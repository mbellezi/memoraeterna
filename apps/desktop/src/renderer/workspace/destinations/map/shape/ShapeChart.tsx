import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import type { TopicHealth } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import { toneClass, toneIcon } from "./health-marks";
import {
  cellContent,
  cellSpan,
  drawnCells,
  fillShares,
  moveFocus,
  type FocusMove,
  type IcicleCell,
  type IcicleLayout
} from "./icicle-layout";
import { cellLabel, cellName, itemsText, shapeHealth, weekText } from "./shape-model";

/** A block is 56 px tall and rows are 2 px apart; both are layout, not copy. */
const rowHeight = 56;
const rowGap = 2;
const rowPitch = rowHeight + rowGap;
/** The width assumed before the chart has been measured (and when it cannot be). */
const defaultAreaWidth = 960;

const keyMoves: Partial<Record<string, FocusMove>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "home",
  End: "end"
};

/** Deeper rows are paler; the root is the quietest. Colour only tints: the words carry the meaning. */
function fillOf(row: number): string {
  if (row === 0) return "var(--surface-soft)";
  const share = fillShares[Math.min(row, fillShares.length) - 1];
  return `color-mix(in srgb, var(--object-topic) ${share}%, var(--surface-raised))`;
}

const ringColour: Record<TopicHealth, string | null> = {
  good: null,
  attention: "var(--state-warning)",
  violation: "var(--state-danger)"
};

/** The selection ring, with the health ring inside it: both show at once. */
function ringOf(selected: boolean, health: TopicHealth): string | undefined {
  const rings: string[] = [];
  if (selected) rings.push("var(--accent)");
  const mark = ringColour[health];
  if (mark) rings.push(mark);
  if (rings.length === 0) return undefined;
  return rings.map((colour, index) => `inset 0 0 0 ${(index + 1) * 2}px ${colour}`).join(", ");
}

export interface ShapeChartProps {
  t: Translator;
  layout: IcicleLayout;
  /** The chart starts at the root of the tree, not at a branch. */
  wholeTree: boolean;
  /** The level of the chart's first row in the whole tree. */
  levelOffset: number;
  /** The block shown as selected; always one of the layout's blocks. */
  selectedKey: string | null;
  /** The chart's width as a share of its area; above 100 the area scrolls sideways. */
  zoomPercent: number;
  /** The read stopped at its depth or node limit. */
  truncated: boolean;
  onSelect: (key: string) => void;
  /** Double click on a block: show its branch alone. */
  onZoomInto: (cell: IcicleCell) => void;
}

/**
 * The icicle: one row per level, a block's width is the items it holds. Every block is a button
 * (one tab stop, arrows move along and between levels), drawn only when wide enough to see; the
 * table beside it lists every topic. Layout comes from `icicle-layout`, drawing is plain DOM.
 */
