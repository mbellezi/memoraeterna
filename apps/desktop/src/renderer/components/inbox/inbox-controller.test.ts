import { describe, expect, it, vi } from "vitest";

import {
  inboxKinds,
  type ChangesDiff,
  type InboxActInput,
  type InboxActResult,
  type InboxCounts,
  type InboxItem,
  type InboxList,
  type InboxListInput
} from "@app/domain";
import { createTranslator } from "@app/i18n";

import type { AppEventHandler } from "../../../shared/app-events";
import { countsOf, item, page, topicDiff, uuid } from "./inbox-fixtures";
import {
  blockerMessages,
  doneMessage,
  InboxController,
  inboxErrorMessage,
  type InboxApi
} from "./inbox-controller";
import { keyOf } from "./inbox-state";

type Listener = AppEventHandler<"inbox.changed">;

interface Harness {
  controller: InboxController;
  api: {
    list: ReturnType<typeof vi.fn<(input?: InboxListInput) => Promise<InboxList>>>;
    counts: ReturnType<typeof vi.fn<() => Promise<InboxCounts>>>;
    act: ReturnType<typeof vi.fn<(input: InboxActInput) => Promise<InboxActResult>>>;
    diff: ReturnType<
      typeof vi.fn<(input: { kind: string; id: string }) => Promise<ChangesDiff | null>>
    >;
  };
  items: InboxItem[];
  emit(counts: InboxCounts): void;
  listening(): boolean;
}

function harness(initial: InboxItem[] = [item("review"), item("duplicate")]): Harness {
  const state = { items: initial };
  let listener: Listener | null = null;
  const api = {
    list: vi.fn<(input?: InboxListInput) => Promise<InboxList>>(async (input) =>
      page(state.items.filter((entry) => !input?.kinds || input.kinds.includes(entry.kind)))
    ),
    counts: vi.fn<() => Promise<InboxCounts>>(async () => countsOf(state.items)),
    act: vi.fn<(input: InboxActInput) => Promise<InboxActResult>>(async () => ({
      status: "done",
      undoable: false
    })),
    diff: vi.fn<(input: { kind: string; id: string }) => Promise<ChangesDiff | null>>(async () =>
      topicDiff()
    )
  };
  const fake: InboxApi = {
    inbox: { list: api.list, counts: api.counts, act: api.act },
    changes: { diff: api.diff as InboxApi["changes"]["diff"] },
    onAppEvent: ((type: string, handler: Listener) => {
      if (type === "inbox.changed") listener = handler;
      return () => {
        listener = null;
      };
    }) as InboxApi["onAppEvent"]
  };
  const controller = new InboxController({ api: () => fake, pageSize: 2 });
  return {
    controller,
    api,
    get items() {
      return state.items;
    },
    set items(next: InboxItem[]) {
      state.items = next;
    },
    emit: (counts) => listener?.({ type: "inbox.changed", ...counts }),
    listening: () => listener !== null
  } as Harness;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const t = createTranslator("en");

async function shown(h: Harness): Promise<void> {
  h.controller.show(true);
  await settle();
}

describe("showing the Inbox", () => {
  it("reads the first page and the counts once, and selects the first item", async () => {
    const h = harness();
    h.controller.show(true);
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    await settle();
    const state = h.controller.getSnapshot();
    expect(state.load).toEqual({ status: "ready" });
    expect(state.items.map((entry) => entry.kind)).toEqual(["review", "duplicate"]);
    expect(state.selectedKey).toBe(keyOf(state.items[0]!));
    expect(state.counts?.total).toBe(2);
    expect(h.api.list).toHaveBeenCalledTimes(1);
    expect(h.api.list).toHaveBeenCalledWith({ limit: 2 });
    expect(h.api.counts).toHaveBeenCalledTimes(1);
    expect(h.api.act).not.toHaveBeenCalled();
    // Showing it again with the same state reads nothing more.
    h.controller.show(true);
    await settle();
    expect(h.api.list).toHaveBeenCalledTimes(1);
  });

  it("loads nothing and listens to nothing while hidden", async () => {
    const h = harness();
    h.controller.show(false);
    await settle();
    expect(h.api.list).not.toHaveBeenCalled();
    expect(h.listening()).toBe(false);
    await shown(h);
    expect(h.listening()).toBe(true);
    h.controller.show(false);
    expect(h.listening()).toBe(false);
  });

  it("refreshes in place when shown again after a good load", async () => {
    const h = harness();
    await shown(h);
    const before = h.controller.getSnapshot();
    h.controller.show(false);
    h.items = [...h.items, item("budget")];
    h.controller.show(true);
    // What is on screen stays while the new read is in flight.
    expect(h.controller.getSnapshot().load.status).toBe("ready");
    expect(h.controller.getSnapshot().items).toEqual(before.items);
    await settle();
    expect(h.controller.getSnapshot().items).toHaveLength(3);
    expect(h.api.list).toHaveBeenCalledTimes(2);
  });

  it("shows an empty Inbox", async () => {
    const h = harness([]);
    await shown(h);
    expect(h.controller.getSnapshot()).toMatchObject({
      load: { status: "ready" },
      items: [],
      selectedKey: null
    });
  });

  it("keeps a failed load visible and retryable, then loads", async () => {
    const h = harness();
    h.api.list.mockRejectedValueOnce(new Error("down"));
    await shown(h);
    expect(h.controller.getSnapshot().load).toEqual({ status: "error" });
    // Shown again, a failed key is a normal load with its loading state.
    h.controller.show(false);
    h.api.list.mockRejectedValueOnce(new Error("down"));
    h.controller.show(true);
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "error" });
    h.controller.retry();
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "ready" });
  });

  it("keeps the list a silent refresh could not read again", async () => {
    const h = harness();
    await shown(h);
    h.controller.show(false);
    h.api.list.mockRejectedValueOnce(new Error("down"));
    h.controller.show(true);
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "ready" });
    expect(h.controller.getSnapshot().items).toHaveLength(2);
  });

  it("does not retry while hidden", async () => {
    const h = harness();
    h.controller.retry();
    await settle();
    expect(h.api.list).not.toHaveBeenCalled();
  });
});

