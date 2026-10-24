import { describe, expect, it, vi } from "vitest";

import { resolveAiLaneRuntimeConfig, type AiLaneRuntimeConfigInput } from "../runtime-config.js";
import { ProviderUnavailableError, type BreakerTransition } from "./breaker.js";
import { createAiScheduler } from "./scheduler.js";
import { fakeSchedulerClock, flush } from "./test-clock.js";
import type { AiPriority, AiScheduler, LaneKey, LanePermit, LaneTicket } from "./types.js";

/**
 * The circuit breaker on scheduler lanes (F3 D32, T47b): a remote lane's calls report their
 * outcomes through the permit, as `runRemoteCall` does, and the lane fails new entries fast once
 * five transient failures in a row say the provider is down.
 */

const codex = "remote:codex";
const other = "remote:other";

function setup(config: AiLaneRuntimeConfigInput = {}) {
  const time = fakeSchedulerClock();
  const transitions: Array<[LaneKey, BreakerTransition]> = [];
  const scheduler = createAiScheduler(
    resolveAiLaneRuntimeConfig(config, { environment: {} }),
    time.clock,
    { onBreakerTransition: (lane, transition) => transitions.push([lane, transition]) }
  );
  return { scheduler, transitions, ...time };
}

function ticket(
  lane: LaneKey,
  priority: AiPriority = "P2",
  extra: Partial<LaneTicket> = {}
): LaneTicket {
  return {
    lane,
    priority,
    workloadClass: "decide",
    label: `${lane} ${priority}`,
    ...(lane.startsWith("remote:")
      ? { remoteKind: lane === codex ? ("codex" as const) : ("api-key" as const) }
      : {}),
    ...extra
  };
}

/** A call that reports `outcome` through its permit, as an adapter's retry loop does. */
function answering(
  scheduler: AiScheduler,
  lane: LaneKey,
  outcome: "ok" | "transient" | "permanent",
  extra: Partial<LaneTicket> = {}
) {
  return scheduler.run(ticket(lane, "P2", extra), async (permit) => {
    permit.observeOutcome(outcome);
    return outcome;
  });
}

/** A call the test ends by hand, so it is still running while the breaker moves. */
function held(scheduler: AiScheduler, lane: LaneKey, extra: Partial<LaneTicket> = {}) {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<LanePermit>();
  const result = scheduler.run(ticket(lane, "P2", extra), async (permit) => {
    started.resolve(permit);
    await gate.promise;
    return "finished";
  });
  return { result, started: started.promise, finish: () => gate.resolve() };
}

async function failTimes(scheduler: AiScheduler, lane: LaneKey, times: number) {
  for (let index = 0; index < times; index++) await answering(scheduler, lane, "transient");
}

const breakerOf = (scheduler: AiScheduler, lane: LaneKey) =>
  scheduler.snapshot().find((snapshot) => snapshot.lane === lane)?.breaker;

