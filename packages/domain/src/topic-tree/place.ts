// PLACE (D10, plan 4.1): deterministic placement of one item by beam descent over the live tree,
// the gate rule, and the placement events that apply a decision. Placement never waits for a
// model and never creates a topic: a lone item waits at an ancestor until REBALANCE forms leaves.
//
// decidePlacement descends from the root keeping the `placement.beam` best admitted children per
// level. A child is admitted when its centroid cosine reaches its node-relative threshold
// max(a_min, m - z * max(s, floor)) (stats.ts); children are ranked by the centroid cosine mixed
// with the label cosine (label.ts). The result is one of:
//   auto        the best admitted leaf beats the best other leaf by at least the ambiguity margin
//               (or has no competitor): applied at once;
//   gate        the best admitted leaf is ambiguous: up to `gate.maxCandidates` leaves for the
//               decider, and the item is applied at once at the deepest admitted common ancestor
//               of the ambiguous leaves with `needs_gate`; resolveGate decides later;
//   unadmitted  no admitted leaf: the deepest admitted internal topic (the root holds Unsorted).
// The margin is the Spike B definition: the best admitted leaf's score minus the best score of
// any other leaf the beam reached, admitted or not, so it can be negative. Without a validated
// decider a gated item is the gate's "none" (`applyNoDeciderFallback`, owner decision 19): it
// stays at its ancestor as a new-topic candidate REBALANCE may group, marked `fallback-none` until
// a ranker decides it again.
//
// Every order is canonical (score, then topic ID), so the same state, vector and configuration
// always give the same decision. placeItem keeps the in-memory statistics current along the
// touched paths within one engine run (D7); the service persists the exact recompute.
import type { TopicPlacementDecision, TopicPlacementManagement } from "../topics.js";
import type { TopicTreeConfig } from "./config.js";
import type { StructureEvent, TopicTreeEditor } from "./events.js";
import { compareStrings } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { labelCosine, mixLabelScore } from "./label.js";
import { chooseSecondaries, maxSecondaries } from "./secondary.js";
import {
  TopicTreeStateError,
  depthOf,
  getItem,
  getLiveTopic,
  getTopic,
  isLive,
  pathOf,
  placementRecord,
  placementsOf
} from "./state.js";
import type { PlacementRecord, TopicNode, TopicTreeState } from "./state.js";
import { addItemToPath, admissionThreshold, statsRow, subtractItemFromPath } from "./stats.js";
import { dot, rowView } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

// ---------------------------------------------------------------------------
// Decision

/** One topic the beam scored for an item. */
export interface PlacementCandidate {
  topicId: string;
  /** Cosine of the item vector to the topic centroid (0 for an empty topic). */
  cosine: number;
  /** Cosine to the topic label, when the topic has a current label. */
  labelCosine: number | null;
  /** Ranking score: the cosine mixed with the label cosine (`placement.labelWeight`). */
  score: number;
  /** Admission threshold the cosine was compared with (null for the start topic). */
  threshold: number | null;
  admitted: boolean;
  /** A live topic without children at decision time. */
  leaf: boolean;
  /** Depth below the root (root = 0). */
  depth: number;
}

interface DecisionBase {
  /** Where the item goes now: the best leaf (auto) or an ancestor (gate, unadmitted). */
  topicId: string;
  /** Ranking score of `topicId`. */
  score: number;
  /** Best admitted leaf minus the best other leaf; null without an admitted leaf or a rival. */
  margin: number | null;
  /** Every leaf the beam reached, best first. */
  leaves: PlacementCandidate[];
}

export type PlacementDecision =
  | (DecisionBase & {
      kind: "auto";
      leaf: PlacementCandidate;
      runnerUp: PlacementCandidate | null;
    })
  | (DecisionBase & {
      kind: "gate";
      /** The best admitted leaf (the automatic choice the gate refines). */
      best: PlacementCandidate;
      /** At most `gate.maxCandidates` leaves, best first; always includes `best`. */
      candidates: PlacementCandidate[];
    })
  | (DecisionBase & { kind: "unadmitted" });

