// The structure jobs of the Topic Tree Engine (F2 T19; D12, D39): `topic-build` (the cold start
// of any library and ID-preserving rebuilds), `topic-rebalance` (REBALANCE of the topics that
// changed) and `topic-audit` (invariants, the mis-parent audit, daily metrics and the rebuild
// triggers). They run on the light lane's `compute` worker (D33). A build reads its inputs and
// applies its result in the engine's turn (`TopicTreeService.runOnTree`); clustering above
// `bootstrap.singleTopicMaxItems` notes runs in the clustering worker thread between the two, so
// the cache is held only for the short parts. Every change is one change-set through the single
// writer (D9), and after a bulk build or rebuild the planner statistics of the topic tables are
// refreshed (ANALYZE), so the pending-item reads keep their index plans. When the route's embedding
// space is not the tree's (D26), the build waits until `space.reembedCoverage` of the current notes
// have a vector in the new space, then rebuilds the tree there with its topic IDs kept.
import { randomUUID } from "node:crypto";

import {
  createTopicTreeLoadRepository,
  createTopicTreeRepository,
  createViewHistoryRepository,
  topicStatsWrites,
  viewHistoryLimits
} from "@app/db";
import type {
  ApplyChangeSetResult,
  JobRecord,
  JsonObject,
  PgPool,
  TopicItemInfo,
  TopicItemVectors,
  TopicTreeSpaceInput
} from "@app/db";
import { topicLimits } from "@app/domain";
import {
  applyRebuild,
  areasActive,
  areasGroupingDue,
  auditTopicTree,
  changeSetRisk,
  chapterSeedGroups,
  coldStartKind,
  compareContentKeys,
  createTopicTreeEditor,
  createTopicTreeState,
  decidePlacement,
  dominantRootSource,
  eventsTopics,
  freshItemsOf,
  freshWindowStart,
  frozenSubtrees,
  getTopic,
  hardViolationTopics,
  hasTopics,
  isLive,
  isYoungLibrary,
  itemKey,
  level2TopicCount,
  liveTopicIds,
  notesByRootSource,
  parseItemKey,
  pathOf,
  placeItem,
  placementRecord,
  primaryPlacement,
  rebalanceTree,
  rebuildNeedsReview,
  rebuildPartitionOf,
  rebuildTrigger,
  recentlyOpenedTopics,
  recomputePaths,
  recomputeSubtree,
  registerItem,
  rootSourceVectorFromState,
  rowView,
  setFrozenTopics,
  shapeReport,
  smallLibraryPartition,
  smallPartitionNodes,
  structureSignals,
  topicClusteringMaxSeedGroups,
  topicClusteringRowOrder,
  topicRecordOf,
  topicsWithStaleStats
} from "@app/domain/topic-tree";
import type {
  BuildBaseline,
  ChapterSeedItem,
  ChapterSeeding,
  FrozenSubtree,
  ItemKey,
  PlacementContext,
  RebuildReason,
  RowPartitionNode,
  TopicClusteringRequest,
  TopicClusteringResult,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

import { jobTaskPayload } from "../../job-task-payload.js";
import { detectCommunitiesLouvain } from "../../workers/topic-communities.js";
import { WorkerSupervisor } from "../worker-supervisor.js";
import { localDay } from "./topic-ai.js";
import type { TopicAiMode } from "./topic-ai.js";
import {
  ItemVectorStore,
  loadTopicTreeCache,
  noteEntries,
  rootVectorFingerprint
} from "./topic-cache.js";
import type { TopicTreeCache } from "./topic-cache.js";
import type { TopicChangeCoalescer } from "./topic-changes.js";
import { TopicTreePayloadSchema, topicJobTypes } from "./topic-jobs.js";
import type { TopicJobType, TopicScope } from "./topic-jobs.js";
import { TopicSpaceChange, compareTreeSpace, coverageShare } from "./topic-space.js";
import type { RouteSpace, SpaceResolution, SpaceResolver } from "./topic-space.js";
import { structuralConfigHash } from "./topic-tree-service.js";
import type { TopicTreeService } from "./topic-tree-service.js";
import { immediateDebounce } from "./topic-triggers.js";
import type { TopicTriggers } from "./topic-triggers.js";

/** Bounds of the structure jobs' own work (engine parameters live in the tree's configuration). */
export const topicStructureLimits = {
  /** Plans of one build whose inputs went stale before the apply (then it is enqueued again). */
  buildAttempts: 2,
  /** Items examined per pending-item read while a cold start gathers the library. */
  pendingPage: 2_000
} as const;

/** Clusters a build request (the clustering worker thread in the app, spec 3.4). */
export type ClusterTopics = (
  request: TopicClusteringRequest,
  signal: AbortSignal
) => Promise<TopicClusteringResult>;

export interface TopicStructureJobsOptions {
  getPool: () => PgPool | null;
  service: TopicTreeService;
  triggers: TopicTriggers;
  changes: TopicChangeCoalescer;
  spaceResolver: SpaceResolver;
  aiMode: TopicAiMode;
  /** Job types with an executor: follow-ups of unregistered types are not requested. */
  isRegistered: (type: string) => boolean;
  /** The configuration the active tree should have now; a new structural hash rebuilds it (D39). */
  effectiveConfig: () => TopicTreeConfig;
  /** Default: the clustering worker thread of a supervisor of its own. */
  clusterTopics?: ClusterTopics;
  /** The re-embedding of a space change (D26); default: one on the same pool and resolver. */
  spaceChange?: TopicSpaceChange;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
}

/** A rebuild that moves the tree to the route's embedding space (D26). */
interface SpaceMove {
  /** The tree loaded in the new space: the rebuild maps onto it. */
  target: TopicTreeCache;
  treeSpace: TopicTreeSpaceInput;
  /** The space the tree leaves. */
  from: string;
  /** The D8 fingerprint of each root source in the new space. */
  rootFingerprints: Map<ItemKey, string | null>;
  /** The route's model runs on this machine (Q8); null when the resolver cannot tell. */
  local: boolean | null;
}

/** The move alone (D26): the tree's structure with every live topic's statistics in the new space. */
interface SpaceSwitch {
  stats: ReturnType<typeof topicStatsWrites>;
  clock: number;
  summary: Record<string, unknown>;
}

/** The inputs of one build, read in the engine's turn. */
interface BuildPlan {
  kind: "cold" | "rebuild";
  reason: "cold-start" | "space" | RebuildReason;
  generation: number;
  config: TopicTreeConfig;
  configHash: string;
  /** The tree's configuration changes with this build (D39). */
  configChanged: boolean;
  seed: number;
  dim: 256 | 768 | 1024;
  /** Clusterable notes in content-key order (D22) and their unit vectors, row by row. */
  keys: ItemKey[];
  contentHashes: string[];
  vectors: Float32Array;
  seeding: ChapterSeeding | null;
  seedRows: number[][];
  frozen: FrozenSubtree[];
  /** Cold start: every current note (with or without a vector) and every root source. */
  notes: Map<ItemKey, TopicItemInfo>;
  /** Cold start: every item the plan read, current or not (the rest was placed meanwhile). */
  seen: Set<ItemKey>;
  sources: { key: ItemKey; contentHash: string; composite: Float32Array | null }[];
  /** D26: the rebuild moves the tree to another embedding space. */
  space: SpaceMove | null;
  loadMs: number;
}

type PlanOutcome = { kind: "plan"; plan: BuildPlan } | { kind: "done"; result: JsonObject };

interface Partition {
  nodes: RowPartitionNode[];
  frozenNodes: number[];
  method: "small" | "louvain";
  modularity: number | null;
  clusterMs: number;
}

/** REBALANCE checks that were deferred, not refused: they are checked again on the next run. */
const deferredReasons: ReadonlySet<string> = new Set(["cooldown", "frozen", "budget"]);

/** Rows of a clustering result that hold more than the root. */
function isTree(nodes: readonly RowPartitionNode[]): boolean {
  return nodes.some((node) => node.parent !== null);
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** A job result with the time its whole run took (`ms`). */
async function timed(run: () => Promise<JsonObject>): Promise<JsonObject> {
  const started = performance.now();
  const result = await run();
  return { ...result, ms: round(performance.now() - started) };
}

/** Every live topic on the paths from `ids` to the root. */
function pathsOf(state: TopicTreeState, ids: Iterable<string>): string[] {
  const output = new Set<string>();
  for (const id of ids) {
    const node = state.topics.get(id);
    if (!node || !isLive(node)) continue;
    for (const pathId of pathOf(state, id)) output.add(pathId);
  }
  return [...output].sort();
}

function baselineOf(summary: Record<string, unknown> | undefined): BuildBaseline | null {
  const notes = summary?.notes;
  if (typeof notes !== "number" || !Number.isFinite(notes)) return null;
  const coherence = summary?.leafCoherence;
  return { notes, leafCoherence: typeof coherence === "number" ? coherence : null };
}

/** Where REBALANCE re-admits a direct item below `from`: the decision's topic, if deeper. */
function readmitter(
  state: TopicTreeState,
  vectors: ItemVectorStore,
  config: TopicTreeConfig
): (item: ItemKey, from: string) => string | null {
  return (item, from) => {
    const row = vectors.rowOf(item);
    if (row === undefined) return null;
    const decision = decidePlacement(state, config, rowView(vectors.matrix, row), { from });
    return decision.topicId === from ? null : decision.topicId;
  };
}

export class TopicStructureJobs {
  private readonly workers: WorkerSupervisor | null;
  private readonly cluster: ClusterTopics;
  private readonly spaceChange: TopicSpaceChange;
  private lastAudit: { treeId: string; generation: number; day: string } | null = null;
  /**
   * Topics REBALANCE checks next, per tree: those the change-sets since its last run touched, the
   * ones the audit found out of their bands, and the checks it deferred (cooldown, freeze, budget,
   * protected hard violations), as in the replay. A whole-tree pass costs seconds at 18k notes.
   */
  private readonly dirty = new Map<string, Set<string>>();

  public constructor(private readonly options: TopicStructureJobsOptions) {
    this.spaceChange =
      options.spaceChange ??
      new TopicSpaceChange({
        getPool: options.getPool,
        spaceResolver: options.spaceResolver,
        aiMode: options.aiMode,
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.now ? { now: options.now } : {})
      });
    if (options.clusterTopics) {
      this.workers = null;
      this.cluster = options.clusterTopics;
    } else {
      const workers = new WorkerSupervisor();
      this.workers = workers;
      this.cluster = (request, signal) => workers.clusterTopics(request, { signal });
    }
  }

  public async dispose(): Promise<void> {
    await this.workers?.shutdown();
  }

  // -------------------------------------------------------------------------
  // Follow-ups other jobs ask for

  /**
   * After an applied PLACE change-set: the topics it touched (read from its stored events) wait
   * for REBALANCE, which is asked for (debounced), an audit when one is due, and a build when a
   * rebuild trigger holds (rebuildIfTriggered).
   */
  public async afterPlace(job: JobRecord, result: JsonObject): Promise<void> {
    const treeId = typeof job.payload.treeId === "string" ? job.payload.treeId : null;
    // D26: a PLACE that waits for the space change (a note was just re-embedded, or a new one
    // arrived) asks the build to check the coverage of the new space again (debounced).
    if (treeId && result.status === "space_changed") {
      await this.guard(() => this.request(topicJobTypes.build, treeId).then(() => undefined));
      return;
    }
    if (result.status !== "applied" || typeof result.changeSetId !== "string") return;
    if (!treeId) return;
    await this.afterChangeSet(treeId, result.changeSetId, Number(result.generation));
    await this.guard(() => this.rebuildIfTriggered(treeId));
  }

  /**
   * The rebuild triggers (doubling, quality drop, unadmitted burst; bootstrap.ts) checked after a
   * PLACE on the cached tree against the last build, so a library that grows several times over
   * within one session is rebuilt without waiting for the next audit. Cheap: one query and one
   * pass over the cached placements. The build is asked for (debounced) and decides again.
   */
  private async rebuildIfTriggered(treeId: string): Promise<void> {
    const latest = await createTopicTreeRepository(this.requirePool()).latestStructureBuild(treeId);
    if (!latest || latest.status === "pending_review") return;
    const baseline = baselineOf(latest.summary);
    if (!baseline) return;
    const trigger = await this.options.service.runOnTree(treeId, async (cache) =>
      hasTopics(cache.state)
        ? rebuildTrigger(structureSignals(cache.state), baseline, cache.config)
        : null
    );
    if (trigger) await this.request(topicJobTypes.build, treeId);
  }

  /**
   * After a human change-set (T26): the topics it touched wait for REBALANCE like those of a PLACE.
   * Protected topics stay where the person put them; their neighbours may need repair.
   */
  public afterHumanChange(treeId: string, changeSetId: string, generation: number): Promise<void> {
    return this.afterChangeSet(treeId, changeSetId, generation);
  }

  /**
   * After a gate change-set (D10): the leaves its decisions filled wait for REBALANCE like those
   * of a PLACE, so one that a ranker took past its hard maximum is split (I4).
   */
  public afterGateChange(treeId: string, changeSetId: string, generation: number): Promise<void> {
    return this.afterChangeSet(treeId, changeSetId, generation);
  }

  private async afterChangeSet(
    treeId: string,
    changeSetId: string,
    generation: number
  ): Promise<void> {
    await this.guard(async () => {
      const events = await createTopicTreeRepository(this.requirePool()).changeSetEvents(
        changeSetId
      );
      this.markDirty(treeId, eventsTopics(events));
      await this.request(topicJobTypes.rebalance, treeId);
      await this.auditIfDue(treeId, generation);
    });
  }

  /**
   * After a sweep that restored statistics a cascade left inexact (D32): an audit, which finds the
   * topics the deletions left out of their bands and asks REBALANCE to check them.
   */
  public async afterSweep(result: JsonObject): Promise<void> {
    if (typeof result.treeId !== "string") return;
    const treeId = result.treeId;
    if (result.status === "space_changed") return this.spaceChanged(treeId);
    if (Number(result.recomputedTopics ?? 0) === 0) return;
    await this.guard(() =>
      this.request(topicJobTypes.audit, treeId, { immediate: true }).then(() => undefined)
    );
  }

  /**
   * The route's embedding space is not the tree's (D26, seen by the sweep or the status): the
   * build re-embeds the library (local route) or waits for it, then moves the tree.
   */
  public spaceChanged(treeId: string): Promise<void> {
    return this.guard(() =>
      this.request(topicJobTypes.build, treeId, { immediate: true }).then(() => undefined)
    );
  }

  private markDirty(treeId: string, topicIds: Iterable<string>): void {
    const set = this.dirty.get(treeId) ?? new Set<string>();
    for (const id of topicIds) set.add(id);
    this.dirty.set(treeId, set);
  }

  /** The topics waiting for REBALANCE in a tree (taken: the run puts back what it defers). */
  private takeDirty(treeId: string): string[] {
    const set = this.dirty.get(treeId);
    this.dirty.delete(treeId);
    return set ? [...set].sort() : [];
  }

  /** Startup: an audit (daily metrics, the structural configuration hash, rebuild triggers). */
  public async startup(treeId: string | null): Promise<void> {
    if (!treeId) return;
    await this.guard(() => this.request(topicJobTypes.audit, treeId).then(() => undefined));
  }

  private async guard(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.options.logger?.error("Topic structure follow-up could not be enqueued", error);
    }
  }

  private async auditIfDue(treeId: string, generation: number): Promise<void> {
    const last = this.lastAudit;
    const every = this.options.service.config().audit.everyChangeSets;
    const due =
      last === null ||
      last.treeId !== treeId ||
      last.day !== localDay(this.now()) ||
      (Number.isFinite(generation) && generation - last.generation >= every);
    if (due) await this.request(topicJobTypes.audit, treeId);
  }

  /** Requests a tree-wide job (or a gate scope); model jobs only when topic AI is on (D23). */
  private async request(
    type: Exclude<TopicJobType, "topic-place" | "topic-sweep">,
    treeId: string,
    options: { scope?: TopicScope; immediate?: boolean } = {}
  ): Promise<number> {
    const model =
      type === topicJobTypes.gate ||
      type === topicJobTypes.name ||
      type === topicJobTypes.areas ||
      type === topicJobTypes.labelEmbed;
    if (model && this.options.aiMode !== "full") return 0;
    if (!this.options.isRegistered(type)) return 0;
    const jobs = await this.options.triggers.request(
      type,
      treeId,
      options.scope ?? null,
      options.immediate ? { debounce: immediateDebounce } : {}
    );
    return jobs.length;
  }

  // -------------------------------------------------------------------------
  // `topic-build`

  public runBuild(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const { treeId } = TopicTreePayloadSchema.parse(jobTaskPayload(job.payload));
    return timed(async () => {
      for (let attempt = 0; attempt < topicStructureLimits.buildAttempts; attempt += 1) {
        const resolution = await this.options.spaceResolver.resolve();
        // D26: until the new space covers the library, the tree waits (outside the engine's turn).
        const waiting = await this.spaceChangeWait(treeId, resolution);
        if (waiting) return waiting;
        const planned = await this.options.service.runOnTree(treeId, async (cache) => {
          const space = compareTreeSpace(cache.tree, resolution);
          if (space.kind === "space_changed") return this.planSpaceMove(cache, space.route, job);
          return this.planBuild(cache);
        });
        if (planned === null) return { status: "tree_inactive" };
        if (planned.kind === "done") return planned.result;
        const { plan } = planned;
        if (signal.aborted) throw new Error("topics.errors.canceled");
        const partition = await this.partition(plan, signal);
        if (signal.aborted) throw new Error("topics.errors.canceled");
        const applied = await this.options.service.runOnTree(treeId, async (cache) => {
          if (plan.kind === "cold") return this.applyColdStart(cache, plan, partition, job);
          if (!plan.space) return this.applyRebuildPlan(cache, plan, partition, job);
          // The tree must still be the one the move was planned on, in its old space.
          const unchanged =
            cache.tree.generation === plan.generation && cache.tree.spaceKey === plan.space.from;
          return unchanged
            ? this.applyRebuildPlan(plan.space.target, plan, partition, job)
            : { status: "stale" };
        });
        if (applied === null) return { status: "tree_inactive" };
        if (applied.status !== "stale") return applied;
      }
      // Other writers kept changing the tree: build again later instead of failing the job.
      await this.request(topicJobTypes.build, treeId);
      return { status: "deferred" };
    });
  }

  /** What a build of this tree does now, and its inputs. */
  private async planBuild(cache: TopicTreeCache): Promise<PlanOutcome> {
    const effective = this.options.effectiveConfig();
    const hash = structuralConfigHash(effective);
    if (!hasTopics(cache.state)) return this.planColdStart(cache, effective, hash);
    const decision = await this.rebuildDecision(cache, effective, hash);
    if ("skip" in decision) return { kind: "done", result: { status: decision.skip } };
    const plan = this.planRebuild(cache, decision);
    // A library that shrank below a first topic keeps its tree; PLACE and REBALANCE tend it.
    if (plan.keys.length < decision.config.bootstrap.minItems) {
      return { kind: "done", result: { status: "too_few_items", rows: plan.keys.length } };
    }
    return { kind: "plan", plan };
  }

  /**
   * Whether a tree with topics is rebuilt now: a new structural configuration (D39), else one of
   * the rebuild triggers against the last build. A proposal that waits for review blocks both; a
   * dismissed configuration rebuild is not proposed again for the same configuration.
   */
  private async rebuildDecision(
    cache: TopicTreeCache,
    effective: TopicTreeConfig,
    hash: string
  ): Promise<
    | { reason: RebuildReason; config: TopicTreeConfig; configHash: string; changed: boolean }
    | { skip: string }
  > {
    const repository = createTopicTreeRepository(this.requirePool());
    const latest = await repository.latestStructureBuild(cache.tree.id);
    if (latest?.status === "pending_review") return { skip: "review_pending" };
    if (hash !== cache.tree.configHash) {
      if (latest?.status === "dismissed" && latest.summary.configHash === hash) {
        return { skip: "dismissed" };
      }
      return { reason: "config", config: effective, configHash: hash, changed: true };
    }
    const baseline = baselineOf(latest?.summary);
    if (!baseline) return { skip: "no_change" };
    const trigger = rebuildTrigger(structureSignals(cache.state), baseline, cache.config);
    if (!trigger) return { skip: "no_change" };
    return {
      reason: trigger,
      config: cache.config,
      configHash: cache.tree.configHash,
      changed: false
    };
  }

  /** The cold start: every current note and root source of the library (D39). */
  private async planColdStart(
    cache: TopicTreeCache,
    config: TopicTreeConfig,
    hash: string
  ): Promise<PlanOutcome> {
    const started = performance.now();
    const pool = this.requirePool();
    const loader = createTopicTreeLoadRepository(pool);
    const noteIds = new Set<string>();
    const sourceIds = new Set<string>();
    for (const entry of cache.state.items.values()) {
      const parsed = parseItemKey(entry.key);
      if (parsed) (parsed.kind === "note" ? noteIds : sourceIds).add(parsed.id);
    }
    let after: ItemKey | null = null;
    do {
      const page = await loader.pendingItems(cache.tree.id, cache.space, {
        limit: topicStructureLimits.pendingPage,
        after
      });
      for (const item of page.items) (item.kind === "note" ? noteIds : sourceIds).add(item.id);
      after = page.next;
    } while (after !== null);
    const owners = await loader.itemOwners({ noteIds: [...noteIds], sourceIds: [...sourceIds] });
    const current = [...owners.notes.values()].filter((owner) => owner.current);
    const vectors = await loader.loadItemVectors(
      cache.space,
      current.map((owner) => ({ kind: "note" as const, id: owner.id }))
    );
    const entries = noteEntries(vectors, owners.notes);
    const notes = new Map<ItemKey, TopicItemInfo>();
    for (const [key, entry] of entries) notes.set(key, entry.info);
    const roots = [...owners.sources.values()].filter((owner) => owner.rootSourceId === owner.id);
    const composites = await loader.loadItemVectors(
      cache.space,
      roots.map((owner) => ({ kind: "source" as const, id: owner.id }))
    );
    const compositeRow = new Map(composites.keys.map((key, row) => [key, row]));
    const sources = roots.map((owner) => {
      const key = itemKey("source", owner.id);
      const row = compositeRow.get(key);
      return {
        key,
        contentHash: owner.contentHash ?? "",
        composite:
          row === undefined
            ? null
            : composites.matrix.data.slice(row * composites.dim, (row + 1) * composites.dim)
      };
    });
    const clusterable = vectors.keys.map((key, row) => ({
      key,
      contentHash: vectors.contentHashes[row] as string,
      row
    }));
    const kind = coldStartKind(clusterable.length, config);
    if (kind === "wait") {
      // Fewer notes than a first topic needs: the items wait in Unsorted, placed as PLACE would.
      return {
        kind: "done",
        result: await this.placeInUnsorted(cache, notes, vectors, sources, clusterable.length)
      };
    }
    const order = topicClusteringRowOrder(clusterable);
    const rowOf = new Map(clusterable.map((item) => [item.key, item.row]));
    const matrix = this.orderedVectors(
      order.keys,
      (key) => {
        const row = rowOf.get(key) as number;
        return vectors.matrix.data.subarray(row * vectors.dim, (row + 1) * vectors.dim);
      },
      cache.space.dimensions
    );
    const hashes = new Map(clusterable.map((item) => [item.key, item.contentHash]));
    const seeding = await this.chapterSeeding(
      order.keys.map((key) => ({
        key,
        contentHash: hashes.get(key) as string,
        rootSource: owners.notes.get(parseItemKey(key)!.id)?.rootSourceId ?? null,
        chapter: null
      })),
      config
    );
    return {
      kind: "plan",
      plan: {
        kind: "cold",
        reason: "cold-start",
        generation: cache.tree.generation,
        config,
        configHash: hash,
        configChanged: hash !== cache.tree.configHash,
        seed: cache.tree.seed,
        dim: cache.space.dimensions,
        keys: order.keys.slice(),
        contentHashes: order.keys.map((key) => hashes.get(key) as string),
        vectors: matrix,
        seeding,
        seedRows: seeding ? order.rowsOf(seeding.groups) : [],
        frozen: [],
        notes,
        seen: new Set([
          ...[...noteIds].map((id) => itemKey("note", id)),
          ...[...sourceIds].map((id) => itemKey("source", id))
        ]),
        sources,
        space: null,
        loadMs: round(performance.now() - started)
      }
    };
  }

  /** A rebuild over the placed notes with vectors, protected subtrees kept whole. */
  private planRebuild(
    cache: TopicTreeCache,
    decision: {
      reason: RebuildReason | "space";
      config: TopicTreeConfig;
      configHash: string;
      changed: boolean;
    },
    space: SpaceMove | null = null
  ): BuildPlan {
    const started = performance.now();
    const { state, vectors } = cache;
    const items: { key: ItemKey; contentHash: string }[] = [];
    for (const entry of state.items.values()) {
      if (entry.kind !== "note" || vectors.rowOf(entry.key) === undefined) continue;
      if (!primaryPlacement(state, entry.key)) continue;
      items.push({ key: entry.key, contentHash: entry.contentHash });
    }
    const order = topicClusteringRowOrder(items);
    const matrix = this.orderedVectors(
      order.keys,
      (key) => vectors.get(key) as Float32Array,
      cache.space.dimensions
    );
    const rowOf = new Map(order.keys.map((key, row) => [key, row]));
    const frozen = frozenSubtrees(state, rowOf);
    return {
      kind: "rebuild",
      reason: decision.reason,
      generation: cache.tree.generation,
      config: decision.config,
      configHash: decision.configHash,
      configChanged: decision.changed,
      seed: cache.tree.seed,
      dim: cache.space.dimensions,
      keys: order.keys.slice(),
      contentHashes: order.keys.map((key) => state.items.get(key)?.contentHash ?? ""),
      vectors: matrix,
      seeding: null,
      seedRows: [],
      frozen,
      notes: new Map(),
      seen: new Set(),
      sources: [],
      space,
      loadMs: round(performance.now() - started)
    };
  }

  // -------------------------------------------------------------------------
  // A change of embedding space (D26)

  /**
   * Null when the build can go on: the tree is in the route's space, or the new space covers
   * `space.reembedCoverage` of the current notes and no queued re-embedding would add to it (the
   * move maps the whole re-embedded library at once; notes whose jobs failed for good do not hold
   * it back). Otherwise the tree keeps waiting in its own space (PLACE of new-space items waits
   * too) while the library is re-embedded: automatically on a local route, after the owner's
   * `topics.reembed` on a remote one. Spaces are never compared.
   */
  private async spaceChangeWait(
    treeId: string,
    resolution: SpaceResolution
  ): Promise<JsonObject | null> {
    const tree = await createTopicTreeRepository(this.requirePool()).tree(treeId);
    if (!tree || tree.status !== "active") return null;
    const space = compareTreeSpace(tree, resolution);
    if (space.kind !== "space_changed") return null;
    const { route } = space;
    const coverage = await this.spaceChange.coverage(route.spaceKey);
    const share = coverageShare(coverage);
    const covered = share >= this.options.effectiveConfig().space.reembedCoverage;
    if (route.space && covered && coverage.queued === 0) return null;
    const requested = covered ? null : await this.spaceChange.reembedAutomatically(route, coverage);
    return {
      status: "space_changed",
      from: tree.spaceKey,
      spaceKey: route.spaceKey,
      coverage: Math.floor(share * 10_000) / 10_000,
      ...coverage,
      reembedding: covered ? "finishing" : requested === null ? "waiting_for_action" : "automatic",
      ...(requested ? { requested } : {})
    };
  }

  /**
   * The move of a tree to the route's space, in the engine's turn: the tree loaded again with the
   * vectors of the new space (only those, never mixed with the old ones), then a rebuild mapped
   * onto it by Hungarian matching, or, for a tree without topics or with too few notes, the same
   * structure with its statistics in the new space.
   */
  private async planSpaceMove(
    cache: TopicTreeCache,
    route: RouteSpace,
    job: JobRecord
  ): Promise<PlanOutcome> {
    const space = route.space;
    if (!space) return { kind: "done", result: { status: "space_changed" } };
    const pool = this.requirePool();
    const target = await loadTopicTreeCache(pool, cache.tree.id, this.options.logger, space);
    if (!target || target.tree.generation !== cache.tree.generation) {
      return { kind: "done", result: { status: "deferred", reason: "generation" } };
    }
    const move: SpaceMove = {
      target,
      treeSpace: {
        spaceKey: space.spaceKey,
        embeddingProvider: space.provider,
        embeddingModel: space.model,
        embeddingRuntime: space.runtime,
        dimensions: space.dimensions
      },
      from: cache.tree.spaceKey,
      rootFingerprints: await this.rootFingerprints(target),
      local: route.local
    };
    const effective = this.options.effectiveConfig();
    const hash = structuralConfigHash(effective);
    const plan = this.planRebuild(
      target,
      {
        reason: "space",
        config: effective,
        configHash: hash,
        changed: hash !== target.tree.configHash
      },
      move
    );
    if (!hasTopics(target.state) || plan.keys.length < effective.bootstrap.minItems) {
      const writes = this.spaceSwitchWrites(move, plan);
      return { kind: "done", result: await this.applySpaceSwitch(move, job, writes) };
    }
    return { kind: "plan", plan };
  }

  /** The D8 fingerprint of every root source of a tree loaded in a space (its composite there). */
  private async rootFingerprints(target: TopicTreeCache): Promise<Map<ItemKey, string | null>> {
    const { state, vectors, config, space } = target;
    const roots = [...state.items.values()].filter((entry) => entry.kind === "source");
    const composites = await createTopicTreeLoadRepository(this.requirePool()).loadItemVectors(
      space,
      roots.map((root) => ({ kind: "source" as const, id: parseItemKey(root.key)!.id }))
    );
    const rowOf = new Map(composites.keys.map((key, row) => [key, row]));
    const byRoot = notesByRootSource(state);
    const output = new Map<ItemKey, string | null>();
    for (const root of roots) {
      const row = rowOf.get(root.key);
      const composite =
        row === undefined
          ? null
          : composites.matrix.data.slice(row * composites.dim, (row + 1) * composites.dim);
      const vector = rootSourceVectorFromState(
        state,
        vectors,
        root.key,
        composite,
        config,
        byRoot.get(root.key) ?? []
      );
      output.set(root.key, rootVectorFingerprint(vector));
    }
    return output;
  }

  /** The move alone, read from the tree loaded in the new space before any rebuild changes it. */
  private spaceSwitchWrites(move: SpaceMove, plan: BuildPlan): SpaceSwitch {
    const { state, vectors, tree } = move.target;
    const signals = structureSignals(state);
    return {
      stats: topicStatsWrites(state, vectors, liveTopicIds(state)),
      clock: state.clock,
      summary: {
        reason: "space",
        from: move.from,
        spaceKey: move.treeSpace.spaceKey,
        rows: plan.keys.length,
        notes: signals.notes,
        leafCoherence: signals.leafCoherence,
        configHash: tree.configHash
      }
    };
  }

  /**
   * A move without a rebuild (no topics yet, fewer notes than a first topic needs, or a rebuild
   * that waits for review): the same structure, every live topic's statistics in the new space,
   * one change-set without events. `propose` records the rebuild for review once the tree moved.
   */
  private async applySpaceSwitch(
    move: SpaceMove,
    job: JobRecord,
    writes: SpaceSwitch,
    propose?: (generation: number) => Promise<JsonObject>
  ): Promise<JsonObject> {
    const { tree } = move.target;
    const result = await createTopicTreeRepository(this.requirePool()).applyChangeSet({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      origin: "rebuild",
      titleKey: "topics.changeSets.space",
      titleParams: { items: 0 },
      jobId: job.id,
      summary: writes.summary,
      events: [],
      stats: writes.stats,
      clock: writes.clock,
      treeSpace: move.treeSpace
    });
    this.options.service.invalidate();
    if (result.kind === "conflict") {
      return result.reason === "treeRetired"
        ? { status: "tree_inactive" }
        : { status: "deferred", reason: result.reason };
    }
    if (result.kind !== "applied") return { status: "no_change", reason: "space" };
    this.dirty.delete(tree.id);
    this.options.changes.record({
      treeId: tree.id,
      generation: result.generation,
      topicIds: null,
      changeSetId: result.changeSetId
    });
    const review = propose ? await propose(result.generation) : null;
    // What waited for the move is placed now, in the new space.
    await this.options.triggers.sweep("requested", {
      treeId: tree.id,
      debounce: immediateDebounce
    });
    const followUps = await this.spaceFollowUps(tree.id, move, {});
    return {
      status: "applied",
      kind: "space",
      ...writes.summary,
      changeSetId: result.changeSetId,
      generation: result.generation,
      ...(review ? { review } : {}),
      followUps
    };
  }

  /**
   * After a move: every label vector is embedded again in the tree's new space, and on a local
   * route the notes the re-embedding missed are queued once more.
   */
  private async spaceFollowUps(
    treeId: string,
    move: SpaceMove,
    follow: Record<string, number>
  ): Promise<Record<string, number>> {
    follow.labels = await this.request(topicJobTypes.labelEmbed, treeId);
    const missed = await this.spaceChange.reembedMissed({
      spaceKey: move.treeSpace.spaceKey,
      local: move.local
    });
    if (missed !== null) follow.reembed = missed;
    return follow;
  }

  /** One Float32Array holding the rows of `keys` in order (it owns its buffer: it is transferred). */
  private orderedVectors(
    keys: readonly ItemKey[],
    vectorOf: (key: ItemKey) => ArrayLike<number>,
    dim: number
  ): Float32Array {
    const data = new Float32Array(keys.length * dim);
    keys.forEach((key, row) => data.set(vectorOf(key), row * dim));
    return data;
  }

  /** Chapter seeding (bootstrap.ts) for the clusterable notes of a cold start. */
  private async chapterSeeding(
    items: ChapterSeedItem[],
    config: TopicTreeConfig
  ): Promise<ChapterSeeding | null> {
    const dominant = dominantRootSource(items);
    if (!dominant || dominant.share < config.bootstrap.chapterSeedShare) return null;
    const loader = createTopicTreeLoadRepository(this.requirePool());
    const children =
      (await loader.childSourceCounts([dominant.rootSource])).get(dominant.rootSource) ?? 0;
    if (children < config.bootstrap.chapterMinChildren) return null;
    const own = items.filter((item) => item.rootSource === dominant.rootSource);
    const chapters = await loader.noteChapters(own.map((item) => parseItemKey(item.key)!.id));
    const withChapters = items.map((item) => ({
      ...item,
      chapter:
        item.rootSource === dominant.rootSource
          ? (chapters.get(parseItemKey(item.key)!.id)?.chapterId ?? null)
          : null
    }));
    return chapterSeedGroups(withChapters, () => children, config, topicClusteringMaxSeedGroups);
  }

  /** The partition of a plan: in process for a small library, else the clustering worker. */
  private async partition(plan: BuildPlan, signal: AbortSignal): Promise<Partition> {
    const started = performance.now();
    const rows = plan.keys.length;
    const frozenRows = new Set(plan.frozen.flatMap((group) => group.rows));
    const small = (): Partition => {
      const matrix = { dim: plan.dim, count: rows, data: plan.vectors };
      const loose = Array.from({ length: rows }, (_, row) => row).filter(
        (row) => !frozenRows.has(row)
      );
      const result =
        loose.length > 0
          ? smallLibraryPartition(matrix, loose, plan.config, plan.seed, detectCommunitiesLouvain)
          : { groups: [], modularity: 0 };
      const nodes = smallPartitionNodes(result.groups);
      const frozenNodes = plan.frozen.map((group) => {
        const key = nodes.length;
        nodes.push({ key, parent: 0, items: [...group.rows] });
        return key;
      });
      return {
        nodes,
        frozenNodes,
        method: "small",
        modularity: result.modularity,
        clusterMs: round(performance.now() - started)
      };
    };
    if (rows - frozenRows.size <= plan.config.bootstrap.singleTopicMaxItems) return small();
    const seedGroups = plan.seedRows
      .map((group) => group.filter((row) => !frozenRows.has(row)))
      .filter((group) => group.length > 0);
    const result = await this.cluster(
      {
        kind: plan.kind === "rebuild" ? "rebuild" : "build",
        rows,
        dimensions: plan.dim,
        // The worker takes this buffer; the plan keeps its own rows for the apply.
        vectors: plan.vectors.slice(),
        ...(seedGroups.length > 0 ? { seedGroups } : {}),
        ...(plan.kind === "rebuild" && plan.frozen.length > 0
          ? { frozenGroups: plan.frozen.map((group) => group.rows) }
          : {}),
        config: plan.config,
        seed: plan.seed
      },
      signal
    );
    // A builder that keeps every row in the root (a library a leaf can hold) makes no first topic.
    if (!isTree(result.nodes)) return small();
    return {
      nodes: result.nodes,
      frozenNodes: result.frozenNodes ?? [],
      method: "louvain",
      modularity: null,
      clusterMs: round(performance.now() - started)
    };
  }

  /**
   * Places what waits in a tree without topics at the root, as PLACE would (notes without a
   * vector flagged `needs_vector`, root sources by their D8 vector): one `place` change-set.
   */
  private async placeInUnsorted(
    cache: TopicTreeCache,
    notes: Map<ItemKey, TopicItemInfo>,
    vectors: TopicItemVectors,
    sources: BuildPlan["sources"],
    clusterable: number
  ): Promise<JsonObject> {
    const { state, config } = cache;
    const store = cache.vectors;
    const editor = createTopicTreeEditor(state);
    const context: PlacementContext = {
      state,
      vectors: store,
      config,
      editor,
      now: this.now().toISOString()
    };
    const rowOf = new Map(vectors.keys.map((key, row) => [key, row]));
    const pendingNotes = [...notes]
      .filter(([key]) => !primaryPlacement(state, key))
      .map(([key, info]) => ({ key, ...info }))
      .sort(compareContentKeys);
    let placed = 0;
    for (const note of pendingNotes) {
      registerItem(state, note);
      const row = rowOf.get(note.key);
      if (row !== undefined) {
        store.set(
          note.key,
          vectors.matrix.data.subarray(row * vectors.dim, (row + 1) * vectors.dim)
        );
      }
      const outcome = placeItem(context, note.key, {
        fingerprint: row === undefined ? null : note.contentHash
      });
      if (outcome.kind === "placed") {
        state.clock += 1;
        placed += 1;
      }
    }
    placed += this.placeSources(context, store, sources, { onlyUnplaced: true }).placed;
    if (editor.events.length === 0) {
      return { status: "waiting_for_items", clusterable, minItems: config.bootstrap.minItems };
    }
    recomputePaths(state, store, [state.rootId]);
    const result = await createTopicTreeRepository(this.requirePool()).applyChangeSet({
      treeId: cache.tree.id,
      expectedGeneration: cache.tree.generation,
      origin: "place",
      titleKey: "topics.changeSets.place",
      titleParams: { items: placed },
      summary: { placed, clusterable },
      events: [...editor.events],
      stats: topicStatsWrites(state, store, [state.rootId]),
      clock: state.clock
    });
    this.options.service.invalidate();
    if (result.kind !== "applied") return { status: "deferred", reason: result.kind };
    this.options.changes.record({
      treeId: cache.tree.id,
      generation: result.generation,
      topicIds: [state.rootId],
      changeSetId: result.changeSetId
    });
    return {
      status: "waiting_for_items",
      clusterable,
      minItems: config.bootstrap.minItems,
      placed,
      changeSetId: result.changeSetId
    };
  }

  /**
   * PLACE of root sources on a built tree, in content-key order, by their D8 vector (D8): a root
   * counts in the statistics only while none of its notes is placed. Returns the scopes left
   * waiting for the gate.
   */
  private placeSources(
    context: PlacementContext,
    store: ItemVectorStore,
    sources: BuildPlan["sources"],
    options: { onlyUnplaced: boolean }
  ): { placed: number; gated: TopicScope[] } {
    const { state, config } = context;
    const gated: TopicScope[] = [];
    let placed = 0;
    const ordered = [...sources].sort(compareContentKeys);
    for (const source of ordered) {
      if (options.onlyUnplaced && primaryPlacement(state, source.key)) continue;
      registerItem(state, {
        key: source.key,
        kind: "source",
        contentHash: source.contentHash,
        rootSource: null
      });
      const vector = rootSourceVectorFromState(state, store, source.key, source.composite, config);
      if (vector.vector) store.set(source.key, vector.vector);
      else store.delete(source.key);
      const outcome = placeItem(context, source.key, {
        fingerprint: rootVectorFingerprint(vector)
      });
      if (outcome.kind === "placed") {
        state.clock += 1;
        placed += 1;
      }
      if (outcome.needsGate) gated.push({ rootSourceId: parseItemKey(source.key)!.id });
    }
    return { placed, gated };
  }

  /**
   * Applies a cold start: the built topics, the notes in them, then notes without a vector and
   * root sources by PLACE on the built tree, written as one `build` snapshot. Items the plan did
   * not see (placed meanwhile) keep their placement.
   */
  private async applyColdStart(
    cache: TopicTreeCache,
    plan: BuildPlan,
    partition: Partition,
    job: JobRecord
  ): Promise<JsonObject> {
    if (hasTopics(cache.state)) return { status: "stale" };
    const started = performance.now();
    const { tree } = cache;
    const { dim, config } = plan;
    const state = createTopicTreeState({ dim, rootId: tree.rootId });
    const store = new ItemVectorStore(dim, plan.keys.length + plan.sources.length + 16);
    const editor = createTopicTreeEditor(state, { record: false });
    for (const [key, info] of plan.notes) registerItem(state, { key, ...info });
    plan.keys.forEach((key, row) =>
      store.set(key, plan.vectors.subarray(row * dim, (row + 1) * dim))
    );
    const topicOf = new Map<number, string>();
    for (const node of partition.nodes) {
      if (node.parent === null) {
        topicOf.set(node.key, tree.rootId);
        continue;
      }
      const id = randomUUID();
      topicOf.set(node.key, id);
      editor.createTopic(id, topicOf.get(node.parent) as string);
    }
    for (const node of partition.nodes) {
      const topicId = topicOf.get(node.key) as string;
      for (const row of node.items) {
        editor.placeItem(
          plan.keys[row] as ItemKey,
          placementRecord(topicId, {
            decidedBy: "build",
            itemFingerprint: plan.contentHashes[row] as string
          })
        );
      }
    }
    recomputeSubtree(state, store);
    const context: PlacementContext = {
      state,
      vectors: store,
      config,
      editor,
      now: this.now().toISOString()
    };
    const vectorless = [...plan.notes]
      .filter(([key]) => !primaryPlacement(state, key))
      .map(([key, info]) => ({ key, ...info }))
      .sort(compareContentKeys);
    for (const note of vectorless) placeItem(context, note.key, { fingerprint: null });
    const sources = this.placeSources(context, store, plan.sources, { onlyUnplaced: false });
    // Items placed after the plan was read keep their place in Unsorted; items the plan read and
    // left out (a note no longer current) leave the tree with this build.
    for (const [item, placements] of cache.state.placements) {
      if (state.items.has(item) || plan.seen.has(item)) continue;
      const entry = cache.state.items.get(item);
      if (!entry) continue;
      registerItem(state, entry);
      const vector = cache.vectors.get(item);
      if (vector) store.set(item, vector);
      for (const placement of placements) editor.placeItem(item, { ...placement });
    }
    recomputeSubtree(state, store);
    const topics = liveTopicIds(state)
      .filter((id) => id !== tree.rootId)
      .map((id) => topicRecordOf(getTopic(state, id)));
    const placements = [...state.placements].flatMap(([item, list]) =>
      list.map((placement) => ({ item, placement }))
    );
    const report = shapeReport(state, config, { areasActive: areasActive(state) });
    const summary = this.buildSummary(plan, partition, state, report);
    const result = await createTopicTreeRepository(this.requirePool()).bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      origin: "build",
      titleKey: "topics.changeSets.build",
      titleParams: { topics: topics.length, items: placements.length },
      jobId: job.id,
      summary,
      topics,
      placements,
      stats: topicStatsWrites(state, store, liveTopicIds(state)),
      clock: cache.state.clock,
      ...(plan.configChanged
        ? {
            treeConfig: {
              config: JSON.parse(JSON.stringify(config)) as Record<string, unknown>,
              configHash: plan.configHash
            }
          }
        : {})
    });
    return this.finishBuild(cache, plan, partition, result, {
      state,
      created: topics.map((topic) => topic.id),
      gated: sources.gated,
      summary,
      applyMs: round(performance.now() - started)
    });
  }

  /**
   * Applies a rebuild: the new partition mapped onto the live tree by Hungarian matching on member
   * Jaccard so topic IDs survive (rebuild-map.ts), then root sources re-placed by PLACE on the
   * result. One `rebuild` change-set, `pending_review` when it touches protected structure (and,
   * for a trigger rebuild, when it re-paths a large share of the items). The move to a new
   * embedding space (D26, `cache` loaded in that space) always happens, since the tree cannot stay
   * behind its route: when its rebuild touches protected structure, the tree moves with its
   * structure unchanged and the rebuild waits for the owner as a proposal on the moved tree (D29).
   * A large share alone needs no review there, as for a configuration: the move is not a trigger.
   */
  private async applyRebuildPlan(
    cache: TopicTreeCache,
    plan: BuildPlan,
    partition: Partition,
    job: JobRecord
  ): Promise<JsonObject> {
    const started = performance.now();
    const { state, vectors, tree } = cache;
    const reason = plan.reason;
    if (!hasTopics(state) || reason === "cold-start") return { status: "stale" };
    // D26: the move alone, read before the rebuild changes the state, in case it waits for review.
    const switched = plan.space ? this.spaceSwitchWrites(plan.space, plan) : null;
    const nodes = rebuildPartitionOf(partition.nodes, plan.keys, {
      state,
      frozen: plan.frozen,
      frozenNodes: partition.frozenNodes
    }).map((node) => ({
      ...node,
      // Notes that left the tree since the plan (a cascade, a status change) are not mapped.
      items: node.items.filter((item) => primaryPlacement(state, item) !== undefined)
    }));
    // A young library (bootstrap.ts) is read before the rebuild changes the state.
    const youngNotes = structureSignals(state).notes;
    const now = this.now().toISOString();
    const recent = await this.frozenTopics(state, plan.config, now);
    const recentItems = new Set<ItemKey>();
    for (const id of recent) for (const item of getTopic(state, id).items) recentItems.add(item);
    const freshItems = await this.freshItems(tree.id, plan.config, now, recentItems);
    const rebuilt = applyRebuild({
      state,
      vectors,
      config: plan.config,
      partition: nodes,
      newTopicId: () => randomUUID(),
      now,
      recentItems,
      freshItems
    });
    // Root sources follow their notes: each is decided again on the rebuilt tree (D8).
    const editor = createTopicTreeEditor(state);
    const context: PlacementContext = { state, vectors, config: plan.config, editor, now };
    const gated: TopicScope[] = [];
    const roots = [...state.items.values()]
      .filter((entry) => entry.kind === "source")
      .sort(compareContentKeys);
    for (const root of roots) {
      const primary = primaryPlacement(state, root.key);
      if (!primary || primary.management === "human" || vectors.rowOf(root.key) === undefined) {
        continue;
      }
      const outcome = placeItem(context, root.key, {
        fingerprint: plan.space?.rootFingerprints.get(root.key) ?? primary.itemFingerprint,
        force: true
      });
      if (outcome.needsGate) gated.push({ rootSourceId: parseItemKey(root.key)!.id });
    }
    recomputeSubtree(state, vectors);
    const events = [...rebuilt.events, ...editor.events];
    const review =
      reason === "space"
        ? rebuilt.review.protectedTouched
        : rebuildNeedsReview(reason, rebuilt.review, isYoungLibrary(youngNotes, plan.config));
    const report = shapeReport(state, plan.config, { areasActive: areasActive(state) });
    const summary = {
      ...this.buildSummary(plan, partition, state, report),
      matched: rebuilt.plan.matched.length,
      created: rebuilt.plan.createdKeys.length,
      retired: rebuilt.retired.length,
      kept: rebuilt.kept.length,
      unnamed: rebuilt.unnamed.length,
      movedShare: rebuilt.movedShare,
      establishedShare: rebuilt.establishedShare,
      exactMatching: rebuilt.plan.exact,
      review: { ...rebuilt.review, required: review },
      ...(plan.space ? { from: plan.space.from, spaceKey: plan.space.treeSpace.spaceKey } : {})
    };
    const repository = createTopicTreeRepository(this.requirePool());
    const meta = {
      treeId: tree.id,
      expectedGeneration: tree.generation,
      origin: "rebuild" as const,
      titleKey: plan.space ? "topics.changeSets.space" : "topics.changeSets.rebuild",
      titleParams: { items: rebuilt.churn.items.length },
      risk: changeSetRisk(rebuilt.movedShare, plan.config),
      jobId: job.id,
      summary,
      events
    };
    if (review && plan.space && switched) {
      // The tree moves with its structure; the rebuild is proposed on the moved tree (D29).
      return this.applySpaceSwitch(plan.space, job, switched, async (generation) => {
        const pending = await repository.applyChangeSet({
          ...meta,
          expectedGeneration: generation,
          titleKey: "topics.changeSets.rebuild",
          status: "pending_review"
        });
        return pending.kind === "pending"
          ? {
              status: "pending_review",
              changeSetId: pending.changeSetId,
              movedShare: rebuilt.movedShare,
              protectedTouched: rebuilt.review.protectedTouched
            }
          : { status: "no_change" };
      });
    }
    if (review) {
      const pending = await repository.applyChangeSet({ ...meta, status: "pending_review" });
      // The cache holds the proposal's result, not the stored tree.
      this.options.service.invalidate();
      return {
        status: pending.kind === "pending" ? "pending_review" : "no_change",
        reason: plan.reason,
        ...(pending.kind === "pending" ? { changeSetId: pending.changeSetId } : {}),
        movedShare: rebuilt.movedShare,
        protectedTouched: rebuilt.review.protectedTouched
      };
    }
    const result = await repository.applyChangeSet({
      ...meta,
      stats: topicStatsWrites(state, vectors, liveTopicIds(state)),
      clock: state.clock,
      ...(plan.space ? { treeSpace: plan.space.treeSpace } : {}),
      ...(plan.configChanged
        ? {
            treeConfig: {
              config: JSON.parse(JSON.stringify(plan.config)) as Record<string, unknown>,
              configHash: plan.configHash
            }
          }
        : {})
    });
    const created = rebuilt.plan.createdKeys.map(
      (key) => rebuilt.plan.topicIdOfKey.get(key) as string
    );
    return this.finishBuild(cache, plan, partition, result, {
      state,
      created: [...created, ...rebuilt.unnamed],
      gated,
      summary,
      applyMs: round(performance.now() - started)
    });
  }

  private buildSummary(
    plan: BuildPlan,
    partition: Partition,
    state: TopicTreeState,
    report: ReturnType<typeof shapeReport>
  ): Record<string, unknown> {
    const signals = structureSignals(state);
    return {
      reason: plan.reason,
      method: partition.method,
      rows: plan.keys.length,
      notes: signals.notes,
      leafCoherence: signals.leafCoherence,
      configHash: plan.configHash,
      seeded: plan.seeding
        ? { rootSource: plan.seeding.rootSource, chapters: plan.seeding.groups.length }
        : null,
      modularity: partition.modularity,
      topics: report.topics - 1,
      leaves: report.leaves,
      meanDepth: report.itemDepth.mean,
      fanOutInTarget: report.fanOut.inTarget,
      hardViolations: report.violations.hardCount
    };
  }

  /** After a build or rebuild change-set: statistics, push, follow-up jobs. */
  private async finishBuild(
    cache: TopicTreeCache,
    plan: BuildPlan,
    partition: Partition,
    result: ApplyChangeSetResult,
    built: {
      state: TopicTreeState;
      created: string[];
      gated: TopicScope[];
      summary: Record<string, unknown>;
      applyMs: number;
    }
  ): Promise<JsonObject> {
    const treeId = cache.tree.id;
    // The cache holds the built state, not the stored tree: the next run loads it again.
    this.options.service.invalidate();
    if (result.kind === "conflict") {
      return result.reason === "treeRetired"
        ? { status: "tree_inactive" }
        : { status: "stale", reason: result.reason };
    }
    if (result.kind !== "applied") return { status: "no_change", reason: plan.reason };
    // The builder's forced repair settled the new structure: nothing waits for REBALANCE.
    this.dirty.delete(treeId);
    const analyzeStarted = performance.now();
    await createTopicTreeRepository(this.requirePool()).analyzeTopicTables();
    const analyzeMs = round(performance.now() - analyzeStarted);
    this.options.changes.record({
      treeId,
      generation: result.generation,
      topicIds: null,
      changeSetId: result.changeSetId
    });
    // Follow-ups: the sweep places what arrived meanwhile, naming names the new topics, the Areas
    // grouping regroups the level-2 topics (T24), the gate decides ambiguous roots, an audit checks.
    await this.options.triggers.sweep("requested", { treeId, debounce: immediateDebounce });
    const follow: Record<string, number> = {};
    if (built.created.length > 0) follow.naming = await this.request(topicJobTypes.name, treeId);
    if (areasGroupingDue(built.state, plan.config)) {
      follow.areas = await this.request(topicJobTypes.areas, treeId, { immediate: true });
    }
    if (plan.space) await this.spaceFollowUps(treeId, plan.space, follow);
    for (const scope of built.gated) {
      follow.gate =
        (follow.gate ?? 0) + (await this.request(topicJobTypes.gate, treeId, { scope }));
    }
    follow.audit = await this.request(topicJobTypes.audit, treeId);
    return {
      status: "applied",
      kind: plan.kind,
      reason: plan.reason,
      changeSetId: result.changeSetId,
      generation: result.generation,
      events: result.events,
      ...built.summary,
      level2Topics: level2TopicCount(built.state),
      followUps: follow,
      timings: {
        loadMs: plan.loadMs,
        clusterMs: partition.clusterMs,
        applyMs: built.applyMs,
        analyzeMs
      }
    };
  }

  // -------------------------------------------------------------------------
  // `topic-rebalance`

  public runRebalance(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const { treeId } = TopicTreePayloadSchema.parse(jobTaskPayload(job.payload));
    return timed(async () => {
      const resolution = await this.options.spaceResolver.resolve();
      const result = await this.options.service.runOnTree(treeId, async (cache) => {
        if (compareTreeSpace(cache.tree, resolution).kind === "space_changed") {
          return { status: "space_changed" };
        }
        return this.rebalanceNow(cache, job, signal);
      });
      return result ?? { status: "tree_inactive" };
    });
  }

  /**
   * REBALANCE (repair.ts) of the topics waiting for it: those the change-sets since the last run
   * touched, those the audit flagged and the checks deferred before (a pass over the whole tree
   * costs seconds at 18k notes, the dirty topics milliseconds). Hard violations first, then soft
   * operations accepted by dQ - lambda * churn > 0 within the cooldown, the freeze on recently
   * opened topics and the day's budgets (seeded from `topic_daily_metrics`, so a reload does not
   * reset them).
   * The root's band is the Areas band once Areas exist; protected operations, and Area-level ones
   * once the tree had its first Areas grouping (T24), become proposals (D12, D29); a proposal
   * waiting for review or dismissed is not repeated.
   */
  private async rebalanceNow(
    cache: TopicTreeCache,
    job: JobRecord,
    signal: AbortSignal
  ): Promise<JsonObject> {
    const { state, vectors, config, tree } = cache;
    if (!hasTopics(state)) return { status: "cold_start" };
    const repository = createTopicTreeRepository(this.requirePool());
    const now = this.now();
    const iso = now.toISOString();
    const day = localDay(now);
    if (state.budget.day !== day) {
      const today = await repository.upsertDailyMetrics({ treeId: tree.id, day });
      state.budget = { day, operations: today.opsApplied, movedItems: today.itemsMoved };
    }
    const frozen = await this.frozenTopics(state, config, iso);
    setFrozenTopics(state, frozen);
    const recentItems = new Set<ItemKey>();
    for (const id of frozen) for (const item of getTopic(state, id).items) recentItems.add(item);
    const areas = areasActive(state);
    // Hard violations the cache shows are checked whatever marked them (I4: a lost mark or a
    // writer that set none never leaves a leaf above its hard maximum after the lane drains).
    const marked = [...this.takeDirty(tree.id), ...hardViolationTopics(state, config)];
    const topics = [...new Set(marked)].sort();
    if (topics.length === 0) return { status: "no_change", checked: 0, areasActive: areas };
    const freshItems = await this.freshItems(tree.id, config, iso, recentItems);
    // Area-level operations wait for review once the tree had its first Areas grouping (D12, T24).
    const grouped = areas ? await repository.changeSetStatusCounts(tree.id, "areas") : null;
    const areaLevelReview = grouped !== null && grouped.applied + grouped.undone > 0;
    const started = performance.now();
    const result = rebalanceTree({
      state,
      vectors,
      config,
      seed: tree.seed,
      now: iso,
      day,
      newTopicId: () => randomUUID(),
      topics,
      recentItems,
      freshItems,
      areasActive: areas,
      areaLevelReview,
      readmit: readmitter(state, vectors, config)
    });
    const engineMs = round(performance.now() - started);
    // What REBALANCE deferred stays dirty for the next run.
    this.markDirty(tree.id, [
      ...result.skipped
        .filter((skip) => deferredReasons.has(skip.reason))
        .map((skip) => skip.topicId),
      ...result.unresolvedHard.map((hard) => hard.topicId)
    ]);
    if (signal.aborted) {
      this.options.service.invalidate();
      throw new Error("topics.errors.canceled");
    }
    const created = result.applied.flatMap((operation) => operation.created);
    const base: JsonObject = {
      checked: topics.length,
      areasActive: areas,
      areaLevelReview,
      frozenTopics: frozen.size,
      freshItems: freshItems.size,
      trials: result.trials,
      exhausted: result.exhausted,
      unresolvedHard: result.unresolvedHard.length,
      engineMs
    };
    let status = "no_change";
    let generation = tree.generation;
    let changeSetId: string | null = null;
    if (result.events.length > 0) {
      // Exact statistics of every touched path (D7): REBALANCE refreshes the spreads of the topics
      // it changed only, and an ancestor's sum may change bits when its children change order.
      const paths = pathsOf(state, [
        ...result.touchedTopics,
        ...topicsWithStaleStats(state, result.events)
      ]);
      recomputePaths(state, vectors, paths);
      const outcome = await repository.applyChangeSet({
        treeId: tree.id,
        expectedGeneration: tree.generation,
        origin: "rebalance",
        titleKey: "topics.changeSets.rebalance",
        titleParams: { operations: result.applied.length, items: result.churn.items },
        risk: changeSetRisk(result.churn.share, config),
        jobId: job.id,
        summary: {
          operations: result.applied.map((operation) => ({
            kind: operation.kind,
            condition: operation.condition,
            trigger: operation.trigger,
            topicId: operation.topicId,
            moved: operation.churn.items.length,
            netGain: operation.netGain
          })),
          movedItems: result.churn.items,
          freshMoved: result.churn.items - result.churn.budgeted,
          movedShare: result.churn.share
        },
        events: result.events,
        stats: topicStatsWrites(state, vectors, paths),
        clock: state.clock
      });
      if (outcome.kind !== "applied") {
        this.options.service.invalidate();
        if (outcome.kind === "conflict" && outcome.reason !== "treeRetired") {
          this.markDirty(tree.id, topics);
          await this.request(topicJobTypes.rebalance, tree.id);
          return { ...base, status: "deferred", reason: outcome.reason };
        }
        return { ...base, status: outcome.kind === "conflict" ? "tree_inactive" : outcome.kind };
      }
      status = "applied";
      generation = outcome.generation;
      changeSetId = outcome.changeSetId;
      cache.tree = { ...cache.tree, generation: outcome.generation, clock: state.clock };
      state.generation = outcome.generation;
      this.options.changes.record({
        treeId: tree.id,
        generation: outcome.generation,
        topicIds:
          result.touchedTopics.length > topicLimits.changedTopicIdsMax
            ? null
            : result.touchedTopics,
        changeSetId: outcome.changeSetId
      });
      await repository.upsertDailyMetrics({
        treeId: tree.id,
        day,
        increments: {
          opsApplied: result.applied.length,
          // The daily move budget counts established items only; path changes count them all.
          itemsMoved: result.churn.budgeted,
          primaryPathChanges: result.churn.items
        }
      });
      if (outcome.dirtyTopicIds.length > 0) {
        // A cascade removed items under this run (D32): reload, and let the sweep restore them.
        this.options.service.invalidate();
        await this.options.triggers.sweep("dirty_stats", { treeId: tree.id });
      }
      if (created.length > 0) await this.request(topicJobTypes.name, tree.id);
      await this.auditIfDue(tree.id, generation);
    }
    const proposed = await this.recordProposals(tree.id, generation, result.proposals, job);
    return {
      ...base,
      status,
      generation,
      ...(changeSetId ? { changeSetId } : {}),
      operations: result.applied.length,
      movedItems: result.churn.items,
      proposals: result.proposals.length,
      proposed
    };
  }

  /** Records new REBALANCE proposals as `pending_review` change-sets (D29), one per key. */
  private async recordProposals(
    treeId: string,
    generation: number,
    proposals: ReturnType<typeof rebalanceTree>["proposals"],
    job: JobRecord
  ): Promise<number> {
    if (proposals.length === 0) return 0;
    const repository = createTopicTreeRepository(this.requirePool());
    const known = new Set(
      (await repository.reviewedProposals(treeId)).flatMap((proposal) =>
        typeof proposal.summary.proposal === "string" ? [proposal.summary.proposal] : []
      )
    );
    let recorded = 0;
    for (const proposal of proposals) {
      if (known.has(proposal.key)) continue;
      known.add(proposal.key);
      const outcome = await repository.applyChangeSet({
        treeId,
        expectedGeneration: generation,
        status: "pending_review",
        origin: "rebalance",
        titleKey: "topics.changeSets.proposal",
        titleParams: { items: proposal.churn.items.length },
        risk: proposal.reason === "area-level" ? "high" : "medium",
        jobId: job.id,
        summary: {
          proposal: proposal.key,
          reason: proposal.reason,
          kind: proposal.kind,
          condition: proposal.condition,
          topicId: proposal.topicId,
          netGain: proposal.netGain,
          moved: proposal.churn.items.length
        },
        events: proposal.events
      });
      if (outcome.kind === "pending") recorded += 1;
    }
    return recorded;
  }

  /** Topics opened within `stability.freezeHours` (the view history), live in this tree. */
  private async frozenTopics(
    state: TopicTreeState,
    config: TopicTreeConfig,
    now: string
  ): Promise<Set<string>> {
    const entries = await createViewHistoryRepository(this.requirePool()).list({
      limit: viewHistoryLimits.listMax,
      kinds: ["topic"]
    });
    const opened = recentlyOpenedTopics(
      entries.map((entry) => ({ topicId: entry.objectId, at: entry.openedAt.toISOString() })),
      now,
      config
    );
    return new Set(
      [...opened].filter((id) => {
        const node = state.topics.get(id);
        return node !== undefined && isLive(node);
      })
    );
  }

  /**
   * Fresh items (stability.freshHours): primary automatic placements made within the window,
   * outside the recently opened topics. Moving them is no churn (stability.ts).
   */
  private async freshItems(
    treeId: string,
    config: TopicTreeConfig,
    now: string,
    recentItems: ReadonlySet<ItemKey>
  ): Promise<Set<ItemKey>> {
    const since = freshWindowStart(now, config);
    if (since === null) return new Set();
    const placed = await createTopicTreeLoadRepository(this.requirePool()).recentlyPlacedItems(
      treeId,
      new Date(since)
    );
    return freshItemsOf(placed, recentItems);
  }

  // -------------------------------------------------------------------------
  // `topic-audit`

  public runAudit(job: JobRecord): Promise<JsonObject> {
    const { treeId } = TopicTreePayloadSchema.parse(jobTaskPayload(job.payload));
    return timed(async () => {
      const result = await this.options.service.runOnTree(treeId, (cache) => this.auditNow(cache));
      return result ?? { status: "tree_inactive" };
    });
  }

  /**
   * The audit (spec 3.5): invariants, the mis-parent audit and an exact-recompute sample on the
   * cached tree, the day's gauges in `topic_daily_metrics`, then what it asks for: a sweep when
   * statistics drifted, REBALANCE for hard violations and re-parent candidates (D12: they go
   * through its acceptance), and a build for a new structural configuration or a rebuild trigger.
   */
  private async auditNow(cache: TopicTreeCache): Promise<JsonObject> {
    const { state, vectors, config, tree } = cache;
    const areas = areasActive(state);
    const started = performance.now();
    const audit = auditTopicTree(state, vectors, config, { seed: tree.seed, areasActive: areas });
    const report = shapeReport(state, config, { areasActive: areas });
    const engineMs = round(performance.now() - started);
    const repository = createTopicTreeRepository(this.requirePool());
    const day = localDay(this.now());
    const soft = Object.values(report.violations.soft).reduce((total, count) => total + count, 0);
    await repository.upsertDailyMetrics({
      treeId: tree.id,
      day,
      gauges: {
        unsortedShare: report.unsortedShare,
        meanDepth: report.itemDepth.mean,
        fanoutInTarget: report.fanOut.inTarget,
        hardViolations: report.violations.hardCount,
        softViolations: soft
      }
    });
    this.lastAudit = { treeId: tree.id, generation: tree.generation, day };
    const requested: Record<string, number> = {};
    if (audit.recomputeTopics.length > 0) {
      this.options.service.invalidate();
      requested.sweep = (
        await this.options.triggers.sweep("dirty_stats", { treeId: tree.id })
      ).length;
    }
    const reparent = audit.reparentCandidates.filter((finding) => !finding.protected).length;
    // Topics out of their bands (hard or soft, protected ones to be proposed) and the re-parent
    // candidates (D12: they go through REBALANCE acceptance, which turns protected and Area-level
    // ones into proposals) wait for REBALANCE.
    const flagged = new Set<string>([
      ...audit.invariants.violations.flatMap((violation) =>
        violation.topicId === null || violation.topicId === state.rootId ? [] : [violation.topicId]
      ),
      ...audit.reparentCandidates.map((finding) => finding.topicId)
    ]);
    if (hasTopics(state) && flagged.size > 0) {
      this.markDirty(tree.id, flagged);
      requested.rebalance = await this.request(topicJobTypes.rebalance, tree.id);
    }
    let rebuild: string | null = null;
    if (hasTopics(state)) {
      const effective = this.options.effectiveConfig();
      const decision = await this.rebuildDecision(
        cache,
        effective,
        structuralConfigHash(effective)
      );
      if ("reason" in decision) {
        rebuild = decision.reason;
        requested.build = await this.request(topicJobTypes.build, tree.id, { immediate: true });
      }
    }
    return {
      status: "audited",
      generation: tree.generation,
      areasActive: areas,
      reachability: report.reachability,
      hardViolations: report.violations.hardCount,
      awaitingApproval: report.violations.awaitingApproval,
      softViolations: soft,
      misParented: audit.misParent.findings.length,
      reparentCandidates: reparent,
      flaggedTopics: flagged.size,
      driftedTopics: audit.recomputeTopics.length,
      flagged: { ...audit.flaggedItems },
      unsortedShare: report.unsortedShare,
      meanDepth: report.itemDepth.mean,
      fanOutInTarget: report.fanOut.inTarget,
      rebuild,
      requested,
      engineMs
    };
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
