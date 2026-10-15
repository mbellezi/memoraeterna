import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  topicChangeSetOrigins,
  topicChangeSetRisks,
  topicChangeSetStatuses,
  topicHealthValues,
  topicItemKinds,
  topicLimits,
  topicManagements,
  topicNameSources,
  topicNameStates,
  topicPlacementDecisions,
  topicPlacementManagements,
  topicPlacementRoles,
  topicRoles,
  topicStructureEventOps,
  topicTreeStatuses
} from "@app/domain";
import {
  canonicalStateDump,
  createTopicTreeEditor,
  createTopicTreeState,
  deletePlacement,
  getTopic,
  itemKey,
  keyedVectors,
  liveTopicIds,
  matrixFromRows,
  placementRecord,
  registerItem,
  recomputeSubtree,
  statsDump,
  topicRecordOf,
  topicTreeConfigWith,
  undoBlockers,
  unregisterItem
} from "@app/domain/topic-tree";
import type {
  ItemKey,
  StructureEvent,
  TopicTreeState,
  UndoableChangeSet
} from "@app/domain/topic-tree";
import type { QueryResult, QueryResultRow } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { createLibraryResetRepository } from "./libraryResetRepository.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  TopicTreeRepositoryError,
  createTopicTreeRepository,
  decodeTopicVector,
  encodeTopicVector,
  eventStatsRefs,
  eventTopicRefs,
  minimalEvents,
  stateFromRecords,
  storedStatsDump,
  topicStatsWrites,
  topicTreeRecordsDump,
  topicTreeRepositoryLimits,
  type TopicItemSource,
  type TopicTreeRecords
} from "./topicTreeRepository.js";
import type { Queryable } from "./types.js";

const workspace = resolve(import.meta.dirname, "../../../..");
const migrationSql = () =>
  readFile(join(workspace, "packages/db/drizzle/0053_topic_tree.sql"), "utf8");
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** The values of a `"table"."column" in (...)` check in the migration. */
function checkList(sql: string, table: string, column: string): string[] {
  const match = new RegExp(`"${table}"\\."${column}" in \\(([^)]*)\\)`, "u").exec(sql);
  if (!match) throw new Error(`No check list for ${table}.${column}`);
  return (match[1] as string).split(",").map((value) => value.trim().replace(/^'|'$/gu, ""));
}

describe("migration 0053 vocabulary", () => {
  it("mirrors the domain's topic vocabulary in its checks", async () => {
    const sql = await migrationSql();
    const sorted = (values: readonly string[]) => [...values].sort();
    expect(sorted(checkList(sql, "topic_trees", "status"))).toEqual(sorted(topicTreeStatuses));
    expect(sorted(checkList(sql, "topics", "role"))).toEqual(sorted(topicRoles));
    expect(sorted(checkList(sql, "topics", "name_state"))).toEqual(sorted(topicNameStates));
    expect(sorted(checkList(sql, "topics", "name_source"))).toEqual(sorted(topicNameSources));
    expect(sorted(checkList(sql, "topics", "management"))).toEqual(sorted(topicManagements));
    expect(sorted(checkList(sql, "topic_stats", "health"))).toEqual(sorted(topicHealthValues));
    expect(sorted(checkList(sql, "topic_change_sets", "origin"))).toEqual(
      sorted(topicChangeSetOrigins)
    );
    expect(sorted(checkList(sql, "topic_change_sets", "status"))).toEqual(
      sorted(topicChangeSetStatuses)
    );
    expect(sorted(checkList(sql, "topic_change_sets", "risk"))).toEqual(
      sorted(topicChangeSetRisks)
    );
    expect(sorted(checkList(sql, "topic_structure_events", "op"))).toEqual(
      sorted(topicStructureEventOps)
    );
    expect(sorted(checkList(sql, "topic_structure_events", "item_kind"))).toEqual(
      sorted(topicItemKinds)
    );
    expect(sorted(checkList(sql, "topic_placements", "role"))).toEqual(sorted(topicPlacementRoles));
    expect(sorted(checkList(sql, "topic_placements", "management"))).toEqual(
      sorted(topicPlacementManagements)
    );
    expect(sorted(checkList(sql, "topic_placements", "decided_by"))).toEqual(
      sorted(topicPlacementDecisions)
    );
    expect(sql).toContain(
      `char_length("topics"."title") between 1 and ${topicLimits.titleMaxLength}`
    );
    expect(sql).toContain(
      `char_length("topics"."description") between 1 and ${topicLimits.descriptionMaxLength}`
    );
    expect(sql).toContain(`jsonb_array_length("topics"."aliases") <= ${topicLimits.aliasesMax}`);
    expect(sql).toContain(
      `"topic_placements"."rank" between 0 and ${topicLimits.maxSecondaryPlacements}`
    );
  });

  it("guards AI-managed parents (D9) and marks deleted paths dirty (D32) in the migration", async () => {
    const sql = await migrationSql();
    expect(sql).toContain("current_setting('memora.topic_writer', true) IS DISTINCT FROM 'engine'");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF parent_id, management ON topics");
    expect(sql).toContain("AFTER DELETE ON topic_placements");
    expect(sql).toContain("REFERENCING OLD TABLE AS removed FOR EACH STATEMENT");
    expect(sql).toMatch(/"topic_placements_note_id_atomic_notes_id_fk"[^;]*ON DELETE cascade/u);
    expect(sql).toMatch(
      /"topic_placements_source_item_id_source_items_id_fk"[^;]*ON DELETE cascade/u
    );
    // The function the I7 index uses is created before the index.
    expect(sql.indexOf("CREATE FUNCTION f_unaccent")).toBeLessThan(
      sql.indexOf("topics_sibling_title_uidx")
    );
  });
});

