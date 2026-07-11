import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAtomicNoteRepository,
  createAiConfigRepository,
  createChunkRepository,
  createDocumentRepository,
  createJobRepository,
  createKnowledgeGraphRepository,
  createLocalModelRepository,
  createPgPool,
  createSourceItemRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-phase5-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_phase5",
  user: "memora_phase5",
  password: `phase5-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

let pool;
let seedPool;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 3 });
  const migrationsFolder = resolve(packageRoot, "drizzle");
  const seedFolder = resolve(packageRoot, "seed");
  await runMigrations(pool, migrationsFolder);
  const history = await pool.query<{ count: string }>("select count(*)::text as count from drizzle.__drizzle_migrations");
  if (Number(history.rows[0]?.count) !== 11) throw new Error("Unexpected AI configuration migration history.");

  const tables = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public'
     and table_name in (
       'local_models', 'local_model_files', 'local_model_downloads', 'ai_task_profile_routes',
       'entities', 'entity_mentions', 'claims', 'claim_entity_links', 'entity_relations', 'atomic_note_entity_links'
     ) order by table_name`
  );
  if (tables.rows.length !== 10) throw new Error("AI or knowledge graph tables are missing.");
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns where table_schema = 'public' and (
       (table_name = 'ai_profile_sets' and column_name in (
         'output_language','provider_config_id','local_model_id','model_id','runtime','capabilities'
       )) or
       (table_name = 'ai_provider_configs' and column_name = 'default_parameters') or
       (table_name = 'local_models' and column_name = 'default_parameters') or
       (table_name = 'similarity_debug_results' and column_name in ('graph_rank','graph_score')) or
       (table_name = 'ai_task_runs' and column_name in ('adapter','repository','revision','quantization','parameters'))
     ) order by table_name, column_name`
  );
  if (columns.rows.length !== 15) throw new Error("AI parameter, graph score, and traceability columns are missing.");
  const indexes = await pool.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'public' and indexname in (
       'local_models_catalog_id_uidx','local_model_files_model_path_uidx','local_model_downloads_job_id_uidx',
       'ai_task_profile_routes_task_uidx','ai_task_profile_routes_profile_id_idx',
       'entities_type_normalized_name_uidx','entity_relations_evidence_uidx'
     )`
  );
  if (indexes.rows.length !== 7) throw new Error("AI configuration or knowledge graph indexes are missing.");

  const localModels = createLocalModelRepository(pool);
  const model = await localModels.upsertModel({
    catalogId: "phase5-model",
    modelId: "phase5/model",
    displayName: "Phase 5 model",
    family: "Verifier",
    variant: "4-bit",
    repository: "phase5/model",
    revision: "a".repeat(40),
    runtime: "mlx",
    format: "safetensors",
    quantization: "4-bit",
    expectedSizeBytes: 10,
    manifestHash: "b".repeat(64),
    capabilities: ["text-generation", "offline"],
    defaultParameters: { contextWindow: 4096, maxTokens: 1024 },
    licenseName: "Test",
    licenseUrl: "https://example.test/license"
  });
  await localModels.updateModel(model.id, {
    status: "ready",
    managedPath: join(workDir, "managed-model"),
    installedSizeBytes: 10
  });
  await localModels.replaceFiles(model.id, [{ path: "model.safetensors", sizeBytes: 10, sha256: "c".repeat(64) }]);
  if ((await localModels.listFiles(model.id)).length !== 1) throw new Error("Local model file persistence failed.");
  const job = await createJobRepository(pool).create({ type: "local-model-download", payload: { localModelId: model.id } });
  await localModels.createDownload({ localModelId: model.id, jobId: job.id, totalBytes: 10 });
  await localModels.updateDownload(job.id, { currentFile: "model.safetensors", downloadedBytes: 5, bytesPerSecond: 5, etaSeconds: 1 });
  if ((await localModels.latestDownload(model.id))?.downloadedBytes !== 5) throw new Error("Download checkpoint persistence failed.");

  const ai = createAiConfigRepository(pool);
  const profile = await ai.createProfile({
    name: "Offline verifier", isDefault: true, privacyMode: "offline_only", outputLanguage: "pt-BR"
  });
  await ai.updateProfile({
    id: profile.id,
    localModelId: model.id,
    modelId: model.modelId,
    runtime: "mlx",
    capabilities: ["text-generation", "summarization", "reranking", "offline"]
  });
  await ai.setProfileTask({
    profileId: profile.id,
    task: "summarization",
    parameters: { maxTokens: 256, temperature: 0 }
  });
  await ai.setTaskRoute("summarization", profile.id);
  const selectedTask = await ai.getDefaultTask("summarization");
  if (selectedTask?.localModelId !== model.id || selectedTask.outputLanguage !== "pt-BR"
      || selectedTask.modelDefaultParameters.contextWindow !== 4096
      || selectedTask.parameters.maxTokens !== 256) {
    throw new Error("Local model profile selection failed.");
  }
  const clonedProfile = await ai.cloneProfile(profile.id, "Offline verifier copy");
  const clonedTasks = await pool.query<{
    status: string;
  }>(
    `select status from ai_profile_tasks
     where profile_id = $1 and task = 'summarization'`,
    [clonedProfile.id]
  );
  if (clonedProfile.isDefault || clonedProfile.privacyMode !== profile.privacyMode
      || clonedProfile.outputLanguage !== profile.outputLanguage
      || clonedProfile.localModelId !== model.id || clonedTasks.rows[0]?.status !== "active") {
    throw new Error("AI profile clone did not preserve its profile and task configuration.");
  }
  await ai.recordTaskRun({
    profileId: profile.id,
    taskType: "summarization",
    provider: "local-mlx",
    modelId: model.modelId,
    runtime: "local",
    adapter: "mlx-swift-lm",
    repository: model.repository,
    revision: model.revision,
    quantization: model.quantization,
    parameters: { maxTokens: 32 },
    durationMs: 12,
    status: "succeeded"
  });

  const graphSource = await createSourceItemRepository(pool).create({
    type: "PersonalNote",
    title: "Graph verifier",
    language: "en"
  });
  const graphDocument = await createDocumentRepository(pool).create({
    sourceItemId: graphSource.id,
    title: graphSource.title,
    canonicalMarkdown: "PostgreSQL supports vector search.",
    contentHash: "graph-verifier",
    language: "en"
  });
  const graphChunkId = randomUUID();
  await createChunkRepository(pool).replaceDocumentChunks(graphDocument.id, graphSource.id, [{
    id: graphChunkId,
    sourceSpanId: randomUUID(),
    chunkIndex: 0,
    content: "PostgreSQL supports vector search.",
    contentHash: "graph-verifier-chunk",
    language: "en",
    span: { id: randomUUID(), startOffset: 0, endOffset: 34 }
  }].map((chunk) => ({ ...chunk, sourceSpanId: chunk.span.id })));
  const graphNote = await createAtomicNoteRepository(pool).upsertGenerated({
    title: "PostgreSQL vector search",
    bodyMarkdown: "PostgreSQL supports vector search.",
    ideaStatement: "PostgreSQL supports vector search.",
    language: "en",
    sourceItemId: graphSource.id,
    evidenceChunkId: graphChunkId,
    evidenceLinks: [{ chunkId: graphChunkId }],
    generationProvider: "verify",
    generationModel: "verify",
    generationRuntime: "test",
    generationPromptVersion: "atomic-note-v2",
    generationKey: "graph-verifier-note"
  });
  const relatedGraphNote = await createAtomicNoteRepository(pool).upsertGenerated({
    title: "Local vector indexing",
    bodyMarkdown: "Vector search can be indexed locally with PostgreSQL.",
    ideaStatement: "PostgreSQL can index vector search locally.",
    language: "en",
    sourceItemId: graphSource.id,
    evidenceChunkId: graphChunkId,
    evidenceLinks: [{ chunkId: graphChunkId }],
    generationProvider: "verify",
    generationModel: "verify",
    generationRuntime: "test",
    generationPromptVersion: "atomic-note-v2",
    generationKey: "graph-verifier-related-note"
  });
  const graph = createKnowledgeGraphRepository(pool);
  const graphPersistence = await graph.replaceSourceExtraction({
    sourceItemId: graphSource.id,
    language: "en",
    generation: { provider: "verify", model: "verify", promptVersion: "knowledge-graph-v1" },
    batches: [{
      entities: [
        { key: "postgres", type: "Product", canonicalName: "PostgreSQL", aliases: [], confidence: 1, evidenceChunkIds: [graphChunkId] },
        { key: "vector", type: "Concept", canonicalName: "Vector search", aliases: [], confidence: 1, evidenceChunkIds: [graphChunkId] }
      ],
      claims: [{ text: "PostgreSQL supports vector search.", confidence: 1, evidenceChunkIds: [graphChunkId], relatedEntityKeys: ["postgres", "vector"] }],
      relations: [{ subjectEntityKey: "postgres", predicate: "supports", objectEntityKey: "vector", confidence: 1, evidenceChunkIds: [graphChunkId] }]
    }]
  });
  if (graphPersistence.entityCount !== 2 || graphPersistence.claimCount !== 1
      || graphPersistence.relationCount !== 1 || graphPersistence.atomicNoteEntityLinkCount !== 4) {
    throw new Error("Knowledge graph SQL persistence failed.");
  }
  const noteElements = await graph.listAtomicNoteElements([graphNote.id]);
  const extracted = noteElements.get(graphNote.id);
  if (extracted?.entities.length !== 2 || extracted.claims.length !== 1 || extracted.relations.length !== 1) {
    throw new Error("Atomic-note graph debug elements are incomplete.");
  }
  await graph.projectSource(graphSource.id);
  const graphNoteCandidates = await graph.findAtomicNoteCandidates(graphNote.id, 10);
  if (graphNoteCandidates[0]?.noteId !== relatedGraphNote.id || graphNoteCandidates[0].graphScore <= 0) {
    throw new Error("AGE atomic-note candidate discovery or entity-frequency scoring failed.");
  }
  const graphResults = await graph.searchChunks({ text: "PostgreSQL", limit: 10 });
  if (graphResults[0]?.chunkId !== graphChunkId || graphResults[0].graphScore <= 0) {
    throw new Error("AGE graph projection or search failed.");
  }
  await graph.clearProjection();
  const clearedGraph = await pool.query(
    "select 1 from ag_catalog.ag_graph where name = 'memora_knowledge'"
  );
  if (clearedGraph.rowCount !== 0) {
    throw new Error("AGE graph projection cleanup failed.");
  }

  await pool.query("create database memora_phase5_seed");
  const seedUrl = new URL(connection.connectionString);
  seedUrl.pathname = "/memora_phase5_seed";
  seedPool = createPgPool({ connectionString: seedUrl.toString(), max: 2 });
  const baseline = await runMigrations(seedPool, migrationsFolder, { seedFolder });
  if (!baseline.seed.applied || baseline.seed.seededMigrations.length !== 11) {
    throw new Error("Empty database did not apply the complete phase 5 baseline.");
  }
  if ((await runMigrations(seedPool, migrationsFolder, { seedFolder })).seed.applied) {
    throw new Error("Seed database reapplied the baseline.");
  }

  console.info(JSON.stringify({
    migrationHistoryCount: Number(history.rows[0]?.count),
    tables: tables.rows.map((row) => row.table_name),
    columns: columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
    indexes: indexes.rows.map((row) => row.indexname),
    localModelId: model.id,
    clonedProfileId: clonedProfile.id,
    downloadJobId: job.id,
    graphSourceId: graphSource.id,
    graphScore: graphResults[0].graphScore,
    baselineMigrations: baseline.seed.seededMigrations
  }, null, 2));
} finally {
  if (seedPool) await closePgPool(seedPool);
  if (pool) await closePgPool(pool);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
