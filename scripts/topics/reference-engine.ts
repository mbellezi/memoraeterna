// The engine port of the offline replay, and its reference implementation.
//
// The replay loop (replay.ts) drives any `ReplayEngine`: build, PLACE a batch, REBALANCE once,
// optionally rebuild. The product engine (T07 PLACE and T08 REBALANCE over the T03 state) plugs
// in through `createRealEngine` (real-engine.ts), the replay's default. `createReferenceEngine`
// (`--engine reference`) is the Spike B incremental engine over the T03 primitives: beam descent
// with node-relative admission, local repair with cooldowns and a churn budget, the ported shape
// operations, plus the two stability controls the E3 protocol names and Spike B lacked, a daily
// budget of soft operations and a freeze on given topics. It is the baseline the product engine
// was held to at gate A, not a second implementation to grow.
import {
  addItemToPath,
  admissionThreshold,
  buildLouvain,
  compareStrings,
  createTopicTreeEditor,
  createTopicTreeState,
  dotRowVec,
  getTopic,
  isLive,
  placementRecord,
  primaryPlacement,
  registerItem,
  repairAll,
  repairDirty,
  repairTopic,
  affectedTopics,
  rowContentHash,
  rowItemKey,
  rowVectors
} from "@app/domain/topic-tree";
import type {
  DetectCommunities,
  EmbeddingMatrix,
  ItemKey,
  ItemVectorSource,
  ShapeContext,
  ShapeOperation,
  TopicOperationKind,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

/** Placement margins whose gated share is reported (Spike B: `insertMargins`). */
export const reportedMargins = [0.01, 0.02, 0.03, 0.05] as const;

export type OperationCounts = Partial<Record<TopicOperationKind, number>>;

export interface BuildSummary {
  rows: number;
  knnMs: number;
  communitiesMs: number;
  repairMs: number;
  totalMs: number;
  /** Operations of the build's final forced repair pass. */
  repairs: number;
}

export interface PlaceSummary {
  placed: number;
  /** Placed on a leaf whose margin to the runner-up leaf was below `placement.ambiguityMargin`. */
  ambiguous: number;
  /** Not admitted to any leaf (placed on the deepest admitted internal topic). */
  unadmitted: number;
  /** Admitted placements whose margin fell below each of `reportedMargins`. */
  gatedAtMargin: Record<string, number>;
  /** Wall time, for the per-item cost. */
  ms: number;
  operations: OperationCounts;
}

export interface RebalanceContext {
  /** Simulated day; the daily budget of soft operations resets when it changes. */
  day: number;
}

export interface RebalanceSummary {
  /** Operations applied, by kind. */
  operations: OperationCounts;
  /** Soft operations skipped: a frozen topic, or the daily budget was spent. */
  skippedFrozen: number;
  skippedBudget: number;
  /** Topics whose soft checks waited for their cooldown (engines that report it). */
  skippedCooldown?: number;
  /** Operations returned for review instead of applied (protected or Area-level, D12). */
  proposals?: number;
  /** Items re-pathed by the operations applied. */
  movedItems: number;
}

/** What an engine's audit and undo checks did over a run (engines that have them). */
export interface EngineAuditSummary {
  /** Audits run (one before each REBALANCE). */
  audits: number;
  /** Mis-parent findings with a re-parent target that joined the REBALANCE checks. */
  reparentCandidates: number;
  /** Topics whose statistics the audit's exact sample found drifted (and recomputed). */
  driftedTopics: number;
  /** REBALANCE change-sets undone on a copy, and those that restored the dump exactly. */
  undoChecked: number;
  undoExact: number;
}

export interface RebuildSummary {
  /**
   * Why a rebuild ran (trigger name) and how many items changed path; `<trigger>:review` when it
   * waits for the owner instead (D29), which holds every later rebuild in the replay.
   */
  trigger: string;
  movedItems: number;
}

export interface PlaceOptions {
  /**
   * Repair after every insert (the growth runs of the Spike B parity check): the reference with
   * the Spike B local policy (cooldowns and the churn budget, no freeze or daily budget), the real
   * engine with a REBALANCE of the touched topics. Default: the reference splits a leaf past its
   * hard limit at once, and REBALANCE does the rest.
   */
  localRepair?: boolean;
  /** The simulated day of the arrivals (fresh items, stability.freshHours); default the last. */
  day?: number;
}

/**
 * How an engine treats an item PLACE sends to the gate: `baseline` takes the best-scoring
 * candidate (the margin-only baseline, D19), `off` leaves it waiting at the fallback ancestor.
 */
export type ReplayGate = "baseline" | "off";

/** What the replay loop needs from an engine. */
export interface ReplayEngine {
  readonly name: string;
  readonly gate: ReplayGate;
  /** The live tree (a rebuild may replace the object, so read it after every call). */
  readonly state: TopicTreeState;
  readonly vectors: ItemVectorSource;
  /** Builds a fresh tree over `rows` (matrix rows) and settles it. */
  build(rows: readonly number[]): BuildSummary;
  /**
   * PLACE: puts each row on its topic. The reference splits a leaf past its hard limit at once;
   * the real engine never changes structure in PLACE and leaves hard limits to REBALANCE.
   */
  place(rows: readonly number[], options?: PlaceOptions): PlaceSummary;
  /** REBALANCE once: repairs under cooldowns, budgets and the freeze. */
  rebalance(context: RebalanceContext): RebalanceSummary;
  /** Topics frozen for soft operations from now on (replaces the previous set). */
  setFrozen(topicIds: ReadonlySet<string>): void;
  /** Rebuild triggers (E3 step 3); null when none fired. Optional: the reference has none. */
  evaluateRebuild?(context: RebalanceContext): RebuildSummary | null;
  /** A full repair pass that ignores cooldowns (before a shape or parity measurement). */
  settle(): OperationCounts;
  /** Audit and undo-check counters so far. Optional: the reference has neither. */
  engineAudit?(): EngineAuditSummary;
}

export interface ReplayEngineInput {
  matrix: EmbeddingMatrix;
  config: TopicTreeConfig;
  seed: number;
  detect: DetectCommunities;
}

export type ReplayEngineFactory = (input: ReplayEngineInput) => ReplayEngine;

function countOperations(
  operations: readonly ShapeOperation[],
  into: OperationCounts = {}
): OperationCounts {
  for (const operation of operations) into[operation.kind] = (into[operation.kind] ?? 0) + 1;
  return into;
}

interface Candidate {
  id: string;
  score: number;
  admitted: boolean;
  leaf: boolean;
  depth: number;
}

export interface Decision {
  topicId: string;
  /** Chosen topic is an admitted leaf. */
  admittedLeaf: boolean;
  /** top1 - top2 between the chosen leaf and the best other leaf; null when there is none. */
  margin: number | null;
  score: number;
}

class ReferenceEngine implements ReplayEngine {
  readonly name = "spike-b-reference";
  /** An ambiguous item goes to the best admitted leaf, as in Spike B. */
  readonly gate = "baseline" as const;
  private current: TopicTreeState;
  private currentVectors: ItemVectorSource;
  private nextTopicId = 1;
  private readonly dirty = new Set<string>();
  private frozen: ReadonlySet<string> = new Set();
  private budgetDay = Number.NaN;
  private now = "2026-01-01T00:00:00.000Z";

  constructor(private readonly input: ReplayEngineInput) {
    this.currentVectors = rowVectors(input.matrix);
    this.current = this.emptyState();
  }

  get state(): TopicTreeState {
    return this.current;
  }

  get vectors(): ItemVectorSource {
    return this.currentVectors;
  }

  private emptyState(): TopicTreeState {
    return createTopicTreeState({ dim: this.input.matrix.dim, rootId: "0" });
  }

  private context(): ShapeContext {
    const state = this.current;
    return {
      state,
      vectors: this.currentVectors,
      config: this.input.config,
      seed: this.input.seed,
      editor: createTopicTreeEditor(state, { record: false }),
      newTopicId: () => String(this.nextTopicId++),
      now: this.now,
      seedLabel: (topicId) => topicId,
      readmit: (item, from) => {
        const target = this.decide(item, from).topicId;
        return target === from ? null : target;
      }
    };
  }

  build(rows: readonly number[]): BuildSummary {
    const started = performance.now();
    const result = buildLouvain(this.input.matrix, rows, {
      seed: this.input.seed,
      config: this.input.config,
      detectCommunities: this.input.detect
    });
    this.current = result.state;
    this.currentVectors = result.vectors;
    this.nextTopicId = Math.max(...[...result.state.topics.keys()].map(Number)) + 1;
    this.dirty.clear();
    return {
      rows: rows.length,
      knnMs: result.timings.knnMs,
      communitiesMs: result.timings.communitiesMs,
      repairMs: result.timings.repairMs,
      totalMs: performance.now() - started,
      repairs: result.repairs.length
    };
  }

  /** The admitted leaf with the best score, else the deepest admitted internal topic. */
  decide(item: ItemKey, from = this.current.rootId): Decision {
    const state = this.current;
    const { config } = this.input;
    const matrix = this.currentVectors.matrix;
    const row = this.currentVectors.rowOf(item) as number;
    const score = (id: string): number =>
      dotRowVec(matrix, row, getTopic(state, id).stats.centroid);
    const start = getTopic(state, from);
    let frontier: Candidate[] = [
      {
        id: from,
        score: start.stats.n > 0 ? score(from) : 0,
        admitted: true,
        leaf: start.children.length === 0,
        depth: 0
      }
    ];
    const terminals: Candidate[] = [];
    while (frontier.length > 0) {
      const next: Candidate[] = [];
      for (const candidate of frontier) {
        const node = getTopic(state, candidate.id);
        if (node.children.length === 0) {
          terminals.push({ ...candidate, leaf: true });
          continue;
        }
        let admittedChild = false;
        for (const childId of node.children) {
          const child = getTopic(state, childId);
          const childScore = score(childId);
          const leaf = child.children.length === 0;
          const entry = { id: childId, score: childScore, leaf, depth: candidate.depth + 1 };
          if (childScore >= admissionThreshold(child, config)) {
            admittedChild = true;
            next.push({ ...entry, admitted: true });
          } else if (leaf) {
            terminals.push({ ...entry, admitted: false });
          }
        }
        if (!admittedChild) terminals.push({ ...candidate, leaf: false });
      }
      next.sort((a, b) => b.score - a.score || compareStrings(a.id, b.id));
      frontier = next.slice(0, config.placement.beam);
    }
    const leaves = terminals
      .filter((candidate) => candidate.leaf)
      .sort((a, b) => b.score - a.score || compareStrings(a.id, b.id));
    const admittedLeaf = leaves.find((candidate) => candidate.admitted);
    if (admittedLeaf) {
      const competitor = leaves.find((candidate) => candidate.id !== admittedLeaf.id);
      return {
        topicId: admittedLeaf.id,
        admittedLeaf: true,
        margin: competitor ? admittedLeaf.score - competitor.score : null,
        score: admittedLeaf.score
      };
    }
    const internal = terminals
      .filter((candidate) => !candidate.leaf && candidate.admitted)
      .sort((a, b) => b.depth - a.depth || b.score - a.score || compareStrings(a.id, b.id))[0];
    return {
      topicId: internal?.id ?? from,
      admittedLeaf: false,
      margin: null,
      score: internal?.score ?? 0
    };
  }

  place(rows: readonly number[], options: PlaceOptions = {}): PlaceSummary {
    const started = performance.now();
    const state = this.current;
    const context = this.context();
    const { editor } = context;
    const summary: PlaceSummary = {
      placed: 0,
      ambiguous: 0,
      unadmitted: 0,
      gatedAtMargin: Object.fromEntries(reportedMargins.map((margin) => [String(margin), 0])),
      ms: 0,
      operations: {}
    };
    for (const row of rows) {
      const item = rowItemKey(row);
      if (primaryPlacement(state, item)) continue;
      if (!state.items.has(item)) {
        registerItem(state, {
          key: item,
          kind: "note",
          contentHash: rowContentHash(row),
          rootSource: null
        });
      }
      state.clock += 1;
      const decision = this.decide(item);
      editor.placeItem(item, placementRecord(decision.topicId, { decidedBy: "auto" }));
      addItemToPath(state, this.currentVectors, item, decision.topicId);
      this.dirty.add(decision.topicId);
      summary.placed += 1;
      if (!decision.admittedLeaf) summary.unadmitted += 1;
      else {
        const margin = decision.margin ?? 1;
        if (margin < this.input.config.placement.ambiguityMargin) summary.ambiguous += 1;
        for (const threshold of reportedMargins) {
          if (margin < threshold) {
            const key = String(threshold);
            summary.gatedAtMargin[key] = (summary.gatedAtMargin[key] ?? 0) + 1;
          }
        }
      }
      if (options.localRepair) {
        countOperations(repairDirty(context, this.dirty), summary.operations);
      } else if (getTopic(state, decision.topicId).items.length > this.input.config.leaf.hardMax) {
        // A leaf past its hard limit splits at once; everything else waits for REBALANCE.
        this.repairTopics(context, new Set([decision.topicId]), summary.operations, "hard");
      }
    }
    summary.ms = performance.now() - started;
    return summary;
  }

  private isHard(topicId: string): boolean {
    const { config } = this.input;
    if (!this.current.topics.has(topicId)) return false;
    const node = getTopic(this.current, topicId);
    if (!isLive(node)) return false;
    return node.children.length === 0
      ? node.items.length > config.leaf.hardMax
      : node.children.length > config.fanOut.hardMax;
  }

  /** A soft bound is broken on this topic (cooldowns aside): REBALANCE has work here. */
  private hasSoftViolation(id: string): boolean {
    const { config } = this.input;
    const node = getTopic(this.current, id);
    if (node.children.length === 0) {
      return (
        node.items.length > config.leaf.max ||
        (node.parentId !== null && node.items.length < config.leaf.min)
      );
    }
    return (
      (node.children.length === 1 && node.items.length === 0) ||
      node.items.length >= config.repair.directItemsSplitAt ||
      node.children.length > config.fanOut.max ||
      node.children.length < config.fanOut.targetMin
    );
  }

  /**
   * Repairs the queued topics one at a time, queuing what each operation touched. "hard" repairs
   * hard violations only; "soft" also applies the freeze and the daily budget. A topic left alone
   * stays dirty for the next REBALANCE, and a soft violation left alone is counted as deferred.
   */
  private repairTopics(
    context: ShapeContext,
    queue: Set<string>,
    operations: OperationCounts,
    mode: "soft" | "hard",
    skipped?: { frozen: number; budget: number }
  ): number {
    const { config } = this.input;
    const state = this.current;
    let moved = 0;
    for (let guard = 10_000; queue.size > 0 && guard > 0; guard -= 1) {
      const id = queue.values().next().value as string;
      queue.delete(id);
      if (!state.topics.has(id) || !isLive(getTopic(state, id))) continue;
      const hard = this.isHard(id);
      if (mode === "hard" && !hard) {
        this.dirty.add(id);
        continue;
      }
      if (!hard) {
        const total = getTopic(state, state.rootId).stats.n;
        const movedCap = Math.max(
          config.stability.dailyMovedMin,
          config.stability.dailyMovedShare * total
        );
        const frozen = this.frozen.has(id);
        const spent =
          state.budget.operations >= config.stability.dailyOperations ||
          state.budget.movedItems >= movedCap;
        if ((frozen || spent) && this.hasSoftViolation(id)) {
          if (skipped) skipped[frozen ? "frozen" : "budget"] += 1;
          this.dirty.add(id);
          continue;
        }
        if (frozen || spent) continue;
      }
      const operation = repairTopic(context, id, { force: false });
      if (!operation) continue;
      countOperations([operation], operations);
      moved += operation.movedItems;
      if (!hard) {
        state.budget.operations += 1;
        state.budget.movedItems += operation.movedItems;
      }
      for (const affected of affectedTopics(state, operation)) queue.add(affected);
    }
    return moved;
  }

  rebalance(context: RebalanceContext): RebalanceSummary {
    const state = this.current;
    if (context.day !== this.budgetDay) {
      this.budgetDay = context.day;
      state.budget = { day: `day-${context.day}`, operations: 0, movedItems: 0 };
    }
    // The simulated clock only matters as a retirement timestamp.
    this.now = new Date(Date.UTC(2026, 0, 1 + context.day)).toISOString();
    const operations: OperationCounts = {};
    const skipped = { frozen: 0, budget: 0 };
    const queue = new Set(this.dirty);
    this.dirty.clear();
    const movedItems = this.repairTopics(this.context(), queue, operations, "soft", skipped);
    return {
      operations,
      skippedFrozen: skipped.frozen,
      skippedBudget: skipped.budget,
      movedItems
    };
  }

  setFrozen(topicIds: ReadonlySet<string>): void {
    this.frozen = topicIds;
    for (const node of this.current.topics.values()) node.control.frozen = topicIds.has(node.id);
  }

  settle(): OperationCounts {
    this.dirty.clear();
    return countOperations(repairAll(this.context(), { force: true }));
  }
}

/** The Spike B incremental engine over the T03 primitives (see the file header). */
export const createReferenceEngine: ReplayEngineFactory = (input) => new ReferenceEngine(input);

export { ReferenceEngine };
