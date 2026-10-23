import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  closePgPool,
  createGardenerFindingRepository,
  createJobRepository,
  createLibraryResetRepository,
  createPgPool,
  createTopicNamingRepository,
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
import { auditLintConfigWith, formatObjectAddress } from "@app/domain";
import {
  checkTopicClusteringResult,
  createTopicTreeEditor,
  gaussianClusters,
  getTopic,
  isLive,
  placementsOf,
  topicLabelText,
  topicTreeConfigWith,
  TopicClusteringRequestSchema
} from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clusterTopics } from "../../workers/topic-clustering.worker.js";
import { JobSupervisor } from "../job-supervisor.js";
import { atomicNoteEmbeddingHash } from "../note-embedding-text.js";
import { createTopicTreeServices } from "./index.js";
import type { TopicTreeServices } from "./index.js";
import { auditCursorsSettingKey } from "./topic-audit-lints.js";
import { TopicStructureJobs } from "./topic-build.js";
import type { ClusterTopics } from "./topic-build.js";
import { loadTopicTreeCache } from "./topic-cache.js";
import { topicJobTypes } from "./topic-jobs.js";
import { topicLabelHash } from "./topic-labels.js";
import { createStoredVectorSpaceResolver } from "./topic-space.js";
import type { SpaceResolution } from "./topic-space.js";
import { TopicTriggers, immediateDebounce } from "./topic-triggers.js";

/**
 * AUDIT's extensions (F4 T85, D19) on the real schema and a throwaway PostgreSQL sidecar: duplicate
 * notes by vector and by title with the owner's dismissal kept, broken `memora://` addresses, vectors
 * missing or older than their note, redirect chains compressed through the engine with an exact undo,
 * names far from their topic's theme handed to the naming job, and the rolling re-placement handed to
 * REBALANCE.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const dim = 256;
const space: TopicLoadSpace = {
  spaceKey: "topic-audit-test-space",
  provider: "test",
  model: "synthetic-256",
  runtime: "none",
  dimensions: dim
};
const baseConfig: TopicTreeConfig = topicTreeConfigWith({
  fanOut: { min: 2, max: 4, targetMin: 2, targetMax: 3, hardMax: 6, rootTarget: 3 },
  leaf: { min: 2, max: 6, target: 4, hardMax: 12, minForTargetFanOut: 2 },
  depth: { target: 3, cap: 5 },
  areas: { min: 2, max: 4, target: 3, minLevel2Topics: 4 },
  bootstrap: { singleTopicMaxItems: 10 },
  repair: { mergeMaxSize: 10, directItemsSplitAt: 4 },
  jobs: { debounceMs: 3_600_000, debounceCapMs: 7_200_000 }
});
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

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

/** The vector of fixture row `row` with a small deterministic perturbation, normalized (cosine > 0.99). */
function nearby(row: number): Float32Array {
  const vector = vectorOf(row);
  vector[(row + 7) % dim] = (vector[(row + 7) % dim] as number) + 0.08;
  let norm = 0;
  for (const value of vector) norm += value * value;
  return vector.map((value) => value / Math.sqrt(norm));
}

const clusterInProcess: ClusterTopics = async (request) => {
  const parsed = TopicClusteringRequestSchema.parse(request);
  const result = clusterTopics(parsed);
  checkTopicClusteringResult(result, parsed);
  return result;
};

/** The parts of a `topic-audit` job result these tests read. */
type Summary = Record<string, number | string | boolean>;
interface AuditResult {
  flaggedTopics: number;
  lints: { duplicates: Summary; brokenLinks: Summary; staleEmbeddings: Summary };
  redirects: Record<string, number>;
  themeDrift: Record<string, number>;
  replacement: Record<string, number | string>;
}