describe("topic tree records", () => {
  it("stores LS as exact little-endian Float64", () => {
    const values = Float64Array.from([0, -0, 1e-300, -2.5, Math.PI, Number.MAX_VALUE]);
    const encoded = encodeTopicVector(values);
    expect(encoded.byteLength).toBe(48);
    expect(encoded.readDoubleLE(32)).toBe(Math.PI);
    const decoded = decodeTopicVector(encoded, 6);
    expect(Buffer.from(decoded.buffer)).toEqual(Buffer.from(values.buffer));
    expect(Object.is(decoded[1], -0)).toBe(true);
    expect(decodeTopicVector(null, 3)).toEqual(new Float64Array(3));
    expect(() => decodeTopicVector(encoded, 5)).toThrow(RangeError);
  });

  it("references every topic an event reads or writes, never a moved-from hint", () => {
    const move: StructureEvent = {
      op: "item.move",
      item: itemKey("note", uuidOf(900)),
      topicId: uuidOf(2),
      before: placementRecord(uuidOf(1), { movedFromTopicId: uuidOf(7) }),
      after: placementRecord(uuidOf(2), { movedFromTopicId: uuidOf(1) })
    };
    expect(eventTopicRefs(move)).toEqual([uuidOf(1), uuidOf(2)]);
    const reparent: StructureEvent = {
      op: "topic.move",
      topicId: uuidOf(3),
      before: { parentId: uuidOf(1), position: 0 },
      after: { parentId: uuidOf(2), position: 4 }
    };
    expect(eventTopicRefs(reparent)).toEqual([uuidOf(1), uuidOf(2), uuidOf(3)]);
    const retire: StructureEvent = {
      op: "topic.retire",
      topicId: uuidOf(3),
      before: { retiredAt: null, redirectTo: null },
      after: { retiredAt: "2026-10-15T12:00:00.000Z", redirectTo: uuidOf(4) }
    };
    expect(eventTopicRefs(retire)).toEqual([uuidOf(3), uuidOf(4)]);
  });

  it("lets only member and child changes make statistics inexact, never a name (D7)", () => {
    const move: StructureEvent = {
      op: "item.move",
      item: itemKey("note", uuidOf(900)),
      topicId: uuidOf(2),
      before: placementRecord(uuidOf(1)),
      after: placementRecord(uuidOf(2))
    };
    expect(eventStatsRefs(move)).toEqual([uuidOf(1), uuidOf(2)]);
    const label: StructureEvent[] = [
      {
        op: "topic.rename",
        topicId: uuidOf(3),
        before: {
          title: null,
          nameState: "unnamed",
          nameSource: null,
          nameLanguage: null,
          namedChangeSetId: null,
          aliases: []
        },
        after: {
          title: "Sono e memória",
          nameState: "named",
          nameSource: "llm",
          nameLanguage: "pt-BR",
          namedChangeSetId: uuidOf(50),
          aliases: ["Descanso"]
        }
      },
      {
        op: "topic.describe",
        topicId: uuidOf(3),
        before: { description: null },
        after: { description: "Notas." }
      },
      {
        op: "topic.manage",
        topicId: uuidOf(3),
        before: { management: "ai" },
        after: { management: "human" }
      }
    ];
    for (const event of label) {
      expect(eventTopicRefs(event)).toEqual([uuidOf(3)]);
      expect(eventStatsRefs(event)).toEqual([]);
    }
  });

  it("keeps only the events that change something (minimal change-sets)", () => {
    const same: StructureEvent = {
      op: "topic.move",
      topicId: uuidOf(3),
      before: { parentId: uuidOf(1), position: 2 },
      after: { position: 2, parentId: uuidOf(1) }
    };
    const real: StructureEvent = { ...same, after: { parentId: uuidOf(1), position: 3 } };
    expect(minimalEvents([same, real, same])).toEqual([real]);
  });

  it("rebuilds the engine state of stored records, statistics and dump included", () => {
    const { state, vectors } = smallWorld();
    const records: TopicTreeRecords = {
      tree: treeRecord(state, 7),
      topics: [...state.topics.values()].map(topicRecordOf),
      placements: [...state.placements].flatMap(([item, list]) =>
        list.map((placement) => ({ item, placement: { ...placement } }))
      )
    };
    expect(topicTreeRecordsDump(records)).toBe(canonicalStateDump(state));
    const rebuilt = stateFromRecords(records, itemData(state, vectors));
    recomputeSubtree(rebuilt, vectors);
    expect(statsDump(rebuilt)).toBe(statsDump(state));
    const writes = topicStatsWrites(state, vectors, liveTopicIds(state));
    expect(storedStatsDump(records, writes)).toBe(statsDump(state));
    const leaf = writes.find((write) => write.topicId === uuidOf(2));
    expect(leaf?.centralities?.map((entry) => entry.item).sort()).toEqual(
      getTopic(state, uuidOf(2)).items.slice().sort()
    );
  });
});

