import type {
  TopicItemLeaf,
  TopicNodeSummary,
  TopicNotes,
  TopicPathEntry,
  TopicTree,
  TopicsChangedEvent
} from "@app/domain";
import type { RecentTarget } from "../../lib/view-history";

/**
 * The navigator's model, without React or the DOM: what a branch of the tree holds, how branches
 * flatten into outline rows, what a key does, which rows a scrolled list renders and which branches
 * a pushed change touches. The store loads and the views draw; both are driven by these functions.
 */

/** Every row is this tall (the 4 px grid), which is what lets a long tree render only a window. */
export const navRowHeight = 28;
/** Children asked for per `topics.tree` page, leaves peeked per branch and leaves per page. */
export const navLimits = {
  children: 100,
  childrenMax: 200,
  peek: 5,
  peekMax: 50,
  page: 50
} as const;

/** Branches are keyed by their parent topic; the root's has this key. */
export const rootBranchKey = "root";
/** The expansion key of the Unsorted group (the root's own leaves). */
export const unsortedKey = "unsorted";
export const branchKeyOf = (parentId: string | null): string => parentId ?? rootBranchKey;

/** Pagination of something a branch holds beyond its first answer. */
export type MoreState = "idle" | "loading" | "error";

/** What one `topics.tree` answer gave, plus the pages read after it. */
export interface BranchData {
  parent: TopicNodeSummary;
  nodes: readonly TopicNodeSummary[];
  nextCursor: string | null;
  items: readonly TopicItemLeaf[];
  /** Leaves of the parent that `items` leaves out. */
  moreItems: number;
  /** The cursor of the next `topics.notes` page, once leaves were read past the peek. */
  itemsCursor: string | null;
  generation: number;
}

export interface Branch {
  phase: "loading" | "ready" | "error";
  /** The last answer. A failed refresh keeps showing it. */
  data: BranchData | null;
  moreTopics: MoreState;
  moreItems: MoreState;
}

export const emptyBranch = (phase: Branch["phase"], data: BranchData | null = null): Branch => ({
  phase,
  data,
  moreTopics: "idle",
  moreItems: "idle"
});

export function branchDataFromTree(tree: TopicTree): BranchData {
  return {
    parent: tree.parent,
    nodes: tree.nodes,
    nextCursor: tree.nextCursor,
    items: tree.items,
    moreItems: tree.moreItems,
    itemsCursor: null,
    generation: tree.generation
  };
}

const leafKey = (leaf: TopicItemLeaf) => `${leaf.kind}:${leaf.id}:${leaf.role}`;

/** More children appended; a topic that moved between two pages is listed once. */
export function appendNodes(data: BranchData, tree: TopicTree): BranchData {
  const known = new Set(data.nodes.map((node) => node.id));
  return {
    ...data,
    nodes: [...data.nodes, ...tree.nodes.filter((node) => !known.has(node.id))],
    nextCursor: tree.nextCursor,
    generation: Math.max(data.generation, tree.generation)
  };
}

/**
 * More leaves read. `first` is a page read from the start (it repeats the leaves already shown, in
 * the same order); later pages follow the cursor. The count of what is left follows the total the
 * first answer reported, and a cursor that is still set always leaves at least one.
 */
export function withItemsPage(data: BranchData, page: TopicNotes, first: boolean): BranchData {
  const total = data.items.length + data.moreItems;
  let items: TopicItemLeaf[];
  if (first) items = [...page.items];
  else {
    const known = new Set(data.items.map(leafKey));
    items = [...data.items, ...page.items.filter((leaf) => !known.has(leafKey(leaf)))];
  }
  const remaining = page.nextCursor === null ? 0 : Math.max(1, total - items.length);
  return { ...data, items, moreItems: remaining, itemsCursor: page.nextCursor };
}

// ---------------------------------------------------------------------------
// Rows

