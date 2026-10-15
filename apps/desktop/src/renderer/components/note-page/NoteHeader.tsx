import type { RefObject } from "react";
import { Check, Pencil, RefreshCw, User } from "lucide-react";
import type { NotePage } from "@app/domain";
import type { Translator } from "@app/i18n";

import { AiNoteBadge } from "../AiNoteBadge";
import { Button } from "../ui/button";
import { NoteEditForm, type EditError } from "./NoteEditForm";
import {
  formatNoteDate,
  interpolateNodes,
  noteActions,
  noteHeaderState,
  provenanceMessage,
  type NoteDraft
} from "./note-page-model";

const pill =
  "inline-flex h-5 items-center gap-1 rounded-full border border-border px-2 text-xs font-medium text-secondary-foreground";
const linkClass = "text-left text-accent hover:underline";

export interface NoteEditing {
  draft: NoteDraft;
  canSave: boolean;
  saving: boolean;
  error: EditError;
}

export interface NoteHeaderProps {
  t: Translator;
  page: NotePage;
  headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
  editRef?: RefObject<HTMLButtonElement | null> | undefined;
  editing: NoteEditing | null;
  review: { pending: boolean; failed: boolean };
  onMarkReviewed: () => void;
  onStartEdit: () => void;
  onDraftChange: (draft: NoteDraft) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  onDiscardAndReload: () => void;
  onEscapeEdit: () => void;
  onOpenNote: (noteId: string) => void;
}

/** Badge row, actions, the idea statement and where the note comes from. */
export function NoteHeader({
  t,
  page,
  headingRef,
  editRef,
  editing,
  review,
  onMarkReviewed,
  onStartEdit,
  onDraftChange,
  onSave,
  onCancelEdit,
  onDiscardAndReload,
  onEscapeEdit,
  onOpenNote
}: NoteHeaderProps) {
  const { note } = page;
  const state = noteHeaderState(note);
  const actions = noteActions(note);
  const provenance = provenanceMessage(page, t.locale);
  const showEditHint = note.authorship === "ai" && actions.edit;
  const lang = note.language ?? undefined;
  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {state.kind === "ai" ? (
          <>
            <AiNoteBadge
              t={t}
              status={note.status}
              humanProtected={note.humanProtected}
              variant="full"
            />
            {state.pending ? (
              <span className="text-xs text-muted-foreground">
                {t("notePage.status.pending_review")}
              </span>
            ) : (
              <>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                  <Check className="size-3" aria-hidden="true" />
                  {t("notePage.badge.activeSinceCreation")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("notePage.badge.reviewOptional")}
                </span>
              </>
            )}
          </>
        ) : null}
        {state.kind === "reviewed" ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
            <Check className="size-3" aria-hidden="true" />
            {t("notePage.badge.reviewedOn", {
              values: { date: formatNoteDate(note.reviewedAt ?? note.updatedAt, t.locale) }
            })}
          </span>
        ) : null}
        {state.kind === "edited" || state.kind === "evolution" ? (
          <>
            <span className={pill}>
              {state.kind === "edited" ? (
                <User className="size-3" aria-hidden="true" />
              ) : (
                <Check className="size-3" aria-hidden="true" />
              )}
              {t(state.kind === "edited" ? "notePage.badge.yours" : "notePage.badge.evolution")}
            </span>
            <span className="text-xs text-muted-foreground">{t("notePage.badge.protected")}</span>
          </>
        ) : null}
        {state.kind === "discarded" || state.kind === "archived" ? (
          <span className="text-xs text-muted-foreground">
            {t(
              state.kind === "discarded" ? "notePage.status.rejected" : "notePage.status.archived"
            )}
          </span>
        ) : null}
        <span className="flex-1" />
        {!editing && (actions.markReviewed || actions.edit) ? (
          <div className="flex flex-wrap items-center gap-2">
            {actions.markReviewed ? (
              <Button
                type="button"
                variant="secondary"
                disabled={review.pending}
                aria-busy={review.pending || undefined}
                onClick={onMarkReviewed}
              >
                <Check aria-hidden="true" />
                {t("notePage.actions.markReviewed")}
              </Button>
            ) : null}
            {actions.edit ? (
              <Button ref={editRef} type="button" variant="link" onClick={onStartEdit}>
                <Pencil aria-hidden="true" />
                {t("notePage.actions.edit")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {note.superseded ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{t("notePage.superseded")}</span>
          {page.successors.length === 1 ? (
            <button
              type="button"
              className={linkClass}
              onClick={() => onOpenNote(page.successors[0]!.id)}
            >
              {t("notePage.openCurrent")}
            </button>
          ) : (
            page.successors.map((successor) => (
              <button
                key={successor.id}
                type="button"
                className={linkClass}
                onClick={() => onOpenNote(successor.id)}
              >
                {t("notePage.openSuccessor", { values: { title: successor.title } })}
              </button>
            ))
          )}
        </p>
      ) : null}
      {review.failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{t("notePage.review.failed")}</p>
          <Button type="button" onClick={onMarkReviewed}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {editing ? (
        <NoteEditForm
          t={t}
          draft={editing.draft}
          language={note.language}
          canSave={editing.canSave}
          saving={editing.saving}
          error={editing.error}
          onChange={onDraftChange}
          onSave={onSave}
          onCancel={onCancelEdit}
          onDiscardAndReload={onDiscardAndReload}
          onEscape={onEscapeEdit}
        />
      ) : (
        <h1
          ref={headingRef}
          tabIndex={-1}
          lang={lang}
          className="font-reading text-2xl font-semibold text-pretty tracking-normal text-foreground"
        >
          {note.ideaStatement}
        </h1>
      )}
      <p className="text-sm text-muted-foreground">
        {interpolateNodes(t(provenance.key), {
          ...Object.fromEntries(
            Object.entries(provenance.values).map(([name, value]) => [name, String(value)])
          ),
          model: (
            <strong className="font-semibold text-secondary-foreground">
              {note.generationModel}
            </strong>
          )
        })}
        {showEditHint ? ` ${t("notePage.provenance.editHint")}` : null}
      </p>
    </header>
  );
}
