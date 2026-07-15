import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, ExternalLink, FileText, Play, RefreshCw, X } from "lucide-react";
import { SourceItemTypes, type ProcessingPlanRequest, type SourceItemType } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import type { LibrarySource, SourceDetail } from "../../shared/ipc";
import { Button } from "./ui/button";
import { defaultProcessingPlan, ProcessingPlanPicker } from "./ProcessingPlanPicker";

export function LibraryView({ t }: { t: Translator }) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [selected, setSelected] = useState<SourceDetail | null>(null);
  const [filter, setFilter] = useState<SourceItemType | "all">("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [processingIds, setProcessingIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function load() {
    setLoading(true);
    setError(false);
    try {
      setSources(await window.app.knowledge.listLibrary(filter === "all" ? [] : [filter]));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  async function openSource(id: string) {
    setLoading(true);
    setError(false);
    try {
      setSelected(await window.app.knowledge.getSourceDetail(id));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [filter]);

  if (selected) {
    return <SourceDetailView detail={selected} t={t} onBack={() => setSelected(null)} />;
  }

  const orderedSources = orderHierarchically(sources);

  return <section className="grid gap-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <label className="grid gap-1 text-sm font-medium">
        {t("library.filterByType")}
        <select value={filter} onChange={(event) => setFilter(event.target.value as SourceItemType | "all")}
          className="h-9 min-w-52 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
          <option value="all">{t("library.allTypes")}</option>
          {SourceItemTypes.map((type) => <option key={type} value={type}>{t(`import.sourceTypes.${type}` as MessageKey)}</option>)}
        </select>
      </label>
      <button type="button" className="grid h-9 w-9 place-items-center rounded-md hover:bg-slate-100 dark:hover:bg-slate-900"
        title={t("library.refresh")} onClick={() => void load()}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
    {selectedIds.size > 0 ? <div className="sticky top-2 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-cyan-200 bg-cyan-50/95 px-4 py-3 shadow-sm backdrop-blur dark:border-cyan-900 dark:bg-cyan-950/95">
      <span className="text-sm font-semibold text-cyan-900 dark:text-cyan-100">{t("library.selectionCount", { values: { count: selectedIds.size } })}</span>
      <div className="flex gap-2"><Button type="button" onClick={() => setProcessingIds([...selectedIds])}><Play className="h-4 w-4" />{t("library.actions.processSelected")}</Button><button type="button" className="grid h-9 w-9 place-items-center rounded-lg" title={t("library.actions.clearSelection")} onClick={() => setSelectedIds(new Set())}><X className="h-4 w-4" /></button></div>
    </div> : null}
    {error ? <StateCard>{t("library.error")}</StateCard> : loading ? <StateCard>{t("shell.states.loading")}</StateCard>
      : sources.length === 0 ? <StateCard>{t("library.empty")}</StateCard>
        : <ol className="grid gap-2">{orderedSources.map(({ source, depth }) => <li key={source.id} style={{ marginLeft: `${Math.min(depth, 5) * 22}px` }}>
          <div role="button" tabIndex={0} onClick={() => void openSource(source.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void openSource(source.id); }}
            className="grid w-full gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-cyan-400 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-cyan-700">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <input type="checkbox" aria-label={t("library.actions.selectSource", { values: { title: source.title } })} checked={selectedIds.has(source.id)} className="mt-1 h-4 w-4 accent-cyan-600" onClick={(event) => event.stopPropagation()} onChange={(event) => setSelectedIds((current) => { const next = new Set(current); if (event.target.checked) next.add(source.id); else next.delete(source.id); return next; })} />
                {depth > 0 ? <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" /> : null}
                <div className="min-w-0"><h2 className="truncate font-semibold">{source.title}</h2><p className="text-xs text-slate-500">{t(`import.sourceTypes.${source.type}` as MessageKey)}{source.childCount > 0 ? ` · ${t("library.childCount", { values: { count: source.childCount } })}` : ""}</p></div>
              </div>
              <div className="flex items-center gap-2"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{t(processingKey(source.processingStatus))}</span><button type="button" className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 hover:bg-cyan-50 dark:border-slate-700 dark:hover:bg-cyan-950" title={t("library.actions.process")} onClick={(event) => { event.stopPropagation(); setProcessingIds([source.id]); }}><Play className="h-3.5 w-3.5" /></button></div>
            </div>
            {source.summary ? <p className="line-clamp-2 text-sm text-slate-600 dark:text-slate-300">{source.summary}</p> : null}
            <p className="text-xs text-slate-500">{t("library.currentStage", { values: { stage: t(stageKey(source.currentStage)) } })}</p>
          </div>
        </li>)}</ol>}
    {processingIds ? <ProcessingDialog sourceIds={processingIds} sources={sources} t={t} onClose={() => setProcessingIds(null)} onQueued={() => { setProcessingIds(null); setSelectedIds(new Set()); void load(); }} /> : null}
  </section>;
}

function ProcessingDialog({ sourceIds, sources, t, onClose, onQueued }: { sourceIds: string[]; sources: LibrarySource[]; t: Translator; onClose: () => void; onQueued: () => void }) {
  const [plan, setPlan] = useState<ProcessingPlanRequest>(() => ({ ...defaultProcessingPlan("search_ready"), targetSourceItemIds: sourceIds, scope: sourceIds.length > 1 ? "selected_items" : "source_only" }));
  const [busy, setBusy] = useState(false);
  const selected = sources.filter((source) => sourceIds.includes(source.id));
  async function queue() {
    setBusy(true);
    try {
      await window.app.ingestion.process({ plan: { ...plan, targetSourceItemIds: sourceIds }, runKind: plan.forceRegeneration ? "reingestion" : "missing_stages", trigger: "library_action" });
      onQueued();
    } finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t("library.processingDialog.title")}>
    <div className="max-h-[92vh] w-full max-w-4xl overflow-auto rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950">
      <header className="flex items-start justify-between gap-4 border-b border-slate-200 p-5 dark:border-slate-800"><div><h2 className="text-lg font-semibold">{t("library.processingDialog.title")}</h2><p className="mt-1 text-sm text-slate-500">{t("library.processingDialog.description", { values: { count: sourceIds.length } })}</p></div><button type="button" className="grid h-9 w-9 place-items-center rounded-lg" onClick={onClose}><X className="h-4 w-4" /></button></header>
      <div className="grid gap-5 p-5">
        <div className="flex flex-wrap gap-2">{selected.map((source) => <span key={source.id} className="rounded-full bg-slate-100 px-3 py-1 text-xs dark:bg-slate-900">{source.title}</span>)}</div>
        {sourceIds.length === 1 ? <label className="grid gap-2 text-sm font-semibold">{t("library.processingDialog.scope")}<select value={plan.scope} onChange={(event) => setPlan({ ...plan, scope: event.target.value as ProcessingPlanRequest["scope"] })} className="h-10 rounded-lg border border-slate-300 bg-white px-3 font-normal dark:border-slate-700 dark:bg-slate-950"><option value="source_only">{t("library.scopes.source_only")}</option><option value="children_only">{t("library.scopes.children_only")}</option><option value="source_and_children">{t("library.scopes.source_and_children")}</option></select></label> : null}
        <ProcessingPlanPicker value={plan} onChange={(next) => setPlan({ ...next, targetSourceItemIds: sourceIds, scope: sourceIds.length > 1 ? "selected_items" : next.scope })} t={t} />
        <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-amber-600" checked={plan.forceRegeneration} onChange={(event) => setPlan({ ...plan, forceRegeneration: event.target.checked, previousArtifactPolicy: event.target.checked ? "preserve_reviewed_archive_pending" : "reuse_valid" })} /><span><span className="block font-semibold">{t("library.processingDialog.regenerate")}</span><span className="text-xs text-slate-600 dark:text-slate-400">{t("library.processingDialog.regenerateHint")}</span></span></label>
      </div>
      <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-slate-200 bg-white/95 p-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"><Button type="button" onClick={onClose}>{t("shell.actions.cancel")}</Button><Button type="button" disabled={busy} onClick={() => void queue()}><Play className="h-4 w-4" />{t("library.actions.queueProcessing")}</Button></footer>
    </div>
  </div>;
}

function orderHierarchically(sources: LibrarySource[]): Array<{ source: LibrarySource; depth: number }> {
  const ids = new Set(sources.map((source) => source.id));
  const byParent = new Map<string | null, LibrarySource[]>();
  for (const source of sources) {
    const parent = source.parentSourceItemId && ids.has(source.parentSourceItemId) ? source.parentSourceItemId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), source]);
  }
  const result: Array<{ source: LibrarySource; depth: number }> = [];
  const seen = new Set<string>();
  function visit(source: LibrarySource, depth: number) {
    if (seen.has(source.id)) return;
    seen.add(source.id); result.push({ source, depth });
    for (const child of byParent.get(source.id) ?? []) visit(child, depth + 1);
  }
  for (const root of byParent.get(null) ?? []) visit(root, 0);
  for (const source of sources) visit(source, 0);
  return result;
}

