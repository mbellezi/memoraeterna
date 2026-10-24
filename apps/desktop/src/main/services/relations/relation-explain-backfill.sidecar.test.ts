import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAtomicNoteRelationRepository,
  createJobRepository,
  createPgPool,
  createRelationExplanationRepository,
  createRelationMatchRunRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  withdrawnNoteRelationSql,
  type PgPool
} from "@app/db";
import { relationExplainBackfillConfig, resultStatusStates } from "@app/domain";

import { RelationExplanationService } from "../relation-explanation-service.js";
import {
  explainBackfillExecutor,
  explainBackfillStatus,
  relationExplainBackfillJobType,
  relationExplainBackfillPassKey,
  runExplainBackfillPass,
  scheduleExplainBackfillPass
} from "./relation-explain-backfill.js";

// The explanation backfill (F4 D18, T84) on a real PostgreSQL database: which relations a pass
// selects (shown relations of notes opened lately, with no explanation), the day's allowance, the
// jobs it queues, and a job that writes at P3 in the background or withdraws a relation its writer
// finds unrelated, exactly as an open would.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe("the backfill's job statuses (spec 3.1b)", () => {
  it("map every outcome to a done, no-change or blocker row", () => {
    for (const outcome of [
      "written",
      "current",
      "vetoed",
      "unrelated",
      "gone",
      "no_writer"
    ] as const) {
      const state = resultStatusStates[explainBackfillStatus(outcome)];
      expect(state, outcome).toBeDefined();
      expect(state!.state, outcome).not.toBe("failed");
    }
    expect(resultStatusStates[explainBackfillStatus("no_writer")]).toMatchObject({
      state: "blocked"
    });
  });
});

