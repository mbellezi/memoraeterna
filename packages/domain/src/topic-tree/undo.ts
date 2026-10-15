// Exact undo of a change-set (plan 4.1 Events and undo; E5): the inverse of its structure events,
// applied atomically. When later change-sets depend on it, undo is blocked and names them (no
// cascade in v1).
//
// Dependency is decided on facets, the parts of the state an event writes or requires:
//   topic:<id>#life     existence and retirement (retiredAt, redirectTo)
//   topic:<id>#parent   parent and position
//   topic:<id>#name     title, name state and source, name language, aliases
//   topic:<id>#description, topic:<id>#management
//   item:<key>          every placement of the item
// topic.create writes every facet of its topic; retire and restore write #life; move writes
// #parent; rename, describe and manage write their facet; item events write the item. Events also
// require the #life of the topics they attach to (a parent, a placement topic, a redirect target).
// A later change-set blocks the target when one of them writes a facet the other writes or
// requires. A later change-set and the later undo of it cancel out and block nothing.
//
// Global invariants that facets cannot see (a cycle, a duplicate sibling title, a secondary that
// lands on its primary path, the depth cap) are checked by applying the inverse to the state and
// rolling it back when it fails; they are reported as conflicts. Deleted items (D32) are reported
// as `itemDeleted`.
import type { TopicChangeSetStatus } from "../topics.js";
import type { TopicTreeConfig } from "./config.js";
import { StructureEventConflictError, applyEvents, invertEvents } from "./events.js";
import type { AppliedEvents, StructureEvent } from "./events.js";
import { compareStrings, normalizeTopicTitle } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { invalidSecondaries } from "./secondary.js";
import { depthOf, getTopic, heightOf, isLive, subtreeItems } from "./state.js";
import type { TopicTreeState } from "./state.js";

/** What undo needs to know about a change-set (`topic_change_sets` plus its events in order). */
export interface UndoableChangeSet {
  id: string;
  status: TopicChangeSetStatus;
  /** The change-set this one undid (`undo_of`), or null. */
  undoOf: string | null;
  events: readonly StructureEvent[];
}

export const undoConflictCodes = [
  "cycle",
  "duplicateTitle",
  "secondaryOnPrimaryPath",
  "depthCap",
  "state"
] as const;
export type UndoConflictCode = (typeof undoConflictCodes)[number];

export type UndoBlocker =
  | {
      kind: "changeSet";
      changeSetId: string;
      /** The shared objects (`topic:<id>`, `item:<key>`), sorted. */
      objects: string[];
    }
  | { kind: "itemDeleted"; item: ItemKey }
  | { kind: "notApplied"; status: TopicChangeSetStatus }
  | {
      kind: "conflict";
      code: UndoConflictCode;
      topicId: string | null;
      item: ItemKey | null;
      reason: string;
    };

export type UndoResult =
  | {
      kind: "undone";
      /** The applied inverse events: the content of the `undo` change-set. */
      events: StructureEvent[];
      /** Live topics whose paths need an exact recompute (D7). */
      touchedTopics: string[];
    }
  | { kind: "blocked"; blockers: UndoBlocker[] };

// ---------------------------------------------------------------------------
// Footprints

export interface ChangeSetFootprint {
  writes: Set<string>;
  requires: Set<string>;
}

const topicFacets = ["life", "parent", "name", "description", "management"] as const;

function facet(topicId: string, part: (typeof topicFacets)[number]): string {
  return `topic:${topicId}#${part}`;
}

function objectOf(key: string): string {
  const hash = key.indexOf("#");
  return hash < 0 ? key : key.slice(0, hash);
}

