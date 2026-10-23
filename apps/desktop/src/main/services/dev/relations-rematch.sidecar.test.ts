import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAtomicNoteRepository,
  createJobRepository,
  createPgPool,
  createSourceMatchStateRepository,
  immediateJobDebounce,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";

import { buildRematchPlan, type RematchPlan, type RematchRoot } from "./relations-rematch-plan.js";
import { runRematch, type RematchPorts, type RematchRunInput } from "./relations-rematch-run.js";
import {
  clearRelationState,
  contentDigest,
  countOpenLinkJobs,
  enableCandidateRecording,
  listLibraryRoots,
  readNotesDigest,
  readRunFacts,
  seedBackgroundMatchState,
  seedBackgroundNoteState
} from "./relations-rematch-state.js";
import { noCompositeBackfill } from "./relations-rematch-summary.js";
import { readCatalogHeaderFacts } from "../catalog-header-policy.js";

// The state a re-match run reads and changes, and the fence that hides unreleased roots from
// retrieval, on a real PostgreSQL database with the product's own retrieval SQL.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const embedding = (theta: number): number[] =>
  Array.from({ length: 256 }, (_, axis) =>
    axis === 0 ? Math.cos(theta) : axis === 1 ? Math.sin(theta) : 0
  );
const space = {
  embeddingModel: "test-embedding",
  embeddingSpaceKey: "test-space",
  embeddingProvider: "test",
  embeddingRuntime: "none"
};

/** Roots in ingestion order: a book with two chapters, a paper, a memo, a late article and an empty one. */
const source = {
  book: u(1),
  ch1: u(2),
  ch2: u(3),
  paper: u(4),
  memo: u(5),
  late: u(6),
  empty: u(7)
};
const titles: Record<string, string> = {
  [source.book]: "Book",
  [source.ch1]: "Chapter 1",
  [source.ch2]: "Chapter 2",
  [source.paper]: "Paper",
  [source.memo]: "Memo",
  [source.late]: "Late",
  [source.empty]: "Empty"
};
const rootOf: Record<string, string> = {
  [source.book]: source.book,
  [source.ch1]: source.book,
  [source.ch2]: source.book,
  [source.paper]: source.paper,
  [source.memo]: source.memo,
  [source.late]: source.late,
  [source.empty]: source.empty
};
/** Notes with their source and a position on the unit circle: close angles are similar notes. */
const notes = [
  { id: u(11), source: source.ch1, title: "Spaced repetition", theta: 0.0 },
  { id: u(12), source: source.ch1, title: "Sleep and memory", theta: 0.5 },
  { id: u(13), source: source.ch2, title: "Retrieval practice", theta: 1.0 },
  { id: u(14), source: source.paper, title: "Spacing effect", theta: 0.05 },
  { id: u(15), source: source.paper, title: "Consolidation", theta: 0.55 },
  { id: u(16), source: source.memo, title: "Testing effect", theta: 1.02 },
  { id: u(17), source: source.late, title: "Repetition schedules", theta: 0.03 }
];
const note = (n: number) => notes.find((entry) => entry.id === u(10 + n))!;

