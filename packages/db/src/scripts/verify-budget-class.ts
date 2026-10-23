import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  budgetLedgerStatement,
  closePgPool,
  createAiBudgetRepository,
  createAiConfigRepository,
  createPgPool,
  ledgerFallbackOutputTokens,
  PostgresSidecarManager,
  type PgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

/**
 * Real-database check of migration `0061_ai_budget_class` (F4 D14, T76): on a database with history
 * (every earlier migration applied and AI task runs written before it) only the new migration runs
 * and the old rows read their budget class as unknown; on an empty database the baseline brings the
 * same columns. It checks the columns, types, the constraint, the partial ledger index and that the
 * monthly ledger's statement uses it, that the ledger counts each background row once (the
 * unclassified P2/P3 rows written before 0061 included, cassette replays and other months left
 * out), and that the writer stores the class, the job and the estimate. It starts its own temporary
 * PostgreSQL sidecar and never connects to an existing database.
 */
const migrationName = "0061_ai_budget_class";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-budget-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_budget",
  user: "memora_budget",
  password: `budget-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

interface Journal {
  entries: Array<{ tag: string }>;
}

const expectedColumns = [
  "budget_class:text:YES",
  "budget_estimate_usd:double precision:YES",
  "job_id:uuid:YES"
];

async function budgetColumns(db: PgPool): Promise<string[]> {
  const columns = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
    `select column_name, data_type, is_nullable from information_schema.columns
     where table_name = 'ai_task_runs' and column_name = any($1::text[]) order by column_name`,
    [expectedColumns.map((column) => column.split(":")[0])]
  );
  return columns.rows.map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`);
}

