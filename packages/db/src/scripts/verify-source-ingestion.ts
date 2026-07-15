import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createBibliographicRepository,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-source-ingestion-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_source_ingestion",
  user: "memora_source_ingestion",
  password: `source-ingestion-${randomUUID()}`,
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

  const history = await pool.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  if (Number(history.rows[0]?.count) !== 18) {
    throw new Error("Unexpected source-ingestion migration history.");
  }

  const columns = await pool.query<{
    tableName: string;
    columnName: string;
    isNullable: string;
    dataType: string;
    columnDefault: string | null;
  }>(
    `select table_name as "tableName", column_name as "columnName", is_nullable as "isNullable",
            data_type as "dataType", column_default as "columnDefault"
       from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'bibliographic_works' and column_name = 'creators') or
        (table_name = 'bibliographic_instances' and column_name in ('creators', 'page_count', 'series'))
      )
      order by table_name, column_name`
  );
  if (columns.rows.length !== 4) throw new Error("Source descriptor columns are missing.");
  const creatorColumns = columns.rows.filter((column) => column.columnName === "creators");
  if (creatorColumns.some((column) => column.isNullable !== "NO" || column.dataType !== "jsonb"
      || !column.columnDefault?.includes("[]"))) {
    throw new Error("Creator columns do not have the required JSONB default.");
  }

  const bibliographic = createBibliographicRepository(pool);
  const creator = { name: "Verification Author", role: "author" };
  const work = await bibliographic.createWork({
    type: "book",
    title: "Source ingestion verification",
    creators: [creator]
  });
  const instanceId = await bibliographic.createInstance({
    workId: work.id,
    type: "edition",
    creators: [creator],
    pageCount: 321,
    series: "Verification series"
  });
  const persisted = await pool.query<{
    creators: unknown;
    pageCount: number;
    series: string;
  }>(
    `select creators, page_count as "pageCount", series
       from bibliographic_instances where id = $1`,
    [instanceId]
  );
  if (!Array.isArray(persisted.rows[0]?.creators) || persisted.rows[0]?.pageCount !== 321
      || persisted.rows[0]?.series !== "Verification series") {
    throw new Error("Structured bibliographic metadata did not round-trip.");
  }

  await pool.query("create database memora_source_ingestion_seed");
  const seedUrl = new URL(connection.connectionString);
  seedUrl.pathname = "/memora_source_ingestion_seed";
  seedPool = createPgPool({ connectionString: seedUrl.toString(), max: 2 });
  const baseline = await runMigrations(seedPool, migrationsFolder, { seedFolder });
  if (!baseline.seed.applied || baseline.seed.seededMigrations.length !== 18) {
    throw new Error("Empty database did not apply the complete source-ingestion baseline.");
  }
  if ((await runMigrations(seedPool, migrationsFolder, { seedFolder })).seed.applied) {
    throw new Error("Source-ingestion baseline was reapplied to an existing database.");
  }

  console.info(JSON.stringify({
    migrationHistoryCount: Number(history.rows[0]?.count),
    columns: columns.rows,
    workId: work.id,
    instanceId,
    baselineMigrations: baseline.seed.seededMigrations
  }, null, 2));
} finally {
  if (seedPool) await closePgPool(seedPool);
  if (pool) await closePgPool(pool);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
