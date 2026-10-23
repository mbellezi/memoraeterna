import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PostgresSidecarManager,
  closePgPool,
  createGardenerOutcomeRepository,
  createJobRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type JobRecord,
  type JsonObject,
  type PgPool
} from "@app/db";
import { gardenerFingerprint } from "@app/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { JobSupervisor } from "./job-supervisor.js";
import type { LightJobRegistry } from "./job-lanes.js";

/**
 * The supervisor's side of the Gardener task model (F4 T74, D7-D9) on a real database: an outcome
 * at finish, a skip by fingerprint, a blocker result that sets the job aside without burning an
 * attempt, failed attempts that back off and quarantine an input after the second failed job, and
 * a manual retry that ends the quarantine. The executor stands in for a topic Areas pass.
 */
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const quiet = { error: () => undefined, warn: () => undefined };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const fingerprintOf = (members: string) => gardenerFingerprint("topic-areas", { members }, sha256);

describe.skipIf(!sidecarInstalled)("Gardener tasks through the job supervisor", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let supervisor: JobSupervisor | undefined;
  /** What the next Areas pass returns, and the members its input fingerprint names, per tree. */
  const answer = new Map<string, JsonObject>();
  const members = new Map<string, string>();
  const execute = vi.fn(async (job: JobRecord) => answer.get(String(job.payload.treeId)) ?? {});
  const ended = vi.fn(async () => undefined);
  const registry: LightJobRegistry = {
    "topic-areas": {
      needsModel: true,
      execute,
      ended,
      fingerprint: async (job) => {
        const value = members.get(String(job.payload.treeId));
        return value === undefined ? null : fingerprintOf(value);
      }
    }
  };
  const db = () => pool!;
  const jobs = () => createJobRepository(db());
  const enqueue = async (treeId: string) =>
    (
      await jobs().enqueueDeduped({
        type: "topic-areas",
        lane: "light",
        dedupeKey: `topic-areas:${treeId}`,
        payload: { treeId },
        debounce: { delayMs: 0, maxDelayMs: 0 }
      })
    ).job;
  /** Runs the model worker until nothing is due, making backoffs due at once. */
  const drain = async () => {
    const ran: JobRecord[] = [];
    for (let pass = 0; pass < 20; pass += 1) {
      await db().query(
        "update jobs set run_after = now() where status = 'queued' and blocked_class is null"
      );
      const job = await supervisor!.runLightOnce("model");
      if (!job) break;
      ran.push(job);
    }
    return ran;
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-gardener-supervisor-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_gardener_supervisor",
      user: "memora_gardener_supervisor",
      password: `gardener-supervisor-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    supervisor = new JobSupervisor({ getPool: () => pool!, lightJobs: registry, logger: quiet });
  }, 120_000);

  afterAll(async () => {
    await supervisor?.stop().catch(() => undefined);
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db().query("delete from jobs");
    await db().query("delete from gardener_outcomes");
    answer.clear();
    members.clear();
    execute.mockClear();
    ended.mockClear();
  });

  it("finishes with an outcome, caches it and skips an equal input", async () => {
    const tree = randomUUID();
    answer.set(tree, { status: "no_change" });
    members.set(tree, "a,b");
    const first = await enqueue(tree);
    await drain();
    expect(await jobs().findById(first.id)).toMatchObject({
      status: "succeeded",
      outcome: "no_change",
      inputFingerprint: fingerprintOf("a,b"),
      result: { status: "no_change" }
    });
    expect(
      await createGardenerOutcomeRepository(db()).get("topic-areas", `tree:${tree}`)
    ).toMatchObject({
      lastOutcome: "no_change",
      lastFingerprint: fingerprintOf("a,b")
    });
    // The same input again: skipped without a call.
    const second = await enqueue(tree);
    await drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await jobs().findById(second.id)).toMatchObject({
      status: "succeeded",
      outcome: "skipped",
      result: { status: "skipped", reason: "same_input" }
    });
    // A changed input runs.
    members.set(tree, "a,b,c");
    answer.set(tree, { status: "applied" });
    const third = await enqueue(tree);
    await drain();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(await jobs().findById(third.id)).toMatchObject({ outcome: "done" });
  });

  it("sets a job aside for a blocker result with its attempt and key back", async () => {
    const tree = randomUUID();
    answer.set(tree, { status: "cap_reached" });
    const job = await enqueue(tree);
    const ran = await supervisor!.runLightOnce("model");
    expect(ran).toMatchObject({
      id: job.id,
      status: "queued",
      attempts: 0,
      dedupeKey: `topic-areas:${tree}`,
      blockedClass: "cap",
      blockedReason: "feature_daily",
      result: { status: "cap_reached" }
    });
    // Due at the next local day; nothing claims it before.
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    expect(ran!.runAfter.getTime()).toBe(midnight.getTime());
    expect(await supervisor!.runLightOnce("model")).toBeNull();
    expect(
      await createGardenerOutcomeRepository(db()).get("topic-areas", `tree:${tree}`)
    ).toBeNull();
    // A new request for it looks again: released, it runs and meets the cap again.
    await enqueue(tree);
    expect(await jobs().findById(job.id)).toMatchObject({ blockedClass: null });
    expect(await supervisor!.runLightOnce("model")).toMatchObject({
      id: job.id,
      blockedClass: "cap",
      attempts: 0
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("backs off failed calls and quarantines an input after its second failed job", async () => {
    const tree = randomUUID();
    const other = randomUUID();
    answer.set(tree, { status: "call_failed" });
    answer.set(other, { status: "invalid", issues: [] });
    members.set(tree, "x");
    members.set(other, "y");
    const first = await enqueue(tree);
    // One attempt: queued again with backoff, the result kept for its readers.
    expect(await supervisor!.runLightOnce("model")).toMatchObject({
      status: "queued",
      attempts: 1,
      error: "gardener_attempt_failed:call_failed",
      result: { status: "call_failed" }
    });
    await drain();
    expect(await jobs().findById(first.id)).toMatchObject({
      status: "failed",
      attempts: 3,
      quarantinedAt: null
    });
    // An answer still invalid after the producer's repair fails at once (no retry), and an
    // unrelated subject's failed job does not add to this input's run.
    const invalid = await enqueue(other);
    await drain();
    expect(await jobs().findById(invalid.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      result: { status: "invalid" }
    });
    const outcomes = createGardenerOutcomeRepository(db());
    expect(await outcomes.get("topic-areas", `tree:${tree}`)).toMatchObject({
      consecutiveFailures: 1,
      quarantinedAt: null
    });
    const second = await enqueue(tree);
    await drain();
    const quarantined = await jobs().findById(second.id);
    expect(quarantined).toMatchObject({ status: "failed" });
    expect(quarantined?.quarantinedAt).toBeInstanceOf(Date);
    expect(await outcomes.get("topic-areas", `tree:${tree}`)).toMatchObject({
      consecutiveFailures: 2,
      lastErrorClass: "result:call_failed",
      failedFingerprint: fingerprintOf("x")
    });
    expect(ended).toHaveBeenCalledTimes(3);
    // The same input again is not run: skipped as quarantined, its owned work settled.
    const calls = execute.mock.calls.length;
    const third = await enqueue(tree);
    await drain();
    expect(execute).toHaveBeenCalledTimes(calls);
    expect(await jobs().findById(third.id)).toMatchObject({
      status: "succeeded",
      outcome: "skipped",
      result: { status: "quarantined" }
    });
    expect(ended).toHaveBeenCalledTimes(4);
    // A manual retry ends the quarantine and runs the input again.
    expect(await supervisor!.retry(second.id)).toMatchObject({ status: "queued" });
    expect((await outcomes.get("topic-areas", `tree:${tree}`))?.quarantinedAt).toBeNull();
    answer.set(tree, { status: "applied" });
    await drain();
    expect(await jobs().findById(second.id)).toMatchObject({
      status: "succeeded",
      outcome: "done"
    });
    // A changed input after a quarantine runs as well.
    answer.set(tree, { status: "invalid" });
    members.set(tree, "x2");
    const changed = await enqueue(tree);
    await drain();
    expect(await jobs().findById(changed.id)).toMatchObject({
      status: "failed",
      quarantinedAt: null
    });
  });

  it("releases every blocked job at startup before the workers run", async () => {
    const root = randomUUID();
    const queued = await jobs().create({
      type: "topic-build",
      lane: "light",
      payload: { treeId: root },
      runAfter: new Date(Date.now() + 3_600_000)
    });
    await jobs().markBlocked({ ids: [queued.id] }, { class: "no_model", reason: "no_route" });
    const restarted = new JobSupervisor({
      getPool: () => pool!,
      lightJobs: {},
      logger: quiet,
      pollIntervalMs: 60_000
    });
    try {
      await restarted.start();
    } finally {
      await restarted.stop();
    }
    expect(await jobs().findById(queued.id)).toMatchObject({
      status: "queued",
      blockedClass: null,
      blockedReason: null
    });
  });
});
