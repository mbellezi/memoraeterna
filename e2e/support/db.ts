// The stores of a running journey profile (F5 T137, spec 5.3): reads the clone's
// `database/dev-connection.json` (the app writes it once PostgreSQL is up) and queries the database
// directly, so a journey can assert what a gesture stored. The descriptor holds a password: it is
// read here, never logged, never written to a report, and an error message never repeats it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAiConfigRepository } from "@app/db";
import pg, { type QueryResult, type QueryResultRow } from "pg";
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

/**
 * The AI configuration repository of the profile's database. The one state a harness cannot reach
 * through the product is the Codex provider row that a browser sign-in leaves behind; it is written
 * here through the repository (so no new writer of the configuration tables exists), and the
 * product's own `ai.saveProvider` takes it from there.
 */
export function aiConfigRepositoryOn(db: ProfileDb) {
  const queryable: Parameters<typeof createAiConfigRepository>[0] = {
    async query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = []
    ) {
      const rows = await db.query<Record<string, unknown>>(text, [...values]);
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as QueryResult<Row>;
    }
  };
  return createAiConfigRepository(queryable);
}

/** How many rows a table holds (a fixed table name from the caller, never user input). */
export async function countRows(
  db: ProfileDb,
  table: "atomic_notes" | "atomic_note_relations" | "topics" | "source_items"
) {
  const [row] = await db.query<{ count: string }>(`select count(*)::text as count from ${table}`);
  return Number(row?.count ?? 0);
}

/**
 * The newest source's type, language and title, for a failure message: a journey that imports through
 * the Add flow needs a cassette recorded for the descriptor the Add flow derives (`descriptorFromFile`),
 * and that is not the golden descriptor BASE-J's source was imported with. Reads the stored row, so the
 * next red run names what the app derived instead of leaving it an inference.
 */
export async function newestSourceSummary(db: ProfileDb): Promise<string> {
  const [row] = await db.query<{ type: string; language: string; title: string }>(
    "select type::text as type, language, title from source_items order by created_at desc limit 1"
  );
  return row ? `${row.type} / ${row.language} / ${JSON.stringify(row.title)}` : "no source";
}

/** An unfinished job as the settle wait reads it. */
export interface UnfinishedJob extends Record<string, unknown> {
  type: string;
  status: string;
  dedupeKey: string | null;
  blockedClass: string | null;
}

/**
 * Passes that always wait in the queue for their next day (`scheduleRetention`,
 * `scheduleExplainBackfillPass`): never work an import leaves. Matched by their dedupe keys, so the
 * per-relation explanations a backfill pass queues still count.
 */
export const periodicPassKeys: readonly string[] = [
  "gardener-retention",
  "relation-explain-backfill:pass"
];

/**
 * Whether a job is work the settle wait must see finish: every running job and every queued one,
 * whatever its `run_after` (relation matching, topic overviews and topic-tree jobs are debounced
 * for up to minutes, and a clone starts paused, so work left queued would never run), except the
 * periodic passes, a job set aside until its class clears (`blocked_class`) and a model download
 * (as the first-run harness's `activeJobs`).
 */
export function isPendingWork(job: UnfinishedJob): boolean {
  if (job.status !== "running" && job.status !== "queued") return false;
  if (job.type === "local-model-download") return false;
  if (job.status === "running") return true;
  if (job.blockedClass !== null) return false;
  return job.dedupeKey === null || !periodicPassKeys.includes(job.dedupeKey);
}

export interface SettleOptions {
  timeoutMs: number;
  /** Between polls (10 s). */
  pollMs?: number;
  /** Polls in a row with no pending work (6: a finished job queues its follow-up a moment later). */
  quietPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits until no job is pending work (`isPendingWork`) for `quietPolls` polls in a row; throws on
 * timeout naming the job types still pending. Returns the jobs it left aside (blocked, periodic).
 */
export async function waitForSettled(
  db: ProfileDb,
  options: SettleOptions
): Promise<{ setAside: Record<string, number> }> {
  const pollMs = options.pollMs ?? 10_000;
  const quietPolls = options.quietPolls ?? 6;
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const deadline = Date.now() + options.timeoutMs;
  let quiet = 0;
  for (;;) {
    const rows = await db.query<UnfinishedJob>(
      `select type::text as type, status::text as status, dedupe_key as "dedupeKey",
              blocked_class as "blockedClass"
         from jobs where status::text in ('queued', 'running')`
    );
    const pending = rows.filter(isPendingWork);
    quiet = pending.length === 0 ? quiet + 1 : 0;
    if (quiet >= quietPolls) return { setAside: countByType(rows) };
    if (Date.now() >= deadline)
      throw new Error(
        `The import and its knowledge work did not settle within ${options.timeoutMs / 1000} s ` +
          `(pending: ${formatCounts(countByType(pending))})`
      );
    await sleep(pollMs);
  }
}

function countByType(rows: readonly UnfinishedJob[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1;
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type} ${count}`)
    .join(", ");
}
