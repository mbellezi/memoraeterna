// Shape, quality and stability metrics: the shape report (also the worker's `metrics` result),
// primary-path churn and diffs, statistics drift, and the clustering scores the self-check and
// the replay harness use (NMI, purity, sampled silhouette).
import { z } from "zod";

import type { TopicTreeConfig } from "./config.js";
import type { ItemKey } from "./ids.js";
import { checkInvariants } from "./invariants.js";
import type { InvariantOptions } from "./invariants.js";
import { createRng } from "./rng.js";
import {
  cloneTopicTreeState,
  getTopic,
  pathOf,
  primaryPlacement,
  subtreeItems,
  walkTopics
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { coherenceOf, recomputeSubtree, statsRow } from "./stats.js";
import { addRow, dotAt } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

export const DistributionSchema = z
  .object({
    count: z.number().int().min(0),
    min: z.number(),
    max: z.number(),
    mean: z.number(),
    p10: z.number(),
    p50: z.number(),
    p90: z.number(),
    p95: z.number()
  })
  .strict();
export type Distribution = z.infer<typeof DistributionSchema>;

const HistogramSchema = z.record(z.string(), z.number().int().min(0));
const share = z.number().min(0).max(1);

export const ShapeReportSchema = z
  .object({
    items: z.number().int().min(0),
    reachable: z.number().int().min(0),
    /** Share of expected items with a primary placement reachable from the root. */
    reachability: share,
    topics: z.number().int().min(0),
    internalTopics: z.number().int().min(0),
    leaves: z.number().int().min(0),
    itemDepth: DistributionSchema,
    leafDepth: DistributionSchema,
    fanOut: DistributionSchema.extend({
      histogram: HistogramSchema,
      inRange: share,
      inTarget: share
    }),
    leafSize: DistributionSchema.extend({
      histogram: HistogramSchema,
      inRange: share,
      inTarget: share
    }),
    /** I6: topics with exactly one child. */
    singleChildTopics: z.number().int().min(0),
    /** Internal topics (root included) holding direct items, and how many items. */
    internalTopicsWithItems: z.number().int().min(0),
    directItemsOnInternal: z.number().int().min(0),
    /** Share of items on internal topics (Spike B's Unsorted measure). */
    internalDirectShare: share,
    /** D27 Unsorted: root direct items plus items waiting at an ancestor for the gate or a split check. */
    unsortedShare: share,
    /** Roots waiting for a vector (reported apart from Unsorted, D27). */
    needsVectorItems: z.number().int().min(0),
    coherence: z
      .object({ leafWeightedMean: z.number(), leafP10: z.number(), internalMean: z.number() })
      .strict(),
    violations: z
      .object({
        hardCount: z.number().int().min(0),
        awaitingApproval: z.number().int().min(0),
        /** The first hard violations as `<code> <reason> <topic or item>`. */
        hard: z.array(z.string()).max(100),
        /** Soft violations per invariant code. */
        soft: z.record(z.string(), z.number().int().min(0))
      })
      .strict()
  })
  .strict();
export type ShapeReport = z.infer<typeof ShapeReportSchema>;

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

function shareOf<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.length > 0 ? values.filter(predicate).length / values.length : 1;
}

