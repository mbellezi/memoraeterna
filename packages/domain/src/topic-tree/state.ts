// In-memory topic tree state: the engine's mirror of `topics`, `topic_stats` and
// `topic_placements` (section 3.1). Topics are keyed by UUID in the product (batch builds use
// counter keys that never leave the worker); items by item key (ids.ts).
//
// Persistent fields (TopicRecord, PlacementRecord) change only through structure events
// (events.ts), which call the primitives below. Statistics (stats.ts) are derived and never part
// of an event. Control fields (cooldown clock, dirty, freeze) are engine bookkeeping.
//
// Orders the engine depends on are canonical: children by (position, id), direct items by
// content key. A canonical dump of the persistent fields is byte-stable, which is how undo is
// proved exact.
import type {
  TopicItemKind,
  TopicManagement,
  TopicNameSource,
  TopicNameState,
  TopicPlacementDecision,
  TopicPlacementManagement,
  TopicRole
} from "../topics.js";
import { compareContentKeys, compareStrings } from "./ids.js";
import type { ItemKey } from "./ids.js";

/** The persistent fields of a topic (`topics` row). */
export interface TopicRecord {
  id: string;
  parentId: string | null;
  role: TopicRole;
  /** Null exactly when `nameState` is `unnamed` (the root has no title). */
  title: string | null;
  nameState: TopicNameState;
  nameSource: TopicNameSource | null;
  nameLanguage: string | null;
  namedChangeSetId: string | null;
  description: string | null;
  aliases: string[];
  /** `human` and `pinned` topics are protected. */
  management: TopicManagement;
  /** Sibling order. */
  position: number;
  retiredAt: string | null;
  /** The topic that replaced a retired one (I9); null for live topics. */
  redirectTo: string | null;
  createdChangeSetId: string | null;
}

/** Persistent topic fields in canonical (dump) order. */
export const topicRecordFields = [
  "id",
  "parentId",
  "role",
  "title",
  "nameState",
  "nameSource",
  "nameLanguage",
  "namedChangeSetId",
  "description",
  "aliases",
  "management",
  "position",
  "retiredAt",
  "redirectTo",
  "createdChangeSetId"
] as const satisfies readonly (keyof TopicRecord)[];

/** BIRCH-style clustering feature of a topic subtree (D7). */
export interface TopicStats {
  /** Items in the subtree that count toward the statistics (D8). */
  n: number;
  /** Sum of their unit vectors. */
  ls: Float64Array;
  /** LS / |LS| (zero when n = 0). */
  centroid: Float32Array;
  /** Sum of squared member cosines to the centroid (exact after a refresh). */
  cosSqSum: number;
  /** Lower percentiles 0%..10% (index = percent) of member cosines at the last refresh. */
  lowCosPercentiles: Float32Array;
}

/** Engine bookkeeping that is not a structure event. */
export interface TopicControl {
  /** Tree clock of the last repair touching this topic (cooldown); null when never repaired. */
  repairClock: number | null;
  /** Statistics need an exact recompute (a cascade deleted members, D32). */
  dirty: boolean;
  /** Recently opened or edited: soft operations leave it alone (set by the service). */
  frozen: boolean;
}

/** The embedded topic label ("title · aliases · description") in the tree's space. */
export interface TopicLabel {
  /** Unit vector. */
  vector: Float32Array;
  /** Hash of the embedded text: a rename makes the label stale. */
  textHash: string;
}

export interface TopicNode extends TopicRecord {
  /** Live children in sibling order (position, then id). */
  children: string[];
  /** Items whose primary placement is this topic, in content-key order. */
  items: ItemKey[];
  /** Items with a secondary placement on this topic, in content-key order. */
  secondaryItems: ItemKey[];
  stats: TopicStats;
  control: TopicControl;
  /** Label vector for label mixing in PLACE and the gate; null until it is embedded. */
  label: TopicLabel | null;
}

/** What the engine knows about an item besides its vector. */
export interface ItemEntry {
  key: ItemKey;
  kind: TopicItemKind;
  /** Content hash: the first part of the content key (D22). */
  contentHash: string;
  /** The root source of a note (it stops counting in statistics once a note is placed, D8). */
  rootSource: ItemKey | null;
}

