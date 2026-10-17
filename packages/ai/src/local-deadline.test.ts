import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeLlamaCppAdapter, MlxAdapter, localRequestDeadlineMs } from "./local-adapters.js";
import { isDeadlineFailure, LocalDeadlineError, runWithLocalDeadline } from "./local-deadline.js";
import { MlxRerankerAdapter, NodeLlamaRankerAdapter } from "./local-ranker-adapters.js";
import { MlxHelperError, MlxHelperHost } from "./mlx-helper-host.js";
import { isTransientAiError } from "./provider-error.js";
import { defaultAiLaneRuntimeConfig, resolveAiLaneRuntimeConfig } from "./runtime-config.js";

const deadlines = resolveAiLaneRuntimeConfig(
  { localDeadlines: { totalMs: { "write-fast": 1_000, embed: 500, decide: 300 }, graceMs: 2_000 } },
  { environment: {} }
).localDeadlines;

const generation = {
  taskType: "summarization" as const,
  input: "Summarize this.",
  requiredCapabilities: ["text-generation" as const],
  parameters: {},
  metadata: {}
};

/** A native call that stops when its signal aborts, or never when `ignoreAbort` is set. */
function nativeCall(options: { ignoreAbort?: boolean } = {}) {
  const ended = Promise.withResolvers<{ output: string; durationMs: number }>();
  const execute = vi.fn(async (input: { signal?: AbortSignal }) => {
    if (!options.ignoreAbort)
      input.signal?.addEventListener(
        "abort",
        () => ended.reject(new DOMException("Local inference canceled.", "AbortError")),
        { once: true }
      );
    return ended.promise;
  });
  return { execute, end: () => ended.resolve({ output: "late", durationMs: 1 }) };
}

function gguf(execute: ReturnType<typeof nativeCall>["execute"]) {
  return new NodeLlamaCppAdapter(
    {
      modelId: "writer",
      modelPath: "/models/writer.gguf",
      capabilities: ["text-generation", "offline"],
      localDeadlines: deadlines
    },
    execute
  );
}

