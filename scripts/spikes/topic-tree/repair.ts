// Structural repair operations shared by the builders (to enforce invariants)
// and the incremental engine (local repair after inserts). Hysteresis comes from
// separated trigger and target sizes plus a per-node cooldown for soft triggers.
import type { TreeConfig } from "./config.js";
import { groupsOf, sphericalKMeans } from "./kmeans.js";
import { deriveSeed } from "./rng.js";
import type { TopicTree } from "./tree.js";
import { dot, matrixFromRows } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

export type RepairKind =
  | "leaf-split"
  | "internal-split"
  | "push-down"
  | "merge"
  | "dissolve"
  | "collapse"
  | "lift"
  | "absorb-direct";

export interface RepairOperation {
  kind: RepairKind;
  nodeId: number;
  created: number[];
  retired: number[];
  /** Items whose direct node changed. */
  movedItems: number;
  clock: number;
}

export interface RepairContext {
  tree: TopicTree;
  matrix: EmbeddingMatrix;
  config: TreeConfig;
  seed: number;
  /**
   * Re-places an item starting at `from` and returns the node it is admitted to
   * below `from`, or null. Used when absorbing direct items of an internal node.
   */
  readmit?: (item: number, from: number) => number | null;
}

export interface RepairOptions {
  /** Ignore cooldowns (builders and explicit settle passes). */
  force: boolean;
}

function finish(
  context: RepairContext,
  operation: Omit<RepairOperation, "clock">,
  touched: number[]
): RepairOperation {
  const { tree } = context;
  for (const id of touched) {
    if (tree.has(id)) tree.node(id).lastRepairAt = tree.clock;
  }
  return { ...operation, clock: tree.clock };
}

/** Exact statistics for new or restructured nodes, then their ancestors. */
function refresh(context: RepairContext, ids: number[], ancestorsOf: number | null): void {
  const { tree, matrix } = context;
  for (const id of ids) {
    if (!tree.has(id)) continue;
    tree.recomputeNode(id, matrix);
    tree.refreshSpread(id, matrix);
  }
  if (ancestorsOf !== null && tree.has(ancestorsOf)) {
    tree.refreshUp(ancestorsOf, matrix);
    tree.refreshSpread(ancestorsOf, matrix);
  }
}

function partition(context: RepairContext, items: number[], k: number, label: string): number[][] {
  const { config, matrix, tree } = context;
  if (k <= 1) return [items];
  const result = sphericalKMeans(matrix, items, {
    k,
    seed: deriveSeed(context.seed, `${label}:${tree.clock}`),
    maxIterations: config.kmeans.maxIterations,
    tolerance: config.kmeans.tolerance,
    minSize: Math.max(config.leaf.min, Math.floor((0.4 * items.length) / k)),
    maxSize: config.leaf.max
  });
  return groupsOf(result, items).sort((a, b) => b.length - a.length);
}

/**
 * Splits an oversized leaf with balanced spherical k-means. Sideways under the
 * parent when possible (the leaf keeps its ID and its largest part, so most items
 * keep their path); a root leaf, or a leaf whose parent is full, splits downward.
 */
export function splitLeaf(context: RepairContext, leafId: number): RepairOperation | null {
  const { tree, config } = context;
  const leaf = tree.node(leafId);
  const size = leaf.items.length;
  if (size <= config.leaf.max || leaf.children.length > 0) return null;
  // Sideways (the leaf keeps its largest part) unless that would push the parent past
  // fanOut.max; then the leaf splits downward into a target fan-out of smaller leaves,
  // so the overflow does not cascade upward.
  const parentFull =
    leaf.parent !== null && tree.node(leaf.parent).children.length >= config.fanOut.max;
  const sideways =
    leaf.parent !== null && (!parentFull || tree.depthOf(leafId) + 1 > config.depth.cap);
  let k = Math.max(2, Math.round(size / config.leaf.target), Math.ceil(size / config.leaf.max));
  if (!sideways)
    k = Math.max(k, Math.min(config.fanOut.targetMin, Math.floor(size / config.leaf.min)));
  const groups = partition(context, [...leaf.items], k, `split:${leafId}`);
  if (groups.length < 2) return null;
  const created: number[] = [];
  let moved = 0;
  if (sideways && leaf.parent !== null) {
    for (const group of groups.slice(1)) {
      const sibling = tree.createNode(leaf.parent);
      tree.moveItems(leafId, sibling.id, group);
      created.push(sibling.id);
      moved += group.length;
    }
    refresh(context, [leafId, ...created], leaf.parent);
  } else {
    for (const group of groups) {
      const child = tree.createNode(leafId);
      tree.moveItems(leafId, child.id, group);
      created.push(child.id);
      moved += group.length;
    }
    refresh(context, created, leafId);
  }
  return finish(
    context,
    { kind: "leaf-split", nodeId: leafId, created, retired: [], movedItems: moved },
    [leafId, ...created]
  );
}

