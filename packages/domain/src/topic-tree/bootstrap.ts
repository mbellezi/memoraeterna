// The cold start, chapter seeding, rebuild triggers and the Areas level of the Topic Tree Engine
// (F2 T19, D12, D39; plan 4.1 "Bootstrap and cold start" and "Shadow rebuild").
//
// Cold start. Items wait in Unsorted (the root's direct items) while fewer than
// `bootstrap.minItems` of them can be clustered (notes with a vector in the tree's space). Then one
// build makes the first tree: up to `bootstrap.singleTopicMaxItems` notes stay one topic unless a
// 2..`bootstrap.maxInitialSplit`-way split reaches `bootstrap.modularityMin` on the cosine kNN
// graph (a single topic has modularity 0); larger libraries go to the Louvain-kNN builder in the
// clustering worker (Spike B's winner). Root sources and notes without a vector are then placed by
// PLACE on the built tree, in the same change-set.
//
// Chapter seeding. When at least `bootstrap.chapterSeedShare` of the clusterable notes come from
// one root source with at least `bootstrap.chapterMinChildren` child source items (a book and its
// chapters), the notes of each chapter seed a subtree of their own (the worker's seed groups).
// Chapters with fewer than `leaf.min` notes, and the notes of the root itself, are clustered with
// the rest.
//
// Rebuilds. Between builds the tree grows by PLACE and REBALANCE. It is rebuilt, mapped onto the
// live tree so topic IDs survive (rebuild-map.ts), when its structural configuration changes (D39,
// decided by the service), when the library doubled since the last build while it holds at most
// `rebuild.doublingMaxItems` notes, when the weighted leaf coherence dropped by
// `rebuild.qualityDrop` since the last build, or when at least `rebuild.unadmittedBurstShare` of
// the items PLACE decided since the last build (and at least `rebuild.unadmittedBurstMinItems`)
// are left unadmitted at an internal topic or the root.
//
// Areas (D12). The root's children are the Areas level once the top two levels exist (a level-1
// topic has children): from then on the root's fan-out band is the Areas band and every Area-level
// REBALANCE operation is a proposal. The LLM grouping into Areas runs after a build that left at
// least `areas.minLevel2Topics` level-2 topics (T24).
import type { CommunityGraph, DetectCommunities } from "./build.js";
import { communityGraphOf, contentAnchor } from "./build.js";
import type { TopicTreeConfig } from "./config.js";
import { compareContentKeys, compareStrings } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { groupsOf, sphericalKMeans } from "./kmeans.js";
import { knnGraph } from "./knn.js";
import type { RebuildPartitionNode } from "./rebuild-map.js";
import { createRng, deriveSeed } from "./rng.js";
import { getTopic, isLive, isProtected, primaryPlacement, walkTopics } from "./state.js";
import type { TopicTreeState } from "./state.js";
import { addRow, dotAt, norm, unit } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

// ---------------------------------------------------------------------------
// Cold start

/**
 * What a build does with `clusterable` notes: `wait` leaves every item in Unsorted, `small` makes
 * one topic or a small split in process, `build` runs the Louvain-kNN builder.
 */
export type ColdStartKind = "wait" | "small" | "build";

export function coldStartKind(clusterable: number, config: TopicTreeConfig): ColdStartKind {
  if (clusterable < config.bootstrap.minItems) return "wait";
  if (clusterable <= config.bootstrap.singleTopicMaxItems) return "small";
  return "build";
}

/**
 * Newman modularity of a labelling of an undirected weighted graph (each edge listed once):
 * Q = sum over communities of L_c / m - (d_c / 2m)^2. A single community scores 0.
 */
export function modularity(graph: CommunityGraph, labels: ArrayLike<number>): number {
  const degree = new Float64Array(graph.nodeCount);
  let total = 0;
  for (let edge = 0; edge < graph.sources.length; edge += 1) {
    const weight = graph.weights[edge] as number;
    total += weight;
    degree[graph.sources[edge] as number] =
      (degree[graph.sources[edge] as number] as number) + weight;
    degree[graph.targets[edge] as number] =
      (degree[graph.targets[edge] as number] as number) + weight;
  }
  if (total <= 0) return 0;
  const inside = new Map<number, number>();
  const degrees = new Map<number, number>();
  for (let edge = 0; edge < graph.sources.length; edge += 1) {
    const a = labels[graph.sources[edge] as number] as number;
    if (a === labels[graph.targets[edge] as number]) {
      inside.set(a, (inside.get(a) ?? 0) + (graph.weights[edge] as number));
    }
  }
  for (let node = 0; node < graph.nodeCount; node += 1) {
    const label = labels[node] as number;
    degrees.set(label, (degrees.get(label) ?? 0) + (degree[node] as number));
  }
  let q = 0;
  for (const [label, sum] of degrees) {
    q += (inside.get(label) ?? 0) / total - (sum / (2 * total)) ** 2;
  }
  return q;
}

