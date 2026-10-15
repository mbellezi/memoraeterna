import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { TransferListItem } from "node:worker_threads";

import {
  checkTopicClusteringResult,
  TopicClusteringError,
  topicClusteringErrorCodes,
  TopicClusteringRequestShapeSchema,
  TopicClusteringResultSchema,
  topicClusteringTimeoutMs
} from "@app/domain/topic-tree";
import type { TopicClusteringRequest, TopicClusteringResult } from "@app/domain/topic-tree";

import { jobTaskPayload } from "../job-task-payload.js";
import {
  workerFailure,
  workerMessageSchema,
  type WorkerTask
} from "../workers/worker-contracts.js";

export interface ExecuteWorkerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  /**
   * Buffers handed over to the worker instead of copied. They are detached in the caller when the
   * worker starts, so the payload must not be read again.
   */
  transferList?: readonly TransferListItem[];
  /** The rejection for a timeout; by default the worker's exit ("Worker exited with code N."). */
  timeoutError?: (timeoutMs: number) => Error;
  /** The rejection for an abort; by default an `AbortError`. */
  canceledError?: () => Error;
}

export interface WorkerSupervisorOptions {
  /** The worker host script; tests point it at a fixture. */
  workerUrl?: URL;
  /** Node options for the worker threads (for example a loader). */
  execArgv?: readonly string[];
}

export class WorkerSupervisor {
  private readonly activeWorkers = new Set<Worker>();
  private readonly workerUrl: URL;
  private readonly execArgv: string[] | undefined;

  constructor(options: WorkerSupervisorOptions = {}) {
    this.workerUrl = options.workerUrl ?? new URL("./workers/worker-host.js", import.meta.url);
    this.execArgv = options.execArgv ? [...options.execArgv] : undefined;
  }

  public async execute(
    type: WorkerTask["type"],
    payload: Record<string, unknown>,
    options: ExecuteWorkerOptions = {}
  ): Promise<Record<string, unknown>> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const worker = new Worker(this.workerUrl, {
      workerData: { id: randomUUID(), type, payload: jobTaskPayload(payload) },
      ...(options.transferList ? { transferList: [...options.transferList] } : {}),
      ...(this.execArgv ? { execArgv: this.execArgv } : {})
    });
    this.activeWorkers.add(worker);
    let timedOut = false;
    const abort = () => void worker.terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.on("message", (raw: unknown) => {
          const message = workerMessageSchema.parse(raw);
          if (message.kind === "progress") options.onProgress?.(message.progress);
          if (message.kind === "result") resolve(message.result);
          if (message.kind === "error") reject(workerFailure(message));
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (options.signal?.aborted) {
            reject(options.canceledError?.() ?? new DOMException("Worker canceled.", "AbortError"));
          } else if (timedOut && options.timeoutError) {
            reject(options.timeoutError(timeoutMs));
          } else if (code !== 0) {
            reject(new Error(`Worker exited with code ${code}.`));
          }
        });
      });
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      this.activeWorkers.delete(worker);
      await worker.terminate();
    }
  }

  /**
   * Clusters a matrix of unit rows in a worker thread (spec 3.4). The matrix is transferred, not
   * copied: `request.vectors` is detached afterwards. The timeout is 30 s plus 5 ms per row
   * (`build.workerTimeout*`), the worker validates the vectors, and the result is validated here.
   * Failures are `TopicClusteringError`s: invalid input, timeout, canceled or failed.
   */
  public async clusterTopics(
    request: TopicClusteringRequest,
    options: Pick<ExecuteWorkerOptions, "signal" | "onProgress"> = {}
  ): Promise<TopicClusteringResult> {
    const canceled = () =>
      new TopicClusteringError("topic_clustering_canceled", "Topic clustering was canceled.");
    const shape = TopicClusteringRequestShapeSchema.safeParse(request);
    const { vectors } = request;
    if (!shape.success) {
      throw new TopicClusteringError(
        "topic_clustering_invalid_input",
        `Invalid clustering request: ${shape.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`)
          .join("; ")}`
      );
    }
    if (
      !(vectors.buffer instanceof ArrayBuffer) ||
      vectors.byteOffset !== 0 ||
      vectors.byteLength !== vectors.buffer.byteLength
    ) {
      throw new TopicClusteringError(
        "topic_clustering_invalid_input",
        "The vectors must own a transferable buffer."
      );
    }
    if (options.signal?.aborted) throw canceled();
    let raw: Record<string, unknown>;
    try {
      raw = await this.execute(
        "topic-clustering",
        { ...shape.data },
        {
          ...options,
          timeoutMs: topicClusteringTimeoutMs(request.rows, shape.data.config.build),
          transferList: [vectors.buffer],
          canceledError: canceled,
          timeoutError: (timeoutMs) =>
            new TopicClusteringError(
              "topic_clustering_timeout",
              `Topic clustering of ${request.rows} rows exceeded ${timeoutMs} ms.`
            )
        }
      );
    } catch (error) {
      throw clusteringFailure(error);
    }
    const parsed = TopicClusteringResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TopicClusteringError(
        "topic_clustering_failed",
        `Invalid clustering result: ${parsed.error.issues[0]?.message ?? "malformed"}`
      );
    }
    checkTopicClusteringResult(parsed.data, shape.data);
    return parsed.data;
  }

  public async shutdown(): Promise<void> {
    await Promise.all([...this.activeWorkers].map((worker) => worker.terminate()));
    this.activeWorkers.clear();
  }
}

/** A worker's failure as a clustering error: its own code when it reported one. */
function clusteringFailure(error: unknown): TopicClusteringError {
  if (error instanceof TopicClusteringError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error && error.message ? error.message : "Clustering failed";
  const known = topicClusteringErrorCodes.find((candidate) => candidate === code);
  return new TopicClusteringError(known ?? "topic_clustering_failed", message, { cause: error });
}
