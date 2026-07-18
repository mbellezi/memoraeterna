import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, FileText, Lightbulb, Search, SquareLibrary } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";
import type { LibrarySource, SearchResult } from "../../shared/ipc";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export interface SearchViewState {
  query: string;
  rootSourceItemId: string;
  results: SearchResult[];
  searched: boolean;
}

export const defaultSearchViewState: SearchViewState = {
  query: "",
  rootSourceItemId: "",
  results: [],
  searched: false
};

export function SearchView({ t, state, onStateChange, onOpenSource }: {
  t: Translator;
  state?: SearchViewState;
  onStateChange?: (state: SearchViewState) => void;
  onOpenSource?: (sourceItemId: string) => void;
}) {
  const [localState, setLocalState] = useState<SearchViewState>(defaultSearchViewState);
  const current = state ?? localState;
  const update = onStateChange ?? setLocalState;
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { void window.app.knowledge.listLibrary([]).then(setSources).catch(() => undefined); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const results = await window.app.search.query({
        text: current.query,
        sourceTypes: [],
        mode: "hybrid",
        limit: 20,
        ...(current.rootSourceItemId ? { rootSourceItemId: current.rootSourceItemId } : {})
      });
      update({ ...current, results, searched: true });
    } finally {
      setLoading(false);
    }
  }

  return <section className="grid gap-5">
    <form className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950" onSubmit={submit}>
      <div className="flex gap-2">
        <Input required value={current.query} onChange={(event) => update({ ...current, query: event.target.value })} placeholder={t("search.placeholder")} />
        <Button disabled={loading} type="submit"><Search className="h-4 w-4" aria-hidden="true" />{t("search.action")}</Button>
      </div>
      <label className="grid gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
        {t("search.scope")}
        <select value={current.rootSourceItemId} onChange={(event) => update({ ...current, rootSourceItemId: event.target.value })}
          className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal dark:border-slate-700 dark:bg-slate-950">
          <option value="">{t("search.scopeAll")}</option>
          {sources.filter((source) => source.childCount > 0).map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
        </select>
      </label>
    </form>
    {current.results.length === 0 ? (
      <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">{t("search.empty")}</p>
    ) : <>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("search.resultsCount", { values: { count: current.results.length } })}</p>
      <ol className="grid gap-3">
        {current.results.map((result) => <li key={result.kind === "chunk" ? result.chunkId : result.noteId} className="motion-fade-in-up">
          <SearchResultCard result={result} t={t} onOpen={onOpenSource ? () => onOpenSource(result.sourceItemId) : undefined} />
        </li>)}
      </ol>
    </>}
  </section>;
}

function SearchResultCard({ result, t, onOpen }: {
  result: SearchResult;
  t: Translator;
  onOpen?: (() => void) | undefined;
}) {
  const isNote = result.kind === "atomic_note";
  const isSubitem = !isNote && result.breadcrumbs.length > 0;
  const kindStyle = isNote
    ? "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200"
    : isSubitem
      ? "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"
      : "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200";
  const KindIcon = isNote ? Lightbulb : isSubitem ? FileText : SquareLibrary;
  const kindLabel = t(isNote ? "search.kinds.atomicNote" : isSubitem ? "search.kinds.subitem" : "search.kinds.source");

  return (
    <article
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      title={onOpen ? t("search.openHint") : undefined}
      className={cn(
        "grid gap-2 rounded-xl border border-slate-200 bg-white p-4 transition dark:border-slate-800 dark:bg-slate-900",
        onOpen && "cursor-pointer hover:-translate-y-0.5 hover:border-cyan-400 hover:shadow-md dark:hover:border-cyan-700"
      )}
      onClick={onOpen}
      onKeyDown={onOpen ? (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } } : undefined}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold", kindStyle)}>
              <KindIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {kindLabel}
            </span>
            {isNote ? <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] dark:bg-slate-800">{t(`knowledge.notes.status.${result.status}` as MessageKey)}</span> : null}
          </div>
          {result.breadcrumbs.length > 0 ? (
            <div className="mb-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
              {result.breadcrumbs.map((item, index) => <span key={item.id} className="inline-flex items-center gap-1">
                {index > 0 ? <ChevronRight className="h-3 w-3" aria-hidden="true" /> : null}{item.title}
              </span>)}
            </div>
          ) : null}
          <h2 className="font-semibold leading-snug">{isNote ? result.title : result.sourceTitle}</h2>
          {isNote ? <p className="mt-0.5 text-sm font-medium text-slate-700 dark:text-slate-300">{result.ideaStatement}</p> : null}
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
          {Math.round(result.finalScore * 100)}%
        </span>
      </div>
      <p className="line-clamp-4 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{result.excerpt}</p>
      <p className="text-xs text-slate-500">
        {isNote
          ? result.sourceTitle
          : result.page ? `${t("search.page")} ${result.page}` : t("search.markdownEvidence")}
      </p>
    </article>
  );
}
