import type { RefObject } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { formatObjectAddress, type NotePage } from "@app/domain";
import type { Translator } from "@app/i18n";

import type { ObjectNavigation, PassageAnchor } from "../../lib/object-navigation";
import { cn } from "../../lib/cn";
import { dispatchClosePanel } from "../../lib/close-panel";
import { ObjectKindGlyph } from "../glyphs";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { ErrorState } from "../ui/error-state";
import { LoadingState, Skeleton, SkeletonLines } from "../ui/skeleton";
import { WhereIsThisView } from "../WhereIsThis";
import { NoteBodyText } from "./NoteBodyText";
import { NoteEvidence } from "./NoteEvidence";
import { NoteHeader, type NoteEditing } from "./NoteHeader";
import {
  NoteRelations,
  type RelationFocus,
  type RelationsGraph,
  type RelationsMore
} from "./NoteRelations";
import type { ExplanationState } from "./RelationEvidenceCard";
import type { NoteDraft, RelationGroup, ReviewDirection, ReviewState } from "./note-page-model";
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
  /** The owner's verdicts being saved, or that could not be saved, by relation. */
  reviews: Readonly<Record<string, ReviewState>>;
  /** "Show more" of each list of relations. */
  more: Readonly<Record<RelationGroup, RelationsMore>>;
  /** Where focus goes once a row left its list (a verdict, a withdrawn relation). */
  relationFocus: RelationFocus | null;
  /** Whether the withdrawn relations are listed. */
  withdrawnOpen: boolean;
  /** The relation graph's inputs (F3 D43); absent, the relations are the list alone. */
  graph?: RelationsGraph | undefined;
  openFailed: boolean;
  /**
   * The page lives in a panel of the workspace: the panel's frame draws the kind, the close control
   * and the path ribbon (which replaces "Where is this"), and the states use the shared primitives.
   */
  embedded?: boolean;
  /**
   * How the relations show: the full list, or the stance summary while the context panel beside
   * the page lists them (design record 5.6, 6.3). The full list is the default.
   */
  relationsView?: "full" | "summary";
  /** The previous panel's compact form: the idea, the first lines and the counts. */
  compact?: boolean;
  /** "Place in topic" (T26): whether the page shows, and what to do once the note was placed. */
  place?: { active: boolean; onPlaced: () => void } | undefined;
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
  onReview: (relationId: string, verdict: "keep" | "remove", direction?: ReviewDirection) => void;
  onRelationFocusHandled: () => void;
  onToggleWithdrawn: () => void;
  onShowMore: (group: RelationGroup) => void;
}

/**
 * The Note page: what the note says, where it comes from, where it is, its evidence and its
 * relations, in one column. Props in, callbacks out: the host decides where it lives (the Library
 * today, a panel later); widths come from the container.
 */
