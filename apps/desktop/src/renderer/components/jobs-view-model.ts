import {
  isRetiredProcessingStage,
  readStoredStageCheckpoint,
  SourceRelationCoverageSchema
} from "@app/domain";
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
  currentStage: string;
  stageError: string | null;
  updatedAt: string;
  errors: JobRecord["errorHistory"];
}

export function groupJobs(jobs: JobRecord[]): JobCardModel[] {
  const groups = new Map<string, JobRecord[]>();
  for (const job of jobs) {
    // Organization and maintenance jobs belong to the retired legacy wiki (F2 D2): nothing runs or
    // shows them, so one left in an old library stays an inert row.
    if (job.type === "organization" || job.type === "maintenance") continue;
    const key = job.ingestionRun?.id ?? job.id;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  return [...groups.entries()]
    .map(([id, groupedJobs]) => {
      const mainJob = groupedJobs.find((job) => job.type === "ingestion") ?? groupedJobs[0]!;
      const ingestionRun = groupedJobs.find((job) => job.ingestionRun)?.ingestionRun ?? null;
      const childErrors = groupedJobs
        .filter((job) => job.type !== "ingestion")
        .flatMap((job) => job.errorHistory);
      const errors = deduplicateErrors(childErrors.length > 0 ? childErrors : mainJob.errorHistory);
      const matching = deferredStagePresentation(mainJob, ingestionRun);
      const status =
        matching?.status ??
        (mainJob.status === "queued" && mainJob.attempts > 0 && errors.length > 0
          ? ("retrying" as const)
          : mainJob.status);
      return {
        id,
        mainJob,
        jobs: groupedJobs,
        ingestionRun,
        source: groupedJobs.find((job) => job.source)?.source ?? null,
        status,
        progress: matching?.progress ?? mainJob.progress,
        currentStage:
          matching?.stage ??
          // Nothing follows a retired stage (F2 D14): a run stored at one has finished the rest.
          (ingestionRun && isRetiredProcessingStage(ingestionRun.currentStage)
            ? "completed"
            : ingestionRun?.currentStage) ??
          mainJob.type,
        stageError: matching?.status === "failed" ? matching.error : null,
        updatedAt:
          groupedJobs
            .map((job) => job.updatedAt)
            .toSorted()
            .at(-1) ?? mainJob.updatedAt,
        errors
      };
    })
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function deferredStagePresentation(
  mainJob: JobRecord,
  run: JobCardModel["ingestionRun"]
): { status: JobRecord["status"]; progress: number; stage: string; error: string | null } | null {
  if (!run || mainJob.type !== "ingestion") return null;
  const deferredStages = ["atomicNoteMatching", "sourceMatching"];
  const stage = deferredStages.includes(run.currentStage)
    ? run.currentStage
    : mainJob.status === "succeeded"
      ? deferredStages.find((key) => {
          const saved = run.stagesCheckpoint[key] as { status?: unknown } | undefined;
          return saved && !["completed", "skipped"].includes(String(saved.status));
        })
      : undefined;
  if (!stage) return null;
  const checkpoint = run.stagesCheckpoint[stage];
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const state = checkpoint as Record<string, unknown>;
  const fraction =
    typeof state.progress === "number" && Number.isFinite(state.progress)
      ? Math.max(0, Math.min(1, state.progress))
      : 0;
  const error = typeof state.error === "string" ? state.error : null;
  const base = stage === "sourceMatching" ? 0.95 : 0.89;
  if (state.status === "waiting_for_batch" || state.status === "pending")
    return { status: "queued", progress: base, stage, error };
  if (state.status === "running" || state.status === "failed" || state.status === "canceled")
    return {
      status: state.status,
      progress: base + fraction * (stage === "sourceMatching" ? 0.04 : 0.06),
      stage,
      error
    };
  if (
    state.status === "completed" &&
    run.effectiveStages.every((key) => {
      // A retired stage (F2 D14) reads as skipped (retired), whatever the run stored for it.
      const other = readStoredStageCheckpoint(key, run.stagesCheckpoint[key]) as
        { status?: unknown } | undefined;
      return key === stage || other?.status === "completed" || other?.status === "skipped";
    })
  )
    return { status: "succeeded", progress: 1, stage, error };
  return null;
}

export function matchesFilter(card: JobCardModel, filter: JobFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active")
    return card.status === "queued" || card.status === "running" || card.status === "retrying";
  if (filter === "completed") return card.status === "succeeded";
  return card.status === "failed" || card.status === "canceled";
}

export function listActivityJobs(card: JobCardModel): JobRecord[] {
  if (card.mainJob.type !== "ingestion") return card.jobs;
  return card.jobs.filter((job) => job.id !== card.mainJob.id);
}

export interface SourceRelationCoverageNotice {
  /** Neutral lines state how far matching went; only a warning reports work that could not finish. */
  tone: "neutral" | "warning";
  messageKey:
    | "sourceRelations.coverage.analysed"
    | "sourceRelations.coverage.relationLimit"
    | "sourceRelations.coverage.incomplete";
  values: { judged: number; candidates: number };
}

/**
 * What the source-matching stage checkpoint says about coverage. The per-run pair cap and the
 * relation limit are normal limits and read neutrally; an exhausted input budget (a pair that could
 * not be completed) is the only warning. Checkpoints written before coverage was recorded, and
 * runs that judged every candidate, show nothing.
 */
export function sourceRelationCoverageNotice(
  checkpoint: unknown
): SourceRelationCoverageNotice | null {
  if (typeof checkpoint !== "object" || checkpoint === null || !("metadata" in checkpoint))
    return null;
  const metadata = checkpoint.metadata;
  if (typeof metadata !== "object" || metadata === null || !("coverage" in metadata)) return null;
  const parsed = SourceRelationCoverageSchema.safeParse(metadata.coverage);
  if (!parsed.success) return null;
  const { judgedPairs: judged, candidatePairs: candidates } = parsed.data;
  const values = { judged, candidates };
  if (parsed.data.budgetExhausted)
    return { tone: "warning", messageKey: "sourceRelations.coverage.incomplete", values };
  if (parsed.data.relationLimitReached)
    return { tone: "neutral", messageKey: "sourceRelations.coverage.relationLimit", values };
  if (parsed.data.capReached)
    return { tone: "neutral", messageKey: "sourceRelations.coverage.analysed", values };
  return null;
}

function deduplicateErrors(errors: JobRecord["errorHistory"]): JobRecord["errorHistory"] {
  const seen = new Set<string>();
  return errors
    .filter((error) => {
      const key = `${error.message}:${error.stage}:${error.attempt}:${error.occurredAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt));
}
