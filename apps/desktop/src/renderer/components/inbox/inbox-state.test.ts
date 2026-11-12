import { describe, expect, it } from "vitest";

import { inboxItemKey, inboxKinds, type InboxItem } from "@app/domain";

import { countsOf, item, uuid } from "./inbox-fixtures";
import {
  initialInboxState,
  keyCarries,
  keyOf,
  mergeItems,
  offers,
  reduceInbox,
  selectedItem,
  selectionAfterReload,
  selectionAfterRemoval,
  type InboxEvent,
  type InboxState
} from "./inbox-state";

const duplicates = (n: number): InboxItem[] =>
  Array.from({ length: n }, (_, index) => item("duplicate", { id: uuid(100 + index) }));

const run = (state: InboxState, ...events: InboxEvent[]): InboxState =>
  events.reduce(reduceInbox, state);

const loaded = (items: InboxItem[], nextCursor: string | null = null): InboxState =>
  reduceInbox(initialInboxState(), { type: "loaded", items, nextCursor, at: 1_000 });

describe("loading the Inbox", () => {
  it("starts loading, then shows the items with the first one selected", () => {
    expect(initialInboxState().load).toEqual({ status: "loading" });
    const state = loaded(duplicates(3));
    expect(state.load).toEqual({ status: "ready" });
    expect(state.items).toHaveLength(3);
    expect(state.selectedKey).toBe(keyOf(state.items[0]!));
    // Ages are measured to the moment the page was read, not to the moment of a render.
    expect(state.readAt).toBe(1_000);
  });

  it("shows an empty Inbox with nothing selected", () => {
    const state = loaded([]);
    expect(state.load).toEqual({ status: "ready" });
    expect(state.selectedKey).toBeNull();
    expect(selectedItem(state)).toBeNull();
  });

  it("reports a failed load and a failed page apart", () => {
    expect(run(initialInboxState(), { type: "loadFailed" }).load).toEqual({ status: "error" });
    const state = run(
      loaded(duplicates(2), "next"),
      { type: "moreLoading" },
      { type: "moreFailed" }
    );
    expect(state).toMatchObject({
      loadingMore: false,
      moreFailed: true,
      load: { status: "ready" }
    });
    expect(run(state, { type: "moreLoading" }).moreFailed).toBe(false);
  });

  it("keeps the selection on its item when the list is read again", () => {
    const items = duplicates(4);
    const state = run(loaded(items), { type: "select", key: keyOf(items[2]!) });
    const again = run(state, {
      type: "loaded",
      items: [items[0]!, items[2]!, items[3]!],
      nextCursor: null,
      at: 2_000
    });
    expect(again.selectedKey).toBe(keyOf(items[2]!));
  });

  it("moves the selection to the item that took its place when it left", () => {
    const items = duplicates(4);
    const state = run(loaded(items), { type: "select", key: keyOf(items[2]!) });
    expect(
      run(state, {
        type: "loaded",
        items: [items[0]!, items[1]!, items[3]!],
        nextCursor: null,
        at: 2_000
      }).selectedKey
    ).toBe(keyOf(items[3]!));
    expect(selectionAfterReload(items, [items[0]!], keyOf(items[3]!))).toBe(keyOf(items[0]!));
    expect(selectionAfterReload(items, [], keyOf(items[3]!))).toBeNull();
  });

  it("appends a page without listing an item twice", () => {
    const items = duplicates(4);
    const state = run(loaded(items.slice(0, 2), "c1"), {
      type: "moreLoaded",
      items: items.slice(1),
      nextCursor: null
    });
    expect(state.items.map(keyOf)).toEqual(items.map(keyOf));
    expect(state.nextCursor).toBeNull();
    expect(mergeItems(items, items)).toHaveLength(4);
  });

  it("holds the counts apart from the items", () => {
    const items = [item("review"), item("duplicate")];
    const state = run(loaded(items), { type: "counts", counts: countsOf(items) });
    expect(state.counts?.total).toBe(2);
    expect(state.counts?.byKind.review).toBe(1);
  });
});

describe("moving through the list", () => {
  const items = duplicates(3);
  const start = loaded(items);

  it("moves one item at a time and stops at the ends", () => {
    const down = run(start, { type: "move", delta: 1 });
    expect(down.selectedKey).toBe(keyOf(items[1]!));
    expect(run(down, { type: "move", delta: 1 }, { type: "move", delta: 1 }).selectedKey).toBe(
      keyOf(items[2]!)
    );
    expect(run(start, { type: "move", delta: -1 }).selectedKey).toBe(keyOf(items[0]!));
  });

  it("jumps to the first and the last", () => {
    expect(run(start, { type: "edge", to: "last" }).selectedKey).toBe(keyOf(items[2]!));
    expect(
      run(start, { type: "edge", to: "last" }, { type: "edge", to: "first" }).selectedKey
    ).toBe(keyOf(items[0]!));
  });

  it("selects only an item that is listed", () => {
    expect(run(start, { type: "select", key: "duplicate:nope" })).toBe(start);
    expect(run(initialInboxState(), { type: "move", delta: 1 }).selectedKey).toBeNull();
  });
});

