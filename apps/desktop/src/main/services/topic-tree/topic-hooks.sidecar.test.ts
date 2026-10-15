import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createChunkRepository,
  createIngestionRunRepository,
  createJobRepository,
  createPgPool,
  createTopicTreeLoadRepository,
  createTopicTreeRepository,
  noteVectorStrategyPrefix,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  topicStatsWrites,
  type JobRecord,
  type PgPool,
  type PostgresSidecarConnection,
  type Queryable,
  type TopicLoadSpace
} from "@app/db";
import { ProcessingPlanRequestSchema, ProcessingStages } from "@app/domain";
import {
  canonicalStateDump,
  createTopicTreeEditor,
  createTopicTreeState,
  deleteTopic,
  gaussianClusters,
  getTopic,
  itemKey,
  liveTopicIds,
  placementRecord,
  recomputeSubtree,
  registerItem,
  repairAll,
  statsDump,
  topicRecordOf,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { HierarchicalIngestionService } from "../hierarchical-ingestion-service.js";
import { JobSupervisor } from "../job-supervisor.js";
import { KnowledgeService } from "../knowledge-service.js";
import { SourceDeletionService } from "../source-deletion-service.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices } from "./index.js";
import { createTopicChangeHooks } from "./topic-hooks.js";
import type { TopicChangeHooks } from "./topic-hooks.js";
import { ItemVectorStore, loadTopicTreeCache } from "./topic-cache.js";
import { treeSpace } from "./topic-space.js";
import { TopicTriggers } from "./topic-triggers.js";

// The ingestion stages run in worker threads built for the packaged app. This proof runs them
// in-process: the chunker splits paragraphs, the embedding check returns its input.
vi.mock("../worker-supervisor.js", async () => {
  const { createHash: hash, randomUUID: uuid } = await import("node:crypto");
  return {
    WorkerSupervisor: class {
      async execute(type: string, payload: Record<string, unknown>) {
        if (type === "embedding") return { embedding: payload.embedding };
        if (type !== "chunking") throw new Error(`unexpected_worker_task:${type}`);
        let offset = 0;
        const chunks = String(payload.markdown)
          .split(/\n\n+/)
          .filter((text) => text.trim().length > 0)
          .map((content, chunkIndex) => {
            const startOffset = offset;
            offset += content.length + 2;
            return {
              id: uuid(),
              sourceSpanId: uuid(),
              chunkIndex,
              content,
              tokenCount: content.split(/\s+/).length,
              contentHash: hash("sha256").update(content).digest("hex"),
              startOffset,
              endOffset: startOffset + content.length
            };
          });
        return { chunks };
      }
      async shutdown() {}
    }
  };
});

/**
 * T15b on the real schema and a throwaway PostgreSQL sidecar: the topic hooks at their call sites.
 * A built tree over synthetic notes; then a discarded, archived and superseded note, a deleted
 * source, a hook that fails, and a source that is reingested (archived notes, replaced chunks,
 * a new composite vector) through the real `HierarchicalIngestionService` and `JobSupervisor`.
 * After each, the placements, the jobs the hooks enqueued and the tree's reachability are checked.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const space: TopicLoadSpace = {
  spaceKey: "topic-hooks-test-space",
  provider: "test",
  model: "synthetic-256",
  runtime: "none",
  dimensions: dim
};
const config: TopicTreeConfig = topicTreeConfigWith({
  fanOut: { min: 2, max: 4, targetMin: 2, targetMax: 3, hardMax: 6, rootTarget: 3 },
  leaf: { min: 2, max: 6, target: 4, hardMax: 12, minForTargetFanOut: 2 },
  depth: { target: 3, cap: 5 },
  areas: { min: 2, max: 4, target: 3 },
  bootstrap: { singleTopicMaxItems: 10 },
  repair: { mergeMaxSize: 10, directItemsSplitAt: 4 },
  jobs: { debounceMs: 3_600_000, debounceCapMs: 7_200_000 }
});
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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
const vectorText = (row: number) => `[${Array.from(vectorOf(row)).join(",")}]`;

async function startSidecar(workDir: string) {
  for (let attempt = 1; ; attempt += 1) {
    const manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, `database-${attempt}`),
      database: "memora_topic_hooks_test",
      user: "memora_topic_hooks_test",
      password: `topic-hooks-${randomUUID()}`,
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

/** Hooks whose jobs are due at once (the service's own debounce is an hour in this test). */
const immediate = { delayMs: 0, maxDelayMs: 0 };
const executableTopicJobs = ["topic-place", "topic-sweep", "topic-rebalance"];

describe.skipIf(!sidecarAvailable)("the topic hooks on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;
  let services: TopicTreeServices;
  let supervisor: JobSupervisor;
  let hooks: TopicChangeHooks;
  let knowledge: KnowledgeService;
  let hierarchy: HierarchicalIngestionService;
  let deletion: SourceDeletionService;
  const warnings: string[] = [];
  const sources: string[] = [];
  const groupOf = new Map<string, number>();
  const notesBySource = new Map<string, string[]>();
  let noteSerial = 0;

  async function insertSource(group: number, title: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "insert into source_items (id, type, title, content_hash) values ($1, 'Book', $2, $3)",
      [id, title, sha(`source-${id}`)]
    );
    const markdown = "Spacing.\n\nRetrieval practice.\n\nInterleaving.";
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, $4, $5)`,
      [randomUUID(), id, title, markdown, sha(markdown)]
    );
    sources.push(id);
    groupOf.set(id, group);
    notesBySource.set(id, []);
    return id;
  }

  /** Notes with a chunk each and a stored 256-d vector in the test space. */
  async function insertNotes(sourceId: string, rows: number[]): Promise<string[]> {
    const ids: string[] = [];
    for (const row of rows) {
      const id = randomUUID();
      const chunk = randomUUID();
      noteSerial += 1;
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         select $1, d.id, $2, $3, 'Passage', $4 from documents d where d.source_item_id = $2`,
        [chunk, sourceId, noteSerial, sha(`chunk-${chunk}`)]
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
          sha(`note-${row}-${noteSerial}`),
          vectorText(row)
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
  const queued = (type: string) =>
    count("select count(*) from jobs where type = $1 and status = 'queued'", [type]);
  /** The queued jobs as a transaction sees them, with the columns a deduped request touches. */
  const queuedJobs = async (db: Queryable = pool) =>
    (
      await db.query<{ id: string; type: string; runAfter: string; updatedAt: string }>(
        `select id, type, run_after::text as "runAfter", updated_at::text as "updatedAt"
           from jobs where status = 'queued' order by type, id`
      )
    ).rows;
  const placements = (noteIds: string[]) =>
    count("select count(*) from topic_placements where note_id = any($1::uuid[])", [noteIds]);

  /** Runs every due compute job, as the light lane would. */
  async function drain(): Promise<JobRecord[]> {
    const done: JobRecord[] = [];
    for (let job = await supervisor.runLightOnce("compute"); job;) {
      done.push(job);
      job = await supervisor.runLightOnce("compute");
    }
    return done;
  }

  /** Every current note and root source has a primary placement (E1), and nothing else does. */
  async function expectReachable(): Promise<void> {
    expect(
      await count(
        `select count(*) from atomic_notes a
          where a.status not in ('rejected', 'archived') and a.supersession_status = 'current'
            and not exists (select 1 from topic_placements p where p.note_id = a.id and p.rank = 0)`
      )
    ).toBe(0);
    expect(
      await count(
        `select count(*) from source_items s where s.parent_source_item_id is null
            and not exists (select 1 from topic_placements p where p.source_item_id = s.id and p.rank = 0)`
      )
    ).toBe(0);
    expect(
      await count(
        `select count(*) from topic_placements p
          where p.item_kind = 'note' and not exists (
            select 1 from atomic_notes a where a.id = p.note_id
              and a.status not in ('rejected', 'archived') and a.supersession_status = 'current')`
      )
    ).toBe(0);
  }

  /** The service's cache equals a fresh load, and stored statistics are exact (D7). */
  async function expectStatsExact(): Promise<void> {
    const tree = await activeTree();
    const fresh = (await loadTopicTreeCache(pool, tree.id))!;
    expect(fresh.staleStoredStats).toEqual([]);
    expect(await count("select count(*) from topic_stats where dirty")).toBe(0);
    const digest = services.service.cacheDigest();
    if (digest) {
      expect(digest.structure).toBe(canonicalStateDump(fresh.state));
      expect(digest.stats).toBe(statsDump(fresh.state));
    }
  }

  /** Writes a built tree into the empty active tree, the way the cold-start build (T19) will. */
  async function bootstrapBuild(): Promise<void> {
    const repository = createTopicTreeRepository(pool);
    const loader = createTopicTreeLoadRepository(pool);
    const tree = await activeTree();
    const noteIds = [...notesBySource.values()].flat();
    const owners = await loader.itemOwners({ noteIds });
    const vectors = await loader.loadItemVectors(
      treeSpace(tree),
      noteIds.map((id) => ({ kind: "note" as const, id }))
    );
    const state = createTopicTreeState({ dim, rootId: tree.rootId });
    const store = new ItemVectorStore(dim);
    const editor = createTopicTreeEditor(state, { record: false });
    vectors.keys.forEach((key, row) => {
      const id = key.slice("note:".length);
      registerItem(state, {
        key,
        kind: "note",
        contentHash: vectors.contentHashes[row]!,
        rootSource: itemKey("source", owners.notes.get(id)!.rootSourceId!)
      });
      store.set(key, vectors.matrix.data.subarray(row * dim, (row + 1) * dim));
      editor.placeItem(
        key,
        placementRecord(tree.rootId, {
          decidedBy: "build",
          itemFingerprint: vectors.contentHashes[row]!
        })
      );
    });
    recomputeSubtree(state, store);
    let topicNumber = 0;
    repairAll(
      {
        state,
        vectors: store,
        config,
        seed: 20261014,
        editor,
        newTopicId: () =>
          `00000000-0000-4000-9000-${(++topicNumber).toString(16).padStart(12, "0")}`,
        now: new Date().toISOString()
      },
      { force: true }
    );
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
    recomputeSubtree(state, store);
    const result = await repository.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: liveTopicIds(state)
        .filter((id) => id !== tree.rootId)
        .map((id) => topicRecordOf(getTopic(state, id))),
      placements: [...state.placements].flatMap(([item, list]) =>
        list.map((placement) => ({ item, placement }))
      ),
      stats: topicStatsWrites(state, store, liveTopicIds(state)),
      clock: state.clock
    });
    expect(result.kind).toBe("applied");
  }

  function deletionService(topicHooks: TopicChangeHooks): SourceDeletionService {
    return new SourceDeletionService({
      getPool: () => pool,
      getStorageSettings: async () => ({
        obsidianVaultPath: null,
        managedRoot: "Memora",
        obsidianSyncEnabled: false,
        obsidianSyncPaused: false,
        deletionPolicy: "tombstone",
        uploadCopiesEnabled: false,
        uploadCopiesFolderPath: null,
        updatedAt: new Date(0).toISOString()
      }),
      userDataPath: workDir,
      topicHooks
    });
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-hooks-"));
    ({ manager, connection } = await startSidecar(workDir));
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: { resolve: async () => ({ kind: "ready", space }) },
      env: {},
      isPackaged: false,
      logger: quiet,
      newTreeConfig: () => config,
      budgetStore: { read: async () => null, write: async () => undefined }
    });
    // The hooks the call sites receive: due at once, so the jobs they enqueue can be observed and
    // run (T19 registers the rebalance executor; its own follow-ups keep the hour's debounce).
    const triggers = new TopicTriggers({
      getPool: () => pool,
      isRegistered: (type) => executableTopicJobs.includes(type),
      debounce: () => immediate
    });
    hooks = createTopicChangeHooks(triggers, { warn: (message: string) => warnings.push(message) });
    supervisor = new JobSupervisor({
      getPool: () => pool,
      lightJobs: services.jobs,
      pollIntervalMs: 20,
      logger: quiet,
      topicHooks: hooks,
      // Chunk and header embeddings are the group's cluster vector: every source keeps its place.
      generateEmbedding: async (_text, _signal, context) => ({
        embedding: Array.from(
          vectorOf((groupOf.get(context?.sourceItemId ?? "") ?? 0) * pointsPerGroup)
        ),
        provider: space.provider,
        model: space.model,
        runtime: space.runtime,
        spaceKey: space.spaceKey
      })
    });
    knowledge = new KnowledgeService({
      getPool: () => pool,
      aiService: {} as never,
      userDataPath: workDir,
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null,
      topicHooks: hooks
    });
    hierarchy = new HierarchicalIngestionService({ getPool: () => pool, topicHooks: hooks });
    deletion = deletionService(hooks);

    // Four sources of 18 notes each, a tree built over them, and the four root sources placed.
    for (let group = 0; group < 4; group += 1) {
      const source = await insertSource(group, `Source ${group}`);
      await insertNotes(source, groupRows(group, 0, pointsPerGroup));
    }
    await services.ensureActiveTree();
    await bootstrapBuild();
    const tree = await activeTree();
    await services.triggers.place(
      tree.id,
      sources.map((rootSourceId) => ({ rootSourceId })),
      { debounce: immediate }
    );
    await drain();
  }, 180_000);

  afterAll(async () => {
    await supervisor?.stop().catch(() => undefined);
    services?.dispose();
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("starts from a reachable tree with exact statistics", async () => {
    expect(await count("select count(*) from topic_placements where rank = 0")).toBe(4 * 18 + 4);
    await expectReachable();
    await expectStatsExact();
  });

  it("takes a discarded note out of the tree through the real review path", async () => {
    const [note] = notesBySource.get(sources[0]!)!;
    await knowledge.reviewNote({ id: note!, action: "discard" });
    expect(await queued("topic-place")).toBe(1);
    const [ran] = await drain();
    expect(ran?.result).toMatchObject({ status: "applied", unplaced: 1 });
    expect(await placements([note!])).toBe(0);
    await expectReachable();
    await expectStatsExact();
  });

  it("takes archived and superseded notes out of the tree the same way", async () => {
    const [archived, superseded] = notesBySource.get(sources[1]!)!;
    await pool.query("update atomic_notes set status = 'archived' where id = $1", [archived]);
    await pool.query("update atomic_notes set supersession_status = 'superseded' where id = $1", [
      superseded
    ]);
    await hooks.notesChanged([archived!, superseded!]);
    // One PLACE for their root, however many of its notes changed.
    expect(await queued("topic-place")).toBe(1);
    const [ran] = await drain();
    expect(ran?.result).toMatchObject({ status: "applied", unplaced: 2 });
    expect(await placements([archived!, superseded!])).toBe(0);
    await expectReachable();
    await expectStatsExact();
  });

  it("deletes a source with its placements and enqueues the repair in the same transaction", async () => {
    const source = sources[2]!;
    const noteIds = notesBySource.get(source)!;
    expect(await placements(noteIds)).toBe(noteIds.length);
    const result = await deletion.delete(source);
    expect(result).toMatchObject({ deletedSources: 1, deletedAtomicNotes: noteIds.length });
    expect(await placements(noteIds)).toBe(0);
    expect(
      await count("select count(*) from topic_placements where source_item_id = $1", [source])
    ).toBe(0);
    // The cascade left the paths dirty, and the sweep and the rebalance are queued for the tree.
    expect(await count("select count(*) from topic_stats where dirty")).toBeGreaterThan(0);
    const tree = await activeTree();
    expect(await queued("topic-rebalance")).toBe(1);
    const sweep = await pool.query<{ payload: { treeId: string; reason: string } }>(
      "select payload from jobs where type = 'topic-sweep' and status = 'queued'"
    );
    expect(sweep.rows.map((row) => row.payload)).toEqual([
      { treeId: tree.id, reason: "dirty_stats" }
    ]);
    const [ran] = await drain();
    expect(ran?.result).toMatchObject({ status: "swept" });
    expect(Number(ran?.result?.recomputedTopics)).toBeGreaterThan(0);
    await expectReachable();
    await expectStatsExact();
    notesBySource.delete(source);
    sources.splice(sources.indexOf(source), 1);
  });

  it("enqueues nothing when the deleted source had no placements", async () => {
    await pool.query("update jobs set status = 'canceled' where status = 'queued'");
    const unplaced = await insertSource(0, "Not placed yet");
    await deletion.delete(unplaced);
    expect(await queued("topic-sweep")).toBe(0);
    expect(await queued("topic-rebalance")).toBe(0);
    sources.splice(sources.indexOf(unplaced), 1);
    notesBySource.delete(unplaced);
    groupOf.delete(unplaced);
  });

  it("commits or rolls back the repair jobs with the deletion", async () => {
    await pool.query("update jobs set status = 'canceled' where status = 'queued'");
    const source = await insertSource(3, "Deleted in a failing transaction");
    const noteIds = await insertNotes(source, groupRows(3, 0, 3));
    const tree = await activeTree();
    await services.triggers.place(tree.id, [{ rootSourceId: source }], { debounce: immediate });
    await drain();
    expect(await placements(noteIds)).toBe(3);
    // The applied PLACE asked for its follow-ups (T19): a debounced REBALANCE of the topics it
    // touched and, when one is due, the audit. They are queued before the deletion: not its jobs.
    const followUps = await queuedJobs();
    expect(followUps.filter((job) => job.type === "topic-rebalance")).toHaveLength(1);
    expect(followUps.filter((job) => job.type === "topic-sweep")).toHaveLength(0);
    // A deletion that fails after the repair was enqueued leaves the source, its placements and
    // the queue as they were: the repair lived and died in the deleting transaction.
    let seenInTransaction: Awaited<ReturnType<typeof queuedJobs>> = [];
    const failing = deletionService({
      ...hooks,
      itemsRemoved: async (options) => {
        await hooks.itemsRemoved(options);
        seenInTransaction = await queuedJobs(options?.client);
        throw new Error("deletion_failed_after_repair");
      }
    });
    await expect(failing.delete(source)).rejects.toThrow("deletion_failed_after_repair");
    // Inside the transaction the repair existed: a new sweep, and the rebalance request merged into
    // the queued follow-up (deduped, so its row was touched rather than a second one created).
    expect(seenInTransaction.filter((job) => job.type === "topic-sweep")).toHaveLength(1);
    const rebalance = followUps.find((job) => job.type === "topic-rebalance")!;
    const merged = seenInTransaction.filter((job) => job.type === "topic-rebalance");
    expect(merged.map((job) => job.id)).toEqual([rebalance.id]);
    expect(merged[0]!.updatedAt).not.toBe(rebalance.updatedAt);
    // After the rollback: no sweep, and the follow-ups exactly as they were before the deletion.
    expect(await count("select count(*) from source_items where id = $1", [source])).toBe(1);
    expect(await placements(noteIds)).toBe(3);
    expect(await queued("topic-sweep")).toBe(0);
    expect(await queuedJobs()).toEqual(followUps);
    expect(await count("select count(*) from topic_stats where dirty")).toBe(0);
    // Kept for the next test: the source stays in the library, placed.
  });

  it("never fails a deletion when a hook cannot enqueue: the sweep finds the dirty paths", async () => {
    const source = sources[sources.length - 1]!;
    const noteIds = notesBySource.get(source)!;
    warnings.length = 0;
    const broken = createTopicChangeHooks(
      new TopicTriggers({
        getPool: () => pool,
        isRegistered: () => true,
        debounce: () => {
          throw new Error("debounce_unavailable");
        }
      }),
      { warn: (message: string) => warnings.push(message) }
    );
    await expect(deletionService(broken).delete(source)).resolves.toMatchObject({
      deletedSources: 1
    });
    expect(await count("select count(*) from source_items where id = $1", [source])).toBe(0);
    expect(await placements(noteIds)).toBe(0);
    expect(warnings).toEqual(["Topic hook itemsRemoved failed; the topic sweep repairs it"]);
    expect(await queued("topic-sweep")).toBe(0);
    expect(await count("select count(*) from topic_stats where dirty")).toBeGreaterThan(0);
    // The startup sweep (and every cache load) is the net: nothing was lost.
    await services.start();
    await drain();
    await expectReachable();
    await expectStatsExact();
    notesBySource.delete(source);
    sources.splice(sources.indexOf(source), 1);
  });

  it("archives the notes a reingestion supersedes and hands them to the tree", async () => {
    const source = sources[0]!;
    // The first note was discarded earlier; the others are current, placed notes.
    const current = notesBySource.get(source)!.slice(1);
    expect(await placements(current)).toBe(current.length);
    await pool.query("update jobs set status = 'canceled' where status = 'queued'");
    await hierarchy.process({
      plan: ProcessingPlanRequestSchema.parse({
        preset: "custom",
        requestedStages: ["chunking", "embedding", "atomicNotes"],
        scope: "source_only",
        targetSourceItemIds: [source],
        previousArtifactPolicy: "preserve_reviewed_archive_pending"
      }),
      runKind: "reingestion",
      trigger: "library_action"
    });
    expect(
      await count(
        "select count(*) from atomic_notes where id = any($1::uuid[]) and status = 'archived' and supersession_status = 'superseded'",
        [current]
      )
    ).toBe(current.length);
    // One PLACE for the source's root, however many of its notes were archived.
    expect(await queued("topic-place")).toBe(1);
    const [ran] = await drain();
    expect(ran?.result).toMatchObject({ status: "applied", unplaced: current.length });
    expect(await placements(current)).toBe(0);
    await expectReachable();
    await expectStatsExact();
    // The reingestion's job reuses the existing chunks: it is not run here.
    await pool.query("update jobs set status = 'canceled' where type = 'ingestion'");
  });

  it("replaces the chunks of a placed source in the ingestion job and hands the tree its repair", async () => {
    const source = sources[1]!;
    const [document] = (
      await pool.query<{ id: string }>("select id from documents where source_item_id = $1", [
        source
      ])
    ).rows;
    const oldNotes = notesBySource.get(source)!;
    const placedBefore = await placements(oldNotes);
    expect(placedBefore).toBeGreaterThan(10);
    await pool.query("update jobs set status = 'canceled' where status = 'queued'");

    // An ingestion run whose chunking stage is still to do, as a retried or first run has it.
    const stages = ["chunking", "embedding"];
    const runs = createIngestionRunRepository(pool);
    const run = await runs.create({
      sourceItemId: source,
      runKind: "reingestion",
      requestedStages: stages,
      effectiveStages: stages,
      trigger: "library_action"
    });
    await runs.initializeStages(run.id, stages, ProcessingStages);
    const job = await createJobRepository(pool).create({
      type: "ingestion",
      payload: {
        ingestionRunId: run.id,
        sourceItemId: source,
        documentId: document!.id,
        markdown: "Spacing.\n\nRetrieval practice.\n\nInterleaving.",
        effectiveStages: stages,
        processingMode: "content"
      }
    });
    await runs.update(run.id, { jobId: job.id, currentStage: "chunking" });

    // The ingestion must not fail on the notes it deletes by cascade (D32).
    await supervisor.runOnce();
    expect((await createJobRepository(pool).findById(job.id))?.status).toBe("succeeded");
    expect(
      await count("select count(*) from atomic_notes where id = any($1::uuid[])", [oldNotes])
    ).toBe(0);
    expect(await placements(oldNotes)).toBe(0);
    // The repair was enqueued in the replacing transaction; the new composite vector queued PLACE.
    expect(await queued("topic-sweep")).toBe(1);
    expect(await queued("topic-rebalance")).toBe(1);
    expect(await queued("topic-place")).toBe(1);
    const repair = (await queuedJobs()).filter((job) => job.type !== "topic-place");
    expect(await count("select count(*) from topic_stats where dirty")).toBeGreaterThan(0);
    expect(
      await count(
        `select count(*) from embeddings_256 where target_type = 'source_item' and target_id = $1
            and strategy = $2`,
        [source, `source-composite-centroid-v2:${space.spaceKey}`]
      )
    ).toBe(1);

    // New notes arrive on the new chunks (generation and embedding) and reach the tree.
    notesBySource.set(source, []);
    const created = await insertNotes(source, groupRows(1, 0, 5));
    await hooks.notesChanged(created);
    expect(await queued("topic-place")).toBe(1);
    const ran = await drain();
    // The repair's sweep and REBALANCE (T19's executor) are due at once and run before PLACE; the
    // follow-ups PLACE asks for are debounced and wait.
    expect(new Set(ran.map((entry) => entry.type))).toEqual(
      new Set(["topic-place", "topic-sweep", "topic-rebalance"])
    );
    expect(ran.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(repair.map((job) => job.id))
    );
    expect(ran.every((entry) => entry.status === "succeeded")).toBe(true);
    expect(await placements(created)).toBe(5);
    await expectReachable();
    await expectStatsExact();
  }, 60_000);

  it("enqueues the repair in the replacing transaction of the repository itself", async () => {
    const source = sources[2]!;
    const [document] = (
      await pool.query<{ id: string }>("select id from documents where source_item_id = $1", [
        source
      ])
    ).rows;
    const noteIds = notesBySource.get(source)!;
    expect(await placements(noteIds)).toBe(noteIds.length);
    await pool.query("update jobs set status = 'canceled' where status = 'queued'");
    const chunkId = randomUUID();
    const spanId = randomUUID();
    await createChunkRepository(pool).replaceDocumentChunks(
      document!.id,
      source,
      [
        {
          id: chunkId,
          sourceSpanId: spanId,
          chunkIndex: 0,
          content: "A new passage.",
          tokenCount: 3,
          contentHash: sha("A new passage."),
          span: { id: spanId, startOffset: 0, endOffset: 14 }
        }
      ],
      { afterReplace: (client) => hooks.itemsRemoved({ client }) }
    );
    expect(await placements(noteIds)).toBe(0);
    expect(await queued("topic-sweep")).toBe(1);
    expect(await queued("topic-rebalance")).toBe(1);
    await drain();
    await expectReachable();
    await expectStatsExact();
  });

  it("adds little to the paths it hooks into", async () => {
    await pool.query("update jobs set status = 'canceled' where status = 'queued'");
    const placed = (
      await pool.query<{ id: string }>(
        "select note_id as id from topic_placements where note_id is not null limit 40"
      )
    ).rows.map((row) => row.id);
    const percentile = (values: number[], p: number) =>
      [...values].sort((a, b) => a - b)[
        Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
      ]!;
    const time = async (run: () => Promise<unknown>) => {
      const started = performance.now();
      await run();
      return performance.now() - started;
    };
    // A note's hand-over: one owner lookup and one deduped enqueue (all of them join one job).
    const notes: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      notes.push(await time(() => hooks.notesChanged([placed[index % placed.length]!])));
    }
    // A deleting or replacing transaction with nothing left dirty: a savepoint and one read.
    const removals: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        removals.push(await time(() => hooks.itemsRemoved({ client })));
      } finally {
        await client.query("rollback");
        client.release();
      }
    }
    const results = {
      notesChangedMs: { p50: percentile(notes, 0.5), p95: percentile(notes, 0.95) },
      itemsRemovedInTransactionMs: {
        p50: percentile(removals, 0.5),
        p95: percentile(removals, 0.95)
      },
      queuedPlaceJobs: await queued("topic-place")
    };
    // MEMORA_TOPIC_HOOKS_REPORT=1 prints the measurements for the task report.
    if (process.env.MEMORA_TOPIC_HOOKS_REPORT) {
      console.info(`[topic-hooks proof] ${JSON.stringify(results)}`);
    }
    expect(results.queuedPlaceJobs).toBeLessThanOrEqual(placed.length);
    // Generous bounds: the point is that a hook is a few statements, not a scan.
    expect(results.notesChangedMs.p95).toBeLessThan(250);
    expect(results.itemsRemovedInTransactionMs.p95).toBeLessThan(250);
    expect(await queued("topic-sweep")).toBe(0);
  });
});
