import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  SourceRelationViewSchema,
  defaultSourceRelationSettings,
  isDirectedNoteRelationType,
  type NoteRelationWriteType
} from "@app/domain";
import {
  PostgresSidecarManager,
  closePgPool,
  createAtomicNoteRelationRepository,
  createChunkRepository,
  createDocumentRepository,
  createEmbeddingRepository,
  createKnowledgeGraphDashboardRepository,
  createObsidianWikiRepository,
  createPgPool,
  createRelationEventRepository,
  createRelationMatchRunRepository,
  createSourceItemRepository,
  createSourceRelationExplanationRepository,
  createSourceRelationRepository,
  currentSourceRelationEvidenceSql,
  listSourceRelations,
  resolvePostgresSidecarPaths,
  runMigrations,
  sourceRelationEvidenceJoins,
  sourceRelationExplainable,
  sourceRelationExplanationPlan,
  type PgPool,
  type SourceRelationChunk
} from "@app/db";

import { aggregateSourceEmbedding } from "./job-supervisor.js";
import { buildCatalogMetadataMarkdown } from "./hierarchical-ingestion-service.js";
import { hierarchyRootComposite, refreshAncestorComposites } from "./source-composite.js";
import { matchSources } from "./source-relation-processing.js";

// Design E (F3 D27) against a real database: promotion of typed shown (applied or suggested,
// decision 29) note relations (majority type and direction, null scores, support count, owner
// rejection final, idempotent, retired when support is lost, typed-only with re-promotion on
// typing, R14), every automatic source relation, judged or promoted, reading as a suggestion until
// it is kept (by the owner or through a supporting note relation that reads as applied), the merge rules with judged
// verdicts and the readers' order (R4, I-R11), discovery's nearest and reverse neighbours on the
// composite vectors, a judged pair end to end, and a hierarchy root's composite recomputed.
// The generative judge's route (`op:source_relation_matching`, class `decide`); routing itself is
// covered by the AI service's tests.
const judgeRoute = vi.hoisted(() => ({
  profileId: "00000000-0000-4000-8000-000000000001",
  providerConfigId: "00000000-0000-4000-8000-000000000002",
  modelId: "judge-model",
  runtime: "remote",
  localModelId: null,
  revision: null,
  parameters: {},
  modelDefaultParameters: {},
  requiredCapabilities: ["text-generation"]
}));
vi.mock("@app/db", async (original) => {
  const actual = await original<typeof import("@app/db")>();
  return {
    ...actual,
    createAiConfigRepository: (pool: Parameters<typeof actual.createAiConfigRepository>[0]) => ({
      ...actual.createAiConfigRepository(pool),
      getDefaultTask: async () => judgeRoute
    })
  };
});
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const unit = (index: number) => Array.from({ length: 256 }, (_, i) => (i === index ? 1 : 0));
/** A unit vector at `cosine` from axis 0, in the plane of axes 0 and `axis`. */
const at = (cosine: number, axis: number) =>
  Array.from({ length: 256 }, (_, i) =>
    i === 0 ? cosine : i === axis ? Math.sqrt(1 - cosine * cosine) : 0
  );