/** The persistent fields of a placement (`topic_placements` row). Rank 0 is the primary. */
export interface PlacementRecord {
  topicId: string;
  rank: number;
  management: TopicPlacementManagement;
  decidedBy: TopicPlacementDecision;
  itemFingerprint: string | null;
  score: number | null;
  margin: number | null;
  needsGate: boolean;
  needsSplitCheck: boolean;
  needsVector: boolean;
  /** "Moved from X" hint after an automatic move. */
  movedFromTopicId: string | null;
  movedAt: string | null;
}

/** Persistent placement fields in canonical (dump) order. */
export const placementRecordFields = [
  "topicId",
  "rank",
  "management",
  "decidedBy",
  "itemFingerprint",
  "score",
  "margin",
  "needsGate",
  "needsSplitCheck",
  "needsVector",
  "movedFromTopicId",
  "movedAt"
] as const satisfies readonly (keyof PlacementRecord)[];

export interface TopicTreeState {
  readonly dim: number;
  readonly rootId: string;
  /** Live and retired topics (retired ones stay as redirects, I9). */
  readonly topics: Map<string, TopicNode>;
  readonly items: Map<ItemKey, ItemEntry>;
  /** Placements of each item, sorted by rank. */
  readonly placements: Map<ItemKey, PlacementRecord[]>;
  /** Root source -> number of its notes with a primary placement (D8). */
  readonly placedNotesBySource: Map<ItemKey, number>;
  /** Applied change-sets (optimistic concurrency with the repository). */
  generation: number;
  /** Logical clock (inserts) that drives cooldowns. */
  clock: number;
  /** Soft-operation budget used on the current local day (stability controls). */
  budget: DailyBudgetUse;
}

/** What the day's soft operations have used of `stability.daily*`. */
export interface DailyBudgetUse {
  /** Local day (YYYY-MM-DD) the counters belong to; null before the first operation. */
  day: string | null;
  operations: number;
  movedItems: number;
}

export class TopicTreeStateError extends Error {
  override readonly name = "TopicTreeStateError";
}

export function emptyStats(dim: number): TopicStats {
  return {
    n: 0,
    ls: new Float64Array(dim),
    centroid: new Float32Array(dim),
    cosSqSum: 0,
    lowCosPercentiles: new Float32Array(0)
  };
}

/** A topic record with neutral defaults: unnamed, AI-managed, live. */
export function topicRecord(
  id: string,
  parentId: string | null,
  fields: Partial<Omit<TopicRecord, "id" | "parentId">> = {}
): TopicRecord {
  return {
    id,
    parentId,
    role: parentId === null ? "root" : "topic",
    title: null,
    nameState: "unnamed",
    nameSource: null,
    nameLanguage: null,
    namedChangeSetId: null,
    description: null,
    aliases: [],
    management: "ai",
    position: 0,
    retiredAt: null,
    redirectTo: null,
    createdChangeSetId: null,
    ...fields
  };
}

/** A placement record with neutral defaults (an AI primary placement). */
export function placementRecord(
  topicId: string,
  fields: Partial<Omit<PlacementRecord, "topicId">> = {}
): PlacementRecord {
  return {
    topicId,
    rank: 0,
    management: "ai",
    decidedBy: "auto",
    itemFingerprint: null,
    score: null,
    margin: null,
    needsGate: false,
    needsSplitCheck: false,
    needsVector: false,
    movedFromTopicId: null,
    movedAt: null,
    ...fields
  };
}

function nodeFrom(record: TopicRecord, dim: number): TopicNode {
  return {
    ...record,
    aliases: [...record.aliases],
    children: [],
    items: [],
    secondaryItems: [],
    stats: emptyStats(dim),
    control: { repairClock: null, dirty: false, frozen: false },
    label: null
  };
}

export function createTopicTreeState(options: {
  dim: number;
  rootId: string;
  root?: Partial<Omit<TopicRecord, "id" | "parentId" | "role">>;
}): TopicTreeState {
  if (!Number.isInteger(options.dim) || options.dim <= 0) {
    throw new TopicTreeStateError(`Invalid dimension ${options.dim}`);
  }
  const root = topicRecord(options.rootId, null, { ...options.root, role: "root" });
  return {
    dim: options.dim,
    rootId: options.rootId,
    topics: new Map([[root.id, nodeFrom(root, options.dim)]]),
    items: new Map(),
    placements: new Map(),
    placedNotesBySource: new Map(),
    generation: 0,
    clock: 0,
    budget: { day: null, operations: 0, movedItems: 0 }
  };
}

