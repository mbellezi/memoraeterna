import { z } from "zod";
import { AtomicNoteMatchingSettingsSchema, CanonicalMatchingSettingsSchema } from "./matching-settings.js";
import { SourceRelationSettingsSchema } from "./source-relations.js";

export const recommendedMatchingPresetId = "recommended-v1";
export const MatchingConfigurationSchema = z.object({
  atomicNoteRelationThreshold: z.number().min(0).max(1),
  entityIdentitySimilarityThreshold: z.number().min(0).max(1),
  relationTypeSimilarityThreshold: z.number().min(0).max(1),
  atomicNoteMatchingSettings: AtomicNoteMatchingSettingsSchema,
  canonicalMatchingSettings: CanonicalMatchingSettingsSchema,
  sourceRelationSettings: SourceRelationSettingsSchema
});
export type MatchingConfiguration = z.infer<typeof MatchingConfigurationSchema>;

// Versioned values frozen before held-out validation; independent of legacy fallbacks.
export const recommendedMatchingConfiguration: MatchingConfiguration = MatchingConfigurationSchema.parse({
  atomicNoteRelationThreshold: 0.6,
  entityIdentitySimilarityThreshold: 0.92,
  relationTypeSimilarityThreshold: 0.92,
  atomicNoteMatchingSettings: {
    textCandidateLimit: 20, vectorCandidateLimit: 20, graphCandidateLimit: 10,
    fusedCandidateLimit: 20, minimumGraphOnlyCandidates: 3, reciprocalRankConstant: 60,
    withEmbeddingAndGraph: { vector: 0.45, text: 0.25, graph: 0.2, metadata: 0.1 },
    withEmbedding: { vector: 0.55, text: 0.3, metadata: 0.15 },
    withGraph: { text: 0.55, graph: 0.3, metadata: 0.15 },
    textAndMetadata: { text: 0.7, metadata: 0.3 },
    rerankerWeight: 0.4, minRerankScore: 0.65, requireReranking: true,
    includeWeakTypes: false, maxRelationsPerNote: 10, maxRerankOutputTokens: 4096
  },
  canonicalMatchingSettings: {
    relationTypeCandidateLimit: 3, entityCandidateLimit: 3,
    confirmationBatchSize: 12, confirmationMaxCharacters: 12000
  },
  sourceRelationSettings: {
    reciprocalRankConstant: 60, evidenceChunksPerSource: 2, evidenceMaxCharacters: 800,
    summaryMaxCharacters: 1000, noteRelationsPerPair: 4, maxOutputTokens: 4096,
    maxCandidates: 30, maxPairs: 6, maxRelations: 10, maxRelationsPerPair: 4,
    maxInputTokens: 60000, minImportance: 0.85, minConfidence: 0.8, includeWeakTypes: false
  }
});

export const MatchingPresetSchema = z.object({
  id: z.string().uuid(),
  // Null is the localized name for settings preserved from an earlier installation.
  name: z.string().trim().min(1).max(100).nullable(),
  settings: MatchingConfigurationSchema.strict()
}).strict();
export const MatchingPresetsSchema = MatchingPresetSchema.array().max(50)
  .refine((presets) => new Set(presets.map((preset) => preset.id)).size === presets.length, "Duplicate preset IDs");
export const MatchingPresetIdSchema = z.union([z.literal(recommendedMatchingPresetId), z.string().uuid()]);
export type MatchingPreset = z.infer<typeof MatchingPresetSchema>;
export function matchingConfigurationsEqual(a: MatchingConfiguration, b: MatchingConfiguration): boolean {
  return JSON.stringify(MatchingConfigurationSchema.parse(a)) === JSON.stringify(MatchingConfigurationSchema.parse(b));
}
