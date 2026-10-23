// The titles of the relation passes the Gardener leaves as change-sets (F4 D10, spec 3.4): a link
// job's run says what it did in the owner's words, as a message key with scalar parameters that the
// renderer translates ("Connections checked for “{note}”", "{n} connections suggested for
// “{source}”"). The copy lives in the `changes.titles` namespace (T77); this module only chooses
// the key and the parameters, so it is pure and has no database.
import type { JsonObject } from "@app/db";

export const relationMatchedTitleKey = "changes.titles.relationMatched";
export const relationSuggestedTitleKey = "changes.titles.relationSuggested";

/** Where MATCH tells a link job which notes it carries the decisions of (their titles). */
export const matchedNotesPayloadKey = "matched";

/** A title in a parameter is clipped; the read model bounds it again by the contract's UTF-16 units. */
const titleParamCharacters = 120;

export interface MatchedNote {
  noteId: string;
  title: string;
}

const clip = (text: string) => [...text].slice(0, titleParamCharacters).join("");

/** The notes a link job's payload says MATCH decided for it; entries that do not parse are left out. */
export function matchedNotesOf(payload: JsonObject): MatchedNote[] {
  const entries: unknown = payload[matchedNotesPayloadKey];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { noteId, title } = entry as Record<string, unknown>;
    return typeof noteId === "string" && noteId && typeof title === "string"
      ? [{ noteId, title: clip(title) }]
      : [];
  });
}

/** The matched-notes entry a MATCH task adds to the payload of the link job it queues. */
export function matchedNoteEntry(note: { id: string; title: string }): MatchedNote {
  return { noteId: note.id, title: clip(note.title) };
}

export interface LinkRunTitle {
  titleKey: string;
  titleParams: JsonObject;
}

/**
 * The title of a link run. A run that persisted what MATCH decided for one edited or accepted note
 * (a link job with no parked ingestion run) is "Connections checked for the note"; any other run
 * that suggested connections and applied none is "n connections suggested for the source"; the rest
 * keep the default title of their kind. `rootTitle` is read only when this needs it.
 */
export async function linkRunTitle(input: {
  matched: readonly MatchedNote[];
  counts: { applied: number; suggested: number };
  rootTitle: () => Promise<string | null>;
}): Promise<LinkRunTitle | null> {
  const [only] = input.matched;
  if (input.matched.length === 1 && only)
    return { titleKey: relationMatchedTitleKey, titleParams: { note: only.title } };
  if (input.counts.suggested > 0 && input.counts.applied === 0) {
    const source = await input.rootTitle();
    if (source)
      return {
        titleKey: relationSuggestedTitleKey,
        titleParams: { n: input.counts.suggested, source: clip(source) }
      };
  }
  return null;
}
