import { hierarchy, partition } from "d3-hierarchy";
import type { TopicDiffNode, TopicShapeNode } from "@app/domain";

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
  /**
   * Siblings from the largest to the smallest (ties by name), the items placed directly in a
   * topic and the remainder after them: the Map's tree chart reads best that way.
   */
  sortBySize?: boolean;
}

/** The largest topic first; a tie keeps the name's order, an unnamed topic last. */
export function bySizeThenName(a: TopicShapeNode, b: TopicShapeNode): number {
  if (a.items !== b.items) return b.items - a.items;
  if (a.title === b.title) return 0;
  if (a.title === null) return 1;
  if (b.title === null) return -1;
  return a.title < b.title ? -1 : 1;
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
    const listed = below.get(node.id) ?? [];
    for (const child of options.sortBySize ? [...listed].sort(bySizeThenName) : listed) {
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
export const cellSpan = (cell: { x0: number; x1: number }): number => cell.x1 - cell.x0;

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

/** What `moveFocus` needs of a cell and of a layout: both icicles (the tree and the diff) have it. */
export interface FocusCell {
  row: number;
  parentKey: string | null;
  childKeys: readonly string[];
}

export interface FocusLayout {
  byKey: ReadonlyMap<string, FocusCell>;
  rowKeys: readonly (readonly string[])[];
}

/**
 * Where an arrow key leads from a cell, among the cells that are drawn: along the level, up to the
 * parent or down to the first subtopic. Null when there is nowhere to go.
 */
export function moveFocus(
  layout: FocusLayout,
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

const focusKeys: ReadonlyMap<string, FocusMove> = new Map([
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["Home", "home"],
  ["End", "end"]
]);

/**
 * What a key press does in an icicle: whether the icicle handles it (the arrows, Home and End; the
 * page keeps Tab, Enter and the rest) and, among the drawn cells, where focus goes (null: nowhere to
 * go, the key is still handled so the page does not scroll).
 */
export function keyboardFocus(
  layout: FocusLayout,
  from: string,
  key: string,
  reachable: ReadonlySet<string>
): { handled: boolean; to: string | null } {
  const move = focusKeys.get(key);
  if (move === undefined) return { handled: false, to: null };
  return { handled: true, to: moveFocus(layout, from, move, reachable) };
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

// ---------------------------------------------------------------------------
// The structural diff: the subtree a change-set touched, before and after (docs D30)

/**
 * One icicle per side. A topic the change-set created has no block before, one it retired has none
 * after; a moved topic hangs from its old parent on one side and from its new one on the other.
 * The read lists the touched topics and the ancestors that hang them from the root, so a block's
 * parent is normally listed too; when it is not (the node limit cut it, or it was not touched on
 * this side) the block hangs from the top of its side and is marked `detached`.
 */
export type DiffSide = "before" | "after";
export const diffSides: readonly DiffSide[] = ["before", "after"];

export interface DiffCell {
  /** `before:<topic id>` or `after:<topic id>`. */
  key: string;
  side: DiffSide;
  topicId: string;
  node: TopicDiffNode;
  /** The topic's title on this side. */
  title: string | null;
  /** The level on this side: 0 for the top. */
  row: number;
  /** Left and right edge as a share of the whole width (0..1). */
  x0: number;
  x1: number;
  /** The width the block spans (see `DiffWeight`). */
  value: number;
  parentKey: string | null;
  /** The blocks directly below, left to right. */
  childKeys: string[];
  /** The parent on this side is not in the read: the block hangs from the top. */
  detached: boolean;
}

export interface DiffIcicle {
  side: DiffSide;
  cells: DiffCell[];
  byKey: ReadonlyMap<string, DiffCell>;
  /** Every block from the top down, each before its subtopics: the order a table lists them in. */
  order: string[];
  /** The blocks of each level, left to right. */
  rowKeys: string[][];
  rows: number;
  total: number;
}

export const diffCellKey = (side: DiffSide, topicId: string): string => `${side}:${topicId}`;

/** The width a topic's block gets on a side; a leaf spans it, a parent spans its children. */
export type DiffWeight = (node: TopicDiffNode, side: DiffSide) => number;

/**
 * The default width: one share for the topic plus the square root of the primary placements the
 * change-set moved out of it (before) or into it (after). The diff carries no item totals, so width
 * only hints at where the placements went: a topic that merely changed its name keeps a block wide
 * enough to read, and a merge of hundreds of items does not push the other topics to slivers.
 */
export const movedWeight: DiffWeight = (node, side) =>
  1 + Math.sqrt(side === "before" ? node.itemsOut : node.itemsIn);

const emptyDiffIcicle = (side: DiffSide): DiffIcicle => ({
  side,
  cells: [],
  byKey: new Map<string, DiffCell>(),
  order: [],
  rowKeys: [],
  rows: 0,
  total: 0
});

interface DiffDatum {
  key: string;
  node: TopicDiffNode | null;
  value: number;
  detached: boolean;
  children?: DiffDatum[];
}

/**
 * The blocks of one side of a diff. `nodes` is the list `changes.diff` returned; a topic is on a
 * side when it existed there. Siblings keep the order of the list, so both sides read alike.
 */
export function buildDiffIcicle(
  nodes: readonly TopicDiffNode[],
  side: DiffSide,
  weight: DiffWeight = movedWeight
): DiffIcicle {
  const parentOf = (node: TopicDiffNode): string | null =>
    side === "before" ? node.parentBefore : node.parentAfter;
  const listed = new Map<string, TopicDiffNode>();
  for (const node of nodes) {
    if (!(side === "before" ? node.existedBefore : node.existsAfter)) continue;
    if (!listed.has(node.id)) listed.set(node.id, node);
  }
  if (listed.size === 0) return emptyDiffIcicle(side);

  const below = new Map<string, TopicDiffNode[]>();
  const tops: TopicDiffNode[] = [];
  for (const node of listed.values()) {
    const parent = parentOf(node);
    if (parent !== null && parent !== node.id && listed.has(parent)) {
      const list = below.get(parent);
      if (list) list.push(node);
      else below.set(parent, [node]);
    } else tops.push(node);
  }

  const placed = new Set<string>();
  const datum = (node: TopicDiffNode): DiffDatum => {
    placed.add(node.id);
    const children: DiffDatum[] = [];
    for (const child of below.get(node.id) ?? [])
      if (!placed.has(child.id)) children.push(datum(child));
    const key = diffCellKey(side, node.id);
    if (children.length > 0) return { key, node, value: 0, detached: false, children };
    const width = weight(node, side);
    return { key, node, value: Number.isFinite(width) ? Math.max(1, width) : 1, detached: false };
  };
  const top = (node: TopicDiffNode): DiffDatum => ({
    ...datum(node),
    detached: parentOf(node) !== null
  });
  const roots = tops.map(top);
  // A parent loop (which a consistent tree never has) leaves topics no top reaches: show them too.
  for (const node of listed.values()) if (!placed.has(node.id)) roots.push(top(node));

  const tree = hierarchy<DiffDatum>(
    { key: "", node: null, value: 0, detached: false, children: roots },
    (d) => d.children
  ).sum((d) => d.value);
  if (!(tree.value && tree.value > 0)) return emptyDiffIcicle(side);
  const laid = partition<DiffDatum>().size([1, 1])(tree);

  const cells: DiffCell[] = [];
  const byKey = new Map<string, DiffCell>();
  for (const item of laid.descendants()) {
    const d = item.data;
    if (item.depth === 0 || d.node === null) continue;
    const cell: DiffCell = {
      key: d.key,
      side,
      topicId: d.node.id,
      node: d.node,
      title: side === "before" ? d.node.titleBefore : d.node.titleAfter,
      row: item.depth - 1,
      x0: item.x0,
      x1: item.x1,
      value: item.value ?? d.value,
      parentKey: item.parent && item.parent.depth > 0 ? item.parent.data.key : null,
      childKeys: (item.children ?? []).map((child) => child.data.key),
      detached: d.detached
    };
    cells.push(cell);
    byKey.set(cell.key, cell);
  }

  const order: string[] = [];
  const walk = (key: string): void => {
    const cell = byKey.get(key);
    if (!cell) return;
    order.push(key);
    for (const child of cell.childKeys) walk(child);
  };
  for (const root of laid.children ?? []) walk(root.data.key);

  let rows = 0;
  for (const cell of cells) rows = Math.max(rows, cell.row + 1);
  const rowKeys: string[][] = Array.from({ length: rows }, () => []);
  for (const key of order) rowKeys[byKey.get(key)!.row]!.push(key);
  for (const keys of rowKeys) keys.sort((a, b) => byKey.get(a)!.x0 - byKey.get(b)!.x0);

  return { side, cells, byKey, order, rowKeys, rows, total: tree.value };
}

export interface DrawnDiffCells {
  /** Blocks wide enough to draw. */
  drawn: DiffCell[];
  /** Blocks too narrow to draw; the table lists them. */
  hidden: number;
  /** Keys of the drawn blocks: the ones a key can reach. */
  reachable: ReadonlySet<string>;
}

/** The blocks of a side that are wide enough at this pixel width of the whole chart. */
export function drawnDiffCells(layout: DiffIcicle, widthPx: number): DrawnDiffCells {
  const drawn: DiffCell[] = [];
  const reachable = new Set<string>();
  let hidden = 0;
  for (const cell of layout.cells) {
    if (cellSpan(cell) * widthPx < minDrawnWidth) {
      hidden += 1;
      continue;
    }
    drawn.push(cell);
    reachable.add(cell.key);
  }
  return { drawn, hidden, reachable };
}

/**
 * The block that holds the side's one tab stop: the selected topic's when it is drawn there,
 * otherwise the first drawn block from the top down.
 */
export function tabStop(
  layout: DiffIcicle,
  selectedKey: string | null,
  reachable: ReadonlySet<string>
): string | null {
  if (selectedKey !== null && reachable.has(selectedKey)) return selectedKey;
  return layout.order.find((key) => reachable.has(key)) ?? null;
}
