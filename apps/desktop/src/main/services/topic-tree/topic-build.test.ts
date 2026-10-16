import type { JobRecord, PgPool } from "@app/db";
import {
  createTopicTreeState,
  defaultTopicTreeConfig,
  insertPlacement,
  insertTopic,
  itemKey,
  placementRecord,
  registerItem,
  topicRecord,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import { describe, expect, it, vi } from "vitest";

import { TopicStructureJobs } from "./topic-build.js";
import type { TopicStructureJobsOptions } from "./topic-build.js";
import type { TopicChangeCoalescer } from "./topic-changes.js";
import { topicJobTypes } from "./topic-jobs.js";
import type { TopicTreeCache } from "./topic-cache.js";
import type { TopicTreeService } from "./topic-tree-service.js";
import { immediateDebounce } from "./topic-triggers.js";
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

  it("asks for the sweep's audit at once and for PLACE's follow-ups debounced", async () => {
    const { jobs, request } = structure();
    await jobs.afterSweep({ status: "swept", treeId, recomputedTopics: 2 });
    await jobs.afterPlace(placeJob, { status: "applied", generation: 3, changeSetId });
    // (type, tree, scope, options): the options of an immediate request name the debounce.
    expect(request.mock.calls.map((call) => (call as unknown[]).slice(0, 4))).toEqual([
      [topicJobTypes.audit, treeId, null, { debounce: immediateDebounce }],
      [topicJobTypes.rebalance, treeId, null, {}],
      [topicJobTypes.audit, treeId, null, {}]
    ]);
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

describe("rebuild triggers after PLACE", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  /** A cached tree of one leaf holding `notes` notes PLACE decided. */
  function cacheWith(notes: number): TopicTreeCache {
    const state = createTopicTreeState({ dim: 4, rootId: uuid(900) });
    insertTopic(state, topicRecord(uuid(901), uuid(900)));
    for (let index = 0; index < notes; index += 1) {
      const key = itemKey("note", uuid(index + 1));
      registerItem(state, { key, kind: "note", contentHash: `h${index}`, rootSource: null });
      insertPlacement(state, key, placementRecord(uuid(901), { decidedBy: "auto" }));
    }
    return { state, config: defaultTopicTreeConfig } as unknown as TopicTreeCache;
  }

  /** Structure jobs whose last build counted `built` notes and whose cached tree holds `notes`. */
  function triggered(
    built: number,
    notes: number,
    status = "applied",
    summary: Record<string, unknown> = {}
  ) {
    const pool = {
      query: async (text: string) =>
        text.includes("origin in ('build', 'rebuild')")
          ? {
              rows: [
                {
                  id: uuid(800),
                  origin: status === "dismissed" ? "rebuild" : "build",
                  status,
                  summary: { notes: built, leafCoherence: 0.5, ...summary },
                  createdAt: new Date(2026, 9, 15)
                }
              ],
              rowCount: 1
            }
          : { rows: [], rowCount: 0 }
    } as unknown as PgPool;
    const cache = cacheWith(notes);
    const service = {
      config: () => defaultTopicTreeConfig,
      runOnTree: async (_id: string, run: (value: TopicTreeCache) => Promise<unknown>) => run(cache)
    } as unknown as TopicTreeService;
    return structure({ getPool: () => pool, service });
  }

  it("asks for a build when the library doubled since the last build, within one session", async () => {
    const { jobs, request } = triggered(12, 24);
    await jobs.afterPlace(placeJob, { status: "applied", generation: 4, changeSetId });
    const builds = request.mock.calls.filter(
      (call) => (call as unknown[])[0] === topicJobTypes.build
    );
    // Debounced like PLACE's other follow-ups; the build job decides again before it runs.
    expect(builds.map((call) => (call as unknown[]).slice(0, 4))).toEqual([
      [topicJobTypes.build, treeId, null, {}]
    ]);
  });

  it("asks for nothing below the trigger, while a rebuild waits for review, or past the bound", async () => {
    for (const [built, notes, status] of [
      [12, 23, "applied"],
      [12, 24, "pending_review"],
      [600, 1_200, "applied"]
    ] as const) {
      const { jobs, requested } = triggered(built, notes, status);
      await jobs.afterPlace(placeJob, { status: "applied", generation: 4, changeSetId });
      expect(requested()).not.toContain(topicJobTypes.build);
    }
  });

  it("counts from the tree a rejected rebuild left in place, so the trigger does not repeat", async () => {
    // The last build counted 12 notes; a doubling rebuild at 24 was rejected (a dismissed
    // rebuild record carrying the tree it kept as the baseline): 24 notes trigger nothing more.
    const rejected = { decided: 12, unadmitted: 0, rejected: { reasons: ["coherence"] } };
    const quiet = triggered(24, 24, "dismissed", rejected);
    await quiet.jobs.afterPlace(placeJob, { status: "applied", generation: 4, changeSetId });
    expect(quiet.requested()).not.toContain(topicJobTypes.build);
    // Once the library doubled again from there, it does.
    const doubled = triggered(12, 48, "dismissed", rejected);
    await doubled.jobs.afterPlace(placeJob, { status: "applied", generation: 4, changeSetId });
    expect(doubled.requested()).toContain(topicJobTypes.build);
  });
});
