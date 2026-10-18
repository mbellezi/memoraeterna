import { z } from "zod";
import {
  AtomicNoteMatchingSettingsSchema,
  CanonicalMatchingSettingsSchema
} from "./matching-settings.js";
import { SourceRelationSettingsSchema } from "./source-relations.js";

export const recommendedMatchingPresetId = "recommended-v2";
// Retired id of the first recommendation; stored settings that still carry it are upgraded on read.
export const retiredRecommendedMatchingPresetId = "recommended-v1";
export const MatchingConfigurationSchema = z.object({
  entityIdentitySimilarityThreshold: z.number().min(0).max(1),
  relationTypeSimilarityThreshold: z.number().min(0).max(1),
  atomicNoteMatchingSettings: AtomicNoteMatchingSettingsSchema,
  canonicalMatchingSettings: CanonicalMatchingSettingsSchema,
  sourceRelationSettings: SourceRelationSettingsSchema
});
export type MatchingConfiguration = z.infer<typeof MatchingConfigurationSchema>;

// Versioned values frozen before held-out validation; independent of legacy fallbacks.
// v2 is v1 with its source floors re-tuned on the tuning partition for `source-relations-v5`
// (docs/kpi-f1b.md). v1 stays frozen only to recognize and upgrade older installs; add a version
// instead of editing either set. Both sets lost the note settings that stopped deciding anything
// (matching settings v2, `matching-settings-migration.ts`); stored settings lose them the same way,
// so what remained still equals what it did.
export const retiredRecommendedMatchingConfiguration: MatchingConfiguration =
  MatchingConfigurationSchema.parse({
    entityIdentitySimilarityThreshold: 0.92,
    relationTypeSimilarityThreshold: 0.92,
    atomicNoteMatchingSettings: { maxRerankOutputTokens: 4096 },
    canonicalMatchingSettings: {
      relationTypeCandidateLimit: 3,
      entityCandidateLimit: 3,
      confirmationBatchSize: 12,
      confirmationMaxCharacters: 12000
    },
    // Design E (F3 D27) deleted the shortlist settings (candidates, pairs, relations, rank fusion and
    // note relations per pair); the judge lists 4 note relations, the value v1 and v2 held.
    sourceRelationSettings: {
      evidenceChunksPerSource: 2,
      evidenceMaxCharacters: 800,
      summaryMaxCharacters: 1000,
      maxOutputTokens: 4096,
      maxRelationsPerPair: 4,
      maxInputTokens: 60000,
      minImportance: 0.85,
      minConfidence: 0.8,
      includeWeakTypes: false
    }
  });
export const recommendedMatchingConfiguration: MatchingConfiguration =
  MatchingConfigurationSchema.parse({
    ...retiredRecommendedMatchingConfiguration,
    sourceRelationSettings: {
      ...retiredRecommendedMatchingConfiguration.sourceRelationSettings,
      minImportance: 0.75,
      minConfidence: 0.85
    }
  });

export const MatchingPresetSchema = z
  .object({
    id: z.string().uuid(),
    // Null is the localized name for settings preserved from an earlier installation.
    name: z.string().trim().min(1).max(100).nullable(),
    settings: MatchingConfigurationSchema.strict()
  })
  .strict();
export const MatchingPresetsSchema = MatchingPresetSchema.array()
  .max(50)
  .refine(
    (presets) => new Set(presets.map((preset) => preset.id)).size === presets.length,
    "Duplicate preset IDs"
  );
export const MatchingPresetIdSchema = z.union([
  z.literal(recommendedMatchingPresetId),
  z.string().uuid()
]);
export type MatchingPreset = z.infer<typeof MatchingPresetSchema>;
export function matchingConfigurationsEqual(
  a: MatchingConfiguration,
  b: MatchingConfiguration
): boolean {
  return (
    JSON.stringify(MatchingConfigurationSchema.parse(a)) ===
    JSON.stringify(MatchingConfigurationSchema.parse(b))
  );
}
