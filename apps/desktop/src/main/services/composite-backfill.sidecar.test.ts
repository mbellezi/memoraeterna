import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chunkMarkdown } from "@app/conversion";
import {
  PostgresSidecarManager,
  closePgPool,
  createEmbeddingRepository,
  createHierarchicalIngestionRepository,
  createIngestionRunRepository,
  createJobRepository,
  createPgPool,
  createSourceItemRepository,
  createSourceRelationRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { ProcessingStages } from "@app/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  readRootPlacements,
  runCompositeBackfillStep
} from "./dev/relations-rematch-composites.js";
import { buildCatalogMetadataMarkdown } from "./hierarchical-ingestion-service.js";
import {
  aggregateSourceEmbedding,
  JobSupervisor,
  type JobSupervisorOptions
} from "./job-supervisor.js";
import {
  compositeBackfillJobType,
  enqueueCompositeBackfill,
  placementOf
} from "./relations/composite-backfill.js";
import {
  backfillSourceComposites,
  compositeStrategy,
  countCompositeBackfillWork,
  hasCompositeBackfillWork,
  hierarchyRootComposite,
  refreshAncestorComposites,
  type CompositeHeaderEmbedder
} from "./source-composite.js";

// T53f on a real database: the backfill of hierarchy-root composites (a root with none gets one, a
// current one is untouched, a second pass writes nothing, it is queued once and runs as a
// low-priority job on the `relations` worker), and a root's header embedded once in a one-batch
// import (no ancestor is built before the batch's aggregate summaries are written).
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

