import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";

import type { TopicPlacementDecision } from "@app/domain";
import {
  createRng,
  deriveSeed,
  itemKey,
  placementRecord,
  topicRecord
} from "@app/domain/topic-tree";
import type { ItemKey } from "@app/domain/topic-tree";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { createTopicTreeRepository } from "../repositories/topicTreeRepository.js";
import type { TopicStatsWrite } from "../repositories/topicTreeRepository.js";
import {
  createTopicTreeLoadRepository,
  noteVectorStrategyPrefix,
  sourceVectorStrategyPrefix,
  topicLoadDefaults,
  topicLoadSql,
  type TopicPendingReason,
  type TopicLoadSpace,
  type TopicSkeleton,
  type TopicTreeLoadRepository
} from "../repositories/topicTreeLoadRepository.js";

// Synthetic library, answers and latency of the topic load repository on a real PostgreSQL (T12b):
// 18.6k random 1024-d unit vectors in `embeddings_1024`, 1.5k topics with exact statistics and 18.8k
// placements, plus the pending cases PLACE and the sweep must find. The measurements run through a
// connection that cannot write, so the proof also shows the repository only reads.
//
// The structure tables are written through `topicTreeRepository` (D9): `writeTopicStructure` creates
// the tree and fills it with one `bootstrapSnapshot`, exactly as the engine's cold start does. The
// library, the vectors and the root sources are written with plain SQL: they are not topic tables.

export const topicLoadBars = {
  /** The skeleton of 1.5k topics and 18.8k placements, every run including the first. */
  skeletonMs: 300,
  /** 18.6k x 1024 vectors, every run (calibrated, spec T12b). */
  vectorsMs: 5_000
} as const;

const dim = 1024;
const guardedRelations = ["atomic_notes", "embeddings_1024"];
const allReasons: TopicPendingReason[] = [
  "unplaced",
  "needs_vector",
  "stale",
  "needs_gate",
  "needs_split_check"
];

export const proofSpace: TopicLoadSpace = {
  spaceKey: "topic-load-proof-space",
  provider: "proof",
  model: "proof-embed-1024",
  runtime: "proof",
  dimensions: 1024
};

export interface TopicLoadProofOptions {
  /** Current notes (default 18,632, the ENV-C corpus). */
  notes?: number;
  /** Topics, root included (default 1,500). */
  topics?: number;
  /** Root sources (default 300). */
  roots?: number;
  /** Timed runs of the skeleton (default 20) and of the vectors (default 3). */
  skeletonRuns?: number;
  vectorRuns?: number;
  seed?: number;
  log?: (line: string) => void;
}

export interface TimingSummary {
  runs: number;
  firstMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface TopicLoadProofReport {
  counts: { notes: number; topics: number; placements: number; vectors: number };
  skeleton: TimingSummary & { loopP99Ms: number };
  vectors: TimingSummary & {
    loaded: number;
    missing: number;
    /** The same load reading pgvector's text form (`embedding::text`, JSON.parse), for the record. */
    textBaselineMs: number;
    loopP99Ms: number;
    loopMaxMs: number;
  };
  pending: {
    found: number;
    byReason: Record<string, number>;
    pages: number;
    fullScanMs: number;
    pageP95Ms: number;
  };
  plans: Array<{ statement: string; plan: string[] }>;
}

interface PlannedTopic {
  id: string;
  parentId: string | null;
  position: number;
  /** Rows of `Plan.vectors` placed directly on this topic. */
  members: number[];
  children: string[];
}

interface PlacementSeed {
  kind: "note" | "source";
  item: string;
  topic: string;
  decided: TopicPlacementDecision;
  fingerprint: string | null;
  centrality: number;
  gate: boolean;
  split: boolean;
  needsVector: boolean;
}

/** What the seeder planted: the answers the repository must give back. */
interface Plan {
  treeId: string;
  rootIds: string[];
  chapterIds: string[];
  /** Current notes in id order; row `i` of `vectors` belongs to `noteIds[i]`. */
  noteIds: string[];
  /** Notes that are not current: rejected, archived or superseded. */
  excluded: Map<string, { status: string; supersession: string }>;
  noteChapter: Map<string, number>;
  /** Notes with a knowledge owner (no root source). */
  knowledgeNotes: Set<string>;
  /** Current notes without a vector row: waiting for one. */
  noVector: Set<string>;
  vectors: Float32Array;
  topics: PlannedTopic[];
  notePlacements: PlacementSeed[];
  sourcePlacements: PlacementSeed[];
  compositeRoots: string[];
  /** Expected pending reason of every pending note and root source, by item key. */
  pending: Map<string, TopicPendingReason>;
}

const md5 = (value: string): string => createHash("md5").update(value).digest("hex");
const hashOf = md5;

function summarize(samples: number[]): TimingSummary {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    runs: samples.length,
    firstMs: Math.round(samples[0] ?? 0),
    p50Ms: Math.round(at(0.5)),
    p95Ms: Math.round(at(0.95)),
    maxMs: Math.round(sorted[sorted.length - 1] ?? 0)
  };
}

async function timed<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await work();
  return { result, ms: performance.now() - start };
}

const byKey = <T extends readonly [string, unknown]>(a: T, b: T): number => (a[0] < b[0] ? -1 : 1);

