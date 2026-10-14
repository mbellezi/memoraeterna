// Topic tree with BIRCH-style clustering-feature statistics per node:
// N (items in the subtree) and LS (sum of unit vectors); centroid = LS/|LS|,
// coherence = |LS|/N (the mean cosine of members to the centroid).
import type { TreeConfig } from "./config.js";
import { addRow, addVec, dotAt, dotRowVec, norm } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

export interface TopicNode {
  readonly id: number;
  parent: number | null;
  children: number[];
  /** Items placed directly on this node (leaf members, or unadmitted items on an internal node). */
  items: number[];
  /** N: items in the subtree. */
  n: number;
  /** LS: sum of the unit vectors of the subtree items. */
  ls: Float64Array;
  /** LS/|LS|. */
  centroid: Float32Array;
  /** Sum of squared member cosines to the centroid (exact after refresh, approximate between). */
  cosSqSum: number;
  /**
   * Lower percentiles 0%..10% (index = percent) of member cosines to the centroid
   * at the last exact refresh; empty until refreshed.
   */
  lowCosPercentiles: Float32Array;
  createdAt: number;
  /** Clock of the last repair touching this node (cooldown); -Infinity when never repaired. */
  lastRepairAt: number;
}

export class TopicTree {
  readonly dim: number;
  readonly nodes = new Map<number, TopicNode>();
  /** Primary placement: item -> node. */
  readonly itemNode = new Map<number, number>();
  /** Retired node -> surviving node (IDs are never reused). */
  readonly redirects = new Map<number, number>();
  readonly rootId: number;
  /** Logical clock (inserts) used by cooldowns. */
  clock = 0;
  private nextId = 0;

  constructor(dim: number) {
    this.dim = dim;
    this.rootId = this.createNode(null).id;
  }

  createNode(parent: number | null): TopicNode {
    const node: TopicNode = {
      id: this.nextId,
      parent,
      children: [],
      items: [],
      n: 0,
      ls: new Float64Array(this.dim),
      centroid: new Float32Array(this.dim),
      cosSqSum: 0,
      lowCosPercentiles: new Float32Array(0),
      createdAt: this.clock,
      lastRepairAt: Number.NEGATIVE_INFINITY
    };
    this.nextId += 1;
    this.nodes.set(node.id, node);
    if (parent !== null) this.node(parent).children.push(node.id);
    return node;
  }

