import type { PgPool } from "../client.js";

export interface ProcessingTaskDeletionResult {
  deletedJobs: number;
  deletedRuns: number;
  batchId: string | null;
  deletedBatch: boolean;
}

interface ProcessingTaskTarget {
  runId: string;
  batchId: string | null;
}

export function createProcessingTaskRepository(pool: PgPool) {
  return {
    async deleteCanceledHierarchy(jobId: string): Promise<ProcessingTaskDeletionResult | null> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const targetResult = await client.query<ProcessingTaskTarget>(
          `select run.id as "runId", run.batch_id as "batchId"
           from jobs job
           join ingestion_runs run
             on run.id::text = job.payload->>'ingestionRunId'
           where job.id = $1
             and job.type = 'ingestion'
             and job.status = 'canceled'
             and job.cancel_requested_at is not null
             and run.status <> 'succeeded'
           for update of job, run`,
          [jobId]
        );
        const target = targetResult.rows[0];
        if (!target) {
          await client.query("commit");
          return null;
        }

        const deletedJobs = await client.query(
          `delete from jobs
           where id = $1 or payload->>'ingestionRunId' = $2`,
          [jobId, target.runId]
        );
        const deletedRuns = await client.query(
          `delete from ingestion_runs where id = $1`,
          [target.runId]
        );

        let deletedBatch = false;
        if (target.batchId) {
          const remainingResult = await client.query<{ count: number }>(
            `select count(*)::int as count from ingestion_runs where batch_id = $1`,
            [target.batchId]
          );
          if (Number(remainingResult.rows[0]?.count ?? 0) === 0) {
            const batchResult = await client.query(
              `delete from processing_batches where id = $1`,
              [target.batchId]
            );
            deletedBatch = (batchResult.rowCount ?? 0) > 0;
          }
        }

        await client.query("commit");
        return {
          deletedJobs: deletedJobs.rowCount ?? 0,
          deletedRuns: deletedRuns.rowCount ?? 0,
          batchId: target.batchId,
          deletedBatch
        };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