export interface SmallPartition {
  /** Groups of matrix rows: one per topic, in the order of their first row (content-key order). */
  groups: number[][];
  /** Modularity of the chosen partition (0 for a single topic). */
  modularity: number;
  /** Every split tried: how it was found, its group count and modularity. */
  candidates: { method: "kmeans" | "louvain"; k: number; modularity: number }[];
}

/**
 * Rows of `labels` (by local index) grouped, with groups below `minSize` folded into the group
 * whose centroid is closest to each of their rows; one group when none is large enough.
 */
function foldedGroups(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  labels: ArrayLike<number>,
  minSize: number
): number[][] {
  const byLabel = new Map<number, number[]>();
  rows.forEach((row, index) => {
    const label = labels[index] as number;
    byLabel.set(label, [...(byLabel.get(label) ?? []), row]);
  });
  const groups = [...byLabel.values()];
  const large = groups.filter((group) => group.length >= minSize);
  if (large.length === 0) return [[...rows]];
  const centroids = large.map((group) => {
    const sum = new Float64Array(matrix.dim);
    for (const row of group) addRow(sum, matrix, row);
    return unit(sum);
  });
  for (const group of groups) {
    if (group.length >= minSize) continue;
    for (const row of group) {
      let best = 0;
      let bestSimilarity = -Infinity;
      centroids.forEach((centroid, index) => {
        const similarity = dotAt(matrix.data, row * matrix.dim, centroid, 0, matrix.dim);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          best = index;
        }
      });
      large[best]?.push(row);
    }
  }
  return large;
}

/**
 * The cold start of a small library (at most `bootstrap.singleTopicMaxItems` notes): splits into
 * 2..`bootstrap.maxInitialSplit` groups of at least `leaf.min` notes are proposed by balanced
 * spherical k-means and, when a community detector is given, by Louvain on the cosine kNN graph at
 * the `louvain.resolutionTries` resolutions around `louvain.resolution` (steps of
 * `louvain.resolutionStep`). Each is scored by modularity on that graph, and the best one is taken
 * only when it reaches `bootstrap.modularityMin`; otherwise every note forms one topic. `rows` come
 * in content-key order (D22), so the result does not depend on IDs.
 */
export function smallLibraryPartition(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  config: TopicTreeConfig,
  seed: number,
  detectCommunities?: DetectCommunities
): SmallPartition {
  const all = [...rows];
  const candidates: SmallPartition["candidates"] = [];
  const single: SmallPartition = { groups: [all], modularity: 0, candidates };
  const maxSplit = Math.min(
    config.bootstrap.maxInitialSplit,
    Math.floor(all.length / config.leaf.min)
  );
  if (maxSplit < 2) return single;
  const graph = knnGraph(matrix, all, Math.min(config.louvain.knn, all.length - 1), {
    seed,
    exactLimit: config.knn.exactLimit,
    nprobe: config.knn.nprobe
  });
  const position = new Map(graph.rows.map((row, index) => [row, index]));
  const community = communityGraphOf(graph, position, all);
  let best: SmallPartition = single;
  const seen = new Set<string>();
  const consider = (method: "kmeans" | "louvain", groups: number[][]): void => {
    if (groups.length < 2 || groups.length > maxSplit) return;
    const sorted = groups
      .map((group) => [...group].sort((a, b) => a - b))
      .sort((a, b) => (a[0] as number) - (b[0] as number));
    const key = JSON.stringify(sorted);
    if (seen.has(key)) return;
    seen.add(key);
    const labelOf = new Map<number, number>();
    sorted.forEach((group, label) => group.forEach((row) => labelOf.set(row, label)));
    const score = modularity(
      community,
      all.map((row) => labelOf.get(row) as number)
    );
    candidates.push({ method, k: sorted.length, modularity: score });
    if (score > best.modularity) best = { groups: sorted, modularity: score, candidates };
  };
  for (let split = 2; split <= maxSplit; split += 1) {
    const result = sphericalKMeans(matrix, all, {
      k: split,
      seed: deriveSeed(seed, `bootstrap:${split}`),
      maxIterations: config.kmeans.maxIterations,
      tolerance: config.kmeans.tolerance,
      minSize: config.leaf.min,
      maxSize: all.length
    });
    consider("kmeans", groupsOf(result, all));
  }
  if (detectCommunities && community.sources.length > 0) {
    const { resolution, resolutionStep, resolutionTries } = config.louvain;
    const lowest = -Math.floor(resolutionTries / 2);
    for (let step = lowest; step < lowest + resolutionTries; step += 1) {
      const labels = detectCommunities(community, {
        resolution: resolution * resolutionStep ** step,
        rng: createRng(deriveSeed(seed, `bootstrap-louvain:${step}`)).next
      });
      consider("louvain", foldedGroups(matrix, all, labels, config.leaf.min));
    }
  }
  const chosen = best.modularity >= config.bootstrap.modularityMin ? best : single;
  return { groups: chosen.groups, modularity: chosen.modularity, candidates };
}

