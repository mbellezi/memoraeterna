// Shape, quality and stability metrics for topic trees.
import type { TreeConfig } from "./config.js";
import type { IncrementalTopicEngine } from "./incremental.js";
import { createRng } from "./rng.js";
import { coherenceOf } from "./tree.js";
import type { TopicTree } from "./tree.js";
import { addRow, dotAt } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

export interface Distribution {
  count: number;
  min: number;
  max: number;
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  p95: number;
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted.length === 0
      ? 0
      : (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
    mean: sorted.length > 0 ? sum / sorted.length : 0,
    p10: at(0.1),
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95)
  };
}

function histogram(values: readonly number[], buckets: readonly number[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) {
    let label = `>${buckets.at(-1) ?? 0}`;
    for (let index = 0; index < buckets.length; index += 1) {
      const upper = buckets[index] as number;
      const lower = index === 0 ? -Infinity : (buckets[index - 1] as number);
      if (value > lower && value <= upper) {
        label = index === 0 ? `<=${upper}` : `${lower + 1}-${upper}`;
        break;
      }
    }
    output[label] = (output[label] ?? 0) + 1;
  }
  return output;
}

export interface ShapeReport {
  items: number;
  reachable: number;
  /** Share of expected items placed on exactly one node reachable from the root. */
  reachability: number;
  nodes: number;
  internalNodes: number;
  leaves: number;
  itemDepth: Distribution;
  leafDepth: Distribution;
  fanOut: Distribution & { histogram: Record<string, number>; inRange: number; inTarget: number };
  leafSize: Distribution & { histogram: Record<string, number>; inRange: number; inTarget: number };
  /** I6: nodes with exactly one child. */
  singleChildNodes: number;
  /** Internal nodes holding unadmitted direct items, and how many items. */
  internalNodesWithItems: number;
  directItemsOnInternal: number;
  /** Share of items sitting on internal nodes (not admitted to any leaf): the Unsorted share. */
  unsortedShare: number;
  coherence: { leafWeightedMean: number; leafP10: number; internalMean: number };
  violations: { hard: string[]; soft: Record<string, number> };
}

