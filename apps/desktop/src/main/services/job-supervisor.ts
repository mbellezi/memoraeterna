import { jobTaskPayload } from "../job-task-payload.js";
import { promptStageProviders } from "./prompt-strategies.js";
import { aiErrorRetryAfterMs } from "@app/ai";
import {
  PromptPinSchema,
  relationsConfig as defaultRelationsConfig,
  waitingForDeciderSkipReason,
  type RelationsConfig
} from "@app/domain";
import {
  withPromptPin,
  capturePromptPin,
  renderPrompt,
  stagePromptFingerprints
} from "./prompt-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";

import {
  matchAtomicNotesFromCheckpoint,
  readAtomicNoteMatchingCheckpoint
} from "./atomic-note-matching-checkpoint.js";
import { InFlightRegistry } from "./relations/in-flight-registry.js";
import { relationLinkRuntime } from "./relations/link-runtime.js";
import {
  createRelationCallBudget,
  localDay,
  type RelationCallBudget
} from "./relations/relation-call-budget.js";
import {
  enqueueRelationLink,
  enqueueRelationRetypeSweep,
  hasPendingRelationJobs,
  hasUntypedRelations,
  isInteractiveRun,
  linkRootOf,
  RelationLinker
} from "./relations/relation-link.js";
import {
  RelationsChangedEmitter,
  type RelationsChangedEvent
} from "./relations/relations-changed.js";
import {
  createChunkRepository,
  createDocumentRepository,
  createAtomicNoteRepository,
  createEmbeddingRepository,
  createIngestionRunRepository,
  createJobRepository,
  createKnowledgeGraphRepository,
  createProcessingTaskRepository,
  createHierarchicalIngestionRepository,
  createSourceItemRepository,
  type JobLane,
  type JobRecord,
  type JsonObject,
  type PgPool,
  type ReplaceDocumentChunksOptions,
  type UpdateJobInput
} from "@app/db";
import { chunkMarkdown } from "@app/conversion";

import { WorkerSupervisor } from "./worker-supervisor.js";
import { buildCatalogMetadataMarkdown } from "./hierarchical-ingestion-service.js";
import {
  countCompositeBackfillWork,
  hierarchyRootComposite,
  refreshAncestorComposites
} from "./source-composite.js";
import {
  compositeBackfillJobType,
  enqueueCompositeBackfill,
  runCompositeBackfill
} from "./relations/composite-backfill.js";
import {
  CatalogHeaderGate,
  catalogHeaderJobType,
  enqueueCatalogHeaderRefresh,
  runCatalogHeaderRefresh
} from "./catalog-header-refresh.js";
import { catalogHeaderConfig } from "./catalog-header-policy.js";
import type { KnowledgeService } from "./knowledge-service.js";
import type { ObsidianSyncService } from "./obsidian-sync-service.js";
import type { TopicChangeHooks } from "./topic-tree/topic-hooks.js";
import { logStructuredError } from "./structured-logging.js";
import {
  embedChunkVectors,
  embedHeaderVectors,
  type EmbeddingBatchGenerator
} from "./embedding-stage.js";
import {
  canManuallyRetryJob,
  isWaitingForDecider,
  manualRetryStages,
  stageRetryStages
} from "./job-retry.js";
import { isTransientJobFailure } from "./job-failure.js";
import type { WorkerTask } from "../workers/worker-contracts.js";
import {
  JobLoop,
  lightWorkers,
  lightWorkerTypes,
  type HeavyJobRegistry,
  type LightJobExecutor,
  type LightJobRegistry,
  type LightWorker
} from "./job-lanes.js";

export interface JobSupervisorOptions {
  traceOperation?: <T>(
    operation: string,
    context: Record<string, unknown>,
    run: () => Promise<T>
  ) => Promise<T>;
  getPool: () => PgPool | null;
  processRelationLabels?: (job: JobRecord, signal: AbortSignal) => Promise<JsonObject>;
  pollIntervalMs?: number;
  logger?: Pick<Console, "error" | "warn">;
  generateEmbedding?: (
    text: string,
    signal?: AbortSignal,
    context?: {
      jobId: string;
      ingestionRunId?: string;
      sourceItemId: string;
      documentId?: string;
      stage: string;
      embeddingInputType: "document";
      chunkId?: string;
      priority?: "P2" | "P3";
    }
  ) => Promise<{
    embedding: number[];
    provider: string;
    model: string;
    runtime: string;
    spaceKey?: string;
  } | null>;
  /**
   * Embeds several texts in one request, at most 32 (F3 D37); the embedding stage uses it instead of
   * `generateEmbedding` when it is set.
   */
  generateEmbeddings?: (
    texts: string[],
    signal?: AbortSignal,
    context?: {
      jobId: string;
      ingestionRunId?: string;
      sourceItemId: string;
      documentId?: string;
      stage: string;
      embeddingInputType: "document";
      chunkIds?: string[];
      priority?: "P2" | "P3";
    }
  ) => Promise<{
    embeddings: number[][];
    provider: string;
    model: string;
    runtime: string;
    spaceKey?: string;
  } | null>;
  /**
   * The embedding space the route writes to, known without a call. With it the embedding stage
   * keeps the vector of a chunk whose text and space are unchanged instead of embedding it again.
   */
  embeddingSpaceKey?: () => Promise<string | null>;
  knowledgeService?: KnowledgeService;
  obsidianSyncService?: Pick<ObsidianSyncService, "projectSource"> & {
    wiki?: ObsidianSyncService["wiki"];
  };
  releaseAiRuntime?: () => Promise<void>;
  /** Light-lane job types; a worker runs only when it has a type (D33). */
  lightJobs?: LightJobRegistry;
  /** DEV-only heavy job types (the relation re-match harness); never a built-in or a light type. */
  devHeavyJobs?: HeavyJobRegistry;
  /**
   * The topic engine's hooks (T15b): a note whose vector was rebuilt, a source whose composite
   * vector was written and a document whose chunks were replaced all reach the topic tree.
   */
  topicHooks?: TopicChangeHooks;
  /** Relations v2 typed configuration (link pool, typing, cap); the defaults when absent. */
  relationsConfig?: RelationsConfig;
  /** The daily cap of background remote relation calls; the settings counter when absent. */
  relationCallBudget?: RelationCallBudget;
}

/** How often an idle heavy loop looks for relation maintenance (decider waits, the daily sweep). */
const relationMaintenanceIntervalMs = 30_000;

/** Deterministic: the document has no text, so a retry can only fail again. */
const emptyDocumentError = "errors.conversion.emptyResult";

const supportedJobTypes = new Set<string>([
  "relation-labels",
  "ingestion",
  "markdown-conversion",
  "chunking",
  "embedding",
  "note-embedding",
  "atomic-note-generation",
  "obsidian-sync",
  "asset-storage"
]);

/** The vault projection (D30): a pass is one job, queued again page by page, on `compute`. */
const projectionJobType = "obsidian-wiki";

/**
 * Runs persisted jobs in two lanes: one heavy loop (ingestion) and the light lane's `compute`,
 * `model` and `relations` workers, which claim disjoint light job types. The vault projection is a
 * light `compute` job, delivered page by page, so placements interleave with it. The link jobs of
 * relations v2 run on the `relations` worker, with a pool of their own (F3 D24). Each loop runs one
 * job at a time and never waits for another loop.
 */
export class JobSupervisor {
  private readonly workers = new WorkerSupervisor();
  private readonly controllers = new Map<string, AbortController>();
  private running = false;
  private readonly heavyLoop: JobLoop;
  private readonly lightLoops: JobLoop[];
  private readonly lightJobs: LightJobRegistry;
  private readonly devHeavyJobs: HeavyJobRegistry;
  private readonly lightTypes: Readonly<Record<LightWorker, readonly string[]>>;
  private readonly pendingProgressUpdates = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private readonly workerId = `${hostname()}:${process.pid}`;
  private readonly relationsConfig: RelationsConfig;
  /** The link jobs of relations v2 (F3 D24); present with a knowledge service. */
  private readonly linker: RelationLinker | null;
  private readonly relationsChanged: RelationsChangedEmitter;
  /** One catalog-header pass at a time (T53h): the next waits for the one running. */
  private readonly catalogHeaderGate = new CatalogHeaderGate();
  private lastRelationMaintenance = Number.NEGATIVE_INFINITY;
  private retypeSweepDay: string | null = null;
  /** The last heavy pass waited for relation jobs (drain mode): the lane is held, not idle. */
  private heavyHeldForLinks = false;

