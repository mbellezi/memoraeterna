import { useEffect, type ReactNode } from "react";
import { ExternalLink, FileText, Pencil } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import type { SourceDetail } from "../../../../shared/ipc";
import { StanceGlyph } from "../../../components/glyphs";
import { MarkdownPreview } from "../../../components/MarkdownEditor";
import { SourceRelationsList } from "../../../components/SourceRelationsList";
import { Button } from "../../../components/ui/button";
import { TagBadges } from "../../../components/ui/tag-input";
import { cn } from "../../../lib/cn";
import type { resolvePassage } from "../../../lib/object-navigation";
import { relationPairArrow, relationTypeView, stanceTextClass } from "../../../lib/relation-stance";
import { useSourceHistory } from "./source-details";
import { metadataEntries, relationConfidenceLabel, relationTypeKey } from "./source-parts";

/**
 * The bodies of the Source panel's Connections, Content and Details tabs. They are the parts the
 * old Source page had, redrawn on the tokens: no graph (the Map owns it, D19), the cited passage
 * marked in the text, and "Editar" going to the import panel (D32).
 */

export const sectionHeading = "m-0 mb-2 text-sm font-semibold text-foreground";

export function Section({
  title,
  hint,
  children
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8 min-w-0">
      <h3 className={sectionHeading}>{title}</h3>
      {hint ? (
        <p className="m-0 mb-3 text-xs leading-5 text-secondary-foreground [text-wrap:pretty]">
          {hint}
        </p>
      ) : null}
      {children}
    </section>
  );
}