// ---------------------------------------------------------------------------
// Planning

/** Random unit vectors from a seeded generator (float32, what pgvector stores). */
function randomUnitVectors(count: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const out = new Float32Array(count * dim);
  for (let row = 0; row < count; row += 1) {
    let sum = 0;
    for (let k = 0; k < dim; k += 1) {
      const value = rng.gaussian();
      out[row * dim + k] = value;
      sum += value * value;
    }
    const scale = 1 / Math.sqrt(sum);
    for (let k = 0; k < dim; k += 1) out[row * dim + k] = (out[row * dim + k] as number) * scale;
  }
  return out;
}

/** The root, 12 Areas, 10 level-2 topics each, then leaves under the level-2 topics; parents first. */
function planTopics(count: number): PlannedTopic[] {
  const topics: PlannedTopic[] = [];
  const add = (parent: PlannedTopic | null): PlannedTopic => {
    const topic: PlannedTopic = {
      id: randomUUID(),
      parentId: parent?.id ?? null,
      position: parent?.children.length ?? 0,
      members: [],
      children: []
    };
    parent?.children.push(topic.id);
    topics.push(topic);
    return topic;
  };
  const root = add(null);
  const areas = Array.from({ length: 12 }, () => add(root));
  const level2 = areas.flatMap((area) => Array.from({ length: 10 }, () => add(area)));
  for (let index = 0; topics.length < count; index += 1) add(level2[index % level2.length] ?? null);
  return topics;
}

/** Notes, roots and the placements that give every kind of pending item. */
function planLibrary(options: {
  notes: number;
  topics: number;
  roots: number;
  seed: number;
}): Plan {
  const { notes, roots, seed } = options;
  const noteIds = Array.from({ length: notes }, () => randomUUID()).sort();
  const excludedIds = Array.from({ length: 150 }, () => randomUUID());
  const excluded = new Map(
    excludedIds.map((id, index) => [
      id,
      index < 50
        ? { status: "rejected", supersession: "current" }
        : index < 100
          ? { status: "archived", supersession: "current" }
          : { status: "active", supersession: "superseded" }
    ])
  );
  const noteChapter = new Map<string, number>();
  [...noteIds, ...excludedIds].forEach((id, index) => noteChapter.set(id, index % roots));
  const plan: Plan = {
    treeId: randomUUID(),
    rootIds: Array.from({ length: roots }, () => randomUUID()),
    chapterIds: Array.from({ length: roots }, () => randomUUID()),
    noteIds,
    excluded,
    noteChapter,
    knowledgeNotes: new Set(noteIds.filter((_, position) => position % 180 === 7)),
    noVector: new Set(),
    vectors: randomUnitVectors(notes, deriveSeed(seed, "note-vectors")),
    topics: planTopics(options.topics),
    notePlacements: [],
    sourcePlacements: [],
    compositeRoots: [],
    pending: new Map()
  };
  planNotePlacements(plan);
  planSourcePlacements(plan);
  return plan;
}

/**
 * Every 150th note is unplaced; the others are placed on a leaf in rotation, and some placements
 * are flagged: a stale fingerprint, a wait for a vector (with and without the vector now stored), the
 * gate and the split check. A pending case is recorded with its expected reason.
 */
function planNotePlacements(plan: Plan) {
  const leaves = plan.topics.filter((topic) => topic.children.length === 0);
  const parentOf = new Map(plan.topics.map((topic) => [topic.id, topic.parentId]));
  const root = plan.topics[0] as PlannedTopic;
  plan.noteIds.forEach((id, position) => {
    if (position % 150 === 0) {
      plan.pending.set(`note:${id}`, "unplaced");
      return;
    }
    const leaf = leaves[position % leaves.length] as PlannedTopic;
    let seed: PlacementSeed = {
      kind: "note",
      item: id,
      topic: leaf.id,
      decided: "build",
      fingerprint: hashOf(id),
      centrality: 0.5 + (position % 50) / 100,
      gate: false,
      split: false,
      needsVector: false
    };
    const waiting = {
      topic: root.id,
      decided: "fallback",
      fingerprint: null,
      needsVector: true
    } as const;
    if (position % 400 === 1) {
      seed = { ...seed, fingerprint: "an-older-vector" };
      plan.pending.set(`note:${id}`, "stale");
    } else if (position % 600 === 2) {
      seed = { ...seed, ...waiting };
      plan.pending.set(`note:${id}`, "needs_vector");
    } else if (position % 900 === 3) {
      // Still waiting: its vector does not exist yet, so nothing can be decided.
      seed = { ...seed, ...waiting };
      plan.noVector.add(id);
    } else if (position % 700 === 4) {
      seed = { ...seed, topic: parentOf.get(leaf.id) as string, decided: "fallback", gate: true };
      plan.pending.set(`note:${id}`, "needs_gate");
    } else if (position % 1100 === 5) {
      seed = { ...seed, split: true };
      plan.pending.set(`note:${id}`, "needs_split_check");
    }
    (plan.topics.find((topic) => topic.id === seed.topic) as PlannedTopic).members.push(position);
    plan.notePlacements.push(seed);
  });
}