export function NotePageView(props: NotePageViewProps) {
  const { t, load, embedded = false } = props;
  if (embedded && props.compact && load.status === "ready")
    return <NoteCompact t={t} page={load.page} />;
  return (
    <div
      className={cn(
        "@container flex flex-col gap-4",
        // The page's column is capped; focus mode centres it (panel-stack-styles), and otherwise it
        // starts on the ribbon's edge.
        embedded && "w-full max-w-264"
      )}
    >
      {embedded ? null : (
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
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {props.announcement}
      </p>
      {embedded ? <EmbeddedStates {...props} /> : null}
      {!embedded && load.status === "loading" ? (
        <div role="status" aria-busy="true" className="flex w-full max-w-190 flex-col gap-4">
          <span className="sr-only">{t("shell.states.loading")}</span>
          <div className="h-8 w-3/4 rounded-md bg-soft" />
          <div className="h-28 rounded-md bg-soft" />
          <div className="h-12 rounded-md bg-soft" />
          <div className="h-12 rounded-md bg-soft" />
        </div>
      ) : null}
      {!embedded && load.status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{t("notePage.error")}</p>
          <Button type="button" onClick={props.onRetry}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {!embedded && load.status === "missing" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("notePage.missing")}
        </p>
      ) : null}
      {load.status === "ready" ? <NoteArticle {...props} page={load.page} /> : null}
    </div>
  );
}

/**
 * The three states of a note in a panel (design record 5.12, 6): a skeleton in the shape of the
 * page, no wider than the reading measure; one plain sentence in place with what is kept and one
 * retry; and what a note that is gone says. The page itself is the success state.
 */
function EmbeddedStates({ t, load, compact, onRetry }: NotePageViewProps) {
  if (load.status === "loading")
    return (
      // The wide sheet keeps its margin while it loads (from 760 px: the text column and the
      // Evidence margin), so the page does not jump when the note arrives.
      <LoadingState
        t={t}
        className="max-w-(--measure) gap-4 @min-[760px]:max-w-none @min-[760px]:grid-cols-[minmax(0,600px)_264px] @min-[760px]:gap-x-12"
      >
        <div className="grid min-w-0 gap-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-7 w-4/5" />
          <Skeleton className="w-1/2" />
          <SkeletonLines lines={5} className="mt-3" />
        </div>
        <div className="hidden min-w-0 gap-3 @min-[760px]:grid">
          <Skeleton className="h-4 w-1/3" />
          <SkeletonLines lines={4} />
        </div>
      </LoadingState>
    );
  if (load.status === "error")
    // The previous panel is quiet: the top panel's one sentence and retry say the failure.
    return compact ? (
      <p className="m-0 text-sm text-muted-foreground">{t("explore.compactError")}</p>
    ) : (
      <ErrorState
        t={t}
        className="max-w-(--measure)"
        message={t("explore.note.error")}
        kept={t("explore.note.errorKept")}
        retryLabel={t("shell.actions.retry")}
        onRetry={onRetry}
      />
    );
  // The previous panel says only a neutral word for a gone object: the top panel's box says what
  // happened, once.
  if (load.status === "missing" && compact)
    return <p className="m-0 text-sm text-muted-foreground">{t("explore.compactGone")}</p>;
  if (load.status === "missing")
    return (
      <EmptyState
        className="max-w-(--measure)"
        headline={t("explore.note.goneHeadline")}
        action={
          // The one way on: the top panel closes and the person is back at the one before it.
          <Button type="button" onClick={() => void dispatchClosePanel()}>
            {t("panelFrame.close")}
          </Button>
        }
      >
        {t("explore.note.goneBody")}
      </EmptyState>
    );
  return null;
}

/**
 * The previous panel's form (design record 6.1): the idea in the title's place and the first lines
 * of the text, so the trail that led to the next panel stays readable. It has no controls: the
 * panel is made the top again by a click on it.
 */
function NoteCompact({ t, page }: { t: Translator; page: NotePage }) {
  const { note } = page;
  return (
    <article aria-label={t("notePage.articleLabel", { values: { title: note.title } })}>
      <h2
        lang={note.language ?? undefined}
        className="m-0 mb-2 font-reading text-lg leading-snug font-semibold text-foreground [text-wrap:balance]"
      >
        {note.ideaStatement}
      </h2>
      <p
        lang={note.language ?? undefined}
        className="m-0 line-clamp-6 font-reading text-sm leading-6 text-secondary-foreground [text-wrap:pretty]"
      >
        {note.bodyMarkdown
          .replace(/[#*_`>[\]]/gu, "")
          .replace(/\s+/gu, " ")
          .trim()}
      </p>
    </article>
  );
}

function NoteArticle(props: NotePageViewProps & { page: NotePage }) {
  const { t, page } = props;
  const { note } = page;
  const primary = page.evidence.items.find((item) => item.primary) ?? null;
  const embedded = props.embedded === true;
  const header = (
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
      place={props.place}
      embedded={embedded}
    />
  );
  const where = embedded ? null : (
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
  );
  const evidence = (
    <NoteEvidence
      t={t}
      evidence={page.evidence}
      quiet={embedded}
      onOpenPassage={props.onOpenPassage}
    />
  );
  return (
    <article
      aria-label={t("notePage.articleLabel", { values: { title: note.title } })}
      className={cn("flex w-full flex-col gap-8 pb-12", !embedded && "max-w-190")}
    >
      {embedded ? (
        // The wide sheet (design record 6.3): from 760 px the text column keeps its 600 px and
        // Evidence moves into a 264 px margin, top-aligned with the title; below it, the margin
        // folds into the body in the same order.
        <div className="grid min-w-0 gap-8 @min-[760px]:grid-cols-[minmax(0,600px)_264px] @min-[760px]:gap-x-12">
          <div className="flex min-w-0 flex-col gap-6">
            {header}
            <NoteBodyText t={t} note={note} embedded citations={page.evidence.items.length} />
          </div>
          {/* Folded under the prose (below 760 px) the quotes keep the prose's measure. */}
          <div className="min-w-0 max-w-(--measure) @min-[760px]:max-w-none">{evidence}</div>
        </div>
      ) : (
        <>
          {header}
          <NoteBodyText t={t} note={note} />
          {where}
          {evidence}
        </>
      )}
      <NoteRelations
        t={t}
        thisId={note.id}
        thisPrimary={primary}
        relations={page.relations}
        withdrawn={page.withdrawn}
        earlierVersions={page.earlierVersions}
        openCard={props.openCard}
        explanations={props.explanations}
        reviews={props.reviews}
        more={props.more}
        withdrawnOpen={props.withdrawnOpen}
        focusRequest={props.relationFocus}
        graph={props.graph}
        view={props.relationsView ?? "full"}
        embedded={embedded}
        onCardEvent={props.onCardEvent}
        onOpenNote={props.onOpenNote}
        onRetryExplanation={props.onRetryExplanation}
        onReview={props.onReview}
        onToggleWithdrawn={props.onToggleWithdrawn}
        onFocusHandled={props.onRelationFocusHandled}
        onShowMore={props.onShowMore}
      />
    </article>
  );
}
