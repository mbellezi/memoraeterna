// Offline topic-tree builders: top-down recursive balanced k-means, bottom-up
// Clio-like (leaf clusters, then recursive clustering of centroids) and Louvain
// over a cosine kNN graph. All finish with a forced repair pass so the tree
// honors the shape invariants.
import graphologyModule from "graphology";
import louvainModule from "graphology-communities-louvain";

import type { TreeConfig } from "./config.js";
import { defaultTreeConfig } from "./config.js";
import { groupsOf, sphericalKMeans } from "./kmeans.js";
import { repairAll } from "./repair.js";
import type { RepairOperation } from "./repair.js";
import { createRng, deriveSeed } from "./rng.js";
import { TopicTree } from "./tree.js";
import { addRow, dotAt, matrixFromRows, unit } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

// Both packages are CommonJS (`module.exports = ...`) but typed with `export default`;
// under NodeNext the default import is module.exports itself at runtime.
const Graph = graphologyModule as unknown as typeof graphologyModule.default;
const louvain = louvainModule as unknown as typeof louvainModule.default;

export type BuilderName = "top-down" | "bottom-up" | "louvain";

export interface BuildOptions {
  seed: number;
  config?: TreeConfig;
}

/** What the Louvain builder did at the top level (Spike B review: root fan-out stability). */
export interface LouvainDiagnostics {
  /** Communities Louvain returned for the whole set (after merging tiny ones). */
  rootCommunities: number;
  /** Children of the root: communities, or super-groups when there were too many. */
  rootChildren: number;
  /** The communities were grouped by centroid because there were more than fanOut.max. */
  rootSuperGrouped: boolean;
  /** Louvain was unusable at the root (one huge community) and k-means took over. */
  rootKmeansFallback: boolean;
  /** Super-grouping events below the root, as community counts. */
  innerSuperGroupings: number[];
}

export interface BuildResult {
  tree: TopicTree;
  /** Repairs applied by the final invariant pass. */
  repairs: RepairOperation[];
  /** Louvain builds only. */
  diagnostics?: LouvainDiagnostics;
}

interface SplitPlan {
  k: number;
  minSize: number;
  maxSize: number;
}

/**
 * How to split `n` items at `depth`: children become leaves when the set is small
 * (or the depth cap is near); otherwise k is chosen so that k^levels ~ n/leafTarget.
 */
export function planSplit(n: number, depth: number, config: TreeConfig): SplitPlan | null {
  const { leaf, fanOut } = config;
  const levelsLeft = config.depth.cap - depth;
  if (n <= leaf.max || levelsLeft <= 0) return null;
  const leavesNeeded = n / leaf.target;
  if (n <= leaf.max * fanOut.targetMax || levelsLeft <= 1) {
    let k = Math.max(2, Math.round(leavesNeeded), Math.ceil(n / leaf.max));
    // Prefer the fan-out target over the leaf-size target while leaves stay large enough.
    if (k < fanOut.targetMin && n >= fanOut.targetMin * leaf.minForTargetFanOut) {
      k = fanOut.targetMin;
    }
    return { k, minSize: Math.max(leaf.min, Math.floor((0.4 * n) / k)), maxSize: leaf.max };
  }
  const levels = Math.min(
    levelsLeft,
    Math.max(2, Math.ceil(Math.log(leavesNeeded) / Math.log(fanOut.targetMax)))
  );
  const k =
    depth === 0 && fanOut.rootTarget > 0
      ? Math.min(fanOut.max, fanOut.rootTarget)
      : Math.min(fanOut.max, Math.max(fanOut.targetMin, Math.round(leavesNeeded ** (1 / levels))));
  return { k, minSize: Math.floor((0.4 * n) / k), maxSize: Math.ceil((2 * n) / k) };
}

function kmeansGroups(
  matrix: EmbeddingMatrix,
  items: number[],
  plan: SplitPlan,
  seed: number,
  config: TreeConfig
): number[][] {
  const result = sphericalKMeans(matrix, items, {
    k: plan.k,
    seed,
    maxIterations: config.kmeans.maxIterations,
    tolerance: config.kmeans.tolerance,
    minSize: plan.minSize,
    maxSize: plan.maxSize
  });
  return groupsOf(result, items);
}

