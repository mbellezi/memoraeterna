// Tree invariants I1-I9 (docs/plan.md 4.1). Each check is marked hard or soft; limits come from
// the typed configuration. Violations on protected topics (human or pinned) are reported as
// awaiting approval: automation never repairs them, so they never count as hard violations.
//
//   I1 every expected item has one primary placement reachable from the root     hard
//   I2 one primary, at most `secondary.max` secondaries off the primary path, no cycles  hard
//   I3 internal fan-out within fanOut.min..max (the root: the Areas band once Areas exist)
//      soft; above fanOut.hardMax hard
//   I4 a leaf holds leaf.min..leaf.max direct items      soft; above leaf.hardMax hard
//   I5 depth up to depth.target                           soft; beyond depth.cap hard
//   I6 no single-child chains                             soft
//   I7 unique sibling titles, case- and accent-insensitive   hard
//   I8 leaf coherence above the calibrated floor (only with the coherence split signal)  soft
//   I9 IDs are never reused; retired topics are empty redirects to live topics   hard
import type { TopicHealth } from "../topics.js";
import type { TopicTreeConfig } from "./config.js";
import { normalizeTopicTitle } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { getTopic, isLive, isProtected, pathOf } from "./state.js";
import type { TopicNode, TopicTreeState } from "./state.js";
import { coherenceOf } from "./stats.js";

export const invariantCodes = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9"] as const;
export type InvariantCode = (typeof invariantCodes)[number];

/** Which severities each invariant can produce. */
export const invariantSeverities: Record<InvariantCode, readonly ("hard" | "soft")[]> = {
  I1: ["hard"],
  I2: ["hard"],
  I3: ["soft", "hard"],
  I4: ["soft", "hard"],
  I5: ["soft", "hard"],
  I6: ["soft"],
  I7: ["hard"],
  I8: ["soft"],
  I9: ["hard"]
};

export interface InvariantViolation {
  code: InvariantCode;
  severity: "hard" | "soft";
  /** Machine-readable reason, e.g. `fan-out-above-hard-max`. */
  reason: string;
  topicId: string | null;
  item: ItemKey | null;
  /** On a protected topic: listed for approval, never repaired automatically. */
  awaitingApproval: boolean;
  /** The measured value (fan-out, size, depth, coherence) when there is one. */
  value: number | null;
}

export interface InvariantReport {
  violations: InvariantViolation[];
  /** Hard violations on AI-managed topics and items (the E1 count). */
  hard: number;
  soft: number;
  awaitingApproval: number;
}

export interface InvariantOptions {
  /** Items that must be reachable (default: every registered item). */
  expectedItems?: Iterable<ItemKey>;
  /** The root's fan-out band is the Areas band (D12): set once the tree has Areas. */
  areasActive?: boolean;
}

export function checkInvariants(
  state: TopicTreeState,
  config: TopicTreeConfig,
  options: InvariantOptions = {}
): InvariantReport {
  const violations: InvariantViolation[] = [];
  const report = (
    code: InvariantCode,
    severity: "hard" | "soft",
    reason: string,
    where: { topicId?: string | null; item?: ItemKey | null; value?: number | null }
  ): void => {
    const topic = where.topicId ? state.topics.get(where.topicId) : undefined;
    violations.push({
      code,
      severity,
      reason,
      topicId: where.topicId ?? null,
      item: where.item ?? null,
      awaitingApproval: topic !== undefined && isProtected(topic),
      value: where.value ?? null
    });
  };

  const root = state.topics.get(state.rootId);
  if (!root || root.parentId !== null || root.role !== "root" || !isLive(root)) {
    report("I2", "hard", "invalid-root", { topicId: state.rootId });
  }

  // Walk the live tree from the root.
  const visited = new Set<string>();
  const reachedItems = new Map<ItemKey, string>();
  const stack: { id: string; depth: number }[] = root ? [{ id: root.id, depth: 0 }] : [];
  while (stack.length > 0) {
    const { id, depth } = stack.pop() as { id: string; depth: number };
    if (visited.has(id)) {
      report("I2", "hard", "cycle-or-shared-child", { topicId: id });
      continue;
    }
    visited.add(id);
    const node = getTopic(state, id);
    if (!isLive(node)) report("I9", "hard", "retired-topic-in-tree", { topicId: id });
    for (const item of node.items) {
      if (reachedItems.has(item)) report("I2", "hard", "item-placed-twice", { topicId: id, item });
      reachedItems.set(item, id);
    }
    checkShape(state, config, options, node, depth, report);
    for (const child of node.children) {
      if (getTopic(state, child).parentId !== id) {
        report("I2", "hard", "stale-parent-pointer", { topicId: child });
      }
      stack.push({ id: child, depth: depth + 1 });
    }
  }

  for (const node of state.topics.values()) {
    if (isLive(node)) {
      if (!visited.has(node.id)) report("I1", "hard", "topic-unreachable", { topicId: node.id });
      if (node.redirectTo !== null)
        report("I9", "hard", "live-topic-redirects", { topicId: node.id });
    } else {
      checkRetired(state, node, report);
    }
  }

  checkPlacements(state, config, reachedItems, report);

  const expected = options.expectedItems ?? state.items.keys();
  for (const item of expected) {
    // A primary on an unreachable topic is reported by checkPlacements.
    if (!state.placements.get(item)?.some((placement) => placement.rank === 0)) {
      report("I1", "hard", "item-unplaced", { item });
    }
  }

  let hard = 0;
  let soft = 0;
  let awaitingApproval = 0;
  for (const violation of violations) {
    if (violation.awaitingApproval) awaitingApproval += 1;
    else if (violation.severity === "hard") hard += 1;
    else soft += 1;
  }
  return { violations, hard, soft, awaitingApproval };
}

