import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PostgresSidecarManager,
  closePgPool,
  createChunkRepository,
  createEmbeddingRepository,
  createHierarchicalIngestionRepository,
  createIngestionRunRepository,
  createJobRepository,
  createKnowledgeGraphRepository,
  createPgPool,
  createSourceItemRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type JobRecord,
  type PgPool
} from "@app/db";
import { ProcessingStages } from "@app/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  carriesSummary,
  CatalogHeaderGate,
  catalogHeaderJobType,
  enqueueCatalogHeaderRefresh,
  listStaleCatalogHeaders,
  runCatalogHeaderRefresh,
  type CatalogHeaderDeps
} from "./catalog-header-refresh.js";
import { buildCatalogMetadataMarkdown } from "./hierarchical-ingestion-service.js";
import {
  aggregateSourceEmbedding,
  JobSupervisor,
  persistCatalogMetadataChunk
} from "./job-supervisor.js";
import { compositeStrategy, hierarchyRootComposite } from "./source-composite.js";
import { compositeBackfillJobType } from "./relations/composite-backfill.js";
import { createRelationCallBudget } from "./relations/relation-call-budget.js";
import { catalogHeaderConfig } from "./catalog-header-policy.js";

// T53h on a real database (plan decision 27): a hierarchy root's catalog header chunk carries the
// root's summary whatever order its jobs ran in. A summary written after the header was built
// rebuilds the chunk, embeds it once, extracts its graph again through the stage's own path and
// builds the root's composite from the same header; a library built without the summary is brought
// up to date once by a deduplicated, idempotent background job on the `relations` worker.
// The ingestion stages run in worker threads built for the packaged app. This proof runs them
// in-process: the chunker splits paragraphs, the embedding check returns its input.
vi.mock("./worker-supervisor.js", async () => {
  const { createHash: hash, randomUUID: uuid } = await import("node:crypto");
  return {
    WorkerSupervisor: class {
      async execute(type: string, payload: Record<string, unknown>) {
        if (type === "embedding") return { embedding: payload.embedding };
        if (type !== "chunking") throw new Error(`unexpected_worker_task:${type}`);
        let offset = 0;
        const chunks = String(payload.markdown)
          .split(/\n\n+/)
          .filter((text) => text.trim().length > 0)
          .map((content, chunkIndex) => {
            const startOffset = offset;
            offset += content.length + 2;
            return {
              id: uuid(),
              sourceSpanId: uuid(),
              chunkIndex,
              content,
              tokenCount: content.split(/\s+/).length,
              contentHash: hash("sha256").update(content).digest("hex"),
              startOffset,
              endOffset: startOffset + content.length
            };
          });
        return { chunks };
      }
      async shutdown() {}
    }
  };
});

const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const unit = (index: number) => Array.from({ length: 256 }, (_, i) => (i === index ? 1 : 0));
const quiet = { error: () => undefined, warn: () => undefined };
const summaryOf = (title: string) => `An aggregate summary of ${title}, written after its header.`;

describe("whether a header carries a summary", () => {
  it("finds it as text and as the JSON string the header renders it in", () => {
    const summary = 'A summary with "quotes",\nand a line break.';
    expect(carriesSummary(`{"summary": ${JSON.stringify(summary)}}`, summary)).toBe(true);
    expect(carriesSummary(`Header\n\n${summary}`, summary)).toBe(true);
    expect(carriesSummary('{"summary": "Another summary."}', summary)).toBe(false);
    expect(carriesSummary("{}", "  ")).toBe(true);
  });
});

describe("one catalog-header pass at a time", () => {
  it("runs the work of two callers one after the other and says when it is busy", async () => {
    const gate = new CatalogHeaderGate();
    const order: string[] = [];
    const first = gate.run(async () => {
      order.push("first starts");
      await new Promise((resolveWork) => setTimeout(resolveWork, 20));
      order.push("first ends");
    });
    const second = gate.run(async () => {
      order.push("second starts");
    });
    expect(gate.busy).toBe(true);
    await Promise.all([first, second]);
    expect(order).toEqual(["first starts", "first ends", "second starts"]);
    expect(gate.busy).toBe(false);
    // A failing pass does not hold the next one.
    await expect(gate.run(async () => Promise.reject(new Error("failed")))).rejects.toThrow();
    await expect(gate.run(async () => "next")).resolves.toBe("next");
  });
});