/** Every 15th root is unplaced; some wait for a composite vector, some have it now. */
function planSourcePlacements(plan: Plan) {
  const root = plan.topics[0] as PlannedTopic;
  const composites = new Set<string>();
  plan.rootIds.forEach((id, index) => {
    const placement: PlacementSeed = {
      kind: "source",
      item: id,
      topic: root.id,
      decided: "fallback",
      fingerprint: null,
      centrality: 0.5,
      gate: false,
      split: false,
      needsVector: false
    };
    if (index % 15 === 0) {
      plan.pending.set(`source:${id}`, "unplaced");
      if (index % 30 === 0) composites.add(id);
    } else if (index % 30 === 1) {
      plan.pending.set(`source:${id}`, "needs_vector");
      composites.add(id);
      plan.sourcePlacements.push({ ...placement, needsVector: true });
    } else if (index % 40 === 2) {
      plan.sourcePlacements.push({ ...placement, needsVector: true });
    } else {
      if (index % 5 === 3) composites.add(id);
      plan.sourcePlacements.push(placement);
    }
  });
  plan.compositeRoots = [...composites];
}

// ---------------------------------------------------------------------------
// Seeding

/** pgvector text form; nine significant digits round-trip every float32. */
function vectorText(data: Float32Array, row: number): string {
  const parts = new Array<string>(dim);
  for (let k = 0; k < dim; k += 1) parts[k] = (data[row * dim + k] as number).toPrecision(9);
  return `[${parts.join(",")}]`;
}

async function insertVectors(
  writer: PgPool,
  rows: Array<{ targetType: string; id: string; strategy: string; text: string }>
): Promise<void> {
  await writer.query(
    `insert into embeddings_1024 (target_type, target_id, provider, model, runtime, usage, strategy, content_hash, embedding)
     select t.type, t.id, $1, $2, $3, 'matching', t.strategy, t.hash, t.vec::vector
       from unnest($4::text[], $5::uuid[], $6::text[], $7::text[], $8::text[]) as t(type, id, strategy, hash, vec)`,
    [
      proofSpace.provider,
      proofSpace.model,
      proofSpace.runtime,
      rows.map((row) => row.targetType),
      rows.map((row) => row.id),
      rows.map((row) => row.strategy),
      rows.map((row) => hashOf(row.id)),
      rows.map((row) => row.text)
    ]
  );
}

/** Roots with one chapter each, and a chunk plus a note per note id, through the ordinary tables. */
async function seedLibrary(writer: PgPool, plan: Plan) {
  const { rootIds, chapterIds } = plan;
  await writer.query(
    `insert into source_items (id, type, title, parent_source_item_id)
     select r.id, 'Book', 'Book ' || r.i, null from unnest($1::uuid[]) with ordinality as r(id, i)`,
    [rootIds]
  );
  await writer.query(
    `insert into source_items (id, type, title, parent_source_item_id)
     select c.chapter, 'BookChapter', 'Chapter', c.root from unnest($1::uuid[], $2::uuid[]) as c(root, chapter)`,
    [rootIds, chapterIds]
  );
  await writer.query(
    `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
     select gen_random_uuid(), c, 'Document', 'seed', md5(c::text) from unnest($1::uuid[]) as c`,
    [chapterIds]
  );
  const perChapter = new Array<number>(chapterIds.length).fill(0);
  const rows = [...plan.noteIds, ...plan.excluded.keys()].map((id) => {
    const chapter = plan.noteChapter.get(id) as number;
    const index = perChapter[chapter] as number;
    perChapter[chapter] = index + 1;
    return { id, chapter: chapterIds[chapter] as string, index, chunk: randomUUID() };
  });
  for (let start = 0; start < rows.length; start += 5_000) {
    const page = rows.slice(start, start + 5_000);
    await writer.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       select t.chunk, d.id, t.chapter, t.idx, 'Passage', md5(t.chunk::text)
         from unnest($1::uuid[], $2::uuid[], $3::int[]) as t(chunk, chapter, idx)
         join documents d on d.source_item_id = t.chapter`,
      [page.map((row) => row.chunk), page.map((row) => row.chapter), page.map((row) => row.index)]
    );
    await writer.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
         ownership, created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key)
       select t.id, 'Note', 'Body', 'Idea', t.status::atomic_note_status, t.supersession, t.ownership,
              t.chapter, t.chunk, 'proof', 'proof', 'proof', 'proof', t.id::text
         from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[])
           as t(id, chapter, chunk, status, supersession, ownership)`,
      [
        page.map((row) => row.id),
        page.map((row) => row.chapter),
        page.map((row) => row.chunk),
        page.map((row) => plan.excluded.get(row.id)?.status ?? "active"),
        page.map((row) => plan.excluded.get(row.id)?.supersession ?? "current"),
        page.map((row) => (plan.knowledgeNotes.has(row.id) ? "knowledge" : "source"))
      ]
    );
  }
}

