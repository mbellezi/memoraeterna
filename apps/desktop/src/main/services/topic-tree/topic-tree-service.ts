// The Topic Tree Engine service (F2 T15): it keeps an active tree (D39), runs PLACE and the sweep
// on the light lane's `compute` worker (D33), commits every change as one change-set through the
// single writer (D9) and reports each commit on the `topicsChanged` push (D15). It holds one
// in-memory cache of the active tree per generation; engine runs take turns on it.
import { createHash } from "node:crypto";

import {
  TopicTreeRepositoryError,
  createJobRepository,
  createTopicTreeLoadRepository,
  createTopicTreeRepository
} from "@app/db";
import type { JobDebounce, JobRecord, JsonObject, PgPool, TopicTreeRecord } from "@app/db";
import { topicLimits } from "@app/domain";
import type { TopicsBlockedReason, TopicsPhase } from "@app/domain";
import {
  canonicalStateDump,
  canonicalTopicTreeConfig,
  compareContentKeys,
  compareStrings,
  defaultTopicTreeConfig,
  isLive,
  itemKey,
  parseItemKey,
  primaryPlacement,
  statsDump
} from "@app/domain/topic-tree";
import type { ItemKey, TopicTreeConfig } from "@app/domain/topic-tree";

import { jobTaskPayload } from "../../job-task-payload.js";
import type { TopicAiBudget, TopicAiMode } from "./topic-ai.js";
import { cacheItemSource, loadTopicTreeCache } from "./topic-cache.js";
import type { TopicTreeCache } from "./topic-cache.js";
import type { TopicChangeCoalescer } from "./topic-changes.js";
import {
  TopicScopedPayloadSchema,
  TopicSweepPayloadSchema,
  scopeKey,
  scopeOfPayload,
  topicJobTypes
} from "./topic-jobs.js";
import type { TopicScope } from "./topic-jobs.js";
import { emptyPlaceSummary, preparePlacement } from "./topic-place.js";
import type { PlaceSummary } from "./topic-place.js";
import { compareTreeSpace } from "./topic-space.js";
import type { SpaceResolution, SpaceResolver } from "./topic-space.js";
import { immediateDebounce } from "./topic-triggers.js";
import type { EnqueuedTopicJob, TopicTriggers } from "./topic-triggers.js";

/** The seed of a tree's builds (the pre-registered evaluation seed of F2). */
export const topicTreeSeed = 20261014;

/**
 * Configuration groups that shape the tree (D39: build, placement, shape and Areas). A change of
 * any of them changes `config_hash`, and T19 rebuilds the tree; operational groups (budgets,
 * debounce, audit cadence, the daily AI cap, worker limits, naming, overviews) never do.
 */
export const structuralConfigGroups = [
  "fanOut",
  "leaf",
  "depth",
  "placement",
  "gate",
  "secondary",
  "items",
  "repair",
  "splitSignal",
  "louvain",
  "knn",
  "kmeans",
  "bottomUp",
  "bootstrap",
  "areas"
] as const satisfies readonly (keyof TopicTreeConfig)[];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    compareStrings(a, b)
  );
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

/** `topic_trees.config_hash`: SHA-256 of the canonical structural groups (D39, R21). */
export function structuralConfigHash(config: TopicTreeConfig): string {
  const structural = Object.fromEntries(
    structuralConfigGroups.map((group) => [group, config[group]])
  );
  return createHash("sha256").update(canonicalJson(structural)).digest("hex");
}

/** Bounds of the service's own work (engine parameters live in the tree's configuration). */
export const topicServiceLimits = {
  /** Commit attempts of one PLACE after generation or event conflicts. */
  placeAttempts: 3,
  /** Place jobs one sweep enqueues; the rest wait for the sweep it enqueues next. */
  placeJobsPerSweep: 500,
  /** Pending items read per statement. */
  pendingPage: 500,
  /** PLACE reuses the route's resolved space for this long; a sweep always resolves it again. */
  spaceRecheckMs: 10_000
} as const;

export type EnsureTreeResult =
  | { kind: "ready"; tree: TopicTreeRecord; created: boolean }
  | {
      kind: "blocked";
      reason: Extract<TopicsBlockedReason, "no_embedding_route" | "waiting_for_embeddings">;
    };