// ---------------------------------------------------------------------------
// Accessors

export function getTopic(state: TopicTreeState, id: string): TopicNode {
  const node = state.topics.get(id);
  if (!node) throw new TopicTreeStateError(`Unknown topic ${id}`);
  return node;
}

export function isLive(node: TopicRecord): boolean {
  return node.retiredAt === null;
}

export function getLiveTopic(state: TopicTreeState, id: string): TopicNode {
  const node = getTopic(state, id);
  if (!isLive(node)) throw new TopicTreeStateError(`Topic ${id} is retired`);
  return node;
}

export function isLeaf(node: TopicNode): boolean {
  return node.children.length === 0;
}

export function isProtected(node: TopicRecord): boolean {
  return node.management !== "ai";
}

export function depthOf(state: TopicTreeState, id: string): number {
  let depth = 0;
  let current = getTopic(state, id).parentId;
  while (current !== null) {
    depth += 1;
    if (depth > state.topics.size) throw new TopicTreeStateError(`Cycle above topic ${id}`);
    current = getTopic(state, current).parentId;
  }
  return depth;
}

/** Topic IDs from the root to `id`, inclusive. */
export function pathOf(state: TopicTreeState, id: string): string[] {
  const path: string[] = [];
  let current: string | null = id;
  while (current !== null) {
    path.push(current);
    if (path.length > state.topics.size) throw new TopicTreeStateError(`Cycle above topic ${id}`);
    current = getTopic(state, current).parentId;
  }
  return path.reverse();
}

/** Height of the live subtree below `id` (a leaf has height 0). */
export function heightOf(state: TopicTreeState, id: string): number {
  let height = 0;
  for (const child of getTopic(state, id).children)
    height = Math.max(height, 1 + heightOf(state, child));
  return height;
}

/** Direct primary items of the live subtree of `id`, in pre-order. */
export function subtreeItems(state: TopicTreeState, id: string, output: ItemKey[] = []): ItemKey[] {
  const node = getTopic(state, id);
  for (const item of node.items) output.push(item);
  for (const child of node.children) subtreeItems(state, child, output);
  return output;
}

/** Pre-order traversal of the live tree from `from` (default: the root). */
export function walkTopics(
  state: TopicTreeState,
  visit: (node: TopicNode, depth: number) => void,
  from = state.rootId,
  depth = 0
): void {
  const node = getTopic(state, from);
  visit(node, depth);
  for (const child of node.children) walkTopics(state, visit, child, depth + 1);
}

/** Live topic IDs in pre-order. */
export function liveTopicIds(state: TopicTreeState): string[] {
  const ids: string[] = [];
  walkTopics(state, (node) => ids.push(node.id));
  return ids;
}

export function leafTopics(state: TopicTreeState): TopicNode[] {
  const output: TopicNode[] = [];
  walkTopics(state, (node) => {
    if (node.children.length === 0) output.push(node);
  });
  return output;
}

export function getItem(state: TopicTreeState, key: ItemKey): ItemEntry {
  const entry = state.items.get(key);
  if (!entry) throw new TopicTreeStateError(`Unknown item ${key}`);
  return entry;
}

export function placementsOf(state: TopicTreeState, key: ItemKey): readonly PlacementRecord[] {
  return state.placements.get(key) ?? [];
}

export function placementAt(
  state: TopicTreeState,
  key: ItemKey,
  rank: number
): PlacementRecord | undefined {
  return state.placements.get(key)?.find((placement) => placement.rank === rank);
}

export function primaryPlacement(state: TopicTreeState, key: ItemKey): PlacementRecord | undefined {
  return placementAt(state, key, 0);
}

/** The live topic that holds `id` now: `id` itself, or the end of its redirect chain. */
export function resolveTopicId(state: TopicTreeState, id: string): string {
  let current = id;
  for (let hops = 0; hops <= state.topics.size; hops += 1) {
    const node = getTopic(state, current);
    if (isLive(node)) return current;
    if (node.redirectTo === null)
      throw new TopicTreeStateError(`Topic ${id} has no live successor`);
    current = node.redirectTo;
  }
  throw new TopicTreeStateError(`Redirect cycle from topic ${id}`);
}

