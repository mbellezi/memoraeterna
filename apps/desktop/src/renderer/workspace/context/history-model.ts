import type { ChangeSetRef, ChangeSetSummary, ChangesUndoResult } from "@app/domain";
import type { MessageKey } from "@app/i18n";

import { blockerMessages, undoFailureMessage } from "../../components/activity/activity-controller";

/**
 * What the Histórico tab says of one change-set (design record §5.6, §5.7): who made it, the node of
 * the thread, the one quiet line under the sentence and whether the row offers Desfazer. Pure, so
 * every rule is tested without a renderer. The sentence itself is `changeSetTitle` (the same words
 * as the Activity drawer and Home), and Desfazer is the F4 `changes.undo`, which names what blocks it.
 */

/** Who made the change: the person (their own edit, an undo) or the Gardener's automatic work. */
export type HistoryWho = "you" | "gardener";

export const historyWho = (change: Pick<ChangeSetSummary, "origin">): HistoryWho =>
  change.origin === "human" || change.origin === "undo" ? "you" : "gardener";

/** What came of a Desfazer here: under way, taken back, refused with the reason, or failed. */
export type HistoryUndo =
  | { status: "pending" }
  | { status: "undone" }
  | { status: "blocked" | "failed"; messageKey: MessageKey };

export const historyUndoKey = (ref: ChangeSetRef): string => `${ref.kind}:${ref.id}`;

/** The row a finished `changes.undo` leaves (a store's own refusal names its blocker). */
export function historyUndoOutcome(result: ChangesUndoResult): HistoryUndo {
  return result.status === "undone"
    ? { status: "undone" }
    : { status: "blocked", messageKey: blockerMessages[result.blockers[0]?.code ?? "conflict"] };
}

/** The row a `changes.undo` that threw leaves. */
export const historyUndoFailure = (error: unknown): HistoryUndo => ({
  status: "failed",
  messageKey: undoFailureMessage(error)
});

/** The thread's node: filled once the change stands, hollow while it waits or no longer stands. */
export type HistoryNode = "done" | "hollow";

/** The line under the sentence, other than a refusal's own words. */
export type HistoryNote = "waiting" | "undone" | "dismissed" | "blocked";

export interface HistoryRowView {
  node: HistoryNode;
  /** A quiet line (waiting for a decision, undone, dismissed, or "cannot be undone now"). */
  note: HistoryNote | null;
  /** Desfazer is offered (or, while it runs, shown as under way). */
  undo: "offered" | "running" | null;
  /** The words of a refusal or a failure of the Desfazer just tried. */
  refusal: MessageKey | null;
}

/** How one row reads, from the change-set and what a Desfazer here did to it. */
export function historyRow(change: ChangeSetSummary, local?: HistoryUndo): HistoryRowView {
  if (local?.status === "undone")
    return { node: "hollow", note: "undone", undo: null, refusal: null };
  if (change.status === "pending_review")
    return { node: "hollow", note: "waiting", undo: null, refusal: null };
  if (change.status === "undone")
    return { node: "hollow", note: "undone", undo: null, refusal: null };
  if (change.status === "dismissed")
    return { node: "hollow", note: "dismissed", undo: null, refusal: null };
  const refusal = local && local.status !== "pending" ? local.messageKey : null;
  if (change.undo === "available")
    return {
      node: "done",
      note: null,
      undo: local?.status === "pending" ? "running" : "offered",
      refusal
    };
  // A refusal already said why; the standing "a later change depends on it" is its short form.
  return {
    node: "done",
    note: change.undo === "blocked" && refusal === null ? "blocked" : null,
    undo: null,
    refusal
  };
}

/** The tab's state from its read: loading, error, empty (no change-set) or success. */
export function historyState(
  read: { status: "loading" } | { status: "error" } | { status: "ready"; items: readonly unknown[] }
): "loading" | "error" | "empty" | "success" {
  if (read.status !== "ready") return read.status;
  return read.items.length === 0 ? "empty" : "success";
}
