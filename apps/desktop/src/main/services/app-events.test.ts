import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { topicLimits } from "@app/domain";

import { appEventJobIdsMax, type AppEvent, type AppEventOf } from "../../shared/app-events.js";
import {
  AppEventBus,
  appEventCoalesceMs,
  budgetEventPublisher,
  changeSetEventHooks
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

describe("the app event bus: an Ask's status", () => {
  const status = (
    requestId: string,
    value: AppEventOf<"consultation.status">["status"]
  ): AppEventOf<"consultation.status"> => ({
    type: "consultation.status",
    requestId,
    status: value
  });

  it("keeps the newest status per request, so a wait shorter than the window shows nothing", () => {
    const { bus, sent } = newBus();
    bus.publish(status(id(1), "waitingForProvider"));
    bus.publish(status(id(2), "waitingForProvider"));
    bus.publish(status(id(1), "answering"));
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent).toEqual([status(id(1), "answering"), status(id(2), "waitingForProvider")]);
  });

  it("shows a wait that outlasts the window, then the answer resuming", () => {
    const { bus, sent } = newBus();
    bus.publish(status(id(1), "waitingForProvider"));
    vi.advanceTimersByTime(appEventCoalesceMs);
    bus.publish(status(id(1), "answering"));
    vi.advanceTimersByTime(appEventCoalesceMs);
    expect(sent.map((event) => (event as AppEventOf<"consultation.status">).status)).toEqual([
      "waitingForProvider",
      "answering"
    ]);
  });
});

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
