import { describe, expect, it } from "vitest";
import {
  MatchingConfigurationSchema,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId
} from "@app/domain";
import { createTranslator } from "@app/i18n";

import { defaultAppSettings, type AppSettings } from "../../../../shared/ipc";
import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import {
  clampValue,
  deletePresetUpdate,
  differenceText,
  differencesOf,
  formatValue,
  isRecommended,
  matchingControls,
  matchingControlsCoverDomain,
  matchingSpecOf,
  parseNumber,
  presetBaseName,
  presetLimit,
  presetOptions,
  restoreCalibratedUpdate,
  savePresetUpdate,
  selectPresetUpdate,
  updateForValue,
  valueOf
} from "./matching-model";

const en = createTranslator("en");
const ptBR = createTranslator("pt-BR");

const customId = "9d1c5a2e-4b1f-4d6a-9b0e-3f5c7a1d2e40";
const customConfiguration = MatchingConfigurationSchema.parse({
  ...recommendedMatchingConfiguration,
  sourceRelationSettings: {
    ...recommendedMatchingConfiguration.sourceRelationSettings,
    minConfidence: 0.8
  }
});
const base: AppSettings = {
  ...defaultAppSettings,
  language: "en",
  updatedAt: "2026-11-12T09:00:00.000Z"
} as AppSettings;
const custom: AppSettings = {
  ...base,
  ...customConfiguration,
  matchingPresets: [{ id: customId, name: "Confidence test", settings: customConfiguration }],
  activeMatchingPresetId: customId
};

describe("the matching controls", () => {
  it("cover exactly the values the domain lists, each one a registry entry of Advanced", () => {
    expect(matchingControlsCoverDomain()).toBe(true);
    const advanced = settingsRegistryV2.filter((entry) => entry.section === "advanced");
    for (const control of matchingControls) {
      const entry = advanced.find((candidate) => candidate.id === control.id);
      expect(entry, control.id).toBeDefined();
      expect(entry?.group).toBe("matching");
    }
    expect(matchingSpecOf("debugMode")).toBeNull();
  });

  it("hold the limits the schemas hold: the calibrated value is inside, and a limit is never wider", () => {
    for (const control of matchingControls) {
      if (control.kind === "switch") continue;
      const calibrated = valueOf(base, control.id) as number;
      expect(calibrated, control.id).toBeGreaterThanOrEqual(control.min);
      expect(calibrated, control.id).toBeLessThanOrEqual(control.max);
      // The schema accepts both ends, so the field may offer both.
      const edges = [control.min, control.max].map(
        (edge) => MatchingConfigurationSchema.safeParse(updateFor(control.id, edge)).success
      );
      expect(edges, control.id).toEqual([true, true]);
    }
  });
});

/** The configuration with one value set, for the schema. */
function updateFor(id: (typeof matchingControls)[number]["id"], value: number) {
  const update = updateForValue(base, id, value) as Record<string, unknown>;
  return { ...recommendedMatchingConfiguration, ...update };
}

describe("numbers", () => {
  it("reads a comma or a dot for the decimals and a thousands mark in the person's language", () => {
    expect(parseNumber("0,92", "pt-BR")).toBe(0.92);
    expect(parseNumber("0.92", "en")).toBe(0.92);
    expect(parseNumber("0.92", "pt-BR")).toBe(0.92);
    expect(parseNumber("4.096", "pt-BR")).toBe(4096);
    expect(parseNumber("4,096", "en")).toBe(4096);
    expect(parseNumber("4096", "fr")).toBe(4096);
    expect(parseNumber("4 096", "fr")).toBe(4096);
    expect(parseNumber(" 12 ", "en")).toBe(12);
  });

  it("refuses text that is not a number", () => {
    for (const text of ["", "  ", "abc", "1,2,3x", "--1", "1e5"])
      expect(parseNumber(text, "en"), text).toBeNull();
  });

  it("clamps to the limits, whole for the integers and to two decimals for the others", () => {
    const decimal = matchingSpecOf("relationTypeSimilarityThreshold")!;
    const whole = matchingSpecOf("canonicalMatchingSettings.confirmationBatchSize")!;
    expect(clampValue(decimal, 1.7)).toBe(1);
    expect(clampValue(decimal, -3)).toBe(0);
    expect(clampValue(decimal, 0.923)).toBe(0.92);
    expect(clampValue(whole, 99)).toBe(12);
    expect(clampValue(whole, 0)).toBe(1);
    expect(clampValue(whole, 7.6)).toBe(8);
  });

  it("shows decimals with two digits and whole numbers grouped, in the interface language", () => {
    const decimal = matchingSpecOf("sourceRelationSettings.minConfidence")!;
    const whole = matchingSpecOf("sourceRelationSettings.maxInputTokens")!;
    expect(formatValue(decimal, 0.8, "pt-BR")).toBe("0,80");
    expect(formatValue(decimal, 0.8, "en")).toBe("0.80");
    expect(formatValue(whole, 60000, "pt-BR")).toBe("60.000");
    expect(formatValue(whole, 60000, "en")).toBe("60,000");
  });
});