// ---------------------------------------------------------------------------
// The writer against a scripted connection

type Respond = (values: readonly unknown[]) => QueryResultRow[];

class ScriptedConnection implements Queryable {
  readonly statements: string[] = [];
  constructor(private readonly script: [RegExp, Respond | Error][] = []) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.statements.push(text.replace(/\s+/gu, " ").trim());
    for (const [pattern, respond] of this.script) {
      if (!pattern.test(text)) continue;
      if (respond instanceof Error) throw respond;
      const rows = respond(values) as T[];
      return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
    }
    return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
  }

  writes(): string[] {
    return this.statements.filter((sql) =>
      /^(?:with .*\)\s*)?(?:insert|update|delete)\b/iu.test(sql)
    );
  }
}

function scriptedPool(connection: ScriptedConnection): PgPool {
  return {
    connect: async () => ({
      query: connection.query.bind(connection),
      release: () => undefined
    }),
    query: connection.query.bind(connection)
  } as unknown as PgPool;
}

const treeId = uuidOf(100);
const rootId = uuidOf(101);
const treeRow = (generation = 5, status = "active") => ({
  id: treeId,
  status,
  spaceKey: "local:test:256",
  embeddingProvider: "test",
  embeddingModel: "test",
  embeddingRuntime: "none",
  dimensions: 256,
  config: {},
  configHash: "hash",
  seed: "1",
  generation: String(generation),
  clock: "0",
  rootId,
  createdAt: new Date("2026-10-15T10:00:00Z"),
  activatedAt: new Date("2026-10-15T10:00:00Z"),
  retiredAt: null
});
const treeSelect: [RegExp, Respond] = [/from topic_trees t where t\.id = \$1/u, () => [treeRow()]];
const rename: StructureEvent = {
  op: "topic.rename",
  topicId: uuidOf(102),
  before: {
    title: null,
    nameState: "unnamed",
    nameSource: null,
    nameLanguage: null,
    namedChangeSetId: null,
    aliases: []
  },
  after: {
    title: "Memória",
    nameState: "named",
    nameSource: "llm",
    nameLanguage: "pt",
    namedChangeSetId: null,
    aliases: []
  }
};
const apply = (overrides: Record<string, unknown> = {}) => ({
  treeId,
  expectedGeneration: 5,
  origin: "naming" as const,
  titleKey: "topics.changeSets.naming",
  events: [rename],
  ...overrides
});

