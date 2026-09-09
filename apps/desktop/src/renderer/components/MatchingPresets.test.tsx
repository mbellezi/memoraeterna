import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";
import { MatchingConfigurationSchema } from "@app/domain";
import { appSettingsSchema, defaultAppSettings, defaultStorageSettings } from "../../shared/ipc";
import { SettingsView } from "./SettingsView";

describe("matching preset interface", () => {
  const settings = appSettingsSchema.parse({ ...defaultAppSettings, language: "en", updatedAt: new Date().toISOString() });
  function render(custom: boolean) {
    const id = "afbec711-07cd-43b1-8088-153df3dc5f73";
    return renderToStaticMarkup(<SettingsView activeScope="matching" appSettings={custom ? { ...settings, activeMatchingPresetId: id, matchingPresets: [{ id, name: "My preset", settings: MatchingConfigurationSchema.parse(settings) }] } : settings}
      settings={{ ...defaultStorageSettings, updatedAt: settings.updatedAt }} isSaving={false} t={createTranslator("en")}
      onAppSettingsChange={() => {}} onChange={() => {}} onSelectObsidianVault={async () => {}} onScopeChange={() => {}} onToast={() => {}} />);
  }
  it("keeps the built-in recommendation visible and protected, with individual reset actions for every variable", () => {
    const html = render(false);
    expect(html).toContain("Balanced — recommended");
    expect(html).toContain("Duplicate preset");
    expect(html).toContain('<fieldset disabled=""');
    expect(html.match(/aria-label="[^"]+: Restore recommended value"/g)).toHaveLength(45);
    expect(html).toContain('value="0.85"');
  });
  it("makes copies editable and exposes rename", () => {
    const html = render(true);
    expect(html).toContain("My preset");
    expect(html).toContain("Rename");
    expect(html).not.toContain('<fieldset disabled=""');
  });
});