function SourceDetailView({ detail, t, onBack }: { detail: SourceDetail; t: Translator; onBack: () => void }) {
  return <section className="grid gap-5">
    <div className="flex items-start justify-between gap-4">
      <div className="grid gap-1"><h2 className="text-xl font-semibold">{detail.title}</h2><p className="text-sm text-slate-500">{t(`import.sourceTypes.${detail.type}` as MessageKey)}</p></div>
      <Button type="button" onClick={onBack}><ArrowLeft className="h-4 w-4" aria-hidden="true" />{t("library.back")}</Button>
    </div>
    <section className="grid gap-3 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between gap-4"><h3 className="font-semibold">{t("library.sections.metadata")}</h3>{detail.sourceUri ? <a href={detail.sourceUri} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm text-cyan-700 dark:text-cyan-300"><ExternalLink className="h-4 w-4" aria-hidden="true" />{t("library.openOriginal")}</a> : null}</div>
      <pre className="overflow-auto whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">{JSON.stringify(detail.metadata, null, 2)}</pre>
    </section>
    <section className="grid gap-2 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h3 className="font-semibold">{t("library.sections.summary")}</h3>
      <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{detail.summary ?? t("library.noSummary")}</p>
    </section>
    {detail.documents.map((document) => <section key={document.id} className="grid gap-4 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h3 className="font-semibold">{t("library.sections.document")}</h3>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-sm dark:bg-slate-950">{document.canonicalMarkdown}</pre>
      {document.assets.length > 0 ? <div className="grid gap-2"><h4 className="text-sm font-semibold">{t("library.sections.originals")}</h4><ul className="grid gap-1 text-sm">{document.assets.map((asset) => <li key={asset.id}><button type="button" className="inline-flex items-center gap-2 text-cyan-700 dark:text-cyan-300" onClick={() => void window.app.knowledge.openAsset(asset.id)}><FileText className="h-4 w-4" aria-hidden="true" />{asset.originalFileName}<span className="sr-only">{t("library.openFile")}</span></button></li>)}</ul></div> : null}
      <details><summary className="cursor-pointer text-sm font-semibold">{t("library.sections.chunks")}</summary><ol className="mt-3 grid gap-2">{document.chunks.map((chunk) => <li key={chunk.id} className="rounded border border-slate-200 p-3 text-sm dark:border-slate-800"><p className="mb-1 text-xs text-slate-500">{t("library.chunk", { values: { index: chunk.chunkIndex + 1 } })}</p><p className="whitespace-pre-wrap">{chunk.content}</p></li>)}</ol></details>
    </section>)}
    <section className="grid gap-3"><h3 className="font-semibold">{t("library.sections.atomicNotes")}</h3>{detail.atomicNotes.length === 0 ? <StateCard>{t("knowledge.notes.emptyForSource")}</StateCard> : detail.atomicNotes.map((note) => <article key={note.id} className="grid gap-2 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"><div className="flex items-start justify-between gap-3"><h4 className="font-semibold">{note.title}</h4><span className="rounded-full bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{t(noteStatusKey(note.status))}</span></div><p className="text-sm font-medium">{note.ideaStatement}</p><p className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{note.bodyMarkdown}</p></article>)}</section>
    <section className="grid gap-3"><h3 className="font-semibold">{t("library.sections.relations")}</h3>{detail.relations.length === 0 ? <StateCard>{t("knowledge.relations.empty")}</StateCard> : detail.relations.map((relation) => <article key={relation.id} className="grid gap-2 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"><div className="flex items-start justify-between gap-4"><p className="text-sm font-medium">{relation.sourceTitle} ↔ {relation.targetTitle}</p><span className="text-xs text-slate-500">{Math.round(relation.finalScore * 100)}%</span></div><p className="text-sm">{t(relationTypeKey(relation.relationType))}</p><p className="text-sm text-slate-600 dark:text-slate-300">{relation.explanation.startsWith("knowledge.") ? t(relation.explanation as MessageKey) : relation.explanation}</p>{relation.sourceStatus === "pending_review" || relation.targetStatus === "pending_review" ? <span className="w-fit rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">{t("knowledge.relations.pendingInvolved")}</span> : null}</article>)}</section>
  </section>;
}

function StateCard({ children }: { children: string }) {
  return <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">{children}</p>;
}

function processingKey(status: string): MessageKey {
  return (`library.processing.${status}` as MessageKey);
}

function stageKey(stage: string): MessageKey {
  const normalized = ({
    atomicNotes: "atomicNotes",
    knowledgeGraph: "knowledgeGraph",
    atomicNoteMatching: "atomicNoteMatching"
  } as Record<string, string>)[stage] ?? stage;
  return (`jobs.stages.${normalized}` as MessageKey);
}

function noteStatusKey(status: string): MessageKey {
  return (`knowledge.notes.status.${status}` as MessageKey);
}

function relationTypeKey(type: string): MessageKey {
  return (`knowledge.relations.types.${type}` as MessageKey);
}