function finalize(
  tree: TopicTree,
  matrix: EmbeddingMatrix,
  config: TreeConfig,
  seed: number
): BuildResult {
  tree.recomputeStats(matrix);
  const repairs = repairAll({ tree, matrix, config, seed }, { force: true });
  tree.recomputeStats(matrix);
  return { tree, repairs };
}

// ---------------------------------------------------------------------------
// Top-down recursive balanced build

export function buildTopDown(
  matrix: EmbeddingMatrix,
  items: readonly number[],
  options: BuildOptions
): BuildResult {
  const config = options.config ?? defaultTreeConfig;
  const tree = new TopicTree(matrix.dim);
  const split = (nodeId: number, members: number[], depth: number): void => {
    const plan = planSplit(members.length, depth, config);
    if (!plan) {
      tree.setItems(nodeId, members);
      return;
    }
    const groups = kmeansGroups(
      matrix,
      members,
      plan,
      deriveSeed(options.seed, `td:${nodeId}`),
      config
    );
    if (groups.length < 2) {
      tree.setItems(nodeId, members);
      return;
    }
    for (const group of groups) split(tree.createNode(nodeId).id, group, depth + 1);
  };
  split(tree.rootId, [...items], 0);
  return finalize(tree, matrix, config, options.seed);
}

// ---------------------------------------------------------------------------
// Bottom-up Clio-like build

interface Cluster {
  items: number[];
  children: Cluster[];
  ls: Float64Array;
  n: number;
}

/** Leaf clusters of about leaf.target items (two-level for large inputs, for speed). */
export function leafClusters(
  matrix: EmbeddingMatrix,
  items: number[],
  config: TreeConfig,
  seed: number
): number[][] {
  const count = Math.max(1, Math.round(items.length / config.leaf.target));
  if (count <= 1) return [items];
  if (count <= 64) {
    return groupsOf(
      sphericalKMeans(matrix, items, {
        k: Math.max(count, Math.ceil(items.length / config.leaf.max)),
        seed,
        maxIterations: config.kmeans.maxIterations,
        tolerance: config.kmeans.tolerance,
        minSize: config.leaf.min,
        maxSize: config.leaf.max
      }),
      items
    );
  }
  const coarse = Math.round(Math.sqrt(count));
  const groups = groupsOf(
    sphericalKMeans(matrix, items, {
      k: coarse,
      seed,
      maxIterations: config.kmeans.maxIterations,
      tolerance: config.kmeans.tolerance,
      minSize: Math.floor((0.3 * items.length) / coarse),
      maxSize: Math.ceil((2.5 * items.length) / coarse)
    }),
    items
  );
  return groups.flatMap((group, index) =>
    leafClusters(matrix, group, config, deriveSeed(seed, `leaf:${index}`))
  );
}

export function buildBottomUp(
  matrix: EmbeddingMatrix,
  items: readonly number[],
  options: BuildOptions
): BuildResult {
  const config = options.config ?? defaultTreeConfig;
  const { childrenTarget, topTopicsMax } = config.bottomUp;
  let level: Cluster[] = leafClusters(
    matrix,
    [...items],
    config,
    deriveSeed(options.seed, "bu:leaves")
  ).map((members) => {
    const ls = new Float64Array(matrix.dim);
    for (const item of members) addRow(ls, matrix, item);
    return { items: members, children: [], ls, n: members.length };
  });

  for (let round = 0; level.length > topTopicsMax && round < 12; round += 1) {
    const m = level.length;
    let k = Math.round(m / childrenTarget);
    if (m <= topTopicsMax * config.fanOut.max) {
      k = Math.min(topTopicsMax, Math.max(k, Math.min(config.fanOut.targetMin, Math.floor(m / 2))));
    }
    k = Math.max(2, k);
    const vectors = matrixFromRows(
      level.map((cluster) => unit(cluster.ls)),
      false
    );
    const indices = level.map((_, index) => index);
    const result = sphericalKMeans(vectors, indices, {
      k,
      seed: deriveSeed(options.seed, `bu:level:${round}`),
      maxIterations: config.kmeans.maxIterations,
      tolerance: config.kmeans.tolerance,
      weights: level.map((cluster) => cluster.n),
      minSize: config.fanOut.min,
      maxSize: config.fanOut.max
    });
    level = groupsOf(result, indices).map((group) => {
      const children = group.map((index) => level[index] as Cluster);
      const ls = new Float64Array(matrix.dim);
      let n = 0;
      for (const child of children) {
        for (let d = 0; d < matrix.dim; d += 1) ls[d] = (ls[d] as number) + (child.ls[d] as number);
        n += child.n;
      }
      return { items: [], children, ls, n };
    });
  }

  const tree = new TopicTree(matrix.dim);
  const materialize = (nodeId: number, cluster: Cluster): void => {
    if (cluster.children.length === 0) tree.setItems(nodeId, cluster.items);
    for (const child of cluster.children) materialize(tree.createNode(nodeId).id, child);
  };
  if (level.length === 1) materialize(tree.rootId, level[0] as Cluster);
  else for (const cluster of level) materialize(tree.createNode(tree.rootId).id, cluster);
  return finalize(tree, matrix, config, options.seed);
}