/**
 * Fan-out overflow on a non-root node, B-tree style: its children are split in two
 * by balanced spherical k-means over their centroids; the node keeps the heavier
 * half and a new sibling takes the other. Depth does not grow; repairNode uses it
 * only while the parent has room, so overflow never cascades up to the root.
 */
export function splitInternal(context: RepairContext, nodeId: number): RepairOperation | null {
  const { tree, config } = context;
  const node = tree.node(nodeId);
  const fanOut = node.children.length;
  if (node.parent === null || fanOut <= config.fanOut.max) return null;
  const children = [...node.children];
  const indices = children.map((_, index) => index);
  const minSize = Math.max(config.fanOut.min, Math.floor(fanOut * 0.3));
  const result = sphericalKMeans(
    matrixFromRows(
      children.map((child) => tree.node(child).centroid),
      false
    ),
    indices,
    {
      k: 2,
      seed: deriveSeed(context.seed, `isplit:${nodeId}:${tree.clock}`),
      maxIterations: config.kmeans.maxIterations,
      weights: children.map((child) => tree.node(child).n),
      minSize,
      maxSize: fanOut - minSize
    }
  );
  const groups = groupsOf(result, indices);
  if (groups.length < 2) return null;
  const weightOf = (group: number[]): number =>
    group.reduce((total, index) => total + tree.node(children[index] as number).n, 0);
  groups.sort((a, b) => weightOf(b) - weightOf(a));
  const sibling = tree.createNode(node.parent);
  let moved = 0;
  for (const index of groups[1] ?? []) {
    const child = children[index] as number;
    tree.setParent(child, sibling.id);
    moved += tree.node(child).n;
  }
  refresh(context, [nodeId, sibling.id], node.parent);
  return finish(
    context,
    { kind: "internal-split", nodeId, created: [sibling.id], retired: [], movedItems: moved },
    [nodeId, sibling.id]
  );
}

/**
 * Fan-out overflow on the root, or on a node whose parent is full: groups the
 * children under new intermediate nodes (the node keeps its ID; its subtree changes
 * path). Children whose subtree would cross the depth cap stay where they are.
 */
export function pushDown(context: RepairContext, nodeId: number): RepairOperation | null {
  const { tree, config } = context;
  const node = tree.node(nodeId);
  const fanOut = node.children.length;
  if (fanOut <= config.fanOut.max) return null;
  // Only children whose subtree stays within the depth cap one level lower are grouped.
  const depth = tree.depthOf(nodeId);
  const children = node.children.filter(
    (child) => depth + 2 + tree.heightOf(child) <= config.depth.cap
  );
  if (children.length < 2 * config.fanOut.min) return null;
  const groupCount = Math.min(
    config.fanOut.targetMax,
    Math.max(2, Math.round(children.length / config.repair.pushDownGroupSize))
  );
  const vectors = matrixFromRows(
    children.map((child) => tree.node(child).centroid),
    false
  );
  const result = sphericalKMeans(
    vectors,
    children.map((_, index) => index),
    {
      k: groupCount,
      seed: deriveSeed(context.seed, `push:${nodeId}:${tree.clock}`),
      maxIterations: config.kmeans.maxIterations,
      weights: children.map((child) => tree.node(child).n),
      minSize: config.fanOut.min,
      maxSize: config.fanOut.max
    }
  );
  const created: number[] = [];
  for (const group of groupsOf(
    result,
    children.map((_, index) => index)
  )) {
    if (group.length < 2) continue;
    const intermediate = tree.createNode(nodeId);
    for (const index of group) tree.setParent(children[index] as number, intermediate.id);
    created.push(intermediate.id);
  }
  if (created.length === 0) return null;
  refresh(context, created, nodeId);
  return finish(context, { kind: "push-down", nodeId, created, retired: [], movedItems: 0 }, [
    nodeId,
    ...created
  ]);
}

/**
 * A leaf below the minimum merges into its most similar sibling leaf when the
 * result stays at or below mergeMaxSize; otherwise its items move up to the parent
 * as direct items. An empty leaf is dissolved.
 */
