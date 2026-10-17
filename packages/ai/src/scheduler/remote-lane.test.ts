import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveDeadline } from "../active-deadline.js";
import { AiProviderError } from "../provider-error.js";
import { resolveAiRuntimeConfig, runRemoteCall, type RemoteAttempt } from "../remote-execution.js";
import { resolveAiLaneRuntimeConfig, type AiLaneRuntimeConfigInput } from "../runtime-config.js";
import { bindLanePermit } from "./execution.js";
import { createAiScheduler } from "./scheduler.js";
import type { AiScheduler, LanePermit, LaneTicket, SchedulerClock } from "./types.js";

/** The scheduler on the faked wall clock, so it shares time with the deadlines and backoffs. */
const fakedClock: SchedulerClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

function scheduler(config: AiLaneRuntimeConfigInput = {}): AiScheduler {
  return createAiScheduler(resolveAiLaneRuntimeConfig(config, { environment: {} }), fakedClock);
}

const codexTicket = (extra: Partial<LaneTicket> = {}): LaneTicket => ({
  lane: "remote:codex",
  remoteKind: "codex",
  priority: "P2",
  workloadClass: "decide",
  label: "call",
  ...extra
});

const busy = () => new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
const rateLimited = (retryAfterMs: number) =>
  new AiProviderError("slow down", { kind: "http", transient: true, status: 429, retryAfterMs });
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Runs `attempt` through the remote retry loop on a scheduled lane, as an adapter would. */
function remoteCall(
  lanes: AiScheduler,
  ticket: LaneTicket,
  attempt: (call: RemoteAttempt) => Promise<string>,
  observe?: (permit: LanePermit) => void
) {
  return lanes.run(ticket, async (permit) => {
    const signal = AbortSignal.any(ticket.signal ? [ticket.signal] : []);
    bindLanePermit(signal, permit);
    try {
      return await runRemoteCall(
        { config: resolveAiRuntimeConfig(), random: () => 0.5 },
        { streaming: false, taskType: "reranking", workloadClass: "decide", signal },
        attempt
      );
    } finally {
      observe?.(permit);
    }
  });
}

/** A long call that holds a lane slot for `milliseconds`. */
function longCall(lanes: AiScheduler, milliseconds: number, label: string, log: string[]) {
  return lanes.run(codexTicket({ workloadClass: "write-quality", label }), async () => {
    log.push(`${label} started ${Date.now()}`);
    await wait(milliseconds);
    log.push(`${label} ended ${Date.now()}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("remote calls on scheduler lanes", () => {
  it("re-waits for a full Codex lane with its deadline paused and still makes its retry (S5, S6)", async () => {
    const lanes = scheduler();
    const log: string[] = [];
    let attempts = 0;
    let permitSeen: LanePermit | undefined;
    // An Ask-like caller timeout that must not run while the call waits for its lane again.
    const caller = new ActiveDeadline(60_000);
    const decide = remoteCall(
      lanes,
      codexTicket({ pauses: [caller], signal: caller.signal }),
      async () => {
        attempts += 1;
        log.push(`decide attempt ${attempts} ${Date.now()}`);
        await wait(1_000);
        if (attempts === 1) throw busy();
        return "decided";
      },
      (permit) => {
        permitSeen = permit;
      }
    );
    const first = longCall(lanes, 300_000, "write 1", log);
    const second = longCall(lanes, 300_000, "write 2", log);
    // Attempt 1 fails at 1 s; the backoff releases the slot and the second write takes it.
    await vi.advanceTimersByTimeAsync(301_500);
    await expect(decide).resolves.toBe("decided");
    await Promise.all([first, second]);
    expect(log).toEqual([
      "decide attempt 1 0",
      "write 1 started 0",
      "write 2 started 1000",
      "write 1 ended 300000",
      "decide attempt 2 300000",
      "write 2 ended 301000"
    ]);
    // The 45 s decide deadline and the 60 s caller timeout counted only the active time.
    expect(caller.signal.aborted).toBe(false);
    expect(caller.elapsedMs).toBeLessThan(5_000);
    expect(permitSeen!.releasedMs).toBe(250);
    expect(permitSeen!.requeueMs).toBe(298_750);
    caller.dispose();
  });

  it("halves the lane within one response of a 429, pauses it until the stated reset and retries", async () => {
    const lanes = scheduler();
    const ticket = {
      ...codexTicket(),
      lane: "remote:key" as const,
      remoteKind: "api-key" as const
    };
    let attempts = 0;
    const call = remoteCall(lanes, ticket, async () => {
      attempts += 1;
      if (attempts === 1) throw rateLimited(2_000);
      return "ok";
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(lanes.snapshot()[0]).toMatchObject({ lane: "remote:key", limit: 2 });
    expect(lanes.snapshot()[0]!.pausedForMs).toBeGreaterThan(1_900);
    const blocked = vi.fn(async () => "later");
    const other = lanes.run({ ...ticket, priority: "P0" }, blocked);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(blocked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(call).resolves.toBe("ok");
    await expect(other).resolves.toBe("later");
    expect(attempts).toBe(2);
  });

  it("lets another call use the lane while a call sleeps for its retry, within the attempt budget", async () => {
    const lanes = scheduler({ mode: "serial" });
    const log: string[] = [];
    let attempts = 0;
    const failing = remoteCall(lanes, codexTicket(), async () => {
      attempts += 1;
      log.push(`attempt ${attempts}`);
      throw busy();
    });
    const failed = expect(failing).rejects.toMatchObject({ status: 503 });
    const quick = lanes.run(codexTicket({ label: "quick" }), async () => {
      log.push("quick");
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    await quick;
    expect(attempts).toBe(3);
    expect(log.slice(0, 2)).toEqual(["attempt 1", "quick"]);
    expect(lanes.snapshot()[0]).toMatchObject({ running: 0 });
  });

  it("opens the lane's breaker on five transient attempts in a row, fails the next call fast, then recovers through one probe (D32)", async () => {
    const lanes = scheduler();
    const down = () =>
      remoteCall(lanes, codexTicket(), async () => {
        throw busy();
      });
    // Two calls of three attempts each: the fifth failed attempt opens the breaker.
    const calls = [down(), down()].map((call) =>
      expect(call).rejects.toMatchObject({ status: 503 })
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all(calls);
    expect(lanes.snapshot()[0]!.breaker).toMatchObject({ state: "open", opened: 1 });
    const attempt = vi.fn(async () => "never");
    await expect(remoteCall(lanes, codexTicket(), attempt)).rejects.toMatchObject({
      message: "errors.ai.providerUnavailable",
      transient: true
    });
    expect(attempt).not.toHaveBeenCalled();
    // Once the period is over a single call probes; its answer closes the breaker.
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(remoteCall(lanes, codexTicket(), async () => "back")).resolves.toBe("back");
    expect(lanes.snapshot()[0]!.breaker).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("reports successes to the lane, which grows back after 20 of them", async () => {
    const lanes = scheduler();
    const ticket = {
      ...codexTicket(),
      lane: "remote:key" as const,
      remoteKind: "api-key" as const
    };
    await lanes.run(ticket, async () => "first");
    lanes.observeRateLimit("remote:key", null);
    lanes.observeRateLimit("remote:key", null);
    expect(lanes.snapshot()[0]!.limit).toBe(1);
    for (let n = 0; n < 20; n++) await remoteCall(lanes, ticket, async () => "ok");
    expect(lanes.snapshot()[0]).toMatchObject({ limit: 2, successStreak: 0 });
  });
});
