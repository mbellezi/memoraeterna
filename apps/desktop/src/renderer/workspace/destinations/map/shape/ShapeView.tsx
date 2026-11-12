import { Fragment, useMemo, type CSSProperties, type KeyboardEvent } from "react";
import { Table2, LayoutPanelLeft } from "lucide-react";
import type { TopicShape } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../../../../components/glyphs";
import { Button } from "../../../../components/ui/button";
import { EmptyState } from "../../../../components/ui/empty-state";
import { ErrorState } from "../../../../components/ui/error-state";
import { Kbd } from "../../../../components/ui/kbd";
import {
  LoadingState,
  Skeleton,
  SkeletonRows,
  skeletonDelayMs,
  useAfterDelay
} from "../../../../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../../../../components/ui/toggle-group";
import { useViewportWidth } from "../../../use-workspace";
import { useAddSource } from "../../../workspace-bridge";
import { columnWidth } from "../../columns";
import { buildIcicle, topicCellKey } from "./icicle-layout";
import { drawnTrail } from "./map-icicle";
import { MapChart } from "./MapChart";
import { MapTable } from "./MapTable";
import { ShapeChanges } from "./ShapeChanges";
import type { ShapeSnapshot } from "./shape-controller";
import {
  defaultSelection,
  mapDescription,
  panelModel,
  resolveSelection,
  tableRows,
  topicOfRow,
  warningViews
} from "./shape-model";
import { ShapeSelected } from "./ShapeSelected";
import { ShapeTable } from "./ShapeTable";
import { ShapeWarnings } from "./ShapeWarnings";

/** "Gráfico e tabela" shows the chart with its table beside it; "Só tabela" gives the table the room. */
export type ShapeDisplay = "chart" | "table";

/** Where the person was before they opened the Map: the topic that holds it, marked "aqui". */
export interface ShapeOrigin {
  topicId: string;
  title: string | null;
}

export interface ShapeViewProps {
  t: Translator;
  snapshot: ShapeSnapshot;
  display: ShapeDisplay;
  onDisplay: (display: ShapeDisplay) => void;
  onRetry: () => void;
  onSelect: (key: string) => void;
  /** Shows a branch alone; `depth` is the topic's level in the chart on screen. */
  onZoomInto: (topicId: string, title: string | null, depth: number) => void;
  /** Goes back up the zoom path to a step (0 is the whole tree). */
  onZoomTo: (index: number) => void;
  onOpenTopic: (topicId: string) => void;
  /** Opens the Inbox: the next step of a topic with a proposal that waits. */
  onOpenInbox?: (() => void) | undefined;
  /** The topic the person came from, when they came from an object. */
  origin?: ShapeOrigin | null | undefined;
  /** The root is the previous panel: its table of topics alone, the open topic marked. */
  compact?: boolean | undefined;
  currentTopicId?: string | null | undefined;
  /** Leaves the Map for where the person was (Esc once the whole tree shows). */
  onBack?: (() => void) | undefined;
  onReview: (changeSetId: string, decision: "apply" | "dismiss") => void;
  onUndo: (changeSetId: string) => void;
  onToggleDetails: (changeSetId: string) => void;
  onRetryDetails: (changeSetId: string) => void;
}

/**
 * The Map lens "Árvore" (design record §7.5): the size and health of the topic tree as a chart with
 * its table, the selected topic with what weighs on it and the next step, and what changed. Props
 * in, callbacks out; the four states are in place and the chart is never shown without its table.
 */
