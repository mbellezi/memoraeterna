import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  closePgPool,
  createJobRepository,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool,
  type Queryable
} from "@app/db";

import { JobSupervisor } from "./job-supervisor.js";

/**
 * Real-database proof of the job lanes (migration 0051_job_lanes): applied as a pending migration
 * on a database with jobs and through the baseline seed; columns, defaults, checks and indexes on
 * both; the light claim's plan; 100 concurrent requests for one key; and the light lane's
 * enqueue-to-done latency while a 2 s heavy job, or a light model job holding a fake AI slot for
 * 2 s, is running. It starts its own temporary PostgreSQL sidecar and touches no other database.
 *
 *   npx tsx apps/desktop/src/main/services/verify-job-lanes.ts
 */
const workspace = resolve(import.meta.dirname, "../../../../..");
const packageRoot = join(workspace, "packages/db");
const migrationsFolder = join(packageRoot, "drizzle");
const seedFolder = join(packageRoot, "seed");
const target = "0051_job_lanes";
const runs = 20;
const latencyBarMs = 100;

const workDir = await mkdtemp(join(tmpdir(), "memora-job-lanes-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_job_lanes",
  user: "memora_job_lanes",
  password: `job-lanes-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
const pools: PgPool[] = [];
const report: Record<string, unknown> = {};

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const round = (value: number) => Math.round(value * 100) / 100;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Columns, checks and indexes of `jobs`, comparable across databases. */
async function jobsShape(pool: PgPool) {
  const columns = await pool.query<{
    column_name: string;
    data_type: string;
    nullable: string;
    def: string | null;
  }>(
    `select column_name, data_type, is_nullable as nullable, column_default as def
       from information_schema.columns
      where table_name = 'jobs' and column_name in ('lane', 'dedupe_key') order by column_name`
  );
  const checks = await pool.query<{ conname: string; def: string }>(
    `select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'jobs'::regclass and contype = 'c' order by conname`
  );
  const indexes = await pool.query<{ indexname: string; indexdef: string }>(
    "select indexname, indexdef from pg_indexes where tablename = 'jobs' order by indexname"
  );
  return { columns: columns.rows, checks: checks.rows, indexes: indexes.rows };
}

/** Runs EXPLAIN on the exact SQL a repository call sends, without executing it. */
async function explainCall(
  pool: PgPool,
  call: (db: Queryable) => Promise<unknown>,
  analyze = false
): Promise<{ indexes: string[]; nodes: string[]; ms: number | null; plan: unknown }> {
  let captured: { text: string; values: readonly unknown[] } | null = null;
  const recorder = {
    query: async (text: string, values: readonly unknown[] = []) => {
      captured = { text, values };
      return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
    }
  } as unknown as Queryable;
  await call(recorder);
  assert.ok(captured, "the call sent a query");
  const { text, values } = captured as { text: string; values: readonly unknown[] };
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<{ "QUERY PLAN": unknown }>(
      `explain (format json${analyze ? ", analyze, buffers" : ""}) ${text}`,
      [...values]
    );
    await client.query("rollback");
    const plan = (result.rows[0]!["QUERY PLAN"] as Array<Record<string, unknown>>)[0]!;
    const indexes: string[] = [];
    const nodes: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      nodes.push(String(node["Node Type"]));
      if (typeof node["Index Name"] === "string") indexes.push(node["Index Name"]);
      for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? [])
        walk(child);
    };
    walk(plan.Plan as Record<string, unknown>);
    return {
      indexes,
      nodes,
      ms: typeof plan["Execution Time"] === "number" ? round(plan["Execution Time"]) : null,
      plan: plan.Plan
    };
  } finally {
    client.release();
  }
}

try {
  const connection = await manager.start();
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const tags: string[] = journal.entries.map((entry: { tag: string }) => entry.tag);
  const index = tags.indexOf(target);
  assert.ok(index > 0, `${target} is in the journal`);

  // 1. Pending path: a database migrated up to 0050 with jobs in every status gets 0051.
  const before = join(workDir, "drizzle-before");
  await cp(migrationsFolder, before, { recursive: true });
  await writeFile(
    join(before, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) })
  );
  const db = createPgPool({ connectionString: connection.connectionString, max: 24 });
  pools.push(db);
  await runMigrations(db, before);
  const statuses = ["queued", "running", "succeeded", "failed", "canceled"];
  for (const status of statuses)
    await db.query(`insert into jobs (type, status, payload) values ('ingestion', $1, '{}')`, [
      status
    ]);
  await runMigrations(db, migrationsFolder);
  const history = await db.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  assert.equal(Number(history.rows[0]!.count), tags.length, "applied as a pending migration");
  const existing = await db.query<{ status: string; lane: string; dedupe_key: string | null }>(
    "select status::text, lane, dedupe_key from jobs order by status"
  );
  assert.equal(existing.rowCount, statuses.length, "existing jobs survive");
  for (const row of existing.rows) {
    assert.equal(row.lane, "heavy", `an existing ${row.status} job is heavy`);
    assert.equal(row.dedupe_key, null, `an existing ${row.status} job has no dedupe key`);
  }
  report.pending = { existingJobs: existing.rowCount, allHeavy: true, history: tags.length };

  // 2. Baseline path: an empty database is seeded with every migration, 0051 included.
  await db.query("create database memora_job_lanes_seed");
  const seededUrl = new URL(connection.connectionString);
  seededUrl.pathname = "/memora_job_lanes_seed";
  const seeded = createPgPool({ connectionString: seededUrl.toString(), max: 2 });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(
    seed.seed.applied && seed.seed.seededMigrations.includes(target),
    "the baseline holds it"
  );

  // 3. Shape: identical on both paths.
  const shape = await jobsShape(db);
  assert.deepEqual(
    await jobsShape(seeded),
    shape,
    "baseline and migration give the same jobs table"
  );
  assert.deepEqual(shape.columns, [
    { column_name: "dedupe_key", data_type: "text", nullable: "YES", def: null },
    { column_name: "lane", data_type: "text", nullable: "NO", def: "'heavy'::text" }
  ]);
  const checks = Object.fromEntries(shape.checks.map((row) => [row.conname, row.def]));
  assert.match(checks.jobs_lane ?? "", /lane = ANY \(ARRAY\['heavy'::text, 'light'::text\]\)/);
  assert.match(
    checks.jobs_dedupe_key ?? "",
    /dedupe_key IS NULL\) OR .*char_length\(dedupe_key\) >= 1.*<= 200/
  );
  const indexes = Object.fromEntries(shape.indexes.map((row) => [row.indexname, row.indexdef]));
  assert.match(
    indexes.jobs_lane_queue_idx ?? "",
    /\(lane, priority DESC, run_after\) WHERE \(status = 'queued'::job_status\)/
  );
  assert.match(
    indexes.jobs_dedupe_queued_uidx ?? "",
    /UNIQUE INDEX .* \(dedupe_key\) WHERE \(\(dedupe_key IS NOT NULL\) AND \(status = 'queued'::job_status\)\)/
  );
  assert.ok(indexes.jobs_queue_idx, "jobs_queue_idx is kept");
  report.shape = {
    columns: shape.columns,
    checks,
    laneIndexes: {
      jobs_lane_queue_idx: indexes.jobs_lane_queue_idx,
      jobs_dedupe_queued_uidx: indexes.jobs_dedupe_queued_uidx
    }
  };

  // 4. 100 concurrent requests for one key leave one queued job.
  const jobs = createJobRepository(db);
  const burst = await Promise.all(
    Array.from({ length: 100 }, (_, n) =>
      jobs.enqueueDeduped({
        type: "verify-light",
        lane: "light",
        dedupeKey: "verify:burst",
        payload: { n }
      })
    )
  );
  const burstRows = await db.query("select id from jobs where dedupe_key = 'verify:burst'");
  assert.equal(burstRows.rowCount, 1, "one queued job per key");
  assert.equal(burst.filter((result) => result.created).length, 1, "one request created it");
  report.concurrentEnqueues = { requests: 100, queuedRows: burstRows.rowCount };
  await db.query("delete from jobs");

  // 5. The light claim reads jobs_lane_queue_idx, on a table the size of a long-lived library.
  await db.query(
    `insert into jobs (type, lane, status, payload, finished_at, created_at, run_after)
     select case when n % 7 = 0 then 'topic-place' else 'ingestion' end,
            case when n % 7 = 0 then 'light' else 'heavy' end,
            (case when n % 13 = 0 then 'failed' else 'succeeded' end)::job_status,
            '{}', now(), now() - make_interval(secs => n), now() - make_interval(secs => n)
       from generate_series(1, 50000) n`
  );
  await db.query(
    `insert into jobs (type, lane, payload, priority, run_after)
     select 'ingestion', 'heavy', '{}', n % 3, now() - make_interval(secs => n) from generate_series(1, 300) n`
  );
  await db.query(
    `insert into jobs (type, lane, payload, run_after)
     select (array['topic-place','topic-sweep','topic-gate','topic-name'])[1 + n % 4], 'light', '{}',
            now() - make_interval(secs => n) from generate_series(1, 40) n`
  );
  await db.query("analyze jobs");
  const lightClaim = (db: Queryable) =>
    createJobRepository(db).claimNext(
      "verify:light-compute",
      ["topic-place", "topic-sweep"],
      "light"
    );
  const heavyClaim = (db: Queryable) =>
    createJobRepository(db).claimNext("verify:heavy", ["ingestion", "embedding"], "heavy");
  const light = await explainCall(db, lightClaim);
  const lightAnalyzed = await explainCall(db, lightClaim, true);
  const heavy = await explainCall(db, heavyClaim);
  const heavyAnalyzed = await explainCall(db, heavyClaim, true);
  assert.ok(
    light.indexes.includes("jobs_lane_queue_idx"),
    `light claim plan: ${light.nodes.join(" > ")}`
  );
  assert.ok(!light.nodes.includes("Sort"), "the light claim reads the index in claim order");
  // Every claim now reads the lane index, but lookups by status still need jobs_queue_idx: the
  // cancellation of a source's queued or running jobs would scan the whole table without it.
  const statusLookup = await explainCall(db, (db) =>
    db.query(
      `select id from jobs where status in ('queued', 'running') and payload->>'sourceItemId' = any($1::text[])`,
      [["verify-source"]]
    )
  );
  assert.ok(statusLookup.indexes.includes("jobs_queue_idx"), "status lookups read jobs_queue_idx");
  report.explain = {
    rows: Number(
      (await db.query<{ n: string }>("select count(*)::text as n from jobs")).rows[0]!.n
    ),
    lightClaim: { indexes: light.indexes, nodes: light.nodes, executionMs: lightAnalyzed.ms },
    heavyClaim: { indexes: heavy.indexes, nodes: heavy.nodes, executionMs: heavyAnalyzed.ms },
    statusLookup: { indexes: statusLookup.indexes, nodes: statusLookup.nodes }
  };
  await db.query("delete from jobs");

  // 6. Light enqueue-to-done while a 2 s heavy job runs, then while a light model job holds the AI slot.
  const executed = new Map<string, () => void>();
  let heavyRunning: (() => void) | null = null;
  let modelRunning: (() => void) | null = null;
  const supervisor = new JobSupervisor({
    getPool: () => db,
    logger: console,
    processRelationLabels: async () => {
      heavyRunning?.();
      await sleep(2_000);
      return { updated: 0 };
    },
    lightJobs: {
      "verify-place": {
        needsModel: false,
        execute: async (job) => {
          executed.get(job.id)?.();
          return { placed: 1 };
        }
      },
      "verify-gate": {
        needsModel: true,
        execute: async () => {
          modelRunning?.();
          await sleep(2_000); // the fake AI slot
          return { gated: 1 };
        }
      }
    }
  });
  const recorded = new Set<() => void>();
  supervisor.subscribe(() => {
    for (const check of recorded) check();
  });
  await supervisor.start();

  /** Enqueues one light compute job and resolves with ms until its success is recorded. */
  const lightTurnaround = async (n: number): Promise<number> => {
    const started = performance.now();
    const { job } = await jobs.enqueueDeduped({
      type: "verify-place",
      lane: "light",
      dedupeKey: `verify-place:${n}`,
      debounce: { delayMs: 0, maxDelayMs: 0 }
    });
    supervisor.wake("light");
    const done = new Promise<void>((resolveDone) => {
      let ran = false;
      executed.set(job.id, () => (ran = true));
      const check = () => {
        if (!ran) return;
        void jobs.findById(job.id).then((row) => {
          if (row?.status === "succeeded" && recorded.delete(check)) resolveDone();
        });
      };
      recorded.add(check);
    });
    await done;
    return performance.now() - started;
  };

  const measure = async (
    label: string,
    hold: () => Promise<void>,
    blocker: () => Promise<string>
  ) => {
    const samples: number[] = [];
    for (let n = 0; n < runs; n++) {
      const running = hold();
      const blockerId = await blocker();
      await running;
      const status = await jobs.findById(blockerId);
      assert.equal(status?.status, "running", `${label}: the blocking job runs during the sample`);
      samples.push(await lightTurnaround(samples.length + (label === "heavy" ? 0 : 1_000)));
      const after = await jobs.findById(blockerId);
      assert.equal(
        after?.status,
        "running",
        `${label}: the blocking job still runs after the sample`
      );
    }
    const result = {
      runs,
      p50Ms: round(percentile(samples, 50)),
      p95Ms: round(percentile(samples, 95)),
      maxMs: round(Math.max(...samples))
    };
    assert.ok(
      result.p95Ms <= latencyBarMs,
      `${label}: p95 ${result.p95Ms} ms > ${latencyBarMs} ms`
    );
    return result;
  };

  report.latencyWithHeavyJob = await measure(
    "heavy",
    () => new Promise<void>((done) => (heavyRunning = done)),
    async () => {
      const job = await jobs.create({ type: "relation-labels", payload: { mode: "missing" } });
      supervisor.wake("heavy");
      return job.id;
    }
  );
  report.latencyWithModelJob = await measure(
    "model",
    () => new Promise<void>((done) => (modelRunning = done)),
    async () => {
      const { job } = await jobs.enqueueDeduped({
        type: "verify-gate",
        lane: "light",
        dedupeKey: `verify-gate:${randomUUID()}`,
        debounce: { delayMs: 0, maxDelayMs: 0 }
      });
      supervisor.wake("light");
      return job.id;
    }
  );

  const stopStarted = performance.now();
  await supervisor.stop();
  report.stopMs = round(performance.now() - stopStarted);
  const leftRunning = await db.query("select id from jobs where status = 'running'");
  assert.equal(leftRunning.rowCount, 0, "stop leaves no job running");

  console.info(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  for (const pool of pools) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
