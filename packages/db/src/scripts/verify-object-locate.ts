import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createChunkRepository,
  createDocumentRepository,
  createObjectLocateRepository,
  createPgPool,
  createSourceItemRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "../index.js";
import { ObjectLocateResultSchema, objectLocateListLimit } from "@app/domain";

/**
 * Real-database check of `objects.locate` (the read-only locate repository): the primary path of
 * sources and notes, the legacy wiki placements and citations, cross-source notes, counts, caps and
 * missing objects, on a throwaway PostgreSQL sidecar migrated from scratch. Latency at scale is
 * measured by `scripts/objects/locate-benchmark.ts`.
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

  // Legacy wiki pages: membership (alsoIn) and current-revision dependencies or evidence (citedBy).
  async function addPage(
    title: string,
    kind: "topic" | "entity" | "synthesis" | "collection",
    archived = false
  ) {
    const id = randomUUID();
    const revisionId = randomUUID();
    await db.query("insert into wiki_pages (id, title, kind, archived) values ($1, $2, $3, $4)", [
      id,
      title,
      kind,
      archived
    ]);
    await db.query(
      "insert into wiki_page_revisions (id, page_id, number, origin, content, content_hash) values ($1, $2, 1, 'verify', '{}'::jsonb, $3)",
      [revisionId, id, revisionId]
    );
    await db.query("update wiki_pages set current_revision_id = $2 where id = $1", [
      id,
      revisionId
    ]);
    return { id, revisionId };
  }
  async function member(
    page: { id: string; revisionId: string },
    targetKind: string,
    targetId: string
  ) {
    const groupId = randomUUID();
    await db.query(
      "insert into wiki_toc_groups (id, page_id, revision_id, snapshot) values ($1, $2, $3, '{}'::jsonb)",
      [groupId, page.id, page.revisionId]
    );
    await db.query(
      "insert into wiki_memberships (id, page_id, group_id, target_kind, target_id, position, snapshot) values ($1, $2, $3, $4, $5, 0, '{}'::jsonb)",
      [randomUUID(), page.id, groupId, targetKind, targetId]
    );
  }
  const depend = (revisionId: string, kind: string, inputId: string) =>
    db.query(
      "insert into wiki_dependencies (revision_id, section_id, kind, input_id, fingerprint, snapshot) values ($1, $2, $3, $4, 'f', '{}'::jsonb)",
      [revisionId, randomUUID(), kind, inputId]
    );
  const evidence = (pageId: string, sourceId: string, documentId: string, chunkId: string) =>
    db.query(
      "insert into wiki_evidence (page_id, source_item_id, document_id, chunk_id, snapshot) values ($1, $2, $3, $4, '{}'::jsonb)",
      [pageId, sourceId, documentId, chunkId]
    );

  const topic = await addPage("Topic page", "topic");
  await member(topic, "source", section.id);
  await depend(topic.revisionId, "source", section.id);
  const entityPage = await addPage("Entity page", "entity");
  await evidence(entityPage.id, section.id, current.documentId, chunkA);
  await evidence(entityPage.id, section.id, current.documentId, chunkB);
  const answer = await addPage("Saved answer", "synthesis");
  await evidence(answer.id, section.id, current.documentId, chunkC);
  const archivedPage = await addPage("Archived page", "topic", true);
  await member(archivedPage, "source", section.id);
  await evidence(archivedPage.id, section.id, current.documentId, chunkA);
  const stale = await addPage("Older revision dependency", "topic");
  const olderRevision = randomUUID();
  await db.query(
    "insert into wiki_page_revisions (id, page_id, number, origin, content, content_hash) values ($1, $2, 0, 'verify', '{}'::jsonb, 'old')",
    [olderRevision, stale.id]
  );
  await depend(olderRevision, "source", section.id);
  const noteMember = await addPage("Collection of notes", "collection");
  await member(noteMember, "atomic_note", own);
  const noteCiting = await addPage("Page using the note", "topic");
  await depend(noteCiting.revisionId, "atomic_note", own);

  const locate = createObjectLocateRepository(db);

  // A source: its chain from the root, legacy placements, citations and counts.
  const located = await locate.locateSource(section.id);
  assert.ok(located);
  ObjectLocateResultSchema.parse(located);
  assert.deepEqual(located.object, { kind: "source", id: section.id, title: "Section A" });
  assert.deepEqual(
    located.primaryPath.map((item) => [item.kind, item.title]),
    [
      ["source", "The Book"],
      ["source", "Chapter One"],
      ["source", "Section A"]
    ],
    "root source > chapter > section"
  );
  assert.deepEqual(
    located.alsoIn.map((item) => [item.kind, item.title, item.legacy]),
    [["topic", "Topic page", true]],
    "an archived page and a page that merely cites the source are not placements"
  );
  assert.deepEqual(
    located.citedBy.map((item) => [item.kind, item.title, item.legacy]),
    [
      ["note", "Citing note", false],
      ["note", "Retained attribution", false],
      ["entity", "Entity page", true],
      ["question", "Saved answer", true],
      ["topic", "Topic page", true]
    ],
    "cross-source notes first, then current legacy pages by kind; archived, superseded and old-revision citations are left out"
  );
  assert.deepEqual(
    located.counts,
    { alsoIn: 1, citedBy: 5, notes: 5, passages: 3, children: 0 },
    "notes match the source's Notes tab (rejected excluded); passages count current chunks only"
  );
  const bookResult = await locate.locateSource(book.id);
  assert.deepEqual(
    bookResult?.primaryPath.map((item) => item.title),
    ["The Book"]
  );
  assert.deepEqual(
    [bookResult?.counts.children, bookResult?.counts.passages, bookResult?.counts.notes],
    [1, 0, 0]
  );
  assert.equal((await locate.locateSource(chapter.id))?.counts.children, 1);

  // A note: owning source chain, then the note itself.
  const ownNote = await locate.locateNote(own);
  assert.ok(ownNote);
  ObjectLocateResultSchema.parse(ownNote);
  assert.deepEqual(
    ownNote.primaryPath.map((item) => [item.kind, item.title]),
    [
      ["source", "The Book"],
      ["source", "Chapter One"],
      ["source", "Section A"],
      ["note", "Own note"]
    ]
  );
  assert.deepEqual(ownNote.object, { kind: "note", id: own, title: "Own note" });
  assert.deepEqual(
    ownNote.alsoIn.map((item) => [item.kind, item.title, item.legacy]),
    [["topic", "Collection of notes", true]]
  );
  assert.deepEqual(
    ownNote.citedBy.map((item) => item.title),
    ["Page using the note"]
  );
  assert.deepEqual(ownNote.counts, { alsoIn: 1, citedBy: 1, notes: 0, passages: 2, children: 0 });
  const knowledgeNote = await locate.locateNote(citing);
  assert.deepEqual(
    knowledgeNote?.primaryPath.map((item) => item.title),
    ["Unrelated article", "Citing note"],
    "a knowledge-owned note hangs from the source it was created from"
  );
  assert.deepEqual(
    (await locate.locateNote(orphan))?.primaryPath.map((item) => item.title),
    ["Orphan note"],
    "a note whose source is gone still locates"
  );
  assert.equal((await locate.locateNote(rejected))?.object.title, "Rejected");

  // Missing objects and a kind mix-up locate nothing.
  assert.equal(await locate.locateSource(randomUUID()), null);
  assert.equal(await locate.locateNote(randomUUID()), null);
  assert.equal(await locate.locateNote(section.id), null);
  assert.equal(await locate.locateSource(own), null);

  // The lists are capped; the counts are not.
  const crowded = await source("StandaloneArticle", "Crowded article");
  for (let index = 0; index < objectLocateListLimit + 5; index += 1)
    await member(
      await addPage(`Page ${String(index).padStart(2, "0")}`, "topic"),
      "source",
      crowded.id
    );
  const crowdedResult = await locate.locateSource(crowded.id);
  assert.equal(crowdedResult?.alsoIn.length, objectLocateListLimit);
  assert.equal(crowdedResult?.counts.alsoIn, objectLocateListLimit + 5);
  assert.equal(crowdedResult?.alsoIn[0]?.title, "Page 00", "lists are ordered by title");

  // A parent cycle (never written by the application) still terminates.
  await db.query("update source_items set parent_source_item_id = $2 where id = $1", [
    book.id,
    section.id
  ]);
  const cyclic = await locate.locateSource(section.id);
  assert.ok(cyclic && cyclic.primaryPath.length <= 32, "the path walk is bounded");
  await db.query("update source_items set parent_source_item_id = null where id = $1", [book.id]);

  // Both statements are valid for EXPLAIN (the plans are compared at scale by the benchmark).
  for (const statement of [locate.statements.source, locate.statements.note])
    await db.query(`explain ${statement}`, [section.id, objectLocateListLimit, 31]);

  console.info(
    JSON.stringify({
      verified: [
        "source: primary path root > chapter > section, legacy placements, citations (cross-source notes, entity, question and topic pages), counts",
        "archived pages, superseded or archived notes, non-current page revisions and superseded document chunks are excluded",
        "note: owning source chain plus the note; knowledge-owned and orphaned notes locate; rejected notes still locate",
        "missing objects and kind mix-ups return null; lists are capped with full counts; parent cycles terminate",
        "both statements EXPLAIN on the migrated schema"
      ]
    })
  );
} finally {
  if (pool) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