export type PlacementDecisionKind = PlacementDecision["kind"];

export interface DecideOptions {
  /** Descend from this live topic instead of the root (re-admission below an ancestor). */
  from?: string;
}

function byScore(a: PlacementCandidate, b: PlacementCandidate): number {
  return b.score - a.score || compareStrings(a.topicId, b.topicId);
}

function evaluate(
  node: TopicNode,
  vector: Float32Array,
  config: TopicTreeConfig,
  depth: number,
  threshold: number | null
): PlacementCandidate {
  const cosine = node.stats.n > 0 ? dot(vector, node.stats.centroid) : 0;
  const label = labelCosine(node, vector);
  return {
    topicId: node.id,
    cosine,
    labelCosine: label,
    score: mixLabelScore(cosine, label, config.placement.labelWeight),
    threshold,
    admitted: threshold === null || cosine >= threshold,
    leaf: node.children.length === 0,
    depth
  };
}

/** Scores one live topic for an item vector (centroid and label cosines, mixed score). */
export function scoreTopic(
  state: TopicTreeState,
  config: TopicTreeConfig,
  vector: Float32Array,
  topicId: string
): PlacementCandidate {
  const node = getLiveTopic(state, topicId);
  return evaluate(node, vector, config, depthOf(state, topicId), admissionThreshold(node, config));
}

/** The deepest topic on every given topic's path (their lowest common ancestor). */
export function commonAncestor(state: TopicTreeState, topicIds: readonly string[]): string {
  let prefix: string[] | null = null;
  for (const id of topicIds) {
    const path = pathOf(state, id);
    if (prefix === null) {
      prefix = path;
      continue;
    }
    let shared = 0;
    while (shared < prefix.length && shared < path.length && prefix[shared] === path[shared]) {
      shared += 1;
    }
    prefix = prefix.slice(0, shared);
  }
  return prefix?.[prefix.length - 1] ?? state.rootId;
}

/** Up to `max` leaves, best first, always including `best` (it replaces the last when needed). */
function gateCandidates(
  leaves: readonly PlacementCandidate[],
  best: PlacementCandidate,
  max: number
): PlacementCandidate[] {
  const candidates = leaves.slice(0, max);
  if (!candidates.includes(best)) candidates[candidates.length - 1] = best;
  return candidates;
}

/**
 * Decides where an item vector (unit, the tree's dimension) belongs. Read-only: the state is not
 * changed. See the module comment for the three outcomes.
 */
