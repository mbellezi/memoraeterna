import { Fragment, createElement, type ReactNode } from "react";
import {
  notePageLimits,
  type NotePage,
  type NotePageEvidence,
  type NotePageNote,
  type NotePageRelation,
  type NotePageRelationExplanation
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { relationTypeView } from "../../lib/relation-stance";
import type { NavigationDirection } from "../../lib/window-navigation";

/**
 * Timing of the relation evidence card: the hover delays, and how long a card must stay open on
 * the same row before its explanation is asked for (a pass-through hover or a tab past never asks).
 */
export const notePageTiming = {
  cardOpenDelayMs: 300,
  cardCloseDelayMs: 150,
  explainDwellMs: 600
} as const;

/** What the header says about the note, in precedence order; `superseded` is reported apart. */
export type NoteHeaderState =
  | { kind: "discarded" }
  | { kind: "archived" }
  | { kind: "edited" }
  | { kind: "evolution" }
  | { kind: "reviewed" }
  | { kind: "ai"; pending: boolean };

export function noteHeaderState(
  note: Pick<NotePageNote, "status" | "authorship">
): NoteHeaderState {
  if (note.status === "rejected") return { kind: "discarded" };
  if (note.status === "archived") return { kind: "archived" };
  if (note.authorship === "edited") return { kind: "edited" };
  if (note.authorship === "evolution") return { kind: "evolution" };
  if (note.status === "approved") return { kind: "reviewed" };
  return { kind: "ai", pending: note.status === "pending_review" };
}

/** History is read-only: a superseded, discarded or archived note offers no action. */
export function noteActions(note: Pick<NotePageNote, "status" | "authorship" | "superseded">): {
  markReviewed: boolean;
  edit: boolean;
} {
  if (note.superseded || note.status === "rejected" || note.status === "archived")
    return { markReviewed: false, edit: false };
  return { markReviewed: noteHeaderState(note).kind === "ai", edit: true };
}

/** The work the listed passages come from, when there is a single one. */
export function evidenceSummary(evidence: NotePage["evidence"]): {
  count: number;
  workCount: number;
  workTitle: string | null;
} {
  const works = new Set(evidence.items.map((item) => item.workTitle ?? item.sourceTitle));
  return {
    count: evidence.total,
    workCount: works.size,
    workTitle: works.size === 1 ? [...works][0]! : null
  };
}

export function formatNoteDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso)
  );
}

/** The provenance sentence under the idea statement: who wrote the note, from what, and when. */
export function provenanceMessage(
  page: Pick<NotePage, "note" | "evidence">,
  locale: string
): { key: MessageKey; values: Record<string, string | number> } {
  const { note } = page;
  const model = note.generationModel;
  if (note.authorship === "edited")
    return {
      key: "notePage.provenance.edited",
      values: { model, date: formatNoteDate(note.lastEditedAt ?? note.updatedAt, locale) }
    };
  const date = formatNoteDate(note.createdAt, locale);
  if (note.authorship === "evolution")
    return { key: "notePage.provenance.evolution", values: { model, date } };
  const summary = evidenceSummary(page.evidence);
  if (summary.count === 0)
    return { key: "notePage.provenance.noEvidence", values: { model, date } };
  if (summary.workCount > 1)
    return {
      key: "notePage.provenance.passagesOfSources",
      values: { model, count: summary.count, sourceCount: summary.workCount, date }
    };
  const source = summary.workTitle ?? "";
  return summary.count === 1
    ? { key: "notePage.provenance.onePassage", values: { model, source, date } }
    : {
        key: "notePage.provenance.passages",
        values: { model, count: summary.count, source, date }
      };
}

/** "Section · passage 3 · p. 7 · range 412–618", from the parts that are known. */
export function evidenceLocator(item: NotePageEvidence, t: Translator): string {
  const parts: string[] = [];
  if (item.workTitle !== null) parts.push(item.sourceTitle);
  if (item.chunkIndex !== null)
    parts.push(t("notePage.evidence.passage", { values: { number: item.chunkIndex + 1 } }));
  if (item.page !== null) parts.push(t("notePage.evidence.page", { values: { page: item.page } }));
  if (item.range !== null)
    parts.push(
      t("notePage.evidence.range", { values: { start: item.range.start, end: item.range.end } })
    );
  return parts.join(" · ");
}

/** A passage opens in the reader only when it is current and its source still exists. */
export function evidenceLinkState(
  item: Pick<NotePageEvidence, "current" | "sourceAvailable">
): "open" | "earlierVersion" | "preserved" {
  if (!item.sourceAvailable) return "preserved";
  return item.current ? "open" : "earlierVersion";
}

