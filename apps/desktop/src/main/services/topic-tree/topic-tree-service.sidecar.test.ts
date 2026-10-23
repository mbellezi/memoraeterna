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
  createTopicTreeRepository,
  noteVectorStrategyPrefix,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type JobRecord,
  type PgPool,
  type PostgresSidecarConnection,
  type TopicLoadSpace
} from "@app/db";
import {
  canonicalStateDump,
  checkTopicClusteringResult,
  gaussianClusters,
  statsDump,
  TopicClusteringRequestSchema,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clusterTopics } from "../../workers/topic-clustering.worker.js";
import { JobSupervisor } from "../job-supervisor.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices } from "./index.js";
import type { ClusterTopics } from "./topic-build.js";
import { loadTopicTreeCache } from "./topic-cache.js";
import { createStoredVectorSpaceResolver, treeSpace } from "./topic-space.js";
import type { SpaceResolution } from "./topic-space.js";
import { immediateDebounce } from "./topic-triggers.js";

/**
 * The topic service against the real schema on a throwaway PostgreSQL sidecar: synthetic notes
 * with 256-d vectors, the tree created from the newest vector's space, PLACE through the
 * repository, the cold-start build PLACE waits for (T19), the sweep after a cascade, the barrier
 * through the real job supervisor, and a library reset.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const space: TopicLoadSpace = {
  spaceKey: "topic-service-test-space",
  provider: "test",
  model: "synthetic-256",
  runtime: "none",
  dimensions: dim
};
/** Shape limits small enough for a few dozen notes to make a tree of depth 2-3. */
const config: TopicTreeConfig = topicTreeConfigWith({
  fanOut: { min: 2, max: 4, targetMin: 2, targetMax: 3, hardMax: 6, rootTarget: 3 },
  leaf: { min: 2, max: 6, target: 4, hardMax: 12, minForTargetFanOut: 2 },
  depth: { target: 3, cap: 5 },
  areas: { min: 2, max: 4, target: 3 },
  bootstrap: { singleTopicMaxItems: 10 },
  repair: { mergeMaxSize: 10, directItemsSplitAt: 4 },
  // Jobs enqueued by triggers stay out of the way unless a test runs them on purpose.
  jobs: { debounceMs: 3_600_000, debounceCapMs: 7_200_000 }
});
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Four groups of clustered notes: group g belongs to source g. */
const clusters = gaussianClusters({
  groups: 4,
  clustersPerGroup: 3,
  pointsPerCluster: 6,
  dim,
  groupSpread: 0.6,
  pointNoise: 0.35,
  seed: 20261015
});
const pointsPerGroup = 18;
const vectorOf = (row: number) => clusters.matrix.data.slice(row * dim, (row + 1) * dim);

/** A note close to fixture row `row`: a small deterministic perturbation, normalized. */
function nearbyVector(row: number, variant: number): Float32Array {
  const vector = vectorOf(row);
  const at = (row + variant * 7) % dim;
  vector[at] = (vector[at] as number) + 0.08;
  const scale = 1 / Math.hypot(...vector);
  return vector.map((value) => value * scale);
}

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
      database: "memora_topic_service_test",
      user: "memora_topic_service_test",
      password: `topic-service-${randomUUID()}`,
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

