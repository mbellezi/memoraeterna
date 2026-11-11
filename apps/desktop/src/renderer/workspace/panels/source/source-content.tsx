import { FileText, Pencil, Quote } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { SourceDetail } from "../../../../shared/ipc";
import { Button } from "../../../components/ui/button";
import { MarkdownPreview } from "../../../components/MarkdownEditor";
import { cn } from "../../../lib/cn";
import type { resolvePassage } from "../../../lib/object-navigation";
import { CollapsibleSection, StateCard } from "./source-parts";

/** The reader of a source: its documents, originals and chunks, with a cited passage marked. */
export function SourceContent({
  detail,
  cited,
  citedChunkId,
  passageCited,
  passageSignal,
  t,
  onEdit,
  onShowHistory
}: {
  detail: SourceDetail;
  /** What the citation resolved to in the current documents; null when none was asked for. */
  cited: ReturnType<typeof resolvePassage> | null;
  citedChunkId: string | null;
  /** A passage was asked for (found or not). */
  passageCited: boolean;
  passageSignal: number;
  t: Translator;
  onEdit: () => void;
  onShowHistory: () => void;
}) {
  return (
    <>
      {detail.documents.length === 0 ? <StateCard>{t("library.containerHint")}</StateCard> : null}

      <Button className="w-fit" type="button" onClick={onEdit}>
        <Pencil className="h-4 w-4" />
        {t("sourcePage.editContent")}
      </Button>

      {detail.assets
        .filter((asset) => asset.role !== "cover")
        .map((asset) => (
          <Button
            className="w-fit"
            key={asset.id}
            onClick={() => void window.app.knowledge.openAsset(asset.id)}
          >
            {asset.originalFileName}
          </Button>
        ))}
      {passageCited ? (
        cited?.status === "found" ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-x-2 rounded-lg border border-border bg-accent-soft px-3 py-2 text-sm text-foreground"
          >
            <Quote className="h-4 w-4 text-accent" aria-hidden="true" />
            {t("objects.citation.showing")}
            <span className="text-muted-foreground">
              {t("library.chunk", { values: { index: cited.chunkIndex + 1 } })}
              {cited.page ? ` · ${t("search.page")} ${cited.page}` : ""}
            </span>
          </p>
        ) : (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-soft px-3 py-2 text-sm text-foreground"
          >
            {t("objects.citation.unavailable")}
            <Button type="button" onClick={onShowHistory}>
              {t("objects.citation.earlierVersions")}
            </Button>
          </div>
        )
      ) : null}
      {detail.documents.map((document) => (
        <div key={document.id} className="grid gap-3">
          <CollapsibleSection
            title={t("library.sections.document")}
            defaultOpen
            openSignal={passageSignal}
          >
            <div className="max-h-[32rem] overflow-auto rounded-xl bg-slate-50 p-5 dark:bg-slate-950">
              <MarkdownPreview
                markdown={document.canonicalMarkdown}
                emptyLabel={t("markdown.emptyPreview")}
                highlight={
                  cited?.status === "found" && cited.documentId === document.id && cited.range
                    ? { ...cited.range, id: "cited-passage" }
                    : undefined
                }
              />
            </div>
            {document.assets.length > 0 ? (
              <div className="mt-3 grid gap-2">
                <h4 className="text-sm font-semibold">{t("library.sections.originals")}</h4>
                <ul className="grid gap-1 text-sm">
                  {document.assets.map((asset) => (
                    <li key={asset.id}>
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 text-cyan-700 hover:underline dark:text-cyan-300"
                        onClick={() => void window.app.knowledge.openAsset(asset.id)}
                      >
                        <FileText className="h-4 w-4" aria-hidden="true" />
                        {asset.originalFileName}
                        <span className="sr-only">{t("library.openFile")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CollapsibleSection>
          <CollapsibleSection
            title={t("library.sections.chunks")}
            count={document.chunks.length}
            openSignal={citedChunkId && cited?.status === "found" ? passageSignal : 0}
          >
            <ol className="grid gap-2">
              {document.chunks.map((chunk) => (
                <li
                  key={chunk.id}
                  id={`passage-chunk-${chunk.id}`}
                  tabIndex={-1}
                  aria-current={chunk.id === citedChunkId ? "true" : undefined}
                  className={cn(
                    "scroll-my-6 rounded-lg border p-3 text-sm outline-none",
                    chunk.id === citedChunkId
                      ? "border-accent bg-accent-soft ring-2 ring-accent"
                      : "border-slate-200 dark:border-slate-800"
                  )}
                >
                  <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    {t("library.chunk", { values: { index: chunk.chunkIndex + 1 } })}
                    {chunk.page ? ` · ${t("search.page")} ${chunk.page}` : ""}
                    {chunk.id === citedChunkId ? (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                        {t("objects.citation.cited")}
                      </span>
                    ) : null}
                  </p>
                  <p className="whitespace-pre-wrap font-reading">{chunk.content}</p>
                </li>
              ))}
            </ol>
          </CollapsibleSection>
        </div>
      ))}
    </>
  );
}
