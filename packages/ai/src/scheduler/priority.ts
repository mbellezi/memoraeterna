import type { AiLaneRuntimeConfig } from "../runtime-config.js";
import { aiPriorities, type AiPriority, type LaneReservation } from "./types.js";

/** The audit number of a priority: 0 for P0 to 3 for P3. */
export function priorityNumber(priority: AiPriority): number {
  return aiPriorities.indexOf(priority);
}

export function isAiPriority(value: unknown): value is AiPriority {
  return typeof value === "string" && (aiPriorities as readonly string[]).includes(value);
}

/**
 * The rank an entry competes with after waiting `waitedMs` (0 = P0 ... 3 = P3). A P3 entry competes
 * as P2 after `p3ToP2Ms` and as P1 after a further `p2ToP1Ms`; a P2 entry as P1 after `p2ToP1Ms`.
 * Nothing ages into P0, and P1 stays P1.
 */
export function effectiveRank(
  priority: AiPriority,
  waitedMs: number,
  aging: AiLaneRuntimeConfig["aging"]
): number {
  switch (priority) {
    case "P0":
      return 0;
    case "P1":
      return 1;
    case "P2":
      return waitedMs >= aging.p2ToP1Ms ? 1 : 2;
    case "P3":
      if (waitedMs >= aging.p3ToP2Ms + aging.p2ToP1Ms) return 1;
      return waitedMs >= aging.p3ToP2Ms ? 2 : 3;
  }
}

export interface RankedEntry extends LaneReservation {
  readonly priority: AiPriority;
}

/**
 * The index of the entry a free slot goes to: the lowest effective rank at `now`, then the earliest
 * admission, then the admission order. Returns -1 for an empty list.
 */
export function selectNext(
  waiting: readonly RankedEntry[],
  now: number,
  aging: AiLaneRuntimeConfig["aging"]
): number {
  let best = -1;
  let bestRank = Number.POSITIVE_INFINITY;
  for (let index = 0; index < waiting.length; index++) {
    const entry = waiting[index]!;
    const rank = effectiveRank(entry.priority, now - entry.admittedAt, aging);
    if (best < 0 || rank < bestRank || (rank === bestRank && before(entry, waiting[best]!))) {
      best = index;
      bestRank = rank;
    }
  }
  return best;
}

function before(left: LaneReservation, right: LaneReservation): boolean {
  return (
    left.admittedAt < right.admittedAt ||
    (left.admittedAt === right.admittedAt && left.sequence < right.sequence)
  );
}
