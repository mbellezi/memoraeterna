import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";
import { formatObjectAddress, notePageLimits, type NotePage as NotePageData } from "@app/domain";
import type { Translator } from "@app/i18n";

import { closePanelPriority, subscribeClosePanel } from "../../lib/close-panel";
import { isSilentRefresh, type LoadOutcome } from "../../lib/hidden-view";
import type { PassageAnchor } from "../../lib/object-navigation";
import { useTopicsPulse } from "../../lib/topics-pulse";
import { recordView, viewsToRecord, type OpenedObject } from "../../lib/view-history";
import { dispatchWindowNavigation, subscribeWindowNavigation } from "../../lib/window-navigation";
import { useObjectOpener, type OpenableNavigation } from "../WhereIsThis";
import type { NoteEditing } from "./NoteHeader";
import { NoteLeaveDialog } from "./NoteLeaveDialog";
import { NotePageView, type NotePageLoad } from "./NotePageView";
import type { RelationsMore } from "./NoteRelations";
import {
  asksForExplanation,
  editBase,
  editChanges,
  editRequest,
  explanationAfter,
  explanationErrorKind,
  hasUnsavedEdit,
  isPristineDraft,
  keepShownRelations,
  keepsNotePageMounted,
  nextAnnouncement,
  refreshRelationLimit,
  reviewErrorKind,
  unsavedEditNavigationGuard,
  withPlacement,
  type ExplanationState,
  type NoteDraft,
  type NoteEditBase
} from "./note-page-model";
import { cardReducer, escapeClosesCard, initialCardState } from "./relation-card-state";

/** Above the Library's history listener (0), below dialogs and overlays that claim Back (10+). */
const unsavedEditNavigationPriority = 5;

/** Runs `go` at once, or once the owner chose to discard the unsaved edit of the page. */
export type NoteLeaveGuard = (go: () => void) => void;

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
  /** Receives the page's guard for moves the host makes itself (an object opened elsewhere). */
  onLeaveGuard?(guard: NoteLeaveGuard | null): void;
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

/**
 * The Note page container: loading, actions, explanations on a deliberate open, Cmd-W, history,
 * the guard of unsaved edits and focus.
 */
