import type { JobRecord } from "@app/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecideRouteStatus } from "../ai-service.js";
import { createTopicTreeServices, engineStatusOf } from "./index.js";
import type { TopicTreeServices, TopicTreeServicesOptions } from "./index.js";
import { topicGateLimits, topicGateOperation } from "./topic-gate.js";
import { topicJobTypes } from "./topic-jobs.js";
import type { TopicServiceStatus } from "./topic-tree-service.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function gateJob(payload: Record<string, unknown>): JobRecord {
  return { id: id(90), type: topicJobTypes.gate, payload } as unknown as JobRecord;
}

/**
 * The gate's wiring without a database (its work on the real schema is the sidecar test): the
 * executor on the `model` worker, the deterministic golden mode, the `no_decider` status and the
 * route recheck that asks the sweep to enqueue waiting scopes.
 */
describe("the topic gate wiring (T23)", () => {
  let services: TopicTreeServices | null = null;
  afterEach(() => {
    services?.dispose();
    services = null;
  });

  function create(
    route: { status: DecideRouteStatus },
    extra: Partial<TopicTreeServicesOptions> = {}
  ) {
    const ai = {
      decideRouteStatus: vi.fn(async (operation?: string) => {
        expect(operation).toBe(topicGateOperation);
        return route.status;
      }),
      rank: vi.fn(async () => {
        throw new Error("no rank call is expected here");
      }),
      runDefaultTask: vi.fn(async () => null),
      activeEmbeddingSpace: vi.fn(async () => null)
    };
    services = createTopicTreeServices({
      getPool: () => null,
      spaceResolver: {
        resolve: async () => ({ kind: "blocked", reason: "waiting_for_embeddings" })
      },
      env: {},
      isPackaged: false,
      logger: quiet,
      ai: ai as unknown as NonNullable<TopicTreeServicesOptions["ai"]>,
      ...extra
    });
    return { services, ai };
  }

  it("registers the gate on the model worker only with an AI service", () => {
    const bare = createTopicTreeServices({
      getPool: () => null,
      spaceResolver: { resolve: async () => ({ kind: "blocked", reason: "no_embedding_route" }) },
      env: {},
      isPackaged: false,
      logger: quiet
    });
    expect(bare.gate).toBeNull();
    expect(bare.jobs[topicJobTypes.gate]).toBeUndefined();
    bare.dispose();
    const { services: full } = create({ status: "ready" });
    expect(full.gate).not.toBeNull();
    expect(full.jobs[topicJobTypes.gate]?.needsModel).toBe(true);
    full.holdTopicJobs();
    expect(full.jobs[topicJobTypes.gate]?.held?.()).toBe(true);
  });

  it("makes no call in a deterministic golden run (G1)", async () => {
    const { services: created, ai } = create(
      { status: "ready" },
      { env: { MEMORA_GOLDEN_RUN: "golden-small", MEMORA_GOLDEN_TOPICS: "deterministic" } }
    );
    const result = await created.gate!.runGate(
      gateJob({ treeId: id(1), rootSourceId: id(2), sourceItemId: id(2) }),
      new AbortController().signal
    );
    expect(result).toMatchObject({ status: "skipped", reason: "deterministic" });
    expect(ai.decideRouteStatus).not.toHaveBeenCalled();
    expect(await created.gate!.waitingForDecider(5)).toBe(false);
  });

  it("leaves the items waiting without a validated ranker and refuses malformed payloads", async () => {
    const { services: created, ai } = create({ status: "not_validated" });
    const result = await created.gate!.runGate(
      gateJob({ treeId: id(1), noteId: id(3) }),
      new AbortController().signal
    );
    expect(result).toMatchObject({ status: "no_decider", route: "not_validated" });
    expect(ai.rank).not.toHaveBeenCalled();
    await expect(
      created.gate!.runGate(gateJob({ treeId: id(1) }), new AbortController().signal)
    ).rejects.toThrow();
  });

  it("reports no_decider only while items wait for the gate", async () => {
    const route = { status: "missing" as DecideRouteStatus };
    const { services: created } = create(route);
    const status: TopicServiceStatus = {
      treeId: id(1),
      generation: 3,
      phase: "active",
      blocked: null,
      counts: { items: 10, placed: 10, pending: 0, needsGate: 2 },
      dailyCapReached: false,
      aiMode: "full",
      held: false
    };
    const gate = created.gate!;
    expect(engineStatusOf(status, await gate.waitingForDecider(2))).toEqual({
      phase: "active",
      blocked: "no_decider",
      dailyCapReached: false
    });
    expect(await gate.waitingForDecider(0)).toBe(false);
    // Another reason the engine already reports wins over the informative one.
    expect(engineStatusOf({ ...status, blocked: "space_changed" }, true)).toMatchObject({
      blocked: "space_changed"
    });
    route.status = "ready";
    expect(await gate.waitingForDecider(2)).toBe(false);
  });

  it("checks the route again on a commit at most every recheck interval, and sweeps once ready", async () => {
    const clock = { now: Date.parse("2026-10-15T12:00:00.000Z") };
    const route = { status: "not_validated" as DecideRouteStatus };
    const { services: created, ai } = create(route, { now: () => new Date(clock.now) });
    const sweep = vi.spyOn(created.triggers, "sweep").mockResolvedValue([]);
    const event = { treeId: id(1), generation: 2, topicIds: null, changeSetId: null };
    // Not blocked yet: a commit checks nothing.
    created.gate!.onTopicsChanged(event);
    expect(ai.decideRouteStatus).not.toHaveBeenCalled();
    await created.gate!.runGate(
      gateJob({ treeId: id(1), noteId: id(3) }),
      new AbortController().signal
    );
    expect(ai.decideRouteStatus).toHaveBeenCalledTimes(1);

    route.status = "ready";
    created.gate!.onTopicsChanged(event);
    expect(ai.decideRouteStatus).toHaveBeenCalledTimes(1);
    clock.now += topicGateLimits.routeRecheckMs;
    created.gate!.onTopicsChanged(event);
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledWith("requested", { treeId: id(1) }));
    expect(ai.decideRouteStatus).toHaveBeenCalledTimes(2);
    // Ready again: later commits check nothing.
    clock.now += 2 * topicGateLimits.routeRecheckMs;
    created.gate!.onTopicsChanged(event);
    expect(ai.decideRouteStatus).toHaveBeenCalledTimes(2);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("finds a ranker validated in the middle of a session without a change of the tree", async () => {
    vi.useFakeTimers();
    try {
      const route = { status: "not_validated" as DecideRouteStatus };
      const { services: created, ai } = create(route);
      const sweep = vi.spyOn(created.triggers, "sweep").mockResolvedValue([]);
      await created.gate!.runGate(
        gateJob({ treeId: id(1), noteId: id(3) }),
        new AbortController().signal
      );
      expect(ai.decideRouteStatus).toHaveBeenCalledTimes(1);
      // Still not validated after the interval: checked again, nothing swept, and the wait goes on.
      await vi.advanceTimersByTimeAsync(topicGateLimits.routeRecheckMs);
      expect(ai.decideRouteStatus).toHaveBeenCalledTimes(2);
      expect(sweep).not.toHaveBeenCalled();
      // Validated now: the next check sweeps the waiting scopes of the active tree, once.
      route.status = "ready";
      await vi.advanceTimersByTimeAsync(topicGateLimits.routeRecheckMs);
      expect(ai.decideRouteStatus).toHaveBeenCalledTimes(3);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(sweep).toHaveBeenCalledWith("requested", {});
      // Ready: nothing is checked again.
      await vi.advanceTimersByTimeAsync(5 * topicGateLimits.routeRecheckMs);
      expect(ai.decideRouteStatus).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checks nothing on a timer outside full AI mode, after the services are disposed, or once swept", async () => {
    vi.useFakeTimers();
    try {
      const route = { status: "missing" as DecideRouteStatus };
      const { services: created, ai } = create(route, {
        env: { MEMORA_GOLDEN_RUN: "golden-small", MEMORA_GOLDEN_TOPICS: "deterministic" }
      });
      expect(await created.gate!.waitingForDecider(3)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await created.gate!.recheckRoute();
      expect(ai.decideRouteStatus).not.toHaveBeenCalled();
      created.dispose();

      const second = create(route);
      expect(await second.services.gate!.waitingForDecider(3)).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      const sweep = vi.spyOn(second.services.triggers, "sweep").mockResolvedValue([]);
      route.status = "ready";
      second.services.dispose();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(3 * topicGateLimits.routeRecheckMs);
      expect(sweep).not.toHaveBeenCalled();
      await second.services.gate!.recheckRoute();
      expect(sweep).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
