import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
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
  checkTopicClusteringResult,
  gaussianClusters,
  getTopic,
  shapeReport,
  TopicClusteringRequestSchema,
  topicTreeConfigWith,
  walkTopics
} from "@app/domain/topic-tree";
import type { TopicClusteringResult, TopicTreeConfig } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clusterTopics } from "../../workers/topic-clustering.worker.js";
import { JobSupervisor } from "../job-supervisor.js";
import type { KnowledgeService } from "../knowledge-service.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices } from "./index.js";
import type { ClusterTopics } from "./topic-build.js";
import { loadTopicTreeCache } from "./topic-cache.js";
import { topicJobTypes } from "./topic-jobs.js";
import { TopicSpaceChange, topicSpaceLimits } from "./topic-space.js";
import type { SpaceResolution } from "./topic-space.js";
import { immediateDebounce } from "./topic-triggers.js";

/**
 * A change of embedding space (D26, T19b) on the real schema and a throwaway PostgreSQL sidecar:
 * a tree built in a 256-d space while the route moves to a 768-d one. The new space holds the
 * same library under an exact rotation (a signed permutation of the coordinates, so every cosine
 * is kept), and the old vectors are scrambled before the move: a rebuild that read them could not
 * keep the tree. PLACE of new-space items waits, a remote route waits for `topics.reembed`, a
 * local route re-embeds by itself, and at the coverage threshold the tree moves with its IDs kept.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const spaceA: TopicLoadSpace = {
  spaceKey: "topic-space-test-a",
  provider: "test",
  model: "synthetic-a-256",
  runtime: "none",
  dimensions: 256
};
const spaceB: TopicLoadSpace = {
  spaceKey: "topic-space-test-b",
  provider: "test",
  model: "synthetic-b-768",
  runtime: "none",
  dimensions: 768
};
const spaceC: TopicLoadSpace = {
  spaceKey: "topic-space-test-c-1024",
  provider: "test",
  model: "synthetic-c-1024",
  runtime: "none",
  dimensions: 1024
};
const config: TopicTreeConfig = topicTreeConfigWith({
  fanOut: { min: 2, max: 4, targetMin: 2, targetMax: 3, hardMax: 6, rootTarget: 3 },
  leaf: { min: 2, max: 6, target: 4, hardMax: 12, minForTargetFanOut: 2 },
  depth: { target: 3, cap: 5 },
  areas: { min: 2, max: 4, target: 3, minLevel2Topics: 4 },
  bootstrap: { singleTopicMaxItems: 10 },
  repair: { mergeMaxSize: 10, directItemsSplitAt: 4 },
  // Debounced jobs stay out of the way unless a test runs them on purpose.
  jobs: { debounceMs: 3_600_000, debounceCapMs: 7_200_000 }
});
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Six subjects (one per source) of three clusters of six notes. */
const clusters = gaussianClusters({
  groups: 6,
  clustersPerGroup: 3,
  pointsPerCluster: 6,
  dim: 256,
  groupSpread: 0.6,
  pointNoise: 0.35,
  seed: 20261015
});
const vectorA = (row: number) => clusters.matrix.data.slice(row * 256, (row + 1) * 256);

/** The rotation into the new space: coordinate i goes to slot perm[i] with sign sign[i]. */
const perm = Array.from({ length: 768 }, (_, index) => index);
for (let index = perm.length - 1, state = 7; index > 0; index -= 1) {
  state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
  const other = state % (index + 1);
  [perm[index], perm[other]] = [perm[other]!, perm[index]!];
}
const vectorB = (row: number): Float32Array => {
  const source = vectorA(row);
  const out = new Float32Array(768);
  for (let index = 0; index < 256; index += 1) {
    out[perm[index]!] = (index % 3 === 0 ? -1 : 1) * (source[index] as number);
  }
  return out;
};

