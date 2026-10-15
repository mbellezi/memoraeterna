import { useId, type FocusEvent, type KeyboardEvent } from "react";
import { Check, RefreshCw, Sparkles } from "lucide-react";
import type { NotePageEvidence, NotePageRelation, NotePageRelations } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { ObjectKindGlyph } from "../glyphs";
import { RelationStanceLabel } from "../RelationStanceLabel";
import { Button } from "../ui/button";
import { RelationEvidenceCard, type ExplanationState } from "./RelationEvidenceCard";
import { cardContent, interpolateNodes } from "./note-page-model";
import type { CardEvent } from "./relation-card-state";

const pill =
  "inline-flex h-5 items-center rounded-full border border-border px-2 text-xs font-medium text-secondary-foreground";

export interface RelationsMore {
  status: "idle" | "loading" | "error";
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
  onCardEvent,
  onOpenNote,
  onRetryExplanation
}: {
  t: Translator;
  thisId: string;
  thisPrimary: NotePageEvidence | null;
  relation: NotePageRelation;
  open: boolean;
  explanation: ExplanationState | null;
  onCardEvent: (event: CardEvent) => void;
  onOpenNote: (noteId: string) => void;
  onRetryExplanation: (relationId: string) => void;
}) {
  const { other } = relation;
  const id = relation.id;
  const leaves = (event: FocusEvent<HTMLLIElement>) =>
    !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget));
  return (
    <li
      className="relative"
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
        onCardEvent({ type: "escape" });
      }}
    >
      <button
        type="button"
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
            {relation.decidedBy ? (
              <span className="inline-flex items-center gap-1">
                <Check className="size-3" aria-hidden="true" />
                <MetaName t={t} label="notePage.relations.decided" name={relation.decidedBy} />
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
          onRetryExplanation={() => onRetryExplanation(id)}
        />
      ) : null}
    </li>
  );
}

/** The note's relations to other notes, each with its evidence card, and further pages. */
export function NoteRelations({
  t,
  thisId,
  thisPrimary,
  relations,
  openCard,
  explanations,
  more,
  onCardEvent,
  onOpenNote,
  onRetryExplanation,
  onShowMore
}: {
  t: Translator;
  thisId: string;
  thisPrimary: NotePageEvidence | null;
  relations: NotePageRelations;
  openCard: string | null;
  explanations: Readonly<Record<string, ExplanationState>>;
  more: RelationsMore;
  onCardEvent: (event: CardEvent) => void;
  onOpenNote: (noteId: string) => void;
  onRetryExplanation: (relationId: string) => void;
  onShowMore: () => void;
}) {
  const headingId = useId();
  const remaining = relations.total - relations.items.length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 id={headingId} className="text-lg font-semibold">
          {t("notePage.relations.title")}
        </h2>
        {relations.total > 0 ? (
          <span className="text-sm text-muted-foreground tabular-nums">{relations.total}</span>
        ) : null}
        {relations.items.length > 0 ? (
          <span className="text-xs text-muted-foreground">{t("notePage.relations.hint")}</span>
        ) : null}
      </div>
      {relations.total === 0 ? (
        <p className="text-sm text-muted-foreground">{t("notePage.relations.empty")}</p>
      ) : (
        <ul className="-mx-3">
          {relations.items.map((relation) => (
            <RelationRow
              key={relation.id}
              t={t}
              thisId={thisId}
              thisPrimary={thisPrimary}
              relation={relation}
              open={openCard === relation.id}
              explanation={explanations[relation.id] ?? null}
              onCardEvent={onCardEvent}
              onOpenNote={onOpenNote}
              onRetryExplanation={onRetryExplanation}
            />
          ))}
        </ul>
      )}
      {remaining > 0 ? (
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
      ) : null}
    </section>
  );
}
