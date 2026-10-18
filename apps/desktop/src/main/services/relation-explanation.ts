import {
  relationExplanationLimits,
  relationExplanationSentinel,
  type RelationExplanationDirection
} from "@app/domain";

import { joinPrompts, renderPrompt } from "./prompt-runtime.js";

/**
 * Version of the explanation contract stored with every explanation. Revision 3 of the prompt lets
 * the writer answer the sentinel when the notes are not related as stated (F3 D22).
 */
export const relationExplanationPromptVersion = "relation-explanation-v3";

export interface RelationExplanationPromptNote {
  ideaStatement: string;
  /** The note's primary evidence passage, as stored; omitted when its chunk is gone. */
  passage: string | null;
}

/**
 * The explanation prompt sees both notes as n1 and n2 in the order `relationExplanationOrder`
 * chose (a decided subject first, otherwise content order), with the type and direction. Only
 * content reaches the model: never an ID.
 */
export function buildRelationExplanationPrompt(input: {
  type: string;
  direction: RelationExplanationDirection;
  first: RelationExplanationPromptNote;
  second: RelationExplanationPromptNote;
}): string {
  const note = (alias: string, value: RelationExplanationPromptNote) => ({
    note: alias,
    idea: value.ideaStatement,
    ...(value.passage === null ? {} : { passage: value.passage })
  });
  return renderPrompt("relations.explain", {
    relation_type: input.type,
    relation_direction: input.direction,
    max_characters: relationExplanationLimits.modelCharacters,
    relation_notes: [note("n1", input.first), note("n2", input.second)]
  });
}

/** One bounded repair: the first prompt followed by the repair instruction. */
export function buildRelationExplanationRepairPrompt(prompt: string): string {
  return joinPrompts(
    prompt,
    renderPrompt("relations.explain.repair", {
      max_characters: relationExplanationLimits.modelCharacters
    })
  );
}

/** The quotes a model may wrap its whole answer in, by opening character. */
const quotePairs: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "“": "”",
  "‘": "’",
  "„": "“",
  "”": "”",
  "«": "»"
};
const intraWordApostrophe = /(?<=[\p{L}\p{N}])['’](?=[\p{L}\p{N}])/gu;

/**
 * Removes the quotes that wrap the whole answer, and only those: the first and last characters
 * must be a matching pair that appears nowhere inside, so an answer that merely begins and ends
 * with quoted phrases ("Yes" n1 says "yes") keeps its quotes. An apostrophe inside a word is not a
 * quote.
 */
function unwrapQuotes(text: string): string {
  const open = text[0] ?? "";
  const close = quotePairs[open];
  if (close === undefined || text.length < 2 || text.at(-1) !== close) return text;
  const inner = text.slice(1, -1);
  const probe = inner.replace(intraWordApostrophe, "");
  return probe.includes(open) || probe.includes(close) ? text : inner.trim();
}

/** The sentinel with its two words joined by `join` (a regular expression source). */
const spelled = (join: string) => relationExplanationSentinel.replace("_", join);

/** The sentinel as a word of an answer, joined by `_` or `-`: never part of an explanation. */
const sentinelWord = new RegExp(`(?<![\\p{L}\\p{N}_])${spelled("[_-]")}(?![\\p{L}\\p{N}_])`, "iu");

/**
 * The sentinel as a small model may spell it when it is the whole answer: any case, its words
 * joined by underscores, hyphens or spaces ("NOT RELATED", "Not-related").
 */
const sentinelSpelling = new RegExp(`^${spelled("[\\s_-]*")}$`, "iu");

/** The start of an answer that is the sentinel, in any of those spellings. */
const sentinelStart = new RegExp(`^${spelled("[\\s_-]*")}`, "iu");

const leadingMarks = /^[\s"'`*_“‘«„]+/u;
const trailingMarks = /[\s"'`*_”’».!]+$/u;

/** The answer without the quotes, emphasis marks and final full stop that may surround it. */
function withoutMarks(output: string): string {
  return output.trim().replace(leadingMarks, "").replace(trailingMarks, "");
}

/**
 * Whether the whole answer is the sentinel: the writer found the notes not related as stated. Only
 * quotes, backticks, emphasis marks and a final full stop may surround it, and its two words may be
 * joined by a space or a hyphen as well as an underscore; an answer that has more to say is not the
 * sentinel (and is no explanation either, see {@link parseRelationExplanation}).
 */
export function isNotRelatedAnswer(output: unknown): boolean {
  return typeof output === "string" && sentinelSpelling.test(withoutMarks(output));
}

/** The text without the quotes, emphasis marks and space an answer may begin with. */
export function withoutLeadingMarks(text: string): string {
  return text.replace(leadingMarks, "");
}

/**
 * Whether a text begins with the sentinel (marks aside): a streamed answer that does is never shown.
 * Not the same as the whole answer: more may follow.
 */
export function beginsWithSentinel(text: string): boolean {
  return sentinelStart.test(withoutLeadingMarks(text));
}

/** Where the sentinel stands as a word of the text, or -1. */
export function sentinelWordIndex(text: string): number {
  return text.search(sentinelWord);
}

/** A UUID-shaped string: an ID never reaches the prompt, so it is never part of an explanation. */
const idShaped = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/**
 * A valid explanation is plain text of at most `modelCharacters` characters and at least
 * `minModelWords` words, without tags or ID-shaped strings. The notes are named n1 and n2, but
 * every other token is content: N400, N95 or "N2 sleep" are words of the notes, never references.
 * Model output never carries canonical references, so a tag is refused, and so is an answer that
 * mentions the sentinel without being only that, or that is the sentinel spelled another way ("Not
 * related.") or translated ("Não relacionado."): too short to explain anything, it goes to the
 * repair, which can answer the sentinel exactly.
 * Returns null when the output is not valid.
 */
export function parseRelationExplanation(output: unknown): string | null {
  if (typeof output !== "string") return null;
  const text = unwrapQuotes(output.trim()).replace(/\s+/g, " ");
  if (!text || text.length > relationExplanationLimits.modelCharacters) return null;
  if (text.split(" ").length < relationExplanationLimits.minModelWords) return null;
  if (/<\/?[a-z][a-z-]*\b/i.test(text)) return null;
  if (sentinelWord.test(text) || sentinelSpelling.test(withoutMarks(text))) return null;
  if (idShaped.test(text)) return null;
  return text;
}

/**
 * The aliases the prompt defines: exactly the lowercase tokens n1 and n2, standing alone. A longer
 * token (n12, an1, n1_to_n2) or a number (n1.5, n2-3) is content.
 */
const aliasToken = /(?<![\p{L}\p{N}_])n([12])(?![\p{L}\p{N}_])(?![-.]\p{N})/gu;

/** The backend alone turns the aliases into canonical, safe note references. */
export function resolveRelationExplanationReferences(
  text: string,
  ids: { first: string; second: string }
): string {
  return text.replace(aliasToken, (_alias, which: string) =>
    which === "1" ? `<note-ref id="${ids.first}" />` : `<note-ref id="${ids.second}" />`
  );
}

/**
 * The text to store for a model answer, or null when the answer is not valid. The length is checked
 * after the aliases became references, against the bound of the stored column: a reference is far
 * longer than its alias, so an answer short in the model's terms can still be too long to store.
 */
export function acceptRelationExplanation(
  output: unknown,
  ids: { first: string; second: string }
): string | null {
  const text = parseRelationExplanation(output);
  if (text === null) return null;
  const resolved = resolveRelationExplanationReferences(text, ids);
  return resolved.length <= relationExplanationLimits.storedCharacters ? resolved : null;
}