describe("following the Inbox", () => {
  it("takes the pushed counts and reads the list again, keeping the selection", async () => {
    const h = harness([item("review"), item("duplicate"), item("backlog")]);
    await shown(h);
    h.controller.command({ type: "move", delta: 1 });
    const selected = h.controller.getSnapshot().selectedKey;
    h.items = [item("duplicate"), item("backlog"), item("withdrawn")];
    h.emit(countsOf(h.items));
    expect(h.controller.getSnapshot().counts?.total).toBe(3);
    await settle();
    expect(h.api.list).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot().selectedKey).toBe(selected);
    expect(h.controller.getSnapshot().items.map((entry) => entry.kind)).toContain("withdrawn");
  });

  it("narrows to a kind or a risk and reads that list", async () => {
    const h = harness([item("review"), item("duplicate"), item("budget")]);
    await shown(h);
    h.controller.setFilter({ kind: "duplicate" });
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    await settle();
    expect(h.api.list).toHaveBeenLastCalledWith({ kinds: ["duplicate"], limit: 2 });
    expect(h.controller.getSnapshot().items.map((entry) => entry.kind)).toEqual(["duplicate"]);
    h.controller.setFilter({ risk: "high" });
    await settle();
    expect(h.api.list).toHaveBeenLastCalledWith({ kinds: ["duplicate"], risk: "high", limit: 2 });
    h.controller.setFilter({ kind: null, risk: null });
    await settle();
    expect(h.api.list).toHaveBeenLastCalledWith({ limit: 2 });
    expect(h.controller.getSnapshot().items).toHaveLength(3);
  });

  it("drops an answer for a list the person already left", async () => {
    const h = harness([item("review"), item("duplicate")]);
    let release: (value: InboxList) => void = () => undefined;
    h.api.list.mockImplementationOnce(
      () => new Promise<InboxList>((resolve) => (release = resolve))
    );
    h.controller.show(true);
    h.controller.setFilter({ kind: "duplicate" });
    await settle();
    release(page([item("review")]));
    await settle();
    expect(h.controller.getSnapshot().items.map((entry) => entry.kind)).toEqual(["duplicate"]);
  });
});

