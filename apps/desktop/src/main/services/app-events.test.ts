import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { topicLimits } from "@app/domain";

import {
  appEventJobIdsMax,
  consultationStages,
  objectChangedRefsMax,
  type AppEvent,
  type AppEventOf,
  type ObjectChangedRef
} from "../../shared/app-events.js";
import { ipcChannels } from "../../shared/ipc.js";
import {
  AppEventBus,
  appEventCoalesceMs,
  appEventDeltaMs,
  appEventPort,
  budgetEventPublisher,
  changeSetEventHooks,
  createAppEventPort
} from "./app-events.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const counts = { queued: 0, blocked: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };

const progress = (
  changedIds: string[],
  queued = 0,
  changedIdsTruncated = false
): AppEventOf<"job.progress"> => ({
  type: "job.progress",
  lanes: { heavy: { ...counts, queued }, light: counts },
  changedIds,
  changedIdsTruncated
});

const download = (
  catalogId: string,
  overrides: Partial<AppEventOf<"model.download">> = {}
): AppEventOf<"model.download"> => ({
  type: "model.download",
  localModelId: id(900),
  catalogId,
  status: "downloading",
  currentFile: "model.gguf",
  downloadedBytes: 10,
  totalBytes: 100,
  bytesPerSecond: 5,
  etaSeconds: 18,
  error: null,
  ...overrides
});

const tree = (
  topicIds: string[] | null,
  generation: number,
  changeSetId: string | null = null,
  treeId = id(700)
): AppEventOf<"tree.changed"> => ({
  type: "tree.changed",
  treeId,
  generation,
  topicIds,
  changeSetId
});

