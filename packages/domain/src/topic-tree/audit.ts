// AUDIT (plan 4.3): the deterministic lint of a tree. Reachability and the hard invariants come
// from checkInvariants; this module adds the mis-parent audit (Spike B "upper-level audit": a
// topic is mis-parented when an uncle centroid is closer than its parent's), the re-parent
// targets REBALANCE may act on (D12: they go through REBALANCE acceptance, repair.ts), an exact
// recompute of a seeded sample of topic statistics (D7), and the flagged-item counts.
//
// Two margins, on purpose:
// - the audit flags a topic when its best uncle (any live child of its grandparent other than its
//   parent) is closer than its parent (Spike B: 3.1 / 1.3 / 0.7% at depths 2 / 3 / 4);
// - a re-parent target must be an internal uncle (one with children) closer than the parent by
//   at least `audit.misParentMargin` (hysteresis: a moved topic never qualifies to move back).
import type { TopicTreeConfig } from "./config.js";
import { compareStrings } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { checkInvariants } from "./invariants.js";
import type { InvariantReport, InvariantViolation } from "./invariants.js";
import { createRng, deriveSeed } from "./rng.js";
import {
  getItem,
  getTopic,
  isLive,
  isProtected,
  primaryPlacement,
  subtreeItems,
  walkTopics
} from "./state.js";
import type { TopicNode, TopicTreeState } from "./state.js";
import { statsRow } from "./stats.js";
import { addRow, addVec, dot, norm } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

/** How a topic at depth >= 2 sits between its parent and its uncles. */
export interface ParentFit {
  topicId: string;
  parentId: string;
  grandparentId: string;
  depth: number;
  /** Cosine of the topic centroid to its parent's centroid (the parent includes the topic). */
  parentCosine: number;
  /** The closest uncle (any live sibling of the parent), or null when the parent is an only child. */
  uncleId: string | null;
  uncleCosine: number;
  /** The closest internal uncle (one with children): the only kind a re-parent may target. */
  internalUncleId: string | null;
  internalUncleCosine: number;
}

/** Parent cosine minus best uncle cosine (Spike B); negative means mis-parented. */
export function parentMargin(fit: ParentFit): number {
  return fit.uncleId === null ? Number.POSITIVE_INFINITY : fit.parentCosine - fit.uncleCosine;
}

/** The parent fit of a live topic at depth >= 2, or null nearer the root. */
export function parentFit(
  state: TopicTreeState,
  topicId: string,
  depth?: number
): ParentFit | null {
  const node = getTopic(state, topicId);
  if (!isLive(node) || node.parentId === null) return null;
  const parent = getTopic(state, node.parentId);
  if (parent.parentId === null) return null;
  const grandparent = getTopic(state, parent.parentId);
  const centroid = node.stats.centroid;
  let uncleId: string | null = null;
  let uncleCosine = Number.NEGATIVE_INFINITY;
  let internalUncleId: string | null = null;
  let internalUncleCosine = Number.NEGATIVE_INFINITY;
  for (const candidateId of grandparent.children) {
    if (candidateId === parent.id) continue;
    const uncle = getTopic(state, candidateId);
    const cosine = dot(centroid, uncle.stats.centroid);
    if (cosine > uncleCosine) {
      uncleCosine = cosine;
      uncleId = candidateId;
    }
    if (uncle.children.length > 0 && cosine > internalUncleCosine) {
      internalUncleCosine = cosine;
      internalUncleId = candidateId;
    }
  }
  return {
    topicId,
    parentId: parent.id,
    grandparentId: grandparent.id,
    depth: depth ?? depthBelowRoot(state, topicId),
    parentCosine: dot(centroid, parent.stats.centroid),
    uncleId,
    uncleCosine,
    internalUncleId,
    internalUncleCosine
  };
}

function depthBelowRoot(state: TopicTreeState, topicId: string): number {
  let depth = 0;
  for (let current = getTopic(state, topicId).parentId; current !== null; depth += 1) {
    current = getTopic(state, current).parentId;
  }
  return depth;
}

export interface ReparentTarget {
  topicId: string;
  /** The internal uncle the topic would move under. */
  uncleId: string;
  /** Uncle cosine minus parent cosine (at least audit.misParentMargin). */
  gain: number;
}

