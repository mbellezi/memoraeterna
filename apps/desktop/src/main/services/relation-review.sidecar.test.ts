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
  createNotePageRepository,
  createPgPool,
  createRelationEventRepository,
  createRelationMatchRunRepository,
  noteRelationDirectionSql,
  resolvePostgresSidecarPaths,
  runMigrations,
  shownNoteRelationSql,
  withdrawnNoteRelationSql,
  type PgClient,
  type PgPool
} from "@app/db";

import { RelationReviewService } from "./relation-review-service.js";

// F3 D15 on a real PostgreSQL database: the owner's verdict on a note relation with its event in a
// run of its own, final in both directions (I-R2, I-R3), and the re-promotion of both roots.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("the relation review on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-relation-review-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_relation_review_test",
        user: "memora_relation_review_test",
        password: `relation-review-${randomUUID()}`,
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

  beforeEach(async () => {
    const db = pool!;
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

  /** A relation between two fresh notes in the given band, typed or not. */
  const seedRelation = async (
    options: { band?: "apply" | "suggest"; typed?: boolean; vetoed?: boolean } = {}
  ) => {
    const seeded = [await seedNote("Retrieval"), await seedNote("Feedback")].sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    const [first, second] = seeded.map((note) => note.id);
    const runs = createRelationMatchRunRepository(pool!);
    const run = await runs.start({ kind: "match" });
    const relations = createAtomicNoteRelationRepository(pool!);
    const written = await relations.upsert({
      loAtomicNoteId: first!,
      hiAtomicNoteId: second!,
      direction: options.typed === false ? "symmetric" : "lo_to_hi",
      relationType: options.typed === false ? null : "supports",
      band: options.band ?? "suggest",
      probability: 0.6,
      finalScore: 0.6,
      explanation: "knowledge.relations.explanations.reranked",
      runId: run.id
    });
    if (options.vetoed) await relations.veto(written.relation.id, "explainer", run.id);
    return {
      id: written.relation.id,
      pair: { lo: first!, hi: second! },
      sources: seeded.map((note) => note.sourceId).sort()
    };
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

  const build = () => {
    const relationsChanged = vi.fn();
    return {
      service: new RelationReviewService({ getPool: () => pool!, relationsChanged }),
      relationsChanged
    };
  };
  const reviewRuns = async () =>
    (await pool!.query("select 1 from relation_match_runs where kind = 'review'")).rowCount;

  it("keeps a suggestion: accepted, with one kept event, the roots promoted again and the page told", async () => {
    const { id, pair, sources } = await seedRelation({ band: "suggest" });
    const { service, relationsChanged } = build();
    expect(await state(id)).toMatchObject({ status: "pending_review", shown: true });

    expect(await service.review({ relationId: id, verdict: "keep" })).toEqual({
      relationId: id,
      outcome: "kept",
      changed: true
    });
    expect(await state(id)).toMatchObject({ status: "accepted", shown: true, withdrawn: false });
    expect(relationsChanged).toHaveBeenCalledWith([pair.lo, pair.hi]);

    const events = await pool!.query<{ kind: string; runKind: string; outcome: string | null }>(
      `select event.kind, run.kind as "runKind", run.outcome
         from relation_events event join relation_match_runs run on run.id = event.run_id
        where event.relation_id = $1 and event.kind in ('kept', 'removed')`,
      [id]
    );
    expect(events.rows).toEqual([{ kind: "kept", runKind: "review", outcome: "succeeded" }]);
    // A typed relation fed the source relations promoted from it: both roots are promoted again.
    const promotions = await pool!.query<{ rootId: string }>(
      `select payload->>'rootId' as "rootId" from jobs
        where type = 'relation-promote' and status = 'queued' order by payload->>'rootId'`
    );
    expect(promotions.rows.map((row) => row.rootId)).toEqual(sources);
    // The page lists it as kept, in the shown group.
    const page = (await createNotePageRepository(pool!).readPage(pair.lo, {
      relationLimit: 20,
      contentLanguage: "en"
    }))!;
    expect(page.relations.items.map((item) => item.state)).toEqual(["kept"]);
    expect(page.withdrawn.total).toBe(0);
  });

  it("keeps a suggestion with the owner's direction, or with none, and records it as the owner's (decision 31b)", async () => {
    const directionOf = async (relationId: string) =>
      (
        await pool!.query<{ direction: string; source: string | null; shown: string }>(
          `select r.direction, r.direction_source as source, ${noteRelationDirectionSql("r")} as shown
             from atomic_note_relations r where r.id = $1`,
          [relationId]
        )
      ).rows[0]!;
    const pageOf = async (noteId: string) =>
      (await createNotePageRepository(pool!).readPage(noteId, {
        relationLimit: 20,
        contentLanguage: "en"
      }))!.relations.items[0]!;

    // The typer guessed lo -> hi and nothing shows it; the owner says hi is the subject.
    const given = await seedRelation({ band: "suggest" });
    expect(await directionOf(given.id)).toMatchObject({
      direction: "lo_to_hi",
      source: "typer",
      shown: "unknown"
    });
    const { service } = build();
    await service.review({ relationId: given.id, verdict: "keep", subjectNoteId: given.pair.hi });
    expect(await directionOf(given.id)).toMatchObject({
      direction: "hi_to_lo",
      source: "owner",
      shown: "hi_to_lo"
    });
    expect(await pageOf(given.pair.hi)).toMatchObject({
      direction: "outgoing",
      directionSource: "owner",
      state: "kept"
    });
    expect(await pageOf(given.pair.lo)).toMatchObject({ direction: "incoming" });
    const [kept] = (
      await createRelationEventRepository(pool!).listByRelation("note", given.id)
    ).filter((event) => event.kind === "kept");
    expect(kept?.before).toMatchObject({ direction: "lo_to_hi", direction_source: "typer" });
    expect(kept?.after).toMatchObject({ direction: "hi_to_lo", direction_source: "owner" });

    // "No direction" is a choice too: the page reads the relation as linked.
    const none = await seedRelation({ band: "suggest" });
    await build().service.review({ relationId: none.id, verdict: "keep", subjectNoteId: null });
    expect(await directionOf(none.id)).toMatchObject({
      direction: "symmetric",
      source: "owner",
      shown: "unknown"
    });
    expect(await pageOf(none.pair.lo)).toMatchObject({
      direction: "unknown",
      directionSource: null,
      state: "kept"
    });

    // Left out, a Keep leaves the guess where it was; a note outside the pair is refused whole.
    const left = await seedRelation({ band: "suggest" });
    await build().service.review({ relationId: left.id, verdict: "keep" });
    expect(await directionOf(left.id)).toMatchObject({ direction: "lo_to_hi", source: "typer" });
    const stranger = await seedRelation({ band: "suggest" });
    await expect(
      build().service.review({
        relationId: stranger.id,
        verdict: "keep",
        subjectNoteId: (await seedNote("Stranger")).id
      })
    ).rejects.toThrow("one of its two notes");
    expect(await state(stranger.id)).toMatchObject({ status: "pending_review" });
    expect(await reviewRuns()).toBeGreaterThan(0);
  });

  it("removes a relation: rejected, one removed event, listed nowhere", async () => {
    const { id, pair } = await seedRelation({ band: "suggest" });
    const { service } = build();
    expect(await service.review({ relationId: id, verdict: "remove" })).toEqual({
      relationId: id,
      outcome: "removed",
      changed: true
    });
    expect(await state(id)).toMatchObject({ status: "rejected", shown: false, withdrawn: false });
    const kinds = (await createRelationEventRepository(pool!).listByRelation("note", id)).map(
      (event) => event.kind
    );
    expect(kinds).toEqual(["suggested", "removed"]);
    const page = (await createNotePageRepository(pool!).readPage(pair.hi, {
      relationLimit: 20,
      contentLanguage: "en"
    }))!;
    expect([page.relations.total, page.withdrawn.total, page.earlierVersions.total]).toEqual([
      0, 0, 0
    ]);
  });

  it("keeps a withdrawn relation: the veto is cleared and it is shown again", async () => {
    const { id, pair } = await seedRelation({ band: "apply", vetoed: true });
    expect(await state(id)).toMatchObject({ withdrawn: true, shown: false });
    const { service } = build();
    await service.review({ relationId: id, verdict: "keep" });
    const after = await state(id);
    expect(after).toMatchObject({
      status: "accepted",
      vetoSource: null,
      shown: true,
      withdrawn: false
    });
    expect(after.vetoedAt).toBeNull();
    // The event holds the image before (vetoed) and after (not).
    const [kept] = (await createRelationEventRepository(pool!).listByRelation("note", id)).filter(
      (event) => event.kind === "kept"
    );
    expect(kept?.before?.veto_source).toBe("explainer");
    expect(kept?.after?.veto_source).toBeNull();
    const page = (await createNotePageRepository(pool!).readPage(pair.lo, {
      relationLimit: 20,
      contentLanguage: "en"
    }))!;
    expect(page.relations.items.map((item) => [item.state, item.vetoSource])).toEqual([
      ["kept", null]
    ]);
  });

  it("removes a withdrawn relation for good", async () => {
    const { id } = await seedRelation({ band: "apply", vetoed: true });
    await build().service.review({ relationId: id, verdict: "remove" });
    expect(await state(id)).toMatchObject({ status: "rejected", withdrawn: false, shown: false });
  });

  it("is final in both directions: a second verdict changes nothing and records nothing", async () => {
    const kept = await seedRelation();
    const removed = await seedRelation();
    const { service, relationsChanged } = build();
    await service.review({ relationId: kept.id, verdict: "keep" });
    await service.review({ relationId: removed.id, verdict: "remove" });
    const runsBefore = await reviewRuns();
    relationsChanged.mockClear();

    expect(await service.review({ relationId: kept.id, verdict: "remove" })).toEqual({
      relationId: kept.id,
      outcome: "kept",
      changed: false
    });
    expect(await service.review({ relationId: removed.id, verdict: "keep" })).toEqual({
      relationId: removed.id,
      outcome: "removed",
      changed: false
    });
    // The same verdict again is no more than a repeat.
    expect(await service.review({ relationId: kept.id, verdict: "keep" })).toMatchObject({
      outcome: "kept",
      changed: false
    });
    expect(await state(kept.id)).toMatchObject({ status: "accepted" });
    expect(await state(removed.id)).toMatchObject({ status: "rejected" });
    // No run, no event and no push for a verdict that changed nothing.
    expect(await reviewRuns()).toBe(runsBefore);
    expect(relationsChanged).not.toHaveBeenCalled();
    expect(
      (await pool!.query("select 1 from relation_events where kind in ('kept', 'removed')"))
        .rowCount
    ).toBe(2);
  });

  it("is final against automation: a kept relation is not rewritten, vetoed or retyped; a removed pair is not made again (I-R2, I-R3)", async () => {
    const kept = await seedRelation({ band: "suggest" });
    const removed = await seedRelation({ band: "suggest" });
    const { service } = build();
    await service.review({ relationId: kept.id, verdict: "keep" });
    await service.review({ relationId: removed.id, verdict: "remove" });
    const relations = createAtomicNoteRelationRepository(pool!);
    const run = await createRelationMatchRunRepository(pool!).start({ kind: "match" });
    const again = (pair: { lo: string; hi: string }) =>
      relations.upsert({
        loAtomicNoteId: pair.lo,
        hiAtomicNoteId: pair.hi,
        direction: "hi_to_lo",
        relationType: "extends",
        band: "apply",
        probability: 0.99,
        finalScore: 0.99,
        explanation: "knowledge.relations.explanations.reranked",
        runId: run.id
      });
    expect((await again(kept.pair)).change).toBe("reviewed");
    expect((await again(removed.pair)).change).toBe("reviewed");
    expect(await relations.veto(kept.id, "explainer", run.id)).toBeNull();
    expect(await state(kept.id)).toMatchObject({ status: "accepted", withdrawn: false });
    expect(await state(removed.id)).toMatchObject({ status: "rejected", shown: false });
    // The matcher skips a pair with a verdict.
    const statuses = await relations.pairStatuses(removed.pair.lo, [removed.pair.hi]);
    expect(statuses.get(removed.pair.hi)).toBe("rejected");
  });

  /**
   * Another writer holds the relation's row in a transaction while the review starts: `hold`
   * writes in it, the review is started and waits for the row, and the writer commits.
   */
  const reviewBehind = async (
    id: string,
    verdict: "keep" | "remove",
    hold: (writer: PgClient, runId: string) => Promise<void>
  ) => {
    const writer = await pool!.connect();
    try {
      await writer.query("begin");
      const runs = createRelationMatchRunRepository(writer);
      const run = await runs.start({ kind: "veto" });
      await hold(writer, run.id);
      const review = build().service.review({ relationId: id, verdict });
      // The review is parked on the row (a lock wait of another backend), not finished or failed.
      for (let attempt = 0; ; attempt += 1) {
        const waiting = await pool!.query(
          `select 1 from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`
        );
        if (waiting.rowCount) break;
        if (attempt >= 200) throw new Error("The review never waited for the relation.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await runs.finish(run.id, { outcome: "succeeded", counts: {} });
      await writer.query("commit");
      return await review;
    } finally {
      await writer.query("rollback").catch(() => undefined);
      writer.release();
    }
  };
  const runIdOfKind = async (kind: string) =>
    (
      await pool!.query<{ id: string }>("select id from relation_match_runs where kind = $1", [
        kind
      ])
    ).rows[0]!.id;

  it("records the row a veto left when the veto commits while the review waits, and reverts exactly (D14, I-R8)", async () => {
    const { id } = await seedRelation({ band: "suggest" });
    const reviewed = await reviewBehind(id, "keep", async (writer, runId) => {
      const vetoed = await createAtomicNoteRelationRepository(writer).veto(id, "explainer", runId);
      expect(vetoed?.change).toBe("updated");
    });
    expect(reviewed).toEqual({ relationId: id, outcome: "kept", changed: true });
    expect(await state(id)).toMatchObject({ status: "accepted", vetoSource: null, shown: true });

    const events = createRelationEventRepository(pool!);
    const [kept] = (await events.listByRelation("note", id)).filter((e) => e.kind === "kept");
    expect(kept?.before).toMatchObject({ status: "pending_review", veto_source: "explainer" });
    expect(kept?.before?.vetoed_at).not.toBeNull();
    expect(kept?.after).toMatchObject({ status: "accepted", veto_source: null, vetoed_at: null });

    // Reverting the review puts the vetoed row back, so the veto itself can be reverted after it.
    expect(await events.revertRun(await runIdOfKind("review"))).toMatchObject({ kind: "reverted" });
    expect(await state(id)).toMatchObject({
      status: "pending_review",
      vetoSource: "explainer",
      withdrawn: true
    });
    expect(await events.revertRun(await runIdOfKind("veto"))).toMatchObject({ kind: "reverted" });
    expect(await state(id)).toMatchObject({ status: "pending_review", vetoSource: null });
  });

  it("records the row a retype left when a link job commits while the review waits (D14, I-R8)", async () => {
    const { id, pair } = await seedRelation({ band: "suggest" });
    await reviewBehind(id, "keep", async (writer, runId) => {
      const retyped = await createAtomicNoteRelationRepository(writer).upsert({
        loAtomicNoteId: pair.lo,
        hiAtomicNoteId: pair.hi,
        direction: "hi_to_lo",
        relationType: "extends",
        band: "apply",
        probability: 0.9,
        finalScore: 0.9,
        explanation: "knowledge.relations.explanations.reranked",
        runId
      });
      expect(retyped.change).toBe("updated");
    });
    const events = createRelationEventRepository(pool!);
    const [kept] = (await events.listByRelation("note", id)).filter((e) => e.kind === "kept");
    expect(kept?.before).toMatchObject({ relation_type: "extends", direction: "hi_to_lo" });
    expect(kept?.after).toMatchObject({ relation_type: "extends", status: "accepted" });
    expect(await events.revertRun(await runIdOfKind("review"))).toMatchObject({ kind: "reverted" });
    expect(await state(id)).toMatchObject({ status: "pending_review", shown: true });
    const stored = await pool!.query<{ relationType: string }>(
      'select relation_type as "relationType" from atomic_note_relations where id = $1',
      [id]
    );
    expect(stored.rows[0]?.relationType).toBe("extends");
  });

  it("answers the verdict that stands to the review that loses a race, never a removal of a kept relation (I-R2)", async () => {
    const { id } = await seedRelation({ band: "suggest" });
    const losing = await reviewBehind(id, "remove", async (writer) => {
      const relations = createAtomicNoteRelationRepository(writer);
      expect(await relations.lockForReview(id)).toBe(true);
      const run = await createRelationMatchRunRepository(writer).start({ kind: "review" });
      expect((await relations.review(id, "keep", run.id))?.change).toBe("updated");
    });
    expect(losing).toEqual({ relationId: id, outcome: "kept", changed: false });
    expect(await state(id)).toMatchObject({ status: "accepted", shown: true });
    // One verdict, one run, one event: the review that lost recorded none.
    expect(await reviewRuns()).toBe(1);
    const verdicts = await pool!.query(
      "select 1 from relation_events where kind in ('kept', 'removed')"
    );
    expect(verdicts.rowCount).toBe(1);
  });

  it("never answers a removal for a row without a verdict that the review could not write", async () => {
    const { id } = await seedRelation({ band: "suggest" });
    const db = pool!;
    // A trigger that swallows the update: the statement then falls back to the row as stored.
    await db.query(`create function swallow_relation_update() returns trigger language plpgsql
                    as $$ begin return null; end $$`);
    await db.query(`create trigger swallow_relation_update before update on atomic_note_relations
                    for each row execute function swallow_relation_update()`);
    try {
      await expect(build().service.review({ relationId: id, verdict: "keep" })).rejects.toThrow(
        "changed while it was reviewed"
      );
    } finally {
      await db.query("drop trigger swallow_relation_update on atomic_note_relations");
      await db.query("drop function swallow_relation_update()");
    }
    expect(await state(id)).toMatchObject({ status: "pending_review", shown: true });
    expect(await reviewRuns()).toBe(0);
  });

  it("promotes the roots of a typed relation again and leaves an untyped one alone", async () => {
    const typed = await seedRelation({ band: "suggest", typed: true });
    const untyped = await seedRelation({ band: "suggest", typed: false });
    const { service } = build();
    await service.review({ relationId: untyped.id, verdict: "keep" });
    expect((await pool!.query("select 1 from jobs where type = 'relation-promote'")).rowCount).toBe(
      0
    );
    await service.review({ relationId: typed.id, verdict: "remove" });
    const roots = await pool!.query<{ rootId: string }>(
      `select payload->>'rootId' as "rootId" from jobs where type = 'relation-promote' order by 1`
    );
    expect(roots.rows.map((row) => row.rootId)).toEqual(typed.sources);
  });

  it("answers null for a relation that is gone and leaves no run behind", async () => {
    const { service, relationsChanged } = build();
    expect(await service.review({ relationId: randomUUID(), verdict: "keep" })).toBeNull();
    expect(await reviewRuns()).toBe(0);
    expect(relationsChanged).not.toHaveBeenCalled();
  });

  it("refuses a request that breaks the contract before reading anything", async () => {
    const { service } = build();
    for (const input of [
      undefined,
      {},
      { relationId: "nope", verdict: "keep" },
      { relationId: randomUUID(), verdict: "maybe" },
      { relationId: randomUUID(), verdict: "keep", extra: 1 }
    ])
      await expect(service.review(input)).rejects.toThrow();
    expect(await reviewRuns()).toBe(0);
  });
});