function newBus(overrides: Partial<ConstructorParameters<typeof AppEventBus>[0]> = {}) {
  const sent: AppEvent[] = [];
  const bus = new AppEventBus({ send: (event) => sent.push(event), ...overrides });
  return { bus, sent };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the app event bus: coalescing", () => {
  it("sends nothing until the window closes, then one event per type and key", () => {
    const { bus, sent } = newBus();

    bus.publish(download("model-a", { downloadedBytes: 10 }));
    bus.publish(download("model-a", { downloadedBytes: 40 }));
    bus.publish(download("model-a", { downloadedBytes: 70 }));
    vi.advanceTimersByTime(appEventCoalesceMs - 1);
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "model.download",
      catalogId: "model-a",
      downloadedBytes: 70
    });
  });

  it("keeps different keys of one type apart and in the order they first appeared", () => {
    const { bus, sent } = newBus();

    bus.publish(download("model-a", { downloadedBytes: 1 }));
    bus.publish(download("model-b", { downloadedBytes: 2 }));
    bus.publish(download("model-a", { downloadedBytes: 3 }));
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent.map((event) => (event as AppEventOf<"model.download">).catalogId)).toEqual([
      "model-a",
      "model-b"
    ]);
    expect((sent[0] as AppEventOf<"model.download">).downloadedBytes).toBe(3);
  });

  it("never lets a terminal state be overtaken by an earlier progress step", () => {
    const { bus, sent } = newBus();

    bus.publish(download("model-a", { status: "downloading", downloadedBytes: 99 }));
    bus.publish(download("model-a", { status: "ready", downloadedBytes: 100 }));
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "ready", downloadedBytes: 100 });
  });

  it("opens a new window with the first event after a flush", () => {
    const { bus, sent } = newBus();

    bus.publish(progress([id(1)]));
    vi.advanceTimersByTime(appEventCoalesceMs);
    bus.publish(progress([id(2)]));
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent).toHaveLength(2);
    expect((sent[1] as AppEventOf<"job.progress">).changedIds).toEqual([id(2)]);
  });

  it("folds job.progress into the newest counts and the changed IDs, newest first", () => {
    const { bus, sent } = newBus();

    bus.publish(progress([id(1), id(2)], 5));
    bus.publish(progress([id(3), id(1)], 4));
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent).toHaveLength(1);
    const folded = sent[0] as AppEventOf<"job.progress">;
    expect(folded.lanes.heavy.queued).toBe(4);
    expect(folded.changedIds).toEqual([id(3), id(1), id(2)]);
    expect(folded.changedIdsTruncated).toBe(false);
  });

  it("caps the changed job IDs and says it was cut", () => {
    const { bus, sent } = newBus();
    const first = Array.from({ length: appEventJobIdsMax }, (_, n) => id(1_000 + n));
    const second = Array.from({ length: 10 }, (_, n) => id(2_000 + n));

    bus.publish(progress(first));
    bus.publish(progress(second));
    vi.advanceTimersByTime(appEventCoalesceMs);

    const folded = sent[0] as AppEventOf<"job.progress">;
    expect(folded.changedIds).toHaveLength(appEventJobIdsMax);
    expect(folded.changedIds.slice(0, 10)).toEqual(second);
    expect(folded.changedIdsTruncated).toBe(true);
  });

  it("keeps a truncation that an earlier event reported", () => {
    const { bus, sent } = newBus();

    bus.publish(progress([id(1)], 0, true));
    bus.publish(progress([id(2)], 0, false));
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect((sent[0] as AppEventOf<"job.progress">).changedIdsTruncated).toBe(true);
  });

  it("folds tree.changed per tree: the highest generation, the union of topics", () => {
    const { bus, sent } = newBus();

    bus.publish(tree([id(11)], 3, id(21)));
    bus.publish(tree([id(12), id(11)], 5, id(21)));
    bus.publish(tree([id(13)], 1, null, id(701)));
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      treeId: id(700),
      generation: 5,
      topicIds: [id(11), id(12)],
      changeSetId: id(21)
    });
    expect(sent[1]).toMatchObject({ treeId: id(701), generation: 1 });
  });

  it("names no change-set once two different ones fold, and lists no topics once one change is broad", () => {
    const { bus, sent } = newBus();

    bus.publish(tree([id(11)], 1, id(21)));
    bus.publish(tree([id(12)], 2, id(22)));
    bus.publish(tree(null, 3, id(22), id(701)));
    bus.publish(tree([id(14)], 4, id(22), id(701)));
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent[0]).toMatchObject({ changeSetId: null, topicIds: [id(11), id(12)] });
    expect(sent[1]).toMatchObject({ topicIds: null, generation: 4, changeSetId: id(22) });
  });

  it("sends a broad tree change as 'refresh everything' once the topics outgrow the limit", () => {
    const { bus, sent } = newBus();
    const many = (offset: number) =>
      Array.from({ length: topicLimits.changedTopicIdsMax }, (_, n) => id(offset + n));

    bus.publish(tree(many(10_000), 1));
    bus.publish(tree(many(20_000), 2));
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect((sent[0] as AppEventOf<"tree.changed">).topicIds).toBeNull();
  });

  it("splits relation.created over 200 notes into several events and loses none", () => {
    const { bus, sent } = newBus();
    const notes = Array.from({ length: 450 }, (_, n) => id(30_000 + n));

    bus.publish({ type: "relation.created", noteIds: notes.slice(0, 200) });
    bus.publish({ type: "relation.created", noteIds: notes.slice(150, 350) });
    bus.publish({ type: "relation.created", noteIds: notes.slice(300, 450) });
    vi.advanceTimersByTime(appEventCoalesceMs);

    const parts = sent as Array<AppEventOf<"relation.created">>;
    expect(parts.map((part) => part.noteIds.length)).toEqual([200, 200, 50]);
    expect(new Set(parts.flatMap((part) => part.noteIds))).toEqual(new Set(notes));
  });

  it("keeps the newest of inbox.changed and gardener.status", () => {
    const { bus, sent } = newBus();
    const status = (state: "running" | "idle"): AppEventOf<"gardener.status"> => ({
      type: "gardener.status",
      status: {
        state,
        params: {},
        coverage: { placed: 1, matched: 1, overviewsFresh: 1 }
      }
    });

    bus.publish(status("running"));
    bus.publish(status("idle"));
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent).toHaveLength(1);
    expect((sent[0] as AppEventOf<"gardener.status">).status.state).toBe("idle");
  });

  it("keeps the newest budget meters, and one event per change-set and per overview", () => {
    const { bus, sent } = newBus();
    const budget = (spentUsd: number): AppEventOf<"budget.changed"> => ({
      type: "budget.changed",
      budget: {
        month: "2026-10",
        day: "2026-10-23",
        money: {
          spentUsd,
          reservedUsd: 0,
          capUsd: 5,
          pauseShare: 0.8,
          continued: false,
          state: "open",
          priceTableVersion: "v"
        },
        calls: { usedCalls: 0, reservedCalls: 0, capCalls: 800, state: "open" }
      }
    });
    bus.publish(budget(1));
    bus.publish(budget(2));
    bus.publish({ type: "changes.changed", kind: "topic", id: id(1) });
    bus.publish({ type: "changes.changed", kind: "topic", id: id(1) });
    bus.publish({ type: "changes.changed", kind: "relation", id: id(1) });
    bus.publish({ type: "overview.changed", topicId: id(2) });
    bus.publish({ type: "overview.changed", topicId: id(3) });
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent.map((event) => event.type)).toEqual([
      "budget.changed",
      "changes.changed",
      "changes.changed",
      "overview.changed",
      "overview.changed"
    ]);
    expect((sent[0] as AppEventOf<"budget.changed">).budget.money.spentUsd).toBe(2);
  });
});

