import type { QueryResult, QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import { processingPresetStages, type EffectiveProcessingPlan } from "@app/domain";

import { HierarchicalIngestionService } from "./hierarchical-ingestion-service.js";
import { IngestionService, type IngestionServiceOptions } from "./ingestion-service.js";
import { YouTubeService } from "./youtube-service.js";

function createService(
  pool: PgPool,
  overrides: Partial<IngestionServiceOptions> = {}
): IngestionService {
  return new IngestionService({
    getPool: () => pool,
    getStorageSettings: async () => ({
      obsidianVaultPath: null,
      managedRoot: "Memora",
      obsidianSyncEnabled: false,
      obsidianSyncPaused: false,
      deletionPolicy: "delete",
      uploadCopiesEnabled: false,
      uploadCopiesFolderPath: null,
      updatedAt: new Date(0).toISOString()
    }),
    userDataPath: "/tmp/memora-ingestion-test",
    resourcesPath: "/tmp/resources",
    workspaceRoot: "/tmp/workspace",
    isPackaged: false,
    fetchExternalPage: async () => new Response("", { status: 500 }),
    ...overrides
  });
}

describe("IngestionService containers", () => {
  it("persists a typed book and bibliographic data without creating a document or run", async () => {
    const pool = new ContainerPool();
    const service = createService(pool as unknown as PgPool);

    const result = await service.createContainerSource({
      descriptor: {
        type: "Book",
        title: "The Dispossessed",
        language: "en",
        creators: [{ name: "Ursula K. Le Guin", role: "author" }],
        tags: [],
        subjects: [],
        isbn13: "9780061054884",
        publisher: "Harper",
        pageCount: 400,
        provenance: { title: { source: "manual" } }
      },
      duplicatePolicy: "ignore"
    });

    expect(result).toMatchObject({ documentId: null, ingestionRunId: null, duplicate: false });
    expect(pool.queries.some((query) => query.includes("insert into source_items"))).toBe(true);
    expect(pool.queries.some((query) => query.includes("insert into bibliographic_works"))).toBe(
      true
    );
    expect(
      pool.queries.some((query) => query.includes("documents") || query.includes("ingestion_runs"))
    ).toBe(false);
  });
});

describe("IngestionService captures", () => {
  afterEach(() => vi.restoreAllMocks());

  const capturedAt = new Date(0).toISOString();
  const captures = {
    web_page: (service: IngestionService) =>
      service.captureWebPage({
        requestId: "00000000-0000-4000-8000-0000000000a1",
        url: "https://example.com/article",
        title: "Captured article",
        capturedAt,
        markdown: "# Captured article\n\nBody.",
        metadata: {}
      }),
    selection: (service: IngestionService) =>
      service.captureSelection({
        requestId: "00000000-0000-4000-8000-0000000000a2",
        url: "https://example.com/article",
        title: "Captured selection",
        capturedAt,
        selection: "A selected idea.",
        metadata: {}
      }),
    youtube: (service: IngestionService) =>
      service.captureYouTube({
        requestId: "00000000-0000-4000-8000-0000000000a3",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        videoId: "dQw4w9WgXcQ",
        capturedAt,
        visibleMetadata: {}
      }),
    obsidian_import: (service: IngestionService) =>
      service.importObsidianNote({
        requestId: "00000000-0000-4000-8000-0000000000a4",
        relativePath: "Inbox/Vault note.md",
        markdown: "# Vault note\n\nWritten in Obsidian.",
        contentHash: "0".repeat(64),
        mtimeMs: 1
      })
  } as const;

  it.each(Object.keys(captures) as Array<keyof typeof captures>)(
    "hands the %s import-only plan request to hierarchical processing and resolves it",
    async (kind) => {
      // The real HierarchicalIngestionService.process validates and resolves the plan the capture
      // path hands over; only the later queueing against PostgreSQL is replaced.
      const queued = vi
        .spyOn(
          HierarchicalIngestionService.prototype as unknown as {
            queueSources: (...args: unknown[]) => Promise<unknown>;
          },
          "queueSources"
        )
        .mockImplementation(async (sourceItemIds) => ({
          batchId: "00000000-0000-4000-8000-0000000000b1",
          queued: [
            {
              sourceItemId: (sourceItemIds as string[])[0],
              documentId: "00000000-0000-4000-8000-0000000000c1",
              ingestionRunId: "00000000-0000-4000-8000-0000000000d1",
              jobId: "00000000-0000-4000-8000-0000000000e1"
            }
          ]
        }));
      const pool = new CapturePool() as unknown as PgPool;
      const service = createService(pool, {
        hierarchicalIngestionService: new HierarchicalIngestionService({ getPool: () => pool }),
        youtubeService: new YouTubeService(async () => ({
          basic_info: { title: "Captured video", author: "Channel" },
          getTranscript: async () => ({
            transcript: { segments: [{ start_ms: 0, snippet: { text: "A spoken idea." } }] }
          })
        }))
      });

      const result = await captures[kind](service);

      expect(result).toMatchObject({
        sourceItemId: "00000000-0000-4000-8000-000000000001",
        ingestionRunId: "00000000-0000-4000-8000-0000000000d1",
        duplicate: false
      });
      expect(queued).toHaveBeenCalledOnce();
      const [sourceItemIds, plan, runKind, trigger] = queued.mock.calls[0] as [
        string[],
        EffectiveProcessingPlan,
        string,
        string
      ];
      expect(sourceItemIds).toEqual(["00000000-0000-4000-8000-000000000001"]);
      expect(plan).toMatchObject({
        preset: "import_only",
        scope: "source_only",
        targetSourceItemIds: ["00000000-0000-4000-8000-000000000001"],
        effectiveStages: [...processingPresetStages.import_only],
        automaticallyIncludedStages: [],
        planVersion: "1"
      });
      expect(runKind).toBe("initial");
      expect(trigger).toBe("integration");
    }
  );
});

class ContainerPool {
  readonly queries: string[] = [];

  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    this.queries.push(text);
    const now = new Date(0);
    const rows = text.includes("insert into source_items")
      ? [
          {
            id: "00000000-0000-4000-8000-000000000001",
            type: "Book",
            title: "The Dispossessed",
            subtitle: null,
            sourceOrigin: "manual",
            sourceUri: null,
            externalId: null,
            parentSourceItemId: null,
            contentHash: null,
            language: "en",
            summary: null,
            summaryGeneratedAt: null,
            metadata: {},
            createdAt: now,
            updatedAt: now
          }
        ]
      : text.includes("insert into bibliographic_works")
        ? [
            {
              id: "00000000-0000-4000-8000-000000000002",
              type: "book",
              title: "The Dispossessed",
              subtitle: null,
              canonicalTitle: null,
              language: "en",
              creators: [],
              identifiers: {},
              metadata: {},
              createdAt: now,
              updatedAt: now
            }
          ]
        : text.includes("insert into bibliographic_instances")
          ? [{ id: "00000000-0000-4000-8000-000000000003" }]
          : [];
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows: rows as unknown as T[]
    };
  }
}

/** Answers the queries a fresh capture issues: no duplicate, one new source, one new document. */
class CapturePool {
  async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
    const now = new Date(0);
    const rows = text.includes("insert into source_items")
      ? [
          {
            id: "00000000-0000-4000-8000-000000000001",
            type: "WebArticle",
            title: "Captured",
            subtitle: null,
            sourceOrigin: "web_capture",
            sourceUri: null,
            externalId: null,
            parentSourceItemId: null,
            contentHash: null,
            language: "en",
            summary: null,
            summaryGeneratedAt: null,
            metadata: {},
            createdAt: now,
            updatedAt: now
          }
        ]
      : text.includes("insert into documents")
        ? [
            {
              id: "00000000-0000-4000-8000-0000000000c1",
              sourceItemId: "00000000-0000-4000-8000-000000000001",
              title: "Captured",
              canonicalMarkdown: "",
              contentHash: "hash",
              language: "en",
              metadata: {},
              createdAt: now,
              updatedAt: now
            }
          ]
        : [];
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows: rows as unknown as T[]
    };
  }
}
