import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createAiScheduler,
  providerFailureKind,
  resolveAiLaneRuntimeConfig,
  toProviderNetworkError,
  type AiScheduler,
  type BreakerTransition,
  type SchedulerClock
} from "@app/ai";
import {
  PostgresSidecarManager,
  closePgPool,
  createIngestionRunRepository,
  createJobRepository,
  createPgPool,
  createSourceItemRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import {
  ProcessingStages,
  gardenerStatusKinds,
  relationExplainBackfillJobType,
  statusSentence
} from "@app/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBackgroundPolicy, type BackgroundPolicy } from "./gardener/background-policy.js";
import {
  GardenerStatusService,
  distinctHolds,
  gardenerStatusStoreOf,
  laneFactsOf
} from "./gardener/status-service.js";
import type { LightJobRegistry } from "./job-lanes.js";
import { JobSupervisor } from "./job-supervisor.js";
import { relationExplainBackfillDedupeKey } from "./relations/relation-explain-backfill.js";

/**
 * A provider outage is a wait, not a failure (F4 D7), on a real database, with the real lane
 * scheduler and its circuit breaker: a DNS outage (every request fails `ENOTFOUND`) meets twenty
 * explanation backfills and an import's summarization. The first failures open the breaker; every
 * task, refused fast or failed in transport, is set aside as `offline.network_unreachable` with its
 * attempt and dedupe key kept, nothing fails and nothing is quarantined, and the status names the
 * outage. Looked at again while the outage lasts, they are set aside again, still at no attempt.
 * When the provider answers the probe the breaker closes, `network_back` frees exactly the rows of
 * the outage's reasons, and every task completes. (As the 10-24 DNS outage did, before this, end
 * twenty backfills `failed` at 3/3 attempts within seconds and an import `completed_with_failures`.)
 */
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const quiet = { error: () => undefined, warn: () => undefined, info: () => undefined };
const codex = "remote:codex";
const relations = 20;

describe.skipIf(!sidecarInstalled)("a provider outage through the job supervisor", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let policy: BackgroundPolicy;
  let scheduler: AiScheduler;
  let supervisor: JobSupervisor;
  let status: GardenerStatusService;
  /** The scheduler's clock: the breaker's open period passes only when the test moves it. */
  let clockMs = 0;
  const transitions: BreakerTransition[] = [];
  /** The clearing event the breaker's close sent, to await before the next pass. */
  let cleared: Promise<void> = Promise.resolve();
  const provider = { up: false, requests: 0 };
  const db = () => pool!;

  /** One remote call of a job, reported to its lane as `runRemoteCall` reports it. */
  const remoteCall = (jobId: string, label: string) =>
    scheduler.run(
      {
        lane: codex,
        remoteKind: "codex",
        priority: "P3",
        workloadClass: "write-fast",
        label,
        budgetClass: "background",
        jobId
      },
      async (permit) => {
        provider.requests += 1;
        if (!provider.up) {
          const failure = toProviderNetworkError(
            new TypeError("fetch failed", {
              cause: Object.assign(new Error("getaddrinfo ENOTFOUND chatgpt.com"), {
                code: "ENOTFOUND"
              })
            })
          );
          permit.observeOutcome("transient", providerFailureKind(failure));
          throw failure;
        }
        permit.observeOutcome("ok");
        return "answer";
      }
    );

  const lightJobs: LightJobRegistry = {
    [relationExplainBackfillJobType]: {
      needsModel: true,
      worker: "relations",
      execute: async (job) => {
        await remoteCall(job.id, "relation_explain");
        return { status: "completed", outcome: "written" };
      }
    }
  };

  const knowledgeService = {
    isHierarchicalRoot: async () => false,
    summarizeSource: async (
      _sourceItemId: string,
      _documentId: string,
      _signal: AbortSignal,
      _onProgress: unknown,
      context: { jobId: string }
    ) => {
      await remoteCall(context.jobId, "summarization");
      return { configured: true, generated: true };
    }
  };

  const jobRows = async (type: string) =>
    (
      await db().query<{
        id: string;
        status: string;
        attempts: number;
        dedupeKey: string | null;
        blockedClass: string | null;
        blockedReason: string | null;
        outcome: string | null;
        runAfterMs: number;
      }>(
        `select id, status::text as status, attempts, dedupe_key as "dedupeKey",
                blocked_class as "blockedClass", blocked_reason as "blockedReason", outcome,
                (extract(epoch from run_after) * 1000)::float8 as "runAfterMs"
           from jobs where type = $1 order by created_at, id`,
        [type]
      )
    ).rows;

  /** Runs the relations worker until nothing is due. */
  const drainRelations = async () => {
    for (let pass = 0; pass < 100; pass += 1)
      if (!(await supervisor.runLightOnce("relations"))) return;
    throw new Error("the relations worker did not settle");
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-provider-outage-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_provider_outage",
      user: "memora_provider_outage",
      password: `provider-outage-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    policy = createBackgroundPolicy({
      getPool: () => pool ?? null,
      powerSource: null,
      isPackaged: false,
      env: {},
      wake: () => undefined,
      logger: quiet
    });
    await policy.controls.get();
    const clock: SchedulerClock = {
      now: () => clockMs,
      setTimer: (callback, delayMs) => {
        const handle = setTimeout(callback, Math.max(0, delayMs));
        handle.unref?.();
        return handle;
      },
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    };
    // As the app wires it: the breaker's close is the `network_back` event (index.ts).
    scheduler = createAiScheduler(resolveAiLaneRuntimeConfig({}, { environment: {} }), clock, {
      onBreakerTransition: (_lane, transition) => {
        transitions.push(transition);
        if (transition.to === "closed") cleared = policy.blockers.notify("network_back");
      }
    });
    supervisor = new JobSupervisor({
      getPool: () => pool ?? null,
      lightJobs,
      knowledgeService: knowledgeService as never,
      backgroundPolicy: policy.jobs,
      logger: quiet
    });
    status = new GardenerStatusService({
      store: () => (pool ? gardenerStatusStoreOf(pool) : null),
      gateHolds: () => distinctHolds(policy.gate.forKinds(gardenerStatusKinds)),
      budget: async () => null,
      lanes: () => scheduler.snapshot(),
      models: async () => [],
      publish: () => undefined
    });
  }, 120_000);

  afterAll(async () => {
    status?.stop();
    await supervisor?.stop().catch(() => undefined);
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("sets the backfill and an import's stage aside, then resumes exactly them when the breaker closes", async () => {
    const jobs = createJobRepository(db());
    // Twenty backfills, queued as the day's pass queues them.
    const relationIds = Array.from({ length: relations }, () => randomUUID());
    for (const relationId of relationIds)
      await jobs.enqueueDeduped({
        type: relationExplainBackfillJobType,
        lane: "light",
        dedupeKey: relationExplainBackfillDedupeKey(relationId),
        payload: { relationId },
        priority: 30,
        debounce: { delayMs: 0, maxDelayMs: 0 }
      });
    // An import whose plan summarizes it (its chunks are there already).
    const source = await createSourceItemRepository(db()).create({
      type: "WebArticle",
      title: "Spacing and retrieval"
    });
    const markdown = "Retrieval practice spaced over days outlasts massed study.";
    const documentId = randomUUID();
    await db().query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, $4, $5)`,
      [
        documentId,
        source.id,
        source.title,
        markdown,
        createHash("sha256").update(markdown).digest("hex")
      ]
    );
    const runs = createIngestionRunRepository(db());
    const stages = ["summarization"];
    const run = await runs.create({
      sourceItemId: source.id,
      requestedStages: stages,
      effectiveStages: stages,
      trigger: "interactive_import"
    });
    await runs.initializeStages(run.id, stages, ProcessingStages);
    const ingestion = await jobs.create({
      type: "ingestion",
      payload: {
        ingestionRunId: run.id,
        sourceItemId: source.id,
        documentId,
        markdown,
        effectiveStages: stages,
        processingMode: "content"
      }
    });
    await runs.update(run.id, { jobId: ingestion.id, currentStage: "summarization" });

    // --- The outage: the import first, then the backfills ------------------------------------
    const started = Date.now();
    expect(await supervisor.runOnce()).toMatchObject({
      id: ingestion.id,
      status: "queued",
      attempts: 0,
      blockedClass: "offline",
      blockedReason: "network_unreachable"
    });
    await drainRelations();
    // Five transport failures opened the breaker; the rest were refused without a request.
    expect(transitions.map((t) => [t.from, t.to])).toEqual([["closed", "open"]]);
    expect(provider.requests).toBe(5);

    const outage = await jobRows(relationExplainBackfillJobType);
    expect(outage).toHaveLength(relations);
    for (const row of outage) {
      expect(row).toMatchObject({
        status: "queued",
        attempts: 0,
        blockedClass: "offline",
        blockedReason: "network_unreachable",
        outcome: null
      });
      // Back within about the breaker's open period: the next probe.
      expect(row.runAfterMs).toBeGreaterThan(started);
      expect(row.runAfterMs).toBeLessThanOrEqual(Date.now() + 31_000);
    }
    expect(outage.map((row) => row.dedupeKey).sort()).toEqual(
      relationIds.map((id) => relationExplainBackfillDedupeKey(id)).sort()
    );
    // The import waits for the network's return or the recheck, its run pending, not failed.
    const [waitingImport] = await jobRows("ingestion");
    expect(waitingImport?.runAfterMs).toBeGreaterThan(Date.now() + 60_000);
    expect(await runs.findById(run.id)).toMatchObject({
      status: "pending",
      error: null,
      stagesCheckpoint: { summarization: { status: "pending" } }
    });
    const stageRow = await db().query<{ status: string; ended: boolean; attempts: number }>(
      `select status::text as status, ended_at is not null as ended, attempts
         from ingestion_run_stages where ingestion_run_id = $1 and stage = 'summarization'`,
      [run.id]
    );
    // The stage's attempt ended with the wait; the next one starts when the import resumes.
    expect(stageRow.rows).toEqual([{ status: "pending", ended: true, attempts: 1 }]);
    // Nothing failed but the import's one summarization attempt; nothing is quarantined.
    const failed = await db().query<{ type: string }>(
      "select type from jobs where status = 'failed'"
    );
    expect(failed.rows.map((row) => row.type)).toEqual(["summarization"]);
    const outcomes = await db().query(
      `select 1 from gardener_outcomes
        where consecutive_failures > 0 or quarantined_at is not null or last_outcome = 'failed'`
    );
    expect(outcomes.rowCount).toBe(0);

    // The status names the outage (T86): the network does not answer.
    const snapshot = await status.refresh();
    expect(snapshot).toMatchObject({
      state: "blocked",
      class: "offline",
      reason: "network_unreachable"
    });
    expect(statusSentence(snapshot, "en").headline).toBe(
      "There is no internet connection. Work that needs an online model resumes when you are back online."
    );
    expect(laneFactsOf(scheduler.snapshot()[0]!)).toMatchObject({
      breaker: { state: "open" },
      failure: { kind: "unreachable" }
    });

    // A row another blocker holds from now on: the outage's clearing event must leave it alone.
    const capped = await jobs.enqueueDeduped({
      type: relationExplainBackfillJobType,
      lane: "light",
      dedupeKey: relationExplainBackfillDedupeKey(randomUUID()),
      payload: { relationId: randomUUID() },
      debounce: { delayMs: 0, maxDelayMs: 0 }
    });
    await db().query(
      `update jobs set blocked_class = 'cap', blocked_reason = 'subscription_daily',
              blocked_at = now(), run_after = now() + interval '1 day' where id = $1`,
      [capped.job.id]
    );

    // --- Looked at again while the outage lasts: set aside again, still at no attempt ----------
    const outageRows = async () =>
      (await jobRows(relationExplainBackfillJobType)).filter((row) => row.id !== capped.job.id);
    /** Makes these rows' clear time pass, and lets the blocker service's tick free them. */
    const due = async (ids: readonly string[]) => {
      await db().query("update jobs set run_after = now() where id = any($1::uuid[])", [ids]);
      await policy.blockers.tick();
    };
    clockMs += 30_000;
    await due(outage.map((row) => row.id));
    await drainRelations();
    // The first one probed and failed; the others were refused by the breaker it opened again.
    expect(provider.requests).toBe(6);
    expect(transitions.map((t) => t.to)).toEqual(["open", "half_open", "open"]);
    for (const row of await outageRows())
      expect(row).toMatchObject({ status: "queued", attempts: 0, blockedClass: "offline" });

    // --- The network is back: the next probe is answered and the breaker closes ----------------
    provider.up = true;
    clockMs += 30_000;
    const [prober, ...rest] = await outageRows();
    await due([prober!.id]);
    expect(await supervisor.runLightOnce("relations")).toMatchObject({
      id: prober!.id,
      status: "succeeded"
    });
    expect(transitions.at(-1)).toMatchObject({ from: "half_open", to: "closed" });
    await cleared;
    // `network_back` freed every row of the outage's reasons at once (the import's too, whose
    // recheck was minutes away), and only those.
    for (const row of [...rest, ...(await jobRows("ingestion"))])
      expect(
        (await jobs.findById(row.id))?.blockedClass,
        `${row.id} is still set aside`
      ).toBeNull();
    expect((await jobs.findById(capped.job.id)) ?? null).toMatchObject({
      status: "queued",
      blockedClass: "cap",
      blockedReason: "subscription_daily"
    });

    await drainRelations();
    expect(await supervisor.runOnce()).toMatchObject({ id: ingestion.id, status: "succeeded" });

    // Every task completed, each with the one attempt that ran it.
    const done = (await jobRows(relationExplainBackfillJobType)).filter(
      (row) => row.id !== capped.job.id
    );
    for (const row of done)
      expect(row).toMatchObject({ status: "succeeded", attempts: 1, outcome: "done" });
    expect((await jobRows("ingestion"))[0]).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(await runs.findById(run.id)).toMatchObject({
      status: "succeeded",
      stagesCheckpoint: { summarization: { status: "completed" } }
    });
    const after = await db().query(
      `select 1 from gardener_outcomes
        where kind = $1 and (last_outcome <> 'done' or consecutive_failures > 0
          or quarantined_at is not null)`,
      [relationExplainBackfillJobType]
    );
    expect(after.rowCount).toBe(0);
    expect(
      (
        await db().query("select 1 from gardener_outcomes where kind = $1", [
          relationExplainBackfillJobType
        ])
      ).rowCount
    ).toBe(relations);
    expect((await status.refresh()).class).not.toBe("offline");
  }, 60_000);
});
