import {
  MatchingConfigurationSchema,
  matchingCalibrationDifferences,
  matchingControlValue,
  matchingValueControlIds,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId,
  type MatchingConfiguration,
  type MatchingControlValue,
  type MatchingDifference,
  type MatchingPreset,
  type MatchingValueControlId
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type { AppSettings, AppSettingsUpdate } from "../../../../shared/ipc";

/**
 * What Settings › Advanced › Matching shows and writes (F4 Q4, F5 T165): the 16 matching values
 * with their limits, which of them differ from the calibrated set, the saved presets and the update
 * that each edit makes. Pure, so every rule is tested without a renderer. The calibrated set is
 * `recommendedMatchingConfiguration` (the built-in preset `recommended-v2`), under which F3's bars
 * were measured.
 */

export type MatchingSubgroup = "identity" | "notes" | "sources";
export type MatchingUnit = "tokens" | "characters";

export interface MatchingControlSpec {
  id: MatchingValueControlId;
  kind: "decimal" | "integer" | "switch";
  min: number;
  max: number;
  /** The arrow keys' step. */
  step: number;
  unit?: MatchingUnit;
  subgroup: MatchingSubgroup;
}

const spec = (
  id: MatchingValueControlId,
  subgroup: MatchingSubgroup,
  kind: MatchingControlSpec["kind"],
  min: number,
  max: number,
  step: number,
  unit?: MatchingUnit
): MatchingControlSpec => ({ id, subgroup, kind, min, max, step, ...(unit ? { unit } : {}) });

/** The limits the schemas hold (`matching-settings.ts`, `source-relations.ts`), in the registry's order. */
export const matchingControls: readonly MatchingControlSpec[] = [
  spec("relationTypeSimilarityThreshold", "identity", "decimal", 0, 1, 0.01),
  spec("entityIdentitySimilarityThreshold", "identity", "decimal", 0, 1, 0.01),
  spec("canonicalMatchingSettings.relationTypeCandidateLimit", "identity", "integer", 1, 20, 1),
  spec("canonicalMatchingSettings.entityCandidateLimit", "identity", "integer", 1, 20, 1),
  spec("canonicalMatchingSettings.confirmationBatchSize", "identity", "integer", 1, 12, 1),
  spec(
    "canonicalMatchingSettings.confirmationMaxCharacters",
    "identity",
    "integer",
    2_000,
    24_000,
    500,
    "characters"
  ),
  spec(
    "atomicNoteMatchingSettings.maxRerankOutputTokens",
    "notes",
    "integer",
    512,
    16_384,
    256,
    "tokens"
  ),
  spec("sourceRelationSettings.evidenceChunksPerSource", "sources", "integer", 1, 12, 1),
  spec("sourceRelationSettings.evidenceMaxCharacters", "sources", "integer", 300, 6_000, 50),
  spec("sourceRelationSettings.summaryMaxCharacters", "sources", "integer", 300, 6_000, 50),
  spec("sourceRelationSettings.maxOutputTokens", "sources", "integer", 512, 16_384, 256, "tokens"),
  spec("sourceRelationSettings.maxRelationsPerPair", "sources", "integer", 1, 20, 1),
  spec(
    "sourceRelationSettings.maxInputTokens",
    "sources",
    "integer",
    2_000,
    200_000,
    1_000,
    "tokens"
  ),
  spec("sourceRelationSettings.minImportance", "sources", "decimal", 0, 1, 0.05),
  spec("sourceRelationSettings.minConfidence", "sources", "decimal", 0, 1, 0.05),
  spec("sourceRelationSettings.includeWeakTypes", "sources", "switch", 0, 1, 1)
];

const bySpecId = new Map(matchingControls.map((control) => [control.id, control]));

/** The spec of a registry id, or null when the id is not a matching value. */
export const matchingSpecOf = (id: string): MatchingControlSpec | null =>
  bySpecId.get(id as MatchingValueControlId) ?? null;

/** True once per matching value the domain lists: the two lists must not drift apart. */
export const matchingControlsCoverDomain = (): boolean =>
  matchingValueControlIds.length === matchingControls.length &&
  matchingValueControlIds.every((id) => bySpecId.has(id));

export const matchingSubgroups: readonly MatchingSubgroup[] = ["identity", "notes", "sources"];

// ---------------------------------------------------------------------------
// Numbers

/** The number a person typed (a comma or a dot for the decimals, spaces and dots for thousands), or null. */
export function parseNumber(text: string, locale: string): number | null {
  const cleaned = text.trim().replace(/\s/gu, "");
  if (cleaned === "") return null;
  const separators = new Intl.NumberFormat(locale)
    .formatToParts(1_000.5)
    .reduce<{ group: string; decimal: string }>(
      (found, part) =>
        part.type === "group"
          ? { ...found, group: part.value }
          : part.type === "decimal"
            ? { ...found, decimal: part.value }
            : found,
      { group: ",", decimal: "." }
    );
  // The last "," or "." is the decimal mark unless it stands exactly before three digits and the
  // locale uses it to group: "2.000" is two thousand in pt-BR and two in en.
  let normalized = cleaned;
  const last = Math.max(cleaned.lastIndexOf(","), cleaned.lastIndexOf("."));
  if (last >= 0) {
    const mark = cleaned[last]!;
    const digitsAfter = cleaned.length - last - 1;
    const groups = mark === separators.group.replace(/\s/gu, "") && digitsAfter === 3;
    normalized = groups
      ? cleaned.replace(/[.,]/gu, "")
      : `${cleaned.slice(0, last).replace(/[.,]/gu, "")}.${cleaned.slice(last + 1)}`;
  }
  if (!/^-?\d+(\.\d+)?$/u.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** A value inside the control's limits; whole numbers for the integers, two decimals for the others. */
export function clampValue(control: MatchingControlSpec, value: number): number {
  const bounded = Math.min(control.max, Math.max(control.min, value));
  return control.kind === "integer" ? Math.round(bounded) : Math.round(bounded * 100) / 100;
}

export function formatValue(
  control: Pick<MatchingControlSpec, "kind">,
  value: number,
  locale: string
): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: control.kind === "decimal" ? 2 : 0,
    maximumFractionDigits: control.kind === "decimal" ? 2 : 0
  }).format(value);
}