async function seedVectors(writer: PgPool, plan: Plan, seed: number) {
  const noteStrategy = `${noteVectorStrategyPrefix}${proofSpace.spaceKey}`;
  for (let start = 0; start < plan.noteIds.length; start += 400) {
    const rows: Parameters<typeof insertVectors>[1] = [];
    for (let row = start; row < Math.min(start + 400, plan.noteIds.length); row += 1) {
      const id = plan.noteIds[row] as string;
      if (!plan.noVector.has(id)) {
        rows.push({
          targetType: "atomic_note",
          id,
          strategy: noteStrategy,
          text: vectorText(plan.vectors, row)
        });
      }
    }
    await insertVectors(writer, rows);
  }
  // Notes that are not current keep their vectors; so do the composites of some roots.
  const excludedVectors = randomUnitVectors(plan.excluded.size, deriveSeed(seed, "excluded"));
  await insertVectors(
    writer,
    [...plan.excluded.keys()].map((id, row) => ({
      targetType: "atomic_note",
      id,
      strategy: noteStrategy,
      text: vectorText(excludedVectors, row)
    }))
  );
  const compositeVectors = randomUnitVectors(
    plan.compositeRoots.length,
    deriveSeed(seed, "composite")
  );
  await insertVectors(
    writer,
    plan.compositeRoots.map((id, row) => ({
      targetType: "source_item",
      id,
      strategy: `${sourceVectorStrategyPrefix}${proofSpace.spaceKey}`,
      text: vectorText(compositeVectors, row)
    }))
  );
}

/** What a topic stores: n, the exact sum of its subtree's counted vectors (children by id, then direct), cos_sq_sum. */
function subtreeStats(plan: Plan, topicsById: Map<string, PlannedTopic>, topic: PlannedTopic) {
  const rows: number[] = [];
  const collect = (current: PlannedTopic) => {
    for (const child of [...current.children].sort())
      collect(topicsById.get(child) as PlannedTopic);
    rows.push(...current.members.filter((row) => !plan.noVector.has(plan.noteIds[row] as string)));
  };
  collect(topic);
  const ls = new Float64Array(dim);
  for (const row of rows) {
    for (let k = 0; k < dim; k += 1)
      ls[k] = (ls[k] as number) + (plan.vectors[row * dim + k] as number);
  }
  const length = Math.sqrt(ls.reduce((sum, value) => sum + value * value, 0));
  let cosSq = 0;
  if (length > 0) {
    for (const row of rows) {
      let dotted = 0;
      for (let k = 0; k < dim; k += 1)
        dotted += (plan.vectors[row * dim + k] as number) * ((ls[k] as number) / length);
      cosSq += dotted * dotted;
    }
  }
  return { n: rows.length, ls, cosSq };
}

/**
 * Writes the planned tree through `topicTreeRepository` (D9), as the engine's cold start does: the
 * active tree with its root, then one `bootstrapSnapshot` change-set holding every topic, every
 * placement and the exact statistics of every topic, in one transaction. Returns the tree
 * generation that change-set produced.
 */