  public constructor(private readonly options: JobSupervisorOptions) {
    const wiki = options.obsidianSyncService?.wiki;
    if (wiki && options.lightJobs?.[projectionJobType])
      throw new Error(`job_lane_conflict:${projectionJobType}`);
    this.relationsConfig = options.relationsConfig ?? defaultRelationsConfig;
    this.relationsChanged = new RelationsChangedEmitter({
      onListenerError: (error) => this.options.logger?.warn(normalizeWorkerError(error))
    });
    this.linker = options.knowledgeService ? this.createLinker(options.knowledgeService) : null;
    const relationJobs = this.linker?.jobs() ?? {};
    for (const type of Object.keys(relationJobs))
      if (options.lightJobs?.[type]) throw new Error(`job_lane_conflict:${type}`);
    if (options.lightJobs?.[compositeBackfillJobType])
      throw new Error(`job_lane_conflict:${compositeBackfillJobType}`);
    if (options.lightJobs?.[catalogHeaderJobType])
      throw new Error(`job_lane_conflict:${catalogHeaderJobType}`);
    const compositeBackfill = this.compositeBackfillExecutor();
    const catalogHeader = this.catalogHeaderExecutor();
    this.lightJobs = {
      ...options.lightJobs,
      ...relationJobs,
      ...(compositeBackfill ? { [compositeBackfillJobType]: compositeBackfill } : {}),
      ...(catalogHeader ? { [catalogHeaderJobType]: catalogHeader } : {}),
      ...(wiki
        ? {
            [projectionJobType]: {
              needsModel: false,
              execute: (job: JobRecord, signal: AbortSignal) => wiki.execute(job, signal)
            }
          }
        : {})
    };
    for (const type of Object.keys(this.lightJobs))
      if (supportedJobTypes.has(type)) throw new Error(`job_lane_conflict:${type}`);
    this.devHeavyJobs = options.devHeavyJobs ?? {};
    for (const type of Object.keys(this.devHeavyJobs))
      if (supportedJobTypes.has(type) || this.lightJobs[type])
        throw new Error(`job_lane_conflict:${type}`);
    this.lightTypes = lightWorkerTypes(this.lightJobs);
    // Only the heavy loop polls the idle release, as often as before the lanes existed.
    this.heavyLoop = this.createLoop(
      async () => (await this.runOnce()) !== null,
      () => this.idle()
    );
    // The `relations` worker has a pool: each loop claims only while its slot is in the pool of
    // the current runtime (1 in drain mode, so link jobs run first in, first out).
    const relationSlots = Math.max(
      this.relationsConfig.link.poolSize,
      this.relationsConfig.link.drainPoolSize
    );
    this.lightLoops = lightWorkers
      .filter((worker) => this.lightTypes[worker].length > 0)
      .flatMap((worker) =>
        worker === "relations"
          ? Array.from({ length: relationSlots }, (_, slot) =>
              this.createLoop(
                async () =>
                  slot < this.relationsPoolSize() &&
                  (await this.runLightOnce(worker, slot)) !== null
              )
            )
          : [this.createLoop(async () => (await this.runLightOnce(worker)) !== null)]
      );
  }

  /**
   * The backfill of hierarchy-root composites (T53f), on the `relations` worker: low priority, its
   * header embeddings at P3, never on the heavy ingestion lane. It needs an embedding model and the
   * space the route writes to; a supervisor without them has no such job.
   */
  private compositeBackfillExecutor(): LightJobExecutor | null {
    const generate = this.embeddingBatchGenerator();
    const spaceKey = this.options.embeddingSpaceKey;
    if (!generate || !spaceKey) return null;
    return {
      needsModel: true,
      worker: "relations",
      execute: (job, signal) =>
        runCompositeBackfill(
          {
            getPool: () => this.requirePool(),
            embeddingSpaceKey: spaceKey,
            generate,
            aggregate: aggregateSourceEmbedding,
            topicHooks: this.options.topicHooks,
            reportProgress: (running, progress) => this.reportInlineProgress(running.id, progress),
            ...(this.options.logger ? { logger: this.options.logger } : {})
          },
          job,
          signal
        )
    };
  }

  /**
   * Queues the composite backfill when a hierarchy node lacks the composite its descendants imply
   * (deduplicated: a queued job absorbs the request; none when there is nothing to build), or
   * whatever the library holds with `always` (the pass then also rebuilds stale composites). Resolves
   * true when a job is queued; false without work, without an embedding model, or when the job
   * type is not wired here.
   */
  public async ensureCompositeBackfill(options: { always?: boolean } = {}): Promise<boolean> {
    if (!this.lightJobs[compositeBackfillJobType]) return false;
    const spaceKey = await this.options.embeddingSpaceKey?.();
    if (!spaceKey) return false;
    const queued = await enqueueCompositeBackfill(this.requirePool(), spaceKey, options);
    if (queued) this.wakeLoops("light");
    return queued;
  }

  /**
   * The header refresh of hierarchy roots (T53h, plan decision 27), on the `relations` worker behind
   * the link jobs, its embeddings and graph call at P3: a book's catalog header chunk follows its
   * summary. It needs the knowledge service (the graph) or an embedding model (the vectors).
   */
  private catalogHeaderExecutor(): LightJobExecutor | null {
    const generate = this.embeddingBatchGenerator();
    const knowledge = this.options.knowledgeService;
    if (!knowledge && !(generate && this.options.embeddingSpaceKey)) return null;
    return {
      needsModel: true,
      worker: "relations",
      held: () => this.catalogHeaderGate.busy,
      execute: (job, signal) =>
        this.catalogHeaderGate.run(() =>
          runCatalogHeaderRefresh(
            {
              getPool: () => this.requirePool(),
              embeddingSpaceKey: this.options.embeddingSpaceKey,
              generate,
              validate: async (embedding) => {
                const validated = await this.workers.execute(
                  "embedding",
                  { embedding },
                  { signal }
                );
                return Array.isArray(validated.embedding) ? validated.embedding.map(Number) : [];
              },
              aggregate: aggregateSourceEmbedding,
              knowledge,
              // The remote graph calls of the refresh are capped per local day (T53h).
              budget: createRelationCallBudget({
                db: () => this.requirePool(),
                cap: () => catalogHeaderConfig.dailyRemoteRoots,
                settingKey: catalogHeaderConfig.dailyRootsSettingKey
              }),
              persistHeaderChunk: persistCatalogMetadataChunk,
              topicHooks: this.options.topicHooks,
              reportProgress: (running, progress) =>
                this.reportInlineProgress(running.id, progress),
              // The composites left are the backfill's, after the headers (no header embedded twice).
              afterPass: () => this.ensureCompositeBackfill(),
              logger: this.options.logger
            },
            job,
            signal
          )
        )
    };
  }

  /**
   * Queues the header refresh when a hierarchy root's catalog header lacks the summary the root has
   * and no import is working on it (`rootIds` limits the look to those roots). Never fails its
   * caller: a summary write or a finished import is not undone by a request that could not be made.
   */
  public async ensureCatalogHeaderRefresh(options: { rootIds?: readonly string[] } = {}) {
    if (!this.lightJobs[catalogHeaderJobType]) return false;
    try {
      const queued = await enqueueCatalogHeaderRefresh(this.requirePool(), options);
      if (queued) this.wakeLoops("light");
      return queued;
    } catch (error) {
      this.options.logger?.warn(normalizeWorkerError(error));
      return false;
    }
  }

  /** A summary was written or cleared for these roots, or a catalog run ended: their headers follow. */
  private async followSummaries(rootIds: readonly string[] | undefined): Promise<void> {
    if (rootIds?.length) await this.ensureCatalogHeaderRefresh({ rootIds });
  }

  /**
   * How many hierarchy nodes still lack a composite although every descendant has one, in the space
   * the route writes to (0 without an embedding model). The re-match harness waits for 0.
   */
  public async compositeBackfillRemaining(): Promise<number> {
    if (!this.lightJobs[compositeBackfillJobType]) return 0;
    const spaceKey = await this.options.embeddingSpaceKey?.();
    return spaceKey ? countCompositeBackfillWork(this.requirePool(), spaceKey) : 0;
  }

