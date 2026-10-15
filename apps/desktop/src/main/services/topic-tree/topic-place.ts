// PLACE of one scope (spec 3.5 `topic-place`): every pending item of one root source, or one note
// without a root. It reads what changed (unplaced or re-embedded notes, notes that stopped being
// current, the root's D8 vector), decides each item with the pure engine in content-key order
// (D22) and returns the events and exact statistics of one change-set; the service commits them.
// Placement never waits for AI (D10): an ambiguous item waits at an ancestor with `needs_gate`.
import { createTopicTreeLoadRepository, topicStatsWrites } from "@app/db";
import type {
  PgPool,
  TopicItemInfo,
  TopicItemVectors,
  TopicPendingItem,
  TopicStatsWrite
} from "@app/db";
import {
  compareContentKeys,
  createTopicTreeEditor,
  dot,
  isLive,
  itemKey,
  notesByRootSource,
  parseItemKey,
  pathOf,
  placeItem,
  placementsOf,
  primaryPlacement,
  recomputePaths,
  registerItem,
  rootSourceVectorFromState,
  topicsWithStaleStats,
  unregisterItem
} from "@app/domain/topic-tree";
import type {
  ItemKey,
  PlaceOutcome,
  PlacementContext,
  StructureEvent,
  TopicTreeState
} from "@app/domain/topic-tree";

import { noteEntries, rootVectorFingerprint } from "./topic-cache.js";
import type { TopicTreeCache } from "./topic-cache.js";
import type { TopicScope } from "./topic-jobs.js";

/** What one PLACE run did, item by item. */
export interface PlaceSummary {
  placed: number;
  moved: number;
  updated: number;
  unchanged: number;
  protected: number;
  unplaced: number;
  needsGate: number;
  needsVector: number;
}

export type PlacePreparation =
  | { kind: "no_change"; summary: PlaceSummary }
  /** The tree has no topics yet and enough items wait: they stay pending for one build (D39). */
  | { kind: "awaiting_build"; pending: number; summary: PlaceSummary }
  /** A note this cache holds was deleted (D32 cascade): reload and run again. */
  | { kind: "stale_cache" }
  | {
      kind: "ready";
      events: StructureEvent[];
      stats: TopicStatsWrite[];
      /** Live topics whose content or counts changed (the paths of the change). */
      changedTopicIds: string[];
      summary: PlaceSummary;
      /** Items left waiting for the gate (`needs_gate`). */
      needsGate: boolean;
    };

export interface PlaceRunInput {
  pool: PgPool;
  cache: TopicTreeCache;
  scope: TopicScope;
  now: string;
  /**
   * True when the tree has no topics and at least `bootstrap.minItems` items are placed or wait
   * unplaced (`unplaced`: this scope's): item-by-item PLACE then waits for the build (D39).
   */
  awaitingBuild: (unplaced: number) => Promise<boolean>;
}

/** Reasons that need a PLACE decision (the gate reasons wait for the `topic-gate` job). */
const placeReasons = ["unplaced", "needs_vector", "stale"] as const;

export function emptyPlaceSummary(): PlaceSummary {
  return {
    placed: 0,
    moved: 0,
    updated: 0,
    unchanged: 0,
    protected: 0,
    unplaced: 0,
    needsGate: 0,
    needsVector: 0
  };
}

function count(summary: PlaceSummary, outcome: PlaceOutcome, state: TopicTreeState, key: ItemKey) {
  if (outcome.kind === "placed") summary.placed += 1;
  else if (outcome.kind === "moved") summary.moved += 1;
  else if (outcome.kind === "updated") summary.updated += 1;
  else if (outcome.kind === "protected") summary.protected += 1;
  else summary.unchanged += 1;
  const primary = primaryPlacement(state, key);
  if (primary?.needsGate) summary.needsGate += 1;
  if (primary?.needsVector) summary.needsVector += 1;
}

/** Every page of a scope's pending items. */
async function scopePending(input: PlaceRunInput): Promise<TopicPendingItem[]> {
  const { cache, scope } = input;
  const loader = createTopicTreeLoadRepository(input.pool);
  const items: TopicPendingItem[] = [];
  let after: ItemKey | null = null;
  do {
    const page = await loader.pendingItems(cache.tree.id, cache.space, {
      reasons: placeReasons,
      after,
      ...("rootSourceId" in scope
        ? { rootSourceId: scope.rootSourceId }
        : { noteIds: [scope.noteId] })
    });
    items.push(...page.items);
    after = page.next;
  } while (after !== null);
  return items;
}