describe("carrying a verb out", () => {
  const items = duplicates(3);

  it("marks the item as working, and a refusal stays beside it", () => {
    const key = keyOf(items[0]!);
    const pending = run(loaded(items), { type: "actionPending", key, verb: "dismiss" });
    expect(pending.actions[key]).toEqual({ status: "pending", verb: "dismiss" });
    const refused = run(pending, {
      type: "actionRefused",
      key,
      message: "inbox.result.stale"
    });
    expect(refused.actions[key]).toEqual({ status: "refused", message: "inbox.result.stale" });
    expect(refused.announcement).toBe("inbox.result.stale");
    expect(refused.items).toHaveLength(3);
  });

  it("removes a finished item and selects the next one, or the previous at the end", () => {
    const state = loaded(items);
    const done = run(state, {
      type: "actionDone",
      key: keyOf(items[0]!),
      announcement: "inbox.result.dismissed"
    });
    expect(done.items.map(keyOf)).toEqual([keyOf(items[1]!), keyOf(items[2]!)]);
    expect(done.selectedKey).toBe(keyOf(items[1]!));
    expect(done.announcement).toBe("inbox.result.dismissed");
    const last = run(
      state,
      { type: "edge", to: "last" },
      {
        type: "actionDone",
        key: keyOf(items[2]!),
        announcement: "inbox.result.dismissed"
      }
    );
    expect(last.selectedKey).toBe(keyOf(items[1]!));
    expect(selectionAfterRemoval(items, keyOf(items[1]!), keyOf(items[0]!))).toBe(keyOf(items[0]!));
    expect(
      run(loaded(duplicates(1)), { type: "itemGone", key: keyOf(duplicates(1)[0]!) }).selectedKey
    ).toBeNull();
  });

  it("clears the item's mark when it leaves, whether it was done or already gone", () => {
    const key = keyOf(items[0]!);
    const pending = run(loaded(items), { type: "actionPending", key, verb: "dismiss" });
    expect(
      run(pending, { type: "actionDone", key, announcement: "inbox.result.kept" }).actions
    ).toEqual({});
    expect(run(pending, { type: "itemGone", key }).actions).toEqual({});
  });

  it("offers the verbs an item lists, and keeps spending off the keyboard", () => {
    const budget = item("budget");
    const review = item("review");
    expect(offers(review, "apply")).toBe(true);
    expect(offers(review, "retry")).toBe(false);
    expect(offers(item("obsidian_conflict"), "dismiss")).toBe(false);
    expect(keyCarries(review, "apply")).toBe(true);
    expect(offers(budget, "apply")).toBe(true);
    expect(keyCarries(budget, "apply")).toBe(false);
    expect(keyCarries(budget, "dismiss")).toBe(true);
    // A suggestion's removal is not carried by x (D34); its keep is carried by a.
    expect(keyCarries(item("suggestion"), "apply")).toBe(true);
    expect(keyCarries(item("suggestion"), "dismiss")).toBe(false);
  });
});

describe("undoing the last verb", () => {
  const items = duplicates(2);
  const undo = {
    key: keyOf(items[0]!),
    kind: "duplicate" as const,
    id: items[0]!.id,
    verb: "dismiss" as const,
    message: "inbox.result.dismissed" as const,
    params: {},
    status: "ready" as const
  };

  it("keeps one undo until the next verb replaces it", () => {
    const state = run(loaded(items), { type: "undoable", undo });
    expect(state.undo).toEqual(undo);
    expect(run(state, { type: "undoPending" }).undo?.status).toBe("pending");
    expect(run(state, { type: "clearUndo" }).undo).toBeNull();
    expect(run(initialInboxState(), { type: "clearUndo" })).toEqual(initialInboxState());
    expect(run(initialInboxState(), { type: "undoPending" })).toEqual(initialInboxState());
  });

  it("clears the undo when it was made, or brings it back ready when it was refused", () => {
    const pending = run(loaded(items), { type: "undoable", undo }, { type: "undoPending" });
    const finished = run(pending, { type: "undoFinished", announcement: "inbox.result.undone" });
    expect(finished.undo).toBeNull();
    expect(finished.announcement).toBe("inbox.result.undone");
    const refused = run(pending, { type: "undoRefused", message: "inbox.result.failed" });
    expect(refused.undo?.status).toBe("ready");
    expect(refused.announcement).toBe("inbox.result.failed");
  });

  it("drops the undo when the filter changes the list", () => {
    const state = run(
      loaded(items),
      { type: "undoable", undo },
      {
        type: "filter",
        filter: { kind: "review" }
      }
    );
    expect(state.undo).toBeNull();
    expect(state).toMatchObject({
      filter: { kind: "review", risk: null },
      load: { status: "loading" },
      items: [],
      selectedKey: null
    });
  });
});

describe("the diff and the help", () => {
  it("keeps a diff per change-set and drops it when told", () => {
    const state = run(
      initialInboxState(),
      { type: "diff", changeSetId: "a", load: { status: "loading" } },
      { type: "diff", changeSetId: "b", load: { status: "missing" } }
    );
    expect(state.diffs).toEqual({ a: { status: "loading" }, b: { status: "missing" } });
    expect(run(state, { type: "diff", changeSetId: "a", load: null }).diffs).toEqual({
      b: { status: "missing" }
    });
  });

  it("toggles the keyboard help, or sets it", () => {
    const state = initialInboxState();
    expect(run(state, { type: "help" }).helpOpen).toBe(true);
    expect(run(state, { type: "help" }, { type: "help" }).helpOpen).toBe(false);
    expect(run(state, { type: "help", open: true }, { type: "help", open: false }).helpOpen).toBe(
      false
    );
  });

  it("announces a result with its parameters", () => {
    const state = run(initialInboxState(), {
      type: "announce",
      announcement: "inbox.result.accepted",
      params: { count: 3 }
    });
    expect(state).toMatchObject({
      announcement: "inbox.result.accepted",
      announcementParams: { count: 3 }
    });
  });

  it("keys an item by kind and ID", () => {
    expect(inboxKinds.map((kind) => keyOf(item(kind)))).toEqual(
      inboxKinds.map((kind) => inboxItemKey(item(kind)))
    );
  });
});
