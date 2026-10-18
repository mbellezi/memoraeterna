import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";
import { MatchingConfigurationSchema } from "@app/domain";
import { appSettingsSchema, defaultAppSettings, defaultStorageSettings } from "../../shared/ipc";
import { SettingsView } from "./SettingsView";

describe("matching preset interface", () => {
  const settings = appSettingsSchema.parse({
    ...defaultAppSettings,
    language: "en",
    updatedAt: new Date().toISOString()
  });
  function render(custom: boolean, activeScope: "matching" | "overview" = "matching") {
    const id = "afbec711-07cd-43b1-8088-153df3dc5f73";
    return renderToStaticMarkup(
      <SettingsView
        activeScope={activeScope}
        appSettings={
          custom
            ? {
                ...settings,
                activeMatchingPresetId: id,
                matchingPresets: [
                  { id, name: "My preset", settings: MatchingConfigurationSchema.parse(settings) }
                ]
              }
            : settings
        }
        settings={{ ...defaultStorageSettings, updatedAt: settings.updatedAt }}
        isSaving={false}
        t={createTranslator("en")}
        onAppSettingsChange={() => {}}
        onChange={() => {}}
        onSelectObsidianVault={async () => {}}
        onScopeChange={() => {}}
        onToast={() => {}}
      />
    );
  }
  it("keeps the built-in recommendation visible and protected, with individual reset actions for every variable", () => {
    const html = render(false);
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
  it("offers no control for a note setting that stopped deciding anything", () => {
    for (const html of [render(false), render(true)]) {
      expect(html).toContain("AI output token limit per note");
      expect(html).toContain("Atomic notes");
      expect(html).toContain("Entity and relation-type identity");
      for (const removed of [
        "Minimum match score",
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
    const recommended = render(false, "overview");
    expect(recommended).toContain("Matching preset");
    expect(recommended).toContain("Balanced — recommended");
    expect(recommended).not.toContain("Matching threshold");
    expect(recommended).not.toContain("0.60");
    expect(render(true, "overview")).toContain("My preset");
  });
  it("makes custom presets editable and exposes rename and deletion", () => {
    const html = render(true);
    expect(html).toContain("My preset");
    expect(html).toContain("Rename");
    expect(html).toContain("Delete preset");
    expect(html).not.toContain('<fieldset disabled=""');
  });
});
