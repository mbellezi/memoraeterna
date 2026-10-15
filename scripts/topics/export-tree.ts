// `topics:export` (F2 T22a): a read-only export of a profile's topic tree for the developer tooling.
//
//   <cache>/topics/exports/<name>/export.json   the tree, names, placements, gate log, change-sets,
//                                               audit and the library counts (this file)
//   <cache>/topics/vectors/<name>.f32           the replay store (export-vectors.ts): one unit row
//   <cache>/topics/vectors/<name>.index.jsonl   per current note with a vector in the tree's space,
//   <cache>/topics/vectors/<name>.meta.json     in import order, so the offline replay (T09) loads it
//
// The replay store is the tree's own space (GGUF vectors in the app's route): spaces are never mixed
// (`rules/data.md`). The export reads through `topicTreeLoadRepository` and plain SELECTs; the
// connection is read-only, and the structure tables have one writer (D9) that is not this.
//
// The pure part takes a `TopicExportSource` so it can be tested without a database;
// `createSqlTopicExportSource` is the PostgreSQL implementation (verified by `verify-export.ts`).
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { createTopicTreeLoadRepository, stateFromRecords } from "@app/db";
import type {
  Queryable,
  TopicItemVectors,
  TopicLoadSpace,
  TopicSkeleton,
  TopicTreeRecords
} from "@app/db";
import {
  TopicTreeConfigSchema,
  itemKey,
  shapeReport,
  topicRecordOf,
  updateCentroid
} from "@app/domain/topic-tree";
import type { ItemKey, ShapeReport, TopicTreeState } from "@app/domain/topic-tree";

import { cacheRoot } from "./datasets.js";
import { replayStorePaths, writeReplayStore } from "./export-vectors.js";
import type { ReplayMeta, WritableReplayRow } from "./export-vectors.js";

export const topicExportFormat = "memora-topic-export";
export const topicExportVersion = 1;
export const topicExportNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Change-sets listed in `export.json` (the counts below always cover all of them). */
export const exportedChangeSetLimit = 5_000;

export interface ExportNote {
  id: string;
  title: string;
  language: string;
  createdAt: string;
  /** The root source of the note's owning source; null for a knowledge-owned note. */
  rootSourceId: string | null;
  rootTitle: string | null;
}

export interface ExportRootSource {
  id: string;
  title: string;
  type: string;
  createdAt: string;
}

export interface ExportGateDecision {
  id: string;
  itemKind: string;
  itemId: string;
  itemHash: string;
  descriptorSetHash: string;
  deciderKey: string;
  candidates: unknown;
  chosenTopicId: string | null;
  noneOfThese: boolean;
  createdAt: string;
}

export interface ExportChangeSet {
  id: string;
  origin: string;
  status: string;
  risk: string;
  titleKey: string;
  undoOf: string | null;
  generation: number | null;
  createdAt: string;
  appliedAt: string | null;
  undoneAt: string | null;
  summary: unknown;
}