async function writeTopicStructure(writer: PgPool, plan: Plan, seed: number): Promise<number> {
  const repository = createTopicTreeRepository(writer);
  const topicsById = new Map(plan.topics.map((topic) => [topic.id, topic]));
  const root = plan.topics[0] as PlannedTopic;
  const topics = plan.topics.slice(1).map((topic) =>
    topicRecord(topic.id, topic.parentId, {
      role: "topic",
      title: `Topic ${topic.position}-${topic.id.slice(0, 8)}`,
      nameState: "named",
      nameSource: "llm",
      nameLanguage: "en",
      position: topic.position
    })
  );
  const seeds = [...plan.notePlacements, ...plan.sourcePlacements];
  const placements = seeds.map((entry) => ({
    item: itemKey(entry.kind, entry.item),
    placement: placementRecord(entry.topic, {
      decidedBy: entry.decided,
      itemFingerprint: entry.fingerprint,
      score: 0.5,
      margin: 0.1,
      needsGate: entry.gate,
      needsSplitCheck: entry.split,
      needsVector: entry.needsVector
    })
  }));
  const centralities = new Map<string, Array<{ item: ItemKey; centrality: number }>>();
  for (const entry of seeds) {
    const list = centralities.get(entry.topic) ?? [];
    list.push({ item: itemKey(entry.kind, entry.item), centrality: entry.centrality });
    centralities.set(entry.topic, list);
  }
  const stats: TopicStatsWrite[] = plan.topics.map((topic) => {
    const exact = subtreeStats(plan, topicsById, topic);
    return {
      topicId: topic.id,
      n: exact.n,
      ls: exact.ls,
      cosSqSum: exact.cosSq,
      lowCosPercentiles: Array.from({ length: 11 }, (_, k) => 0.2 + k * 0.01),
      repairClock: 3,
      centralities: centralities.get(topic.id) ?? []
    };
  });
  const client = await writer.connect();
  try {
    await client.query("begin");
    const tree = await repository.createTree(
      {
        id: plan.treeId,
        rootId: root.id,
        spaceKey: proofSpace.spaceKey,
        embeddingProvider: proofSpace.provider,
        embeddingModel: proofSpace.model,
        embeddingRuntime: proofSpace.runtime,
        dimensions: 1024,
        config: {},
        configHash: "proof",
        seed
      },
      { client }
    );
    const applied = await repository.bootstrapSnapshot(
      {
        treeId: tree.id,
        expectedGeneration: tree.generation,
        titleKey: "topics.changeSets.build",
        topics,
        placements,
        stats
      },
      { client }
    );
    assert.ok(applied.kind === "applied", `bootstrapSnapshot: ${JSON.stringify(applied)}`);
    assert.deepEqual(applied.dirtyTopicIds, [], "every topic has exact statistics");
    await client.query("commit");
    return applied.generation;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Answers and latency

interface Proof {
  plan: Plan;
  /** The tree generation after the bootstrap change-set. */
  generation: number;
  repository: TopicTreeLoadRepository;
  reader: PgPool;
  log: (line: string) => void;
}

async function checkSkeleton(proof: Proof, runs: number) {
  const { plan, repository, log } = proof;
  const topicsById = new Map(plan.topics.map((topic) => [topic.id, topic]));
  const skeleton = await repository.loadSkeleton(plan.treeId);
  assert.ok(skeleton);
  assert.equal(skeleton.tree.generation, proof.generation);
  assert.deepEqual(skeleton.tree.space, proofSpace);
  assert.equal(skeleton.topics.length, plan.topics.length);
  assert.equal(
    skeleton.placements.length,
    plan.notePlacements.length + plan.sourcePlacements.length
  );
  const loadedById = new Map(skeleton.topics.map((topic) => [topic.id, topic]));
  // The repository derives the direct count from the primary placements, root sources included.
  const direct = new Map<string, number>();
  for (const entry of [...plan.notePlacements, ...plan.sourcePlacements]) {
    direct.set(entry.topic, (direct.get(entry.topic) ?? 0) + 1);
  }
  for (const planned of plan.topics) {
    const loaded = loadedById.get(planned.id);
    assert.ok(loaded, `topic ${planned.id} is missing`);
    assert.equal(loaded.parentId, planned.parentId);
    assert.equal(loaded.position, planned.position);
    assert.equal(loaded.stats?.directItems, direct.get(planned.id) ?? 0);
    assert.equal(loaded.stats?.children, planned.children.length);
  }
  // Statistics survive the bytea round trip exactly and equal the sum of the vectors they came from.
  for (const index of [0, 13, Math.floor(plan.topics.length / 5), plan.topics.length - 1]) {
    const planned = plan.topics[index] as PlannedTopic;
    const expected = subtreeStats(plan, topicsById, planned);
    const stats = loadedById.get(planned.id)?.stats;
    assert.ok(stats);
    assert.equal(stats.n, expected.n);
    assert.equal(stats.ls.length, dim);
    assert.ok(
      stats.ls.every((value, k) => value === expected.ls[k]),
      `LS of ${planned.id} differs`
    );
    assert.equal(stats.cosSqSum, expected.cosSq);
    assert.equal(stats.lowCosPercentiles.length, 11);
    assert.equal(stats.dirty, false);
  }
  const keys = skeleton.placements.map((placement) => placement.key);
  assert.deepEqual(keys, [...keys].sort(), "placements come in item-key order");
  assert.ok(skeleton.placements.every((placement) => loadedById.has(placement.topicId)));
  const placed = new Set(keys);
  for (const [key, reason] of plan.pending) {
    assert.equal(placed.has(key), reason !== "unplaced", `${key} (${reason}) placement`);
  }
  log("skeleton answers: tree, topics, statistics (exact), placements");

  const loop = monitorEventLoopDelay({ resolution: 5 });
  const samples: number[] = [];
  loop.enable();
  for (let run = 0; run < runs; run += 1) {
    samples.push((await timed(() => repository.loadSkeleton(plan.treeId))).ms);
  }
  loop.disable();
  const timing = summarize(samples);
  log(`skeleton ms: ${JSON.stringify(timing)}`);
  assert.ok(
    samples.every((ms) => ms <= topicLoadBars.skeletonMs),
    `skeleton load over ${topicLoadBars.skeletonMs} ms: ${samples.map(Math.round).join(", ")}`
  );
  return { skeleton, timing: { ...timing, loopP99Ms: Math.round(loop.percentile(99) / 1e6) } };
}

async function checkVectors(proof: Proof, runs: number) {
  const { plan, repository, log } = proof;
  const requests = plan.noteIds.map((id) => ({ kind: "note" as const, id }));
  const withVector = plan.noteIds.filter((id) => !plan.noVector.has(id));

  const exact = await repository.loadItemVectors(proofSpace, requests, { normalize: false });
  assert.deepEqual(
    exact.keys,
    withVector.map((id) => `note:${id}`)
  );
  assert.deepEqual(exact.contentHashes, withVector.map(hashOf));
  assert.deepEqual(new Set(exact.missing), new Set([...plan.noVector].map((id) => `note:${id}`)));
  assert.deepEqual(exact.stale, []);
  let mismatches = 0;
  let row = 0;
  plan.noteIds.forEach((id, position) => {
    if (plan.noVector.has(id)) return;
    for (let k = 0; k < dim; k += 1) {
      if (exact.matrix.data[row * dim + k] !== plan.vectors[position * dim + k]) mismatches += 1;
    }
    row += 1;
  });
  assert.equal(mismatches, 0, "stored float32 values come back bit for bit");

  const unit = await repository.loadItemVectors(proofSpace, requests.slice(0, 200));
  for (let r = 0; r < unit.matrix.count; r += 1) {
    let sum = 0;
    for (let k = 0; k < dim; k += 1) sum += (unit.matrix.data[r * dim + k] as number) ** 2;
    assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-6);
  }
  const first = plan.noteIds[10] as string;
  const second = plan.noteIds[11] as string;
  const stale = await repository.loadItemVectors(proofSpace, [
    { kind: "note", id: first, contentHash: "edited-since" },
    { kind: "note", id: second, contentHash: hashOf(second) }
  ]);
  assert.deepEqual(stale.stale, [`note:${first}`]);
  assert.deepEqual(stale.keys, [`note:${second}`]);
  const other = await repository.loadItemVectors(
    { ...proofSpace, spaceKey: "another-space" },
    requests.slice(0, 10)
  );
  assert.equal(other.matrix.count, 0, "the vectors of another space key are never read");
  assert.equal(other.missing.length, 10);
  const composites = await repository.loadItemVectors(
    proofSpace,
    plan.compositeRoots.map((id) => ({ kind: "source" as const, id }))
  );
  assert.deepEqual(
    composites.keys,
    plan.compositeRoots.map((id) => `source:${id}`)
  );
  log("vector answers: bit-exact float32, unit rows, stale, missing, other space, composites");

  const loop = monitorEventLoopDelay({ resolution: 5 });
  const samples: number[] = [];
  let loaded = 0;
  let missing = 0;
  loop.enable();
  for (let run = 0; run < runs; run += 1) {
    const { result, ms } = await timed(() => repository.loadItemVectors(proofSpace, requests));
    samples.push(ms);
    loaded = result.matrix.count;
    missing = result.missing.length;
  }
  loop.disable();
  const timing = summarize(samples);
  log(`vectors ms: ${JSON.stringify(timing)} for ${loaded} x ${dim}`);
  assert.ok(
    samples.every((ms) => ms <= topicLoadBars.vectorsMs),
    `vector load over ${topicLoadBars.vectorsMs} ms: ${samples.map(Math.round).join(", ")}`
  );
  const textBaselineMs = Math.round(await textBaseline(proof, withVector));
  log(`vectors, text form instead of binary: ${textBaselineMs} ms`);
  assert.ok(timing.p50Ms < textBaselineMs, "the binary read is the faster one");
  return {
    ...timing,
    loaded,
    missing,
    textBaselineMs,
    loopP99Ms: Math.round(loop.percentile(99) / 1e6),
    loopMaxMs: Math.round(loop.max / 1e6)
  };
}

/** Reads the same vectors as text and parses them: the alternative the binary read replaced. */
async function textBaseline(proof: Proof, ids: string[]): Promise<number> {
  const start = performance.now();
  const out = new Float32Array(ids.length * dim);
  let row = 0;
  for (let from = 0; from < ids.length; from += topicLoadDefaults.vectorPageSize) {
    const result = await proof.reader.query<{ text: string }>(
      `select e.embedding::text as text from embeddings_1024 e
        where e.target_type = 'atomic_note' and e.target_id = any($1::uuid[]) and e.model = $2 and e.strategy = $3`,
      [
        ids.slice(from, from + topicLoadDefaults.vectorPageSize),
        proofSpace.model,
        `${noteVectorStrategyPrefix}${proofSpace.spaceKey}`
      ]
    );
    for (const item of result.rows) out.set(JSON.parse(item.text) as number[], dim * row++);
  }
  assert.equal(row, ids.length);
  return performance.now() - start;
}

/** Pages until the cursor ends; returns what was found and how long each page took. */
async function collectPending(
  repository: TopicTreeLoadRepository,
  plan: Plan,
  options: Parameters<TopicTreeLoadRepository["pendingItems"]>[2]
) {
  const found = new Map<string, TopicPendingReason>();
  const pageMs: number[] = [];
  let after: string | null = null;
  const start = performance.now();
  do {
    const { result: page, ms } = await timed(() =>
      repository.pendingItems(plan.treeId, proofSpace, { ...options, after })
    );
    pageMs.push(ms);
    for (const item of page.items) {
      assert.ok(!found.has(item.key), `${item.key} was listed twice`);
      found.set(item.key, item.reason);
    }
    after = page.next;
  } while (after);
  return { found, pageMs, totalMs: performance.now() - start };
}

async function checkPending(proof: Proof) {
  const { plan, repository, log } = proof;
  const scan = await collectPending(repository, plan, { limit: 500 });
  assert.deepEqual(
    [...scan.found].sort(byKey),
    [...plan.pending].sort(byKey),
    "pendingItems finds exactly the planted cases; rejected, archived, superseded and waiting items stay out"
  );
  const byReason: Record<string, number> = {};
  for (const reason of scan.found.values()) byReason[reason] = (byReason[reason] ?? 0) + 1;
  const timing = summarize(scan.pageMs);
  log(
    `pending: ${scan.found.size} ${JSON.stringify(byReason)}; ${scan.pageMs.length} pages, scan ${Math.round(scan.totalMs)} ms, page p95 ${timing.p95Ms} ms`
  );

  // Scoped to one root source, to one reason, to some note ids, and the notes without a root.
  const rootIndex = 15;
  const root = plan.rootIds[rootIndex] as string;
  const scoped = await collectPending(repository, plan, { rootSourceId: root, limit: 500 });
  const expectedScoped = [...plan.pending].filter(([key]) => {
    const id = key.slice(key.indexOf(":") + 1);
    return (
      key === `source:${root}` ||
      (key.startsWith("note:") &&
        plan.noteChapter.get(id) === rootIndex &&
        !plan.knowledgeNotes.has(id))
    );
  });
  assert.deepEqual([...scoped.found].sort(byKey), expectedScoped.sort(byKey));
  const gateOnly = await collectPending(repository, plan, { reasons: ["needs_gate"], limit: 500 });
  assert.deepEqual(
    [...gateOnly.found].sort(byKey),
    [...plan.pending].filter(([, reason]) => reason === "needs_gate").sort(byKey)
  );
  const notes = [...plan.pending]
    .filter(([key]) => key.startsWith("note:"))
    .slice(0, 5)
    .map(([key]) => key.slice(5));
  const byIds = await repository.pendingItems(plan.treeId, proofSpace, { noteIds: notes });
  assert.deepEqual(byIds.items.map((item) => item.id).sort(), [...notes].sort());
  assert.equal(byIds.next, null);
  const knowledge = await repository.pendingItems(plan.treeId, proofSpace, {
    noteIds: [...plan.knowledgeNotes].slice(0, 3)
  });
  assert.ok(knowledge.items.every((item) => item.rootSourceId === null));
  log(
    "pending answers: planted cases, root scope, reason filter, note ids, knowledge notes without a root"
  );
  return {
    found: scan.found.size,
    byReason,
    pages: scan.pageMs.length,
    fullScanMs: Math.round(scan.totalMs),
    pageP95Ms: timing.p95Ms,
    root,
    notes
  };
}

// ---------------------------------------------------------------------------
// Plans

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** The nodes of the EXPLAIN of exactly the statement the repository runs, and the relations it scans in sequence. */
async function explain(reader: PgPool, statement: string, values: unknown[]) {
  const result = await reader.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
    `explain (format json) ${statement}`,
    values
  );
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode) => {
    nodes.push(node);
    node.Plans?.forEach(walk);
  };
  const top = result.rows[0]?.["QUERY PLAN"][0]?.Plan;
  assert.ok(top);
  walk(top);
  return {
    plan: nodes.map((node) => {
      const relation = node["Relation Name"] ? ` on ${node["Relation Name"]}` : "";
      const index = node["Index Name"] ? ` using ${node["Index Name"]}` : "";
      return `${node["Node Type"]}${relation}${index}`;
    }),
    seqScans: nodes
      .filter((node) => node["Node Type"] === "Seq Scan")
      .map((node) => node["Relation Name"] ?? "")
  };
}

