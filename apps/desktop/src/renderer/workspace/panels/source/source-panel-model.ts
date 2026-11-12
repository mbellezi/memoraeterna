import type { ObjectAnchor } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type { SourceDetail } from "../../../../shared/ipc";
import type { PassageAnchor } from "../../../lib/object-navigation";

/**
 * The rules of the Source panel that need no renderer: which tab an address opens, the note rows
 * and where each note rests in the text, and the meta line under the title. Every function is pure;
 * `now` is the instant of the read, so nothing here ticks.
 */

export const sourceTabs = ["overview", "notes", "connections", "content", "details"] as const;
export type SourceTab = (typeof sourceTabs)[number];

/** The notes the Overview lists before "see all"; the Notes tab pages by `notesPageSize`. */
export const overviewNotes = 6;
export const notesPageSize = 30;

/** A note that arrived this recently, while the source is still being made, is "agora mesmo". */
export const freshNoteMs = 2 * 60_000;

/**
 * The tab an address opens (design record 6.2, D10): a relation anchor opens Connections, a passage
 * or a span opens Content, anything else the Overview.
 */
export function tabForAnchor(anchor: ObjectAnchor | undefined): SourceTab {
  if (anchor?.relation) return "connections";
  if (anchor?.passage || anchor?.span) return "content";
  return "overview";
}

/** The passage an address asks to show, or null. A span alone finds its chunk through the span. */
export function passageOf(anchor: ObjectAnchor | undefined): PassageAnchor | null {
  if (!anchor?.passage && !anchor?.span) return null;
  return { chunkId: anchor.passage ?? null, sourceSpanId: anchor.span ?? null, documentId: null };
}

/** Where a note rests in the text: a page when the passage has one, else the passage's number. */
export type NoteSection = { kind: "page"; page: number } | { kind: "passage"; index: number };

export interface NoteRow {
  id: string;
  /** `memora://note/<id>`: what a click opens beside the panel. */
  address: string;
  title: string;
  createdAt: string;
  section: NoteSection | null;
  /** Arrived within `freshNoteMs` of the read while the source was still being made. */
  fresh: boolean;
}

function sectionOf(detail: SourceDetail, chunkId: string): NoteSection | null {
  for (const document of detail.documents) {
    const chunk = document.chunks.find((candidate) => candidate.id === chunkId);
    if (chunk)
      return chunk.page
        ? { kind: "page", page: chunk.page }
        : { kind: "passage", index: chunk.chunkIndex + 1 };
  }
  return null;
}

/** The source's notes, newest first (the order the design lists them while they arrive). */
export function noteRows(detail: SourceDetail, now: number, generating: boolean): NoteRow[] {
  return detail.atomicNotes
    .filter((note) => note.supersessionStatus === "current" && note.status !== "rejected")
    .map((note) => ({
      id: note.id,
      address: `memora://note/${note.id}`,
      title: note.title,
      createdAt: note.createdAt,
      section: sectionOf(detail, note.evidenceChunkId),
      fresh: generating && now - Date.parse(note.createdAt) <= freshNoteMs
    }))
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.id.localeCompare(right.id)
    );
}

/** The note's section as words ("p. 7", "trecho 3"). */
export function sectionWords(section: NoteSection, t: Translator): string {
  return section.kind === "page"
    ? t("sourcePage.notes.page", { values: { page: section.page } })
    : t("sourcePage.notes.passage", { values: { index: section.index } });
}

// ---------------------------------------------------------------------------
// The meta line

const descriptorOf = (detail: SourceDetail): Record<string, unknown> => {
  const descriptor = detail.metadata.descriptor;
  return descriptor && typeof descriptor === "object"
    ? (descriptor as Record<string, unknown>)
    : {};
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : null;

/** The creators' names, as the descriptor holds them. */
function creatorNames(descriptor: Record<string, unknown>): string[] {
  const creators = descriptor.creators;
  if (!Array.isArray(creators)) return [];
  return creators
    .map((creator) =>
      typeof creator === "string"
        ? creator
        : creator && typeof creator === "object" && "name" in creator
          ? String((creator as { name: unknown }).name)
          : ""
    )
    .filter((name) => name.trim() !== "");
}

/** "A e B", "A, B e C", or "A et al." from the fourth name on; a list formatter owns the "e". */
export function creatorsText(names: readonly string[], locale: string, t: Translator): string {
  if (names.length === 0) return "";
  if (names.length > 3) return t("sourcePage.meta.etAl", { values: { name: names[0] ?? "" } });
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

/** The year of a source: the descriptor's `year`, else the first four digits of its publication date. */
function yearOf(descriptor: Record<string, unknown>): string | null {
  const year = text(descriptor.year);
  if (year) return year;
  const date = text(descriptor.publicationDate);
  const match = date ? /^\d{4}/u.exec(date) : null;
  return match ? match[0] : null;
}

/** When the source was added: its oldest stored version. */
export function addedAt(detail: SourceDetail): string | null {
  const times = detail.history.map((entry) => Date.parse(entry.createdAt)).filter(Number.isFinite);
  return times.length === 0 ? null : new Date(Math.min(...times)).toISOString();
}

const sameLocalDay = (left: number, right: number) =>
  new Date(left).toDateString() === new Date(right).toDateString();

/** "adicionada hoje, 09:12", "adicionada ontem, 18:40" or "adicionada em 3 nov". */
export function addedWords(iso: string, now: number, locale: string, t: Translator): string {
  const when = Date.parse(iso);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(when);
  if (sameLocalDay(when, now)) return t("sourcePage.meta.addedToday", { values: { time } });
  if (sameLocalDay(when, now - 24 * 3_600_000))
    return t("sourcePage.meta.addedYesterday", { values: { time } });
  const date = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(when);
  return t("sourcePage.meta.addedOn", { values: { date } });
}

/**
 * The meta line's items, in the design's order: the type, who wrote it (and the year), where it was
 * published, how long it is, when it was added. An item with no data is left out, never guessed.
 */
export function metaItems(detail: SourceDetail, now: number, t: Translator): string[] {
  const descriptor = descriptorOf(detail);
  const items: string[] = [t(`sourcePage.types.${detail.type}` as MessageKey)];
  const who = creatorsText(creatorNames(descriptor), t.locale, t);
  const year = yearOf(descriptor);
  if (who) items.push(year ? `${who} (${year})` : who);
  else if (year) items.push(year);
  const venue = text(descriptor.venue) ?? text(descriptor.siteName) ?? text(descriptor.channel);
  const volume = text(descriptor.volume);
  if (venue)
    items.push(volume ? t("sourcePage.meta.volume", { values: { venue, volume } }) : venue);
  const pages = Number(descriptor.pageCount);
  if (Number.isInteger(pages) && pages > 0)
    items.push(
      t(pages === 1 ? "sourcePage.meta.pagesOne" : "sourcePage.meta.pages", {
        values: { count: pages }
      })
    );
  const added = addedAt(detail);
  if (added) items.push(addedWords(added, now, t.locale, t));
  return items;
}

/** The pieces of a sentence around one token (`{link}` or `{key}`): the text before, the text after. */
export function splitSentence(sentence: string, token: string): [string, string] | null {
  const at = sentence.indexOf(token);
  return at < 0 ? null : [sentence.slice(0, at), sentence.slice(at + token.length)];
}
