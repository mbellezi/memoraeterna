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
  topicTreeRecordsDump,
  type JobRecord,
  type PgPool,
  type TopicLoadSpace
} from "@app/db";
import { KnowledgeControlsSchema, type KnowledgeControls } from "@app/domain";
import {
  checkTopicClusteringResult,
  gaussianClusters,
  TopicClusteringRequestSchema,
  topicTreeConfigForPreset,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { clusterTopics } from "../../workers/topic-clustering.worker.js";
import { JobSupervisor } from "../job-supervisor.js";
import { KnowledgeControlsService } from "../gardener/knowledge-controls.js";
import { registerKnowledgeControlsIpc } from "../gardener/knowledge-controls-ipc.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices } from "./index.js";
import type { ClusterTopics } from "./topic-build.js";
import { topicJobTypes } from "./topic-jobs.js";
import { createStoredVectorSpaceResolver } from "./topic-space.js";
import { structuralConfigHash } from "./topic-tree-service.js";
import { immediateDebounce } from "./topic-triggers.js";

/**
 * The tree shape control (F4 D13, T98) on the real schema and a throwaway PostgreSQL sidecar: the
 * person changes the shape through the controls IPC, and the build proposes a rebuild for review
 * instead of applying it (D11: a tree-shape rebuild is always reviewed). Nothing moves until the
 * proposal is applied; a dismissed shape is not proposed again; a proposal that waits blocks a
 * second; applying one moves the tree to the shape, so nothing asks for it again.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const space: TopicLoadSpace = {
  spaceKey: "topic-shape-test-space",
  provider: "test",
  model: "synthetic-256",
  runtime: "none",
  dimensions: dim
};
/** The engine's own configuration with a first topic from 6 notes and no job debounce. */
const baseConfig = topicTreeConfigWith({
  bootstrap: { minItems: 6, singleTopicMaxItems: 12 },
  jobs: { debounceMs: 0, debounceCapMs: 0 }
});
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Three subjects of three clusters of 40 notes: leaves of 15 (Balanced) and of 10 (Deep) differ.
const groups = 3;
const notesPerGroup = 120;
const clusters = gaussianClusters({
  groups,
  clustersPerGroup: 3,
  pointsPerCluster: 40,
  dim,
  groupSpread: 0.6,
  pointNoise: 0.35,
  seed: 20261016
});
const vectorOf = (row: number) => clusters.matrix.data.slice(row * dim, (row + 1) * dim);
const clusterInProcess: ClusterTopics = async (request) => {
  const parsed = TopicClusteringRequestSchema.parse(request);
  const result = clusterTopics(parsed);
  checkTopicClusteringResult(result, parsed);
  return result;
};

describe.skipIf(!sidecarAvailable)("the tree shape control on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let services: TopicTreeServices;
  let supervisor: JobSupervisor;
  let stored: unknown = null;
  let controls: KnowledgeControlsService;
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();
  let shapeHandedOn: Promise<void> | null = null;

  const shapeConfig = (shape: KnowledgeControls["treeShape"]) =>
    topicTreeConfigForPreset(shape, baseConfig);
  const activeTree = async () => (await createTopicTreeRepository(pool).activeTree())!;
  const structure = async () =>
    topicTreeRecordsDump(
      await createTopicTreeRepository(pool).readTreeRecords((await activeTree()).id)
    );

  async function drain(): Promise<JobRecord[]> {
    const done: JobRecord[] = [];
    await pool.query("update jobs set run_after = now() where status = 'queued'");
    for (let job = await supervisor.runLightOnce("compute"); job;) {
      done.push(job);
      job = await supervisor.runLightOnce("compute");
    }
    return done;
  }
  const buildResults = (jobs: JobRecord[]) =>
    jobs.filter((job) => job.type === topicJobTypes.build).map((job) => job.result ?? {});
  const pending = () =>
    pool
      .query<{ id: string }>("select id from topic_change_sets where status = 'pending_review'")
      .then((result) => result.rows);

  /** The person picks a shape in Settings: the controls IPC stores it and hands it to the build. */
  async function chooseShape(shape: KnowledgeControls["treeShape"]) {
    shapeHandedOn = null;
    const answer = await handlers.get(ipcChannels.knowledgeControlsUpdate)!(
      {},
      { treeShape: shape }
    );
    await shapeHandedOn;
    return KnowledgeControlsSchema.parse(answer);
  }

  async function seedLibrary() {
    for (let group = 0; group < groups; group += 1) {
      const sourceId = randomUUID();
      await pool.query(
        `insert into source_items (id, type, title, content_hash) values ($1, 'Book', $2, $3)`,
        [sourceId, `Subject ${group}`, sha(`source-${group}`)]
      );
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, $3, 'seed', $4)`,
        [randomUUID(), sourceId, `Subject ${group}`, sha(`document-${group}`)]
      );
      for (let index = 0; index < notesPerGroup; index += 1) {
        const row = group * notesPerGroup + index;
        const noteId = randomUUID();
        const chunkId = randomUUID();
        await pool.query(
          `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
           select $1, d.id, $2, $3, 'Passage', $4 from documents d where d.source_item_id = $2`,
          [chunkId, sourceId, index, sha(`chunk-${chunkId}`)]
        );
        await pool.query(
          `insert into atomic_notes (id, title, body_markdown, idea_statement, ownership,
             created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
             generation_runtime, generation_prompt_version, generation_key)
           values ($1, 'Note', 'Body', 'Idea', 'source', $2, $3, 'test', 'test', 'test', 'test', $4)`,
          [noteId, sourceId, chunkId, `key-${noteId}`]
        );
        await pool.query(
          `insert into embeddings_256 (target_type, target_id, provider, model, runtime, usage,
             strategy, content_hash, embedding)
           values ('atomic_note', $1, $2, $3, $4, 'matching', $5, $6, $7::vector)`,
          [
            noteId,
            space.provider,
            space.model,
            space.runtime,
            `${noteVectorStrategyPrefix}${space.spaceKey}`,
            sha(`note-${row}`),
            `[${Array.from(vectorOf(row)).join(",")}]`
          ]
        );
      }
    }
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-shape-"));
    manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, "database"),
      database: "memora_topic_shape_test",
      user: "memora_topic_shape_test",
      password: `topic-shape-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    controls = new KnowledgeControlsService({
      store: {
        read: async () => stored,
        write: async (value) => {
          stored = structuredClone(value);
        }
      }
    });
    const resolver = createStoredVectorSpaceResolver(() => pool);
    services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: { resolve: () => resolver.resolve() },
      env: {},
      isPackaged: false,
      logger: quiet,
      // The product's wiring (main/index.ts): the shape the controls hold, proposed for review.
      newTreeConfig: () => shapeConfig(controls.current().treeShape),
      reviewConfigChanges: true,
      clusterTopics: clusterInProcess,
      budgetStore: { read: async () => null, write: async () => undefined }
    });
    supervisor = new JobSupervisor({
      getPool: () => pool,
      lightJobs: services.jobs,
      pollIntervalMs: 20,
      logger: quiet
    });
    registerKnowledgeControlsIpc(
      {
        handle: (channel, listener) => {
          handlers.set(channel, listener as never);
        }
      },
      () => controls,
      {
        treeShapeChanged: () => {
          shapeHandedOn = services.shapeChanged();
        }
      }
    );
    await controls.get();
    await seedLibrary();
  }, 180_000);

  afterAll(async () => {
    await supervisor?.stop().catch(() => undefined);
    services?.dispose();
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("builds the library to the Balanced shape, which is the engine's own configuration", async () => {
    expect(structuralConfigHash(shapeConfig("balanced"))).toBe(structuralConfigHash(baseConfig));
    expect((await services.ensureActiveTree())?.kind).toBe("ready");
    const tree = await activeTree();
    const roots = await pool.query<{ id: string }>(
      "select id from source_items where parent_source_item_id is null order by id"
    );
    await services.triggers.place(
      tree.id,
      roots.rows.map((row) => ({ rootSourceId: row.id })),
      { debounce: immediateDebounce }
    );
    const built = buildResults(await drain()).filter((result) => result.status === "applied");
    expect(built[0]).toMatchObject({ kind: "cold" });
    expect((await activeTree()).configHash).toBe(structuralConfigHash(shapeConfig("balanced")));
  });

  it("proposes a rebuild for a new shape and moves nothing until it is reviewed", async () => {
    const before = await structure();
    const treeBefore = await activeTree();
    expect((await chooseShape("broad")).treeShape).toBe("broad");
    const [build] = buildResults(await drain());
    expect(build).toMatchObject({ status: "pending_review", reason: "config" });
    // The proposal is one change-set, high risk (always reviewed), carrying the shape it is for.
    const proposals = await pool.query<{
      id: string;
      status: string;
      risk: string;
      origin: string;
      summary: { treeConfig?: { configHash: string } };
    }>(
      `select id, status, risk, origin, summary from topic_change_sets
        where tree_id = $1 and status = 'pending_review'`,
      [treeBefore.id]
    );
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]).toMatchObject({ origin: "rebuild", risk: "high" });
    expect(proposals.rows[0]!.summary.treeConfig?.configHash).toBe(
      structuralConfigHash(shapeConfig("broad"))
    );
    // Nothing moved: the structure, the generation and the tree's configuration are as they were.
    expect(await structure()).toBe(before);
    const treeAfter = await activeTree();
    expect(treeAfter.generation).toBe(treeBefore.generation);
    expect(treeAfter.configHash).toBe(treeBefore.configHash);
  });

  it("does not propose a second rebuild while one waits", async () => {
    expect(structuralConfigHash(shapeConfig("deep"))).not.toBe(
      structuralConfigHash(shapeConfig("balanced"))
    );
    await chooseShape("deep");
    expect(buildResults(await drain())[0]).toMatchObject({ status: "review_pending" });
    expect(await pending()).toHaveLength(1);
    await chooseShape("broad");
    await drain();
    expect(await pending()).toHaveLength(1);
  });

  it("keeps a dismissed shape from being proposed again, and leaves the tree as it was", async () => {
    const before = await structure();
    const treeBefore = await activeTree();
    const [proposal] = await pending();
    expect(
      await services.service.review({ changeSetId: proposal!.id, decision: "dismiss" })
    ).toEqual({ status: "dismissed" });
    expect(await structure()).toBe(before);
    expect((await activeTree()).configHash).toBe(treeBefore.configHash);
    // The same shape again: dismissed, not proposed (D39).
    await services.shapeChanged();
    expect(buildResults(await drain())[0]).toMatchObject({ status: "dismissed" });
    expect(await pending()).toHaveLength(0);
  });

  it("records a shape that moves nothing instead of proposing it", async () => {
    const before = await structure();
    await chooseShape("deep");
    const [build] = buildResults(await drain());
    expect(build).toMatchObject({ status: "applied", reason: "config", events: 0 });
    expect(await pending()).toHaveLength(0);
    expect(await structure()).toBe(before);
    expect((await activeTree()).configHash).toBe(structuralConfigHash(shapeConfig("deep")));
  });

  it("moves the tree to the shape when the proposal is applied, and nothing asks again", async () => {
    const before = await structure();
    await chooseShape("broad");
    const [build] = buildResults(await drain());
    expect(build).toMatchObject({ status: "pending_review", reason: "config" });
    const changeSetId = String(build!.changeSetId);
    expect(await services.service.review({ changeSetId, decision: "apply" })).toEqual({
      status: "applied"
    });
    expect(await structure()).not.toBe(before);
    const tree = await activeTree();
    expect(tree.configHash).toBe(structuralConfigHash(shapeConfig("broad")));
    expect(tree.config).toEqual(JSON.parse(JSON.stringify(shapeConfig("broad"))));
    // The tree is built under the shape the controls hold: the same hash, so no further rebuild.
    await services.triggers.request(topicJobTypes.audit, tree.id, null, {
      debounce: immediateDebounce
    });
    const audit = (await drain()).find((job) => job.type === topicJobTypes.audit);
    expect(audit?.result?.rebuild ?? null).not.toBe("config");
    expect(await pending()).toHaveLength(0);
    // Undoing the rebuild restores the structure exactly.
    const undone = await createTopicTreeRepository(pool).undoChangeSet({
      treeId: tree.id,
      changeSetId,
      titleKey: "topics.changeSets.undo"
    });
    expect(undone.kind).toBe("applied");
    expect(await structure()).toBe(before);
  });

  it("proposes nothing for the shape the tree already has", async () => {
    await chooseShape("broad");
    const results = buildResults(await drain());
    expect(results.every((result) => result.status !== "pending_review")).toBe(true);
    expect(await pending()).toHaveLength(0);
  });

  it("keeps rebuilding a growing library while a dismissed shape is held", async () => {
    // The tree back on Balanced (its structure moves nothing), then Broad proposed and dismissed.
    await chooseShape("balanced");
    expect(buildResults(await drain())[0]).toMatchObject({ status: "applied", reason: "config" });
    const balanced = await activeTree();
    await chooseShape("broad");
    expect(buildResults(await drain())[0]).toMatchObject({ status: "pending_review" });
    const [proposal] = await pending();
    await services.service.review({ changeSetId: proposal!.id, decision: "dismiss" });
    // The library has more than doubled since the tree was last built (its baseline says 150).
    const built = await pool.query<{ id: string }>(
      `update topic_change_sets set summary = jsonb_set(summary, '{notes}', '150')
        where id = (select id from topic_change_sets
                     where tree_id = $1 and origin in ('build', 'rebuild') and status = 'applied'
                     order by created_at desc, id desc limit 1)
        returning id`,
      [balanced.id]
    );
    expect(built.rows).toHaveLength(1);
    await services.shapeChanged();
    // The trigger still rebuilds, on the tree's own configuration; the dismissed shape stays so.
    expect(buildResults(await drain())[0]).toMatchObject({ reason: "doubling" });
    expect((await activeTree()).configHash).toBe(balanced.configHash);
    await services.shapeChanged();
    const after = buildResults(await drain());
    expect(after.every((result) => result.reason !== "config")).toBe(true);
    const proposals = await pool.query(
      `select 1 from topic_change_sets
        where status = 'pending_review' and summary ->> 'reason' = 'config'`
    );
    expect(proposals.rows).toHaveLength(0);
  });
});
