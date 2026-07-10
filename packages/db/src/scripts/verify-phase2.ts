import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAiConfigRepository,
  createBibliographicRepository,
  createChunkRepository,
  createDocumentRepository,
  createEmbeddingRepository,
  createJobRepository,
  createIngestionRunRepository,
  createPgPool,
  createSearchRepository,
  createSourceItemRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-phase2-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_phase2",
  user: "memora_phase2",
  password: `phase2-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

let pool;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 3 });
  const migrationsFolder = resolve(packageRoot, "drizzle");
  const seedFolder = resolve(packageRoot, "seed");
  const firstRun = await runMigrations(pool, migrationsFolder, { seedFolder });
  if (!firstRun.seed.applied || firstRun.seed.seededMigrations.length !== 3) {
    throw new Error("Empty database did not apply the complete phase 2 baseline.");
  }

  await pool.query("insert into settings (key, value) values ('phase2.marker', 'true'::jsonb)");
  const secondRun = await runMigrations(pool, migrationsFolder, { seedFolder });
  if (secondRun.seed.applied) throw new Error("Existing database reapplied the baseline.");

  const history = await pool.query<{ count: string }>("select count(*)::text as count from drizzle.__drizzle_migrations");
  if (Number(history.rows[0]?.count) !== 3) throw new Error("Unexpected Drizzle migration history.");
  const extensions = await pool.query<{ extname: string }>(
    "select extname from pg_extension where extname in ('vector', 'unaccent', 'pg_trgm') order by extname"
  );
  if (extensions.rows.length !== 3) throw new Error("Phase 2 extensions are missing.");

  const columns = await pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
     where table_name = 'source_spans' and column_name in ('source_block_id', 'bounding_box', 'selector', 'page')`
  );
  if (columns.rows.length !== 4) throw new Error("SourceSpan provenance columns are missing.");
  const indexes = await pool.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'public'
     and indexname in ('embeddings_256_embedding_hnsw_idx', 'embeddings_768_embedding_hnsw_idx',
                       'chunks_content_trgm_idx', 'chunks_content_fts_idx')`
  );
  if (indexes.rows.length !== 4) throw new Error("Phase 2 search indexes are missing.");

  const sources = createSourceItemRepository(pool);
  const documents = createDocumentRepository(pool);
  const source = await sources.create({
    type: "PersonalNote", title: "Memória permanente", sourceOrigin: "manual",
    contentHash: "a".repeat(64), language: "pt-BR"
  });
  if ((await sources.lookup("Memoria", 5))[0]?.id !== source.id) {
    throw new Error("Accent-insensitive source lookup failed.");
  }
  const book = await sources.create({ type: "Book", title: "Parent book" });
  const chapter = await sources.create({
    type: "BookChapter", title: "Linked chapter", parentSourceItemId: book.id
  });
  if ((await sources.findById(chapter.id))?.parentSourceItemId !== book.id) {
    throw new Error("Book chapter parent linkage was not persisted.");
  }
  const document = await documents.create({
    sourceItemId: source.id, title: source.title,
    canonicalMarkdown: "# Memória\n\nUma memória eterna e pesquisável.\n",
    contentHash: "b".repeat(64), language: "pt-BR"
  });
  const chunks = createChunkRepository(pool);
  const chunkId = randomUUID();
  const spanId = randomUUID();
  const chunkInput = [{
    id: chunkId, sourceSpanId: spanId, chunkIndex: 0,
    content: "Uma memória eterna e pesquisável.", tokenCount: 8,
    contentHash: "c".repeat(64), language: "pt-BR",
    span: { id: spanId, startOffset: 11, endOffset: 45, page: 1, sourceBlockId: "block-1", selector: "/blocks/1" }
  }];
  await chunks.replaceDocumentChunks(document.id, source.id, chunkInput);
  await chunks.replaceDocumentChunks(document.id, source.id, chunkInput);
  if ((await chunks.listByDocument(document.id)).length !== 1) throw new Error("Chunk replacement is not idempotent.");

  const vector = Array.from({ length: 256 }, (_, index) => index === 0 ? 1 : 0);
  await createEmbeddingRepository(pool).upsert({
    targetType: "chunk", targetId: chunkId, chunkId, provider: "test", model: "test-256",
    runtime: "local", contentHash: "c".repeat(64), embedding: vector
  });
  const matches = await createEmbeddingRepository(pool).search(vector, 5, "test-256");
  if (matches[0]?.chunkId !== chunkId) throw new Error("Vector search did not return the expected chunk.");
  const search = await createSearchRepository(pool).search({ text: "memoria", limit: 5 });
  if (search[0]?.chunkId !== chunkId || search[0].page !== 1) {
    throw new Error("Accent-insensitive text search did not preserve evidence.");
  }

  const bibliographic = createBibliographicRepository(pool);
  const work = await bibliographic.createWork({
    type: "book", title: "A República", identifiers: { isbn: "9780000000001" }
  });
  await bibliographic.createInstance({ workId: work.id, type: "edition", isbn: "9780000000001" });
  if ((await bibliographic.lookup("9780000000001"))[0]?.id !== work.id) {
    throw new Error("Bibliographic identifier lookup failed.");
  }

  const ai = createAiConfigRepository(pool);
  const provider = await ai.upsertProvider({
    provider: "openai-compatible", displayName: "Test provider", credentialRef: "test:secret",
    baseUrl: "https://example.test/v1", metadata: { modelId: "test-256", capabilities: ["embedding"] }
  });
  const profile = await ai.createProfile({ name: "Default", isDefault: true });
  await ai.setProfileTask({
    profileId: profile.id, task: "embedding", providerConfigId: provider.id,
    modelId: "test-256", requiredCapabilities: ["embedding"]
  });
  if ((await ai.getDefaultTask("embedding"))?.providerConfigId !== provider.id) {
    throw new Error("Default AI profile task resolution failed.");
  }

  const runs = createIngestionRunRepository(pool);
  const ingestionRun = await runs.create({ sourceItemId: source.id, currentStage: "chunking" });
  await runs.beginStage(ingestionRun.id, "chunking");
  await runs.completeStage(ingestionRun.id, "chunking", { chunkCount: 1 });
  await runs.fail(ingestionRun.id, "simulated_restart");
  const resumed = await runs.startOrResume(ingestionRun.id);
  if ((resumed?.stagesCheckpoint.chunking as { status?: string } | undefined)?.status !== "completed") {
    throw new Error("Ingestion checkpoint was not preserved on resume.");
  }

  const jobs = createJobRepository(pool);
  const job = await jobs.create({ type: "chunking", payload: { documentId: document.id } });
  const claimed = await jobs.claimNext("phase2-verifier");
  if (claimed?.id !== job.id || claimed.status !== "running") throw new Error("SKIP LOCKED queue claim failed.");
  await jobs.reportProgress(job.id, 0.5);
  const canceled = await jobs.requestCancel(job.id);
  if (!canceled?.cancelRequestedAt) throw new Error("Running job cancellation was not persisted.");

  console.info(JSON.stringify({
    baselineMigrations: firstRun.seed.seededMigrations,
    migrationHistoryCount: Number(history.rows[0]?.count),
    extensions: extensions.rows.map((row) => row.extname),
    verifiedIndexes: indexes.rows.map((row) => row.indexname),
    vectorTopMatch: matches[0]?.chunkId,
    textTopMatch: search[0]?.chunkId
  }, null, 2));
} finally {
  if (pool) await closePgPool(pool);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