// ---------------------------------------------------------------------------
// Values and updates

/** The configuration an `AppSettings` carries: what the group shows. */
export const configurationOf = (settings: AppSettings): MatchingConfiguration =>
  MatchingConfigurationSchema.parse(settings);

export const valueOf = (settings: AppSettings, id: MatchingValueControlId): MatchingControlValue =>
  matchingControlValue(configurationOf(settings), id);

/**
 * The update that sets one value. The main process puts the new value into the preset that is
 * selected, so the update carries the changed group only; a value in a nested group travels with
 * the other values of that group, which the schema needs whole.
 */
export function updateForValue(
  settings: AppSettings,
  id: MatchingValueControlId,
  value: MatchingControlValue
): AppSettingsUpdate {
  const [group, key] = id.split(".") as [keyof MatchingConfiguration, string | undefined];
  if (!key) return { [group]: value } as AppSettingsUpdate;
  const current = configurationOf(settings)[group] as Record<string, unknown>;
  return { [group]: { ...current, [key]: value } } as AppSettingsUpdate;
}

/** The built-in recommendation is selected: the values are the calibrated ones and read-only. */
export const isRecommended = (settings: Pick<AppSettings, "activeMatchingPresetId">): boolean =>
  (settings.activeMatchingPresetId ?? recommendedMatchingPresetId) === recommendedMatchingPresetId;

/** The controls whose value is not the calibrated one, in the order the group shows them. */
export const differencesOf = (settings: AppSettings): readonly MatchingDifference[] =>
  matchingCalibrationDifferences(configurationOf(settings));

/** The update that puts the calibrated values back and selects the recommendation; saved presets stay. */
export const restoreCalibratedUpdate = (
  settings: Pick<AppSettings, "matchingPresets">
): AppSettingsUpdate => ({
  ...recommendedMatchingConfiguration,
  matchingPresets: settings.matchingPresets,
  activeMatchingPresetId: recommendedMatchingPresetId
});

/** A value as the person reads it ("0,80", "4.096", "on"). */
export function valueText(t: Translator, id: MatchingValueControlId, value: MatchingControlValue) {
  if (typeof value === "boolean")
    return t(value ? "settingsAdvanced.matching.on" : "settingsAdvanced.matching.off");
  const control = matchingSpecOf(id);
  return formatValue(control ?? { kind: "integer" }, value, t.locale);
}