describe("circuit breaker on a remote lane", () => {
  it("opens after five consecutive transient failures and fails new entries fast, job-transient", async () => {
    const { scheduler, transitions } = setup();
    await failTimes(scheduler, codex, 4);
    expect(breakerOf(scheduler, codex)).toMatchObject({ state: "closed", consecutiveFailures: 4 });
    await answering(scheduler, codex, "transient");
    expect(breakerOf(scheduler, codex)).toMatchObject({ state: "open", opened: 1 });
    expect(transitions.map(([lane, t]) => [lane, t.from, t.to, t.reason])).toEqual([
      [codex, "closed", "open", "failures"]
    ]);

    const execute = vi.fn(async () => "never");
    const refused = await scheduler.run(ticket(codex), execute).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProviderUnavailableError);
    expect(refused).toMatchObject({
      message: "errors.ai.providerUnavailable",
      transient: true,
      lane: codex,
      retryAfterMs: 30_000
    });
    expect(execute).not.toHaveBeenCalled();
    expect(breakerOf(scheduler, codex)).toMatchObject({ refused: 1 });
  });

  it("is not opened by successes, rate limits alone or permanent failures in between", async () => {
    const { scheduler } = setup();
    await failTimes(scheduler, codex, 4);
    await answering(scheduler, codex, "ok");
    await failTimes(scheduler, codex, 4);
    await answering(scheduler, codex, "permanent");
    await failTimes(scheduler, codex, 4);
    scheduler.observeRateLimit(codex, null);
    expect(breakerOf(scheduler, codex)).toMatchObject({ state: "closed", consecutiveFailures: 4 });
    expect(scheduler.snapshot().find((lane) => lane.lane === codex)).toMatchObject({
      rateLimits: 1
    });
  });

  it("never opens the local lane, which has no breaker", async () => {
    const { scheduler } = setup();
    for (let index = 0; index < 10; index++) await answering(scheduler, "local", "transient");
    await expect(answering(scheduler, "local", "ok")).resolves.toBe("ok");
    expect(breakerOf(scheduler, "local")).toBeNull();
  });

  it("takes the outcomes the scheduler is told about directly, as the spec's API does", async () => {
    const { scheduler } = setup();
    await answering(scheduler, codex, "ok");
    for (let index = 0; index < 5; index++) scheduler.observeOutcome(codex, "transient");
    expect(breakerOf(scheduler, codex)?.state).toBe("open");
  });

  it("leaves running calls alone and fails the entries that were waiting when it opened", async () => {
    const { scheduler } = setup({ lanes: { codexMax: 2 } });
    const running = held(scheduler, codex);
    const failing = held(scheduler, codex);
    const permits = await Promise.all([running.started, failing.started]);
    // Both slots are taken: these wait. The fifth entry below is a new one after the breaker opened.
    const waitingP0 = scheduler.run(ticket(codex, "P0"), async () => "waited");
    const waitingP2 = scheduler.run(ticket(codex, "P2"), async () => "waited");
    const rejected = [waitingP0, waitingP2].map((call) => call.catch((error: unknown) => error));
    await flush();
    for (let index = 0; index < 5; index++) permits[1]!.observeOutcome("transient");
    const errors = await Promise.all(rejected);
    for (const error of errors) {
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).retryAfterMs).toBe(30_000);
    }
    expect(breakerOf(scheduler, codex)).toMatchObject({ state: "open", refused: 2 });
    // The calls that were running finish normally.
    running.finish();
    failing.finish();
    await expect(Promise.all([running.result, failing.result])).resolves.toEqual([
      "finished",
      "finished"
    ]);
    expect(scheduler.snapshot().find((lane) => lane.lane === codex)).toMatchObject({
      running: 0,
      waiting: { P0: 0, P1: 0, P2: 0, P3: 0 }
    });
  });

  it("does not fail a running call that waits for its lane again between two attempts", async () => {
    const { scheduler } = setup({ lanes: { codexMax: 1 } });
    const backoff = Promise.withResolvers<void>();
    const call = scheduler.run(ticket(codex), async (permit) => {
      // Attempt 1 fails and the backoff gives the slot up; another call takes it meanwhile.
      permit.observeOutcome("transient");
      await permit.releaseDuring(() => backoff.promise);
      permit.observeOutcome("ok");
      return "retried";
    });
    await flush();
    const blocker = held(scheduler, codex);
    const blockerPermit = await blocker.started;
    // The backoff ends on a full lane: the call waits for its slot again.
    backoff.resolve();
    await flush();
    expect(scheduler.snapshot().find((lane) => lane.lane === codex)?.waiting.P2).toBe(1);
    // The breaker opens meanwhile; a running call between two attempts is not a new entry.
    for (let index = 0; index < 4; index++) blockerPermit.observeOutcome("transient");
    expect(breakerOf(scheduler, codex)).toMatchObject({ state: "open", refused: 0 });
    blocker.finish();
    await expect(call).resolves.toBe("retried");
    await blocker.result;
  });

  it("lets one probe through after the open period; its success closes the breaker", async () => {
    const { scheduler, transitions, advance } = setup();
    await failTimes(scheduler, codex, 5);
    await advance(29_999);
    await expect(answering(scheduler, codex, "ok")).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
    await advance(1);
    // Half-open: the first entry is the probe, a second is failed fast while it is out.
    const probe = held(scheduler, codex);
    const probePermit = await probe.started;
    expect(breakerOf(scheduler, codex)).toMatchObject({ state: "half_open" });
    await expect(answering(scheduler, codex, "ok")).rejects.toMatchObject({
      message: "errors.ai.providerUnavailable",
      retryAfterMs: 30_000
    });
    probePermit.observeOutcome("ok");
    expect(breakerOf(scheduler, codex)).toMatchObject({ state: "closed", consecutiveFailures: 0 });
    probe.finish();
    await probe.result;
    await expect(answering(scheduler, codex, "ok")).resolves.toBe("ok");
    expect(transitions.map(([, t]) => t.reason)).toEqual(["failures", "elapsed", "probe_answered"]);
  });

  it("says in each refusal whether the probe is out and how the provider last failed (F4 D7)", async () => {
    const { scheduler, advance } = setup({ lanes: { codexMax: 1 } });
    // An unreachable network: the lane remembers it (F4 D27) when the breaker opens.
    const running = held(scheduler, codex);
    await running.started;
    const waiting = scheduler.run(ticket(codex), async () => "never").catch((error) => error);
    for (let index = 0; index < 5; index++)
      scheduler.observeOutcome(codex, "transient", "unreachable");
    // The entry waiting when the breaker opened is refused with what the lane knows.
    expect(await waiting).toMatchObject({ breaker: "open", failure: "unreachable" });
    await expect(answering(scheduler, codex, "ok")).rejects.toMatchObject({
      breaker: "open",
      failure: "unreachable",
      retryAfterMs: 30_000
    });
    running.finish();
    await running.result;
    await advance(30_000);
    // Half-open: the probe is out, so the next entry waits for its answer.
    const probe = held(scheduler, codex);
    await probe.started;
    await expect(answering(scheduler, codex, "ok")).rejects.toMatchObject({
      breaker: "half_open",
      failure: "unreachable",
      retryAfterMs: 30_000
    });
    probe.finish();
    await probe.result;
  });

  it("opens again for another period when the probe fails", async () => {
    const { scheduler, advance } = setup();
    await failTimes(scheduler, codex, 5);
    await advance(30_000);
    await answering(scheduler, codex, "transient");
    expect(breakerOf(scheduler, codex)).toMatchObject({ state: "open", opened: 2 });
    await advance(29_000);
    await expect(answering(scheduler, codex, "ok")).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
    await advance(1_000);
    await expect(answering(scheduler, codex, "ok")).resolves.toBe("ok");
    expect(breakerOf(scheduler, codex)?.state).toBe("closed");
  });

  it("frees the probe when it is cancelled while waiting, or ends without any answer", async () => {
    const { scheduler, advance } = setup({ lanes: { codexMax: 1 } });
    const blocker = held(scheduler, codex);
    await blocker.started;
    for (let index = 0; index < 5; index++) scheduler.observeOutcome(codex, "transient");
    await advance(30_000);
    // The probe waits for the busy lane and is cancelled there: nothing was learnt.
    const controller = new AbortController();
    const waiting = scheduler.run(
      ticket(codex, "P2", { signal: controller.signal }),
      async () => 1
    );
    const cancelled = expect(waiting).rejects.toThrow("changed my mind");
    expect(breakerOf(scheduler, codex)?.state).toBe("half_open");
    await expect(answering(scheduler, codex, "ok")).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
    controller.abort(new Error("changed my mind"));
    await cancelled;
    blocker.finish();
    await blocker.result;
    // The next entry probes, and a probe that fails before any request (no outcome) frees it again.
    await expect(
      scheduler.run(ticket(codex), async () => {
        throw new Error("errors.ai.missingCredential");
      })
    ).rejects.toThrow("missingCredential");
    expect(breakerOf(scheduler, codex)?.state).toBe("half_open");
    await expect(answering(scheduler, codex, "ok")).resolves.toBe("ok");
    expect(breakerOf(scheduler, codex)?.state).toBe("closed");
  });

  it("does not change another lane: an open breaker leaves the schedule of the others as it was (S10)", async () => {
    // The same script on the `other` and local lanes, with and without an outage on `codex`.
    async function run(outage: boolean) {
      const { scheduler, advance, now, clock } = setup({ lanes: { apiKeyMax: 2 } });
      const sleep = (milliseconds: number) =>
        new Promise<void>((resolve) => clock.setTimer(resolve, milliseconds));
      const starts: string[] = [];
      if (outage) await failTimes(scheduler, codex, 5);
      const calls: Array<Promise<unknown>> = [];
      for (let index = 0; index < 6; index++) {
        const lane: LaneKey = index % 3 === 0 ? "local" : other;
        calls.push(
          scheduler.run(ticket(lane, index === 4 ? "P0" : "P2"), async (permit) => {
            starts.push(`${lane} ${index} at ${now()}`);
            permit.observeOutcome("ok");
            await sleep(25);
          })
        );
        await advance(10);
      }
      if (outage) await expect(answering(scheduler, codex, "ok")).rejects.toThrow();
      await advance(1_000);
      await Promise.all(calls);
      return {
        starts,
        lanes: scheduler
          .snapshot()
          .filter((lane) => lane.lane !== codex)
          .map(({ lane, limit, running, rateLimits, breaker }) => ({
            lane,
            limit,
            running,
            rateLimits,
            breaker
          }))
      };
    }
    const withOutage = await run(true);
    expect(withOutage).toEqual(await run(false));
    expect(withOutage.starts).toHaveLength(6);
  });

  it("reports the transitions it makes to its owner and survives an owner that throws", async () => {
    const time = fakeSchedulerClock();
    const onBreakerTransition = vi.fn<(lane: LaneKey, transition: BreakerTransition) => void>(
      () => {
        throw new Error("listener failed");
      }
    );
    const scheduler = createAiScheduler(
      resolveAiLaneRuntimeConfig({}, { environment: {} }),
      time.clock,
      { onBreakerTransition }
    );
    await failTimes(scheduler, codex, 5);
    expect(onBreakerTransition).toHaveBeenCalledTimes(1);
    await time.advance(30_000);
    await expect(answering(scheduler, codex, "ok")).resolves.toBe("ok");
    expect(onBreakerTransition.mock.calls.map(([, t]) => t.to)).toEqual([
      "open",
      "half_open",
      "closed"
    ]);
  });

  it("follows the configured threshold and open period", async () => {
    const { scheduler, advance } = setup({ breaker: { failureThreshold: 2, openMs: 1_000 } });
    await failTimes(scheduler, codex, 2);
    await expect(answering(scheduler, codex, "ok")).rejects.toMatchObject({ retryAfterMs: 1_000 });
    await advance(1_000);
    await expect(answering(scheduler, codex, "ok")).resolves.toBe("ok");
  });
});
