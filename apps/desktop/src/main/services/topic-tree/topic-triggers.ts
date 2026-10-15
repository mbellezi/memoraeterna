// The trigger API of the topic engine: the calls the rest of the main process makes when notes or
// sources change (the call sites reach it through `topic-hooks.ts`, T15b). Each call enqueues
// deduped, debounced light-lane jobs (spec 3.5): `topic-place` per root source (or per note without
// one), `topic-sweep` for the whole tree and, after a deletion, `topic-rebalance`. A trigger may run
// inside the caller's transaction (pass its client); the job then exists exactly when the change
// commits. Nothing here decides a placement.
import {
  createJobRepository,
  createTopicTreeLoadRepository,
  createTopicTreeRepository,
  immediateJobDebounce
} from "@app/db";
import type { JobDebounce, JobRecord, JsonObject, PgPool, Queryable } from "@app/db";

import { scopePayload, topicDedupeKey, topicJobTypes } from "./topic-jobs.js";
import type { TopicJobType, TopicScope, TopicSweepReason } from "./topic-jobs.js";

export interface TopicTriggerOptions {
  /** The caller's open transaction: the jobs commit or roll back with its change. */
  client?: Queryable;
}

/** A topic job a trigger enqueued (or an existing queued job that absorbed the request). */
export interface EnqueuedTopicJob {
  job: JobRecord;
  type: TopicJobType;
  scope: TopicScope | null;
}

export interface TopicTriggersOptions {
  getPool: () => PgPool | null;
  /** Job types with an executor; a request for another type is skipped, never queued unclaimed. */
  isRegistered: (type: string) => boolean;
  /** `topics.jobs` of the active configuration (the light-lane debounce). */
  debounce: () => JobDebounce;
  onEnqueued?: (job: EnqueuedTopicJob) => void;
  /** Wakes the light lane after an enqueue outside a transaction. */
  wake?: () => void;
}

/** True when a topic of the tree has inexact statistics: a cascade removed items under them. */
async function hasDirtyStats(db: Queryable, treeId: string): Promise<boolean> {
  const result = await db.query<{ dirty: boolean }>(
    `select exists (
       select 1 from topic_stats s join topics t on t.id = s.topic_id
        where t.tree_id = $1 and s.dirty
     ) as dirty`,
    [treeId]
  );
  return result.rows[0]?.dirty === true;
}

/**
 * Runs a job as soon as possible (a sweep at startup, places a sweep found). Merged into a queued
 * job of its key it makes that job due now, and no debounced request moves it back.
 */
export const immediateDebounce: Readonly<JobDebounce> = immediateJobDebounce;

export class TopicTriggers {
  public constructor(private readonly options: TopicTriggersOptions) {}

  /**
   * Notes were embedded or re-embedded, or their status or supersession changed: PLACE their
   * roots (a note without a root source on its own). A note that no longer exists left the tree
   * by cascade (D32): the sweep repairs its topics' statistics.
   */
  public async notesChanged(
    noteIds: readonly string[],
    options: TopicTriggerOptions = {}
  ): Promise<EnqueuedTopicJob[]> {
    const db = this.database(options);
    if (!db || noteIds.length === 0) return [];
    const treeId = await this.activeTreeId(db);
    if (!treeId) return this.sweepWithoutTree(db, options);
    const owners = await createTopicTreeLoadRepository(db).itemOwners({ noteIds });
    const scopes: TopicScope[] = [];
    let deleted = false;
    for (const id of new Set(noteIds.map((noteId) => noteId.toLowerCase()))) {
      const owner = owners.notes.get(id);
      if (!owner) deleted = true;
      else scopes.push(owner.rootSourceId ? { rootSourceId: owner.rootSourceId } : { noteId: id });
    }
    const jobs = await this.placeScopes(db, treeId, scopes, options);
    if (deleted) jobs.push(...(await this.enqueue(db, topicJobTypes.sweep, treeId, null, options)));
    return jobs;
  }

  /** A source's composite vector was written or the source changed: PLACE its root. */
  public async sourcesChanged(
    sourceItemIds: readonly string[],
    options: TopicTriggerOptions = {}
  ): Promise<EnqueuedTopicJob[]> {
    const db = this.database(options);
    if (!db || sourceItemIds.length === 0) return [];
    const treeId = await this.activeTreeId(db);
    if (!treeId) return this.sweepWithoutTree(db, options);
    const owners = await createTopicTreeLoadRepository(db).itemOwners({ sourceIds: sourceItemIds });
    const scopes: TopicScope[] = [];
    for (const owner of owners.sources.values()) {
      if (owner.rootSourceId) scopes.push({ rootSourceId: owner.rootSourceId });
    }
    return this.placeScopes(db, treeId, scopes, options);
  }