/** One clustered node: `items` are matrix rows (the worker's result shape). */
export interface RowPartitionNode {
  key: number;
  parent: number | null;
  items: number[];
}

/** Partition nodes of a small library: the root, then one topic per group. */
export function smallPartitionNodes(groups: readonly (readonly number[])[]): RowPartitionNode[] {
  return [
    { key: 0, parent: null, items: [] },
    ...groups.map((items, index) => ({ key: index + 1, parent: 0, items: [...items] }))
  ];
}

// ---------------------------------------------------------------------------
// Chapter seeding

export interface ChapterSeedItem {
  key: ItemKey;
  contentHash: string;
  /** Root source ID of the note; null for a knowledge-owned note. */
  rootSource: string | null;
  /** The root's child source item the note descends from (known for the dominant root only). */
  chapter: string | null;
}

/** The root source that holds the most items, with its share (ties: the smaller ID). */
export function dominantRootSource(
  items: readonly Pick<ChapterSeedItem, "rootSource">[]
): { rootSource: string; share: number } | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.rootSource !== null) {
      counts.set(item.rootSource, (counts.get(item.rootSource) ?? 0) + 1);
    }
  }
  let best: { rootSource: string; count: number } | null = null;
  for (const [rootSource, count] of counts) {
    if (
      best === null ||
      count > best.count ||
      (count === best.count && compareStrings(rootSource, best.rootSource) < 0)
    ) {
      best = { rootSource, count };
    }
  }
  if (best === null || items.length === 0) return null;
  return { rootSource: best.rootSource, share: best.count / items.length };
}

export interface ChapterSeeding {
  rootSource: string;
  share: number;
  /** Item keys per chapter, each in content-key order; groups ordered by their first item. */
  groups: ItemKey[][];
}

/**
 * Chapter seeding (plan 4.1: chapter centroids seed the build of a single hierarchical source):
 * when the dominant root holds at least `bootstrap.chapterSeedShare` of the items and has at least
 * `bootstrap.chapterMinChildren` child source items, each chapter with at least `leaf.min` notes
 * becomes a seed group; at most `maxGroups` of them (the largest), the rest are clustered loose.
 * Null when fewer than two groups remain.
 */
export function chapterSeedGroups(
  items: readonly ChapterSeedItem[],
  childSources: (rootSource: string) => number,
  config: TopicTreeConfig,
  maxGroups: number
): ChapterSeeding | null {
  const dominant = dominantRootSource(items);
  if (!dominant || dominant.share < config.bootstrap.chapterSeedShare) return null;
  if (childSources(dominant.rootSource) < config.bootstrap.chapterMinChildren) return null;
  const byChapter = new Map<string, ChapterSeedItem[]>();
  for (const item of items) {
    if (item.rootSource !== dominant.rootSource || item.chapter === null) continue;
    const list = byChapter.get(item.chapter) ?? [];
    list.push(item);
    byChapter.set(item.chapter, list);
  }
  const groups = [...byChapter.values()]
    .filter((group) => group.length >= config.leaf.min)
    .map((group) => group.sort(compareContentKeys))
    .sort(
      (a, b) =>
        b.length - a.length || compareContentKeys(a[0] as ChapterSeedItem, b[0] as ChapterSeedItem)
    )
    .slice(0, Math.max(0, maxGroups))
    .sort((a, b) => compareContentKeys(a[0] as ChapterSeedItem, b[0] as ChapterSeedItem))
    .map((group) => group.map((item) => item.key));
  if (groups.length < 2) return null;
  return { rootSource: dominant.rootSource, share: dominant.share, groups };
}

