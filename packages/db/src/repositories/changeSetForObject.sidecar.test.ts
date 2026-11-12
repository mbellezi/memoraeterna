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
import { createChangeSetRepository } from "./changeSetRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// `changes.forObject` on a real PostgreSQL (F5 T173, D31): the change-sets that touched one topic,
// note or source, newest first, from the structure events, the overview writes and the relation
// events of the three stores. The F4 read model has no object filter, so this is its own query.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const hourMs = 60 * 60 * 1000;

describe.skipIf(!sidecarInstalled)(
  "the change-sets of one object on a real PostgreSQL database",
  () => {
    let workDir = "";
    let manager: PostgresSidecarManager;
    let pool: PgPool;
    let changes: ReturnType<typeof createChangeSetRepository>;

    const now = Date.now();
    const ago = (hours: number) => new Date(now - hours * hourMs);
    const id = {
      s1: randomUUID(),
      s2: randomUUID(),
      sa: randomUUID(),
      sb: randomUUID(),
      sc: randomUUID(),
      n1: randomUUID(),
      n2: randomUUID(),
      n3: randomUUID(),
      science: randomUUID(),
      biology: randomUUID(),
      sleep: randomUUID(),
      art: randomUUID()
    };
    const set: Record<string, string> = {};
    let treeId = "";
    let generation = 100;

    async function source(sourceId: string, title: string) {
      await pool.query(
        `insert into source_items (id, type, title, language, content_hash, created_at, updated_at)
       values ($1, 'Book', $2, 'en', $3, now(), now())`,
        [sourceId, title, `content-${sourceId}`]
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

    async function note(noteId: string, title: string, sourceId: string, chunkId: string) {
      await pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
         ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
         generation_provider, generation_model, generation_runtime, generation_prompt_version,
         generation_key, language, created_at, updated_at)
       values ($1, $2, $3, $4, 'active', 'current', 'source', $5, $5, $6, 'seed', 'seed', 'local', 'seed',
         $1::uuid::text, 'en', now(), now())`,
        [noteId, title, `${title} body.`, `${title} idea.`, sourceId, chunkId]
      );
    }

    /** A change-set of the topic engine, with its events: `[op, topic, item kind, item id, refs]`. */
    async function topicSet(
      name: string,
      input: {
        origin: string;
        at: Date;
        events: Array<[string, string, string?, string?, string[]?]>;
      }
    ) {
      const row = await pool.query<{ id: string }>(
        `insert into topic_change_sets (tree_id, origin, status, title_key, risk, generation, created_at, applied_at)
       values ($1, $2, 'applied', $3, 'low', $4, $5, $5) returning id`,
        [treeId, input.origin, `topics.changeSets.${input.origin}`, (generation += 1), input.at]
      );
      const changeSetId = row.rows[0]!.id;
      for (const [seq, [op, topicId, itemKind, itemId, refs]] of input.events.entries())
        await pool.query(
          `insert into topic_structure_events (change_set_id, seq, op, topic_id, item_kind, item_id, ref_topic_ids, before, after)
         values ($1, $2, $3, $4, $5, $6, $7::uuid[], '{}'::jsonb, '{}'::jsonb)`,
          [changeSetId, seq, op, topicId, itemKind ?? null, itemId ?? null, refs ?? []]
        );
      set[name] = changeSetId;
    }

    async function noteRelation(from: string, to: string) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      const row = await pool.query<{ id: string }>(
        `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
         direction, band, probability, final_score, explanation, status, matching_model)
       values ($1, $2, 'same_as', 'symmetric', 'apply', 0.5, 0.5, 'Why.', 'pending_review', 'seed') returning id`,
        [lo, hi]
      );
      return { id: row.rows[0]!.id, lo, hi };
    }

    /** A finished relation pass with one event; `image` is the relation row's image the event keeps. */
    async function relationRun(
      name: string,
      input: {
        kind: "note" | "source";
        relationId: string | null;
        image: Record<string, string> | null;
        before?: Record<string, string>;
        eventKind?: string;
        at: Date;
        reverted?: boolean;
      }
    ) {
      const run = await pool.query<{ id: string }>(
        `insert into relation_match_runs (kind, started_at, finished_at, outcome, undone_at)
       values ('match', $1, $1, $2, $3) returning id`,
        [input.at, input.reverted ? "reverted" : "applied", input.reverted ? input.at : null]
      );
      await pool.query(
        `insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
        [
          run.rows[0]!.id,
          input.kind,
          input.relationId,
          `pair-${name}`,
          input.eventKind ?? "applied",
          input.before ? JSON.stringify(input.before) : null,
          input.image ? JSON.stringify(input.image) : null
        ]
      );
      set[name] = run.rows[0]!.id;
    }

    const idsOf = async (kind: string, objectId: string, limit = 20) =>
      (await changes.forObject({ kind, id: objectId, limit })).map((item) => item.id);

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-change-set-object-"));
      let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
      for (let attempt = 1; !connection; attempt += 1) {
        manager = new PostgresSidecarManager({
          binDir: sidecar.binDir,
          dataDir: join(workDir, `data-${attempt}`),
          database: "memora_change_set_object_test",
          user: "memora_change_set_object_test",
          password: `change-set-object-${randomUUID()}`,
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
      changes = createChangeSetRepository(pool);

      await source(id.s1, "Sleep");
      await source(id.s2, "Memory");
      await source(id.sa, "Naps");
      await source(id.sb, "Rest");
      await source(id.sc, "Nights");
      const [c1, c2] = [await passage(id.s1), await passage(id.s2)];
      await note(id.n1, "Naps", id.s1, c1);
      await note(id.n2, "Consolidation", id.s2, c2);
      await note(id.n3, "Dreams", id.s2, c2);

      const trees = createTopicTreeRepository(pool);
      const rootId = randomUUID();
      const tree = await trees.createTree({
        id: randomUUID(),
        rootId,
        spaceKey: "test:object:256",
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
        placements: [{ item: itemKey("note", id.n1), placement: placementRecord(id.sleep) }]
      });
      // The build is the oldest change-set of the tree.
      await pool.query(
        "update topic_change_sets set created_at = $2, applied_at = $2 where tree_id = $1",
        [tree.id, ago(500)]
      );
      const build = await pool.query<{ id: string }>(
        "select id from topic_change_sets where tree_id = $1",
        [tree.id]
      );
      set.build = build.rows[0]!.id;

      // Topic engine change-sets, oldest to newest: a placement of Naps in Sleep, a rename of Sleep
      // that references itself, a move that touches Art only, and the placement of a source.
      await topicSet("place", {
        origin: "place",
        at: ago(40),
        events: [["item.place", id.sleep, "note", id.n1]]
      });
      await topicSet("rename", {
        origin: "human",
        at: ago(30),
        events: [["topic.rename", id.sleep, undefined, undefined, [id.sleep]]]
      });
      await topicSet("moveArt", {
        origin: "rebalance",
        at: ago(20),
        events: [["topic.move", id.art, undefined, undefined, [id.science]]]
      });
      await topicSet("placeSource", {
        origin: "place",
        at: ago(10),
        events: [["item.place", id.biology, "source", id.s1]]
      });

      // An overview write of Sleep.
      const overview = await pool.query<{ id: string }>(
        `insert into topic_overview_versions (topic_id, origin, status, title_key, risk, base_version, version, created_at, applied_at)
       values ($1, 'write', 'applied', 'changes.titles.overview.write', 'low', 0, 1, $2, $2) returning id`,
        [id.sleep, ago(25)]
      );
      set.overview = overview.rows[0]!.id;

      // Relation passes: Naps-Consolidation (a living relation), Consolidation-Dreams (not Naps), a
      // reverted pass of Naps-Dreams (its relation row is gone, the event keeps the image) and a
      // source relation between Sleep and Memory.
      const nm = await noteRelation(id.n1, id.n2);
      await relationRun("relNm", {
        kind: "note",
        relationId: nm.id,
        image: { source_atomic_note_id: nm.lo, target_atomic_note_id: nm.hi },
        at: ago(15)
      });
      const md = await noteRelation(id.n2, id.n3);
      await relationRun("relMd", {
        kind: "note",
        relationId: md.id,
        image: { source_atomic_note_id: md.lo, target_atomic_note_id: md.hi },
        at: ago(14)
      });
      const [lo, hi] = id.n1 < id.n3 ? [id.n1, id.n3] : [id.n3, id.n1];
      await relationRun("relReverted", {
        kind: "note",
        relationId: randomUUID(),
        image: { source_atomic_note_id: lo, target_atomic_note_id: hi },
        at: ago(12),
        reverted: true
      });
      const sourceRelationId = randomUUID();
      await pool.query(
        `insert into source_relations (id, source_item_id, target_source_item_id, identity_key,
         relation_type, source_idea, target_idea, explanation, importance, confidence, status)
       values ($1, $2, $3, $4, 'supports', 'An idea', 'Another idea', 'Why.', 0.9, 0.9, 'accepted')`,
        [sourceRelationId, id.s1, id.s2, `identity-${sourceRelationId}`]
      );
      await relationRun("relSource", {
        kind: "source",
        relationId: sourceRelationId,
        image: { source_item_id: id.s1, target_source_item_id: id.s2 },
        at: ago(5)
      });
      // A promote pass that retired the pending relation Naps-Rest: the row is gone and the pass
      // was not reverted. Another promote pass moved a relation off Naps to its root Nights: the row
      // now stands at Nights and Rest.
      await relationRun("relRetired", {
        kind: "source",
        relationId: randomUUID(),
        eventKind: "retired",
        before: { source_item_id: id.sa, target_source_item_id: id.sb },
        image: null,
        at: ago(4)
      });
      const movedId = randomUUID();
      await pool.query(
        `insert into source_relations (id, source_item_id, target_source_item_id, identity_key,
         relation_type, source_idea, target_idea, explanation, importance, confidence, status)
       values ($1, $2, $3, $4, 'supports', 'An idea', 'Another idea', 'Why.', 0.9, 0.9, 'accepted')`,
        [movedId, id.sc, id.sb, `identity-${movedId}`]
      );
      await relationRun("relMoved", {
        kind: "source",
        relationId: movedId,
        eventKind: "promoted",
        before: { source_item_id: id.sa, target_source_item_id: id.sb },
        image: { source_item_id: id.sc, target_source_item_id: id.sb },
        at: ago(3)
      });
    }, 120_000);

    afterAll(async () => {
      if (pool) await closePgPool(pool);
      if (manager) await manager.stop();
      if (workDir) await rm(workDir, { recursive: true, force: true });
    });

    it("lists a topic's structure events, referenced topics and overview writes, newest first", async () => {
      // Sleep: the overview write, the rename (own event and reference), the placement into it, the build.
      expect(await idsOf("topic", id.sleep)).toEqual([
        set.overview,
        set.rename,
        set.place,
        set.build
      ]);
      // Art: the move of Art and the build, nothing of Sleep's.
      expect(await idsOf("topic", id.art)).toEqual([set.moveArt, set.build]);
      // Science is referenced by the move (a reference counts), and by the build.
      expect(await idsOf("topic", id.science)).toEqual([set.moveArt, set.build]);
    });

    it("lists a note's placements and the relation passes that changed one of its relations", async () => {
      // Naps: the reverted pass (read by the image of its events), its living relation's pass, the
      // placement and the build; not Consolidation-Dreams, not the rename of its topic.
      expect(await idsOf("note", id.n1)).toEqual([
        set.relReverted,
        set.relNm,
        set.place,
        set.build
      ]);
      // Dreams: its own relation's pass and the reverted one.
      expect(await idsOf("note", id.n3)).toEqual([set.relReverted, set.relMd]);
      // A note placed nowhere and related to nothing has nothing.
      expect(await idsOf("note", randomUUID())).toEqual([]);
    });

    it("lists a source's placements and its source relation passes", async () => {
      expect(await idsOf("source", id.s1)).toEqual([set.relSource, set.placeSource]);
      expect(await idsOf("source", id.s2)).toEqual([set.relSource]);
    });

    it("lists the passes that retired or re-pointed a source relation, though no row of it stands at the source", async () => {
      // Naps: the retired relation (its row is gone) and the one moved off it, neither reverted.
      expect(await idsOf("source", id.sa)).toEqual([set.relMoved, set.relRetired]);
      // Rest: both; Nights: the pass that moved the relation to it.
      expect(await idsOf("source", id.sb)).toEqual([set.relMoved, set.relRetired]);
      expect(await idsOf("source", id.sc)).toEqual([set.relMoved]);
    });

    it("answers what changes.list reports: the status, the undo and the title", async () => {
      const listed = await changes.forObject({ kind: "note", id: id.n1, limit: 20 });
      const reverted = listed.find((item) => item.id === set.relReverted);
      expect(reverted).toMatchObject({ kind: "relation", status: "undone", undo: "unavailable" });
      const living = listed.find((item) => item.id === set.relNm);
      expect(living).toMatchObject({
        kind: "relation",
        status: "applied",
        undo: "available",
        titleKey: "changes.titles.relation.match"
      });
      for (const item of listed) expect(item).toEqual(await changes.get(item.kind, item.id));
    });

    it("is bounded, and an entity, a question or a bad ID has no change-sets", async () => {
      expect(await idsOf("topic", id.sleep, 2)).toEqual([set.overview, set.rename]);
      expect(await idsOf("entity", id.sleep)).toEqual([]);
      expect(await idsOf("question", id.sleep)).toEqual([]);
      expect(await idsOf("topic", "not-an-id")).toEqual([]);
      expect(await changes.forObject({ kind: "topic", id: id.sleep, limit: 500 })).toHaveLength(4);
    });
  }
);