export interface TopicServiceCounts {
  /** Items with a primary placement, plus the pending ones last seen. */
  items: number;
  placed: number;
  /** Items waiting for PLACE when last counted; null before the first sweep. */
  pending: number | null;
  needsGate: number;
}

/** What `topics.status` reports (T16 maps it to the contract). */
export interface TopicServiceStatus {
  treeId: string | null;
  generation: number | null;
  phase: TopicsPhase;
  blocked: TopicsBlockedReason | null;
  counts: TopicServiceCounts;
  /** D34: today's background topic AI calls reached the cap. */
  dailyCapReached: boolean;
  aiMode: TopicAiMode;
  /** The topic barrier holds the topic jobs (D23). */
  held: boolean;
}

export interface TopicTreeServiceOptions {
  getPool: () => PgPool | null;
  spaceResolver: SpaceResolver;
  triggers: TopicTriggers;
  changes: TopicChangeCoalescer;
  aiMode: TopicAiMode;
  budget: TopicAiBudget;
  /** Job types with an executor (the gate and the build are registered by later tasks). */
  isRegistered: (type: string) => boolean;
  /** The configuration of a new tree (default: the engine's start values). */
  newTreeConfig?: () => TopicTreeConfig;
  wake?: () => void;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
}

interface HeldJob {
  id: string;
  type: string;
  dedupeKey: string | null;
  scope: TopicScope | null;
}

export class TopicTreeService {
  private cache: TopicTreeCache | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private held = false;
  private readonly heldJobs = new Map<string, HeldJob>();
  private pendingCount: number | null = null;
  private placedCounts: { treeId: string; placed: number; needsGate: number } | null = null;
  private lastSpace: SpaceResolution | null = null;
  private lastSpaceAt = 0;

  public constructor(private readonly options: TopicTreeServiceOptions) {}

  /** The active tree's configuration, or the start values before a tree exists. */
  public config(): TopicTreeConfig {
    return this.cache?.config ?? this.options.newTreeConfig?.() ?? defaultTopicTreeConfig;
  }

  /** The light-lane debounce of topic jobs (typed configuration, spec 3.5). */
  public jobDebounce(): JobDebounce {
    const { jobs } = this.config();
    return { delayMs: jobs.debounceMs, maxDelayMs: jobs.debounceCapMs };
  }

  public get aiMode(): TopicAiMode {
    return this.options.aiMode;
  }

  /**
   * Runs engine work one at a time: every run that reads or changes the cache goes through here.
   * A run must never wait for a model inside it (D10): the gate and naming call their model first.
   */
  public exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Drops the cache; the next run loads the tree again. */
  public invalidate(): void {
    this.cache = null;
  }

  /**
   * Runs an engine job (the build, REBALANCE and audit of `topic-build.ts`) on the cache of an
   * active tree at its current generation, in turn with PLACE and the sweep. Null when the tree is
   * not active. A run that throws drops the cache; a run that commits keeps the cache in step
   * itself, or drops it.
   */
  public runOnTree<T>(
    treeId: string,
    run: (cache: TopicTreeCache) => Promise<T>
  ): Promise<T | null> {
    return this.exclusive(async () => {
      const cache = await this.currentCache(treeId);
      if (!cache) return null;
      try {
        return await run(cache);
      } catch (error) {
        this.cache = null;
        throw error;
      }
    });
  }

  /**
   * The cached tree's canonical structure and statistics dumps (developer checks and exports):
   * equal dumps of the cache and of a fresh load mean the cache follows the database exactly.
   */
  public cacheDigest(): {
    treeId: string;
    generation: number;
    structure: string;
    stats: string;
  } | null {
    const cache = this.cache;
    if (!cache) return null;
    return {
      treeId: cache.tree.id,
      generation: cache.tree.generation,
      structure: canonicalStateDump(cache.state),
      stats: statsDump(cache.state)
    };
  }

  // -------------------------------------------------------------------------
  // The active tree (D39)

  /** Creates the active tree in the route's space when none exists (startup, after a reset). */
  public ensureActiveTree(): Promise<EnsureTreeResult> {
    return this.exclusive(() => this.ensureActiveTreeNow());
  }

