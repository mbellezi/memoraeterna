import { relationExplanationLimits, type RelationExplanationDirection } from "@app/domain";

import { joinPrompts, renderPrompt } from "./prompt-runtime.js";

/** Version of the explanation contract stored with every explanation. */
export const relationExplanationPromptVersion = "relation-explanation-v1";

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

/**
 * A valid explanation is plain text of at most `modelCharacters` characters without tags. The notes
 * are named n1 and n2, but every other token is content: N400, N95 or "N2 sleep" are words of the
 * notes, never references. Model output never carries canonical references, so a tag is refused.
 * Returns null when the output is not valid.
 */
export function parseRelationExplanation(output: unknown): string | null {
  if (typeof output !== "string") return null;
  const text = unwrapQuotes(output.trim()).replace(/\s+/g, " ");
  if (!text || text.length > relationExplanationLimits.modelCharacters) return null;
  if (/<\/?[a-z][a-z-]*\b/i.test(text)) return null;
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
