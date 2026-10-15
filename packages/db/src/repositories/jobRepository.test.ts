import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { QueryResult, QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  createJobRepository,
  defaultJobDebounce,
  jobDedupeKeyMaxLength,
  type EnqueueDedupedInput
} from "./jobRepository.js";
import type { Queryable } from "./types.js";

class FakeQueryable implements Queryable {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly rows: QueryResultRow[][] = []) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, values });
    const rows = (this.rows.shift() ?? []) as T[];
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
  }
}

const jobRow = (overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  type: "topic-place",
  status: "queued",
  priority: 0,
  payload: {},
  result: null,
  error: null,
  progress: 0,
  attempts: 0,
  maxAttempts: 3,
  runAfter: new Date("2026-10-15T10:00:10Z"),
  lockedAt: null,
  lockedBy: null,
  finishedAt: null,
  cancelRequestedAt: null,
  lane: "light",
  dedupeKey: "topic-place:tree:root",
  createdAt: new Date("2026-10-15T10:00:00Z"),
  updatedAt: new Date("2026-10-15T10:00:00Z"),
  ...overrides
});

const deduped = (overrides: Partial<EnqueueDedupedInput> = {}): EnqueueDedupedInput => ({
  type: "topic-place",
  lane: "light",
  dedupeKey: "topic-place:tree:root",
  payload: { sourceItemId: "root" },
  ...overrides
});

describe("job lanes and dedupe keys", () => {
  it("debounces deduped jobs by 10 s and never past 60 s after the first request", () => {
    expect(defaultJobDebounce).toEqual({ delayMs: 10_000, maxDelayMs: 60_000 });
    expect(Object.isFrozen(defaultJobDebounce)).toBe(true);
    expect(jobDedupeKeyMaxLength).toBe(200);
  });

  it("claims one lane and type set, and drops the claimed job's dedupe key", async () => {
    const db = new FakeQueryable([[jobRow({ status: "running", dedupeKey: null })]]);
    const job = await createJobRepository(db).claimNext(
      "worker:light-compute",
      ["topic-place", "topic-sweep"],
      "light"
    );
    expect(job).toMatchObject({ lane: "light", dedupeKey: null, status: "running" });
    const [query] = db.queries;
    expect(query?.text).toContain("and lane = $2 and type = any($3::text[])");
    expect(query?.text).toContain("order by priority desc, run_after asc");
    expect(query?.text).toContain("dedupe_key = null");
    expect(query?.values).toEqual([
      "worker:light-compute",
      "light",
      ["topic-place", "topic-sweep"]
    ]);
  });

  it("claims any lane and type when the caller names neither", async () => {
    const db = new FakeQueryable();
    await expect(createJobRepository(db).claimNext("verifier")).resolves.toBeNull();
    expect(db.queries[0]?.text).not.toContain("lane =");
    expect(db.queries[0]?.text).not.toContain("type = any");
    expect(db.queries[0]?.values).toEqual(["verifier"]);
  });

  it("merges a request into the queued job of its key in one insert-or-update", async () => {
    const db = new FakeQueryable([[{ ...jobRow(), created: false }]]);
    const result = await createJobRepository(db).enqueueDeduped(
      deduped({ debounce: { delayMs: 2_500, maxDelayMs: 30_000 } })
    );
    expect(result).toMatchObject({ created: false, job: { id: "job-1", lane: "light" } });
    const [query] = db.queries;
    expect(query?.text).toContain(
      "on conflict (dedupe_key) where dedupe_key is not null and status = 'queued'"
    );
    expect(query?.text).toContain("greatest(");
    expect(query?.values).toEqual([
      "topic-place",
      "light",
      "topic-place:tree:root",
      0,
      { sourceItemId: "root" },
      3,
      2.5,
      30
    ]);
  });

  it("refuses a key that is queued for another type or lane", async () => {
    const db = new FakeQueryable([[]]);
    await expect(createJobRepository(db).enqueueDeduped(deduped())).rejects.toThrow(
      "job_dedupe_key_conflict"
    );
  });

  it.each([
    ["an empty key", deduped({ dedupeKey: "" }), "job_dedupe_key_invalid"],
    [
      "a key over 200 code points",
      deduped({ dedupeKey: "k".repeat(201) }),
      "job_dedupe_key_invalid"
    ],
    ["an unknown lane", deduped({ lane: "medium" as never }), "job_lane_invalid"],
    [
      "a negative delay",
      deduped({ debounce: { delayMs: -1, maxDelayMs: 0 } }),
      "job_debounce_invalid"
    ],
    [
      "a cap below the delay",
      deduped({ debounce: { delayMs: 20_000, maxDelayMs: 10_000 } }),
      "job_debounce_invalid"
    ]
  ])("refuses %s before touching the database", async (_name, input, message) => {
    const db = new FakeQueryable();
    await expect(createJobRepository(db).enqueueDeduped(input)).rejects.toThrow(message);
    expect(db.queries).toEqual([]);
  });

  it("counts a key's length in code points, like the database check", async () => {
    const db = new FakeQueryable([[{ ...jobRow(), created: true }]]);
    await expect(
      createJobRepository(db).enqueueDeduped(deduped({ dedupeKey: "😀".repeat(200) }))
    ).resolves.toMatchObject({ created: true });
  });

  it("queues a retried job without its key, so it never collides with a newer request", async () => {
    const db = new FakeQueryable([[jobRow({ dedupeKey: null })]]);
    await createJobRepository(db).retry("job-1");
    expect(db.queries[0]?.text).toContain("dedupe_key = null");
  });

  it("lists the queued and running jobs of a batch by its runs and by the job payload", async () => {
    const db = new FakeQueryable([[{ id: "job-1" }, { id: "job-2" }]]);
    await expect(createJobRepository(db).activeIdsForBatch("batch-1")).resolves.toEqual([
      "job-1",
      "job-2"
    ]);
    const [query] = db.queries;
    expect(query?.text).toContain("r.batch_id = $1 or j.payload->>'batchId' = $1::text");
    expect(query?.text).toContain("j.status in ('queued', 'running')");
    expect(query?.values).toEqual(["batch-1"]);
  });
});

