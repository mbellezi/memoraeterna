import { describe, expect, it, vi } from "vitest";

import { resolveAiLaneRuntimeConfig, type AiLaneRuntimeConfigInput } from "../runtime-config.js";
import { aimdOnOutcome, aimdOnRateLimit, initialAimd } from "./aimd.js";
import {
  executionLane,
  isRemoteExecution,
  laneMaximum,
  providerTreatedAsRemote,
  treatAsRemoteHonoured
} from "./lanes.js";
import { effectiveRank, priorityNumber, selectNext } from "./priority.js";
import { createAiScheduler } from "./scheduler.js";
import { fakeSchedulerClock, flush } from "./test-clock.js";
import type { AiPriority, AiScheduler, LaneKey, LanePermit, LaneTicket } from "./types.js";

function setup(config: AiLaneRuntimeConfigInput = {}) {
  const time = fakeSchedulerClock();
  const scheduler = createAiScheduler(
    resolveAiLaneRuntimeConfig(config, { environment: {} }),
    time.clock
  );
  return { scheduler, ...time };
}

function ticket(
  lane: LaneKey,
  priority: AiPriority = "P2",
  extra: Partial<LaneTicket> = {}
): LaneTicket {
  return {
    lane,
    priority,
    workloadClass: "write-fast",
    label: `${lane} ${priority}`,
    ...(lane.startsWith("remote:") ? { remoteKind: "api-key" as const } : {}),
    ...extra
  };
}

/** An execution the test ends by hand, recording when it started. */
function controlled(scheduler: AiScheduler, t: LaneTicket, name: string, log: string[]) {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<LanePermit>();
  const result = scheduler.run(t, async (permit) => {
    log.push(name);
    started.resolve(permit);
    await gate.promise;
    return name;
  });
  return { result, started: started.promise, finish: () => gate.resolve() };
}

/** Occupies the local lane with a running call. */
async function occupy(scheduler: AiScheduler, lane: LaneKey = "local") {
  const log: string[] = [];
  const call = controlled(scheduler, ticket(lane, "P2"), "running", log);
  await call.started;
  return call;
}

