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

import { countLabel } from "../../../../components/topic-page/topic-page-model";
import { cn } from "../../../../lib/cn";
import { toneClass, toneIcon } from "./health-marks";
import { fitMapLabel, type MeasureText } from "./icicle-fit";
import { fillShares, moveFocus, type FocusMove, type IcicleLayout } from "./icicle-layout";
import { mapBoxes, mapColumnShares, mapGap, type MapBox } from "./map-icicle";
import { cellLabel, cellName, shapeHealth } from "./shape-model";
import { useMeasure } from "./use-measure";

/** The chart's height is layout, not copy: 440 px holds a few hundred notes legibly. */
export const mapChartHeight = 440;
/** The width assumed before the chart has been measured (and when it cannot be). */
const defaultAreaWidth = 560;
const labelFont = "500 12px Inter, system-ui, sans-serif";

/** Depth runs left to right, so the vertical arrows move along a column and the horizontal ones between levels. */
const keyMoves: Partial<Record<string, FocusMove>> = {
  ArrowUp: "left",
  ArrowDown: "right",
  ArrowLeft: "up",
  ArrowRight: "down",
  Home: "home",
  End: "end"
};

/** Deeper columns are paler; the colour only tints, the words carry the meaning. */
function fillOf(row: number, selected: boolean): string {
  if (selected) return "var(--surface-selected)";
  const share = fillShares[Math.min(Math.max(row, 1), fillShares.length) - 1];
  return `color-mix(in srgb, var(--object-topic) ${share}%, var(--surface-raised))`;
}

const ringColour: Record<TopicHealth, string | null> = {
  good: null,
  attention: "var(--state-warning)",
  violation: "var(--state-danger)"
};

/** The selection's 2 px accent outline, with the health ring inside it: both show at once. */
function ringOf(selected: boolean, health: TopicHealth, here: boolean): string | undefined {
  const rings: string[] = [];
  if (selected) rings.push("inset 0 0 0 2px var(--accent)");
  const mark = ringColour[health];
  if (mark) rings.push(`inset 0 0 0 ${selected ? 4 : 2}px ${mark}`);
  // The ancestor that holds where the person was: a 3 px bar on its left edge.
  if (here) rings.push("inset 3px 0 0 0 var(--accent)");
  return rings.length === 0 ? undefined : rings.join(", ");
}

export interface MapChartProps {
  t: Translator;
  layout: IcicleLayout;
  /** The chart starts at the root of the tree, not at a branch. */
  wholeTree: boolean;
  /** The level of the chart's root in the whole tree. */
  levelOffset: number;
  /** The block shown as selected; always one of the layout's blocks. */
  selectedKey: string | null;
  /** The drawn blocks that hold where the person came from (the "aqui" marker). */
  hereKeys: ReadonlySet<string>;
  /** The read stopped at its depth or node limit. */
  truncated: boolean;
  onSelect: (key: string) => void;
  /** Enter or a double click on a block: show its branch alone. */
  onZoomInto: (key: string) => void;
}

/**
 * The tree chart of the Map (design record §7.5): depth runs left to right (Áreas | Tópicos |
 * Subtópicos), a block is as tall as the notes it holds, siblings are sorted by size and a run of
 * blocks under 18 px is one dashed "mais N" block. Every block that is drawn on its own is a button
 * (one tab stop; arrows move, Enter zooms in). The table beside it lists every topic.
 */
export function MapChart({
  t,
  layout,
  wholeTree,
  levelOffset,
  selectedKey,
  hereKeys,
  truncated,
  onSelect,
  onZoomInto
}: MapChartProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(defaultAreaWidth);
  useEffect(() => {
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // Coarse steps: a few pixels of window resize redraw nothing.
      if (width > 0) setAreaWidth(Math.max(16, Math.round(width / 8) * 8));
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);
  const measure = useMeasure(labelFont);

  const { boxes, reachable, deeper } = useMemo(
    () => mapBoxes(layout, { widthPx: areaWidth, heightPx: mapChartHeight }),
    [layout, areaWidth]
  );
  const stop = selectedKey !== null && reachable.has(selectedKey) ? selectedKey : null;
  const firstReachable = stop ?? boxes.find((box) => box.cell && reachable.has(box.id))?.id ?? null;
  const columnNames = [
    wholeTree && levelOffset === 0 ? t("map.chart.columns.areas") : null,
    wholeTree && levelOffset === 0 ? t("map.chart.columns.topics") : null,
    wholeTree && levelOffset === 0 ? t("map.chart.columns.subtopics") : null
  ];
  const hidden = boxes.filter((box) => box.kind === "merged").length;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const from = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]")?.dataset.cell;
    if (!from) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onZoomInto(from);
      return;
    }
    const move = keyMoves[event.key];
    if (!move) return;
    const to = moveFocus(layout, from, move, reachable);
    event.preventDefault();
    if (to === null) return;
    areaRef.current?.querySelector<HTMLElement>(`[data-cell="${to}"]`)?.focus();
  };

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-3">
      <div ref={areaRef} className="min-w-0">
        <div
          aria-hidden="true"
          className="mb-1 flex text-xs font-semibold text-secondary-foreground"
        >
          {mapColumnShares.map((share, column) => (
            <span
              key={column}
              className="min-w-0 truncate px-2"
              style={{ width: `${share * 100}%` }}
            >
              {columnNames[column] ??
                t("topics.shape.chart.level", { values: { level: levelOffset + column + 1 } })}
            </span>
          ))}
        </div>
        <div
          role="group"
          aria-label={t("map.chart.label")}
          onKeyDown={onKeyDown}
          className="relative"
          style={{ height: mapChartHeight }}
        >
          {boxes.map((box) =>
            box.kind === "merged" ? (
              <MergedBlock key={box.id} t={t} box={box} />
            ) : box.kind === "direct" ? (
              <div
                key={box.id}
                aria-hidden="true"
                className="absolute rounded-md border border-dashed border-border-strong"
                style={rect(box)}
              />
            ) : (
              <Block
                key={box.id}
                t={t}
                box={box}
                wholeTree={wholeTree}
                levelOffset={levelOffset}
                measure={measure}
                selected={box.id === selectedKey}
                here={hereKeys.has(box.id)}
                stop={box.id === firstReachable}
                onSelect={onSelect}
                onZoomInto={onZoomInto}
              />
            )
          )}
        </div>
      </div>
      <figcaption className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-secondary-foreground">
        <span>{t("map.chart.legend.height")}</span>
        <span className="inline-flex items-center gap-1.5">
          <WarningGlyph />
          {t("map.chart.legend.attention")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-3 w-4 rounded-sm"
            style={{ boxShadow: "inset 0 0 0 2px var(--accent)" }}
          />
          {t("map.chart.legend.selected")}
        </span>
        {hereKeys.size > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-3 w-4 rounded-sm"
              style={{ boxShadow: "inset 3px 0 0 0 var(--accent)" }}
            />
            {t("map.chart.legend.here")}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-3 w-4 rounded-sm border border-dashed border-border-strong"
          />
          {t("map.chart.legend.direct")}
        </span>
      </figcaption>
      {truncated ? (
        <p className="m-0 text-xs text-muted-foreground">{t("topics.shape.chart.truncated")}</p>
      ) : null}
      {deeper > 0 ? (
        <p className="m-0 text-xs text-muted-foreground">
          {t("map.chart.deeper", {
            values: { count: new Intl.NumberFormat(t.locale).format(deeper) }
          })}
        </p>
      ) : null}
      {hidden > 0 ? (
        <p className="m-0 text-xs text-muted-foreground">{t("map.chart.merged")}</p>
      ) : null}
    </figure>
  );
}