describe.skipIf(!sidecarInstalled)(
  "the header chunk of a hierarchy root follows its summary (T53h)",
  () => {
    let workDir = "";
    let manager: PostgresSidecarManager | undefined;
    let pool: PgPool | undefined;
    const db = () => pool!;

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-catalog-header-"));
      let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
      for (let attempt = 1; !connection; attempt += 1) {
        manager = new PostgresSidecarManager({
          binDir: sidecar.binDir,
          dataDir: join(workDir, `data-${attempt}`),
          database: "memora_catalog_header_test",
          user: "memora_catalog_header_test",
          password: `catalog-header-${randomUUID()}`,
          startupTimeoutMs: 30_000,
          shutdownTimeoutMs: 10_000
        });
        try {
          connection = await manager.start();
        } catch (error) {
          await manager.stop().catch(() => undefined);
          if (attempt >= 3) throw error;
        }
      }
      pool = createPgPool({ connectionString: connection.connectionString, max: 8 });
      await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
        seedFolder: join(workspace, "packages/db/seed")
      });
    }, 120_000);

    afterAll(async () => {
      if (pool) await closePgPool(pool);
      await manager?.stop().catch(() => undefined);
      if (workDir) await rm(workDir, { recursive: true, force: true });
    });

    // The tests share one database: each starts with no summary written and no job queued, so the
    // pass of a test looks at the books of that test only.
    beforeEach(async () => {
      await db().query("update source_items set summary = null where summary is not null");
      await db().query("update chunks set metadata = metadata - 'headerRefresh'");
      await db().query("delete from jobs where type in ($1, $2, 'ingestion')", [
        catalogHeaderJobType,
        compositeBackfillJobType
      ]);
      await db().query(
        "update ingestion_runs set status = 'canceled' where status in ('pending', 'running')"
      );
      await db().query("delete from settings where key = $1", [
        catalogHeaderConfig.dailyRootsSettingKey
      ]);
    });

    // --- fixtures -----------------------------------------------------------------------------------

    const newSpace = () => `space-${randomUUID()}`;
    const sources = () => createSourceItemRepository(db());

    /** What the stage's own path would write for a header chunk: an entity mention on each chunk. */
    const extractGraph = async (rootId: string, documentId: string) => {
      const chunks = await createChunkRepository(db()).listByDocument(documentId);
      await createKnowledgeGraphRepository(db()).replaceSourceExtraction({
        sourceItemId: rootId,
        language: "en",
        generation: { processingMode: "catalog_metadata" },
        generationReceipt: { jobId: null, ingestionRunId: null, metadata: {} },
        batches: [
          {
            entities: [
              {
                key: "e1",
                type: "Concept",
                canonicalName: `Entity ${randomUUID()}`,
                aliases: [],
                confidence: 0.9,
                evidenceChunkIds: chunks.map((chunk) => chunk.id)
              }
            ],
            relations: []
          }
        ]
      });
      return chunks;
    };

    interface Library {
      spaceKey: string;
      rootId: string;
      title: string;
      documentId: string;
      chunkId: string;
    }

    /**
     * A book as a library built before this task holds it: chapters with composites, a catalog document
     * whose header chunk was built without the summary (embedded, with its graph), and then a summary
     * written late (which deletes the book's composite, as any update of the source does).
     */
    const book = async (
      spaceKey: string,
      options: {
        title?: string;
        summary?: string | null;
        vector?: boolean;
        graph?: boolean;
        chapters?: number;
      } = {}
    ): Promise<Library> => {
      const title = options.title ?? `Memory and spacing ${randomUUID().slice(0, 8)}`;
      const root = await sources().create({ type: "Book", title });
      for (let index = 1; index <= (options.chapters ?? 2); index += 1) {
        const chapter = await sources().create({
          type: "BookChapter",
          title: `${title} chapter ${index}`,
          parentSourceItemId: root.id
        });
        await createEmbeddingRepository(db()).upsert({
          targetType: "source_item",
          targetId: chapter.id,
          provider: "test",
          model: "test-256",
          runtime: "local",
          strategy: compositeStrategy(spaceKey),
          contentHash: `composite-${chapter.id}`,
          embedding: unit(index)
        });
      }
      const documentId = randomUUID();
      const header = buildCatalogMetadataMarkdown((await sources().findById(root.id))!);
      await db().query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash, metadata)
       values ($1, $2, $3, $4, $5, '{"processingMode":"catalog_metadata"}'::jsonb)`,
        [documentId, root.id, title, header, createHash("sha256").update(header).digest("hex")]
      );
      const [chunk] = await persistCatalogMetadataChunk(
        createChunkRepository(db()),
        documentId,
        root.id,
        header
      );
      if (options.vector !== false)
        await createEmbeddingRepository(db()).upsert({
          targetType: "chunk",
          targetId: chunk!.id,
          chunkId: chunk!.id,
          provider: "test",
          model: "test-256",
          runtime: "local",
          strategy: `native-v2:${spaceKey}`,
          contentHash: chunk!.contentHash,
          embedding: unit(100)
        });
      if (options.graph !== false) await extractGraph(root.id, documentId);
      if (options.summary !== null)
        await sources().update(root.id, {
          summary: options.summary ?? summaryOf(title),
          summaryGeneratedAt: new Date()
        });
      return { spaceKey, rootId: root.id, title, documentId, chunkId: chunk!.id };
    };

    /** The model calls the pass makes, answered with one vector per text. */
    const models = (spaceKey: string) => {
      const embedded: Array<{ texts: string[]; context: Record<string, unknown> }> = [];
      const generate = vi.fn(async (texts: string[], _signal: AbortSignal, context: object) => {
        embedded.push({ texts, context: context as Record<string, unknown> });
        return {
          embeddings: texts.map((_, index) => unit(50 + index)),
          provider: "test",
          model: "test-256",
          runtime: "local",
          spaceKey
        };
      });
      const graphs: Array<{
        rootId: string;
        documentId: string;
        context: Record<string, unknown>;
      }> = [];
      const knowledge = {
        catalogGraphLocality: vi.fn<() => Promise<"local" | "remote" | null>>(async () => "local"),
        generateCatalogKnowledgeGraph: vi.fn(
          async (rootId: string, documentId: string, context: Record<string, unknown> = {}) => {
            graphs.push({ rootId, documentId, context });
            await extractGraph(rootId, documentId);
            return { configured: true, generated: true };
          }
        )
      };
      return { generate, embedded, knowledge, graphs };
    };

    const jobOf = (payload: Record<string, unknown> = {}): JobRecord =>
      ({ id: randomUUID(), type: catalogHeaderJobType, payload }) as unknown as JobRecord;

    const depsFor = (
      spaceKey: string | null,
      m: ReturnType<typeof models>,
      extra: Partial<CatalogHeaderDeps> = {}
    ): CatalogHeaderDeps => ({
      getPool: () => db(),
      embeddingSpaceKey: async () => spaceKey,
      generate: m.generate as unknown as CatalogHeaderDeps["generate"],
      validate: async (embedding) => embedding,
      aggregate: aggregateSourceEmbedding,
      knowledge: m.knowledge as unknown as CatalogHeaderDeps["knowledge"],
      persistHeaderChunk: persistCatalogMetadataChunk,
      logger: quiet,
      env: {},
      ...extra
    });

    /** Runs pages of the pass until no page asks for another, as the supervisor re-queues the job. */
    const runPass = async (deps: CatalogHeaderDeps) => {
      const signal = new AbortController().signal;
      let job = jobOf();
      const pages: Array<Record<string, unknown>> = [];
      for (let page = 0; page < 20; page += 1) {
        const result = await runCatalogHeaderRefresh(deps, job, signal);
        pages.push(result);
        const next = result.continueWith as Record<string, unknown> | undefined;
        if (!next) return { pages, result };
        job = jobOf(next);
      }
      throw new Error("the pass never ended");
    };

    const headerChunks = async (documentId: string) =>
      createChunkRepository(db()).listByDocument(documentId);
    const mentionChunkIds = async (rootId: string) =>
      (
        await db().query<{ chunkId: string }>(
          `select chunk_id as "chunkId" from entity_mentions where source_item_id = $1`,
          [rootId]
        )
      ).rows.map((row) => row.chunkId);
    const chunkVectors = async (chunkId: string) =>
      Number(
        (
          await db().query<{ n: number }>(
            `select count(*)::int as n from embeddings_256 where target_type = 'chunk' and target_id = $1`,
            [chunkId]
          )
        ).rows[0]!.n
      );
    const compositeState = async (library: Library) => {
      const source = (await sources().findById(library.rootId))!;
      return hierarchyRootComposite({
        pool: db(),
        sourceItemId: library.rootId,
        header: buildCatalogMetadataMarkdown(source),
        space: {
          model: "test-256",
          dimensions: 256,
          strategy: compositeStrategy(library.spaceKey)
        }
      });
    };
    const queuedHeaderJobs = async () =>
      Number(
        (
          await db().query<{ n: number }>(
            "select count(*)::int as n from jobs where type = $1 and status = 'queued'",
            [catalogHeaderJobType]
          )
        ).rows[0]!.n
      );

    // --- the late summary ---------------------------------------------------------------------------

    it("rebuilds the header chunk with the summary, embeds it once, replaces its graph and builds the composite", async () => {
      const spaceKey = newSpace();
      const library = await book(spaceKey);
      const m = models(spaceKey);
      // Before: the chunk lacks the summary the root has, it holds a vector and a mention, and the
      // summary written after it deleted the composite.
      expect((await headerChunks(library.documentId))[0]!.content).not.toContain(
        "aggregate summary"
      );
      expect(await chunkVectors(library.chunkId)).toBe(1);
      expect(await mentionChunkIds(library.rootId)).toEqual([library.chunkId]);
      expect(await compositeState(library)).toBe("stale");
      const stale = await listStaleCatalogHeaders(db());
      expect(stale.map((entry) => entry.rootId)).toContain(library.rootId);

      const { result } = await runPass(depsFor(spaceKey, m));

      const source = (await sources().findById(library.rootId))!;
      const header = buildCatalogMetadataMarkdown(source);
      const chunks = await headerChunks(library.documentId);
      // The header chunk is the root's header, summary included, in place of the old chunk.
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.content).toBe(header);
      expect(chunks[0]!.content).toContain(summaryOf(library.title));
      expect(chunks[0]!.id).not.toBe(library.chunkId);
      expect(chunks[0]!.metadata).toMatchObject({ processingMode: "catalog_metadata" });
      // Its vector and its graph are the new chunk's: the old chunk's mentions and vector went with it.
      expect(await chunkVectors(library.chunkId)).toBe(0);
      expect(await chunkVectors(chunks[0]!.id)).toBe(1);
      expect(await mentionChunkIds(library.rootId)).toEqual([chunks[0]!.id]);
      expect(m.graphs).toHaveLength(1);
      expect(m.graphs[0]).toMatchObject({ rootId: library.rootId, documentId: library.documentId });
      expect(m.graphs[0]!.context).toMatchObject({ priority: "P3" });
      // The composite follows, built from the same header: one embedding served both.
      expect(await compositeState(library)).toBe("current");
      expect(m.embedded).toHaveLength(1);
      expect(m.embedded[0]!.texts).toEqual([header]);
      expect(m.embedded[0]!.context).toMatchObject({
        sourceItemId: library.rootId,
        documentId: library.documentId,
        stage: "embedding",
        priority: "P3"
      });
      expect(m.embedded[0]!.context).not.toHaveProperty("ingestionRunId");
      // Nothing is left owed on the chunk, and the job says what it cost.
      expect(chunks[0]!.metadata).not.toHaveProperty("headerRefresh");
      expect(result).toMatchObject({
        examined: 1,
        refreshed: 1,
        replaced: 1,
        embeddings: 1,
        graphs: 1,
        composites: 1,
        refreshedIds: [library.rootId]
      });
    });

    it("makes no call the second time: a header that carries its summary is left alone", async () => {
      const spaceKey = newSpace();
      const library = await book(spaceKey);
      const first = models(spaceKey);
      await runPass(depsFor(spaceKey, first));
      const chunkAfterFirst = (await headerChunks(library.documentId))[0]!;

      const second = models(spaceKey);
      const { result } = await runPass(depsFor(spaceKey, second));
      expect(second.generate).not.toHaveBeenCalled();
      expect(second.knowledge.generateCatalogKnowledgeGraph).not.toHaveBeenCalled();
      expect(result).toMatchObject({ examined: 0, refreshed: 0, embeddings: 0, graphs: 0 });
      expect((await headerChunks(library.documentId))[0]!.id).toBe(chunkAfterFirst.id);
      expect(await enqueueCatalogHeaderRefresh(db(), { rootIds: [library.rootId] })).toBe(false);
    });

    it("queues nothing in a measurement run, whatever the knob that makes it one", async () => {
      const spaceKey = newSpace();
      await book(spaceKey);
      for (const env of [
        { MEMORA_CATALOG_HEADERS: "off" },
        { MEMORA_RELATIONS_REMATCH: "arrival:20261031" },
        { MEMORA_GOLDEN_RUN: "manifest.json" },
        { MEMORA_GOLDEN_PIN: "extraction" },
        { MEMORA_AI_CASSETTE: "replay" }
      ])
        expect(await enqueueCatalogHeaderRefresh(db(), {}, env), JSON.stringify(env)).toBe(false);
      expect(await queuedHeaderJobs()).toBe(0);
      // The product, and a live proof that forces it on over a knob, queue it.
      expect(await enqueueCatalogHeaderRefresh(db(), {}, {})).toBe(true);
      expect(await queuedHeaderJobs()).toBe(1);
      await db().query("delete from jobs where type = $1", [catalogHeaderJobType]);
      expect(
        await enqueueCatalogHeaderRefresh(
          db(),
          {},
          {
            MEMORA_CATALOG_HEADERS: "on",
            MEMORA_RELATIONS_REMATCH: "burst"
          }
        )
      ).toBe(true);
    });

    it("does nothing in a measurement run with a job an earlier start of the profile queued", async () => {
      const spaceKey = newSpace();
      const library = await book(spaceKey);
      const m = models(spaceKey);
      const result = await runCatalogHeaderRefresh(
        depsFor(spaceKey, m, { env: { MEMORA_AI_CASSETTE: "replay" } }),
        jobOf(),
        new AbortController().signal
      );
      expect(result).toEqual({ skipped: "refresh_off", reason: "cassette_replay" });
      expect(m.generate).not.toHaveBeenCalled();
      expect(m.knowledge.generateCatalogKnowledgeGraph).not.toHaveBeenCalled();
      expect((await headerChunks(library.documentId))[0]!.id).toBe(library.chunkId);
    });

    it("follows a summary that changes again, and leaves a root whose header already carries it", async () => {
      const spaceKey = newSpace();
      const current = await book(spaceKey);
      await runPass(depsFor(spaceKey, models(spaceKey)));
      const rebuilt = (await headerChunks(current.documentId))[0]!;

      await sources().update(current.rootId, {
        summary: "A different summary of the whole book, written by a later batch.",
        summaryGeneratedAt: new Date()
      });
      const m = models(spaceKey);
      const { result } = await runPass(depsFor(spaceKey, m));
      const chunk = (await headerChunks(current.documentId))[0]!;
      expect(chunk.id).not.toBe(rebuilt.id);
      expect(chunk.content).toContain("A different summary of the whole book");
      expect(chunk.content).not.toContain("written after its header");
      expect(result).toMatchObject({ refreshed: 1, replaced: 1 });
      expect(await compositeState(current)).toBe("current");
    });

    it("leaves the roots with nothing to follow: no summary, an import still running, no header yet", async () => {
      const spaceKey = newSpace();
      const noSummary = await book(spaceKey, { summary: null });
      const running = await book(spaceKey);
      const runs = createIngestionRunRepository(db());
      const run = await runs.create({
        sourceItemId: running.rootId,
        requestedStages: ["embedding"],
        effectiveStages: ["chunking", "embedding"],
        trigger: "interactive_import"
      });
      await db().query("update ingestion_runs set status = 'running' where id = $1", [run.id]);
      // A root with children and a summary but no header chunk yet: its own catalog run builds it.
      const headerless = await sources().create({ type: "Book", title: "Headerless" });
      await sources().create({
        type: "BookChapter",
        title: "Headerless chapter",
        parentSourceItemId: headerless.id
      });
      await sources().update(headerless.id, {
        summary: "A summary.",
        summaryGeneratedAt: new Date()
      });

      const stale = await listStaleCatalogHeaders(db());
      expect(stale.map((entry) => entry.rootId)).not.toContain(noSummary.rootId);
      expect(stale.map((entry) => entry.rootId)).not.toContain(headerless.id);
      // The root being imported is listed as busy: it is not queued, and the pass leaves it.
      expect(stale.find((entry) => entry.rootId === running.rootId)?.busy).toBe(true);
      expect(await enqueueCatalogHeaderRefresh(db(), { rootIds: [running.rootId] })).toBe(false);
      const m = models(spaceKey);
      const { result } = await runPass(depsFor(spaceKey, m, {}));
      // Only the roots of other tests may be ready; the running root's chunk is as it was.
      expect((await headerChunks(running.documentId))[0]!.id).toBe(running.chunkId);
      expect(result.refreshedIds).not.toContain(running.rootId);
      expect(result.waiting).toBeGreaterThanOrEqual(1);
      // Once the import ends, the header follows.
      await runs.complete(run.id);
      expect(await enqueueCatalogHeaderRefresh(db(), { rootIds: [running.rootId] })).toBe(true);
      await db().query("delete from jobs where type = $1", [catalogHeaderJobType]);
      const after = await runPass(depsFor(spaceKey, models(spaceKey)));
      expect(after.result.refreshedIds).toContain(running.rootId);
    });

    // --- what the old chunk had -----------------------------------------------------------------------

    it("gives the new chunk what the old one had: no vector and no graph for a library processed without them", async () => {
      const spaceKey = newSpace();
      const bare = await book(spaceKey, { vector: false, graph: false });
      const m = models(spaceKey);
      await runPass(depsFor(spaceKey, m));
      const chunk = (await headerChunks(bare.documentId))[0]!;
      expect(chunk.content).toContain(summaryOf(bare.title));
      expect(await chunkVectors(chunk.id)).toBe(0);
      expect(m.knowledge.generateCatalogKnowledgeGraph).not.toHaveBeenCalled();
      expect(m.generate).toHaveBeenCalledTimes(1);
      // The composite follows all the same (it is the root's vector for source discovery).
      expect(await compositeState(bare)).toBe("current");
    });

    it("leaves the chunk as it is when it could not be given back what it had", async () => {
      const spaceKey = newSpace();
      const embedded = await book(spaceKey);
      const noEmbedding = models(spaceKey);
      const first = await runPass(depsFor(null, noEmbedding));
      expect((await headerChunks(embedded.documentId))[0]!.id).toBe(embedded.chunkId);
      expect(first.result.skipped).toEqual(
        expect.arrayContaining([{ rootId: embedded.rootId, reason: "no_embedding" }])
      );

      const noGraph = models(spaceKey);
      noGraph.knowledge.catalogGraphLocality.mockResolvedValue(null);
      const second = await runPass(depsFor(spaceKey, noGraph));
      expect((await headerChunks(embedded.documentId))[0]!.id).toBe(embedded.chunkId);
      expect(await mentionChunkIds(embedded.rootId)).toEqual([embedded.chunkId]);
      expect(second.result.skipped).toEqual(
        expect.arrayContaining([{ rootId: embedded.rootId, reason: "no_graph_route" }])
      );
      expect(noGraph.generate).not.toHaveBeenCalled();
    });

    it("never replaces a document that holds more than the header", async () => {
      const spaceKey = newSpace();
      const mixed = await book(spaceKey);
      await db().query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 1, 'Real content of the document.', 'content-hash')`,
        [randomUUID(), mixed.documentId, mixed.rootId]
      );
      const m = models(spaceKey);
      const { result } = await runPass(depsFor(spaceKey, m));
      expect(result.skipped).toEqual(
        expect.arrayContaining([{ rootId: mixed.rootId, reason: "document_changed" }])
      );
      expect(await headerChunks(mixed.documentId)).toHaveLength(2);
      expect(m.generate).not.toHaveBeenCalled();
    });

    // --- a failure and a restart ------------------------------------------------------------------------

    it("resumes a chunk that owes its graph: no second embedding, no second chunk", async () => {
      const spaceKey = newSpace();
      const library = await book(spaceKey);
      const failing = models(spaceKey);
      failing.knowledge.generateCatalogKnowledgeGraph.mockRejectedValueOnce(
        new Error("errors.ai.invalidOutput")
      );
      const first = await runPass(depsFor(spaceKey, failing));
      // The chunk was replaced and embedded, then the graph failed: the failure is reported and the
      // chunk keeps a note of what it still owes.
      expect(first.result.failures).toEqual([
        { rootId: library.rootId, message: "errors.ai.invalidOutput" }
      ]);
      const owing = (await headerChunks(library.documentId))[0]!;
      expect(owing.id).not.toBe(library.chunkId);
      expect(owing.metadata).toMatchObject({ headerRefresh: { owes: ["graph"] } });
      expect(await chunkVectors(owing.id)).toBe(1);
      expect(await mentionChunkIds(library.rootId)).toEqual([]);
      const queued = await listStaleCatalogHeaders(db(), { rootIds: [library.rootId] });
      expect(queued).toMatchObject([{ rootId: library.rootId, outdated: false, owes: ["graph"] }]);

      // A later pass pays the debt with the graph alone.
      const resumed = models(spaceKey);
      const second = await runPass(depsFor(spaceKey, resumed));
      expect(resumed.generate).not.toHaveBeenCalled();
      expect(resumed.knowledge.generateCatalogKnowledgeGraph).toHaveBeenCalledTimes(1);
      const done = (await headerChunks(library.documentId))[0]!;
      expect(done.id).toBe(owing.id);
      expect(done.metadata).not.toHaveProperty("headerRefresh");
      expect(await mentionChunkIds(library.rootId)).toEqual([done.id]);
      expect(second.result).toMatchObject({ refreshed: 1, replaced: 0, graphs: 1, embeddings: 0 });
    });

    it("stops the pass at a model that fails for good: the roots left keep the vector and graph they have", async () => {
      const spaceKey = newSpace();
      const first = await book(spaceKey, { title: "Alpha book" });
      const second = await book(spaceKey, { title: "Beta book" });
      const failing = models(spaceKey);
      failing.knowledge.generateCatalogKnowledgeGraph.mockRejectedValue(
        new Error("errors.ai.invalidOutput")
      );
      const { pages, result } = await runPass(depsFor(spaceKey, failing));
      // The first root was replaced and owes its graph; the pass ended there.
      expect(pages).toHaveLength(1);
      expect(result).not.toHaveProperty("continueWith");
      expect(result).toMatchObject({ stopped: "graph_failed", refreshed: 0 });
      expect(failing.knowledge.generateCatalogKnowledgeGraph).toHaveBeenCalledTimes(1);
      expect((await headerChunks(first.documentId))[0]!.metadata).toMatchObject({
        headerRefresh: { owes: ["graph"] }
      });
      // The second root was not touched: its chunk, its vector and its graph are as they were.
      expect((await headerChunks(second.documentId))[0]!.id).toBe(second.chunkId);
      expect(await chunkVectors(second.chunkId)).toBe(1);
      expect(await mentionChunkIds(second.rootId)).toEqual([second.chunkId]);

      // The embedding model fails the same way.
      const embedding = models(spaceKey);
      embedding.generate.mockRejectedValue(new Error("errors.localModels.notReady"));
      const third = await book(spaceKey, { title: "Gamma book" });
      await db().query("update source_items set summary = null where id = any($1::uuid[])", [
        [first.rootId, second.rootId]
      ]);
      await db().query("update chunks set metadata = metadata - 'headerRefresh'");
      const attempt = await runPass(depsFor(spaceKey, embedding));
      expect(attempt.result).toMatchObject({ stopped: "embedding_failed" });
      expect((await headerChunks(third.documentId))[0]!.metadata).toMatchObject({
        headerRefresh: { owes: ["embedding", "graph"] }
      });
      expect(embedding.knowledge.generateCatalogKnowledgeGraph).not.toHaveBeenCalled();
    });

    it("does not extract the graph again when an ingestion run of the root already did", async () => {
      const spaceKey = newSpace();
      const library = await book(spaceKey);
      const failing = models(spaceKey);
      failing.knowledge.generateCatalogKnowledgeGraph.mockRejectedValueOnce(
        new Error("errors.ai.invalidOutput")
      );
      await runPass(depsFor(spaceKey, failing));
      // The root's own catalog run, queued meanwhile, extracts the graph of the chunk it finds.
      await extractGraph(library.rootId, library.documentId);
      const resumed = models(spaceKey);
      await runPass(depsFor(spaceKey, resumed));
      expect(resumed.knowledge.generateCatalogKnowledgeGraph).not.toHaveBeenCalled();
      expect((await headerChunks(library.documentId))[0]!.metadata).not.toHaveProperty(
        "headerRefresh"
      );
    });

    it("rethrows a failure the retry can mend, with the chunk's debts recorded for it", async () => {
      const spaceKey = newSpace();
      const library = await book(spaceKey);
      const m = models(spaceKey);
      m.knowledge.generateCatalogKnowledgeGraph.mockRejectedValueOnce(
        new Error("Connection terminated unexpectedly")
      );
      await expect(runPass(depsFor(spaceKey, m))).rejects.toThrow(
        "Connection terminated unexpectedly"
      );
      const owing = (await headerChunks(library.documentId))[0]!;
      expect(owing.metadata).toMatchObject({ headerRefresh: { owes: ["graph"] } });
      // The retry resumes where the failure stopped.
      const retry = models(spaceKey);
      await runPass(depsFor(spaceKey, retry));
      expect(retry.generate).not.toHaveBeenCalled();
      expect((await headerChunks(library.documentId))[0]!.metadata).not.toHaveProperty(
        "headerRefresh"
      );
    });

    // --- the pass ---------------------------------------------------------------------------------------

    // --- the daily cap of the remote graph calls ------------------------------------------------------

    describe("the daily cap of the remote graph calls", () => {
      /** The day's counter over the clock the test moves; its own setting, never the relations'. */
      const capped = (cap: number, clock: { now: Date }) =>
        createRelationCallBudget({
          db: () => db(),
          cap: () => cap,
          now: () => clock.now,
          settingKey: catalogHeaderConfig.dailyRootsSettingKey
        });
      const counter = async () =>
        (
          await db().query<{ value: { day: string; calls: number } }>(
            "select value from settings where key = $1",
            [catalogHeaderConfig.dailyRootsSettingKey]
          )
        ).rows[0]?.value ?? null;
      const threeBooks = async (spaceKey: string): Promise<[Library, Library, Library]> => [
        await book(spaceKey, { title: "Alpha book" }),
        await book(spaceKey, { title: "Beta book" }),
        await book(spaceKey, { title: "Gamma book" })
      ];

      it("refreshes the roots the cap allows, leaves the rest as they are and defers them to the next day", async () => {
        const spaceKey = newSpace();
        const [alpha, beta, gamma] = await threeBooks(spaceKey);
        const clock = { now: new Date(2026, 9, 18, 9, 30) };
        const m = models(spaceKey);
        m.knowledge.catalogGraphLocality.mockResolvedValue("remote");
        const deps = depsFor(spaceKey, m, { budget: capped(2, clock), now: () => clock.now });

        const { result } = await runPass(deps);

        expect(result).toMatchObject({ refreshed: 2, graphs: 2, cappedToday: 1 });
        expect(result.refreshedIds).toEqual([alpha.rootId, beta.rootId]);
        expect(result.skipped).toEqual([{ rootId: gamma.rootId, reason: "daily_cap" }]);
        expect(result.retryAfter).toBe(new Date(2026, 9, 19).toISOString());
        // The root the cap held back keeps its chunk, its vector and its graph.
        expect((await headerChunks(gamma.documentId))[0]!.id).toBe(gamma.chunkId);
        expect(await chunkVectors(gamma.chunkId)).toBe(1);
        expect(await mentionChunkIds(gamma.rootId)).toEqual([gamma.chunkId]);
        expect(m.knowledge.generateCatalogKnowledgeGraph).toHaveBeenCalledTimes(2);
        expect(await counter()).toMatchObject({ day: "2026-10-18", calls: 2 });
        // The deferred pass is a queued job due with the next local day, not before.
        const [queued] = (
          await db().query<{ runAfter: Date }>(
            `select run_after as "runAfter" from jobs where type = $1 and status = 'queued'`,
            [catalogHeaderJobType]
          )
        ).rows;
        const dueIn = queued!.runAfter.getTime() - Date.now();
        expect(dueIn).toBeGreaterThan(0);
        expect(queued!.runAfter.getTime()).toBeLessThanOrEqual(new Date(2026, 9, 19).getTime());

        // The day after, the count starts again and the root is refreshed.
        clock.now = new Date(2026, 9, 19, 0, 5);
        const next = models(spaceKey);
        next.knowledge.catalogGraphLocality.mockResolvedValue("remote");
        const later = await runPass(
          depsFor(spaceKey, next, { budget: capped(2, clock), now: () => clock.now })
        );
        expect(later.result).toMatchObject({ refreshed: 1, graphs: 1 });
        expect(later.result).not.toHaveProperty("cappedToday");
        expect((await headerChunks(gamma.documentId))[0]!.content).toContain(
          summaryOf(gamma.title)
        );
        expect(await counter()).toMatchObject({ day: "2026-10-19", calls: 1 });
      });

      it("counts nothing on a local route, and never touches the relation calls' counter", async () => {
        const spaceKey = newSpace();
        await threeBooks(spaceKey);
        await db().query("delete from settings where key = 'relations.ai.dailyCalls'");
        const clock = { now: new Date(2026, 9, 18, 9, 30) };
        const m = models(spaceKey);
        m.knowledge.catalogGraphLocality.mockResolvedValue("local");
        // A cap of nothing refuses every remote call; a local route is not remote.
        const { result } = await runPass(depsFor(spaceKey, m, { budget: capped(0, clock) }));
        expect(result).toMatchObject({ refreshed: 3, graphs: 3 });
        expect(result).not.toHaveProperty("cappedToday");
        expect(await counter()).toBeNull();
        const relations = await db().query(
          "select 1 from settings where key = 'relations.ai.dailyCalls'"
        );
        expect(relations.rows).toHaveLength(0);
      });

      it("takes no place for a root that has no graph to extract again, or one that is left alone", async () => {
        const spaceKey = newSpace();
        const bare = await book(spaceKey, { title: "Bare book", graph: false });
        const mixed = await book(spaceKey, { title: "Mixed book" });
        await db().query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
           values ($1, $2, $3, 1, 'Real content of the document.', 'content-hash')`,
          [randomUUID(), mixed.documentId, mixed.rootId]
        );
        const clock = { now: new Date(2026, 9, 18, 9, 30) };
        const m = models(spaceKey);
        m.knowledge.catalogGraphLocality.mockResolvedValue("remote");
        const { result } = await runPass(depsFor(spaceKey, m, { budget: capped(5, clock) }));
        expect(result.refreshedIds).toEqual([bare.rootId]);
        expect(result.skipped).toEqual([{ rootId: mixed.rootId, reason: "document_changed" }]);
        expect(await counter()).toBeNull();
      });

      it("holds a chunk that still owes its graph back too, and keeps the debt", async () => {
        const spaceKey = newSpace();
        const library = await book(spaceKey);
        const clock = { now: new Date(2026, 9, 18, 9, 30) };
        const failing = models(spaceKey);
        failing.knowledge.catalogGraphLocality.mockResolvedValue("remote");
        failing.knowledge.generateCatalogKnowledgeGraph.mockRejectedValueOnce(
          new Error("errors.ai.invalidOutput")
        );
        await runPass(depsFor(spaceKey, failing, { budget: capped(1, clock) }));
        expect(await counter()).toMatchObject({ calls: 1 });
        // The next attempt the same day needs a second place: the cap holds it back, owing the graph.
        const resumed = models(spaceKey);
        resumed.knowledge.catalogGraphLocality.mockResolvedValue("remote");
        const { result } = await runPass(depsFor(spaceKey, resumed, { budget: capped(1, clock) }));
        expect(result.skipped).toEqual([{ rootId: library.rootId, reason: "daily_cap" }]);
        expect(resumed.knowledge.generateCatalogKnowledgeGraph).not.toHaveBeenCalled();
        expect((await headerChunks(library.documentId))[0]!.metadata).toMatchObject({
          headerRefresh: { owes: ["graph"] }
        });
      });
    });

    it("gives its slot back after each root: the totals add up over the pages", async () => {
      const spaceKey = newSpace();
      const libraries = [
        await book(spaceKey, { title: "Alpha book" }),
        await book(spaceKey, { title: "Beta book" }),
        await book(spaceKey, { title: "Gamma book" })
      ];
      const m = models(spaceKey);
      const { pages, result } = await runPass(depsFor(spaceKey, m));
      expect(pages).toHaveLength(3);
      for (const page of pages.slice(0, 2)) expect(page).toHaveProperty("continueWith");
      expect(pages[2]).not.toHaveProperty("continueWith");
      expect(result).toMatchObject({
        examined: 3,
        refreshed: 3,
        replaced: 3,
        embeddings: 3,
        graphs: 3,
        composites: 3
      });
      expect((result.refreshedIds as string[]).toSorted()).toEqual(
        libraries.map((library) => library.rootId).toSorted()
      );
      // In title order, one root per page.
      expect(m.graphs.map((graph) => graph.rootId)).toEqual(
        libraries.map((library) => library.rootId)
      );
    });

    it("asks for the composite backfill when it has no root left, so no header is embedded by both", async () => {
      const spaceKey = newSpace();
      await book(spaceKey);
      const afterPass = vi.fn(async () => true);
      const m = models(spaceKey);
      const { pages } = await runPass(depsFor(spaceKey, m, { afterPass }));
      expect(afterPass).toHaveBeenCalledTimes(pages.length > 0 ? 1 : 0);
      // Not between pages: only when the last one ended.
      const several = vi.fn(async () => true);
      const spaceTwo = newSpace();
      await book(spaceTwo, { title: "Delta book" });
      await book(spaceTwo, { title: "Epsilon book" });
      await runPass(depsFor(spaceTwo, models(spaceTwo), { afterPass: several }));
      expect(several).toHaveBeenCalledTimes(1);
    });

    // --- the job on the supervisor ------------------------------------------------------------------------

    describe("the catalog-header job", () => {
      const knowledgeOf = (m: ReturnType<typeof models>) => ({
        ...m.knowledge,
        isHierarchicalRoot: async () => false,
        summarizeSource: async () => ({ configured: true, generated: true }),
        summarizeHierarchiesForBatch: async () => ({
          generatedCount: 0,
          reusedCount: 0,
          blockedRoots: [],
          changedRootIds: []
        }),
        typeRelationPairs: async () => ({ calls: 0, cacheHits: 0, untyped: {}, results: [] }),
        promoteSourceRelations: async () => ({}),
        discoverSourceRelations: async () => ({})
      });
      const supervisorFor = (spaceKey: string, m: ReturnType<typeof models>) =>
        new JobSupervisor({
          getPool: () => db(),
          logger: quiet,
          generateEmbeddings: m.generate as never,
          embeddingSpaceKey: async () => spaceKey,
          knowledgeService: knowledgeOf(m) as never
        });
      const clearJobs = async () => {
        await db().query("delete from jobs where type in ($1, $2)", [
          catalogHeaderJobType,
          compositeBackfillJobType
        ]);
      };

      it("is queued once, behind the link jobs, runs on the relations worker and finishes the book", async () => {
        await clearJobs();
        const spaceKey = newSpace();
        const library = await book(spaceKey);
        const m = models(spaceKey);
        const supervisor = supervisorFor(spaceKey, m);
        expect(supervisor.supportsJobType(catalogHeaderJobType)).toBe(true);

        expect(await supervisor.ensureCatalogHeaderRefresh()).toBe(true);
        expect(await supervisor.ensureCatalogHeaderRefresh({ rootIds: [library.rootId] })).toBe(
          true
        );
        expect(await queuedHeaderJobs()).toBe(1);
        const [queued] = (
          await db().query<{ lane: string; priority: number }>(
            "select lane, priority from jobs where type = $1 and status = 'queued'",
            [catalogHeaderJobType]
          )
        ).rows;
        expect(queued).toMatchObject({ lane: "light", priority: -1 });

        // The heavy lane and the other light workers do not take it.
        expect(await supervisor.runOnce()).toBeNull();
        expect(await supervisor.runLightOnce("compute")).toBeNull();
        expect(await supervisor.runLightOnce("model")).toBeNull();
        const job = await supervisor.runLightOnce("relations");
        expect(job).toMatchObject({ type: catalogHeaderJobType, status: "succeeded" });
        expect(job?.result).toMatchObject({
          examined: 1,
          refreshed: 1,
          replaced: 1,
          embeddings: 1,
          graphs: 1,
          composites: 1,
          refreshedIds: [library.rootId]
        });
        // Every embedding the job made was at the background priority, for no ingestion run.
        for (const call of m.embedded) {
          expect(call.context).toMatchObject({ jobId: job!.id, priority: "P3" });
          expect(call.context).not.toHaveProperty("ingestionRunId");
        }
        expect(m.graphs[0]!.context).toMatchObject({ jobId: job!.id, priority: "P3" });
        // Nothing is left: a request queues nothing, and the composite backfill was asked for.
        expect(await supervisor.ensureCatalogHeaderRefresh()).toBe(false);
        expect(await queuedHeaderJobs()).toBe(0);
        expect(await compositeState(library)).toBe("current");
      });

      it("queues nothing at the start of a measurement run, and a job queued before it does nothing in it", async () => {
        const spaceKey = newSpace();
        const library = await book(spaceKey);
        const m = models(spaceKey);
        const supervisor = supervisorFor(spaceKey, m);
        // A job an earlier start of the profile queued.
        expect(await supervisor.ensureCatalogHeaderRefresh()).toBe(true);
        expect(await queuedHeaderJobs()).toBe(1);
        vi.stubEnv("MEMORA_RELATIONS_REMATCH", "arrival:20261031");
        try {
          // The start queues no refresh under the knob, and asks for no other either.
          expect(await supervisor.ensureCatalogHeaderRefresh()).toBe(false);
          const job = await supervisor.runLightOnce("relations");
          expect(job).toMatchObject({ type: catalogHeaderJobType, status: "succeeded" });
          expect(job?.result).toEqual({ skipped: "refresh_off", reason: "relations_rematch" });
        } finally {
          vi.unstubAllEnvs();
        }
        expect(m.generate).not.toHaveBeenCalled();
        expect(m.knowledge.generateCatalogKnowledgeGraph).not.toHaveBeenCalled();
        expect((await headerChunks(library.documentId))[0]!.id).toBe(library.chunkId);

        // A fresh start under the knob queues none at all.
        await db().query("delete from jobs where type = $1", [catalogHeaderJobType]);
        vi.stubEnv("MEMORA_GOLDEN_PIN", "extraction");
        try {
          const starting = supervisorFor(spaceKey, m);
          await starting.start();
          await starting.stop();
        } finally {
          vi.unstubAllEnvs();
        }
        expect(await queuedHeaderJobs()).toBe(0);
        const seen = await db().query("select 1 from jobs where type = $1", [catalogHeaderJobType]);
        expect(seen.rows).toHaveLength(0);
      });

      it("counts the root against the day's cap when the graph runs on a remote route", async () => {
        const spaceKey = newSpace();
        const library = await book(spaceKey);
        const m = models(spaceKey);
        m.knowledge.catalogGraphLocality.mockResolvedValue("remote");
        const supervisor = supervisorFor(spaceKey, m);
        expect(await supervisor.ensureCatalogHeaderRefresh()).toBe(true);
        const job = await supervisor.runLightOnce("relations");
        expect(job?.result).toMatchObject({ refreshed: 1, graphs: 1 });
        const stored = await db().query<{ value: { calls: number; day: string } }>(
          "select value from settings where key = $1",
          [catalogHeaderConfig.dailyRootsSettingKey]
        );
        expect(stored.rows[0]?.value.calls).toBe(1);
        expect((await headerChunks(library.documentId))[0]!.content).toContain(
          summaryOf(library.title)
        );
      });

      it("queues the pass at the app's start only when a library holds a header without its summary", async () => {
        await clearJobs();
        const spaceKey = newSpace();
        const m = models(spaceKey);
        const none = supervisorFor(spaceKey, m);
        await none.start();
        await none.stop();
        expect(await queuedHeaderJobs()).toBe(0);

        await book(spaceKey);
        await book(spaceKey);
        const starting = supervisorFor(spaceKey, m);
        await starting.start();
        await starting.stop();
        // One job for the library, not one per book, and not queued again by a second start.
        expect(await queuedHeaderJobs()).toBe(1);
        const again = supervisorFor(spaceKey, m);
        await again.start();
        await again.stop();
        expect(await queuedHeaderJobs()).toBe(1);
      });

      it("is not wired without a knowledge service or an embedding model", () => {
        const bare = new JobSupervisor({ getPool: () => db(), logger: quiet });
        expect(bare.supportsJobType(catalogHeaderJobType)).toBe(false);
      });

      it("does not claim a second pass while one runs, and queues one beside a running pass", async () => {
        await clearJobs();
        const spaceKey = newSpace();
        const slow = models(spaceKey);
        let release: () => void = () => undefined;
        const blocked = new Promise<void>((resolveBlock) => {
          release = resolveBlock;
        });
        slow.knowledge.generateCatalogKnowledgeGraph.mockImplementationOnce(
          async (rootId: string, documentId: string) => {
            await blocked;
            await extractGraph(rootId, documentId);
            return { configured: true, generated: true };
          }
        );
        const library = await book(spaceKey);
        const supervisor = supervisorFor(spaceKey, slow);
        expect(await supervisor.ensureCatalogHeaderRefresh()).toBe(true);
        const running = supervisor.runLightOnce("relations");
        await vi.waitFor(() =>
          expect(slow.knowledge.generateCatalogKnowledgeGraph).toHaveBeenCalled()
        );
        // A summary written meanwhile is not lost: a request queues a job beside the running one,
        // which is not claimed until the pass ends.
        const later = await book(spaceKey);
        expect(await supervisor.ensureCatalogHeaderRefresh({ rootIds: [later.rootId] })).toBe(true);
        expect(await queuedHeaderJobs()).toBe(1);
        expect(await supervisor.runLightOnce("relations", 1)).toBeNull();
        release();
        const first = await running;
        expect(first?.result).toMatchObject({ refreshed: 1 });
        // The pass queued its next page (the other root) and the request is a job of its own: they
        // run one after the other, and the second finds nothing left.
        let rounds = 0;
        while ((await supervisor.runLightOnce("relations")) !== null && rounds < 5) rounds += 1;
        expect(rounds).toBeGreaterThanOrEqual(1);
        expect((await headerChunks(library.documentId))[0]!.content).toContain(
          summaryOf(library.title)
        );
        expect((await headerChunks(later.documentId))[0]!.content).toContain(
          summaryOf(later.title)
        );
      });
    });

    // --- the orders an import can run its jobs in ---------------------------------------------------------

    describe("a book imported with each source paced on its own", () => {
      interface Staged {
        rootId: string;
        title: string;
        chapterJobs: string[];
        rootJob: string;
        rootRun: string;
        documentId: string;
      }

      /** A book as an import queues it: a run per chapter, and a catalog run for the book. */
      const stage = async (spaceKey: string, batchId: string, title: string): Promise<Staged> => {
        const runs = createIngestionRunRepository(db());
        const jobs = createJobRepository(db());
        const root = await sources().create({ type: "Book", title });
        const staged: Staged = {
          rootId: root.id,
          title,
          chapterJobs: [],
          rootJob: "",
          rootRun: "",
          documentId: ""
        };
        const contentStages = ["chunking", "summarization", "embedding"];
        for (let index = 1; index <= 2; index += 1) {
          const chapter = await sources().create({
            type: "BookChapter",
            title: `Chapter ${index} of ${title}`,
            parentSourceItemId: root.id
          });
          const markdown = `Chapter ${index} opens.\n\nIt argues point ${index} of ${title}.`;
          const documentId = randomUUID();
          await db().query(
            `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
           values ($1, $2, $3, $4, $5)`,
            [
              documentId,
              chapter.id,
              chapter.title,
              markdown,
              createHash("sha256").update(markdown).digest("hex")
            ]
          );
          const run = await runs.create({
            sourceItemId: chapter.id,
            batchId,
            requestedStages: contentStages,
            effectiveStages: contentStages,
            trigger: "interactive_import"
          });
          await runs.initializeStages(run.id, contentStages, ProcessingStages);
          const job = await jobs.create({
            type: "ingestion",
            payload: {
              ingestionRunId: run.id,
              batchId,
              sourceItemId: chapter.id,
              documentId,
              markdown,
              effectiveStages: contentStages,
              processingMode: "content"
            }
          });
          await runs.update(run.id, { jobId: job.id, currentStage: "chunking" });
          staged.chapterJobs.push(job.id);
        }
        void spaceKey;
        return staged;
      };

      /** The book's own catalog run, with the stages a full-knowledge plan gives it. */
      const queueCatalogRun = async (staged: Staged, batchId: string): Promise<void> => {
        const runs = createIngestionRunRepository(db());
        const catalogStages = ["chunking", "embedding", "knowledgeGraph"];
        staged.documentId = randomUUID();
        await db().query(
          `insert into documents (id, source_item_id, title, canonical_markdown, content_hash, metadata)
         values ($1, $2, $3, $4, $5, '{"processingMode":"catalog_metadata"}'::jsonb)`,
          [
            staged.documentId,
            staged.rootId,
            staged.title,
            staged.title,
            createHash("sha256").update(staged.title).digest("hex")
          ]
        );
        const run = await runs.create({
          sourceItemId: staged.rootId,
          batchId,
          requestedStages: ["embedding", "knowledgeGraph"],
          effectiveStages: catalogStages,
          trigger: "interactive_import"
        });
        await runs.initializeStages(run.id, catalogStages, ProcessingStages);
        const job = await createJobRepository(db()).create({
          type: "ingestion",
          payload: {
            ingestionRunId: run.id,
            batchId,
            sourceItemId: staged.rootId,
            documentId: staged.documentId,
            markdown: staged.title,
            effectiveStages: catalogStages,
            processingMode: "catalog_metadata"
          }
        });
        await runs.update(run.id, { jobId: job.id, currentStage: "chunking" });
        staged.rootJob = job.id;
        staged.rootRun = run.id;
      };

      const batch = () =>
        createHierarchicalIngestionRepository(db()).createBatch({
          trigger: "interactive_import",
          requestedPlan: {},
          effectivePlan: {},
          reingestionPolicy: "reuse_valid",
          targetSourceItemIds: []
        });

      /** The supervisor over a fake knowledge service whose barrier writes the batch's summaries. */
      const supervisorOver = (spaceKey: string, m: ReturnType<typeof models>, staged: Staged[]) => {
        const knowledge = {
          ...m.knowledge,
          isHierarchicalRoot: async (id: string) => staged.some((book) => book.rootId === id),
          summarizeSource: async () => ({ configured: true, generated: true }),
          summarizeHierarchiesForBatch: vi.fn(async () => {
            const changedRootIds: string[] = [];
            for (const { rootId, title } of staged) {
              const current = await sources().findById(rootId);
              if (current?.summary) continue;
              await sources().update(rootId, {
                summary: summaryOf(title),
                summaryGeneratedAt: new Date()
              });
              changedRootIds.push(rootId);
            }
            return {
              generatedCount: changedRootIds.length,
              reusedCount: 0,
              blockedRoots: [],
              changedRootIds
            };
          }),
          typeRelationPairs: async () => ({ calls: 0, cacheHits: 0, untyped: {}, results: [] }),
          promoteSourceRelations: async () => ({}),
          discoverSourceRelations: async () => ({})
        };
        const supervisor = new JobSupervisor({
          getPool: () => db(),
          logger: quiet,
          generateEmbeddings: m.generate as never,
          embeddingSpaceKey: async () => spaceKey,
          knowledgeService: knowledge as never
        });
        return { supervisor, knowledge };
      };

      it("rebuilds the header of a book whose catalog run went before its chapters' summaries", async () => {
        const spaceKey = newSpace();
        const batchId = (await batch()).id;
        const staged = await stage(spaceKey, batchId, "Retrieval and spacing");
        await queueCatalogRun(staged, batchId);
        // The book's own run is first in line, as when each source is paced on its own.
        await db().query(
          "update jobs set run_after = run_after - interval '1 hour' where id = $1",
          [staged.rootJob]
        );
        const m = models(spaceKey);
        const { supervisor, knowledge } = supervisorOver(spaceKey, m, [staged]);

        const first = await supervisor.runOnce();
        expect(first).toMatchObject({ id: staged.rootJob, status: "succeeded" });
        // The header was built before any summary existed.
        const early = (await headerChunks(staged.documentId))[0]!;
        expect(early.content).not.toContain("aggregate summary");
        expect(await queuedHeaderJobs()).toBe(0);

        // Then the chapters: the last one passes the summarization barrier and writes the summary.
        for (let ran = 0; ran < 2; ran += 1) {
          const job = await supervisor.runOnce();
          expect(job?.status, `${job?.error ?? ""}`).toBe("succeeded");
        }
        expect(knowledge.summarizeHierarchiesForBatch).toHaveBeenCalled();
        expect((await sources().findById(staged.rootId))?.summary).toContain("aggregate summary");
        // The summary written late queued the header's follow, on the relations worker.
        expect(await queuedHeaderJobs()).toBe(1);
        const embeddedBefore = m.embedded.length;
        const graphsBefore = m.graphs.length;
        let job: JobRecord | null = await supervisor.runLightOnce("relations");
        while (job !== null && job.type !== catalogHeaderJobType)
          job = await supervisor.runLightOnce("relations");
        expect(job).toMatchObject({ type: catalogHeaderJobType, status: "succeeded" });

        const source = (await sources().findById(staged.rootId))!;
        const chunks = await headerChunks(staged.documentId);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]!.content).toBe(buildCatalogMetadataMarkdown(source));
        expect(chunks[0]!.content).toContain(summaryOf(staged.title));
        expect(chunks[0]!.id).not.toBe(early.id);
        expect(await mentionChunkIds(staged.rootId)).toEqual([chunks[0]!.id]);
        expect(m.graphs.length).toBe(graphsBefore + 1);
        // One embedding for the rebuilt header: the chunk's, shared with the composite.
        expect(m.embedded.slice(embeddedBefore)).toHaveLength(1);
        expect(
          await compositeState({
            spaceKey,
            rootId: staged.rootId,
            title: staged.title,
            documentId: staged.documentId,
            chunkId: chunks[0]!.id
          })
        ).toBe("current");
        // And it is done: the book's header is current, with nothing left to queue.
        expect(await supervisor.ensureCatalogHeaderRefresh()).toBe(false);
      });

      it("queues nothing for a one-batch import: the book's run came last and its header has the summary", async () => {
        const spaceKey = newSpace();
        const batchId = (await batch()).id;
        const staged = await stage(spaceKey, batchId, "Sleep and learning");
        await queueCatalogRun(staged, batchId);
        const m = models(spaceKey);
        const { supervisor } = supervisorOver(spaceKey, m, [staged]);

        for (let ran = 0; ran < 3; ran += 1) {
          const job = await supervisor.runOnce();
          expect(job?.status, `${job?.error ?? ""}`).toBe("succeeded");
          while ((await supervisor.runLightOnce("relations")) !== null) continue;
        }
        const source = (await sources().findById(staged.rootId))!;
        const chunks = await headerChunks(staged.documentId);
        // The header has the summary from the start, as it does today.
        expect(chunks).toHaveLength(1);
        expect(chunks[0]!.content).toBe(buildCatalogMetadataMarkdown(source));
        expect(chunks[0]!.content).toContain(summaryOf(staged.title));
        const headerJobs = await db().query(
          "select 1 from jobs where type = $1 and status in ('queued', 'running', 'succeeded')",
          [catalogHeaderJobType]
        );
        expect(headerJobs.rows).toHaveLength(0);
        // The graph was extracted once, by the book's own run.
        expect(m.graphs).toHaveLength(1);
      });

      it("follows a summary written while the book's own catalog run was working, when that run ends", async () => {
        const spaceKey = newSpace();
        const batchId = (await batch()).id;
        const staged = await stage(spaceKey, batchId, "Attention and memory");
        await queueCatalogRun(staged, batchId);
        await db().query(
          "update jobs set run_after = run_after - interval '1 hour' where id = $1",
          [staged.rootJob]
        );
        const m = models(spaceKey);
        // The summary lands between the run's chunking and its end: the embedding of the run writes it.
        let written = false;
        const generate = vi.fn(async (texts: string[], signal: AbortSignal, context: object) => {
          if (!written) {
            written = true;
            await sources().update(staged.rootId, {
              summary: summaryOf(staged.title),
              summaryGeneratedAt: new Date()
            });
          }
          return m.generate(texts, signal, context);
        });
        const supervisor = new JobSupervisor({
          getPool: () => db(),
          logger: quiet,
          generateEmbeddings: generate as never,
          embeddingSpaceKey: async () => spaceKey,
          knowledgeService: {
            ...m.knowledge,
            isHierarchicalRoot: async () => false,
            summarizeSource: async () => ({ configured: true, generated: true }),
            summarizeHierarchiesForBatch: async () => ({
              generatedCount: 0,
              reusedCount: 0,
              blockedRoots: [],
              changedRootIds: []
            }),
            typeRelationPairs: async () => ({ calls: 0, cacheHits: 0, untyped: {}, results: [] }),
            promoteSourceRelations: async () => ({}),
            discoverSourceRelations: async () => ({})
          } as never
        });
        expect(await supervisor.runOnce()).toMatchObject({
          id: staged.rootJob,
          status: "succeeded"
        });
        expect((await headerChunks(staged.documentId))[0]!.content).not.toContain(
          "aggregate summary"
        );
        // While the run was working the root was left to it; when it ended the header was queued.
        expect(await queuedHeaderJobs()).toBe(1);
        while ((await supervisor.runLightOnce("relations")) !== null) continue;
        expect((await headerChunks(staged.documentId))[0]!.content).toContain(
          summaryOf(staged.title)
        );
      });
    });
  }
);
