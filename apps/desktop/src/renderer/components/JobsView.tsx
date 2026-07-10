import { useEffect, useState } from "react";
import { RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";
import type { JobRecord } from "../../shared/ipc";
import { Button } from "./ui/button";

export function JobsView({ t }: { t: Translator }) {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [clearing, setClearing] = useState(false);

  async function load() {
    setJobs(await window.app.jobs.list());
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 1_000);
    return () => clearInterval(timer);
  }, []);

  async function clearCompletedOrFailed() {
    if (!window.confirm(t("jobs.actions.clearCompletedOrFailedConfirm"))) return;
    setClearing(true);
    try {
      await window.app.jobs.clearCompletedOrFailed();
      await load();
    } finally {
      setClearing(false);
    }
  }

  if (jobs.length === 0) {
    return <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">{t("jobs.empty")}</p>;
  }

  const hasClearableJobs = jobs.some((job) => job.status === "succeeded" || job.status === "failed");

  return <section className="grid gap-3">
    <div className="flex justify-end">
      <Button
        type="button"
        className="border-rose-700 bg-rose-700 hover:bg-rose-600 dark:border-rose-700 dark:bg-rose-700 dark:hover:bg-rose-600"
        disabled={!hasClearableJobs || clearing}
        onClick={() => void clearCompletedOrFailed()}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        {t("jobs.actions.clearCompletedOrFailed")}
      </Button>
    </div>
    {jobs.map((job) => <article key={job.id} className="grid gap-3 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
    <div className="flex items-center justify-between gap-4">
      <div><h2 className="font-medium">{t(jobTypeMessageKey(job.type))}</h2><p className="text-xs text-slate-500">{t(`jobs.status.${job.status}` as MessageKey)}</p></div>
      <div className="flex gap-2">
        {job.canRetry ? <Button type="button" onClick={() => void window.app.jobs.retry(job.id).then(load)}><RotateCcw className="h-4 w-4" aria-hidden="true" />{t("shell.actions.retry")}</Button> : null}
        {job.canCancel ? <Button type="button" onClick={() => void window.app.jobs.cancel(job.id).then(load)}><X className="h-4 w-4" aria-hidden="true" />{t("shell.actions.cancel")}</Button> : null}
        <button type="button" className="grid h-9 w-9 place-items-center" title={t("jobs.actions.refresh")} onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden="true" /></button>
      </div>
    </div>
    <div className="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-800"><div className="h-full bg-cyan-600" style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
    {job.ingestionRun ? <div className="grid gap-2">
      <p className="text-xs text-slate-500">{t("jobs.currentStage", { values: { stage: t(stageMessageKey(job.ingestionRun.currentStage)) } })}</p>
      <ol className="flex flex-wrap gap-2">{Object.entries(job.ingestionRun.stagesCheckpoint).map(([stage, checkpoint]) => <li key={stage} className="rounded-full bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{t(stageMessageKey(stage))}: {checkpointStatusLabel(t, checkpoint)}</li>)}</ol>
    </div> : null}
    {job.error ? <p className="text-sm text-rose-700 dark:text-rose-300">{jobErrorLabel(t, job.error)}</p> : null}
  </article>)}</section>;
}

function jobTypeMessageKey(type: string): MessageKey {
  return ({
    ingestion: "jobs.types.ingestion",
    "markdown-conversion": "jobs.types.conversion",
    chunking: "jobs.types.chunking",
    embedding: "jobs.types.embedding",
    summarization: "jobs.types.summarization",
    "atomic-note-generation": "jobs.types.atomicNoteGeneration",
    "knowledge-graph-generation": "jobs.types.knowledgeGraphGeneration",
    "atomic-note-matching": "jobs.types.atomicNoteMatching",
    "obsidian-sync": "jobs.types.obsidianSync",
    "asset-storage": "jobs.types.assetStorage"
  } as Record<string, MessageKey>)[type] ?? "jobs.types.ingestion";
}

function stageMessageKey(stage: string): MessageKey {
  return (`jobs.stages.${stage}` as MessageKey);
}

function checkpointStatusKey(checkpoint: unknown): MessageKey {
  if (typeof checkpoint === "object" && checkpoint !== null && "status" in checkpoint
      && typeof checkpoint.status === "string") {
    return (`jobs.stageStatus.${checkpoint.status}` as MessageKey);
  }
  return "jobs.stageStatus.pending";
}

function checkpointStatusLabel(t: Translator, checkpoint: unknown): string {
  const status = t(checkpointStatusKey(checkpoint));
  if (typeof checkpoint !== "object" || checkpoint === null || !("metadata" in checkpoint)) return status;
  const metadata = checkpoint.metadata;
  if (typeof metadata !== "object" || metadata === null) return status;
  const completed = "completed" in metadata ? Number(metadata.completed) : NaN;
  const total = "total" in metadata ? Number(metadata.total) : NaN;
  return Number.isInteger(completed) && Number.isInteger(total) && total > 0
    ? `${status} (${completed}/${total})`
    : status;
}

function jobErrorLabel(t: Translator, error: string): string {
  const messageKey = error.match(/^errors\.[A-Za-z0-9.]+/)?.[0];
  return messageKey ? t(messageKey as MessageKey) : t("errors.common.unknown");
}