  private async ensureActiveTreeNow(): Promise<EnsureTreeResult> {
    const pool = this.requirePool();
    const repository = createTopicTreeRepository(pool);
    const active = await repository.activeTree();
    if (active) {
      if (this.cache && this.cache.tree.id !== active.id) this.cache = null;
      return { kind: "ready", tree: active, created: false };
    }
    this.cache = null;
    this.pendingCount = null;
    const resolution = await this.resolveSpace(true);
    if (resolution.kind === "blocked") return resolution;
    const config = this.options.newTreeConfig?.() ?? defaultTopicTreeConfig;
    let tree: TopicTreeRecord;
    try {
      tree = await repository.createTree({
        spaceKey: resolution.space.spaceKey,
        embeddingProvider: resolution.space.provider,
        embeddingModel: resolution.space.model,
        embeddingRuntime: resolution.space.runtime,
        dimensions: resolution.space.dimensions,
        config: JSON.parse(canonicalTopicTreeConfig(config)) as Record<string, unknown>,
        configHash: structuralConfigHash(config),
        seed: topicTreeSeed
      });
    } catch (error) {
      if (!(error instanceof TopicTreeRepositoryError) || error.code !== "activeTreeExists") {
        throw error;
      }
      const winner = await repository.activeTree();
      if (!winner) throw error;
      return { kind: "ready", tree: winner, created: false };
    }
    // No job is queued here: a reset leaves an empty tree and nothing to do (a golden run refuses
    // to start over queued jobs); startup and the sweep that created it look for work themselves.
    this.options.logger?.info(`Topic tree ${tree.id} created in space ${tree.spaceKey}`);
    this.placedCounts = { treeId: tree.id, placed: 0, needsGate: 0 };
    this.options.changes.record({
      treeId: tree.id,
      generation: tree.generation,
      topicIds: null,
      changeSetId: null
    });
    return { kind: "ready", tree, created: true };
  }

  /**
   * The route's space, resolved again when the last answer is older than
   * `topicServiceLimits.spaceRecheckMs` or when `fresh` asks (tree creation and the sweep).
   */
  private async resolveSpace(fresh = false): Promise<SpaceResolution> {
    const now = this.now().getTime();
    if (!fresh && this.lastSpace && now - this.lastSpaceAt < topicServiceLimits.spaceRecheckMs) {
      return this.lastSpace;
    }
    this.lastSpace = await this.options.spaceResolver.resolve();
    this.lastSpaceAt = now;
    return this.lastSpace;
  }

  /** The cache of an active tree at its current generation; null when the tree is not active. */
  private async currentCache(treeId: string): Promise<TopicTreeCache | null> {
    const pool = this.requirePool();
    const tree = await createTopicTreeRepository(pool).tree(treeId);
    if (!tree || tree.status !== "active") {
      if (this.cache?.tree.id === treeId) this.cache = null;
      return null;
    }
    if (this.cache?.tree.id === treeId && this.cache.tree.generation === tree.generation) {
      return this.cache;
    }
    this.cache = null;
    const cache = await loadTopicTreeCache(pool, treeId, this.options.logger);
    if (!cache) return null;
    this.cache = cache;
    this.rememberCounts(cache);
    // Statistics another path left inexact (D32's cascade) are persisted by the sweep.
    if (cache.staleStoredStats.length > 0) {
      await this.options.triggers.sweep("dirty_stats", { treeId });
    }
    return cache;
  }

  /**
   * D39: no item-by-item PLACE into a tree without topics while at least `bootstrap.minItems`
   * items are placed or wait unplaced. `unplaced` is the scope's own count, already part of the
   * library's.
   */
  private async awaitingBuild(cache: TopicTreeCache, unplaced: number): Promise<boolean> {
    const { state, config } = cache;
    const hasTopics = [...state.topics.values()].some(
      (node) => node.id !== state.rootId && isLive(node)
    );
    if (hasTopics) return false;
    const minimum = config.bootstrap.minItems;
    if (state.items.size + unplaced >= minimum) return true;
    const loader = createTopicTreeLoadRepository(this.requirePool());
    let total = state.items.size;
    let after: ItemKey | null = null;
    do {
      const page = await loader.pendingItems(cache.tree.id, cache.space, {
        reasons: ["unplaced"],
        limit: topicServiceLimits.pendingPage,
        after
      });
      total += page.items.length;
      after = page.next;
    } while (after !== null && total < minimum);
    return total >= minimum;
  }