/** The internal uncle a topic should move under (D12 mis-parent audit), or null. */
export function reparentTarget(
  state: TopicTreeState,
  config: TopicTreeConfig,
  topicId: string,
  fit: ParentFit | null = parentFit(state, topicId)
): ReparentTarget | null {
  if (fit === null || fit.internalUncleId === null) return null;
  if (getTopic(state, topicId).stats.n === 0) return null;
  const gain = fit.internalUncleCosine - fit.parentCosine;
  return gain >= config.audit.misParentMargin
    ? { topicId, uncleId: fit.internalUncleId, gain }
    : null;
}

export interface MisParentFinding extends ParentFit {
  /** parentCosine - uncleCosine (negative). */
  margin: number;
  /** A re-parent target exists (internal uncle beyond audit.misParentMargin). */
  reparent: ReparentTarget | null;
  /** The topic, its parent or its target uncle is protected: a proposal, never automatic. */
  protected: boolean;
}

export interface MisParentDepthSummary {
  depth: number;
  /** Live topics at this depth (the share's denominator). */
  topics: number;
  misParented: number;
  share: number;
  /** Mean finite parent margin over the depth's topics. */
  meanMargin: number | null;
}

export interface MisParentAudit {
  /** Mis-parented topics, in pre-order. */
  findings: MisParentFinding[];
  byDepth: MisParentDepthSummary[];
}

/** The mis-parent audit over the live tree (deterministic; centroids must be current). */
export function misParentAudit(state: TopicTreeState, config: TopicTreeConfig): MisParentAudit {
  const findings: MisParentFinding[] = [];
  const depths = new Map<
    number,
    { topics: number; mis: number; marginSum: number; finite: number }
  >();
  walkTopics(state, (node, depth) => {
    if (depth === 0) return;
    const summary = depths.get(depth) ?? { topics: 0, mis: 0, marginSum: 0, finite: 0 };
    summary.topics += 1;
    depths.set(depth, summary);
    const fit = parentFit(state, node.id, depth);
    if (fit === null) return;
    const margin = parentMargin(fit);
    if (Number.isFinite(margin)) {
      summary.marginSum += margin;
      summary.finite += 1;
    }
    if (!(margin < 0)) return;
    summary.mis += 1;
    const reparent = reparentTarget(state, config, node.id, fit);
    const involved = [node.id, fit.parentId, ...(reparent ? [reparent.uncleId] : [])];
    findings.push({
      ...fit,
      margin,
      reparent,
      protected: involved.some((id) => isProtected(getTopic(state, id)))
    });
  });
  const byDepth = [...depths.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, summary]) => ({
      depth,
      topics: summary.topics,
      misParented: summary.mis,
      share: summary.topics > 0 ? summary.mis / summary.topics : 0,
      meanMargin: summary.finite > 0 ? summary.marginSum / summary.finite : null
    }));
  return { findings, byDepth };
}

// ---------------------------------------------------------------------------
// Exact recompute sample (D7)

/**
 * Largest |LS - exact LS| an audit tolerates per counted member before it calls a topic's
 * statistics drifted. It is a float tolerance, not a product threshold: add/subtract within one
 * engine run stays orders of magnitude below it, and any real inconsistency is far above it.
 */
export const statsDriftTolerancePerItem = 1e-6;

export interface StatsCheck {
  topicId: string;
  /** Stored N minus the exact N. */
  countError: number;
  /** |stored LS - exact LS|. */
  sumError: number;
  drifted: boolean;
}

/** Exact N and LS of a live subtree, summed like stats.ts (children by ID, then direct items). */
function exactSubtreeStats(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  id: string,
  dim: number
): { n: number; ls: Float64Array } {
  const node = getTopic(state, id);
  const ls = new Float64Array(dim);
  let n = 0;
  for (const childId of [...node.children].sort(compareStrings)) {
    const child = exactSubtreeStats(state, vectors, childId, dim);
    n += child.n;
    addVec(ls, child.ls);
  }
  for (const item of node.items) {
    const row = statsRow(state, vectors, item);
    if (row === undefined) continue;
    n += 1;
    addRow(ls, vectors.matrix, row);
  }
  return { n, ls };
}

/** Smallest content hash in a subtree (the D22 order of topics with fresh UUIDs). */
function anchorOf(state: TopicTreeState, id: string): string {
  let anchor: string | null = null;
  for (const item of subtreeItems(state, id)) {
    const hash = getItem(state, item).contentHash;
    if (anchor === null || compareStrings(hash, anchor) < 0) anchor = hash;
  }
  return anchor ?? `empty:${id}`;
}

