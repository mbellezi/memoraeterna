import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import {
  decodeBacklinkCursor,
  encodeBacklinkCursor,
  formatObjectAddress,
  type ObjectAddress,
  type ObjectBacklink
} from "@app/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { shownNoteRelationSql } from "./note-relation-sql.js";
import { createObjectReadRepository } from "./objectReadRepository.js";
import { createQuestionRepository } from "./questionRepository.js";
import { createTopicOverviewRepository } from "./topicOverviewRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// The objects read layer on a real PostgreSQL (F5 T118, D11): `resolve` (get and resolveMany) for
// each of the five kinds, anchored previews, statuses and redirects, paths, and every arm of
// `backlinks` with its keyset paging.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const at = (kind: ObjectAddress["kind"], id: string, anchor?: ObjectAddress["anchor"]) =>
  formatObjectAddress({ kind, id, ...(anchor ? { anchor } : {}) });

describe.skipIf(!sidecarInstalled)("objects read layer on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let objects: ReturnType<typeof createObjectReadRepository>;

  // Ids of the main world, filled by beforeAll.
  const topic = {
    science: randomUUID(),
    biology: randomUUID(),
    sleep: randomUUID(),
    rest: randomUUID(),
    old: randomUUID(),
    nap: randomUUID(),
    broken: randomUUID(),
    unnamed: randomUUID(),
    /** A live-looking topic of a retired tree (an old tree's topics keep `retired_at` null). */
    stale: randomUUID()
  };
  const w = {
    s1: randomUUID(),
    s1chapter: randomUUID(),
    s2: randomUUID(),
    d1: randomUUID(),
    d2: randomUUID(),
    c1: randomUUID(),
    c2: randomUUID(),
    c3: randomUUID(),
    span1: randomUUID(),
    n1: randomUUID(),
    n2: randomUUID(),
    n3: randomUUID(),
    entity: randomUUID(),
    emptyEntity: randomUUID(),
    q1: "",
    q2: ""
  };

  const noteSql = `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
       supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
       evidence_chunk_id, generation_provider, generation_model, generation_runtime,
       generation_prompt_version, generation_key, language)
     values ($1::uuid, $2, $3, $4, 'active', $5, 'source', $6, $6, $7, 'seed', 'seed', 'local', 'seed', $1::uuid::text, $8)`;

  async function source(
    id: string,
    title: string,
    extra: { summary?: string; parent?: string } = {}
  ) {
    await pool.query(
      `insert into source_items (id, type, title, summary, parent_source_item_id, language, content_hash)
       values ($1, 'Book', $2, $3, $4, 'en', $5)`,
      [id, title, extra.summary ?? null, extra.parent ?? null, `content-${id}`]
    );
  }
  async function document(id: string, sourceId: string) {
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Doc', 'seed', $3)`,
      [id, sourceId, `doc-${id}`]
    );
  }
  async function chunk(
    id: string,
    documentId: string,
    sourceId: string,
    index: number,
    content: string,
    spanId?: string
  ) {
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash, source_span_id)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [id, documentId, sourceId, index, content, `hash-${id}`, spanId ?? null]
    );
  }
  async function note(
    id: string,
    title: string,
    body: string,
    sourceId: string,
    chunkId: string,
    options: { superseded?: boolean; idea?: string } = {}
  ) {
    await pool.query(noteSql, [
      id,
      title,
      body,
      options.idea ?? `${title} idea.`,
      options.superseded ? "superseded" : "current",
      sourceId,
      chunkId,
      "en"
    ]);
    await pool.query(
      `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id) values ($1, $2, $3)`,
      [id, sourceId, chunkId]
    );
  }
  async function relate(
    from: string,
    to: string,
    kind: "applied" | "suggested" | "withdrawn" | "removed"
  ) {
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const row = await pool.query<{ id: string }>(
      `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
         direction, band, probability, final_score, explanation, status, vetoed_at, veto_source, matching_model)
       values ($1, $2, 'same_as', 'symmetric', $3, 0.5, 0.5, $4, $5, $6, $7, 'seed') returning id`,
      [
        lo,
        hi,
        kind === "suggested" ? "suggest" : "apply",
        `Why ${kind}: they **share** an idea.`,
        kind === "removed" ? "rejected" : "pending_review",
        kind === "withdrawn" ? new Date() : null,
        kind === "withdrawn" ? "explainer" : null
      ]
    );
    return row.rows[0]!.id;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-object-read-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_object_read_test",
        user: "memora_object_read_test",
        password: `object-read-${randomUUID()}`,
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
    objects = createObjectReadRepository(pool);

    // Sources, passages and notes.
    await source(w.s1, "Sleep", { summary: "Sleep **restores** the [body](https://example.com)." });
    await source(w.s1chapter, "Sleep, chapter 1", { parent: w.s1 });
    await source(w.s2, "Memory");
    await document(w.d1, w.s1);
    await document(w.d2, w.s2);
    await pool.query(
      `insert into source_spans (id, document_id, source_item_id, start_offset, end_offset)
       values ($1, $2, $3, 0, 30)`,
      [w.span1, w.d1, w.s1]
    );
    await chunk(w.c1, w.d1, w.s1, 0, "Naps restore focus in the afternoon.", w.span1);
    await chunk(w.c2, w.d1, w.s1, 1, "A second passage about sleep debt.");
    await chunk(w.c3, w.d2, w.s2, 0, "Memories consolidate during sleep.");
    await note(
      w.n1,
      "Naps",
      "# Naps\n\nShort **naps** restore [focus](https://example.com) and `mood`.\n\n- one\n- two",
      w.s1,
      w.c1
    );
    await pool.query(
      `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id) values ($1, $2, $3)`,
      [w.n1, w.s1, w.c2]
    );
    await note(w.n2, "Consolidation", "", w.s2, w.c3, { idea: "Memories consolidate." });
    await note(w.n3, "Old naps", "Superseded body.", w.s1, w.c1, { superseded: true });

    // Entities.
    await pool.query(
      `insert into entities (id, type, canonical_name, normalized_name, description, confidence, language)
       values ($1, 'concept', 'Circadian rhythm', 'circadian rhythm', 'The body clock.', 0.9, 'en'),
              ($2, 'concept', 'Orphan', 'orphan', null, 0.9, 'und')`,
      [w.entity, w.emptyEntity]
    );
    for (const id of [w.n1, w.n2, w.n3])
      await pool.query(
        `insert into atomic_note_entity_links (atomic_note_id, entity_id, confidence) values ($1, $2, 0.8)`,
        [id, w.entity]
      );

    // The topic tree: Science > Biology > Sleep, and four retired topics under Science.
    const trees = createTopicTreeRepository(pool);
    const rootId = randomUUID();
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:objects:256",
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
    await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        named(topic.science, rootId, "Science"),
        named(topic.biology, topic.science, "Biology", {
          description: "The study of living things."
        }),
        named(topic.sleep, topic.biology, "Sleep"),
        named(topic.rest, topic.science, "Rest"),
        named(topic.old, topic.science, "Old"),
        named(topic.nap, topic.science, "Nap"),
        named(topic.broken, topic.science, "Broken"),
        named(topic.unnamed, topic.science, null)
      ],
      placements: [
        { item: itemKey("note", w.n1), placement: placementRecord(topic.sleep) },
        { item: itemKey("note", w.n1), placement: placementRecord(topic.biology, { rank: 1 }) },
        { item: itemKey("note", w.n2), placement: placementRecord(topic.science) },
        { item: itemKey("source", w.s1), placement: placementRecord(topic.biology) }
      ]
    });
    // Retire: Rest -> Sleep; Nap -> Rest (a chain); Broken -> Old, and Old has no successor.
    const retire = (id: string, to: string | null) =>
      pool.query("update topics set retired_at = now(), redirect_to = $2 where id = $1", [id, to]);
    await retire(topic.rest, topic.sleep);
    await retire(topic.old, null);
    await retire(topic.nap, topic.rest);
    await retire(topic.broken, topic.old);

    // Overviews: Science has a lead and no description; Sleep cites the note, a passage and a span.
    const overviews = createTopicOverviewRepository(pool);
    const overview = (
      topicId: string,
      text: string,
      citations: Parameters<typeof overviews.write>[0]["citations"]
    ) =>
      overviews.write({
        topicId,
        paragraphs: [
          { text, citations: citations.map((citation) => citation.n) },
          { text: "A second paragraph.", citations: [] }
        ],
        evidence: [],
        memberFingerprint: "members",
        memberCount: 1,
        inputHash: "input",
        promptRevisionId: "topic.overview@test",
        provider: "test",
        model: "test",
        runtime: "none",
        aiTaskRunId: null,
        language: "en",
        support: { status: "unchecked", unsupported: [] },
        divergences: [],
        citations
      });
    await overview(topic.science, "Science covers the natural world.", []);
    await overview(topic.sleep, "Naps help [1].", [
      {
        n: 1,
        chunkId: w.c2,
        sourceSpanId: null,
        noteId: w.n1,
        excerpt: "Naps restore focus.",
        excerptHash: hash("Naps restore focus.")
      },
      {
        n: 2,
        chunkId: null,
        sourceSpanId: w.span1,
        noteId: null,
        excerpt: "The afternoon span.",
        excerptHash: hash("The afternoon span.")
      }
    ]);

    // A retired tree keeps its topics and their overviews: its topic cites Naps too.
    const oldTree = randomUUID();
    const oldRoot = randomUUID();
    await pool.query(
      `insert into topic_trees (id, status, space_key, embedding_provider, embedding_model,
         embedding_runtime, dimensions, config, config_hash, seed, activated_at, retired_at)
       values ($1, 'retired', 'test:objects:old', 'test', 'test', 'none', 256, '{}', 'old', 1, now(), now())`,
      [oldTree]
    );
    await pool.query(
      `insert into topics (id, tree_id, role, parent_id, title, name_state, name_source, name_language, management)
       values ($1, $3, 'root', null, null, 'unnamed', null, null, 'human'),
              ($2, $3, 'topic', $1, 'Stale sleep', 'named', 'llm', 'en', 'human')`,
      [oldRoot, topic.stale, oldTree]
    );
    await overview(topic.stale, "Old tree lead [1, 2].", [
      {
        n: 1,
        chunkId: w.c2,
        sourceSpanId: null,
        noteId: w.n1,
        excerpt: "Stale citation.",
        excerptHash: hash("Stale citation.")
      }
    ]);

    // Source relations between Sleep and Memory: one visible, one removed.
    const sourceRelation = async (
      key: string,
      to: string,
      status: string,
      explanation: string | null
    ) => {
      const id = randomUUID();
      await pool.query(
        `insert into source_relations (id, source_item_id, target_source_item_id, identity_key,
           relation_type, source_idea, target_idea, explanation, importance, confidence, status)
         values ($1, $2, $3, $4, 'supports', 'An idea', 'Another idea', $5, 0.9, 0.9, $6)`,
        [id, w.s1, to, key, explanation, status]
      );
      await pool.query(
        `insert into source_relation_evidence (relation_id, evidence_key, origin, source_chunk_id,
           target_chunk_id, snapshot)
         values ($1, 'evidence', 'source_analysis', $2, $3, $4)`,
        [id, w.c1, w.c3, { sourceHash: `hash-${w.c1}`, targetHash: `hash-${w.c3}` }]
      );
      return id;
    };
    sourceRelationId = await sourceRelation(
      "sr-visible",
      w.s2,
      "pending_review",
      "Sleep **supports** memory."
    );
    await sourceRelation("sr-removed", w.s2, "rejected", "Removed.");

    // Note relations of Naps: applied (to Consolidation), suggested, withdrawn, removed and one
    // to a superseded note, which is no endpoint.
    const others = await Promise.all(
      ["a", "b", "c", "d"].map(async (title) => {
        const id = randomUUID();
        await note(id, `Other ${title}`, `Other ${title} body.`, w.s2, w.c3);
        return id;
      })
    );
    relationIds.applied = await relate(w.n1, w.n2, "applied");
    relationIds.suggested = await relate(w.n1, others[0]!, "suggested");
    await relate(w.n1, others[1]!, "withdrawn");
    await relate(w.n1, others[2]!, "removed");
    await relate(w.n1, w.n3, "applied");

    // Questions citing everything, in two versions of one and one version of the other.
    const questions = createQuestionRepository(pool);
    const first = await questions.create({
      text: "Do naps help?",
      privacy: "offline_only",
      mode: "text"
    });
    const second = await questions.create({
      text: "What is **sleep** debt?",
      privacy: "offline_only",
      mode: "text"
    });
    w.q1 = first.id;
    w.q2 = second.id;
    const answer = (
      cited: Array<{ kind: "note" | "source" | "topic" | "chunk"; targetId: string }>
    ) => ({
      paragraphs: [{ markdown: "Naps help [1].", citations: cited.map((_, index) => index + 1) }],
      citations: cited.map((citation, index) => ({ ordinal: index + 1, ...citation })),
      provenance: { provider: "test" },
      status: "complete" as const,
      startedAt: new Date("2026-11-11T10:00:00.000Z"),
      completedAt: new Date("2026-11-11T10:00:01.000Z")
    });
    await questions.appendAnswer(first.id, answer([{ kind: "note", targetId: w.n1 }]));
    await questions.appendAnswer(
      first.id,
      answer([
        { kind: "note", targetId: w.n1 },
        { kind: "source", targetId: w.s1 },
        { kind: "chunk", targetId: w.c2 },
        { kind: "topic", targetId: topic.sleep }
      ])
    );
    await questions.appendAnswer(second.id, answer([{ kind: "chunk", targetId: w.c1 }]));
  }, 240_000);

  let sourceRelationId = "";
  const relationIds = { applied: "", suggested: "" };

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  const resolve1 = async (address: ObjectAddress, path = false) => {
    const found = await objects.resolve([address], { path });
    return found.get(formatObjectAddress(address));
  };

  /** All pages of a target's backlinks, `size` per page. */
  async function allBacklinks(target: ObjectAddress, size = 50) {
    const items: ObjectBacklink[] = [];
    const pages: number[] = [];
    let cursor;
    do {
      const page = await objects.backlinks({ target, limit: size, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      pages.push(page.items.length);
      cursor = page.next;
    } while (cursor);
    return { items, pages };
  }

  describe("resolve", () => {
    it("summarises a source: its summary as plain text, its counts and no path unless asked", async () => {
      const summary = await resolve1({ kind: "source", id: w.s1 });
      expect(summary).toMatchObject({
        address: at("source", w.s1),
        kind: "source",
        title: "Sleep",
        status: "current",
        preview: "Sleep restores the body.",
        language: "en",
        counts: { notes: 1, passages: 2 }
      });
      expect(summary).not.toHaveProperty("path");
      expect(Date.parse(summary!.updatedAt)).not.toBeNaN();
    });

    it("summarises a note: its body without Markdown, and its idea when the body is empty", async () => {
      expect(await resolve1({ kind: "note", id: w.n1 })).toMatchObject({
        title: "Naps",
        status: "current",
        preview: "Naps Short naps restore focus and mood. one two",
        // Two passages of one source are one source.
        counts: { sources: 1 }
      });
      expect((await resolve1({ kind: "note", id: w.n2 }))?.preview).toBe("Memories consolidate.");
    });

    it("marks a superseded note retired", async () => {
      expect((await resolve1({ kind: "note", id: w.n3 }))?.status).toBe("retired");
    });

    it("summarises a topic: its description, else the lead of its overview, with the tree's counts", async () => {
      expect(await resolve1({ kind: "topic", id: topic.biology })).toMatchObject({
        title: "Biology",
        status: "current",
        preview: "The study of living things.",
        language: "en"
      });
      expect((await resolve1({ kind: "topic", id: topic.science }))?.preview).toBe(
        "Science covers the natural world."
      );
      expect((await resolve1({ kind: "topic", id: topic.unnamed }))?.title).toBe("");
      expect((await resolve1({ kind: "topic", id: topic.unnamed }))?.preview).toBe("");
    });

    it("leaves the citation markers of an overview lead out of a topic preview", async () => {
      expect((await resolve1({ kind: "topic", id: topic.sleep }))?.preview).toBe("Naps help.");
      expect((await resolve1({ kind: "topic", id: topic.stale }))?.preview).toBe("Old tree lead.");
    });

    it("marks a topic of a retired tree retired, though its own retired_at is null", async () => {
      expect(await resolve1({ kind: "topic", id: topic.stale })).toMatchObject({
        title: "Stale sleep",
        status: "retired"
      });
      expect((await resolve1({ kind: "topic", id: topic.sleep }))?.status).toBe("current");
    });

    it("summarises an entity and a question", async () => {
      expect(await resolve1({ kind: "entity", id: w.entity })).toMatchObject({
        title: "Circadian rhythm",
        status: "current",
        preview: "The body clock.",
        counts: { notes: 2 }
      });
      const bare = await resolve1({ kind: "entity", id: w.emptyEntity });
      expect(bare?.preview).toBe("");
      expect(bare).not.toHaveProperty("language");
      expect(await resolve1({ kind: "question", id: w.q1 })).toMatchObject({
        title: "Do naps help?",
        preview: "Do naps help?",
        status: "current",
        counts: { answers: 2 }
      });
    });

    it("follows a retired topic's redirects to the live topic, and stays retired when none is left", async () => {
      expect(await resolve1({ kind: "topic", id: topic.rest })).toMatchObject({
        status: "redirected",
        redirectTo: at("topic", topic.sleep)
      });
      // A chain: Nap -> Rest -> Sleep.
      expect(await resolve1({ kind: "topic", id: topic.nap })).toMatchObject({
        status: "redirected",
        redirectTo: at("topic", topic.sleep)
      });
      expect(await resolve1({ kind: "topic", id: topic.old })).toMatchObject({ status: "retired" });
      // Broken -> Old, which is retired with no successor.
      const broken = await resolve1({ kind: "topic", id: topic.broken });
      expect(broken?.status).toBe("retired");
      expect(broken).not.toHaveProperty("redirectTo");
    });

    it("previews the anchored passage or span, and the object when the anchor is not its own", async () => {
      expect(
        (await resolve1({ kind: "source", id: w.s1, anchor: { passage: w.c2 } }))?.preview
      ).toBe("A second passage about sleep debt.");
      // A span previews the passage written from it.
      expect(
        (await resolve1({ kind: "source", id: w.s1, anchor: { span: w.span1 } }))?.preview
      ).toBe("Naps restore focus in the afternoon.");
      // A note previews a passage of its own evidence, and ignores one of another source.
      expect((await resolve1({ kind: "note", id: w.n1, anchor: { passage: w.c2 } }))?.preview).toBe(
        "A second passage about sleep debt."
      );
      expect((await resolve1({ kind: "note", id: w.n1, anchor: { passage: w.c3 } }))?.preview).toBe(
        "Naps Short naps restore focus and mood. one two"
      );
      expect(
        (await resolve1({ kind: "source", id: w.s2, anchor: { passage: w.c1 } }))?.preview
      ).toBe("");
      // A topic previews a passage its overview cites.
      expect(
        (await resolve1({ kind: "topic", id: topic.sleep, anchor: { passage: w.c2 } }))?.preview
      ).toBe("A second passage about sleep debt.");
      expect(
        (await resolve1({ kind: "topic", id: topic.sleep, anchor: { span: w.span1 } }))?.preview
      ).toBe("Naps restore focus in the afternoon.");
      // The anchor stays on the address.
      expect(
        (await resolve1({ kind: "source", id: w.s1, anchor: { passage: w.c2 } }))?.address
      ).toBe(at("source", w.s1, { passage: w.c2 }));
    });

    it("cuts a long preview at 280 characters with an ellipsis and never splits a character", async () => {
      await pool.query(`update source_items set summary = $2 where id = $1`, [
        w.s2,
        `${"é😀 ".repeat(200)}`
      ]);
      const preview = (await resolve1({ kind: "source", id: w.s2 }))?.preview ?? "";
      expect(Array.from(preview).length).toBeLessThanOrEqual(280);
      expect(Array.from(preview).length).toBeGreaterThan(270);
      expect(preview.endsWith("…")).toBe(true);
      await pool.query(`update source_items set summary = null where id = $1`, [w.s2]);
    });

    it("leaves a missing object out of the result", async () => {
      const found = await objects.resolve([
        { kind: "note", id: randomUUID() },
        { kind: "topic", id: randomUUID() },
        { kind: "entity", id: randomUUID() },
        { kind: "question", id: randomUUID() },
        { kind: "source", id: randomUUID() }
      ]);
      expect(found.size).toBe(0);
    });

    it("resolves 200 addresses of mixed kinds in one call, a repeated object once per address", async () => {
      const addresses: ObjectAddress[] = [
        { kind: "source", id: w.s1 },
        { kind: "source", id: w.s1, anchor: { passage: w.c1 } },
        { kind: "note", id: w.n1 },
        { kind: "topic", id: topic.sleep },
        { kind: "entity", id: w.entity },
        { kind: "question", id: w.q2 },
        ...Array.from({ length: 194 }, (): ObjectAddress => ({ kind: "note", id: randomUUID() }))
      ];
      const found = await objects.resolve(addresses);
      expect(found.size).toBe(6);
      expect(found.get(at("source", w.s1))?.preview).not.toBe(
        found.get(at("source", w.s1, { passage: w.c1 }))?.preview
      );
    });

    it("gives the topics above each object, root first and without the untitled root", async () => {
      const topicsOf = async (address: ObjectAddress) =>
        (await resolve1(address, true))?.path?.map((segment) => segment.title);
      expect(await topicsOf({ kind: "note", id: w.n1 })).toEqual(["Science", "Biology", "Sleep"]);
      expect(await topicsOf({ kind: "note", id: w.n2 })).toEqual(["Science"]);
      expect(await topicsOf({ kind: "source", id: w.s1 })).toEqual(["Science", "Biology"]);
      // A chapter is placed through its root source.
      expect(await topicsOf({ kind: "source", id: w.s1chapter })).toEqual(["Science", "Biology"]);
      expect(await topicsOf({ kind: "topic", id: topic.sleep })).toEqual(["Science", "Biology"]);
      expect(await topicsOf({ kind: "topic", id: topic.science })).toEqual([]);
      expect(await topicsOf({ kind: "entity", id: w.entity })).toEqual([]);
      expect(await topicsOf({ kind: "question", id: w.q1 })).toEqual([]);
      // A source the tree does not hold has an empty path, not a missing one.
      expect(await topicsOf({ kind: "source", id: w.s2 })).toEqual([]);
    });
  });

  describe("backlinks", () => {
    it("lists, for a source: the notes on its passages, its visible relations and the questions citing it", async () => {
      const { items } = await allBacklinks({ kind: "source", id: w.s1 });
      const evidence = items.filter((item) => item.via === "evidence");
      expect(evidence.map((item) => item.from)).toEqual(Array(2).fill(at("note", w.n1)));
      expect(evidence.map((item) => item.anchor).sort()).toEqual(
        [`passage=${w.c1}`, `passage=${w.c2}`].sort()
      );
      expect(evidence.every((item) => item.snippet?.length)).toBe(true);
      // The superseded note is no backlink.
      expect(items.some((item) => item.from === at("note", w.n3))).toBe(false);
      expect(items.filter((item) => item.via === "source_relation")).toEqual([
        {
          from: at("source", w.s2),
          via: "source_relation",
          anchor: `relation=${sourceRelationId}`,
          snippet: "Sleep supports memory."
        }
      ]);
      // Q1 cites the source and its passage; Q2 cites another passage of it. Newest question first.
      expect(items.filter((item) => item.via === "question_citation")).toEqual(
        [
          {
            from: at("question", w.q2),
            via: "question_citation",
            anchor: `passage=${w.c1}`,
            snippet: "What is sleep debt?"
          },
          {
            from: at("question", w.q1),
            via: "question_citation",
            anchor: `passage=${w.c2}`,
            snippet: "Do naps help?"
          }
        ].map((expected) => expect.objectContaining(expected))
      );
      // Arms come in the order of the vias.
      expect(items.map((item) => item.via)).toEqual(
        [...items.map((item) => item.via)].sort(
          (a, b) =>
            [
              "evidence",
              "relation",
              "source_relation",
              "overview_citation",
              "question_citation",
              "mention"
            ].indexOf(a) -
            [
              "evidence",
              "relation",
              "source_relation",
              "overview_citation",
              "question_citation",
              "mention"
            ].indexOf(b)
        )
      );
    });

    it("lists, for a note: shown relations only, the topics citing it and the questions citing it", async () => {
      const { items } = await allBacklinks({ kind: "note", id: w.n1 });
      const relations = items.filter((item) => item.via === "relation");
      expect(relations.map((item) => item.from).sort()).toHaveLength(2);
      expect(relations.every((item) => item.anchor === undefined)).toBe(true);
      expect(relations.some((item) => item.from === at("note", w.n2))).toBe(true);
      expect(relations[0]?.snippet).toMatch(/^Why (applied|suggested): they share an idea\.$/);
      expect(items.filter((item) => item.via === "overview_citation")).toEqual([
        { from: at("topic", topic.sleep), via: "overview_citation", snippet: "Naps restore focus." }
      ]);
      // Q1 names the note and cites its other passage; Q2 cites the note's evidence passage only,
      // which is how Ask cites. Locate places a Question by the same notes, so both are listed,
      // newest first, each with the passage it cites.
      expect(items.filter((item) => item.via === "question_citation")).toEqual([
        expect.objectContaining({
          from: at("question", w.q2),
          via: "question_citation",
          anchor: `passage=${w.c1}`
        }),
        expect.objectContaining({
          from: at("question", w.q1),
          via: "question_citation",
          anchor: `passage=${w.c2}`
        })
      ]);
      // The passage a superseded note rests on does not list a Question under that note.
      const old = (await allBacklinks({ kind: "note", id: w.n3 })).items;
      expect(old.some((item) => item.via === "question_citation")).toBe(false);
    });

    it("keeps a topic's backlink position when its overview is rewritten", async () => {
      const sourceId = randomUUID();
      const docId = randomUUID();
      const chunkId = randomUUID();
      const noteId = randomUUID();
      await source(sourceId, "Overview source");
      await document(docId, sourceId);
      await chunk(chunkId, docId, sourceId, 0, "Overview passage.");
      await note(noteId, "Cited note", "Body.", sourceId, chunkId);
      const active = await pool.query<{ id: string }>(
        "select id from topic_trees where status = 'active'"
      );
      const overviews = createTopicOverviewRepository(pool);
      const write = (topicId: string, text: string) =>
        overviews.write({
          topicId,
          paragraphs: [{ text, citations: [1] }],
          evidence: [],
          memberFingerprint: "members",
          memberCount: 1,
          inputHash: text,
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
              chunkId,
              sourceSpanId: null,
              noteId,
              excerpt: "Overview passage.",
              excerptHash: hash("Overview passage.")
            }
          ]
        });
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const id = randomUUID();
        ids.push(id);
        await pool.query(
          `insert into topics (id, tree_id, role, parent_id, title, name_state, name_source, name_language, management)
           values ($1, $2, 'topic', $3, $4, 'named', 'llm', 'en', 'human')`,
          [id, active.rows[0]!.id, topic.science, `Cited by overview ${index}`]
        );
        await write(id, `Lead ${index}.`);
      }
      const address: ObjectAddress = { kind: "note", id: noteId };
      const whole = await objects.backlinks({ target: address, limit: 50 });
      const overviewRows = whole.items.filter((item) => item.via === "overview_citation");
      expect(overviewRows).toHaveLength(5);
      const first = await objects.backlinks({ target: address, limit: 2 });
      // The topic the last page ends with is rewritten while the client holds its cursor.
      const last = overviewRows.at(-1)!.from;
      await write(last.slice("memora://topic/".length), "Lead rewritten.");
      const rest: ObjectBacklink[] = [];
      let cursor = first.next;
      while (cursor) {
        const page = await objects.backlinks({ target: address, limit: 2, cursor });
        rest.push(...page.items);
        cursor = page.next;
      }
      expect([...first.items, ...rest]).toEqual(whole.items);
    });

    it("equals the shown relations of note-relation-sql on the same fixtures", async () => {
      const direct = await pool.query<{ other: string }>(
        `select case when r.source_atomic_note_id = $1::uuid then r.target_atomic_note_id
                     else r.source_atomic_note_id end as other
           from atomic_note_relations r
          where (r.source_atomic_note_id = $1::uuid or r.target_atomic_note_id = $1::uuid)
            and ${shownNoteRelationSql("r")}`,
        [w.n1]
      );
      const { items } = await allBacklinks({ kind: "note", id: w.n1 });
      expect(
        items
          .filter((item) => item.via === "relation")
          .map((item) => item.from)
          .sort()
      ).toEqual(direct.rows.map((row) => at("note", row.other)).sort());
      expect(direct.rows).toHaveLength(2);
    });

    it("lists, for a topic, the questions citing it; for an entity, the current notes mentioning it", async () => {
      expect((await allBacklinks({ kind: "topic", id: topic.sleep })).items).toEqual([
        expect.objectContaining({ from: at("question", w.q1), via: "question_citation" })
      ]);
      const mentions = (await allBacklinks({ kind: "entity", id: w.entity })).items;
      expect(mentions.map((item) => item.from).sort()).toEqual(
        [at("note", w.n1), at("note", w.n2)].sort()
      );
      expect(mentions.every((item) => item.via === "mention")).toBe(true);
    });

    it("has nothing for a question or an object with no links", async () => {
      expect((await allBacklinks({ kind: "question", id: w.q1 })).items).toEqual([]);
      expect((await allBacklinks({ kind: "entity", id: w.emptyEntity })).items).toEqual([]);
      expect((await allBacklinks({ kind: "note", id: randomUUID() })).items).toEqual([]);
    });

    it("pages by keyset across the arms, whole and in order, under inserts", async () => {
      const sourceId = randomUUID();
      const docId = randomUUID();
      const chunkId = randomUUID();
      await source(sourceId, "Paged source");
      await document(docId, sourceId);
      await chunk(chunkId, docId, sourceId, 0, "Paged passage.");
      const noteIds: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const id = randomUUID();
        noteIds.push(id);
        await note(id, `Paged note ${index}`, "Body.", sourceId, chunkId);
      }
      // Two sources related to the paged one, one visible each, through the usual evidence.
      const address: ObjectAddress = { kind: "source", id: sourceId };
      const whole = await objects.backlinks({ target: address, limit: 50 });
      expect(whole.items).toHaveLength(7);
      expect(whole.next).toBeUndefined();

      const first = await objects.backlinks({ target: address, limit: 3 });
      expect(first.items).toHaveLength(3);
      expect(first.next).toBeDefined();
      // Rows created after the first page land before its cursor: the rest does not move.
      for (let index = 0; index < 2; index += 1)
        await note(randomUUID(), `Late note ${index}`, "Body.", sourceId, chunkId);
      const second = await objects.backlinks({ target: address, limit: 3, cursor: first.next! });
      const third = await objects.backlinks({ target: address, limit: 3, cursor: second.next! });
      expect([...first.items, ...second.items, ...third.items]).toEqual(whole.items);
      expect(third.next).toBeUndefined();
      expect(new Set(whole.items.map((item) => `${item.from}${item.anchor}`)).size).toBe(7);
      // The cursor survives encoding.
      const cursor = encodeBacklinkCursor(first.next!);
      expect(decodeBacklinkCursor(cursor)).toEqual(first.next);
    });

    it("keeps an exact page boundary and returns the whole list when paged one row at a time", async () => {
      const whole = await allBacklinks({ kind: "source", id: w.s1 });
      const single = await allBacklinks({ kind: "source", id: w.s1 }, 1);
      expect(single.items).toEqual(whole.items);
      expect(single.pages.every((size) => size === 1)).toBe(true);
      const exact = await allBacklinks({ kind: "source", id: w.s1 }, whole.items.length);
      expect(exact.pages).toEqual([whole.items.length]);
    });

    it("bounds every item: a snippet is at most 160 characters of plain text", async () => {
      const id = randomUUID();
      await note(id, "Long", "Body.", w.s1, w.c1);
      await pool.query(`update chunks set content = $2 where id = $1`, [
        w.c1,
        `**${"long passage ".repeat(60)}**`
      ]);
      const { items } = await allBacklinks({ kind: "source", id: w.s1 });
      expect(items.length).toBeGreaterThan(0);
      for (const item of items)
        expect(Array.from(item.snippet ?? "").length).toBeLessThanOrEqual(160);
      expect(items.some((item) => (item.snippet ?? "").endsWith("…"))).toBe(true);
      expect(items.some((item) => (item.snippet ?? "").includes("*"))).toBe(false);
      await pool.query(
        `update chunks set content = 'Naps restore focus in the afternoon.' where id = $1`,
        [w.c1]
      );
    });
  });
});
