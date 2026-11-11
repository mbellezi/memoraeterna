import { FileText, Globe, Layers, NotebookPen } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { SourceDetail } from "../../../../shared/ipc";
import { CollapsibleSection, StatTile } from "./source-parts";

/** The counts and the summary of a source. */
export function SourceOverview({
  detail,
  chunkCount,
  t
}: {
  detail: SourceDetail;
  chunkCount: number;
  t: Translator;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          icon={FileText}
          label={t("library.detail.stats.documents")}
          value={detail.documents.length}
          tone="cyan"
        />
        <StatTile
          icon={Layers}
          label={t("library.detail.stats.chunks")}
          value={chunkCount}
          tone="emerald"
        />
        <StatTile
          icon={NotebookPen}
          label={t("library.detail.stats.notes")}
          value={detail.atomicNotes.length}
          tone="violet"
        />
        <StatTile
          icon={Globe}
          label={t("library.detail.stats.relations")}
          value={detail.relations.length}
          tone="amber"
        />
      </div>
      <CollapsibleSection title={t("library.sections.summary")} defaultOpen>
        <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">
          {detail.summary ?? t("library.noSummary")}
        </p>
        {detail.metadata.summaryStale === true ? (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-300">{t("sourcePage.stale")}</p>
        ) : null}
      </CollapsibleSection>
    </>
  );
}
