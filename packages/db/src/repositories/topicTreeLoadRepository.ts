import { endianness } from "node:os";

import type { QueryResultRow } from "pg";

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
import { itemKey, parseItemKey } from "@app/domain/topic-tree";
import type {
  EmbeddingMatrix,
  ItemKey,
  PlacementRecord,
  TopicRecord
} from "@app/domain/topic-tree";

import type { Queryable } from "./types.js";

// Read-only bulk loading for the topic service (F2, T12b, T15): the tree skeleton, the vectors of
// a set of items, the items that still need a placement, the owners of items (status and root
// source) and the newest note vector's space. Everything here only reads: the engine
// writes the structure tables through `topicTreeRepository` alone (D9), and nothing here may ever
// issue an INSERT, UPDATE or DELETE.
//
// Every statement is bounded: the skeleton comes in keyset pages, vectors in pages of ids that hit
// the `(target_type, target_id, model)` index, pending items in pages of at most `limit` rows and
// owners in pages of primary keys. The newest-space read is the one scan (each embedding table's
// note rows, newest first); the service runs it only when it resolves the space. Vectors are read through pgvector's binary `vector_send` (a quarter of the time of parsing the
// text form, measured by `db:topic-load:verify`) and arrive as one Float32 matrix.

/** Storage identity of note vectors: `native-v2:<space key>` (`knowledge-service.ts`). */
export const noteVectorStrategyPrefix = "native-v2:";
/** Storage identity of a source's composite vector: `source-composite-centroid-v2:<space key>`. */
export const sourceVectorStrategyPrefix = "source-composite-centroid-v2:";

export const topicLoadDefaults = {
  /** Topics (with their statistics) per statement; a statistic is `dimensions * 8` bytes. */
  topicPageSize: 500,
  /** Placements per statement. */
  placementPageSize: 5_000,
  /** Item ids per vector statement. */
  vectorPageSize: 1_000,
  /** Pending items per call. */
  pendingLimit: 500,
  /** Reads of the skeleton before giving up on a tree that keeps changing under it. */
  snapshotAttempts: 3
} as const;

/** A stored vector or statistic is not what the tree's space says it must be. */
export class TopicLoadError extends Error {
  override readonly name: string = "TopicLoadError";
}

/** The tree changed during every attempt to read its skeleton. */
export class TopicSkeletonUnstableError extends TopicLoadError {
  override readonly name = "TopicSkeletonUnstableError";
}

export type TopicLoadDimensions = 256 | 768 | 1024;

/** The embedding space of a tree (`topic_trees` columns); vectors of other spaces never load. */
export interface TopicLoadSpace {
  spaceKey: string;
  provider: string;
  model: string;
  runtime: string;
  dimensions: TopicLoadDimensions;
}

export interface TopicSkeletonTree {
  id: string;
  status: TopicTreeStatus;
  space: TopicLoadSpace;
  /** The stored configuration (`TopicTreeConfigSchema` parses it). */
  config: unknown;
  configHash: string;
  seed: number;
  /** Applied change-sets so far (optimistic concurrency with the writer). */
  generation: number;
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
}

/** `topic_stats` of one topic: the exact, derived statistics (D7) plus their bookkeeping. */
export interface TopicSkeletonStats {
  spaceKey: string;
  n: number;
  /** Sum of the unit vectors of the items that count; length = the tree's dimensions. */
  ls: Float64Array;
  cosSqSum: number;
  /** Lower percentiles 0%..10% of member cosines at the last refresh. */
  lowCosPercentiles: Float32Array;
  coherence: number | null;
  directItems: number;
  children: number;
  health: TopicHealth;
  violations: unknown[];
  /** A cascade deleted members (D32) or a write flagged the path: recompute before trusting it. */
  dirty: boolean;
  lastRepairAt: string | null;
  /** Tree clock of the last repair; null when the topic was never repaired. */
  repairClock: number | null;
  computedAt: string;
}

/** A topic (live or retired, I9) with its statistics; `stats` is null before the first recompute. */
export interface TopicSkeletonTopic extends TopicRecord {
  stats: TopicSkeletonStats | null;
}

/** One `topic_placements` row. Rank 0 is the primary placement. */
export interface TopicSkeletonPlacement extends PlacementRecord {
  id: string;
  itemKind: TopicItemKind;
  itemId: string;
  /** `note:<uuid>` or `source:<uuid>`. */
  key: ItemKey;
  centrality: number | null;
  changeSetId: string | null;
}

export interface TopicSkeleton {
  tree: TopicSkeletonTree;
  /** Every topic of the tree in `id` order (retired ones stay as redirects). */
  topics: TopicSkeletonTopic[];
  /** Every placement in item-key order, then rank. */
  placements: TopicSkeletonPlacement[];
}

export interface TopicItemVectorRequest {
  kind: TopicItemKind;
  id: string;
  /**
   * Hash of the content the vector must have been built from (the note's embedding text). A
   * vector built from other content is stale (D7) and is reported instead of loaded. Omit it to
   * accept the vector stored in the space.
   */
  contentHash?: string;
}