describe.skipIf(!sidecarAvailable)("AUDIT's extensions on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let connection: PostgresSidecarConnection;
  let pool: PgPool;
  let services: TopicTreeServices;
  let supervisor: JobSupervisor;
  let spaceOverride: SpaceResolution | null = null;

  async function insertSource(title: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "insert into source_items (id, type, title, content_hash) values ($1, 'Book', $2, $3)",
      [id, title, `source-${title}`]
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [randomUUID(), id, title, `document-${id}`]
    );
    return id;
  }

  /** A note with a vector of the space whose hash is the hash of its embedding text. */
  async function insertNote(
    sourceId: string,
    entry: { title: string; vector: ArrayLike<number>; body?: string }
  ): Promise<string> {
    const id = randomUUID();
    const chunk = randomUUID();
    const body = entry.body ?? "Body";
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       select $1, d.id, $2, (select count(*) from chunks c where c.source_item_id = $2), 'Passage', $3
         from documents d where d.source_item_id = $2`,
      [chunk, sourceId, `chunk-${chunk}`]
    );
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, ownership,
         created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key)
       values ($1, $2, $3, 'Idea', 'source', $4, $5, 'test', 'test', 'test', 'test', $6)`,
      [id, entry.title, body, sourceId, chunk, `key-${id}`]
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
        atomicNoteEmbeddingHash({ title: entry.title, ideaStatement: "Idea", bodyMarkdown: body }),
        `[${Array.from(entry.vector).join(",")}]`
      ]
    );
    return id;
  }

  async function count(sql: string, values: unknown[] = []): Promise<number> {
    const result = await pool.query<{ count: string }>(sql, values);
    return Number(result.rows[0]?.count ?? 0);
  }

  const activeTree = async () => (await createTopicTreeRepository(pool).activeTree())!;

  async function drain(): Promise<JobRecord[]> {
    const done: JobRecord[] = [];
    for (let job = await supervisor.runLightOnce("compute"); job;) {
      done.push(job);
      job = await supervisor.runLightOnce("compute");
    }
    return done;
  }

  async function runQueued(type: string): Promise<JobRecord[]> {
    await pool.query("update jobs set run_after = now() where type = $1 and status = 'queued'", [
      type
    ]);
    return drain();
  }

  /** Asks for an audit now and runs it (and whatever else is due). */
  async function audit(): Promise<AuditResult> {
    const tree = await activeTree();
    await services.triggers.request(topicJobTypes.audit, tree.id, null, {
      debounce: immediateDebounce
    });
    const jobs = await runQueued(topicJobTypes.audit);
    const done = jobs.filter((job) => job.type === topicJobTypes.audit).at(-1);
    if (!done?.result) throw new Error(`no audit result: ${JSON.stringify(done?.error)}`);
    return done.result as unknown as AuditResult;
  }

  /** A second set of structure jobs over the same tree, with its own lint numbers and wiring. */
  function structureJobs(
    options: {
      aiMode?: "full" | "deterministic";
      lints?: ReturnType<typeof auditLintConfigWith>;
      requestThemeRenames?: (treeId: string, topicIds: readonly string[]) => Promise<void>;
    } = {}
  ) {
    return new TopicStructureJobs({
      getPool: () => pool,
      service: services.service,
      triggers: new TopicTriggers({
        getPool: () => pool,
        isRegistered: () => true,
        debounce: () => ({ delayMs: 3_600_000, maxDelayMs: 7_200_000 })
      }),
      changes: services.changes,
      spaceResolver: { resolve: async () => spaceOverride ?? stored.resolve() },
      aiMode: options.aiMode ?? "full",
      isRegistered: () => true,
      effectiveConfig: () => baseConfig,
      clusterTopics: clusterInProcess,
      ...(options.lints ? { lints: options.lints } : {}),
      ...(options.requestThemeRenames ? { requestThemeRenames: options.requestThemeRenames } : {}),
      logger: quiet
    });
  }

  async function auditJob(structure: TopicStructureJobs): Promise<AuditResult> {
    const tree = await activeTree();
    const job = await createJobRepository(pool).create({
      type: topicJobTypes.audit,
      lane: "light",
      payload: { treeId: tree.id }
    });
    const result = await structure.runAudit(job);
    await pool.query("update jobs set status = 'succeeded' where id = $1", [job.id]);
    return result as unknown as AuditResult;
  }

  let stored: ReturnType<typeof createStoredVectorSpaceResolver>;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-audit-"));
    for (let attempt = 1; ; attempt += 1) {
      const candidate = new PostgresSidecarManager({
        binDir: sidecarPaths.binDir,
        dataDir: join(workDir, `database-${attempt}`),
        database: "memora_topic_audit_test",
        user: "memora_topic_audit_test",
        password: `topic-audit-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await candidate.start();
        manager = candidate;
        break;
      } catch (error) {
        await candidate.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    stored = createStoredVectorSpaceResolver(() => pool);
    services = createTopicTreeServices({
      getPool: () => pool,
      spaceResolver: { resolve: async () => spaceOverride ?? stored.resolve() },
      env: {},
      isPackaged: false,
      logger: quiet,
      newTreeConfig: () => baseConfig,
      clusterTopics: clusterInProcess,
      budgetStore: { read: async () => null, write: async () => undefined }
    });
    supervisor = new JobSupervisor({
      getPool: () => pool,
      lightJobs: services.jobs,
      pollIntervalMs: 20,
      logger: quiet
    });
    // Six subjects of 18 notes each, built into a tree.
    await createLibraryResetRepository(pool).reset();
    services.service.invalidate();
    for (let group = 0; group < 6; group += 1) {
      const source = await insertSource(`Subject ${group}`);
      for (let index = 0; index < pointsPerGroup; index += 1) {
        const row = group * pointsPerGroup + index;
        await insertNote(source, { title: `Fixture note ${row}`, vector: vectorOf(row) });
      }
    }
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
    await drain();
    expect(
      await count("select count(*) from topics where role = 'topic' and retired_at is null")
    ).toBeGreaterThan(3);
  }, 180_000);

  afterAll(async () => {
    await supervisor?.stop().catch(() => undefined);
    services?.dispose();
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("finds duplicate notes by vector and by title, once, and keeps the owner's dismissal", async () => {
    const source = await insertSource("Duplicates");
    const original = await insertNote(source, { title: "Retrieval practice", vector: vectorOf(0) });
    const copy = await insertNote(source, { title: "Practising retrieval", vector: nearby(0) });
    const twinOne = await insertNote(source, { title: "Spaced  Repetition", vector: vectorOf(40) });
    const twinTwo = await insertNote(source, { title: "spaced repetition", vector: vectorOf(80) });
    const pairKey = (a: string, b: string) => `dup:${[a, b].sort().join(":")}`;

    const first = await audit();
    expect(first.lints.duplicates).toMatchObject({ state: "done", exhausted: true });
    expect(first.lints.duplicates.pairs).toBeGreaterThanOrEqual(2);
    const findings = createGardenerFindingRepository(pool);
    const rows = (await findings.list({ kinds: ["duplicate"], limit: 50 })).findings;
    const byKey = new Map(rows.map((row) => [row.fingerprint, row]));
    expect(byKey.get(pairKey(original, copy))).toMatchObject({
      params: { reason: "vector" },
      risk: "low",
      status: "open",
      objectRefs: [original, copy].sort().map((id) => formatObjectAddress({ kind: "note", id }))
    });
    expect(byKey.get(pairKey(twinOne, twinTwo))).toMatchObject({ params: { reason: "title" } });

    // Nothing new on the next audit: the scan resumes after the notes it has seen.
    const second = await audit();
    expect(second.lints.duplicates).toMatchObject({ examined: 0, created: 0, exhausted: true });

    // A dismissal persists when the finding is found again (the scan starts over).
    const twins = byKey.get(pairKey(twinOne, twinTwo))!;
    expect(await findings.dismiss(twins.id)).toMatchObject({ status: "dismissed" });
    await pool.query("delete from settings where key = $1", [auditCursorsSettingKey]);
    const third = await audit();
    expect(third.lints.duplicates.dismissed).toBeGreaterThanOrEqual(1);
    expect((await findings.get(twins.id))?.status).toBe("dismissed");

    // A pair that is no longer alike is resolved by the next check.
    await pool.query(
      "update embeddings_256 set embedding = $2::vector where target_id = $1 and target_type = 'atomic_note'",
      [copy, `[${Array.from(vectorOf(100)).join(",")}]`]
    );
    const fourth = await audit();
    expect(fourth.lints.duplicates.resolved).toBeGreaterThanOrEqual(1);
    expect((await findings.get(byKey.get(pairKey(original, copy))!.id))?.status).toBe("resolved");
  }, 120_000);

  it("finds the addresses that name nothing and resolves them when they are gone", async () => {
    const gone = randomUUID();
    await pool.query(
      `insert into view_history (kind, object_id, address, title) values ('note', $1, $2, 'A deleted note')`,
      [gone, `memora://note/${gone}`]
    );
    const found = await audit();
    expect(found.lints.brokenLinks).toMatchObject({ state: "done", broken: 1, created: 1 });
    const address = formatObjectAddress({ kind: "note", id: gone });
    const findings = createGardenerFindingRepository(pool);
    expect((await findings.list({ kinds: ["broken_link"] })).findings).toMatchObject([
      {
        fingerprint: `link:${address}`,
        objectRefs: [address],
        params: { kind: "note", reason: "missing" }
      }
    ]);
    await pool.query("delete from view_history");
    const resolved = await audit();
    expect(resolved.lints.brokenLinks).toMatchObject({ broken: 0, resolved: 1 });
    expect((await findings.list({ kinds: ["broken_link"] })).findings).toEqual([]);
  }, 120_000);

  it("queues one re-embedding for a note edited after its vector or left without one", async () => {
    const source = await insertSource("Stale");
    const edited = await insertNote(source, { title: "Edited later", vector: vectorOf(10) });
    const bare = await insertNote(source, { title: "No vector", vector: vectorOf(20) });
    await audit();
    await pool.query("delete from jobs where type = 'note-embedding'");
    await pool.query(
      "update atomic_notes set body_markdown = 'A body edited by hand', updated_at = now() + interval '1 hour' where id = $1",
      [edited]
    );
    await pool.query(
      "delete from embeddings_256 where target_type = 'atomic_note' and target_id = $1",
      [bare]
    );
    const result = await audit();
    expect(result.lints.staleEmbeddings).toMatchObject({
      state: "done",
      missing: 1,
      content: 1,
      queued: 2
    });
    const tree = await activeTree();
    const queued = await pool.query<{ id: string; spaceKey: string | null }>(
      `select payload->>'atomicNoteId' as id, payload->>'spaceKey' as "spaceKey"
         from jobs where type = 'note-embedding' and status = 'queued' order by 1`
    );
    expect(queued.rows).toEqual(
      [edited, bare].sort().map((id) => ({ id, spaceKey: tree.spaceKey }))
    );
    // Queued jobs are not queued again.
    const again = await audit();
    expect(again.lints.staleEmbeddings).toMatchObject({ queued: 0 });
    expect(
      await count("select count(*) from jobs where type = 'note-embedding' and status = 'queued'")
    ).toBe(2);
    // A note whose text the vector still matches is left alone, however it was touched since.
    const touched = await insertNote(source, { title: "Touched only", vector: vectorOf(30) });
    await pool.query(
      "update atomic_notes set updated_at = now() + interval '2 hours' where id = $1",
      [touched]
    );
    const quiet2 = await audit();
    expect(quiet2.lints.staleEmbeddings).toMatchObject({ content: 0, queued: 0 });
  }, 120_000);

  it("queues no re-embedding in a deterministic run or while the embedding space moves", async () => {
    const source = await insertSource("Stale off");
    const bare = await insertNote(source, { title: "Bare again", vector: vectorOf(50) });
    await pool.query(
      "delete from embeddings_256 where target_type = 'atomic_note' and target_id = $1",
      [bare]
    );
    await pool.query("delete from jobs where type = 'note-embedding'");
    const deterministic = await auditJob(structureJobs({ aiMode: "deterministic" }));
    expect(deterministic.lints.staleEmbeddings).toEqual({ state: "off", reason: "deterministic" });
    spaceOverride = { kind: "unembedded", spaceKey: "another-space", local: true };
    try {
      const moving = await auditJob(structureJobs());
      expect(moving.lints.staleEmbeddings).toEqual({ state: "off", reason: "space_changed" });
    } finally {
      spaceOverride = null;
    }
    expect(await count("select count(*) from jobs where type = 'note-embedding'")).toBe(0);
  }, 120_000);

  it("compresses redirect chains through the engine as one undoable change-set", async () => {
    const tree = await activeTree();
    const repository = createTopicTreeRepository(pool);
    const cache = (await loadTopicTreeCache(pool, tree.id))!;
    const [x, y, z] = [randomUUID(), randomUUID(), randomUUID()] as [string, string, string];
    // Merges that left x -> y -> z (z live): three empty topics, two retired into the next.
    const editor = createTopicTreeEditor(cache.state);
    for (const id of [x, y, z]) editor.createTopic(id, cache.state.rootId);
    editor.retireTopic(y, z, "2026-10-20T12:00:00.000Z");
    editor.retireTopic(x, y, "2026-10-20T12:00:00.000Z");
    const merged = await repository.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      origin: "rebalance",
      titleKey: "topics.changeSets.rebalance",
      events: editor.events
    });
    expect(merged.kind).toBe("applied");
    services.service.invalidate();

    const compressed = await audit();
    expect(compressed.redirects).toMatchObject({ chains: 1, compressed: 1, unresolved: 0 });
    const redirectOf = async (id: string) =>
      (
        await pool.query<{ redirect_to: string }>("select redirect_to from topics where id = $1", [
          id
        ])
      ).rows[0]?.redirect_to;
    expect(await redirectOf(x)).toBe(z);
    expect(await redirectOf(y)).toBe(z);
    const change = await pool.query<{
      id: string;
      title_key: string;
      title_params: unknown;
      risk: string;
      status: string;
    }>(
      `select id, title_key, title_params, risk, status from topic_change_sets
        where tree_id = $1 and origin = 'audit' order by generation desc limit 1`,
      [tree.id]
    );
    expect(change.rows[0]).toMatchObject({
      title_key: "topics.changeSets.redirects",
      title_params: { topics: 1 },
      risk: "low",
      status: "applied"
    });
    // The change-set reads like any other, and nothing is left to compress.
    expect((await audit()).redirects).toMatchObject({ chains: 0, compressed: 0 });

    const undone = await services.service.undo({ changeSetId: change.rows[0]!.id });
    expect(undone.status).toBe("undone");
    expect(await redirectOf(x)).toBe(y);
    expect(await redirectOf(y)).toBe(z);
    // And it compresses again: the audit is idempotent over the state it finds.
    expect((await audit()).redirects).toMatchObject({ chains: 1, compressed: 1 });
    expect(await redirectOf(x)).toBe(z);
  }, 120_000);

  it("asks for a new name for the topics named far from their members' theme, and never a human one", async () => {
    const tree = await activeTree();
    const repository = createTopicTreeRepository(pool);
    const cache = (await loadTopicTreeCache(pool, tree.id))!;
    const leaves = [...cache.state.topics.values()]
      .filter((node) => isLive(node) && node.children.length === 0 && node.parentId !== null)
      .filter((node) => node.stats.n >= 5)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(leaves.length).toBeGreaterThanOrEqual(2);
    const [byModel, byHand] = leaves as [(typeof leaves)[number], (typeof leaves)[number]];
    const editor = createTopicTreeEditor(cache.state);
    for (const [node, source] of [
      [byModel, "llm"],
      [byHand, "human"]
    ] as const) {
      editor.renameTopic(node.id, {
        title: `Theme ${source}`,
        nameState: "named",
        nameSource: source,
        nameLanguage: "en"
      });
    }
    const renamed = await repository.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      origin: "naming",
      titleKey: "topics.changeSets.naming",
      events: editor.events
    });
    expect(renamed.kind).toBe("applied");
    services.service.invalidate();
    // Both labels point away from their topic's centroid, as a name of another theme would.
    const fresh = (await loadTopicTreeCache(pool, tree.id))!;
    for (const id of [byModel.id, byHand.id]) {
      const node = getTopic(fresh.state, id);
      const text = topicLabelText(node) as string;
      await createTopicNamingRepository(pool).upsertTopicLabel({
        topicId: id,
        space: { ...space, spaceKey: fresh.tree.spaceKey, model: fresh.tree.embeddingModel },
        contentHash: topicLabelHash(text),
        embedding: Array.from(node.stats.centroid, (value) => -value)
      });
    }
    services.service.invalidate();

    const requests: { treeId: string; topicIds: readonly string[] }[] = [];
    const structure = structureJobs({
      requestThemeRenames: async (treeId, topicIds) => {
        requests.push({ treeId, topicIds });
      }
    });
    const result = await auditJob(structure);
    expect(result.themeDrift).toMatchObject({ measured: 1, drifted: 1 });
    expect(requests).toEqual([{ treeId: tree.id, topicIds: [byModel.id] }]);
    // The names stay as they are: only the naming job may change one.
    const names = await pool.query<{ id: string; title: string }>(
      "select id, title from topics where id = any($1::uuid[])",
      [[byModel.id, byHand.id]]
    );
    expect(new Map(names.rows.map((row) => [row.id, row.title]))).toEqual(
      new Map([
        [byModel.id, "Theme llm"],
        [byHand.id, "Theme human"]
      ])
    );
  }, 120_000);

  it("hands the notes the rolling re-placement would move to REBALANCE, once a day", async () => {
    const tree = await activeTree();
    const repository = createTopicTreeRepository(pool);
    const cache = (await loadTopicTreeCache(pool, tree.id))!;
    // A note put into a leaf of another branch, as a stale placement would be.
    const note = [...cache.state.items.keys()].find((key) => {
      const placement = placementsOf(cache.state, key)[0];
      return (
        key.startsWith("note:") &&
        placement?.management === "ai" &&
        placement.topicId !== cache.state.rootId
      );
    })!;
    const from = placementsOf(cache.state, note)[0]!.topicId;
    // The fullest leaf of another branch: its centroid is the theme of several notes, not of one.
    const wrong = [...cache.state.topics.values()]
      .filter(
        (node) =>
          isLive(node) &&
          node.children.length === 0 &&
          node.parentId !== null &&
          node.parentId !== getTopic(cache.state, from).parentId &&
          node.id !== from
      )
      .sort((x, y) => y.stats.n - x.stats.n || (x.id < y.id ? -1 : 1))[0]!;
    expect(wrong.stats.n).toBeGreaterThanOrEqual(4);
    const editor = createTopicTreeEditor(cache.state);
    editor.updatePlacement(note, 0, { topicId: wrong.id });
    const moved = await repository.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      origin: "rebalance",
      titleKey: "topics.changeSets.rebalance",
      events: editor.events
    });
    expect(moved.kind).toBe("applied");
    services.service.invalidate();

    const structure = structureJobs({
      lints: auditLintConfigWith({
        replacement: { share: 1, perRun: 10_000, candidates: 10_000, minGain: 0.1 }
      })
    });
    const audited = await auditJob(structure);
    expect(audited.replacement).toMatchObject({ state: "decided" });
    expect(audited.replacement.candidates).toBeGreaterThanOrEqual(1);
    expect(audited.flaggedTopics).toBeGreaterThanOrEqual(1);
    // Once a day: the same day's next audit does not decide again.
    expect((await auditJob(structure)).replacement).toEqual({ state: "done_today" });

    // REBALANCE tries the candidates against its acceptance rule: the numbers decide whether it
    // moves any, and its change-set says which operations it applied.
    const job = await createJobRepository(pool).create({
      type: topicJobTypes.rebalance,
      lane: "light",
      payload: { treeId: tree.id }
    });
    const rebalanced = await structure.runRebalance(job, new AbortController().signal);
    await pool.query("update jobs set status = 'succeeded' where id = $1", [job.id]);
    expect(Number(rebalanced.misplacedLeaves)).toBeGreaterThanOrEqual(1);
    const applied = await pool.query<{
      summary: { operations?: { kind: string; condition: string }[] };
    }>("select summary from topic_change_sets where tree_id = $1 and id = $2", [
      tree.id,
      rebalanced.changeSetId ?? randomUUID()
    ]);
    const replaced = (applied.rows[0]?.summary.operations ?? []).filter(
      (operation) => operation.condition === "misplaced"
    );
    expect(replaced.length > 0).toBe(Number(rebalanced.misplacedMoved) > 0);
    for (const operation of replaced) expect(operation.kind).toBe("replace");
  }, 120_000);

  it("is reproduced by the read-only dry run of the lints (npm run topics:lints), writing nothing", async () => {
    const tree = await activeTree();
    const before = {
      findings: await count("select count(*) from gardener_findings"),
      cursors: await count("select count(*) from settings where key = $1", [
        auditCursorsSettingKey
      ]),
      jobs: await count("select count(*) from jobs"),
      generation: tree.generation
    };
    const out = join(workDir, "lints.json");
    await promisify(execFile)(
      join(workspaceRoot, "node_modules/.bin/tsx"),
      [
        "scripts/topics/audit-lints.ts",
        "--db",
        connection.connectionString,
        "--json",
        out,
        "--out",
        join(workDir, "lints.md")
      ],
      { cwd: workspaceRoot, timeout: 120_000 }
    );
    const report = JSON.parse(await readFile(out, "utf8"));
    expect(report.tree).toMatchObject({ id: tree.id, spaceKey: tree.spaceKey });
    expect(report.duplicates.examined).toBeGreaterThan(100);
    expect(report.duplicates.pairs).toBeGreaterThanOrEqual(1);
    expect(report.replacement.sampled).toBe(report.replacement.eligible);
    expect(report.themeDrift.measured).toBeGreaterThanOrEqual(1);
    expect(report.redirects.retired).toBeGreaterThanOrEqual(1);
    expect(await readFile(join(workDir, "lints.md"), "utf8")).toContain("## Duplicate notes");
    // Nothing was recorded, queued or changed.
    expect({
      findings: await count("select count(*) from gardener_findings"),
      cursors: await count("select count(*) from settings where key = $1", [
        auditCursorsSettingKey
      ]),
      jobs: await count("select count(*) from jobs"),
      generation: (await activeTree()).generation
    }).toEqual(before);
  }, 180_000);
});
