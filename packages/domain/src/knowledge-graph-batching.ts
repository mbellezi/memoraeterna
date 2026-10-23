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

/** The most rows one identity call may ask about: the confirmation answer's contract allows this many. */
export const maxIdentityGroupRows = 24;

const identityGroupSchema = z
  .object({
    /** Rows (an entity or relation type with at least one candidate) one identity call asks about. */
    maxRows: z.number().int().min(1).max(maxIdentityGroupRows),
    /** Characters of one identity prompt; a single row always fits. */
    maxCharacters: z.number().int().min(2_000).max(24_000)
  })
  .strict();
export type IdentityGroupLimits = z.infer<typeof identityGroupSchema>;

/**
 * Identity groups by writer locality (F4 D20). Extraction checkpoints every raw batch first; entity
 * identity, then relation types, resolve a source's rows in groups across its batches. Remote writers
 * take 24 rows and 24,000 characters per call; local ones 12 and 12,000, where the stored
 * `confirmationBatchSize` and `confirmationMaxCharacters` (Advanced › Matching) may only lower them.
 */
export const identityGroupingSchema = z
  .object({ remote: identityGroupSchema, local: identityGroupSchema })
  .strict();
export type IdentityGrouping = z.infer<typeof identityGroupingSchema>;

export const defaultIdentityGrouping: IdentityGrouping = identityGroupingSchema.parse({
  remote: { maxRows: 24, maxCharacters: 24_000 },
  local: { maxRows: 12, maxCharacters: 12_000 }
});

/**
 * The identity group of a writer (Q4's reading with D20). A remote writer takes the typed remote group
 * whatever is stored; a local writer, or one nothing is known about, takes the stored values capped
 * at the typed local group, so a stored 24,000 characters still gives local groups of 12,000.
 */
export function identityGroupFor(
  locality: "local" | "remote" | null,
  stored: { confirmationBatchSize: number; confirmationMaxCharacters: number },
  config: IdentityGrouping = defaultIdentityGrouping
): IdentityGroupLimits {
  if (locality === "remote") return config.remote;
  return {
    maxRows: Math.max(1, Math.min(config.local.maxRows, Math.floor(stored.confirmationBatchSize))),
    maxCharacters: Math.min(
      config.local.maxCharacters,
      Math.floor(stored.confirmationMaxCharacters)
    )
  };
}
