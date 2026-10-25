import { describe, expect, it, vi } from "vitest";

import type {
  BlockedJobGroup,
  StatusCoverageCounts,
  StatusJobEnd,
  StatusRunningJob,
  StatusTaskRow
} from "@app/db";
import {
  defaultGardenerStatusConfig,
  gardenerBlocker,
  relationExplainBackfillJobType,
  gardenerStatusKinds,
  type GardenerBlocker,
  type GardenerStatusSnapshot
} from "@app/domain";

import type { AppEvent, AppEventHandler, AppEventType } from "../../../shared/app-events.js";
import {
  GardenerStatusService,
  JobDurationSampler,
  distinctHolds,
  laneFactsOf,
  routeLaneOf,
  type GardenerStatusServiceOptions,
  type GardenerStatusStore
} from "./status-service.js";

/** A clock and timers the test moves by hand; a timer fires when `advance` passes its time. */
function fakeTime(start = Date.UTC(2026, 9, 24, 15, 0, 0)) {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    timers: {
      setTimeout(callback: () => void, ms: number) {
        const id = ++nextId;
        timers.set(id, { at: now + ms, callback });
        return id;
      },
      clearTimeout(handle: unknown) {
        timers.delete(handle as number);
      }
    },
    pending: () => timers.size,
    /** Moves the clock, firing every timer that falls due on the way, and lets async work finish. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        await settle();
        const due = [...timers]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = target;
      await settle();
    }
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const task = (type: string, counts: Partial<StatusTaskRow> = {}): StatusTaskRow => ({
  type,
  running: 0,
  ready: 0,
  sameScope: 0,
  retrying: 0,
  scheduled: 0,
  ...counts
});

const emptyCoverage: StatusCoverageCounts = {
  notes: 0,
  placedNotes: 0,
  matchedNotes: 0,
  overviews: 0,
  freshOverviews: 0
};

function setup(
  overrides: Partial<GardenerStatusServiceOptions> = {},
  storeOverrides: Partial<GardenerStatusStore> = {}
) {
  const time = fakeTime();
  const state = {
    tasks: [] as StatusTaskRow[],
    blocked: [] as BlockedJobGroup[],
    running: [] as StatusRunningJob[],
    ends: [] as StatusJobEnd[],
    coverage: emptyCoverage,
    holds: [] as GardenerBlocker[],
    lanes: [] as ReturnType<GardenerStatusServiceOptions["lanes"]>,
    models: [] as Array<{ status: string }>,
    budget: null as Awaited<ReturnType<GardenerStatusServiceOptions["budget"]>>
  };
  const store: GardenerStatusStore = {
    taskCounts: vi.fn(async () => state.tasks),
    blockedGroups: vi.fn(async () => state.blocked),
    runningJobs: vi.fn(async () => state.running),
    jobEnds: vi.fn(async () => state.ends),
    coverage: vi.fn(async () => state.coverage),
    ...storeOverrides
  };
  const published: GardenerStatusSnapshot[] = [];
  const handlers = new Map<AppEventType, Set<(event: AppEvent) => void>>();
  const events = {
    subscribe<T extends AppEventType>(type: T, handler: AppEventHandler<T>) {
      const entry = (event: AppEvent) => (handler as (event: AppEvent) => void)(event);
      const set = handlers.get(type) ?? new Set();
      set.add(entry);
      handlers.set(type, set);
      return () => set.delete(entry);
    }
  };
  const emit = (event: AppEvent) => {
    for (const handler of handlers.get(event.type) ?? []) handler(event);
  };
  const signals = new Set<() => void>();
  const warn = vi.fn();
  const service = new GardenerStatusService({
    store: () => store,
    gateHolds: () => state.holds,
    budget: async () => state.budget,
    lanes: () => state.lanes,
    models: async () => state.models,
    publish: (event) => published.push(event.status),
    events,
    signals: [
      (listener) => {
        signals.add(listener);
        return () => signals.delete(listener);
      }
    ],
    now: time.now,
    timers: time.timers,
    logger: { warn },
    ...overrides
  });
  return { service, state, store, published, emit, signals, warn, time, handlers };
}

const lane = (
  extra: Partial<ReturnType<GardenerStatusServiceOptions["lanes"]>[number]> = {}
): ReturnType<GardenerStatusServiceOptions["lanes"]>[number] => ({
  lane: "remote:codex",
  running: 0,
  waiting: { P0: 0, P1: 0, P2: 0, P3: 0 },
  pausedForMs: null,
  breaker: {
    state: "closed" as const,
    consecutiveFailures: 0,
    reopensInMs: null,
    opened: 0,
    refused: 0
  },
  failure: null,
  ...extra
});

describe("the status read from the database and the ports", () => {
  it("is idle with nothing to do, and covered", async () => {
    const { service } = setup();
    expect(await service.snapshot()).toEqual({
      state: "idle",
      params: {},
      coverage: { placed: 1, matched: 1, overviewsFresh: 1 }
    });
  });

  it("counts the Gardener's kinds, and a task scheduled for later only within its horizon", async () => {
    const { service, store } = setup();
    await service.refresh();
    expect(store.taskCounts).toHaveBeenCalledWith(gardenerStatusKinds, 300);
    expect(gardenerStatusKinds).toContain("topic-name");
    expect(gardenerStatusKinds).not.toContain("ingestion");
  });

  it("turns the counts of the library into shares rounded down", async () => {
    const { service, state } = setup();
    state.coverage = {
      notes: 200,
      placedNotes: 199,
      matchedNotes: 100,
      overviews: 3,
      freshOverviews: 1
    };
    expect((await service.snapshot()).coverage).toEqual({
      placed: 0.99,
      matched: 0.5,
      overviewsFresh: 0.33
    });
  });

  it("reads the coverage at most once in its window", async () => {
    const { service, store, time } = setup();
    await service.refresh();
    await service.refresh();
    expect(store.coverage).toHaveBeenCalledTimes(1);
    await time.advance(defaultGardenerStatusConfig.coverageTtlMs + 1);
    await service.refresh();
    expect(store.coverage).toHaveBeenCalledTimes(2);
  });

  it("explains blocked, waiting and held work from every source", async () => {
    const { service, state } = setup();
    state.tasks = [task("topic-name", { ready: 3 })];
    expect((await service.refresh()).reason).toBe("queue");

    state.blocked = [
      {
        type: "topic-gate",
        blockerClass: "no_model",
        reason: "no_decider",
        count: 4,
        earliestRunAfter: new Date(0)
      }
    ];
    expect(await service.refresh()).toMatchObject({
      state: "blocked",
      class: "no_model",
      reason: "no_decider"
    });

    state.holds = [gardenerBlocker("paused", "user_pause")];
    expect(await service.refresh()).toMatchObject({ class: "paused", action: "resume" });

    state.holds = [];
    state.blocked = [];
    state.lanes = [lane({ waiting: { P0: 0, P1: 0, P2: 2, P3: 1 }, pausedForMs: 120_000 })];
    const limited = await service.refresh();
    expect(limited).toMatchObject({ class: "waiting", reason: "provider_rate_limit" });
    expect(limited.eta).toEqual({
      kind: "at",
      at: new Date(state.lanes[0] ? Date.UTC(2026, 9, 24, 15, 2, 0) : 0).toISOString()
    });

    state.lanes = [];
    state.models = [{ status: "ready" }, { status: "verifying" }];
    expect(await service.refresh()).toMatchObject({ class: "download", reason: "model_verifying" });
  });

  it("carries the spending against the cap into a money pause", async () => {
    const { service, state } = setup();
    state.holds = [gardenerBlocker("cap", "money_80")];
    state.budget = { money: { spentUsd: 4.02, capUsd: 5 } } as never;
    expect(await service.snapshot()).toMatchObject({
      state: "attention",
      class: "cap",
      reason: "money_80",
      params: { capUsd: 5, spentUsd: 4.02 },
      action: "continue_budget"
    });
  });

  it("keeps working when the budget or the models cannot be read", async () => {
    const { service, state } = setup({
      budget: async () => {
        throw new Error("budget gone");
      },
      models: async () => {
        throw new Error("models gone");
      }
    });
    state.tasks = [task("topic-place", { running: 1 })];
    expect((await service.snapshot()).state).toBe("running");
  });

  it("explains a fetch by its time left, and a loading embedder until it is told it stopped", async () => {
    const { service, state, emit } = setup();
    service.start();
    state.tasks = [task("topic-gate", { ready: 2 })];
    state.models = [{ status: "downloading" }];
    emit({
      type: "model.download",
      localModelId: "00000000-0000-4000-8000-000000000001",
      catalogId: "ranker",
      status: "downloading",
      currentFile: null,
      downloadedBytes: 1,
      totalBytes: 10,
      bytesPerSecond: 1,
      etaSeconds: 200,
      error: null
    });
    expect(await service.refresh()).toMatchObject({
      class: "download",
      reason: "model_downloading",
      eta: { kind: "duration", seconds: 180 }
    });

    state.models = [];
    emit({
      type: "model.download",
      localModelId: "00000000-0000-4000-8000-000000000001",
      catalogId: "ranker",
      status: "ready",
      currentFile: null,
      downloadedBytes: 10,
      totalBytes: 10,
      bytesPerSecond: 0,
      etaSeconds: null,
      error: null
    });
    expect((await service.refresh()).class).toBe("waiting");

    service.noteEmbeddingLoad("loading");
    expect(await service.refresh()).toMatchObject({ class: "download", reason: "model_loading" });
    service.noteEmbeddingLoad("ready");
    expect((await service.refresh()).class).toBe("waiting");
  });

  it("stops taking a model for loading after the configured time", async () => {
    const { service, state, time } = setup();
    state.tasks = [task("topic-gate", { ready: 1 })];
    service.noteEmbeddingLoad("loading");
    expect((await service.refresh()).class).toBe("download");
    await time.advance(defaultGardenerStatusConfig.modelLoadTtlMs + 1);
    expect((await service.refresh()).class).toBe("waiting");
  });

  it("is idle, and says so, while no database is open", async () => {
    const { service } = setup({ store: () => null });
    expect(await service.snapshot()).toMatchObject({ state: "idle", params: {} });
  });

  it("keeps the last status when a read fails, and says why", async () => {
    const failing = vi.fn(async () => {
      throw new Error("database gone");
    });
    const { service, state, warn, store } = setup();
    state.tasks = [task("topic-place", { running: 1 })];
    expect((await service.refresh()).state).toBe("running");
    (store.taskCounts as ReturnType<typeof vi.fn>).mockImplementation(failing);
    expect((await service.refresh()).state).toBe("running");
    expect(warn).toHaveBeenCalledWith("The Gardener status could not be read", expect.any(Error));
    const fresh = setup({}, { taskCounts: failing });
    expect(await fresh.service.refresh()).toMatchObject({ state: "idle" });
  });
});

describe("the lane each kind's calls take (spec 3.8)", () => {
  const codex = "remote:codex";
  const priced = "remote:priced";
  const signedOut = () => lane({ lane: codex, failure: { kind: "unauthorized", ageMs: 11_000 } });
  const heldBackfills: BlockedJobGroup = {
    type: relationExplainBackfillJobType,
    blockerClass: "cap",
    reason: "money_80",
    count: 6,
    earliestRunAfter: new Date(0)
  };
  /** The money window's routes: the explanations on the priced fake, every other call on Codex. */
  const moneyWindowRoutes = vi.fn(async (route: { operation?: string }) =>
    route.operation === "relation_explanation" ? priced : codex
  );

  it("names the cap that holds work routed to another lane, not that lane's sign-in (gate S 10-25)", async () => {
    const { service, state } = setup({ routeLane: moneyWindowRoutes });
    state.holds = [gardenerBlocker("cap", "money_80")];
    state.budget = { money: { spentUsd: 0.065336, capUsd: 0.097728 } } as never;
    state.blocked = [heldBackfills];
    state.lanes = [lane({ lane: "local", breaker: null }), signedOut(), lane({ lane: priced })];
    expect(await service.refresh()).toMatchObject({
      state: "attention",
      class: "cap",
      reason: "money_80",
      action: "continue_budget"
    });
    // The backfill is read by the route the budget gate holds it by: its operation route first.
    expect(moneyWindowRoutes).toHaveBeenCalledWith({
      routeClass: "write-fast",
      operation: "relation_explanation",
      task: "text-generation"
    });
  });

  it("names the sign-in for work whose calls take the signed-out lane, held or not", async () => {
    const { service, state } = setup({ routeLane: async () => codex });
    state.holds = [gardenerBlocker("cap", "money_80")];
    state.blocked = [heldBackfills];
    state.lanes = [signedOut(), lane({ lane: priced })];
    expect(await service.refresh()).toMatchObject({ class: "no_model", reason: "signin_required" });
    state.blocked = [];
    state.tasks = [task("topic-overview", { ready: 1 })];
    expect(await service.refresh()).toMatchObject({ class: "no_model", reason: "signin_required" });
  });

  it("takes work whose lane it cannot read as any remote lane's, as without a reader", async () => {
    for (const routeLane of [
      undefined,
      async () => undefined,
      async () => {
        throw new Error("routes gone");
      }
    ]) {
      const { service, state } = setup(routeLane ? { routeLane } : {});
      state.holds = [gardenerBlocker("cap", "money_80")];
      state.blocked = [heldBackfills];
      state.lanes = [signedOut(), lane({ lane: priced })];
      expect(await service.refresh()).toMatchObject({ reason: "signin_required" });
    }
  });

  it("reads only the kinds with work now, and none whose route the budget gate does not meter", async () => {
    const routeLane = vi.fn(async () => priced);
    const { service, state } = setup({ routeLane });
    state.tasks = [
      task("topic-name"),
      task("topic-place", { running: 1 }),
      task("relation-match", { ready: 1 })
    ];
    state.lanes = [signedOut()];
    // The decider's lane is not read: its matching is work on every remote lane.
    expect(await service.refresh()).toMatchObject({ reason: "signin_required" });
    expect(routeLane).not.toHaveBeenCalled();
    state.tasks = [task("topic-name", { scheduled: 1 })];
    expect(await service.refresh()).toMatchObject({ reason: "queue" });
    expect(routeLane).toHaveBeenCalledOnce();
    expect(routeLane).toHaveBeenCalledWith({ routeClass: "write-fast" });
  });
});