export function decidePlacement(
  state: TopicTreeState,
  config: TopicTreeConfig,
  vector: Float32Array,
  options: DecideOptions = {}
): PlacementDecision {
  if (vector.length !== state.dim) {
    throw new TopicTreeStateError(`Vector has ${vector.length} dimensions, expected ${state.dim}`);
  }
  const from = options.from ?? state.rootId;
  const start = evaluate(getLiveTopic(state, from), vector, config, depthOf(state, from), null);
  const beam = Math.max(1, config.placement.beam);
  const reached = new Map<string, PlacementCandidate>();
  const terminals: PlacementCandidate[] = [];
  let frontier = [start];
  while (frontier.length > 0) {
    const next: PlacementCandidate[] = [];
    for (const current of frontier) {
      reached.set(current.topicId, current);
      const node = getTopic(state, current.topicId);
      if (node.children.length === 0) {
        terminals.push(current);
        continue;
      }
      let admittedChild = false;
      for (const childId of node.children) {
        const child = getTopic(state, childId);
        const threshold = admissionThreshold(child, config);
        const candidate = evaluate(child, vector, config, current.depth + 1, threshold);
        if (candidate.admitted) {
          admittedChild = true;
          next.push(candidate);
        } else if (candidate.leaf) {
          terminals.push(candidate);
        }
      }
      if (!admittedChild) terminals.push(current);
    }
    next.sort(byScore);
    frontier = next.slice(0, beam);
  }

  // The root is never a leaf topic: an item at the root waits in Unsorted.
  const leaves = terminals
    .filter((candidate) => candidate.leaf && candidate.topicId !== state.rootId)
    .sort(byScore);
  const best = leaves.find((candidate) => candidate.admitted);
  if (best) {
    const runnerUp = leaves.find((candidate) => candidate.topicId !== best.topicId) ?? null;
    const margin = runnerUp === null ? null : best.score - runnerUp.score;
    if (margin === null || margin >= config.placement.ambiguityMargin) {
      return {
        kind: "auto",
        topicId: best.topicId,
        score: best.score,
        margin,
        leaves,
        leaf: best,
        runnerUp
      };
    }
    const candidates = gateCandidates(leaves, best, config.gate.maxCandidates);
    const ambiguous = candidates.filter(
      (candidate) =>
        candidate === best || candidate.score > best.score - config.placement.ambiguityMargin
    );
    // Every leaf the beam reached hangs below admitted topics, so their common ancestor is one;
    // the walk up is a guard.
    const path = pathOf(
      state,
      commonAncestor(
        state,
        ambiguous.map((candidate) => candidate.topicId)
      )
    );
    let fallback = start;
    for (const id of path.reverse()) {
      const candidate = reached.get(id);
      if (candidate?.admitted) {
        fallback = candidate;
        break;
      }
    }
    return {
      kind: "gate",
      topicId: fallback.topicId,
      score: fallback.score,
      margin,
      leaves,
      best,
      candidates
    };
  }
  const internal = terminals
    .filter((candidate) => !candidate.leaf && candidate.admitted)
    .sort((a, b) => b.depth - a.depth || b.score - a.score || compareStrings(a.topicId, b.topicId));
  const target = internal[0] ?? start;
  return { kind: "unadmitted", topicId: target.topicId, score: target.score, margin: null, leaves };
}

// ---------------------------------------------------------------------------
// The gate rule

/** The decider's log-odds for one gate candidate. */
export interface GateScore {
  topicId: string;
  logOdds: number;
}

export interface GateResolution {
  kind: "accept" | "none";
  /** The accepted topic, or the best candidate that fell short; null without candidates. */
  topicId: string | null;
  /** Probability of the best candidate. */
  probability: number;
  /** Probability of "none of these" (tau). */
  noneProbability: number;
  /** Probability of each candidate, in input order. */
  probabilities: number[];
}

/**
 * The D10 gate rule: p = softmax([logOdds..., tau] / T); accept the best candidate (the first on
 * ties) when its p reaches theta, otherwise "none" (the item is flagged for a split check). For a
 * fixed input the accepted set only shrinks as theta grows.
 */
export function resolveGate(
  scores: readonly GateScore[],
  gate: TopicTreeConfig["gate"]
): GateResolution {
  const seen = new Set<string>();
  for (const score of scores) {
    if (Number.isNaN(score.logOdds) || score.logOdds === Number.POSITIVE_INFINITY) {
      throw new RangeError(`Invalid log-odds for topic ${score.topicId}`);
    }
    if (seen.has(score.topicId)) throw new RangeError(`Duplicate gate candidate ${score.topicId}`);
    seen.add(score.topicId);
  }
  const values = [...scores.map((score) => score.logOdds), gate.tau].map(
    (value) => value / gate.temperature
  );
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  const probabilities = exps.map((value) => value / total);
  const noneProbability = probabilities.pop() as number;
  let bestIndex = -1;
  probabilities.forEach((probability, index) => {
    if (bestIndex < 0 || probability > (probabilities[bestIndex] as number)) bestIndex = index;
  });
  const probability = bestIndex < 0 ? 0 : (probabilities[bestIndex] as number);
  const topicId = bestIndex < 0 ? null : (scores[bestIndex] as GateScore).topicId;
  const accepted = topicId !== null && probability >= gate.theta;
  return {
    kind: accepted ? "accept" : "none",
    topicId,
    probability,
    noneProbability,
    probabilities
  };
}