export function NotePage({
  noteId,
  active,
  backLabel,
  t,
  onBack,
  onOpenNote,
  onOpenPassage,
  onNavigate,
  onChanged,
  onLeaveGuard
}: NotePageProps) {
  const [load, setLoad] = useState<NotePageLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<NoteEditing | null>(null);
  const [leaving, setLeaving] = useState<{ go: () => void } | null>(null);
  const [review, setReview] = useState({ pending: false, failed: false });
  const [more, setMore] = useState<RelationsMore>({ status: "idle" });
  const [explanations, setExplanations] = useState<Record<string, ExplanationState>>({});
  const [explainRetry, setExplainRetry] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [placedByHand, setPlacedByHand] = useState(0);
  const topicsPulse = useTopicsPulse(active);
  const [card, dispatchCard] = useReducer(cardReducer, initialCardState);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const outcome = useRef<LoadOutcome | null>(null);
  const wasHidden = useRef(false);
  const shown = useRef<NotePageData | null>(null);
  const editingNow = useRef<NoteEditing | null>(null);
  const explanationsNow = useRef<Readonly<Record<string, ExplanationState>>>({});
  const recorded = useRef<ReadonlySet<string>>(new Set());
  const focusedHeading = useRef(false);
  const focusEdit = useRef(false);
  const key = `${noteId}|${attempt}`;

  // Every move off the page (or onto another note) asks first when it would drop an unsaved edit.
  const leave = (go: () => void) => {
    if (hasUnsavedEdit(editing)) setLeaving({ go });
    else go();
  };
  // A topic opens in the Wiki and keeps this page, and its draft, mounted underneath.
  const opener = useObjectOpener((navigation) =>
    keepsNotePageMounted(navigation) ? onNavigate(navigation) : leave(() => onNavigate(navigation))
  );

  useEffect(() => {
    shown.current = load.status === "ready" ? load.page : null;
  }, [load]);

  useEffect(() => {
    editingNow.current = editing;
  }, [editing]);

  useEffect(() => {
    explanationsNow.current = explanations;
  }, [explanations]);

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
        setLoad((current) => {
          const next = keepShownRelations(current.status === "ready" ? current.page : null, page);
          return current.status === "ready" && JSON.stringify(current.page) === JSON.stringify(next)
            ? current
            : { status: "ready", page: next };
        });
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

  // The path of the note follows the topic tree: it is read again (one cheap locate, not the whole
  // page) after the tree changed and after the note was placed by hand. A failed read keeps the
  // path that is shown.
  const placementAsk = topicsPulse + placedByHand;
  useEffect(() => {
    if (!active || placementAsk === 0) return;
    let live = true;
    window.app.objects
      .locate({ address: formatObjectAddress({ kind: "note", id: noteId }) })
      .then((placement) => {
        if (!live || !placement) return;
        setLoad((current) => {
          if (current.status !== "ready" || current.page.note.id !== noteId) return current;
          const page = withPlacement(current.page, placement);
          return page === current.page ? current : { status: "ready", page };
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [active, placementAsk, noteId]);

  // A hidden page closes its card and its question about leaving; the editor draft is kept.
  useEffect(() => {
    if (active) return;
    dispatchCard({ type: "reset" });
    setLeaving(null);
  }, [active]);

  useEffect(() => {
    const pending = card.pending;
    if (!pending) return;
    const timer = setTimeout(() => dispatchCard({ type: "timer" }), pending.delayMs);
    return () => clearTimeout(timer);
  }, [card.pending]);

  useEffect(() => {
    const dwell = card.dwell;
    if (!dwell) return;
    const timer = setTimeout(() => dispatchCard({ type: "dwell" }), dwell.delayMs);
    return () => clearTimeout(timer);
  }, [card.dwell]);

  // Escape closes a card opened by hover too, wherever focus is (never while typing).
  useEffect(() => {
    if (!active || card.open === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (escapeClosesCard(event)) dispatchCard({ type: "escape" });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, card.open]);

  // A card that stayed open asks for the explanation it lacks; closing it first cancels the request.
  // A relation found gone ends in a terminal state: it is not asked for again.
  useEffect(() => {
    const relationId = card.explain;
    if (!active || relationId === null) return;
    const relation = shown.current?.relations.items.find((item) => item.id === relationId);
    if (!asksForExplanation(relation, explanationsNow.current[relationId])) return;
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
        const after = explanationAfter(result);
        setExplanations((current) =>
          after ? { ...current, [relationId]: after } : without(current, relationId)
        );
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
  }, [active, card.explain, explainRetry]);

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

  // Back, Forward and their shortcuts and mouse buttons ask before an unsaved edit is dropped.
  useEffect(() => {
    if (!active || !isEditing) return;
    return subscribeWindowNavigation(
      unsavedEditNavigationGuard(
        () => hasUnsavedEdit(editingNow.current),
        (direction) => setLeaving({ go: () => dispatchWindowNavigation(direction) })
      ),
      unsavedEditNavigationPriority
    );
  }, [active, isEditing]);

  // The host asks the same way before it moves on its own.
  useEffect(() => {
    if (!onLeaveGuard) return;
    onLeaveGuard((go) => {
      if (hasUnsavedEdit(editingNow.current)) setLeaving({ go });
      else go();
    });
    return () => onLeaveGuard(null);
  }, [onLeaveGuard]);

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
  // The same outcome twice in a row is announced twice.
  const announce = (text: string) =>
    setAnnouncement((previous) => nextAnnouncement(previous, text));

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
    // Taken against the version the draft started from, never a page refreshed meanwhile.
    const request = editRequest(page.note.id, editing);
    if (!request) return;
    setEditing({ ...editing, saving: true, error: null });
    try {
      await window.app.knowledge.reviewNote(request);
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

  const draftState = (base: NoteEditBase, draft: NoteDraft): NoteEditing => {
    const changes = editChanges(base, draft);
    return {
      base,
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

  const discardAndLeave = () => {
    if (!leaving) return;
    // The move below is no longer held by the unsaved edit.
    editingNow.current = null;
    setLeaving(null);
    setEditing(null);
    leaving.go();
  };

  return (
    <>
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
        onBack={() => leave(onBack)}
        onRetry={reload}
        onMarkReviewed={() => void markReviewed()}
        onStartEdit={() => {
          if (!page) return;
          const base = editBase(page.note);
          setEditing(
            draftState(base, {
              title: base.title,
              ideaStatement: base.ideaStatement,
              bodyMarkdown: base.bodyMarkdown
            })
          );
        }}
        onDraftChange={(draft) =>
          setEditing((current) => current && draftState(current.base, draft))
        }
        onSave={() => void save()}
        onCancelEdit={cancelEdit}
        onDiscardAndReload={() => {
          cancelEdit();
          reload();
        }}
        onEscapeEdit={() => {
          if (editing && isPristineDraft(editing.base, editing.draft)) cancelEdit();
        }}
        onOpenNote={(id) => leave(() => onOpenNote(id))}
        place={{ active, onPlaced: () => setPlacedByHand((current) => current + 1) }}
        onOpenPassage={(sourceItemId, passage) => leave(() => onOpenPassage(sourceItemId, passage))}
        onOpenPlacement={opener.open}
        onCardEvent={dispatchCard}
        onRetryExplanation={(relationId) => {
          setExplanations((current) => without(current, relationId));
          dispatchCard({ type: "explainNow", id: relationId });
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
      {leaving ? (
        <NoteLeaveDialog t={t} onKeepEditing={() => setLeaving(null)} onDiscard={discardAndLeave} />
      ) : null}
    </>
  );
}
