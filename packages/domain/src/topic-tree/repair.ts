// REBALANCE (plan 4.1 "Operations" and "Stability", 4.3): checks topics, tries the operations
// their conditions call for, and applies the ones the policy accepts:
//
// - Hard violations first (a leaf above leaf.hardMax, fan-out above fanOut.hardMax, depth beyond
//   depth.cap, secondaries that break I2): fixed without the acceptance test and regardless of
//   cooldown, freeze and budgets; among the operations that fix one, the least churn wins.
// - Soft conditions (quality.ts) only when dQ - lambda * churn > 0, the topic is out of its
//   cooldown, nothing the operation touches is frozen, and the day's operation and move budgets
//   (and repair.softMoveShare per operation) hold. `force` lifts cooldown, freeze and budgets,
//   never acceptance or protection. The mis-parent correction (D12) weighs its churn once
//   instead of lambda times (churnWeightOf).
// - No operation may add a hard violation, and an operation that touches protected structure
//   (human or pinned topics, human placements) or, once Areas exist and were grouped
//   (`areaLevelReview`), the Area level (D12) comes back as a proposal (`pending_review`) instead
//   of being applied.
//
// Every candidate runs as a trial on the live state through a recording editor, is measured (Q on
// the smallest scope that contains it, churn from its events, hard violations in the scope) and
// rolled back by its exact inverse; the chosen one is re-applied from its recorded events, so the
// result is exactly the logged change-set. Order is by depth (deepest first), then content
// anchor (D22), so fresh UUIDs replay to the same tree.
import {
  collapseChain,
  contentAnchor,
  liftIntoParent,
  liftThinNode,
  splitInternal,
  splitLeaf
} from "./build.js";
import type { ShapeContext, ShapeOperation } from "./build.js";
import { reparentTarget } from "./audit.js";
import type { TopicTreeConfig } from "./config.js";
import {
  StructureEventConflictError,
  applyEvents,
  createTopicTreeEditor,
  invertEvents
} from "./events.js";
import type { StructureEvent, TopicTreeEditor } from "./events.js";
import { compareStrings, normalizeTopicTitle } from "./ids.js";
import type { ItemKey } from "./ids.js";
import {
  absorbMovableItems,
  dropInvalidSecondaries,
  eventsAreAreaLevel,
  eventsTouchFrozen,
  eventsTouchProtected,
  mergeSiblingLeaves,
  mergeUndersizedLeaf,
  pushDownAround,
  refreshTopics,
  reparentTopic,
  splitLeafDownward
} from "./operations.js";
import type { TopicOperation, TopicOperationKind } from "./operations.js";
import {
  areDuplicateLeaves,
  fanOutBand,
  movableDirectItems,
  netGain,
  subtreeQuality
} from "./quality.js";
import type { QualityOptions } from "./quality.js";
import {
  consumeDailyBudget,
  dailyBudget,
  eventChurn,
  eventsTopics,
  isCoolingDown,
  placedItemCount
} from "./stability.js";
import type { EventChurn } from "./stability.js";
import {
  TopicTreeStateError,
  depthOf,
  getTopic,
  heightOf,
  isLive,
  isProtected,
  pathOf,
  placementsOf
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import type { ItemVectorSource } from "./vectors.js";

export type RebalanceTrigger = "hard" | "soft";

export const rebalanceConditions = [
  // hard
  "leaf-above-hard-max",
  "fan-out-above-hard-max",
  "depth-above-cap",
  "invalid-secondary",
  // soft
  "leaf-above-max",
  "leaf-below-min",
  "single-child",
  "fan-out-above-max",
  "direct-items",
  "duplicate-siblings",
  "mis-parented",
  "deep-thin-topic"
] as const;
export type RebalanceCondition = (typeof rebalanceConditions)[number];

export type RebalanceSkipReason =
  | "cooldown"
  | "frozen"
  | "budget"
  | "rejected"
  | "hard-invariant"
  | "no-fix"
  | "conflict"
  | "no-change";

export interface RebalanceInput {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  config: TopicTreeConfig;
  seed: number;
  /** Timestamp of retirements and "moved from" hints. */
  now: string;
  /** Local day (YYYY-MM-DD) of `now` for the daily budgets (stability.ts localDay). */
  day: string;
  /** IDs for new topics (UUIDs in the product). */
  newTopicId: () => string;
  /** Topics to check (dirty topics); default: every live topic (a settle). */
  topics?: Iterable<string>;
  /** Items opened recently: their churn counts stability.recentChurnWeight times. */
  recentItems?: ReadonlySet<ItemKey>;
  /** The root's band is the Areas band and Area-level operations are proposals (D12). */
  areasActive?: boolean;
  /**
   * With `areasActive`, whether Area-level operations are proposals (default true). False before a
   * tree's first Areas grouping and inside the grouping itself: D12 makes them proposals afterwards.
   */
  areaLevelReview?: boolean;
  /** Re-placement below an internal topic (PLACE, T07); without it direct items only form leaves. */
  readmit?: (item: ItemKey, from: string) => string | null;
  /** Ignore cooldowns, freeze and budgets (explicit settles). Acceptance and protection hold. */
  force?: boolean;
  /** Only fix hard violations. */
  hardOnly?: boolean;
  /** Check only these conditions (default: all of them). */
  conditions?: ReadonlySet<RebalanceCondition>;
  /** Upper bound on trials (default max(256, 8 x live topics)). */
  maxTrials?: number;
}

interface Candidate {
  kind: TopicOperationKind;
  topicId: string;
  trigger: RebalanceTrigger;
  condition: RebalanceCondition;
  /** Levels above `topicId` whose subtree contains every change (quality.ts scope rule). */
  scopeLevels: number;
  run: (context: ShapeContext) => TopicOperation | ShapeOperation | null;
}

export interface RebalanceMeasure {
  kind: TopicOperationKind;
  topicId: string;
  trigger: RebalanceTrigger;
  condition: RebalanceCondition;
  events: StructureEvent[];
  created: string[];
  retired: string[];
  churn: EventChurn;
  /** dQ on the operation's scope (item units). */
  deltaQuality: number;
  /** dQ - lambda * weighted churn. */
  netGain: number;
}

export type AppliedRebalanceOperation = RebalanceMeasure;

export interface RebalanceProposal extends RebalanceMeasure {
  /** Deduplication key for the service: `<condition>:<topic>`. */
  key: string;
  reason: "protected" | "area-level";
}

export interface SkippedRebalanceCheck {
  topicId: string;
  condition: RebalanceCondition;
  kind: TopicOperationKind;
  reason: RebalanceSkipReason;
  netGain: number | null;
}

export interface RebalanceResult {
  applied: AppliedRebalanceOperation[];
  /** The applied events in order: the change-set. */
  events: StructureEvent[];
  proposals: RebalanceProposal[];
  skipped: SkippedRebalanceCheck[];
  /** Hard conditions still present on checked topics (protected ones await approval). */
  unresolvedHard: { topicId: string; condition: RebalanceCondition }[];
  /** Live topics the applied events touched (recompute and push these). */
  touchedTopics: string[];
  /** Distinct items whose primary path changed, weighted, and their share of placed items. */
  churn: { items: number; weighted: number; share: number };
  trials: number;
  /** maxTrials stopped the run before every check was done. */
  exhausted: boolean;
}

// ---------------------------------------------------------------------------
// Conditions and candidates

function ancestorAt(state: TopicTreeState, id: string, levels: number): string {
  let current = id;
  for (let level = 0; level < levels; level += 1) {
    const parent = getTopic(state, current).parentId;
    if (parent === null) break;
    current = parent;
  }
  return current;
}

interface Environment {
  input: RebalanceInput;
  quality: QualityOptions;
  /** Merge targets must be automatic: neither protected nor frozen (unless forced). */
  eligibleTarget: (topicId: string) => boolean;
}

function hardCandidates(env: Environment, id: string, depth: number): Candidate[] {
  const { state, config } = env.input;
  const node = getTopic(state, id);
  const isRoot = id === state.rootId;
  const output: Candidate[] = [];
  const add = (
    kind: TopicOperationKind,
    topicId: string,
    condition: RebalanceCondition,
    scopeLevels: number,
    run: Candidate["run"]
  ): void => {
    output.push({ kind, topicId, trigger: "hard", condition, scopeLevels, run });
  };
  if (!isRoot && node.children.length === 0 && node.items.length > config.leaf.hardMax) {
    add("leaf-split", id, "leaf-above-hard-max", 2, (context) => splitLeaf(context, id));
    add("leaf-split", id, "leaf-above-hard-max", 1, (context) => splitLeafDownward(context, id));
  }
  if (node.children.length > config.fanOut.hardMax) {
    if (!isRoot) {
      add("internal-split", id, "fan-out-above-hard-max", 2, (context) =>
        splitInternal(context, id)
      );
    }
    if (!isRoot || !env.input.areasActive) {
      add("push-down", id, "fan-out-above-hard-max", 1, (context) => pushDownAround(context, id));
    }
  }
  if (hasInvalidSecondary(state, config, id)) {
    add("secondary-cleanup", id, "invalid-secondary", depth, (context) =>
      dropInvalidSecondaries(context, id)
    );
  }
  if (depth > config.depth.cap) {
    for (const ancestor of pathOf(state, id).slice(1, -1).reverse()) {
      add("lift", ancestor, "depth-above-cap", 2, (context) => liftIntoParent(context, ancestor));
      add("lift", ancestor, "depth-above-cap", 1, (context) => liftThinNode(context, ancestor));
    }
  }
  return output;
}

function softCandidates(env: Environment, id: string, depth: number): Candidate[] {
  const { state, config } = env.input;
  const node = getTopic(state, id);
  const isRoot = id === state.rootId;
  const output: Candidate[] = [];
  const add = (
    kind: TopicOperationKind,
    condition: RebalanceCondition,
    scopeLevels: number,
    run: Candidate["run"],
    topicId = id
  ): void => {
    output.push({ kind, topicId, trigger: "soft", condition, scopeLevels, run });
  };
  if (node.children.length === 0) {
    if (isRoot) return output; // the cold start belongs to the bootstrap (T19)
    const size = node.items.length;
    if (size > config.leaf.max) {
      add("leaf-split", "leaf-above-max", 2, (context) => splitLeaf(context, id));
      add("leaf-split", "leaf-above-max", 1, (context) => splitLeafDownward(context, id));
    }
    if (size < config.leaf.min) {
      add("merge", "leaf-below-min", 2, (context) =>
        mergeUndersizedLeaf(context, id, env.eligibleTarget)
      );
    }
    for (const siblingId of getTopic(state, node.parentId as string).children) {
      if (siblingId === id || !env.eligibleTarget(siblingId)) continue;
      if (!areDuplicateLeaves(config, node, getTopic(state, siblingId))) continue;
      add("sibling-merge", "duplicate-siblings", 2, (context) =>
        mergeSiblingLeaves(context, id, siblingId)
      );
    }
  } else {
    const fanOut = node.children.length;
    if (fanOut === 1 && node.items.length === 0) {
      add("collapse", "single-child", 1, (context) => collapseChain(context, id));
    }
    if (fanOut > fanOutBand(state, config, id, env.quality).high) {
      if (!isRoot) {
        add("internal-split", "fan-out-above-max", 2, (context) => splitInternal(context, id));
        add("push-down", "fan-out-above-max", 1, (context) => pushDownAround(context, id));
      } else if (!env.input.areasActive) {
        add("push-down", "fan-out-above-max", 1, (context) => pushDownAround(context, id));
      }
    }
    if (movableDirectItems(state, node).length >= config.repair.directItemsSplitAt) {
      if (env.input.readmit) {
        add("absorb-direct", "direct-items", 1, (context) =>
          absorbMovableItems(context, id, { formLeaves: false })
        );
      }
      add("absorb-direct", "direct-items", 1, (context) =>
        absorbMovableItems(context, id, { formLeaves: true })
      );
    }
    if (
      !isRoot &&
      fanOut < config.fanOut.targetMin &&
      depth + heightOf(state, id) > config.depth.target
    ) {
      add("lift", "deep-thin-topic", 2, (context) => liftIntoParent(context, id));
      add("lift", "deep-thin-topic", 1, (context) => liftThinNode(context, id));
    }
  }
  if (depth >= 2) {
    const target = reparentTarget(state, config, id);
    if (target && env.eligibleTarget(target.uncleId)) {
      add("reparent", "mis-parented", 3, (context) => reparentTopic(context, id, target.uncleId));
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Hard violations in a scope

/** Keys of the hard violations (I2-I5, I7) within the live subtree of `scopeId`. */
export function scopeHardViolations(
  state: TopicTreeState,
  config: TopicTreeConfig,
  scopeId: string
): Set<string> {
  const output = new Set<string>();
  const visit = (id: string, depth: number, path: Set<string>): void => {
    const node = getTopic(state, id);
    const isRoot = id === state.rootId;
    if (node.children.length === 0 && !isRoot && node.items.length > config.leaf.hardMax) {
      output.add(`I4:${id}`);
    }
    if (node.children.length > config.fanOut.hardMax) output.add(`I3:${id}`);
    if (depth > config.depth.cap) output.add(`I5:${id}`);
    const titles = new Map<string, string>();
    for (const childId of node.children) {
      const title = getTopic(state, childId).title;
      if (title === null) continue;
      const key = normalizeTopicTitle(title);
      if (titles.has(key)) output.add(`I7:${childId}`);
      else titles.set(key, childId);
    }
    for (const item of node.items) {
      const secondaries = placementsOf(state, item).filter((placement) => placement.rank > 0);
      if (secondaries.length > config.secondary.max) output.add(`I2:${item}:count`);
      for (const secondary of secondaries) {
        if (path.has(secondary.topicId)) output.add(`I2:${item}:${secondary.topicId}`);
      }
    }
    for (const child of node.children) visit(child, depth + 1, new Set([...path, child]));
  };
  visit(scopeId, depthOf(state, scopeId), new Set(pathOf(state, scopeId)));
  return output;
}

/** A direct item of the topic has a secondary on its primary path or too many secondaries. */
function hasInvalidSecondary(state: TopicTreeState, config: TopicTreeConfig, id: string): boolean {
  const path = new Set(pathOf(state, id));
  return getTopic(state, id).items.some((item) => {
    const secondaries = placementsOf(state, item).filter((placement) => placement.rank > 0);
    return (
      secondaries.length > config.secondary.max ||
      secondaries.some((placement) => path.has(placement.topicId))
    );
  });
}

function hardConditionsOf(
  state: TopicTreeState,
  config: TopicTreeConfig,
  id: string,
  depth: number
): RebalanceCondition[] {
  const node = getTopic(state, id);
  const output: RebalanceCondition[] = [];
  if (
    id !== state.rootId &&
    node.children.length === 0 &&
    node.items.length > config.leaf.hardMax
  ) {
    output.push("leaf-above-hard-max");
  }
  if (node.children.length > config.fanOut.hardMax) output.push("fan-out-above-hard-max");
  if (depth > config.depth.cap) output.push("depth-above-cap");
  if (hasInvalidSecondary(state, config, id)) output.push("invalid-secondary");
  return output;
}

// ---------------------------------------------------------------------------
// Trials

interface Outcome extends RebalanceMeasure {
  hardBefore: Set<string>;
  hardAfter: Set<string>;
  protectedTouched: boolean;
  areaLevel: boolean;
  frozen: boolean;
  /** Repair clocks the operation set, to restore when it is re-applied. */
  clocks: Map<string, number | null>;
}

function snapshotClocks(state: TopicTreeState): Map<string, number | null> {
  const output = new Map<string, number | null>();
  for (const node of state.topics.values()) output.set(node.id, node.control.repairClock);
  return output;
}

function changedClocks(
  state: TopicTreeState,
  before: Map<string, number | null>
): Map<string, number | null> {
  const output = new Map<string, number | null>();
  for (const node of state.topics.values()) {
    if (before.get(node.id) !== node.control.repairClock) {
      output.set(node.id, node.control.repairClock);
    }
  }
  return output;
}

function restoreClocks(state: TopicTreeState, clocks: Map<string, number | null>): void {
  for (const [id, clock] of clocks) {
    const node = state.topics.get(id);
    if (node) node.control.repairClock = clock;
  }
}

function undoEvents(
  input: RebalanceInput,
  events: readonly StructureEvent[],
  touched: Iterable<string>
): void {
  const { touchedTopics } = applyEvents(input.state, invertEvents(events));
  refreshTopics(input.state, input.vectors, [...touchedTopics, ...touched]);
}

function redoEvents(input: RebalanceInput, events: readonly StructureEvent[]): void {
  const { touchedTopics } = applyEvents(input.state, events);
  refreshTopics(input.state, input.vectors, touchedTopics);
}

function withinScope(state: TopicTreeState, scopeId: string, topicIds: Iterable<string>): boolean {
  for (const id of topicIds) {
    const node = state.topics.get(id);
    if (!node) continue;
    // A retired topic keeps its parent pointer; its old place must be inside the scope too.
    const anchor = isLive(node) ? id : node.parentId;
    if (anchor === null || !state.topics.has(anchor)) return false;
    if (!pathOf(state, anchor).includes(scopeId)) return false;
  }
  return true;
}

function shapeContext(env: Environment, editor: TopicTreeEditor): ShapeContext {
  const { input } = env;
  return {
    state: input.state,
    vectors: input.vectors,
    config: input.config,
    seed: input.seed,
    editor,
    newTopicId: input.newTopicId,
    now: input.now,
    markMoves: true,
    ...(input.readmit ? { readmit: input.readmit } : {})
  };
}

/**
 * The factor on a check's weighted churn before acceptance multiplies it by lambda
 * (`stability.churnWeight`): 1 for shape repairs, 1 / lambda for the mis-parent correction (D12),
 * whose churn so counts once. Q prices a mis-parented subtree at its items x (1 + gain) and the
 * re-parent moves exactly those items, so at lambda >= 1 + gain no correction could ever pass.
 * Recently opened items still weigh more, and the margin (`audit.misParentMargin`), cooldown,
 * freeze, budgets, protection and the Area-level rule bound it like any soft operation.
 */
export function churnWeightOf(condition: RebalanceCondition, config: TopicTreeConfig): number {
  const lambda = config.stability.churnWeight;
  return condition === "mis-parented" && lambda > 0 ? 1 / lambda : 1;
}

/**
 * Runs one candidate on the live state and measures it. The returned outcome leaves the state
 * changed; `rollback` restores it exactly (structure, statistics and repair clocks).
 */
function runTrial(
  env: Environment,
  candidate: Candidate
): { outcome: Outcome; rollback: () => void } | { failure: RebalanceSkipReason } {
  const { input, quality } = env;
  const { state, vectors, config } = input;
  const clocks = snapshotClocks(state);
  let scope = ancestorAt(state, candidate.topicId, candidate.scopeLevels);
  let qualityBefore = subtreeQuality(state, vectors, config, scope, quality).total;
  let hardBefore = scopeHardViolations(state, config, scope);
  const editor = createTopicTreeEditor(state);
  let operation: TopicOperation | ShapeOperation | null;
  try {
    operation = candidate.run(shapeContext(env, editor));
  } catch (error) {
    if (!(error instanceof StructureEventConflictError || error instanceof TopicTreeStateError)) {
      throw error;
    }
    undoEvents(input, editor.events, editor.touched);
    restoreClocks(state, clocks);
    return { failure: "conflict" };
  }
  const events = [...editor.events];
  if (!operation || events.length === 0) {
    undoEvents(input, events, editor.touched);
    restoreClocks(state, clocks);
    return { failure: "no-change" };
  }
  const touched = new Set([...eventsTopics(events), ...editor.touched]);
  if (!withinScope(state, scope, touched)) {
    // Widen to the whole tree: measure "before" on the restored state, then redo.
    undoEvents(input, events, editor.touched);
    scope = state.rootId;
    qualityBefore = subtreeQuality(state, vectors, config, scope, quality).total;
    hardBefore = scopeHardViolations(state, config, scope);
    redoEvents(input, events);
  }
  const deltaQuality = subtreeQuality(state, vectors, config, scope, quality).total - qualityBefore;
  const hardAfter = scopeHardViolations(state, config, scope);
  const churn = eventChurn(state, events, config, input.recentItems);
  const outcome: Outcome = {
    kind: operation.kind,
    topicId: candidate.topicId,
    trigger: candidate.trigger,
    condition: candidate.condition,
    events,
    created: [...operation.created],
    retired: [...operation.retired],
    churn,
    deltaQuality,
    netGain: netGain(
      deltaQuality,
      churnWeightOf(candidate.condition, config) * churn.weighted,
      config
    ),
    hardBefore,
    hardAfter,
    protectedTouched: eventsTouchProtected(state, events),
    areaLevel:
      input.areasActive === true &&
      input.areaLevelReview !== false &&
      eventsAreAreaLevel(state, events),
    frozen: eventsTouchFrozen(state, events),
    clocks: changedClocks(state, clocks)
  };
  return {
    outcome,
    rollback: () => {
      undoEvents(input, events, touched);
      restoreClocks(state, clocks);
    }
  };
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The driver

/** Soft operations that move whole subtrees (bounded per operation by repair.softMoveShare). */
const subtreeOperationKinds: ReadonlySet<TopicOperationKind> = new Set([
  "internal-split",
  "push-down",
  "lift",
  "reparent"
]);

type Verdict =
  | { status: "apply"; score: number }
  | { status: "propose"; score: number; reason: RebalanceProposal["reason"] }
  | { status: "skip"; reason: RebalanceSkipReason };

function judge(
  env: Environment,
  outcome: Outcome,
  budget: { operationsLeft: number; movedItemsLeft: number; total: number }
): Verdict {
  const { config } = env.input;
  const force = env.input.force === true;
  if (outcome.trigger === "hard") {
    const fixes =
      isSubset(outcome.hardAfter, outcome.hardBefore) &&
      outcome.hardAfter.size < outcome.hardBefore.size;
    if (!fixes) return { status: "skip", reason: "no-fix" };
  } else if (!isSubset(outcome.hardAfter, outcome.hardBefore)) {
    return { status: "skip", reason: "hard-invariant" };
  }
  const score = outcome.trigger === "hard" ? -outcome.churn.weighted : outcome.netGain;
  if (outcome.trigger === "soft" && !(outcome.netGain > 0)) {
    return { status: "skip", reason: "rejected" };
  }
  if (outcome.protectedTouched) return { status: "propose", score, reason: "protected" };
  if (outcome.areaLevel) return { status: "propose", score, reason: "area-level" };
  if (outcome.trigger === "soft" && !force) {
    if (outcome.frozen) return { status: "skip", reason: "frozen" };
    const moved = outcome.churn.items.length;
    // As in the batch repair (build.ts), repair.softMoveShare bounds the operations that re-path
    // whole subtrees; leaf-level ones are bounded by the daily budget only.
    const repathsSubtrees = subtreeOperationKinds.has(outcome.kind);
    if (
      budget.operationsLeft <= 0 ||
      moved > budget.movedItemsLeft ||
      (repathsSubtrees && moved > config.repair.softMoveShare * budget.total)
    ) {
      return { status: "skip", reason: "budget" };
    }
  }
  return { status: "apply", score };
}

function measureOf(outcome: Outcome): RebalanceMeasure {
  return {
    kind: outcome.kind,
    topicId: outcome.topicId,
    trigger: outcome.trigger,
    condition: outcome.condition,
    events: outcome.events,
    created: outcome.created,
    retired: outcome.retired,
    churn: outcome.churn,
    deltaQuality: outcome.deltaQuality,
    netGain: outcome.netGain
  };
}

/**
 * REBALANCE over `input.topics` (default: the whole tree). It changes `input.state` only through
 * the applied operations, whose events (in order) are `result.events`; statistics of the touched
 * paths are exact afterwards.
 */
export function rebalanceTree(input: RebalanceInput): RebalanceResult {
  const { state, config } = input;
  const force = input.force === true;
  const env: Environment = {
    input,
    quality: input.areasActive === undefined ? {} : { areasActive: input.areasActive },
    eligibleTarget: (topicId) => {
      const node = state.topics.get(topicId);
      return (
        node !== undefined && isLive(node) && !isProtected(node) && (force || !node.control.frozen)
      );
    }
  };
  const total = placedItemCount(state);
  const maxTrials =
    input.maxTrials ?? Math.max(256, 8 * [...state.topics.values()].filter(isLive).length);
  const result: RebalanceResult = {
    applied: [],
    events: [],
    proposals: [],
    skipped: [],
    unresolvedHard: [],
    touchedTopics: [],
    churn: { items: 0, weighted: 0, share: 0 },
    trials: 0,
    exhausted: false
  };
  const proposalKeys = new Set<string>();
  const touched = new Set<string>();
  const movedItems = new Set<ItemKey>();
  const checked = new Set<string>();
  const initial = input.topics ? [...input.topics] : [...state.topics.keys()];

  const order = (ids: Iterable<string>): string[] =>
    [...new Set(ids)]
      .filter((id) => state.topics.has(id) && isLive(getTopic(state, id)))
      .map((id) => ({ id, depth: depthOf(state, id), anchor: contentAnchor(state, id) }))
      .sort(
        (a, b) =>
          b.depth - a.depth || compareStrings(a.anchor, b.anchor) || compareStrings(a.id, b.id)
      )
      .map((entry) => entry.id);

  /**
   * Live topics an applied operation touched, their parents and their siblings (a merge or a new
   * leaf changes what the siblings' own operations are worth).
   */
  const recheck = (outcome: Outcome): string[] => {
    const next = new Set<string>();
    for (const topicId of [...eventsTopics(outcome.events), ...outcome.created]) {
      const node = state.topics.get(topicId);
      if (!node || !isLive(node)) continue;
      next.add(topicId);
      if (node.parentId === null) continue;
      next.add(node.parentId);
      for (const sibling of getTopic(state, node.parentId).children) next.add(sibling);
    }
    return [...next];
  };

  const apply = (outcome: Outcome, keep: boolean): void => {
    if (!keep) redoEvents(input, outcome.events);
    restoreClocks(state, outcome.clocks);
    result.applied.push(measureOf(outcome));
    result.events.push(...outcome.events);
    for (const item of outcome.churn.items) movedItems.add(item);
    result.churn.weighted += outcome.churn.weighted;
    for (const id of eventsTopics(outcome.events)) touched.add(id);
    if (outcome.trigger === "soft" && !force) {
      consumeDailyBudget(state, input.day, outcome.churn.items.length);
    }
  };

  /** Checks one topic; returns the topics to re-check when an operation was applied. */
  const process = (id: string, depth: number, trigger: RebalanceTrigger): string[] => {
    checked.add(id);
    let candidates: Candidate[];
    if (trigger === "hard") {
      candidates = hardCandidates(env, id, depth);
    } else {
      if (!force && isCoolingDown(state, config, id)) {
        for (const candidate of softCandidates(env, id, depth)) {
          result.skipped.push(skipOf(candidate, "cooldown", null));
        }
        return [];
      }
      if (!force && getTopic(state, id).control.frozen) {
        for (const candidate of softCandidates(env, id, depth)) {
          result.skipped.push(skipOf(candidate, "frozen", null));
        }
        return [];
      }
      candidates = softCandidates(env, id, depth);
    }
    if (input.conditions) {
      const wanted = input.conditions;
      candidates = candidates.filter((candidate) => wanted.has(candidate.condition));
    }
    if (candidates.length === 0) return [];
    const budget = { ...dailyBudget(state, config, input.day, total), total };
    let best: { outcome: Outcome; score: number } | null = null;
    let bestProposal: {
      outcome: Outcome;
      score: number;
      reason: RebalanceProposal["reason"];
    } | null = null;
    for (const candidate of candidates) {
      if (result.trials >= maxTrials) {
        result.exhausted = true;
        break;
      }
      result.trials += 1;
      const trial = runTrial(env, candidate);
      if ("failure" in trial) {
        result.skipped.push(skipOf(candidate, trial.failure, null));
        continue;
      }
      const verdict = judge(env, trial.outcome, budget);
      if (verdict.status === "apply" && candidates.length === 1) {
        // The only candidate stays applied: no rollback and redo.
        apply(trial.outcome, true);
        return recheck(trial.outcome);
      }
      trial.rollback();
      if (verdict.status === "skip") {
        result.skipped.push(skipOf(candidate, verdict.reason, trial.outcome.netGain));
      } else if (verdict.status === "apply") {
        if (best === null || verdict.score > best.score) {
          best = { outcome: trial.outcome, score: verdict.score };
        }
      } else if (bestProposal === null || verdict.score > bestProposal.score) {
        bestProposal = { outcome: trial.outcome, score: verdict.score, reason: verdict.reason };
      }
    }
    if (best) {
      apply(best.outcome, false);
      return recheck(best.outcome);
    }
    if (bestProposal) {
      const { outcome } = bestProposal;
      const key = `${outcome.condition}:${outcome.topicId}`;
      // One proposal per operation and topic: a hard and a soft check of one leaf propose once.
      const operation = `${outcome.kind}:${outcome.topicId}`;
      if (!proposalKeys.has(operation)) {
        proposalKeys.add(operation);
        result.proposals.push({
          ...measureOf(bestProposal.outcome),
          key,
          reason: bestProposal.reason
        });
      }
    }
    return [];
  };

  const phase = (trigger: RebalanceTrigger, start: Iterable<string>): void => {
    let pending = order(start);
    while (pending.length > 0 && !result.exhausted) {
      const next = new Set<string>();
      for (const id of pending) {
        const node = state.topics.get(id);
        if (!node || !isLive(node)) continue;
        for (const topicId of process(id, depthOf(state, id), trigger)) next.add(topicId);
        if (result.exhausted) break;
      }
      pending = order(next);
    }
  };

  phase("hard", initial);
  if (!input.hardOnly) phase("soft", [...initial, ...touched]);

  for (const id of checked) {
    const node = state.topics.get(id);
    if (!node || !isLive(node)) continue;
    for (const condition of hardConditionsOf(state, config, id, depthOf(state, id))) {
      result.unresolvedHard.push({ topicId: id, condition });
    }
  }
  result.touchedTopics = [...touched]
    .filter((id) => state.topics.has(id) && isLive(getTopic(state, id)))
    .sort(compareStrings);
  result.churn.items = movedItems.size;
  result.churn.share = total > 0 ? movedItems.size / total : 0;
  return result;
}

function skipOf(
  candidate: Candidate,
  reason: RebalanceSkipReason,
  gain: number | null
): SkippedRebalanceCheck {
  return {
    topicId: candidate.topicId,
    condition: candidate.condition,
    kind: candidate.kind,
    reason,
    netGain: gain
  };
}