export function shapeReport(
  tree: TopicTree,
  config: TreeConfig,
  expectedItems?: readonly number[]
): ShapeReport {
  const hard: string[] = [];
  const soft: Record<string, number> = {
    fanOutOutsideRange: 0,
    leafSizeOutsideRange: 0,
    depthAboveTarget: 0,
    singleChildNodes: 0,
    internalNodesWithItems: 0
  };
  const visited = new Set<number>();
  const seenItems = new Map<number, number>();
  const itemDepths: number[] = [];
  const leafDepths: number[] = [];
  const fanOuts: number[] = [];
  const leafSizes: number[] = [];
  const leafCoherence: { value: number; n: number }[] = [];
  const internalCoherence: number[] = [];
  let singleChild = 0;
  let internalWithItems = 0;
  let directOnInternal = 0;

  const stack: { id: number; depth: number }[] = [{ id: tree.rootId, depth: 0 }];
  while (stack.length > 0) {
    const { id, depth } = stack.pop() as { id: number; depth: number };
    if (visited.has(id)) {
      hard.push(`I2 cycle or shared child at node ${id}`);
      continue;
    }
    visited.add(id);
    const node = tree.node(id);
    for (const item of node.items) {
      if (seenItems.has(item)) hard.push(`I2 item ${item} placed twice`);
      seenItems.set(item, id);
      itemDepths.push(depth);
    }
    if (node.children.length === 0) {
      leafDepths.push(depth);
      leafSizes.push(node.items.length);
      leafCoherence.push({ value: coherenceOf(node), n: node.n });
      if (node.items.length > config.leaf.hardMax)
        hard.push(`I4 leaf ${id} has ${node.items.length} items`);
      if (node.items.length < config.leaf.min || node.items.length > config.leaf.max) {
        soft.leafSizeOutsideRange = (soft.leafSizeOutsideRange ?? 0) + 1;
      }
      if (depth > config.depth.cap) hard.push(`I5 leaf ${id} at depth ${depth}`);
      if (depth > config.depth.target) soft.depthAboveTarget = (soft.depthAboveTarget ?? 0) + 1;
    } else {
      fanOuts.push(node.children.length);
      internalCoherence.push(coherenceOf(node));
      if (node.children.length > config.fanOut.hardMax) {
        hard.push(`I3 node ${id} has fan-out ${node.children.length}`);
      }
      if (node.children.length < config.fanOut.min || node.children.length > config.fanOut.max) {
        soft.fanOutOutsideRange = (soft.fanOutOutsideRange ?? 0) + 1;
      }
      if (node.children.length === 1) singleChild += 1;
      if (node.items.length > 0) {
        internalWithItems += 1;
        directOnInternal += node.items.length;
      }
      for (const child of node.children) {
        if (tree.node(child).parent !== id)
          hard.push(`I2 node ${child} has a stale parent pointer`);
        stack.push({ id: child, depth: depth + 1 });
      }
    }
  }
  soft.singleChildNodes = singleChild;
  soft.internalNodesWithItems = internalWithItems;

  const expected = expectedItems ?? [...tree.itemNode.keys()];
  let reachable = 0;
  for (const item of expected) {
    const node = tree.itemNode.get(item);
    if (node !== undefined && seenItems.get(item) === node) reachable += 1;
  }
  if (reachable < expected.length) hard.push(`I1 ${expected.length - reachable} items unreachable`);
  if (visited.size !== tree.nodes.size) {
    hard.push(`I1 ${tree.nodes.size - visited.size} nodes unreachable from the root`);
  }

  const leafWeight = leafCoherence.reduce((total, entry) => total + entry.n, 0);
  const sortedLeafCoherence = leafCoherence.map((entry) => entry.value).sort((a, b) => a - b);
  const fanOutDistribution = distribution(fanOuts);
  const leafDistribution = distribution(leafSizes);
  const targetLow = Math.ceil(config.leaf.target * 0.5);
  const targetHigh = Math.floor(config.leaf.target * 1.5);
  return {
    items: expected.length,
    reachable,
    reachability: expected.length > 0 ? reachable / expected.length : 1,
    nodes: visited.size,
    internalNodes: fanOuts.length,
    leaves: leafSizes.length,
    itemDepth: distribution(itemDepths),
    leafDepth: distribution(leafDepths),
    fanOut: {
      ...fanOutDistribution,
      histogram: histogram(fanOuts, [1, 3, 9, 12, 16]),
      inRange: share(fanOuts, (f) => f >= config.fanOut.min && f <= config.fanOut.max),
      inTarget: share(fanOuts, (f) => f >= config.fanOut.targetMin && f <= config.fanOut.targetMax)
    },
    leafSize: {
      ...leafDistribution,
      histogram: histogram(leafSizes, [2, 7, 22, 30, 45]),
      inRange: share(leafSizes, (s) => s >= config.leaf.min && s <= config.leaf.max),
      inTarget: share(leafSizes, (s) => s >= targetLow && s <= targetHigh)
    },
    singleChildNodes: singleChild,
    internalNodesWithItems: internalWithItems,
    directItemsOnInternal: directOnInternal,
    unsortedShare: expected.length > 0 ? directOnInternal / expected.length : 0,
    coherence: {
      leafWeightedMean:
        leafWeight > 0
          ? leafCoherence.reduce((total, entry) => total + entry.value * entry.n, 0) / leafWeight
          : 0,
      leafP10: sortedLeafCoherence[Math.floor(0.1 * sortedLeafCoherence.length)] ?? 0,
      internalMean: distribution(internalCoherence).mean
    },
    violations: { hard: [...new Set(hard)], soft }
  };
}

