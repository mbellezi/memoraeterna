import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  closePgPool,
  createJobRepository,
  createLibraryResetRepository,
  createPgPool,
  createTopicTreeLoadRepository,
  createTopicTreeRepository,
  noteVectorStrategyPrefix,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  topicTreeRecordsDump,
  type PgPool,
  type TopicLoadSpace
} from "@app/db";
import {
  buildLouvain,
  checkTopicClusteringResult,
  gaussianClusters,
  getTopic,
  isLive,
  itemKey,
  parseItemKey,
  rowItemKey,
  shapeReport,
  smallLibraryPartition,
  topicClusteringRowOrder,
  TopicClusteringRequestSchema,
  topicTreeConfigWith,
  walkTopics
} from "@app/domain/topic-tree";
import type { ItemKey, TopicTreeConfig, TopicTreeState } from "@app/domain/topic-tree";

import { clusterTopics } from "../../workers/topic-clustering.worker.js";
import { detectCommunitiesLouvain } from "../../workers/topic-communities.js";
import { JobSupervisor } from "../job-supervisor.js";
import type { LightJobRegistry } from "../job-lanes.js";
import { WorkerSupervisor } from "../worker-supervisor.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices } from "./index.js";
import type { ClusterTopics } from "./topic-build.js";
import { loadTopicTreeCache, treeConfig } from "./topic-cache.js";
import { topicJobTypes } from "./topic-jobs.js";
import { createStoredVectorSpaceResolver, treeSpace } from "./topic-space.js";
import { structuralConfigHash } from "./topic-tree-service.js";
import { immediateDebounce } from "./topic-triggers.js";

/**
 * Real-database proof of the structure jobs (F2 T19). Two modes:
 *
 * Scratch (default), on a temporary PostgreSQL sidecar with a synthetic library of clustered
 * notes under root sources: the cold start of the whole library through the light lane (build
 * timings, ANALYZE, shape, reachability), its equality with the in-process Louvain build over the
 * same rows in content-key order, PLACE latency of late notes while a fake model job holds the
 * light lane's `model` worker (D33), REBALANCE and the audit, a structural configuration change
 * rebuilt with Hungarian mapping and undone exactly (D39), and a chapter-seeded book.
 *
 *   npx tsx apps/desktop/src/main/services/topic-tree/verify-topic-build.ts \
 *     [--notes 3000] [--dim 1024] [--roots 60] [--arrivals 300] [--gate-hold-ms 60000] [--worker]
 *
 * `--worker` clusters in the built worker thread (`npm run build -w @app/desktop` first).
 *
 * Read only (`--db <connection.json | postgres url>`): a profile's active tree is checked for
 * reachability and hard violations, and its last cold-start build is compared with the in-process
 * build of the same notes (content-key order, the tree's seed and configuration), as long as their
 * vectors are still the ones the build used. The session is read-only; nothing is written.
 */
const { values: args } = parseArgs({
  options: {
    notes: { type: "string", default: "3000" },
    dim: { type: "string", default: "1024" },
    roots: { type: "string", default: "60" },
    arrivals: { type: "string", default: "300" },
    "gate-hold-ms": { type: "string", default: "60000" },
    worker: { type: "boolean", default: false },
    db: { type: "string" }
  }
});

const workspace = resolve(import.meta.dirname, "../../../../../..");
const seed = 20261014;
const quiet = { info: () => undefined, warn: () => undefined, error: console.error };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const round = (value: number) => Math.round(value * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);
};
const spread = (values: number[]) => ({
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  max: percentile(values, 100)
});

/** The clustering worker's code in this process. */
const clusterInProcess: ClusterTopics = async (request) => {
  const parsed = TopicClusteringRequestSchema.parse(request);
  const result = clusterTopics(parsed);
  checkTopicClusteringResult(result, parsed);
  return result;
};

/** Each topic as its sorted note keys plus its children's forms: equal strings, equal trees. */
function notePartition(
  rootId: string,
  children: (id: string) => readonly string[],
  notes: (id: string) => readonly ItemKey[]
): string {
  const encode = (id: string): string =>
    `(${[...notes(id)].sort().join(",")}|${children(id).map(encode).sort().join("")})`;
  return encode(rootId);
}

function statePartition(state: TopicTreeState, keyOf: (item: ItemKey) => ItemKey | null) {
  return notePartition(
    state.rootId,
    (id) => getTopic(state, id).children,
    (id) =>
      getTopic(state, id)
        .items.map(keyOf)
        .filter((key): key is ItemKey => key !== null)
  );
}

