import type { RefObject } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { formatObjectAddress, type NotePage } from "@app/domain";
import type { Translator } from "@app/i18n";

import type { ObjectNavigation, PassageAnchor } from "../../lib/object-navigation";
import { ObjectKindGlyph } from "../glyphs";
import { Button } from "../ui/button";
import { WhereIsThisView } from "../WhereIsThis";
import { NoteBodyText } from "./NoteBodyText";
import { NoteEvidence } from "./NoteEvidence";
import { NoteHeader, type NoteEditing } from "./NoteHeader";
import { NoteRelations, type RelationsMore } from "./NoteRelations";
import type { ExplanationState } from "./RelationEvidenceCard";
import type { NoteDraft } from "./note-page-model";
import type { CardEvent } from "./relation-card-state";

export type NotePageLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; page: NotePage };

export interface NotePageViewProps {
  t: Translator;
  backLabel: string;
  load: NotePageLoad;
  headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
  editRef?: RefObject<HTMLButtonElement | null> | undefined;
  editing: NoteEditing | null;
  review: { pending: boolean; failed: boolean };
  openCard: string | null;
  explanations: Readonly<Record<string, ExplanationState>>;
  more: RelationsMore;
  openFailed: boolean;
  /** Polite announcement of the last action's result. */
  announcement: string;
  onBack: () => void;
  onRetry: () => void;
  onMarkReviewed: () => void;
  onStartEdit: () => void;
  onDraftChange: (draft: NoteDraft) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onDiscardAndReload: () => void;
  onEscapeEdit: () => void;
  onOpenNote: (noteId: string) => void;
  onOpenPassage: (sourceItemId: string, passage: PassageAnchor) => void;
  onOpenPlacement: (navigation: ObjectNavigation) => void;
  onCardEvent: (event: CardEvent) => void;
  onRetryExplanation: (relationId: string) => void;
  onShowMore: () => void;
}

/**
 * The Note page: what the note says, where it comes from, where it is, its evidence and its
 * relations, in one column. Props in, callbacks out: the host decides where it lives (the Library
 * today, a panel later); widths come from the container.
 */
export function NotePageView(props: NotePageViewProps) {
  const { t, load } = props;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button type="button" variant="secondary" onClick={props.onBack}>
          <ArrowLeft aria-hidden="true" />
          {props.backLabel}
        </Button>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-secondary-foreground">
          <ObjectKindGlyph kind="note" className="text-object-note" />
          {t("notePage.kind")}
        </span>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {props.announcement}
      </p>
      {load.status === "loading" ? (
        <div role="status" aria-busy="true" className="flex w-full max-w-190 flex-col gap-4">
          <span className="sr-only">{t("shell.states.loading")}</span>
          <div className="h-8 w-3/4 rounded-md bg-soft" />
          <div className="h-28 rounded-md bg-soft" />
          <div className="h-12 rounded-md bg-soft" />
          <div className="h-12 rounded-md bg-soft" />
        </div>
      ) : null}
      {load.status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{t("notePage.error")}</p>
          <Button type="button" onClick={props.onRetry}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {load.status === "missing" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("notePage.missing")}
        </p>
      ) : null}
      {load.status === "ready" ? <NoteArticle {...props} page={load.page} /> : null}
    </div>
  );
}

function NoteArticle(props: NotePageViewProps & { page: NotePage }) {
  const { t, page } = props;
  const { note } = page;
  const primary = page.evidence.items.find((item) => item.primary) ?? null;
  return (
    <article
      aria-label={t("notePage.articleLabel", { values: { title: note.title } })}
      className="flex w-full max-w-190 flex-col gap-8 pb-12"
    >
      <NoteHeader
        t={t}
        page={page}
        headingRef={props.headingRef}
        editRef={props.editRef}
        editing={props.editing}
        review={props.review}
        onMarkReviewed={props.onMarkReviewed}
        onStartEdit={props.onStartEdit}
        onDraftChange={props.onDraftChange}
        onSave={props.onSave}
        onCancelEdit={props.onCancelEdit}
        onDiscardAndReload={props.onDiscardAndReload}
        onEscapeEdit={props.onEscapeEdit}
        onOpenNote={props.onOpenNote}
      />
      <NoteBodyText t={t} note={note} />
      <WhereIsThisView
        t={t}
        variant="page"
        state={{
          status: "ready",
          address: formatObjectAddress({ kind: "note", id: note.id }),
          result: page.placement
        }}
        openFailed={props.openFailed}
        onOpen={props.onOpenPlacement}
        onRetry={props.onRetry}
      />
      <NoteEvidence t={t} evidence={page.evidence} onOpenPassage={props.onOpenPassage} />
      <NoteRelations
        t={t}
        thisId={note.id}
        thisPrimary={primary}
        relations={page.relations}
        openCard={props.openCard}
        explanations={props.explanations}
        more={props.more}
        onCardEvent={props.onCardEvent}
        onOpenNote={props.onOpenNote}
        onRetryExplanation={props.onRetryExplanation}
        onShowMore={props.onShowMore}
      />
    </article>
  );
}
