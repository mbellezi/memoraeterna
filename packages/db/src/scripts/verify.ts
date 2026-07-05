import { closePgPool, createPgPool } from "../client.js";

const connectionString = process.env.MEMORA_DATABASE_URL;

if (!connectionString) {
  throw new Error("MEMORA_DATABASE_URL is required to verify database migrations.");
}

const expectedTables = [
  "source_items",
  "documents",
  "document_assets",
  "source_spans",
  "chunks",
  "jobs",
  "ingestion_runs",
  "settings",
  "storage_settings",
  "integration_clients",
  "obsidian_sync_files"
];

const pool = createPgPool({ connectionString, max: 1 });

try {
  const migrationResult = await pool.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  const migrationCount = Number(migrationResult.rows[0]?.count ?? 0);

  const tableResult = await pool.query<{ table_name: string }>(
    `select table_name
     from information_schema.tables
     where table_schema = 'public' and table_name = any($1::text[])
     order by table_name`,
    [expectedTables]
  );
  const foundTables = new Set(tableResult.rows.map((row) => row.table_name));
  const missingTables = expectedTables.filter((table) => !foundTables.has(table));

  if (migrationCount < 1) {
    throw new Error("No rows found in drizzle.__drizzle_migrations.");
  }
  if (missingTables.length > 0) {
    throw new Error(`Missing expected tables: ${missingTables.join(", ")}.`);
  }

  console.info(`Verified ${migrationCount} Drizzle migration(s) and ${foundTables.size} expected table(s).`);
} finally {
  await closePgPool(pool);
}
