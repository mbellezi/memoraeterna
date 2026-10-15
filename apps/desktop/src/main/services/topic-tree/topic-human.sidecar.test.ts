import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { IpcMain } from "electron";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  createTopicTreeRepository,
  createViewHistoryRepository,
  noteVectorStrategyPrefix,
  resolvePostgresSidecarPaths,
  runMigrations,
  topicTreeRecordsDump,
  viewHistoryAddress,
  type JobRecord,
  type PgPool,
  type PostgresSidecarConnection,
  type TopicLoadSpace
} from "@app/db";
import type {
  TopicChangeSet,
  TopicMutationResult,
  TopicNodeSummary,
  TopicPage,
  TopicShape,
  TopicTree,
  TopicUndoResult
} from "@app/domain";
import {
  canonicalStateDump,
  checkTopicClusteringResult,
  gaussianClusters,
  getTopic,
  statsDump,
  TopicClusteringRequestSchema,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";

import { ipcChannels } from "../../../shared/ipc.js";
import { clusterTopics } from "../../workers/topic-clustering.worker.js";
import { JobSupervisor } from "../job-supervisor.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices } from "./index.js";
import type { ClusterTopics } from "./topic-build.js";
import { loadTopicTreeCache } from "./topic-cache.js";
import { createStoredVectorSpaceResolver } from "./topic-space.js";
import { immediateDebounce } from "./topic-triggers.js";

/**
 * Human structure operations (T26) on a real tree in a throwaway PostgreSQL sidecar: the handlers
 * `topics.mutate`, `topics.undo` and `topics.review` as the renderer calls them, with the rules
 * they must keep: a stale stamp is refused, a pin is one change-set with its view-history pin, undo
 * restores the stored tree exactly (E5), a proposal is applied or dismissed, and the statistics stay
 * exact after every operation (D7).
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const space: TopicLoadSpace = {
  spaceKey: "topic-human-test-space",
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
const groupRows = (group: number, from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => group * pointsPerGroup + from + index);

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
      database: "memora_topic_human_test",
      user: "memora_topic_human_test",
      password: `topic-human-${randomUUID()}`,
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

describe.skipIf(!sidecarAvailable)("human structure operations on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;
  let services: TopicTreeServices;
  let supervisor: JobSupervisor;
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>();
  const historyPushes: string[] = [];
  const sources: string[] = [];
  const notesBySource = new Map<string, string[]>();

  const call = async <T>(channel: string, payload?: unknown): Promise<T> =>
    (await handlers.get(channel)!({}, payload)) as T;
  const mutate = (payload: unknown) => call<TopicMutationResult>(ipcChannels.topicsMutate, payload);
  const undo = (changeSetId: string) =>
    call<TopicUndoResult>(ipcChannels.topicsUndo, { changeSetId });
  const children = async (parentId: string | null): Promise<TopicNodeSummary[]> =>
    (await call<TopicTree>(ipcChannels.topicsTree, { parentId, includeItems: false, itemLimit: 0 }))
      .nodes;
  const count = async (sql: string, values: unknown[] = []): Promise<number> =>
    Number((await pool.query<{ count: string }>(sql, values)).rows[0]?.count ?? 0);
  const activeTree = async () => (await createTopicTreeRepository(pool).activeTree())!;
  const stampOf = async (id: string): Promise<string> => {
    const tree = await call<TopicTree>(ipcChannels.topicsTree, { parentId: id, itemLimit: 0 });
    return tree.parent.updatedAt;
  };

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

  async function insertNotes(sourceId: string, rows: number[]): Promise<string[]> {
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
         values ($1, $5, 'Body', 'Idea', 'source', $2, $3, 'test', 'test', 'test', 'test', $4)`,
        [id, sourceId, chunk, `key-${id}`, `Note ${row}`]
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
          sha(`note-${row}-${id}`),
          `[${Array.from(vectorOf(row)).join(",")}]`
        ]
      );
      ids.push(id);
    }
    notesBySource.get(sourceId)!.push(...ids);
    return ids;
  }

  async function drain(): Promise<JobRecord[]> {
    const done: JobRecord[] = [];
    for (let job = await supervisor.runLightOnce("compute"); job;) {
      done.push(job);
      job = await supervisor.runLightOnce("compute");
    }
    return done;
  }

  /** The service's cache equals a fresh load and the stored statistics are exact (D7). */
  async function expectCacheExact(): Promise<void> {
    const tree = await activeTree();
    const fresh = (await loadTopicTreeCache(pool, tree.id))!;
    expect(fresh.staleStoredStats).toEqual([]);
    const digest = services.service.cacheDigest();
    if (digest) {
      expect(digest.generation).toBe(tree.generation);
      expect(digest.structure).toBe(canonicalStateDump(fresh.state));
      expect(digest.stats).toBe(statsDump(fresh.state));
    }
  }

  const dumpTree = async (): Promise<string> => {
    const tree = await activeTree();
    return topicTreeRecordsDump(await createTopicTreeRepository(pool).readTreeRecords(tree.id));
  };

  /** Two leaves that have different parents, a parent with at least two children and its root path. */
  async function pickTopics() {
    const tree = await activeTree();
    const cache = (await loadTopicTreeCache(pool, tree.id))!;
    const state = cache.state;
    const root = getTopic(state, state.rootId);
    const parents = root.children.filter((id) => getTopic(state, id).children.length >= 2);
    const [areaA, areaB] = parents;
    return { state, rootId: state.rootId, areaA: areaA!, areaB: areaB! };
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-human-"));
    ({ manager, connection } = await startSidecar(workDir));
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    const stored = createStoredVectorSpaceResolver(() => pool);
    services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: stored,
      env: {},
      isPackaged: false,
      logger: quiet,
      newTreeConfig: () => config,
      clusterTopics: clusterInProcess,
      budgetStore: { read: async () => null, write: async () => undefined },
      ipc: {
        main: {
          handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) =>
            handlers.set(channel, handler)
        } as unknown as IpcMain,
        targets: () => [
          {
            isDestroyed: () => false,
            send: (channel: string) => {
              if (channel === ipcChannels.viewHistoryChanged) historyPushes.push(channel);
            }
          }
        ]
      }
    });
    supervisor = new JobSupervisor({
      getPool: () => pool,
      lightJobs: services.jobs,
      pollIntervalMs: 20,
      logger: quiet
    });
    for (let group = 0; group < 4; group += 1) {
      const source = await insertSource(`Source ${group}`, `hash-${group}`);
      await insertNotes(source, groupRows(group, 0, pointsPerGroup));
    }
    const ensured = await services.ensureActiveTree();
    if (ensured?.kind !== "ready") throw new Error("no tree");
    await services.triggers.place(
      ensured.tree.id,
      sources.map((rootSourceId) => ({ rootSourceId })),
      { debounce: immediateDebounce }
    );
    await drain();
    expect(await count("select count(*) from topics where retired_at is null")).toBeGreaterThan(5);
  }, 120_000);

  afterAll(async () => {
    await supervisor?.stop().catch(() => undefined);
    services?.dispose();
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("renames a topic as one protected, human-named change-set and refuses a stale stamp", async () => {
    const [area] = await children(null);
    const stamp = await stampOf(area!.id);
    const before = (await activeTree()).generation;
    await expect(
      mutate({
        op: "rename",
        id: area!.id,
        title: "Memória",
        expectedUpdatedAt: "2020-01-01T00:00:00.000Z"
      })
    ).rejects.toThrow("topics.errors.stale");
    expect((await activeTree()).generation).toBe(before);

    const result = await mutate({
      op: "rename",
      id: area!.id,
      title: "  Memória  ",
      expectedUpdatedAt: stamp
    });
    expect(result.generation).toBe(before + 1);
    const row = (
      await pool.query<{
        title: string;
        name_state: string;
        name_source: string;
        management: string;
        named: string;
      }>(
        `select title, name_state, name_source, management, named_change_set_id as named
           from topics where id = $1`,
        [area!.id]
      )
    ).rows[0];
    expect(row).toMatchObject({
      title: "Memória",
      name_state: "named",
      name_source: "human",
      management: "human",
      named: result.changeSetId
    });
    const stored = await pool.query<{ origin: string; title_key: string; status: string }>(
      "select origin, title_key, status from topic_change_sets where id = $1",
      [result.changeSetId]
    );
    expect(stored.rows[0]).toEqual({
      origin: "human",
      title_key: "topics.changeSets.humanRename",
      status: "applied"
    });
    // The stamp it was made from is spent, and the same title again changes nothing.
    await expect(
      mutate({ op: "rename", id: area!.id, title: "Other", expectedUpdatedAt: stamp })
    ).rejects.toThrow("topics.errors.stale");
    await expect(
      mutate({
        op: "rename",
        id: area!.id,
        title: "Memória",
        expectedUpdatedAt: await stampOf(area!.id)
      })
    ).rejects.toThrow("topics.errors.unchanged");
    await expectCacheExact();
    // The page names the change and offers its undo.
    const page = await call<TopicPage>(ipcChannels.topicsPage, { id: area!.id });
    expect(page.lastChange).toMatchObject({
      changeSetId: result.changeSetId,
      titleKey: "topics.changeSets.humanRename",
      undo: "available"
    });
  });

  it("refuses a duplicate sibling title, a cycle, the root and a missing topic", async () => {
    const { rootId, areaA, areaB, state } = await pickTopics();
    const [first, second] = [areaA, areaB];
    await mutate({
      op: "rename",
      id: first,
      title: "Física",
      expectedUpdatedAt: await stampOf(first)
    });
    await expect(
      mutate({
        op: "rename",
        id: second,
        title: "fisica",
        expectedUpdatedAt: await stampOf(second)
      })
    ).rejects.toThrow("topics.errors.duplicateTitle");
    const child = getTopic(state, first).children[0]!;
    await expect(
      mutate({
        op: "move",
        id: first,
        parentId: child,
        expectedUpdatedAt: await stampOf(first)
      })
    ).rejects.toThrow("topics.errors.cycle");
    await expect(
      mutate({ op: "rename", id: rootId, title: "Root", expectedUpdatedAt: await stampOf(rootId) })
    ).rejects.toThrow("topics.errors.invalid");
    await expect(mutate({ op: "pin", id: randomUUID() })).rejects.toThrow("topics.errors.notFound");
    await expectCacheExact();
  });

  it("moves a topic with exact statistics, and undo restores the stored tree exactly (E5)", async () => {
    const { areaA, areaB, state } = await pickTopics();
    const moving = getTopic(state, areaB).children[0]!;
    const dump = await dumpTree();
    const pushes = historyPushes.length;
    const moved = await mutate({
      op: "move",
      id: moving,
      parentId: areaA,
      expectedUpdatedAt: await stampOf(moving)
    });
    const row = (
      await pool.query<{ parent_id: string; management: string }>(
        "select parent_id, management from topics where id = $1",
        [moving]
      )
    ).rows[0];
    expect(row).toEqual({ parent_id: areaA, management: "human" });
    await expectCacheExact();
    expect(await dumpTree()).not.toBe(dump);

    const undone = await undo(moved.changeSetId);
    expect(undone).toMatchObject({ status: "undone" });
    expect(await dumpTree()).toBe(dump);
    await expectCacheExact();
    expect(await count("select count(*) from topic_stats where dirty")).toBe(0);
    // The undo is a change-set of its own, and it cannot be undone again.
    expect(
      (await call<TopicChangeSet>(ipcChannels.topicsChangeSet, { id: moved.changeSetId })).summary
    ).toMatchObject({ status: "undone" });
    expect(historyPushes.length).toBe(pushes);
  });

  it("creates a subtopic, which undo removes", async () => {
    const { areaA } = await pickTopics();
    const dump = await dumpTree();
    const created = await mutate({ op: "create", parentId: areaA, title: "Notas soltas" });
    const topic = (
      await pool.query<{ id: string; management: string; name_source: string }>(
        "select id, management, name_source from topics where parent_id = $1 and title = 'Notas soltas'",
        [areaA]
      )
    ).rows[0];
    expect(topic).toMatchObject({ management: "human", name_source: "human" });
    await expect(mutate({ op: "create", parentId: areaA, title: "notas SOLTAS" })).rejects.toThrow(
      "topics.errors.duplicateTitle"
    );
    await expectCacheExact();
    expect(await undo(created.changeSetId)).toMatchObject({ status: "undone" });
    expect(await dumpTree()).toBe(dump);
    await expectCacheExact();
  });

  it("pins a topic with its view-history pin in one change-set; undo restores both (D28)", async () => {
    const { areaB } = await pickTopics();
    const address = viewHistoryAddress("topic", areaB);
    const history = createViewHistoryRepository(pool);
    const pushes = historyPushes.length;
    const pinned = await mutate({ op: "pin", id: areaB });
    expect(
      (await pool.query("select management from topics where id = $1", [areaB])).rows[0]
    ).toEqual({ management: "pinned" });
    expect(
      (await history.list({ kinds: ["topic"] })).find((entry) => entry.address === address)
    ).toMatchObject({ pinned: true });
    expect(historyPushes.length).toBe(pushes + 1);

    expect(await undo(pinned.changeSetId)).toMatchObject({ status: "undone" });
    expect(
      (
        await pool.query<{ management: string }>("select management from topics where id = $1", [
          areaB
        ])
      ).rows[0]?.management
    ).not.toBe("pinned");
    expect(
      (await history.list({ kinds: ["topic"] })).find((entry) => entry.address === address)
    ).toMatchObject({ pinned: false });

    // Unpinning leaves a protected topic; undoing the unpin pins both effects again.
    await mutate({ op: "pin", id: areaB });
    const unpinned = await mutate({ op: "unpin", id: areaB });
    expect(
      (
        await pool.query<{ management: string }>("select management from topics where id = $1", [
          areaB
        ])
      ).rows[0]?.management
    ).toBe("human");
    expect(
      (await history.list({ kinds: ["topic"] })).find((entry) => entry.address === address)
    ).toMatchObject({ pinned: false });
    expect(await undo(unpinned.changeSetId)).toMatchObject({ status: "undone" });
    expect(
      (
        await pool.query<{ management: string }>("select management from topics where id = $1", [
          areaB
        ])
      ).rows[0]?.management
    ).toBe("pinned");
    expect(
      (await history.list({ kinds: ["topic"] })).find((entry) => entry.address === address)
    ).toMatchObject({ pinned: true });
    await expectCacheExact();
  });

  it("refuses a pin past the view history's limit without half doing it", async () => {
    const { areaA } = await pickTopics();
    const history = createViewHistoryRepository(pool);
    const pinnedNow = (await history.list()).filter((entry) => entry.pinned).length;
    for (let n = pinnedNow; n < 10; n += 1) {
      const id = randomUUID();
      await history.record({ kind: "topic", objectId: id, title: `Filler ${n}` });
      await history.setPinned(viewHistoryAddress("topic", id), true);
    }
    const before = await activeTree();
    const changeSets = await count("select count(*) from topic_change_sets");
    const managementBefore = (
      await pool.query<{ management: string }>("select management from topics where id = $1", [
        areaA
      ])
    ).rows[0]!.management;
    await expect(mutate({ op: "pin", id: areaA })).rejects.toThrow("errors.viewHistory.pinLimit");
    expect((await activeTree()).generation).toBe(before.generation);
    expect(await count("select count(*) from topic_change_sets")).toBe(changeSets);
    expect(
      (
        await pool.query<{ management: string }>("select management from topics where id = $1", [
          areaA
        ])
      ).rows[0]?.management
    ).toBe(managementBefore);
    await expectCacheExact();
    await pool.query("delete from view_history where title like 'Filler %'");
  });

  it("places a note by hand: as the primary, as an also-in, and one that waited for a place", async () => {
    const { areaA, areaB, state } = await pickTopics();
    const target = getTopic(state, areaA).children[0]!;
    const [note] = notesBySource.get(sources[3]!)!;
    const dump = await dumpTree();
    const primary = await mutate({
      op: "placeItem",
      item: { kind: "note", id: note! },
      topicId: target,
      role: "primary"
    });
    expect(
      (
        await pool.query(
          "select topic_id, management, decided_by from topic_placements where note_id = $1 and rank = 0",
          [note]
        )
      ).rows[0]
    ).toEqual({ topic_id: target, management: "human", decided_by: "human" });
    await expectCacheExact();
    expect(await undo(primary.changeSetId)).toMatchObject({ status: "undone" });
    expect(await dumpTree()).toBe(dump);

    // A note that is not in the tree yet (its vector exists, PLACE has not run).
    const [fresh] = await insertNotes(sources[0]!, groupRows(0, 0, 1));
    const placed = await mutate({
      op: "placeItem",
      item: { kind: "note", id: fresh!.toUpperCase() },
      topicId: target,
      role: "primary"
    });
    expect(await count("select count(*) from topic_placements where note_id = $1", [fresh])).toBe(
      1
    );
    // PLACE leaves a human placement where the person put it.
    await services.triggers.place((await activeTree()).id, [{ rootSourceId: sources[0]! }], {
      debounce: immediateDebounce
    });
    await drain();
    expect(
      (
        await pool.query("select topic_id from topic_placements where note_id = $1 and rank = 0", [
          fresh
        ])
      ).rows[0]
    ).toEqual({ topic_id: target });
    await expectCacheExact();

    // "Also in" needs a primary and stays off its path.
    const secondary = await mutate({
      op: "placeItem",
      item: { kind: "note", id: fresh! },
      topicId: getTopic(state, areaB).children[0]!,
      role: "secondary"
    });
    expect(
      await count("select count(*) from topic_placements where note_id = $1 and rank > 0", [fresh])
    ).toBe(1);
    await expect(
      mutate({
        op: "placeItem",
        item: { kind: "note", id: fresh! },
        topicId: target,
        role: "secondary"
      })
    ).rejects.toThrow("topics.errors.invalid");
    await expect(
      mutate({
        op: "placeItem",
        item: { kind: "note", id: randomUUID() },
        topicId: target,
        role: "primary"
      })
    ).rejects.toThrow("topics.errors.notFound");
    expect(await undo(secondary.changeSetId)).toMatchObject({ status: "undone" });
    expect(await undo(placed.changeSetId)).toMatchObject({ status: "undone" });
    await expectCacheExact();
  });

  it("blocks the undo of a change-set a later one depends on, and never undoes a build", async () => {
    const { areaA } = await pickTopics();
    const first = await mutate({
      op: "rename",
      id: areaA,
      title: "Primeiro nome",
      expectedUpdatedAt: await stampOf(areaA)
    });
    const second = await mutate({
      op: "rename",
      id: areaA,
      title: "Segundo nome",
      expectedUpdatedAt: await stampOf(areaA)
    });
    const blocked = await undo(first.changeSetId);
    expect(blocked).toMatchObject({
      status: "blocked",
      blockers: [{ kind: "changeSet", changeSetId: second.changeSetId }]
    });
    expect((await call<TopicPage>(ipcChannels.topicsPage, { id: areaA })).lastChange).toMatchObject(
      { changeSetId: second.changeSetId, undo: "available" }
    );
    // Undoing the later one first frees the earlier one.
    expect(await undo(second.changeSetId)).toMatchObject({ status: "undone" });
    expect(await undo(first.changeSetId)).toMatchObject({ status: "undone" });
    const build = (
      await pool.query<{ id: string }>(
        "select id from topic_change_sets where origin = 'build' order by created_at limit 1"
      )
    ).rows[0]!;
    expect(await undo(build.id)).toMatchObject({
      status: "blocked",
      blockers: [{ kind: "conflict", code: "notUndoable" }]
    });
    await expect(undo(randomUUID())).rejects.toThrow("topics.errors.notFound");
    await expectCacheExact();
  });

  it("undoes the last change from the Topic page banner and from Shape's changed today (E5 c)", async () => {
    const { areaA, areaB, state } = await pickTopics();
    const leafA = getTopic(state, areaA).children[0]!;
    // From the banner of the page.
    const dumpBanner = await dumpTree();
    await mutate({
      op: "move",
      id: leafA,
      parentId: areaB,
      expectedUpdatedAt: await stampOf(leafA)
    });
    const page = await call<TopicPage>(ipcChannels.topicsPage, { id: leafA });
    expect(page.lastChange).toMatchObject({ undo: "available" });
    expect(await undo(page.lastChange!.changeSetId)).toMatchObject({ status: "undone" });
    expect(await dumpTree()).toBe(dumpBanner);
    // From "changed today" of the shape.
    await mutate({
      op: "move",
      id: leafA,
      parentId: areaB,
      expectedUpdatedAt: await stampOf(leafA)
    });
    const shape = await call<TopicShape>(ipcChannels.topicsShape, {});
    const today = shape.changedToday.find(
      (change) => change.origin === "human" && change.undo === "available"
    );
    expect(today).toBeDefined();
    const detail = await call<TopicChangeSet>(ipcChannels.topicsChangeSet, { id: today!.id });
    expect(detail.after.topics.map((topic) => topic.id)).toContain(leafA);
    expect(await undo(today!.id)).toMatchObject({ status: "undone" });
    expect(await dumpTree()).toBe(dumpBanner);
    await expectCacheExact();
  });

  it("applies or dismisses a proposal that waits for the owner (D29)", async () => {
    const { areaA, areaB, state } = await pickTopics();
    const repository = createTopicTreeRepository(pool);
    const tree = await activeTree();
    const moving = getTopic(state, areaB).children.at(-1)!;
    const node = getTopic(state, moving);
    const proposal = (parentId: string, from = node) =>
      repository.applyChangeSet({
        treeId: tree.id,
        expectedGeneration: 0,
        status: "pending_review",
        origin: "rebalance",
        titleKey: "topics.changeSets.proposal",
        events: [
          {
            op: "topic.move",
            topicId: moving,
            before: { parentId: from.parentId!, position: from.position },
            after: { parentId, position: 0 }
          }
        ]
      });
    const waiting = await proposal(areaA);
    if (waiting.kind !== "pending") throw new Error("not pending");
    expect(
      (await call<TopicShape>(ipcChannels.topicsShape, {})).warnings.some(
        (warning) => warning.pendingReview && warning.changeSetId === waiting.changeSetId
      )
    ).toBe(true);

    const generation = (await activeTree()).generation;
    await expect(
      call(ipcChannels.topicsReview, { changeSetId: waiting.changeSetId, decision: "dismiss" })
    ).resolves.toEqual({ status: "dismissed" });
    expect((await activeTree()).generation).toBe(generation);
    expect(
      (await call<TopicShape>(ipcChannels.topicsShape, {})).warnings.some(
        (warning) => warning.changeSetId === waiting.changeSetId
      )
    ).toBe(false);
    // A resolved proposal answers with its status instead of failing.
    await expect(
      call(ipcChannels.topicsReview, { changeSetId: waiting.changeSetId, decision: "apply" })
    ).resolves.toEqual({ status: "dismissed" });

    const dump = await dumpTree();
    const second = await proposal(areaA);
    if (second.kind !== "pending") throw new Error("not pending");
    await expect(
      call(ipcChannels.topicsReview, { changeSetId: second.changeSetId, decision: "apply" })
    ).resolves.toEqual({ status: "applied" });
    expect(
      (await pool.query("select parent_id from topics where id = $1", [moving])).rows[0]
    ).toEqual({ parent_id: areaA });
    await expectCacheExact();
    // The applied proposal is a change-set like any other: it can be undone.
    expect(await undo(second.changeSetId)).toMatchObject({ status: "undone" });
    expect(await dumpTree()).toBe(dump);

    // A proposal the tree has moved away from no longer applies and stays waiting.
    const third = await proposal(areaA);
    if (third.kind !== "pending") throw new Error("not pending");
    await mutate({
      op: "move",
      id: moving,
      parentId: areaA,
      expectedUpdatedAt: await stampOf(moving)
    });
    await expect(
      call(ipcChannels.topicsReview, { changeSetId: third.changeSetId, decision: "apply" })
    ).rejects.toThrow("topics.errors.stale");
    expect(
      (await pool.query("select status from topic_change_sets where id = $1", [third.changeSetId]))
        .rows[0]
    ).toEqual({ status: "pending_review" });
    await expect(
      call(ipcChannels.topicsReview, { changeSetId: randomUUID(), decision: "apply" })
    ).rejects.toThrow("topics.errors.notFound");
    await expectCacheExact();
  });

  it("keeps a topic a person moved where it is through REBALANCE", async () => {
    const { areaA, areaB, state } = await pickTopics();
    const moving = getTopic(state, areaB).children[0]!;
    await mutate({
      op: "move",
      id: moving,
      parentId: areaA,
      expectedUpdatedAt: await stampOf(moving)
    });
    // Notes pile up around the topic's neighbours and REBALANCE runs on everything it touched.
    const [source] = sources;
    await insertNotes(source!, groupRows(0, 0, 14));
    await services.triggers.place((await activeTree()).id, [{ rootSourceId: source! }], {
      debounce: immediateDebounce
    });
    await drain();
    const tree = await activeTree();
    await services.triggers.request("topic-rebalance", tree.id, null, {
      debounce: immediateDebounce
    });
    await drain();
    const row = (
      await pool.query<{ parent_id: string; retired_at: string | null; management: string }>(
        "select parent_id, retired_at, management from topics where id = $1",
        [moving]
      )
    ).rows[0];
    expect(row).toMatchObject({ parent_id: areaA, retired_at: null, management: "human" });
    await expectCacheExact();
  }, 60_000);
});