  /** The link jobs and their steps, which the knowledge service provides (T52). */
  private createLinker(knowledge: KnowledgeService): RelationLinker {
    return new RelationLinker({
      getPool: () => this.requirePool(),
      steps: {
        typeRelationPairs: (pairs, options, signal) =>
          knowledge.typeRelationPairs(pairs, options, signal),
        discoverSourceRelations: (input, signal) =>
          knowledge.discoverSourceRelations(input, signal),
        // Design E's promotion (T53, D27, R14), with no call.
        promoteSourceRelations: (rootIds) => knowledge.promoteSourceRelations(rootIds)
      },
      registry: new InFlightRegistry(),
      budget:
        this.options.relationCallBudget ??
        createRelationCallBudget({
          db: () => this.requirePool(),
          cap: () => this.relationsConfig.ai.maxBackgroundCallsPerDay
        }),
      config: this.relationsConfig,
      relationsChanged: (noteIds) => this.relationsChanged.changed(noteIds),
      runsSettled: async (runs) => {
        const hierarchy = createHierarchicalIngestionRepository(this.requirePool());
        for (const batchId of new Set(runs.flatMap((run) => (run.batchId ? [run.batchId] : []))))
          await hierarchy.refreshBatch(batchId);
        this.notify();
      },
      ...(this.options.logger ? { logger: this.options.logger } : {})
    });
  }

  /** The link jobs that run at once: the configured pool, or the drain pool (golden, re-match). */
  private relationsPoolSize(): number {
    return relationLinkRuntime().drain
      ? this.relationsConfig.link.drainPoolSize
      : this.relationsConfig.link.poolSize;
  }

  /** The `relationsChanged` push (F3 3.11 step 4): notes whose relations a link job changed. */
  public subscribeRelationsChanged(listener: (event: RelationsChangedEvent) => void): () => void {
    return this.relationsChanged.subscribe(listener);
  }

  /**
   * Notes whose relations changed outside a link job (a veto from an explanation, the owner's
   * review): they join the same coalesced push, so open pages read their relations once per burst.
   */
  public announceRelationsChanged(noteIds: Iterable<string>): void {
    this.relationsChanged.changed(noteIds);
  }

  public async start(): Promise<void> {
    if (this.running) return;
    const pool = this.requirePool();
    await createJobRepository(pool).recoverInterrupted();
    const runs = createIngestionRunRepository(pool);
    await runs.recoverInterrupted();
    // A run parked for its link job survives a restart: its root's link job is queued again (a
    // queued one absorbs the request), so no run is left waiting for a job that is gone.
    if (this.linker)
      try {
        for (const sourceItemId of await runs.listLinkingSourceItems())
          await enqueueRelationLink(pool, { rootId: await linkRootOf(pool, sourceItemId) });
      } catch (error) {
        this.options.logger?.warn(normalizeWorkerError(error));
      }
    // Once per start, before the loops: the hierarchy roots a library holds without a composite
    // (ingested before a chapter's embedding refreshed them) are built in the background (T53f),
    // after the headers built without a summary that exists are rebuilt with it (T53h), which build
    // their roots' composites from the same header; the header pass asks for the backfill when done.
    try {
      if (!(await this.ensureCatalogHeaderRefresh())) await this.ensureCompositeBackfill();
    } catch (error) {
      this.options.logger?.warn(normalizeWorkerError(error));
    }
    this.running = true;
    for (const loop of this.loops()) loop.start();
  }

  /** Stops every loop and resolves once each one's job in progress has ended. */
  public async stop(): Promise<void> {
    this.running = false;
    const stopped = this.loops().map((loop) => loop.stop());
    for (const controller of this.controllers.values()) controller.abort();
    await this.workers.shutdown();
    await Promise.all(stopped);
    await Promise.allSettled(this.pendingProgressUpdates);
    this.controllers.clear();
    this.relationsChanged.flush();
  }

