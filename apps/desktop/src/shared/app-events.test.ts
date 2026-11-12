import { describe, expect, it, vi } from "vitest";

import { inboxKinds } from "@app/domain";

import {
  AppEventSchema,
  appEventJobIdsMax,
  consultationStages,
  createAppEventDispatcher,
  inboxEventKinds,
  inboxEventRisks,
  objectChangedRefsMax,
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
    questionId: id(11),
    stage: "waitingForProvider"
  },
  "consultation.delta": {
    type: "consultation.delta",
    requestId: id(10),
    questionId: id(11),
    paragraphs: [
      {
        markdown: "A cited paragraph.",
        citations: [{ ordinal: 1, address: `memora://note/${id(12)}`, anchor: { passage: id(13) } }]
      }
    ],
    restart: false
  },
  "object.changed": {
    type: "object.changed",
    refs: [
      { kind: "note", id: id(14), change: "updated" },
      { kind: "source", id: id(15), change: "deleted" }
    ]
  },
  "view.changed": { type: "view.changed" },
  "settings.changed": { type: "settings.changed", stores: ["app", "ai"], keys: ["theme"] },
  "database.status": {
    type: "database.status",
    state: "ready",
    messageKey: "database.status.ready",
    updatedAt: "2026-11-11T10:00:00.000Z"
  },
  "model.loading": { type: "model.loading", modelId: "mlx-embedding", state: "loading" },
  "obsidian.sync": {
    type: "obsidian.sync",
    state: "running",
    stage: "reconciling",
    progress: 0.5,
    processed: 5,
    total: 10,
    synced: 4,
    conflicts: 0,
    projected: 0,
    startedAt: "2026-11-11T10:00:00.000Z",
    finishedAt: null,
    error: null
  },
  "obsidian.projection": { type: "obsidian.projection", kind: "wiki", state: "running" },
  "monitoring.changed": { type: "monitoring.changed", since: "2026-11-11T10:00:00.000Z" },
  "explanation.delta": {
    type: "explanation.delta",
    requestId: id(16),
    relationId: id(17),
    text: "The notes agree."
  },
  "import.progress": { type: "import.progress", runId: id(18), fileIndex: 2, fraction: 0.25 }
};