async function checkPlans(
  proof: Proof,
  skeleton: TopicSkeleton,
  pending: { root: string; notes: string[] }
) {
  const { plan, reader, log } = proof;
  const noteStrategy = `${noteVectorStrategyPrefix}${proofSpace.spaceKey}`;
  const sourceStrategy = `${sourceVectorStrategyPrefix}${proofSpace.spaceKey}`;
  const middleNote = plan.noteIds[Math.floor(plan.noteIds.length / 2)] as string;
  const middleSource = plan.rootIds[Math.floor(plan.rootIds.length / 2)] as string;
  const middlePlacement = skeleton.placements[Math.floor(skeleton.placements.length / 2)];
  const middleTopic = skeleton.topics[Math.floor(skeleton.topics.length / 3)];
  assert.ok(middlePlacement && middleTopic);
  /** The parameters of a pending statement: tree, model, strategy, cursor, window, reasons, scope. */
  const pendingValues = (kind: "note" | "source", after: string | null, ...scope: unknown[]) => [
    plan.treeId,
    proofSpace.model,
    kind === "note" ? noteStrategy : sourceStrategy,
    after,
    500,
    allReasons,
    ...scope
  ];
  const statements: Array<{ name: string; sql: string; values: unknown[]; guard: string[] }> = [
    { name: "tree", sql: topicLoadSql.tree, values: [plan.treeId], guard: guardedRelations },
    {
      name: "placements, first page",
      sql: topicLoadSql.placements,
      values: [plan.treeId, null, null, null, 5_000],
      guard: guardedRelations
    },
    {
      name: "placements, later page",
      sql: topicLoadSql.placements,
      values: [
        plan.treeId,
        middlePlacement.itemKind,
        middlePlacement.itemId,
        middlePlacement.rank,
        5_000
      ],
      guard: guardedRelations
    },
    {
      name: "topics and statistics, first page",
      sql: topicLoadSql.topics,
      values: [plan.treeId, null, 500],
      guard: guardedRelations
    },
    {
      name: "topics and statistics, later page",
      sql: topicLoadSql.topics,
      values: [plan.treeId, middleTopic.id, 500],
      guard: guardedRelations
    },
    {
      name: "note vectors, 1000 ids",
      sql: topicLoadSql.itemVectors(1024),
      values: ["atomic_note", plan.noteIds.slice(0, 1_000), proofSpace.model, noteStrategy],
      guard: guardedRelations
    },
    {
      name: "source vectors",
      sql: topicLoadSql.itemVectors(1024),
      values: ["source_item", plan.compositeRoots, proofSpace.model, sourceStrategy],
      guard: guardedRelations
    },
    {
      name: "pending notes, first window",
      sql: topicLoadSql.pendingNotes(1024, "library"),
      values: pendingValues("note", null),
      guard: guardedRelations
    },
    {
      name: "pending notes, later window",
      sql: topicLoadSql.pendingNotes(1024, "library"),
      values: pendingValues("note", middleNote),
      guard: guardedRelations
    },
    {
      name: "pending notes of one root",
      sql: topicLoadSql.pendingNotes(1024, "root"),
      values: pendingValues("note", null, pending.root),
      guard: guardedRelations
    },
    {
      name: "pending notes by id",
      sql: topicLoadSql.pendingNotes(1024, "ids"),
      values: pendingValues("note", null, pending.notes),
      guard: guardedRelations
    },
    {
      name: "pending sources, later window",
      sql: topicLoadSql.pendingSources(1024, "library"),
      values: pendingValues("source", middleSource),
      guard: guardedRelations
    },
    {
      name: "pending source of one root",
      sql: topicLoadSql.pendingSources(1024, "root"),
      values: pendingValues("source", null, pending.root),
      guard: guardedRelations
    }
  ];
  const plans: TopicLoadProofReport["plans"] = [];
  for (const statement of statements) {
    const { plan: nodes, seqScans } = await explain(reader, statement.sql, statement.values);
    plans.push({ statement: statement.name, plan: nodes });
    const offending = seqScans.filter((relation) => statement.guard.includes(relation));
    assert.deepEqual(
      offending,
      [],
      `${statement.name} scans ${offending.join(", ")} in sequence:\n${nodes.join("\n")}`
    );
    log(`explain ${statement.name}: ${nodes.join(" > ")}`);
  }
  return plans;
}

