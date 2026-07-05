import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { closePgPool, createPgPool } from "../client.js";
import { runMigrations } from "../migrations.js";

const connectionString = process.env.MEMORA_DATABASE_URL;
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

if (!connectionString) {
  throw new Error("MEMORA_DATABASE_URL is required to run database migrations.");
}

const pool = createPgPool({ connectionString, max: 1 });

try {
  await runMigrations(pool, migrationsFolder);
} finally {
  await closePgPool(pool);
}
