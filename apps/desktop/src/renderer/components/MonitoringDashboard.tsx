import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Activity, Bug, ChevronDown, ChevronRight, Copy, RefreshCw, Trash2 } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import type { MonitoringDetail, MonitoringPage, MonitoringQuery, MonitoringRow } from "../../shared/monitoring";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { DebugDashboard } from "./DebugDashboard";
import { ObsidianSyncStatusCard } from "./ObsidianSyncStatusCard";

type Translator = (key: MessageKey) => string;
interface Props {
  enabled: boolean; fullCapture: boolean; t: Translator;
  onCaptureChange: (settings: { debugMode: boolean; debugFullCapture: boolean }) => Promise<void>;
  onOpenSource: (id: string) => void;
}
const field = "min-h-9 rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950";
const panel = "rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950";
const tokenKeys = ["inputTokens", "outputTokens", "reasoningTokens", "cachedInputTokens", "totalTokens"] as const;
const number = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString();

export function MonitoringDashboard({ enabled, fullCapture, t, onCaptureChange, onOpenSource }: Props) {
  const [view, setView] = useState<"ai" | "debug">("ai");
  const [page, setPage] = useState<MonitoringPage | null>(null);
  const [kind, setKind] = useState<MonitoringQuery["kind"]>("all");
  const [status, setStatus] = useState<MonitoringQuery["status"]>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [days, setDays] = useState(7);
  const [offset, setOffset] = useState(0);
  const [anchor, setAnchor] = useState(() => new Date().toISOString());
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [changing, setChanging] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [similarityVersion, setSimilarityVersion] = useState(0);
  const [similarityOpen, setSimilarityOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const requestId = useRef(0);
  const limit = 50;

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setOffset(0); }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    const until = anchor;
    try {
      const next = await window.app.monitoring.list({ view, kind, status, search: debouncedSearch, limit, offset, until,
        ...(days ? { since: new Date(Date.parse(until) - days * 86_400_000).toISOString() } : {}) });
      if (id !== requestId.current) return;
      setPage(next); setError(false);
    } catch { if (id === requestId.current) setError(true); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [view, kind, status, debouncedSearch, days, offset, anchor]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);
  useEffect(() => {
    if (!live || offset > 0) return;
    const timer = setInterval(() => { if (!document.hidden) setAnchor(new Date().toISOString()); }, 5000);
    return () => clearInterval(timer);
  }, [live, offset]);

  async function changeCapture(debugMode: boolean, debugFullCapture: boolean) {
    if (debugFullCapture && (!fullCapture || !enabled) && !window.confirm(t("monitoring.fullWarning"))) return;
    setChanging(true);
    try { await onCaptureChange({ debugMode, debugFullCapture: debugMode && debugFullCapture }); }
    catch { setError(true); }
    finally { setChanging(false); }
  }
  function changeView(next: "ai" | "debug") { setView(next); setOffset(0); setKind("all"); setSelected(null); }
  const totals = page?.totals;
  return <div className="grid min-w-0 gap-4 text-slate-900 dark:text-slate-100">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-lg font-semibold"><Activity className="h-5 w-5 text-cyan-600" />{t("monitoring.title")}</h2>
        <p className="mt-1 text-xs text-slate-500">{t("monitoring.description")}</p></div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs"><Switch checked={live} onChange={(event) => setLive(event.target.checked)} />{t("monitoring.live")}</label>
        <Button type="button" disabled={loading} onClick={() => { setOffset(0); setAnchor(new Date().toISOString()); }}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />{t("debug.refresh")}</Button>
        <Button type="button" onClick={() => setCleanupOpen(!cleanupOpen)} aria-expanded={cleanupOpen}><Trash2 className="h-4 w-4" />{t("monitoring.cleanup")}</Button>
      </div>
    </div>
    <div role="tablist" aria-label={t("monitoring.title")} className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
      {(["ai", "debug"] as const).map((tab, index) => <button key={tab} id={`monitoring-tab-${tab}`} type="button" role="tab" aria-selected={view === tab} aria-controls="monitoring-panel" tabIndex={view === tab ? 0 : -1}
        onKeyDown={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "ai" : event.key === "End" ? "debug" : index ? "ai" : "debug"; changeView(next); document.getElementById(`monitoring-tab-${next}`)?.focus(); } }}
        onClick={() => changeView(tab)} className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium ${view === tab ? "border-cyan-600 text-cyan-700 dark:text-cyan-300" : "border-transparent text-slate-500"}`}>
        {tab === "ai" ? <Activity className="h-4 w-4" /> : <Bug className="h-4 w-4" />}{t(`monitoring.tabs.${tab}`)}
        {tab === "debug" && enabled && <span className="h-2 w-2 rounded-full bg-amber-500" aria-label={t("debug.recording")} />}
      </button>)}
    </div>
    {cleanupOpen && <Cleanup t={t} onCleaned={() => { setOffset(0); setAnchor(new Date().toISOString()); setSelected(null); setSimilarityVersion((value) => value + 1); }} />}
    <section id="monitoring-panel" role="tabpanel" aria-labelledby={`monitoring-tab-${view}`} className="grid min-w-0 gap-4">
      {view === "debug" && <div className={`${panel} grid gap-3 p-3 sm:grid-cols-2`}>
        <label className="flex items-start gap-3"><Switch className="mt-1" checked={enabled} disabled={changing} onChange={(event) => void changeCapture(event.target.checked, false)} /><span><span className="text-sm font-medium">{t("monitoring.debugCapture")}</span><span className="mt-1 block text-xs text-slate-500">{t("monitoring.debugDescription")}</span></span></label>
        <label className="flex items-start gap-3"><Switch className="mt-1" checked={enabled && fullCapture} disabled={!enabled || changing} onChange={(event) => void changeCapture(enabled, event.target.checked)} /><span><span className="text-sm font-medium">{t("monitoring.fullCapture")}</span><span className="mt-1 block text-xs text-slate-500">{t("monitoring.fullDescription")}</span></span></label>
      </div>}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        {([
          ["executions", totals?.count], ["running", totals?.running], ["failed", totals?.failed],
          ["inputTokens", totals?.inputTokens], ["outputTokens", totals?.outputTokens],
          ["reasoningTokens", totals?.reasoningTokens], ["cachedInputTokens", totals?.cachedInputTokens], ["totalTokens", totals?.tokens]
        ] as const).map(([label, value]) => <div key={label} className={`${panel} px-3 py-2`}><div className="text-[10px] font-medium text-slate-500">{t(`monitoring.${label}`)}</div><div className="mt-1 font-mono text-lg tabular-nums">{number(value)}</div></div>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>{t("monitoring.usageNote")} {totals && totals.missingUsage > 0 && `${t("monitoring.missingUsage")}: ${number(totals.missingUsage)}`}</span>
        <span>{t("monitoring.cost")}: {totals?.costEstimate == null ? "—" : totals.costEstimate.toFixed(6)} · {t("monitoring.missingCost")}: {number(totals?.missingCost)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className={`${field} min-w-52 flex-1`} aria-label={t("monitoring.search")} placeholder={t("monitoring.search")} value={search} onChange={(event) => setSearch(event.target.value)} />
        <select className={field} aria-label={t("monitoring.kind")} value={kind} onChange={(event) => { setKind(event.target.value as MonitoringQuery["kind"]); setOffset(0); }}>
          {(["all", "embedding", "llm", ...(view === "debug" ? ["operation"] : [])]).map((key) => <option key={key} value={key}>{t(`monitoring.kinds.${key}` as MessageKey)}</option>)}
        </select>
        <select className={field} aria-label={t("monitoring.status")} value={status} onChange={(event) => { setStatus(event.target.value as MonitoringQuery["status"]); setOffset(0); }}>
          {["all", "running", "succeeded", "failed", "canceled", "interrupted"].map((key) => <option key={key} value={key}>{t(`monitoring.statuses.${key}` as MessageKey)}</option>)}
        </select>
        <select className={field} aria-label={t("monitoring.period")} value={days} onChange={(event) => { setDays(Number(event.target.value)); setOffset(0); }}>
          {[1, 7, 30, 0].map((value) => <option key={value} value={value}>{t(`monitoring.periods.${value}` as MessageKey)}</option>)}
        </select>
      </div>
      {error && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{t("monitoring.error")} <button type="button" className="underline" onClick={() => void refresh()}>{t("debug.refresh")}</button></div>}
      <div className={`${panel} min-w-0 max-w-full overflow-x-auto`} aria-busy={loading}>
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-50 text-[10px] text-slate-500 dark:bg-slate-900"><tr>
            {["operation", "source", "model", ...tokenKeys, "duration"].map((key) => <th key={key} className="whitespace-nowrap px-3 py-2 font-medium">{t(`monitoring.${key}` as MessageKey)}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {page?.rows.map((row) => <Fragment key={row.id}><tr className={selected === row.id ? "bg-cyan-50/70 dark:bg-cyan-950/25" : "hover:bg-slate-50 dark:hover:bg-slate-900/50"}>
              <td className="max-w-72 px-3 py-2"><button type="button" className="flex w-full items-start gap-1.5 text-left" aria-expanded={selected === row.id} onClick={() => setSelected(selected === row.id ? null : row.id)}>
                {selected === row.id ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />}<span className="min-w-0"><span className="block truncate font-medium" title={row.operation}>{row.operation}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-slate-500" title={`${row.stage} · ${row.id}`}>{row.stage} · {new Date(row.startedAt).toLocaleTimeString()}</span>
                  <span className={`mt-1 inline-flex items-center gap-1 text-[10px] ${row.status === "succeeded" ? "text-emerald-700 dark:text-emerald-400" : row.status === "running" ? "text-cyan-700 dark:text-cyan-300" : "text-amber-700 dark:text-amber-300"}`}>{t(`monitoring.statuses.${row.status}`)}{row.hasPayload && <span title={t("monitoring.fullCapture")} className="font-mono"> · {"{ }"}</span>}</span>
                </span></button></td>
              <td className="max-w-48 px-3 py-2"><span className="block truncate" title={row.sources.map((source) => `${source.title} (${source.id})`).join("\n")}>{row.sources[0]?.title ?? (typeof row.context.sourceTitle === "string" ? row.context.sourceTitle : typeof row.context.fileName === "string" ? row.context.fileName : t("monitoring.noSource"))}</span><span className="block text-[10px] text-slate-500">{row.sources.length > 1 ? `+${row.sources.length - 1} · ` : ""}{String(row.context.origin ?? "—")}</span></td>
              <td className="max-w-44 px-3 py-2"><span className="block truncate" title={row.modelId ?? ""}>{row.modelId ?? "—"}</span><span className="text-[10px] text-slate-500">{[row.provider, row.runtime].filter(Boolean).join(" · ")}</span></td>
              {tokenKeys.map((key) => <td key={key} className={`px-3 py-2 text-right font-mono tabular-nums ${key === "reasoningTokens" ? "text-violet-700 dark:text-violet-300" : key === "cachedInputTokens" ? "text-amber-700 dark:text-amber-300" : ""}`}>{number(row.tokenUsage[key])}</td>)}
              <td className="whitespace-nowrap px-3 py-2 text-right font-mono">{row.durationMs == null ? "—" : `${(row.durationMs / 1000).toFixed(2)}s`}</td>
            </tr>{selected === row.id && <tr><td colSpan={9} className="bg-slate-50 p-3 dark:bg-slate-900/40"><OperationDetail key={`${row.id}:${row.status}`} row={row} t={t} onOpenSource={onOpenSource} /></td></tr>}</Fragment>)}
          </tbody>
        </table>
        {!page?.rows.length && <div role="status" className="p-10 text-center text-sm text-slate-500">{loading ? t("shell.states.loading") : t(view === "ai" ? "monitoring.empty" : "monitoring.debugEmpty")}</div>}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span>{t("monitoring.filteredTotal")}: {number(totals?.count)} · {offset + (page?.rows.length ? 1 : 0)}–{offset + (page?.rows.length ?? 0)}{offset > 0 && live ? ` · ${t("monitoring.pagePaused")}` : ""}</span>
        <div className="flex gap-2"><Button type="button" disabled={offset === 0 || loading} onClick={() => { setOffset(Math.max(0, offset - limit)); setSelected(null); }}>{t("monitoring.previous")}</Button><Button type="button" disabled={loading || offset + limit >= (totals?.count ?? 0)} onClick={() => { setOffset(offset + limit); setSelected(null); }}>{t("monitoring.next")}</Button></div>
      </div>
      {view === "debug" && <details className={`${panel} p-3`} onToggle={(event) => setSimilarityOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">{t("debug.captureTitle")}</summary>{similarityOpen && <div className="mt-4"><DebugDashboard key={similarityVersion} enabled={enabled} t={t} onEnabledChange={(next) => changeCapture(next, false)} embedded /></div>}</details>}
      {view === "debug" && <details className={`${panel} p-3`} onToggle={(event) => setSyncOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">{t("monitoring.sync")}</summary>{syncOpen && <div className="mt-3"><ObsidianSyncStatusCard available t={t} /></div>}</details>}
    </section>
  </div>;
}

function OperationDetail({ row, t, onOpenSource }: { row: MonitoringRow; t: Translator; onOpenSource: (id: string) => void }) {
  const [detail, setDetail] = useState<MonitoringDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    void window.app.monitoring.detail(row.id).then((value) => { if (active) { setDetail(value); setFailed(!value); } }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [row.id, retry]);
  if (failed) return <div role="alert">{t("monitoring.error")} <button type="button" className="underline" onClick={() => setRetry(retry + 1)}>{t("debug.refresh")}</button></div>;
  if (!detail) return <p role="status">{t("shell.states.loading")}</p>;
  return <div className="grid min-w-0 gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-[11px] text-slate-500">{row.id} · {new Date(row.startedAt).toLocaleString()}</span><button type="button" className="flex items-center gap-1 text-xs" onClick={() => { void navigator.clipboard.writeText(JSON.stringify(detail, null, 2)).then(() => setCopied(true), () => setFailed(true)); }}><Copy className="h-3.5 w-3.5" />{t(copied ? "monitoring.copied" : "monitoring.copy")}</button></div>
    {row.sources.length > 0 && <div className="flex flex-wrap gap-2">{row.sources.map((source) => <button key={source.id} type="button" onClick={() => onOpenSource(source.id)} className="rounded border border-cyan-200 px-2 py-1 text-cyan-800 dark:border-cyan-900 dark:text-cyan-300" title={source.id}>{source.title} ↗</button>)}</div>}
    {row.error && <pre className="whitespace-pre-wrap break-words rounded border border-red-300 p-3 text-red-700 dark:text-red-300">{row.error}</pre>}
    <div className="grid min-w-0 gap-3 lg:grid-cols-2">
      {detail.hasPayload ? <><CodePanel title={t("monitoring.input")} value={detail.input} tone="input" t={t} /><CodePanel title={t("monitoring.output")} value={detail.output} tone="output" t={t} /></> : <p className="text-xs text-slate-500 lg:col-span-2">{t("monitoring.noPayload")}</p>}
      <details className="min-w-0 lg:col-span-2"><summary className="cursor-pointer text-xs font-medium text-slate-500">{t("monitoring.provenance")} · {t("monitoring.parameters")}</summary><div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
      <CodePanel title={t("monitoring.provenance")} value={{ ...detail.context, stage: detail.stage, taskType: detail.taskType, aiTaskRunId: detail.aiTaskRunId, profileId: detail.profileId, sources: detail.sources }} tone="neutral" t={t} />
      <CodePanel title={t("monitoring.parameters")} value={{ parameters: detail.parameters, tokenUsage: detail.tokenUsage, costEstimate: detail.costEstimate, details: detail.details }} tone="neutral" t={t} />
      </div></details>
    </div>
  </div>;
}

export function CodePanel({ title, value, tone, t }: { title: string; value: unknown; tone: "input" | "output" | "neutral"; t: Translator }) {
  const [limit, setLimit] = useState(32_000);
  let parsed = value;
  if (typeof value === "string") { try { parsed = JSON.parse(value.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, "$1")); } catch { /* Plain prompts and Markdown remain readable text. */ } }
  const json = typeof parsed !== "string";
  const text = (json ? JSON.stringify(parsed, null, 2) : parsed as string) ?? "—";
  const visible = text.slice(0, limit);
  const tokens = json ? visible.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g) : [visible];
  return <section className={`min-w-0 overflow-hidden rounded-lg border ${tone === "input" ? "border-cyan-300 dark:border-cyan-800" : tone === "output" ? "border-violet-300 dark:border-violet-800" : "border-slate-200 dark:border-slate-700"}`}>
    <h4 className={`flex items-center justify-between px-3 py-2 text-xs font-semibold ${tone === "input" ? "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200" : tone === "output" ? "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200" : "bg-slate-100 dark:bg-slate-800"}`}>{title}<span className="font-mono text-[10px] opacity-60">{json ? "JSON" : "TXT"}</span></h4>
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-200"><code>{tokens.map((token, index) => <span key={index} className={!json ? "" : /^".*:\s*$/.test(token) ? "text-sky-300" : token.startsWith('"') ? "text-emerald-300" : /^(true|false|null)$/.test(token) ? "text-fuchsia-300" : /^-?\d/.test(token) ? "text-amber-300" : ""}>{token}</span>)}</code></pre>
    {text.length > limit && <button type="button" className="w-full px-3 py-2 text-xs" onClick={() => setLimit(limit + 32_000)}>{t("monitoring.showMore")} ({number(limit)}/{number(text.length)})</button>}
  </section>;
}

function Cleanup({ t, onCleaned }: { t: Translator; onCleaned: () => void }) {
  const [amount, setAmount] = useState("30");
  const [unit, setUnit] = useState<"days" | "months">("days");
  const [scope, setScope] = useState<"all" | "payloads">("all");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const valid = /^\d+$/.test(amount) && Number(amount) >= 1 && Number(amount) <= 3650;
  async function clean() {
    if (!valid) return;
    setBusy(true); setMessage("");
    try {
      const input = { amount: Number(amount), unit, scope };
      const preview = await window.app.monitoring.prune({ ...input, preview: true });
      if (!preview.count) { setMessage(t("monitoring.nothingToClean")); return; }
      if (!window.confirm(`${t("monitoring.cleanConfirmation")}\n${t("monitoring.before")}: ${new Date(preview.cutoff).toLocaleString()}\n${t("monitoring.kinds.all")}: ${preview.count}\n${t(scope === "all" ? "monitoring.cleanAll" : "monitoring.cleanPayloads")}`)) return;
      const result = await window.app.monitoring.prune({ ...input, preview: false });
      setMessage(`${t("monitoring.cleaned")}: ${number(result.count)}`); onCleaned();
    } catch { setMessage(t("monitoring.error")); }
    finally { setBusy(false); }
  }
  return <div className={`${panel} grid gap-3 p-3`}><p className="text-xs text-slate-500">{t("monitoring.cleanupDescription")}</p>
    <div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-xs">{t("monitoring.olderThan")}<input type="number" min="1" max="3650" className={`${field} w-20`} value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <select className={field} aria-label={t("monitoring.unit")} value={unit} onChange={(event) => setUnit(event.target.value as "days" | "months")}><option value="days">{t("monitoring.days")}</option><option value="months">{t("monitoring.months")}</option></select>
      <select className={field} aria-label={t("monitoring.scope")} value={scope} onChange={(event) => setScope(event.target.value as "all" | "payloads")}><option value="all">{t("monitoring.cleanAll")}</option><option value="payloads">{t("monitoring.cleanPayloads")}</option></select>
      <Button type="button" disabled={busy || !valid} onClick={() => void clean()}><Trash2 className="h-4 w-4" />{t("monitoring.cleanup")}</Button><span role="status" className="text-xs">{message}</span>
    </div></div>;
}
