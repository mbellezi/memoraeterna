import type { JobRecord } from "@app/db";
import {
  defaultKnowledgeControls,
  gardenerBlocker,
  gardenerBlockerKey,
  gardenerTaskConfig,
  type GardenerBlocker,
  type GardenerBlockerKey,
  type KnowledgeControls
} from "@app/domain";
import { describe, expect, it, vi } from "vitest";

import { BackgroundGate } from "./background-gate.js";
import { BlockerService, type JobBlockerStore } from "./blocker-service.js";
import type { PowerSnapshot } from "./power-signals.js";

interface Row {
  id: string;
  type: string;
  status: "queued" | "running";
  blocked: Pick<GardenerBlocker, "class" | "reason"> | null;
  runAfter: number;
  attempts: number;
  dedupeKey: string | null;
}

/** An in-memory `jobs` table with the blocker writes' semantics (the SQL is proven on PostgreSQL). */
function memoryStore(clock: { now: number }) {
  const rows: Row[] = [];
  const keyOf = (row: Row) => (row.blocked ? gardenerBlockerKey(row.blocked) : null);
  const store: JobBlockerStore = {
    stampGateBlocks: async (stamps, gateReasons) => {
      let count = 0;
      for (const stamp of stamps)
        for (const row of rows) {
          if (row.type !== stamp.type || row.status !== "queued") continue;
          const key = keyOf(row);
          const replace =
            key === null ||
            (gateReasons.includes(key) && key !== gardenerBlockerKey(stamp.blocker));
          if (!replace) continue;
          row.blocked = { ...stamp.blocker };
          count += 1;
        }
      return count;
    },
    clearBlocks: async ({ reasons, dueOnly, exceptTypes }) => {
      const types = new Set<string>();
      let cleared = 0;
      for (const row of rows) {
        const key = keyOf(row);
        if (row.status !== "queued" || key === null || !reasons.includes(key)) continue;
        if (dueOnly && row.runAfter > clock.now) continue;
        if (exceptTypes?.includes(row.type)) continue;
        // A paused row keeps its own run_after (a backoff or a debounce it was stamped in).
        if (row.blocked?.class !== "paused") row.runAfter = Math.min(row.runAfter, clock.now);
        row.blocked = null;
        types.add(row.type);
        cleared += 1;
      }
      return { cleared, types: [...types].sort() };
    },
    blockTask: async ({ jobId, blocker, runAfter, dedupeKey }) => {
      const row = rows.find(
        (candidate) => candidate.id === jobId && candidate.status === "running"
      );
      if (!row) return false;
      Object.assign(row, {
        status: "queued",
        attempts: Math.max(0, row.attempts - 1),
        blocked: { class: blocker.class, reason: blocker.reason },
        runAfter: runAfter ? runAfter.getTime() : clock.now,
        dedupeKey: dedupeKey ?? null
      });
      return true;
    }
  };
  let sequence = 0;
  const add = (
    type: string,
    blocked: GardenerBlockerKey | null = null,
    options: { runAfter?: number; status?: Row["status"]; attempts?: number } = {}
  ) => {
    const [blockerClass, reason] = blocked ? blocked.split(".") : [];
    const row: Row = {
      id: `job-${++sequence}`,
      type,
      status: options.status ?? "queued",
      blocked: blocked ? ({ class: blockerClass, reason } as GardenerBlocker) : null,
      runAfter: options.runAfter ?? clock.now,
      attempts: options.attempts ?? 0,
      dedupeKey: null
    };
    rows.push(row);
    return row;
  };
  const reasonOf = (row: Row) => keyOf(row);
  return { rows, store, add, reasonOf };
}

function setup(controls: Partial<KnowledgeControls> = {}, power?: Partial<PowerSnapshot>) {
  const clock = { now: Date.parse("2026-10-23T12:00:00") };
  const memory = memoryStore(clock);
  const state = {
    controls: { ...defaultKnowledgeControls, ...controls },
    power: { active: false, onBattery: false, idleMs: 3_600_000, overridden: false, ...power },
    routes: 1
  };
  const controlListeners = new Set<(changed: readonly string[]) => void>();
  const powerListeners = new Set<() => void>();
  const gate = new BackgroundGate({ controls: () => state.controls, power: () => state.power });
  const wake = vi.fn();
  const intervals: Array<() => void> = [];
  const service = new BlockerService({
    store: () => memory.store,
    gate,
    signals: {
      subscribeControls: (listener) => {
        controlListeners.add(listener);
        return () => controlListeners.delete(listener);
      },
      subscribePower: (listener) => {
        powerListeners.add(listener);
        return () => powerListeners.delete(listener);
      },
      refreshControls: async () => state.controls
    },
    wake,
    routesGeneration: () => state.routes,
    now: () => new Date(clock.now),
    timers: {
      setInterval: (callback) => intervals.push(callback),
      clearInterval: () => {
        intervals.length = 0;
      }
    }
  });
  const setControls = async (change: Partial<KnowledgeControls>) => {
    state.controls = { ...state.controls, ...change };
    for (const listener of controlListeners) listener(Object.keys(change));
    await service.reconcile();
  };
  const setPower = async (change: Partial<PowerSnapshot>) => {
    state.power = { ...state.power, ...change };
    for (const listener of powerListeners) listener();
    await service.reconcile();
  };
  return { ...memory, clock, state, service, wake, setControls, setPower, intervals };
}