describe("paging", () => {
  const many = Array.from({ length: 5 }, (_, index) =>
    item("duplicate", { id: uuid(100 + index) })
  );

  function paged(): Harness {
    const h = harness(many);
    h.api.list.mockImplementation(async (input) => {
      const start = input?.cursor ? Number(input.cursor) : 0;
      const end = start + (input?.limit ?? 2);
      return page(many.slice(start, end), end < many.length ? String(end) : null);
    });
    return h;
  }

  it("reads the next page when the selection reaches the last item loaded", async () => {
    const h = paged();
    await shown(h);
    expect(h.controller.getSnapshot()).toMatchObject({ nextCursor: "2" });
    // Moving onto the last item loaded reads the next page ahead of the person.
    h.controller.command({ type: "move", delta: 1 });
    await settle();
    expect(h.api.list).toHaveBeenCalledTimes(2);
    expect(h.api.list).toHaveBeenLastCalledWith({ cursor: "2", limit: 2 });
    expect(h.controller.getSnapshot().items).toHaveLength(4);
    h.controller.command({ type: "edge", to: "last" });
    await h.controller.loadMore();
    expect(h.controller.getSnapshot().items).toHaveLength(5);
    expect(h.controller.getSnapshot().nextCursor).toBeNull();
    await h.controller.loadMore();
    expect(h.api.list).toHaveBeenCalledTimes(3);
  });

  it("keeps the pages the person loaded, and the selection on its item, when a change arrives", async () => {
    const h = paged();
    await shown(h);
    await h.controller.loadMore();
    h.controller.command({ type: "edge", to: "last" });
    const selected = h.controller.getSnapshot().selectedKey;
    expect(selected).toBe(keyOf(many[3]!));
    const before = h.api.list.mock.calls.length;
    h.emit(countsOf(many));
    await settle();
    // The refresh reads the first page and the one after it again, not the first page alone.
    expect(h.api.list.mock.calls.slice(before).map(([input]) => input)).toEqual([
      { limit: 2 },
      { cursor: "2", limit: 2 }
    ]);
    expect(h.controller.getSnapshot().items).toHaveLength(4);
    expect(h.controller.getSnapshot().selectedKey).toBe(selected);
    expect(h.controller.getSnapshot().nextCursor).toBe("4");
  });

  it("does not read a page twice at once, and keeps what a failed page left", async () => {
    const h = paged();
    await shown(h);
    const calls = h.api.list.mock.calls.length;
    h.api.list.mockRejectedValueOnce(new Error("down"));
    const first = h.controller.loadMore();
    void h.controller.loadMore();
    await first;
    expect(h.api.list.mock.calls.length).toBe(calls + 1);
    expect(h.controller.getSnapshot()).toMatchObject({ moreFailed: true, loadingMore: false });
    expect(h.controller.getSnapshot().items).toHaveLength(2);
    await h.controller.loadMore();
    expect(h.controller.getSnapshot()).toMatchObject({ moreFailed: false });
    expect(h.controller.getSnapshot().items).toHaveLength(4);
  });
});

describe("every verb goes through inbox.act", () => {
  const cases: Array<[kind: (typeof inboxKinds)[number], verb: "apply" | "dismiss" | "retry"]> = [
    ["review", "apply"],
    ["review", "dismiss"],
    ["contradiction", "apply"],
    ["contradiction", "dismiss"],
    ["suggestion", "apply"],
    ["suggestion", "dismiss"],
    ["withdrawn", "apply"],
    ["withdrawn", "dismiss"],
    ["quarantined", "retry"],
    ["quarantined", "dismiss"],
    ["duplicate", "dismiss"],
    ["backlog", "apply"],
    ["backlog", "dismiss"],
    ["budget", "apply"],
    ["budget", "dismiss"]
  ];

  it.each(cases)("%s: %s", async (kind, verb) => {
    const target = item(kind);
    const h = harness([target, item("duplicate", { id: uuid(500) })]);
    await shown(h);
    await h.controller.act(verb);
    expect(h.api.act).toHaveBeenCalledWith({ kind, id: target.id, action: verb });
    const state = h.controller.getSnapshot();
    // The finished item leaves the list and the next one is selected.
    expect(state.items.map(keyOf)).not.toContain(keyOf(target));
    expect(state.selectedKey).not.toBe(keyOf(target));
    expect(state.announcement).toBe(doneMessage(kind, verb));
  });

  it("offers nothing on an Obsidian conflict and ignores a verb the item does not list", async () => {
    const h = harness([item("obsidian_conflict"), item("duplicate")]);
    await shown(h);
    await h.controller.act("dismiss");
    await h.controller.act("apply");
    expect(h.api.act).not.toHaveBeenCalled();
    h.controller.command({ type: "move", delta: 1 });
    await h.controller.act("apply");
    await h.controller.act("retry");
    expect(h.api.act).not.toHaveBeenCalled();
  });

  it("carries a verb out from a key, but never the budget's continue", async () => {
    const h = harness([item("budget"), item("backlog")]);
    await shown(h);
    expect(h.controller.command({ type: "verb", verb: "apply" })).toBe(false);
    expect(h.api.act).not.toHaveBeenCalled();
    expect(h.controller.command({ type: "verb", verb: "dismiss" })).toBe(true);
    await settle();
    expect(h.api.act).toHaveBeenCalledWith({
      kind: "budget",
      id: item("budget").id,
      action: "dismiss"
    });
    // The next item takes the keys: apply is accepting the re-match.
    expect(h.controller.command({ type: "verb", verb: "retry" })).toBe(false);
    expect(h.controller.command({ type: "verb", verb: "apply" })).toBe(true);
    await settle();
    expect(h.api.act).toHaveBeenLastCalledWith({
      kind: "backlog",
      id: item("backlog").id,
      action: "apply"
    });
  });

  it("says how many notes an accepted backlog queued", async () => {
    const h = harness([item("backlog")]);
    await shown(h);
    h.api.act.mockResolvedValueOnce({ status: "done", undoable: false, queued: 12 });
    await h.controller.act("apply");
    expect(h.controller.getSnapshot()).toMatchObject({
      announcement: "inbox.result.accepted",
      announcementParams: { count: 12 }
    });
    expect(t("inbox.result.accepted", { values: { count: 12 } })).toContain("12");
  });

  it("ignores a second verb on an item that is working", async () => {
    const h = harness([item("duplicate")]);
    await shown(h);
    let release: (value: InboxActResult) => void = () => undefined;
    h.api.act.mockImplementationOnce(
      () => new Promise<InboxActResult>((resolve) => (release = resolve))
    );
    const first = h.controller.act("dismiss");
    await h.controller.act("dismiss");
    expect(h.api.act).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().actions[keyOf(item("duplicate"))]).toEqual({
      status: "pending",
      verb: "dismiss"
    });
    release({ status: "done", undoable: false });
    await first;
    expect(h.controller.getSnapshot().items).toHaveLength(0);
  });
});

