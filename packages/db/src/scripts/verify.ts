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
  ,"bibliographic_works"
  ,"bibliographic_instances"
  ,"source_item_bibliographic_links"
  ,"ai_provider_configs"
  ,"ai_profile_sets"
  ,"ai_profile_tasks"
  ,"ai_task_profile_routes"
  ,"ai_model_capabilities"
  ,"ai_task_runs"
  ,"embeddings_256"
  ,"embeddings_768"
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

  const extensionResult = await pool.query<{ extname: string }>(
    "select extname from pg_extension where extname = any($1::text[]) order by extname",
    [["pg_trgm", "unaccent", "vector"]]
  );
  if (migrationCount < 3) {
    throw new Error("No rows found in drizzle.__drizzle_migrations.");
  }
  if (missingTables.length > 0) {
    throw new Error(`Missing expected tables: ${missingTables.join(", ")}.`);
  }
  if (extensionResult.rows.length !== 3) {
    throw new Error("Missing one or more phase 2 PostgreSQL extensions.");
  }

  console.info(`Verified ${migrationCount} Drizzle migration(s) and ${foundTables.size} expected table(s).`);
} finally {
  await closePgPool(pool);
}