describe("what differs from the calibrated set", () => {
  it("is nothing for the recommendation, and names the one value that moved, in words", () => {
    expect(differencesOf(base)).toEqual([]);
    expect(isRecommended(base)).toBe(true);
    const differences = differencesOf(custom);
    expect(differences.map((difference) => difference.id)).toEqual([
      "sourceRelationSettings.minConfidence"
    ]);
    expect(isRecommended(custom)).toBe(false);
    expect(differenceText(ptBR, differences[0]!, () => "Confiança mínima")).toBe(
      "Confiança mínima (0,80 em vez de 0,85)"
    );
    expect(differenceText(en, differences[0]!, () => "Minimum confidence")).toBe(
      "Minimum confidence (0.80 instead of 0.85)"
    );
  });

  it("restores the calibrated values and the recommendation, and keeps the saved presets", () => {
    const update = restoreCalibratedUpdate(custom);
    expect(update.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
    expect(update.matchingPresets).toBe(custom.matchingPresets);
    expect(update.sourceRelationSettings).toEqual(
      recommendedMatchingConfiguration.sourceRelationSettings
    );
  });
});

describe("one value", () => {
  it("is written as the changed group alone, with the rest of its group, and a top-level value as itself", () => {
    expect(updateForValue(custom, "relationTypeSimilarityThreshold", 0.9)).toEqual({
      relationTypeSimilarityThreshold: 0.9
    });
    expect(updateForValue(custom, "sourceRelationSettings.maxRelationsPerPair", 6)).toEqual({
      sourceRelationSettings: {
        ...customConfiguration.sourceRelationSettings,
        maxRelationsPerPair: 6
      }
    });
    expect(updateForValue(custom, "sourceRelationSettings.includeWeakTypes", true)).toEqual({
      sourceRelationSettings: {
        ...customConfiguration.sourceRelationSettings,
        includeWeakTypes: true
      }
    });
  });
});

describe("presets", () => {
  it("lists the recommendation first, then each saved one; a changed one reads Custom and an unnamed one Earlier", () => {
    const named = presetOptions(en, custom);
    expect(named.map((option) => option.label)).toEqual([
      "Balanced (recommended)",
      "Custom: Confidence test"
    ]);
    const unnamed = presetOptions(en, {
      matchingPresets: [{ id: customId, name: null, settings: customConfiguration }]
    });
    expect(unnamed[1]?.label).toBe("Earlier settings");
    const same = presetOptions(en, {
      matchingPresets: [{ id: customId, name: "Mine", settings: recommendedMatchingConfiguration }]
    });
    expect(same[1]?.label).toBe("Mine");
  });

  it("selects a preset by giving its values as the effective ones, and none that does not exist", () => {
    const update = selectPresetUpdate(custom, customId);
    expect(update?.activeMatchingPresetId).toBe(customId);
    expect(update?.sourceRelationSettings).toEqual(customConfiguration.sourceRelationSettings);
    expect(selectPresetUpdate(custom, recommendedMatchingPresetId)?.activeMatchingPresetId).toBe(
      recommendedMatchingPresetId
    );
    expect(selectPresetUpdate(custom, "unknown")).toBeNull();
  });

  it("creates from the calibrated set, duplicates the values on screen, and renames in place", () => {
    const created = savePresetUpdate(custom, "create", "  Fresh  ", () => "new-id");
    expect(created?.activeMatchingPresetId).toBe("new-id");
    expect(created?.matchingPresets?.at(-1)).toEqual({
      id: "new-id",
      name: "Fresh",
      settings: recommendedMatchingConfiguration
    });
    expect(created?.matchingPresets).toHaveLength(2);
    const duplicated = savePresetUpdate(custom, "duplicate", "Copy", () => "copy-id");
    expect(duplicated?.matchingPresets?.at(-1)?.settings).toEqual(customConfiguration);
    const renamed = savePresetUpdate(custom, "rename", "Better name", () => "unused");
    expect(renamed?.activeMatchingPresetId).toBe(customId);
    expect(renamed?.matchingPresets).toHaveLength(1);
    expect(renamed?.matchingPresets?.[0]?.name).toBe("Better name");
  });

  it("refuses an empty or too long name, renaming the recommendation, and a 51st preset", () => {
    expect(savePresetUpdate(custom, "create", "   ", () => "x")).toBeNull();
    expect(savePresetUpdate(custom, "create", "x".repeat(101), () => "x")).toBeNull();
    expect(savePresetUpdate(base, "rename", "Name", () => "x")).toBeNull();
    const full: AppSettings = {
      ...custom,
      matchingPresets: Array.from({ length: presetLimit }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        name: `Preset ${index}`,
        settings: customConfiguration
      }))
    };
    expect(savePresetUpdate(full, "duplicate", "One more", () => "x")).toBeNull();
    // Renaming does not add one, so it is allowed at the limit.
    expect(
      savePresetUpdate(
        { ...full, activeMatchingPresetId: full.matchingPresets[0]!.id },
        "rename",
        "Renamed",
        () => "x"
      )
    ).not.toBeNull();
  });

  it("deletes the selected one and goes back to the recommendation; there is nothing to delete on the recommendation", () => {
    const update = deletePresetUpdate(custom);
    expect(update?.matchingPresets).toEqual([]);
    expect(update?.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
    expect(update?.sourceRelationSettings).toEqual(
      recommendedMatchingConfiguration.sourceRelationSettings
    );
    expect(deletePresetUpdate(base)).toBeNull();
  });
});

describe("the name a rename or a copy starts from", () => {
  it("is the preset's own name, not the 'Custom:' label of the selector", () => {
    expect(presetOptions(en, custom).at(-1)?.label).toBe("Custom: Confidence test");
    expect(presetBaseName(en, custom, customId)).toBe("Confidence test");
  });

  it("is the 'previous' label for a preset without a name, and the recommendation's name for it", () => {
    const unnamed = { ...custom, matchingPresets: [{ ...custom.matchingPresets[0]!, name: null }] };
    expect(presetBaseName(en, unnamed, customId)).toBe(
      en("settingsAdvanced.matching.presetPrevious")
    );
    expect(presetBaseName(en, custom, recommendedMatchingPresetId)).toBe(
      en("settingsAdvanced.matching.presetRecommended")
    );
  });
});
