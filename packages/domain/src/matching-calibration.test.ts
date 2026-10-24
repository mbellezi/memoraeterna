import { describe, expect, it } from "vitest";

import {
  matchingCalibrationDifferences,
  matchingControlValue,
  matchingNoteDecisionValues,
  matchingValueControlIds
} from "./matching-calibration.js";
import {
  MatchingConfigurationSchema,
  recommendedMatchingConfiguration,
  type MatchingConfiguration
} from "./matching-presets.js";

const withChanges = (changes: {
  relationTypeSimilarityThreshold?: number;
  sourceRelationSettings?: Partial<MatchingConfiguration["sourceRelationSettings"]>;
  canonicalMatchingSettings?: Partial<MatchingConfiguration["canonicalMatchingSettings"]>;
  atomicNoteMatchingSettings?: Partial<MatchingConfiguration["atomicNoteMatchingSettings"]>;
}): MatchingConfiguration =>
  MatchingConfigurationSchema.parse({
    ...recommendedMatchingConfiguration,
    ...changes,
    sourceRelationSettings: {
      ...recommendedMatchingConfiguration.sourceRelationSettings,
      ...changes.sourceRelationSettings
    },
    canonicalMatchingSettings: {
      ...recommendedMatchingConfiguration.canonicalMatchingSettings,
      ...changes.canonicalMatchingSettings
    },
    atomicNoteMatchingSettings: {
      ...recommendedMatchingConfiguration.atomicNoteMatchingSettings,
      ...changes.atomicNoteMatchingSettings
    }
  });

describe("the matching controls against the calibrated set", () => {
  it("names one value control per stored matching value (16, with the preset selector 17)", () => {
    expect(matchingValueControlIds).toHaveLength(16);
    expect(new Set(matchingValueControlIds).size).toBe(16);
    // Every id reads a defined value of the configuration: thresholds, the note value, four
    // canonical and nine source values.
    for (const id of matchingValueControlIds)
      expect(["number", "boolean"], id).toContain(
        typeof matchingControlValue(recommendedMatchingConfiguration, id)
      );
    const shape = MatchingConfigurationSchema.shape;
    const stored = [
      ...Object.keys(shape).filter(
        (key) =>
          key !== "atomicNoteMatchingSettings" &&
          key !== "canonicalMatchingSettings" &&
          key !== "sourceRelationSettings"
      ),
      ...Object.keys(recommendedMatchingConfiguration.atomicNoteMatchingSettings).map(
        (key) => `atomicNoteMatchingSettings.${key}`
      ),
      ...Object.keys(recommendedMatchingConfiguration.canonicalMatchingSettings).map(
        (key) => `canonicalMatchingSettings.${key}`
      ),
      ...Object.keys(recommendedMatchingConfiguration.sourceRelationSettings).map(
        (key) => `sourceRelationSettings.${key}`
      )
    ];
    expect([...matchingValueControlIds].sort()).toEqual(stored.sort());
  });

  it("finds no difference in the calibrated set itself", () => {
    expect(matchingCalibrationDifferences(recommendedMatchingConfiguration)).toEqual([]);
  });

  it("lists each differing control with its own and its calibrated value, in screen order", () => {
    const differences = matchingCalibrationDifferences(
      withChanges({
        relationTypeSimilarityThreshold: 0.8,
        canonicalMatchingSettings: { confirmationBatchSize: 6 },
        sourceRelationSettings: { includeWeakTypes: true, maxInputTokens: 30000 }
      })
    );
    expect(differences).toEqual([
      { id: "relationTypeSimilarityThreshold", current: 0.8, calibrated: 0.92 },
      { id: "canonicalMatchingSettings.confirmationBatchSize", current: 6, calibrated: 12 },
      { id: "sourceRelationSettings.maxInputTokens", current: 30000, calibrated: 60000 },
      { id: "sourceRelationSettings.includeWeakTypes", current: true, calibrated: false }
    ]);
  });

  it("reads the note decision values: only the generative decider's output budget", () => {
    expect(matchingNoteDecisionValues(recommendedMatchingConfiguration)).toEqual({
      maxRerankOutputTokens: 4096
    });
  });
});
