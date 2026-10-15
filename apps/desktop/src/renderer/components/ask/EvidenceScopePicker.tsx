import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { MessageKey } from "@app/i18n";
const control =
  "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900";
export function EvidenceScopePicker({
  selected,
  onChange,
  t,
  hint = "organization.scopeHint"
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
  t: (key: MessageKey) => string;
  hint?: MessageKey;
}) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [query, setQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [retry, setRetry] = useState(0);
  // The page on screen belongs to the request that produced it; a newer request is loading.
  const request = `${query}\u0000${offset}\u0000${retry}`;
  const [page, setPage] = useState<{
    request: string;
    items: Array<{ id: string; title: string }>;
    more: boolean;
    failed: boolean;
  } | null>(null);
  const loading = page?.request !== request,
    failed = !loading && page.failed,
    items = loading ? [] : page.items,
    more = !loading && page.more;
  useEffect(() => {
    let current = true;
    const timer = setTimeout(
      () =>
        void window.app.wiki
          .search({ kind: "source", text: query, offset, limit: 30 })
          .then((result) => {
            if (!current) return;
            setLabels((old) => ({
              ...old,
              ...Object.fromEntries(result.items.map((i) => [i.id, i.title]))
            }));
            setPage({ request, items: result.items, more: result.hasMore, failed: false });
          })
          .catch(() => {
            if (current) setPage({ request, items: [], more: false, failed: true });
          }),
      150
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [request, query, offset]);
  return (
    <div className="grid gap-2">
      <label className="grid gap-1 text-sm">
        {t("organization.sourceScope")}
        <input
          className={control}
          aria-label={t("wiki.search")}
          placeholder={t("wiki.search")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      <p className="text-xs text-slate-500">
        {t(hint)} · {selected.length}/100
      </p>
      <div className="flex flex-wrap gap-1">
        {selected.map((id) => (
          <button
            type="button"
            key={id}
            className="rounded-full bg-cyan-500/10 px-2 py-1 text-xs text-cyan-700 focus-visible:ring-2 dark:text-cyan-300"
            onClick={() => onChange(selected.filter((v) => v !== id))}
          >
            {labels[id] ?? id.slice(0, 8)}{" "}
            <X size={12} className="inline" aria-label={t("organization.close")} />
          </button>
        ))}
      </div>
      {failed ? (
        <p role="alert" className="text-sm text-red-600">
          {t("consultation.errors.sources")}{" "}
          <button className={control} onClick={() => setRetry((v) => v + 1)}>
            {t("organization.refresh")}
          </button>
        </p>
      ) : loading ? (
        <p role="status" className="text-sm">
          {t("organization.loading")}
        </p>
      ) : (
        <div className="grid max-h-48 gap-1 overflow-auto rounded-lg border border-slate-200 p-2 dark:border-slate-800 sm:grid-cols-2">
          {items.map((item) => (
            <label
              key={item.id}
              className="flex min-w-0 items-center gap-2 rounded p-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                disabled={!selected.includes(item.id) && selected.length >= 100}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, item.id]
                      : selected.filter((id) => id !== item.id)
                  )
                }
              />
              <span className="truncate">{item.title}</span>
            </label>
          ))}
          {!items.length && <p className="text-sm text-slate-500">{t("consultation.noSources")}</p>}
        </div>
      )}
      <div className="flex gap-2">
        <button
          className={control}
          disabled={loading || offset === 0}
          onClick={() => setOffset((v) => Math.max(0, v - 30))}
        >
          {t("sourceRelations.previous")}
        </button>
        <button
          className={control}
          disabled={loading || !more}
          onClick={() => setOffset((v) => v + 30)}
        >
          {t("sourceRelations.next")}
        </button>
      </div>
    </div>
  );
}