/** A second rotation, into a 1024-d space. */
const permC = Array.from({ length: 1024 }, (_, index) => index);
for (let index = permC.length - 1, state = 11; index > 0; index -= 1) {
  state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
  const other = state % (index + 1);
  [permC[index], permC[other]] = [permC[other]!, permC[index]!];
}
const vectorC = (row: number): Float32Array => {
  const source = vectorA(row);
  const out = new Float32Array(1024);
  for (let index = 0; index < 256; index += 1) {
    out[permC[index]!] = (index % 5 === 0 ? -1 : 1) * (source[index] as number);
  }
  return out;
};

/** A test may change what the clustering returns (after it was checked). */
let perturb: ((result: TopicClusteringResult) => void) | null = null;
const clusterInProcess: ClusterTopics = async (request) => {
  const parsed = TopicClusteringRequestSchema.parse(request);
  const result = clusterTopics(parsed);
  checkTopicClusteringResult(result, parsed);
  perturb?.(result);
  return result;
};

async function startSidecar(workDir: string) {
  for (let attempt = 1; ; attempt += 1) {
    const manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, `database-${attempt}`),
      database: "memora_topic_space_test",
      user: "memora_topic_space_test",
      password: `topic-space-${randomUUID()}`,
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

describe.skipIf(!sidecarAvailable)("an embedding-space change on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;
  let services: TopicTreeServices;
  let supervisor: JobSupervisor;
  let route: SpaceResolution = { kind: "ready", space: spaceA, local: true };
  /** Fixture row of every note of the library, and the roots. */
  const rowOf = new Map<string, number>();
  const roots: string[] = [];
  let liveBefore = new Set<string>();
  let waitingNote = "";

  async function count(sql: string, values: unknown[] = []): Promise<number> {
    const result = await pool.query<{ count: string }>(sql, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  async function insertVector(
    noteId: string,
    space: TopicLoadSpace,
    hash: string,
    vector: ArrayLike<number>
  ): Promise<void> {
    await pool.query(
      `insert into embeddings_${space.dimensions} (target_type, target_id, provider, model, runtime,
         usage, strategy, content_hash, embedding)
       values ('atomic_note', $1, $2, $3, $4, 'matching', $5, $6, $7::vector)
       on conflict (target_type, target_id, model) do update set embedding = excluded.embedding`,
      [
        noteId,
        space.provider,
        space.model,
        space.runtime,
        `${noteVectorStrategyPrefix}${space.spaceKey}`,
        hash,
        `[${Array.from(vector).join(",")}]`
      ]
    );
  }

  async function insertSource(title: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into source_items (id, type, title, content_hash) values ($1, 'Book', $2, $3)`,
      [id, title, sha(`source-${title}`)]
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [randomUUID(), id, title, sha(`document-${id}`)]
    );
    return id;
  }

  async function insertNote(sourceId: string): Promise<string> {
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
    return id;
  }

  /** Runs every due compute job, as the light lane would. */
  async function drain(): Promise<JobRecord[]> {
    const done: JobRecord[] = [];
    for (let job = await supervisor.runLightOnce("compute"); job;) {
      done.push(job);
      job = await supervisor.runLightOnce("compute");
    }
    return done;
  }

  const resultOf = (jobs: JobRecord[], type: string) =>
    jobs.filter((job) => job.type === type).map((job) => job.result ?? { error: job.error });
  const activeTree = async () => (await createTopicTreeRepository(pool).activeTree())!;
  const liveTopics = async () =>
    new Set(
      (
        await pool.query<{ id: string }>(
          "select id from topics where retired_at is null and role = 'topic'"
        )
      ).rows.map((row) => row.id)
    );
  const queuedEmbeddings = () =>
    pool.query<{ note: string; space: string | null }>(
      `select payload->>'atomicNoteId' as note, payload->>'spaceKey' as space from jobs
        where type = 'note-embedding' and status = 'queued' order by 1`
    );
  /** The route moves; the status reads it at once (PLACE reuses it for a few seconds). */
  async function routeTo(next: SpaceResolution): Promise<void> {
    route = next;
    await services.service.status();
  }

  async function runBuild(): Promise<JsonResult> {
    const tree = await activeTree();
    await services.triggers.request(topicJobTypes.build, tree.id, null, {
      debounce: immediateDebounce
    });
    const builds = resultOf(await drain(), topicJobTypes.build);
    return builds[0] as JsonResult;
  }
  type JsonResult = Record<string, unknown>;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-space-"));
    ({ manager, connection } = await startSidecar(workDir));
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: { resolve: async () => route },
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
    // The library in the old space, built into a tree.
    for (let group = 0; group < 6; group += 1) {
      const root = await insertSource(`Subject ${group}`);
      roots.push(root);
      for (let index = 0; index < 18; index += 1) {
        const row = group * 18 + index;
        const id = await insertNote(root);
        rowOf.set(id, row);
        await insertVector(id, spaceA, sha(`note-${row}`), vectorA(row));
      }
    }
    expect((await services.ensureActiveTree())?.kind).toBe("ready");
    await services.triggers.place(
      (await activeTree()).id,
      roots.map((rootSourceId) => ({ rootSourceId })),
      { debounce: immediateDebounce }
    );
    const [build] = resultOf(await drain(), topicJobTypes.build).filter(
      (result) => (result as JsonResult).status === "applied"
    );
    expect(build).toMatchObject({ kind: "cold", rows: 108, hardViolations: 0 });
    await pool.query("update jobs set status = 'canceled' where status = 'queued'");
    liveBefore = await liveTopics();
    expect(liveBefore.size).toBeGreaterThan(6);
  }, 180_000);

  afterAll(async () => {
    await supervisor?.stop().catch(() => undefined);
    services?.dispose();
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("leaves PLACE of new-space items waiting, and never compares the two spaces", async () => {
    const tree = await activeTree();
    // A remote route in the new space; one new note is embedded there, and only there.
    await routeTo({ kind: "ready", space: spaceB, local: false });
    waitingNote = await insertNote(roots[0]!);
    await insertVector(waitingNote, spaceB, sha("waiting"), vectorB(0));
    await services.triggers.notesChanged([waitingNote], {});
    await pool.query("update jobs set run_after = now() where type = 'topic-place'");
    const jobs = await drain();
    expect(resultOf(jobs, topicJobTypes.place)).toEqual([
      expect.objectContaining({ status: "space_changed" })
    ]);
    expect(
      await count("select count(*) from topic_placements where note_id = $1", [waitingNote])
    ).toBe(0);
    expect((await activeTree()).generation).toBe(tree.generation);
    // The status names the move, and the notes a re-embedding would cover on a remote route.
    const status = await services.service.status();
    expect(status).toMatchObject({
      blocked: "space_changed",
      route: { spaceKey: spaceB.spaceKey, local: false }
    });
    await expect(services.spaceChange.reembedNotes(status.route)).resolves.toBe(108);
    // The build waits: nothing is re-embedded on a remote route without the owner.
    expect(await runBuild()).toMatchObject({
      status: "space_changed",
      from: spaceA.spaceKey,
      spaceKey: spaceB.spaceKey,
      notes: 109,
      embedded: 1,
      queued: 0,
      reembedding: "waiting_for_action"
    });
    expect((await queuedEmbeddings()).rows).toEqual([]);
  });

  it("sends one note first into a space no note has a vector of, and stops if it lands elsewhere", async () => {
    const errors: unknown[] = [];
    const change = new TopicSpaceChange({
      getPool: () => pool,
      spaceResolver: { resolve: async () => route },
      aiMode: "full",
      logger: { ...quiet, error: (message: unknown) => errors.push(message) }
    });
    const spaceC = { spaceKey: "topic-space-test-c", space: null, local: true };
    const none = { notes: 109, embedded: 0, queued: 0 };
    const probes = () =>
      pool.query<{ id: string }>(
        `select id from jobs where type = 'note-embedding' and payload->>'spaceKey' = $1`,
        [spaceC.spaceKey]
      );
    // One note goes first; while its job waits, nothing more is queued.
    await expect(change.reembedAutomatically(spaceC, none)).resolves.toBe(1);
    await expect(change.reembedAutomatically(spaceC, none)).resolves.toBe(0);
    expect((await probes()).rows).toHaveLength(1);
    // Its vector landed in another space than the one the route was resolved to: a disagreement
    // between the space computed without a call and the calls. The library is never re-embedded.
    await pool.query(
      `update jobs set status = 'succeeded', result = '{"embedded": true}'::jsonb,
              finished_at = now() + interval '1 second'
        where id = $1`,
      [(await probes()).rows[0]!.id]
    );
    await expect(change.reembedAutomatically(spaceC, none)).resolves.toBe(0);
    await expect(change.reembedAutomatically(spaceC, none)).resolves.toBe(0);
    expect((await probes()).rows).toHaveLength(1);
    expect(errors).toHaveLength(1);
    await pool.query("update jobs set status = 'canceled' where id = $1", [
      (await probes()).rows[0]!.id
    ]);
  });

  it("sends the next note first when one ended without a vector, and bounds every retry", async () => {
    const errors: unknown[] = [];
    const change = new TopicSpaceChange({
      getPool: () => pool,
      spaceResolver: { resolve: async () => route },
      aiMode: "full",
      logger: { ...quiet, error: (message: unknown) => errors.push(message) }
    });
    const jobsOf = async (spaceKey: string) =>
      (
        await pool.query<{ id: string; note: string; status: string }>(
          `select id, payload->>'atomicNoteId' as note, status from jobs
            where type = 'note-embedding' and payload->>'spaceKey' = $1 order by created_at, id`,
          [spaceKey]
        )
      ).rows;
    const endWithoutVector = (spaceKey: string) =>
      pool.query(
        `update jobs set status = 'failed', finished_at = now()
          where type = 'note-embedding' and status = 'queued' and payload->>'spaceKey' = $1`,
        [spaceKey]
      );
    // The first note's job ends without a vector (its note went away, or the call failed for
    // good): the next note goes first, a bounded number of times.
    const spaceD = { spaceKey: "topic-space-test-d", space: null, local: true };
    const none = { notes: 109, embedded: 0, queued: 0 };
    for (let attempt = 0; attempt < topicSpaceLimits.probeAttempts; attempt += 1) {
      await expect(change.reembedAutomatically(spaceD, none)).resolves.toBe(1);
      await expect(change.reembedAutomatically(spaceD, none)).resolves.toBe(0);
      await endWithoutVector(spaceD.spaceKey);
    }
    await expect(change.reembedAutomatically(spaceD, none)).resolves.toBe(0);
    await expect(change.reembedAutomatically(spaceD, none)).resolves.toBe(0);
    const sent = await jobsOf(spaceD.spaceKey);
    expect(sent).toHaveLength(topicSpaceLimits.probeAttempts);
    expect(new Set(sent.map((job) => job.note)).size).toBe(topicSpaceLimits.probeAttempts);
    expect(errors).toHaveLength(1);

    // Once a note has a vector of the space, the library goes; it goes again only when none of
    // its jobs is left and the coverage is still short, a bounded number of times.
    const spaceE = { spaceKey: "topic-space-test-e", space: null, local: true };
    const some = { notes: 109, embedded: 1, queued: 0 };
    for (let round = 0; round < topicSpaceLimits.automaticRounds; round += 1) {
      await expect(change.reembedAutomatically(spaceE, some)).resolves.toBe(109);
      await expect(change.reembedAutomatically(spaceE, some)).resolves.toBe(0);
      await endWithoutVector(spaceE.spaceKey);
    }
    await expect(change.reembedAutomatically(spaceE, some)).resolves.toBe(0);
    expect((await jobsOf(spaceE.spaceKey)).filter((job) => job.status === "queued")).toEqual([]);
  });

  it("re-embeds on the owner's action on a remote route, and by itself on a local one", async () => {
    // topics.reembed: every current note without a vector in the route's space, once.
    await expect(services.spaceChange.reembed()).resolves.toEqual({ queued: 108 });
    const queued = (await queuedEmbeddings()).rows;
    expect(queued).toHaveLength(108);
    expect(new Set(queued.map((job) => job.space))).toEqual(new Set([spaceB.spaceKey]));
    expect(queued.map((job) => job.note)).not.toContain(waitingNote);
    await expect(services.spaceChange.reembed()).resolves.toEqual({ queued: 0 });
    const status = await services.service.status();
    await expect(services.spaceChange.reembedNotes(status.route)).resolves.toBe(0);
    await pool.query("update jobs set status = 'canceled' where type = 'note-embedding'");

    // A local route re-embeds by itself, once per space in a process; it asks the owner nothing.
    await routeTo({ kind: "ready", space: spaceB, local: true });
    await expect(
      services.spaceChange.reembedNotes((await services.service.status()).route)
    ).resolves.toBeNull();
    expect(await runBuild()).toMatchObject({
      status: "space_changed",
      reembedding: "automatic",
      requested: 108
    });
    expect((await queuedEmbeddings()).rows).toHaveLength(108);
    expect(await runBuild()).toMatchObject({ status: "space_changed", reembedding: "automatic" });
    expect((await queuedEmbeddings()).rows).toHaveLength(108);
    // Without topic AI (G1) nothing is re-embedded by itself.
    const deterministic = new TopicSpaceChange({
      getPool: () => pool,
      spaceResolver: { resolve: async () => route },
      aiMode: "deterministic"
    });
    await expect(
      deterministic.reembedAutomatically(
        { spaceKey: "another", space: null, local: true },
        { notes: 109, embedded: 0, queued: 0 }
      )
    ).resolves.toBeNull();
  });

  it("moves the tree once the new space covers the library, its topic IDs kept, in that space only", async () => {
    const tree = await activeTree();
    const ids = [...rowOf.keys()].sort();
    // A topic retired earlier keeps statistics of the old space (a rebuild or merge retired it).
    const retired = randomUUID();
    const writer = await pool.connect();
    try {
      await writer.query("begin");
      await writer.query(
        `insert into topics (id, tree_id, parent_id, role, management, retired_at, redirect_to)
         values ($1, $2, $3, 'topic', 'human', now(), $3)`,
        [retired, tree.id, tree.rootId]
      );
      await writer.query(
        `insert into topic_stats (topic_id, space_key, n, ls, dirty, computed_at)
         values ($1, $2, 0, $3, false, now())`,
        [retired, spaceA.spaceKey, Buffer.alloc(256 * 8)]
      );
      await writer.query("commit");
    } finally {
      writer.release();
    }
    // The queued jobs re-embed the notes (simulated: each stores its vector, then succeeds).
    const embed = async (notes: readonly string[]) => {
      for (const id of notes) {
        const row = rowOf.get(id)!;
        await insertVector(id, spaceB, sha(`note-${row}`), vectorB(row));
      }
      await pool.query(
        `update jobs set status = 'succeeded' where type = 'note-embedding'
            and payload->>'atomicNoteId' = any($1::text[])`,
        [notes]
      );
    };
    await embed(ids.slice(0, 100));
    expect(await runBuild()).toMatchObject({
      status: "space_changed",
      embedded: 101,
      queued: 8,
      reembedding: "automatic"
    });
    // 106 of 109 notes pass the threshold, and three jobs are still on their way: the move waits
    // for them, so it maps the whole re-embedded library at once.
    await embed(ids.slice(100, 105));
    expect(await runBuild()).toMatchObject({
      status: "space_changed",
      embedded: 106,
      queued: 3,
      reembedding: "finishing"
    });
    expect((await activeTree()).spaceKey).toBe(spaceA.spaceKey);
    await embed(ids.slice(105));
    // The old vectors are scrambled: a move that read any of them could not keep the tree.
    await pool.query(`update embeddings_256 set embedding = $1::vector where strategy = $2`, [
      `[1${",0".repeat(255)}]`,
      `${noteVectorStrategyPrefix}${spaceA.spaceKey}`
    ]);
    const moved = await runBuild();
    expect(moved).toMatchObject({
      status: "applied",
      kind: "rebuild",
      reason: "space",
      from: spaceA.spaceKey,
      spaceKey: spaceB.spaceKey,
      rows: 108,
      hardViolations: 0
    });
    const after = await activeTree();
    expect(after).toMatchObject({
      id: tree.id,
      spaceKey: spaceB.spaceKey,
      embeddingModel: spaceB.model,
      dimensions: 768
    });
    // Unchanged data under a new space: more than 95% of the topics keep their IDs.
    const liveAfter = await liveTopics();
    const kept = [...liveBefore].filter((id) => liveAfter.has(id)).length;
    expect(kept / liveBefore.size).toBeGreaterThan(0.95);
    expect(Number(moved.matched)).toBe(kept);
    // Every statistic of the tree, the retired topic's included, lives in the new space.
    expect(
      await count(
        `select count(*) from topic_stats s join topics t on t.id = s.topic_id
          where t.tree_id = $1 and s.space_key <> $2`,
        [tree.id, spaceB.spaceKey]
      )
    ).toBe(0);
    // The note that waited is placed by the sweep that follows, in the new space.
    await drain();
    expect(
      await count("select count(*) from topic_placements where note_id = $1 and rank = 0", [
        waitingNote
      ])
    ).toBe(1);
    // Stored statistics equal an exact recompute from the new space's vectors alone (D7).
    const fresh = (await loadTopicTreeCache(pool, tree.id))!;
    expect(fresh.space).toEqual(spaceB);
    expect(fresh.staleStoredStats).toEqual([]);
    const report = shapeReport(fresh.state, config);
    expect(report.reachability).toBe(1);
    expect(report.violations.hardCount).toBe(0);
    // The route and the tree agree again: nothing waits.
    const status = await services.service.status();
    expect(status.blocked).toBeNull();
    expect(status.route).toBeUndefined();
  });

  it("moves with its structure kept when the rebuild touches protected structure, which waits for review (D29)", async () => {
    services.service.invalidate();
    const tree = await activeTree();
    const repository = createTopicTreeRepository(pool);
    // A pinned leaf below the first level: the rebuild in the new space will re-parent it.
    const before = (await loadTopicTreeCache(pool, tree.id))!;
    let pinned: string | null = null;
    walkTopics(before.state, (node) => {
      if (
        pinned === null &&
        node.children.length === 0 &&
        node.items.length > 0 &&
        node.parentId !== before.state.rootId
      )
        pinned = node.id;
    });
    const pinnedId = pinned as unknown as string;
    const parentBefore = getTopic(before.state, pinnedId).parentId;
    expect(
      (
        await repository.applyChangeSet({
          treeId: tree.id,
          expectedGeneration: before.tree.generation,
          origin: "human",
          titleKey: "topics.changeSets.pin",
          events: [
            {
              op: "topic.manage",
              topicId: pinnedId,
              before: { management: "ai" },
              after: { management: "pinned" }
            }
          ]
        })
      ).kind
    ).toBe("applied");
    const liveBefore = await liveTopics();

    // A local route in a third space. The heavy lane runs the re-embedding jobs: three of them
    // fail for good, and those run last.
    const failing = new Set([...rowOf.keys()].sort().slice(-3));
    const heavy = new JobSupervisor({
      getPool: () => pool,
      knowledgeService: {
        embedAtomicNote: async (noteId: string) => {
          if (failing.has(noteId)) throw new Error("errors.ai.invalidRequest");
          // The same text in every space: the waiting note's too.
          const row = rowOf.get(noteId);
          const hash = row === undefined ? sha("waiting") : sha(`note-${row}`);
          await insertVector(noteId, spaceC, hash, vectorC(row ?? 0));
          return { embedded: true };
        }
      } as unknown as KnowledgeService,
      topicHooks: services.hooks,
      pollIntervalMs: 20,
      logger: quiet
    });
    const runHeavy = async () => {
      while (await heavy.runOnce());
    };
    const queuedBuilds = () =>
      count("select count(*) from jobs where type = 'topic-build' and status = 'queued'");
    try {
      await routeTo({ kind: "unembedded", spaceKey: spaceC.spaceKey, local: true });
      expect(await runBuild()).toMatchObject({ reembedding: "automatic", requested: 1 });
      route = { kind: "ready", space: spaceC, local: true };
      await runHeavy();
      // The first note landed; its job's end asked the build to look again (debounced).
      expect(await queuedBuilds()).toBe(1);
      expect(await runBuild()).toMatchObject({ reembedding: "automatic", requested: 108 });
      await pool.query(
        `update jobs set run_after = now() + interval '1 day'
          where type = 'note-embedding' and payload->>'atomicNoteId' = any($1::text[])`,
        [[...failing]]
      );
      await runHeavy();
      // 106 of 109 notes are covered; the build waits for the three jobs still on their way.
      expect(await runBuild()).toMatchObject({
        status: "space_changed",
        embedded: 106,
        queued: 3,
        reembedding: "finishing"
      });
      // Nothing else asks for a build: the last jobs fail for good, and their ends do.
      // (A canceled job has no Gardener outcome: F4 D5.)
      await pool.query(
        "update jobs set status = 'canceled', outcome = null where type = 'topic-build'"
      );
      await pool.query("update jobs set run_after = now() where type = 'note-embedding'");
      await runHeavy();
      expect(
        await count("select count(*) from jobs where type = 'note-embedding' and status = 'failed'")
      ).toBeGreaterThanOrEqual(3);
      expect(await queuedBuilds()).toBe(1);

      // The new space's partition re-parents the pinned leaf: protected structure.
      perturb = (result) => {
        for (const key of result.frozenNodes ?? []) {
          const node = result.nodes.find((entry) => entry.key === key);
          if (node) node.parent = 0;
        }
      };
      await pool.query("update jobs set run_after = now() where type = 'topic-build'");
      const [moved] = resultOf(await drain(), topicJobTypes.build) as JsonResult[];
      expect(moved).toMatchObject({
        status: "applied",
        kind: "space",
        from: spaceB.spaceKey,
        spaceKey: spaceC.spaceKey,
        review: { status: "pending_review", protectedTouched: true },
        // The notes whose jobs failed are queued once more on a local route.
        followUps: { reembed: 3 }
      });
      // The tree moved with its structure (every topic ID) kept, its statistics in the new space.
      expect(await activeTree()).toMatchObject({ spaceKey: spaceC.spaceKey, dimensions: 1024 });
      expect(await liveTopics()).toEqual(liveBefore);
      const switched = (await loadTopicTreeCache(pool, tree.id))!;
      expect(getTopic(switched.state, pinnedId).parentId).toBe(parentBefore);
      expect(switched.staleStoredStats).toEqual([]);
      expect(
        await count(
          `select count(*) from topic_stats s join topics t on t.id = s.topic_id
            where t.tree_id = $1 and s.space_key <> $2`,
          [tree.id, spaceC.spaceKey]
        )
      ).toBe(0);
      expect(
        new Set(
          (await queuedEmbeddings()).rows
            .filter((job) => job.space === spaceC.spaceKey)
            .map((job) => job.note)
        )
      ).toEqual(failing);
      // The owner applies the proposal on the moved tree.
      const review = moved!.review as JsonResult;
      await expect(
        services.service.review({ changeSetId: review.changeSetId as string, decision: "apply" })
      ).resolves.toEqual({ status: "applied" });
      const applied = (await loadTopicTreeCache(pool, tree.id))!;
      expect(getTopic(applied.state, pinnedId).parentId).toBe(applied.state.rootId);
      expect(applied.space).toEqual(spaceC);
      expect(applied.staleStoredStats).toEqual([]);
    } finally {
      perturb = null;
      await heavy.stop();
    }
  });
});
