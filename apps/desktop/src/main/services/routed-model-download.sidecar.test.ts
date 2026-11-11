import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PostgresSidecarManager,
  bumpAiConfigGeneration,
  closePgPool,
  createAiConfigRepository,
  createIngestionRunRepository,
  createJobRepository,
  createLocalModelRepository,
  createPgPool,
  createSourceItemRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { ProcessingStages, relationExplainBackfillJobType } from "@app/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AiService } from "./ai-service.js";
import { createBackgroundPolicy, type BackgroundPolicy } from "./gardener/background-policy.js";
import type { LightJobRegistry } from "./job-lanes.js";
import { JobSupervisor } from "./job-supervisor.js";
import { relationExplainBackfillDedupeKey } from "./relations/relation-explain-backfill.js";

/**
 * A routed local model that is installed but not ready yet is a wait, not a missing model (F4 D7,
 * gate S 10-25 job 34826f96): on a real database, with the real AI service and background policy,
 * a Gardener task and an import's inline stage whose routed model is being verified are set aside
 * as `download.model_verifying`, their attempt and dedupe key kept and the run pending, instead of
 * failing as "no model". The download settling frees exactly them. A model that is not arriving
 * (failed) still reads as no model. No model runs here: nothing is called once a model is ready.
 */
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const quiet = { error: () => undefined, warn: () => undefined, info: () => undefined };

