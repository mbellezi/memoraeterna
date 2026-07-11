import { hostname } from "node:os";

import {
  createChunkRepository,
  createEmbeddingRepository,
  createIngestionRunRepository,
  createJobRepository,
  createSourceItemRepository,
  type JobRecord,
  type JsonObject,
  type PgPool
} from "@app/db";

import { WorkerSupervisor } from "./worker-supervisor.js";
import type { KnowledgeService } from "./knowledge-service.js";
import type { ObsidianSyncService } from "./obsidian-sync-service.js";
import { logStructuredError } from "./structured-logging.js";
import { canManuallyRetryJob } from "./job-retry.js";
import type { WorkerTask } from "../workers/worker-contracts.js";

export interface JobSupervisorOptions {
  getPool: () => PgPool | null;
  pollIntervalMs?: number;
  logger?: Pick<Console, "error" | "warn">;
  generateEmbedding?: (text: string, signal?: AbortSignal) => Promise<{
    embedding: number[];
    provider: string;
    model: string;
    runtime: string;
  } | null>;
  knowledgeService?: KnowledgeService;
  obsidianSyncService?: Pick<ObsidianSyncService, "projectSource">;
  releaseAiRuntime?: () => Promise<void>;
}

const supportedJobTypes = new Set<WorkerTask["type"]>([
  "ingestion", "markdown-conversion", "chunking", "embedding",
  "atomic-note-generation", "obsidian-sync", "asset-storage"
]);

export class JobSupervisor {
  private readonly workers = new WorkerSupervisor();
  private readonly controllers = new Map<string, AbortController>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopping = false;
  private drainPromise: Promise<void> | null = null;
  private readonly pendingProgressUpdates = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private readonly workerId = `${hostname()}:${process.pid}`;

  public constructor(private readonly options: JobSupervisorOptions) {}

