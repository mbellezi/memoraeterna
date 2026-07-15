import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, Search } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { LibrarySource, SearchResult } from "../../shared/ipc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function SearchView({ t }: { t: Translator }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [rootSourceItemId, setRootSourceItemId] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { void window.app.knowledge.listLibrary([]).then(setSources); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try { setResults(await window.app.search.query({ text: query, sourceTypes: [], mode: "hybrid", limit: 20, ...(rootSourceItemId ? { rootSourceItemId } : {}) })); }
    finally { setLoading(false); }
  }

  return <section className="grid gap-5">
    <form className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950" onSubmit={submit}><div className="flex gap-2"><Input required value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} /><Button disabled={loading} type="submit"><Search className="h-4 w-4" aria-hidden="true" />{t("search.action")}</Button></div><label className="grid gap-1 text-xs font-semibold text-slate-600 dark:text-slate-300">{t("search.scope")}<select value={rootSourceItemId} onChange={(event) => setRootSourceItemId(event.target.value)} className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-normal dark:border-slate-700 dark:bg-slate-950"><option value="">{t("search.scopeAll")}</option>{sources.filter((source) => source.childCount > 0).map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}</select></label></form>
    {results.length === 0 ? <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">{t("search.empty")}</p> : (
      <ol className="grid gap-3">{results.map((result) => <li key={result.chunkId} className="grid gap-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"><div className="flex items-center justify-between gap-4"><div><div className="mb-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">{result.breadcrumbs.map((item, index) => <span key={item.id} className="inline-flex items-center gap-1">{index > 0 ? <ChevronRight className="h-3 w-3" /> : null}{item.title}</span>)}</div><h2 className="font-semibold">{result.sourceTitle}</h2></div><span className="text-xs text-slate-500">{Math.round(result.finalScore * 100)}%</span></div><p className="line-clamp-4 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{result.excerpt}</p><p className="text-xs text-slate-500">{result.page ? `${t("search.page")} ${result.page}` : t("search.markdownEvidence")}</p></li>)}</ol>
    )}
  </section>;
}
