import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrateMatchingSettingsV2 } from "./matching-settings-migration.js";
import {
  MatchingConfigurationSchema,
  MatchingPresetsSchema,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId,
  retiredRecommendedMatchingConfiguration,
  retiredRecommendedMatchingPresetId
} from "./matching-presets.js";

describe("matching presets", () => {
  it("keeps recommended-v1 frozen at the validated benchmark values", () => {
    const benchmark = JSON.parse(
      readFileSync(
        new URL("../../../docs/matching-benchmark-settings.json", import.meta.url),
        "utf8"
      )
    );
    // The record predates matching settings v2: its dead note fields leave through the migration.
    expect(retiredRecommendedMatchingConfiguration).toEqual(
      MatchingConfigurationSchema.parse(migrateMatchingSettingsV2(benchmark.settings))
    );
    expect(retiredRecommendedMatchingPresetId).toBe("recommended-v1");
  });
  it("defines recommended-v2 as v1 with only the two source floors re-tuned", () => {
    expect(recommendedMatchingPresetId).toBe("recommended-v2");
    expect(recommendedMatchingConfiguration).toEqual({
      ...retiredRecommendedMatchingConfiguration,
      sourceRelationSettings: {
        ...retiredRecommendedMatchingConfiguration.sourceRelationSettings,
        minImportance: 0.75,
        minConfidence: 0.85
      }
    });
    expect(retiredRecommendedMatchingConfiguration.sourceRelationSettings).toMatchObject({
      minImportance: 0.85,
      minConfidence: 0.8
    });
  });
  it("rejects duplicate identities, invalid snapshots and attempts to replace the built-in preset", () => {
    const preset = {
      id: "afbec711-07cd-43b1-8088-153df3dc5f73",
      name: "Custom",
      settings: recommendedMatchingConfiguration
    };
    expect(MatchingPresetsSchema.safeParse([preset, preset]).success).toBe(false);
    for (const id of [recommendedMatchingPresetId, retiredRecommendedMatchingPresetId])
      expect(MatchingPresetsSchema.safeParse([{ ...preset, id }]).success).toBe(false);
    expect(
      MatchingPresetsSchema.safeParse([
        {
          ...preset,
          settings: {
            ...preset.settings,
            sourceRelationSettings: {
              ...preset.settings.sourceRelationSettings,
              maxRelationsPerPair: 0
            }
          }
        }
      ]).success
    ).toBe(false);
    expect(MatchingPresetsSchema.safeParse([{ ...preset, name: " " }]).success).toBe(false);
  });
  it("refuses a preset saved with settings that stopped deciding anything until the migration drops them", () => {
    const saved = {
      id: "afbec711-07cd-43b1-8088-153df3dc5f73",
      name: "Saved before F3",
      settings: {
        ...recommendedMatchingConfiguration,
        atomicNoteRelationThreshold: 0.6,
        atomicNoteMatchingSettings: { maxRerankOutputTokens: 4096, rerankerWeight: 0.4 },
        sourceRelationSettings: {
          ...recommendedMatchingConfiguration.sourceRelationSettings,
          reciprocalRankConstant: 60,
          noteRelationsPerPair: 4,
          maxCandidates: 30,
          maxPairs: 6,
          maxRelations: 10
        }
      }
    };
    expect(MatchingPresetsSchema.safeParse([saved]).success).toBe(false);
    const migrated = migrateMatchingSettingsV2({ matchingPresets: [saved] }) as {
      matchingPresets: unknown[];
    };
    const [read] = MatchingPresetsSchema.parse(migrated.matchingPresets);
    expect(read!.settings).toEqual(recommendedMatchingConfiguration);
    expect(
      MatchingPresetsSchema.safeParse(
        (
          migrateMatchingSettingsV2({
            matchingPresets: [
              {
                ...saved,
                settings: {
                  ...saved.settings,
                  sourceRelationSettings: { ...saved.settings.sourceRelationSettings, typo: 1 }
                }
              }
            ]
          }) as { matchingPresets: unknown[] }
        ).matchingPresets
      ).success
    ).toBe(false);
  });
});
