import { useEffect, useId, useRef, type FocusEvent, type KeyboardEvent } from "react";
import { Check, ChevronDown, ChevronRight, RefreshCw, Sparkles } from "lucide-react";
import type { NotePageEvidence, NotePageRelation, NotePageRelations } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { ObjectKindGlyph } from "../glyphs";
import { RelationStanceLabel } from "../RelationStanceLabel";
import { Button } from "../ui/button";
import { RelationEvidenceCard, type ExplanationState } from "./RelationEvidenceCard";
import {
  bandWordKey,
  cardContent,
  interpolateNodes,
  relationStateKey,
  type RelationGroup,
  type ReviewState
} from "./note-page-model";
import type { CardEvent } from "./relation-card-state";

const pill =
  "inline-flex h-5 items-center rounded-full border border-border px-2 text-xs font-medium text-secondary-foreground";

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export interface RelationsMore {
  status: "idle" | "loading" | "error";
}

/**
 * Where focus goes once a row left its list (a verdict, a relation the writer withdrew): the row
 * that takes its place, else the heading of its group, so focus is never lost to the page.
 */
export interface RelationFocus {
  relationId: string | null;
  group: RelationGroup;
}

function MetaName({ t, label, name }: { t: Translator; label: MessageKey; name: string }) {
  return (
    <span>
      {interpolateNodes(`${t(label)} {name}`, {
        name: <strong className="font-semibold text-secondary-foreground">{name}</strong>
      })}
    </span>
  );
}