describe("the app event contract", () => {
  it.each(Object.entries(samples))("accepts a well-formed %s event", (_type, event) => {
    expect(AppEventSchema.safeParse(event).success).toBe(true);
  });

  it("covers the F4 event types and the eleven that F5 adds (D16)", () => {
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
        "consultation.status",
        "consultation.delta",
        "object.changed",
        "view.changed",
        "settings.changed",
        "database.status",
        "model.loading",
        "obsidian.sync",
        "obsidian.projection",
        "monitoring.changed",
        "explanation.delta",
        "import.progress"
      ].sort()
    );
  });

  it.each(Object.entries(samples))("round-trips %s through JSON unchanged", (_type, event) => {
    const parsed = AppEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
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

  it("knows the six stages of an Ask, for one request id", () => {
    const status = samples["consultation.status"];
    for (const stage of consultationStages)
      expect(AppEventSchema.safeParse({ ...status, stage }).success).toBe(true);
    expect(consultationStages).toHaveLength(6);
    expect(AppEventSchema.safeParse({ ...status, stage: "thinking" }).success).toBe(false);
    expect(AppEventSchema.safeParse({ ...status, requestId: "r" }).success).toBe(false);
    expect(AppEventSchema.safeParse({ ...status, message: "Waiting" }).success).toBe(false);
    expect(AppEventSchema.safeParse({ ...status, status: "answering" }).success).toBe(false);
  });

  it("carries a failure's error and an optional question id on the Ask's status", () => {
    const bare: Record<string, unknown> = { ...samples["consultation.status"] };
    delete bare.questionId;
    expect(AppEventSchema.safeParse({ ...bare, stage: "retrieving" }).success).toBe(true);
    expect(
      AppEventSchema.safeParse({ ...bare, stage: "failed", error: "consultation.errors.failed" })
        .success
    ).toBe(true);
  });

  it("holds an answer's paragraphs whole, with bounded citations", () => {
    const delta = samples["consultation.delta"] as Extract<
      AppEvent,
      { type: "consultation.delta" }
    >;
    expect(AppEventSchema.safeParse({ ...delta, paragraphs: [], restart: true }).success).toBe(
      true
    );
    const withoutQuestion: Record<string, unknown> = { ...delta };
    delete withoutQuestion.questionId;
    expect(AppEventSchema.safeParse(withoutQuestion).success).toBe(false);
    expect(
      AppEventSchema.safeParse({
        ...delta,
        paragraphs: [{ markdown: "x", citations: [{ ordinal: 0, address: "memora://note/n" }] }]
      }).success
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({
        ...delta,
        paragraphs: [
          { markdown: "x", citations: [{ ordinal: 1, address: "a", anchor: { page: "1" } }] }
        ]
      }).success
    ).toBe(false);
  });

  it("lists at most 200 refs of the five kinds, or says only which kinds overflowed", () => {
    const ref = (n: number) => ({ kind: "note" as const, id: id(n), change: "created" as const });
    const many = (count: number) => Array.from({ length: count }, (_, n) => ref(n));
    expect(
      AppEventSchema.safeParse({ type: "object.changed", refs: many(objectChangedRefsMax) }).success
    ).toBe(true);
    expect(
      AppEventSchema.safeParse({ type: "object.changed", refs: many(objectChangedRefsMax + 1) })
        .success
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({ type: "object.changed", overflow: true, kinds: ["note", "topic"] })
        .success
    ).toBe(true);
    expect(AppEventSchema.safeParse({ type: "object.changed", refs: [] }).success).toBe(false);
    expect(
      AppEventSchema.safeParse({ type: "object.changed", overflow: false, kinds: ["note"] }).success
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({ type: "object.changed", refs: [{ ...ref(1), kind: "graph" }] })
        .success
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({ type: "object.changed", refs: [{ ...ref(1), change: "gone" }] })
        .success
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({ type: "object.changed", refs: [ref(1)], overflow: true }).success
    ).toBe(false);
  });

  it("names the stores a settings change touched, and rejects an unknown one", () => {
    expect(
      AppEventSchema.safeParse({ type: "settings.changed", stores: ["storage"] }).success
    ).toBe(true);
    expect(AppEventSchema.safeParse({ type: "settings.changed", stores: [] }).success).toBe(false);
    expect(AppEventSchema.safeParse({ type: "settings.changed", stores: ["theme"] }).success).toBe(
      false
    );
  });

  it("rejects a bad model state, projection kind, import fraction and monitoring time", () => {
    expect(AppEventSchema.safeParse({ ...samples["model.loading"], state: "asleep" }).success).toBe(
      false
    );
    expect(
      AppEventSchema.safeParse({ ...samples["obsidian.projection"], kind: "graph" }).success
    ).toBe(false);
    expect(AppEventSchema.safeParse({ ...samples["import.progress"], fraction: 1.5 }).success).toBe(
      false
    );
    expect(
      AppEventSchema.safeParse({ ...samples["monitoring.changed"], since: "yesterday" }).success
    ).toBe(false);
    expect(AppEventSchema.safeParse({ type: "view.changed", extra: 1 }).success).toBe(false);
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
    // The suggestions D33 routes to the Inbox have their own count (T176).
    const withoutSuggestion = Object.fromEntries(
      Object.entries(event.byKind).filter(([kind]) => kind !== "suggestion")
    );
    expect(AppEventSchema.safeParse({ ...event, byKind: withoutSuggestion }).success).toBe(false);
  });

  it("counts the same kinds the Inbox lists, in the same order", () => {
    expect([...inboxEventKinds]).toEqual([...inboxKinds]);
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

describe("the dispatcher's sticky states (T125)", () => {
  const database = { ...samples["database.status"] } as AppEvent;
  const loading = (modelId: string, state: "loading" | "ready" | "released" | "failed") =>
    ({ type: "model.loading", modelId, state }) as AppEvent;

  it("hands the last sticky value, once, to a subscriber that arrives after it was delivered", () => {
    const { wire, push } = fakeWire();
    const dispatcher = createAppEventDispatcher(wire, undefined, { eager: true });
    push(loading("a", "loading"));
    push(loading("a", "ready"));
    push(loading("b", "ready"));
    push(database);
    push(samples["job.progress"]);

    const models = vi.fn();
    const databases = vi.fn();
    const jobs = vi.fn();
    dispatcher.subscribe("model.loading", models);
    dispatcher.subscribe("database.status", databases);
    dispatcher.subscribe("job.progress", jobs);

    // One value per model, the newest; a type that is not sticky is never replayed.
    expect(models.mock.calls.map(([event]) => event)).toEqual([
      loading("a", "ready"),
      loading("b", "ready")
    ]);
    expect(databases).toHaveBeenCalledExactlyOnceWith(database);
    expect(jobs).not.toHaveBeenCalled();

    // A later event reaches the subscriber once, and a third subscriber sees the newest value.
    push(loading("a", "released"));
    expect(models).toHaveBeenCalledTimes(3);
    const late = vi.fn();
    dispatcher.subscribe("model.loading", late);
    expect(late.mock.calls.map(([event]) => event)).toEqual([
      loading("a", "released"),
      loading("b", "ready")
    ]);
  });

  it("listens from the start when eager, and never lets go of the wire", () => {
    const { wire, attach, detach } = fakeWire();
    const dispatcher = createAppEventDispatcher(wire, undefined, { eager: true });
    expect(attach).toHaveBeenCalledTimes(1);
    dispatcher.subscribe("job.progress", vi.fn())();
    expect(detach).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(1);
  });

  it("does not replay an invalid sticky event", () => {
    const { wire, push } = fakeWire();
    const dispatcher = createAppEventDispatcher(wire, undefined, { eager: true });
    push({ type: "model.loading", modelId: "", state: "ready" });
    const models = vi.fn();
    dispatcher.subscribe("model.loading", models);
    expect(models).not.toHaveBeenCalled();
  });

  it("forgets what it held once nothing listens (it cannot know what changed meanwhile)", () => {
    const { wire, push } = fakeWire();
    const dispatcher = createAppEventDispatcher(wire);
    const stop = dispatcher.subscribe("database.status", vi.fn());
    push(database);
    stop();
    const again = vi.fn();
    dispatcher.subscribe("database.status", again);
    expect(again).not.toHaveBeenCalled();
  });

  it("keeps a handler that throws from stopping the replay", () => {
    const { wire, push } = fakeWire();
    const onHandlerError = vi.fn();
    const dispatcher = createAppEventDispatcher(wire, onHandlerError, { eager: true });
    push(database);
    const boom = new Error("boom");
    dispatcher.subscribe("database.status", () => {
      throw boom;
    });
    expect(onHandlerError).toHaveBeenCalledWith(boom);
  });

  it("names the stages and page counts of an import in its progress event", () => {
    const event = {
      type: "import.progress",
      runId: id(18),
      fileIndex: 0,
      fraction: 0.4,
      stage: "processing_pages",
      completedPages: 3,
      totalPages: 10
    };
    expect(AppEventSchema.safeParse(event).success).toBe(true);
    expect(AppEventSchema.safeParse({ ...event, stage: "unknown_stage" }).success).toBe(false);
    expect(AppEventSchema.safeParse({ ...event, totalPages: 0 }).success).toBe(false);
  });
});
