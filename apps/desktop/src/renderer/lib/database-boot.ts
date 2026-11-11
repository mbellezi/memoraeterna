import type { DatabaseStatus } from "../../shared/ipc";
import type { AppEventApi } from "./app-events";

/**
 * The boot of the window (F5 D16): it learns the database lifecycle from `database.status`, which
 * is sticky (a window that loads late gets the last value) and sent at once, plus one
 * `database.getStatus` read. No loop waits and asks again.
 */

export interface DatabaseBootApi extends AppEventApi {
  database: { getStatus(): Promise<DatabaseStatus> };
}

export interface WaitForDatabaseOptions {
  /** Every status of this attempt, in the order it arrives (the boot screen shows its message). */
  onStatus: (status: DatabaseStatus) => void;
  /** How long to wait for a final state before the boot fails. */
  timeoutMs: number;
  /** The clock, for a test. */
  now?: () => number;
}

const failedStatus = (error?: string): DatabaseStatus => ({
  state: "failed",
  messageKey: "database.status.failed",
  updatedAt: new Date().toISOString(),
  ...(error ? { error } : {})
});

/**
 * Resolves with the first final status (`ready`, or a `failed` that this attempt produced). A
 * `failed` stamped before the attempt began is the replay of an earlier failure, which a retry
 * must not take for its own result; a status older than one already seen is dropped. A failed read
 * and the timeout end the wait as `failed`, as the old loop did. Call it right after asking main to
 * start the database.
 */
export function waitForDatabaseReady(
  api: DatabaseBootApi,
  options: WaitForDatabaseOptions
): Promise<DatabaseStatus> {
  const attemptStartedAt = (options.now ?? Date.now)();
  return new Promise<DatabaseStatus>((resolve) => {
    let settled = false;
    let newest = 0;
    let stopListening: () => void = () => undefined;

    const timeout = setTimeout(
      () => finish(failedStatus("Database startup timed out.")),
      options.timeoutMs
    );
    const finish = (status: DatabaseStatus): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stopListening();
      resolve(status);
    };

    const take = (status: DatabaseStatus): void => {
      if (settled) return;
      const at = Date.parse(status.updatedAt);
      if (status.state === "failed" && at < attemptStartedAt) return;
      if (at < newest) return;
      newest = at;
      options.onStatus(status);
      if (status.state === "ready" || status.state === "failed") finish(status);
    };

    stopListening = api.onAppEvent("database.status", (event) => {
      const { type, ...status } = event;
      void type;
      take(status);
    });
    // The sticky replay can settle the wait while the subscription is still being made.
    if (settled) {
      stopListening();
      return;
    }
    api.database.getStatus().then(take, () => finish(failedStatus()));
  });
}