// ---------------------------------------------------------------------------
// Plans and placement events

/** The primary placement a plan asks for. */
export interface PlannedPlacement {
  topicId: string;
  decidedBy: TopicPlacementDecision;
  score: number | null;
  margin: number | null;
  needsGate: boolean;
  needsSplitCheck: boolean;
  needsVector: boolean;
}

/** What one item's placements should become. */
export interface PlacementPlan {
  primary: PlannedPlacement;
  /** AI "also in" topics, best first (secondary.ts). */
  secondaries: { topicId: string; score: number | null }[];
}

/** The plan for a decision: auto places the leaf with its secondaries; the others wait above. */
export function planFromDecision(
  state: TopicTreeState,
  config: TopicTreeConfig,
  decision: PlacementDecision
): PlacementPlan {
  const flags = { needsGate: false, needsSplitCheck: false, needsVector: false };
  switch (decision.kind) {
    case "auto":
      return {
        primary: {
          topicId: decision.topicId,
          decidedBy: "auto",
          score: decision.score,
          margin: decision.margin,
          ...flags
        },
        secondaries: chooseSecondaries(state, config, decision.leaf, decision.leaves).map(
          (candidate) => ({ topicId: candidate.topicId, score: candidate.score })
        )
      };
    case "gate":
      return {
        primary: {
          topicId: decision.topicId,
          decidedBy: "fallback",
          score: decision.score,
          margin: decision.margin,
          ...flags,
          needsGate: true
        },
        secondaries: []
      };
    case "unadmitted":
      return {
        primary: {
          topicId: decision.topicId,
          decidedBy: "fallback",
          score: decision.score,
          margin: null,
          ...flags
        },
        secondaries: []
      };
  }
}

/** The plan for an item with no vector: it waits in Unsorted, flagged `needs_vector` (D8). */
export function needsVectorPlan(state: TopicTreeState): PlacementPlan {
  return {
    primary: {
      topicId: state.rootId,
      decidedBy: "fallback",
      score: null,
      margin: null,
      needsGate: false,
      needsSplitCheck: false,
      needsVector: true
    },
    secondaries: []
  };
}

/** Engine context of PLACE; a ShapeContext (build.ts) satisfies it. */
export interface PlacementContext {
  readonly state: TopicTreeState;
  readonly vectors: ItemVectorSource;
  readonly config: TopicTreeConfig;
  /** Applies (and logs) every change as a structure event. */
  readonly editor: TopicTreeEditor;
  /** Timestamp of "moved from" hints. */
  readonly now: string;
}

export interface ApplyPlanOptions {
  /** `topic_placements.item_fingerprint` of the vector the plan used. */
  fingerprint: string | null;
  /** Record "moved from" when a settled primary moves (default true). */
  markMove?: boolean;
}

export type ApplyPlanResult =
  { kind: "applied"; events: number; from: string | null; to: string } | { kind: "protected" };

/** A placement shown in its topic: not waiting for a gate or a vector (D27). */
function isSettled(placement: PlacementRecord): boolean {
  return !placement.needsGate && !placement.needsVector;
}

function differs(current: PlacementRecord, patch: Partial<PlacementRecord>): boolean {
  return Object.entries(patch).some(
    ([field, value]) => (current as unknown as Record<string, unknown>)[field] !== value
  );
}

/**
 * Turns an item's placements into the plan with the fewest events: AI secondaries that are no
 * longer wanted (or would sit on the new primary path) are unplaced first, then the primary is
 * placed or moved, then missing secondaries take the lowest free ranks. Human placements are never
 * changed: an item with a human primary, or whose new primary path would contain one of its human
 * secondaries, is left alone (`protected`). Statistics are not touched (see placeItem).
 */
