// The builders of the developer comparison report (`npm run topics:report`, F2 T22b, D21).
//
// It reads what the developer tooling already produces, never a live database: an in-app tree as
// written by `topics:export` (`export.json` plus the replay store of its note vectors) and, for
// the fresh build it is compared with, the same offline engine the replay harness runs (T09). One
// profile (DEV, ENV-G, ENV-F or ENV-C) becomes one `ProfileReport`:
//
// - the exit criteria it can be measured against (E1 reachability, E2 shape, E3 churn from the
//   daily metrics, E5 undo rate, the Unsorted share) with bars and a verdict each;
// - the shape, the naming, the placements and the gate (decisions, "none", margins);
// - churn and change-sets per day;
// - sampled topics (Areas, level 2, deeper) with their 5 central members;
// - the incremental tree against a fresh build of the same vectors in the same content-key order
//   and seed (equal partition hash, agreement, shapes side by side);
// - the legacy wiki's shape, recorded before the wipe (DEV only).
//
// Everything here is pure over parsed inputs, so tests build trees in memory. A report holds
// aggregates, topic names and note titles of the exported library: it stays in `.cache/`.
import { createHash } from "node:crypto";

import {
  canonicalPartition,
  coherenceOf,
  compareStrings,
  cutLabels,
  createRng,
  createTopicTreeState,
  deriveSeed,
  insertPlacement,
  insertTopic,
  isLive,
  leafLabels,
  nmi,
  placementRecord,
  recomputeSubtree,
  registerItem,
  rowContentHash,
  rowItemKey,
  rowOfItemKey,
  shapeReport,
  subtreeItems,
  TopicTreeConfigSchema,
  topicRecord,
  walkTopics
} from "@app/domain/topic-tree";
import type {
  EmbeddingMatrix,
  ItemVectorSource,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { createReplayDataset, subsetDataset } from "./datasets.js";
import type { ReplayDataset } from "./datasets.js";
import type { ReplayStore } from "./export-vectors.js";
import { parityRun } from "./replay.js";
import { createRealEngine } from "./real-engine.js";
import { summarizeShape } from "./report-data.js";
import type { ShapeSummary, TruthSummary } from "./report-data.js";
import { depthLabels, truthSummary } from "./replay-metrics.js";
import { ComparisonDocumentSchema, compareSchemaVersion } from "./report-schema.js";
import type {
  ComparisonDocument,
  ExportDocument,
  FreshComparison,
  LegacyRecord,
  ProfileReport,
  Sample,
  TargetCheck
} from "./report-schema.js";

export * from "./report-schema.js";

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------
// Inputs and options

/** Which ground truth an export can be joined to: (language, root title) -> domain. */
export interface TruthSource {
  name: string;
  domainOf(language: string, rootTitle: string): string | undefined;
}

export interface ProfileInput {
  document: ExportDocument;
  /** The replay store of the export's note vectors; null for an export made with --no-vectors. */
  store: ReplayStore | null;
  truth?: TruthSource | null;
  legacy?: LegacyRecord | null;
}

export interface ReportOptions {
  /** Seed of the samples (the fresh build uses the tree's own seed). */
  seed: number;
  /** Topics sampled for the members view. */
  sample: number;
  /** Build the fresh tree for the comparison (it takes about as long as the app's build). */
  fresh: boolean;
  /** Central members shown per sampled topic. */
  members: number;
}

export const defaultReportOptions: ReportOptions = {
  seed: 20261014,
  sample: 12,
  fresh: true,
  members: 5
};

// ---------------------------------------------------------------------------
// Exit criteria: the bars (spec section 8)

export const exitBars = {
  /** E1 */
  reachability: 1,
  hardViolations: 0,
  /** E2 */
  meanDepthMax: 4.5,
  fanOutInTargetMin: 0.8,
  /** E3, per week, in replay and in the app */
  weeklyChurnMax: 0.03,
  /** D27 (reported, from this many items) */
  unsortedMax: 0.02,
  unsortedMinItems: 50,
  /** Plan section 8 KPI, reported */
  undoRateMax: 0.05
} as const;

const automaticOrigins = new Set([
  "build",
  "place",
  "gate",
  "rebalance",
  "audit",
  "naming",
  "areas",
  "rebuild"
]);

function target(
  id: string,
  name: string,
  value: number | null,
  bounds: { min?: number; max?: number },
  options: { gating: boolean; note?: string }
): TargetCheck {
  const min = bounds.min ?? null;
  const max = bounds.max ?? null;
  const status =
    value === null
      ? "na"
      : (min === null || value >= min - 1e-9) && (max === null || value <= max + 1e-9)
        ? "pass"
        : "fail";
  return {
    id,
    name,
    value: value === null ? null : round(value, 6),
    min,
    max,
    status,
    gating: options.gating,
    note: options.note ?? null
  };
}

function histogramOf(values: readonly string[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number);
}

// ---------------------------------------------------------------------------
// The tree of an export

interface TreeNode {
  id: string;
  parentId: string | null;
  children: string[];
  depth: number;
  topic: ExportDocument["topics"][number];
}

interface ExportTree {
  rootId: string;
  nodes: Map<string, TreeNode>;
  /** Live topics not reachable from the root through live parents. */
  unreachable: number;
}

/** The live topics of an export with their children in sibling order (position, then id). */
export function exportTree(document: ExportDocument): ExportTree {
  const live = document.topics.filter((topic) => topic.retiredAt === null);
  const root = live.find((topic) => topic.role === "root" && topic.parentId === null);
  if (!root) throw new Error(`The export ${document.name} has no live root topic`);
  const nodes = new Map<string, TreeNode>();
  for (const topic of live)
    nodes.set(topic.id, { id: topic.id, parentId: topic.parentId, children: [], depth: -1, topic });
  for (const node of nodes.values()) {
    if (node.parentId === null) continue;
    nodes.get(node.parentId)?.children.push(node.id);
  }
  for (const node of nodes.values()) {
    node.children.sort(
      (a, b) =>
        nodes.get(a)!.topic.position - nodes.get(b)!.topic.position || (a < b ? -1 : a > b ? 1 : 0)
    );
  }
  const queue: TreeNode[] = [nodes.get(root.id)!];
  nodes.get(root.id)!.depth = 0;
  for (let at = 0; at < queue.length; at += 1) {
    const node = queue[at]!;
    for (const childId of node.children) {
      const child = nodes.get(childId)!;
      child.depth = node.depth + 1;
      queue.push(child);
    }
  }
  const unreachable = [...nodes.values()].filter((node) => node.depth < 0).length;
  return { rootId: root.id, nodes, unreachable };
}

// ---------------------------------------------------------------------------
// The incremental tree as an engine state, on the replay store's rows

/** Rows of the store in content-key order (D22): the content hash first, then the item key. */
export function contentKeyOrder(store: Pick<ReplayStore, "rows">): number[] {
  return store.rows
    .map((row, index) => ({ index, hash: row.contentHash, key: `note:${row.id}` }))
    .sort((a, b) => compareStrings(a.hash, b.hash) || compareStrings(a.key, b.key))
    .map((entry) => entry.index);
}

/** The vector source of a matrix whose rows are the engine's `row:<n>` items. */
export function rowVectorSource(matrix: EmbeddingMatrix): ItemVectorSource {
  return { matrix, rowOf: (item) => rowOfItemKey(item) };
}

export interface ExportState {
  state: TopicTreeState;
  /** Rows (in the dataset's order) that have a primary placement on a live topic. */
  placedRows: number[];
  unplaced: number;
  placedOnRetired: number;
}

/**
 * Rebuilds the exported tree's notes as an engine state on `row:<n>` keys, `n` being the row of
 * the (reordered) dataset. Notes without a placement stay out; a placement on a retired topic is
 * counted, not placed. Statistics are recomputed from the vectors, in the tree's own space.
 */
export function stateFromExport(
  document: ExportDocument,
  dataset: Pick<ReplayDataset, "rows" | "matrix">
): ExportState {
  const tree = exportTree(document);
  const state = createTopicTreeState({ dim: dataset.matrix.dim, rootId: tree.rootId });
  const queue = [tree.rootId];
  for (let at = 0; at < queue.length; at += 1) {
    const node = tree.nodes.get(queue[at]!)!;
    for (const childId of node.children) {
      const child = tree.nodes.get(childId)!;
      insertTopic(
        state,
        topicRecord(child.id, node.id, {
          position: child.topic.position,
          title: child.topic.title,
          management: child.topic.management as "ai" | "human" | "pinned"
        })
      );
      queue.push(childId);
    }
  }
  const rowOfNote = new Map(dataset.rows.map((row, index) => [row.id, index]));
  const retired = new Set(document.topics.filter((t) => t.retiredAt !== null).map((t) => t.id));
  const placedRows: number[] = [];
  let placedOnRetired = 0;
  for (const placement of document.placements) {
    if (placement.kind !== "note" || placement.rank !== 0) continue;
    const row = rowOfNote.get(placement.item.slice("note:".length));
    if (row === undefined) continue;
    if (!state.topics.has(placement.topicId)) {
      if (retired.has(placement.topicId)) placedOnRetired += 1;
      continue;
    }
    const key = rowItemKey(row);
    registerItem(state, { key, kind: "note", contentHash: rowContentHash(row), rootSource: null });
    insertPlacement(
      state,
      key,
      placementRecord(placement.topicId, {
        decidedBy: placement.decidedBy as "build",
        margin: placement.margin,
        score: placement.score,
        needsGate: placement.needsGate,
        needsSplitCheck: placement.needsSplitCheck,
        needsVector: placement.needsVector
      })
    );
    placedRows.push(row);
  }
  placedRows.sort((a, b) => a - b);
  recomputeSubtree(state, rowVectorSource(dataset.matrix), state.rootId);
  return {
    state,
    placedRows,
    unplaced: dataset.rows.length - placedRows.length,
    placedOnRetired
  };
}

/** Drops topics that hold no note anywhere below them (the fresh build has none). */
function prunedPartitionHash(state: TopicTreeState): string {
  const keep = new Set<string>();
  const mark = (id: string): boolean => {
    const node = state.topics.get(id)!;
    let any = node.items.length > 0;
    for (const child of node.children) if (mark(child)) any = true;
    if (any) keep.add(id);
    return any;
  };
  mark(state.rootId);
  const encode = (id: string): string => {
    const node = state.topics.get(id)!;
    const children = node.children
      .filter((child) => keep.has(child))
      .map(encode)
      .sort(compareStrings);
    return `(${[...node.items].sort(compareStrings).join(",")}|${children.join("")})`;
  };
  return sha256(encode(state.rootId));
}

// ---------------------------------------------------------------------------
// Comparison with a fresh build

function shapeOf(
  state: TopicTreeState,
  config: TopicTreeConfig,
  rows: readonly number[]
): ShapeSummary {
  const keys = rows.map(rowItemKey);
  const root = state.topics.get(state.rootId)!;
  return summarizeShape(shapeReport(state, config, { expectedItems: keys }), root.children.length);
}

export function compareWithFreshBuild(
  document: ExportDocument,
  dataset: ReplayDataset,
  config: TopicTreeConfig,
  seed: number
): { comparison: FreshComparison; app: ExportState; freshTruth: TruthSummary | null } {
  const app = stateFromExport(document, dataset);
  const allRows = Array.from({ length: dataset.rows.length }, (_, row) => row);
  const run = {
    dataset,
    config,
    seed,
    detect: detectCommunitiesLouvain,
    createEngine: createRealEngine
  };
  const fresh = parityRun(run);
  const common = app.placedRows;
  const keys = common.map(rowItemKey);
  const appLeaf = leafLabels(app.state, keys);
  const freshLeaf = leafLabels(fresh.state, keys);
  const laterChangeSets = Object.fromEntries(
    Object.entries(document.changeSets.byOrigin).filter(
      ([origin, total]) => origin !== "build" && origin !== "naming" && total > 0
    )
  );
  const comparison: FreshComparison = {
    rows: dataset.rows.length,
    seed,
    configHash: fresh.report.configHash,
    buildMs: round(fresh.report.timings.totalMs, 1),
    app: {
      shape: shapeOf(app.state, config, common),
      partitionHash: prunedPartitionHash(app.state)
    },
    fresh: {
      shape: shapeOf(fresh.state, config, allRows),
      partitionHash: sha256(canonicalPartition(fresh.state))
    },
    identical: false,
    unplaced: app.unplaced,
    placedOnRetired: app.placedOnRetired,
    agreement: {
      leafNmi: round(nmi(appLeaf, freshLeaf)),
      depth1Nmi: round(nmi(depthLabels(app.state, keys, 1), depthLabels(fresh.state, keys, 1))),
      depth2Nmi: round(nmi(depthLabels(app.state, keys, 2), depthLabels(fresh.state, keys, 2))),
      cutNmi: round(
        nmi(
          cutLabels(app.state, keys, fresh.state.topics.get(fresh.state.rootId)!.children.length),
          depthLabels(fresh.state, keys, 1)
        )
      )
    },
    laterChangeSets
  };
  comparison.identical =
    app.unplaced === 0 &&
    app.placedOnRetired === 0 &&
    comparison.app.partitionHash === comparison.fresh.partitionHash;
  return { comparison, app, freshTruth: fresh.report.truth };
}

// ---------------------------------------------------------------------------
// Sampled topics

function strataQuota(total: number): Record<Sample["stratum"], number> {
  const area = Math.ceil(total * 0.25);
  const level2 = Math.ceil(total * 0.35);
  return { area, level2, deep: Math.max(0, total - area - level2) };
}

/**
 * Topics for the members view, drawn with the seed: Areas (depth 1), level 2 and deeper topics,
 * each with its central members (the closest to the topic's centroid). A topic needs at least
 * `members` notes below it to be a candidate.
 */
export function sampleTopics(
  document: ExportDocument,
  state: TopicTreeState,
  dataset: Pick<ReplayDataset, "rows" | "matrix">,
  options: { seed: number; sample: number; members: number }
): Sample[] {
  const tree = exportTree(document);
  const roots = new Map(document.roots.map((root) => [root.id, root.title]));
  const eligible: Record<Sample["stratum"], string[]> = { area: [], level2: [], deep: [] };
  walkTopics(state, (node, depth) => {
    if (depth === 0 || !isLive(node) || node.stats.n < options.members) return;
    eligible[depth === 1 ? "area" : depth === 2 ? "level2" : "deep"].push(node.id);
  });
  const rng = createRng(deriveSeed(options.seed, "report-sample"));
  const quota = strataQuota(options.sample);
  const chosen: Array<{ id: string; stratum: Sample["stratum"] }> = [];
  let carry = 0;
  for (const stratum of ["area", "level2", "deep"] as const) {
    const pool = rng.shuffle([...eligible[stratum]].sort());
    const want = quota[stratum] + carry;
    const take = pool.slice(0, want);
    carry = want - take.length;
    for (const id of take) chosen.push({ id, stratum });
  }
  // A short stratum hands its quota back to the shallower ones that still have topics.
  for (const stratum of ["level2", "area", "deep"] as const) {
    if (carry <= 0) break;
    const used = new Set(chosen.map((entry) => entry.id));
    const spare = rng.shuffle(eligible[stratum].filter((id) => !used.has(id)).sort());
    for (const id of spare.slice(0, carry)) {
      chosen.push({ id, stratum });
      carry -= 1;
    }
  }
  const { dim, data } = dataset.matrix;
  return chosen.map(({ id, stratum }) => {
    const node = state.topics.get(id)!;
    const members = subtreeItems(state, id)
      .map((key) => ({ key, row: rowOfItemKey(key)! }))
      .map((entry) => {
        let dot = 0;
        for (let k = 0; k < dim; k += 1)
          dot += (data[entry.row * dim + k] as number) * (node.stats.centroid[k] as number);
        return { ...entry, cosine: dot };
      })
      .sort((a, b) => b.cosine - a.cosine || a.row - b.row)
      .slice(0, options.members);
    const exported = tree.nodes.get(id)!.topic;
    return {
      topicId: id,
      stratum,
      depth: tree.nodes.get(id)!.depth,
      title: exported.title,
      nameState: exported.nameState,
      nameSource: exported.nameSource,
      description: exported.description,
      aliases: exported.aliases,
      notes: node.stats.n,
      directItems: node.items.length,
      children: node.children.length,
      coherence: round(coherenceOf(node.stats)),
      centralCosine: round(
        members.reduce((total, member) => total + member.cosine, 0) / Math.max(1, members.length)
      ),
      members: members.map((member) => {
        const row = dataset.rows[member.row]!;
        return {
          title: row.title === "" ? "(no title)" : row.title,
          source: roots.get(row.rootSourceId) ?? null,
          cosine: round(member.cosine)
        };
      })
    };
  });
}

// ---------------------------------------------------------------------------
// Placements, gate, churn

function placementStats(document: ExportDocument, tree: ExportTree): ProfileReport["placements"] {
  const placements = document.placements;
  const primaryNotes = placements.filter((p) => p.kind === "note" && p.rank === 0);
  const margins = primaryNotes
    .filter((p) => p.decidedBy === "auto" && p.margin !== null)
    .map((p) => p.margin as number)
    .sort((a, b) => a - b);
  const bounds = [0.01, 0.02, 0.03, 0.05];
  return {
    total: placements.length,
    primaryNotes: primaryNotes.length,
    secondary: placements.filter((p) => p.rank > 0).length,
    sources: placements.filter((p) => p.kind === "source" && p.rank === 0).length,
    atRoot: primaryNotes.filter((p) => p.topicId === tree.rootId).length,
    byDecision: histogramOf(primaryNotes.map((p) => p.decidedBy)),
    needsGate: placements.filter((p) => p.rank === 0 && p.needsGate).length,
    needsSplitCheck: placements.filter((p) => p.rank === 0 && p.needsSplitCheck).length,
    needsVector: placements.filter((p) => p.rank === 0 && p.needsVector).length,
    margin: {
      n: margins.length,
      p10: quantile(margins, 0.1),
      p50: quantile(margins, 0.5),
      p90: quantile(margins, 0.9),
      below: Object.fromEntries(
        bounds.map((bound) => [
          String(bound),
          margins.length === 0
            ? 0
            : round(margins.filter((margin) => margin < bound).length / margins.length)
        ])
      )
    }
  };
}

function gateStats(document: ExportDocument, tree: ExportTree): ProfileReport["gate"] {
  const decisions = document.gateDecisions;
  const primary = new Map(
    document.placements.filter((p) => p.rank === 0).map((p) => [p.item, p.topicId])
  );
  const below = (topicId: string, ancestor: string): boolean => {
    for (let at: string | null = topicId, hops = 0; at !== null && hops < 64; hops += 1) {
      if (at === ancestor) return true;
      at = tree.nodes.get(at)?.parentId ?? null;
    }
    return false;
  };
  const accepted = decisions.filter((d) => d.chosenTopicId !== null && !d.noneOfThese);
  const checkable = accepted.filter((d) => primary.has(`${d.itemKind}:${d.itemId}`));
  const candidateCounts = decisions
    .map((d) => (Array.isArray(d.candidates) ? d.candidates.length : null))
    .filter((n): n is number => n !== null);
  return {
    decisions: decisions.length,
    accepted: accepted.length,
    none: decisions.filter((d) => d.noneOfThese).length,
    byDecider: histogramOf(decisions.map((d) => d.deciderKey)),
    candidatesMean:
      candidateCounts.length === 0
        ? null
        : round(candidateCounts.reduce((a, b) => a + b, 0) / candidateCounts.length, 2),
    stillInChosen:
      checkable.length === 0
        ? null
        : round(
            checkable.filter((d) =>
              below(primary.get(`${d.itemKind}:${d.itemId}`)!, d.chosenTopicId as string)
            ).length / checkable.length
          )
  };
}

function churnStats(
  document: ExportDocument,
  items: number
): { days: ProfileReport["churn"]["days"]; worstWeek: number | null } {
  const days = [...document.dailyMetrics]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((metric) => ({
      day: metric.day,
      opsApplied: metric.opsApplied,
      itemsMoved: metric.itemsMoved,
      primaryPathChanges: metric.primaryPathChanges,
      churn: items > 0 ? round(metric.primaryPathChanges / items) : 0,
      gateCalls: metric.gateCalls,
      namingCalls: metric.namingCalls,
      meanDepth: metric.meanDepth,
      fanoutInTarget: metric.fanoutInTarget,
      hardViolations: metric.hardViolations
    }));
  if (days.length < 7 || items === 0) return { days, worstWeek: null };
  let worst = 0;
  for (let start = 0; start + 7 <= days.length; start += 1) {
    let sum = 0;
    for (let at = start; at < start + 7; at += 1) sum += days[at]!.primaryPathChanges;
    worst = Math.max(worst, sum / items);
  }
  return { days, worstWeek: round(worst) };
}

function undoRateOf(changeSets: ExportDocument["changeSets"]): number | null {
  if (changeSets.listed >= changeSets.total) {
    const automatic = changeSets.items.filter((item) => automaticOrigins.has(item.origin));
    return automatic.length === 0
      ? null
      : round(automatic.filter((item) => item.status === "undone").length / automatic.length);
  }
  // The listing is cut: the undone change-sets over the automatic ones, from the counts.
  const automatic =
    changeSets.total - (changeSets.byOrigin.human ?? 0) - (changeSets.byOrigin.undo ?? 0);
  return automatic > 0 ? round(Math.min(1, (changeSets.byStatus.undone ?? 0) / automatic)) : null;
}

function changeSetStats(document: ExportDocument): ProfileReport["changeSets"] {
  const { changeSets } = document;
  const undoRate = undoRateOf(changeSets);
  const byDay = new Map<string, Record<string, number>>();
  for (const item of changeSets.items) {
    const day = item.createdAt.slice(0, 10);
    const row = byDay.get(day) ?? {};
    row[item.origin] = (row[item.origin] ?? 0) + 1;
    byDay.set(day, row);
  }
  return {
    total: changeSets.total,
    listed: changeSets.listed,
    byOrigin: changeSets.byOrigin as Record<string, number>,
    byStatus: changeSets.byStatus as Record<string, number>,
    undoRate,
    perDay: [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, byOrigin]) => ({
        day,
        total: Object.values(byOrigin).reduce((a, b) => a + b, 0),
        byOrigin
      }))
  };
}