describe("the time left from the tasks the service saw finish", () => {
  it("is the median duration of a kind times the tasks ahead of it", async () => {
    const { service, state, time } = setup();
    const claimed = (id: string, ago: number): StatusRunningJob => ({
      id,
      type: "topic-place",
      lockedAt: new Date(time.now() - ago)
    });
    // Five tasks are seen running, then done, each after 4 s.
    for (let index = 0; index < 5; index += 1) {
      state.running = [claimed(`job-${index}`, 4_000)];
      state.tasks = [task("topic-place", { running: 1 })];
      await service.refresh();
      state.running = [];
      state.tasks = [];
      state.ends = [{ id: `job-${index}`, status: "succeeded", finishedAt: new Date(time.now()) }];
      await service.refresh();
    }
    state.tasks = [task("topic-place", { ready: 30 })];
    state.ends = [];
    const snapshot = await service.refresh();
    expect(snapshot.eta).toEqual({ kind: "duration", seconds: 120 });
  });

  it("has no estimate before three tasks of the kind finished", async () => {
    const { service, state } = setup();
    state.tasks = [task("topic-place", { ready: 30 })];
    expect((await service.refresh()).eta).toBeUndefined();
  });
});

describe("the duration sampler", () => {
  const ends = (list: StatusJobEnd[]) => async () => list;

  it("keeps the time from the claim to the finish of a job that succeeded", async () => {
    const sampler = new JobDurationSampler();
    const claimed = new Date(1_000);
    await sampler.observe([{ id: "a", type: "topic-name", lockedAt: claimed }], 1_500, ends([]));
    expect(sampler.durations()).toEqual({});
    await sampler.observe(
      [],
      9_000,
      ends([{ id: "a", status: "succeeded", finishedAt: new Date(4_000) }])
    );
    expect(sampler.durations()).toEqual({ "topic-name": [3_000] });
  });

  it("takes no sample from a job that failed, was set aside, or has no finish time", async () => {
    const sampler = new JobDurationSampler();
    const running = ["a", "b", "c", "d"].map((id) => ({
      id,
      type: "topic-name",
      lockedAt: new Date(0)
    }));
    await sampler.observe(running, 100, ends([]));
    await sampler.observe(
      [],
      200,
      ends([
        { id: "a", status: "failed", finishedAt: new Date(150) },
        { id: "b", status: "queued", finishedAt: null },
        { id: "c", status: "succeeded", finishedAt: null }
      ])
    );
    expect(sampler.durations()).toEqual({});
  });

  it("starts a job claimed without a time from the first look at it", async () => {
    const sampler = new JobDurationSampler();
    await sampler.observe([{ id: "a", type: "topic-name", lockedAt: null }], 5_000, ends([]));
    await sampler.observe(
      [],
      6_000,
      ends([{ id: "a", status: "succeeded", finishedAt: new Date(7_000) }])
    );
    expect(sampler.durations()).toEqual({ "topic-name": [2_000] });
  });

  it("bounds the samples it keeps per kind and ignores nonsense", () => {
    const sampler = new JobDurationSampler();
    for (let index = 0; index < 700; index += 1) sampler.add("topic-name", index);
    sampler.add("topic-name", -1);
    sampler.add("topic-name", Number.NaN);
    const kept = sampler.durations()["topic-name"]!;
    expect(kept).toHaveLength(500);
    expect(kept[0]).toBe(200);
    expect(kept.at(-1)).toBe(699);
  });
});

