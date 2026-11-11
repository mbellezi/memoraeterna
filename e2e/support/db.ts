// The stores of a running journey profile (F5 T137, spec 5.3): reads the clone's
// `database/dev-connection.json` (the app writes it once PostgreSQL is up) and queries the database
// directly, so a journey can assert what a gesture stored. The descriptor holds a password: it is
// read here, never logged, never written to a report, and an error message never repeats it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { z } from "zod";

const connectionSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    database: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1)
  })
  .passthrough();

export interface ProfileDb {
  query<Row extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

/** The descriptor of a running profile; throws without naming its content. */
export async function readConnection(userDataDir: string) {
  const path = join(userDataDir, "database", "dev-connection.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`The profile has no readable database/dev-connection.json (${userDataDir})`);
  }
  const parsed = connectionSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`database/dev-connection.json is not a connection descriptor (${userDataDir})`);
  return parsed.data;
}

/** A small pool on the profile's database (loopback only); close it before the app quits. */
export async function openProfileDb(userDataDir: string): Promise<ProfileDb> {
  const connection = await readConnection(userDataDir);
  if (!["127.0.0.1", "localhost", "::1"].includes(connection.host))
    throw new Error("A journey only reads a database on loopback");
  const pool = new pg.Pool({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    max: 2,
    application_name: "memora-journeys"
  });
  return {
    async query<Row extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return (await pool.query<Row>(sql, params)).rows;
    },
    close: () => pool.end()
  };
}

/** Jobs that are not finished yet, by type (`queued` and `running`). */
export async function pendingJobs(db: ProfileDb): Promise<Record<string, number>> {
  const rows = await db.query<{ type: string; count: string }>(
    "select type, count(*)::text as count from jobs where status in ('queued', 'running') group by type"
  );
  return Object.fromEntries(rows.map((row) => [row.type, Number(row.count)]));
}

/** How many rows a table holds (a fixed table name from the caller, never user input). */
export async function countRows(
  db: ProfileDb,
  table: "atomic_notes" | "atomic_note_relations" | "topics" | "source_items"
) {
  const [row] = await db.query<{ count: string }>(`select count(*)::text as count from ${table}`);
  return Number(row?.count ?? 0);
}