// ---------------------------------------------------------------------------
// One profile

export function buildProfileReport(input: ProfileInput, options: ReportOptions): ProfileReport {
  const { document, store } = input;
  const config = TopicTreeConfigSchema.parse(document.tree.config);
  const tree = exportTree(document);
  const caveats: string[] = [];
  const audit = document.audit;
  const root = tree.nodes.get(tree.rootId)!;
  const shape = summarizeShape(audit, root.children.length);

  // E2 reads the root apart (its band is the Areas band, D12): internal topics but the root.
  const inner = [...tree.nodes.values()].filter(
    (node) => node.depth > 0 && node.children.length > 0
  );
  const inTarget = inner.filter(
    (node) =>
      node.children.length >= config.fanOut.targetMin &&
      node.children.length <= config.fanOut.targetMax
  );
  const fanOutShare = inner.length > 0 ? inTarget.length / inner.length : null;
  const retiredIds = new Set(document.topics.filter((t) => t.retiredAt !== null).map((t) => t.id));
  const placementsOnRetired = document.placements.filter((p) => retiredIds.has(p.topicId)).length;
  const itemsWithoutPrimary = audit.items - audit.reachable;
  const orphans = tree.unreachable + placementsOnRetired + itemsWithoutPrimary;

  const placements = placementStats(document, tree);
  const churn = churnStats(document, audit.items);
  const changeSets = changeSetStats(document);
  const targets: TargetCheck[] = [
    target(
      "E1",
      "Reachability",
      audit.reachability,
      { min: exitBars.reachability },
      { gating: true }
    ),
    target(
      "E1",
      "Orphans (unreachable topics, placements on retired topics, items without a primary)",
      orphans,
      { max: 0 },
      { gating: true }
    ),
    target(
      "E1",
      "Hard violations",
      audit.violations.hardCount,
      { max: exitBars.hardViolations },
      {
        gating: true,
        ...(audit.violations.awaitingApproval > 0
          ? { note: `${audit.violations.awaitingApproval} more await approval (protected nodes)` }
          : {})
      }
    ),
    target(
      "E2",
      "Mean depth of an item (root = 0)",
      audit.itemDepth.count > 0 ? audit.itemDepth.mean : null,
      { max: exitBars.meanDepthMax },
      { gating: true }
    ),
    target(
      "E2",
      "Internal topics with 4-9 children (root apart)",
      fanOutShare,
      { min: exitBars.fanOutInTargetMin },
      {
        gating: true,
        note: `${inner.length} internal topics besides the root; the root has ${root.children.length} children (the Areas band)`
      }
    ),
    target(
      "E3",
      "Worst seven-day primary-path churn (daily metrics, share of the items)",
      churn.worstWeek,
      { max: exitBars.weeklyChurnMax },
      {
        gating: false,
        note:
          churn.worstWeek === null
            ? `${churn.days.length} days of daily metrics: seven are needed. The E3 protocol is the weekly replay (topics:replay)`
            : "approximate: E3 proper is the weekly replay; this reads the app's own daily metrics"
      }
    ),
    target(
      "D27",
      "Unsorted share (root items and items waiting at an ancestor)",
      audit.items >= exitBars.unsortedMinItems ? audit.unsortedShare : null,
      { max: exitBars.unsortedMax },
      {
        gating: false,
        note:
          audit.items >= exitBars.unsortedMinItems
            ? `${audit.needsVectorItems} roots wait for a vector (apart from the share)`
            : `needs ${exitBars.unsortedMinItems} items`
      }
    ),
    target(
      "E5",
      "Undone share of automatic change-sets",
      changeSets.undoRate,
      { max: exitBars.undoRateMax },
      { gating: false }
    )
  ];

  const naming = {
    topics: tree.nodes.size - 1,
    named: 0,
    provisional: 0,
    unnamed: 0,
    bySource: {} as Record<string, number>,
    byLanguage: {} as Record<string, number>
  };
  for (const node of tree.nodes.values()) {
    if (node.depth === 0) continue;
    const topic = node.topic;
    if (topic.nameState === "named") naming.named += 1;
    else if (topic.nameState === "provisional") naming.provisional += 1;
    else naming.unnamed += 1;
    if (topic.nameSource)
      naming.bySource[topic.nameSource] = (naming.bySource[topic.nameSource] ?? 0) + 1;
    if (topic.nameLanguage)
      naming.byLanguage[topic.nameLanguage] = (naming.byLanguage[topic.nameLanguage] ?? 0) + 1;
  }

  const levelCounts = new Map<number, { topics: number; notes: number; unnamed: number }>();
  for (const node of tree.nodes.values()) {
    const level = levelCounts.get(node.depth) ?? { topics: 0, notes: 0, unnamed: 0 };
    level.topics += 1;
    if (node.depth > 0 && node.topic.nameState === "unnamed") level.unnamed += 1;
    levelCounts.set(node.depth, level);
  }
  for (const placement of document.placements) {
    if (placement.kind !== "note" || placement.rank !== 0) continue;
    const depth = tree.nodes.get(placement.topicId)?.depth;
    if (depth !== undefined && depth >= 0) levelCounts.get(depth)!.notes += 1;
  }

  let fresh: FreshComparison | null = null;
  let samples: Sample[] = [];
  let truth: ProfileReport["truth"] = null;
  if (store === null) {
    caveats.push(
      "Exported without vectors (--no-vectors): no sampled members, no comparison with a fresh build."
    );
  } else {
    if (
      document.vectors?.spaceKey !== undefined &&
      store.meta.spaceKey !== undefined &&
      store.meta.spaceKey !== document.vectors.spaceKey
    )
      throw new Error(
        `The replay store of ${document.name} is in another embedding space than its export`
      );
    const order = contentKeyOrder(store);
    const labelled = withTruth(store, document, input.truth ?? null);
    truth = labelled.truth;
    const dataset = subsetDataset(
      createReplayDataset(document.name, labelled.store, { twins: false }),
      order
    );
    const appTruth = (state: TopicTreeState, rows: readonly number[]) =>
      truthSummary(state, dataset, rows);
    if (options.fresh) {
      const compared = compareWithFreshBuild(document, dataset, config, document.tree.seed);
      fresh = compared.comparison;
      samples = sampleTopics(document, compared.app.state, dataset, options);
      if (truth) {
        truth.app = appTruth(compared.app.state, compared.app.placedRows);
        truth.fresh = compared.freshTruth;
      }
    } else {
      const app = stateFromExport(document, dataset);
      samples = sampleTopics(document, app.state, dataset, options);
      if (truth) truth.app = appTruth(app.state, app.placedRows);
      caveats.push("The comparison with a fresh build was skipped (--no-fresh).");
    }
    if (document.vectors && document.vectors.notesWithoutVector > 0)
      caveats.push(
        `${document.vectors.notesWithoutVector} notes have no vector yet: they are in the audit above and left out of the samples and the comparison.`
      );
  }
  if (fresh !== null && !fresh.identical && Object.keys(fresh.laterChangeSets).length === 0)
    caveats.push(
      "The tree has only the build change-set yet differs from the fresh build: check that the app's build uses the same seed, configuration and content-key order."
    );

  return {
    name: document.name,
    label: document.label,
    exportedAt: document.createdAt,
    tree: {
      id: document.tree.id,
      generation: document.tree.generation,
      status: document.tree.status,
      spaceKey: document.tree.space.spaceKey,
      model: document.tree.space.model,
      runtime: document.tree.space.runtime,
      dimensions: document.tree.space.dimensions,
      configHash: document.tree.configHash,
      seed: document.tree.seed,
      activatedAt: document.tree.activatedAt
    },
    library: {
      notes: document.library.notes,
      rootSources: document.library.rootSources,
      vectorRows: document.vectors?.rows ?? null,
      notesWithoutVector: document.vectors?.notesWithoutVector ?? null
    },
    targets,
    shape,
    fanOutHistogram: audit.fanOut.histogram,
    leafSizeHistogram: audit.leafSize.histogram,
    levels: [...levelCounts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([depth, level]) => ({ depth, ...level })),
    naming,
    placements,
    gate: gateStats(document, tree),
    changeSets,
    churn,
    samples,
    fresh,
    truth,
    legacy: input.legacy ?? null,
    caveats
  };
}