export interface TopicItemVectors {
  dim: number;
  /** Items with a current vector, in request order. */
  keys: ItemKey[];
  /**
   * The content hash of each vector (aligned with `keys`). It is the placement fingerprint:
   * a placement whose `itemFingerprint` differs from it was decided on another vector.
   */
  contentHashes: string[];
  /** Row `i` is the unit vector of `keys[i]`. */
  matrix: EmbeddingMatrix;
  /** Items with no usable vector in the space (never embedded, other space, or a zero vector). */
  missing: ItemKey[];
  /** Items whose stored vector was built from other content than `contentHash`. */
  stale: ItemKey[];
}

export const topicPendingReasons = [
  "unplaced",
  "needs_vector",
  "stale",
  "needs_gate",
  "needs_split_check"
] as const;
export type TopicPendingReason = (typeof topicPendingReasons)[number];

export interface TopicPendingItem {
  kind: TopicItemKind;
  id: string;
  key: ItemKey;
  /** The first matching reason: unplaced, needs_vector, stale, needs_gate, then needs_split_check. */
  reason: TopicPendingReason;
  /** Topic of the item's primary placement; null for an unplaced item. */
  topicId: string | null;
  /** The root source of the item; null for a knowledge-owned note that has none. */
  rootSourceId: string | null;
}

export interface TopicPendingPage {
  items: TopicPendingItem[];
  /** Pass as `after` to continue: the last item examined (not necessarily a returned one). Null at the end. */
  next: ItemKey | null;
}

export interface TopicPendingOptions {
  /** Items examined per call (default `topicLoadDefaults.pendingLimit`). */
  limit?: number;
  /** The `next` of the previous page. Notes come first, then sources, each in id order. */
  after?: ItemKey | null;
  /** Restrict to the items of one root source (its notes and itself). */
  rootSourceId?: string;
  /** Restrict the notes to these ids (sources are then not scanned). */
  noteIds?: readonly string[];
  /** Reasons to report (default all). */
  reasons?: readonly TopicPendingReason[];
}

/** A note's root source (through its owning source, as `pendingItems` reads it) and its status. */
export interface TopicNoteOwner {
  id: string;
  /** Not rejected, not archived and not superseded. */
  current: boolean;
  /** The root of the note's owning source; null for a knowledge-owned note. */
  rootSourceId: string | null;
}

/** A source's hierarchy root and its content hash (part of its content key, D22). */
export interface TopicSourceOwner {
  id: string;
  /** The top of its source hierarchy (its own id for a root source); null on a broken chain. */
  rootSourceId: string | null;
  contentHash: string | null;
}

export interface TopicItemOwners {
  /** The requested notes that exist; a requested note missing here was deleted. */
  notes: Map<string, TopicNoteOwner>;
  /** The requested sources that exist. */
  sources: Map<string, TopicSourceOwner>;
}

export interface TopicItemOwnersOptions {
  /** Item ids per statement (default `vectorPageSize`). */
  pageSize?: number;
}

export interface TopicSkeletonOptions {
  /** Reads before giving up when the generation moves (default `snapshotAttempts`). */
  attempts?: number;
  topicPageSize?: number;
  placementPageSize?: number;
}

export interface TopicItemVectorsOptions {
  /** Item ids per statement (default `vectorPageSize`). */
  pageSize?: number;
  /** Normalize every row to unit length (default true); a zero row is reported as missing. */
  normalize?: boolean;
}

// ---------------------------------------------------------------------------
// Decoding

/**
 * Decodes a `topic_stats.ls` value: `dim` little-endian float64 values (the byte order of every
 * supported platform). An empty value is the zero vector of an empty topic.
 */
export function decodeFloat64Vector(value: Uint8Array, dim: number): Float64Array {
  if (endianness() !== "LE") throw new TopicLoadError("Topic statistics are stored little-endian.");
  const out = new Float64Array(dim);
  if (value.byteLength === 0) return out;
  if (value.byteLength !== dim * 8) {
    throw new TopicLoadError(`Statistic has ${value.byteLength} bytes, expected ${dim * 8}.`);
  }
  new Uint8Array(out.buffer).set(value);
  return out;
}

