import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAiConfigRepository,
  createPgPool,
  PostgresSidecarManager,
  type PgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

/**
 * Real-database check of migration `0057_ai_task_run_lanes` (F3 T47): on a database with history
 * (every earlier migration applied and AI task runs written) only the new migration runs and keeps
 * the old rows unknown; on an empty database the baseline brings the same columns. It checks the
 * columns, types, defaults, constraints, the index and that the soak report's query can use it,
 * and that the writer stores and nulls the scheduler's fields. It starts its own temporary
 * PostgreSQL sidecar and never connects to an existing database.
 */
const migrationName = "0057_ai_task_run_lanes";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-ai-lanes-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_ai_lanes",
  user: "memora_ai_lanes",
  password: `ai-lanes-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

interface Journal {
  entries: Array<{ tag: string }>;
}

const expectedColumns = [
  "deadline_ms:integer:YES:",
  "deadline_outcome:text:YES:",
  "is_repair:boolean:NO:false",
  "lane:text:YES:",
  "priority:smallint:YES:",
  "requeue_ms:integer:YES:",
  "retry_wait_ms:integer:YES:",
  "schema_mode:text:YES:",
  "workload_class:text:YES:"
];
const expectedChecks = [
  "ai_task_runs_deadline",
  "ai_task_runs_lane",
  "ai_task_runs_priority",
  "ai_task_runs_schema_mode",
  "ai_task_runs_waits",
  "ai_task_runs_workload_class"
];

async function laneColumns(db: PgPool): Promise<string[]> {
  const columns = await db.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select column_name, data_type, is_nullable, column_default from information_schema.columns
     where table_name = 'ai_task_runs' and column_name = any($1::text[]) order by column_name`,
    [expectedColumns.map((column) => column.split(":")[0])]
  );
  return columns.rows.map(
    (row) => `${row.column_name}:${row.data_type}:${row.is_nullable}:${row.column_default ?? ""}`
  );
}

async function verifySchema(db: PgPool, label: string, journal: Journal): Promise<void> {
  const history = await db.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  assert.equal(Number(history.rows[0]?.count), journal.entries.length, `${label}: history`);
  assert.deepEqual(await laneColumns(db), expectedColumns, `${label}: columns`);
  const checks = await db.query<{ conname: string }>(
    `select conname from pg_constraint
     where conrelid = 'ai_task_runs'::regclass and contype = 'c' and conname like 'ai_task_runs_%'
     order by conname`
  );
  assert.deepEqual(
    checks.rows.map((row) => row.conname),
    expectedChecks,
    `${label}: constraints`
  );
  const index = await db.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where indexname = 'ai_task_runs_started_class_idx'"
  );
  assert.match(
    index.rows[0]?.indexdef ?? "",
    /ON public\.ai_task_runs USING btree \(started_at, workload_class\)/u,
    `${label}: index`
  );
}

/** Applies every migration before 0057 from a copy of the folder, as a profile from before F3. */
async function migrateBefore(db: PgPool, journal: Journal): Promise<void> {
  const folder = join(workDir, "migrations-before");
  await cp(migrationsFolder, folder, { recursive: true });
  const position = journal.entries.findIndex((entry) => entry.tag === migrationName);
  assert.ok(position > 0, "the migration is in the journal");
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }, null, 2)
  );
  await runMigrations(db, folder);
}

