// Topic statistics (D7): per topic, N (items in the subtree that count, D8) and LS (the sum of
// their unit vectors); centroid = LS/|LS|, coherence m = |LS|/N, spread s = the standard deviation
// of member cosines to the centroid. Admission to a topic is cos >= max(a_min, m - z * max(s, floor)).
//
// The exact recompute is bit-stable: a topic sums its children's LS in topic-ID order, then its
// direct items in content-key order. In-memory add/subtract along a path is used only inside one
// engine run and in replay; anything persisted comes from the exact recompute.
import type { TopicTreeConfig } from "./config.js";
import { compareStrings } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { getTopic, pathOf, subtreeItems, walkTopics } from "./state.js";
import type { TopicNode, TopicStats, TopicTreeState } from "./state.js";
import { addRow, addVec, dotAt, dotRowVec, norm } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

/**
 * Whether an item counts toward N and LS: every note, and a root source only while none of its
 * notes has a primary placement (D8).
 */
export function countsInStats(state: TopicTreeState, item: ItemKey): boolean {
  const entry = state.items.get(item);
  if (!entry) return false;
  return entry.kind === "note" || !state.placedNotesBySource.has(item);
}

/** The vector row of an item that counts, or undefined (not counting, or no current vector). */
export function statsRow(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  item: ItemKey
): number | undefined {
  return countsInStats(state, item) ? vectors.rowOf(item) : undefined;
}

export function updateCentroid(stats: TopicStats): void {
  const length = norm(stats.ls);
  for (let k = 0; k < stats.centroid.length; k += 1) {
    stats.centroid[k] = length > 0 ? (stats.ls[k] as number) / length : 0;
  }
}

/** m: mean member cosine to the centroid, |LS|/N. */
export function coherenceOf(stats: TopicStats): number {
  return stats.n > 0 ? norm(stats.ls) / stats.n : 0;
}

/** s: standard deviation of member cosines to the centroid. */
export function spreadOf(stats: TopicStats): number {
  if (stats.n === 0) return 0;
  const mean = coherenceOf(stats);
  return Math.sqrt(Math.max(0, stats.cosSqSum / stats.n - mean * mean));
}

/**
 * Mean member cosine used for admission: |LS|/N, or its leave-one-out estimate
 * (|LS|^2/N - 1) / sqrt(|LS|^2 (1 - 2/N) + 1) when configured (a new item is out of sample).
 */
export function admissionMean(stats: TopicStats, config: TopicTreeConfig): number {
  const mean = coherenceOf(stats);
  if (!config.placement.leaveOneOutMean || stats.n < 2) return mean;
  const squared = (mean * stats.n) ** 2;
  return (squared / stats.n - 1) / Math.sqrt(Math.max(1e-12, squared * (1 - 2 / stats.n) + 1));
}

/**
 * Node-relative admission threshold max(a_min, m - z * max(s, floor)). Internal nodes mix their
 * subtopics, so their rule relaxes to the configured lower percentile of member cosines when that
 * is lower; leaves also honor the leaf-only floor. An empty topic admits nothing.
 */
export function admissionThreshold(node: TopicNode, config: TopicTreeConfig): number {
  const { stats } = node;
  if (stats.n === 0) return Number.POSITIVE_INFINITY;
  const { admissionFloor, leafFloor, spreadFactor, spreadFloor, internalPercentile } =
    config.placement;
  let threshold =
    admissionMean(stats, config) - spreadFactor * Math.max(spreadFloor, spreadOf(stats));
  const percentile = stats.lowCosPercentiles[Math.round(internalPercentile * 100)];
  if (node.children.length > 0 && internalPercentile > 0 && percentile !== undefined) {
    threshold = Math.min(threshold, percentile);
  }
  return Math.max(admissionFloor, node.children.length === 0 ? leafFloor : 0, threshold);
}

/** Exact N, LS and centroid of one topic from its children (ID order) and direct items. */
export function recomputeTopic(state: TopicTreeState, vectors: ItemVectorSource, id: string): void {
  const node = getTopic(state, id);
  const { stats } = node;
  stats.ls.fill(0);
  stats.n = 0;
  for (const childId of [...node.children].sort(compareStrings)) {
    const child = getTopic(state, childId);
    stats.n += child.stats.n;
    addVec(stats.ls, child.stats.ls);
  }
  for (const item of node.items) {
    const row = statsRow(state, vectors, item);
    if (row === undefined) continue;
    stats.n += 1;
    addRow(stats.ls, vectors.matrix, row);
  }
  updateCentroid(stats);
}

