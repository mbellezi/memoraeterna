import { z } from "zod";

import { directedNoteRelationTypes } from "./knowledge.js";
import { withinCharacters } from "./note-page.js";

/**
 * Explanations of note relations are written on demand (docs/plan.md decision 16): never in bulk or
 * in the background, only when the owner opens a relation, then cached on the relation for the
 * inputs they were written from. These are the shared, browser-safe parts of that contract.
 */
export const relationExplanationLimits = {
  /** The model writes at most this many characters (note references count as their alias). */
  modelCharacters: 300,
  /**
   * An explanation has at least this many words. A shorter answer is no explanation: it is the
   * sentinel in another spelling or language ("Not related.", "Não relacionado."), which must not
   * be cached as text; it goes to the repair, which can answer the sentinel exactly.
   */
  minModelWords: 3,
  /**
   * The longest stored text, note references expanded (the database check counts characters).
   * An answer that expands beyond it is invalid output, not a failure at the insert.
   */
  storedCharacters: 4_000,
  /** Active time an explanation may take once it runs (waiting for the AI queue does not count). */
  timeoutMs: 120_000,
  /**
   * Output tokens asked for. An explanation is one or two sentences (about 100 tokens), but a
   * route that cannot turn reasoning off counts its reasoning inside the cap, so the rest is room
   * to think: a cap of the answer alone would come back empty.
   */
  maxOutputTokens: 2_048,
  /** Streamed text leaves for the window at most this often (F3 D22), the last piece included. */
  streamCoalesceMs: 50,
  /**
   * Characters of the answer held back until they cannot be the start of the sentinel: nothing is
   * shown before this many have arrived, and an answer that begins with the sentinel is never shown.
   */
  sentinelHoldCharacters: 16
} as const;

/**
 * The whole answer of the writer when the notes are not related as stated (prompt revision 3). It
 * withdraws the relation (F3 D22); it is never shown as an explanation. It is also the text of the
 * row that caches the writer's verdict under the key of the inputs it was given (a row with this
 * text is never an explanation: readers show none).
 */
export const relationExplanationSentinel = "NOT_RELATED";

/**
 * Relation types that read in one direction (the others read the same both ways): the directed
 * write types of the relations v2 vocabulary (D10). Legacy `mentions` reads as neutral, like its
 * stance on screen.
 */
export const directedRelationTypes = directedNoteRelationTypes;

export function isDirectedRelationType(type: string): boolean {
  return (directedRelationTypes as readonly string[]).includes(type);
}

export const RelationExplainInputSchema = z
  .object({
    relationId: z.string().uuid(),
    /**
     * Names the request on the delta channel, so a card that was closed and opened again ignores
     * the pieces of the request it canceled.
     */
    requestId: z.string().uuid().optional()
  })
  .strict();
export type RelationExplainInput = z.infer<typeof RelationExplainInputSchema>;

export const RelationExplanationResultSchema = z
  .object({
    relationId: z.string().uuid(),
    /** Safe text whose note references are `<note-ref id="..." />` tags. */
    text: z
      .string()
      .min(1)
      .refine((value) => withinCharacters(value, relationExplanationLimits.storedCharacters)),
    /** The model that wrote it. */
    writtenBy: z.string().min(1),
    writtenAt: z.string().datetime()
  })
  .strict();
export type RelationExplanationResult = z.infer<typeof RelationExplanationResultSchema>;

/** The writer found the notes unrelated: the relation is withdrawn until the owner reviews it. */
export const RelationVetoResultSchema = z
  .object({ relationId: z.string().uuid(), vetoed: z.literal(true) })
  .strict();
export type RelationVetoResult = z.infer<typeof RelationVetoResultSchema>;

/**
 * The writer found the notes unrelated, but the relation stays as it is: a human verdict is final
 * (a kept relation), and a relation to an earlier version of a note cannot be withdrawn. Nothing is
 * explained, and the verdict is cached with the relation, so opening it again asks nobody.
 */
export const RelationUnrelatedResultSchema = z
  .object({ relationId: z.string().uuid(), unrelated: z.literal(true) })
  .strict();
export type RelationUnrelatedResult = z.infer<typeof RelationUnrelatedResultSchema>;

/**
 * What opening a relation answers: its explanation, the veto that withdrew the relation, or the
 * writer's disagreement with a relation that stays.
 */
export const RelationExplainOutcomeSchema = z.union([
  RelationExplanationResultSchema,
  RelationVetoResultSchema,
  RelationUnrelatedResultSchema
]);
export type RelationExplainOutcome = z.infer<typeof RelationExplainOutcomeSchema>;

/** Whether an answer of `explain` is the veto. */
export function isRelationVeto(outcome: RelationExplainOutcome): outcome is RelationVetoResult {
  return "vetoed" in outcome;
}

/** Whether an answer of `explain` is the writer's disagreement with a relation that stays. */
export function isRelationUnrelated(
  outcome: RelationExplainOutcome
): outcome is RelationUnrelatedResult {
  return "unrelated" in outcome;
}

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
