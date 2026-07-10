import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, FileText, RefreshCw } from "lucide-react";
import { SourceItemTypes, type SourceItemType } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import type { LibrarySource, SourceDetail } from "../../shared/ipc";
import { Button } from "./ui/button";

export function LibraryView({ t }: { t: Translator }) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [selected, setSelected] = useState<SourceDetail | null>(null);
  const [filter, setFilter] = useState<SourceItemType | "all">("all");
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
    {error ? <StateCard>{t("library.error")}</StateCard> : loading ? <StateCard>{t("shell.states.loading")}</StateCard>
      : sources.length === 0 ? <StateCard>{t("library.empty")}</StateCard>
        : <ol className="grid gap-3">{sources.map((source) => <li key={source.id}>
          <button type="button" onClick={() => void openSource(source.id)}
            className="grid w-full gap-3 rounded-md border border-slate-200 bg-white p-4 text-left transition-colors hover:border-cyan-400 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-cyan-700">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0"><h2 className="truncate font-semibold">{source.title}</h2><p className="text-xs text-slate-500">{t(`import.sourceTypes.${source.type}` as MessageKey)}</p></div>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">{t(processingKey(source.processingStatus))}</span>
            </div>
            {source.summary ? <p className="line-clamp-2 text-sm text-slate-600 dark:text-slate-300">{source.summary}</p> : null}
            <p className="text-xs text-slate-500">{t("library.currentStage", { values: { stage: t(stageKey(source.currentStage)) } })}</p>
          </button>
        </li>)}</ol>}
  </section>;
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
  const normalized = ({ atomicNotes: "atomicNotes", atomicNoteMatching: "atomicNoteMatching" } as Record<string, string>)[stage] ?? stage;
  return (`jobs.stages.${normalized}` as MessageKey);
}

function noteStatusKey(status: string): MessageKey {
  return (`knowledge.notes.status.${status}` as MessageKey);
}

function relationTypeKey(type: string): MessageKey {
  return (`knowledge.relations.types.${type}` as MessageKey);
}
