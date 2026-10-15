import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { aiTaskRequestSchema } from "./contracts.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible.js";
import { AiProviderError } from "./provider-error.js";
import {
  aiWorkloadClass,
  remoteCallTask,
  requestWorkloadClass,
  defaultAiRuntimeConfig,
  isLocalEndpoint,
  monotonicProgress,
  resolveAiRuntimeConfig,
  remoteCallReport,
  retryDelayMs,
  runRemoteCall,
  withCallReport,
  type AiRuntimeConfigInput,
  type RemoteAttempt,
  type RemoteCallReport
} from "./remote-execution.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const transient = (retryAfterMs?: number) =>
  new AiProviderError("busy", {
    kind: "http",
    transient: true,
    status: 503,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  });
const permanent = () => new AiProviderError("bad", { kind: "http", transient: false, status: 400 });

function context(runtime: AiRuntimeConfigInput = {}, random = () => 0.5) {
  return { config: resolveAiRuntimeConfig(runtime), random };
}

describe("remote execution configuration", () => {
  it("ships the documented defaults and rejects values that cannot be deadlines", () => {
    expect(resolveAiRuntimeConfig().deadlines).toMatchObject({
      connectMs: 10_000,
      firstByteMs: 30_000,
      stallMs: 20_000,
      answerStartMs: 30_000,
      totalMs: { embed: 30_000, decide: 45_000 }
    });
    expect(
      resolveAiRuntimeConfig({ deadlines: { totalMs: { embed: 5_000 } } }).deadlines.totalMs
    ).toEqual({ ...defaultAiRuntimeConfig.deadlines.totalMs, embed: 5_000 });
    expect(() => resolveAiRuntimeConfig({ deadlines: { stallMs: 0 } })).toThrow();
    expect(() => resolveAiRuntimeConfig({ retry: { maxAttempts: 0 } })).toThrow();
  });

  it("gives each task class its own total deadline", () => {
    expect(aiWorkloadClass("embedding")).toBe("embed");
    expect(aiWorkloadClass("reranking")).toBe("decide");
    expect(aiWorkloadClass("summarization")).toBe("write-fast");
    expect(aiWorkloadClass("knowledge-graph-generation")).toBe("write-quality");
    expect(aiWorkloadClass("structured-output")).toBe("answer");
  });

  it("recognizes servers on this machine or its private network", () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://localhost:1234/v1",
      "http://[::1]:8000/v1",
      "http://192.168.1.20:8000/v1",
      "http://10.0.0.4/v1",
      "http://172.20.1.1/v1",
      "http://studio.local:11434/v1"
    ])
      expect(isLocalEndpoint(url)).toBe(true);
    for (const url of ["https://api.openai.com/v1", "http://172.32.0.1/v1", "not a url"])
      expect(isLocalEndpoint(url)).toBe(false);
  });

  it("recognizes private IPv6 addresses and the whole loopback block", () => {
    for (const url of [
      "http://127.1.2.3:8000/v1",
      "http://[fd12:3456:789a::1]:8000/v1",
      "http://[fc00::5]/v1",
      "http://[fe80::1ff:fe23:4567:890a]/v1",
      "http://[febf::1]/v1",
      "http://[::ffff:127.0.0.1]/v1",
      "http://[::ffff:192.168.1.5]/v1",
      "http://app.localhost:3000/v1"
    ])
      expect(isLocalEndpoint(url)).toBe(true);
    for (const url of [
      "http://[2001:db8::1]/v1",
      "http://[fec0::1]/v1",
      "http://[::]/v1",
      "http://[::ffff:8.8.8.8]/v1",
      "http://172.15.0.1/v1",
      "http://192.169.0.1/v1",
      "http://11.0.0.1/v1"
    ])
      expect(isLocalEndpoint(url)).toBe(false);
  });

  it("does not take a public host name for a private address because of how it starts", () => {
    for (const url of [
      "https://10.example.com/v1",
      "https://127.0.0.1.nip.io/v1",
      "https://192.168.acme.com/v1",
      "https://172.16.evil.test/v1",
      "https://fc00.example.com/v1",
      "https://fe80.example.com/v1",
      "https://localhost.example.com/v1",
      "https://notlocalhost/v1",
      "https://example.localhost.com/v1"
    ])
      expect(isLocalEndpoint(url)).toBe(false);
  });

  it("never reports progress that goes backwards", () => {
    const seen: number[] = [];
    const report = monotonicProgress((event: { progress: number }) => seen.push(event.progress));
    for (const progress of [0.2, 0.5, 0.1, 0.6]) report({ progress });
    expect(seen).toEqual([0.2, 0.5, 0.5, 0.6]);
  });
});

