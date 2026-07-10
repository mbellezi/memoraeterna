import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import {
  appSettingsSchema,
  defaultAppSettings,
  defaultStorageSettings,
  storageSettingsSchema
} from "../shared/ipc";

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
    expect(html).toContain("Settings");
  });
});
