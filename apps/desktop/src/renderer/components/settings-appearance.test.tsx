import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import {
  appSettingsSchema,
  defaultAppSettings,
  defaultStorageSettings,
  themeModeSchema,
  type ThemeMode
} from "../../shared/ipc";
import { SettingsView } from "./SettingsView";

function render(themeMode: ThemeMode, language: (typeof supportedLanguageCodes)[number] = "en") {
  const appSettings = appSettingsSchema.parse({
    ...defaultAppSettings,
    themeMode,
    language,
    updatedAt: new Date(0).toISOString()
  });
  return renderToStaticMarkup(
    <SettingsView
      activeScope="personalization"
      appSettings={appSettings}
      settings={{ ...defaultStorageSettings, updatedAt: appSettings.updatedAt }}
      isSaving={false}
      t={createTranslator(language)}
      onAppSettingsChange={() => undefined}
      onChange={() => undefined}
      onSelectObsidianVault={async () => undefined}
      onScopeChange={() => undefined}
      onToast={() => undefined}
    />
  );
}

describe("the theme choice in Settings", () => {
  it("offers Light, Dark and System, with the current choice pressed", () => {
    for (const mode of themeModeSchema.options) {
      const html = render(mode);
      const buttons = [...html.matchAll(/<button[^>]*aria-label="(Light|Dark|System)"[^>]*>/gu)];
      expect(
        buttons.map((match) => match[1]),
        mode
      ).toEqual(["Light", "Dark", "System"]);
      const active = buttons.filter((match) => match[0].includes('aria-pressed="true"'));
      expect(
        active.map((match) => match[1]),
        mode
      ).toEqual([{ light: "Light", dark: "Dark", system: "System" }[mode]]);
    }
  });

  it("starts on System for a new install and on the stored choice otherwise", () => {
    expect(defaultAppSettings.themeMode).toBe("system");
    expect(render(defaultAppSettings.themeMode)).toMatch(
      /aria-label="System"[^>]*aria-pressed="true"/u
    );
    expect(render("dark")).toMatch(/aria-label="Dark"[^>]*aria-pressed="true"/u);
    expect(render("dark")).toMatch(/aria-label="System"[^>]*aria-pressed="false"/u);
  });

  it("is written in every interface language", () => {
    for (const language of supportedLanguageCodes) {
      const t = createTranslator(language);
      const html = render("system", language);
      for (const mode of themeModeSchema.options) {
        const label = t(`settings.appearance.themeModes.${mode}`);
        expect(label, `${language} ${mode}`).not.toContain("[[missing");
        expect(html, `${language} ${mode}`).toContain(`aria-label="${label}"`);
      }
      // The three labels differ, so each choice can be told apart.
      expect(
        new Set(themeModeSchema.options.map((mode) => t(`settings.appearance.themeModes.${mode}`)))
          .size
      ).toBe(3);
    }
  });
});
