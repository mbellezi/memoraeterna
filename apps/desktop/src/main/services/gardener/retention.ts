import {
  createJobRepository,
  createRelationEventRepository,
  createTopicOverviewRepository,
  createTopicTreeRepository,
  type JobRecord,
  type JsonObject,
  type PgPool
} from "@app/db";
import { changeSetConfig, gardenerRetentionJobType, type ChangeSetConfig } from "@app/domain";

import type { LightJobExecutor } from "../job-lanes.js";

/**
 * Retention (F4 D10, spec 3.1): a daily light job prunes applied or undone change-sets past the
 * window from each store through its own writer (topic change-sets through the topic engine's
 * repository, relation passes through the relation event log, overview writes through the
 * overview repository), and succeeded or canceled jobs past theirs. Pending reviews, the owner's
 * verdicts, human passes, download jobs and the newest job of each type are never pruned; an undo
 * and what it undid go only together. It is one job on the jobs table, queued again for the next day when it ends.
 */
export { gardenerRetentionJobType };
const dedupeKey = gardenerRetentionJobType;
const dayMs = 24 * 60 * 60 * 1000;

/** How long after the app starts the first pass may run when none is due earlier. */
export const retentionStartDelayMs = 10 * 60 * 1000;

/** The writers retention calls; each deletes at most `limit` rows made before `before`. */
export interface RetentionStores {
  topic(input: { before: Date; limit: number }): Promise<number>;
  relation(input: { before: Date; limit: number }): Promise<number>;
  overview(input: { before: Date; limit: number }): Promise<number>;
  jobs(input: { before: Date; limit: number }): Promise<number>;
}

export interface RetentionReport {
  /** Rows each store pruned. */
  pruned: { topic: number; relation: number; overview: number; jobs: number };
  changeSetsBefore: string;
  jobsBefore: string;
  /** False when a store reached its batch limit: the next pass continues. */
  complete: boolean;
}

export function createRetentionStores(pool: PgPool): RetentionStores {
  return {
    topic: (input) => createTopicTreeRepository(pool).pruneChangeSets(input),
    relation: (input) => createRelationEventRepository(pool).pruneRuns(input),
    overview: (input) => createTopicOverviewRepository(pool).pruneVersions(input),
    jobs: (input) => createJobRepository(pool).pruneFinished(input)
  };
}

/** One retention pass: each store in batches until it has nothing left or reaches its limit. */
export async function runRetention(
  stores: RetentionStores,
  options: {
    now: Date;
    config?: ChangeSetConfig["retention"];
    signal?: AbortSignal;
  }
): Promise<RetentionReport> {
  const config = options.config ?? changeSetConfig.retention;
  const changeSetsBefore = new Date(options.now.getTime() - config.changeSetDays * dayMs);
  const jobsBefore = new Date(options.now.getTime() - config.jobDays * dayMs);
  const pruned = { topic: 0, relation: 0, overview: 0, jobs: 0 };
  let complete = true;
  const steps: Array<[keyof typeof pruned, Date]> = [
    ["topic", changeSetsBefore],
    ["relation", changeSetsBefore],
    ["overview", changeSetsBefore],
    ["jobs", jobsBefore]
  ];
  for (const [store, before] of steps) {
    let batches = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      if (batches >= config.maxBatches) {
        complete = false;
        break;
      }
      const deleted = await stores[store]({ before, limit: config.batchSize });
      batches += 1;
      pruned[store] += deleted;
      if (deleted === 0) break;
    }
  }
  return {
    pruned,
    changeSetsBefore: changeSetsBefore.toISOString(),
    jobsBefore: jobsBefore.toISOString(),
    complete
  };
}

/**
 * Queues the next pass `delayMs` from now. A pass already queued keeps its time when it is due or
 * earlier (the merge never postpones a due job), so a start never pulls the daily pass forward.
 */
export async function scheduleRetention(
  jobs: Pick<ReturnType<typeof createJobRepository>, "enqueueDeduped">,
  delayMs: number
): Promise<JobRecord> {
  const delay = Math.max(0, Math.trunc(delayMs));
  const { job } = await jobs.enqueueDeduped({
    type: gardenerRetentionJobType,
    lane: "light",
    dedupeKey,
    payload: {},
    debounce: { delayMs: delay, maxDelayMs: delay }
  });
  return job;
}

export interface RetentionJobOptions {
  getPool: () => PgPool | null;
  now?: () => Date;
  config?: ChangeSetConfig["retention"];
  /** The writers; the repositories of the pool by default. */
  stores?: (pool: PgPool) => RetentionStores;
}

/** The `gardener-retention` light job: one pass, then the next one queued a day later. */
export function retentionJobExecutor(options: RetentionJobOptions): LightJobExecutor {
  return {
    needsModel: false,
    async execute(_job, signal): Promise<JsonObject> {
      const pool = options.getPool();
      if (!pool) throw new Error("database_unavailable");
      const report = await runRetention((options.stores ?? createRetentionStores)(pool), {
        now: options.now?.() ?? new Date(),
        ...(options.config ? { config: options.config } : {}),
        signal
      });
      // An unfinished pass continues at once; a finished one comes back tomorrow.
      await scheduleRetention(createJobRepository(pool), report.complete ? dayMs : 0);
      return { status: "completed", ...report };
    }
  };
}