describe.skipIf(!sidecarInstalled)("hierarchy-root composites on PostgreSQL (T53f)", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-composite-backfill-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_composite_backfill_test",
        user: "memora_composite_backfill_test",
        password: `composite-backfill-${randomUUID()}`,
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
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // --- fixtures -----------------------------------------------------------------------------------

  /** Each test works in a space of its own: the pass looks at one space at a time. */
  const newSpace = () => `space-${randomUUID()}`;
  const work = async (title: string, parentId?: string, type = "AcademicPaper") => {
    const source = await createSourceItemRepository(db()).create({
      type: type as "AcademicPaper",
      title
    });
    if (parentId)
      await db().query("update source_items set parent_source_item_id = $1 where id = $2", [
        parentId,
        source.id
      ]);
    return source;
  };
  const composite = async (id: string, embedding: number[], spaceKey: string) =>
    createEmbeddingRepository(db()).upsert({
      targetType: "source_item",
      targetId: id,
      provider: "test",
      model: "test-256",
      runtime: "local",
      strategy: compositeStrategy(spaceKey),
      contentHash: `composite-${id}-${embedding.indexOf(1)}`,
      embedding
    });
  const compositeRow = async (id: string, spaceKey: string) =>
    (
      await db().query<{ createdAt: Date; contentHash: string }>(
        `select created_at as "createdAt", content_hash as "contentHash" from embeddings_256
          where target_type = 'source_item' and target_id = $1 and strategy = $2`,
        [id, compositeStrategy(spaceKey)]
      )
    ).rows[0];
  /** The header embedder of a route in `spaceKey`: it records each text with the source asked for. */
  const embedder = (spaceKey: string, calls: Array<{ text: string; sourceItemId: string }>) =>
    vi.fn<CompositeHeaderEmbedder>(async (text, context) => {
      calls.push({ text, sourceItemId: context.sourceItemId });
      return {
        embedding: unit(7),
        provider: "test",
        model: "test-256",
        runtime: "local",
        spaceKey
      };
    });
  const backfill = (
    spaceKey: string,
    embed: CompositeHeaderEmbedder,
    extra: Partial<Parameters<typeof backfillSourceComposites>[0]> = {}
  ) =>
    backfillSourceComposites({
      pool: db(),
      spaceKey,
      embed,
      aggregate: aggregateSourceEmbedding,
      ...extra
    });
  const headerOf = async (id: string) =>
    buildCatalogMetadataMarkdown((await createSourceItemRepository(db()).findById(id))!);
  const queuedBackfills = async () =>
    Number(
      (
        await db().query<{ n: number }>(
          "select count(*)::int as n from jobs where type = $1 and status = 'queued'",
          [compositeBackfillJobType]
        )
      ).rows[0]!.n
    );

  // --- the backfill --------------------------------------------------------------------------------

  it("builds the composite of a book that has none from its header and its chapters'", async () => {
    const spaceKey = newSpace();
    const book = await work("Backfilled book", undefined, "Book");
    const one = await work("Backfill chapter one", book.id, "BookChapter");
    const two = await work("Backfill chapter two", book.id, "BookChapter");
    await composite(one.id, unit(4), spaceKey);
    await composite(two.id, unit(5), spaceKey);
    const repository = createSourceRelationRepository(db());
    expect(await repository.discoveryVector(book.id)).toBeNull();
    expect(await hasCompositeBackfillWork(db(), spaceKey)).toBe(true);
    expect(await countCompositeBackfillWork(db(), spaceKey)).toBe(1);

    const calls: Array<{ text: string; sourceItemId: string }> = [];
    const result = await backfill(spaceKey, embedder(spaceKey, calls));

    expect(result).toMatchObject({
      examined: 1,
      written: [book.id],
      rebuilt: 0,
      current: 0,
      incomplete: 0,
      failed: [],
      stopped: null
    });
    // The catalog header, once, for the book (the audit names the source it belongs to).
    expect(calls.map((call) => call.text)).toEqual(
      chunkMarkdown(await headerOf(book.id)).map((chunk) => chunk.content)
    );
    expect(calls.every((call) => call.sourceItemId === book.id)).toBe(true);
    expect((await repository.discoveryVector(book.id))?.spaceKey).toBe(`256:${spaceKey}`);
    // The root's own stage and a chapter's refresh find it current: no header is embedded again.
    expect(
      await hierarchyRootComposite({
        pool: db(),
        sourceItemId: book.id,
        header: await headerOf(book.id),
        space: {
          model: "test-256",
          dimensions: 256,
          strategy: compositeStrategy(spaceKey)
        }
      })
    ).toBe("current");
    expect(await hasCompositeBackfillWork(db(), spaceKey)).toBe(false);
  });

  it("leaves a root whose composite is current alone, and writes nothing the second time", async () => {
    const spaceKey = newSpace();
    const book = await work("Settled book", undefined, "Book");
    const one = await work("Settled chapter one", book.id, "BookChapter");
    const two = await work("Settled chapter two", book.id, "BookChapter");
    await composite(one.id, unit(4), spaceKey);
    await composite(two.id, unit(5), spaceKey);
    const calls: Array<{ text: string; sourceItemId: string }> = [];
    const embed = embedder(spaceKey, calls);
    expect((await backfill(spaceKey, embed)).written).toEqual([book.id]);
    const stored = await compositeRow(book.id, spaceKey);
    const embedded = calls.length;

    const again = await backfill(spaceKey, embed);

    expect(again).toMatchObject({ examined: 1, written: [], current: 1, incomplete: 0 });
    expect(embed).toHaveBeenCalledTimes(embedded);
    // The row was not written: its timestamp and hash are the first pass's.
    expect(await compositeRow(book.id, spaceKey)).toEqual(stored);
  });

  it("rebuilds a composite that went stale when a chapter was embedded again", async () => {
    const spaceKey = newSpace();
    const book = await work("Stale book", undefined, "Book");
    const one = await work("Stale chapter one", book.id, "BookChapter");
    const two = await work("Stale chapter two", book.id, "BookChapter");
    await composite(one.id, unit(4), spaceKey);
    await composite(two.id, unit(5), spaceKey);
    const calls: Array<{ text: string; sourceItemId: string }> = [];
    const embed = embedder(spaceKey, calls);
    await backfill(spaceKey, embed);
    const before = await compositeRow(book.id, spaceKey);

    await composite(one.id, unit(6), spaceKey);
    const result = await backfill(spaceKey, embed);

    expect(result).toMatchObject({ written: [book.id], rebuilt: 1, current: 0 });
    expect((await compositeRow(book.id, spaceKey))?.contentHash).not.toBe(before?.contentHash);
    // A stale composite is not a gap the cheap test counts: the pass itself finds it.
    expect(await hasCompositeBackfillWork(db(), spaceKey)).toBe(false);
  });

  it("waits for a chapter that has no composite and builds nothing from the others", async () => {
    const spaceKey = newSpace();
    const book = await work("Waiting book", undefined, "Book");
    const one = await work("Waiting chapter one", book.id, "BookChapter");
    await work("Waiting chapter two", book.id, "BookChapter");
    await composite(one.id, unit(4), spaceKey);
    const calls: Array<{ text: string; sourceItemId: string }> = [];

    const result = await backfill(spaceKey, embedder(spaceKey, calls));

    expect(result).toMatchObject({ examined: 1, written: [], incomplete: 1 });
    expect(calls).toEqual([]);
    expect(await createSourceRelationRepository(db()).discoveryVector(book.id)).toBeNull();
    // Not a gap the backfill can close: it is not queued for it.
    expect(await hasCompositeBackfillWork(db(), spaceKey)).toBe(false);
  });

  it("builds a part's composite before its book's, nearest the chapters first", async () => {
    const spaceKey = newSpace();
    const book = await work("Parted book", undefined, "Book");
    const part = await work("Parted part", book.id, "DocumentSection");
    const one = await work("Parted chapter one", part.id, "BookChapter");
    const two = await work("Parted chapter two", part.id, "BookChapter");
    await composite(one.id, unit(4), spaceKey);
    await composite(two.id, unit(5), spaceKey);

    const calls: Array<{ text: string; sourceItemId: string }> = [];
    const result = await backfill(spaceKey, embedder(spaceKey, calls));

    expect(result.written).toEqual([part.id, book.id]);
    expect(calls.map((call) => call.sourceItemId)).toEqual([
      ...chunkMarkdown(await headerOf(part.id)).map(() => part.id),
      ...chunkMarkdown(await headerOf(book.id)).map(() => book.id)
    ]);
    for (const id of [part.id, book.id])
      expect(
        await hierarchyRootComposite({
          pool: db(),
          sourceItemId: id,
          header: await headerOf(id),
          space: { model: "test-256", dimensions: 256, strategy: compositeStrategy(spaceKey) }
        })
      ).toBe("current");
  });

  it("looks at the space the route writes to and no other", async () => {
    const spaceKey = newSpace();
    const elsewhere = newSpace();
    const book = await work("Other space book", undefined, "Book");
    const chapter = await work("Other space chapter", book.id, "BookChapter");
    await composite(chapter.id, unit(4), elsewhere);
    const calls: Array<{ text: string; sourceItemId: string }> = [];

    const result = await backfill(spaceKey, embedder(spaceKey, calls));

    expect(result).toMatchObject({ examined: 0, written: [] });
    expect(calls).toEqual([]);
    expect(await hasCompositeBackfillWork(db(), spaceKey)).toBe(false);
    expect(await hasCompositeBackfillWork(db(), elsewhere)).toBe(true);
  });

  it("reports a node it cannot build and goes on; a cancellation is thrown; no model stops it", async () => {
    const spaceKey = newSpace();
    const failing = await work("Failing book", undefined, "Book");
    const sound = await work("Sound book", undefined, "Book");
    for (const book of [failing, sound]) {
      const chapter = await work(`${book.title} chapter`, book.id, "BookChapter");
      await composite(chapter.id, unit(4), spaceKey);
    }
    const warn = vi.fn();
    const calls: Array<{ text: string; sourceItemId: string }> = [];
    const embed = embedder(spaceKey, calls);
    const flaky: CompositeHeaderEmbedder = async (text, context) => {
      if (context.sourceItemId === failing.id) throw new Error("cassette miss");
      return embed(text, context);
    };

    const result = await backfill(spaceKey, flaky, { warn });

    expect(result.written).toEqual([sound.id]);
    expect(result.failed).toEqual([{ sourceItemId: failing.id, message: "cassette miss" }]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ message: "cassette miss" }),
      failing.id
    );

    const controller = new AbortController();
    controller.abort();
    await expect(backfill(spaceKey, flaky, { signal: controller.signal })).rejects.toThrow();

    // No embedding model routed: the pass stops, writing nothing.
    const stopped = await backfill(spaceKey, async () => null);
    expect(stopped).toMatchObject({ written: [], stopped: "no_embedding" });
    // A header embedded in another space would mix spaces.
    const moved = await backfill(spaceKey, async () => ({
      embedding: unit(7),
      provider: "test",
      model: "test-256",
      runtime: "local",
      spaceKey: newSpace()
    }));
    expect(moved).toMatchObject({ written: [], stopped: "space_changed" });
  });

  it("builds no ancestor while the batch's aggregate summaries are still to be written", async () => {
    const spaceKey = newSpace();
    const book = await work("Awaiting book", undefined, "Book");
    const one = await work("Awaiting chapter one", book.id, "BookChapter");
    const two = await work("Awaiting chapter two", book.id, "BookChapter");
    await composite(one.id, unit(4), spaceKey);
    await composite(two.id, unit(5), spaceKey);
    const calls: Array<{ text: string; sourceItemId: string }> = [];
    const embed = embedder(spaceKey, calls);
    const refresh = (awaitingSummary: boolean) =>
      refreshAncestorComposites({
        pool: db(),
        sourceItemId: two.id,
        embed,
        aggregate: aggregateSourceEmbedding,
        awaitingSummary
      });

    expect(await refresh(true)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await createSourceRelationRepository(db()).discoveryVector(book.id)).toBeNull();
    // Once the summaries are written it builds as before.
    expect(await refresh(false)).toEqual([book.id]);
    expect(calls.length).toBeGreaterThan(0);
  });

  // --- the job -------------------------------------------------------------------------------------

  describe("the relation-composite job", () => {
    const hooks = () => ({
      notesChanged: vi.fn(async () => undefined),
      sourcesChanged: vi.fn(async () => undefined),
      itemsRemoved: vi.fn(async () => undefined)
    });
    type Generate = NonNullable<JobSupervisorOptions["generateEmbedding"]>;
    const generator = (spaceKey: string) =>
      vi.fn<Generate>(async () => ({
        embedding: unit(9),
        provider: "test",
        model: "test-256",
        runtime: "local",
        spaceKey
      }));
    const supervisorFor = (
      spaceKey: string,
      options: {
        topicHooks?: ReturnType<typeof hooks>;
        generate?: ReturnType<typeof generator>;
        withSpace?: boolean;
      } = {}
    ) =>
      new JobSupervisor({
        getPool: () => db(),
        logger: quiet,
        generateEmbedding: options.generate ?? generator(spaceKey),
        ...(options.withSpace === false ? {} : { embeddingSpaceKey: async () => spaceKey }),
        ...(options.topicHooks ? { topicHooks: options.topicHooks } : {})
      });

    it("is queued once, behind the link jobs, and runs on the relations worker", async () => {
      const spaceKey = newSpace();
      const book = await work("Queued book", undefined, "Book");
      const chapter = await work("Queued chapter", book.id, "BookChapter");
      await composite(chapter.id, unit(4), spaceKey);
      const topicHooks = hooks();
      const generate = generator(spaceKey);
      const supervisor = supervisorFor(spaceKey, { topicHooks, generate });
      expect(supervisor.supportsJobType(compositeBackfillJobType)).toBe(true);

      expect(await supervisor.ensureCompositeBackfill()).toBe(true);
      expect(await supervisor.ensureCompositeBackfill()).toBe(true);
      expect(await enqueueCompositeBackfill(db(), spaceKey)).toBe(true);
      expect(await queuedBackfills()).toBe(1);
      const [queued] = (
        await db().query<{ lane: string; priority: number; payload: unknown }>(
          "select lane, priority, payload from jobs where type = $1 and status = 'queued'",
          [compositeBackfillJobType]
        )
      ).rows;
      expect(queued).toMatchObject({ lane: "light", priority: -1 });
      expect(await supervisor.compositeBackfillRemaining()).toBe(1);

      // The heavy lane and the other light workers do not take it.
      expect(await supervisor.runLightOnce("compute")).toBeNull();
      expect(await supervisor.runLightOnce("model")).toBeNull();
      const job = await supervisor.runLightOnce("relations");

      expect(job).toMatchObject({ type: compositeBackfillJobType, status: "succeeded" });
      expect(job?.result).toMatchObject({
        spaceKey,
        examined: 1,
        written: 1,
        rebuilt: 0,
        failed: 0,
        roots: 1,
        rootsWithCurrentNotes: 0,
        writtenIds: [book.id]
      });
      // The header is embedded at the background priority, for no ingestion run.
      expect(generate).toHaveBeenCalled();
      const context = generate.mock.calls[0]![2];
      expect(context).toMatchObject({
        jobId: job!.id,
        sourceItemId: book.id,
        stage: "source_embedding",
        priority: "P3"
      });
      expect(context).not.toHaveProperty("ingestionRunId");
      expect(topicHooks.sourcesChanged).toHaveBeenCalledWith([book.id]);
      // Nothing left: no job is queued for it again, and a rerun writes nothing.
      expect(await supervisor.compositeBackfillRemaining()).toBe(0);
      expect(await supervisor.ensureCompositeBackfill()).toBe(false);
      expect(await queuedBackfills()).toBe(0);
    });

    it("fails the job, with the real error, when every node it tried failed", async () => {
      const spaceKey = newSpace();
      const book = await work("Failing job book", undefined, "Book");
      const chapter = await work("Failing job chapter", book.id, "BookChapter");
      await composite(chapter.id, unit(4), spaceKey);
      const supervisor = supervisorFor(spaceKey, {
        generate: vi.fn<NonNullable<JobSupervisorOptions["generateEmbedding"]>>(async () => {
          throw new Error("errors.models.invalidOutput");
        })
      });
      expect(await supervisor.ensureCompositeBackfill()).toBe(true);

      const job = await supervisor.runLightOnce("relations");

      expect(job).toMatchObject({ status: "failed", error: "errors.models.invalidOutput" });
      expect(await createSourceRelationRepository(db()).discoveryVector(book.id)).toBeNull();
      // The gap is still there for the next request.
      expect(await supervisor.compositeBackfillRemaining()).toBe(1);
    });

    it("queues no second job beside a running one: two passes would embed the same headers twice", async () => {
      const spaceKey = newSpace();
      const book = await work("Running book", undefined, "Book");
      const chapter = await work("Running chapter", book.id, "BookChapter");
      await composite(chapter.id, unit(4), spaceKey);
      const running = await createJobRepository(db()).create({
        type: compositeBackfillJobType,
        lane: "light"
      });
      await db().query("update jobs set status = 'running', locked_at = now() where id = $1", [
        running.id
      ]);
      expect(await enqueueCompositeBackfill(db(), spaceKey)).toBe(true);
      expect(await queuedBackfills()).toBe(0);
      // Once it ends, the gap it left is queued again.
      await db().query("update jobs set status = 'succeeded', finished_at = now() where id = $1", [
        running.id
      ]);
      expect(await enqueueCompositeBackfill(db(), spaceKey)).toBe(true);
      expect(await queuedBackfills()).toBe(1);
      await db().query(
        "update jobs set status = 'canceled' where type = $1 and status = 'queued'",
        [compositeBackfillJobType]
      );
    });

    it("is not wired without an embedding model and the space the route writes to", async () => {
      const spaceKey = newSpace();
      const without = supervisorFor(spaceKey, { withSpace: false });
      expect(without.supportsJobType(compositeBackfillJobType)).toBe(false);
      expect(await without.ensureCompositeBackfill()).toBe(false);
      expect(await without.compositeBackfillRemaining()).toBe(0);
      const bare = new JobSupervisor({ getPool: () => db(), logger: quiet });
      expect(bare.supportsJobType(compositeBackfillJobType)).toBe(false);
    });

    it("counts the roots with current notes among the ones it wrote: they keep their vector", async () => {
      const spaceKey = newSpace();
      const withNotes = await work("Noted book", undefined, "Book");
      const bare = await work("Bare book", undefined, "Book");
      const noteChapter = await work("Noted chapter", withNotes.id, "BookChapter");
      const bareChapter = await work("Bare chapter", bare.id, "BookChapter");
      await composite(noteChapter.id, unit(4), spaceKey);
      await composite(bareChapter.id, unit(5), spaceKey);
      const documentId = randomUUID();
      const chunkId = randomUUID();
      await db().query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'text', $3)`,
        [documentId, noteChapter.id, `hash-${documentId}`]
      );
      await db().query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, 0, 'Passage', $4)`,
        [chunkId, documentId, noteChapter.id, `chunk-${chunkId}`]
      );
      await db().query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
           evidence_chunk_id, generation_provider, generation_model, generation_runtime,
           generation_prompt_version, generation_key)
         values ($1::uuid, 'Note', 'Note', 'Note', $2, $3, 'test', 'test', 'local', 'test', $1::uuid::text)`,
        [randomUUID(), noteChapter.id, chunkId]
      );

      expect(await placementOf(db(), [withNotes.id, bare.id, noteChapter.id])).toEqual({
        roots: 2,
        withCurrentNotes: 1
      });
      expect(await placementOf(db(), [])).toEqual({ roots: 0, withCurrentNotes: 0 });
    });
  });

  // --- the re-match harness waits for it -----------------------------------------------------------

  describe("the first step of a re-match run", () => {
    /** A book with two chapters that have composites; with `notes`, a current note on a chapter. */
    async function library(spaceKey: string, title: string, notes: boolean) {
      const book = await work(title, undefined, "Book");
      const one = await work(`${title}, chapter one`, book.id, "BookChapter");
      const two = await work(`${title}, chapter two`, book.id, "BookChapter");
      await composite(one.id, unit(4), spaceKey);
      await composite(two.id, unit(5), spaceKey);
      if (notes) {
        const documentId = randomUUID();
        const chunkId = randomUUID();
        await db().query(
          `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
           values ($1, $2, 'Document', 'text', $3)`,
          [documentId, one.id, `hash-${documentId}`]
        );
        await db().query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
           values ($1, $2, $3, 0, 'Passage', $4)`,
          [chunkId, documentId, one.id, `chunk-${chunkId}`]
        );
        await db().query(
          `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
             evidence_chunk_id, generation_provider, generation_model, generation_runtime,
             generation_prompt_version, generation_key)
           values ($1::uuid, 'Note', 'Note', 'Note', $2, $3, 'test', 'test', 'local', 'test', $1::uuid::text)`,
          [randomUUID(), one.id, chunkId]
        );
      }
      return book;
    }
    const supervisorFor = (spaceKey: string) =>
      new JobSupervisor({
        getPool: () => db(),
        logger: quiet,
        generateEmbedding: async () => ({
          embedding: unit(9),
          provider: "test",
          model: "test-256",
          runtime: "local",
          spaceKey
        }),
        embeddingSpaceKey: async () => spaceKey
      });
    /** The step's dependencies, with the relations worker's lane stood in for by the wait itself. */
    function stepOf(supervisor: JobSupervisor, options: { runJobs: boolean; since: Date }) {
      const clock = { now: Date.now() };
      return {
        clock,
        deps: {
          pool: db(),
          ensure: ({ full }: { full: boolean }) =>
            supervisor.ensureCompositeBackfill({ always: full }),
          remaining: () => supervisor.compositeBackfillRemaining(),
          now: () => new Date(clock.now),
          sleep: async (ms: number) => {
            clock.now += ms;
            if (options.runJobs) await supervisor.runLightOnce("relations");
          },
          since: options.since,
          log: () => undefined
        }
      };
    }
    const run = { signal: new AbortController().signal, timeoutMs: 60_000, pollMs: 10 };

    it("waits for the backfill to drain and says how many composites it wrote", async () => {
      const since = new Date();
      const spaceKey = newSpace();
      const bare = await library(spaceKey, "Step bare book", false);
      const noted = await library(spaceKey, "Step noted book", true);
      const supervisor = supervisorFor(spaceKey);
      // The app's start queued the job already: the step waits for it and never doubles it.
      expect(await supervisor.ensureCompositeBackfill()).toBe(true);
      const { deps } = stepOf(supervisor, { runJobs: true, since });

      const facts = await runCompositeBackfillStep(deps, run);

      expect(facts).toMatchObject({
        jobs: 1,
        examined: 2,
        written: 2,
        rebuilt: 0,
        failed: 0,
        remaining: 0,
        skipped: []
      });
      // No topic tree here: nothing was placed, and the roots are told apart by their notes.
      expect(facts.placements).toMatchObject({
        backfilledRoots: 2,
        withCurrentNotes: 1,
        moved: 0,
        movedWithCurrentNotes: 0
      });
      for (const book of [bare, noted])
        expect(await createSourceRelationRepository(db()).discoveryVector(book.id)).not.toBeNull();
      const roots = await readRootPlacements(db(), [bare.id, noted.id]);
      expect(roots.map((root) => [root.title, root.hasCurrentNotes, root.placement])).toEqual([
        ["Step bare book", false, null],
        ["Step noted book", true, null]
      ]);
      expect(await queuedBackfills()).toBe(0);
    });

    it("rebuilds a composite that went stale, which no gap test finds, in its first round", async () => {
      const since = new Date();
      const spaceKey = newSpace();
      const book = await library(spaceKey, "Stale step book", false);
      const supervisor = supervisorFor(spaceKey);
      await runCompositeBackfillStep(stepOf(supervisor, { runJobs: true, since }).deps, run);
      const built = await compositeRow(book.id, spaceKey);
      // A chapter embedded again: the book's composite is stale, and nothing is missing.
      const [chapter] = (
        await db().query<{ id: string }>(
          "select id from source_items where parent_source_item_id = $1 order by title limit 1",
          [book.id]
        )
      ).rows;
      await composite(chapter!.id, unit(8), spaceKey);
      expect(await supervisor.compositeBackfillRemaining()).toBe(0);
      expect(await supervisor.ensureCompositeBackfill()).toBe(false);

      const later = new Date();
      const facts = await runCompositeBackfillStep(
        stepOf(supervisor, { runJobs: true, since: later }).deps,
        run
      );

      expect(facts).toMatchObject({ jobs: 1, written: 1, rebuilt: 1, remaining: 0 });
      expect((await compositeRow(book.id, spaceKey))?.contentHash).not.toBe(built?.contentHash);
    });

    it("queues the job itself when the app's start did not, and finds nothing the second time", async () => {
      const since = new Date();
      const spaceKey = newSpace();
      await library(spaceKey, "Late step book", false);
      const supervisor = supervisorFor(spaceKey);
      const first = await runCompositeBackfillStep(
        stepOf(supervisor, { runJobs: true, since }).deps,
        run
      );
      expect(first).toMatchObject({ jobs: 1, written: 1, remaining: 0 });
      // A rerun in a later app run: the first round queues a pass over every node, which finds
      // each composite current and writes and embeds nothing.
      const again = await runCompositeBackfillStep(
        stepOf(supervisor, { runJobs: true, since: new Date() }).deps,
        run
      );
      expect(again).toMatchObject({ jobs: 1, examined: 1, written: 0, current: 1, remaining: 0 });
      expect(await queuedBackfills()).toBe(0);
    });

    it("says how many topic jobs the backfill caused were still open when it stopped waiting", async () => {
      const since = new Date();
      const spaceKey = newSpace();
      await library(spaceKey, "Topic step book", false);
      const supervisor = supervisorFor(spaceKey);
      const gate = await createJobRepository(db()).create({ type: "topic-gate", lane: "light" });
      const { deps } = stepOf(supervisor, { runJobs: true, since });

      const facts = await runCompositeBackfillStep(deps, {
        signal: run.signal,
        timeoutMs: 500,
        pollMs: 50
      });

      expect(facts).toMatchObject({ written: 1, remaining: 0 });
      expect(facts.placements.topicJobsOpen).toBe(1);
      await db().query("update jobs set status = 'canceled' where id = $1", [gate.id]);
    });

    it("reports the gap that stays when the job never drains, instead of waiting for ever", async () => {
      const since = new Date();
      const spaceKey = newSpace();
      await library(spaceKey, "Stuck step book", false);
      const supervisor = supervisorFor(spaceKey);
      const { deps, clock } = stepOf(supervisor, { runJobs: false, since });
      const started = clock.now;

      const facts = await runCompositeBackfillStep(deps, {
        signal: run.signal,
        timeoutMs: 200,
        pollMs: 50
      });

      expect(facts).toMatchObject({ jobs: 1, written: 0, remaining: 1 });
      expect(clock.now - started).toBeLessThan(2_000);
      // The job is still queued once: the rounds merged into it.
      expect(await queuedBackfills()).toBe(1);
      await db().query(
        "update jobs set status = 'canceled' where type = $1 and status = 'queued'",
        [compositeBackfillJobType]
      );
    });
  });

  // --- a root's header embedded once in a one-batch import ----------------------------------------

  describe("a one-batch import of books", () => {
    /** A book with two chapters, as an import queues it: a run per chapter, one for the book. */
    interface Book {
      root: { id: string; title: string };
      chapters: Array<{ id: string; title: string }>;
      rootRun: string;
      chapterRuns: string[];
    }

    async function stageBook(
      batchId: string,
      title: string,
      volume: number,
      chapters: number,
      sources: Book[]
    ): Promise<{ chapterJobs: string[]; rootJob: () => Promise<string> }> {
      const sourceRepository = createSourceItemRepository(db());
      const runs = createIngestionRunRepository(db());
      const jobs = createJobRepository(db());
      const root = await sourceRepository.create({ type: "Book", title });
      const book: Book = { root, chapters: [], rootRun: "", chapterRuns: [] };
      const chapterJobs: string[] = [];
      const contentStages = ["chunking", "summarization", "embedding"];
      for (let index = 1; index <= chapters; index += 1) {
        const chapter = await sourceRepository.create({
          type: "BookChapter",
          // No chapter title holds its book's, so a header of the book is told from a chapter's.
          title: `Chapter ${index} of volume ${volume}`,
          parentSourceItemId: root.id
        });
        const markdown = `Chapter ${index} opens.\n\nIt argues point ${index} of volume ${volume}.`;
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
        book.chapters.push(chapter);
        book.chapterRuns.push(run.id);
        chapterJobs.push(job.id);
      }
      sources.push(book);
      // The book's own run is queued after every content run of the batch, with its catalog header.
      const rootJob = async () => {
        const catalogStages = ["chunking", "embedding"];
        const documentId = randomUUID();
        await db().query(
          `insert into documents (id, source_item_id, title, canonical_markdown, content_hash, metadata)
           values ($1, $2, $3, $4, $5, '{"processingMode":"catalog_metadata"}'::jsonb)`,
          [documentId, root.id, title, title, createHash("sha256").update(title).digest("hex")]
        );
        const run = await runs.create({
          sourceItemId: root.id,
          batchId,
          requestedStages: ["embedding"],
          effectiveStages: catalogStages,
          trigger: "interactive_import"
        });
        await runs.initializeStages(run.id, catalogStages, ProcessingStages);
        const job = await jobs.create({
          type: "ingestion",
          payload: {
            ingestionRunId: run.id,
            batchId,
            sourceItemId: root.id,
            documentId,
            markdown: title,
            effectiveStages: catalogStages,
            processingMode: "catalog_metadata"
          }
        });
        await runs.update(run.id, { jobId: job.id, currentStage: "chunking" });
        book.rootRun = run.id;
        return job.id;
      };
      return { chapterJobs, rootJob };
    }

    // The second case is the one that embedded a header twice: the first book's last chapter
    // embeds before the second book's chapters have been summarized, so the batch's aggregate
    // summaries are not written yet. In the first, the last chapter passes the barrier itself.
    it.each([
      { name: "a book of two chapters", chapters: [2] },
      { name: "a book of two chapters beside a book of one", chapters: [2, 1] }
    ])(
      "embeds each header once in a one-batch import of $name",
      async ({ chapters }) => {
        const spaceKey = newSpace();
        const sources: Book[] = [];
        const batch = await createHierarchicalIngestionRepository(db()).createBatch({
          trigger: "interactive_import",
          requestedPlan: {},
          effectivePlan: {},
          reingestionPolicy: "reuse_valid",
          targetSourceItemIds: []
        });
        const bookTitles = ["Memory and spacing", "Sleep and learning"];
        const staged = [];
        for (const [index, count] of chapters.entries())
          staged.push(await stageBook(batch.id, bookTitles[index]!, index + 1, count, sources));
        // The books' own runs are queued after every content run of the batch.
        for (const book of staged) await book.rootJob();

        // The calls that embed a book's header (a segment of its catalog header) and nothing else.
        const headerCalls: Array<{ text: string; stage: string }> = [];
        const generate = vi.fn(
          async (
            text: string,
            _signal: AbortSignal | undefined,
            context?: { stage: string; sourceItemId: string }
          ) => {
            if (context?.stage === "source_embedding")
              headerCalls.push({ text, stage: context.stage });
            return {
              embedding: unit(text.length % 200),
              provider: "test",
              model: "test-256",
              runtime: "local",
              spaceKey
            };
          }
        );
        // The barrier: the job that passes it writes every root's aggregate summary (a summary
        // written into a root deletes its composite, as the repository does for any update).
        const summaries = vi.fn(async () => {
          for (const { root } of sources) {
            const current = await createSourceItemRepository(db()).findById(root.id);
            if (current?.summary) continue;
            await createSourceItemRepository(db()).update(root.id, {
              summary: `An aggregate summary of ${root.title}.`,
              summaryGeneratedAt: new Date()
            });
          }
          return { generatedCount: sources.length, reusedCount: 0, blockedRoots: [] };
        });
        const knowledgeService = {
          isHierarchicalRoot: async (id: string) =>
            sources.some((book) => book.root.id === id && book.chapters.length > 0),
          summarizeSource: async () => ({ configured: true, generated: true }),
          summarizeHierarchiesForBatch: summaries
        };
        const supervisor = new JobSupervisor({
          getPool: () => db(),
          logger: quiet,
          generateEmbedding: generate,
          embeddingSpaceKey: async () => spaceKey,
          knowledgeService: knowledgeService as never
        });

        const jobs = chapters.reduce((total, count) => total + count, 0) + chapters.length;
        for (let ran = 0; ran < jobs; ran += 1) {
          const job = await supervisor.runOnce();
          expect(job?.status, `job ${ran + 1}: ${job?.error ?? ""}`).toBe("succeeded");
        }
        expect(await supervisor.runOnce()).toBeNull();

        for (const book of sources) {
          const source = (await createSourceItemRepository(db()).findById(book.root.id))!;
          expect(source.summary).toContain("aggregate summary");
          const segments = chunkMarkdown(buildCatalogMetadataMarkdown(source)).map(
            (chunk) => chunk.content
          );
          // One embedding of the final header (with its summary) and none of an earlier one.
          const embedded = headerCalls.filter((call) => call.text.includes(book.root.title));
          expect(
            embedded.map((call) => call.text),
            book.root.title
          ).toEqual(segments);
          // The header chunk of the book (chunk 0 of its catalog document) is that same header, so
          // the composite and the chunk are built from one text.
          const chunk = await db().query<{ content: string }>(
            "select content from chunks where source_item_id = $1 and chunk_index = 0",
            [book.root.id]
          );
          expect(chunk.rows.map((row) => row.content)).toEqual([
            buildCatalogMetadataMarkdown(source)
          ]);
          // The composite is there and holds exactly the final header and the chapters' composites.
          expect(
            await hierarchyRootComposite({
              pool: db(),
              sourceItemId: book.root.id,
              header: buildCatalogMetadataMarkdown(source),
              space: {
                model: "test-256",
                dimensions: 256,
                strategy: compositeStrategy(spaceKey)
              }
            })
          ).toBe("current");
          expect(
            (await createSourceRelationRepository(db()).discoveryVector(book.root.id))?.spaceKey
          ).toBe(`256:${spaceKey}`);
        }
        // Nothing is left for the backfill to build.
        expect(await supervisor.compositeBackfillRemaining()).toBe(0);
      },
      60_000
    );
  });
});