describe("what a verb answered", () => {
  async function actWith(result: InboxActResult | Error, target = item("review")) {
    const h = harness([target, item("duplicate")]);
    await shown(h);
    if (result instanceof Error) h.api.act.mockRejectedValueOnce(result);
    else h.api.act.mockResolvedValueOnce(result);
    await h.controller.act("apply");
    return h;
  }

  it("keeps an undo for a verb that can be taken back, and not for one that cannot", async () => {
    const h = await actWith({ status: "done", undoable: true });
    expect(h.controller.getSnapshot().undo).toMatchObject({
      kind: "review",
      verb: "apply",
      message: "inbox.result.applied",
      status: "ready"
    });
    const g = await actWith({ status: "done", undoable: false });
    expect(g.controller.getSnapshot().undo).toBeNull();
  });

  it("replaces the undo with the next verb's, and drops it when that one cannot be undone", async () => {
    const h = harness([item("review"), item("duplicate"), item("backlog")]);
    await shown(h);
    h.api.act.mockResolvedValueOnce({ status: "done", undoable: true });
    await h.controller.act("apply");
    expect(h.controller.getSnapshot().undo?.kind).toBe("review");
    h.api.act.mockResolvedValueOnce({ status: "done", undoable: true });
    await h.controller.act("dismiss");
    expect(h.controller.getSnapshot().undo?.kind).toBe("duplicate");
    h.api.act.mockResolvedValueOnce({ status: "done", undoable: false });
    await h.controller.act("dismiss");
    expect(h.controller.getSnapshot().undo).toBeNull();
  });

  it("names what blocks a verb with the writer's own sentence, and keeps the item", async () => {
    const h = await actWith({
      status: "blocked",
      blockers: [{ code: "later_change", changeSet: null }],
      more: 0
    });
    const key = keyOf(item("review"));
    expect(h.controller.getSnapshot().actions[key]).toEqual({
      status: "refused",
      message: blockerMessages.later_change
    });
    expect(h.controller.getSnapshot().items).toHaveLength(2);
    expect(t(blockerMessages.later_change)).not.toContain("changes.blockers");
  });

  it("reads the list again when the item changed, and says so", async () => {
    const h = await actWith({ status: "stale" });
    expect(h.controller.getSnapshot().actions[keyOf(item("review"))]).toEqual({
      status: "refused",
      message: "inbox.result.stale"
    });
    await settle();
    expect(h.api.list).toHaveBeenCalledTimes(2);
  });

  it("explains a verb that has to wait or does not apply", async () => {
    const waiting = await actWith({ status: "waiting" });
    expect(waiting.controller.getSnapshot().actions[keyOf(item("review"))]).toMatchObject({
      message: "inbox.result.waiting"
    });
    const unsupported = await actWith({ status: "unsupported" });
    expect(unsupported.controller.getSnapshot().actions[keyOf(item("review"))]).toMatchObject({
      message: "inbox.result.unsupported"
    });
  });

  it("drops an item that is already handled", async () => {
    const h = harness([item("review"), item("duplicate")]);
    await shown(h);
    // Someone else handled it: the stores no longer list it.
    h.items = [item("duplicate")];
    h.api.act.mockResolvedValueOnce({ status: "gone" });
    await h.controller.act("apply");
    expect(h.controller.getSnapshot().items.map((entry) => entry.kind)).toEqual(["duplicate"]);
    expect(h.controller.getSnapshot().announcement).toBe("inbox.result.gone");
    await settle();
    expect(h.api.list).toHaveBeenCalledTimes(2);
  });

  it("words a failure by the handler's own key, else plainly", async () => {
    const unavailable = await actWith(
      new Error("Error invoking remote method: inbox.errors.unavailable")
    );
    expect(unavailable.controller.getSnapshot().actions[keyOf(item("review"))]).toEqual({
      status: "refused",
      message: "inbox.errors.unavailable"
    });
    const topics = await actWith(new Error("topics.errors.notFound"));
    expect(topics.controller.getSnapshot().actions[keyOf(item("review"))]).toMatchObject({
      message: "topics.errors.notFound"
    });
    const unknown = await actWith(new Error("socket hang up"));
    expect(unknown.controller.getSnapshot().actions[keyOf(item("review"))]).toMatchObject({
      message: "inbox.result.failed"
    });
    expect(inboxErrorMessage("changes.errors.invalidCursor")).toBe("changes.errors.invalidCursor");
  });
});

