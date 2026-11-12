import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
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

  it("stands the first-run view in for the shell while the first run is checked", () => {
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
      />
    );

    expect(html).toContain("Getting ready");
    expect(html).toContain('aria-label="Setup steps"');
    expect(html).not.toContain('id="app-navigation"');
  });

  it("renders the desktop shell after the database is ready without touching Node APIs", () => {
    const html = renderToString(
      <App
        firstRun={false}
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
    // The Library's root is the new table (T149); the old screen's "dark:" classes no longer show.
    expect(html).toContain('data-surface="destination-library"');
    for (const name of ["Home", "Explore", "Library", "Inbox", "Map", "Settings"])
      expect(html).toContain(`aria-label="${name}"`);
    expect(html).toContain('data-surface="shell"');
    expect(html).toContain("h-screen");
    expect(html).toContain("overflow-auto overscroll-contain");
  });

  it("shows the Activity pill in the header, and no modal stands over a model loading", () => {
    const html = renderToString(
      <App
        firstRun={false}
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
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).toContain("Checking activity…");
    expect(header).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-modal="true"');
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
          firstRun={false}
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

describe("the rail", () => {
  const rail = () => {
    const html = renderToString(
      <App
        firstRun={false}
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
      />
    );
    return html.slice(html.indexOf('<nav aria-label="Main navigation"'), html.indexOf("</nav>"));
  };

  it("lists the five worded destinations, Settings and the old screens, with no theme toggle", () => {
    const navigation = rail();
    // Five destinations and Settings are buttons; the old views sit behind one menu.
    expect(navigation.match(/<button/g)).toHaveLength(7);
    for (const word of ["Home", "Explore", "Library", "Inbox", "Map", "Settings", "Old screens"])
      expect(navigation).toContain(`<span>${word}</span>`);
    expect(navigation).not.toContain("Toggle theme");
    expect(navigation).not.toContain("navigation\u0020collapsed");
  });

  it("marks the place the app starts at (Home) as current and shows the Inbox count is being read", () => {
    const navigation = rail();
    expect(navigation.match(/aria-current="page"/g)).toHaveLength(1);
    expect(navigation).toMatch(/aria-label="Home" aria-current="page"/u);
    expect(navigation).toContain('data-state="loading"');
    expect(navigation).toContain("Counting what is waiting for you");
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
        firstRun={false}
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
      const navigation = html.slice(html.indexOf("<nav "), html.indexOf("</nav>"));
      expect(navigation, language).not.toContain(removedAutomationTitle[language]);
      expect(html, language).not.toContain(removedAutomationTitle[language]);
    }
  });

  it("mounts Explore's own root, not the old Wiki screen, for the Explore destination", () => {
    const html = shell("en");
    expect(html).toContain('data-surface="destination-explore"');
    expect(html).not.toContain('aria-labelledby="wiki-placeholder-title"');
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
