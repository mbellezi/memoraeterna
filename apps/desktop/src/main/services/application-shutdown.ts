/**
 * The application's quit path (F3 T62 follow-up). Quitting stops the services in order, and every
 * step has a bound: a step that does not end within it is logged by name, with what it was waiting
 * for, and the quit goes on without it. A pre-soak once ended its driver and then never quit: the
 * Electron process stayed up for 85 minutes behind one unbounded wait, with the database never
 * asked to stop. Now no wait is unbounded, a failing step cannot skip the ones after it (the
 * database is always asked to stop), and a watchdog ends the process if the platform's own quit
 * does not complete after the services are down.
 */

/** The logger of the quit path (the main process passes `console`). */
export interface ShutdownLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ShutdownStep {
  name: string;
  /** The longest the quit waits for this step before it goes on without it. */
  timeoutMs: number;
  run(): Promise<unknown> | unknown;
  /** What the step is waiting for, read when it overruns, so the log names the culprit. */
  describe?: () => string;
}

export interface ShutdownStepOutcome {
  name: string;
  outcome: "done" | "timeout" | "failed";
  ms: number;
}

/** After the last step the platform still has to close its windows and exit. */
export const shutdownExitGraceMs = 15_000;

/** The longest a quit can take: every step at its bound, then the platform's own exit. */
export function shutdownBoundMs(steps: readonly ShutdownStep[], graceMs = shutdownExitGraceMs) {
  return steps.reduce((total, step) => total + step.timeoutMs, graceMs);
}

const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the process holds open, by kind (`TCPSocketWrap 3, ChildProcess 1`): a hint at what a step waits for. */
function activeResources(): string {
  const read = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo;
  if (typeof read !== "function") return "";
  const counts = new Map<string, number>();
  for (const name of read.call(process)) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => `${name} ${count}`).join(", ");
}

function safeDescribe(step: ShutdownStep): string {
  try {
    return step.describe?.() ?? "";
  } catch (error) {
    return `(could not be read: ${failureText(error)})`;
  }
}

/**
 * Runs the steps one after the other. A step ends `done`, `failed` (it threw) or `timeout` (it did
 * not end within its bound: its promise is left running and a late failure is only logged). The
 * next step always runs, so a stuck or failing step never keeps the database from being stopped.
 */
export async function runShutdownSteps(
  steps: readonly ShutdownStep[],
  options: { logger: ShutdownLogger; now?: () => number }
): Promise<ShutdownStepOutcome[]> {
  const now = options.now ?? Date.now;
  const outcomes: ShutdownStepOutcome[] = [];
  for (const step of steps) {
    const startedAt = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), step.timeoutMs);
    });
    const work = (async () => step.run())().then(
      () => "done" as const,
      (error: unknown) => {
        options.logger.warn(`Shutdown: ${step.name} failed: ${failureText(error)}`);
        return "failed" as const;
      }
    );
    const outcome = await Promise.race([work, bound]);
    clearTimeout(timer);
    const ms = now() - startedAt;
    if (outcome === "timeout") {
      const waiting = safeDescribe(step);
      const open = activeResources();
      options.logger.warn(
        `Shutdown: ${step.name} did not end within ${step.timeoutMs} ms; going on without it${
          waiting ? ` (${waiting})` : ""
        }${open ? ` [open: ${open}]` : ""}`
      );
    }
    outcomes.push({ name: step.name, outcome, ms });
  }
  return outcomes;
}

export interface ApplicationShutdown {
  /** Starts the quit once; later calls return the same promise. It resolves when the steps ended. */
  begin(): Promise<void>;
}

/**
 * The quit as the main process runs it: the steps, then `quit()` (the platform's second quit, with
 * the services down), and a watchdog armed at the start that calls `exit` if the process is still
 * there after every step's bound and the grace for the platform. It is never disarmed: a process
 * that is leaving does not mind it.
 */
export function createApplicationShutdown(options: {
  steps: () => ShutdownStep[];
  logger: ShutdownLogger;
  quit(): void;
  exit(): void;
  graceMs?: number;
  now?: () => number;
}): ApplicationShutdown {
  let started: Promise<void> | null = null;
  return {
    begin() {
      started ??= (async () => {
        const steps = options.steps();
        const bound = shutdownBoundMs(steps, options.graceMs);
        const watchdog = setTimeout(() => {
          options.logger.error(
            `Shutdown: the process was still running after ${bound} ms; exiting`
          );
          options.exit();
        }, bound);
        watchdog.unref?.();
        const startedAt = (options.now ?? Date.now)();
        try {
          const outcomes = await runShutdownSteps(steps, {
            logger: options.logger,
            ...(options.now ? { now: options.now } : {})
          });
          const overran = outcomes.filter((entry) => entry.outcome !== "done");
          options.logger.info(
            `Shutdown: services down in ${(options.now ?? Date.now)() - startedAt} ms${
              overran.length > 0
                ? `; ${overran.map((entry) => `${entry.name} ${entry.outcome}`).join(", ")}`
                : ""
            }`
          );
        } finally {
          options.quit();
        }
      })();
      return started;
    }
  };
}

/** A short line for the lanes: `local running 1 waiting P1:1`, the lanes that do nothing left out. */
export function describeLanes(
  lanes: ReadonlyArray<{
    lane: string;
    running: number;
    held: number;
    waiting: Readonly<Record<string, number>>;
  }>
): string {
  const parts = lanes.flatMap((lane) => {
    const waiting = Object.entries(lane.waiting)
      .filter(([, count]) => count > 0)
      .map(([priority, count]) => `${priority}:${count}`);
    if (lane.running === 0 && lane.held === 0 && waiting.length === 0) return [];
    return [
      `${lane.lane} running ${lane.running}${lane.held ? ` held ${lane.held}` : ""}${
        waiting.length > 0 ? ` waiting ${waiting.join(",")}` : ""
      }`
    ];
  });
  return parts.length > 0 ? `AI lanes: ${parts.join("; ")}` : "AI lanes idle";
}
