import { isTransientAiError } from "@app/ai";

/** PostgreSQL connection, shutdown, serialization and lock errors that a later attempt can outlive. */
const transientDatabaseCodes = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "40001",
  "40P01",
  "53300",
  "53400",
  "55P03",
  "57P01",
  "57P02",
  "57P03"
]);
/** Busy or locked files, exhausted descriptors and dropped connections of the filesystem and network I/O. */
const transientSystemCodes = new Set([
  "EBUSY",
  "EAGAIN",
  "EMFILE",
  "ENFILE",
  "ETIMEDOUT",
  "ECONNRESET"
]);
const transientMessages = [
  /^Worker exited with code \d+\.?$/,
  /^Connection terminated/,
  /^timeout exceeded when trying to connect/,
  /^Client has encountered a connection error/,
  // The local helper died without answering, the routed model changed while the call waited, or
  // the local model was busy: a new attempt is admitted again with the current routing.
  /^errors\.localModels\.(?:runtimeFailed|modelBusy)$/,
  /^organization\.errors\.modelChanged$/
];

/**
 * Whether a failed job can succeed when it runs again: provider timeouts, 408/425/429/5xx, network
 * failures, stalled streams, a crashed worker or local helper, database connection or contention
 * errors, and transient filesystem errors (a worker reports the error code with its message).
 * Everything else is deterministic (invalid model output after its repair, an empty document, a missing
 * model or credential, a context overflow): the job fails once and keeps its real error.
 *
 * A bare `AbortError` is transient (F4 D8): a local runtime aborts a batch or a load of its own, and the
 * job that asked can run again. It says nothing about who aborted, so the callers decide cancellation
 * first, from the job's own signal: an aborted signal is a cancel (the user's, or the quit's), never a
 * retry, and only a live signal reaches this check (`job-supervisor.ts`, `catalog-header-refresh.ts`).
 * It stays out of `isTransientAiError`, which adapters use to retry calls and would retry cancelled ones.
 */
export function isTransientJobFailure(error: unknown): boolean {
  if (isTransientAiError(error)) return true;
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current.name === "AbortError") return true;
    const { code, message } = current as Error & { code?: unknown };
    if (
      typeof code === "string" &&
      (transientDatabaseCodes.has(code) || transientSystemCodes.has(code))
    )
      return true;
    if (transientMessages.some((pattern) => pattern.test(message))) return true;
    current = current.cause;
  }
  return false;
}