/** What the places above the tree (Pinned and Recents) list. */
export interface PlaceEntry {
  /** `memora://<kind>/<id>` as the history stores it. */
  address: string;
  kind: "topic" | "note" | "source";
  /** For a topic: the live topic the entry leads to (a retired one resolves to its successor). */
  id: string;
  /** Null for a topic that is not named yet; the view says "Unnamed topic". */
  title: string | null;
  /** Pinned in the history (a pinned topic is also protected, docs D28). */
  pinned: boolean;
  /** Items in a topic's subtree; null for notes, sources and while unknown. */
  count: number | null;
  health: TopicNodeSummary["health"] | null;
  management: TopicNodeSummary["management"] | null;
  /** Where a note or source opens in the Library; null for topics. */
  source: RecentTarget | null;
}

interface RowBase {
  key: string;
  level: number;
  parentKey: string | null;
  posInSet: number;
  setSize: number;
}
export interface TopicRow extends RowBase {
  type: "topic";
  node: TopicNodeSummary;
  expandable: boolean;
  expanded: boolean;
}
export interface LeafRow extends RowBase {
  type: "leaf";
  leaf: TopicItemLeaf;
  /** The leaf waits at an internal topic (docs D27); the Unsorted group's leaves all do. */
  waiting: boolean;
}
export interface UnsortedRow extends RowBase {
  type: "unsorted";
  count: number;
  expandable: true;
  expanded: boolean;
}
export interface MoreRow extends RowBase {
  type: "more";
  what: "topics" | "items";
  /** The topic whose children or leaves continue; null for the root. */
  parentId: string | null;
  remaining: number | null;
  state: MoreState;
}
export interface StatusRow extends RowBase {
  type: "status";
  state: "loading" | "error";
  parentId: string | null;
}
export interface PlaceRow extends RowBase {
  type: "place";
  place: PlaceEntry;
}
export type NavRow = TopicRow | LeafRow | UnsortedRow | MoreRow | StatusRow | PlaceRow;

export type ExpandableRow = TopicRow | UnsortedRow;
export const isExpandableRow = (row: NavRow): row is ExpandableRow =>
  (row.type === "topic" || row.type === "unsorted") && row.expandable;

export const topicKey = (id: string) => `t:${id}`;
const moreKey = (parentKey: string, what: MoreRow["what"]) => `m:${parentKey}:${what}`;
const statusKey = (parentKey: string) => `s:${parentKey}`;

/** A topic offers a chevron when it has subtopics or leaves of its own. */
export const topicExpandable = (node: TopicNodeSummary) =>
  node.children > 0 || node.directItems > 0;

type Draft = { row: NavRow; node?: TopicNodeSummary };

/** Outline rows of one parent's children: subtopics, then its leaves, each group with its "more". */
function branchRows(
  branches: ReadonlyMap<string, Branch>,
  expanded: ReadonlySet<string>,
  parentId: string | null,
  parentKey: string | null,
  level: number,
  out: NavRow[],
  options: { leaves: boolean; waiting: boolean }
): void {
  const branchKey = branchKeyOf(parentId);
  const branch = branches.get(branchKey);
  const data = branch?.data ?? null;
  const owner = parentKey ?? rootBranchKey;
  const drafts: Draft[] = [];
  const base = (key: string): RowBase => ({ key, level, parentKey, posInSet: 0, setSize: 0 });
  if (!data) {
    if (branch?.phase !== "ready") {
      drafts.push({
        row: {
          ...base(statusKey(owner)),
          type: "status",
          state: branch?.phase === "error" ? "error" : "loading",
          parentId
        }
      });
    }
  } else {
    for (const node of data.nodes) {
      drafts.push({
        node,
        row: {
          ...base(topicKey(node.id)),
          type: "topic",
          node,
          expandable: topicExpandable(node),
          expanded: topicExpandable(node) && expanded.has(node.id)
        }
      });
    }
    if (data.nextCursor !== null) {
      drafts.push({
        row: {
          ...base(moreKey(owner, "topics")),
          type: "more",
          what: "topics",
          parentId,
          remaining: null,
          state: branch?.moreTopics ?? "idle"
        }
      });
    }
    if (options.leaves) {
      for (const leaf of data.items) {
        drafts.push({
          row: {
            ...base(`l:${owner}:${leaf.kind}:${leaf.id}:${leaf.role}`),
            type: "leaf",
            leaf,
            waiting: options.waiting && leaf.unsorted
          }
        });
      }
      if (data.moreItems > 0) {
        drafts.push({
          row: {
            ...base(moreKey(owner, "items")),
            type: "more",
            what: "items",
            parentId,
            remaining: data.moreItems,
            state: branch?.moreItems ?? "idle"
          }
        });
      }
    }
  }
  drafts.forEach((draft, index) => {
    draft.row.posInSet = index + 1;
    draft.row.setSize = drafts.length;
    out.push(draft.row);
    if (draft.node && draft.row.type === "topic" && draft.row.expanded) {
      branchRows(branches, expanded, draft.node.id, draft.row.key, level + 1, out, {
        leaves: true,
        waiting: true
      });
    }
  });
}