export function applyPlacementPlan(
  context: PlacementContext,
  item: ItemKey,
  plan: PlacementPlan,
  options: ApplyPlanOptions
): ApplyPlanResult {
  const { state, config, editor } = context;
  getItem(state, item);
  const placements = placementsOf(state, item).map((placement) => ({ ...placement }));
  const primary = placements.find((placement) => placement.rank === 0);
  if (primary?.management === "human") return { kind: "protected" };
  const target = plan.primary.topicId;
  getLiveTopic(state, target);
  const targetPath = new Set(pathOf(state, target));
  const human = placements.filter(
    (placement) => placement.rank > 0 && placement.management === "human"
  );
  if (human.some((placement) => targetPath.has(placement.topicId))) return { kind: "protected" };

  let events = 0;
  const room = Math.max(0, maxSecondaries(config) - human.length);
  const wanted = plan.secondaries
    .filter(
      (secondary) =>
        !targetPath.has(secondary.topicId) &&
        !human.some((placement) => placement.topicId === secondary.topicId)
    )
    .slice(0, room);
  const wantedIds = new Set(wanted.map((secondary) => secondary.topicId));
  for (const placement of placements) {
    if (placement.rank > 0 && placement.management === "ai" && !wantedIds.has(placement.topicId)) {
      editor.unplaceItem(item, placement.rank);
      events += 1;
    }
  }

  const management: TopicPlacementManagement = "ai";
  const fields = { ...plan.primary, management, itemFingerprint: options.fingerprint };
  if (!primary) {
    editor.placeItem(item, placementRecord(target, { ...fields, rank: 0 }));
    events += 1;
  } else {
    const moving = primary.topicId !== target;
    const hint = !moving
      ? { movedFromTopicId: primary.movedFromTopicId, movedAt: primary.movedAt }
      : (options.markMove ?? true) && isSettled(primary)
        ? { movedFromTopicId: primary.topicId, movedAt: context.now }
        : { movedFromTopicId: null, movedAt: null };
    const patch = { ...fields, ...hint };
    if (differs(primary, patch)) {
      editor.updatePlacement(item, 0, patch);
      events += 1;
    }
  }

  const decidedBy: TopicPlacementDecision = plan.primary.decidedBy === "gate" ? "gate" : "auto";
  for (const secondary of wanted) {
    const current = placementsOf(state, item).find(
      (placement) => placement.rank > 0 && placement.topicId === secondary.topicId
    );
    if (current) {
      const patch = { score: secondary.score, itemFingerprint: options.fingerprint };
      if (differs(current, patch)) {
        editor.updatePlacement(item, current.rank, patch);
        events += 1;
      }
      continue;
    }
    const used = new Set(placementsOf(state, item).map((placement) => placement.rank));
    let rank = 1;
    while (used.has(rank)) rank += 1;
    editor.placeItem(
      item,
      placementRecord(secondary.topicId, {
        rank,
        decidedBy,
        score: secondary.score,
        itemFingerprint: options.fingerprint
      })
    );
    events += 1;
  }
  return { kind: "applied", events, from: primary?.topicId ?? null, to: target };
}

// ---------------------------------------------------------------------------
// In-memory statistics around a placement change (D7, D8)

/** Items whose stats contribution a placement change of `item` can alter: it and its root. */
function relatedItems(state: TopicTreeState, item: ItemKey): ItemKey[] {
  const entry = getItem(state, item);
  const related = [item];
  if (entry.rootSource !== null && state.items.has(entry.rootSource)) {
    related.push(entry.rootSource);
  }
  return related;
}

