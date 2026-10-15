import { hierarchy, partition } from "d3-hierarchy";
import type { TopicShapeNode } from "@app/domain";

/**
 * The icicle of the topic tree: one row per level, width proportional to the items a topic holds.
 * The geometry comes from d3-hierarchy's partition and nothing else of d3 is used; the cells are
 * drawn as DOM controls by the view, so everything here is plain data and runs without a renderer.
 *
 * A topic's width is the sum of its subtopics, the items placed directly in it and a remainder for
 * whatever the read left out (a node limit cut the siblings), so a parent always spans exactly its
 * children and the widths of a row never exceed the row above.
 */

/**
 * - `topic`: a topic, selectable and focusable.
 * - `unsorted`: the items placed directly on the root, which wait for a place (docs D27).
 * - `direct`: the items placed directly in an internal topic (the dashed block under it).
 * - `rest`: width the read did not list; never drawn.
 */
export type IcicleCellKind = "topic" | "unsorted" | "direct" | "rest";

export interface IcicleCell {
  /** `topic:<id>`, `unsorted`, `direct:<id>` or `rest:<id>`. */
  key: string;
  kind: IcicleCellKind;
  /** The topic the cell belongs to (the root for `unsorted`). */
  topicId: string;
  /** The topic's read; null for the pseudo cells. */
  node: TopicShapeNode | null;
  /** The level: 0 for the root of the view. */
  row: number;
  /** Left and right edge as a share of the whole width (0..1). */
  x0: number;
  x1: number;
  /** Items the cell spans. */
  value: number;
  parentKey: string | null;
  /** Selectable cells directly below, left to right. */
  childKeys: string[];
  /** A topic whose subtopics the read did not list (the depth limit cut them). */
  cut: boolean;
}

export interface IcicleLayout {
  /** Every cell, level by level. */
  cells: IcicleCell[];
  byKey: ReadonlyMap<string, IcicleCell>;
  /** Selectable cells (topics and unsorted) from the root down, each before its subtopics: the table order. */
  order: string[];
  /** Selectable cells of each level, left to right. */
  rowKeys: string[][];
  /** Levels drawn. */
  rows: number;
  /** Items under the root of the view. */
  total: number;
  rootKey: string | null;
}

export const emptyIcicle: IcicleLayout = Object.freeze({
  cells: [],
  byKey: new Map<string, IcicleCell>(),
  order: [],
  rowKeys: [],
  rows: 0,
  total: 0,
  rootKey: null
});

export const topicCellKey = (topicId: string): string => `topic:${topicId}`;
export const unsortedCellKey = "unsorted";

export const isSelectableCell = (cell: IcicleCell): boolean =>
  cell.kind === "topic" || cell.kind === "unsorted";

interface Datum {
  key: string;
  kind: IcicleCellKind;
  topicId: string;
  node: TopicShapeNode | null;
  value: number;
  cut: boolean;
  children?: Datum[];
}

function pseudo(kind: "unsorted" | "direct" | "rest", node: TopicShapeNode, value: number): Datum {
  const key = kind === "unsorted" ? unsortedCellKey : `${kind}:${node.id}`;
  return { key, kind, topicId: node.id, node: null, value, cut: false };
}

export interface IcicleOptions {
  /**
   * The read starts at the root of the tree, so the items placed directly on it are the unsorted
   * ones. In a branch they are that topic's direct items like any other.
   */
  wholeTree: boolean;
}

/**
 * The cells of a shape read. `nodes` is the flat list of `topics.shape`: the requested root has no
 * parent, siblings keep their order. Returns the empty layout for an empty or rootless read.
 */
export function buildIcicle(
  nodes: readonly TopicShapeNode[],
  options: IcicleOptions = { wholeTree: true }
): IcicleLayout {
  const root = nodes.find((node) => node.parentId === null);
  if (!root || root.items <= 0) return emptyIcicle;
  const below = new Map<string, TopicShapeNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = below.get(node.parentId);
    if (list) list.push(node);
    else below.set(node.parentId, [node]);
  }

  const seen = new Set<string>();
  const datum = (node: TopicShapeNode, isRoot: boolean): Datum => {
    seen.add(node.id);
    const base = {
      key: topicCellKey(node.id),
      kind: "topic" as const,
      topicId: node.id,
      node
    };
    const unsortedHere = isRoot && options.wholeTree;
    // A topic listed twice (or below itself) is built once.
    const children: Datum[] = [];
    let used = 0;
    for (const child of below.get(node.id) ?? []) {
      if (seen.has(child.id)) continue;
      children.push(datum(child, false));
      used += child.items;
    }
    if (children.length === 0 && !(unsortedHere && node.directItems > 0))
      return { ...base, value: node.items, cut: node.children > 0 };
    if (node.directItems > 0) {
      children.push(pseudo(unsortedHere ? "unsorted" : "direct", node, node.directItems));
      used += node.directItems;
    }
    // Items the read did not list (a node limit cut some siblings) keep their share of the width.
    if (node.items > used) children.push(pseudo("rest", node, node.items - used));
    return { ...base, value: 0, cut: false, children };
  };

  const tree = hierarchy(datum(root, true), (d) => d.children).sum((d) => d.value);
  if (!(tree.value && tree.value > 0)) return emptyIcicle;
  const placed = partition<Datum>().size([1, 1])(tree);

  const cells: IcicleCell[] = [];
  const byKey = new Map<string, IcicleCell>();
  for (const item of placed.descendants()) {
    const d = item.data;
    const cell: IcicleCell = {
      key: d.key,
      kind: d.kind,
      topicId: d.topicId,
      node: d.node,
      row: item.depth,
      x0: item.x0,
      x1: item.x1,
      value: item.value ?? d.value,
      parentKey: item.parent ? item.parent.data.key : null,
      childKeys: (item.children ?? [])
        .filter((child) => child.data.kind === "topic" || child.data.kind === "unsorted")
        .map((child) => child.data.key),
      cut: d.cut
    };
    cells.push(cell);
    byKey.set(cell.key, cell);
  }

  const rootKey = tree.data.key;
  const order: string[] = [];
  const walk = (key: string): void => {
    const cell = byKey.get(key);
    if (!cell) return;
    order.push(key);
    for (const child of cell.childKeys) walk(child);
  };
  walk(rootKey);

  let rows = 0;
  for (const cell of cells) rows = Math.max(rows, cell.row + 1);
  const rowKeys: string[][] = Array.from({ length: rows }, () => []);
  for (const key of order) rowKeys[byKey.get(key)!.row]!.push(key);
  for (const keys of rowKeys) keys.sort((a, b) => byKey.get(a)!.x0 - byKey.get(b)!.x0);

  return { cells, byKey, order, rowKeys, rows, total: tree.value, rootKey };
}

