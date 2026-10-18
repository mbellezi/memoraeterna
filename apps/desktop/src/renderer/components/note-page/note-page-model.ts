import { Fragment, createElement, type ReactNode } from "react";
import {
  notePageLimits,
  relationBandWord,
  type NotePage,
  type NotePageActor,
  type NotePageEvidence,
  type NotePageNote,
  type NotePageRelation,
  type NotePageRelationExplanation,
  type NotePageRelations
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
  /** Who gave the direction a directed type states; null when it states none (decision 31b). */
  directionKey: MessageKey | null;
}

/** Whether a relation of a directed type is only linked: nobody gave it a direction (decision 31b). */
export function isLinkedOnly(relation: Pick<NotePageRelation, "type" | "direction">): boolean {
  return relationTypeView(relation.type).directed && relation.direction === "unknown";
}

/**
 * How the card says the relation: never invents a direction nobody gave. A directed type states
 * "A extends B" only when the owner or the decider chose the direction (or a legacy row was decided
 * with one); otherwise the notes are "linked" by that type.
 */
export function relationSentence(
  relation: Pick<NotePageRelation, "type" | "direction" | "directionSource">
): RelationSentence {
  const view = relationTypeView(relation.type);
  const base = { verbKey: view.verbKey, wordKey: view.wordKey };
  if (!view.directed)
    return {
      ...base,
      key: "notePage.card.sentence",
      subject: "this",
      object: "other",
      directionKey: null
    };
  if (relation.direction === "unknown")
    return {
      ...base,
      key: "notePage.card.undirected",
      subject: "this",
      object: "other",
      directionKey: null
    };
  const outgoing = relation.direction === "outgoing";
  return {
    ...base,
    key: "notePage.card.sentence",
    subject: outgoing ? "this" : "other",
    object: outgoing ? "other" : "this",
    directionKey:
      relation.directionSource === "owner"
        ? "notePage.card.directionOwner"
        : relation.directionSource === "decider"
          ? "notePage.card.directionDecider"
          : "notePage.card.directionConfirmed"
  };
}

/** The owner's choice of direction on Keep (decision 31b). */
export type DirectionChoice = "none" | "thisToOther" | "otherToThis";

/** The choice a card opens on: the direction already shown, else none (the default). */
export function initialDirectionChoice(direction: NotePageRelation["direction"]): DirectionChoice {
  return direction === "outgoing"
    ? "thisToOther"
    : direction === "incoming"
      ? "otherToThis"
      : "none";
}

/** What a Keep carries of the owner's direction: the choice, and its subject note for the request. */
export interface ReviewDirection {
  choice: DirectionChoice;
  subjectNoteId: string | null;
}

/** The note that is the subject of a choice (`null`: no direction), as the review request names it. */
export function subjectOfDirectionChoice(
  choice: DirectionChoice,
  ids: { thisId: string; otherId: string }
): string | null {
  return choice === "none" ? null : choice === "thisToOther" ? ids.thisId : ids.otherId;
}

/** The direction a choice gives the relation on this page, as the page reads it. */
export function directionOfChoice(choice: DirectionChoice): NotePageRelation["direction"] {
  return choice === "thisToOther" ? "outgoing" : choice === "otherToThis" ? "incoming" : "unknown";
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
  /** Who decided, typed and explained the relation, for the steps that are known. */
  provenance: ProvenanceLine[];
}

/** One step of a relation and the model that did it (D42: the decider, the typer and the writer). */
export interface ProvenanceLine {
  role: "decided" | "typed" | "explained";
  actor: NotePageActor;
}

/** The known steps of a relation, in the order they happen; an unknown step has no line. */
export function provenanceLines(
  relation: Pick<NotePageRelation, "decidedBy" | "typedBy" | "explainedBy">
): ProvenanceLine[] {
  const lines: ProvenanceLine[] = [];
  if (relation.decidedBy) lines.push({ role: "decided", actor: relation.decidedBy });
  if (relation.typedBy) lines.push({ role: "typed", actor: relation.typedBy });
  if (relation.explainedBy) lines.push({ role: "explained", actor: relation.explainedBy });
  return lines;
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
    provenance: provenanceLines(relation)
  };
}

/**
 * The band word a relation shows (D42): "Strong", "Possible" or "Not calibrated", never a
 * percentage. Nothing is shown for a legacy row, a kept relation or a withdrawn one, and a library
 * whose automatic relations are all suggestions never shows "Strong".
 */
export function bandWordKey(
  relation: Pick<NotePageRelation, "band" | "calibration" | "state">
): MessageKey | null {
  const word = relationBandWord(relation);
  return word === null ? null : (`notePage.band.${word}` as const);
}

/** The state chip of a relation: the ones the owner has to know about; an applied one has none. */
export function relationStateKey(state: NotePageRelation["state"]): MessageKey | null {
  return state === "applied" ? null : (`notePage.state.${state}` as const);
}

/**
 * Whether the card offers Keep and Remove (F3 D15): on a suggested relation and on a withdrawn one,
 * including the relation the writer withdrew a moment ago, whose row still says why it is hidden. A
 * kept relation is final, and an applied one has no review here.
 */