describe("publishing", () => {
  it("publishes the first status and then only what changes", async () => {
    const { service, state, published } = setup();
    await service.refresh();
    await service.refresh();
    expect(published).toHaveLength(1);
    state.holds = [gardenerBlocker("paused", "user_pause")];
    await service.refresh();
    await service.refresh();
    expect(published).toHaveLength(2);
    expect(published[1]).toMatchObject({ class: "paused", reason: "user_pause" });
  });

  it("does not publish again for a time that only drifted by a few milliseconds", async () => {
    const { service, state, published } = setup();
    state.tasks = [task("topic-name", { ready: 1 })];
    const paused = (ms: number) => [
      lane({ waiting: { P0: 0, P1: 0, P2: 1, P3: 0 }, pausedForMs: ms })
    ];
    state.lanes = paused(120_000);
    await service.refresh();
    state.lanes = paused(119_996);
    await service.refresh();
    state.lanes = paused(120_011);
    await service.refresh();
    expect(published).toHaveLength(1);
    state.lanes = paused(240_000);
    await service.refresh();
    expect(published).toHaveLength(2);
  });

  it("does not let a failing publisher fail the status", async () => {
    const { service, warn } = setup({
      publish: () => {
        throw new Error("window gone");
      }
    });
    expect((await service.refresh()).state).toBe("idle");
    expect(warn).toHaveBeenCalledWith(
      "The Gardener status could not be published",
      expect.any(Error)
    );
  });

  it("answers a read from the last status inside the refresh window", async () => {
    const { service, store, time } = setup();
    await service.snapshot();
    await service.snapshot();
    expect(store.taskCounts).toHaveBeenCalledTimes(1);
    await time.advance(defaultGardenerStatusConfig.refreshWindowMs + 1);
    await service.snapshot();
    expect(store.taskCounts).toHaveBeenCalledTimes(2);
  });

  it("reads once for any number of readers at the same time, and once more if something changed meanwhile", async () => {
    const { service, store } = setup();
    const reads = await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
    expect(reads[0]).toBe(reads[1]);
    expect(store.taskCounts).toHaveBeenCalledTimes(2);
  });
});

