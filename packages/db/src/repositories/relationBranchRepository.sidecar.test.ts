import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  createRelationBranchRepository,
  relationBranchColours,
  type RelationBranchRead,
  type RelationBranchRequest
} from "./relationBranchRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// `relations.branch` on a real PostgreSQL (F5 T133, D19): a branch of the topic tree and a source as
// scopes; which relations count (shown only, current endpoints); the note, per-topic and relation
// limits with the truncation flag; colours that stay put across calls; outside topics and
// super-edges; a retired topic read through its redirect, and scopes that do not exist.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe("relationBranchColours", () => {
  const t = (id: string, parentId: string | null, title: string, depth: number) => ({
    id,
    parentId,
    title,
    depth
  });

  it("orders the groups at the depth by title then ID, shallower groups after, modulo 12", () => {
    const topics = [
      t("s", null, "Scope", 0),
      t("b", "s", "Beta", 1),
      t("a2", "s", "Alpha", 1),
      t("a1", "s", "Alpha", 1),
      t("b1", "b", "Below", 2),
      ...Array.from({ length: 12 }, (_, index) => t(`x${index}`, "s", `X${index}`, 1))
    ];
    const { groupOf, colourOf } = relationBranchColours(topics, 1);
    expect(groupOf.get("b1")).toBe("b");
    expect(groupOf.get("s")).toBe("s");
    expect(["a1", "a2", "b", "x0"].map((id) => colourOf.get(id))).toEqual([0, 1, 2, 3]);
    // Twelve X topics follow Beta at 3..14 in code-unit order (X0, X1, X10, X11, X2 ... X9): X7 is
    // the 13th group, so its colour wraps to 0, and X9 is the 15th.
    expect(colourOf.get("x7")).toBe(0);
    expect(colourOf.get("x9")).toBe(2);
    // The scope topic comes after all 15 groups at depth 1.
    expect(colourOf.get("s")).toBe(15 % 12);
  });

  it("is the same whatever the order the topics arrive in", () => {
    const topics = [
      t("s", null, "", 0),
      t("m", "s", "Ética", 1),
      t("n", "s", "Economia", 1),
      t("o", "n", "Deep", 2)
    ];
    const once = relationBranchColours(topics, 1);
    const reversed = relationBranchColours([...topics].reverse(), 1);
    expect([...reversed.colourOf.entries()].sort()).toEqual([...once.colourOf.entries()].sort());
    expect(once.colourOf.get("n")).toBe(0);
    expect(once.colourOf.get("m")).toBe(1);
    expect(once.groupOf.get("o")).toBe("n");
  });
});