/**
 * The partition the cold start would make of `notes` (content-key order, D22): in process for a
 * small library, else the Louvain builder over the same rows, seed and configuration.
 */
async function expectedPartition(
  pool: PgPool,
  space: TopicLoadSpace,
  notes: readonly { key: ItemKey; contentHash: string }[],
  config: TopicTreeConfig,
  treeSeed: number
): Promise<{ partition: string; rows: number; vectorsMatch: number }> {
  const order = topicClusteringRowOrder(notes);
  const loaded = await createTopicTreeLoadRepository(pool).loadItemVectors(
    space,
    order.keys.map((key) => ({ kind: "note" as const, id: parseItemKey(key)!.id }))
  );
  const hashes = new Map(notes.map((note) => [note.key, note.contentHash]));
  const vectorsMatch = loaded.keys.filter(
    (key, row) => hashes.get(key) === loaded.contentHashes[row]
  ).length;
  assert.deepEqual(loaded.keys, order.keys, "every built note still has its vector");
  const rows = order.keys.map((_, row) => row);
  const rowKey = new Map(order.keys.map((key, row) => [rowItemKey(row), key]));
  if (rows.length <= config.bootstrap.singleTopicMaxItems) {
    const small = smallLibraryPartition(
      loaded.matrix,
      rows,
      config,
      treeSeed,
      detectCommunitiesLouvain
    );
    const groups = new Map(small.groups.map((group, index) => [`g${index}`, group]));
    return {
      partition: notePartition(
        "root",
        (id) => (id === "root" ? [...groups.keys()] : []),
        (id) => (groups.get(id) ?? []).map((row) => order.keys[row]!)
      ),
      rows: rows.length,
      vectorsMatch
    };
  }
  const built = buildLouvain(loaded.matrix, rows, {
    seed: treeSeed,
    config,
    detectCommunities: detectCommunitiesLouvain
  });
  return {
    partition: statePartition(built.state, (item) => rowKey.get(item) ?? null),
    rows: rows.length,
    vectorsMatch
  };
}

// ---------------------------------------------------------------------------
// Read-only check of a profile (--db)

