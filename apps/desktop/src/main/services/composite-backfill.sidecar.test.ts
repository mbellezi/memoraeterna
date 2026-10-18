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
  readCompositeJobFacts,
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
  compositeBackfillPage,
  enqueueCompositeBackfill,
  placementOf,
  readBackfillRoots
} from "./relations/composite-backfill.js";
import type { TopicChangeHooks } from "./topic-tree/topic-hooks.js";
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
// current one is untouched, a second pass writes nothing, it is queued once and runs as a paged,
// low-priority job on the `relations` worker), and a one-batch import of books, where every book's
// composite is there when its discovery runs (no batch barrier) and a root's header is embedded once
// when its last chapter passes the summarization barrier.
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
  /** An active topic tree with one root topic: the notes a test places are placed in it. */
  let treeId = "";
  let topicId = "";

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
    treeId = (
      await pool.query<{ id: string }>(
        `insert into topic_trees (status, space_key, embedding_provider, embedding_model,
           embedding_runtime, dimensions, config, config_hash, seed, activated_at)
         values ('active', 'fixture-space', 'test', 'test-256', 'local', 256, '{}'::jsonb,
           'fixture', 1, now()) returning id`
      )
    ).rows[0]!.id;
    // The database refuses a topic written outside the engine: the fixture is the engine's writer.
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('memora.topic_writer', 'engine', true)");
      topicId = (
        await client.query<{ id: string }>(
          "insert into topics (tree_id, role) values ($1, 'root') returning id",
          [treeId]
        )
      ).rows[0]!.id;
      await client.query("commit");
    } finally {
      client.release();
    }
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

  /** A current note of a source (a chunk of its own as evidence); `placed` puts it in the tree. */
  const note = async (sourceId: string, options: { placed?: boolean; status?: string } = {}) => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    const noteId = randomUUID();
    await db().query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Document', 'text', $3)`,
      [documentId, sourceId, `hash-${documentId}`]
    );
    await db().query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Passage', $4)`,
      [chunkId, documentId, sourceId, `chunk-${chunkId}`]
    );
    await db().query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, ownership, status,
         created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key)
       values ($1::uuid, 'Note', 'Note', 'Note', 'source', $2, $3, $4, 'test', 'test', 'local', 'test',
         $1::uuid::text)`,
      [noteId, options.status ?? "active", sourceId, chunkId]
    );
    if (options.placed)
      await db().query(
        `insert into topic_placements (tree_id, item_kind, note_id, topic_id, role, rank, decided_by)
         values ($1, 'note', $2, $3, 'primary', 0, 'build')`,
        [treeId, noteId, topicId]
      );
    return noteId;
  };

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

  it("leaves a node to the import still working in its tree, and builds it once that ends", async () => {
    const spaceKey = newSpace();
    const book = await work("Importing book", undefined, "Book");
    const one = await work("Importing chapter one", book.id, "BookChapter");
    const two = await work("Importing chapter two", book.id, "BookChapter");
    await composite(one.id, unit(4), spaceKey);
    await composite(two.id, unit(5), spaceKey);
    // A resumed import: the chapter's run is still pending, and the book's own stages are to run
    // (with the summary the import writes), so the backfill would only embed a header it must redo.
    const runs = createIngestionRunRepository(db());
    const run = await runs.create({
      sourceItemId: two.id,
      requestedStages: ["embedding"],
      effectiveStages: ["embedding"],
      trigger: "interactive_import"
    });
    const calls: Array<{ text: string; sourceItemId: string }> = [];

    expect(await countCompositeBackfillWork(db(), spaceKey)).toBe(0);
    expect(await hasCompositeBackfillWork(db(), spaceKey)).toBe(false);
    const waiting = await backfill(spaceKey, embedder(spaceKey, calls));
    expect(waiting).toMatchObject({ examined: 1, written: [], incomplete: 1, current: 0 });
    expect(calls).toEqual([]);
    expect(await createSourceRelationRepository(db()).discoveryVector(book.id)).toBeNull();

    await runs.complete(run.id);
    expect(await countCompositeBackfillWork(db(), spaceKey)).toBe(1);
    expect(await backfill(spaceKey, embedder(spaceKey, calls))).toMatchObject({
      written: [book.id],
      incomplete: 0
    });
    expect(await createSourceRelationRepository(db()).discoveryVector(book.id)).not.toBeNull();
  });

  it("walks the nodes in pages that end at their limit and start after the last node done", async () => {
    const spaceKey = newSpace();
    const books: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const book = await work(`Paged pass book ${index}`, undefined, "Book");
      const chapter = await work(`Paged pass chapter ${index}`, book.id, "BookChapter");
      await composite(chapter.id, unit(4), spaceKey);
      books.push(book.id);
    }
    const calls: Array<{ text: string; sourceItemId: string }> = [];
    const embed = embedder(spaceKey, calls);

    // At most two composites per page: 2, 2 and 1.
    const written: string[] = [];
    const sizes: number[] = [];
    let after: Awaited<ReturnType<typeof backfill>>["next"] = null;
    do {
      const page = await backfill(spaceKey, embed, { after, limits: { nodes: 50, writes: 2 } });
      sizes.push(page.written.length);
      written.push(...page.written);
      after = page.next;
    } while (after);
    expect(sizes).toEqual([2, 2, 1]);
    expect(written.toSorted()).toEqual(books.toSorted());
    expect(new Set(written).size).toBe(5);

    // Nodes that are current cost no write, so their page ends at the number of nodes looked at.
    const looked: number[] = [];
    after = null;
    do {
      const page = await backfill(spaceKey, embed, { after, limits: { nodes: 2, writes: 2 } });
      looked.push(page.current);
      expect(page.written).toEqual([]);
      after = page.next;
    } while (after);
    expect(looked).toEqual([2, 2, 1]);
  });

  it("builds a book's composite as soon as its last chapter has one, before any summary exists", async () => {
    const spaceKey = newSpace();
    const book = await work("Early book", undefined, "Book");
    const one = await work("Early chapter one", book.id, "BookChapter");
    const two = await work("Early chapter two", book.id, "BookChapter");
    const calls: Array<{ text: string; sourceItemId: string }> = [];
    const refresh = (sourceItemId: string) =>
      refreshAncestorComposites({
        pool: db(),
        sourceItemId,
        embed: embedder(spaceKey, calls),
        aggregate: aggregateSourceEmbedding
      });

    // The first chapter leaves the book waiting for the second one.
    await composite(one.id, unit(4), spaceKey);
    expect(await refresh(one.id)).toEqual([]);
    expect(await createSourceRelationRepository(db()).discoveryVector(book.id)).toBeNull();
    // The last one builds it at once: the book's discovery runs when its last record has linked
    // and needs the vector then, whether or not the batch's summaries are written (no batch barrier).
    await composite(two.id, unit(5), spaceKey);
    expect(await refresh(two.id)).toEqual([book.id]);
    expect(await createSourceRelationRepository(db()).discoveryVector(book.id)).not.toBeNull();

    // A summary written afterwards deletes it (any update of the source does), and the header it
    // embedded is no longer the book's: the next build, the root's own stage, the backfill or the
    // catalog-header job (plan decision 27) that follows a late summary, makes it with the summary.
    await createSourceItemRepository(db()).update(book.id, { summary: "A late summary." });
    expect(await createSourceRelationRepository(db()).discoveryVector(book.id)).toBeNull();
    expect(
      await hierarchyRootComposite({
        pool: db(),
        sourceItemId: book.id,
        header: await headerOf(book.id),
        space: { model: "test-256", dimensions: 256, strategy: compositeStrategy(spaceKey) }
      })
    ).toBe("stale");
  });

  // --- the job -------------------------------------------------------------------------------------

  describe("the relation-composite job", () => {
    const hooks = () => ({
      notesChanged: vi.fn(async () => undefined),
      sourcesChanged: vi.fn<TopicChangeHooks["sourcesChanged"]>(async () => undefined),
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

    it("queues no second job beside the next page of a pass or a job waiting for its retry", async () => {
      const spaceKey = newSpace();
      const book = await work("Paging book", undefined, "Book");
      const chapter = await work("Paging chapter", book.id, "BookChapter");
      await composite(chapter.id, unit(4), spaceKey);
      // A job past its claim holds no dedupe key: this one stands for a pass between two pages.
      const between = await createJobRepository(db()).create({
        type: compositeBackfillJobType,
        lane: "light",
        priority: -1
      });

      expect(await enqueueCompositeBackfill(db(), spaceKey)).toBe(true);

      expect(await queuedBackfills()).toBe(1);
      await db().query("update jobs set status = 'canceled' where id = $1", [between.id]);
      expect(await enqueueCompositeBackfill(db(), spaceKey)).toBe(true);
      expect(await queuedBackfills()).toBe(1);
      await db().query(
        "update jobs set status = 'canceled' where type = $1 and status = 'queued'",
        [compositeBackfillJobType]
      );
    });

    it("gives its slot back between pages: the same job is queued again and the totals add up", async () => {
      const spaceKey = newSpace();
      const total = compositeBackfillPage.writes + 2;
      const books: string[] = [];
      for (let index = 0; index < total; index += 1) {
        const book = await work(`Paged job book ${index}`, undefined, "Book");
        const chapter = await work(`Paged job chapter ${index}`, book.id, "BookChapter");
        await composite(chapter.id, unit(4), spaceKey);
        books.push(book.id);
      }
      const topicHooks = hooks();
      const supervisor = supervisorFor(spaceKey, { topicHooks });
      const open = async () =>
        Number(
          (
            await db().query<{ n: number }>(
              "select count(*)::int as n from jobs where type = $1 and status in ('queued', 'running')",
              [compositeBackfillJobType]
            )
          ).rows[0]!.n
        );
      expect(await supervisor.ensureCompositeBackfill()).toBe(true);

      // The first page writes its share and the same job waits for the rest, behind the link jobs.
      const first = await supervisor.runLightOnce("relations");
      expect(first).toMatchObject({
        status: "queued",
        priority: -1,
        attempts: 0,
        result: { examined: total, written: compositeBackfillPage.writes, failed: 0 }
      });
      expect(first?.result).not.toHaveProperty("continueWith");
      expect(first?.payload).toMatchObject({ afterId: expect.any(String) });
      // The pass is open: a request neither queues a second job nor claims the library is done.
      expect(await supervisor.ensureCompositeBackfill()).toBe(true);
      expect(await open()).toBe(1);
      expect(await supervisor.compositeBackfillRemaining()).toBe(2);

      // A payload the supervisor added its own keys to (a failed attempt's history, the prompt
      // pin) still says where the pass is.
      await db().query(
        `update jobs set payload = payload || '{"errorHistory": [], "promptPin": null}'::jsonb where id = $1`,
        [first!.id]
      );

      const second = await supervisor.runLightOnce("relations");
      expect(second).toMatchObject({
        id: first!.id,
        status: "succeeded",
        result: { examined: total, written: total, rebuilt: 0, failed: 0, roots: total }
      });
      expect(second?.result).not.toHaveProperty("continueWith");
      expect((second?.result as { writtenIds: string[] }).writtenIds.toSorted()).toEqual(
        books.toSorted()
      );
      // Each page handed its own roots to PLACE.
      expect(topicHooks.sourcesChanged.mock.calls.map(([ids]) => ids.length)).toEqual([
        compositeBackfillPage.writes,
        2
      ]);
      expect(await supervisor.compositeBackfillRemaining()).toBe(0);
      expect(await supervisor.ensureCompositeBackfill()).toBe(false);
      expect(await open()).toBe(0);
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

    it("counts the roots with current placed notes among the ones it wrote: they keep their vector", async () => {
      const spaceKey = newSpace();
      const withNotes = await work("Noted book", undefined, "Book");
      const bare = await work("Bare book", undefined, "Book");
      const noteChapter = await work("Noted chapter", withNotes.id, "BookChapter");
      const bareChapter = await work("Bare chapter", bare.id, "BookChapter");
      await composite(noteChapter.id, unit(4), spaceKey);
      await composite(bareChapter.id, unit(5), spaceKey);
      await note(noteChapter.id, { placed: true });

      expect(await placementOf(db(), [withNotes.id, bare.id, noteChapter.id])).toEqual({
        roots: 2,
        withCurrentNotes: 1
      });
      expect(await placementOf(db(), [])).toEqual({ roots: 0, withCurrentNotes: 0 });
    });

    it("holds a root's vector only by current notes the tree has placed", async () => {
      const spaceKey = newSpace();
      const roots: Record<string, string> = {};
      for (const [name, options] of Object.entries({
        placed: { placed: true },
        // The topic tree places a new note later: until then the root may still move.
        waiting: {},
        // Archived and superseded notes are no source of a root's vector.
        archived: { placed: true, status: "archived" },
        superseded: { placed: true }
      })) {
        const book = await work(`Held ${name} book`, undefined, "Book");
        const chapter = await work(`Held ${name} chapter`, book.id, "BookChapter");
        await composite(chapter.id, unit(4), spaceKey);
        const noteId = await note(chapter.id, options);
        if (name === "superseded")
          await db().query(
            "update atomic_notes set supersession_status = 'superseded' where id = $1",
            [noteId]
          );
        roots[name] = book.id;
      }

      const read = await readBackfillRoots(db(), Object.values(roots));

      expect(Object.fromEntries(read.map((root) => [root.title, root.hasCurrentNotes]))).toEqual({
        "Held placed book": true,
        "Held waiting book": false,
        "Held archived book": false,
        "Held superseded book": false
      });
      expect(await placementOf(db(), Object.values(roots))).toEqual({
        roots: 4,
        withCurrentNotes: 1
      });
    });
  });

  // --- the re-match harness waits for it -----------------------------------------------------------

  describe("the first step of a re-match run", () => {
    /** A book with two chapters that have composites; with `notes`, a current placed note on a chapter. */
    async function library(spaceKey: string, title: string, notes: boolean) {
      const book = await work(title, undefined, "Book");
      const one = await work(`${title}, chapter one`, book.id, "BookChapter");
      const two = await work(`${title}, chapter two`, book.id, "BookChapter");
      await composite(one.id, unit(4), spaceKey);
      await composite(two.id, unit(5), spaceKey);
      if (notes) await note(one.id, { placed: true });
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

    it("reports what the last pass saw, not the sum of the app start's job and its own", async () => {
      const since = new Date();
      const spaceKey = newSpace();
      await library(spaceKey, "Passes bare book", false);
      await library(spaceKey, "Passes noted book", true);
      const supervisor = supervisorFor(spaceKey);
      // Drain mode holds the heavy lane until the job the app's start queued has ended, so it
      // finishes before the step runs; the step's first round is then a second, full pass.
      expect(await supervisor.ensureCompositeBackfill()).toBe(true);
      expect(await supervisor.runLightOnce("relations")).toMatchObject({ status: "succeeded" });

      const facts = await runCompositeBackfillStep(
        stepOf(supervisor, { runJobs: true, since }).deps,
        run
      );

      // Two jobs saw the same two nodes: the library has two, and the first job wrote both.
      expect(facts).toMatchObject({
        jobs: 2,
        examined: 2,
        written: 2,
        rebuilt: 0,
        current: 2,
        incomplete: 0,
        failed: 0,
        remaining: 0
      });
    });

    it("compares the placements with the ones read before the app's start queued the job", async () => {
      const since = new Date();
      const spaceKey = newSpace();
      const bare = await library(spaceKey, "Baseline book", false);
      const supervisor = supervisorFor(spaceKey);
      // The preparation of the run reads the placements before the job supervisor starts.
      const placementsBefore = await readRootPlacements(db());
      expect(placementsBefore.find((root) => root.rootId === bare.id)?.placement).toBeNull();
      // The app's start queues the job, it writes the composite, and PLACE places the root
      // before the step reads anything (a debounce shorter than the checks before the step).
      expect(await supervisor.ensureCompositeBackfill()).toBe(true);
      await supervisor.runLightOnce("relations");
      await db().query(
        `insert into topic_placements (tree_id, item_kind, source_item_id, topic_id, role, rank, decided_by)
         values ($1, 'source', $2, $3, 'primary', 0, 'fallback')`,
        [treeId, bare.id, topicId]
      );
      const { deps } = stepOf(supervisor, { runJobs: true, since });

      const facts = await runCompositeBackfillStep({ ...deps, placementsBefore }, run);
      const hidden = await runCompositeBackfillStep(deps, run);

      expect(facts.placements).toMatchObject({ backfilledRoots: 1, moved: 1 });
      expect(facts.placements.moves).toEqual([
        expect.objectContaining({
          rootId: bare.id,
          before: null,
          after: { topicId, needsVector: false }
        })
      ]);
      // The baseline read inside the step comes after the move: it is true by default.
      expect(hidden.placements).toMatchObject({ backfilledRoots: 1, moved: 0, moves: [] });
    });

    it("counts the jobs that ran in this app run, whenever they were queued", async () => {
      const spaceKey = newSpace();
      await library(spaceKey, "Earlier runs book", false);
      const jobs = createJobRepository(db());
      const ids: string[] = [];
      const finished = async (result: Record<string, unknown>, finishedAt: Date, days: number) => {
        const job = await jobs.create({ type: compositeBackfillJobType, lane: "light" });
        await db().query(
          "update jobs set created_at = now() - make_interval(days => $2) where id = $1",
          [job.id, days]
        );
        await jobs.update(job.id, { status: "succeeded", result, finishedAt });
        ids.push(job.id);
      };
      const since = new Date();
      // A job an earlier app run finished, and one queued by an earlier run (a quit before it ran,
      // a crash that requeued it) that this run's start merged into and ran: it keeps its old
      // creation time.
      await finished(
        { examined: 9, written: 4, current: 5 },
        new Date(since.getTime() - 3_600_000),
        2
      );
      await finished(
        { examined: 7, written: 3, rebuilt: 1, current: 3 },
        new Date(since.getTime() + 1),
        2
      );

      expect(await readCompositeJobFacts(db(), since)).toMatchObject({
        jobs: 1,
        examined: 7,
        written: 3,
        rebuilt: 1,
        current: 3
      });
      // They are no job of the tests that follow.
      await db().query("delete from jobs where id = any($1::uuid[])", [ids]);
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

  // --- a one-batch import of books: the composite is there when the book's discovery runs ---------

  describe("a one-batch import of books", () => {
    /** A book with chapters, as an import queues it: a run per chapter, one for the book. */
    interface Book {
      root: { id: string; title: string };
      chapters: Array<{ id: string; title: string }>;
      chapterJobs: string[];
      rootRun: string;
    }

    async function stageBook(
      batchId: string,
      title: string,
      volume: number,
      chapters: number,
      sources: Book[]
    ): Promise<{ rootJob: () => Promise<string> }> {
      const sourceRepository = createSourceItemRepository(db());
      const runs = createIngestionRunRepository(db());
      const jobs = createJobRepository(db());
      const root = await sourceRepository.create({ type: "Book", title });
      const book: Book = { root, chapters: [], chapterJobs: [], rootRun: "" };
      // A chapter's plan, as an import's: its notes are matched and its source is discovered, so
      // its run parks for the link job of the book, whose discovery waits for the last chapter.
      const contentStages = [
        "chunking",
        "summarization",
        "embedding",
        "atomicNoteMatching",
        "sourceMatching"
      ];
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
        book.chapterJobs.push(job.id);
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
      return { rootJob };
    }

    // In the first batch the last chapter of the only book passes the summarization barrier itself,
    // so the summary exists before the book's composite is built and its header is embedded once.
    // In the second, the first book's last chapter embeds before the second book's chapters are
    // summarized, so the batch's aggregate summaries are not written yet. Its composite is built
    // at once all the same: the book's discovery runs when its last record has linked and needs the
    // vector then, with no batch barrier (rules/knowledge.md). The summary the barrier writes
    // afterwards deletes it and the book's own job builds it again, with the summary, so that book's
    // header is embedded twice: the first time only so that its discovery has a vector. The book's
    // header chunk is built after the summary here, so plan decision 27's follow (the header built
    // before a late summary: catalog-header-refresh.sidecar.test.ts) has nothing to do and queues
    // nothing, as the assertions below check.
    it.each([
      { name: "a book of two chapters", chapters: [2], headerBuilds: [1] },
      {
        name: "a book of two chapters beside a book of one",
        chapters: [2, 1],
        headerBuilds: [2, 1]
      }
    ])(
      "has each book's composite when its discovery runs in a one-batch import of $name",
      async ({ chapters, headerBuilds }) => {
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
          const changedRootIds: string[] = [];
          for (const { root } of sources) {
            const current = await createSourceItemRepository(db()).findById(root.id);
            if (current?.summary) continue;
            await createSourceItemRepository(db()).update(root.id, {
              summary: `An aggregate summary of ${root.title}.`,
              summaryGeneratedAt: new Date()
            });
            changedRootIds.push(root.id);
          }
          return {
            generatedCount: changedRootIds.length,
            reusedCount: 0,
            blockedRoots: [],
            changedRootIds
          };
        });
        // Source discovery, as the link job runs it: what a book's discovery finds to plan with is
        // its composite (`matchSources` records `no_vector` without one, and a catalog run never
        // parks or queues a link job, so nothing would plan that book's discovery again).
        const discovered: Array<{ rootId: string; vectorSpace: string | null }> = [];
        const knowledgeService = {
          isHierarchicalRoot: async (id: string) =>
            sources.some((book) => book.root.id === id && book.chapters.length > 0),
          summarizeSource: async () => ({ configured: true, generated: true }),
          summarizeHierarchiesForBatch: summaries,
          typeRelationPairs: async () => ({ calls: 0, cacheHits: 0, untyped: {}, results: [] }),
          promoteSourceRelations: async () => ({}),
          discoverSourceRelations: async (input: { rootId: string }) => {
            const vector = await createSourceRelationRepository(db()).discoveryVector(input.rootId);
            discovered.push({ rootId: input.rootId, vectorSpace: vector?.spaceKey ?? null });
            return {};
          }
        };
        const supervisor = new JobSupervisor({
          getPool: () => db(),
          logger: quiet,
          generateEmbedding: generate,
          embeddingSpaceKey: async () => spaceKey,
          knowledgeService: knowledgeService as never
        });
        const lastChapterJobs = new Map(sources.map((book) => [book.chapterJobs.at(-1)!, book]));

        const jobs = chapters.reduce((total, count) => total + count, 0) + chapters.length;
        for (let ran = 0; ran < jobs; ran += 1) {
          const job = await supervisor.runOnce();
          expect(job?.status, `job ${ran + 1}: ${job?.error ?? ""}`).toBe("succeeded");
          // The book whose last chapter this was is ready for discovery as the job ends.
          const finished = lastChapterJobs.get(job!.id);
          if (finished)
            expect(
              await createSourceRelationRepository(db()).discoveryVector(finished.root.id),
              `${finished.root.title} when its last chapter is done`
            ).not.toBeNull();
          // The link job the chapter's run parked for runs on the relations worker at once.
          while ((await supervisor.runLightOnce("relations")) !== null) continue;
        }
        expect(await supervisor.runOnce()).toBeNull();
        expect(await supervisor.runLightOnce("relations")).toBeNull();

        // Each book was discovered once, with its composite in place.
        expect(discovered.map((entry) => entry.rootId).toSorted()).toEqual(
          sources.map((book) => book.root.id).toSorted()
        );
        expect(discovered.map((entry) => entry.vectorSpace)).toEqual(
          discovered.map(() => `256:${spaceKey}`)
        );
        // Every book's header chunk was built after its summary (its run came last): the summary
        // written at the barrier left no header to follow, and plan decision 27 queued nothing.
        const followed = await db().query("select 1 from jobs where type = 'catalog-header'");
        expect(followed.rows).toHaveLength(0);

        for (const [index, book] of sources.entries()) {
          const source = (await createSourceItemRepository(db()).findById(book.root.id))!;
          expect(source.summary).toContain("aggregate summary");
          const segments = chunkMarkdown(buildCatalogMetadataMarkdown(source)).map(
            (chunk) => chunk.content
          );
          // The header of the final text (with its summary) was embedded last, and as many times
          // as the book built its composite (see the comment above the cases).
          const embedded = headerCalls
            .filter((call) => call.text.includes(book.root.title))
            .map((call) => call.text);
          expect(embedded.length, book.root.title).toBe(segments.length * headerBuilds[index]!);
          expect(embedded.slice(-segments.length), book.root.title).toEqual(segments);
          // The header chunk of the book (chunk 0 of its catalog document) is that same header, so
          // the composite and the chunk are built from one text.
          const chunk = await db().query<{ content: string }>(
            "select content from chunks where source_item_id = $1 and chunk_index = 0",
            [book.root.id]
          );
          expect(chunk.rows.map((row) => row.content)).toEqual([
            buildCatalogMetadataMarkdown(source)
          ]);
          // The composite holds exactly the final header and the chapters' composites.
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
