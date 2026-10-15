import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  TopicChangeSetSchema,
  TopicNotesSchema,
  TopicShapeSchema,
  TopicTreeSchema,
  topicReadLimits
} from "@app/domain";
import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import type { StructureEvent } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { TopicReadError, createTopicReadRepository, topicReadSql } from "./topicReadRepository.js";
import {
  createTopicTreeRepository,
  type ApplyChangeSetInput,
  type TopicStatsWrite,
  type TopicWriterOptions
} from "./topicTreeRepository.js";

// The read model against a real PostgreSQL database: the counts, the keyset paging, the page of a
// leaf and of an internal topic, the Shape cells, the change-set views and the snapshot rule.
// `scripts/topics/read-benchmark.ts` measures the same statements at the size of the library.
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const ids = {
  tree: u(1),
  root: u(2),
  a: u(3),
  b: u(4),
  c: u(5),
  a1: u(6),
  a2: u(7),
  b1: u(8)
};
const source = { x: u(200), y: u(201), z: u(202) };
const section = { x: u(210), y: u(211), z: u(212) };
/** Note `n` of the world has ID `note(n)`. */
const note = (n: number): string => u(300 + n);

interface NoteSeed {
  n: number;
  topic: string;
  centrality: number | null;
  home: "x" | "y" | "z";
  needsGate?: boolean;
  needsSplitCheck?: boolean;
  status?: string;
  human?: boolean;
  edited?: boolean;
}

// The world: three root sources (one section each), twelve notes, three kinds of waiting.
const noteSeeds: NoteSeed[] = [
  { n: 1, topic: ids.a1, centrality: 0.9, home: "x" },
  { n: 2, topic: ids.a1, centrality: 0.8, home: "x", human: true },
  { n: 3, topic: ids.a1, centrality: 0.7, home: "x", edited: true },
  { n: 4, topic: ids.a1, centrality: null, home: "x" },
  { n: 5, topic: ids.a, centrality: 0.6, home: "x", needsSplitCheck: true },
  { n: 6, topic: ids.a2, centrality: 0.95, home: "y" },
  { n: 7, topic: ids.a2, centrality: 0.5, home: "y" },
  { n: 8, topic: ids.b1, centrality: 0.85, home: "z" },
  { n: 9, topic: ids.b1, centrality: 0.4, home: "z" },
  { n: 10, topic: ids.c, centrality: 0.77, home: "z" },
  { n: 11, topic: ids.root, centrality: null, home: "z" },
  { n: 12, topic: ids.a1, centrality: 0.3, home: "x", needsGate: true },
  // Never placed: a rejected note whose relation must not count.
  { n: 99, topic: "", centrality: null, home: "x", status: "rejected" },
  // Placed by a later change-set.
  { n: 14, topic: "", centrality: null, home: "x" },
  { n: 15, topic: "", centrality: null, home: "x" }
];

const dimensions = 256;
const stats = (topic: string, n: number, extra: Partial<TopicStatsWrite> = {}): TopicStatsWrite => {
  const ls = new Float64Array(dimensions);
  ls[0] = n * 0.8;
  return { topicId: topic, n, ls, cosSqSum: n * 0.64, lowCosPercentiles: [], ...extra };
};

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

