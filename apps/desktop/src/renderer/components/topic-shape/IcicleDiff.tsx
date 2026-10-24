import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { RefreshCw, TableProperties, Telescope } from "lucide-react";
import type { ChangeSetRef, TopicDiffNode } from "@app/domain";
import type { Translator } from "@app/i18n";

import { Button } from "../ui/button";
import { DiffMark } from "./diff-marks";
import {
  IcicleDiffController,
  type IcicleDiffLoader,
  type IcicleDiffSnapshot
} from "./icicle-diff-controller";
import { diffRows, resolveDiffSelection, type DiffRow } from "./icicle-diff-model";
import type { DiffWeight } from "./icicle-layout";
import { IcicleDiffChart } from "./IcicleDiffChart";
import { IcicleDiffTable, Place } from "./IcicleDiffTable";
import { panelDomId, tabDomId, ViewSwitch } from "./ViewSwitch";

export type IcicleDiffDisplay = "chart" | "table";

export interface IcicleDiffViewProps {
  t: Translator;
  snapshot: IcicleDiffSnapshot;
  display: IcicleDiffDisplay;
  /** Overrides the width of a block (see `movedWeight`). */
  weight?: DiffWeight | undefined;
  onDisplay: (display: IcicleDiffDisplay) => void;
  onSelect: (topicId: string) => void;
  onRetry: () => void;
  /** Shows "Open topic" for a selected topic that still exists. */
  onOpenTopic?: ((topicId: string) => void) | undefined;
}

/**
 * The structural diff of a change-set: the topic tree before and after as icicles with a table
 * alternative, and the selected topic in words. Props in, callbacks out; widths come from the
 * container. The loading, empty, error and success states are all here.
 */
export function IcicleDiffView(props: IcicleDiffViewProps) {
  const { t, snapshot } = props;
  const { load } = snapshot;
  return (
    <section
      data-icicle-diff=""
      aria-label={t("topics.shape.diff.label")}
      className="flex min-w-0 flex-col gap-3"
    >
      {load.status === "loading" ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <span className="sr-only">{t("topics.shape.diff.loading")}</span>
          <div className="h-16 rounded-lg bg-soft" />
          <div className="h-16 rounded-lg bg-soft" />
        </div>
      ) : null}
      {load.status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{t("topics.shape.diff.error")}</p>
          <Button type="button" onClick={props.onRetry}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {load.status === "missing" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("topics.shape.diff.missing")}
        </p>
      ) : null}
      {load.status === "unsupported" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("topics.shape.diff.unsupported")}
        </p>
      ) : null}
      {load.status === "ready" && load.nodes.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("topics.shape.diff.empty")}
        </p>
      ) : null}
      {load.status === "ready" && load.nodes.length > 0 ? (
        <Ready {...props} nodes={load.nodes} hidden={load.hidden} />
      ) : null}
    </section>
  );
}

function Ready({
  t,
  snapshot,
  display,
  weight,
  nodes,
  hidden,
  onDisplay,
  onSelect,
  onOpenTopic
}: IcicleDiffViewProps & { nodes: readonly TopicDiffNode[]; hidden: number }) {
  const prefix = useId();
  const rows = useMemo(() => diffRows(t, nodes), [t, nodes]);
  const selectedId = resolveDiffSelection(nodes, snapshot.selectedId);
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  return (
    <>
      <div className="flex">
        <ViewSwitch
          size="sm"
          label={t("topics.shape.diff.display.label")}
          value={display}
          idPrefix={prefix}
          items={[
            {
              id: "chart",
              label: t("topics.shape.diff.display.chart"),
              icon: <Telescope aria-hidden="true" />
            },
            {
              id: "table",
              label: t("topics.shape.diff.display.table"),
              icon: <TableProperties aria-hidden="true" />
            }
          ]}
          onChange={onDisplay}
        />
      </div>
      <div
        role="tabpanel"
        id={panelDomId(prefix, display)}
        aria-labelledby={tabDomId(prefix, display)}
        className="min-w-0"
      >
        {display === "chart" ? (
          <IcicleDiffChart
            t={t}
            nodes={nodes}
            hidden={hidden}
            weight={weight}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ) : (
          <IcicleDiffTable t={t} rows={rows} selectedId={selectedId} onSelect={onSelect} />
        )}
      </div>
      <SelectedTopic t={t} row={selected} onOpenTopic={onOpenTopic} />
    </>
  );
}