  // -------------------------------------------------------------------------
  // PLACE (`topic-place`)

  public runPlace(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const payload = TopicScopedPayloadSchema.parse(jobTaskPayload(job.payload));
    const scope = scopeOfPayload(payload);
    return this.exclusive(() => timed(() => this.placeNow(job, payload.treeId, scope, signal)));
  }

  private async placeNow(
    job: JobRecord,
    treeId: string,
    scope: TopicScope,
    signal: AbortSignal
  ): Promise<JsonObject> {
    const pool = this.requirePool();
    const repository = createTopicTreeRepository(pool);
    const base = { scope: scopeKey(scope) };
    for (let attempt = 0; attempt < topicServiceLimits.placeAttempts; attempt += 1) {
      const cache = await this.currentCache(treeId);
      if (!cache) return { ...base, status: "tree_inactive" };
      const space = compareTreeSpace(cache.tree, await this.resolveSpace());
      if (space.kind === "space_changed") return { ...base, status: "space_changed" };
      let preparation;
      try {
        preparation = await preparePlacement({
          pool,
          cache,
          scope,
          now: this.now().toISOString(),
          awaitingBuild: (unplaced) => this.awaitingBuild(cache, unplaced)
        });
      } catch (error) {
        this.cache = null;
        throw error;
      }
      if (preparation.kind === "stale_cache") {
        this.cache = null;
        continue;
      }
      if (preparation.kind === "no_change") {
        return { ...base, status: "no_change", ...summaryJson(preparation.summary) };
      }
      if (preparation.kind === "awaiting_build") {
        await this.requestBuild(cache.tree.id);
        return {
          ...base,
          status: "awaiting_build",
          pending: preparation.pending,
          ...summaryJson(preparation.summary)
        };
      }
      if (signal.aborted) {
        this.cache = null;
        throw new Error("topics.errors.canceled");
      }
      let result;
      try {
        result = await repository.applyChangeSet({
          treeId: cache.tree.id,
          expectedGeneration: cache.tree.generation,
          origin: "place",
          titleKey: "topics.changeSets.place",
          titleParams: { items: changedItems(preparation.summary) },
          jobId: job.id,
          summary: summaryJson(preparation.summary),
          events: preparation.events,
          stats: preparation.stats,
          clock: cache.state.clock
        });
      } catch (error) {
        this.cache = null;
        throw error;
      }
      if (result.kind === "no_change") {
        return { ...base, status: "no_change", ...summaryJson(preparation.summary) };
      }
      if (result.kind === "pending") {
        this.cache = null;
        return { ...base, status: "pending_review", changeSetId: result.changeSetId };
      }
      if (result.kind === "conflict") {
        this.cache = null;
        if (result.reason === "treeRetired") return { ...base, status: "tree_inactive" };
        continue;
      }
      cache.tree = { ...cache.tree, generation: result.generation, clock: cache.state.clock };
      cache.state.generation = result.generation;
      this.rememberCounts(cache);
      const { placed, moved, updated } = preparation.summary;
      this.adjustPending(-(placed + moved + updated));
      this.options.changes.record({
        treeId: cache.tree.id,
        generation: result.generation,
        topicIds:
          preparation.changedTopicIds.length > topicLimits.changedTopicIdsMax
            ? null
            : preparation.changedTopicIds,
        changeSetId: result.changeSetId
      });
      if (result.dirtyTopicIds.length > 0) {
        // A cascade removed items under this cache (D32): reload, and let the sweep restore them.
        this.cache = null;
        await this.options.triggers.sweep("dirty_stats", { treeId: cache.tree.id });
      }
      if (preparation.needsGate) await this.requestGate(cache.tree.id, scope);
      return {
        ...base,
        status: "applied",
        changeSetId: result.changeSetId,
        generation: result.generation,
        events: result.events,
        ...summaryJson(preparation.summary)
      };
    }
    // Other writers kept moving the tree: try again later instead of failing the job.
    await this.options.triggers.place(treeId, [scope]);
    return { ...base, status: "deferred" };
  }

