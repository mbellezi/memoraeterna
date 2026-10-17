// The topic clustering worker (T13, spec 3.4): pure compute over a transferred matrix of unit
// rows. `build` and `rebuild` run the Louvain builder of the engine; seed groups (chapters) are
// built as their own subtrees under the root and frozen groups (human or pinned subtrees) are
// kept whole as protected leaves, attached under the closest AI-managed topic. The protocol, its
// validation and the row order are in `@app/domain/topic-tree` (`worker-protocol.ts`).
import {
  buildLouvain,
  buildTimestamp,
  createRng,
  createTopicTreeEditor,
  createTopicTreeState,
  deriveSeed,
  dot,
  dotAt,
  getItem,
  getTopic,
  knnGraph,
  partitionOf,
  placementRecord,
  recomputeSubtree,
  recomputeTopic,
  recomputeUp,
  registerItem,
  repairAll,
  rowContentHash,
  rowItemKey,
  rowVectors,
  shapeReport,
  sumRows,
  topicClusteringRecallK,
  topicClusteringRecallQueries,
  TopicClusteringError,
  TopicClusteringRequestSchema,
  topicTreeConfigWith,
  unit,
  walkTopics
} from "@app/domain/topic-tree";
import type {
  EmbeddingMatrix,
  ItemVectorSource,
  ShapeContext,
  TopicClusteringRequest,
  TopicClusteringResult,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "./topic-communities.js";

interface Timings {
  knnMs: number;
  communitiesMs: number;
  repairMs: number;
}

/** A tree built over some rows, before the parts are assembled. */
interface Part {
  state: TopicTreeState;
  /** The part's root becomes a child of the combined root (seed groups) or is the root itself. */
  asChild: boolean;
}

/** The configuration of a tree below the root: no Areas target, `levels` fewer levels of depth. */
function innerConfig(config: TopicTreeConfig, levels: number): TopicTreeConfig {
  const cap = Math.max(1, config.depth.cap - levels);
  return topicTreeConfigWith(
    { fanOut: { rootTarget: 0 }, depth: { cap, target: Math.min(config.depth.target, cap) } },
    config
  );
}

function repairContext(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  config: TopicTreeConfig,
  seed: number
): ShapeContext {
  // Topic IDs are the counters 0..n-1 (the builders' form), so the next one is the topic count.
  let nextId = state.topics.size;
  return {
    state,
    vectors,
    config,
    seed,
    editor: createTopicTreeEditor(state, { record: false }),
    newTopicId: () => String(nextId++),
    now: buildTimestamp,
    seedLabel: (topicId) => topicId
  };
}

function rootOnly(dim: number): TopicTreeState {
  return createTopicTreeState({ dim, rootId: "0" });
}

/** The parts under one root: each seed part under a new child, the loose part in the root. */
function assemble(
  parts: readonly Part[],
  matrix: EmbeddingMatrix,
  vectors: ItemVectorSource,
  config: TopicTreeConfig,
  seed: number
): { state: TopicTreeState; repairMs: number } {
  const state = rootOnly(matrix.dim);
  const editor = createTopicTreeEditor(state, { record: false });
  let nextId = 1;
  for (const part of parts) {
    const ids = new Map<string, string>();
    walkTopics(part.state, (node) => {
      let id = state.rootId;
      if (node.parentId !== null || part.asChild) {
        id = String(nextId++);
        editor.createTopic(
          id,
          node.parentId === null ? state.rootId : (ids.get(node.parentId) as string)
        );
      }
      ids.set(node.id, id);
      for (const item of node.items) {
        registerItem(state, { ...getItem(part.state, item) });
        editor.placeItem(item, placementRecord(id, { decidedBy: "build" }));
      }
    });
  }
  const started = performance.now();
  recomputeSubtree(state, vectors);
  repairAll(repairContext(state, vectors, config, seed), { force: true });
  recomputeSubtree(state, vectors);
  return { state, repairMs: performance.now() - started };
}

/**
 * The deepest topic on the way down to `centroid` that still has room for a child, following the
 * closest child at each level and stopping above the first leaf. Protected leaves attached
 * earlier take part, so groups of one subject end up as siblings.
 */
function attachPoint(
  state: TopicTreeState,
  centroid: Float32Array,
  config: TopicTreeConfig
): string {
  let current = state.rootId;
  let withRoom: string | null = null;
  for (;;) {
    const node = getTopic(state, current);
    if (node.children.length < config.fanOut.max) withRoom = current;
    let best: string | null = null;
    let bestSimilarity = -Infinity;
    for (const childId of node.children) {
      const child = getTopic(state, childId);
      if (child.stats.n === 0) continue;
      const similarity = dot(centroid, child.stats.centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = childId;
      }
    }
    if (best === null || getTopic(state, best).children.length === 0) {
      return withRoom ?? current;
    }
    current = best;
  }
}

/** Attaches each frozen group as one protected leaf. */
function graftFrozen(
  state: TopicTreeState,
  matrix: EmbeddingMatrix,
  vectors: ItemVectorSource,
  config: TopicTreeConfig,
  groups: readonly (readonly number[])[]
): void {
  const context = repairContext(state, vectors, config, 0);
  for (const group of groups) {
    const parentId = attachPoint(state, unit(sumRows(matrix, group)), config);
    const id = context.newTopicId();
    context.editor.createTopic(id, parentId, { management: "pinned" });
    for (const row of group) {
      registerItem(state, {
        key: rowItemKey(row),
        kind: "note",
        contentHash: rowContentHash(row),
        rootSource: null
      });
      context.editor.placeItem(rowItemKey(row), placementRecord(id, { decidedBy: "build" }));
    }
    recomputeTopic(state, vectors, id);
    recomputeUp(state, vectors, parentId);
  }
}

function treeResult(
  request: TopicClusteringRequest,
  config: TopicTreeConfig,
  state: TopicTreeState,
  timings: Timings,
  exact: boolean
): TopicClusteringResult {
  const nodes = partitionOf(state);
  const result: TopicClusteringResult = {
    nodes,
    metrics: shapeReport(state, config, {
      expectedItems: Array.from({ length: request.rows }, (_, row) => rowItemKey(row))
    }),
    timings,
    knn: { exact }
  };
  const groups = request.frozenGroups;
  if (groups) {
    const wanted = new Map(groups.map((group, index) => [group[0] as number, index]));
    const frozenNodes: number[] = [];
    for (const node of nodes) {
      for (const row of node.items) {
        const index = wanted.get(row);
        if (index !== undefined) frozenNodes[index] = node.key;
      }
    }
    result.frozenNodes = frozenNodes;
  }
  return result;
}

function buildTree(request: TopicClusteringRequest): TopicClusteringResult {
  const config = request.kind === "split-subtree" ? innerConfig(request.config, 0) : request.config;
  const matrix: EmbeddingMatrix = {
    dim: request.dimensions,
    count: request.rows,
    data: request.vectors
  };
  const vectors = rowVectors(matrix);
  const claimed = new Uint8Array(request.rows);
  const seedGroups = request.seedGroups ?? [];
  const frozenGroups = request.frozenGroups ?? [];
  for (const group of [...seedGroups, ...frozenGroups]) for (const row of group) claimed[row] = 1;
  const loose: number[] = [];
  for (let row = 0; row < request.rows; row += 1) if (claimed[row] === 0) loose.push(row);

  const timings: Timings = { knnMs: 0, communitiesMs: 0, repairMs: 0 };
  let exact = true;
  const build = (rows: readonly number[], partConfig: TopicTreeConfig, seed: number) => {
    const built = buildLouvain(matrix, rows, {
      seed,
      config: partConfig,
      detectCommunities: detectCommunitiesLouvain,
      // Seeded parts and the loose rows are one library: one small-library neighbour count.
      libraryItems: request.rows
    });
    timings.knnMs += built.timings.knnMs;
    timings.communitiesMs += built.timings.communitiesMs;
    timings.repairMs += built.timings.repairMs;
    exact &&= built.knnExact ?? true;
    return built.state;
  };

  const looseState = loose.length > 0 ? build(loose, config, request.seed) : null;
  let state: TopicTreeState;
  if (seedGroups.length === 0) {
    state = looseState ?? rootOnly(matrix.dim);
  } else {
    const seedConfig = innerConfig(config, 1);
    const parts: Part[] = seedGroups.map((group, index) => ({
      state: build(group, seedConfig, deriveSeed(request.seed, `seed:${index}`)),
      asChild: true
    }));
    if (looseState) parts.push({ state: looseState, asChild: false });
    const assembled = assemble(parts, matrix, vectors, config, request.seed);
    timings.repairMs += assembled.repairMs;
    state = assembled.state;
  }

  if (frozenGroups.length > 0) {
    const started = performance.now();
    graftFrozen(state, matrix, vectors, config, frozenGroups);
    recomputeSubtree(state, vectors);
    timings.repairMs += performance.now() - started;
  }
  return treeResult(request, config, state, timings, exact);
}

/** Exact top-k neighbours of one row over all rows (ties keep the earlier row). */
function exactNeighbors(matrix: EmbeddingMatrix, query: number, k: number): number[] {
  const { dim, data } = matrix;
  const best: { row: number; sim: number }[] = [];
  const offset = query * dim;
  for (let row = 0; row < matrix.count; row += 1) {
    if (row === query) continue;
    const sim = dotAt(data, offset, data, row * dim, dim);
    if (best.length === k && sim <= (best[k - 1] as { sim: number }).sim) continue;
    let at = best.length;
    while (at > 0 && (best[at - 1] as { sim: number }).sim < sim) at -= 1;
    best.splice(at, 0, { row, sim });
    if (best.length > k) best.pop();
  }
  return best.map((entry) => entry.row);
}

/** Recall@10 of the kNN graph the builders use, against exact scans for sampled rows. */
function measureRecall(request: TopicClusteringRequest): TopicClusteringResult {
  const matrix: EmbeddingMatrix = {
    dim: request.dimensions,
    count: request.rows,
    data: request.vectors
  };
  const rows = Array.from({ length: request.rows }, (_, row) => row);
  const k = Math.min(topicClusteringRecallK, Math.max(1, request.rows - 1));
  const started = performance.now();
  const graph = knnGraph(matrix, rows, k, {
    seed: request.seed,
    exactLimit: request.config.knn.exactLimit,
    nprobe: request.config.knn.nprobe
  });
  const knnMs = performance.now() - started;
  let recallAt10 = 1;
  if (!graph.exact) {
    const queries = createRng(deriveSeed(request.seed, "knn-recall"))
      .shuffle(rows.slice())
      .slice(0, topicClusteringRecallQueries);
    let found = 0;
    let total = 0;
    for (const query of queries) {
      const listed = new Set<number>();
      for (let slot = 0; slot < k; slot += 1) {
        const neighbor = graph.neighbors[query * k + slot] as number;
        if (neighbor >= 0) listed.add(neighbor);
      }
      const truth = exactNeighbors(matrix, query, k);
      found += truth.filter((row) => listed.has(row)).length;
      total += truth.length;
    }
    recallAt10 = total > 0 ? found / total : 1;
  }
  return {
    nodes: [],
    metrics: shapeReport(rootOnly(matrix.dim), request.config, { expectedItems: [] }),
    timings: { knnMs, communitiesMs: 0, repairMs: 0 },
    knn: { exact: graph.exact, recallAt10 }
  };
}

/** Runs a validated request in this thread. */
export function clusterTopics(request: TopicClusteringRequest): TopicClusteringResult {
  return request.kind === "knn-recall" ? measureRecall(request) : buildTree(request);
}

function describeIssues(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`)
    .join("; ");
}

/** The worker entry: validates the payload, runs it and tags failures with their error code. */
export async function runTopicClustering(
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const parsed = TopicClusteringRequestSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TopicClusteringError(
      "topic_clustering_invalid_input",
      `Invalid clustering request: ${describeIssues(parsed.error)}`
    );
  }
  try {
    return clusterTopics(parsed.data);
  } catch (error) {
    if (error instanceof TopicClusteringError) throw error;
    throw new TopicClusteringError(
      "topic_clustering_failed",
      error instanceof Error && error.message ? error.message : "Clustering failed",
      { cause: error }
    );
  }
}
