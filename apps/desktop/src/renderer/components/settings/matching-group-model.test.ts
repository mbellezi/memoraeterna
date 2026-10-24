import {
  MatchingConfigurationSchema,
  matchingValueControlIds,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId
} from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { describe, expect, it } from "vitest";

import { appSettingsSchema, defaultAppSettings } from "../../../shared/ipc";
import {
  formatMatchingValue,
  matchingGroupModel,
  matchingPresetLabel,
  restoreCalibratedUpdate
} from "./matching-group-model";

const t = createTranslator("en");
const presetId = "afbec711-07cd-43b1-8088-153df3dc5f73";
const base = appSettingsSchema.parse({
  ...defaultAppSettings,
  language: "en",
  updatedAt: new Date(0).toISOString()
});

function withPreset(name: string | null, source: Record<string, unknown> = {}) {
  const configuration = MatchingConfigurationSchema.parse({ ...base, ...source });
  return {
    ...base,
    ...configuration,
    activeMatchingPresetId: presetId,
    matchingPresets: [{ id: presetId, name, settings: configuration }]
  };
}

describe("the matching group against the calibrated set", () => {
  it("is the calibrated set by default: recommended, read-only, nothing differs", () => {
    const model = matchingGroupModel(base, t);
    expect(model.isRecommended).toBe(true);
    expect(model.differences).toEqual([]);
    expect(model.calibratedText.size).toBe(0);
    expect(model.selectedPresetId).toBe(recommendedMatchingPresetId);
    expect(model.options).toEqual([
      { id: recommendedMatchingPresetId, label: "Balanced — recommended" }
    ]);
    expect(model.configuration).toEqual(recommendedMatchingConfiguration);
  });

  it("lists the controls that differ with their calibrated value as text", () => {
    const model = matchingGroupModel(
      withPreset("Mine", {
        entityIdentitySimilarityThreshold: 0.8,
        canonicalMatchingSettings: {
          ...recommendedMatchingConfiguration.canonicalMatchingSettings,
          confirmationMaxCharacters: 9000
        },
        sourceRelationSettings: {
          ...recommendedMatchingConfiguration.sourceRelationSettings,
          maxInputTokens: 30000,
          includeWeakTypes: true
        }
      }),
      t
    );
    expect(model.isRecommended).toBe(false);
    expect(model.differences.map((difference) => difference.id)).toEqual([
      "entityIdentitySimilarityThreshold",
      "canonicalMatchingSettings.confirmationMaxCharacters",
      "sourceRelationSettings.maxInputTokens",
      "sourceRelationSettings.includeWeakTypes"
    ]);
    expect([...model.calibratedText]).toEqual([
      ["entityIdentitySimilarityThreshold", "0.92"],
      ["canonicalMatchingSettings.confirmationMaxCharacters", "12,000"],
      ["sourceRelationSettings.maxInputTokens", "60,000"],
      ["sourceRelationSettings.includeWeakTypes", "Off"]
    ]);
  });

  it("names the preset away from the calibrated set Custom, with its name when it has one", () => {
    const differs = { relationTypeSimilarityThreshold: 0.7 };
    expect(matchingGroupModel(withPreset(null, differs), t).options.at(-1)?.label).toBe("Custom");
    expect(matchingGroupModel(withPreset("Mine", differs), t).options.at(-1)?.label).toBe(
      "Custom: Mine"
    );
    // A named preset that equals the calibrated set keeps its name; an unnamed one is Custom.
    expect(matchingGroupModel(withPreset("Mine"), t).options.at(-1)?.label).toBe("Mine");
    expect(matchingGroupModel(withPreset(null), t).options.at(-1)?.label).toBe("Custom");
    const preset = withPreset("Mine", differs).matchingPresets[0]!;
    expect(matchingPresetLabel(t, preset)).toBe("Custom: Mine");
  });

  it("restores the calibrated values by selecting the recommendation and keeping the presets", () => {
    const away = withPreset("Mine", { relationTypeSimilarityThreshold: 0.7 });
    const restored = restoreCalibratedUpdate(away);
    expect(restored.activeMatchingPresetId).toBe(recommendedMatchingPresetId);
    expect(restored.matchingPresets).toBe(away.matchingPresets);
    expect(MatchingConfigurationSchema.parse(restored)).toEqual(recommendedMatchingConfiguration);
    expect(
      matchingGroupModel({ ...away, ...restored }, t).differences,
      "nothing differs after the restore"
    ).toEqual([]);
  });

  it("formats each value for the interface language", () => {
    expect(formatMatchingValue(t, "sourceRelationSettings.minImportance", 0.75)).toBe("0.75");
    expect(formatMatchingValue(t, "sourceRelationSettings.maxInputTokens", 60000)).toBe("60,000");
    expect(
      formatMatchingValue(createTranslator("pt-BR"), "sourceRelationSettings.maxInputTokens", 60000)
    ).toBe("60.000");
    for (const locale of supportedLanguageCodes) {
      const translate = createTranslator(locale);
      const on = formatMatchingValue(translate, "sourceRelationSettings.includeWeakTypes", true);
      const off = formatMatchingValue(translate, "sourceRelationSettings.includeWeakTypes", false);
      expect(on, locale).not.toBe(off);
      expect(`${on}${off}`, locale).not.toContain("[[missing");
    }
  });

  it("knows every one of the 16 values the group edits", () => {
    for (const id of matchingValueControlIds)
      expect(typeof formatMatchingValue(t, id, 1), id).toBe("string");
  });
});
