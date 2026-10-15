import type { JobRecord, PgPool } from "@app/db";
import { defaultTopicTreeConfig, topicTreeConfigWith } from "@app/domain/topic-tree";
import { describe, expect, it, vi } from "vitest";

import { TopicStructureJobs } from "./topic-build.js";
import type { TopicStructureJobsOptions } from "./topic-build.js";
import type { TopicChangeCoalescer } from "./topic-changes.js";
import { topicJobTypes } from "./topic-jobs.js";
import type { TopicTreeService } from "./topic-tree-service.js";
import type { TopicTriggers } from "./topic-triggers.js";

const treeId = "00000000-0000-4000-8000-000000000001";
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Structure jobs over fakes: the requests they make are recorded, nothing touches a database. */
function structure(overrides: Partial<TopicStructureJobsOptions> = {}, everyChangeSets = 50) {
  const request = vi.fn(async () => [{}]);
  const config = topicTreeConfigWith({ audit: { everyChangeSets } });
  let now = new Date(2026, 9, 15, 12);
  const jobs = new TopicStructureJobs({
    // A change-set with no stored events: the requests are what this test looks at.
    getPool: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }) as unknown as PgPool,
    service: { config: () => config } as unknown as TopicTreeService,
    triggers: { request } as unknown as TopicTriggers,
    changes: {} as TopicChangeCoalescer,
    spaceResolver: { resolve: async () => ({ kind: "blocked", reason: "waiting_for_embeddings" }) },
    aiMode: "full",
    isRegistered: () => true,
    effectiveConfig: () => defaultTopicTreeConfig,
    clusterTopics: async () => {
      throw new Error("no clustering in this test");
    },
    logger: quiet,
    now: () => now,
    ...overrides
  });
  const requested = () => request.mock.calls.map((call) => (call as unknown[])[0]);
  return {
    jobs,
    request,
    requested,
    setNow: (date: Date) => {
      now = date;
    }
  };
}

const placeJob = { id: "job", payload: { treeId } } as unknown as JobRecord;
const changeSetId = "00000000-0000-4000-8000-000000000002";

describe("the structure jobs' follow-ups", () => {
  it("asks for REBALANCE after an applied PLACE change-set, and for nothing otherwise", async () => {
    const { jobs, requested } = structure();
    await jobs.afterPlace(placeJob, { status: "no_change" });
    await jobs.afterPlace(placeJob, { status: "awaiting_build" });
    expect(requested()).toEqual([]);
    await jobs.afterPlace(placeJob, { status: "applied", generation: 3, changeSetId });
    expect(requested()).toEqual([topicJobTypes.rebalance, topicJobTypes.audit]);
  });

  it("audits again every audit.everyChangeSets change-sets and on a new day", async () => {
    const { jobs, requested, setNow } = structure({}, 10);
    // An audit has not run in this process: the first PLACE asks for one.
    await jobs.afterPlace(placeJob, { status: "applied", generation: 1, changeSetId });
    expect(requested().filter((type) => type === topicJobTypes.audit)).toHaveLength(1);
    // Until an audit runs, every applied PLACE asks again (the queued job absorbs the requests).
    await jobs.afterPlace(placeJob, { status: "applied", generation: 2, changeSetId });
    expect(requested().filter((type) => type === topicJobTypes.audit)).toHaveLength(2);
    setNow(new Date(2026, 9, 16, 12));
    await jobs.afterPlace(placeJob, { status: "applied", generation: 3, changeSetId });
    expect(requested().filter((type) => type === topicJobTypes.audit)).toHaveLength(3);
  });

  it("asks for an audit after a sweep restored statistics, and one at startup", async () => {
    const { jobs, requested } = structure();
    await jobs.afterSweep({ status: "swept", treeId, recomputedTopics: 0 });
    expect(requested()).toEqual([]);
    await jobs.afterSweep({ status: "swept", treeId, recomputedTopics: 2 });
    await jobs.startup(null);
    await jobs.startup(treeId);
    expect(requested()).toEqual([topicJobTypes.audit, topicJobTypes.audit]);
  });

  it("skips types without an executor and never fails the job that asked", async () => {
    const skipped = structure({ isRegistered: (type) => type !== topicJobTypes.rebalance });
    await skipped.jobs.afterPlace(placeJob, { status: "applied", generation: 1, changeSetId });
    expect(skipped.requested()).toEqual([topicJobTypes.audit]);
    const failing = structure();
    failing.request.mockRejectedValueOnce(new Error("database gone"));
    await expect(
      failing.jobs.afterPlace(placeJob, { status: "applied", generation: 1, changeSetId })
    ).resolves.toBeUndefined();
    expect(quiet.error).toHaveBeenCalled();
  });
});
