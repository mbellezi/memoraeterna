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
import { createJobActivityRepository, jobActivityChangedIdsMax } from "./jobActivityRepository.js";
import { createJobRepository } from "./jobRepository.js";
import type { Queryable } from "./types.js";

class ScriptedQueryable implements Queryable {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly scripted: QueryResultRow[][]) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, values });
    const rows = (this.scripted.shift() ?? []) as T[];
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
  }
}

describe("the job activity read", () => {
  it("reads the cursor first and counts every lane and state, zero where there is no job", async () => {
    const db = new ScriptedQueryable([
      [{ cursor: "2026-10-23 10:00:00.5+00" }],
      [
        { lane: "heavy", status: "running", count: 2 },
        { lane: "light", status: "queued", count: 40 },
        { lane: "light", status: "blocked", count: 3 },
        { lane: "light", status: "failed", count: 1 }
      ]
    ]);

    const activity = await createJobActivityRepository(db).read();

    expect(db.queries[0]?.text).toContain("clock_timestamp()");
    // A queued job a blocker set aside is counted apart (D5): it is not queued work.
    expect(db.queries[1]?.text).toContain("blocked_class is not null then 'blocked'");
    expect(activity.cursor).toBe("2026-10-23 10:00:00.5+00");
    expect(activity.counts).toEqual({
      heavy: { queued: 0, blocked: 0, running: 2, succeeded: 0, failed: 0, canceled: 0 },
      light: { queued: 40, blocked: 3, running: 0, succeeded: 0, failed: 1, canceled: 0 }
    });
    // The first read has no cursor to compare with, so it names no job and asks for none.
    expect(activity.changedIds).toEqual([]);
    expect(activity.changedIdsTruncated).toBe(false);
    expect(db.queries).toHaveLength(2);
  });

  it("names the jobs touched since the previous cursor, one more than the limit to tell it was cut", async () => {
    const rows = Array.from({ length: jobActivityChangedIdsMax + 1 }, (_, n) => ({
      id: `job-${n}`
    }));
    const db = new ScriptedQueryable([[{ cursor: "c2" }], [], rows]);

    const activity = await createJobActivityRepository(db).read({ since: "c1" });

    const changed = db.queries.find((query) => query.text.includes("updated_at"));
    expect(changed?.values).toEqual(["c1", jobActivityChangedIdsMax + 1]);
    expect(changed?.text).toContain("order by updated_at desc");
    expect(activity.changedIds).toHaveLength(jobActivityChangedIdsMax);
    expect(activity.changedIdsTruncated).toBe(true);
  });

  it("fails loudly when the database returns no clock", async () => {
    await expect(createJobActivityRepository(new ScriptedQueryable([[]])).read()).rejects.toThrow(
      "job_activity_clock_unavailable"
    );
  });
});

const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("the job activity read on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-job-activity-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_job_activity",
      user: "memora_job_activity",
      password: `job-activity-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
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

  it("counts by lane and state, a blocked queued job apart", async () => {
    const jobs = createJobRepository(db());
    await jobs.create({ type: "ingestion" });
    await jobs.create({ type: "ingestion" });
    await jobs.create({ type: "topic-place", lane: "light" });
    const running = await jobs.create({ type: "topic-sweep", lane: "light" });
    await jobs.update(running.id, { status: "running" });
    const failed = await jobs.create({ type: "topic-sweep", lane: "light" });
    await jobs.update(failed.id, { status: "failed" });
    const held = await jobs.create({ type: "topic-name", lane: "light" });
    await jobs.markBlocked({ ids: [held.id] }, { class: "paused", reason: "user_pause" });

    const activity = await createJobActivityRepository(db()).read();

    expect(activity.counts).toEqual({
      heavy: { queued: 2, blocked: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 },
      light: { queued: 1, blocked: 1, running: 1, succeeded: 0, failed: 1, canceled: 0 }
    });
  });

  it("names the jobs changed since the cursor and not the ones that rest", async () => {
    const jobs = createJobRepository(db());
    const rest = await jobs.create({ type: "ingestion" });
    const repository = createJobActivityRepository(db());
    const first = await repository.read();
    // The overlap of one second would still name `rest` right after its write, so age it.
    await db().query("update jobs set updated_at = now() - interval '1 hour' where id = $1", [
      rest.id
    ]);
    const moved = await jobs.create({ type: "ingestion" });
    await jobs.update(moved.id, { status: "running" });

    const second = await repository.read({ since: first.cursor });

    expect(second.changedIds).toEqual([moved.id]);
    expect(second.changedIdsTruncated).toBe(false);
    expect(second.cursor).not.toBe(first.cursor);
  });

  it("cuts at the limit and says so", async () => {
    const jobs = createJobRepository(db());
    const repository = createJobActivityRepository(db());
    const first = await repository.read();
    for (let n = 0; n < 5; n += 1) await jobs.create({ type: "ingestion" });

    const second = await repository.read({ since: first.cursor, limit: 3 });

    expect(second.changedIds).toHaveLength(3);
    expect(second.changedIdsTruncated).toBe(true);
  });
});
