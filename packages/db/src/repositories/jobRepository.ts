import type { QueryResultRow } from "pg";
import { sanitizeStoredValue } from "@app/domain";
import { taskHistoryCutoffKey, terminalTaskStatusesSql } from "./taskHistory.js";

import {
  asJsonObject,
  findById,
  insertRow,
  mapNullableTimestamp,
  mapTimestamp,
  updateRow
} from "./sql.js";
import type { JobLane, JobRecord, JobStatus, JsonObject, Queryable } from "./types.js";

interface JobRow extends QueryResultRow {
  id: string;
  type: string;
  status: JobStatus;
  priority: number;
  payload: unknown;
  result: unknown;
  error: string | null;
  progress: number;
  attempts: number;
  maxAttempts: number;
  runAfter: unknown;
  lockedAt: unknown;
  lockedBy: string | null;
  finishedAt: unknown;
  cancelRequestedAt: unknown;
  lane: JobLane;
  dedupeKey: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CreateJobInput {
  type: string;
  payload?: JsonObject;
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
  /** Defaults to `heavy`. */
  lane?: JobLane;
  /** Fails on a key that a queued job already holds; `enqueueDeduped` merges instead. */
  dedupeKey?: string;
}

/**
 * Debounce of a deduped job. A request with a delay moves the start of the queued job to `delayMs`
 * from now, never earlier than it was and never later than `maxDelayMs` after the first request
 * (unless it already was), and not at all once the job is due (`run_after` has passed). A request
 * with `delayMs` 0 is immediate: it makes the job due now and nothing a debounced request does
 * later moves it back.
 */
export interface JobDebounce {
  delayMs: number;
  maxDelayMs: number;
}

export const defaultJobDebounce: Readonly<JobDebounce> = Object.freeze({
  delayMs: 10_000,
  maxDelayMs: 60_000
});

/** An immediate request: the job runs as soon as a worker is free. */
export const immediateJobDebounce: Readonly<JobDebounce> = Object.freeze({
  delayMs: 0,
  maxDelayMs: 0
});

/** Same bound as the `jobs_dedupe_key` check, in code points like `char_length`. */
export const jobDedupeKeyMaxLength = 200;

export interface EnqueueDedupedInput {
  type: string;
  lane: JobLane;
  /** Names the work, for example `topic-place:<tree>:<root>`; the queued job keeps its payload. */
  dedupeKey: string;
  payload?: JsonObject;
  priority?: number;
  maxAttempts?: number;
  debounce?: JobDebounce;
}

export interface UpdateJobInput {
  status?: JobStatus;
  priority?: number;
  payload?: JsonObject;
  result?: JsonObject | null;
  error?: string | null;
  progress?: number;
  attempts?: number;
  maxAttempts?: number;
  runAfter?: Date;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  finishedAt?: Date | null;
  cancelRequestedAt?: Date | null;
}

const returning = [
  "id",
  "type",
  "status",
  "priority",
  "payload",
  "result",
  "error",
  "progress",
  "attempts",
  'max_attempts as "maxAttempts"',
  'run_after as "runAfter"',
  'locked_at as "lockedAt"',
  'locked_by as "lockedBy"',
  'finished_at as "finishedAt"',
  'cancel_requested_at as "cancelRequestedAt"',
  "lane",
  'dedupe_key as "dedupeKey"',
  'created_at as "createdAt"',
  'updated_at as "updatedAt"'
].join(", ");

function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    priority: Number(row.priority),
    payload: asJsonObject(row.payload),
    result: row.result === null ? null : asJsonObject(row.result),
    error: row.error,
    progress: Number(row.progress) / 10_000,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.maxAttempts),
    runAfter: mapTimestamp(row.runAfter),
    lockedAt: mapNullableTimestamp(row.lockedAt),
    lockedBy: row.lockedBy,
    finishedAt: mapNullableTimestamp(row.finishedAt),
    cancelRequestedAt: mapNullableTimestamp(row.cancelRequestedAt),
    lane: row.lane,
    dedupeKey: row.dedupeKey,
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

/** Re-embeds one atomic note after its text changed; background work that never calls a generative model. */
export const noteEmbeddingJobType = "note-embedding";
/** Short job: it runs ahead of the long ingestion jobs that were queued before it. */
const noteEmbeddingJobPriority = 10;

function assertDedupeInput(input: EnqueueDedupedInput, debounce: JobDebounce): void {
  const keyLength = Array.from(input.dedupeKey).length;
  if (keyLength < 1 || keyLength > jobDedupeKeyMaxLength) throw new Error("job_dedupe_key_invalid");
  if (input.lane !== "heavy" && input.lane !== "light") throw new Error("job_lane_invalid");
  const { delayMs, maxDelayMs } = debounce;
  if (
    !Number.isFinite(delayMs) ||
    !Number.isFinite(maxDelayMs) ||
    delayMs < 0 ||
    maxDelayMs < delayMs
  )
    throw new Error("job_debounce_invalid");
}

