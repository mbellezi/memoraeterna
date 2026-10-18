import { Fragment, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";
import type { NotePageRelation } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { relationTypeView, stanceTextClass } from "../../lib/relation-stance";
import { StanceGlyph } from "../glyphs";
import { Button } from "../ui/button";
import { NoteRefText } from "./NoteRefText";
import {
  bandWordKey,
  interpolateNodes,
  offersReview,
  relationSentence,
  type CardContent,
  type ExplanationState,
  type ProvenanceLine,
  type ReviewState
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

const roleKeys: Record<ProvenanceLine["role"], MessageKey> = {
  decided: "notePage.card.decided",
  typed: "notePage.card.typed",
  explained: "notePage.card.explained"
};

/** What the card says about the relation's state apart from the explanation (D42). */
function stateNoteKey(
  relation: Pick<NotePageRelation, "state" | "vetoSource">,
  explanation: ExplanationState | null
): MessageKey | null {
  // The writer's verdict a moment ago has its own live message.
  if (explanation?.status === "vetoed") return null;
  if (relation.state === "suggested") return "notePage.card.suggestedHint";
  if (relation.state === "kept") return "notePage.card.keptNote";
  if (relation.state === "withdrawn")
    return relation.vetoSource === "typer"
      ? "notePage.card.withdrawnTyper"
      : "notePage.card.withdrawnExplainer";
  return null;
}

/**
 * The evidence of a relation, shown beside its row on hover or focus: what the relation says, how
 * confident the matcher was (a word, never a percentage), the two passages, the explanation
 * (written once the card stayed open, if none is stored, and shown as it is written) and who
 * decided, typed and explained it. When the writer finds the notes unrelated the card says so and
 * that the relation is hidden. A suggested or withdrawn relation offers Keep and Remove (F3 D15).
 * It is non-modal (a group, never a dialog), holds no focus of its own and never answers Cmd-W.
 */
export function RelationEvidenceCard({
  t,
  thisId,
  relation,
  content,
  explanation,
  review,
  onRetryExplanation,
  onReview
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
  /** The owner's verdict being saved, or that could not be saved. */
  review: ReviewState | null;
  onRetryExplanation: () => void;
  onReview: (verdict: "keep" | "remove") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scopeId = useId();
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
  const bandKey = bandWordKey(relation);
  const stateNote = stateNoteKey(relation, explanation);
  const reviewing = review?.status === "pending";
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
        {bandKey ? (
          <span className="text-xs text-muted-foreground">
            {" · "}
            {interpolateNodes(t("notePage.card.confidence"), {
              word: (
                <strong className="font-semibold text-secondary-foreground">{t(bandKey)}</strong>
              )
            })}
          </span>
        ) : null}
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
        <p className="font-reading text-base text-secondary-foreground">
          <NoteRefText
            text={content.explanation.text}
            thisId={thisId}
            other={relation.other}
            t={t}
          />
        </p>
      ) : writing ? (
        // Each state has a node of its own: a status region that is added with its text is
        // announced, one whose role comes and goes on a reused node is not.
        <p key="writing" role="status" aria-busy="true" className="text-sm text-muted-foreground">
          {t("notePage.card.writing")}
        </p>
      ) : streaming ? (
        // The text so far is a preview the validated text replaces: it is not announced piece by
        // piece, only marked busy.
        <p
          key="streaming"
          aria-busy="true"
          className="font-reading text-base text-secondary-foreground"
        >
          <NoteRefText text={explanation.text} thisId={thisId} other={relation.other} t={t} />
        </p>
      ) : explanation?.status === "vetoed" ? (
        <p key="vetoed" role="status" className="text-sm text-foreground">
          {t("notePage.card.unrelated")}
        </p>
      ) : explanation?.status === "unexplained" ? (
        // Neutral: the owner decided this relation (or it cannot be withdrawn), so the writer's
        // disagreement withdraws nothing.
        <p key="unexplained" className="text-sm text-muted-foreground">
          {t("notePage.card.unexplained")}
        </p>
      ) : explanation?.status === "unavailable" ? (
        <p key="unavailable" className="text-sm text-muted-foreground">
          {t("notePage.card.explainUnavailable")}
        </p>
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
      {stateNote ? <p className="text-sm text-muted-foreground">{t(stateNote)}</p> : null}
      {offersReview(relation, explanation) ? (
        <div className="flex flex-col gap-2" aria-busy={reviewing || undefined}>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={reviewing}
              aria-describedby={scopeId}
              onClick={() => onReview("keep")}
            >
              <Check aria-hidden="true" />
              {t("notePage.card.keep")}
            </Button>
            <Button
              type="button"
              disabled={reviewing}
              aria-describedby={scopeId}
              onClick={() => onReview("remove")}
            >
              <X aria-hidden="true" />
              {t("notePage.card.remove")}
            </Button>
          </div>
          <p id={scopeId} className="text-xs text-muted-foreground">
            {t("notePage.card.reviewScope")}
          </p>
          {review?.status === "failed" ? (
            <p role="alert" className="text-sm text-foreground">
              {t("notePage.card.reviewFailed")}
            </p>
          ) : null}
        </div>
      ) : null}
      {content.provenance.length > 0 ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border pt-2 text-xs">
          {content.provenance.map((line) => (
            <Fragment key={line.role}>
              <dt className="text-muted-foreground">{t(roleKeys[line.role])}</dt>
              <dd className="min-w-0 truncate" title={line.actor.model}>
                {line.actor.model}
                {line.actor.kind ? (
                  <span className="text-muted-foreground">
                    {" · "}
                    {t(
                      line.actor.kind === "local"
                        ? "notePage.card.kindLocal"
                        : "notePage.card.kindRemote"
                    )}
                  </span>
                ) : null}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