describe("blocker service (D7)", () => {
  it("resumes exactly the rows of a reason when its clearing event comes", async () => {
    const { add, service, reasonOf, wake } = setup();
    const daily = add("topic-name", "cap.subscription_daily");
    const feature = add("topic-areas", "cap.feature_daily");
    const download = add("topic-gate", "download.model_loading");
    const money = add("topic-overview", "cap.money_100");
    const offline = add("relation-link", "offline.network_unreachable");
    await service.notify("day_rollover");
    expect([daily, feature].map(reasonOf)).toEqual([null, null]);
    expect([download, money, offline].map(reasonOf)).toEqual([
      "download.model_loading",
      "cap.money_100",
      "offline.network_unreachable"
    ]);
    expect(wake).toHaveBeenLastCalledWith(["topic-areas", "topic-name"]);
    await service.notify("download_settled");
    expect(reasonOf(download)).toBeNull();
    expect(reasonOf(money)).toBe("cap.money_100");
    await service.notify("network_back");
    expect(reasonOf(offline)).toBeNull();
    await service.notify("month_rollover");
    expect(reasonOf(money)).toBeNull();
  });

  it("stamps the queued rows of held kinds and clears them on resume, never a running row", async () => {
    const { add, reasonOf, setControls, wake } = setup();
    const overview = add("topic-overview");
    const name = add("topic-name");
    const place = add("topic-place");
    const running = add("topic-overview", null, { status: "running" });
    const ingestion = add("ingestion");
    await setControls({ paused: true });
    expect([overview, name, place].map(reasonOf)).toEqual([
      "paused.user_pause",
      "paused.user_pause",
      "paused.user_pause"
    ]);
    expect(reasonOf(running)).toBeNull();
    expect(reasonOf(ingestion)).toBeNull();
    // Off under pause: pause stays the highest; resuming leaves the generative kinds held by Off,
    // while naming (provisional names under Off) and placement run.
    await setControls({ autonomy: "off" });
    expect(reasonOf(overview)).toBe("paused.user_pause");
    wake.mockClear();
    await setControls({ paused: false });
    expect(reasonOf(overview)).toBe("paused.autonomy_off");
    expect(reasonOf(name)).toBeNull();
    expect(reasonOf(place)).toBeNull();
    expect(wake).toHaveBeenCalledWith(["topic-name", "topic-overview", "topic-place"]);
    await setControls({ autonomy: "suggest" });
    expect(reasonOf(overview)).toBeNull();
  });

  it("never lets a pause, autonomy or power toggle free a money-capped task; a cap change does", async () => {
    const { add, reasonOf, service, setControls, setPower } = setup();
    service.start();
    const money = add("topic-overview", "cap.money_100");
    const almost = add("relation-explain-backfill", "cap.money_80");
    await setControls({ paused: true });
    await setControls({ paused: false });
    await setControls({ autonomy: "suggest", onlyIdle: true, onlyOnAc: true });
    await setPower({ onBattery: true });
    expect([money, almost].map(reasonOf)).toEqual(["cap.money_100", "cap.money_80"]);
    await setControls({ onlyOnAc: false, onlyIdle: false, monthlyCapUsd: 20 });
    expect([money, almost].map(reasonOf)).toEqual([null, null]);
    service.stop();
  });

  it("keeps a stamped row's retry backoff when its gate lifts; an event's clear makes it due", async () => {
    const { add, rows, clock, setControls, service } = setup();
    // A task waits 20 min for a provider's reset (a retry backoff) when the pause stamps it.
    const backoff = add("topic-overview", null, { runAfter: clock.now + 20 * 60_000 });
    await setControls({ paused: true });
    await setControls({ paused: false });
    expect(rows.find((row) => row.id === backoff.id)).toMatchObject({
      blocked: null,
      runAfter: clock.now + 20 * 60_000
    });
    // A per-task wait for a sign-in clears early on the routes event: due at once.
    const signin = add("topic-overview", "no_model.signin_required", {
      runAfter: clock.now + 300_000
    });
    await service.notify("routes_changed");
    expect(rows.find((row) => row.id === signin.id)).toMatchObject({
      blocked: null,
      runAfter: clock.now
    });
  });

  it("keeps a per-task block of a gate reason while the gate still holds, and clears it after", async () => {
    const { add, reasonOf, service, setControls } = setup({ paused: true });
    // A mixed kind met the pause at admission: its claim gate never holds it, its row stays.
    const link = add("relation-link", "paused.user_pause");
    await service.notify("controls_changed");
    await service.reconcile();
    expect(reasonOf(link)).toBe("paused.user_pause");
    await setControls({ paused: false });
    expect(reasonOf(link)).toBeNull();
  });

  it("follows the user's activity under only-idle and the power source under only-AC", async () => {
    const { add, reasonOf, setPower, setControls } = setup(
      { onlyIdle: true, onlyOnAc: true },
      { idleMs: 10_000 }
    );
    const name = add("topic-name");
    await setControls({});
    expect(reasonOf(name)).toBe("paused.only_idle_user_active");
    await setPower({ idleMs: 400_000, onBattery: true });
    expect(reasonOf(name)).toBe("paused.only_ac_on_battery");
    await setPower({ onBattery: false });
    expect(reasonOf(name)).toBeNull();
  });

  it("re-gates every blocked row at startup, before the workers start", async () => {
    const { add, reasonOf, service, clock, wake } = setup({ autonomy: "off" });
    const later = add("topic-name", "waiting.provider_rate_limit", {
      runAfter: clock.now + 60_000
    });
    const due = add("topic-overview", "waiting.provider_rate_limit", { runAfter: clock.now - 1 });
    const naming = add("topic-name", "waiting.provider_rate_limit", { runAfter: clock.now - 1 });
    const download = add("topic-gate", "download.model_downloading");
    const capped = add("relation-retype", "cap.subscription_daily");
    const stalePause = add("topic-place", "paused.user_pause");
    const stillOff = add("topic-overview", "paused.autonomy_off");
    const fresh = add("topic-areas");
    await service.regate();
    expect(reasonOf(later)).toBe("waiting.provider_rate_limit");
    // Set free, then held again by what holds now: Off holds the generative kinds.
    expect([due, download, capped, stalePause].map(reasonOf)).toEqual([
      "paused.autonomy_off",
      null,
      "paused.autonomy_off",
      null
    ]);
    expect(reasonOf(stillOff)).toBe("paused.autonomy_off");
    expect(reasonOf(fresh)).toBe("paused.autonomy_off");
    // Naming runs under Off (provisional names): set free and not held again.
    expect(reasonOf(naming)).toBeNull();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![0]).toEqual(
      expect.arrayContaining([
        "topic-gate",
        "topic-name",
        "topic-overview",
        "topic-place",
        "relation-retype"
      ])
    );
  });

  it("ticks: rollovers, a moved AI configuration and time-bound waits that came due", async () => {
    const { add, reasonOf, service, clock, state } = setup();
    const daily = add("topic-name", "cap.subscription_daily");
    const route = add("topic-name", "no_model.no_route");
    const quota = add("relation-retype", "cap.provider_quota", { runAfter: clock.now + 30_000 });
    await service.tick();
    expect([daily, route, quota].map(reasonOf)).toEqual([
      "cap.subscription_daily",
      "no_model.no_route",
      "cap.provider_quota"
    ]);
    state.routes += 1;
    clock.now += 31_000;
    await service.tick();
    expect(reasonOf(route)).toBeNull();
    expect(reasonOf(quota)).toBeNull();
    expect(reasonOf(daily)).toBe("cap.subscription_daily");
    clock.now = Date.parse("2026-10-24T00:00:01");
    await service.tick();
    expect(reasonOf(daily)).toBeNull();
  });

  it("starts and stops its subscriptions and its tick", async () => {
    const { service, intervals, add, reasonOf, state, setControls } = setup();
    service.start();
    expect(intervals).toHaveLength(1);
    const name = add("topic-name");
    state.controls = { ...state.controls, paused: true };
    intervals[0]!();
    await vi.waitFor(() => expect(reasonOf(name)).toBe("paused.user_pause"));
    service.stop();
    expect(intervals).toHaveLength(0);
    await setControls({ paused: false });
    expect(reasonOf(name)).toBeNull();
  });

  it("sets a claimed task aside with its attempt back, due when its blocker clears", async () => {
    const { add, rows, service, clock } = setup();
    const job = (row: { id: string }) => ({ id: row.id, dedupeKey: "key" }) as JobRecord;
    const known = add("topic-overview", null, { status: "running", attempts: 1 });
    expect(
      await service.blockTask(
        job(known),
        gardenerBlocker("waiting", "provider_rate_limit", { clearsAt: clock.now + 5_000 })
      )
    ).toBe(true);
    expect(rows.find((row) => row.id === known.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      runAfter: clock.now + 5_000,
      dedupeKey: "key"
    });
    const probe = add("relation-link", null, { status: "running", attempts: 2 });
    await service.blockTask(job(probe), gardenerBlocker("offline", "network_unreachable"));
    expect(probe.runAfter).toBe(clock.now + 300_000);
    // An event-only reason waits for its event, bounded by the task model's recheck (T74).
    const event = add("topic-name", null, { status: "running", attempts: 1 });
    await service.blockTask(job(event), gardenerBlocker("cap", "money_80"));
    expect(event.runAfter).toBe(clock.now + gardenerTaskConfig.blockRecheckMs);
    expect(event.blocked).toEqual({ class: "cap", reason: "money_80" });
    // The claim took the job's dedupe key (claimNext nulls it): the key it held is restored.
    const claimed = add("topic-areas", null, { status: "running", attempts: 1 });
    await service.blockTask(
      { id: claimed.id, dedupeKey: null, claimedDedupeKey: "topic-areas:tree" } as JobRecord,
      gardenerBlocker("paused", "user_pause")
    );
    expect(claimed).toMatchObject({ status: "queued", dedupeKey: "topic-areas:tree" });
  });

  it("never throws when the store fails, and does nothing without a database", async () => {
    const logger = { warn: vi.fn() };
    const failing = new BlockerService({
      store: () => ({
        stampGateBlocks: async () => 0,
        clearBlocks: async () => {
          throw new Error("column blocked_class does not exist");
        },
        blockTask: async () => false
      }),
      gate: new BackgroundGate({
        controls: () => defaultKnowledgeControls,
        power: () => ({ active: false, onBattery: false, idleMs: 0, overridden: false })
      }),
      signals: {
        subscribeControls: () => () => undefined,
        subscribePower: () => () => undefined,
        refreshControls: async () => undefined
      },
      wake: vi.fn(),
      logger
    });
    await expect(failing.regate()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const none = new BlockerService({
      store: () => null,
      gate: new BackgroundGate({
        controls: () => defaultKnowledgeControls,
        power: () => ({ active: false, onBattery: false, idleMs: 0, overridden: false })
      }),
      signals: {
        subscribeControls: () => () => undefined,
        subscribePower: () => () => undefined,
        refreshControls: async () => undefined
      },
      wake: vi.fn()
    });
    await expect(none.notify("day_rollover")).resolves.toBeUndefined();
    expect(
      await none.blockTask(
        { id: "x", dedupeKey: null } as JobRecord,
        gardenerBlocker("paused", "user_pause")
      )
    ).toBe(false);
  });

  it("reads the added gates again before the startup re-gate and on every tick", async () => {
    const logger = { warn: vi.fn() };
    const order: string[] = [];
    const refreshGates = vi
      .fn(async () => {
        order.push("refresh");
      })
      .mockRejectedValueOnce(new Error("budget unreadable"));
    const service = new BlockerService({
      store: () => ({
        stampGateBlocks: async () => {
          order.push("stamp");
          return 0;
        },
        clearBlocks: async () => ({ cleared: 0, types: [] }),
        blockTask: async () => false
      }),
      gate: new BackgroundGate({
        controls: () => defaultKnowledgeControls,
        power: () => ({ active: false, onBattery: false, idleMs: 0, overridden: false })
      }),
      signals: {
        subscribeControls: () => () => undefined,
        subscribePower: () => () => undefined,
        refreshControls: async () => undefined
      },
      wake: vi.fn(),
      refreshGates,
      logger
    });
    // A gate that cannot read its state keeps its last answer; the re-gate still runs.
    await expect(service.regate()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "A background gate could not read its state",
      expect.any(Error)
    );
    order.length = 0;
    await service.tick();
    expect(refreshGates).toHaveBeenCalledTimes(2);
    // The gates answer the tick's re-gate from what they just read.
    expect(order).toEqual(["refresh", "stamp"]);
  });
});