export function createJobRepository(db: Queryable) {
  return {
    /**
     * Queues the re-embedding of a note unless one is already waiting for it. A queued job reads
     * the note when it runs, so it covers every edit made before then; a running job may have read
     * the text before the edit, so it does not count. Call it inside the editing transaction: the
     * lock then makes concurrent edits of one note queue a single job.
     */
    async enqueueNoteEmbedding(input: {
      atomicNoteId: string;
      sourceItemId: string;
    }): Promise<boolean> {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
        `${noteEmbeddingJobType}:${input.atomicNoteId}`
      ]);
      const result = await db.query(
        `insert into jobs (type, priority, payload)
         select $1, $2, jsonb_build_object('atomicNoteId', $3::text, 'sourceItemId', $4::text)
          where not exists (
            select 1 from jobs
             where type = $1 and status = 'queued' and payload->>'atomicNoteId' = $3::text
          )`,
        [noteEmbeddingJobType, noteEmbeddingJobPriority, input.atomicNoteId, input.sourceItemId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    /**
     * Queues the re-embedding of many notes in one statement after the embedding space changed
     * (D26), skipping notes that already have a queued job for the same space (a job of another
     * space ends without a call). `spaceKey` names the space the jobs embed into: a job skips a
     * note only when a vector of its text exists in that space.
     */
    async enqueueNoteEmbeddings(
      notes: readonly { atomicNoteId: string; sourceItemId: string }[],
      options: { spaceKey?: string } = {}
    ): Promise<number> {
      if (notes.length === 0) return 0;
      const result = await db.query(
        `insert into jobs (type, priority, payload)
         select $1, $2, jsonb_build_object('atomicNoteId', n.id, 'sourceItemId', n.source)
                  || case when $5::text is null then '{}'::jsonb
                          else jsonb_build_object('spaceKey', $5::text) end
           from unnest($3::text[], $4::text[]) as n(id, source)
          where not exists (
            select 1 from jobs
             where type = $1 and status = 'queued' and payload->>'atomicNoteId' = n.id
               and payload->>'spaceKey' is not distinct from $5::text
          )`,
        [
          noteEmbeddingJobType,
          noteEmbeddingJobPriority,
          notes.map((note) => note.atomicNoteId),
          notes.map((note) => note.sourceItemId),
          options.spaceKey ?? null
        ]
      );
      return result.rowCount ?? 0;
    },

    /**
     * How many `note-embedding` jobs that named the space `spaceKey` stored a vector (D26), only
     * those finished at or after `since` when it is given.
     */
    async countSpaceEmbeddings(spaceKey: string, since?: Date): Promise<number> {
      const result = await db.query<QueryResultRow & { count: number }>(
        `select count(*)::int as count from jobs
          where type = $1 and status = 'succeeded' and payload->>'spaceKey' = $2
            and result->>'embedded' = 'true'
            and ($3::timestamptz is null or finished_at >= $3)`,
        [noteEmbeddingJobType, spaceKey, since ?? null]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /** Whether a `note-embedding` job that names the space `spaceKey` is queued or running. */
    async hasOpenSpaceEmbeddings(spaceKey: string): Promise<boolean> {
      const result = await db.query<QueryResultRow & { open: boolean }>(
        `select exists (select 1 from jobs where type = $1 and status in ('queued', 'running')
            and payload->>'spaceKey' = $2) as open`,
        [noteEmbeddingJobType, spaceKey]
      );
      return result.rows[0]?.open === true;
    },

    async create(input: CreateJobInput): Promise<JobRecord> {
      const row = await insertRow<JobRow>(
        db,
        "jobs",
        {
          type: input.type,
          payload: input.payload ?? {},
          priority: input.priority ?? 0,
          max_attempts: input.maxAttempts ?? 3,
          run_after: input.runAfter,
          lane: input.lane,
          dedupe_key: input.dedupeKey
        },
        returning
      );
      return mapJob(row);
    },

    /**
     * Queues a job unless one with the same key is already queued; then that job absorbs the
     * request and its start moves by the merge rule, which depends on the order of requests only
     * through whether the job is due (`run_after <= now`, exactly what `claimNext` claims):
     * - an immediate request (`delayMs` 0) sets `run_after = least(run_after, now)`, so the job is
     *   due now;
     * - a debounced request leaves a due job as it is, so nothing postpones a job that is due,
     *   and otherwise moves `run_after` forward by the debounce, up to the cap after `created_at`.
     * "Due" is derived from `run_after`, not stored: a second marker could disagree with it.
     * A running job never absorbs a request: it may have read its inputs already, so a new queued
     * job is created next to it. Safe under any number of concurrent callers (one insert-or-update
     * on the partial unique index; the merge reads the clock after it holds the row).
     */
    async enqueueDeduped(
      input: EnqueueDedupedInput
    ): Promise<{ job: JobRecord; created: boolean }> {
      const debounce = input.debounce ?? defaultJobDebounce;
      assertDedupeInput(input, debounce);
      const result = await db.query<JobRow & { created: boolean }>(
        `insert into jobs as j (type, lane, dedupe_key, priority, payload, max_attempts, run_after)
         values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::double precision))
         on conflict (dedupe_key) where dedupe_key is not null and status = 'queued'
         do update set
           run_after = case
             when $7::double precision <= 0 then least(j.run_after, clock_timestamp())
             when j.run_after <= clock_timestamp() then j.run_after
             else greatest(
               j.run_after,
               least(excluded.run_after, j.created_at + make_interval(secs => $8::double precision))
             )
           end,
           updated_at = now()
         where j.type = excluded.type and j.lane = excluded.lane
         returning ${returning}, (j.xmax = 0) as created`,
        [
          input.type,
          input.lane,
          input.dedupeKey,
          input.priority ?? 0,
          sanitizeStoredValue(input.payload ?? {}),
          input.maxAttempts ?? 3,
          debounce.delayMs / 1000,
          debounce.maxDelayMs / 1000
        ]
      );
      const row = result.rows[0];
      // The key is queued for another type or lane: a caller bug, never merged silently.
      if (!row) throw new Error("job_dedupe_key_conflict");
      return { job: mapJob(row), created: row.created === true };
    },

    async latestByType(type: string): Promise<JobRecord | null> {
      const result = await db.query<JobRow>(
        `select ${returning} from jobs where type = $1 order by (status in ('queued', 'running')) desc, created_at desc limit 1`,
        [type]
      );
      return result.rows[0] ? mapJob(result.rows[0]) : null;
    },

    async findById(id: string): Promise<JobRecord | null> {
      const row = await findById<JobRow>(db, "jobs", id, returning);
      return row ? mapJob(row) : null;
    },

    async update(id: string, input: UpdateJobInput): Promise<JobRecord | null> {
      const row = await updateRow<JobRow>(
        db,
        "jobs",
        id,
        {
          status: input.status,
          priority: input.priority,
          payload: input.payload,
          result: input.result,
          error: input.error,
          progress: input.progress === undefined ? undefined : Math.round(input.progress * 10_000),
          attempts: input.attempts,
          max_attempts: input.maxAttempts,
          run_after: input.runAfter,
          locked_at: input.lockedAt,
          locked_by: input.lockedBy,
          finished_at: input.finishedAt,
          cancel_requested_at: input.cancelRequestedAt
        },
        returning
      );
      return row ? mapJob(row) : null;
    },

    async listQueued(limit = 25): Promise<JobRecord[]> {
      const result = await db.query<JobRow>(
        `select ${returning}
         from jobs
         where status = 'queued' and run_after <= now()
         order by priority desc, run_after asc
         limit $1`,
        [limit]
      );
      return result.rows.map(mapJob);
    },

    async list(limit?: number): Promise<JobRecord[]> {
      const result = await db.query<JobRow>(
        `select ${returning} from jobs
         where payload->>'dashboardDismissedAt' is null or status in ('queued', 'running')
         order by created_at desc limit $1`,
        [limit ?? 100]
      );
      return result.rows.map(mapJob);
    },

    /** The queued and running jobs of a processing batch: its runs' ingestion jobs and batch jobs. */
    async activeIdsForBatch(batchId: string): Promise<string[]> {
      const result = await db.query<{ id: string }>(
        `select distinct j.id
         from jobs j
         left join ingestion_runs r on j.id = r.job_id or j.payload->>'ingestionRunId' = r.id::text
         where (r.batch_id = $1 or j.payload->>'batchId' = $1::text)
           and j.status in ('queued', 'running')`,
        [batchId]
      );
      return result.rows.map((row) => row.id);
    },
    /**
     * Claims the next due job, optionally of one lane and of the given types. The order matches
     * `jobs_lane_queue_idx`, so a lane claim reads the index in order. The claimed job drops its
     * dedupe key: from now on a request for the same work queues a new job.
     */
    async claimNext(
      workerId: string,
      allowedTypes?: readonly string[],
      lane?: JobLane
    ): Promise<JobRecord | null> {
      const values: unknown[] = [workerId];
      const filters: string[] = [];
      if (lane) {
        values.push(lane);
        filters.push(`and lane = $${values.length}`);
      }
      if (allowedTypes) {
        values.push([...allowedTypes]);
        filters.push(`and type = any($${values.length}::text[])`);
      }
      const result = await db.query<JobRow>(
        `with candidate as (
           select id from jobs
           where status = 'queued' and run_after <= now() ${filters.join(" ")}
           order by priority desc, run_after asc
           for update skip locked
           limit 1
         )
         update jobs
         set status = 'running', locked_at = now(), locked_by = $1,
             attempts = attempts + 1, dedupe_key = null, updated_at = now()
         where id = (select id from candidate)
         returning ${returning}`,
        values
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    },

    async reportProgress(id: string, progress: number): Promise<JobRecord | null> {
      return this.update(id, { progress: Math.max(0, Math.min(1, progress)) });
    },

    async setAiExecution(
      id: string,
      input: {
        provider: string;
        modelId: string;
        reasoningLevel: string | null;
      }
    ): Promise<JobRecord | null> {
      const result = await db.query<JobRow>(
        `update jobs set
           payload = jsonb_set(payload, '{aiExecution}', $2::jsonb, true),
           updated_at = now()
         where id = $1
         returning ${returning}`,
        [id, input]
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    },

    async requestCancel(id: string): Promise<JobRecord | null> {
      const result = await db.query<JobRow>(
        `update jobs
         set status = case when status = 'queued' then 'canceled'::job_status else status end,
             cancel_requested_at = now(),
             finished_at = case when status = 'queued' then now() else finished_at end,
             updated_at = now()
         where id = $1 and status in ('queued', 'running')
         returning ${returning}`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    },

    async retry(id: string): Promise<JobRecord | null> {
      const result = await db.query<JobRow>(
        `update jobs
         set status = 'queued', result = null, error = null, progress = 0, run_after = now(),
             payload = payload - 'dashboardDismissedAt',
             attempts = 0, dedupe_key = null,
             locked_at = null, locked_by = null, finished_at = null,
             cancel_requested_at = null, updated_at = now()
         where id = $1 and status in ('failed', 'canceled', 'succeeded')
         returning ${returning}`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    },

    async clearCompletedOrFailed(): Promise<number> {
      const result = await db.query(
        `with cutoff as (
           insert into settings(key,value) values($1,jsonb_build_object('before',clock_timestamp()))
           on conflict(key) do update set value=excluded.value,updated_at=now() returning value
         ) update jobs j
         set payload = jsonb_set(j.payload, '{dashboardDismissedAt}', (select value->'before' from cutoff))
         where j.status in ('succeeded', 'failed', 'canceled')
           and j.payload->>'dashboardDismissedAt' is null
           and not exists(select 1 from organization_runs r where r.job_id=j.id and r.status not in ${terminalTaskStatusesSql})
           and not exists(select 1 from maintenance_runs r where r.job_id=j.id and r.status not in ${terminalTaskStatusesSql})
           and not exists(select 1 from ingestion_runs r where r.job_id=j.id and r.status::text not in ${terminalTaskStatusesSql})`,
        [taskHistoryCutoffKey]
      );
      return result.rowCount ?? 0;
    },

    async recoverStale(staleAfterSeconds = 60): Promise<number> {
      const result = await db.query(
        `update jobs
         set status = case
               when cancel_requested_at is not null then 'canceled'::job_status
               when attempts < max_attempts then 'queued'::job_status
               else 'failed'::job_status
             end,
             error = case
               when cancel_requested_at is not null or attempts < max_attempts then error
               else coalesce(error, 'worker_crashed')
             end,
             finished_at = case when cancel_requested_at is not null or attempts >= max_attempts then now() else null end,
             run_after = now(), locked_at = null, locked_by = null, updated_at = now()
         where status = 'running'
           and locked_at < now() - make_interval(secs => $1)`,
        [staleAfterSeconds]
      );
      return result.rowCount ?? 0;
    },

    async recoverInterrupted(): Promise<number> {
      const result = await db.query(
        `update jobs
         set status = case
               when cancel_requested_at is not null then 'canceled'::job_status
               when attempts < max_attempts then 'queued'::job_status
               else 'failed'::job_status
             end,
             error = case
               when cancel_requested_at is not null or attempts < max_attempts then error
               else coalesce(error, 'worker_crashed')
             end,
             finished_at = case when cancel_requested_at is not null or attempts >= max_attempts then now() else null end,
             run_after = now(), locked_at = null, locked_by = null, updated_at = now()
         where status = 'running'`
      );
      return result.rowCount ?? 0;
    }
  };
}