/** Item -> primary topic for the related items that count in the statistics now. */
function contributions(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  items: readonly ItemKey[]
): [ItemKey, string][] {
  const output: [ItemKey, string][] = [];
  for (const item of items) {
    const primary = placementsOf(state, item).find((placement) => placement.rank === 0);
    if (primary && statsRow(state, vectors, item) !== undefined) {
      output.push([item, primary.topicId]);
    }
  }
  return output;
}

/**
 * Runs `change` with the item (and its root source) out of the in-memory statistics, then adds
 * back whatever counts afterwards: a note placed for the first time stops its root source from
 * counting (D8), and a re-decided item never sees itself in its old topic.
 */
function withStatsUpdate<T>(context: PlacementContext, item: ItemKey, change: () => T): T {
  const { state, vectors } = context;
  const related = relatedItems(state, item);
  for (const [key, topicId] of contributions(state, vectors, related)) {
    subtractItemFromPath(state, vectors, key, topicId);
  }
  try {
    return change();
  } finally {
    for (const [key, topicId] of contributions(state, vectors, related)) {
      addItemToPath(state, vectors, key, topicId);
    }
  }
}

/**
 * Live topics whose statistics a list of applied structure events may have changed: every topic
 * an event touched, plus, for each note whose primary placement was added or removed, the
 * current primary topic of its root source, which starts or stops counting (D8). Recomputing the
 * paths of these topics (stats.ts recomputePaths) makes the statistics exact again (D7); the
 * editor's `touched` set alone misses the root-source paths.
 */
export function topicsWithStaleStats(
  state: TopicTreeState,
  events: readonly StructureEvent[]
): string[] {
  const topics = new Set<string>();
  const add = (id: string | null | undefined): void => {
    if (id === null || id === undefined) return;
    const node = state.topics.get(id);
    if (node && isLive(node)) topics.add(id);
  };
  for (const event of events) {
    add(event.topicId);
    if ("item" in event) {
      add(event.before?.topicId);
      add(event.after?.topicId);
      const primaryChanged =
        (event.op === "item.place" && event.after.rank === 0) ||
        (event.op === "item.unplace" && event.before.rank === 0);
      const entry = state.items.get(event.item);
      if (primaryChanged && entry?.kind === "note" && entry.rootSource !== null) {
        add(
          placementsOf(state, entry.rootSource).find((placement) => placement.rank === 0)?.topicId
        );
      }
    } else if (event.op === "topic.move") {
      add(event.before.parentId);
      add(event.after.parentId);
    } else if (event.op === "topic.create") {
      add(event.before?.parentId ?? event.after?.parentId);
    } else if (event.op === "topic.retire" || event.op === "topic.restore") {
      const node = state.topics.get(event.topicId);
      add(node?.parentId);
      add(event.after.redirectTo);
    }
  }
  return [...topics].sort(compareStrings);
}

// ---------------------------------------------------------------------------
// PLACE of one item

export type PlaceOutcomeKind = "placed" | "moved" | "updated" | "unchanged" | "protected" | "stale";

export interface PlaceOutcome {
  kind: PlaceOutcomeKind;
  /** The decision PLACE made (null when it decided nothing). */
  decision: PlacementDecision | null;
  /** Primary topic before and after. */
  from: string | null;
  to: string | null;
  /** Structure events emitted for the item. */
  events: number;
  /** The item now waits for the gate (the service enqueues `topic-gate`). */
  needsGate: boolean;
}

export interface PlaceItemOptions {
  /** Identity of the item's current vector (`topic_placements.item_fingerprint`). */
  fingerprint?: string | null;
  /** Record a "moved from" hint when a settled item moves (default true). */
  markMove?: boolean;
  /** Re-decide an item whose placement is current (same fingerprint). */
  force?: boolean;
}

