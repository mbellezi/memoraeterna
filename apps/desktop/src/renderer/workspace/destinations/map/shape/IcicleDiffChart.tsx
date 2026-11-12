import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent
} from "react";
import type { TopicDiffChange, TopicDiffNode } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import { useMeasure } from "./use-measure";
import { DiffGlyph, DiffSwatch, diffFill } from "./diff-marks";
import {
  createKeyAssigner,
  fitDiffLabel,
  type DiffLabelForm,
  type MeasureText
} from "./icicle-fit";
import {
  diffChanges,
  diffCellLabel,
  diffLegend,
  diffSideKeys,
  hiddenText,
  legendLine,
  legendText,
  movedMark,
  topicNameOn
} from "./icicle-diff-model";
import {
  buildDiffIcicle,
  cellSpan,
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

/** The font of a block's name, for fitting it. */
const labelFont = "500 14px Inter, system-ui, sans-serif";

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
  const measure = useMeasure(labelFont);
  // What each block says: name and count, the name, a letter key or nothing (design record §7.4).
  // A topic keeps its letter on both sides, and the legend under the lanes names each letter.
  const { forms, keyed } = useMemo(
    () => fitBlocks(t, layouts, drawn, areaWidth, measure),
    [t, layouts, drawn, areaWidth, measure]
  );
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
            forms={forms}
            letters={keyed.letters}
            selectedId={selectedId}
            onSelect={onSelect}
            onPreview={setPreviewKey}
          />
        ))}
      </div>
      <p aria-hidden="true" className="min-h-4 text-xs text-foreground">
        {preview ? diffCellLabel(t, preview) : null}
      </p>
      {keyed.legend.length > 0 ? (
        <ul
          aria-label={t("inbox.diff.legend")}
          className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-xs text-foreground"
        >
          {keyed.legend.map((entry) => (
            <li key={entry.letter} className="inline-flex items-center gap-1.5">
              <KeyCircle letter={entry.letter} />
              <DiffGlyph change={entry.change} />
              <span>{entry.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
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

/** What a block says of itself, from the room it has. */
interface FitResult {
  forms: ReadonlyMap<string, DiffLabelForm>;
  keyed: {
    /** The letter of each keyed topic. */
    letters: ReadonlyMap<string, string>;
    /** One line per letter, in the order the letters were given. */
    legend: { letter: string; text: string; change: TopicDiffChange }[];
  };
}

/** The line under a block's name: what happened to it and how many items moved. */
function changeLine(t: Translator, cell: DiffCell): string {
  const moved = movedMark(cell);
  const word = t(diffChanges[cell.node.change].key);
  return moved ? `${word} ${moved}` : word;
}

function fitBlocks(
  t: Translator,
  layouts: readonly DiffIcicle[],
  drawn: readonly DrawnDiffCells[],
  widthPx: number,
  measure: MeasureText
): FitResult {
  const forms = new Map<string, DiffLabelForm>();
  const letters = new Map<string, string>();
  const legend: { letter: string; text: string; change: TopicDiffChange }[] = [];
  const letterOf = createKeyAssigner();
  layouts.forEach((layout, index) => {
    for (const cell of drawn[index]!.drawn) {
      const name = topicNameOn(t, cell.node, cell.side);
      const form = fitDiffLabel({
        widthPx: cellSpan(cell) * widthPx,
        name,
        count: changeLine(t, cell),
        measure
      });
      // A topic past the 26th letter has no key: its block says nothing and the table lists it.
      const letter = form === "key" ? letterOf(cell.topicId) : null;
      forms.set(cell.key, form === "key" && letter === null ? "none" : form);
      if (letter !== null && !letters.has(cell.topicId)) {
        letters.set(cell.topicId, letter);
        legend.push({ letter, text: legendLine(t, cell), change: cell.node.change });
      }
    }
  });
  return { forms, keyed: { letters, legend } };
}

/** A letter in a circle: the key of a block too small for its name. */
function KeyCircle({ letter }: { letter: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-grid size-5 shrink-0 place-items-center rounded-full border border-border-strong bg-surface text-xs font-semibold leading-none text-foreground"
    >
      {letter}
    </span>
  );
}

function SideChart({
  t,
  layout,
  drawn,
  forms,
  letters,
  selectedId,
  onSelect,
  onPreview
}: {
  t: Translator;
  layout: DiffIcicle;
  drawn: DrawnDiffCells;
  forms: ReadonlyMap<string, DiffLabelForm>;
  letters: ReadonlyMap<string, string>;
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
                form={forms.get(cell.key) ?? "none"}
                letter={letters.get(cell.topicId) ?? null}
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
  form,
  letter,
  selected,
  stop,
  onSelect
}: {
  t: Translator;
  cell: DiffCell;
  form: DiffLabelForm;
  /** The block's letter when it says only that. */
  letter: string | null;
  selected: boolean;
  stop: boolean;
  onSelect: (topicId: string) => void;
}) {
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
        form === "nameCount" || form === "name" ? "px-2" : "items-center px-0"
      )}
    >
      {form === "nameCount" || form === "name" ? (
        <>
          <span className="flex min-w-0 items-center gap-1.5">
            <DiffGlyph change={cell.node.change} />
            <span className="block truncate font-medium">
              {topicNameOn(t, cell.node, cell.side)}
            </span>
          </span>
          {form === "nameCount" ? (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-secondary-foreground tabular-nums">
              <span className="truncate">{t(diffChanges[cell.node.change].key)}</span>
              {moved ? <span className="shrink-0">{moved}</span> : null}
            </span>
          ) : null}
        </>
      ) : null}
      {form === "key" && letter !== null ? <KeyCircle letter={letter} /> : null}
    </button>
  );
}
