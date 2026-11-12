import type { AskScope, ObjectKind, ObjectLocateResult } from "@app/domain";

import type { LibrarySourceProgress } from "../../../shared/ipc-library";
import type { QuestionListItemView } from "../../../shared/ipc-questions";
import { ribbonSegments } from "../PathRibbon";

/**
 * What the Perguntar tab asks about (design record §5.6, §20.1 row 17; D14). Only D14's three scopes
 * exist (the whole library, one topic, chosen sources), so each kind of object maps to one of them
 * and the tab always writes which: a topic asks that topic; a source asks that source; a note asks
 * the topic it is in (its primary place), or the library when it has none; an entity and a question
 * ask the library. Pure, so every mapping is tested without a renderer.
 */

/** Which words the tab's heading and description use. */
export type AskVariant = "source" | "topic" | "note" | "noteUnplaced" | "entity" | "library";

export interface AskTarget {
  variant: AskVariant;
  /** The scope `questions.ask` takes. */
  scope: AskScope;
  /** The topic a note asks (its primary place): its title, empty while the topic has no name. */
  topicTitle: string | null;
}

/** The deepest topic above a placed note or source: its primary place, or null when it has none. */
export function primaryTopic(
  located: ObjectLocateResult | null
): { id: string; title: string } | null {
  if (!located) return null;
  const segment = ribbonSegments(located).at(-1);
  return segment ? { id: segment.id, title: segment.title } : null;
}

/**
 * The target of an object. A note needs where it is first: `primary` is `undefined` while that is
 * being read (the tab waits, since a scope it cannot write is a scope it must not guess), `null`
 * when the note has no place, and the topic otherwise.
 */
export function askTarget(
  kind: ObjectKind,
  id: string,
  primary: { id: string; title: string } | null | undefined
): AskTarget | null {
  switch (kind) {
    case "source":
      return {
        variant: "source",
        scope: { kind: "sources", sourceIds: [id] },
        topicTitle: null
      };
    case "topic":
      return { variant: "topic", scope: { kind: "topic", topicId: id }, topicTitle: null };
    case "note":
      if (primary === undefined) return null;
      return primary === null
        ? { variant: "noteUnplaced", scope: { kind: "library" }, topicTitle: null }
        : {
            variant: "note",
            scope: { kind: "topic", topicId: primary.id },
            topicTitle: primary.title
          };
    case "entity":
      return { variant: "entity", scope: { kind: "library" }, topicTitle: null };
    case "question":
      return { variant: "library", scope: { kind: "library" }, topicTitle: null };
  }
}

/** Whether two stored scopes ask about the same thing (the sources compare as sets). */
export function sameScope(a: AskScope, b: AskScope): boolean {
  if (a.kind === "library") return b.kind === "library";
  if (a.kind === "topic") return b.kind === "topic" && a.topicId === b.topicId;
  if (b.kind !== "sources") return false;
  const ids = new Set(a.sourceIds);
  return ids.size === b.sourceIds.length && b.sourceIds.every((value) => ids.has(value));
}

/** How many earlier questions the tab lists. */
export const earlierLimit = 5;

/** The questions already asked of this scope, in the order they came (newest first). */
export function earlierQuestions(
  items: readonly QuestionListItemView[],
  scope: AskScope
): QuestionListItemView[] {
  return items.filter((item) => sameScope(item.scope, scope)).slice(0, earlierLimit);
}

/** What the milestone line of a source says: its passages are searchable, or not yet. */
export type IndexedLine =
  { kind: "indexed"; count: number; arriving: boolean } | { kind: "indexing" };

/**
 * "You can already ask: the 142 passages are indexed. The notes are still arriving." A source asks
 * the passages the moment they are indexed, before any note exists; while they are not, the line
 * says so. Nothing is said when the read found no source or no passages and nothing is running.
 */
export function indexedLine(progress: LibrarySourceProgress): IndexedLine | null {
  if (!progress) return null;
  const running = progress.run?.status === "running" || progress.run?.status === "pending";
  const { chunks, notes } = progress.steps;
  if (chunks.indexed > 0)
    return {
      kind: "indexed",
      count: chunks.indexed,
      arriving: running && notes.state !== "done" && notes.state !== "notApplicable"
    };
  return running && chunks.state !== "done" ? { kind: "indexing" } : null;
}

/** The tab's state: one failure at a time (the scope, then the send, then the earlier list). */
export function askTabState(input: {
  scope: "loading" | "error" | "ready";
  sendFailed: boolean;
  earlier: "loading" | "error" | "ready";
  earlierCount: number;
}): "loading" | "empty" | "error" | "success" {
  if (input.scope === "error" || input.sendFailed) return "error";
  if (input.scope === "loading") return "loading";
  if (input.earlier === "error") return "error";
  if (input.earlier === "loading") return "loading";
  return input.earlierCount === 0 ? "empty" : "success";
}
