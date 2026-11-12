import { describe, expect, it } from "vitest";
import {
  appendNodes,
  ancestorsToOpen,
  branchDataFromTree,
  emptyBranch,
  isExpandableRow,
  mergeChange,
  navigationAction,
  navLineHeight,
  navMaxWrapped,
  navOverscan,
  navRowHeight,
  noChange,
  openPathKeys,
  placeRows,
  rootBranchKey,
  rootState,
  rovingKey,
  rowTops,
  topicRows,
  touchedBranches,
  unreadOpenTopics,
  unsortedKey,
  unsortedRows,
  viewportRows,
  visibleBranchKeys,
  windowIndexes,
  withItemsPage,
  type Branch,
  type NavRow,
  type PlaceEntry
} from "./topic-navigation";
import { id, nodeSummary, noteLeaf, sourceLeaf } from "./topic-fixtures";

const root = nodeSummary({
  id: id(1),
  title: null,
  items: 40,
  directItems: 3,
  unsorted: 3,
  children: 2
});
const areaA = nodeSummary({
  id: id(2),
  parentId: id(1),
  title: "Memory",
  items: 30,
  directItems: 2,
  children: 2
});
const areaB = nodeSummary({ id: id(3), parentId: id(1), title: "Literature", items: 7 });
const sub = nodeSummary({ id: id(4), parentId: id(2), title: "Decay", items: 9, directItems: 9 });
const leafless = nodeSummary({ id: id(5), parentId: id(2), title: "Empty", items: 0 });

const branch = (
  parent: typeof root,
  nodes: readonly (typeof root)[],
  extra: Partial<Parameters<typeof branchDataFromTree>[0]> = {}
): Branch =>
  emptyBranch(
    "ready",
    branchDataFromTree({
      generation: 1,
      parent,
      nodes: [...nodes],
      items: [],
      moreItems: 0,
      unsorted: parent.unsorted,
      nextCursor: null,
      ...extra
    })
  );

const branches = (entries: Array<[string, Branch]>) => new Map(entries);

