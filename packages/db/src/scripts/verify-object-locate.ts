import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";

import {
  closePgPool,
  createChunkRepository,
  createDocumentRepository,
  createObjectLocateRepository,
  createPgPool,
  createSourceItemRepository,
  createTopicTreeRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "../index.js";
import {
  ObjectLocateResultSchema,
  objectLocateListLimit,
  objectLocatePathLimit,
  objectLocateTopicPathLimit
} from "@app/domain";

/**
 * Real-database check of `objects.locate` (the read-only locate repository, docs/f2-decisions.md
 * D24): the topic path in front of the source chain for notes and sources, secondary placements as
 * "also in", the tree root and unnamed topics, objects the tree does not hold, a retired tree, the
 * deepest topic path, notes citing a source, counts, caps, missing objects and parent cycles, on a
 * throwaway PostgreSQL sidecar migrated from scratch. The topic tree is written through
 * `topicTreeRepository` (D9). Latency at scale is measured by
 * `scripts/objects/locate-benchmark.ts`.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-object-locate-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_object_locate",
  user: "memora_object_locate",
  password: `object-locate-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

let pool: PgPool | null = null;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 3 });
  const db = pool;
  await runMigrations(db, resolve(packageRoot, "drizzle"));

  const sources = createSourceItemRepository(db);
  const documents = createDocumentRepository(db);
  const chunks = createChunkRepository(db);

  const source = async (
    type: "Book" | "BookChapter" | "DocumentSection" | "StandaloneArticle",
    title: string,
    parentSourceItemId?: string
  ) => sources.create({ type, title, ...(parentSourceItemId ? { parentSourceItemId } : {}) });
  const book = await source("Book", "The Book");
  const chapter = await source("BookChapter", "Chapter One", book.id);
  const section = await source("DocumentSection", "Section A", chapter.id);
  const article = await source("StandaloneArticle", "Unrelated article");

  async function addChunks(sourceItemId: string, count: number, superseded = false) {
    const content = Array.from(
      { length: count },
      (_, index) => `Passage ${index} of ${sourceItemId}.`
    ).join("\n\n");
    const document = await documents.create({
      sourceItemId,
      title: "Document",
      canonicalMarkdown: content,
      contentHash: randomUUID(),
      ...(superseded ? { metadata: { supersededByDocumentId: randomUUID() } } : {})
    });
    let offset = 0;
    const ids: string[] = [];
    await chunks.replaceDocumentChunks(
      document.id,
      sourceItemId,
      content.split("\n\n").map((text, index) => {
        const id = randomUUID();
        ids.push(id);
        const span = { id: randomUUID(), startOffset: offset, endOffset: offset + text.length };
        offset += text.length + 2;
        return {
          id,
          sourceSpanId: span.id,
          chunkIndex: index,
          content: text,
          contentHash: `${id}`,
          span
        };
      })
    );
    return { documentId: document.id, chunkIds: ids };
  }

  const current = await addChunks(section.id, 3);
  await addChunks(section.id, 2, true);
  const articleChunks = await addChunks(article.id, 2);

  async function addNote(input: {
    title: string;
    createdFrom: string;
    status?: string;
    supersession?: string;
    ownership?: "source" | "knowledge";
    owning?: string | null;
    chunk: string;
  }) {
    const id = randomUUID();
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
         ownership, owning_source_item_id, created_from_source_item_id, evidence_chunk_id,
         generation_provider, generation_model, generation_runtime, generation_prompt_version, generation_key)
       values ($1::uuid, $2, $2, $2, $3::atomic_note_status, $4, $5, $6, $7, $8, 'verify', 'verify', 'local', 'verify', $1::uuid::text)`,
      [
        id,
        input.title,
        input.status ?? "active",
        input.supersession ?? "current",
        input.ownership ?? "source",
        input.owning === undefined
          ? input.ownership === "knowledge"
            ? null
            : input.createdFrom
          : input.owning,
        input.createdFrom,
        input.chunk
      ]
    );
    return id;
  }
  const link = (noteId: string, sourceId: string, chunkId: string) =>
    db.query(
      "insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id) values ($1, $2, $3)",
      [noteId, sourceId, chunkId]
    );
  const [chunkA, chunkB, chunkC] = current.chunkIds as [string, string, string];

  const own = await addNote({ title: "Own note", createdFrom: section.id, chunk: chunkA });
  await link(own, section.id, chunkA);
  await link(own, section.id, chunkB);
  const rejected = await addNote({
    title: "Rejected",
    createdFrom: section.id,
    status: "rejected",
    chunk: chunkA
  });
  const citing = await addNote({
    title: "Citing note",
    createdFrom: article.id,
    ownership: "knowledge",
    chunk: articleChunks.chunkIds[0]!
  });
  await link(citing, section.id, chunkC);
  const retained = await addNote({
    title: "Retained attribution",
    createdFrom: article.id,
    ownership: "knowledge",
    chunk: articleChunks.chunkIds[0]!
  });
  await db.query(
    "insert into atomic_note_evidence (note_id, chunk_id, source_id, snapshot) values ($1, $2, $3, '{}'::jsonb)",
    [retained, chunkA, section.id]
  );
  const archived = await addNote({
    title: "Archived citing",
    createdFrom: article.id,
    ownership: "knowledge",
    status: "archived",
    chunk: articleChunks.chunkIds[0]!
  });
  await link(archived, section.id, chunkA);
  const superseded = await addNote({
    title: "Superseded citing",
    createdFrom: article.id,
    ownership: "knowledge",
    supersession: "superseded",
    chunk: articleChunks.chunkIds[0]!
  });
  await link(superseded, section.id, chunkA);
  // A knowledge-owned note survives the deletion of the source it was created from.
  const gone = await source("StandaloneArticle", "Deleted article");
  const goneChunks = await addChunks(gone.id, 1);
  const orphan = await addNote({
    title: "Orphan note",
    createdFrom: gone.id,
    ownership: "knowledge",
    chunk: goneChunks.chunkIds[0]!
  });
  await db.query("delete from source_items where id = $1", [gone.id]);

  const locate = createObjectLocateRepository(db);

  // Before any tree exists, every object has its source chain alone (no topic entries, no error).
  const untreed = await locate.locateNote(own);
  assert.deepEqual(
    untreed?.primaryPath.map((item) => [item.kind, item.title]),
    [
      ["source", "The Book"],
      ["source", "Chapter One"],
      ["source", "Section A"],
      ["note", "Own note"]
    ],
    "a library with no topic tree locates by its source chain"
  );
  assert.deepEqual(untreed?.alsoIn, []);

  // The topic tree, written through the engine's repository: a root, an Area, two named topics and
  // an unnamed one. The book is placed in "Spacing"; `own` in "Forgetting" with two secondary
  // placements; `citing` in "Spacing"; the article waits at the root; the rest is not placed.
  const trees = createTopicTreeRepository(db);
  const treeInput = (id: string, rootId: string) => ({
    id,
    rootId,
    spaceKey: "verify:locate:256",
    embeddingProvider: "verify",
    embeddingModel: "verify",
    embeddingRuntime: "none",
    dimensions: 256 as const,
    config: {},
    configHash: "verify",
    seed: 1
  });
  const rootId = randomUUID();
  const area = randomUUID();
  const forgetting = randomUUID();
  const spacing = randomUUID();
  const unnamed = randomUUID();
  const named = (title: string, position: number) =>
    ({
      role: "topic",
      title,
      nameState: "named",
      nameSource: "llm",
      nameLanguage: "en",
      position
    }) as const;
  const tree = await trees.createTree(treeInput(randomUUID(), rootId));
  const built = await trees.bootstrapSnapshot({
    treeId: tree.id,
    expectedGeneration: tree.generation,
    titleKey: "topics.changeSets.build",
    topics: [
      topicRecord(area, rootId, named("Memory", 0)),
      topicRecord(forgetting, area, named("Forgetting", 0)),
      topicRecord(spacing, area, named("Spacing", 1)),
      topicRecord(unnamed, area, { role: "topic", position: 2 })
    ],
    placements: [
      { item: itemKey("note", own), placement: placementRecord(forgetting) },
      { item: itemKey("note", own), placement: placementRecord(spacing, { rank: 1 }) },
      { item: itemKey("note", own), placement: placementRecord(unnamed, { rank: 2 }) },
      { item: itemKey("note", citing), placement: placementRecord(spacing) },
      { item: itemKey("source", book.id), placement: placementRecord(spacing) },
      { item: itemKey("source", article.id), placement: placementRecord(rootId) }
    ]
  });
  assert.equal(built.kind, "applied", "the verification tree is written");
  const topicRef = (id: string, title: string) => ({ kind: "topic", id, title });

  // A source: the topics of its root source, then its chain, with citations and counts.
  const located = await locate.locateSource(section.id);
  assert.ok(located);
  ObjectLocateResultSchema.parse(located);
  assert.deepEqual(located.object, { kind: "source", id: section.id, title: "Section A" });
  assert.deepEqual(
    located.primaryPath.map((item) => [item.kind, item.title]),
    [
      ["topic", ""],
      ["topic", "Memory"],
      ["topic", "Spacing"],
      ["source", "The Book"],
      ["source", "Chapter One"],
      ["source", "Section A"]
    ],
    "the root, Memory, Spacing (where the book sits), then root source > chapter > section"
  );
  assert.deepEqual(
    located.primaryPath.slice(0, 3).map((item) => item.id),
    [rootId, area, spacing],
    "the path names the topics by identity, root first"
  );
  assert.deepEqual(located.alsoIn, [], "a root source has no secondary placement");
  assert.deepEqual(
    located.citedBy.map((item) => [item.kind, item.title]),
    [
      ["note", "Citing note"],
      ["note", "Retained attribution"]
    ],
    "cross-source notes; archived and superseded notes are left out"
  );
  assert.deepEqual(
    located.counts,
    { alsoIn: 0, citedBy: 2, notes: 5, passages: 3, children: 0 },
    "notes match the source's Notes tab (rejected excluded); passages count current chunks only"
  );
  const bookResult = await locate.locateSource(book.id);
  assert.deepEqual(
    bookResult?.primaryPath.map((item) => item.title),
    ["", "Memory", "Spacing", "The Book"]
  );
  assert.deepEqual(
    [bookResult?.counts.children, bookResult?.counts.passages, bookResult?.counts.notes],
    [1, 0, 0]
  );
  assert.equal((await locate.locateSource(chapter.id))?.counts.children, 1);

  // A note: its own topics, the owning source chain, then the note itself.
  const ownNote = await locate.locateNote(own);
  assert.ok(ownNote);
  ObjectLocateResultSchema.parse(ownNote);
  assert.deepEqual(
    ownNote.primaryPath.map((item) => [item.kind, item.title]),
    [
      ["topic", ""],
      ["topic", "Memory"],
      ["topic", "Forgetting"],
      ["source", "The Book"],
      ["source", "Chapter One"],
      ["source", "Section A"],
      ["note", "Own note"]
    ],
    "a note takes its own primary topic, not its book's"
  );
  assert.deepEqual(ownNote.object, { kind: "note", id: own, title: "Own note" });
  assert.deepEqual(
    ownNote.alsoIn,
    [topicRef(spacing, "Spacing"), topicRef(unnamed, "")],
    "secondary placements in rank order; an unnamed topic has an empty title"
  );
  assert.deepEqual(ownNote.citedBy, [], "no overview cites a note before the overview tables");
  assert.deepEqual(ownNote.counts, { alsoIn: 2, citedBy: 0, notes: 0, passages: 2, children: 0 });
  const knowledgeNote = await locate.locateNote(citing);
  assert.deepEqual(
    knowledgeNote?.primaryPath.map((item) => item.title),
    ["", "Memory", "Spacing", "Unrelated article", "Citing note"],
    "a knowledge-owned note hangs from the source it was created from"
  );
  assert.deepEqual(
    (await locate.locateSource(article.id))?.primaryPath.map((item) => [item.kind, item.title]),
    [
      ["topic", ""],
      ["source", "Unrelated article"]
    ],
    "an item waiting at the root has the root as its topic path"
  );
  assert.deepEqual(
    (await locate.locateNote(orphan))?.primaryPath.map((item) => item.title),
    ["Orphan note"],
    "a note the tree does not hold, whose source is gone, still locates"
  );
  assert.deepEqual(
    (await locate.locateNote(rejected))?.primaryPath.map((item) => item.kind),
    ["source", "source", "source", "note"],
    "a rejected note has no placement and keeps its source chain"
  );
  assert.equal((await locate.locateNote(rejected))?.object.title, "Rejected");

  // Missing objects and a kind mix-up locate nothing.
  assert.equal(await locate.locateSource(randomUUID()), null);
  assert.equal(await locate.locateNote(randomUUID()), null);
  assert.equal(await locate.locateNote(section.id), null);
  assert.equal(await locate.locateSource(own), null);

  // The lists are capped; the counts are not. Citations are the notes that derive from a source.
  const crowded = await source("StandaloneArticle", "Crowded article");
  const crowdedChunks = await addChunks(crowded.id, 1);
  for (let index = 0; index < objectLocateListLimit + 5; index += 1) {
    const note = await addNote({
      title: `Citation ${String(index).padStart(2, "0")}`,
      createdFrom: article.id,
      ownership: "knowledge",
      chunk: articleChunks.chunkIds[0]!
    });
    await link(note, crowded.id, crowdedChunks.chunkIds[0]!);
  }
  const crowdedResult = await locate.locateSource(crowded.id);
  assert.equal(crowdedResult?.citedBy.length, objectLocateListLimit);
  assert.equal(crowdedResult?.counts.citedBy, objectLocateListLimit + 5);
  assert.equal(crowdedResult?.citedBy[0]?.title, "Citation 00", "lists are ordered by title");
  ObjectLocateResultSchema.parse(crowdedResult);

  // The deepest tree the engine allows (the root and seven levels) fits the contract with the
  // deepest source chain: the topic path and the source chain are bounded separately.
  const deepTopics = Array.from({ length: objectLocateTopicPathLimit - 1 }, () => randomUUID());
  const deepNote = await addNote({
    title: "Deep note",
    createdFrom: section.id,
    chunk: chunkA
  });
  const deepRoot = randomUUID();
  const client = await db.connect();
  try {
    await client.query("begin");
    const replacement = await trees.replaceActiveTree(client, treeInput(randomUUID(), deepRoot));
    const deepBuilt = await trees.bootstrapSnapshot(
      {
        treeId: replacement.id,
        expectedGeneration: replacement.generation,
        titleKey: "topics.changeSets.build",
        topics: deepTopics.map((id, level) =>
          topicRecord(
            id,
            level === 0 ? deepRoot : deepTopics[level - 1]!,
            named(`Level ${level + 1}`, 0)
          )
        ),
        placements: [
          { item: itemKey("note", deepNote), placement: placementRecord(deepTopics.at(-1)!) }
        ]
      },
      { client }
    );
    assert.equal(deepBuilt.kind, "applied", "the deep tree is written");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const deepResult = await locate.locateNote(deepNote);
  assert.ok(deepResult);
  ObjectLocateResultSchema.parse(deepResult);
  assert.deepEqual(
    deepResult.primaryPath.slice(0, objectLocateTopicPathLimit).map((item) => item.title),
    ["", ...deepTopics.map((_, level) => `Level ${level + 1}`)],
    "the root and seven levels"
  );
  assert.equal(
    deepResult.primaryPath.length,
    objectLocateTopicPathLimit + 4,
    "eight topics, three sources and the note"
  );

  // The first tree is retired: its placements stay in the table but no longer place anything.
  assert.equal(
    (await db.query("select 1 from topic_placements where note_id = $1", [own])).rowCount,
    3,
    "the retired tree keeps its rows"
  );
  const afterReplace = await locate.locateNote(own);
  assert.deepEqual(
    afterReplace?.primaryPath.map((item) => item.kind),
    ["source", "source", "source", "note"],
    "a retired tree places nothing"
  );
  assert.deepEqual(afterReplace?.alsoIn, []);
  assert.equal(afterReplace?.counts.alsoIn, 0);

  // A parent cycle in the sources (never written by the application) still terminates.
  await db.query("update source_items set parent_source_item_id = $2 where id = $1", [
    book.id,
    section.id
  ]);
  const cyclic = await locate.locateSource(section.id);
  assert.ok(
    cyclic && cyclic.primaryPath.length <= objectLocatePathLimit,
    "the source walk is bounded"
  );
  // A note takes one slot of the path itself, so even on the deepest chain it fits the contract.
  const cyclicNote = await locate.locateNote(own);
  assert.equal(
    cyclicNote?.primaryPath.length,
    objectLocatePathLimit,
    "the note's walk stops one ancestor earlier"
  );
  ObjectLocateResultSchema.parse(cyclicNote);
  await db.query("update source_items set parent_source_item_id = null where id = $1", [book.id]);

  // Both statements are valid for EXPLAIN (the plans are compared at scale by the benchmark).
  for (const statement of [locate.statements.source, locate.statements.note])
    await db.query(`explain ${statement}`, [section.id, objectLocateListLimit, 31]);

  console.info(
    JSON.stringify({
      verified: [
        "no tree: the source chain alone; with a tree: root > topics > root source > chapter > section, and for a note its own topics in front of its source's chain",
        "secondary placements are 'also in' in rank order; the tree root and an unnamed topic come back with empty titles; items at the root and items the tree does not hold locate",
        "citations: cross-source notes; archived, superseded and rejected notes and superseded document chunks are excluded; lists capped with full counts",
        "the deepest topic path (root and seven levels) fits the contract; a retired tree places nothing",
        "missing objects and kind mix-ups return null; parent cycles terminate",
        "both statements EXPLAIN on the migrated schema"
      ]
    })
  );
} finally {
  if (pool) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
