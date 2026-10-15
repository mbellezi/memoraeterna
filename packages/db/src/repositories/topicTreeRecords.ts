// Records of the Topic Tree Engine tables (F2 T12): row mappings, the Float64 LS encoding, event
// references and the bridge between stored records and the engine's in-memory state. Nothing here
// writes: `topicTreeRepository.ts` is the only writer of the topic tables (D9).
import {
  StructureEventSchema,
  canonicalStateDump,
  coherenceOf,
  compareStrings,
  createTopicTreeState,
  insertPlacement,
  insertTopic,
  isLive,
  itemCentrality,
  itemKey,
  parseItemKey,
  registerItem,
  updateCentroid
} from "@app/domain/topic-tree";
import type {
  ItemEntry,
  ItemKey,
  ItemVectorSource,
  PlacementRecord,
  StructureEvent,
  TopicRecord,
  TopicTreeState
} from "@app/domain/topic-tree";
import type {
  TopicHealth,
  TopicItemKind,
  TopicManagement,
  TopicNameSource,
  TopicNameState,
  TopicPlacementDecision,
  TopicPlacementManagement,
  TopicRole,
  TopicTreeStatus
} from "@app/domain";

export type TopicTreeDimensions = 256 | 768 | 1024;

/** A `topic_trees` row with its live root. */
export interface TopicTreeRecord {
  id: string;
  status: TopicTreeStatus;
  spaceKey: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingRuntime: string;
  dimensions: TopicTreeDimensions;
  config: Record<string, unknown>;
  configHash: string;
  seed: number;
  generation: number;
  clock: number;
  rootId: string;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

/** One stored placement: the item key and the engine's persistent placement fields. */
export interface TopicPlacementEntry {
  item: ItemKey;
  placement: PlacementRecord;
}

/** The persistent records of a tree: every topic (root and retired included) and placement. */
export interface TopicTreeRecords {
  tree: TopicTreeRecord;
  /** Sorted by ID. */
  topics: TopicRecord[];
  /** Sorted by item key, then rank. */
  placements: TopicPlacementEntry[];
}

/** Exact statistics of one live topic (D7), as the engine computed them. */
export interface TopicStatsWrite {
  topicId: string;
  n: number;
  /** Sum of the counted members' unit vectors, `dimensions` values. */
  ls: Float64Array;
  cosSqSum: number;
  /** Lower percentiles 0%..10% of member cosines (0 or 11 values). */
  lowCosPercentiles: ArrayLike<number>;
  /** Tree clock of the topic's last repair; omitted keeps the stored value. */
  repairClock?: number | null;
  /** From the engine's invariant check; omitted keeps the stored value. */
  health?: TopicHealth;
  violations?: readonly unknown[];
  /** Cosine of each item placed on the topic to its centroid; null without a current vector. */
  centralities?: readonly { item: ItemKey; centrality: number | null }[];
}

/** What the engine knows about an item besides its vector (ItemEntry without the key). */
export type TopicItemInfo = Omit<ItemEntry, "key">;

/** Item metadata and current vectors in a tree's space (a missing vector: stale or absent). */
export interface TopicItemData {
  entries: ReadonlyMap<ItemKey, TopicItemInfo>;
  vectors: ItemVectorSource;
}

/**
 * Where an exact recompute reads items: the service's vector cache, or a paged SQL loader. Keys it
 * does not return are treated as unknown items.
 */
export interface TopicItemSource {
  load(keys: readonly ItemKey[], tree: TopicTreeRecord): Promise<TopicItemData>;
}

// ---------------------------------------------------------------------------
// Values

/** LS is stored as little-endian Float64 (`topic_stats.ls`). */
export function encodeTopicVector(values: Float64Array): Buffer {
  const buffer = Buffer.alloc(values.length * 8);
  for (let index = 0; index < values.length; index += 1) {
    buffer.writeDoubleLE(values[index] as number, index * 8);
  }
  return buffer;
}

/** Decodes `topic_stats.ls`; a missing value (never computed) is the zero vector. */
export function decodeTopicVector(bytes: Uint8Array | null, dimensions: number): Float64Array {
  const values = new Float64Array(dimensions);
  if (bytes === null) return values;
  if (bytes.byteLength !== dimensions * 8) {
    throw new RangeError(`Topic vector has ${bytes.byteLength} bytes, expected ${dimensions * 8}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < dimensions; index += 1) {
    values[index] = view.getFloat64(index * 8, true);
  }
  return values;
}

export function isoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

function numeric(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function nullableNumeric(value: unknown): number | null {
  return value === null || value === undefined ? null : numeric(value);
}

// ---------------------------------------------------------------------------
// Row mappings

export interface TopicTreeRow {
  id: string;
  status: TopicTreeStatus;
  spaceKey: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingRuntime: string;
  dimensions: number;
  config: Record<string, unknown>;
  configHash: string;
  seed: string | number;
  generation: string | number;
  clock: string | number;
  rootId: string | null;
  createdAt: Date | string;
  activatedAt: Date | string | null;
  retiredAt: Date | string | null;
}

export const topicTreeColumns = `t.id, t.status, t.space_key as "spaceKey",
  t.embedding_provider as "embeddingProvider", t.embedding_model as "embeddingModel",
  t.embedding_runtime as "embeddingRuntime", t.dimensions, t.config, t.config_hash as "configHash",
  t.seed, t.generation, t.clock, t.created_at as "createdAt", t.activated_at as "activatedAt",
  t.retired_at as "retiredAt",
  (select r.id from topics r where r.tree_id = t.id and r.role = 'root' and r.retired_at is null)
    as "rootId"`;

export function topicTreeFromRow(row: TopicTreeRow): TopicTreeRecord {
  if (row.rootId === null) throw new Error(`Topic tree ${row.id} has no root`);
  return {
    id: row.id,
    status: row.status,
    spaceKey: row.spaceKey,
    embeddingProvider: row.embeddingProvider,
    embeddingModel: row.embeddingModel,
    embeddingRuntime: row.embeddingRuntime,
    dimensions: numeric(row.dimensions) as TopicTreeDimensions,
    config: row.config,
    configHash: row.configHash,
    seed: numeric(row.seed),
    generation: numeric(row.generation),
    clock: numeric(row.clock),
    rootId: row.rootId,
    createdAt: new Date(row.createdAt),
    activatedAt: row.activatedAt === null ? null : new Date(row.activatedAt),
    retiredAt: row.retiredAt === null ? null : new Date(row.retiredAt)
  };
}

export interface TopicRow {
  id: string;
  parentId: string | null;
  role: TopicRole;
  title: string | null;
  nameState: TopicNameState;
  nameSource: TopicNameSource | null;
  nameLanguage: string | null;
  namedChangeSetId: string | null;
  description: string | null;
  aliases: string[];
  management: TopicManagement;
  position: number;
  retiredAt: Date | string | null;
  redirectTo: string | null;
  createdChangeSetId: string | null;
}

export const topicColumns = `id, parent_id as "parentId", role, title, name_state as "nameState",
  name_source as "nameSource", name_language as "nameLanguage",
  named_change_set_id as "namedChangeSetId", description, aliases, management, position,
  retired_at as "retiredAt", redirect_to as "redirectTo",
  created_change_set_id as "createdChangeSetId"`;

export function topicRecordFromRow(row: TopicRow): TopicRecord {
  return {
    id: row.id,
    parentId: row.parentId,
    role: row.role,
    title: row.title,
    nameState: row.nameState,
    nameSource: row.nameSource,
    nameLanguage: row.nameLanguage,
    namedChangeSetId: row.namedChangeSetId,
    description: row.description,
    aliases: [...row.aliases],
    management: row.management,
    position: numeric(row.position),
    retiredAt: isoTimestamp(row.retiredAt),
    redirectTo: row.redirectTo,
    createdChangeSetId: row.createdChangeSetId
  };
}

export interface PlacementRow {
  itemKind: TopicItemKind;
  itemId: string;
  topicId: string;
  rank: number;
  management: TopicPlacementManagement;
  decidedBy: TopicPlacementDecision;
  itemFingerprint: string | null;
  score: number | string | null;
  margin: number | string | null;
  needsGate: boolean;
  needsSplitCheck: boolean;
  needsVector: boolean;
  movedFromTopicId: string | null;
  movedAt: Date | string | null;
}

export const placementColumns = `item_kind as "itemKind",
  coalesce(note_id, source_item_id) as "itemId", topic_id as "topicId", rank, management,
  decided_by as "decidedBy", item_fingerprint as "itemFingerprint", score, margin,
  needs_gate as "needsGate", needs_split_check as "needsSplitCheck",
  needs_vector as "needsVector", moved_from_topic_id as "movedFromTopicId", moved_at as "movedAt"`;

export function placementEntryFromRow(row: PlacementRow): TopicPlacementEntry {
  return {
    item: itemKey(row.itemKind, row.itemId),
    placement: {
      topicId: row.topicId,
      rank: numeric(row.rank),
      management: row.management,
      decidedBy: row.decidedBy,
      itemFingerprint: row.itemFingerprint,
      score: nullableNumeric(row.score),
      margin: nullableNumeric(row.margin),
      needsGate: row.needsGate,
      needsSplitCheck: row.needsSplitCheck,
      needsVector: row.needsVector,
      movedFromTopicId: row.movedFromTopicId,
      movedAt: isoTimestamp(row.movedAt)
    }
  };
}

// ---------------------------------------------------------------------------
// Events

/** Parses structure events at the repository boundary (D9 inputs and stored history). */
export function parseStructureEvents(values: readonly unknown[]): StructureEvent[] {
  return values.map((value) => StructureEventSchema.parse(value) as StructureEvent);
}

/** The item of an item event, split for the `item_kind`/`item_id` columns. */
export function eventItem(event: StructureEvent): { kind: TopicItemKind; id: string } | null {
  if (!("item" in event)) return null;
  const parsed = parseItemKey(event.item);
  if (!parsed) throw new TypeError(`Invalid item key ${event.item}`);
  return parsed;
}

/**
 * Every topic an event reads or writes: the topic, parents, redirect targets and placement topics.
 * Undo looks up later change-sets by these references; "moved from" hints are not dependencies.
 */
export function eventTopicRefs(event: StructureEvent): string[] {
  const refs = new Set<string>([event.topicId]);
  const add = (id: string | null | undefined): void => {
    if (id !== null && id !== undefined) refs.add(id);
  };
  switch (event.op) {
    case "topic.create":
      add(event.before?.parentId);
      add(event.after?.parentId);
      add(event.before?.redirectTo);
      add(event.after?.redirectTo);
      break;
    case "topic.retire":
    case "topic.restore":
      add(event.before.redirectTo);
      add(event.after.redirectTo);
      break;
    case "topic.move":
      add(event.before.parentId);
      add(event.after.parentId);
      break;
    case "item.place":
    case "item.unplace":
    case "item.move":
      add(event.before?.topicId);
      add(event.after?.topicId);
      break;
    default:
      break;
  }
  return [...refs].sort(compareStrings);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => compareStrings(a, b));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

/** An update whose before and after are equal changes nothing. */
export function isNoOpEvent(event: StructureEvent): boolean {
  switch (event.op) {
    case "topic.move":
    case "topic.rename":
    case "topic.describe":
    case "topic.manage":
    case "item.move":
      return canonicalJson(event.before) === canonicalJson(event.after);
    default:
      return false;
  }
}

/** A change-set records only the events that change something (minimal change-sets). */
export function minimalEvents(events: readonly StructureEvent[]): StructureEvent[] {
  return events.filter((event) => !isNoOpEvent(event));
}

/** Notes whose primary placement an event adds or removes (their root source may start or stop counting, D8). */
export function primaryNoteChanges(events: readonly StructureEvent[]): string[] {
  const notes = new Set<string>();
  for (const event of events) {
    const primary =
      (event.op === "item.place" && event.after.rank === 0) ||
      (event.op === "item.unplace" && event.before.rank === 0);
    const item = primary ? eventItem(event) : null;
    if (item?.kind === "note") notes.add(item.id);
  }
  return [...notes].sort(compareStrings);
}

// ---------------------------------------------------------------------------
// State bridge

function depthOrder(topics: readonly TopicRecord[], rootId: string): TopicRecord[] {
  const children = new Map<string, TopicRecord[]>();
  for (const topic of topics) {
    if (topic.parentId === null) continue;
    const list = children.get(topic.parentId) ?? [];
    list.push(topic);
    children.set(topic.parentId, list);
  }
  const ordered: TopicRecord[] = [];
  const queue = [rootId];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index] as string) ?? []) {
      ordered.push(child);
      queue.push(child.id);
    }
  }
  if (ordered.length !== topics.length - 1) {
    throw new Error("Topic records are not one tree under the root");
  }
  return ordered;
}

/**
 * The engine state of stored records. With item data, items carry their content hash and root
 * source (statistics need them); without, placeholders that only serve the canonical dump.
 */
export function stateFromRecords(records: TopicTreeRecords, items?: TopicItemData): TopicTreeState {
  const root = records.topics.find((topic) => topic.id === records.tree.rootId);
  if (!root) throw new Error(`Topic tree ${records.tree.id} has no root record`);
  const state = createTopicTreeState({
    dim: records.tree.dimensions,
    rootId: root.id,
    root: {
      title: root.title,
      nameState: root.nameState,
      nameSource: root.nameSource,
      nameLanguage: root.nameLanguage,
      namedChangeSetId: root.namedChangeSetId,
      description: root.description,
      aliases: [...root.aliases],
      management: root.management,
      position: root.position,
      retiredAt: root.retiredAt,
      redirectTo: root.redirectTo,
      createdChangeSetId: root.createdChangeSetId
    }
  });
  for (const topic of depthOrder(records.topics, root.id)) insertTopic(state, topic);
  for (const { item } of records.placements) {
    if (state.items.has(item)) continue;
    const parsed = parseItemKey(item);
    if (!parsed) throw new TypeError(`Invalid item key ${item}`);
    const info = items
      ? items.entries.get(item)
      : { kind: parsed.kind, contentHash: item, rootSource: null };
    if (!info) throw new Error(`Item ${item} has no data`);
    if (info.kind !== parsed.kind) throw new Error(`Item ${item} is not a ${info.kind}`);
    registerItem(state, { key: item, ...info });
  }
  for (const { item, placement } of records.placements) insertPlacement(state, item, placement);
  state.generation = records.tree.generation;
  state.clock = records.tree.clock;
  return state;
}

/** The engine's canonical dump of stored records: equal dumps mean equal persistent structure. */
export function topicTreeRecordsDump(records: TopicTreeRecords): string {
  return canonicalStateDump(stateFromRecords(records));
}

/** Stored statistics loaded into a state (the exact values of topics outside a recompute). */
export interface StoredTopicStats {
  topicId: string;
  n: number;
  ls: Float64Array;
  cosSqSum: number;
  lowCosPercentiles: Float32Array;
  repairClock: number | null;
}

export function loadStoredStats(state: TopicTreeState, rows: readonly StoredTopicStats[]): void {
  for (const row of rows) {
    const node = state.topics.get(row.topicId);
    if (!node) continue;
    node.stats.n = row.n;
    node.stats.ls.set(row.ls);
    node.stats.cosSqSum = row.cosSqSum;
    node.stats.lowCosPercentiles = row.lowCosPercentiles;
    updateCentroid(node.stats);
    node.control.repairClock = row.repairClock;
  }
}

/** Statistics writes for live topics of an engine state, with the centralities of their items. */
export function topicStatsWrites(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  topicIds: Iterable<string>
): TopicStatsWrite[] {
  const writes: TopicStatsWrite[] = [];
  for (const topicId of [...new Set(topicIds)].sort(compareStrings)) {
    const node = state.topics.get(topicId);
    if (!node || !isLive(node)) continue;
    const items = [...node.items, ...node.secondaryItems];
    writes.push({
      topicId,
      n: node.stats.n,
      ls: node.stats.ls,
      cosSqSum: node.stats.cosSqSum,
      lowCosPercentiles: node.stats.lowCosPercentiles,
      repairClock: node.control.repairClock,
      centralities: items.map((item) => ({
        item,
        centrality: itemCentrality(state, vectors, item, topicId)
      }))
    });
  }
  return writes;
}

/** m = |LS| / N of a stats write (stored as `topic_stats.coherence`), null when empty. */
export function statsCoherence(write: TopicStatsWrite): number | null {
  if (write.n === 0) return null;
  return coherenceOf({
    n: write.n,
    ls: write.ls,
    centroid: new Float32Array(0),
    cosSqSum: write.cosSqSum,
    lowCosPercentiles: new Float32Array(0)
  });
}

/** N and the exact bits of LS per live topic, sorted by ID: the engine's `statsDump` format. */
export function storedStatsDump(
  records: TopicTreeRecords,
  stats: readonly { topicId: string; n: number; ls: Float64Array }[]
): string {
  const live = new Set(records.topics.filter((topic) => topic.retiredAt === null).map((t) => t.id));
  const rows = stats
    .filter((row) => live.has(row.topicId))
    .map((row): [string, number, string] => [
      row.topicId,
      row.n,
      Buffer.from(row.ls.buffer, row.ls.byteOffset, row.ls.byteLength).toString("hex")
    ])
    .sort((a, b) => compareStrings(a[0], b[0]));
  return JSON.stringify(rows);
}
