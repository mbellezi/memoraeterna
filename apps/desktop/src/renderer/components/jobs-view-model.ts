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
    const status = mainJob.status === "queued" && mainJob.attempts > 0 && errors.length > 0
      ? "retrying" as const
      : mainJob.status;
    return {
      id,
      mainJob,
      jobs: groupedJobs,
      ingestionRun,
      source: groupedJobs.find((job) => job.source)?.source ?? null,
      status,
      progress: mainJob.progress,
      updatedAt: groupedJobs.map((job) => job.updatedAt).toSorted().at(-1) ?? mainJob.updatedAt,
      errors
    };
  }).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