export function shapeReport(
  state: TopicTreeState,
  config: TopicTreeConfig,
  options: InvariantOptions = {}
): ShapeReport {
  const expected = [...(options.expectedItems ?? state.items.keys())];
  const invariants = checkInvariants(state, config, { ...options, expectedItems: expected });
  const itemDepths: number[] = [];
  const leafDepths: number[] = [];
  const fanOuts: number[] = [];
  const leafSizes: number[] = [];
  const leafCoherence: { value: number; n: number }[] = [];
  const internalCoherence: number[] = [];
  const reached = new Set<ItemKey>();
  let topics = 0;
  let singleChild = 0;
  let internalWithItems = 0;
  let directOnInternal = 0;
  let unsorted = 0;
  let needsVector = 0;
  walkTopics(state, (node, depth) => {
    topics += 1;
    for (const item of node.items) {
      reached.add(item);
      itemDepths.push(depth);
      const placement = primaryPlacement(state, item);
      if (placement?.needsVector) needsVector += 1;
      else if (node.id === state.rootId) unsorted += 1;
      else if (node.children.length > 0 && (placement?.needsGate || placement?.needsSplitCheck)) {
        unsorted += 1;
      }
    }
    if (node.children.length === 0) {
      leafDepths.push(depth);
      leafSizes.push(node.items.length);
      leafCoherence.push({ value: coherenceOf(node.stats), n: node.stats.n });
    } else {
      fanOuts.push(node.children.length);
      internalCoherence.push(coherenceOf(node.stats));
      if (node.children.length === 1) singleChild += 1;
      if (node.items.length > 0) {
        internalWithItems += 1;
        directOnInternal += node.items.length;
      }
    }
  });
  const reachable = expected.filter((item) => reached.has(item)).length;
  const leafWeight = leafCoherence.reduce((total, entry) => total + entry.n, 0);
  const sortedLeafCoherence = leafCoherence.map((entry) => entry.value).sort((a, b) => a - b);
  const targetLow = Math.ceil(config.leaf.target * 0.5);
  const targetHigh = Math.floor(config.leaf.target * 1.5);
  const soft: Record<string, number> = {};
  const hard: string[] = [];
  for (const violation of invariants.violations) {
    if (violation.awaitingApproval) continue;
    if (violation.severity === "soft") soft[violation.code] = (soft[violation.code] ?? 0) + 1;
    else if (hard.length < 100) {
      hard.push(
        `${violation.code} ${violation.reason} ${violation.topicId ?? violation.item ?? ""}`.trim()
      );
    }
  }
  return {
    items: expected.length,
    reachable,
    reachability: expected.length > 0 ? reachable / expected.length : 1,
    topics,
    internalTopics: fanOuts.length,
    leaves: leafSizes.length,
    itemDepth: distribution(itemDepths),
    leafDepth: distribution(leafDepths),
    fanOut: {
      ...distribution(fanOuts),
      histogram: histogram(fanOuts, [1, 3, 9, 12, 16]),
      inRange: shareOf(fanOuts, (f) => f >= config.fanOut.min && f <= config.fanOut.max),
      inTarget: shareOf(
        fanOuts,
        (f) => f >= config.fanOut.targetMin && f <= config.fanOut.targetMax
      )
    },
    leafSize: {
      ...distribution(leafSizes),
      histogram: histogram(leafSizes, [2, 7, 22, 30, 45]),
      inRange: shareOf(leafSizes, (s) => s >= config.leaf.min && s <= config.leaf.max),
      inTarget: shareOf(leafSizes, (s) => s >= targetLow && s <= targetHigh)
    },
    singleChildTopics: singleChild,
    internalTopicsWithItems: internalWithItems,
    directItemsOnInternal: directOnInternal,
    internalDirectShare: expected.length > 0 ? Math.min(1, directOnInternal / expected.length) : 0,
    unsortedShare: expected.length > 0 ? Math.min(1, unsorted / expected.length) : 0,
    needsVectorItems: needsVector,
    coherence: {
      leafWeightedMean:
        leafWeight > 0
          ? leafCoherence.reduce((total, entry) => total + entry.value * entry.n, 0) / leafWeight
          : 0,
      leafP10: sortedLeafCoherence[Math.floor(0.1 * sortedLeafCoherence.length)] ?? 0,
      internalMean: distribution(internalCoherence).mean
    },
    violations: {
      hardCount: invariants.hard,
      awaitingApproval: invariants.awaitingApproval,
      hard,
      soft
    }
  };
}

// ---------------------------------------------------------------------------
// Churn and primary-path diffs

/** Root-to-topic path (topic IDs joined by "/") of each item's primary placement ("" if none). */
export function primaryPaths(state: TopicTreeState, items: readonly ItemKey[]): string[] {
  return items.map((item) => {
    const placement = primaryPlacement(state, item);
    return placement && state.topics.has(placement.topicId)
      ? pathOf(state, placement.topicId).join("/")
      : "";
  });
}

/** Share of items whose primary path changed between two aligned path lists. */
export function churn(before: readonly string[], after: readonly string[]): number {
  if (before.length !== after.length) throw new Error("Path arrays differ in length");
  let changed = 0;
  for (let i = 0; i < before.length; i += 1) if (before[i] !== after[i]) changed += 1;
  return before.length > 0 ? changed / before.length : 0;
}

export interface PrimaryPathDiff {
  /** Items present in both states whose primary path changed. */
  changed: ItemKey[];
  /** Items present before and absent (unplaced) after. */
  removed: ItemKey[];
  /** Items placed after and not before. */
  added: ItemKey[];
  /** changed / items present in both. */
  churn: number;
}

/**
 * Primary-path diff between two states over the items placed in `before` and/or `after`. With
 * `resolveBefore`, topic IDs of the earlier paths are mapped first (e.g. through redirects).
 */
export function primaryPathDiff(
  before: TopicTreeState,
  after: TopicTreeState,
  resolveBefore: (topicId: string) => string = (topicId) => topicId
): PrimaryPathDiff {
  const pathMap = (
    state: TopicTreeState,
    resolve: (id: string) => string
  ): Map<ItemKey, string> => {
    const output = new Map<ItemKey, string>();
    walkTopics(state, (node) => {
      if (node.items.length === 0) return;
      const path = pathOf(state, node.id).map(resolve).join("/");
      for (const item of node.items) output.set(item, path);
    });
    return output;
  };
  const earlier = pathMap(before, resolveBefore);
  const later = pathMap(after, (id) => id);
  const changed: ItemKey[] = [];
  const removed: ItemKey[] = [];
  let common = 0;
  for (const [item, path] of earlier) {
    const next = later.get(item);
    if (next === undefined) {
      removed.push(item);
      continue;
    }
    common += 1;
    if (next !== path) changed.push(item);
  }
  const added = [...later.keys()].filter((item) => !earlier.has(item));
  return { changed, removed, added, churn: common > 0 ? changed.length / common : 0 };
}

