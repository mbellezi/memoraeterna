import { Fragment, useId, useMemo, type ReactNode } from "react";
import { Maximize, RefreshCw, TableProperties, Telescope, ZoomIn, ZoomOut } from "lucide-react";
import type { TopicShape } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import { ObjectKindGlyph } from "../../../../components/glyphs";
import { Button } from "../../../../components/ui/button";
import { toneClass, toneIcon } from "./health-marks";
import { buildIcicle, stepZoom, zoomSteps, type IcicleCell } from "./icicle-layout";
import { ShapeChanges } from "./ShapeChanges";
import { ShapeChart } from "./ShapeChart";
import type { ShapeSnapshot } from "./shape-controller";
import {
  depthText,
  panelModel,
  resolveSelection,
  shareText,
  tableRows,
  warningViews,
  warningsValue
} from "./shape-model";
import { ShapeSelected } from "./ShapeSelected";
import { ShapeTable } from "./ShapeTable";
import { ShapeWarnings } from "./ShapeWarnings";
import { panelDomId, tabDomId, ViewSwitch } from "./ViewSwitch";

export type ShapeDisplay = "chart" | "table";

export interface ShapeViewProps {
  t: Translator;
  snapshot: ShapeSnapshot;
  display: ShapeDisplay;
  /** The chart's width as a share of its area (see `zoomSteps`). */
  zoomPercent: number;
  onDisplay: (display: ShapeDisplay) => void;
  onZoomPercent: (percent: number) => void;
  onRetry: () => void;
  onSelect: (key: string) => void;
  /** Shows a branch alone; `depth` is the topic's level in the chart on screen. */
  onZoomInto: (topicId: string, title: string | null, depth: number) => void;
  /** Goes back up the zoom path to a step (0 is the whole tree). */
  onZoomTo: (index: number) => void;
  onOpenTopic: (topicId: string) => void;
  onReview: (changeSetId: string, decision: "apply" | "dismiss") => void;
  onUndo: (changeSetId: string) => void;
  onToggleDetails: (changeSetId: string) => void;
  onRetryDetails: (changeSetId: string) => void;
}

/**
 * The Map lens "Shape": the size, depth and health of the topic tree as an icicle with a table
 * alternative, the selected topic, the warnings (with Apply and Dismiss for proposals that wait
 * for the person) and what changed today. Props in, callbacks out; widths come from the container.
 */