describe.skipIf(!sidecarAvailable)("the topic service on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;
  let services: TopicTreeServices;
  let supervisor: JobSupervisor;
  let spaceOverride: SpaceResolution | null = null;
  const sources: string[] = [];
  const notesBySource = new Map<string, string[]>();

  async function insertSource(title: string, contentHash: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "insert into source_items (id, type, title, content_hash) values ($1, 'Book', $2, $3)",
      [id, title, contentHash]
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [randomUUID(), id, title, sha(`document-${id}`)]
    );
    sources.push(id);
    notesBySource.set(id, []);
    return id;
  }

  /**
   * Notes with their stored 256-d vectors (strategy `native-v2:<space>`, content hash per note);
   * with `variant`, a nearby vector and content instead of the fixture row's own.
   */
  async function insertNotes(sourceId: string, rows: number[], variant = 0): Promise<string[]> {
    const ids: string[] = [];
    for (const row of rows) {
      const id = randomUUID();
      const chunk = randomUUID();
      const index = (notesBySource.get(sourceId)?.length ?? 0) + ids.length;
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         select $1, d.id, $2, $3, 'Passage', $4 from documents d where d.source_item_id = $2`,
        [chunk, sourceId, index, sha(`chunk-${chunk}`)]
      );
      await pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, ownership,
           created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
           generation_runtime, generation_prompt_version, generation_key)
         values ($1, 'Note', 'Body', 'Idea', 'source', $2, $3, 'test', 'test', 'test', 'test', $4)`,
        [id, sourceId, chunk, `key-${id}`]
      );
      await pool.query(
        `insert into embeddings_256 (target_type, target_id, provider, model, runtime, usage, strategy,
           content_hash, embedding)
         values ('atomic_note', $1, $2, $3, $4, 'matching', $5, $6, $7::vector)`,
        [
          id,
          space.provider,
          space.model,
          space.runtime,
          `${noteVectorStrategyPrefix}${space.spaceKey}`,
          sha(variant === 0 ? `note-${row}` : `note-${row}-near-${variant}`),
          `[${Array.from(variant === 0 ? vectorOf(row) : nearbyVector(row, variant)).join(",")}]`
        ]
      );
      ids.push(id);
    }
    notesBySource.get(sourceId)!.push(...ids);
    return ids;
  }

  const groupRows = (group: number, from: number, to: number) =>
    Array.from({ length: to - from }, (_, index) => group * pointsPerGroup + from + index);

  async function count(sql: string, values: unknown[] = []): Promise<number> {
    const result = await pool.query<{ count: string }>(sql, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  const activeTree = async () => (await createTopicTreeRepository(pool).activeTree())!;
  const changeSets = () => count("select count(*) from topic_change_sets");

  /** Enqueues PLACE for scopes and runs every due compute job, as the light lane would. */
  async function place(rootSourceIds: string[]): Promise<JobRecord[]> {
    const tree = await activeTree();
    await services.triggers.place(
      tree.id,
      rootSourceIds.map((rootSourceId) => ({ rootSourceId })),
      { debounce: immediateDebounce }
    );
    return drain();
  }

  async function drain(): Promise<JobRecord[]> {
    const done: JobRecord[] = [];
    for (let job = await supervisor.runLightOnce("compute"); job;) {
      done.push(job);
      job = await supervisor.runLightOnce("compute");
    }
    return done;
  }

  /** The service's cache equals a fresh load, and stored statistics are exact (D7). */
  async function expectCacheExact(): Promise<void> {
    const tree = await activeTree();
    const fresh = (await loadTopicTreeCache(pool, tree.id))!;
    expect(fresh.staleStoredStats).toEqual([]);
    const digest = services.service.cacheDigest();
    expect(digest?.generation).toBe(tree.generation);
    expect(digest?.structure).toBe(canonicalStateDump(fresh.state));
    expect(digest?.stats).toBe(statsDump(fresh.state));
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-service-"));
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
      newTreeConfig: () => config,
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

  it("creates no tree before any note vector, then one in the newest vector's space (D39)", async () => {
    await expect(services.ensureActiveTree()).resolves.toEqual({
      kind: "blocked",
      reason: "waiting_for_embeddings"
    });
    const first = await insertSource("Source zeta", "hash-z");
    await insertNotes(first, groupRows(0, 0, 5));
    const created = await services.ensureActiveTree();
    expect(created).toMatchObject({ kind: "ready", created: true });
    if (created?.kind !== "ready") throw new Error("unreachable");
    expect(treeSpace(created.tree)).toEqual(space);
    expect(created.tree.config).toEqual(JSON.parse(JSON.stringify(config)));
    await expect(services.ensureActiveTree()).resolves.toMatchObject({
      kind: "ready",
      created: false,
      tree: { id: created.tree.id }
    });
    expect(await count("select count(*) from topics")).toBe(1);
  });

  it("places items at the root while fewer than bootstrap.minItems exist; PLACE is idempotent", async () => {
    const [first] = sources;
    const [job] = await place([first!]);
    expect(job?.status).toBe("succeeded");
    // Five notes and their root source wait in Unsorted (the root) until the build.
    expect(job?.result).toMatchObject({ status: "applied", placed: 6 });
    expect(await count("select count(*) from topic_placements")).toBe(6);
    const before = await changeSets();
    const [again] = await place([first!]);
    expect(again?.result).toMatchObject({ status: "no_change", placed: 0 });
    expect(await changeSets()).toBe(before);
    await expectCacheExact();
  });

  it("waits for one build once bootstrap.minItems items wait, which places them all (D39)", async () => {
    const others = [
      await insertSource("Source alpha", "hash-a"),
      await insertSource("Source mu", "hash-m"),
      await insertSource("Source beta", "hash-b")
    ];
    await insertNotes(sources[0]!, groupRows(0, 5, pointsPerGroup));
    for (const [index, source] of others.entries()) {
      await insertNotes(source, groupRows(index + 1, 0, pointsPerGroup));
    }
    const before = await changeSets();
    const jobs = await place(others);
    // No item-by-item PLACE into an empty tree: every root waits, then one cold-start build
    // (T19) places every note and root, and the sweep after it finds nothing pending.
    expect(jobs.map((job) => [job.type, job.result?.status])).toEqual([
      ["topic-place", "awaiting_build"],
      ["topic-place", "awaiting_build"],
      ["topic-place", "awaiting_build"],
      ["topic-build", "applied"],
      ["topic-sweep", "swept"]
    ]);
    expect(await changeSets()).toBe(before + 1);
    expect(await count("select count(*) from topic_placements where rank = 0")).toBe(
      4 * pointsPerGroup + 4
    );
    await expectCacheExact();
  });

  it("places new notes and roots into a built tree in one change-set per root", async () => {
    // Two notes per source arrive after the build.
    for (const [index, source] of sources.entries()) {
      await insertNotes(source, groupRows(index, 0, 2), 1);
    }
    const before = await changeSets();
    const jobs = await place(sources);
    expect(jobs.map((job) => job.result?.status)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied"
    ]);
    expect(await changeSets()).toBe(before + 4);
    // Every current note and root source is reachable through one primary placement (E1).
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
    // Each placement remembers the vector it was decided on.
    expect(
      await count(
        `select count(*) from topic_placements p join embeddings_256 e
           on e.target_type = 'atomic_note' and e.target_id = p.note_id
         where p.item_fingerprint is distinct from e.content_hash`
      )
    ).toBe(0);
    await expectCacheExact();
    const replay = await place(sources);
    expect(replay.map((job) => job.result?.status)).toEqual([
      "no_change",
      "no_change",
      "no_change",
      "no_change"
    ]);
    expect(await changeSets()).toBe(before + 4);
  });

  it("unplaces a note that stops being current", async () => {
    const [note] = notesBySource.get(sources[1]!)!;
    await pool.query("update atomic_notes set status = 'archived' where id = $1", [note]);
    const [job] = await services.triggers.notesChanged([note!]);
    expect(job?.job.dedupeKey).toContain(sources[1]!);
    await pool.query("update jobs set run_after = now() where id = $1", [job!.job.id]);
    const [ran] = await drain();
    expect(ran?.result).toMatchObject({ status: "applied", unplaced: 1 });
    expect(await count("select count(*) from topic_placements where note_id = $1", [note])).toBe(0);
    await expectCacheExact();
  });

  it("sweeps: restores statistics after a cascade (D32) and places what waits", async () => {
    const [deleted] = notesBySource.get(sources[2]!)!.slice(-1);
    await pool.query("delete from atomic_notes where id = $1", [deleted]);
    expect(await count("select count(*) from topic_stats where dirty")).toBeGreaterThan(0);
    const [fresh] = await insertNotes(sources[3]!, groupRows(3, 0, 1));
    const tree = await activeTree();
    const sweep = await services.service.runSweep(
      {
        id: randomUUID(),
        payload: { treeId: tree.id, reason: "requested" }
      } as unknown as JobRecord,
      new AbortController().signal
    );
    expect(sweep).toMatchObject({ status: "swept", pending: 1, placeJobs: 1 });
    expect(Number(sweep.recomputedTopics)).toBeGreaterThan(0);
    expect(await count("select count(*) from topic_stats where dirty")).toBe(0);
    const [ran] = await drain();
    expect(ran?.result).toMatchObject({ status: "applied", placed: 1 });
    expect(await count("select count(*) from topic_placements where note_id = $1", [fresh])).toBe(
      1
    );
    await expectCacheExact();
  });

  it("holds topic jobs queued and runs them after release in content-key order (D23)", async () => {
    await pool.query("update jobs set status = 'canceled' where status = 'queued'");
    const tree = await activeTree();
    // Content hashes order the roots m < x < z; ids and enqueue order do not.
    const roots = [
      { id: await insertSource("Late z", "hash-late-z") },
      { id: await insertSource("Late m", "hash-late-m") },
      { id: await insertSource("Late x", "hash-late-x") }
    ];
    services.holdTopicJobs();
    await supervisor.start();
    try {
      for (const [index, root] of roots.entries()) {
        const notes = await insertNotes(root.id, groupRows(index, 6, 8));
        await services.triggers.notesChanged(notes);
        // A second request joins the queued job (one queued job per key).
        await services.triggers.notesChanged(notes.slice(0, 1));
      }
      const keys = roots.map((root) => `topic-place:${tree.id}:${root.id}`);
      expect(
        await count("select count(*) from jobs where dedupe_key = any($1) and status = 'queued'", [
          keys
        ])
      ).toBe(3);
      // Due now: only the barrier keeps the running light lane from claiming them.
      await pool.query("update jobs set run_after = now() where dedupe_key = any($1)", [keys]);
      await new Promise((done) => setTimeout(done, 300));
      expect(
        await count("select count(*) from jobs where type = 'topic-place' and status = 'queued'")
      ).toBe(3);
      await services.releaseTopicJobs();
      const deadline = Date.now() + 20_000;
      while (
        (await count(
          "select count(*) from jobs where type = 'topic-place' and status in ('queued', 'running')"
        )) > 0
      ) {
        if (Date.now() > deadline) throw new Error("topic jobs did not finish");
        await new Promise((done) => setTimeout(done, 25));
      }
    } finally {
      await supervisor.stop();
    }
    const order = await pool.query<{ root: string; status: string }>(
      `select payload->>'rootSourceId' as root, status from jobs
        where type = 'topic-place' and payload->>'rootSourceId' = any($1) order by locked_at`,
      [roots.map((root) => root.id)]
    );
    expect(order.rows.map((row) => row.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(order.rows.map((row) => row.root)).toEqual([roots[1]!.id, roots[2]!.id, roots[0]!.id]);
    await expectCacheExact();
  }, 60_000);

  it("reports a changed embedding space and leaves PLACE waiting", async () => {
    spaceOverride = { kind: "ready", space: { ...space, spaceKey: "another-space" } };
    try {
      const status = await services.service.status();
      expect(status).toMatchObject({ blocked: "space_changed", aiMode: "full", held: false });
      const jobs = await place([sources[0]!]);
      expect(jobs.find((job) => job.type === "topic-place")?.result).toMatchObject({
        status: "space_changed"
      });
    } finally {
      spaceOverride = null;
    }
    // The waiting PLACE asked the build to check the space change again (T19b): let it run.
    await pool.query("update jobs set run_after = now() where status = 'queued'");
    await drain();
    await expect(services.service.status()).resolves.toMatchObject({
      blocked: null,
      phase: "active"
    });
  });

  it("reads a build a blocker set aside as waiting, not building (F4 D5)", async () => {
    const tree = await activeTree();
    const jobs = createJobRepository(pool);
    const build = await jobs.create({
      type: "topic-build",
      lane: "light",
      payload: { treeId: tree.id },
      runAfter: new Date(Date.now() + 3_600_000)
    });
    try {
      await expect(services.service.status()).resolves.toMatchObject({ phase: "building" });
      await jobs.markBlocked({ ids: [build.id] }, { class: "paused", reason: "user_pause" });
      await expect(services.service.status()).resolves.toMatchObject({ phase: "active" });
    } finally {
      await jobs.requestCancel(build.id);
    }
    await expect(services.service.status()).resolves.toMatchObject({ phase: "active" });
  });

  it("leaves an empty active tree after a library reset (D39)", async () => {
    const before = await activeTree();
    await createLibraryResetRepository(pool).reset();
    // The AI service resolves the route's space without a stored vector (T14); stand in for it.
    spaceOverride = { kind: "ready", space };
    try {
      const after = await services.ensureActiveTree();
      expect(after).toMatchObject({ kind: "ready", created: true });
      if (after?.kind !== "ready") throw new Error("unreachable");
      expect(after.tree.id).not.toBe(before.id);
      expect(await count("select count(*) from topics")).toBe(1);
      expect(await count("select count(*) from topic_placements")).toBe(0);
      // Nothing is queued: a golden run refuses to start over queued jobs.
      expect(await count("select count(*) from jobs where status = 'queued'")).toBe(0);
      // A job of the tree the reset removed finds no active tree instead of touching the new one.
      const stale = await createJobRepository(pool).create({
        type: "topic-place",
        lane: "light",
        payload: { treeId: before.id, rootSourceId: before.rootId, sourceItemId: before.rootId }
      });
      await expect(
        services.service.runPlace(stale, new AbortController().signal)
      ).resolves.toMatchObject({ status: "tree_inactive" });
    } finally {
      spaceOverride = null;
    }
  });
});
