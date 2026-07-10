import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAiConfigRepository,
  createJobRepository,
  createLocalModelRepository,
  createPgPool,
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
  if (Number(history.rows[0]?.count) !== 6) throw new Error("Unexpected phase 5 migration history.");

  const tables = await pool.query<{ table_name: string }>(
    `select table_name from information_schema.tables where table_schema = 'public'
     and table_name in ('local_models', 'local_model_files', 'local_model_downloads') order by table_name`
  );
  if (tables.rows.length !== 3) throw new Error("Phase 5 local model tables are missing.");
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns where table_schema = 'public' and (
       (table_name = 'ai_profile_tasks' and column_name = 'local_model_id') or
       (table_name = 'ai_task_runs' and column_name in ('adapter','repository','revision','quantization','parameters'))
     ) order by table_name, column_name`
  );
  if (columns.rows.length !== 6) throw new Error("Phase 5 AI traceability columns are missing.");
  const indexes = await pool.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'public' and indexname in (
       'local_models_catalog_id_uidx','local_model_files_model_path_uidx','local_model_downloads_job_id_uidx'
     )`
  );
  if (indexes.rows.length !== 3) throw new Error("Phase 5 local model indexes are missing.");

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
  const profile = await ai.createProfile({ name: "Offline verifier", isDefault: true, privacyMode: "offline_only" });
  await ai.setProfileTask({
    profileId: profile.id,
    task: "summarization",
    localModelId: model.id,
    modelId: model.modelId,
    runtime: "mlx",
    requiredCapabilities: ["summarization"]
  });
  if ((await ai.getDefaultTask("summarization"))?.localModelId !== model.id) {
    throw new Error("Local model profile selection failed.");
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

  await pool.query("create database memora_phase5_seed");
  const seedUrl = new URL(connection.connectionString);
  seedUrl.pathname = "/memora_phase5_seed";
  seedPool = createPgPool({ connectionString: seedUrl.toString(), max: 2 });
  const baseline = await runMigrations(seedPool, migrationsFolder, { seedFolder });
  if (!baseline.seed.applied || baseline.seed.seededMigrations.length !== 6) {
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
    downloadJobId: job.id,
    baselineMigrations: baseline.seed.seededMigrations
  }, null, 2));
} finally {
  if (seedPool) await closePgPool(seedPool);
  if (pool) await closePgPool(pool);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
