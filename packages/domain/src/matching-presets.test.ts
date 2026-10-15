import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
    expect(retiredRecommendedMatchingConfiguration).toEqual(
      MatchingConfigurationSchema.parse(benchmark.settings)
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
            sourceRelationSettings: { ...preset.settings.sourceRelationSettings, maxPairs: 0 }
          }
        }
      ]).success
    ).toBe(false);
    expect(MatchingPresetsSchema.safeParse([{ ...preset, name: " " }]).success).toBe(false);
  });
});