const rect = (box: MapBox): CSSProperties => ({
  left: box.x + mapGap / 2,
  top: box.y + mapGap / 2,
  width: Math.max(0, box.w - mapGap),
  height: Math.max(1, box.h - mapGap)
});

function WarningGlyph() {
  const Icon = toneIcon.warning;
  return <Icon className={cn("size-3.5", toneClass.warning)} aria-hidden="true" />;
}

/** A run of small blocks as one dashed block: how many and how many notes; the table lists them. */
function MergedBlock({ t, box }: { t: Translator; box: MapBox }) {
  const notes = countLabel(t, "notes", box.items);
  const names = box.members.map((cell) => cellName(t, cell, false)).join(", ");
  const label = t("map.chart.moreTopics", {
    values: { count: new Intl.NumberFormat(t.locale).format(box.members.length), notes }
  });
  return (
    <div
      title={`${label}: ${names}`}
      className="absolute flex items-center overflow-hidden rounded-md border border-dashed border-border-strong px-2 text-xs text-secondary-foreground"
      style={rect(box)}
    >
      <span aria-hidden="true" className="truncate">
        {label}
      </span>
      <span className="sr-only">{`${label}: ${names}`}</span>
    </div>
  );
}

function Block({
  t,
  box,
  wholeTree,
  levelOffset,
  measure,
  selected,
  here,
  stop,
  onSelect,
  onZoomInto
}: {
  t: Translator;
  box: MapBox;
  wholeTree: boolean;
  levelOffset: number;
  measure: MeasureText;
  selected: boolean;
  here: boolean;
  stop: boolean;
  onSelect: (key: string) => void;
  onZoomInto: (key: string) => void;
}) {
  const cell = box.cell!;
  const node = cell.node;
  const health = node?.health ?? "good";
  const name = cellName(t, cell, wholeTree);
  const count = countLabel(t, "notes", cell.value);
  const form = fitMapLabel({
    widthPx: box.w - mapGap,
    heightPx: box.h - mapGap,
    name,
    count,
    measure
  });
  const label = cellLabel(t, cell, wholeTree, levelOffset);
  const HealthIcon = health === "good" ? null : toneIcon[shapeHealth[health].tone];
  return (
    <button
      type="button"
      data-cell={cell.key}
      data-form={form}
      aria-label={here ? `${label}, ${t("map.chart.here")}` : label}
      aria-pressed={selected}
      title={label}
      tabIndex={stop ? 0 : -1}
      onClick={() => onSelect(cell.key)}
      onDoubleClick={() => onZoomInto(cell.key)}
      style={{
        ...rect(box),
        background: fillOf(cell.row, selected),
        boxShadow: ringOf(selected, health, here)
      }}
      className={cn(
        "absolute flex min-w-0 overflow-hidden rounded-md border-0 px-2 text-left text-xs text-foreground",
        form === "stacked" ? "flex-col justify-center gap-0.5" : "items-center gap-1.5",
        "focus-visible:-outline-offset-2 focus-visible:outline-foreground"
      )}
    >
      {form === "none" ? null : (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "block min-w-0 truncate",
                cell.row <= 1 ? "font-semibold" : "font-medium"
              )}
            >
              {name}
            </span>
            {HealthIcon ? (
              <HealthIcon
                className={cn("size-3.5 shrink-0", toneClass[shapeHealth[health].tone])}
                aria-hidden="true"
              />
            ) : null}
            {here ? (
              <span className="shrink-0 font-semibold text-accent">{`${t("map.chart.here")} ↳`}</span>
            ) : null}
          </span>
          {form === "nameCount" || form === "stacked" ? (
            <span className="shrink-0 whitespace-nowrap text-secondary-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </>
      )}
    </button>
  );
}
