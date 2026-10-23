import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { closePgPool, createPgPool, runMigrations } from "@app/db";

import { resolveConnection } from "../kpi/connection.js";

/**
 * Applies every pending migration to a scratch clone through `runMigrations`, the call the app
 * makes at start (inside its 30 s bound, gate M), and prints how long it took and how many
 * migrations the history held before and after. For the migration time of a profile from its head:
 *
 *   npx tsx scripts/ask/migrate-timed.ts --db <scratch connection.json | postgres url>
 *
 * Loopback only; it writes to the database it is given, so give it a clone, never a profile.
 */
const { values } = parseArgs({ options: { db: { type: "string" } }, strict: true });
if (!values.db) {
  console.error("Usage: npx tsx scripts/ask/migrate-timed.ts --db <scratch connection.json | url>");
  process.exit(2);
}
const connection = await resolveConnection(values.db);
if (
  !["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    connection.info.host.replace(/^\[|\]$/gu, "")
  )
)
  throw new Error("Only a loopback scratch database is migrated.");
const pool = createPgPool({ connectionString: connection.connectionString, max: 1 });
const count = async () =>
  Number(
    (
      await pool.query<{ n: string }>(
        "select count(*)::text as n from drizzle.__drizzle_migrations"
      )
    ).rows[0]!.n
  );
try {
  const before = await count();
  const started = performance.now();
  await runMigrations(pool, resolve(import.meta.dirname, "../../packages/db/drizzle"));
  console.info(
    JSON.stringify({
      database: connection.info.name,
      migrationsBefore: before,
      migrationsAfter: await count(),
      migrationMs: Math.round(performance.now() - started)
    })
  );
} finally {
  await closePgPool(pool);
}
