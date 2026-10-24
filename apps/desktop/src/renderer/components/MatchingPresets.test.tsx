import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";
import {
  MatchingConfigurationSchema,
  matchingValueControlIds,
  recommendedMatchingConfiguration
} from "@app/domain";
import { appSettingsSchema, defaultAppSettings, defaultStorageSettings } from "../../shared/ipc";
import { matchingControlDomIds } from "../../shared/settings-registry";
import { SettingsView } from "./SettingsView";

const presetId = "afbec711-07cd-43b1-8088-153df3dc5f73";

describe("matching preset interface (Settings › Knowledge › Advanced › Matching settings)", () => {
  const settings = appSettingsSchema.parse({
    ...defaultAppSettings,
    language: "en",
    updatedAt: new Date().toISOString()
  });
  /** A custom preset named "My preset"; `changes` moves some of its values off the calibrated set. */
  function custom(name: string | null, changes: Record<string, unknown> = {}) {
    const configuration = MatchingConfigurationSchema.parse({
      ...settings,
      ...changes,
      sourceRelationSettings: {
        ...settings.sourceRelationSettings,
        ...((changes.sourceRelationSettings as object | undefined) ?? {})
      }
    });
    return {
      ...settings,
      ...configuration,
      activeMatchingPresetId: presetId,
      matchingPresets: [{ id: presetId, name, settings: configuration }]
    };
  }
  function render(
    appSettings: typeof settings = settings,
    activeScope: "knowledge" | "overview" = "knowledge",
    locale: Parameters<typeof createTranslator>[0] = "en"
  ) {
    return renderToStaticMarkup(
      <SettingsView
        activeScope={activeScope}
        appSettings={appSettings}
        settings={{ ...defaultStorageSettings, updatedAt: settings.updatedAt }}
        isSaving={false}
        t={createTranslator(locale)}
        onAppSettingsChange={() => {}}
        onChange={() => {}}
        onSelectObsidianVault={async () => {}}
        onScopeChange={() => {}}
        onToast={() => {}}
      />
    );
  }

  it("keeps the built-in recommendation visible and protected, with individual reset actions for every variable", () => {
    const html = render();
    expect(html).toContain("Matching settings");
    expect(html).toContain("Balanced — recommended");
    expect(html).toContain("Create preset");
    expect(html).toContain("Duplicate preset");
    expect(html).not.toContain("Delete preset");
    expect(html).toContain('<fieldset disabled=""');
    expect(html.match(/aria-label="[^"]+: Restore recommended value"/g)).toHaveLength(16);
    const slider = (id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    expect(slider("sourceRelations-minImportance")).toContain('value="0.75"');
    expect(slider("sourceRelations-minConfidence")).toContain('value="0.85"');
  });

  it("shows all 17 matching controls inside an Advanced disclosure of the Knowledge scope", () => {
    const html = render();
    const advanced = html.slice(html.indexOf("<details"));
    for (const id of matchingValueControlIds)
      expect(advanced, id).toContain(`id="${matchingControlDomIds[id]}"`);
    expect(advanced).toContain('id="matching-preset"');
    // None of them is outside the disclosure.
    expect(html.slice(0, html.indexOf("<details"))).not.toContain('id="matching-preset"');
  });

  it("offers no control for a note setting that stopped deciding anything", () => {
    for (const html of [render(), render(custom("My preset"))]) {
      expect(html).toContain("AI output token limit per note");
      expect(html).toContain("Atomic notes");
      expect(html).toContain("Entity and relation-type identity");
      for (const removed of [
        "Minimum match score",
        "Restore note defaults",
        "Fewer, stricter relations",
        "Scoring weights",
        "With embeddings and graph",
        "Candidates sent to AI per note",
        "New relations per note per execution",
        "Allow generic mentions and related links"
      ])
        expect(html).not.toContain(removed);
      expect(html).not.toContain('id="atomicNoteRelationThreshold"');
    }
  });

  it("shows the active preset, not a score threshold, in the settings overview", () => {
    const recommended = render(settings, "overview");
    expect(recommended).toContain("Matching preset");
    expect(recommended).toContain("Balanced — recommended");
    expect(recommended).not.toContain("Matching threshold");
    expect(recommended).not.toContain("0.60");
    expect(render(custom("My preset"), "overview")).toContain("My preset");
    // Away from the calibrated set it reads Custom.
    expect(
      render(custom("My preset", { relationTypeSimilarityThreshold: 0.8 }), "overview")
    ).toContain("Custom: My preset");
  });

  it("makes custom presets editable and exposes rename and deletion", () => {
    const html = render(custom("My preset"));
    expect(html).toContain("My preset");
    expect(html).toContain("Rename");
    expect(html).toContain("Delete preset");
    expect(html).not.toContain('<fieldset disabled=""');
  });

  describe("a value away from the calibrated set", () => {
    const away = () =>
      custom(null, {
        relationTypeSimilarityThreshold: 0.8,
        sourceRelationSettings: { maxRelationsPerPair: 6, includeWeakTypes: true }
      });

    it("shows no notice while every value is the calibrated one", () => {
      for (const html of [render(), render(custom("My preset"))]) {
        expect(html).not.toContain("differ from the calibrated set");
        expect(html).not.toContain("Restore calibrated values");
        expect(html).not.toContain("Calibrated: ");
      }
    });

    it("says so, offers to restore them and counts the controls that differ", () => {
      const html = render(away());
      expect(html).toContain(
        "These values differ from the calibrated set; relations found with them were not measured."
      );
      expect(html).toContain("Restore calibrated values");
      expect(html).toContain("Values that differ: 3");
      // The notice sits in a status region, so it is announced when it appears.
      expect(html).toMatch(
        /<div role="status"[^>]*>\s*<div[^>]*>[^]*differ from the calibrated set/u
      );
    });

    it("shows the calibrated value beside each differing control, in text, and beside no other", () => {
      const html = render(away());
      expect(html.match(/Calibrated: /g)).toHaveLength(3);
      expect(html).toContain("Calibrated: 0.92");
      expect(html).toContain("Calibrated: 4");
      expect(html).toContain("Calibrated: Off");
      // The text follows its own control.
      const around = (id: string, text: string) => {
        const from = html.indexOf(
          `id="${matchingControlDomIds[id as keyof typeof matchingControlDomIds]}"`
        );
        return html.slice(from, from + 1500).includes(text);
      };
      expect(around("relationTypeSimilarityThreshold", "Calibrated: 0.92")).toBe(true);
      expect(around("sourceRelationSettings.maxRelationsPerPair", "Calibrated: 4")).toBe(true);
      expect(around("sourceRelationSettings.includeWeakTypes", "Calibrated: Off")).toBe(true);
      expect(html).not.toMatch(/id="entityIdentitySimilarityThreshold"[^]{0,900}Calibrated:/u);
    });

    it("makes the preset selector read Custom, with the name when the preset has one", () => {
      expect(render(away())).toMatch(/<option[^>]*selected=""[^>]*>Custom<\/option>/u);
      const named = render(custom("My preset", { relationTypeSimilarityThreshold: 0.8 }));
      expect(named).toMatch(/<option[^>]*selected=""[^>]*>Custom: My preset<\/option>/u);
      // The built-in recommendation keeps its own name.
      expect(render()).toMatch(/<option[^>]*selected=""[^>]*>Balanced — recommended<\/option>/u);
    });

    it("says the same in every interface language", () => {
      for (const locale of ["pt-BR", "it", "fr", "es"] as const) {
        const t = createTranslator(locale);
        const html = render(away(), "knowledge", locale);
        expect(html, locale).toContain(t("settings.matching.calibration.notice"));
        expect(html, locale).toContain(t("settings.matching.calibration.restore"));
        expect(html, locale).toContain(
          t("settings.matching.calibration.calibrated", { values: { value: "0.92" } })
        );
        expect(html, locale).not.toContain("[[missing");
        expect(html, locale).toContain(`>${t("settings.matching.presets.previous")}</option>`);
      }
      // The copy is not the English text left in place.
      expect(createTranslator("pt-BR")("settings.matching.calibration.notice")).not.toBe(
        createTranslator("en")("settings.matching.calibration.notice")
      );
    });
  });

  it("restores the calibrated values by selecting the recommendation, keeping the saved presets", async () => {
    const { restoreCalibratedUpdate } = await import("./settings/matching-group-model");
    const away = custom("My preset", { relationTypeSimilarityThreshold: 0.8 });
    const update = restoreCalibratedUpdate(away);
    expect(update.activeMatchingPresetId).toBe("recommended-v2");
    expect(update.matchingPresets).toEqual(away.matchingPresets);
    expect(MatchingConfigurationSchema.parse(update)).toEqual(recommendedMatchingConfiguration);
  });
});
