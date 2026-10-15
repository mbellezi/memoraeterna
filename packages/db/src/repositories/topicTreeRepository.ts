// The Topic Tree Engine write repository (F2 T12; D7, D9, D32): the only writer of `topic_trees`,
// `topics`, `topic_stats`, `topic_placements`, `topic_change_sets`, `topic_structure_events` and
// the engine logs (`topic_gate_decisions`, `topic_daily_metrics`, `topic_calibrations`).
//
// Every structural write is one change-set of structure events, applied in a short transaction
// that takes the tree's advisory lock, checks the generation the engine computed from, sets
// `memora.topic_writer = 'engine'` (the database guard refuses AI-managed parent writes without
// it), checks each event's `before` against the stored row and bumps the generation. Statistics
// are derived (D7): the engine passes the exact values of the paths it touched, anything else on
// the paths whose members or children changed is marked dirty (a rename is not such a change),
// and `recomputeStats` restores exact values bottom-up. Placements leave with deleted items by
// cascade and a statement trigger marks their paths dirty (D32).
import { randomUUID } from "node:crypto";

import { topicChangeSetOrigins, topicChangeSetRisks, topicHealthValues } from "@app/domain";
import type {
  TopicChangeSetOrigin,
  TopicChangeSetRisk,
  TopicChangeSetStatus,
  TopicItemKind
} from "@app/domain";
import {
  TopicTreeConfigSchema,
  changeSetBlockers,
  compareStrings,
  invertEvents,
  itemKey,
  maxSecondaries,
  parseItemKey,
  recomputePaths,
  recomputeSubtree
} from "@app/domain/topic-tree";
import type {
  ItemKey,
  PlacementRecord,
  StructureEvent,
  TopicRecord,
  UndoBlocker,
  UndoConflictCode,
  UndoableChangeSet
} from "@app/domain/topic-tree";
import { z } from "zod";

import type { PgPool } from "../client.js";
import {
  decodeTopicVector,
  encodeTopicVector,
  eventItem,
  eventStatsRefs,
  eventTopicRefs,
  loadStoredStats,
  minimalEvents,
  parseStructureEvents,
  placementColumns,
  placementEntryFromRow,
  primaryNoteChanges,
  stateFromRecords,
  statsCoherence,
  topicColumns,
  topicRecordFromRow,
  topicStatsWrites,
  topicTreeColumns,
  topicTreeFromRow
} from "./topicTreeRecords.js";
import type {
  PlacementRow,
  StoredTopicStats,
  TopicItemSource,
  TopicRow,
  TopicStatsWrite,
  TopicTreeRecord,
  TopicTreeRecords,
  TopicTreeRow
} from "./topicTreeRecords.js";
import type { Queryable } from "./types.js";

export {
  decodeTopicVector,
  encodeTopicVector,
  eventStatsRefs,
  eventTopicRefs,
  isNoOpEvent,
  minimalEvents,
  stateFromRecords,
  storedStatsDump,
  topicStatsWrites,
  topicTreeRecordsDump
} from "./topicTreeRecords.js";
export type {
  TopicItemData,
  TopicItemInfo,
  TopicItemSource,
  TopicPlacementEntry,
  TopicStatsWrite,
  TopicTreeDimensions,
  TopicTreeRecord,
  TopicTreeRecords
} from "./topicTreeRecords.js";

/** Bounds of the repository's own work (no engine parameter lives here). */
export const topicTreeRepositoryLimits = {
  /**
   * Engine transactions give up on a row lock after this, below PostgreSQL's 1 s deadlock check,
   * so a stalled change-set is retried by the engine and never aborts the ingestion that holds the
   * lock (an ingestion cascade waits for the tree's statistics rows instead).
   */
  lockTimeoutMs: 500,
  /** Item events applied per statement. */
  itemBatchSize: 2_000,
  /** Structure event rows inserted per statement. */
  eventInsertBatchSize: 5_000,
  /** A recompute retries when a change-set lands while it reads. */
  recomputeAttempts: 3
} as const;

/** The transaction setting the D9 guard trigger requires for AI-managed parent writes. */
export const topicTreeWriterSetting = "memora.topic_writer";

export type TopicTreeRepositoryErrorCode =
  "treeNotFound" | "changeSetNotFound" | "activeTreeExists" | "invalidInput";

