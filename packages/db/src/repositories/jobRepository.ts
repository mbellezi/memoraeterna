import type { QueryResultRow } from "pg";

import {
  asJsonObject,
  findById,
  insertRow,
  listRows,
  mapNullableTimestamp,
  mapTimestamp,
  updateRow
} from "./sql.js";
import type { JobRecord, JobStatus, JsonObject, Queryable } from "./types.js";

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
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CreateJobInput {
  type: string;
  payload?: JsonObject;
  priority?: number;
  maxAttempts?: number;
  runAfter?: Date;
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
  "max_attempts as \"maxAttempts\"",
  "run_after as \"runAfter\"",
  "locked_at as \"lockedAt\"",
  "locked_by as \"lockedBy\"",
  "finished_at as \"finishedAt\"",
  "cancel_requested_at as \"cancelRequestedAt\"",
  "created_at as \"createdAt\"",
  "updated_at as \"updatedAt\""
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
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createJobRepository(db: Queryable) {
  return {
    async create(input: CreateJobInput): Promise<JobRecord> {
      const row = await insertRow<JobRow>(
        db,
        "jobs",
        {
          type: input.type,
          payload: input.payload ?? {},
          priority: input.priority ?? 0,
          max_attempts: input.maxAttempts ?? 3,
          run_after: input.runAfter
        },
        returning
      );
      return mapJob(row);
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
      const rows = await listRows<JobRow>(db, "jobs", returning, limit);
      return rows.map(mapJob);
    },

    async claimNext(workerId: string): Promise<JobRecord | null> {
      const result = await db.query<JobRow>(
        `with candidate as (
           select id from jobs
           where status = 'queued' and run_after <= now()
           order by priority desc, run_after asc
           for update skip locked
           limit 1
         )
         update jobs
         set status = 'running', locked_at = now(), locked_by = $1,
             attempts = attempts + 1, updated_at = now()
         where id = (select id from candidate)
         returning ${returning}`,
        [workerId]
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
    },

    async reportProgress(id: string, progress: number): Promise<JobRecord | null> {
      return this.update(id, { progress: Math.max(0, Math.min(1, progress)) });
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
         set status = 'queued', error = null, progress = 0, run_after = now(),
             locked_at = null, locked_by = null, finished_at = null,
             cancel_requested_at = null, updated_at = now()
         where id = $1 and status = 'failed' and attempts < max_attempts
         returning ${returning}`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapJob(row) : null;
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
    }
  };
}