export function ShapeView(props: ShapeViewProps) {
  const { t, snapshot } = props;
  const { load } = snapshot;
  const width = useViewportWidth();
  const style = {
    "--map-inspector-w": `${columnWidth("mapInspector", width)}px`
  } as CSSProperties;
  const ready = load.status === "ready" ? load.shape : null;
  const items = ready?.summary.items ?? 0;
  const topics = ready?.summary.topics ?? 0;
  if (props.compact) return <CompactShape {...props} shape={ready} />;

  return (
    <div
      className="@container flex min-w-0 flex-col gap-4"
      style={style}
      onKeyDown={(event) => onEscape(event, props)}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {load.status === "loading" ? (
          <CountSkeleton />
        ) : (
          <p className="m-0 text-sm text-secondary-foreground">
            {ready && items > 0
              ? mapDescription(t, items, topics)
              : t("map.shape.descriptionPlain")}
          </p>
        )}
        {(ready && items > 0) || load.status === "loading" ? (
          <ToggleGroup
            label={t("map.display.label")}
            value={props.display}
            disabled={load.status === "loading"}
            onValueChange={props.onDisplay}
          >
            <ToggleGroupItem value="chart">
              <LayoutPanelLeft aria-hidden="true" />
              {t("map.display.both")}
            </ToggleGroupItem>
            <ToggleGroupItem value="table">
              <Table2 aria-hidden="true" />
              {t("map.display.table")}
            </ToggleGroupItem>
          </ToggleGroup>
        ) : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {snapshot.announcement}
      </p>
      {load.status === "loading" ? <Loading t={t} /> : null}
      {load.status === "error" ? (
        <ErrorState
          t={t}
          message={t("map.states.error")}
          kept={t("map.states.errorKept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={props.onRetry}
        />
      ) : null}
      {load.status === "missing" ? (
        snapshot.zoom.length > 1 ? (
          <EmptyState
            headline={t("topics.shape.missing")}
            action={
              <Button type="button" onClick={() => props.onZoomTo(0)}>
                {t("topics.shape.backToTree")}
              </Button>
            }
          />
        ) : (
          <MapEmpty t={t} />
        )
      ) : null}
      {ready ? <ShapeReady {...props} shape={ready} /> : null}
    </div>
  );
}

/** The Map as the previous panel (design record §8): its table, one row per topic, the open one marked. */
function CompactShape(props: ShapeViewProps & { shape: TopicShape | null }) {
  const { t, snapshot, shape } = props;
  const layout = useMemo(
    () => (shape ? buildIcicle(shape.nodes, { wholeTree: true, sortBySize: true }) : null),
    [shape]
  );
  if (snapshot.load.status === "loading") return <Loading t={t} compact />;
  if (snapshot.load.status === "error")
    return (
      <ErrorState
        t={t}
        message={t("map.states.error")}
        kept={t("map.states.errorKept")}
        retryLabel={t("shell.actions.retry")}
        onRetry={props.onRetry}
      />
    );
  if (!shape || !layout || layout.cells.length === 0) return <MapEmpty t={t} />;
  const rows = tableRows(t, layout, true, 0, null);
  return (
    <MapTable
      t={t}
      compact
      rows={rows}
      selectedKey={null}
      currentKey={props.currentTopicId ? topicCellKey(props.currentTopicId) : null}
      hereKeys={new Set()}
      onSelect={(key) => {
        const topicId = topicOfRow(rows, key);
        if (topicId !== null) props.onOpenTopic(topicId);
      }}
    />
  );
}

/** The count line of the header while the tree is read: a bar where the description's numbers will be. */
function CountSkeleton() {
  const shown = useAfterDelay(skeletonDelayMs);
  return shown ? <Skeleton aria-hidden="true" className="h-4 w-72 max-w-full" /> : <span />;
}

/** The weights of the blocks in the three columns of the loading chart: Áreas, Tópicos, Subtópicos. */
const loadingColumns = [
  { share: "25%", blocks: [6, 4] },
  { share: "37.5%", blocks: [3, 2.5, 2, 1.5, 1, 4, 1.5, 1.5] },
  { share: "37.5%", blocks: [2, 2, 1, 5, 4, 1] }
] as const;

/** The tree is still being read: the three columns of the chart and the inspector, as bars. */
function Loading({ t, compact = false }: { t: Translator; compact?: boolean }) {
  if (compact)
    return (
      <LoadingState t={t}>
        <SkeletonRows rows={12} className="-mx-2" />
      </LoadingState>
    );
  return (
    <LoadingState
      t={t}
      className="@3xl:grid-cols-[minmax(0,1fr)_var(--map-inspector-w)] @3xl:gap-6"
    >
      <div className="grid min-w-0 gap-1">
        <div className="flex">
          {loadingColumns.map((column, index) => (
            <div key={index} className="min-w-0 px-2 py-1" style={{ width: column.share }}>
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
        <div className="flex h-[440px] min-w-0 gap-0.5">
          {loadingColumns.map((column, index) => (
            <div
              key={index}
              className="flex min-w-0 flex-col gap-0.5"
              style={{ width: column.share }}
            >
              {column.blocks.map((weight, block) => (
                <Skeleton
                  key={block}
                  className="min-h-3 w-full rounded-md"
                  style={{ flex: `${weight} 1 0` }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className="grid content-start gap-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="mt-4 h-48 w-full rounded-lg" />
      </div>
    </LoadingState>
  );
}

/** No topics yet: what the Map is for and the one thing to do, add a source (the app's own Add). */
function MapEmpty({ t }: { t: Translator }) {
  const addSource = useAddSource();
  return (
    <EmptyState
      headline={t("map.states.empty")}
      className="max-w-xl"
      action={
        <Button
          type="button"
          variant="primary"
          disabled={!addSource}
          onClick={addSource ?? undefined}
        >
          {t("map.states.emptyAdd")}
        </Button>
      }
    >
      {t("map.states.emptyBody")}
    </EmptyState>
  );
}

/**
 * What Esc does in the Map (design record §7.5): zoom out one step while a branch shows, then leave
 * for where the person was when they came from an object; otherwise nothing.
 */
export function escapeStep(zoomSteps: number, cameFromObject: boolean): "zoomOut" | "leave" | null {
  if (zoomSteps > 1) return "zoomOut";
  return cameFromObject ? "leave" : null;
}

function onEscape(event: KeyboardEvent<HTMLElement>, props: ShapeViewProps): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target as HTMLElement;
  // A menu, a field or a dialog takes Esc for itself.
  if (target.closest('input, textarea, select, [role="dialog"], [role="menu"]')) return;
  const { zoom } = props.snapshot;
  const step = escapeStep(zoom.length, Boolean(props.onBack && props.origin));
  if (step === "zoomOut") {
    event.preventDefault();
    props.onZoomTo(zoom.length - 2);
  } else if (step === "leave") {
    event.preventDefault();
    props.onBack?.();
  }
}

function ShapeReady(props: ShapeViewProps & { shape: TopicShape }) {
  const { t, snapshot, shape, display } = props;
  const wholeTree = snapshot.zoom.length === 1;
  const levelOffset = snapshot.zoom.at(-1)?.depth ?? 0;
  const growth = snapshot.growth.status === "ready" ? snapshot.growth.byTopic : null;
  const layout = useMemo(
    () => buildIcicle(shape.nodes, { wholeTree, sortBySize: true }),
    [shape.nodes, wholeTree]
  );
  const originKey = props.origin ? topicCellKey(props.origin.topicId) : null;
  const selectedKey = resolveSelection(
    layout,
    snapshot.selectedKey,
    defaultSelection(layout, originKey)
  );
  const panel =
    selectedKey === null
      ? null
      : panelModel(t, layout, selectedKey, wholeTree, levelOffset, growth);
  const rows = useMemo(
    () => tableRows(t, layout, wholeTree, levelOffset, growth),
    [t, layout, wholeTree, levelOffset, growth]
  );
  const warnings = warningViews(t, shape.warnings, layout, wholeTree);
  const here = useMemo(
    () =>
      originKey && layout.byKey.has(originKey)
        ? {
            // Only the deepest block the chart draws that holds the origin: the origin itself when it
            // is drawn, else its nearest ancestor. A chain of marks would say "here" four times.
            chart: new Set(drawnTrail(layout, originKey).slice(-1)),
            // The table lists the origin itself, and the root holds everything: it is not marked.
            table: new Set(originKey === layout.rootKey ? [] : [originKey])
          }
        : { chart: new Set<string>(), table: new Set<string>() },
    [layout, originKey]
  );
  const zoomInto = (key: string) => {
    const cell = layout.byKey.get(key);
    const node = cell?.node;
    if (cell && node && cell.row > 0 && node.children > 0)
      props.onZoomInto(node.id, node.title, cell.row);
  };
  const empty = layout.cells.length === 0;
  const proposalHere =
    selectedKey !== null &&
    warnings.some(
      (warning) => warning.proposal !== null && warning.subject?.cellKey === selectedKey
    );

  if (empty) return <MapEmpty t={t} />;
  return (
    <>
      {props.origin && wholeTree && props.onBack ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-surface-selected px-4 py-2 text-sm text-foreground">
          <p className="m-0 min-w-0 flex-1">
            {t("map.band.whole")} <Kbd>Esc</Kbd>{" "}
            {t("map.band.back", {
              values: { topic: props.origin.title ?? t("topics.page.unnamed") }
            })}
          </p>
          <Button type="button" onClick={props.onBack}>
            {t("map.band.action")}
            <Kbd>Esc</Kbd>
          </Button>
        </div>
      ) : null}
      {snapshot.zoom.length > 1 ? (
        <nav
          aria-label={t("topics.shape.branch.label")}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        >
          <span className="text-muted-foreground">{t("topics.shape.branch.zoomedIn")}</span>
          {snapshot.zoom.map((step, index) => {
            const last = index === snapshot.zoom.length - 1;
            const name =
              index === 0 ? t("topics.navigator.topics") : (step.title ?? t("topics.page.unnamed"));
            return (
              <Fragment key={step.id ?? "tree"}>
                {index > 0 ? (
                  <span aria-hidden="true" className="text-muted-foreground">
                    {"›"}
                  </span>
                ) : null}
                {last ? (
                  <span
                    aria-current="location"
                    className="inline-flex items-center gap-1.5 font-semibold text-foreground"
                  >
                    <ObjectKindGlyph kind="topic" className="text-object-topic" />
                    {name}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => props.onZoomTo(index)}
                    className="rounded-sm text-accent hover:underline"
                  >
                    {name}
                  </button>
                )}
              </Fragment>
            );
          })}
        </nav>
      ) : null}
      <div className="grid min-w-0 gap-6 @3xl:grid-cols-[minmax(0,1fr)_var(--map-inspector-w)]">
        <div className="flex min-w-0 flex-col gap-6">
          {display === "chart" ? (
            <MapChart
              t={t}
              layout={layout}
              wholeTree={wholeTree}
              levelOffset={levelOffset}
              selectedKey={selectedKey}
              hereKeys={here.chart}
              truncated={shape.truncated}
              onSelect={props.onSelect}
              onZoomInto={zoomInto}
            />
          ) : (
            <ShapeTable t={t} rows={rows} selectedKey={selectedKey} onSelect={props.onSelect} />
          )}
          <ShapeChanges
            t={t}
            changes={shape.changedToday}
            actions={snapshot.actions}
            details={snapshot.details}
            onUndo={props.onUndo}
            onToggleDetails={props.onToggleDetails}
            onRetryDetails={props.onRetryDetails}
          />
        </div>
        <aside
          aria-label={t("topics.shape.panel.label")}
          className="flex min-w-0 flex-col gap-6 border-t border-border pt-5 @3xl:border-t-0 @3xl:border-l @3xl:pt-0 @3xl:pl-5"
        >
          {panel ? (
            <ShapeSelected
              t={t}
              model={panel}
              onOpenTopic={props.onOpenTopic}
              onZoomIn={() => selectedKey !== null && zoomInto(selectedKey)}
              onOpenInbox={proposalHere ? props.onOpenInbox : undefined}
            />
          ) : null}
          {display === "chart" ? (
            <section className="flex flex-col gap-2">
              <h3 className="m-0 text-xs font-semibold text-secondary-foreground">
                {t("map.inspector.table")}
              </h3>
              <MapTable
                t={t}
                rows={rows}
                selectedKey={selectedKey}
                hereKeys={here.table}
                onSelect={props.onSelect}
              />
            </section>
          ) : null}
          <ShapeWarnings
            t={t}
            warnings={warnings}
            actions={snapshot.actions}
            details={snapshot.details}
            onSelect={props.onSelect}
            onReview={props.onReview}
            onToggleDetails={props.onToggleDetails}
            onRetryDetails={props.onRetryDetails}
          />
        </aside>
      </div>
    </>
  );
}
