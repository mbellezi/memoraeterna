import { useEffect, useMemo, useState } from "react";
import { Bug, Network, RefreshCw, Search, Trash2 } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import type { SimilarityDebugRun } from "../../shared/ipc";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { ObsidianSyncStatusCard } from "./ObsidianSyncStatusCard";

interface DebugDashboardProps {
  enabled: boolean;
  t: (key: MessageKey) => string;
  onEnabledChange: (enabled: boolean) => Promise<void>;
}

type RunFilter = "all" | SimilarityDebugRun["kind"];

const scoreStyles = {
  text: { bar: "bg-amber-500", badge: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" },
  vector: { bar: "bg-cyan-500", badge: "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200" },
  graph: { bar: "bg-blue-500", badge: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-200" },
  metadata: { bar: "bg-violet-500", badge: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200" },
  rerank: { bar: "bg-fuchsia-500", badge: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200" },
  final: { bar: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200" }
} as const;

export function DebugDashboard({
  enabled,
  t,
  onEnabledChange
}: DebugDashboardProps) {
  const [runs, setRuns] = useState<SimilarityDebugRun[]>([]);
  const [filter, setFilter] = useState<RunFilter>("all");
  const [loading, setLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const filteredRuns = useMemo(
    () => filter === "all" ? runs : runs.filter((run) => run.kind === filter),
    [filter, runs]
  );
  const resultCount = useMemo(
    () => filteredRuns.reduce((total, run) => total + run.results.length, 0),
    [filteredRuns]
  );

  async function refresh() {
    setLoading(true);
    try {
      setRuns(await window.app.debug.listSimilarityRuns());
    } finally {
      setLoading(false);
    }
  }

  async function toggle(next: boolean) {
    setChanging(true);
    try {
      await onEnabledChange(next);
    } finally {
      setChanging(false);
    }
  }

  async function clear() {
    if (!window.confirm(t("debug.clearConfirmation"))) return;
    await window.app.debug.clearSimilarityRuns();
    setRuns([]);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="grid gap-6">
      <ObsidianSyncStatusCard available t={t} />
      <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-fuchsia-100 p-2 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200">
              <Bug className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="font-semibold text-slate-950 dark:text-slate-50">{t("debug.captureTitle")}</h2>
              <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-300">{t("debug.captureDescription")}</p>
            </div>
          </div>
          <label className="flex min-h-11 items-center gap-3 rounded-lg border border-slate-200 px-4 dark:border-slate-700">
            <Switch checked={enabled} disabled={changing} onChange={(event) => void toggle(event.target.checked)} />
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              {enabled ? t("debug.enabled") : t("debug.disabled")}
            </span>
          </label>
        </div>
      </section>

      <section className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <SummaryCard label={t("debug.executions")} value={filteredRuns.length} tone="cyan" />
          <SummaryCard label={t("debug.candidates")} value={resultCount} tone="violet" />
          <SummaryCard label={t("debug.captureState")} value={enabled ? t("debug.recording") : t("debug.paused")} tone={enabled ? "green" : "slate"} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
            {(["all", "chunk_search", "atomic_note_matching"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={filter === value
                  ? "bg-slate-900 px-3 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-950"
                  : "bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-900"}
                onClick={() => setFilter(value)}
              >
                {t(`debug.filters.${value}` as MessageKey)}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" disabled={loading} onClick={() => void refresh()}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
              {t("debug.refresh")}
            </Button>
            <Button type="button" className="bg-white text-red-700 dark:bg-slate-950 dark:text-red-300" onClick={() => void clear()}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              {t("debug.clear")}
            </Button>
          </div>
        </div>

        {filteredRuns.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
            <Bug className="mx-auto h-8 w-8 text-slate-400" aria-hidden="true" />
            <p className="mt-3 font-medium text-slate-800 dark:text-slate-200">{t("debug.empty")}</p>
            <p className="mt-1 text-sm text-slate-500">{t("debug.emptyDescription")}</p>
          </div>
        ) : filteredRuns.map((run) => <RunCard key={run.id} run={run} t={t} />)}
      </section>
    </div>
  );
}

function RunCard({ run, t }: { run: SimilarityDebugRun; t: DebugDashboardProps["t"] }) {
  const isChunk = run.kind === "chunk_search";
  const passed = run.results.filter((result) => result.passedThreshold === true).length;
  const threshold = typeof run.metadata.threshold === "number" ? run.metadata.threshold : null;
  return (
    <details className="group rounded-xl border border-slate-200 bg-white shadow-sm open:ring-2 open:ring-cyan-100 dark:border-slate-800 dark:bg-slate-950 dark:open:ring-cyan-950">
      <summary className="cursor-pointer list-none p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <div className={isChunk
              ? "rounded-lg bg-cyan-100 p-2 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200"
              : "rounded-lg bg-violet-100 p-2 text-violet-800 dark:bg-violet-950 dark:text-violet-200"}>
              {isChunk ? <Search className="h-5 w-5" aria-hidden="true" /> : <Network className="h-5 w-5" aria-hidden="true" />}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={isChunk
                  ? "rounded-full bg-cyan-100 px-2 py-1 text-xs font-semibold text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200"
                  : "rounded-full bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-900 dark:bg-violet-950 dark:text-violet-200"}>
                  {t(isChunk ? "debug.chunkSearch" : "debug.noteMatching")}
                </span>
                <span className="text-xs text-slate-500">{new Date(run.createdAt).toLocaleString()}</span>
              </div>
              <p className="mt-2 line-clamp-2 font-medium text-slate-950 dark:text-slate-50">{run.queryText}</p>
              <p className="mt-1 text-xs text-slate-500">
                {run.strategy} · {run.model ?? t("debug.noModel")} {run.dimensions ? `· ${run.dimensions}d` : ""}
              </p>
            </div>
          </div>
          <div className="flex gap-2 text-xs">
            <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700 dark:bg-slate-900 dark:text-slate-300">
              {run.results.length} {t("debug.candidates").toLowerCase()}
            </span>
            {!isChunk && <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">{passed} {t("debug.passed").toLowerCase()}</span>}
            {!isChunk && threshold !== null && <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-900 dark:bg-amber-950 dark:text-amber-200">{t("debug.thresholdUsed")}: {threshold.toFixed(2)}</span>}
          </div>
        </div>
      </summary>
      <div className="grid gap-3 border-t border-slate-200 p-5 dark:border-slate-800">
        <GraphElementsPanel title={t("debug.sourceElements")} value={run.metadata.sourceGraphElements} t={t} />
        {run.results.map((result) => (
          <article key={result.id} className="grid gap-4 rounded-lg border border-slate-200 p-4 dark:border-slate-800">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-slate-400">#{result.finalRank}</span>
                  <h3 className="font-medium text-slate-950 dark:text-slate-50">{result.targetLabel ?? result.targetId}</h3>
                </div>
                {(result.textRank || result.vectorRank || result.graphRank) && (
                  <p className="mt-1 text-xs text-slate-500">
                    {t("debug.textRank")}: {result.textRank ?? "—"} · {t("debug.vectorRank")}: {result.vectorRank ?? "—"} · {t("debug.graphRank")}: {result.graphRank ?? "—"}
                  </p>
                )}
              </div>
              {result.passedThreshold !== null && (
                <span className={result.passedThreshold
                  ? "rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                  : "rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-900 dark:bg-red-950 dark:text-red-200"}>
                  {t(result.passedThreshold ? "debug.passed" : "debug.rejected")}
                </span>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <ScoreMetric label={t("debug.textScore")} value={result.textScore} tone="text" />
              <ScoreMetric label={t("debug.vectorScore")} value={result.vectorScore} tone="vector" />
              <ScoreMetric label={t("debug.graphScore")} value={result.graphScore} tone="graph" />
              {result.metadataScore !== null && <ScoreMetric label={t("debug.metadataScore")} value={result.metadataScore} tone="metadata" />}
              {result.rerankScore !== null && <ScoreMetric label={t("debug.rerankScore")} value={result.rerankScore} tone="rerank" />}
              <ScoreMetric label={t(result.fusionScore !== null ? "debug.fusionScore" : "debug.finalScore")} value={result.finalScore} tone="final" />
            </div>
            {typeof result.metadata.baseScore === "number" && (
              <p className="text-xs text-slate-500">{t("debug.beforeRerank")}: {formatScore(result.metadata.baseScore)}</p>
            )}
            {typeof result.metadata.rerankError === "string" && result.metadata.rerankError.length > 0 && (
              <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
                <strong>{t("debug.rerankError")}:</strong> {result.metadata.rerankError}
              </div>
            )}
            {((typeof result.metadata.graphError === "string" && result.metadata.graphError.length > 0)
              || (typeof run.metadata.graphError === "string" && run.metadata.graphError.length > 0)) && (
              <div className="rounded-md border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
                <strong>{t("debug.graphError")}:</strong> {t("debug.graphUnavailable")}
              </div>
            )}
            {result.metadata.rerankStatus === "not_configured" && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {t("debug.rerankNotConfigured")}
              </div>
            )}
            <GraphElementsPanel title={t("debug.candidateElements")} value={result.metadata.graphElements} t={t} />
            {result.explanation && <p className="text-sm text-slate-600 dark:text-slate-300">{result.explanation}</p>}
          </article>
        ))}
      </div>
    </details>
  );
}

function GraphElementsPanel({ title, value, t }: {
  title: string;
  value: unknown;
  t: DebugDashboardProps["t"];
}) {
  const elements = readGraphElements(value);
  if (!elements || elements.entities.length + elements.claims.length + elements.relations.length === 0) return null;
  return (
    <section className="grid gap-3 rounded-lg border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-900 dark:bg-blue-950/20">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-blue-950 dark:text-blue-100">
        <Network className="h-4 w-4" aria-hidden="true" />{title}
      </h4>
      {elements.entities.length > 0 && <div className="grid gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-800 dark:text-blue-300">{t("debug.entities")}</p>
        <div className="flex flex-wrap gap-2">{elements.entities.map((entity, index) => (
          <span key={`${entity.name}:${index}`} className="rounded-full bg-white px-2 py-1 text-xs text-slate-800 shadow-sm dark:bg-slate-900 dark:text-slate-200">
            {entity.name} · {entity.type} · {formatScore(entity.confidence)}
          </span>
        ))}</div>
      </div>}
      {elements.claims.length > 0 && <div className="grid gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-800 dark:text-blue-300">{t("debug.claims")}</p>
        <ul className="grid gap-1 text-sm text-slate-700 dark:text-slate-300">{elements.claims.map((claim, index) => (
          <li key={`${claim.text}:${index}`}>• {claim.text} <span className="text-xs text-slate-500">({formatScore(claim.confidence)})</span></li>
        ))}</ul>
      </div>}
      {elements.relations.length > 0 && <div className="grid gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-800 dark:text-blue-300">{t("debug.relations")}</p>
        <ul className="grid gap-1 text-sm text-slate-700 dark:text-slate-300">{elements.relations.map((relation, index) => (
          <li key={`${relation.subject}:${relation.predicate}:${relation.object}:${index}`}>
            {relation.subject} → {relation.predicate} → {relation.object} <span className="text-xs text-slate-500">({formatScore(relation.confidence)})</span>
          </li>
        ))}</ul>
      </div>}
    </section>
  );
}

function readGraphElements(value: unknown): {
  entities: Array<{ name: string; type: string; confidence: number }>;
  claims: Array<{ text: string; confidence: number }>;
  relations: Array<{ subject: string; predicate: string; object: string; confidence: number }>;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    entities: readElementArray(record.entities, (item) => {
      const name = readString(item.name);
      const type = readString(item.type);
      return name && type ? { name, type, confidence: readConfidence(item.confidence) } : null;
    }),
    claims: readElementArray(record.claims, (item) => {
      const text = readString(item.text);
      return text ? { text, confidence: readConfidence(item.confidence) } : null;
    }),
    relations: readElementArray(record.relations, (item) => {
      const subject = readString(item.subject);
      const predicate = readString(item.predicate);
      const object = readString(item.object);
      return subject && predicate && object
        ? { subject, predicate, object, confidence: readConfidence(item.confidence) }
        : null;
    })
  };
}

function readElementArray<T>(value: unknown, read: (item: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const parsed = read(item as Record<string, unknown>);
    return parsed ? [parsed] : [];
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ScoreMetric({ label, value, tone }: {
  label: string;
  value: number | null;
  tone: keyof typeof scoreStyles;
}) {
  const score = value === null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className="grid gap-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{label}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${scoreStyles[tone].badge}`}>{formatScore(value)}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className={`h-full rounded-full ${scoreStyles[tone].bar}`} style={{ width: `${score * 100}%` }} />
      </div>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string | number; tone: "cyan" | "violet" | "green" | "slate" }) {
  const styles = {
    cyan: "border-cyan-200 bg-cyan-50 text-cyan-950 dark:border-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-100",
    violet: "border-violet-200 bg-violet-50 text-violet-950 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-100",
    green: "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
    slate: "border-slate-200 bg-slate-50 text-slate-950 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
  };
  return <div className={`rounded-xl border p-4 ${styles[tone]}`}><p className="text-xs font-semibold uppercase tracking-wide opacity-70">{label}</p><p className="mt-2 text-2xl font-bold">{value}</p></div>;
}

function formatScore(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "—";
}