  // -------------------------------------------------------------------------
  // The sweep (`topic-sweep`): the reachability net

  public runSweep(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    TopicSweepPayloadSchema.parse(jobTaskPayload(job.payload));
    return this.exclusive(() => timed(() => this.sweepNow(signal)));
  }

  private async sweepNow(signal: AbortSignal): Promise<JsonObject> {
    const ensured = await this.ensureActiveTreeNow();
    if (ensured.kind === "blocked") return { status: "blocked", reason: ensured.reason };
    const pool = this.requirePool();
    const treeId = ensured.tree.id;
    this.cache = null;
    const cache = await loadTopicTreeCache(pool, treeId, this.options.logger);
    if (!cache) return { status: "tree_inactive" };
    this.cache = cache;
    this.rememberCounts(cache);
    const space = compareTreeSpace(cache.tree, await this.resolveSpace(true));
    if (space.kind === "space_changed") return { status: "space_changed", treeId };

    // 1. Exact statistics where a cascade or another path left them inexact (D7, D32).
    let recomputed: string[] = [];
    if (cache.staleStoredStats.length > 0) {
      const outcome = await createTopicTreeRepository(pool).recomputeStats({
        treeId,
        items: cacheItemSource(cache),
        topicIds: cache.staleStoredStats
      });
      if (outcome.kind === "recomputed") {
        recomputed = outcome.topicIds;
        cache.staleStoredStats = [];
      } else if (outcome.kind === "conflict") {
        this.cache = null;
        await this.options.triggers.sweep("dirty_stats", { treeId });
        return { status: "deferred", reason: outcome.reason, treeId };
      }
    }
    if (signal.aborted) throw new Error("topics.errors.canceled");

    // 2. Every scope with pending items, and every scope with a placed note that left.
    const loader = createTopicTreeLoadRepository(pool);
    const placeScopes = new Map<string, TopicScope>();
    const gateScopes = new Map<string, TopicScope>();
    let pending = 0;
    let unplaced = 0;
    let after: ItemKey | null = null;
    do {
      const page = await loader.pendingItems(treeId, cache.space, {
        limit: topicServiceLimits.pendingPage,
        after
      });
      for (const item of page.items) {
        const scope: TopicScope =
          item.kind === "source"
            ? { rootSourceId: item.id }
            : item.rootSourceId
              ? { rootSourceId: item.rootSourceId }
              : { noteId: item.id };
        if (item.reason === "needs_gate") gateScopes.set(scopeKey(scope), scope);
        else if (item.reason !== "needs_split_check") {
          pending += 1;
          if (item.reason === "unplaced") unplaced += 1;
          placeScopes.set(scopeKey(scope), scope);
        }
      }
      after = page.next;
    } while (after !== null);
    const placedNoteIds = [...cache.state.items.values()].flatMap((entry) =>
      entry.kind === "note" ? [parseItemKey(entry.key)!.id] : []
    );
    const owners = await loader.itemOwners({ noteIds: placedNoteIds });
    for (const id of placedNoteIds) {
      const owner = owners.notes.get(id);
      // Gone (a cascade the load raced with) or no longer current: its scope unplaces it.
      if (owner?.current === true) continue;
      const rootKey = cache.state.items.get(itemKey("note", id))?.rootSource ?? null;
      const root = owner ? owner.rootSourceId : rootKey ? parseItemKey(rootKey)!.id : null;
      const scope: TopicScope = root ? { rootSourceId: root } : { noteId: id };
      placeScopes.set(scopeKey(scope), scope);
    }
    this.pendingCount = pending;

    // 3. A tree without topics and enough items waits for one build (D39) instead of PLACE.
    const hasTopics = [...cache.state.topics.values()].some(
      (node) => node.id !== cache.state.rootId && isLive(node)
    );
    const awaitingBuild =
      !hasTopics && cache.state.items.size + unplaced >= cache.config.bootstrap.minItems;
    let placeJobs = 0;
    let more = false;
    if (awaitingBuild) {
      await this.requestBuild(treeId);
    } else {
      const keys = [...placeScopes.keys()].sort(compareStrings);
      more = keys.length > topicServiceLimits.placeJobsPerSweep;
      const batch = keys
        .slice(0, topicServiceLimits.placeJobsPerSweep)
        .map((key) => placeScopes.get(key)!);
      placeJobs = (
        await this.options.triggers.place(treeId, batch, { debounce: immediateDebounce })
      ).length;
      if (more) await this.options.triggers.sweep("continue", { treeId });
    }
    let gateJobs = 0;
    for (const scope of [...gateScopes.values()].sort((a, b) =>
      compareStrings(scopeKey(a), scopeKey(b))
    )) {
      gateJobs += (await this.requestGate(treeId, scope)).length;
    }
    if (recomputed.length > 0) {
      this.options.changes.record({
        treeId,
        generation: cache.tree.generation,
        topicIds: recomputed.length > topicLimits.changedTopicIdsMax ? null : recomputed,
        changeSetId: null
      });
    }
    return {
      status: awaitingBuild ? "awaiting_build" : "swept",
      treeId,
      generation: cache.tree.generation,
      recomputedTopics: recomputed.length,
      pending,
      placeJobs,
      gateJobs,
      continues: more
    };
  }

