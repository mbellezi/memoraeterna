import { describe, expect, it, vi } from "vitest";

import {
  AppEventSchema,
  appEventJobIdsMax,
  createAppEventDispatcher,
  inboxEventKinds,
  inboxEventRisks,
  type AppEvent,
  type AppEventWire
} from "./app-events";
import { ipcChannels } from "./ipc";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const counts = { queued: 1, blocked: 0, running: 2, succeeded: 3, failed: 0, canceled: 0 };

const samples: Record<AppEvent["type"], AppEvent> = {
  "job.progress": {
    type: "job.progress",
    lanes: { heavy: counts, light: { ...counts, queued: 40 } },
    changedIds: [id(1), id(2)],
    changedIdsTruncated: false
  },
  "inbox.changed": {
    type: "inbox.changed",
    total: 3,
    byKind: Object.fromEntries(inboxEventKinds.map((kind) => [kind, 0])) as Record<
      (typeof inboxEventKinds)[number],
      number
    >,
    byRisk: Object.fromEntries(inboxEventRisks.map((risk) => [risk, 1])) as Record<
      (typeof inboxEventRisks)[number],
      number
    >
  },
  "gardener.status": {
    type: "gardener.status",
    status: {
      state: "attention",
      class: "cap",
      reason: "money_100",
      params: { spentUsd: 5, capUsd: 5 },
      coverage: { placed: 0.9, matched: 0.5, overviewsFresh: 0.2 },
      eta: { kind: "at", at: "2026-11-01T00:00:00.000Z" },
      action: "raise_budget"
    }
  },
  "model.download": {
    type: "model.download",
    localModelId: id(3),
    catalogId: "gguf-qwen3-embedding-0.6b-q8-0",
    status: "downloading",
    currentFile: "model.gguf",
    downloadedBytes: 10,
    totalBytes: 100,
    bytesPerSecond: 5,
    etaSeconds: 18,
    error: null
  },
  "tree.changed": {
    type: "tree.changed",
    treeId: id(4),
    generation: 7,
    topicIds: [id(5)],
    changeSetId: null
  },
  "relation.created": { type: "relation.created", noteIds: [id(6)] },
  "budget.changed": {
    type: "budget.changed",
    budget: {
      month: "2026-10",
      day: "2026-10-23",
      money: {
        spentUsd: 4.2,
        reservedUsd: 0.1,
        capUsd: 5,
        pauseShare: 0.8,
        continued: false,
        state: "paused",
        priceTableVersion: "2026-10-23.2"
      },
      calls: { usedCalls: 12, reservedCalls: 1, capCalls: 800, state: "open" }
    }
  },
  "changes.changed": { type: "changes.changed", kind: "overview", id: id(7) },
  "overview.changed": { type: "overview.changed", topicId: id(8) },
  "consultation.status": {
    type: "consultation.status",
    requestId: id(10),
    status: "waitingForProvider"
  }
};

describe("the app event contract", () => {
  it.each(Object.entries(samples))("accepts a well-formed %s event", (_type, event) => {
    expect(AppEventSchema.safeParse(event).success).toBe(true);
  });

  it("covers the six event types of D26, the budget, change-set and overview changes and the Ask's status", () => {
    expect(Object.keys(samples).sort()).toEqual(
      [
        "gardener.status",
        "inbox.changed",
        "job.progress",
        "model.download",
        "relation.created",
        "tree.changed",
        "budget.changed",
        "changes.changed",
        "overview.changed",
        "consultation.status"
      ].sort()
    );
  });

  it("validates the budget's meters and a change-set's reference", () => {
    const budget = samples["budget.changed"] as Extract<AppEvent, { type: "budget.changed" }>;
    expect(
      AppEventSchema.safeParse({
        ...budget,
        budget: { ...budget.budget, money: { ...budget.budget.money, spentUsd: -1 } }
      }).success
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({ type: "changes.changed", kind: "graph", id: id(9) }).success
    ).toBe(false);
    expect(AppEventSchema.safeParse({ type: "overview.changed", topicId: "t" }).success).toBe(
      false
    );
  });

  it("knows only the two states of a running Ask, for one request id", () => {
    const status = samples["consultation.status"];
    expect(AppEventSchema.safeParse({ ...status, status: "answering" }).success).toBe(true);
    expect(AppEventSchema.safeParse({ ...status, status: "thinking" }).success).toBe(false);
    expect(AppEventSchema.safeParse({ ...status, requestId: "r" }).success).toBe(false);
    expect(AppEventSchema.safeParse({ ...status, message: "Waiting" }).success).toBe(false);
  });

  it("rejects an unknown type, a missing field, an extra field and a bad value", () => {
    expect(AppEventSchema.safeParse({ type: "job.unknown" }).success).toBe(false);
    expect(AppEventSchema.safeParse({ type: "job.progress" }).success).toBe(false);
    expect(AppEventSchema.safeParse({ ...samples["relation.created"], extra: 1 }).success).toBe(
      false
    );
    expect(
      AppEventSchema.safeParse({ ...samples["tree.changed"], treeId: "not-a-uuid" }).success
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({
        ...samples["job.progress"],
        changedIds: Array.from({ length: appEventJobIdsMax + 1 }, (_, n) => id(n))
      }).success
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({
        ...samples["job.progress"],
        lanes: { heavy: { ...counts, queued: -1 }, light: counts }
      }).success
    ).toBe(false);
  });

  it("requires every Inbox kind and risk, so a publisher cannot forget one", () => {
    const event = samples["inbox.changed"] as Extract<AppEvent, { type: "inbox.changed" }>;
    const withoutReview = Object.fromEntries(
      Object.entries(event.byKind).filter(([kind]) => kind !== "review")
    );
    expect(AppEventSchema.safeParse({ ...event, byKind: withoutReview }).success).toBe(false);
  });

  it("uses one channel for the whole bus", () => {
    expect(ipcChannels.appEvents).toBe("app:events");
    expect(new Set(Object.values(ipcChannels)).size).toBe(Object.values(ipcChannels).length);
    expect(Object.keys(ipcChannels)).not.toContain("jobsChanged");
  });
});