describe.skipIf(!sidecarInstalled)("source relations by design E on PostgreSQL", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-source-design-e-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_source_design_e_test",
        user: "memora_source_design_e_test",
        password: `source-design-e-${randomUUID()}`,
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
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // --- fixtures -----------------------------------------------------------------------------------

  const work = async (title: string, parentId?: string, type = "AcademicPaper") => {
    const source = await createSourceItemRepository(db()).create({
      type: type as "AcademicPaper",
      title
    });
    if (parentId)
      await db().query("update source_items set parent_source_item_id = $1 where id = $2", [
        parentId,
        source.id
      ]);
    return source;
  };
  const passage = async (
    source: { id: string; title: string },
    content: string
  ): Promise<SourceRelationChunk> => {
    const document = await createDocumentRepository(db()).create({
      sourceItemId: source.id,
      title: source.title,
      canonicalMarkdown: content,
      contentHash: `hash-${content}`
    });
    const id = randomUUID(),
      span = randomUUID();
    await createChunkRepository(db()).replaceDocumentChunks(document.id, source.id, [
      {
        id,
        sourceSpanId: span,
        chunkIndex: 0,
        content,
        contentHash: `hash-${content}`,
        span: { id: span, startOffset: 0, endOffset: content.length }
      }
    ]);
    return {
      id,
      sourceItemId: source.id,
      documentId: document.id,
      sourceSpanId: span,
      content,
      contentHash: `hash-${content}`,
      title: source.title,
      summary: null,
      rootId: source.id,
      rootTitle: source.title,
      chunkIndex: 0
    };
  };
  /** A source with one passage and one note per idea. */
  const withNotes = async (source: { id: string; title: string }, ideas: string[]) => {
    const notes: string[] = [];
    for (const idea of ideas) {
      const chunk = await passage(source, `${source.title}: ${idea}`);
      const id = randomUUID();
      await db().query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
           evidence_chunk_id, generation_provider, generation_model, generation_runtime,
           generation_prompt_version, generation_key)
         values ($1::uuid, $2, $2, $2, $3, $4, 'test', 'test', 'local', 'test', $1::uuid::text)`,
        [id, idea, source.id, chunk.id]
      );
      notes.push(id);
    }
    return notes;
  };
  /**
   * A note relation read from `subject` to `object`. The direction is the owner's by default, so
   * promotion reads it; `typer` stores the guess nobody gave (decision 31b), which promotion does not.
   */
  const relate = async (
    subject: string,
    object: string,
    type: NoteRelationWriteType | null,
    band: "apply" | "suggest" | null = "apply",
    directionSource: "owner" | "decider" | "typer" = "owner"
  ) => {
    const run = await createRelationMatchRunRepository(db()).start({ kind: "link" });
    const written = await createAtomicNoteRelationRepository(db()).upsertDecided({
      subjectAtomicNoteId: subject,
      objectAtomicNoteId: object,
      relationType: type,
      band,
      directionSource: isDirectedNoteRelationType(type) ? directionSource : null,
      probability: 0.9,
      finalScore: 0.9,
      explanation: "knowledge.relations.explanations.reranked",
      runId: run.id
    });
    await createRelationMatchRunRepository(db()).finish(run.id, { outcome: "succeeded" });
    return written.relation.id;
  };
  const composite = async (rootId: string, embedding: number[], space: string) =>
    createEmbeddingRepository(db()).upsert({
      targetType: "source_item",
      targetId: rootId,
      provider: "test",
      model: "test-256",
      runtime: "local",
      strategy: `source-composite-centroid-v2:${space}`,
      contentHash: `composite-${rootId}`,
      embedding
    });
  const relationsBetween = async (left: string, right: string) =>
    (
      await db().query<{
        id: string;
        origin: string;
        relation_type: string;
        source_item_id: string;
        target_source_item_id: string;
        importance: number | null;
        confidence: number | null;
        support_count: number | null;
        status: string;
      }>(
        `select id, origin, relation_type, source_item_id, target_source_item_id, importance,
           confidence, support_count, status::text as status
           from source_relations
          where (source_item_id = $1 and target_source_item_id = $2)
             or (source_item_id = $2 and target_source_item_id = $1)
          order by relation_type, id`,
        [left, right]
      )
    ).rows;
  const staleNoteEvidence = async (relationIds: string[]) =>
    Number(
      (
        await db().query<{ n: number }>(
          `select count(*)::int as n from source_relation_evidence e ${sourceRelationEvidenceJoins}
            where e.relation_id = any($1::uuid[]) and e.origin = 'atomic_notes'
              and not ${currentSourceRelationEvidenceSql}`,
          [relationIds]
        )
      ).rows[0]!.n
    );

  // --- promotion ----------------------------------------------------------------------------------

  it("promotes the majority type with no scores, its support and evidence, once (D27)", async () => {
    const repository = createSourceRelationRepository(db());
    const retrieval = await work("Retrieval practice");
    const feedback = await work("Feedback timing");
    const [r1, r2, r3] = await withNotes(retrieval, ["Recall builds", "Effort helps", "Tests"]);
    const [x1, x2, x3] = await withNotes(feedback, ["Fast feedback", "Delays", "Corrections"]);
    await relate(r1!, x1!, "supports");
    await relate(r2!, x2!, "supports");
    await relate(r3!, x3!, "extends");
    await relate(r1!, x2!, null); // untyped: shown, never promoted
    await relate(r2!, x3!, "supports", "suggest"); // suggested: promoted with the applied ones

    const promotion = await repository.promoteFromNotes(retrieval.id);
    expect(promotion).toMatchObject({
      promoted: 1,
      refreshed: 0,
      retired: 0,
      ownerRejected: 0,
      otherRootIds: [feedback.id]
    });
    const [promoted, ...others] = await relationsBetween(retrieval.id, feedback.id);
    expect(others).toEqual([]);
    expect(promoted).toMatchObject({
      origin: "promoted",
      relation_type: "supports",
      source_item_id: retrieval.id,
      target_source_item_id: feedback.id,
      importance: null,
      confidence: null,
      support_count: 3,
      status: "pending_review"
    });
    // Its evidence is the three supporting note relations, current while they are shown; two read
    // as applied, which confirms the relation, so it is not a suggestion.
    const page = await listSourceRelations(db(), retrieval.id, feedback.id);
    const view = SourceRelationViewSchema.parse({ ...page.relations[0], writtenExplanation: null });
    expect(view).toMatchObject({
      origin: "promoted",
      supportCount: 3,
      importance: null,
      current: true,
      suggested: false
    });
    expect(view.evidence.map((evidence) => [evidence.origin, evidence.current])).toEqual([
      ["atomic_notes", true],
      ["atomic_notes", true],
      ["atomic_notes", true]
    ]);
    // One event in one `promote` run, which reverts exactly.
    const events = await createRelationEventRepository(db()).listByRun(promotion.runId!);
    expect(events.map((event) => [event.relationKind, event.kind, event.before])).toEqual([
      ["source", "promoted", null]
    ]);
    expect((await createRelationMatchRunRepository(db()).get(promotion.runId!))?.kind).toBe(
      "promote"
    );
    // Idempotent from either root.
    for (const root of [retrieval.id, feedback.id])
      expect(await repository.promoteFromNotes(root)).toMatchObject({
        promoted: 0,
        refreshed: 0,
        retired: 0,
        runId: null
      });
    expect(await createRelationEventRepository(db()).revertRun(promotion.runId!)).toMatchObject({
      kind: "reverted",
      deleted: 1
    });
    expect(await relationsBetween(retrieval.id, feedback.id)).toEqual([]);
  });

  it("promotes an untyped relation once it is typed, and re-promotes a re-typed one (R14, I-R10)", async () => {
    const repository = createSourceRelationRepository(db());
    const spacing = await work("Spacing effects");
    const sleep = await work("Sleep and memory");
    const [s1, s2] = await withNotes(spacing, ["Spaced reviews", "Intervals"]);
    const [m1, m2] = await withNotes(sleep, ["Consolidation", "Replay"]);
    await relate(s1!, m1!, null);
    expect(await repository.promoteFromNotes(spacing.id)).toMatchObject({ promoted: 0 });
    expect(await relationsBetween(spacing.id, sleep.id)).toEqual([]);
    // The link job's typing (or the sweep) types it: re-promotion of both roots promotes it.
    await relate(s1!, m1!, "depends_on");
    await relate(s2!, m2!, "depends_on");
    expect(await repository.promoteFromNotes(sleep.id)).toMatchObject({ promoted: 1 });
    const [first] = await relationsBetween(spacing.id, sleep.id);
    expect(first).toMatchObject({
      relation_type: "depends_on",
      source_item_id: spacing.id,
      support_count: 2
    });
    // Both note relations are re-typed: the old relation retires, the new type is promoted, and no
    // promoted evidence is left non-current under the facts-only fingerprint (D11).
    await relate(s1!, m1!, "same_as");
    await relate(s2!, m2!, "same_as");
    const retyped = await repository.promoteFromNotes(spacing.id);
    expect(retyped).toMatchObject({ promoted: 1, retired: 1 });
    const after = await relationsBetween(spacing.id, sleep.id);
    expect(after.map((row) => [row.relation_type, row.origin, row.support_count])).toEqual([
      ["same_as", "promoted", 2]
    ]);
    // A symmetric relation reads from the root first in content order ("Sleep" < "Spacing").
    expect(after[0]!.source_item_id).toBe(sleep.id);
    expect(await staleNoteEvidence(after.map((row) => row.id))).toBe(0);
    const kinds = (await createRelationEventRepository(db()).listByRun(retyped.runId!)).map(
      (event) => event.kind
    );
    expect(kinds.toSorted()).toEqual(["promoted", "retired"]);
    // Losing every supporting relation retires the promoted relation.
    await relate(s1!, m1!, null);
    await relate(s2!, m2!, null);
    expect(await repository.promoteFromNotes(sleep.id)).toMatchObject({ retired: 1 });
    expect(await relationsBetween(spacing.id, sleep.id)).toEqual([]);
  });

  it("reads a promoted relation from its notes' direction only when someone gave one (decision 31b)", async () => {
    const repository = createSourceRelationRepository(db());
    // Content order puts "Alpha blocking" before "Zeta interleaving", the reverse of the notes' guess.
    const zeta = await work("Zeta interleaving");
    const alpha = await work("Alpha blocking");
    const [z1, z2] = await withNotes(zeta, ["Mixing topics helps", "Interleaving beats blocking"]);
    const [a1, a2] = await withNotes(alpha, ["Blocking groups topics", "Blocking is easy"]);
    const readers = async () => {
      const [row] = await relationsBetween(zeta.id, alpha.id);
      const page = await listSourceRelations(db(), zeta.id, alpha.id);
      const context = await createSourceRelationExplanationRepository(db()).readContext(row!.id);
      const refs = await createObsidianWikiRepository(db()).relationRefs([zeta.id, alpha.id]);
      return {
        row: row!,
        directed: page.relations[0]?.directed,
        explanation: context ? sourceRelationExplanationPlan(context, "en").direction : null,
        // The vault's wiki leaves suggestions out; this one stays while a note relation is applied.
        wikiDirected: refs.find((ref) => ref.id === row!.id)?.directed ?? null
      };
    };
    // Guesses only: one relation that reads both ways, the roots in content order, and nothing
    // that states a direction names one.
    await relate(z1!, a1!, "extends", "apply", "typer");
    await relate(a2!, z2!, "extends", "apply", "typer");
    expect(await repository.promoteFromNotes(zeta.id)).toMatchObject({ promoted: 1 });
    const guessed = await readers();
    expect(guessed.row).toMatchObject({
      relation_type: "extends",
      source_item_id: alpha.id,
      target_source_item_id: zeta.id,
      support_count: 2
    });
    expect(guessed).toMatchObject({ directed: false, explanation: "symmetric" });
    // Idempotent from either root, and the guess changing its mind changes nothing.
    await relate(a1!, z1!, "extends", "apply", "typer");
    for (const root of [zeta.id, alpha.id])
      expect(await repository.promoteFromNotes(root)).toMatchObject({ promoted: 0, retired: 0 });
    // The owner gives one note relation a direction against the order the relation is stored in.
    // Until promotion turns it, the relation still reads both ways: never against the owner.
    await relate(z1!, a1!, "extends", "apply", "owner");
    expect(await readers()).toMatchObject({ directed: false, explanation: "symmetric" });
    // Promotion turns the same relation in place: it reads from the subject, and the notes that are
    // only linked still support it.
    const given = await repository.promoteFromNotes(zeta.id);
    expect(given).toMatchObject({ promoted: 0, refreshed: 1, retired: 0 });
    const directed = await readers();
    expect(directed.row).toMatchObject({
      id: guessed.row.id,
      relation_type: "extends",
      source_item_id: zeta.id,
      target_source_item_id: alpha.id,
      support_count: 2
    });
    expect(directed).toMatchObject({ directed: true, explanation: "s1_to_s2" });
    expect(await relationsBetween(zeta.id, alpha.id)).toHaveLength(1);
    expect(await staleNoteEvidence([directed.row.id])).toBe(0);
    // A symmetric type reads both ways whatever its source; it is never "directed".
    await relate(z2!, a2!, "same_as", "apply", "typer");
    await repository.promoteFromNotes(zeta.id);
    const same = (await relationsBetween(zeta.id, alpha.id)).find(
      (row) => row.relation_type === "same_as"
    );
    expect(same).toBeDefined();
    const page = await listSourceRelations(db(), zeta.id, alpha.id);
    expect(page.relations.find((item) => item.id === same!.id)?.directed).toBe(false);
  });

  it("turns a relation the owner kept in place when a direction arrives against its order, and the revert turns it back (decision 31b)", async () => {
    const repository = createSourceRelationRepository(db());
    const zeta = await work("Zeta massed practice");
    const alpha = await work("Alpha spaced practice");
    const [z1, z2] = await withNotes(zeta, ["Cramming works briefly", "Massing is quick"]);
    const [a1, a2] = await withNotes(alpha, ["Spacing lasts longer", "Spacing is slow"]);
    await relate(z1!, a1!, "extends", "apply", "typer");
    await relate(a2!, z2!, "extends", "apply", "typer");
    await repository.promoteFromNotes(zeta.id);
    const [linked] = await viewsBetween(zeta.id, alpha.id);
    expect(linked).toMatchObject({ directed: false, sourceItemId: alpha.id });
    // The owner keeps the relation as it reads: Alpha and Zeta, extends, no direction.
    expect(await repository.review(linked!.id, "accepted", linked!.updatedAt)).toBe(true);
    const before = (await relationsBetween(zeta.id, alpha.id))[0]!;
    const identity = String(
      (await db().query("select identity_key from source_relations where id = $1", [before.id]))
        .rows[0]!.identity_key
    );
    // Later the owner keeps a note relation of the pair with Zeta as subject.
    const noteRelation = await relate(z1!, a1!, "extends", "apply", "typer");
    const review = await createRelationMatchRunRepository(db()).start({ kind: "review" });
    await createAtomicNoteRelationRepository(db()).review(noteRelation, "keep", review.id, {
      subjectAtomicNoteId: z1!
    });
    await createRelationMatchRunRepository(db()).finish(review.id, { outcome: "succeeded" });
    // Not yet promoted again: the kept relation still reads both ways, never against the owner.
    expect((await viewsBetween(zeta.id, alpha.id))[0]).toMatchObject({
      id: before.id,
      directed: false,
      status: "accepted"
    });
    // Promotion turns the kept row: no second relation, no retirement, the status stays.
    const turned = await repository.promoteFromNotes(zeta.id);
    expect(turned).toMatchObject({ promoted: 0, refreshed: 1, retired: 0, ownerRejected: 0 });
    expect(await relationsBetween(zeta.id, alpha.id)).toEqual([
      expect.objectContaining({
        id: before.id,
        status: "accepted",
        origin: "promoted",
        source_item_id: zeta.id,
        target_source_item_id: alpha.id,
        support_count: 2
      })
    ]);
    expect((await viewsBetween(zeta.id, alpha.id))[0]).toMatchObject({
      id: before.id,
      directed: true,
      suggested: false,
      sourceItemId: zeta.id
    });
    expect(await staleNoteEvidence([before.id])).toBe(0);
    expect(
      (await db().query("select identity_key from source_relations where id = $1", [before.id]))
        .rows[0]!.identity_key
    ).not.toBe(identity);
    expect(await repository.promoteFromNotes(alpha.id)).toMatchObject({
      promoted: 0,
      refreshed: 0,
      retired: 0,
      runId: null
    });
    // One event with both images; the revert puts the row back as it was, byte for byte.
    const events = await createRelationEventRepository(db()).listByRun(turned.runId!);
    expect(events.map((event) => [event.kind, event.before !== null])).toEqual([
      ["promoted", true]
    ]);
    expect(await createRelationEventRepository(db()).revertRun(turned.runId!)).toMatchObject({
      kind: "reverted"
    });
    expect(
      (await db().query("select identity_key from source_relations where id = $1", [before.id]))
        .rows[0]!.identity_key
    ).toBe(identity);
    expect(await relationsBetween(zeta.id, alpha.id)).toEqual([
      expect.objectContaining({ id: before.id, source_item_id: alpha.id, status: "accepted" })
    ]);
  });

  it("keeps an owner's removal final and a relation read as stored when directions arrive both ways (decision 31b)", async () => {
    const repository = createSourceRelationRepository(db());
    // Removed by the owner as it reads both ways: a direction against its order makes no new one.
    const zeta = await work("Zeta lectures");
    const alpha = await work("Alpha labs");
    const [z1, z2] = await withNotes(zeta, ["Lectures explain", "Lectures scale"]);
    const [a1, a2] = await withNotes(alpha, ["Labs apply", "Labs are costly"]);
    await relate(z1!, a1!, "extends", "apply", "typer");
    await relate(a2!, z2!, "extends", "apply", "typer");
    await repository.promoteFromNotes(zeta.id);
    const [removed] = await relationsBetween(zeta.id, alpha.id);
    await db().query("update source_relations set status = 'rejected' where id = $1", [
      removed!.id
    ]);
    await relate(z1!, a1!, "extends", "apply", "owner");
    expect(await repository.promoteFromNotes(zeta.id)).toMatchObject({
      promoted: 0,
      refreshed: 0,
      retired: 0,
      ownerRejected: 1
    });
    expect(await relationsBetween(zeta.id, alpha.id)).toEqual([
      expect.objectContaining({ id: removed!.id, status: "rejected", source_item_id: alpha.id })
    ]);

    // Directions both ways: the stored relation keeps the way it is stored, the other gets its own.
    const left = await work("Zeta seminars");
    const right = await work("Alpha workshops");
    const [l1, l2] = await withNotes(left, ["Seminars discuss", "Seminars invite"]);
    const [r1, r2] = await withNotes(right, ["Workshops build", "Workshops mix"]);
    await relate(l1!, r1!, "extends", "apply", "typer");
    await repository.promoteFromNotes(left.id);
    const [stored] = await relationsBetween(left.id, right.id);
    expect(stored).toMatchObject({ source_item_id: right.id });
    await relate(l1!, r1!, "extends", "apply", "owner");
    await relate(r2!, l2!, "extends", "apply", "owner");
    expect(await repository.promoteFromNotes(left.id)).toMatchObject({
      promoted: 1,
      retired: 0,
      ownerRejected: 0
    });
    const both = await relationsBetween(left.id, right.id);
    expect(both.map((row) => [row.source_item_id, row.target_source_item_id])).toHaveLength(2);
    expect(both.find((row) => row.id === stored!.id)).toMatchObject({
      source_item_id: right.id,
      target_source_item_id: left.id
    });
    expect(both.every((row) => row.support_count === 1)).toBe(true);
    expect(await repository.promoteFromNotes(right.id)).toMatchObject({
      promoted: 0,
      refreshed: 0,
      retired: 0,
      runId: null
    });
  });

  it("keeps the linked notes as support and the relation confirmed when one directed suggestion arrives (decision 31b)", async () => {
    const repository = createSourceRelationRepository(db());
    const zeta = await work("Zeta retrieval");
    const alpha = await work("Alpha restudy");
    const ideas = ["one", "two", "three", "four"];
    const zs = await withNotes(
      zeta,
      ideas.map((idea) => `Retrieval ${idea}`)
    );
    const as = await withNotes(
      alpha,
      ideas.map((idea) => `Restudy ${idea}`)
    );
    // Three relations the owner kept with the default "no direction".
    const review = await createRelationMatchRunRepository(db()).start({ kind: "review" });
    for (const index of [0, 1, 2]) {
      const id = await relate(zs[index]!, as[index]!, "extends", "apply", "typer");
      await createAtomicNoteRelationRepository(db()).review(id, "keep", review.id, {
        subjectAtomicNoteId: null
      });
    }
    await createRelationMatchRunRepository(db()).finish(review.id, { outcome: "succeeded" });
    expect(await repository.promoteFromNotes(zeta.id)).toMatchObject({ promoted: 1 });
    const [confirmed] = await viewsBetween(zeta.id, alpha.id);
    expect(confirmed).toMatchObject({ suggested: false, supportCount: 3, directed: false });
    // The decider suggests a direction for a fourth pair: the same relation turns to read from its
    // subject, with all four notes as support, and it stays confirmed and in the wiki.
    await relate(zs[3]!, as[3]!, "extends", "suggest", "decider");
    expect(await repository.promoteFromNotes(zeta.id)).toMatchObject({
      promoted: 0,
      refreshed: 1,
      retired: 0
    });
    expect(await viewsBetween(zeta.id, alpha.id)).toEqual([
      expect.objectContaining({
        id: confirmed!.id,
        suggested: false,
        supportCount: 4,
        directed: true,
        sourceItemId: zeta.id
      })
    ]);
    expect(await wikiRelations(zeta.id, alpha.id)).toEqual([confirmed!.id]);
    expect(await staleNoteEvidence([confirmed!.id])).toBe(0);
  });

  it("plans a pair's promotion from what it reads under the pair's lock (R14, I-R10)", async () => {
    const repository = createSourceRelationRepository(db());
    const rhythm = await work("Circadian rhythm");
    const timing = await work("Study timing");
    const [c1] = await withNotes(rhythm, ["Alertness cycles"]);
    const [t1] = await withNotes(timing, ["Morning study"]);
    await relate(c1!, t1!, "depends_on");
    // Another writer of the pair (a judged decision, a pass for the other root) holds its lock.
    const holder = await db().connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        [rhythm.id, timing.id].sort().join(":")
      ]);
      const pass = repository.promoteFromNotes(rhythm.id);
      // The pass has read the pair and waits for its lock; the typer re-types the relation.
      await vi.waitFor(
        async () =>
          expect(
            Number(
              (
                await db().query<{ n: number }>(
                  "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted"
                )
              ).rows[0]!.n
            )
          ).toBe(1),
        { timeout: 5_000, interval: 10 }
      );
      await relate(c1!, t1!, "supports");
      await holder.query("commit");
      await pass;
    } finally {
      holder.release();
    }
    // The pass writes what holds once it has the lock, not what it read before waiting.
    const rows = await relationsBetween(rhythm.id, timing.id);
    expect(rows.map((row) => [row.relation_type, row.origin, row.support_count])).toEqual([
      ["supports", "promoted", 1]
    ]);
    expect(await staleNoteEvidence(rows.map((row) => row.id))).toBe(0);
  });

  it("keeps an owner rejection final and an owner-kept relation when support is lost", async () => {
    const repository = createSourceRelationRepository(db());
    const one = await work("Attention spans");
    const two = await work("Multitasking costs");
    const [a1] = await withNotes(one, ["Attention is finite"]);
    const [b1] = await withNotes(two, ["Switching costs time"]);
    await relate(a1!, b1!, "supports");
    await repository.promoteFromNotes(one.id);
    const [row] = await relationsBetween(one.id, two.id);
    await db().query("update source_relations set status = 'rejected' where id = $1", [row!.id]);
    expect(await repository.promoteFromNotes(one.id)).toMatchObject({
      promoted: 0,
      ownerRejected: 1
    });
    expect((await relationsBetween(one.id, two.id)).map((item) => item.status)).toEqual([
      "rejected"
    ]);
    // Kept by the owner: when its support goes, the relation stays (never retired automatically).
    await db().query("update source_relations set status = 'accepted' where id = $1", [row!.id]);
    await relate(a1!, b1!, null);
    expect(await repository.promoteFromNotes(two.id)).toMatchObject({ retired: 0 });
    expect((await relationsBetween(one.id, two.id)).map((item) => item.status)).toEqual([
      "accepted"
    ]);
  });

  it("lets a judged verdict upgrade a promoted relation and never downgrades it (R4, I-R11)", async () => {
    const repository = createSourceRelationRepository(db());
    const habits = await work("Habit loops");
    const cues = await work("Context cues");
    const third = await work("Unrelated reading");
    const [h1, h2] = await withNotes(habits, ["Loops repeat", "Rewards"]);
    const [c1, c2] = await withNotes(cues, ["Cues trigger", "Context matters"]);
    const [t1] = await withNotes(third, ["A side note"]);
    await relate(h1!, c1!, "extends");
    await relate(h1!, t1!, "clarifies");
    await repository.promoteFromNotes(habits.id);
    const habitChunk = await passage(habits, "Habits form through repeated cue and reward.");
    const cueChunk = await passage(cues, "Stable contexts cue habitual behaviour.");
    const judged = (relationType: string) => ({
      existingId: null,
      sourceItemId: habits.id,
      targetSourceItemId: cues.id,
      relationType,
      sourceIdea: null,
      targetIdea: null,
      explanation: null,
      importance: 0.9,
      confidence: 0.95,
      evidence: [{ source: habitChunk, target: cueChunk, note: null }]
    });
    expect(
      await repository.commitDecision(
        `judged-${randomUUID()}`,
        habits.id,
        cues.id,
        [judged("extends")],
        {}
      )
    ).toBe(1);
    const [upgraded] = await relationsBetween(habits.id, cues.id);
    expect(upgraded).toMatchObject({
      origin: "judged",
      importance: 0.9,
      confidence: 0.95,
      support_count: 1
    });
    // Promotion refreshes the judged relation's support and leaves its origin and scores.
    await relate(h2!, c2!, "extends");
    expect(await repository.promoteFromNotes(cues.id)).toMatchObject({ promoted: 0, refreshed: 1 });
    const [refreshed, ...more] = await relationsBetween(habits.id, cues.id);
    expect(more).toEqual([]);
    expect(refreshed).toMatchObject({
      id: upgraded!.id,
      origin: "judged",
      importance: 0.9,
      support_count: 2
    });
    // Readers list scored relations first, then promoted ones (nulls last).
    const page = await listSourceRelations(db(), habits.id, null);
    expect(page.relations.map((relation) => relation.origin)).toEqual(["judged", "promoted"]);
  });

  it("keeps one relation per root pair and type for a book: chapters' verdicts join the promoted one", async () => {
    const repository = createSourceRelationRepository(db());
    const book = await work("Memory book", undefined, "Book");
    const first = await work("Memory book chapter one", book.id, "BookChapter");
    const second = await work("Memory book chapter two", book.id, "BookChapter");
    const paper = await work("Recall paper");
    const [f1] = await withNotes(first, ["Recall consolidates"]);
    const [s1] = await withNotes(second, ["Testing helps"]);
    const [p1, p2] = await withNotes(paper, ["Retrieval strengthens", "Practice tests"]);
    await relate(f1!, p1!, "supports");
    await relate(s1!, p2!, "supports");
    expect(await repository.promoteFromNotes(book.id)).toMatchObject({ promoted: 1 });
    const [promoted] = await relationsBetween(book.id, paper.id);
    expect(promoted).toMatchObject({
      source_item_id: book.id,
      origin: "promoted",
      support_count: 2
    });
    // The promoted relation's evidence lies in the book's chapters, and is current.
    const page = await listSourceRelations(db(), book.id, paper.id);
    expect(
      page.relations[0]!.evidence.map((evidence: { current: boolean }) => evidence.current)
    ).toEqual([true, true]);
    // The judge answers about chapters: each verdict joins the book's one relation.
    for (const chapter of [first, second]) {
      const chapterChunk = await passage(chapter, `${chapter.title}: retrieval evidence`);
      const paperChunk = await passage(paper, `Recall paper evidence for ${chapter.title}`);
      await repository.commitDecision(
        `judged-${randomUUID()}`,
        book.id,
        paper.id,
        [
          {
            existingId: null,
            sourceItemId: chapter.id,
            targetSourceItemId: paper.id,
            relationType: "supports",
            sourceIdea: null,
            targetIdea: null,
            explanation: null,
            importance: 0.8,
            confidence: 0.9,
            evidence: [{ source: chapterChunk, target: paperChunk, note: null }]
          }
        ],
        {}
      );
    }
    const rows = await relationsBetween(book.id, paper.id);
    const chapterRows = (
      await db().query("select id from source_relations where source_item_id = any($1::uuid[])", [
        [first.id, second.id]
      ])
    ).rows;
    expect(chapterRows).toEqual([]);
    expect(rows).toEqual([
      expect.objectContaining({
        id: promoted!.id,
        origin: "judged",
        importance: 0.8,
        support_count: 2
      })
    ]);
  });

  it("treats a relation saved as contrasts and one written as contradicts as the same", async () => {
    const repository = createSourceRelationRepository(db());
    const left = await work("Growth mindset");
    const right = await work("Fixed ability beliefs");
    const leftChunk = await passage(left, "Ability grows with effort.");
    const rightChunk = await passage(right, "Ability is fixed at birth.");
    const verdict = (relationType: string) => ({
      existingId: null,
      sourceItemId: left.id,
      targetSourceItemId: right.id,
      relationType,
      sourceIdea: null,
      targetIdea: null,
      explanation: null,
      importance: 0.9,
      confidence: 0.9,
      evidence: [{ source: leftChunk, target: rightChunk, note: null }]
    });
    // A relation the earlier judge saved as contrasts, which the owner rejected.
    expect(
      await repository.commitDecision(
        `old-${randomUUID()}`,
        left.id,
        right.id,
        [verdict("contrasts")],
        {}
      )
    ).toBe(1);
    const [saved] = await relationsBetween(left.id, right.id);
    await db().query("update source_relations set status = 'rejected' where id = $1", [saved!.id]);
    // The judge now writes contradicts: the rejection stands for it, and for promotion.
    expect(
      await repository.commitDecision(
        `new-${randomUUID()}`,
        left.id,
        right.id,
        [verdict("contradicts")],
        {}
      )
    ).toBe(0);
    const [l1] = await withNotes(left, ["Effort changes ability"]);
    const [r1] = await withNotes(right, ["Ability cannot change"]);
    await relate(l1!, r1!, "contradicts");
    expect(await repository.promoteFromNotes(left.id)).toMatchObject({
      promoted: 0,
      ownerRejected: 1
    });
    expect((await relationsBetween(left.id, right.id)).map((row) => row.status)).toEqual([
      "rejected"
    ]);
  });

  // --- suggestions (decision 29) -------------------------------------------------------------------

  /** The relations between two works as readers list them, parsed with the view schema. */
  const viewsBetween = async (left: string, right: string) =>
    (await listSourceRelations(db(), left, right)).relations.map((relation) =>
      SourceRelationViewSchema.parse({ ...relation, writtenExplanation: null })
    );
  /** The owner's verdict on a note relation (the review writer's effect on its row). */
  const decideNote = (relationId: string, status: "accepted" | "rejected") =>
    db().query(
      "update atomic_note_relations set status = $2::atomic_note_relation_status where id = $1",
      [relationId, status]
    );
  /** What the vault's wiki would write of the relations between two works. */
  const wikiRelations = async (left: string, right: string) =>
    (await createObsidianWikiRepository(db()).relationRefs([left, right])).map((ref) =>
      String(ref.id)
    );
  /** Two works with one typed note relation of the given band between each pair of their notes. */
  const linkedWorks = async (
    names: [string, string],
    relations: Array<{ type: NoteRelationWriteType | null; band: "apply" | "suggest" | null }>
  ) => {
    const left = await work(names[0]);
    const right = await work(names[1]);
    const lefts = await withNotes(
      left,
      relations.map((_, index) => `${names[0]} idea ${index}`)
    );
    const rights = await withNotes(
      right,
      relations.map((_, index) => `${names[1]} idea ${index}`)
    );
    const noteRelationIds: string[] = [];
    for (const [index, item] of relations.entries())
      noteRelationIds.push(await relate(lefts[index]!, rights[index]!, item.type, item.band));
    return { left, right, noteRelationIds };
  };

  it("promotes typed suggestions to a suggested source relation that every reader reads as one", async () => {
    const repository = createSourceRelationRepository(db());
    const { left, right } = await linkedWorks(
      ["Spaced repetition", "Flashcard design"],
      [
        { type: "supports", band: "suggest" },
        { type: "supports", band: "suggest" },
        { type: null, band: "suggest" } // untyped: shown, never promoted
      ]
    );
    const promotion = await repository.promoteFromNotes(left.id);
    expect(promotion).toMatchObject({ promoted: 1, refreshed: 0, retired: 0, ownerRejected: 0 });
    const [row, ...others] = await relationsBetween(left.id, right.id);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      origin: "promoted",
      relation_type: "supports",
      importance: null,
      confidence: null,
      support_count: 2,
      status: "pending_review"
    });
    // The list reads it as a suggestion, with current evidence: a suggested note relation supports it.
    const [view, ...more] = await viewsBetween(left.id, right.id);
    expect(more).toEqual([]);
    expect(view).toMatchObject({
      origin: "promoted",
      suggested: true,
      supportCount: 2,
      status: "pending_review",
      current: true
    });
    expect(view!.evidence.map((evidence) => evidence.current)).toEqual([true, true]);
    // Its explanation can be written: both sides have current passages.
    const context = await createSourceRelationExplanationRepository(db()).readContext(view!.id);
    expect(context && sourceRelationExplainable(context)).toBe(true);
    // The graph draws it, marked as a suggestion; the vault's wiki leaves it out, as the vault's
    // note links leave out suggestions.
    const graph = await createKnowledgeGraphDashboardRepository(db()).get("sources", "relations");
    expect(graph.edges.find((edge) => edge.id === view!.id)).toMatchObject({
      kind: "source_relation",
      label: "supports",
      suggested: true
    });
    expect(await wikiRelations(left.id, right.id)).toEqual([]);
    // Idempotent from either root: nothing changes, no run is recorded, and it stays a suggestion.
    for (const root of [left.id, right.id])
      expect(await repository.promoteFromNotes(root)).toMatchObject({
        promoted: 0,
        refreshed: 0,
        retired: 0,
        runId: null
      });
    expect((await viewsBetween(left.id, right.id)).map((item) => item.suggested)).toEqual([true]);
  });

  it("ends the suggestion when the owner keeps the source relation, or any note relation that supports it", async () => {
    const repository = createSourceRelationRepository(db());
    // Kept on the source relation itself: Accept.
    const kept = await linkedWorks(
      ["Interleaved practice", "Blocked practice"],
      [
        { type: "contradicts", band: "suggest" },
        { type: "contradicts", band: "suggest" }
      ]
    );
    await repository.promoteFromNotes(kept.left.id);
    const [suggestion] = await viewsBetween(kept.left.id, kept.right.id);
    expect(suggestion).toMatchObject({ suggested: true, status: "pending_review" });
    expect(await repository.review(suggestion!.id, "accepted", suggestion!.updatedAt)).toBe(true);
    expect(await viewsBetween(kept.left.id, kept.right.id)).toEqual([
      expect.objectContaining({ id: suggestion!.id, suggested: false, status: "accepted" })
    ]);
    expect(await wikiRelations(kept.left.id, kept.right.id)).toEqual([suggestion!.id]);

    // Kept through a supporting note relation: the owner keeps one of the two suggestions. The
    // source relation reads as kept at once, with no new promotion pass, and its evidence and
    // support do not change.
    const through = await linkedWorks(
      ["Elaborative interrogation", "Self explanation"],
      [
        { type: "extends", band: "suggest" },
        { type: "extends", band: "suggest" }
      ]
    );
    await repository.promoteFromNotes(through.left.id);
    expect((await viewsBetween(through.left.id, through.right.id))[0]).toMatchObject({
      suggested: true
    });
    expect(await wikiRelations(through.left.id, through.right.id)).toEqual([]);
    await decideNote(through.noteRelationIds[0]!, "accepted");
    const [upgraded] = await viewsBetween(through.left.id, through.right.id);
    expect(upgraded).toMatchObject({
      suggested: false,
      status: "pending_review",
      supportCount: 2,
      current: true
    });
    expect(await wikiRelations(through.left.id, through.right.id)).toEqual([upgraded!.id]);
    expect(await repository.promoteFromNotes(through.left.id)).toMatchObject({
      promoted: 0,
      refreshed: 0,
      retired: 0,
      runId: null
    });
    // Removing the kept one leaves the other suggestion: it is a suggestion again.
    await decideNote(through.noteRelationIds[0]!, "rejected");
    expect(await repository.promoteFromNotes(through.left.id)).toMatchObject({ refreshed: 1 });
    expect((await viewsBetween(through.left.id, through.right.id))[0]).toMatchObject({
      suggested: true,
      supportCount: 1
    });
  });

  it("counts applied and suggested note relations alike, and any that reads as applied confirms (D47, decision 29)", async () => {
    const repository = createSourceRelationRepository(db());
    // An F3 suggestion confirms nothing: the relation stays a suggestion, whatever the count.
    const suggestions = await linkedWorks(
      ["Dual coding", "Concrete examples"],
      [
        { type: "clarifies", band: "suggest" },
        { type: "clarifies", band: "suggest" },
        { type: "clarifies", band: "suggest" }
      ]
    );
    expect(await repository.promoteFromNotes(suggestions.left.id)).toMatchObject({ promoted: 1 });
    expect((await viewsBetween(suggestions.left.id, suggestions.right.id))[0]).toMatchObject({
      origin: "promoted",
      suggested: true,
      supportCount: 3
    });
    // An existing relation with no band reads as applied (D47): one among the suggestions confirms,
    // and every supporting relation is still counted.
    const legacy = await linkedWorks(
      ["Analogical reasoning", "Transfer of learning"],
      [
        { type: "same_as", band: null },
        { type: "same_as", band: "suggest" },
        { type: "same_as", band: "suggest" }
      ]
    );
    expect(await repository.promoteFromNotes(legacy.left.id)).toMatchObject({ promoted: 1 });
    expect((await viewsBetween(legacy.left.id, legacy.right.id))[0]).toMatchObject({
      origin: "promoted",
      suggested: false,
      status: "pending_review",
      supportCount: 3
    });
    // The owner's Keep is an applied reading too, and it is what a suggestion needs to be confirmed.
    await decideNote(suggestions.noteRelationIds[0]!, "accepted");
    expect((await viewsBetween(suggestions.left.id, suggestions.right.id))[0]).toMatchObject({
      suggested: false,
      status: "pending_review",
      supportCount: 3
    });
    // A confirmed relation whose confirming relation is removed is a suggestion again.
    await decideNote(suggestions.noteRelationIds[0]!, "rejected");
    expect((await viewsBetween(suggestions.left.id, suggestions.right.id))[0]).toMatchObject({
      suggested: true
    });
  });

  it("retires a suggested relation when its last supporting relation is removed, and keeps an owner removal final", async () => {
    const repository = createSourceRelationRepository(db());
    const { left, right, noteRelationIds } = await linkedWorks(
      ["Desirable difficulties", "Fluency illusions"],
      [
        { type: "supports", band: "suggest" },
        { type: "supports", band: "suggest" }
      ]
    );
    await repository.promoteFromNotes(left.id);
    // One removal refreshes the support; the last one retires the relation, as one event.
    await decideNote(noteRelationIds[0]!, "rejected");
    expect(await repository.promoteFromNotes(left.id)).toMatchObject({ refreshed: 1, retired: 0 });
    expect((await viewsBetween(left.id, right.id))[0]).toMatchObject({
      suggested: true,
      supportCount: 1
    });
    await decideNote(noteRelationIds[1]!, "rejected");
    // Before the pass runs nothing supports it: it is stale, and still a suggestion nobody kept.
    expect((await viewsBetween(left.id, right.id))[0]).toMatchObject({
      suggested: true,
      current: false
    });
    const retired = await repository.promoteFromNotes(right.id);
    expect(retired).toMatchObject({ promoted: 0, retired: 1 });
    expect(await relationsBetween(left.id, right.id)).toEqual([]);
    expect(
      (await createRelationEventRepository(db()).listByRun(retired.runId!)).map(
        (event) => event.kind
      )
    ).toEqual(["retired"]);

    // The owner removes a suggested source relation: it is never promoted again, and the note
    // suggestions that supported it stay as they are.
    const other = await linkedWorks(
      ["Testing effect", "Restudy"],
      [{ type: "supports", band: "suggest" }]
    );
    await repository.promoteFromNotes(other.left.id);
    const [suggestion] = await viewsBetween(other.left.id, other.right.id);
    expect(await repository.review(suggestion!.id, "rejected", suggestion!.updatedAt)).toBe(true);
    expect(await repository.promoteFromNotes(other.left.id)).toMatchObject({
      promoted: 0,
      ownerRejected: 1
    });
    expect(
      (await relationsBetween(other.left.id, other.right.id)).map((row) => row.status)
    ).toEqual(["rejected"]);
    expect((await viewsBetween(other.left.id, other.right.id))[0]).toMatchObject({
      suggested: false,
      status: "rejected"
    });
  });

  const judgedVerdict = (
    left: { id: string },
    right: { id: string },
    leftChunk: SourceRelationChunk,
    rightChunk: SourceRelationChunk,
    relationType = "extends"
  ) => ({
    existingId: null,
    sourceItemId: left.id,
    targetSourceItemId: right.id,
    relationType,
    sourceIdea: null,
    targetIdea: null,
    explanation: null,
    importance: 0.9,
    confidence: 0.95,
    evidence: [{ source: leftChunk, target: rightChunk, note: null }]
  });

  it("keeps a promoted suggestion a suggestion when a judged verdict lands on it", async () => {
    const repository = createSourceRelationRepository(db());
    const { left, right, noteRelationIds } = await linkedWorks(
      ["Mnemonic devices", "Method of loci"],
      [{ type: "extends", band: "suggest" }]
    );
    await repository.promoteFromNotes(left.id);
    expect((await viewsBetween(left.id, right.id))[0]).toMatchObject({ suggested: true });
    const leftChunk = await passage(left, "Mnemonics organise material into memorable images.");
    const rightChunk = await passage(right, "The method of loci places images along a route.");
    await repository.commitDecision(
      `judged-${randomUUID()}`,
      left.id,
      right.id,
      [judgedVerdict(left, right, leftChunk, rightChunk)],
      {}
    );
    // Automatic and automatic: the judge's scores are in, the relation is still not the owner's.
    expect((await viewsBetween(left.id, right.id))[0]).toMatchObject({
      origin: "judged",
      suggested: true,
      importance: 0.9,
      supportCount: 1
    });
    expect(await wikiRelations(left.id, right.id)).toEqual([]);
    // Keeping the supporting note relation confirms it, as for a promoted one.
    await decideNote(noteRelationIds[0]!, "accepted");
    expect((await viewsBetween(left.id, right.id))[0]).toMatchObject({
      origin: "judged",
      suggested: false,
      status: "pending_review"
    });
  });

  it("reads an unreviewed judged relation as a suggestion that only the owner's Keep confirms", async () => {
    const repository = createSourceRelationRepository(db());
    const left = await work("Cognitive load theory");
    const right = await work("Worked examples");
    const leftChunk = await passage(left, "Working memory holds few elements at once.");
    const rightChunk = await passage(right, "Studying solved problems lowers the load on novices.");
    expect(
      await repository.commitDecision(
        `judged-${randomUUID()}`,
        left.id,
        right.id,
        [judgedVerdict(left, right, leftChunk, rightChunk, "supports")],
        {}
      )
    ).toBe(1);
    const [suggestion] = await viewsBetween(left.id, right.id);
    expect(suggestion).toMatchObject({
      origin: "judged",
      suggested: true,
      status: "pending_review",
      supportCount: null,
      current: true
    });
    const graph = await createKnowledgeGraphDashboardRepository(db()).get("sources", "relations");
    expect(graph.edges.find((edge) => edge.id === suggestion!.id)).toMatchObject({
      kind: "source_relation",
      suggested: true
    });
    expect(await wikiRelations(left.id, right.id)).toEqual([]);
    // The owner's Keep confirms it, and the vault's wiki writes it.
    expect(await repository.review(suggestion!.id, "accepted", suggestion!.updatedAt)).toBe(true);
    expect((await viewsBetween(left.id, right.id))[0]).toMatchObject({
      suggested: false,
      status: "accepted"
    });
    expect(await wikiRelations(left.id, right.id)).toEqual([suggestion!.id]);
    // Removed instead, it is final: a later verdict on the pair does not bring it back.
    const other = await work("Expertise reversal");
    const otherChunk = await passage(other, "Guidance that helps novices can hamper experts.");
    await repository.commitDecision(
      `judged-${randomUUID()}`,
      left.id,
      other.id,
      [judgedVerdict(left, other, leftChunk, otherChunk, "extends")],
      {}
    );
    const [removable] = await viewsBetween(left.id, other.id);
    expect(removable).toMatchObject({ suggested: true });
    expect(await repository.review(removable!.id, "rejected", removable!.updatedAt)).toBe(true);
    expect(
      await repository.commitDecision(
        `judged-${randomUUID()}`,
        left.id,
        other.id,
        [judgedVerdict(left, other, leftChunk, otherChunk, "extends")],
        {}
      )
    ).toBe(0);
    expect((await viewsBetween(left.id, other.id))[0]).toMatchObject({
      suggested: false,
      status: "rejected"
    });
  });

  // --- discovery ----------------------------------------------------------------------------------

  it("plans the nearest earlier root and the reverse neighbours, and stores their state", async () => {
    const repository = createSourceRelationRepository(db());
    const space = `space-${randomUUID()}`;
    const root = async (title: string, vector: number[], notes = true) => {
      const source = await work(title);
      if (notes) await withNotes(source, [`${title} idea`]);
      else await passage(source, `${title} text`);
      await composite(source.id, vector, space);
      return source;
    };
    const discover = async (rootId: string, neighbours = 1) =>
      repository.planDiscovery({
        rootId,
        vector: (await repository.discoveryVector(rootId))!,
        fingerprint: await repository.fingerprint(rootId),
        neighbours
      });
    const first = await root("Alpha root", unit(0));
    expect((await discover(first.id)).pairs).toEqual([]);
    const second = await root("Beta root", at(0.9, 1));
    // Mutual nearest: the second's nearest is the first, whose empty bar it beats.
    expect((await discover(second.id)).pairs.map((pair) => [pair.rootId, pair.reason])).toEqual([
      [first.id, "nearest"]
    ]);
    const third = await root("Gamma root", at(0.95, 2));
    const plan = await discover(third.id);
    // Nearest of the third is the first (0.95); the second's bar (0.9 to the first) is not beaten
    // by its cosine to the third (about 0.855).
    expect(plan.pairs.map((pair) => [pair.rootId, pair.reason])).toEqual([[first.id, "nearest"]]);
    const states = await repository.matchStates([first.id, second.id, third.id]);
    expect(states.map((state) => state.rootId)).toEqual([first.id, second.id, third.id]);
    expect(states[0]).toMatchObject({ nearestRootId: third.id });
    expect(states[0]!.nearestCosine).toBeCloseTo(0.95, 4);
    expect(states[2]).toMatchObject({ nearestRootId: first.id });
    // A root without notes, a root in another space and a linked root are never candidates.
    const silent = await root("Delta root", unit(0), false);
    await discover(silent.id);
    const elsewhere = await work("Epsilon root");
    await withNotes(elsewhere, ["Elsewhere idea"]);
    await composite(elsewhere.id, unit(0), `other-${space}`);
    await discover(elsewhere.id);
    const linked = await root("Zeta root", at(0.99, 3));
    const [l1] = (await withNotes(linked, ["Linked idea"])) as [string];
    const [f1] = (
      await db().query<{ id: string }>(
        "select id from atomic_notes where created_from_source_item_id = $1",
        [first.id]
      )
    ).rows.map((row) => row.id) as [string];
    await relate(l1, f1, "supports");
    await repository.promoteFromNotes(linked.id);
    const last = await discover(linked.id);
    expect(last.pairs.map((pair) => pair.rootId)).not.toContain(first.id);
    expect(last.pairs.map((pair) => pair.rootId)).not.toContain(silent.id);
    expect(last.pairs.map((pair) => pair.rootId)).not.toContain(elsewhere.id);
    expect(last.pairs[0]).toMatchObject({ rootId: third.id, reason: "nearest" });
    // A re-match run's fence hides unreleased roots from discovery (3.17).
    const fenced = await root("Eta root", at(0.97, 4));
    const plan2 = await repository.planDiscovery({
      rootId: fenced.id,
      vector: (await repository.discoveryVector(fenced.id))!,
      fingerprint: await repository.fingerprint(fenced.id),
      neighbours: 1,
      fence: { rootSourceItemIds: [second.id] }
    });
    expect(plan2.candidates).toBe(1);
    expect(plan2.pairs.map((pair) => pair.rootId)).toEqual([second.id]);
  });

  it("plans a root again with the same pairs and states, at the stored cosine precision", async () => {
    const repository = createSourceRelationRepository(db());
    const space = `space-${randomUUID()}`;
    const root = async (title: string, vector: number[]) => {
      const source = await work(title);
      await withNotes(source, [`${title} idea`]);
      await composite(source.id, vector, space);
      return source;
    };
    const input = async (rootId: string, neighbours: number) => ({
      rootId,
      vector: (await repository.discoveryVector(rootId))!,
      fingerprint: await repository.fingerprint(rootId),
      neighbours
    });
    const pairsOf = (plan: { pairs: Array<{ rootId: string; reason: string }> }) =>
      plan.pairs.map((pair) => [pair.rootId, pair.reason]);
    // One neighbour: R's nearest is N, and R beats X's bar (its cosine to N), so X is a reverse
    // neighbour whose bar becomes its cosine to R.
    const n = await root("Nu root", unit(0));
    const x = await root("Xi root", at(0.5, 1));
    await repository.planDiscovery(await input(n.id, 1));
    await repository.planDiscovery(await input(x.id, 1));
    const r = await root("Rho root", at(0.9, 1));
    const first = await repository.planDiscovery(await input(r.id, 1));
    expect(pairsOf(first)).toEqual([
      [n.id, "nearest"],
      [x.id, "reverse"]
    ]);
    const states = await repository.matchStates([n.id, x.id, r.id]);
    // A re-plan (another run or judge) selects the same pairs and stores the same states.
    expect(await repository.previewDiscovery(await input(r.id, 1))).toMatchObject({
      pairs: first.pairs
    });
    const again = await repository.planDiscovery(await input(r.id, 1));
    expect(pairsOf(again)).toEqual(pairsOf(first));
    expect(await repository.matchStates([n.id, x.id, r.id])).toEqual(
      states.map((state) => ({ ...state }))
    );
    // Two neighbours: X2's two nearest become A and R, so its bar is R's own cosine, stored as
    // `real` (here rounded up from the double PostgreSQL computes); R's own two nearest are B and
    // A. A re-plan recognizes R in X2's set by that bar, compared at the stored precision.
    const space2 = `space-${randomUUID()}`;
    const root2 = async (title: string, vector: number[]) => {
      const source = await work(title);
      await withNotes(source, [`${title} idea`]);
      await composite(source.id, vector, space2);
      return source;
    };
    const padded = (values: number[]) => Array.from({ length: 256 }, (_, i) => values[i] ?? 0);
    const a = await root2("Alpha two", padded([1, 0, 0]));
    const x2 = await root2("Xi two", padded([2.7, 0, 1.3]));
    const b = await root2("Beta two", padded([0.9, 0.436, 0]));
    for (const id of [a.id, x2.id, b.id]) await repository.planDiscovery(await input(id, 2));
    const r2 = await root2("Rho two", padded([0.95, 0.3, 0.05]));
    const plan2 = await repository.planDiscovery(await input(r2.id, 2));
    expect(pairsOf(plan2)).toEqual([
      [b.id, "nearest"],
      [a.id, "nearest"],
      [x2.id, "reverse"]
    ]);
    const states2 = await repository.matchStates([a.id, x2.id, b.id, r2.id]);
    expect(pairsOf(await repository.planDiscovery(await input(r2.id, 2)))).toEqual(pairsOf(plan2));
    expect(await repository.matchStates([a.id, x2.id, b.id, r2.id])).toEqual(states2);
  });

  it("previews without storing anything, and judges what an earlier plan left owed", async () => {
    const repository = createSourceRelationRepository(db());
    const space = `space-${randomUUID()}`;
    const root = async (title: string, vector: number[]) => {
      const source = await work(title);
      await withNotes(source, [`${title} idea`]);
      await composite(source.id, vector, space);
      return source;
    };
    const plan = async (rootId: string) =>
      repository.planDiscovery({
        rootId,
        vector: (await repository.discoveryVector(rootId))!,
        fingerprint: await repository.fingerprint(rootId),
        neighbours: 1
      });
    const n = await root("Owed nu", unit(0));
    const x = await root("Owed xi", at(0.5, 1));
    await plan(n.id);
    await plan(x.id);
    const r = await root("Owed rho", at(0.9, 1));
    // A preview of a root never matched stores no state, neither its own nor its neighbours'.
    const before = await repository.matchStates([n.id, x.id]);
    const preview = await repository.previewDiscovery({
      rootId: r.id,
      vector: (await repository.discoveryVector(r.id))!,
      fingerprint: await repository.fingerprint(r.id),
      neighbours: 1
    });
    expect(preview.pairs.map((pair) => pair.rootId)).toEqual([n.id, x.id]);
    expect(await repository.matchStates([n.id, x.id, r.id])).toEqual(before);
    // One call asks about both pairs (D21); by title the works read nu (w1, s1), rho (w2, s2) and
    // xi (w3, s3). A malformed item about rho and xi leaves X's pair open, and the input budget stops
    // the repair: N's pair is decided, X stays planned and unjudged.
    const runDefaultTask = vi.fn(async () => ({
      output: {
        relations: runDefaultTask.mock.calls.length === 1 ? [["s2", "s3", "supports", "high"]] : []
      },
      profileId: judgeRoute.profileId,
      modelId: judgeRoute.modelId,
      providerId: "openai-codex",
      runtime: "remote",
      aiTaskRunId: null,
      inputTokens: 100,
      outputTokens: 10
    }));
    const options = {
      pool: db(),
      ai: { runDefaultTask } as never,
      sourceIds: [r.id],
      contentLanguage: "en"
    };
    const settings = { ...defaultSourceRelationSettings, maxInputTokens: 200_000 };
    expect(
      await matchSources({
        ...options,
        runKey: "budget",
        settings: { ...settings, maxInputTokens: 50 }
      })
    ).toMatchObject({ completed: 1, total: 2, partial: true });
    // A later root beats R at X: a fresh plan of R would not select X any more.
    const s2 = await root("Owed sigma", at(0.45, 1));
    await plan(s2.id);
    expect((await repository.matchStates([x.id]))[0]).toMatchObject({ nearestRootId: s2.id });
    expect(await repository.owedDiscoveryRoots(r.id, `next:${r.id}`)).toEqual([x.id]);
    // The next run of R judges the owed pair; the judged one is reused with no call.
    expect(await matchSources({ ...options, runKey: "next", settings })).toMatchObject({
      completed: 2,
      total: 2
    });
    expect(runDefaultTask).toHaveBeenCalledTimes(2);
    expect(await repository.owedDiscoveryRoots(r.id, "any")).toEqual([]);
  });

  it("matches a source end to end: promotion, one judged pair, nothing again on a rerun", async () => {
    const space = `space-${randomUUID()}`;
    const memory = await work("Working memory limits");
    const load = await work("Cognitive load design");
    const outside = await work("Instructional design history");
    await withNotes(memory, ["Memory holds few items"]);
    const [l1] = await withNotes(load, ["Design reduces load"]);
    const [o1] = await withNotes(outside, ["Design evolved"]);
    await composite(memory.id, unit(0), space);
    await composite(load.id, at(0.8, 1), space);
    // The new source's note relation to a third work is promoted; discovery judges its nearest.
    await relate(l1!, o1!, "supports");
    const repository = createSourceRelationRepository(db());
    // The first root is matched before the second exists in the space's arrival order.
    await repository.planDiscovery({
      rootId: memory.id,
      vector: (await repository.discoveryVector(memory.id))!,
      fingerprint: await repository.fingerprint(memory.id),
      neighbours: 1
    });
    const route = judgeRoute;
    const runDefaultTask = vi.fn(async () => ({
      output: { relations: [["s1", "s2", "contrasts", 90, 90, ["c1"], ["c2"]]] },
      profileId: route.profileId,
      modelId: route.modelId,
      providerId: "openai-codex",
      runtime: "remote",
      aiTaskRunId: null,
      inputTokens: 100,
      outputTokens: 10
    }));
    const options = {
      pool: db(),
      ai: { runDefaultTask } as never,
      sourceIds: [load.id],
      settings: { ...defaultSourceRelationSettings, maxInputTokens: 200_000 },
      contentLanguage: "en"
    };
    const result = await matchSources({ ...options, runKey: "first" });
    expect(result).toMatchObject({ promoted: 1, completed: 1, total: 1, persistedCount: 1 });
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
    // The judge's contrasts is written as contradicts, read from the first root in content order.
    expect(
      (await relationsBetween(memory.id, load.id)).map((row) => [row.relation_type, row.origin])
    ).toEqual([["contradicts", "judged"]]);
    expect(
      (await relationsBetween(load.id, outside.id)).map((row) => [row.relation_type, row.origin])
    ).toEqual([["supports", "promoted"]]);
    // A rerun finds the pair linked now, so it plans nothing and makes no call.
    expect(await matchSources({ ...options, runKey: "second" })).toMatchObject({
      completed: 0,
      total: 0,
      promoted: 0
    });
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
  });

  it("selects a large pair's evidence by bounded exact vector pairs, not the cross joins (R19)", async () => {
    const repository = createSourceRelationRepository(db());
    const space = `space-${randomUUID()}`;
    const left = await work("Large left work");
    const right = await work("Large right work");
    const vectors = async (source: { id: string; title: string }, axes: number[]) => {
      const chunks: SourceRelationChunk[] = [];
      for (const [index, axis] of axes.entries()) {
        const chunk = await passage(source, `${source.title} passage ${index}`);
        await createEmbeddingRepository(db()).upsert({
          targetType: "chunk",
          targetId: chunk.id,
          chunkId: chunk.id,
          provider: "test",
          model: "test-256",
          runtime: "local",
          strategy: `native-v2:${space}`,
          contentHash: chunk.contentHash,
          embedding: unit(axis)
        });
        chunks.push(chunk);
      }
      return chunks;
    };
    const leftChunks = await vectors(left, [10, 11, 12]);
    const rightChunks = await vectors(right, [10, 13, 14]);
    const bounds = { exactEvidencePairs: 0, boundedEvidenceChunks: 3 };
    const evidence = await repository.pairChunks(left.id, right.id, [], 1, bounds);
    // The identical vectors on axis 10 are the nearest pair; one passage per root.
    expect(evidence.map((chunk) => chunk.id).toSorted()).toEqual(
      [leftChunks[0]!.id, rightChunks[0]!.id].toSorted()
    );
    expect(await repository.pairChunks(right.id, left.id, [], 1, bounds)).toEqual(evidence);
    // Under the bound, the exact path runs (the lexical pairs need no vector).
    expect(
      (await repository.pairChunks(left.id, right.id, [], 1))
        .map((chunk) => chunk.rootId)
        .toSorted()
    ).toEqual([left.id, right.id].toSorted());
  });

  // --- hierarchy roots ----------------------------------------------------------------------------

  it("recomputes a book's null composite once its chapters have vectors", async () => {
    const space = `space-${randomUUID()}`;
    const book = await work("Learning book", undefined, "Book");
    const chapter = await work("Chapter one", book.id, "BookChapter");
    await composite(chapter.id, unit(4), space);
    const repository = createSourceRelationRepository(db());
    expect(await repository.discoveryVector(book.id)).toBeNull();
    const embed = vi.fn(async () => ({
      embedding: unit(5),
      provider: "test",
      model: "test-256",
      runtime: "local",
      spaceKey: space
    }));
    expect(
      await refreshAncestorComposites({
        pool: db(),
        sourceItemId: chapter.id,
        embed,
        aggregate: aggregateSourceEmbedding
      })
    ).toEqual([book.id]);
    expect((await repository.discoveryVector(book.id))?.spaceKey).toBe(`256:${space}`);
    // Unchanged inputs: nothing is recomputed and no header is embedded again.
    const calls = embed.mock.calls.length;
    expect(
      await refreshAncestorComposites({
        pool: db(),
        sourceItemId: chapter.id,
        embed,
        aggregate: aggregateSourceEmbedding
      })
    ).toEqual([]);
    expect(embed).toHaveBeenCalledTimes(calls);
  });

  it("builds a book's composite once its last chapter embeds, embedding its header once", async () => {
    const space = `space-${randomUUID()}`;
    const book = await work("Two chapter book", undefined, "Book");
    const one = await work("First chapter", book.id, "BookChapter");
    const two = await work("Second chapter", book.id, "BookChapter");
    const plain = await work("A plain paper");
    const embed = vi.fn(async () => ({
      embedding: unit(7),
      provider: "test",
      model: "test-256",
      runtime: "local",
      spaceKey: space
    }));
    const refresh = (sourceItemId: string) =>
      refreshAncestorComposites({
        pool: db(),
        sourceItemId,
        embed,
        aggregate: aggregateSourceEmbedding
      });
    const compositeSpace = {
      model: "test-256",
      dimensions: 256 as const,
      strategy: `source-composite-centroid-v2:${space}`
    };
    // What the root's own embedding stage does: it embeds a header only to build the composite.
    const stage = async (id: string) =>
      hierarchyRootComposite({
        pool: db(),
        sourceItemId: id,
        header: buildCatalogMetadataMarkdown(
          (await createSourceItemRepository(db()).findById(id))!
        ),
        space: compositeSpace
      });
    expect(await stage(plain.id)).toBe("none");
    expect(await stage(book.id)).toBe("incomplete");
    await composite(one.id, unit(4), space);
    // The first chapter: the book still waits for the second, so nothing is embedded.
    expect(await refresh(one.id)).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
    expect(await stage(book.id)).toBe("incomplete");
    await composite(two.id, unit(5), space);
    expect(await refresh(two.id)).toEqual([book.id]);
    const headerSegments = embed.mock.calls.length;
    expect(headerSegments).toBeGreaterThan(0);
    // The root's stage then finds it current; a refresh again changes nothing.
    expect(await stage(book.id)).toBe("current");
    expect(await refresh(one.id)).toEqual([]);
    expect(embed).toHaveBeenCalledTimes(headerSegments);
    // A chapter embedded again with other content makes the book's composite stale.
    await composite(one.id, unit(6), space);
    expect(await stage(book.id)).toBe("stale");
    // A failure on the book is reported and never thrown with `warn`; a cancellation is.
    const warn = vi.fn();
    const failing = vi.fn(async () => {
      throw new Error("cassette miss");
    });
    expect(
      await refreshAncestorComposites({
        pool: db(),
        sourceItemId: one.id,
        embed: failing,
        aggregate: aggregateSourceEmbedding,
        warn
      })
    ).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: "cassette miss" }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      refreshAncestorComposites({
        pool: db(),
        sourceItemId: one.id,
        embed: failing,
        aggregate: aggregateSourceEmbedding,
        signal: controller.signal,
        warn
      })
    ).rejects.toThrow("cassette miss");
  });
});