// ---------------------------------------------------------------------------
// The shape of a live tree

/** The tree has a topic below the root (otherwise it is in its cold start). */
export function hasTopics(state: TopicTreeState): boolean {
  for (const node of state.topics.values()) {
    if (node.id !== state.rootId && isLive(node)) return true;
  }
  return false;
}

/** The root's children are the Areas level: the top two levels exist (D12). */
export function areasActive(state: TopicTreeState): boolean {
  return getTopic(state, state.rootId).children.some(
    (child) => getTopic(state, child).children.length > 0
  );
}

/** Live topics at depth 2 (the topics the Areas grouping regroups). */
export function level2TopicCount(state: TopicTreeState): number {
  let count = 0;
  walkTopics(state, (_node, depth) => {
    if (depth === 2) count += 1;
  });
  return count;
}

/** A build left enough level-2 topics for the Areas grouping (T24's `topic-areas`). */
export function areasGroupingDue(state: TopicTreeState, config: TopicTreeConfig): boolean {
  return level2TopicCount(state) >= config.areas.minLevel2Topics;
}

// ---------------------------------------------------------------------------
// Rebuild triggers

/** What a build records in its change-set summary for the triggers of the next rebuild. */
export interface BuildBaseline {
  /** Placed notes right after the build. */
  notes: number;
  /** Weighted leaf coherence right after the build (null when it had no leaf with notes). */
  leafCoherence: number | null;
}

const placeDecisions: ReadonlySet<string> = new Set(["auto", "gate", "fallback"]);

export interface StructureSignals {
  /** Notes with a primary placement. */
  notes: number;
  /** sum |LS| / sum N over leaves: the n-weighted mean leaf coherence. */
  leafCoherence: number | null;
  /** Items whose primary placement PLACE decided since the last build (not waiting for a vector). */
  decidedSinceBuild: number;
  /** Of those, the items left unadmitted (fallback, no gate or split check pending). */
  unadmitted: number;
}

export function structureSignals(state: TopicTreeState): StructureSignals {
  let notes = 0;
  let decided = 0;
  let unadmitted = 0;
  for (const [item] of state.placements) {
    const primary = primaryPlacement(state, item);
    if (!primary) continue;
    if (state.items.get(item)?.kind === "note") notes += 1;
    // Builds, rebuilds and humans decide the rest; PLACE decides auto, gate and fallback.
    if (primary.needsVector || !placeDecisions.has(primary.decidedBy)) continue;
    decided += 1;
    if (primary.decidedBy === "fallback" && !primary.needsGate && !primary.needsSplitCheck) {
      unadmitted += 1;
    }
  }
  let ls = 0;
  let n = 0;
  walkTopics(state, (node) => {
    if (node.children.length > 0 || node.id === state.rootId || node.stats.n === 0) return;
    ls += norm(node.stats.ls);
    n += node.stats.n;
  });
  return {
    notes,
    leafCoherence: n > 0 ? ls / n : null,
    decidedSinceBuild: decided,
    unadmitted
  };
}

export type RebuildTrigger = "doubling" | "quality-drop" | "unadmitted-burst";
/** Why a tree with topics is rebuilt: its structural configuration changed, or a trigger. */
export type RebuildReason = "config" | RebuildTrigger;

/** The trigger that asks for a rebuild now, or null (see the module comment). */
export function rebuildTrigger(
  signals: StructureSignals,
  baseline: BuildBaseline,
  config: TopicTreeConfig
): RebuildTrigger | null {
  const { rebuild } = config;
  if (
    baseline.notes > 0 &&
    signals.notes >= 2 * baseline.notes &&
    signals.notes <= rebuild.doublingMaxItems
  ) {
    return "doubling";
  }
  if (
    baseline.leafCoherence !== null &&
    signals.leafCoherence !== null &&
    baseline.leafCoherence - signals.leafCoherence >= rebuild.qualityDrop
  ) {
    return "quality-drop";
  }
  if (
    signals.unadmitted >= rebuild.unadmittedBurstMinItems &&
    signals.decidedSinceBuild > 0 &&
    signals.unadmitted / signals.decidedSinceBuild >= rebuild.unadmittedBurstShare
  ) {
    return "unadmitted-burst";
  }
  return null;
}

/**
 * Whether a rebuild waits for the owner (D29): a structural configuration change only when it
 * touches protected structure (D39); a trigger rebuild also when it re-paths a large share.
 */