describe("following changes", () => {
  it("recomputes once, after the window, however many changes come", async () => {
    const { service, store, emit, signals, time } = setup();
    service.start();
    await time.advance(defaultGardenerStatusConfig.refreshWindowMs);
    const initial = vi.mocked(store.taskCounts).mock.calls.length;
    for (let index = 0; index < 10; index += 1) {
      emit({
        type: "job.progress",
        lanes: {
          heavy: { queued: 0, blocked: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 },
          light: { queued: 0, blocked: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 }
        },
        changedIds: [],
        changedIdsTruncated: false
      });
      for (const signal of signals) signal();
    }
    service.touch();
    expect(store.taskCounts).toHaveBeenCalledTimes(initial);
    await time.advance(defaultGardenerStatusConfig.refreshWindowMs);
    expect(store.taskCounts).toHaveBeenCalledTimes(initial + 1);
  });

  it("follows the controls and the budget the instant they change", async () => {
    const { service, state, published, emit, signals, time } = setup();
    service.start();
    await time.advance(defaultGardenerStatusConfig.refreshWindowMs);
    expect(published).toHaveLength(1);
    state.holds = [gardenerBlocker("paused", "autonomy_off")];
    for (const signal of signals) signal();
    await time.advance(defaultGardenerStatusConfig.refreshWindowMs);
    expect(published.at(-1)).toMatchObject({ class: "paused", reason: "autonomy_off" });
    state.holds = [gardenerBlocker("cap", "money_100")];
    emit({
      type: "budget.changed",
      budget: {
        month: "2026-10",
        day: "2026-10-24",
        money: {
          spentUsd: 5,
          reservedUsd: 0,
          capUsd: 5,
          pauseShare: 0.8,
          continued: false,
          state: "exhausted",
          priceTableVersion: "v"
        },
        calls: { usedCalls: 0, reservedCalls: 0, capCalls: 800, state: "open" }
      }
    });
    await time.advance(defaultGardenerStatusConfig.refreshWindowMs);
    expect(published.at(-1)).toMatchObject({ class: "cap", reason: "money_100" });
  });

  it("looks again on the heartbeat while something is held, and never while idle", async () => {
    const { service, state, store, time } = setup();
    await service.refresh();
    expect(time.pending()).toBe(0);
    state.holds = [gardenerBlocker("paused", "user_pause")];
    await service.refresh();
    expect(time.pending()).toBe(1);
    const reads = vi.mocked(store.taskCounts).mock.calls.length;
    await time.advance(defaultGardenerStatusConfig.heartbeatMs);
    expect(store.taskCounts).toHaveBeenCalledTimes(reads + 1);
  });

  it("looks again just after a hold clears by itself, and the status then lets go", async () => {
    const { service, state, published, time } = setup({}, {});
    state.tasks = [task("topic-name", { ready: 1 })];
    state.lanes = [lane({ waiting: { P0: 0, P1: 0, P2: 1, P3: 0 }, pausedForMs: 10_000 })];
    await service.refresh();
    expect(published.at(-1)).toMatchObject({ reason: "provider_rate_limit" });
    // The pause lifts at +10 s; the lane reports it paused no longer.
    state.lanes = [lane({ waiting: { P0: 0, P1: 0, P2: 1, P3: 0 }, pausedForMs: null })];
    await time.advance(11_000);
    expect(published.at(-1)).toMatchObject({ class: "waiting", reason: "queue" });
  });

  it("stops following when stopped: no read, no publication, no timer", async () => {
    const { service, store, published, emit, signals, time } = setup();
    service.start();
    await time.advance(defaultGardenerStatusConfig.refreshWindowMs);
    service.stop();
    const reads = vi.mocked(store.taskCounts).mock.calls.length;
    const sent = published.length;
    emit({
      type: "model.download",
      localModelId: "00000000-0000-4000-8000-000000000001",
      catalogId: "ranker",
      status: "downloading",
      currentFile: null,
      downloadedBytes: 0,
      totalBytes: 1,
      bytesPerSecond: 0,
      etaSeconds: null,
      error: null
    });
    expect(signals.size).toBe(0);
    service.touch();
    await time.advance(120_000);
    expect(store.taskCounts).toHaveBeenCalledTimes(reads);
    expect(published).toHaveLength(sent);
    expect(time.pending()).toBe(0);
  });
});

