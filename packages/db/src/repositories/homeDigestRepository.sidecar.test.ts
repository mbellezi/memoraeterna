import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import { formatObjectAddress } from "@app/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createChangeSetRepository } from "./changeSetRepository.js";
import { createHomeDigestRepository, homeDigestLimits } from "./homeDigestRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";
import { createViewHistoryRepository } from "./viewHistoryRepository.js";

// Home's digest on a real PostgreSQL (F5 T130, D9): the empty library, a null `since`, what
// arrived before and after `since` (sources, notes, placed and unplaced), the Gardener's changes
// around `since`, the Inbox's first rows, the last questions, the trail and the Shape strip.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const hourMs = 60 * 60 * 1000;

describe.skipIf(!sidecarInstalled)("home digest on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let home: ReturnType<typeof createHomeDigestRepository>;

  const now = new Date();
  const ago = (hours: number) => new Date(now.getTime() - hours * hourMs);
  const since = ago(48);

  const id = {
    s1: randomUUID(),
    s1chapter: randomUUID(),
    s2: randomUUID(),
    sOld: randomUUID(),
    n1: randomUUID(),
    n2: randomUUID(),
    nOld: randomUUID(),
    nSuperseded: randomUUID(),
    science: randomUUID(),
    biology: randomUUID(),
    sleep: randomUUID(),
    art: randomUUID(),
    ghostTopic: randomUUID()
  };

  async function source(sourceId: string, title: string, createdAt: Date, parent?: string) {
    await pool.query(
      `insert into source_items (id, type, title, parent_source_item_id, language, content_hash, created_at, updated_at)
       values ($1, 'Book', $2, $3, 'en', $4, $5, $5)`,
      [sourceId, title, parent ?? null, `content-${sourceId}`, createdAt]
    );
  }

  async function note(
    noteId: string,
    title: string,
    sourceId: string,
    chunkId: string,
    createdAt: Date,
    superseded = false
  ) {
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
         ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
         generation_provider, generation_model, generation_runtime, generation_prompt_version,
         generation_key, language, created_at, updated_at)
       values ($1, $2, $3, $4, 'active', $5, 'source', $6, $6, $7, 'seed', 'seed', 'local', 'seed', $1::uuid::text, 'en', $8, $8)`,
      [
        noteId,
        title,
        `${title} body.`,
        `${title} idea.`,
        superseded ? "superseded" : "current",
        sourceId,
        chunkId,
        createdAt
      ]
    );
  }

  async function passage(sourceId: string) {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Doc', 'seed', $3)`,
      [documentId, sourceId, `doc-${documentId}`]
    );
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'A passage.', $4)`,
      [chunkId, documentId, sourceId, `hash-${chunkId}`]
    );
    return chunkId;
  }

  let treeId = "";
  let generation = 100;

  /** A change-set of the topic engine; an applied one has a generation and an apply time. */
  async function changeSet(input: {
    origin: string;
    status: "applied" | "pending_review" | "dismissed";
    risk: "low" | "medium" | "high";
    createdAt: Date;
  }) {
    const applied = input.status === "applied";
    const result = await pool.query<{ id: string }>(
      `insert into topic_change_sets (tree_id, origin, status, title_key, risk, generation, created_at, applied_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        treeId,
        input.origin,
        input.status,
        `topics.changeSets.${input.origin}`,
        input.risk,
        applied ? (generation += 1) : null,
        input.createdAt,
        applied ? input.createdAt : null
      ]
    );
    return result.rows[0]!.id;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-home-digest-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_home_digest_test",
        user: "memora_home_digest_test",
        password: `home-digest-${randomUUID()}`,
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
    home = createHomeDigestRepository(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // The empty library runs first: the world below is seeded by the next test.
  it("reads an empty library: first run, nothing anywhere, no tree", async () => {
    const digest = await home.digest({ since, now });
    expect(digest.firstRun).toBe(true);
    expect(digest.since).toEqual(since);
    expect(digest.continue).toEqual([]);
    expect(digest.new.sources).toEqual({ total: 0, items: [] });
    expect(digest.new.notes).toEqual({ total: 0, placed: 0, unplaced: 0, items: [] });
    expect(digest.inbox).toEqual({ total: 0, top: [] });
    expect(digest.questions).toEqual([]);
    expect(digest.growth).toEqual([]);
    expect(digest.gardener).toEqual({ count: 0, top: [] });
    expect(digest.shape.hasTree).toBe(false);
    expect(digest.shape).toMatchObject({ notes: 0, topics: 0, depth: 0, roots: [] });
  });

  describe("with a library", () => {
    beforeAll(async () => {
      // Sources: two arrivals after `since`, a chapter (never an arrival), and an old source.
      await source(id.sOld, "Old book", ago(240));
      await source(id.s1, "Sleep", ago(30));
      await source(id.s1chapter, "Sleep, chapter 1", ago(29), id.s1);
      await source(id.s2, "Memory", ago(2));
      const [c1, c2, cOld] = await Promise.all([passage(id.s1), passage(id.s2), passage(id.sOld)]);
      await note(id.nOld, "Old note", id.sOld, cOld, ago(200));
      await note(id.n1, "Naps", id.s1, c1, ago(20));
      await note(id.n2, "Consolidation", id.s2, c2, ago(1));
      await note(id.nSuperseded, "Old naps", id.s1, c1, ago(10), true);

      // The tree: Science > Biology > Sleep, and Art. Naps sleep, the old note is in Art; the new
      // Consolidation note has no place yet.
      const trees = createTopicTreeRepository(pool);
      const rootId = randomUUID();
      const tree = await trees.createTree({
        id: randomUUID(),
        rootId,
        spaceKey: "test:home:256",
        embeddingProvider: "test",
        embeddingModel: "test",
        embeddingRuntime: "none",
        dimensions: 256,
        config: {},
        configHash: "test",
        seed: 1
      });
      treeId = tree.id;
      const named = (topicId: string, parent: string, title: string) =>
        topicRecord(topicId, parent, {
          role: "topic",
          title,
          nameState: "named" as const,
          nameSource: "llm" as const,
          nameLanguage: "en"
        });
      await trees.bootstrapSnapshot({
        treeId: tree.id,
        expectedGeneration: tree.generation,
        titleKey: "topics.changeSets.build",
        topics: [
          named(id.science, rootId, "Science"),
          named(id.biology, id.science, "Biology"),
          named(id.sleep, id.biology, "Sleep"),
          named(id.art, rootId, "Art")
        ],
        placements: [
          { item: itemKey("note", id.n1), placement: placementRecord(id.sleep) },
          { item: itemKey("note", id.nOld), placement: placementRecord(id.art) },
          { item: itemKey("source", id.s1), placement: placementRecord(id.biology) }
        ]
      });
      // The build is older than `since`, so it is not the Gardener's work of this digest.
      await pool.query(
        "update topic_change_sets set created_at = $2, applied_at = $2 where tree_id = $1",
        [tree.id, ago(500)]
      );
      // Shape health: Art is out of bounds (one hard violation); Science needs attention (one soft
      // violation, and a proposed repair that waits for approval, which is not counted).
      await pool.query(
        `update topic_stats set health = 'violation', violations = $2::jsonb where topic_id = $1`,
        [id.art, JSON.stringify([{ code: "size", reason: "too-big", severity: "hard" }])]
      );
      await pool.query(
        `update topic_stats set health = 'attention', violations = $2::jsonb where topic_id = $1`,
        [
          id.science,
          JSON.stringify([
            { code: "depth", reason: "too-deep", severity: "soft" },
            { code: "size", reason: "split-proposed", severity: "soft", awaitingApproval: true }
          ])
        ]
      );

      // The Gardener: counted are applied or proposed change-sets after `since`, left out are
      // earlier ones, the owner's own (`human`) and dismissed ones.
      await changeSet({ origin: "rebalance", status: "applied", risk: "high", createdAt: ago(40) });
      await changeSet({ origin: "audit", status: "applied", risk: "medium", createdAt: ago(30) });
      await changeSet({ origin: "naming", status: "applied", risk: "low", createdAt: ago(5) });
      await changeSet({ origin: "place", status: "applied", risk: "low", createdAt: ago(3) });
      await changeSet({ origin: "rebalance", status: "applied", risk: "high", createdAt: ago(60) });
      await changeSet({ origin: "human", status: "applied", risk: "high", createdAt: ago(4) });
      await changeSet({ origin: "audit", status: "dismissed", risk: "high", createdAt: ago(4) });
      // A proposal that waits for the owner is Gardener work and an Inbox row.
      await changeSet({
        origin: "rebalance",
        status: "pending_review",
        risk: "medium",
        createdAt: ago(6)
      });

      // Growth: two arriving notes in Sleep and one in Biology within the week, by 'place' events.
      const placeSet = await changeSet({
        origin: "place",
        status: "applied",
        risk: "low",
        createdAt: ago(24)
      });
      const arrival = (seq: number, topicId: string, itemId: string) =>
        pool.query(
          `insert into topic_structure_events (change_set_id, seq, op, topic_id, item_kind, item_id, after)
           values ($1, $2, 'item.place', $3, 'note', $4, $5::jsonb)`,
          [placeSet, seq, topicId, itemId, JSON.stringify({ topicId, rank: 0 })]
        );
      await arrival(0, id.sleep, id.n1);
      await arrival(1, id.sleep, id.n2);
      await arrival(2, id.biology, randomUUID());

      // The Inbox: a high backlog item, a medium proposal (above) and a medium duplicate.
      const finding = (kind: string, risk: string, createdAt: Date) =>
        pool.query(
          `insert into gardener_findings (kind, fingerprint, risk, created_at) values ($1, $2, $3, $4)`,
          [kind, `fp-${randomUUID()}`, risk, createdAt]
        );
      await finding("backlog", "high", ago(9));
      await finding("duplicate", "medium", ago(2));
      await finding("budget", "low", ago(1));

      // Questions: four, the last three are listed, one has an answer.
      const question = async (text: string, scope: unknown, createdAt: Date) =>
        (
          await pool.query<{ id: string }>(
            `insert into questions (text, scope, privacy, mode, status, created_at, updated_at)
             values ($1, $2::jsonb, 'offline_only', 'text', 'complete', $3, $3) returning id`,
            [text, JSON.stringify(scope), createdAt]
          )
        ).rows[0]!.id;
      await question("Oldest question?", { kind: "library" }, ago(100));
      await question("Second?", { kind: "topic", topicId: id.sleep }, ago(50));
      const withAnswer = await question("Third?", { kind: "sources", sourceIds: [id.s1] }, ago(10));
      await question("Latest?", { kind: "library" }, ago(1));
      await pool.query(
        `insert into question_answers (question_id, version, paragraphs, provenance, status, started_at)
         values ($1, 1, '[]'::jsonb, '{}'::jsonb, 'complete', now())`,
        [withAnswer]
      );

      // The trail: nine opens, the oldest pinned; the last is a topic that does not exist.
      const history = createViewHistoryRepository(pool);
      const opens: Array<{ kind: "source" | "note" | "topic"; objectId: string; title: string }> = [
        { kind: "source", objectId: id.sOld, title: "Old book" },
        { kind: "source", objectId: id.s1, title: "Sleep" },
        { kind: "note", objectId: id.n1, title: "Naps" },
        { kind: "source", objectId: id.s2, title: "Memory" },
        { kind: "note", objectId: id.n2, title: "Consolidation" },
        { kind: "topic", objectId: id.sleep, title: "Sleep" },
        { kind: "topic", objectId: id.biology, title: "Biology" },
        { kind: "topic", objectId: id.science, title: "Science" },
        { kind: "topic", objectId: id.ghostTopic, title: "A topic that went away" }
      ];
      for (const open of opens) await history.record(open);
      await history.setPinned(formatObjectAddress({ kind: "source", id: id.sOld }), true);
    }, 60_000);

    it("lists the six latest opens by time, a pin among them only when it is one of the six", async () => {
      const { continue: trail } = await home.digest({ since, now });
      expect(trail).toHaveLength(homeDigestLimits.continue);
      expect(trail.map((entry) => entry.address)).toEqual(
        [id.ghostTopic, id.science, id.biology, id.sleep, id.n2, id.s2].map((objectId, index) =>
          formatObjectAddress({
            kind: index < 4 ? "topic" : index === 4 ? "note" : "source",
            id: objectId
          })
        )
      );
      // Each carries the summary of its object; a topic that went away keeps the title it had.
      expect(trail[1]).toMatchObject({
        title: "Science",
        summary: { kind: "topic", title: "Science" }
      });
      expect(trail[0]).toMatchObject({ title: "A topic that went away" });
      expect(trail[0]?.summary).toBeNull();
    });

    it("counts the arrivals after `since`: root sources, current notes, placed and not", async () => {
      const { new: arrived } = await home.digest({ since, now });
      // Sleep (30 h ago) and Memory (2 h ago) arrived; the chapter and the old book did not.
      expect(arrived.sources.total).toBe(2);
      expect(arrived.sources.items.map((item) => item.object.title)).toEqual(["Memory", "Sleep"]);
      // Naps (placed) and Consolidation (no place): the superseded and the old note do not count.
      expect(arrived.notes).toMatchObject({ total: 2, placed: 1, unplaced: 1 });
      expect(arrived.notes.items.map((item) => item.object.title)).toEqual([
        "Consolidation",
        "Naps"
      ]);
      // A listed arrival says where it is: Naps is in Science > Biology > Sleep.
      expect(arrived.notes.items[1]?.object.path?.map((segment) => segment.title)).toEqual([
        "Science",
        "Biology",
        "Sleep"
      ]);
    });

    it("counts nothing older than `since`, and a later `since` counts less", async () => {
      const later = await home.digest({ since: ago(10), now });
      expect(later.new.sources.total).toBe(1);
      expect(later.new.notes).toMatchObject({ total: 1, placed: 0, unplaced: 1 });
      const future = await home.digest({ since: new Date(now.getTime() + hourMs), now });
      expect(future.new.sources.total).toBe(0);
      expect(future.new.notes).toMatchObject({ total: 0, placed: 0, unplaced: 0 });
      expect(future.gardener.count).toBe(0);
    });

    it("looks back seven days when `since` is null", async () => {
      const digest = await home.digest({ since: null, now });
      expect(digest.since).toEqual(new Date(now.getTime() - 7 * 24 * hourMs));
      expect(digest.new.sources.total).toBe(2);
      expect(digest.new.notes.total).toBe(2);
      expect(digest.firstRun).toBe(false);
    });

    it("counts the Gardener's changes applied or proposed after `since`, the top three by risk then recency", async () => {
      const { gardener } = await home.digest({ since, now });
      // rebalance (high, 40 h), audit (medium, 30 h), naming (low, 5 h), place (low, 3 h), the
      // proposal (medium, 6 h) and the placing set of the week (low, 24 h): six. Not counted: the
      // one from 60 h ago, the owner's, the dismissed one and the build.
      expect(gardener.count).toBe(6);
      expect(gardener.top.map((change) => [change.risk, change.origin])).toEqual([
        ["high", "rebalance"],
        ["medium", "rebalance"],
        ["medium", "audit"]
      ]);
      expect(gardener.top[1]).toMatchObject({ status: "pending_review", kind: "topic" });

      // Only the later ones count when `since` moves forward.
      const recent = await home.digest({ since: ago(10), now });
      expect(recent.gardener.count).toBe(3);
      expect(recent.gardener.top.map((change) => change.origin)).toEqual([
        "rebalance",
        "place",
        "naming"
      ]);
    });

    it("totals the Inbox and lists its top three by risk then age", async () => {
      const { inbox } = await home.digest({ since, now });
      expect(inbox.total).toBe(4);
      expect(inbox.top.map((row) => [row.kind, row.risk])).toEqual([
        ["backlog", "high"],
        ["review", "medium"],
        ["duplicate", "medium"]
      ]);
    });

    it("lists the last three questions, newest first, with scope and answer count", async () => {
      const { questions } = await home.digest({ since, now });
      expect(questions.map((question) => question.text)).toEqual(["Latest?", "Third?", "Second?"]);
      expect(questions[1]).toMatchObject({
        scope: { kind: "sources", sourceIds: [id.s1] },
        answerCount: 1,
        status: "complete"
      });
      expect(questions[2]?.scope).toEqual({ kind: "topic", topicId: id.sleep });
    });

    it("names the topics that received notes this week", async () => {
      const { growth, shape } = await home.digest({ since, now });
      expect(growth).toEqual([
        { id: id.sleep, title: "Sleep", arrivals: 2 },
        { id: id.biology, title: "Biology", arrivals: 1 }
      ]);
      expect(shape.arrivalsThisWeek).toBe(3);
    });

    it("reads the shape: notes, topics, depth, violations and one segment per top-level topic", async () => {
      const { shape } = await home.digest({ since, now });
      expect(shape).toMatchObject({
        hasTree: true,
        notes: 2,
        topics: 4,
        depth: 3,
        violations: { hard: 1, soft: 1 },
        outOfBounds: 1
      });
      expect(shape.roots).toEqual([
        { id: id.art, title: "Art", notes: 1, topics: 1, health: "violation" },
        { id: id.science, title: "Science", notes: 1, topics: 3, health: "attention" }
      ]);
    });

    it("reads every part from one repeatable-read snapshot on one connection", async () => {
      const connect = vi.spyOn(pool, "connect");
      const query = vi.spyOn(pool, "query");
      try {
        await home.digest({ since, now });
        expect(connect).toHaveBeenCalledTimes(1);
        expect(query).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
        query.mockRestore();
      }
    });

    it("reads only: nothing is written by a digest", async () => {
      const count = async () =>
        Number(
          (
            await pool.query<{ n: string }>(
              `select (select count(*) from view_history) + (select count(*) from topic_change_sets)
                      + (select count(*) from questions) + (select count(*) from gardener_findings) as n`
            )
          ).rows[0]!.n
        );
      const before = await count();
      await home.digest({ since, now });
      expect(await count()).toBe(before);
    });

    it("reports a Gardener row's undo as changes.list does, blocked by a later change-set", async () => {
      const first = await changeSet({
        origin: "rebalance",
        status: "applied",
        risk: "high",
        createdAt: ago(10)
      });
      const later = await changeSet({
        origin: "audit",
        status: "applied",
        risk: "low",
        createdAt: ago(5)
      });
      for (const changeSetId of [first, later])
        await pool.query(
          `insert into topic_structure_events (change_set_id, seq, op, topic_id, ref_topic_ids, before, after)
           values ($1, 0, 'topic.rename', $2, $3::uuid[], '{}'::jsonb, '{}'::jsonb)`,
          [changeSetId, id.sleep, [id.sleep]]
        );
      const stated = await createChangeSetRepository(pool).get("topic", first);
      expect(stated?.undo).toBe("blocked");
      const { gardener } = await home.digest({ since, now });
      expect(gardener.top.find((change) => change.id === first)).toEqual(stated);
    });

    it("counts a proposal made before `since` as nothing new, whatever store proposed it", async () => {
      const base = (await home.digest({ since, now })).gardener.count;
      const overview = (createdAt: Date) =>
        pool.query(
          `insert into topic_overview_versions (topic_id, origin, status, title_key, risk, base_version, proposed, created_at)
           values ($1, 'rewrite', 'pending_review', 'topics.overview.rewrite', 'high', 0, '{}'::jsonb, $2)`,
          [id.sleep, createdAt]
        );
      // Old proposals, of the topic engine and of the overview store: not new work.
      await changeSet({
        origin: "rebalance",
        status: "pending_review",
        risk: "high",
        createdAt: ago(100)
      });
      await overview(ago(100));
      expect((await home.digest({ since, now })).gardener.count).toBe(base);
      // A proposal after `since` is.
      await overview(ago(2));
      const after = await home.digest({ since, now });
      expect(after.gardener.count).toBe(base + 1);
      expect(after.gardener.top.some((change) => change.kind === "overview")).toBe(true);
    });
  });
});