describe.skipIf(!sidecarInstalled)("the re-match harness on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;

  const count = async (table: string, where = "true") =>
    Number(
      (await pool.query<{ n: string }>(`select count(*)::text as n from ${table} where ${where}`))
        .rows[0]!.n
    );

  async function insertSources() {
    const insert = (id: string, type: string, parent: string | null) =>
      pool.query(
        "insert into source_items (id, type, title, parent_source_item_id, created_at) values ($1, $2, $3, $4, now() + $5::interval)",
        [id, type, titles[id], parent, `${Number(BigInt(`0x${id.slice(-12)}`))} seconds`]
      );
    await insert(source.book, "Book", null);
    await insert(source.ch1, "BookChapter", source.book);
    await insert(source.ch2, "BookChapter", source.book);
    await insert(source.paper, "GenericDocument", null);
    await insert(source.memo, "GenericDocument", null);
    await insert(source.late, "GenericDocument", null);
    await insert(source.empty, "GenericDocument", null);
  }

  async function insertNotes() {
    const chunkOf = new Map<string, string>();
    for (const sourceId of [source.ch1, source.ch2, source.paper, source.memo, source.late]) {
      const documentId = randomUUID();
      const chunkId = randomUUID();
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'text', $3)`,
        [documentId, sourceId, `hash-${sourceId}`]
      );
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, 0, 'text', $4)`,
        [chunkId, documentId, sourceId, `chunk-${sourceId}`]
      );
      chunkOf.set(sourceId, chunkId);
    }
    for (const entry of notes) {
      await pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
            created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
            generation_runtime, generation_prompt_version, generation_key)
         values ($1::uuid, $2, $3, $4, 'active', 'current', $5, $6, 'test', 'test', 'local', 'test', $1::text)`,
        [
          entry.id,
          entry.title,
          `Body of ${entry.title}`,
          `Idea of ${entry.title}`,
          entry.source,
          chunkOf.get(entry.source)
        ]
      );
      await pool.query(
        `insert into embeddings_256 (target_type, target_id, provider, model, runtime, strategy, content_hash, embedding)
         values ('atomic_note', $1, $2, $3, $4, 'native-v2:' || $5, 'hash', $6::vector)`,
        [
          entry.id,
          space.embeddingProvider,
          space.embeddingModel,
          space.embeddingRuntime,
          space.embeddingSpaceKey,
          `[${embedding(entry.theta).join(",")}]`
        ]
      );
    }
    // A rejected note: it never counts.
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
          created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
          generation_runtime, generation_prompt_version, generation_key)
       values ($1::uuid, 'Rejected', 'b', 'i', 'rejected', 'current', $2, $3, 'test', 'test', 'local', 'test', $1::text)`,
      [u(19), source.paper, chunkOf.get(source.paper)]
    );
  }

  async function insertCompositeVectors(roots: Array<[string, number]>) {
    for (const [rootId, theta] of roots)
      await pool.query(
        `insert into embeddings_256 (target_type, target_id, provider, model, runtime, strategy, content_hash, embedding)
         values ('source_item', $1, 'test', 'test-embedding', 'none', 'source-composite-centroid-v2:test-space', 'hash', $2::vector)`,
        [rootId, `[${embedding(theta).join(",")}]`]
      );
  }

  const pairKey = (a: number, b: number) => `${note(a).id}:${note(b).id}`;

  /** Relation state for every table a run clears: pairs 1-4 (book-paper), 3-6 (book-memo), 6-7 (memo-late). */
  async function seedRelationState() {
    const pairs: Array<[number, number]> = [
      [1, 4],
      [3, 6],
      [6, 7]
    ];
    for (const [lo, hi] of pairs) {
      await pool.query(
        `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
            final_score, explanation, direction, direction_source, band, probability, status)
         values ($1, $2, 'supports', 0.9, 'x', 'lo_to_hi', 'typer', 'apply', 0.9, 'accepted')`,
        [note(lo).id, note(hi).id]
      );
      for (const deciderKey of ["key-now", "key-before"])
        await pool.query(
          `insert into relation_decisions (pair_key, lo_atomic_note_id, hi_atomic_note_id, lo_content_hash,
              hi_content_hash, decider_key, lo_to_hi_score, lo_to_hi_decided_at, hi_to_lo_score,
              hi_to_lo_decided_at, score_scale)
           values ($1, $2, $3, 'h', 'h', $4, 1.5, now(), -0.5, now(), 'log_odds')`,
          [pairKey(lo, hi), note(lo).id, note(hi).id, deciderKey]
        );
      await pool.query(
        `insert into relation_typings (pair_key, typer_key, lo_hash, hi_hash, relation_type, direction)
         values ($1, 'typer', 'h', 'h', 'supports', 'lo_to_hi')`,
        [pairKey(lo, hi)]
      );
    }
    for (const entry of notes)
      await pool.query(
        "insert into note_match_state (note_id, decider_key, space_key, kth_cosine) values ($1, 'key-now', 'space', 0.5)",
        [entry.id]
      );
    const relation = (sourceId: string, targetId: string, identity: string) =>
      pool.query(
        `insert into source_relations (source_item_id, target_source_item_id, identity_key, relation_type,
            status, origin, support_count)
         values ($1, $2, $3, 'supports', 'accepted', 'promoted', 2)`,
        [sourceId, targetId, identity]
      );
    await relation(source.book, source.paper, "book-paper");
    await relation(source.book, source.memo, "book-memo");
    await relation(source.memo, source.late, "memo-late");
    for (const [sourceId, targetId] of [
      [source.book, source.paper],
      [source.memo, source.late]
    ] as const) {
      await pool.query(
        "insert into source_matching_decisions (key, source_root_id, target_root_id) values ($1, $2, $3)",
        [`${sourceId}:${targetId}`, sourceId, targetId]
      );
      await pool.query(
        "insert into source_matching_runs (key, source_root_id, state) values ($1, $2, '{}'::jsonb)",
        [`run:${sourceId}`, sourceId]
      );
    }
    const state = createSourceMatchStateRepository(pool);
    for (const rootId of [source.book, source.paper, source.memo, source.late])
      await state.record({
        rootId,
        nearestRootId: null,
        nearestCosine: null,
        spaceKey: "test-space",
        fingerprint: "fp"
      });
    for (const [runId, rootId] of [
      [u(901), source.book],
      [u(902), source.memo]
    ] as const) {
      await pool.query(
        "insert into relation_match_runs (id, kind, root_id) values ($1, 'match', $2)",
        [runId, rootId]
      );
      await pool.query(
        `insert into relation_events (run_id, relation_kind, pair_key, kind)
         values ($1, 'note', $2, 'applied')`,
        [runId, pairKey(1, 4)]
      );
    }
  }

  async function wipeRelationState() {
    for (const table of [
      "relation_events",
      "relation_match_runs",
      "source_relations",
      "source_matching_decisions",
      "source_matching_runs",
      "source_match_state",
      "note_match_state",
      "relation_typings",
      "relation_decisions",
      "atomic_note_relations",
      "jobs"
    ])
      await pool.query(`delete from ${table}`);
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-rematch-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_rematch_test",
        user: "memora_rematch_test",
        password: `rematch-${randomUUID()}`,
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
    await insertSources();
    await insertNotes();
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  beforeEach(async () => {
    await wipeRelationState();
    await pool.query("delete from embeddings_256 where target_type = 'source_item'");
  });

  it("lists the roots in ingestion order with the sources that hold notes", async () => {
    const roots = await listLibraryRoots(pool);
    expect(roots.map((root) => [root.title, root.notes])).toEqual([
      ["Book", 3],
      ["Paper", 2],
      ["Memo", 1],
      ["Late", 1],
      ["Empty", 0]
    ]);
    expect(roots[0]!.records.map((record) => [record.title, record.notes])).toEqual([
      ["Chapter 1", 2],
      ["Chapter 2", 1]
    ]);
    // The rejected note of the paper is not counted.
    expect(roots[1]!.records).toEqual([{ id: source.paper, title: "Paper", notes: 2 }]);
    expect(roots[4]!.records).toEqual([]);
  });

  it("digests the notes the way the golden runner does", async () => {
    // Source path, title, hash of idea and body, status: sorted, joined by newlines, SHA-256.
    const md5 = (text: string) => createHash("md5").update(text).digest("hex");
    const lines = [
      ...notes.map(
        (entry) =>
          `${rootOf[entry.source] !== entry.source ? `${titles[rootOf[entry.source]!]} / ` : ""}${titles[entry.source]}|${entry.title}|${md5(`Idea of ${entry.title}|Body of ${entry.title}`)}|active`
      ),
      `Paper|Rejected|${md5("i|b")}|rejected`
    ];
    expect(await readNotesDigest(pool)).toEqual(contentDigest(lines));
    expect((await readNotesDigest(pool)).notes).toBe(8);
  });

  it("clears every table of relation state, keeping the decisions of other deciders", async () => {
    await seedRelationState();
    const cleared = await clearRelationState(pool, { deciderKey: "key-now", scope: "all" });
    expect(cleared).toEqual({
      noteRelations: 3,
      decisions: 3,
      typings: 3,
      noteMatchState: 7,
      sourceRelations: 3,
      sourceDecisions: 4,
      sourceMatchState: 4,
      runs: 2,
      events: 2
    });
    for (const table of [
      "atomic_note_relations",
      "relation_typings",
      "note_match_state",
      "source_relations",
      "source_matching_decisions",
      "source_matching_runs",
      "source_match_state",
      "relation_match_runs",
      "relation_events"
    ])
      expect(await count(table), table).toBe(0);
    expect(await count("relation_decisions", "decider_key = 'key-now'")).toBe(0);
    expect(await count("relation_decisions", "decider_key = 'key-before'")).toBe(3);
    // The notes themselves are untouched.
    expect(await count("atomic_notes")).toBe(8);
  });

  it("clears only what touches the released roots when the rest is a matched background", async () => {
    await seedRelationState();
    const cleared = await clearRelationState(pool, {
      deciderKey: "key-now",
      scope: { rootIds: [source.book, source.paper] }
    });
    expect(cleared).toMatchObject({
      noteRelations: 2,
      decisions: 2,
      typings: 2,
      noteMatchState: 5,
      sourceRelations: 2,
      sourceMatchState: 2,
      runs: 1,
      events: 1
    });
    // What only the background holds stays: the memo-late relation and its state.
    expect(await count("atomic_note_relations")).toBe(1);
    expect(await count("relation_decisions", "decider_key = 'key-now'")).toBe(1);
    expect(await count("relation_typings")).toBe(1);
    expect(await count("note_match_state")).toBe(2);
    expect(await count("source_relations", "identity_key = 'memo-late'")).toBe(1);
    expect(await count("source_match_state")).toBe(2);
    expect(await count("relation_match_runs", `root_id = '${source.memo}'`)).toBe(1);
    expect(await count("source_matching_decisions")).toBe(1);
    expect(await count("source_matching_runs")).toBe(1);
  });

  it("records the background roots as matched, each with its nearest earlier root", async () => {
    await insertCompositeVectors([
      [source.book, 0.0],
      [source.paper, 0.9],
      [source.memo, 0.05],
      [source.late, 1.0]
    ]);
    // The paper has a vector but is not background; the empty root has none.
    const seeded = await seedBackgroundMatchState(pool, [
      source.book,
      source.memo,
      source.late,
      source.empty
    ]);
    expect(seeded).toBe(3);
    const state = createSourceMatchStateRepository(pool);
    const rows = await state.listEarlier("test-space", Number.MAX_SAFE_INTEGER);
    expect(rows.map((row) => row.rootId)).toEqual([source.book, source.memo, source.late]);
    expect(rows.map((row) => row.matchSeq)).toEqual(
      [...rows.map((row) => row.matchSeq)].sort((a, b) => a - b)
    );
    expect(rows.map((row) => row.nearestRootId)).toEqual([null, source.book, source.memo]);
    expect(rows[1]!.nearestCosine).toBeCloseTo(Math.cos(0.05), 3);
    expect(rows[2]!.nearestCosine).toBeCloseTo(Math.cos(0.95), 3);
    // Nothing about roots outside the background, and nothing to seed with no vector.
    expect(await state.read(source.paper)).toBeNull();
    expect(await seedBackgroundMatchState(pool, [source.empty])).toBe(0);
    expect(await seedBackgroundMatchState(pool, [])).toBe(0);
    // At two neighbours (C2) the bar is the second nearest earlier root's cosine; null with one.
    await wipeRelationState();
    expect(await seedBackgroundMatchState(pool, [source.book, source.memo, source.late], 2)).toBe(
      3
    );
    const two = await state.listEarlier("test-space", Number.MAX_SAFE_INTEGER);
    expect(two.map((row) => row.nearestRootId)).toEqual([null, source.book, source.memo]);
    expect(two.slice(0, 2).map((row) => row.nearestCosine)).toEqual([null, null]);
    expect(two[2]!.nearestCosine).toBeCloseTo(Math.cos(1.0), 3);
  });

  it("gives the background notes the match state a library matched at arrival holds", async () => {
    await wipeRelationState();
    const states = async () =>
      (
        await pool.query<{ id: string; key: string; space: string; kth: number | null }>(
          `select note_id::text as id, decider_key as key, space_key as space, kth_cosine as kth
             from note_match_state order by note_id`
        )
      ).rows;
    // Background: the book (notes 1-3) and the paper (4-5, plus a rejected note). The memo and the late
    // article arrive after: their notes are no neighbours of a background note's k-th cosine.
    const seeded = await seedBackgroundNoteState(pool, {
      rootIds: [source.book, source.paper],
      deciderKey: "key-now",
      k: 2,
      vectorK: 4
    });
    expect(seeded).toBe(5);
    const rows = await states();
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3, 4, 5].map((n) => note(n).id));
    expect(rows.every((row) => row.key === "key-now" && row.space === "test-space")).toBe(true);
    // Note 1 (angle 0): its neighbours in the background are 4 (0.05), 2 (0.5), 5 (0.55) and 3 (1.0); the
    // 2nd is note 2. The late article's note 7 (0.03) would have been the 1st if the fence let it in.
    expect(rows[0]!.kth).toBeCloseTo(Math.cos(0.5), 3);
    expect(rows[2]!.kth).toBeCloseTo(Math.cos(0.5), 3);
    // The paper alone: each note has one neighbour, so its 1st cosine is that one and its 2nd is none. A
    // note with fewer than k candidates opens its guard to every later note (null).
    await wipeRelationState();
    const alone = { rootIds: [source.paper], deciderKey: "key-now", vectorK: 4 };
    expect(await seedBackgroundNoteState(pool, { ...alone, k: 1 })).toBe(2);
    for (const row of await states()) expect(row.kth).toBeCloseTo(Math.cos(0.5), 3);
    await wipeRelationState();
    expect(await seedBackgroundNoteState(pool, { ...alone, k: 2 })).toBe(2);
    expect((await states()).map((row) => row.kth)).toEqual([null, null]);
    expect(
      await seedBackgroundNoteState(pool, { rootIds: [], deciderKey: "k", k: 2, vectorK: 4 })
    ).toBe(0);
    expect(
      await seedBackgroundNoteState(pool, {
        rootIds: [source.empty],
        deciderKey: "k",
        k: 2,
        vectorK: 4
      })
    ).toBe(0);
  });

  it("turns debug mode on in the saved app preferences, and only there", async () => {
    // No saved preferences: the app would write its defaults, so nothing is invented here.
    await pool.query("delete from settings where key = 'app.preferences'");
    expect(await enableCandidateRecording(pool)).toBe(false);
    expect((await pool.query("select 1 from settings where key = 'app.preferences'")).rows).toEqual(
      []
    );
    await pool.query(
      `insert into settings (key, value) values ('app.preferences', '{"debugMode": false, "language": "pt-BR"}')`
    );
    expect(await enableCandidateRecording(pool)).toBe(true);
    expect(
      (await pool.query("select value from settings where key = 'app.preferences'")).rows[0]?.value
    ).toEqual({ debugMode: true, language: "pt-BR" });
    // Again: still on, nothing else changes.
    expect(await enableCandidateRecording(pool)).toBe(true);
    await pool.query("delete from settings where key = 'app.preferences'");
  });

  it("counts the link jobs a run waits for and reads the facts of a run", async () => {
    const since = new Date(Date.now() - 1_000);
    const jobs = createJobRepository(pool);
    expect(await countOpenLinkJobs(pool)).toBe(0);
    await jobs.enqueueDeduped({
      type: "relation-link",
      lane: "light",
      dedupeKey: `relation-link:${source.book}`,
      payload: { rootId: source.book },
      debounce: immediateJobDebounce
    });
    await jobs.create({ type: "topic-place", lane: "light" });
    expect(await countOpenLinkJobs(pool)).toBe(1);
    // A link job a blocker set aside is not open work: the drain does not wait for it (F4 D5).
    await jobs.markBlocked({ types: ["relation-link"] }, { class: "cap", reason: "money_80" });
    expect(await countOpenLinkJobs(pool)).toBe(0);
    await jobs.releaseBlocks({ types: ["relation-link"] });
    expect(await countOpenLinkJobs(pool)).toBe(1);
    const facts = await readRunFacts(pool, since);
    expect(facts.linkJobs).toEqual([
      expect.objectContaining({
        rootId: source.book,
        status: "queued",
        attempts: 0,
        finishedAt: null
      })
    ]);
    await pool.query(
      "update jobs set status = 'succeeded', finished_at = now() where type = 'relation-link'"
    );
    expect(await countOpenLinkJobs(pool)).toBe(0);
    expect((await readRunFacts(pool, since)).linkJobs[0]).toMatchObject({ status: "succeeded" });
    expect(facts.aiCalls).toEqual([]);
  });

  describe("a run through the product's retrieval", () => {
    const rootsOf = async (): Promise<RematchRoot[]> =>
      (await listLibraryRoots(pool)).map((root) => ({ ...root, partition: null }));

    /** Ports that retrieve each note's vector neighbours with the fence the run hands them. */
    function retrievingPorts(seen: Array<{ note: string; roots: string[] }>): RematchPorts {
      const repository = createAtomicNoteRepository(pool);
      const jobs = createJobRepository(pool);
      // Before the rows the run makes, so what it reads "since it started" is all of them.
      let clock = Date.now() - 60_000;
      return {
        deciderKey: async () => "key-now",
        clear: (input) => clearRelationState(pool, input),
        seedBackground: (rootIds) => seedBackgroundMatchState(pool, rootIds),
        seedBackgroundNotes: (rootIds, deciderKey) =>
          seedBackgroundNoteState(pool, { rootIds, deciderKey, k: 2, vectorK: 4 }),
        recordCandidates: () => enableCandidateRecording(pool),
        backfillComposites: async () => noCompositeBackfill,
        noteIds: async (recordId) =>
          (await repository.listBySourceItem(recordId))
            .filter((entry) => entry.status !== "rejected")
            .map((entry) => entry.id),
        matchRecord: async (input) => {
          for (const noteId of input.noteIds) {
            const own = notes.find((entry) => entry.id === noteId)!;
            const candidates = await repository.findVectorMatchingCandidates({
              noteId,
              embedding: embedding(own.theta),
              ...space,
              limit: 20,
              fence: input.fence
            });
            seen.push({
              note: noteId,
              roots: [
                ...new Set(
                  candidates.map((candidate) => rootOf[candidate.note.createdFromSourceItemId]!)
                )
              ]
            });
          }
          return { decided: input.noteIds.length, accepted: 0 };
        },
        enqueueLink: async (rootId) => {
          await jobs.enqueueDeduped({
            type: "relation-link",
            lane: "light",
            dedupeKey: `relation-link:${rootId}`,
            payload: { rootId },
            debounce: immediateJobDebounce
          });
        },
        openLinkJobs: () => countOpenLinkJobs(pool),
        facts: (since) => readRunFacts(pool, since),
        catalogHeaders: () => readCatalogHeaderFacts(pool, { env: {} }),
        cassette: () => null,
        now: () => new Date((clock += 10)),
        // The link executor of the real app is not here: finishing the jobs is its stand-in.
        sleep: async () => {
          await pool.query(
            "update jobs set status = 'succeeded', finished_at = now() where type = 'relation-link' and status <> 'succeeded'"
          );
        },
        log: () => undefined
      };
    }

    const runInput = (
      plan: RematchPlan,
      extra: Partial<RematchRunInput> = {}
    ): RematchRunInput => ({
      runId: "run",
      jobId: "job",
      profile: { name: "clone", kind: null },
      plan,
      mode: { kind: "arrival", order: { kind: "manifest" } },
      background: "none",
      discovery: "on",
      candidates: "off",
      digest: {
        expected: { notes: 8, sha256: "a".repeat(64) },
        actual: { notes: 8, sha256: "a".repeat(64) }
      },
      lanesMode: "serial",
      link: "drain",
      helperBatchSize: null,
      p0Probe: null,
      drainTimeoutMs: 60_000,
      drainPollMs: 1,
      signal: new AbortController().signal,
      ...extra
    });

    it("hides the roots not released yet from retrieval, whatever their vectors say", async () => {
      await seedRelationState();
      const seen: Array<{ note: string; roots: string[] }> = [];
      const plan = buildRematchPlan(await rootsOf(), {
        kind: "arrival",
        order: { kind: "manifest" }
      });
      const summary = await runRematch(retrievingPorts(seen), runInput(plan));
      expect(summary.outcome).toBe("completed");
      expect(summary.cleared.noteRelations).toBe(3);
      const rootsSeenBy = (n: number) => seen.find((entry) => entry.note === note(n).id)!.roots;
      // The book is released first and sees only itself, though the paper's note 14 is nearly its note 11.
      expect(rootsSeenBy(1)).toEqual([source.book]);
      expect(rootsSeenBy(3)).toEqual([source.book]);
      // The paper sees the book; the memo sees both and not the late article that comes after it.
      expect(new Set(rootsSeenBy(4))).toEqual(new Set([source.book, source.paper]));
      expect(new Set(rootsSeenBy(6))).toEqual(new Set([source.book, source.paper]));
      expect(new Set(rootsSeenBy(7))).toEqual(new Set([source.book, source.paper, source.memo]));
      // No call ever saw a root that was not released when it ran.
      const order = [source.book, source.paper, source.memo, source.late];
      for (const [index, root] of order.entries())
        for (const entry of seen.filter(
          (candidate) => rootOf[notes.find((n) => n.id === candidate.note)!.source] === root
        ))
          for (const seenRoot of entry.roots)
            expect(order.indexOf(seenRoot)).toBeLessThanOrEqual(index);
      expect(summary.timeline.map((entry) => entry.title)).toEqual([
        "Book",
        "Paper",
        "Memo",
        "Late"
      ]);
      expect(summary.linkJobs.total).toBe(4);
      expect(await count("source_match_state")).toBe(0);
    });

    it("lets a burst see the whole library from its first note", async () => {
      const seen: Array<{ note: string; roots: string[] }> = [];
      const plan = buildRematchPlan(await rootsOf(), { kind: "burst" });
      await runRematch(retrievingPorts(seen), runInput(plan, { mode: { kind: "burst" } }));
      const first = seen.find((entry) => entry.note === note(1).id)!;
      expect(new Set(first.roots)).toEqual(
        new Set([source.book, source.paper, source.memo, source.late])
      );
    });

    it("keeps a matched background visible to retrieval and to discovery, and the rest hidden", async () => {
      await insertCompositeVectors([
        [source.book, 0.0],
        [source.paper, 0.9],
        [source.memo, 0.05],
        [source.late, 1.0]
      ]);
      await seedRelationState();
      const seen: Array<{ note: string; roots: string[] }> = [];
      const ports = retrievingPorts(seen);
      const matched: string[][] = [];
      const original = ports.matchRecord;
      ports.matchRecord = async (input) => {
        // Discovery reads the roots with a match state: the background only, no released root yet.
        matched.push(
          (
            await createSourceMatchStateRepository(pool).listEarlier(
              "test-space",
              Number.MAX_SAFE_INTEGER
            )
          ).map((row) => row.rootId)
        );
        return original(input);
      };
      // Release the memo and the paper; the book and the late article are already matched.
      const plan = buildRematchPlan(
        await rootsOf(),
        { kind: "arrival", order: { kind: "manifest" } },
        ["Memo", "Paper"]
      );
      const summary = await runRematch(ports, runInput(plan, { background: "matched" }));
      expect(summary.backgroundSeeded).toBe(2);
      // The background's notes (the book's three and the late article's) hold a match state in the
      // vectors' space; the released roots' states were cleared and no decide step wrote new ones here.
      expect(summary.backgroundNotesSeeded).toBe(4);
      const kept = await pool.query<{ id: string; space: string }>(
        "select note_id::text as id, space_key as space from note_match_state order by note_id"
      );
      expect(kept.rows.map((row) => row.id)).toEqual([1, 2, 3, 7].map((n) => note(n).id));
      expect(kept.rows.every((row) => row.space === "test-space")).toBe(true);
      expect(matched[0]).toEqual([source.book, source.late]);
      const memo = seen.find((entry) => entry.note === note(6).id)!;
      expect(new Set(memo.roots)).toEqual(new Set([source.book, source.late]));
      expect(memo.roots).not.toContain(source.paper);
      // What only the background holds was not cleared: the memo-late relation went (the memo is released).
      expect(await count("atomic_note_relations")).toBe(0);
      expect(await count("source_relations", "identity_key = 'book-paper'")).toBe(0);
    });
  });
});
