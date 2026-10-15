// The product engine in the offline replay (gate A, E3): the same `ReplayEngine` port as the
// Spike B reference, driven by the domain engine instead of a re-implementation.
//
// - build: the Louvain builder (identical to the reference, so both engines start from one tree).
// - PLACE: T07 `placeItem` per arrival (beam descent with node-relative admission, the gate rule's
//   fallback ancestor with `needs_gate`, "also in" secondaries) on the in-memory statistics (D7
//   allows add/subtract inside one engine run and in replay). PLACE never changes structure: a leaf
//   past its hard limit waits for the day's REBALANCE, which fixes hard violations first.
// - The gate: the replay has no ranker scores (the gate-score cache is empty until T23 descriptors
//   and a ranker run exist), so a gated item is resolved by one of two stand-ins, each through
//   T07 `applyGateResolution`: `baseline` accepts the best-scoring candidate (the margin-only
//   baseline that gate precision is reported against, D19, and what the reference engine does with
//   ambiguous items); `off` leaves it waiting at the fallback ancestor (no validated ranker).
// - REBALANCE: T08 `rebalanceTree` on the topics PLACE touched plus the checks it deferred
//   (cooldown, freeze, budget, unresolved hard violations), with its stability controls: acceptance
//   dQ - lambda * churn > 0, per-topic cooldown, the freeze on the "recently viewed" set (its items
//   weighted up in churn), the daily operation and move budgets, and Area-level operations as
//   proposals once Areas exist (D12; proposals are never applied in a replay).
// - AUDIT: T08 `auditTopicTree` before each REBALANCE (the service audits every
//   `audit.everyChangeSets` change-sets, several times a day at E3's arrival rate): drifted
//   statistics are recomputed and mis-parent findings with a re-parent target join the checks, so
//   they go through REBALANCE acceptance (D12).
// - Undo (optional): each day's REBALANCE change-set is undone on a copy of the tree with T07
//   `undoChangeSet` and must restore the pre-REBALANCE canonical dump byte for byte.
// - Rebuilds (E3 step 3) are not evaluated: the domain maps a rebuild (rebuild-map.ts) but has no
//   trigger evaluation yet (T19), so, as with the reference, no rebuild runs in the replay.
//
// Every row is a note (the DS-C stores hold notes only), exactly the reference's item set; root
// sources and their vectors (D8) need app exports with source rows (T22a) and are not modelled.
import { createHash } from "node:crypto";