  // -------------------------------------------------------------------------
  // Jobs this service asks for

  /** The gate of a scope, when a gate executor exists and topic AI is not off (D10, D23). */
  private async requestGate(treeId: string, scope: TopicScope): Promise<EnqueuedTopicJob[]> {
    if (this.options.aiMode !== "full" || !this.options.isRegistered(topicJobTypes.gate)) return [];
    return this.options.triggers.request(topicJobTypes.gate, treeId, scope);
  }

  /** The cold-start build (D39), when a build executor exists (T19). */
  private async requestBuild(treeId: string): Promise<EnqueuedTopicJob[]> {
    if (!this.options.isRegistered(topicJobTypes.build)) return [];
    return this.options.triggers.request(topicJobTypes.build, treeId, null, {
      debounce: immediateDebounce
    });
  }

  // -------------------------------------------------------------------------
  // The topic barrier (D23)

  public isHeld(): boolean {
    return this.held;
  }

  /** Holds every topic job: queued ones stay queued and nothing is dropped. */
  public holdTopicJobs(): void {
    this.held = true;
  }

  /** Remembers the jobs enqueued while held, to release them in content-key order. */
  public trackEnqueued(enqueued: EnqueuedTopicJob): void {
    if (!this.held) return;
    this.heldJobs.set(enqueued.job.id, {
      id: enqueued.job.id,
      type: enqueued.type,
      dedupeKey: enqueued.job.dedupeKey,
      scope: enqueued.scope
    });
  }

  /**
   * Releases the barrier: the jobs enqueued while held become due at once, in content-key order
   * (D22): place jobs by their root source's (or note's) content key, then the others by key.
   */
  public async releaseTopicJobs(): Promise<void> {
    const jobs = [...this.heldJobs.values()];
    this.heldJobs.clear();
    try {
      if (jobs.length > 0) await this.orderReleased(jobs);
    } finally {
      this.held = false;
      this.options.wake?.();
    }
  }

  private async orderReleased(jobs: HeldJob[]): Promise<void> {
    const pool = this.requirePool();
    const loader = createTopicTreeLoadRepository(pool);
    const places = jobs.filter((job) => job.type === topicJobTypes.place && job.scope);
    const others = jobs
      .filter((job) => !places.includes(job))
      .sort(
        (a, b) =>
          compareStrings(a.type, b.type) || compareStrings(a.dedupeKey ?? a.id, b.dedupeKey ?? b.id)
      );
    const rootIds = places.flatMap((job) =>
      job.scope && "rootSourceId" in job.scope ? [job.scope.rootSourceId] : []
    );
    const noteIds = places.flatMap((job) =>
      job.scope && "noteId" in job.scope ? [job.scope.noteId] : []
    );
    const owners = await loader.itemOwners({ sourceIds: rootIds });
    const active = await createTopicTreeRepository(pool).activeTree();
    const noteHashes = new Map<string, string>();
    if (active && noteIds.length > 0) {
      const vectors = await loader.loadItemVectors(
        {
          spaceKey: active.spaceKey,
          provider: active.embeddingProvider,
          model: active.embeddingModel,
          runtime: active.embeddingRuntime,
          dimensions: active.dimensions
        },
        noteIds.map((id) => ({ kind: "note" as const, id }))
      );
      vectors.keys.forEach((key, row) => noteHashes.set(key, vectors.contentHashes[row] as string));
    }
    const keyed = places.map((job) => {
      const scope = job.scope as TopicScope;
      const key =
        "rootSourceId" in scope
          ? itemKey("source", scope.rootSourceId)
          : itemKey("note", scope.noteId);
      const contentHash =
        "rootSourceId" in scope
          ? (owners.sources.get(scope.rootSourceId)?.contentHash ?? "")
          : (noteHashes.get(key) ?? "");
      return { job, key, contentHash };
    });
    keyed.sort((a, b) => compareContentKeys(a, b));
    const ordered = [...keyed.map((entry) => entry.job), ...others];
    const jobsRepository = createJobRepository(pool);
    const base = this.now().getTime() - ordered.length - 1_000;
    for (const [index, job] of ordered.entries()) {
      await jobsRepository.update(job.id, { runAfter: new Date(base + index) });
    }
  }

