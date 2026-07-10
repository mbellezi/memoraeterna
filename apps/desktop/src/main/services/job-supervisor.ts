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
    this.controllers.clear();
    await this.workers.shutdown();
  }

  public async runOnce(): Promise<JobRecord | null> {
    const repository = createJobRepository(this.requirePool());
    const job = await repository.claimNext(this.workerId);
    if (!job) return null;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      if (!supportedJobTypes.has(job.type as WorkerTask["type"])) throw new Error("unsupported_job_type");
      const result = job.type === "ingestion"
        ? await this.executeIngestion(job, controller.signal)
        : await this.workers.execute(job.type as WorkerTask["type"], job.payload, {
            signal: controller.signal,
            onProgress: (progress) => { void repository.reportProgress(job.id, progress); }
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

  private schedule(delay: number): void {
    if (!this.running || this.stopping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain().catch((error: unknown) => this.options.logger?.error(normalizeWorkerError(error)));
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
        onProgress: (progress) => {
          void createJobRepository(pool).reportProgress(job.id, 0.2 + progress * 0.7);
        }
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
    await runs.complete(ingestionRunId);
    return { ingestionRunId, documentId, sourceItemId };
  }

  private async drain(): Promise<void> {
    if (!this.running || this.stopping) return;
    const job = await this.runOnce();
    this.schedule(job ? 0 : (this.options.pollIntervalMs ?? 500));
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
