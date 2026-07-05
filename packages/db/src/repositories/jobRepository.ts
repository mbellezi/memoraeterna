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
  attempts: number;
  maxAttempts: number;
  runAfter: unknown;
  lockedAt: unknown;
  lockedBy: string | null;
  finishedAt: unknown;
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
  attempts?: number;
  maxAttempts?: number;
  runAfter?: Date;
  lockedAt?: Date | null;
  lockedBy?: string | null;
  finishedAt?: Date | null;
}

const returning = [
  "id",
  "type",
  "status",
  "priority",
  "payload",
  "result",
  "error",
  "attempts",
  "max_attempts as \"maxAttempts\"",
  "run_after as \"runAfter\"",
  "locked_at as \"lockedAt\"",
  "locked_by as \"lockedBy\"",
  "finished_at as \"finishedAt\"",
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
    attempts: Number(row.attempts),
    maxAttempts: Number(row.maxAttempts),
    runAfter: mapTimestamp(row.runAfter),
    lockedAt: mapNullableTimestamp(row.lockedAt),
    lockedBy: row.lockedBy,
    finishedAt: mapNullableTimestamp(row.finishedAt),
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
          attempts: input.attempts,
          max_attempts: input.maxAttempts,
          run_after: input.runAfter,
          locked_at: input.lockedAt,
          locked_by: input.lockedBy,
          finished_at: input.finishedAt
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
    }
  };
}
