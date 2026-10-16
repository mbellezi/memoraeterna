import { describe, expect, it } from "vitest";
import {
  appSettingsSchema,
  appSettingsUpdateSchema,
  databaseStatusSchema,
  defaultAppSettings,
  defaultStorageSettings,
  ipcChannels,
  storageSettingsSchema,
  storageSettingsUpdateSchema,
  systemInfoSchema,
  themeModeSchema,
  windowNavigationDirectionSchema
} from "./ipc";
import {
  manualIngestionInputSchema,
  searchInputSchema,
  atomicNoteReviewInputSchema,
  sourceDetailSchema,
  atomicNoteViewSchema,
  knowledgeGraphDashboardNodeSchema,
  aiProfileTaskInputSchema,
  aiProfileCreateSchema,
  aiTaskRouteSchema,
  localModelDownloadInputSchema,
  localModelViewSchema,
  libraryResetResultSchema,
  sourceDeletionResultSchema,
  similarityDebugRunSchema,
  fileImportProgressSchema,
  fileMetadataExtractionResultSchema,
  libraryBrowseInputSchema,
  obsidianWikiRetiredMoveSchema,
  obsidianWikiScopeSchema,
  obsidianWikiStatusSchema,
  storedObsidianWikiScopeSchema
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

  it("validates native window navigation events", () => {
    expect(windowNavigationDirectionSchema.parse("back")).toBe("back");
    expect(windowNavigationDirectionSchema.parse("forward")).toBe("forward");
    expect(() => windowNavigationDirectionSchema.parse("up")).toThrow();
  });

  it("accepts partial settings updates and rejects unknown fields", () => {
    expect(storageSettingsUpdateSchema.parse({ managedRoot: "Memora" })).toEqual({
      managedRoot: "Memora"
    });

    expect(() => storageSettingsUpdateSchema.parse({ unknown: true })).toThrow();
  });

  it("defaults library queries to hybrid source search", () => {
    expect(libraryBrowseInputSchema.parse({ query: "memory" })).toMatchObject({
      query: "memory",
      searchMode: "hybrid",
      limit: 48
    });
    expect(
      libraryBrowseInputSchema.parse({ query: "memory", searchMode: "traditional" }).searchMode
    ).toBe("traditional");
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
      // A new install follows the OS appearance until the owner picks a theme.
      themeMode: "system",
      graphWheelZoomSensitivity: 1,
      keepLocalEmbeddingModelsLoaded: true,
      summaryMinimumWordCount: 40,
      knowledgeGraphMaxEntitiesPerSource: 250,
      knowledgeGraphMaxRelationsPerSource: 500
    });

    expect(appSettingsUpdateSchema.parse({ themeMode: "light" })).toEqual({
      themeMode: "light"
    });
    // System, Light and Dark are the three choices; a stored explicit choice stays valid.
    expect(themeModeSchema.options).toEqual(["system", "light", "dark"]);
    for (const themeMode of themeModeSchema.options) {
      expect(appSettingsUpdateSchema.parse({ themeMode })).toEqual({ themeMode });
      expect(
        appSettingsSchema.parse({
          ...defaultAppSettings,
          themeMode,
          language: "en",
          updatedAt: new Date(0).toISOString()
        }).themeMode
      ).toBe(themeMode);
    }
    expect(() => appSettingsUpdateSchema.parse({ themeMode: "auto" })).toThrow();
    expect(appSettingsUpdateSchema.parse({ graphWheelZoomSensitivity: 1.25 })).toEqual({
      graphWheelZoomSensitivity: 1.25
    });
    expect(() => appSettingsUpdateSchema.parse({ graphWheelZoomSensitivity: 1.51 })).toThrow();
    expect(appSettingsUpdateSchema.parse({ summaryMinimumWordCount: 75 })).toEqual({
      summaryMinimumWordCount: 75
    });
    expect(
      appSettingsUpdateSchema.parse({
        knowledgeGraphMaxEntitiesPerSource: 125,
        knowledgeGraphMaxRelationsPerSource: 300
      })
    ).toEqual({
      knowledgeGraphMaxEntitiesPerSource: 125,
      knowledgeGraphMaxRelationsPerSource: 300
    });
    expect(appSettingsUpdateSchema.parse({ keepLocalEmbeddingModelsLoaded: false })).toEqual({
      keepLocalEmbeddingModelsLoaded: false
    });
    expect(() => appSettingsUpdateSchema.parse({ summaryMinimumWordCount: -1 })).toThrow();
    expect(() =>
      appSettingsUpdateSchema.parse({ knowledgeGraphMaxEntitiesPerSource: 0 })
    ).toThrow();
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
    expect(
      manualIngestionInputSchema.parse({
        descriptor: {
          type: "PersonalNote",
          title: "An idea",
          language: "en",
          creators: [],
          tags: [],
          provenance: {}
        },
        content: "Evidence"
      })
    ).toMatchObject({ duplicatePolicy: "ignore" });
    expect(() =>
      manualIngestionInputSchema.parse({
        descriptor: { type: "PodcastEpisode", title: "Outside the MVP" },
        content: "No"
      })
    ).toThrow();
    expect(searchInputSchema.parse({ text: "memory" })).toMatchObject({
      mode: "hybrid",
      limit: 20
    });
    expect(
      fileMetadataExtractionResultSchema.parse({
        fileToken: "00000000-0000-4000-8000-000000000001",
        fileName: "book.epub",
        mimeType: "application/epub+zip",
        draft: {
          sourceType: "Book",
          values: { title: "Book" },
          provenance: { title: { source: "extracted", evidence: "epub-opf" } },
          warnings: []
        }
      }).draft.values.title
    ).toBe("Book");
    expect(
      fileImportProgressSchema.parse({
        requestId: "00000000-0000-4000-8000-000000000001",
        stage: "processing_pages",
        progress: 0.37,
        completedPages: 37,
        totalPages: 100
      })
    ).toMatchObject({ completedPages: 37, totalPages: 100 });
    expect(() =>
      fileImportProgressSchema.parse({
        requestId: "00000000-0000-4000-8000-000000000001",
        stage: "processing_pages",
        progress: 0.37,
        completedPages: 101,
        totalPages: 100
      })
    ).toThrow();
  });

  it("validates phase 3 source details and review actions", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(atomicNoteReviewInputSchema.parse({ id, action: "approve" })).toEqual({
      id,
      action: "approve"
    });
    expect(() => atomicNoteReviewInputSchema.parse({ id, action: "edit" })).toThrow();
    const detail = sourceDetailSchema.parse({
      id,
      type: "PersonalNote",
      title: "Source",
      subtitle: null,
      sourceUri: null,
      language: "en",
      summary: null,
      metadata: {},
      updatedAt: new Date(0).toISOString(),
      assets: [],
      documents: [],
      summaries: [],
      atomicNotes: [],
      relations: []
    });
    expect(detail.title).toBe("Source");
    expect(detail.graph).toEqual({ entities: [], relations: [], sourceConnections: [] });
  });

  it("accepts the active status of a note at birth in note views and graph nodes", () => {
    const view = {
      id: "00000000-0000-4000-8000-000000000001",
      title: "Title",
      bodyMarkdown: "Body",
      ideaStatement: "Idea",
      language: "en",
      sourceItemId: "00000000-0000-4000-8000-000000000002",
      sourceSpanId: null,
      evidenceChunkId: "00000000-0000-4000-8000-000000000003",
      generationModel: "model",
      generationPromptVersion: "atomic-note-v4",
      humanProtected: false,
      createdAt: "2026-10-14T10:00:00.000Z",
      updatedAt: "2026-10-14T10:00:00.000Z"
    };
    for (const status of ["active", "pending_review", "approved", "rejected", "archived"])
      expect(atomicNoteViewSchema.parse({ ...view, status }).status).toBe(status);
    expect(atomicNoteViewSchema.safeParse({ ...view, status: "draft" }).success).toBe(false);
    // Lists show the AI badge only on notes nobody edited, so the flag is part of every view.
    const withoutFlag: Partial<typeof view> = { ...view };
    delete withoutFlag.humanProtected;
    expect(atomicNoteViewSchema.safeParse({ ...withoutFlag, status: "active" }).success).toBe(
      false
    );
    expect(
      atomicNoteViewSchema.parse({ ...view, status: "active", humanProtected: true }).humanProtected
    ).toBe(true);
    const node = {
      id: view.id,
      kind: "atomic_note",
      title: "Title",
      subtitle: null,
      content: null,
      sourceItemId: view.sourceItemId,
      sourceType: null,
      detailCount: 0,
      parentSourceItemId: null,
      childCount: 0
    };
    expect(
      knowledgeGraphDashboardNodeSchema.parse({ ...node, noteStatus: "active" }).noteStatus
    ).toBe("active");
  });

  it("validates phase 5 local model commands and profile selections", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(localModelDownloadInputSchema.parse({ catalogId: "mlx-test" })).toEqual({
      catalogId: "mlx-test",
      acceptLicense: false
    });
    expect(
      aiProfileTaskInputSchema.parse({
        profileId: id,
        task: "summarization"
      })
    ).toEqual({ profileId: id, task: "summarization", parameters: {} });
    expect(
      aiProfileTaskInputSchema.parse({
        profileId: id,
        task: "knowledge-graph-generation"
      }).task
    ).toBe("knowledge-graph-generation");
    expect(aiProfileCreateSchema.parse({ name: "Portuguese" })).toMatchObject({
      outputLanguage: "ui"
    });
    expect(aiTaskRouteSchema.parse({ task: "embedding", profileId: id })).toEqual({
      task: "embedding",
      profileId: id
    });
    expect(
      localModelViewSchema.parse({
        id,
        catalogId: "mlx-test",
        modelId: "repo/model",
        displayName: "Model",
        family: "Family",
        variant: "Variant",
        repository: "repo/model",
        revision: "a".repeat(40),
        runtime: "mlx",
        format: "safetensors",
        quantization: "4-bit",
        capabilities: ["offline"],
        parameterCapabilities: {},
        defaultParameters: { contextWindow: 4096 },
        recommendedParameters: null,
        minimumMemoryBytes: 1,
        recommendedMemoryBytes: 2,
        expectedSizeBytes: 10,
        installedSizeBytes: 0,
        licenseName: "Test",
        licenseUrl: "https://example.test/license",
        requiresLicenseAcceptance: false,
        licenseAccepted: false,
        status: "not_downloaded",
        compatible: true,
        compatibilityReason: "compatible",
        profilesUsing: [],
        lastError: null,
        download: null
      }).catalogId
    ).toBe("mlx-test");
  });

  it("validates the destructive library reset result", () => {
    expect(
      libraryResetResultSchema.parse({
        deletedSources: 2,
        deletedAtomicNotes: 3,
        deletedFiles: 4,
        failedFiles: 0
      })
    ).toEqual({ deletedSources: 2, deletedAtomicNotes: 3, deletedFiles: 4, failedFiles: 0 });
  });

  it("validates a complete source deletion result", () => {
    expect(
      sourceDeletionResultSchema.parse({
        deletedSources: 3,
        deletedAtomicNotes: 4,
        deletedFiles: 5,
        failedFiles: 0,
        graphCleanupFailed: false
      })
    ).toMatchObject({ deletedSources: 3, deletedAtomicNotes: 4, graphCleanupFailed: false });
  });

  it("validates similarity debug runs and score details", () => {
    const runId = "00000000-0000-4000-8000-000000000001";
    const resultId = "00000000-0000-4000-8000-000000000002";
    expect(
      similarityDebugRunSchema.parse({
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
        results: [
          {
            id: resultId,
            runId,
            targetType: "atomic_note",
            targetId: resultId,
            targetLabel: "Candidate",
            finalRank: 1,
            textRank: 2,
            vectorRank: 1,
            graphRank: 3,
            textScore: 0.4,
            vectorScore: 0.8,
            metadataScore: 0.5,
            graphScore: 0.7,
            rerankScore: 0.9,
            fusionScore: null,
            finalScore: 0.81,
            passedThreshold: true,
            explanation: "related",
            metadata: { rerankStatus: "succeeded" },
            createdAt: new Date(0).toISOString()
          }
        ]
      }).results[0]?.rerankScore
    ).toBe(0.9);
  });

  it("carries the SourceSpan of every chunk so a citation can highlight it", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000001",
      type: "PersonalNote",
      title: "Source",
      subtitle: null,
      sourceUri: null,
      language: "en",
      summary: null,
      metadata: {},
      updatedAt: new Date(0).toISOString(),
      assets: [],
      summaries: [],
      atomicNotes: [],
      relations: []
    };
    const chunk = {
      id: "00000000-0000-4000-8000-000000000003",
      content: "Passage",
      chunkIndex: 0,
      sourceSpanId: "00000000-0000-4000-8000-000000000004"
    };
    const document = (chunks: unknown[]) => ({
      id: "00000000-0000-4000-8000-000000000002",
      title: "Source",
      canonicalMarkdown: "Passage",
      language: "en",
      chunks,
      assets: []
    });
    const parsed = sourceDetailSchema.parse({
      ...base,
      documents: [document([{ ...chunk, startOffset: 4, endOffset: 11, page: 2 }, chunk])]
    });
    expect(parsed.documents[0]?.chunks.map((c) => [c.startOffset, c.endOffset, c.page])).toEqual([
      [4, 11, 2],
      [null, null, null]
    ]);
    expect(
      sourceDetailSchema.safeParse({
        ...base,
        documents: [document([{ ...chunk, startOffset: -1 }])]
      }).success
    ).toBe(false);
  });

  it("registers the objects.locate channel", () => {
    expect(ipcChannels.objectsLocate).toBe("app:objects:locate");
    expect(new Set(Object.values(ipcChannels)).size).toBe(Object.values(ipcChannels).length);
  });

  it("has no channel for the removed legacy wiki, curator, organization and maintenance surface", () => {
    const names = Object.keys(ipcChannels);
    for (const removed of [
      "investigationList",
      "investigationGet",
      "investigationFollow",
      "investigationState",
      "consultationSave",
      "maintenanceCommand",
      "curatorCommand",
      "organizationCommand",
      "wikiCollection",
      "wikiTree",
      "wikiContext",
      "wikiMove",
      "wikiLinkedTarget",
      "wikiResolveLinks",
      "wikiGet",
      "wikiSave",
      "wikiHistory",
      "jobsCancelBatch"
    ])
      expect(names, removed).not.toContain(removed);
    // Legacy reads that stay until the legacy repositories go (T40r).
    expect(ipcChannels.wikiList).toBe("app:wiki:list");
    expect(ipcChannels.wikiSearch).toBe("app:wiki:search");
  });

  it("reports the retired old wiki files in the Obsidian wiki status", () => {
    const status = {
      active: true,
      job: null,
      delivery: { state: "running", total: 20_412, delivered: 600, failed: 1 },
      scope: { sourceIds: [], includeDescendants: true },
      conflicts: [],
      retired: {
        archived: 20,
        absent: 0,
        keptTotal: 2,
        kept: [
          {
            id: "00000000-0000-4000-8000-000000000005",
            relativePath: "Memora/Wiki/Topics/Topic 5.md",
            reason: "edited"
          }
        ]
      }
    };
    expect(obsidianWikiStatusSchema.parse(status).retired.kept).toHaveLength(1);
    expect(() => obsidianWikiStatusSchema.parse({ ...status, retired: undefined })).toThrow();
    expect(() =>
      obsidianWikiStatusSchema.parse({
        ...status,
        retired: { ...status.retired, kept: [{ ...status.retired.kept[0], reason: "deleted" }] }
      })
    ).toThrow();
    expect(() =>
      obsidianWikiStatusSchema.parse({ ...status, retired: { ...status.retired, extra: 1 } })
    ).toThrow();
    expect(() =>
      obsidianWikiStatusSchema.parse({
        ...status,
        retired: { ...status.retired, kept: Array(201).fill(status.retired.kept[0]) }
      })
    ).toThrow();
  });

  it("scopes the projection by sources only, and reads a stored scope that still names pages", () => {
    const id = "00000000-0000-4000-8000-000000000005";
    expect(obsidianWikiScopeSchema.parse({})).toEqual({ sourceIds: [], includeDescendants: true });
    expect(() => obsidianWikiScopeSchema.parse({ sourceIds: [], pageIds: [id] })).toThrow();
    expect(
      storedObsidianWikiScopeSchema.parse({
        sourceIds: [id],
        pageIds: [],
        includeDescendants: false
      })
    ).toEqual({ sourceIds: [id], includeDescendants: false });
    expect(() => storedObsidianWikiScopeSchema.parse({ sourceIds: [], other: 1 })).toThrow();
  });

  it("reports where a delivery pass stands", () => {
    const status = {
      active: true,
      job: { status: "queued", error: null },
      delivery: { state: "running", total: 10, delivered: 4, failed: 0 },
      scope: { sourceIds: [], includeDescendants: true },
      conflicts: [],
      retired: { archived: 0, absent: 0, keptTotal: 0, kept: [] }
    };
    expect(obsidianWikiStatusSchema.parse(status).delivery?.delivered).toBe(4);
    expect(obsidianWikiStatusSchema.parse({ ...status, delivery: null }).delivery).toBeNull();
    expect(() =>
      obsidianWikiStatusSchema.parse({
        ...status,
        delivery: { ...status.delivery, state: "paged" }
      })
    ).toThrow();
  });

  it("moves a kept file to recovery by id only", () => {
    expect(ipcChannels.obsidianWikiRetiredMove).toBe("app:obsidian:wiki:retired:move");
    const id = "00000000-0000-4000-8000-000000000005";
    expect(obsidianWikiRetiredMoveSchema.parse({ id })).toEqual({ id });
    expect(() => obsidianWikiRetiredMoveSchema.parse({ id: "not-a-uuid" })).toThrow();
    expect(() => obsidianWikiRetiredMoveSchema.parse({ id, path: "../escape.md" })).toThrow();
    expect(new Set(Object.values(ipcChannels)).size).toBe(Object.values(ipcChannels).length);
  });

  it("registers the note page and relation explanation channels", () => {
    expect(ipcChannels.notesPage).toBe("app:notes:page");
    expect(ipcChannels.notesRelations).toBe("app:notes:relations");
    expect(ipcChannels.relationsExplain).toBe("app:relations:explain");
    expect(ipcChannels.relationsCancelExplain).toBe("app:relations:cancel-explain");
    expect(ipcChannels.relationsExplainSource).toBe("app:relations:explain-source");
    expect(ipcChannels.relationsCancelExplainSource).toBe("app:relations:cancel-explain-source");
    expect(new Set(Object.values(ipcChannels)).size).toBe(Object.values(ipcChannels).length);
  });
});
