import { Fragment, createElement, type ReactNode } from "react";
import type {
  NotePage,
  NotePageEvidence,
  NotePageNote,
  NotePageRelation,
  NotePageRelationExplanation
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { relationTypeView } from "../../lib/relation-stance";

/** Hover timing of the relation evidence card. */
export const notePageTiming = { cardOpenDelayMs: 300, cardCloseDelayMs: 150 } as const;

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
 * stored, opening the card asks for one (docs/plan.md decision 16).
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

/** Relations asked for when the page is read again: the rows already shown stay on screen. */
export function refreshRelationLimit(shown: number): number {
  return Math.min(Math.max(shown, 20), 50);
}
