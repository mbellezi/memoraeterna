import { useEffect, useState } from "react";
import { RefreshCw, RotateCcw, X } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import type { JobRecord } from "../../shared/ipc";
import { Button } from "./ui/button";

export function JobsView({ t }: { t: (key: MessageKey) => string }) {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  async function load() { setJobs(await window.app.jobs.list()); }
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 1_000); return () => clearInterval(timer); }, []);
  if (jobs.length === 0) return <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">{t("jobs.empty")}</p>;
  return <section className="grid gap-3">{jobs.map((job) => <article key={job.id} className="grid gap-3 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"><div className="flex items-center justify-between gap-4"><div><h2 className="font-medium">{t(jobTypeMessageKey(job.type))}</h2><p className="text-xs text-slate-500">{t(`jobs.status.${job.status}` as MessageKey)}</p></div><div className="flex gap-2">{job.status === "failed" ? <Button type="button" onClick={() => void window.app.jobs.retry(job.id).then(load)}><RotateCcw className="h-4 w-4" aria-hidden="true" />{t("shell.actions.retry")}</Button> : null}{job.status === "queued" || job.status === "running" ? <Button type="button" onClick={() => void window.app.jobs.cancel(job.id).then(load)}><X className="h-4 w-4" aria-hidden="true" />{t("shell.actions.cancel")}</Button> : null}<button type="button" className="grid h-9 w-9 place-items-center" title={t("jobs.actions.refresh")} onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden="true" /></button></div></div><div className="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-800"><div className="h-full bg-cyan-600" style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>{job.error ? <p className="text-sm text-rose-700 dark:text-rose-300">{job.error.startsWith("errors.") ? t(job.error as MessageKey) : t("errors.common.unknown")}</p> : null}</article>)}</section>;
}

function jobTypeMessageKey(type: string): MessageKey {
  return ({
    ingestion: "jobs.types.ingestion",
    "markdown-conversion": "jobs.types.conversion",
    chunking: "jobs.types.chunking",
    embedding: "jobs.types.embedding",
    "atomic-note-generation": "jobs.types.atomicNoteGeneration",
    "obsidian-sync": "jobs.types.obsidianSync",
    "asset-storage": "jobs.types.assetStorage"
  } as Record<string, MessageKey>)[type] ?? "jobs.types.ingestion";
}