/** Position for a new last child of `parentId`. */
export function nextChildPosition(state: TopicTreeState, parentId: string): number {
  let max = -1;
  for (const child of getTopic(state, parentId).children) {
    max = Math.max(max, getTopic(state, child).position);
  }
  return max + 1;
}

/** The persistent fields of a topic. */
export function topicRecordOf(node: TopicRecord): TopicRecord {
  const record = {} as Record<string, unknown>;
  for (const field of topicRecordFields) {
    const value = node[field];
    record[field] = Array.isArray(value) ? [...value] : value;
  }
  return record as unknown as TopicRecord;
}

// ---------------------------------------------------------------------------
// Ordering helpers

function compareSiblings(state: TopicTreeState, a: string, b: string): number {
  return getTopic(state, a).position - getTopic(state, b).position || compareStrings(a, b);
}

function compareItems(state: TopicTreeState, a: ItemKey, b: ItemKey): number {
  return compareContentKeys(getItem(state, a), getItem(state, b));
}

function insertSorted<T>(list: T[], value: T, compare: (a: T, b: T) => number): void {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(list[middle] as T, value) <= 0) low = middle + 1;
    else high = middle;
  }
  list.splice(low, 0, value);
}

function removeValue<T>(list: T[], value: T): void {
  const index = list.indexOf(value);
  if (index < 0) throw new TopicTreeStateError(`Missing ${String(value)}`);
  list.splice(index, 1);
}

/** Sorts a list of item keys in content-key order (in place) and returns it. */
export function sortItemsByContentKey(state: TopicTreeState, items: ItemKey[]): ItemKey[] {
  return items.sort((a, b) => compareItems(state, a, b));
}

// ---------------------------------------------------------------------------
// Primitives (structure only; events.ts checks event preconditions before calling them)

/** Registers an item or updates its content hash and root source, keeping every order canonical. */
export function registerItem(state: TopicTreeState, entry: ItemEntry): void {
  const previous = state.items.get(entry.key);
  if (previous && previous.kind !== entry.kind) {
    throw new TopicTreeStateError(`Item ${entry.key} cannot change kind`);
  }
  const placements = state.placements.get(entry.key) ?? [];
  const primary = placements.find((placement) => placement.rank === 0);
  if (previous && primary) adjustSourceCount(state, previous, -1);
  state.items.set(entry.key, { ...entry });
  if (previous && previous.contentHash !== entry.contentHash) {
    for (const placement of placements) {
      const node = getTopic(state, placement.topicId);
      const list = placement.rank === 0 ? node.items : node.secondaryItems;
      removeValue(list, entry.key);
      insertSorted(list, entry.key, (a, b) => compareItems(state, a, b));
    }
  }
  if (previous && primary) adjustSourceCount(state, entry, 1);
}

export function unregisterItem(state: TopicTreeState, key: ItemKey): void {
  if ((state.placements.get(key)?.length ?? 0) > 0) {
    throw new TopicTreeStateError(`Item ${key} is still placed`);
  }
  state.items.delete(key);
}

function adjustSourceCount(state: TopicTreeState, entry: ItemEntry, delta: number): void {
  if (entry.kind !== "note" || entry.rootSource === null) return;
  const count = (state.placedNotesBySource.get(entry.rootSource) ?? 0) + delta;
  if (count > 0) state.placedNotesBySource.set(entry.rootSource, count);
  else state.placedNotesBySource.delete(entry.rootSource);
}

function attachChild(state: TopicTreeState, parentId: string, childId: string): void {
  const parent = getLiveTopic(state, parentId);
  insertSorted(parent.children, childId, (a, b) => compareSiblings(state, a, b));
}

function detachChild(state: TopicTreeState, parentId: string, childId: string): void {
  removeValue(getTopic(state, parentId).children, childId);
}

function assertNoCycle(state: TopicTreeState, id: string, parentId: string): void {
  let current: string | null = parentId;
  for (let hops = 0; current !== null; hops += 1) {
    if (current === id)
      throw new TopicTreeStateError(`Moving ${id} under ${parentId} makes a cycle`);
    if (hops > state.topics.size) throw new TopicTreeStateError(`Cycle above topic ${parentId}`);
    current = getTopic(state, current).parentId;
  }
}