/** "0,80 instead of 0,85" for one difference, in words. */
export function differenceText(
  t: Translator,
  difference: MatchingDifference,
  label: (id: MatchingValueControlId) => string
): string {
  return t("settingsAdvanced.matching.differenceItem", {
    values: {
      label: label(difference.id),
      current: valueText(t, difference.id, difference.current),
      calibrated: valueText(t, difference.id, difference.calibrated)
    }
  });
}

// ---------------------------------------------------------------------------
// Presets

export const presetLimit = 50;
export const presetNameMax = 100;

export interface PresetOption {
  id: string;
  label: string;
}

/** What a saved preset is called: values away from the calibrated set read "Custom: name". */
export function presetLabel(t: Translator, preset: MatchingPreset): string {
  if (preset.name === null) return t("settingsAdvanced.matching.presetPrevious");
  return matchingCalibrationDifferences(preset.settings).length > 0
    ? t("settingsAdvanced.matching.presetCustomNamed", { values: { name: preset.name } })
    : preset.name;
}

/** The selector's options: the recommendation, then the saved presets. */
export function presetOptions(
  t: Translator,
  settings: Pick<AppSettings, "matchingPresets">
): PresetOption[] {
  return [
    { id: recommendedMatchingPresetId, label: t("settingsAdvanced.matching.presetRecommended") },
    ...settings.matchingPresets.map((preset) => ({ id: preset.id, label: presetLabel(t, preset) }))
  ];
}

/** The update that selects a preset (its values become the effective ones), or null when it is unknown. */
export function selectPresetUpdate(
  settings: Pick<AppSettings, "matchingPresets">,
  id: string
): AppSettingsUpdate | null {
  const configuration =
    id === recommendedMatchingPresetId
      ? recommendedMatchingConfiguration
      : settings.matchingPresets.find((preset) => preset.id === id)?.settings;
  return configuration
    ? { ...configuration, matchingPresets: settings.matchingPresets, activeMatchingPresetId: id }
    : null;
}

export type PresetEdit = "create" | "duplicate" | "rename";

export const validPresetName = (name: string): boolean => {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= presetNameMax;
};

/** The update that saves a preset under a name, or null when the name is not valid or the limit is reached. */
export function savePresetUpdate(
  settings: AppSettings,
  edit: PresetEdit,
  name: string,
  newId: () => string
): AppSettingsUpdate | null {
  if (!validPresetName(name)) return null;
  const trimmed = name.trim();
  const selected = settings.matchingPresets.find(
    (preset) => preset.id === settings.activeMatchingPresetId
  );
  if (edit === "rename") {
    if (!selected) return null;
    return {
      ...selected.settings,
      activeMatchingPresetId: selected.id,
      matchingPresets: settings.matchingPresets.map((preset) =>
        preset.id === selected.id ? { ...preset, name: trimmed } : preset
      )
    };
  }
  if (settings.matchingPresets.length >= presetLimit) return null;
  const configuration =
    edit === "create" ? recommendedMatchingConfiguration : configurationOf(settings);
  const id = newId();
  return {
    ...configuration,
    activeMatchingPresetId: id,
    matchingPresets: [...settings.matchingPresets, { id, name: trimmed, settings: configuration }]
  };
}

/** The update that deletes the selected preset and selects the recommendation again. */
export function deletePresetUpdate(settings: AppSettings): AppSettingsUpdate | null {
  const selected = settings.matchingPresets.find(
    (preset) => preset.id === settings.activeMatchingPresetId
  );
  if (!selected) return null;
  return {
    ...recommendedMatchingConfiguration,
    activeMatchingPresetId: recommendedMatchingPresetId,
    matchingPresets: settings.matchingPresets.filter((preset) => preset.id !== selected.id)
  };
}

/** The copy key of a subgroup's heading and introduction. */
export const subgroupKeys = (
  subgroup: MatchingSubgroup
): { title: MessageKey; intro: MessageKey } => ({
  title: `settingsAdvanced.matching.subgroups.${subgroup}.title` as MessageKey,
  intro: `settingsAdvanced.matching.subgroups.${subgroup}.intro` as MessageKey
});