/** What happened to the selected topic, in words; a polite live region, so a selection is announced. */
function SelectedTopic({
  t,
  row,
  onOpenTopic
}: {
  t: Translator;
  row: DiffRow | null;
  onOpenTopic: ((topicId: string) => void) | undefined;
}) {
  const number = new Intl.NumberFormat(t.locale);
  return (
    <div aria-live="polite" className="flex flex-col gap-2 rounded-md bg-soft p-3 text-sm">
      {row === null ? (
        <p className="text-xs text-muted-foreground">{t("topics.shape.diff.selected.none")}</p>
      ) : (
        <>
          <p className="text-xs font-semibold text-secondary-foreground">
            {t("topics.shape.diff.selected.label")}
          </p>
          <p className="font-medium text-foreground [overflow-wrap:anywhere]">
            {row.name}
            {row.was !== null ? (
              <span className="font-normal text-muted-foreground">
                {` · ${t("topics.shape.diff.table.was", { values: { title: row.was } })}`}
              </span>
            ) : null}
          </p>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 text-xs">
            <dt className="text-secondary-foreground">{t("topics.shape.diff.table.change")}</dt>
            <dd>
              <DiffMark t={t} change={row.change} />
            </dd>
            <dt className="text-secondary-foreground">
              {t("topics.shape.diff.table.parentBefore")}
            </dt>
            <dd className="text-foreground [overflow-wrap:anywhere]">
              <Place
                t={t}
                exists={row.existedBefore}
                parent={row.parentBefore}
                none={t("topics.shape.diff.table.noneBefore")}
              />
            </dd>
            <dt className="text-secondary-foreground">
              {t("topics.shape.diff.table.parentAfter")}
            </dt>
            <dd className="text-foreground [overflow-wrap:anywhere]">
              <Place
                t={t}
                exists={row.existsAfter}
                parent={row.parentAfter}
                none={t("topics.shape.diff.table.noneAfter")}
              />
            </dd>
            <dt className="text-secondary-foreground">{t("topics.shape.diff.table.itemsIn")}</dt>
            <dd className="text-foreground tabular-nums">{number.format(row.itemsIn)}</dd>
            <dt className="text-secondary-foreground">{t("topics.shape.diff.table.itemsOut")}</dt>
            <dd className="text-foreground tabular-nums">{number.format(row.itemsOut)}</dd>
          </dl>
          {onOpenTopic && row.existsAfter ? (
            <div>
              <Button type="button" onClick={() => onOpenTopic(row.id)}>
                {t("topics.shape.diff.selected.open")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export interface IcicleDiffProps {
  t: Translator;
  /** The change-set to draw; null draws nothing. Only a topic change-set has a structure to draw. */
  target: ChangeSetRef | null;
  /** Reads the bounded diff (the host passes the `changes.diff` IPC): the component has no IPC of its own. */
  load: IcicleDiffLoader;
  /** Bump it after an undo or a review of the target: the diff is read again in place. */
  revision?: number | undefined;
  /** Overrides the width of a block (see `movedWeight`); a host with item totals passes them here. */
  weight?: DiffWeight | undefined;
  onOpenTopic?: ((topicId: string) => void) | undefined;
}

/**
 * The icicle diff for a host that has a change-set in view (the Inbox detail pane; F5's Map ›
 * Shape reuses it). Mount it only while its view is shown: it reads when it mounts or when
 * `target` changes, never polls and listens to nothing. The state lives in a controller (tested
 * without a renderer); the chart or table choice is the person's view and lives here.
 */
export function IcicleDiff({
  t,
  target,
  load,
  revision = 0,
  weight,
  onOpenTopic
}: IcicleDiffProps) {
  const [controller] = useState(() => new IcicleDiffController({ load }));
  // The loader is used when a read starts; a new callback from the parent restarts nothing.
  useEffect(() => {
    controller.setLoader(load);
  }, [controller, load]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const [display, setDisplay] = useState<IcicleDiffDisplay>("chart");

  const kind = target?.kind ?? null;
  const id = target?.id ?? null;
  useEffect(() => {
    controller.setTarget(kind === null || id === null ? null : { kind, id });
  }, [controller, kind, id]);

  const seenRevision = useRef(revision);
  useEffect(() => {
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    controller.refresh();
  }, [controller, revision]);

  return (
    <IcicleDiffView
      t={t}
      snapshot={snapshot}
      display={display}
      weight={weight}
      onDisplay={setDisplay}
      onSelect={(topicId) => controller.select(topicId)}
      onRetry={() => controller.retry()}
      onOpenTopic={onOpenTopic}
    />
  );
}
