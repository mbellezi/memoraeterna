import { describe, expect, it } from "vitest";

import { CircuitBreaker, ProviderUnavailableError, type BreakerTransition } from "./breaker.js";
import { isTransientAiError, aiErrorRetryAfterMs } from "../provider-error.js";

const config = { failureThreshold: 5, openMs: 30_000 };

function breaker(overrides: Partial<typeof config> = {}) {
  const transitions: BreakerTransition[] = [];
  const instance = new CircuitBreaker({ ...config, ...overrides }, (t) => transitions.push(t));
  return { breaker: instance, transitions };
}

/** Opens a closed breaker with `failureThreshold` transient failures at `now`. */
function open(instance: CircuitBreaker, now = 0, count = config.failureThreshold) {
  for (let index = 0; index < count; index++) instance.record("transient", now);
}

describe("circuit breaker state machine (F3 D32)", () => {
  it("admits everything while closed and opens after five consecutive transient failures", () => {
    const { breaker: instance, transitions } = breaker();
    for (let failure = 1; failure <= 4; failure++) {
      instance.record("transient", failure);
      expect(instance.admit(failure)).toEqual({ kind: "admit" });
      expect(instance.snapshot(failure)).toMatchObject({
        state: "closed",
        consecutiveFailures: failure
      });
    }
    expect(transitions).toEqual([]);
    instance.record("transient", 5);
    expect(transitions).toEqual([{ from: "closed", to: "open", reason: "failures", at: 5 }]);
    expect(instance.snapshot(5)).toMatchObject({
      state: "open",
      opened: 1,
      reopensInMs: 30_000
    });
  });

  it("counts only consecutive failures: a success or a permanent failure resets the count", () => {
    const { breaker: instance, transitions } = breaker();
    open(instance, 0, 4);
    instance.record("ok", 1);
    open(instance, 2, 4);
    instance.record("permanent", 3);
    open(instance, 4, 4);
    expect(instance.snapshot(5)).toMatchObject({ state: "closed", consecutiveFailures: 4 });
    expect(transitions).toEqual([]);
    instance.record("transient", 6);
    expect(instance.snapshot(6).state).toBe("open");
  });

  it("fails entries fast with the time left while open, and counts them", () => {
    const { breaker: instance } = breaker();
    open(instance, 1_000);
    expect(instance.admit(1_000)).toEqual({ kind: "refuse", retryAfterMs: 30_000 });
    expect(instance.admit(11_000)).toEqual({ kind: "refuse", retryAfterMs: 20_000 });
    expect(instance.admit(30_999)).toEqual({ kind: "refuse", retryAfterMs: 1 });
    expect(instance.snapshot(30_999)).toMatchObject({
      state: "open",
      reopensInMs: 1,
      refused: 3
    });
  });

  it("half-opens when the open period ends and admits exactly one probe", () => {
    const { breaker: instance, transitions } = breaker();
    open(instance, 0);
    expect(instance.snapshot(29_999).state).toBe("open");
    expect(instance.snapshot(30_000).state).toBe("half_open");
    // The transition is stamped with the end of the open period, not with when it was noticed.
    expect(transitions.at(-1)).toEqual({
      from: "open",
      to: "half_open",
      reason: "elapsed",
      at: 30_000
    });
    const first = instance.admit(40_000);
    expect(first).toEqual({ kind: "probe", token: expect.any(Number) });
    expect(instance.admit(40_001)).toEqual({ kind: "refuse", retryAfterMs: 30_000 });
    expect(instance.snapshot(40_001)).toMatchObject({ state: "half_open", reopensInMs: null });
  });

  it("closes when the probe is answered, by a success or by a permanent failure", () => {
    for (const outcome of ["ok", "permanent"] as const) {
      const { breaker: instance, transitions } = breaker();
      open(instance, 0);
      const probe = instance.admit(30_000);
      if (probe.kind !== "probe") throw new Error("expected a probe");
      instance.record(outcome, 31_000, probe.token);
      expect(transitions.at(-1)).toEqual({
        from: "half_open",
        to: "closed",
        reason: "probe_answered",
        at: 31_000
      });
      expect(instance.admit(31_000)).toEqual({ kind: "admit" });
      // The failure count started over.
      open(instance, 32_000, 4);
      expect(instance.snapshot(32_000).state).toBe("closed");
    }
  });

  it("opens again for a full period when the probe fails transiently", () => {
    const { breaker: instance, transitions } = breaker();
    open(instance, 0);
    const probe = instance.admit(30_000);
    if (probe.kind !== "probe") throw new Error("expected a probe");
    instance.record("transient", 32_000, probe.token);
    expect(transitions.at(-1)).toEqual({
      from: "half_open",
      to: "open",
      reason: "probe_failed",
      at: 32_000
    });
    expect(instance.admit(40_000)).toEqual({ kind: "refuse", retryAfterMs: 22_000 });
    expect(instance.snapshot(62_000)).toMatchObject({ state: "half_open", opened: 2 });
    expect(instance.admit(62_000)).toEqual({ kind: "probe", token: expect.any(Number) });
  });

  it("ignores the outcomes of calls that were already running while it is open or half-open", () => {
    const { breaker: instance, transitions } = breaker();
    open(instance, 0);
    instance.record("ok", 1_000);
    instance.record("transient", 2_000);
    expect(instance.snapshot(2_000)).toMatchObject({ state: "open", reopensInMs: 28_000 });
    const probe = instance.admit(30_000);
    if (probe.kind !== "probe") throw new Error("expected a probe");
    // A late success of a call from before the outage is not the probe's answer.
    instance.record("ok", 30_500);
    instance.record("transient", 30_600, probe.token + 1);
    expect(instance.snapshot(30_700).state).toBe("half_open");
    expect(transitions.map((t) => t.to)).toEqual(["open", "half_open"]);
    instance.record("ok", 31_000, probe.token);
    expect(instance.snapshot(31_000).state).toBe("closed");
  });

  it("lets the next entry probe when the probe ended without an answer, but not for a stale token", () => {
    const { breaker: instance } = breaker();
    open(instance, 0);
    const first = instance.admit(30_000);
    if (first.kind !== "probe") throw new Error("expected a probe");
    instance.settleProbe(first.token);
    const second = instance.admit(30_100);
    if (second.kind !== "probe") throw new Error("expected a second probe");
    expect(second.token).not.toBe(first.token);
    // The first probe settling late must not free the second one.
    instance.settleProbe(first.token);
    expect(instance.admit(30_200).kind).toBe("refuse");
    // And its late answer decides nothing.
    instance.record("ok", 30_300, first.token);
    expect(instance.snapshot(30_300).state).toBe("half_open");
  });

  it("follows a configured threshold and open period", () => {
    const { breaker: instance } = breaker({ failureThreshold: 2, openMs: 1_000 });
    open(instance, 0, 2);
    expect(instance.admit(10)).toEqual({ kind: "refuse", retryAfterMs: 990 });
    expect(instance.admit(1_000).kind).toBe("probe");
  });
});

describe("provider unavailable error", () => {
  it("is a transient provider error carrying the wait, so jobs retry it after the breaker is shut", () => {
    const error = new ProviderUnavailableError("remote:codex", 20_000.4);
    expect(error.message).toBe("errors.ai.providerUnavailable");
    expect(error.lane).toBe("remote:codex");
    expect(isTransientAiError(error)).toBe(true);
    expect(aiErrorRetryAfterMs(error)).toBe(20_001);
    expect(new ProviderUnavailableError("remote:codex", -5).retryAfterMs).toBe(0);
  });
});
