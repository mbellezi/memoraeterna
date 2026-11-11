import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopicNotes, TopicPage, TopicUndoResult } from "@app/domain";
import { createTranslator } from "@app/i18n";

import { viewHistoryRecordInputSchema } from "../../../shared/view-history";
import { createFakeAppEvents } from "../../lib/fake-app-events";
import type { AppEventOf } from "../../../shared/app-events";
import { TopicPageController, type TopicPageApi } from "./topic-page-controller";
import { noteLeaf, topicFixtureId, topicPage } from "./topic-page-fixtures";

const t = createTranslator("en");
const topicId = topicFixtureId(3);
const otherId = topicFixtureId(4);

interface Harness {
  controller: TopicPageController;
  api: {
    page: ReturnType<typeof vi.fn<TopicPageApi["page"]>>;
    notes: ReturnType<typeof vi.fn<TopicPageApi["notes"]>>;
    undo: ReturnType<typeof vi.fn<TopicPageApi["undo"]>>;
  };
  record: ReturnType<typeof vi.fn>;
  /** `tree.changed` on the bus, a fake of `window.app.onAppEvent`. */
  events: ReturnType<typeof createFakeAppEvents>;
  emit(event: Partial<AppEventOf<"tree.changed">>): void;
  listening(): boolean;
}

function harness(
  answer: (id: string) => Promise<TopicPage | null> = (id) =>
    Promise.resolve(topicPage({ topic: { ...topicPage().topic, id } }))
): Harness {
  const events = createFakeAppEvents();
  const api = {
    page: vi.fn<TopicPageApi["page"]>((input) => answer(input.id)),
    notes: vi.fn<TopicPageApi["notes"]>(),
    undo: vi.fn<TopicPageApi["undo"]>()
  };
  const record = vi.fn();
  const controller = new TopicPageController({
    api: () => api,
    onTreeChanged: (listener) => events.api.onAppEvent("tree.changed", listener),
    record,
    now: () => Date.UTC(2026, 9, 15, 18, 0, 0),
    refreshDelayMs: 1_000
  });
  return {
    controller,
    api,
    record,
    events,
    emit: (event) =>
      events.emit({
        type: "tree.changed",
        treeId: topicFixtureId(999),
        generation: 13,
        topicIds: null,
        changeSetId: null,
        ...event
      }),
    listening: () => events.listening("tree.changed") > 0
  };
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("opening a page", () => {
  it("reads it once and records the open once: two calls in all, no AI and no second read", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    await settle();
    const load = h.controller.getSnapshot().load;
    expect(load.status).toBe("ready");
    expect(h.api.page).toHaveBeenCalledTimes(1);
    expect(h.api.page).toHaveBeenCalledWith({ id: topicId, noteLimit: 6 });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledWith({
      kind: "topic",
      id: topicId,
      title: "Forgetting curve"
    });
    expect(h.api.notes).not.toHaveBeenCalled();
    expect(h.api.undo).not.toHaveBeenCalled();
    expect(h.api.page.mock.calls.length + h.record.mock.calls.length).toBeLessThanOrEqual(2);
    // What the preload would send is accepted: the history validates every record it receives.
    expect(viewHistoryRecordInputSchema.safeParse(h.record.mock.calls[0]?.[0]).success).toBe(true);
  });

  it("keeps one open for one showing, however often it is shown again", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    await settle();
    h.controller.show(topicId, true, createTranslator("pt-BR"));
    h.controller.show(topicId, true, t);
    await settle();
    expect(h.api.page).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("records the topic that was resolved, not the retired one that was asked for", async () => {
    const resolved = topicPage();
    const h = harness(() => Promise.resolve({ ...resolved, redirectedFrom: otherId }));
    h.controller.show(otherId, true, t);
    await settle();
    expect(h.record).toHaveBeenCalledWith({
      kind: "topic",
      id: resolved.topic.id,
      title: "Forgetting curve"
    });
  });

  it("shows a topic that is gone as missing and records nothing", async () => {
    const h = harness(() => Promise.resolve(null));
    h.controller.show(topicId, true, t);
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "missing" });
    expect(h.record).not.toHaveBeenCalled();
  });

  it("shows a failure that Retry reads again", async () => {
    let fail = true;
    const h = harness(() =>
      fail ? Promise.reject(new Error("down")) : Promise.resolve(topicPage())
    );
    h.controller.show(topicId, true, t);
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "error" });
    expect(h.record).not.toHaveBeenCalled();
    fail = false;
    h.controller.retry();
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    await settle();
    expect(h.controller.getSnapshot().load.status).toBe("ready");
    expect(h.api.page).toHaveBeenCalledTimes(2);
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("drops an older answer that arrives after a newer one", async () => {
    const pending = new Map<string, (page: TopicPage) => void>();
    const h = harness(
      (id) =>
        new Promise((resolve) => {
          pending.set(id, resolve);
        })
    );
    h.controller.show(topicId, true, t);
    h.controller.show(otherId, true, t);
    pending.get(otherId)?.(
      topicPage({ topic: { ...topicPage().topic, id: otherId, title: "New" } })
    );
    await settle();
    pending.get(topicId)?.(topicPage());
    await settle();
    const load = h.controller.getSnapshot().load;
    expect(load.status === "ready" && load.page.topic.title).toBe("New");
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("starts from loading for another topic and records that open too", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    await settle();
    h.controller.show(otherId, true, t);
    expect(h.controller.getSnapshot().load).toEqual({ status: "loading" });
    expect(h.controller.getSnapshot().undo).toEqual({ status: "idle" });
    await settle();
    expect(h.record.mock.calls.map(([input]) => input.id)).toEqual([topicId, otherId]);
    // Back to the first topic is another open.
    h.controller.show(topicId, true, t);
    await settle();
    expect(h.record).toHaveBeenCalledTimes(3);
  });
});

