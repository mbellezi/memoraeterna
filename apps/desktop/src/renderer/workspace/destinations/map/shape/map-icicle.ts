import { cellSpan, isSelectableCell, type IcicleCell, type IcicleLayout } from "./icicle-layout";
import { mapMergeBelow, mapMergedMinHeight } from "./icicle-fit";

/**
 * The Map's tree chart (design record §7.5): `icicle-layout.ts` with x and y swapped, so depth runs
 * left to right (Áreas | Tópicos | Subtópicos), a block's height is the notes it holds and its
 * label is horizontal. Columns are 25%, 37.5% and 37.5% of the width, so the deeper labels get
 * more room. The chart shows three levels below the root of the read; the table lists every one,
 * to the tree's depth cap, and a block with levels under it zooms in to show them.
 *
 * Pure geometry in pixels: sorted siblings (the layout is built with `sortBySize`), runs of blocks
 * shorter than 18 px merged into one dashed block, and the keys an arrow can reach.
 */

export const mapColumnShares = [0.25, 0.375, 0.375] as const;
export const mapColumnCount = mapColumnShares.length;
/** Blocks are 2 px apart: each one is inset by half of it. */
export const mapGap = 2;

export type MapBoxKind = "topic" | "unsorted" | "direct" | "merged";

export interface MapBox {
  /** A stable key for the list: the cell's, or `merged:<first key>`. */
  id: string;
  kind: MapBoxKind;
  /** The block's cell; null for a merged block and the one of direct items has the topic's. */
  cell: IcicleCell | null;
  /** The cells a merged block stands for, in order. */
  members: readonly IcicleCell[];
  /** 0 for the first level below the root of the read. */
  column: number;
  x: number;
  w: number;
  y: number;
  h: number;
  /** Notes the block holds (a merged block holds its members'). */
  items: number;
}

export interface MapBoxes {
  boxes: MapBox[];
  /** The selectable blocks that are drawn on their own: the ones an arrow can reach. */
  reachable: ReadonlySet<string>;
  /** Selectable topics under the third level: only the table and a zoom show them. */
  deeper: number;
}

const columnOffsets = mapColumnShares.map((_, index) =>
  mapColumnShares.slice(0, index).reduce((sum, share) => sum + share, 0)
);

export function mapBoxes(
  layout: IcicleLayout,
  size: { widthPx: number; heightPx: number }
): MapBoxes {
  const { widthPx, heightPx } = size;
  const groups = new Map<string, IcicleCell[]>();
  let deeper = 0;
  for (const cell of layout.cells) {
    if (cell.kind === "rest" || cell.row < 1) continue;
    if (cell.row > mapColumnCount) {
      if (isSelectableCell(cell)) deeper += 1;
      continue;
    }
    const group = groups.get(cell.parentKey ?? "");
    if (group) group.push(cell);
    else groups.set(cell.parentKey ?? "", [cell]);
  }

  const boxes: MapBox[] = [];
  const reachable = new Set<string>();
  const place = (cell: IcicleCell): MapBox => {
    const column = cell.row - 1;
    return {
      id: cell.key,
      kind: cell.kind === "direct" ? "direct" : cell.kind === "unsorted" ? "unsorted" : "topic",
      cell,
      members: [],
      column,
      x: columnOffsets[column]! * widthPx,
      w: mapColumnShares[column]! * widthPx,
      y: cell.x0 * heightPx,
      h: cellSpan(cell) * heightPx,
      items: cell.value
    };
  };

  for (const cells of groups.values()) {
    cells.sort((a, b) => a.x0 - b.x0);
    let run: IcicleCell[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const first = run[0]!;
        const last = run.at(-1)!;
        const column = first.row - 1;
        const top = first.x0 * heightPx;
        boxes.push({
          id: `merged:${first.key}`,
          kind: "merged",
          cell: null,
          members: run,
          column,
          x: columnOffsets[column]! * widthPx,
          w: mapColumnShares[column]! * widthPx,
          y: top,
          h: Math.max(mapMergedMinHeight, last.x1 * heightPx - top),
          items: run.reduce((sum, cell) => sum + cell.value, 0)
        });
      } else if (run.length === 1) {
        const box = place(run[0]!);
        boxes.push(box);
        reachable.add(box.id);
      }
      run = [];
    };
    for (const cell of cells) {
      const height = cellSpan(cell) * heightPx;
      if (isSelectableCell(cell) && height < mapMergeBelow) {
        run.push(cell);
        continue;
      }
      flush();
      if (height < 1) continue;
      boxes.push(place(cell));
      if (isSelectableCell(cell)) reachable.add(cell.key);
    }
    flush();
  }
  return { boxes, reachable, deeper };
}

/** The ancestors of a cell that the chart draws (the cell included), for the "aqui" marker. */
export function drawnTrail(layout: IcicleLayout, key: string): string[] {
  const trail: string[] = [];
  let current = layout.byKey.get(key);
  while (current) {
    if (current.row >= 1 && current.row <= mapColumnCount) trail.unshift(current.key);
    current = current.parentKey === null ? undefined : layout.byKey.get(current.parentKey);
  }
  return trail;
}
