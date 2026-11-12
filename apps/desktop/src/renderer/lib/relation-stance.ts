import { isDirectedRelationType } from "@app/domain";
import type { MessageKey } from "@app/i18n";

import { relationBranchStance, relationBranchStances } from "../../shared/ipc-relations-branch";

/**
 * How a stored relation type reads on screen: its stance (glyph and colour), its word, its verb in a
 * sentence and whether it has a direction. The six stances are the legend of every relation view;
 * colour always comes with a glyph and a word.
 */
export const stances = relationBranchStances;
export type Stance = (typeof stances)[number];

export interface RelationTypeView {
  stance: Stance;
  /** The row and card label, `notePage.stance.<type>`. */
  wordKey: MessageKey;
  /** The verb of the card sentence, `notePage.card.verbs.<type>`. */
  verbKey: MessageKey;
  directed: boolean;
  /** Tie-break order: the legend order of the stance. */
  order: number;
}

/**
 * Stored types that have a word and a verb of their own. Their stance is mapped once, in
 * `relationBranchStance` (shared with the main process), so a new type reads alike everywhere; a
 * stored contrast is shown as such, never as a contradiction.
 */
const knownTypes = new Set([
  "supports",
  "contrasts",
  "contradicts",
  "extends",
  "depends_on",
  "example_of",
  "clarifies",
  "mentions",
  "similar_to",
  "same_as",
  "related"
] as const);
type KnownType = typeof knownTypes extends Set<infer T> ? T : never;

/** A type a later phase adds before this map knows it reads as `related`; the raw value never shows. */
export function relationTypeView(type: string): RelationTypeView {
  const known: KnownType = knownTypes.has(type as KnownType) ? (type as KnownType) : "related";
  const stance = relationBranchStance(known);
  return {
    stance,
    wordKey: `notePage.stance.${known}`,
    verbKey: `notePage.card.verbs.${known}`,
    directed: isDirectedRelationType(known),
    order: stances.indexOf(stance)
  };
}

/**
 * How a stored note pair reads from its first note to its second: the stored endpoints are sorted
 * by ID (relations v2, D8), so a relation with a direction points either way; a symmetric type reads
 * both ways. A relation nobody gave a direction (decision 31b), or a legacy one whose direction is
 * unknown, draws no arrow: only a dot between the notes.
 */
export function relationPairArrow(
  direction: "lo_to_hi" | "hi_to_lo" | "symmetric" | "unknown"
): string {
  return direction === "lo_to_hi"
    ? "→"
    : direction === "hi_to_lo"
      ? "←"
      : direction === "symmetric"
        ? "↔"
        : "·";
}

/** Literal classes, so the styles are generated: `text-stance-<stance>` from tokens.css. */
export const stanceTextClass: Record<Stance, string> = {
  supports: "text-stance-supports",
  contradicts: "text-stance-contradicts",
  extends: "text-stance-extends",
  depends_on: "text-stance-depends-on",
  example_of: "text-stance-example-of",
  related: "text-stance-related"
};
