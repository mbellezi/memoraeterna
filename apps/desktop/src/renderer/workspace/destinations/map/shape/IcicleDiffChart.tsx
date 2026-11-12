import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import type { TopicDiffNode } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import { DiffGlyph, DiffSwatch, diffFill } from "./diff-marks";
import {
  diffChanges,
  diffCellLabel,
  diffLegend,
  diffSideKeys,
  hiddenText,
  legendText,
  movedMark,
  topicNameOn
} from "./icicle-diff-model";
import {
  buildDiffIcicle,
  cellSpan,
  diffCellContent,
  diffCellKey,
  diffSides,
  drawnDiffCells,
  keyboardFocus,
  tabStop,
  type DiffCell,
  type DiffIcicle,
  type DiffWeight,
  type DrawnDiffCells
} from "./icicle-layout";

/** A block is 44 px tall (a name and a word) and rows are 2 px apart; both are layout, not copy. */
const rowHeight = 44;
const rowGap = 2;
const rowPitch = rowHeight + rowGap;
/** The width assumed before the chart has been measured (and when it cannot be). */
const defaultAreaWidth = 480;

const selectionRing = "inset 0 0 0 2px var(--accent)";

export interface IcicleDiffChartProps {
  t: Translator;
  nodes: readonly TopicDiffNode[];
  /** Topics the read left out because it is bounded (deeper levels are summarized). */
  hidden: number;
  /** Overrides the width of a block (see `movedWeight`); a host with item totals passes them here. */
  weight?: DiffWeight | undefined;
  /** The selected topic: it is ringed on both sides. */
  selectedId: string | null;
  onSelect: (topicId: string) => void;
}

/**
 * The structural diff as two icicles, the tree before the change above the tree after it. A block
 * is a topic: its tint and glyph say what happened to it, its width hints at the items moved. Every
 * block is a button, one tab stop per side (arrows move along and between levels, Home and End to
 * the ends), drawn only when wide enough to see; the table beside it lists every topic. A block too
 * narrow for its name is named on a line below the icicles while it has focus or the pointer.
 * Layout comes from `icicle-layout`, drawing is plain DOM.
 */
