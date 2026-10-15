import { z } from "zod";

/**
 * Explanations of note relations are written on demand (docs/plan.md decision 16): never in bulk or
 * in the background, only when the owner opens a relation, then cached on the relation for the
 * inputs they were written from. These are the shared, browser-safe parts of that contract.
 */
export const relationExplanationLimits = {
  /** The model writes at most this many characters (note references count as their alias). */
  modelCharacters: 300,
  /** Active time an explanation may take once it runs (waiting for the AI queue does not count). */
  timeoutMs: 120_000,
  /** Output tokens asked for; an explanation is one or two sentences. */
  maxOutputTokens: 512
} as const;

/** Relation types that read in one direction (the others read the same both ways). */
export const directedRelationTypes = [
  "supports",
  "extends",
  "depends_on",
  "example_of",
  "clarifies",
  "mentions"
] as const;

export function isDirectedRelationType(type: string): boolean {
  return (directedRelationTypes as readonly string[]).includes(type);
}

export const RelationExplainInputSchema = z.object({ relationId: z.string().uuid() }).strict();
export type RelationExplainInput = z.infer<typeof RelationExplainInputSchema>;

export const RelationExplanationResultSchema = z
  .object({
    relationId: z.string().uuid(),
    /** Safe text whose note references are `<note-ref id="..." />` tags. */
    text: z.string().min(1).max(4_000),
    /** The model that wrote it. */
    writtenBy: z.string().min(1),
    writtenAt: z.string().datetime()
  })
  .strict();
export type RelationExplanationResult = z.infer<typeof RelationExplanationResultSchema>;

/** How the relation reads between the two notes, as the prompt states it. */
export type RelationExplanationDirection = "n1_to_n2" | "symmetric" | "unknown";

/**
 * The order in which an explanation sees the two notes. A directed type with a decided direction
 * puts its subject first; otherwise the order follows content (idea, then title), so the prompt is
 * a function of content: an ID only breaks a tie between indistinguishable notes.
 */
export function relationExplanationOrder<
  T extends { id: string; title: string; ideaStatement: string }
>(input: {
  type: string;
  semanticSourceId: string | null | undefined;
  a: T;
  b: T;
}): { direction: RelationExplanationDirection; first: T; second: T } {
  const { a, b } = input;
  if (isDirectedRelationType(input.type)) {
    if (input.semanticSourceId === a.id) return { direction: "n1_to_n2", first: a, second: b };
    if (input.semanticSourceId === b.id) return { direction: "n1_to_n2", first: b, second: a };
  }
  const key = (note: T) => [note.ideaStatement, note.title, note.id];
  const [ka, kb] = [key(a), key(b)];
  let order = 0;
  for (let index = 0; index < ka.length && order === 0; index++)
    order = ka[index]! < kb[index]! ? -1 : ka[index]! > kb[index]! ? 1 : 0;
  const [first, second] = order <= 0 ? [a, b] : [b, a];
  return { direction: isDirectedRelationType(input.type) ? "unknown" : "symmetric", first, second };
}
