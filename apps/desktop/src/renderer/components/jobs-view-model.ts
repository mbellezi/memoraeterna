import type { JobRecord } from "../../shared/ipc";

export type JobFilter = "all" | "active" | "completed" | "attention";

export const preparationStages = [
  "conversion",
  "structureDetection",
  "structureReview",
  "materialization"
] as const;

export function collapsePreparationStages(stages: readonly string[]): string[] {
  const preparation = new Set<string>(preparationStages);
  const collapsed: string[] = [];
  for (const stage of stages) {
    if (preparation.has(stage)) {
      if (!collapsed.includes("preparation")) collapsed.push("preparation");
    } else {
      collapsed.push(stage);
    }
  }
  return collapsed;
}

export interface JobCardModel {
  id: string;
  mainJob: JobRecord;
  jobs: JobRecord[];
  ingestionRun: NonNullable<JobRecord["ingestionRun"]> | null;
  source: NonNullable<JobRecord["source"]> | null;
  status: JobRecord["status"] | "retrying";
  progress: number;
  updatedAt: string;
  errors: JobRecord["errorHistory"];
}

export function groupJobs(jobs: JobRecord[]): JobCardModel[] {
  const groups = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    const key = job.ingestionRun?.id ?? job.id;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  return [...groups.entries()].map(([id, groupedJobs]) => {
    const mainJob = groupedJobs.find((job) => job.type === "ingestion") ?? groupedJobs[0]!;
    const ingestionRun = groupedJobs.find((job) => job.ingestionRun)?.ingestionRun ?? null;
    const childErrors = groupedJobs.filter((job) => job.type !== "ingestion").flatMap((job) => job.errorHistory);
    const errors = deduplicateErrors(childErrors.length > 0 ? childErrors : mainJob.errorHistory);
    const matching = deferredStagePresentation(mainJob,ingestionRun);
    const status = matching?.status ?? (mainJob.status === "queued" && mainJob.attempts > 0 && errors.length > 0
      ? "retrying" as const
      : mainJob.status);
    return {
      id,
      mainJob,
      jobs: groupedJobs,
      ingestionRun,
      source: groupedJobs.find((job) => job.source)?.source ?? null,
      status,
      progress: matching?.progress ?? mainJob.progress,
      updatedAt: groupedJobs.map((job) => job.updatedAt).toSorted().at(-1) ?? mainJob.updatedAt,
      errors
    };
  }).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function deferredStagePresentation(mainJob: JobRecord, run: JobCardModel["ingestionRun"]): {status: JobRecord["status"]; progress:number} | null {
  if (!run || mainJob.type !== "ingestion") return null;
  const deferredStages = ["atomicNoteMatching","sourceMatching"];
  const stage = deferredStages.includes(run.currentStage) ? run.currentStage : mainJob.status === "succeeded"
    ? deferredStages.find((key) => {
      const saved = run.stagesCheckpoint[key] as {status?:unknown} | undefined;
      return saved && !["completed","skipped"].includes(String(saved.status));
    }) : undefined;
  if (!stage) return null;
  const checkpoint = run.stagesCheckpoint[stage];
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const state = checkpoint as Record<string,unknown>;
  const fraction = typeof state.progress === "number" && Number.isFinite(state.progress) ? Math.max(0,Math.min(1,state.progress)) : 0;
  const base = stage === "sourceMatching" ? 0.95 : 0.89;
  if (state.status === "waiting_for_batch" || state.status === "pending") return {status:"queued",progress:base};
  if (state.status === "running" || state.status === "failed" || state.status === "canceled") return {status:state.status,progress:base + fraction * (stage === "sourceMatching" ? 0.04 : 0.06)};
  if (state.status === "completed" && run.effectiveStages.every((key) => {
    const other = run.stagesCheckpoint[key] as {status?: unknown} | undefined;
    return key === stage || other?.status === "completed" || other?.status === "skipped";
  })) return {status:"succeeded",progress:1};
  return null;
}

export function matchesFilter(card: JobCardModel, filter: JobFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return card.status === "queued" || card.status === "running" || card.status === "retrying";
  if (filter === "completed") return card.status === "succeeded";
  return card.status === "failed" || card.status === "canceled";
}

export function listActivityJobs(card: JobCardModel): JobRecord[] {
  if (card.mainJob.type !== "ingestion") return card.jobs;
  return card.jobs.filter((job) => job.id !== card.mainJob.id);
}

function deduplicateErrors(errors: JobRecord["errorHistory"]): JobRecord["errorHistory"] {
  const seen = new Set<string>();
  return errors.filter((error) => {
    const key = `${error.message}:${error.stage}:${error.attempt}:${error.occurredAt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}