describe("lane scheduler: behaviours of the single queue it replaces", () => {
  it("runs a lane's calls in FIFO order with only one active execution on the local lane", async () => {
    const { scheduler } = setup();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const order: number[] = [];
    let active = 0,
      maximum = 0;
    const results = [1, 2, 3].map((id) =>
      scheduler.run(ticket("local"), async () => {
        order.push(id);
        active++;
        maximum = Math.max(maximum, active);
        if (id === 1) {
          started.resolve();
          await gate.promise;
        }
        active--;
        return id;
      })
    );
    await started.promise;
    expect(order).toEqual([1]);
    gate.resolve();
    expect(await Promise.all(results)).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(maximum).toBe(1);
  });

  it("reports the wait between admission and the start of execution", async () => {
    const { scheduler, advance } = setup();
    const gate = Promise.withResolvers<void>();
    const waits: number[] = [];
    const first = scheduler.run(ticket("local"), async ({ queueMs }) => {
      waits.push(queueMs);
      await gate.promise;
    });
    await advance(40);
    const second = scheduler.run(ticket("local"), async ({ queueMs }) => {
      waits.push(queueMs);
    });
    await advance(210);
    const third = scheduler.run(ticket("local"), async ({ queueMs }) => {
      waits.push(queueMs);
    });
    await advance(750.6);
    gate.resolve();
    await Promise.all([first, second, third]);
    expect(waits).toEqual([0, 961, 751]);
  });

  it("cancels waiting work promptly without invoking it or releasing the active slot", async () => {
    const { scheduler } = setup();
    const running = await occupy(scheduler);
    const controller = new AbortController();
    const canceled = vi.fn(async () => 2),
      next = vi.fn(async () => 3);
    const second = scheduler.run(ticket("local", "P2", { signal: controller.signal }), canceled);
    const rejected = expect(second).rejects.toThrow("cancel waiting");
    const third = scheduler.run(ticket("local"), next);
    controller.abort(new Error("cancel waiting"));
    await rejected;
    expect(canceled).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    running.finish();
    await running.result;
    expect(await third).toBe(3);
    expect(canceled).not.toHaveBeenCalled();
  });

  it("waits for a cancelled running call to settle before starting another one", async () => {
    const { scheduler } = setup();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>(),
      stopped = Promise.withResolvers<void>();
    const first = scheduler.run(ticket("local", "P2", { signal: controller.signal }), async () => {
      started.resolve();
      await stopped.promise;
      controller.signal.throwIfAborted();
    });
    const rejected = expect(first).rejects.toThrow("cancel active");
    await started.promise;
    const next = vi.fn(async () => 2),
      second = scheduler.run(ticket("local"), next);
    controller.abort(new Error("cancel active"));
    await flush();
    expect(next).not.toHaveBeenCalled();
    stopped.resolve();
    await rejected;
    expect(await second).toBe(2);
  });

  it("continues after synchronous failures and rejects already cancelled requests", async () => {
    const { scheduler } = setup();
    const first = scheduler.run(ticket("local"), () => {
      throw new Error("failed");
    });
    const second = scheduler.run(ticket("local"), async () => 2);
    await expect(first).rejects.toThrow("failed");
    expect(await second).toBe(2);
    const execute = vi.fn(async () => 3);
    await expect(
      scheduler.run(
        ticket("local", "P2", { signal: AbortSignal.abort(new Error("already canceled")) }),
        execute
      )
    ).rejects.toThrow("already canceled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("admits P0 work before every waiting background call, first come first served", async () => {
    const { scheduler } = setup();
    const running = await occupy(scheduler);
    const order: string[] = [];
    const call = (name: string, priority: AiPriority) =>
      scheduler.run(ticket("local", priority), async () => void order.push(name));
    const calls = [
      call("background 1", "P2"),
      call("background 2", "P2"),
      call("interactive 1", "P0"),
      call("interactive 2", "P0"),
      call("background 3", "P2")
    ];
    running.finish();
    await Promise.all([running.result, ...calls]);
    expect(order).toEqual([
      "interactive 1",
      "interactive 2",
      "background 1",
      "background 2",
      "background 3"
    ]);
  });

  it("never preempts a running call, so P0 work waits for at most that one", async () => {
    const { scheduler } = setup();
    const running = await occupy(scheduler);
    const order: string[] = [];
    const interactive = scheduler.run(ticket("local", "P0"), async () => void order.push("P0"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);
    running.finish();
    await Promise.all([running.result, interactive]);
    expect(order).toEqual(["P0"]);
  });

  it("lets admissions of the same tick compete by priority when the lane is idle", async () => {
    const { scheduler } = setup();
    const order: string[] = [];
    await Promise.all([
      scheduler.run(ticket("local", "P3"), async () => void order.push("P3")),
      scheduler.run(ticket("local", "P2"), async () => void order.push("P2")),
      scheduler.run(ticket("local", "P0"), async () => void order.push("P0"))
    ]);
    expect(order).toEqual(["P0", "P2", "P3"]);
  });

  it("reports the wait of a call that was served before older background work", async () => {
    const { scheduler, advance } = setup();
    const running = await occupy(scheduler);
    const waits: Record<string, number> = {};
    const background = scheduler.run(
      ticket("local", "P2"),
      async ({ queueMs }) => void (waits.background = queueMs)
    );
    await advance(500);
    const interactive = scheduler.run(
      ticket("local", "P0"),
      async ({ queueMs }) => void (waits.interactive = queueMs)
    );
    await advance(1_500);
    running.finish();
    await Promise.all([running.result, background, interactive]);
    expect(waits).toEqual({ interactive: 1_500, background: 2_000 });
  });

  it("cancels a waiting P0 call without disturbing the others and shows the lane in snapshots", async () => {
    const { scheduler } = setup();
    const running = await occupy(scheduler);
    const controller = new AbortController();
    const canceled = vi.fn(async () => 1);
    const rejected = expect(
      scheduler.run(ticket("local", "P0", { signal: controller.signal }), canceled)
    ).rejects.toThrow("changed my mind");
    const background = scheduler.run(ticket("local", "P2"), async () => 2);
    await flush();
    expect(scheduler.snapshot()).toEqual([
      expect.objectContaining({
        lane: "local",
        limit: 1,
        running: 1,
        waiting: { P0: 1, P1: 0, P2: 1, P3: 0 }
      })
    ]);
    controller.abort(new Error("changed my mind"));
    await rejected;
    expect(scheduler.snapshot()[0]!.waiting).toEqual({ P0: 0, P1: 0, P2: 1, P3: 0 });
    running.finish();
    await running.result;
    expect(await background).toBe(2);
    expect(canceled).not.toHaveBeenCalled();
    await flush();
    expect(scheduler.snapshot()[0]).toMatchObject({ running: 0, waiting: { P2: 0 } });
  });
});

describe("lane scheduler: lanes, limits and adaptation", () => {
  it("runs a remote call while the local lane is busy (lanes are independent)", async () => {
    const { scheduler } = setup();
    const local = await occupy(scheduler);
    const remote = vi.fn(async () => "remote");
    await expect(scheduler.run(ticket("remote:codex-1", "P0"), remote)).resolves.toBe("remote");
    local.finish();
    await local.result;
  });

  it("starts API-key lanes at 4 and Codex lanes at 2 concurrent calls", async () => {
    const { scheduler } = setup();
    const log: string[] = [];
    const apiKey = [1, 2, 3, 4, 5].map((n) =>
      controlled(scheduler, ticket("remote:key", "P2", { remoteKind: "api-key" }), `key ${n}`, log)
    );
    const codex = [1, 2, 3].map((n) =>
      controlled(
        scheduler,
        ticket("remote:codex", "P2", { remoteKind: "codex" }),
        `codex ${n}`,
        log
      )
    );
    await flush();
    expect(log.sort()).toEqual(["codex 1", "codex 2", "key 1", "key 2", "key 3", "key 4"]);
    expect(scheduler.snapshot().map((lane) => [lane.lane, lane.limit, lane.running])).toEqual([
      ["remote:key", 4, 4],
      ["remote:codex", 2, 2]
    ]);
    for (const call of [...apiKey, ...codex]) call.finish();
    await Promise.all([...apiKey, ...codex].map((call) => call.result));
  });

  it("runs every lane at one call in serial mode", async () => {
    const { scheduler } = setup({ mode: "serial" });
    const log: string[] = [];
    const calls = [1, 2].map((n) =>
      controlled(scheduler, ticket("remote:key", "P2", { remoteKind: "api-key" }), `key ${n}`, log)
    );
    const local = controlled(scheduler, ticket("local"), "local", log);
    await flush();
    // One call per lane, and the lanes still do not wait for each other.
    expect(log.sort()).toEqual(["key 1", "local"]);
    calls[0]!.finish();
    await calls[0]!.result;
    await flush();
    expect(log).toContain("key 2");
    calls[1]!.finish();
    local.finish();
    await Promise.all([calls[1]!.result, local.result]);
  });

  it("halves a remote lane on a rate limit, pauses it until the reset and grows it after 20 successes", async () => {
    const { scheduler, advance } = setup();
    const lane = "remote:key";
    const log: string[] = [];
    const first = controlled(scheduler, ticket(lane), "first", log);
    const permit = await first.started;
    permit.observeRateLimit(3_000);
    expect(scheduler.snapshot()[0]).toMatchObject({ limit: 2, pausedForMs: 3_000 });
    const waiting = [1, 2, 3].map((n) => controlled(scheduler, ticket(lane), `next ${n}`, log));
    await advance(2_999);
    expect(log).toEqual(["first"]);
    await advance(1);
    // The reset passed: the lane runs again, at its halved limit (the first call still runs).
    expect(log).toEqual(["first", "next 1"]);
    first.finish();
    await first.result;
    await flush();
    expect(log).toEqual(["first", "next 1", "next 2"]);
    for (let n = 0; n < 19; n++) scheduler.observeOutcome(lane, "ok");
    expect(scheduler.snapshot()[0]).toMatchObject({ limit: 2, successStreak: 19 });
    scheduler.observeOutcome(lane, "ok");
    await flush();
    expect(scheduler.snapshot()[0]).toMatchObject({ limit: 3, successStreak: 0 });
    expect(log).toEqual(["first", "next 1", "next 2", "next 3"]);
    for (const call of waiting) call.finish();
    await Promise.all(waiting.map((call) => call.result));
  });

  it("never pauses a lane longer than the configured maximum and leaves other lanes alone (S10)", async () => {
    const { scheduler, advance } = setup({ lanes: { maxPauseMs: 1_000 } });
    const log: string[] = [];
    const first = controlled(scheduler, ticket("remote:a"), "a1", log);
    await first.started;
    scheduler.observeRateLimit("remote:a", 3_600_000);
    const blocked = controlled(scheduler, ticket("remote:a", "P0"), "a2", log);
    const other = controlled(scheduler, ticket("remote:b"), "b1", log);
    const local = controlled(scheduler, ticket("local"), "local", log);
    await flush();
    expect(log).toEqual(["a1", "b1", "local"]);
    await advance(1_000);
    expect(log).toEqual(["a1", "b1", "local", "a2"]);
    for (const call of [first, blocked, other, local]) call.finish();
    await Promise.all([first, blocked, other, local].map((call) => call.result));
  });

  it("resumes a paused lane when its timer fires before the reset on the scheduler clock", async () => {
    const time = fakeSchedulerClock({ earlyTimersMs: 1 });
    const scheduler = createAiScheduler(
      resolveAiLaneRuntimeConfig({}, { environment: {} }),
      time.clock
    );
    const lane = "remote:key";
    const log: string[] = [];
    const first = controlled(scheduler, ticket(lane), "first", log);
    (await first.started).observeRateLimit(3_000);
    first.finish();
    await first.result;
    const next = controlled(scheduler, ticket(lane, "P0"), "next", log);
    // The pause timer fires at 2,999 ms, short of the reset: the lane stays paused until 3,000.
    await time.advance(2_999);
    expect(log).toEqual(["first"]);
    await time.advance(1);
    expect(log).toEqual(["first", "next"]);
    expect(scheduler.snapshot()[0]).toMatchObject({ running: 1, pausedForMs: null });
    next.finish();
    await next.result;
  });

  it("lets a retried attempt back onto its lane when its backoff and the pause both end early", async () => {
    const time = fakeSchedulerClock({ earlyTimersMs: 1 });
    const scheduler = createAiScheduler(
      resolveAiLaneRuntimeConfig({}, { environment: {} }),
      time.clock
    );
    let settled = false;
    // A 429 with Retry-After 600 ms whose backoff sleeps exactly the stated wait.
    const retried = scheduler.run(ticket("remote:key", "P0"), async (permit) => {
      permit.observeRateLimit(600);
      await permit.releaseDuring(
        () => new Promise<void>((resolve) => time.clock.setTimer(resolve, 600))
      );
      return "retried";
    });
    void retried.then(() => (settled = true));
    await time.advance(5_000);
    expect(settled).toBe(true);
    await expect(retried).resolves.toBe("retried");
    expect(scheduler.snapshot()[0]).toMatchObject({ running: 0, pausedForMs: null });
  });

  it("keeps the local lane at one call whatever the rate-limit signals", async () => {
    const { scheduler } = setup();
    scheduler.observeRateLimit("local", null);
    for (let n = 0; n < 40; n++) scheduler.observeOutcome("local", "ok");
    const running = await occupy(scheduler);
    expect(scheduler.snapshot()[0]).toMatchObject({ lane: "local", limit: 1, maximum: 1 });
    running.finish();
    await running.result;
  });

  it("classifies execution targets into lanes", () => {
    const base = { localModelId: null, providerConfigId: "p-1", baseUrl: null };
    expect(executionLane({ ...base, localModelId: "m-1", provider: "local" })).toEqual({
      lane: "local"
    });
    expect(executionLane({ ...base, provider: "openai-codex" })).toEqual({
      lane: "remote:p-1",
      remoteKind: "codex"
    });
    expect(executionLane({ ...base, provider: "google" })).toEqual({
      lane: "remote:p-1",
      remoteKind: "api-key"
    });
    // Ollama or LM Studio on this machine share the machine with the local runtimes.
    expect(executionLane({ ...base, provider: "openai-compatible" }).lane).toBe("local");
    expect(
      executionLane({
        ...base,
        provider: "openai-compatible",
        baseUrl: "http://192.168.1.4:1234/v1"
      }).lane
    ).toBe("local");
    expect(
      isRemoteExecution({ ...base, provider: "openai-compatible", baseUrl: "https://api.x.ai/v1" })
    ).toBe(true);
    const product = resolveAiLaneRuntimeConfig({}, { environment: {} });
    expect(laneMaximum("remote:p-1", "codex", product)).toBe(2);
    expect(laneMaximum("remote:p-1", "api-key", product)).toBe(4);
    expect(laneMaximum("local", "api-key", product)).toBe(1);
    expect(laneMaximum("remote:p-1", "api-key", { ...product, mode: "serial" })).toBe(1);
  });

  it("puts a loopback fake in a remote lane only when treatAsRemote is honoured (R6)", () => {
    const loopback = {
      localModelId: null,
      providerConfigId: "fake-1",
      baseUrl: "http://127.0.0.1:41000/v1"
    };
    const metadata = { treatAsRemote: true };
    // Honoured: the fake leaves the local lane, whatever its address.
    const honoured = providerTreatedAsRemote(metadata, true);
    expect(
      executionLane({ ...loopback, provider: "openai-compatible", treatAsRemote: honoured })
    ).toEqual({ lane: "remote:fake-1", remoteKind: "api-key" });
    expect(
      executionLane({ ...loopback, provider: "openai-codex", treatAsRemote: honoured })
    ).toEqual({ lane: "remote:fake-1", remoteKind: "codex" });
    // Not honoured (no knob, or packaged): the flag is ignored and the loopback endpoint is local.
    const ignored = providerTreatedAsRemote(metadata, false);
    expect(ignored).toBe(false);
    expect(
      executionLane({ ...loopback, provider: "openai-compatible", treatAsRemote: ignored }).lane
    ).toBe("local");
    // Only a literal true counts, and a local runtime stays local either way.
    expect(providerTreatedAsRemote({ treatAsRemote: "yes" }, true)).toBe(false);
    expect(providerTreatedAsRemote(undefined, true)).toBe(false);
    expect(
      isRemoteExecution({
        ...loopback,
        localModelId: "m-1",
        provider: "local",
        treatAsRemote: true
      })
    ).toBe(false);
  });

  it("honours treatAsRemote only unpackaged and under MEMORA_FAKE_REMOTE (R6)", () => {
    const env = { MEMORA_FAKE_REMOTE: "scripts/soak/plan.json" };
    expect(treatAsRemoteHonoured(env, { isPackaged: false })).toBe(true);
    expect(treatAsRemoteHonoured(env, { isPackaged: true })).toBe(false);
    expect(treatAsRemoteHonoured({}, { isPackaged: false })).toBe(false);
    expect(treatAsRemoteHonoured({ MEMORA_FAKE_REMOTE: "  " }, { isPackaged: false })).toBe(false);
  });

  it("adapts limits additively up and multiplicatively down, within the minimum and maximum", () => {
    const config = { minimum: 1, increaseAfterSuccesses: 20, decreaseFactor: 0.5 };
    let state = initialAimd(4);
    state = aimdOnRateLimit(state, config);
    expect(state.limit).toBe(2);
    state = aimdOnRateLimit(aimdOnRateLimit(state, config), config);
    expect(state.limit).toBe(1);
    for (let n = 0; n < 19; n++) state = aimdOnOutcome(state, "ok", config);
    state = aimdOnOutcome(state, "permanent", config);
    expect(state).toMatchObject({ limit: 1, streak: 19 });
    state = aimdOnOutcome(state, "transient", config);
    expect(state.streak).toBe(0);
    for (let n = 0; n < 100; n++) state = aimdOnOutcome(state, "ok", config);
    expect(state.limit).toBe(4);
  });
});

describe("lane scheduler: priorities and aging", () => {
  const aging = { p3ToP2Ms: 60_000, p2ToP1Ms: 120_000 };

  it("ages P3 into P2 after 60 s and into P1 after 180 s, P2 into P1 after 120 s, never into P0 (S4)", () => {
    expect(effectiveRank("P3", 59_999, aging)).toBe(3);
    expect(effectiveRank("P3", 60_000, aging)).toBe(2);
    expect(effectiveRank("P3", 179_999, aging)).toBe(2);
    expect(effectiveRank("P3", 180_000, aging)).toBe(1);
    expect(effectiveRank("P2", 119_999, aging)).toBe(2);
    expect(effectiveRank("P2", 120_000, aging)).toBe(1);
    expect(effectiveRank("P1", 10_000_000, aging)).toBe(1);
    expect(effectiveRank("P0", 0, aging)).toBe(0);
    expect(["P0", "P1", "P2", "P3"].map((p) => priorityNumber(p as AiPriority))).toEqual([
      0, 1, 2, 3
    ]);
  });

  it("selects FIFO within an effective priority, the aged entry before younger ones", () => {
    const waiting = [
      { priority: "P2" as const, admittedAt: 50_000, sequence: 2 },
      { priority: "P3" as const, admittedAt: 0, sequence: 1 },
      { priority: "P2" as const, admittedAt: 59_000, sequence: 3 }
    ];
    expect(selectNext(waiting, 59_000, aging)).toBe(0);
    // At 60 s the P3 entry competes as P2 and is the oldest P2.
    expect(selectNext(waiting, 60_000, aging)).toBe(1);
    expect(selectNext([], 0, aging)).toBe(-1);
  });

  it("starts a P3 entry within 60 s plus one call under a steady P2 stream", async () => {
    const { scheduler, advance, now } = setup();
    const callMs = 1_000;
    const log: string[] = [];
    const calls = [controlled(scheduler, ticket("local", "P2"), "p2 0", log)];
    await calls[0]!.started;
    let p3StartedAt: number | null = null;
    const p3 = scheduler.run(ticket("local", "P3"), async () => {
      p3StartedAt = now();
    });
    // A new P2 call every second and each one second long: a P2 entry always waits.
    for (let second = 1; p3StartedAt === null && second <= 200; second++) {
      calls.push(controlled(scheduler, ticket("local", "P2"), `p2 ${second}`, log));
      await advance(callMs);
      calls.shift()!.finish();
      await flush();
    }
    await p3;
    expect(p3StartedAt).not.toBeNull();
    expect(p3StartedAt!).toBeGreaterThanOrEqual(60_000);
    expect(p3StartedAt!).toBeLessThanOrEqual(60_000 + callMs);
    for (const call of calls) call.finish();
    await Promise.all(calls.map((call) => call.result));
  });

  it("gives a P0 entry the first free slot of a full remote lane (S3)", async () => {
    const { scheduler } = setup();
    const log: string[] = [];
    const running = [1, 2].map((n) =>
      controlled(scheduler, ticket("remote:c", "P2", { remoteKind: "codex" }), `bg ${n}`, log)
    );
    await flush();
    const queued = controlled(
      scheduler,
      ticket("remote:c", "P2", { remoteKind: "codex" }),
      "bg 3",
      log
    );
    const interactive = controlled(
      scheduler,
      ticket("remote:c", "P0", { remoteKind: "codex" }),
      "ask",
      log
    );
    await flush();
    running[1]!.finish();
    await running[1]!.result;
    await flush();
    expect(log).toEqual(["bg 1", "bg 2", "ask"]);
    for (const call of [running[0]!, queued, interactive]) call.finish();
    await Promise.all([running[0]!, queued, interactive].map((call) => call.result));
  });
});

describe("lane scheduler: permits", () => {
  it("lets another call run while a call sleeps for a retry, then keeps the sleeper's age (S6)", async () => {
    const { scheduler, advance } = setup();
    const order: string[] = [];
    const backoff = Promise.withResolvers<void>();
    const sleeper = scheduler.run(ticket("local", "P2"), async (permit) => {
      order.push("attempt 1");
      await permit.releaseDuring(() => backoff.promise);
      order.push("attempt 2");
      return { requeueMs: permit.requeueMs, releasedMs: permit.releasedMs };
    });
    await flush();
    const later = controlled(scheduler, ticket("local", "P2"), "later", order);
    await flush();
    // The sleeper gave the slot up, so a call admitted after it runs during the backoff.
    expect(order).toEqual(["attempt 1", "later"]);
    await advance(500);
    backoff.resolve();
    await flush();
    // Waiting again behind the running call; a younger entry does not overtake it.
    const youngest = controlled(scheduler, ticket("local", "P2"), "youngest", order);
    await advance(2_000);
    later.finish();
    await later.result;
    const waits = await sleeper;
    expect(order).toEqual(["attempt 1", "later", "attempt 2"]);
    expect(waits).toEqual({ releasedMs: 500, requeueMs: 2_000 });
    await flush();
    expect(order.at(-1)).toBe("youngest");
    youngest.finish();
    await youngest.result;
  });

  it("stops the ticket's clocks while it waits, also when it waits again after a backoff", async () => {
    const { scheduler } = setup();
    const running = await occupy(scheduler);
    const clock = { pause: vi.fn(), resume: vi.fn() };
    const waiting = scheduler.run(ticket("local", "P0", { pauses: [clock] }), async (permit) => {
      expect(clock.pause).toHaveBeenCalledTimes(1);
      expect(clock.resume).toHaveBeenCalledTimes(1);
      const extra = { pause: vi.fn(), resume: vi.fn() };
      await permit.releaseDuring(async () => "slept", { pause: [extra] });
      expect(extra.pause).toHaveBeenCalledTimes(1);
      expect(extra.resume).toHaveBeenCalledTimes(1);
      return "done";
    });
    await flush();
    expect(clock.pause).toHaveBeenCalledTimes(1);
    expect(clock.resume).not.toHaveBeenCalled();
    running.finish();
    await expect(waiting).resolves.toBe("done");
    expect(clock.pause).toHaveBeenCalledTimes(2);
    expect(clock.resume).toHaveBeenCalledTimes(2);
  });

  it("holds the slot after the execution settled until its hold settles", async () => {
    const { scheduler } = setup();
    const recovery = Promise.withResolvers<void>();
    const failed = scheduler.run(ticket("local"), async (permit) => {
      permit.holdUntil(recovery.promise);
      throw new Error("wedged");
    });
    await expect(failed).rejects.toThrow("wedged");
    const next = vi.fn(async () => "next");
    const queued = scheduler.run(ticket("local", "P0"), next);
    await flush();
    expect(next).not.toHaveBeenCalled();
    expect(scheduler.snapshot()[0]).toMatchObject({ running: 1, held: 1 });
    recovery.resolve();
    await expect(queued).resolves.toBe("next");
  });

  it("fails the waiting and new entries of a lane while a refusing hold lasts, and no other lane's (C11)", async () => {
    const { scheduler } = setup();
    const recovery = Promise.withResolvers<void>();
    const log: string[] = [];
    const wedging = controlled(scheduler, ticket("local"), "wedging", log);
    const permit = await wedging.started;
    const clock = { pause: vi.fn(), resume: vi.fn() };
    const waiting = scheduler
      .run(ticket("local", "P0", { pauses: [clock] }), async () => "never")
      .catch((error: unknown) => error);
    permit.holdUntil(recovery.promise, {
      refuse: (entry) => new Error(`refused ${entry.priority} ${entry.workloadClass}`)
    });
    // The execution still runs: the lane refuses once it settled and its slot is held.
    await flush();
    expect(scheduler.snapshot()[0]).toMatchObject({ waiting: { P0: 1 } });
    expect(clock.pause).toHaveBeenCalledTimes(1);
    wedging.finish();
    await wedging.result;
    expect(((await waiting) as Error).message).toBe("refused P0 write-fast");
    expect(clock.resume).toHaveBeenCalledTimes(1);
    const later = vi.fn(async () => "later");
    await expect(
      scheduler.run(ticket("local", "P3", { workloadClass: "decide" }), later)
    ).rejects.toThrow("refused P3 decide");
    await expect(scheduler.run(ticket("remote:key"), async () => "remote")).resolves.toBe("remote");
    expect(scheduler.snapshot()[0]).toMatchObject({
      lane: "local",
      running: 1,
      held: 1,
      waiting: { P0: 0, P1: 0, P2: 0, P3: 0 }
    });
    expect(later).not.toHaveBeenCalled();
    // The runtime recovered: the lane takes calls again.
    recovery.resolve();
    await flush();
    await expect(scheduler.run(ticket("local"), later)).resolves.toBe("later");
    expect(scheduler.snapshot()[0]).toMatchObject({ running: 0, held: 0 });
  });

  it("frees the slot before the caller continues, so telemetry runs off the lane", async () => {
    const { scheduler } = setup();
    const result = await scheduler.run(ticket("local"), async () => "value");
    expect(result).toBe("value");
    expect(scheduler.snapshot()[0]).toMatchObject({ running: 0 });
  });
});