describe("undo", () => {
  async function withUndo() {
    const h = harness([item("review"), item("duplicate")]);
    await shown(h);
    h.api.act.mockResolvedValueOnce({ status: "done", undoable: true });
    await h.controller.act("apply");
    h.api.act.mockClear();
    return h;
  }

  it("takes the last verb back through the same writer, then reads the list again", async () => {
    const h = await withUndo();
    expect(h.controller.command({ type: "undo" })).toBe(true);
    expect(h.controller.getSnapshot().undo?.status).toBe("pending");
    await settle();
    expect(h.api.act).toHaveBeenCalledWith({
      kind: "review",
      id: item("review").id,
      action: "undo"
    });
    expect(h.controller.getSnapshot()).toMatchObject({
      undo: null,
      announcement: "inbox.result.undone"
    });
    expect(h.api.list).toHaveBeenCalledTimes(2);
  });

  it("does not use the key when there is nothing to undo, or while an undo is working", async () => {
    const h = harness();
    await shown(h);
    expect(h.controller.command({ type: "undo" })).toBe(false);
    const g = await withUndo();
    g.api.act.mockImplementationOnce(() => new Promise<InboxActResult>(() => undefined));
    void g.controller.undo();
    expect(g.controller.command({ type: "undo" })).toBe(false);
    await g.controller.undo();
    expect(g.api.act).toHaveBeenCalledTimes(1);
  });

  it("explains a blocked undo and keeps it ready, and drops one that is no longer possible", async () => {
    const h = await withUndo();
    h.api.act.mockResolvedValueOnce({
      status: "blocked",
      blockers: [{ code: "newer_version", changeSet: null }],
      more: 0
    });
    await h.controller.undo();
    expect(h.controller.getSnapshot()).toMatchObject({
      undo: { status: "ready" },
      announcement: blockerMessages.newer_version
    });
    h.api.act.mockResolvedValueOnce({ status: "gone" });
    await h.controller.undo();
    expect(h.controller.getSnapshot()).toMatchObject({
      undo: null,
      announcement: "inbox.result.undoUnavailable"
    });
  });

  it("keeps the undo when it failed, and lets the person hide it", async () => {
    const h = await withUndo();
    h.api.act.mockRejectedValueOnce(new Error("socket hang up"));
    await h.controller.undo();
    expect(h.controller.getSnapshot()).toMatchObject({
      undo: { status: "ready" },
      announcement: "inbox.result.failed"
    });
    h.controller.dismissUndo();
    expect(h.controller.getSnapshot().undo).toBeNull();
  });
});

