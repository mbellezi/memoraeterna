import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import { workerMessageSchema, type WorkerTask } from "../workers/worker-contracts.js";

export interface ExecuteWorkerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export class WorkerSupervisor {
  private readonly activeWorkers = new Set<Worker>();

  public async execute(
    type: WorkerTask["type"],
    payload: Record<string, unknown>,
    options: ExecuteWorkerOptions = {}
  ): Promise<Record<string, unknown>> {
    const worker = new Worker(new URL("./workers/worker-host.js", import.meta.url), {
      workerData: { id: randomUUID(), type, payload }
    });
    this.activeWorkers.add(worker);
    const abort = () => void worker.terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, options.timeoutMs ?? 120_000);
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        worker.on("message", (raw: unknown) => {
          const message = workerMessageSchema.parse(raw);
          if (message.kind === "progress") options.onProgress?.(message.progress);
          if (message.kind === "result") resolve(message.result);
          if (message.kind === "error") reject(new Error(message.error));
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (options.signal?.aborted) {
            reject(new DOMException("Worker canceled.", "AbortError"));
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

  public async shutdown(): Promise<void> {
    await Promise.all([...this.activeWorkers].map((worker) => worker.terminate()));
    this.activeWorkers.clear();
  }
}