export interface ExportDailyMetric {
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

/** What the export reads. Everything is a read; the SQL implementation uses a read-only session. */
export interface TopicExportSource {
  /** The skeleton of the tree (the active one when `treeId` is absent); null when there is none. */
  loadSkeleton(treeId?: string): Promise<TopicSkeleton | null>;
  /** Current notes (not rejected, archived or superseded) in import order. */
  listNotes(): Promise<ExportNote[]>;
  rootSources(): Promise<ExportRootSource[]>;
  /** Vectors of notes in the tree's space, in request order. */
  loadNoteVectors(space: TopicLoadSpace, noteIds: readonly string[]): Promise<TopicItemVectors>;
  gateDecisions(treeId: string): Promise<ExportGateDecision[]>;
  /** The first `limit` change-sets by generation, and the counts of all of them. */
  changeSets(
    treeId: string,
    limit: number
  ): Promise<{
    items: ExportChangeSet[];
    total: number;
    byOrigin: Record<string, number>;
    byStatus: Record<string, number>;
  }>;
  dailyMetrics(treeId: string): Promise<ExportDailyMetric[]>;
}

export interface TopicExportOptions {
  /** Dataset name of the replay store and folder of the export. */
  name: string;
  /** Free text for the report header (never a path or a secret). */
  label?: string;
  /** The tree to export; the active one by default. */
  treeId?: string;
  /** Skip the vectors (the JSON export only). */
  vectors?: boolean;
  /** Replace an export of the same name. */
  force?: boolean;
  /** Where `topics/exports` and `topics/vectors` live (default `cacheRoot()`). */
  cacheDirectory?: string;
  /** Where the database is, for the header: host, port and name, never a password. */
  database?: { host: string; port: number | null; name: string };
  now?: () => Date;
}

export interface TopicExportFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface TopicExportResult {
  exportPath: string;
  vectorsDirectory: string | null;
  files: TopicExportFile[];
  summary: {
    treeId: string;
    generation: number;
    topics: number;
    liveTopics: number;
    placements: number;
    notes: number;
    vectorRows: number;
    notesWithoutVector: number;
    reachability: number;
    hardViolations: number;
    gateDecisions: number;
    changeSets: number;
  };
}

export class TopicExportError extends Error {
  override readonly name = "TopicExportError";
}

const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

/** The primary subtag of a BCP 47 code, lower case (`pt-BR` is `pt`); `und` stays. */
export function primaryLanguage(code: string): string {
  const primary = code.trim().split(/[-_]/u)[0]?.toLowerCase() ?? "";
  return primary === "" ? "und" : primary;
}

function treeRecords(skeleton: TopicSkeleton): TopicTreeRecords {
  const root = skeleton.topics.find((topic) => topic.role === "root" && topic.retiredAt === null);
  if (!root) throw new TopicExportError(`Topic tree ${skeleton.tree.id} has no live root`);
  const { tree } = skeleton;
  return {
    tree: {
      id: tree.id,
      status: tree.status,
      spaceKey: tree.space.spaceKey,
      embeddingProvider: tree.space.provider,
      embeddingModel: tree.space.model,
      embeddingRuntime: tree.space.runtime,
      dimensions: tree.space.dimensions,
      config: tree.config as Record<string, unknown>,
      configHash: tree.configHash,
      seed: tree.seed,
      generation: tree.generation,
      clock: 0,
      rootId: root.id,
      createdAt: new Date(tree.createdAt),
      activatedAt: tree.activatedAt === null ? null : new Date(tree.activatedAt),
      retiredAt: tree.retiredAt === null ? null : new Date(tree.retiredAt)
    },
    topics: skeleton.topics.map((topic) => topicRecordOf(topic)),
    placements: skeleton.placements.map((placement) => ({
      item: placement.key,
      placement: {
        topicId: placement.topicId,
        rank: placement.rank,
        management: placement.management,
        decidedBy: placement.decidedBy,
        itemFingerprint: placement.itemFingerprint,
        score: placement.score,
        margin: placement.margin,
        needsGate: placement.needsGate,
        needsSplitCheck: placement.needsSplitCheck,
        needsVector: placement.needsVector,
        movedFromTopicId: placement.movedFromTopicId,
        movedAt: placement.movedAt
      }
    }))
  };
}

/** The engine state of the stored tree, with the stored statistics, for the shape audit. */
function auditState(skeleton: TopicSkeleton): TopicTreeState {
  const state = stateFromRecords(treeRecords(skeleton));
  for (const topic of skeleton.topics) {
    const node = state.topics.get(topic.id);
    if (!node || topic.stats === null) continue;
    node.stats.n = topic.stats.n;
    node.stats.ls.set(topic.stats.ls);
    node.stats.cosSqSum = topic.stats.cosSqSum;
    node.stats.lowCosPercentiles = topic.stats.lowCosPercentiles;
    updateCentroid(node.stats);
    node.control.repairClock = topic.stats.repairClock;
    node.control.dirty = topic.stats.dirty;
  }
  return state;
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function fileEntry(path: string, label: string): Promise<TopicExportFile> {
  const data = await readFile(path);
  return { path: label, bytes: data.byteLength, sha256: sha256(data) };
}

export function assertExportName(name: string): void {
  if (!topicExportNamePattern.test(name))
    throw new TopicExportError(
      `The export name must match ${topicExportNamePattern} (lower case letters, digits and dashes)`
    );
}

/** Exports one tree. Refuses an existing export of the same name unless `force`. */
export async function exportTopicTree(
  source: TopicExportSource,
  options: TopicExportOptions
): Promise<TopicExportResult> {
  assertExportName(options.name);
  const now = options.now ?? (() => new Date());
  const base = join(options.cacheDirectory ?? cacheRoot(), "topics");
  const exportDirectory = join(base, "exports", options.name);
  const exportPath = join(exportDirectory, "export.json");
  const vectorsDirectory = join(base, "vectors");
  const withVectors = options.vectors ?? true;
  const storePaths = replayStorePaths(vectorsDirectory, options.name);
  if (!options.force) {
    for (const path of [exportPath, ...(withVectors ? [storePaths.meta] : [])])
      if (await exists(path))
        throw new TopicExportError(`${path} already exists; export under another name or --force`);
  }

  const skeleton = await source.loadSkeleton(options.treeId);
  if (!skeleton)
    throw new TopicExportError(
      options.treeId
        ? `Topic tree ${options.treeId} does not exist`
        : "There is no active topic tree"
    );
  const { tree } = skeleton;
  const config = TopicTreeConfigSchema.parse(tree.config);
  // One after the other: the source may be a single database connection.
  const notes = await source.listNotes();
  const roots = await source.rootSources();
  const gate = await source.gateDecisions(tree.id);
  const changeSets = await source.changeSets(tree.id, exportedChangeSetLimit);
  const daily = await source.dailyMetrics(tree.id);

  // The audit counts every current note and root source of the library as expected, so an item the
  // tree never placed shows up as unreachable instead of being silently absent.
  const state = auditState(skeleton);
  const expected: ItemKey[] = [
    ...notes.map((note) => itemKey("note", note.id)),
    ...roots.map((root) => itemKey("source", root.id))
  ];
  const audit: ShapeReport = shapeReport(state, config, { expectedItems: expected });

  const files: TopicExportFile[] = [];
  let vectorRows = 0;
  let notesWithoutVector = 0;
  let meta: ReplayMeta | null = null;
  if (withVectors) {
    const loaded = await source.loadNoteVectors(
      tree.space,
      notes.map((note) => note.id)
    );
    const byId = new Map(notes.map((note, order) => [note.id, { note, order }]));
    const rows: WritableReplayRow[] = loaded.keys.map((key, row) => {
      const id = key.slice("note:".length);
      const entry = byId.get(id)!;
      return {
        id,
        kind: "note",
        contentHash: loaded.contentHashes[row] as string,
        lang: primaryLanguage(entry.note.language),
        group: entry.note.rootSourceId ?? "knowledge",
        title: entry.note.title,
        order: entry.order,
        rootSourceId: entry.note.rootSourceId,
        createdAt: entry.note.createdAt,
        rootTitle: entry.note.rootTitle,
        dataset: options.name
      };
    });
    vectorRows = rows.length;
    notesWithoutVector = notes.length - rows.length;
    meta = {
      dataset: options.name,
      count: rows.length,
      dim: loaded.dim,
      model: { name: tree.space.model },
      runtime: tree.space.runtime,
      input: "app note embeddings in the tree's space",
      createdAt: now().toISOString(),
      spaceKey: tree.space.spaceKey,
      provider: tree.space.provider,
      treeId: tree.id,
      generation: tree.generation,
      configHash: tree.configHash
    };
    await writeReplayStore(vectorsDirectory, options.name, { meta, rows, matrix: loaded.matrix });
    for (const path of [storePaths.vectors, storePaths.index, storePaths.meta])
      files.push(await fileEntry(path, `vectors/${basename(path)}`));
  }

  const liveTopics = skeleton.topics.filter((topic) => topic.retiredAt === null);
  const document = {
    format: topicExportFormat,
    version: topicExportVersion,
    name: options.name,
    label: options.label ?? null,
    createdAt: now().toISOString(),
    database: options.database ?? null,
    tree: {
      id: tree.id,
      status: tree.status,
      space: tree.space,
      configHash: tree.configHash,
      seed: tree.seed,
      generation: tree.generation,
      createdAt: tree.createdAt,
      activatedAt: tree.activatedAt,
      retiredAt: tree.retiredAt,
      config: tree.config
    },
    library: { notes: notes.length, rootSources: roots.length },
    roots: roots.map((root) => ({
      ...root,
      notes: notes.filter((note) => note.rootSourceId === root.id).length
    })),
    topics: skeleton.topics.map((topic) => ({
      id: topic.id,
      parentId: topic.parentId,
      role: topic.role,
      title: topic.title,
      nameState: topic.nameState,
      nameSource: topic.nameSource,
      nameLanguage: topic.nameLanguage,
      description: topic.description,
      aliases: topic.aliases,
      management: topic.management,
      position: topic.position,
      retiredAt: topic.retiredAt,
      redirectTo: topic.redirectTo,
      stats:
        topic.stats === null
          ? null
          : {
              n: topic.stats.n,
              coherence: topic.stats.coherence,
              cosSqSum: topic.stats.cosSqSum,
              directItems: topic.stats.directItems,
              children: topic.stats.children,
              health: topic.stats.health,
              violations: topic.stats.violations,
              dirty: topic.stats.dirty,
              computedAt: topic.stats.computedAt
            }
    })),
    placements: skeleton.placements.map((placement) => ({
      item: placement.key,
      kind: placement.itemKind,
      topicId: placement.topicId,
      rank: placement.rank,
      management: placement.management,
      decidedBy: placement.decidedBy,
      fingerprint: placement.itemFingerprint,
      score: placement.score,
      margin: placement.margin,
      centrality: placement.centrality,
      needsGate: placement.needsGate,
      needsSplitCheck: placement.needsSplitCheck,
      needsVector: placement.needsVector,
      movedFromTopicId: placement.movedFromTopicId,
      changeSetId: placement.changeSetId
    })),
    gateDecisions: gate,
    changeSets: {
      total: changeSets.total,
      listed: changeSets.items.length,
      byOrigin: changeSets.byOrigin,
      byStatus: changeSets.byStatus,
      items: changeSets.items
    },
    dailyMetrics: daily,
    audit,
    vectors: meta
      ? {
          dataset: options.name,
          dim: meta.dim,
          spaceKey: tree.space.spaceKey,
          rows: vectorRows,
          notesWithoutVector,
          files
        }
      : null
  };
  await writeAtomic(exportPath, `${JSON.stringify(document, null, 2)}\n`);
  return {
    exportPath,
    vectorsDirectory: withVectors ? vectorsDirectory : null,
    files,
    summary: {
      treeId: tree.id,
      generation: tree.generation,
      topics: skeleton.topics.length,
      liveTopics: liveTopics.length,
      placements: skeleton.placements.length,
      notes: notes.length,
      vectorRows,
      notesWithoutVector,
      reachability: audit.reachability,
      hardViolations: audit.violations.hardCount,
      gateDecisions: gate.length,
      changeSets: changeSets.total
    }
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL source

interface NoteRow {
  id: string;
  title: string;
  language: string;
  createdAt: Date | string;
  rootId: string | null;
  rootTitle: string | null;
}

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

/** The PostgreSQL implementation. `db` should be a read-only session; nothing here writes. */
export function createSqlTopicExportSource(db: Queryable): TopicExportSource {
  const load = createTopicTreeLoadRepository(db);
  return {
    async loadSkeleton(treeId) {
      const id = treeId ?? (await load.activeTreeId());
      return id === null ? null : load.loadSkeleton(id);
    },

    async listNotes() {
      const result = await db.query<NoteRow>(
        `select a.id::text as id, a.title, a.language, a.created_at as "createdAt",
                root.id::text as "rootId", root.title as "rootTitle"
         from atomic_notes a
         left join lateral (
           with recursive up(id, parent_id, title, created_at) as (
             select s.id, s.parent_source_item_id, s.title, s.created_at from source_items s
             where s.id = a.owning_source_item_id
             union all
             select s.id, s.parent_source_item_id, s.title, s.created_at
             from source_items s join up on s.id = up.parent_id)
           select id, title, created_at from up where parent_id is null limit 1) root on true
         where a.status not in ('rejected', 'archived') and a.supersession_status = 'current'
         order by root.created_at nulls last, root.id nulls last, a.created_at, a.id`
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        language: row.language,
        createdAt: iso(row.createdAt),
        rootSourceId: row.rootId,
        rootTitle: row.rootTitle
      }));
    },

    async rootSources() {
      const result = await db.query<{
        id: string;
        title: string;
        type: string;
        createdAt: Date | string;
      }>(
        `select id::text as id, title, type::text as type, created_at as "createdAt"
         from source_items where parent_source_item_id is null order by created_at, id`
      );
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        type: row.type,
        createdAt: iso(row.createdAt)
      }));
    },

