// The placement gate (F2 T23, D10): the `topic-gate` job on the light lane's `model` worker. PLACE
// never waits for AI: an ambiguous item waits at the deepest admitted common ancestor of its best
// leaves with `needs_gate`, and this job lets the decider choose among at most
// `gate.maxCandidates` leaves, or "none of these". Only a validated dedicated ranker decides
// (D17): the `op:topic_gate` route, else `class:decide`, never a generative model.
//
// Without a ready route (owner decision 19, which replaces D10's "gated notes wait") the job gives
// the waiting items the gate's "none" with no call (`applyNoDeciderFallback`: `needs_split_check`,
// `decided_by = fallback-none`), so REBALANCE may group them into new topics, and the status says
// `no_decider`. PLACE does the same at once when it finds no decider. Once a route is ready (found
// by the recheck timer, by the next committed change or by the next gate job) the sweep enqueues
// every scope with waiting or fallback items, and this job decides the fallback items again
// wherever REBALANCE moved them, without waiting for a restart.
//
// One job is one scope: a root source with its notes, or one note without a root.
// 1. In the engine's turn, with no model call (D10): the waiting items are decided again exactly as
//    PLACE decides (gate.ts `decideWaitingItems`). An item that is no longer ambiguous is placed by
//    that decision in step 3; for the others the candidates and what describes them are copied.
// 2. Outside the engine lock: the texts are read, the item's query and the candidates' descriptors
//    are built in content-key order (D22) and the decision cache (`topic_gate_decisions`, keyed by
//    query, descriptor set and decider) is read; a miss is one `rank` call (background queue,
//    audited with the scope's root source). p = softmax([logOdds..., tau] / T): the best candidate
//    is accepted when p >= theta, otherwise "none" (the item waits with `needs_split_check`).
//    Every new decision is recorded with its raw log-odds and the ranker's truncation flags.
// 3. In the engine's turn again: a decision is applied while the item still waits with the same
//    vector and, when the tree moved meanwhile, its candidates are still the same leaves; anything
//    else waits for the next gate job. One `gate` change-set with exact statistics (D7).
//
// G1 (D23): a deterministic golden run makes no gate call (nothing is enqueued, and a job left from
// another run is skipped). Gate calls are local and cost nothing, so D34's daily cap does not apply.
import { createHash } from "node:crypto";