describe("local deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("states a deadline per workload class, from the class the request states or its task type", () => {
    expect(localRequestDeadlineMs({ taskType: "embedding" })).toBe(30_000);
    expect(localRequestDeadlineMs({ taskType: "reranking" })).toBe(10_000);
    expect(localRequestDeadlineMs({ taskType: "summarization" })).toBe(180_000);
    expect(localRequestDeadlineMs({ taskType: "knowledge-graph-generation" })).toBe(900_000);
    expect(localRequestDeadlineMs({ taskType: "text-generation" })).toBe(300_000);
    expect(
      localRequestDeadlineMs({ taskType: "structured-output", workloadClass: "write-fast" })
    ).toBe(180_000);
    expect(defaultAiLaneRuntimeConfig.localDeadlines).toMatchObject({
      tokenStallMs: 60_000,
      graceMs: 2_000
    });
  });

  it("aborts a GGUF generation at its class deadline and keeps the model loaded", async () => {
    const native = nativeCall();
    const adapter = gguf(native.execute);
    const dispose = vi.spyOn(adapter, "dispose");
    const result = adapter.run(generation);
    const failed = expect(result).rejects.toMatchObject({
      name: "LocalDeadlineError",
      code: "deadline",
      deadlineMs: 1_000
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(native.execute.mock.calls[0]![0].signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    // Cancelling stops the sequence; the model stays resident for the next call.
    expect(dispose).not.toHaveBeenCalled();
    expect(adapter.wedged).toBe(false);
  });

  it("abandons a GGUF call that ignores its deadline 2 s later and stays wedged until it ended", async () => {
    const native = nativeCall({ ignoreAbort: true });
    const adapter = gguf(native.execute);
    const dispose = vi.spyOn(adapter, "dispose").mockResolvedValue();
    let settledAt: number | null = null;
    const failure: Promise<LocalDeadlineError> = adapter.run(generation).then(
      () => {
        throw new Error("expected the deadline to end the call");
      },
      (error: unknown) => {
        settledAt = Date.now();
        return error as LocalDeadlineError;
      }
    );
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settledAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const error = await failure;
    expect(settledAt! - startedAt).toBe(3_000);
    expect(error).toMatchObject({ code: "aborted_deadline", deadlineMs: 1_000 });
    expect(error.recovery).toBeInstanceOf(Promise);
    expect(isTransientAiError(error)).toBe(true);
    expect(adapter.wedged).toBe(true);
    // New calls fail visibly while the abandoned one still runs.
    await expect(adapter.run(generation)).rejects.toMatchObject({ code: "wedged" });
    expect(dispose).not.toHaveBeenCalled();
    native.end();
    await error.recovery;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(adapter.wedged).toBe(false);
  });

  it("ends a streamed GGUF generation that stops producing tokens for the stall bound", async () => {
    const stalled = resolveAiLaneRuntimeConfig(
      { localDeadlines: { tokenStallMs: 200, totalMs: { "write-fast": 10_000 } } },
      { environment: {} }
    ).localDeadlines;
    const adapter = new NodeLlamaCppAdapter(
      {
        modelId: "writer",
        modelPath: "/models/writer.gguf",
        capabilities: ["text-generation", "offline", "streaming"],
        localDeadlines: stalled
      },
      async (input) => {
        input.onProgress?.({ progress: 0.1 });
        await new Promise((resolve) => setTimeout(resolve, 150));
        input.onProgress?.({ progress: 0.2 });
        return new Promise((_resolve, reject) =>
          input.signal?.addEventListener("abort", () => reject(input.signal!.reason), {
            once: true
          })
        );
      }
    );
    const result = adapter.runStreaming(generation, undefined, () => undefined);
    const failed = expect(result).rejects.toMatchObject({ code: "stalled" });
    await vi.advanceTimersByTimeAsync(349);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
  });

  it("keeps caller cancellation apart from deadlines", async () => {
    const native = nativeCall();
    const adapter = gguf(native.execute);
    const controller = new AbortController();
    const result = adapter.run(generation, controller.signal);
    controller.abort(new Error("user canceled"));
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("gives a GGUF rank call the decide deadline from its own start, not from its turn", async () => {
    const runtime = {
      isLoaded: () => true,
      load: async () => undefined,
      rank: vi.fn(
        (input: { documents: readonly string[]; signal?: AbortSignal }) =>
          new Promise<{ probabilities: number[]; tokenCounts: number[]; truncated: boolean[] }>(
            (resolve, reject) => {
              const timer = setTimeout(
                () =>
                  resolve({
                    probabilities: input.documents.map(() => 0.5),
                    tokenCounts: input.documents.map(() => 10),
                    truncated: input.documents.map(() => false)
                  }),
                250
              );
              input.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(input.signal!.reason);
              });
            }
          )
      ),
      runtimeBuild: async () => "build",
      dispose: async () => undefined
    };
    const adapter = new NodeLlamaRankerAdapter(
      {
        modelId: "ranker",
        modelPath: "/models/ranker.gguf",
        capabilities: ["reranking", "offline"],
        localDeadlines: deadlines
      },
      runtime
    );
    const request = {
      taskType: "reranking" as const,
      input: { instruction: "Judge.", query: "q", documents: ["a", "b"] },
      requiredCapabilities: ["reranking" as const],
      parameters: {},
      metadata: {},
      workloadClass: "decide" as const
    };
    // Two calls of 250 ms each: the second waits its turn and still meets its 300 ms deadline.
    const first = adapter.run(request);
    const second = adapter.run(request);
    await vi.advanceTimersByTimeAsync(500);
    await expect(first).resolves.toMatchObject({ taskType: "reranking" });
    await expect(second).resolves.toMatchObject({ taskType: "reranking" });
  });

  it("asks the MLX helper for the class deadline instead of one bound for every class", async () => {
    const execute = vi.fn(async (input: { timeoutMs: number }) => ({
      output: `ok ${input.timeoutMs}`,
      durationMs: 1
    }));
    const writer = new MlxAdapter(
      {
        modelId: "writer",
        modelPath: "/models/writer",
        helperPath: "/helper",
        capabilities: ["text-generation", "offline"],
        localDeadlines: deadlines
      },
      execute
    );
    await writer.run(generation);
    await writer.run({ ...generation, taskType: "text-generation", workloadClass: "decide" });
    expect(execute.mock.calls.map(([input]) => input.timeoutMs)).toEqual([1_000, 300]);

    const score = vi.fn(async (_input: unknown, options: { timeoutMs?: number }) => {
      throw new MlxHelperError(
        "errors.localModels.runtimeFailed",
        "timeout",
        true,
        String(options.timeoutMs)
      );
    });
    const ranker = new MlxRerankerAdapter(
      {
        modelId: "ranker",
        modelPath: "/models/ranker",
        helperPath: "/helper",
        capabilities: ["reranking", "offline"],
        localDeadlines: deadlines
      },
      score
    );
    const failure = await ranker
      .run({
        taskType: "reranking",
        input: { instruction: "Judge.", query: "q", documents: ["a"] },
        requiredCapabilities: ["reranking"],
        parameters: {},
        metadata: {}
      })
      .catch((error: unknown) => error);
    expect(score.mock.calls[0]![1]).toMatchObject({ timeoutMs: 300 });
    // The helper's own timeout (it kills the helper until T61's cancel) is a deadline failure.
    expect(isDeadlineFailure(failure)).toBe(true);
  });

  it("settles every bounded call by its deadline plus the grace period (S5)", async () => {
    const outcomes: string[] = [];
    const calls = [0, 500, 1_500, 4_000].map((stopsAfterAbort) =>
      runWithLocalDeadline({
        deadlineMs: 1_000,
        graceMs: 2_000,
        run: (signal) =>
          new Promise<string>((resolve) => {
            signal.addEventListener("abort", () =>
              setTimeout(() => resolve("stopped"), stopsAfterAbort)
            );
          }),
        wedged: async () => undefined
      }).catch((error: LocalDeadlineError) => {
        outcomes.push(`${stopsAfterAbort}:${error.code}:${Date.now()}`);
      })
    );
    const startedAt = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(calls);
    expect(outcomes.map((entry) => entry.replace(/:\d+$/, ""))).toEqual([
      "0:deadline",
      "500:deadline",
      "1500:deadline",
      "4000:aborted_deadline"
    ]);
    for (const entry of outcomes)
      expect(Number(entry.split(":")[2]) - startedAt).toBeLessThanOrEqual(3_000);
  });
});

describe("the MLX helper under a class deadline", () => {
  it("kills a helper that does not answer within the class deadline and serves the next call", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mlx-deadline-"));
    const helperPath = join(root, "fake-helper.mjs");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.prompt === "hang") continue;
  process.stdout.write(JSON.stringify({
    protocolVersion: 1, requestId: request.requestId, kind: "result", ok: true,
    output: "answered", durationMs: 1
  }) + "\\n");
}
`
    );
    await chmod(helperPath, 0o755);
    const host = new MlxHelperHost({ helperPath });
    const adapter = new MlxAdapter({
      modelId: "writer",
      modelPath: "/models/writer",
      helperPath,
      host,
      capabilities: ["text-generation", "offline"],
      localDeadlines: resolveAiLaneRuntimeConfig(
        { localDeadlines: { totalMs: { answer: 300 } } },
        { environment: {} }
      ).localDeadlines
    });
    const request = {
      taskType: "text-generation" as const,
      input: "hang",
      requiredCapabilities: ["text-generation" as const],
      parameters: {},
      metadata: {}
    };
    const startedAt = Date.now();
    const failure = await adapter.run(request).catch((error: unknown) => error);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(failure).toMatchObject({ name: "MlxHelperError", code: "timeout" });
    expect(isDeadlineFailure(failure)).toBe(true);
    await expect(adapter.run({ ...request, input: "hello" })).resolves.toMatchObject({
      output: "answered"
    });
    // Until the helper can cancel (T61), the deadline kills it and the next call starts a new one.
    expect(host.spawnCount).toBe(2);
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  });
});
