import { describe, expect, it } from "vitest";

import { AiProviderError } from "../provider-error.js";
import { resolveAiRuntimeConfig, runRemoteCall } from "../remote-execution.js";
import { resolveAiLaneRuntimeConfig } from "../runtime-config.js";
import { bindLanePermit } from "./execution.js";
import { createAiScheduler } from "./scheduler.js";
import { fakeSchedulerClock } from "./test-clock.js";
import type { AiScheduler, LaneTicket } from "./types.js";

/**
 * A remote call reports to its lane how it failed (F4 D27): the retry loop classifies the failure
 * of an attempt and tells the lane's permit, so the Activity status can tell an unreachable network,
 * a refused sign-in and a provider that does not answer apart.
 */
const codex = "remote:codex";

const ticket: LaneTicket = {
  lane: codex,
  remoteKind: "codex",
  priority: "P2",
  workloadClass: "write-fast",
  label: "codex"
};

const context = {
  config: resolveAiRuntimeConfig({ retry: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 } }),
  random: () => 0
};

function setup() {
  const time = fakeSchedulerClock();
  return createAiScheduler(resolveAiLaneRuntimeConfig({}, { environment: {} }), time.clock);
}

async function failing(scheduler: AiScheduler, error: unknown) {
  await scheduler.run(ticket, async (permit) => {
    const controller = new AbortController();
    bindLanePermit(controller.signal, permit);
    await runRemoteCall(
      context,
      { streaming: false, taskType: "summarization", signal: controller.signal },
      async () => {
        throw error;
      }
    ).catch(() => undefined);
  });
}

const lane = (scheduler: AiScheduler) =>
  scheduler.snapshot().find((snapshot) => snapshot.lane === codex)!;

describe("a remote call reports how it failed to its lane", () => {
  it("names the unreachable network, the refused sign-in and the silent provider", async () => {
    const scheduler = setup();
    await failing(
      scheduler,
      Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" })
    );
    expect(lane(scheduler).failure).toMatchObject({ kind: "unreachable" });
    await failing(
      scheduler,
      new AiProviderError("unauthorized", { kind: "http", transient: false, status: 401 })
    );
    expect(lane(scheduler).failure).toMatchObject({ kind: "unauthorized" });
    await failing(
      scheduler,
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" })
    );
    expect(lane(scheduler).failure).toMatchObject({ kind: "unavailable" });
  });

  it("forgets a failure at the next answer, a rate limit included, and pauses the lane for it", async () => {
    const scheduler = setup();
    await failing(
      scheduler,
      new AiProviderError("unauthorized", { kind: "http", transient: false, status: 401 })
    );
    await failing(
      scheduler,
      new AiProviderError("slow down", {
        kind: "http",
        transient: true,
        status: 429,
        retryAfterMs: 1_000
      })
    );
    expect(lane(scheduler).failure).toBeNull();
    expect(lane(scheduler).pausedForMs).toBeGreaterThan(0);
  });

  it("forgets a failure when a call succeeds", async () => {
    const scheduler = setup();
    await failing(
      scheduler,
      new AiProviderError("down", { kind: "http", transient: true, status: 503 })
    );
    expect(lane(scheduler).failure).toMatchObject({ kind: "unavailable" });
    await scheduler.run(ticket, async (permit) => {
      const controller = new AbortController();
      bindLanePermit(controller.signal, permit);
      await runRemoteCall(
        context,
        { streaming: false, taskType: "summarization", signal: controller.signal },
        async () => "fine"
      );
    });
    expect(lane(scheduler).failure).toBeNull();
  });
});
