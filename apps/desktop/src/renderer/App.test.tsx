import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
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
    expect(navigation.match(/<button/g)).toHaveLength(10);
  });
});