describe("a hidden page", () => {
  it("loads nothing, listens to nothing and records nothing", async () => {
    const h = harness();
    h.controller.show(topicId, false, t);
    await settle();
    expect(h.api.page).not.toHaveBeenCalled();
    expect(h.events.listening("tree.changed")).toBe(0);
    expect(h.record).not.toHaveBeenCalled();
  });

  it("stops listening when hidden and refreshes in place, once, when shown again", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    await settle();
    const shown = h.controller.getSnapshot();
    h.controller.show(topicId, false, t);
    expect(h.listening()).toBe(false);
    h.emit({ topicIds: null });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.api.page).toHaveBeenCalledTimes(1);
    h.controller.show(topicId, true, t);
    // The page on screen stays while it is read again.
    expect(h.controller.getSnapshot().load).toBe(shown.load);
    await settle();
    expect(h.api.page).toHaveBeenCalledTimes(2);
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.listening()).toBe(true);
  });

  it("keeps a failed first load visible instead of retrying behind the person's back", async () => {
    const h = harness(() => Promise.reject(new Error("down")));
    h.controller.show(topicId, true, t);
    await settle();
    h.controller.show(topicId, false, t);
    h.controller.show(topicId, true, t);
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "error" });
    expect(h.api.page).toHaveBeenCalledTimes(1);
  });

  it("keeps the read in flight when it is disposed and shown again, as React does while developing", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    h.controller.dispose();
    expect(h.listening()).toBe(false);
    h.controller.show(topicId, true, t);
    expect(h.listening()).toBe(true);
    await settle();
    expect(h.controller.getSnapshot().load.status).toBe("ready");
    expect(h.api.page).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("records nothing for a read that finishes while it is disposed, and once when shown again", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    h.controller.dispose();
    await settle();
    expect(h.record).not.toHaveBeenCalled();
    h.controller.show(topicId, true, t);
    await settle();
    expect(h.record).toHaveBeenCalledTimes(1);
  });
});

