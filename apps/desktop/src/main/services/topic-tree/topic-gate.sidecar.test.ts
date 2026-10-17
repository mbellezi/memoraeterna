import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAiConfigRepository,
  createLibraryResetRepository,
  createLocalModelRepository,
  createPgPool,
  createTopicTreeRepository,
  noteVectorStrategyPrefix,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  topicStatsWrites,
  type JobRecord,
  type PgPool,
  type PostgresSidecarConnection,
  type TopicLoadSpace
} from "@app/db";
import {
  createRng,
  createTopicTreeEditor,
  createTopicTreeState,
  gateTextVersion,
  getTopic,
  itemKey,
  liveTopicIds,
  placementRecord,
  recomputeSubtree,
  registerItem,
  shapeReport,
  topicRecordOf,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AiRankInput, AiRankResult, DecideRouteStatus } from "../ai-service.js";
import { JobSupervisor } from "../job-supervisor.js";
import { createTopicTreeServices, engineStatusOf } from "./index.js";
import type { TopicTreeServices, TopicTreeServicesOptions } from "./index.js";
import { ItemVectorStore, loadTopicTreeCache } from "./topic-cache.js";
import { topicGateLimits, topicGateOperation } from "./topic-gate.js";
import { immediateDebounce } from "./topic-triggers.js";

/**
 * The placement gate (T23) against the real schema on a throwaway PostgreSQL sidecar: PLACE parks
 * an ambiguous note with `needs_gate`, the `topic-gate` job ranks its candidate leaves on a fake
 * validated ranker routed as `class:decide`, applies the D10 rule as one `gate` change-set and
 * records the decision with its raw log-odds. Also: "none of these", the decision cache, no
 * validated route (owner decision 19's fallback in PLACE and in the gate job, REBALANCE grouping
 * fallback notes, and a ranker deciding them again once ready), the deterministic golden mode, an
 * item that is no longer ambiguous, and a tree that moves while the ranker runs.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const space: TopicLoadSpace = {
  spaceKey: "topic-gate-test-space",
  provider: "test",
  model: "synthetic-256",
  runtime: "none",
  dimensions: dim
};
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/** Leaves admit any item near them, so the margin alone decides what is ambiguous. */
const config: TopicTreeConfig = topicTreeConfigWith({
  placement: { spreadFactor: 10, spreadFloor: 0.2, ambiguityMargin: 0.05 },
  // Jobs enqueued by triggers stay out of the way unless a test runs them on purpose.
  jobs: { debounceMs: 3_600_000, debounceCapMs: 7_200_000 }
});

type LeafKey = "A1" | "A2" | "B";
const leaves: Array<{
  key: LeafKey;
  parent: "A" | null;
  title: string;
  axis: number;
  notes: string[];
}> = [
  {
    key: "A1",
    parent: "A",
    title: "Sleep",
    axis: 0,
    notes: ["Sleep and memory", "Sleep stages", "Sleep deprivation", "Naps after lunch"]
  },
  {
    key: "A2",
    parent: "A",
    title: "Retrieval practice",
    axis: 1,
    notes: ["Retrieval practice", "Testing effect", "Free recall", "Flashcards"]
  },
  {
    key: "B",
    parent: null,
    title: "Oceans",
    axis: 2,
    notes: ["Ocean currents", "Tides and the moon", "Deep water", "Coastal climate"]
  }
];

/** A unit vector on `axes` (equal weights) plus seeded noise. */
function vectorOn(axes: number[], seed: number, noise = 0.05): Float32Array {
  const rng = createRng(seed);
  const vector = new Float32Array(dim);
  for (const axis of axes) vector[axis] = 1;
  for (let k = 0; k < dim; k += 1) vector[k] = (vector[k] as number) + noise * rng.gaussian();
  const length = Math.hypot(...vector);
  return vector.map((value) => value / length);
}

type Responder = (input: AiRankInput) => number[];

/** The topic a descriptor names, or null for an unnamed one. */
const topicLine = (document: string): string | null =>
  /^Topic: (.+)$/mu.exec(document)?.[1] ?? null;

/** The fake ranker's default judgement: the topic whose name opens the query's title wins. */
const byTitle: Responder = (input) => {
  const title = (/^Title: (.+)$/mu.exec(input.query)?.[1] ?? "").toLowerCase();
  return input.documents.map((document) => {
    const topic = topicLine(document)?.toLowerCase().split(" ")[0] ?? "";
    return topic !== "" && title.includes(topic) ? 6 : -6;
  });
};

