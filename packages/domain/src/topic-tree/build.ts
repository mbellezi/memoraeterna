// Batch builders and shape operations (ported from Spike B).
//
// Builders: the Louvain builder over a cosine kNN graph (the Spike B winner; the community
// detector is injected, so this package stays free of graphology) and the top-down and bottom-up
// comparators. Each builds a fresh state over matrix rows (`row:<n>` keys, counter topic IDs) and
// finishes with a forced shape-repair pass so the tree honors I3-I6.
//
// Shape operations (leaf split, internal split, push-down, merge, dissolve, collapse, lift,
// absorb) change the state only through the editor, so every one of them emits invertible
// structure events. They implement mechanics only: protection, freeze, budgets and acceptance are
// REBALANCE policy and are decided by its caller. Random choices derive from the seed, a seed
// label and the tree clock; the default label is the topic's content anchor (D22), builds use the
// topic ID (Spike B parity).
import { defaultTopicTreeConfig } from "./config.js";
import type { TopicTreeConfig } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import type { TopicTreeEditor } from "./events.js";
import { compareStrings, rowContentHash, rowItemKey, rowOfItemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { groupsOf, sphericalKMeans } from "./kmeans.js";
import { knnGraph } from "./knn.js";
import type { KnnGraph } from "./knn.js";
import { createRng, deriveSeed } from "./rng.js";
import {
  createTopicTreeState,
  depthOf,
  getItem,
  getTopic,
  heightOf,
  isLive,
  liveTopicIds,
  pathOf,
  placementRecord,
  placementsOf,
  registerItem,
  resolveTopicId,
  subtreeItems,
  walkTopics
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import {
  addItemToPath,
  recomputeSubtree,
  recomputeTopic,
  recomputeUp,
  refreshSpread,
  subtractItemFromPath
} from "./stats.js";
import { addRow, dot, dotAt, matrixFromRows, rowVectors, unit } from "./vectors.js";
import type { EmbeddingMatrix, ItemVectorSource } from "./vectors.js";

/** Timestamp recorded by builds (build states never leave the builder with their topic IDs). */
export const buildTimestamp = "1970-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Split planning

export interface SplitPlan {
  k: number;
  minSize: number;
  maxSize: number;
}

/**
 * How to split `n` items at `depth`. The small-n rule: a set of at most leaf.max items (or one at
 * the depth cap) stays one leaf (the bootstrap decides 2-4-way splits of small libraries); a
 * last-level split prefers fanOut.targetMin leaves while they still average leaf.minForTargetFanOut
 * items. Larger sets get k so that k^levels ~ n / leaf.target, and the root aims at
 * fanOut.rootTarget Areas.
 */
export function planSplit(n: number, depth: number, config: TopicTreeConfig): SplitPlan | null {
  const { leaf, fanOut } = config;
  const levelsLeft = config.depth.cap - depth;
  if (n <= leaf.max || levelsLeft <= 0) return null;
  const leavesNeeded = n / leaf.target;
  if (n <= leaf.max * fanOut.targetMax || levelsLeft <= 1) {
    let k = Math.max(2, Math.round(leavesNeeded), Math.ceil(n / leaf.max));
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

// ---------------------------------------------------------------------------
// Shape operations

export type ShapeOperationKind =
  | "leaf-split"
  | "internal-split"
  | "push-down"
  | "merge"
  | "dissolve"
  | "collapse"
  | "lift"
  | "absorb-direct";

export interface ShapeOperation {
  kind: ShapeOperationKind;
  /** The topic the operation was applied to (for a lift: the topic that adopted children). */
  topicId: string;
  created: string[];
  retired: string[];
  /** Items whose direct topic changed. */
  movedItems: number;
  /** Tree clock when it ran. */
  clock: number;
}

export interface ShapeContext {
  readonly state: TopicTreeState;
  readonly vectors: ItemVectorSource;
  readonly config: TopicTreeConfig;
  readonly seed: number;
  /** Applies (and logs) every change as a structure event. */
  readonly editor: TopicTreeEditor;
  /** IDs for new topics (UUIDs in the product, counters in builds). */
  readonly newTopicId: () => string;
  /** Timestamp of retirements and of "moved from" hints. */
  readonly now: string;
  /** Seed label of a topic; default: its content anchor (D22). */
  readonly seedLabel?: (topicId: string) => string;
  /** Re-places an item from `from` downwards: the topic below `from` it is admitted to, or null. */
  readonly readmit?: (item: ItemKey, from: string) => string | null;
  /** Record "moved from" hints on the items an operation moves (off in builds). */
  readonly markMoves?: boolean;
}

export interface RepairOptions {
  /** Ignore cooldowns and the churn budget (builds and explicit settle passes). */
  force: boolean;
}

/** Content anchor of a topic: the smallest content hash in its subtree (stable across fresh UUIDs). */
export function contentAnchor(state: TopicTreeState, topicId: string): string {
  let anchor: string | null = null;
  for (const item of subtreeItems(state, topicId)) {
    const hash = getItem(state, item).contentHash;
    if (anchor === null || compareStrings(hash, anchor) < 0) anchor = hash;
  }
  return anchor ?? `empty:${topicId}`;
}

function labelOf(context: ShapeContext, topicId: string): string {
  return context.seedLabel ? context.seedLabel(topicId) : contentAnchor(context.state, topicId);
}

function isLiveTopic(state: TopicTreeState, id: string): boolean {
  const node = state.topics.get(id);
  return node !== undefined && isLive(node);
}

function centroidOf(state: TopicTreeState, id: string): Float32Array {
  return getTopic(state, id).stats.centroid;
}

function createChild(context: ShapeContext, parentId: string): string {
  const id = context.newTopicId();
  context.editor.createTopic(id, parentId);
  return id;
}

/** Moves primary items between topics (statistics are refreshed by the caller). */
function moveItems(
  context: ShapeContext,
  from: string,
  to: string,
  items: readonly ItemKey[]
): void {
  const hint = context.markMoves ? { movedFromTopicId: from, movedAt: context.now } : {};
  for (const item of items) context.editor.updatePlacement(item, 0, { topicId: to, ...hint });
}

/**
 * Moves the secondary placements of a topic that is about to retire to `to`, or drops them where
 * `to` would break I2 (already placed there, or on the primary path).
 */
function evacuateSecondaries(context: ShapeContext, from: string, to: string): void {
  const { state, editor } = context;
  for (const item of [...getTopic(state, from).secondaryItems]) {
    const placements = placementsOf(state, item);
    const secondary = placements.find((placement) => placement.topicId === from);
    if (!secondary) continue;
    const primary = placements.find((placement) => placement.rank === 0);
    const blocked =
      placements.some((placement) => placement.topicId === to) ||
      (primary !== undefined && pathOf(state, primary.topicId).includes(to));
    if (blocked) editor.unplaceItem(item, secondary.rank);
    else editor.updatePlacement(item, secondary.rank, { topicId: to });
  }
}

function retire(context: ShapeContext, id: string, survivor: string): void {
  evacuateSecondaries(context, id, survivor);
  context.editor.retireTopic(id, survivor, context.now);
}

/** Exact statistics for new or restructured topics, then the path above `ancestorsOf`. */
function refresh(context: ShapeContext, ids: readonly string[], ancestorsOf: string | null): void {
  const { state, vectors } = context;
  for (const id of ids) {
    if (!isLiveTopic(state, id)) continue;
    recomputeTopic(state, vectors, id);
    refreshSpread(state, vectors, id);
  }
  if (ancestorsOf !== null && isLiveTopic(state, ancestorsOf)) {
    recomputeUp(state, vectors, ancestorsOf);
    refreshSpread(state, vectors, ancestorsOf);
  }
}

function finish(
  context: ShapeContext,
  operation: Omit<ShapeOperation, "clock">,
  touched: readonly string[]
): ShapeOperation {
  const { state } = context;
  for (const id of touched) {
    if (isLiveTopic(state, id)) getTopic(state, id).control.repairClock = state.clock;
  }
  return { ...operation, clock: state.clock };
}

/** Balanced k-means partition of items (content-key order in, largest group first out). */
function partition(
  context: ShapeContext,
  items: readonly ItemKey[],
  k: number,
  label: string
): ItemKey[][] {
  const { config, state, vectors } = context;
  if (k <= 1) return [[...items]];
  const placed: ItemKey[] = [];
  const rows: number[] = [];
  const withoutVector: ItemKey[] = [];
  for (const item of items) {
    const row = vectors.rowOf(item);
    if (row === undefined) withoutVector.push(item);
    else {
      placed.push(item);
      rows.push(row);
    }
  }
  if (rows.length < 2) return [[...items]];
  const result = sphericalKMeans(vectors.matrix, rows, {
    k,
    seed: deriveSeed(context.seed, `${label}:${state.clock}`),
    maxIterations: config.kmeans.maxIterations,
    tolerance: config.kmeans.tolerance,
    minSize: Math.max(config.leaf.min, Math.floor((0.4 * rows.length) / k)),
    maxSize: config.leaf.max
  });
  const groups = groupsOf(result, placed).sort((a, b) => b.length - a.length);
  groups[0]?.push(...withoutVector);
  return groups;
}

/**
 * Splits an oversized leaf with balanced spherical k-means: sideways under its parent when there
 * is room (the leaf keeps its largest part, so most items keep their path); a root leaf, or a leaf
 * under a full parent, splits downward so the overflow does not cascade upward.
 */
export function splitLeaf(context: ShapeContext, leafId: string): ShapeOperation | null {
  const { state, config } = context;
  const leaf = getTopic(state, leafId);
  const size = leaf.items.length;
  if (size <= config.leaf.max || leaf.children.length > 0) return null;
  const parentFull =
    leaf.parentId !== null && getTopic(state, leaf.parentId).children.length >= config.fanOut.max;
  const sideways =
    leaf.parentId !== null && (!parentFull || depthOf(state, leafId) + 1 > config.depth.cap);
  let k = Math.max(2, Math.round(size / config.leaf.target), Math.ceil(size / config.leaf.max));
  if (!sideways) {
    k = Math.max(k, Math.min(config.fanOut.targetMin, Math.floor(size / config.leaf.min)));
  }
  const groups = partition(context, leaf.items, k, `split:${labelOf(context, leafId)}`);
  if (groups.length < 2) return null;
  const created: string[] = [];
  let moved = 0;
  if (sideways && leaf.parentId !== null) {
    const parentId = leaf.parentId;
    for (const group of groups.slice(1)) {
      const sibling = createChild(context, parentId);
      moveItems(context, leafId, sibling, group);
      created.push(sibling);
      moved += group.length;
    }
    refresh(context, [leafId, ...created], parentId);
  } else {
    for (const group of groups) {
      const child = createChild(context, leafId);
      moveItems(context, leafId, child, group);
      created.push(child);
      moved += group.length;
    }
    refresh(context, created, leafId);
  }
  return finish(
    context,
    { kind: "leaf-split", topicId: leafId, created, retired: [], movedItems: moved },
    [leafId, ...created]
  );
}

/**
 * Fan-out overflow on a non-root topic, B-tree style: its children are split in two by balanced
 * k-means over their centroids; it keeps the heavier half and a new sibling takes the other.
 * Depth does not grow.
 */
export function splitInternal(context: ShapeContext, topicId: string): ShapeOperation | null {
  const { state, config } = context;
  const node = getTopic(state, topicId);
  const fanOut = node.children.length;
  if (node.parentId === null || fanOut <= config.fanOut.max) return null;
  const parentId = node.parentId;
  const children = [...node.children];
  const indices = children.map((_, index) => index);
  const minSize = Math.max(config.fanOut.min, Math.floor(fanOut * 0.3));
  const result = sphericalKMeans(
    matrixFromRows(
      children.map((child) => centroidOf(state, child)),
      false
    ),
    indices,
    {
      k: 2,
      seed: deriveSeed(context.seed, `isplit:${labelOf(context, topicId)}:${state.clock}`),
      maxIterations: config.kmeans.maxIterations,
      weights: children.map((child) => getTopic(state, child).stats.n),
      minSize,
      maxSize: fanOut - minSize
    }
  );
  const groups = groupsOf(result, indices);
  if (groups.length < 2) return null;
  const weightOf = (group: number[]): number =>
    group.reduce((total, index) => total + getTopic(state, children[index] as string).stats.n, 0);
  groups.sort((a, b) => weightOf(b) - weightOf(a));
  const sibling = createChild(context, parentId);
  let moved = 0;
  for (const index of groups[1] ?? []) {
    const child = children[index] as string;
    context.editor.moveTopic(child, sibling);
    moved += getTopic(state, child).stats.n;
  }
  refresh(context, [topicId, sibling], parentId);
  return finish(
    context,
    { kind: "internal-split", topicId, created: [sibling], retired: [], movedItems: moved },
    [topicId, sibling]
  );
}

/**
 * Fan-out overflow on the root, or on a topic whose parent is full: groups the children under new
 * intermediate topics (the topic keeps its ID; its subtree changes path). Children whose subtree
 * would cross the depth cap stay where they are.
 */
export function pushDown(context: ShapeContext, topicId: string): ShapeOperation | null {
  const { state, config } = context;
  const node = getTopic(state, topicId);
  const fanOut = node.children.length;
  if (fanOut <= config.fanOut.max) return null;
  const depth = depthOf(state, topicId);
  const children = node.children.filter(
    (child) => depth + 2 + heightOf(state, child) <= config.depth.cap
  );
  if (children.length < 2 * config.fanOut.min) return null;
  const groupCount = Math.min(
    config.fanOut.targetMax,
    Math.max(2, Math.round(children.length / config.repair.pushDownGroupSize))
  );
  const indices = children.map((_, index) => index);
  const result = sphericalKMeans(
    matrixFromRows(
      children.map((child) => centroidOf(state, child)),
      false
    ),
    indices,
    {
      k: groupCount,
      seed: deriveSeed(context.seed, `push:${labelOf(context, topicId)}:${state.clock}`),
      maxIterations: config.kmeans.maxIterations,
      weights: children.map((child) => getTopic(state, child).stats.n),
      minSize: config.fanOut.min,
      maxSize: config.fanOut.max
    }
  );
  const created: string[] = [];
  for (const group of groupsOf(result, indices)) {
    if (group.length < 2) continue;
    const intermediate = createChild(context, topicId);
    for (const index of group) context.editor.moveTopic(children[index] as string, intermediate);
    created.push(intermediate);
  }
  if (created.length === 0) return null;
  refresh(context, created, topicId);
  return finish(context, { kind: "push-down", topicId, created, retired: [], movedItems: 0 }, [
    topicId,
    ...created
  ]);
}

/**
 * A leaf below the minimum merges into its most similar sibling leaf when the result stays at or
 * below mergeMaxSize; otherwise its items move up to the parent as direct items. An empty leaf is
 * dissolved. The merged leaf retires with a redirect to the topic that took its items.
 */
export function mergeTinyLeaf(context: ShapeContext, leafId: string): ShapeOperation | null {
  const { state, config } = context;
  const leaf = getTopic(state, leafId);
  if (leaf.parentId === null || leaf.children.length > 0) return null;
  const size = leaf.items.length;
  if (size >= config.leaf.min) return null;
  const parentId = leaf.parentId;
  if (size === 0) {
    retire(context, leafId, parentId);
    refresh(context, [], parentId);
    return finish(
      context,
      { kind: "dissolve", topicId: leafId, created: [], retired: [leafId], movedItems: 0 },
      [parentId]
    );
  }
  let target = parentId;
  let best = -Infinity;
  for (const siblingId of getTopic(state, parentId).children) {
    const sibling = getTopic(state, siblingId);
    if (siblingId === leafId || sibling.children.length > 0) continue;
    if (sibling.items.length + size > config.repair.mergeMaxSize) continue;
    const similarity = dot(sibling.stats.centroid, leaf.stats.centroid);
    if (similarity > best) {
      best = similarity;
      target = siblingId;
    }
  }
  const items = [...leaf.items];
  moveItems(context, leafId, target, items);
  retire(context, leafId, target);
  refresh(context, target === parentId ? [] : [target], parentId);
  return finish(
    context,
    { kind: "merge", topicId: leafId, created: [], retired: [leafId], movedItems: items.length },
    [target, parentId]
  );
}

/** A topic with exactly one child and no direct items absorbs that child. */
export function collapseChain(context: ShapeContext, topicId: string): ShapeOperation | null {
  const { state } = context;
  const node = getTopic(state, topicId);
  if (node.children.length !== 1 || node.items.length > 0) return null;
  const childId = node.children[0] as string;
  const child = getTopic(state, childId);
  for (const grandchild of [...child.children]) context.editor.moveTopic(grandchild, topicId);
  const items = [...child.items];
  moveItems(context, childId, topicId, items);
  retire(context, childId, topicId);
  refresh(context, [topicId], topicId);
  return finish(
    context,
    { kind: "collapse", topicId, created: [], retired: [childId], movedItems: items.length },
    [topicId]
  );
}

/**
 * A thin internal topic (fan-out below the target, no direct items) dissolves into its parent when
 * the parent's fan-out stays within the target: its children move up one level and it retires with
 * a redirect to the parent.
 */
export function liftIntoParent(
  context: ShapeContext,
  topicId: string,
  maxMoved = Number.POSITIVE_INFINITY
): ShapeOperation | null {
  const { state, config } = context;
  const node = getTopic(state, topicId);
  if (node.parentId === null || node.children.length === 0 || node.items.length > 0) return null;
  if (node.children.length >= config.fanOut.targetMin || node.stats.n > maxMoved) return null;
  const parentId = node.parentId;
  if (
    getTopic(state, parentId).children.length - 1 + node.children.length >
    config.fanOut.targetMax
  ) {
    return null;
  }
  const moved = node.stats.n;
  for (const child of [...node.children]) context.editor.moveTopic(child, parentId);
  retire(context, topicId, parentId);
  refresh(context, [parentId], parentId);
  return finish(
    context,
    { kind: "lift", topicId: parentId, created: [], retired: [topicId], movedItems: moved },
    [parentId]
  );
}

/**
 * A topic below the fan-out target adopts the children of one internal child (the one with the
 * fewest children, then the fewest items), which retires with a redirect, as long as its fan-out
 * stays within the target. Children holding direct items are kept.
 */
export function liftThinNode(
  context: ShapeContext,
  topicId: string,
  maxMoved = Number.POSITIVE_INFINITY
): ShapeOperation | null {
  const { state, config } = context;
  const node = getTopic(state, topicId);
  const fanOut = node.children.length;
  if (fanOut === 0 || fanOut >= config.fanOut.targetMin) return null;
  let best: string | null = null;
  let bestChildren = Infinity;
  let bestN = Infinity;
  for (const childId of node.children) {
    const child = getTopic(state, childId);
    if (child.children.length === 0 || child.items.length > 0 || child.stats.n > maxMoved) continue;
    if (fanOut - 1 + child.children.length > config.fanOut.targetMax) continue;
    if (
      child.children.length < bestChildren ||
      (child.children.length === bestChildren && child.stats.n < bestN)
    ) {
      best = childId;
      bestChildren = child.children.length;
      bestN = child.stats.n;
    }
  }
  if (best === null) return null;
  const moved = getTopic(state, best).stats.n;
  for (const grandchild of [...getTopic(state, best).children]) {
    context.editor.moveTopic(grandchild, topicId);
  }
  retire(context, best, topicId);
  refresh(context, [topicId], topicId);
  return finish(
    context,
    { kind: "lift", topicId, created: [], retired: [best], movedItems: moved },
    [topicId]
  );
}

/**
 * Direct items piling up on an internal topic: each is re-admitted below it when possible; once
 * enough remain, they form new leaf children. A lone item never creates a topic.
 */
export function absorbDirectItems(context: ShapeContext, topicId: string): ShapeOperation | null {
  const { state, config, vectors } = context;
  const node = getTopic(state, topicId);
  if (node.children.length === 0 || node.items.length < config.repair.directItemsSplitAt) {
    return null;
  }
  let moved = 0;
  if (context.readmit) {
    for (const item of [...node.items]) {
      const target = context.readmit(item, topicId);
      if (target === null || target === topicId) continue;
      subtractItemFromPath(state, vectors, item, topicId);
      moveItems(context, topicId, target, [item]);
      addItemToPath(state, vectors, item, target);
      moved += 1;
    }
  }
  const created: string[] = [];
  const remaining = [...node.items];
  const k = Math.max(
    1,
    Math.round(remaining.length / config.leaf.target),
    Math.ceil(remaining.length / config.leaf.max)
  );
  // New leaves must leave a way to repair the fan-out (a local push-down within the depth cap).
  // The root never grows past fanOut.max this way, because its only repair would re-path every
  // item; its leftover items stay Unsorted until a rebuild.
  const room =
    node.children.length + k <= config.fanOut.max ||
    (node.parentId !== null && depthOf(state, topicId) + 2 <= config.depth.cap);
  if (remaining.length >= config.repair.directItemsSplitAt && room) {
    for (const group of partition(context, remaining, k, `absorb:${labelOf(context, topicId)}`)) {
      const leaf = createChild(context, topicId);
      moveItems(context, topicId, leaf, group);
      created.push(leaf);
      moved += group.length;
    }
    refresh(context, created, topicId);
  }
  if (moved === 0) return null;
  return finish(
    context,
    { kind: "absorb-direct", topicId, created, retired: [], movedItems: moved },
    [topicId, ...created]
  );
}

/**
 * Checks one topic and applies at most one operation. Hard violations (a leaf above leaf.hardMax,
 * fan-out above fanOut.hardMax) ignore the cooldown; soft overflow respects the churn budget
 * (softMoveShare of all items) unless forced.
 */
export function repairTopic(
  context: ShapeContext,
  topicId: string,
  options: RepairOptions
): ShapeOperation | null {
  const { state, config } = context;
  if (!isLiveTopic(state, topicId)) return null;
  const node = getTopic(state, topicId);
  const repairClock = node.control.repairClock;
  const cooled =
    options.force ||
    repairClock === null ||
    state.clock - repairClock >= config.repair.cooldownInserts;
  if (node.children.length === 0) {
    const size = node.items.length;
    if (size > config.leaf.hardMax || (size > config.leaf.max && cooled)) {
      return splitLeaf(context, topicId);
    }
    if (node.parentId !== null && (size === 0 || (size < config.leaf.min && cooled))) {
      return mergeTinyLeaf(context, topicId);
    }
    return null;
  }
  if (node.children.length === 1 && node.items.length === 0) return collapseChain(context, topicId);
  if (node.items.length >= config.repair.directItemsSplitAt && cooled) {
    const operation = absorbDirectItems(context, topicId);
    if (operation) return operation;
  }
  const total = getTopic(state, state.rootId).stats.n;
  const fanOut = node.children.length;
  const hard = fanOut > config.fanOut.hardMax;
  if (hard || (fanOut > config.fanOut.max && cooled)) {
    // Sideways while the parent has room (re-paths about half the subtree); otherwise push down
    // locally (re-paths the subtree), so overflow never cascades to the root.
    const parentFull =
      node.parentId === null || getTopic(state, node.parentId).children.length >= config.fanOut.max;
    const moves = parentFull ? node.stats.n : node.stats.n / 2;
    if (!hard && !options.force && moves > config.repair.softMoveShare * total) return null;
    return parentFull
      ? (pushDown(context, topicId) ?? splitInternal(context, topicId))
      : (splitInternal(context, topicId) ?? pushDown(context, topicId));
  }
  if (fanOut < config.fanOut.targetMin && cooled) {
    const budget = options.force ? Number.POSITIVE_INFINITY : config.repair.softMoveShare * total;
    return liftIntoParent(context, topicId, budget) ?? liftThinNode(context, topicId, budget);
  }
  return null;
}

/** Topics worth re-checking after an operation: the touched topics and their parents. */
export function affectedTopics(state: TopicTreeState, operation: ShapeOperation): string[] {
  const ids = [operation.topicId, ...operation.created];
  for (const retired of operation.retired) {
    if (state.topics.has(retired)) ids.push(resolveTopicId(state, retired));
  }
  const output = new Set<string>();
  for (const id of ids) {
    if (!isLiveTopic(state, id)) continue;
    output.add(id);
    const parent = getTopic(state, id).parentId;
    if (parent !== null) output.add(parent);
  }
  return [...output];
}

/** Repairs until no topic needs an operation (bounded passes; deepest topics first). */
export function repairAll(context: ShapeContext, options: RepairOptions): ShapeOperation[] {
  const log: ShapeOperation[] = [];
  for (let pass = 0; pass < 20; pass += 1) {
    let changed = false;
    for (const id of liveTopicIds(context.state).reverse()) {
      for (let guard = 0; guard < 8; guard += 1) {
        const operation = repairTopic(context, id, options);
        if (!operation) break;
        log.push(operation);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return log;
}

/**
 * Local repair of dirty topics (soft triggers respect cooldowns), re-checking what each operation
 * affected; at most `budget` checks.
 */
export function repairDirty(
  context: ShapeContext,
  dirty: Set<string>,
  budget = 10_000
): ShapeOperation[] {
  const applied: ShapeOperation[] = [];
  let remaining = budget;
  while (dirty.size > 0 && remaining > 0) {
    remaining -= 1;
    const id = dirty.values().next().value as string;
    dirty.delete(id);
    const operation = repairTopic(context, id, { force: false });
    if (!operation) continue;
    applied.push(operation);
    for (const affected of affectedTopics(context.state, operation)) dirty.add(affected);
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Build states

export interface BuildOptions {
  seed: number;
  config?: TopicTreeConfig;
}

export interface BuildTimings {
  knnMs: number;
  communitiesMs: number;
  repairMs: number;
}

/** What the Louvain builder did at the top level (Spike B review: root fan-out stability). */
export interface LouvainDiagnostics {
  /** Communities found for the whole set (after merging tiny ones). */
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
  /** The built tree: counter topic IDs (root "0") and `row:<n>` item keys. */
  state: TopicTreeState;
  vectors: ItemVectorSource;
  /** Operations of the final forced shape-repair pass. */
  repairs: ShapeOperation[];
  timings: BuildTimings;
  /** Louvain builds only. */
  diagnostics?: LouvainDiagnostics;
  /** Louvain builds only: whether the kNN graph was exact. */
  knnExact?: boolean;
}

interface BuildSession {
  context: ShapeContext;
  setItems(topicId: string, rows: readonly number[]): void;
  createTopic(parentId: string): string;
}

function startBuild(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  options: BuildOptions
): BuildSession {
  const config = options.config ?? defaultTopicTreeConfig;
  const state = createTopicTreeState({ dim: matrix.dim, rootId: "0" });
  for (const row of rows) {
    registerItem(state, {
      key: rowItemKey(row),
      kind: "note",
      contentHash: rowContentHash(row),
      rootSource: null
    });
  }
  let nextId = 1;
  const context: ShapeContext = {
    state,
    vectors: rowVectors(matrix),
    config,
    seed: options.seed,
    editor: createTopicTreeEditor(state, { record: false }),
    newTopicId: () => String(nextId++),
    now: buildTimestamp,
    seedLabel: (topicId) => topicId
  };
  return {
    context,
    setItems(topicId, members) {
      const placement = placementRecord(topicId, { decidedBy: "build" });
      for (const row of members) context.editor.placeItem(rowItemKey(row), placement);
    },
    createTopic: (parentId) => createChild(context, parentId)
  };
}

function finishBuild(session: BuildSession, timings: Omit<BuildTimings, "repairMs">): BuildResult {
  const { context } = session;
  const started = performance.now();
  recomputeSubtree(context.state, context.vectors);
  const repairs = repairAll(context, { force: true });
  recomputeSubtree(context.state, context.vectors);
  return {
    state: context.state,
    vectors: context.vectors,
    repairs,
    timings: { ...timings, repairMs: performance.now() - started }
  };
}

function kmeansGroups(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  plan: SplitPlan,
  seed: number,
  config: TopicTreeConfig
): number[][] {
  const result = sphericalKMeans(matrix, rows, {
    k: plan.k,
    seed,
    maxIterations: config.kmeans.maxIterations,
    tolerance: config.kmeans.tolerance,
    minSize: plan.minSize,
    maxSize: plan.maxSize
  });
  return groupsOf(result, rows);
}

// ---------------------------------------------------------------------------
// Top-down recursive balanced build (comparator)

export function buildTopDown(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  options: BuildOptions
): BuildResult {
  const session = startBuild(matrix, rows, options);
  const { config } = session.context;
  const split = (topicId: string, members: number[], depth: number): void => {
    const plan = planSplit(members.length, depth, config);
    if (!plan) {
      session.setItems(topicId, members);
      return;
    }
    const groups = kmeansGroups(
      matrix,
      members,
      plan,
      deriveSeed(options.seed, `td:${topicId}`),
      config
    );
    if (groups.length < 2) {
      session.setItems(topicId, members);
      return;
    }
    for (const group of groups) split(session.createTopic(topicId), group, depth + 1);
  };
  split(session.context.state.rootId, [...rows], 0);
  return finishBuild(session, { knnMs: 0, communitiesMs: 0 });
}

// ---------------------------------------------------------------------------
// Bottom-up Clio-like build (comparator)

interface Cluster {
  rows: number[];
  children: Cluster[];
  ls: Float64Array;
  n: number;
}

/** Leaf clusters of about leaf.target rows (two-level for large inputs, for speed). */
export function leafClusters(
  matrix: EmbeddingMatrix,
  rows: number[],
  config: TopicTreeConfig,
  seed: number
): number[][] {
  const count = Math.max(1, Math.round(rows.length / config.leaf.target));
  if (count <= 1) return [rows];
  if (count <= 64) {
    return groupsOf(
      sphericalKMeans(matrix, rows, {
        k: Math.max(count, Math.ceil(rows.length / config.leaf.max)),
        seed,
        maxIterations: config.kmeans.maxIterations,
        tolerance: config.kmeans.tolerance,
        minSize: config.leaf.min,
        maxSize: config.leaf.max
      }),
      rows
    );
  }
  const coarse = Math.round(Math.sqrt(count));
  const groups = groupsOf(
    sphericalKMeans(matrix, rows, {
      k: coarse,
      seed,
      maxIterations: config.kmeans.maxIterations,
      tolerance: config.kmeans.tolerance,
      minSize: Math.floor((0.3 * rows.length) / coarse),
      maxSize: Math.ceil((2.5 * rows.length) / coarse)
    }),
    rows
  );
  return groups.flatMap((group, index) =>
    leafClusters(matrix, group, config, deriveSeed(seed, `leaf:${index}`))
  );
}

export function buildBottomUp(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  options: BuildOptions
): BuildResult {
  const session = startBuild(matrix, rows, options);
  const { config } = session.context;
  const { childrenTarget, topTopicsMax } = config.bottomUp;
  let level: Cluster[] = leafClusters(
    matrix,
    [...rows],
    config,
    deriveSeed(options.seed, "bu:leaves")
  ).map((members) => {
    const ls = new Float64Array(matrix.dim);
    for (const row of members) addRow(ls, matrix, row);
    return { rows: members, children: [], ls, n: members.length };
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
    const previous = level;
    level = groupsOf(result, indices).map((group) => {
      const children = group.map((index) => previous[index] as Cluster);
      const ls = new Float64Array(matrix.dim);
      let n = 0;
      for (const child of children) {
        for (let d = 0; d < matrix.dim; d += 1) ls[d] = (ls[d] as number) + (child.ls[d] as number);
        n += child.n;
      }
      return { rows: [], children, ls, n };
    });
  }

  const materialize = (topicId: string, cluster: Cluster): void => {
    if (cluster.children.length === 0) session.setItems(topicId, cluster.rows);
    for (const child of cluster.children) materialize(session.createTopic(topicId), child);
  };
  const rootId = session.context.state.rootId;
  if (level.length === 1) materialize(rootId, level[0] as Cluster);
  else for (const cluster of level) materialize(session.createTopic(rootId), cluster);
  return finishBuild(session, { knnMs: 0, communitiesMs: 0 });
}

// ---------------------------------------------------------------------------
// Louvain over the cosine kNN graph (the Spike B winner)

/**
 * An undirected weighted graph for community detection: nodes 0..nodeCount-1, edges with
 * source < target, weight = cosine (at least 1e-6). A detector must add nodes in index order and
 * edges in array order: that order is part of the determinism contract.
 */
export interface CommunityGraph {
  nodeCount: number;
  sources: Int32Array;
  targets: Int32Array;
  weights: Float64Array;
}

/**
 * Community detection (Louvain in the desktop worker, graphology-communities-louvain): returns
 * a community label per node. It must draw randomness only from `rng`.
 */
export type DetectCommunities = (
  graph: CommunityGraph,
  options: { resolution: number; rng: () => number }
) => ArrayLike<number>;

export interface LouvainBuildOptions extends BuildOptions {
  detectCommunities: DetectCommunities;
  /**
   * "legacy" reproduces the root grouping before the Spike B review (acceptance window up to
   * acceptAbove x the target, super-grouping with round(n / 6)); only for before/after runs.
   */
  rootGrouping?: "fixed" | "legacy";
  /** Reuse a precomputed kNN graph over (a superset of) the rows. */
  graph?: KnnGraph;
}

/** The kNN graph restricted to `subset` (matrix rows), as a community graph. */
export function communityGraphOf(
  graph: KnnGraph,
  position: ReadonlyMap<number, number>,
  subset: readonly number[]
): CommunityGraph {
  const local = new Map<number, number>();
  subset.forEach((row, index) => local.set(row, index));
  const sources: number[] = [];
  const targets: number[] = [];
  const weights: number[] = [];
  const edgeIndex = new Map<number, number>();
  subset.forEach((row, index) => {
    const at = position.get(row);
    if (at === undefined) return;
    for (let slot = 0; slot < graph.k; slot += 1) {
      const neighbor = graph.neighbors[at * graph.k + slot] as number;
      if (neighbor < 0) continue;
      const other = local.get(graph.rows[neighbor] as number);
      if (other === undefined || other === index) continue;
      const weight = Math.max(1e-6, graph.sims[at * graph.k + slot] as number);
      const a = Math.min(index, other);
      const b = Math.max(index, other);
      const key = a * subset.length + b;
      const existing = edgeIndex.get(key);
      if (existing === undefined) {
        edgeIndex.set(key, sources.length);
        sources.push(a);
        targets.push(b);
        weights.push(weight);
      } else if ((weights[existing] as number) < weight) {
        weights[existing] = weight;
      }
    }
  });
  return {
    nodeCount: subset.length,
    sources: Int32Array.from(sources),
    targets: Int32Array.from(targets),
    weights: Float64Array.from(weights)
  };
}

function centroidOfRows(matrix: EmbeddingMatrix, members: readonly number[]): Float32Array {
  const ls = new Float64Array(matrix.dim);
  for (const row of members) addRow(ls, matrix, row);
  return unit(ls);
}

/** Folds groups smaller than `minSize` into the most similar remaining group. */
function mergeSmallGroups(
  matrix: EmbeddingMatrix,
  groups: number[][],
  minSize: number
): number[][] {
  const large = groups.filter((group) => group.length >= minSize);
  const small = groups.filter((group) => group.length < minSize);
  if (large.length === 0) return [groups.flat()];
  const centroids = large.map((group) => centroidOfRows(matrix, group));
  for (const group of small) {
    for (const row of group) {
      let best = 0;
      let bestSim = -Infinity;
      centroids.forEach((centroid, index) => {
        const sim = dotAt(matrix.data, row * matrix.dim, centroid, 0, matrix.dim);
        if (sim > bestSim) {
          bestSim = sim;
          best = index;
        }
      });
      large[best]?.push(row);
    }
  }
  return large;
}

export function buildLouvain(
  matrix: EmbeddingMatrix,
  rows: readonly number[],
  options: LouvainBuildOptions
): BuildResult {
  const session = startBuild(matrix, rows, options);
  const { config } = session.context;
  let started = performance.now();
  const graph =
    options.graph ??
    knnGraph(matrix, rows, config.louvain.knn, {
      seed: options.seed,
      exactLimit: config.knn.exactLimit,
      nprobe: config.knn.nprobe
    });
  const knnMs = performance.now() - started;
  const position = new Map(graph.rows.map((row, index) => [row, index]));

  const diagnostics: LouvainDiagnostics = {
    rootCommunities: 0,
    rootChildren: 0,
    rootSuperGrouped: false,
    rootKmeansFallback: false,
    innerSuperGroupings: []
  };
  // Spike B review: at the root the acceptance window stops at fanOut.max and, if no resolution
  // fits, the super-grouping aims at rootTarget (the legacy window let 13 communities through and
  // super-grouped them into 2 Areas).
  const legacyRoot = options.rootGrouping === "legacy";
  const { acceptAbove, acceptBelow, resolutionStep } = config.louvain;
  const acceptMax = (desired: number, depth: number): number =>
    depth === 0 && !legacyRoot
      ? Math.min(desired * acceptAbove, config.fanOut.max)
      : desired * acceptAbove;

  const detect = (members: number[], resolution: number, seed: number): number[][] => {
    const communityGraph = communityGraphOf(graph, position, members);
    const labels =
      communityGraph.sources.length > 0
        ? options.detectCommunities(communityGraph, { resolution, rng: createRng(seed).next })
        : null;
    const groups = new Map<number, number[]>();
    members.forEach((row, local) => {
      const label = labels ? (labels[local] as number | undefined) : undefined;
      const community = label ?? -1 - local;
      const group = groups.get(community) ?? [];
      group.push(row);
      groups.set(community, group);
    });
    return [...groups.values()];
  };

  const communities = (
    members: number[],
    desired: number,
    topicId: string,
    depth: number
  ): number[][] => {
    let resolution = config.louvain.resolution;
    let best: number[][] = [members];
    let bestError = Infinity;
    for (let attempt = 0; attempt < config.louvain.resolutionTries; attempt += 1) {
      const groups = mergeSmallGroups(
        matrix,
        detect(members, resolution, deriveSeed(options.seed, `lv:${topicId}:${attempt}`)),
        config.leaf.min
      );
      const error = Math.abs(Math.log(groups.length / desired));
      if (error < bestError) {
        best = groups;
        bestError = error;
      }
      if (groups.length >= desired * acceptBelow && groups.length <= acceptMax(desired, depth))
        break;
      resolution *= groups.length < desired ? resolutionStep : 1 / resolutionStep;
    }
    return best;
  };

  const split = (topicId: string, members: number[], depth: number): void => {
    const plan = planSplit(members.length, depth, config);
    if (!plan) {
      session.setItems(topicId, members);
      return;
    }
    let groups = communities(members, plan.k, topicId, depth);
    if (depth === 0) diagnostics.rootCommunities = groups.length;
    const largest = Math.max(...groups.map((group) => group.length));
    if (groups.length < 2 || largest > 0.95 * members.length) {
      groups = kmeansGroups(
        matrix,
        members,
        plan,
        deriveSeed(options.seed, `lv-km:${topicId}`),
        config
      );
      if (depth === 0) diagnostics.rootKmeansFallback = true;
    }
    if (groups.length > config.fanOut.max && depth + 2 <= config.depth.cap) {
      // Too many communities for one level: group them by centroid first.
      const vectors = matrixFromRows(
        groups.map((group) => centroidOfRows(matrix, group)),
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
          seed: deriveSeed(options.seed, `lv-group:${topicId}`),
          weights: groups.map((group) => group.length),
          minSize: config.fanOut.min,
          maxSize: config.fanOut.max
        }),
        indices
      );
      const flat = groups;
      groups = superGroups.map((indicesInGroup) =>
        indicesInGroup.flatMap((index) => flat[index] ?? [])
      );
    }
    if (groups.length < 2) {
      session.setItems(topicId, members);
      return;
    }
    if (depth === 0) diagnostics.rootChildren = groups.length;
    for (const group of groups) split(session.createTopic(topicId), group, depth + 1);
  };
  started = performance.now();
  split(session.context.state.rootId, [...rows], 0);
  // The community phase includes its k-means fallbacks and super-grouping.
  const communitiesMs = performance.now() - started;
  return { ...finishBuild(session, { knnMs, communitiesMs }), diagnostics, knnExact: graph.exact };
}

// ---------------------------------------------------------------------------
// Partitions

/** One topic of a built tree for the worker result: integer keys, items as matrix rows. */
export interface PartitionNode {
  key: number;
  parent: number | null;
  items: number[];
}

/** The live tree in pre-order (key = pre-order index; the root is key 0). */
export function partitionOf(
  state: TopicTreeState,
  rowOf: (item: ItemKey) => number | undefined = rowOfItemKey
): PartitionNode[] {
  const keys = new Map<string, number>();
  const nodes: PartitionNode[] = [];
  walkTopics(state, (node) => {
    const key = nodes.length;
    keys.set(node.id, key);
    const items = node.items.map((item) => {
      const row = rowOf(item);
      if (row === undefined) throw new Error(`Item ${item} has no row`);
      return row;
    });
    nodes.push({
      key,
      parent: node.parentId === null ? null : (keys.get(node.parentId) as number),
      items
    });
  });
  return nodes;
}

/**
 * ID-free canonical form of the live tree: each topic is its sorted item keys and the sorted
 * canonical forms of its children. Equal strings mean the same tree up to topic IDs.
 */
export function canonicalPartition(state: TopicTreeState): string {
  const encode = (id: string): string => {
    const node = getTopic(state, id);
    const children = node.children.map(encode).sort(compareStrings);
    const items = [...node.items].sort(compareStrings);
    return `(${items.join(",")}|${children.join("")})`;
  };
  return encode(state.rootId);
}
