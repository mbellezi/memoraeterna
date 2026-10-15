import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  type JobRecord,
  type PgPool,
  type PostgresSidecarConnection,
  type TopicLoadSpace
} from "@app/db";
import {
  buildLouvain,
  canonicalStateDump,
  checkTopicClusteringResult,
  gaussianClusters,
  getTopic,
  itemKey,
  placementRecord,
  rowItemKey,
  shapeReport,
  statsDump,
  topicClusteringRowOrder,
  TopicClusteringRequestSchema,
  topicTreeConfigWith,
  walkTopics
} from "@app/domain/topic-tree";
import type { ItemKey, TopicTreeConfig, TopicTreeState } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clusterTopics } from "../../workers/topic-clustering.worker.js";
import { detectCommunitiesLouvain } from "../../workers/topic-communities.js";
import { JobSupervisor } from "../job-supervisor.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices } from "./index.js";
import { TopicStructureJobs } from "./topic-build.js";
import type { ClusterTopics } from "./topic-build.js";
import { loadTopicTreeCache } from "./topic-cache.js";
import { topicJobTypes } from "./topic-jobs.js";
import { createStoredVectorSpaceResolver } from "./topic-space.js";
import type { SpaceResolution } from "./topic-space.js";
import { structuralConfigHash } from "./topic-tree-service.js";
import { TopicTriggers, immediateDebounce } from "./topic-triggers.js";

/**
 * The structure jobs (T19) on the real schema and a throwaway PostgreSQL sidecar: the cold start
 * of a small and of a large library (equal to the in-process Louvain build over content-key rows),
 * chapter seeding, the follow-up jobs, REBALANCE, the audit, a structural configuration change
 * rebuilt with Hungarian mapping and undone exactly, a pinned subtree in a rebuild, and a changed
 * embedding space. Clustering runs the worker's code in process.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const seed = 20261014;
const space: TopicLoadSpace = {
  spaceKey: "topic-build-test-space",
  provider: "test",
  model: "synthetic-256",
  runtime: "none",
  dimensions: dim
};
/** Shape limits small enough for about a hundred notes to make a tree of depth 2-4. */
const baseConfig: TopicTreeConfig = topicTreeConfigWith({
  fanOut: { min: 2, max: 4, targetMin: 2, targetMax: 3, hardMax: 6, rootTarget: 3 },
  leaf: { min: 2, max: 6, target: 4, hardMax: 12, minForTargetFanOut: 2 },
  depth: { target: 3, cap: 5 },
  areas: { min: 2, max: 4, target: 3, minLevel2Topics: 4 },
  bootstrap: { singleTopicMaxItems: 10 },
  repair: { mergeMaxSize: 10, directItemsSplitAt: 4 },
  // Debounced jobs stay out of the way unless a test runs them on purpose.
  jobs: { debounceMs: 3_600_000, debounceCapMs: 7_200_000 }
});
/** A small-library configuration: a first topic from 6 notes, in process up to 12. */
const smallConfig: TopicTreeConfig = topicTreeConfigWith(
  { bootstrap: { minItems: 6, singleTopicMaxItems: 12 } },
  baseConfig
);
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Six subjects (one per source) of three clusters of six notes. */
const clusters = gaussianClusters({
  groups: 6,
  clustersPerGroup: 3,
  pointsPerCluster: 6,
  dim,
  groupSpread: 0.6,
  pointNoise: 0.35,
  seed: 20261015
});
const pointsPerGroup = 18;
const vectorOf = (row: number) => clusters.matrix.data.slice(row * dim, (row + 1) * dim);
const groupRows = (group: number, from = 0, to = pointsPerGroup) =>
  Array.from({ length: to - from }, (_, index) => group * pointsPerGroup + from + index);

/** The clustering worker's own code, run in process (no built worker host under vitest). */
const clusterInProcess: ClusterTopics = async (request) => {
  const parsed = TopicClusteringRequestSchema.parse(request);
  const result = clusterTopics(parsed);
  checkTopicClusteringResult(result, parsed);
  return result;
};

