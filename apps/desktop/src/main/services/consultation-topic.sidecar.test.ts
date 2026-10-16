import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createConsultationRepository,
  createKnowledgeConsultationRepository,
  createPgPool,
  createTopicTreeRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";

import { consultationSnapshot } from "./consultation-fixture.js";
import { ConsultationService } from "./consultation-service.js";

// Ask about a topic against a real PostgreSQL database: the topic scope is resolved by the
// retrieval and grounding SQL itself, so what an answer may cite is proven here and not by mocks.
// The same run spies on every wiki, organization, curator and investigation repository factory
// and on every statement, and none of them is touched.
const legacy = vi.hoisted(() => ({ names: [] as string[], calls: [] as string[] }));
vi.mock("@app/db", async (original) => {
  const db = await original<typeof import("@app/db")>();
  const entries = Object.entries(db).filter(
    ([name, value]) =>
      /^create\w*(wiki|organization|curator|investigation)\w*$/i.test(name) &&
      typeof value === "function"
  );
  legacy.names = entries.map(([name]) => name);
  return {
    ...db,
    ...Object.fromEntries(
      entries.map(([name, factory]) => [
        name,
        (...args: unknown[]) => {
          legacy.calls.push(name);
          return (factory as (...a: unknown[]) => unknown)(...args);
        }
      ])
    )
  };
});

const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const dimensions = 256;
const ids = {
  tree: u(1),
  root: u(2),
  areaA: u(3),
  a1: u(4),
  a2: u(5),
  areaB: u(6),
  areaC: u(7),
  retired: u(8)
};
/** A book (root) and its one section, which holds the passages. */
const book = (key: number) => ({ root: u(100 + key), section: u(110 + key) });
const chunk = (name: string) =>
  u(
    {
      x0: 400,
      x1: 401,
      x2: 402,
      y0: 410,
      y1: 411,
      z0: 420,
      z1: 421,
      w0: 430,
      v0: 440
    }[name]!
  );
const note = (n: number) => u(300 + n);

/** One direction for every passage and for the question: the semantic score cannot tell them apart. */
const embedding = Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0));
const space = { model: "embed", provider: "test", runtime: "test", spaceKey: "space" };

const answer = {
  paragraphs: [{ markdown: "Practice improved recall [e1].", citations: ["e1"], contextIds: [] }],
  gaps: []
};