/** A refused call (bad input or a missing object); conflicts are results, not errors. */
export class TopicTreeRepositoryError extends Error {
  override readonly name = "TopicTreeRepositoryError";
  constructor(
    readonly code: TopicTreeRepositoryErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** Why one event of a change-set could not be applied to the stored rows. */
export type TopicEventConflictCode =
  | "state"
  | "cycle"
  | "duplicateTitle"
  | "itemDeleted"
  /** A row lock was not granted in time (a concurrent writer holds it); retry later. */
  | "busy";

class TopicEventConflict extends Error {
  constructor(
    readonly index: number,
    readonly code: TopicEventConflictCode,
    readonly reason: string,
    readonly item: ItemKey | null = null,
    readonly topicId: string | null = null
  ) {
    super(`Topic event ${index} conflicts (${code}): ${reason}`);
  }
}

class UndoBlocked extends Error {
  constructor(readonly blockers: UndoBlocker[]) {
    super("Undo blocked");
  }
}

// ---------------------------------------------------------------------------
// Inputs and results

const uuid = z.string().uuid();

const CreateTopicTreeInputSchema = z
  .object({
    id: uuid.optional(),
    rootId: uuid.optional(),
    spaceKey: z.string().min(1).max(300),
    embeddingProvider: z.string().min(1).max(200),
    embeddingModel: z.string().min(1).max(300),
    embeddingRuntime: z.string().min(1).max(200),
    dimensions: z.union([z.literal(256), z.literal(768), z.literal(1024)]),
    config: z.record(z.string(), z.unknown()),
    configHash: z.string().min(1).max(200),
    seed: z.number().int().safe()
  })
  .strict();
export type CreateTopicTreeInput = z.input<typeof CreateTopicTreeInputSchema>;

const ChangeSetMetaSchema = z.object({
  id: uuid.optional(),
  origin: z.enum(topicChangeSetOrigins).refine((origin) => origin !== "undo", {
    message: "Undo change-sets come from undoChangeSet"
  }),
  titleKey: z.string().min(1).max(200),
  titleParams: z.record(z.string(), z.unknown()).default({}),
  risk: z.enum(topicChangeSetRisks).default("low"),
  jobId: uuid.nullable().default(null),
  aiTaskRunIds: z.array(uuid).max(1_000).default([]),
  summary: z.record(z.string(), z.unknown()).default({})
});
type ChangeSetMeta = z.output<typeof ChangeSetMetaSchema>;
/** A stored change-set's metadata; only undoChangeSet records the `undo` origin. */
type StoredChangeSetMeta = Omit<ChangeSetMeta, "origin"> & { origin: TopicChangeSetOrigin };

/** Title and provenance of a change-set (a localized key and its parameters). */
export interface TopicChangeSetMeta {
  /** The new change-set's ID, when its events already name it (`created_change_set_id`). */
  id?: string;
  origin: Exclude<TopicChangeSetOrigin, "undo">;
  titleKey: string;
  titleParams?: Record<string, unknown>;
  risk?: TopicChangeSetRisk;
  jobId?: string | null;
  aiTaskRunIds?: string[];
  summary?: Record<string, unknown>;
}

/** Runs the call inside the caller's open transaction (a savepoint keeps a conflict recoverable). */
export interface TopicWriterOptions {
  client?: Queryable;
}

export interface ApplyChangeSetInput extends TopicChangeSetMeta {
  treeId: string;
  /** The tree generation the engine computed the events from. */
  expectedGeneration: number;
  events: readonly StructureEvent[];
  /** `pending_review` records the proposal without applying it (D12, D29). */
  status?: "applied" | "pending_review";
  /** Exact statistics of topics the events touched (engine-computed, D7). */
  stats?: readonly TopicStatsWrite[];
  /** The engine clock after the change-set (repair cooldowns). */
  clock?: number;
  /** A structural configuration change that comes with a rebuild (D39). */
  treeConfig?: { config: Record<string, unknown>; configHash: string };
}

export type TopicConflict =
  | { kind: "conflict"; reason: "generation"; currentGeneration: number }
  | { kind: "conflict"; reason: "treeRetired"; currentGeneration: number }
  | { kind: "conflict"; reason: "notBootstrappable"; currentGeneration: number }
  | {
      kind: "conflict";
      reason: "event";
      currentGeneration: number;
      eventIndex: number;
      code: TopicEventConflictCode;
      message: string;
    };

export interface AppliedChangeSet {
  kind: "applied";
  changeSetId: string;
  /** The tree generation after the change-set. */
  generation: number;
  events: number;
  /** Live topics whose statistics still need an exact recompute (recomputeStats). */
  dirtyTopicIds: string[];
}

export type ApplyChangeSetResult =
  | AppliedChangeSet
  | { kind: "pending"; changeSetId: string; generation: number; events: number }
  | { kind: "no_change"; generation: number }
  | TopicConflict;

export interface BootstrapSnapshotInput extends Omit<TopicChangeSetMeta, "origin"> {
  treeId: string;
  expectedGeneration: number;
  origin?: "build" | "rebuild";
  /** Every topic below the root (live), any order. */
  topics: readonly TopicRecord[];
  /** Every placement the tree should hold. */
  placements: readonly { item: ItemKey; placement: PlacementRecord }[];
  stats?: readonly TopicStatsWrite[];
  clock?: number;
  /** The configuration the build used, when it differs from the tree's (D39). */
  treeConfig?: { config: Record<string, unknown>; configHash: string };
}

/** The latest build or rebuild of a tree (any status): the baseline of its rebuild triggers. */
export interface TopicStructureBuild {
  changeSetId: string;
  origin: "build" | "rebuild";
  status: TopicChangeSetStatus;
  summary: Record<string, unknown>;
  createdAt: Date;
}

/** A proposal that waits for the owner or that the owner dismissed (D29). */
export interface TopicProposal {
  changeSetId: string;
  origin: TopicChangeSetOrigin;
  status: "pending_review" | "dismissed";
  summary: Record<string, unknown>;
  createdAt: Date;
}

/** The topic tables whose planner statistics a bulk build or rebuild leaves stale. */
export const topicAnalyzedTables = [
  "topic_trees",
  "topics",
  "topic_stats",
  "topic_placements",
  "topic_change_sets",
  "topic_structure_events"
] as const;

export interface UndoChangeSetInput {
  treeId: string;
  /** The change-set to undo. */
  changeSetId: string;
  /** The ID of the `undo` change-set that records the inverse. */
  id?: string;
  /** When given, the undo refuses to run on another generation. */
  expectedGeneration?: number;
  titleKey: string;
  titleParams?: Record<string, unknown>;
  risk?: TopicChangeSetRisk;
  jobId?: string | null;
  summary?: Record<string, unknown>;
  stats?: readonly TopicStatsWrite[];
  clock?: number;
}

export type UndoChangeSetResult =
  AppliedChangeSet | { kind: "blocked"; blockers: UndoBlocker[] } | TopicConflict;

export interface ResolvePendingInput {
  treeId: string;
  changeSetId: string;
  decision: "apply" | "dismiss";
  expectedGeneration: number;
  stats?: readonly TopicStatsWrite[];
  clock?: number;
}

export type ResolvePendingResult =
  | AppliedChangeSet
  | { kind: "dismissed"; changeSetId: string }
  | { kind: "not_pending"; status: TopicChangeSetStatus }
  | TopicConflict;

export interface UnplaceForSourcesInput extends TopicChangeSetMeta {
  treeId: string;
  sourceIds: readonly string[];
  /** Also unplace the notes created from these sources or rooted at them. */
  includeNotes?: boolean;
  expectedGeneration?: number;
}

export interface RecomputeStatsInput {
  treeId: string;
  items: TopicItemSource;
  /** Topics to recompute besides the dirty ones (with their paths to the root). */
  topicIds?: Iterable<string>;
  /** Recompute every live topic from scratch. */
  all?: boolean;
}

export type RecomputeStatsResult =
  | { kind: "recomputed"; topicIds: string[]; generation: number }
  | { kind: "clean"; generation: number }
  | { kind: "conflict"; reason: "busy" | "treeRetired" };

export interface DailyMetricsInput {
  treeId: string;
  /** Local day, YYYY-MM-DD. */
  day: string;
  increments?: Partial<
    Record<"opsApplied" | "itemsMoved" | "primaryPathChanges" | "gateCalls" | "namingCalls", number>
  >;
  gauges?: Partial<
    Record<
      "unsortedShare" | "meanDepth" | "fanoutInTarget" | "hardViolations" | "softViolations",
      number | null
    >
  >;
}

export interface TopicDailyMetrics {
  treeId: string;
  day: string;
  opsApplied: number;
  itemsMoved: number;
  primaryPathChanges: number;
  unsortedShare: number | null;
  meanDepth: number | null;
  fanoutInTarget: number | null;
  hardViolations: number | null;
  softViolations: number | null;
  gateCalls: number;
  namingCalls: number;
}

const GateCandidateSchema = z
  .object({
    topicId: uuid,
    descriptorHash: z.string().min(1).max(200),
    cosine: z.number().finite(),
    labelCosine: z.number().finite().nullable(),
    logOdds: z.number().finite().nullable(),
    /** The ranker cut this candidate's sequence to fit (recorded, never silent; T23). */
    truncated: z.boolean().optional()
  })
  .strict();

const GateDecisionInputSchema = z
  .object({
    treeId: uuid,
    item: z.string().min(1),
    itemHash: z.string().min(1).max(200),
    descriptorSetHash: z.string().min(1).max(200),
    deciderKey: z.string().min(1).max(300),
    candidates: z.array(GateCandidateSchema).max(16),
    chosenTopicId: uuid.nullable(),
    aiTaskRunId: uuid.nullable().default(null)
  })
  .strict();
export type GateDecisionInput = z.input<typeof GateDecisionInputSchema>;

export interface TopicGateDecision {
  id: string;
  treeId: string;
  item: ItemKey;
  itemHash: string;
  descriptorSetHash: string;
  deciderKey: string;
  candidates: z.output<typeof GateCandidateSchema>[];
  chosenTopicId: string | null;
  noneOfThese: boolean;
  aiTaskRunId: string | null;
  createdAt: Date;
}

export interface CalibrationInput {
  spaceKey: string;
  deciderKey: string | null;
  params: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  dataset: string;
  /** Make it the active calibration of its space and decider (the previous one is deactivated). */
  activate: boolean;
}

export interface TopicCalibration {
  id: string;
  spaceKey: string;
  deciderKey: string | null;
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  dataset: string;
  active: boolean;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Transactions

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

const treeLockKey = (treeId: string): string => `topic-tree:${treeId}`;
const lifecycleLockKey = "topic-tree:lifecycle";

async function advisoryLock(db: Queryable, key: string): Promise<void> {
  await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

async function enterWriter(db: Queryable): Promise<void> {
  await db.query("select set_config($1, 'engine', true), set_config('lock_timeout', $2, true)", [
    topicTreeWriterSetting,
    `${topicTreeRepositoryLimits.lockTimeoutMs}ms`
  ]);
}

/**
 * Runs `work` as the engine writer: in its own transaction, or inside the caller's transaction
 * behind a savepoint (the caller's settings are restored afterwards). Advisory locks are taken
 * first and held until the transaction ends; `work` throwing rolls everything back.
 */
async function runWriter<T>(
  pool: PgPool,
  options: TopicWriterOptions,
  lockKeys: readonly string[],
  work: (db: Queryable) => Promise<T>
): Promise<T> {
  const caller = options.client;
  if (caller) {
    await caller.query("savepoint topic_tree_writer");
    try {
      const previous = await caller.query<{ writer: string | null; timeout: string }>(
        "select current_setting($1, true) as writer, current_setting('lock_timeout') as timeout",
        [topicTreeWriterSetting]
      );
      for (const key of lockKeys) await advisoryLock(caller, key);
      await enterWriter(caller);
      const result = await work(caller);
      await caller.query("select set_config($1, $2, true), set_config('lock_timeout', $3, true)", [
        topicTreeWriterSetting,
        previous.rows[0]?.writer ?? "",
        previous.rows[0]?.timeout ?? "0"
      ]);
      await caller.query("release savepoint topic_tree_writer");
      return result;
    } catch (error) {
      await caller.query("rollback to savepoint topic_tree_writer").catch(() => undefined);
      await caller.query("release savepoint topic_tree_writer").catch(() => undefined);
      throw error;
    }
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const key of lockKeys) await advisoryLock(client, key);
    await enterWriter(client);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function isBusy(error: unknown): boolean {
  return (error as PgErrorLike).code === "55P03";
}

/** Maps a database error raised by one event's statement to a conflict, or null to rethrow. */
function eventConflictOf(
  error: unknown,
  index: number,
  item: ItemKey | null,
  topicId: string | null
): TopicEventConflict | null {
  const pg = error as PgErrorLike;
  const message = pg.message ?? "";
  if (pg.code === "55P03") return new TopicEventConflict(index, "busy", message, item, topicId);
  if (pg.code === "23505") {
    const code = pg.constraint === "topics_sibling_title_uidx" ? "duplicateTitle" : "state";
    return new TopicEventConflict(index, code, message, item, topicId);
  }
  if (pg.code === "23503") {
    const deleted =
      pg.constraint === "topic_placements_note_id_atomic_notes_id_fk" ||
      pg.constraint === "topic_placements_source_item_id_source_items_id_fk";
    return new TopicEventConflict(index, deleted ? "itemDeleted" : "state", message, item, topicId);
  }
  if (pg.code === "23514") return new TopicEventConflict(index, "state", message, item, topicId);
  if (message.includes("topics.errors.cycle")) {
    return new TopicEventConflict(index, "cycle", message, item, topicId);
  }
  if (message.includes("topics.errors.parentTree")) {
    return new TopicEventConflict(index, "state", message, item, topicId);
  }
  return null;
}

async function guarded<T>(
  index: number,
  item: ItemKey | null,
  topicId: string | null,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw eventConflictOf(error, index, item, topicId) ?? error;
  }
}

function conflictResult(error: TopicEventConflict, generation: number): TopicConflict {
  return {
    kind: "conflict",
    reason: "event",
    currentGeneration: generation,
    eventIndex: error.index,
    code: error.code,
    message: error.reason
  };
}

// ---------------------------------------------------------------------------
// Reads used by the writer

async function readTree(db: Queryable, treeId: string): Promise<TopicTreeRecord | null> {
  const result = await db.query<TopicTreeRow>(
    `select ${topicTreeColumns} from topic_trees t where t.id = $1`,
    [treeId]
  );
  return result.rows[0] ? topicTreeFromRow(result.rows[0]) : null;
}

async function requireTree(db: Queryable, treeId: string): Promise<TopicTreeRecord> {
  const tree = await readTree(db, treeId);
  if (!tree) throw new TopicTreeRepositoryError("treeNotFound", `Topic tree ${treeId} not found`);
  return tree;
}

async function readRecords(db: Queryable, tree: TopicTreeRecord): Promise<TopicTreeRecords> {
  const topics = await db.query<TopicRow>(
    `select ${topicColumns} from topics where tree_id = $1 order by id`,
    [tree.id]
  );
  const placements = await db.query<PlacementRow>(
    `select ${placementColumns} from topic_placements where tree_id = $1`,
    [tree.id]
  );
  return {
    tree,
    topics: topics.rows.map(topicRecordFromRow),
    placements: placements.rows
      .map(placementEntryFromRow)
      .sort((a, b) => compareStrings(a.item, b.item) || a.placement.rank - b.placement.rank)
  };
}

interface StoredStatsRow {
  topicId: string;
  n: number;
  ls: Buffer | null;
  cosSqSum: number;
  lowCosPercentiles: number[] | null;
  repairClock: string | number | null;
  dirty: boolean;
}

async function readStats(
  db: Queryable,
  tree: TopicTreeRecord
): Promise<(StoredTopicStats & { dirty: boolean })[]> {
  const result = await db.query<StoredStatsRow>(
    `select s.topic_id as "topicId", s.n, s.ls, s.cos_sq_sum as "cosSqSum",
            s.low_cos_percentiles as "lowCosPercentiles", s.repair_clock as "repairClock", s.dirty
       from topic_stats s join topics t on t.id = s.topic_id
      where t.tree_id = $1 and t.retired_at is null
      order by s.topic_id`,
    [tree.id]
  );
  return result.rows.map((row) => ({
    topicId: row.topicId,
    n: Number(row.n),
    ls: decodeTopicVector(row.ls, tree.dimensions),
    cosSqSum: Number(row.cosSqSum),
    lowCosPercentiles: Float32Array.from(row.lowCosPercentiles ?? []),
    repairClock: row.repairClock === null ? null : Number(row.repairClock),
    dirty: row.dirty
  }));
}

interface ClosureRow {
  id: string;
  root: boolean;
  live: boolean;
}

/**
 * The topics whose statistics a change to `topicIds` can alter: every one of them and its
 * ancestors, plus, for notes whose primary placement changes, the primary path of their root
 * source (D8). The root comes first, so rows are always locked in the same order.
 */
async function topicClosure(
  db: Queryable,
  treeId: string,
  topicIds: readonly string[],
  noteIds: readonly string[]
): Promise<ClosureRow[]> {
  if (topicIds.length === 0 && noteIds.length === 0) return [];
  const result = await db.query<ClosureRow>(
    `with recursive up as (
       select n.id as note_id, s.id, s.parent_source_item_id as parent, 0 as depth
         from atomic_notes n join source_items s on s.id = n.created_from_source_item_id
        where n.id = any($3::uuid[])
       union all
       select up.note_id, s.id, s.parent_source_item_id, up.depth + 1
         from up join source_items s on s.id = up.parent where up.depth < 64
     ), seed as (
       select unnest($2::uuid[]) as id
       union
       select p.topic_id from topic_placements p join up on up.parent is null and p.source_item_id = up.id
        where p.tree_id = $1 and p.item_kind = 'source' and p.rank = 0
     ), path as (
       select t.id, t.parent_id, t.retired_at from topics t join seed on seed.id = t.id
        where t.tree_id = $1
       union
       select t.id, t.parent_id, t.retired_at from topics t join path on t.id = path.parent_id
     )
     select id, parent_id is null as root, retired_at is null as live from path
     order by parent_id is null desc, id`,
    [treeId, [...topicIds], [...noteIds]]
  );
  return result.rows;
}

/** Locks the statistics rows of `topicIds` in the given (root-first) order; returns the dirty ones. */
async function lockStats(db: Queryable, topicIds: readonly string[]): Promise<Set<string>> {
  if (topicIds.length === 0) return new Set();
  const result = await db.query<{ topicId: string; dirty: boolean }>(
    `select topic_id as "topicId", dirty from topic_stats where topic_id = any($1::uuid[])
      order by array_position($1::uuid[], topic_id) for update`,
    [[...topicIds]]
  );
  return new Set(result.rows.filter((row) => row.dirty).map((row) => row.topicId));
}

interface EventRow {
  changeSetId: string;
  seq: number;
  op: string;
  topicId: string | null;
  itemKind: TopicItemKind | null;
  itemId: string | null;
  before: unknown;
  after: unknown;
}

async function readEvents(
  db: Queryable,
  changeSetIds: readonly string[]
): Promise<Map<string, StructureEvent[]>> {
  const output = new Map<string, StructureEvent[]>(changeSetIds.map((id) => [id, []]));
  if (changeSetIds.length === 0) return output;
  const result = await db.query<EventRow>(
    `select change_set_id as "changeSetId", seq, op, topic_id as "topicId", item_kind as "itemKind",
            item_id as "itemId", before, after
       from topic_structure_events where change_set_id = any($1::uuid[])
      order by change_set_id, seq`,
    [[...changeSetIds]]
  );
  for (const row of result.rows) {
    const raw =
      row.itemKind !== null && row.itemId !== null
        ? {
            op: row.op,
            item: itemKey(row.itemKind, row.itemId),
            topicId: row.topicId,
            before: row.before,
            after: row.after
          }
        : { op: row.op, topicId: row.topicId, before: row.before, after: row.after };
    output.get(row.changeSetId)?.push(...parseStructureEvents([raw]));
  }
  return output;
}

// ---------------------------------------------------------------------------
// Event application (one statement per topic event; item events in batches)

const topicFieldColumns = {
  parentId: ["parent_id", "uuid"],
  role: ["role", "text"],
  title: ["title", "text"],
  nameState: ["name_state", "text"],
  nameSource: ["name_source", "text"],
  nameLanguage: ["name_language", "text"],
  namedChangeSetId: ["named_change_set_id", "uuid"],
  description: ["description", "text"],
  aliases: ["aliases", "jsonb"],
  management: ["management", "text"],
  position: ["position", "int"],
  retiredAt: ["retired_at", "timestamptz"],
  redirectTo: ["redirect_to", "uuid"],
  createdChangeSetId: ["created_change_set_id", "uuid"]
} as const satisfies Record<Exclude<keyof TopicRecord, "id">, readonly [string, string]>;
type TopicField = keyof typeof topicFieldColumns;

function topicFieldEntries(fields: object): [TopicField, unknown][] {
  return Object.entries(fields).filter(([field]) => field in topicFieldColumns) as [
    TopicField,
    unknown
  ][];
}

function topicParam(field: TopicField, value: unknown): unknown {
  return field === "aliases" ? JSON.stringify(value) : value;
}

/** `column is not distinct from $n` for each field; parameters appended to `params`. */
function topicMatch(fields: object, params: unknown[]): string {
  return topicFieldEntries(fields)
    .map(([field, value]) => {
      const [column, type] = topicFieldColumns[field];
      params.push(topicParam(field, value));
      return `${column} is not distinct from $${params.length}::${type}`;
    })
    .join(" and ");
}

function topicAssign(fields: object, params: unknown[]): string {
  return topicFieldEntries(fields)
    .map(([field, value]) => {
      const [column, type] = topicFieldColumns[field];
      params.push(topicParam(field, value));
      return `${column} = $${params.length}::${type}`;
    })
    .join(", ");
}

interface ApplyContext {
  treeId: string;
  changeSetId: string;
  spaceKey: string;
}

/** Structural checks the stored rows cannot express (the engine's event preconditions). */
function staticEventProblem(event: StructureEvent): string | null {
  switch (event.op) {
    case "topic.retire":
      if (event.before.retiredAt !== null || event.after.retiredAt === null) {
        return "retire must take a live topic out";
      }
      return event.after.redirectTo === event.topicId ? "a topic cannot redirect to itself" : null;
    case "topic.restore":
      if (event.before.retiredAt === null || event.after.retiredAt !== null) {
        return "restore must bring a topic back";
      }
      return event.after.redirectTo !== null ? "a live topic has no redirect" : null;
    case "item.place":
      return event.topicId === event.after.topicId ? null : "topicId differs from the placement";
    case "item.move":
      if (event.before.rank !== event.after.rank) return "a move keeps the rank";
      return event.topicId === event.after.topicId ? null : "topicId differs from the placement";
    default:
      return null;
  }
}

async function applyTopicEvent(
  db: Queryable,
  context: ApplyContext,
  event: Exclude<StructureEvent, { item: string }>,
  index: number
): Promise<void> {
  const params: unknown[] = [event.topicId, context.treeId];
  let sql: string;
  switch (event.op) {
    case "topic.create": {
      if (event.after !== null) {
        const fields = topicFieldEntries(event.after);
        const values = fields.map(([field, value]) => {
          params.push(topicParam(field, value));
          return `$${params.length}::${topicFieldColumns[field][1]}`;
        });
        params.push(context.spaceKey);
        const space = params.length;
        const position = (name: TopicField): number =>
          3 + fields.findIndex(([field]) => field === name);
        const parent = position("parentId");
        const retired = position("retiredAt");
        sql = `with created as (
                 insert into topics (id, tree_id, ${fields.map(([field]) => topicFieldColumns[field][0]).join(", ")})
                 select $1, $2, ${values.join(", ")}
                  where $${retired}::timestamptz is not null or exists (
                    select 1 from topics p where p.id = $${parent}::uuid and p.tree_id = $2 and p.retired_at is null)
                 returning id)
               insert into topic_stats (topic_id, space_key) select id, $${space} from created
               returning topic_id`;
      } else if (event.before !== null) {
        sql = `delete from topics where id = $1 and tree_id = $2 and ${topicMatch(event.before, params)}
               returning id`;
      } else {
        throw new TopicEventConflict(index, "state", "topic.create needs a before or an after");
      }
      break;
    }
    case "topic.retire": {
      const assign = topicAssign(event.after, params);
      const match = topicMatch(event.before, params);
      sql = `update topics t set ${assign}, updated_at = now()
              where t.id = $1 and t.tree_id = $2 and t.role <> 'root' and ${match}
                and not exists (select 1 from topics c where c.parent_id = t.id and c.retired_at is null)
                and not exists (select 1 from topic_placements p where p.topic_id = t.id)
              returning t.id`;
      break;
    }
    case "topic.restore": {
      const assign = topicAssign(event.after, params);
      const match = topicMatch(event.before, params);
      sql = `update topics t set ${assign}, updated_at = now()
              where t.id = $1 and t.tree_id = $2 and ${match}
                and exists (select 1 from topics p where p.id = t.parent_id and p.retired_at is null)
              returning t.id`;
      break;
    }
    case "topic.move": {
      const assign = topicAssign(event.after, params);
      const match = topicMatch(event.before, params);
      params.push(event.after.parentId);
      sql = `update topics t set ${assign}, updated_at = now()
              where t.id = $1 and t.tree_id = $2 and t.retired_at is null and ${match}
                and exists (select 1 from topics p where p.id = $${params.length}::uuid
                              and p.tree_id = $2 and p.retired_at is null)
              returning t.id`;
      break;
    }
    case "topic.rename":
    case "topic.describe":
    case "topic.manage": {
      const assign = topicAssign(event.after, params);
      const match = topicMatch(event.before, params);
      sql = `update topics t set ${assign}, updated_at = now()
              where t.id = $1 and t.tree_id = $2 and ${match} returning t.id`;
      break;
    }
    default:
      throw new TopicEventConflict(index, "state", "unknown topic event");
  }
  const result = await guarded(index, null, event.topicId, () => db.query(sql, params));
  if (result.rowCount !== 1) {
    throw new TopicEventConflict(
      index,
      "state",
      `${event.op} on ${event.topicId} does not match the stored topic`,
      null,
      event.topicId
    );
  }
}

const placementFields = [
  ["topic_id", "uuid"],
  ["management", "text"],
  ["decided_by", "text"],
  ["item_fingerprint", "text"],
  ["score", "float8"],
  ["margin", "float8"],
  ["needs_gate", "bool"],
  ["needs_split_check", "bool"],
  ["needs_vector", "bool"],
  ["moved_from_topic_id", "uuid"],
  ["moved_at", "timestamptz"]
] as const;

function placementValues(record: PlacementRecord): unknown[] {
  return [
    record.topicId,
    record.management,
    record.decidedBy,
    record.itemFingerprint,
    record.score,
    record.margin,
    record.needsGate,
    record.needsSplitCheck,
    record.needsVector,
    record.movedFromTopicId,
    record.movedAt
  ];
}

interface ItemRow {
  item: ItemKey;
  kind: TopicItemKind;
  id: string;
}

/** Column arrays for `unnest`: kind, id, rank, then the placement fields of each record set. */
function placementArrays(
  rows: readonly ItemRow[],
  ranks: readonly number[],
  ...recordSets: readonly (readonly PlacementRecord[])[]
): unknown[][] {
  const arrays: unknown[][] = [rows.map((row) => row.kind), rows.map((row) => row.id), [...ranks]];
  for (const records of recordSets) {
    const values = records.map(placementValues);
    placementFields.forEach((_, field) => arrays.push(values.map((value) => value[field])));
  }
  return arrays;
}

/** `unnest($a::text[], ...) as i(kind, item_id, rank, <prefix>topic_id, ...)` from `$first`. */
function placementUnnest(first: number, prefixes: readonly string[]): string {
  const types = ["text", "uuid", "int"];
  const names = ["kind", "item_id", "rank"];
  for (const prefix of prefixes) {
    for (const [column, type] of placementFields) {
      types.push(type);
      names.push(`${prefix}${column}`);
    }
  }
  const args = types.map((type, index) => `$${first + index}::${type}[]`).join(", ");
  return `unnest(${args}) as i(${names.join(", ")})`;
}

function placementMatch(prefix: string): string {
  return placementFields
    .map(([column]) => `p.${column} is not distinct from i.${prefix}${column}`)
    .join(" and ");
}

const itemMatch = `p.tree_id = $1 and p.item_kind = i.kind
  and coalesce(p.note_id, p.source_item_id) = i.item_id and p.rank = i.rank`;

/** Root source of each placed note (the canonical source hierarchy root of its origin). */
const noteRootsSql = `up as (
  select i.item_id as note_id, s.id, s.parent_source_item_id as parent, 0 as depth
    from input i join atomic_notes n on n.id = i.item_id
    join source_items s on s.id = n.created_from_source_item_id
   where i.kind = 'note'
  union all
  select up.note_id, s.id, s.parent_source_item_id, up.depth + 1
    from up join source_items s on s.id = up.parent where up.depth < 64
), roots as (select note_id, id from up where parent is null)`;

type ItemEvent = Extract<StructureEvent, { item: string }>;

function itemRowOf(event: ItemEvent): ItemRow {
  const parsed = eventItem(event);
  if (!parsed) throw new TypeError("Not an item event");
  return { item: event.item, ...parsed };
}

async function applyItemBatch(
  db: Queryable,
  context: ApplyContext,
  op: ItemEvent["op"],
  events: readonly ItemEvent[],
  firstIndex: number
): Promise<void> {
  const rows = events.map(itemRowOf);
  let sql: string;
  let arrays: unknown[][];
  if (op === "item.place") {
    const after = events.map((event) => event.after as PlacementRecord);
    arrays = placementArrays(
      rows,
      after.map((record) => record.rank),
      after
    );
    sql = `with recursive input as (select * from ${placementUnnest(3, ["a_"])}), ${noteRootsSql}
           insert into topic_placements (tree_id, item_kind, note_id, source_item_id, root_source_item_id,
             topic_id, role, rank, management, decided_by, item_fingerprint, score, margin, needs_gate,
             needs_split_check, needs_vector, moved_from_topic_id, moved_at, change_set_id)
           select $1, i.kind, case when i.kind = 'note' then i.item_id end,
                  case when i.kind = 'source' then i.item_id end, r.id, i.a_topic_id,
                  case when i.rank = 0 then 'primary' else 'secondary' end, i.rank, i.a_management,
                  i.a_decided_by, i.a_item_fingerprint, i.a_score, i.a_margin, i.a_needs_gate,
                  i.a_needs_split_check, i.a_needs_vector, i.a_moved_from_topic_id, i.a_moved_at, $2
             from input i left join roots r on r.note_id = i.item_id and i.kind = 'note'
            where exists (select 1 from topics t where t.id = i.a_topic_id and t.tree_id = $1
                            and t.retired_at is null)
           returning 1`;
  } else if (op === "item.unplace") {
    const before = events.map((event) => event.before as PlacementRecord);
    arrays = placementArrays(
      rows,
      before.map((record) => record.rank),
      before
    );
    // $2 (the change-set) is unused by a delete; the cast only types the parameter.
    sql = `with input as (select * from ${placementUnnest(3, ["b_"])})
           delete from topic_placements p using input i
            where ${itemMatch} and ${placementMatch("b_")} and $2::uuid is not null
           returning 1`;
  } else {
    const before = events.map((event) => event.before as PlacementRecord);
    const after = events.map((event) => event.after as PlacementRecord);
    arrays = placementArrays(
      rows,
      before.map((record) => record.rank),
      before,
      after
    );
    const assign = placementFields.map(([column]) => `${column} = i.a_${column}`).join(", ");
    sql = `with input as (select * from ${placementUnnest(3, ["b_", "a_"])})
           update topic_placements p set ${assign}, change_set_id = $2
             from input i
            where ${itemMatch} and ${placementMatch("b_")}
              and (i.a_topic_id = i.b_topic_id or exists (
                select 1 from topics t where t.id = i.a_topic_id and t.tree_id = $1
                   and t.retired_at is null))
           returning 1`;
  }
  const first = rows[0]?.item ?? null;
  const result = await guarded(firstIndex, first, null, () =>
    db.query(sql, [context.treeId, context.changeSetId, ...arrays])
  );
  if (result.rowCount !== events.length) {
    throw new TopicEventConflict(
      firstIndex,
      "state",
      `${op}: ${events.length - (result.rowCount ?? 0)} of ${events.length} placements do not match the stored rows`,
      first
    );
  }
}

/**
 * Applies events in order: topic events one by one, consecutive item events of one kind on
 * distinct items in one statement. Any mismatch throws a TopicEventConflict (the caller's
 * transaction then rolls back the whole change-set).
 */
async function applyEventsSql(
  db: Queryable,
  context: ApplyContext,
  events: readonly StructureEvent[]
): Promise<void> {
  for (let index = 0; index < events.length;) {
    const event = events[index] as StructureEvent;
    const problem = staticEventProblem(event);
    if (problem) throw new TopicEventConflict(index, "state", problem, null, event.topicId);
    if (!("item" in event)) {
      await applyTopicEvent(db, context, event, index);
      index += 1;
      continue;
    }
    const batch: ItemEvent[] = [event];
    const seen = new Set([event.item]);
    for (let next = index + 1; next < events.length; next += 1) {
      const candidate = events[next] as StructureEvent;
      if (batch.length >= topicTreeRepositoryLimits.itemBatchSize) break;
      if (candidate.op !== event.op || !("item" in candidate) || seen.has(candidate.item)) break;
      const candidateProblem = staticEventProblem(candidate);
      if (candidateProblem) break;
      batch.push(candidate);
      seen.add(candidate.item);
    }
    await applyItemBatch(db, context, event.op, batch, index);
    index += batch.length;
  }
}

async function insertEventRows(
  db: Queryable,
  changeSetId: string,
  events: readonly StructureEvent[]
): Promise<void> {
  const size = topicTreeRepositoryLimits.eventInsertBatchSize;
  for (let start = 0; start < events.length; start += size) {
    const slice = events.slice(start, start + size);
    const items = slice.map(eventItem);
    await db.query(
      `insert into topic_structure_events
         (change_set_id, seq, op, topic_id, item_kind, item_id, before, after, ref_topic_ids)
       select $1, i.seq, i.op, i.topic_id, i.item_kind, i.item_id, i.before::jsonb, i.after::jsonb,
              string_to_array(i.refs, ',')::uuid[]
         from unnest($2::int[], $3::text[], $4::uuid[], $5::text[], $6::uuid[], $7::text[],
                     $8::text[], $9::text[])
           as i(seq, op, topic_id, item_kind, item_id, before, after, refs)`,
      [
        changeSetId,
        slice.map((_, offset) => start + offset),
        slice.map((event) => event.op),
        slice.map((event) => event.topicId),
        items.map((item) => item?.kind ?? null),
        items.map((item) => item?.id ?? null),
        slice.map((event) => (event.before === null ? null : JSON.stringify(event.before))),
        slice.map((event) => (event.after === null ? null : JSON.stringify(event.after))),
        slice.map((event) => eventTopicRefs(event).join(","))
      ]
    );
  }
}

// ---------------------------------------------------------------------------
// Statistics writes

function validateStats(tree: TopicTreeRecord, stats: readonly TopicStatsWrite[]): void {
  const seen = new Set<string>();
  for (const write of stats) {
    const problem = !uuid.safeParse(write.topicId).success
      ? "an invalid topic ID"
      : seen.has(write.topicId)
        ? "a duplicate topic"
        : !Number.isInteger(write.n) || write.n < 0
          ? "an invalid N"
          : write.ls.length !== tree.dimensions
            ? `LS with ${write.ls.length} values, expected ${tree.dimensions}`
            : !write.ls.every(Number.isFinite) || !Number.isFinite(write.cosSqSum)
              ? "a non-finite value"
              : write.lowCosPercentiles.length !== 0 && write.lowCosPercentiles.length !== 11
                ? "low-cosine percentiles that are neither 0 nor 11 values"
                : write.health !== undefined && !topicHealthValues.includes(write.health)
                  ? "an unknown health"
                  : null;
    if (problem) {
      throw new TopicTreeRepositoryError(
        "invalidInput",
        `Statistics for ${write.topicId} have ${problem}`
      );
    }
    seen.add(write.topicId);
  }
}

function realArrayLiteral(values: ArrayLike<number>): string {
  return `{${Array.from(values, (value) => String(value)).join(",")}}`;
}

/** Writes exact statistics; a topic stays dirty when `stillDirty` names it. */
async function writeStats(
  db: Queryable,
  tree: TopicTreeRecord,
  stats: readonly TopicStatsWrite[],
  stillDirty: ReadonlySet<string>
): Promise<void> {
  if (stats.length === 0) return;
  const result = await db.query<{ count: number }>(
    `with input as (
       select * from unnest($2::uuid[], $3::int[], $4::bytea[], $5::float8[], $6::text[], $7::real[],
                            $8::bool[], $9::bool[], $10::int8[], $11::text[], $12::text[])
         as i(topic_id, n, ls, cos_sq_sum, low, coherence, dirty, set_clock, clock, health, violations)
     ), updated as (
       update topic_stats s set n = i.n, ls = i.ls, cos_sq_sum = i.cos_sq_sum,
              low_cos_percentiles = i.low::real[], coherence = i.coherence, dirty = i.dirty,
              space_key = $13, computed_at = now(),
              repair_clock = case when i.set_clock then i.clock else s.repair_clock end,
              last_repair_at = case when i.set_clock and i.clock is distinct from s.repair_clock
                                    then now() else s.last_repair_at end,
              health = coalesce(i.health, s.health),
              violations = coalesce(i.violations::jsonb, s.violations)
         from input i join topics t on t.id = i.topic_id and t.tree_id = $1 and t.retired_at is null
        where s.topic_id = i.topic_id
       returning s.topic_id)
     select count(*)::int as count from updated`,
    [
      tree.id,
      stats.map((write) => write.topicId),
      stats.map((write) => write.n),
      stats.map((write) => encodeTopicVector(write.ls)),
      stats.map((write) => write.cosSqSum),
      stats.map((write) => realArrayLiteral(write.lowCosPercentiles)),
      stats.map(statsCoherence),
      stats.map((write) => stillDirty.has(write.topicId)),
      stats.map((write) => write.repairClock !== undefined),
      stats.map((write) => write.repairClock ?? null),
      stats.map((write) => write.health ?? null),
      stats.map((write) => (write.violations ? JSON.stringify(write.violations) : null)),
      tree.spaceKey
    ]
  );
  if (Number(result.rows[0]?.count) !== stats.length) {
    throw new TopicTreeRepositoryError(
      "invalidInput",
      "Statistics name a topic that is not a live topic of the tree"
    );
  }
  const centralities = stats.flatMap((write) =>
    (write.centralities ?? []).map((entry) => ({ topicId: write.topicId, ...entry }))
  );
  if (centralities.length === 0) return;
  const parsed = centralities.map((entry) => ({ ...entry, row: eventItemKey(entry.item) }));
  await db.query(
    `update topic_placements p set centrality = i.value
       from unnest($2::uuid[], $3::text[], $4::uuid[], $5::float8[]) as i(topic_id, kind, item_id, value)
      where p.tree_id = $1 and p.topic_id = i.topic_id and p.item_kind = i.kind
        and coalesce(p.note_id, p.source_item_id) = i.item_id`,
    [
      tree.id,
      parsed.map((entry) => entry.topicId),
      parsed.map((entry) => entry.row.kind),
      parsed.map((entry) => entry.row.id),
      parsed.map((entry) => entry.centrality)
    ]
  );
}

function eventItemKey(item: ItemKey): { kind: TopicItemKind; id: string } {
  const parsed = parseItemKey(item);
  if (!parsed) throw new TopicTreeRepositoryError("invalidInput", `Invalid item key ${item}`);
  return parsed;
}

async function markDirty(db: Queryable, topicIds: readonly string[]): Promise<void> {
  if (topicIds.length === 0) return;
  await db.query("update topic_stats set dirty = true where topic_id = any($1::uuid[])", [
    [...topicIds]
  ]);
}

/** Direct primary items and live children of each topic (read models of the navigator). */
async function recount(db: Queryable, treeId: string, topicIds: readonly string[]): Promise<void> {
  if (topicIds.length === 0) return;
  await db.query(
    `update topic_stats s set
       direct_items = (select count(*)::int from topic_placements p
                        where p.topic_id = s.topic_id and p.role = 'primary'),
       children = (select count(*)::int from topics c
                    where c.tree_id = $2 and c.parent_id = s.topic_id and c.retired_at is null)
     where s.topic_id = any($1::uuid[])`,
    [[...topicIds], treeId]
  );
}

// ---------------------------------------------------------------------------
// Change-sets

function parseMeta(meta: TopicChangeSetMeta): ChangeSetMeta {
  const parsed = ChangeSetMetaSchema.safeParse(meta);
  if (!parsed.success) {
    throw new TopicTreeRepositoryError(
      "invalidInput",
      `Invalid change-set: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

function parseEvents(events: readonly StructureEvent[]): StructureEvent[] {
  try {
    return minimalEvents(parseStructureEvents(events));
  } catch (error) {
    throw new TopicTreeRepositoryError(
      "invalidInput",
      `Invalid structure event: ${(error as Error).message}`
    );
  }
}

async function insertChangeSet(
  db: Queryable,
  treeId: string,
  meta: StoredChangeSetMeta,
  status: "applied" | "pending_review",
  generation: number | null,
  undoOf: string | null
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into topic_change_sets (id, tree_id, origin, status, title_key, title_params, risk,
       undo_of, job_id, ai_task_run_ids, summary, generation, applied_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11::jsonb, $12,
             case when $4 = 'applied' then now() end)
     returning id`,
    [
      meta.id ?? randomUUID(),
      treeId,
      meta.origin,
      status,
      meta.titleKey,
      JSON.stringify(meta.titleParams),
      meta.risk,
      undoOf,
      meta.jobId,
      JSON.stringify(meta.aiTaskRunIds),
      JSON.stringify(meta.summary),
      generation
    ]
  );
  return result.rows[0]!.id;
}

interface CommitInput {
  tree: TopicTreeRecord;
  /** A new change-set row, or the pending one being applied. */
  changeSet:
    { meta: Parameters<typeof insertChangeSet>[2]; undoOf: string | null } | { pendingId: string };
  events: readonly StructureEvent[];
  stats: readonly TopicStatsWrite[];
  clock?: number | undefined;
  treeConfig?: { config: Record<string, unknown>; configHash: string } | undefined;
}

/**
 * Applies a change-set inside the writer transaction: locks the statistics rows of every path it
 * touches (root first), records it, applies the events, writes the engine's statistics, marks the
 * rest of the paths whose members or children changed dirty and bumps the generation. Names,
 * descriptions and management leave statistics exact (D7): they never make a topic dirty.
 */
async function commitChangeSet(db: Queryable, input: CommitInput): Promise<AppliedChangeSet> {
  const { tree, events } = input;
  validateStats(tree, input.stats);
  const refs = [...new Set(events.flatMap(eventTopicRefs))].sort(compareStrings);
  const statsRefs = [...new Set(events.flatMap(eventStatsRefs))].sort(compareStrings);
  const notes = primaryNoteChanges(events);
  const before = await topicClosure(db, tree.id, refs, notes);
  const preDirty = await lockStats(
    db,
    before.map((row) => row.id)
  );
  const generation = tree.generation + 1;
  let changeSetId: string;
  if ("pendingId" in input.changeSet) {
    changeSetId = input.changeSet.pendingId;
    const pending = await db.query(
      `update topic_change_sets set status = 'applied', generation = $2, applied_at = now()
        where id = $1 and status = 'pending_review'`,
      [changeSetId, generation]
    );
    if (pending.rowCount !== 1) throw new TopicEventConflict(0, "state", "the proposal is gone");
  } else {
    changeSetId = await insertChangeSet(
      db,
      tree.id,
      input.changeSet.meta,
      "applied",
      generation,
      input.changeSet.undoOf
    );
    await insertEventRows(db, changeSetId, events);
  }
  await applyEventsSql(db, { treeId: tree.id, changeSetId, spaceKey: tree.spaceKey }, events);
  const after = await topicClosure(db, tree.id, statsRefs, notes);
  const live = after.filter((row) => row.live).map((row) => row.id);
  const supplied = new Set(input.stats.map((write) => write.topicId));
  await writeStats(db, tree, input.stats, preDirty);
  await markDirty(
    db,
    live.filter((id) => !supplied.has(id))
  );
  await recount(db, tree.id, [...new Set([...live, ...supplied])]);
  await db.query(
    `update topic_trees set generation = generation + 1, clock = coalesce($2::bigint, clock),
            config = coalesce($3::jsonb, config), config_hash = coalesce($4, config_hash)
      where id = $1`,
    [
      tree.id,
      input.clock ?? null,
      input.treeConfig ? JSON.stringify(input.treeConfig.config) : null,
      input.treeConfig?.configHash ?? null
    ]
  );
  const dirty = [...new Set([...live, ...supplied])].filter(
    (id) => !supplied.has(id) || preDirty.has(id)
  );
  return {
    kind: "applied",
    changeSetId,
    generation,
    events: events.length,
    dirtyTopicIds: dirty.sort(compareStrings)
  };
}

/** The tree conflict that stops a writer before any change, or null. */
function treeConflict(
  tree: TopicTreeRecord,
  expectedGeneration: number | undefined
): TopicConflict | null {
  if (tree.status !== "active") {
    return { kind: "conflict", reason: "treeRetired", currentGeneration: tree.generation };
  }
  if (expectedGeneration !== undefined && expectedGeneration !== tree.generation) {
    return { kind: "conflict", reason: "generation", currentGeneration: tree.generation };
  }
  return null;
}

/** Runs a change-set writer and turns event conflicts into a conflict result. */
async function withConflicts<T>(
  db: Queryable,
  treeId: string,
  run: () => Promise<T>
): Promise<T | TopicConflict> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TopicEventConflict || isBusy(error)) {
      const tree = await readTree(db, treeId);
      const generation = tree?.generation ?? 0;
      return error instanceof TopicEventConflict
        ? conflictResult(error, generation)
        : conflictResult(new TopicEventConflict(0, "busy", (error as Error).message), generation);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Undo checks (D7 exact undo; plan 4.1 "blocks and names them")

async function laterChangeSets(
  db: Queryable,
  treeId: string,
  generation: number,
  events: readonly StructureEvent[]
): Promise<UndoableChangeSet[]> {
  const refs = [...new Set(events.flatMap(eventTopicRefs))];
  const items = events.map(eventItem).filter((item) => item !== null);
  const result = await db.query<{
    id: string;
    status: TopicChangeSetStatus;
    undoOf: string | null;
  }>(
    `with hits as (
       select e.change_set_id from topic_structure_events e where e.ref_topic_ids && $3::uuid[]
       union
       select e.change_set_id from topic_structure_events e
         join unnest($4::text[], $5::uuid[]) as i(kind, id) on e.item_kind = i.kind and e.item_id = i.id
     )
     select cs.id, cs.status, cs.undo_of as "undoOf"
       from topic_change_sets cs join hits h on h.change_set_id = cs.id
      where cs.tree_id = $1 and cs.generation > $2 and cs.status in ('applied', 'undone')
      order by cs.generation`,
    [treeId, generation, refs, items.map((item) => item.kind), items.map((item) => item.id)]
  );
  const stored = await readEvents(
    db,
    result.rows.map((row) => row.id)
  );
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    undoOf: row.undoOf,
    events: stored.get(row.id) ?? []
  }));
}

async function deletedItems(
  db: Queryable,
  events: readonly StructureEvent[]
): Promise<UndoBlocker[]> {
  const unique = new Map<string, { kind: TopicItemKind; id: string }>();
  for (const event of events) {
    const item = eventItem(event);
    if (item) unique.set(`${item.kind}:${item.id}`, item);
  }
  const items = [...unique.values()];
  if (items.length === 0) return [];
  const result = await db.query<{ kind: TopicItemKind; id: string }>(
    `select i.kind, i.id from unnest($1::text[], $2::uuid[]) as i(kind, id)
      where (i.kind = 'note' and not exists (select 1 from atomic_notes n where n.id = i.id))
         or (i.kind = 'source' and not exists (select 1 from source_items s where s.id = i.id))`,
    [items.map((item) => item.kind), items.map((item) => item.id)]
  );
  return result.rows
    .map((row) => itemKey(row.kind, row.id))
    .sort(compareStrings)
    .map((item) => ({ kind: "itemDeleted", item }));
}

function conflictBlocker(
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

/**
 * Invariants the applied inverse may break that event preconditions do not check (the database
 * side of the engine's undo checks): the depth cap below moved, restored and re-created topics,
 * and I2 for the items involved.
 */
async function inverseConflicts(
  db: Queryable,
  tree: TopicTreeRecord,
  inverse: readonly StructureEvent[]
): Promise<UndoBlocker[]> {
  const config = TopicTreeConfigSchema.parse(tree.config);
  const placed = [
    ...new Set(
      inverse
        .filter(
          (event) =>
            event.op === "topic.move" ||
            event.op === "topic.restore" ||
            (event.op === "topic.create" && event.after !== null)
        )
        .map((event) => event.topicId)
    )
  ].sort(compareStrings);
  const blockers: UndoBlocker[] = [];
  if (placed.length > 0) {
    const deep = await db.query<{ topicId: string }>(
      `with recursive up as (
         select t.id as start, t.parent_id as node, 0 as hops from topics t
          where t.id = any($1::uuid[]) and t.retired_at is null
         union all
         select up.start, p.parent_id, up.hops + 1 from up join topics p on p.id = up.node
          where up.hops < 64
       ), down as (
         select t.id as start, t.id as node, 0 as height from topics t
          where t.id = any($1::uuid[]) and t.retired_at is null
         union all
         select down.start, c.id, down.height + 1 from down
           join topics c on c.tree_id = $2 and c.parent_id = down.node and c.retired_at is null
          where down.height < 64
       )
       select d.start as "topicId"
         from (select start, max(hops) as depth from up where node is null group by start) d
         join (select start, max(height) as height from down group by start) h on h.start = d.start
        where d.depth + h.height > $3
        order by d.start`,
      [placed, tree.id, config.depth.cap]
    );
    for (const row of deep.rows) {
      blockers.push(
        conflictBlocker("depthCap", "the subtree crosses the depth cap", { topicId: row.topicId })
      );
    }
  }
  const items = inverse.map(eventItem).filter((item) => item !== null);
  const invalid = await db.query<{ kind: TopicItemKind; id: string }>(
    `with recursive sub as (
       select t.id from topics t where t.id = any($2::uuid[]) and t.retired_at is null
       union
       select c.id from topics c join sub on c.parent_id = sub.id
        where c.tree_id = $1 and c.retired_at is null
     ), items as (
       select i.kind, i.id from unnest($3::text[], $4::uuid[]) as i(kind, id)
       union
       select p.item_kind, coalesce(p.note_id, p.source_item_id) from topic_placements p
         join sub on p.topic_id = sub.id where p.tree_id = $1 and p.rank = 0
     ), placed as (
       select p.item_kind as kind, coalesce(p.note_id, p.source_item_id) as id, p.rank, p.topic_id
         from topic_placements p
         join items i on p.item_kind = i.kind and coalesce(p.note_id, p.source_item_id) = i.id
        where p.tree_id = $1
     ), path as (
       select pl.kind, pl.id, pl.topic_id as node, 0 as hops from placed pl where pl.rank = 0
       union all
       select path.kind, path.id, t.parent_id, path.hops + 1 from path join topics t on t.id = path.node
        where t.parent_id is not null and path.hops < 64
     ), secondary as (
       select s.kind, s.id,
              (not exists (select 1 from placed pr where pr.kind = s.kind and pr.id = s.id and pr.rank = 0)
               or t.id is null or t.retired_at is not null or t.parent_id is null
               or exists (select 1 from path where path.kind = s.kind and path.id = s.id
                            and path.node = s.topic_id)) as invalid
         from placed s left join topics t on t.id = s.topic_id where s.rank > 0
     )
     select kind, id from secondary where invalid
     union
     select kind, id from secondary where not invalid group by kind, id having count(*) > $5`,
    [
      tree.id,
      placed,
      items.map((item) => item.kind),
      items.map((item) => item.id),
      maxSecondaries(config)
    ]
  );
  for (const item of invalid.rows.map((row) => itemKey(row.kind, row.id)).sort(compareStrings)) {
    blockers.push(
      conflictBlocker("secondaryOnPrimaryPath", "a secondary placement breaks I2", { item })
    );
  }
  return blockers;
}

function undoBlockerOf(error: TopicEventConflict, inverse: readonly StructureEvent[]): UndoBlocker {
  if (error.code === "itemDeleted") {
    const event = inverse[error.index];
    const item = error.item ?? (event && "item" in event ? event.item : null);
    if (item) return { kind: "itemDeleted", item };
  }
  const code: UndoConflictCode =
    error.code === "cycle" || error.code === "duplicateTitle" ? error.code : "state";
  return conflictBlocker(code, error.reason, { topicId: error.topicId, item: error.item });
}

// ---------------------------------------------------------------------------
// Bootstrap

function bootstrapProblem(
  rootId: string,
  topics: readonly TopicRecord[],
  placements: BootstrapSnapshotInput["placements"]
): string | null {
  const ids = new Set<string>();
  for (const topic of topics) {
    if (topic.id === rootId || ids.has(topic.id)) return `duplicate topic ${topic.id}`;
    if (topic.role !== "topic" || topic.parentId === null) return `${topic.id} is not a topic`;
    if (topic.retiredAt !== null || topic.redirectTo !== null) return `${topic.id} is retired`;
    ids.add(topic.id);
  }
  for (const topic of topics) {
    if (topic.parentId !== rootId && !ids.has(topic.parentId as string)) {
      return `${topic.id} has an unknown parent`;
    }
  }
  const ranks = new Set<string>();
  const homes = new Set<string>();
  for (const { item, placement } of placements) {
    if (placement.topicId !== rootId && !ids.has(placement.topicId)) {
      return `${item} is placed on an unknown topic`;
    }
    const rank = `${item}#${placement.rank}`;
    const home = `${item}@${placement.topicId}`;
    if (ranks.has(rank) || homes.has(home)) return `${item} is placed twice`;
    ranks.add(rank);
    homes.add(home);
  }
  return null;
}

/** Topics in an order where every parent precedes its children (null when there is a cycle). */
function parentsFirst(rootId: string, topics: readonly TopicRecord[]): TopicRecord[] | null {
  const children = new Map<string, TopicRecord[]>();
  for (const topic of topics) {
    const list = children.get(topic.parentId as string) ?? [];
    list.push(topic);
    children.set(topic.parentId as string, list);
  }
  const ordered: TopicRecord[] = [];
  const queue = [rootId];
  for (let index = 0; index < queue.length; index += 1) {
    const list = (children.get(queue[index] as string) ?? []).sort((a, b) =>
      compareStrings(a.id, b.id)
    );
    for (const child of list) {
      ordered.push(child);
      queue.push(child.id);
    }
  }
  return ordered.length === topics.length ? ordered : null;
}

function samePlacement(a: PlacementRecord, b: PlacementRecord): boolean {
  return (
    JSON.stringify(placementValues(a)) === JSON.stringify(placementValues(b)) && a.rank === b.rank
  );
}

// ---------------------------------------------------------------------------
// Repository

export function createTopicTreeRepository(pool: PgPool) {
  async function insertTree(db: Queryable, input: CreateTopicTreeInput): Promise<TopicTreeRecord> {
    const parsed = CreateTopicTreeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new TopicTreeRepositoryError(
        "invalidInput",
        `Invalid topic tree: ${parsed.error.message}`
      );
    }
    const tree = parsed.data;
    const treeId = tree.id ?? randomUUID();
    const rootId = tree.rootId ?? randomUUID();
    try {
      await db.query(
        `insert into topic_trees (id, status, space_key, embedding_provider, embedding_model,
           embedding_runtime, dimensions, config, config_hash, seed, activated_at)
         values ($1, 'active', $2, $3, $4, $5, $6, $7::jsonb, $8, $9, now())`,
        [
          treeId,
          tree.spaceKey,
          tree.embeddingProvider,
          tree.embeddingModel,
          tree.embeddingRuntime,
          tree.dimensions,
          JSON.stringify(tree.config),
          tree.configHash,
          tree.seed
        ]
      );
    } catch (error) {
      if ((error as PgErrorLike).constraint === "topic_trees_active_uidx") {
        throw new TopicTreeRepositoryError("activeTreeExists", "A topic tree is already active");
      }
      throw error;
    }
    await db.query(
      `insert into topics (id, tree_id, parent_id, role, name_state, management)
       values ($1, $2, null, 'root', 'unnamed', 'ai')`,
      [rootId, treeId]
    );
    await db.query(
      `insert into topic_stats (topic_id, space_key, ls, dirty, computed_at)
       values ($1, $2, $3, false, now())`,
      [rootId, tree.spaceKey, encodeTopicVector(new Float64Array(tree.dimensions))]
    );
    return requireTree(db, treeId);
  }

  return {
    /** Creates the active tree with its root; refused while another tree is active. */
    async createTree(input: CreateTopicTreeInput, options: TopicWriterOptions = {}) {
      return runWriter(pool, options, [lifecycleLockKey], (db) => insertTree(db, input));
    },

    /** The active tree, or null (D39: the service creates one when there is none). */
    async activeTree(db: Queryable = pool): Promise<TopicTreeRecord | null> {
      const result = await db.query<TopicTreeRow>(
        `select ${topicTreeColumns} from topic_trees t where t.status = 'active'`
      );
      return result.rows[0] ? topicTreeFromRow(result.rows[0]) : null;
    },

    async tree(treeId: string, db: Queryable = pool): Promise<TopicTreeRecord | null> {
      return readTree(db, treeId);
    },

    /**
     * Retires the active tree and creates its replacement in the caller's transaction (R20, D26):
     * the caller fills the new tree (bootstrapSnapshot with the same client) before committing,
     * so another session never sees two active trees or none.
     */
    async replaceActiveTree(client: Queryable, input: CreateTopicTreeInput) {
      return runWriter(pool, { client }, [lifecycleLockKey], async (db) => {
        const current = await db.query<{ id: string }>(
          "select id from topic_trees where status = 'active'"
        );
        // Engine writers on the old tree finish first; afterwards they see it retired.
        for (const row of current.rows) await advisoryLock(db, treeLockKey(row.id));
        await db.query(
          "update topic_trees set status = 'retired', retired_at = now() where status = 'active'"
        );
        return insertTree(db, input);
      });
    },

    /** The persistent records of a tree (every topic and placement), for dumps and recomputes. */
    async readTreeRecords(treeId: string, db: Queryable = pool): Promise<TopicTreeRecords> {
      return readRecords(db, await requireTree(db, treeId));
    },

    /** Stored statistics of the tree's live topics. */
    async readTreeStats(treeId: string, db: Queryable = pool) {
      return readStats(db, await requireTree(db, treeId));
    },

    /** The structure events of a change-set, in order. */
    async changeSetEvents(changeSetId: string, db: Queryable = pool): Promise<StructureEvent[]> {
      return (await readEvents(db, [changeSetId])).get(changeSetId) ?? [];
    },

    /** The latest build or rebuild change-set of a tree, whatever its status; null before any. */
    async latestStructureBuild(
      treeId: string,
      db: Queryable = pool
    ): Promise<TopicStructureBuild | null> {
      const result = await db.query<{
        id: string;
        origin: "build" | "rebuild";
        status: TopicChangeSetStatus;
        summary: Record<string, unknown> | null;
        createdAt: Date | string;
      }>(
        `select id, origin, status, summary, created_at as "createdAt" from topic_change_sets
          where tree_id = $1 and origin in ('build', 'rebuild')
          order by created_at desc, id desc limit 1`,
        [treeId]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        changeSetId: row.id,
        origin: row.origin,
        status: row.status,
        summary: row.summary ?? {},
        createdAt: new Date(row.createdAt)
      };
    },

    /**
     * The proposals of a tree that wait for review or were dismissed (D29), oldest first, so the
     * engine neither repeats a waiting proposal nor brings back a dismissed one.
     */
    async reviewedProposals(treeId: string, db: Queryable = pool): Promise<TopicProposal[]> {
      const result = await db.query<{
        id: string;
        origin: TopicChangeSetOrigin;
        status: "pending_review" | "dismissed";
        summary: Record<string, unknown> | null;
        createdAt: Date | string;
      }>(
        `select id, origin, status, summary, created_at as "createdAt" from topic_change_sets
          where tree_id = $1 and status in ('pending_review', 'dismissed') order by created_at, id`,
        [treeId]
      );
      return result.rows.map((row) => ({
        changeSetId: row.id,
        origin: row.origin,
        status: row.status,
        summary: row.summary ?? {},
        createdAt: new Date(row.createdAt)
      }));
    },

    /**
     * Refreshes the planner statistics of the topic tables (ANALYZE takes no lock that blocks
     * readers or writers). A bulk build or rebuild changes most of their rows at once, and until
     * autovacuum catches up the pending-item reads plan as if the tables were empty.
     */
    async analyzeTopicTables(): Promise<void> {
      await pool.query(`analyze ${topicAnalyzedTables.join(", ")}`);
    },

    /**
     * Applies one change-set (or records it for review). Events that change nothing are dropped;
     * an empty change-set writes nothing (`no_change`). A stale generation, a retired tree or an
     * event whose `before` does not match the stored row is a conflict: nothing is written and
     * the engine reloads and recomputes.
     */
    async applyChangeSet(
      input: ApplyChangeSetInput,
      options: TopicWriterOptions = {}
    ): Promise<ApplyChangeSetResult> {
      const meta = parseMeta(input);
      const events = parseEvents(input.events);
      if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
        throw new TopicTreeRepositoryError("invalidInput", "Invalid expected generation");
      }
      const db = options.client ?? pool;
      return withConflicts(db, input.treeId, () =>
        runWriter(pool, options, [treeLockKey(input.treeId)], async (writer) => {
          const tree = await requireTree(writer, input.treeId);
          const pending = input.status === "pending_review";
          const conflict = treeConflict(tree, pending ? undefined : input.expectedGeneration);
          if (conflict) return conflict;
          // A structural configuration change is recorded even when its rebuild moves nothing.
          if (events.length === 0 && (pending || !input.treeConfig))
            return { kind: "no_change", generation: tree.generation } as const;
          if (pending) {
            const changeSetId = await insertChangeSet(
              writer,
              tree.id,
              meta,
              "pending_review",
              null,
              null
            );
            await insertEventRows(writer, changeSetId, events);
            return {
              kind: "pending",
              changeSetId,
              generation: tree.generation,
              events: events.length
            } as const;
          }
          return commitChangeSet(writer, {
            tree,
            changeSet: { meta, undoOf: null },
            events,
            stats: input.stats ?? [],
            clock: input.clock,
            treeConfig: input.treeConfig
          });
        })
      );
    },

    /**
     * Writes a built tree into a tree that holds only its root (the cold start and seeders): one
     * change-set of topic creations and placement events, applied in bulk.
     */
    async bootstrapSnapshot(
      input: BootstrapSnapshotInput,
      options: TopicWriterOptions = {}
    ): Promise<ApplyChangeSetResult> {
      const meta = parseMeta({ ...input, origin: input.origin ?? "build" });
      const db = options.client ?? pool;
      return withConflicts(db, input.treeId, () =>
        runWriter(pool, options, [treeLockKey(input.treeId)], async (writer) => {
          const tree = await requireTree(writer, input.treeId);
          const conflict = treeConflict(tree, input.expectedGeneration);
          if (conflict) return conflict;
          const other = await writer.query(
            "select 1 from topics where tree_id = $1 and role <> 'root' limit 1",
            [tree.id]
          );
          if (other.rowCount) {
            return {
              kind: "conflict",
              reason: "notBootstrappable",
              currentGeneration: tree.generation
            } as const;
          }
          const problem = bootstrapProblem(tree.rootId, input.topics, input.placements);
          const ordered = problem ? null : parentsFirst(tree.rootId, input.topics);
          if (problem || !ordered) {
            throw new TopicTreeRepositoryError(
              "invalidInput",
              `Invalid snapshot: ${problem ?? "a cycle"}`
            );
          }
          const existing = (await readRecords(writer, tree)).placements;
          const wanted = new Map(
            input.placements.map((entry) => [`${entry.item}#${entry.placement.rank}`, entry])
          );
          const unplace: StructureEvent[] = [];
          const move: StructureEvent[] = [];
          for (const { item, placement } of existing) {
            const target = wanted.get(`${item}#${placement.rank}`);
            if (!target) {
              unplace.push({
                op: "item.unplace",
                item,
                topicId: placement.topicId,
                before: placement,
                after: null
              });
            } else if (!samePlacement(placement, target.placement)) {
              move.push({
                op: "item.move",
                item,
                topicId: target.placement.topicId,
                before: placement,
                after: target.placement
              });
            }
            wanted.delete(`${item}#${placement.rank}`);
          }
          const remaining = [...wanted.values()].sort(
            (a, b) => a.placement.rank - b.placement.rank || compareStrings(a.item, b.item)
          );
          const place: StructureEvent[] = remaining.map(({ item, placement }) => ({
            op: "item.place",
            item,
            topicId: placement.topicId,
            before: null,
            after: placement
          }));
          const creates: StructureEvent[] = ordered.map((topic) => {
            const { id, ...after } = topic;
            return {
              op: "topic.create",
              topicId: id,
              before: null,
              after: { ...after, parentId: topic.parentId as string, role: "topic" }
            };
          });
          const events = parseEvents([...creates, ...unplace, ...move, ...place]);
          return commitChangeSet(writer, {
            tree,
            changeSet: { meta, undoOf: null },
            events,
            stats: input.stats ?? [],
            clock: input.clock,
            treeConfig: input.treeConfig
          });
        })
      );
    },

    /**
     * Undoes an applied change-set exactly: blocked, naming the blockers, when a later change-set
     * depends on it, an item it touched was deleted (`itemDeleted`), or its inverse no longer
     * applies or would break an invariant. The inverse is recorded as an `undo` change-set.
     */
    async undoChangeSet(
      input: UndoChangeSetInput,
      options: TopicWriterOptions = {}
    ): Promise<UndoChangeSetResult> {
      const db = options.client ?? pool;
      const meta = parseMeta({ ...input, origin: "human" });
      try {
        return await withConflicts(db, input.treeId, () =>
          runWriter(pool, options, [treeLockKey(input.treeId)], async (writer) => {
            const tree = await requireTree(writer, input.treeId);
            const conflict = treeConflict(tree, input.expectedGeneration);
            if (conflict) return conflict;
            const target = await writer.query<{
              id: string;
              status: TopicChangeSetStatus;
              undoOf: string | null;
              generation: string | number | null;
            }>(
              `select id, status, undo_of as "undoOf", generation from topic_change_sets
                where id = $1 and tree_id = $2`,
              [input.changeSetId, tree.id]
            );
            const row = target.rows[0];
            if (!row) {
              throw new TopicTreeRepositoryError(
                "changeSetNotFound",
                `Change-set ${input.changeSetId} not found`
              );
            }
            const events = (await readEvents(writer, [row.id])).get(row.id) ?? [];
            const undoable: UndoableChangeSet = {
              id: row.id,
              status: row.status,
              undoOf: row.undoOf,
              events
            };
            const later =
              row.status === "applied"
                ? await laterChangeSets(writer, tree.id, Number(row.generation), events)
                : [];
            const blockers = [...changeSetBlockers(undoable, later)];
            if (row.status === "applied") blockers.push(...(await deletedItems(writer, events)));
            if (blockers.length > 0) throw new UndoBlocked(blockers);
            const inverse = invertEvents(events);
            let applied: AppliedChangeSet;
            try {
              applied = await commitChangeSet(writer, {
                tree,
                changeSet: { meta: { ...meta, origin: "undo" }, undoOf: row.id },
                events: inverse,
                stats: input.stats ?? [],
                clock: input.clock
              });
            } catch (error) {
              if (error instanceof TopicEventConflict && error.code !== "busy") {
                throw new UndoBlocked([undoBlockerOf(error, inverse)]);
              }
              throw error;
            }
            const broken = await inverseConflicts(writer, tree, inverse);
            if (broken.length > 0) throw new UndoBlocked(broken);
            await writer.query(
              "update topic_change_sets set status = 'undone', undone_at = now() where id = $1",
              [row.id]
            );
            return applied;
          })
        );
      } catch (error) {
        if (error instanceof UndoBlocked) return { kind: "blocked", blockers: error.blockers };
        throw error;
      }
    },

    /** Applies or dismisses a `pending_review` change-set (D29). */
    async resolvePendingChangeSet(
      input: ResolvePendingInput,
      options: TopicWriterOptions = {}
    ): Promise<ResolvePendingResult> {
      const db = options.client ?? pool;
      return withConflicts(db, input.treeId, () =>
        runWriter(pool, options, [treeLockKey(input.treeId)], async (writer) => {
          const tree = await requireTree(writer, input.treeId);
          const row = (
            await writer.query<{ status: TopicChangeSetStatus }>(
              "select status from topic_change_sets where id = $1 and tree_id = $2 for update",
              [input.changeSetId, tree.id]
            )
          ).rows[0];
          if (!row) {
            throw new TopicTreeRepositoryError(
              "changeSetNotFound",
              `Change-set ${input.changeSetId} not found`
            );
          }
          if (row.status !== "pending_review")
            return { kind: "not_pending", status: row.status } as const;
          if (input.decision === "dismiss") {
            await writer.query("update topic_change_sets set status = 'dismissed' where id = $1", [
              input.changeSetId
            ]);
            return { kind: "dismissed", changeSetId: input.changeSetId } as const;
          }
          const conflict = treeConflict(tree, input.expectedGeneration);
          if (conflict) return conflict;
          const events =
            (await readEvents(writer, [input.changeSetId])).get(input.changeSetId) ?? [];
          return commitChangeSet(writer, {
            tree,
            changeSet: { pendingId: input.changeSetId },
            events,
            stats: input.stats ?? [],
            clock: input.clock
          });
        })
      );
    },

    /**
     * Unplaces source items (and optionally their notes) as one change-set, before a known removal
     * path; deletions that bypass it still leave by cascade (D32).
     */
    async unplaceForSources(
      input: UnplaceForSourcesInput,
      options: TopicWriterOptions = {}
    ): Promise<ApplyChangeSetResult> {
      const meta = parseMeta(input);
      const sourceIds = [...new Set(input.sourceIds)];
      if (!sourceIds.every((id) => uuid.safeParse(id).success)) {
        throw new TopicTreeRepositoryError("invalidInput", "Invalid source ID");
      }
      const db = options.client ?? pool;
      return withConflicts(db, input.treeId, () =>
        runWriter(pool, options, [treeLockKey(input.treeId)], async (writer) => {
          const tree = await requireTree(writer, input.treeId);
          const conflict = treeConflict(tree, input.expectedGeneration);
          if (conflict) return conflict;
          const rows = await writer.query<PlacementRow>(
            `select ${placementColumns} from topic_placements p
              where p.tree_id = $1 and (
                (p.item_kind = 'source' and p.source_item_id = any($2::uuid[]))
                or ($3 and p.item_kind = 'note' and (p.root_source_item_id = any($2::uuid[])
                    or exists (select 1 from atomic_notes n where n.id = p.note_id
                                and n.created_from_source_item_id = any($2::uuid[])))))`,
            [tree.id, sourceIds, input.includeNotes ?? false]
          );
          const entries = rows.rows
            .map(placementEntryFromRow)
            .sort((a, b) => compareStrings(a.item, b.item) || b.placement.rank - a.placement.rank);
          if (entries.length === 0)
            return { kind: "no_change", generation: tree.generation } as const;
          const events: StructureEvent[] = entries.map(({ item, placement }) => ({
            op: "item.unplace",
            item,
            topicId: placement.topicId,
            before: placement,
            after: null
          }));
          return commitChangeSet(writer, {
            tree,
            changeSet: { meta, undoOf: null },
            events: parseEvents(events),
            stats: []
          });
        })
      );
    },

    /**
     * Restores exact statistics (D7) for the dirty topics, the given ones and their paths to the
     * root, bottom-up with the engine's own functions; `all` recomputes every live topic. Item
     * data is loaded before the transaction; the writer locks the rows, re-reads the structure
     * and writes, retrying when a change-set landed meanwhile.
     */
    async recomputeStats(input: RecomputeStatsInput): Promise<RecomputeStatsResult> {
      const requested = new Set(input.topicIds ?? []);
      for (let attempt = 0; attempt < topicTreeRepositoryLimits.recomputeAttempts; attempt += 1) {
        const tree = await requireTree(pool, input.treeId);
        if (tree.status !== "active") return { kind: "conflict", reason: "treeRetired" };
        const snapshot = await readRecords(pool, tree);
        const stored = await readStats(pool, tree);
        const live = new Set(
          snapshot.topics.filter((topic) => topic.retiredAt === null).map((t) => t.id)
        );
        const targets = input.all
          ? [...live]
          : [
              ...new Set([
                ...stored.filter((row) => row.dirty).map((row) => row.topicId),
                ...requested
              ])
            ].filter((id) => live.has(id));
        if (targets.length === 0) return { kind: "clean", generation: tree.generation };
        const keys = [...new Set(snapshot.placements.map((entry) => entry.item))];
        const data = await input.items.load(keys, tree);
        let outcome: RecomputeStatsResult | "retry";
        try {
          outcome = await runWriter(pool, {}, [treeLockKey(tree.id)], async (writer) => {
            const current = await requireTree(writer, tree.id);
            if (current.generation !== tree.generation || current.status !== "active")
              return "retry";
            const closure = await topicClosure(writer, tree.id, targets, []);
            const ids = closure.filter((row) => row.live).map((row) => row.id);
            await lockStats(writer, ids);
            const records = await readRecords(writer, current);
            if (records.placements.some((entry) => !data.entries.has(entry.item))) return "retry";
            const state = stateFromRecords(records, data);
            if (input.all) {
              recomputeSubtree(state, data.vectors);
            } else {
              loadStoredStats(state, await readStats(writer, current));
              recomputePaths(state, data.vectors, targets);
            }
            const writes = topicStatsWrites(state, data.vectors, ids);
            await writeStats(writer, current, writes, new Set());
            await recount(writer, tree.id, ids);
            return {
              kind: "recomputed",
              topicIds: [...ids].sort(compareStrings),
              generation: current.generation
            };
          });
        } catch (error) {
          if (!isBusy(error)) throw error;
          outcome = "retry";
        }
        if (outcome !== "retry") return outcome;
      }
      return { kind: "conflict", reason: "busy" };
    },

    /** Adds counters and sets gauges of one tree and local day. */
    async upsertDailyMetrics(input: DailyMetricsInput): Promise<TopicDailyMetrics> {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.day)) {
        throw new TopicTreeRepositoryError("invalidInput", `Invalid day ${input.day}`);
      }
      const add = input.increments ?? {};
      const counters = [
        add.opsApplied,
        add.itemsMoved,
        add.primaryPathChanges,
        add.gateCalls,
        add.namingCalls
      ].map((value) => value ?? 0);
      if (!counters.every((value) => Number.isInteger(value) && value >= 0)) {
        throw new TopicTreeRepositoryError("invalidInput", "Daily counters grow by whole numbers");
      }
      const gauges = input.gauges ?? {};
      const result = await pool.query<TopicDailyMetrics & { day: string | Date }>(
        `insert into topic_daily_metrics as m (tree_id, day, ops_applied, items_moved, primary_path_changes,
           gate_calls, naming_calls, unsorted_share, mean_depth, fanout_in_target, hard_violations,
           soft_violations)
         values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (tree_id, day) do update set
           ops_applied = m.ops_applied + excluded.ops_applied,
           items_moved = m.items_moved + excluded.items_moved,
           primary_path_changes = m.primary_path_changes + excluded.primary_path_changes,
           gate_calls = m.gate_calls + excluded.gate_calls,
           naming_calls = m.naming_calls + excluded.naming_calls,
           unsorted_share = case when $13 then excluded.unsorted_share else m.unsorted_share end,
           mean_depth = case when $14 then excluded.mean_depth else m.mean_depth end,
           fanout_in_target = case when $15 then excluded.fanout_in_target else m.fanout_in_target end,
           hard_violations = case when $16 then excluded.hard_violations else m.hard_violations end,
           soft_violations = case when $17 then excluded.soft_violations else m.soft_violations end,
           updated_at = now()
         returning tree_id as "treeId", to_char(day, 'YYYY-MM-DD') as day, ops_applied as "opsApplied",
           items_moved as "itemsMoved", primary_path_changes as "primaryPathChanges",
           unsorted_share as "unsortedShare", mean_depth as "meanDepth",
           fanout_in_target as "fanoutInTarget", hard_violations as "hardViolations",
           soft_violations as "softViolations", gate_calls as "gateCalls", naming_calls as "namingCalls"`,
        [
          input.treeId,
          input.day,
          ...counters,
          gauges.unsortedShare ?? null,
          gauges.meanDepth ?? null,
          gauges.fanoutInTarget ?? null,
          gauges.hardViolations ?? null,
          gauges.softViolations ?? null,
          "unsortedShare" in gauges,
          "meanDepth" in gauges,
          "fanoutInTarget" in gauges,
          "hardViolations" in gauges,
          "softViolations" in gauges
        ]
      );
      return { ...result.rows[0]!, day: String(result.rows[0]!.day) };
    },

