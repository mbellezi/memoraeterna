import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Clock3,
  FileText,
  Globe2,
  Layers3,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Sparkles,
  StickyNote,
  Trash2,
  Video,
  X
} from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";
import type { JobRecord, ProcessingBatch } from "../../shared/ipc";
import { cn } from "../lib/cn";
import {
  collapsePreparationStages,
  groupJobs,
  listActivityJobs,
  matchesFilter,
  preparationStages,
  type JobCardModel,
  type JobFilter
} from "./jobs-view-model";
import { Button } from "./ui/button";

type IngestionRun = NonNullable<JobRecord["ingestionRun"]>;

const pipelineStages = [
  "conversion",
  "structureDetection",
  "structureReview",
  "materialization",
  "chunking",
  "embedding",
  "summarization",
  "atomicNotes",
  "knowledgeGraph",
  "atomicNoteMatching",
  "obsidianProjection",
  "aggregateSummarization"
] as const;

export function JobsView({ t }: { t: Translator }) {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [batches, setBatches] = useState<ProcessingBatch[]>([]);
  const [filter, setFilter] = useState<JobFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(typeof window !== "undefined");
  const [loadError, setLoadError] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState(false);
  const [selectedAttempt, setSelectedAttempt] = useState<JobRecord | null>(null);

  async function load() {
    try {
      const [nextJobs, nextBatches] = await Promise.all([window.app.jobs.list(), window.app.ingestion.listBatches()]);
      setJobs(nextJobs);
      setBatches(nextBatches);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.app.jobs.subscribe(() => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void load(), 100);
    });
    const fallbackTimer = setInterval(() => void load(), 5_000);
    return () => {
      unsubscribe();
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(fallbackTimer);
    };
  }, []);

  const cards = useMemo(() => groupJobs(jobs), [jobs]);
  const filteredCards = cards.filter((card) => matchesFilter(card, filter));
  const batchGroups = groupCardsByBatch(filteredCards, batches);
  const stats = {
    active: cards.filter((card) => card.status === "queued" || card.status === "running" || card.status === "retrying").length,
    completed: cards.filter((card) => card.status === "succeeded").length,
    attention: cards.filter((card) => card.status === "failed" || card.status === "canceled").length
  };

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

  async function runAction(jobId: string, action: "retry" | "cancel" | "delete") {
    if (action === "delete" && !window.confirm(t("jobs.actions.deleteConfirm"))) return;
    setBusyJobId(jobId);
    setActionError(false);
    try {
      const result = await window.app.jobs[action](jobId);
      if (action === "delete" && result === null) throw new Error("job_delete_rejected");
      await load();
    } catch {
      setActionError(true);
    } finally {
      setBusyJobId(null);
    }
  }

  function toggleExpanded(cardId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }

  return <><section className="mx-auto grid w-full max-w-[1480px] gap-5">
    <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {t("jobs.dashboard.eyebrow")}
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-950 dark:text-white">{t("jobs.dashboard.title")}</h2>
          <p className="mt-1.5 max-w-xl text-sm leading-6 text-slate-600 dark:text-slate-400">{t("jobs.dashboard.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-slate-600 transition hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-800 dark:border-slate-800 dark:text-slate-300 dark:hover:border-cyan-800 dark:hover:bg-cyan-950"
            title={t("jobs.actions.refresh")}
            onClick={() => void load()}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} aria-hidden="true" />
          </button>
          <Button
            type="button"
            className="border-slate-200 bg-white text-slate-700 hover:bg-rose-50 hover:text-rose-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-rose-950 dark:hover:text-rose-200"
            disabled={stats.completed + stats.attention === 0 || clearing}
            onClick={() => void clearCompletedOrFailed()}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {t("jobs.actions.clearCompletedOrFailed")}
          </Button>
        </div>
      </div>

      <div className="relative mt-5 grid gap-3 sm:grid-cols-3">
        <StatTile icon={LoaderCircle} label={t("jobs.summary.active")} value={stats.active} tone="cyan" />
        <StatTile icon={Check} label={t("jobs.summary.completed")} value={stats.completed} tone="emerald" />
        <StatTile icon={AlertTriangle} label={t("jobs.summary.attention")} value={stats.attention} tone="amber" />
      </div>
    </div>

    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t("jobs.filters.label")}>
        {(["all", "active", "completed", "attention"] as const).map((item) => (
          <button
            key={item}
            type="button"
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-semibold transition",
              filter === item
                ? "border-slate-900 bg-slate-900 text-white shadow-sm dark:border-white dark:bg-white dark:text-slate-950"
                : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-950 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400 dark:hover:text-white"
            )}
            onClick={() => setFilter(item)}
          >
            {t(`jobs.filters.${item}` as MessageKey)}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        {t("jobs.liveUpdates")}
      </div>
    </div>

    {loadError ? <div className="flex items-center justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200">
      <span>{t("jobs.loadError")}</span>
      <button type="button" className="font-semibold underline underline-offset-4" onClick={() => void load()}>{t("shell.actions.retry")}</button>
    </div> : null}

    {actionError ? <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200" role="alert">
      {t("jobs.actions.actionError")}
    </div> : null}

    {loading && cards.length === 0 ? <LoadingCards /> : filteredCards.length === 0 ? (
      <EmptyState t={t} filtered={cards.length > 0} />
    ) : (
      <div className="grid gap-5">
        {batchGroups.map((group) => <section key={group.id} className="grid gap-3">
          {group.batch ? <BatchHeader batch={group.batch} t={t} /> : null}
          {group.cards.map((card) => <JobCard
            key={card.id}
            card={card}
            expanded={expanded.has(card.id) || card.status === "failed"}
            busy={busyJobId === card.mainJob.id}
            t={t}
            onToggle={() => toggleExpanded(card.id)}
            onAction={(action) => void runAction(card.mainJob.id, action)}
            onSelectAttempt={setSelectedAttempt}
          />)}
        </section>)}
      </div>
    )}
  </section>
  {selectedAttempt ? <AttemptDetailsDialog job={selectedAttempt} t={t} onClose={() => setSelectedAttempt(null)} /> : null}
  </>;
}