    loadNoteVectors(space, noteIds) {
      return load.loadItemVectors(
        space,
        noteIds.map((id) => ({ kind: "note" as const, id }))
      );
    },

    async gateDecisions(treeId) {
      const result = await db.query<{
        id: string;
        itemKind: string;
        itemId: string;
        itemHash: string;
        descriptorSetHash: string;
        deciderKey: string;
        candidates: unknown;
        chosenTopicId: string | null;
        noneOfThese: boolean;
        createdAt: Date | string;
      }>(
        `select id::text as id, item_kind as "itemKind", item_id::text as "itemId",
                item_hash as "itemHash", descriptor_set_hash as "descriptorSetHash",
                decider_key as "deciderKey", candidates, chosen_topic_id::text as "chosenTopicId",
                none_of_these as "noneOfThese", created_at as "createdAt"
         from topic_gate_decisions where tree_id = $1 order by created_at, id`,
        [treeId]
      );
      return result.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
    },

    async changeSets(treeId, limit) {
      const counts = await db.query<{ origin: string; status: string; count: number }>(
        `select origin, status, count(*)::int as count from topic_change_sets
         where tree_id = $1 group by origin, status order by origin, status`,
        [treeId]
      );
      const byOrigin: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      let total = 0;
      for (const row of counts.rows) {
        const count = Number(row.count);
        total += count;
        byOrigin[row.origin] = (byOrigin[row.origin] ?? 0) + count;
        byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
      }
      const result = await db.query<{
        id: string;
        origin: string;
        status: string;
        risk: string;
        titleKey: string;
        undoOf: string | null;
        generation: string | null;
        createdAt: Date | string;
        appliedAt: Date | string | null;
        undoneAt: Date | string | null;
        summary: unknown;
      }>(
        `select id::text as id, origin, status, risk, title_key as "titleKey",
                undo_of::text as "undoOf", generation::text as generation, created_at as "createdAt",
                applied_at as "appliedAt", undone_at as "undoneAt", summary
         from topic_change_sets where tree_id = $1
         order by generation nulls last, created_at, id limit $2`,
        [treeId, limit]
      );
      return {
        total,
        byOrigin,
        byStatus,
        items: result.rows.map((row) => ({
          id: row.id,
          origin: row.origin,
          status: row.status,
          risk: row.risk,
          titleKey: row.titleKey,
          undoOf: row.undoOf,
          generation: row.generation === null ? null : Number(row.generation),
          createdAt: iso(row.createdAt),
          appliedAt: isoOrNull(row.appliedAt),
          undoneAt: isoOrNull(row.undoneAt),
          summary: row.summary
        }))
      };
    },

    async dailyMetrics(treeId) {
      const result = await db.query<ExportDailyMetric & { day: Date | string }>(
        `select to_char(day, 'YYYY-MM-DD') as day, ops_applied as "opsApplied",
                items_moved as "itemsMoved", primary_path_changes as "primaryPathChanges",
                unsorted_share as "unsortedShare", mean_depth as "meanDepth",
                fanout_in_target as "fanoutInTarget", hard_violations as "hardViolations",
                soft_violations as "softViolations", gate_calls as "gateCalls",
                naming_calls as "namingCalls"
         from topic_daily_metrics where tree_id = $1 order by day`,
        [treeId]
      );
      return result.rows.map((row) => ({ ...row, day: String(row.day) }));
    }
  };
}
