import { gardenerJobKeys, gardenerTaskKind, resultStatusStates } from "@app/domain";
import { describe, expect, it, vi } from "vitest";

import { lightWorkerOf, lightWorkerTypes } from "../job-lanes.js";
import { createTopicTreeServices } from "./index.js";
import { overviewRefreshStatuses } from "./topic-overview.js";
import {
  TopicOverviewRefresh,
  topicOverviewDedupeKey,
  topicOverviewJobType
} from "./topic-overview-job.js";

// REFRESH's job (F4 D17, T84) without a database: its statuses, its keys and where it runs.

const topicId = "00000000-0000-4000-8000-0000000000a1";

describe("the topic-overview job", () => {
  it("returns only statuses the Gardener maps (spec 3.1b)", () => {
    for (const status of overviewRefreshStatuses)
      expect(resultStatusStates[status], status).toBeDefined();
    expect(resultStatusStates.applied).toEqual({ state: "outcome", outcome: "done" });
    expect(resultStatusStates.pending_review).toEqual({ state: "outcome", outcome: "done" });
    expect(resultStatusStates.current).toEqual({ state: "outcome", outcome: "no_change" });
    expect(resultStatusStates.deferred).toEqual({ state: "outcome", outcome: "no_change" });
    expect(resultStatusStates.no_route).toMatchObject({ state: "blocked" });
    // An invalid answer is a failed attempt with backoff (spec 3.1b, T74's R4).
    expect(resultStatusStates.invalid).toEqual({ state: "failed", retry: true });
  });

  it("reads its topic from a claimed payload, whose dedupe key the claim keeps beside it (T74)", async () => {
    const refresh = vi.fn(async () => ({ status: "current" as const }));
    const executor = new TopicOverviewRefresh({
      getPool: () => null,
      overview: { refresh } as never,
      autonomy: async () => "auto",
      aiMode: "full"
    }).executor();
    await executor.execute(
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        payload: { topicId, claimedDedupeKey: `topic-overview:${topicId}` }
      } as never,
      new AbortController().signal
    );
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ topicId }));
  });

  it("is one deduped request per topic, scoped to the topic, a background generative task", () => {
    expect(topicOverviewDedupeKey(topicId.toUpperCase())).toBe(`topic-overview:${topicId}`);
    expect(gardenerJobKeys(topicOverviewJobType, { topicId })).toEqual({
      scopeKey: `topic:${topicId}`,
      subjectKey: `topic:${topicId}`,
      rootOf: null
    });
    expect(gardenerTaskKind(topicOverviewJobType)).toMatchObject({
      task: "refresh",
      worker: "model",
      generative: true,
      budgetClass: "background"
    });
  });

  it("requests nothing in a golden run (no overview is written there)", async () => {
    const getPool = vi.fn(() => null);
    const refresh = new TopicOverviewRefresh({
      getPool,
      overview: { refresh: vi.fn() },
      autonomy: async () => "auto",
      aiMode: "deterministic"
    });
    expect(await refresh.request(topicId, null)).toBe(0);
    expect(await refresh.requestTopic(topicId)).toBe(false);
    expect(getPool).not.toHaveBeenCalled();
  });

  it("runs on the model worker, held by the topic barrier like every topic job", () => {
    const services = createTopicTreeServices({
      getPool: () => null,
      spaceResolver: { resolve: async () => ({ kind: "unavailable" }) } as never,
      env: {},
      isPackaged: false,
      ai: {
        runDefaultTask: vi.fn(),
        embedMany: vi.fn(),
        activeEmbeddingSpace: vi.fn(),
        rank: vi.fn(),
        decideRouteStatus: vi.fn()
      } as never,
      getContentLanguage: async () => "en"
    });
    try {
      const executor = services.jobs[topicOverviewJobType]!;
      expect(executor).toBeDefined();
      expect(lightWorkerOf(executor)).toBe("model");
      expect(lightWorkerTypes(services.jobs).model).toContain(topicOverviewJobType);
      expect(executor.fingerprint).toBeTypeOf("function");
      expect(executor.held?.()).toBe(false);
      services.holdTopicJobs();
      expect(executor.held?.()).toBe(true);
      expect(services.overviewRefresh).not.toBeNull();
    } finally {
      services.dispose();
    }
  });
});