/**
 * The Topics tree: the root's children as the top level, open topics showing their branch. A
 * hoisted tree (`hoistId`, "Show only this branch") starts at that topic: its subtopics and its
 * own leaves are the top level.
 */
export function topicRows(
  branches: ReadonlyMap<string, Branch>,
  expanded: ReadonlySet<string>,
  hoistId: string | null = null
): NavRow[] {
  const out: NavRow[] = [];
  if (hoistId !== null) {
    branchRows(branches, expanded, hoistId, null, 1, out, { leaves: true, waiting: true });
    return out;
  }
  if (!branches.get(rootBranchKey)?.data) return out;
  branchRows(branches, expanded, null, null, 1, out, { leaves: false, waiting: false });
  return out;
}

/** The Unsorted group (docs D27): the root's own leaves, shown only while there are some. */
export function unsortedRows(
  branches: ReadonlyMap<string, Branch>,
  expanded: ReadonlySet<string>
): NavRow[] {
  const data = branches.get(rootBranchKey)?.data;
  if (!data || data.parent.unsorted === 0) return [];
  const open = expanded.has(unsortedKey);
  const rows: NavRow[] = [
    {
      type: "unsorted",
      key: unsortedKey,
      level: 1,
      parentKey: null,
      posInSet: 1,
      setSize: 1,
      count: data.parent.unsorted,
      expandable: true,
      expanded: open
    }
  ];
  if (!open) return rows;
  const group: NavRow[] = [];
  const level = 2;
  const parentKey = unsortedKey;
  for (const leaf of data.items) {
    group.push({
      type: "leaf",
      key: `l:${unsortedKey}:${leaf.kind}:${leaf.id}:${leaf.role}`,
      level,
      parentKey,
      posInSet: 0,
      setSize: 0,
      leaf,
      waiting: false
    });
  }
  if (data.moreItems > 0) {
    group.push({
      type: "more",
      key: moreKey(unsortedKey, "items"),
      level,
      parentKey,
      posInSet: 0,
      setSize: 0,
      what: "items",
      parentId: null,
      remaining: data.moreItems,
      state: branches.get(rootBranchKey)?.moreItems ?? "idle"
    });
  }
  group.forEach((row, index) => {
    row.posInSet = index + 1;
    row.setSize = group.length;
  });
  return [...rows, ...group];
}

/** Pinned or recent entries as a flat outline. */
export function placeRows(places: readonly PlaceEntry[], group: "pinned" | "recents"): NavRow[] {
  return places.map((place, index) => ({
    type: "place",
    key: `p:${group}:${place.address}`,
    level: 1,
    parentKey: null,
    posInSet: index + 1,
    setSize: places.length,
    place
  }));
}

/** What the Topics section shows, from the root branch alone. */
export type RootState = "loading" | "error" | "preparing" | "empty" | "tree";

export function rootState(root: Branch | undefined): RootState {
  if (!root) return "loading";
  if (!root.data) {
    return root.phase === "error" ? "error" : root.phase === "loading" ? "loading" : "preparing";
  }
  return root.data.parent.items === 0 && root.data.nodes.length === 0 ? "empty" : "tree";
}