function RelationRow({
  t,
  thisId,
  thisPrimary,
  relation,
  open,
  explanation,
  review,
  onCardEvent,
  onOpenNote,
  onRetryExplanation,
  onReview
}: {
  t: Translator;
  thisId: string;
  thisPrimary: NotePageEvidence | null;
  relation: NotePageRelation;
  open: boolean;
  explanation: ExplanationState | null;
  review: ReviewState | null;
  onCardEvent: (event: CardEvent) => void;
  onOpenNote: (noteId: string) => void;
  onRetryExplanation: (relationId: string) => void;
  onReview: (relationId: string, verdict: "keep" | "remove") => void;
}) {
  const { other } = relation;
  const id = relation.id;
  const button = useRef<HTMLButtonElement>(null);
  const leaves = (event: FocusEvent<HTMLLIElement>) =>
    !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget));
  const stateKey = relationStateKey(relation.state);
  // A suggested relation says so; its confidence is in the card. A row with no state chip (an
  // applied one) says its band, so the list always tells how sure the matcher was (D42).
  const bandKey = stateKey ? null : bandWordKey(relation);
  return (
    <li
      className="relative"
      data-relation-id={id}
      onPointerEnter={() => onCardEvent({ type: "pointerEnter", id })}
      onPointerLeave={() => onCardEvent({ type: "pointerLeave", id })}
      onFocus={() => onCardEvent({ type: "focusIn", id })}
      onBlur={(event) => {
        if (leaves(event)) onCardEvent({ type: "focusOut", id });
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        event.stopPropagation();
        // The card closes, and a control inside it goes with it: focus stays on the row.
        if (event.target !== button.current) button.current?.focus();
        onCardEvent({ type: "escape" });
      }}
    >
      <button
        ref={button}
        type="button"
        data-relation-button={id}
        className={cn(
          "flex w-full flex-wrap gap-x-3 gap-y-1 rounded-md p-3 text-left text-foreground hover:bg-surface-hover",
          open && "bg-surface-hover"
        )}
        onClick={() => onOpenNote(other.id)}
      >
        <span className="flex-none basis-26 pt-1">
          <RelationStanceLabel type={relation.type} t={t} />
        </span>
        <span className="flex min-w-0 flex-1 basis-80 flex-col gap-1.5">
          <span className="flex gap-2">
            <ObjectKindGlyph kind="note" className="mt-1.5 text-object-note" />
            <span className="sr-only">{t("objects.kinds.note")}: </span>
            <span
              lang={other.language ?? undefined}
              className="font-reading text-reading leading-6 text-pretty"
            >
              {other.ideaStatement}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="max-w-full truncate">{other.sourceTitle}</span>
            {other.authorship === "edited" ? (
              <span className={pill}>{t("notePage.badge.yours")}</span>
            ) : null}
            {other.superseded ? <span>{t("notePage.relations.superseded")}</span> : null}
            {stateKey ? (
              <span className={cn(pill, relation.state === "suggested" && "border-accent")}>
                {t(stateKey)}
              </span>
            ) : null}
            {bandKey ? (
              <span>
                {interpolateNodes(t("notePage.card.confidence"), {
                  word: (
                    <strong className="font-semibold text-secondary-foreground">
                      {t(bandKey)}
                    </strong>
                  )
                })}
              </span>
            ) : null}
            {relation.decidedBy ? (
              <span className="inline-flex items-center gap-1">
                <Check className="size-3" aria-hidden="true" />
                <MetaName
                  t={t}
                  label="notePage.relations.decided"
                  name={relation.decidedBy.model}
                />
              </span>
            ) : null}
            {relation.explanation?.writtenBy ? (
              <span className="inline-flex items-center gap-1">
                <Sparkles className="size-3" aria-hidden="true" />
                <MetaName
                  t={t}
                  label="notePage.relations.explained"
                  name={relation.explanation.writtenBy}
                />
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {open ? (
        <RelationEvidenceCard
          t={t}
          thisId={thisId}
          relation={relation}
          content={cardContent(relation, thisPrimary)}
          explanation={explanation}
          review={review}
          onRetryExplanation={() => onRetryExplanation(id)}
          onReview={(verdict) => onReview(id, verdict)}
        />
      ) : null}
    </li>
  );
}

interface ListProps {
  t: Translator;
  thisId: string;
  thisPrimary: NotePageEvidence | null;
  openCard: string | null;
  explanations: Readonly<Record<string, ExplanationState>>;
  reviews: Readonly<Record<string, ReviewState>>;
  onCardEvent: (event: CardEvent) => void;
  onOpenNote: (noteId: string) => void;
  onRetryExplanation: (relationId: string) => void;
  onReview: (relationId: string, verdict: "keep" | "remove") => void;
}

function RelationList({
  relations,
  id,
  ...props
}: ListProps & { relations: NotePageRelations; id?: string }) {
  return (
    <ul id={id} className="-mx-3">
      {relations.items.map((relation) => (
        <RelationRow
          key={relation.id}
          t={props.t}
          thisId={props.thisId}
          thisPrimary={props.thisPrimary}
          relation={relation}
          open={props.openCard === relation.id}
          explanation={props.explanations[relation.id] ?? null}
          review={props.reviews[relation.id] ?? null}
          onCardEvent={props.onCardEvent}
          onOpenNote={props.onOpenNote}
          onRetryExplanation={props.onRetryExplanation}
          onReview={props.onReview}
        />
      ))}
    </ul>
  );
}

/** "Show N more" under a list that has more rows than it holds, and a retry when they failed. */
function ShowMore({
  t,
  relations,
  more,
  onShowMore
}: {
  t: Translator;
  relations: NotePageRelations;
  more: RelationsMore;
  onShowMore: () => void;
}) {
  const remaining = relations.total - relations.items.length;
  if (remaining <= 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        disabled={more.status === "loading"}
        aria-busy={more.status === "loading" || undefined}
        onClick={onShowMore}
      >
        {t("notePage.relations.showMore", { values: { count: Math.min(20, remaining) } })}
      </Button>
      {more.status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{t("notePage.relations.moreFailed")}</p>
          <Button type="button" onClick={onShowMore}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The note's relations to other notes, each with its evidence card, and further pages: the shown
 * ones (applied, suggested or kept), the ones an automatic check withdrew (the owner keeps or
 * removes each, F3 D15) and, apart, the ones to an earlier version of a note (R29).
 */
export function NoteRelations({
  t,
  thisId,
  thisPrimary,
  relations,
  withdrawn,
  earlierVersions,
  openCard,
  explanations,
  reviews,
  more,
  withdrawnOpen,
  focusRequest,
  onCardEvent,
  onOpenNote,
  onRetryExplanation,
  onReview,
  onToggleWithdrawn,
  onFocusHandled,
  onShowMore
}: {
  t: Translator;
  thisId: string;
  thisPrimary: NotePageEvidence | null;
  relations: NotePageRelations;
  withdrawn: NotePageRelations;
  earlierVersions: NotePageRelations;
  openCard: string | null;
  explanations: Readonly<Record<string, ExplanationState>>;
  reviews: Readonly<Record<string, ReviewState>>;
  more: Readonly<Record<RelationGroup, RelationsMore>>;
  /** Whether the withdrawn relations are listed (they are behind "Show" until the owner asks). */
  withdrawnOpen: boolean;
  focusRequest: RelationFocus | null;
  onCardEvent: (event: CardEvent) => void;
  onOpenNote: (noteId: string) => void;
  onRetryExplanation: (relationId: string) => void;
  onReview: (relationId: string, verdict: "keep" | "remove") => void;
  onToggleWithdrawn: () => void;
  onFocusHandled: () => void;
  onShowMore: (group: RelationGroup) => void;
}) {
  const headingId = useId();
  const withdrawnId = useId();
  const withdrawnListId = useId();
  const earlierId = useId();
  const section = useRef<HTMLElement>(null);
  const shownHeading = useRef<HTMLHeadingElement>(null);
  const withdrawnHeading = useRef<HTMLHeadingElement>(null);
  const earlierHeading = useRef<HTMLHeadingElement>(null);
  const empty = relations.total === 0 && withdrawn.total === 0 && earlierVersions.total === 0;
  const list: ListProps = {
    t,
    thisId,
    thisPrimary,
    openCard,
    explanations,
    reviews,
    onCardEvent,
    onOpenNote,
    onRetryExplanation,
    onReview
  };

  // Focus goes to the row that took the place of one that left, else to the heading of its group
  // (the main one when that group is gone): a control that unmounts never leaves focus nowhere.
  useEffect(() => {
    if (!focusRequest) return;
    const byGroup = {
      shown: shownHeading.current,
      withdrawn: withdrawnHeading.current,
      earlier: earlierHeading.current
    };
    const row = focusRequest.relationId
      ? section.current?.querySelector<HTMLElement>(
          `[data-relation-button="${CSS.escape(focusRequest.relationId)}"]`
        )
      : null;
    // A row that takes the focus does not open its card: nobody chose it, and its explanation is
    // written for a card that stays open.
    if (row && focusRequest.relationId && focusRequest.relationId !== openCard)
      onCardEvent({ type: "park", id: focusRequest.relationId });
    (row ?? byGroup[focusRequest.group] ?? shownHeading.current)?.focus();
    onFocusHandled();
    // The request is the only thing that runs this: lists and callbacks are read as they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, relations, withdrawn, earlierVersions]);

  return (
    <section ref={section} aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2
          id={headingId}
          ref={shownHeading}
          tabIndex={-1}
          className={cn("text-lg font-semibold", focusRing)}
        >
          {t("notePage.relations.title")}
        </h2>
        {relations.total > 0 ? (
          <span className="text-sm text-muted-foreground tabular-nums">{relations.total}</span>
        ) : null}
        {relations.items.length > 0 ? (
          <span className="text-xs text-muted-foreground">{t("notePage.relations.hint")}</span>
        ) : null}
      </div>
      {empty ? (
        <p className="text-sm text-muted-foreground">{t("notePage.relations.empty")}</p>
      ) : null}
      {relations.items.length > 0 ? <RelationList relations={relations} {...list} /> : null}
      <ShowMore
        t={t}
        relations={relations}
        more={more.shown}
        onShowMore={() => onShowMore("shown")}
      />
      {withdrawn.total > 0 ? (
        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3
              id={withdrawnId}
              ref={withdrawnHeading}
              tabIndex={-1}
              className={cn("text-sm font-semibold", focusRing)}
            >
              {withdrawn.total === 1
                ? t("notePage.relations.withdrawnOne")
                : t("notePage.relations.withdrawn", { values: { count: withdrawn.total } })}
            </h3>
            <Button
              type="button"
              variant="secondary"
              aria-expanded={withdrawnOpen}
              aria-controls={withdrawnListId}
              onClick={onToggleWithdrawn}
            >
              {withdrawnOpen ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )}
              {t(
                withdrawnOpen
                  ? "notePage.relations.hideWithdrawn"
                  : "notePage.relations.showWithdrawn"
              )}
            </Button>
          </div>
          {withdrawnOpen ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t("notePage.relations.withdrawnHint")}
              </p>
              <RelationList relations={withdrawn} id={withdrawnListId} {...list} />
              <ShowMore
                t={t}
                relations={withdrawn}
                more={more.withdrawn}
                onShowMore={() => onShowMore("withdrawn")}
              />
            </>
          ) : null}
        </div>
      ) : null}
      {earlierVersions.total > 0 ? (
        <div
          role="group"
          aria-labelledby={earlierId}
          className="mt-2 flex flex-col gap-2 border-t border-border pt-3"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3
              id={earlierId}
              ref={earlierHeading}
              tabIndex={-1}
              className={cn("text-sm font-semibold", focusRing)}
            >
              {t("notePage.relations.earlierTitle")}
            </h3>
            <span className="text-sm text-muted-foreground tabular-nums">
              {earlierVersions.total}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t("notePage.relations.earlierHint")}</p>
          <RelationList relations={earlierVersions} {...list} />
          <ShowMore
            t={t}
            relations={earlierVersions}
            more={more.earlier}
            onShowMore={() => onShowMore("earlier")}
          />
        </div>
      ) : null}
    </section>
  );
}