async function startSidecar(workDir: string) {
  for (let attempt = 1; ; attempt += 1) {
    const manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, `database-${attempt}`),
      database: "memora_topic_build_test",
      user: "memora_topic_build_test",
      password: `topic-build-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    try {
      return { manager, connection: await manager.start() };
    } catch (error) {
      await manager.stop().catch(() => undefined);
      if (attempt >= 3) throw error;
    }
  }
}

/** The tree in content terms: each topic as its sorted note keys plus its children's forms. */
function notePartition(state: TopicTreeState, keyOf: (item: ItemKey) => ItemKey | null): string {
  const encode = (id: string): string => {
    const node = getTopic(state, id);
    const items = node.items
      .map(keyOf)
      .filter((key): key is ItemKey => key !== null)
      .sort();
    return `(${items.join(",")}|${node.children.map(encode).sort().join("")})`;
  };
  return encode(state.rootId);
}

describe.skipIf(!sidecarAvailable)("the topic structure jobs on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;
  let services: TopicTreeServices;
  let supervisor: JobSupervisor;
  let current: TopicTreeConfig = smallConfig;
  let spaceOverride: SpaceResolution | null = null;
  /** Content hash (vector) of every inserted note. */
  const noteHash = new Map<string, string>();

  async function insertSource(
    title: string,
    options: { parent?: string; contentHash?: string } = {}
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into source_items (id, type, title, content_hash, parent_source_item_id)
       values ($1, $2, $3, $4, $5)`,
      [
        id,
        options.parent ? "BookChapter" : "Book",
        title,
        options.contentHash ?? sha(`source-${title}`),
        options.parent ?? null
      ]
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [randomUUID(), id, title, sha(`document-${id}`)]
    );
    return id;
  }

  /** Notes of a source with stored vectors (`native-v2:<space>`). */
  async function insertNotes(
    sourceId: string,
    entries: readonly { hash: string; vector: ArrayLike<number> }[]
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const entry of entries) {
      const id = randomUUID();
      const chunk = randomUUID();
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         select $1, d.id, $2, (select count(*) from chunks c where c.source_item_id = $2), 'Passage', $3
           from documents d where d.source_item_id = $2`,
        [chunk, sourceId, sha(`chunk-${chunk}`)]
      );
      await pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, ownership,
           created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
           generation_runtime, generation_prompt_version, generation_key)
         values ($1, 'Note', 'Body', 'Idea', 'source', $2, $3, 'test', 'test', 'test', 'test', $4)`,
        [id, sourceId, chunk, `key-${id}`]
      );
      await pool.query(
        `insert into embeddings_256 (target_type, target_id, provider, model, runtime, usage,
           strategy, content_hash, embedding)
         values ('atomic_note', $1, $2, $3, $4, 'matching', $5, $6, $7::vector)`,
        [
          id,
          space.provider,
          space.model,
          space.runtime,
          `${noteVectorStrategyPrefix}${space.spaceKey}`,
          entry.hash,
          `[${Array.from(entry.vector).join(",")}]`
        ]
      );
      noteHash.set(id, entry.hash);
      ids.push(id);
    }
    return ids;
  }

  const fixtureNotes = (rows: readonly number[]) =>
    rows.map((row) => ({ hash: sha(`note-${row}`), vector: vectorOf(row) }));

  /** A note close to fixture row `row` (a small deterministic perturbation, normalized). */
  function nearby(row: number, variant: number): { hash: string; vector: Float32Array } {
    const vector = vectorOf(row);
    vector[(row + variant * 7) % dim] = (vector[(row + variant * 7) % dim] as number) + 0.08;
    let norm = 0;
    for (const value of vector) norm += value * value;
    const scale = 1 / Math.sqrt(norm);
    return { hash: sha(`near-${row}-${variant}`), vector: vector.map((value) => value * scale) };
  }

  async function count(sql: string, values: unknown[] = []): Promise<number> {
    const result = await pool.query<{ count: string }>(sql, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  const activeTree = async () => (await createTopicTreeRepository(pool).activeTree())!;

  /** Runs every due compute job, as the light lane would. */
  async function drain(): Promise<JobRecord[]> {
    const done: JobRecord[] = [];
    for (let job = await supervisor.runLightOnce("compute"); job;) {
      done.push(job);
      job = await supervisor.runLightOnce("compute");
    }
    return done;
  }

  /** Makes the queued jobs of a type due now, then drains. */
  async function runQueued(type: string): Promise<JobRecord[]> {
    await pool.query("update jobs set run_after = now() where type = $1 and status = 'queued'", [
      type
    ]);
    return drain();
  }

  async function placeAll(): Promise<JobRecord[]> {
    const tree = await activeTree();
    const roots = await pool.query<{ id: string }>(
      "select id from source_items where parent_source_item_id is null order by id"
    );
    await services.triggers.place(
      tree.id,
      roots.rows.map((row) => ({ rootSourceId: row.id })),
      { debounce: immediateDebounce }
    );
    return drain();
  }

  async function reset(config: TopicTreeConfig): Promise<void> {
    await createLibraryResetRepository(pool).reset();
    services.service.invalidate();
    current = config;
    noteHash.clear();
  }

  /** Every current note and root source has one primary placement (E1). */
  async function expectReachable(): Promise<void> {
    expect(
      await count(
        `select count(*) from atomic_notes a where not exists (
           select 1 from topic_placements p where p.note_id = a.id and p.rank = 0)`
      )
    ).toBe(0);
    expect(
      await count(
        `select count(*) from source_items s where s.parent_source_item_id is null and not exists (
           select 1 from topic_placements p where p.source_item_id = s.id and p.rank = 0)`
      )
    ).toBe(0);
  }

  /** Stored statistics are exact and the service's cache equals a fresh load (D7). */
  async function expectExact(): Promise<TopicTreeState> {
    const tree = await activeTree();
    const fresh = (await loadTopicTreeCache(pool, tree.id))!;
    expect(fresh.staleStoredStats).toEqual([]);
    const report = shapeReport(fresh.state, current);
    expect(report.violations.hardCount).toBe(0);
    expect(report.reachability).toBe(1);
    return fresh.state;
  }

  const resultOf = (jobs: JobRecord[], type: string) =>
    jobs.filter((job) => job.type === type).map((job) => job.result ?? { error: job.error });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-build-"));
    ({ manager, connection } = await startSidecar(workDir));
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    const stored = createStoredVectorSpaceResolver(() => pool);
    services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: { resolve: async () => spaceOverride ?? stored.resolve() },
      env: {},
      isPackaged: false,
      logger: quiet,
      newTreeConfig: () => current,
      clusterTopics: clusterInProcess,
      budgetStore: { read: async () => null, write: async () => undefined }
    });
    supervisor = new JobSupervisor({
      getPool: () => pool,
      lightJobs: services.jobs,
      pollIntervalMs: 20,
      logger: quiet
    });
  }, 120_000);

  afterAll(async () => {
    await supervisor?.stop().catch(() => undefined);
    services?.dispose();
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("keeps a library below bootstrap.minItems clusterable notes in Unsorted, reachable", async () => {
    const first = await insertSource("Source alpha");
    const second = await insertSource("Source beta");
    await insertNotes(first, fixtureNotes(groupRows(0, 0, 3)));
    await insertNotes(second, fixtureNotes(groupRows(1, 0, 2)));
    expect((await services.ensureActiveTree())?.kind).toBe("ready");
    // 5 notes and 2 roots reach minItems (6): PLACE waits for one build, which cannot make a
    // topic from 5 notes and places them in Unsorted instead.
    const jobs = await placeAll();
    const builds = resultOf(jobs, topicJobTypes.build);
    expect(builds[0]).toMatchObject({ status: "waiting_for_items", clusterable: 5, placed: 7 });
    expect(await count("select count(*) from topics where role = 'topic'")).toBe(0);
    await expectReachable();
    await expectExact();
  });

  it("makes the first topics of a small library in process, roots placed with their notes", async () => {
    const second = (
      await pool.query<{ id: string }>("select id from source_items where title = 'Source beta'")
    ).rows[0]!.id;
    await insertNotes(second, fixtureNotes(groupRows(1, 2, 5)));
    const jobs = await placeAll();
    const [build] = resultOf(jobs, topicJobTypes.build).filter(
      (result) => result.status === "applied"
    );
    expect(build).toMatchObject({ kind: "cold", reason: "cold-start", method: "small", rows: 8 });
    // Two separated subjects: two topics (the split beats one topic by modularity).
    expect(build?.topics).toBe(2);
    expect(Number(build?.modularity)).toBeGreaterThanOrEqual(current.bootstrap.modularityMin);
    const change = await pool.query<{ origin: string; summary: Record<string, unknown> }>(
      "select origin, summary from topic_change_sets where id = $1",
      [build?.changeSetId]
    );
    expect(change.rows[0]).toMatchObject({ origin: "build", summary: { notes: 8, rows: 8 } });
    await expectReachable();
    const state = await expectExact();
    // Each root sits in the topic that holds its notes (D8).
    for (const root of await pool
      .query<{ id: string }>("select id from source_items where parent_source_item_id is null")
      .then((result) => result.rows)) {
      const placement = state.placements.get(itemKey("source", root.id))?.[0];
      const topic = getTopic(state, placement!.topicId);
      expect(
        topic.items.filter(
          (item) => state.items.get(item)?.rootSource === itemKey("source", root.id)
        ).length
      ).toBeGreaterThan(0);
    }
  });

  it("builds a large library with the Louvain-kNN builder, equal to the in-process build", async () => {
    await reset(baseConfig);
    const roots: string[] = [];
    for (let group = 0; group < 6; group += 1) {
      const root = await insertSource(`Subject ${group}`);
      roots.push(root);
      await insertNotes(root, fixtureNotes(groupRows(group)));
    }
    expect((await services.ensureActiveTree())?.kind).toBe("ready");
    const jobs = await placeAll();
    const [build] = resultOf(jobs, topicJobTypes.build).filter(
      (result) => result.status === "applied"
    );
    expect(build).toMatchObject({ kind: "cold", method: "louvain", rows: 108, hardViolations: 0 });
    expect(resultOf(jobs, topicJobTypes.sweep).at(-1)).toMatchObject({
      status: "swept",
      pending: 0
    });
    await expectReachable();
    const state = await expectExact();

    // The same stored vectors, rows (content-key order, D22), seed and configuration in process.
    const notes = [...noteHash].map(([id, hash]) => ({
      key: itemKey("note", id),
      contentHash: hash
    }));
    const order = topicClusteringRowOrder(notes);
    const loaded = await createTopicTreeLoadRepository(pool).loadItemVectors(
      space,
      order.keys.map((key) => ({ kind: "note" as const, id: key.slice("note:".length) }))
    );
    expect(loaded.keys).toEqual(order.keys);
    const expected = buildLouvain(
      loaded.matrix,
      order.keys.map((_, row) => row),
      {
        seed,
        config: baseConfig,
        detectCommunities: detectCommunitiesLouvain
      }
    );
    const rowKey = new Map(order.keys.map((key, row) => [rowItemKey(row), key]));
    expect(notePartition(state, (item) => (item.startsWith("note:") ? item : null))).toBe(
      notePartition(expected.state, (item) => rowKey.get(item) ?? null)
    );

    // The bulk write is followed by ANALYZE of the topic tables (planner statistics).
    const deadline = Date.now() + 5_000;
    let analyzed = 0;
    while (Date.now() < deadline) {
      analyzed = await count(
        `select count(*) from pg_stat_user_tables
          where relname in ('topics', 'topic_stats', 'topic_placements') and last_analyze is not null`
      );
      if (analyzed === 3) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    expect(analyzed).toBe(3);
    expect(Number((build?.timings as Record<string, number>).analyzeMs)).toBeGreaterThanOrEqual(0);
    // The audit follows the build; nothing else is due.
    expect(
      await count("select count(*) from jobs where type = 'topic-audit' and status = 'queued'")
    ).toBe(1);
  });

  it("splits a leaf past its hard limit by REBALANCE and records the day's metrics", async () => {
    const tree = await activeTree();
    const before = (await loadTopicTreeCache(pool, tree.id))!;
    // The largest leaf receives a burst of near-duplicates of one of its notes.
    let target: string | null = null;
    let size = 0;
    walkTopics(before.state, (node) => {
      if (node.children.length === 0 && node.items.length > size) {
        target = node.id;
        size = node.items.length;
      }
    });
    const member = getTopic(before.state, target!).items.find((item) => item.startsWith("note:"))!;
    const memberHash = noteHash.get(member.slice(5))!;
    const row = groupRows(0, 0, 6 * pointsPerGroup).find((r) => sha(`note-${r}`) === memberHash)!;
    const owner = (
      await pool.query<{ root: string }>(
        "select created_from_source_item_id as root from atomic_notes where id = $1",
        [member.slice(5)]
      )
    ).rows[0]!.root;
    await insertNotes(
      owner,
      Array.from({ length: baseConfig.leaf.hardMax }, (_, variant) => nearby(row, variant + 1))
    );
    const placed = await placeAll();
    expect(
      resultOf(placed, topicJobTypes.place).some((result) => result.status === "applied")
    ).toBe(true);
    // PLACE asked for REBALANCE (debounced); run it now.
    const jobs = await runQueued(topicJobTypes.rebalance);
    const [rebalance] = resultOf(jobs, topicJobTypes.rebalance);
    expect(rebalance).toMatchObject({ status: "applied", areasActive: true });
    expect(Number(rebalance?.operations)).toBeGreaterThan(0);
    const state = await expectExact();
    walkTopics(state, (node) => {
      if (node.children.length === 0 && node.id !== state.rootId) {
        expect(node.items.length).toBeLessThanOrEqual(baseConfig.leaf.hardMax);
      }
    });
    const digest = services.service.cacheDigest();
    const fresh = (await loadTopicTreeCache(pool, tree.id))!;
    expect(digest?.structure).toBe(canonicalStateDump(fresh.state));
    expect(digest?.stats).toBe(statsDump(fresh.state));
    const metrics = await pool.query<{ ops: number; moved: number }>(
      "select ops_applied as ops, items_moved as moved from topic_daily_metrics where tree_id = $1",
      [tree.id]
    );
    expect(metrics.rows[0]?.ops).toBeGreaterThan(0);
  });

  it("audits, and rebuilds a new structural configuration with IDs kept and an exact undo (D39)", async () => {
    const audit = resultOf(await runQueued(topicJobTypes.audit), topicJobTypes.audit)[0];
    expect(audit).toMatchObject({ status: "audited", hardViolations: 0, rebuild: null });
    const tree = await activeTree();
    const repository = createTopicTreeRepository(pool);
    const day = await pool.query<{ fanout: number | null; depth: number | null }>(
      "select fanout_in_target as fanout, mean_depth as depth from topic_daily_metrics where tree_id = $1",
      [tree.id]
    );
    expect(day.rows[0]?.depth).toBeGreaterThan(0);
    const before = topicTreeRecordsDump(await repository.readTreeRecords(tree.id));
    const topicsBefore = new Set(
      (await pool.query<{ id: string }>("select id from topics where retired_at is null")).rows.map(
        (row) => row.id
      )
    );

    current = topicTreeConfigWith({ leaf: { target: 5 } }, baseConfig);
    await services.triggers.request(topicJobTypes.audit, tree.id, null, {
      debounce: immediateDebounce
    });
    const jobs = await drain();
    expect(resultOf(jobs, topicJobTypes.audit)[0]).toMatchObject({ rebuild: "config" });
    const [rebuild] = resultOf(jobs, topicJobTypes.build);
    expect(rebuild).toMatchObject({ status: "applied", kind: "rebuild", reason: "config" });
    expect(Number(rebuild?.matched)).toBeGreaterThan(0);
    const after = await activeTree();
    expect(after.configHash).toBe(structuralConfigHash(current));
    expect(after.config).toEqual(JSON.parse(JSON.stringify(current)));
    const kept = (
      await pool.query<{ id: string }>("select id from topics where retired_at is null")
    ).rows.filter((row) => topicsBefore.has(row.id)).length;
    expect(kept).toBe(Number(rebuild?.matched) + 1);
    await expectReachable();
    await expectExact();

    // The rebuild is one change-set and its undo restores the tree exactly.
    const undone = await repository.undoChangeSet({
      treeId: after.id,
      changeSetId: String(rebuild?.changeSetId),
      titleKey: "topics.changeSets.undo"
    });
    expect(undone.kind).toBe("applied");
    expect(topicTreeRecordsDump(await repository.readTreeRecords(after.id))).toBe(before);
    // The configuration stays the new one, so nothing asks for the same rebuild again.
    const again = resultOf(await runQueued(topicJobTypes.audit), topicJobTypes.audit)[0];
    expect(again?.rebuild ?? null).not.toBe("config");
  });

  it("keeps a pinned subtree whole through a rebuild, or proposes it for review", async () => {
    services.service.invalidate();
    const tree = await activeTree();
    const repository = createTopicTreeRepository(pool);
    const cache = (await loadTopicTreeCache(pool, tree.id))!;
    let pinned: string | null = null;
    walkTopics(cache.state, (node, depth) => {
      if (pinned === null && depth === 1) pinned = node.id;
    });
    const pin = await repository.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: cache.tree.generation,
      origin: "human",
      titleKey: "topics.changeSets.pin",
      events: [
        {
          op: "topic.manage",
          topicId: pinned!,
          before: { management: "ai" },
          after: { management: "pinned" }
        }
      ]
    });
    expect(pin.kind).toBe("applied");
    const shape = (state: TopicTreeState) => {
      const parts: string[] = [];
      walkTopics(
        state,
        (node) => parts.push(`${node.id}<${node.parentId}:${node.items.join(",")}`),
        pinned!
      );
      return parts.join("|");
    };
    const pinnedBefore = shape((await loadTopicTreeCache(pool, tree.id))!.state);
    current = topicTreeConfigWith({ leaf: { target: 3 } }, baseConfig);
    await services.triggers.request(topicJobTypes.build, tree.id, null, {
      debounce: immediateDebounce
    });
    const [rebuild] = resultOf(await drain(), topicJobTypes.build);
    expect(["applied", "pending_review"]).toContain(rebuild?.status);
    const state = (await loadTopicTreeCache(pool, tree.id))!.state;
    expect(getTopic(state, pinned!).management).toBe("pinned");
    expect(shape(state)).toBe(pinnedBefore);
    if (rebuild?.status === "pending_review") {
      expect(rebuild.protectedTouched).toBe(true);
      // The proposal blocks another rebuild until the owner resolves it.
      await services.triggers.request(topicJobTypes.build, tree.id, null, {
        debounce: immediateDebounce
      });
      expect(resultOf(await drain(), topicJobTypes.build)[0]).toMatchObject({
        status: "review_pending"
      });
    }
  });

  it("proposes the repair of a pinned leaf for review, once (D29)", async () => {
    services.service.invalidate();
    const tree = await activeTree();
    const repository = createTopicTreeRepository(pool);
    let cache = (await loadTopicTreeCache(pool, tree.id))!;
    let leaf: string | null = null;
    walkTopics(cache.state, (node) => {
      if (leaf === null && node.children.length === 0 && node.management === "ai") leaf = node.id;
    });
    const pin = await repository.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: cache.tree.generation,
      origin: "human",
      titleKey: "topics.changeSets.pin",
      events: [
        {
          op: "topic.manage",
          topicId: leaf!,
          before: { management: "ai" },
          after: { management: "pinned" }
        }
      ]
    });
    expect(pin.kind).toBe("applied");
    // The pinned leaf receives a burst past leaf.hardMax (written directly, as a human would).
    const root = (
      await pool.query<{ id: string }>(
        "select id from source_items where parent_source_item_id is null order by id limit 1"
      )
    ).rows[0]!.id;
    const ids = await insertNotes(
      root,
      Array.from({ length: baseConfig.leaf.hardMax + 2 }, (_, variant) => nearby(0, variant + 40))
    );
    cache = (await loadTopicTreeCache(pool, tree.id))!;
    const burst = await repository.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: cache.tree.generation,
      origin: "human",
      titleKey: "topics.changeSets.place",
      events: ids.map((id) => ({
        op: "item.place" as const,
        item: itemKey("note", id),
        topicId: leaf!,
        before: null,
        after: placementRecord(leaf!, {
          management: "human",
          decidedBy: "human",
          itemFingerprint: noteHash.get(id)!
        })
      }))
    });
    expect(burst.kind).toBe("applied");
    services.service.invalidate();
    const pending = () =>
      count(
        `select count(*) from topic_change_sets
          where tree_id = $1 and status = 'pending_review' and origin = 'rebalance'`,
        [tree.id]
      );
    const before = await pending();
    const dump = topicTreeRecordsDump(await repository.readTreeRecords(tree.id));
    // The audit finds the pinned leaf past its hard limit and asks REBALANCE to check it.
    const rebalance = async () => {
      await services.triggers.request(topicJobTypes.audit, tree.id, null, {
        debounce: immediateDebounce
      });
      const [audit] = resultOf(await drain(), topicJobTypes.audit);
      expect(Number(audit?.flaggedTopics)).toBeGreaterThan(0);
      return resultOf(await runQueued(topicJobTypes.rebalance), topicJobTypes.rebalance)[0];
    };
    const first = await rebalance();
    expect(first).toMatchObject({ proposed: 1, unresolvedHard: 1 });
    expect(await pending()).toBe(before + 1);
    const proposal = await pool.query<{ summary: Record<string, unknown> }>(
      `select summary from topic_change_sets
        where tree_id = $1 and status = 'pending_review' and origin = 'rebalance'
        order by created_at desc limit 1`,
      [tree.id]
    );
    expect(proposal.rows[0]?.summary).toMatchObject({
      reason: "protected",
      condition: "leaf-above-hard-max",
      topicId: leaf
    });
    // Nothing was applied to the pinned leaf, and the proposal is not recorded twice.
    expect(topicTreeRecordsDump(await repository.readTreeRecords(tree.id))).toBe(dump);
    expect(await rebalance()).toMatchObject({ proposed: 0 });
    expect(await pending()).toBe(before + 1);
  });

  it("asks for naming and the Areas grouping after a build only when topic AI runs (G1)", async () => {
    for (const aiMode of ["deterministic", "full"] as const) {
      await reset(baseConfig);
      for (let group = 0; group < 6; group += 1) {
        await insertNotes(await insertSource(`Subject ${group}`), fixtureNotes(groupRows(group)));
      }
      const ensured = await services.ensureActiveTree();
      if (ensured?.kind !== "ready") throw new Error("no tree");
      // Every follow-up type is registered for these structure jobs.
      const triggers = new TopicTriggers({
        getPool: () => pool,
        isRegistered: () => true,
        debounce: () => ({ delayMs: 3_600_000, maxDelayMs: 7_200_000 })
      });
      const structure = new TopicStructureJobs({
        getPool: () => pool,
        service: services.service,
        triggers,
        changes: services.changes,
        spaceResolver: { resolve: async () => ({ kind: "ready", space }) },
        aiMode,
        isRegistered: () => true,
        effectiveConfig: () => current,
        clusterTopics: clusterInProcess,
        logger: quiet
      });
      const job = await createJobRepository(pool).create({
        type: topicJobTypes.build,
        lane: "light",
        payload: { treeId: ensured.tree.id }
      });
      const result = await structure.runBuild(job, new AbortController().signal);
      await pool.query("update jobs set status = 'succeeded' where id = $1", [job.id]);
      expect(result).toMatchObject({ status: "applied", kind: "cold" });
      expect(Number(result.level2Topics)).toBeGreaterThanOrEqual(current.areas.minLevel2Topics);
      const queued = async (type: string) =>
        count("select count(*) from jobs where type = $1 and status = 'queued'", [type]);
      const expected = aiMode === "full" ? 1 : 0;
      expect(await queued(topicJobTypes.name)).toBe(expected);
      expect(await queued(topicJobTypes.areas)).toBe(expected);
      expect(await queued(topicJobTypes.audit)).toBe(1);
      await structure.dispose();
    }
  });

  it("seeds one subtree per chapter of a single book (chapter seeding)", async () => {
    await reset(baseConfig);
    const book = await insertSource("A book");
    const chapters: string[] = [];
    for (let group = 0; group < 3; group += 1) {
      const chapter = await insertSource(`Chapter ${group}`, { parent: book });
      chapters.push(chapter);
      await insertNotes(chapter, fixtureNotes(groupRows(group, 0, 12)));
    }
    await insertNotes(await insertSource("A note"), fixtureNotes(groupRows(5, 0, 2)));
    expect((await services.ensureActiveTree())?.kind).toBe("ready");
    const jobs = await placeAll();
    const [build] = resultOf(jobs, topicJobTypes.build).filter(
      (result) => result.status === "applied"
    );
    expect(build).toMatchObject({ method: "louvain", seeded: { chapters: 3 } });
    await expectReachable();
    const state = await expectExact();
    // The majority-chapter share of every leaf holding the book's notes.
    const chapterOf = new Map<string, string>();
    for (const row of (
      await pool.query<{ id: string; chapter: string }>(
        "select id, created_from_source_item_id as chapter from atomic_notes"
      )
    ).rows) {
      chapterOf.set(itemKey("note", row.id), row.chapter);
    }
    let majority = 0;
    let total = 0;
    walkTopics(state, (node) => {
      if (node.children.length > 0) return;
      const counts = new Map<string, number>();
      for (const item of node.items) {
        const chapter = chapterOf.get(item);
        if (chapter && chapters.includes(chapter))
          counts.set(chapter, (counts.get(chapter) ?? 0) + 1);
      }
      const values = [...counts.values()];
      majority += values.length > 0 ? Math.max(...values) : 0;
      total += values.reduce((sum, value) => sum + value, 0);
    });
    expect(total).toBe(36);
    expect(majority / total).toBe(1);
  });

  it("leaves the tree alone while the embedding space changed", async () => {
    const tree = await activeTree();
    const generation = tree.generation;
    spaceOverride = { kind: "ready", space: { ...space, spaceKey: "another-space" } };
    try {
      for (const type of [topicJobTypes.build, topicJobTypes.rebalance] as const) {
        await services.triggers.request(type, tree.id, null, { debounce: immediateDebounce });
        expect(resultOf(await drain(), type)[0]).toMatchObject({ status: "space_changed" });
      }
    } finally {
      spaceOverride = null;
    }
    expect((await activeTree()).generation).toBe(generation);
  });

  it("never lets PLACE's debounced audit request defer the immediate one a sweep made", async () => {
    const tree = await activeTree();
    const placeJob = { id: randomUUID(), payload: { treeId: tree.id } } as unknown as JobRecord;
    const swept = { status: "swept", treeId: tree.id, recomputedTopics: 2 };
    // A generation far ahead of the last audit: this PLACE asks for an audit too.
    const placed = { status: "applied", generation: 1_000_000, changeSetId: randomUUID() };
    const sweep = () => services.structure.afterSweep(swept);
    const place = () => services.structure.afterPlace(placeJob, placed);
    const queuedJobs = async (type: string) =>
      (
        await pool.query<{ id: string; due: boolean; seconds: number }>(
          `select id, run_after <= clock_timestamp() as due,
                  extract(epoch from run_after - clock_timestamp())::float8 as seconds
             from jobs where type = $1 and status = 'queued'`,
          [type]
        )
      ).rows;
    for (const order of [
      [sweep, place],
      [place, sweep],
      [place, sweep, place]
    ]) {
      await pool.query(
        "update jobs set status = 'canceled' where status = 'queued' and type = any($1)",
        [[topicJobTypes.audit, topicJobTypes.rebalance]]
      );
      for (const step of order) await step();
      // One audit, due now, and the debounce (an hour here) only left on the REBALANCE.
      const audits = await queuedJobs(topicJobTypes.audit);
      expect(audits).toMatchObject([{ due: true }]);
      const rebalances = await queuedJobs(topicJobTypes.rebalance);
      expect(rebalances).toHaveLength(1);
      expect(rebalances[0]?.seconds).toBeGreaterThan(3_000);
    }
    await pool.query(
      "update jobs set status = 'canceled' where status = 'queued' and type = any($1)",
      [[topicJobTypes.audit, topicJobTypes.rebalance]]
    );
  });
});