    /**
     * Records a gate decision in the decision cache (item content, descriptor set and decider);
     * an identical key keeps the first decision and returns it with `cached: true`.
     */
    async recordGateDecision(
      input: GateDecisionInput
    ): Promise<{ decision: TopicGateDecision; cached: boolean }> {
      const parsed = GateDecisionInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new TopicTreeRepositoryError(
          "invalidInput",
          `Invalid gate decision: ${parsed.error.message}`
        );
      }
      const decision = parsed.data;
      const item = eventItemKey(decision.item);
      const inserted = await pool.query<GateDecisionRow>(
        `insert into topic_gate_decisions (tree_id, item_kind, item_id, item_hash, descriptor_set_hash,
           decider_key, candidates, chosen_topic_id, none_of_these, ai_task_run_id)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8::uuid is null, $9)
         on conflict (item_hash, descriptor_set_hash, decider_key) do nothing
         returning ${gateColumns}`,
        [
          decision.treeId,
          item.kind,
          item.id,
          decision.itemHash,
          decision.descriptorSetHash,
          decision.deciderKey,
          JSON.stringify(decision.candidates),
          decision.chosenTopicId,
          decision.aiTaskRunId
        ]
      );
      if (inserted.rows[0])
        return { decision: gateDecisionFromRow(inserted.rows[0]), cached: false };
      const existing = await findGateDecision(pool, decision);
      if (!existing) throw new Error("A cached gate decision disappeared");
      return { decision: existing, cached: true };
    },

    /** The cached decision for an item content, descriptor set and decider, or null. */
    async findGateDecision(key: GateDecisionKey): Promise<TopicGateDecision | null> {
      return findGateDecision(pool, key);
    },

    /** Stores a calibration; `activate` makes it the active one of its space and decider. */
    async saveCalibration(input: CalibrationInput): Promise<TopicCalibration> {
      if (!input.spaceKey || !input.dataset) {
        throw new TopicTreeRepositoryError(
          "invalidInput",
          "A calibration needs a space and a dataset"
        );
      }
      return runWriter(pool, {}, [`topic-calibration:${input.spaceKey}`], async (db) => {
        if (input.activate) {
          await db.query(
            `update topic_calibrations set active = false
              where space_key = $1 and coalesce(decider_key, '') = coalesce($2, '') and active`,
            [input.spaceKey, input.deciderKey]
          );
        }
        const result = await db.query<CalibrationRow>(
          `insert into topic_calibrations (space_key, decider_key, params, metrics, dataset, active)
           values ($1, $2, $3::jsonb, $4::jsonb, $5, $6) returning ${calibrationColumns}`,
          [
            input.spaceKey,
            input.deciderKey,
            JSON.stringify(input.params),
            JSON.stringify(input.metrics ?? {}),
            input.dataset,
            input.activate
          ]
        );
        return calibrationFromRow(result.rows[0]!);
      });
    },

    async activeCalibration(
      spaceKey: string,
      deciderKey: string | null
    ): Promise<TopicCalibration | null> {
      const result = await pool.query<CalibrationRow>(
        `select ${calibrationColumns} from topic_calibrations
          where space_key = $1 and coalesce(decider_key, '') = coalesce($2, '') and active`,
        [spaceKey, deciderKey]
      );
      return result.rows[0] ? calibrationFromRow(result.rows[0]) : null;
    }
  };
}