describe("topic tree writer (scripted connection)", () => {
  it("locks the tree and sets the engine writer before reading, and refuses a stale generation", async () => {
    const connection = new ScriptedConnection([treeSelect]);
    const result = await createTopicTreeRepository(scriptedPool(connection)).applyChangeSet(
      apply({ expectedGeneration: 4 })
    );
    expect(result).toEqual({ kind: "conflict", reason: "generation", currentGeneration: 5 });
    expect(connection.statements.slice(0, 3)).toEqual([
      "begin",
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      "select set_config($1, 'engine', true), set_config('lock_timeout', $2, true)"
    ]);
    expect(connection.writes()).toEqual([]);
    expect(connection.statements.at(-1)).toBe("commit");
  });

  it("writes nothing for an empty change-set or one whose events change nothing", async () => {
    const connection = new ScriptedConnection([treeSelect]);
    const repo = createTopicTreeRepository(scriptedPool(connection));
    await expect(repo.applyChangeSet(apply({ events: [] }))).resolves.toEqual({
      kind: "no_change",
      generation: 5
    });
    const noOp: StructureEvent = { ...rename, after: rename.before };
    await expect(repo.applyChangeSet(apply({ events: [noOp] }))).resolves.toEqual({
      kind: "no_change",
      generation: 5
    });
    expect(connection.writes()).toEqual([]);
  });

  it("validates events and metadata before any statement", async () => {
    const connection = new ScriptedConnection([treeSelect]);
    const repo = createTopicTreeRepository(scriptedPool(connection));
    const invalid = { ...rename, topicId: "not-a-uuid" } as unknown as StructureEvent;
    await expect(repo.applyChangeSet(apply({ events: [invalid] }))).rejects.toBeInstanceOf(
      TopicTreeRepositoryError
    );
    await expect(repo.applyChangeSet(apply({ origin: "undo" }))).rejects.toThrow(
      /Invalid change-set/u
    );
    await expect(repo.applyChangeSet(apply({ titleKey: "" }))).rejects.toThrow(
      /Invalid change-set/u
    );
    expect(connection.statements).toEqual([]);
  });

  it("records a proposal without touching the structure or the generation", async () => {
    const changeSetId = uuidOf(200);
    const connection = new ScriptedConnection([
      treeSelect,
      [/insert into topic_change_sets/u, () => [{ id: changeSetId }]]
    ]);
    const result = await createTopicTreeRepository(scriptedPool(connection)).applyChangeSet(
      apply({ status: "pending_review", expectedGeneration: 1 })
    );
    expect(result).toEqual({ kind: "pending", changeSetId, generation: 5, events: 1 });
    const writes = connection.writes();
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^insert into topic_change_sets/u);
    expect(writes[1]).toMatch(/^insert into topic_structure_events/u);
  });

  it("runs inside a caller's transaction behind a savepoint and restores its settings", async () => {
    const connection = new ScriptedConnection([
      treeSelect,
      [/current_setting\(\$1, true\) as writer/u, () => [{ writer: "", timeout: "0" }]]
    ]);
    const repo = createTopicTreeRepository(scriptedPool(new ScriptedConnection()));
    await repo.applyChangeSet(apply({ expectedGeneration: 4 }), { client: connection });
    expect(connection.statements[0]).toBe("savepoint topic_tree_writer");
    expect(connection.statements.at(-2)).toBe(
      "select set_config($1, $2, true), set_config('lock_timeout', $3, true)"
    );
    expect(connection.statements.at(-1)).toBe("release savepoint topic_tree_writer");

    const failing = new ScriptedConnection([
      [/from topic_trees t where t\.id = \$1/u, new Error("connection lost")]
    ]);
    await expect(repo.applyChangeSet(apply(), { client: failing })).rejects.toThrow(
      "connection lost"
    );
    expect(failing.statements).toContain("rollback to savepoint topic_tree_writer");
  });

  it("turns a row lock that is not granted in time into a retryable conflict", async () => {
    const busy = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03"
    });
    const connection = new ScriptedConnection([
      treeSelect,
      [/insert into topic_change_sets/u, () => [{ id: uuidOf(201) }]],
      [/^\s*update topics t set/u, busy]
    ]);
    const result = await createTopicTreeRepository(scriptedPool(connection)).applyChangeSet(
      apply()
    );
    expect(result).toMatchObject({
      kind: "conflict",
      reason: "event",
      code: "busy",
      eventIndex: 0
    });
    expect(connection.statements).toContain("rollback");
    expect(topicTreeRepositoryLimits.lockTimeoutMs).toBeLessThan(1_000);
  });

  it("blocks an undo that a later change-set depends on, before writing anything", async () => {
    const target = uuidOf(300);
    const later = uuidOf(301);
    const note = uuidOf(302);
    const eventRows: Record<string, QueryResultRow[]> = {
      [target]: [
        {
          changeSetId: target,
          seq: 0,
          op: "item.place",
          topicId: uuidOf(102),
          itemKind: "note",
          itemId: note,
          before: null,
          after: placementRecord(uuidOf(102))
        }
      ],
      [later]: [
        {
          changeSetId: later,
          seq: 0,
          op: "item.move",
          topicId: uuidOf(103),
          itemKind: "note",
          itemId: note,
          before: placementRecord(uuidOf(102)),
          after: placementRecord(uuidOf(103))
        }
      ]
    };
    const connection = new ScriptedConnection([
      treeSelect,
      [
        /from topic_change_sets\s+where id = \$1 and tree_id = \$2/u,
        () => [{ id: target, status: "applied", undoOf: null, generation: "3" }]
      ],
      [/with hits as/u, () => [{ id: later, status: "applied", undoOf: null }]],
      [
        /from topic_structure_events where change_set_id = any/u,
        (values) => (values[0] as string[]).flatMap((id) => eventRows[id] ?? [])
      ]
    ]);
    const result = await createTopicTreeRepository(scriptedPool(connection)).undoChangeSet({
      treeId,
      changeSetId: target,
      titleKey: "topics.changeSets.undo"
    });
    expect(result).toEqual({
      kind: "blocked",
      blockers: [{ kind: "changeSet", changeSetId: later, objects: [`item:note:${note}`] }]
    });
    expect(connection.writes()).toEqual([]);
    expect(connection.statements.at(-1)).toBe("rollback");
  });
});

