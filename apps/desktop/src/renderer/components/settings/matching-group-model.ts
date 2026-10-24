// What the matching group shows about the calibrated set (F4 Q4): which controls differ from it,
// the calibrated value of each as text, and what the preset selector reads. Pure, so it is tested
// in node. The calibrated set is `recommendedMatchingConfiguration` (preset `recommended-v2`).
import {
  MatchingConfigurationSchema,
  matchingCalibrationDifferences,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId,
  type MatchingConfiguration,
  type MatchingControlValue,
  type MatchingDifference,
  type MatchingPreset,
  type MatchingValueControlId
} from "@app/domain";
import type { Translator } from "@app/i18n";

import type { AppSettings } from "../../../shared/ipc";

/** Controls shown as a similarity or score between 0 and 1, with two decimals as the slider does. */
const twoDecimals: ReadonlySet<MatchingValueControlId> = new Set([
  "relationTypeSimilarityThreshold",
  "entityIdentitySimilarityThreshold",
  "sourceRelationSettings.minImportance",
  "sourceRelationSettings.minConfidence"
]);

/** A control's value as text for this interface language. */
export function formatMatchingValue(
  t: Translator,
  id: MatchingValueControlId,
  value: MatchingControlValue
): string {
  if (typeof value === "boolean")
    return t(value ? "settings.matching.calibration.on" : "settings.matching.calibration.off");
  if (twoDecimals.has(id)) return value.toFixed(2);
  return new Intl.NumberFormat(t.locale).format(value);
}

/** What a preset is called in the selector: values away from the calibrated set read "Custom". */
export function matchingPresetLabel(t: Translator, preset: MatchingPreset): string {
  const differs = matchingCalibrationDifferences(preset.settings).length > 0;
  if (preset.name === null) return t("settings.matching.presets.previous");
  return differs
    ? t("settings.matching.presets.customNamed", { values: { name: preset.name } })
    : preset.name;
}

export interface MatchingGroupModel {
  /** The built-in recommendation is selected: the group is read-only. */
  isRecommended: boolean;
  /** The controls whose value is not the calibrated one, in screen order. */
  differences: readonly MatchingDifference[];
  /** The calibrated value of each differing control, as text for "Calibrated: …". */
  calibratedText: ReadonlyMap<MatchingValueControlId, string>;
  selectedPresetId: string;
  /** The selector's options: the recommendation, then the saved presets. */
  options: ReadonlyArray<{ id: string; label: string }>;
  /** The configuration the group shows. */
  configuration: MatchingConfiguration;
}

export function matchingGroupModel(settings: AppSettings, t: Translator): MatchingGroupModel {
  const configuration = MatchingConfigurationSchema.parse(settings);
  const differences = matchingCalibrationDifferences(configuration);
  return {
    isRecommended: settings.activeMatchingPresetId === recommendedMatchingPresetId,
    differences,
    calibratedText: new Map(
      differences.map((difference) => [
        difference.id,
        formatMatchingValue(t, difference.id, difference.calibrated)
      ])
    ),
    selectedPresetId: settings.activeMatchingPresetId ?? recommendedMatchingPresetId,
    options: [
      { id: recommendedMatchingPresetId, label: t("settings.matching.presets.recommended") },
      ...settings.matchingPresets.map((preset) => ({
        id: preset.id,
        label: matchingPresetLabel(t, preset)
      }))
    ],
    configuration
  };
}

/**
 * The update that puts the calibrated values back: the built-in recommendation is selected again.
 * The saved presets stay as they are, so the person can return to one.
 */
export function restoreCalibratedUpdate(settings: Pick<AppSettings, "matchingPresets">) {
  return {
    ...recommendedMatchingConfiguration,
    matchingPresets: settings.matchingPresets,
    activeMatchingPresetId: recommendedMatchingPresetId
  };
}
