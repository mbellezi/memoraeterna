import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createJobBlockerRepository } from "./jobBlockerRepository.js";
import { createJobRepository } from "./jobRepository.js";

const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

// The blocker writes of T75 on a real database. The columns come from migration 0060 (T74); before
// it is in the branch, the test adds them itself (a no-op once the migration made them).
describe.skipIf(!sidecarInstalled)("job blockers on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;

  const insert = async (input: {
    type: string;
    status?: "queued" | "running" | "succeeded";
    blocked?: [string, string];
    runAfterSeconds?: number;
    dedupeKey?: string;
    attempts?: number;
  }) => {
    const result = await db().query<{ id: string }>(
      `insert into jobs (type, status, lane, payload, blocked_class, blocked_reason, blocked_at,
                         run_after, dedupe_key, attempts)
       values ($1, $2, 'light', '{}', $3, $4, case when $3::text is null then null else now() end,
               now() + make_interval(secs => $5), $6, $7)
       returning id`,
      [
        input.type,
        input.status ?? "queued",
        input.blocked?.[0] ?? null,
        input.blocked?.[1] ?? null,
        input.runAfterSeconds ?? 0,
        input.dedupeKey ?? null,
        input.attempts ?? 0
      ]
    );
    return result.rows[0]!.id;
  };
  const row = async (id: string) =>
    (
      await db().query<{
        status: string;
        blocked_class: string | null;
        blocked_reason: string | null;
        blocked_at: Date | null;
        attempts: number;
        dedupe_key: string | null;
        due: boolean;
      }>(
        `select status, blocked_class, blocked_reason, blocked_at, attempts, dedupe_key,
                run_after <= now() as due
         from jobs where id = $1`,
        [id]
      )
    ).rows[0]!;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-job-blockers-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_job_blockers",
      user: "memora_job_blockers",
      password: `job-blockers-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    await pool.query(
      `alter table jobs
         add column if not exists blocked_class text,
         add column if not exists blocked_reason text,
         add column if not exists blocked_at timestamptz`
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db().query("delete from jobs");
  });

  it("stamps the queued rows of a held type, never a running row or a per-task blocker", async () => {
    const blockers = createJobBlockerRepository(db());
    const queued = await insert({ type: "topic-name" });
    const running = await insert({ type: "topic-name", status: "running" });
    const perTask = await insert({ type: "topic-name", blocked: ["download", "model_loading"] });
    const otherGate = await insert({
      type: "topic-name",
      blocked: ["paused", "only_idle_user_active"]
    });
    const otherType = await insert({ type: "topic-place" });
    const stamped = await blockers.stampGateBlocks(
      [{ type: "topic-name", blocker: { class: "paused", reason: "user_pause" } }],
      ["paused.user_pause", "paused.only_idle_user_active"]
    );
    expect(stamped).toBe(2);
    expect(await row(queued)).toMatchObject({
      blocked_class: "paused",
      blocked_reason: "user_pause"
    });
    expect((await row(queued)).blocked_at).toBeInstanceOf(Date);
    expect(await row(otherGate)).toMatchObject({ blocked_reason: "user_pause" });
    expect(await row(perTask)).toMatchObject({ blocked_reason: "model_loading" });
    expect(await row(running)).toMatchObject({ status: "running", blocked_class: null });
    expect(await row(otherType)).toMatchObject({ blocked_class: null });
    // Stamping again changes nothing.
    expect(
      await blockers.stampGateBlocks(
        [{ type: "topic-name", blocker: { class: "paused", reason: "user_pause" } }],
        ["paused.user_pause", "paused.only_idle_user_active"]
      )
    ).toBe(0);
  });

  it("clears exactly the rows of a reason, keeping attempts, keys and a paused row's backoff", async () => {
    const blockers = createJobBlockerRepository(db());
    // Stamped by the pause while it waited 10 min for a retry backoff: it still waits for it.
    const paused = await insert({
      type: "topic-name",
      blocked: ["paused", "user_pause"],
      runAfterSeconds: 600,
      dedupeKey: "topic-name:tree",
      attempts: 1
    });
    const pausedDue = await insert({ type: "topic-name", blocked: ["paused", "user_pause"] });
    const capped = await insert({ type: "topic-name", blocked: ["cap", "subscription_daily"] });
    const held = await insert({ type: "topic-areas", blocked: ["paused", "user_pause"] });
    const result = await blockers.clearBlocks({
      reasons: ["paused.user_pause"],
      exceptTypes: ["topic-areas"]
    });
    expect(result).toEqual({ cleared: 2, types: ["topic-name"] });
    expect(await row(paused)).toMatchObject({
      status: "queued",
      blocked_class: null,
      blocked_reason: null,
      blocked_at: null,
      attempts: 1,
      dedupe_key: "topic-name:tree",
      due: false
    });
    expect(await row(pausedDue)).toMatchObject({ blocked_class: null, due: true });
    expect(await row(capped)).toMatchObject({ blocked_reason: "subscription_daily" });
    expect(await row(held)).toMatchObject({ blocked_reason: "user_pause" });
    // A per-task wait cleared by its event before its recheck time is due at once.
    const signin = await insert({
      type: "topic-overview",
      blocked: ["no_model", "signin_required"],
      runAfterSeconds: 300
    });
    expect(await blockers.clearBlocks({ reasons: ["no_model.signin_required"] })).toEqual({
      cleared: 1,
      types: ["topic-overview"]
    });
    expect(await row(signin)).toMatchObject({ blocked_class: null, due: true });
  });

  it("clears a time-bound wait only once its run_after has passed", async () => {
    const blockers = createJobBlockerRepository(db());
    const later = await insert({
      type: "topic-name",
      blocked: ["waiting", "provider_rate_limit"],
      runAfterSeconds: 600
    });
    const due = await insert({
      type: "topic-name",
      blocked: ["waiting", "provider_rate_limit"],
      runAfterSeconds: -1
    });
    expect(
      await blockers.clearBlocks({ reasons: ["waiting.provider_rate_limit"], dueOnly: true })
    ).toEqual({ cleared: 1, types: ["topic-name"] });
    expect(await row(due)).toMatchObject({ blocked_class: null });
    expect(await row(later)).toMatchObject({ blocked_reason: "provider_rate_limit", due: false });
    expect(await blockers.blockedGroups()).toEqual([
      {
        type: "topic-name",
        blockerClass: "waiting",
        reason: "provider_rate_limit",
        count: 1,
        earliestRunAfter: expect.any(Date)
      }
    ]);
  });

  it("returns a blocked running task to the queue with its attempt and free key restored", async () => {
    const blockers = createJobBlockerRepository(db());
    const jobs = createJobRepository(db());
    const id = await insert({ type: "topic-overview", status: "running", attempts: 1 });
    const clearsAt = new Date(Date.now() + 120_000);
    expect(
      await blockers.blockTask({
        jobId: id,
        blocker: { class: "cap", reason: "money_80" },
        runAfter: clearsAt,
        dedupeKey: "topic-overview:topic"
      })
    ).toBe(true);
    expect(await row(id)).toMatchObject({
      status: "queued",
      attempts: 0,
      blocked_class: "cap",
      blocked_reason: "money_80",
      dedupe_key: "topic-overview:topic",
      due: false
    });
    expect((await jobs.findById(id))?.lockedBy).toBeNull();
    // Not running any more: nothing to block.
    expect(
      await blockers.blockTask({ jobId: id, blocker: { class: "paused", reason: "user_pause" } })
    ).toBe(false);
  });

  it("leaves the key off when a queued job of the key exists, so both stay queued", async () => {
    const blockers = createJobBlockerRepository(db());
    const queued = await insert({ type: "topic-name", dedupeKey: "topic-name:tree" });
    const running = await insert({ type: "topic-name", status: "running", attempts: 2 });
    expect(
      await blockers.blockTask({
        jobId: running,
        blocker: { class: "paused", reason: "user_pause" },
        dedupeKey: "topic-name:tree"
      })
    ).toBe(true);
    expect(await row(running)).toMatchObject({ status: "queued", attempts: 1, dedupe_key: null });
    expect(await row(queued)).toMatchObject({ dedupe_key: "topic-name:tree" });
  });
});