/** Exact squared-cosine sum and low percentiles of member cosines (O(N * dim)). */
export function refreshSpread(state: TopicTreeState, vectors: ItemVectorSource, id: string): void {
  const { stats } = getTopic(state, id);
  const { matrix } = vectors;
  const cosines: number[] = [];
  let sum = 0;
  for (const item of subtreeItems(state, id)) {
    const row = statsRow(state, vectors, item);
    if (row === undefined) continue;
    const cos = dotAt(matrix.data, row * matrix.dim, stats.centroid, 0, matrix.dim);
    cosines.push(cos);
    sum += cos * cos;
  }
  stats.cosSqSum = sum;
  const sorted = Float32Array.from(cosines).sort();
  stats.lowCosPercentiles =
    sorted.length === 0
      ? new Float32Array(0)
      : Float32Array.from({ length: 11 }, (_, percent) => {
          const index = Math.min(sorted.length - 1, Math.floor((percent / 100) * sorted.length));
          return sorted[index] as number;
        });
}

/** Exact N, LS and centroid of `id` and its ancestors (its children must be current). */
export function recomputeUp(state: TopicTreeState, vectors: ItemVectorSource, id: string): void {
  for (const topicId of pathOf(state, id).reverse()) recomputeTopic(state, vectors, topicId);
}

/** Exact statistics, spreads included, for the live subtree of `id` (default: the whole tree). */
export function recomputeSubtree(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  id: string = state.rootId
): void {
  const node = getTopic(state, id);
  for (const child of node.children) recomputeSubtree(state, vectors, child);
  recomputeTopic(state, vectors, id);
  refreshSpread(state, vectors, id);
  node.control.dirty = false;
}

/**
 * Exact statistics of every topic on the paths from the given topics to the root, bottom-up,
 * spreads included: what a change-set that touched these topics requires (D7).
 */
export function recomputePaths(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  topicIds: Iterable<string>
): void {
  const depth = new Map<string, number>();
  for (const id of topicIds) {
    if (!state.topics.has(id)) continue;
    pathOf(state, id).forEach((topicId, index) => depth.set(topicId, index));
  }
  const ordered = [...depth.keys()].sort(
    (a, b) => (depth.get(b) as number) - (depth.get(a) as number) || compareStrings(a, b)
  );
  for (const id of ordered) recomputeTopic(state, vectors, id);
  for (const id of ordered) {
    refreshSpread(state, vectors, id);
    getTopic(state, id).control.dirty = false;
  }
}

/**
 * In-memory insert: adds an item's vector along the path of `topicId` (N, LS, centroid, and an
 * approximate squared-cosine sum). It does not apply the D8 source rule; callers that place the
 * first note of a counted root source subtract the source first.
 */
export function addItemToPath(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  item: ItemKey,
  topicId: string
): void {
  const row = statsRow(state, vectors, item);
  if (row === undefined) return;
  for (const id of pathOf(state, topicId)) {
    const { stats } = getTopic(state, id);
    stats.n += 1;
    addRow(stats.ls, vectors.matrix, row);
    updateCentroid(stats);
    const cos = dotRowVec(vectors.matrix, row, stats.centroid);
    stats.cosSqSum += cos * cos;
  }
}

/** In-memory removal: subtracts an item's vector along the path of `topicId`. */
export function subtractItemFromPath(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  item: ItemKey,
  topicId: string
): void {
  const row = statsRow(state, vectors, item);
  if (row === undefined) return;
  for (const id of pathOf(state, topicId)) {
    const { stats } = getTopic(state, id);
    const cos = dotRowVec(vectors.matrix, row, stats.centroid);
    stats.cosSqSum = Math.max(0, stats.cosSqSum - cos * cos);
    stats.n -= 1;
    addRow(stats.ls, vectors.matrix, row, -1);
    updateCentroid(stats);
  }
}

/** Cosine of an item to the centroid of its primary topic (its centrality), when both exist. */
export function itemCentrality(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  item: ItemKey,
  topicId: string
): number | null {
  const row = vectors.rowOf(item);
  const { stats } = getTopic(state, topicId);
  if (row === undefined || stats.n === 0) return null;
  return dotRowVec(vectors.matrix, row, stats.centroid);
}

function float64Hex(values: Float64Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

/**
 * Canonical dump of N and the exact bits of LS for every live topic, sorted by ID: two states
 * whose statistics are bit-equal produce equal dumps.
 */
export function statsDump(state: TopicTreeState): string {
  const rows: [string, number, string][] = [];
  walkTopics(state, (node) => rows.push([node.id, node.stats.n, float64Hex(node.stats.ls)]));
  rows.sort((a, b) => compareStrings(a[0], b[0]));
  return JSON.stringify(rows);
}
