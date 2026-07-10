import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import type { SearchResult } from "../../shared/ipc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function SearchView({ t }: { t: (key: MessageKey) => string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try { setResults(await window.app.search.query({ text: query, sourceTypes: [], mode: "hybrid", limit: 20 })); }
    finally { setLoading(false); }
  }

  return <section className="grid gap-5">
    <form className="flex gap-2" onSubmit={submit}><Input required value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} /><Button disabled={loading} type="submit"><Search className="h-4 w-4" aria-hidden="true" />{t("search.action")}</Button></form>
    {results.length === 0 ? <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">{t("search.empty")}</p> : (
      <ol className="grid gap-3">{results.map((result) => <li key={result.chunkId} className="grid gap-2 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"><div className="flex items-center justify-between gap-4"><h2 className="font-semibold">{result.sourceTitle}</h2><span className="text-xs text-slate-500">{Math.round(result.finalScore * 100)}%</span></div><p className="line-clamp-4 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">{result.excerpt}</p><p className="text-xs text-slate-500">{result.page ? `${t("search.page")} ${result.page}` : t("search.markdownEvidence")}</p></li>)}</ol>
    )}
  </section>;
}
