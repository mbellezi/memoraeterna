import { z } from "zod";

/**
 * Knowledge-graph extraction batches by writer locality (F3 D36). A remote write-quality writer takes
 * larger batches (fewer calls per chapter); a local writer keeps the small batches that its 4B to 9B
 * models answer reliably. Extraction stays once per source over its chunks. These are start values
 * that the X7 reference run confirms or revises, so they live here and not in a prompt or a rule.
 */
const batchSchema = z
  .object({
    /** Characters of source text per extraction call. */
    maxInputCharacters: z.number().int().min(2_000).max(60_000),
    /** Hard caps the prompt states for one call. */
    maxEntities: z.number().int().min(1).max(100),
    maxRelations: z.number().int().min(1).max(200)
  })
  .strict();

export const knowledgeGraphBatchingSchema = z
  .object({
    remote: batchSchema,
    local: batchSchema
  })
  .strict();
export type KnowledgeGraphBatching = z.infer<typeof knowledgeGraphBatchingSchema>;
export type KnowledgeGraphBatch = z.infer<typeof batchSchema>;

export const defaultKnowledgeGraphBatching: KnowledgeGraphBatching =
  knowledgeGraphBatchingSchema.parse({
    remote: { maxInputCharacters: 7_000, maxEntities: 24, maxRelations: 24 },
    local: { maxInputCharacters: 3_500, maxEntities: 12, maxRelations: 12 }
  });

/**
 * The batch recorded fixtures were extracted with. Under `MEMORA_GOLDEN_PIN=extraction` every writer
 * uses it, so each recorded graph call, and each recorded repair, replays (D5).
 */
export const pinnedKnowledgeGraphBatch: KnowledgeGraphBatch = batchSchema.parse({
  maxInputCharacters: 3_500,
  maxEntities: 12,
  maxRelations: 12
});

/**
 * The batch for a writer. A pinned run, a writer that runs on this machine and a task with no route
 * (nothing is known about it) take the small batch: larger batches are only for a writer that is
 * known to be remote.
 */
export function knowledgeGraphBatchFor(
  locality: "local" | "remote" | null,
  options: { pinned: boolean },
  config: KnowledgeGraphBatching = defaultKnowledgeGraphBatching
): KnowledgeGraphBatch {
  if (options.pinned) return pinnedKnowledgeGraphBatch;
  return locality === "remote" ? config.remote : config.local;
}