export function offersReview(
  relation: Pick<NotePageRelation, "state">,
  explanation: { status: string } | null | undefined
): boolean {
  return (
    relation.state === "suggested" ||
    relation.state === "withdrawn" ||
    explanation?.status === "vetoed"
  );
}

/** A verdict being saved, or one that could not be saved. */
export type ReviewState = { status: "pending" } | { status: "failed" };

/**
 * The explanation of an open card while it is being written (with the text streamed so far), why
 * it could not be, that the writer found the notes unrelated and the relation is hidden (F3 D22),
 * that it found them unrelated but the relation stays (no explanation is available), or that the
 * relation can no longer be explained (it, or one of its notes, is no longer current).
 */
export type ExplanationState =
  | { status: "writing" }
  | { status: "streaming"; text: string }
  | { status: "vetoed" }
  | { status: "unexplained" }
  | { status: "unavailable" }
  | { status: "failed"; kind: "noModel" | "failed" };

/**
 * Whether a card asks for an explanation: none is stored and the relation was not found gone,
 * withdrawn or left unexplained.
 */
export function asksForExplanation(
  relation: Pick<NotePageRelation, "explanation"> | undefined,
  state: ExplanationState | undefined
): boolean {
  return (
    relation !== undefined &&
    relation.explanation === null &&
    state?.status !== "unavailable" &&
    state?.status !== "vetoed" &&
    state?.status !== "unexplained"
  );
}

/**
 * What the card holds once the request answered: nothing when the explanation was written (the
 * relation carries it), "vetoed" when the writer found the notes unrelated and the relation was
 * withdrawn, "unexplained" when it found them unrelated and the relation stays, a terminal
 * "unavailable" when there was nothing to explain.
 */
export function explanationAfter(
  result: { text: string } | { vetoed: true } | { unrelated: true } | null
): ExplanationState | null {
  if (result === null) return { status: "unavailable" };
  if ("vetoed" in result) return { status: "vetoed" };
  return "unrelated" in result ? { status: "unexplained" } : null;
}

/**
 * The card after a piece of the streamed text: the text so far, or back to writing when the text
 * shown is void (empty). A piece that arrives once the request ended changes nothing.
 */