describe("the topic rows", () => {
  const loaded = branches([
    [rootBranchKey, branch(root, [areaA, areaB])],
    [
      areaA.id,
      branch(areaA, [sub, leafless], {
        items: [noteLeaf(1), sourceLeaf(2, { unsorted: true })],
        moreItems: 4,
        nextCursor: "next"
      })
    ]
  ]);

  it("lists the areas first and nothing below them while they are closed", () => {
    const rows = topicRows(loaded, new Set());
    expect(rows.map((row) => row.key)).toEqual([`t:${areaA.id}`, `t:${areaB.id}`]);
    expect(rows.every((row) => row.level === 1 && row.parentKey === null)).toBe(true);
    expect(rows.map((row) => [row.posInSet, row.setSize])).toEqual([
      [1, 2],
      [2, 2]
    ]);
    const first = rows[0]!;
    expect(first.type === "topic" && first.expandable).toBe(true);
    // A topic with no subtopics and no leaves has nothing to open.
    expect(
      isExpandableRow(topicRows(branches([[rootBranchKey, branch(root, [areaB])]]), new Set())[0]!)
    ).toBe(false);
  });

  it("lists an open topic's subtopics, then a row for more of them, then its leaves and the rest", () => {
    const rows = topicRows(loaded, new Set([areaA.id]));
    expect(rows.map((row) => row.type)).toEqual([
      "topic",
      "topic",
      "topic",
      "more",
      "leaf",
      "leaf",
      "more",
      "topic"
    ]);
    const inside = rows.slice(1, 7);
    expect(inside.every((row) => row.level === 2 && row.parentKey === `t:${areaA.id}`)).toBe(true);
    expect(inside.map((row) => [row.posInSet, row.setSize])).toEqual([
      [1, 6],
      [2, 6],
      [3, 6],
      [4, 6],
      [5, 6],
      [6, 6]
    ]);
    const more = rows[6] as Extract<NavRow, { type: "more" }>;
    expect(more).toMatchObject({ what: "items", remaining: 4, parentId: areaA.id });
    // The leaf that waits at an internal topic is marked; the other is not.
    expect(
      rows.filter((row) => row.type === "leaf").map((row) => row.type === "leaf" && row.waiting)
    ).toEqual([false, true]);
  });

  it("shows a loading row while a branch is read and a retry row when it failed", () => {
    const loading = branches([
      [rootBranchKey, branch(root, [areaA])],
      [areaA.id, emptyBranch("loading")]
    ]);
    expect(topicRows(loading, new Set([areaA.id])).map((row) => row.type)).toEqual([
      "topic",
      "status"
    ]);
    const failed = branches([
      [rootBranchKey, branch(root, [areaA])],
      [areaA.id, emptyBranch("error")]
    ]);
    const rows = topicRows(failed, new Set([areaA.id]));
    expect(rows[1]).toMatchObject({ type: "status", state: "error", parentId: areaA.id, level: 2 });
    // An open topic whose branch is not even requested yet reads as loading.
    const unread = branches([[rootBranchKey, branch(root, [areaA])]]);
    expect(topicRows(unread, new Set([areaA.id]))[1]).toMatchObject({
      type: "status",
      state: "loading"
    });
  });

  it("keeps the rows of a branch whose refresh is running", () => {
    const refreshing = branches([
      [rootBranchKey, emptyBranch("loading", branch(root, [areaA, areaB]).data)]
    ]);
    expect(topicRows(refreshing, new Set())).toHaveLength(2);
    expect(topicRows(new Map(), new Set())).toEqual([]);
  });

  it("gives every leaf of one parent a distinct key, even a note that also appears there", () => {
    const both = branches([
      [rootBranchKey, branch(root, [areaA])],
      [
        areaA.id,
        branch(areaA, [], {
          items: [noteLeaf(1), noteLeaf(1, { role: "secondary" })]
        })
      ]
    ]);
    const keys = topicRows(both, new Set([areaA.id])).map((row) => row.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the Unsorted group", () => {
  const data = branches([
    [rootBranchKey, branch(root, [areaA], { items: [sourceLeaf(1), noteLeaf(2)], moreItems: 1 })]
  ]);

  it("shows one row with the count of the root's own items", () => {
    expect(unsortedRows(data, new Set())).toMatchObject([
      { type: "unsorted", key: unsortedKey, count: 3, expanded: false, level: 1 }
    ]);
  });

  it("lists the leaves and a row for the rest when it is open", () => {
    const rows = unsortedRows(data, new Set([unsortedKey]));
    expect(rows.map((row) => row.type)).toEqual(["unsorted", "leaf", "leaf", "more"]);
    expect(rows.slice(1).every((row) => row.level === 2 && row.parentKey === unsortedKey)).toBe(
      true
    );
    expect(rows.slice(1).map((row) => [row.posInSet, row.setSize])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3]
    ]);
    // Everything in the group waits, so no leaf carries the marker.
    expect(
      rows.filter((row) => row.type === "leaf").some((row) => row.type === "leaf" && row.waiting)
    ).toBe(false);
  });

  it("is absent when nothing waits at the root", () => {
    const none = branches([[rootBranchKey, branch({ ...root, unsorted: 0 }, [areaA])]]);
    expect(unsortedRows(none, new Set())).toEqual([]);
    expect(unsortedRows(new Map(), new Set())).toEqual([]);
  });
});

describe("the places", () => {
  const place = (n: number): PlaceEntry => ({
    address: `memora://note/${id(n)}`,
    kind: "note",
    id: id(n),
    title: `Note ${n}`,
    pinned: false,
    count: null,
    health: null,
    management: null,
    source: { sourceItemId: id(100 + n) }
  });

  it("numbers a flat list of entries", () => {
    const rows = placeRows([place(1), place(2)], "recents");
    expect(rows.map((row) => [row.level, row.posInSet, row.setSize, row.parentKey])).toEqual([
      [1, 1, 2, null],
      [1, 2, 2, null]
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(placeRows([], "pinned")).toEqual([]);
  });
});

describe("keys", () => {
  const rows = topicRows(
    branches([
      [rootBranchKey, branch(root, [areaA, areaB])],
      [areaA.id, branch(areaA, [sub], { items: [noteLeaf(1)] })]
    ]),
    new Set([areaA.id])
  );
  // Memory (open), Decay, Note 1, Literature (leaf-less)
  const at = (key: string, index: number) => navigationAction(rows, index, key);

  it("moves with the arrows, Home and End and stops at the ends", () => {
    expect(at("ArrowDown", 0)).toEqual({ type: "focus", key: rows[1]!.key });
    expect(at("ArrowUp", 1)).toEqual({ type: "focus", key: rows[0]!.key });
    expect(at("ArrowUp", 0)).toEqual({ type: "none" });
    expect(at("ArrowDown", rows.length - 1)).toEqual({ type: "none" });
    expect(at("Home", 2)).toEqual({ type: "focus", key: rows[0]!.key });
    expect(at("End", 0)).toEqual({ type: "focus", key: rows.at(-1)!.key });
  });

  it("opens a closed branch with Right, enters an open one, and does nothing on a leaf", () => {
    const closed = topicRows(branches([[rootBranchKey, branch(root, [areaA, areaB])]]), new Set());
    expect(navigationAction(closed, 0, "ArrowRight")).toEqual({
      type: "expand",
      key: closed[0]!.key
    });
    expect(at("ArrowRight", 0)).toEqual({ type: "focus", key: rows[1]!.key });
    expect(at("ArrowRight", 2)).toEqual({ type: "none" });
    expect(at("ArrowRight", 3)).toEqual({ type: "none" });
  });

  it("closes an open branch with Left and goes to the parent from anything else", () => {
    expect(at("ArrowLeft", 0)).toEqual({ type: "collapse", key: rows[0]!.key });
    expect(at("ArrowLeft", 2)).toEqual({ type: "focus", key: rows[0]!.key });
    expect(at("ArrowLeft", 3)).toEqual({ type: "none" });
  });

  it("opens the row's object with Enter and Space, and ignores other keys", () => {
    expect(at("Enter", 1)).toEqual({ type: "activate", key: rows[1]!.key });
    expect(at(" ", 2)).toEqual({ type: "activate", key: rows[2]!.key });
    expect(at("a", 1)).toEqual({ type: "none" });
    expect(at("Tab", 1)).toEqual({ type: "none" });
    expect(navigationAction(rows, 99, "ArrowDown")).toEqual({ type: "none" });
  });

  it("keeps one tab stop: the remembered row while it exists, else the first", () => {
    expect(rovingKey(rows, rows[2]!.key)).toBe(rows[2]!.key);
    expect(rovingKey(rows, "t:gone")).toBe(rows[0]!.key);
    expect(rovingKey(rows, null)).toBe(rows[0]!.key);
    expect(rovingKey([], "x")).toBeNull();
  });
});

describe("windowing", () => {
  it("finds the rows between two pixel positions, clamped to the list", () => {
    expect(viewportRows(0, 280, 1000)).toEqual({ first: 0, end: 10 });
    expect(viewportRows(56, 84, 1000)).toEqual({ first: 2, end: 5 });
    // The list starts below the top of the visible area.
    expect(viewportRows(-200, 400, 1000)).toEqual({ first: 0, end: 8 });
    expect(viewportRows(-500, 400, 1000)).toEqual({ first: 0, end: 0 });
    expect(viewportRows(10_000_000, 400, 100)).toEqual({ first: 100, end: 100 });
    expect(viewportRows(0, 280, 4)).toEqual({ first: 0, end: 4 });
    expect(navRowHeight).toBe(28);
  });

  it("draws the viewport with an overscan and the rows that must exist", () => {
    expect(windowIndexes(100, { first: 20, end: 30 }, 5)).toEqual(
      Array.from({ length: 20 }, (_, n) => 15 + n)
    );
    expect(windowIndexes(100, { first: 0, end: 3 }, 2)).toEqual([0, 1, 2, 3, 4]);
    expect(windowIndexes(100, { first: 98, end: 100 }, 3)).toEqual([95, 96, 97, 98, 99]);
    // The focused row far away is still drawn; one that is not in the list is not.
    expect(windowIndexes(100, { first: 0, end: 2 }, 0, [60, -1, 100])).toEqual([0, 1, 60]);
    expect(windowIndexes(0, { first: 0, end: 0 }, 5)).toEqual([]);
  });

  it("draws a bounded number of rows for a very long list", () => {
    const view = viewportRows(14_000, 700, 5_000);
    expect(windowIndexes(5_000, view, 10, [0]).length).toBeLessThanOrEqual(26 + 20 + 1);
  });
});

describe("the open row and its ancestors", () => {
  const open = branches([
    [rootBranchKey, branch(root, [areaA, areaB])],
    [areaA.id, branch(areaA, [sub, leafless], { items: [noteLeaf(1)] })]
  ]);
  const rows = topicRows(open, new Set([areaA.id]));

  it("are the rows that show their whole name: the open topic and each ancestor above it", () => {
    expect([...openPathKeys(rows, sub.id)]).toEqual([`t:${sub.id}`, `t:${areaA.id}`]);
    expect([...openPathKeys(rows, areaB.id)]).toEqual([`t:${areaB.id}`]);
    expect(openPathKeys(rows, null).size).toBe(0);
    expect(openPathKeys(rows, id(99)).size).toBe(0);
  });

  it("make their rows taller by a line each, and the rows below follow", () => {
    const wrapped = new Set([`t:${areaA.id}`]);
    const plain = rowTops(rows, () => 1);
    expect(plain.tops).toEqual(rows.map((_, index) => index * navRowHeight));
    const placed = rowTops(rows, (row) => (wrapped.has(row.key) ? 2 : 1));
    expect(placed.tops[0]).toBe(0);
    expect(placed.tops[1]).toBe(navRowHeight + navLineHeight);
    expect(placed.height).toBe(plain.height + navLineHeight);
    // A row never has fewer than one line.
    expect(rowTops(rows, () => 0).height).toBe(plain.height);
  });

  it("are taller by less than the overscan, so the window still draws every row in view", () => {
    expect(navMaxWrapped * navLineHeight).toBeLessThanOrEqual(navOverscan * navRowHeight);
  });
});

describe("pushed changes", () => {
  it("merges what was pushed, and a broad change absorbs the rest", () => {
    let pending = mergeChange(noChange, { topicIds: [id(1)] });
    pending = mergeChange(pending, { topicIds: [id(2)] });
    expect([...pending.ids]).toEqual([id(1), id(2)]);
    expect(mergeChange(pending, { topicIds: [] })).toBe(pending);
    const broad = mergeChange(pending, { topicIds: null });
    expect(broad.all).toBe(true);
    expect(mergeChange(broad, { topicIds: [id(3)] })).toBe(broad);
    expect(noChange.ids.size).toBe(0);
  });

  const tree = branches([
    [rootBranchKey, branch(root, [areaA, areaB])],
    [areaA.id, branch(areaA, [sub])],
    [areaB.id, branch(areaB, [])]
  ]);

  it("touches the branches that show a changed topic as their parent or as a child", () => {
    expect(touchedBranches(tree, { all: false, ids: new Set([sub.id]) })).toEqual([areaA.id]);
    expect(touchedBranches(tree, { all: false, ids: new Set([areaA.id]) }).sort()).toEqual(
      [rootBranchKey, areaA.id].sort()
    );
    expect(touchedBranches(tree, { all: false, ids: new Set([id(99)]) })).toEqual([]);
    expect(touchedBranches(tree, { all: true, ids: new Set() })).toHaveLength(3);
    // A branch that has no answer yet has nothing to compare.
    expect(
      touchedBranches(branches([[areaA.id, emptyBranch("loading")]]), { all: true, ids: new Set() })
    ).toEqual([]);
  });

  it("knows which branches are on screen: the root's and those of open topics that are shown", () => {
    expect([...visibleBranchKeys(tree, new Set())]).toEqual([rootBranchKey]);
    expect([...visibleBranchKeys(tree, new Set([areaA.id]))].sort()).toEqual(
      [rootBranchKey, areaA.id].sort()
    );
    // An open topic under a closed one is not on screen.
    expect([...visibleBranchKeys(tree, new Set([sub.id]))]).toEqual([rootBranchKey]);
  });

  it("finds the open, shown topics whose branch was never read", () => {
    expect(unreadOpenTopics(tree, new Set([areaA.id, sub.id]))).toEqual([sub.id]);
    expect(unreadOpenTopics(tree, new Set([sub.id]))).toEqual([]);
    expect(unreadOpenTopics(tree, new Set())).toEqual([]);
    expect(unreadOpenTopics(new Map(), new Set([areaA.id]))).toEqual([]);
  });
});

describe("paging", () => {
  const first = branchDataFromTree({
    generation: 2,
    parent: root,
    nodes: [areaA],
    items: [noteLeaf(1), noteLeaf(2)],
    moreItems: 3,
    unsorted: 0,
    nextCursor: "c1"
  });

  it("appends a page of subtopics once, whatever the page repeats", () => {
    const next = appendNodes(first, {
      generation: 3,
      parent: root,
      nodes: [areaA, areaB],
      items: [],
      moreItems: 0,
      unsorted: 0,
      nextCursor: null
    });
    expect(next.nodes.map((node) => node.id)).toEqual([areaA.id, areaB.id]);
    expect(next.nextCursor).toBeNull();
    expect(next.generation).toBe(3);
  });

  it("replaces the leaves with the first page, which repeats them, and appends the later ones", () => {
    const page = (ids: number[], nextCursor: string | null) => ({
      items: ids.map((n) => noteLeaf(n)),
      nextCursor
    });
    const one = withItemsPage(first, page([1, 2, 3], "c2"), true);
    expect(one.items.map((leaf) => leaf.title)).toEqual(["Note 1", "Note 2", "Note 3"]);
    // Five leaves were announced in all; two are left, and a cursor is kept.
    expect(one.moreItems).toBe(2);
    expect(one.itemsCursor).toBe("c2");
    const two = withItemsPage(one, page([3, 4, 5], null), false);
    expect(two.items).toHaveLength(5);
    expect(two.moreItems).toBe(0);
    expect(two.itemsCursor).toBeNull();
    // A cursor that is still set always leaves at least one to ask for.
    expect(withItemsPage(first, page([1, 2, 3, 4, 5, 6], "c9"), true).moreItems).toBe(1);
  });
});

describe("reaching a topic", () => {
  it("lists the topics to open: the ancestors without the root and without the topic itself", () => {
    const path = [id(1), id(2), id(4)].map((entry) => ({ id: entry, title: null }));
    expect(ancestorsToOpen(path, id(1))).toEqual([id(2)]);
    expect(ancestorsToOpen(path, null)).toEqual([id(1), id(2)]);
    expect(ancestorsToOpen(path.slice(0, 1), id(1))).toEqual([]);
    expect(ancestorsToOpen([], id(1))).toEqual([]);
  });

  it("reads the state of the root branch", () => {
    expect(rootState(undefined)).toBe("loading");
    expect(rootState(emptyBranch("loading"))).toBe("loading");
    expect(rootState(emptyBranch("error"))).toBe("error");
    expect(rootState(emptyBranch("ready"))).toBe("preparing");
    expect(rootState(branch({ ...root, items: 0, unsorted: 0 }, []))).toBe("empty");
    expect(rootState(branch({ ...root, items: 3 }, []))).toBe("tree");
    expect(rootState(branch(root, [areaA]))).toBe("tree");
    // A failed reload keeps showing the tree it had.
    expect(rootState({ ...branch(root, [areaA]), phase: "error" })).toBe("tree");
  });
});
