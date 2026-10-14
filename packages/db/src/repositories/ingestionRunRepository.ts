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
  batchId: string | null;
  runKind: IngestionRunRecord["runKind"];
  requestedStages: unknown;
  effectiveStages: unknown;
  planVersion: string;
  inputDocumentRevisionId: string | null;
  inputHashes: unknown;
  supersedesRunId: string | null;
  previousArtifactPolicy: string;
  trigger: string;
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
  batchId?: string | null;
  runKind?: IngestionRunRecord["runKind"];
  requestedStages?: string[];
  effectiveStages?: string[];
  planVersion?: string;
  inputDocumentRevisionId?: string | null;
  inputHashes?: JsonObject;
  supersedesRunId?: string | null;
  previousArtifactPolicy?: string;
  trigger?: string;
  status?: IngestionRunStatus;
  currentStage?: string;
  stagesCheckpoint?: JsonObject;
  startedAt?: Date | null;
}

export interface UpdateIngestionRunInput {
  sourceItemId?: string | null;
  jobId?: string | null;
  batchId?: string | null;
  status?: IngestionRunStatus;
  currentStage?: string;
  stagesCheckpoint?: JsonObject;
  inputHashes?: JsonObject;
  error?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

const returning = [
  "id",
  'source_item_id as "sourceItemId"',
  'job_id as "jobId"',
  'batch_id as "batchId"',
  'run_kind as "runKind"',
  'requested_stages as "requestedStages"',
  'effective_stages as "effectiveStages"',
  'plan_version as "planVersion"',
  'input_document_revision_id as "inputDocumentRevisionId"',
  'input_hashes as "inputHashes"',
  'supersedes_run_id as "supersedesRunId"',
  'previous_artifact_policy as "previousArtifactPolicy"',
  "trigger",
  "status",
  'current_stage as "currentStage"',
  'stages_checkpoint as "stagesCheckpoint"',
  "error",
  'started_at as "startedAt"',
  'completed_at as "completedAt"',
  'created_at as "createdAt"',
  'updated_at as "updatedAt"'
].join(", ");

function mapIngestionRun(row: IngestionRunRow): IngestionRunRecord {
  return {
    id: row.id,
    sourceItemId: row.sourceItemId,
    jobId: row.jobId,
    batchId: row.batchId,
    runKind: row.runKind,
    requestedStages: Array.isArray(row.requestedStages) ? row.requestedStages : [],
    effectiveStages: Array.isArray(row.effectiveStages) ? row.effectiveStages : [],
    planVersion: row.planVersion,
    inputDocumentRevisionId: row.inputDocumentRevisionId,
    inputHashes: asJsonObject(row.inputHashes),
    supersedesRunId: row.supersedesRunId,
    previousArtifactPolicy: row.previousArtifactPolicy,
    trigger: row.trigger,
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

/**
 * Attempt accounting for a stage row that is entering `running`. An attempt is open while the row is
 * running and has not ended; only a transition from any other state opens a new one. Progress
 * updates of an open attempt leave its counters alone.
 */
const attemptTimingAssignments = `
  attempts = case
    when ingestion_run_stages.status = 'running' and ingestion_run_stages.ended_at is null
      then greatest(ingestion_run_stages.attempts, 1)
    else ingestion_run_stages.attempts + 1
  end,
  attempt_started_at = case
    when ingestion_run_stages.status = 'running' and ingestion_run_stages.ended_at is null
      then coalesce(ingestion_run_stages.attempt_started_at, now())
    else now()
  end,
  ended_at = null`;

/** Ends the open attempt of a stage row; a row that never began keeps `ended_at` null. */
function attemptEndAssignment(alias: string): string {
  return `case when ${alias}.status = 'running' and ${alias}.ended_at is null then now() else ${alias}.ended_at end`;
}

/**
 * A run the rest of its batch no longer waits for: it failed or was canceled and no job is left to
 * retry it. A failed run whose job is queued or running again is still coming back, so it is not
 * abandoned. `run` and `job` are the aliases of `ingestion_runs` and its (left-joined) `jobs` row.
 */
function abandonedRun(run: string, job: string): string {
  return `((${run}.status in ('failed', 'canceled') or ${job}.status in ('failed', 'canceled'))
    and coalesce(${job}.status::text, '') not in ('queued', 'running'))`;
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
          batch_id: input.batchId ?? null,
          run_kind: input.runKind ?? "initial",
          requested_stages: JSON.stringify(input.requestedStages ?? []),
          effective_stages: JSON.stringify(input.effectiveStages ?? []),
          plan_version: input.planVersion ?? "1",
          input_document_revision_id: input.inputDocumentRevisionId ?? null,
          input_hashes: input.inputHashes ?? {},
          supersedes_run_id: input.supersedesRunId ?? null,
          previous_artifact_policy: input.previousArtifactPolicy ?? "reuse_valid",
          trigger: input.trigger ?? "interactive_import",
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
          batch_id: input.batchId,
          status: input.status,
          current_stage: input.currentStage,
          stages_checkpoint: input.stagesCheckpoint,
          input_hashes: input.inputHashes,
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

    async listByBatch(batchId: string): Promise<IngestionRunRecord[]> {
      const result = await db.query<IngestionRunRow>(
        `select ${returning} from ingestion_runs where batch_id = $1 order by created_at asc`,
        [batchId]
      );
      return result.rows.map(mapIngestionRun);
    },

    /** The runs of a batch that still take part in its collective stages (not abandoned). */
    async listBatchParticipants(batchId: string): Promise<IngestionRunRecord[]> {
      const result = await db.query<IngestionRunRow>(
        `select ${returning} from ingestion_runs
         where batch_id = $1 and not exists (
           select 1 from ingestion_runs run left join jobs job on job.id = run.job_id
           where run.id = ingestion_runs.id and ${abandonedRun("run", "job")}
         )
         order by created_at asc`,
        [batchId]
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
      await db.query(
        `insert into ingestion_run_stages (
           ingestion_run_id, stage, status, progress, started_at, attempts, attempt_started_at
         ) values ($1, $2, 'running', 0, now(), 1, now())
         on conflict (ingestion_run_id, stage) do update
         set ${attemptTimingAssignments},
             status = 'running', started_at = coalesce(ingestion_run_stages.started_at, now()),
             error = null, updated_at = now()`,
        [id, stage]
      );
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
      await db.query(
        `insert into ingestion_run_stages (
           ingestion_run_id, stage, status, progress, metadata, started_at, attempts, attempt_started_at
         ) values ($1, $2, 'running', $3, $4::jsonb, now(), 1, now())
         on conflict (ingestion_run_id, stage) do update
         set ${attemptTimingAssignments},
             status = 'running', progress = excluded.progress, metadata = excluded.metadata,
             started_at = coalesce(ingestion_run_stages.started_at, now()), updated_at = now()`,
        [id, stage, Math.round(Math.max(0, Math.min(1, progress)) * 10_000), metadata]
      );
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
      await db.query(
        `insert into ingestion_run_stages (ingestion_run_id, stage, status, progress, metadata, completed_at, ended_at)
         values ($1, $2, 'completed', 10000, $3::jsonb, now(), now())
         on conflict (ingestion_run_id, stage) do update
         set status = 'completed', progress = 10000, metadata = excluded.metadata,
             completed_at = now(), ended_at = now(), error = null, updated_at = now()`,
        [id, stage, metadata]
      );
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

    async skipStage(id: string, stage: string, reason: string): Promise<IngestionRunRecord | null> {
      await db.query(
        `insert into ingestion_run_stages (ingestion_run_id, stage, status, skip_reason, progress, completed_at, ended_at)
         values ($1, $2, 'skipped', $3, 10000, now(), now())
         on conflict (ingestion_run_id, stage) do update
         set status = 'skipped', skip_reason = excluded.skip_reason, progress = 10000,
             completed_at = now(), ended_at = now(), updated_at = now()`,
        [id, stage, reason]
      );
      const result = await db.query<IngestionRunRow>(
        `update ingestion_runs set stages_checkpoint = jsonb_set(
           stages_checkpoint, array[$2], jsonb_build_object(
             'status', 'skipped', 'reason', $3::text, 'completedAt', now(), 'metadata', '{}'::jsonb
           ), true), updated_at = now()
         where id = $1 returning ${returning}`,
        [id, stage, reason]
      );
      const row = result.rows[0];
      return row ? mapIngestionRun(row) : null;
    },

    async initializeStages(
      id: string,
      effectiveStages: readonly string[],
      allStages: readonly string[]
    ): Promise<void> {
      for (const stage of allStages) {
        const requested = effectiveStages.includes(stage);
        await db.query(
          `insert into ingestion_run_stages (ingestion_run_id, stage, status, skip_reason, progress, completed_at, ended_at)
           values ($1, $2, $3::ingestion_run_stage_status, $4, $5, $6, $6)
           on conflict (ingestion_run_id, stage) do nothing`,
          [
            id,
            stage,
            requested ? "pending" : "skipped",
            requested ? null : "not_requested",
            requested ? 0 : 10000,
            requested ? null : new Date()
          ]
        );
      }
    },

    async waitForBatchStage(id: string, stage: string, metadata: JsonObject = {}): Promise<void> {
      await db.query(
        `update ingestion_run_stages set status = 'waiting_for_review', skip_reason = 'batch_barrier', metadata=$3,
           ended_at = ${attemptEndAssignment("ingestion_run_stages")}, updated_at = now()
         where ingestion_run_id = $1 and stage = $2`,
        [id, stage, metadata]
      );
      await db.query(
        `update ingestion_runs set stages_checkpoint = jsonb_set(
           stages_checkpoint, array[$2], jsonb_build_object('status', 'waiting_for_batch', 'metadata', $3::jsonb), true
         ), updated_at = now() where id = $1`,
        [id, stage, metadata]
      );
    },

    /**
     * How many runs of the batch still have to finish `stage` before a collective stage may start.
     * One failed or canceled sibling never holds back the others: an abandoned run is settled, and
     * so is a stage that failed or was canceled unless its job is queued or running again.
     */
    async countIncompleteBatchStage(batchId: string, stage: string): Promise<number> {
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from ingestion_runs run
         join ingestion_run_stages stage_state on stage_state.ingestion_run_id = run.id and stage_state.stage = $2
         left join jobs job on job.id = run.job_id
         where run.batch_id = $1
           and (stage_state.status in ('pending', 'running', 'waiting_for_review')
             or (stage_state.status in ('failed', 'canceled') and job.status in ('queued', 'running')))
           and not ${abandonedRun("run", "job")}`,
        [batchId, stage]
      );
      return Number(result.rows[0]?.count ?? 0);
    },

    /**
     * The finished run of a batch that parked its collective matching behind a sibling, when nothing
     * is left in the batch that could still run it: its job is the one to run again. Null while any
     * run of the batch is pending, running or waiting for a retry.
     */
    async findReleasableBatchRun(
      batchId: string
    ): Promise<{ runId: string; jobId: string } | null> {
      const result = await db.query<{ runId: string; jobId: string }>(
        `select run.id as "runId", run.job_id as "jobId"
         from ingestion_runs run join jobs job on job.id = run.job_id
         where run.batch_id = $1 and job.status = 'succeeded'
           and exists (
             select 1 from ingestion_run_stages stage_state
             where stage_state.ingestion_run_id = run.id
               and stage_state.stage in ('atomicNoteMatching', 'sourceMatching')
               and stage_state.status = 'waiting_for_review'
           )
           and not exists (
             select 1 from ingestion_runs other left join jobs other_job on other_job.id = other.job_id
             where other.batch_id = $1 and not ${abandonedRun("other", "other_job")}
               and (other.status in ('pending', 'running') or other_job.status in ('queued', 'running'))
           )
         order by run.updated_at desc, run.id
         limit 1`,
        [batchId]
      );
      return result.rows[0] ?? null;
    },

    async completeStageForBatch(
      batchId: string,
      stage: string,
      metadata: JsonObject = {}
    ): Promise<void> {
      await db.query(
        `update ingestion_run_stages stage_state set status = 'completed', progress = 10000, metadata = $3::jsonb,
           completed_at = now(), ended_at = now(), error = null, updated_at = now()
         from ingestion_runs run
         where run.batch_id = $1 and stage_state.ingestion_run_id = run.id and stage_state.stage = $2
           and stage_state.status <> 'skipped'`,
        [batchId, stage, metadata]
      );
      await db.query(
        `update ingestion_runs set stages_checkpoint = jsonb_set(
           stages_checkpoint, array[$2], jsonb_build_object('status', 'completed', 'completedAt', now(), 'metadata', $3::jsonb), true
         ), updated_at = now()
         where batch_id = $1 and effective_stages ? $2`,
        [batchId, stage, metadata]
      );
    },

    async fail(id: string, error: string): Promise<IngestionRunRecord | null> {
      await db.query(
        `update ingestion_run_stages stage set status = 'failed', error = $2,
           ended_at = ${attemptEndAssignment("stage")}, updated_at = now()
         from ingestion_runs run
         where run.id = $1 and stage.ingestion_run_id = run.id and stage.stage = run.current_stage`,
        [id, error]
      );
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

    async failStage(id: string, stage: string, error: string, canceled = false): Promise<void> {
      const status = canceled ? "canceled" : "failed";
      await db.query(
        `update ingestion_run_stages set status = $3::ingestion_run_stage_status,error = $4,
        ended_at = ${attemptEndAssignment("ingestion_run_stages")},updated_at = now()
        where ingestion_run_id = $1 and stage = $2`,
        [id, stage, status, canceled ? null : error]
      );
      await db.query(
        `update ingestion_runs set stages_checkpoint = jsonb_set(stages_checkpoint,array[$2],
        coalesce(stages_checkpoint->$2,'{}'::jsonb) || jsonb_build_object('status',$3::text,'error',$4::text),true),updated_at = now()
        where id = $1`,
        [id, stage, status, canceled ? null : error]
      );
    },

    async cancel(id: string): Promise<IngestionRunRecord | null> {
      await db.query(
        `update ingestion_run_stages stage set status = 'canceled',
           ended_at = ${attemptEndAssignment("stage")}, updated_at = now()
         from ingestion_runs run
         where run.id = $1 and stage.ingestion_run_id = run.id and stage.stage = run.current_stage`,
        [id]
      );
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
      // Close the attempts that the crash interrupted, so a resumed stage opens a fresh attempt
      // instead of inheriting the downtime.
      await db.query(
        `update ingestion_run_stages as stage
         set ended_at = now(), updated_at = now()
         from ingestion_runs as interrupted
         left join jobs as job on job.id = interrupted.job_id
         where stage.ingestion_run_id = interrupted.id
           and interrupted.status = 'running'
           and job.status is distinct from 'running'
           and stage.status = 'running'
           and stage.ended_at is null`
      );
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
