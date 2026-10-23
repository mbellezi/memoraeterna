import { describe, expect, it } from "vitest";

import { AiProviderError, providerFailureKind, toProviderNetworkError } from "../provider-error.js";
import { resolveAiLaneRuntimeConfig } from "../runtime-config.js";
import { createAiScheduler } from "./scheduler.js";
import { fakeSchedulerClock } from "./test-clock.js";
import type { AiScheduler, LaneFailureKind, LaneKey, LaneTicket } from "./types.js";

/**
 * What a remote lane remembers of how its provider last failed (F4 D27): the Activity status reads
 * it to tell an unreachable network, a refused sign-in and a provider that does not answer apart.
 */

const codex = "remote:codex";

function setup() {
  const time = fakeSchedulerClock();
  const scheduler = createAiScheduler(
    resolveAiLaneRuntimeConfig({}, { environment: {} }),
    time.clock
  );
  return { scheduler, ...time };
}

const ticket = (lane: LaneKey): LaneTicket => ({
  lane,
  priority: "P2",
  workloadClass: "decide",
  label: lane,
  ...(lane.startsWith("remote:") ? { remoteKind: "codex" as const } : {})
});

function answering(
  scheduler: AiScheduler,
  outcome: "ok" | "transient" | "permanent",
  failure?: LaneFailureKind,
  lane: LaneKey = codex
) {
  return scheduler.run(ticket(lane), async (permit) => {
    permit.observeOutcome(outcome, failure);
    return outcome;
  });
}

const failureOf = (scheduler: AiScheduler, lane: LaneKey = codex) =>
  scheduler.snapshot().find((snapshot) => snapshot.lane === lane)?.failure;

describe("the failure a lane remembers", () => {
  it("has none before any call and for the local lane", async () => {
    const { scheduler } = setup();
    await answering(scheduler, "ok", undefined, "local");
    await answering(scheduler, "transient", "unreachable", "local");
    expect(failureOf(scheduler, "local")).toBeNull();
  });

  it("remembers how the provider failed and how long ago", async () => {
    const { scheduler, advance } = setup();
    await answering(scheduler, "transient", "unreachable");
    expect(failureOf(scheduler)).toEqual({ kind: "unreachable", ageMs: 0 });
    await advance(12_000);
    expect(failureOf(scheduler)).toEqual({ kind: "unreachable", ageMs: 12_000 });
    await answering(scheduler, "permanent", "unauthorized");
    expect(failureOf(scheduler)).toEqual({ kind: "unauthorized", ageMs: 0 });
  });

  it("forgets it when a response shows the provider answers", async () => {
    const { scheduler } = setup();
    await answering(scheduler, "transient", "unavailable");
    await answering(scheduler, "ok");
    expect(failureOf(scheduler)).toBeNull();
    await answering(scheduler, "transient", "unreachable");
    // A rejected request (a permanent failure with no kind) is an answer too.
    await answering(scheduler, "permanent");
    expect(failureOf(scheduler)).toBeNull();
  });

  it("keeps a failure of a transient outcome that names none out of the memory", async () => {
    const { scheduler } = setup();
    await answering(scheduler, "transient");
    expect(failureOf(scheduler)).toBeNull();
  });

  it("is not forgotten by a call that was already running when the breaker opened", async () => {
    const { scheduler } = setup();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<{ observeOutcome(outcome: "ok"): void }>();
    const running = scheduler.run(ticket(codex), async (permit) => {
      started.resolve(permit);
      await gate.promise;
    });
    const permit = await started.promise;
    for (let index = 0; index < 5; index++) await answering(scheduler, "transient", "unreachable");
    expect(scheduler.snapshot().find((lane) => lane.lane === codex)?.breaker?.state).toBe("open");
    permit.observeOutcome("ok");
    expect(failureOf(scheduler)).toMatchObject({ kind: "unreachable" });
    gate.resolve();
    await running;
  });
});

describe("how a failed call is classified (providerFailureKind)", () => {
  const http = (status: number, transient: boolean) =>
    new AiProviderError(`HTTP ${status}`, { kind: "http", transient, status });
  const network = (code: string) =>
    new AiProviderError("connection failed", { kind: "network", transient: true, code });

  it("reads a refused credential as unauthorized", () => {
    expect(providerFailureKind(http(401, false))).toBe("unauthorized");
    expect(providerFailureKind(http(403, false))).toBe("unauthorized");
  });

  it("reads DNS and routing failures as an unreachable network", () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH"])
      expect(providerFailureKind(network(code)), code).toBe("unreachable");
  });

  it("reads a refused connection, a server error and a timeout as a provider that does not answer", () => {
    expect(providerFailureKind(network("ECONNREFUSED"))).toBe("unavailable");
    expect(providerFailureKind(network("ECONNRESET"))).toBe("unavailable");
    expect(providerFailureKind(http(503, true))).toBe("unavailable");
    expect(providerFailureKind(http(500, true))).toBe("unavailable");
    expect(
      providerFailureKind(new AiProviderError("timeout", { kind: "timeout", transient: true }))
    ).toBe("unavailable");
  });

  it("reads an answer of the provider, a rate limit included, as no failure", () => {
    expect(providerFailureKind(http(429, true))).toBeUndefined();
    expect(providerFailureKind(http(400, false))).toBeUndefined();
    expect(providerFailureKind(http(404, false))).toBeUndefined();
    expect(
      providerFailureKind(
        new AiProviderError("overflow", { kind: "context_overflow", transient: false })
      )
    ).toBeUndefined();
    expect(providerFailureKind(new Error("not a provider error"))).toBeUndefined();
    expect(providerFailureKind(undefined)).toBeUndefined();
  });

  it("looks through the cause of a wrapped failure and a raw transport error", () => {
    const raw = Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), {
      code: "ENOTFOUND"
    });
    expect(providerFailureKind(raw)).toBe("unreachable");
    expect(providerFailureKind(toProviderNetworkError(raw))).toBe("unreachable");
    expect(providerFailureKind(new Error("failed", { cause: http(401, false) }))).toBe(
      "unauthorized"
    );
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      code: "ECONNREFUSED"
    });
    expect(providerFailureKind(refused)).toBe("unavailable");
  });
});