describe("the keys that move", () => {
  it("moves through the items, to the ends, and toggles the help", async () => {
    const h = harness([item("review"), item("duplicate"), item("backlog")]);
    await shown(h);
    const kinds = () => h.controller.selected()?.kind;
    expect(kinds()).toBe("review");
    expect(h.controller.command({ type: "move", delta: 1 })).toBe(true);
    expect(kinds()).toBe("duplicate");
    expect(h.controller.command({ type: "edge", to: "last" })).toBe(true);
    expect(kinds()).toBe("backlog");
    expect(h.controller.command({ type: "move", delta: 1 })).toBe(true);
    expect(kinds()).toBe("backlog");
    h.controller.command({ type: "edge", to: "first" });
    expect(kinds()).toBe("review");
    expect(h.controller.command({ type: "help" })).toBe(true);
    expect(h.controller.getSnapshot().helpOpen).toBe(true);
    h.controller.setHelp(false);
    expect(h.controller.getSnapshot().helpOpen).toBe(false);
    // Focus moves belong to the view.
    expect(h.controller.command({ type: "open" })).toBe(false);
    expect(h.controller.command({ type: "escape" })).toBe(false);
  });
});

describe("the change a review item would make", () => {
  it("reads its before and after once, when its item is selected", async () => {
    const h = harness([
      item("review"),
      item("duplicate"),
      item("review", { id: `topic:${uuid(901)}`, changeSet: topicDiff().summary })
    ]);
    await shown(h);
    expect(h.api.diff).toHaveBeenCalledTimes(1);
    expect(h.api.diff).toHaveBeenCalledWith({ kind: "overview", id: uuid(900) });
    expect(h.controller.getSnapshot().diffs[uuid(900)]?.status).toBe("ready");
    h.controller.command({ type: "move", delta: 1 });
    await settle();
    expect(h.api.diff).toHaveBeenCalledTimes(1);
    h.controller.command({ type: "move", delta: 1 });
    await settle();
    expect(h.api.diff).toHaveBeenLastCalledWith({ kind: "topic", id: uuid(901) });
    // Back on the first one, its diff is kept.
    h.controller.command({ type: "edge", to: "first" });
    await settle();
    expect(h.api.diff).toHaveBeenCalledTimes(2);
  });

  it("shows a change that is gone, and a failure that can be tried again", async () => {
    const h = harness([item("review")]);
    h.api.diff.mockResolvedValueOnce(null);
    await shown(h);
    expect(h.controller.getSnapshot().diffs[uuid(900)]).toEqual({ status: "missing" });
    const g = harness([item("review")]);
    g.api.diff.mockRejectedValueOnce(new Error("down"));
    await shown(g);
    expect(g.controller.getSnapshot().diffs[uuid(900)]).toEqual({ status: "error" });
    g.controller.retryDiff();
    expect(g.controller.getSnapshot().diffs[uuid(900)]).toEqual({ status: "loading" });
    await settle();
    expect(g.controller.getSnapshot().diffs[uuid(900)]?.status).toBe("ready");
  });

  it("asks for no diff for an item that is not a change-set", async () => {
    const h = harness([item("duplicate"), item("budget")]);
    await shown(h);
    h.controller.command({ type: "move", delta: 1 });
    await settle();
    expect(h.api.diff).not.toHaveBeenCalled();
  });
});

describe("the tables", () => {
  it("has a sentence for every verb of every kind", () => {
    for (const kind of inboxKinds)
      for (const verb of ["apply", "dismiss", "retry"] as const)
        expect(t(doneMessage(kind, verb)), `${kind} ${verb}`).not.toMatch(/^\[\[missing/u);
    // A Divergence kept beside the text says so; nothing was removed.
    expect(doneMessage("contradiction", "apply", "divergence")).toBe("inbox.result.kept");
    expect(doneMessage("contradiction", "dismiss", "divergence")).toBe("inbox.result.dismissed");
    expect(doneMessage("contradiction", "dismiss", "relation")).toBe("inbox.result.removed");
    // A suggestion is kept or removed; it has no plain dismiss (D34).
    expect(doneMessage("suggestion", "apply")).toBe("inbox.result.kept");
    expect(doneMessage("suggestion", "dismiss")).toBe("inbox.result.removed");
  });

  it("has a sentence for every blocker", () => {
    for (const message of Object.values(blockerMessages))
      expect(t(message)).not.toMatch(/^\[\[missing/u);
  });
});
