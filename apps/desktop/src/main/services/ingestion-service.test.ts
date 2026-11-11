import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import {
  SourceDescriptorSchema,
  processingPresetStages,
  resolveProcessingPlan,
  type EffectiveProcessingPlan
} from "@app/domain";

import { HierarchicalIngestionService } from "./hierarchical-ingestion-service.js";
import { SourceEditorialService } from "./source-editorial-service.js";
import { captureObjectEvents, type ObjectEventCapture } from "./object-events-fixture.js";
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

  describe("web page text", () => {
    const capture = (service: IngestionService, content: Record<string, string>) =>
      service.captureWebPage({
        requestId: "00000000-0000-4000-8000-0000000000a5",
        url: "https://example.com/article",
        title: "Captured article",
        capturedAt,
        ...content,
        metadata: {}
      });
    const setup = () => {
      vi.spyOn(
        HierarchicalIngestionService.prototype as unknown as {
          queueSources: (...args: unknown[]) => Promise<unknown>;
        },
        "queueSources"
      ).mockResolvedValue({
        batchId: "00000000-0000-4000-8000-0000000000b1",
        queued: [
          {
            sourceItemId: "00000000-0000-4000-8000-000000000001",
            documentId: "00000000-0000-4000-8000-0000000000c1",
            ingestionRunId: "00000000-0000-4000-8000-0000000000d1",
            jobId: "00000000-0000-4000-8000-0000000000e1"
          }
        ]
      });
      const pool = new CapturePool();
      const typed = pool as unknown as PgPool;
      const service = createService(typed, {
        hierarchicalIngestionService: new HierarchicalIngestionService({ getPool: () => typed })
      });
      return { pool, service };
    };
    const storedMarkdown = (pool: CapturePool) =>
      pool.documentInserts.flat().filter((value) => typeof value === "string");

    it("stores the Markdown of an HTML fragment that has no html or body tag", async () => {
      const { pool, service } = setup();
      await capture(service, {
        html:
          '<div class="mw-parser-output"><section><p>The forgetting curve describes how memory retention declines without rehearsal.</p>' +
          "<p>Hermann Ebbinghaus measured the decline of retention across several days.</p></section></div>"
      });
      expect(pool.documentInserts).toHaveLength(1);
      expect(storedMarkdown(pool).join("\n")).toContain("forgetting curve describes how memory");
    });

    it("falls back to the visible text when the HTML holds nothing to extract", async () => {
      const { pool, service } = setup();
      await capture(service, {
        html: "<html><body><div></div></body></html>",
        textContent: "Visible text of an application page that Defuddle cannot read."
      });
      expect(pool.documentInserts).toHaveLength(1);
      expect(storedMarkdown(pool).join("\n")).toContain("Visible text of an application page");
    });

    it("refuses a capture that yields no text instead of storing an empty document", async () => {
      const { pool, service } = setup();
      await expect(
        capture(service, { html: "<html><body><div></div></body></html>", textContent: "  \n " })
      ).rejects.toThrow("errors.conversion.emptyResult");
      await expect(capture(service, { markdown: "   " })).rejects.toThrow(
        "errors.conversion.emptyResult"
      );
      expect(pool.documentInserts).toEqual([]);
    });
  });
});

