import { isDirectedRelationType } from "@app/domain";
import type { MessageKey } from "@app/i18n";

/**
 * How a stored relation type reads on screen: its stance (glyph and colour), its word, its verb in a
 * sentence and whether it has a direction. The six stances are the legend of every relation view;
 * colour always comes with a glyph and a word.
 */
export const stances = [
  "supports",
  "contradicts",
  "extends",
  "depends_on",
  "example_of",
  "related"
] as const;
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

/** Stored types and the stances they take; a stored contrast is shown as such, never as a contradiction. */
const typeStances = {
  supports: "supports",
  contrasts: "contradicts",
  contradicts: "contradicts",
  extends: "extends",
  depends_on: "depends_on",
  example_of: "example_of",
  clarifies: "related",
  mentions: "related",
  similar_to: "related",
  same_as: "related",
  related: "related"
} as const satisfies Record<string, Stance>;
type KnownType = keyof typeof typeStances;

/** A type a later phase adds before this map knows it reads as `related`; the raw value never shows. */
export function relationTypeView(type: string): RelationTypeView {
  const known: KnownType = Object.hasOwn(typeStances, type) ? (type as KnownType) : "related";
  const stance = typeStances[known];
  return {
    stance,
    wordKey: `notePage.stance.${known}`,
    verbKey: `notePage.card.verbs.${known}`,
    directed: isDirectedRelationType(known),
    order: stances.indexOf(stance)
  };
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
