// Measurements of the replay: agreement with ground-truth labels, the E1 audit and E3 primary-path
// churn. Pure functions over the T03 state and a labelled dataset.
import {
  checkInvariants,
  getTopic,
  isLive,
  leafLabels,
  nmi,
  pathOf,
  primaryPlacement,
  purity,
  resolveTopicId,
  rowItemKey,
  shapeReport,
  walkTopics
} from "@app/domain/topic-tree";
import type { ItemKey, TopicTreeConfig, TopicTreeState } from "@app/domain/topic-tree";

import type { ReplayDataset } from "./datasets.js";
import type { AuditReport, TruthSummary } from "./report-data.js";

/** The `row:<n>` keys of dataset rows. */
export function rowKeys(rows: readonly number[]): ItemKey[] {
  return rows.map(rowItemKey);
}

/** The topic at `depth` on each item's primary path (the topic itself when shallower), as ids. */
export function depthLabels(
  state: TopicTreeState,
  items: readonly ItemKey[],
  depth: number
): Int32Array {
  const ids = new Map<string, number>();
  return Int32Array.from(items, (item) => {
    const placement = primaryPlacement(state, item);
    if (!placement) return -1;
    const path = pathOf(state, placement.topicId);
    const topicId = path[Math.min(depth, path.length - 1)] as string;
    if (!ids.has(topicId)) ids.set(topicId, ids.size);
    return ids.get(topicId) as number;
  });
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

/** Agreement of the tree over `rows` with the dataset's labels; null when it has no domains. */
export function truthSummary(
  state: TopicTreeState,
  dataset: ReplayDataset,
  rows: readonly number[]
): TruthSummary | null {
  if (!dataset.hasDomains || rows.length === 0) return null;
  const keys = rowKeys(rows);
  const domain = Int32Array.from(rows, (row) => dataset.labels.domain[row] as number);
  const group = Int32Array.from(rows, (row) => dataset.labels.group[row] as number);
  const leaves = leafLabels(state, keys);
  return {
    leafDomainPurity: round(purity(leaves, domain)),
    depth1NmiDomain: round(nmi(depthLabels(state, keys, 1), domain)),
    depth2NmiDomain: round(nmi(depthLabels(state, keys, 2), domain)),
    leafNmiGroup: round(nmi(leaves, group))
  };
}

/** Rows that currently have a primary placement. */
export function placedRows(state: TopicTreeState): number[] {
  const rows: number[] = [];
  for (const [item, placements] of state.placements) {
    if (placements.length === 0) continue;
    const row = Number(item.slice("row:".length));
    if (Number.isInteger(row)) rows.push(row);
  }
  return rows.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// E1: reachability, orphans, hard violations

export function auditState(
  state: TopicTreeState,
  config: TopicTreeConfig,
  rows: readonly number[]
): Pick<
  AuditReport,
  | "expectedItems"
  | "reachable"
  | "reachability"
  | "orphans"
  | "hardViolations"
  | "hardViolationCount"
  | "awaitingApproval"
  | "passes"
> {
  const keys = rowKeys(rows);
  const shape = shapeReport(state, config, { expectedItems: keys });
  const invariants = checkInvariants(state, config, { expectedItems: keys });
  const visited = new Set<string>();
  walkTopics(state, (node) => {
    visited.add(node.id);
  });
  let unreachableTopics = 0;
  for (const node of state.topics.values()) {
    if (isLive(node) && !visited.has(node.id)) unreachableTopics += 1;
  }
  let placementsOnRetired = 0;
  for (const placements of state.placements.values()) {
    for (const placement of placements) {
      const topic = state.topics.get(placement.topicId);
      if (!topic || !isLive(topic)) placementsOnRetired += 1;
    }
  }
  const itemsWithoutPrimary = keys.filter(
    (item) => primaryPlacement(state, item) === undefined
  ).length;
  const orphans = {
    unreachableTopics,
    placementsOnRetiredTopics: placementsOnRetired,
    itemsWithoutPrimary
  };
  const hardCount = shape.violations.hardCount;
  return {
    expectedItems: keys.length,
    reachable: shape.reachable,
    reachability: round(shape.reachability, 6),
    orphans,
    hardViolations: shape.violations.hard,
    hardViolationCount: hardCount,
    awaitingApproval: invariants.awaitingApproval,
    passes:
      shape.reachability === 1 &&
      unreachableTopics === 0 &&
      placementsOnRetired === 0 &&
      itemsWithoutPrimary === 0 &&
      hardCount === 0
  };
}

// ---------------------------------------------------------------------------
// E3: primary-path churn

/** Root-to-topic path ids of each placed row's primary placement, at one moment. */
export interface PathSnapshot {
  rows: number[];
  paths: string[][];
}

export function pathSnapshot(state: TopicTreeState, rows: readonly number[]): PathSnapshot {
  const kept: number[] = [];
  const paths: string[][] = [];
  for (const row of rows) {
    const placement = primaryPlacement(state, rowItemKey(row));
    if (!placement) continue;
    kept.push(row);
    paths.push(pathOf(state, placement.topicId));
  }
  return { rows: kept, paths };
}

export interface ChurnMeasurement {
  /** Items present at the snapshot. */
  items: number;
  /** Their primary path (topic IDs from the root) differs now. A rename is not churn; a merge is. */
  changed: number;
  /** `changed / items`. */
  churn: number;
  /**
   * Changes left after mapping the old path through redirects (a retired topic's successor): what a
   * link to the old path still reaches. Reported beside the E3 figure, never instead of it.
   */
  changedAfterRedirects: number;
}

export function churnSince(snapshot: PathSnapshot, state: TopicTreeState): ChurnMeasurement {
  let changed = 0;
  let changedAfterRedirects = 0;
  const resolved = new Map<string, string>();
  const resolve = (id: string): string => {
    let value = resolved.get(id);
    if (value === undefined) {
      value = resolveTopicId(state, id);
      resolved.set(id, value);
    }
    return value;
  };
  snapshot.rows.forEach((row, index) => {
    const placement = primaryPlacement(state, rowItemKey(row));
    const before = snapshot.paths[index] as string[];
    const after = placement ? pathOf(state, placement.topicId) : null;
    const same = (a: readonly string[], b: readonly string[] | null): boolean =>
      b !== null && a.length === b.length && a.every((id, at) => id === b[at]);
    if (same(before, after)) return;
    changed += 1;
    if (!same(before.map(resolve), after)) changedAfterRedirects += 1;
  });
  const items = snapshot.rows.length;
  return {
    items,
    changed,
    churn: items > 0 ? changed / items : 0,
    changedAfterRedirects
  };
}

/** The `count` topics that received the most of `rows`, by current primary topic (ties by id). */
export function fastestGrowingTopics(
  state: TopicTreeState,
  rows: readonly number[],
  count: number
): string[] {
  const received = new Map<string, number>();
  for (const row of rows) {
    const placement = primaryPlacement(state, rowItemKey(row));
    if (!placement) continue;
    const topic = state.topics.get(placement.topicId);
    if (!topic || !isLive(topic) || topic.id === state.rootId) continue;
    received.set(topic.id, (received.get(topic.id) ?? 0) + 1);
  }
  return [...received.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, count)
    .map(([id]) => id);
}

/** Children of the root: the Areas. */
export function rootChildCount(state: TopicTreeState): number {
  return getTopic(state, state.rootId).children.length;
}