// ---------------------------------------------------------------------------

/**
 * Seeds the synthetic library on the migrated database behind `connectionString` and checks the load
 * repository against it. Throws on the first wrong answer, missed bar or sequential scan.
 */
export async function runTopicLoadProof(
  connectionString: string,
  options: TopicLoadProofOptions = {}
): Promise<TopicLoadProofReport> {
  const log = options.log ?? (() => undefined);
  const seed = options.seed ?? 20_261_015;
  const writer = createPgPool({ connectionString, max: 2 });
  const readOnlyString = `${connectionString}${connectionString.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
  const reader = createPgPool({ connectionString: readOnlyString, max: 2 });
  try {
    const plan = planLibrary({
      notes: options.notes ?? 18_632,
      topics: options.topics ?? 1_500,
      roots: options.roots ?? 300,
      seed
    });
    const placements = plan.notePlacements.length + plan.sourcePlacements.length;
    let started = performance.now();
    await seedLibrary(writer, plan);
    log(
      `library: ${plan.noteIds.length} notes, ${plan.rootIds.length} roots (${Math.round(performance.now() - started)} ms)`
    );
    started = performance.now();
    await seedVectors(writer, plan, seed);
    log(
      `vectors: ${plan.noteIds.length - plan.noVector.size} notes, ${plan.compositeRoots.length} composites (${Math.round(performance.now() - started)} ms)`
    );
    started = performance.now();
    const generation = await writeTopicStructure(writer, plan, seed);
    await writer.query("analyze");
    log(
      `structure: ${plan.topics.length} topics, ${placements} placements (${Math.round(performance.now() - started)} ms)`
    );

    // The measuring connection cannot write: the repository can only read.
    const mode = await reader.query<{ default_transaction_read_only: string }>(
      "show default_transaction_read_only"
    );
    assert.equal(mode.rows[0]?.default_transaction_read_only, "on");
    await assert.rejects(
      createTopicTreeRepository(reader).createTree({
        spaceKey: proofSpace.spaceKey,
        embeddingProvider: proofSpace.provider,
        embeddingModel: proofSpace.model,
        embeddingRuntime: proofSpace.runtime,
        dimensions: 1024,
        config: {},
        configHash: "proof",
        seed
      }),
      /read-only/
    );

    const repository = createTopicTreeLoadRepository(reader);
    assert.equal(await repository.activeTreeId(), plan.treeId);
    assert.equal(await repository.loadSkeleton(randomUUID()), null);
    const proof: Proof = { plan, generation, repository, reader, log };
    const { skeleton, timing: skeletonTiming } = await checkSkeleton(
      proof,
      options.skeletonRuns ?? 20
    );
    const vectors = await checkVectors(proof, options.vectorRuns ?? 3);
    const pending = await checkPending(proof);
    const plans = await checkPlans(proof, skeleton, pending);
    return {
      counts: {
        notes: plan.noteIds.length,
        topics: plan.topics.length,
        placements,
        vectors: vectors.loaded
      },
      skeleton: skeletonTiming,
      vectors,
      pending: {
        found: pending.found,
        byReason: pending.byReason,
        pages: pending.pages,
        fullScanMs: pending.fullScanMs,
        pageP95Ms: pending.pageP95Ms
      },
      plans
    };
  } finally {
    await Promise.all([closePgPool(writer), closePgPool(reader)]);
  }
}
