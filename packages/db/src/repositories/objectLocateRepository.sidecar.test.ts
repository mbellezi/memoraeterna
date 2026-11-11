import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import { ObjectLocateResultSchema, objectLocateTopicPathLimit } from "@app/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createObjectLocateRepository } from "./objectLocateRepository.js";
import { createTopicOverviewRepository } from "./topicOverviewRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// `objects.locate` for topics and entities on a real PostgreSQL (F5 T119, D11): the ancestor chain
// of a topic at the depth cap, an entity with notes in three topics (top places by count), and a
// retired topic read through `redirect_to`.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe.skipIf(!sidecarInstalled)("locate for topics and entities on a real database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let locate: ReturnType<typeof createObjectLocateRepository>;

  const rootId = randomUUID();
  /** A chain below the root: deep[0] is at depth 1 and deep[6] at depth 7 (eight with the root). */
  const deep = Array.from({ length: 7 }, () => randomUUID());
  const topic = {
    sleep: randomUUID(),
    memory: randomUUID(),
    focus: randomUUID(),
    mood: randomUUID(),
    unplaced: randomUUID(),
    retired: randomUUID(),
    retiredTwice: randomUUID(),
    retiredNoSuccessor: randomUUID(),
    cycleA: randomUUID(),
    cycleB: randomUUID(),
    unnamed: randomUUID(),
    citing: randomUUID(),
    stale: randomUUID()
  };
  const w = {
    s1: randomUUID(),
    d1: randomUUID(),
    c1: randomUUID(),
    notes: Array.from({ length: 7 }, () => randomUUID()),
    entity: randomUUID(),
    lonely: randomUUID(),
    deepEntity: randomUUID()
  };

  async function note(id: string, title: string, superseded = false) {
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key, language)
       values ($1::uuid, $2, 'Body.', $2, 'active', $3, 'source', $4, $4, $5, 'seed', 'seed',
         'local', 'seed', $1::uuid::text, 'en')`,
      [id, title, superseded ? "superseded" : "current", w.s1, w.c1]
    );
    await pool.query(
      `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id) values ($1, $2, $3)`,
      [id, w.s1, w.c1]
    );
  }
  const mention = (noteId: string, entityId: string) =>
    pool.query(
      `insert into atomic_note_entity_links (atomic_note_id, entity_id, confidence) values ($1, $2, 0.8)`,
      [noteId, entityId]
    );

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-object-locate-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_object_locate_test",
        user: "memora_object_locate_test",
        password: `object-locate-${randomUUID()}`,
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
    locate = createObjectLocateRepository(pool);

    await pool.query(
      `insert into source_items (id, type, title, language, content_hash)
       values ($1, 'Book', 'Sleep', 'en', 'content-s1')`,
      [w.s1]
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Doc', 'seed', 'doc-1')`,
      [w.d1, w.s1]
    );
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Naps restore focus.', 'hash-c1')`,
      [w.c1, w.d1, w.s1]
    );
    const [n0, n1, n2, n3, n4, n5, n6] = w.notes as [
      string,
      string,
      string,
      string,
      string,
      string,
      string
    ];
    await note(n0, "Alpha");
    await note(n1, "Beta");
    await note(n2, "Gamma");
    await note(n3, "Delta");
    await note(n4, "Old delta", true);
    await note(n5, "Epsilon");
    await note(n6, "Zeta");

    // The entity: Sleep holds two of its notes, Memory and Focus one each (a tie broken by title),
    // Mood holds a superseded note and a secondary placement only, and one note is not placed.
    await pool.query(
      `insert into entities (id, type, canonical_name, normalized_name, description, confidence, language)
       values ($1, 'concept', 'Circadian rhythm', 'circadian rhythm', 'The body clock.', 0.9, 'en'),
              ($2, 'concept', 'Lonely', 'lonely', null, 0.9, 'en'),
              ($3, 'concept', 'Deep', 'deep', null, 0.9, 'en')`,
      [w.entity, w.lonely, w.deepEntity]
    );
    for (const id of [n0, n1, n2, n3, n4, n5]) await mention(id, w.entity);
    await mention(n6, w.deepEntity);
    await mention(n3, w.lonely);

    const trees = createTopicTreeRepository(pool);
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:locate:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    const named = (id: string, parent: string, title: string | null, extra = {}) =>
      topicRecord(id, parent, {
        role: "topic",
        ...(title
          ? { title, nameState: "named" as const, nameSource: "llm" as const, nameLanguage: "en" }
          : {}),
        ...extra
      });
    const retiring = [
      topic.retired,
      topic.retiredTwice,
      topic.retiredNoSuccessor,
      topic.cycleA,
      topic.cycleB
    ];
    await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        ...deep.map((id, index) =>
          named(id, index === 0 ? rootId : deep[index - 1]!, `Level ${index + 1}`)
        ),
        named(topic.sleep, rootId, "Sleep"),
        named(topic.memory, rootId, "Memory"),
        named(topic.focus, rootId, "Focus"),
        named(topic.mood, rootId, "Mood"),
        named(topic.unplaced, rootId, "Unplaced"),
        named(topic.unnamed, rootId, null),
        named(topic.citing, rootId, "Citing"),
        ...retiring.map((id, index) => named(id, rootId, `Retired ${index}`))
      ],
      placements: [
        { item: itemKey("note", n0), placement: placementRecord(topic.sleep) },
        { item: itemKey("note", n1), placement: placementRecord(topic.sleep) },
        { item: itemKey("note", n2), placement: placementRecord(topic.memory) },
        { item: itemKey("note", n3), placement: placementRecord(topic.focus) },
        { item: itemKey("note", n4), placement: placementRecord(topic.mood) },
        { item: itemKey("note", n5), placement: placementRecord(topic.sleep, { rank: 1 }) },
        { item: itemKey("note", n5), placement: placementRecord(topic.mood, { rank: 2 }) },
        // A note deep in the chain, to give the deepest topic a member.
        { item: itemKey("note", n6), placement: placementRecord(deep[6]!) }
      ]
    });

    // Retire: retired -> sleep; retiredTwice -> retired (a chain); retiredNoSuccessor -> nothing;
    // cycleA <-> cycleB.
    const retire = (id: string, to: string | null) =>
      pool.query("update topics set retired_at = now(), redirect_to = $2 where id = $1", [id, to]);
    await retire(topic.retired, topic.sleep);
    await retire(topic.retiredTwice, topic.retired);
    await retire(topic.retiredNoSuccessor, null);
    await retire(topic.cycleA, topic.cycleB);
    await retire(topic.cycleB, topic.cycleA);

    // Overviews: Citing cites a note of Sleep's subtree; Sleep cites its own note (itself is not
    // listed as citing); Memory cites a note of Focus, not of its own subtree.
    const overviews = createTopicOverviewRepository(pool);
    const overview = (topicId: string, noteId: string) =>
      overviews.write({
        topicId,
        paragraphs: [{ text: "Lead [1].", citations: [1] }],
        evidence: [],
        memberFingerprint: "members",
        memberCount: 1,
        inputHash: `input-${topicId}`,
        promptRevisionId: "topic.overview@test",
        provider: "test",
        model: "test",
        runtime: "none",
        aiTaskRunId: null,
        language: "en",
        support: { status: "unchecked", unsupported: [] },
        divergences: [],
        citations: [
          {
            n: 1,
            chunkId: w.c1,
            sourceSpanId: null,
            noteId,
            excerpt: "Naps restore focus.",
            excerptHash: hash("Naps restore focus.")
          }
        ]
      });
    await overview(topic.citing, n0);
    await overview(topic.sleep, n1);
    await overview(topic.memory, n3);

    // A topic of an old tree: it still has `retired_at` null, but the tree is no longer active.
    const oldTree = randomUUID();
    const oldRoot = randomUUID();
    await pool.query(
      `insert into topic_trees (id, status, space_key, embedding_provider, embedding_model,
         embedding_runtime, dimensions, config, config_hash, seed, activated_at, retired_at)
       values ($1, 'retired', 'test:locate:old', 'test', 'test', 'none', 256, '{}', 'old', 1, now(), now())`,
      [oldTree]
    );
    await pool.query(
      `insert into topics (id, tree_id, role, parent_id, title, name_state, name_source, name_language, management)
       values ($1, $3, 'root', null, null, 'unnamed', null, null, 'human'),
              ($2, $3, 'topic', $1, 'Stale', 'named', 'llm', 'en', 'human')`,
      [oldRoot, topic.stale, oldTree]
    );
  }, 180_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  const titles = (path: ReadonlyArray<{ title: string }>) => path.map((item) => item.title);

  it("walks a topic chain at depth 7: the root, seven levels, itself last", async () => {
    const located = await locate.locateTopic(deep[6]!);
    expect(located).not.toBeNull();
    expect(located!.primaryPath).toHaveLength(objectLocateTopicPathLimit);
    expect(located!.primaryPath.map((item) => item.id)).toEqual([rootId, ...deep]);
    expect(titles(located!.primaryPath)).toEqual([
      "",
      ...deep.map((_, index) => `Level ${index + 1}`)
    ]);
    expect(located!.object).toEqual({ kind: "topic", id: deep[6], title: "Level 7" });
    expect(located!.alsoIn).toEqual([]);
    expect(located!.counts.alsoIn).toBe(0);
    expect(ObjectLocateResultSchema.safeParse(located).success).toBe(true);
    // A level in the middle stops at itself.
    const middle = await locate.locateTopic(deep[2]!);
    expect(middle!.primaryPath.map((item) => item.id)).toEqual([rootId, ...deep.slice(0, 3)]);
  });

  it("locates the root and a topic that is not named yet (an empty title is not a missing topic)", async () => {
    const root = await locate.locateTopic(rootId);
    expect(root!.primaryPath).toEqual([{ kind: "topic", id: rootId, title: "" }]);
    const unnamed = await locate.locateTopic(topic.unnamed);
    expect(unnamed!.object).toEqual({ kind: "topic", id: topic.unnamed, title: "" });
    expect(unnamed!.primaryPath.map((item) => item.id)).toEqual([rootId, topic.unnamed]);
  });

  it("lists the other pages whose overview cites a note of the topic's subtree, never itself", async () => {
    const sleep = await locate.locateTopic(topic.sleep);
    // Sleep holds n0 (cited by Citing) and n1 (cited by Sleep itself, left out).
    expect(sleep!.citedBy).toEqual([{ kind: "topic", id: topic.citing, title: "Citing" }]);
    expect(sleep!.counts.citedBy).toBe(1);
    // Memory's own note n2 is cited by nobody; Focus's n3 is cited by Memory, which does not hold it.
    expect((await locate.locateTopic(topic.memory))!.citedBy).toEqual([]);
    expect((await locate.locateTopic(topic.focus))!.citedBy).toEqual([
      { kind: "topic", id: topic.memory, title: "Memory" }
    ]);
    // The root's subtree is the whole tree: every other page that cites any note.
    const root = await locate.locateTopic(rootId);
    expect(root!.citedBy.map((item) => item.title)).toEqual(["Citing", "Memory", "Sleep"]);
  });

  it("resolves a retired topic through redirect_to to the live topic, at any depth of the chain", async () => {
    const once = await locate.locateTopic(topic.retired);
    expect(once!.object).toEqual({ kind: "topic", id: topic.sleep, title: "Sleep" });
    expect(once!.primaryPath.map((item) => item.id)).toEqual([rootId, topic.sleep]);
    const twice = await locate.locateTopic(topic.retiredTwice);
    expect(twice!.object.id).toBe(topic.sleep);
    expect(twice).toEqual(once);
  });

  it("has no place for a retired topic without a successor, a redirect cycle, a topic of an old tree or no topic", async () => {
    expect(await locate.locateTopic(topic.retiredNoSuccessor)).toBeNull();
    expect(await locate.locateTopic(topic.cycleA)).toBeNull();
    expect(await locate.locateTopic(topic.stale)).toBeNull();
    expect(await locate.locateTopic(randomUUID())).toBeNull();
  });

  it("places an entity with notes in three topics: top places by count, the first is primary", async () => {
    const located = await locate.locateEntity(w.entity);
    expect(located).not.toBeNull();
    // Sleep has two notes; Focus and Memory one each (Focus before Memory by title). The superseded
    // note of Mood and the secondary placements do not count.
    expect(located!.primaryPath).toEqual([
      { kind: "topic", id: rootId, title: "" },
      { kind: "topic", id: topic.sleep, title: "Sleep" },
      { kind: "entity", id: w.entity, title: "Circadian rhythm" }
    ]);
    expect(located!.alsoIn).toEqual([
      { kind: "topic", id: topic.focus, title: "Focus" },
      { kind: "topic", id: topic.memory, title: "Memory" }
    ]);
    expect(located!.object).toEqual({ kind: "entity", id: w.entity, title: "Circadian rhythm" });
    // Five current notes mention it (the superseded one does not, a note with only secondary
    // placements still counts as a mention); two other topics hold notes.
    expect(located!.counts).toEqual({
      alsoIn: 2,
      citedBy: 0,
      notes: 5,
      passages: 0,
      children: 0
    });
    expect(located!.citedBy).toEqual([]);
    expect(ObjectLocateResultSchema.safeParse(located).success).toBe(true);
  });

  it("places an entity whose only place is one topic, and one placed at the depth cap", async () => {
    const lonely = await locate.locateEntity(w.lonely);
    expect(lonely!.primaryPath.map((item) => item.id)).toEqual([rootId, topic.focus, w.lonely]);
    expect(lonely!.alsoIn).toEqual([]);
    expect(lonely!.counts.alsoIn).toBe(0);
    // Its one note sits in the deepest topic: the path is that chain and then the entity.
    const deepPlaced = await locate.locateEntity(w.deepEntity);
    expect(deepPlaced!.primaryPath.map((item) => item.id)).toEqual([rootId, ...deep, w.deepEntity]);
    expect(deepPlaced!.primaryPath).toHaveLength(objectLocateTopicPathLimit + 1);
    expect(ObjectLocateResultSchema.safeParse(deepPlaced).success).toBe(true);
    // An entity none of whose notes is placed has the entity alone in its path.
    const free = randomUUID();
    await pool.query(
      `insert into entities (id, type, canonical_name, normalized_name, confidence, language)
       values ($1, 'concept', 'Free', 'free', 0.9, 'en')`,
      [free]
    );
    const freeNote = randomUUID();
    await note(freeNote, "Free note");
    await mention(freeNote, free);
    const alone = await locate.locateEntity(free);
    expect(alone!.primaryPath).toEqual([{ kind: "entity", id: free, title: "Free" }]);
    expect(alone!.counts.notes).toBe(1);
    expect(await locate.locateEntity(randomUUID())).toBeNull();
  });

  it("keeps the five best places of an entity and counts the rest", async () => {
    // Five more topics, each holding one note of the entity: the list keeps four beyond the first.
    const extra = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const noteId = randomUUID();
        await note(noteId, `Extra ${index}`);
        await mention(noteId, w.entity);
        return noteId;
      })
    );
    const [tree] = (
      await pool.query<{ id: string }>("select id from topic_trees where status = 'active'")
    ).rows;
    const topics = extra.map(() => randomUUID());
    await pool.query(
      `insert into topics (id, tree_id, role, parent_id, title, name_state, name_source, name_language, management)
       select t.id, $1, 'topic', $2, 'Extra ' || t.n, 'named', 'llm', 'en', 'human'
         from unnest($3::uuid[]) with ordinality as t(id, n)`,
      [tree!.id, rootId, topics]
    );
    for (const [index, noteId] of extra.entries())
      await pool.query(
        `insert into topic_placements (tree_id, topic_id, item_kind, note_id, rank, role, decided_by)
         values ($1, $2, 'note', $3, 0, 'primary', 'build')`,
        [tree!.id, topics[index], noteId]
      );
    const located = await locate.locateEntity(w.entity);
    expect(located!.alsoIn).toHaveLength(4);
    expect(located!.primaryPath.at(-2)?.title).toBe("Sleep");
    // Eight topics hold its notes (Sleep, Focus, Memory and the five new ones): seven are "also in",
    // four of them listed, in title order (the titles run Extra 1 to Extra 5, before Focus and Memory).
    expect(located!.counts.alsoIn).toBe(7);
    expect(located!.counts.notes).toBe(10);
    expect(titles(located!.alsoIn)).toEqual(["Extra 1", "Extra 2", "Extra 3", "Extra 4"]);
  });
});
