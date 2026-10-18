import type { AiEmbedManyOptions, AiModelAdapter, AiTaskRequest } from "@app/ai";
import { describe, expect, it, vi } from "vitest";

import type { AiService } from "../ai-service.js";
import { injectedMarker, LocalFaultController } from "./soak-local-faults.js";
import { MemoryEventSink, type LocalFaultRecord } from "./soak-records.js";

const locals = (sink: MemoryEventSink) =>
  sink.events.filter((event): event is LocalFaultRecord => event.type === "local");

describe("the typing fault", () => {
  const typing = { operation: "relation_typing", stage: "relation_typing" };
  const run = vi.fn(
    async () => ({ output: "ok" }) as never
  ) as unknown as AiService["runDefaultTask"];

  it("fails every typing call that involves a poisoned source, permanently and marked injected", async () => {
    const sink = new MemoryEventSink();
    const faults = new LocalFaultController(sink);
    const wrapped = faults.withTypingFaults(run);
    faults.poison("source-bad");
    await expect(
      wrapped("structured-output", "prompt", {
        ...typing,
        sourceItemIds: ["source-ok", "source-bad"]
      })
    ).rejects.toMatchObject({
      transient: false,
      status: 422,
      message: expect.stringContaining(injectedMarker)
    });
    await expect(
      wrapped("structured-output", "prompt", {
        operation: "relation_typing_repair",
        sourceItemId: "source-bad"
      })
    ).rejects.toThrow(injectedMarker);
    expect(locals(sink).map((event) => [event.kind, event.detail.stage])).toEqual([
      ["typing_failure", "fired"],
      ["typing_failure", "fired"]
    ]);
  });

  it("leaves every other call alone, however it reaches the service", async () => {
    const sink = new MemoryEventSink();
    const faults = new LocalFaultController(sink);
    const wrapped = faults.withTypingFaults(run);
    faults.poison("source-bad");
    // Another source, another operation, and no context at all.
    await expect(
      wrapped("structured-output", "p", { ...typing, sourceItemIds: ["source-ok"] })
    ).resolves.toMatchObject({ output: "ok" });
    await expect(
      wrapped("summarization", "p", { operation: "summary", sourceItemIds: ["source-bad"] })
    ).resolves.toMatchObject({ output: "ok" });
    await expect(wrapped("embedding", "p")).resolves.toMatchObject({ output: "ok" });
    expect(locals(sink)).toEqual([]);
  });
});

/** A GGUF embedder that takes `batchMs` for a batch and stops when its signal aborts. */
function embedder(batchMs: number) {
  const calls: string[] = [];
  const adapter: AiModelAdapter = {
    describe: () => ({
      providerId: "local-gguf",
      modelId: "embedder",
      runtime: "local",
      capabilities: ["embedding", "offline"],
      parameterCapabilities: {},
      limits: {},
      requirements: {}
    }),
    canHandle: () => true,
    run: async (request: AiTaskRequest, signal?: AbortSignal) => {
      calls.push("run");
      await work(signal);
      return {
        taskType: request.taskType,
        output: [0],
        providerId: "local-gguf",
        modelId: "embedder",
        runtime: "local",
        durationMs: 1
      };
    },
    embedMany: async (texts: readonly string[], options: AiEmbedManyOptions = {}) => {
      calls.push(`embedMany ${texts.length}`);
      await work(options.signal);
      return {
        embeddings: texts.map(() => [0]),
        providerId: "local-gguf",
        modelId: "embedder",
        runtime: "local" as const,
        durationMs: 1
      };
    }
  };
  async function work(signal?: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, batchMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true }
      );
    });
  }
  return { adapter, calls };
}

describe("the forced GGUF abort", () => {
  it("aborts the next embedding batch in the middle of it, once", async () => {
    const sink = new MemoryEventSink();
    const faults = new LocalFaultController(sink, { ggufAbortAfterMs: 15 });
    const { adapter } = embedder(200);
    const wrapped = faults.adapterDecorator(adapter);
    faults.armGgufAbort();
    expect(faults.ggufAbortArmed).toBe(true);
    await expect(wrapped.embedMany!(["a", "b", "c"], {})).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(locals(sink)).toEqual([
      expect.objectContaining({ kind: "gguf_abort", detail: { stage: "fired", texts: 3 } })
    ]);
    // Disarmed after one batch: the next one runs to the end.
    expect(faults.ggufAbortArmed).toBe(false);
    const quick = faults.adapterDecorator(embedder(5).adapter);
    await expect(quick.embedMany!(["a"], {})).resolves.toMatchObject({ embeddings: [[0]] });
  });

  it("records a batch that finished before the abort, and an abort nobody used", async () => {
    const sink = new MemoryEventSink();
    let now = 0;
    const faults = new LocalFaultController(sink, {
      ggufAbortAfterMs: 500,
      armedForMs: 1_000,
      now: () => now
    });
    const wrapped = faults.adapterDecorator(embedder(5).adapter);
    faults.armGgufAbort();
    await wrapped.embedMany!(["a"], {});
    faults.armGgufAbort();
    now = 5_000;
    await wrapped.embedMany!(["a"], {});
    expect(locals(sink).map((event) => event.detail.stage)).toEqual(["finished_first", "expired"]);
  });

  it("composes with the caller's own signal and passes other adapters through untouched", async () => {
    const faults = new LocalFaultController(new MemoryEventSink(), { ggufAbortAfterMs: 1_000 });
    const { adapter } = embedder(200);
    faults.armGgufAbort();
    const caller = new AbortController();
    const pending = faults.adapterDecorator(adapter).embedMany!(["a"], { signal: caller.signal });
    caller.abort(new Error("caller left"));
    await expect(pending).rejects.toThrow("caller left");
    const remote: AiModelAdapter = {
      ...adapter,
      describe: () => ({ ...adapter.describe(), providerId: "openai-codex" })
    };
    expect(faults.adapterDecorator(remote)).toBe(remote);
  });
});
