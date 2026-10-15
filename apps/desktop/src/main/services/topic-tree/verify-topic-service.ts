import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import {
  closePgPool,
  createPgPool,
  createTopicTreeLoadRepository,
  createTopicTreeRepository,
  noteVectorStrategyPrefix,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  stateFromRecords,
  topicLoadSql,
  topicStatsWrites,
  type PgPool,
  type Queryable,
  type TopicItemInfo,
  type TopicLoadSpace
} from "@app/db";
import {
  buildLouvain,
  canonicalStateDump,
  defaultTopicTreeConfig,
  gaussianClusters,
  getTopic,
  itemKey,
  liveTopicIds,
  parseItemKey,
  recomputeSubtree,
  rowOfItemKey,
  statsDump,
  topicRecordOf,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import type { ItemKey, PlacementRecord, TopicRecord } from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../workers/topic-communities.js";
import { JobSupervisor } from "../job-supervisor.js";
import { createTopicTreeServices } from "./index.js";
import { ItemVectorStore, loadTopicTreeCache } from "./topic-cache.js";
import { createStoredVectorSpaceResolver } from "./topic-space.js";

/**
 * Real-database proof of the topic service (F2 T15) on a temporary PostgreSQL sidecar: a synthetic
 * library of clustered notes under root sources with stored vectors, the active tree created from
 * the newest vector's space (D39), a Louvain build written through `bootstrapSnapshot` (as T19
 * will), then late notes placed by `topic-place` jobs on the job supervisor's light lane. It
 * measures the cache load, enqueue-to-done latency per root, the idempotent replay, the sweep and
 * the plans of the new loader reads, and checks reachability and that stored statistics are exact.
 *
 *   npx tsx apps/desktop/src/main/services/topic-tree/verify-topic-service.ts \
 *     [--notes 18000] [--dim 1024] [--roots 60] [--arrivals 600]
 */
const { values: args } = parseArgs({
  options: {
    notes: { type: "string", default: "18000" },
    dim: { type: "string", default: "1024" },
    roots: { type: "string", default: "60" },
    arrivals: { type: "string", default: "600" },
    "skip-analyze": { type: "boolean", default: false }
  }
});
const notes = Number(args.notes);
const dim = Number(args.dim) as 256 | 768 | 1024;
const rootCount = Number(args.roots);
const arrivals = Number(args.arrivals);
assert.ok([256, 768, 1024].includes(dim), "--dim is 256, 768 or 1024");
assert.ok(notes > arrivals && arrivals >= rootCount && rootCount >= 1, "notes > arrivals >= roots");

const workspace = resolve(import.meta.dirname, "../../../../../..");
const space: TopicLoadSpace = {
  spaceKey: `verify-topic-service-${dim}`,
  provider: "synthetic",
  model: `gaussian-clusters-${dim}`,
  runtime: "none",
  dimensions: dim
};
const seed = 20261014;
const config = topicTreeConfigWith({ jobs: { debounceMs: 0, debounceCapMs: 0 } });
const quiet = { info: () => undefined, warn: () => undefined, error: console.error };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const round = (value: number) => Math.round(value * 10) / 10;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);
};
const report: Record<string, unknown> = {
  notes,
  dim,
  roots: rootCount,
  arrivals,
  config: "start values, debounce 0",
  analyzedAfterBuild: !args["skip-analyze"]
};