describe.skipIf(!sidecarInstalled)("the explanation backfill on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let aiRunId = "";
  const writer = { promptRevision: "prompt-3", model: "model-a" };
  const now = new Date();

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-explain-backfill-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_explain_backfill_test",
        user: "memora_explain_backfill_test",
        password: `explain-backfill-${randomUUID()}`,
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
    aiRunId = (
      await pool.query<{ id: string }>(
        `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, finished_at)
         values ('text-generation', 'verify', 'writer-model', 'remote', 1, 'succeeded', now()) returning id`
      )
    ).rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const db = pool!;
    await db.query("delete from atomic_note_relation_explanations");
    await db.query("delete from relation_events");
    await db.query("delete from relation_match_runs");
    await db.query("delete from atomic_note_relations");
    await db.query("delete from jobs");
    await db.query("delete from gardener_outcomes");
    await db.query("delete from view_history");
    await db.query("delete from settings where key = $1", [
      relationExplainBackfillConfig.dailySettingKey
    ]);
  });

  /** A source with a document and a chunk, and a note on it with current evidence. */
  const seedNote = async (title: string) => {
    const db = pool!;
    const sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID(),
      id = randomUUID();
    await db.query(`insert into source_items (id, type, title) values ($1, 'PersonalNote', $2)`, [
      sourceId,
      title
    ]);
    await db.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [documentId, sourceId, title, `hash-${documentId}`]
    );
    await db.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, $4, $5)`,
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, 'pending_review', 'current', 'source', $5, $5, $6, 'seed', 'seed',
               'local', 'seed', $7)`,
      [id, title, `${title} body.`, `${title} idea.`, sourceId, chunkId, `key-${id}`]
    );
    return id;
  };

  /** An applied `supports` relation between two fresh notes. */
  const seedRelation = async (name: string) => {
    const [first, second] = [await seedNote(`${name} A`), await seedNote(`${name} B`)].sort();
    const run = await createRelationMatchRunRepository(pool!).start({ kind: "match" });
    const written = await createAtomicNoteRelationRepository(pool!).upsert({
      loAtomicNoteId: first!,
      hiAtomicNoteId: second!,
      direction: "lo_to_hi",
      relationType: "supports",
      band: "apply",
      finalScore: 0.9,
      explanation: "knowledge.relations.explanations.reranked",
      runId: run.id
    });
    return { id: written.relation.id, notes: [first!, second!] as const };
  };

  const opened = async (noteId: string, daysAgo = 0) => {
    await pool!.query(
      `insert into view_history (kind, object_id, address, title, opened_at)
       values ('note', $1::uuid, 'memora://note/' || $1::text, 'Note', now() - make_interval(days => $2::int))`,
      [noteId, daysAgo]
    );
  };

  const queuedBackfills = async () =>
    (
      await pool!.query<{
        dedupeKey: string;
        payload: Record<string, unknown>;
        subjectKey: string | null;
        scopeKey: string | null;
        priority: number;
      }>(
        `select dedupe_key as "dedupeKey", payload, subject_key as "subjectKey",
                scope_key as "scopeKey", priority
           from jobs where type = $1 and status = 'queued' and payload ? 'relationId'
          order by dedupe_key`,
        [relationExplainBackfillJobType]
      )
    ).rows;

  it("selects the shown relations of notes opened lately with no explanation, within the day's allowance", async () => {
    const fresh = await seedRelation("Fresh");
    const second = await seedRelation("Second");
    const third = await seedRelation("Third");
    const unopened = await seedRelation("Unopened");
    const explained = await seedRelation("Explained");
    const old = await seedRelation("Old");
    const kept = await seedRelation("Withdrawn");
    for (const relation of [fresh, second, third, explained, kept]) await opened(relation.notes[0]);
    await opened(old.notes[1], relationExplainBackfillConfig.openedWithinDays + 3);
    await createRelationExplanationRepository(pool!).save({
      relationId: explained.id,
      text: "Already explained.",
      inputHash: "facts",
      promptVersion: "v3",
      provider: "openai-codex",
      model: "model-a",
      runtime: "remote",
      aiTaskRunId: aiRunId,
      language: "en"
    });
    await pool!.query(
      "update atomic_note_relations set vetoed_at = now(), veto_source = 'explainer' where id = $1",
      [kept.id]
    );
    const config = { ...relationExplainBackfillConfig, dailyRelations: 2 };

    const first = await runExplainBackfillPass(pool!, { now, config });
    expect(first).toEqual({ remaining: 2, queued: 2 });
    const queued = await queuedBackfills();
    expect(queued).toHaveLength(2);
    const eligible = new Set([fresh.id, second.id, third.id]);
    for (const job of queued) {
      const relationId = job.payload.relationId as string;
      expect(eligible.has(relationId)).toBe(true);
      expect(job).toMatchObject({
        dedupeKey: `${relationExplainBackfillJobType}:${relationId}`,
        subjectKey: `relation:${relationId}`,
        scopeKey: null,
        priority: -10
      });
    }
    // The day's allowance is spent: a second pass (a restart) queues nothing more.
    expect(await runExplainBackfillPass(pool!, { now, config })).toEqual({
      remaining: 0,
      queued: 0
    });
    // A new day: the third eligible relation, never one already queued.
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect(await runExplainBackfillPass(pool!, { now: tomorrow, config })).toEqual({
      remaining: 2,
      queued: 1
    });
    expect(new Set((await queuedBackfills()).map((job) => job.payload.relationId))).toEqual(
      eligible
    );
    void unopened;
  });

  it("queues the pass a while after the start and again a day after it ran", async () => {
    const jobs = createJobRepository(pool!);
    const job = await scheduleExplainBackfillPass(jobs, relationExplainBackfillConfig.startDelayMs);
    expect(job.payload).toEqual({ pass: true });
    expect(job.runAfter.getTime()).toBeGreaterThan(Date.now() + 60_000);
    // A second start keeps the queued pass.
    expect((await scheduleExplainBackfillPass(jobs, 1_000)).id).toBe(job.id);
    const executor = explainBackfillExecutor({
      getPool: () => pool!,
      backfill: async () => "written",
      now: () => now
    });
    // As a worker claims it: the claim keeps the dropped dedupe key beside the task (T74).
    const result = await executor.execute(
      { ...job, payload: { pass: true, claimedDedupeKey: relationExplainBackfillPassKey } },
      new AbortController().signal
    );
    expect(result).toEqual({ status: "completed", remaining: 20, queued: 0 });
    // A DEV override (the soak's drop step 3) lowers the day's allowance for the next pass.
    const lowered = explainBackfillExecutor({
      getPool: () => pool!,
      backfill: async () => "written",
      now: () => now,
      dailyRelations: () => 10
    });
    expect(
      await lowered.execute({ ...job, payload: { pass: true } }, new AbortController().signal)
    ).toEqual({ status: "completed", remaining: 10, queued: 0 });
    const next = await pool!.query<{ runAfter: Date }>(
      `select run_after as "runAfter" from jobs where dedupe_key = $1 and status = 'queued'`,
      [relationExplainBackfillPassKey]
    );
    // The pass ran outside a worker here: its queued row was the one it re-dated.
    expect(next.rows[0]!.runAfter.getTime()).toBeGreaterThanOrEqual(job.runAfter.getTime());
  });

  it("writes at P3 in the background, and withdraws a relation its writer finds unrelated", async () => {
    const explained = await seedRelation("Explained");
    const unrelated = await seedRelation("Unrelated");
    const outputs = new Map([
      [explained.id, "n1 supports what n2 reports."],
      [unrelated.id, "NOT_RELATED"]
    ]);
    let current = "";
    const runDefaultTask = vi.fn(async (...args: unknown[]) => {
      void args;
      return {
        output: outputs.get(current)!,
        taskType: "text-generation" as const,
        providerId: "openai-codex",
        modelId: "model-a",
        runtime: "remote" as const,
        durationMs: 5,
        profileId: randomUUID(),
        aiTaskRunId: aiRunId,
        outputLanguage: "en"
      };
    });
    const relationsChanged = vi.fn();
    const service = new RelationExplanationService({
      getPool: () => pool!,
      ai: { runDefaultTask } as never,
      getContentLanguage: async () => "en",
      resolveWriter: async () => writer,
      relationsChanged
    });
    const executor = explainBackfillExecutor({
      getPool: () => pool!,
      backfill: (relationId, options) => service.backfill(relationId, options)
    });
    const jobs = createJobRepository(pool!);
    const run = async (relationId: string) => {
      current = relationId;
      const job = await jobs.create({
        type: relationExplainBackfillJobType,
        lane: "light",
        payload: { relationId }
      });
      const signal = new AbortController().signal;
      return {
        job,
        fingerprint: await executor.fingerprint!(job, signal),
        result: await executor.execute(job, signal)
      };
    };

    const first = await run(explained.id);
    expect(first.result).toEqual({ status: "completed", outcome: "written" });
    const [, , context] = runDefaultTask.mock.calls[0]!;
    expect(context).toMatchObject({
      stage: "relation_explanation_backfill",
      priority: "P3",
      budgetClass: "background",
      workloadClass: "write-fast",
      jobId: first.job.id
    });
    // Nobody watches a backfill: it streams to no card.
    expect(context).not.toHaveProperty("onTextDelta");
    const cached = await createRelationExplanationRepository(pool!).readContext(explained.id);
    expect(cached?.stored?.text).toContain("supports what");
    // The content fingerprint: the same facts read the same, whoever writes them.
    expect(first.fingerprint).toMatch(/^gf1:[0-9a-f]{64}$/u);
    expect(await executor.fingerprint!(first.job, new AbortController().signal)).toBe(
      first.fingerprint
    );
    // Asked again, the cached explanation is the answer: no call.
    const calls = runDefaultTask.mock.calls.length;
    expect((await run(explained.id)).result).toEqual({ status: "current", outcome: "current" });
    expect(runDefaultTask.mock.calls.length).toBe(calls);

    const vetoed = await run(unrelated.id);
    expect(vetoed.result).toEqual({ status: "applied", outcome: "vetoed" });
    const state = (
      await pool!.query<{ withdrawn: boolean; vetoSource: string | null }>(
        `select ${withdrawnNoteRelationSql("r")} as withdrawn, r.veto_source as "vetoSource"
           from atomic_note_relations r where r.id = $1`,
        [unrelated.id]
      )
    ).rows[0]!;
    expect(state).toEqual({ withdrawn: true, vetoSource: "explainer" });
    expect(relationsChanged).toHaveBeenCalledWith(expect.arrayContaining([...unrelated.notes]));
  });
});
