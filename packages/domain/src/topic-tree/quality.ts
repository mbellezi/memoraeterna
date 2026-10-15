// Tree quality Q for REBALANCE acceptance (plan 4.1 "Operations"): a soft operation is applied
// only when dQ - lambda * churn > 0, where churn counts the items whose primary path changes
// (recently opened items weighted up, stability.ts) and lambda is `stability.churnWeight`.
//
// Q is measured in items, like churn, so lambda is the only exchange rate:
//
//   Q = fit - cost
//   fit  = sum over items of the cosine to the centroid of the group that holds it: |LS| of a
//          leaf, LS_direct . centroid for the direct items of an internal topic (counted items, D8)
//   cost = sum over soft conditions of  affected items x (1 + how far the condition goes)
//
// with "affected items" floored at leaf.min (the smallest topic worth having) and every threshold
// taken from the typed configuration, so Q itself adds no tunable number:
//
//   condition             when                                       affected    how far
//   leaf size (I4)        outside leaf.min..leaf.max                 leaf items  relative distance
//   fan-out (I3)          outside fanOut.min..max (the root: the     subtree     relative distance
//                         Areas band once Areas exist, D12)
//   single child (I6)     exactly one child                          subtree     0
//   depth (I5)            direct items beyond depth.target           those items relative distance
//   direct items          >= repair.directItemsSplitAt movable       those items relative distance
//                         items on an internal topic
//   duplicate siblings    a pair of sibling leaves at centroid       both leaves (cos - threshold) /
//                         cosine >= repair.siblingMergeCosine whose              (1 - threshold)
//                         union fits repair.mergeMaxSize
//   mis-parent (D12)      an internal uncle closer than the parent   subtree     the cosine gain
//                         by >= audit.misParentMargin
//
// Inside every band the cost is 0, which is the hysteresis: a topic is left alone until it leaves
// its band, and an operation never lands it just outside the band that triggers the reverse one.
// Hard violations cost on the same scale but are fixed without the acceptance test (repair.ts).
// The I8 split signal is off until calibrated (config.splitSignal) and is not part of Q. A root
// without children is the cold start (bootstrap, T19) and costs nothing.
import { parentFit, reparentTarget } from "./audit.js";
import type { TopicTreeConfig } from "./config.js";
import { depthOf, getTopic, primaryPlacement } from "./state.js";
import type { TopicNode, TopicTreeState } from "./state.js";
import { statsRow } from "./stats.js";
import { addRow, dot, norm } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

export interface QualityOptions {
  /** The root's fan-out band is the Areas band (D12). */
  areasActive?: boolean;
}

/** The terms of Q over a set of topics: `fit` adds, every other term is a cost. */
export interface QualityTerms {
  fit: number;
  leafSize: number;
  fanOut: number;
  singleChild: number;
  depth: number;
  directItems: number;
  duplicates: number;
  misParent: number;
}

export interface QualityReport extends QualityTerms {
  /** Sum of the cost terms. */
  cost: number;
  /** fit - cost. */
  total: number;
  topics: number;
  items: number;
}

export const qualityCostTerms = [
  "leafSize",
  "fanOut",
  "singleChild",
  "depth",
  "directItems",
  "duplicates",
  "misParent"
] as const satisfies readonly (keyof QualityTerms)[];

/**
 * Cost of `affected` items in a condition whose measured `value` lies outside [low, high]:
 * affected (floored at `unit`) x (1 + relative distance outside the band); 0 inside the band.
 */
export function bandCost(
  affected: number,
  value: number,
  low: number,
  high: number,
  unit: number
): number {
  if (value >= low && value <= high) return 0;
  const distance =
    value > high ? (value - high) / Math.max(1, high) : (low - value) / Math.max(1, low);
  return Math.max(affected, unit) * (1 + distance);
}

/**
 * Direct items an operation may move off an internal topic: not waiting for the gate
 * (`needs_gate`), not waiting for a vector (`needs_vector`) and not placed by a human.
 */
export function isMovableDirectItem(state: TopicTreeState, item: string): boolean {
  const placement = primaryPlacement(state, item);
  return (
    placement !== undefined &&
    placement.management === "ai" &&
    !placement.needsGate &&
    !placement.needsVector
  );
}

export function movableDirectItems(state: TopicTreeState, node: TopicNode): string[] {
  return node.items.filter((item) => isMovableDirectItem(state, item));
}

/** Fan-out band of a topic: the Areas band at the root once Areas exist, I3 elsewhere. */
export function fanOutBand(
  state: TopicTreeState,
  config: TopicTreeConfig,
  topicId: string,
  options: QualityOptions = {}
): { low: number; high: number } {
  return topicId === state.rootId && options.areasActive
    ? { low: config.areas.min, high: config.areas.max }
    : { low: config.fanOut.min, high: config.fanOut.max };
}

