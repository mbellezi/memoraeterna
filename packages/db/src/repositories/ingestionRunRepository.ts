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
import type { IngestionRunRecord, IngestionRunStatus, JsonObject, Queryable } from "./types.js";

interface IngestionRunRow extends QueryResultRow {
  id: string;
  sourceItemId: string | null;
  jobId: string | null;
  status: IngestionRunStatus;
  currentStage: string;
  stagesCheckpoint: unknown;
  error: string | null;
  startedAt: unknown;
  completedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

export interface CreateIngestionRunInput {
  sourceItemId?: string | null;
  jobId?: string | null;
  status?: IngestionRunStatus;
  currentStage?: string;
  stagesCheckpoint?: JsonObject;
  startedAt?: Date | null;
}

export interface UpdateIngestionRunInput {
  sourceItemId?: string | null;
  jobId?: string | null;
  status?: IngestionRunStatus;
  currentStage?: string;
  stagesCheckpoint?: JsonObject;
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

const returning = [
  "id",
  "source_item_id as \"sourceItemId\"",
  "job_id as \"jobId\"",
  "status",
  "current_stage as \"currentStage\"",
  "stages_checkpoint as \"stagesCheckpoint\"",
  "error",
  "started_at as \"startedAt\"",
  "completed_at as \"completedAt\"",
  "created_at as \"createdAt\"",
  "updated_at as \"updatedAt\""
].join(", ");

function mapIngestionRun(row: IngestionRunRow): IngestionRunRecord {
  return {
    id: row.id,
    sourceItemId: row.sourceItemId,
    jobId: row.jobId,
    status: row.status,
    currentStage: row.currentStage,
    stagesCheckpoint: asJsonObject(row.stagesCheckpoint),
    error: row.error,
    startedAt: mapNullableTimestamp(row.startedAt),
    completedAt: mapNullableTimestamp(row.completedAt),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createIngestionRunRepository(db: Queryable) {
  return {
    async create(input: CreateIngestionRunInput): Promise<IngestionRunRecord> {
      const row = await insertRow<IngestionRunRow>(
        db,
        "ingestion_runs",
        {
          source_item_id: input.sourceItemId ?? null,
          job_id: input.jobId ?? null,
          status: input.status ?? "pending",
          current_stage: input.currentStage ?? "queued",
          stages_checkpoint: input.stagesCheckpoint ?? {},
          started_at: input.startedAt
        },
        returning
      );
      return mapIngestionRun(row);
    },

    async findById(id: string): Promise<IngestionRunRecord | null> {
      const row = await findById<IngestionRunRow>(db, "ingestion_runs", id, returning);
      return row ? mapIngestionRun(row) : null;
    },

    async update(id: string, input: UpdateIngestionRunInput): Promise<IngestionRunRecord | null> {
      const row = await updateRow<IngestionRunRow>(
        db,
        "ingestion_runs",
        id,
        {
          source_item_id: input.sourceItemId,
          job_id: input.jobId,
          status: input.status,
          current_stage: input.currentStage,
          stages_checkpoint: input.stagesCheckpoint,
          error: input.error,
          started_at: input.startedAt,
          completed_at: input.completedAt
        },
        returning
      );
      return row ? mapIngestionRun(row) : null;
    },

    async listBySourceItem(sourceItemId: string): Promise<IngestionRunRecord[]> {
      const result = await db.query<IngestionRunRow>(
        `select ${returning} from ingestion_runs where source_item_id = $1 order by created_at desc`,
        [sourceItemId]
      );
      return result.rows.map(mapIngestionRun);
    },

    async list(limit?: number): Promise<IngestionRunRecord[]> {
      const rows = await listRows<IngestionRunRow>(db, "ingestion_runs", returning, limit);
      return rows.map(mapIngestionRun);
    },

    async startOrResume(id: string): Promise<IngestionRunRecord | null> {
      const result = await db.query<IngestionRunRow>(
        `update ingestion_runs
         set status = 'running', started_at = coalesce(started_at, now()),
             error = null, updated_at = now()
         where id = $1 and status in ('pending', 'failed', 'canceled')
         returning ${returning}`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapIngestionRun(row) : null;
    },

    async beginStage(id: string, stage: string): Promise<IngestionRunRecord | null> {
      const result = await db.query<IngestionRunRow>(
        `update ingestion_runs
         set status = 'running', current_stage = $2,
             stages_checkpoint = jsonb_set(
               stages_checkpoint,
               array[$2],
               coalesce(stages_checkpoint -> $2, '{}'::jsonb)
                 || jsonb_build_object(
                      'status', 'running',
                      'startedAt', coalesce(stages_checkpoint -> $2 -> 'startedAt', to_jsonb(now())),
                      'resumedAt', now()
                    ),
               true
             ),
             started_at = coalesce(started_at, now()), error = null, updated_at = now()
         where id = $1
         returning ${returning}`,
        [id, stage]
      );
      const row = result.rows[0];
      return row ? mapIngestionRun(row) : null;
    },

    async updateStageProgress(
      id: string,
      stage: string,
      progress: number,
      metadata: JsonObject = {}
    ): Promise<IngestionRunRecord | null> {
      const result = await db.query<IngestionRunRow>(
        `update ingestion_runs
         set stages_checkpoint = jsonb_set(
               stages_checkpoint,
               array[$2],
               coalesce(stages_checkpoint -> $2, '{}'::jsonb)
                 || jsonb_build_object(
                      'status', 'running',
                      'progress', $3::double precision,
                      'metadata', $4::jsonb,
                      'updatedAt', now()
                    ),
               true
             ),
             updated_at = now()
         where id = $1
         returning ${returning}`,
        [id, stage, Math.max(0, Math.min(1, progress)), metadata]
      );
      const row = result.rows[0];
      return row ? mapIngestionRun(row) : null;
    },

    async completeStage(
      id: string,
      stage: string,
      metadata: JsonObject = {}
    ): Promise<IngestionRunRecord | null> {
      const result = await db.query<IngestionRunRow>(
        `update ingestion_runs
         set stages_checkpoint = jsonb_set(
               stages_checkpoint,
               array[$2],
               jsonb_build_object('status', 'completed', 'completedAt', now(), 'metadata', $3::jsonb),
               true
             ),
             updated_at = now()
         where id = $1
         returning ${returning}`,
        [id, stage, metadata]
      );
      const row = result.rows[0];
      return row ? mapIngestionRun(row) : null;
    },

    async fail(id: string, error: string): Promise<IngestionRunRecord | null> {
      const result = await db.query<IngestionRunRow>(
        `update ingestion_runs
         set status = 'failed', error = $2,
             stages_checkpoint = case
               when stages_checkpoint -> current_stage ->> 'status' = 'running' then
                 jsonb_set(
                   stages_checkpoint,
                   array[current_stage],
                   (stages_checkpoint -> current_stage)
                     || jsonb_build_object('status', 'failed', 'failedAt', now()),
                   true
                 )
               else stages_checkpoint
             end,
             updated_at = now()
         where id = $1
         returning ${returning}`,
        [id, error]
      );
      const row = result.rows[0];
      return row ? mapIngestionRun(row) : null;
    },

    async cancel(id: string): Promise<IngestionRunRecord | null> {
      const result = await db.query<IngestionRunRow>(
        `update ingestion_runs
         set status = 'canceled', error = null,
             stages_checkpoint = case
               when stages_checkpoint -> current_stage ->> 'status' = 'running' then
                 jsonb_set(
                   stages_checkpoint,
                   array[current_stage],
                   (stages_checkpoint -> current_stage)
                     || jsonb_build_object('status', 'canceled', 'canceledAt', now()),
                   true
                 )
               else stages_checkpoint
             end,
             updated_at = now()
         where id = $1
         returning ${returning}`,
        [id]
      );
      const row = result.rows[0];
      return row ? mapIngestionRun(row) : null;
    },

    async complete(id: string): Promise<IngestionRunRecord | null> {
      return this.update(id, {
        status: "succeeded",
        currentStage: "completed",
        completedAt: new Date(),
        error: null
      });
    },

    async listResumable(limit = 25): Promise<IngestionRunRecord[]> {
      const result = await db.query<IngestionRunRow>(
        `select ${returning}
         from ingestion_runs
         where status in ('pending', 'running', 'failed')
         order by updated_at asc
         limit $1`,
        [limit]
      );
      return result.rows.map(mapIngestionRun);
    },

    async recoverInterrupted(): Promise<number> {
      const result = await db.query(
        `update ingestion_runs as run
         set status = case
               when recovered.job_status = 'queued' then 'pending'::ingestion_run_status
               when recovered.job_status = 'canceled' then 'canceled'::ingestion_run_status
               else 'failed'::ingestion_run_status
             end,
             stages_checkpoint = case
               when run.stages_checkpoint -> run.current_stage ->> 'status' = 'running' then
                 jsonb_set(
                   run.stages_checkpoint,
                   array[run.current_stage],
                   (run.stages_checkpoint -> run.current_stage)
                     || jsonb_build_object(
                          'status', case
                            when recovered.job_status = 'queued' then 'pending'
                            when recovered.job_status = 'canceled' then 'canceled'
                            else 'failed'
                          end,
                          'interruptedAt', now()
                        ),
                   true
                 )
               else run.stages_checkpoint
             end,
             error = case
               when recovered.job_status = 'failed' or recovered.job_status is null
                 then coalesce(run.error, recovered.job_error, 'worker_crashed')
               else null
             end,
             completed_at = case when recovered.job_status in ('failed', 'canceled') or recovered.job_status is null then now() else null end,
             updated_at = now()
         from (
           select interrupted.id, job.status as job_status, job.error as job_error
           from ingestion_runs as interrupted
           left join jobs as job on job.id = interrupted.job_id
           where interrupted.status = 'running'
         ) as recovered
         where run.id = recovered.id
           and recovered.job_status is distinct from 'running'`
      );
      return result.rowCount ?? 0;
    }
  };
}
