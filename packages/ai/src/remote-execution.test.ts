import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiProviderError } from "./provider-error.js";
import {
  aiWorkloadClass,
  defaultAiRuntimeConfig,
  isLocalEndpoint,
  monotonicProgress,
  resolveAiRuntimeConfig,
  remoteCallReport,
  retryDelayMs,
  runRemoteCall,
  withCallReport,
  type AiRuntimeConfigInput,
  type RemoteAttempt
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
      stallMs: 20_000
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
            call.chunkReceived();
            call.outputStarted();
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
