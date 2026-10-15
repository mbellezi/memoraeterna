import type { JobRecord, JsonObject } from "@app/db";
import { MaintenanceCommandSchema } from "@app/domain";

import type { MaintenanceService } from "./maintenance-service.js";

/**
 * The legacy wiki, curator, organization and maintenance writers are retired (F2 D3): nothing may
 * create legacy state again. This module is their fence. Every fenced entry answers this localized
 * error and writes nothing. The task that deletes the legacy code deletes this module with it.
 */
export const legacyRetiredKey = "legacy.errors.retired";

export function legacyRetiredError(): Error {
  return new Error(legacyRetiredKey);
}

/**
 * Wraps one legacy IPC channel. Deny by default: only a command named in `reads` (the read commands
 * that still-mounted UI calls) is validated and forwarded; any other command, including one added
 * later and one with a malformed payload, answers `legacy.errors.retired` before the service runs.
 */
export function fenceLegacyCommand<Command extends { command: string }, Result>(
  reads: ReadonlySet<string>,
  schema: { parse(input: unknown): Command },
  run: (command: Command) => Result
): (input: unknown) => Result {
  return (input) => {
    const name =
      typeof input === "object" && input !== null
        ? (input as { command?: unknown }).command
        : undefined;
    if (typeof name !== "string" || !reads.has(name)) throw legacyRetiredError();
    return run(schema.parse(input));
  };
}

/** The legacy maintenance command the Maintenance view and the golden tooling still read. */
export const maintenanceReadCommands: ReadonlySet<string> = new Set(["dashboard"]);

/** The `maintenanceCommand` handler: `dashboard` reads, every other command is retired. */
export function createMaintenanceCommandHandler(service: Pick<MaintenanceService, "command">) {
  const fenced = fenceLegacyCommand(maintenanceReadCommands, MaintenanceCommandSchema, (command) =>
    service.command(command)
  );
  return (_event: unknown, input: unknown) => fenced(input);
}

/**
 * The executor behind the `organization` and `maintenance` job types. A job of those types that is
 * still queued (an app that stopped with work admitted) must not run the retired code: `cancel`
 * is the supervisor's own cancellation, which aborts the job in progress, so the supervisor ends
 * it as canceled and never retries it. The result names the reason. Nothing else is written.
 */
export function createRetiredJobExecutor(cancel: (jobId: string) => Promise<unknown>) {
  return async (job: JobRecord): Promise<JsonObject> => {
    await cancel(job.id);
    return { error: legacyRetiredKey, jobType: job.type };
  };
}
