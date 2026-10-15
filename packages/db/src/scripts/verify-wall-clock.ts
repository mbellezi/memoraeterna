import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAiConfigRepository,
  createIngestionRunRepository,
  createJobRepository,
  createPgPool,
  PostgresSidecarManager,
  type PgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

/**
 * Real-database check of the wall-clock instrumentation: stage attempts and end times on
 * `ingestion_run_stages`, queue wait and retry index on `ai_task_runs`. It starts its own temporary
 * PostgreSQL sidecar under the system temp directory and never connects to an existing database.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-wall-clock-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_wall_clock",
  user: "memora_wall_clock",
  password: `wall-clock-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

interface StageRow {
  status: string;
  attempts: number;
  started_at: Date | null;
  attempt_started_at: Date | null;
  ended_at: Date | null;
  completed_at: Date | null;
}

let pool: PgPool | undefined;
try {
  const connection = await manager.start();
  const db = createPgPool({ connectionString: connection.connectionString, max: 3 });
  pool = db;
  const migrationsFolder = resolve(packageRoot, "drizzle");
  const seedFolder = resolve(packageRoot, "seed");
  await runMigrations(db, migrationsFolder, { seedFolder });

  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const history = await db.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  assert.equal(Number(history.rows[0]?.count), journal.entries.length, "migration history");
  const columns = await db.query<{ table_name: string; column_name: string; data_type: string }>(
    `select table_name, column_name, data_type from information_schema.columns
     where (table_name, column_name) in (
       ('ai_task_runs', 'queue_ms'), ('ai_task_runs', 'attempt'), ('ingestion_run_stages', 'attempts'),
       ('ingestion_run_stages', 'attempt_started_at'), ('ingestion_run_stages', 'ended_at')
     ) order by table_name, column_name`
  );
  assert.deepEqual(
    columns.rows.map((row) => `${row.table_name}.${row.column_name}:${row.data_type}`),
    [
      "ai_task_runs.attempt:integer",
      "ai_task_runs.queue_ms:integer",
      "ingestion_run_stages.attempt_started_at:timestamp with time zone",
      "ingestion_run_stages.attempts:integer",
      "ingestion_run_stages.ended_at:timestamp with time zone"
    ]
  );

  const runs = createIngestionRunRepository(db);
  const jobs = createJobRepository(db);
  const pause = () => db.query("select pg_sleep(0.05)");
  const stage = async (runId: string, name: string): Promise<StageRow> => {
    const result = await db.query<StageRow>(
      `select status, attempts, started_at, attempt_started_at, ended_at, completed_at
       from ingestion_run_stages where ingestion_run_id = $1 and stage = $2`,
      [runId, name]
    );
    const row = result.rows[0];
    assert.ok(row, `stage row ${name}`);
    return row;
  };
  const after = (later: Date | null, earlier: Date | null, label: string) => {
    assert.ok(later && earlier && later > earlier, label);
  };

  // Skipped stages end immediately and never count an attempt.
  const run = await runs.create({});
  await runs.initializeStages(
    run.id,
    ["chunking", "summarization", "embedding"],
    ["chunking", "summarization", "embedding", "knowledgeGraph"]
  );
  const skipped = await stage(run.id, "knowledgeGraph");
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.attempts, 0);
  assert.ok(skipped.ended_at && skipped.completed_at && !skipped.started_at);

  // One attempt: progress updates inside it keep the counters, completion ends it.
  await runs.beginStage(run.id, "chunking");
  const begun = await stage(run.id, "chunking");
  assert.equal(begun.attempts, 1);
  assert.ok(begun.started_at && begun.attempt_started_at && !begun.ended_at);
  await pause();
  await runs.updateStageProgress(run.id, "chunking", 0.5);
  const progressed = await stage(run.id, "chunking");
  assert.equal(progressed.attempts, 1);
  assert.deepEqual(progressed.attempt_started_at, begun.attempt_started_at);
  await pause();
  await runs.completeStage(run.id, "chunking", { chunkCount: 1 });
  const completed = await stage(run.id, "chunking");
  assert.equal(completed.status, "completed");
  assert.equal(completed.attempts, 1);
  after(completed.ended_at, completed.attempt_started_at, "completion ends the attempt");
  assert.deepEqual(completed.ended_at, completed.completed_at);

  // A failed attempt ends at the failure; the retry opens attempt 2 and keeps the first start.
  await runs.beginStage(run.id, "summarization");
  const firstTry = await stage(run.id, "summarization");
  await pause();
  await runs.failStage(run.id, "summarization", "provider_failed");
  const failed = await stage(run.id, "summarization");
  assert.equal(failed.status, "failed");
  after(failed.ended_at, failed.attempt_started_at, "failure ends the attempt");
  assert.equal(failed.completed_at, null);
  await pause();
  await runs.beginStage(run.id, "summarization");
  const retried = await stage(run.id, "summarization");
  assert.equal(retried.attempts, 2);
  assert.deepEqual(retried.started_at, firstTry.started_at);
  after(retried.attempt_started_at, failed.ended_at, "retry starts after the failure");
  assert.equal(retried.ended_at, null);
  await runs.completeStage(run.id, "summarization");

  // A stage that starts through its first progress update gets a start, and waiting ends the attempt.
  assert.equal((await stage(run.id, "embedding")).started_at, null);
  await runs.updateStageProgress(run.id, "embedding", 0);
  const progressStart = await stage(run.id, "embedding");
  assert.equal(progressStart.attempts, 1);
  assert.ok(
    progressStart.started_at && progressStart.attempt_started_at && !progressStart.ended_at
  );
  await runs.waitForBatchStage(run.id, "embedding");
  const waiting = await stage(run.id, "embedding");
  assert.equal(waiting.status, "waiting_for_review");
  assert.ok(waiting.ended_at);
  await pause();
  await runs.updateStageProgress(run.id, "embedding", 0.2);
  const resumed = await stage(run.id, "embedding");
  assert.equal(resumed.attempts, 2);
  assert.equal(resumed.ended_at, null);
  assert.deepEqual(resumed.started_at, progressStart.started_at);
  after(resumed.attempt_started_at, waiting.ended_at, "resumed attempt starts after the wait");

  // Run-level failure ends the open attempt of the current stage.
  await runs.beginStage(run.id, "embedding");
  await runs.fail(run.id, "worker_error");
  const runFailed = await stage(run.id, "embedding");
  assert.equal(runFailed.status, "failed");
  assert.ok(runFailed.ended_at);

  // A crash leaves a running stage row; recovery ends that attempt so the resume opens a new one.
  const interrupted = await runs.create({});
  const interruptedJob = await jobs.create({
    type: "ingestion",
    payload: { ingestionRunId: interrupted.id }
  });
  await runs.update(interrupted.id, { jobId: interruptedJob.id });
  await runs.beginStage(interrupted.id, "knowledgeGraph");
  assert.equal((await jobs.claimNext("wall-clock-worker"))?.id, interruptedJob.id);
  await jobs.recoverInterrupted();
  await runs.recoverInterrupted();
  const crashed = await stage(interrupted.id, "knowledgeGraph");
  assert.ok(crashed.ended_at, "recovery ends the interrupted attempt");
  await runs.startOrResume(interrupted.id);
  await runs.beginStage(interrupted.id, "knowledgeGraph");
  const afterCrash = await stage(interrupted.id, "knowledgeGraph");
  assert.equal(afterCrash.attempts, 2);
  assert.equal(afterCrash.ended_at, null);

  // Canceling ends the open attempt too.
  const canceled = await runs.create({});
  await runs.beginStage(canceled.id, "atomicNotes");
  await runs.cancel(canceled.id);
  const canceledStage = await stage(canceled.id, "atomicNotes");
  assert.equal(canceledStage.status, "canceled");
  assert.ok(canceledStage.ended_at);

  // AI task runs keep queue wait and retry index, and leave them null when unknown.
  const ai = createAiConfigRepository(db);
  const base = {
    taskType: "reranking",
    provider: "verify",
    modelId: "verify-model",
    runtime: "remote",
    durationMs: 25,
    status: "succeeded"
  };
  const measured = await ai.recordTaskRun({ ...base, queueMs: 1_234, attempt: 1 });
  const unknown = await ai.recordTaskRun(base);
  const invalid = await ai.recordTaskRun({ ...base, queueMs: -1, attempt: Number.NaN });
  const audit = await db.query<{ id: string; queue_ms: number | null; attempt: number | null }>(
    "select id, queue_ms, attempt from ai_task_runs where id = any($1::uuid[])",
    [[measured, unknown, invalid]]
  );
  const byId = new Map(audit.rows.map((row) => [row.id, row]));
  assert.deepEqual(
    [byId.get(measured)?.queue_ms, byId.get(measured)?.attempt],
    [1_234, 1],
    "measured values"
  );
  for (const id of [unknown, invalid])
    assert.deepEqual([byId.get(id)?.queue_ms, byId.get(id)?.attempt], [null, null], "unknown");

  // The row is written when the call ends: its start is the end minus the measured duration, to the
  // millisecond, and a call that took no time starts when it ends.
  const instant = await ai.recordTaskRun({ ...base, durationMs: 0 });
  const times = await db.query<{ id: string; measured_ms: number }>(
    `select id, extract(epoch from finished_at - started_at) * 1000 as measured_ms
     from ai_task_runs where id = any($1::uuid[])`,
    [[measured, instant]]
  );
  const measuredMs = new Map(times.rows.map((row) => [row.id, Number(row.measured_ms)]));
  assert.equal(measuredMs.get(measured), 25, "started_at is finished_at minus duration_ms");
  assert.equal(measuredMs.get(instant), 0, "an instant call starts when it ends");

  console.info(
    JSON.stringify({
      verified: [
        "migration history and columns",
        "stage attempts, start and end times through retry, wait, failure, recovery and cancel",
        "ai_task_runs queue_ms and attempt, null when unknown",
        "ai_task_runs started_at is the call's real start, finished_at minus duration_ms"
      ],
      migrations: journal.entries.length
    })
  );
} finally {
  if (pool) await closePgPool(pool);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