const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("job lanes on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;
  const seconds = async (id: string, expression: string) =>
    Number(
      (
        await db().query<{ value: string }>(
          `select extract(epoch from ${expression})::text as value from jobs where id = $1`,
          [id]
        )
      ).rows[0]?.value
    );

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-job-lanes-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_job_lanes",
      user: "memora_job_lanes",
      password: `job-lanes-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 20 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db().query("delete from jobs");
  });

  it("leaves one queued job after 100 concurrent requests for one key", async () => {
    const jobs = createJobRepository(db());
    const results = await Promise.all(
      Array.from({ length: 100 }, () => jobs.enqueueDeduped(deduped()))
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
    const rows = await db().query("select status from jobs where dedupe_key = $1", [
      "topic-place:tree:root"
    ]);
    expect(rows.rows).toEqual([{ status: "queued" }]);
  });

  it("only moves a queued job's start forward, up to the cap after its first request", async () => {
    const jobs = createJobRepository(db());
    const { job } = await jobs.enqueueDeduped(deduped());
    expect(await seconds(job.id, "run_after - created_at")).toBe(10);
    // A request with no delay never pulls the start earlier.
    await jobs.enqueueDeduped(deduped({ debounce: { delayMs: 0, maxDelayMs: 60_000 } }));
    expect(await seconds(job.id, "run_after - created_at")).toBe(10);
    // A later request pushes it.
    await jobs.enqueueDeduped(deduped({ debounce: { delayMs: 30_000, maxDelayMs: 60_000 } }));
    expect(await seconds(job.id, "run_after - created_at")).toBeGreaterThanOrEqual(30);
    // ... but never beyond the cap after the first request.
    await db().query(
      `update jobs set created_at = now() - interval '55 seconds', run_after = now() + interval '1 second'
        where id = $1`,
      [job.id]
    );
    await jobs.enqueueDeduped(deduped({ debounce: { delayMs: 30_000, maxDelayMs: 60_000 } }));
    expect(await seconds(job.id, "run_after - created_at")).toBe(60);
    // A start already beyond the cap (a retry backoff) is kept, not pulled back to it.
    await db().query(
      `update jobs set created_at = now() - interval '120 seconds', run_after = now() + interval '20 seconds'
        where id = $1`,
      [job.id]
    );
    await jobs.enqueueDeduped(deduped());
    expect(await seconds(job.id, "run_after - created_at")).toBe(140);
    expect((await jobs.findById(job.id))?.status).toBe("queued");
  });

  it("never lets a running job absorb a new request", async () => {
    const jobs = createJobRepository(db());
    const first = await jobs.enqueueDeduped(deduped({ debounce: { delayMs: 0, maxDelayMs: 0 } }));
    const claimed = await jobs.claimNext("light-compute", ["topic-place"], "light");
    expect(claimed).toMatchObject({ id: first.job.id, status: "running", dedupeKey: null });
    const second = await jobs.enqueueDeduped(deduped());
    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
    const rows = await db().query<{ status: string; dedupe_key: string | null }>(
      "select status, dedupe_key from jobs order by created_at, status"
    );
    expect(rows.rows).toEqual([
      { status: "running", dedupe_key: null },
      { status: "queued", dedupe_key: "topic-place:tree:root" }
    ]);
  });

  it("claims by lane and type, so no lane takes another lane's work", async () => {
    const jobs = createJobRepository(db());
    const heavy = await jobs.create({ type: "ingestion", priority: 100 });
    const light = await jobs.create({ type: "topic-place", lane: "light" });
    expect(heavy.lane).toBe("heavy");
    expect(await jobs.claimNext("light-model", ["topic-gate"], "light")).toBeNull();
    expect((await jobs.claimNext("light-compute", ["topic-place"], "light"))?.id).toBe(light.id);
    expect(await jobs.claimNext("heavy", ["topic-place"], "heavy")).toBeNull();
    expect((await jobs.claimNext("heavy", ["ingestion"], "heavy"))?.id).toBe(heavy.id);
  });

  it("requeues interrupted and retried jobs next to a newer queued job of their key", async () => {
    const jobs = createJobRepository(db());
    const now = { debounce: { delayMs: 0, maxDelayMs: 0 } };
    const interrupted = await jobs.enqueueDeduped(deduped(now));
    await jobs.claimNext("light-compute", ["topic-place"], "light");
    const newer = await jobs.enqueueDeduped(deduped(now));
    expect(await jobs.recoverInterrupted()).toBe(1);
    expect(await jobs.findById(interrupted.job.id)).toMatchObject({
      status: "queued",
      dedupeKey: null
    });
    const canceled = await jobs.requestCancel(newer.job.id);
    expect(canceled).toMatchObject({ status: "canceled" });
    const latest = await jobs.enqueueDeduped(deduped(now));
    expect(latest.created).toBe(true);
    expect(await jobs.retry(newer.job.id)).toMatchObject({ status: "queued", dedupeKey: null });
    const keyed = await db().query(
      "select id from jobs where status = 'queued' and dedupe_key is not null"
    );
    expect(keyed.rows).toEqual([{ id: latest.job.id }]);
  });

  it("refuses to merge a request into a queued job of another type", async () => {
    const jobs = createJobRepository(db());
    const { job } = await jobs.enqueueDeduped(deduped());
    await expect(jobs.enqueueDeduped(deduped({ type: "topic-gate" }))).rejects.toThrow(
      "job_dedupe_key_conflict"
    );
    expect(await jobs.findById(job.id)).toMatchObject({
      type: "topic-place",
      runAfter: job.runAfter
    });
  });

  it("lists only the queued and running jobs of the batch that a payload names", async () => {
    const jobs = createJobRepository(db());
    const [batchA, batchB, batchC] = [randomUUID(), randomUUID(), randomUUID()];
    const queued = await jobs.create({ type: "ingestion", payload: { batchId: batchA } });
    const running = await jobs.create({ type: "chunking", payload: { batchId: batchA } });
    await db().query("update jobs set status = 'running' where id = $1", [running.id]);
    const done = await jobs.create({ type: "embedding", payload: { batchId: batchA } });
    await db().query("update jobs set status = 'succeeded' where id = $1", [done.id]);
    await jobs.create({ type: "ingestion", payload: { batchId: batchB } });
    expect((await jobs.activeIdsForBatch(batchA)).sort()).toEqual([queued.id, running.id].sort());
    expect(await jobs.activeIdsForBatch(batchC)).toEqual([]);
  });

  it("enforces the lane and key checks in the database", async () => {
    await expect(
      db().query("insert into jobs (type, lane) values ('x', 'medium')")
    ).rejects.toMatchObject({ code: "23514", constraint: "jobs_lane" });
    await expect(
      db().query("insert into jobs (type, dedupe_key) values ('x', '')")
    ).rejects.toMatchObject({ code: "23514", constraint: "jobs_dedupe_key" });
    await expect(
      db().query("insert into jobs (type, dedupe_key) values ('x', repeat('k', 201))")
    ).rejects.toMatchObject({ code: "23514", constraint: "jobs_dedupe_key" });
  });
});
