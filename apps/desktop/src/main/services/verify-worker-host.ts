import { createRequire, syncBuiltinESMExports } from "node:module";

/**
 * Side-effect module for the real-service verification scripts. The packaged app bundles the worker
 * host next to the main bundle; under tsx it is the TypeScript source, so the supervisor's worker
 * threads are pointed there (tsx's loader is inherited by the thread). Import it before any service.
 */
const workerThreads = createRequire(import.meta.url)(
  "node:worker_threads"
) as typeof import("node:worker_threads");
class SourceWorker extends workerThreads.Worker {
  public constructor(file: string | URL, options?: import("node:worker_threads").WorkerOptions) {
    super(
      file instanceof URL && file.pathname.endsWith("/services/workers/worker-host.js")
        ? new URL("../workers/worker-host.ts", import.meta.url)
        : file,
      options
    );
  }
}
workerThreads.Worker = SourceWorker;
syncBuiltinESMExports();
