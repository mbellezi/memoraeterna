import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createTranslator, messages, supportedLanguageCodes } from "@app/i18n";
import { App } from "./App";
import { SettingsScopeMenu, type SettingsScope } from "./components/SettingsView";
import { useDocumentLanguage } from "./lib/document-language";
import {
  appSettingsSchema,
  defaultAppSettings,
  defaultStorageSettings,
  storageSettingsSchema
} from "../shared/ipc";

// Effects do not run in a server render: spy on the hook that keeps <html lang> in step.
vi.mock("./lib/document-language", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/document-language")>();
  return { ...original, useDocumentLanguage: vi.fn(original.useDocumentLanguage) };
});

describe("App", () => {
  it("renders the database startup screen before the shell", () => {
    const html = renderToString(<App />);

    expect(html).toContain("Starting Memora Eterna");
    expect(html).toContain("Starting the local database");
  });

  it("renders the desktop shell after the database is ready without touching Node APIs", () => {
    const html = renderToString(
      <App
        initialDatabaseStatus={{
          state: "ready",
          messageKey: "database.status.ready",
          updatedAt: new Date(0).toISOString()
        }}
        initialSettings={storageSettingsSchema.parse({
          ...defaultStorageSettings,
          updatedAt: new Date(0).toISOString()
        })}
        initialAppSettings={appSettingsSchema.parse({
          ...defaultAppSettings,
          language: "en",
          updatedAt: new Date(0).toISOString()
        })}
        initialSystemInfo={null}
      />
    );

    expect(html).toContain("Memora Eterna");
    expect(html).toContain("dark");
    expect(html).toContain("Library");
    expect(html).toContain("Review notes");
    expect(html).toContain("Knowledge graph");
    expect(html).toContain("Settings");
    expect(html).toContain("h-screen overflow-hidden");
    expect(html).toContain("overflow-y-auto overscroll-contain");
    expect(html).toContain("overflow-auto overscroll-contain");
  });
});

describe("startup theme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  /** The startup screen markup when the OS is in the given scheme and `stored` was remembered. */
  const startup = (stored: string | null, osDark: boolean, storage: "ok" | "blocked" = "ok") => {
    vi.stubGlobal("window", {
      get localStorage() {
        if (storage === "blocked") throw new Error("blocked");
        return {
          getItem: (key: string) => (key === "memora.themeMode" ? stored : null),
          setItem: () => undefined
        };
      },
      matchMedia: () => ({
        matches: osDark,
        addEventListener: () => undefined,
        removeEventListener: () => undefined
      })
    });
    return renderToString(<App />);
  };
  const bootScreen = (html: string) => html.slice(0, html.indexOf(">"));

  it("draws the remembered Dark theme on a light OS, as an existing install expects", () => {
    expect(bootScreen(startup("dark", false))).toContain("dark");
  });

  it("draws the remembered Light theme on a dark OS", () => {
    expect(bootScreen(startup("light", true))).not.toContain("dark");
  });

  it("starts from the System default where nothing usable is remembered or storage fails", () => {
    // A server render has no live OS scheme, so System draws light; what matters is that none of
    // these cases invents Dark.
    for (const stored of [null, "system", "sepia"])
      expect(bootScreen(startup(stored, true)), String(stored)).not.toContain("dark");
    expect(bootScreen(startup("dark", true, "blocked"))).not.toContain("dark");
  });
});

describe("interface language", () => {
  it("is what the document is marked with, so assistive technology reads the right language", () => {
    const shell = (language: "en" | "pt-BR" | "it" | "fr" | "es") =>
      renderToString(
        <App
          initialDatabaseStatus={{
            state: "ready",
            messageKey: "database.status.ready",
            updatedAt: new Date(0).toISOString()
          }}
          initialSettings={storageSettingsSchema.parse({
            ...defaultStorageSettings,
            updatedAt: new Date(0).toISOString()
          })}
          initialAppSettings={appSettingsSchema.parse({
            ...defaultAppSettings,
            language,
            updatedAt: new Date(0).toISOString()
          })}
        />
      );
    for (const language of ["pt-BR", "it", "fr", "es", "en"] as const) {
      vi.mocked(useDocumentLanguage).mockClear();
      shell(language);
      expect(useDocumentLanguage).toHaveBeenCalledWith(language);
    }
  });
});

