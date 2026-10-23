import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { gardenerStatusKinds, type GardenerStatusSnapshot } from "@app/domain";

import { createBackgroundPolicy, type BackgroundPolicy } from "./background-policy.js";
import {
  GardenerStatusService,
  distinctHolds,
  gardenerStatusStoreOf,
  type GardenerStatusServiceOptions
} from "./status-service.js";

// The status (F4 D27) on a real PostgreSQL database with the real background policy: the windows of
// the soak's ground truth (spec 5.4), played one after the other, each answered by the class the
// ground truth names. The AI lanes are the only fake: the scheduler's snapshot is theirs to give.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

type Lane = ReturnType<GardenerStatusServiceOptions["lanes"]>[number];

describe.skipIf(!sidecarInstalled)("the Gardener status on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let policy: BackgroundPolicy;
  let service: GardenerStatusService;
  let lanes: Lane[] = [];
  let published: GardenerStatusSnapshot[] = [];
  const db = () => pool!;

  const codex = (extra: Partial<Lane> = {}): Lane => ({
    lane: "remote:codex",
    running: 0,
    waiting: { P0: 0, P1: 0, P2: 0, P3: 0 },
    pausedForMs: null,
    breaker: { state: "closed", consecutiveFailures: 0, reopensInMs: null, opened: 0, refused: 0 },
    failure: null,
    ...extra
  });

  const insertJob = async (input: {
    type: string;
    status?: "queued" | "running";
    attempts?: number;
    runAfterSeconds?: number;
    blocked?: [string, string];
  }) =>
    (
      await db().query<{ id: string }>(
        `insert into jobs (type, status, lane, payload, attempts, run_after,
                           blocked_class, blocked_reason, blocked_at, locked_at)
         values ($1, $2::job_status, 'light', '{}', $3, now() + make_interval(secs => $4), $5, $6,
                 case when $5::text is null then null else now() end,
                 case when $2::job_status = 'running' then now() end)
         returning id`,
        [
          input.type,
          input.status ?? "queued",
          input.attempts ?? 0,
          input.runAfterSeconds ?? 0,
          input.blocked?.[0] ?? null,
          input.blocked?.[1] ?? null
        ]
      )
    ).rows[0]!.id;

  /** Re-gates the queued rows as the blocker service does after a control moved. */
  const regate = async () => {
    await policy.blockers.notify("controls_changed");
    await policy.blockers.reconcile();
  };

  const status = async () => service.refresh();

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-gardener-status-service-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_gardener_status_service",
      user: "memora_gardener_status_service",
      password: `gardener-status-service-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    policy = createBackgroundPolicy({
      getPool: () => pool ?? null,
      powerSource: null,
      isPackaged: false,
      env: {},
      wake: () => undefined
    });
    service = new GardenerStatusService({
      store: () => (pool ? gardenerStatusStoreOf(pool) : null),
      gateHolds: () => distinctHolds(policy.gate.forKinds(gardenerStatusKinds)),
      budget: async () => null,
      lanes: () => lanes,
      models: async () => [],
      publish: (event) => published.push(event.status)
    });
    await policy.controls.get();
  }, 120_000);

  afterAll(async () => {
    service?.stop();
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db().query("delete from jobs");
    await policy.controls.update({
      paused: false,
      autonomy: "auto",
      onlyIdle: false,
      onlyOnAc: false
    });
    policy.power.setDevOverride(null);
    lanes = [];
    published = [];
    await regate();
  });

  it("is idle on an empty library, and quiet about it", async () => {
    expect(await status()).toMatchObject({
      state: "idle",
      params: {},
      coverage: { placed: 1, matched: 1, overviewsFresh: 1 }
    });
    expect(published).toHaveLength(1);
    await status();
    expect(published).toHaveLength(1);
  });

  it("explains tasks that only wait their turn, and a task that waits for its next attempt", async () => {
    await insertJob({ type: "topic-place" });
    await insertJob({ type: "topic-name" });
    expect(await status()).toMatchObject({ state: "running", class: "waiting", reason: "queue" });
    await db().query("delete from jobs");
    await insertJob({ type: "topic-name", attempts: 1, runAfterSeconds: 120 });
    expect(await status()).toMatchObject({
      state: "blocked",
      class: "waiting",
      reason: "retry_backoff"
    });
  });

  it("window: pause, then resume (paused.user_pause)", async () => {
    await insertJob({ type: "topic-place" });
    await insertJob({ type: "topic-name" });
    await policy.controls.update({ paused: true });
    await regate();
    expect(await status()).toMatchObject({
      state: "blocked",
      class: "paused",
      reason: "user_pause",
      action: "resume"
    });
    await policy.controls.update({ paused: false });
    await regate();
    expect(await status()).toMatchObject({ class: "waiting", reason: "queue" });
    expect(published.map((entry) => entry.class)).toEqual(["paused", "waiting"]);
  });

  it("window: autonomy Off holds the generative kinds while placement still runs (paused.autonomy_off)", async () => {
    await insertJob({ type: "topic-place", status: "running" });
    await insertJob({ type: "topic-name" });
    await policy.controls.update({ autonomy: "off" });
    await regate();
    expect(await status()).toMatchObject({
      state: "running",
      class: "paused",
      reason: "autonomy_off",
      action: "open_controls"
    });
  });

  it("window: only idle while the user is active, only on AC on battery", async () => {
    await insertJob({ type: "topic-place" });
    policy.power.setDevOverride({
      startedAt: Date.now(),
      blocks: [{ active: true, onBattery: false }]
    });
    await policy.controls.update({ onlyIdle: true });
    await regate();
    expect(await status()).toMatchObject({ class: "paused", reason: "only_idle_user_active" });
    await policy.controls.update({ onlyIdle: false, onlyOnAc: true });
    policy.power.setDevOverride({
      startedAt: Date.now(),
      blocks: [{ active: false, onBattery: true }]
    });
    await regate();
    expect(await status()).toMatchObject({ class: "paused", reason: "only_ac_on_battery" });
  });

  it("window: a rate limit, a refused connection and a network that is gone, each by its class", async () => {
    await insertJob({ type: "topic-name", status: "running" });
    await insertJob({ type: "topic-name" });
    await insertJob({ type: "topic-name", attempts: 1, runAfterSeconds: 60 });

    lanes = [codex({ running: 1, pausedForMs: 90_000 })];
    const limited = await status();
    expect(limited).toMatchObject({ class: "waiting", reason: "provider_rate_limit" });
    expect(limited.eta?.kind).toBe("at");

    lanes = [
      codex({
        running: 1,
        breaker: {
          state: "open",
          consecutiveFailures: 5,
          reopensInMs: 30_000,
          opened: 1,
          refused: 0
        },
        failure: { kind: "unavailable", ageMs: 1_000 }
      })
    ];
    expect(await status()).toMatchObject({ class: "waiting", reason: "provider_unavailable" });

    lanes = [
      codex({
        running: 1,
        breaker: {
          state: "open",
          consecutiveFailures: 5,
          reopensInMs: 30_000,
          opened: 1,
          refused: 0
        },
        failure: { kind: "unreachable", ageMs: 1_000 }
      })
    ];
    expect(await status()).toMatchObject({ class: "offline", reason: "network_unreachable" });

    lanes = [codex({ running: 1, failure: { kind: "unauthorized", ageMs: 1_000 } })];
    expect(await status()).toMatchObject({
      state: "attention",
      class: "no_model",
      reason: "signin_required",
      action: "sign_in"
    });

    lanes = [codex({ running: 1 })];
    expect((await status()).reason).toBe("queue");
  });

  it("window: a task set aside for a missing ranker, with the class of AI work it is about", async () => {
    await insertJob({ type: "topic-gate", blocked: ["no_model", "no_decider"] });
    expect(await status()).toMatchObject({
      state: "blocked",
      class: "no_model",
      reason: "no_decider",
      action: "open_local_models"
    });
    await db().query("delete from jobs");
    await insertJob({ type: "topic-name", blocked: ["no_model", "no_route"] });
    expect(await status()).toMatchObject({
      state: "attention",
      class: "no_model",
      reason: "no_route",
      params: { routeClass: "write-fast" },
      action: "open_ai_settings"
    });
  });

  it("window: a wait that clears by itself says when", async () => {
    await insertJob({
      type: "topic-name",
      blocked: ["no_model", "signin_required"],
      runAfterSeconds: 300
    });
    const waiting = await status();
    expect(waiting).toMatchObject({ class: "no_model", reason: "signin_required" });
    expect(waiting.eta?.kind).toBe("at");
    const clears = Date.parse((waiting.eta as { at: string }).at) - Date.now();
    expect(clears).toBeGreaterThan(280_000);
    expect(clears).toBeLessThan(305_000);
  });

  it("gives every state of every kind a reason: no fallback", async () => {
    for (const type of gardenerStatusKinds) {
      await db().query("delete from jobs");
      await insertJob({ type });
      const snapshot = await status();
      expect(snapshot.class, type).toBeDefined();
    }
  });
});