async function connectionString(value: string): Promise<string> {
  if (/^postgres(ql)?:\/\//iu.test(value)) return value;
  const parsed = JSON.parse(await readFile(value, "utf8")) as { connectionString?: unknown };
  if (typeof parsed.connectionString !== "string") {
    throw new Error(`${value} has no connectionString`);
  }
  return parsed.connectionString;
}

async function checkProfile(db: string): Promise<Record<string, unknown>> {
  // Every session of this pool is read-only (libpq `options`): nothing can be written.
  const url = new URL(await connectionString(db));
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  const pool = createPgPool({ connectionString: url.toString(), max: 2 });
  try {
    const repository = createTopicTreeRepository(pool);
    const tree = await repository.activeTree();
    assert.ok(tree, "the profile has an active tree");
    const cache = await loadTopicTreeCache(pool, tree.id);
    assert.ok(cache, "the tree loads");
    const config = treeConfig(tree);
    // Stale statistics are either flagged dirty (a cascade, D32) or differ from the recompute.
    const dirty = await pool.query<{ count: string }>(
      `select count(*)::text as count from topic_stats s join topics t on t.id = s.topic_id
        where t.tree_id = $1 and t.retired_at is null and s.dirty`,
      [tree.id]
    );
    const unplaced = await pool.query<{ notes: string; roots: string }>(
      `select (select count(*) from atomic_notes a
                where a.status not in ('rejected', 'archived') and a.supersession_status = 'current'
                  and not exists (select 1 from topic_placements p
                                   where p.note_id = a.id and p.tree_id = $1 and p.rank = 0))::text as notes,
              (select count(*) from source_items s where s.parent_source_item_id is null
                  and not exists (select 1 from topic_placements p
                                   where p.source_item_id = s.id and p.tree_id = $1 and p.rank = 0))::text as roots`,
      [tree.id]
    );
    const report = shapeReport(cache.state, config);
    const output: Record<string, unknown> = {
      treeId: tree.id,
      generation: tree.generation,
      configHash: tree.configHash,
      items: cache.state.items.size,
      unplacedNotes: Number(unplaced.rows[0]!.notes),
      unplacedRoots: Number(unplaced.rows[0]!.roots),
      reachability: report.reachability,
      hardViolations: report.violations.hardCount,
      topics: report.topics - 1,
      leaves: report.leaves,
      meanDepth: round3(report.itemDepth.mean),
      fanOutInTarget: round3(report.fanOut.inTarget),
      unsortedShare: report.unsortedShare,
      staleStoredStats: cache.staleStoredStats.length,
      dirtyStoredStats: Number(dirty.rows[0]!.count)
    };
    const build = await repository.latestStructureBuild(tree.id);
    if (!build || build.origin !== "build") {
      output.parity = "no cold-start build to compare";
      return output;
    }
    if (build.summary.seeded) {
      output.parity = "chapter-seeded build: not compared";
      return output;
    }
    // The build as written: its topics and the notes it placed.
    const events = await repository.changeSetEvents(build.changeSetId);
    const parent = new Map<string, string>();
    const noteTopic = new Map<ItemKey, string>();
    const fingerprints: { key: ItemKey; contentHash: string }[] = [];
    for (const event of events) {
      if (event.op === "topic.create" && event.after)
        parent.set(event.topicId, event.after.parentId!);
      if ((event.op === "item.place" || event.op === "item.move") && event.after?.rank === 0) {
        if (!event.item.startsWith("note:") || event.after.decidedBy !== "build") continue;
        noteTopic.set(event.item, event.after.topicId);
        fingerprints.push({ key: event.item, contentHash: event.after.itemFingerprint ?? "" });
      }
    }
    const childrenOf = new Map<string, string[]>();
    for (const [id, parentId] of parent) {
      childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), id]);
    }
    const notesOf = new Map<string, ItemKey[]>();
    for (const [key, topicId] of noteTopic)
      notesOf.set(topicId, [...(notesOf.get(topicId) ?? []), key]);
    const stored = notePartition(
      tree.rootId,
      (id) => childrenOf.get(id) ?? [],
      (id) => notesOf.get(id) ?? []
    );
    const expected = await expectedPartition(
      pool,
      treeSpace(tree),
      fingerprints,
      config,
      tree.seed
    );
    output.parity = {
      buildChangeSet: build.changeSetId,
      rows: expected.rows,
      vectorsUnchanged: expected.vectorsMatch,
      equal: stored === expected.partition
    };
    return output;
  } finally {
    await closePgPool(pool);
  }
}

// ---------------------------------------------------------------------------
// Scratch proof

/** What the scratch proof measured so far (printed when a check fails). */
const progress: Record<string, unknown> = {};