const workDir = await mkdtemp(join(tmpdir(), "memora-topic-service-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_topic_service",
  user: "memora_topic_service",
  password: `topic-service-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
let pool: PgPool | null = null;

/** Runs EXPLAIN (analyze) on SQL with parameters and names the scans it uses. */
async function explain(db: PgPool, text: string, values: unknown[]) {
  const result = await db.query<{ "QUERY PLAN": unknown }>(
    `explain (format json, analyze) ${text}`,
    values
  );
  const plan = (result.rows[0]!["QUERY PLAN"] as Array<Record<string, unknown>>)[0]!;
  const scans: string[] = [];
  const walk = (node: Record<string, unknown>) => {
    const type = String(node["Node Type"]);
    if (type.includes("Scan"))
      scans.push(`${type}${node["Relation Name"] ? ` ${String(node["Relation Name"])}` : ""}`);
    for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? [])
      walk(child);
  };
  walk(plan.Plan as Record<string, unknown>);
  return { ms: round(Number(plan["Execution Time"])), scans: [...new Set(scans)].sort() };
}

try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 8 });
  const db = pool;
  await runMigrations(db, join(workspace, "packages/db/drizzle"), {
    seedFolder: join(workspace, "packages/db/seed")
  });

  // 1. A library: root sources with a document each, a chunk and a note per vector.
  const groups = Math.max(rootCount, 12);
  const clusters = gaussianClusters({
    groups,
    clustersPerGroup: 8,
    pointsPerCluster: Math.ceil(notes / (groups * 8)),
    dim,
    groupSpread: 0.7,
    pointNoise: 0.45,
    seed
  });
  const seedStarted = performance.now();
  const rootIds = Array.from({ length: rootCount }, () => randomUUID());
  await db.query(
    `insert into source_items (id, type, title, content_hash)
     select r.id, 'Book', 'Book ' || r.i, md5('source-' || r.i)
       from unnest($1::uuid[]) with ordinality as r(id, i)`,
    [rootIds]
  );
  await db.query(
    `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
     select gen_random_uuid(), r, 'Document', 'seed', md5(r::text) from unnest($1::uuid[]) as r`,
    [rootIds]
  );
  const noteIds = Array.from({ length: notes }, () => randomUUID());
  const rootOfRow = (row: number) => rootIds[(clusters.groups[row] as number) % rootCount]!;
  const strategy = `${noteVectorStrategyPrefix}${space.spaceKey}`;
  for (let start = 0; start < notes; start += 500) {
    const rows = Array.from({ length: Math.min(500, notes - start) }, (_, index) => start + index);
    const chunks = rows.map(() => randomUUID());
    await db.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       select t.chunk, d.id, t.root, t.row, 'Passage', md5(t.chunk::text)
         from unnest($1::uuid[], $2::uuid[], $3::int[]) as t(chunk, root, row)
         join documents d on d.source_item_id = t.root`,
      [chunks, rows.map(rootOfRow), rows]
    );
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, ownership,
         created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key)
       select t.id, 'Note', 'Body', 'Idea', 'source', t.root, t.chunk, 'proof', 'proof', 'proof',
              'proof', t.id::text
         from unnest($1::uuid[], $2::uuid[], $3::uuid[]) as t(id, root, chunk)`,
      [rows.map((row) => noteIds[row]!), rows.map(rootOfRow), chunks]
    );
    await db.query(
      `insert into embeddings_${dim} (target_type, target_id, provider, model, runtime, usage,
         strategy, content_hash, embedding)
       select 'atomic_note', t.id, $1, $2, $3, 'matching', $4, t.hash, t.vec::vector
         from unnest($5::uuid[], $6::text[], $7::text[]) as t(id, hash, vec)`,
      [
        space.provider,
        space.model,
        space.runtime,
        strategy,
        rows.map((row) => noteIds[row]!),
        rows.map((row) => sha(`note-${row}`)),
        rows.map((row) => {
          const parts = new Array<string>(dim);
          for (let k = 0; k < dim; k += 1)
            parts[k] = (clusters.matrix.data[row * dim + k] as number).toPrecision(9);
          return `[${parts.join(",")}]`;
        })
      ]
    );
  }
  report.seedMs = round(performance.now() - seedStarted);

  // 2. The service creates the active tree in the newest note vector's space (D39).
  let supervisor: JobSupervisor | null = null;
  const services = createTopicTreeServices({
    getPool: () => db,
    spaceResolver: createStoredVectorSpaceResolver(() => db),
    env: {},
    isPackaged: false,
    // As in the app: an enqueue wakes the light lane instead of waiting for its next poll.
    wake: () => supervisor?.wake("light"),
    logger: quiet,
    newTreeConfig: () => config,
    budgetStore: { read: async () => null, write: async () => undefined }
  });
  const ensured = await services.ensureActiveTree();
  assert.equal(ensured?.kind, "ready", "the tree exists");
  if (ensured?.kind !== "ready") throw new Error("unreachable");
  const tree = ensured.tree;
  assert.equal(tree.spaceKey, space.spaceKey, "in the newest vector's space");

  // 3. The cold-start build of every note but the arrivals, written as T19 will write it.
  const late = new Set<number>();
  for (let row = 0; late.size < arrivals; row += Math.floor(notes / arrivals))
    late.add(row % notes);
  const buildRows = Array.from({ length: notes }, (_, row) => row).filter((row) => !late.has(row));
  const buildStarted = performance.now();
  const built = buildLouvain(clusters.matrix, buildRows, {
    seed,
    config,
    detectCommunities: detectCommunitiesLouvain
  });
  report.buildMs = round(performance.now() - buildStarted);
  const topicId = new Map<string, string>([[built.state.rootId, tree.rootId]]);
  for (const id of liveTopicIds(built.state)) if (!topicId.has(id)) topicId.set(id, randomUUID());
  const keyOf = (rowKey: ItemKey) => itemKey("note", noteIds[rowOfItemKey(rowKey)!]!);
  const topics: TopicRecord[] = liveTopicIds(built.state)
    .filter((id) => id !== built.state.rootId)
    .map((id) => {
      const record = topicRecordOf(getTopic(built.state, id));
      return { ...record, id: topicId.get(id)!, parentId: topicId.get(record.parentId!)! };
    });
  const placements = [...built.state.placements].flatMap(([rowKey, list]) =>
    list.map((placement) => ({
      item: keyOf(rowKey),
      placement: {
        ...placement,
        topicId: topicId.get(placement.topicId)!,
        itemFingerprint: sha(`note-${rowOfItemKey(rowKey)}`)
      } satisfies PlacementRecord
    }))
  );
  const repository = createTopicTreeRepository(db);
  const records = await repository.readTreeRecords(tree.id);
  const entries = new Map<ItemKey, TopicItemInfo>();
  const store = new ItemVectorStore(dim, buildRows.length);
  for (const row of buildRows) {
    const key = itemKey("note", noteIds[row]!);
    entries.set(key, {
      kind: "note",
      contentHash: sha(`note-${row}`),
      rootSource: itemKey("source", rootOfRow(row))
    });
    store.set(key, clusters.matrix.data.subarray(row * dim, (row + 1) * dim));
  }
  const state = stateFromRecords(
    { tree, topics: [...records.topics, ...topics], placements },
    { entries, vectors: store }
  );
  recomputeSubtree(state, store);
  const snapshotStarted = performance.now();
  const snapshot = await repository.bootstrapSnapshot({
    treeId: tree.id,
    expectedGeneration: tree.generation,
    titleKey: "topics.changeSets.build",
    topics,
    placements,
    stats: topicStatsWrites(state, store, liveTopicIds(state)),
    clock: 0
  });
  assert.equal(snapshot.kind, "applied", "the build is written");
  // A bulk write leaves the planner without statistics until autovacuum analyzes the tables; the
  // pending reads then probe placements by tree and rank instead of by note (measured, T15).
  if (!args["skip-analyze"]) await db.query("analyze");
  report.build = {
    items: buildRows.length,
    topics: topics.length + 1,
    leaves: topics.filter((topic) => getTopic(state, topic.id).children.length === 0).length,
    snapshotMs: round(performance.now() - snapshotStarted)
  };

  // 4. Cold cache loads of the built tree.
  const loads: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = performance.now();
    const cache = await loadTopicTreeCache(db, tree.id);
    loads.push(performance.now() - started);
    assert.deepEqual(cache?.staleStoredStats, [], "the build's statistics are exact");
  }
  report.cacheLoadMs = { p50: percentile(loads, 50), max: percentile(loads, 100) };

  // 5. Late notes per root, placed by topic-place on the light lane (enqueue to done).
  supervisor = new JobSupervisor({
    getPool: () => db,
    lightJobs: services.jobs,
    pollIntervalMs: 500,
    logger: quiet
  });
  await supervisor.start();
  const before = await db.query<{ count: string }>(
    "select count(*)::text as count from topic_change_sets"
  );
  const lateByRoot = new Map<string, string[]>();
  for (const row of late) {
    const root = rootOfRow(row);
    lateByRoot.set(root, [...(lateByRoot.get(root) ?? []), noteIds[row]!]);
  }
  const placeStarted = performance.now();
  for (const ids of lateByRoot.values()) await services.triggers.notesChanged(ids);
  const waitForTopicJobs = async () => {
    const deadline = Date.now() + 600_000;
    for (;;) {
      const open = await db.query<{ count: string }>(
        "select count(*)::text as count from jobs where type like 'topic-%' and status in ('queued', 'running')"
      );
      if (Number(open.rows[0]!.count) === 0) return;
      assert.ok(Date.now() < deadline, "topic jobs finish");
      await new Promise((done) => setTimeout(done, 20));
    }
  };
  await waitForTopicJobs();
  const placeWallMs = performance.now() - placeStarted;
  const jobs = await db.query<{
    queuedMs: number;
    runMs: number;
    status: string;
    result: Record<string, unknown>;
  }>(
    `select extract(epoch from (finished_at - created_at)) * 1000 as "queuedMs",
            (result->>'ms')::float8 as "runMs", status, result
       from jobs where type = 'topic-place' order by finished_at`
  );
  assert.ok(
    jobs.rows.every((job) => job.status === "succeeded"),
    "every PLACE job succeeds"
  );
  const results = jobs.rows.map((job) => job.result);
  const sum = (field: string) =>
    results.reduce((total, result) => total + Number(result[field] ?? 0), 0);
  const spread = (values: number[]) => ({
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: percentile(values, 100)
  });
  report.place = {
    jobs: jobs.rowCount,
    // All roots' jobs were enqueued at once and one compute worker runs them in turn.
    enqueueToDoneMs: spread(jobs.rows.map((job) => Number(job.queuedMs))),
    // The first job loads the cache of the tree the build changed; the rest reuse it.
    firstRunMs: round(Number(jobs.rows[0]!.runMs)),
    runMs: spread(jobs.rows.slice(1).map((job) => Number(job.runMs))),
    wallMs: round(placeWallMs),
    placed: sum("placed"),
    needsGate: sum("needsGate"),
    unchanged: sum("unchanged"),
    statuses: [...new Set(results.map((result) => String(result.status)))]
  };
  assert.equal(sum("placed"), arrivals + rootCount, "every late note and every root is placed");

  // 6. Reachability, exact statistics and the cache against a fresh load.
  const orphans = await db.query<{ notes: string; roots: string }>(
    `select (select count(*) from atomic_notes a where not exists (
              select 1 from topic_placements p where p.note_id = a.id and p.rank = 0))::text as notes,
            (select count(*) from source_items s where s.parent_source_item_id is null and not exists (
              select 1 from topic_placements p where p.source_item_id = s.id and p.rank = 0))::text as roots`
  );
  assert.equal(Number(orphans.rows[0]!.notes), 0, "every note is reachable");
  assert.equal(Number(orphans.rows[0]!.roots), 0, "every root source is reachable");
  const fresh = (await loadTopicTreeCache(db, tree.id))!;
  assert.deepEqual(fresh.staleStoredStats, [], "stored statistics are exact after PLACE");
  const digest = services.service.cacheDigest();
  assert.equal(digest?.structure, canonicalStateDump(fresh.state), "the cache equals the database");
  assert.equal(digest?.stats, statsDump(fresh.state), "cached statistics are bit-equal");

  // 7. Replay: PLACE again for every root changes nothing.
  const changeSets = Number(
    (await db.query<{ count: string }>("select count(*)::text as count from topic_change_sets"))
      .rows[0]!.count
  );
  await services.triggers.place(
    tree.id,
    rootIds.map((rootSourceId) => ({ rootSourceId }))
  );
  await waitForTopicJobs();
  const replay = await db.query<{ status: string }>(
    `select result->>'status' as status from jobs where type = 'topic-place'
      order by created_at desc limit $1`,
    [rootCount]
  );
  assert.ok(
    replay.rows.every((row) => row.status === "no_change"),
    "the replay is a no-op"
  );
  const after = Number(
    (await db.query<{ count: string }>("select count(*)::text as count from topic_change_sets"))
      .rows[0]!.count
  );
  assert.equal(after, changeSets, "the replay writes no change-set");
  report.changeSets = {
    place: changeSets - Number(before.rows[0]!.count),
    replay: after - changeSets
  };

  // 8. The sweep over the whole tree.
  await supervisor.stop();
  const sweepStarted = performance.now();
  const sweep = await services.service.runSweep(
    { id: randomUUID(), payload: { treeId: tree.id, reason: "requested" } } as never,
    new AbortController().signal
  );
  report.sweep = { ms: round(performance.now() - sweepStarted), result: sweep };
  assert.equal(sweep.pending, 0, "nothing waits after PLACE");

  // 9. Plans of the loader reads this task added.
  const someNotes = noteIds.slice(0, 1_000);
  report.explain = {
    noteOwners: await explain(db, topicLoadSql.noteOwners, [someNotes]),
    sourceOwners: await explain(db, topicLoadSql.sourceOwners, [rootIds]),
    newestNoteSpace: await explain(db, topicLoadSql.newestNoteSpace, [])
  };
  const ownersStarted = performance.now();
  await createTopicTreeLoadRepository(db as Queryable).itemOwners({ noteIds });
  report.itemOwnersAllNotesMs = round(performance.now() - ownersStarted);
  const pendingStarted = performance.now();
  let pendingWindows = 0;
  for (let after: ItemKey | null = null; ; pendingWindows += 1) {
    const page = await createTopicTreeLoadRepository(db).pendingItems(tree.id, space, { after });
    after = page.next;
    if (after === null) break;
  }
  report.pendingLibraryScan = {
    ms: round(performance.now() - pendingStarted),
    windows: pendingWindows + 1
  };
  assert.ok(parseItemKey(itemKey("note", noteIds[0]!)), "keys round-trip");
  assert.equal(defaultTopicTreeConfig.bootstrap.minItems, 12, "the D39 threshold");

  services.dispose();
  console.info(JSON.stringify({ ok: true, ...report }, null, 2));
} finally {
  if (pool) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
