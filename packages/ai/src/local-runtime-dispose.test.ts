import { describe, expect, it, vi } from "vitest";

import { runDisposeStep, type LocalDisposeStep } from "./dispose-step.js";
import { NodeLlamaRuntime } from "./local-adapters.js";

/**
 * The bounded disposal of a local runtime (F4 D23): each step ends within its bound whatever the
 * native library does, and each is reported by name for the shutdown log.
 */

/** A stand-in for `node-llama-cpp`: the model and the engine dispose as the test scripts. */
function fakeEngine(
  options: {
    modelDispose?: () => Promise<void>;
    engineDispose?: () => Promise<void>;
    loadModel?: (input: { loadSignal?: AbortSignal }) => Promise<unknown>;
  } = {}
) {
  const model = { dispose: vi.fn(options.modelDispose ?? (async () => undefined)) };
  const llama = {
    dispose: vi.fn(options.engineDispose ?? (async () => undefined)),
    loadModel: vi.fn(options.loadModel ?? (async () => model))
  };
  return { model, llama, importModule: async () => ({ getLlama: async () => llama }) as never };
}

function runtime(engine: ReturnType<typeof fakeEngine>, disposeMs = 50) {
  const steps: LocalDisposeStep[] = [];
  const instance = new NodeLlamaRuntime("/models/writer.gguf", {
    disposeMs,
    onDisposeStep: (step) => steps.push(step),
    importModule: engine.importModule
  });
  return { instance, steps };
}

describe("runDisposeStep", () => {
  it("reports a step that ended, one that failed, and abandons one that overran", async () => {
    const seen: string[] = [];
    const listener = (step: LocalDisposeStep) => seen.push(`${step.step}:${step.outcome}`);
    await expect(runDisposeStep("ok", 100, async () => undefined, listener)).resolves.toMatchObject(
      {
        outcome: "done"
      }
    );
    await expect(
      runDisposeStep(
        "bad",
        100,
        async () => {
          throw new Error("native failure");
        },
        listener
      )
    ).resolves.toMatchObject({ outcome: "failed" });
    const started = Date.now();
    const slow = await runDisposeStep("slow", 40, () => new Promise(() => undefined), listener);
    expect(slow).toMatchObject({ step: "slow", boundMs: 40, outcome: "timeout" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(seen).toEqual(["ok:done", "bad:failed", "slow:timeout"]);
  });
});

describe("NodeLlamaRuntime.dispose", () => {
  it("disposes the model, then the engine, and reports both under their bound", async () => {
    const engine = fakeEngine();
    const { instance, steps } = runtime(engine);
    await instance.ensureLoaded();
    await instance.dispose();

    expect(steps.map((step) => [step.step, step.outcome])).toEqual([
      ["gguf model", "done"],
      ["gguf engine", "done"]
    ]);
    for (const step of steps) expect(step.ms).toBeLessThanOrEqual(step.boundMs);
    expect(instance.isLoaded()).toBe(false);
  });

  it("goes on to the engine when the model's dispose never returns, within the bound", async () => {
    const engine = fakeEngine({ modelDispose: () => new Promise(() => undefined) });
    const { instance, steps } = runtime(engine, 40);
    await instance.ensureLoaded();
    const started = Date.now();
    await instance.dispose();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([
      ["gguf model", "timeout"],
      ["gguf engine", "done"]
    ]);
    expect(engine.llama.dispose).toHaveBeenCalledOnce();
  });

  it("aborts a load in progress and reports the wait", async () => {
    const engine = fakeEngine({
      loadModel: ({ loadSignal }) =>
        new Promise((_resolve, reject) => {
          loadSignal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
        })
    });
    const { instance, steps } = runtime(engine);
    const loading = instance.ensureLoaded().catch((error: unknown) => error);
    await vi.waitFor(() => expect(engine.llama.loadModel).toHaveBeenCalled());
    await instance.dispose();

    expect(await loading).toMatchObject({ name: "AbortError" });
    expect(steps.map((step) => [step.step, step.outcome])).toEqual([["gguf load", "done"]]);
    // The engine the aborted load had created was released by the load itself.
    expect(engine.llama.dispose).toHaveBeenCalledOnce();
  });

  it("leaves a load that ignores the abort after its bound and releases what it later builds", async () => {
    let finish!: (value: unknown) => void;
    const engine = fakeEngine({
      loadModel: () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    });
    const { instance, steps } = runtime(engine, 40);
    const loading = instance.ensureLoaded().catch((error: unknown) => error);
    await vi.waitFor(() => expect(engine.llama.loadModel).toHaveBeenCalled());
    await instance.dispose();

    expect(steps.map((step) => [step.step, step.outcome])).toEqual([["gguf load", "timeout"]]);
    // The load ends after the bound: it sees the abort, releases the model and the engine, and fails.
    finish(engine.model);
    expect(await loading).toMatchObject({ name: "AbortError" });
    expect(engine.model.dispose).toHaveBeenCalledOnce();
    expect(engine.llama.dispose).toHaveBeenCalledOnce();
    expect(instance.isLoaded()).toBe(false);
  });

  it("does nothing, and reports nothing, for a runtime that never loaded", async () => {
    const { instance, steps } = runtime(fakeEngine());
    await instance.dispose();
    expect(steps).toEqual([]);
  });
});