describe("the app event bus: an Ask's status and text", () => {
  const status = (
    requestId: string,
    stage: AppEventOf<"consultation.status">["stage"]
  ): AppEventOf<"consultation.status"> => ({ type: "consultation.status", requestId, stage });

  it("never folds consultation.status: every stage leaves at once, in order", () => {
    const { bus, sent } = newBus();
    bus.publish(status(id(1), "retrieving"));
    bus.publish(status(id(1), "waitingForProvider"));
    bus.publish(status(id(2), "answering"));
    bus.publish(status(id(1), "answering"));
    bus.publish(status(id(1), "done"));
    expect(sent).toEqual([
      status(id(1), "retrieving"),
      status(id(1), "waitingForProvider"),
      status(id(2), "answering"),
      status(id(1), "answering"),
      status(id(1), "done")
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("carries all six stages and a failure's error through the bus", () => {
    const { bus, sent } = newBus();
    for (const stage of consultationStages) bus.publish(status(id(1), stage));
    bus.publish({ ...status(id(1), "failed"), error: "consultation.errors.failed" });
    expect(sent.map((event) => (event as AppEventOf<"consultation.status">).stage)).toEqual([
      ...consultationStages,
      "failed"
    ]);
    expect(sent.at(-1)).toMatchObject({ error: "consultation.errors.failed" });
  });

  const delta = (
    requestId: string,
    paragraphs: string[],
    restart = false
  ): AppEventOf<"consultation.delta"> => ({
    type: "consultation.delta",
    requestId,
    questionId: id(50),
    paragraphs: paragraphs.map((markdown) => ({ markdown, citations: [] })),
    restart
  });

  it("folds consultation.delta per request in a 50 ms window and keeps the latest", () => {
    const { bus, sent } = newBus();
    bus.publish(delta(id(1), ["One."]));
    bus.publish(delta(id(2), ["Other."]));
    bus.publish(delta(id(1), ["One.", "Two."]));
    vi.advanceTimersByTime(appEventDeltaMs - 1);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([delta(id(1), ["One.", "Two."]), delta(id(2), ["Other."])]);
  });

  it("opens a second 50 ms window after the first closed", () => {
    const { bus, sent } = newBus();
    bus.publish(delta(id(1), ["One."]));
    vi.advanceTimersByTime(appEventDeltaMs);
    bus.publish(delta(id(1), ["One.", "Two."]));
    vi.advanceTimersByTime(appEventDeltaMs);
    expect(sent).toHaveLength(2);
    expect((sent[1] as AppEventOf<"consultation.delta">).paragraphs).toHaveLength(2);
  });

  it("does not lose a restart that a later delta of the same window follows", () => {
    const { bus, sent } = newBus();
    bus.publish(delta(id(1), ["One."]));
    bus.publish(delta(id(1), ["Again."], true));
    bus.publish(delta(id(1), ["Again.", "More."]));
    vi.advanceTimersByTime(appEventDeltaMs);
    expect(sent).toEqual([{ ...delta(id(1), ["Again.", "More."]), restart: true }]);
  });

  it("folds explanation.delta per request in 50 ms, the whole text so far", () => {
    const { bus, sent } = newBus();
    const explanation = (requestId: string, text: string): AppEventOf<"explanation.delta"> => ({
      type: "explanation.delta",
      requestId,
      relationId: id(60),
      text
    });
    bus.publish(explanation(id(1), "The"));
    bus.publish(explanation(id(1), "The notes"));
    bus.publish(explanation(id(2), "Other"));
    bus.publish(explanation(id(1), ""));
    vi.advanceTimersByTime(appEventDeltaMs);
    expect(sent).toEqual([explanation(id(1), ""), explanation(id(2), "Other")]);
  });
});

describe("the app event bus: a window per type", () => {
  it("keeps each type's own window: a 50 ms type leaves before a 250 ms one", () => {
    const { bus, sent } = newBus();
    bus.publish(progress([id(1)]));
    bus.publish({
      type: "explanation.delta",
      requestId: id(1),
      relationId: id(2),
      text: "x"
    });
    vi.advanceTimersByTime(appEventDeltaMs);
    expect(sent.map((event) => event.type)).toEqual(["explanation.delta"]);
    vi.advanceTimersByTime(appEventCoalesceMs - appEventDeltaMs);
    expect(sent.map((event) => event.type)).toEqual(["explanation.delta", "job.progress"]);
  });

  it("opens one window per type, not one for all: a later event does not wait for an earlier type", () => {
    const { bus, sent } = newBus();
    bus.publish(progress([id(1)]));
    vi.advanceTimersByTime(200);
    bus.publish({ type: "overview.changed", topicId: id(3) });
    vi.advanceTimersByTime(50);
    expect(sent.map((event) => event.type)).toEqual(["job.progress"]);
    vi.advanceTimersByTime(200);
    expect(sent.map((event) => event.type)).toEqual(["job.progress", "overview.changed"]);
  });

  it("sends database.status at once (0 ms) and keeps every one", () => {
    const { bus, sent } = newBus();
    const database = (state: "starting" | "ready"): AppEventOf<"database.status"> => ({
      type: "database.status",
      state,
      messageKey: state === "ready" ? "database.status.ready" : "database.status.starting",
      updatedAt: "2026-11-11T10:00:00.000Z"
    });
    bus.publish(database("starting"));
    bus.publish(database("ready"));
    expect(sent.map((event) => (event as AppEventOf<"database.status">).state)).toEqual([
      "starting",
      "ready"
    ]);
  });

  it("lets the options' window set the default, never a type's own window", () => {
    const { bus, sent } = newBus({ windowMs: 30 });
    bus.publish(progress([id(1)]));
    bus.publish({ type: "consultation.status", requestId: id(1), stage: "answering" });
    bus.publish({ type: "explanation.delta", requestId: id(1), relationId: id(2), text: "x" });
    expect(sent.map((event) => event.type)).toEqual(["consultation.status"]);
    vi.advanceTimersByTime(appEventDeltaMs - 1);
    expect(sent.map((event) => event.type)).toEqual(["consultation.status", "job.progress"]);
    vi.advanceTimersByTime(1);
    expect(sent.map((event) => event.type)).toEqual([
      "consultation.status",
      "job.progress",
      "explanation.delta"
    ]);
  });

  it("folds settings.changed: the stores add up, a change without keys makes the fold keyless", () => {
    const { bus, sent } = newBus();
    bus.publish({ type: "settings.changed", stores: ["ai"], keys: ["route"] });
    bus.publish({ type: "settings.changed", stores: ["app"], keys: ["theme", "route"] });
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent).toEqual([
      { type: "settings.changed", stores: ["app", "ai"], keys: ["route", "theme"] }
    ]);

    bus.publish({ type: "settings.changed", stores: ["ai"], keys: ["route"] });
    bus.publish({ type: "settings.changed", stores: ["storage"] });
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent[1]).toEqual({ type: "settings.changed", stores: ["ai", "storage"] });
  });

  it("folds monitoring.changed to the earliest since, import.progress per run, projections per kind", () => {
    const { bus, sent } = newBus();
    bus.publish({ type: "monitoring.changed", since: "2026-11-11T10:05:00.000Z" });
    bus.publish({ type: "monitoring.changed", since: "2026-11-11T10:01:00.000Z" });
    bus.publish({ type: "monitoring.changed", since: "2026-11-11T10:09:00.000Z" });
    bus.publish({ type: "import.progress", runId: "a", fileIndex: 0, fraction: 0.2 });
    bus.publish({ type: "import.progress", runId: "b", fileIndex: 1, fraction: 0.1 });
    bus.publish({ type: "import.progress", runId: "a", fileIndex: 0, fraction: 0.6 });
    bus.publish({ type: "obsidian.projection", kind: "wiki", state: "running" });
    bus.publish({ type: "obsidian.projection", kind: "layout", state: "running" });
    bus.publish({ type: "obsidian.projection", kind: "wiki", state: "completed" });
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent).toEqual([
      { type: "monitoring.changed", since: "2026-11-11T10:01:00.000Z" },
      { type: "import.progress", runId: "a", fileIndex: 0, fraction: 0.6 },
      { type: "import.progress", runId: "b", fileIndex: 1, fraction: 0.1 },
      { type: "obsidian.projection", kind: "wiki", state: "completed" },
      { type: "obsidian.projection", kind: "layout", state: "running" }
    ]);
  });
});

describe("the app event bus: object.changed", () => {
  const ref = (
    n: number,
    change: ObjectChangedRef["change"],
    kind: ObjectChangedRef["kind"] = "note"
  ): ObjectChangedRef => ({ kind, id: id(n), change });
  const changed = (...refs: ObjectChangedRef[]): AppEventOf<"object.changed"> => ({
    type: "object.changed",
    refs
  });

  it("merges refs by kind and id: the last change wins", () => {
    const { bus, sent } = newBus();
    bus.publish(changed(ref(1, "created"), ref(2, "updated")));
    bus.publish(changed(ref(1, "updated"), ref(3, "moved", "topic")));
    bus.publish(changed(ref(2, "relations")));
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent).toEqual([
      changed(ref(1, "updated"), ref(2, "relations"), ref(3, "moved", "topic"))
    ]);
  });

  it("keeps the same id of two kinds apart", () => {
    const { bus, sent } = newBus();
    bus.publish(changed(ref(1, "created", "note")));
    bus.publish(changed(ref(1, "updated", "source")));
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect((sent[0] as { refs: unknown[] }).refs).toHaveLength(2);
  });

  it("lets deleted win over any later change of the same object", () => {
    const { bus, sent } = newBus();
    bus.publish(changed(ref(1, "updated"), ref(2, "created")));
    bus.publish(changed(ref(1, "deleted")));
    bus.publish(changed(ref(1, "updated"), ref(2, "deleted")));
    bus.publish(changed(ref(2, "updated")));
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent).toEqual([changed(ref(1, "deleted"), ref(2, "deleted"))]);
  });

  it("sends exactly 200 refs as they are", () => {
    const { bus, sent } = newBus();
    bus.publish(changed(...Array.from({ length: 120 }, (_, n) => ref(n, "created"))));
    bus.publish(changed(...Array.from({ length: 80 }, (_, n) => ref(1_000 + n, "created"))));
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { refs: unknown[] }).refs).toHaveLength(objectChangedRefsMax);
  });

  it("splits a batch over 200 into an overflow naming the kinds, in canonical order", () => {
    const { bus, sent } = newBus();
    const notes = Array.from({ length: 150 }, (_, n) => ref(n, "created", "note"));
    const sources = Array.from({ length: 60 }, (_, n) => ref(1_000 + n, "created", "source"));
    bus.publish(changed(...notes));
    bus.publish(changed(...sources));
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent).toEqual([{ type: "object.changed", overflow: true, kinds: ["source", "note"] }]);
  });

  it("keeps an overflow an overflow when more refs follow in the window", () => {
    const { bus, sent } = newBus();
    bus.publish({ type: "object.changed", overflow: true, kinds: ["note"] });
    bus.publish(changed(ref(1, "created", "topic")));
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent).toEqual([{ type: "object.changed", overflow: true, kinds: ["note", "topic"] }]);
  });

  it("starts the next window clean after an overflow", () => {
    const { bus, sent } = newBus();
    bus.publish({ type: "object.changed", overflow: true, kinds: ["note"] });
    vi.advanceTimersByTime(appEventCoalesceMs);
    bus.publish(changed(ref(1, "created")));
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent[1]).toEqual(changed(ref(1, "created")));
  });
});

