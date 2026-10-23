import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalDisposeStep } from "@app/ai";

import { AiService } from "./ai-service.js";

/**
 * The quit's "AI runtime" step (F4 D23): each step of the local runtimes' disposal is bounded and
 * timed by its runtime, and the service logs them in one line so a quit that overran names the step.
 */

function service() {
  const logger = { info: vi.fn(), error: vi.fn() };
  const ai = new AiService({
    userDataPath: "/tmp/ai-dispose-tests",
    getPool: () => null,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    logger
  });
  const internals = ai as unknown as {
    releaseLocalRuntime: (force?: boolean) => Promise<void>;
    recordDisposeStep: (step: LocalDisposeStep) => void;
  };
  return { ai, logger, internals };
}

afterEach(() => vi.restoreAllMocks());

describe("AiService.dispose", () => {
  it("logs one line with every step of the disposal, its time and its bound", async () => {
    const { ai, logger, internals } = service();
    vi.spyOn(internals, "releaseLocalRuntime").mockImplementation(async (force) => {
      expect(force).toBe(true);
      internals.recordDisposeStep({ step: "gguf model", ms: 12, boundMs: 2_000, outcome: "done" });
      internals.recordDisposeStep({
        step: "mlx helper shutdown",
        ms: 31,
        boundMs: 2_000,
        outcome: "done"
      });
    });

    await ai.dispose();

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledOnce();
    expect(String(logger.info.mock.calls[0]![0])).toMatch(
      /^AI runtime disposed in \d+ ms: gguf model 12\/2000 ms done, mlx helper shutdown 31\/2000 ms done$/u
    );
  });

  it("logs a step that overran as an error as it ends, and still reports it in the line", async () => {
    const { ai, logger, internals } = service();
    vi.spyOn(internals, "releaseLocalRuntime").mockImplementation(async () => {
      internals.recordDisposeStep({
        step: "gguf engine",
        ms: 2_001,
        boundMs: 2_000,
        outcome: "timeout"
      });
    });

    await ai.dispose();

    expect(String(logger.error.mock.calls[0]![0])).toBe(
      "AI runtime: gguf engine timeout after 2001 ms (bound 2000 ms)"
    );
    expect(String(logger.info.mock.calls[0]![0])).toContain("gguf engine 2001/2000 ms timeout");
  });

  it("logs nothing when no local runtime was running, and keeps no step between disposals", async () => {
    const { ai, logger, internals } = service();
    await ai.dispose();
    expect(logger.info).not.toHaveBeenCalled();

    // A runtime that reports a step on its own (an idle release) is no part of a later disposal.
    internals.recordDisposeStep({ step: "gguf model", ms: 5, boundMs: 2_000, outcome: "done" });
    await ai.dispose();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