/** A wire that records attaches and lets a test push raw payloads, as the preload's IPC listener does. */
function fakeWire() {
  let deliver: ((payload: unknown) => void) | null = null;
  const attach = vi.fn((next: (payload: unknown) => void) => {
    deliver = next;
    return detach;
  });
  const detach = vi.fn(() => {
    deliver = null;
  });
  const wire: AppEventWire = { attach };
  return { wire, attach, detach, push: (payload: unknown) => deliver?.(payload) };
}

describe("the preload's dispatcher", () => {
  it("drops an invalid payload and delivers nothing", () => {
    const { wire, push } = fakeWire();
    const handler = vi.fn();
    createAppEventDispatcher(wire).subscribe("job.progress", handler);

    push({ type: "job.progress", lanes: "nope" });
    push({ type: "job.progress" });
    push("a string");
    push(null);
    push({ ...samples["job.progress"], changedIdsTruncated: "yes" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers a valid event only to the handlers of its type", () => {
    const { wire, push } = fakeWire();
    const dispatcher = createAppEventDispatcher(wire);
    const progress = vi.fn();
    const download = vi.fn();
    dispatcher.subscribe("job.progress", progress);
    dispatcher.subscribe("model.download", download);

    push(samples["job.progress"]);

    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith(samples["job.progress"]);
    expect(download).not.toHaveBeenCalled();
  });

  it("listens on the wire only while someone is subscribed", () => {
    const { wire, attach, detach, push } = fakeWire();
    const dispatcher = createAppEventDispatcher(wire);
    expect(attach).not.toHaveBeenCalled();

    const first = dispatcher.subscribe("job.progress", vi.fn());
    const second = dispatcher.subscribe("tree.changed", vi.fn());
    expect(attach).toHaveBeenCalledTimes(1);

    first();
    expect(detach).not.toHaveBeenCalled();
    second();
    expect(detach).toHaveBeenCalledTimes(1);
    second();
    expect(detach).toHaveBeenCalledTimes(1);

    const handler = vi.fn();
    dispatcher.subscribe("job.progress", handler);
    expect(attach).toHaveBeenCalledTimes(2);
    push(samples["job.progress"]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes one subscription of a function that subscribed twice", () => {
    const { wire, push } = fakeWire();
    const dispatcher = createAppEventDispatcher(wire);
    const handler = vi.fn();
    const stopFirst = dispatcher.subscribe("relation.created", handler);
    dispatcher.subscribe("relation.created", handler);

    stopFirst();
    push(samples["relation.created"]);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering when one handler throws, and reports the error", () => {
    const { wire, push } = fakeWire();
    const onHandlerError = vi.fn();
    const dispatcher = createAppEventDispatcher(wire, onHandlerError);
    const boom = new Error("boom");
    const after = vi.fn();
    dispatcher.subscribe("tree.changed", () => {
      throw boom;
    });
    dispatcher.subscribe("tree.changed", after);

    push(samples["tree.changed"]);

    expect(after).toHaveBeenCalledTimes(1);
    expect(onHandlerError).toHaveBeenCalledWith(boom);
  });
});
