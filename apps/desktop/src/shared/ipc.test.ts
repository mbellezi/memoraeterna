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
  searchInputSchema,
  atomicNoteReviewInputSchema,
  sourceDetailSchema
  , aiProfileTaskInputSchema
  , localModelDownloadInputSchema
  , localModelViewSchema
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

  it("validates phase 3 source details and review actions", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(atomicNoteReviewInputSchema.parse({ id, action: "approve" })).toEqual({ id, action: "approve" });
    expect(() => atomicNoteReviewInputSchema.parse({ id, action: "edit" })).toThrow();
    expect(sourceDetailSchema.parse({
      id,
      type: "PersonalNote",
      title: "Source",
      subtitle: null,
      sourceUri: null,
      language: "en",
      summary: null,
      metadata: {},
      updatedAt: new Date(0).toISOString(),
      documents: [],
      summaries: [],
      atomicNotes: [],
      relations: []
    }).title).toBe("Source");
  });

  it("validates phase 5 local model commands and profile selections", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(localModelDownloadInputSchema.parse({ catalogId: "mlx-test" })).toEqual({
      catalogId: "mlx-test",
      acceptLicense: false
    });
    expect(aiProfileTaskInputSchema.parse({
      profileId: id,
      task: "summarization",
      localModelId: id,
      modelId: "local/model",
      runtime: "mlx",
      requiredCapabilities: ["summarization"]
    }).runtime).toBe("mlx");
    expect(() => aiProfileTaskInputSchema.parse({
      profileId: id,
      task: "summarization",
      modelId: "missing-source",
      runtime: "remote",
      requiredCapabilities: []
    })).toThrow();
    expect(localModelViewSchema.parse({
      id, catalogId: "mlx-test", modelId: "repo/model", displayName: "Model",
      family: "Family", variant: "Variant", repository: "repo/model", revision: "a".repeat(40),
      runtime: "mlx", format: "safetensors", quantization: "4-bit",
      capabilities: ["offline"], minimumMemoryBytes: 1, recommendedMemoryBytes: 2,
      expectedSizeBytes: 10, installedSizeBytes: 0, licenseName: "Test",
      licenseUrl: "https://example.test/license", requiresLicenseAcceptance: false,
      licenseAccepted: false, status: "not_downloaded", compatible: true,
      compatibilityReason: "compatible", profilesUsing: [], lastError: null, download: null
    }).catalogId).toBe("mlx-test");
  });
});
