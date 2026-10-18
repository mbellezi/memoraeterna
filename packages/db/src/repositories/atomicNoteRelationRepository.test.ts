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
import { createNoteMatchStateRepository } from "./noteMatchStateRepository.js";
import { createNotePageRepository } from "./notePageRepository.js";
import {
  appliedNoteRelationSql,
  earlierVersionNoteRelationSql,
  shownNoteRelationSql,
  suggestedNoteRelationSql,
  withdrawnNoteRelationSql
} from "./note-relation-sql.js";
import { createRelationExplanationRepository } from "./relationExplanationRepository.js";
import { createRelationTypingRepository } from "./relationTypingRepository.js";
import { createSourceMatchStateRepository } from "./sourceMatchStateRepository.js";

// Relations v2 (F3 D8, D9) against a real PostgreSQL database: the canonical upsert (sorted pair,
// direction, band, probability, keys; idempotent; a human verdict is final; one event per change,
// D14), the veto, the five
// visibility predicates over a fixture holding every state, the readers that derive the direction
// from the column, the typing cache and the matching state. The migration itself is verified by
// `npm run db:relations:verify`.
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("note relations v2 on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;
  const relations = () => createAtomicNoteRelationRepository(db());
  const works: Record<"x" | "y", { id: string; chunk: string; document: string }> = {
    x: { id: "", chunk: "", document: "" },
    y: { id: "", chunk: "", document: "" }
  };
  /** A link run: every banded write and veto records its event in a run (D14). */
  let runId = "";
  const run = async (kind: string) =>
    (
      await db().query<{ id: string }>(
        "insert into relation_match_runs (kind) values ($1) returning id",
        [kind]
      )
    ).rows[0]!.id;

  /** A current note of work `home` (its own primary chunk unless given). */
  async function note(
    title: string,
    home: "x" | "y",
    options: { status?: string; supersession?: string; chunk?: string; ownership?: string } = {}
  ): Promise<string> {
    const id = randomUUID();
    await db().query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
         created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key, ownership)
       values ($1::uuid, $2, 'Body', $3, $4, $5, $6, $7, 'test', 'test', 'local', 'test',
               $1::uuid::text, $8)`,
      [
        id,
        title,
        `Idea of ${title}`,
        options.status ?? "active",
        options.supersession ?? "current",
        works[home].id,
        options.chunk ?? works[home].chunk,
        options.ownership ?? "source"
      ]
    );
    return id;
  }

  const decided = (
    subject: string,
    object: string,
    input: Partial<Parameters<ReturnType<typeof relations>["upsertDecided"]>[0]> = {}
  ) =>
    relations().upsertDecided({
      subjectAtomicNoteId: subject,
      objectAtomicNoteId: object,
      relationType: "supports",
      band: "apply",
      probability: 0.91,
      deciderKey: "ranker-v2",
      finalScore: 0.91,
      explanation: "knowledge.relations.explanations.reranked",
      runId,
      ...input
    });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-note-relations-v2-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_note_relations_test",
        user: "memora_note_relations_test",
        password: `note-relations-${randomUUID()}`,
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
      works[key] = { id: source, chunk, document };
    }
    runId = await run("link");
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("stores the decided pair once, sorted, with its direction, and never writes direction metadata", async () => {
    const [a, b] = [await note("A", "x"), await note("B", "y")];
    const [lo, hi] = [a, b].sort() as [string, string];
    const forward = await decided(hi, lo);
    expect(forward.change).toBe("created");
    expect(forward.before).toBeNull();
    expect(forward.relation).toMatchObject({
      sourceAtomicNoteId: lo,
      targetAtomicNoteId: hi,
      direction: "hi_to_lo",
      band: "apply",
      probability: expect.closeTo(0.91, 5),
      deciderKey: "ranker-v2",
      typerKey: null,
      vetoedAt: null,
      metadata: {}
    });
    expect(forward.after).toMatchObject({ id: forward.relation.id, direction: "hi_to_lo" });
    // A symmetric or untyped relation reads both ways.
    const [c, d] = [await note("C", "x"), await note("D", "y")];
    expect((await decided(c, d, { relationType: "contradicts" })).relation.direction).toBe(
      "symmetric"
    );
    const [e, f] = [await note("E", "x"), await note("F", "y")];
    expect((await decided(e, f, { relationType: null })).relation).toMatchObject({
      relationType: null,
      direction: "symmetric"
    });
    // The canonical pair is refused unsorted, as a self pair, or with an unknown direction.
    const base = {
      relationType: "supports",
      band: "apply" as const,
      finalScore: 1,
      explanation: "x",
      runId
    };
    await expect(
      relations().upsert({ ...base, loAtomicNoteId: hi, hiAtomicNoteId: lo, direction: "lo_to_hi" })
    ).rejects.toThrow("sorted");
    await expect(
      relations().upsert({ ...base, loAtomicNoteId: lo, hiAtomicNoteId: lo, direction: "lo_to_hi" })
    ).rejects.toThrow("itself");
    await expect(
      relations().upsert({
        ...base,
        loAtomicNoteId: lo,
        hiAtomicNoteId: hi,
        direction: "unknown" as "lo_to_hi"
      })
    ).rejects.toThrow("known direction");
    // The database refuses what the repository would: the canonical CHECK.
    await expect(
      db().query(
        `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
           direction, final_score, explanation) values ($1, $2, 'supports', 'lo_to_hi', 1, 'x')`,
        [hi, lo]
      )
    ).rejects.toThrow(/atomic_note_relations_pair/);
  });

  it("is idempotent, updates an automatic relation and leaves a human verdict as it is (I-R3)", async () => {
    const [a, b] = [await note("G", "x"), await note("H", "y")];
    const first = await decided(a, b);
    const again = await decided(a, b);
    expect(again.change).toBe("unchanged");
    expect(again.relation.updatedAt).toEqual(first.relation.updatedAt);
    expect(again.after).toEqual(first.after);
    const typed = await decided(b, a, {
      relationType: "extends",
      band: "suggest",
      probability: 0.7
    });
    expect(typed.change).toBe("updated");
    expect(typed.before).toMatchObject({ relation_type: "supports", band: "apply" });
    expect(typed.relation).toMatchObject({ relationType: "extends", band: "suggest" });
    expect(typed.relation.id).toBe(first.relation.id);
    expect(
      (
        await db().query("select count(*)::int as n from atomic_note_relations where id = $1", [
          first.relation.id
        ])
      ).rows[0]
    ).toEqual({ n: 1 });
    // pairStatuses reads the one row of the pair from either note.
    expect(await relations().pairStatuses(a, [b])).toEqual(new Map([[b, "pending_review"]]));
    expect(await relations().pairStatuses(b, [a])).toEqual(new Map([[a, "pending_review"]]));

    const [c, d] = [await note("I", "x"), await note("J", "y")];
    const kept = await decided(c, d, { status: "accepted" });
    const touched = await decided(d, c, { relationType: "contradicts", band: "suggest" });
    expect(touched.change).toBe("reviewed");
    expect(touched.relation).toMatchObject({
      relationType: "supports",
      band: "apply",
      status: "accepted"
    });
    expect(touched.after).toEqual(kept.after);
    expect(await relations().veto(kept.relation.id, "explainer", runId)).toBeNull();
  });

  it("withdraws a relation once by an automatic veto", async () => {
    const [a, b] = [await note("K", "x"), await note("L", "y")];
    const { relation } = await decided(a, b);
    const vetoed = await relations().veto(relation.id, "explainer", runId);
    expect(vetoed?.change).toBe("updated");
    expect(vetoed?.before).toMatchObject({ vetoed_at: null });
    expect(vetoed?.relation).toMatchObject({ vetoSource: "explainer", vetoedAt: expect.any(Date) });
    expect(await relations().veto(relation.id, "typer", runId)).toBeNull();
    expect(await relations().veto(randomUUID(), "typer", runId)).toBeNull();
  });

  it("records the owner's verdict in the write's own statement, final in both directions (D15, I-R2, I-R3)", async () => {
    const reviewRun = await run("review");
    const eventKinds = async (relationId: string) =>
      (
        await db().query<{ kind: string; runId: string }>(
          'select kind, run_id as "runId" from relation_events where relation_id = $1 order by seq',
          [relationId]
        )
      ).rows;
    const [a, b, c, d] = [
      await note("V1", "x"),
      await note("V2", "y"),
      await note("V3", "x"),
      await note("V4", "y")
    ];
    // Keep clears the veto of a withdrawn relation and accepts it.
    const withdrawn = await decided(a, b, { band: "apply" });
    await relations().veto(withdrawn.relation.id, "explainer", runId);
    const kept = await relations().review(withdrawn.relation.id, "keep", reviewRun);
    expect(kept?.change).toBe("updated");
    expect(kept?.relation).toMatchObject({ status: "accepted", vetoedAt: null, vetoSource: null });
    expect(kept?.before).toMatchObject({ vetoed_at: expect.any(String) });
    expect(kept?.after).toMatchObject({ status: "accepted", vetoed_at: null });
    expect((await eventKinds(withdrawn.relation.id)).slice(-1)).toEqual([
      { kind: "kept", runId: reviewRun }
    ]);
    // Remove rejects; the veto fields of a removed relation are left as they were.
    const suggested = await decided(c, d, { band: "suggest" });
    const removed = await relations().review(suggested.relation.id, "remove", reviewRun);
    expect(removed?.relation.status).toBe("rejected");
    expect((await eventKinds(suggested.relation.id)).slice(-1)).toEqual([
      { kind: "removed", runId: reviewRun }
    ]);

    // The first verdict stays: a second review writes nothing and records no event.
    const eventsBefore = (await eventKinds(withdrawn.relation.id)).length;
    const again = await relations().review(withdrawn.relation.id, "remove", reviewRun);
    expect(again?.change).toBe("reviewed");
    expect(again?.eventId).toBeNull();
    expect(again?.relation.status).toBe("accepted");
    expect(
      (await relations().review(suggested.relation.id, "keep", reviewRun))?.relation.status
    ).toBe("rejected");
    expect((await eventKinds(withdrawn.relation.id)).length).toBe(eventsBefore);
    // Automation changes neither verdict: not the kept relation's type, not the removed pair.
    expect((await decided(a, b, { relationType: "contradicts", band: "suggest" })).change).toBe(
      "reviewed"
    );
    expect((await decided(c, d, { band: "apply" })).change).toBe("reviewed");
    expect(await relations().veto(withdrawn.relation.id, "typer", runId)).toBeNull();
    expect(await relations().pairStatuses(c, [d])).toEqual(new Map([[d, "rejected"]]));
    // A relation that is gone has nothing to review.
    expect(await relations().review(randomUUID(), "keep", reviewRun)).toBeNull();
    await expect(relations().review(withdrawn.relation.id, "keep", "")).rejects.toThrow(
      "needs its run"
    );
  });

  it("locks a relation's row for a review and says whether the relation exists", async () => {
    const [a, b] = [await note("LK1", "x"), await note("LK2", "y")];
    const { relation } = await decided(a, b, { band: "suggest" });
    expect(await relations().lockForReview(randomUUID())).toBe(false);

    const holder = await db().connect();
    const other = await db().connect();
    try {
      await holder.query("begin");
      expect(await createAtomicNoteRelationRepository(holder).lockForReview(relation.id)).toBe(
        true
      );
      // Another writer waits for the row until the lock is released.
      await other.query("begin");
      await other.query("set local lock_timeout = '150ms'");
      await expect(
        other.query("update atomic_note_relations set updated_at = now() where id = $1", [
          relation.id
        ])
      ).rejects.toThrow(/lock timeout/u);
    } finally {
      await other.query("rollback").catch(() => undefined);
      other.release();
      await holder.query("rollback").catch(() => undefined);
      holder.release();
    }
    // Released with the transaction.
    expect(await relations().lockForReview(relation.id)).toBe(true);
  });

  it("says what each relation of a source is now, from the same predicates", async () => {
    const [a, b, c, d, e, f] = [
      await note("W1", "x"),
      await note("W2", "y"),
      await note("W3", "y"),
      await note("W4", "y"),
      await note("W5", "y"),
      await note("W6", "y")
    ];
    const reviewRun = await run("review");
    const applied = await decided(a, b, { band: "apply" });
    const suggested = await decided(a, c, { band: "suggest" });
    const kept = await decided(a, d, { band: "suggest" });
    await relations().review(kept.relation.id, "keep", reviewRun);
    const withdrawn = await decided(a, e, { band: "apply" });
    await relations().veto(withdrawn.relation.id, "typer", runId);
    const removed = await decided(a, f, { band: "apply" });
    await relations().review(removed.relation.id, "remove", reviewRun);
    const listed = await relations().listBySourceItem(works.x.id);
    const byId = new Map(listed.map((row) => [row.id, row]));
    expect(byId.get(applied.relation.id)).toMatchObject({ state: "applied", shown: true });
    expect(byId.get(suggested.relation.id)).toMatchObject({ state: "suggested", shown: true });
    expect(byId.get(kept.relation.id)).toMatchObject({ state: "kept", shown: true, applied: true });
    expect(byId.get(withdrawn.relation.id)).toMatchObject({ state: "withdrawn", shown: false });
    // A removed relation is listed too, and never reads as applied.
    expect(byId.get(removed.relation.id)).toMatchObject({
      state: "removed",
      shown: false,
      applied: false
    });
  });

  it("records exactly one event per automatic change in the write's own statement (D14, I-R8)", async () => {
    const events = async (relationId: string) =>
      (
        await db().query<{
          id: string;
          runId: string;
          relationKind: string;
          pairKey: string;
          kind: string;
          before: string | null;
          after: string;
        }>(
          `select id, run_id as "runId", relation_kind as "relationKind", pair_key as "pairKey", kind,
                  before::text as before, after::text as after
             from relation_events where relation_id = $1 order by seq`,
          [relationId]
        )
      ).rows;
    const image = async (relationId: string) =>
      (
        await db().query<{ image: string }>(
          "select to_jsonb(r)::text as image from atomic_note_relations r where r.id = $1",
          [relationId]
        )
      ).rows[0]!.image;
    const [a, b] = [await note("S", "x"), await note("T", "y")];
    const [lo, hi] = [a, b].sort() as [string, string];

    // Persisted untyped (D20), then typed, then moved to the suggest band, each one event whose
    // images are the rows before and after, byte for byte.
    const untyped = await decided(a, b, { relationType: null });
    const typed = await decided(a, b, { relationType: "extends" });
    const imageTyped = await image(untyped.relation.id);
    const unchanged = await decided(a, b, { relationType: "extends" });
    const suggested = await decided(a, b, { relationType: "extends", band: "suggest" });
    expect([untyped.change, typed.change, unchanged.change, suggested.change]).toEqual([
      "created",
      "updated",
      "unchanged",
      "updated"
    ]);
    expect(unchanged.eventId).toBeNull();
    const recorded = await events(untyped.relation.id);
    expect(recorded.map((event) => event.kind)).toEqual(["untyped", "typed", "suggested"]);
    expect(recorded.map((event) => event.id)).toEqual([
      untyped.eventId,
      typed.eventId,
      suggested.eventId
    ]);
    expect(recorded[0]).toMatchObject({
      runId,
      relationKind: "note",
      pairKey: `${lo}:${hi}`,
      before: null
    });
    expect(recorded[1]!.before).toBe(recorded[0]!.after);
    expect(recorded[1]!.after).toBe(imageTyped);
    expect(recorded[2]!.before).toBe(imageTyped);
    expect(recorded[2]!.after).toBe(await image(untyped.relation.id));
    // A reconcile run's band change is `reconciled`; a reversed direction is a new type fact.
    const reconcile = await run("reconcile");
    const reconciled = await decided(a, b, { relationType: "extends", runId: reconcile });
    const reversed = await decided(b, a, { relationType: "extends" });
    expect([reconciled.change, reversed.change]).toEqual(["updated", "updated"]);
    expect((await events(untyped.relation.id)).slice(3).map((event) => event.kind)).toEqual([
      "reconciled",
      "typed"
    ]);
    // A veto is `vetoed`; a created typed row is `applied` or `suggested` by band.
    const vetoed = await relations().veto(untyped.relation.id, "typer", runId);
    expect((await events(untyped.relation.id)).at(-1)).toMatchObject({
      id: vetoed?.eventId,
      kind: "vetoed",
      after: await image(untyped.relation.id)
    });
    const [c, d] = [await note("U", "x"), await note("V", "y")];
    const applied = await decided(c, d);
    const [e, f] = [await note("W", "x"), await note("X", "y")];
    const suggestion = await decided(e, f, { band: "suggest" });
    expect((await events(applied.relation.id)).map((event) => event.kind)).toEqual(["applied"]);
    expect((await events(suggestion.relation.id)).map((event) => event.kind)).toEqual([
      "suggested"
    ]);

    // A human verdict is never changed, so it records nothing.
    const [g, h] = [await note("Y", "x"), await note("Z", "y")];
    const kept = await decided(g, h, { status: "accepted" });
    const reviewed = await decided(h, g, { relationType: "contradicts" });
    expect([reviewed.change, reviewed.eventId]).toEqual(["reviewed", null]);
    expect(await events(kept.relation.id)).toHaveLength(1);

    // A banded write or a veto without its run is refused; a run that does not exist fails the
    // whole statement, so no relation is written without its event.
    const [i, j] = [await note("AA", "x"), await note("AB", "y")];
    const pairRows = async () =>
      (
        await db().query(
          `select 1 from atomic_note_relations
            where least($1::uuid, $2::uuid) = source_atomic_note_id
              and greatest($1::uuid, $2::uuid) = target_atomic_note_id`,
          [i, j]
        )
      ).rowCount;
    await expect(decided(i, j, { runId: null })).rejects.toThrow("needs its run");
    await expect(decided(i, j, { runId: randomUUID() })).rejects.toThrow(/relation_events_run_id/);
    expect(await pairRows()).toBe(0);
    await expect(
      relations().veto(applied.relation.id, "typer", undefined as unknown as string)
    ).rejects.toThrow("needs its run");
    // The interim generative matcher's band-null rows are written without a run and record none.
    const interim = await decided(i, j, { band: null, probability: null, runId: null });
    expect([interim.change, interim.eventId]).toEqual(["created", null]);
    expect(await events(interim.relation.id)).toHaveLength(0);
  });

  it("classifies every state with the five predicates, endpoints included (D9)", async () => {
    const self = await note("Self", "x");
    const other = (title: string, options: Parameters<typeof note>[2] = {}) =>
      note(title, "y", options);
    const supersededDocument = randomUUID();
    const oldChunk = randomUUID();
    const goneChunk = randomUUID();
    await db().query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash, metadata)
       values ($1, $2, 'Old', 'text', 'doc-old', jsonb_build_object('supersededByDocumentId', $3::text))`,
      [supersededDocument, works.y.id, works.y.document]
    );
    await db().query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Old passage', 'chunk-old'), ($4, $5, $3, 1, 'Gone passage', 'chunk-gone')`,
      [oldChunk, supersededDocument, works.y.id, goneChunk, works.y.document]
    );
    // Only a knowledge-owned note outlives its primary chunk.
    const orphan = await other("p10", { chunk: goneChunk, ownership: "knowledge" });
    await db().query("delete from chunks where id = $1", [goneChunk]);
    const cases: Array<{
      name: string;
      other: string;
      input: Parameters<typeof decided>[2];
      after?: (id: string) => Promise<unknown>;
      expected: string[];
    }> = [
      { name: "applied", other: await other("p1"), input: {}, expected: ["applied", "shown"] },
      {
        name: "legacy",
        other: await other("p2"),
        input: { band: null, probability: null, relationType: "similar_to" },
        expected: ["applied", "shown"]
      },
      {
        name: "suggested",
        other: await other("p3"),
        input: { band: "suggest" },
        expected: ["suggested", "shown"]
      },
      {
        name: "kept",
        other: await other("p4"),
        input: { band: "suggest", status: "accepted" },
        expected: ["applied", "shown"]
      },
      {
        name: "withdrawn",
        other: await other("p5"),
        input: {},
        after: (id) => relations().veto(id, "explainer", runId),
        expected: ["withdrawn"]
      },
      { name: "removed", other: await other("p6"), input: { status: "rejected" }, expected: [] },
      {
        name: "to an archived note",
        other: await other("p7", { status: "archived" }),
        input: {},
        expected: []
      },
      {
        name: "to an earlier version",
        other: await other("p8", { supersession: "superseded" }),
        input: {},
        expected: ["earlier"]
      },
      {
        name: "to a note whose evidence is superseded",
        other: await other("p9", { chunk: oldChunk }),
        input: {},
        expected: ["earlier"]
      },
      {
        name: "to a note whose evidence is gone",
        other: orphan,
        input: {},
        expected: ["earlier"]
      },
      {
        name: "a suggestion to an earlier version",
        other: await other("p11", { supersession: "superseded" }),
        input: { band: "suggest" },
        expected: []
      }
    ];
    for (const entry of cases) {
      const { relation } = await decided(self, entry.other, entry.input);
      await entry.after?.(relation.id);
      const row = (
        await db().query<Record<string, boolean>>(
          `select ${appliedNoteRelationSql("r")} as applied, ${suggestedNoteRelationSql("r")} as suggested,
                  ${shownNoteRelationSql("r")} as shown, ${withdrawnNoteRelationSql("r")} as withdrawn,
                  ${earlierVersionNoteRelationSql("r", "s", "o")} as earlier,
                  ${shownNoteRelationSql("r", ["s", "o"])} = ${shownNoteRelationSql("r")} as "sameShown"
             from atomic_note_relations r
             join atomic_notes s on s.id = $2 join atomic_notes o on o.id = $3
            where r.id = $1`,
          [relation.id, self, entry.other]
        )
      ).rows[0]!;
      expect(row.sameShown, entry.name).toBe(true);
      const truths = ["applied", "suggested", "shown", "withdrawn", "earlier"].filter(
        (key) => row[key]
      );
      expect(truths, entry.name).toEqual(entry.expected);
    }

    // The Note page lists each group through its predicate: the shown relations, the ones a veto
    // withdrew and, apart, the applied ones to notes that are not current (R29, flagged superseded
    // when the other note is), with the direction relative to its note; removed and archived ones
    // stay out.
    const notePages = createNotePageRepository(db());
    const group = async (name: "shown" | "withdrawn" | "earlier") =>
      notePages.listRelations(self, { group: name, offset: 0, limit: 50, contentLanguage: "en" });
    const [shownPage, withdrawnPage, earlierPage] = await Promise.all([
      group("shown"),
      group("withdrawn"),
      group("earlier")
    ]);
    const others = (key: string) =>
      cases.filter((entry) => entry.expected.includes(key)).map((entry) => entry.other);
    expect(shownPage.total).toBe(others("shown").length);
    expect(shownPage.items.map((item) => item.other.id).sort()).toEqual(others("shown").sort());
    expect(withdrawnPage.items.map((item) => item.other.id)).toEqual(others("withdrawn"));
    expect(withdrawnPage.items[0]).toMatchObject({ state: "withdrawn", vetoSource: "explainer" });
    expect(earlierPage.total).toBe(others("earlier").length);
    expect(earlierPage.items.map((item) => item.other.id).sort()).toEqual(others("earlier").sort());
    // A group is never listed in another: the same relation is in exactly one list.
    const all = [...shownPage.items, ...withdrawnPage.items, ...earlierPage.items];
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    const listed = new Map(shownPage.items.map((item) => [item.other.id, item]));
    expect(listed.get(cases[0]!.other)?.direction).toBe("outgoing");
    expect(listed.get(cases[0]!.other)).toMatchObject({ state: "applied", band: "apply" });
    expect(listed.get(cases[1]!.other)).toMatchObject({
      type: "similar_to",
      direction: "unknown",
      state: "applied",
      band: null
    });
    expect(listed.get(cases[2]!.other)).toMatchObject({ state: "suggested", band: "suggest" });
    expect(listed.get(cases[3]!.other)).toMatchObject({ state: "kept" });
    const earlier = new Map(earlierPage.items.map((item) => [item.other.id, item]));
    expect(earlier.get(cases[7]!.other)?.other.superseded).toBe(true);
  });

  it("reads the direction from the column in every reader", async () => {
    const [a, b] = [await note("M", "x"), await note("N", "y")];
    const { relation } = await decided(b, a, { relationType: "extends" });
    const notePages = createNotePageRepository(db());
    const read = (note: string) =>
      notePages.listRelations(note, {
        group: "shown",
        offset: 0,
        limit: 5,
        contentLanguage: "en"
      });
    const fromA = await read(a);
    const fromB = await read(b);
    expect(fromA.items.find((item) => item.id === relation.id)?.direction).toBe("incoming");
    expect(fromB.items.find((item) => item.id === relation.id)?.direction).toBe("outgoing");
    const context = await createRelationExplanationRepository(db()).readContext(relation.id);
    expect(context).toMatchObject({ semanticSourceId: b, type: "extends", listed: true });
    // A legacy relation whose direction was never recorded reads neutral everywhere.
    await db().query(
      "update atomic_note_relations set direction = 'unknown', band = null where id = $1",
      [relation.id]
    );
    expect((await read(a)).items.find((item) => item.id === relation.id)?.direction).toBe(
      "unknown"
    );
    expect(
      (await createRelationExplanationRepository(db()).readContext(relation.id))?.semanticSourceId
    ).toBeNull();
    const listedBySource = await relations().listBySourceItem(works.x.id);
    expect(listedBySource.find((row) => row.id === relation.id)).toMatchObject({
      direction: "unknown",
      shown: true,
      applied: true
    });
  });

  it("caches the typer's verdict per pair and typer, reused only on unchanged inputs", async () => {
    const [a, b] = [await note("O", "x"), await note("P", "y")];
    const [lo, hi] = [a, b].sort() as [string, string];
    const typings = createRelationTypingRepository(db());
    await typings.record({
      loAtomicNoteId: lo,
      hiAtomicNoteId: hi,
      typerKey: "typer-1",
      loHash: "lo-1",
      hiHash: "hi-1",
      relationType: "none",
      direction: null,
      aiTaskRunId: null
    });
    const lookup = (hiHash: string, typerKey = "typer-1") =>
      typings.find({
        typerKey,
        pairs: [{ loAtomicNoteId: hi, hiAtomicNoteId: lo, loHash: hiHash, hiHash: "lo-1" }]
      });
    // The pair may be named in either order; the hashes follow their notes.
    expect([...(await lookup("hi-1")).values()]).toMatchObject([
      { pairKey: `${lo}:${hi}`, relationType: "none", direction: null }
    ]);
    expect((await lookup("hi-2")).size).toBe(0);
    expect((await lookup("hi-1", "typer-2")).size).toBe(0);
    await expect(
      typings.record({
        loAtomicNoteId: hi,
        hiAtomicNoteId: lo,
        typerKey: "typer-1",
        loHash: "a",
        hiHash: "b",
        relationType: "supports",
        direction: "lo_to_hi",
        aiTaskRunId: null
      })
    ).rejects.toThrow("canonical");
    await expect(
      typings.record({
        loAtomicNoteId: lo,
        hiAtomicNoteId: hi,
        typerKey: "typer-1",
        loHash: "a",
        hiHash: "b",
        relationType: "supports",
        direction: "symmetric",
        aiTaskRunId: null
      })
    ).rejects.toThrow(/relation_typings_verdict/);
  });

  it("keeps per-note and per-root matching state", async () => {
    const [a, b] = [await note("Q", "x"), await note("R", "y")];
    const notes = createNoteMatchStateRepository(db());
    await notes.record({ noteId: a, deciderKey: "ranker", spaceKey: "space-1", kthCosine: 0.42 });
    await notes.record({ noteId: b, deciderKey: "ranker", spaceKey: "space-1", kthCosine: null });
    const states = await notes.read([a, b], "space-1");
    expect(states.get(a)?.kthCosine).toBeCloseTo(0.42, 5);
    expect(states.get(b)?.kthCosine).toBeNull();
    expect((await notes.read([a], "space-2")).size).toBe(0);
    await expect(
      notes.record({ noteId: a, deciderKey: "ranker", spaceKey: "space-1", kthCosine: 1.5 })
    ).rejects.toThrow("between -1 and 1");

    const roots = createSourceMatchStateRepository(db());
    const first = await roots.record({
      rootId: works.x.id,
      nearestRootId: null,
      nearestCosine: null,
      spaceKey: "space-1",
      fingerprint: "fx"
    });
    const second = await roots.record({
      rootId: works.y.id,
      nearestRootId: works.x.id,
      nearestCosine: 0.6,
      spaceKey: "space-1",
      fingerprint: "fy"
    });
    expect(second.matchSeq).toBeGreaterThan(first.matchSeq);
    const again = await roots.record({ ...first, fingerprint: "fx2" });
    expect(again.matchSeq).toBe(first.matchSeq);
    expect(await roots.offerNearest(works.x.id, works.y.id, 0.6)).toBe(true);
    expect(await roots.offerNearest(works.x.id, works.y.id, 0.5)).toBe(false);
    expect(await roots.offerNearest(works.x.id, works.x.id, 0.9)).toBe(false);
    expect((await roots.read(works.x.id))?.nearestRootId).toBe(works.y.id);
    expect(
      (await roots.listEarlier("space-1", second.matchSeq)).map((state) => state.rootId)
    ).toEqual([works.x.id]);
  });
});
