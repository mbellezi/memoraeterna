import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createIngestionRunRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { isGraphIncomplete } from "@app/domain";

import { manualRetryStages } from "./job-retry.js";

// The stage-level retry of a run that ended "graph incomplete" (F3 D25, R25) against a real
// database: the run keeps `succeeded` with its graph stage `failed`, and the retry reopens that
// stage alone, keeping the batches the failed stage had finished.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("the stage-level retry on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-stage-retry-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_stage_retry_test",
        user: "memora_stage_retry_test",
        password: `stage-retry-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  const stageRow = async (runId: string, stage: string) =>
    (
      await pool!.query<{
        status: string;
        skipReason: string | null;
        error: string | null;
        metadata: Record<string, unknown>;
      }>(
        `select status::text as status, skip_reason as "skipReason", error, metadata
         from ingestion_run_stages where ingestion_run_id = $1 and stage = $2`,
        [runId, stage]
      )
    ).rows[0];

  /** A run that ended succeeded with its graph failed after one batch, and its matching waiting. */
  const finishedRun = async () => {
    const sourceId = randomUUID();
    await pool!.query(
      `insert into source_items (id, type, title) values ($1, 'PersonalNote', 'Graph incomplete')`,
      [sourceId]
    );
    const runs = createIngestionRunRepository(pool!);
    const run = await runs.create({
      sourceItemId: sourceId,
      status: "running",
      effectiveStages: ["atomicNotes", "knowledgeGraph", "atomicNoteMatching", "sourceMatching"]
    });
    await runs.completeStage(run.id, "atomicNotes", { noteIds: ["note-1"] });
    await runs.beginStage(run.id, "knowledgeGraph");
    await runs.updateStageProgress(run.id, "knowledgeGraph", 0.5, {
      completed: 1,
      total: 2,
      completedBatches: [{ batch: "b1" }]
    });
    await runs.failStage(run.id, "knowledgeGraph", "errors.knowledgeGraph.invalidOutput");
    await runs.skipStage(run.id, "atomicNoteMatching", "waiting_for_decider");
    await runs.skipStage(run.id, "sourceMatching", "waiting_for_decider");
    await runs.complete(run.id);
    return { runs, id: run.id };
  };

  it("ends a run succeeded with a failed graph stage: graph incomplete", async () => {
    const { runs, id } = await finishedRun();
    const run = (await runs.findById(id))!;
    expect(run.status).toBe("succeeded");
    expect(isGraphIncomplete(run)).toBe(true);
    expect(await stageRow(id, "knowledgeGraph")).toMatchObject({
      status: "failed",
      error: "errors.knowledgeGraph.invalidOutput"
    });
  });

  it("reopens the graph alone and keeps the batches it had finished", async () => {
    const { runs, id } = await finishedRun();
    const run = (await runs.findById(id))!;
    expect(manualRetryStages(run)).toEqual([
      "knowledgeGraph",
      "atomicNoteMatching",
      "sourceMatching"
    ]);
    const reopened = await runs.reopenStages(id, ["knowledgeGraph"]);
    expect(reopened).toMatchObject({ status: "pending", currentStage: "knowledgeGraph" });
    // The stage's checkpoint keeps only the finished batches, with no status: the resume re-runs it.
    expect(reopened!.stagesCheckpoint.knowledgeGraph).toEqual({
      metadata: { completed: 1, total: 2, completedBatches: [{ batch: "b1" }] }
    });
    expect(reopened!.stagesCheckpoint.atomicNotes).toMatchObject({ status: "completed" });
    expect(reopened!.stagesCheckpoint.atomicNoteMatching).toMatchObject({ status: "skipped" });
    expect(await stageRow(id, "knowledgeGraph")).toMatchObject({
      status: "pending",
      error: null,
      metadata: { completedBatches: [{ batch: "b1" }] }
    });
    expect(await stageRow(id, "atomicNoteMatching")).toMatchObject({ status: "skipped" });
    expect(isGraphIncomplete(reopened!)).toBe(false);
  });

  it("starts a stage that was skipped clean, and reopens nothing for a run still working", async () => {
    const { runs, id } = await finishedRun();
    await runs.reopenStages(id, ["atomicNoteMatching", "sourceMatching"]);
    expect((await runs.findById(id))!.stagesCheckpoint.atomicNoteMatching).toBeUndefined();
    expect(await stageRow(id, "atomicNoteMatching")).toMatchObject({
      status: "pending",
      skipReason: null,
      metadata: {}
    });
    // The run is pending now: it is not finished, so a second reopening writes nothing.
    expect(await runs.reopenStages(id, ["knowledgeGraph"])).toBeNull();
    expect(await stageRow(id, "knowledgeGraph")).toMatchObject({ status: "failed" });
  });
});
