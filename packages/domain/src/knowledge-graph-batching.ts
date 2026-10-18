import { z } from "zod";

/**
 * Knowledge-graph extraction batches by writer locality (F3 D36). Extraction stays once per source
 * over its chunks. D36 gave remote writers 7,000-character batches with 24/24 caps; on X7-REF at M2
 * that kept 85% of F1a's entity yield (bar 90%), so by Q8 remote writers keep F1a's 3,500 with 12/12,
 * like local ones (owner, 2026-10-18). The split stays so a later measurement can change one side.
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
    remote: { maxInputCharacters: 3_500, maxEntities: 12, maxRelations: 12 },
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
