import { hostname } from "node:os";

import {
  createChunkRepository,
  createEmbeddingRepository,
  createIngestionRunRepository,
  createJobRepository,
  type JobRecord,
  type JsonObject,
  type PgPool
} from "@app/db";

import { WorkerSupervisor } from "./worker-supervisor.js";
import type { KnowledgeService } from "./knowledge-service.js";
import type { ObsidianSyncService } from "./obsidian-sync-service.js";
import type { WorkerTask } from "../workers/worker-contracts.js";

export interface JobSupervisorOptions {
  getPool: () => PgPool | null;
  pollIntervalMs?: number;
  logger?: Pick<Console, "error" | "warn">;
  generateEmbedding?: (text: string) => Promise<{
    embedding: number[];
    provider: string;
    model: string;
    runtime: string;
  } | null>;
  knowledgeService?: KnowledgeService;
  obsidianSyncService?: Pick<ObsidianSyncService, "projectSource">;
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
  private readonly workerId = `${hostname()}:${process.pid}`;

  public constructor(private readonly options: JobSupervisorOptions) {}

  public async start(): Promise<void> {
    if (this.running) return;
    const pool = this.requirePool();
    await createJobRepository(pool).recoverStale();
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
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      if (!supportedJobTypes.has(job.type as WorkerTask["type"])) throw new Error("unsupported_job_type");
      const result = job.type === "ingestion"
        ? await this.executeIngestion(job, controller.signal)
        : await this.workers.execute(job.type as WorkerTask["type"], job.payload, {
            signal: controller.signal,
            onProgress: (progress) => this.trackProgress(repository.reportProgress(job.id, progress))
          });
      return await repository.update(job.id, {
        status: controller.signal.aborted ? "canceled" : "succeeded",
        progress: controller.signal.aborted ? job.progress : 1,
        result,
        error: null,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date()
      });
    } catch (error) {
      const wasCanceled = controller.signal.aborted;
      const shouldRetry = !wasCanceled && job.attempts < job.maxAttempts;
      if (job.type === "ingestion" && typeof job.payload.ingestionRunId === "string") {
        const runs = createIngestionRunRepository(this.requirePool());
        if (wasCanceled) {
          await runs.update(job.payload.ingestionRunId, { status: "canceled", error: null });
        } else {
          await runs.fail(job.payload.ingestionRunId, normalizeWorkerError(error));
        }
      }
      return await repository.update(job.id, {
        status: wasCanceled ? "canceled" : shouldRetry ? "queued" : "failed",
        error: wasCanceled ? null : normalizeWorkerError(error),
        runAfter: shouldRetry ? new Date(Date.now() + Math.min(30_000, 1_000 * 2 ** job.attempts)) : job.runAfter,
        lockedAt: null,
        lockedBy: null,
        finishedAt: shouldRetry ? null : new Date()
      });
    } finally {
      this.controllers.delete(job.id);
    }
  }

  public async requestCancel(jobId: string): Promise<JobRecord | null> {
    const job = await createJobRepository(this.requirePool()).requestCancel(jobId);
    this.controllers.get(jobId)?.abort();
    return job;
  }

  public async retry(jobId: string): Promise<JobRecord | null> {
    const job = await createJobRepository(this.requirePool()).retry(jobId);
    if (job) this.schedule(0);
    return job;
  }

  public async list(limit = 100): Promise<JobRecord[]> {
    return createJobRepository(this.requirePool()).list(limit);
  }

  public async listWithRuns(limit = 100) {
    const pool = this.requirePool();
    const [jobs, runs] = await Promise.all([
      createJobRepository(pool).list(limit),
      createIngestionRunRepository(pool).list(limit)
    ]);
    return jobs.map((job) => ({
      job,
      ingestionRun: runs.find((run) => run.jobId === job.id || run.id === job.payload.ingestionRunId) ?? null
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

  private async executeIngestion(job: JobRecord, signal: AbortSignal): Promise<Record<string, unknown>> {
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
    } else {
      persistedChunks = await createChunkRepository(pool).listByDocument(documentId);
    }
    const embeddingCheckpoint = run.stagesCheckpoint.embedding as JsonObject | undefined;
    if (embeddingCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "embedding");
      let embeddedCount = 0;
      if (this.options.generateEmbedding) {
        for (const chunk of persistedChunks) {
          if (signal.aborted) throw new DOMException("Ingestion canceled.", "AbortError");
          const generated = await this.options.generateEmbedding(chunk.content);
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
    }
    await createJobRepository(pool).reportProgress(job.id, 0.5);
    throwIfAborted(signal);
    const summaryCheckpoint = run.stagesCheckpoint.summarization as JsonObject | undefined;
    if (summaryCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "summarization");
      const summary = this.options.knowledgeService
        ? await this.runInlineStageJob(
            "summarization",
            { ingestionRunId, sourceItemId, documentId },
            () => this.options.knowledgeService!.summarizeSource(sourceItemId, documentId)
          )
        : { configured: false, generated: false };
      await runs.completeStage(ingestionRunId, "summarization", summary);
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.68);
    const atomicCheckpoint = run.stagesCheckpoint.atomicNotes as JsonObject | undefined;
    let noteIds = readStringArray((atomicCheckpoint?.metadata as JsonObject | undefined)?.noteIds);
    if (atomicCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "atomicNotes");
      const generated = this.options.knowledgeService
        ? await this.runInlineStageJob(
            "atomic-note-generation",
            { ingestionRunId, sourceItemId, documentId },
            () => this.options.knowledgeService!.generateAtomicNotes(sourceItemId, documentId)
          )
        : { configured: false, generatedCount: 0, noteIds: [] };
      noteIds = readStringArray(generated.noteIds);
      await runs.completeStage(ingestionRunId, "atomicNotes", generated);
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.84);
    const matchingCheckpoint = run.stagesCheckpoint.atomicNoteMatching as JsonObject | undefined;
    if (matchingCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "atomicNoteMatching");
      const matching = this.options.knowledgeService && noteIds.length > 0
        ? await this.runInlineStageJob(
            "atomic-note-matching",
            { ingestionRunId, sourceItemId, documentId, noteIds },
            () => this.options.knowledgeService!.matchAtomicNotes(noteIds)
          )
        : { persistedCount: 0 };
      await runs.completeStage(ingestionRunId, "atomicNoteMatching", matching);
    }
    throwIfAborted(signal);
    await createJobRepository(pool).reportProgress(job.id, 0.94);
    const projectionCheckpoint = run.stagesCheckpoint.obsidianProjection as JsonObject | undefined;
    if (projectionCheckpoint?.status !== "completed") {
      await runs.beginStage(ingestionRunId, "obsidianProjection");
      const projection = this.options.obsidianSyncService
        ? await this.runInlineStageJob(
            "obsidian-sync",
            { ingestionRunId, sourceItemId, documentId },
            () => this.options.obsidianSyncService!.projectSource(sourceItemId)
          )
        : { projected: 0 };
      await runs.completeStage(ingestionRunId, "obsidianProjection", projection);
    }
    await createJobRepository(pool).reportProgress(job.id, 0.98);
    await runs.complete(ingestionRunId);
    return { ingestionRunId, documentId, sourceItemId };
  }

  private async runInlineStageJob(
    type: string,
    payload: JsonObject,
    run: () => Promise<Record<string, unknown>>
  ): Promise<Record<string, unknown>> {
    const repository = createJobRepository(this.requirePool());
    const job = await repository.create({ type, payload, maxAttempts: 1 });
    await repository.update(job.id, {
      status: "running",
      attempts: 1,
      lockedAt: new Date(),
      lockedBy: this.workerId
    });
    try {
      const result = await run();
      await repository.update(job.id, {
        status: "succeeded",
        progress: 1,
        result,
        error: null,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date()
      });
      return result;
    } catch (error) {
      await repository.update(job.id, {
        status: "failed",
        error: normalizeWorkerError(error),
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date()
      });
      throw error;
    }
  }

  private async drain(): Promise<void> {
    if (!this.running || this.stopping) return;
    const job = await this.runOnce();
    this.schedule(job ? 0 : (this.options.pollIntervalMs ?? 500));
  }

  private trackProgress(promise: Promise<unknown>): void {
    this.pendingProgressUpdates.add(promise);
    void promise
      .catch((error: unknown) => this.options.logger?.warn(normalizeWorkerError(error)))
      .finally(() => this.pendingProgressUpdates.delete(promise));
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Ingestion canceled.", "AbortError");
}