describe("retry delays", () => {
  const policy = { baseDelayMs: 500, maxDelayMs: 8_000 };

  it("uses exponential backoff with full jitter below a cap", () => {
    expect(retryDelayMs(0, policy, undefined, () => 0)).toBe(0);
    expect(retryDelayMs(0, policy, undefined, () => 0.999)).toBe(499);
    expect(retryDelayMs(2, policy, undefined, () => 0.5)).toBe(1_000);
    expect(retryDelayMs(10, policy, undefined, () => 0.999)).toBe(7_992);
  });

  it("never waits less than the provider asked for", () => {
    expect(retryDelayMs(0, policy, 3_000, () => 0.5)).toBe(3_000);
    expect(retryDelayMs(5, policy, 100, () => 0.5)).toBe(4_000);
  });
});

describe("runRemoteCall retries", () => {
  it("retries a transient failure with backoff and returns the later result", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue("done");
    const result = runRemoteCall(context(), { streaming: false }, attempt);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    // random 0.5: the first retry waits 250 ms, the second 500 ms.
    await vi.advanceTimersByTimeAsync(249);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toBe("done");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("is bounded by the configured number of attempts and throws the last failure", async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(transient());
    const result = runRemoteCall(
      context({ retry: { maxAttempts: 2 } }),
      { streaming: false },
      attempt
    );
    const settled = expect(result).rejects.toThrow("busy");
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a permanent provider error", permanent()],
    ["an unclassified error", new Error("knowledge_graph_output_invalid:schema_validation")]
  ])("does not retry %s", async (_name, error) => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    await expect(runRemoteCall(context(), { streaming: false }, attempt)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry a single-attempt call such as a connection test", async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(transient());
    await expect(
      runRemoteCall(context(), { streaming: false, retry: false }, attempt)
    ).rejects.toThrow("busy");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("waits at least as long as Retry-After", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transient(5_000))
      .mockResolvedValue("done");
    const result = runRemoteCall(context(), { streaming: false }, attempt);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("done");
  });

  it("waits inline for a Retry-After of at most five seconds and leaves a longer one to the job", async () => {
    expect(defaultAiRuntimeConfig.retry.maxInlineRetryAfterMs).toBe(5_000);
    const within = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transient(5_000))
      .mockResolvedValue("done");
    const waited = runRemoteCall(context(), { streaming: false }, within);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(waited).resolves.toBe("done");
    const beyond = transient(5_001);
    const refused = vi.fn<() => Promise<string>>().mockRejectedValue(beyond);
    await expect(runRemoteCall(context(), { streaming: false }, refused)).rejects.toBe(beyond);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("leaves a Retry-After longer than the inline limit to the caller", async () => {
    const error = transient(120_000);
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    await expect(runRemoteCall(context(), { streaming: false }, attempt)).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not start a retry that cannot finish inside the total deadline", async () => {
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(transient(2_000));
    const result = runRemoteCall(
      context({ deadlines: { totalMs: { embed: 1_500 } } }),
      { streaming: false, taskType: "embedding" },
      attempt
    );
    await expect(result).rejects.toThrow("busy");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("stops at once when the caller cancels, also while waiting to retry", async () => {
    const controller = new AbortController();
    const attempt = vi.fn<() => Promise<string>>().mockRejectedValue(transient());
    const result = runRemoteCall(
      context(),
      { streaming: false, signal: controller.signal },
      attempt
    );
    const settled = expect(result).rejects.toThrow("user canceled");
    await vi.advanceTimersByTimeAsync(10);
    expect(attempt).toHaveBeenCalledTimes(1);
    controller.abort(new Error("user canceled"));
    await settled;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("runRemoteCall deadlines", () => {
  const hang = () => new Promise<Response>(() => undefined);

  it("fails an unanswered connection with a transient timeout and retries it", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(hang);
    const result = runRemoteCall(
      context({ retry: { maxAttempts: 2 } }),
      { streaming: true },
      (call) => call.fetch(fetchImplementation, "https://example.test", {})
    );
    const settled = expect(result).rejects.toMatchObject({
      kind: "timeout",
      transient: true,
      message: "AI provider did not respond within 10000 ms."
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    // random 0.5: the retry starts 250 ms later and gets a fresh connect deadline.
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
  });

  it("waits as long as the total deadline for a non-streamed answer", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      () => new Promise((resolve) => setTimeout(() => resolve(new Response("{}")), 25_000))
    );
    const result = runRemoteCall(context(), { streaming: false, taskType: "embedding" }, (call) =>
      call.fetch(fetchImplementation, "https://example.test", {})
    );
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(result).resolves.toBeInstanceOf(Response);
  });

  it("applies the total deadline to the call and its retries together", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(hang);
    const result = runRemoteCall(
      context({ deadlines: { totalMs: { embed: 15_000 } } }),
      { streaming: false, taskType: "embedding" },
      (call) => call.fetch(fetchImplementation, "https://example.test", {})
    );
    const settled = expect(result).rejects.toMatchObject({
      kind: "timeout",
      transient: true,
      message: "AI provider request exceeded its 15000 ms deadline."
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it("does not apply connect or first-byte deadlines to servers on this machine", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      () => new Promise((resolve) => setTimeout(() => resolve(new Response("{}")), 60_000))
    );
    const result = runRemoteCall(
      { ...context(), local: true },
      { streaming: true, taskType: "reranking" },
      (call) => call.fetch(fetchImplementation, "http://127.0.0.1:11434", {})
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toBeInstanceOf(Response);
  });

  it("ends a read that ignores the abort signal when the stream stalls", async () => {
    const silent = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      }
    });
    const result = runRemoteCall(
      context({ retry: { maxAttempts: 1 } }),
      { streaming: true },
      async (call) => {
        const response = await call.fetch(
          async () => new Response(silent),
          "https://example.test",
          {}
        );
        const reader = response.body!.getReader();
        while (true) {
          const { done, value } = await call.guard(reader.read());
          if (value?.byteLength) call.chunkReceived();
          if (done) return;
        }
      }
    );
    const settled = expect(result).rejects.toMatchObject({
      kind: "stalled",
      transient: true,
      message: "AI provider stream stalled for 20000 ms."
    });
    await vi.advanceTimersByTimeAsync(19_999);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  describe("silence after the first chunk", () => {
    /** A stream that delivers one lifecycle chunk and then goes quiet, like a model that thinks. */
    const silentAfterLifecycle = (parameters: Record<string, unknown>, outputAt?: number) =>
      runRemoteCall(
        context({ retry: { maxAttempts: 1 } }),
        { streaming: true, taskType: "structured-output", parameters },
        async (call) => {
          const response = await call.fetch(
            async () => new Response(new ReadableStream<Uint8Array>({ start: () => undefined })),
            "https://example.test",
            {}
          );
          expect(response.ok).toBe(true);
          call.chunkReceived();
          if (outputAt !== undefined) {
            await call.guard(new Promise<void>((resolve) => setTimeout(resolve, outputAt)));
            call.progressed("answer");
          }
          return call.guard(new Promise<string>(() => undefined));
        }
      );

    it("stalls an ordinary request after the stall window", async () => {
      const result = silentAfterLifecycle({ reasoningLevel: "low" });
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider stream stalled for 20000 ms."
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await settled;
    });

    it("lets a high-reasoning request think in silence for the longer window until its first output", async () => {
      const result = silentAfterLifecycle({ reasoningLevel: "high" });
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider stream stalled for 120000 ms."
      });
      // One early chunk and then 60 s of silence is not a stall for a reasoning request.
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(59_999);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
    });

    it("applies the short stall window again once the answer text started", async () => {
      const result = silentAfterLifecycle({ reasoningLevel: "high" }, 50_000);
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider stream stalled for 20000 ms."
      });
      await vi.advanceTimersByTimeAsync(50_000);
      await vi.advanceTimersByTimeAsync(19_999);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
    });

    it("never lets the reasoning window be shorter than the stall window", async () => {
      const result = runRemoteCall(
        context({
          retry: { maxAttempts: 1 },
          deadlines: { stallMs: 200_000, firstByteHighReasoningMs: 120_000 }
        }),
        {
          streaming: true,
          taskType: "knowledge-graph-generation",
          parameters: { reasoningLevel: "xhigh" }
        },
        async (call) => {
          call.chunkReceived();
          return call.guard(new Promise<string>(() => undefined));
        }
      );
      const settled = expect(result).rejects.toMatchObject({
        message: "AI provider stream stalled for 200000 ms."
      });
      await vi.advanceTimersByTimeAsync(200_000);
      await settled;
    });
  });

  describe("progress, not bytes", () => {
    type Step = [at: number, progress?: "reasoning" | "answer"];
    interface Script {
      /** Chunks the attempt receives, at times counted from its start, and the progress each carries. */
      steps: Step[];
      /** The attempt returns at this time; without it the stream stays open and silent. */
      endAt?: number;
    }
    const play = (
      scripts: Script[],
      input: {
        runtime?: AiRuntimeConfigInput;
        parameters?: Record<string, unknown>;
        local?: boolean;
        taskType?: "reranking" | "structured-output";
      } = {}
    ) => {
      let started = 0;
      const result = runRemoteCall(
        {
          ...context({ ...input.runtime, retry: { maxAttempts: 2, ...input.runtime?.retry } }),
          ...(input.local ? { local: true } : {})
        },
        {
          streaming: true,
          taskType: input.taskType ?? "structured-output",
          parameters: input.parameters ?? {}
        },
        async (call) => {
          const script = scripts[Math.min(started++, scripts.length - 1)]!;
          await call.fetch(async () => new Response("{}"), "https://example.test", {});
          let now = 0;
          for (const [at, progress] of script.steps) {
            await call.guard(new Promise<void>((resolve) => setTimeout(resolve, at - now)));
            now = at;
            call.chunkReceived();
            if (progress) call.progressed(progress);
          }
          if (script.endAt === undefined) return call.guard(new Promise<string>(() => undefined));
          await call.guard(
            new Promise<void>((resolve) => setTimeout(resolve, script.endAt! - now))
          );
          return "done";
        }
      );
      return { result, attempts: () => started };
    };
    /** A chunk every five seconds that carries no progress: lifecycle events, keep-alives, empty data. */
    const heartbeats = (count = 12): Step[] => Array.from({ length: count }, (_, i) => [i * 5_000]);

    it("stalls a stream that sends only lifecycle events or keep-alives at the stall window", async () => {
      const { result, attempts } = play([{ steps: heartbeats() }], {
        runtime: { retry: { maxAttempts: 1 } }
      });
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        transient: true,
        message: "AI provider stream stalled for 20000 ms."
      });
      // Bytes kept arriving every five seconds; the stall still fires 20 s after the first one.
      await vi.advanceTimersByTimeAsync(20_000);
      await settled;
      expect(attempts()).toBe(1);
    });

    it("retries a stream that made no progress and returns the later answer", async () => {
      const { result, attempts } = play([
        { steps: heartbeats() },
        { steps: [[0], [8_000, "reasoning"], [12_000, "answer"]], endAt: 13_000 }
      ]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(attempts()).toBe(1);
      // random 0.5: the retry starts 250 ms after the stall.
      await vi.advanceTimersByTimeAsync(250);
      expect(attempts()).toBe(2);
      await vi.advanceTimersByTimeAsync(14_000);
      await expect(result).resolves.toBe("done");
    });

    it("lets steady reasoning text and then answer text keep the stream alive", async () => {
      const { result } = play(
        [
          {
            steps: [
              [0],
              [10_000, "reasoning"],
              [20_000, "reasoning"],
              [28_000, "answer"],
              [38_000, "answer"]
            ],
            endAt: 40_000
          }
        ],
        { runtime: { retry: { maxAttempts: 1 } } }
      );
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(result).resolves.toBe("done");
    });

    it("does not count reasoning text that arrives after the answer started", async () => {
      const { result } = play([{ steps: [[0], [1_000, "answer"], [15_000, "reasoning"]] }], {
        runtime: { retry: { maxAttempts: 1 } }
      });
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider stream stalled for 20000 ms."
      });
      // Armed by the answer text at 1 s, not by the reasoning text at 15 s.
      await vi.advanceTimersByTimeAsync(21_000);
      await settled;
    });

    it("bounds the time to the first answer text of an ordinary request, however much it reasons", async () => {
      const reasoning: Step[] = Array.from({ length: 6 }, (_, i) => [
        i * 5_000,
        "reasoning" as const
      ]);
      const { result, attempts } = play([{ steps: reasoning }], {
        runtime: { retry: { maxAttempts: 1 } }
      });
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        transient: true,
        message: "AI provider produced no answer text within 30000 ms."
      });
      // The stall deadline is re-armed by every reasoning text; the no-answer bound is not.
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;
      expect(attempts()).toBe(1);
    });

    it("retries a request whose answer did not start in time inside the total deadline", async () => {
      const reasoning: Step[] = Array.from({ length: 12 }, (_, i) => [
        i * 5_000,
        "reasoning" as const
      ]);
      const { result, attempts } = play([
        { steps: reasoning },
        { steps: [[0], [2_000, "answer"]], endAt: 3_000 }
      ]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts()).toBe(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(attempts()).toBe(2);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(result).resolves.toBe("done");
    });

    it("keeps the longer pre-answer window of a high-reasoning request, restarted by its reasoning text", async () => {
      const { result } = play(
        [
          {
            steps: [[0], [100_000, "reasoning"], [200_000, "reasoning"], [250_000, "answer"]],
            endAt: 251_000
          }
        ],
        {
          runtime: { retry: { maxAttempts: 1 }, deadlines: { totalMs: { answer: 600_000 } } },
          parameters: { reasoningLevel: "high" }
        }
      );
      await vi.advanceTimersByTimeAsync(251_000);
      await expect(result).resolves.toBe("done");
    });

    it("does not let lifecycle events stretch the long window of a high-reasoning request", async () => {
      const { result } = play([{ steps: [[0], [60_000], [110_000]] }], {
        runtime: { retry: { maxAttempts: 1 } },
        parameters: { reasoningLevel: "high" }
      });
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider stream stalled for 120000 ms."
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await settled;
    });

    it("does not bound the time to the first answer text of a server on this machine", async () => {
      const reasoning: Step[] = Array.from({ length: 10 }, (_, i) => [
        i * 10_000,
        "reasoning" as const
      ]);
      const { result } = play([{ steps: [...reasoning, [100_000, "answer"]], endAt: 100_500 }], {
        runtime: { retry: { maxAttempts: 1 } },
        local: true,
        taskType: "reranking"
      });
      await vi.advanceTimersByTimeAsync(100_500);
      await expect(result).resolves.toBe("done");
    });

    it("ends a decide call that never makes progress at its 45 s total deadline after bounded retries", async () => {
      const { result, attempts } = play([{ steps: heartbeats(20) }], {
        runtime: { retry: { maxAttempts: 3 } },
        taskType: "reranking"
      });
      const settled = expect(result).rejects.toMatchObject({
        kind: "timeout",
        message: "AI provider request exceeded its 45000 ms deadline."
      });
      await vi.advanceTimersByTimeAsync(45_000);
      await settled;
      // Stalled at 30 s, the answer-start bound; the second attempt was cut by the total deadline.
      expect(attempts()).toBe(2);
    });

    describe("a decide call, which asks for no reasoning summary and so thinks in silence", () => {
      it("may stay silent until the answer-start bound, past the stall window", async () => {
        const { result } = play([{ steps: [[0], [25_000, "answer"]], endAt: 26_000 }], {
          runtime: { retry: { maxAttempts: 1 } },
          taskType: "reranking"
        });
        await vi.advanceTimersByTimeAsync(26_000);
        await expect(result).resolves.toBe("done");
      });

      it("is cut at the answer-start bound when no answer text arrives", async () => {
        const { result } = play([{ steps: heartbeats(20) }], {
          runtime: { retry: { maxAttempts: 1 } },
          taskType: "reranking"
        });
        let ended = false;
        const settled = expect(result).rejects.toMatchObject({ kind: "stalled", transient: true });
        void result.catch(() => {
          ended = true;
        });
        await vi.advanceTimersByTimeAsync(29_999);
        expect(ended).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await settled;
      });

      it("takes the bound from the configured answer-start window", async () => {
        const shorter = play([{ steps: [[0]] }], {
          runtime: { retry: { maxAttempts: 1 }, deadlines: { answerStartMs: 12_000 } },
          taskType: "reranking"
        });
        const shorterSettled = expect(shorter.result).rejects.toMatchObject({
          message: "AI provider produced no answer text within 12000 ms."
        });
        await vi.advanceTimersByTimeAsync(12_000);
        await shorterSettled;
        const longer = play([{ steps: [[0]] }], {
          runtime: { retry: { maxAttempts: 1 }, deadlines: { answerStartMs: 40_000 } },
          taskType: "reranking"
        });
        const longerSettled = expect(longer.result).rejects.toMatchObject({
          message: "AI provider stream stalled for 40000 ms."
        });
        await vi.advanceTimersByTimeAsync(40_000);
        await longerSettled;
      });

      it("keeps the stall window for the answer text once it started", async () => {
        const { result } = play([{ steps: [[0], [10_000, "answer"]] }], {
          runtime: { retry: { maxAttempts: 1 } },
          taskType: "reranking"
        });
        const settled = expect(result).rejects.toMatchObject({
          message: "AI provider stream stalled for 20000 ms."
        });
        // 10 s of silence, then the answer text, then 20 s of silence: not the 30 s of the first phase.
        await vi.advanceTimersByTimeAsync(30_000);
        await settled;
      });

      it("does not change the window of the other task classes or of a server on this machine", async () => {
        const write = play([{ steps: [[0]] }], {
          runtime: { retry: { maxAttempts: 1 } },
          taskType: "structured-output"
        });
        const writeSettled = expect(write.result).rejects.toMatchObject({
          message: "AI provider stream stalled for 20000 ms."
        });
        await vi.advanceTimersByTimeAsync(20_000);
        await writeSettled;
        const local = play([{ steps: [[0]] }], {
          runtime: { retry: { maxAttempts: 1 } },
          taskType: "reranking",
          local: true
        });
        const localSettled = expect(local.result).rejects.toMatchObject({
          message: "AI provider stream stalled for 20000 ms."
        });
        await vi.advanceTimersByTimeAsync(20_000);
        await localSettled;
      });
    });
  });

  it("allows a high-reasoning request to stay silent longer before its first byte", async () => {
    const respond = (delay: number) =>
      vi.fn<typeof fetch>(
        () => new Promise((resolve) => setTimeout(() => resolve(new Response("{}")), delay))
      );
    const first = (parameters: Record<string, unknown>) =>
      runRemoteCall(
        context({ retry: { maxAttempts: 1 } }),
        { streaming: true, taskType: "structured-output", parameters },
        async (call) => {
          await call.fetch(respond(1), "https://example.test", {});
          return call.guard(new Promise<void>((resolve) => setTimeout(resolve, 60_000)));
        }
      );
    // Never calls chunkReceived: the stall deadline stays the first-byte deadline.
    const normal = expect(first({ reasoningLevel: "low" })).rejects.toMatchObject({
      message: "AI provider sent no data within 30000 ms."
    });
    await vi.advanceTimersByTimeAsync(31_000);
    await normal;
    const high = first({ reasoningLevel: "high" });
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(high).resolves.toBeUndefined();
  });
});