export function JobCard({
  card,
  expanded,
  busy,
  t,
  onToggle,
  onAction,
  onSelectAttempt
}: {
  card: JobCardModel;
  expanded: boolean;
  busy: boolean;
  t: Translator;
  onToggle: () => void;
  onAction: (action: "retry" | "cancel" | "delete") => void;
  onSelectAttempt: (job: JobRecord) => void;
}) {
  const status = statusStyle(card.status);
  const StatusIcon = status.icon;
  const SourceIcon = sourceIcon(card.source?.type);
  const progress = Math.round(card.progress * 100);
  const currentStage = card.ingestionRun?.currentStage ?? card.mainJob.type;
  const activity = listActivityJobs(card).toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return <article className={cn(
    "group overflow-hidden rounded-2xl border bg-white shadow-sm transition duration-300 dark:bg-slate-950",
    (card.status === "running" || card.status === "retrying") && "border-cyan-300 shadow-cyan-950/5 dark:border-cyan-900",
    card.status === "failed" && "border-rose-300 dark:border-rose-900",
    card.status !== "running" && card.status !== "retrying" && card.status !== "failed" && "border-slate-200 dark:border-slate-800"
  )}>
    <div className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3.5">
          <div className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl border", status.iconSurface)}>
            <SourceIcon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="max-w-3xl truncate text-base font-semibold text-slate-950 dark:text-white">
                {card.source?.title ?? t(jobTypeMessageKey(card.mainJob.type))}
              </h3>
              <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold", status.badge)}>
                <StatusIcon className={cn("h-3.5 w-3.5", (card.status === "running" || card.status === "retrying") && "animate-spin")} aria-hidden="true" />
                {t(`jobs.status.${card.status}` as MessageKey)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span>{card.source ? t(`import.sourceTypes.${card.source.type}` as MessageKey) : t(jobTypeMessageKey(card.mainJob.type))}</span>
              <span className="h-1 w-1 rounded-full bg-slate-300 dark:bg-slate-700" />
              <span>{t("jobs.currentStage", { values: { stage: stageLabel(t, currentStage) } })}</span>
              <span className="h-1 w-1 rounded-full bg-slate-300 dark:bg-slate-700" />
              <span>{t("jobs.updatedAt", { values: { date: formatDate(card.updatedAt, t.locale) } })}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {card.mainJob.canRetry ? <Button
            type="button"
            className="border-slate-200 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
            disabled={busy}
            onClick={() => onAction("retry")}
          >
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button> : null}
          {card.mainJob.canDelete ? <Button
            type="button"
            className="border-rose-200 bg-white text-rose-700 hover:bg-rose-50 dark:border-rose-900 dark:bg-slate-900 dark:text-rose-200 dark:hover:bg-rose-950"
            disabled={busy}
            onClick={() => onAction("delete")}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {t("jobs.actions.delete")}
          </Button> : null}
          {card.mainJob.canCancel ? <Button
            type="button"
            className="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
            disabled={busy}
            onClick={() => onAction("cancel")}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            {t("shell.actions.cancel")}
          </Button> : null}
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="font-medium text-slate-600 dark:text-slate-300">{t("jobs.progress.percentComplete", { values: { percent: progress } })}</span>
          {card.status === "running" ? <span className="flex items-center gap-1.5 text-cyan-700 dark:text-cyan-300">
            <BrainCircuit className="h-3.5 w-3.5" aria-hidden="true" />
            {t("jobs.streaming")}
          </span> : null}
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          <div
            className={cn(
              "relative h-full rounded-full transition-[width] duration-700 ease-out",
              card.status === "failed" ? "bg-rose-500" : card.status === "canceled" ? "bg-amber-500" : "bg-gradient-to-r from-cyan-500 via-sky-500 to-violet-500"
            )}
            style={{ width: `${progress}%` }}
          >
            {(card.status === "running" || card.status === "retrying") ? <span className="absolute inset-0 animate-pulse bg-white/25" /> : null}
          </div>
        </div>
      </div>

      {card.ingestionRun ? <PipelineTimeline run={card.ingestionRun} t={t} /> : null}
    </div>

    <div className="border-t border-slate-100 bg-slate-50/70 dark:border-slate-900 dark:bg-slate-950/80">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left text-xs font-semibold text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2">
          <Layers3 className="h-4 w-4" aria-hidden="true" />
          {t("jobs.details", { values: { count: activity.length } })}
          {card.errors.length > 0 ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] text-rose-700 dark:bg-rose-950 dark:text-rose-200">
            {t("jobs.errorCount", { values: { count: card.errors.length } })}
          </span> : null}
        </span>
        {expanded ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
      </button>

      {expanded ? <div className="grid gap-4 border-t border-slate-100 px-5 py-4 dark:border-slate-900 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.42fr)]">
        <div>
          <h4 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{t("jobs.activity.title")}</h4>
          <ol className="grid gap-2">
            {activity.map((job) => <ActivityRow key={job.id} job={job} t={t} onSelect={() => onSelectAttempt(job)} />)}
          </ol>
        </div>
        <div>
          <h4 className="mb-3 text-xs font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{t("jobs.errors.title")}</h4>
          {card.errors.length === 0 ? <div className="rounded-xl border border-dashed border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
            {t("jobs.errors.empty")}
          </div> : <ol className="grid max-h-64 gap-2 overflow-auto pr-1">
            {card.errors.toReversed().map((error, index) => <li key={`${error.occurredAt}-${index}`} className="rounded-xl border border-rose-200 bg-rose-50 p-3 dark:border-rose-900 dark:bg-rose-950/40">
              <div className="flex items-center justify-between gap-3 text-[11px] font-semibold text-rose-700 dark:text-rose-200">
                <span>{stageLabel(t, error.stage)}</span>
                <span>{formatDate(error.occurredAt, t.locale)}</span>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-rose-900 dark:text-rose-100">{jobErrorLabel(t, error.message)}</p>
            </li>)}
          </ol>}
        </div>
      </div> : null}
    </div>
  </article>;
}

function PipelineTimeline({ run, t }: { run: IngestionRun; t: Translator }) {
  const visibleStages = collapsePreparationStages(
    pipelineStages.filter((stage) => run.effectiveStages.length === 0 || run.effectiveStages.includes(stage))
  );
  return <ol className="mt-5 grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
    {visibleStages.map((stage, index) => {
      const checkpoint = run.stagesCheckpoint[stage];
      const stageStatus = stage === "preparation"
        ? resolvePreparationStatus(run)
        : resolveStageStatus(run, stage, checkpoint);
      const Icon = stageStatus === "completed" ? Check : stageStatus === "running" ? LoaderCircle
        : stageStatus === "failed" ? AlertTriangle : Circle;
      return <li key={stage} className="relative min-w-0">
        {index < visibleStages.length - 1 ? <span className={cn(
          "absolute left-[calc(50%+12px)] right-[calc(-50%+12px)] top-3 hidden h-px lg:block",
          stageStatus === "completed" ? "bg-emerald-400 dark:bg-emerald-700" : "bg-slate-200 dark:bg-slate-800"
        )} /> : null}
        <div className="relative flex flex-col items-center text-center">
          <span className={cn(
            "grid h-6 w-6 place-items-center rounded-full border bg-white dark:bg-slate-950",
            stageStatus === "completed" && "border-emerald-500 text-emerald-600 dark:text-emerald-400",
            stageStatus === "running" && "border-cyan-500 bg-cyan-50 text-cyan-700 ring-4 ring-cyan-100 dark:bg-cyan-950 dark:text-cyan-300 dark:ring-cyan-950",
            stageStatus === "failed" && "border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
            (stageStatus === "pending" || stageStatus === "canceled") && "border-slate-300 text-slate-300 dark:border-slate-700 dark:text-slate-700"
          )}>
            <Icon className={cn("h-3.5 w-3.5", stageStatus === "running" && "animate-spin")} aria-hidden="true" />
          </span>
          <span className={cn(
            "mt-2 line-clamp-2 text-[10px] font-medium leading-4",
            stageStatus === "running" ? "text-cyan-700 dark:text-cyan-300" : stageStatus === "completed" ? "text-slate-700 dark:text-slate-300" : "text-slate-400 dark:text-slate-600"
          )}>{t(stageMessageKey(stage))}</span>
          {checkpointSummary(stage, checkpoint) ? <span className="mt-0.5 text-[9px] text-slate-400">{checkpointSummary(stage, checkpoint)}</span> : null}
        </div>
      </li>;
    })}
  </ol>;
}

function BatchHeader({ batch, t }: { batch: ProcessingBatch; t: Translator }) {
  const percent = Math.round(batch.progress > 1 ? batch.progress / 100 : batch.progress * 100);
  const preset = typeof batch.effectivePlan.preset === "string" ? batch.effectivePlan.preset : "custom";
  return <header className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 dark:border-violet-900 dark:bg-violet-950/40">
    <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-violet-700 dark:text-violet-300">{t("jobs.batch.label")}</p><p className="mt-1 text-sm font-semibold">{t("jobs.batch.plan", { values: { plan: preset === "custom" ? t("jobs.batch.custom") : t(`processing.presets.${preset}.title` as MessageKey) } })}</p></div>
    <div className="min-w-56"><div className="flex justify-between text-xs text-slate-600 dark:text-slate-300"><span>{t("jobs.batch.items", { values: { completed: batch.completedItems, total: batch.totalItems } })}</span><span>{percent}%</span></div><div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white dark:bg-slate-900"><div className="h-full rounded-full bg-violet-500" style={{ width: `${percent}%` }} /></div></div>
  </header>;
}

function groupCardsByBatch(cards: JobCardModel[], batches: ProcessingBatch[]) {
  const batchById = new Map(batches.map((batch) => [batch.id, batch]));
  const groups = new Map<string, { id: string; batch: ProcessingBatch | null; cards: JobCardModel[] }>();
  for (const card of cards) {
    const batchId = card.ingestionRun?.batchId ?? `standalone:${card.id}`;
    const group = groups.get(batchId) ?? { id: batchId, batch: batchById.get(batchId) ?? null, cards: [] };
    group.cards.push(card); groups.set(batchId, group);
  }
  return [...groups.values()];
}

function ActivityRow({ job, t, onSelect }: { job: JobRecord; t: Translator; onSelect: () => void }) {
  const style = statusStyle(job.status);
  const Icon = style.icon;
  const typeLabel = t(jobTypeMessageKey(job.type));
  return <li>
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-cyan-300 hover:bg-cyan-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 dark:border-slate-800 dark:bg-slate-900/70 dark:hover:border-cyan-800 dark:hover:bg-cyan-950/30"
      onClick={onSelect}
      aria-label={t("jobs.attemptDetails.open", { values: { type: typeLabel } })}
    >
      <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", style.badge)}>
        <Icon className={cn("h-3.5 w-3.5", job.status === "running" && "animate-spin")} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <span className="truncate text-xs font-semibold text-slate-800 dark:text-slate-100">{typeLabel}</span>
          <div className="flex max-w-[65%] flex-wrap items-center justify-end gap-x-2 gap-y-1 text-right text-[10px] text-slate-400">
            <span className="shrink-0">{formatDate(job.createdAt, t.locale)}</span>
            {job.aiExecution ? <>
              <span className="h-1 w-1 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
              <span className="truncate font-medium text-slate-600 dark:text-slate-300">{job.aiExecution.modelId}</span>
              <span className="h-1 w-1 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
              <span className="shrink-0">{t("jobs.activity.reasoning", { values: { level: job.aiExecution.reasoningLevel ? t(`settings.ai.parameters.reasoning.${job.aiExecution.reasoningLevel}` as MessageKey) : t("jobs.activity.modelDefault") } })}</span>
            </> : null}
          </div>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
          <div className={cn("h-full rounded-full", job.status === "failed" ? "bg-rose-500" : "bg-cyan-500")} style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
      </div>
      <span className="w-8 text-right text-[10px] font-semibold text-slate-500">{Math.round(job.progress * 100)}%</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
    </button>
  </li>;
}

export function AttemptDetailsDialog({ job, t, onClose }: { job: JobRecord; t: Translator; onClose: () => void }) {
  const style = statusStyle(job.status);
  const StatusIcon = style.icon;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div
    className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-4 backdrop-blur-sm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="attempt-details-title"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
  >
    <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-5 dark:border-slate-800">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="attempt-details-title" className="text-lg font-semibold text-slate-950 dark:text-white">{t("jobs.attemptDetails.title")}</h2>
            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold", style.badge)}>
              <StatusIcon className={cn("h-3.5 w-3.5", job.status === "running" && "animate-spin")} aria-hidden="true" />
              {t(`jobs.status.${job.status}` as MessageKey)}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t(jobTypeMessageKey(job.type))}</p>
        </div>
        <button type="button" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-900 dark:hover:text-white" onClick={onClose} title={t("shell.actions.close")}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </header>

      <div className="grid gap-5 overflow-y-auto p-5">
        <dl className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-800 dark:bg-slate-900/60 sm:grid-cols-2">
          <AttemptMetadata label={t("jobs.attemptDetails.attempt")} value={String(job.attempts)} />
          <AttemptMetadata label={t("jobs.attemptDetails.startedAt")} value={formatDate(job.createdAt, t.locale)} />
          <AttemptMetadata label={t("jobs.attemptDetails.jobId")} value={job.id} monospace />
          {job.aiExecution ? <>
            <AttemptMetadata label={t("jobs.attemptDetails.provider")} value={job.aiExecution.provider} />
            <AttemptMetadata label={t("jobs.attemptDetails.model")} value={job.aiExecution.modelId} />
          </> : null}
        </dl>

        <section>
          <h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">{t("jobs.attemptDetails.failureReason")}</h3>
          <pre className={cn(
            "mt-2 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border p-4 font-mono text-xs leading-5",
            job.error
              ? "border-rose-200 bg-rose-50 text-rose-950 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100"
              : "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
          )}>{job.error ?? t("jobs.attemptDetails.noFailureReason")}</pre>
        </section>
      </div>
    </div>
  </div>;
}