/** Sibling leaves that the duplicate condition (and the sibling merge) applies to. */
export function areDuplicateLeaves(
  config: TopicTreeConfig,
  a: TopicNode,
  b: TopicNode
): { cosine: number } | null {
  if (a.children.length > 0 || b.children.length > 0) return null;
  if (a.stats.n === 0 || b.stats.n === 0) return null;
  if (a.items.length + b.items.length > config.repair.mergeMaxSize) return null;
  const cosine = dot(a.stats.centroid, b.stats.centroid);
  return cosine >= config.repair.siblingMergeCosine ? { cosine } : null;
}

function emptyTerms(): QualityTerms {
  return {
    fit: 0,
    leafSize: 0,
    fanOut: 0,
    singleChild: 0,
    depth: 0,
    directItems: 0,
    duplicates: 0,
    misParent: 0
  };
}

/**
 * Q over the live subtree of `scopeId` (default: the whole tree). Statistics must be current for
 * the subtree. The difference of two calls on the same scope is exact for any change confined to
 * the subtree of a child of the scope (repair.ts picks the scope that way): topics outside the
 * scope read only unchanged neighbours.
 */
export function subtreeQuality(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  config: TopicTreeConfig,
  scopeId: string = state.rootId,
  options: QualityOptions = {}
): QualityReport {
  const terms = emptyTerms();
  const unit = config.leaf.min;
  const { leaf, depth: depthConfig, repair } = config;
  let topics = 0;
  let items = 0;
  const visit = (id: string, depth: number): number => {
    const node = getTopic(state, id);
    topics += 1;
    items += node.items.length;
    let count = node.items.length;
    for (const child of node.children) count += visit(child, depth + 1);
    const isRoot = id === state.rootId;
    const isLeaf = node.children.length === 0;
    if (isRoot && isLeaf) return count; // the cold start belongs to the bootstrap

    // fit
    if (isLeaf) {
      terms.fit += norm(node.stats.ls);
    } else if (node.items.length > 0 && node.stats.n > 0) {
      const direct = new Float64Array(state.dim);
      for (const item of node.items) {
        const row = statsRow(state, vectors, item);
        if (row !== undefined) addRow(direct, vectors.matrix, row);
      }
      terms.fit += dot(direct, node.stats.centroid);
    }

    if (isLeaf) {
      const size = node.items.length;
      terms.leafSize += bandCost(size, size, leaf.min, leaf.max, unit);
    } else {
      const fanOut = node.children.length;
      const band = fanOutBand(state, config, id, options);
      terms.fanOut += bandCost(count, fanOut, band.low, band.high, unit);
      if (fanOut === 1) terms.singleChild += Math.max(count, unit);
      const movable = movableDirectItems(state, node).length;
      if (movable >= repair.directItemsSplitAt) {
        terms.directItems += bandCost(movable, movable, 0, repair.directItemsSplitAt - 1, unit);
      }
      // Duplicate sibling leaves among the children, each pair once: the pair costs the items of
      // both leaves, so a set of mutually redundant leaves costs more the more pieces it has.
      const leaves = node.children
        .map((child) => getTopic(state, child))
        .filter((child) => child.children.length === 0);
      const threshold = repair.siblingMergeCosine;
      for (let a = 0; a < leaves.length; a += 1) {
        for (let b = a + 1; b < leaves.length; b += 1) {
          const left = leaves[a] as TopicNode;
          const right = leaves[b] as TopicNode;
          const duplicate = areDuplicateLeaves(config, left, right);
          if (!duplicate) continue;
          const closeness = (duplicate.cosine - threshold) / Math.max(1e-9, 1 - threshold);
          terms.duplicates +=
            Math.max(left.items.length + right.items.length, unit) * (1 + closeness);
        }
      }
    }
    if (node.items.length > 0 && depth > depthConfig.target) {
      terms.depth += bandCost(node.items.length, depth, 0, depthConfig.target, unit);
    }
    if (depth >= 2) {
      const target = reparentTarget(state, config, id, parentFit(state, id, depth));
      if (target) terms.misParent += Math.max(count, unit) * (1 + target.gain);
    }
    return count;
  };
  visit(scopeId, depthOf(state, scopeId));
  const cost = qualityCostTerms.reduce((total, term) => total + terms[term], 0);
  return { ...terms, cost, total: terms.fit - cost, topics, items };
}

/** Q of the whole live tree. */
export function treeQuality(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  config: TopicTreeConfig,
  options: QualityOptions = {}
): QualityReport {
  return subtreeQuality(state, vectors, config, state.rootId, options);
}

/** dQ - lambda * weighted churn (item units): positive means a soft operation is worth it. */
export function netGain(
  deltaQuality: number,
  weightedChurn: number,
  config: TopicTreeConfig
): number {
  return deltaQuality - config.stability.churnWeight * weightedChurn;
}

/** Plan 4.1 acceptance for soft operations: dQ - lambda * churn > 0. */
export function acceptsChange(
  deltaQuality: number,
  weightedChurn: number,
  config: TopicTreeConfig
): boolean {
  return netGain(deltaQuality, weightedChurn, config) > 0;
}