describe("IngestionService file imports without text", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-file-import-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  const plan = resolveProcessingPlan({
    preset: "import_only",
    requestedStages: [],
    scope: "source_only",
    targetSourceItemIds: [],
    forceRegeneration: false,
    previousArtifactPolicy: "reuse_valid"
  });

  function setup() {
    const pool = new TransactionRecordingPool();
    const process = vi.fn(async () => ({
      batchId: "00000000-0000-4000-8000-0000000000b1",
      queued: [
        {
          sourceItemId: "00000000-0000-4000-8000-000000000001",
          documentId: "00000000-0000-4000-8000-0000000000c1",
          ingestionRunId: "00000000-0000-4000-8000-0000000000d1",
          jobId: "00000000-0000-4000-8000-0000000000e1"
        }
      ]
    }));
    const service = createService(pool as unknown as PgPool, {
      userDataPath: directory,
      hierarchicalIngestionService: { process } as unknown as HierarchicalIngestionService
    });
    const importFile = async (fileName: string, contents: string) => {
      const path = join(directory, fileName);
      await writeFile(path, contents);
      return service.importFile(path, {
        descriptor: SourceDescriptorSchema.parse({ type: "StandaloneArticle", title: fileName }),
        duplicatePolicy: "ignore",
        processingPlan: plan
      });
    };
    return { pool, process, service, importFile };
  }

  const inserts = (pool: TransactionRecordingPool) =>
    pool.texts().filter((text) => text.includes("insert into"));

  it("stores the Markdown of an HTML file that is a rendered article fragment", async () => {
    const { pool, process, importFile } = setup();

    await importFile(
      "wikibooks-chapter.html",
      '<div class="mw-content-ltr mw-parser-output" lang="en"><table><tbody><tr><td><a href="/wiki/Previous">Previous Chapter</a></td></tr></tbody></table>' +
        "<p>Memory and language interact when a speaker retrieves a word from long-term storage.</p>" +
        "<h2>Naming</h2><p>Picture naming shows how lexical access depends on the strength of a memory trace.</p></div>"
    );

    const stored = pool.storedDocumentText();
    expect(stored).toContain("Memory and language interact");
    expect(stored).toContain("Picture naming shows how lexical access");
    expect(process).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "an HTML fragment with no text",
      "empty-fragment.html",
      '<div class="mw-parser-output"></div>'
    ],
    [
      "an HTML page with only markup",
      "markup-only.html",
      "<html><body><p>&nbsp;</p></body></html>"
    ],
    ["a blank text file", "blank.txt", "  \n\n "],
    ["an empty Markdown file", "empty.md", ""]
  ])("refuses %s and stores nothing", async (_name, fileName, contents) => {
    const { pool, process, importFile } = setup();

    await expect(importFile(fileName, contents)).rejects.toThrow("errors.conversion.emptyResult");

    expect(inserts(pool)).toEqual([]);
    expect(pool.texts()).not.toContain("begin");
    expect(process).not.toHaveBeenCalled();
    await expect(readdir(join(directory, "assets"))).rejects.toThrow();
  });

  it("refuses every empty file on its own, so none is taken for a duplicate of another", async () => {
    const { pool, importFile } = setup();

    // Both convert to the hash of the empty string; the second must fail as empty, not as the
    // first one's duplicate, and neither is stored.
    for (const [fileName, contents] of [
      ["memory-and-language.html", '<div class="mw-parser-output"></div>'],
      ["o-alienista-i.html", "<div class='mw-parser-output'><span></span></div>"]
    ] as const) {
      await expect(importFile(fileName, contents)).rejects.toThrow("errors.conversion.emptyResult");
    }
    // No duplicate lookup ran either: the empty content was refused before any query.
    expect(pool.texts()).toEqual([]);
  });

  it("refuses a prepared file whose conversion holds no text when it is imported", async () => {
    const { pool, process, service } = setup();
    const emptyConversion = {
      status: "requires_ocr",
      markdown: "",
      contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      blocks: [],
      assets: [],
      engine: "native-html",
      engineVersion: "1",
      profile: "standard",
      options: {},
      warnings: [],
      quality: { textCoverage: 0 },
      metadata: {}
    };
    // A prepared selection older than the guard, or one whose conversion lost its text.
    (
      service as unknown as { preparedFiles: Map<string, Record<string, unknown>> }
    ).preparedFiles.set("token", {
      path: join(directory, "stale.html"),
      fileName: "stale.html",
      mimeType: "text/html",
      data: new Uint8Array(),
      conversion: { ...emptyConversion },
      draft: {},
      preparedAt: Date.now()
    });

    await expect(
      service.importPreparedFile("token", {
        descriptor: SourceDescriptorSchema.parse({ type: "StandaloneArticle", title: "Stale" }),
        duplicatePolicy: "ignore",
        processingPlan: plan
      })
    ).rejects.toThrow("errors.conversion.emptyResult");

    expect(inserts(pool)).toEqual([]);
    expect(process).not.toHaveBeenCalled();
  });

  it("refuses an Obsidian note without text: an empty document fails every processing stage", async () => {
    const { pool, process, service } = setup();

    await expect(
      service.importObsidianNote({
        requestId: "00000000-0000-4000-8000-0000000000a4",
        relativePath: "Inbox/Empty note.md",
        markdown: "\n  \n",
        contentHash: "0".repeat(64),
        mtimeMs: 1
      })
    ).rejects.toThrow("errors.conversion.emptyResult");

    expect(inserts(pool)).toEqual([]);
    expect(process).not.toHaveBeenCalled();
  });
});

class ContainerPool {
  readonly queries: string[] = [];

