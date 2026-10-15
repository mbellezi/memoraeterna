import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { formatObjectAddress, notePageLimits, type NotePage as NotePageData } from "@app/domain";
import type { Translator } from "@app/i18n";

import { closePanelPriority, subscribeClosePanel } from "../../lib/close-panel";
import { isSilentRefresh, type LoadOutcome } from "../../lib/hidden-view";
import type { PassageAnchor } from "../../lib/object-navigation";
import { recordView, viewsToRecord, type OpenedObject } from "../../lib/view-history";
import { useObjectOpener, type OpenableNavigation } from "../WhereIsThis";
import type { NoteEditing } from "./NoteHeader";
import { NotePageView, type NotePageLoad } from "./NotePageView";
import type { RelationsMore } from "./NoteRelations";
import type { ExplanationState } from "./RelationEvidenceCard";
import {
  editChanges,
  explanationErrorKind,
  isPristineDraft,
  refreshRelationLimit,
  reviewErrorKind,
  type NoteDraft
} from "./note-page-model";
import { cardReducer, initialCardState } from "./relation-card-state";

export interface NotePageProps {
  noteId: string;
  /** False while the host view is hidden: nothing loads, the card closes, the draft is kept. */
  active: boolean;
  backLabel: string;
  t: Translator;
  onBack(): void;
  onOpenNote(noteId: string): void;
  onOpenPassage(sourceItemId: string, passage: PassageAnchor): void;
  /** Path segments and placements. */
  onNavigate(navigation: OpenableNavigation): void;
  /** After a review or an edit, so the host can refresh what it keeps of the note. */
  onChanged?(): void;
}

/**
 * What a render does about loading: nothing while hidden or when the key already finished, a
 * refresh in place when the page is shown again after a successful load or reloads the note it
 * already shows (after its own actions), otherwise a load with a loading state.
 */
export function notePageLoadDecision(input: {
  active: boolean;
  wasHidden: boolean;
  outcome: LoadOutcome | null;
  key: string;
  showing: boolean;
}): "skip" | "silent" | "load" {
  if (!input.active) return "skip";
  if (isSilentRefresh(input.wasHidden, input.outcome, input.key)) return "silent";
  if (input.outcome?.key === input.key) return "skip";
  return input.showing ? "silent" : "load";
}

/** The note opened as a page, with the host's history entry for it. */
export function notePageOpenedObject(page: NotePageData): OpenedObject {
  return {
    kind: "note",
    id: page.note.id,
    title: page.note.title,
    parentAddress: formatObjectAddress({ kind: "source", id: page.note.homeSourceId })
  };
}

function withExplanation(
  load: NotePageLoad,
  relationId: string,
  explanation: { text: string; writtenBy: string }
): NotePageLoad {
  if (load.status !== "ready") return load;
  const items = load.page.relations.items.map((item) =>
    item.id === relationId ? { ...item, explanation } : item
  );
  return { status: "ready", page: { ...load.page, relations: { ...load.page.relations, items } } };
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!(key in record)) return record as Record<string, T>;
  const next = { ...record };
  delete next[key];
  return next;
}

