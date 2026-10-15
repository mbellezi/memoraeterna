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

const wrappingQuotes = /^(["'“”«»`]+)([\s\S]*?)(["'“”«»`]+)$/;

/**
 * A valid explanation is plain text of at most `modelCharacters` characters that names the notes
 * only as n1 and n2. Model output never carries canonical references: a tag is refused, and so is
 * any other alias. Returns null when the output is not valid.
 */
export function parseRelationExplanation(output: unknown): string | null {
  if (typeof output !== "string") return null;
  let text = output.trim();
  const quoted = wrappingQuotes.exec(text);
  if (quoted) text = quoted[2]!.trim();
  text = text.replace(/\s+/g, " ");
  if (!text || text.length > relationExplanationLimits.modelCharacters) return null;
  if (/<\/?[a-z][a-z-]*\b/i.test(text)) return null;
  for (const [alias] of text.matchAll(/\b[nN][0-9]+\b/g))
    if (alias !== "n1" && alias !== "n2") return null;
  return text;
}

/** The backend alone turns the aliases into canonical, safe note references. */
export function resolveRelationExplanationReferences(
  text: string,
  ids: { first: string; second: string }
): string {
  return text.replace(/\bn([12])\b/g, (_alias, which: string) =>
    which === "1" ? `<note-ref id="${ids.first}" />` : `<note-ref id="${ids.second}" />`
  );
}