  // -------------------------------------------------------------------------
  // Status

  public async status(): Promise<TopicServiceStatus> {
    const budget = await this.options.budget.usage().catch(() => null);
    const base = {
      dailyCapReached: budget?.capReached ?? false,
      aiMode: this.options.aiMode,
      held: this.held
    };
    const pool = this.options.getPool();
    const active = pool ? await createTopicTreeRepository(pool).activeTree() : null;
    const resolution = await this.resolveSpace(true).catch(() => this.lastSpace);
    if (!active) {
      return {
        ...base,
        treeId: null,
        generation: null,
        phase: "active",
        blocked: resolution?.kind === "blocked" ? resolution.reason : "waiting_for_embeddings",
        counts: { items: 0, placed: 0, pending: this.pendingCount, needsGate: 0 }
      };
    }
    const space = resolution ? compareTreeSpace(active, resolution) : null;
    const blocked: TopicsBlockedReason | null =
      space?.kind === "space_changed"
        ? "space_changed"
        : resolution?.kind === "blocked"
          ? resolution.reason
          : null;
    const build = pool ? await createJobRepository(pool).latestByType(topicJobTypes.build) : null;
    const building =
      build !== null &&
      (build.status === "queued" || build.status === "running") &&
      build.payload.treeId === active.id;
    return {
      ...base,
      treeId: active.id,
      generation: active.generation,
      phase: building ? "building" : "active",
      blocked,
      counts: this.counts(active.id)
    };
  }

  private counts(treeId: string): TopicServiceCounts {
    const placedCounts =
      this.placedCounts?.treeId === treeId ? this.placedCounts : { placed: 0, needsGate: 0 };
    return {
      items: placedCounts.placed + (this.pendingCount ?? 0),
      placed: placedCounts.placed,
      pending: this.pendingCount,
      needsGate: placedCounts.needsGate
    };
  }

  /** Remembers the placed counts of a cache that matches the database (after a load or commit). */
  private rememberCounts(cache: TopicTreeCache): void {
    let placed = 0;
    let needsGate = 0;
    for (const key of cache.state.items.keys()) {
      const primary = primaryPlacement(cache.state, key);
      if (!primary) continue;
      placed += 1;
      if (primary.needsGate) needsGate += 1;
    }
    this.placedCounts = { treeId: cache.tree.id, placed, needsGate };
  }

  private adjustPending(delta: number): void {
    if (this.pendingCount !== null) this.pendingCount = Math.max(0, this.pendingCount + delta);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

function summaryJson(summary: PlaceSummary = emptyPlaceSummary()): JsonObject {
  return { ...summary };
}

/** A job result with the time its run took once it held the engine (`ms`). */
async function timed(run: () => Promise<JsonObject>): Promise<JsonObject> {
  const started = performance.now();
  const result = await run();
  return { ...result, ms: Math.round((performance.now() - started) * 10) / 10 };
}

/** Items a PLACE change-set placed, moved, re-decided in place or took out of the tree. */
function changedItems(summary: PlaceSummary): number {
  return summary.placed + summary.moved + summary.updated + summary.unplaced;
}
