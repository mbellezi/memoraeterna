import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAiConfigRepository,
  createAtomicNoteRelationRepository,
  createAtomicNoteRepository,
  createChunkRepository,
  createDocumentRepository,
  createEmbeddingRepository,
  createIngestionRunRepository,
  createLibraryRepository,
  createPgPool,
  createSourceItemRepository,
  createSourceSummaryRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-phase3-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_phase3",
  user: "memora_phase3",
  password: `phase3-${randomUUID()}`,
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
  if (!firstRun.seed.applied || firstRun.seed.seededMigrations.length !== 4) {
    throw new Error("Empty database did not apply the complete phase 3 baseline.");
  }
  const secondRun = await runMigrations(pool, migrationsFolder, { seedFolder });
  if (secondRun.seed.applied) throw new Error("Existing database reapplied the phase 3 baseline.");

  const history = await pool.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  if (Number(history.rows[0]?.count) !== 4) throw new Error("Unexpected Drizzle migration history.");
  const tables = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name in (
       'source_summaries', 'atomic_notes', 'atomic_note_source_links',
       'atomic_note_relations', 'atomic_note_review_events'
     ) order by table_name`
  );
  if (tables.rows.length !== 5) throw new Error("Phase 3 knowledge tables are missing.");
  const indexes = await pool.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'public'
     and indexname in (
       'source_summaries_source_item_id_idx', 'atomic_notes_status_idx',
       'atomic_notes_source_generation_key_uidx',
       'atomic_note_source_links_note_chunk_uidx',
       'atomic_note_relations_source_target_uidx',
       'atomic_note_review_events_note_id_idx'
     )`
  );
  if (indexes.rows.length !== 6) throw new Error("Phase 3 indexes are missing.");

  const sources = createSourceItemRepository(pool);
  const source = await sources.create({
    type: "PersonalNote",
    title: "Traceable knowledge",
    language: "en",
    metadata: { entities: ["PostgreSQL"], tags: ["local-first"] }
  });
  const document = await createDocumentRepository(pool).create({
    sourceItemId: source.id,
    title: source.title,
    canonicalMarkdown: "# Traceable knowledge\n\nAtomic notes preserve evidence.\n",
    contentHash: "a".repeat(64),
    language: "en"
  });
  const chunkId = randomUUID();
  const spanId = randomUUID();
  await createChunkRepository(pool).replaceDocumentChunks(document.id, source.id, [{
    id: chunkId,
    sourceSpanId: spanId,
    chunkIndex: 0,
    content: "Atomic notes preserve evidence.",
    contentHash: "b".repeat(64),
    span: { id: spanId, startOffset: 23, endOffset: 54, page: 1 }
  }]);

  const ai = createAiConfigRepository(pool);
  const provider = await ai.upsertProvider({
    provider: "openai-compatible",
    displayName: "Phase 3 verifier",
    credentialRef: "test:secret",
    baseUrl: "https://example.test/v1",
    metadata: { modelId: "mock-model" }
  });
  const profile = await ai.createProfile({ name: "Phase 3", isDefault: true });
  await ai.setProfileTask({
    profileId: profile.id,
    task: "summarization",
    providerConfigId: provider.id,
    modelId: "mock-model",
    requiredCapabilities: ["summarization"]
  });
  const aiTaskRunId = await ai.recordTaskRun({
    profileId: profile.id,
    taskType: "summarization",
    provider: "openai-compatible",
    modelId: "mock-model",
    runtime: "remote",
    durationMs: 10,
    status: "succeeded"
  });
  const summary = await createSourceSummaryRepository(pool).create({
    sourceItemId: source.id,
    summary: "Atomic notes preserve traceable evidence.",
    language: "en",
    profileId: profile.id,
    aiTaskRunId,
    provider: "openai-compatible",
    model: "mock-model",
    runtime: "remote",
    promptVersion: "summary-v1",
    inputHash: "a".repeat(64),
    outputHash: "c".repeat(64),
    metadata: { mapReduce: false }
  });
  await sources.update(source.id, { summary: summary.summary, summaryGeneratedAt: summary.generatedAt });
  if ((await sources.findById(source.id))?.summary !== summary.summary) {
    throw new Error("Source summary was not promoted to source_items.");
  }

  const notes = createAtomicNoteRepository(pool);
  const firstNote = await notes.upsertGenerated({
    title: "Atomic notes preserve evidence",
    bodyMarkdown: "An atomic note should retain a link to its supporting chunk.",
    ideaStatement: "Atomic notes are traceable to evidence.",
    language: "en",
    sourceItemId: source.id,
    evidenceChunkId: chunkId,
    sourceSpanId: spanId,
    evidenceLinks: [{ chunkId, sourceSpanId: spanId }],
    generationProfileId: profile.id,
    aiTaskRunId,
    generationProvider: "openai-compatible",
    generationModel: "mock-model",
    generationRuntime: "remote",
    generationPromptVersion: "atomic-note-v1",
    generationKey: "first-note",
    metadata: { entities: ["PostgreSQL"] }
  });
  const secondNote = await notes.upsertGenerated({
    title: "Provenance supports review",
    bodyMarkdown: "Evidence links let reviewers inspect generated notes.",
    ideaStatement: "Provenance makes generated knowledge reviewable.",
    language: "en",
    sourceItemId: source.id,
    evidenceChunkId: chunkId,
    sourceSpanId: spanId,
    evidenceLinks: [{ chunkId, sourceSpanId: spanId }],
    generationProfileId: profile.id,
    aiTaskRunId,
    generationProvider: "openai-compatible",
    generationModel: "mock-model",
    generationRuntime: "remote",
    generationPromptVersion: "atomic-note-v1",
    generationKey: "second-note",
    metadata: { entities: ["PostgreSQL"] }
  });
  if (firstNote.status !== "pending_review" || secondNote.status !== "pending_review") {
    throw new Error("Generated notes did not start pending review.");
  }
  await notes.upsertGenerated({
    title: firstNote.title,
    bodyMarkdown: firstNote.bodyMarkdown,
    ideaStatement: firstNote.ideaStatement,
    language: firstNote.language,
    sourceItemId: source.id,
    evidenceChunkId: chunkId,
    evidenceLinks: [{ chunkId, sourceSpanId: spanId }],
    generationProvider: firstNote.generationProvider,
    generationModel: firstNote.generationModel,
    generationRuntime: firstNote.generationRuntime,
    generationPromptVersion: firstNote.generationPromptVersion,
    generationKey: firstNote.generationKey
  });
  if ((await notes.listBySourceItem(source.id)).length !== 2) {
    throw new Error("Atomic note generation was not idempotent.");
  }

  const vector = Array.from({ length: 256 }, (_, index) => index === 0 ? 1 : 0);
  const embeddings = createEmbeddingRepository(pool);
  await embeddings.upsert({
    targetType: "atomic_note", targetId: firstNote.id, provider: "test", model: "test-256",
    runtime: "local", usage: "matching", contentHash: "d".repeat(64), embedding: vector
  });
  await embeddings.upsert({
    targetType: "atomic_note", targetId: secondNote.id, provider: "test", model: "test-256",
    runtime: "local", usage: "matching", contentHash: "e".repeat(64), embedding: vector
  });
  const candidates = await notes.findMatchingCandidates({
    noteId: firstNote.id,
    embedding: vector,
    embeddingModel: "test-256",
    limit: 5
  });
  if (candidates[0]?.note.id !== secondNote.id || candidates[0].vectorScore < 0.99) {
    throw new Error("Hybrid atomic note candidate search failed.");
  }

  const relation = await createAtomicNoteRelationRepository(pool).upsert({
    sourceAtomicNoteId: firstNote.id,
    targetAtomicNoteId: secondNote.id,
    relationType: "supports",
    vectorScore: candidates[0].vectorScore,
    graphScore: 1,
    finalScore: 0.9,
    explanation: "knowledge.relations.explanations.hybrid",
    matchingProfileId: profile.id,
    matchingModel: "mock-model",
    metadata: { threshold: 0.72 }
  });
  if (relation.finalScore !== 0.9) throw new Error("Atomic note relation was not persisted.");
  const approved = await notes.review({ id: firstNote.id, action: "approve" });
  if (approved?.status !== "approved") throw new Error("Atomic note approval failed.");
  const reviewEvents = await pool.query<{ count: string }>(
    "select count(*)::text as count from atomic_note_review_events where atomic_note_id = $1",
    [firstNote.id]
  );
  if (Number(reviewEvents.rows[0]?.count) !== 1) throw new Error("Review transition was not recorded.");

  const ingestionRun = await createIngestionRunRepository(pool).create({
    sourceItemId: source.id,
    currentStage: "atomicNoteMatching"
  });
  await createIngestionRunRepository(pool).complete(ingestionRun.id);
  const library = await createLibraryRepository(pool).listSources();
  if (library[0]?.id !== source.id || library[0].processingStatus !== "succeeded") {
    throw new Error("Library processing state query failed.");
  }

  console.info(JSON.stringify({
    baselineMigrations: firstRun.seed.seededMigrations,
    migrationHistoryCount: Number(history.rows[0]?.count),
    verifiedTables: tables.rows.map((row) => row.table_name),
    verifiedIndexes: indexes.rows.map((row) => row.indexname),
    sourceSummaryId: summary.id,
    pendingNotesCreated: 2,
    candidateTopMatch: candidates[0]?.note.id,
    relationId: relation.id,
    reviewEventCount: Number(reviewEvents.rows[0]?.count)
  }, null, 2));
} finally {
  if (pool) await closePgPool(pool);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