import {
  applyGateResolution,
  auditTopicTree,
  buildLouvain,
  canonicalStateDump,
  canonicalTopicTreeConfig,
  cloneTopicTreeState,
  createTopicTreeEditor,
  createTopicTreeState,
  decidePlacement,
  getTopic,
  isLive,
  placeItem,
  primaryPlacement,
  rebalanceTree,
  recomputePaths,
  registerItem,
  rowContentHash,
  rowItemKey,
  rowVectors,
  rowView,
  setFrozenTopics,
  topicTreeConfigWith,
  undoChangeSet
} from "@app/domain/topic-tree";
import type {
  BuildResult,
  GateResolution,
  ItemKey,
  ItemVectorSource,
  PlacementContext,
  PlacementDecision,
  RebalanceInput,
  RebalanceResult,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

import { reportedMargins } from "./reference-engine.js";
import type {
  BuildSummary,
  EngineAuditSummary,
  OperationCounts,
  PlaceOptions,
  PlaceSummary,
  RebalanceContext,
  RebalanceSummary,
  ReplayEngine,
  ReplayEngineFactory,
  ReplayEngineInput,
  ReplayGate
} from "./reference-engine.js";

export const replayGates: readonly ReplayGate[] = ["baseline", "off"];

export interface RealEngineOptions {
  /** How gated items are resolved in the replay (see the file header). Default `baseline`. */
  gate?: ReplayGate;
  /**
   * The root's band is the Areas band and Area-level operations are proposals (D12). The product
   * applies Areas at bootstrap, so a library of E3's size has them. Default true.
   */
  areasActive?: boolean;
  /** Audit before every REBALANCE (default true). */
  audit?: boolean;
  /** Undo every REBALANCE change-set on a copy and compare the dump (default false). */
  undoCheck?: boolean;
  /**
   * Base builds shared between engines (calibration grids replay one base under many stability
   * settings). The key covers the seed, the rows and every setting the builder reads.
   */
  buildCache?: Map<string, { result: BuildResult; summary: BuildSummary }>;
}

/**
 * Stability budgets that constrain nothing: unlimited daily operations and moves. Cooldowns and
 * the per-operation churn bound are Spike B's own repair settings and stay; the freeze is the
 * replay's (none in growth runs). Lambda is left as configured on purpose: besides accepting an
 * operation (dQ - lambda * churn > 0) it chooses between the fixes of one condition (a sideways or
 * a downward split), and at 0 REBALANCE takes the largest dQ whatever it moves, which builds a
 * deeper tree than Spike B's split rule (measured at gate A: +0.14 to +0.25 mean depth).
 */
export function neutralStability(config: TopicTreeConfig): TopicTreeConfig {
  return topicTreeConfigWith(
    {
      stability: {
        dailyOperations: 100_000,
        dailyMovedShare: 1,
        dailyMovedMin: 1_000_000
      }
    },
    config
  );
}

/** Builder inputs only: stability and the soft-repair limits a forced build pass ignores. */
function buildKey(seed: number, rows: readonly number[], config: TopicTreeConfig): string {
  const parsed = JSON.parse(canonicalTopicTreeConfig(config)) as Record<string, unknown>;
  delete parsed.stability;
  const repair = { ...(parsed.repair as Record<string, unknown>) };
  delete repair.cooldownInserts;
  delete repair.softMoveShare;
  parsed.repair = repair;
  const hash = createHash("sha256");
  hash.update(JSON.stringify(parsed));
  hash.update(Int32Array.from(rows));
  return `${seed}:${rows.length}:${hash.digest("hex")}`;
}

const dayInstant = (day: number): string =>
  new Date(Date.UTC(2026, 0, 1) + day * 86_400_000).toISOString();

function addCount(into: OperationCounts, kind: string, by = 1): void {
  const key = kind as keyof OperationCounts;
  into[key] = (into[key] ?? 0) + by;
}

const deferredReasons: ReadonlySet<string> = new Set(["cooldown", "frozen", "budget"]);

class RealEngine implements ReplayEngine {
  readonly name: string;
  private current: TopicTreeState;
  private currentVectors: ItemVectorSource;
  private nextTopicId = 1;
  private readonly dirty = new Set<string>();
  private frozenItems: ReadonlySet<ItemKey> = new Set();
  private day = 0;
  readonly gate: ReplayGate;
  private readonly areasActive: boolean;
  private readonly runAudit: boolean;
  private readonly undoCheck: boolean;
  private auditSummary: EngineAuditSummary = {
    audits: 0,
    reparentCandidates: 0,
    driftedTopics: 0,
    undoChecked: 0,
    undoExact: 0
  };

  constructor(
    private readonly input: ReplayEngineInput,
    private readonly options: RealEngineOptions
  ) {
    this.gate = options.gate ?? "baseline";
    this.areasActive = options.areasActive ?? true;
    this.runAudit = options.audit ?? true;
    this.undoCheck = options.undoCheck ?? false;
    this.name = `t07-t08/gate-${this.gate}`;
    this.current = createTopicTreeState({ dim: input.matrix.dim, rootId: "0" });
    this.currentVectors = rowVectors(input.matrix);
  }

  get state(): TopicTreeState {
    return this.current;
  }

  get vectors(): ItemVectorSource {
    return this.currentVectors;
  }

  build(rows: readonly number[]): BuildSummary {
    const { input } = this;
    const key = this.options.buildCache ? buildKey(input.seed, rows, input.config) : null;
    let cached = key === null ? undefined : this.options.buildCache?.get(key);
    if (!cached) {
      const started = performance.now();
      const result = buildLouvain(input.matrix, rows, {
        seed: input.seed,
        config: input.config,
        detectCommunities: input.detect
      });
      cached = {
        result,
        summary: {
          rows: rows.length,
          knnMs: result.timings.knnMs,
          communitiesMs: result.timings.communitiesMs,
          repairMs: result.timings.repairMs,
          totalMs: performance.now() - started,
          repairs: result.repairs.length
        }
      };
      if (key !== null) this.options.buildCache?.set(key, cached);
    }
    // A cached build is shared: every engine works on its own copy.
    this.current = key === null ? cached.result.state : cloneTopicTreeState(cached.result.state);
    this.currentVectors = cached.result.vectors;
    this.nextTopicId = Math.max(...[...this.current.topics.keys()].map(Number)) + 1;
    this.dirty.clear();
    return { ...cached.summary };
  }

  private now(): string {
    return dayInstant(this.day);
  }

  private placementContext(): PlacementContext {
    return {
      state: this.current,
      vectors: this.currentVectors,
      config: this.input.config,
      editor: createTopicTreeEditor(this.current, { record: false }),
      now: this.now()
    };
  }

  /** Where re-admission below `from` puts an item (absorb-direct), or null to leave it. */
  private readmit(item: ItemKey, from: string): string | null {
    const row = this.currentVectors.rowOf(item);
    if (row === undefined) return null;
    const decision = decidePlacement(
      this.current,
      this.input.config,
      rowView(this.currentVectors.matrix, row),
      { from }
    );
    const target =
      decision.kind === "gate" && this.gate === "baseline"
        ? decision.best.topicId
        : decision.topicId;
    return target === from ? null : target;
  }

  private rebalanceInput(overrides: Partial<RebalanceInput>): RebalanceInput {
    return {
      state: this.current,
      vectors: this.currentVectors,
      config: this.input.config,
      seed: this.input.seed,
      now: this.now(),
      day: this.now().slice(0, 10),
      newTopicId: () => String(this.nextTopicId++),
      recentItems: this.frozenItems,
      areasActive: this.areasActive,
      readmit: (item, from) => this.readmit(item, from),
      ...overrides
    };
  }

  /** REBALANCE on the dirty topics; what it deferred stays dirty for the next run. */
  private rebalanceDirty(): RebalanceResult {
    const topics = [...this.dirty];
    this.dirty.clear();
    const result = rebalanceTree(this.rebalanceInput({ topics }));
    for (const skip of result.skipped) {
      if (deferredReasons.has(skip.reason)) this.dirty.add(skip.topicId);
    }
    for (const hard of result.unresolvedHard) this.dirty.add(hard.topicId);
    return result;
  }

  private static count(result: RebalanceResult, into: OperationCounts = {}): OperationCounts {
    for (const operation of result.applied) addCount(into, operation.kind);
    return into;
  }

  private resolveGate(context: PlacementContext, item: ItemKey, decision: PlacementDecision): void {
    if (decision.kind !== "gate" || this.gate !== "baseline") return;
    const resolution: GateResolution = {
      kind: "accept",
      topicId: decision.best.topicId,
      probability: 1,
      noneProbability: 0,
      probabilities: decision.candidates.map((candidate) =>
        candidate.topicId === decision.best.topicId ? 1 : 0
      )
    };
    applyGateResolution(context, item, resolution, { candidates: decision.candidates });
  }

  place(rows: readonly number[], options: PlaceOptions = {}): PlaceSummary {
    const started = performance.now();
    const state = this.current;
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
      const context = this.placementContext();
      const outcome = placeItem(context, item, { fingerprint: item });
      const decision = outcome.decision;
      if (decision === null) continue;
      summary.placed += 1;
      if (decision.kind === "unadmitted") summary.unadmitted += 1;
      else {
        if (decision.kind === "gate") summary.ambiguous += 1;
        const margin = decision.margin ?? 1;
        for (const threshold of reportedMargins) {
          if (margin < threshold) {
            const key = String(threshold);
            summary.gatedAtMargin[key] = (summary.gatedAtMargin[key] ?? 0) + 1;
          }
        }
        this.resolveGate(context, item, decision);
      }
      const topicId = primaryPlacement(state, item)?.topicId;
      if (topicId !== undefined) this.dirty.add(topicId);
      if (options.localRepair) RealEngine.count(this.rebalanceDirty(), summary.operations);
    }
    summary.ms = performance.now() - started;
    return summary;
  }

  /** The audit before a REBALANCE: exact stats where they drifted, re-parent checks queued. */
  private audit(): void {
    const audit = auditTopicTree(this.current, this.currentVectors, this.input.config, {
      seed: this.input.seed + this.day,
      areasActive: this.areasActive,
      expectedItems: []
    });
    this.auditSummary.audits += 1;
    this.auditSummary.reparentCandidates += audit.reparentCandidates.length;
    this.auditSummary.driftedTopics += audit.recomputeTopics.length;
    if (audit.recomputeTopics.length > 0) {
      recomputePaths(this.current, this.currentVectors, audit.recomputeTopics);
    }
    for (const finding of audit.reparentCandidates) {
      if (!finding.protected) this.dirty.add(finding.topicId);
    }
  }

  rebalance(context: RebalanceContext): RebalanceSummary {
    this.day = context.day;
    if (this.runAudit) this.audit();
    const before = this.undoCheck ? canonicalStateDump(this.current) : null;
    const result = this.rebalanceDirty();
    if (before !== null && result.events.length > 0) this.checkUndo(result, before);
    const reasons = (reason: string): number =>
      new Set(result.skipped.filter((skip) => skip.reason === reason).map((skip) => skip.topicId))
        .size;
    return {
      operations: RealEngine.count(result),
      skippedFrozen: reasons("frozen"),
      skippedBudget: reasons("budget"),
      skippedCooldown: reasons("cooldown"),
      proposals: result.proposals.length,
      movedItems: result.churn.items
    };
  }

  /** Undoes the REBALANCE change-set on a copy: the dump must equal the one taken before it. */
  private checkUndo(result: RebalanceResult, before: string): void {
    const copy = cloneTopicTreeState(this.current);
    const undone = undoChangeSet(
      copy,
      this.input.config,
      { id: `rebalance-${this.day}`, status: "applied", undoOf: null, events: result.events },
      []
    );
    this.auditSummary.undoChecked += 1;
    if (undone.kind === "undone" && canonicalStateDump(copy) === before) {
      this.auditSummary.undoExact += 1;
    }
  }

  setFrozen(topicIds: ReadonlySet<string>): void {
    setFrozenTopics(this.current, topicIds);
    const items = new Set<ItemKey>();
    for (const id of topicIds) {
      const node = this.current.topics.get(id);
      if (!node || !isLive(node)) continue;
      for (const item of getTopic(this.current, id).items) items.add(item);
    }
    this.frozenItems = items;
  }

  settle(): OperationCounts {
    this.dirty.clear();
    return RealEngine.count(rebalanceTree(this.rebalanceInput({ force: true })));
  }

  /** Audit and undo-check counters since the engine was created. */
  engineAudit(): EngineAuditSummary {
    return { ...this.auditSummary };
  }
}

/** A factory of the product engine with the given replay options. */
export function createRealEngineFactory(options: RealEngineOptions = {}): ReplayEngineFactory {
  return (input) => new RealEngine(input, options);
}

/** The product engine with the default replay options (gate `baseline`, Areas active, audit on). */
export const createRealEngine: ReplayEngineFactory = createRealEngineFactory();

export { RealEngine };
