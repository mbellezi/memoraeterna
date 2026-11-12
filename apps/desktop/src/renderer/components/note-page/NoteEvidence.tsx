import { useId, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { NotePage, NotePageEvidence } from "@app/domain";
import type { Translator } from "@app/i18n";

import { citationTarget, type PassageAnchor } from "../../lib/object-navigation";
import { ObjectKindGlyph } from "../glyphs";
import { evidenceLinkState, evidenceLocator } from "./note-page-model";
import { useClampOverflow } from "./use-clamp-overflow";

const linkClass = "inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline";
const tagClass = "rounded-full bg-soft px-2 text-xs text-muted-foreground";

function EvidenceFigure({
  t,
  item,
  number,
  quiet,
  onOpenPassage
}: {
  t: Translator;
  item: NotePageEvidence;
  /** Its place in the list, for the quiet form's numeral. */
  number: number;
  /** The panel's form (design record 6.3): a numbered italic quote and its source, no box. */
  quiet: boolean;
  onOpenPassage: (sourceItemId: string, passage: PassageAnchor) => void;
}) {
  const quote = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const overflows = useClampOverflow(quote, !expanded);
  const quoteId = useId();
  const state = evidenceLinkState(item);
  const locator = evidenceLocator(item, t);
  const open = () => {
    const target = citationTarget({
      sourceItemId: item.sourceItemId,
      chunkId: item.chunkId,
      sourceSpanId: item.sourceSpanId,
      documentId: item.documentId
    });
    onOpenPassage(target.sourceItemId, target.passage);
  };
  if (quiet)
    return (
      <figure className="m-0 grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        <span aria-hidden="true" className="pt-0.5 text-xs text-muted-foreground tabular-nums">
          {number}
        </span>
        <blockquote
          id={quoteId}
          lang={item.language ?? undefined}
          className="m-0 font-reading text-sm leading-6 text-foreground italic"
        >
          <div ref={quote} className={`whitespace-pre-line ${expanded ? "" : "line-clamp-6"}`}>
            {item.excerpt}
          </div>
        </blockquote>
        <figcaption className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <ObjectKindGlyph kind="source" size={12} className="text-object-source" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {item.workTitle ?? item.sourceTitle}
            {locator ? ` · ${locator}` : ""}
          </span>
          {state === "open" ? (
            <button type="button" className={linkClass} onClick={open}>
              <ExternalLink className="size-3" aria-hidden="true" />
              {t("notePage.evidence.open")}
            </button>
          ) : (
            <span className={tagClass}>
              {t(
                state === "earlierVersion"
                  ? "notePage.evidence.earlierVersion"
                  : "notePage.evidence.preserved"
              )}
            </span>
          )}
          {overflows || expanded ? (
            <button
              type="button"
              className={linkClass}
              aria-expanded={expanded}
              aria-controls={quoteId}
              onClick={() => setExpanded((current) => !current)}
            >
              {t(expanded ? "notePage.evidence.showLess" : "notePage.evidence.showMore")}
            </button>
          ) : null}
        </figcaption>
      </figure>
    );
  return (
    <figure className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3">
      <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <ObjectKindGlyph kind="source" className="text-object-source" />
        <span className="text-sm font-medium">{item.workTitle ?? item.sourceTitle}</span>
        {locator ? <span className="text-xs text-muted-foreground">{locator}</span> : null}
        <span className="flex-1" />
        {state === "open" ? (
          <button
            type="button"
            className={linkClass}
            onClick={() => {
              const target = citationTarget({
                sourceItemId: item.sourceItemId,
                chunkId: item.chunkId,
                sourceSpanId: item.sourceSpanId,
                documentId: item.documentId
              });
              onOpenPassage(target.sourceItemId, target.passage);
            }}
          >
            <ExternalLink className="size-3" aria-hidden="true" />
            {t("notePage.evidence.open")}
          </button>
        ) : (
          <span className={tagClass}>
            {t(
              state === "earlierVersion"
                ? "notePage.evidence.earlierVersion"
                : "notePage.evidence.preserved"
            )}
          </span>
        )}
      </figcaption>
      <blockquote
        id={quoteId}
        lang={item.language ?? undefined}
        className="rounded-md bg-soft px-3 py-2 font-reading text-reading leading-6"
      >
        {/* The clamp sits inside the padding, so no part of a hidden line shows. */}
        <div ref={quote} className={`whitespace-pre-line ${expanded ? "" : "line-clamp-6"}`}>
          {item.excerpt}
        </div>
      </blockquote>
      {overflows || expanded ? (
        <button
          type="button"
          className={`${linkClass} self-start`}
          aria-expanded={expanded}
          aria-controls={quoteId}
          onClick={() => setExpanded((current) => !current)}
        >
          {t(expanded ? "notePage.evidence.showLess" : "notePage.evidence.showMore")}
        </button>
      ) : null}
    </figure>
  );
}

/** The passages that support the note, with their exact place; hidden when there are none. */
export function NoteEvidence({
  t,
  evidence,
  quiet = false,
  onOpenPassage
}: {
  t: Translator;
  evidence: NotePage["evidence"];
  /** The panel's form: numbered quotes in a margin or under the prose, no boxes. */
  quiet?: boolean;
  onOpenPassage: (sourceItemId: string, passage: PassageAnchor) => void;
}) {
  const headingId = useId();
  if (evidence.total === 0) return null;
  const hidden = evidence.total - evidence.items.length;
  return (
    <section
      aria-labelledby={headingId}
      className={quiet ? "flex flex-col gap-4" : "flex flex-col gap-3"}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id={headingId} className={quiet ? "text-sm font-semibold" : "text-lg font-semibold"}>
          {t("notePage.evidence.title")}
        </h2>
        <span className="text-sm text-muted-foreground tabular-nums">{evidence.total}</span>
        <span className="text-xs text-muted-foreground">{t("notePage.evidence.hint")}</span>
      </div>
      {evidence.items.map((item, index) => (
        <EvidenceFigure
          key={item.chunkId}
          t={t}
          item={item}
          number={index + 1}
          quiet={quiet}
          onOpenPassage={onOpenPassage}
        />
      ))}
      {hidden > 0 ? (
        <p className="text-xs text-muted-foreground">
          {hidden === 1
            ? t("notePage.evidence.moreOne")
            : t("notePage.evidence.more", { values: { count: hidden } })}
        </p>
      ) : null}
    </section>
  );
}
