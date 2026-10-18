import { useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import type { NotePageRelation } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { relationTypeView, stanceTextClass } from "../../lib/relation-stance";
import { StanceGlyph } from "../glyphs";
import { Button } from "../ui/button";
import { NoteRefText } from "./NoteRefText";
import {
  interpolateNodes,
  relationSentence,
  type CardContent,
  type ExplanationState
} from "./note-page-model";

export type { ExplanationState } from "./note-page-model";

function scrollContainerBottom(element: HTMLElement): number {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll")
      return parent.getBoundingClientRect().bottom;
  }
  return window.innerHeight;
}

/**
 * The evidence of a relation, shown beside its row on hover or focus: what the relation says, the
 * two passages, the explanation (written once the card stayed open, if none is stored, and shown as
 * it is written) and who decided. When the writer finds the notes unrelated the card says so and
 * that the relation is hidden.
 * It is non-modal (a group, never a dialog), holds no focus of its own and never answers Cmd-W.
 */
export function RelationEvidenceCard({
  t,
  thisId,
  relation,
  content,
  explanation,
  onRetryExplanation
}: {
  t: Translator;
  thisId: string;
  relation: NotePageRelation;
  content: CardContent;
  /**
   * Set while an explanation is written, after it failed or when there is none to write; absent
   * before the card asked for one (the dwell) and once one is shown.
   */
  explanation: ExplanationState | null;
  onRetryExplanation: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);
  useLayoutEffect(() => {
    const card = ref.current;
    const row = card?.parentElement;
    if (!card || !row) return;
    setAbove(row.getBoundingClientRect().bottom + card.offsetHeight > scrollContainerBottom(row));
  }, []);
  const view = relationTypeView(relation.type);
  const word = t(view.wordKey);
  const sentence = relationSentence(relation);
  const strong = (text: string) => <strong className="font-semibold">{text}</strong>;
  const other = strong(
    t("notePage.card.quoted", { values: { text: relation.other.ideaStatement } })
  );
  const subject = sentence.subject === "this" ? strong(t("notePage.card.thisNoteSubject")) : other;
  const object = sentence.object === "this" ? strong(t("notePage.card.thisNoteObject")) : other;
  const passages = [
    content.thisPassage ? { key: "this", ...content.thisPassage } : null,
    content.otherPassage
      ? {
          key: "other",
          sourceTitle: content.otherPassage.sourceTitle,
          chunkIndex: content.otherPassage.chunkIndex,
          excerpt: content.otherPassage.excerpt,
          language: content.otherPassage.language
        }
      : null
  ].filter((passage) => passage !== null);
  const writing = !content.explanation && explanation?.status === "writing";
  const streaming = !content.explanation && explanation?.status === "streaming";
  return (
    <div
      ref={ref}
      role="group"
      aria-label={t("notePage.card.label", { values: { type: word } })}
      className={cn(
        "absolute right-0 left-26 z-10 flex max-w-120 flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-lg motion-scale-in",
        above ? "bottom-[calc(100%-0.5rem)]" : "top-[calc(100%-0.5rem)]"
      )}
    >
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 text-xs font-semibold",
            stanceTextClass[view.stance]
          )}
        >
          <StanceGlyph stance={view.stance} size={16} />
          {word}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("notePage.card.betweenNotes")}
          {sentence.directionConfirmed ? ` · ${t("notePage.card.directionConfirmed")}` : null}
        </span>
      </p>
      <p className="text-sm">
        {interpolateNodes(t(sentence.key), {
          subject,
          object,
          verb: t(sentence.verbKey),
          word: t(sentence.wordKey)
        })}
      </p>
      {passages.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(200px,100%),1fr))] gap-2">
          {passages.map((passage) => (
            <div key={passage.key} className="flex flex-col gap-1 rounded-md bg-soft px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {passage.chunkIndex === null
                  ? passage.sourceTitle
                  : t("notePage.card.passageLabel", {
                      values: { source: passage.sourceTitle, number: passage.chunkIndex + 1 }
                    })}
              </span>
              <p
                lang={passage.language ?? undefined}
                className="font-reading text-base line-clamp-4"
              >
                {passage.excerpt}
              </p>
            </div>
          ))}
        </div>
      ) : null}
      {content.explanation ? (
        <div className="flex flex-col gap-1">
          <p className="font-reading text-base text-secondary-foreground">
            <NoteRefText
              text={content.explanation.text}
              thisId={thisId}
              other={relation.other}
              t={t}
            />
          </p>
          {content.explanation.writtenBy ? (
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Sparkles className="size-3" aria-hidden="true" />
              <span>
                {interpolateNodes(t("notePage.card.explainedBy"), {
                  model: (
                    <strong className="font-semibold text-secondary-foreground">
                      {content.explanation.writtenBy}
                    </strong>
                  )
                })}
              </span>
            </p>
          ) : null}
        </div>
      ) : writing ? (
        <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
          {t("notePage.card.writing")}
        </p>
      ) : streaming ? (
        // The text so far is a preview the validated text replaces: it is not announced piece by
        // piece, only marked busy.
        <p aria-busy="true" className="font-reading text-base text-secondary-foreground">
          <NoteRefText text={explanation.text} thisId={thisId} other={relation.other} t={t} />
        </p>
      ) : explanation?.status === "vetoed" ? (
        <p role="status" className="text-sm text-foreground">
          {t("notePage.card.unrelated")}
        </p>
      ) : explanation?.status === "unavailable" ? (
        <p className="text-sm text-muted-foreground">{t("notePage.card.explainUnavailable")}</p>
      ) : explanation?.status === "failed" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">
            {t(
              explanation.kind === "noModel"
                ? "notePage.card.explainNoModel"
                : "notePage.card.explainFailed"
            )}
          </p>
          <Button type="button" onClick={onRetryExplanation}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {content.decidedBy ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border pt-2 text-xs">
          <dt className="text-muted-foreground">{t("notePage.card.decided")}</dt>
          <dd className="min-w-0 truncate">{content.decidedBy}</dd>
        </dl>
      ) : null}
    </div>
  );
}
