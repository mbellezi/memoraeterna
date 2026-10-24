import {
  AiProviderError,
  ProviderUnavailableError,
  isConnectFailure,
  isTransientAiError,
  providerFailureKind
} from "@app/ai";
import {
  gardenerBlocker,
  gardenerTaskConfig,
  type GardenerBlocker,
  type GardenerTaskConfig
} from "@app/domain";

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
  /^organization\.errors\.modelChanged$/,
  // The RemoteBudget refused an attempt before it was sent (F4 D14): the work waits for the cap to
  // clear (T75 sets it aside as a blocker without spending an attempt).
  /^gardener\.blocked\.cap\.(?:money_80|money_100|subscription_daily)$/
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

/**
 * The blocker of a job whose AI call met a provider outage (F4 D7): the remote lane's circuit
 * breaker failed it fast (`ProviderUnavailableError`), or its connection failed after the call's
 * own retries (DNS, routing, a refused connection: {@link isConnectFailure}), so nothing reached
 * the provider. Such a job waits, its attempt and dedupe key kept, instead of failing:
 * `offline.network_unreachable` when the network did not answer (the lane's memory of how its
 * provider failed, F4 D27), else `waiting.provider_unavailable`. A job whose own call failed comes
 * back after `providerProbeMs`, as the next probe; a refused one sent nothing and waits for the
 * probe's answer (`network_back`) or the blocker recheck, so a long outage costs one look per
 * probe, not one per waiting task. Answers keep their paths: 5xx, 429, deadlines and stalls back
 * off, and so does a reset or a cut stream (the request may have been sent, and a request that
 * always breaks the connection must still run out of attempts); 4xx and invalid output fail. Null
 * for any other error, a database's refused connection included (it is no provider error).
 */
export function providerOutageBlocker(
  error: unknown,
  now: number = Date.now(),
  config: Pick<GardenerTaskConfig, "providerProbeMs"> = gardenerTaskConfig
): GardenerBlocker | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (current instanceof ProviderUnavailableError)
      return current.failure === "unreachable"
        ? gardenerBlocker("offline", "network_unreachable", { clearsAt: null })
        : gardenerBlocker("waiting", "provider_unavailable", { clearsAt: null });
    if (current instanceof AiProviderError) {
      if (!isConnectFailure(current)) return null;
      const clearsAt = now + config.providerProbeMs;
      return providerFailureKind(current) === "unreachable"
        ? gardenerBlocker("offline", "network_unreachable", { clearsAt })
        : gardenerBlocker("waiting", "provider_unavailable", { clearsAt });
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Whether an error is a provider outage a job waits for ({@link providerOutageBlocker}). */
export function isProviderOutage(error: unknown): boolean {
  return providerOutageBlocker(error) !== null;
}