/** The notes of the scope this cache holds (placed before this run). */
function knownNotes(state: TopicTreeState, scope: TopicScope): ItemKey[] {
  if ("noteId" in scope) {
    const key = itemKey("note", scope.noteId);
    return state.items.has(key) ? [key] : [];
  }
  const root = itemKey("source", scope.rootSourceId);
  return [...state.items.values()]
    .filter((entry) => entry.kind === "note" && entry.rootSource === root)
    .map((entry) => entry.key);
}

const idOf = (key: ItemKey): string => (parseItemKey(key) as { id: string }).id;

/**
 * Gives an item a new vector (or none) and, when it already sits in the tree, restores the exact
 * statistics of its topics' paths, so the decisions of this run start from exact values.
 */
function replaceVector(
  cache: TopicTreeCache,
  key: ItemKey,
  vector: Float32Array | null,
  recompute: Set<string>
): string[] {
  const { state, vectors } = cache;
  if (vector ? vectors.holds(key, vector) : vectors.rowOf(key) === undefined) return [];
  if (vector) vectors.set(key, vector);
  else vectors.delete(key);
  if (!state.items.has(key)) return [];
  const topics = placementsOf(state, key).map((placement) => placement.topicId);
  for (const topicId of topics) recompute.add(topicId);
  return topics;
}

function liveTopics(state: TopicTreeState, ids: Iterable<string>): string[] {
  const output = new Set<string>();
  for (const id of ids) {
    const node = state.topics.get(id);
    if (node && isLive(node)) output.add(id);
  }
  return [...output];
}

/** Every live topic on the paths from `ids` to the root. */
function pathsOf(state: TopicTreeState, ids: Iterable<string>): string[] {
  const output = new Set<string>();
  for (const id of liveTopics(state, ids))
    for (const pathId of pathOf(state, id)) output.add(pathId);
  return [...output].sort();
}

/**
 * Prepares one PLACE change-set on the cache (it mutates the cache's state and vectors; the
 * caller commits the events or drops the cache). Items are decided in content-key order.
 */
