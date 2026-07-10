import { describe, expect, it } from "vitest";
import {
  appSettingsSchema,
  appSettingsUpdateSchema,
  databaseStatusSchema,
  defaultAppSettings,
  defaultStorageSettings,
  storageSettingsSchema,
  storageSettingsUpdateSchema,
  systemInfoSchema
} from "./ipc";
import {
  manualIngestionInputSchema,
  searchInputSchema
} from "./ipc";

describe("desktop IPC contracts", () => {
  it("parses database lifecycle status responses", () => {
    expect(
      databaseStatusSchema.parse({
        state: "migrating",
        messageKey: "database.status.migrating",
        updatedAt: new Date(0).toISOString()
      })
    ).toMatchObject({
      state: "migrating"
    });

    expect(() =>
      databaseStatusSchema.parse({
        state: "running",
        messageKey: "database.status.ready",
        updatedAt: new Date(0).toISOString()
      })
    ).toThrow();
  });

  it("parses the exposed system info response", () => {
    expect(
      systemInfoSchema.parse({
        appName: "Memora Eterna",
        locale: "en",
        platform: "darwin",
        versions: {
          electron: "43.0.0",
          node: "24.17.0"
        }
      })
    ).toMatchObject({
      platform: "darwin"
    });
  });

  it("accepts partial settings updates and rejects unknown fields", () => {
    expect(storageSettingsUpdateSchema.parse({ managedRoot: "Memora" })).toEqual({
      managedRoot: "Memora"
    });

    expect(() => storageSettingsUpdateSchema.parse({ unknown: true })).toThrow();
  });

  it("parses app appearance and language settings", () => {
    expect(
      appSettingsSchema.parse({
        ...defaultAppSettings,
        language: "pt-BR",
        updatedAt: new Date(0).toISOString()
      })
    ).toMatchObject({
      language: "pt-BR",
      themeMode: "dark"
    });

    expect(appSettingsUpdateSchema.parse({ themeMode: "light" })).toEqual({
      themeMode: "light"
    });
    expect(() => appSettingsUpdateSchema.parse({ language: "de" })).toThrow();
  });

  it("parses persisted storage settings", () => {
    expect(
      storageSettingsSchema.parse({
        ...defaultStorageSettings,
        updatedAt: new Date(0).toISOString()
      })
    ).toMatchObject({
      managedRoot: "Memora",
      deletionPolicy: "tombstone"
    });
  });

  it("validates phase 2 ingestion and search payloads", () => {
    expect(manualIngestionInputSchema.parse({
      sourceType: "PersonalNote",
      title: "An idea",
      content: "Evidence",
      metadata: {}
    })).toMatchObject({ duplicatePolicy: "ignore" });
    expect(() => manualIngestionInputSchema.parse({
      sourceType: "PodcastEpisode",
      title: "Outside the MVP",
      content: "No"
    })).toThrow();
    expect(searchInputSchema.parse({ text: "memory" })).toMatchObject({ mode: "hybrid", limit: 20 });
  });
});