  async connect() {
    return { query: this.query.bind(this), release: () => undefined };
  }

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
  /** Values of every `insert into documents` statement. */
  readonly documentInserts: unknown[][] = [];

  async connect() {
    return { query: this.query.bind(this), release: () => undefined };
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<QueryResult<T>> {
    if (text.includes("insert into documents")) this.documentInserts.push(values);
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

/**
 * Records every statement with the connection that ran it and fails the first one that matches
 * `failOn`, which is how an insert that PostgreSQL rejects is simulated.
 */
class TransactionRecordingPool {
  readonly statements: Array<{ connection: string; text: string; values: unknown[] }> = [];
  failOn: RegExp | null = null;
  /** Makes every stored file look referenced by a committed document_assets row. */
  assetsReferenced = false;
  /** Makes the duplicate lookups and the source update find this already stored source. */
  hasDuplicate = false;
  private connections = 0;

  async connect() {
    const connection = `client-${++this.connections}`;
    return {
      query: (text: string, values?: unknown[]) => this.run(connection, text, values),
      release: () => undefined
    };
  }

  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    return this.run("pool", text, values) as Promise<QueryResult<T>>;
  }

  /** Every string bound to an `insert into documents` statement: the stored Markdown is one. */
  storedDocumentText(): string {
    return this.statements
      .filter((statement) => statement.text.includes("insert into documents"))
      .flatMap((statement) => statement.values)
      .filter((value): value is string => typeof value === "string")
      .join("\n");
  }

  texts(connection?: string): string[] {
    return this.statements
      .filter((statement) => !connection || statement.connection === connection)
      .map((statement) => statement.text);
  }

  private async run(connection: string, text: string, values: unknown[] = []) {
    this.statements.push({ connection, text, values });
    if (this.failOn?.test(text)) throw new Error("simulated database failure");
    const now = new Date(0);
    const rows =
      (this.hasDuplicate &&
        (text.includes("where ($1::text is not null and source_uri = $1)") ||
          text.includes("unaccent(lower(title))") ||
          text.startsWith("update source_items"))) ||
      text.includes("insert into source_items")
        ? [
            {
              id: "00000000-0000-4000-8000-000000000001",
              type: "GenericDocument",
              title: "Atomic",
              subtitle: null,
              sourceOrigin: "file_upload",
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
                title: "Atomic",
                canonicalMarkdown: "",
                contentHash: "hash",
                language: "en",
                metadata: {},
                createdAt: now,
                updatedAt: now
              }
            ]
          : text.includes("insert into bibliographic_works")
            ? [{ id: "00000000-0000-4000-8000-000000000002", creators: [], identifiers: {} }]
            : text.includes("insert into bibliographic_instances")
              ? [{ id: "00000000-0000-4000-8000-000000000003" }]
              : text.includes("insert into document_assets")
                ? [{ id: "00000000-0000-4000-8000-0000000000a1" }]
                : text.includes("from document_assets where storage_base")
                  ? this.assetsReferenced
                    ? [{ "?column?": 1 }]
                    : []
                  : [];
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows
    } as unknown as QueryResult;
  }
}

describe("IngestionService atomic import persistence", () => {
  let directory: string;
  let capture: ObjectEventCapture;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-atomic-import-"));
    capture = captureObjectEvents();
  });
  afterEach(async () => {
    capture.stop();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  const plan = resolveProcessingPlan({
    preset: "import_only",
    requestedStages: [],
    scope: "source_only",
    targetSourceItemIds: [],
    forceRegeneration: false,
    previousArtifactPolicy: "reuse_valid"
  });

  async function storedFiles(): Promise<string[]> {
    const entries = await readdir(join(directory, "assets"), {
      recursive: true,
      withFileTypes: true
    }).catch(() => []);
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  }

  async function importMarkdown(
    pool: TransactionRecordingPool,
    type: "GenericDocument" | "Book",
    createStructureDraft?: () => Promise<unknown>,
    duplicatePolicy: "version" | "update" = "version"
  ) {
    const path = join(directory, "import-source.md");
    await writeFile(path, "# Chapter One\n\nFirst chapter.\n\n# Chapter Two\n\nSecond chapter.\n");
    const process = vi.fn(async () => ({
      batchId: "00000000-0000-4000-8000-0000000000b1",
      queued: [
        {
          sourceItemId: "00000000-0000-4000-8000-000000000001",
          documentId: "00000000-0000-4000-8000-0000000000c1",
          ingestionRunId: "00000000-0000-4000-8000-0000000000d1",
          jobId: "00000000-0000-4000-8000-0000000000e1"
        }
      ]
    }));
    const service = createService(pool as unknown as PgPool, {
      userDataPath: directory,
      hierarchicalIngestionService: {
        process,
        createStructureDraft:
          createStructureDraft ?? (async () => ({ id: "00000000-0000-4000-8000-0000000000f1" }))
      } as unknown as HierarchicalIngestionService
    });
    const run = () =>
      service.importFile(path, {
        descriptor: SourceDescriptorSchema.parse({ type, title: "Atomic" }),
        duplicatePolicy,
        processingPlan: plan
      });
    return { run, process };
  }

  it("commits the source, document and asset rows on one connection and keeps the stored file", async () => {
    const pool = new TransactionRecordingPool();
    const { run, process } = await importMarkdown(pool, "GenericDocument");

    await expect(run()).resolves.toMatchObject({ documentId: expect.any(String) });

    const transaction = pool.texts("client-1");
    expect(transaction[0]).toBe("begin");
    expect(transaction.at(-1)).toBe("commit");
    for (const table of ["source_items", "documents", "document_assets"]) {
      expect(transaction.some((text) => text.includes(`insert into ${table}`))).toBe(true);
    }
    expect(pool.texts("pool").some((text) => text.includes("insert into"))).toBe(false);
    expect(await storedFiles()).toHaveLength(1);
    expect(process).toHaveBeenCalledOnce();
    // The commit announced the new source; nothing was announced before it.
    expect(capture.refs()).toEqual([
      { kind: "source", id: "00000000-0000-4000-8000-000000000001", change: "created" }
    ]);
  });

  it.each([
    ["the document insert", /insert into documents/],
    ["the original asset row", /insert into document_assets/]
  ])("rolls back every row and removes the stored file when %s fails", async (_name, failOn) => {
    const pool = new TransactionRecordingPool();
    pool.failOn = failOn;
    const { run, process } = await importMarkdown(pool, "GenericDocument");

    await expect(run()).rejects.toThrow("simulated database failure");

    const transaction = pool.texts("client-1");
    expect(transaction.at(-1)).toBe("rollback");
    expect(transaction).not.toContain("commit");
    expect(pool.texts("pool").some((text) => text.includes("insert into"))).toBe(false);
    expect(await storedFiles()).toEqual([]);
    expect(process).not.toHaveBeenCalled();
    expect(capture.events).toEqual([]);
  });

  it("rolls back a hierarchical import when the structure draft fails after the asset rows", async () => {
    const pool = new TransactionRecordingPool();
    const { run, process } = await importMarkdown(pool, "Book", async () => {
      throw new Error("structure draft failed");
    });

    await expect(run()).rejects.toThrow("structure draft failed");

    const transaction = pool.texts("client-1");
    expect(transaction.some((text) => text.includes("insert into bibliographic_works"))).toBe(true);
    expect(transaction.some((text) => text.includes("insert into document_assets"))).toBe(true);
    expect(transaction.at(-1)).toBe("rollback");
    expect(transaction).not.toContain("commit");
    expect(await storedFiles()).toEqual([]);
    expect(process).not.toHaveBeenCalled();
    expect(capture.events).toEqual([]);
  });

  it("keeps a stored file that another asset row already references", async () => {
    const first = new TransactionRecordingPool();
    await (await importMarkdown(first, "GenericDocument")).run();
    const [existing] = await storedFiles();
    expect(existing).toBeDefined();

    // The same bytes again: the store deduplicates, so the failed import did not create the file.
    const second = new TransactionRecordingPool();
    second.failOn = /insert into documents/;
    await expect((await importMarkdown(second, "GenericDocument")).run()).rejects.toThrow(
      "simulated database failure"
    );

    expect(await storedFiles()).toEqual([existing]);
  });

  it("does not remove a file it created when another asset row references it by then", async () => {
    const pool = new TransactionRecordingPool();
    pool.failOn = /insert into documents/;
    // A concurrent import committed a row for the same content-addressed path in the meantime.
    pool.assetsReferenced = true;
    const { run } = await importMarkdown(pool, "GenericDocument");

    await expect(run()).rejects.toThrow("simulated database failure");

    expect(await storedFiles()).toHaveLength(1);
  });

  it("rolls back a container source whose bibliographic rows fail", async () => {
    const pool = new TransactionRecordingPool();
    pool.failOn = /insert into bibliographic_works/;
    const service = createService(pool as unknown as PgPool, { userDataPath: directory });

    await expect(
      service.createContainerSource({
        descriptor: SourceDescriptorSchema.parse({ type: "Book", title: "Atomic book" }),
        duplicatePolicy: "ignore"
      })
    ).rejects.toThrow("simulated database failure");

    const transaction = pool.texts("client-1");
    expect(transaction.some((text) => text.includes("insert into source_items"))).toBe(true);
    expect(transaction.at(-1)).toBe("rollback");
    expect(transaction).not.toContain("commit");
    expect(capture.events).toEqual([]);
  });

  describe("editing a source", () => {
    const sourceItemId = "00000000-0000-4000-8000-000000000001";
    const input = { sourceItemId } as unknown as Parameters<IngestionService["editSource"]>[0];

    it("announces the source once its own transaction committed", async () => {
      vi.spyOn(SourceEditorialService.prototype, "save").mockResolvedValue({} as never);
      const service = createService(new TransactionRecordingPool() as unknown as PgPool);

      await service.editSource(input);

      expect(capture.refs()).toEqual([{ kind: "source", id: sourceItemId, change: "updated" }]);
    });

    it("leaves the announcement to the caller whose transaction it joined, and to nobody on failure", async () => {
      const save = vi
        .spyOn(SourceEditorialService.prototype, "save")
        .mockResolvedValueOnce({} as never)
        .mockRejectedValueOnce(new Error("sourceWorkspace.conflict"));
      const service = createService(new TransactionRecordingPool() as unknown as PgPool);

      await service.editSource(input, {} as never);
      await expect(service.editSource(input)).rejects.toThrow("sourceWorkspace.conflict");

      expect(save).toHaveBeenCalledTimes(2);
      expect(capture.events).toEqual([]);
    });
  });

  it("announces a committed container source as created", async () => {
    const pool = new TransactionRecordingPool();
    const service = createService(pool as unknown as PgPool, { userDataPath: directory });

    await service.createContainerSource({
      descriptor: SourceDescriptorSchema.parse({ type: "Book", title: "Atomic book" }),
      duplicatePolicy: "ignore"
    });

    expect(pool.texts("client-1").at(-1)).toBe("commit");
    expect(capture.refs()).toEqual([
      { kind: "source", id: "00000000-0000-4000-8000-000000000001", change: "created" }
    ]);
  });

  describe("a source that was stored before", () => {
    const sourceItemId = "00000000-0000-4000-8000-000000000001";
    /** The rows of an update are the persisted rows' own business: the announcement is what counts. */
    const persistedRows = () =>
      vi
        .spyOn(
          IngestionService.prototype as unknown as { persistRows: () => Promise<unknown> },
          "persistRows"
        )
        .mockResolvedValue({
          sourceItem: { id: sourceItemId },
          document: { id: "00000000-0000-4000-8000-0000000000c1" },
          structure: null,
          edited: false
        });

    it.each([
      ["update", "updated"],
      ["version", "created"]
    ] as const)(
      "announces a %s import of a known source as %s, after its transaction committed",
      async (policy, change) => {
        const pool = new TransactionRecordingPool();
        pool.hasDuplicate = true;
        persistedRows();
        const { run } = await importMarkdown(pool, "GenericDocument", undefined, policy);
        await run();
        expect(capture.refs()).toEqual([{ kind: "source", id: sourceItemId, change }]);
      }
    );

    it("announces nothing for an update whose transaction failed", async () => {
      const pool = new TransactionRecordingPool();
      pool.hasDuplicate = true;
      vi.spyOn(
        IngestionService.prototype as unknown as { persistRows: () => Promise<unknown> },
        "persistRows"
      ).mockRejectedValue(new Error("simulated database failure"));
      const { run } = await importMarkdown(pool, "GenericDocument", undefined, "update");
      await expect(run()).rejects.toThrow("simulated database failure");
      expect(capture.events).toEqual([]);
    });

    it.each([
      ["update", "updated"],
      ["version", "created"]
    ] as const)("announces a %s of a known container source as %s", async (policy, change) => {
      const pool = new TransactionRecordingPool();
      pool.hasDuplicate = true;
      const service = createService(pool as unknown as PgPool, { userDataPath: directory });
      await service.createContainerSource({
        descriptor: SourceDescriptorSchema.parse({ type: "Book", title: "Atomic book" }),
        duplicatePolicy: policy
      });
      expect(capture.refs()).toEqual([{ kind: "source", id: sourceItemId, change }]);
    });
  });
});