export function IcicleDiffChart({
  t,
  nodes,
  hidden,
  weight,
  selectedId,
  onSelect
}: IcicleDiffChartProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(defaultAreaWidth);
  useEffect(() => {
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // Coarse steps: a few pixels of window resize redraw nothing.
      if (width > 0) setAreaWidth(Math.max(16, Math.round(width / 16) * 16));
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  const layouts = useMemo(
    () => diffSides.map((side) => buildDiffIcicle(nodes, side, weight)),
    [nodes, weight]
  );
  const drawn = useMemo(
    () => layouts.map((layout) => drawnDiffCells(layout, areaWidth)),
    [layouts, areaWidth]
  );
  const legend = useMemo(() => diffLegend(nodes), [nodes]);
  const pruned = drawn.some((side) => side.hidden > 0);
  const detached = layouts.some((layout) => layout.cells.some((cell) => cell.detached));
  // The block under the pointer or holding focus, named below the icicles for a sighted reader.
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const preview =
    previewKey === null
      ? null
      : (layouts.map((layout) => layout.byKey.get(previewKey)).find((cell) => cell) ?? null);

  return (
    <figure className="flex min-w-0 flex-col gap-3">
      <div ref={areaRef} className="flex min-w-0 flex-col gap-3">
        {layouts.map((layout, index) => (
          <SideChart
            key={layout.side}
            t={t}
            layout={layout}
            drawn={drawn[index]!}
            widthPx={areaWidth}
            selectedId={selectedId}
            onSelect={onSelect}
            onPreview={setPreviewKey}
          />
        ))}
      </div>
      <p aria-hidden="true" className="min-h-4 text-xs text-foreground">
        {preview ? diffCellLabel(t, preview) : null}
      </p>
      <figcaption className="flex flex-col gap-2 text-xs text-secondary-foreground">
        <ul
          aria-label={t("topics.shape.diff.chart.legend")}
          className="flex flex-wrap gap-x-4 gap-y-2"
        >
          {legend.map((item) => (
            <li key={item.change} className="inline-flex items-center gap-1.5">
              <DiffSwatch change={item.change} />
              {legendText(t, item)}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <span>{t("topics.shape.diff.chart.legendWidth")}</span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-3 w-4 rounded-sm"
              style={{ boxShadow: selectionRing }}
            />
            {t("topics.shape.diff.chart.legendSelected")}
          </span>
          {detached ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-3 w-4 rounded-sm border border-dashed border-border-strong"
              />
              {t("topics.shape.diff.chart.legendDetached")}
            </span>
          ) : null}
        </div>
      </figcaption>
      {pruned ? (
        <p className="text-xs text-muted-foreground">{t("topics.shape.diff.chart.pruned")}</p>
      ) : null}
      {hidden > 0 ? <p className="text-xs text-muted-foreground">{hiddenText(t, hidden)}</p> : null}
    </figure>
  );
}

function SideChart({
  t,
  layout,
  drawn,
  widthPx,
  selectedId,
  onSelect,
  onPreview
}: {
  t: Translator;
  layout: DiffIcicle;
  drawn: DrawnDiffCells;
  widthPx: number;
  selectedId: string | null;
  onSelect: (topicId: string) => void;
  onPreview: (key: string | null) => void;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const keys = diffSideKeys[layout.side];
  const selectedKey = selectedId === null ? null : diffCellKey(layout.side, selectedId);
  const stop = tabStop(layout, selectedKey, drawn.reachable);
  const height = layout.rows * rowPitch - rowGap;

  const cellOf = (target: EventTarget): string | undefined =>
    (target as HTMLElement).closest<HTMLElement>("[data-cell]")?.dataset.cell;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const from = cellOf(event.target);
    if (!from) return;
    const { handled, to } = keyboardFocus(layout, from, event.key, drawn.reachable);
    if (!handled) return;
    event.preventDefault();
    if (to === null) return;
    groupRef.current?.querySelector<HTMLElement>(`[data-cell="${to}"]`)?.focus();
  };

  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h4 className="text-xs font-semibold text-secondary-foreground">{t(keys.heading)}</h4>
      {layout.cells.length === 0 ? (
        <p className="rounded-md bg-soft px-3 py-2 text-xs text-muted-foreground">
          {t(keys.nothing)}
        </p>
      ) : (
        <div
          ref={groupRef}
          role="group"
          aria-label={t(keys.chart)}
          onKeyDown={onKeyDown}
          onFocus={(event) => onPreview(cellOf(event.target) ?? null)}
          onBlur={() => onPreview(null)}
          onMouseOver={(event) => onPreview(cellOf(event.target) ?? null)}
          onMouseLeave={() => onPreview(null)}
          className="relative"
          style={{ height }}
        >
          {drawn.drawn.map((cell) => (
            <div
              key={cell.key}
              className="absolute px-px"
              style={{
                left: `${cell.x0 * 100}%`,
                width: `${cellSpan(cell) * 100}%`,
                top: cell.row * rowPitch,
                height: rowHeight
              }}
            >
              <Block
                t={t}
                cell={cell}
                widthPx={cellSpan(cell) * widthPx}
                selected={cell.key === selectedKey}
                stop={cell.key === stop}
                onSelect={onSelect}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Block({
  t,
  cell,
  widthPx,
  selected,
  stop,
  onSelect
}: {
  t: Translator;
  cell: DiffCell;
  widthPx: number;
  selected: boolean;
  stop: boolean;
  onSelect: (topicId: string) => void;
}) {
  const content = diffCellContent(widthPx);
  const label = diffCellLabel(t, cell);
  const moved = movedMark(cell);
  const style: CSSProperties = {
    background: diffFill(cell.node.change),
    boxShadow: selected ? selectionRing : undefined
  };
  return (
    <button
      type="button"
      data-cell={cell.key}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      tabIndex={stop ? 0 : -1}
      onClick={() => onSelect(cell.topicId)}
      style={style}
      className={cn(
        "flex h-full w-full min-w-0 flex-col justify-center gap-0.5 overflow-hidden rounded-md",
        "text-left text-sm leading-4 text-foreground",
        "focus-visible:-outline-offset-2 focus-visible:outline-foreground",
        cell.detached && "border border-dashed border-border-strong",
        content === "full" ? "px-2" : "items-center px-0"
      )}
    >
      {content === "full" ? (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <DiffGlyph change={cell.node.change} />
            <span className="block truncate font-medium">
              {topicNameOn(t, cell.node, cell.side)}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-secondary-foreground tabular-nums">
            <span className="truncate">{t(diffChanges[cell.node.change].key)}</span>
            {moved ? <span className="shrink-0">{moved}</span> : null}
          </span>
        </>
      ) : null}
      {content === "glyph" ? <DiffGlyph change={cell.node.change} /> : null}
    </button>
  );
}
