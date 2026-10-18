import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAtomicNoteRelationRepository,
  createNotePageRepository,
  createPgPool,
  createRelationExplanationRepository,
  createRelationMatchRunRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  shownNoteRelationSql,
  withdrawnNoteRelationSql,
  type PgPool
} from "@app/db";

import { pickRelationsToOpen, runExplainProbe } from "./dev/explain-probe.js";
import { RelationExplanationService } from "./relation-explanation-service.js";

// F3 D22 on a real PostgreSQL database: the context SQL with the veto columns, the veto written
// through the visibility predicates with its event in a run of its own, the key of a written
// explanation with its writer, and the Note page judging explanations by that writer.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)(
  "explanations and the veto on a real PostgreSQL database",
  () => {
    let workDir = "";
    let manager: PostgresSidecarManager | undefined;
    let pool: PgPool | undefined;
    let aiRunId = "";
    const writer = { promptRevision: "prompt-3", model: "model-a" };

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-relation-explanation-"));
      let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
      for (let attempt = 1; !connection; attempt += 1) {
        manager = new PostgresSidecarManager({
          binDir: sidecar.binDir,
          dataDir: join(workDir, `data-${attempt}`),
          database: "memora_relation_explanation_test",
          user: "memora_relation_explanation_test",
          password: `relation-explanation-${randomUUID()}`,
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
      return { id, sourceId };
    };

    /** An applied `supports` relation between two fresh notes. */
    const seedRelation = async (status?: "accepted") => {
      const seeded = [await seedNote("Retrieval"), await seedNote("Feedback")].sort((a, b) =>
        a.id < b.id ? -1 : 1
      );
      const [first, second] = seeded.map((note) => note.id);
      const run = await createRelationMatchRunRepository(pool!).start({ kind: "match" });
      const written = await createAtomicNoteRelationRepository(pool!).upsert({
        loAtomicNoteId: first!,
        hiAtomicNoteId: second!,
        direction: "lo_to_hi",
        relationType: "supports",
        band: "apply",
        finalScore: 0.9,
        explanation: "knowledge.relations.explanations.reranked",
        runId: run.id,
        ...(status ? { status } : {})
      });
      return {
        id: written.relation.id,
        notes: [first!, second!] as const,
        sources: seeded.map((note) => note.sourceId).sort()
      };
    };

    const execution = (output: string) => ({
      output,
      taskType: "text-generation" as const,
      providerId: "openai-codex",
      modelId: "model-a",
      runtime: "remote" as const,
      durationMs: 5,
      profileId: randomUUID(),
      aiTaskRunId: aiRunId,
      outputLanguage: "en"
    });

    const build = (output: string) => {
      const runDefaultTask = vi.fn(async (...args: unknown[]) => {
        const logContext = args[2] as { onTextDelta?: (event: unknown) => void };
        logContext.onTextDelta?.({ kind: "text", delta: output });
        return execution(output);
      });
      const relationsChanged = vi.fn();
      const service = new RelationExplanationService({
        getPool: () => pool!,
        ai: { runDefaultTask } as never,
        getContentLanguage: async () => "en",
        resolveWriter: async () => writer,
        relationsChanged
      });
      return { service, runDefaultTask, relationsChanged };
    };

    const state = async (relationId: string) =>
      (
        await pool!.query<{
          status: string;
          vetoedAt: Date | null;
          vetoSource: string | null;
          shown: boolean;
          withdrawn: boolean;
        }>(
          `select r.status::text as status, r.vetoed_at as "vetoedAt", r.veto_source as "vetoSource",
                ${shownNoteRelationSql("r")} as shown, ${withdrawnNoteRelationSql("r")} as withdrawn
           from atomic_note_relations r where r.id = $1`,
          [relationId]
        )
      ).rows[0]!;

    it("withdraws a relation the writer finds unrelated: hidden, with its event, and asked once", async () => {
      const { id, notes, sources } = await seedRelation();
      expect(await state(id)).toMatchObject({ shown: true, withdrawn: false });
      const { service, runDefaultTask, relationsChanged } = build("NOT_RELATED");

      expect(await service.explain({ relationId: id })).toEqual({ relationId: id, vetoed: true });
      expect(await state(id)).toMatchObject({
        status: "pending_review",
        vetoSource: "explainer",
        shown: false,
        withdrawn: true
      });
      expect((await state(id)).vetoedAt).toBeInstanceOf(Date);
      expect(relationsChanged).toHaveBeenCalledWith([...notes].sort());
      // The verdict is cached under the key as the sentinel (never as an explanation), and the veto
      // is one `vetoed` event in a `veto` run.
      const cached = await pool!.query<{ text: string; inputHash: string }>(
        `select text, input_hash as "inputHash" from atomic_note_relation_explanations`
      );
      expect(cached.rows).toEqual([
        { text: "NOT_RELATED", inputHash: expect.stringMatching(/^[a-f0-9]{64}\.[a-f0-9]{16}$/u) }
      ]);
      const events = await pool!.query<{ kind: string; runKind: string; outcome: string | null }>(
        `select event.kind, run.kind as "runKind", run.outcome
         from relation_events event join relation_match_runs run on run.id = event.run_id
        where event.relation_id = $1 and event.kind = 'vetoed'`,
        [id]
      );
      expect(events.rows).toEqual([{ kind: "vetoed", runKind: "veto", outcome: "succeeded" }]);

      // The source relations promoted from a typed relation are promoted again for both roots.
      const promotions = await pool!.query<{ rootId: string }>(
        `select payload->>'rootId' as "rootId" from jobs
          where type = 'relation-promote' and status = 'queued' order by payload->>'rootId'`
      );
      expect(promotions.rows.map((row) => row.rootId)).toEqual(sources);

      // Opened again: the verdict is the answer, with no call, no second event and no second run.
      expect(await service.explain({ relationId: id })).toEqual({ relationId: id, vetoed: true });
      expect(runDefaultTask).toHaveBeenCalledTimes(1);
      expect(
        (await pool!.query("select 1 from relation_match_runs where kind = 'veto'")).rowCount
      ).toBe(1);
    });

    /** The writer's verdict rows and the veto traces of the library. */
    const traces = async () => ({
      cached: (
        await pool!.query(
          "select 1 from atomic_note_relation_explanations where text = 'NOT_RELATED'"
        )
      ).rowCount,
      promotions: (await pool!.query("select 1 from jobs where type = 'relation-promote'"))
        .rowCount,
      vetoRuns: (await pool!.query("select 1 from relation_match_runs where kind = 'veto'"))
        .rowCount,
      vetoEvents: (await pool!.query("select 1 from relation_events where kind = 'vetoed'"))
        .rowCount
    });

    const pageExplanation = async (relationId: string) => {
      const [self] = (
        await pool!.query<{ source: string }>(
          "select source_atomic_note_id as source from atomic_note_relations where id = $1",
          [relationId]
        )
      ).rows;
      return (await createNotePageRepository(pool!).readPage(self!.source, {
        relationLimit: 20,
        contentLanguage: "en",
        explanationWriter: writer
      }))!.relations.items.find((item) => item.id === relationId)?.explanation;
    };

    it("leaves a relation with a human verdict alone, caches the verdict and asks once", async () => {
      const { id } = await seedRelation("accepted");
      const { service, runDefaultTask, relationsChanged } = build("NOT_RELATED");
      // Nothing is withdrawn or explained: the owner kept it, and the writer disagrees.
      expect(await service.explain({ relationId: id })).toEqual({
        relationId: id,
        unrelated: true
      });
      expect(await state(id)).toMatchObject({ status: "accepted", vetoSource: null, shown: true });
      expect(relationsChanged).not.toHaveBeenCalled();
      expect(await traces()).toEqual({ cached: 1, promotions: 0, vetoRuns: 0, vetoEvents: 0 });

      // Opened again, also by a new service as after a restart: no call, the same answer.
      const restarted = build("NOT_RELATED");
      expect(await service.explain({ relationId: id })).toEqual({
        relationId: id,
        unrelated: true
      });
      expect(await restarted.service.explain({ relationId: id })).toEqual({
        relationId: id,
        unrelated: true
      });
      expect(runDefaultTask).toHaveBeenCalledTimes(1);
      expect(restarted.runDefaultTask).not.toHaveBeenCalled();
      expect(await traces()).toEqual({ cached: 1, promotions: 0, vetoRuns: 0, vetoEvents: 0 });
      expect(await state(id)).toMatchObject({ status: "accepted", shown: true });
      // The page never shows the sentinel as an explanation.
      expect(await pageExplanation(id)).toBeNull();

      // Another model reads the same notes again, once.
      const other = new RelationExplanationService({
        getPool: () => pool!,
        ai: { runDefaultTask: vi.fn(async () => execution("n1 gives n2 its evidence.")) } as never,
        getContentLanguage: async () => "en",
        resolveWriter: async () => ({ ...writer, model: "model-b" })
      });
      expect(await other.explain({ relationId: id })).toMatchObject({
        text: expect.stringContaining("gives")
      });
    });

    it("answers a kept relation the explainer had withdrawn with its cached verdict, and no call", async () => {
      const { id } = await seedRelation();
      const first = build("NOT_RELATED");
      expect(await first.service.explain({ relationId: id })).toEqual({
        relationId: id,
        vetoed: true
      });
      // The owner keeps it (the veto is cleared, the verdict is human).
      await pool!.query(
        `update atomic_note_relations set status = 'accepted', vetoed_at = null, veto_source = null
          where id = $1`,
        [id]
      );
      const kept = build("NOT_RELATED");
      expect(await kept.service.explain({ relationId: id })).toEqual({
        relationId: id,
        unrelated: true
      });
      expect(kept.runDefaultTask).not.toHaveBeenCalled();
      expect(await state(id)).toMatchObject({ status: "accepted", shown: true, withdrawn: false });
    });

    it("answers a relation the typer withdrew with the veto, caches the verdict and asks once", async () => {
      const { id } = await seedRelation();
      const run = await createRelationMatchRunRepository(pool!).start({ kind: "veto" });
      await createAtomicNoteRelationRepository(pool!).veto(id, "typer", run.id);
      const first = build("NOT_RELATED");
      expect(await first.service.explain({ relationId: id })).toEqual({
        relationId: id,
        vetoed: true
      });
      // The typer's veto stays its own: no second veto, event or promotion.
      expect(await state(id)).toMatchObject({ vetoSource: "typer", withdrawn: true });
      expect(first.relationsChanged).not.toHaveBeenCalled();
      expect((await traces()).vetoEvents).toBe(1);

      const second = build("NOT_RELATED");
      expect(await second.service.explain({ relationId: id })).toEqual({
        relationId: id,
        vetoed: true
      });
      expect(first.runDefaultTask).toHaveBeenCalledTimes(1);
      expect(second.runDefaultTask).not.toHaveBeenCalled();
      expect(await traces()).toMatchObject({ cached: 1, vetoEvents: 1 });
    });

    it("does not withdraw a relation to an earlier version of a note: no list would show it", async () => {
      const { id, notes } = await seedRelation();
      await pool!.query(
        "update atomic_notes set supersession_status = 'superseded' where id = $1",
        [notes[0]]
      );
      const context = await createRelationExplanationRepository(pool!).readContext(id);
      expect(context).toMatchObject({ listed: true, vetoable: false, withdrawn: false });

      const { service, runDefaultTask, relationsChanged } = build("NOT_RELATED");
      expect(await service.explain({ relationId: id })).toEqual({
        relationId: id,
        unrelated: true
      });
      expect((await state(id)).vetoedAt).toBeNull();
      expect(relationsChanged).not.toHaveBeenCalled();
      expect(await traces()).toEqual({ cached: 1, promotions: 0, vetoRuns: 0, vetoEvents: 0 });

      expect(await service.explain({ relationId: id })).toEqual({
        relationId: id,
        unrelated: true
      });
      expect(runDefaultTask).toHaveBeenCalledTimes(1);
    });

    it("stores an explanation under the key with its writer and reuses it with no call", async () => {
      const { id } = await seedRelation();
      const first = build("n1 gives n2 its evidence.");
      const written = await first.service.explain({ relationId: id });
      expect(written).toMatchObject({ relationId: id, writtenBy: "model-a" });
      expect(first.runDefaultTask).toHaveBeenCalledTimes(1);
      const stored = (
        await pool!.query<{ inputHash: string; promptVersion: string }>(
          `select input_hash as "inputHash", prompt_version as "promptVersion"
           from atomic_note_relation_explanations where relation_id = $1`,
          [id]
        )
      ).rows[0]!;
      expect(stored.inputHash).toMatch(/^[a-f0-9]{64}\.[a-f0-9]{16}$/u);
      expect(stored.promptVersion).toBe("relation-explanation-v3");

      // A second open (a new service, as after a restart) makes no call.
      const second = build("n1 gives n2 its evidence.");
      expect(await second.service.explain({ relationId: id })).toEqual(written);
      expect(second.runDefaultTask).not.toHaveBeenCalled();

      // Another model writes it again on the next open.
      const other = new RelationExplanationService({
        getPool: () => pool!,
        ai: { runDefaultTask: vi.fn(async () => execution("n2 is evidence for n1.")) } as never,
        getContentLanguage: async () => "en",
        resolveWriter: async () => ({ ...writer, model: "model-b" })
      });
      expect(await other.explain({ relationId: id })).toMatchObject({
        text: expect.stringContaining("is evidence for")
      });

      // The Note page judges it by the writer too (the third open above stored model-b's).
      const [self] = (
        await pool!.query<{ source: string }>(
          "select source_atomic_note_id as source from atomic_note_relations where id = $1",
          [id]
        )
      ).rows;
      const pageOf = async (explanationWriter?: typeof writer | null) =>
        (await createNotePageRepository(pool!).readPage(self!.source, {
          relationLimit: 20,
          contentLanguage: "en",
          ...(explanationWriter === undefined ? {} : { explanationWriter })
        }))!.relations.items[0]?.explanation;
      expect(await pageOf({ ...writer, model: "model-b" })).toMatchObject({ writtenBy: "model-a" });
      expect(await pageOf(writer)).toBeNull();
      expect(await pageOf(null)).toMatchObject({ writtenBy: "model-a" });
    });

    it("probes the opens of a library: picks the shown relations without an explanation and opens each twice", async () => {
      const open = await seedRelation();
      const explained = await seedRelation();
      const withdrawn = await seedRelation();
      await build("n1 gives n2 its evidence.").service.explain({ relationId: explained.id });
      await build("NOT_RELATED").service.explain({ relationId: withdrawn.id });
      // Only a shown relation that has no explanation is a relation to open.
      expect(await pickRelationsToOpen(pool!, 10)).toEqual([open.id]);

      const { runDefaultTask } = build("n1 and n2 share the evidence.");
      const userDataPath = join(workDir, ".cache/profiles/clone");
      await mkdir(userDataPath, { recursive: true });
      const outcome = await runExplainProbe({
        env: {
          MEMORA_DEV_EXPLAIN_PROBE: ".cache/f3/t59/probe.json",
          MEMORA_DEV_EXPLAIN_PROBE_OPENS: "5"
        },
        isPackaged: false,
        workspaceRoot: workDir,
        userDataPath,
        pool: pool!,
        ai: { runDefaultTask } as never,
        getContentLanguage: async () => "en",
        resolveWriter: async () => writer,
        logger: { info: vi.fn(), error: vi.fn() }
      });
      expect(outcome).toBe("done");
      const report = JSON.parse(
        await readFile(join(workDir, ".cache/f3/t59/probe.json"), "utf8")
      ) as {
        opens: number;
        secondOpenMakesNoCall: boolean;
        firstOpen: { calls: number; explained: number; streamed: number; opens: unknown[] };
        secondOpen: { calls: number; explained: number; streamed: number };
      };
      expect(report.opens).toBe(1);
      expect(report.firstOpen).toMatchObject({ calls: 1, explained: 1, streamed: 1 });
      expect(runDefaultTask).toHaveBeenCalledTimes(1);
      // The second open reads the stored explanation: no call, no stream.
      expect(report.secondOpen).toMatchObject({ calls: 0, explained: 1, streamed: 0 });
      expect(report.secondOpenMakesNoCall).toBe(true);
    });

    it("keeps the second-open bar when a relation the owner kept is one the writer calls unrelated", async () => {
      const kept = await seedRelation("accepted");
      await seedRelation();
      const runDefaultTask = vi.fn(async () => execution("NOT_RELATED"));
      const userDataPath = join(workDir, ".cache/profiles/clone");
      await mkdir(userDataPath, { recursive: true });
      const outcome = await runExplainProbe({
        env: {
          MEMORA_DEV_EXPLAIN_PROBE: ".cache/f3/t59/kept.json",
          MEMORA_DEV_EXPLAIN_PROBE_OPENS: "5"
        },
        isPackaged: false,
        workspaceRoot: workDir,
        userDataPath,
        pool: pool!,
        ai: { runDefaultTask } as never,
        getContentLanguage: async () => "en",
        resolveWriter: async () => writer,
        logger: { info: vi.fn(), error: vi.fn() }
      });
      expect(outcome).toBe("done");
      const report = JSON.parse(await readFile(join(workDir, ".cache/f3/t59/kept.json"), "utf8"));
      expect(report.opens).toBe(2);
      expect(report.firstOpen).toMatchObject({ calls: 2, vetoed: 1, unrelated: 1 });
      expect(report.secondOpen).toMatchObject({ calls: 0, vetoed: 1, unrelated: 1 });
      expect(report.secondOpenMakesNoCall).toBe(true);
      expect(await state(kept.id)).toMatchObject({ status: "accepted", shown: true });
    });

    it("lists a withdrawn relation as explainable but never as shown", async () => {
      const { id } = await seedRelation();
      const { service } = build("NOT_RELATED");
      await service.explain({ relationId: id });
      const context = await createRelationExplanationRepository(pool!).readContext(id);
      expect(context).toMatchObject({
        listed: true,
        vetoable: false,
        withdrawn: true,
        vetoSource: "explainer"
      });
    });
  }
);
