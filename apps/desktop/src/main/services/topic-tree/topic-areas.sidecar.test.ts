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
  topicStatsWrites,
  topicTreeRecordsDump,
  type JobRecord,
  type PgPool,
  type PostgresSidecarConnection,
  type TopicLoadSpace
} from "@app/db";
import {
  createRng,
  createTopicTreeEditor,
  createTopicTreeState,
  getTopic,
  itemKey,
  liveTopicIds,
  placementRecord,
  recomputeSubtree,
  registerItem,
  topicRecordOf,
  topicTreeConfigWith
} from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JobSupervisor } from "../job-supervisor.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices, TopicTreeServicesOptions } from "./index.js";
import { ItemVectorStore, loadTopicTreeCache } from "./topic-cache.js";
import { immediateDebounce } from "./topic-triggers.js";

/**
 * The Areas job (T24, D12) against the real schema on a throwaway PostgreSQL sidecar, with a fake
 * model that reads the grouping prompt: the bootstrap applies on its own and undoes exactly, later
 * groupings wait for review, a pinned Area stays as it is, invalid and worse groupings change
 * nothing, and no call is made in a deterministic golden run, at the daily cap or without a route.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const space: TopicLoadSpace = {
  spaceKey: "topic-areas-test-space",
  provider: "test",
  model: "synthetic-256",
  runtime: "none",
  dimensions: dim
};
const contentLanguage = "pt-BR";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Four subjects of four topics each; the stored Areas mix them (one topic of each per Area). */
const subjects = ["Astronomia", "Botânica", "Cinema brasileiro", "Direito civil"];
const groups = subjects.length;
const leavesPerGroup = 5;
const notesPerLeaf = 4;

function configWith(overrides: Parameters<typeof topicTreeConfigWith>[0] = {}): TopicTreeConfig {
  return topicTreeConfigWith({
    // Only a test runs a job; the jobs other listeners queue stay an hour away.
    jobs: { debounceMs: 3_600_000, debounceCapMs: 7_200_000 },
    areas: { min: 3, target: 4, max: 6, minLevel2Topics: 8 },
    ...overrides
  });
}

interface PromptTopic {
  alias: string;
  titles: string[];
}
interface PromptPinned {
  alias: string;
  title: string;
}

/** The topics and pinned Areas a grouping prompt carries (the JSON lists after their labels). */
function promptOf(input: string): { pinned: PromptPinned[]; topics: PromptTopic[] } {
  const pinnedStart = input.lastIndexOf("Pinned areas:\n") + "Pinned areas:\n".length;
  const topicsLabel = input.lastIndexOf("\nTopics:\n");
  return {
    pinned: JSON.parse(input.slice(pinnedStart, topicsLabel)) as PromptPinned[],
    topics: JSON.parse(input.slice(topicsLabel + "\nTopics:\n".length)) as PromptTopic[]
  };
}

/** The subject a topic's note titles name ("G2 ..."). */
const subjectOf = (topic: PromptTopic): number => Number(/G(\d)/u.exec(topic.titles[0] ?? "")?.[1]);

/** The grouping a careful writer gives: one new Area per subject that has topics to group. */
function trueGrouping(prompt: { topics: PromptTopic[] }, skip = new Set<string>()) {
  return {
    areas: subjects
      .map((title, group) => ({
        new: { title, description: `Notas sobre ${title.toLowerCase()}.` },
        members: prompt.topics
          .filter((topic) => subjectOf(topic) === group && !skip.has(topic.alias))
          .map((topic) => topic.alias)
      }))
      .filter((area) => area.members.length > 0)
  };
}

type Answer = (prompt: { pinned: PromptPinned[]; topics: PromptTopic[] }) => unknown;