export function mergeTinyLeaf(context: RepairContext, leafId: number): RepairOperation | null {
  const { tree, config } = context;
  const leaf = tree.node(leafId);
  if (leaf.parent === null || leaf.children.length > 0) return null;
  const size = leaf.items.length;
  if (size >= config.leaf.min) return null;
  const parentId = leaf.parent;
  if (size === 0) {
    tree.retire(leafId, parentId);
    refresh(context, [], parentId);
    return finish(
      context,
      { kind: "dissolve", nodeId: leafId, created: [], retired: [leafId], movedItems: 0 },
      [parentId]
    );
  }
  let target = parentId;
  let best = -Infinity;
  for (const siblingId of tree.node(parentId).children) {
    const sibling = tree.node(siblingId);
    if (siblingId === leafId || sibling.children.length > 0) continue;
    if (sibling.items.length + size > config.repair.mergeMaxSize) continue;
    const similarity = dot(sibling.centroid, leaf.centroid);
    if (similarity > best) {
      best = similarity;
      target = siblingId;
    }
  }
  const items = [...leaf.items];
  tree.moveItems(leafId, target, items);
  tree.retire(leafId, target);
  refresh(context, target === parentId ? [] : [target], parentId);
  return finish(
    context,
    { kind: "merge", nodeId: leafId, created: [], retired: [leafId], movedItems: items.length },
    [target, parentId]
  );
}

/** A node with exactly one child and no direct items absorbs that child. */
export function collapseChain(context: RepairContext, nodeId: number): RepairOperation | null {
  const { tree } = context;
  const node = tree.node(nodeId);
  if (node.children.length !== 1 || node.items.length > 0) return null;
  const childId = node.children[0] as number;
  const child = tree.node(childId);
  for (const grandchild of [...child.children]) tree.setParent(grandchild, nodeId);
  const items = [...child.items];
  tree.moveItems(childId, nodeId, items);
  tree.retire(childId, nodeId);
  refresh(context, [nodeId], nodeId);
  return finish(
    context,
    { kind: "collapse", nodeId, created: [], retired: [childId], movedItems: items.length },
    [nodeId]
  );
}

/**
 * A thin internal node (fan-out below the target, no direct items) dissolves into
 * its parent when the parent's fan-out stays within the target: its children move
 * up one level and it is retired with a redirect to the parent.
 */
export function liftIntoParent(
  context: RepairContext,
  nodeId: number,
  maxMoved = Number.POSITIVE_INFINITY
): RepairOperation | null {
  const { tree, config } = context;
  const node = tree.node(nodeId);
  if (node.parent === null || node.children.length === 0 || node.items.length > 0) return null;
  if (node.children.length >= config.fanOut.targetMin || node.n > maxMoved) return null;
  const parentId = node.parent;
  if (tree.node(parentId).children.length - 1 + node.children.length > config.fanOut.targetMax) {
    return null;
  }
  for (const child of [...node.children]) tree.setParent(child, parentId);
  tree.retire(nodeId, parentId);
  refresh(context, [parentId], parentId);
  return finish(
    context,
    { kind: "lift", nodeId: parentId, created: [], retired: [nodeId], movedItems: node.n },
    [parentId]
  );
}

/**
 * A node below the fan-out target (e.g. a thin level left by community detection or
 * a push-down) adopts the children of one internal child, which is retired with a
 * redirect, as long as its fan-out stays within the target. The child with the
 * fewest children is lifted first; children holding direct items are kept.
 */
export function liftThinNode(
  context: RepairContext,
  nodeId: number,
  maxMoved = Number.POSITIVE_INFINITY
): RepairOperation | null {
  const { tree, config } = context;
  const node = tree.node(nodeId);
  const fanOut = node.children.length;
  if (fanOut === 0 || fanOut >= config.fanOut.targetMin) return null;
  let best = -1;
  let bestChildren = Infinity;
  let bestN = Infinity;
  for (const childId of node.children) {
    const child = tree.node(childId);
    if (child.children.length === 0 || child.items.length > 0 || child.n > maxMoved) continue;
    if (fanOut - 1 + child.children.length > config.fanOut.targetMax) continue;
    if (
      child.children.length < bestChildren ||
      (child.children.length === bestChildren && child.n < bestN)
    ) {
      best = childId;
      bestChildren = child.children.length;
      bestN = child.n;
    }
  }
  if (best < 0) return null;
  const moved = tree.node(best).n;
  for (const grandchild of [...tree.node(best).children]) tree.setParent(grandchild, nodeId);
  tree.retire(best, nodeId);
  refresh(context, [nodeId], nodeId);
  return finish(
    context,
    { kind: "lift", nodeId, created: [], retired: [best], movedItems: moved },
    [nodeId]
  );
}

/**
 * Direct items piling up on an internal node: try to re-admit each one below the
 * node; once enough remain, they form new leaf children (a lone item never creates
 * a topic).
 */