function AttemptMetadata({ label, value, monospace = false }: { label: string; value: string; monospace?: boolean }) {
  return <div className="min-w-0">
    <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</dt>
    <dd className={cn("mt-1 break-all text-slate-900 dark:text-slate-100", monospace && "font-mono text-xs")}>{value}</dd>
  </div>;
}

function StatTile({ icon: Icon, label, value, tone }: {
  icon: typeof LoaderCircle;
  label: string;
  value: number;
  tone: "cyan" | "emerald" | "amber";
}) {
  const tones = {
    cyan: "border-cyan-200 bg-cyan-50 text-cyan-800 dark:border-cyan-900 dark:bg-cyan-950/50 dark:text-cyan-200",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200",
    amber: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
  };
  return <div className={cn("flex items-center gap-3 rounded-xl border px-3.5 py-3", tones[tone])}>
    <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/70 dark:bg-slate-950/40"><Icon className="h-4 w-4" aria-hidden="true" /></span>
    <div><div className="text-lg font-bold leading-none">{value}</div><div className="mt-1 text-[11px] font-semibold opacity-80">{label}</div></div>
  </div>;
}

function EmptyState({ t, filtered }: { t: Translator; filtered: boolean }) {
  return <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center dark:border-slate-800 dark:bg-slate-950/60">
    <div className="max-w-sm">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-400">
        <Layers3 className="h-6 w-6" aria-hidden="true" />
      </div>
      <h3 className="mt-4 font-semibold text-slate-900 dark:text-white">{t(filtered ? "jobs.filteredEmpty.title" : "jobs.emptyState.title")}</h3>
      <p className="mt-1.5 text-sm leading-6 text-slate-500 dark:text-slate-400">{t(filtered ? "jobs.filteredEmpty.description" : "jobs.emptyState.description")}</p>
    </div>
  </div>;
}