// ---------------------------------------------------------------------------
// Keyboard

export type NavAction =
  | { type: "focus"; key: string }
  | { type: "expand" | "collapse"; key: string }
  | { type: "activate"; key: string }
  | { type: "none" };
const none: NavAction = { type: "none" };

/**
 * What a key does on the row at `index` (an ARIA tree with one tab stop): arrows move, Home and End
 * jump, Right opens a branch or enters it, Left closes it or goes to the parent, Enter and Space
 * open the row's object.
 */
export function navigationAction(rows: readonly NavRow[], index: number, key: string): NavAction {
  const row = rows[index];
  if (!row) return none;
  const focus = (target: NavRow | undefined): NavAction =>
    target ? { type: "focus", key: target.key } : none;
  switch (key) {
    case "ArrowDown":
      return focus(rows[index + 1]);
    case "ArrowUp":
      return focus(rows[index - 1]);
    case "Home":
      return focus(rows[0]);
    case "End":
      return focus(rows[rows.length - 1]);
    case "ArrowRight": {
      if (!isExpandableRow(row)) return none;
      if (!row.expanded) return { type: "expand", key: row.key };
      const next = rows[index + 1];
      return next?.parentKey === row.key ? focus(next) : none;
    }
    case "ArrowLeft": {
      if (isExpandableRow(row) && row.expanded) return { type: "collapse", key: row.key };
      return row.parentKey
        ? focus(rows.find((candidate) => candidate.key === row.parentKey))
        : none;
    }
    case "Enter":
    case " ":
      return { type: "activate", key: row.key };
    default:
      return none;
  }
}

/** The row to keep as the tab stop: the remembered one while it exists, else the first. */
export function rovingKey(rows: readonly NavRow[], remembered: string | null): string | null {
  if (remembered !== null && rows.some((row) => row.key === remembered)) return remembered;
  return rows[0]?.key ?? null;
}

// ---------------------------------------------------------------------------
// Windowing

/** The rows a scroll position shows: indexes of the first and the one after the last. */
export interface RowViewport {
  first: number;
  end: number;
}

/**
 * Rows between `top` and `top + height` pixels of a list of `count` rows. `top` may be negative
 * (the list starts below the visible area) and the answer is always inside the list.
 */
export function viewportRows(top: number, height: number, count: number): RowViewport {
  const first = Math.min(count, Math.max(0, Math.floor(top / navRowHeight)));
  const end = Math.min(count, Math.max(first, Math.ceil((top + height) / navRowHeight)));
  return { first, end };
}

/** A line of a row's name that wraps (the open row and its ancestors). */
export const navLineHeight = 20;
/** Rows drawn beyond the ones in view, so a fast scroll does not show blanks. */
export const navOverscan = 10;
/** The most rows that can wrap at once: the open row and its ancestors (the tree is 7 deep). */
export const navMaxWrapped = 9;

/**
 * The rows that must show their whole name: the open topic and every ancestor of it in the list
 * (the nearest earlier row of each lower level), never cut by a width (design record 5.3). A row
 * that is not a topic cannot be open, so a list without the open topic has none.
 */
export function openPathKeys(
  rows: readonly NavRow[],
  selectedTopicId: string | null
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (selectedTopicId === null) return keys;
  rows.forEach((row, index) => {
    const open =
      (row.type === "topic" && row.node.id === selectedTopicId) ||
      (row.type === "place" && row.place.kind === "topic" && row.place.id === selectedTopicId);
    if (!open) return;
    keys.add(row.key);
    let level = row.level;
    for (let at = index - 1; at >= 0 && level > 1; at -= 1) {
      const earlier = rows[at]!;
      if (earlier.level < level) {
        keys.add(earlier.key);
        level = earlier.level;
      }
    }
  });
  return keys;
}

/**
 * Where each row of a windowed list sits, and the list's height: a row is `navRowHeight` tall plus
 * one `navLineHeight` for every extra line its name wraps to (`lines` is the line count of the rows
 * that wrap; any other row has one). The window still counts rows by `navRowHeight`, which puts a
 * row at most `navMaxWrapped * navLineHeight` px early, and the overscan covers that.
 */