function share<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.length > 0 ? values.filter(predicate).length / values.length : 1;
}

/**
 * Cosine-distance silhouette over the partition "item -> direct node", estimated
 * on a sample. Mean distances to a cluster come from its sum vector, so the
 * estimate is exact for the sampled items.
 */
export function sampledSilhouette(
  tree: TopicTree,
  matrix: EmbeddingMatrix,
  options: { sample?: number; seed?: number } = {}
): number {
  const clusters = [...tree.nodes.values()].filter((node) => node.items.length > 0);
  if (clusters.length < 2) return 0;
  const { dim } = matrix;
  const sums = new Float32Array(clusters.length * dim);
  const sizes = clusters.map((node) => node.items.length);
  const clusterIndex = new Map<number, number>();
  clusters.forEach((node, index) => {
    const ls = new Float64Array(dim);
    for (const item of node.items) addRow(ls, matrix, item);
    sums.set(ls, index * dim);
    clusterIndex.set(node.id, index);
  });
  const items = [...tree.itemNode.keys()];
  const rng = createRng(options.seed ?? 1);
  const sample = rng.shuffle(items).slice(0, options.sample ?? 1000);
  let total = 0;
  for (const item of sample) {
    const own = clusterIndex.get(tree.itemNode.get(item) as number) as number;
    const ownSize = sizes[own] as number;
    if (ownSize < 2) continue; // silhouette of a singleton is 0
    let a = 0;
    let b = Infinity;
    for (let c = 0; c < clusters.length; c += 1) {
      const sim = dotAt(matrix.data, item * dim, sums, c * dim, dim);
      if (c === own) a = 1 - (sim - 1) / (ownSize - 1);
      else b = Math.min(b, 1 - sim / (sizes[c] as number));
    }
    const denominator = Math.max(a, b);
    total += denominator > 0 ? (b - a) / denominator : 0;
  }
  return sample.length > 0 ? total / sample.length : 0;
}

export interface PlacementStats {
  total: number;
  /** Share whose best leaf beat the runner-up leaf by less than the margin. */
  ambiguityRate: number;
  /** Ambiguous with the runner-up under a different parent. */
  crossParentAmbiguityRate: number;
  /** Share not admitted to any leaf (would land on an internal node). */
  unadmittedRate: number;
  /** Share re-placed onto their current node. */
  agreement: number;
}

/** Re-runs the placement decision for items already in the tree (read-only). */
export function placementStats(
  engine: IncrementalTopicEngine,
  items: readonly number[]
): PlacementStats {
  let ambiguous = 0;
  let crossParent = 0;
  let unadmitted = 0;
  let agree = 0;
  for (const item of items) {
    const placement = engine.place(item);
    if (placement.ambiguous) ambiguous += 1;
    if (placement.crossParentAmbiguous) crossParent += 1;
    if (!placement.admittedLeaf) unadmitted += 1;
    if (engine.tree.itemNode.get(item) === placement.nodeId) agree += 1;
  }
  const total = items.length;
  return {
    total,
    ambiguityRate: total > 0 ? ambiguous / total : 0,
    crossParentAmbiguityRate: total > 0 ? crossParent / total : 0,
    unadmittedRate: total > 0 ? unadmitted / total : 0,
    agreement: total > 0 ? agree / total : 0
  };
}

/** Normalized mutual information with arithmetic-mean normalization. */
export function nmi(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error("Label arrays differ in length");
  const n = a.length;
  if (n === 0) return 1;
  const countA = new Map<number, number>();
  const countB = new Map<number, number>();
  const joint = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    countA.set(x, (countA.get(x) ?? 0) + 1);
    countB.set(y, (countB.get(y) ?? 0) + 1);
    const key = `${x}:${y}`;
    joint.set(key, (joint.get(key) ?? 0) + 1);
  }
  const entropy = (counts: Map<number, number>): number => {
    let h = 0;
    for (const count of counts.values()) h -= (count / n) * Math.log(count / n);
    return h;
  };
  const ha = entropy(countA);
  const hb = entropy(countB);
  let mutual = 0;
  for (const [key, count] of joint) {
    const [x, y] = key.split(":").map(Number) as [number, number];
    mutual +=
      (count / n) * Math.log((count * n) / ((countA.get(x) as number) * (countB.get(y) as number)));
  }
  return ha + hb > 0 ? (2 * mutual) / (ha + hb) : 1;
}