describe.skipIf(!sidecarInstalled)("relations.branch on a real database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let branch: ReturnType<typeof createRelationBranchRepository>;

  const rootId = randomUUID();
  const topic = {
    a: randomUUID(),
    a1: randomUUID(),
    a2: randomUUID(),
    a1x: randomUUID(),
    b: randomUUID(),
    b1: randomUUID(),
    old: randomUUID()
  };
  const src = { s1: randomUUID(), s2: randomUUID(), s3: randomUUID() };
  /** A document and a chunk per source: a note's evidence lies in the source it was made from. */
  const chunkOf = { [src.s1]: randomUUID(), [src.s2]: randomUUID(), [src.s3]: randomUUID() };
  const n = Object.fromEntries(
    ["n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "m1", "m2", "u1", "r1"].map((key) => [
      key,
      randomUUID()
    ])
  ) as Record<
    "n1" | "n2" | "n3" | "n4" | "n5" | "n6" | "n7" | "n8" | "n9" | "m1" | "m2" | "u1" | "r1",
    string
  >;
  const relationIds = new Map<string, string>();

  async function note(
    key: keyof typeof n,
    source: string,
    minute: number,
    superseded = false
  ): Promise<void> {
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key, language, created_at)
       values ($1::uuid, $2, 'Body.', $2, 'active', $3, 'source', $4, $4, $5, 'seed', 'seed',
         'local', 'seed', $1::uuid::text, 'en', timestamptz '2026-11-01 10:00:00+00' + make_interval(mins => $6))`,
      [
        n[key],
        key.toUpperCase(),
        superseded ? "superseded" : "current",
        source,
        chunkOf[source],
        minute
      ]
    );
  }

  type Kind = "applied" | "kept" | "suggested" | "withdrawn" | "removed";
  async function relate(
    x: keyof typeof n,
    y: keyof typeof n,
    probability: number,
    kind: Kind = "applied",
    type: "same_as" | "contradicts" = "same_as"
  ): Promise<void> {
    const [lo, hi] = n[x] < n[y] ? [n[x], n[y]] : [n[y], n[x]];
    const row = await pool.query<{ id: string }>(
      `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
         direction, band, probability, final_score, explanation, status, vetoed_at, veto_source, matching_model)
       values ($1, $2, $3, 'symmetric', $4, $5::float8, $5::float8, 'Why.', $6, $7, $8, 'seed') returning id`,
      [
        lo,
        hi,
        type,
        kind === "suggested" ? "suggest" : "apply",
        probability,
        kind === "removed" ? "rejected" : kind === "kept" ? "accepted" : "pending_review",
        kind === "withdrawn" ? new Date() : null,
        kind === "withdrawn" ? "explainer" : null
      ]
    );
    relationIds.set(`${x}-${y}`, row.rows[0]!.id);
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-relation-branch-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_relation_branch_test",
        user: "memora_relation_branch_test",
        password: `relation-branch-${randomUUID()}`,
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
    await runMigrations(pool, migrationsFolder);
    branch = createRelationBranchRepository(pool);

    // s1 is a book with one chapter s2; s3 is another source.
    await pool.query(
      `insert into source_items (id, type, title, language, content_hash, parent_source_item_id)
       values ($1, 'Book', 'Sleep', 'en', 'content-s1', null),
              ($2, 'BookChapter', 'Naps', 'en', 'content-s2', $1),
              ($3, 'Book', 'Other', 'en', 'content-s3', null)`,
      [src.s1, src.s2, src.s3]
    );
    for (const [index, source] of [src.s1, src.s2, src.s3].entries()) {
      const doc = randomUUID();
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Doc', 'seed', $3)`,
        [doc, source, `doc-${index}`]
      );
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, 0, 'Naps restore focus.', $4)`,
        [chunkOf[source], doc, source, `hash-${index}`]
      );
    }
    // Created minutes give the recency order: a higher number is newer.
    await note("n1", src.s1, 1);
    await note("n2", src.s1, 2);
    await note("n3", src.s2, 3);
    await note("n4", src.s3, 4);
    await note("n5", src.s1, 5);
    await note("n6", src.s3, 6);
    await note("n7", src.s3, 7);
    await note("n8", src.s3, 8);
    await note("n9", src.s3, 9, true);
    await note("m1", src.s1, 10);
    await note("m2", src.s3, 11);
    await note("u1", src.s2, 12);
    await note("r1", src.s1, 13);

    const trees = createTopicTreeRepository(pool);
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:branch:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    const named = (id: string, parent: string, title: string) =>
      topicRecord(id, parent, {
        role: "topic",
        title,
        nameState: "named" as const,
        nameSource: "llm" as const,
        nameLanguage: "en"
      });
    const place = (key: keyof typeof n, topicId: string) => ({
      item: itemKey("note", n[key]),
      placement: placementRecord(topicId)
    });
    // Root -> A (Alpha area: A1 Zeta -> A1x Deep; A2 Eta), B (Beta area: B1 Gamma); Old retires to A.
    await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        named(topic.a, rootId, "Alpha area"),
        named(topic.a1, topic.a, "Zeta"),
        named(topic.a2, topic.a, "Eta"),
        named(topic.a1x, topic.a1, "Deep"),
        named(topic.b, rootId, "Beta area"),
        named(topic.b1, topic.b, "Gamma"),
        named(topic.old, rootId, "Old")
      ],
      placements: [
        place("n1", topic.a1),
        place("n2", topic.a1),
        place("n3", topic.a1),
        place("n4", topic.a1),
        place("n9", topic.a1),
        place("n5", topic.a2),
        place("n6", topic.a2),
        place("n7", topic.a1x),
        place("n8", topic.a),
        place("m1", topic.b1),
        place("m2", topic.b1),
        // r1 waits in Unsorted: its primary placement is on the root.
        place("r1", rootId),
        // A secondary placement never makes a note part of a branch.
        { item: itemKey("note", n.m2), placement: placementRecord(topic.a2, { rank: 1 }) }
      ]
    });
    await pool.query("update topics set retired_at = now(), redirect_to = $2 where id = $1", [
      topic.old,
      topic.a
    ]);

    // Inside A: n1 is the hub. Probabilities give the strength order of the edges.
    await relate("n1", "n2", 0.95);
    await relate("n1", "n3", 0.9, "kept");
    await relate("n1", "n4", 0.85, "applied", "contradicts");
    await relate("n2", "n3", 0.8);
    await relate("n1", "n5", 0.75);
    await relate("n5", "n6", 0.7);
    await relate("n1", "n7", 0.65);
    await relate("n6", "n8", 0.6);
    await relate("n3", "n4", 0.55, "suggested");
    // Never counted: withdrawn, removed, and an endpoint that is an earlier version.
    await relate("n2", "n4", 0.99, "withdrawn");
    await relate("n6", "n7", 0.98, "removed");
    await relate("n1", "n9", 0.97);
    // Leaving A for B1 (Gamma); u1 is not placed, so its relation has no outside topic.
    await relate("n1", "m1", 0.5);
    await relate("n2", "m1", 0.45);
    await relate("n5", "m2", 0.4);
    await relate("n1", "u1", 0.35);
    // n1-r1 leaves A for Unsorted, which is no outside topic either.
    await relate("n1", "r1", 0.3);
  }, 180_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  const request = (
    scope: RelationBranchRequest["scope"],
    overrides: Partial<RelationBranchRequest> = {}
  ): RelationBranchRequest => ({
    scope,
    colourDepth: 1,
    noteLimit: 400,
    perTopicLimit: 80,
    relationLimit: 2000,
    ...overrides
  });
  const keyOf = (id: string) => Object.entries(n).find(([, value]) => value === id)?.[0];
  const nodeKeys = (read: RelationBranchRead | null) => read!.nodes.map((node) => keyOf(node.id));
  const edgeKeys = (read: RelationBranchRead | null) =>
    read!.edges.map((edge) => [keyOf(edge.a), keyOf(edge.b)].sort().join("-"));
  const colourOf = (read: RelationBranchRead | null) =>
    Object.fromEntries(read!.topics.map((item) => [item.id, item.colourIndex]));
  /** Every node's topic is listed (or null), and no outside topic is drawn as a topic too. */
  const expectSelfContained = (read: RelationBranchRead | null) => {
    const listed = new Set(read!.topics.map((item) => item.id));
    for (const node of read!.nodes)
      if (node.topicId !== null) expect(listed).toContain(node.topicId);
    for (const entry of read!.outside) expect(listed).not.toContain(entry.topicId);
  };

  it("draws a branch: its topics, its current notes by degree, the shown relations among them", async () => {
    const read = await branch.read(request({ topicId: topic.a }));
    expect(read).not.toBeNull();
    // The scope topic first, then by depth and title.
    expect(read!.topics.map((item) => item.id)).toEqual([topic.a, topic.a2, topic.a1, topic.a1x]);
    expect(read!.topics[0]).toMatchObject({ title: "Alpha area", noteCount: 1 });
    expect(Object.fromEntries(read!.topics.map((item) => [item.id, item.noteCount]))).toEqual({
      [topic.a]: 1,
      [topic.a1]: 4,
      [topic.a2]: 2,
      [topic.a1x]: 1
    });
    // Degree inside the branch, then the newest first among equals.
    expect(nodeKeys(read)).toEqual(["n1", "n3", "n6", "n5", "n4", "n2", "n8", "n7"]);
    expect(read!.nodes.map((node) => node.degree)).toEqual([5, 3, 2, 2, 2, 2, 1, 1]);
    expect(read!.nodes.find((node) => node.id === n.n7)!.topicId).toBe(topic.a1x);
    expect(edgeKeys(read)).toEqual([
      "n1-n2",
      "n1-n3",
      "n1-n4",
      "n2-n3",
      "n1-n5",
      "n5-n6",
      "n1-n7",
      "n6-n8",
      "n3-n4"
    ]);
    const suggested = read!.edges.find((edge) => edge.id === relationIds.get("n3-n4"));
    expect(suggested).toMatchObject({ band: "suggest", type: "same_as" });
    expect(read!.edges.find((edge) => edge.id === relationIds.get("n1-n4"))!.type).toBe(
      "contradicts"
    );
    expect(read!.truncated).toBe(false);
  });

  it("counts the relations leaving the branch per the other note's topic", async () => {
    const read = await branch.read(request({ topicId: topic.a }));
    // n1-u1 (not placed) and n1-r1 (Unsorted) have no outside topic.
    expect(read!.outside).toEqual([{ topicId: topic.b1, title: "Gamma", edgeCount: 3 }]);
    expectSelfContained(read);
  });

  it("colours by the topics at the depth and aggregates super-edges between those groups", async () => {
    const one = await branch.read(request({ topicId: topic.a }));
    // Depth 1: Eta (A2) 0, Zeta (A1) 1 and Deep below it, the scope topic after them.
    expect(colourOf(one)).toEqual({ [topic.a2]: 0, [topic.a1]: 1, [topic.a1x]: 1, [topic.a]: 2 });
    const pair = (x: string, y: string) => (x < y ? { a: x, b: y } : { a: y, b: x });
    expect(one!.superEdges).toHaveLength(2);
    expect(one!.superEdges).toEqual(
      expect.arrayContaining([
        { ...pair(topic.a1, topic.a2), weight: 1 },
        { ...pair(topic.a, topic.a2), weight: 1 }
      ])
    );
    // Depth 2: Deep 0, then the shallower ones by depth and title: the scope, Eta, Zeta.
    const two = await branch.read(request({ topicId: topic.a }, { colourDepth: 2 }));
    expect(colourOf(two)).toEqual({ [topic.a1x]: 0, [topic.a]: 1, [topic.a2]: 2, [topic.a1]: 3 });
    expect(two!.superEdges).toHaveLength(3);
    expect(two!.superEdges).toEqual(
      expect.arrayContaining([{ ...pair(topic.a1, topic.a1x), weight: 1 }])
    );
  });

  it("keeps every colour where it was across calls and limits", async () => {
    const first = colourOf(await branch.read(request({ topicId: topic.a })));
    for (const overrides of [{}, { noteLimit: 1 }, { perTopicLimit: 1, relationLimit: 1 }])
      expect(colourOf(await branch.read(request({ topicId: topic.a }, overrides)))).toEqual(first);
  });

  it("applies the note, per-topic and relation limits and says it truncated", async () => {
    const few = await branch.read(request({ topicId: topic.a }, { noteLimit: 3 }));
    expect(nodeKeys(few)).toEqual(["n1", "n3", "n6"]);
    expect(edgeKeys(few)).toEqual(["n1-n3"]);
    expect(few!.truncated).toBe(true);
    // The degree stays the degree inside the whole branch, not among the drawn notes.
    expect(few!.nodes[0]!.degree).toBe(5);
    // Outside counts only the drawn notes' relations: n1-m1 (n2 and n5 are not drawn).
    expect(few!.outside).toEqual([{ topicId: topic.b1, title: "Gamma", edgeCount: 1 }]);
    // A relation to a scope note that is not drawn is not "outside".
    const one = await branch.read(request({ topicId: topic.a }, { noteLimit: 1 }));
    expect(one!.outside).toEqual([{ topicId: topic.b1, title: "Gamma", edgeCount: 1 }]);

    const perTopic = await branch.read(request({ topicId: topic.a }, { perTopicLimit: 2 }));
    expect(nodeKeys(perTopic)).toEqual(["n1", "n3", "n6", "n5", "n8", "n7"]);
    expect(perTopic!.truncated).toBe(true);

    const strongest = await branch.read(request({ topicId: topic.a }, { relationLimit: 2 }));
    expect(edgeKeys(strongest)).toEqual(["n1-n2", "n1-n3"]);
    expect(strongest!.nodes).toHaveLength(8);
    expect(strongest!.truncated).toBe(true);

    const exact = await branch.read(
      request({ topicId: topic.a }, { noteLimit: 8, relationLimit: 9 })
    );
    expect(exact!.truncated).toBe(false);
  });

  it("scopes to a source: its notes and its chapters', and the topics they are placed in", async () => {
    const read = await branch.read(request({ sourceId: src.s1 }));
    expect(new Set(nodeKeys(read))).toEqual(new Set(["n1", "n2", "n3", "n5", "m1", "u1", "r1"]));
    // Neither a note the tree has not placed nor one waiting in Unsorted has a topic.
    expect(read!.nodes.find((node) => node.id === n.u1)!.topicId).toBeNull();
    expect(read!.nodes.find((node) => node.id === n.r1)!.topicId).toBeNull();
    expectSelfContained(read);
    // The placed topics and their ancestors below the root, by depth then title.
    expect(read!.topics.map((item) => item.id)).toEqual([
      topic.a,
      topic.b,
      topic.a2,
      topic.b1,
      topic.a1
    ]);
    expect(Object.fromEntries(read!.topics.map((item) => [item.id, item.noteCount]))).toEqual({
      [topic.a]: 0,
      [topic.b]: 0,
      [topic.a1]: 3,
      [topic.a2]: 1,
      [topic.b1]: 1
    });
    // Colours by the areas below the root: Alpha area 0, Beta area 1.
    expect(colourOf(read)).toEqual({
      [topic.a]: 0,
      [topic.a1]: 0,
      [topic.a2]: 0,
      [topic.b]: 1,
      [topic.b1]: 1
    });
    expect(new Set(edgeKeys(read))).toEqual(
      new Set(["n1-n2", "n1-n3", "n2-n3", "n1-n5", "m1-n1", "m1-n2", "n1-u1", "n1-r1"])
    );
    // Another source's notes in Zeta, Eta and Gamma are in topics this read draws, so only Deep is
    // outside: a topic is never both a colour group and an outside pill.
    expect(read!.outside).toEqual([{ topicId: topic.a1x, title: "Deep", edgeCount: 1 }]);
    const [a, b] = topic.a < topic.b ? [topic.a, topic.b] : [topic.b, topic.a];
    expect(read!.superEdges).toEqual([{ a, b, weight: 2 }]);
    expect(read!.truncated).toBe(false);

    const chapter = await branch.read(request({ sourceId: src.s2 }));
    expect(new Set(nodeKeys(chapter))).toEqual(new Set(["n3", "u1"]));
  });

  it("reads a retired topic through its redirect and has nothing for a scope that does not exist", async () => {
    const redirected = await branch.read(request({ topicId: topic.old }));
    expect(redirected).toEqual(await branch.read(request({ topicId: topic.a })));
    expect(await branch.read(request({ topicId: randomUUID() }))).toBeNull();
    expect(await branch.read(request({ sourceId: randomUUID() }))).toBeNull();
    // A source with no note is a scope with nothing in it.
    const empty = randomUUID();
    await pool.query(
      `insert into source_items (id, type, title, language, content_hash)
       values ($1, 'Book', 'Empty', 'en', 'content-empty')`,
      [empty]
    );
    expect(await branch.read(request({ sourceId: empty }))).toEqual({
      topics: [],
      nodes: [],
      edges: [],
      outside: [],
      superEdges: [],
      truncated: false
    });
  });

  it("explains the two statements it runs, for the benchmark's plan check", async () => {
    for (const scope of [{ topicId: topic.a }, { sourceId: src.s1 }]) {
      const plans = await branch.explain(request(scope));
      for (const plan of [plans!.topics, plans!.graph])
        expect((plan as Array<{ Plan: { "Node Type": string } }>)[0]!.Plan["Node Type"]).toEqual(
          expect.any(String)
        );
    }
    expect(await branch.explain(request({ topicId: randomUUID() }))).toBeNull();
  });

  it("draws the whole tree from the root, the unnamed root first", async () => {
    const read = await branch.read(request({ topicId: rootId }));
    expect(read!.topics[0]).toMatchObject({ id: rootId, title: "", parentId: null });
    // Every current note placed in the tree, r1 on the root; u1 is not placed and n9 is an earlier
    // version.
    expect(read!.nodes).toHaveLength(11);
    expect(read!.nodes.find((node) => node.id === n.r1)!.topicId).toBe(rootId);
    expect(read!.topics[0]!.noteCount).toBe(1);
    expectSelfContained(read);
    expect(read!.outside).toEqual([]);
  });
});