const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const admin = createPgPool({ connectionString: connection.connectionString, max: 2 });
  pools.push(admin);
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")
  ) as Journal;
  const databaseUrl = (name: string) => {
    const url = new URL(connection.connectionString);
    url.pathname = `/${name}`;
    return url.toString();
  };

  // 1. A database with history: the earlier migrations and AI task runs written before 0057.
  await admin.query("create database memora_ai_lanes_history");
  const history = createPgPool({
    connectionString: databaseUrl("memora_ai_lanes_history"),
    max: 3
  });
  pools.push(history);
  await migrateBefore(history, journal);
  assert.deepEqual(await laneColumns(history), [], "no lane columns before 0057");
  // Written as the pre-F3 writer wrote it (the current writer needs the 0057 columns).
  const written = await history.query<{ id: string }>(
    `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, queue_ms, attempt,
       status, finished_at)
     values ('summarization', 'openai-codex', 'writer', 'remote', 1200, 30, 0, 'succeeded', now())
     returning id`
  );
  const before = written.rows[0]!.id;
  const beforeCount = await history.query<{ count: string }>(
    "select count(*)::text as count from ai_task_runs"
  );
  const started = performance.now();
  await runMigrations(history, migrationsFolder, { seedFolder });
  const migrationMs = Math.round(performance.now() - started);
  await verifySchema(history, "history", journal);
  const kept = await history.query<Record<string, unknown>>(
    `select queue_ms, attempt, duration_ms, lane, workload_class, priority, deadline_ms,
            deadline_outcome, is_repair, schema_mode, retry_wait_ms, requeue_ms
     from ai_task_runs where id = $1`,
    [before]
  );
  assert.deepEqual(
    kept.rows[0],
    {
      queue_ms: 30,
      attempt: 0,
      duration_ms: 1_200,
      lane: null,
      workload_class: null,
      priority: null,
      deadline_ms: null,
      deadline_outcome: null,
      is_repair: false,
      schema_mode: null,
      retry_wait_ms: null,
      requeue_ms: null
    },
    "a row written before 0057 keeps its values and reads the new ones as unknown"
  );
  const afterCount = await history.query<{ count: string }>(
    "select count(*)::text as count from ai_task_runs"
  );
  assert.equal(afterCount.rows[0]?.count, beforeCount.rows[0]?.count, "no row added or lost");

  // 2. An empty database: the baseline seed carries 0057.
  await admin.query("create database memora_ai_lanes_empty");
  const empty = createPgPool({ connectionString: databaseUrl("memora_ai_lanes_empty"), max: 3 });
  pools.push(empty);
  const seeded = await runMigrations(empty, migrationsFolder, { seedFolder });
  assert.ok(seeded.seed.applied, "the baseline seed was applied");
  await verifySchema(empty, "empty", journal);

  // 3. The writer stores the scheduler's fields, nulls what is unknown or out of range.
  const ai = createAiConfigRepository(empty);
  const base = {
    taskType: "reranking",
    provider: "local-mlx",
    modelId: "ranker",
    runtime: "mlx",
    durationMs: 900,
    status: "succeeded"
  };
  const full = await ai.recordTaskRun({
    ...base,
    lane: "local",
    workloadClass: "decide",
    priority: 2,
    deadlineMs: 10_000,
    deadlineOutcome: "met",
    isRepair: false,
    schemaMode: "none",
    retryWaitMs: 0,
    requeueMs: 0
  });
  const remote = await ai.recordTaskRun({
    ...base,
    provider: "openai-codex",
    runtime: "remote",
    status: "failed",
    lane: "remote:00000000-0000-4000-8000-000000000001",
    workloadClass: "write-fast",
    priority: 0,
    deadlineMs: 120_000,
    deadlineOutcome: "aborted",
    isRepair: true,
    schemaMode: "json",
    retryWaitMs: 812.4,
    requeueMs: 2_500.6
  });
  const unknown = await ai.recordTaskRun({ ...base, priority: 9, deadlineMs: 0, retryWaitMs: -1 });
  const rows = await empty.query<Record<string, unknown>>(
    `select id, lane, workload_class, priority, deadline_ms, deadline_outcome, is_repair,
            schema_mode, retry_wait_ms, requeue_ms
     from ai_task_runs where id = any($1::uuid[])`,
    [[full, remote, unknown]]
  );
  const byId = new Map(rows.rows.map(({ id, ...row }) => [id as string, row]));
  assert.deepEqual(byId.get(full), {
    lane: "local",
    workload_class: "decide",
    priority: 2,
    deadline_ms: 10_000,
    deadline_outcome: "met",
    is_repair: false,
    schema_mode: "none",
    retry_wait_ms: 0,
    requeue_ms: 0
  });
  assert.deepEqual(byId.get(remote), {
    lane: "remote:00000000-0000-4000-8000-000000000001",
    workload_class: "write-fast",
    priority: 0,
    deadline_ms: 120_000,
    deadline_outcome: "aborted",
    is_repair: true,
    schema_mode: "json",
    retry_wait_ms: 812,
    requeue_ms: 2_501
  });
  assert.deepEqual(byId.get(unknown), {
    lane: null,
    workload_class: null,
    priority: null,
    deadline_ms: null,
    deadline_outcome: null,
    is_repair: false,
    schema_mode: null,
    retry_wait_ms: null,
    requeue_ms: null
  });

  // 4. The constraints refuse values outside the vocabulary.
  const refused: string[] = [];
  for (const [column, value] of [
    ["lane", "cloud"],
    ["lane", "remote:"],
    ["workload_class", "think"],
    ["priority", "4"],
    ["deadline_ms", "0"],
    ["deadline_outcome", "late"],
    ["schema_mode", "xml"],
    ["retry_wait_ms", "-1"],
    ["requeue_ms", "-5"]
  ] as const) {
    await empty
      .query(
        `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, ${column})
         values ('reranking', 'p', 'm', 'remote', 1, 'succeeded', $1)`,
        [value]
      )
      .then(
        () => assert.fail(`${column} = ${value} was accepted`),
        (error: { code?: string }) => {
          assert.equal(error.code, "23514", `${column} = ${value} violates a check`);
          refused.push(`${column}=${value}`);
        }
      );
  }

  // 5. The soak report's query (a time window per class) can use the index.
  const client = await empty.connect();
  let plan: string;
  try {
    await client.query("begin");
    await client.query("set local enable_seqscan = off");
    const explained = await client.query<{ "QUERY PLAN": string }>(
      `explain select count(*) from ai_task_runs
       where started_at >= now() - interval '1 day' and workload_class = 'decide'`
    );
    plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
    await client.query("rollback");
  } finally {
    client.release();
  }
  assert.match(plan, /ai_task_runs_started_class_idx/u, "the index serves the soak query");

  console.info(
    JSON.stringify({
      verified: [
        "history database: only 0057 ran; the earlier row kept its values and reads unknown",
        "empty database: the baseline seed carries 0057",
        "columns, types, nullability and the is_repair default",
        "six check constraints refuse values outside the vocabulary",
        "index (started_at, workload_class), used by the soak query",
        "recordTaskRun stores, rounds and nulls the scheduler's fields"
      ],
      migrations: journal.entries.length,
      migrationMs,
      refused
    })
  );
} finally {
  for (const pool of pools.reverse()) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