/**
 * Compares the stored statistics of `audit.exactRecomputeSample` live topics (a seeded sample in
 * content-anchor order, so it does not depend on UUIDs) with an exact recompute.
 */
export function exactRecomputeSample(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  config: TopicTreeConfig,
  seed: number
): StatsCheck[] {
  const live: { id: string; anchor: string }[] = [];
  walkTopics(state, (node) => live.push({ id: node.id, anchor: anchorOf(state, node.id) }));
  live.sort((a, b) => compareStrings(a.anchor, b.anchor) || compareStrings(a.id, b.id));
  const rng = createRng(deriveSeed(seed, `audit:${state.generation}`));
  const sample = rng
    .shuffle(live.map((entry) => entry.id))
    .slice(0, config.audit.exactRecomputeSample);
  return sample.map((topicId) => {
    const stored = getTopic(state, topicId).stats;
    const exact = exactSubtreeStats(state, vectors, topicId, state.dim);
    const difference = new Float64Array(state.dim);
    addVec(difference, stored.ls);
    addVec(difference, exact.ls, -1);
    const sumError = norm(difference);
    const countError = stored.n - exact.n;
    return {
      topicId,
      countError,
      sumError,
      drifted: countError !== 0 || sumError > statsDriftTolerancePerItem * Math.max(1, exact.n)
    };
  });
}

// ---------------------------------------------------------------------------
// The audit

export interface FlaggedItems {
  needsGate: number;
  needsSplitCheck: number;
  needsVector: number;
}

export interface TopicTreeAudit {
  invariants: InvariantReport;
  /** Share of expected items with a primary placement reachable from the root. */
  reachability: number;
  /** I1 violations (unplaced or unreachable items, unreachable topics). */
  unreachable: InvariantViolation[];
  misParent: MisParentAudit;
  /** Mis-parent findings with an automatic re-parent target (the rest wait or are proposals). */
  reparentCandidates: MisParentFinding[];
  statsChecks: StatsCheck[];
  /** Topics REBALANCE or the sweep should recompute: dirty flags plus drifted samples. */
  recomputeTopics: string[];
  flaggedItems: FlaggedItems;
}

export interface AuditOptions {
  /** Items that must be reachable (default: every registered item). */
  expectedItems?: Iterable<ItemKey>;
  /** The root's fan-out band is the Areas band (D12). */
  areasActive?: boolean;
  /** Seed of the exact-recompute sample. */
  seed: number;
}

export function auditTopicTree(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  config: TopicTreeConfig,
  options: AuditOptions
): TopicTreeAudit {
  const expected = [...(options.expectedItems ?? state.items.keys())];
  const invariants = checkInvariants(state, config, {
    expectedItems: expected,
    ...(options.areasActive === undefined ? {} : { areasActive: options.areasActive })
  });
  const unreachable = invariants.violations.filter((violation) => violation.code === "I1");
  const unreachableItems = new Set(
    unreachable.flatMap((violation) => (violation.item === null ? [] : [violation.item]))
  );
  const reachable = expected.filter((item) => !unreachableItems.has(item)).length;
  const misParent = misParentAudit(state, config);
  const statsChecks = exactRecomputeSample(state, vectors, config, options.seed);
  const recompute = new Set<string>();
  walkTopics(state, (node: TopicNode) => {
    if (node.control.dirty) recompute.add(node.id);
  });
  for (const check of statsChecks) if (check.drifted) recompute.add(check.topicId);
  const flaggedItems: FlaggedItems = { needsGate: 0, needsSplitCheck: 0, needsVector: 0 };
  for (const key of state.placements.keys()) {
    const placement = primaryPlacement(state, key);
    if (!placement) continue;
    if (placement.needsGate) flaggedItems.needsGate += 1;
    if (placement.needsSplitCheck) flaggedItems.needsSplitCheck += 1;
    if (placement.needsVector) flaggedItems.needsVector += 1;
  }
  return {
    invariants,
    reachability: expected.length > 0 ? reachable / expected.length : 1,
    unreachable,
    misParent,
    reparentCandidates: misParent.findings.filter((finding) => finding.reparent !== null),
    statsChecks,
    recomputeTopics: [...recompute].sort(compareStrings),
    flaggedItems
  };
}