/** Encodes a statistic the way `decodeFloat64Vector` reads it. */
export function encodeFloat64Vector(values: Float64Array): Buffer {
  if (endianness() !== "LE") throw new TopicLoadError("Topic statistics are stored little-endian.");
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

/**
 * Copies the payload of a pgvector binary value (`vector_send`: int16 dimensions, int16 unused,
 * then big-endian float32 values) into `target`, still big-endian; the caller swaps a whole page
 * at once.
 */
function copyVectorPayload(value: Uint8Array, dim: number, target: Uint8Array, at: number): void {
  const header = value.byteLength >= 4 ? (value[0]! << 8) | value[1]! : -1;
  if (header !== dim || value.byteLength !== 4 + dim * 4) {
    throw new TopicLoadError(`Stored vector has ${header} dimensions, expected ${dim}.`);
  }
  target.set(value.subarray(4), at);
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

// ---------------------------------------------------------------------------
// SQL (exported so the latency proof can EXPLAIN exactly what the repository runs)

const embeddingTable = (dimensions: number): string => {
  if (dimensions === 256 || dimensions === 768 || dimensions === 1024) {
    return `embeddings_${dimensions}`;
  }
  throw new TopicLoadError(`Unsupported embedding dimension: ${dimensions}`);
};

export type TopicPendingNoteScope = "library" | "root" | "ids";
export type TopicPendingSourceScope = "library" | "root";

// Pending items are read in windows of at most $5 ids in primary-key order after the cursor $4, so
// a sweep never scans a table: the window is joined to the placement and the vector by lateral
// subqueries with a limit, which the planner runs as index probes per id (it cannot flatten them
// into a hash join that reads the whole table). $1 tree, $2 model, $3 strategy, $6 reasons, and $7
// the root source or the note ids of a scoped read. A note's root is the root of its owning source;
// knowledge-owned notes have none.
const currentNote =
  "a.status not in ('rejected', 'archived') and a.supersession_status = 'current'";
const noteWindows: Record<TopicPendingNoteScope, string> = {
  library: `with win as materialized (
      select a.id, a.owning_source_item_id as owner from atomic_notes a
      where ${currentNote} and ($4::uuid is null or a.id > $4)
      order by a.id limit $5
    )`,
  ids: `with win as materialized (
      select a.id, a.owning_source_item_id as owner from atomic_notes a
      where ${currentNote} and a.id = any($7::uuid[]) and ($4::uuid is null or a.id > $4)
      order by a.id limit $5
    )`,
  // The notes of the root are found through the source index first; ordering them is cheap.
  root: `with recursive sub(id) as (select $7::uuid
        union all select s.id from source_items s join sub on s.parent_source_item_id = sub.id),
    scoped as materialized (
      select a.id, a.owning_source_item_id as owner from atomic_notes a
      where a.created_from_source_item_id = any(array(select id from sub))
        and ${currentNote} and a.ownership = 'source'
    ), win as materialized (
      select id, owner from scoped where ($4::uuid is null or id > $4) order by id limit $5
    )`
};
const sourceWindows: Record<TopicPendingSourceScope, string> = {
  library: `with win as materialized (
      select s.id from source_items s where s.parent_source_item_id is null and ($4::uuid is null or s.id > $4)
      order by s.id limit $5
    )`,
  root: `with win as materialized (
      select s.id from source_items s
      where s.id = $7::uuid and s.parent_source_item_id is null and ($4::uuid is null or s.id > $4)
      order by s.id limit $5
    )`
};
/** The pending rows of the reasons asked for, then the cursor row: the last id of the window and its size. */
const pendingTail = (
  rootColumn: string
): string => `select 'item' as part, id, reason, topic_id as "topicId",
        ${rootColumn} as "rootSourceId", null::int as examined
      from pending where reason = any($6::text[])
    union all
    select 'cursor', (select id from win order by id desc limit 1), null::text, null::uuid, null::uuid,
      (select count(*)::int from win)
    order by 1 desc, 2`;

// A hierarchy walk up from one source, bounded so that a broken chain can never loop.
const rootOf = (start: string): string => `left join lateral (
      with recursive up(id, parent_id, depth) as (
        select h.id, h.parent_source_item_id, 0 from source_items h where h.id = ${start}
        union all select h.id, h.parent_source_item_id, up.depth + 1 from source_items h
          join up on h.id = up.parent_id where up.depth < 64)
      select up.id from up where up.parent_id is null limit 1) root on true`;

/** The newest note vector of one embedding table that names its space (`native-v2:<space key>`). */
const newestNoteVector = (
  dimensions: number
): string => `(select provider, model, runtime, strategy,
      ${dimensions} as dimensions, created_at from ${embeddingTable(dimensions)}
     where target_type = 'atomic_note' and starts_with(strategy, '${noteVectorStrategyPrefix}')
     order by created_at desc limit 1)`;

export const topicLoadSql = {
  tree: `select id, status, space_key as "spaceKey", embedding_provider as provider,
      embedding_model as model, embedding_runtime as runtime, dimensions, config,
      config_hash as "configHash", seed::text as seed, generation::text as generation,
      created_at as "createdAt", activated_at as "activatedAt", retired_at as "retiredAt"
    from topic_trees where id = $1`,
  activeTree: `select id from topic_trees where status = 'active'`,
  generation: `select generation::text as generation from topic_trees where id = $1`,
  // Keyset pages in the order of the unique index (tree, kind, item, rank).
  placements: `select p.id, p.item_kind as "itemKind", coalesce(p.note_id, p.source_item_id) as "itemId",
      p.topic_id as "topicId", p.rank, p.management, p.decided_by as "decidedBy",
      p.item_fingerprint as "itemFingerprint", p.score, p.margin, p.centrality,
      p.needs_gate as "needsGate", p.needs_split_check as "needsSplitCheck",
      p.needs_vector as "needsVector", p.moved_from_topic_id as "movedFromTopicId",
      p.moved_at as "movedAt", p.change_set_id as "changeSetId"
    from topic_placements p
    where p.tree_id = $1
      and ($2::text is null or (p.item_kind, coalesce(p.note_id, p.source_item_id), p.rank) > ($2::text, $3::uuid, $4::smallint))
    order by p.item_kind, coalesce(p.note_id, p.source_item_id), p.rank
    limit $5`,
  topics: `select t.id, t.parent_id as "parentId", t.role, t.title, t.name_state as "nameState",
      t.name_source as "nameSource", t.name_language as "nameLanguage",
      t.named_change_set_id as "namedChangeSetId", t.description, t.aliases, t.management,
      t.position, t.retired_at as "retiredAt", t.redirect_to as "redirectTo",
      t.created_change_set_id as "createdChangeSetId",
      s.topic_id as "statsTopicId", s.space_key as "statsSpaceKey", s.n, s.ls,
      s.cos_sq_sum as "cosSqSum", s.low_cos_percentiles as "lowCosPercentiles", s.coherence,
      s.direct_items as "directItems", s.children, s.health, s.violations, s.dirty,
      s.last_repair_at as "lastRepairAt", s.repair_clock::text as "repairClock",
      s.computed_at as "computedAt"
    from topics t left join topic_stats s on s.topic_id = t.id
    where t.tree_id = $1 and ($2::uuid is null or t.id > $2)
    order by t.id
    limit $3`,
  itemVectors: (
    dimensions: number
  ): string => `select e.target_id as id, e.content_hash as "contentHash",
      vector_send(e.embedding) as vector
    from ${embeddingTable(dimensions)} e
    where e.target_type = $1 and e.target_id = any($2::uuid[]) and e.model = $3 and e.strategy = $4`,
  // The owners of a page of note ids: the note's status and the root of its owning source.
  noteOwners: `select a.id, (${currentNote}) as current, root.id as "rootSourceId"
    from atomic_notes a
    ${rootOf("a.owning_source_item_id")}
    where a.id = any($1::uuid[])`,
  sourceOwners: `select s.id, s.content_hash as "contentHash", root.id as "rootSourceId"
    from source_items s
    ${rootOf("s.id")}
    where s.id = any($1::uuid[])`,
  // The space of the newest note vector that names one: the topic service's interim space
  // resolver reads it until the AI service computes the route's space without a call (D26, T14).
  newestNoteSpace: `select provider, model, runtime, strategy, dimensions from (
      ${[256, 768, 1024].map(newestNoteVector).join("\n      union all ")}
    ) v order by created_at desc limit 1`,
  pendingNotes: (dimensions: number, scope: TopicPendingNoteScope): string =>
    `${noteWindows[scope]}, pending as (
      select win.id, p.topic_id, root.id as root_id,
        case when p.id is null then 'unplaced'
             when v.hash is not null and p.needs_vector then 'needs_vector'
             when v.hash is not null and p.item_fingerprint is distinct from v.hash then 'stale'
             when p.needs_gate then 'needs_gate'
             when p.needs_split_check then 'needs_split_check' end as reason
      from win
      left join lateral (select p.id, p.topic_id, p.item_fingerprint, p.needs_vector, p.needs_gate,
          p.needs_split_check from topic_placements p
        where p.note_id = win.id and p.tree_id = $1 and p.rank = 0 limit 1) p on true
      left join lateral (select e.content_hash as hash from ${embeddingTable(dimensions)} e
        where e.target_type = 'atomic_note' and e.target_id = win.id and e.model = $2
          and e.strategy = $3 limit 1) v on true
      left join lateral (with recursive up(id, parent_id) as (
          select s.id, s.parent_source_item_id from source_items s where s.id = win.owner
          union all select s.id, s.parent_source_item_id from source_items s join up on s.id = up.parent_id)
        select up.id from up where up.parent_id is null limit 1) root on true
    )
    ${pendingTail("root_id")}`,
  pendingSources: (dimensions: number, scope: TopicPendingSourceScope): string =>
    `${sourceWindows[scope]}, pending as (
      select win.id, p.topic_id,
        case when p.id is null then 'unplaced'
             when v.hash is not null and p.needs_vector then 'needs_vector'
             when p.needs_gate then 'needs_gate'
             when p.needs_split_check then 'needs_split_check' end as reason
      from win
      left join lateral (select p.id, p.topic_id, p.needs_vector, p.needs_gate, p.needs_split_check
        from topic_placements p
        where p.source_item_id = win.id and p.tree_id = $1 and p.rank = 0 limit 1) p on true
      left join lateral (select e.content_hash as hash from ${embeddingTable(dimensions)} e
        where e.target_type = 'source_item' and e.target_id = win.id and e.model = $2
          and e.strategy = $3 limit 1) v on true
    )
    ${pendingTail("id")}`
};

// ---------------------------------------------------------------------------
// Rows

interface TreeRow extends QueryResultRow {
  id: string;
  status: TopicTreeStatus;
  spaceKey: string;
  provider: string;
  model: string;
  runtime: string;
  dimensions: number;
  config: unknown;
  configHash: string;
  seed: string;
  generation: string;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

interface PlacementRow extends QueryResultRow {
  id: string;
  itemKind: TopicItemKind;
  itemId: string;
  topicId: string;
  rank: number;
  management: TopicPlacementManagement;
  decidedBy: TopicPlacementDecision;
  itemFingerprint: string | null;
  score: number | null;
  margin: number | null;
  centrality: number | null;
  needsGate: boolean;
  needsSplitCheck: boolean;
  needsVector: boolean;
  movedFromTopicId: string | null;
  movedAt: Date | null;
  changeSetId: string | null;
}

interface TopicRow extends QueryResultRow {
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
  retiredAt: Date | null;
  redirectTo: string | null;
  createdChangeSetId: string | null;
  statsTopicId: string | null;
  statsSpaceKey: string | null;
  n: number | null;
  ls: Buffer | null;
  cosSqSum: number | null;
  lowCosPercentiles: number[] | null;
  coherence: number | null;
  directItems: number | null;
  children: number | null;
  health: TopicHealth | null;
  violations: unknown[] | null;
  dirty: boolean | null;
  lastRepairAt: Date | null;
  repairClock: string | null;
  computedAt: Date | null;
}

interface PendingRow extends QueryResultRow {
  part: "item" | "cursor";
  id: string | null;
  reason: TopicPendingReason | null;
  topicId: string | null;
  rootSourceId: string | null;
  /** On the cursor row: how many ids the window held. */
  examined: number | null;
}

interface NoteOwnerRow extends QueryResultRow {
  id: string;
  current: boolean;
  rootSourceId: string | null;
}

interface SourceOwnerRow extends QueryResultRow {
  id: string;
  contentHash: string | null;
  rootSourceId: string | null;
}

interface StoredSpaceRow extends QueryResultRow {
  provider: string;
  model: string;
  runtime: string;
  strategy: string;
  dimensions: number;
}

function toSpace(row: TreeRow): TopicLoadSpace {
  const dimensions = Number(row.dimensions);
  if (dimensions !== 256 && dimensions !== 768 && dimensions !== 1024) {
    throw new TopicLoadError(`Unsupported tree dimension ${row.dimensions}.`);
  }
  return {
    spaceKey: row.spaceKey,
    provider: row.provider,
    model: row.model,
    runtime: row.runtime,
    dimensions
  };
}

function toTree(row: TreeRow): TopicSkeletonTree {
  return {
    id: row.id,
    status: row.status,
    space: toSpace(row),
    config: row.config,
    configHash: row.configHash,
    seed: Number(row.seed),
    generation: Number(row.generation),
    createdAt: new Date(row.createdAt).toISOString(),
    activatedAt: iso(row.activatedAt),
    retiredAt: iso(row.retiredAt)
  };
}

function toPlacement(row: PlacementRow): TopicSkeletonPlacement {
  return {
    id: row.id,
    itemKind: row.itemKind,
    itemId: row.itemId,
    key: itemKey(row.itemKind, row.itemId),
    topicId: row.topicId,
    rank: Number(row.rank),
    management: row.management,
    decidedBy: row.decidedBy,
    itemFingerprint: row.itemFingerprint,
    score: row.score,
    margin: row.margin,
    centrality: row.centrality,
    needsGate: row.needsGate,
    needsSplitCheck: row.needsSplitCheck,
    needsVector: row.needsVector,
    movedFromTopicId: row.movedFromTopicId,
    movedAt: iso(row.movedAt),
    changeSetId: row.changeSetId
  };
}

function toTopic(row: TopicRow, dim: number): TopicSkeletonTopic {
  const { statsTopicId } = row;
  const stats: TopicSkeletonStats | null =
    statsTopicId === null
      ? null
      : {
          spaceKey: row.statsSpaceKey ?? "",
          n: Number(row.n),
          ls: decodeFloat64Vector(row.ls ?? new Uint8Array(0), dim),
          cosSqSum: Number(row.cosSqSum),
          lowCosPercentiles: Float32Array.from(row.lowCosPercentiles ?? []),
          coherence: row.coherence,
          directItems: Number(row.directItems),
          children: Number(row.children),
          health: row.health ?? "good",
          violations: row.violations ?? [],
          dirty: row.dirty === true,
          lastRepairAt: iso(row.lastRepairAt),
          repairClock: row.repairClock === null ? null : Number(row.repairClock),
          computedAt: new Date(row.computedAt ?? 0).toISOString()
        };
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
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    management: row.management,
    position: Number(row.position),
    retiredAt: iso(row.retiredAt),
    redirectTo: row.redirectTo,
    createdChangeSetId: row.createdChangeSetId,
    stats
  };
}

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  const chosen = value ?? fallback;
  if (!Number.isInteger(chosen) || chosen < 1 || chosen > max) {
    throw new TopicLoadError(`Page size ${chosen} is outside 1..${max}.`);
  }
  return chosen;
}

/** Vector storage identity of an item kind in a space. */
function vectorTarget(kind: TopicItemKind, space: TopicLoadSpace) {
  return kind === "note"
    ? { targetType: "atomic_note", strategy: `${noteVectorStrategyPrefix}${space.spaceKey}` }
    : { targetType: "source_item", strategy: `${sourceVectorStrategyPrefix}${space.spaceKey}` };
}

export function createTopicTreeLoadRepository(db: Queryable) {
  async function readTree(treeId: string): Promise<TopicSkeletonTree | null> {
    const result = await db.query<TreeRow>(topicLoadSql.tree, [treeId]);
    const row = result.rows[0];
    return row ? toTree(row) : null;
  }

  async function readGeneration(treeId: string): Promise<number | null> {
    const result = await db.query<QueryResultRow & { generation: string }>(
      topicLoadSql.generation,
      [treeId]
    );
    const row = result.rows[0];
    return row ? Number(row.generation) : null;
  }

  async function readPlacements(tree: TopicSkeletonTree, pageSize: number) {
    const placements: TopicSkeletonPlacement[] = [];
    let cursor: TopicSkeletonPlacement | null = null;
    for (;;) {
      const result: { rows: PlacementRow[] } = await db.query<PlacementRow>(
        topicLoadSql.placements,
        [tree.id, cursor?.itemKind ?? null, cursor?.itemId ?? null, cursor?.rank ?? null, pageSize]
      );
      for (const row of result.rows) placements.push(toPlacement(row));
      if (result.rows.length < pageSize) return placements;
      cursor = placements[placements.length - 1] ?? null;
    }
  }

  async function readTopics(tree: TopicSkeletonTree, pageSize: number) {
    const topics: TopicSkeletonTopic[] = [];
    let after: string | null = null;
    for (;;) {
      const result: { rows: TopicRow[] } = await db.query<TopicRow>(topicLoadSql.topics, [
        tree.id,
        after,
        pageSize
      ]);
      for (const row of result.rows) topics.push(toTopic(row, tree.space.dimensions));
      if (result.rows.length < pageSize) return topics;
      after = topics[topics.length - 1]?.id ?? null;
    }
  }

  return {
    /**
     * Who owns a set of items: for each note that exists, whether it is current and the root of its
     * owning source (null for a knowledge-owned note, as `pendingItems` reports it); for each source,
     * its hierarchy root and content hash. Ids are read in pages through the primary keys; a
     * requested id that is missing from the answer no longer exists.
     */
    async itemOwners(
      input: { noteIds?: readonly string[]; sourceIds?: readonly string[] },
      options: TopicItemOwnersOptions = {}
    ): Promise<TopicItemOwners> {
      const pageSize = positiveInteger(options.pageSize, topicLoadDefaults.vectorPageSize, 10_000);
      const owners: TopicItemOwners = { notes: new Map(), sources: new Map() };
      const noteIds = [...new Set((input.noteIds ?? []).map((id) => id.toLowerCase()))];
      const sourceIds = [...new Set((input.sourceIds ?? []).map((id) => id.toLowerCase()))];
      for (let start = 0; start < noteIds.length; start += pageSize) {
        const result = await db.query<NoteOwnerRow>(topicLoadSql.noteOwners, [
          noteIds.slice(start, start + pageSize)
        ]);
        for (const row of result.rows) {
          owners.notes.set(row.id, {
            id: row.id,
            current: row.current === true,
            rootSourceId: row.rootSourceId
          });
        }
      }
      for (let start = 0; start < sourceIds.length; start += pageSize) {
        const result = await db.query<SourceOwnerRow>(topicLoadSql.sourceOwners, [
          sourceIds.slice(start, start + pageSize)
        ]);
        for (const row of result.rows) {
          owners.sources.set(row.id, {
            id: row.id,
            rootSourceId: row.rootSourceId,
            contentHash: row.contentHash
          });
        }
      }
      return owners;
    },

    /**
     * The embedding space of the newest stored note vector that names its space, or null when no
     * note has one. Vectors without a space identity (`native-unidentified`) are never guessed.
     */
    async newestNoteVectorSpace(): Promise<TopicLoadSpace | null> {
      const result = await db.query<StoredSpaceRow>(topicLoadSql.newestNoteSpace);
      const row = result.rows[0];
      if (!row) return null;
      const dimensions = Number(row.dimensions);
      if (dimensions !== 256 && dimensions !== 768 && dimensions !== 1024) return null;
      const spaceKey = row.strategy.slice(noteVectorStrategyPrefix.length);
      if (!spaceKey) return null;
      return {
        spaceKey,
        provider: row.provider,
        model: row.model,
        runtime: row.runtime,
        dimensions
      };
    },

    /** The id of the active tree, or null when none exists yet (D39 creates it). */
    async activeTreeId(): Promise<string | null> {
      const result = await db.query<QueryResultRow & { id: string }>(topicLoadSql.activeTree);
      return result.rows[0]?.id ?? null;
    },

    /**
     * The whole skeleton of a tree: the tree row, its placements and then its topics with their
     * exact statistics, all in keyset pages. Statistics are read last so that a dirty flag set by
     * a cascade (D32) during the read is never missed. The read is one consistent view of the
     * change-sets: when the generation moved while reading, it is read again, up to `attempts`
     * times. Returns null when the tree does not exist.
     */
    async loadSkeleton(
      treeId: string,
      options: TopicSkeletonOptions = {}
    ): Promise<TopicSkeleton | null> {
      const attempts = positiveInteger(options.attempts, topicLoadDefaults.snapshotAttempts, 10);
      const topicPageSize = positiveInteger(
        options.topicPageSize,
        topicLoadDefaults.topicPageSize,
        5_000
      );
      const placementPageSize = positiveInteger(
        options.placementPageSize,
        topicLoadDefaults.placementPageSize,
        50_000
      );
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const tree = await readTree(treeId);
        if (!tree) return null;
        const placements = await readPlacements(tree, placementPageSize);
        const topics = await readTopics(tree, topicPageSize);
        if ((await readGeneration(treeId)) === tree.generation) return { tree, topics, placements };
      }
      throw new TopicSkeletonUnstableError(
        `Topic tree ${treeId} changed during ${attempts} attempts to read it.`
      );
    },

    /**
     * Loads the vectors of `items` in `space`, a page of ids per statement, as one unit-length
     * Float32 matrix in request order. Only vectors of exactly this space are read (a different
     * model, revision or runtime has a different space key). Items without one are reported, never
     * guessed (`rules/data.md`).
     */
    async loadItemVectors(
      space: TopicLoadSpace,
      items: readonly TopicItemVectorRequest[],
      options: TopicItemVectorsOptions = {}
    ): Promise<TopicItemVectors> {
      const pageSize = positiveInteger(options.pageSize, topicLoadDefaults.vectorPageSize, 10_000);
      const normalize = options.normalize ?? true;
      if (endianness() !== "LE") throw new TopicLoadError("Vectors are decoded little-endian.");
      const dim = space.dimensions;
      const capacity = new Float32Array(items.length * dim);
      const bytes = new Uint8Array(capacity.buffer);
      const keys: ItemKey[] = [];
      const contentHashes: string[] = [];
      const missing: ItemKey[] = [];
      const stale: ItemKey[] = [];
      const sql = topicLoadSql.itemVectors(dim);
      const seen = new Set<ItemKey>();
      for (let start = 0; start < items.length; start += pageSize) {
        const page = items.slice(start, start + pageSize);
        const found = new Map<string, { contentHash: string; vector: Uint8Array }>();
        for (const kind of ["note", "source"] as const) {
          const ids = page
            .filter((item) => item.kind === kind)
            .map((item) => item.id.toLowerCase());
          if (ids.length === 0) continue;
          const target = vectorTarget(kind, space);
          const result = await db.query<
            QueryResultRow & { id: string; contentHash: string; vector: Buffer }
          >(sql, [target.targetType, ids, space.model, target.strategy]);
          for (const row of result.rows) {
            found.set(itemKey(kind, row.id), { contentHash: row.contentHash, vector: row.vector });
          }
        }
        const first = keys.length;
        for (const item of page) {
          const key = itemKey(item.kind, item.id);
          if (seen.has(key)) continue;
          seen.add(key);
          const vector = found.get(key);
          if (!vector) {
            missing.push(key);
          } else if (item.contentHash !== undefined && vector.contentHash !== item.contentHash) {
            stale.push(key);
          } else {
            copyVectorPayload(vector.vector, dim, bytes, keys.length * dim * 4);
            keys.push(key);
            contentHashes.push(vector.contentHash);
          }
        }
        // The payload is big-endian: swap the page's rows in place.
        const rows = keys.length - first;
        if (rows > 0) Buffer.from(capacity.buffer, first * dim * 4, rows * dim * 4).swap32();
      }
      return finishLoad(capacity, dim, normalize, keys, contentHashes, missing, stale);
    },

    /**
     * Items that need PLACE or the gate, in id order, notes first then root sources. Each call
     * examines at most `limit` items through index probes (no statement scans a table) and returns
     * the pending ones with a cursor; loop until `next` is null. A note is pending while it has no
     * primary placement in the tree (`unplaced`), when its vector now exists for a placement that
     * waited for one (`needs_vector`), when its stored vector is not the one its placement was
     * decided on (`stale`: `itemFingerprint` differs from the vector's content hash), or while the
     * placement waits for the gate (`needs_gate`, `needs_split_check`). A root source is
     * `unplaced`, `needs_vector` (its composite vector now exists) or waits for the gate; the
     * service re-places it from its notes (D8). Current means a note that is not rejected or
     * archived and not superseded.
     */
    async pendingItems(
      treeId: string,
      space: TopicLoadSpace,
      options: TopicPendingOptions = {}
    ): Promise<TopicPendingPage> {
      const limit = positiveInteger(options.limit, topicLoadDefaults.pendingLimit, 5_000);
      const reasons = options.reasons ?? topicPendingReasons;
      const cursor = options.after ? parseItemKey(options.after) : null;
      if (options.after && !cursor) throw new TopicLoadError(`Invalid cursor ${options.after}.`);
      const rootSourceId = options.rootSourceId ?? null;
      if (rootSourceId && options.noteIds) {
        throw new TopicLoadError("Scope pending items by a root source or by note ids, not both.");
      }
      const noteScope: TopicPendingNoteScope = options.noteIds
        ? "ids"
        : rootSourceId
          ? "root"
          : "library";
      const noteScoped: unknown[] = options.noteIds
        ? [options.noteIds.map((id) => id.toLowerCase())]
        : rootSourceId
          ? [rootSourceId]
          : [];
      const items: TopicPendingItem[] = [];
      const scan = async (
        kind: TopicItemKind,
        sql: string,
        after: string | null,
        window: number,
        scoped: unknown[]
      ): Promise<{ examined: number; last: string | null }> => {
        const result = await db.query<PendingRow>(sql, [
          treeId,
          space.model,
          vectorTarget(kind, space).strategy,
          after,
          window,
          [...reasons],
          ...scoped
        ]);
        let examined = 0;
        let last: string | null = null;
        for (const row of result.rows) {
          if (row.part === "cursor") {
            examined = Number(row.examined);
            last = row.id;
          } else if (row.id !== null && row.reason !== null) {
            items.push({
              kind,
              id: row.id,
              key: itemKey(kind, row.id),
              reason: row.reason,
              topicId: row.topicId,
              rootSourceId: row.rootSourceId
            });
          }
        }
        return { examined, last };
      };
      let remaining = limit;
      if (!cursor || cursor.kind === "note") {
        const notes = await scan(
          "note",
          topicLoadSql.pendingNotes(space.dimensions, noteScope),
          cursor?.id ?? null,
          limit,
          noteScoped
        );
        // A full window may have more notes behind it: continue from its last note.
        if (notes.examined >= limit && notes.last) {
          return { items, next: itemKey("note", notes.last) };
        }
        remaining -= notes.examined;
      }
      if (options.noteIds !== undefined) return { items, next: null };
      const sources = await scan(
        "source",
        topicLoadSql.pendingSources(space.dimensions, rootSourceId ? "root" : "library"),
        cursor?.kind === "source" ? cursor.id : null,
        remaining,
        rootSourceId ? [rootSourceId] : []
      );
      return {
        items,
        next: sources.examined >= remaining && sources.last ? itemKey("source", sources.last) : null
      };
    }
  };
}