export interface RelationSentence {
  key: "notePage.card.sentence" | "notePage.card.undirected";
  subject: "this" | "other";
  object: "this" | "other";
  verbKey: MessageKey;
  wordKey: MessageKey;
  /** Only a directed type whose direction was decided states it. */
  directionConfirmed: boolean;
}

/** How the card says the relation: never invents a direction the decider did not give. */
export function relationSentence(
  relation: Pick<NotePageRelation, "type" | "direction">
): RelationSentence {
  const view = relationTypeView(relation.type);
  const base = { verbKey: view.verbKey, wordKey: view.wordKey };
  if (!view.directed)
    return {
      ...base,
      key: "notePage.card.sentence",
      subject: "this",
      object: "other",
      directionConfirmed: false
    };
  if (relation.direction === "unknown")
    return {
      ...base,
      key: "notePage.card.undirected",
      subject: "this",
      object: "other",
      directionConfirmed: false
    };
  const outgoing = relation.direction === "outgoing";
  return {
    ...base,
    key: "notePage.card.sentence",
    subject: outgoing ? "this" : "other",
    object: outgoing ? "other" : "this",
    directionConfirmed: true
  };
}

/**
 * Splits a translated template on the `{name}` tokens the translator left in place and puts React
 * nodes there, so emphasised parts are elements, never HTML. Unknown tokens stay as text.
 */
export function interpolateNodes(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  const parts = template.split(/(\{[a-zA-Z]+\})/);
  return parts
    .filter((part) => part !== "")
    .map((part, index) => {
      const name = /^\{([a-zA-Z]+)\}$/.exec(part)?.[1];
      const node = name !== undefined && name in nodes ? nodes[name] : part;
      return createElement(Fragment, { key: index }, node);
    });
}

export type NoteRefSegment = string | { ref: "this" | "other" | "unknown" };

