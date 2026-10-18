import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createApplicationShutdown,
  describeLanes,
  runShutdownSteps,
  shutdownBoundMs,
  shutdownExitGraceMs,
  type ShutdownLogger,
  type ShutdownStep
} from "./application-shutdown.js";

function logger() {
  const lines: Array<{ level: "info" | "warn" | "error"; message: string }> = [];
  const log: ShutdownLogger = {
    info: (message) => lines.push({ level: "info", message }),
    warn: (message) => lines.push({ level: "warn", message }),
    error: (message) => lines.push({ level: "error", message })
  };
  return { log, lines };
}

/** A step that never ends, as a job that ignores its cancellation. */
const stuck = (name: string, timeoutMs: number, describe?: () => string): ShutdownStep => ({
  name,
  timeoutMs,
  run: () => new Promise<never>(() => undefined),
  ...(describe ? { describe } : {})
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("running the quit steps", () => {
  it("runs the steps in order and reports each", async () => {
    const order: string[] = [];
    const { log, lines } = logger();
    const outcomes = await runShutdownSteps(
      [
        { name: "a", timeoutMs: 1_000, run: () => void order.push("a") },
        { name: "b", timeoutMs: 1_000, run: async () => void order.push("b") }
      ],
      { logger: log }
    );
    expect(order).toEqual(["a", "b"]);
    expect(outcomes.map((entry) => [entry.name, entry.outcome])).toEqual([
      ["a", "done"],
      ["b", "done"]
    ]);
    expect(lines).toEqual([]);
  });

  it("goes on past a step that never ends, names it and says what it waits for", async () => {
    const { log, lines } = logger();
    const later = vi.fn();
    const running = runShutdownSteps(
      [
        stuck("job supervisor", 30_000, () => "jobs in flight: 10d242, 2e343e"),
        { name: "database", timeoutMs: 45_000, run: later }
      ],
      { logger: log }
    );
    await vi.advanceTimersByTimeAsync(29_999);
    expect(later).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const outcomes = await running;
    // The step after a stuck one still runs: the database is always asked to stop.
    expect(later).toHaveBeenCalledOnce();
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["timeout", "done"]);
    expect(outcomes[0]!.ms).toBe(30_000);
    const warning = lines.find((entry) => entry.level === "warn")!.message;
    expect(warning).toContain("job supervisor did not end within 30000 ms");
    expect(warning).toContain("jobs in flight: 10d242, 2e343e");
  });

  it("does not let a step that throws, now or late, skip the ones after it", async () => {
    const { log, lines } = logger();
    const later = vi.fn();
    const running = runShutdownSteps(
      [
        {
          name: "integration gateway",
          timeoutMs: 1_000,
          run: () => {
            throw new Error("address in use");
          }
        },
        {
          name: "late failure",
          timeoutMs: 1_000,
          run: () =>
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error("late")), 5_000)
            )
        },
        { name: "database", timeoutMs: 1_000, run: later }
      ],
      { logger: log }
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const outcomes = await running;
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["failed", "timeout", "done"]);
    expect(later).toHaveBeenCalledOnce();
    expect(
      lines.some((entry) => entry.message.includes("integration gateway failed: address in use"))
    ).toBe(true);
    // The late rejection of the abandoned step is logged, never an unhandled rejection.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lines.some((entry) => entry.message.includes("late failure failed: late"))).toBe(true);
  });

  it("survives a describe that throws", async () => {
    const { log, lines } = logger();
    const running = runShutdownSteps(
      [
        stuck("AI runtime", 10, () => {
          throw new Error("service gone");
        })
      ],
      { logger: log }
    );
    await vi.advanceTimersByTimeAsync(10);
    expect((await running).map((entry) => entry.outcome)).toEqual(["timeout"]);
    expect(lines.find((entry) => entry.level === "warn")?.message).toContain(
      "AI runtime did not end within 10 ms"
    );
  });
});

describe("the application's quit", () => {
  it("quits after the steps, within the sum of their bounds, when one is stuck", async () => {
    const { log, lines } = logger();
    const quit = vi.fn();
    const exit = vi.fn();
    const steps: ShutdownStep[] = [
      { name: "window", timeoutMs: 2_000, run: () => undefined },
      stuck("job supervisor", 30_000),
      { name: "database", timeoutMs: 45_000, run: () => undefined }
    ];
    const shutdown = createApplicationShutdown({ steps: () => steps, logger: log, quit, exit });
    const done = shutdown.begin();
    await vi.advanceTimersByTimeAsync(30_000);
    await done;
    // The platform's quit is asked for once the services are down, 30 s in, far before the bound.
    expect(quit).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(
      lines.find((entry) => entry.level === "info" && entry.message.includes("services down"))
        ?.message
    ).toContain("job supervisor timeout");
    // Asking again does not run the steps a second time.
    await shutdown.begin();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("ends the process when the platform's quit does not complete after the services are down", async () => {
    const { log, lines } = logger();
    const exit = vi.fn();
    const steps: ShutdownStep[] = [stuck("job supervisor", 30_000), stuck("database", 45_000)];
    const shutdown = createApplicationShutdown({
      steps: () => steps,
      logger: log,
      // `app.quit()` that never ends the process, as a window that refuses to close.
      quit: () => undefined,
      exit
    });
    void shutdown.begin();
    const bound = shutdownBoundMs(steps);
    expect(bound).toBe(30_000 + 45_000 + shutdownExitGraceMs);
    await vi.advanceTimersByTimeAsync(bound - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledOnce();
    expect(
      lines.some((entry) => entry.level === "error" && entry.message.includes("exiting"))
    ).toBe(true);
  });

  it("asks the platform to quit even when a step cannot be built to run", async () => {
    const { log } = logger();
    const quit = vi.fn();
    const shutdown = createApplicationShutdown({
      steps: () => [
        {
          name: "broken",
          timeoutMs: 100,
          run: () => {
            throw new Error("boom");
          }
        }
      ],
      logger: log,
      quit,
      exit: vi.fn()
    });
    await shutdown.begin();
    expect(quit).toHaveBeenCalledOnce();
  });
});

describe("describing the AI lanes", () => {
  it("lists only the lanes with work, with their queues", () => {
    expect(
      describeLanes([
        { lane: "local", running: 1, held: 0, waiting: { P0: 0, P1: 1, P2: 0, P3: 0 } },
        { lane: "remote:a", running: 0, held: 0, waiting: { P0: 0, P1: 0, P2: 0, P3: 0 } }
      ])
    ).toBe("AI lanes: local running 1 waiting P1:1");
    expect(describeLanes([{ lane: "local", running: 0, held: 0, waiting: { P0: 0 } }])).toBe(
      "AI lanes idle"
    );
  });
});