/** Direct node of each item (the leaf partition). */
export function leafLabels(tree: TopicTree, items: readonly number[]): Int32Array {
  return Int32Array.from(items, (item) => tree.itemNode.get(item) ?? -1);
}

/**
 * Labels from a frontier cut: start at the root's children and keep expanding the
 * largest internal node until there are at least `clusters` labels.
 */
export function cutLabels(tree: TopicTree, items: readonly number[], clusters: number): Int32Array {
  let frontier = tree.isLeaf(tree.rootId) ? [tree.rootId] : [...tree.node(tree.rootId).children];
  for (;;) {
    if (frontier.length >= clusters) break;
    let largest = -1;
    for (const id of frontier) {
      const node = tree.node(id);
      if (node.children.length === 0) continue;
      if (largest < 0 || node.n > tree.node(largest).n) largest = id;
    }
    if (largest < 0) break;
    frontier = frontier.filter((id) => id !== largest).concat(tree.node(largest).children);
  }
  const label = new Map<number, number>();
  for (const id of frontier) {
    for (const item of tree.subtreeItems(id)) label.set(item, id);
  }
  return Int32Array.from(items, (item) => label.get(item) ?? tree.itemNode.get(item) ?? -1);
}

/** Share of items whose majority-label leaf agrees with their own label. */
export function purity(labels: ArrayLike<number>, truth: ArrayLike<number>): number {
  const byCluster = new Map<number, Map<number, number>>();
  for (let i = 0; i < labels.length; i += 1) {
    const counts = byCluster.get(labels[i] as number) ?? new Map<number, number>();
    counts.set(truth[i] as number, (counts.get(truth[i] as number) ?? 0) + 1);
    byCluster.set(labels[i] as number, counts);
  }
  let majority = 0;
  for (const counts of byCluster.values()) majority += Math.max(...counts.values());
  return labels.length > 0 ? majority / labels.length : 1;
}

/** Root-to-node path of each item's primary placement, as a string key. */
export function primaryPaths(tree: TopicTree, items: readonly number[]): string[] {
  return items.map((item) => {
    const node = tree.itemNode.get(item);
    return node === undefined ? "" : tree.pathOf(node).join("/");
  });
}

/** Share of items whose primary path changed. */
export function churn(before: readonly string[], after: readonly string[]): number {
  if (before.length !== after.length) throw new Error("Path arrays differ in length");
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) changed += 1;
  return before.length > 0 ? changed / before.length : 0;
}

/**
 * Largest deviation between the incrementally maintained N/LS statistics and an
 * exact recomputation (a consistency check for insert/remove/repair).
 */
export function statsDrift(
  tree: TopicTree,
  matrix: EmbeddingMatrix
): { maxCountError: number; maxSumError: number } {
  const exact = tree.clone();
  exact.recomputeStats(matrix);
  let maxCountError = 0;
  let maxSumError = 0;
  for (const [id, node] of tree.nodes) {
    const reference = exact.node(id);
    maxCountError = Math.max(maxCountError, Math.abs(node.n - reference.n));
    let squared = 0;
    for (let k = 0; k < matrix.dim; k += 1) {
      squared += ((node.ls[k] as number) - (reference.ls[k] as number)) ** 2;
    }
    maxSumError = Math.max(maxSumError, Math.sqrt(squared));
  }
  return { maxCountError, maxSumError };
}