describe("helpers", () => {
  it("lists each blocker the gates hold once, whatever number of kinds they hold", () => {
    const pause = gardenerBlocker("paused", "user_pause");
    const held = new Map<string, GardenerBlocker>([
      ["topic-name", pause],
      ["topic-areas", gardenerBlocker("paused", "user_pause")],
      ["topic-gate", gardenerBlocker("cap", "money_80")]
    ]);
    expect(
      distinctHolds(held)
        .map((blocker) => `${blocker.class}.${blocker.reason}`)
        .sort()
    ).toEqual(["cap.money_80", "paused.user_pause"]);
    expect(distinctHolds(new Map())).toEqual([]);
  });

  it("reads a route's lane from the AI service's route, as the budget gate reads its metering", async () => {
    const taskRouteModel = vi.fn(async (task: string) =>
      task === "embedding" ? null : { lane: "remote:priced" }
    );
    const read = routeLaneOf(() => ({ taskRouteModel }));
    expect(
      await read({
        routeClass: "write-fast",
        operation: "relation_explanation",
        task: "text-generation"
      })
    ).toBe("remote:priced");
    expect(taskRouteModel).toHaveBeenCalledWith("text-generation", {
      workloadClass: "write-fast",
      operation: "relation_explanation"
    });
    expect(await read({ routeClass: "write-fast" })).toBe("remote:priced");
    expect(taskRouteModel).toHaveBeenLastCalledWith("structured-output", {
      workloadClass: "write-fast"
    });
    // No route serves it: its calls take no lane. No AI service yet: the lane is not known.
    expect(await read({ routeClass: "embed" })).toBeNull();
    expect(await routeLaneOf(() => null)({ routeClass: "write-fast" })).toBeUndefined();
  });

  it("sums the waits of a lane over its priorities", () => {
    expect(
      laneFactsOf(lane({ running: 1, waiting: { P0: 1, P1: 2, P2: 3, P3: 4 } }))
    ).toMatchObject({
      lane: "remote:codex",
      running: 1,
      waiting: 10,
      breaker: { state: "closed" }
    });
    expect(laneFactsOf({ ...lane({ lane: "local" }), breaker: null }).breaker).toBeNull();
  });
});