export function rowTops(
  rows: readonly NavRow[],
  lines: (row: NavRow) => number
): { tops: number[]; height: number } {
  const tops: number[] = [];
  let top = 0;
  for (const row of rows) {
    tops.push(top);
    top += navRowHeight + (Math.max(1, lines(row)) - 1) * navLineHeight;
  }
  return { tops, height: top };
}

/**
 * The row indexes to render: the viewport with an overscan on both sides, and the rows that must
 * exist whatever the scroll (the one holding focus, so the tab stop never disappears).
 */
export function windowIndexes(
  count: number,
  viewport: RowViewport,
  overscan: number,
  forced: readonly number[] = []
): number[] {
  const indexes = new Set<number>();
  const from = Math.max(0, viewport.first - overscan);
  const to = Math.min(count, viewport.end + overscan);
  for (let index = from; index < to; index += 1) indexes.add(index);
  for (const index of forced) if (index >= 0 && index < count) indexes.add(index);
  return [...indexes].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Pushed changes

/** Changes pushed while they could not be applied yet, merged. */
export interface PendingChange {
  /** The change was too broad to list (or a read failed): treat every branch as touched. */
  all: boolean;
  ids: ReadonlySet<string>;
}
export const noChange: PendingChange = { all: false, ids: new Set() };

export function mergeChange(pending: PendingChange, event: Pick<TopicsChangedEvent, "topicIds">) {
  if (pending.all) return pending;
  if (event.topicIds === null) return { all: true, ids: new Set<string>() };
  if (event.topicIds.length === 0) return pending;
  return { all: false, ids: new Set([...pending.ids, ...event.topicIds]) };
}
export const hasChange = (change: PendingChange) => change.all || change.ids.size > 0;
export const touches = (change: PendingChange, id: string) => change.all || change.ids.has(id);

/** Branches whose own topic, or one of whose listed children, a change touched. */
export function touchedBranches(
  branches: ReadonlyMap<string, Branch>,
  change: PendingChange
): string[] {
  const keys: string[] = [];
  for (const [key, branch] of branches) {
    const data = branch.data;
    if (!data) continue;
    if (touches(change, data.parent.id) || data.nodes.some((node) => touches(change, node.id))) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Branches whose rows are on screen: the root's, and the branch of every open topic whose own row
 * is shown. Only these are read again on a change; the others are dropped and read when opened.
 */
export function visibleBranchKeys(
  branches: ReadonlyMap<string, Branch>,
  expanded: ReadonlySet<string>
): Set<string> {
  const visible = new Set<string>();
  const walk = (key: string) => {
    const data = branches.get(key)?.data;
    if (!data) return;
    visible.add(key);
    for (const node of data.nodes)
      if (expanded.has(node.id) && topicExpandable(node)) walk(node.id);
  };
  walk(rootBranchKey);
  return visible;
}

/** Open topics that are on screen but whose branch was never read (or was dropped). */
export function unreadOpenTopics(
  branches: ReadonlyMap<string, Branch>,
  expanded: ReadonlySet<string>
): string[] {
  const missing: string[] = [];
  const walk = (key: string) => {
    const data = branches.get(key)?.data;
    if (!data) return;
    for (const node of data.nodes) {
      if (!expanded.has(node.id) || !topicExpandable(node)) continue;
      if (!branches.has(node.id)) missing.push(node.id);
      else walk(node.id);
    }
  };
  walk(rootBranchKey);
  return missing;
}

/** The topics to open so that the last entry of `path` shows: its ancestors, root excluded. */
export function ancestorsToOpen(path: readonly TopicPathEntry[], rootId: string | null): string[] {
  return path
    .slice(0, -1)
    .map((entry) => entry.id)
    .filter((id) => id !== rootId);
}

/** A failure the read side reports for a cursor that no longer matches (reload from the start). */
export const isStaleCursor = (error: unknown) => String(error).includes("topics.errors.stale");