/** The facets a list of structure events writes and requires (see the module comment). */
export function changeSetFootprint(events: readonly StructureEvent[]): ChangeSetFootprint {
  const writes = new Set<string>();
  const requires = new Set<string>();
  const live = (id: string | null | undefined): void => {
    if (id !== null && id !== undefined) requires.add(facet(id, "life"));
  };
  for (const event of events) {
    switch (event.op) {
      case "topic.create": {
        for (const part of topicFacets) writes.add(facet(event.topicId, part));
        const record = event.after ?? event.before;
        live(record?.parentId);
        live(record?.redirectTo);
        break;
      }
      case "topic.retire":
      case "topic.restore":
        writes.add(facet(event.topicId, "life"));
        live(event.before.redirectTo);
        live(event.after.redirectTo);
        break;
      case "topic.move":
        writes.add(facet(event.topicId, "parent"));
        live(event.topicId);
        live(event.before.parentId);
        live(event.after.parentId);
        break;
      case "topic.rename":
        writes.add(facet(event.topicId, "name"));
        break;
      case "topic.describe":
        writes.add(facet(event.topicId, "description"));
        break;
      case "topic.manage":
        writes.add(facet(event.topicId, "management"));
        break;
      case "item.place":
      case "item.unplace":
      case "item.move":
        writes.add(`item:${event.item}`);
        live(event.topicId);
        live(event.before?.topicId);
        live(event.after?.topicId);
        break;
    }
  }
  for (const key of writes) requires.delete(key);
  return { writes, requires };
}

function shared(a: ChangeSetFootprint, b: ChangeSetFootprint): string[] {
  const output = new Set<string>();
  for (const key of a.writes) {
    if (b.writes.has(key) || b.requires.has(key)) output.add(objectOf(key));
  }
  for (const key of b.writes) {
    if (a.requires.has(key)) output.add(objectOf(key));
  }
  return [...output].sort(compareStrings);
}

/**
 * The later change-sets that block undoing `target`: `later` lists every change-set applied after
 * it, in apply order, undone ones and undo change-sets included. Change-sets that were never
 * applied are ignored, and a change-set cancels out with a later undo of it.
 */