describe.skipIf(!sidecarInstalled)("Ask about a topic on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const statements: string[] = [];

  /** The service over the real database, with a model that cites the first passage. */
  const ask = (semantic = false) => {
    const spied = new Proxy(pool!, {
      get(target, property) {
        if (property !== "query") return Reflect.get(target, property) as unknown;
        return (...args: unknown[]) => {
          statements.push(String(typeof args[0] === "string" ? args[0] : ""));
          return (target.query as (...a: unknown[]) => unknown)(...args);
        };
      }
    });
    const model = vi.fn(async () => ({
      output: JSON.stringify(answer),
      aiTaskRunId: randomUUID(),
      inputTokens: 100,
      outputTokens: 20,
      costEstimate: 0
    }));
    const service = new ConsultationService({
      getPool: () => spied,
      ai: {
        pinOrganizationProfile: vi.fn(async () => consultationSnapshot().profile),
        runOrganizationTask: model,
        runConsultationEmbedding: vi.fn(async () =>
          semantic
            ? {
                output: embedding,
                modelId: space.model,
                providerId: space.provider,
                runtime: space.runtime,
                embeddingSpaceKey: space.spaceKey
              }
            : null
        )
      } as never,
      contentLanguage: async () => "en"
    });
    return {
      model,
      run: (overrides: Record<string, unknown>) =>
        service.ask({
          requestId: randomUUID(),
          question: "Does retrieval practice improve recall?",
          ...overrides
        } as never)
    };
  };
  const cited = (result: Awaited<ReturnType<ReturnType<typeof ask>["run"]>>) =>
    result.evidence.map((e) => e.chunkId).toSorted();

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-ask-topic-"));
    // Parallel test files pick free ports the same way; a lost race needs only a fresh attempt.
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_ask_topic_test",
        user: "memora_ask_topic_test",
        password: `ask-topic-${randomUUID()}`,
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

    // Library: five books of one section each. Every passage answers the question lexically, so
    // only the topic scope can keep a passage out.
    const passages: Record<number, string[]> = {
      1: ["x0", "x1", "x2"],
      2: ["y0", "y1"],
      3: ["z0", "z1"],
      4: ["w0"],
      5: ["v0"]
    };
    for (const [key, names] of Object.entries(passages)) {
      const { root, section } = book(Number(key));
      await pool.query("insert into source_items (id, type, title) values ($1, 'Book', $2)", [
        root,
        `Book ${key}`
      ]);
      await pool.query(
        "insert into source_items (id, type, title, parent_source_item_id) values ($1, 'DocumentSection', $2, $3)",
        [section, `Book ${key} section`, root]
      );
      const document = randomUUID();
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'seed', $3)`,
        [document, section, `hash-book-${key}`]
      );
      for (const [index, name] of names.entries()) {
        await pool.query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            chunk(name),
            document,
            section,
            index,
            `Retrieval practice improves recall, passage ${name}.`,
            `chunk-${name}`
          ]
        );
      }
    }
    const chunkRows = await pool.query("select id, content_hash from chunks");
    for (const row of chunkRows.rows) {
      await pool.query(
        `insert into embeddings_256 (target_type, target_id, chunk_id, provider, model, runtime,
           usage, strategy, content_hash, embedding)
         values ('chunk', $1, $1, $2, $3, $4, 'retrieval', $5, $6, $7::vector)`,
        [
          row.id,
          space.provider,
          space.model,
          space.runtime,
          `native-v2:${space.spaceKey}`,
          row.content_hash,
          `[${embedding.join(",")}]`
        ]
      );
    }
    const notes: Array<{ n: number; book: number; chunk: string; status?: string }> = [
      { n: 1, book: 1, chunk: "x0" },
      { n: 2, book: 1, chunk: "x1" },
      { n: 3, book: 2, chunk: "y0" },
      { n: 4, book: 2, chunk: "y1" },
      { n: 5, book: 4, chunk: "w0", status: "rejected" },
      { n: 7, book: 5, chunk: "v0" },
      // Rests on the same passage as note 1 but lives in another topic.
      { n: 8, book: 1, chunk: "x0" }
    ];
    for (const seed of notes) {
      await pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
           supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
           evidence_chunk_id, generation_provider, generation_model, generation_runtime,
           generation_prompt_version, generation_key)
         values ($1, $2, 'Practice helps.', $3, $4, 'current', 'source', $5, $5, $6, 'seed', 'seed',
                 'local', 'seed', $7)`,
        [
          note(seed.n),
          `Note ${seed.n}`,
          `Idea of note ${seed.n}`,
          seed.status ?? "active",
          book(seed.book).section,
          chunk(seed.chunk),
          `key-${seed.n}`
        ]
      );
    }

    // Tree: Area A (subtopics A1 and A2), Area B and Area C.
    const repo = createTopicTreeRepository(pool);
    await repo.createTree({
      id: ids.tree,
      rootId: ids.root,
      spaceKey: "local:test:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions,
      config: {},
      configHash: "hash",
      seed: 1
    });
    const topic = (id: string, parent: string, position: number) =>
      topicRecord(id, parent, {
        role: "topic",
        title: `Topic ${position}`,
        nameState: "named",
        nameSource: "llm",
        nameLanguage: "en",
        position
      });
    const ls = new Float64Array(dimensions);
    ls[0] = 1;
    const built = await repo.bootstrapSnapshot({
      treeId: ids.tree,
      expectedGeneration: 0,
      titleKey: "topics.changeSets.build",
      topics: [
        topic(ids.areaA, ids.root, 0),
        topic(ids.areaB, ids.root, 1),
        topic(ids.areaC, ids.root, 2),
        topic(ids.a1, ids.areaA, 0),
        topic(ids.a2, ids.areaA, 1)
      ],
      placements: [
        // Note 1 sits in A1, note 2 directly in Area A.
        { item: itemKey("note", note(1)), placement: placementRecord(ids.a1) },
        { item: itemKey("note", note(2)), placement: placementRecord(ids.areaA) },
        // Note 3 is primary in B and "also in" A2.
        { item: itemKey("note", note(3)), placement: placementRecord(ids.areaB) },
        { item: itemKey("note", note(3)), placement: placementRecord(ids.a2, { rank: 1 }) },
        { item: itemKey("note", note(4)), placement: placementRecord(ids.areaB) },
        // A rejected note the tree has not repaired yet.
        { item: itemKey("note", note(5)), placement: placementRecord(ids.a1) },
        { item: itemKey("note", note(7)), placement: placementRecord(ids.areaC) },
        { item: itemKey("note", note(8)), placement: placementRecord(ids.areaC) },
        // A book with no notes is placed as a source: all of its passages belong to A2.
        { item: itemKey("source", book(3).root), placement: placementRecord(ids.a2) }
      ],
      stats: [ids.root, ids.areaA, ids.areaB, ids.areaC, ids.a1, ids.a2].map((topicId) => ({
        topicId,
        n: 1,
        ls,
        cosSqSum: 1,
        lowCosPercentiles: []
      }))
    });
    expect(built).toMatchObject({ kind: "applied", generation: 1 });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("cites only passages of the notes placed in the topic's subtree, primary or secondary, and of its sources", async () => {
    const { run } = ask();
    // Area A: note 1 (A1), note 2 (A), note 3 as "also in" A2, and the note-less book in A2.
    const area = await run({ topicId: ids.areaA });
    expect(cited(area)).toEqual(
      [chunk("x0"), chunk("x1"), chunk("y0"), chunk("z0"), chunk("z1")].toSorted()
    );
    expect(area.scope).toMatchObject({ topicId: ids.areaA, sourceIds: [] });
    // Checked again against the database once the model answered: nothing moved meanwhile.
    expect(area.coverage.stale).toBe(false);
    // Not cited: the unreferenced passage of a book whose notes are placed (x2), the other note of
    // book 2 (y1), the rejected note's passage (w0) and everything under Area C (v0).
    for (const outside of ["x2", "y1", "w0", "v0"])
      expect(cited(area), outside).not.toContain(chunk(outside));
    // A subtopic holds only its own placements; a secondary placement counts there too.
    expect(cited(await run({ topicId: ids.a1 }))).toEqual([chunk("x0")]);
    expect(cited(await run({ topicId: ids.a2 }))).toEqual(
      [chunk("y0"), chunk("z0"), chunk("z1")].toSorted()
    );
    // The primary placement counts as well.
    expect(cited(await run({ topicId: ids.areaB }))).toEqual([chunk("y0"), chunk("y1")].toSorted());
  });

  it("offers as optional context only the notes placed in the subtree", async () => {
    const { run } = ask();
    // Notes 1 and 8 rest on the same passage; only note 1 is in A1.
    const a1 = await run({ topicId: ids.a1 });
    expect(a1.contexts.map((c) => [c.kind, c.id])).toEqual([["atomic_note", note(1)]]);
    const c = await run({ topicId: ids.areaC });
    expect(c.contexts.map((entry) => entry.id).toSorted()).toEqual([note(7), note(8)].toSorted());
    expect(cited(c)).toEqual([chunk("v0"), chunk("x0")].toSorted());
  });

  it("answers over the whole placed tree from the root and over the library without a topic", async () => {
    const { run } = ask();
    const root = await run({ topicId: ids.root });
    // Every placed passage; the unreferenced x2 and the rejected note's w0 are not part of any topic.
    expect(cited(root)).toEqual(["x0", "x1", "y0", "y1", "z0", "z1", "v0"].map(chunk).toSorted());
    const library = await run({});
    expect(cited(library)).toEqual(
      ["x0", "x1", "x2", "y0", "y1", "z0", "z1", "w0", "v0"].map(chunk).toSorted()
    );
    expect(library.scope.topicId).toBeUndefined();
  });

  it("limits the semantic hits to the topic as well", async () => {
    const retrieval = createConsultationRepository(pool!);
    const sections = [1, 2, 3, 4, 5].map((key) => book(key).section);
    const hits = async (topicId?: string) =>
      (await retrieval.vector(sections, { embedding, ...space }, topicId ?? null))
        .map((hit: { id: string }) => hit.id)
        .toSorted();
    expect(await hits()).toEqual(
      ["x0", "x1", "x2", "y0", "y1", "z0", "z1", "w0", "v0"].map(chunk).toSorted()
    );
    expect(await hits(ids.a1)).toEqual([chunk("x0")]);
    expect(await hits(ids.areaB)).toEqual([chunk("y0"), chunk("y1")].toSorted());
    // The same through a hybrid question.
    const hybrid = await ask(true).run({ topicId: ids.a1, mode: "hybrid" });
    expect(hybrid.coverage.vector).toBe("available");
    expect(cited(hybrid)).toEqual([chunk("x0")]);
  });

  it("has nothing to answer from for a missing, empty or retired topic, and calls no model", async () => {
    const repo = createTopicTreeRepository(pool!);
    const created = u(900);
    const { id: _id, ...record } = topicRecord(u(0), ids.root, {
      role: "topic",
      title: "Temporary",
      nameState: "named",
      nameSource: "llm",
      nameLanguage: "en",
      position: 3
    });
    void _id;
    const applied = await repo.applyChangeSet({
      treeId: ids.tree,
      expectedGeneration: 1,
      origin: "rebalance",
      titleKey: "topics.changeSets.split",
      events: [
        {
          op: "topic.create",
          topicId: created,
          before: null,
          after: { ...record, parentId: ids.root, role: "topic" as const }
        }
      ]
    });
    expect(applied.kind).toBe("applied");
    const { model, run } = ask();
    await expect(run({ topicId: created })).rejects.toThrow("consultation.errors.noTopicEvidence");
    const retired = await repo.applyChangeSet({
      treeId: ids.tree,
      expectedGeneration: applied.kind === "applied" ? applied.generation : 0,
      origin: "rebalance",
      titleKey: "topics.changeSets.dissolve",
      events: [
        {
          op: "topic.retire",
          topicId: created,
          before: { retiredAt: null, redirectTo: null },
          after: { retiredAt: new Date().toISOString(), redirectTo: ids.areaA }
        }
      ]
    });
    expect(retired.kind).toBe("applied");
    await expect(run({ topicId: created })).rejects.toThrow("consultation.errors.noTopicEvidence");
    await expect(run({ topicId: u(901) })).rejects.toThrow("consultation.errors.noTopicEvidence");
    expect(model).not.toHaveBeenCalled();
  });

  it("checks membership again from the database before and after the answer", async () => {
    const grounding = createKnowledgeConsultationRepository(pool!);
    const members = await grounding.topicMembers(ids.a1, {
      chunkIds: [chunk("x0"), chunk("x1"), chunk("x2")],
      noteIds: [note(1), note(2), note(8)]
    });
    expect(members).toEqual({ chunkIds: [chunk("x0")], noteIds: [note(1)] });
    expect(
      await grounding.scope({ sourceIds: [], includeDescendants: false, topicId: ids.a1 })
    ).toEqual([book(1).section]);
  });

  it("reads no wiki repository and no wiki or organization table", () => {
    expect(legacy.names.length, "the spy covers the wiki repositories").toBeGreaterThan(0);
    expect(legacy.calls).toEqual([]);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements)
      expect(statement).not.toMatch(
        /\b(wiki|organization|maintenance|automatic_routine|knowledge_impact)_[a-z_]+/
      );
  });
});
