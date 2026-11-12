import { useState } from "react";
import { FileText } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";
import type { SourceDetail } from "../../../../shared/ipc";
import { Button } from "../../../components/ui/button";
import { MarkdownPreview } from "../../../components/MarkdownEditor";
import { TagBadges } from "../../../components/ui/tag-input";
import { CollapsibleSection, metadataEntries } from "./source-parts";

/** The descriptor of a source as labelled fields, with the raw metadata and the cover file below. */
export function SourceDetails({ detail, t }: { detail: SourceDetail; t: Translator }) {
  return (
    <div className="grid gap-4">
      <dl className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 sm:grid-cols-2">
        {metadataEntries(detail.metadata).map(([key, value]) => (
          <div key={key}>
            <dt className="text-xs text-slate-500">
              {t(`import.metadataFields.${key}` as MessageKey)}
            </dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-sm">
              {key === "tags" ? (
                <span className="flex flex-wrap gap-1.5">
                  <TagBadges tags={value.split(/[,\n]/)} t={t} />
                </span>
              ) : (
                value
              )}
            </dd>
          </div>
        ))}
      </dl>
      <CollapsibleSection title={t("library.detail.rawMetadata")}>
        <pre className="overflow-auto whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300">
          {JSON.stringify(detail.metadata, null, 2)}
        </pre>
        {detail.assets
          .filter((asset) => asset.role === "cover")
          .map((asset) => (
            <button
              key={asset.id}
              type="button"
              className="mt-2 inline-flex w-fit items-center gap-2 text-sm text-cyan-700 hover:underline dark:text-cyan-300"
              onClick={() => void window.app.knowledge.openAsset(asset.id)}
            >
              <FileText className="h-4 w-4" aria-hidden="true" />
              {asset.originalFileName}
            </button>
          ))}
      </CollapsibleSection>
    </div>
  );
}

/**
 * The state of the History tab: the earlier document being read and whether its load is under way
 * or failed. It lives in the page, not in the tab, so it survives a switch of tabs.
 */
export function useSourceHistory(sourceItemId: string) {
  const [historical, setHistorical] = useState<{ title: string; markdown: string } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  function open(documentId: string) {
    setLoading(true);
    setError(false);
    window.app.knowledge
      .getSourceDocument({ sourceItemId, documentId })
      .then(setHistorical)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }
  return { historical, error, loading, open };
}

/** The earlier versions of a source's content (read-only) and its earlier generated summaries. */
export function SourceHistory({
  detail,
  history,
  t
}: {
  detail: SourceDetail;
  history: ReturnType<typeof useSourceHistory>;
  t: Translator;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-sm text-slate-500">{t("sourcePage.historyHint")}</p>
      <ol className="grid gap-2">
        {detail.history.map((item) => (
          <li key={item.id}>
            <Button disabled={history.loading} onClick={() => history.open(item.id)}>
              {item.title} · {new Date(item.createdAt).toLocaleString()}
              {item.isCurrent ? ` · ${t("sourcePage.current")}` : ""}
            </Button>
          </li>
        ))}
      </ol>
      {history.loading ? <p>{t("shell.states.loading")}</p> : null}
      {history.error ? <p role="alert">{t("library.error")}</p> : null}
      {history.historical ? (
        <div className="max-h-[60vh] overflow-auto rounded-xl border border-slate-200 p-5 dark:border-slate-800">
          <MarkdownPreview
            markdown={history.historical.markdown}
            emptyLabel={t("markdown.emptyPreview")}
          />
        </div>
      ) : null}
      {detail.summaries.map((summary) => (
        <details
          key={summary.id}
          className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"
        >
          <summary className="cursor-pointer text-sm">
            {t("library.sections.summary")} · {new Date(summary.generatedAt).toLocaleString()} ·{" "}
            {summary.model}
          </summary>
          <p className="mt-3 whitespace-pre-wrap text-sm">{summary.summary}</p>
        </details>
      ))}
    </div>
  );
}
