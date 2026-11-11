import {
  formatObjectAddress,
  parseObjectAddress,
  type ObjectKind,
  type ObjectRef,
  type ObjectResolved
} from "@app/domain";
import type { MessageKey } from "@app/i18n";

/**
 * What an object link, its hover card and quick-look say about an object, as plain functions over
 * `objects.resolveMany`'s answer (design record §10): the counts that suit the kind, the place
 * above it, how its address is anchored, and the state the card or the sheet is in.
 */

/** The anchors that carry text of their own: the card shows that text as "Trecho". */
export function anchorsPassage(address: string): boolean {
  const anchor = parseObjectAddress(address)?.anchor;
  return anchor?.passage !== undefined || anchor?.span !== undefined;
}

/** A link into a relation: its card says where the other end sits ("Vai para <path>"). */
export function isRelationLink(address: string): boolean {
  return parseObjectAddress(address)?.anchor?.relation !== undefined;
}

/** The address without its anchor: what the object itself is. */
export function objectOfAddress(address: string): string {
  const parsed = parseObjectAddress(address);
  return parsed ? formatObjectAddress({ kind: parsed.kind, id: parsed.id }) : address;
}

/** One count of the card's line: the message pair and the number. */
export interface PreviewCount {
  /** `preview.counts.<name>`; the line picks `.one` or `.other`. */
  name: "answers" | "items" | "notes" | "passages" | "sources" | "subtopics";
  count: number;
}

/**
 * The counts that suit the kind, in reading order, without the zeros that say nothing. A topic's
 * `notes` is `topic_stats.n`, the items placed under it (a source counts, a note still waiting for
 * its vector does not), so it is worded as items in the topic, never as an exact note count.
 */
export function previewCounts(item: Pick<ObjectResolved, "kind" | "counts">): PreviewCount[] {
  const counts = item.counts ?? {};
  const pick = (name: PreviewCount["name"], key: string): PreviewCount[] => {
    const value = counts[key];
    return value !== undefined && value > 0 ? [{ name, count: value }] : [];
  };
  switch (item.kind) {
    case "source":
      return [...pick("notes", "notes"), ...pick("passages", "passages")];
    case "note":
      return pick("sources", "sources");
    case "topic":
      return [...pick("items", "notes"), ...pick("subtopics", "children")];
    case "entity":
      return pick("notes", "notes");
    case "question":
      return pick("answers", "answers");
  }
}

/** The message key of one count (`one` for exactly 1, else `other`). */
export function countKey(entry: PreviewCount): MessageKey {
  return `preview.counts.${entry.name}.${entry.count === 1 ? "one" : "other"}` as MessageKey;
}

/** The topics above an object, root first; an untitled one is `""` and the caller words it. */
export function placeOf(item: Pick<ObjectResolved, "path">): ObjectRef[] {
  return (item.path ?? []).filter((ref) => ref.kind === "topic");
}

/** What the card and the sheet are in. */
export type PreviewState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; item: ObjectResolved };

export type SurfaceState = "loading" | "empty" | "error" | "success";

/**
 * The four states of the surface (D1): loading until the read answers, error when it failed, empty
 * when there is nothing to show (no object at that address, or one with no text yet), else success.
 */
export function surfaceState(state: PreviewState): SurfaceState {
  switch (state.status) {
    case "loading":
      return "loading";
    case "error":
      return "error";
    case "missing":
      return "empty";
    case "ready":
      return state.item.preview.trim() === "" ? "empty" : "success";
  }
}

/** The title to show: the object's own, or the kind's word for an object with none yet. */
export function titleOf(item: Pick<ObjectResolved, "title">, fallback: string): string {
  return item.title.trim() === "" ? fallback : item.title;
}

export const kindWordKeys: Record<ObjectKind, MessageKey> = {
  source: "objects.kinds.source",
  note: "objects.kinds.note",
  topic: "objects.kinds.topic",
  question: "objects.kinds.question",
  entity: "objects.kinds.entity"
};

// ---------------------------------------------------------------------------------------------
// Markdown: `[text](memora://<kind>/<uuid>[#anchor])` is an object link.

const idSource = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const anchorSource = `[a-z]+=${idSource}`;

/** The RegExp source of one object link in Markdown, for the renderer's inline splitter. */
export const markdownObjectLinkSource = String.raw`\[[^\]]+\]\(memora:\/\/(?:source|note|topic|question|entity)\/${idSource}(?:#${anchorSource}(?:&${anchorSource})*)?\)`;

const markdownObjectLink = new RegExp(`^\\[([^\\]]+)\\]\\((memora://[^)]+)\\)$`);

/**
 * The label and the canonical address of a Markdown object link, or null when the token is not one
 * or its address is not valid (the renderer then writes the label as plain text, never a dead link).
 */
export function parseMarkdownObjectLink(token: string): { label: string; address: string } | null {
  const match = markdownObjectLink.exec(token);
  const parsed = match?.[2] ? parseObjectAddress(match[2]) : null;
  if (!match?.[1] || !parsed) return null;
  return { label: match[1], address: formatObjectAddress(parsed) };
}