async function verifySchema(db: PgPool, label: string, journal: Journal): Promise<void> {
  const history = await db.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  assert.equal(Number(history.rows[0]?.count), journal.entries.length, `${label}: history`);
  assert.deepEqual(await budgetColumns(db), expectedColumns, `${label}: columns`);
  const check = await db.query<{ definition: string }>(
    `select pg_get_constraintdef(oid) as definition from pg_constraint
     where conrelid = 'ai_task_runs'::regclass and conname = 'ai_task_runs_budget_class'`
  );
  assert.match(check.rows[0]?.definition ?? "", /budget_class/u, `${label}: budget class check`);
  const index = await db.query<{ indexdef: string }>(
    "select indexdef from pg_indexes where indexname = 'ai_task_runs_budget_ledger_idx'"
  );
  const definition = index.rows[0]?.indexdef ?? "";
  assert.match(definition, /USING btree \(started_at\)/u, `${label}: ledger index column`);
  assert.match(definition, /WHERE \(\(lane ~~ 'remote:%'::text\)/u, `${label}: ledger index lane`);
  assert.match(definition, /budget_class = 'background'::text/u, `${label}: ledger index class`);
}

/** Applies every migration before 0061 from a copy of the folder, as a profile from before F4. */
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

const lane = "remote:00000000-0000-4000-8000-0000000000c1";

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

  // 1. A database with history: the earlier migrations and AI task runs written before 0061.
  await admin.query("create database memora_budget_history");
  const history = createPgPool({ connectionString: databaseUrl("memora_budget_history"), max: 3 });
  pools.push(history);
  await migrateBefore(history, journal);
  assert.deepEqual(await budgetColumns(history), [], "no budget columns before 0061");
  // Written as the F3 writer wrote them (the current writer needs the 0061 columns).
  const old = async (priority: number | null, values: { lane?: string; tokens?: boolean } = {}) =>
    (
      await history.query<{ id: string }>(
        `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status,
           finished_at, lane, priority, input_tokens, output_tokens, parameters)
         values ('summarization', 'openai-compatible', 'gpt-5', 'remote', 1000, 'succeeded', now(),
           $1, $2, $3, $4, '{"maxTokens": 2000}'::jsonb)
         returning id`,
        [
          values.lane ?? lane,
          priority,
          values.tokens === false ? null : 1_000,
          values.tokens === false ? null : 500
        ]
      )
    ).rows[0]!.id;
  const oldBackground = await old(3);
  const oldIngestion = await old(2);
  const oldInteractive = await old(0);
  const oldLocal = await old(2, { lane: "local" });
  const oldUnknownUsage = await old(3, { tokens: false });
  const beforeCount = await history.query<{ count: string }>(
    "select count(*)::text as count from ai_task_runs"
  );
  const started = performance.now();
  await runMigrations(history, migrationsFolder, { seedFolder });
  const migrationMs = Math.round(performance.now() - started);
  await verifySchema(history, "history", journal);
  const kept = await history.query<{
    id: string;
    budget_class: string | null;
    job_id: string | null;
  }>(`select id, budget_class, job_id from ai_task_runs where id = any($1::uuid[]) order by id`, [
    [oldBackground, oldIngestion, oldInteractive, oldLocal, oldUnknownUsage]
  ]);
  assert.equal(kept.rows.length, 5, "the rows written before 0061 are kept");
  assert.ok(
    kept.rows.every((row) => row.budget_class === null && row.job_id === null),
    "a row written before 0061 reads its budget class and job as unknown"
  );
  const afterCount = await history.query<{ count: string }>(
    "select count(*)::text as count from ai_task_runs"
  );
  assert.equal(afterCount.rows[0]?.count, beforeCount.rows[0]?.count, "no row added or lost");

  // 2. The ledger: background rows and the unclassified P2/P3 remote rows, each counted once.
  const ai = createAiConfigRepository(history);
  const jobId = randomUUID();
  const base = {
    taskType: "summarization",
    provider: "openai-compatible",
    modelId: "gpt-5",
    runtime: "remote",
    durationMs: 1_000,
    status: "succeeded",
    lane
  };
  const background = await ai.recordTaskRun({
    ...base,
    priority: 3,
    budgetClass: "background",
    jobId,
    budgetEstimateUsd: 0.25,
    inputTokens: 2_000,
    outputTokens: 1_000
  });
  const backgroundNoUsage = await ai.recordTaskRun({
    ...base,
    status: "failed",
    priority: 3,
    budgetClass: "background",
    budgetEstimateUsd: 0.5
  });
  // Not in the ledger: user-started and interactive work, and a cassette replay (it spent nothing).
  await ai.recordTaskRun({
    ...base,
    priority: 2,
    budgetClass: "user",
    inputTokens: 9e6,
    outputTokens: 9e6
  });
  await ai.recordTaskRun({
    ...base,
    priority: 0,
    budgetClass: "interactive",
    inputTokens: 9e6,
    outputTokens: 9e6
  });
  await ai.recordTaskRun({
    ...base,
    adapter: "cassette-replay",
    priority: 3,
    budgetClass: "background",
    inputTokens: 9e6,
    outputTokens: 9e6
  });
  // A background call of last month is outside the window.
  const lastMonth = await ai.recordTaskRun({
    ...base,
    priority: 3,
    budgetClass: "background",
    inputTokens: 9e6,
    outputTokens: 9e6
  });
  await history.query(
    "update ai_task_runs set started_at = started_at - interval '40 days' where id = $1",
    [lastMonth]
  );
  const stored = await history.query<{
    budget_class: string;
    job_id: string | null;
    budget_estimate_usd: number | null;
  }>(
    "select budget_class, job_id, budget_estimate_usd from ai_task_runs where id = any($1::uuid[]) order by budget_estimate_usd",
    [[background, backgroundNoUsage]]
  );
  assert.deepEqual(
    stored.rows,
    [
      { budget_class: "background", job_id: jobId, budget_estimate_usd: 0.25 },
      { budget_class: "background", job_id: null, budget_estimate_usd: 0.5 }
    ],
    "the writer stores the class, the job and the estimate"
  );
  const now = new Date();
  const window = {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 1)
  };
  const ledger = await createAiBudgetRepository(history).monthLedger(window);
  assert.deepEqual(
    ledger,
    [
      {
        provider: "openai-compatible",
        modelId: "gpt-5",
        // background (2), the old P3 and P2 rows with usage, the old P3 row without usage
        calls: 5,
        inputTokens: 2_000 + 1_000 + 1_000,
        outputTokens: 1_000 + 500 + 500,
        estimatedCalls: 1,
        estimateUsd: 0.5,
        unestimatedCalls: 1,
        unestimatedInputTokens: 0,
        unestimatedOutputTokens: 2_000
      }
    ],
    "the ledger counts each background row once, old unclassified P2/P3 rows included"
  );
  assert.ok(
    ledgerFallbackOutputTokens > 0,
    "a row with no budget priced at no output is never zero"
  );

  // 3. The ledger statement uses the partial index.
  const client = await history.connect();
  let plan: string;
  try {
    await client.query("begin");
    await client.query("set local enable_seqscan = off");
    const explained = await client.query<{ "QUERY PLAN": string }>(
      `explain ${budgetLedgerStatement}`,
      [window.start, window.end]
    );
    plan = explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
    await client.query("rollback");
  } finally {
    client.release();
  }
  assert.match(plan, /ai_task_runs_budget_ledger_idx/u, "the ledger statement uses its index");

  // 4. An empty database: the baseline seed carries 0061.
  await admin.query("create database memora_budget_empty");
  const empty = createPgPool({ connectionString: databaseUrl("memora_budget_empty"), max: 3 });
  pools.push(empty);
  const seeded = await runMigrations(empty, migrationsFolder, { seedFolder });
  assert.ok(seeded.seed.applied, "the baseline seed was applied");
  await verifySchema(empty, "empty", journal);

  // 5. The constraint refuses values outside the vocabulary; the writer drops a non-UUID job id.
  const refused: string[] = [];
  for (const [column, value] of [
    ["budget_class", "system"],
    ["budget_class", "Background"],
    ["budget_estimate_usd", "-0.01"]
  ] as const) {
    await empty
      .query(
        `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, ${column})
         values ('summarization', 'p', 'm', 'remote', 1, 'succeeded', $1)`,
        [value]
      )
      .then(
        () => assert.fail(`${column} = ${value} was accepted`),
        (error: { code?: string }) => {
          assert.equal(error.code, "23514", `${column} = ${value} violates the check`);
          refused.push(`${column}=${value}`);
        }
      );
  }
  const labelled = await createAiConfigRepository(empty).recordTaskRun({
    ...base,
    jobId: "not-a-uuid",
    budgetEstimateUsd: Number.NaN
  });
  const dropped = await empty.query<{ job_id: string | null; budget_estimate_usd: number | null }>(
    "select job_id, budget_estimate_usd from ai_task_runs where id = $1",
    [labelled]
  );
  assert.deepEqual(
    dropped.rows[0],
    { job_id: null, budget_estimate_usd: null },
    "the writer stores unknown for a non-UUID job id and a non-finite estimate"
  );

  console.info(
    JSON.stringify({
      verified: [
        "history database: only 0061 ran; the earlier rows kept and read the budget class as unknown",
        "empty database: the baseline seed carries 0061",
        "columns, types and nullability; the budget class check refuses other values",
        "partial index on started_at for background remote rows, used by the ledger statement",
        "the ledger counts each background row once, old P2/P3 rows included, replays and other months out",
        "recordTaskRun stores the class, the job and the estimate, and unknown for invalid values"
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