function outcomeOf(
  state: TopicTreeState,
  item: ItemKey,
  decision: PlacementDecision | null,
  result: ApplyPlanResult | null,
  fallbackKind: PlaceOutcomeKind
): PlaceOutcome {
  const primary = placementsOf(state, item).find((placement) => placement.rank === 0);
  const after = primary?.topicId ?? null;
  const needsGate = primary?.needsGate ?? false;
  if (result === null || result.kind === "protected") {
    const kind = result === null ? fallbackKind : "protected";
    return { kind, decision, from: after, to: after, events: 0, needsGate };
  }
  const kind: PlaceOutcomeKind =
    result.events === 0
      ? "unchanged"
      : result.from === null
        ? "placed"
        : result.from !== result.to
          ? "moved"
          : "updated";
  return { kind, decision, from: result.from, to: result.to, events: result.events, needsGate };
}

/**
 * PLACE for one registered item, through the context's editor. An item is (re)decided when it
 * has no primary placement, its fingerprint changed, it waited for a vector that now exists, or
 * `force` is set; otherwise it is `unchanged` (PLACE is idempotent). An item without a vector
 * keeps its placement, or waits in Unsorted with `needs_vector` when it has none. Items with a
 * human primary placement are never re-placed. In-memory statistics follow the change.
 */
export function placeItem(
  context: PlacementContext,
  item: ItemKey,
  options: PlaceItemOptions = {}
): PlaceOutcome {
  const { state, vectors, config } = context;
  getItem(state, item);
  const fingerprint = options.fingerprint ?? null;
  const primary = placementsOf(state, item).find((placement) => placement.rank === 0);
  if (primary?.management === "human") {
    return outcomeOf(state, item, null, { kind: "protected" }, "protected");
  }
  const row = vectors.rowOf(item);
  const current =
    primary !== undefined &&
    primary.itemFingerprint === fingerprint &&
    !(primary.needsVector && row !== undefined);
  if (!options.force && current) return outcomeOf(state, item, null, null, "unchanged");
  if (row === undefined && primary) return outcomeOf(state, item, null, null, "unchanged");
  const apply = {
    fingerprint,
    ...(options.markMove === undefined ? {} : { markMove: options.markMove })
  };
  return withStatsUpdate(context, item, () => {
    if (row === undefined) {
      const result = applyPlacementPlan(context, item, needsVectorPlan(state), apply);
      return outcomeOf(state, item, null, result, "unchanged");
    }
    const decision = decidePlacement(state, config, rowView(vectors.matrix, row));
    const result = applyPlacementPlan(
      context,
      item,
      planFromDecision(state, config, decision),
      apply
    );
    return outcomeOf(state, item, decision, result, "unchanged");
  });
}

export interface GateApplyOptions {
  /**
   * The leaves of the decision the gate refined: an accepted item may also take "also in"
   * placements among them (secondary.ts).
   */
  candidates?: readonly PlacementCandidate[];
}

/** The decision of owner decision 19's fallback: the gate's "none" given without a decider. */
export const noDeciderDecision = "fallback-none" satisfies TopicPlacementDecision;

/**
 * The placement waits for a gate decision: flagged `needs_gate`, or decided by the no-decider
 * fallback (`fallback-none`), which a validated ranker decides again wherever REBALANCE moved it.
 */
export function awaitsGateDecision(placement: PlacementRecord | undefined): boolean {
  return (
    placement !== undefined &&
    placement.management === "ai" &&
    (placement.needsGate || placement.decidedBy === noDeciderDecision)
  );
}

/** The item's primary placement for a gate step: absent, human (`protected`) or AI. */
function gatePrimary(state: TopicTreeState, item: ItemKey): PlacementRecord | "protected" | null {
  getItem(state, item);
  const primary = placementsOf(state, item).find((placement) => placement.rank === 0);
  if (primary?.management === "human") return "protected";
  return primary ?? null;
}

