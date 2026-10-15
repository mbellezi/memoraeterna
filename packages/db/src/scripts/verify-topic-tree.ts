import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  canonicalStateDump,
  createTopicTreeEditor,
  createTopicTreeState,
  createTopic,
  deletePlacement,
  deleteTopic,
  gaussianClusters,
  getTopic,
  humanPlaceItem,
  itemKey,
  keyedVectors,
  leafTopics,
  liveTopicIds,
  createMatrix,
  moveTopic,
  pathOf,
  pinTopic,
  placeItem,
  placementRecord,
  placementsOf,
  rebalanceTree,
  recomputePaths,
  recomputeSubtree,
  registerItem,
  renameTopic,
  repairAll,
  splitLeaf,
  statsDump,
  topicRecordOf,
  topicTreeConfigWith,
  topicsWithStaleStats,
  undoBlockers,
  undoChangeSet,
  unregisterItem
} from "@app/domain/topic-tree";
import type {
  ItemKey,
  ItemVectorSource,
  ShapeContext,
  StructureEvent,
  TopicTreeConfig,
  TopicTreeState,
  UndoableChangeSet
} from "@app/domain/topic-tree";

import {
  closePgPool,
  createChunkRepository,
  createLibraryResetRepository,
  createPgPool,
  createSourceItemRepository,
  createTopicTreeRepository,
  PostgresSidecarManager,
  type PgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  storedStatsDump,
  topicStatsWrites,
  topicTreeRecordsDump,
  type TopicItemSource,
  type TopicTreeRepository
} from "../index.js";

/**
 * Real-database proof of the topic tree tables (migration 0053) and the engine write repository
 * (F2 T12): migration history and shape on the pending and baseline paths; the D9 guard; I7; the
 * placement rank limits; a 2,000-item tree bootstrapped through `bootstrapSnapshot`, 20 PLACE,
 * 5 REBALANCE and 3 human change-sets from the pure engine, each compared with the engine's own
 * state, and the last 5 undone back to the same snapshot hash (E5 b); blockers of a dependent
 * undo; deletions by cascade (a note, a document's chunks, a source) that mark their paths dirty,
 * exact recomputes and `itemDeleted`; serialized concurrent applies; the logs; the library reset.
 * It starts its own temporary PostgreSQL sidecar and never touches an existing database.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-topic-tree-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_topic_tree",
  user: "memora_topic_tree",
  password: `topic-tree-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

const report: Record<string, unknown> = {};
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const now = "2026-10-15T12:00:00.000Z";
const day = "2026-10-15";
const ms = (start: number): number => Math.round((performance.now() - start) * 10) / 10;

/** One replacement chunk with its span (re-chunking deletes the document's previous chunks). */
function rewrittenChunk(content: string) {
  const span = randomUUID();
  return {
    id: randomUUID(),
    sourceSpanId: span,
    chunkIndex: 0,
    content,
    contentHash: sha(content),
    span: { id: span, startOffset: 0, endOffset: content.length }
  };
}

/** Asserts two statistics dumps are equal, naming the differing topics. */
function assertSameStats(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  const rows = (dump: string) =>
    new Map((JSON.parse(dump) as [string, number, string][]).map((row) => [row[0], row]));
  const a = rows(actual);
  const e = rows(expected);
  const differing = [...new Set([...a.keys(), ...e.keys()])].filter(
    (id) => JSON.stringify(a.get(id)) !== JSON.stringify(e.get(id))
  );
  assert.fail(
    `${label}: ${differing.length} topics differ: ${differing
      .slice(0, 5)
      .map((id) => `${id} n ${a.get(id)?.[1]} vs ${e.get(id)?.[1]}`)
      .join("; ")}`
  );
}

/** Asserts two canonical dumps are equal, naming the first differing topic or placement. */
function assertSameDump(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  type Dump = { topics: unknown[][]; placements: unknown[][] };
  const a = JSON.parse(actual) as Dump;
  const e = JSON.parse(expected) as Dump;
  const keyed = (rows: unknown[][], key: (row: unknown[]) => string) =>
    new Map(rows.map((row) => [key(row), JSON.stringify(row)]));
  const topicsA = keyed(a.topics, (row) => String(row[0]));
  const topicsE = keyed(e.topics, (row) => String(row[0]));
  const placementsA = keyed(a.placements, (row) => `${row[0]}#${row[2]}`);
  const placementsE = keyed(e.placements, (row) => `${row[0]}#${row[2]}`);
  const first = (x: Map<string, string>, y: Map<string, string>) =>
    [...new Set([...x.keys(), ...y.keys()])].find((key) => x.get(key) !== y.get(key));
  const topic = first(topicsA, topicsE);
  const placement = first(placementsA, placementsE);
  assert.fail(
    `${label}: stored ${a.topics.length} topics / ${a.placements.length} placements, engine ` +
      `${e.topics.length} / ${e.placements.length}; first topic difference ${topic}: ` +
      `${topic ? `${topicsA.get(topic)} vs ${topicsE.get(topic)}` : "none"}; first placement ` +
      `difference ${placement}: ${placement ? `${placementsA.get(placement)} vs ${placementsE.get(placement)}` : "none"}`
  );
}

