import type { IngestionRunRecord, JobRecord } from "@app/db";

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

export function hasIncompleteIngestionStages(
  ingestionRun: RetryableIngestionRunState
): boolean {
  const sourceMatching = ingestionRun.stagesCheckpoint.sourceMatching;
  return ingestionRun.status !== "succeeded" || (sourceMatching !== undefined && !isCompletedCheckpoint(sourceMatching)) || resumableIngestionStages.some((stage) => {
    const checkpoint = ingestionRun.stagesCheckpoint[stage];
    return !isCompletedCheckpoint(checkpoint);
  });
}

export function canManuallyRetryJob(
  job: RetryableJobState,
  ingestionRun?: RetryableIngestionRunState | null
): boolean {
  if (job.type === "relation-labels") return job.status === "failed" || job.status === "canceled";
  if (job.type !== "ingestion" || !ingestionRun) return false;
  if (job.status === "queued" || job.status === "running") return false;
  const organization = ingestionRun.stagesCheckpoint.organizeKnowledge as { status?: string; metadata?: { organizationRunId?: string } } | undefined;
  if (organization?.metadata?.organizationRunId && ["pending", "waiting_for_batch", "running"].includes(organization.status ?? "")) return false;
  return job.status !== "succeeded" || hasIncompleteIngestionStages(ingestionRun);
}

export function canDeleteCanceledJob(
  job: DeletableJobState,
  ingestionRun?: DeletableIngestionRunState | null
): boolean {
  return job.type === "ingestion"
    && job.status === "canceled"
    && job.cancelRequestedAt !== null
    && ingestionRun !== null
    && ingestionRun !== undefined
    && ingestionRun.status !== "succeeded";
}

function isCompletedCheckpoint(checkpoint: unknown): boolean {
  return typeof checkpoint === "object"
    && checkpoint !== null
    && "status" in checkpoint
    && checkpoint.status === "completed";
}
