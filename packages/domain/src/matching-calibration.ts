// The matching controls against the calibrated set (F4 Q4, D33). The 16 matching values and the
// preset selector live in Settings › Advanced › Matching at the recommended values F3's bars were
// measured under; this module says which values differ from them, control by control, so the
// screen can show the calibrated value beside each one (in text, never in colour alone).
import {
  recommendedMatchingConfiguration,
  type MatchingConfiguration
} from "./matching-presets.js";

/** The value controls of the matching group, by the path of their stored value. */
export const matchingValueControlIds = [
  "relationTypeSimilarityThreshold",
  "entityIdentitySimilarityThreshold",
  "atomicNoteMatchingSettings.maxRerankOutputTokens",
  "canonicalMatchingSettings.relationTypeCandidateLimit",
  "canonicalMatchingSettings.entityCandidateLimit",
  "canonicalMatchingSettings.confirmationBatchSize",
  "canonicalMatchingSettings.confirmationMaxCharacters",
  "sourceRelationSettings.evidenceChunksPerSource",
  "sourceRelationSettings.evidenceMaxCharacters",
  "sourceRelationSettings.summaryMaxCharacters",
  "sourceRelationSettings.maxOutputTokens",
  "sourceRelationSettings.maxRelationsPerPair",
  "sourceRelationSettings.maxInputTokens",
  "sourceRelationSettings.minImportance",
  "sourceRelationSettings.minConfidence",
  "sourceRelationSettings.includeWeakTypes"
] as const;
export type MatchingValueControlId = (typeof matchingValueControlIds)[number];
export type MatchingControlValue = number | boolean;

/** The value of one matching control in a configuration. */
export function matchingControlValue(
  configuration: MatchingConfiguration,
  id: MatchingValueControlId
): MatchingControlValue {
  const [group, key] = id.split(".") as [keyof MatchingConfiguration, string | undefined];
  const value = key ? (configuration[group] as Record<string, unknown>)[key] : configuration[group];
  return value as MatchingControlValue;
}

export interface MatchingDifference {
  id: MatchingValueControlId;
  current: MatchingControlValue;
  calibrated: MatchingControlValue;
}

/**
 * The matching controls whose value is not the calibrated one, in the order the screen shows them.
 * The calibrated set is `recommendedMatchingConfiguration` (preset `recommended-v2`), under which
 * F3's bars were measured.
 */
export function matchingCalibrationDifferences(
  configuration: MatchingConfiguration,
  calibrated: MatchingConfiguration = recommendedMatchingConfiguration
): MatchingDifference[] {
  const differences: MatchingDifference[] = [];
  for (const id of matchingValueControlIds) {
    const current = matchingControlValue(configuration, id);
    const reference = matchingControlValue(calibrated, id);
    if (current !== reference) differences.push({ id, current, calibrated: reference });
  }
  return differences;
}

/**
 * The values that shape what a stored note decision is (the generative decider's output budget).
 * Thresholds, identity limits and floors are in no note decision.
 */
export function matchingNoteDecisionValues(configuration: MatchingConfiguration) {
  return { maxRerankOutputTokens: configuration.atomicNoteMatchingSettings.maxRerankOutputTokens };
}