export type TopicTreeLoadRepository = ReturnType<typeof createTopicTreeLoadRepository>;

/** Scales a row to unit length; false when it has no direction (all zero). */
function normalizeRow(data: Float32Array, offset: number, dim: number): boolean {
  let sum = 0;
  for (let k = 0; k < dim; k += 1) {
    const value = data[offset + k] as number;
    sum += value * value;
  }
  if (!(sum > 0) || !Number.isFinite(sum)) return false;
  const scale = 1 / Math.sqrt(sum);
  for (let k = 0; k < dim; k += 1) data[offset + k] = (data[offset + k] as number) * scale;
  return true;
}

/**
 * Normalizes every row and trims the matrix to the rows kept. A zero vector has no direction: it
 * counts as missing, not as a topic member.
 */
function finishLoad(
  capacity: Float32Array,
  dim: number,
  normalize: boolean,
  keys: ItemKey[],
  contentHashes: string[],
  missing: ItemKey[],
  stale: ItemKey[]
): TopicItemVectors {
  const outKeys: ItemKey[] = [];
  const outHashes: string[] = [];
  keys.forEach((key, row) => {
    if (normalize && !normalizeRow(capacity, row * dim, dim)) {
      missing.push(key);
      return;
    }
    const kept = outKeys.length;
    if (kept !== row) capacity.copyWithin(kept * dim, row * dim, (row + 1) * dim);
    outKeys.push(key);
    outHashes.push(contentHashes[row] as string);
  });
  const count = outKeys.length;
  const data = count * dim === capacity.length ? capacity : capacity.slice(0, count * dim);
  return {
    dim,
    keys: outKeys,
    contentHashes: outHashes,
    matrix: { dim, count, data },
    missing,
    stale
  };
}