// ---------------------------------------------------------------------------
// A small engine world: root ── A (3 notes, 1 source) ── B (3 notes, 1 source)

function smallWorld(): {
  state: TopicTreeState;
  vectors: ReturnType<typeof keyedVectors>;
  notes: ItemKey[];
  sources: ItemKey[];
} {
  const dim = 256;
  const rows: number[][] = [];
  for (let row = 0; row < 8; row += 1) {
    rows.push(
      Array.from(
        { length: dim },
        (_, k) => Math.sin((row + 1) * (k + 1) * 0.37) + (row < 4 ? 1 : -1)
      )
    );
  }
  const notes = Array.from({ length: 6 }, (_, n) => itemKey("note", uuidOf(500 + n)));
  const sources = [itemKey("source", uuidOf(600)), itemKey("source", uuidOf(601))];
  const vectors = keyedVectors(matrixFromRows(rows), [...notes, ...sources]);
  const state = createTopicTreeState({ dim, rootId });
  notes.forEach((key, n) =>
    registerItem(state, {
      key,
      kind: "note",
      contentHash: `h${n}`,
      rootSource: sources[n < 3 ? 0 : 1] as ItemKey
    })
  );
  sources.forEach((key, n) =>
    registerItem(state, { key, kind: "source", contentHash: `s${n}`, rootSource: null })
  );
  const editor = createTopicTreeEditor(state, { record: false });
  editor.createTopic(uuidOf(2), rootId, { title: "Alpha", nameState: "named", nameSource: "llm" });
  editor.createTopic(uuidOf(3), rootId, { title: "Beta", nameState: "named", nameSource: "llm" });
  notes.forEach((key, n) => editor.placeItem(key, placementRecord(n < 3 ? uuidOf(2) : uuidOf(3))));
  sources.forEach((key, n) =>
    editor.placeItem(key, placementRecord(n === 0 ? uuidOf(2) : uuidOf(3)))
  );
  recomputeSubtree(state, vectors);
  return { state, vectors, notes, sources };
}