type Reporter = (
  code: InvariantCode,
  severity: "hard" | "soft",
  reason: string,
  where: { topicId?: string | null; item?: ItemKey | null; value?: number | null }
) => void;

function checkShape(
  state: TopicTreeState,
  config: TopicTreeConfig,
  options: InvariantOptions,
  node: TopicNode,
  depth: number,
  report: Reporter
): void {
  const topicId = node.id;
  const isRoot = node.id === state.rootId;
  if (depth > config.depth.cap) report("I5", "hard", "depth-above-cap", { topicId, value: depth });
  if (node.children.length === 0) {
    if (!isRoot) {
      const size = node.items.length;
      if (size > config.leaf.hardMax) {
        report("I4", "hard", "leaf-above-hard-max", { topicId, value: size });
      } else if (size < config.leaf.min || size > config.leaf.max) {
        report("I4", "soft", "leaf-size-outside-range", { topicId, value: size });
      }
      if (depth > config.depth.target && depth <= config.depth.cap) {
        report("I5", "soft", "depth-above-target", { topicId, value: depth });
      }
      const { signal, threshold } = config.splitSignal;
      const coherence = coherenceOf(node.stats);
      if (
        signal === "coherence" &&
        threshold !== null &&
        node.stats.n >= 2 &&
        coherence < threshold
      ) {
        report("I8", "soft", "coherence-below-floor", { topicId, value: coherence });
      }
    }
    return;
  }
  const fanOut = node.children.length;
  const [min, max] =
    isRoot && options.areasActive
      ? [config.areas.min, config.areas.max]
      : [config.fanOut.min, config.fanOut.max];
  if (fanOut > config.fanOut.hardMax) {
    report("I3", "hard", "fan-out-above-hard-max", { topicId, value: fanOut });
  } else if (fanOut < min || fanOut > max) {
    report("I3", "soft", "fan-out-outside-range", { topicId, value: fanOut });
  }
  if (fanOut === 1) report("I6", "soft", "single-child", { topicId });
  const titles = new Set<string>();
  for (const childId of node.children) {
    const title = getTopic(state, childId).title;
    if (title === null) continue;
    const key = normalizeTopicTitle(title);
    if (titles.has(key)) report("I7", "hard", "duplicate-sibling-title", { topicId: childId });
    titles.add(key);
  }
}

function checkRetired(state: TopicTreeState, node: TopicNode, report: Reporter): void {
  const topicId = node.id;
  if (node.children.length > 0 || node.items.length > 0 || node.secondaryItems.length > 0) {
    report("I9", "hard", "retired-topic-not-empty", { topicId });
  }
  const seen = new Set<string>([node.id]);
  let current = node.redirectTo;
  while (current !== null) {
    const next = state.topics.get(current);
    if (!next || seen.has(current)) {
      report("I9", "hard", "broken-redirect", { topicId });
      return;
    }
    if (isLive(next)) return;
    seen.add(current);
    current = next.redirectTo;
  }
}

function checkPlacements(
  state: TopicTreeState,
  config: TopicTreeConfig,
  reachedItems: Map<ItemKey, string>,
  report: Reporter
): void {
  for (const [item, placements] of state.placements) {
    const primary = placements.find((placement) => placement.rank === 0);
    const secondaries = placements.filter((placement) => placement.rank > 0);
    if (secondaries.length > config.secondary.max) {
      report("I2", "hard", "too-many-secondaries", { item, value: secondaries.length });
    }
    if (primary && reachedItems.get(item) !== primary.topicId) {
      report("I1", "hard", "primary-not-reachable", { topicId: primary.topicId, item });
    }
    const primaryPath =
      primary && state.topics.has(primary.topicId) && isLive(getTopic(state, primary.topicId))
        ? new Set(pathOf(state, primary.topicId))
        : new Set<string>();
    for (const secondary of secondaries) {
      const topic = state.topics.get(secondary.topicId);
      if (!primary) report("I2", "hard", "secondary-without-primary", { item });
      if (!topic || !isLive(topic)) {
        report("I1", "hard", "secondary-on-retired-topic", { topicId: secondary.topicId, item });
      } else if (primaryPath.has(secondary.topicId)) {
        report("I2", "hard", "secondary-on-primary-path", { topicId: secondary.topicId, item });
      }
    }
  }
}

/** Health of one topic from its own violations: a hard one is a violation, a soft one attention. */
export function topicHealth(violations: readonly InvariantViolation[]): TopicHealth {
  if (violations.some((violation) => violation.severity === "hard")) return "violation";
  return violations.length > 0 ? "attention" : "good";
}

/** Violations grouped by topic (item-level violations are left out). */
export function violationsByTopic(report: InvariantReport): Map<string, InvariantViolation[]> {
  const output = new Map<string, InvariantViolation[]>();
  for (const violation of report.violations) {
    if (violation.topicId === null) continue;
    const list = output.get(violation.topicId) ?? [];
    list.push(violation);
    output.set(violation.topicId, list);
  }
  return output;
}