/** A plain line for a part with nothing in it: what it is and when it fills, never a blank. */
export function Quiet({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 max-w-(--measure) text-sm text-secondary-foreground [text-wrap:pretty]">
      {children}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Connections

export function ConnectionsTab({
  t,
  detail,
  relationId,
  onOpen,
  relationsEpoch
}: {
  t: Translator;
  detail: SourceDetail;
  relationId: string | undefined;
  onOpen: (address: string) => void;
  /** Moves when promoted source relations may have appeared; the list reads again in place. */
  relationsEpoch: number;
}) {
  return (
    <>
      <Section title={t("sourcePage.connections.notes")}>
        {detail.relations.length === 0 ? (
          <Quiet>{t("sourcePage.connections.notesEmpty")}</Quiet>
        ) : (
          <ol className="m-0 list-none p-0">
            {detail.relations.map((relation) => {
              const view = relationTypeView(relation.relationType);
              const explanation = relation.explanation.startsWith("knowledge.")
                ? t(relation.explanation as MessageKey)
                : relation.explanation;
              return (
                <li key={relation.id} className="border-t border-border py-3 first:border-t-0">
                  <p className="m-0 text-sm leading-5 font-medium text-foreground [text-wrap:pretty]">
                    <button
                      type="button"
                      data-quick-look={`memora://note/${relation.sourceAtomicNoteId}`}
                      onClick={() => onOpen(`memora://note/${relation.sourceAtomicNoteId}`)}
                      className="rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {relation.sourceTitle}
                    </button>{" "}
                    <span aria-hidden="true" className="text-muted-foreground">
                      {relationPairArrow(relation.direction)}
                    </span>{" "}
                    <button
                      type="button"
                      data-quick-look={`memora://note/${relation.targetAtomicNoteId}`}
                      onClick={() => onOpen(`memora://note/${relation.targetAtomicNoteId}`)}
                      className="rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {relation.targetTitle}
                    </button>
                  </p>
                  <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 text-xs leading-5 text-secondary-foreground">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5",
                        stanceTextClass[view.stance]
                      )}
                    >
                      <StanceGlyph stance={view.stance} size={14} />
                      <span className="font-medium">
                        {t(relationTypeKey(relation.relationType))}
                      </span>
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{relationConfidenceLabel(relation, t)}</span>
                  </p>
                  {explanation ? (
                    <p className="m-0 mt-1 max-w-(--measure) text-xs leading-5 text-secondary-foreground [text-wrap:pretty]">
                      {explanation}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </Section>
      <Section title={t("sourcePage.connections.sources")}>
        <SourceRelationsList
          sourceItemId={detail.id}
          {...(relationId ? { relationId } : {})}
          refreshToken={relationsEpoch}
          t={t}
          onOpenNote={(_sourceItemId, noteId) => onOpen(`memora://note/${noteId}`)}
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Content

/** The cited passage is scrolled to and focused once the reader is drawn (never animated under reduced motion). */
function useScrollToCitation(chunkId: string | null, token: string) {
  useEffect(() => {
    if (!chunkId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const target =
        document.getElementById("cited-passage") ??
        document.getElementById(`passage-chunk-${chunkId}`);
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      target?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [chunkId, token]);
}

export function ContentTab({
  t,
  detail,
  cited,
  asked
}: {
  t: Translator;
  detail: SourceDetail;
  /** What the address's passage resolved to; null when it named none. */
  cited: ReturnType<typeof resolvePassage> | null;
  /** The address named a passage (found or not). */
  asked: string | null;
}) {
  const chunkId = cited?.status === "found" ? cited.chunkId : null;
  useScrollToCitation(chunkId, asked ?? "");
  const originals = detail.assets.filter((asset) => asset.role !== "cover");
  return (
    <>
      {cited?.status === "found" ? (
        <p
          role="status"
          className="m-0 mb-5 flex flex-wrap items-baseline gap-x-2 rounded-lg bg-surface-selected px-3 py-2 text-sm text-foreground"
        >
          {t("objects.citation.showing")}
          <span className="text-secondary-foreground">
            {t("library.chunk", { values: { index: cited.chunkIndex + 1 } })}
            {cited.page ? ` · ${t("sourcePage.notes.page", { values: { page: cited.page } })}` : ""}
          </span>
        </p>
      ) : cited?.status === "missing" ? (
        <p
          role="status"
          className="m-0 mb-5 rounded-lg bg-soft px-3 py-2 text-sm text-secondary-foreground [text-wrap:pretty]"
        >
          {t("objects.citation.unavailable")}
        </p>
      ) : null}
      {detail.documents.length === 0 ? <Quiet>{t("sourcePage.reader.empty")}</Quiet> : null}
      {detail.documents.map((document) => {
        const range =
          cited?.status === "found" && cited.documentId === document.id ? cited.range : null;
        return (
          <div key={document.id} className="mb-8 min-w-0 max-w-(--measure)">
            <div className="font-reading text-reading text-foreground [text-wrap:pretty]">
              <MarkdownPreview
                markdown={document.canonicalMarkdown}
                emptyLabel={t("markdown.emptyPreview")}
                highlight={range ? { ...range, id: "cited-passage" } : undefined}
              />
            </div>
            {document.chunks.length > 0 ? (
              <details
                className="mt-6 rounded-lg border border-border"
                open={cited?.status === "found" && range === null}
              >
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent">
                  {t("sourcePage.reader.passages", { values: { count: document.chunks.length } })}
                </summary>
                <ol className="m-0 grid list-none gap-2 p-3">
                  {document.chunks.map((chunk) => (
                    <li
                      key={chunk.id}
                      id={`passage-chunk-${chunk.id}`}
                      tabIndex={-1}
                      aria-current={chunk.id === chunkId ? "true" : undefined}
                      className={cn(
                        "scroll-my-6 rounded-md border p-3 text-sm outline-none",
                        chunk.id === chunkId ? "border-accent bg-surface-selected" : "border-border"
                      )}
                    >
                      <p className="m-0 mb-1 text-xs text-muted-foreground">
                        {t("library.chunk", { values: { index: chunk.chunkIndex + 1 } })}
                        {chunk.page
                          ? ` · ${t("sourcePage.notes.page", { values: { page: chunk.page } })}`
                          : ""}
                        {chunk.id === chunkId ? ` · ${t("objects.citation.cited")}` : ""}
                      </p>
                      <p className="m-0 font-reading whitespace-pre-wrap">{chunk.content}</p>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            {document.assets.length > 0 ? (
              <ul className="m-0 mt-4 grid list-none gap-1 p-0">
                {document.assets.map((asset) => (
                  <li key={asset.id}>
                    <FileButton
                      name={asset.originalFileName}
                      openLabel={t("library.openFile")}
                      id={asset.id}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
      {originals.length > 0 &&
      detail.documents.every((document) => document.assets.length === 0) ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {originals.map((asset) => (
            <li key={asset.id}>
              <FileButton
                name={asset.originalFileName}
                openLabel={t("library.openFile")}
                id={asset.id}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** A stored file, opened by the main process: the renderer holds an id, never a path. */
function FileButton({ name, openLabel, id }: { name: string; openLabel: string; id: string }) {
  return (
    <button
      type="button"
      onClick={() => void window.app.knowledge.openAsset(id)}
      className="inline-flex max-w-full items-center gap-2 rounded-sm text-sm text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <FileText aria-hidden="true" className="size-4 flex-none" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
      <span className="sr-only">{openLabel}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Details

export function DetailsTab({
  t,
  detail,
  onEdit
}: {
  t: Translator;
  detail: SourceDetail;
  onEdit: () => void;
}) {
  const history = useSourceHistory(detail.id);
  const entries = metadataEntries(detail.metadata);
  const originals = detail.assets.filter((asset) => asset.role !== "cover");
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="secondary" onClick={onEdit}>
          <Pencil aria-hidden="true" />
          {t("sourcePage.edit")}
        </Button>
        {detail.sourceUri ? (
          <a
            href={detail.sourceUri}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-sm text-sm text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <ExternalLink aria-hidden="true" className="size-3.5" />
            {t("library.openOriginal")}
          </a>
        ) : null}
      </div>
      <div className="mb-8 min-w-0">
        <dl className="m-0 grid max-w-(--measure) gap-x-6 gap-y-3 sm:grid-cols-2">
          {entries.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">
                {t(`sourcePage.fields.${key}` as MessageKey)}
              </dt>
              <dd className="m-0 mt-0.5 text-sm text-foreground [overflow-wrap:anywhere] whitespace-pre-wrap">
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
          {entries.some(([key]) => key === "language") ? null : (
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{t("sourcePage.fields.language")}</dt>
              <dd className="m-0 mt-0.5 text-sm text-foreground">{detail.language}</dd>
            </div>
          )}
        </dl>
      </div>
      {originals.length > 0 ? (
        <Section title={t("library.sections.originals")}>
          <ul className="m-0 grid list-none gap-1 p-0">
            {originals.map((asset) => (
              <li key={asset.id}>
                <FileButton
                  name={asset.originalFileName}
                  openLabel={t("library.openFile")}
                  id={asset.id}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {detail.history.length > 1 ? (
        <Section title={t("sourcePage.details.earlier")} hint={t("sourcePage.historyHint")}>
          <ol className="m-0 grid list-none justify-items-start gap-1 p-0">
            {detail.history.map((item) => (
              <li key={item.id}>
                <Button
                  variant="ghost"
                  disabled={history.loading}
                  onClick={() => history.open(item.id)}
                >
                  {new Date(item.createdAt).toLocaleString(t.locale)}
                  {item.isCurrent ? ` · ${t("sourcePage.current")}` : ""}
                </Button>
              </li>
            ))}
          </ol>
          {history.error ? (
            <p role="alert" className="m-0 mt-2 text-xs text-secondary-foreground">
              {t("sourcePage.errors.earlier")}
            </p>
          ) : null}
          {history.historical ? (
            <div className="mt-3 max-h-96 max-w-(--measure) overflow-auto rounded-lg border border-border p-4 font-reading text-sm">
              <MarkdownPreview
                markdown={history.historical.markdown}
                emptyLabel={t("markdown.emptyPreview")}
              />
            </div>
          ) : null}
        </Section>
      ) : null}
      <details className="mb-8 max-w-(--measure)">
        <summary className="cursor-pointer text-sm font-medium text-secondary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {t("library.detail.rawMetadata")}
        </summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-soft p-3 text-xs whitespace-pre-wrap text-secondary-foreground">
          {JSON.stringify(detail.metadata, null, 2)}
        </pre>
      </details>
    </>
  );
}