async function startSidecar(workDir: string) {
  for (let attempt = 1; ; attempt += 1) {
    const manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, `database-${attempt}`),
      database: "memora_topic_gate_test",
      user: "memora_topic_gate_test",
      password: `topic-gate-${randomUUID()}`,
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

describe.skipIf(!sidecarAvailable)("the placement gate on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-gate-"));
    ({ manager, connection } = await startSidecar(workDir));
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  // -------------------------------------------------------------------------
  // A fresh library, tree, ranker route and services for every test

  interface World {
    services: TopicTreeServices;
    supervisor: JobSupervisor;
    treeId: string;
    topics: Record<"A" | LeafKey, string>;
    rankerId: string;
    route: { status: DecideRouteStatus };
    ranks: AiRankInput[];
    clock: { now: number };
    setResponder(responder: Responder): void;
    /** Runs once inside the next rank call, before it answers (the tree moving meanwhile). */
    duringRank: { run: (() => Promise<void>) | null };
    dispose(): Promise<void>;
  }

  async function insertSource(title: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "insert into source_items (id, type, title, content_hash) values ($1, 'Book', $2, $3)",
      [id, title, sha(`source-${title}-${id}`)]
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [id, id, title, sha(`document-${id}`)]
    );
    return id;
  }

  /** A note with its 256-d vector in the tree's space; returns its id and content hash. */
  async function insertNote(
    source: string,
    index: number,
    note: { title: string; idea: string; body: string },
    vector: Float32Array
  ): Promise<{ id: string; hash: string }> {
    const id = randomUUID();
    const chunk = randomUUID();
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $2, $3, 'Passage', $4)`,
      [chunk, source, index, sha(`chunk-${chunk}`)]
    );
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, language, ownership,
         created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, 'en', 'source', $5, $6, 'test', 'test', 'test', 'test', $7)`,
      [id, note.title, note.body, note.idea, source, chunk, `key-${id}`]
    );
    const hash = sha(`note-${note.title}-${note.idea}`);
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
        hash,
        `[${Array.from(vector).join(",")}]`
      ]
    );
    return { id, hash };
  }

  /** A validated ranker routed as `class:decide` (what the gate keys its decisions by). */
  async function seedRanker(): Promise<string> {
    const models = createLocalModelRepository(pool);
    const model = await models.upsertModel({
      catalogId: "test-qwen3-reranker",
      modelId: "test-qwen3-reranker",
      displayName: "Test ranker",
      family: "qwen3",
      variant: "reranker",
      repository: "Qwen/Qwen3-Reranker-0.6B",
      revision: "test-revision",
      runtime: "gguf",
      format: "gguf",
      quantization: "q8_0",
      expectedSizeBytes: 1,
      manifestHash: sha("manifest"),
      capabilities: ["reranking", "offline"],
      licenseName: "Apache-2.0",
      licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0"
    });
    await models.updateModel(model.id, { status: "ready", managedPath: join(workDir, "ranker") });
    const ai = createAiConfigRepository(pool);
    const profile = await ai.createProfile({ name: "Ranker", privacyMode: "offline_only" });
    await ai.updateProfile({
      id: profile.id,
      localModelId: model.id,
      modelId: model.modelId,
      runtime: "gguf",
      capabilities: ["reranking"]
    });
    await ai.seedTaskRoute("class:decide", profile.id);
    return model.id;
  }

  async function world(
    options: { env?: Record<string, string | undefined>; seed?: (w: Seeding) => Promise<void> } = {}
  ): Promise<World> {
    await createLibraryResetRepository(pool).reset();
    await pool.query("delete from ai_task_profile_routes");
    await pool.query("delete from ai_profile_sets");
    await pool.query("delete from local_models");
    const rankerId = await seedRanker();
    const clock = { now: Date.parse("2026-10-15T12:00:00.000Z") };
    const route: World["route"] = { status: "ready" };
    const ranks: AiRankInput[] = [];
    const duringRank: World["duringRank"] = { run: null };
    let responder: Responder = byTitle;

    const fake = {
      decideRouteStatus: vi.fn(async (operation?: string) => {
        expect(operation).toBe(topicGateOperation);
        return route.status;
      }),
      rank: vi.fn(async (input: AiRankInput): Promise<AiRankResult> => {
        ranks.push(input);
        if (route.status !== "ready") throw new Error("errors.localModels.rankerNotValidated");
        const pending = duringRank.run;
        duringRank.run = null;
        if (pending) await pending();
        const logOdds = responder(input);
        const tokenCounts = input.documents.map(
          (document) => 20 + Math.ceil((input.query.length + document.length) / 4)
        );
        const aiTaskRunId = await createAiConfigRepository(pool).recordTaskRun({
          taskType: "reranking",
          provider: "local-gguf",
          modelId: "test-qwen3-reranker",
          runtime: "gguf",
          inputTokens: tokenCounts.reduce((sum, count) => sum + count, 0),
          outputTokens: 0,
          costEstimate: 0,
          durationMs: 1,
          status: "succeeded",
          sourceItemIds: input.sourceIds ?? []
        });
        return {
          logOdds,
          scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
          tokenCounts,
          truncated: input.documents.map((document) => document.includes("Deep water")),
          aiTaskRunId,
          profileId: randomUUID(),
          localModelId: rankerId,
          provider: "local-gguf",
          modelId: "test-qwen3-reranker",
          runtime: "gguf",
          durationMs: 1,
          queueMs: 0
        };
      }),
      runDefaultTask: vi.fn(async () => null),
      activeEmbeddingSpace: vi.fn(async () => null)
    };

    const services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: { resolve: async () => ({ kind: "ready", space }) },
      env: options.env ?? {},
      isPackaged: false,
      logger: quiet,
      newTreeConfig: () => config,
      ai: fake as unknown as NonNullable<TopicTreeServicesOptions["ai"]>,
      now: () => new Date(clock.now)
    });
    const supervisor = new JobSupervisor({
      getPool: () => pool,
      lightJobs: services.jobs,
      pollIntervalMs: 20,
      logger: quiet
    });

    const ensured = await services.ensureActiveTree();
    if (ensured?.kind !== "ready") throw new Error("the tree was not created");
    const tree = ensured.tree;
    const rootId = tree.rootId;
    const state = createTopicTreeState({ dim, rootId });
    const store = new ItemVectorStore(dim);
    const editor = createTopicTreeEditor(state, { record: false });
    const named = (title: string) => ({
      title,
      nameState: "named" as const,
      nameSource: "llm" as const,
      nameLanguage: "en"
    });
    const topics = { A: randomUUID() } as World["topics"];
    editor.createTopic(topics.A, rootId, named("Memory"));
    let seed = 1;
    for (const leaf of leaves) {
      topics[leaf.key] = randomUUID();
      editor.createTopic(
        topics[leaf.key],
        leaf.parent ? topics[leaf.parent] : rootId,
        named(leaf.title)
      );
      const source = await insertSource(`Book ${leaf.key}`);
      for (const [index, title] of leaf.notes.entries()) {
        const vector = vectorOn([leaf.axis], seed++);
        const note = await insertNote(
          source,
          index,
          { title, idea: `${title} in one sentence.`, body: `${title}. A longer passage.` },
          vector
        );
        const key = itemKey("note", note.id);
        registerItem(state, {
          key,
          kind: "note",
          contentHash: note.hash,
          rootSource: itemKey("source", source)
        });
        store.set(key, vector);
        editor.placeItem(
          key,
          placementRecord(topics[leaf.key], { decidedBy: "build", itemFingerprint: note.hash })
        );
      }
    }
    await options.seed?.({ state, store, editor, rootId });
    recomputeSubtree(state, store);
    const built = await createTopicTreeRepository(pool).bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: liveTopicIds(state)
        .filter((id) => id !== rootId)
        .map((id) => topicRecordOf(getTopic(state, id))),
      placements: [...state.placements].flatMap(([key, list]) =>
        list.map((placement) => ({ item: key, placement }))
      ),
      stats: topicStatsWrites(state, store, liveTopicIds(state)),
      clock: state.clock
    });
    if (built.kind !== "applied") throw new Error(`the tree was not seeded: ${built.kind}`);
    services.service.invalidate();
    services.changes.flush();

    return {
      services,
      supervisor,
      treeId: tree.id,
      topics,
      rankerId,
      route,
      ranks,
      clock,
      duringRank,
      setResponder: (next) => {
        responder = next;
      },
      dispose: async () => {
        await supervisor.stop().catch(() => undefined);
        services.dispose();
      }
    };
  }

  /** What a test may add to the seeded tree before it is stored. */
  interface Seeding {
    state: ReturnType<typeof createTopicTreeState>;
    store: ItemVectorStore;
    editor: ReturnType<typeof createTopicTreeEditor>;
    rootId: string;
  }

  /** Adds `count` notes on `axis` (one new source) to the seeded topic titled `title`. */
  async function fillTopic(
    seed: Seeding,
    title: string,
    axis: number,
    count: number
  ): Promise<void> {
    const topic = [...seed.state.topics.values()].find((node) => node.title === title)!;
    const source = await insertSource(`${title} handbook`);
    for (let index = 0; index < count; index += 1) {
      const name = `${title} fact ${index}`;
      const vector = vectorOn([axis], 10_000 + 1_000 * axis + index);
      const note = await insertNote(
        source,
        index,
        { title: name, idea: `${name} in one sentence.`, body: `${name}. A passage.` },
        vector
      );
      const key = itemKey("note", note.id);
      registerItem(seed.state, {
        key,
        kind: "note",
        contentHash: note.hash,
        rootSource: itemKey("source", source)
      });
      seed.store.set(key, vector);
      seed.editor.placeItem(
        key,
        placementRecord(topic.id, { decidedBy: "build", itemFingerprint: note.hash })
      );
    }
  }

  /** Runs every queued `compute` job until none is left, as a drained light lane would. */
  async function drainCompute(w: World): Promise<JobRecord[]> {
    const done: JobRecord[] = [];
    for (let pass = 0; pass < 50; pass += 1) {
      await pool.query("update jobs set run_after = now() where status = 'queued'");
      const job = await w.supervisor.runLightOnce("compute");
      if (!job) return done;
      done.push(job);
    }
    throw new Error("the compute worker never drained");
  }

  const resultsOf = (jobs: JobRecord[], type: string) =>
    jobs.filter((job) => job.type === type).map((job) => job.result ?? { error: job.error });

  async function primaryCount(topicId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "select count(*) from topic_placements where topic_id = $1 and rank = 0",
      [topicId]
    );
    return Number(result.rows[0]!.count);
  }

  /** Hard violations of the stored tree as the audit counts them (E1). */
  async function storedHardViolations(w: World): Promise<number> {
    const cache = (await loadTopicTreeCache(pool, w.treeId))!;
    return shapeReport(cache.state, config).violations.hardCount;
  }

  /** Makes the queued jobs of one type due and parks the others a day away. */
  async function makeDue(type: string): Promise<void> {
    await pool.query(
      `update jobs set run_after = case when type = $1 then now() else now() + interval '1 day' end
        where status = 'queued'`,
      [type]
    );
  }

  async function runDue(w: World, type: string, worker: "compute" | "model"): Promise<JobRecord> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await makeDue(type);
      const job = await w.supervisor.runLightOnce(worker);
      if (job?.type === type) return job;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`no ${type} job ran`);
  }

  async function queued(type: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      "select count(*) from jobs where type = $1 and status = 'queued'",
      [type]
    );
    return Number(result.rows[0]!.count);
  }

  async function finished(
    job: JobRecord
  ): Promise<JobRecord & { result: Record<string, unknown> }> {
    const result = await pool.query<{ status: string; result: Record<string, unknown> }>(
      "select status, result from jobs where id = $1",
      [job.id]
    );
    return { ...job, ...result.rows[0]! } as JobRecord & { result: Record<string, unknown> };
  }

  /** A new source with one note between Sleep and Retrieval practice, placed by PLACE. */
  async function ambiguousNote(
    w: World,
    title = "Sleep consolidates memories"
  ): Promise<{ id: string; source: string }> {
    const source = await insertSource(`Article ${title}`);
    const note = await insertNote(
      source,
      0,
      {
        title,
        idea: "Sleep after study helps recall.",
        body: "Sleep and recall interact. ".repeat(30)
      },
      vectorOn([0, 1], 999)
    );
    await w.services.triggers.notesChanged([note.id]);
    await runDue(w, "topic-place", "compute");
    return { id: note.id, source };
  }

  interface PlacementRow {
    topicId: string;
    decidedBy: string;
    needsGate: boolean;
    needsSplitCheck: boolean;
    rank: number;
  }
  async function placements(noteId: string): Promise<PlacementRow[]> {
    const result = await pool.query<PlacementRow>(
      `select topic_id as "topicId", decided_by as "decidedBy", needs_gate as "needsGate",
              needs_split_check as "needsSplitCheck", rank
         from topic_placements where note_id = $1 order by rank`,
      [noteId]
    );
    return result.rows;
  }

  async function sourcePlacement(sourceId: string): Promise<PlacementRow | undefined> {
    const result = await pool.query<PlacementRow>(
      `select topic_id as "topicId", decided_by as "decidedBy", needs_gate as "needsGate",
              needs_split_check as "needsSplitCheck", rank
         from topic_placements where source_item_id = $1 and rank = 0`,
      [sourceId]
    );
    return result.rows[0];
  }

  async function decisions(noteId: string) {
    const result = await pool.query<{
      chosenTopicId: string | null;
      noneOfThese: boolean;
      candidates: Array<{
        topicId: string;
        descriptorHash: string;
        cosine: number;
        logOdds: number | null;
        truncated?: boolean;
      }>;
      deciderKey: string;
      aiTaskRunId: string | null;
    }>(
      `select chosen_topic_id as "chosenTopicId", none_of_these as "noneOfThese", candidates,
              decider_key as "deciderKey", ai_task_run_id as "aiTaskRunId"
         from topic_gate_decisions where item_id = $1 order by created_at`,
      [noteId]
    );
    return result.rows;
  }

  // -------------------------------------------------------------------------

  it("lets the validated ranker place an ambiguous note and its source in one change-set", async () => {
    const w = await world();
    try {
      const note = await ambiguousNote(w);
      // PLACE parked the note and its root source (same vector) at Memory with needs_gate and
      // asked for the gate; nothing waited for AI.
      expect(await placements(note.id)).toMatchObject([
        { topicId: w.topics.A, needsGate: true, decidedBy: "fallback" }
      ]);
      expect(await sourcePlacement(note.source)).toMatchObject({
        topicId: w.topics.A,
        needsGate: true
      });
      expect(w.ranks).toHaveLength(0);
      expect(await queued("topic-gate")).toBe(1);

      w.services.changes.flush();
      const pushed: Array<string | null> = [];
      w.services.changes.subscribe((event) => pushed.push(event.changeSetId));
      const job = await finished(await runDue(w, "topic-gate", "model"));
      expect(job.status).toBe("succeeded");
      expect(job.result).toMatchObject({ status: "applied", accepted: 2, none: 0, calls: 2 });

      // Sleep, and "also in" Retrieval practice: the runner-up leaf within the secondary gap.
      expect(await placements(note.id)).toMatchObject([
        { rank: 0, topicId: w.topics.A1, decidedBy: "gate", needsGate: false },
        { rank: 1, topicId: w.topics.A2, decidedBy: "gate" }
      ]);

      expect(await sourcePlacement(note.source)).toMatchObject({
        topicId: w.topics.A1,
        decidedBy: "gate",
        needsGate: false
      });

      // One audited background call per item on the gate's operation, for the note's source,
      // whose texts carry content only, in content-key order.
      expect(w.ranks).toHaveLength(2);
      const call = w.ranks.find((rank) => rank.query.startsWith("Title: Sleep"))!;
      const sourceCall = w.ranks.find((rank) => rank.query.startsWith("Title: Article"))!;
      expect(sourceCall.query).toMatch(
        /^Title: Article Sleep consolidates memories\nAbout: \{ .*"title": "Article Sleep consolidates memories".*\}\nNotes: Sleep consolidates memories$/u
      );
      expect(sourceCall.sourceIds).toEqual([note.source]);
      expect(call).toMatchObject({
        operation: topicGateOperation,
        priority: "P2",
        sourceIds: [note.source],
        jobId: job.id,
        stage: "topic_gate"
      });
      expect(call.query).toMatch(/^Title: Sleep consolidates.*\nIdea: .*\nText: /u);
      expect(Array.from(call.query.split("\nText: ")[1]!).length).toBe(400);
      expect(call.documents.length).toBeGreaterThanOrEqual(2);
      expect(call.documents.length).toBeLessThanOrEqual(config.gate.maxCandidates);
      for (const text of [call.query, ...call.documents]) expect(text).not.toMatch(uuidPattern);
      const hashes = call.documents.map((document) => sha(`${gateTextVersion}\n${document}`));
      expect([...hashes].sort()).toEqual(hashes);
      expect(call.documents.some((document) => document.startsWith("Topic: Sleep\n"))).toBe(true);
      expect(call.documents.find((document) => document.startsWith("Topic: Sleep\n"))).toMatch(
        /\nExamples: [^\n]+; [^\n]+; [^\n]+$/u
      );

      // The decision, with its raw log-odds, is the cache of this item, descriptor set and ranker.
      const [decision] = await decisions(note.id);
      expect(decision).toMatchObject({ chosenTopicId: w.topics.A1, noneOfThese: false });
      expect(decision!.deciderKey).toContain("ranker:gguf:Qwen/Qwen3-Reranker-0.6B@test-revision");
      expect(decision!.candidates.map((candidate) => candidate.logOdds)).toEqual(
        expect.arrayContaining([6, -6])
      );
      expect(
        decision!.candidates.every((candidate) => typeof candidate.truncated === "boolean")
      ).toBe(true);
      expect(decision!.candidates.some((candidate) => candidate.truncated === true)).toBe(true);
      expect(decision!.aiTaskRunId).not.toBeNull();
      const sources = await pool.query(
        "select source_item_id from ai_task_run_sources where ai_task_run_id = $1",
        [decision!.aiTaskRunId]
      );
      expect(sources.rows).toEqual([{ source_item_id: note.source }]);

      const changeSet = await pool.query<{
        origin: string;
        titleKey: string;
        summary: Record<string, unknown>;
      }>(
        `select origin, title_key as "titleKey", summary from topic_change_sets
          where tree_id = $1 and origin = 'gate'`,
        [w.treeId]
      );
      expect(changeSet.rows).toHaveLength(1);
      expect(changeSet.rows[0]).toMatchObject({
        titleKey: "topics.changeSets.gate",
        summary: { accepted: 2, calls: 2, cacheHits: 0 }
      });
      const metrics = await pool.query<{ gateCalls: number }>(
        'select gate_calls as "gateCalls" from topic_daily_metrics where tree_id = $1',
        [w.treeId]
      );
      expect(metrics.rows).toEqual([{ gateCalls: 2 }]);
      w.services.changes.flush();
      expect(pushed).toHaveLength(1);
      expect(pushed[0]).not.toBeNull();
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("keeps a note no candidate fits at its ancestor, flagged for a split check", async () => {
    const w = await world();
    try {
      w.setResponder((input) => input.documents.map(() => -5));
      const note = await ambiguousNote(w);
      const job = await finished(await runDue(w, "topic-gate", "model"));
      expect(job.result).toMatchObject({ status: "applied", accepted: 0, none: 2 });
      expect(await placements(note.id)).toMatchObject([
        { topicId: w.topics.A, needsGate: false, needsSplitCheck: true }
      ]);
      expect(await decisions(note.id)).toMatchObject([{ chosenTopicId: null, noneOfThese: true }]);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("reuses a cached decision for the same content, descriptors and ranker without a call", async () => {
    const w = await world();
    try {
      const note = await ambiguousNote(w);
      await runDue(w, "topic-gate", "model");
      expect(w.ranks).toHaveLength(2);
      const repository = createTopicTreeRepository(pool);
      const gateSet = await pool.query<{ id: string }>(
        "select id from topic_change_sets where tree_id = $1 and origin = 'gate'",
        [w.treeId]
      );
      const undone = await repository.undoChangeSet({
        treeId: w.treeId,
        changeSetId: gateSet.rows[0]!.id,
        titleKey: "topics.changeSets.undo"
      });
      expect(undone.kind).toBe("applied");
      expect(await placements(note.id)).toMatchObject([{ topicId: w.topics.A, needsGate: true }]);

      await w.services.triggers.request(
        "topic-gate",
        w.treeId,
        { rootSourceId: note.source },
        {
          debounce: immediateDebounce
        }
      );
      const job = await finished(await runDue(w, "topic-gate", "model"));
      expect(job.result).toMatchObject({ status: "applied", accepted: 2, calls: 0, cacheHits: 2 });
      expect(w.ranks).toHaveLength(2);
      expect((await placements(note.id))[0]).toMatchObject({
        topicId: w.topics.A1,
        decidedBy: "gate",
        needsGate: false
      });
      expect(await decisions(note.id)).toHaveLength(1);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("treats a gated note as the gate's none without a validated ranker, and decides it again once one is ready", async () => {
    const w = await world();
    try {
      // Owner decision 19: PLACE finds no validated decider, so the ambiguous note and its root
      // source are the gate's "none" at once: movable new-topic candidates, marked fallback-none.
      w.route.status = "not_validated";
      const note = await ambiguousNote(w);
      expect(await placements(note.id)).toMatchObject([
        { topicId: w.topics.A, needsGate: false, needsSplitCheck: true, decidedBy: "fallback-none" }
      ]);
      expect(await sourcePlacement(note.source)).toMatchObject({
        topicId: w.topics.A,
        decidedBy: "fallback-none",
        needsGate: false
      });
      expect(await queued("topic-gate")).toBe(0);
      expect(w.ranks).toHaveLength(0);
      const placeSet = await pool.query<{ summary: Record<string, unknown> }>(
        "select summary from topic_change_sets where tree_id = $1 and origin = 'place'",
        [w.treeId]
      );
      expect(placeSet.rows).toEqual([
        { summary: expect.objectContaining({ needsGate: 0, fallbackNone: 2 }) }
      ]);

      const status = await w.services.service.status();
      expect(status.counts).toMatchObject({ needsGate: 0, fallbackNone: 2 });
      const noDecider = await w.services.gate!.waitingForDecider(
        status.counts.needsGate + status.counts.fallbackNone
      );
      expect(engineStatusOf(status, noDecider)).toMatchObject({ blocked: "no_decider" });

      // A sweep while no ranker is ready sends nothing to the gate.
      await w.services.triggers.sweep("requested", {
        treeId: w.treeId,
        debounce: immediateDebounce
      });
      const idle = await finished(await runDue(w, "topic-sweep", "compute"));
      expect(idle.result).toMatchObject({ gateJobs: 0, fallbackScopes: 1 });

      // A ranker becomes ready: the next committed change (after the recheck interval) asks the
      // sweep to send the fallback items to the gate, which decides them again (T26f).
      w.route.status = "ready";
      w.clock.now += topicGateLimits.routeRecheckMs + 1;
      w.services.changes.record({
        treeId: w.treeId,
        generation: 1,
        topicIds: null,
        changeSetId: null
      });
      w.services.changes.flush();
      for (let attempt = 0; attempt < 100 && (await queued("topic-sweep")) === 0; attempt += 1) {
        await new Promise((done) => setTimeout(done, 20));
      }
      expect(await queued("topic-sweep")).toBe(1);
      const sweep = await finished(await runDue(w, "topic-sweep", "compute"));
      expect(sweep.result).toMatchObject({ gateJobs: 1, fallbackScopes: 1 });
      const gate = await finished(await runDue(w, "topic-gate", "model"));
      expect(gate.result).toMatchObject({ status: "applied", accepted: 2, calls: 2 });
      expect((await placements(note.id))[0]).toMatchObject({
        topicId: w.topics.A1,
        decidedBy: "gate",
        needsGate: false,
        needsSplitCheck: false
      });
      const left = await pool.query<{ count: string }>(
        "select count(*) from topic_placements where tree_id = $1 and decided_by = 'fallback-none'",
        [w.treeId]
      );
      expect(Number(left.rows[0]!.count)).toBe(0);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("gives items already waiting with needs_gate the fallback when the gate job finds no ranker", async () => {
    let waitingNote = "";
    let waitingSource = "";
    const w = await world({
      seed: async (seed) => {
        waitingSource = await insertSource("Waiting article");
        const vector = vectorOn([0, 1], 999);
        const note = await insertNote(
          waitingSource,
          0,
          { title: "Sleep and recall", idea: "Sleep helps recall.", body: "Sleep and recall." },
          vector
        );
        waitingNote = note.id;
        const key = itemKey("note", note.id);
        registerItem(seed.state, {
          key,
          kind: "note",
          contentHash: note.hash,
          rootSource: itemKey("source", waitingSource)
        });
        seed.store.set(key, vector);
        // Gated while a ranker was routed; the ranker is gone since.
        seed.editor.placeItem(
          key,
          placementRecord([...seed.state.topics.values()].find((n) => n.title === "Memory")!.id, {
            decidedBy: "fallback",
            itemFingerprint: note.hash,
            needsGate: true
          })
        );
      }
    });
    try {
      w.route.status = "missing";
      await w.services.triggers.request(
        "topic-gate",
        w.treeId,
        { rootSourceId: waitingSource },
        { debounce: immediateDebounce }
      );
      const job = await finished(await runDue(w, "topic-gate", "model"));
      expect(job.result).toMatchObject({ status: "no_decider", route: "missing", fallback: 1 });
      expect(w.ranks).toHaveLength(0);
      expect(await placements(waitingNote)).toMatchObject([
        { topicId: w.topics.A, decidedBy: "fallback-none", needsGate: false, needsSplitCheck: true }
      ]);
      const gateSet = await pool.query<{ summary: Record<string, unknown> }>(
        "select summary from topic_change_sets where tree_id = $1 and origin = 'gate'",
        [w.treeId]
      );
      expect(gateSet.rows).toEqual([
        { summary: expect.objectContaining({ fallback: 1, accepted: 0, calls: 0 }) }
      ]);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("lets REBALANCE group fallback notes into a new leaf, where a ranker decides them again", async () => {
    // Fuller leaves, so that no arriving note pulls a leaf's centroid towards the next ones.
    const w = await world({
      seed: async (seed) => {
        await fillTopic(seed, "Sleep", 0, 6);
        await fillTopic(seed, "Retrieval practice", 1, 6);
      }
    });
    try {
      w.route.status = "not_validated";
      const source = await insertSource("Article Sleep before exams");
      const ids: string[] = [];
      const arriving = config.repair.directItemsSplitAt + 1;
      for (let index = 0; index < arriving; index += 1) {
        const title = `Sleep before an exam ${index}`;
        const note = await insertNote(
          source,
          index,
          { title, idea: `${title} helps recall.`, body: `${title}. A longer passage.` },
          vectorOn([0, 1], 700 + index, 0.005)
        );
        ids.push(note.id);
      }
      await w.services.triggers.notesChanged(ids);
      const place = await finished(await runDue(w, "topic-place", "compute"));
      expect(place.result).toMatchObject({ status: "applied", needsGate: 0 });
      expect(place.result.fallbackNone).toBe(arriving + 1);
      for (const id of ids) {
        expect(await placements(id)).toMatchObject([
          { topicId: w.topics.A, decidedBy: "fallback-none", needsSplitCheck: true }
        ]);
      }

      // REBALANCE groups the new-topic candidates into a new leaf below Memory.
      const drained = await drainCompute(w);
      expect(resultsOf(drained, "topic-rebalance")).toContainEqual(
        expect.objectContaining({ status: "applied" })
      );
      const homes = new Set<string>();
      for (const id of ids) {
        const [primary] = await placements(id);
        expect(primary).toMatchObject({ decidedBy: "fallback-none", needsSplitCheck: false });
        homes.add(primary!.topicId);
      }
      expect(homes.size).toBe(1);
      const [leaf] = [...homes];
      expect([w.topics.A, w.topics.A1, w.topics.A2]).not.toContain(leaf);
      const parent = await pool.query<{ parentId: string }>(
        'select parent_id as "parentId" from topics where id = $1',
        [leaf]
      );
      expect(parent.rows[0]?.parentId).toBe(w.topics.A);
      expect(await storedHardViolations(w)).toBe(0);

      // A ranker is validated: the sweep sends the fallback items to the gate, which decides
      // them again where REBALANCE put them, and nothing is marked fallback-none afterwards.
      w.route.status = "ready";
      await w.services.triggers.sweep("requested", {
        treeId: w.treeId,
        debounce: immediateDebounce
      });
      const sweep = await finished(await runDue(w, "topic-sweep", "compute"));
      expect(sweep.result).toMatchObject({ gateJobs: 1, fallbackScopes: 1 });
      const gate = await finished(await runDue(w, "topic-gate", "model"));
      // Their new leaf is now the clear best, so PLACE's decision applies without a rank call.
      expect(gate.result).toMatchObject({
        status: "applied",
        items: arriving + 1,
        redecided: arriving + 1,
        calls: 0,
        fallback: 0
      });
      for (const id of ids) {
        expect(await placements(id)).toMatchObject([{ topicId: leaf, decidedBy: "auto" }]);
      }
      const remaining = await pool.query<{ count: string }>(
        "select count(*) from topic_placements where tree_id = $1 and decided_by = 'fallback-none'",
        [w.treeId]
      );
      expect(Number(remaining.rows[0]!.count)).toBe(0);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("makes no gate call in a deterministic golden run (G1)", async () => {
    const w = await world({
      env: { MEMORA_GOLDEN_RUN: "golden-small", MEMORA_GOLDEN_TOPICS: "deterministic" }
    });
    try {
      const note = await ambiguousNote(w);
      expect(await placements(note.id)).toMatchObject([{ topicId: w.topics.A, needsGate: true }]);
      expect(await queued("topic-gate")).toBe(0);
      await w.services.triggers.request(
        "topic-gate",
        w.treeId,
        { rootSourceId: note.source },
        {
          debounce: immediateDebounce
        }
      );
      const job = await finished(await runDue(w, "topic-gate", "model"));
      expect(job.result).toMatchObject({ status: "skipped", reason: "deterministic" });
      expect(w.ranks).toHaveLength(0);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("places an item that is no longer ambiguous by PLACE's decision, with no call", async () => {
    let waitingNote = "";
    let waitingSource = "";
    const w = await world({
      seed: async (seed) => {
        waitingSource = await insertSource("Waiting article");
        const vector = vectorOn([2], 4242);
        const note = await insertNote(
          waitingSource,
          0,
          { title: "Gulf Stream", idea: "A warm current.", body: "The Gulf Stream." },
          vector
        );
        waitingNote = note.id;
        const key = itemKey("note", note.id);
        registerItem(seed.state, {
          key,
          kind: "note",
          contentHash: note.hash,
          rootSource: itemKey("source", waitingSource)
        });
        seed.store.set(key, vector);
        // It waits at the root for a gate, but its vector clearly belongs to Oceans now.
        seed.editor.placeItem(
          key,
          placementRecord(seed.rootId, {
            decidedBy: "fallback",
            itemFingerprint: note.hash,
            needsGate: true
          })
        );
      }
    });
    try {
      await w.services.triggers.request(
        "topic-gate",
        w.treeId,
        { rootSourceId: waitingSource },
        {
          debounce: immediateDebounce
        }
      );
      const job = await finished(await runDue(w, "topic-gate", "model"));
      expect(job.result).toMatchObject({ status: "applied", redecided: 1, calls: 0 });
      expect(w.ranks).toHaveLength(0);
      expect((await placements(waitingNote))[0]).toMatchObject({
        topicId: w.topics.B,
        decidedBy: "auto",
        needsGate: false
      });
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("applies a decision after the tree moved meanwhile, when its candidates are the same", async () => {
    const w = await world();
    try {
      const note = await ambiguousNote(w);
      const repository = createTopicTreeRepository(pool);
      w.duringRank.run = async () => {
        // A person renames Oceans while the ranker runs: a new generation, the same leaves.
        const tree = (await repository.tree(w.treeId))!;
        const result = await repository.applyChangeSet({
          treeId: w.treeId,
          expectedGeneration: tree.generation,
          origin: "human",
          titleKey: "topics.changeSets.rename",
          events: [
            {
              op: "topic.describe",
              topicId: w.topics.B,
              before: { description: null },
              after: { description: "Seas, tides and currents." }
            }
          ]
        });
        expect(result.kind).toBe("applied");
      };
      const job = await finished(await runDue(w, "topic-gate", "model"));
      expect(job.result).toMatchObject({ status: "applied", accepted: 2, deferred: 0 });
      expect((await placements(note.id))[0]).toMatchObject({
        topicId: w.topics.A1,
        decidedBy: "gate"
      });
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("leaves a decision whose candidates changed meanwhile for the next gate job", async () => {
    const w = await world();
    try {
      const note = await ambiguousNote(w);
      const repository = createTopicTreeRepository(pool);
      let relocated = false;
      w.duringRank.run = async () => {
        // A person puts Retrieval practice under Oceans: Oceans is no longer a leaf, so the
        // ambiguous items' candidate leaves are not the ones the ranker is scoring.
        const tree = (await repository.tree(w.treeId))!;
        const current = await pool.query<{ position: number }>(
          "select position from topics where id = $1",
          [w.topics.A2]
        );
        const result = await repository.applyChangeSet({
          treeId: w.treeId,
          expectedGeneration: tree.generation,
          origin: "human",
          titleKey: "topics.changeSets.move",
          events: [
            {
              op: "topic.move",
              topicId: w.topics.A2,
              before: { parentId: w.topics.A, position: current.rows[0]!.position },
              after: { parentId: w.topics.B, position: 0 }
            }
          ]
        });
        expect(result.kind).toBe("applied");
        relocated = true;
      };
      const job = await finished(await runDue(w, "topic-gate", "model"));
      expect(relocated).toBe(true);
      expect(job.result).toMatchObject({ accepted: 0, none: 0, deferred: 2, continues: true });
      // Nothing changed: both still wait, and another gate job is queued for their scope.
      expect(await placements(note.id)).toMatchObject([{ topicId: w.topics.A, needsGate: true }]);
      expect(await queued("topic-gate")).toBe(1);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("splits a leaf the gate filled past its hard maximum before the light lane drains (I4)", async () => {
    // Sleep and Retrieval practice hold leaf.max - 1 notes each: inside their band.
    const before = config.leaf.max - 1;
    const w = await world({
      seed: async (seed) => {
        await fillTopic(seed, "Sleep", 0, before - 4);
        await fillTopic(seed, "Retrieval practice", 1, before - 4);
      }
    });
    try {
      // An article whose notes sit between the two leaves arrives: PLACE parks every note and the
      // source at Memory with needs_gate, so its change-set names Memory, not Sleep.
      const arriving = config.leaf.hardMax - before;
      const source = await insertSource("Article Sleep before exams");
      const ids: string[] = [];
      for (let index = 0; index < arriving; index += 1) {
        const title = `Sleep before an exam ${index}`;
        const note = await insertNote(
          source,
          index,
          { title, idea: `${title} helps recall.`, body: `${title}. A longer passage.` },
          vectorOn([0, 1], 700 + index, 0.02)
        );
        ids.push(note.id);
      }
      await w.services.triggers.notesChanged(ids);
      const place = await finished(await runDue(w, "topic-place", "compute"));
      expect(place.result).toMatchObject({ status: "applied", needsGate: arriving + 1 });
      // Its follow-ups run beside the gate (as on ENV-C): REBALANCE checks what PLACE touched and
      // finds nothing to repair; the first audit finds the tree in its bands.
      const settled = await drainCompute(w);
      expect(resultsOf(settled, "topic-rebalance")).toEqual([
        expect.objectContaining({ status: "no_change", unresolvedHard: 0 })
      ]);
      expect(await primaryCount(w.topics.A1)).toBe(before);

      // The ranker puts every waiting item in Sleep: one gate change-set takes it past the hard
      // maximum (leaf size counts the notes and the root source).
      const gate = await finished(await runDue(w, "topic-gate", "model"));
      expect(gate.result).toMatchObject({ status: "applied", accepted: arriving + 1 });
      expect(await primaryCount(w.topics.A1)).toBe(config.leaf.hardMax + 1);

      // The light lane drains: REBALANCE splits Sleep, and no hard violation is left (E1).
      const drained = await drainCompute(w);
      expect(resultsOf(drained, "topic-rebalance")).toContainEqual(
        expect.objectContaining({ status: "applied", unresolvedHard: 0 })
      );
      const split = await pool.query<{ summary: { operations: Array<Record<string, unknown>> } }>(
        `select summary from topic_change_sets
          where tree_id = $1 and origin = 'rebalance' and status = 'applied'`,
        [w.treeId]
      );
      expect(split.rows.flatMap((row) => row.summary.operations)).toContainEqual(
        expect.objectContaining({
          kind: "leaf-split",
          trigger: "hard",
          condition: "leaf-above-hard-max",
          topicId: w.topics.A1
        })
      );
      expect(await primaryCount(w.topics.A1)).toBeLessThanOrEqual(config.leaf.hardMax);
      expect(await storedHardViolations(w)).toBe(0);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("lets REBALANCE repair a leaf above its hard maximum that no change-set named", async () => {
    // A tree stored with Sleep already past the hard maximum (a mark lost to a failed run, a
    // restart or a writer that asks for no REBALANCE): what PLACE touches next is elsewhere.
    const w = await world({
      seed: async (seed) => {
        await fillTopic(seed, "Sleep", 0, config.leaf.hardMax + 2 - 4);
      }
    });
    try {
      expect(await primaryCount(w.topics.A1)).toBe(config.leaf.hardMax + 2);
      const source = await insertSource("Article Gulf Stream");
      const note = await insertNote(
        source,
        0,
        { title: "Gulf Stream", idea: "A warm current.", body: "The Gulf Stream. A passage." },
        vectorOn([2], 4_343)
      );
      await w.services.triggers.notesChanged([note.id]);
      await runDue(w, "topic-place", "compute");
      expect((await placements(note.id))[0]).toMatchObject({ topicId: w.topics.B });
      // Only the REBALANCE that PLACE asked for runs (the audit, which would flag Sleep, is not
      // due): it still sees the hard violation in the cache and splits Sleep.
      const rebalance = await finished(await runDue(w, "topic-rebalance", "compute"));
      expect(rebalance.result).toMatchObject({ status: "applied", unresolvedHard: 0 });
      expect(await primaryCount(w.topics.A1)).toBeLessThanOrEqual(config.leaf.hardMax);
      expect(await storedHardViolations(w)).toBe(0);
    } finally {
      await w.dispose();
    }
  }, 60_000);
});