/**
 * Largest deviation between the statistics in `state` (maintained in memory) and an exact
 * recompute of the same structure: the add/subtract consistency check.
 */
export function statsDrift(
  state: TopicTreeState,
  vectors: ItemVectorSource
): { maxCountError: number; maxSumError: number } {
  const exact = cloneTopicTreeState(state);
  recomputeSubtree(exact, vectors);
  let maxCountError = 0;
  let maxSumError = 0;
  walkTopics(state, (node) => {
    const reference = getTopic(exact, node.id).stats;
    maxCountError = Math.max(maxCountError, Math.abs(node.stats.n - reference.n));
    let squared = 0;
    for (let k = 0; k < state.dim; k += 1) {
      squared += ((node.stats.ls[k] as number) - (reference.ls[k] as number)) ** 2;
    }
    maxSumError = Math.max(maxSumError, Math.sqrt(squared));
  });
  return { maxCountError, maxSumError };
}

// ---------------------------------------------------------------------------
// Clustering scores (self-check and replay)

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

/** Share of items whose cluster's majority label equals their own label. */
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

/** The direct topic of each item as an integer label (-1 when unplaced). */
export function leafLabels(state: TopicTreeState, items: readonly ItemKey[]): Int32Array {
  const index = new Map<string, number>();
  return Int32Array.from(items, (item) => {
    const topicId = primaryPlacement(state, item)?.topicId;
    if (topicId === undefined) return -1;
    if (!index.has(topicId)) index.set(topicId, index.size);
    return index.get(topicId) as number;
  });
}

/**
 * Labels from a frontier cut: start at the root's children and keep expanding the largest internal
 * topic until there are at least `clusters` labels.
 */
export function cutLabels(
  state: TopicTreeState,
  items: readonly ItemKey[],
  clusters: number
): Int32Array {
  const root = getTopic(state, state.rootId);
  let frontier = root.children.length === 0 ? [root.id] : [...root.children];
  for (;;) {
    if (frontier.length >= clusters) break;
    let largest: string | null = null;
    for (const id of frontier) {
      const node = getTopic(state, id);
      if (node.children.length === 0) continue;
      if (largest === null || node.stats.n > getTopic(state, largest).stats.n) largest = id;
    }
    if (largest === null) break;
    const expanded = largest;
    frontier = frontier.filter((id) => id !== expanded).concat(getTopic(state, expanded).children);
  }
  const label = new Map<ItemKey, number>();
  frontier.forEach((id, index) => {
    for (const item of subtreeItems(state, id)) label.set(item, index);
  });
  const fallback = leafLabels(state, items);
  return Int32Array.from(
    items,
    (item, index) => label.get(item) ?? frontier.length + (fallback[index] as number)
  );
}

/**
 * Cosine-distance silhouette of the partition "item -> direct topic", estimated on a seeded
 * sample. Mean distances to a cluster come from its sum vector, so the estimate is exact for the
 * sampled items.
 */
export function sampledSilhouette(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  options: { sample?: number; seed?: number } = {}
): number {
  const clusters: ItemKey[][] = [];
  walkTopics(state, (node) => {
    const members = node.items.filter((item) => statsRow(state, vectors, item) !== undefined);
    if (members.length > 0) clusters.push(members);
  });
  if (clusters.length < 2) return 0;
  const { matrix } = vectors;
  const { dim } = matrix;
  const sums = new Float32Array(clusters.length * dim);
  const sizes = clusters.map((members) => members.length);
  const clusterOf = new Map<ItemKey, number>();
  clusters.forEach((members, index) => {
    const ls = new Float64Array(dim);
    for (const item of members) {
      addRow(ls, matrix, vectors.rowOf(item) as number);
      clusterOf.set(item, index);
    }
    sums.set(ls, index * dim);
  });
  const rng = createRng(options.seed ?? 1);
  const sample = rng.shuffle([...clusterOf.keys()]).slice(0, options.sample ?? 1000);
  let total = 0;
  for (const item of sample) {
    const own = clusterOf.get(item) as number;
    const ownSize = sizes[own] as number;
    if (ownSize < 2) continue; // silhouette of a singleton is 0
    const offset = (vectors.rowOf(item) as number) * dim;
    let a = 0;
    let b = Infinity;
    for (let c = 0; c < clusters.length; c += 1) {
      const sim = dotAt(matrix.data, offset, sums, c * dim, dim);
      if (c === own) a = 1 - (sim - 1) / (ownSize - 1);
      else b = Math.min(b, 1 - sim / (sizes[c] as number));
    }
    const denominator = Math.max(a, b);
    total += denominator > 0 ? (b - a) / denominator : 0;
  }
  return sample.length > 0 ? total / sample.length : 0;
}