/**
 * Ground-truth labels (domain per root article) joined by (language, root title). The join is
 * used when it reaches at least 90% of the notes; the store's rows are copied with their domain.
 */
function withTruth(
  store: ReplayStore,
  document: ExportDocument,
  source: TruthSource | null
): { store: ReplayStore; truth: ProfileReport["truth"] } {
  if (source === null) return { store, truth: null };
  const titles = new Map(document.roots.map((root) => [root.id, root.title]));
  let matched = 0;
  const rows = store.rows.map((row) => {
    const title = titles.get(row.rootSourceId);
    const domain = title === undefined ? undefined : source.domainOf(row.lang, title);
    if (domain !== undefined) matched += 1;
    return domain === undefined ? row : { ...row, domain };
  });
  const coverage = store.rows.length === 0 ? 0 : matched / store.rows.length;
  if (coverage < 0.9) return { store, truth: null };
  return {
    store: { ...store, rows },
    truth: { source: source.name, coverage: round(coverage), app: null, fresh: null }
  };
}

// ---------------------------------------------------------------------------
// The comparison document

export function buildComparison(
  profiles: readonly ProfileReport[],
  now: () => Date = () => new Date()
): ComparisonDocument {
  return ComparisonDocumentSchema.parse({
    schema: compareSchemaVersion,
    createdAt: now().toISOString(),
    profiles
  });
}

/** Failed gating checks over all profiles: `<profile>: <check>`. */
export function gatingFailures(profiles: readonly ProfileReport[]): string[] {
  return profiles.flatMap((profile) =>
    profile.targets
      .filter((check) => check.gating && check.status === "fail")
      .map((check) => `${profile.name}: ${check.id} ${check.name}`)
  );
}