function assertEmpty(node: TopicNode, action: string): void {
  if (node.children.length > 0 || node.items.length > 0 || node.secondaryItems.length > 0) {
    throw new TopicTreeStateError(`Cannot ${action} non-empty topic ${node.id}`);
  }
}

/** Adds a topic. IDs are never reused (I9): an existing ID, live or retired, is rejected. */
export function insertTopic(state: TopicTreeState, record: TopicRecord): TopicNode {
  if (state.topics.has(record.id))
    throw new TopicTreeStateError(`Topic ${record.id} already exists`);
  if (record.role === "root" || record.parentId === null) {
    throw new TopicTreeStateError("A tree has exactly one root");
  }
  if (isLive(record)) getLiveTopic(state, record.parentId);
  else getTopic(state, record.parentId);
  const node = nodeFrom(record, state.dim);
  state.topics.set(node.id, node);
  if (isLive(node)) attachChild(state, record.parentId, node.id);
  return node;
}

/** Removes a topic entirely (the inverse of its creation). */
export function deleteTopic(state: TopicTreeState, id: string): void {
  const node = getTopic(state, id);
  if (id === state.rootId) throw new TopicTreeStateError("Cannot delete the root");
  assertEmpty(node, "delete");
  for (const other of state.topics.values()) {
    if (other.id !== id && (other.parentId === id || other.redirectTo === id)) {
      throw new TopicTreeStateError(`Topic ${id} is still referenced by ${other.id}`);
    }
  }
  if (isLive(node) && node.parentId !== null) detachChild(state, node.parentId, id);
  state.topics.delete(id);
}

export type TopicFieldPatch = Partial<Omit<TopicRecord, "id" | "role">>;

/**
 * Changes persistent fields of a topic. Parent and position changes re-attach it (with a cycle
 * check); setting `retiredAt` detaches an empty topic, clearing it re-attaches the topic.
 */