/** Canonical `<note-ref id="..." />` tags resolved by ID: this note, the other note or inert. */
export function noteRefSegments(
  text: string,
  ids: { thisId: string; otherId: string }
): NoteRefSegment[] {
  const segments: NoteRefSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(/<note-ref\s+id="([^"]*)"\s*\/>/g)) {
    if (match.index > last) segments.push(text.slice(last, match.index));
    const id = match[1]!.toLowerCase();
    segments.push({
      ref:
        id === ids.thisId.toLowerCase()
          ? "this"
          : id === ids.otherId.toLowerCase()
            ? "other"
            : "unknown"
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push(text.slice(last));
  return segments;
}

export interface CardContent {
  thisPassage: {
    sourceTitle: string;
    chunkIndex: number | null;
    excerpt: string;
    language: string | null;
  } | null;
  otherPassage:
    (NonNullable<NotePageRelation["other"]["passage"]> & { sourceTitle: string }) | null;
  explanation: NotePageRelationExplanation | null;
  decidedBy: string | null;
}

/**
 * What the evidence card of a relation shows. Every relation has a card: when no explanation is
 * stored, a card that stays open asks for one (docs/plan.md decision 16).
 */
export function cardContent(
  relation: NotePageRelation,
  thisPrimary: NotePageEvidence | null
): CardContent {
  return {
    thisPassage: thisPrimary
      ? {
          sourceTitle: thisPrimary.sourceTitle,
          chunkIndex: thisPrimary.chunkIndex,
          excerpt: thisPrimary.excerpt,
          language: thisPrimary.language
        }
      : null,
    otherPassage: relation.other.passage
      ? { ...relation.other.passage, sourceTitle: relation.other.sourceTitle }
      : null,
    explanation: relation.explanation,
    decidedBy: relation.decidedBy
  };
}

/**
 * The explanation of an open card while it is being written, why it could not be, or that the
 * relation can no longer be explained (it, or one of its notes, is no longer current).
 */
export type ExplanationState =
  | { status: "writing" }
  | { status: "unavailable" }
  | { status: "failed"; kind: "noModel" | "failed" };

/** Whether a card asks for an explanation: none is stored and the relation was not found gone. */
export function asksForExplanation(
  relation: Pick<NotePageRelation, "explanation"> | undefined,
  state: ExplanationState | undefined
): boolean {
  return relation !== undefined && relation.explanation === null && state?.status !== "unavailable";
}

/**
 * What the card holds once the request answered: nothing when the explanation was written (the
 * relation carries it), a terminal "unavailable" when there was nothing to explain.
 */
export function explanationAfter(result: { text: string } | null): ExplanationState | null {
  return result ? null : { status: "unavailable" };
}

/** A stale write token shows as a conflict; everything else is a plain failure. */
export function reviewErrorKind(error: unknown): "conflict" | "failed" {
  return String(error).includes("sourceWorkspace.conflict") ? "conflict" : "failed";
}

/** Why an explanation could not be written: no writer model, or anything else. */
export function explanationErrorKind(error: unknown): "noModel" | "failed" {
  return String(error).includes("errors.ai.noCompatibleModel") ? "noModel" : "failed";
}

export interface NoteDraft {
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
}

/** The changed, trimmed fields; `"invalid"` when a field is blank; `null` when nothing changed. */
export function editChanges(
  note: Pick<NotePageNote, "title" | "ideaStatement" | "bodyMarkdown">,
  draft: NoteDraft
): Partial<NoteDraft> | "invalid" | null {
  const next = {
    title: draft.title.trim(),
    ideaStatement: draft.ideaStatement.trim(),
    bodyMarkdown: draft.bodyMarkdown.trim()
  };
  if (!next.title || !next.ideaStatement || !next.bodyMarkdown) return "invalid";
  const changes: Partial<NoteDraft> = {};
  if (next.title !== note.title.trim()) changes.title = next.title;
  if (next.ideaStatement !== note.ideaStatement.trim()) changes.ideaStatement = next.ideaStatement;
  if (next.bodyMarkdown !== note.bodyMarkdown.trim()) changes.bodyMarkdown = next.bodyMarkdown;
  return Object.keys(changes).length > 0 ? changes : null;
}

/** The version an edit started from: its fields and its write token. */
export type NoteEditBase = NoteDraft & { updatedAt: string };

export function editBase(
  note: Pick<NotePageNote, "title" | "ideaStatement" | "bodyMarkdown" | "updatedAt">
): NoteEditBase {
  return {
    title: note.title,
    ideaStatement: note.ideaStatement,
    bodyMarkdown: note.bodyMarkdown,
    updatedAt: note.updatedAt
  };
}

/**
 * The edit to send: the fields changed since the version the draft started from, with that
 * version's write token, so a note changed meanwhile is a conflict, never silently overwritten.
 */
export function editRequest(
  noteId: string,
  edit: { base: NoteEditBase; draft: NoteDraft }
): ({ id: string; action: "edit"; expectedUpdatedAt: string } & Partial<NoteDraft>) | null {
  const changes = editChanges(edit.base, edit.draft);
  if (changes === null || changes === "invalid") return null;
  return { id: noteId, action: "edit", expectedUpdatedAt: edit.base.updatedAt, ...changes };
}

/** Whether the draft still equals the note: Escape cancels only a pristine edit. */
export function isPristineDraft(
  note: Pick<NotePageNote, "title" | "ideaStatement" | "bodyMarkdown">,
  draft: NoteDraft
): boolean {
  return (
    draft.title === note.title &&
    draft.ideaStatement === note.ideaStatement &&
    draft.bodyMarkdown === note.bodyMarkdown
  );
}

/** Whether leaving the page now would lose typed text: an open edit that is not pristine. */
export function hasUnsavedEdit(edit: { base: NoteDraft; draft: NoteDraft } | null): boolean {
  return edit !== null && !isPristineDraft(edit.base, edit.draft);
}

/**
 * A history listener (Back, Forward, Cmd-[ and Cmd-], mouse buttons) that holds the move while an
 * unsaved edit is open and asks instead; with nothing unsaved it lets the move through.
 */
export function unsavedEditNavigationGuard(
  hasUnsaved: () => boolean,
  ask: (direction: NavigationDirection) => void
): (direction: NavigationDirection) => boolean {
  return (direction) => {
    if (!hasUnsaved()) return false;
    ask(direction);
    return true;
  };
}

/**
 * The next text of the polite live region. It speaks only when its text changes, so the same
 * outcome twice in a row alternates a trailing no-break space and is announced again.
 */
export function nextAnnouncement(previous: string, text: string): string {
  return previous === text ? `${text}\u00a0` : text;
}

/**
 * Relations asked for when the page is read again: as many rows as are shown, within the page
 * size the schema allows. Rows shown past it are kept by `keepShownRelations`.
 */
export function refreshRelationLimit(shown: number): number {
  return Math.min(Math.max(shown, notePageLimits.relationPage), notePageLimits.relationPageMax);
}

/**
 * The page read again, keeping the rows that were shown past its first page ("Show more"), so a
 * refresh never shortens the list. The refreshed rows and total win; kept rows are not re-read.
 */
export function keepShownRelations(shown: NotePage | null, refreshed: NotePage): NotePage {
  const fresh = refreshed.relations.items;
  if (!shown || shown.relations.items.length <= fresh.length) return refreshed;
  const known = new Set(fresh.map((item) => item.id));
  const tail = shown.relations.items.slice(fresh.length).filter((item) => !known.has(item.id));
  return { ...refreshed, relations: { ...refreshed.relations, items: [...fresh, ...tail] } };
}
