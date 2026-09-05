import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HierarchicalIngestionService } from "../apps/desktop/src/main/services/hierarchical-ingestion-service.js";
import {
  createPgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations,
  createSourceItemRepository, createDocumentRepository, createChunkRepository,
  createAtomicNoteRepository, createSourceEditingRepository, createLibraryRepository,
  createHierarchicalIngestionRepository, createIngestionRunRepository, createSearchRepository,
  createBibliographicRepository
} from "../packages/db/src/index.js";

const workDir = await mkdtemp(join(tmpdir(), "memora-source-workspace-"));
const manager = new PostgresSidecarManager({
  binDir: resolvePostgresSidecarPaths({ cwd: process.cwd(), env: process.env }).binDir,
  dataDir: join(workDir, "data"), database: "source_workspace", user: "source_workspace",
  password: randomUUID(), startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000
});
let pool: ReturnType<typeof createPgPool> | undefined;
try {
  pool = createPgPool({ connectionString: (await manager.start()).connectionString, max: 3 });
  await runMigrations(pool, resolve("packages/db/drizzle"), { seedFolder: resolve("packages/db/seed") });
  const sources = createSourceItemRepository(pool), documents = createDocumentRepository(pool);
  const root = await sources.create({ type: "Book", title: "Editorial test book" });
  const bibliography = createBibliographicRepository(pool);
  const work = await bibliography.createWork({ type: "book", title: root.title, creators: [] });
  const instanceId = await bibliography.createInstance({ workId: work.id, type: "book_edition" });
  await bibliography.linkSource({ sourceItemId: root.id, workId: work.id, instanceId });
  for (let i = 0; i < 125; i++) await sources.create({ type: "BookChapter", title: `Chapter ${String(i).padStart(3, "0")}`,
    parentSourceItemId: root.id, metadata: { descriptor: { creators: [{ name: "José Verification", role: "author" }], isbn13: "9780000000002" } } });
  const library = createLibraryRepository(pool);
  const page = await library.listSources({ query: "Jose Verification", limit: 48 });
  assert.equal(page.length, 48);
  const next = await library.listSources({ query: "Jose Verification", limit: 48, offset: 48 });
  assert.equal(next.length, 48);
  assert.equal(new Set([...page, ...next].map((item) => item.id)).size, 96);
  assert.equal((await library.listSources({ parentId: null })).length, 1);
  assert.equal((await library.listSources({ query: "9780000000002", offset: 120 })).length, 5);
  const source = await sources.findById(page[0]!.id);
  assert(source);
  await bibliography.linkSource({ sourceItemId: source.id, workId: work.id, instanceId, relationType: "chapter_of" });
  const document = await documents.create({ sourceItemId: source.id, title: source.title, canonicalMarkdown: "Original evidence", contentHash: "a".repeat(64) });
  const chunkId = randomUUID(), spanId = randomUUID();
  await createChunkRepository(pool).replaceDocumentChunks(document.id, source.id, [{ id: chunkId, sourceSpanId: spanId,
    chunkIndex: 0, content: "Original evidence", contentHash: "a".repeat(64),
    span: { id: spanId, startOffset: 0, endOffset: 17 } }]);
  const note = await createAtomicNoteRepository(pool).upsertGenerated({ title: "Reviewed evidence", bodyMarkdown: "Reviewed body",
    ideaStatement: "Preserve this", sourceItemId: source.id, evidenceChunkId: chunkId, sourceSpanId: spanId,
    evidenceLinks: [{ chunkId, sourceSpanId: spanId }], generationProvider: "test", generationModel: "test",
    generationRuntime: "test", generationPromptVersion: "test", generationKey: randomUUID() });
  await pool.query("update atomic_notes set status = 'approved' where id = $1", [note.id]);
  const editing = createSourceEditingRepository(pool);
  const input = { sourceItemId: source.id, expectedUpdatedAt: source.updatedAt.toISOString(), title: "Edited chapter",
    subtitle: null, sourceUri: null, language: "en", descriptor: { type: "BookChapter", title: "Edited chapter", creators: [], parentSourceItemId: root.id } };
  const edited = await editing.save({ ...input, content: { documentId: document.id, markdown: "Revised content", hash: "b".repeat(64) } });
  assert(edited.contentChanged && edited.documentId !== document.id);
  assert.equal((await documents.findById(document.id))?.canonicalMarkdown, "Original evidence");
  assert.equal((await documents.listBySourceItem(source.id)).length, 1);
  assert.equal((await documents.listBySourceItem(source.id))[0]?.id, edited.documentId);
  assert.equal((await pool.query("select status from atomic_notes where id = $1", [note.id])).rows[0]?.status, "approved");
  assert.equal((await createChunkRepository(pool).listByDocument(document.id))[0]?.id, chunkId);
  assert.equal((await createSearchRepository(pool).searchText({ text: "Original evidence" })).length, 0);
  const artifacts = await createHierarchicalIngestionRepository(pool).getArtifactState(source.id, edited.documentId!);
  assert.equal(artifacts.atomicNotes, false);
  assert.equal(artifacts.chunking, false);
  assert.equal((await sources.findById(root.id))?.metadata.summaryStale, true);
  assert.equal((await pool.query("select title from bibliographic_works where id = $1", [work.id])).rows[0]?.title, root.title);
  assert.equal((await documents.listHistory(source.id)).length, 2);
  const metadataEdit = await editing.save({ sourceItemId: root.id,
    expectedUpdatedAt: (await sources.findById(root.id))!.updatedAt.toISOString(), title: "Revised catalog title",
    subtitle: null, sourceUri: null, language: "en", descriptor: { type: "Book", title: "Revised catalog title",
      creators: [{ name: "Catalog Author", role: "author" }], isbn13: "9780000000002", publisher: "Test publisher" } });
  assert.equal(metadataEdit.contentChanged, false);
  assert.equal((await documents.listBySourceItem(root.id)).length, 0);
  const edition = (await pool.query("select isbn, publisher from bibliographic_instances where id = $1", [instanceId])).rows[0];
  assert.equal(edition?.isbn, "9780000000002");
  assert.equal(edition?.publisher, "Test publisher");
  await assert.rejects(editing.save(input), /sourceWorkspace.conflict/);
  const current = (await sources.findById(source.id))!;
  const unchanged = await editing.save({ ...input, expectedUpdatedAt: current.updatedAt.toISOString(),
    content: { documentId: edited.documentId, markdown: "Revised content", hash: "b".repeat(64) } });
  assert.equal(unchanged.contentChanged, false);
  const previousRun = await createIngestionRunRepository(pool).create({ sourceItemId: source.id, status: "failed" });
  const hierarchyService = new HierarchicalIngestionService({ getPool: () => pool ?? null });
  const batch = await hierarchyService.process({ runKind: "reingestion", plan: {
    preset: "summary", requestedStages: [], targetSourceItemIds: [source.id], scope: "selected_items",
    forceRegeneration: true, previousArtifactPolicy: "preserve_reviewed_archive_pending"
  } });
  assert.deepEqual(batch.queued.map((item) => item.sourceItemId), [source.id]);
  const selectedRun = await createIngestionRunRepository(pool).findById(batch.queued[0]!.ingestionRunId);
  assert.equal(selectedRun?.supersedesRunId, previousRun.id);
  assert.equal(selectedRun?.effectiveStages.includes("atomicNotes"), false);
  assert.equal((await pool.query("select status from atomic_notes where id = $1", [note.id])).rows[0]?.status, "approved");
  const run = await createIngestionRunRepository(pool).create({ sourceItemId: source.id });
  await assert.rejects(editing.save({ ...input, expectedUpdatedAt: (await sources.findById(source.id))!.updatedAt.toISOString() }), /sourceWorkspace.processing/);
  assert(run.id);
  console.log("Verified: paginated catalog, accent/identifier search, immutable content, reviewed evidence, revision invalidation, optimistic concurrency, active-run protection.");
} finally {
  await pool?.end(); await manager.stop(); await rm(workDir, { recursive: true, force: true });
}