// ---------------------------------------------------------------------------
// Cosine kNN graph and Louvain build

export interface KnnGraph {
  k: number;
  /** Global item IDs in local order. */
  rows: number[];
  /** n * k local neighbor indices (-1 when fewer than k exist). */
  neighbors: Int32Array;
  /** n * k cosine similarities. */
  sims: Float32Array;
}

export interface KnnOptions {
  seed: number;
  /** Exact search up to this many rows; inverted-file (IVF) search above. */
  exactLimit?: number;
  /** IVF lists probed per query. */
  nprobe?: number;
}

function pushTopK(
  neighbors: Int32Array,
  sims: Float32Array,
  base: number,
  k: number,
  candidate: number,
  sim: number
): void {
  if (sim <= (sims[base + k - 1] as number)) return;
  let position = k - 1;
  while (position > 0 && (sims[base + position - 1] as number) < sim) {
    sims[base + position] = sims[base + position - 1] as number;
    neighbors[base + position] = neighbors[base + position - 1] as number;
    position -= 1;
  }
  sims[base + position] = sim;
  neighbors[base + position] = candidate;
}

export function knnGraph(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  k: number,
  options: KnnOptions
): KnnGraph {
  const n = rows.length;
  const { dim, data } = matrix;
  const neighbors = new Int32Array(n * k).fill(-1);
  const sims = new Float32Array(n * k).fill(-Infinity);
  const exactLimit = options.exactLimit ?? 3000;
  if (n <= exactLimit) {
    for (let i = 0; i < n; i += 1) {
      const offset = (rows[i] as number) * dim;
      for (let j = i + 1; j < n; j += 1) {
        const sim = dotAt(data, offset, data, (rows[j] as number) * dim, dim);
        pushTopK(neighbors, sims, i * k, k, j, sim);
        pushTopK(neighbors, sims, j * k, k, i, sim);
      }
    }
  } else {
    const local = rows.map((_, index) => index);
    const listCount = Math.max(2, Math.round(Math.sqrt(n)));
    const coarse = sphericalKMeans(matrix, rows, {
      k: listCount,
      seed: deriveSeed(options.seed, "ivf"),
      maxIterations: 8
    });
    const lists: number[][] = Array.from({ length: coarse.k }, () => []);
    for (const i of local) lists[coarse.assignments[i] as number]?.push(i);
    const nprobe = Math.min(coarse.k, options.nprobe ?? 8);
    const centroidSims = new Float64Array(coarse.k);
    const order = Array.from({ length: coarse.k }, (_, index) => index);
    for (let i = 0; i < n; i += 1) {
      const offset = (rows[i] as number) * dim;
      coarse.centroids.forEach((centroid, c) => {
        centroidSims[c] = dotAt(data, offset, centroid, 0, dim);
      });
      order.sort((a, b) => (centroidSims[b] as number) - (centroidSims[a] as number));
      for (let p = 0; p < nprobe; p += 1) {
        for (const j of lists[order[p] as number] ?? []) {
          if (j === i) continue;
          pushTopK(
            neighbors,
            sims,
            i * k,
            k,
            j,
            dotAt(data, offset, data, (rows[j] as number) * dim, dim)
          );
        }
      }
    }
  }
  return { k, rows: [...rows], neighbors, sims };
}