  /**
   * Notes or sources were deleted and their placements left by cascade (D32): when that left
   * statistics inexact, enqueue the sweep that restores them and the rebalance that follows. A
   * deletion that touched no placed item enqueues nothing. The dirty flag is the durable record:
   * a lost job here is found again by the startup sweep and by every cache load.
   */
  public async repair(options: TopicTriggerOptions = {}): Promise<EnqueuedTopicJob[]> {
    const db = this.database(options);
    if (!db) return [];
    const treeId = await this.activeTreeId(db);
    if (!treeId || !(await hasDirtyStats(db, treeId))) return [];
    return [
      ...(await this.enqueue(db, topicJobTypes.sweep, treeId, null, options, {
        reason: "dirty_stats"
      })),
      ...(await this.enqueue(db, topicJobTypes.rebalance, treeId, null, options))
    ];
  }

  /** PLACE of known scopes of a tree (the sweep's fan-out). */
  public async place(
    treeId: string,
    scopes: readonly TopicScope[],
    options: TopicTriggerOptions & { debounce?: JobDebounce } = {}
  ): Promise<EnqueuedTopicJob[]> {
    const db = this.database(options);
    if (!db) return [];
    return this.placeScopes(db, treeId, scopes, options);
  }

  /** The tree-wide reachability net: pending items, flagged items and dirty statistics. */
  public async sweep(
    reason: TopicSweepReason,
    options: TopicTriggerOptions & { treeId?: string | null; debounce?: JobDebounce } = {}
  ): Promise<EnqueuedTopicJob[]> {
    const db = this.database(options);
    if (!db) return [];
    const treeId = options.treeId === undefined ? await this.activeTreeId(db) : options.treeId;
    return this.enqueue(db, topicJobTypes.sweep, treeId, null, options, { reason });
  }

  /**
   * Any other registered topic job of a tree: the gate per scope, or a tree-wide job (build,
   * rebalance, audit, naming, Areas, labels). Unregistered types are skipped.
   */
  public async request(
    type: Exclude<TopicJobType, "topic-place" | "topic-sweep">,
    treeId: string,
    scope: TopicScope | null = null,
    options: TopicTriggerOptions & { debounce?: JobDebounce } = {}
  ): Promise<EnqueuedTopicJob[]> {
    const db = this.database(options);
    if (!db) return [];
    return this.enqueue(db, type, treeId, scope, options);
  }

  private async placeScopes(
    db: Queryable,
    treeId: string,
    scopes: readonly TopicScope[],
    options: TopicTriggerOptions & { debounce?: JobDebounce }
  ): Promise<EnqueuedTopicJob[]> {
    const unique = new Map<string, TopicScope>();
    for (const scope of scopes)
      unique.set(topicDedupeKey(topicJobTypes.place, treeId, scope), scope);
    const jobs: EnqueuedTopicJob[] = [];
    for (const key of [...unique.keys()].sort()) {
      jobs.push(
        ...(await this.enqueue(db, topicJobTypes.place, treeId, unique.get(key)!, options))
      );
    }
    return jobs;
  }

  private sweepWithoutTree(db: Queryable, options: TopicTriggerOptions) {
    return this.enqueue(db, topicJobTypes.sweep, null, null, options, { reason: "requested" });
  }

  private async enqueue(
    db: Queryable,
    type: TopicJobType,
    treeId: string | null,
    scope: TopicScope | null,
    options: TopicTriggerOptions & { debounce?: JobDebounce },
    extra: JsonObject = {}
  ): Promise<EnqueuedTopicJob[]> {
    if (!this.options.isRegistered(type)) return [];
    const payload: JsonObject =
      type === topicJobTypes.sweep
        ? { treeId, reason: extra.reason ?? "requested" }
        : scope
          ? scopePayload(treeId as string, scope)
          : { treeId };
    const { job } = await createJobRepository(db).enqueueDeduped({
      type,
      lane: "light",
      dedupeKey: topicDedupeKey(type, treeId, scope ?? undefined),
      payload,
      debounce: options.debounce ?? this.options.debounce()
    });
    const enqueued: EnqueuedTopicJob = { job, type, scope };
    this.options.onEnqueued?.(enqueued);
    if (!options.client) this.options.wake?.();
    return [enqueued];
  }

  private database(options: TopicTriggerOptions): Queryable | null {
    return options.client ?? this.options.getPool();
  }

  private async activeTreeId(db: Queryable): Promise<string | null> {
    const pool = this.options.getPool();
    if (!pool) return null;
    return (await createTopicTreeRepository(pool).activeTree(db))?.id ?? null;
  }
}