describe("a pushed change", () => {
  it("reads the page again once after a quiet period, however many changes came", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    await settle();
    h.emit({ generation: 13, topicIds: [topicId] });
    h.emit({ generation: 14, topicIds: [topicId] });
    h.emit({ generation: 15, topicIds: null });
    expect(h.api.page).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.api.page).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.api.page).toHaveBeenCalledTimes(2);
  });

  it("ignores a change that cannot alter the page", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    await settle();
    h.emit({ generation: 20, topicIds: [topicFixtureId(555)] });
    h.emit({ generation: 12, topicIds: [topicId] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.api.page).toHaveBeenCalledTimes(1);
  });

  it("neither renders nor reads again when the new page has the same content", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    await settle();
    const before = h.controller.getSnapshot();
    const seen = vi.fn();
    h.controller.subscribe(seen);
    h.emit({ generation: 13, topicIds: [topicId] });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(h.api.page).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot()).toBe(before);
    expect(seen).not.toHaveBeenCalled();
    // The generation was seen: the same one asks for nothing more.
    h.emit({ generation: 12, topicIds: [topicId] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.api.page).toHaveBeenCalledTimes(2);
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("shows the new content without a loading state and keeps a failed refresh quiet", async () => {
    let call = 0;
    const h = harness(() => {
      call += 1;
      if (call === 2)
        return Promise.resolve(
          topicPage({ generation: 13, counts: { notes: 24, sources: 4, subtopics: 2 } })
        );
      if (call === 3) return Promise.reject(new Error("down"));
      return Promise.resolve(topicPage());
    });
    h.controller.show(topicId, true, t);
    await settle();
    const states: string[] = [];
    h.controller.subscribe(() => states.push(h.controller.getSnapshot().load.status));
    h.emit({ generation: 13, topicIds: [topicId] });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(states).toEqual(["ready"]);
    const ready = h.controller.getSnapshot().load;
    expect(ready.status === "ready" && ready.page.counts.notes).toBe(24);
    h.emit({ generation: 14, topicIds: [topicId] });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(h.controller.getSnapshot().load).toBe(ready);
  });

  it("makes the page missing when the topic left the tree", async () => {
    let gone = false;
    const h = harness(() => Promise.resolve(gone ? null : topicPage()));
    h.controller.show(topicId, true, t);
    await settle();
    gone = true;
    h.emit({ generation: 13, topicIds: null });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(h.controller.getSnapshot().load).toEqual({ status: "missing" });
  });

  it("stops listening and drops a waiting refresh when the topic changes", async () => {
    const h = harness();
    h.controller.show(topicId, true, t);
    await settle();
    h.emit({ generation: 13, topicIds: null });
    h.controller.show(otherId, true, t);
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.api.page.mock.calls.map(([input]) => input.id)).toEqual([topicId, otherId]);
  });
});

describe("undoing the last change", () => {
  const undone: TopicUndoResult = {
    status: "undone",
    changeSetId: topicFixtureId(901),
    generation: 13
  };

  it("undoes it, announces it and reads the page again", async () => {
    const h = harness();
    h.api.undo.mockResolvedValue(undone);
    h.controller.show(topicId, true, t);
    await settle();
    const pending = h.controller.undo();
    expect(h.controller.getSnapshot().undo).toEqual({ status: "pending" });
    await pending;
    expect(h.api.undo).toHaveBeenCalledWith({ changeSetId: topicFixtureId(900) });
    expect(h.controller.getSnapshot().undo).toEqual({ status: "idle" });
    expect(h.controller.getSnapshot().announcement).toBe("Change undone.");
    await settle();
    expect(h.api.page).toHaveBeenCalledTimes(2);
  });

  it("asks once at a time", async () => {
    const h = harness();
    h.api.undo.mockResolvedValue(undone);
    h.controller.show(topicId, true, t);
    await settle();
    const first = h.controller.undo();
    const second = h.controller.undo();
    await Promise.all([first, second]);
    expect(h.api.undo).toHaveBeenCalledTimes(1);
  });

  it("explains a refusal because a later change depends on it", async () => {
    const h = harness();
    h.api.undo.mockResolvedValue({
      status: "blocked",
      blockers: [{ kind: "changeSet", changeSetId: topicFixtureId(902), objects: [] }]
    });
    h.controller.show(topicId, true, t);
    await settle();
    await h.controller.undo();
    expect(h.controller.getSnapshot().undo).toEqual({ status: "blocked" });
    expect(h.controller.getSnapshot().announcement).toContain("cannot be undone now");
  });

  it("reports a failure the person can try again, including a handler that is not installed", async () => {
    const h = harness();
    h.api.undo.mockRejectedValueOnce(new Error("topics.errors.unavailable"));
    h.controller.show(topicId, true, t);
    await settle();
    await h.controller.undo();
    expect(h.controller.getSnapshot().undo).toEqual({ status: "failed" });
    expect(h.controller.getSnapshot().announcement).toContain("could not be undone");
    h.api.undo.mockResolvedValueOnce(undone);
    await h.controller.undo();
    expect(h.controller.getSnapshot().undo).toEqual({ status: "idle" });
  });

  it("does nothing when the change cannot be undone or there is none", async () => {
    const blocked = harness(() =>
      Promise.resolve(topicPage({ lastChange: { ...topicPage().lastChange!, undo: "blocked" } }))
    );
    blocked.controller.show(topicId, true, t);
    await settle();
    await blocked.controller.undo();
    expect(blocked.api.undo).not.toHaveBeenCalled();

    const none = harness(() => Promise.resolve(topicPage({ lastChange: null })));
    none.controller.show(topicId, true, t);
    await settle();
    await none.controller.undo();
    expect(none.api.undo).not.toHaveBeenCalled();
  });
});