function LoadingCards() {
  return <div className="grid gap-4" aria-busy="true">
    {[0, 1].map((item) => <div key={item} className="animate-pulse rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex gap-3"><div className="h-11 w-11 rounded-xl bg-slate-100 dark:bg-slate-900" /><div className="flex-1"><div className="h-4 w-1/3 rounded bg-slate-100 dark:bg-slate-900" /><div className="mt-2 h-3 w-1/4 rounded bg-slate-100 dark:bg-slate-900" /></div></div>
      <div className="mt-5 h-2.5 rounded-full bg-slate-100 dark:bg-slate-900" />
      <div className="mt-5 h-12 rounded-xl bg-slate-50 dark:bg-slate-900/60" />
    </div>)}
  </div>;
}

function resolveStageStatus(run: IngestionRun, stage: string, checkpoint: unknown): string {
  const status = checkpointStatus(checkpoint);
  if (status !== "pending") return status;
  if (run.currentStage === stage && run.status === "running") return "running";
  if (run.currentStage === stage && run.status === "failed") return "failed";
  if (run.currentStage === stage && run.status === "canceled") return "canceled";
  return "pending";
}

function resolvePreparationStatus(run: IngestionRun): string {
  const statuses = preparationStages.map((stage) => resolveStageStatus(run, stage, run.stagesCheckpoint[stage]));
  for (const status of ["failed", "running", "canceled"] as const) {
    if (statuses.includes(status)) return status;
  }
  return statuses.every((status) => status === "completed" || status === "skipped") ? "completed" : "pending";
}

