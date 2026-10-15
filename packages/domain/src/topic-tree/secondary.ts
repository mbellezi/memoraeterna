// Secondary "also in" placements (plan 4.1, I2): up to `secondary.max` (at most 2) further leaves
// an item is admitted to and scores nearly as well as its primary leaf (within
// `secondary.maxScoreGap`). A secondary is never on the primary path (the primary topic or one of
// its ancestors), never on the root and never twice on one topic. Secondaries do not count in the
// statistics (D7, D8): only primary placements do.
import { topicLimits } from "../topics.js";
import type { TopicTreeConfig } from "./config.js";
import { compareStrings } from "./ids.js";
import type { ItemKey } from "./ids.js";
import type { PlacementCandidate } from "./place.js";
import { isLive, pathOf, placementsOf } from "./state.js";
import type { PlacementRecord, TopicTreeState } from "./state.js";

/** How many secondaries an item may hold: `secondary.max`, never above the I2 limit of 2. */
export function maxSecondaries(config: TopicTreeConfig): number {
  return Math.min(config.secondary.max, topicLimits.maxSecondaryPlacements);
}

/**
 * The "also in" leaves for an item whose primary is `primary`: admitted live leaves off the
 * primary path that score at least `primary.score - secondary.maxScoreGap`, best first (score,
 * then topic ID), at most `maxSecondaries(config)`.
 */
export function chooseSecondaries(
  state: TopicTreeState,
  config: TopicTreeConfig,
  primary: { topicId: string; score: number },
  candidates: readonly PlacementCandidate[]
): PlacementCandidate[] {
  const max = maxSecondaries(config);
  if (max === 0) return [];
  const primaryPath = new Set(pathOf(state, primary.topicId));
  const floor = primary.score - config.secondary.maxScoreGap;
  const chosen = new Map<string, PlacementCandidate>();
  for (const candidate of candidates) {
    const { topicId } = candidate;
    if (!candidate.admitted || !candidate.leaf || !(candidate.score >= floor)) continue;
    if (topicId === state.rootId || primaryPath.has(topicId) || chosen.has(topicId)) continue;
    const node = state.topics.get(topicId);
    if (!node || !isLive(node) || node.children.length > 0) continue;
    chosen.set(topicId, candidate);
  }
  return [...chosen.values()]
    .sort((a, b) => b.score - a.score || compareStrings(a.topicId, b.topicId))
    .slice(0, max);
}

/**
 * The secondary placements of an item that break I2 in the current state: without a primary, on
 * a missing or retired topic, on the root, on the primary path, or beyond the limit (the highest
 * ranks first go over it).
 */
export function invalidSecondaries(
  state: TopicTreeState,
  config: TopicTreeConfig,
  item: ItemKey
): PlacementRecord[] {
  const placements = placementsOf(state, item);
  const primary = placements.find((placement) => placement.rank === 0);
  const secondaries = placements.filter((placement) => placement.rank > 0);
  const primaryNode = primary ? state.topics.get(primary.topicId) : undefined;
  const primaryPath =
    primary && primaryNode && isLive(primaryNode)
      ? new Set(pathOf(state, primary.topicId))
      : new Set<string>();
  const invalid: PlacementRecord[] = [];
  const valid: PlacementRecord[] = [];
  for (const secondary of secondaries) {
    const node = state.topics.get(secondary.topicId);
    if (
      !primary ||
      !node ||
      !isLive(node) ||
      secondary.topicId === state.rootId ||
      primaryPath.has(secondary.topicId)
    ) {
      invalid.push(secondary);
    } else {
      valid.push(secondary);
    }
  }
  invalid.push(...valid.slice(maxSecondaries(config)));
  return invalid.sort((a, b) => a.rank - b.rank);
}

/** The lowest secondary rank (1..max) the item does not use, or null when all are taken. */
export function freeSecondaryRank(
  state: TopicTreeState,
  config: TopicTreeConfig,
  item: ItemKey
): number | null {
  const used = new Set(placementsOf(state, item).map((placement) => placement.rank));
  for (let rank = 1; rank <= maxSecondaries(config); rank += 1) {
    if (!used.has(rank)) return rank;
  }
  return null;
}