describe("a workload class the caller states", () => {
  const hang = () => new Promise<Response>(() => undefined);

  it("travels on the request and replaces the task type's class", () => {
    const request = aiTaskRequestSchema.parse({
      taskType: "structured-output",
      input: "Name these topics.",
      workloadClass: "write-fast",
      operation: "topic_name"
    });
    expect(requestWorkloadClass(request)).toBe("write-fast");
    expect(requestWorkloadClass({ taskType: "structured-output" })).toBe("answer");
    // Note matching states no class: its derived class only sets the decide deadlines.
    expect(requestWorkloadClass({ taskType: "reranking" })).toBe("decide");
    expect(remoteCallTask(request)).toEqual({
      taskType: "structured-output",
      parameters: {},
      workloadClass: "write-fast"
    });
    expect(() =>
      aiTaskRequestSchema.parse({ taskType: "summarization", input: "", workloadClass: "fast" })
    ).toThrow();
  });

  it("sets the total deadline of the call", async () => {
    const runtime = context({ deadlines: { totalMs: { "write-fast": 15_000, answer: 60_000 } } });
    const stated = runRemoteCall(
      runtime,
      { streaming: false, taskType: "structured-output", workloadClass: "write-fast" },
      (call) => call.fetch(vi.fn<typeof fetch>(hang), "https://example.test", {})
    );
    const derived = runRemoteCall(
      runtime,
      { streaming: false, taskType: "structured-output" },
      (call) => call.fetch(vi.fn<typeof fetch>(hang), "https://example.test", {})
    );
    let derivedEnded = false;
    void derived.catch(() => {
      derivedEnded = true;
    });
    const settled = expect(stated).rejects.toMatchObject({
      kind: "timeout",
      message: "AI provider request exceeded its 15000 ms deadline."
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    expect(derivedEnded).toBe(false);
    const derivedSettled = expect(derived).rejects.toMatchObject({
      message: "AI provider request exceeded its 60000 ms deadline."
    });
    await vi.advanceTimersByTimeAsync(45_000);
    await derivedSettled;
  });

  it("reaches the remote deadline through an adapter", async () => {
    const adapter = new OpenAiCompatibleAdapter({
      apiKey: "test-key",
      modelId: "writer",
      capabilities: ["structured-output"],
      baseUrl: "https://example.test/v1",
      fetch: vi.fn<typeof fetch>(hang),
      runtime: { deadlines: { totalMs: { "write-fast": 15_000 } }, retry: { maxAttempts: 1 } }
    });
    const result = adapter.run({
      taskType: "structured-output",
      input: "Name these topics.",
      requiredCapabilities: [],
      parameters: {},
      metadata: {},
      workloadClass: "write-fast"
    });
    const settled = expect(result).rejects.toMatchObject({
      message: "AI provider request exceeded its 15000 ms deadline."
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
  });
});

describe("what a call cost beyond its answer", () => {
  it("reports the attempts it made and the tokens its failed attempts used", async () => {
    const reported: Array<{ attempts: number; failedUsage: unknown }> = [];
    const attempt = vi
      .fn<(call: RemoteAttempt) => Promise<string>>()
      .mockImplementationOnce(async (call) => {
        call.reportUsage({ inputTokens: 100, outputTokens: 5 });
        call.reportUsage({ inputTokens: 100, outputTokens: 20 });
        throw transient();
      })
      .mockImplementationOnce(async (call) => {
        call.reportUsage({ inputTokens: 100 });
        throw transient();
      })
      .mockImplementation(async (call) => {
        call.reportUsage({ inputTokens: 100, outputTokens: 30 });
        return "done";
      });
    const result = runRemoteCall(
      context(),
      { streaming: false, report: (report) => reported.push(report) },
      attempt
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe("done");
    // The cumulative report of an attempt replaces its earlier ones; the answer's own usage is not
    // counted as failed.
    expect(reported).toEqual([
      { attempts: 3, failedUsage: { inputTokens: 200, outputTokens: 20 } }
    ]);
  });

  it("attaches the report to the error of a failed call", async () => {
    const error = permanent();
    const failure = runRemoteCall(context(), { streaming: false }, async () => {
      throw error;
    });
    await expect(failure).rejects.toBe(error);
    expect(remoteCallReport(error)).toEqual({ attempts: 1, failedUsage: {} });
    expect(remoteCallReport(new Error("other"))).toBeUndefined();
    expect(remoteCallReport("text")).toBeUndefined();
  });

  it("counts the requests an attempt sent, not only the attempts", async () => {
    const lean = { include: [] as string[], shape: "lean" };
    const full = { include: ["reasoning.encrypted_content"], shape: "full" };
    const fetchOk = async () => new Response("{}");
    const reported: RemoteCallReport[] = [];
    const attempt = vi
      .fn<(call: RemoteAttempt) => Promise<string>>()
      // Two requests inside one attempt (a fallback to another shape), then a transient failure.
      .mockImplementationOnce(async (call) => {
        await call.fetch(fetchOk, "https://example.test", {}, lean);
        await call.fetch(fetchOk, "https://example.test", {}, full);
        throw transient();
      })
      // An attempt that failed before it reached the network still counts as one.
      .mockImplementationOnce(async () => {
        throw transient();
      })
      .mockImplementation(async (call) => {
        await call.fetch(fetchOk, "https://example.test", {}, full);
        return "done";
      });
    const result = runRemoteCall(
      context(),
      { streaming: false, report: (report) => reported.push(report) },
      attempt
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(result).resolves.toBe("done");
    expect(reported).toEqual([{ attempts: 4, failedUsage: {}, requestOptions: full }]);
  });

  it("attaches the request count and the last wire options to the error of a failed call", async () => {
    const lean = { reasoningSummary: null };
    const error = permanent();
    const failure = runRemoteCall(context(), { streaming: false }, async (call) => {
      await call.fetch(async () => new Response("{}"), "https://example.test", {}, lean);
      await call.fetch(async () => new Response("{}"), "https://example.test", {});
      throw error;
    });
    await expect(failure).rejects.toBe(error);
    // The second request stated no options, so those of the last one that did are kept.
    expect(remoteCallReport(error)).toEqual({
      attempts: 2,
      failedUsage: {},
      requestOptions: lean
    });
    // A call whose adapter states no wire options has none.
    const plain = permanent();
    await expect(
      runRemoteCall(context(), { streaming: false }, async (call) => {
        await call.fetch(async () => new Response("{}"), "https://example.test", {});
        throw plain;
      })
    ).rejects.toBe(plain);
    expect(remoteCallReport(plain)).toEqual({ attempts: 1, failedUsage: {} });
    expect(remoteCallReport(plain)).not.toHaveProperty("requestOptions");
  });

  it("keeps the usage of every attempt of a call that never succeeded", async () => {
    const last = transient();
    const attempt = vi.fn(async (call: RemoteAttempt) => {
      call.reportUsage({ inputTokens: 10 });
      throw last;
    });
    const result = runRemoteCall(
      context({ retry: { maxAttempts: 2 } }),
      { streaming: false },
      attempt
    );
    const settled = expect(result).rejects.toBe(last);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    expect(remoteCallReport(last)).toEqual({ attempts: 2, failedUsage: { inputTokens: 20 } });
  });

  it("adds failed-attempt tokens to the totals only where the answer's own count is known", () => {
    const base = {
      taskType: "summarization" as const,
      output: "x",
      providerId: "p",
      modelId: "m",
      runtime: "remote" as const,
      durationMs: 1
    };
    const report = { attempts: 3, failedUsage: { inputTokens: 200, outputTokens: 20 } };
    expect(
      withCallReport(
        {
          ...base,
          inputTokens: 100,
          outputTokens: 30,
          tokenUsage: { inputTokens: 100, outputTokens: 30, totalTokens: 130, "provider.x": 7 }
        },
        report
      )
    ).toEqual({
      ...base,
      attempts: 3,
      inputTokens: 300,
      outputTokens: 50,
      tokenUsage: { inputTokens: 300, outputTokens: 50, totalTokens: 350, "provider.x": 7 },
      retriedUsage: { inputTokens: 200, outputTokens: 20 }
    });
    // The provider did not report the answer's usage: unknown stays unknown.
    expect(withCallReport({ ...base, tokenUsage: {} }, report)).toEqual({
      ...base,
      attempts: 3,
      tokenUsage: {},
      retriedUsage: { inputTokens: 200, outputTokens: 20 }
    });
    expect(withCallReport(base, { attempts: 1, failedUsage: {} })).toEqual({
      ...base,
      attempts: 1
    });
    expect(withCallReport(base, undefined)).toBe(base);
  });
});