describe.skipIf(!sidecarInstalled)("topic read repository on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;
  const writer = () => createTopicTreeRepository(db());
  const reader = () => createTopicReadRepository(db());
  let generation = 0;

  const apply = async (
    input: Omit<ApplyChangeSetInput, "treeId" | "expectedGeneration">,
    options?: TopicWriterOptions
  ) => {
    const result = await writer().applyChangeSet(
      { treeId: ids.tree, expectedGeneration: generation, ...input },
      options
    );
    if (result.kind === "applied" || result.kind === "pending") generation = result.generation;
    expect(["applied", "pending"]).toContain(result.kind);
    return result.kind === "applied" || result.kind === "pending" ? result.changeSetId : "";
  };
  const placeEvent = (n: number, topic: string): StructureEvent => ({
    op: "item.place",
    item: itemKey("note", note(n)),
    topicId: topic,
    before: null,
    after: placementRecord(topic)
  });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-read-"));
    // Parallel test files pick free ports the same way; a lost race needs only a fresh attempt.
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_topic_read_test",
        user: "memora_topic_read_test",
        password: `topic-read-${randomUUID()}`,
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

    // Library: three books (a section each) and the notes.
    const books: Array<["x" | "y" | "z", string, string | null]> = [
      ["x", "Book X", "Author X"],
      ["y", "Book Y", null],
      ["z", "Paper Z", null]
    ];
    for (const [key, title, subtitle] of books) {
      await db().query(
        "insert into source_items (id, type, title, subtitle) values ($1, 'Book', $2, $3)",
        [source[key], title, subtitle]
      );
      await db().query(
        "insert into source_items (id, type, title, parent_source_item_id) values ($1, 'DocumentSection', $2, $3)",
        [section[key], `${title} section`, source[key]]
      );
      const document = randomUUID();
      await db().query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'seed', $3)`,
        [document, section[key], `hash-${key}`]
      );
      await db().query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, 0, 'Passage', $4)`,
        [u(400 + (key === "x" ? 0 : key === "y" ? 1 : 2)), document, section[key], `chunk-${key}`]
      );
    }
    for (const seed of noteSeeds) {
      const chunk = u(400 + (seed.home === "x" ? 0 : seed.home === "y" ? 1 : 2));
      await db().query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
           supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
           evidence_chunk_id, generation_provider, generation_model, generation_runtime,
           generation_prompt_version, generation_key, metadata)
         values ($1, $2, 'Body', $3, $4, 'current', 'source', $5, $5, $6, 'seed', 'seed', 'local',
                 'seed', $7, $8::jsonb)`,
        [
          note(seed.n),
          `Note ${seed.n}`,
          `Idea of note ${seed.n}`,
          seed.status ?? "active",
          section[seed.home],
          chunk,
          `key-${seed.n}`,
          JSON.stringify(seed.human ? { humanProtected: "true" } : {})
        ]
      );
      if (seed.edited) {
        await db().query(
          `insert into atomic_note_review_events (atomic_note_id, action, previous_status, next_status)
           values ($1, 'edit', 'active', 'active')`,
          [note(seed.n)]
        );
      }
    }
    const relations: Array<[number, number, string, string]> = [
      [1, 6, "supports", "accepted"],
      [1, 8, "contrasts", "accepted"],
      [2, 3, "extends", "accepted"],
      [6, 9, "similar_to", "accepted"],
      [10, 1, "related", "accepted"],
      [1, 12, "supports", "rejected"],
      [3, 11, "clarifies", "pending_review"],
      [1, 99, "mentions", "accepted"]
    ];
    for (const [from, to, type, status] of relations) {
      const [first, second] = [note(from), note(to)].sort();
      await db().query(
        `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id,
           relation_type, final_score, explanation, status)
         values ($1, $2, $3, 0.5, 'why', $4)`,
        [first, second, type, status]
      );
    }

    // Tree: the root, three Areas (C is a leaf) and three subtopics.
    const repo = writer();
    const tree = await repo.createTree({
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
    const topic = (id: string, parent: string, position: number, fields = {}) =>
      topicRecord(id, parent, {
        role: "topic",
        title: "Untitled",
        nameState: "named",
        nameSource: "llm",
        nameLanguage: "en",
        position,
        ...fields
      });
    const placements = noteSeeds
      .filter((seed) => seed.topic !== "")
      .map((seed) => ({
        item: itemKey("note", note(seed.n)),
        placement: placementRecord(seed.topic, {
          needsGate: seed.needsGate ?? false,
          needsSplitCheck: seed.needsSplitCheck ?? false
        })
      }));
    placements.push(
      {
        item: itemKey("note", note(1)),
        placement: placementRecord(ids.b1, { rank: 1 })
      },
      { item: itemKey("source", source.x), placement: placementRecord(ids.a2) },
      { item: itemKey("source", source.y), placement: placementRecord(ids.c) },
      {
        item: itemKey("source", source.z),
        placement: placementRecord(ids.root, { needsVector: true })
      }
    );
    const violation = (
      code: string,
      severity: string,
      reason: string,
      awaiting: boolean,
      value: number
    ) => ({
      code,
      severity,
      reason,
      topicId: null,
      item: null,
      awaitingApproval: awaiting,
      value
    });
    const centralities = (topicId: string) =>
      noteSeeds
        .filter((seed) => seed.topic === topicId && seed.centrality !== null)
        .map((seed) => ({
          item: itemKey("note", note(seed.n)),
          centrality: seed.centrality as number
        }));
    const built = await repo.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: 0,
      titleKey: "topics.changeSets.build",
      topics: [
        topic(ids.a, ids.root, 0, { title: "Area A", description: "The A area." }),
        topic(ids.b, ids.root, 1, { title: "Area B" }),
        topic(ids.c, ids.root, 2, { title: "Area C", management: "pinned" }),
        topic(ids.a1, ids.a, 0, {
          title: "Alpha one",
          description: "About alpha.",
          aliases: ["First alpha"]
        }),
        topic(ids.a2, ids.a, 1, {
          title: null,
          nameState: "unnamed",
          nameSource: null,
          nameLanguage: null
        }),
        topic(ids.b1, ids.b, 0, { title: "Beta one" })
      ],
      placements,
      stats: [
        stats(ids.root, 11),
        stats(ids.a, 8, { centralities: centralities(ids.a) }),
        stats(ids.b, 2),
        stats(ids.c, 1),
        stats(ids.a1, 5, {
          centralities: centralities(ids.a1),
          health: "attention",
          violations: [violation("I4", "soft", "leaf-size-outside-range", false, 5)]
        }),
        stats(ids.a2, 2, { centralities: centralities(ids.a2) }),
        stats(ids.b1, 2, {
          centralities: centralities(ids.b1),
          health: "violation",
          violations: [violation("I3", "hard", "fan-out-above-hard-max", false, 15)]
        })
      ].map((write) =>
        write.topicId === ids.c
          ? {
              ...write,
              centralities: centralities(ids.c),
              health: "attention" as const,
              violations: [violation("I4", "soft", "leaf-size-outside-range", true, 1)]
            }
          : write
      )
    });
    expect(built).toMatchObject({ kind: "applied", generation: 1 });
    generation = 1;
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  const tree = (
    input: Partial<Parameters<ReturnType<typeof createTopicReadRepository>["readTree"]>[0]> = {}
  ) =>
    reader().readTree({
      parentId: null,
      limit: 100,
      includeItems: false,
      itemLimit: 5,
      ...input
    });

  it("lists the children of the root with exact subtree counts, waiting items and health", async () => {
    const answer = await tree({ includeItems: true, itemLimit: 5 });
    expect(answer).not.toBeNull();
    expect(TopicTreeSchema.parse(answer)).toEqual(answer);
    expect(answer?.generation).toBe(1);
    // 15 primary placements: 9 in Area A, 2 in B, 2 in C and 2 on the root itself.
    expect(answer?.parent).toMatchObject({
      id: ids.root,
      parentId: null,
      items: 15,
      directItems: 2,
      children: 3,
      unsorted: 1
    });
    expect(
      answer?.nodes.map((node) => [node.id, node.items, node.directItems, node.unsorted])
    ).toEqual([
      [ids.a, 9, 1, 1],
      [ids.b, 2, 0, 0],
      [ids.c, 2, 2, 0]
    ]);
    expect(answer?.nodes[0]).toMatchObject({
      title: "Area A",
      nameState: "named",
      management: "ai",
      children: 2,
      health: "good",
      newThisWeek: 0,
      position: 0
    });
    expect(answer?.nodes[2]).toMatchObject({ management: "pinned", health: "attention" });
    // The root's own leaves: the note and the source that wait for a place.
    expect(answer?.unsorted).toBe(1);
    expect(answer?.moreItems).toBe(0);
    // Neither has a centrality, so the placement ID orders them: compare as a set.
    expect(
      answer?.items.map((item) => [item.kind, item.id, item.unsorted].join(" ")).sort()
    ).toEqual([`note ${note(11)} true`, `source ${source.z} false`].sort());
    expect(answer?.nextCursor).toBeNull();
  });

  it("pages children by keyset and refuses a malformed cursor", async () => {
    const first = await tree({ limit: 2 });
    expect(first?.nodes.map((node) => node.id)).toEqual([ids.a, ids.b]);
    expect(first?.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect((first?.nextCursor ?? "").length).toBeLessThanOrEqual(topicReadLimits.cursorMax);
    const second = await tree({ limit: 2, cursor: first?.nextCursor ?? undefined });
    expect(second?.nodes.map((node) => node.id)).toEqual([ids.c]);
    expect(second?.nextCursor).toBeNull();
    await expect(tree({ cursor: "not-a-cursor" })).rejects.toBeInstanceOf(TopicReadError);
    await expect(
      tree({ cursor: Buffer.from('["x",1]').toString("base64url") })
    ).rejects.toBeInstanceOf(TopicReadError);
  });

  it("answers a subtopic level with the leaves, a secondary placement and what is left out", async () => {
    const answer = await tree({ parentId: ids.b1, includeItems: true, itemLimit: 2 });
    expect(answer?.parent).toMatchObject({
      id: ids.b1,
      items: 2,
      directItems: 2,
      health: "violation"
    });
    expect(answer?.nodes).toEqual([]);
    expect(answer?.items.map((item) => [item.id, item.role])).toEqual([
      [note(8), "primary"],
      [note(9), "primary"]
    ]);
    // Two primary leaves are shown; the secondary placement of note 1 is left out.
    expect(answer?.moreItems).toBe(1);
    const unsortedLeaf = await tree({ parentId: ids.a1, includeItems: true, itemLimit: 10 });
    expect(unsortedLeaf?.items.find((item) => item.id === note(12))).toMatchObject({
      unsorted: true
    });
    expect(unsortedLeaf?.items.find((item) => item.id === note(2))).toMatchObject({
      kind: "note",
      provenance: "human",
      sourceTitle: "Book X section",
      unsorted: false
    });
    expect(unsortedLeaf?.items.find((item) => item.id === note(3))).toMatchObject({
      provenance: "human"
    });
    expect(unsortedLeaf?.items.find((item) => item.id === note(1))).toMatchObject({
      provenance: "ai"
    });
    expect(await tree({ parentId: u(9999) })).toBeNull();
  });

  it("pages a topic's leaves primary first by centrality, across the role boundary", async () => {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const answer = await reader().readItems({
        id: ids.b1,
        limit: 1,
        scope: "direct",
        kind: "all",
        cursor
      });
      expect(
        TopicNotesSchema.parse({ items: answer?.items, nextCursor: answer?.nextCursor })
      ).toBeTruthy();
      pages.push((answer?.items ?? []).map((item) => `${item.id}:${item.role}`));
      cursor = answer?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(pages.flat()).toEqual([
      `${note(8)}:primary`,
      `${note(9)}:primary`,
      `${note(1)}:secondary`
    ]);
    expect(cursor).toBeUndefined();
  });

  it("lists a subtree's primary placements by centrality with nulls last, notes only on request", async () => {
    const all = await reader().readItems({ id: ids.a, limit: 100, scope: "subtree", kind: "all" });
    // Placements without a centrality (note 4 and the source) tie, and the placement ID breaks it.
    expect(all?.items.slice(0, 7).map((item) => item.id)).toEqual([
      note(6), //  0.95
      note(1), //  0.90
      note(2), //  0.80
      note(3), //  0.70
      note(5), //  0.60
      note(7), //  0.50
      note(12) //  0.30
    ]);
    expect(
      all?.items
        .slice(7)
        .map((item) => item.id)
        .sort()
    ).toEqual([note(4), source.x].sort());
    expect(all?.items.every((item) => item.role === "primary")).toBe(true);
    const sourceLeaf = all?.items.find((item) => item.kind === "source");
    expect(sourceLeaf).toMatchObject({ id: source.x, title: "Book X", noteCount: 6 });

    const notes = await reader().readItems({ id: ids.a, limit: 4, scope: "subtree", kind: "note" });
    expect(notes?.items.map((item) => item.id)).toEqual([note(6), note(1), note(2), note(3)]);
    expect(notes?.nextCursor).not.toBeNull();
    const rest = await reader().readItems({
      id: ids.a,
      limit: 100,
      scope: "subtree",
      kind: "note",
      cursor: notes?.nextCursor ?? undefined
    });
    expect(rest?.items.map((item) => item.id)).toEqual([note(5), note(7), note(12), note(4)]);
    expect(rest?.nextCursor).toBeNull();
    expect(
      await reader().readItems({ id: u(9999), limit: 5, scope: "direct", kind: "all" })
    ).toBeNull();
  });

  it("marks only the items that wait for a place as unsorted, wherever the page starts", async () => {
    const everything = await reader().readItems({
      id: ids.root,
      limit: 100,
      scope: "subtree",
      kind: "all"
    });
    const waiting = everything?.items
      .filter((item) => item.unsorted)
      .map((item) => item.id)
      .sort();
    // The note on the root, the one waiting for a split check and the one waiting for the gate; the
    // source that waits for a vector is reported apart.
    expect(waiting).toEqual([note(11), note(12), note(5)].sort());
    expect(everything?.items.find((item) => item.id === source.z)).toMatchObject({
      unsorted: false
    });
    expect(everything?.items).toHaveLength(15);
  });

  it("walks the path from the root and follows a retired topic's redirect", async () => {
    expect(await reader().readPath(ids.a1)).toEqual({
      resolvedId: ids.a1,
      redirectedFrom: null,
      path: [
        { id: ids.root, title: null },
        { id: ids.a, title: "Area A" },
        { id: ids.a1, title: "Alpha one" }
      ]
    });
    expect((await reader().readPath(ids.root))?.path).toEqual([{ id: ids.root, title: null }]);
    expect(await reader().readPath(u(9999))).toBeNull();
  });

  it("reads the page of a leaf: counts, central notes by centrality, sources, relations and neighbours", async () => {
    const page = await reader().readPage({ id: ids.a1, noteLimit: 6 });
    expect(page).not.toBeNull();
    expect(page?.counts).toEqual({ notes: 5, sources: 1, subtopics: 0 });
    expect(page?.topic).toMatchObject({
      id: ids.a1,
      title: "Alpha one",
      description: "About alpha.",
      aliases: ["First alpha"],
      nameLanguage: "en",
      items: 5,
      health: "attention",
      coherence: expect.closeTo(0.8, 5)
    });
    expect(page?.path.map((entry) => entry.id)).toEqual([ids.root, ids.a, ids.a1]);
    expect(
      page?.centralNotes.map((entry) => [entry.id, entry.centrality, entry.relationCount])
    ).toEqual([
      [note(1), expect.closeTo(0.9, 5), 3],
      [note(2), expect.closeTo(0.8, 5), 1],
      [note(3), expect.closeTo(0.7, 5), 2],
      [note(12), expect.closeTo(0.3, 5), 0],
      [note(4), null, 0]
    ]);
    expect(page?.centralNotes[1]).toMatchObject({
      provenance: "human",
      title: "Note 2",
      idea: "Idea of note 2",
      sourceId: section.x,
      sourceTitle: "Book X section"
    });
    expect(page?.moreNotes).toBe(0);
    expect(page?.sources).toEqual([
      { id: source.x, title: "Book X", subtitle: "Author X", noteCount: 5 }
    ]);
    expect(page?.relationStances).toEqual({
      supports: 1,
      contrasts: 1,
      extends: 1,
      similar_to: 0,
      depends_on: 0,
      clarifies: 1,
      mentions: 0,
      related: 1
    });
    // A pending-review relation still counts as a relation of note 3 (with note 2's, two); the
    // rejected relation of note 12 and the one to the rejected note 99 do not count.
    expect(
      page?.relatedLeaves
        .map((leaf) => [leaf.topicId, leaf.relationCount])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ).toEqual(
      [
        [ids.a2, 1],
        [ids.b1, 1],
        [ids.c, 1],
        [ids.root, 1]
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
    expect(page?.lastChange).toMatchObject({
      titleKey: "topics.changeSets.build",
      undo: "unavailable"
    });
  });

  it("reads the page of an internal topic: the best note of each child, then its own", async () => {
    const page = await reader().readPage({ id: ids.a, noteLimit: 6 });
    expect(page?.counts).toEqual({ notes: 8, sources: 2, subtopics: 2 });
    expect(
      page?.subtopics.map((entry) => [
        entry.id,
        entry.title,
        entry.items,
        entry.description,
        entry.health
      ])
    ).toEqual([
      [ids.a1, "Alpha one", 5, "About alpha.", "attention"],
      [ids.a2, null, 3, null, "good"]
    ]);
    expect(page?.centralNotes.map((entry) => entry.id)).toEqual([note(1), note(6), note(5)]);
    expect(page?.moreNotes).toBe(5);
    expect(page?.sources).toEqual([
      { id: source.x, title: "Book X", subtitle: "Author X", noteCount: 6 },
      { id: source.y, title: "Book Y", subtitle: null, noteCount: 2 }
    ]);
    const one = await reader().readPage({ id: ids.a, noteLimit: 1 });
    expect(one?.centralNotes.map((entry) => entry.id)).toEqual([note(1)]);
    expect(one?.moreNotes).toBe(7);
  });

  it("reports the Shape of the tree: cells, sums, depth, waiting share, warnings and the cut", async () => {
    const shape = await reader().readShape({ rootId: null, depth: 4, nodeLimit: 2_000 });
    expect(shape).not.toBeNull();
    expect(TopicShapeSchema.parse(shape)).toEqual(shape);
    expect(shape?.truncated).toBe(false);
    expect(shape?.nodes.map((node) => [node.id, node.depth, node.items, node.parentId])).toEqual([
      [ids.root, 0, 15, null],
      [ids.a, 1, 9, ids.root],
      [ids.b, 1, 2, ids.root],
      [ids.c, 1, 2, ids.root],
      [ids.a1, 2, 5, ids.a],
      [ids.a2, 2, 3, ids.a],
      [ids.b1, 2, 2, ids.b]
    ]);
    // 2 items on the root (depth 0), 1 + 2 on the Areas (depth 1), 5 + 3 + 2 on the subtopics (depth 2).
    expect(shape?.summary).toMatchObject({
      items: 15,
      topics: 6,
      needsVector: 1,
      hard: 1,
      soft: 1
    });
    expect(shape?.summary.meanDepth).toBeCloseTo((1 * 1 + 1 * 2 + 2 * 5 + 2 * 3 + 2 * 2) / 15, 6);
    expect(shape?.summary.reachable).toBe(1);
    // Waiting: the root's one unsorted item, note 5 (split check) and note 12 (gate).
    expect(shape?.summary.unsortedShare).toBeCloseTo(3 / 15, 6);
    expect(shape?.nodes[1]).toMatchObject({ title: "Area A", children: 2, management: "ai" });
    // The hard violation first, then the one awaiting approval, then the soft one.
    expect(
      shape?.warnings.map((warning) => [
        warning.topicId,
        warning.code,
        warning.params.awaitingApproval
      ])
    ).toEqual([
      [ids.b1, "fan-out-above-hard-max", false],
      [ids.c, "leaf-size-outside-range", true],
      [ids.a1, "leaf-size-outside-range", false]
    ]);
    expect(shape?.warnings[0]?.params).toMatchObject({
      invariant: "I3",
      severity: "hard",
      value: 15
    });
    expect(shape?.changedToday).toEqual([]);

    const cut = await reader().readShape({ rootId: null, depth: 1, nodeLimit: 2_000 });
    expect(cut?.nodes.map((node) => node.id)).toEqual([ids.root, ids.a, ids.b, ids.c]);
    expect(cut?.truncated).toBe(true);
    const limited = await reader().readShape({ rootId: null, depth: 4, nodeLimit: 3 });
    expect(limited?.nodes).toHaveLength(3);
    expect(limited?.truncated).toBe(true);

    const branch = await reader().readShape({ rootId: ids.a, depth: 2, nodeLimit: 100 });
    expect(branch?.nodes.map((node) => [node.id, node.depth, node.parentId])).toEqual([
      [ids.a, 0, null],
      [ids.a1, 1, ids.a],
      [ids.a2, 1, ids.a]
    ]);
    expect(branch?.summary).toMatchObject({ items: 9, topics: 2, hard: 0, soft: 1 });
    expect(await reader().readShape({ rootId: u(9999), depth: 2, nodeLimit: 10 })).toBeNull();
  });

  it("counts new arrivals this week, names the last change and tells when undo is blocked", async () => {
    const firstPlace = await apply({
      origin: "place",
      titleKey: "topics.changeSets.place",
      events: [placeEvent(14, ids.a1)]
    });
    let answer = await tree();
    expect(answer?.generation).toBe(generation);
    expect(answer?.nodes.map((node) => [node.id, node.newThisWeek])).toEqual([
      [ids.a, 1],
      [ids.b, 0],
      [ids.c, 0]
    ]);
    expect(answer?.parent.newThisWeek).toBe(1);
    let page = await reader().readPage({ id: ids.a1, noteLimit: 3 });
    expect(page?.lastChange).toMatchObject({
      changeSetId: firstPlace,
      titleKey: "topics.changeSets.place",
      undo: "available"
    });
    expect(page?.topic.newThisWeek).toBe(1);

    const secondPlace = await apply({
      origin: "place",
      titleKey: "topics.changeSets.place",
      events: [placeEvent(15, ids.a1)]
    });
    page = await reader().readPage({ id: ids.a1, noteLimit: 3 });
    expect(page?.lastChange?.changeSetId).toBe(secondPlace);
    expect(page?.lastChange?.undo).toBe("available");
    expect((await reader().readChangeSet(firstPlace))?.summary.undo).toBe("blocked");
    answer = await tree({ parentId: ids.a });
    expect(answer?.nodes.find((node) => node.id === ids.a1)?.newThisWeek).toBe(2);
  });

  it("lists today's structural changes, the proposals that wait and a change-set's before and after", async () => {
    const renamed = await apply({
      origin: "human",
      titleKey: "topics.changeSets.rename",
      titleParams: { title: "Alpha two", nested: { dropped: true } },
      events: [
        {
          op: "topic.rename",
          topicId: ids.a2,
          before: {
            title: null,
            nameState: "unnamed",
            nameSource: null,
            nameLanguage: null,
            namedChangeSetId: null,
            aliases: []
          },
          after: {
            title: "Alpha two",
            nameState: "named",
            nameSource: "human",
            nameLanguage: "en",
            namedChangeSetId: null,
            aliases: []
          }
        }
      ]
    });
    const proposal = await apply({
      origin: "areas",
      titleKey: "topics.changeSets.areas",
      status: "pending_review",
      risk: "medium",
      events: [
        {
          op: "topic.move",
          topicId: ids.b1,
          before: { parentId: ids.b, position: 0 },
          after: { parentId: ids.a, position: 2 }
        }
      ]
    });
    const shape = await reader().readShape({ rootId: null, depth: 4, nodeLimit: 2_000 });
    expect(shape?.changedToday.map((entry) => [entry.id, entry.origin, entry.undo])).toEqual([
      [renamed, "human", "available"]
    ]);
    expect(shape?.changedToday[0]?.titleParams).toEqual({ title: "Alpha two" });
    expect(shape?.warnings[0]).toMatchObject({
      topicId: ids.b1,
      code: "pending-review",
      changeSetId: proposal,
      pendingReview: true,
      params: { origin: "areas", risk: "medium", titleKey: "topics.changeSets.areas" }
    });

    const detail = await reader().readChangeSet(renamed);
    expect(TopicChangeSetSchema.parse(detail)).toEqual(detail);
    expect(detail?.before.topics).toEqual([{ id: ids.a2, title: null, parentTitle: "Area A" }]);
    expect(detail?.after.topics).toEqual([
      { id: ids.a2, title: "Alpha two", parentTitle: "Area A" }
    ]);
    const waiting = await reader().readChangeSet(proposal);
    expect(waiting?.summary).toMatchObject({ status: "pending_review", undo: "unavailable" });
    expect(waiting?.before.topics).toEqual([
      { id: ids.b1, title: "Beta one", parentTitle: "Area B" }
    ]);
    expect(waiting?.after.topics).toEqual([
      { id: ids.b1, title: "Beta one", parentTitle: "Area A" }
    ]);
    const placed = await reader().readChangeSet(
      (await reader().readPage({ id: ids.a1, noteLimit: 1 }))?.lastChange?.changeSetId ?? ""
    );
    expect(placed?.after.items).toEqual([
      { kind: "note", id: note(15), title: "Note 15", topicId: ids.a1, topicTitle: "Alpha one" }
    ]);
    expect(placed?.before.items).toEqual([]);
    expect(await reader().readChangeSet(u(9999))).toBeNull();
  });

  it("resolves a retired topic to its successor", async () => {
    const created = u(500);
    await apply({
      origin: "rebalance",
      titleKey: "topics.changeSets.split",
      events: [
        {
          op: "topic.create",
          topicId: created,
          before: null,
          after: topicRecordPayload(ids.root, "Temporary", 3)
        }
      ]
    });
    await apply({
      origin: "rebalance",
      titleKey: "topics.changeSets.dissolve",
      events: [
        {
          op: "topic.retire",
          topicId: created,
          before: { retiredAt: null, redirectTo: null },
          after: { retiredAt: iso(), redirectTo: ids.a }
        }
      ]
    });
    expect(await reader().readPath(created)).toMatchObject({
      resolvedId: ids.a,
      redirectedFrom: created,
      path: [
        { id: ids.root, title: null },
        { id: ids.a, title: "Area A" }
      ]
    });
    const page = await reader().readPage({ id: created, noteLimit: 2 });
    expect(page?.topic.id).toBe(ids.a);
    expect(page?.redirectedFrom).toBe(created);
    expect(await tree({ parentId: created })).toBeNull();
    const shape = await reader().readShape({ rootId: null, depth: 1, nodeLimit: 100 });
    expect(shape?.changedToday.map((entry) => entry.titleKey)).toContain(
      "topics.changeSets.dissolve"
    );
  });

  it("reads the ancestry and the counts of the status", async () => {
    const ancestry = await reader().readAncestry();
    expect(ancestry?.rootId).toBe(ids.root);
    expect(ancestry?.topics.find((entry) => entry.id === ids.a1)).toEqual({
      id: ids.a1,
      parentId: ids.a,
      title: "Alpha one",
      depth: 2
    });
    expect(ancestry?.topics.some((entry) => entry.id === u(500))).toBe(false);
    const counts = await reader().readStatusCounts();
    // 14 current notes (99 is rejected) and three root sources; 17 placed items; note 12 waits for the gate.
    expect(counts).toMatchObject({ items: 14 + 3, needsGate: 1 });
    expect(counts?.placed).toBe(17);
  });

  it("never shows a change-set before it commits", async () => {
    const client = await db().connect();
    const before = generation;
    try {
      await client.query("begin");
      const result = await writer().applyChangeSet(
        {
          treeId: ids.tree,
          expectedGeneration: generation,
          origin: "place",
          titleKey: "topics.changeSets.place",
          events: [
            {
              op: "item.place",
              item: itemKey("note", note(10)),
              topicId: ids.b1,
              before: null,
              after: placementRecord(ids.b1, { rank: 1 })
            }
          ]
        },
        { client }
      );
      expect(result.kind).toBe("applied");
      // Another session still reads the previous generation, and the listing does not change.
      expect((await tree())?.generation).toBe(before);
      expect((await tree({ parentId: ids.b1, includeItems: true, itemLimit: 1 }))?.moreItems).toBe(
        2
      );
      await client.query("commit");
      generation = before + 1;
    } finally {
      client.release();
    }
    expect((await tree())?.generation).toBe(before + 1);
    expect((await tree({ parentId: ids.b1, includeItems: true, itemLimit: 1 }))?.moreItems).toBe(3);
  });

  it("tells blocked from available the same way when thousands of change-sets came later", async () => {
    const describeEvent = (
      topic: string,
      before: string | null,
      after: string | null
    ): StructureEvent => ({
      op: "topic.describe",
      topicId: topic,
      before: { description: before },
      after: { description: after }
    });
    // csUnrelated touches Area C only, csRelated touches Area B only.
    const csUnrelated = await apply({
      origin: "human",
      titleKey: "topics.changeSets.describe",
      events: [describeEvent(ids.c, null, "About C.")]
    });
    const csRelated = await apply({
      origin: "human",
      titleKey: "topics.changeSets.describe",
      events: [describeEvent(ids.b, null, "About B 0.")]
    });
    expect((await reader().readChangeSet(csUnrelated))?.summary.undo).toBe("available");
    expect((await reader().readChangeSet(csRelated))?.summary.undo).toBe("available");
    // More later change-sets than the repository reads one by one.
    for (let n = 1; n <= 405; n += 1) {
      await apply({
        origin: "human",
        titleKey: "topics.changeSets.describe",
        events: [describeEvent(ids.b, `About B ${n - 1}.`, `About B ${n}.`)]
      });
    }
    expect((await reader().readChangeSet(csUnrelated))?.summary.undo).toBe("available");
    expect((await reader().readChangeSet(csRelated))?.summary.undo).toBe("blocked");
    const page = await reader().readPage({ id: ids.c, noteLimit: 2 });
    expect(page?.lastChange).toMatchObject({ changeSetId: csUnrelated, undo: "available" });
  }, 60_000);

  it("reaches every table through an index when scans are discouraged", async () => {
    const client = await db().connect();
    try {
      await client.query("begin");
      await client.query("set local enable_seqscan = off");
      const changeSetIds = (
        await client.query<{ id: string }>("select id from topic_change_sets")
      ).rows.map((row) => row.id);
      const statements: Array<[string, unknown[]]> = [
        [topicReadSql.children, [ids.tree, ids.root, null, null, 101]],
        [topicReadSql.nodes, [ids.tree, [ids.root, ids.a, ids.b], new Date(Date.now() - 6e8)]],
        [topicReadSql.counts, [[ids.a, ids.a1, ids.a2]]],
        [topicReadSql.sources, [[ids.a, ids.a1, ids.a2], 300, 300, 20]],
        [topicReadSql.directCentral, [ids.a1, 6]],
        [topicReadSql.representatives, [ids.tree, [ids.a1, ids.a2]]],
        [topicReadSql.centralNotes, [[note(1), note(2)], 300, ids.tree, 400]],
        [topicReadSql.relations, [[ids.a, ids.a1, ids.a2], 100, 50, ids.tree, 200, 5]],
        [topicReadSql.blocked, [ids.tree, changeSetIds]],
        [topicReadSql.lastChange, [ids.tree, ids.a1]],
        [topicReadSql.flagged, [ids.tree]],
        [topicReadSql.recent, [ids.tree, new Date(Date.now() - 6e8)]]
      ];
      const scanned: string[] = [];
      for (const [statement, values] of statements) {
        const plan = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
          `explain (format json) ${statement}`,
          values
        );
        scanned.push(...sequentialScans(plan.rows[0]!["QUERY PLAN"][0]!.Plan));
      }
      const guarded = scanned.filter((relation) =>
        ["topic_placements", "atomic_notes", "atomic_note_relations"].includes(relation)
      );
      expect(guarded).toEqual([]);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });
});

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}

function sequentialScans(node: PlanNode, found: string[] = []): string[] {
  if (node["Node Type"] === "Seq Scan" && node["Relation Name"]) found.push(node["Relation Name"]);
  for (const child of node.Plans ?? []) sequentialScans(child, found);
  return found;
}

/** The payload of a `topic.create` event: a named, AI-managed topic under `parentId`. */
function topicRecordPayload(parentId: string, title: string, position: number) {
  const { id: _id, ...record } = topicRecord(u(0), parentId, {
    role: "topic",
    title,
    nameState: "named",
    nameSource: "llm",
    nameLanguage: "en",
    position
  });
  void _id;
  return { ...record, parentId, role: "topic" as const };
}
