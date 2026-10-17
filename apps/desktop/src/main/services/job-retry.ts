import type { IngestionRunRecord, JobRecord } from "@app/db";
import { linkingParkReason, waitingForDeciderSkipReason } from "@app/domain";

export const resumableIngestionStages = [
  "chunking",
  "embedding",
  "summarization",
  "atomicNotes",
  "knowledgeGraph",
  "atomicNoteMatching",
  "obsidianProjection"
] as const;

type RetryableJobState = Pick<JobRecord, "type" | "status">;
type RetryableIngestionRunState = Pick<IngestionRunRecord, "status" | "stagesCheckpoint">;
type DeletableJobState = Pick<JobRecord, "type" | "status" | "cancelRequestedAt">;
type DeletableIngestionRunState = Pick<IngestionRunRecord, "status">;

export function hasIncompleteIngestionStages(ingestionRun: RetryableIngestionRunState): boolean {
  const sourceMatching = ingestionRun.stagesCheckpoint.sourceMatching;
  return (
    ingestionRun.status !== "succeeded" ||
    (sourceMatching !== undefined && !isCompletedCheckpoint(sourceMatching)) ||
    resumableIngestionStages.some((stage) => {
      const checkpoint = ingestionRun.stagesCheckpoint[stage];
      return !isCompletedCheckpoint(checkpoint);
    })
  );
}

export function canManuallyRetryJob(
  job: RetryableJobState,
  ingestionRun?: RetryableIngestionRunState | null
): boolean {
  if (job.type === "relation-labels") return job.status === "failed" || job.status === "canceled";
  if (job.type !== "ingestion" || !ingestionRun) return false;
  if (job.status === "queued" || job.status === "running") return false;
  // A run parked for its link job is still in progress: the link job completes it (F3 D24).
  if (isParkedForLinking(ingestionRun)) return false;
  // A retired stage (F2 D14) reads as skipped, so a run admitted with it never waits on it.
  return job.status !== "succeeded" || hasIncompleteIngestionStages(ingestionRun);
}

export function canDeleteCanceledJob(
  job: DeletableJobState,
  ingestionRun?: DeletableIngestionRunState | null
): boolean {
  return (
    job.type === "ingestion" &&
    job.status === "canceled" &&
    job.cancelRequestedAt !== null &&
    ingestionRun !== null &&
    ingestionRun !== undefined &&
    ingestionRun.status !== "succeeded"
  );
}

/** A run whose `sourceMatching` stage waits for its link job (F3 D24). */
export function isParkedForLinking(ingestionRun: RetryableIngestionRunState): boolean {
  return (
    ingestionRun.status === "running" &&
    checkpointStatus(ingestionRun.stagesCheckpoint.sourceMatching) === linkingParkReason
  );
}

/**
 * The stage-level retry (F3 D25): the stages that re-running `stage` of a finished run puts back
 * to pending, or null when it cannot be retried that way. A matching stage skipped to wait for a
 * validated ranker (C7) takes the matching stages skipped with it; a failed stage (the knowledge
 * graph's, T55k) is re-run alone. Every other stage keeps its checkpoint.
 */
export function stageRetryStages(
  ingestionRun: RetryableIngestionRunState,
  stage: string
): string[] | null {
  if (!["succeeded", "failed", "canceled"].includes(ingestionRun.status)) return null;
  const checkpoint = ingestionRun.stagesCheckpoint[stage];
  if (checkpointStatus(checkpoint) === "failed") return [stage];
  if (!isWaitingForDecider(checkpoint)) return null;
  return ["atomicNoteMatching", "sourceMatching"].filter(
    (other) => other === stage || isWaitingForDecider(ingestionRun.stagesCheckpoint[other])
  );
}

/** A stage skipped to wait for a validated ranker (C7). */
export function isWaitingForDecider(checkpoint: unknown): boolean {
  return (
    checkpointStatus(checkpoint) === "skipped" &&
    typeof checkpoint === "object" &&
    checkpoint !== null &&
    "reason" in checkpoint &&
    checkpoint.reason === waitingForDeciderSkipReason
  );
}

function checkpointStatus(checkpoint: unknown): unknown {
  return typeof checkpoint === "object" && checkpoint !== null && "status" in checkpoint
    ? checkpoint.status
    : undefined;
}

function isCompletedCheckpoint(checkpoint: unknown): boolean {
  return (
    typeof checkpoint === "object" &&
    checkpoint !== null &&
    "status" in checkpoint &&
    checkpoint.status === "completed"
  );
}
