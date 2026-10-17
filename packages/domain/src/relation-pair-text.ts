/**
 * The text a relation ranker sees for one note (F3 D13, template `relation-pair-text-v1`): the
 * title, the idea statement and the first characters of the body, one labelled line each. It is
 * Spike A's rendering (`scripts/spikes/reranker/dataset.ts`), so the scores of the bake-off and of
 * the product are scores of the same input, and its SHA-256 is the note's rendered-input hash that
 * keys a stored decision.
 */
export const relationPairTextTemplate = "relation-pair-text-v1";

export interface RelationPairTextNote {
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
}

/**
 * Renders a note for the ranker. The body's whitespace runs collapse to one space and the body is
 * cut after `bodyCharacters` code points (never inside a surrogate pair).
 */
export function renderRelationPairText(note: RelationPairTextNote, bodyCharacters: number): string {
  if (!Number.isInteger(bodyCharacters) || bodyCharacters < 1)
    throw new Error("The rendered body needs a positive number of characters.");
  const body = [...note.bodyMarkdown.replace(/\s+/gu, " ").trim()]
    .slice(0, bodyCharacters)
    .join("");
  return `Title: ${note.title}\nIdea: ${note.ideaStatement}\nText: ${body}`;
}
