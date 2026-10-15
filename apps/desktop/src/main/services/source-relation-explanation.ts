import { relationExplanationLimits } from "@app/domain";
import type { SourceRelationExplanationDirection } from "@app/db";

import { joinPrompts, renderPrompt } from "./prompt-runtime.js";
import { parseRelationExplanation } from "./relation-explanation.js";

/** Version of the source explanation contract stored with every explanation. */
export const sourceRelationExplanationPromptVersion = "source-relation-explanation-v1";

export interface SourceRelationExplanationPromptSource {
  title: string;
  /** The source's current evidence passages, in document order. */
  passages: string[];
}

/**
 * The explanation prompt sees the two sources as s1 and s2 in the order the plan chose (the
 * relation's source first for a directed type, otherwise content order), with the type, the
 * direction, their titles and evidence passages. Only content reaches the model: never an ID.
 */
export function buildSourceRelationExplanationPrompt(input: {
  type: string;
  direction: SourceRelationExplanationDirection;
  first: SourceRelationExplanationPromptSource;
  second: SourceRelationExplanationPromptSource;
}): string {
  const source = (alias: string, value: SourceRelationExplanationPromptSource) => ({
    source: alias,
    title: value.title,
    passages: value.passages
  });
  return renderPrompt("relations.sources.explain", {
    relation_type: input.type,
    relation_direction: input.direction,
    max_characters: relationExplanationLimits.modelCharacters,
    relation_sources: [source("s1", input.first), source("s2", input.second)]
  });
}

/** One bounded repair: the first prompt followed by the repair instruction. */
export function buildSourceRelationExplanationRepairPrompt(prompt: string): string {
  return joinPrompts(
    prompt,
    renderPrompt("relations.sources.explain.repair", {
      max_characters: relationExplanationLimits.modelCharacters
    })
  );
}

/**
 * The aliases the prompt defines: exactly the lowercase tokens s1 and s2, standing alone. A longer
 * token (s12, as1, s1_to_s2) or a number (s1.5, s2-3) is content.
 */
const aliasToken = /(?<![\p{L}\p{N}_])s([12])(?![\p{L}\p{N}_])(?![-.]\p{N})/gu;

/** The backend alone turns the aliases into canonical, safe source references. */
export function resolveSourceRelationExplanationReferences(
  text: string,
  ids: { first: string; second: string }
): string {
  return text.replace(aliasToken, (_alias, which: string) =>
    which === "1" ? `<source-ref id="${ids.first}" />` : `<source-ref id="${ids.second}" />`
  );
}

/**
 * The text to store for a model answer, or null when it is not valid: plain text without tags of at
 * most `modelCharacters` characters, then at most the stored bound once the aliases became
 * references.
 */
export function acceptSourceRelationExplanation(
  output: unknown,
  ids: { first: string; second: string }
): string | null {
  const text = parseRelationExplanation(output);
  if (text === null) return null;
  const resolved = resolveSourceRelationExplanationReferences(text, ids);
  return resolved.length <= relationExplanationLimits.storedCharacters ? resolved : null;
}