  /** One heavy pass: at most one heavy job. */
  public async runOnce(): Promise<JobRecord | null> {
    // Drain mode (golden and re-match runs): the next heavy job waits for the link jobs queued so
    // far, so each one runs between its source and the next and every prompt is a function of
    // the arrival order (3.11), not of how far the next source's ingestion has got.
    this.heavyHeldForLinks =
      relationLinkRuntime().drain &&
      (await hasPendingRelationJobs(this.requirePool(), this.lightTypes.relations));
    if (this.heavyHeldForLinks) return null;
    const repository = createJobRepository(this.requirePool());
    const job = await repository.claimNext(
      this.workerId,
      [...supportedJobTypes, ...Object.keys(this.devHeavyJobs)],
      "heavy"
    );
    if (!job) return null;
    this.notify();
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const devHeavy = this.devHeavyJobs[job.type];
      if (!devHeavy && !supportedJobTypes.has(job.type as WorkerTask["type"]))
        throw new Error("unsupported_job_type");
      const taskJob = { ...job, payload: jobTaskPayload(job.payload) };
      const execute = async () =>
        withPromptPin(
          job.payload.promptPin ? PromptPinSchema.parse(job.payload.promptPin) : null,
          async () =>
            job.type === "relation-labels"
              ? await this.options.processRelationLabels!(taskJob, controller.signal)
              : job.type === "ingestion"
                ? await this.executeIngestion(taskJob, controller)
                : job.type === "note-embedding"
                  ? await this.executeNoteEmbedding(taskJob, controller.signal)
                  : await this.workers.execute(job.type as WorkerTask["type"], taskJob.payload, {
                      signal: controller.signal,
                      onProgress: (progress) =>
                        this.trackProgress(repository.reportProgress(job.id, progress))
                    })
        );
      // A DEV heavy job holds the heavy loop like ingestion does but is none of its work.
      const run = devHeavy ? () => devHeavy.execute(taskJob, controller.signal) : execute;
      const result = await (this.options.traceOperation?.(
        job.type,
        {
          jobId: job.id,
          ingestionRunId: job.payload.ingestionRunId,
          sourceItemId: job.payload.sourceItemId,
          documentId: job.payload.documentId,
          origin: "job",
          attempt: job.attempts
        },
        run
      ) ?? run());
      const updated = await repository.update(job.id, finishedJob(job, result, controller.signal));
      const batchId = optionalString(job.payload.batchId);
      if (batchId)
        await createHierarchicalIngestionRepository(this.requirePool()).refreshBatch(batchId);
      await this.reembeddingEnded(job);
      this.notify();
      return updated;
    } catch (error) {
      const wasCanceled = controller.signal.aborted;
      const shouldRetry =
        !wasCanceled && job.attempts < job.maxAttempts && isTransientJobFailure(error);
      if (job.type === "ingestion" && typeof job.payload.ingestionRunId === "string") {
        const runs = createIngestionRunRepository(this.requirePool());
        if (wasCanceled) {
          await runs.cancel(job.payload.ingestionRunId);
        } else {
          await runs.fail(job.payload.ingestionRunId, normalizeWorkerError(error));
        }
      }
      const updated = await repository.update(
        job.id,
        failedJob(job, error, wasCanceled, shouldRetry)
      );
      // A failed run holds back no sibling: each source decides and links by itself (F3 D24).
      const batchId = optionalString(job.payload.batchId);
      if (batchId)
        await createHierarchicalIngestionRepository(this.requirePool()).refreshBatch(batchId);
      if (!shouldRetry) await this.reembeddingEnded(job);
      this.notify();
      return updated;
    } finally {
      this.controllers.delete(job.id);
    }
  }

  /**
   * One pass of a light worker: at most one light job of its types, never a heavy one. A held
   * type is skipped while held: its jobs stay queued (the topic barrier, D23). `slot` names the
   * loop of a pooled worker (`relations`).
   */
  public async runLightOnce(worker: LightWorker, slot = 0): Promise<JobRecord | null> {
    // The vault projection's admission runs where its pages run: a pass starts when the canonical
    // data, the topic tree or the binding changed since the last one.
    if (worker === "compute" && this.lightTypes.compute.includes(projectionJobType))
      try {
        await this.options.obsidianSyncService?.wiki?.enqueue();
      } catch {
        this.options.logger?.warn("Wiki synchronization admission is temporarily unavailable");
      }
    const types = this.lightTypes[worker].filter((type) => !this.lightJobs[type]!.held?.());
    if (types.length === 0) return null;
    const repository = createJobRepository(this.requirePool());
    const job = await repository.claimNext(
      `${this.workerId}:light-${worker}${slot > 0 ? `-${slot}` : ""}`,
      types,
      "light"
    );
    if (!job) return null;
    this.notify();
    const executor = this.lightJobs[job.type]!;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const taskJob = { ...job, payload: jobTaskPayload(job.payload) };
      const execute = async () =>
        withPromptPin(
          job.payload.promptPin ? PromptPinSchema.parse(job.payload.promptPin) : null,
          () => executor.execute(taskJob, controller.signal)
        );
      const result = await (this.options.traceOperation?.(
        job.type,
        {
          jobId: job.id,
          sourceItemId: job.payload.sourceItemId,
          origin: "job",
          lane: "light",
          attempt: job.attempts
        },
        execute
      ) ?? execute());
      const updated = await repository.update(
        job.id,
        lightJobUpdate(job, result, controller.signal)
      );
      this.notify();
      return updated;
    } catch (error) {
      const wasCanceled = controller.signal.aborted;
      const shouldRetry =
        !wasCanceled && job.attempts < job.maxAttempts && isTransientJobFailure(error);
      const updated = await repository.update(
        job.id,
        failedJob(job, error, wasCanceled, shouldRetry)
      );
      // A job that ended for good settles the work it owned (the runs a link job completes).
      if (!shouldRetry)
        try {
          await executor.ended?.(job, error, wasCanceled);
        } catch (settleError) {
          this.options.logger?.warn(normalizeWorkerError(settleError));
        }
      this.notify();
      return updated;
    } finally {
      this.controllers.delete(job.id);
      // A heavy lane held for relation jobs (drain mode) looks again as soon as one ends.
      if (worker === "relations" && this.heavyHeldForLinks) this.wakeLoops("heavy");
    }
  }

  /**
   * How the embedding stage embeds a batch of texts: the supervisor's batch generator, else its
   * single-text one called for each text in order; null without either.
   */
  private embeddingBatchGenerator(): EmbeddingBatchGenerator | null {
    const many = this.options.generateEmbeddings;
    if (many) return (texts, signal, context) => many(texts, signal, context);
    const single = this.options.generateEmbedding;
    if (!single) return null;
    return async (texts, signal, context) => {
      const { chunkIds, ...rest } = context;
      const embeddings: number[][] = [];
      let identity: { provider: string; model: string; runtime: string; spaceKey?: string } | null =
        null;
      for (const [index, text] of texts.entries()) {
        const chunkId = chunkIds?.[index];
        const generated = await single(text, signal, { ...rest, ...(chunkId ? { chunkId } : {}) });
        if (!generated) return null;
        if (identity?.spaceKey && generated.spaceKey !== identity.spaceKey)
          throw new Error("errors.sourceRelations.configurationChanged");
        embeddings.push(generated.embedding);
        identity = generated;
      }
      return identity ? { ...identity, embeddings } : null;
    };
  }

  /** Whether a job type has an executor here: a built-in one, a light one or a DEV heavy one. */
  public supportsJobType(type: string): boolean {
    return supportedJobTypes.has(type) || type in this.lightJobs || type in this.devHeavyJobs;
  }

  /** Runs a pass at once: every loop, or only the loops of one lane. */
  public wake(lane?: JobLane): void {
    this.wakeLoops(lane);
    this.notify();
  }

  public async queueRelationLabels(payload: {
    mode: "missing" | "all";
    contentLanguage: string;
  }): Promise<string> {
    const id = await createKnowledgeGraphRepository(this.requirePool()).queueRelationLabels(
      payload
    );
    this.wakeLoops("heavy");
    this.notify();
    return id;
  }

  public async relationLabelsStatus() {
    return createJobRepository(this.requirePool()).latestByType("relation-labels");
  }

  public async cancelBatch(batchId: string): Promise<null> {
    const pool = this.requirePool(),
      runs = createIngestionRunRepository(pool);
    for (const id of await createJobRepository(pool).activeIdsForBatch(batchId))
      await this.requestCancel(id);
    for (const run of await runs.listByBatch(batchId))
      if (["pending", "running"].includes(run.status)) await runs.cancel(run.id);
    await createHierarchicalIngestionRepository(pool).refreshBatch(batchId);
    this.notify();
    return null;
  }

  public async requestCancel(jobId: string): Promise<JobRecord | null> {
    const job = await createJobRepository(this.requirePool()).requestCancel(jobId);
    this.controllers.get(jobId)?.abort();
    this.notify();
    return job;
  }

  public async retry(jobId: string): Promise<JobRecord | null> {
    const pool = this.requirePool();
    const repository = createJobRepository(pool);
    const current = await repository.findById(jobId);
    if (!current) return null;
    const ingestionRunId = optionalString(current.payload.ingestionRunId);
    const ingestionRun = ingestionRunId
      ? await createIngestionRunRepository(pool).findById(ingestionRunId)
      : null;
    if (!canManuallyRetryJob(current, ingestionRun)) return null;
    // A finished run whose graph failed or whose matching waited for a ranker re-runs those
    // stages alone (the stage-level retry, D25).
    const reopen = ingestionRun ? manualRetryStages(ingestionRun) : null;
    if (ingestionRun && reopen)
      await createIngestionRunRepository(pool).reopenStages(ingestionRun.id, reopen);
    const job = await repository.retry(jobId);
    if (job) this.wakeLoops(job.lane);
    if (job) this.notify();
    return job;
  }

  /**
   * The stage-level retry (F3 D25): re-runs one skipped or failed stage of a finished run, and the
   * stages skipped with it (both matching stages after a wait for a validated ranker, C7), by
   * queueing the run's ingestion job again: its other stages keep their checkpoints. Null when the
   * stage cannot be retried that way or the run's job is still queued or running.
   */
  public async retryStage(runId: string, stage: string): Promise<JobRecord | null> {
    const pool = this.requirePool();
    const runs = createIngestionRunRepository(pool);
    const jobs = createJobRepository(pool);
    const run = await runs.findById(runId);
    if (!run?.jobId) return null;
    const stages = stageRetryStages(run, stage);
    if (!stages) return null;
    const current = await jobs.findById(run.jobId);
    if (!current || current.status === "queued" || current.status === "running") return null;
    if (!(await runs.reopenStages(run.id, stages))) return null;
    const job = await jobs.retry(run.jobId);
    if (job) this.wakeLoops("heavy");
    this.notify();
    return job;
  }

  public async deleteCanceledHierarchy(jobId: string) {
    const result = await createProcessingTaskRepository(this.requirePool()).deleteCanceledHierarchy(
      jobId
    );
    if (!result) return null;
    if (result.batchId && !result.deletedBatch) {
      await createHierarchicalIngestionRepository(this.requirePool()).refreshBatch(result.batchId);
    }
    this.notify();
    return { deletedJobs: result.deletedJobs, deletedRuns: result.deletedRuns };
  }

  public async list(limit = 100): Promise<JobRecord[]> {
    return createJobRepository(this.requirePool()).list(limit);
  }

  public async clearCompletedOrFailed(): Promise<number> {
    const deleted = await createJobRepository(this.requirePool()).clearCompletedOrFailed();
    if (deleted > 0) this.notify();
    return deleted;
  }

  public async cancelForSources(sourceItemIds: string[]): Promise<void> {
    if (sourceItemIds.length === 0) return;
    const pool = this.requirePool();
    const jobs = await pool.query<{ id: string }>(
      `select id from jobs
       where status in ('queued', 'running') and payload->>'sourceItemId' = any($1::text[])`,
      [sourceItemIds]
    );
    if (jobs.rows.length === 0) return;
    const repository = createJobRepository(pool);
    await Promise.all(
      jobs.rows.map(async ({ id }) => {
        await repository.requestCancel(id);
        this.controllers.get(id)?.abort();
      })
    );
    this.notify();
    await Promise.all(this.loops().map((loop) => loop.settled()));
    await Promise.allSettled(this.pendingProgressUpdates);
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async listWithRuns(limit = 100) {
    const pool = this.requirePool();
    const [jobs, runs, sources] = await Promise.all([
      createJobRepository(pool).list(limit),
      createIngestionRunRepository(pool).list(limit),
      createSourceItemRepository(pool).list(limit)
    ]);
    return jobs.map((job) => ({
      job,
      ingestionRun:
        runs.find((run) => run.jobId === job.id || run.id === job.payload.ingestionRunId) ?? null,
      source: sources.find((source) => source.id === job.payload.sourceItemId) ?? null
    }));
  }

  private createLoop(pass: () => Promise<boolean>, onIdle?: () => Promise<void>): JobLoop {
    return new JobLoop({
      pass,
      ...(onIdle ? { onIdle } : {}),
      pollIntervalMs: this.options.pollIntervalMs ?? 500,
      onError: (error) => this.options.logger?.error(normalizeWorkerError(error))
    });
  }

  private loops(): JobLoop[] {
    return [this.heavyLoop, ...this.lightLoops];
  }

  private wakeLoops(lane?: JobLane): void {
    const loops =
      lane === "heavy" ? [this.heavyLoop] : lane === "light" ? this.lightLoops : this.loops();
    for (const loop of loops) loop.wake();
  }

  /** What an idle heavy loop does: relation maintenance, then the idle runtime release. */
  private async idle(): Promise<void> {
    // Held for link jobs, the lane is not idle: its next job follows them, models stay loaded.
    if (this.heavyHeldForLinks) return;
    try {
      await this.relationMaintenance();
    } catch (error) {
      this.options.logger?.warn(normalizeWorkerError(error));
    }
    await this.releaseIdleRuntime();
  }

  /**
   * Relation work no job asks for, at most every 30 s: runs whose matching was skipped to wait for
   * a validated ranker (C7) re-run through the stage-level retry once a decider is ready, and the
   * day's untyped re-typing sweep is queued once (D20). Golden and re-match runs (drain mode)
   * queue no sweep: their work is the runs they drain.
   */
  private async relationMaintenance(): Promise<void> {
    const knowledge = this.options.knowledgeService;
    if (!this.linker || typeof knowledge?.noteDeciderAvailable !== "function") return;
    const now = Date.now();
    if (now - this.lastRelationMaintenance < relationMaintenanceIntervalMs) return;
    this.lastRelationMaintenance = now;
    const pool = this.requirePool();
    const waiting = await createIngestionRunRepository(pool).listSkippedMatching(
      waitingForDeciderSkipReason
    );
    if (waiting.length > 0 && (await knowledge.noteDeciderAvailable()))
      for (const run of waiting) await this.retryStage(run.id, "atomicNoteMatching");
    const day = localDay(new Date(now));
    if (!relationLinkRuntime().drain && this.retypeSweepDay !== day) {
      this.retypeSweepDay = day;
      if ((await hasUntypedRelations(pool)) && (await enqueueRelationRetypeSweep(pool)))
        this.wakeLoops("light");
    }
  }

  /** Local models are released only when no loop of either lane runs or has just run a job. */
  private async releaseIdleRuntime(): Promise<void> {
    if (this.loops().some((loop) => loop.busy)) return;
    await this.options.releaseAiRuntime?.();
  }

  /**
   * Rebuilds the vector of one note a human edited. It only calls the embedding model, never a
   * generative one; a provider failure is retried like any other job.
   */
  private async executeNoteEmbedding(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const atomicNoteId = readString(job.payload, "atomicNoteId");
    const sourceItemId = optionalString(job.payload.sourceItemId);
    // A re-embedding after an embedding-space change names the space it embeds into (D26).
    const spaceKey = optionalString(job.payload.spaceKey);
    const knowledge = this.options.knowledgeService;
    if (!knowledge) return { embedded: false, reason: "knowledge_unavailable" };
    const context = {
      jobId: job.id,
      stage: "note_embedding",
      ...(sourceItemId ? { sourceItemId } : {})
    };
    const result = spaceKey
      ? await knowledge.embedAtomicNote(atomicNoteId, signal, context, { spaceKey })
      : await knowledge.embedAtomicNote(atomicNoteId, signal, context);
    // The new vector, or a note that is gone or no longer current, changes its place in the tree.
    // An unchanged vector was embedded (and handed to the tree) by matching already.
    if (
      result.embedded ||
      result.reason === "note_not_found" ||
      result.reason === "note_not_current"
    )
      await this.options.topicHooks?.notesChanged([atomicNoteId]);
    return { ...result };
  }

  /**
   * A re-embedding job of a space change (D26) ended for good, with or without a vector: the topic
   * build looks at the new space's coverage again, so a last job that failed cannot leave it
   * waiting. Called once the job's row says so.
   */
  private async reembeddingEnded(job: JobRecord): Promise<void> {
    if (job.type !== "note-embedding" || !optionalString(job.payload.spaceKey)) return;
    await this.options.topicHooks?.reembeddingEnded?.();
  }

  /** Chunk replacement hands the topic tree its repair in the replacing transaction (T15b). */
  private chunkReplacementOptions(): ReplaceDocumentChunksOptions | undefined {
    const hooks = this.options.topicHooks;
    return hooks ? { afterReplace: (client) => hooks.itemsRemoved({ client }) } : undefined;
  }

  private async executeIngestion(
    job: JobRecord,
    controller: AbortController
  ): Promise<Record<string, unknown>> {
    const signal = controller.signal;
    const ingestionRunId = readString(job.payload, "ingestionRunId");
    const documentId = readString(job.payload, "documentId");
    const sourceItemId = readString(job.payload, "sourceItemId");
    const catalogMetadataOnly = job.payload.processingMode === "catalog_metadata";
    let markdown = optionalString(job.payload.markdown) ?? "";
    // A document without text (an import that converted to nothing) has nothing to chunk or derive.
    if (!catalogMetadataOnly && !markdown.trim()) throw new Error(emptyDocumentError);
    const pool = this.requirePool();
    const inputDocument = await createDocumentRepository(pool).findById(documentId);
    if (inputDocument?.metadata.supersededByDocumentId)
      throw new Error("errors.common.validationFailed");
    if (catalogMetadataOnly) {
      const source = await createSourceItemRepository(pool).findById(sourceItemId);
      if (source) markdown = buildCatalogMetadataMarkdown(source);
    }
    const runs = createIngestionRunRepository(pool);
    if (catalogMetadataOnly) {
      await runs.update(ingestionRunId, {
        inputHashes: {
          contentHash: createHash("sha256").update(markdown).digest("hex"),
          promptFingerprints: stagePromptFingerprints(
            capturePromptPin(),
            false,
            await promptStageProviders(pool)
          )
        }
      });
    }
    const run = (await runs.startOrResume(ingestionRunId)) ?? (await runs.findById(ingestionRunId));
    if (!run) throw new Error("ingestion_run_not_found");
    const effectiveStages = new Set(
      run.effectiveStages.filter((stage): stage is string => typeof stage === "string")
    );
    const legacyRun = effectiveStages.size === 0;
    const shouldRun = (stage: string) => legacyRun || effectiveStages.has(stage);
    const checkpoint = run.stagesCheckpoint.chunking as JsonObject | undefined;
    let persistedChunks;
    if (shouldRun("chunking") && checkpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "chunking");
      this.notify();
      const chunkRepository = createChunkRepository(pool);
      // Replacing the chunks deletes the old notes by cascade, and their placements with them
      // (D32): the repair jobs are enqueued in the replacing transaction.
      const replacement = this.chunkReplacementOptions();
      persistedChunks = catalogMetadataOnly
        ? await persistCatalogMetadataChunk(
            chunkRepository,
            documentId,
            sourceItemId,
            markdown,
            replacement
          )
        : await chunkRepository.replaceDocumentChunks(
            documentId,
            sourceItemId,
            await this.createContentChunks(job, markdown, signal),
            replacement
          );
      await runs.completeStage(ingestionRunId, "chunking", { chunkCount: persistedChunks.length });
      this.notify();
    } else {
      persistedChunks = await createChunkRepository(pool).listByDocument(documentId);
    }
    await createJobRepository(pool).reportProgress(job.id, 0.5);
    throwIfAborted(signal);
    const summaryCheckpoint = run.stagesCheckpoint.summarization as JsonObject | undefined;
    const aggregateHierarchyRoot =
      shouldRun("summarization") && this.options.knowledgeService
        ? await this.options.knowledgeService.isHierarchicalRoot(sourceItemId)
        : false;
    if (shouldRun("summarization") && summaryCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "summarization");
      this.notify();
      const summary = aggregateHierarchyRoot
        ? { configured: true, generated: false, aggregate: true }
        : this.options.knowledgeService
          ? await this.runInlineStageJob(
              "summarization",
              { ingestionRunId, sourceItemId, documentId },
              (stageJobId) =>
                this.options.knowledgeService!.summarizeSource(
                  sourceItemId,
                  documentId,
                  signal,
                  (progress) => this.reportInlineProgress(stageJobId, progress),
                  {
                    jobId: stageJobId,
                    ingestionRunId,
                    sourceItemId,
                    documentId,
                    stage: "summarization"
                  }
                ),
              controller
            )
          : { configured: false, generated: false };
      await runs.completeStage(ingestionRunId, "summarization", summary);
      this.notify();
    }
    const batchSummariesComplete =
      !run.batchId ||
      !shouldRun("summarization") ||
      (await runs.countIncompleteBatchStage(run.batchId, "summarization")) === 0;
    if (aggregateHierarchyRoot && this.options.knowledgeService && batchSummariesComplete) {
      const summarized = await this.options.knowledgeService.summarizeHierarchiesForBatch(
        run.batchId,
        signal,
        {
          jobId: job.id,
          ingestionRunId,
          sourceItemId,
          documentId,
          stage: "aggregateSummarization"
        },
        sourceItemId,
        run.runKind === "reingestion"
      );
      await this.followSummaries(summarized?.changedRootIds);
    } else if (
      !aggregateHierarchyRoot &&
      shouldRun("summarization") &&
      run.batchId &&
      batchSummariesComplete
    ) {
      const summarized = await this.options.knowledgeService?.summarizeHierarchiesForBatch(
        run.batchId,
        signal,
        {
          jobId: job.id,
          ingestionRunId,
          sourceItemId,
          documentId,
          stage: "aggregateSummarization"
        }
      );
      // A root whose header was built before its summary: the header follows it (T53h).
      await this.followSummaries(summarized?.changedRootIds);
    }
    const embeddingCheckpoint = run.stagesCheckpoint.embedding as JsonObject | undefined;
    if (shouldRun("embedding") && embeddingCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "embedding");
      this.notify();
      let embeddedCount = 0;
      let reusedCount = 0;
      let sourceEmbedded = false;
      const generate = this.embeddingBatchGenerator();
      if (generate) {
        const embeddings = createEmbeddingRepository(pool);
        const stage = {
          pool,
          signal,
          generate,
          ...(this.options.embeddingSpaceKey
            ? { routeSpaceKey: this.options.embeddingSpaceKey }
            : {}),
          validate: async (embedding: number[]) => {
            const validated = await this.workers.execute("embedding", { embedding }, { signal });
            return Array.isArray(validated.embedding) ? validated.embedding.map(Number) : [];
          },
          context: { jobId: job.id, ingestionRunId, sourceItemId, documentId }
        };
        const chunkSet = await embedChunkVectors({
          ...stage,
          chunks: persistedChunks,
          render: (content) => renderPrompt("embedding.content.chunk", { source_text: content })
        });
        const chunkVectors = chunkSet.vectors;
        let embeddingIdentity = chunkSet.identity;
        // The count of chunks that have a vector; the ones kept from an earlier run are counted apart.
        embeddedCount = chunkVectors.length;
        reusedCount = chunkSet.reused;

        const source = await createSourceItemRepository(pool).findById(sourceItemId);
        if (source) {
          const header = buildCatalogMetadataMarkdown(source);
          // A hierarchy root embeds its header only to build its composite (F3 D27): while a
          // descendant has none the last one to embed builds it, and one that did left it current.
          const chunkDimensions = chunkVectors[0]?.length;
          const hierarchyComposite =
            embeddingIdentity?.spaceKey &&
            (chunkDimensions === 256 || chunkDimensions === 768 || chunkDimensions === 1_024)
              ? await hierarchyRootComposite({
                  pool,
                  sourceItemId,
                  header,
                  space: {
                    model: embeddingIdentity.model,
                    dimensions: chunkDimensions,
                    strategy: `source-composite-centroid-v2:${embeddingIdentity.spaceKey}`
                  }
                })
              : "none";
          const embedsHeader = hierarchyComposite === "none" || hierarchyComposite === "stale";
          if (hierarchyComposite === "current") sourceEmbedded = true;
          const headerEmbedded = await embedHeaderVectors({
            ...stage,
            segments: embedsHeader ? chunkMarkdown(header).map((chunk) => chunk.content) : [],
            identity: embeddingIdentity
          });
          const headerVectors = headerEmbedded.vectors;
          embeddingIdentity = headerEmbedded.identity;
          const descendants =
            await createHierarchicalIngestionRepository(pool).listDescendants(sourceItemId);
          let contentVectors = chunkVectors;
          let hierarchyContentComplete = true;
          if (descendants.length > 0 && embeddingIdentity) {
            const dimensions = chunkVectors[0]?.length ?? headerVectors[0]?.length;
            if (dimensions === 256 || dimensions === 768 || dimensions === 1_024) {
              const childVectors = await embeddings.listSourceEmbeddings(
                descendants.map((descendant) => descendant.id),
                embeddingIdentity.model,
                dimensions,
                embeddingIdentity.spaceKey
                  ? `source-composite-centroid-v2:${embeddingIdentity.spaceKey}`
                  : undefined
              );
              hierarchyContentComplete = childVectors.length === descendants.length;
              contentVectors = childVectors.map((item) => item.embedding);
            }
          }
          const sourceEmbedding =
            hierarchyContentComplete && embedsHeader
              ? aggregateSourceEmbedding(headerVectors, contentVectors)
              : null;
          if (sourceEmbedding && embeddingIdentity) {
            const sourceFingerprint = createHash("sha256").update(header);
            for (const vector of contentVectors) sourceFingerprint.update(vector.join(","));
            const sourceContentHash = sourceFingerprint.digest("hex");
            await embeddings.upsert({
              targetType: "source_item",
              targetId: sourceItemId,
              provider: embeddingIdentity.provider,
              model: embeddingIdentity.model,
              runtime: embeddingIdentity.runtime,
              strategy: embeddingIdentity.spaceKey
                ? `source-composite-centroid-v2:${embeddingIdentity.spaceKey}`
                : "source-composite-centroid-v1",
              contentHash: sourceContentHash,
              embedding: sourceEmbedding
            });
            sourceEmbedded = true;
            await this.options.topicHooks?.sourcesChanged([sourceItemId]);
          }
        }
      }
      // A chapter's composite completes its hierarchy roots' composites (F3 D27 discovery); a failed
      // refresh is reported and never fails this stage, whose own vectors are written.
      const recomposed = await refreshAncestorComposites({
        pool,
        sourceItemId,
        aggregate: aggregateSourceEmbedding,
        // Through the stage's own generator (batched when wired, F3 D37), so an ancestor's header is
        // the same request whichever job builds its composite.
        embed: generate
          ? async (text) => {
              const generated = await generate([text], signal, {
                jobId: job.id,
                ingestionRunId,
                sourceItemId,
                documentId,
                stage: "source_embedding",
                embeddingInputType: "document"
              });
              const embedding = generated?.embeddings[0];
              if (!generated || !embedding) return null;
              return {
                embedding,
                provider: generated.provider,
                model: generated.model,
                runtime: generated.runtime,
                ...(generated.spaceKey ? { spaceKey: generated.spaceKey } : {})
              };
            }
          : null,
        signal,
        warn: (error) => this.options.logger?.warn(normalizeWorkerError(error))
      });
      if (recomposed.length) await this.options.topicHooks?.sourcesChanged(recomposed);
      await runs.completeStage(ingestionRunId, "embedding", {
        embeddedCount,
        reusedCount,
        sourceEmbedded,
        configured: Boolean(this.options.generateEmbedding ?? this.options.generateEmbeddings)
      });
      this.notify();
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.68);
    const atomicCheckpoint = run.stagesCheckpoint.atomicNotes as JsonObject | undefined;
    let noteIds = readStringArray((atomicCheckpoint?.metadata as JsonObject | undefined)?.noteIds);
    if (noteIds.length === 0 && atomicCheckpoint?.status === "completed") {
      noteIds = (await createAtomicNoteRepository(pool).listBySourceItem(sourceItemId))
        .filter((note) => note.status !== "rejected")
        .map((note) => note.id);
    }
    if (shouldRun("atomicNotes") && atomicCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "atomicNotes");
      this.notify();
      const generated = this.options.knowledgeService
        ? await this.runInlineStageJob(
            "atomic-note-generation",
            { ingestionRunId, sourceItemId, documentId },
            (jobId) =>
              this.options.knowledgeService!.generateAtomicNotes(
                sourceItemId,
                documentId,
                {
                  jobId,
                  ingestionRunId,
                  onProgress: (progress) => this.reportInlineProgress(jobId, progress)
                },
                signal
              ),
            controller
          )
        : { configured: false, generatedCount: 0, noteIds: [] };
      noteIds = readStringArray(generated.noteIds);
      await runs.completeStage(ingestionRunId, "atomicNotes", generated);
      this.notify();
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.84);
    const graphCheckpoint = run.stagesCheckpoint.knowledgeGraph as JsonObject | undefined;
    if (shouldRun("knowledgeGraph") && graphCheckpoint?.status !== "completed") {
      const graphMetadata = graphCheckpoint?.metadata as JsonObject | undefined;
      await runs.beginStage(ingestionRunId, "knowledgeGraph");
      this.notify();
      let graph: Record<string, unknown> | null = null;
      try {
        graph = this.options.knowledgeService
          ? await this.runInlineStageJob(
              "knowledge-graph-generation",
              { ingestionRunId, sourceItemId, documentId },
              (stageJobId) =>
                catalogMetadataOnly
                  ? this.options.knowledgeService!.generateCatalogKnowledgeGraph(
                      sourceItemId,
                      documentId,
                      {
                        jobId: stageJobId,
                        ingestionRunId,
                        onProgress: (progress) => this.reportInlineProgress(stageJobId, progress)
                      },
                      signal
                    )
                  : this.options.knowledgeService!.generateKnowledgeGraph(
                      sourceItemId,
                      documentId,
                      {
                        jobId: stageJobId,
                        ingestionRunId,
                        // One graph pass over the chunks per source; a second pass over the notes
                        // only when the processing plan asks for it.
                        includeAtomicNotesGraph:
                          shouldRun("atomicNotes") && job.payload.knowledgeGraphOnNotes === true,
                        completedBatches: graphMetadata?.completedBatches,
                        onProgress: (progress) => this.reportInlineProgress(stageJobId, progress),
                        onBatchCompleted: async ({ completed, total, checkpoints }) => {
                          const progress = total > 0 ? completed / total : 1;
                          await Promise.all([
                            createJobRepository(pool).reportProgress(stageJobId, progress),
                            createJobRepository(pool).reportProgress(
                              job.id,
                              0.84 + progress * 0.05
                            ),
                            runs.updateStageProgress(ingestionRunId, "knowledgeGraph", progress, {
                              completed,
                              total,
                              completedBatches: checkpoints
                            })
                          ]);
                        }
                      },
                      signal
                    ),
              controller
            )
          : { configured: false, generated: false, projected: false };
      } catch (error) {
        // A graph that failed for good ends this stage only (D25, R25). Cancellation and a failure
        // the job's own retry can still mend (a provider outage, a first local deadline) take the
        // job's path, so the graph comes back before matching runs.
        if (signal.aborted || (job.attempts < job.maxAttempts && isTransientJobFailure(error)))
          throw error;
        // Matching runs with the graph signal absent; the stage stays failed and retryable, and
        // the run ends `succeeded` with its graph incomplete.
        await runs.failStage(ingestionRunId, "knowledgeGraph", normalizeWorkerError(error));
        this.options.logger?.warn(normalizeWorkerError(error));
      }
      if (graph) await runs.completeStage(ingestionRunId, "knowledgeGraph", graph);
      this.notify();
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.89);
    const batchId = run.batchId ?? optionalString(job.payload.batchId);
    // Note matching decides this run's own notes as soon as they exist: no batch barrier, so a
    // failing sibling never delays it (F3 D24). An interactive import decides and links at P1.
    const priority = isInteractiveRun(run) || job.payload.interactive === true ? "P1" : "P2";
    const noteMatching = run.stagesCheckpoint.atomicNoteMatching as JsonObject | undefined;
    let waitingForDecider = isWaitingForDecider(noteMatching);
    if (shouldRun("atomicNoteMatching") && !isSettledStage(noteMatching)) {
      await runs.beginStage(ingestionRunId, "atomicNoteMatching");
      this.notify();
      const matchNoteIds = (await createAtomicNoteRepository(pool).listBySourceItem(sourceItemId))
        .filter((note) => note.status !== "rejected")
        .map((note) => note.id);
      const matchContext = { ingestionRunId, sourceItemId, documentId };
      const matched: Record<string, unknown> =
        this.options.knowledgeService && matchNoteIds.length > 0
          ? await this.runInlineStageJob(
              "atomic-note-matching",
              { ...matchContext, noteIds: matchNoteIds },
              (stageJobId) =>
                matchAtomicNotesFromCheckpoint({
                  noteIds: matchNoteIds,
                  checkpoint: readAtomicNoteMatchingCheckpoint(noteMatching),
                  save: async (progress, metadata) => {
                    await createJobRepository(pool).reportProgress(stageJobId, progress);
                    await runs.updateStageProgress(
                      ingestionRunId,
                      "atomicNoteMatching",
                      progress,
                      metadata
                    );
                    this.notify();
                  },
                  // A progress tick inside a note never rewrites the stage checkpoint.
                  reportProgress: async (progress) => {
                    await createJobRepository(pool).reportProgress(stageJobId, progress);
                    this.notify();
                  },
                  // Decided pairs stay in the checkpoint until the link job persists them (D21).
                  match: (noteIds, onProgress, onNoteCompleted, onNoteDecided) =>
                    this.options.knowledgeService!.matchAtomicNotes(
                      noteIds,
                      signal,
                      onProgress,
                      {
                        ...matchContext,
                        jobId: stageJobId,
                        stage: "atomic_note_matching",
                        priority
                      },
                      { onNoteCompleted, onNoteDecided }
                    )
                }),
              controller
            )
          : { persistedCount: 0, completed: 0, total: 0, decided: [] };
      if (matched.skipped === waitingForDeciderSkipReason) {
        // Mode `ranker` without a validated ranker (C7): no call was made; the matching stages
        // are skipped, the run completes, and a ranker validation re-runs them (D25).
        await runs.skipStage(ingestionRunId, "atomicNoteMatching", waitingForDeciderSkipReason);
        waitingForDecider = true;
      } else await runs.completeStage(ingestionRunId, "atomicNoteMatching", matched as JsonObject);
      this.notify();
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.95);
    const sourceMatching = run.stagesCheckpoint.sourceMatching as JsonObject | undefined;
    let linkRoot: string | null = null;
    // Only the link job persists what note matching decided (D21), so a plan with note matching
    // and no source stage parks for it too; that link job skips discovery.
    const linksNotes = shouldRun("atomicNoteMatching") && !waitingForDecider && !!this.linker;
    if ((shouldRun("sourceMatching") || linksNotes) && !isSettledStage(sourceMatching)) {
      if (waitingForDecider) {
        await runs.skipStage(ingestionRunId, "sourceMatching", waitingForDeciderSkipReason);
      } else if (!this.linker) {
        await runs.completeStage(ingestionRunId, "sourceMatching", { configured: false });
      } else {
        // The link job of the source's root types, persists and discovers (3.11); the run parks
        // its source stage for it once this job's last stage has run, below.
        linkRoot = await linkRootOf(pool, sourceItemId);
      }
      this.notify();
    }
    const projectionCheckpoint = run.stagesCheckpoint.obsidianProjection as JsonObject | undefined;
    if (shouldRun("obsidianProjection") && projectionCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "obsidianProjection");
      this.notify();
      const projection = this.options.obsidianSyncService
        ? await this.runInlineStageJob(
            "obsidian-sync",
            { ingestionRunId, sourceItemId, documentId },
            () => this.options.obsidianSyncService!.projectSource(sourceItemId)
          )
        : { projected: 0 };
      await runs.completeStage(ingestionRunId, "obsidianProjection", projection);
      this.notify();
    }
    await createJobRepository(pool).reportProgress(job.id, 0.98);
    if (linkRoot) {
      // Parked last, so the link job never races this job's own writes: the run stays running and
      // completes when its link job does (D24).
      await runs.parkForLinking(ingestionRunId, { rootId: linkRoot });
      await enqueueRelationLink(pool, {
        rootId: linkRoot,
        batchId: batchId ?? null,
        interactive: priority === "P1"
      });
      this.wakeLoops("light");
    } else await runs.complete(ingestionRunId);
    // A summary written while this catalog run was working is followed once it has ended (T53h).
    if (catalogMetadataOnly) await this.followSummaries([sourceItemId]);
    this.notify();
    return {
      ingestionRunId,
      documentId,
      sourceItemId,
      ...(linkRoot ? { linking: linkRoot } : {})
    };
  }

  private async createContentChunks(job: JobRecord, markdown: string, signal: AbortSignal) {
    const chunkResult = await this.workers.execute(
      "chunking",
      {
        markdown,
        blocks: Array.isArray(job.payload.blocks) ? job.payload.blocks : []
      },
      {
        signal,
        onProgress: (progress) =>
          this.trackProgress(
            createJobRepository(this.requirePool()).reportProgress(job.id, 0.05 + progress * 0.3)
          )
      }
    );
    return (Array.isArray(chunkResult.chunks) ? chunkResult.chunks : []).map((raw) =>
      parseWorkerChunk(raw)
    );
  }

  private async runInlineStageJob(
    type: string,
    payload: JsonObject,
    run: (jobId: string) => Promise<Record<string, unknown>>,
    controller?: AbortController
  ): Promise<Record<string, unknown>> {
    const repository = createJobRepository(this.requirePool());
    payload = { ...payload, promptPin: capturePromptPin() };
    const job = await repository.create({ type, payload, maxAttempts: 1 });
    await repository.update(job.id, {
      status: "running",
      attempts: 1,
      lockedAt: new Date(),
      lockedBy: this.workerId
    });
    this.notify();
    if (controller) this.controllers.set(job.id, controller);
    try {
      const result = await (this.options.traceOperation?.(
        type,
        {
          jobId: job.id,
          ingestionRunId: payload.ingestionRunId,
          sourceItemId: payload.sourceItemId,
          documentId: payload.documentId,
          origin: "ingestion"
        },
        () => run(job.id)
      ) ?? run(job.id));
      await repository.update(job.id, {
        status: "succeeded",
        progress: 1,
        result,
        error: null,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date()
      });
      this.notify();
      return result;
    } catch (error) {
      logStructuredError(
        this.options.logger,
        "job_failed",
        {
          jobId: job.id,
          jobType: type,
          ingestionRunId: optionalString(payload.ingestionRunId),
          sourceItemId: optionalString(payload.sourceItemId),
          documentId: optionalString(payload.documentId),
          stage: type
        },
        error,
        "job_failed"
      );
      const canceled = controller?.signal.aborted ?? false;
      const normalizedError = normalizeWorkerError(error);
      await repository.update(job.id, {
        status: canceled ? "canceled" : "failed",
        error: canceled ? null : normalizedError,
        payload: canceled
          ? payload
          : appendErrorHistory(payload, {
              message: normalizedError,
              stage: type,
              attempt: 1,
              occurredAt: new Date().toISOString()
            }),
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date()
      });
      this.notify();
      throw error;
    } finally {
      if (controller) this.controllers.delete(job.id);
    }
  }

  private trackProgress(promise: Promise<unknown>): void {
    this.pendingProgressUpdates.add(promise);
    void promise
      .catch((error: unknown) => this.options.logger?.warn(normalizeWorkerError(error)))
      .finally(() => {
        this.pendingProgressUpdates.delete(promise);
        this.notify();
      });
  }

  private reportInlineProgress(jobId: string, progress: number): void {
    this.trackProgress(createJobRepository(this.requirePool()).reportProgress(jobId, progress));
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

function readString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_${key}`);
  return value;
}

function parseWorkerChunk(raw: unknown) {
  if (typeof raw !== "object" || raw === null) throw new Error("invalid_worker_chunk");
  const value = raw as Record<string, unknown>;
  const boundingBox =
    typeof value.boundingBox === "object" && value.boundingBox !== null
      ? (value.boundingBox as JsonObject)
      : null;
  return {
    id: readString(value, "id"),
    sourceSpanId: readString(value, "sourceSpanId"),
    chunkIndex: Number(value.chunkIndex),
    content: readString(value, "content"),
    tokenCount: Number(value.tokenCount),
    contentHash: readString(value, "contentHash"),
    span: {
      id: readString(value, "sourceSpanId"),
      startOffset: Number(value.startOffset),
      endOffset: Number(value.endOffset),
      ...(typeof value.page === "number" ? { page: value.page } : {}),
      ...(typeof value.sourceBlockId === "string" ? { sourceBlockId: value.sourceBlockId } : {}),
      ...(boundingBox ? { boundingBox } : {}),
      ...(typeof value.selector === "string" ? { selector: value.selector } : {})
    }
  };
}

export async function persistCatalogMetadataChunk(
  repository: Pick<
    ReturnType<typeof createChunkRepository>,
    "listByDocument" | "replaceDocumentChunks"
  >,
  documentId: string,
  sourceItemId: string,
  content: string,
  replacement?: ReplaceDocumentChunksOptions
) {
  const chunk = createCatalogMetadataChunk(content);
  const existing = await repository.listByDocument(documentId);
  // Replacing identical catalog chunks cascades to graph evidence even when only embedding was requested.
  if (
    existing.length === 1 &&
    existing[0]!.sourceItemId === sourceItemId &&
    existing[0]!.content === content &&
    existing[0]!.contentHash === chunk.contentHash &&
    existing[0]!.chunkingVersion === chunk.chunkingVersion &&
    existing[0]!.metadata.processingMode === "catalog_metadata"
  )
    return existing;
  return replacement
    ? repository.replaceDocumentChunks(documentId, sourceItemId, [chunk], replacement)
    : repository.replaceDocumentChunks(documentId, sourceItemId, [chunk]);
}

export function createCatalogMetadataChunk(content: string) {
  const id = randomUUID();
  const sourceSpanId = randomUUID();
  return {
    id,
    sourceSpanId,
    chunkIndex: 0,
    content,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    contentHash: createHash("sha256").update(content).digest("hex"),
    chunkingVersion: "catalog-metadata-v1",
    metadata: { processingMode: "catalog_metadata" },
    span: {
      id: sourceSpanId,
      startOffset: 0,
      endOffset: content.length,
      selector: "catalog-metadata",
      label: "catalog-metadata",
      metadata: { processingMode: "catalog_metadata" }
    }
  };
}

export function aggregateSourceEmbedding(
  headerVectors: number[][],
  contentVectors: number[][]
): number[] | null {
  const dimensions = headerVectors[0]?.length ?? contentVectors[0]?.length;
  if (!dimensions) return null;
  const compatibleHeaders = headerVectors.filter((vector) => vector.length === dimensions);
  const compatibleContent = contentVectors.filter((vector) => vector.length === dimensions);
  const header = meanVector(compatibleHeaders);
  const content = meanVector(compatibleContent);
  if (!header && !content) return null;
  const combined = Array.from(
    { length: dimensions },
    (_, index) =>
      (header?.[index] ?? 0) * (content ? 0.35 : 1) + (content?.[index] ?? 0) * (header ? 0.65 : 1)
  );
  const magnitude = Math.sqrt(combined.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? combined.map((value) => value / magnitude) : combined;
}

function meanVector(vectors: number[][]): number[] | null {
  const dimensions = vectors[0]?.length;
  if (!dimensions) return null;
  return Array.from(
    { length: dimensions },
    (_, index) => vectors.reduce((sum, vector) => sum + (vector[index] ?? 0), 0) / vectors.length
  );
}

export function participatesInAtomicNoteMatching(effectiveStages: readonly unknown[]): boolean {
  return effectiveStages.includes("atomicNoteMatching");
}

/** A stage checkpoint that needs no more work: completed, or skipped (not requested, or waiting). */
function isSettledStage(checkpoint: JsonObject | undefined): boolean {
  return checkpoint?.status === "completed" || checkpoint?.status === "skipped";
}

function normalizeWorkerError(error: unknown): string {
  if (!(error instanceof Error)) return "worker_failed";
  return error.message;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A light job that did one step of a longer task returns the payload of its next step as
 * `continueWith`: the same job is queued again with it, due at once, behind the work already
 * waiting, with its attempts counted afresh. Its own step's result is kept. Paged work (the vault
 * projection, D30) so stays one job that a crash re-runs from its last step.
 */
export const lightJobContinuation = "continueWith";

/** The update after a light job's step: queued again with its next payload, or finished. */
export function lightJobUpdate(
  job: JobRecord,
  result: JsonObject,
  signal: AbortSignal = new AbortController().signal
): UpdateJobInput {
  const { [lightJobContinuation]: next, ...stepResult } = result;
  if (!next || typeof next !== "object" || Array.isArray(next) || signal.aborted)
    return finishedJob(job, stepResult, signal);
  return {
    status: "queued",
    payload: {
      ...(next as JsonObject),
      ...(job.payload.promptPin ? { promptPin: job.payload.promptPin } : {})
    },
    result: stepResult,
    error: null,
    attempts: 0,
    runAfter: new Date(),
    lockedAt: null,
    lockedBy: null,
    finishedAt: null
  };
}

/** The update that ends a job whose work returned, or that was canceled while it ran. */
function finishedJob(job: JobRecord, result: JsonObject, signal: AbortSignal): UpdateJobInput {
  return {
    status: signal.aborted ? "canceled" : "succeeded",
    progress: signal.aborted ? job.progress : 1,
    result,
    error: null,
    lockedAt: null,
    lockedBy: null,
    finishedAt: new Date()
  };
}

/** The update after a failure: canceled, queued again after a growing backoff, or failed. */
function failedJob(
  job: JobRecord,
  error: unknown,
  wasCanceled: boolean,
  shouldRetry: boolean
): UpdateJobInput {
  const normalizedError = normalizeWorkerError(error);
  return {
    status: wasCanceled ? "canceled" : shouldRetry ? "queued" : "failed",
    error: wasCanceled ? null : normalizedError,
    payload: wasCanceled
      ? job.payload
      : appendErrorHistory(job.payload, {
          message: normalizedError,
          stage: job.type,
          attempt: job.attempts,
          occurredAt: new Date().toISOString()
        }),
    runAfter: shouldRetry
      ? new Date(
          Date.now() +
            Math.max(Math.min(30_000, 1_000 * 2 ** job.attempts), aiErrorRetryAfterMs(error) ?? 0)
        )
      : job.runAfter,
    lockedAt: null,
    lockedBy: null,
    finishedAt: shouldRetry ? null : new Date()
  };
}

function appendErrorHistory(
  payload: JsonObject,
  event: { message: string; stage: string; attempt: number; occurredAt: string }
): JsonObject {
  const existing = Array.isArray(payload.errorHistory) ? payload.errorHistory : [];
  return { ...payload, errorHistory: [...existing, event].slice(-20) };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Ingestion canceled.", "AbortError");
}
