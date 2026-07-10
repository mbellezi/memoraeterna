import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createDocumentRepository,
  createIntegrationClientRepository,
  createObsidianSyncRepository,
  createPgPool,
  createSourceItemRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-phase4-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_phase4",
  user: "memora_phase4",
  password: `phase4-${randomUUID()}`,
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

  const migrated = await runMigrations(pool, migrationsFolder);
  if (migrated.seed.applied) throw new Error("Migration-only flow unexpectedly applied the baseline.");
  const existingRun = await runMigrations(pool, migrationsFolder, { seedFolder });
  if (existingRun.seed.applied) throw new Error("Existing database reapplied the baseline.");
  const history = await pool.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  if (Number(history.rows[0]?.count) !== 5) throw new Error("Unexpected phase 4 migration history.");

  const columns = await pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
    `select table_name, column_name, is_nullable from information_schema.columns
     where table_schema = 'public' and (
       (table_name = 'integration_clients' and column_name in ('capabilities', 'contract_version')) or
       (table_name = 'obsidian_sync_files' and column_name in ('memora_id', 'entity_type', 'entity_id', 'frontmatter_hash', 'mtime_ms'))
     ) order by table_name, column_name`
  );
  if (columns.rows.length !== 7 || columns.rows.some((column) => column.is_nullable !== "NO")) {
    throw new Error("Phase 4 integration columns are missing or nullable.");
  }
  const indexes = await pool.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = 'public'
     and indexname in ('integration_clients_token_hash_uidx', 'obsidian_sync_files_memora_id_uidx', 'obsidian_sync_files_relative_path_uidx')`
  );
  if (indexes.rows.length !== 3) throw new Error("Phase 4 integration indexes are missing.");

  const token = `memora_${randomUUID()}`;
  const clients = createIntegrationClientRepository(pool);
  const client = await clients.create({
    clientType: "chrome-extension",
    displayName: "Phase 4 verifier",
    tokenHash: createHash("sha256").update(token).digest("hex"),
    scopes: ["capture-web-page"],
    capabilities: ["capture-web-page"],
    contractVersion: "1.0.0"
  });
  if ((await clients.findAuthorizedByTokenHash(client.tokenHash))?.id !== client.id) {
    throw new Error("Integration client authorization lookup failed.");
  }
  await clients.touch(client.id, { capabilities: ["capture-web-page"], contractVersion: "1.0.0" });
  if (!(await clients.setStatus(client.id, "revoked")) || await clients.findAuthorizedByTokenHash(client.tokenHash)) {
    throw new Error("Integration client revocation failed.");
  }

  const source = await createSourceItemRepository(pool).create({ type: "PersonalNote", title: "Projected note" });
  const document = await createDocumentRepository(pool).create({
    sourceItemId: source.id,
    title: source.title,
    canonicalMarkdown: "# Projected note\n",
    contentHash: "a".repeat(64)
  });
  const syncFiles = createObsidianSyncRepository(pool);
  const syncFile = await syncFiles.create({
    memoraId: source.id,
    entityType: "source_item",
    entityId: source.id,
    sourceItemId: source.id,
    documentId: document.id,
    memoraType: "source_item",
    relativePath: "Memora/Sources/Notes/projected-note.md",
    frontmatterHash: "b".repeat(64),
    contentHash: "a".repeat(64),
    mtimeMs: Date.now(),
    status: "synced"
  });
  if ((await syncFiles.findByMemoraId(source.id))?.id !== syncFile.id) {
    throw new Error("Obsidian identity lookup failed.");
  }
  const moved = await syncFiles.update(syncFile.id, { relativePath: "Memora/Sources/Notes/moved.md" });
  if (moved?.relativePath !== "Memora/Sources/Notes/moved.md") throw new Error("Obsidian path update failed.");

  await pool.query("create database memora_phase4_seed");
  const seedUrl = new URL(connection.connectionString);
  seedUrl.pathname = "/memora_phase4_seed";
  seedPool = createPgPool({ connectionString: seedUrl.toString(), max: 2 });
  const baseline = await runMigrations(seedPool, migrationsFolder, { seedFolder });
  if (!baseline.seed.applied || baseline.seed.seededMigrations.length !== 5) {
    throw new Error("Empty database did not apply the complete phase 4 baseline.");
  }
  if ((await runMigrations(seedPool, migrationsFolder, { seedFolder })).seed.applied) {
    throw new Error("Seed database reapplied the baseline.");
  }

  console.info(JSON.stringify({
    migrationHistoryCount: Number(history.rows[0]?.count),
    verifiedColumns: columns.rows.map((column) => `${column.table_name}.${column.column_name}`),
    verifiedIndexes: indexes.rows.map((index) => index.indexname),
    integrationClientRevoked: client.id,
    obsidianSyncFile: syncFile.id,
    baselineMigrations: baseline.seed.seededMigrations
  }, null, 2));
} finally {
  if (seedPool) await closePgPool(seedPool);
  if (pool) await closePgPool(pool);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
