// The topic tree audit of a stored tree (F2 T17): the E1 figures (reachability, orphans, hard
// violations), the E2 shape readings, the Unsorted share (D27) and the undo rate of automatic
// change-sets (plan section 8). Pure: `audit-db.ts` reads the rows and this module judges them.
//
// The judging is the engine's own, so a stored tree and a replayed one are held to the same
// definitions: the invariant checks and the shape report of `@app/domain/topic-tree` run on an
// in-memory state built from the rows. The audit must also describe damaged data, which the
// engine's state refuses to hold (a live topic below a retired one, a placement on a retired
// topic). Those rows are classified first, counted as orphans and left out of the state; the
// items they carry are then not reported a second time as unplaced.
//
// Statistics and vectors are not read here, so the coherence invariant (I8) and the exact
// statistics recompute (D7) belong to the service's audit, not to this one.
import {
  checkInvariants,
  compareStrings,
  createTopicTreeState,
  distribution,
  insertPlacement,
  insertTopic,
  parseItemKey,
  placementRecord,
  primaryPlacement,
  registerItem,
  shapeReport,
  topicRecord,
  walkTopics
} from "@app/domain/topic-tree";
import type {
  InvariantViolation,
  ItemKey,
  TopicNode,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";
import type { TopicManagement, TopicPlacementManagement, TopicTreeStatus } from "@app/domain";

export const auditSchemaId = "topics-audit/v1";

/** Plan section 8 KPI values. The audit reports against them and never fails on them. */
export const auditTargets = {
  /** Item-weighted mean depth, root = 0 (E2). */
  meanDepth: 4.5,
  /** Share of internal non-root topics with target-band fan-out (E2). */
  fanOutInTarget: 0.8,
  /** Undone share of automatic change-sets (plan section 8). */
  undoRate: 0.05
} as const;

export const defaultUndoWindowDays = 7;
export const defaultListLimit = 100;

export class TopicAuditError extends Error {
  override readonly name = "TopicAuditError";
}

// ---------------------------------------------------------------------------
// Input: what the rows say

export interface AuditTopic {
  id: string;
  parentId: string | null;
  role: "root" | "topic";
  title: string | null;
  management: TopicManagement;
  position: number;
  /** ISO timestamp; null for a live topic. */
  retiredAt: string | null;
  redirectTo: string | null;
}

export interface AuditPlacement {
  item: ItemKey;
  topicId: string;
  rank: number;
  management: TopicPlacementManagement;
  needsGate: boolean;
  needsSplitCheck: boolean;
  needsVector: boolean;
}

/** Automatic change-sets applied inside the window, and how many of them were undone. */
export interface UndoWindow {
  days: number;
  automatic: number;
  undone: number;
}

export interface AuditInput {
  tree: {
    id: string;
    status: TopicTreeStatus;
    generation: number;
    /** The rows were read at one tree generation. */
    consistent: boolean;
  };
  config: TopicTreeConfig;
  topics: readonly AuditTopic[];
  placements: readonly AuditPlacement[];
  /** Current notes and root sources: every one must be reachable (I1). */
  expectedItems: readonly ItemKey[];
  /** The tree has Areas, so the root's fan-out band is the Areas band (D12). */
  areasActive: boolean;
  undo: UndoWindow;
}

// ---------------------------------------------------------------------------
// Output

/** Aggregates only: safe to put in the KPI report. */
export interface TopicAuditSummary {
  tree: {
    status: TopicTreeStatus;
    generation: number;
    consistent: boolean;
    areasActive: boolean;
  };
  topics: {
    /** Live topics reachable from the root, the root included. */
    live: number;
    retired: number;
    /** Live topics with children, the root included. */
    internal: number;
    /** Live non-root topics without children. */
    leaves: number;
    maxDepth: number;
  };
  items: {
    expected: number;
    notes: number;
    sources: number;
    /** Expected items with a primary placement on a live topic reachable from the root. */
    reachable: number;
    reachability: number | null;
    /** Placed primary items that are no longer expected (archived, rejected, superseded). */
    placedNotCurrent: number;
  };
  orphans: {
    unreachableTopics: number;
    placementsOnRetiredTopics: number;
    /** Placements on a live topic the root does not reach, or on a topic of another tree. */
    placementsOnUnreachableTopics: number;
    /** Expected items with no primary placement row at all. */
    itemsWithoutPrimary: number;
  };
  violations: {
    /** Hard violations on AI-managed nodes (the E1 count). */
    hard: number;
    soft: number;
    /** Violations on protected nodes: listed for approval, never counted above. */
    awaitingApproval: number;
    byReason: ViolationCount[];
  };
  shape: {
    /** Item-weighted depth of the primary topic of expected items, root = 0. */
    itemDepth: DistributionSummary | null;
    /** Children per internal non-root topic (the root is apart, D12). */
    fanOut: (DistributionSummary & { inTarget: number; inRange: number }) | null;
    rootFanOut: number;
    rootInBand: boolean;
    /** Direct items per leaf. */
    leafSize: (DistributionSummary & { inRange: number }) | null;
    singleChildTopics: number;
  };
  unsorted: {
    /** Direct items of the root. */
    rootItems: number;
    /** Items waiting for the gate or a split check at an internal topic below the root. */
    waitingAtAncestor: number;
    share: number | null;
    shareTarget: number;
    minItems: number;
    /** Null below `minItems`, where the target does not apply. */
    meetsTarget: boolean | null;
  };
  /** Waiting for a vector, apart from the Unsorted share (D27). */
  needsVector: { notes: number; sources: number };
  undo: {
    windowDays: number;
    automatic: number;
    undone: number;
    rate: number | null;
    target: number;
    meetsTarget: boolean | null;
  };
  /** Reported against the plan's E2 bars; never gating. */
  e2: {
    meanDepthWithin: boolean | null;
    fanOutInTargetWithin: boolean | null;
    noSingleChild: boolean;
  };
  /** E1: reachability 100%, 0 orphans, 0 hard violations. */
  e1: { passes: boolean; failures: string[] };
}

export interface DistributionSummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface ViolationCount {
  code: string;
  severity: "hard" | "soft";
  reason: string;
  awaitingApproval: boolean;
  count: number;
}

export interface Listed<T> {
  total: number;
  shown: T[];
}

export interface PlacementRef {
  item: ItemKey;
  topicId: string;
  rank: number;
}

export interface AuditViolation {
  code: string;
  severity: "hard" | "soft";
  reason: string;
  topicId: string | null;
  item: ItemKey | null;
  awaitingApproval: boolean;
  value: number | null;
}

/** Identifiers to locate a problem. Never part of the KPI report. */
export interface TopicAuditDetails {
  treeId: string;
  unreachableTopics: Listed<string>;
  placementsOnRetiredTopics: Listed<PlacementRef>;
  placementsOnUnreachableTopics: Listed<PlacementRef>;
  itemsWithoutPrimary: Listed<ItemKey>;
  placedNotCurrent: Listed<ItemKey>;
  violations: Listed<AuditViolation>;
}

export interface TopicAuditReport {
  schema: typeof auditSchemaId;
  generatedAt: string;
  summary: TopicAuditSummary;
  details: TopicAuditDetails;
}

export interface AnalyzeOptions {
  /** Entries listed per detail list (default 100). The totals are always exact. */
  limit?: number;
  /** Clock of `generatedAt`. */
  now?: () => string;
}

// ---------------------------------------------------------------------------
// Analysis

const byId = (a: { id: string }, b: { id: string }): number => compareStrings(a.id, b.id);

function listed<T>(all: readonly T[], limit: number): Listed<T> {
  return { total: all.length, shown: all.slice(0, limit) };
}

function summarizeDistribution(values: readonly number[]): DistributionSummary | null {
  if (values.length === 0) return null;
  const d = distribution(values);
  return { count: d.count, mean: d.mean, p50: d.p50, p95: d.p95, max: d.max };
}

const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

function inBand(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

/** Splits the stored rows into the part the engine can hold and the orphans around it. */
function buildState(input: AuditInput) {
  const topicsById = new Map(input.topics.map((topic) => [topic.id, topic]));
  const liveRoots = input.topics
    .filter((topic) => topic.role === "root" && topic.retiredAt === null)
    .sort(byId);
  const root = liveRoots[0];
  if (!root) throw new TopicAuditError("The tree has no live root topic.");

  const liveChildren = new Map<string, AuditTopic[]>();
  for (const topic of input.topics) {
    if (topic.retiredAt !== null || topic.parentId === null || topic.role === "root") continue;
    const list = liveChildren.get(topic.parentId) ?? [];
    list.push(topic);
    liveChildren.set(topic.parentId, list);
  }

  const state = createTopicTreeState({
    dim: 1,
    rootId: root.id,
    root: { management: root.management, position: root.position }
  });
  const attached = new Set<string>([root.id]);
  const queue = [root.id];
  for (let index = 0; index < queue.length; index += 1) {
    const children = (liveChildren.get(queue[index] as string) ?? []).sort(byId);
    for (const child of children) {
      if (attached.has(child.id)) continue;
      attached.add(child.id);
      queue.push(child.id);
      insertTopic(
        state,
        topicRecord(child.id, child.parentId, {
          role: "topic",
          title: child.title,
          nameState: child.title === null ? "unnamed" : "named",
          management: child.management,
          position: child.position
        })
      );
    }
  }

  // Retired topics stay in the state (I9 redirects) when their parent is in it.
  let pending = input.topics.filter((topic) => topic.retiredAt !== null).sort(byId);
  for (let progressed = true; progressed && pending.length > 0;) {
    progressed = false;
    const rest: AuditTopic[] = [];
    for (const topic of pending) {
      if (topic.parentId !== null && state.topics.has(topic.parentId)) {
        insertTopic(
          state,
          topicRecord(topic.id, topic.parentId, {
            role: "topic",
            title: topic.title,
            nameState: topic.title === null ? "unnamed" : "named",
            management: topic.management,
            position: topic.position,
            retiredAt: topic.retiredAt,
            redirectTo: topic.redirectTo
          })
        );
        progressed = true;
      } else rest.push(topic);
    }
    pending = rest;
  }

  const unreachableTopics = input.topics
    .filter((topic) => topic.retiredAt === null && !attached.has(topic.id))
    .map((topic) => topic.id)
    .sort(compareStrings);
  return { state, topicsById, attached, unreachableTopics };
}

interface PlacementSplit {
  onRetired: PlacementRef[];
  onUnreachable: PlacementRef[];
  rejected: AuditViolation[];
  /** Expected items whose primary row sits on a retired or unreachable topic. */
  orphanedPrimaries: Set<ItemKey>;
  primaryRows: Set<ItemKey>;
}

function placeRows(
  input: AuditInput,
  built: ReturnType<typeof buildState>,
  split: PlacementSplit
): void {
  const { state, topicsById, attached } = built;
  const ordered = [...input.placements].sort(
    (a, b) => compareStrings(a.item, b.item) || a.rank - b.rank
  );
  for (const row of ordered) {
    const ref: PlacementRef = { item: row.item, topicId: row.topicId, rank: row.rank };
    if (row.rank === 0) split.primaryRows.add(row.item);
    const topic = topicsById.get(row.topicId);
    if (topic !== undefined && topic.retiredAt !== null) {
      split.onRetired.push(ref);
      if (row.rank === 0) split.orphanedPrimaries.add(row.item);
      continue;
    }
    if (topic === undefined || !attached.has(topic.id)) {
      split.onUnreachable.push(ref);
      if (row.rank === 0) split.orphanedPrimaries.add(row.item);
      continue;
    }
    const parsed = parseItemKey(row.item);
    if (!parsed) throw new TopicAuditError(`Invalid item key ${row.item}.`);
    if (!state.items.has(row.item)) {
      registerItem(state, {
        key: row.item,
        kind: parsed.kind,
        contentHash: row.item,
        rootSource: null
      });
    }
    try {
      insertPlacement(
        state,
        row.item,
        placementRecord(row.topicId, {
          rank: row.rank,
          management: row.management,
          needsGate: row.needsGate,
          needsSplitCheck: row.needsSplitCheck,
          needsVector: row.needsVector
        })
      );
    } catch {
      split.rejected.push({
        code: "I2",
        severity: "hard",
        reason: "placement-rejected",
        topicId: row.topicId,
        item: row.item,
        awaitingApproval: false,
        value: row.rank
      });
    }
  }
}

interface UnsortedCounts {
  rootItems: number;
  waitingAtAncestor: number;
  needsVectorNotes: number;
  needsVectorSources: number;
}

/** D27: the root's direct items and items waiting at an internal topic; needs_vector apart. */
function countUnsorted(state: TopicTreeState, expected: ReadonlySet<ItemKey>): UnsortedCounts {
  const counts: UnsortedCounts = {
    rootItems: 0,
    waitingAtAncestor: 0,
    needsVectorNotes: 0,
    needsVectorSources: 0
  };
  walkTopics(state, (node: TopicNode) => {
    for (const item of node.items) {
      if (!expected.has(item)) continue;
      const placement = primaryPlacement(state, item);
      if (placement?.needsVector) {
        if (item.startsWith("note:")) counts.needsVectorNotes += 1;
        else counts.needsVectorSources += 1;
      } else if (node.id === state.rootId) counts.rootItems += 1;
      else if (node.children.length > 0 && (placement?.needsGate || placement?.needsSplitCheck)) {
        counts.waitingAtAncestor += 1;
      }
    }
  });
  return counts;
}

function violationRows(violations: readonly InvariantViolation[]): AuditViolation[] {
  return violations.map((violation) => ({
    code: violation.code,
    severity: violation.severity,
    reason: violation.reason,
    topicId: violation.topicId,
    item: violation.item,
    awaitingApproval: violation.awaitingApproval,
    value: violation.value
  }));
}

const severityRank = { hard: 0, soft: 1 } as const;

function compareViolations(a: AuditViolation, b: AuditViolation): number {
  return (
    Number(a.awaitingApproval) - Number(b.awaitingApproval) ||
    severityRank[a.severity] - severityRank[b.severity] ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.reason, b.reason) ||
    compareStrings(a.topicId ?? "", b.topicId ?? "") ||
    compareStrings(a.item ?? "", b.item ?? "")
  );
}

function countByReason(violations: readonly AuditViolation[]): ViolationCount[] {
  const counts = new Map<string, ViolationCount>();
  for (const violation of violations) {
    const key = `${violation.code}|${violation.severity}|${violation.reason}|${violation.awaitingApproval}`;
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else {
      counts.set(key, {
        code: violation.code,
        severity: violation.severity,
        reason: violation.reason,
        awaitingApproval: violation.awaitingApproval,
        count: 1
      });
    }
  }
  return [...counts.values()].sort(
    (a, b) =>
      Number(a.awaitingApproval) - Number(b.awaitingApproval) ||
      severityRank[a.severity] - severityRank[b.severity] ||
      compareStrings(a.code, b.code) ||
      compareStrings(a.reason, b.reason)
  );
}

export function analyzeTopicTree(
  input: AuditInput,
  options: AnalyzeOptions = {}
): TopicAuditReport {
  const limit = options.limit ?? defaultListLimit;
  const { config } = input;
  const built = buildState(input);
  const { state } = built;

  const split: PlacementSplit = {
    onRetired: [],
    onUnreachable: [],
    rejected: [],
    orphanedPrimaries: new Set(),
    primaryRows: new Set()
  };
  placeRows(input, built, split);

  const expected = new Set(input.expectedItems);
  // Items on a bad topic are counted as orphan placements; the engine would call them unplaced.
  const engineExpected = [...expected].filter((item) => !split.orphanedPrimaries.has(item));
  const engineOptions = { expectedItems: engineExpected, areasActive: input.areasActive };
  const invariants = checkInvariants(state, config, engineOptions);
  const shape = shapeReport(state, config, engineOptions);

  // The rows the state could not hold are hard I1 violations too, so every E1 failure is listed.
  const protectedTopic = (id: string): boolean => {
    const management = built.topicsById.get(id)?.management;
    return management !== undefined && management !== "ai";
  };
  const orphanViolation = (reason: string, id: string, item: ItemKey | null, rank: number | null) =>
    ({
      code: "I1",
      severity: "hard",
      reason,
      topicId: id,
      item,
      awaitingApproval: protectedTopic(id),
      value: rank
    }) satisfies AuditViolation;
  const orphanViolations: AuditViolation[] = [
    ...built.unreachableTopics.map((id) => orphanViolation("topic-unreachable", id, null, null)),
    ...split.onRetired.map((ref) =>
      orphanViolation("placement-on-retired-topic", ref.topicId, ref.item, ref.rank)
    ),
    ...split.onUnreachable.map((ref) =>
      orphanViolation("placement-on-unreachable-topic", ref.topicId, ref.item, ref.rank)
    )
  ];
  const all = [
    ...violationRows(invariants.violations),
    ...split.rejected,
    ...orphanViolations
  ].sort(compareViolations);
  const hard = all.filter((v) => !v.awaitingApproval && v.severity === "hard").length;
  const soft = all.filter((v) => !v.awaitingApproval && v.severity === "soft").length;
  const awaitingApproval = all.filter((v) => v.awaitingApproval).length;

  const itemsWithoutPrimary = [...expected]
    .filter((item) => !split.primaryRows.has(item))
    .sort(compareStrings);
  const placedNotCurrent = [...state.items.keys()]
    .filter((item) => !expected.has(item) && primaryPlacement(state, item) !== undefined)
    .sort(compareStrings);
  const unreachableTopics = built.unreachableTopics;

  const depths: number[] = [];
  const fanOuts: number[] = [];
  const leafSizes: number[] = [];
  let internal = 0;
  let leaves = 0;
  let maxDepth = 0;
  let live = 0;
  walkTopics(state, (node, depth) => {
    live += 1;
    maxDepth = Math.max(maxDepth, depth);
    for (const item of node.items) if (expected.has(item)) depths.push(depth);
    if (node.children.length > 0) {
      internal += 1;
      if (node.id !== state.rootId) fanOuts.push(node.children.length);
    } else if (node.id !== state.rootId) {
      leaves += 1;
      leafSizes.push(node.items.length);
    }
  });
  const root = state.topics.get(state.rootId) as TopicNode;
  const rootBand: [number, number] = input.areasActive
    ? [config.areas.min, config.areas.max]
    : [config.fanOut.min, config.fanOut.max];

  const unsortedCounts = countUnsorted(state, expected);
  const expectedCount = expected.size;
  const unsortedShare =
    expectedCount > 0
      ? Math.min(1, (unsortedCounts.rootItems + unsortedCounts.waitingAtAncestor) / expectedCount)
      : null;
  const reachable = shape.reachable;
  const reachability = expectedCount > 0 ? reachable / expectedCount : null;

  const itemDepth = summarizeDistribution(depths);
  const fanOutBase = summarizeDistribution(fanOuts);
  const fanOutInTarget =
    fanOuts.length > 0
      ? fanOuts.filter((n) => inBand(n, config.fanOut.targetMin, config.fanOut.targetMax)).length /
        fanOuts.length
      : null;
  const undoRate = share(input.undo.undone, input.undo.automatic);

  const orphans = {
    unreachableTopics: unreachableTopics.length,
    placementsOnRetiredTopics: split.onRetired.length,
    placementsOnUnreachableTopics: split.onUnreachable.length,
    itemsWithoutPrimary: itemsWithoutPrimary.length
  };
  const failures = [
    ...(reachability !== null && reachability < 1 ? ["reachability"] : []),
    ...Object.entries(orphans)
      .filter(([, count]) => count > 0)
      .map(([name]) => name),
    ...(hard > 0 ? ["hardViolations"] : [])
  ];

  const summary: TopicAuditSummary = {
    tree: {
      status: input.tree.status,
      generation: input.tree.generation,
      consistent: input.tree.consistent,
      areasActive: input.areasActive
    },
    topics: {
      live,
      retired: input.topics.filter((topic) => topic.retiredAt !== null).length,
      internal,
      leaves,
      maxDepth
    },
    items: {
      expected: expectedCount,
      notes: [...expected].filter((item) => item.startsWith("note:")).length,
      sources: [...expected].filter((item) => item.startsWith("source:")).length,
      reachable,
      reachability,
      placedNotCurrent: placedNotCurrent.length
    },
    orphans,
    violations: { hard, soft, awaitingApproval, byReason: countByReason(all) },
    shape: {
      itemDepth,
      fanOut:
        fanOutBase === null
          ? null
          : {
              ...fanOutBase,
              inTarget: fanOutInTarget ?? 0,
              inRange:
                fanOuts.filter((n) => inBand(n, config.fanOut.min, config.fanOut.max)).length /
                fanOuts.length
            },
      rootFanOut: root.children.length,
      rootInBand:
        root.children.length === 0 || inBand(root.children.length, rootBand[0], rootBand[1]),
      leafSize:
        leafSizes.length === 0
          ? null
          : {
              ...(summarizeDistribution(leafSizes) as DistributionSummary),
              inRange:
                leafSizes.filter((n) => inBand(n, config.leaf.min, config.leaf.max)).length /
                leafSizes.length
            },
      singleChildTopics: shape.singleChildTopics
    },
    unsorted: {
      rootItems: unsortedCounts.rootItems,
      waitingAtAncestor: unsortedCounts.waitingAtAncestor,
      share: unsortedShare,
      shareTarget: config.unsorted.shareTarget,
      minItems: config.unsorted.minItems,
      meetsTarget:
        unsortedShare === null || expectedCount < config.unsorted.minItems
          ? null
          : unsortedShare <= config.unsorted.shareTarget
    },
    needsVector: {
      notes: unsortedCounts.needsVectorNotes,
      sources: unsortedCounts.needsVectorSources
    },
    undo: {
      windowDays: input.undo.days,
      automatic: input.undo.automatic,
      undone: input.undo.undone,
      rate: undoRate,
      target: auditTargets.undoRate,
      meetsTarget: undoRate === null ? null : undoRate <= auditTargets.undoRate
    },
    e2: {
      meanDepthWithin: itemDepth === null ? null : itemDepth.mean <= auditTargets.meanDepth,
      fanOutInTargetWithin:
        fanOutInTarget === null ? null : fanOutInTarget >= auditTargets.fanOutInTarget,
      noSingleChild: shape.singleChildTopics === 0
    },
    e1: { passes: failures.length === 0, failures }
  };

  return {
    schema: auditSchemaId,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    summary,
    details: {
      treeId: input.tree.id,
      unreachableTopics: listed(unreachableTopics, limit),
      placementsOnRetiredTopics: listed(split.onRetired, limit),
      placementsOnUnreachableTopics: listed(split.onUnreachable, limit),
      itemsWithoutPrimary: listed(itemsWithoutPrimary, limit),
      placedNotCurrent: listed(placedNotCurrent, limit),
      violations: listed(all, limit)
    }
  };
}