export function absorbDirectItems(context: RepairContext, nodeId: number): RepairOperation | null {
  const { tree, config, matrix } = context;
  const node = tree.node(nodeId);
  if (node.children.length === 0 || node.items.length < config.repair.directItemsSplitAt) {
    return null;
  }
  let moved = 0;
  if (context.readmit) {
    for (const item of [...node.items]) {
      const target = context.readmit(item, nodeId);
      if (target === null || target === nodeId) continue;
      tree.removeItem(item, matrix);
      tree.addItem(target, item, matrix);
      moved += 1;
    }
  }
  const created: number[] = [];
  const remaining = [...node.items];
  const k = Math.max(
    1,
    Math.round(remaining.length / config.leaf.target),
    Math.ceil(remaining.length / config.leaf.max)
  );
  // New leaves must leave a way to repair the fan-out (a local push-down within the
  // depth cap). The root never grows past fanOut.max this way, because its only
  // repair would re-path every item; its leftover items stay Unsorted until a rebuild.
  const room =
    node.children.length + k <= config.fanOut.max ||
    (node.parent !== null && tree.depthOf(nodeId) + 2 <= config.depth.cap);
  if (remaining.length >= config.repair.directItemsSplitAt && room) {
    for (const group of partition(context, remaining, k, `absorb:${nodeId}`)) {
      const leaf = tree.createNode(nodeId);
      tree.moveItems(nodeId, leaf.id, group);
      created.push(leaf.id);
      moved += group.length;
    }
    refresh(context, created, nodeId);
  }
  if (moved === 0) return null;
  return finish(
    context,
    { kind: "absorb-direct", nodeId, created, retired: [], movedItems: moved },
    [nodeId, ...created]
  );
}

/**
 * Checks one node and applies at most one repair. Hard violations (leaf above
 * leaf.hardMax, fan-out above fanOut.hardMax) ignore the cooldown.
 */
export function repairNode(
  context: RepairContext,
  nodeId: number,
  options: RepairOptions
): RepairOperation | null {
  const { tree, config } = context;
  if (!tree.has(nodeId)) return null;
  const node = tree.node(nodeId);
  const cooled = options.force || tree.clock - node.lastRepairAt >= config.repair.cooldownInserts;
  if (node.children.length === 0) {
    const size = node.items.length;
    if (size > config.leaf.hardMax || (size > config.leaf.max && cooled)) {
      return splitLeaf(context, nodeId);
    }
    if (node.parent !== null && (size === 0 || (size < config.leaf.min && cooled))) {
      return mergeTinyLeaf(context, nodeId);
    }
    return null;
  }
  if (node.children.length === 1 && node.items.length === 0) return collapseChain(context, nodeId);
  if (node.items.length >= config.repair.directItemsSplitAt && cooled) {
    const operation = absorbDirectItems(context, nodeId);
    if (operation) return operation;
  }
  const fanOut = node.children.length;
  const hard = fanOut > config.fanOut.hardMax;
  if (hard || (fanOut > config.fanOut.max && cooled)) {
    // Churn budget for soft overflow: a sideways split re-paths about half of the
    // subtree, a push-down all of it.
    // Sideways while the parent has room (re-paths about half the subtree); otherwise
    // push down locally (re-paths the subtree) so overflow never cascades to the root.
    const parentFull =
      node.parent === null || tree.node(node.parent).children.length >= config.fanOut.max;
    const moves = parentFull ? node.n : node.n / 2;
    const total = tree.node(tree.rootId).n;
    if (!hard && !options.force && moves > config.repair.softMoveShare * total) return null;
    return parentFull
      ? (pushDown(context, nodeId) ?? splitInternal(context, nodeId))
      : (splitInternal(context, nodeId) ?? pushDown(context, nodeId));
  }
  if (fanOut < config.fanOut.targetMin && cooled) {
    // Lifting re-paths the lifted subtree; soft, so it respects the churn budget.
    const budget = options.force
      ? Number.POSITIVE_INFINITY
      : config.repair.softMoveShare * tree.node(tree.rootId).n;
    return liftIntoParent(context, nodeId, budget) ?? liftThinNode(context, nodeId, budget);
  }
  return null;
}

/** Nodes worth re-checking after an operation. */
export function affectedNodes(tree: TopicTree, operation: RepairOperation): number[] {
  const ids = [operation.nodeId, ...operation.created];
  for (const retired of operation.retired) ids.push(tree.resolve(retired));
  const output = new Set<number>();
  for (const id of ids) {
    if (!tree.has(id)) continue;
    output.add(id);
    const parent = tree.node(id).parent;
    if (parent !== null) output.add(parent);
  }
  return [...output];
}

/** Repairs until no node needs an operation (bounded number of passes). */
export function repairAll(context: RepairContext, options: RepairOptions): RepairOperation[] {
  const { tree } = context;
  const log: RepairOperation[] = [];
  for (let pass = 0; pass < 20; pass += 1) {
    const ids: number[] = [];
    tree.walk((node) => ids.push(node.id));
    let changed = false;
    // Deepest nodes first so leaf repairs settle before fan-out repairs above them.
    for (const id of ids.reverse()) {
      for (let guard = 0; guard < 8; guard += 1) {
        const operation = repairNode(context, id, options);
        if (!operation) break;
        log.push(operation);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return log;
}