export type TopicTreeRepository = ReturnType<typeof createTopicTreeRepository>;

interface GateDecisionRow {
  id: string;
  treeId: string;
  itemKind: TopicItemKind;
  itemId: string;
  itemHash: string;
  descriptorSetHash: string;
  deciderKey: string;
  candidates: z.output<typeof GateCandidateSchema>[];
  chosenTopicId: string | null;
  noneOfThese: boolean;
  aiTaskRunId: string | null;
  createdAt: Date | string;
}

const gateColumns = `id, tree_id as "treeId", item_kind as "itemKind", item_id as "itemId",
  item_hash as "itemHash", descriptor_set_hash as "descriptorSetHash", decider_key as "deciderKey",
  candidates, chosen_topic_id as "chosenTopicId", none_of_these as "noneOfThese",
  ai_task_run_id as "aiTaskRunId", created_at as "createdAt"`;

export interface GateDecisionKey {
  itemHash: string;
  descriptorSetHash: string;
  deciderKey: string;
}

async function findGateDecision(
  db: Queryable,
  key: GateDecisionKey
): Promise<TopicGateDecision | null> {
  const result = await db.query<GateDecisionRow>(
    `select ${gateColumns} from topic_gate_decisions
      where item_hash = $1 and descriptor_set_hash = $2 and decider_key = $3`,
    [key.itemHash, key.descriptorSetHash, key.deciderKey]
  );
  return result.rows[0] ? gateDecisionFromRow(result.rows[0]) : null;
}

function gateDecisionFromRow(row: GateDecisionRow): TopicGateDecision {
  return {
    id: row.id,
    treeId: row.treeId,
    item: itemKey(row.itemKind, row.itemId),
    itemHash: row.itemHash,
    descriptorSetHash: row.descriptorSetHash,
    deciderKey: row.deciderKey,
    candidates: row.candidates,
    chosenTopicId: row.chosenTopicId,
    noneOfThese: row.noneOfThese,
    aiTaskRunId: row.aiTaskRunId,
    createdAt: new Date(row.createdAt)
  };
}

interface CalibrationRow {
  id: string;
  spaceKey: string;
  deciderKey: string | null;
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  dataset: string;
  active: boolean;
  createdAt: Date | string;
}

const calibrationColumns = `id, space_key as "spaceKey", decider_key as "deciderKey", params, metrics,
  dataset, active, created_at as "createdAt"`;

function calibrationFromRow(row: CalibrationRow): TopicCalibration {
  return { ...row, createdAt: new Date(row.createdAt) };
}