export function rebuildNeedsReview(
  reason: RebuildReason,
  review: { largeShare: boolean; protectedTouched: boolean }
): boolean {
  return review.protectedTouched || (reason !== "config" && review.largeShare);
}

// ---------------------------------------------------------------------------
// Protected subtrees in a rebuild

/** The top-most live protected (human or pinned) topics below the root, in content-anchor order. */
export function protectedSubtrees(state: TopicTreeState): string[] {
  const output: string[] = [];
  const visit = (id: string): void => {
    for (const child of getTopic(state, id).children) {
      if (isProtected(getTopic(state, child))) output.push(child);
      else visit(child);
    }
  };
  visit(state.rootId);
  const anchors = new Map(output.map((id) => [id, contentAnchor(state, id)]));
  return output.sort(
    (a, b) =>
      compareStrings(anchors.get(a) as string, anchors.get(b) as string) || compareStrings(a, b)
  );
}

/** A protected subtree kept whole by a rebuild and the clustered rows it holds. */
export interface FrozenSubtree {
  topicId: string;
  rows: number[];
}

/**
 * The rows of each protected subtree (frozen groups of the clustering request), in content-key
 * order; subtrees that hold no clustered row are left out (the rebuild does not touch them).
 */
export function frozenSubtrees(
  state: TopicTreeState,
  rowOf: ReadonlyMap<ItemKey, number>,
  topicIds: readonly string[] = protectedSubtrees(state)
): FrozenSubtree[] {
  const output: FrozenSubtree[] = [];
  for (const topicId of topicIds) {
    const rows: number[] = [];
    const visit = (id: string): void => {
      const node = getTopic(state, id);
      for (const item of node.items) {
        const row = rowOf.get(item);
        if (row !== undefined) rows.push(row);
      }
      for (const child of node.children) visit(child);
    };
    visit(topicId);
    if (rows.length > 0) output.push({ topicId, rows: rows.sort((a, b) => a - b) });
  }
  return output;
}

/**
 * The rebuild partition (rebuild-map.ts) of a clustering result: rows become item keys, and the
 * node that holds each frozen group is replaced by the protected subtree as it is (its topics,
 * each with its own direct items), so the mapping matches those topics to themselves and leaves
 * them untouched. Keys are renumbered in pre-order.
 */
export function rebuildPartitionOf(
  nodes: readonly RowPartitionNode[],
  rowKeys: readonly ItemKey[],
  options: {
    state?: TopicTreeState;
    frozen?: readonly FrozenSubtree[];
    /** Node key of each frozen group, in `frozen` order (the worker's `frozenNodes`). */
    frozenNodes?: readonly number[];
  } = {}
): RebuildPartitionNode[] {
  const children = new Map<number, number[]>();
  const byKey = new Map<number, RowPartitionNode>();
  let root: RowPartitionNode | null = null;
  for (const node of nodes) {
    byKey.set(node.key, node);
    if (node.parent === null) root = node;
    else children.set(node.parent, [...(children.get(node.parent) ?? []), node.key]);
  }
  if (!root) throw new Error("The clustering result has no root");
  const frozenAt = new Map<number, FrozenSubtree>();
  (options.frozenNodes ?? []).forEach((key, index) => {
    const group = options.frozen?.[index];
    if (group) frozenAt.set(key, group);
  });
  const rowSet = new Map<ItemKey, number>(rowKeys.map((key, row) => [key, row]));
  const output: RebuildPartitionNode[] = [];
  const keyOf = (row: number): ItemKey => {
    const key = rowKeys[row];
    if (key === undefined) throw new Error(`Row ${row} has no item`);
    return key;
  };
  const emitSubtree = (topicId: string, parent: number): void => {
    const state = options.state as TopicTreeState;
    const node = getTopic(state, topicId);
    const key = output.length;
    output.push({
      key,
      parent,
      items: node.items.filter((item) => rowSet.has(item))
    });
    for (const child of node.children) emitSubtree(child, key);
  };
  const emit = (node: RowPartitionNode, parent: number | null): void => {
    const frozen = frozenAt.get(node.key);
    if (frozen && parent !== null && options.state) {
      emitSubtree(frozen.topicId, parent);
      return;
    }
    const key = output.length;
    output.push({ key, parent, items: node.items.map(keyOf) });
    for (const child of children.get(node.key) ?? []) emit(byKey.get(child)!, key);
  };
  emit(root, null);
  return output;
}