describe.skipIf(!sidecarInstalled)("a routed local model still arriving (F4 D7)", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let policy: BackgroundPolicy;
  let ai: AiService;
  let supervisor: JobSupervisor;
  let localModelId = "";
  const db = () => pool!;
  /** What each call of a task read: a result, or null ("no model"). */
  const answers: Array<"result" | "null"> = [];

  const call = async (task: "embedding" | "summarization", jobId: string) => {
    const result = await ai.runDefaultTask(task, "Retrieval practice outlasts massed study.", {
      jobId,
      ...(task === "embedding" ? { workloadClass: "embed" as const } : {}),
      budgetClass: "background"
    });
    answers.push(result ? "result" : "null");
    if (!result) throw new Error("errors.relationTypes.embeddingRequired");
    return result;
  };

  const lightJobs: LightJobRegistry = {
    [relationExplainBackfillJobType]: {
      needsModel: true,
      worker: "relations",
      execute: async (job) => {
        await call("embedding", job.id);
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
      await call("summarization", context.jobId);
      return { configured: true, generated: true };
    }
  };

  const setModelStatus = async (status: string) => {
    await db().query("update local_models set status = $2 where id = $1", [localModelId, status]);
    // Every writer of a local model's row moves the AI configuration's generation.
    bumpAiConfigGeneration();
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-routed-model-download-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_routed_model_download",
      user: "memora_routed_model_download",
      password: `routed-model-download-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    // One local profile serves embedding and summarization, routed by task.
    const config = createAiConfigRepository(pool);
    for (const table of [
      "ai_task_profile_routes",
      "ai_profile_tasks",
      "ai_profile_sets",
      "ai_provider_configs",
      "local_models"
    ])
      await pool.query(`delete from ${table}`);
    const model = await createLocalModelRepository(pool).upsertModel({
      catalogId: "test-local-model",
      modelId: "test-local-model",
      displayName: "Test local model",
      family: "test",
      variant: "test",
      repository: "test/test",
      revision: "0".repeat(40),
      runtime: "mlx",
      format: "safetensors",
      quantization: "4-bit",
      expectedSizeBytes: 1,
      manifestHash: "hash",
      capabilities: ["embedding", "summarization", "text-generation"],
      licenseName: "MIT",
      licenseUrl: "https://example.test/license"
    });
    localModelId = model.id;
    const profile = await config.createProfile({ name: "local", privacyMode: "offline_only" });
    await config.updateProfile({
      id: profile.id,
      localModelId: model.id,
      modelId: model.modelId,
      runtime: "mlx",
      capabilities: ["embedding", "summarization", "text-generation"],
      privacyMode: "offline_only"
    });
    for (const task of ["embedding", "summarization"]) {
      await config.setProfileTask({ profileId: profile.id, task });
      await config.setTaskRoute(task, profile.id);
    }
    policy = createBackgroundPolicy({
      getPool: () => pool ?? null,
      powerSource: null,
      isPackaged: false,
      env: {},
      wake: () => undefined,
      logger: quiet
    });
    await policy.controls.get();
    // As the app wires them (index.ts).
    ai = new AiService({
      userDataPath: join(workDir, "user-data"),
      getPool: () => pool ?? null,
      workspaceRoot: workspace,
      resourcesPath: workDir,
      isPackaged: false,
      logger: quiet,
      backgroundAdmission: policy.admission,
      onDownloadBlock: (jobId, blocker) => policy.gate.noteRefusal(jobId, blocker)
    });
    supervisor = new JobSupervisor({
      getPool: () => pool ?? null,
      lightJobs,
      knowledgeService: knowledgeService as never,
      backgroundPolicy: policy.jobs,
      logger: quiet
    });
  }, 120_000);

  afterAll(async () => {
    await supervisor?.stop().catch(() => undefined);
    await ai?.dispose().catch(() => undefined);
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("reads the routed model's install state where the route reads no model", async () => {
    const config = createAiConfigRepository(db());
    await setModelStatus("ready");
    expect(await config.getDefaultTask("embedding")).toMatchObject({ localModelId });
    expect(await config.getRoutedLocalModelStatus("embedding")).toBe("ready");
    await setModelStatus("verifying");
    expect(await config.getDefaultTask("embedding")).toBeNull();
    expect(await config.getRoutedLocalModelStatus("embedding")).toBe("verifying");
    // A key with a route chooses the profile first, as `getDefaultTask` does.
    expect(
      await config.getRoutedLocalModelStatus("embedding", undefined, ["class:none", "embedding"])
    ).toBe("verifying");
    // No route and no default profile: nothing is routed at all.
    expect(await config.getRoutedLocalModelStatus("structured-output")).toBeNull();
  });

  it("sets a task and an import aside while the model is verified, and frees them when it settles", async () => {
    await setModelStatus("verifying");
    const jobs = createJobRepository(db());
    const relationId = randomUUID();
    const backfill = await jobs.enqueueDeduped({
      type: relationExplainBackfillJobType,
      lane: "light",
      dedupeKey: relationExplainBackfillDedupeKey(relationId),
      payload: { relationId },
      debounce: { delayMs: 0, maxDelayMs: 0 }
    });
    // An import whose plan summarizes it.
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

    expect(await supervisor.runOnce()).toMatchObject({
      id: ingestion.id,
      status: "queued",
      attempts: 0,
      blockedClass: "download",
      blockedReason: "model_verifying"
    });
    expect(await runs.findById(run.id)).toMatchObject({
      status: "pending",
      error: null,
      stagesCheckpoint: { summarization: { status: "pending" } }
    });
    expect(await supervisor.runLightOnce("relations")).toMatchObject({
      id: backfill.job.id,
      status: "queued",
      attempts: 0,
      dedupeKey: relationExplainBackfillDedupeKey(relationId),
      blockedClass: "download",
      blockedReason: "model_verifying"
    });
    // No call read "no model", and nothing failed for good or counted toward a quarantine.
    expect(answers).toEqual([]);
    const ended = await db().query(
      "select type from jobs where status = 'failed' and type <> 'summarization'"
    );
    expect(ended.rowCount).toBe(0);
    const outcomes = await db().query(
      "select 1 from gardener_outcomes where consecutive_failures > 0 or quarantined_at is not null"
    );
    expect(outcomes.rowCount).toBe(0);

    // The verification failed: the download settled, which frees exactly these rows.
    await setModelStatus("failed");
    await policy.blockers.notify("download_settled");
    for (const id of [ingestion.id, backfill.job.id])
      expect((await jobs.findById(id))?.blockedClass).toBeNull();
    // A model that is not arriving reads "no model" as before: the task fails as it did.
    await db().query("update jobs set run_after = now() where id = $1", [backfill.job.id]);
    expect(await supervisor.runLightOnce("relations")).toMatchObject({
      id: backfill.job.id,
      blockedClass: null,
      attempts: 1
    });
    expect(answers).toEqual(["null"]);
  }, 60_000);
});