  public async start(): Promise<void> {
    if (this.running) return;
    const pool = this.requirePool();
    await createJobRepository(pool).recoverInterrupted();
    await createIngestionRunRepository(pool).recoverInterrupted();
    this.running = true;
    this.stopping = false;
    this.schedule(0);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers.values()) controller.abort();
    await this.workers.shutdown();
    await this.drainPromise;
    await Promise.allSettled(this.pendingProgressUpdates);
    this.controllers.clear();
  }

  public async runOnce(): Promise<JobRecord | null> {
    const repository = createJobRepository(this.requirePool());
    const job = await repository.claimNext(this.workerId, [...supportedJobTypes]);
    if (!job) return null;
    this.notify();
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      if (!supportedJobTypes.has(job.type as WorkerTask["type"])) throw new Error("unsupported_job_type");
      const result = job.type === "ingestion"
        ? await this.executeIngestion(job, controller)
        : await this.workers.execute(job.type as WorkerTask["type"], job.payload, {
            signal: controller.signal,
            onProgress: (progress) => this.trackProgress(repository.reportProgress(job.id, progress))
          });
      const updated = await repository.update(job.id, {
        status: controller.signal.aborted ? "canceled" : "succeeded",
        progress: controller.signal.aborted ? job.progress : 1,
        result,
        error: null,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date()
      });
      this.notify();
      return updated;
    } catch (error) {
      const wasCanceled = controller.signal.aborted;
      const shouldRetry = !wasCanceled && job.attempts < job.maxAttempts;
      if (job.type === "ingestion" && typeof job.payload.ingestionRunId === "string") {
        const runs = createIngestionRunRepository(this.requirePool());
        if (wasCanceled) {
          await runs.cancel(job.payload.ingestionRunId);
        } else {
          await runs.fail(job.payload.ingestionRunId, normalizeWorkerError(error));
        }
      }
      const normalizedError = normalizeWorkerError(error);
      const updated = await repository.update(job.id, {
        status: wasCanceled ? "canceled" : shouldRetry ? "queued" : "failed",
        error: wasCanceled ? null : normalizedError,
        payload: wasCanceled ? job.payload : appendErrorHistory(job.payload, {
          message: normalizedError,
          stage: job.type,
          attempt: job.attempts,
          occurredAt: new Date().toISOString()
        }),
        runAfter: shouldRetry ? new Date(Date.now() + Math.min(30_000, 1_000 * 2 ** job.attempts)) : job.runAfter,
        lockedAt: null,
        lockedBy: null,
        finishedAt: shouldRetry ? null : new Date()
      });
      this.notify();
      return updated;
    } finally {
      this.controllers.delete(job.id);
    }
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
    const job = await repository.retry(jobId);
    if (job) this.schedule(0);
    if (job) this.notify();
    return job;
  }

  public async list(limit = 100): Promise<JobRecord[]> {
    return createJobRepository(this.requirePool()).list(limit);
  }

  public async clearCompletedOrFailed(): Promise<number> {
    const deleted = await createJobRepository(this.requirePool()).clearCompletedOrFailed();
    if (deleted > 0) this.notify();
    return deleted;
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
      ingestionRun: runs.find((run) => run.jobId === job.id || run.id === job.payload.ingestionRunId) ?? null,
      source: sources.find((source) => source.id === job.payload.sourceItemId) ?? null
    }));
  }

  private schedule(delay: number): void {
    if (!this.running || this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drainPromise = this.drain()
        .catch((error: unknown) => this.options.logger?.error(normalizeWorkerError(error)))
        .finally(() => { this.drainPromise = null; });
    }, delay);
  }

  private async executeIngestion(job: JobRecord, controller: AbortController): Promise<Record<string, unknown>> {
    const signal = controller.signal;
    const ingestionRunId = readString(job.payload, "ingestionRunId");
    const documentId = readString(job.payload, "documentId");
    const sourceItemId = readString(job.payload, "sourceItemId");
    const markdown = readString(job.payload, "markdown");
    const pool = this.requirePool();
    const runs = createIngestionRunRepository(pool);
    const run = await runs.startOrResume(ingestionRunId) ?? await runs.findById(ingestionRunId);
    if (!run) throw new Error("ingestion_run_not_found");
    const checkpoint = run.stagesCheckpoint.chunking as JsonObject | undefined;
    let persistedChunks;
    if (checkpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "chunking");
      this.notify();
      const chunkResult = await this.workers.execute("chunking", {
        markdown,
        blocks: Array.isArray(job.payload.blocks) ? job.payload.blocks : []
      }, {
        signal,
        onProgress: (progress) => this.trackProgress(
          createJobRepository(pool).reportProgress(job.id, 0.05 + progress * 0.3)
        )
      });
      const chunks = Array.isArray(chunkResult.chunks) ? chunkResult.chunks : [];
      persistedChunks = await createChunkRepository(pool).replaceDocumentChunks(
        documentId,
        sourceItemId,
        chunks.map((raw) => parseWorkerChunk(raw))
      );
      await runs.completeStage(ingestionRunId, "chunking", { chunkCount: chunks.length });
      this.notify();
    } else {
      persistedChunks = await createChunkRepository(pool).listByDocument(documentId);
    }
    const embeddingCheckpoint = run.stagesCheckpoint.embedding as JsonObject | undefined;
    if (embeddingCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "embedding");
      this.notify();
      let embeddedCount = 0;
      if (this.options.generateEmbedding) {
        for (const chunk of persistedChunks) {
          if (signal.aborted) throw new DOMException("Ingestion canceled.", "AbortError");
          const generated = await this.options.generateEmbedding(chunk.content, signal);
          if (!generated) break;
          const validated = await this.workers.execute("embedding", { embedding: generated.embedding }, { signal });
          const embedding = Array.isArray(validated.embedding) ? validated.embedding.map(Number) : [];
          await createEmbeddingRepository(pool).upsert({
            targetType: "chunk", targetId: chunk.id, chunkId: chunk.id,
            provider: generated.provider, model: generated.model, runtime: generated.runtime,
            contentHash: chunk.contentHash, embedding
          });
          embeddedCount += 1;
        }
      }
      await runs.completeStage(ingestionRunId, "embedding", {
        embeddedCount,
        configured: Boolean(this.options.generateEmbedding)
      });
      this.notify();
    }
    await createJobRepository(pool).reportProgress(job.id, 0.5);
    throwIfAborted(signal);
    const summaryCheckpoint = run.stagesCheckpoint.summarization as JsonObject | undefined;
    if (summaryCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "summarization");
      this.notify();
      const summary = this.options.knowledgeService
        ? await this.runInlineStageJob(
            "summarization",
            { ingestionRunId, sourceItemId, documentId },
            (stageJobId) => this.options.knowledgeService!.summarizeSource(
              sourceItemId,
              documentId,
              signal,
              (progress) => this.reportInlineProgress(stageJobId, progress)
            ),
            controller
          )
        : { configured: false, generated: false };
      await runs.completeStage(ingestionRunId, "summarization", summary);
      this.notify();
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.68);
    const atomicCheckpoint = run.stagesCheckpoint.atomicNotes as JsonObject | undefined;
    let noteIds = readStringArray((atomicCheckpoint?.metadata as JsonObject | undefined)?.noteIds);
    if (atomicCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "atomicNotes");
      this.notify();
      const generated = this.options.knowledgeService
        ? await this.runInlineStageJob(
            "atomic-note-generation",
            { ingestionRunId, sourceItemId, documentId },
            (jobId) => this.options.knowledgeService!.generateAtomicNotes(
              sourceItemId,
              documentId,
              { jobId, ingestionRunId, onProgress: (progress) => this.reportInlineProgress(jobId, progress) },
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
    if (graphCheckpoint?.status !== "completed") {
      const graphMetadata = graphCheckpoint?.metadata as JsonObject | undefined;
      await runs.beginStage(ingestionRunId, "knowledgeGraph");
      this.notify();
      const graph = this.options.knowledgeService
        ? await this.runInlineStageJob(
            "knowledge-graph-generation",
            { ingestionRunId, sourceItemId, documentId },
            (stageJobId) => this.options.knowledgeService!.generateKnowledgeGraph(
              sourceItemId,
              documentId,
              {
                completedBatches: graphMetadata?.completedBatches,
                onProgress: (progress) => this.reportInlineProgress(stageJobId, progress),
                onBatchCompleted: async ({ completed, total, checkpoints }) => {
                  const progress = total > 0 ? completed / total : 1;
                  await Promise.all([
                    createJobRepository(pool).reportProgress(stageJobId, progress),
                    createJobRepository(pool).reportProgress(job.id, 0.84 + progress * 0.05),
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
      await runs.completeStage(ingestionRunId, "knowledgeGraph", graph);
      this.notify();
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.89);
    const matchingCheckpoint = run.stagesCheckpoint.atomicNoteMatching as JsonObject | undefined;
    if (matchingCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "atomicNoteMatching");
      this.notify();
      const matching = this.options.knowledgeService && noteIds.length > 0
        ? await this.runInlineStageJob(
            "atomic-note-matching",
            { ingestionRunId, sourceItemId, documentId, noteIds },
            (stageJobId) => this.options.knowledgeService!.matchAtomicNotes(
              noteIds,
              signal,
              async (progress) => {
                const completed = Math.min(noteIds.length, Math.round(progress * noteIds.length));
                await Promise.all([
                  createJobRepository(pool).reportProgress(stageJobId, progress),
                  createJobRepository(pool).reportProgress(job.id, 0.89 + progress * 0.06),
                  runs.updateStageProgress(ingestionRunId, "atomicNoteMatching", progress, {
                    completed,
                    total: noteIds.length
                  })
                ]);
                this.notify();
              }
            ),
            controller
          )
        : { persistedCount: 0 };
      await runs.completeStage(ingestionRunId, "atomicNoteMatching", matching);
      this.notify();
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.95);
    const projectionCheckpoint = run.stagesCheckpoint.obsidianProjection as JsonObject | undefined;
    if (projectionCheckpoint?.status !== "completed") {
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
    await runs.complete(ingestionRunId);
    this.notify();
    return { ingestionRunId, documentId, sourceItemId };
  }

  private async runInlineStageJob(
    type: string,
    payload: JsonObject,
    run: (jobId: string) => Promise<Record<string, unknown>>,
    controller?: AbortController
  ): Promise<Record<string, unknown>> {
    const repository = createJobRepository(this.requirePool());
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
      const result = await run(job.id);
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
      logStructuredError(this.options.logger, "job_failed", {
        jobId: job.id,
        jobType: type,
        ingestionRunId: optionalString(payload.ingestionRunId),
        sourceItemId: optionalString(payload.sourceItemId),
        documentId: optionalString(payload.documentId),
        stage: type
      }, error, "job_failed");
      const canceled = controller?.signal.aborted ?? false;
      const normalizedError = normalizeWorkerError(error);
      await repository.update(job.id, {
        status: canceled ? "canceled" : "failed",
        error: canceled ? null : normalizedError,
        payload: canceled ? payload : appendErrorHistory(payload, {
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

  private async drain(): Promise<void> {
    if (!this.running || this.stopping) return;
    const job = await this.runOnce();
    if (!job) await this.options.releaseAiRuntime?.();
    this.schedule(job ? 0 : (this.options.pollIntervalMs ?? 500));
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
  const boundingBox = typeof value.boundingBox === "object" && value.boundingBox !== null
    ? value.boundingBox as JsonObject
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

function normalizeWorkerError(error: unknown): string {
  if (!(error instanceof Error)) return "worker_failed";
  return error.message.slice(0, 500);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
