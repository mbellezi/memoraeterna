import type { MessageKey, Translator } from "@app/i18n";

import type { JobRecord } from "../../../shared/ipc";
import { groupJobs, type JobCardModel } from "../../components/jobs-view-model";
import { errorText, formatDuration, formatFull, formatWhen, type PageRead } from "./call-log-model";

/**
 * What the job history shows (F5 T165): the finished runs of the jobs list, an import with its
 * steps as one row, newest first. The grouping is the one the old Jobs screen used
 * (`jobs-view-model`); the words are this page's own. Pure.
 */

export type RunOutcome = "succeeded" | "failed" | "canceled" | "graphIncomplete";

export interface TaskRowView {
  id: string;
  when: string;
  whenFull: string;
  /** What ran ("Import a source", "Find connections"). */
  title: string;
  /** The source it was about, when there is one; the person's own text. */
  detail: string | null;
  outcome: RunOutcome;
  outcomeLabel: string;
  /** Why it did not finish, when it did not. */
  error: string | null;
  duration: string | null;
}

const outcomeKeys: Record<RunOutcome, MessageKey> = {
  succeeded: "diagnostics.taskHistory.outcomes.succeeded",
  failed: "diagnostics.taskHistory.outcomes.failed",
  canceled: "diagnostics.taskHistory.outcomes.canceled",
  graphIncomplete: "diagnostics.taskHistory.outcomes.graphIncomplete"
};

/** The words of a job type; a type this list does not know reads as the generic "background work". */
const typeKeys: Readonly<Record<string, MessageKey>> = {
  ingestion: "diagnostics.jobTypes.ingestion",
  "markdown-conversion": "diagnostics.jobTypes.conversion",
  chunking: "diagnostics.jobTypes.chunking",
  embedding: "diagnostics.jobTypes.embedding",
  "note-embedding": "diagnostics.jobTypes.noteEmbedding",
  summarization: "diagnostics.jobTypes.summarization",
  "atomic-note-generation": "diagnostics.jobTypes.atomicNoteGeneration",
  "knowledge-graph-generation": "diagnostics.jobTypes.knowledgeGraphGeneration",
  "relation-labels": "diagnostics.jobTypes.relationLabels",
  "atomic-note-matching": "diagnostics.jobTypes.atomicNoteMatching",
  "source-matching": "diagnostics.jobTypes.sourceMatching",
  "obsidian-sync": "diagnostics.jobTypes.obsidianSync",
  "obsidian-wiki": "diagnostics.jobTypes.obsidianWiki",
  "asset-storage": "diagnostics.jobTypes.assetStorage",
  "local-model-download": "diagnostics.jobTypes.localModelDownload",
  "topic-place": "diagnostics.jobTypes.topicPlace",
  "topic-sweep": "diagnostics.jobTypes.topicSweep",
  "topic-build": "diagnostics.jobTypes.topicBuild",
  "topic-rebalance": "diagnostics.jobTypes.topicRebalance",
  "topic-audit": "diagnostics.jobTypes.topicAudit",
  "topic-name": "diagnostics.jobTypes.topicName",
  "topic-areas": "diagnostics.jobTypes.topicAreas",
  "topic-label-embed": "diagnostics.jobTypes.topicLabelEmbed",
  "topic-gate": "diagnostics.jobTypes.topicGate",
  "relation-link": "diagnostics.jobTypes.relationLink",
  "relation-retype": "diagnostics.jobTypes.relationRetype",
  "relation-promote": "diagnostics.jobTypes.relationPromote",
  "relation-composite": "diagnostics.jobTypes.relationComposite",
  "catalog-header": "diagnostics.jobTypes.catalogHeader"
};

export const jobTypeKeyOf = (type: string): MessageKey =>
  typeKeys[type] ?? "diagnostics.jobTypes.other";

/** Every job type the list names, for the test that holds each to its copy. */
export const knownJobTypes: readonly string[] = Object.keys(typeKeys);

const finished = (card: JobCardModel): card is JobCardModel & { status: RunOutcome } =>
  card.status === "succeeded" ||
  card.status === "failed" ||
  card.status === "canceled" ||
  card.status === "graphIncomplete";

/** The finished runs, newest first. A run still queued, running or retrying is not history. */
export function taskRowsOf(jobs: readonly JobRecord[], t: Translator, now: Date): TaskRowView[] {
  return groupJobs([...jobs])
    .filter(finished)
    .map((card) => {
      const start = Date.parse(card.mainJob.createdAt);
      const end = Date.parse(card.updatedAt);
      const at = new Date(end);
      const failed = card.status === "failed";
      return {
        id: card.id,
        when: formatWhen(t, at, now),
        whenFull: formatFull(t.locale, at),
        title: t(jobTypeKeyOf(card.mainJob.type)),
        detail: card.source?.title ?? null,
        outcome: card.status,
        outcomeLabel: t(outcomeKeys[card.status]),
        error: failed
          ? errorText(
              t,
              card.stageError ?? card.mainJob.error ?? card.errors.at(-1)?.message ?? null
            )
          : null,
        duration:
          Number.isFinite(start) && Number.isFinite(end) && end >= start
            ? formatDuration(end - start, t.locale)
            : null
      };
    });
}

type PageState = "loading" | "error" | "empty" | "success";

/** Loading, error, empty (no run has finished yet) or success. */
export function taskHistoryState(read: PageRead<JobRecord[]>, t: Translator, now: Date): PageState {
  if (read.status !== "ready") return read.status;
  return taskRowsOf(read.value, t, now).length === 0 ? "empty" : "success";
}

/**
 * What the Diagnostics page as a whole is in: loading while any page waits, error when one failed
 * (the others' rows stay readable), empty when every page has nothing to show, else success.
 */
export function diagnosticsState(states: readonly PageState[]): PageState {
  if (states.includes("loading")) return "loading";
  if (states.includes("error")) return "error";
  return states.every((state) => state === "empty") ? "empty" : "success";
}