const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const tags: string[] = journal.entries.map((entry: { tag: string }) => entry.tag);
  const tag = tags.find((name) => name.endsWith("_topic_tree"));
  assert.ok(tag, "the topic tree migration is in the journal");
  const index = tags.indexOf(tag);
  const historyCount = async (db: PgPool) =>
    Number(
      (
        await db.query<{ count: string }>(
          "select count(*)::text as count from drizzle.__drizzle_migrations"
        )
      ).rows[0]?.count
    );
  const migrationsBefore = async (before: number, name: string) => {
    const folder = join(workDir, name);
    await cp(migrationsFolder, folder, { recursive: true });
    await writeFile(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, before) })
    );
    return folder;
  };

  // 1. Pending path: a database at 0052 with a source keeps it and gets 0053.
  const db = createPgPool({ connectionString: connection.connectionString, max: 6 });
  pools.push(db);
  await runMigrations(db, await migrationsBefore(index, "drizzle-before-topic-tree"));
  assert.equal(await historyCount(db), index, "history before the topic tree migration");
  const kept = await createSourceItemRepository(db).create({
    type: "StandaloneArticle",
    title: "Kept source"
  });
  await runMigrations(db, migrationsFolder);
  assert.equal(await historyCount(db), tags.length, "0053 applied as a pending migration");
  assert.equal(
    (await db.query("select 1 from source_items where id = $1", [kept.id])).rowCount,
    1,
    "existing data survives"
  );

  // 2. Baseline path: an empty database is seeded with every migration, 0053 included.
  const seededName = "memora_topic_tree_seed";
  await db.query(`create database ${seededName}`);
  const seededUrl = new URL(connection.connectionString);
  seededUrl.pathname = `/${seededName}`;
  const seeded = createPgPool({ connectionString: seededUrl.toString(), max: 2 });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(seed.seed.applied && seed.seed.seededMigrations.includes(tag), "baseline holds 0053");
  assert.equal(await historyCount(seeded), tags.length, "seeded history");

  // 3. Shape: columns, indexes, constraints, triggers and functions, identical on both paths.
  const topicTables = [
    "topic_trees",
    "topics",
    "topic_stats",
    "topic_placements",
    "topic_change_sets",
    "topic_structure_events",
    "topic_gate_decisions",
    "topic_daily_metrics",
    "topic_calibrations"
  ];
  const shape = async (pool: PgPool) => ({
    columns: (
      await pool.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `select table_name, column_name, data_type, is_nullable from information_schema.columns
          where table_name = any($1::text[])`,
        [topicTables]
      )
    ).rows
      .map((row) => `${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}`)
      .sort(),
    indexes: (
      await pool.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where tablename = any($1::text[])",
        [topicTables]
      )
    ).rows
      .map((row) => row.indexdef)
      .sort(),
    constraints: (
      await pool.query<{ conname: string; contype: string; def: string }>(
        `select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = any(select oid from pg_class where relname = any($1::text[]))`,
        [topicTables]
      )
    ).rows
      .map((row) => `${row.conname}:${row.contype}:${row.def}`)
      .sort(),
    triggers: (
      await pool.query<{ tgname: string; relname: string }>(
        `select t.tgname, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where not t.tgisinternal and c.relname = any($1::text[])`,
        [topicTables]
      )
    ).rows
      .map((row) => `${row.relname}.${row.tgname}`)
      .sort(),
    functions: (
      await pool.query<{ proname: string; provolatile: string }>(
        `select proname, provolatile from pg_proc
          where proname in ('f_unaccent','topics_parent_writer_guard','topic_placements_mark_dirty')`
      )
    ).rows
      .map((row) => `${row.proname}:${row.provolatile}`)
      .sort()
  });
  const pendingShape = await shape(db);
  assert.deepEqual(await shape(seeded), pendingShape, "pending and baseline shapes are identical");
  assert.deepEqual(pendingShape.triggers, [
    "topic_placements.topic_placements_mark_dirty",
    "topics.topics_parent_writer_guard"
  ]);
  assert.deepEqual(pendingShape.functions, [
    "f_unaccent:i",
    "topic_placements_mark_dirty:v",
    "topics_parent_writer_guard:v"
  ]);
  for (const name of [
    "topic_trees_active_uidx",
    "topics_sibling_title_uidx",
    "topics_tree_root_uidx",
    "topic_placements_item_rank_uidx",
    "topic_placements_item_topic_uidx",
    "topic_structure_events_refs_idx",
    "topic_change_sets_generation_uidx",
    "topic_gate_decisions_cache_uidx",
    "topic_calibrations_active_uidx"
  ]) {
    assert.ok(
      pendingShape.indexes.some((definition) => definition.includes(name)),
      `index ${name}`
    );
  }
  const cascades = pendingShape.constraints.filter((definition) => definition.includes("CASCADE"));
  assert.ok(
    cascades.some((definition) => definition.startsWith("topic_placements_note_id")) &&
      cascades.some((definition) => definition.startsWith("topic_placements_source_item_id")),
    "placements cascade from notes and sources (D32)"
  );
  report.shape = {
    columns: pendingShape.columns.length,
    indexes: pendingShape.indexes.length,
    constraints: pendingShape.constraints.length,
    triggers: pendingShape.triggers,
    functions: pendingShape.functions
  };

  // 4. A synthetic library: 200 root sources with 9 notes each, plus 20 later notes.
  const dim = 256;
  const sourcesCount = 200;
  const notesPerSource = 9;
  const laterNotes = 20;
  const data = gaussianClusters({
    groups: 6,
    clustersPerGroup: 6,
    pointsPerCluster: 51,
    dim,
    groupSpread: 0.8,
    pointNoise: 0.45,
    seed: 20261014
  });
  const noteCount = sourcesCount * notesPerSource + laterNotes;
  const sourceIds = Array.from({ length: sourcesCount }, () => randomUUID());
  const documentIds = sourceIds.map(() => randomUUID());
  const noteIds = Array.from({ length: noteCount }, () => randomUUID());
  const chunkIds = noteIds.map(() => randomUUID());
  const sourceOf = (note: number): number => note % sourcesCount;
  await db.query(
    `insert into source_items (id, type, title)
     select id, 'StandaloneArticle'::source_item_type, 'Source ' || n
       from unnest($1::uuid[]) with ordinality as s(id, n)`,
    [sourceIds]
  );
  await db.query(
    `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
     select d, s, 'Document', 'seed', md5(d::text) from unnest($1::uuid[], $2::uuid[]) as x(d, s)`,
    [documentIds, sourceIds]
  );
  await db.query(
    `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
     select c, d, s, n::int, 'Passage ' || n, md5(c::text)
       from unnest($1::uuid[], $2::uuid[], $3::uuid[]) with ordinality as x(c, d, s, n)`,
    [
      chunkIds,
      noteIds.map((_, note) => documentIds[sourceOf(note)]),
      noteIds.map((_, note) => sourceIds[sourceOf(note)])
    ]
  );
  await db.query(
    `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
        ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
        generation_provider, generation_model, generation_runtime, generation_prompt_version,
        generation_key)
     select n, 'Note ' || i, 'Body ' || i, 'Idea ' || i, 'active', 'current', 'source', s, s, c,
            'seed', 'seed', 'local', 'seed', n::text
       from unnest($1::uuid[], $2::uuid[], $3::uuid[]) with ordinality as x(n, s, c, i)`,
    [noteIds, noteIds.map((_, note) => sourceIds[sourceOf(note)]), chunkIds]
  );

  // The engine world: notes are unit vectors; a source's vector is the mean of its notes.
  const noteKeys = noteIds.map((id) => itemKey("note", id));
  const sourceKeys = sourceIds.map((id) => itemKey("source", id));
  const matrix = createMatrix(noteCount + sourcesCount, dim);
  matrix.data.set(data.matrix.data.subarray(0, noteCount * dim));
  for (let note = 0; note < noteCount - laterNotes; note += 1) {
    const offset = (noteCount + sourceOf(note)) * dim;
    for (let k = 0; k < dim; k += 1) {
      matrix.data[offset + k] =
        (matrix.data[offset + k] as number) + (matrix.data[note * dim + k] as number);
    }
  }
  for (let source = 0; source < sourcesCount; source += 1) {
    const offset = (noteCount + source) * dim;
    let length = 0;
    for (let k = 0; k < dim; k += 1) length += (matrix.data[offset + k] as number) ** 2;
    for (let k = 0; k < dim; k += 1) {
      matrix.data[offset + k] = (matrix.data[offset + k] as number) / Math.sqrt(length);
    }
  }
  const vectors: ItemVectorSource = keyedVectors(matrix, [...noteKeys, ...sourceKeys]);
  const rootId = randomUUID();
  const config: TopicTreeConfig = topicTreeConfigWith({});
  const state: TopicTreeState = createTopicTreeState({ dim, rootId });
  noteKeys.forEach((key, note) =>
    registerItem(state, {
      key,
      kind: "note",
      contentHash: sha(`note-${note}`),
      rootSource: sourceKeys[sourceOf(note)] as ItemKey
    })
  );
  sourceKeys.forEach((key, source) =>
    registerItem(state, {
      key,
      kind: "source",
      contentHash: sha(`source-${source}`),
      rootSource: null
    })
  );
  const items: TopicItemSource = {
    async load(keys) {
      const entries = new Map();
      for (const key of keys) {
        const entry = state.items.get(key);
        if (entry)
          entries.set(key, {
            kind: entry.kind,
            contentHash: entry.contentHash,
            rootSource: entry.rootSource
          });
      }
      return { entries, vectors };
    }
  };

  // 5. Bootstrap: 2,000 items built by the engine and written through bootstrapSnapshot.
  const repo: TopicTreeRepository = createTopicTreeRepository(db);
  const shapeContext = (
    editor: ReturnType<typeof createTopicTreeEditor>,
    shapeConfig = config
  ): ShapeContext => ({
    state,
    vectors,
    config: shapeConfig,
    seed: 20261014,
    editor,
    newTopicId: () => randomUUID(),
    now
  });
  const buildStart = performance.now();
  const setup = createTopicTreeEditor(state, { record: false });
  const bootstrapItems = [...noteKeys.slice(0, noteCount - laterNotes), ...sourceKeys];
  for (const key of bootstrapItems) {
    setup.placeItem(key, placementRecord(rootId, { decidedBy: "build" }));
  }
  recomputeSubtree(state, vectors);
  repairAll(shapeContext(setup), { force: true });
  // A cold build's retired intermediates were never published: the snapshot holds live topics.
  for (let removed = true; removed;) {
    removed = false;
    for (const node of [...state.topics.values()]) {
      if (node.retiredAt === null) continue;
      const referenced = [...state.topics.values()].some(
        (other) =>
          other.id !== node.id && (other.parentId === node.id || other.redirectTo === node.id)
      );
      if (!referenced) {
        deleteTopic(state, node.id);
        removed = true;
      }
    }
  }
  recomputeSubtree(state, vectors);
  const engineBuildMs = ms(buildStart);
  const tree = await repo.createTree({
    rootId,
    spaceKey: "local:synthetic:256:topic-tree-verify",
    embeddingProvider: "synthetic",
    embeddingModel: "gaussian-clusters",
    embeddingRuntime: "none",
    dimensions: dim,
    config: {},
    configHash: sha("default-config"),
    seed: 20261014
  });
  await assert.rejects(
    repo.createTree({
      spaceKey: tree.spaceKey,
      embeddingProvider: "synthetic",
      embeddingModel: "gaussian-clusters",
      embeddingRuntime: "none",
      dimensions: dim,
      config: {},
      configHash: tree.configHash,
      seed: 1
    }),
    /already active/u,
    "a second active tree is refused"
  );
  const topics = liveTopicIds(state)
    .filter((id) => id !== rootId)
    .map((id) => topicRecordOf(getTopic(state, id)));
  const placements = [...state.placements].flatMap(([item, list]) =>
    list.map((placement) => ({ item, placement }))
  );
  const bootstrapStart = performance.now();
  const bootstrap = await repo.bootstrapSnapshot({
    treeId: tree.id,
    expectedGeneration: 0,
    titleKey: "topics.changeSets.build",
    topics,
    placements,
    stats: topicStatsWrites(state, vectors, liveTopicIds(state)),
    clock: state.clock
  });
  const bootstrapMs = ms(bootstrapStart);
  assert.equal(bootstrap.kind, "applied", "the bootstrap applies");
  assert.ok(
    bootstrap.kind === "applied" && bootstrap.dirtyTopicIds.length === 0,
    "exact statistics"
  );
  let generation = bootstrap.kind === "applied" ? bootstrap.generation : 0;
  state.generation = generation;
  const dbDump = async () => topicTreeRecordsDump(await repo.readTreeRecords(tree.id));
  const dbStats = async () =>
    storedStatsDump(await repo.readTreeRecords(tree.id), await repo.readTreeStats(tree.id));
  assertSameDump(await dbDump(), canonicalStateDump(state), "the stored tree equals the engine's");
  assertSameStats(
    await dbStats(),
    statsDump(state),
    "stored statistics are bit-equal to the engine's"
  );
  report.bootstrap = {
    items: bootstrapItems.length,
    topics: topics.length + 1,
    placements: placements.length,
    leaves: leafTopics(state).length,
    engineBuildMs,
    bootstrapSnapshotMs: bootstrapMs
  };

  // 6. D9 guard, I7 and placement limits (raw statements in rolled-back transactions).
  const guard = await db.connect();
  const leaf = leafTopics(state)[0]!;
  const otherParent = getTopic(state, rootId).children.find((id) => id !== leaf.parentId)!;
  try {
    await guard.query("begin");
    await assert.rejects(
      guard.query(/* D9 guard probe */ "update topics set parent_id = $2 where id = $1", [
        leaf.id,
        otherParent
      ]),
      /topics\.errors\.writerGuard/u,
      "a non-engine parent write on an AI topic is refused"
    );
    await guard.query("rollback");
    await guard.query("begin");
    await guard.query("select set_config('memora.topic_writer', 'engine', true)");
    await guard.query(/* D9 guard probe */ "update topics set management = 'human' where id = $1", [
      leaf.id
    ]);
    await guard.query("select set_config('memora.topic_writer', '', true)");
    const human = await guard.query(
      /* D9 guard probe */ "update topics set parent_id = $2 where id = $1 returning id",
      [leaf.id, otherParent]
    );
    assert.equal(human.rowCount, 1, "a human topic's parent write passes the guard");
    await assert.rejects(
      guard.query(/* D9 guard probe */ "update topics set parent_id = $2 where id = $1", [
        otherParent,
        leaf.id
      ]),
      /topics\.errors\.cycle|topics\.errors\.writerGuard/u,
      "a cycle is refused"
    );
    await guard.query("rollback");
    await guard.query("begin");
    await guard.query("select set_config('memora.topic_writer', 'engine', true)");
    const parentOf = getTopic(state, leaf.parentId!);
    const [a, b] = [randomUUID(), randomUUID()];
    await guard
      .query(
        /* D9 guard probe */ `insert into topics (id, tree_id, parent_id, role, title, name_state)
       values ($1, $3, $4, 'topic', 'memoria', 'named'), ($2, $3, $4, 'topic', 'Memória', 'named')`,
        [a, b, tree.id, parentOf.id]
      )
      .then(
        () => assert.fail("I7 must refuse Memória beside memoria"),
        (error: { constraint?: string }) =>
          assert.equal(error.constraint, "topics_sibling_title_uidx", "I7 backstop")
      );
    await guard.query("rollback");
    await guard.query("begin");
    const note = noteIds[0]!;
    await guard
      .query(
        /* D9 guard probe */ `insert into topic_placements (tree_id, item_kind, note_id, topic_id, role, rank, decided_by)
         values ($1, 'note', $2, $3, 'secondary', 3, 'auto')`,
        [tree.id, note, leaf.id]
      )
      .then(
        () => assert.fail("a fourth placement rank must be refused"),
        (error: { constraint?: string }) => assert.equal(error.constraint, "topic_placements_rank")
      );
    await guard.query("rollback");
    await guard.query("begin");
    const primary = placementsOf(state, noteKeys[0]!)[0]!;
    await guard
      .query(
        /* D9 guard probe */ `insert into topic_placements (tree_id, item_kind, note_id, topic_id, role, rank, decided_by)
         values ($1, 'note', $2, $3, 'primary', 0, 'auto')`,
        [tree.id, note, otherParent]
      )
      .then(
        () => assert.fail("a second primary must be refused"),
        (error: { constraint?: string }) =>
          assert.equal(
            error.constraint,
            "topic_placements_item_rank_uidx",
            `one primary (${primary.topicId})`
          )
      );
    await guard.query("rollback");
  } finally {
    guard.release();
  }
  assertSameDump(await dbDump(), canonicalStateDump(state), "the probes left nothing behind");

  // 7. Change-sets from the engine: 20 PLACE, 5 REBALANCE, 3 human.
  const history: UndoableChangeSet[] = [];
  /** The stored snapshot hash after each applied change-set (index = history index). */
  const appliedHashes: string[] = [];
  const pathsOf = (topicIds: Iterable<string>): string[] => {
    const output = new Set<string>();
    for (const id of topicIds) {
      if (state.topics.has(id) && getTopic(state, id).retiredAt === null) {
        for (const pathId of pathOf(state, id)) output.add(pathId);
      }
    }
    return [...output];
  };
  const apply = async (
    origin: "place" | "rebalance" | "human",
    events: readonly StructureEvent[],
    touched: Iterable<string> = [],
    changeSetId?: string
  ) => {
    const stale = [...new Set([...topicsWithStaleStats(state, events), ...touched])];
    recomputePaths(state, vectors, stale);
    const start = performance.now();
    const result = await repo.applyChangeSet({
      ...(changeSetId ? { id: changeSetId } : {}),
      treeId: tree.id,
      expectedGeneration: generation,
      origin,
      titleKey: `topics.changeSets.${origin}`,
      events,
      stats: topicStatsWrites(state, vectors, pathsOf(stale)),
      clock: state.clock
    });
    const elapsed = ms(start);
    assert.equal(result.kind, "applied", `${origin} applies (${JSON.stringify(result)})`);
    if (result.kind !== "applied") throw new Error("unreachable");
    assert.deepEqual(result.dirtyTopicIds, [], `${origin}: the engine covered every touched path`);
    generation = result.generation;
    state.generation = generation;
    history.push({
      id: result.changeSetId,
      status: "applied",
      undoOf: null,
      events: await repo.changeSetEvents(result.changeSetId)
    });
    const dump = await dbDump();
    assertSameDump(dump, canonicalStateDump(state), `${origin}: stored tree equals the engine's`);
    assertSameStats(await dbStats(), statsDump(state), `${origin}: statistics are bit-equal`);
    appliedHashes.push(sha(dump));
    return { result, elapsed };
  };
  const placeTimes: number[] = [];
  for (const key of noteKeys.slice(noteCount - laterNotes)) {
    const editor = createTopicTreeEditor(state);
    placeItem({ state, vectors, config, editor, now }, key, { fingerprint: `vector:${key}` });
    const { elapsed } = await apply("place", editor.events);
    placeTimes.push(elapsed);
  }
  const noOp = await repo.applyChangeSet({
    treeId: tree.id,
    expectedGeneration: generation,
    origin: "place",
    titleKey: "topics.changeSets.place",
    events: []
  });
  assert.equal(noOp.kind, "no_change", "an idempotent PLACE writes no change-set");
  const tight = topicTreeConfigWith({ leaf: { min: 3, max: 12, target: 8 } });
  const rebalanceSizes: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    const largest = leafTopics(state)
      .filter((node) => node.management === "ai")
      .sort((x, y) => y.items.length - x.items.length || (x.id < y.id ? -1 : 1))
      .slice(0, 2)
      .map((node) => node.id);
    const result = rebalanceTree({
      state,
      vectors,
      config: tight,
      seed: 20261014 + round,
      now,
      day,
      newTopicId: () => randomUUID(),
      topics: largest,
      force: true,
      maxTrials: 32
    });
    let events = result.events;
    let touched = result.touchedTopics;
    if (events.length === 0) {
      const editor = createTopicTreeEditor(state);
      const operation = splitLeaf(shapeContext(editor, tight), largest[0]!);
      assert.ok(operation, "a REBALANCE split applies");
      events = editor.events;
      touched = [...editor.touched];
    }
    rebalanceSizes.push(events.length);
    await apply("rebalance", events, touched);
  }
  const humanContext = () => {
    const editor = createTopicTreeEditor(state);
    return { state, config, editor };
  };
  const leaves = leafTopics(state).filter((node) => node.management === "ai");
  const renameId = randomUUID();
  const rename = humanContext();
  renameTopic(rename, leaves[0]!.id, "Memória viva", { language: "pt", changeSetId: renameId });
  await apply("human", rename.editor.events, [], renameId);
  const created = humanContext();
  const createdId = randomUUID();
  const createId = randomUUID();
  createTopic(created, createdId, leaves[1]!.parentId!, "Leituras escolhidas", {
    language: "pt",
    changeSetId: createId
  });
  humanPlaceItem(created, leaves[1]!.items[0]!, createdId, "primary");
  await apply("human", created.editor.events, [...created.editor.touched], createId);
  const pin = humanContext();
  pinTopic(pin, leaves[2]!.id);
  const target = leaves.find(
    (node) => node.parentId !== leaves[2]!.parentId && node.id !== leaves[2]!.id
  )!;
  moveTopic(pin, leaves[2]!.id, target.parentId!);
  await apply("human", pin.editor.events, [...pin.editor.touched]);
  report.changeSets = {
    place: {
      count: placeTimes.length,
      p50Ms: placeTimes.sort((x, y) => x - y)[10],
      maxMs: placeTimes.at(-1)
    },
    rebalanceEvents: rebalanceSizes,
    humanEvents: history.slice(-3).map((changeSet) => changeSet.events.length)
  };

  // 8. Undo the last 5, newest first, in the database and in the engine (E5 b).
  assert.equal(history.length, 28, "20 PLACE, 5 REBALANCE and 3 human change-sets");
  const hashBeforeLastFive = appliedHashes[22] as string;
  const undoTimes: number[] = [];
  for (const targetSet of history.slice(-5).reverse()) {
    const later = history.slice(history.indexOf(targetSet) + 1);
    const engine = undoChangeSet(state, config, targetSet, later);
    assert.equal(engine.kind, "undone", "the engine undoes it");
    if (engine.kind !== "undone") throw new Error("unreachable");
    const stale = [
      ...new Set([...topicsWithStaleStats(state, engine.events), ...engine.touchedTopics])
    ];
    recomputePaths(state, vectors, stale);
    const start = performance.now();
    const result = await repo.undoChangeSet({
      treeId: tree.id,
      changeSetId: targetSet.id,
      expectedGeneration: generation,
      titleKey: "topics.changeSets.undo",
      stats: topicStatsWrites(state, vectors, pathsOf(stale)),
      clock: state.clock
    });
    undoTimes.push(ms(start));
    assert.equal(result.kind, "applied", `the database undoes it (${JSON.stringify(result)})`);
    if (result.kind !== "applied") throw new Error("unreachable");
    generation = result.generation;
    state.generation = generation;
    targetSet.status = "undone";
    history.push({
      id: result.changeSetId,
      status: "applied",
      undoOf: targetSet.id,
      events: engine.events
    });
    assert.deepEqual(
      await repo.changeSetEvents(result.changeSetId),
      engine.events,
      "the stored inverse"
    );
    assert.equal(
      await dbDump(),
      canonicalStateDump(state),
      "after undo the stored tree equals the engine's"
    );
    assertSameStats(await dbStats(), statsDump(state), "after undo the statistics are bit-equal");
  }
  const hashAfterUndo = sha(await dbDump());
  assert.equal(hashAfterUndo, hashBeforeLastFive, "E5 b: the ordered snapshot hash is equal");
  report.undo = {
    lastFiveMs: undoTimes,
    snapshotHashBefore: hashBeforeLastFive.slice(0, 16),
    snapshotHashAfterUndo: hashAfterUndo.slice(0, 16)
  };

  // 9. Undoing a change-set a later one depends on is blocked and names the same blockers.
  const blockedTarget = history.find(
    (changeSet) =>
      changeSet.status === "applied" &&
      changeSet.undoOf === null &&
      undoBlockers(state, config, changeSet, history.slice(history.indexOf(changeSet) + 1)).some(
        (blocker) => blocker.kind === "changeSet"
      )
  );
  assert.ok(blockedTarget, "some change-set has a later dependent");
  const engineBlockers = undoBlockers(
    state,
    config,
    blockedTarget,
    history.slice(history.indexOf(blockedTarget) + 1)
  );
  const blocked = await repo.undoChangeSet({
    treeId: tree.id,
    changeSetId: blockedTarget.id,
    titleKey: "topics.changeSets.undo"
  });
  assert.equal(blocked.kind, "blocked", "undo with a dependent is blocked");
  assert.deepEqual(
    blocked.kind === "blocked" ? blocked.blockers : [],
    engineBlockers,
    "same blockers"
  );
  assertSameDump(await dbDump(), canonicalStateDump(state), "a blocked undo changes nothing");
  report.dependentUndo = {
    blockers: engineBlockers.map((blocker) =>
      blocker.kind === "changeSet" ? `changeSet:${blocker.objects.join("+")}` : blocker.kind
    )
  };

  // 10. Deletions leave by cascade (D32), mark their paths dirty, and recompute exactly.
  const dirtyTopics = async () =>
    (
      await db.query<{ topicId: string }>(
        `select s.topic_id as "topicId" from topic_stats s join topics t on t.id = s.topic_id
          where t.tree_id = $1 and t.retired_at is null and s.dirty order by 1`,
        [tree.id]
      )
    ).rows.map((row) => row.topicId);
  const forget = (key: ItemKey): void => {
    for (const placement of [...placementsOf(state, key)].reverse()) {
      deletePlacement(state, key, placement.rank);
    }
    unregisterItem(state, key);
  };
  const recompute = async (label: string) => {
    const start = performance.now();
    const result = await repo.recomputeStats({ treeId: tree.id, items });
    const elapsed = ms(start);
    assert.equal(result.kind, "recomputed", `${label}: recomputed`);
    recomputeSubtree(state, vectors);
    assertSameStats(
      await dbStats(),
      statsDump(state),
      `${label}: exact statistics after the recompute`
    );
    assert.deepEqual(await dirtyTopics(), [], `${label}: nothing left dirty`);
    assertSameDump(await dbDump(), canonicalStateDump(state), `${label}: stored tree`);
    return { recomputedTopics: result.kind === "recomputed" ? result.topicIds.length : 0, elapsed };
  };
  // (a) A note placed by a PLACE change-set, deleted directly.
  const placeSet = history.find((changeSet) =>
    changeSet.events.some((event) => event.op === "item.place" && event.after.rank === 0)
  )!;
  const placedEvent = placeSet.events.find((event) => event.op === "item.place")!;
  const deletedNote = (placedEvent as { item: ItemKey }).item;
  const deletedPath = pathsOf(
    placementsOf(state, deletedNote).map((placement) => placement.topicId)
  );
  const deletion = await db.connect();
  try {
    await deletion.query("begin");
    await deletion.query("delete from atomic_notes where id = $1", [deletedNote.slice(5)]);
    const left = await deletion.query("select 1 from topic_placements where note_id = $1", [
      deletedNote.slice(5)
    ]);
    assert.equal(left.rowCount, 0, "its placements left in the same transaction");
    const marked = await deletion.query<{ dirty: boolean }>(
      "select dirty from topic_stats where topic_id = any($1::uuid[])",
      [deletedPath]
    );
    assert.ok(
      marked.rows.length === deletedPath.length && marked.rows.every((row) => row.dirty),
      "its path is dirty in the same transaction"
    );
    await deletion.query("commit");
  } finally {
    deletion.release();
  }
  forget(deletedNote);
  const directNote = await recompute("note deletion");
  const engineDeleted = undoBlockers(
    state,
    config,
    placeSet,
    history.slice(history.indexOf(placeSet) + 1)
  );
  const deletedUndo = await repo.undoChangeSet({
    treeId: tree.id,
    changeSetId: placeSet.id,
    titleKey: "topics.changeSets.undo"
  });
  assert.equal(deletedUndo.kind, "blocked", "undoing the PLACE of a deleted note is blocked");
  const deletedBlockers = deletedUndo.kind === "blocked" ? deletedUndo.blockers : [];
  assert.ok(
    deletedBlockers.some(
      (blocker) => blocker.kind === "itemDeleted" && blocker.item === deletedNote
    ),
    "the blocker is itemDeleted"
  );
  assert.deepEqual(deletedBlockers, engineDeleted, "the engine reports the same blockers");
  // (b) Chunk replacement of a source's document deletes its notes; the source counts again (D8).
  const rechunked = 7;
  // Every registered note of the source, the later PLACE notes included.
  const notesOf = (source: number): ItemKey[] =>
    noteKeys.filter((key, note) => sourceOf(note) === source && state.items.has(key));
  const rechunkedNotes = notesOf(rechunked);
  const rechunkedSource = sourceKeys[rechunked] as ItemKey;
  const sourceTopic = placementsOf(state, rechunkedSource)[0]!.topicId;
  await createChunkRepository(db).replaceDocumentChunks(
    documentIds[rechunked]!,
    sourceIds[rechunked]!,
    [rewrittenChunk("Rewritten passage")]
  );
  const rechunkLeft = await db.query(
    "select 1 from topic_placements where note_id = any($1::uuid[])",
    [rechunkedNotes.map((key) => key.slice(5))]
  );
  assert.equal(rechunkLeft.rowCount, 0, "re-chunking removed the notes' placements");
  assert.ok(
    (await dirtyTopics()).includes(sourceTopic),
    "the root source's own path is dirty (D8)"
  );
  for (const key of rechunkedNotes) forget(key);
  const rechunk = await recompute("chunk replacement");
  // (c) Removing a source deletes it and its notes.
  const removed = 11;
  const removedNotes = notesOf(removed);
  assert.ok(
    await createSourceItemRepository(db).remove(sourceIds[removed]!),
    "the source is removed"
  );
  const removedLeft = await db.query(
    "select 1 from topic_placements where source_item_id = $1 or note_id = any($2::uuid[])",
    [sourceIds[removed], removedNotes.map((key) => key.slice(5))]
  );
  assert.equal(removedLeft.rowCount, 0, "source removal removed its placements and its notes'");
  for (const key of removedNotes) forget(key);
  forget(sourceKeys[removed] as ItemKey);
  const sourceRemoval = await recompute("source removal");
  report.deletion = {
    noteDeletion: directNote,
    itemDeletedBlockers: deletedBlockers.map((blocker) => blocker.kind),
    chunkReplacement: { notes: rechunkedNotes.length, ...rechunk },
    sourceRemoval: { notes: removedNotes.length, ...sourceRemoval }
  };

  // 11. Two concurrent applies serialize on the tree lock; the stale one is a conflict.
  const pinTarget = leafTopics(state).find((node) => node.management === "ai")!;
  const holdEditor = createTopicTreeEditor(state);
  pinTopic({ state, config, editor: holdEditor }, pinTarget.id);
  const holder = await db.connect();
  let waited = 0;
  try {
    await holder.query("begin");
    const first = await repo.applyChangeSet(
      {
        treeId: tree.id,
        expectedGeneration: generation,
        origin: "human",
        titleKey: "topics.changeSets.human",
        events: holdEditor.events
      },
      { client: holder }
    );
    assert.equal(first.kind, "applied", "the first apply holds the lock");
    const started = performance.now();
    const second = repo.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: generation,
      origin: "human",
      titleKey: "topics.changeSets.human",
      events: holdEditor.events
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    await holder.query("commit");
    const secondResult = await second;
    waited = ms(started);
    assert.ok(waited >= 300, "the second apply waited for the first");
    assert.deepEqual(
      secondResult,
      { kind: "conflict", reason: "generation", currentGeneration: generation + 1 },
      "the stale apply is a generation conflict"
    );
    generation += 1;
    state.generation = generation;
  } finally {
    holder.release();
  }
  const describe = (description: string | null, before: string | null): StructureEvent => ({
    op: "topic.describe",
    topicId: pinTarget.id,
    before: { description: before },
    after: { description }
  });
  const racers = await Promise.all(
    [0, 1].map(() =>
      repo.applyChangeSet({
        treeId: tree.id,
        expectedGeneration: generation,
        origin: "human",
        titleKey: "topics.changeSets.human",
        events: [describe("Pinned for the owner", null)]
      })
    )
  );
  assert.deepEqual(
    racers.map((result) => result.kind).sort(),
    ["applied", "conflict"],
    "of two concurrent applies on one generation, exactly one lands"
  );
  createTopicTreeEditor(state).describeTopic(pinTarget.id, "Pinned for the owner");
  generation += 1;
  state.generation = generation;
  assertSameDump(await dbDump(), canonicalStateDump(state), "after the concurrent applies");
  report.concurrency = { secondWaitedMs: waited, racers: racers.map((result) => result.kind) };

  // 12. Proposals, unplacing sources, logs.
  const renameTarget = leafTopics(state).find(
    (node) => node.management === "ai" && node.title === null
  )!;
  const proposal = await repo.applyChangeSet({
    treeId: tree.id,
    expectedGeneration: generation,
    origin: "areas",
    titleKey: "topics.changeSets.areas",
    status: "pending_review",
    risk: "high",
    events: [
      {
        op: "topic.rename",
        topicId: renameTarget.id,
        before: {
          title: null,
          nameState: "unnamed",
          nameSource: null,
          nameLanguage: null,
          namedChangeSetId: null,
          aliases: []
        },
        after: {
          title: "Área proposta",
          nameState: "named",
          nameSource: "llm",
          nameLanguage: "pt",
          namedChangeSetId: null,
          aliases: []
        }
      }
    ]
  });
  assert.equal(proposal.kind, "pending", "a proposal is recorded");
  assertSameDump(await dbDump(), canonicalStateDump(state), "a proposal changes nothing");
  const resolved = await repo.resolvePendingChangeSet({
    treeId: tree.id,
    changeSetId: proposal.kind === "pending" ? proposal.changeSetId : "",
    decision: "apply",
    expectedGeneration: generation
  });
  assert.equal(resolved.kind, "applied", "an approved proposal applies");
  createTopicTreeEditor(state).renameTopic(renameTarget.id, {
    title: "Área proposta",
    nameState: "named",
    nameSource: "llm",
    nameLanguage: "pt"
  });
  generation += 1;
  state.generation = generation;
  assertSameDump(await dbDump(), canonicalStateDump(state), "after applying the proposal");
  const unplaced = sourceKeys[3] as ItemKey;
  const unplace = await repo.unplaceForSources({
    treeId: tree.id,
    sourceIds: [sourceIds[3]!],
    origin: "place",
    titleKey: "topics.changeSets.unplace"
  });
  assert.equal(unplace.kind, "applied", "a source is unplaced as a change-set");
  const unplacedBefore = [...placementsOf(state, unplaced)];
  for (const placement of [...unplacedBefore].reverse()) {
    deletePlacement(state, unplaced, placement.rank);
  }
  generation += 1;
  state.generation = generation;
  assertSameDump(await dbDump(), canonicalStateDump(state), "after unplacing a source");
  const replace = await repo.undoChangeSet({
    treeId: tree.id,
    changeSetId: unplace.kind === "applied" ? unplace.changeSetId : "",
    titleKey: "topics.changeSets.undo"
  });
  assert.equal(replace.kind, "applied", "unplacing a source undoes");
  for (const placement of unplacedBefore) {
    createTopicTreeEditor(state, { record: false }).placeItem(unplaced, placement);
  }
  generation += 1;
  state.generation = generation;
  assertSameDump(await dbDump(), canonicalStateDump(state), "after undoing the unplace");
  await recompute("after the unplace round trip");
  const gateInput = {
    treeId: tree.id,
    item: noteKeys[0]!,
    itemHash: sha("item"),
    descriptorSetHash: sha("descriptors"),
    deciderKey: "mlx:qwen3-reranker-0.6b@test",
    candidates: [
      { topicId: leaf.id, descriptorHash: sha("d1"), cosine: 0.71, labelCosine: null, logOdds: 2.5 }
    ],
    chosenTopicId: leaf.id
  };
  const gateFirst = await repo.recordGateDecision(gateInput);
  const gateSecond = await repo.recordGateDecision({
    ...gateInput,
    chosenTopicId: null,
    candidates: []
  });
  assert.ok(!gateFirst.cached && gateSecond.cached, "the decision cache keeps the first decision");
  assert.equal(gateSecond.decision.chosenTopicId, leaf.id);
  await repo.upsertDailyMetrics({
    treeId: tree.id,
    day,
    increments: { opsApplied: 3, gateCalls: 1 },
    gauges: { unsortedShare: 0.02 }
  });
  const metrics = await repo.upsertDailyMetrics({
    treeId: tree.id,
    day,
    increments: { opsApplied: 2 },
    gauges: { meanDepth: 3.5 }
  });
  assert.deepEqual(
    [metrics.opsApplied, metrics.gateCalls, metrics.unsortedShare === 0.02, metrics.meanDepth],
    [5, 1, true, 3.5],
    "counters add, gauges keep what was not given"
  );
  const firstCalibration = await repo.saveCalibration({
    spaceKey: tree.spaceKey,
    deciderKey: null,
    params: { leaf: { target: 15 } },
    dataset: "seeds 7-12",
    activate: true
  });
  const secondCalibration = await repo.saveCalibration({
    spaceKey: tree.spaceKey,
    deciderKey: null,
    params: { leaf: { target: 14 } },
    dataset: "seeds 7-12",
    activate: true
  });
  assert.equal((await repo.activeCalibration(tree.spaceKey, null))?.id, secondCalibration.id);
  assert.notEqual(firstCalibration.id, secondCalibration.id);

  // 13. Re-chunking a document whose 4,000 notes are placed, against one whose notes are not.
  const bulk = async (placed: boolean) => {
    const source = randomUUID();
    const document = randomUUID();
    const chunks = Array.from({ length: 4_000 }, () => randomUUID());
    const notes = chunks.map(() => randomUUID());
    await db.query(
      "insert into source_items (id, type, title) values ($1, 'StandaloneArticle', 'Bulk')",
      [source]
    );
    await db.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Bulk', 'seed', $3)`,
      [document, source, sha(document)]
    );
    await db.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       select c, $2, $3, n::int, 'Passage', md5(c::text)
         from unnest($1::uuid[]) with ordinality as x(c, n)`,
      [chunks, document, source]
    );
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
          ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
          generation_provider, generation_model, generation_runtime, generation_prompt_version,
          generation_key)
       select n, 'Bulk', 'Body', 'Idea', 'active', 'current', 'source', $3, $3, c, 'seed', 'seed',
              'local', 'seed', n::text
         from unnest($1::uuid[], $2::uuid[]) as x(n, c)`,
      [notes, chunks, source]
    );
    let placeMs = 0;
    if (placed) {
      const start = performance.now();
      const result = await repo.applyChangeSet({
        treeId: tree.id,
        expectedGeneration: generation,
        origin: "place",
        titleKey: "topics.changeSets.place",
        events: notes.map((id) => ({
          op: "item.place" as const,
          item: itemKey("note", id),
          topicId: rootId,
          before: null,
          after: placementRecord(rootId, { decidedBy: "fallback" })
        }))
      });
      placeMs = ms(start);
      assert.equal(result.kind, "applied", "4,000 placements in one change-set");
      generation += 1;
    }
    const start = performance.now();
    await createChunkRepository(db).replaceDocumentChunks(document, source, [
      rewrittenChunk(`Rewritten ${document}`)
    ]);
    return { placeMs, rechunkMs: ms(start) };
  };
  const unplacedRechunk = await bulk(false);
  const placedRechunk = await bulk(true);
  assert.ok((await dirtyTopics()).includes(rootId), "the root is dirty after the bulk re-chunk");
  report.rechunk4000 = { unplacedNotes: unplacedRechunk, placedNotes: placedRechunk };

  // 14. Replacing the active tree in one transaction (R20, D26).
  const replacer = await db.connect();
  let replacementId = "";
  try {
    await replacer.query("begin");
    const replacement = await repo.replaceActiveTree(replacer, {
      spaceKey: "local:synthetic:768:replacement",
      embeddingProvider: "synthetic",
      embeddingModel: "gaussian-clusters-768",
      embeddingRuntime: "none",
      dimensions: 768,
      config: {},
      configHash: sha("replacement"),
      seed: 7
    });
    replacementId = replacement.id;
    assert.equal((await repo.activeTree())?.id, tree.id, "other sessions still see the old tree");
    await replacer.query("commit");
  } finally {
    replacer.release();
  }
  assert.equal((await repo.activeTree())?.id, replacementId, "the new tree is active");
  assert.equal((await repo.tree(tree.id))?.status, "retired", "the old tree is retired");
  const late = await repo.applyChangeSet({
    treeId: tree.id,
    expectedGeneration: generation,
    origin: "human",
    titleKey: "topics.changeSets.human",
    events: [describe(null, "Pinned for the owner")]
  });
  assert.equal(
    late.kind === "conflict" ? late.reason : late.kind,
    "treeRetired",
    "a retired tree takes no change-set"
  );

  // 15. The library reset clears every topic table.
  await createLibraryResetRepository(db).reset();
  const remaining: Record<string, number> = {};
  for (const table of topicTables) {
    const count = await db.query<{ count: number }>(`select count(*)::int as count from ${table}`);
    remaining[table] = Number(count.rows[0]?.count);
  }
  assert.ok(
    Object.values(remaining).every((count) => count === 0),
    "the reset empties the topic tables"
  );
  report.reset = remaining;

  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const pool of pools) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