export function ShapeChart({
  t,
  layout,
  wholeTree,
  levelOffset,
  selectedKey,
  zoomPercent,
  truncated,
  onSelect,
  onZoomInto
}: ShapeChartProps) {
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

  const chartWidth = (areaWidth * zoomPercent) / 100;
  const { drawn, hidden, reachable } = useMemo(
    () => drawnCells(layout, chartWidth),
    [layout, chartWidth]
  );
  const stop = selectedKey !== null && reachable.has(selectedKey) ? selectedKey : layout.rootKey;
  const height = layout.rows * rowPitch - rowGap;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = keyMoves[event.key];
    if (!move || event.altKey || event.ctrlKey || event.metaKey) return;
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]")?.dataset.cell;
    if (!from) return;
    const to = moveFocus(layout, from, move, reachable);
    event.preventDefault();
    if (to === null) return;
    areaRef.current?.querySelector<HTMLElement>(`[data-cell="${to}"]`)?.focus();
  };

  return (
    <figure className="flex min-w-0 flex-col gap-3">
      <div className="flex gap-2">
        <div aria-hidden="true" className="flex w-13 shrink-0 flex-col gap-0.5">
          {Array.from({ length: layout.rows }, (_, row) => (
            <div key={row} className="flex h-14 items-center text-xs text-muted-foreground">
              {t("topics.shape.chart.level", { values: { level: row + levelOffset } })}
            </div>
          ))}
        </div>
        <div ref={areaRef} className="min-w-0 flex-1 overflow-x-auto">
          <div
            role="group"
            aria-label={t("topics.shape.chart.label")}
            onKeyDown={onKeyDown}
            className="relative"
            style={{ width: `${zoomPercent}%`, height }}
          >
            {drawn.map((cell) => (
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
                {cell.kind === "direct" ? (
                  <div
                    aria-hidden="true"
                    className="h-full w-full rounded-md border border-dashed border-border-strong"
                  />
                ) : (
                  <Block
                    t={t}
                    cell={cell}
                    wholeTree={wholeTree}
                    levelOffset={levelOffset}
                    widthPx={cellSpan(cell) * chartWidth}
                    selected={cell.key === selectedKey}
                    stop={cell.key === stop}
                    onSelect={onSelect}
                    onZoomInto={onZoomInto}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-secondary-foreground">
        <span>{t("topics.shape.chart.legendWidth")}</span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-3 w-4 rounded-sm"
            style={{ boxShadow: "inset 0 0 0 2px var(--state-warning)" }}
          />
          <WarningGlyph />
          {t("topics.shape.chart.legendAttention")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-3 w-4 rounded-sm"
            style={{ boxShadow: "inset 0 0 0 2px var(--accent)" }}
          />
          {t("topics.shape.chart.legendSelected")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-3 w-4 rounded-sm border border-dashed border-border-strong"
          />
          {t("topics.shape.chart.legendDirect")}
        </span>
        <span>{t("topics.shape.chart.legendNew")}</span>
      </figcaption>
      {truncated ? (
        <p className="text-xs text-muted-foreground">{t("topics.shape.chart.truncated")}</p>
      ) : null}
      {hidden > 0 ? (
        <p className="text-xs text-muted-foreground">{t("topics.shape.chart.pruned")}</p>
      ) : null}
    </figure>
  );
}

function WarningGlyph() {
  const Icon = toneIcon.warning;
  return <Icon className={cn("size-3.5", toneClass.warning)} aria-hidden="true" />;
}

function Block({
  t,
  cell,
  wholeTree,
  levelOffset,
  widthPx,
  selected,
  stop,
  onSelect,
  onZoomInto
}: {
  t: Translator;
  cell: IcicleCell;
  wholeTree: boolean;
  levelOffset: number;
  widthPx: number;
  selected: boolean;
  stop: boolean;
  onSelect: (key: string) => void;
  onZoomInto: (cell: IcicleCell) => void;
}) {
  const node = cell.node;
  const health = node?.health ?? "good";
  const content = cellContent(widthPx);
  const label = cellLabel(t, cell, wholeTree, levelOffset);
  const style: CSSProperties = {
    background: fillOf(cell.row),
    boxShadow: ringOf(selected, health)
  };
  const HealthIcon = health === "good" ? null : toneIcon[shapeHealth[health].tone];
  const glyph = HealthIcon ? (
    <HealthIcon
      className={cn("size-3.5 shrink-0", toneClass[shapeHealth[health].tone])}
      aria-hidden="true"
    />
  ) : null;
  const week = node && node.newThisWeek > 0 ? weekText(t, node.newThisWeek) : null;
  const strong = cell.row <= 1;
  return (
    <button
      type="button"
      data-cell={cell.key}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      tabIndex={stop ? 0 : -1}
      onClick={() => onSelect(cell.key)}
      onDoubleClick={() => onZoomInto(cell)}
      style={style}
      className={cn(
        "flex h-full w-full min-w-0 flex-col justify-center gap-0.5 overflow-hidden rounded-md",
        "text-left text-sm leading-4 text-foreground",
        "focus-visible:-outline-offset-2 focus-visible:outline-foreground",
        content === "none" ? "px-0" : "px-2"
      )}
    >
      {content === "full" ? (
        <>
          <span className={cn("block truncate", strong ? "font-semibold" : "font-medium")}>
            {cellName(t, cell, wholeTree)}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-secondary-foreground tabular-nums">
            <span className="truncate">{itemsText(t, cell.value)}</span>
            {week ? <span className="font-normal text-muted-foreground">{week}</span> : null}
            {glyph}
          </span>
        </>
      ) : null}
      {content === "count" ? (
        <span className="flex items-center gap-1 text-xs text-secondary-foreground tabular-nums">
          {new Intl.NumberFormat(t.locale).format(cell.value)}
          {glyph}
        </span>
      ) : null}
    </button>
  );
}