export function updateTopicFields(state: TopicTreeState, id: string, patch: TopicFieldPatch): void {
  const node = getTopic(state, id);
  const wasLive = isLive(node);
  const nextParent = patch.parentId === undefined ? node.parentId : patch.parentId;
  const nextRetired = patch.retiredAt === undefined ? node.retiredAt : patch.retiredAt;
  const structural =
    nextParent !== node.parentId ||
    (patch.position !== undefined && patch.position !== node.position) ||
    nextRetired !== node.retiredAt;
  if (id === state.rootId && (nextParent !== null || nextRetired !== null)) {
    throw new TopicTreeStateError("The root cannot move or retire");
  }
  if (nextRetired !== null && wasLive) assertEmpty(node, "retire");
  if (nextParent !== null && nextParent !== node.parentId) assertNoCycle(state, id, nextParent);
  if (structural && nextRetired === null && nextParent !== null) getLiveTopic(state, nextParent);
  if (structural && wasLive && node.parentId !== null) detachChild(state, node.parentId, id);
  for (const [field, value] of Object.entries(patch)) {
    (node as unknown as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
  }
  if (structural && nextRetired === null && nextParent !== null) attachChild(state, nextParent, id);
}

function topicList(node: TopicNode, rank: number): ItemKey[] {
  return rank === 0 ? node.items : node.secondaryItems;
}

/** Adds a placement of a registered item on a live topic. */
export function insertPlacement(
  state: TopicTreeState,
  key: ItemKey,
  record: PlacementRecord
): void {
  const entry = getItem(state, key);
  const placements = state.placements.get(key) ?? [];
  if (!Number.isInteger(record.rank) || record.rank < 0) {
    throw new TopicTreeStateError(`Invalid placement rank ${record.rank}`);
  }
  if (placements.some((placement) => placement.rank === record.rank)) {
    throw new TopicTreeStateError(`Item ${key} already has a placement at rank ${record.rank}`);
  }
  if (placements.some((placement) => placement.topicId === record.topicId)) {
    throw new TopicTreeStateError(`Item ${key} is already placed on topic ${record.topicId}`);
  }
  const node = getLiveTopic(state, record.topicId);
  insertSorted(placements, { ...record }, (a, b) => a.rank - b.rank);
  state.placements.set(key, placements);
  insertSorted(topicList(node, record.rank), key, (a, b) => compareItems(state, a, b));
  if (record.rank === 0) adjustSourceCount(state, entry, 1);
}

export function deletePlacement(
  state: TopicTreeState,
  key: ItemKey,
  rank: number
): PlacementRecord {
  const placements = state.placements.get(key) ?? [];
  const index = placements.findIndex((placement) => placement.rank === rank);
  if (index < 0) throw new TopicTreeStateError(`Item ${key} has no placement at rank ${rank}`);
  const [removed] = placements.splice(index, 1) as [PlacementRecord];
  if (placements.length === 0) state.placements.delete(key);
  removeValue(topicList(getTopic(state, removed.topicId), rank), key);
  if (rank === 0) adjustSourceCount(state, getItem(state, key), -1);
  return removed;
}

export type PlacementFieldPatch = Partial<Omit<PlacementRecord, "rank">>;

/** Changes a placement; a topic change moves the item between topic lists. */
export function updatePlacementFields(
  state: TopicTreeState,
  key: ItemKey,
  rank: number,
  patch: PlacementFieldPatch
): void {
  const placement = placementAt(state, key, rank);
  if (!placement) throw new TopicTreeStateError(`Item ${key} has no placement at rank ${rank}`);
  if (patch.topicId !== undefined && patch.topicId !== placement.topicId) {
    const target = getLiveTopic(state, patch.topicId);
    if (placementsOf(state, key).some((other) => other.topicId === patch.topicId)) {
      throw new TopicTreeStateError(`Item ${key} is already placed on topic ${patch.topicId}`);
    }
    removeValue(topicList(getTopic(state, placement.topicId), rank), key);
    insertSorted(topicList(target, rank), key, (a, b) => compareItems(state, a, b));
  }
  Object.assign(placement, patch);
}

// ---------------------------------------------------------------------------
// Snapshots

function cloneStats(stats: TopicStats): TopicStats {
  return {
    n: stats.n,
    ls: stats.ls.slice(),
    centroid: stats.centroid.slice(),
    cosSqSum: stats.cosSqSum,
    lowCosPercentiles: stats.lowCosPercentiles.slice()
  };
}

/** Deep copy (records, structure, statistics and control). */
export function cloneTopicTreeState(state: TopicTreeState): TopicTreeState {
  const topics = new Map<string, TopicNode>();
  for (const [id, node] of state.topics) {
    topics.set(id, {
      ...node,
      aliases: [...node.aliases],
      children: [...node.children],
      items: [...node.items],
      secondaryItems: [...node.secondaryItems],
      stats: cloneStats(node.stats),
      control: { ...node.control },
      label: node.label
        ? { vector: node.label.vector.slice(), textHash: node.label.textHash }
        : null
    });
  }
  const placements = new Map<ItemKey, PlacementRecord[]>();
  for (const [key, list] of state.placements)
    placements.set(
      key,
      list.map((p) => ({ ...p }))
    );
  return {
    dim: state.dim,
    rootId: state.rootId,
    topics,
    items: new Map([...state.items].map(([key, entry]) => [key, { ...entry }])),
    placements,
    placedNotesBySource: new Map(state.placedNotesBySource),
    generation: state.generation,
    clock: state.clock,
    budget: { ...state.budget }
  };
}

/**
 * Canonical JSON of the persistent fields: every topic (live and retired: parents, positions,
 * titles, management, redirects) sorted by ID and every placement sorted by item key and rank.
 * Two states with the same structure produce byte-equal dumps.
 */
export function canonicalStateDump(state: TopicTreeState): string {
  const topicIds = [...state.topics.keys()].sort(compareStrings);
  const topics = topicIds.map((id) => {
    const node = getTopic(state, id);
    return topicRecordFields.map((field) => node[field]);
  });
  const itemKeys = [...state.placements.keys()].sort(compareStrings);
  const placements = itemKeys.flatMap((key) =>
    (state.placements.get(key) ?? []).map((placement) => [
      key,
      ...placementRecordFields.map((field) => placement[field])
    ])
  );
  return JSON.stringify({ rootId: state.rootId, topics, placements });
}