describe.skipIf(!sidecarAvailable)("topic Areas on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-areas-"));
    for (let attempt = 1; ; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecarPaths.binDir,
        dataDir: join(workDir, `database-${attempt}`),
        database: "memora_topic_areas_test",
        user: "memora_topic_areas_test",
        password: `topic-areas-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
        break;
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
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

  interface World {
    services: TopicTreeServices;
    supervisor: JobSupervisor;
    treeId: string;
    rootId: string;
    /** The stored Areas, and the level-2 topic of each subject and index. */
    areas: string[];
    leaves: string[][];
    calls: Array<{ input: string; context: Record<string, unknown> }>;
    gate: { current: Promise<void> | null };
    route: { ready: boolean };
    setAnswer(answer: Answer): void;
    dispose(): Promise<void>;
  }

  async function world(
    options: {
      config?: TopicTreeConfig;
      env?: Record<string, string | undefined>;
      budgetCalls?: { calls: number };
      /** The stored Areas already follow the subjects (default: they mix them). */
      layout?: "mixed" | "grouped" | "stray";
    } = {}
  ): Promise<World> {
    await createLibraryResetRepository(pool).reset();
    const config = options.config ?? configWith();
    const calls: World["calls"] = [];
    const gate: World["gate"] = { current: null };
    const route = { ready: true };
    let answer: Answer = (prompt) => trueGrouping(prompt);
    const budget = options.budgetCalls ?? { calls: 0 };
    const fake = {
      runDefaultTask: vi.fn(
        async (task: string, input: string, context: Record<string, unknown> = {}) => {
          if (!route.ready) return null;
          calls.push({ input, context });
          if (gate.current) await gate.current;
          return {
            providerId: "fixture",
            modelId: "fixture-writer",
            runtime: "remote" as const,
            durationMs: 1,
            aiTaskRunId: randomUUID(),
            profileId: randomUUID(),
            outputLanguage: contentLanguage,
            inputTokens: 900,
            outputTokens: 300,
            taskType: task,
            output: answer(promptOf(input))
          };
        }
      ),
      activeEmbeddingSpace: vi.fn(async () => null)
    };
    const services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: { resolve: async () => ({ kind: "ready", space }) },
      env: options.env ?? {},
      isPackaged: false,
      logger: quiet,
      newTreeConfig: () => config,
      budgetStore: {
        read: async () => ({ day: "2026-10-15", calls: budget.calls }),
        write: async (record) => {
          budget.calls = record.calls;
        }
      },
      ai: fake as unknown as NonNullable<TopicTreeServicesOptions["ai"]>,
      getContentLanguage: async () => contentLanguage,
      now: () => new Date("2026-10-15T12:00:00.000Z")
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
    const live = createTopicTreeState({ dim, rootId });
    const editor = createTopicTreeEditor(live, { record: false });
    const store = new ItemVectorStore(dim);
    const rng = createRng(20261015);
    const areas = Array.from({ length: groups }, () => randomUUID());
    // The stored Areas carry provisional names, as naming leaves them before the grouping.
    areas.forEach((area, index) =>
      editor.createTopic(area, rootId, {
        title: `Área ${index + 1}`,
        nameState: "provisional",
        nameSource: "tfidf",
        nameLanguage: contentLanguage
      })
    );
    const leaves: string[][] = [];
    for (let group = 0; group < groups; group += 1) {
      leaves.push([]);
      for (let index = 0; index < leavesPerGroup; index += 1) {
        const leaf = randomUUID();
        leaves[group]!.push(leaf);
        // Mixed: the stored Areas mix the subjects. Grouped: one subject per Area. Stray: grouped,
        // except that the last topic of the first subject sits in the second Area.
        const layout = options.layout ?? "mixed";
        const stray = layout === "stray" && group === 0 && index === leavesPerGroup - 1;
        const area = layout === "mixed" ? (group + index) % groups : stray ? 1 : group;
        editor.createTopic(leaf, areas[area] as string);
        const source = randomUUID();
        await pool.query(
          "insert into source_items (id, type, title, content_hash) values ($1, 'Book', $2, $3)",
          [source, `Livro G${group} L${index}`, sha(`book-${group}-${index}`)]
        );
        const document = randomUUID();
        await pool.query(
          `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
           values ($1, $2, 'Livro', 'seed', $3)`,
          [document, source, sha(`document-${group}-${index}`)]
        );
        for (let n = 0; n < notesPerLeaf; n += 1) {
          const id = randomUUID();
          const chunk = randomUUID();
          await pool.query(
            `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
             values ($1, $2, $3, $4, 'Passage', $5)`,
            [chunk, document, source, n, sha(`chunk-${chunk}`)]
          );
          const title = `G${group} ${subjects[group]} tópico ${index} nota ${n}`;
          await pool.query(
            `insert into atomic_notes (id, title, body_markdown, idea_statement, language, ownership,
               created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
               generation_runtime, generation_prompt_version, generation_key)
             values ($1, $2, 'Body', 'Idea', 'pt-BR', 'source', $3, $4, 'test', 'test', 'test',
               'test', $5)`,
            [id, title, source, chunk, `key-${id}`]
          );
          // A subject axis, a topic axis and noise: subjects are the natural Areas.
          const vector = new Float32Array(dim);
          vector[group] = 1;
          vector[16 + group * leavesPerGroup + index] = 0.7;
          for (let k = 0; k < dim; k += 1)
            vector[k] = (vector[k] as number) + 0.05 * rng.gaussian();
          const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
          for (let k = 0; k < dim; k += 1) vector[k] = (vector[k] as number) / length;
          const hash = sha(`note-${title}`);
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
          const key = itemKey("note", id);
          registerItem(live, {
            key,
            kind: "note",
            contentHash: hash,
            rootSource: itemKey("source", source)
          });
          store.set(key, vector);
          editor.placeItem(
            key,
            placementRecord(leaf, { decidedBy: "build", itemFingerprint: hash })
          );
        }
      }
    }
    recomputeSubtree(live, store);
    const built = await createTopicTreeRepository(pool).bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: liveTopicIds(live)
        .filter((id) => id !== rootId)
        .map((id) => topicRecordOf(getTopic(live, id))),
      placements: [...live.placements].flatMap(([key, list]) =>
        list.map((placement) => ({ item: key, placement }))
      ),
      stats: topicStatsWrites(live, store, liveTopicIds(live)),
      clock: live.clock
    });
    if (built.kind !== "applied") throw new Error(`the tree was not seeded: ${built.kind}`);
    services.service.invalidate();
    services.changes.flush();
    return {
      services,
      supervisor,
      treeId: tree.id,
      rootId,
      areas,
      leaves,
      calls,
      gate,
      route,
      setAnswer: (next) => {
        answer = next;
      },
      dispose: async () => {
        await supervisor.stop().catch(() => undefined);
        services.dispose();
      }
    };
  }

  /** Runs the queued job of a type on its light worker; the other queued jobs stay parked. */
  async function runQueued(
    w: World,
    type: "topic-areas" | "topic-audit" | "topic-rebalance"
  ): Promise<JobRecord> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await pool.query(
        `update jobs set run_after = case when type = $1 then now()
           else now() + interval '1 day' end where status = 'queued'`,
        [type]
      );
      const job = await w.supervisor.runLightOnce(type === "topic-areas" ? "model" : "compute");
      if (job?.type === type) {
        return (await createJobRepository(pool).findById(job.id)) as JobRecord;
      }
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`no ${type} job ran`);
  }

  /** Requests the Areas job and runs it on the model worker. */
  async function runAreas(w: World): Promise<JobRecord> {
    await w.services.triggers.request("topic-areas", w.treeId, null, {
      debounce: immediateDebounce
    });
    return runQueued(w, "topic-areas");
  }

  /** The audit, then the REBALANCE it asks for (the mis-parent wiring, D12). */
  async function auditThenRebalance(w: World): Promise<JobRecord> {
    await w.services.triggers.request("topic-audit", w.treeId, null, {
      debounce: immediateDebounce
    });
    const audit = await runQueued(w, "topic-audit");
    expect(Number(audit.result?.reparentCandidates)).toBeGreaterThan(0);
    return runQueued(w, "topic-rebalance");
  }

  async function records(w: World) {
    return createTopicTreeRepository(pool).readTreeRecords(w.treeId);
  }

  async function areaChangeSets(w: World) {
    const result = await pool.query<{ id: string; status: string; title_key: string }>(
      `select id, status, title_key from topic_change_sets
        where tree_id = $1 and origin = 'areas' order by created_at, id`,
      [w.treeId]
    );
    return result.rows;
  }

  it("applies the first grouping on its own, names the Areas and undoes it exactly", async () => {
    const w = await world();
    try {
      const before = topicTreeRecordsDump(await records(w));
      const job = await runAreas(w);
      expect(job.status).toBe("succeeded");
      expect(job.result).toMatchObject({
        status: "applied",
        bootstrap: true,
        units: groups * leavesPerGroup,
        calls: 1,
        inputTokens: 900,
        outputTokens: 300
      });
      const silhouette = job.result?.silhouette as { before: number; after: number };
      expect(silhouette.after).toBeGreaterThan(silhouette.before);
      expect(w.calls).toHaveLength(1);
      expect(w.calls[0]?.context).toMatchObject({
        operation: "topic_areas",
        workloadClass: "write-fast",
        priority: "background",
        stage: "topic_areas"
      });
      // The prompt carries content, not IDs: aliases and note titles only.
      for (const id of [...w.areas, ...w.leaves.flat()]) {
        expect(w.calls[0]?.input).not.toContain(id);
      }

      const stored = await records(w);
      const areas = stored.topics.filter(
        (topic) => topic.parentId === w.rootId && !topic.retiredAt
      );
      expect(areas.map((area) => area.title).sort()).toEqual([...subjects].sort());
      for (const area of areas) {
        expect(area).toMatchObject({
          nameSource: "llm",
          nameState: "named",
          nameLanguage: "pt-BR"
        });
      }
      // Each subject's topics share an Area, and the stored Area IDs survived (Jaccard matching).
      for (const group of w.leaves) {
        const parents = new Set(
          group.map((leaf) => stored.topics.find((topic) => topic.id === leaf)?.parentId)
        );
        expect(parents.size).toBe(1);
        expect(w.areas).toContain([...parents][0]);
      }
      const [changeSet] = await areaChangeSets(w);
      expect(changeSet).toMatchObject({ status: "applied", title_key: "topics.changeSets.areas" });
      // The cache follows the stored tree, and the stored statistics are exact (D7).
      const digest = await w.services.service.runOnTree(w.treeId, async () =>
        w.services.service.cacheDigest()
      );
      expect(digest?.structure).toBe(topicTreeRecordsDump(stored));
      expect((await loadTopicTreeCache(pool, w.treeId))?.staleStoredStats).toEqual([]);

      const undone = await createTopicTreeRepository(pool).undoChangeSet({
        treeId: w.treeId,
        changeSetId: changeSet!.id,
        titleKey: "topics.changeSets.undo"
      });
      expect(undone.kind).toBe("applied");
      expect(topicTreeRecordsDump(await records(w))).toBe(before);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("proposes later groupings for review and asks nothing while one waits", async () => {
    const w = await world();
    try {
      await runAreas(w);
      const [first] = await areaChangeSets(w);
      w.services.service.invalidate();
      await createTopicTreeRepository(pool).undoChangeSet({
        treeId: w.treeId,
        changeSetId: first!.id,
        titleKey: "topics.changeSets.undo"
      });
      w.services.service.invalidate();
      const before = topicTreeRecordsDump(await records(w));
      // The tree had a grouping (undone): the next one waits for the owner.
      const job = await runAreas(w);
      expect(job.result).toMatchObject({ status: "pending_review", bootstrap: false });
      expect(topicTreeRecordsDump(await records(w))).toBe(before);
      expect((await areaChangeSets(w)).map((row) => row.status)).toEqual([
        "undone",
        "pending_review"
      ]);
      const waiting = await runAreas(w);
      expect(waiting.result).toMatchObject({ status: "review_pending" });
      expect(w.calls).toHaveLength(2);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("keeps a pinned Area as it is, and adding to it waits for review", async () => {
    const w = await world({ layout: "grouped" });
    try {
      const repository = createTopicTreeRepository(pool);
      const tree = await repository.tree(w.treeId);
      const pinned = w.areas[0] as string;
      const pin = await repository.applyChangeSet({
        treeId: w.treeId,
        expectedGeneration: tree!.generation,
        origin: "human",
        titleKey: "topics.changeSets.human",
        events: [
          {
            op: "topic.manage",
            topicId: pinned,
            before: { management: "ai" },
            after: { management: "pinned" }
          }
        ]
      });
      expect(pin.kind).toBe("applied");
      w.services.service.invalidate();
      const pinnedBefore = (await records(w)).topics.find((topic) => topic.id === pinned);
      const childrenOf = async (id: string) =>
        (await records(w)).topics
          .filter((topic) => topic.parentId === id && !topic.retiredAt)
          .map((topic) => topic.id)
          .sort();
      const keptBefore = await childrenOf(pinned);
      expect(keptBefore).toHaveLength(leavesPerGroup);

      // The pinned Area keeps its four topics; the other twelve regroup by subject.
      w.setAnswer((prompt) => {
        expect(prompt.pinned.map((area) => area.alias)).toEqual(["A1"]);
        expect(prompt.topics).toHaveLength((groups - 1) * leavesPerGroup);
        return trueGrouping(prompt);
      });
      const job = await runAreas(w);
      expect(job.result).toMatchObject({ status: "applied", protectedTouched: false });
      expect((await records(w)).topics.find((topic) => topic.id === pinned)).toEqual(pinnedBefore);
      expect(await childrenOf(pinned)).toEqual(keptBefore);

      // A forced regroup that adds a topic to the pinned Area becomes a proposal, even though no
      // grouping was reviewed yet on this tree.
      const again = await world({ layout: "stray" });
      try {
        const repo2 = createTopicTreeRepository(pool);
        const tree2 = await repo2.tree(again.treeId);
        await repo2.applyChangeSet({
          treeId: again.treeId,
          expectedGeneration: tree2!.generation,
          origin: "human",
          titleKey: "topics.changeSets.human",
          events: [
            {
              op: "topic.manage",
              topicId: again.areas[0] as string,
              before: { management: "ai" },
              after: { management: "pinned" }
            }
          ]
        });
        again.services.service.invalidate();
        // The stray topic of the pinned Area's subject goes back to it.
        again.setAnswer((prompt) => {
          const joining = prompt.topics.find((topic) => subjectOf(topic) === 0) as PromptTopic;
          const grouping = trueGrouping(prompt, new Set([joining.alias]));
          return {
            areas: [
              { alias: "A1", members: [joining.alias] },
              ...grouping.areas.filter((area) => area.members.length > 0)
            ]
          };
        });
        const forced = await runAreas(again);
        expect(forced.result).toMatchObject({
          status: "pending_review",
          bootstrap: true,
          protectedTouched: true
        });
      } finally {
        await again.dispose();
      }
    } finally {
      await w.dispose();
    }
  }, 90_000);

  it("changes nothing for an invalid answer or a grouping that lowers the silhouette", async () => {
    const w = await world({ layout: "grouped" });
    try {
      const before = topicTreeRecordsDump(await records(w));
      w.setAnswer((prompt) => {
        const grouping = trueGrouping(prompt);
        grouping.areas[0]!.members.pop();
        return grouping;
      });
      const invalid = await runAreas(w);
      expect(invalid.result).toMatchObject({ status: "invalid" });
      expect(invalid.result?.issues).toEqual([expect.objectContaining({ code: "missing-topic" })]);

      // Scrambled: each Area takes one topic of every subject, but not the stored ones.
      w.setAnswer((prompt) => ({
        areas: subjects.map((title, area) => ({
          new: { title, description: "Mistura." },
          members: prompt.topics
            .filter((topic, index) => (subjectOf(topic) + index) % groups === area)
            .map((topic) => topic.alias)
        }))
      }));
      const rejected = await runAreas(w);
      expect(rejected.result).toMatchObject({ status: "rejected", accepted: false });
      expect(rejected.result?.reasons).toContain("silhouette");
      expect(topicTreeRecordsDump(await records(w))).toBe(before);
      expect(await areaChangeSets(w)).toEqual([]);

      // A judged build is not asked about again at startup.
      await w.services.areas!.requestIfNeeded(w.treeId);
      const queued = await pool.query(
        "select 1 from jobs where type = 'topic-areas' and status = 'queued'"
      );
      expect(queued.rowCount).toBe(0);
    } finally {
      await w.dispose();
    }
  }, 60_000);

  it("asks nothing in a deterministic golden run, at the daily cap or without a route", async () => {
    const golden = await world({ env: { MEMORA_GOLDEN_RUN: "1" } });
    try {
      const job = await golden.services.jobs["topic-areas"]!.execute(
        { id: randomUUID(), payload: { treeId: golden.treeId } } as unknown as JobRecord,
        new AbortController().signal
      );
      expect(job).toMatchObject({ status: "skipped", reason: "deterministic" });
      expect(golden.calls).toHaveLength(0);
    } finally {
      await golden.dispose();
    }

    const capped = await world({ budgetCalls: { calls: 300 } });
    try {
      const job = await runAreas(capped);
      expect(job.result).toMatchObject({ status: "cap_reached" });
      expect(capped.calls).toHaveLength(0);
      // The grouping is asked for again at the next start.
      await capped.services.areas!.requestIfNeeded(capped.treeId);
      const queued = await pool.query(
        "select 1 from jobs where type = 'topic-areas' and status = 'queued'"
      );
      expect(queued.rowCount).toBe(1);
    } finally {
      await capped.dispose();
    }

    const routeless = await world();
    try {
      routeless.route.ready = false;
      const job = await runAreas(routeless);
      expect(job.result).toMatchObject({ status: "no_route" });
    } finally {
      await routeless.dispose();
    }
  }, 90_000);

  it("re-parents a mis-parented topic on its own before the first grouping, and proposes it after", async () => {
    const w = await world({ layout: "stray" });
    try {
      const stray = w.leaves[0]![leavesPerGroup - 1] as string;
      const parentOf = async (id: string) =>
        (await records(w)).topics.find((topic) => topic.id === id)?.parentId;
      expect(await parentOf(stray)).toBe(w.areas[1]);
      // No grouping yet: the audit's re-parent goes through REBALANCE and applies.
      const first = await auditThenRebalance(w);
      expect(first.result).toMatchObject({ status: "applied", areaLevelReview: false });
      expect(await parentOf(stray)).toBe(w.areas[0]);

      // The first grouping (the subjects as they now stand) bootstraps the Areas.
      const grouped = await runAreas(w);
      expect(grouped.result).toMatchObject({ status: "applied", bootstrap: true });

      // Another topic strays (the first one cools down after its repair): now the re-parent is
      // an Area-level proposal for the owner.
      const repository = createTopicTreeRepository(pool);
      const tree = await repository.tree(w.treeId);
      const second = w.leaves[0]![0] as string;
      const stored = (await records(w)).topics.find((topic) => topic.id === second);
      const other = (await records(w)).topics.find((topic) => topic.id === w.leaves[1]![0])
        ?.parentId as string;
      const moved = await repository.applyChangeSet({
        treeId: w.treeId,
        expectedGeneration: tree!.generation,
        origin: "rebalance",
        titleKey: "topics.changeSets.rebalance",
        events: [
          {
            op: "topic.move",
            topicId: second,
            before: { parentId: stored!.parentId as string, position: stored!.position },
            after: { parentId: other, position: 99 }
          }
        ]
      });
      expect(moved.kind).toBe("applied");
      w.services.service.invalidate();
      const reviewed = await auditThenRebalance(w);
      expect(reviewed.result).toMatchObject({ areaLevelReview: true, proposed: 1 });
      expect(await parentOf(second)).toBe(other);
      const proposal = await pool.query<{ summary: Record<string, unknown> }>(
        `select summary from topic_change_sets
          where tree_id = $1 and status = 'pending_review' and origin = 'rebalance'`,
        [w.treeId]
      );
      expect(proposal.rows[0]?.summary).toMatchObject({
        reason: "area-level",
        kind: "reparent",
        condition: "mis-parented",
        topicId: second
      });
    } finally {
      await w.dispose();
    }
  }, 90_000);

  it("drops an answer for a tree whose level-2 topics changed while the model answered", async () => {
    const w = await world();
    let release: () => void = () => undefined;
    w.gate.current = new Promise<void>((done) => {
      release = done;
    });
    try {
      const run = runAreas(w);
      while (w.calls.length === 0) await new Promise((done) => setTimeout(done, 10));
      // A person moves a topic to another Area meanwhile.
      const repository = createTopicTreeRepository(pool);
      const tree = await repository.tree(w.treeId);
      const leaf = w.leaves[0]![0] as string;
      const stored = (await records(w)).topics.find((topic) => topic.id === leaf);
      const target = w.areas.find((area) => area !== stored?.parentId) as string;
      const moved = await repository.applyChangeSet({
        treeId: w.treeId,
        expectedGeneration: tree!.generation,
        origin: "human",
        titleKey: "topics.changeSets.human",
        events: [
          {
            op: "topic.move",
            topicId: leaf,
            before: { parentId: stored!.parentId as string, position: stored!.position },
            after: { parentId: target, position: 99 }
          }
        ]
      });
      expect(moved.kind).toBe("applied");
      w.services.service.invalidate();
      release();
      const job = await run;
      expect(job.result).toMatchObject({ status: "stale" });
      expect(await areaChangeSets(w)).toEqual([]);
    } finally {
      release();
      await w.dispose();
    }
  }, 60_000);
});