/**
 * Owner decision 19: an item waiting with `needs_gate` while no validated decider exists is the
 * gate's "none". It stays at its fallback ancestor flagged `needs_split_check` (a new-topic
 * candidate REBALANCE may group into a new leaf, quality.ts) with `decided_by = fallback-none`, the
 * mark that survives REBALANCE's moves so the gate decides it again once a ranker validates. The
 * outcome is `stale` when the item does not wait for the gate, `protected` for human placements.
 */
export function applyNoDeciderFallback(context: PlacementContext, item: ItemKey): PlaceOutcome {
  const { state } = context;
  const primary = gatePrimary(state, item);
  if (primary === "protected")
    return outcomeOf(state, item, null, { kind: "protected" }, "protected");
  if (!primary || !primary.needsGate) return outcomeOf(state, item, null, null, "stale");
  const plan: PlacementPlan = {
    primary: {
      topicId: primary.topicId,
      decidedBy: noDeciderDecision,
      score: primary.score,
      margin: primary.margin,
      needsGate: false,
      needsSplitCheck: true,
      needsVector: false
    },
    secondaries: []
  };
  return withStatsUpdate(context, item, () =>
    outcomeOf(
      state,
      item,
      null,
      applyPlacementPlan(context, item, plan, {
        fingerprint: primary.itemFingerprint,
        markMove: false
      }),
      "unchanged"
    )
  );
}

/**
 * Applies a gate resolution to an item waiting for a gate decision (`awaitsGateDecision`). Accept
 * moves it to the chosen leaf (`decided_by = gate`). "None" leaves it where it is: an item flagged
 * `needs_gate`, or a `fallback-none` item still above the leaves, is flagged `needs_split_check`;
 * a `fallback-none` item REBALANCE already grouped into a leaf keeps that new topic. The outcome is
 * `stale` when the item no longer waits for the gate or the chosen topic is no longer a live leaf
 * (PLACE decides again), and `protected` for human placements.
 */
export function applyGateResolution(
  context: PlacementContext,
  item: ItemKey,
  resolution: GateResolution,
  options: GateApplyOptions = {}
): PlaceOutcome {
  const { state, vectors, config } = context;
  const primary = gatePrimary(state, item);
  if (primary === "protected")
    return outcomeOf(state, item, null, { kind: "protected" }, "protected");
  if (!primary || !awaitsGateDecision(primary)) return outcomeOf(state, item, null, null, "stale");
  const above =
    primary.topicId === state.rootId ||
    (state.topics.get(primary.topicId)?.children.length ?? 0) > 0;
  const keep: PlannedPlacement = {
    topicId: primary.topicId,
    decidedBy: primary.decidedBy === noDeciderDecision ? "fallback" : primary.decidedBy,
    score: primary.score,
    margin: primary.margin,
    needsGate: false,
    needsSplitCheck: primary.needsGate || above,
    needsVector: false
  };
  let plan: PlacementPlan = { primary: keep, secondaries: [] };
  if (resolution.kind === "accept") {
    const topicId = resolution.topicId as string;
    const node = state.topics.get(topicId);
    if (!node || !isLive(node) || node.children.length > 0 || topicId === state.rootId) {
      return outcomeOf(state, item, null, null, "stale");
    }
    const row = vectors.rowOf(item);
    const score =
      row === undefined
        ? null
        : scoreTopic(state, config, rowView(vectors.matrix, row), topicId).score;
    const secondaries =
      score === null || !options.candidates
        ? []
        : chooseSecondaries(state, config, { topicId, score }, options.candidates);
    plan = {
      primary: { ...keep, topicId, decidedBy: "gate", score, needsSplitCheck: false },
      secondaries: secondaries.map((candidate) => ({
        topicId: candidate.topicId,
        score: candidate.score
      }))
    };
  }
  return withStatsUpdate(context, item, () =>
    outcomeOf(
      state,
      item,
      null,
      applyPlacementPlan(context, item, plan, {
        fingerprint: primary.itemFingerprint,
        markMove: false
      }),
      "unchanged"
    )
  );
}
