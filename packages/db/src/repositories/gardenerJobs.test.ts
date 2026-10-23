import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createGardenerOutcomeRepository } from "./gardenerOutcomeRepository.js";
import { createJobRepository, immediateJobDebounce } from "./jobRepository.js";

/**
 * The Gardener task state of `jobs` and the outcome cache (F4 T74, D5-D9) on a real PostgreSQL:
 * scope and subject keys by kind, claim-time scope exclusion and its race, gated and blocked jobs,
 * set-aside jobs that keep their attempt and key, quarantine and pruning.
 */
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("Gardener task state on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;
  const jobs = () => createJobRepository(db());
  const treeId = randomUUID();
  const place = (rootSourceId: string, overrides: Record<string, unknown> = {}) => ({
    type: "topic-place",
    lane: "light" as const,
    dedupeKey: `topic-place:${treeId}:${rootSourceId}`,
    payload: { treeId, rootSourceId, sourceItemId: rootSourceId },
    debounce: immediateJobDebounce,
    ...overrides
  });
  const columns = async (id: string) =>
    (
      await db().query<Record<string, unknown>>(
        `select status, attempts, dedupe_key, scope_key, subject_key, outcome, blocked_class,
                blocked_reason, quarantined_at is not null as quarantined, priority, payload
           from jobs where id = $1`,
        [id]
      )
    ).rows[0];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-gardener-jobs-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_gardener_jobs",
      user: "memora_gardener_jobs",
      password: `gardener-jobs-${randomUUID()}`,
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
    await db().query("delete from ingestion_runs");
    await db().query("delete from jobs");
    await db().query("delete from gardener_outcomes");
    await db().query("delete from source_items");
  });

  it("gives each kind its scope and subject, and inline stages none", async () => {
    const root = randomUUID();
    const { job: placed } = await jobs().enqueueDeduped(place(root));
    expect(placed).toMatchObject({
      scopeKey: `tree:${treeId}:structure`,
      subjectKey: `root:${root}`
    });
    const { job: named } = await jobs().enqueueDeduped({
      type: "topic-name",
      lane: "light",
      dedupeKey: `topic-name:${treeId}`,
      payload: { treeId }
    });
    expect(named).toMatchObject({ scopeKey: `tree:${treeId}:names`, subjectKey: `tree:${treeId}` });
    // A link job names its root as sourceItemId, so cancel and delete reach it.
    const { job: link } = await jobs().enqueueDeduped({
      type: "relation-link",
      lane: "light",
      dedupeKey: `relation-link:${root}`,
      payload: { rootId: root }
    });
    expect(link).toMatchObject({
      scopeKey: `root:${root}`,
      subjectKey: `root:${root}`,
      payload: { rootId: root, sourceItemId: root }
    });
    const header = await jobs().create({ type: "catalog-header", lane: "light" });
    expect(header).toMatchObject({ scopeKey: "catalog-header", subjectKey: "catalog-header" });
    const stage = await jobs().create({
      type: "atomic-note-generation",
      payload: { sourceItemId: root }
    });
    expect(stage).toMatchObject({ scopeKey: null, subjectKey: null });
    const download = await jobs().create({ type: "local-model-download", payload: {} });
    expect(download).toMatchObject({ scopeKey: null, subjectKey: null });
  });

  it("scopes an ingestion job by the hierarchy root of its source", async () => {
    const book = await db().query<{ id: string }>(
      "insert into source_items (type, title) values ('Book', 'A book') returning id"
    );
    const bookId = book.rows[0]!.id;
    const chapter = await db().query<{ id: string }>(
      "insert into source_items (type, title, parent_source_item_id) values ('BookChapter', 'One', $1) returning id",
      [bookId]
    );
    const chapterId = chapter.rows[0]!.id;
    const ingestion = await jobs().create({
      type: "ingestion",
      payload: { sourceItemId: chapterId }
    });
    expect(ingestion).toMatchObject({ scopeKey: `root:${bookId}`, subjectKey: `root:${bookId}` });
    // A source that is gone names itself; a payload without a source gets no key.
    const gone = randomUUID();
    expect(
      await jobs().create({ type: "ingestion", payload: { sourceItemId: gone } })
    ).toMatchObject({ scopeKey: `root:${gone}` });
    expect(await jobs().create({ type: "ingestion" })).toMatchObject({ scopeKey: null });
  });

  it("runs an import's inline stage rows beside its scoped parent (B2)", async () => {
    const root = randomUUID();
    const parent = await jobs().create({ type: "ingestion", payload: { sourceItemId: root } });
    expect((await jobs().claimNext("heavy", ["ingestion"], "heavy"))?.id).toBe(parent.id);
    // What runInlineStageJob does for every stage: create the row, then mark it running.
    for (const type of ["summarization", "atomic-note-generation", "knowledge-graph-generation"]) {
      const stage = await jobs().create({ type, payload: { sourceItemId: root }, maxAttempts: 1 });
      const running = await jobs().update(stage.id, { status: "running", attempts: 1 });
      expect(running).toMatchObject({ status: "running", scopeKey: null });
      await jobs().update(stage.id, { status: "succeeded", finishedAt: new Date() });
    }
    expect(await columns(parent.id)).toMatchObject({
      status: "running",
      scope_key: `root:${root}`
    });
  });

  it("never claims a job whose scope has a running job, and claims it once that one ends", async () => {
    const root = randomUUID();
    const { job: first } = await jobs().enqueueDeduped(place(root, { priority: 5 }));
    const second = await jobs().create({
      type: "topic-sweep",
      lane: "light",
      payload: { treeId, reason: "requested" },
      priority: 4
    });
    const other = await jobs().create({ type: "catalog-header", lane: "light", priority: 1 });
    expect((await jobs().claimNext("w1", undefined, "light"))?.id).toBe(first.id);
    // The sweep shares the tree's structure scope: the next claim skips it for another scope.
    expect((await jobs().claimNext("w2", undefined, "light"))?.id).toBe(other.id);
    expect(await jobs().claimNext("w3", undefined, "light")).toBeNull();
    await jobs().update(first.id, { status: "succeeded", finishedAt: new Date() });
    expect((await jobs().claimNext("w3", undefined, "light"))?.id).toBe(second.id);
    // The database refuses a second running job of one scope whatever writes it.
    const third = await jobs().create({
      type: "topic-rebalance",
      lane: "light",
      payload: { treeId }
    });
    await expect(
      db().query("update jobs set status = 'running' where id = $1", [third.id])
    ).rejects.toMatchObject({ code: "23505", constraint: "jobs_running_scope_uidx" });
  });

  it("lets two racing workers run one job per scope (claim race)", async () => {
    for (let round = 0; round < 15; round += 1) {
      await db().query("delete from jobs");
      const [a, b] = [randomUUID(), randomUUID()];
      for (const priority of [9, 8])
        await jobs().create({
          type: "relation-link",
          lane: "light",
          payload: { rootId: a, n: priority },
          priority
        });
      const loner = await jobs().create({
        type: "relation-link",
        lane: "light",
        payload: { rootId: b },
        priority: 1
      });
      const claimed = await Promise.all(
        ["w1", "w2", "w3"].map((worker) =>
          createJobRepository(db()).claimNext(worker, ["relation-link"], "light")
        )
      );
      const scopes = claimed.filter((job) => job !== null).map((job) => job!.scopeKey);
      expect(scopes.sort()).toEqual([`root:${a}`, `root:${b}`].sort());
      expect(claimed.some((job) => job?.id === loner.id)).toBe(true);
      const running = await db().query<{ count: string }>(
        "select count(*)::text as count from jobs where status = 'running'"
      );
      expect(running.rows[0]?.count).toBe("2");
    }
  });

  it("retries a claim that lost the scope race without that scope", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const first = await jobs().create({
      type: "relation-link",
      lane: "light",
      payload: { rootId: a },
      priority: 9
    });
    const sibling = await jobs().create({
      type: "relation-link",
      lane: "light",
      payload: { rootId: a, n: 2 },
      priority: 8
    });
    const other = await jobs().create({
      type: "relation-link",
      lane: "light",
      payload: { rootId: b },
      priority: 1
    });
    // Worker 1 claims inside a transaction it has not committed: worker 2's snapshot cannot see
    // the running job, picks its sibling and waits on the unique index until worker 1 commits.
    const client = await db().connect();
    try {
      await client.query("begin");
      expect((await createJobRepository(client).claimNext("w1", ["relation-link"]))?.id).toBe(
        first.id
      );
      const racing = jobs().claimNext("w2", ["relation-link"]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await client.query("commit");
      expect((await racing)?.id).toBe(other.id);
    } finally {
      client.release();
    }
    expect(await columns(sibling.id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("never claims a gated kind or a blocked job, and keeps their attempts and keys", async () => {
    const { job: named } = await jobs().enqueueDeduped({
      type: "topic-name",
      lane: "light",
      dedupeKey: `topic-name:${treeId}`,
      payload: { treeId },
      debounce: immediateJobDebounce
    });
    expect(
      await jobs().claimNext("model", ["topic-name"], "light", { gatedTypes: ["topic-name"] })
    ).toBeNull();
    expect(
      await jobs().claimNext("any", undefined, undefined, { gatedTypes: ["topic-name"] })
    ).toBeNull();
    expect(await columns(named.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      dedupe_key: `topic-name:${treeId}`
    });
    // A global gate stamps why the queued job waits; a stamped job is never claimed.
    expect(
      await jobs().markBlocked({ types: ["topic-name"] }, { class: "paused", reason: "user_pause" })
    ).toBe(1);
    expect(await jobs().claimNext("model", ["topic-name"], "light")).toBeNull();
    expect(await jobs().list(10, { lane: "light" })).toEqual([]);
    expect(await jobs().list(10, { lane: "light", includeBlocked: true })).toHaveLength(1);
    expect(await columns(named.id)).toMatchObject({
      attempts: 0,
      dedupe_key: `topic-name:${treeId}`,
      blocked_class: "paused",
      blocked_reason: "user_pause"
    });
    // Released (the gate lifted): claimable again.
    expect(await jobs().releaseBlocks({ classes: ["paused"] })).toBe(1);
    expect((await jobs().claimNext("model", ["topic-name"], "light"))?.id).toBe(named.id);
  });

  it("sets a claimed job aside with its attempt and key back, and merges it into a newer duplicate", async () => {
    const root = randomUUID();
    const { job } = await jobs().enqueueDeduped(place(root));
    const claimed = await jobs().claimNext("compute", ["topic-place"], "light");
    expect(claimed).toMatchObject({ id: job.id, attempts: 1, dedupeKey: null });
    expect(claimed?.claimedDedupeKey).toBe(`topic-place:${treeId}:${root}`);
    const clearAt = new Date(Date.now() + 60_000);
    const setAside = await jobs().setAside(job.id, {
      blocker: { class: "cap", reason: "feature_daily" },
      clearAt,
      dedupeKey: claimed!.claimedDedupeKey!,
      result: { status: "cap_reached" }
    });
    expect(setAside?.mergedInto).toBeNull();
    expect(await columns(job.id)).toMatchObject({
      status: "queued",
      attempts: 0,
      dedupe_key: `topic-place:${treeId}:${root}`,
      blocked_class: "cap",
      blocked_reason: "feature_daily"
    });
    expect(setAside?.job.runAfter.getTime()).toBeGreaterThanOrEqual(clearAt.getTime() - 1);
    // A due-only release leaves it: its clear time has not passed.
    expect(await jobs().releaseBlocks({ due: true })).toBe(0);
    // The clear time passes (set aside two seconds ago, due one second ago).
    await db().query(
      `update jobs set blocked_at = now() - interval '2 seconds',
              run_after = now() - interval '1 second' where id = $1`,
      [job.id]
    );
    expect(await jobs().releaseBlocks({ due: true })).toBe(1);
    expect(await columns(job.id)).toMatchObject({ status: "queued", blocked_class: null });

    // Claimed again; meanwhile a newer request queues a duplicate under the key.
    const again = await jobs().claimNext("compute", ["topic-place"], "light");
    const { job: newer } = await jobs().enqueueDeduped(place(root, { priority: 0 }));
    await db().query("update jobs set priority = 7 where id = $1", [job.id]);
    const merged = await jobs().setAside(job.id, {
      blocker: { class: "no_model", reason: "no_route" },
      clearAt: new Date(Date.now() + 60_000),
      dedupeKey: again!.claimedDedupeKey!
    });
    expect(merged?.mergedInto).toBe(newer.id);
    expect(await columns(job.id)).toMatchObject({ status: "canceled", attempts: 0 });
    expect(await columns(newer.id)).toMatchObject({
      status: "queued",
      priority: 7,
      blocked_class: null,
      dedupe_key: `topic-place:${treeId}:${root}`
    });
  });

  it("raises a queued job's priority on merge and releases its blocker", async () => {
    const root = randomUUID();
    const { job } = await jobs().enqueueDeduped(place(root, { priority: 1 }));
    await jobs().enqueueDeduped(place(root, { priority: 0 }));
    expect(await columns(job.id)).toMatchObject({ priority: 1 });
    await jobs().enqueueDeduped(place(root, { priority: 6 }));
    expect(await columns(job.id)).toMatchObject({ priority: 6 });
    await jobs().markBlocked({ ids: [job.id] }, { class: "no_model", reason: "no_decider" });
    // A new request for the same work looks again at a job a blocker held.
    const { created } = await jobs().enqueueDeduped(place(root));
    expect(created).toBe(false);
    expect(await columns(job.id)).toMatchObject({ blocked_class: null, priority: 6 });
  });

  it("re-gates every blocked job at startup", async () => {
    const roots = [randomUUID(), randomUUID(), randomUUID()];
    const ids: string[] = [];
    for (const root of roots) ids.push((await jobs().enqueueDeduped(place(root))).job.id);
    await jobs().markBlocked({ ids: [ids[0]!] }, { class: "paused", reason: "user_pause" });
    await jobs().markBlocked(
      { ids: [ids[1]!] },
      { class: "offline", reason: "network_unreachable" }
    );
    expect(await jobs().releaseBlocks()).toBe(2);
    const blocked = await db().query(
      "select id from jobs where blocked_class is not null or blocked_at is not null"
    );
    expect(blocked.rows).toEqual([]);
  });

  it("quarantines an input after two failed jobs, per kind, subject and fingerprint", async () => {
    const outcomes = createGardenerOutcomeRepository(db());
    const failOnce = async (subject: string, fingerprint: string | null) => {
      const job = await jobs().create({ type: "topic-name", lane: "light", payload: { treeId } });
      await db().query("update jobs set status = 'running' where id = $1", [job.id]);
      return jobs().finish(
        job.id,
        { status: "failed", error: "invalid", finishedAt: new Date() },
        {
          kind: "topic-name",
          subjectKey: subject,
          result: "failed",
          fingerprint,
          errorClass: "result:invalid",
          quarantineAfter: 2
        }
      );
    };
    const succeed = async (subject: string, fingerprint: string | null) => {
      const job = await jobs().create({ type: "topic-name", lane: "light", payload: { treeId } });
      return jobs().finish(
        job.id,
        { status: "succeeded", finishedAt: new Date() },
        {
          kind: "topic-name",
          subjectKey: subject,
          result: "no_change",
          fingerprint,
          quarantineAfter: 2
        }
      );
    };
    const fp = (n: number) => `gf1:${String(n).repeat(64).slice(0, 64)}`;
    const subject = `tree:${treeId}`;
    expect(await failOnce(subject, fp(1))).toMatchObject({ status: "failed", quarantinedAt: null });
    // Another subject fails in between: unrelated subjects never add up.
    await failOnce(`tree:${randomUUID()}`, fp(1));
    const second = await failOnce(subject, fp(1));
    expect(second?.quarantinedAt).toBeInstanceOf(Date);
    expect(await outcomes.get("topic-name", subject)).toMatchObject({
      consecutiveFailures: 2,
      failedFingerprint: fp(1),
      lastErrorClass: "result:invalid",
      lastJobId: second!.id
    });
    expect((await outcomes.get("topic-name", subject))?.quarantinedAt).toBeInstanceOf(Date);
    expect(await outcomes.countQuarantined()).toBe(1);
    // A new fingerprint starts a new run: the old quarantine is over, one failure is not enough.
    const changed = await failOnce(subject, fp(2));
    expect(changed?.quarantinedAt).toBeNull();
    expect(await outcomes.get("topic-name", subject)).toMatchObject({
      consecutiveFailures: 1,
      failedFingerprint: fp(2),
      quarantinedAt: null
    });
    // A success ends the run and records the fingerprint a later job may skip on.
    await succeed(subject, fp(3));
    expect(await outcomes.get("topic-name", subject)).toMatchObject({
      lastOutcome: "no_change",
      lastFingerprint: fp(3),
      consecutiveFailures: 0,
      failedFingerprint: null,
      quarantinedAt: null
    });
    // Unknown fingerprints count too (null equals null), and a manual retry ends the quarantine.
    await failOnce(subject, null);
    const quarantined = await failOnce(subject, null);
    expect(quarantined?.quarantinedAt).toBeInstanceOf(Date);
    expect(await outcomes.listQuarantined()).toHaveLength(1);
    const retried = await jobs().retry(quarantined!.id);
    expect(retried).toMatchObject({ status: "queued", quarantinedAt: null, outcome: null });
    expect(await outcomes.get("topic-name", subject)).toMatchObject({
      consecutiveFailures: 0,
      quarantinedAt: null,
      lastFingerprint: null
    });
  });

  it("keeps a skip from changing the failure run", async () => {
    const outcomes = createGardenerOutcomeRepository(db());
    const job = await jobs().create({ type: "topic-areas", lane: "light", payload: { treeId } });
    await jobs().finish(
      job.id,
      { status: "succeeded", finishedAt: new Date() },
      {
        kind: "topic-areas",
        subjectKey: `tree:${treeId}`,
        result: "done",
        fingerprint: "gf1:" + "a".repeat(64),
        quarantineAfter: 2
      }
    );
    const skipped = await jobs().create({
      type: "topic-areas",
      lane: "light",
      payload: { treeId }
    });
    const ended = await jobs().finish(
      skipped.id,
      { status: "succeeded", outcome: "skipped", finishedAt: new Date() },
      {
        kind: "topic-areas",
        subjectKey: `tree:${treeId}`,
        result: "skipped",
        fingerprint: "gf1:" + "a".repeat(64),
        quarantineAfter: 2
      }
    );
    expect(ended).toMatchObject({ outcome: "skipped" });
    expect(await outcomes.get("topic-areas", `tree:${treeId}`)).toMatchObject({
      lastOutcome: "skipped",
      lastFingerprint: "gf1:" + "a".repeat(64),
      consecutiveFailures: 0
    });
  });

  it("prunes old succeeded and canceled jobs, never failed, downloads or a run's job", async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const make = async (type: string, status: string) => {
      const job = await jobs().create({ type, lane: type === "ingestion" ? "heavy" : "light" });
      await db().query(
        "update jobs set status = $2::job_status, finished_at = $3, outcome = case when $2 = 'succeeded' then 'done' end where id = $1",
        [job.id, status, old]
      );
      return job.id;
    };
    const pruned = [await make("topic-place", "succeeded"), await make("topic-name", "canceled")];
    const kept = [
      await make("topic-areas", "failed"),
      await make("local-model-download", "succeeded"),
      await make("ingestion", "succeeded")
    ];
    await db().query("insert into ingestion_runs (job_id) values ($1)", [kept[2]]);
    const recent = await jobs().create({ type: "topic-place", lane: "light" });
    await jobs().update(recent.id, { status: "succeeded", finishedAt: new Date() });
    const before = new Date(Date.now() - 30 * 86_400_000);
    expect(await jobs().pruneFinished({ before, limit: 1 })).toBe(1);
    expect(await jobs().pruneFinished({ before })).toBe(1);
    const left = await db().query<{ id: string }>("select id from jobs");
    expect(left.rows.map((row) => row.id).sort()).toEqual([...kept, recent.id].sort());
    expect(pruned.every((id) => !left.rows.some((row) => row.id === id))).toBe(true);
  });

  it("keeps the state columns consistent in the database", async () => {
    const job = await jobs().create({ type: "topic-place", lane: "light" });
    const refused = async (sql: string) =>
      expect(db().query(sql, [job.id])).rejects.toMatchObject({
        code: "23514",
        constraint: "jobs_gardener"
      });
    await refused("update jobs set outcome = 'done' where id = $1");
    await refused("update jobs set outcome = 'finished', status = 'succeeded' where id = $1");
    await refused("update jobs set quarantined_at = now() where id = $1");
    await refused("update jobs set blocked_class = 'paused' where id = $1");
    await refused(
      "update jobs set blocked_class = 'later', blocked_reason = 'x', blocked_at = now() where id = $1"
    );
    await refused(
      "update jobs set status = 'running', blocked_class = 'paused', blocked_reason = 'user_pause', blocked_at = now() where id = $1"
    );
    // A succeeded job gets the outcome `done` by default; a requeue clears it.
    expect(await jobs().update(job.id, { status: "succeeded" })).toMatchObject({ outcome: "done" });
    expect(await jobs().update(job.id, { status: "queued" })).toMatchObject({ outcome: null });
    expect(
      await jobs().update(job.id, { status: "succeeded", outcome: "no_change" })
    ).toMatchObject({
      outcome: "no_change"
    });
  });
});