/** Louvain communities over the kNN graph restricted to `subset` (global item IDs). */
function louvainCommunities(
  graph: KnnGraph,
  position: Map<number, number>,
  subset: number[],
  resolution: number,
  seed: number
): number[][] {
  const g = new Graph({ type: "undirected", allowSelfLoops: false });
  const inSubset = new Map<number, number>();
  subset.forEach((item, local) => {
    inSubset.set(item, local);
    g.addNode(String(local));
  });
  subset.forEach((item, local) => {
    const row = position.get(item);
    if (row === undefined) return;
    for (let slot = 0; slot < graph.k; slot += 1) {
      const neighbor = graph.neighbors[row * graph.k + slot] as number;
      if (neighbor < 0) continue;
      const other = inSubset.get(graph.rows[neighbor] as number);
      if (other === undefined || other === local) continue;
      const weight = Math.max(1e-6, graph.sims[row * graph.k + slot] as number);
      const a = String(Math.min(local, other));
      const b = String(Math.max(local, other));
      if (g.hasEdge(a, b)) {
        if ((g.getEdgeAttribute(a, b, "weight") as number) < weight) {
          g.setEdgeAttribute(a, b, "weight", weight);
        }
      } else {
        g.addEdge(a, b, { weight });
      }
    }
  });
  const mapping =
    g.size > 0
      ? louvain(g, { resolution, getEdgeWeight: "weight", rng: createRng(seed).next })
      : {};
  const groups = new Map<number, number[]>();
  subset.forEach((item, local) => {
    const community = mapping[String(local)] ?? -1 - local;
    const members = groups.get(community) ?? [];
    members.push(item);
    groups.set(community, members);
  });
  return [...groups.values()];
}

function centroidOf(matrix: EmbeddingMatrix, members: number[]): Float32Array {
  const ls = new Float64Array(matrix.dim);
  for (const item of members) addRow(ls, matrix, item);
  return unit(ls);
}

/** Folds groups smaller than `minSize` into the most similar remaining group. */
function mergeSmallGroups(matrix: EmbeddingMatrix, groups: number[][], minSize: number) {
  const large = groups.filter((group) => group.length >= minSize);
  const small = groups.filter((group) => group.length < minSize);
  if (large.length === 0) return [groups.flat()];
  const centroids = large.map((group) => centroidOf(matrix, group));
  for (const group of small) {
    for (const item of group) {
      let best = 0;
      let bestSim = -Infinity;
      centroids.forEach((centroid, index) => {
        const sim = dotAt(matrix.data, item * matrix.dim, centroid, 0, matrix.dim);
        if (sim > bestSim) {
          bestSim = sim;
          best = index;
        }
      });
      large[best]?.push(item);
    }
  }
  return large;
}

export interface LouvainBuildOptions extends BuildOptions {
  /**
   * "legacy" reproduces the root grouping before the Spike B review (acceptance window up
   * to 1.5 x the target, super-grouping with round(n / 6)); only for before/after runs.
   */
  rootGrouping?: "fixed" | "legacy";
  /** Reuse a precomputed kNN graph over (a superset of) the items. */
  graph?: KnnGraph;
  exactLimit?: number;
  nprobe?: number;
}