export async function preparePlacement(input: PlaceRunInput): Promise<PlacePreparation> {
  const { cache, scope } = input;
  const { state, vectors, config } = cache;
  const loader = createTopicTreeLoadRepository(input.pool);
  const summary = emptyPlaceSummary();
  const pending = await scopePending(input);
  const known = knownNotes(state, scope);
  const pendingNotes = pending.filter((item) => item.kind === "note");
  const rootId = "rootSourceId" in scope ? scope.rootSourceId : null;
  const owners = await loader.itemOwners({
    noteIds: [...new Set([...known.map(idOf), ...pendingNotes.map((item) => item.id)])],
    sourceIds: rootId ? [rootId] : []
  });
  if (known.some((key) => !owners.notes.has(idOf(key)))) return { kind: "stale_cache" };
  const leaving = known
    .filter((key) => owners.notes.get(idOf(key))?.current === false)
    .sort((a, b) => compareContentKeys(state.items.get(a)!, state.items.get(b)!));
  const waiting = await input.awaitingBuild(
    pending.filter((item) => item.reason === "unplaced").length
  );

  const editor = createTopicTreeEditor(state);
  const context: PlacementContext = { state, vectors, config, editor, now: input.now };
  const recompute = new Set<string>();

  // Notes that stopped being current (rejected, archived or superseded) leave the tree.
  for (const key of leaving) {
    const ranks = placementsOf(state, key)
      .map((placement) => placement.rank)
      .sort((a, b) => b - a);
    for (const rank of ranks) editor.unplaceItem(key, rank);
    summary.unplaced += 1;
    unregisterItem(state, key);
    vectors.delete(key);
  }
  for (const id of topicsWithStaleStats(state, editor.events)) recompute.add(id);

  if (waiting) {
    if (editor.events.length === 0)
      return { kind: "awaiting_build", pending: pending.length, summary };
    return finish(cache, editor.events, editor.touched, recompute, summary, false);
  }

  // The scope's notes take their current vectors first: a re-embedded note its new one, a note
  // whose vector was deleted by an edit none (it keeps its place, out of the statistics, D7).
  const leftIds = new Set(leaving.map(idOf));
  const scopeIds = [
    ...new Set([...known.map(idOf), ...pendingNotes.map((item) => item.id)])
  ].filter((id) => !leftIds.has(id));
  const noteVectors: TopicItemVectors =
    scopeIds.length === 0
      ? emptyVectors(cache)
      : await loader.loadItemVectors(
          cache.space,
          scopeIds.map((id) => ({ kind: "note" as const, id }))
        );
  const current = noteEntries(noteVectors, owners.notes);
  for (const key of known) {
    const note = current.get(key);
    if (!note) continue;
    replaceVector(cache, key, note.vector, recompute);
    register(state, key, note.info);
  }
  if (recompute.size > 0) recomputePaths(state, vectors, liveTopics(state, recompute));

  // Pending notes, in content-key order (D22).
  const pendingKeys = new Set(pendingNotes.map((item) => itemKey("note", item.id)));
  const notes = [...current]
    .filter(([key]) => pendingKeys.has(key))
    .sort(([a, x], [b, y]) =>
      compareContentKeys(
        { key: a, contentHash: x.info.contentHash },
        { key: b, contentHash: y.info.contentHash }
      )
    );
  for (const [key, note] of notes) {
    register(state, key, note.info);
    if (note.vector) vectors.set(key, note.vector);
    const outcome = placeItem(context, key, {
      fingerprint: note.vector ? note.info.contentHash : null
    });
    if (outcome.kind === "placed") state.clock += 1;
    count(summary, outcome, state, key);
  }

  // The root source itself, by its D8 vector, re-placed only when that vector moved enough.
  const rootOwner = rootId ? owners.sources.get(rootId) : undefined;
  if (rootId && rootOwner?.rootSourceId === rootId) {
    const key = itemKey("source", rootId);
    const composites = await loader.loadItemVectors(cache.space, [{ kind: "source", id: rootId }]);
    const composite = composites.keys.length > 0 ? composites.matrix.data.slice() : null;
    register(state, key, {
      kind: "source",
      contentHash: rootOwner.contentHash ?? "",
      rootSource: null
    });
    const vector = rootSourceVectorFromState(
      state,
      vectors,
      key,
      composite,
      config,
      notesByRootSource(state).get(key) ?? []
    );
    // A root that still counts (none of its notes is placed) starts its decision from exact paths.
    const moved = replaceVector(cache, key, vector.vector, recompute);
    if (moved.length > 0) recomputePaths(state, vectors, liveTopics(state, moved));
    const fingerprint = rootVectorFingerprint(vector);
    const primary = primaryPlacement(state, key);
    const last = cache.placedRootVectors.get(key);
    const settled =
      primary !== undefined &&
      !primary.needsVector &&
      vector.vector !== null &&
      primary.itemFingerprint !== fingerprint &&
      last !== undefined &&
      dot(last, vector.vector) >= config.items.sourceReplaceCosine;
    if (!settled) {
      const outcome = placeItem(context, key, { fingerprint });
      if (outcome.kind === "placed") state.clock += 1;
      if (vector.vector && outcome.events > 0)
        cache.placedRootVectors.set(key, vector.vector.slice());
      count(summary, outcome, state, key);
    } else {
      summary.unchanged += 1;
    }
  }

  if (editor.events.length === 0) return { kind: "no_change", summary };
  return finish(cache, editor.events, editor.touched, recompute, summary, summary.needsGate > 0);
}

/** Registers an item, or refreshes its content hash and root source when they changed. */
function register(state: TopicTreeState, key: ItemKey, info: TopicItemInfo): void {
  const current = state.items.get(key);
  if (
    current &&
    current.contentHash === info.contentHash &&
    current.rootSource === info.rootSource &&
    current.kind === info.kind
  ) {
    return;
  }
  registerItem(state, { key, ...info });
}

function emptyVectors(cache: TopicTreeCache): TopicItemVectors {
  const dim = cache.space.dimensions;
  return {
    dim,
    keys: [],
    contentHashes: [],
    matrix: { dim, count: 0, data: new Float32Array(0) },
    missing: [],
    stale: []
  };
}

/** Exact statistics of every touched path, ready to commit with the events (D7). */
function finish(
  cache: TopicTreeCache,
  events: StructureEvent[],
  touched: Iterable<string>,
  recompute: Iterable<string>,
  summary: PlaceSummary,
  needsGate: boolean
): PlacePreparation {
  const { state, vectors } = cache;
  const stale = liveTopics(state, [
    ...topicsWithStaleStats(state, events),
    ...touched,
    ...recompute
  ]);
  recomputePaths(state, vectors, stale);
  const changedTopicIds = pathsOf(state, stale);
  return {
    kind: "ready",
    events: [...events],
    stats: topicStatsWrites(state, vectors, changedTopicIds),
    changedTopicIds,
    summary,
    needsGate
  };
}