/** The Note page container: loading, actions, explanations on open, Cmd-W, history and focus. */
export function NotePage({
  noteId,
  active,
  backLabel,
  t,
  onBack,
  onOpenNote,
  onOpenPassage,
  onNavigate,
  onChanged
}: NotePageProps) {
  const [load, setLoad] = useState<NotePageLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<NoteEditing | null>(null);
  const [review, setReview] = useState({ pending: false, failed: false });
  const [more, setMore] = useState<RelationsMore>({ status: "idle" });
  const [explanations, setExplanations] = useState<Record<string, ExplanationState>>({});
  const [explainRetry, setExplainRetry] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [card, dispatchCard] = useReducer(cardReducer, initialCardState);
  const opener = useObjectOpener(onNavigate);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const outcome = useRef<LoadOutcome | null>(null);
  const wasHidden = useRef(false);
  const shown = useRef<NotePageData | null>(null);
  const recorded = useRef<ReadonlySet<string>>(new Set());
  const focusedHeading = useRef(false);
  const focusEdit = useRef(false);
  const key = `${noteId}|${attempt}`;

  useEffect(() => {
    shown.current = load.status === "ready" ? load.page : null;
  }, [load]);

  useEffect(() => {
    const decision = notePageLoadDecision({
      active,
      wasHidden: wasHidden.current,
      outcome: outcome.current,
      key,
      showing: shown.current !== null
    });
    if (!active) {
      wasHidden.current = true;
      return;
    }
    wasHidden.current = false;
    if (decision === "skip") return;
    const silent = decision === "silent";
    const rows = shown.current?.relations.items.length ?? 0;
    let live = true;
    if (!silent) setLoad({ status: "loading" });
    window.app.notes
      .page({
        noteId,
        relationLimit: rows > 0 ? refreshRelationLimit(rows) : notePageLimits.relationPage
      })
      .then((page) => {
        if (!live) return;
        outcome.current = { key, ok: true, hasData: page !== null };
        if (!page) {
          setLoad({ status: "missing" });
          return;
        }
        setLoad((current) =>
          current.status === "ready" && JSON.stringify(current.page) === JSON.stringify(page)
            ? current
            : { status: "ready", page }
        );
      })
      .catch(() => {
        if (!live) return;
        outcome.current = { key, ok: false, hasData: false };
        // A failed refresh keeps the page that is shown.
        if (!silent) setLoad({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [active, key, noteId]);

  // A hidden page closes its card; the editor draft is kept.
  useEffect(() => {
    if (!active) dispatchCard({ type: "reset" });
  }, [active]);

  useEffect(() => {
    const pending = card.pending;
    if (!pending) return;
    const timer = setTimeout(() => dispatchCard({ type: "timer" }), pending.delayMs);
    return () => clearTimeout(timer);
  }, [card.pending]);

  // Opening a relation without a current explanation asks for one; closing the card cancels it.
  useEffect(() => {
    const relationId = card.open;
    if (!active || relationId === null) return;
    const relation = shown.current?.relations.items.find((item) => item.id === relationId);
    if (!relation || relation.explanation) return;
    let settled = false;
    let canceled = false;
    setExplanations((current) => ({ ...current, [relationId]: { status: "writing" } }));
    window.app.relations
      .explain({ relationId })
      .then((result) => {
        settled = true;
        if (result)
          setLoad((current) =>
            withExplanation(current, relationId, { text: result.text, writtenBy: result.writtenBy })
          );
        setExplanations((current) => without(current, relationId));
      })
      .catch((error: unknown) => {
        settled = true;
        if (canceled) return;
        setExplanations((current) => ({
          ...current,
          [relationId]: { status: "failed", kind: explanationErrorKind(error) }
        }));
      });
    return () => {
      if (settled) return;
      canceled = true;
      void window.app.relations.cancelExplain({ relationId }).catch(() => undefined);
      setExplanations((current) => without(current, relationId));
    };
  }, [active, card.open, explainRetry]);

  // Cmd-W closes the page; while editing it keeps the editor (an edit is never discarded).
  const close = useEffectEvent(() => onBack());
  const isEditing = editing !== null;
  useEffect(() => {
    if (!active) return;
    if (isEditing) return subscribeClosePanel(() => true, closePanelPriority.editing);
    return subscribeClosePanel(() => {
      close();
      return true;
    }, closePanelPriority.panel);
  }, [active, isEditing]);

  // One recorded open per showing of the page; nothing while hidden.
  useEffect(() => {
    const next = viewsToRecord(
      !active ? null : load.status === "ready" ? [notePageOpenedObject(load.page)] : [],
      recorded.current
    );
    recorded.current = next.recorded;
    next.record.forEach((object) =>
      recordView({
        kind: object.kind,
        id: object.id,
        title: object.title,
        ...(object.parentAddress ? { parentAddress: object.parentAddress } : {})
      })
    );
  }, [active, load]);

  // Focus: the heading when the note first shows, "Edit" after an action that removed a control.
  useEffect(() => {
    if (!active || load.status !== "ready") return;
    if (!focusedHeading.current) {
      focusedHeading.current = true;
      headingRef.current?.focus({ preventScroll: true });
    }
    if (focusEdit.current && editRef.current && !isEditing) {
      focusEdit.current = false;
      editRef.current.focus();
    }
  }, [active, load, isEditing]);

  const page = load.status === "ready" ? load.page : null;
  const reload = () => setAttempt((current) => current + 1);
  const announce = (text: string) => setAnnouncement(text);

  const markReviewed = async () => {
    if (!page || review.pending) return;
    setReview({ pending: true, failed: false });
    try {
      await window.app.knowledge.reviewNote({
        id: page.note.id,
        action: "approve",
        expectedUpdatedAt: page.note.updatedAt
      });
      setReview({ pending: false, failed: false });
      focusEdit.current = true;
      reload();
      onChanged?.();
      announce(t("notePage.announce.reviewed"));
    } catch (error) {
      const conflict = reviewErrorKind(error) === "conflict";
      setReview({ pending: false, failed: !conflict });
      // Somebody changed the note meanwhile: show what it is now.
      if (conflict) reload();
    }
  };

  const save = async () => {
    if (!page || !editing || editing.saving) return;
    const changes = editChanges(page.note, editing.draft);
    if (changes === null || changes === "invalid") return;
    setEditing({ ...editing, saving: true, error: null });
    try {
      await window.app.knowledge.reviewNote({
        id: page.note.id,
        action: "edit",
        expectedUpdatedAt: page.note.updatedAt,
        ...changes
      });
      setEditing(null);
      focusEdit.current = true;
      reload();
      onChanged?.();
      announce(t("notePage.announce.saved"));
    } catch (error) {
      setEditing((current) =>
        current ? { ...current, saving: false, error: reviewErrorKind(error) } : current
      );
    }
  };

  const draftState = (draft: NoteDraft): NoteEditing => {
    const changes = page ? editChanges(page.note, draft) : null;
    return {
      draft,
      canSave: changes !== null && changes !== "invalid",
      saving: false,
      error: changes === "invalid" ? "invalid" : null
    };
  };

  const cancelEdit = () => {
    setEditing(null);
    focusEdit.current = true;
  };

  return (
    <NotePageView
      t={t}
      backLabel={backLabel}
      load={load}
      headingRef={headingRef}
      editRef={editRef}
      editing={editing}
      review={review}
      openCard={card.open}
      explanations={explanations}
      more={more}
      openFailed={opener.openFailed}
      announcement={announcement}
      onBack={onBack}
      onRetry={reload}
      onMarkReviewed={() => void markReviewed()}
      onStartEdit={() => {
        if (!page) return;
        setEditing(
          draftState({
            title: page.note.title,
            ideaStatement: page.note.ideaStatement,
            bodyMarkdown: page.note.bodyMarkdown
          })
        );
      }}
      onDraftChange={(draft) => setEditing(draftState(draft))}
      onSave={() => void save()}
      onCancelEdit={cancelEdit}
      onDiscardAndReload={() => {
        cancelEdit();
        reload();
      }}
      onEscapeEdit={() => {
        if (page && editing && isPristineDraft(page.note, editing.draft)) cancelEdit();
      }}
      onOpenNote={onOpenNote}
      onOpenPassage={onOpenPassage}
      onOpenPlacement={opener.open}
      onCardEvent={dispatchCard}
      onRetryExplanation={(relationId) => {
        setExplanations((current) => without(current, relationId));
        setExplainRetry((current) => current + 1);
      }}
      onShowMore={() => {
        if (!page || more.status === "loading") return;
        setMore({ status: "loading" });
        window.app.notes
          .relations({
            noteId,
            offset: page.relations.items.length,
            limit: notePageLimits.relationPage
          })
          .then((next) => {
            setLoad((current) => {
              if (current.status !== "ready") return current;
              const known = new Set(current.page.relations.items.map((item) => item.id));
              const items = [
                ...current.page.relations.items,
                ...next.items.filter((item) => !known.has(item.id))
              ];
              return {
                status: "ready",
                page: { ...current.page, relations: { total: next.total, items } }
              };
            });
            setMore({ status: "idle" });
          })
          .catch(() => setMore({ status: "error" }));
      }}
    />
  );
}