export function buildLouvain(
  matrix: EmbeddingMatrix,
  items: readonly number[],
  options: LouvainBuildOptions
): BuildResult {
  const config = options.config ?? defaultTreeConfig;
  const graph =
    options.graph ??
    knnGraph(matrix, items, config.louvain.knn, {
      seed: options.seed,
      ...(options.exactLimit === undefined ? {} : { exactLimit: options.exactLimit }),
      ...(options.nprobe === undefined ? {} : { nprobe: options.nprobe })
    });
  const position = new Map(graph.rows.map((item, index) => [item, index]));
  const tree = new TopicTree(matrix.dim);

  const diagnostics: LouvainDiagnostics = {
    rootCommunities: 0,
    rootChildren: 0,
    rootSuperGrouped: false,
    rootKmeansFallback: false,
    innerSuperGroupings: []
  };
  // Spike B review: the window used to reach 1.5 x desired (13 communities for 9 Areas),
  // above fanOut.max. Those were then super-grouped with k = round(13 / 6) = 2 and the
  // root ended with 2 Areas for some seeds and samples. At the root the window now stops
  // at fanOut.max and, if no resolution fits, the super-grouping aims at rootTarget.
  const legacyRoot = options.rootGrouping === "legacy";
  const acceptMax = (desired: number, depth: number): number =>
    depth === 0 && !legacyRoot ? Math.min(desired * 1.5, config.fanOut.max) : desired * 1.5;

  const communities = (
    members: number[],
    desired: number,
    nodeId: number,
    depth: number
  ): number[][] => {
    let resolution = config.louvain.resolution;
    let best: number[][] = [members];
    let bestError = Infinity;
    for (let attempt = 0; attempt < config.louvain.resolutionTries; attempt += 1) {
      const groups = mergeSmallGroups(
        matrix,
        louvainCommunities(
          graph,
          position,
          members,
          resolution,
          deriveSeed(options.seed, `lv:${nodeId}:${attempt}`)
        ),
        config.leaf.min
      );
      const error = Math.abs(Math.log(groups.length / desired));
      if (error < bestError) {
        best = groups;
        bestError = error;
      }
      if (groups.length >= desired * 0.7 && groups.length <= acceptMax(desired, depth)) break;
      resolution *= groups.length < desired ? 1.6 : 1 / 1.6;
    }
    return best;
  };

  const split = (nodeId: number, members: number[], depth: number): void => {
    const plan = planSplit(members.length, depth, config);
    if (!plan) {
      tree.setItems(nodeId, members);
      return;
    }
    let groups = communities(members, plan.k, nodeId, depth);
    if (depth === 0) diagnostics.rootCommunities = groups.length;
    const largest = Math.max(...groups.map((group) => group.length));
    if (groups.length < 2 || largest > 0.95 * members.length) {
      groups = kmeansGroups(
        matrix,
        members,
        plan,
        deriveSeed(options.seed, `lv-km:${nodeId}`),
        config
      );
      if (depth === 0) diagnostics.rootKmeansFallback = true;
    }
    if (groups.length > config.fanOut.max && depth + 2 <= config.depth.cap) {
      // Too many communities for one level: group them by centroid first.
      const vectors = matrixFromRows(
        groups.map((group) => centroidOf(matrix, group)),
        false
      );
      const indices = groups.map((_, index) => index);
      const superK =
        depth === 0 && config.fanOut.rootTarget > 0 && !legacyRoot
          ? Math.min(config.fanOut.max, config.fanOut.rootTarget)
          : Math.min(
              config.fanOut.targetMax,
              Math.max(2, Math.round(groups.length / config.repair.pushDownGroupSize))
            );
      if (depth === 0) diagnostics.rootSuperGrouped = true;
      else diagnostics.innerSuperGroupings.push(groups.length);
      const superGroups = groupsOf(
        sphericalKMeans(vectors, indices, {
          k: superK,
          seed: deriveSeed(options.seed, `lv-group:${nodeId}`),
          weights: groups.map((group) => group.length),
          minSize: config.fanOut.min,
          maxSize: config.fanOut.max
        }),
        indices
      );
      groups = superGroups.map((indicesInGroup) =>
        indicesInGroup.flatMap((index) => groups[index] ?? [])
      );
    }
    if (groups.length < 2) {
      tree.setItems(nodeId, members);
      return;
    }
    if (depth === 0) diagnostics.rootChildren = groups.length;
    for (const group of groups) split(tree.createNode(nodeId).id, group, depth + 1);
  };
  split(tree.rootId, [...items], 0);
  return { ...finalize(tree, matrix, config, options.seed), diagnostics };
}

export function buildTree(
  name: BuilderName,
  matrix: EmbeddingMatrix,
  items: readonly number[],
  options: LouvainBuildOptions
): BuildResult {
  switch (name) {
    case "top-down":
      return buildTopDown(matrix, items, options);
    case "bottom-up":
      return buildBottomUp(matrix, items, options);
    case "louvain":
      return buildLouvain(matrix, items, options);
  }
}