function checkpointStatus(checkpoint: unknown): string {
  return typeof checkpoint === "object" && checkpoint !== null && "status" in checkpoint
    && typeof checkpoint.status === "string" ? checkpoint.status : "pending";
}

function checkpointSummary(stage: string, checkpoint: unknown): string | null {
  if (typeof checkpoint !== "object" || checkpoint === null || !("metadata" in checkpoint)) return null;
  const metadata = checkpoint.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const record = metadata as Record<string, unknown>;
  const completed = Number(record.completed);
  const total = Number(record.total);
  if (Number.isInteger(completed) && Number.isInteger(total) && total > 0) return `${completed}/${total}`;
  const countKey = ({
    chunking: "chunkCount",
    embedding: "embeddedCount",
    atomicNotes: "generatedCount",
    knowledgeGraph: "batchCount",
    atomicNoteMatching: "persistedCount",
    obsidianProjection: "projected"
  } as Record<string, string>)[stage];
  const rawCount = countKey ? record[countKey] : undefined;
  const count = typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : undefined;
  return count === undefined ? null : String(count);
}

function statusStyle(status: JobCardModel["status"]) {
  return ({
    queued: { icon: Clock3, badge: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200", iconSurface: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300" },
    running: { icon: LoaderCircle, badge: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200", iconSurface: "border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-900 dark:bg-cyan-950 dark:text-cyan-300" },
    retrying: { icon: RotateCcw, badge: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200", iconSurface: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300" },
    succeeded: { icon: Check, badge: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200", iconSurface: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300" },
    failed: { icon: AlertTriangle, badge: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200", iconSurface: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300" },
    canceled: { icon: X, badge: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200", iconSurface: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300" }
  })[status];
}

function sourceIcon(type?: string) {
  return ({
    PersonalNote: StickyNote,
    DailyNote: StickyNote,
    WebArticle: Globe2,
    Book: BookOpen,
    BookChapter: BookOpen,
    PeriodicalIssue: BookOpen,
    AcademicPaper: FileText,
    DocumentSection: FileText,
    StandaloneArticle: FileText,
    Video,
    GenericDocument: FileText
  } as Record<string, typeof FileText>)[type ?? ""] ?? FileText;
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
    "asset-storage": "jobs.types.assetStorage",
    "local-model-download": "jobs.types.localModelDownload"
  } as Record<string, MessageKey>)[type] ?? "jobs.types.ingestion";
}