export function explanationStreamed(
  state: ExplanationState | undefined,
  text: string
): ExplanationState | undefined {
  if (state?.status !== "writing" && state?.status !== "streaming") return state;
  return text === "" ? { status: "writing" } : { status: "streaming", text };
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
 * Whether opening a "Where is this" target leaves the Note page mounted underneath: a topic opens in
 * the Wiki over the Library, so an unsaved edit survives and nothing has to ask first. Every other
 * target replaces the page and asks when an edit would be lost.
 */
export function keepsNotePageMounted(navigation: { type: string }): boolean {
  return navigation.type === "topic";
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
 * The page with its place in the topic tree read again (the tree changed, or the note was placed
 * by hand). It is the same page when the place did not change, so nothing redraws for nothing.
 */
export function withPlacement(page: NotePage, placement: NotePage["placement"]): NotePage {
  return JSON.stringify(page.placement) === JSON.stringify(placement)
    ? page
    : { ...page, placement };
}

/** The page's three lists of relations: the group each one holds and the field it is held in. */
export const relationLists = [
  { group: "shown", list: "relations" },
  { group: "withdrawn", list: "withdrawn" },
  { group: "earlier", list: "earlierVersions" }
] as const;
export type RelationList = (typeof relationLists)[number]["list"];
export type RelationGroup = (typeof relationLists)[number]["group"];

/** The field of the page a group of relations is held in. */
export function listOf(group: RelationGroup): RelationList {
  return relationLists.find((entry) => entry.group === group)!.list;
}

/** The group a field of the page holds. */
export function groupOf(list: RelationList): RelationGroup {
  return relationLists.find((entry) => entry.list === list)!.group;
}

/**
 * The page with the explanation that was just written on the relation, wherever it is listed. The
 * answer names the model, not where it ran: that is read with the page again.
 */
export function withWrittenExplanation(
  page: NotePage,
  relationId: string,
  explanation: { text: string; writtenBy: string }
): NotePage {
  let next = page;
  for (const { list } of relationLists) {
    if (!page[list].items.some((item) => item.id === relationId)) continue;
    next = {
      ...next,
      [list]: {
        ...page[list],
        items: page[list].items.map((item) =>
          item.id === relationId
            ? {
                ...item,
                explanation,
                explainedBy: { model: explanation.writtenBy, kind: item.explainedBy?.kind ?? null }
              }
            : item
        )
      }
    };
  }
  return next;
}

/**
 * One list read again, keeping the rows that were shown past its first page ("Show more"), so a
 * refresh never shortens it. The refreshed rows and total win; kept rows are not re-read, except
 * those in `dropped` (relations the writer withdrew, which the server no longer lists there).
 */
function keepShownList(
  shown: NotePageRelations,
  fresh: NotePageRelations,
  dropped: ReadonlySet<string>
): NotePageRelations {
  if (shown.items.length <= fresh.items.length) return fresh;
  const known = new Set(fresh.items.map((item) => item.id));
  const tail = shown.items
    .slice(fresh.items.length)
    .filter((item) => !known.has(item.id) && !dropped.has(item.id));
  return { ...fresh, items: [...fresh.items, ...tail] };
}

/**
 * The page read again, keeping the rows of each list that were shown past its first page, so a
 * refresh never shortens a list. The refreshed rows and totals win.
 */
export function keepShownRelations(
  shown: NotePage | null,
  refreshed: NotePage,
  dropped: ReadonlySet<string> = new Set()
): NotePage {
  if (!shown) return refreshed;
  let next = refreshed;
  for (const { list } of relationLists) {
    // A row is in one list: the refreshed rows of another list say a kept row has moved there.
    const elsewhere = relationLists.flatMap((other) =>
      other.list === list ? [] : refreshed[other.list].items.map((item) => item.id)
    );
    const kept = keepShownList(shown[list], refreshed[list], new Set([...dropped, ...elsewhere]));
    if (kept !== refreshed[list]) next = { ...next, [list]: kept };
  }
  return next;
}

/** The list a relation is in on the page, and the ID order of that list; null when it is in none. */
export function locateRelation(
  page: NotePage,
  relationId: string
): { list: RelationList; ids: string[] } | null {
  for (const { list } of relationLists) {
    const ids = page[list].items.map((item) => item.id);
    if (ids.includes(relationId)) return { list, ids };
  }
  return null;
}

/**
 * Where focus goes when a row leaves its list: the row that takes its place, else the one before
 * it; null when the list is empty then, and the caller falls back to the heading of the list.
 */
export function focusAfterRemoval(ids: readonly string[], removedId: string): string | null {
  const index = ids.indexOf(removedId);
  if (index === -1) return null;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}

/**
 * The page after the owner's verdict on a relation, before it is read again: a removed relation
 * leaves its list and the total; a kept one says so, and a kept withdrawn one moves to the shown
 * list (last when that list is fully loaded: the order is the server's, which the next read
 * restores). The same page when the
 * relation is not on it.
 */
export function withReviewed(
  page: NotePage,
  relationId: string,
  outcome: "kept" | "removed",
  choice?: DirectionChoice
): NotePage {
  const found = locateRelation(page, relationId);
  if (!found) return page;
  const from = page[found.list];
  const item = from.items.find((candidate) => candidate.id === relationId)!;
  const left: NotePageRelations = {
    items: from.items.filter((candidate) => candidate.id !== relationId),
    total: Math.max(0, from.total - 1)
  };
  if (outcome === "removed") return { ...page, [found.list]: left };
  // The owner's choice of direction (decision 31b), when the card offered one.
  const given =
    choice === undefined
      ? {}
      : {
          direction: directionOfChoice(choice),
          directionSource: choice === "none" ? null : ("owner" as const)
        };
  const kept: NotePageRelation = { ...item, ...given, state: "kept", vetoSource: null };
  if (found.list === "relations")
    return {
      ...page,
      relations: {
        ...from,
        items: from.items.map((candidate) => (candidate.id === relationId ? kept : candidate))
      }
    };
  // The row joins the shown list only when that list is fully loaded. A list read in part gets it
  // at the place the server sorts it, on the next read: appended here it would shift the offset
  // "Show more" asks for, and one row of the server's list would be skipped.
  const loaded = page.relations.items.length >= page.relations.total;
  return {
    ...page,
    [found.list]: left,
    relations: {
      items: loaded ? [...page.relations.items, kept] : page.relations.items,
      total: page.relations.total + 1
    }
  };
}

/**
 * The page with the relations an explanation withdrew moved out of the shown list into the
 * withdrawn one (the row stays in the withdrawn list when that list is fully loaded), after their
 * cards closed. The total of the shown list counts the rows that are still listed, so a row leaves
 * it once, and the withdrawn total counts the new row once.
 */
export function withWithdrawn(page: NotePage, ids: ReadonlySet<string>): NotePage {
  const leaving = page.relations.items.filter((item) => ids.has(item.id));
  if (leaving.length === 0) return page;
  const items = page.relations.items.filter((item) => !ids.has(item.id));
  const total = Math.max(items.length, page.relations.total - leaving.length);
  const loaded = page.withdrawn.items.length >= page.withdrawn.total;
  const moved: NotePageRelation[] = leaving.map((item) => ({
    ...item,
    state: "withdrawn",
    vetoSource: item.vetoSource ?? "explainer"
  }));
  const known = new Set(page.withdrawn.items.map((item) => item.id));
  return {
    ...page,
    relations: { items, total },
    withdrawn: {
      items: loaded
        ? [...page.withdrawn.items, ...moved.filter((item) => !known.has(item.id))]
        : page.withdrawn.items,
      total: page.withdrawn.total + moved.filter((item) => !known.has(item.id)).length
    }
  };
}
