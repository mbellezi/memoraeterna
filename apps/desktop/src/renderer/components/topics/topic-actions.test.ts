import { describe, expect, it, vi } from "vitest";
import type { ObjectLocateResult } from "@app/domain";
import { activateRow, owningSourceOf, toggleRow, type RowActionDeps } from "./topic-actions";
import {
  placeRows,
  topicRows,
  unsortedRows,
  emptyBranch,
  branchDataFromTree,
  rootBranchKey,
  unsortedKey,
  type NavRow
} from "./topic-navigation";
import { id, nodeSummary, noteLeaf, sourceLeaf } from "./topic-fixtures";

const parent = nodeSummary({ id: id(1), title: null, items: 5, unsorted: 2, children: 1 });
const area = nodeSummary({ id: id(2), parentId: id(1), title: "Memory", items: 3, directItems: 3 });
const data = (items = [noteLeaf(1), sourceLeaf(2)], moreItems = 0) =>
  emptyBranch(
    "ready",
    branchDataFromTree({
      generation: 1,
      parent,
      nodes: [area],
      items,
      moreItems,
      unsorted: 2,
      nextCursor: null
    })
  );

const deps = (expanded: string[] = []) => {
  const calls = {
    expand: vi.fn(),
    toggle: vi.fn(),
    loadMoreTopics: vi.fn(),
    loadMoreItems: vi.fn(),
    retryBranch: vi.fn(),
    onOpenTopic: vi.fn(),
    onOpenSource: vi.fn(),
    openNote: vi.fn(),
    startExpand: vi.fn(),
    clearOpenFailure: vi.fn()
  };
  const value: RowActionDeps = {
    store: {
      expand: calls.expand,
      toggle: calls.toggle,
      loadMoreTopics: calls.loadMoreTopics,
      loadMoreItems: calls.loadMoreItems,
      retryBranch: calls.retryBranch
    },
    expanded: new Set(expanded),
    onOpenTopic: calls.onOpenTopic,
    onOpenSource: calls.onOpenSource,
    openNote: calls.openNote,
    startExpand: calls.startExpand,
    clearOpenFailure: calls.clearOpenFailure
  };
  return { value, calls };
};

const branches = new Map([[rootBranchKey, data([noteLeaf(1), sourceLeaf(2)], 3)]]);
const topic = topicRows(branches, new Set())[0]!;
const leaves = unsortedRows(branches, new Set([unsortedKey]));

describe("opening a topic row", () => {
  it("opens the topic and its branch, and starts the measurement of the expansion", () => {
    const { value, calls } = deps();
    activateRow(topic, value);
    expect(calls.startExpand).toHaveBeenCalledWith(area.id);
    expect(calls.expand).toHaveBeenCalledWith(area.id);
    expect(calls.onOpenTopic).toHaveBeenCalledWith(area.id);
  });

  it("does not measure or reopen a branch that is already open, but still opens the topic", () => {
    const { value, calls } = deps([area.id]);
    activateRow(topic, value);
    expect(calls.startExpand).not.toHaveBeenCalled();
    expect(calls.onOpenTopic).toHaveBeenCalledWith(area.id);
  });
});

describe("the chevron and the arrow keys", () => {
  it("toggle a topic's branch, measuring only when it opens", () => {
    const closed = deps();
    toggleRow(topic, closed.value);
    expect(closed.calls.startExpand).toHaveBeenCalledWith(area.id);
    expect(closed.calls.toggle).toHaveBeenCalledWith(area.id);
    const open = deps([area.id]);
    toggleRow(topic, open.value);
    expect(open.calls.startExpand).not.toHaveBeenCalled();
    expect(open.calls.toggle).toHaveBeenCalledWith(area.id);
  });

  it("toggle the Unsorted group without measuring, and do nothing on a row that has no branch", () => {
    const { value, calls } = deps();
    const unsorted = unsortedRows(branches, new Set())[0]!;
    toggleRow(unsorted, value);
    expect(calls.toggle).toHaveBeenCalledWith(unsortedKey);
    expect(calls.startExpand).not.toHaveBeenCalled();
    activateRow(unsorted, value);
    expect(calls.toggle).toHaveBeenCalledTimes(2);
    const leaf = leaves.find((row) => row.type === "leaf")!;
    toggleRow(leaf, value);
    expect(calls.toggle).toHaveBeenCalledTimes(2);
  });
});

