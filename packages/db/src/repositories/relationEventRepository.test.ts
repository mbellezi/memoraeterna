import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createAtomicNoteRelationRepository } from "./atomicNoteRelationRepository.js";
import {
  createRelationEventRepository,
  relationEventKinds,
  relationEventRelationKinds,
  type RelationEventKind,
  type RelationEventRelationKind
} from "./relationEventRepository.js";
import {
  createRelationMatchRunRepository,
  relationMatchRunKinds,
  type RelationMatchRunKind
} from "./relationMatchRunRepository.js";

// Relation events and match runs (F3 D14, I-R8) against a real PostgreSQL database: every event
// kind round-trips, a run is reverted to the byte (created, typed, vetoed and promoted rows alike),
// and a revert that a later run, an open run or a change outside the log blocks names why and
// changes nothing. The migration itself is verified by `npm run db:relations:verify`.
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const tables = { note: "atomic_note_relations", source: "source_relations" } as const;

describe.skipIf(!sidecarInstalled)(
  "relation events and match runs on a real PostgreSQL database",
  () => {
    let workDir = "";
    let manager: PostgresSidecarManager | undefined;
    let pool: PgPool | undefined;
    const db = () => pool!;
    const noteRelations = () => createAtomicNoteRelationRepository(db());
    const events = () => createRelationEventRepository(db());
    const runs = () => createRelationMatchRunRepository(db());
    const works: Record<"x" | "y", { id: string; chunk: string }> = {
      x: { id: "", chunk: "" },
      y: { id: "", chunk: "" }
    };

    /** A finished-by-default run: the revert refuses an open one. */
    const startRun = async (kind: RelationMatchRunKind = "link") =>
      (await runs().start({ kind })).id;
    const finishRun = (id: string) => runs().finish(id, { outcome: "completed" });

    async function note(title: string, home: "x" | "y"): Promise<string> {
      const id = randomUUID();
      await db().query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
         created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key, ownership)
       values ($1::uuid, $2, 'Body', $3, 'active', 'current', $4, $5, 'test', 'test', 'local', 'test',
               $1::uuid::text, 'source')`,
        [id, title, `Idea of ${title}`, works[home].id, works[home].chunk]
      );
      return id;
    }

    /** A decided pair of two fresh notes, written in `runId` (its event comes from the upsert). */
    async function pair(
      runId: string,
      options: { type?: string | null; band?: "apply" | "suggest"; status?: "accepted" } = {}
    ) {
      const [a, b] = [await note("A", "x"), await note("B", "y")];
      const written = await noteRelations().upsertDecided({
        subjectAtomicNoteId: a,
        objectAtomicNoteId: b,
        relationType: options.type === undefined ? "supports" : options.type,
        band: options.band ?? "apply",
        probability: 0.91,
        deciderKey: "ranker-v2",
        finalScore: 0.91,
        explanation: "knowledge.relations.explanations.reranked",
        runId,
        ...(options.status ? { status: options.status } : {})
      });
      return { a, b, relation: written.relation, eventId: written.eventId };
    }

    /** Re-decides a pair (a type or band change) in `runId`. */
    const retype = (
      a: string,
      b: string,
      runId: string,
      input: { type: string | null; band?: "apply" | "suggest" }
    ) =>
      noteRelations().upsertDecided({
        subjectAtomicNoteId: a,
        objectAtomicNoteId: b,
        relationType: input.type,
        band: input.band ?? "apply",
        probability: 0.8,
        deciderKey: "ranker-v2",
        finalScore: 0.8,
        explanation: "knowledge.relations.explanations.reranked",
        runId
      });

    /** The row as the database renders it, exactly as an event stores it. */
    const image = async (relationKind: RelationEventRelationKind, id: string) =>
      (
        await db().query<{ image: string }>(
          `select to_jsonb(r)::text as image from ${tables[relationKind]} r where r.id = $1::uuid`,
          [id]
        )
      ).rows[0]?.image ?? null;

    /** Records an event whose images are the rows' own text, with no trip through JavaScript. */
    async function record(
      runId: string,
      kind: RelationEventKind,
      relationKind: RelationEventRelationKind,
      relationId: string,
      pairKey: string,
      before: string | null,
      after: string | null
    ) {
      await db().query(
        `insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
       values ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb, $7::jsonb)`,
        [runId, relationKind, relationId, pairKey, kind, before, after]
      );
    }

    /** A source relation's pair key: its root pair and type, made unique here by the relation ID. */
    const sourcePairKey = (id: string, type = "supports") =>
      `${works.x.id}:${works.y.id}:${type}:${id}`;

    /** A promoted source relation of x to y, with an unusually large number in its metadata. */
    async function promoted(runId: string, type: string, supportCount: number, key = randomUUID()) {
      const id = randomUUID();
      await db().query(
        `insert into source_relations (id, identity_key, source_item_id, target_source_item_id,
         relation_type, origin, support_count, metadata)
       values ($1::uuid, $2, $3, $4, $5, 'promoted', $6, '{"fingerprint": 12345678901234567890.123456789}'::jsonb)`,
        [id, key, works.x.id, works.y.id, type, supportCount]
      );
      await record(
        runId,
        "promoted",
        "source",
        id,
        sourcePairKey(id, type),
        null,
        await image("source", id)
      );
      return id;
    }

    async function setSupport(runId: string, id: string, supportCount: number) {
      const before = await image("source", id);
      await db().query(
        "update source_relations set support_count = $2, updated_at = clock_timestamp() where id = $1::uuid",
        [id, supportCount]
      );
      await record(
        runId,
        "promoted",
        "source",
        id,
        sourcePairKey(id),
        before,
        await image("source", id)
      );
    }

    async function retire(runId: string, id: string) {
      const before = await image("source", id);
      await db().query("delete from source_relations where id = $1::uuid", [id]);
      await record(runId, "retired", "source", id, sourcePairKey(id), before, null);
    }

    /** Every relation row of both tables, as the database renders it. */
    async function snapshot() {
      return (
        await db().query<{ key: string; image: string }>(
          `select 'note:' || id::text as key, to_jsonb(r)::text as image from atomic_note_relations r
         union all
         select 'source:' || id::text, to_jsonb(s)::text from source_relations s
         order by 1`
        )
      ).rows;
    }

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-relation-events-"));
      let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
      for (let attempt = 1; !connection; attempt += 1) {
        manager = new PostgresSidecarManager({
          binDir: sidecar.binDir,
          dataDir: join(workDir, `data-${attempt}`),
          database: "memora_relation_events_test",
          user: "memora_relation_events_test",
          password: `relation-events-${randomUUID()}`,
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
      await runMigrations(pool, resolve(workspace, "packages/db/drizzle"), {
        seedFolder: resolve(workspace, "packages/db/seed")
      });
      for (const key of ["x", "y"] as const) {
        const source = randomUUID(),
          document = randomUUID(),
          chunk = randomUUID();
        await db().query(
          "insert into source_items (id, type, title) values ($1, 'StandaloneArticle', $2)",
          [source, `Work ${key}`]
        );
        await db().query(
          `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'text', $3)`,
          [document, source, `doc-${key}`]
        );
        await db().query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, 0, 'Passage', $4)`,
          [chunk, document, source, `chunk-${key}`]
        );
        works[key] = { id: source, chunk };
      }
    }, 120_000);

    afterAll(async () => {
      if (pool) await closePgPool(pool);
      if (manager) await manager.stop().catch(() => undefined);
      if (workDir) await rm(workDir, { recursive: true, force: true });
    });

    it("opens a run, finishes it once and lists runs newest first", async () => {
      const started = await runs().start({
        kind: "link",
        rootId: works.x.id,
        deciderKey: "ranker-v2",
        calibrationVersion: "cal-1"
      });
      expect(started).toMatchObject({
        kind: "link",
        rootId: works.x.id,
        deciderKey: "ranker-v2",
        calibrationVersion: "cal-1",
        finishedAt: null,
        outcome: null,
        counts: {},
        timings: {}
      });
      expect(started.startedAt).toBeInstanceOf(Date);
      const finished = await runs().finish(started.id, {
        outcome: "completed",
        counts: { applied: 3, typed: 2 },
        timings: { totalMs: 41 }
      });
      expect(finished).toMatchObject({
        id: started.id,
        outcome: "completed",
        counts: { applied: 3, typed: 2 },
        timings: { totalMs: 41 }
      });
      expect(finished?.finishedAt).toBeInstanceOf(Date);
      // A run finishes once; a missing run finishes nothing.
      expect(await runs().finish(started.id, { outcome: "failed" })).toBeNull();
      expect(await runs().finish(randomUUID(), { outcome: "failed" })).toBeNull();
      expect((await runs().get(started.id))?.outcome).toBe("completed");
      expect(await runs().get(randomUUID())).toBeNull();

      // Counts and timings stay when a finish gives none; `reverted` is only set by a revert.
      const plain = await runs().start({ kind: "type", rootId: works.x.id });
      await runs().finish(plain.id, { outcome: "deferred" });
      expect(await runs().get(plain.id)).toMatchObject({ outcome: "deferred", counts: {} });
      const other = await runs().start({ kind: "discover", rootId: works.y.id });
      await expect(runs().finish(other.id, { outcome: "reverted" })).rejects.toThrow("reverting");
      await expect(runs().finish(other.id, { outcome: "" })).rejects.toThrow("outcome");
      await expect(runs().finish(other.id, { outcome: "x".repeat(201) })).rejects.toThrow(
        "outcome"
      );
      await expect(
        runs().start({ kind: "guess" as unknown as RelationMatchRunKind })
      ).rejects.toThrow("kind");

      const listed = await runs().list({ rootId: works.x.id, limit: 10 });
      expect(listed.map((run) => run.id).slice(0, 2)).toEqual([plain.id, started.id]);
      expect(listed.every((run) => run.rootId === works.x.id)).toBe(true);
      expect((await runs().list({ kind: "discover" })).map((run) => run.id)).toContain(other.id);
      expect((await runs().list({ rootId: works.y.id, kind: "link" })).length).toBe(0);
      // The run kinds of the repository are the database's.
      const check = (
        await db().query<{ definition: string }>(
          `select pg_get_constraintdef(oid) as definition from pg_constraint
          where conname = 'relation_match_runs_values'`
        )
      ).rows[0]!.definition;
      const checked = [...check.matchAll(/'([a-z]+)'::text/gu)]
        .map((match) => match[1])
        .filter((value) => value !== "object");
      expect(new Set(checked)).toEqual(new Set(relationMatchRunKinds));
      for (const kind of relationMatchRunKinds) {
        expect((await runs().start({ kind })).kind).toBe(kind);
      }
    });

    it("round-trips every event kind on both relation kinds, with no foreign key to relations", async () => {
      const runId = await startRun();
      const appended: Array<{ kind: RelationEventKind; relationKind: RelationEventRelationKind }> =
        [];
      for (const relationKind of relationEventRelationKinds) {
        for (const kind of relationEventKinds) {
          const id = randomUUID();
          const before =
            kind === "applied" ? null : { id, relation_type: "supports", probability: 0.75 };
          const after =
            kind === "retired" ? null : { id, relation_type: "extends", probability: 0.9 };
          const event = await events().append({
            runId,
            relationKind,
            relationId: id,
            pairKey: `${relationKind}:${kind}`,
            kind,
            before,
            after
          });
          expect(event).toMatchObject({ runId, relationKind, relationId: id, kind, before, after });
          expect(event.at).toBeInstanceOf(Date);
          expect(await events().get(event.id)).toEqual(event);
          expect(await events().listByRelation(relationKind, id)).toEqual([event]);
          appended.push({ kind, relationKind });
        }
      }
      const listed = await events().listByRun(runId);
      expect(listed.map((event) => [event.relationKind, event.kind])).toEqual(
        appended.map((entry) => [entry.relationKind, entry.kind])
      );
      expect(listed.map((event) => event.seq)).toEqual(
        [...listed.map((event) => event.seq)].sort((a, b) => a - b)
      );
      expect(
        (await events().listByRun(runId, { afterSeq: listed[3]!.seq, limit: 2 })).map((e) => e.id)
      ).toEqual([listed[4]!.id, listed[5]!.id]);
      expect(await events().countByKind(runId)).toEqual(
        Object.fromEntries(relationEventKinds.map((kind) => [kind, 2]))
      );

      // An event with no relation row (an informational one) is allowed; nothing else is.
      const bare = await events().append({
        runId,
        relationKind: "note",
        relationId: null,
        pairKey: "pair",
        kind: "kept",
        before: null,
        after: null
      });
      expect(bare).toMatchObject({ relationId: null, before: null, after: null });
      const id = randomUUID();
      const base = { runId, relationKind: "note" as const, relationId: id, pairKey: "pair" };
      await expect(
        events().append({ ...base, kind: "moved" as RelationEventKind, before: null, after: null })
      ).rejects.toThrow("kind");
      await expect(
        events().append({
          ...base,
          relationKind: "topic" as RelationEventRelationKind,
          kind: "kept",
          before: null,
          after: null
        })
      ).rejects.toThrow("relation kind");
      await expect(
        events().append({ ...base, pairKey: "", kind: "kept", before: null, after: null })
      ).rejects.toThrow("pair key");
      await expect(
        events().append({ ...base, kind: "kept", before: null, after: { id: randomUUID() } })
      ).rejects.toThrow("its id");
      await expect(
        events().append({
          ...base,
          relationId: null,
          kind: "kept",
          before: null,
          after: { id }
        })
      ).rejects.toThrow("its id");
      await expect(
        events().append({ ...base, runId: randomUUID(), kind: "kept", before: null, after: null })
      ).rejects.toThrow(/relation_events_run_id/);
      await expect(
        db().query(
          `insert into relation_events (run_id, relation_kind, pair_key, kind) values ($1, 'note', 'pair', 'moved')`,
          [runId]
        )
      ).rejects.toThrow(/relation_events_values/);

      // The repository's kinds are the database's.
      const check = (
        await db().query<{ definition: string }>(
          `select pg_get_constraintdef(oid) as definition from pg_constraint
          where conname = 'relation_events_values'`
        )
      ).rows[0]!.definition;
      const checked = new Set([...check.matchAll(/'([a-z]+)'::text/gu)].map((match) => match[1]));
      for (const kind of [...relationEventKinds, ...relationEventRelationKinds])
        expect(checked.has(kind)).toBe(true);
      expect(checked.size).toBe(relationEventKinds.length + relationEventRelationKinds.length);

      // Events keep IDs without foreign keys to relations (F2 D32): only the run is referenced, and an
      // event outlives its relation.
      const foreign = await db().query<{ name: string; target: string }>(
        `select conname as name, confrelid::regclass::text as target from pg_constraint
        where conrelid = 'relation_events'::regclass and contype = 'f'`
      );
      expect(foreign.rows).toEqual([
        { name: "relation_events_run_id_relation_match_runs_id_fk", target: "relation_match_runs" }
      ]);
      const live = await startRun();
      const created = await pair(live);
      await finishRun(live);
      await db().query("delete from atomic_note_relations where id = $1", [created.relation.id]);
      expect(await events().listByRelation("note", created.relation.id)).toHaveLength(1);
    });

    it("reverts a run that created, typed, vetoed, promoted and retired rows to the byte (I-R8)", async () => {
      const beforeSetup = await snapshot();
      // The state before: committed by an earlier run.
      const setup = await startRun();
      const untyped = await pair(setup, { type: null });
      const applied = await pair(setup);
      const suggested = await pair(setup, { band: "suggest", type: "extends" });
      const supported = await promoted(setup, "supports", 1);
      const retired = await promoted(setup, "extends", 3);
      await finishRun(setup);
      const before = await snapshot();

      // The run: it creates a pair, types another, withdraws a third, re-bands a fourth, creates one
      // promoted relation, raises another's support and retires the last.
      const run = await startRun();
      const created = await pair(run);
      await retype(untyped.a, untyped.b, run, { type: "supports" });
      await noteRelations().veto(applied.relation.id, "explainer", run);
      await retype(suggested.a, suggested.b, run, { type: "extends", band: "apply" });
      const createdSource = await promoted(run, "contradicts", 2);
      await setSupport(run, supported, 2);
      await retire(run, retired);
      await finishRun(run);
      const kinds = Object.keys(await events().countByKind(run)).sort();
      expect(kinds).toEqual(["applied", "promoted", "retired", "typed", "vetoed"].sort());
      expect(await snapshot()).not.toEqual(before);
      expect(await image("source", retired)).toBeNull();
      expect(await image("note", created.relation.id)).not.toBeNull();
      const eventsBefore = await events().listByRun(run);

      const reverted = await events().revertRun(run);
      expect(reverted).toMatchObject({
        kind: "reverted",
        runId: run,
        events: eventsBefore.length,
        restored: 4,
        deleted: 2,
        recreated: 1,
        skipped: 0
      });
      if (reverted.kind !== "reverted") return;
      expect(
        reverted.relations
          .map((relation) => [relation.relationKind, relation.relationId, relation.change])
          .sort()
      ).toEqual(
        [
          ["note", created.relation.id, "deleted"],
          ["note", untyped.relation.id, "restored"],
          ["note", applied.relation.id, "restored"],
          ["note", suggested.relation.id, "restored"],
          ["source", createdSource, "deleted"],
          ["source", supported, "restored"],
          ["source", retired, "recreated"]
        ].sort()
      );
      // Every row of both tables is as it was: created rows gone, deleted rows back, and the rest
      // equal in every column (timestamps and the large metadata number included).
      expect(await snapshot()).toEqual(before);
      expect(await image("note", created.relation.id)).toBeNull();
      expect(await image("source", createdSource)).toBeNull();
      // The log is append-only: the events stay, and the run says it was reverted.
      expect(await events().listByRun(run)).toEqual(eventsBefore);
      expect(await runs().get(run)).toMatchObject({
        outcome: "reverted",
        counts: { revertedEvents: eventsBefore.length }
      });
      expect(await events().revertRun(run)).toEqual({ kind: "already_reverted", runId: run });
      expect(await snapshot()).toEqual(before);
      expect(await events().revertRun(randomUUID())).toMatchObject({ kind: "not_found" });
      expect(await events().revertRun("not-an-id")).toEqual({
        kind: "not_found",
        runId: "not-an-id"
      });
      // Reverting the earlier run is now free: nothing blocks it, and it restores the empty state.
      expect((await events().revertRun(setup)).kind).toBe("reverted");
      expect(await snapshot()).toEqual(beforeSetup);
    });

    it("restores the rows of a review and a reconcile run, and a created-then-deleted row leaves nothing", async () => {
      const setup = await startRun();
      const target = await pair(setup, { band: "suggest" });
      await finishRun(setup);
      const before = await snapshot();

      // A review run: the owner keeps the suggestion (the review writer is T60's; this is its write).
      const review = await startRun("review");
      const reviewBefore = await image("note", target.relation.id);
      await db().query(
        "update atomic_note_relations set status = 'accepted', updated_at = clock_timestamp() where id = $1",
        [target.relation.id]
      );
      await record(
        review,
        "kept",
        "note",
        target.relation.id,
        `${target.relation.sourceAtomicNoteId}:${target.relation.targetAtomicNoteId}`,
        reviewBefore,
        await image("note", target.relation.id)
      );
      await finishRun(review);
      expect((await events().revertRun(review)).kind).toBe("reverted");
      expect(await snapshot()).toEqual(before);

      // A reconcile run re-bands a pair without a model call (its event is `reconciled`).
      const reconcile = await startRun("reconcile");
      const moved = await retype(target.a, target.b, reconcile, {
        type: "supports",
        band: "apply"
      });
      expect(moved.eventId).not.toBeNull();
      await finishRun(reconcile);
      expect((await events().listByRun(reconcile)).map((event) => event.kind)).toEqual([
        "reconciled"
      ]);
      expect((await events().revertRun(reconcile)).kind).toBe("reverted");
      expect(await snapshot()).toEqual(before);

      // Created and deleted inside one run: the revert leaves nothing and reports `none`.
      const run = await startRun();
      const gone = await promoted(run, "supports", 1);
      await retire(run, gone);
      await finishRun(run);
      const result = await events().revertRun(run);
      expect(result).toMatchObject({
        kind: "reverted",
        events: 2,
        restored: 0,
        deleted: 0,
        recreated: 0
      });
      if (result.kind === "reverted")
        expect(result.relations.map((relation) => relation.change)).toEqual(["none"]);
      expect(await snapshot()).toEqual(before);
    });

    it("names the later run that blocks a revert, and reverts once that run is reverted", async () => {
      const setup = await startRun();
      const target = await pair(setup, { type: null });
      await finishRun(setup);
      const before = await snapshot();

      const first = await startRun("link");
      await retype(target.a, target.b, first, { type: "supports" });
      const unrelated = await pair(first);
      await finishRun(first);
      const second = await startRun("veto");
      const vetoed = await noteRelations().veto(target.relation.id, "explainer", second);
      await finishRun(second);
      const afterBoth = await snapshot();
      const firstEvent = (await events().listByRun(first)).find(
        (event) => event.relationId === target.relation.id
      )!;
      const secondEvent = (await events().listByRun(second))[0]!;
      expect(secondEvent.id).toBe(vetoed?.eventId);

      // The later run blocks the earlier one on the relation they share, and not on the other.
      const blocked = await events().revertRun(first);
      expect(blocked).toMatchObject({ kind: "blocked", runId: first, blockerCount: 1 });
      if (blocked.kind !== "blocked") return;
      expect(blocked.blockers).toEqual([
        {
          code: "later_run",
          runId: second,
          runKind: "veto",
          startedAt: expect.any(Date),
          eventId: secondEvent.id,
          eventKind: "vetoed",
          relationKind: "note",
          relationId: target.relation.id,
          pairKey: firstEvent.pairKey
        }
      ]);
      expect(await snapshot()).toEqual(afterBoth);
      expect((await runs().get(first))?.outcome).toBe("completed");

      // Reverting the later run first frees the earlier one; the unrelated pair goes with it.
      expect((await events().revertRun(second)).kind).toBe("reverted");
      expect((await events().revertRun(first)).kind).toBe("reverted");
      expect(await snapshot()).toEqual(before);
      expect(await image("note", unrelated.relation.id)).toBeNull();
    });

    it("blocks on a later run's event on the same pair under another relation ID, and on concurrent runs both ways", async () => {
      const first = await startRun();
      const target = await pair(first);
      await finishRun(first);
      // The row is deleted and the pair decided again: a new relation ID, the same pair.
      await db().query("delete from atomic_note_relations where id = $1", [target.relation.id]);
      const second = await startRun();
      const again = await retype(target.a, target.b, second, { type: "extends" });
      await finishRun(second);
      expect(again.relation.id).not.toBe(target.relation.id);
      const blocked = await events().revertRun(first);
      expect(blocked).toMatchObject({
        kind: "blocked",
        blockers: [
          {
            code: "later_run",
            runId: second,
            eventKind: "applied",
            relationId: target.relation.id,
            pairKey: again.relation.sourceAtomicNoteId + ":" + again.relation.targetAtomicNoteId
          }
        ]
      });

      // Two runs that interleave events on one relation block each other.
      const left = await startRun();
      const shared = await pair(left, { type: null });
      const right = await startRun();
      await retype(shared.a, shared.b, right, { type: "supports" });
      await retype(shared.a, shared.b, left, { type: "supports", band: "suggest" });
      await finishRun(left);
      await finishRun(right);
      const leftBlocked = await events().revertRun(left);
      const rightBlocked = await events().revertRun(right);
      expect(leftBlocked).toMatchObject({
        kind: "blocked",
        blockers: [{ code: "later_run", runId: right }]
      });
      expect(rightBlocked).toMatchObject({
        kind: "blocked",
        blockers: [{ code: "later_run", runId: left }]
      });
    });

    it("refuses an open run, and a relation that changed without an event, and changes nothing", async () => {
      // An open run may still receive events.
      const open = await startRun();
      await pair(open);
      const before = await snapshot();
      expect(await events().revertRun(open)).toEqual({
        kind: "blocked",
        runId: open,
        blockers: [{ code: "run_open", runId: open }],
        blockerCount: 1
      });
      expect(await snapshot()).toEqual(before);
      await finishRun(open);

      // A human review is no event: the revert does not overwrite it, and the run's other rows stay too.
      const run = await startRun();
      const kept = await pair(run);
      const other = await pair(run);
      await finishRun(run);
      await db().query(
        "update atomic_note_relations set status = 'accepted', updated_at = clock_timestamp() where id = $1",
        [kept.relation.id]
      );
      const reviewed = await snapshot();
      const blocked = await events().revertRun(run);
      expect(blocked).toMatchObject({
        kind: "blocked",
        blockerCount: 1,
        blockers: [
          {
            code: "changed_since",
            relationKind: "note",
            relationId: kept.relation.id,
            eventId: kept.eventId
          }
        ]
      });
      expect(await snapshot()).toEqual(reviewed);
      expect(await image("note", other.relation.id)).not.toBeNull();
      expect((await runs().get(run))?.outcome).toBe("completed");

      // A deleted note takes its relation with it: nothing to restore.
      const gone = await startRun();
      const orphan = await pair(gone);
      await finishRun(gone);
      await db().query("delete from atomic_notes where id = $1", [orphan.a]);
      expect(await events().revertRun(gone)).toMatchObject({
        kind: "blocked",
        blockers: [{ code: "row_missing", relationId: orphan.relation.id }]
      });

      // A row deleted by the run is back under another row: the database refuses the earlier row, and
      // the whole revert rolls back.
      const retiring = await startRun();
      const identity = randomUUID();
      const source = await promoted(retiring, "supports", 1, identity);
      const typed = await pair(retiring, { type: null });
      await retype(typed.a, typed.b, retiring, { type: "supports" });
      await retire(retiring, source);
      await finishRun(retiring);
      await db().query(
        `insert into source_relations (identity_key, source_item_id, target_source_item_id, relation_type,
         origin, support_count) values ($1, $2, $3, 'supports', 'promoted', 1)`,
        [identity, works.x.id, works.y.id]
      );
      const afterTake = await snapshot();
      const refused = await events().revertRun(retiring);
      expect(refused).toMatchObject({
        kind: "blocked",
        blockers: [{ code: "restore_refused", relationKind: "source", relationId: source }]
      });
      expect(await snapshot()).toEqual(afterTake);
      // A row the run deleted that exists again under its own ID is named too.
      await db().query(
        `insert into source_relations (id, identity_key, source_item_id, target_source_item_id,
         relation_type, origin, support_count) values ($1, $2, $3, $4, 'extends', 'promoted', 1)`,
        [source, randomUUID(), works.x.id, works.y.id]
      );
      expect(await events().revertRun(retiring)).toMatchObject({
        kind: "blocked",
        blockers: [{ code: "row_exists", relationId: source }]
      });
    });

    it("reverts a run larger than one batch of events, in order, and keeps the log", async () => {
      const before = await snapshot();
      const run = await startRun("reconcile");
      const rows = 1200;
      // Created, then changed once each: two events per row, past the revert's page size.
      await db().query(
        `with created as (
         insert into source_relations (identity_key, source_item_id, target_source_item_id,
           relation_type, origin, support_count)
         select 'bulk-' || gen_random_uuid()::text, $2, $3, 'supports', 'promoted', 1
           from generate_series(1, $4::int)
         returning *)
       insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
       select $1::uuid, 'source', c.id, 'bulk:' || c.id::text, 'promoted', null, to_jsonb(c) from created c`,
        [run, works.x.id, works.y.id, rows]
      );
      await db().query(
        `with prior as (select r.id, to_jsonb(r) as image from source_relations r
                       where r.identity_key like 'bulk-%' and r.support_count = 1),
            moved as (update source_relations r set support_count = 2, updated_at = clock_timestamp()
                       from prior where r.id = prior.id returning r.*)
       insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
       select $1::uuid, 'source', moved.id, 'bulk:' || moved.id::text, 'promoted', prior.image, to_jsonb(moved)
         from moved join prior on prior.id = moved.id`,
        [run]
      );
      await finishRun(run);
      expect((await events().countByKind(run)).promoted).toBe(rows * 2);
      const result = await events().revertRun(run);
      expect(result).toMatchObject({
        kind: "reverted",
        events: rows * 2,
        deleted: rows,
        restored: 0
      });
      expect(await snapshot()).toEqual(before);
      expect(await events().listByRun(run, { limit: 10_000 })).toHaveLength(rows * 2);
    }, 60_000);

    it("reverts concurrently safely: a writer holding a relation makes the revert wait and see its event", async () => {
      const run = await startRun();
      const target = await pair(run, { type: null });
      await finishRun(run);
      const writer = await db().connect();
      try {
        await writer.query("begin");
        const later = (
          await writer.query<{ id: string }>(
            "insert into relation_match_runs (kind) values ('type') returning id"
          )
        ).rows[0]!.id;
        // The writer changes the relation in a later run and has not committed yet.
        await writer.query(
          `with prior as (select to_jsonb(r) as image from atomic_note_relations r where r.id = $1),
              moved as (update atomic_note_relations r set relation_type = 'extends', direction = 'lo_to_hi',
                          direction_source = 'typer', updated_at = clock_timestamp() where r.id = $1 returning r.*)
         insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
         select $2::uuid, 'note', moved.id, 'pair', 'typed', prior.image, to_jsonb(moved) from moved, prior`,
          [target.relation.id, later]
        );
        const reverting = events().revertRun(run);
        await new Promise((settle) => setTimeout(settle, 300));
        await writer.query("commit");
        // The revert waited for the lock, then read the writer's event: blocked, not clobbered.
        expect(await reverting).toMatchObject({
          kind: "blocked",
          blockers: [{ code: "later_run", runId: later }]
        });
      } finally {
        await writer.query("rollback").catch(() => undefined);
        writer.release();
      }
      expect(await image("note", target.relation.id)).toContain('"extends"');
    });
  }
);
