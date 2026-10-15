import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closePgPool,
  createPgPool,
  createTopicTreeRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import type { ItemKey } from "@app/domain/topic-tree";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TopicAuditError } from "./audit-core.js";
import type { TopicAuditReport } from "./audit-core.js";
import { auditDatabase, type AuditDb } from "./audit-db.js";

// The audit against a real database: the rows a tree really has, read by the SQL the audit really
// runs, with damage planted behind the engine's back (this file is exempt from the single-writer
// scan, like every test).
const root = resolve(import.meta.dirname, "../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noteId = (n: number): string => uid(1000 + n);

/** The topic ids of one of the two trees the test builds (topic ids are unique across trees). */
interface Layout {
  root: string;
  leaf: (n: number) => string;
}
const sound: Layout = { root: uid(1), leaf: (n) => uid(10 + n) };
const damaged: Layout = { root: uid(501), leaf: (n) => uid(510 + n) };

describe.skipIf(!sidecarInstalled)("the topic tree audit on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let connectionString = "";
  const repository = () => createTopicTreeRepository(pool);

  const q = (text: string, values: unknown[] = []) => pool.query(text, values);

  /** Runs statements as the engine, the only way to write AI-managed topics (the D9 guard). */
  async function asEngine(run: (query: typeof q) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('memora.topic_writer', 'engine', true)");
      await run((text, values = []) => client.query(text, values));
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async function createTree(layout: Layout, config: Record<string, unknown> = {}) {
    const tree = await repository().createTree({
      rootId: layout.root,
      spaceKey: "local:test:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config,
      configHash: "hash",
      seed: 1
    });
    return tree;
  }

  /** root -> 4 leaves of 3 notes (the fourth also holds the first root source); S2 waits for a vector at the root. */
  async function bootstrap(treeId: string, { root: rootTopic, leaf }: Layout): Promise<void> {
    const topics = [1, 2, 3, 4].map((n) =>
      topicRecord(leaf(n), rootTopic, {
        title: `Topic ${n}`,
        nameState: "named",
        nameSource: "llm",
        nameLanguage: "en",
        position: n
      })
    );
    const placements: Array<{ item: ItemKey; placement: ReturnType<typeof placementRecord> }> = [];
    for (let n = 0; n < 12; n += 1) {
      placements.push({
        item: itemKey("note", noteId(n)),
        placement: placementRecord(leaf(Math.floor(n / 3) + 1), { decidedBy: "build" })
      });
    }
    placements.push({
      item: itemKey("source", uid(1)),
      placement: placementRecord(leaf(4), { decidedBy: "build" })
    });
    placements.push({
      item: itemKey("source", uid(2)),
      placement: placementRecord(rootTopic, { decidedBy: "fallback", needsVector: true })
    });
    const result = await repository().bootstrapSnapshot({
      treeId,
      expectedGeneration: 0,
      titleKey: "topics.changeSets.build",
      topics,
      placements
    });
    expect(result.kind).toBe("applied");
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-audit-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "audit_fixture",
      user: "audit_fixture",
      password: `audit-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    connectionString = (await manager.start()).connectionString;
    pool = createPgPool({ connectionString, max: 4 });
    await runMigrations(pool, join(root, "packages/db/drizzle"), {
      seedFolder: join(root, "packages/db/seed")
    });

    // Two root sources (the first has a chapter), twelve current notes and three that are not current.
    await q(
      `insert into source_items (id, type, title, parent_source_item_id) values
         ($1, 'Book', 'Source one', null), ($2, 'StandaloneArticle', 'Source two', null),
         ($3, 'BookChapter', 'Chapter', $1)`,
      [uid(1), uid(2), uid(3)]
    );
    await q(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Document', 'seed', 'doc')`,
      [uid(90), uid(1)]
    );
    await q(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Passage', 'chunk')`,
      [uid(91), uid(90), uid(1)]
    );
    const notes: Array<[number, string, string]> = [
      ...Array.from({ length: 12 }, (_, n): [number, string, string] => [n, "active", "current"]),
      [20, "rejected", "current"],
      [21, "archived", "current"],
      [22, "active", "superseded"]
    ];
    for (const [n, status, supersession] of notes) {
      await q(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
           ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
           generation_provider, generation_model, generation_runtime, generation_prompt_version, generation_key)
         values ($1, 'Note', 'Body', 'Idea', $2::atomic_note_status, $3, 'source', $4, $4, $5, 'seed', 'seed',
           'local', 'seed', $6)`,
        [noteId(n), status, supersession, uid(1), uid(91), `key-${n}`]
      );
    }
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  let firstTree = "";

  it("has nothing to audit before a tree exists", async () => {
    await expect(auditDatabase(pool)).rejects.toThrow(TopicAuditError);
    await expect(auditDatabase(pool)).rejects.toThrow("There is no active topic tree.");
    await expect(auditDatabase(pool, { treeId: uid(777) })).rejects.toThrow(
      "That topic tree does not exist."
    );
  });

  it("passes E1 on a sound tree, with current items only and a root source waiting for a vector", async () => {
    firstTree = (await createTree(sound)).id;
    await bootstrap(firstTree, sound);
    const { summary, details } = await auditDatabase(pool);
    expect(details.treeId).toBe(firstTree);
    expect(summary.tree).toEqual({
      status: "active",
      generation: 1,
      consistent: true,
      areasActive: false
    });
    // 12 current notes and 2 root sources; the rejected, archived and superseded notes and the chapter are not items.
    expect(summary.items).toMatchObject({
      expected: 14,
      notes: 12,
      sources: 2,
      reachable: 14,
      reachability: 1,
      placedNotCurrent: 0
    });
    expect(summary.orphans).toEqual({
      unreachableTopics: 0,
      placementsOnRetiredTopics: 0,
      placementsOnUnreachableTopics: 0,
      itemsWithoutPrimary: 0
    });
    expect(summary.violations).toMatchObject({ hard: 0, soft: 0, awaitingApproval: 0 });
    expect(summary.topics).toEqual({ live: 5, retired: 0, internal: 1, leaves: 4, maxDepth: 1 });
    expect(summary.needsVector).toEqual({ notes: 0, sources: 1 });
    // The root source waiting for a vector sits at the root but is not Unsorted (D27).
    expect(summary.unsorted).toMatchObject({ rootItems: 0, waitingAtAncestor: 0, share: 0 });
    expect(summary.e1).toEqual({ passes: true, failures: [] });
  });

  it("reads the undo rate of automatic change-sets in the window, and the Areas band", async () => {
    // Window: the build change-set (now) plus seven applied and one undone within seven days count;
    // a human change-set, an undo, a pending proposal and one from a month ago do not.
    const rows: Array<[string, string, string]> = [
      ...(["place", "place", "place", "gate", "rebalance", "rebalance", "audit"] as const).map(
        (origin): [string, string, string] => [origin, "applied", "36 hours"]
      ),
      ["rebalance", "undone", "3 days"],
      ["human", "applied", "36 hours"],
      ["rebalance", "applied", "30 days"],
      ["areas", "applied", "1 hour"]
    ];
    let generation = 100;
    for (const [origin, status, age] of rows) {
      generation += 1;
      await q(
        `insert into topic_change_sets (tree_id, origin, status, title_key, generation, applied_at, undone_at)
         values ($1, $2, $3, 'topics.test', $4, now() - $5::interval,
                 case when $3 = 'undone' then now() else null end)`,
        [firstTree, origin, status, generation, age]
      );
    }
    await q(
      `insert into topic_change_sets (tree_id, origin, status, title_key) values ($1, 'rebalance', 'pending_review', 'topics.test')`,
      [firstTree]
    );
    const { summary } = await auditDatabase(pool);
    // build + 7 applied + areas + 1 undone = 10 automatic; the undone one is 1 of them.
    expect(summary.undo).toEqual({
      windowDays: 7,
      automatic: 10,
      undone: 1,
      rate: 0.1,
      target: 0.05,
      meetsTarget: false
    });
    expect(summary.tree.areasActive).toBe(true);
    // One day back there are only the build and the Areas change-sets.
    const shortWindow = await auditDatabase(pool, { undoWindowDays: 1 });
    expect(shortWindow.summary.undo).toMatchObject({ windowDays: 1, automatic: 2, undone: 0 });
    expect((await auditDatabase(pool, { areas: "off" })).summary.tree.areasActive).toBe(false);
  });

  it("holds the tree to its own stored configuration", async () => {
    const tightened = {
      fanOut: { targetMin: 2, targetMax: 3, max: 3, hardMax: 16, rootTarget: 0 }
    };
    await q("update topic_trees set config = $2::jsonb where id = $1", [firstTree, tightened]);
    const { summary, details } = await auditDatabase(pool, { areas: "off" });
    expect(details.violations.shown).toEqual([
      {
        code: "I3",
        severity: "soft",
        reason: "fan-out-outside-range",
        topicId: sound.root,
        item: null,
        awaitingApproval: false,
        value: 4
      }
    ]);
    expect(summary.e1.passes).toBe(true);
    await q("update topic_trees set config = '{}'::jsonb where id = $1", [firstTree]);
    await q('update topic_trees set config = \'{"fanOut": {"max": 1}}\'::jsonb where id = $1', [
      firstTree
    ]);
    await expect(auditDatabase(pool)).rejects.toThrow("The stored tree configuration is invalid.");
    await q("update topic_trees set config = '{}'::jsonb where id = $1", [firstTree]);
  });

  it("only reads: every statement is a SELECT, and a read-only session is enough", async () => {
    const statements: string[] = [];
    const spy: AuditDb = {
      query: (text, values) => {
        statements.push(text);
        return pool.query(text, values as unknown[]) as never;
      }
    };
    await auditDatabase(spy);
    expect(statements.length).toBeGreaterThan(5);
    for (const text of statements) expect(text.trimStart()).toMatch(/^select\b/iu);

    const client = new pg.Client({
      connectionString,
      options: "-c default_transaction_read_only=on"
    });
    await client.connect();
    try {
      expect((await auditDatabase(client)).summary.e1.passes).toBe(true);
    } finally {
      await client.end();
    }
  });

  it("reads again when the tree moves while it is read, and says so when it never settles", async () => {
    let checks = 0;
    const moving: AuditDb = {
      query: async (text, values) => {
        const result = await pool.query(text, values as unknown[]);
        if (!text.includes("select generation::text as generation from topic_trees")) {
          return result as never;
        }
        checks += 1;
        return { rows: [{ generation: checks === 1 ? "999" : "1" }] } as never;
      }
    };
    expect((await auditDatabase(moving)).summary.tree.consistent).toBe(true);
    expect(checks).toBe(2);

    checks = 0;
    const neverSettles: AuditDb = {
      query: async (text, values) => {
        const result = await pool.query(text, values as unknown[]);
        if (!text.includes("select generation::text as generation from topic_trees")) {
          return result as never;
        }
        checks += 1;
        return { rows: [{ generation: String(1000 + checks) }] } as never;
      }
    };
    const report = await auditDatabase(neverSettles, { attempts: 3 });
    expect(report.summary.tree.consistent).toBe(false);
    expect(checks).toBe(3);
  });

  describe("on a tree with planted damage", () => {
    let damagedTree = "";
    const { root: rootTopic, leaf } = damaged;
    const retired = uid(600);
    const detachedParent = uid(601);
    const detached = uid(602);
    const crowd = (n: number) => uid(700 + n);

    beforeAll(async () => {
      // The first tree is retired; the damaged one is the active tree from here on.
      await q("update topic_trees set status = 'retired', retired_at = now() where id = $1", [
        firstTree
      ]);
      damagedTree = (await createTree(damaged)).id;
      await bootstrap(damagedTree, damaged);
      await asEngine(async (query) => {
        // 1. An expected item loses its placement.
        await query("delete from topic_placements where tree_id = $1 and note_id = $2", [
          damagedTree,
          noteId(0)
        ]);
        // 2. A primary placement sits on a retired topic.
        await query(
          `insert into topics (id, tree_id, parent_id, role, title, name_state, retired_at, redirect_to)
           values ($1, $2, $3, 'topic', 'Retired', 'named', now(), $4)`,
          [retired, damagedTree, rootTopic, leaf(1)]
        );
        await query(
          "update topic_placements set topic_id = $3 where tree_id = $1 and note_id = $2",
          [damagedTree, noteId(1), retired]
        );
        // 3. A live topic below a retired one, with a note placed on it.
        await query(
          `insert into topics (id, tree_id, parent_id, role, title, name_state, retired_at, redirect_to)
           values ($1, $2, $3, 'topic', 'Retired parent', 'named', now(), $4)`,
          [detachedParent, damagedTree, rootTopic, leaf(1)]
        );
        await query(
          `insert into topics (id, tree_id, parent_id, role, title, name_state)
           values ($1, $2, $3, 'topic', 'Detached', 'named')`,
          [detached, damagedTree, detachedParent]
        );
        await query(
          "update topic_placements set topic_id = $3 where tree_id = $1 and note_id = $2",
          [damagedTree, noteId(2), detached]
        );
        // 4. A topic with 17 children (above the hard maximum of 16), all of them empty leaves.
        for (let n = 0; n < 17; n += 1) {
          await query(
            `insert into topics (id, tree_id, parent_id, role, title, name_state)
             values ($1, $2, $3, 'topic', $4, 'named')`,
            [crowd(n), damagedTree, leaf(3), `Crowd ${n}`]
          );
        }
      });
    }, 60_000);

    const expectedDamage = (report: TopicAuditReport) => {
      const { summary, details } = report;
      expect(details.treeId).toBe(damagedTree);
      expect(summary.orphans).toEqual({
        unreachableTopics: 1,
        placementsOnRetiredTopics: 1,
        placementsOnUnreachableTopics: 1,
        itemsWithoutPrimary: 1
      });
      expect(details.unreachableTopics.shown).toEqual([detached]);
      expect(details.placementsOnRetiredTopics.shown).toEqual([
        { item: itemKey("note", noteId(1)), topicId: retired, rank: 0 }
      ]);
      expect(details.placementsOnUnreachableTopics.shown).toEqual([
        { item: itemKey("note", noteId(2)), topicId: detached, rank: 0 }
      ]);
      expect(details.itemsWithoutPrimary.shown).toEqual([itemKey("note", noteId(0))]);
      // Hard: the detached topic, two placements on bad topics, one unplaced item, one fan-out.
      expect(
        details.violations.shown
          .filter((v) => v.severity === "hard")
          .map((v) => `${v.code} ${v.reason}`)
          .sort()
      ).toEqual(
        [
          "I1 item-unplaced",
          "I1 placement-on-retired-topic",
          "I1 placement-on-unreachable-topic",
          "I1 topic-unreachable",
          "I3 fan-out-above-hard-max"
        ].sort()
      );
      expect(summary.violations.hard).toBe(5);
      // Soft: the 17 empty leaves, and the first leaf that lost all three of its notes.
      expect(summary.violations.byReason.filter((v) => v.severity === "soft")).toEqual([
        {
          code: "I4",
          severity: "soft",
          reason: "leaf-size-outside-range",
          awaitingApproval: false,
          count: 18
        }
      ]);
      expect(summary.items).toMatchObject({ expected: 14, reachable: 11 });
      expect(summary.e1.passes).toBe(false);
      expect(summary.e1.failures).toEqual([
        "reachability",
        "unreachableTopics",
        "placementsOnRetiredTopics",
        "placementsOnUnreachableTopics",
        "itemsWithoutPrimary",
        "hardViolations"
      ]);
    };

    it("reports exactly the planted damage", async () => {
      expectedDamage(await auditDatabase(pool));
    });

    it("still audits the retired first tree by id, and finds it sound", async () => {
      const report = await auditDatabase(pool, { treeId: firstTree });
      expect(report.summary.tree.status).toBe("retired");
      expect(report.summary.e1.passes).toBe(true);
    });

    it("runs from the command line: the report, the JSON file and the exit code", async () => {
      const json = join(workDir, "audit.json");
      const run = (...args: string[]) =>
        spawnSync(join(root, "node_modules/.bin/tsx"), ["scripts/topics/audit.ts", ...args], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, NODE_NO_WARNINGS: "1" }
        });

      const failing = run("--db", connectionString, "--json", json);
      expect(failing.status).toBe(1);
      expect(failing.stdout).toContain("# Topic tree audit");
      expect(failing.stdout).toContain("FAIL: reachability, unreachableTopics");
      expect(failing.stdout).toContain("topic-unreachable");
      expect(failing.stderr).not.toContain(connectionString);
      expectedDamage(JSON.parse(await readFile(json, "utf8")) as TopicAuditReport);

      const passing = run("--db", connectionString, "--tree", firstTree);
      expect(passing.status).toBe(0);
      expect(passing.stdout).toContain("PASS");

      const broken = run("--db", connectionString, "--tree", uid(777));
      expect(broken.status).toBe(2);
      expect(broken.stderr).toContain("That topic tree does not exist.");
      expect(broken.stderr).not.toContain(connectionString);
    }, 60_000);
  });
});