export function changeSetBlockers(
  target: UndoableChangeSet,
  later: readonly UndoableChangeSet[]
): UndoBlocker[] {
  if (target.status !== "applied") return [{ kind: "notApplied", status: target.status }];
  const effective = later.filter(
    (changeSet) => changeSet.status === "applied" || changeSet.status === "undone"
  );
  const cancelled = new Set<string>();
  const seen = new Set<string>();
  for (const changeSet of effective) {
    const undid = changeSet.undoOf;
    if (undid !== null && seen.has(undid) && !cancelled.has(undid)) {
      cancelled.add(undid);
      cancelled.add(changeSet.id);
    }
    seen.add(changeSet.id);
  }
  const footprint = changeSetFootprint(target.events);
  const blockers: UndoBlocker[] = [];
  for (const changeSet of effective) {
    if (cancelled.has(changeSet.id)) continue;
    const objects = shared(footprint, changeSetFootprint(changeSet.events));
    if (objects.length > 0)
      blockers.push({ kind: "changeSet", changeSetId: changeSet.id, objects });
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// Applying the inverse

function deletedItems(state: TopicTreeState, events: readonly StructureEvent[]): UndoBlocker[] {
  const items = new Set<ItemKey>();
  for (const event of events) {
    if ("item" in event && !state.items.has(event.item)) items.add(event.item);
  }
  return [...items].sort(compareStrings).map((item) => ({ kind: "itemDeleted", item }));
}

function conflict(
  code: UndoConflictCode,
  reason: string,
  where: { topicId?: string | null; item?: ItemKey | null } = {}
): UndoBlocker {
  return {
    kind: "conflict",
    code,
    topicId: where.topicId ?? null,
    item: where.item ?? null,
    reason
  };
}

/** Invariants the applied inverse may break that event preconditions do not check. */
function inverseConflicts(
  state: TopicTreeState,
  config: TopicTreeConfig,
  inverse: readonly StructureEvent[]
): UndoBlocker[] {
  const placedTopics = new Set<string>();
  const titledTopics = new Set<string>();
  const items = new Set<ItemKey>();
  for (const event of inverse) {
    if ("item" in event) {
      items.add(event.item);
      continue;
    }
    const node = state.topics.get(event.topicId);
    if (!node || !isLive(node)) continue;
    if (event.op === "topic.move" || event.op === "topic.restore" || event.op === "topic.create") {
      placedTopics.add(event.topicId);
      titledTopics.add(event.topicId);
    }
    if (event.op === "topic.rename") titledTopics.add(event.topicId);
  }
  const conflicts: UndoBlocker[] = [];
  for (const topicId of [...titledTopics].sort(compareStrings)) {
    const node = getTopic(state, topicId);
    if (node.title === null || node.parentId === null) continue;
    const title = normalizeTopicTitle(node.title);
    for (const siblingId of getTopic(state, node.parentId).children) {
      const sibling = getTopic(state, siblingId).title;
      if (siblingId !== topicId && sibling !== null && normalizeTopicTitle(sibling) === title) {
        conflicts.push(conflict("duplicateTitle", "a sibling has the same title", { topicId }));
        break;
      }
    }
  }
  for (const topicId of [...placedTopics].sort(compareStrings)) {
    if (depthOf(state, topicId) + heightOf(state, topicId) > config.depth.cap) {
      conflicts.push(conflict("depthCap", "the subtree crosses the depth cap", { topicId }));
    }
    for (const item of subtreeItems(state, topicId)) items.add(item);
  }
  for (const item of [...items].sort(compareStrings)) {
    if (!state.items.has(item)) continue;
    if (invalidSecondaries(state, config, item).length > 0) {
      conflicts.push(
        conflict("secondaryOnPrimaryPath", "a secondary placement breaks I2", { item })
      );
    }
  }
  return conflicts;
}

function eventConflict(error: StructureEventConflictError): UndoBlocker {
  const event = error.event;
  return conflict(/cycle/u.test(error.reason) ? "cycle" : "state", error.reason, {
    topicId: event.topicId,
    item: "item" in event ? event.item : null
  });
}

/**
 * Undoes `target` on the state when nothing blocks it: no later change-set depends on it, its
 * items still exist, and its inverse applies without breaking an invariant. On success the state
 * holds the inverse (the caller records it as an `undo` change-set and recomputes
 * `touchedTopics`); otherwise the state is unchanged and the blockers are returned.
 */
export function undoChangeSet(
  state: TopicTreeState,
  config: TopicTreeConfig,
  target: UndoableChangeSet,
  later: readonly UndoableChangeSet[]
): UndoResult {
  const blockers = [...changeSetBlockers(target, later), ...deletedItems(state, target.events)];
  if (blockers.length > 0) return { kind: "blocked", blockers };
  const inverse = invertEvents(target.events);
  let applied: AppliedEvents;
  try {
    applied = applyEvents(state, inverse);
  } catch (error) {
    if (error instanceof StructureEventConflictError) {
      return { kind: "blocked", blockers: [eventConflict(error)] };
    }
    throw error;
  }
  const conflicts = inverseConflicts(state, config, inverse);
  if (conflicts.length > 0) {
    applyEvents(state, invertEvents(inverse));
    return { kind: "blocked", blockers: conflicts };
  }
  return { kind: "undone", events: inverse, touchedTopics: applied.touchedTopics };
}

/**
 * Why `target` cannot be undone now (empty when it can). The state is left as it was: a trial
 * undo is rolled back.
 */
export function undoBlockers(
  state: TopicTreeState,
  config: TopicTreeConfig,
  target: UndoableChangeSet,
  later: readonly UndoableChangeSet[]
): UndoBlocker[] {
  const result = undoChangeSet(state, config, target, later);
  if (result.kind === "blocked") return result.blockers;
  applyEvents(state, invertEvents(result.events));
  return [];
}
