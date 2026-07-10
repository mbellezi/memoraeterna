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
  , aiProfileCreateSchema
  , aiTaskRouteSchema
  , localModelDownloadInputSchema
  , localModelViewSchema
  , libraryResetResultSchema
  , similarityDebugRunSchema
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
    })).toEqual({ profileId: id, task: "summarization", parameters: {} });
    expect(aiProfileCreateSchema.parse({ name: "Portuguese" })).toMatchObject({
      outputLanguage: "ui"
    });
    expect(aiTaskRouteSchema.parse({ task: "embedding", profileId: id })).toEqual({
      task: "embedding", profileId: id
    });
    expect(localModelViewSchema.parse({
      id, catalogId: "mlx-test", modelId: "repo/model", displayName: "Model",
      family: "Family", variant: "Variant", repository: "repo/model", revision: "a".repeat(40),
      runtime: "mlx", format: "safetensors", quantization: "4-bit",
      capabilities: ["offline"], defaultParameters: { contextWindow: 4096 },
      minimumMemoryBytes: 1, recommendedMemoryBytes: 2,
      expectedSizeBytes: 10, installedSizeBytes: 0, licenseName: "Test",
      licenseUrl: "https://example.test/license", requiresLicenseAcceptance: false,
      licenseAccepted: false, status: "not_downloaded", compatible: true,
      compatibilityReason: "compatible", profilesUsing: [], lastError: null, download: null
    }).catalogId).toBe("mlx-test");
  });

  it("validates the destructive library reset result", () => {
    expect(libraryResetResultSchema.parse({
      deletedSources: 2,
      deletedAtomicNotes: 3,
      deletedFiles: 4,
      failedFiles: 0
    })).toEqual({ deletedSources: 2, deletedAtomicNotes: 3, deletedFiles: 4, failedFiles: 0 });
  });

  it("validates similarity debug runs and score details", () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const resultId = "00000000-0000-4000-8000-000000000002";
    expect(similarityDebugRunSchema.parse({
      id: runId,
      kind: "atomic_note_matching",
      queryText: "Atomic idea",
      queryTargetId: resultId,
      mode: "hybrid",
      model: "embed-model",
      dimensions: 1024,
      requestedLimit: 20,
      strategy: "weighted_scores_with_optional_reranking",
      metadata: { threshold: 0.72 },
      createdAt: new Date(0).toISOString(),
      results: [{
        id: resultId,
        runId,
        targetType: "atomic_note",
        targetId: resultId,
        targetLabel: "Candidate",
        finalRank: 1,
        textRank: 2,
        vectorRank: 1,
        textScore: 0.4,
        vectorScore: 0.8,
        metadataScore: 0.5,
        rerankScore: 0.9,
        fusionScore: null,
        finalScore: 0.81,
        passedThreshold: true,
        explanation: "related",
        metadata: { rerankStatus: "succeeded" },
        createdAt: new Date(0).toISOString()
      }]
    }).results[0]?.rerankScore).toBe(0.9);
  });
});