  node(id: number): TopicNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown topic node ${id}`);
    return node;
  }

  has(id: number): boolean {
    return this.nodes.has(id);
  }

  isLeaf(id: number): boolean {
    return this.node(id).children.length === 0;
  }

  depthOf(id: number): number {
    let depth = 0;
    let current = this.node(id).parent;
    while (current !== null) {
      depth += 1;
      current = this.node(current).parent;
    }
    return depth;
  }

  /** Node IDs from the root to `id`, inclusive. */
  pathOf(id: number): number[] {
    const path: number[] = [];
    let current: number | null = id;
    while (current !== null) {
      path.push(current);
      current = this.node(current).parent;
    }
    return path.reverse();
  }

  /** Height of the subtree below `id` (a leaf has height 0). */
  heightOf(id: number): number {
    const node = this.node(id);
    let height = 0;
    for (const child of node.children) height = Math.max(height, 1 + this.heightOf(child));
    return height;
  }

  subtreeItems(id: number, output: number[] = []): number[] {
    const node = this.node(id);
    output.push(...node.items);
    for (const child of node.children) this.subtreeItems(child, output);
    return output;
  }

  /** Pre-order traversal from the root. */
  walk(visit: (node: TopicNode, depth: number) => void, from = this.rootId, depth = 0): void {
    const node = this.node(from);
    visit(node, depth);
    for (const child of node.children) this.walk(visit, child, depth + 1);
  }

  leaves(): TopicNode[] {
    const output: TopicNode[] = [];
    this.walk((node) => {
      if (node.children.length === 0) output.push(node);
    });
    return output;
  }

  /** Builder mode: sets the direct items of a node without touching statistics. */
  setItems(id: number, items: number[]): void {
    const node = this.node(id);
    node.items = items;
    for (const item of items) this.itemNode.set(item, id);
  }

  /** Adds an item to a node and updates N and LS on the whole path. */
  addItem(id: number, item: number, matrix: EmbeddingMatrix): void {
    this.node(id).items.push(item);
    this.itemNode.set(item, id);
    for (const nodeId of this.pathOf(id)) {
      const node = this.node(nodeId);
      node.n += 1;
      addRow(node.ls, matrix, item);
      this.updateCentroid(node);
      const cos = dotRowVec(matrix, item, node.centroid);
      node.cosSqSum += cos * cos;
    }
  }

  /** Removes an item and subtracts it along its old path. Returns the old node. */
  removeItem(item: number, matrix: EmbeddingMatrix): number {
    const id = this.itemNode.get(item);
    if (id === undefined) throw new Error(`Item ${item} is not placed`);
    const node = this.node(id);
    node.items.splice(node.items.indexOf(item), 1);
    this.itemNode.delete(item);
    for (const nodeId of this.pathOf(id)) {
      const current = this.node(nodeId);
      const cos = dotRowVec(matrix, item, current.centroid);
      current.cosSqSum = Math.max(0, current.cosSqSum - cos * cos);
      current.n -= 1;
      addRow(current.ls, matrix, item, -1);
      this.updateCentroid(current);
    }
    return id;
  }

  /** Detaches `child` from its parent and attaches it under `parent` (no statistics update). */
  setParent(child: number, parent: number): void {
    const node = this.node(child);
    if (node.parent !== null) {
      const siblings = this.node(node.parent).children;
      siblings.splice(siblings.indexOf(child), 1);
    }
    node.parent = parent;
    this.node(parent).children.push(child);
  }

  /** Moves direct items to another node (no statistics update). */
  moveItems(from: number, to: number, items: readonly number[]): void {
    const source = this.node(from);
    const moving = new Set(items);
    source.items = source.items.filter((item) => !moving.has(item));
    const target = this.node(to);
    for (const item of items) {
      target.items.push(item);
      this.itemNode.set(item, to);
    }
  }

  /** Removes an empty node and records a redirect to its survivor. */
  retire(id: number, survivor: number): void {
    const node = this.node(id);
    if (node.children.length > 0 || node.items.length > 0) {
      throw new Error(`Cannot retire non-empty topic node ${id}`);
    }
    if (id === this.rootId) throw new Error("Cannot retire the root");
    if (node.parent !== null) {
      const siblings = this.node(node.parent).children;
      const index = siblings.indexOf(id);
      if (index >= 0) siblings.splice(index, 1);
    }
    this.nodes.delete(id);
    this.redirects.set(id, survivor);
  }

  /** Follows redirects to the live node that replaced a retired one. */
  resolve(id: number): number {
    let current = id;
    while (!this.nodes.has(current)) {
      const next = this.redirects.get(current);
      if (next === undefined) throw new Error(`Unknown topic node ${id}`);
      current = next;
    }
    return current;
  }

  updateCentroid(node: TopicNode): void {
    const length = norm(node.ls);
    for (let k = 0; k < this.dim; k += 1) {
      node.centroid[k] = length > 0 ? (node.ls[k] as number) / length : 0;
    }
  }

  /** Recomputes N, LS and the centroid of one node from its direct items and children. */
  recomputeNode(id: number, matrix: EmbeddingMatrix): void {
    const node = this.node(id);
    node.ls.fill(0);
    node.n = node.items.length;
    for (const item of node.items) addRow(node.ls, matrix, item);
    for (const childId of node.children) {
      const child = this.node(childId);
      node.n += child.n;
      addVec(node.ls, child.ls);
    }
    this.updateCentroid(node);
  }

  /** Recomputes `id` and all its ancestors (children must already be current). */
  refreshUp(id: number, matrix: EmbeddingMatrix): void {
    let current: number | null = id;
    while (current !== null) {
      this.recomputeNode(current, matrix);
      current = this.node(current).parent;
    }
  }

  /** Exact recomputation of every statistic in the subtree of `id` (default: whole tree). */
  recomputeStats(matrix: EmbeddingMatrix, id = this.rootId): void {
    const node = this.node(id);
    for (const child of node.children) this.recomputeStats(matrix, child);
    this.recomputeNode(id, matrix);
    this.refreshSpread(id, matrix);
  }

  /** Exact squared-cosine sum and low percentiles of member cosines (O(N * dim)). */
  refreshSpread(id: number, matrix: EmbeddingMatrix): void {
    const node = this.node(id);
    const members = this.subtreeItems(id);
    const cosines = new Float32Array(members.length);
    let sum = 0;
    members.forEach((item, index) => {
      const cos = dotAt(matrix.data, item * matrix.dim, node.centroid, 0, matrix.dim);
      cosines[index] = cos;
      sum += cos * cos;
    });
    node.cosSqSum = sum;
    cosines.sort();
    node.lowCosPercentiles =
      cosines.length === 0
        ? new Float32Array(0)
        : Float32Array.from({ length: 11 }, (_, percent) => {
            const index = Math.min(
              cosines.length - 1,
              Math.floor((percent / 100) * cosines.length)
            );
            return cosines[index] as number;
          });
  }

  clone(): TopicTree {
    const copy = new TopicTree(this.dim);
    copy.nodes.clear();
    for (const [id, node] of this.nodes) {
      copy.nodes.set(id, {
        ...node,
        children: [...node.children],
        items: [...node.items],
        ls: node.ls.slice(),
        centroid: node.centroid.slice(),
        lowCosPercentiles: node.lowCosPercentiles.slice()
      });
    }
    for (const [item, node] of this.itemNode) copy.itemNode.set(item, node);
    for (const [from, to] of this.redirects) copy.redirects.set(from, to);
    copy.clock = this.clock;
    copy.nextId = this.nextId;
    (copy as { rootId: number }).rootId = this.rootId;
    return copy;
  }
}

/** m_c: mean member cosine to the centroid, |LS|/N. */
export function coherenceOf(node: TopicNode): number {
  return node.n > 0 ? norm(node.ls) / node.n : 0;
}

/** s_c: standard deviation of member cosines to the centroid. */
export function spreadOf(node: TopicNode): number {
  if (node.n === 0) return 0;
  const mean = coherenceOf(node);
  return Math.sqrt(Math.max(0, node.cosSqSum / node.n - mean * mean));
}

/**
 * Mean member cosine used for admission: |LS|/N, or its leave-one-out estimate
 * (|LS|^2/N - 1) / sqrt(|LS|^2 (1 - 2/N) + 1) when configured.
 */
export function admissionMean(node: TopicNode, config: TreeConfig): number {
  const mean = coherenceOf(node);
  if (!config.placement.leaveOneOutMean || node.n < 2) return mean;
  const squared = (mean * node.n) ** 2;
  return (squared / node.n - 1) / Math.sqrt(Math.max(1e-12, squared * (1 - 2 / node.n) + 1));
}

/**
 * Node-relative admission threshold max(a_min, m_c - k * max(s_c, floor)). For an
 * internal node the member cosines are a mixture of its subtopics, so the rule is
 * relaxed to the configured lower percentile of member cosines when that is lower.
 */
export function admissionThreshold(node: TopicNode, config: TreeConfig): number {
  if (node.n === 0) return Infinity;
  const { admissionFloor, leafFloor, spreadFactor, spreadFloor, internalPercentile } =
    config.placement;
  let threshold =
    admissionMean(node, config) - spreadFactor * Math.max(spreadFloor, spreadOf(node));
  const percentile = node.lowCosPercentiles[Math.round(internalPercentile * 100)];
  if (node.children.length > 0 && internalPercentile > 0 && percentile !== undefined) {
    threshold = Math.min(threshold, percentile);
  }
  return Math.max(admissionFloor, node.children.length === 0 ? leafFloor : 0, threshold);
}
