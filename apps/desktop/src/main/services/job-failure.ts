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
 * failures, stalled streams, a crashed worker or local helper, and database connection or contention
 * errors.
 * Everything else is deterministic (invalid model output after its repair, an empty document, a missing
 * model or credential, a context overflow): the job fails once and keeps its real error.
 */
export function isTransientJobFailure(error: unknown): boolean {
  if (isTransientAiError(error)) return true;
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const { code, message } = current as Error & { code?: unknown };
    if (typeof code === "string" && transientDatabaseCodes.has(code)) return true;
    if (transientMessages.some((pattern) => pattern.test(message))) return true;
    current = current.cause;
  }
  return false;
}