describe("opening a leaf", () => {
  it("opens a source in the Library", () => {
    const { value, calls } = deps();
    const source = leaves.find((row) => row.type === "leaf" && row.leaf.kind === "source")!;
    activateRow(source, value);
    expect(calls.clearOpenFailure).toHaveBeenCalled();
    expect(calls.onOpenSource).toHaveBeenCalledWith(id(6002));
  });

  it("finds the source of a note before opening it", () => {
    const { value, calls } = deps();
    const note = leaves.find((row) => row.type === "leaf" && row.leaf.kind === "note")!;
    activateRow(note, value);
    expect(calls.openNote).toHaveBeenCalledWith(id(5001));
    expect(calls.onOpenSource).not.toHaveBeenCalled();
  });
});

describe("opening a pinned or recent entry", () => {
  const place = (overrides: Partial<Parameters<typeof placeRows>[0][number]>): NavRow =>
    placeRows(
      [
        {
          address: `memora://source/${id(7)}`,
          kind: "source",
          id: id(7),
          title: "A source",
          pinned: false,
          count: null,
          health: null,
          management: null,
          source: { sourceItemId: id(7) },
          ...overrides
        }
      ],
      "recents"
    )[0]!;

  it("opens a topic in the Wiki, and a note or source in the Library", () => {
    const { value, calls } = deps();
    activateRow(place({ kind: "topic", id: id(9), source: null }), value);
    expect(calls.onOpenTopic).toHaveBeenCalledWith(id(9));
    activateRow(place({}), value);
    expect(calls.onOpenSource).toHaveBeenCalledWith(id(7), undefined);
    activateRow(
      place({ kind: "note", id: id(8), source: { sourceItemId: id(7), atomicNoteId: id(8) } }),
      value
    );
    expect(calls.onOpenSource).toHaveBeenLastCalledWith(id(7), id(8));
    // An entry the Library cannot open does nothing.
    const none = deps();
    activateRow(place({ source: null }), none.value);
    expect(none.calls.onOpenSource).not.toHaveBeenCalled();
  });
});

describe("the rows that continue or retry", () => {
  const rows = topicRows(
    new Map([
      [rootBranchKey, data()],
      [area.id, emptyBranch("error")]
    ]),
    new Set([area.id])
  );

  it("read more subtopics or more leaves", () => {
    const { value, calls } = deps();
    const more = (what: "topics" | "items", parentId: string | null): NavRow => ({
      type: "more",
      key: `m:${what}`,
      level: 1,
      parentKey: null,
      posInSet: 1,
      setSize: 1,
      what,
      parentId,
      remaining: 3,
      state: "idle"
    });
    activateRow(more("topics", area.id), value);
    expect(calls.loadMoreTopics).toHaveBeenCalledWith(area.id);
    activateRow(more("items", null), value);
    expect(calls.loadMoreItems).toHaveBeenCalledWith(null);
  });

  it("read a failed branch again, and leave a loading one alone", () => {
    const { value, calls } = deps([area.id]);
    const failed = rows.find((row) => row.type === "status")!;
    activateRow(failed, value);
    expect(calls.retryBranch).toHaveBeenCalledWith(area.id);
    activateRow({ ...(failed as Extract<NavRow, { type: "status" }>), state: "loading" }, value);
    expect(calls.retryBranch).toHaveBeenCalledTimes(1);
  });
});

describe("the source a note opens in", () => {
  const located = (path: ObjectLocateResult["primaryPath"], kind = "note" as const) =>
    ({
      object: { kind, id: id(5), title: "n" },
      primaryPath: path,
      alsoIn: [],
      citedBy: [],
      counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
    }) as ObjectLocateResult;

  it("is the innermost source of its path", () => {
    expect(
      owningSourceOf(
        located([
          { kind: "source", id: id(10), title: "Book" },
          { kind: "source", id: id(11), title: "Chapter" },
          { kind: "note", id: id(5), title: "n" }
        ])
      )
    ).toBe(id(11));
  });

  it("is nothing for a note outside any source, or for an object that is not a note", () => {
    expect(owningSourceOf(located([{ kind: "note", id: id(5), title: "n" }]))).toBeNull();
    expect(owningSourceOf(null)).toBeNull();
    expect(owningSourceOf(located([{ kind: "source", id: id(10), title: "Book" }], "note"))).toBe(
      id(10)
    );
  });
});