import {
  createAiConfigRepository,
  createAtomicNoteRepository,
  createLocalModelRepository,
  createSourceItemRepository,
  createTopicNamingRepository,
  createTopicTreeRepository,
  operationRouteKey,
  topicStatsWrites,
  workloadClassRouteKey
} from "@app/db";
import type { JobRecord, JsonObject, PgPool } from "@app/db";
import { isBackgroundBlocked, topicLimits } from "@app/domain";
import {
  applyGateResolution,
  applyNoDeciderFallback,
  awaitsGateDecision,
  centralItems,
  compareContentKeys,
  createTopicTreeEditor,
  decideWaitingItems,
  gateCacheKeys,
  gateDeciderKey,
  gateDescriptor,
  gateNoteQuery,
  gateScores,
  gateSourceQuery,
  isLive,
  itemKey,
  parseItemKey,
  pathOf,
  placeItem,
  placementsOf,
  primaryPlacement,
  recomputePaths,
  resolveGate,
  sourceCentralNotes,
  topicsWithStaleStats,
  unrankedGateResolution
} from "@app/domain/topic-tree";
import type {
  GateResolution,
  ItemKey,
  PlacementContext,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

import { jobTaskPayload } from "../../job-task-payload.js";
import type { AiService, DecideRouteStatus } from "../ai-service.js";
import { buildCatalogMetadataMarkdown } from "../hierarchical-ingestion-service.js";
import { localDay } from "./topic-ai.js";
import type { TopicAiMode } from "./topic-ai.js";
import type { TopicTreeCache } from "./topic-cache.js";
import type { TopicChangeCoalescer, TopicsChangedEvent } from "./topic-changes.js";
import { TopicScopedPayloadSchema, scopeKey, scopeOfPayload, topicJobTypes } from "./topic-jobs.js";
import type { TopicScope } from "./topic-jobs.js";
import { topicGateInstruction } from "./topic-prompts.js";
import type { TopicTreeService } from "./topic-tree-service.js";
import type { TopicTriggers } from "./topic-triggers.js";

/** The AI operation of the gate: `op:topic_gate` may route it before `class:decide`. */
export const topicGateOperation = "topic_gate";

/** What the gate needs of the AI service: the validated ranker and its route's readiness. */
export type GateAi = Pick<AiService, "rank" | "decideRouteStatus">;

/** Bounds of the gate service's own work (gate parameters live in the tree's configuration). */
export const topicGateLimits = {
  /** Waiting items one job decides; a scope with more asks for another job. */
  itemsPerJob: 200,
  /** Central members read per example title a descriptor shows (titles repeat across notes). */
  examplesPerTitle: 3,
  /** Commit attempts of one job after generation or event conflicts. */
  commitAttempts: 3,
  /** Decisions a change-set summary lists. */
  summaryDecisions: 100,
  /**
   * While no route is ready the route is checked again: a committed change checks it at most this
   * often, and a timer checks it this often when nothing is committed, so a ranker validated in
   * the middle of a session is found without a change of the tree.
   */
  routeRecheckMs: 60_000
} as const;

/** Route problems: the ranker is gone or not validated, so the items keep waiting (D10). */
const routeErrors = new Set([
  "errors.ai.noCompatibleModel",
  "errors.ai.unsupportedTask",
  "errors.localModels.notReady",
  "errors.localModels.rankerNotValidated"
]);

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The ranker a decider key names: its local model and the key. */
export interface GateDecider {
  localModelId: string;
  key: string;
}

export interface TopicGateOptions {
  getPool: () => PgPool | null;
  /** The engine: its turn (`runOnTree`) and its cache. */
  service: Pick<TopicTreeService, "runOnTree" | "invalidate">;
  ai: GateAi;
  aiMode: TopicAiMode;
  triggers: TopicTriggers;
  changes: TopicChangeCoalescer;
  /** An applied gate change-set: the leaves it filled wait for REBALANCE (I4), as after PLACE. */
  onChangeSet?: (change: {
    treeId: string;
    changeSetId: string;
    generation: number;
  }) => Promise<void> | void;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// What step 1 copies out of the engine

interface PlannedCandidate {
  topicId: string;
  cosine: number;
  labelCosine: number | null;
  title: string | null;
  description: string | null;
  aliases: string[];
  /** Central members of the leaf, nearest its centroid first (their titles are the examples). */
  examples: ItemKey[];
}

interface PlannedItem {
  key: ItemKey;
  kind: "note" | "source";
  id: string;
  fingerprint: string | null;
  /** The root source behind the item (the audit's participating source). */
  rootSourceId: string | null;
  /** `redecide`: the item is no longer ambiguous and PLACE's decision applies. */
  action: "rank" | "redecide";
  /** Flagged `needs_gate` (otherwise a `fallback-none` item a ranker decides again). */
  needsGate: boolean;
  candidates: PlannedCandidate[];
  /** For a root source: its notes nearest its vector (their titles are the query's `Notes`). */
  sourceNotes: ItemKey[];
}

interface GatePlan {
  generation: number;
  config: TopicTreeConfig;
  /** A ranker decides (otherwise the no-decider fallback of owner decision 19 applies). */
  ranked: boolean;
  items: PlannedItem[];
  /** Waiting items left for another job (`itemsPerJob`). */
  more: boolean;
}

/** What step 2 decided for one item (`fallback`: no decider, owner decision 19). */
type ItemOutcome =
  | { kind: "redecide" }
  | { kind: "fallback" }
  | {
      kind: "resolved";
      resolution: GateResolution;
      cached: boolean;
      aiTaskRunId: string | null;
      /** Wall time of the rank call (null for a cache hit or an unranked item). */
      rankMs: number | null;
    };

interface RankRun {
  calls: number;
  cacheHits: number;
  unranked: number;
  truncated: number;
  inputTokens: number;
  rankMs: number[];
  aiTaskRunIds: string[];
}

interface ApplyResult {
  status: "applied" | "no_change" | "tree_inactive" | "deferred";
  changeSetId?: string;
  generation?: number;
  accepted: number;
  none: number;
  redecided: number;
  /** Items given the gate's "none" without a decider (`fallback-none`, decision 19). */
  fallback: number;
  /** Items whose candidates changed or that no longer waited with the same vector. */
  stale: number;
  /** Items left waiting for the next gate job (the tree moved under their candidates). */
  deferred: number;
}

/**
 * Items of a scope whose primary placement waits for the gate, in content-key order (D22): flagged
 * `needs_gate`, plus, when a ranker can decide (`ranked`), the no-decider fallback's items.
 */
function waitingItems(state: TopicTreeState, scope: TopicScope, ranked: boolean): ItemKey[] {
  const waits = (key: ItemKey) => {
    const primary = primaryPlacement(state, key);
    return ranked ? awaitsGateDecision(primary) : primary?.needsGate === true;
  };
  const keys: ItemKey[] = [];
  if ("noteId" in scope) {
    const key = itemKey("note", scope.noteId);
    if (state.items.has(key) && waits(key)) keys.push(key);
  } else {
    const root = itemKey("source", scope.rootSourceId);
    for (const entry of state.items.values()) {
      if (entry.key !== root && entry.rootSource !== root) continue;
      if (waits(entry.key)) keys.push(entry.key);
    }
  }
  return keys.sort((a, b) => compareContentKeys(state.items.get(a)!, state.items.get(b)!));
}

const sameTopics = (a: readonly { topicId: string }[], b: readonly { topicId: string }[]) =>
  a.length === b.length &&
  [...a.map((entry) => entry.topicId)].sort().join() ===
    [...b.map((entry) => entry.topicId)].sort().join();

function liveTopics(state: TopicTreeState, ids: Iterable<string>): string[] {
  const output = new Set<string>();
  for (const id of ids) {
    const node = state.topics.get(id);
    if (node && isLive(node)) output.add(id);
  }
  return [...output];
}

/** Every live topic on the paths from `ids` to the root. */
function pathsOf(state: TopicTreeState, ids: Iterable<string>): string[] {
  const output = new Set<string>();
  for (const id of liveTopics(state, ids)) for (const topic of pathOf(state, id)) output.add(topic);
  return [...output].sort();
}

/** The topics an item's statistics contribution may touch: its placements and its root's. */
function contributionTopics(state: TopicTreeState, key: ItemKey): string[] {
  const topics = placementsOf(state, key).map((placement) => placement.topicId);
  const root = state.items.get(key)?.rootSource;
  if (root) topics.push(...placementsOf(state, root).map((placement) => placement.topicId));
  return topics;
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

export class TopicGateService {
  /** The last route check found no ready ranker: items wait, and the next ready check sweeps. */
  private routeBlocked = false;
  private lastRouteCheck = 0;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  public constructor(private readonly options: TopicGateOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }

  // -------------------------------------------------------------------------
  // The route

  /** The gate's route: `ready` or why not; an error reads as `missing` (never throws). */
  private async routeStatus(): Promise<DecideRouteStatus> {
    this.lastRouteCheck = this.now().getTime();
    try {
      return await this.options.ai.decideRouteStatus(topicGateOperation);
    } catch (error) {
      this.options.logger?.warn("The topic gate route could not be read", error);
      return "missing";
    }
  }

  /**
   * True when items wait for a gate decision (flagged, or decided by the no-decider fallback) and
   * no validated ranker can decide them (`no_decider`, an informative status). Never throws.
   */
  public async waitingForDecider(waiting: number): Promise<boolean> {
    if (waiting <= 0 || this.options.aiMode !== "full") return false;
    return !(await this.deciderReady(waiting));
  }

  /**
   * Whether a validated ranker can decide gated items now (owner decision 19: PLACE and the sweep
   * ask). While `waiting` items owe it a decision and none is ready, the route is checked again
   * until one is, which sweeps them in (T26f). Never throws: an unreadable route is not ready.
   */
  public async deciderReady(waiting: number): Promise<boolean> {
    const ready = (await this.routeStatus()) === "ready";
    if (!ready && waiting > 0) this.block();
    return ready;
  }

  /**
   * The `topicsChanged` listener: while no route was ready, a committed change checks the route
   * at most every `routeRecheckMs`, and a ready one asks the sweep to enqueue the waiting scopes.
   */
  public readonly onTopicsChanged = (event: TopicsChangedEvent): void => {
    if (!this.routeBlocked || this.options.aiMode !== "full") return;
    if (this.now().getTime() - this.lastRouteCheck < topicGateLimits.routeRecheckMs) return;
    void this.routeStatus()
      .then((status) => (status === "ready" ? this.routeReady(event.treeId) : undefined))
      .catch((error: unknown) => this.options.logger?.warn("Topic gate route check", error));
  };

  /** A route is ready after none was: the sweep enqueues every scope that waits (D10). */
  private async routeReady(treeId?: string): Promise<void> {
    if (!this.routeBlocked) return;
    this.routeBlocked = false;
    this.stopRecheck();
    await this.options.triggers.sweep("requested", treeId === undefined ? {} : { treeId });
  }

  /** Items wait and no route can decide them: the route is checked again on a timer too. */
  private block(): void {
    this.routeBlocked = true;
    if (this.recheckTimer !== null || this.disposed || this.options.aiMode !== "full") return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      void this.recheckRoute().catch((error: unknown) =>
        this.options.logger?.warn("Topic gate route check", error)
      );
    }, topicGateLimits.routeRecheckMs);
    // The check never keeps the process alive.
    this.recheckTimer.unref?.();
  }

  private stopRecheck(): void {
    if (this.recheckTimer !== null) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
  }

  /**
   * Reads the route again while items wait for a decider: a ready route sweeps them in (the active
   * tree), a route that is still not ready is checked again after the recheck interval.
   */
  public async recheckRoute(): Promise<void> {
    if (!this.routeBlocked || this.disposed || this.options.aiMode !== "full") return;
    if ((await this.routeStatus()) === "ready") await this.routeReady();
    else this.block();
  }

  /** Stops the recheck timer (the services were disposed). */
  public dispose(): void {
    this.disposed = true;
    this.stopRecheck();
  }

  // -------------------------------------------------------------------------
  // The job

  public async runGate(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const payload = TopicScopedPayloadSchema.parse(jobTaskPayload(job.payload));
    const scope = scopeOfPayload(payload);
    const treeId = payload.treeId;
    const base = { treeId, scope: scopeKey(scope) };
    if (this.options.aiMode !== "full")
      return { ...base, status: "skipped", reason: "deterministic" };
    const started = performance.now();
    const route = await this.routeStatus();
    if (route !== "ready") {
      this.block();
      return this.fallBack(job, treeId, scope, { ...base, route }, started);
    }
    if (this.routeBlocked) await this.routeReady(treeId);

    // 1. The waiting items and their candidates, in the engine's turn.
    const plan = await this.options.service.runOnTree(treeId, async (cache) =>
      this.plan(cache, scope, true)
    );
    if (!plan) return { ...base, status: "tree_inactive" };
    if (plan.items.length === 0) return { ...base, status: "nothing_waiting" };
    if (signal.aborted) throw new Error("topics.errors.canceled");

    // 2. The decider, outside the engine lock.
    const run: RankRun = {
      calls: 0,
      cacheHits: 0,
      unranked: 0,
      truncated: 0,
      inputTokens: 0,
      rankMs: [],
      aiTaskRunIds: []
    };
    const { outcomes, failure } = await this.decide(job, treeId, plan, run, signal);
    await this.recordCalls(treeId, run.calls);
    if (failure === "no_decider") {
      // The ranker went away mid-run: the items it did not decide get the fallback (decision 19).
      for (const item of plan.items)
        if (item.action === "rank" && !outcomes.has(item.key) && item.needsGate)
          outcomes.set(item.key, { kind: "fallback" });
    }

    // 3. The decisions, in the engine's turn.
    const applied =
      outcomes.size === 0 ? null : await this.apply(job, treeId, scope, plan, outcomes, run);
    if (applied?.status === "tree_inactive") return { ...base, status: "tree_inactive" };
    if (applied?.changeSetId && applied.generation !== undefined) {
      await this.followChangeSet(treeId, applied.changeSetId, applied.generation);
    }
    const left = (applied?.deferred ?? 0) > 0 || plan.more;
    if (left && !failure) await this.options.triggers.request(topicJobTypes.gate, treeId, scope);
    const result: JsonObject = {
      ...base,
      status: failure === "no_decider" ? "no_decider" : (applied?.status ?? "no_change"),
      items: plan.items.length,
      ...(applied?.changeSetId ? { changeSetId: applied.changeSetId } : {}),
      ...(applied?.generation === undefined ? {} : { generation: applied.generation }),
      accepted: applied?.accepted ?? 0,
      none: applied?.none ?? 0,
      redecided: applied?.redecided ?? 0,
      fallback: applied?.fallback ?? 0,
      stale: applied?.stale ?? 0,
      deferred: applied?.deferred ?? 0,
      calls: run.calls,
      cacheHits: run.cacheHits,
      unranked: run.unranked,
      truncated: run.truncated,
      inputTokens: run.inputTokens,
      rankMs: run.rankMs.map((ms) => round(ms, 1)),
      continues: left,
      ms: round(performance.now() - started, 1)
    };
    if (failure instanceof Error) {
      this.options.logger?.warn(`Topic gate ${job.id} stopped`, failure);
      throw failure;
    }
    if (failure === "no_decider") this.block();
    return result;
  }

  /**
   * No validated decider (owner decision 19): the scope's items that wait with `needs_gate` get
   * the gate's "none" without a call (`fallback-none`), in one `gate` change-set, so REBALANCE may
   * group them; items that are no longer ambiguous take PLACE's decision. Once a ranker is ready
   * the sweep sends them back here and they are decided again.
   */
  private async fallBack(
    job: JobRecord,
    treeId: string,
    scope: TopicScope,
    base: JsonObject,
    started: number
  ): Promise<JsonObject> {
    const plan = await this.options.service.runOnTree(treeId, async (cache) =>
      this.plan(cache, scope, false)
    );
    if (!plan) return { ...base, status: "tree_inactive" };
    if (plan.items.length === 0) return { ...base, status: "no_decider", items: 0, fallback: 0 };
    const outcomes = new Map<ItemKey, ItemOutcome>(
      plan.items.map((item) => [
        item.key,
        item.action === "rank" ? { kind: "fallback" } : { kind: "redecide" }
      ])
    );
    const run: RankRun = {
      calls: 0,
      cacheHits: 0,
      unranked: 0,
      truncated: 0,
      inputTokens: 0,
      rankMs: [],
      aiTaskRunIds: []
    };
    const applied = await this.apply(job, treeId, scope, plan, outcomes, run);
    if (applied.status === "tree_inactive") return { ...base, status: "tree_inactive" };
    if (applied.changeSetId && applied.generation !== undefined) {
      await this.followChangeSet(treeId, applied.changeSetId, applied.generation);
    }
    const left = applied.deferred > 0 || plan.more;
    if (left) await this.options.triggers.request(topicJobTypes.gate, treeId, scope);
    return {
      ...base,
      status: "no_decider",
      items: plan.items.length,
      ...(applied.changeSetId ? { changeSetId: applied.changeSetId } : {}),
      ...(applied.generation === undefined ? {} : { generation: applied.generation }),
      fallback: applied.fallback,
      redecided: applied.redecided,
      stale: applied.stale,
      deferred: applied.deferred,
      continues: left,
      ms: round(performance.now() - started, 1)
    };
  }

  // -------------------------------------------------------------------------
  // Step 1: the plan

  /**
   * The waiting items of a scope and what describes their candidates. `ranked`: a ranker will
   * decide, so the no-decider fallback's items are decided again too.
   */
  private plan(cache: TopicTreeCache, scope: TopicScope, ranked: boolean): GatePlan {
    const { state, vectors, config } = cache;
    const all = waitingItems(state, scope, ranked);
    const keys = all.slice(0, topicGateLimits.itemsPerJob);
    const decisions = decideWaitingItems(state, vectors, config, keys);
    const exampleCount = config.gate.descriptorExamples * topicGateLimits.examplesPerTitle;
    const items: PlannedItem[] = [];
    for (const key of keys) {
      const decision = decisions.get(key);
      const entry = state.items.get(key)!;
      const primary = primaryPlacement(state, key)!;
      if (!decision) continue; // no current vector: the item keeps waiting for one
      const parsed = parseItemKey(key)!;
      const root = entry.kind === "source" ? key : entry.rootSource;
      const candidates =
        decision.kind === "gate"
          ? decision.candidates.map((candidate): PlannedCandidate => {
              const node = state.topics.get(candidate.topicId)!;
              return {
                topicId: candidate.topicId,
                cosine: candidate.cosine,
                labelCosine: candidate.labelCosine,
                title: node.title,
                description: node.description,
                aliases: [...node.aliases],
                examples: centralItems(state, vectors, candidate.topicId, exampleCount).map(
                  (item) => item.key
                )
              };
            })
          : [];
      items.push({
        key,
        kind: entry.kind,
        id: parsed.id,
        fingerprint: primary.itemFingerprint,
        rootSourceId: root ? parseItemKey(root)!.id : null,
        action: decision.kind === "gate" ? "rank" : "redecide",
        needsGate: primary.needsGate,
        candidates,
        sourceNotes:
          entry.kind === "source" && decision.kind === "gate"
            ? sourceCentralNotes(
                state,
                vectors,
                key,
                config.gate.sourceQueryNoteTitles * topicGateLimits.examplesPerTitle
              )
            : []
      });
    }
    return {
      generation: cache.tree.generation,
      config,
      ranked,
      items,
      more: all.length > keys.length
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: the decider

  /** The decider key of a local model (its artifact and the instruction). */
  private async deciderFor(
    localModelId: string,
    instruction: string,
    known: Map<string, GateDecider | null>
  ): Promise<GateDecider | null> {
    if (known.has(localModelId)) return known.get(localModelId) ?? null;
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    const decider = model
      ? {
          localModelId,
          key: gateDeciderKey(
            {
              runtime: model.runtime,
              repository: model.repository,
              revision: model.revision,
              quantization: model.quantization,
              instruction
            },
            sha256
          )
        }
      : null;
    known.set(localModelId, decider);
    return decider;
  }

  /** The ranker the gate's route names now (read without loading it). */
  private async routedDecider(
    instruction: string,
    known: Map<string, GateDecider | null>
  ): Promise<GateDecider | null> {
    const decide = workloadClassRouteKey("decide");
    const selection = await createAiConfigRepository(this.requirePool()).getDefaultTask(
      decide,
      undefined,
      [operationRouteKey(topicGateOperation), decide]
    );
    return selection?.localModelId
      ? this.deciderFor(selection.localModelId, instruction, known)
      : null;
  }

  /**
   * Decides every planned item: cached decisions first, a rank call for each miss. Stops at the
   * first route problem (`no_decider`) or other failure and returns what was decided before it.
   */
  private async decide(
    job: JobRecord,
    treeId: string,
    plan: GatePlan,
    run: RankRun,
    signal: AbortSignal
  ): Promise<{ outcomes: Map<ItemKey, ItemOutcome>; failure: "no_decider" | Error | null }> {
    const pool = this.requirePool();
    const outcomes = new Map<ItemKey, ItemOutcome>();
    for (const item of plan.items)
      if (item.action === "redecide") outcomes.set(item.key, { kind: "redecide" });
    const ranked = plan.items.filter((item) => item.action === "rank");
    if (ranked.length === 0) return { outcomes, failure: null };

    const texts = await this.readTexts(pool, ranked);
    const instruction = topicGateInstruction();
    const known = new Map<string, GateDecider | null>();
    let decider = await this.routedDecider(instruction, known);
    const repository = createTopicTreeRepository(pool);
    const gate = plan.config.gate;

    for (const item of ranked) {
      if (signal.aborted) throw new Error("topics.errors.canceled");
      const query = this.queryOf(item, texts, gate);
      if (query === null) continue; // the item is gone: PLACE or the sweep takes it out
      const keys = gateCacheKeys(
        query,
        item.candidates.map((candidate) => ({
          topicId: candidate.topicId,
          descriptor: gateDescriptor(
            {
              title: candidate.title,
              description: candidate.description,
              aliases: candidate.aliases,
              examples: candidate.examples.flatMap((key) => {
                const title = texts.members.get(key)?.title;
                return title ? [title] : [];
              })
            },
            gate
          )
        })),
        sha256
      );
      const scoring = keys.candidates.filter((candidate) => candidate.descriptor !== null);
      if (scoring.length === 0) {
        // Nothing the ranker could read: "none of these" without a call.
        run.unranked += 1;
        outcomes.set(item.key, {
          kind: "resolved",
          resolution: unrankedGateResolution(),
          cached: false,
          aiTaskRunId: null,
          rankMs: null
        });
        continue;
      }
      const planned = new Map(item.candidates.map((candidate) => [candidate.topicId, candidate]));
      const cacheKey = decider
        ? {
            itemHash: keys.itemHash,
            descriptorSetHash: keys.descriptorSetHash,
            deciderKey: decider.key
          }
        : null;
      const cached = cacheKey ? await repository.findGateDecision(cacheKey) : null;
      const reusable =
        cached !== null &&
        cached.candidates.length === keys.candidates.length &&
        cached.candidates.every(
          (stored, index) => stored.descriptorHash === keys.candidates[index]!.descriptorHash
        );
      if (reusable) {
        run.cacheHits += 1;
        const resolution = resolveGate(
          gateScores(
            keys.candidates.map((candidate, index) => ({
              topicId: candidate.topicId,
              logOdds: cached.candidates[index]!.logOdds
            }))
          ),
          gate
        );
        if (cached.aiTaskRunId) run.aiTaskRunIds.push(cached.aiTaskRunId);
        outcomes.set(item.key, {
          kind: "resolved",
          resolution,
          cached: true,
          aiTaskRunId: cached.aiTaskRunId,
          rankMs: null
        });
        continue;
      }

      let result;
      const callStarted = performance.now();
      try {
        result = await this.options.ai.rank(
          {
            operation: topicGateOperation,
            instruction,
            query,
            documents: scoring.map((candidate) => candidate.descriptor as string),
            priority: "P2",
            sourceIds: item.rootSourceId ? [item.rootSourceId] : [],
            jobId: job.id,
            stage: "topic_gate"
          },
          signal
        );
      } catch (error) {
        // A background refusal (F4 D7) ends the job; the supervisor sets it aside.
        if (signal.aborted || isBackgroundBlocked(error)) throw error;
        const key = error instanceof Error ? error.message : "";
        return { outcomes, failure: routeErrors.has(key) ? "no_decider" : (error as Error) };
      }
      const rankMs = performance.now() - callStarted;
      run.calls += 1;
      run.rankMs.push(rankMs);
      run.inputTokens += result.tokenCounts.reduce((sum, count) => sum + count, 0);
      run.aiTaskRunIds.push(result.aiTaskRunId);
      if (decider?.localModelId !== result.localModelId) {
        decider = await this.deciderFor(result.localModelId, instruction, known);
      }
      const logOdds = new Map<string, { logOdds: number; truncated: boolean }>();
      scoring.forEach((candidate, index) => {
        const truncated = result.truncated[index] === true;
        if (truncated) run.truncated += 1;
        logOdds.set(candidate.topicId, { logOdds: result.logOdds[index]!, truncated });
      });
      const scored = keys.candidates.map((candidate) => ({
        topicId: candidate.topicId,
        logOdds: logOdds.get(candidate.topicId)?.logOdds ?? null
      }));
      const resolution = resolveGate(gateScores(scored), gate);
      outcomes.set(item.key, {
        kind: "resolved",
        resolution,
        cached: false,
        aiTaskRunId: result.aiTaskRunId,
        rankMs
      });
      if (!decider) continue;
      try {
        await repository.recordGateDecision({
          treeId,
          item: item.key,
          itemHash: keys.itemHash,
          descriptorSetHash: keys.descriptorSetHash,
          deciderKey: decider.key,
          candidates: keys.candidates.map((candidate) => {
            const source = planned.get(candidate.topicId)!;
            const score = logOdds.get(candidate.topicId);
            return {
              topicId: candidate.topicId,
              descriptorHash: candidate.descriptorHash,
              cosine: source.cosine,
              labelCosine: source.labelCosine,
              logOdds: score?.logOdds ?? null,
              ...(score ? { truncated: score.truncated } : {})
            };
          }),
          chosenTopicId: resolution.kind === "accept" ? resolution.topicId : null,
          aiTaskRunId: result.aiTaskRunId
        });
      } catch (error) {
        // The log is bookkeeping: a failed write never loses the decision itself.
        this.options.logger?.warn("A topic gate decision could not be recorded", error);
      }
    }
    return { outcomes, failure: null };
  }

  /** The texts of the planned items, their sources' catalogs and the members they cite. */
  private async readTexts(
    pool: PgPool,
    items: readonly PlannedItem[]
  ): Promise<{
    notes: Map<string, { title: string; idea: string; body: string }>;
    sources: Map<string, { title: string; header: string }>;
    members: Map<ItemKey, { title: string }>;
  }> {
    const notes = new Map<string, { title: string; idea: string; body: string }>();
    const sources = new Map<string, { title: string; header: string }>();
    const noteRepository = createAtomicNoteRepository(pool);
    const sourceRepository = createSourceItemRepository(pool);
    const memberKeys = new Set<ItemKey>();
    for (const item of items) {
      for (const candidate of item.candidates)
        for (const key of candidate.examples) memberKeys.add(key);
      for (const key of item.sourceNotes) memberKeys.add(key);
      if (item.kind === "note") {
        const note = await noteRepository.findById(item.id);
        if (note) {
          notes.set(item.id, {
            title: note.title,
            idea: note.ideaStatement,
            body: note.bodyMarkdown
          });
        }
      } else {
        const source = await sourceRepository.findById(item.id);
        if (source) {
          sources.set(item.id, {
            title: source.title,
            header: buildCatalogMetadataMarkdown(source)
          });
        }
      }
    }
    const members = await createTopicNamingRepository(pool).memberTexts(
      [...memberKeys].flatMap((key) => {
        const parsed = parseItemKey(key);
        return parsed ? [parsed] : [];
      })
    );
    return { notes, sources, members };
  }

  private queryOf(
    item: PlannedItem,
    texts: Awaited<ReturnType<TopicGateService["readTexts"]>>,
    gate: TopicTreeConfig["gate"]
  ): string | null {
    if (item.kind === "note") {
      const note = texts.notes.get(item.id);
      return note ? gateNoteQuery(note, gate) : null;
    }
    const source = texts.sources.get(item.id);
    if (!source) return null;
    return gateSourceQuery(
      {
        title: source.title,
        header: source.header,
        noteTitles: item.sourceNotes.flatMap((key) => {
          const title = texts.members.get(key)?.title;
          return title ? [title] : [];
        })
      },
      gate
    );
  }

  /** The follow-ups of an applied gate change-set (REBALANCE of its topics); never throws. */
  private async followChangeSet(
    treeId: string,
    changeSetId: string,
    generation: number
  ): Promise<void> {
    try {
      await this.options.onChangeSet?.({ treeId, changeSetId, generation });
    } catch (error) {
      this.options.logger?.warn(`Topic follow-up of change-set ${changeSetId} failed`, error);
    }
  }

  /** Adds the day's rank calls to the tree's daily metrics (`gate_calls`); never throws. */
  private async recordCalls(treeId: string, calls: number): Promise<void> {
    if (calls <= 0) return;
    try {
      await createTopicTreeRepository(this.requirePool()).upsertDailyMetrics({
        treeId,
        day: localDay(this.now()),
        increments: { gateCalls: calls }
      });
    } catch (error) {
      this.options.logger?.warn("Topic gate calls could not be counted", error);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: the change-set

  private async apply(
    job: JobRecord,
    treeId: string,
    scope: TopicScope,
    plan: GatePlan,
    outcomes: ReadonlyMap<ItemKey, ItemOutcome>,
    run: RankRun
  ): Promise<ApplyResult> {
    const repository = createTopicTreeRepository(this.requirePool());
    for (let attempt = 0; attempt < topicGateLimits.commitAttempts; attempt += 1) {
      const result = await this.options.service.runOnTree(treeId, async (cache) => {
        const prepared = this.prepare(cache, plan, outcomes);
        if (prepared.events.length === 0) {
          return {
            kind: "done" as const,
            result: { ...prepared.counts, status: "no_change" as const }
          };
        }
        const { state, vectors } = cache;
        const decisions = prepared.decisions.slice(0, topicGateLimits.summaryDecisions);
        const outcome = await repository.applyChangeSet({
          treeId,
          expectedGeneration: cache.tree.generation,
          origin: "gate",
          titleKey: "topics.changeSets.gate",
          titleParams: {
            items:
              prepared.counts.accepted +
              prepared.counts.none +
              prepared.counts.redecided +
              prepared.counts.fallback
          },
          jobId: job.id,
          aiTaskRunIds: [...new Set(run.aiTaskRunIds)].slice(0, 1_000),
          summary: {
            scope: scopeKey(scope),
            accepted: prepared.counts.accepted,
            none: prepared.counts.none,
            redecided: prepared.counts.redecided,
            fallback: prepared.counts.fallback,
            stale: prepared.counts.stale,
            deferred: prepared.counts.deferred,
            calls: run.calls,
            cacheHits: run.cacheHits,
            decisions
          },
          events: prepared.events,
          stats: topicStatsWrites(state, vectors, prepared.changedTopicIds),
          clock: state.clock
        });
        if (outcome.kind !== "applied") {
          this.options.service.invalidate();
          if (outcome.kind === "conflict" && outcome.reason === "treeRetired") {
            return {
              kind: "done" as const,
              result: { ...prepared.counts, status: "tree_inactive" as const }
            };
          }
          return { kind: "retry" as const };
        }
        cache.tree = { ...cache.tree, generation: outcome.generation, clock: state.clock };
        state.generation = outcome.generation;
        this.options.changes.record({
          treeId,
          generation: outcome.generation,
          topicIds:
            prepared.changedTopicIds.length > topicLimits.changedTopicIdsMax
              ? null
              : prepared.changedTopicIds,
          changeSetId: outcome.changeSetId
        });
        if (outcome.dirtyTopicIds.length > 0) {
          // A cascade removed items under this cache (D32): reload, and let the sweep restore them.
          this.options.service.invalidate();
          await this.options.triggers.sweep("dirty_stats", { treeId });
        }
        return {
          kind: "done" as const,
          result: {
            ...prepared.counts,
            status: "applied" as const,
            changeSetId: outcome.changeSetId,
            generation: outcome.generation
          }
        };
      });
      if (!result) return { ...emptyCounts(), status: "tree_inactive" };
      if (result.kind === "done") return result.result;
    }
    // Other writers kept moving the tree: the decisions are cached, so the next job applies them.
    return { ...emptyCounts(), deferred: outcomes.size, status: "deferred" };
  }

  /**
   * Applies the decisions to the cache's state (the caller commits the events or drops the cache)
   * and makes the statistics of every path they touched exact again (D7).
   */
  private prepare(
    cache: TopicTreeCache,
    plan: GatePlan,
    outcomes: ReadonlyMap<ItemKey, ItemOutcome>
  ) {
    const { state, vectors, config } = cache;
    const counts = emptyCounts();
    const planned = new Map(plan.items.map((item) => [item.key, item]));
    const keys = [...outcomes.keys()].filter((key) => {
      const primary = state.items.has(key) ? primaryPlacement(state, key) : undefined;
      const current =
        primary !== undefined &&
        (outcomes.get(key)?.kind === "fallback"
          ? primary.needsGate
          : awaitsGateDecision(primary)) &&
        primary.itemFingerprint === planned.get(key)?.fingerprint;
      if (!current) counts.stale += 1;
      return current;
    });
    keys.sort((a, b) => compareContentKeys(state.items.get(a)!, state.items.get(b)!));
    // Decided again on the tree as it is now (bit-equal statistics afterwards): a resolution
    // applies only while its candidates are still the item's leaves, and the decision's leaves
    // give an accepted item its "also in" placements. On an unchanged tree they equal the plan's.
    const fresh = decideWaitingItems(
      state,
      vectors,
      config,
      keys.filter((key) => outcomes.get(key)?.kind === "resolved")
    );
    const editor = createTopicTreeEditor(state);
    const context: PlacementContext = {
      state,
      vectors,
      config,
      editor,
      now: this.now().toISOString()
    };
    const touched = new Set<string>();
    const decisions: JsonObject[] = [];
    for (const key of keys) {
      const outcome = outcomes.get(key)!;
      const item = planned.get(key)!;
      for (const topic of contributionTopics(state, key)) touched.add(topic);
      const primary = primaryPlacement(state, key)!;
      if (outcome.kind === "fallback") {
        const applied = applyNoDeciderFallback(context, key);
        if (applied.kind === "stale") counts.stale += 1;
        else if (applied.events > 0) counts.fallback += 1;
      } else if (outcome.kind === "redecide") {
        const placed = placeItem(context, key, {
          fingerprint: primary.itemFingerprint,
          force: true
        });
        if (placed.needsGate && !plan.ranked) {
          // Ambiguous again with no decider: the gate's "none" now (decision 19).
          if (applyNoDeciderFallback(context, key).events > 0) counts.fallback += 1;
        } else if (placed.events > 0 && !placed.needsGate) counts.redecided += 1;
        else if (placed.needsGate) counts.deferred += 1;
      } else {
        const decision = fresh.get(key);
        if (decision?.kind !== "gate" || !sameTopics(decision.candidates, item.candidates)) {
          counts.deferred += 1;
          continue;
        }
        const applied = applyGateResolution(context, key, outcome.resolution, {
          candidates: decision.leaves
        });
        if (applied.kind === "stale") {
          counts.deferred += 1;
          continue;
        }
        if (applied.kind === "protected" || applied.events === 0) continue;
        if (outcome.resolution.kind === "accept") counts.accepted += 1;
        else counts.none += 1;
        decisions.push({
          item: key,
          topicId: outcome.resolution.kind === "accept" ? outcome.resolution.topicId : null,
          p: round(outcome.resolution.probability),
          pNone: round(outcome.resolution.noneProbability),
          cached: outcome.cached
        });
      }
      for (const topic of contributionTopics(state, key)) touched.add(topic);
    }
    const stale = liveTopics(state, [
      ...touched,
      ...editor.touched,
      ...topicsWithStaleStats(state, editor.events)
    ]);
    recomputePaths(state, vectors, stale);
    return {
      events: [...editor.events],
      changedTopicIds: pathsOf(state, stale),
      counts,
      decisions
    };
  }
}

function emptyCounts(): Omit<ApplyResult, "status"> {
  return { accepted: 0, none: 0, redecided: 0, fallback: 0, stale: 0, deferred: 0 };
}