describe("compact main navigation", () => {
  it("renders all destinations as named icons with tooltips and retains the active destination", () => {
    const html = renderToString(
      <App
        initialDatabaseStatus={{
          state: "ready",
          messageKey: "database.status.ready",
          updatedAt: new Date(0).toISOString()
        }}
        initialSettings={storageSettingsSchema.parse({
          ...defaultStorageSettings,
          updatedAt: new Date(0).toISOString()
        })}
        initialAppSettings={appSettingsSchema.parse({
          ...defaultAppSettings,
          navigationCollapsed: true,
          language: "en",
          updatedAt: new Date(0).toISOString()
        })}
      />
    );
    expect(html).toContain('aria-label="Expand main navigation"');
    expect(html).toContain('aria-expanded="false" aria-controls="app-navigation"');
    expect(html).toContain('aria-label="Library" aria-current="page" title="Library"');
    expect(html).toContain('aria-label="Settings" title="Settings"');
    expect(html).toContain('aria-label="Toggle theme"');
    expect(html).toContain("w-16");
    const navigation = html.slice(html.indexOf('<nav id="app-navigation"'), html.indexOf("</nav>"));
    expect(navigation).not.toContain(">Library</button>");
    expect(navigation.match(/<button/g)).toHaveLength(9);
  });
});

describe("entry points of the removed wiki", () => {
  /** What the removed Automation destination was called, by language; the copy left the locales. */
  const removedAutomationTitle = {
    en: "Knowledge automation",
    "pt-BR": "Conhecimento automático",
    it: "Conoscenza automatica",
    fr: "Connaissances automatiques",
    es: "Conocimiento automático"
  } as const satisfies Record<(typeof supportedLanguageCodes)[number], string>;
  const shell = (language: (typeof supportedLanguageCodes)[number]) =>
    renderToString(
      <App
        initialDatabaseStatus={{
          state: "ready",
          messageKey: "database.status.ready",
          updatedAt: new Date(0).toISOString()
        }}
        initialSettings={storageSettingsSchema.parse({
          ...defaultStorageSettings,
          updatedAt: new Date(0).toISOString()
        })}
        initialAppSettings={appSettingsSchema.parse({
          ...defaultAppSettings,
          language,
          updatedAt: new Date(0).toISOString()
        })}
      />
    );

  it("has no Automation destination in any language", () => {
    for (const language of supportedLanguageCodes) {
      const html = shell(language);
      const navigation = html.slice(
        html.indexOf('<nav id="app-navigation"'),
        html.indexOf("</nav>")
      );
      expect(navigation, language).not.toContain(removedAutomationTitle[language]);
      expect(html, language).not.toContain(removedAutomationTitle[language]);
    }
  });

  it("shows the Wiki shell with the empty state, not the old workspace, for the Wiki destination", () => {
    const html = shell("en");
    expect(html).toContain('aria-labelledby="wiki-placeholder-title"');
    expect(html).toContain(messages.en.topics.placeholder.openLibrary);
    // The old workspace's page tree and creation controls are not mounted.
    expect(html).not.toContain("New page");
    expect(html).not.toContain("No AI required");
  });

  it("has no Organization or Maintenance scope in Settings", () => {
    const html = renderToString(
      <SettingsScopeMenu
        activeScope="overview"
        t={createTranslator("en")}
        onScopeChange={() => undefined}
      />
    );
    expect(html).toContain("settings-tab-overview");
    expect(html).not.toContain("settings-tab-organization");
    expect(html).not.toContain("settings-tab-maintenance");
    // A scope the Settings view no longer has cannot be asked for.
    expectTypeOf<"organization">().not.toExtend<SettingsScope>();
    expectTypeOf<"maintenance">().not.toExtend<SettingsScope>();
  });
});