describe("all the notes of the topic", () => {
  const answer = (ids: number[], nextCursor: string | null): TopicNotes => ({
    items: ids.map((n) => noteLeaf({ id: topicFixtureId(1000 + n), title: `Note ${n}` })),
    nextCursor
  });

  async function opened(h: Harness) {
    h.controller.show(topicId, true, t);
    await settle();
  }

  it("is asked for only on request, from the subtree, and pages on", async () => {
    const h = harness();
    h.api.notes
      .mockResolvedValueOnce(answer([1, 2], "c1"))
      .mockResolvedValueOnce(answer([2, 3], null));
    await opened(h);
    expect(h.api.notes).not.toHaveBeenCalled();
    h.controller.showAllNotes();
    expect(h.controller.getSnapshot().notes).toEqual({ status: "loading" });
    await settle();
    expect(h.api.notes).toHaveBeenLastCalledWith({
      id: topicId,
      scope: "subtree",
      kind: "note",
      limit: 50
    });
    let notes = h.controller.getSnapshot().notes;
    expect(notes?.status === "ready" && notes.notes.map((note) => note.title)).toEqual([
      "Note 1",
      "Note 2"
    ]);
    h.controller.loadMoreNotes();
    h.controller.loadMoreNotes();
    await settle();
    expect(h.api.notes).toHaveBeenCalledTimes(2);
    expect(h.api.notes).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "c1" }));
    notes = h.controller.getSnapshot().notes;
    expect(notes?.status === "ready" && notes.notes.map((note) => note.title)).toEqual([
      "Note 1",
      "Note 2",
      "Note 3"
    ]);
    expect(notes?.status === "ready" && notes.nextCursor).toBeNull();
    h.controller.loadMoreNotes();
    expect(h.api.notes).toHaveBeenCalledTimes(2);
  });

  it("starts again from the first page when the cursor went stale", async () => {
    const h = harness();
    h.api.notes
      .mockResolvedValueOnce(answer([1], "c1"))
      .mockRejectedValueOnce(new Error("topics.errors.stale"))
      .mockResolvedValueOnce(answer([5], null));
    await opened(h);
    h.controller.showAllNotes();
    await settle();
    h.controller.loadMoreNotes();
    await settle();
    expect(h.api.notes).toHaveBeenCalledTimes(3);
    const notes = h.controller.getSnapshot().notes;
    expect(notes?.status === "ready" && notes.notes.map((note) => note.title)).toEqual(["Note 5"]);
  });

  it("keeps the notes shown when a later page fails, and retries that page", async () => {
    const h = harness();
    h.api.notes
      .mockResolvedValueOnce(answer([1], "c1"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(answer([2], null));
    await opened(h);
    h.controller.showAllNotes();
    await settle();
    h.controller.loadMoreNotes();
    await settle();
    let notes = h.controller.getSnapshot().notes;
    expect(notes?.status === "ready" && notes.more).toBe("error");
    expect(notes?.status === "ready" && notes.notes).toHaveLength(1);
    h.controller.retryNotes();
    await settle();
    notes = h.controller.getSnapshot().notes;
    expect(notes?.status === "ready" && notes.notes).toHaveLength(2);
  });

  it("fails visibly on the first page and tries that page again", async () => {
    const h = harness();
    h.api.notes.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(answer([1], null));
    await opened(h);
    h.controller.showAllNotes();
    await settle();
    expect(h.controller.getSnapshot().notes).toEqual({ status: "error" });
    h.controller.retryNotes();
    await settle();
    expect(h.controller.getSnapshot().notes?.status).toBe("ready");
  });

  it("is forgotten when another topic opens", async () => {
    const h = harness();
    h.api.notes.mockResolvedValue(answer([1], null));
    await opened(h);
    h.controller.showAllNotes();
    await settle();
    h.controller.show(otherId, true, t);
    expect(h.controller.getSnapshot().notes).toBeNull();
  });
});
