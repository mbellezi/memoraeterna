// Stability controls of REBALANCE (plan 4.1 "Stability"): per-topic cooldown, freeze on topics
// the user recently opened or edited, daily operation and move budgets, recently opened items
// weighted up in churn, and the exact churn of a set of structure events. Hysteresis is the band
// model of quality.ts; the "moved from X" hint is written by the operations (ShapeContext
// markMoves). Protection (human and pinned topics) is not a stability control: operations.ts
// turns anything that touches protected structure into a proposal.
import type { TopicChangeSetRisk } from "../topics.js";
import type { TopicTreeConfig } from "./config.js";
import type { StructureEvent } from "./events.js";
import type { ItemKey } from "./ids.js";
import { getTopic, isLive, pathOf, primaryPlacement, subtreeItems } from "./state.js";
import type { TopicTreeState } from "./state.js";

// ---------------------------------------------------------------------------
// Local day and daily budgets

/** The local calendar day (YYYY-MM-DD) of an instant in an IANA time zone. */
export function localDay(instant: string | Date, timeZone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid instant ${String(instant)}`);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Items with a placement (the base of the daily move budget and of churn shares). */
export function placedItemCount(state: TopicTreeState): number {
  return state.placements.size;
}

export interface DailyBudgetStatus {
  day: string;
  maxOperations: number;
  maxMovedItems: number;
  operationsUsed: number;
  movedItemsUsed: number;
  operationsLeft: number;
  movedItemsLeft: number;
}

/**
 * The soft-operation budget left on `day`: stability.dailyOperations operations and
 * max(dailyMovedMin, dailyMovedShare x placed items) moved items. A new day starts from zero.
 */
export function dailyBudget(
  state: TopicTreeState,
  config: TopicTreeConfig,
  day: string,
  totalItems: number = placedItemCount(state)
): DailyBudgetStatus {
  const { dailyOperations, dailyMovedShare, dailyMovedMin } = config.stability;
  const sameDay = state.budget.day === day;
  const operationsUsed = sameDay ? state.budget.operations : 0;
  const movedItemsUsed = sameDay ? state.budget.movedItems : 0;
  const maxMovedItems = Math.max(dailyMovedMin, Math.floor(dailyMovedShare * totalItems));
  return {
    day,
    maxOperations: dailyOperations,
    maxMovedItems,
    operationsUsed,
    movedItemsUsed,
    operationsLeft: Math.max(0, dailyOperations - operationsUsed),
    movedItemsLeft: Math.max(0, maxMovedItems - movedItemsUsed)
  };
}

/** Records one applied soft operation and the items it moved against `day`'s budget. */
export function consumeDailyBudget(state: TopicTreeState, day: string, movedItems: number): void {
  if (state.budget.day !== day) state.budget = { day, operations: 0, movedItems: 0 };
  state.budget.operations += 1;
  state.budget.movedItems += movedItems;
}

// ---------------------------------------------------------------------------
// Cooldown and freeze

/** A soft repair on a topic waits repair.cooldownInserts inserts after its previous repair. */
export function isCoolingDown(
  state: TopicTreeState,
  config: TopicTreeConfig,
  topicId: string
): boolean {
  const clock = getTopic(state, topicId).control.repairClock;
  return clock !== null && state.clock - clock < config.repair.cooldownInserts;
}

export interface TopicOpen {
  topicId: string;
  /** When the user opened or edited the topic (ISO timestamp). */
  at: string;
}

/** Topics opened or edited within stability.freezeHours of `now` (the service reads view_history). */
export function recentlyOpenedTopics(
  opens: Iterable<TopicOpen>,
  now: string,
  config: TopicTreeConfig
): Set<string> {
  const end = Date.parse(now);
  const start = end - config.stability.freezeHours * 3_600_000;
  const output = new Set<string>();
  for (const open of opens) {
    const at = Date.parse(open.at);
    if (at >= start && at <= end) output.add(open.topicId);
  }
  return output;
}

/** Freezes exactly the given topics (unknown and retired ones are ignored); thaws the rest. */
export function setFrozenTopics(state: TopicTreeState, topicIds: Iterable<string>): void {
  const frozen = new Set(topicIds);
  for (const node of state.topics.values()) node.control.frozen = frozen.has(node.id);
}

// ---------------------------------------------------------------------------
// Events: the topics they touch and the churn they cause

/** Every topic an event names: its subject, the parents before and after, item topics. */
export function eventTopics(event: StructureEvent): string[] {
  const ids = [event.topicId];
  switch (event.op) {
    case "topic.create":
      ids.push(...[event.before?.parentId, event.after?.parentId].filter(isString));
      break;
    case "topic.move":
      ids.push(event.before.parentId, event.after.parentId);
      break;
    case "topic.retire":
    case "topic.restore":
      ids.push(...[event.before.redirectTo, event.after.redirectTo].filter(isString));
      break;
    case "item.place":
      ids.push(event.after.topicId);
      break;
    case "item.unplace":
      ids.push(event.before.topicId);
      break;
    case "item.move":
      ids.push(event.before.topicId, event.after.topicId);
      break;
    default:
      break;
  }
  return ids;
}

function isString(value: string | null | undefined): value is string {
  return typeof value === "string";
}

/** The distinct topics named by a list of events (see eventTopics). */
export function eventsTopics(events: readonly StructureEvent[]): Set<string> {
  const output = new Set<string>();
  for (const event of events) for (const id of eventTopics(event)) output.add(id);
  return output;
}

export interface EventChurn {
  /** Items whose primary path (topic IDs from the root) changed, in first-seen order. */
  items: ItemKey[];
  /** items, with recently opened ones counted stability.recentChurnWeight times. */
  weighted: number;
  /** How many of `items` were recently opened. */
  recent: number;
}

/**
 * Items whose primary path changed between the state before `events` and `state` (after them),
 * computed from the events alone: an item's before-path follows the first recorded parent of
 * every moved topic and its first recorded primary topic. Only items placed both before and after
 * count (a first placement or a removal is not churn). A rename is not churn; a merge or a move is
 * (E3). Redirects are not resolved, so an item that left a retired topic counts.
 */
export function eventChurn(
  state: TopicTreeState,
  events: readonly StructureEvent[],
  config: TopicTreeConfig,
  recentItems: ReadonlySet<ItemKey> = new Set()
): EventChurn {
  const beforeParent = new Map<string, string | null>();
  const beforeTopic = new Map<ItemKey, string | null>();
  const movedTopics: string[] = [];
  for (const event of events) {
    if (event.op === "topic.move") {
      if (!beforeParent.has(event.topicId)) beforeParent.set(event.topicId, event.before.parentId);
      movedTopics.push(event.topicId);
    } else if (
      event.op === "item.place" ||
      event.op === "item.unplace" ||
      event.op === "item.move"
    ) {
      const rank = (event.before ?? event.after)?.rank;
      if (rank !== 0 || beforeTopic.has(event.item)) continue;
      beforeTopic.set(event.item, event.before === null ? null : event.before.topicId);
    }
  }
  const candidates = new Set<ItemKey>(beforeTopic.keys());
  for (const id of movedTopics) {
    const node = state.topics.get(id);
    if (node && isLive(node)) for (const item of subtreeItems(state, id)) candidates.add(item);
  }
  const parentBefore = (id: string): string | null => {
    if (beforeParent.has(id)) return beforeParent.get(id) as string | null;
    return getTopic(state, id).parentId;
  };
  const pathBefore = (topicId: string): string => {
    const path: string[] = [];
    for (let current: string | null = topicId; current !== null; current = parentBefore(current)) {
      path.push(current);
      if (path.length > state.topics.size) throw new Error(`Cycle above topic ${topicId}`);
    }
    return path.reverse().join("/");
  };
  const items: ItemKey[] = [];
  let weighted = 0;
  let recent = 0;
  for (const item of candidates) {
    const earlier = beforeTopic.has(item)
      ? (beforeTopic.get(item) ?? null)
      : (primaryPlacement(state, item)?.topicId ?? null);
    const later = primaryPlacement(state, item)?.topicId ?? null;
    if (earlier === null || later === null) continue;
    if (pathBefore(earlier) === pathOf(state, later).join("/")) continue;
    items.push(item);
    const isRecent = recentItems.has(item);
    if (isRecent) recent += 1;
    weighted += isRecent ? config.stability.recentChurnWeight : 1;
  }
  return { items, weighted, recent };
}

/** Risk of a change-set from the share of items it moved (D29 lists high-risk ones for review). */
export function changeSetRisk(movedShare: number, config: TopicTreeConfig): TopicChangeSetRisk {
  if (movedShare > config.rebuild.reviewChurnShare) return "high";
  if (movedShare > config.repair.softMoveShare) return "medium";
  return "low";
}
