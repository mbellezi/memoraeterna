import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  SourceRelationViewSchema,
  defaultSourceRelationSettings,
  type NoteRelationWriteType
} from "@app/domain";
import {
  PostgresSidecarManager,
  closePgPool,
  createAtomicNoteRelationRepository,
  createChunkRepository,
  createDocumentRepository,
  createEmbeddingRepository,
  createPgPool,
  createRelationEventRepository,
  createRelationMatchRunRepository,
  createSourceItemRepository,
  createSourceRelationRepository,
  currentSourceRelationEvidenceSql,
  listSourceRelations,
  resolvePostgresSidecarPaths,
  runMigrations,
  sourceRelationEvidenceJoins,
  type PgPool,
  type SourceRelationChunk
} from "@app/db";

import { aggregateSourceEmbedding } from "./job-supervisor.js";
import { refreshAncestorComposites } from "./source-composite.js";
import { matchSources } from "./source-relation-processing.js";

// Design E (F3 D27) against a real database: promotion of typed applied note relations (majority
// type and direction, null scores, support count, owner rejection final, idempotent, retired when
// support is lost, typed-only with re-promotion on typing, R14), the merge rules with judged
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
  const relate = async (
    subject: string,
    object: string,
    type: NoteRelationWriteType | null,
    band: "apply" | "suggest" = "apply"
  ) => {
    const run = await createRelationMatchRunRepository(db()).start({ kind: "link" });
    const written = await createAtomicNoteRelationRepository(db()).upsertDecided({
      subjectAtomicNoteId: subject,
      objectAtomicNoteId: object,
      relationType: type,
      band,
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
    await relate(r2!, x3!, "supports", "suggest"); // suggested: not applied

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
      support_count: 2,
      status: "pending_review"
    });
    // Its evidence is the two supporting note relations, current while they are applied.
    const page = await listSourceRelations(db(), retrieval.id, feedback.id);
    const view = SourceRelationViewSchema.parse({ ...page.relations[0], writtenExplanation: null });
    expect(view).toMatchObject({
      origin: "promoted",
      supportCount: 2,
      importance: null,
      current: true
    });
    expect(view.evidence.map((evidence) => [evidence.origin, evidence.current])).toEqual([
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
    // The input budget stops the run after the first pair: X stays planned and unjudged.
    const runDefaultTask = vi.fn(async () => ({
      output: { relations: [] },
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
});