function stageMessageKey(stage: string): MessageKey {
  const aliases = {
    ingestion: "queued",
    "markdown-conversion": "conversion",
    "atomic-note-generation": "atomicNotes",
    "knowledge-graph-generation": "knowledgeGraph",
    "atomic-note-matching": "atomicNoteMatching",
    "obsidian-sync": "obsidianProjection"
  } as Record<string, string>;
  return (`jobs.stages.${aliases[stage] ?? stage}` as MessageKey);
}

function stageLabel(t: Translator, stage: string): string {
  const pipelineStage = pipelineStages.includes(stage as (typeof pipelineStages)[number])
    || ["queued", "completed", "ingestion", "markdown-conversion", "atomic-note-generation", "knowledge-graph-generation", "atomic-note-matching", "obsidian-sync"].includes(stage);
  return pipelineStage ? t(stageMessageKey(stage)) : t(jobTypeMessageKey(stage));
}

function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function jobErrorLabel(t: Translator, error: string): string {
  if (error.includes("knowledge_graph_unknown_evidence_alias")) return t("jobs.errors.unknownEvidence");
  if (error.includes("knowledge_graph_output_invalid")) return t("jobs.errors.invalidModelOutput");
  const messageKey = error.match(/^errors\.[A-Za-z0-9.]+/)?.[0];
  if (messageKey) return t(messageKey as MessageKey);
  return error.split(/\r?\n/, 1)[0]?.trim() || t("errors.common.unknown");
}