export function ShapeView(props: ShapeViewProps) {
  const { t, snapshot } = props;
  const lensPrefix = useId();
  const displayPrefix = useId();
  const { load } = snapshot;
  return (
    <div className="@container flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="text-xl font-semibold text-foreground">{t("topics.shape.title")}</h1>
        <ViewSwitch
          label={t("topics.shape.lens.label")}
          value="shape"
          idPrefix={lensPrefix}
          items={[
            { id: "shape", label: t("topics.shape.lens.shape") },
            {
              id: "atlas",
              label: t("topics.shape.lens.atlas"),
              note: t("topics.shape.lens.later"),
              disabled: true
            }
          ]}
          onChange={() => undefined}
        />
        <span className="flex-1" />
        {load.status === "ready" ? (
          <ChartControls {...props} displayPrefix={displayPrefix} />
        ) : null}
      </div>
      <p className="max-w-190 text-sm text-secondary-foreground">{t("topics.shape.intro")}</p>
      <p className="sr-only" role="status" aria-live="polite">
        {snapshot.announcement}
      </p>
      <div
        role="tabpanel"
        id={panelDomId(lensPrefix, "shape")}
        aria-labelledby={tabDomId(lensPrefix, "shape")}
        className="flex min-w-0 flex-col gap-5"
      >
        {load.status === "loading" ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-4">
            <span className="sr-only">{t("topics.shape.loading")}</span>
            <div className="h-20 rounded-lg bg-soft" />
            <div className="h-56 rounded-lg bg-soft" />
          </div>
        ) : null}
        {load.status === "error" ? (
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-foreground">{t("topics.shape.error")}</p>
            <Button type="button" onClick={props.onRetry}>
              <RefreshCw aria-hidden="true" />
              {t("shell.actions.retry")}
            </Button>
          </div>
        ) : null}
        {load.status === "missing" ? (
          <div role="status" className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground">
              {snapshot.zoom.length > 1
                ? t("topics.shape.missing")
                : t("topics.navigator.preparing")}
            </p>
            {snapshot.zoom.length > 1 ? (
              <Button type="button" onClick={() => props.onZoomTo(0)}>
                {t("topics.shape.backToTree")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {load.status === "ready" ? (
          <ShapeReady {...props} displayPrefix={displayPrefix} shape={load.shape} />
        ) : null}
      </div>
    </div>
  );
}

/** Chart or table, and the chart's zoom (which has nothing to do while the table shows). */
function ChartControls({
  t,
  display,
  displayPrefix,
  zoomPercent,
  onDisplay,
  onZoomPercent
}: ShapeViewProps & { displayPrefix: string }) {
  const chart = display === "chart";
  const percent = new Intl.NumberFormat(t.locale, { style: "percent" }).format(zoomPercent / 100);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ViewSwitch
        size="sm"
        label={t("topics.shape.display.label")}
        value={display}
        idPrefix={displayPrefix}
        items={[
          {
            id: "chart",
            label: t("topics.shape.display.chart"),
            icon: <Telescope aria-hidden="true" />
          },
          {
            id: "table",
            label: t("topics.shape.display.table"),
            icon: <TableProperties aria-hidden="true" />
          }
        ]}
        onChange={onDisplay}
      />
      <div className="inline-flex items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          aria-label={t("topics.shape.zoom.out")}
          title={t("topics.shape.zoom.out")}
          disabled={!chart || zoomPercent <= zoomSteps[0]}
          onClick={() => onZoomPercent(stepZoom(zoomPercent, "out"))}
        >
          <ZoomOut aria-hidden="true" />
        </Button>
        <output
          aria-label={t("topics.shape.zoom.level", { values: { percent } })}
          className="min-w-11 text-center text-xs text-secondary-foreground tabular-nums"
        >
          {percent}
        </output>
        <Button
          type="button"
          variant="ghost"
          aria-label={t("topics.shape.zoom.in")}
          title={t("topics.shape.zoom.in")}
          disabled={!chart || zoomPercent >= zoomSteps.at(-1)!}
          onClick={() => onZoomPercent(stepZoom(zoomPercent, "in"))}
        >
          <ZoomIn aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="link"
          disabled={!chart || zoomPercent === zoomSteps[0]}
          onClick={() => onZoomPercent(zoomSteps[0])}
        >
          <Maximize aria-hidden="true" />
          {t("topics.shape.zoom.fit")}
        </Button>
      </div>
    </div>
  );
}

function ShapeReady(props: ShapeViewProps & { shape: TopicShape; displayPrefix: string }) {
  const { t, snapshot, shape, display, displayPrefix } = props;
  const wholeTree = snapshot.zoom.length === 1;
  const levelOffset = snapshot.zoom.at(-1)?.depth ?? 0;
  const layout = useMemo(() => buildIcicle(shape.nodes, { wholeTree }), [shape.nodes, wholeTree]);
  const selectedKey = resolveSelection(layout, snapshot.selectedKey);
  const panel =
    selectedKey === null ? null : panelModel(t, layout, selectedKey, wholeTree, levelOffset);
  const rows = useMemo(
    () => tableRows(t, layout, wholeTree, levelOffset),
    [t, layout, wholeTree, levelOffset]
  );
  const warnings = warningViews(t, shape.warnings, layout, wholeTree);
  const zoomInto = (cell: IcicleCell) => {
    const node = cell.node;
    if (node && cell.row > 0 && node.children > 0) props.onZoomInto(node.id, node.title, cell.row);
  };
  const empty = layout.cells.length === 0;
  const { summary } = shape;
  const number = new Intl.NumberFormat(t.locale);
  return (
    <>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(7.5rem,100%),1fr))] gap-x-6 gap-y-3 rounded-lg border border-border bg-surface p-4">
        <Summary label={t("topics.shape.summary.items")}>{number.format(summary.items)}</Summary>
        <Summary label={t("topics.shape.summary.topics")}>{number.format(summary.topics)}</Summary>
        <Summary label={t("topics.shape.summary.meanDepth")}>
          {depthText(t, summary.meanDepth)}
        </Summary>
        <Summary label={t("topics.shape.summary.reachable")}>
          {shareText(t, summary.reachable)}
        </Summary>
        <Summary label={t("topics.navigator.unsorted")}>
          {shareText(t, summary.unsortedShare)}
        </Summary>
        <Summary label={t("topics.shape.summary.warnings")}>
          <span className="inline-flex items-center gap-1.5">
            {summary.soft + summary.hard > 0 ? <WarningsGlyph hard={summary.hard > 0} /> : null}
            {warningsValue(t, summary.soft, summary.hard)}
          </span>
        </Summary>
      </dl>
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
        {wholeTree ? (
          <span className="text-muted-foreground">{t("topics.shape.branch.wholeTree")}</span>
        ) : null}
      </nav>
      <div className="grid min-w-0 gap-8 @4xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <div
            role="tabpanel"
            id={panelDomId(displayPrefix, "chart")}
            aria-labelledby={tabDomId(displayPrefix, "chart")}
            hidden={display !== "chart"}
          >
            {display === "chart" ? (
              empty ? (
                <p className="text-sm text-muted-foreground">{t("topics.shape.empty")}</p>
              ) : (
                <ShapeChart
                  t={t}
                  layout={layout}
                  wholeTree={wholeTree}
                  levelOffset={levelOffset}
                  selectedKey={selectedKey}
                  zoomPercent={props.zoomPercent}
                  truncated={shape.truncated}
                  onSelect={props.onSelect}
                  onZoomInto={zoomInto}
                />
              )
            ) : null}
          </div>
          <div
            role="tabpanel"
            id={panelDomId(displayPrefix, "table")}
            aria-labelledby={tabDomId(displayPrefix, "table")}
            hidden={display !== "table"}
          >
            {display === "table" ? (
              empty ? (
                <p className="text-sm text-muted-foreground">{t("topics.shape.empty")}</p>
              ) : (
                <ShapeTable t={t} rows={rows} selectedKey={selectedKey} onSelect={props.onSelect} />
              )
            ) : null}
          </div>
        </div>
        <aside
          aria-label={t("topics.shape.panel.label")}
          className={cn(
            "flex min-w-0 flex-col gap-6 border-t border-border pt-5",
            "@4xl:border-t-0 @4xl:border-l @4xl:pt-0 @4xl:pl-5"
          )}
        >
          {panel ? (
            <ShapeSelected
              t={t}
              model={panel}
              onOpenTopic={props.onOpenTopic}
              onZoomIn={() => {
                const cell = layout.byKey.get(panel.key);
                if (cell) zoomInto(cell);
              }}
            />
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
          <ShapeChanges
            t={t}
            changes={shape.changedToday}
            actions={snapshot.actions}
            details={snapshot.details}
            onUndo={props.onUndo}
            onToggleDetails={props.onToggleDetails}
            onRetryDetails={props.onRetryDetails}
          />
        </aside>
      </div>
    </>
  );
}

function Summary({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

function WarningsGlyph({ hard }: { hard: boolean }) {
  const tone = hard ? "danger" : "warning";
  const Icon = toneIcon[tone];
  return <Icon className={cn("size-4", toneClass[tone])} aria-hidden="true" />;
}