/** The share of the width a cell spans. */
export const cellSpan = (cell: IcicleCell): number => cell.x1 - cell.x0;

/** A block narrower than this many pixels is not drawn (the table lists every topic). */
export const minDrawnWidth = 3;
/** How much a block of this width can say: its name and count, only its count, or nothing. */
export const fullLabelWidth = 88;
export const countLabelWidth = 32;

export type CellContent = "full" | "count" | "none";

export function cellContent(widthPx: number): CellContent {
  if (widthPx >= fullLabelWidth) return "full";
  if (widthPx >= countLabelWidth) return "count";
  return "none";
}

export interface DrawnCells {
  /** Cells to draw: wide enough, never the remainder. */
  drawn: IcicleCell[];
  /** Selectable cells too narrow to draw. */
  hidden: number;
  /** Keys of the selectable cells that are drawn (the ones a key can reach). */
  reachable: ReadonlySet<string>;
}

/** The cells that are wide enough at this pixel width of the whole chart. */
export function drawnCells(layout: IcicleLayout, widthPx: number): DrawnCells {
  const drawn: IcicleCell[] = [];
  const reachable = new Set<string>();
  let hidden = 0;
  for (const cell of layout.cells) {
    if (cell.kind === "rest") continue;
    if (cellSpan(cell) * widthPx < minDrawnWidth) {
      if (isSelectableCell(cell)) hidden += 1;
      continue;
    }
    drawn.push(cell);
    if (isSelectableCell(cell)) reachable.add(cell.key);
  }
  return { drawn, hidden, reachable };
}

export type FocusMove = "left" | "right" | "up" | "down" | "home" | "end";

/**
 * Where an arrow key leads from a cell, among the cells that are drawn: along the level, up to the
 * parent or down to the first subtopic. Null when there is nowhere to go.
 */
export function moveFocus(
  layout: IcicleLayout,
  from: string,
  move: FocusMove,
  reachable: ReadonlySet<string>
): string | null {
  const cell = layout.byKey.get(from);
  if (!cell) return null;
  if (move === "up")
    return cell.parentKey !== null && reachable.has(cell.parentKey) ? cell.parentKey : null;
  if (move === "down") return cell.childKeys.find((key) => reachable.has(key)) ?? null;
  const row = (layout.rowKeys[cell.row] ?? []).filter((key) => reachable.has(key));
  const index = row.indexOf(from);
  if (index < 0) return null;
  if (move === "home") return row[0] ?? null;
  if (move === "end") return row.at(-1) ?? null;
  return row[index + (move === "left" ? -1 : 1)] ?? null;
}

/** The selectable cells from the root down to a cell, the cell last. */
export function cellTrail(layout: IcicleLayout, key: string): IcicleCell[] {
  const trail: IcicleCell[] = [];
  let current = layout.byKey.get(key);
  while (current) {
    trail.unshift(current);
    current = current.parentKey === null ? undefined : layout.byKey.get(current.parentKey);
  }
  return trail;
}

/**
 * How much of the topic colour tints a block, by level below the root: deeper rows are paler.
 * The words carry the meaning; a test checks text contrast on every one of these mixes.
 */
export const fillShares = [18, 11, 6, 3] as const;

/** Chart zoom steps as a share of the width of the area: 100% fits the area. */
export const zoomSteps = [100, 150, 200, 300, 400, 600, 800] as const;

export function stepZoom(current: number, direction: "in" | "out"): number {
  const index = zoomSteps.findIndex((step) => step >= current);
  const at = index < 0 ? zoomSteps.length - 1 : index;
  const next = Math.min(zoomSteps.length - 1, Math.max(0, at + (direction === "in" ? 1 : -1)));
  return zoomSteps[next]!;
}