describe("the app event bus: sticky types", () => {
  const database = (state: "starting" | "ready"): AppEventOf<"database.status"> => ({
    type: "database.status",
    state,
    messageKey: state === "ready" ? "database.status.ready" : "database.status.starting",
    updatedAt: "2026-11-11T10:00:00.000Z"
  });
  const model = (
    modelId: string,
    state: AppEventOf<"model.loading">["state"]
  ): AppEventOf<"model.loading"> => ({ type: "model.loading", modelId, state });
  const gardener = (state: "running" | "idle"): AppEventOf<"gardener.status"> => ({
    type: "gardener.status",
    status: { state, params: {}, coverage: { placed: 1, matched: 1, overviewsFresh: 1 } }
  });

  function fakeWindow(destroyed = false) {
    const sends: Array<[string, unknown]> = [];
    return {
      sends,
      window: {
        isDestroyed: () => destroyed,
        send: (channel: string, payload: unknown) => sends.push([channel, payload])
      }
    };
  }

  it("replays the last value of each sticky type and key to a window that loaded, on the one channel", () => {
    const { bus } = newBus();
    bus.publish(database("starting"));
    bus.publish(database("ready"));
    bus.publish(model("a", "loading"));
    bus.publish(model("b", "ready"));
    bus.publish(model("a", "ready"));
    bus.publish(gardener("running"));
    bus.publish(gardener("idle"));
    vi.advanceTimersByTime(appEventCoalesceMs);

    const { sends, window } = fakeWindow();
    bus.replaySticky(window);

    expect(sends.every(([channel]) => channel === ipcChannels.appEvents)).toBe(true);
    expect(sends.map(([, event]) => event)).toEqual([
      database("ready"),
      model("a", "ready"),
      model("b", "ready"),
      gardener("idle")
    ]);
  });

  it("replays a value that is still inside its window (the freshest, not the last delivered)", () => {
    const { bus, sent } = newBus();
    bus.publish(gardener("idle"));
    const { sends, window } = fakeWindow();
    bus.replaySticky(window);
    expect(sent).toHaveLength(0);
    expect(sends.map(([, event]) => event)).toEqual([gardener("idle")]);
  });

  it("replays nothing for a type that is not sticky, and nothing to a destroyed window", () => {
    const { bus } = newBus();
    bus.publish(progress([id(1)]));
    bus.publish(download("model-a"));
    bus.publish({ type: "consultation.status", requestId: id(1), stage: "answering" });
    const alive = fakeWindow();
    bus.replaySticky(alive.window);
    expect(alive.sends).toEqual([]);

    bus.publish(database("ready"));
    const gone = fakeWindow(true);
    bus.replaySticky(gone.window);
    expect(gone.sends).toEqual([]);
  });

  it("does not replay an invalid sticky event, and forgets what it held on dispose", () => {
    const { bus } = newBus({ onInvalid: () => undefined });
    bus.publish({ type: "model.loading", modelId: "", state: "ready" } as AppEvent);
    bus.publish(database("ready"));
    bus.dispose();
    const { sends, window } = fakeWindow();
    bus.replaySticky(window);
    expect(sends).toEqual([]);
  });

  it("reports a window that throws and keeps replaying to the next value", () => {
    const onError = vi.fn();
    const { bus } = newBus({ onError });
    bus.publish(database("ready"));
    bus.publish(model("a", "ready"));
    const seen: unknown[] = [];
    bus.replaySticky({
      send: (_channel, payload) => {
        seen.push(payload);
        throw new Error("gone");
      }
    });
    expect(seen).toHaveLength(2);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

describe("the app event port", () => {
  const database = (): AppEventOf<"database.status"> => ({
    type: "database.status",
    state: "ready",
    messageKey: "database.status.ready",
    updatedAt: "2026-11-11T10:00:00.000Z"
  });
  const model = (
    modelId: string,
    state: AppEventOf<"model.loading">["state"]
  ): AppEventOf<"model.loading"> => ({ type: "model.loading", modelId, state });

  it("keeps the last value of each sticky type and key before a bus attaches, and drops the rest", () => {
    const port = createAppEventPort();
    const { bus, sent } = newBus();
    port.publish(progress([id(1)]));
    port.publish({
      type: "object.changed",
      refs: [{ kind: "note", id: id(1), change: "created" }]
    });
    port.publish(model("a", "loading"));
    port.publish(model("b", "loading"));
    port.publish(model("a", "ready"));
    port.publish(database());
    port.publish({ type: "nothing.here" } as unknown as AppEvent);

    port.attach(bus);
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent).toEqual([database(), model("a", "ready"), model("b", "loading")].sort(byType));
  });

  it("publishes straight to the bus once attached, and a second attach hands over nothing twice", () => {
    const port = createAppEventPort();
    const { bus, sent } = newBus();
    port.publish(database());
    port.attach(bus);
    port.attach(bus);
    port.publish({ type: "view.changed" });
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent.map((event) => event.type).sort()).toEqual(["database.status", "view.changed"]);
  });

  it("carries events to a bus that validates them, so an invalid one is reported there", () => {
    const port = createAppEventPort();
    const onInvalid = vi.fn();
    const { bus, sent } = newBus({ onInvalid });
    port.attach(bus);
    port.publish({ type: "import.progress", runId: "a", fileIndex: 0, fraction: 7 });
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent).toEqual([]);
    expect(onInvalid).toHaveBeenCalledTimes(1);
  });

  it("goes back to buffering after detach", () => {
    const port = createAppEventPort();
    const first = newBus();
    port.attach(first.bus);
    port.detach();
    port.publish(database());
    const second = newBus();
    port.attach(second.bus);
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual([database()]);
  });

  it("exports one process-wide port", () => {
    expect(appEventPort.publish).toEqual(expect.any(Function));
    expect(appEventPort.attach).toEqual(expect.any(Function));
  });
});

function byType(left: AppEvent, right: AppEvent): number {
  return left.type.localeCompare(right.type);
}

describe("the app event bus: validation, listeners and shutdown", () => {
  it("reports an invalid event and never sends it", () => {
    const onInvalid = vi.fn();
    const { bus, sent } = newBus({ onInvalid });

    bus.publish({ type: "relation.created", noteIds: ["not-a-uuid"] } as unknown as AppEvent);
    bus.publish({ type: "nothing.here" } as unknown as AppEvent);
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(sent).toHaveLength(0);
    expect(onInvalid).toHaveBeenCalledTimes(2);
  });

  it("delivers the coalesced event to in-process subscribers of its type only", () => {
    const { bus } = newBus();
    const downloads = vi.fn();
    const jobs = vi.fn();
    bus.subscribe("model.download", downloads);
    const stop = bus.subscribe("job.progress", jobs);

    bus.publish(download("model-a", { downloadedBytes: 1 }));
    bus.publish(download("model-a", { downloadedBytes: 2 }));
    bus.publish(progress([id(1)]));
    stop();
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(downloads).toHaveBeenCalledTimes(1);
    expect(downloads).toHaveBeenCalledWith(expect.objectContaining({ downloadedBytes: 2 }));
    expect(jobs).not.toHaveBeenCalled();
  });

  it("isolates a sender or a subscriber that throws", () => {
    const onError = vi.fn();
    const boom = new Error("boom");
    const { bus } = newBus({
      send: () => {
        throw boom;
      },
      onError
    });
    const later = vi.fn();
    bus.subscribe("job.progress", () => {
      throw boom;
    });
    bus.subscribe("job.progress", later);

    bus.publish(progress([id(1)]));
    bus.publish(download("model-a"));
    vi.advanceTimersByTime(appEventCoalesceMs);

    expect(later).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it("flush sends what is pending at once", () => {
    const { bus, sent } = newBus();

    bus.publish(progress([id(1)]));
    bus.flush();

    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(appEventCoalesceMs * 4);
    expect(sent).toHaveLength(1);
  });

  it("drops what is pending on dispose and ignores later events", () => {
    const { bus, sent } = newBus();
    const subscriber = vi.fn();
    bus.subscribe("job.progress", subscriber);

    bus.publish(progress([id(1)]));
    bus.dispose();
    bus.publish(progress([id(2)]));
    vi.advanceTimersByTime(appEventCoalesceMs * 4);

    expect(sent).toHaveLength(0);
    expect(subscriber).not.toHaveBeenCalled();
  });
});

describe("the publishers wired in main", () => {
  it("puts the change-set service's hooks and the budget's meters on the bus, valid", () => {
    const invalid = vi.fn();
    const { bus, sent } = newBus({ onInvalid: invalid });
    const hooks = changeSetEventHooks(bus);
    hooks.changed({ kind: "relation", id: id(10) });
    hooks.overviewChanged(id(11));
    budgetEventPublisher(bus)({
      month: "2026-10",
      day: "2026-10-23",
      money: {
        spentUsd: 5,
        reservedUsd: 0,
        capUsd: 5,
        pauseShare: 0.8,
        continued: true,
        state: "exhausted",
        priceTableVersion: "v"
      },
      calls: { usedCalls: 0, reservedCalls: 0, capCalls: 800, state: "open" }
    });
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(invalid).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { type: "changes.changed", kind: "relation", id: id(10) },
      { type: "overview.changed", topicId: id(11) },
      expect.objectContaining({ type: "budget.changed" })
    ]);
  });
});