async function scratchProof(): Promise<Record<string, unknown>> {
  const notes = Number(args.notes);
  const dim = Number(args.dim) as 256 | 768 | 1024;
  const rootCount = Number(args.roots);
  const arrivals = Number(args.arrivals);
  const gateHoldMs = Number(args["gate-hold-ms"]);
  assert.ok([256, 768, 1024].includes(dim), "--dim is 256, 768 or 1024");
  assert.ok(
    notes > arrivals && arrivals >= rootCount && rootCount >= 1,
    "notes > arrivals >= roots"
  );
  const space: TopicLoadSpace = {
    spaceKey: `verify-topic-build-${dim}`,
    provider: "synthetic",
    model: `gaussian-clusters-${dim}`,
    runtime: "none",
    dimensions: dim
  };
  // Start values with a 1 s debounce, so late notes wait as in the app but the proof stays short.
  const debounceMs = 1_000;
  let config = topicTreeConfigWith({ jobs: { debounceMs, debounceCapMs: 6 * debounceMs } });
  const report = progress;
  Object.assign(report, {
    notes,
    dim,
    roots: rootCount,
    arrivals,
    debounceMs,
    gateHoldMs,
    clustering: "in-process"
  });

  let cluster = clusterInProcess;
  let workers: WorkerSupervisor | null = null;
  if (args.worker) {
    const host = resolve(workspace, "apps/desktop/out/main/workers/worker-host.js");
    assert.ok(existsSync(host), `${host} is missing: run "npm run build -w @app/desktop" first`);
    const supervisor = new WorkerSupervisor({ workerUrl: pathToFileURL(host) });
    workers = supervisor;
    cluster = (request, signal) => supervisor.clusterTopics(request, { signal });
    report.clustering = "worker thread (built host)";
  }

  const workDir = await mkdtemp(join(tmpdir(), "memora-topic-build-"));
  const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
  const manager = new PostgresSidecarManager({
    binDir: sidecar.binDir,
    dataDir: join(workDir, "data"),
    database: "memora_topic_build",
    user: "memora_topic_build",
    password: `topic-build-${randomUUID()}`,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 10_000
  });
  let pool: PgPool | null = null;
  let services: TopicTreeServices | null = null;
  let supervisor: JobSupervisor | null = null;
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
    const rootIds = Array.from({ length: rootCount }, () => randomUUID());
    const strategy = `${noteVectorStrategyPrefix}${space.spaceKey}`;
    const noteIds = Array.from({ length: notes }, () => randomUUID());
    const rootOfRow = (row: number) => rootIds[(clusters.groups[row] as number) % rootCount]!;
    const insertRoots = async (ids: string[], parent: string | null = null, prefix = "Book") => {
      await db.query(
        `insert into source_items (id, type, title, content_hash, parent_source_item_id)
         select r.id, $3::source_item_type, $4::text || ' ' || r.i, md5($4::text || r.id::text),
                $2::uuid
           from unnest($1::uuid[]) with ordinality as r(id, i)`,
        [ids, parent, parent ? "BookChapter" : "Book", prefix]
      );
      await db.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         select gen_random_uuid(), r, 'Document', 'seed', md5(r::text) from unnest($1::uuid[]) as r`,
        [ids]
      );
    };
    const insertNotes = async (
      rows: readonly number[],
      ownerOf: (row: number) => string,
      idOf: (row: number) => string,
      hashOf: (row: number) => string,
      data: Float32Array
    ) => {
      for (let start = 0; start < rows.length; start += 500) {
        const page = rows.slice(start, start + 500);
        const chunks = page.map(() => randomUUID());
        await db.query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
           select t.chunk, d.id, t.owner, t.row, 'Passage', md5(t.chunk::text)
             from unnest($1::uuid[], $2::uuid[], $3::int[]) as t(chunk, owner, row)
             join documents d on d.source_item_id = t.owner`,
          [chunks, page.map(ownerOf), page]
        );
        await db.query(
          `insert into atomic_notes (id, title, body_markdown, idea_statement, ownership,
             created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
             generation_runtime, generation_prompt_version, generation_key)
           select t.id, 'Note', 'Body', 'Idea', 'source', t.owner, t.chunk, 'proof', 'proof', 'proof',
                  'proof', t.id::text
             from unnest($1::uuid[], $2::uuid[], $3::uuid[]) as t(id, owner, chunk)`,
          [page.map(idOf), page.map(ownerOf), chunks]
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
            page.map(idOf),
            page.map(hashOf),
            page.map((row) => {
              const parts = new Array<string>(dim);
              for (let k = 0; k < dim; k += 1)
                parts[k] = (data[row * dim + k] as number).toPrecision(9);
              return `[${parts.join(",")}]`;
            })
          ]
        );
      }
    };
    const late = new Set<number>();
    for (let row = 0; late.size < arrivals; row += Math.floor(notes / arrivals))
      late.add(row % notes);
    const early = Array.from({ length: notes }, (_, row) => row).filter((row) => !late.has(row));
    const seedStarted = performance.now();
    await insertRoots(rootIds);
    await insertNotes(
      early,
      rootOfRow,
      (row) => noteIds[row]!,
      (row) => sha(`note-${row}`),
      clusters.matrix.data
    );
    report.seedMs = round(performance.now() - seedStarted);

    // 2. Services and the light lane, as in the app; a fake model job can hold the model worker.
    let releaseGate: (() => void) | null = null;
    const gateStarted: number[] = [];
    services = createTopicTreeServices({
      getPool: () => db,
      spaceResolver: createStoredVectorSpaceResolver(() => db),
      env: {},
      isPackaged: false,
      wake: () => supervisor?.wake("light"),
      logger: quiet,
      newTreeConfig: () => config,
      clusterTopics: cluster,
      budgetStore: { read: async () => null, write: async () => undefined }
    });
    const lightJobs: LightJobRegistry = {
      ...services.jobs,
      // A stand-in model call: holds the `model` worker until released (D33).
      [topicJobTypes.gate]: {
        needsModel: true,
        execute: () =>
          new Promise((done) => {
            gateStarted.push(performance.now());
            const timer = setTimeout(() => done({ status: "held", ms: gateHoldMs }), gateHoldMs);
            releaseGate = () => {
              clearTimeout(timer);
              done({ status: "released" });
            };
          })
      }
    };
    supervisor = new JobSupervisor({
      getPool: () => db,
      lightJobs,
      pollIntervalMs: 200,
      logger: quiet
    });
    const ensured = await services.ensureActiveTree();
    assert.equal(ensured?.kind, "ready", "the tree exists");
    if (ensured?.kind !== "ready") throw new Error("unreachable");
    const tree = ensured.tree;
    await supervisor.start();

    const jobsOf = async (type: string, since: Date) =>
      (
        await db.query<{ status: string; result: Record<string, unknown>; queuedMs: number }>(
          `select status, result, extract(epoch from (finished_at - created_at)) * 1000 as "queuedMs"
             from jobs where type = $1 and created_at >= $2 order by created_at`,
          [type, since]
        )
      ).rows;
    const waitFor = async (check: () => Promise<boolean>, what: string, timeoutMs = 900_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await check())) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((done) => setTimeout(done, 50));
      }
    };
    const idle = (types: readonly string[]) => async () =>
      Number(
        (
          await db.query<{ count: string }>(
            `select count(*)::text as count from jobs
              where type = any($1) and status in ('queued', 'running') and run_after <= now()`,
            [types]
          )
        ).rows[0]!.count
      ) === 0;

    // 3. The cold start: PLACE of every root waits for one build (D39).
    const coldStarted = new Date();
    const wallStarted = performance.now();
    await services.triggers.place(
      tree.id,
      rootIds.map((rootSourceId) => ({ rootSourceId })),
      { debounce: immediateDebounce }
    );
    await waitFor(
      async () =>
        (await jobsOf(topicJobTypes.build, coldStarted)).some(
          (job) => job.status === "succeeded"
        ) && (await idle([topicJobTypes.place, topicJobTypes.sweep, topicJobTypes.build])()),
      "the cold start"
    );
    report.coldStartWallMs = round(performance.now() - wallStarted);
    const builds = await jobsOf(topicJobTypes.build, coldStarted);
    const build = builds.find((job) => job.result?.status === "applied")?.result;
    assert.ok(build, `a build applied: ${JSON.stringify(builds.map((job) => job.result))}`);
    report.build = {
      method: build.method,
      rows: build.rows,
      topics: build.topics,
      leaves: build.leaves,
      level2Topics: build.level2Topics,
      meanDepth: build.meanDepth,
      fanOutInTarget: build.fanOutInTarget,
      hardViolations: build.hardViolations,
      seeded: build.seeded,
      timings: build.timings,
      jobMs: build.ms,
      buildJobs: builds.map((job) => job.result?.status)
    };

    const reachability = async () => {
      const result = await db.query<{ notes: string; roots: string }>(
        `select (select count(*) from atomic_notes a where not exists (
                  select 1 from topic_placements p where p.note_id = a.id and p.rank = 0))::text as notes,
                (select count(*) from source_items s where s.parent_source_item_id is null and not exists (
                  select 1 from topic_placements p where p.source_item_id = s.id and p.rank = 0))::text as roots`
      );
      return {
        unplacedNotes: Number(result.rows[0]!.notes),
        unplacedRoots: Number(result.rows[0]!.roots)
      };
    };
    const shape = async () => {
      const cache = (await loadTopicTreeCache(db, tree.id))!;
      const shaped = shapeReport(cache.state, config);
      return {
        cache,
        reachability: shaped.reachability,
        hardViolations: shaped.violations.hardCount,
        staleStoredStats: cache.staleStoredStats.length
      };
    };
    const afterBuild = await shape();
    report.afterBuild = {
      ...(await reachability()),
      reachability: afterBuild.reachability,
      hardViolations: afterBuild.hardViolations,
      staleStoredStats: afterBuild.staleStoredStats
    };
    assert.deepEqual(
      await reachability(),
      { unplacedNotes: 0, unplacedRoots: 0 },
      "E1 after the build"
    );
    assert.equal(afterBuild.hardViolations, 0, "0 hard violations after the build");
    assert.equal(
      afterBuild.staleStoredStats,
      0,
      "stored statistics are exact after the build and its sweep (D7)"
    );

    // 4. Parity: the stored partition of the notes equals the in-process build of the same rows.
    const builtNotes = early.map((row) => ({
      key: itemKey("note", noteIds[row]!),
      contentHash: sha(`note-${row}`)
    }));
    const changeSet = (await createTopicTreeRepository(db).latestStructureBuild(tree.id))!;
    const events = await createTopicTreeRepository(db).changeSetEvents(changeSet.changeSetId);
    const parent = new Map<string, string>();
    const noteTopic = new Map<ItemKey, string>();
    for (const event of events) {
      if (event.op === "topic.create" && event.after)
        parent.set(event.topicId, event.after.parentId!);
      if ((event.op === "item.place" || event.op === "item.move") && event.after?.rank === 0) {
        if (event.item.startsWith("note:")) noteTopic.set(event.item, event.after.topicId);
      }
    }
    const childrenOf = new Map<string, string[]>();
    for (const [id, parentId] of parent)
      childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), id]);
    const notesOf = new Map<string, ItemKey[]>();
    for (const [key, topicId] of noteTopic)
      notesOf.set(topicId, [...(notesOf.get(topicId) ?? []), key]);
    const stored = notePartition(
      tree.rootId,
      (id) => childrenOf.get(id) ?? [],
      (id) => notesOf.get(id) ?? []
    );
    const expected = await expectedPartition(db, space, builtNotes, config, tree.seed);
    report.parity = { rows: expected.rows, equal: stored === expected.partition };
    assert.equal(stored, expected.partition, "the build equals the in-process Louvain build");
    // The read-only profile check (`--db`) on this cluster reaches the same verdict.
    const profile = await checkProfile(connection.connectionString);
    report.profileCheck = profile;
    const profileParity = profile.parity as { equal?: boolean } | string;
    assert.ok(
      typeof profileParity === "object" && profileParity.equal === true,
      "the read-only profile check agrees"
    );

    // 5. PLACE latency of late notes while a fake model call holds the model worker (D33).
    await createJobRepository(db).enqueueDeduped({
      type: topicJobTypes.gate,
      lane: "light",
      dedupeKey: `topic-gate:${tree.id}:hold`,
      payload: { treeId: tree.id, noteId: randomUUID() },
      debounce: immediateDebounce
    });
    supervisor.wake("light");
    await waitFor(async () => gateStarted.length > 0, "the model worker to be held", 30_000);
    const lateStarted = new Date();
    const lateByRoot = new Map<string, number[]>();
    for (const row of late)
      lateByRoot.set(rootOfRow(row), [...(lateByRoot.get(rootOfRow(row)) ?? []), row]);
    const lateRoots = [...lateByRoot.keys()];
    const placeDone = async (since: Date, expected: number) => {
      const jobs = await jobsOf(topicJobTypes.place, since);
      return (
        jobs.length >= expected &&
        jobs.every((job) => job.status !== "queued" && job.status !== "running")
      );
    };
    const arrive = async (roots: readonly string[]) => {
      const rows = roots.flatMap((root) => lateByRoot.get(root) ?? []);
      await insertNotes(
        rows,
        rootOfRow,
        (row) => noteIds[row]!,
        (row) => sha(`note-${row}`),
        clusters.matrix.data
      );
      for (const root of roots) {
        await services!.triggers.notesChanged(
          (lateByRoot.get(root) ?? []).map((row) => noteIds[row]!)
        );
      }
    };
    // 5a. One source at a time (the spec's case: one import while the model worker is held).
    const perSource: number[] = [];
    const perSourceRun: number[] = [];
    const single = lateRoots.slice(0, Math.min(10, lateRoots.length - 1));
    for (const root of single) {
      const since = new Date();
      await arrive([root]);
      await waitFor(() => placeDone(since, 1), "PLACE of one source");
      const [job] = (await jobsOf(topicJobTypes.place, since)).filter(
        (entry) => entry.status === "succeeded"
      );
      perSource.push(Number(job?.queuedMs));
      perSourceRun.push(Number(job?.result?.ms ?? 0));
    }
    // 5b. Every other root at once (a burst on the one compute worker; reported, not a bar).
    const burstStarted = new Date();
    const burst = lateRoots.slice(single.length);
    await arrive(burst);
    await waitFor(() => placeDone(burstStarted, burst.length), "the burst of PLACE");
    const lateJobs = await jobsOf(topicJobTypes.place, lateStarted);
    report.lateJobStatuses = Object.fromEntries(
      [...new Set(lateJobs.map((job) => `${job.status}/${String(job.result?.status)}`))].map(
        (key) => [
          key,
          lateJobs.filter((job) => `${job.status}/${String(job.result?.status)}` === key).length
        ]
      )
    );
    const burstJobs = (await jobsOf(topicJobTypes.place, burstStarted)).filter(
      (job) => job.status === "succeeded"
    );
    const gateHeldThroughout = performance.now() - gateStarted[0]! < gateHoldMs;
    report.placeWhileModelHeld = {
      bar: debounceMs + 5_000,
      modelWorkerStillHeld: gateHeldThroughout,
      oneSourceAtATime: {
        sources: perSource.length,
        enqueueToDoneMs: spread(perSource),
        runMs: spread(perSourceRun)
      },
      burst: {
        sources: burstJobs.length,
        enqueueToDoneMs: spread(burstJobs.map((job) => Number(job.queuedMs))),
        runMs: spread(burstJobs.map((job) => Number(job.result?.ms ?? 0)))
      },
      placed: lateJobs.reduce((total, job) => total + Number(job.result?.placed ?? 0), 0)
    };
    assert.ok(gateHeldThroughout, "the model worker was held for the whole measurement");
    assert.ok(
      percentile(perSource, 95) <= debounceMs + 5_000,
      "PLACE enqueue-to-done p95 within debounce + 5 s per source while the model worker is held"
    );
    (releaseGate as (() => void) | null)?.();

    // 6. REBALANCE (asked for by PLACE) and the audit.
    const rebalanceStarted = new Date(lateStarted.getTime() - 1);
    await db.query(
      "update jobs set run_after = now() where type in ('topic-rebalance', 'topic-audit') and status = 'queued'"
    );
    supervisor.wake("light");
    await waitFor(
      idle([topicJobTypes.rebalance, topicJobTypes.audit, topicJobTypes.sweep]),
      "REBALANCE and the audit"
    );
    const rebalances = await jobsOf(topicJobTypes.rebalance, rebalanceStarted);
    const audits = await jobsOf(topicJobTypes.audit, coldStarted);
    report.rebalance = rebalances.map((job) => ({
      status: job.result?.status,
      operations: job.result?.operations,
      movedItems: job.result?.movedItems,
      proposals: job.result?.proposals,
      engineMs: job.result?.engineMs,
      ms: job.result?.ms
    }));
    report.audit = audits.map((job) => ({
      status: job.result?.status,
      hardViolations: job.result?.hardViolations,
      misParented: job.result?.misParented,
      unsortedShare: job.result?.unsortedShare,
      rebuild: job.result?.rebuild,
      engineMs: job.result?.engineMs,
      ms: job.result?.ms
    }));
    const afterGrowth = await shape();
    report.afterGrowth = {
      ...(await reachability()),
      hardViolations: afterGrowth.hardViolations,
      staleStoredStats: afterGrowth.staleStoredStats
    };
    assert.deepEqual(
      await reachability(),
      { unplacedNotes: 0, unplacedRoots: 0 },
      "E1 after growth"
    );

    // 7. A structural configuration change: one Hungarian-mapped rebuild, undone exactly (D39).
    const repository = createTopicTreeRepository(db);
    const beforeRebuild = topicTreeRecordsDump(await repository.readTreeRecords(tree.id));
    const liveBefore = new Set(
      [...afterGrowth.cache.state.topics.values()]
        .filter((node) => isLive(node))
        .map((node) => node.id)
    );
    config = topicTreeConfigWith({ leaf: { target: 14 } }, config);
    const rebuildStarted = new Date();
    await services.triggers.request(topicJobTypes.audit, tree.id, null, {
      debounce: immediateDebounce
    });
    await waitFor(
      async () =>
        (await jobsOf(topicJobTypes.build, rebuildStarted)).some(
          (job) => job.status === "succeeded"
        ) && (await idle([topicJobTypes.build, topicJobTypes.audit, topicJobTypes.sweep])()),
      "the configuration rebuild"
    );
    const rebuild = (await jobsOf(topicJobTypes.build, rebuildStarted)).find(
      (job) => job.result?.kind === "rebuild"
    )?.result;
    assert.ok(rebuild, "a rebuild ran");
    // Nothing may land on top of the rebuild before its undo.
    await supervisor.stop();
    const after = (await repository.activeTree())!;
    const liveAfter = (await loadTopicTreeCache(db, tree.id))!;
    const kept = [...liveAfter.state.topics.values()].filter(
      (node) => isLive(node) && liveBefore.has(node.id)
    ).length;
    report.configRebuild = {
      status: rebuild.status,
      reason: rebuild.reason,
      matched: rebuild.matched,
      created: rebuild.created,
      retired: rebuild.retired,
      topicsKept: kept,
      topicsBefore: liveBefore.size,
      movedShare: rebuild.movedShare,
      exactMatching: rebuild.exactMatching,
      configHashStored: after.configHash === structuralConfigHash(config),
      timings: rebuild.timings,
      jobMs: rebuild.ms
    };
    assert.equal(rebuild.status, "applied", "the configuration rebuild applies");
    const undoStarted = performance.now();
    const undone = await repository.undoChangeSet({
      treeId: tree.id,
      changeSetId: String(rebuild.changeSetId),
      titleKey: "topics.changeSets.undo"
    });
    const undoExact =
      undone.kind === "applied" &&
      topicTreeRecordsDump(await repository.readTreeRecords(tree.id)) === beforeRebuild;
    (report.configRebuild as Record<string, unknown>).undo = {
      kind: undone.kind,
      exact: undoExact,
      ms: round(performance.now() - undoStarted)
    };
    assert.ok(undoExact, "undoing the rebuild restores the tree exactly");

    // 8. A chapter-seeded book: the majority-chapter share of each leaf.
    await supervisor.stop();
    await createLibraryResetRepository(db).reset();
    services.service.invalidate();
    config = topicTreeConfigWith({ jobs: { debounceMs, debounceCapMs: 6 * debounceMs } });
    const chapters = 8;
    const perChapter = 40;
    const book = gaussianClusters({
      groups: chapters,
      clustersPerGroup: 2,
      pointsPerCluster: perChapter / 2,
      dim,
      groupSpread: 0.6,
      pointNoise: 0.45,
      seed: seed + 1
    });
    const bookId = randomUUID();
    const chapterIds = Array.from({ length: chapters }, () => randomUUID());
    await insertRoots([bookId]);
    await insertRoots(chapterIds, bookId, "Chapter");
    const bookNotes = Array.from({ length: chapters * perChapter }, () => randomUUID());
    const chapterOfRow = (row: number) => chapterIds[book.groups[row] as number]!;
    await insertNotes(
      bookNotes.map((_, row) => row),
      chapterOfRow,
      (row) => bookNotes[row]!,
      (row) => sha(`book-${row}`),
      book.matrix.data
    );
    const bookTree = await services.ensureActiveTree();
    assert.equal(bookTree?.kind, "ready", "a tree for the book");
    if (bookTree?.kind !== "ready") throw new Error("unreachable");
    await supervisor.start();
    const bookStarted = new Date();
    await services.triggers.place(bookTree.tree.id, [{ rootSourceId: bookId }], {
      debounce: immediateDebounce
    });
    await waitFor(
      async () =>
        (await jobsOf(topicJobTypes.build, bookStarted)).some(
          (job) => job.status === "succeeded"
        ) && (await idle([topicJobTypes.place, topicJobTypes.sweep, topicJobTypes.build])()),
      "the book's cold start"
    );
    const bookBuild = (await jobsOf(topicJobTypes.build, bookStarted)).find(
      (job) => job.result?.status === "applied"
    )?.result;
    const bookCache = (await loadTopicTreeCache(db, bookTree.tree.id))!;
    const chapterOfNote = new Map(
      bookNotes.map((id, row) => [itemKey("note", id), chapterOfRow(row)])
    );
    let majority = 0;
    let total = 0;
    const leafShares: number[] = [];
    walkTopics(bookCache.state, (node) => {
      if (node.children.length > 0) return;
      const counts = new Map<string, number>();
      for (const item of node.items) {
        const chapter = chapterOfNote.get(item);
        if (chapter) counts.set(chapter, (counts.get(chapter) ?? 0) + 1);
      }
      const values = [...counts.values()];
      if (values.length === 0) return;
      const sum = values.reduce((a, b) => a + b, 0);
      majority += Math.max(...values);
      total += sum;
      leafShares.push(Math.max(...values) / sum);
    });
    report.chapterSeeding = {
      chapters,
      notes: chapters * perChapter,
      seeded: bookBuild?.seeded,
      leaves: leafShares.length,
      majorityChapterShare: total > 0 ? round3(majority / total) : null,
      leafShareMin: leafShares.length > 0 ? round3(Math.min(...leafShares)) : null
    };
    return report;
  } finally {
    await supervisor?.stop().catch(() => undefined);
    services?.dispose();
    await workers?.shutdown();
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
}

try {
  const result = args.db ? await checkProfile(args.db) : await scratchProof();
  console.info(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.info(JSON.stringify({ ok: false, ...progress }, null, 2));
  throw error;
}