function treeRecord(state: TopicTreeState, generation: number) {
  return {
    id: treeId,
    status: "active" as const,
    spaceKey: "local:test:256",
    embeddingProvider: "test",
    embeddingModel: "test",
    embeddingRuntime: "none",
    dimensions: 256 as const,
    config: {},
    configHash: "hash",
    seed: 1,
    generation,
    clock: 0,
    rootId: state.rootId,
    createdAt: new Date(),
    activatedAt: new Date(),
    retiredAt: null
  };
}

function itemData(state: TopicTreeState, vectors: ReturnType<typeof keyedVectors>) {
  return {
    entries: new Map(
      [...state.items].map(([key, entry]) => [
        key,
        { kind: entry.kind, contentHash: entry.contentHash, rootSource: entry.rootSource }
      ])
    ),
    vectors
  };
}

// ---------------------------------------------------------------------------
// Real PostgreSQL

const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("topic tree writer on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-tree-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_topic_tree_test",
      user: "memora_topic_tree_test",
      password: `topic-tree-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("bootstraps, guards, applies, undoes and recomputes after a cascade, exactly", async () => {
    const { state, vectors, notes, sources } = smallWorld();
    const sourceIds = sources.map((key) => key.slice(7));
    for (const [n, source] of sourceIds.entries()) {
      const document = randomUUID();
      await db().query(
        "insert into source_items (id, type, title) values ($1, 'StandaloneArticle', $2)",
        [source, `Source ${n}`]
      );
      await db().query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'seed', $3)`,
        [document, source, `hash-${n}`]
      );
      for (const [index, key] of notes.slice(n * 3, n * 3 + 3).entries()) {
        const chunk = randomUUID();
        await db().query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
           values ($1, $2, $3, $4, 'Passage', $5)`,
          [chunk, document, source, index, `chunk-${n}-${index}`]
        );
        await db().query(
          `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
             supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
             evidence_chunk_id, generation_provider, generation_model, generation_runtime,
             generation_prompt_version, generation_key)
           values ($1, 'Note', 'Body', 'Idea', 'active', 'current', 'source', $2, $2, $3, 'seed',
                   'seed', 'local', 'seed', $4)`,
          [key.slice(5), source, chunk, key]
        );
      }
    }
    const repo = createTopicTreeRepository(db());
    const tree = await repo.createTree({
      rootId,
      spaceKey: "local:test:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "hash",
      seed: 1
    });
    const built = await repo.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: 0,
      titleKey: "topics.changeSets.build",
      topics: liveTopicIds(state)
        .filter((id) => id !== rootId)
        .map((id) => topicRecordOf(getTopic(state, id))),
      placements: [...state.placements].flatMap(([item, list]) =>
        list.map((placement) => ({ item, placement }))
      ),
      stats: topicStatsWrites(state, vectors, liveTopicIds(state))
    });
    expect(built).toMatchObject({ kind: "applied", generation: 1, dirtyTopicIds: [] });
    const dump = async () => topicTreeRecordsDump(await repo.readTreeRecords(tree.id));
    const stats = async () =>
      storedStatsDump(await repo.readTreeRecords(tree.id), await repo.readTreeStats(tree.id));
    expect(await dump()).toBe(canonicalStateDump(state));
    expect(await stats()).toBe(statsDump(state));

    // D9: an AI topic's parent cannot change outside an engine transaction; I7 backstop.
    await expect(
      db().query("update topics set parent_id = $2 where id = $1", [uuidOf(3), uuidOf(2)])
    ).rejects.toThrow("topics.errors.writerGuard");
    const client = await db().connect();
    try {
      await client.query("begin");
      await client.query("select set_config('memora.topic_writer', 'engine', true)");
      await expect(
        client.query(
          `insert into topics (id, tree_id, parent_id, role, title, name_state)
           values ($1, $2, $3, 'topic', 'ALPHA', 'named')`,
          [randomUUID(), tree.id, rootId]
        )
      ).rejects.toMatchObject({ constraint: "topics_sibling_title_uidx" });
      await client.query("rollback");
    } finally {
      client.release();
    }

    // An engine move applies with exact statistics; its undo restores the structure.
    const editor = createTopicTreeEditor(state);
    editor.updatePlacement(notes[0] as ItemKey, 0, { topicId: uuidOf(3) });
    recomputeSubtree(state, vectors);
    const moved = await repo.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: 1,
      origin: "rebalance",
      titleKey: "topics.changeSets.rebalance",
      events: editor.events,
      stats: topicStatsWrites(state, vectors, liveTopicIds(state))
    });
    expect(moved).toMatchObject({ kind: "applied", generation: 2, dirtyTopicIds: [] });
    expect(await dump()).toBe(canonicalStateDump(state));
    expect(await stats()).toBe(statsDump(state));
    const undone = await repo.undoChangeSet({
      treeId: tree.id,
      changeSetId: moved.kind === "applied" ? moved.changeSetId : "",
      expectedGeneration: 2,
      titleKey: "topics.changeSets.undo"
    });
    expect(undone).toMatchObject({ kind: "applied", generation: 3 });
    expect(undone.kind === "applied" ? undone.dirtyTopicIds.sort() : []).toEqual(
      [rootId, uuidOf(2), uuidOf(3)].sort()
    );
    createTopicTreeEditor(state).updatePlacement(notes[0] as ItemKey, 0, { topicId: uuidOf(2) });
    expect(await dump()).toBe(canonicalStateDump(state));

    // D32: deleting a placed note removes its placement and marks its path dirty; the exact
    // recompute matches the engine, and undoing the build that placed it is blocked.
    await db().query("delete from atomic_notes where id = $1", [(notes[1] as string).slice(5)]);
    const dirty = await db().query<{ topicId: string }>(
      `select topic_id as "topicId" from topic_stats where dirty order by 1`
    );
    expect(dirty.rows.map((row) => row.topicId)).toEqual([rootId, uuidOf(2), uuidOf(3)].sort());
    deletePlacement(state, notes[1] as ItemKey, 0);
    unregisterItem(state, notes[1] as ItemKey);
    recomputeSubtree(state, vectors);
    const items: TopicItemSource = { load: async () => itemData(state, vectors) };
    const recomputed = await repo.recomputeStats({ treeId: tree.id, items });
    expect(recomputed).toMatchObject({ kind: "recomputed", generation: 3 });
    expect(await stats()).toBe(statsDump(state));
    expect(await dump()).toBe(canonicalStateDump(state));
    const blocked = await repo.undoChangeSet({
      treeId: tree.id,
      changeSetId: built.kind === "applied" ? built.changeSetId : "",
      titleKey: "topics.changeSets.undo"
    });
    expect(blocked.kind).toBe("blocked");
    expect(blocked.kind === "blocked" ? blocked.blockers : []).toContainEqual({
      kind: "itemDeleted",
      item: notes[1]
    });
    await expect(repo.recomputeStats({ treeId: tree.id, items })).resolves.toEqual({
      kind: "clean",
      generation: 3
    });

    // The reads of the human path (T26): the stamp a rename or move is made from, and a
    // change-set looked up inside its own tree.
    const stamps = await repo.topicStamps(tree.id, [uuidOf(3), uuidOf(9999)]);
    expect([...stamps.keys()]).toEqual([uuidOf(3)]);
    expect(stamps.get(uuidOf(3))).toMatchObject({ retired: false });
    expect(stamps.get(uuidOf(3))?.updatedAt).toBeInstanceOf(Date);
    const movedId = moved.kind === "applied" ? moved.changeSetId : "";
    await expect(repo.changeSetMeta(tree.id, movedId)).resolves.toEqual({
      id: movedId,
      origin: "rebalance",
      status: "undone",
      titleKey: "topics.changeSets.rebalance"
    });
    await expect(repo.changeSetMeta(tree.id, randomUUID())).resolves.toBeNull();
    await expect(repo.changeSetMeta(randomUUID(), movedId)).resolves.toBeNull();
  }, 60_000);

  it("blocks an undo whose inverse would break I2 or the depth cap, like the engine", async () => {
    await createLibraryResetRepository(db()).reset();
    const source = randomUUID();
    const note = randomUUID();
    const document = randomUUID();
    const chunk = randomUUID();
    await db().query(
      "insert into source_items (id, type, title) values ($1, 'StandaloneArticle', 'Source')",
      [source]
    );
    await db().query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Document', 'seed', 'hash')`,
      [document, source]
    );
    await db().query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Passage', 'chunk')`,
      [chunk, document, source]
    );
    await db().query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, 'Note', 'Body', 'Idea', 'active', 'current', 'source', $2, $2, $3, 'seed',
               'seed', 'local', 'seed', 'key')`,
      [note, source, chunk]
    );
    const config = topicTreeConfigWith({ depth: { target: 2, cap: 2 } });
    const noteKey = itemKey("note", note);
    const sourceKey = itemKey("source", source);
    const [a, b, p, q, z] = [uuidOf(11), uuidOf(12), uuidOf(13), uuidOf(14), uuidOf(15)];
    const state = createTopicTreeState({ dim: 256, rootId });
    registerItem(state, { key: noteKey, kind: "note", contentHash: "n", rootSource: sourceKey });
    registerItem(state, { key: sourceKey, kind: "source", contentHash: "s", rootSource: null });
    const setup = createTopicTreeEditor(state, { record: false });
    for (const id of [a, b, p]) setup.createTopic(id, rootId);
    setup.createTopic(q, p);
    setup.placeItem(noteKey, placementRecord(a));
    setup.placeItem(noteKey, placementRecord(b, { rank: 1 }));
    setup.placeItem(sourceKey, placementRecord(b));
    const repo = createTopicTreeRepository(db());
    const tree = await repo.createTree({
      rootId,
      spaceKey: "local:test:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: { depth: { target: 2, cap: 2 } },
      configHash: "cap-2",
      seed: 1
    });
    const built = await repo.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: 0,
      titleKey: "topics.changeSets.build",
      topics: [a, b, p, q].map((id) => topicRecordOf(getTopic(state, id))),
      placements: [...state.placements].flatMap(([item, list]) =>
        list.map((placement) => ({ item, placement }))
      )
    });
    expect(built.kind).toBe("applied");
    let generation = 1;
    const history: UndoableChangeSet[] = [];
    const step = async (change: (editor: ReturnType<typeof createTopicTreeEditor>) => void) => {
      const editor = createTopicTreeEditor(state);
      change(editor);
      const result = await repo.applyChangeSet({
        treeId: tree.id,
        expectedGeneration: generation,
        origin: "human",
        titleKey: "topics.changeSets.human",
        events: editor.events
      });
      expect(result.kind).toBe("applied");
      generation += 1;
      const changeSet: UndoableChangeSet = {
        id: result.kind === "applied" ? result.changeSetId : "",
        status: "applied",
        undoOf: null,
        events: [...editor.events]
      };
      history.push(changeSet);
      return changeSet;
    };
    // I2: the secondary on B goes; then A moves under B, so B is on the note's primary path.
    const dropSecondary = await step((editor) => editor.unplaceItem(noteKey, 1));
    await step((editor) => editor.moveTopic(a, b));
    // Depth cap: Q comes up to the root; then Z is created under it; Q cannot go back under P.
    const liftQ = await step((editor) => editor.moveTopic(q, rootId));
    await step((editor) => editor.createTopic(z, q));
    const later = (target: UndoableChangeSet) => history.slice(history.indexOf(target) + 1);
    for (const target of [dropSecondary, liftQ]) {
      const engine = undoBlockers(state, config, target, later(target));
      expect(engine).toHaveLength(1);
      const stored = await repo.undoChangeSet({
        treeId: tree.id,
        changeSetId: target.id,
        titleKey: "topics.changeSets.undo"
      });
      expect(stored).toEqual({ kind: "blocked", blockers: engine });
    }
    expect(undoBlockers(state, config, dropSecondary, later(dropSecondary))[0]).toMatchObject({
      code: "secondaryOnPrimaryPath",
      item: noteKey
    });
    expect(undoBlockers(state, config, liftQ, later(liftQ))[0]).toMatchObject({
      code: "depthCap",
      topicId: q
    });
    expect(topicTreeRecordsDump(await repo.readTreeRecords(tree.id))).toBe(
      canonicalStateDump(state)
    );
  }, 60_000);
});
