import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runsStreaming, type AiModelAdapter, type AiTaskRequest } from "./contracts.js";
import { GoogleGeminiAdapter } from "./google.js";
import { OpenAiCodexAdapter } from "./openai-codex.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible.js";
import { remoteCallReport, type AiRuntimeConfigInput } from "./remote-execution.js";

const encoder = new TextEncoder();
const request = (parameters: Record<string, unknown> = {}): AiTaskRequest => ({
  taskType: "text-generation",
  input: "hello",
  requiredCapabilities: [],
  parameters,
  metadata: {}
});
const events = (...payloads: unknown[]) =>
  payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
const streamHeaders = { "content-type": "text/event-stream" };
const sse = (body: string) => new Response(body, { status: 200, headers: streamHeaders });

/**
 * A stream that delivers each chunk at its time (fake timers) and then, unless `endAt` is given,
 * neither ends nor fails.
 */
function scheduled(chunks: Array<[atMs: number, body: string]>, endAt?: number): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const [at, body] of chunks)
          setTimeout(() => controller.enqueue(encoder.encode(body)), at);
        if (endAt !== undefined) setTimeout(() => controller.close(), endAt);
      }
    }),
    { status: 200, headers: streamHeaders }
  );
}

const runtime = (input: AiRuntimeConfigInput = {}): AiRuntimeConfigInput => ({
  ...input,
  retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 400, ...input.retry }
});
const codex = (fetch: typeof globalThis.fetch, config?: AiRuntimeConfigInput) =>
  new OpenAiCodexAdapter({
    accessToken: "oauth-access-token",
    accountId: "account-1",
    modelId: "gpt-test",
    capabilities: ["text-generation"],
    fetch,
    runtime: runtime(config),
    random: () => 0.5
  });
const google = (fetch: typeof globalThis.fetch, config?: AiRuntimeConfigInput) =>
  new GoogleGeminiAdapter({
    apiKey: "google-secret-key",
    modelId: "gemini-test",
    capabilities: ["text-generation"],
    fetch,
    runtime: runtime(config),
    random: () => 0.5
  });
const openAi = (fetch: typeof globalThis.fetch, baseUrl: string, config?: AiRuntimeConfigInput) =>
  new OpenAiCompatibleAdapter({
    baseUrl,
    apiKey: "secret-key",
    modelId: "model",
    capabilities: ["text-generation"],
    fetch,
    runtime: runtime(config),
    random: () => 0.5
  });
const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;

describe("remote generation always streams", () => {
  const adapter = (
    providerId: string,
    runtimeKind: "remote" | "local",
    capabilities: string[],
    streams = true
  ): AiModelAdapter =>
    ({
      describe: () => ({ providerId, modelId: "m", runtime: runtimeKind, capabilities }),
      canHandle: () => true,
      run: async () => ({}),
      ...(streams ? { runStreaming: async () => ({}) } : {})
    }) as unknown as AiModelAdapter;

  it("streams every remote generation, whatever capabilities are stored for the model", () => {
    for (const taskType of ["summarization", "reranking", "structured-output"] as const)
      expect(runsStreaming(adapter("google", "remote", ["text-generation"]), taskType)).toBe(true);
    expect(runsStreaming(adapter("google", "remote", ["embedding"]), "embedding")).toBe(false);
  });

  it("leaves local adapters to their declared capabilities and needs a streaming method", () => {
    expect(runsStreaming(adapter("mlx", "local", ["text-generation"]), "summarization")).toBe(
      false
    );
    expect(runsStreaming(adapter("mlx", "local", ["streaming"]), "summarization")).toBe(true);
    expect(runsStreaming(adapter("x", "remote", [], false), "summarization")).toBe(false);
  });

  it("is what the real remote adapters offer", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const created of [openAi(fetch, "https://a.example.test/v1"), google(fetch), codex(fetch)])
      expect(runsStreaming(created, "summarization")).toBe(true);
  });
});

describe("watchdogs of streamed calls", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const created = events({ type: "response.created" });
  const answer = events(
    { type: "response.output_text.delta", delta: "done" },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }
  );

  it("lets a high-reasoning ChatGPT/Codex call think in silence after its first lifecycle event", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      scheduled(
        [
          [0, created],
          [60_000, answer]
        ],
        60_000
      )
    );
    const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
      request({ reasoningLevel: "high" })
    );
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(result).resolves.toMatchObject({ output: "done", attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stalls a high-reasoning call that stays silent beyond the reasoning window", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => scheduled([[0, created]]));
    const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
      request({ reasoningLevel: "high" })
    );
    const settled = expect(result).rejects.toMatchObject({
      kind: "stalled",
      message: "AI provider stream stalled for 120000 ms."
    });
    await vi.advanceTimersByTimeAsync(119_999);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
  });

  it("still stalls an ordinary ChatGPT/Codex call after the short window", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => scheduled([[0, created]]));
    const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
      request({ reasoningLevel: "low" })
    );
    const settled = expect(result).rejects.toMatchObject({ kind: "stalled" });
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
  });

  it("applies the short window to a high-reasoning call once its answer started", async () => {
    const first = events({ type: "response.output_text.delta", delta: "par" });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      scheduled([
        [0, created],
        [50_000, first]
      ])
    );
    const result = codex(fetch, { retry: { maxAttempts: 1 } }).run(
      request({ reasoningLevel: "high" })
    );
    const settled = expect(result).rejects.toMatchObject({
      kind: "stalled",
      message: "AI provider stream stalled for 20000 ms."
    });
    await vi.advanceTimersByTimeAsync(70_000);
    await settled;
  });
});

describe("streaming usage for OpenAI-compatible servers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const deltas = (content: string) =>
    sse(events({ choices: [{ delta: { content } }] }) + "data: [DONE]\n\n");

  it("streams with usage, and falls back once to a stream without it when the server rejects stream_options", async () => {
    const baseUrl = "https://strict-server.example.test/v1";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (_url, init) =>
        JSON.parse(String(init?.body)).stream_options
          ? new Response("Unknown parameter: 'stream_options'.", { status: 400 })
          : deltas("answer")
      );
    const result = await openAi(fetch, baseUrl).runStreaming(request(), undefined, () => undefined);
    expect(result.output).toBe("answer");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetch.mock.calls[0])).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    });
    expect(bodyOf(fetch.mock.calls[1])).not.toHaveProperty("stream_options");
    expect(bodyOf(fetch.mock.calls[1])).toMatchObject({ stream: true });
    // The next call to the same server does not ask for usage again.
    await openAi(fetch, baseUrl).runStreaming(request(), undefined, () => undefined);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetch.mock.calls[2])).not.toHaveProperty("stream_options");
  });

  it("keeps stream_options for servers that accept it and reports their usage", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        sse(
          events(
            { choices: [{ delta: { content: "ok" } }] },
            { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }
          )
        )
      );
    const result = await openAi(fetch, "https://lenient-server.example.test/v1").runStreaming(
      request(),
      undefined,
      () => undefined
    );
    expect(result).toMatchObject({ output: "ok", inputTokens: 9, outputTokens: 2, attempts: 1 });
    expect(bodyOf(fetch.mock.calls[0])).toHaveProperty("stream_options");
  });

  it("does not take any other 400 for a stream_options rejection", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("model not found", { status: 400 }));
    await expect(
      openAi(fetch, "https://other-400.example.test/v1").runStreaming(
        request(),
        undefined,
        () => undefined
      )
    ).rejects.toMatchObject({ status: 400, transient: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("quota and plan limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const quota = (retryIn: string) =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: `You exceeded your current quota, please check your plan and billing details. Please retry in ${retryIn}.`
        }
      }),
      { status: 429 }
    );
  const answer = () => Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });

  it("waits the few seconds a Gemini per-minute quota names and then succeeds", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(quota("3s"))
      .mockResolvedValue(answer());
    const result = google(fetch).run(request());
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ output: "ok", attempts: 2 });
  });

  it("hands a longer Gemini quota wait to the job instead of holding the execution slot", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => quota("32.4s"));
    const error = await google(fetch)
      .run(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, transient: true, retryAfterMs: 32_400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an exhausted billing quota at all", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
        {
          status: 429
        }
      )
    );
    const error = await openAi(fetch, "https://billing.example.test/v1")
      .run(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, transient: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves a ChatGPT plan limit to the job, which waits for the announced reset", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "usage_limit_reached",
              message: "The usage limit has been reached",
              plan_type: "plus",
              resets_in_seconds: 1_200
            }
          }),
          { status: 429 }
        )
    );
    const error = await codex(fetch)
      .run(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 429, transient: true, retryAfterMs: 1_200_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("what a streamed call cost when it was retried", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const chunk = (text: string, promptTokenCount: number, candidatesTokenCount: number) =>
    events({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount, candidatesTokenCount }
    });

  it("counts the attempts and the tokens a stalled attempt used", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(scheduled([[0, chunk("par", 120, 3)]]))
      .mockResolvedValue(sse(chunk("complete answer", 120, 10)));
    const result = google(fetch).runStreaming(request(), undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(20_100);
    await expect(result).resolves.toMatchObject({
      output: "complete answer",
      attempts: 2,
      // The answer's own 120 + 10 tokens plus the 120 + 3 the stalled attempt reported.
      inputTokens: 240,
      outputTokens: 13,
      tokenUsage: { inputTokens: 240, outputTokens: 13, totalTokens: 253 },
      retriedUsage: { inputTokens: 120, outputTokens: 3 }
    });
  });

  it("reports one attempt and no retried usage when the first attempt succeeds", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(sse(chunk("ok", 5, 1)));
    const result = await google(fetch).runStreaming(request(), undefined, () => undefined);
    expect(result).toMatchObject({ attempts: 1, inputTokens: 5, outputTokens: 1 });
    expect(result).not.toHaveProperty("retriedUsage");
  });

  it("attaches attempts and billed tokens to the error of a call that never succeeded", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => scheduled([[0, chunk("par", 120, 3)]]));
    const result = google(fetch, { retry: { maxAttempts: 2 } }).runStreaming(
      request(),
      undefined,
      () => undefined
    );
    const settled = result.catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(41_000);
    const error = await settled;
    expect(error).toMatchObject({ kind: "stalled" });
    expect(remoteCallReport(error)).toEqual({
      attempts: 2,
      failedUsage: { inputTokens: 240, outputTokens: 6 }
    });
  });

  it("counts the attempts of a call that was not streamed", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    const result = google(fetch).run(request());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ attempts: 2 });
  });
});

describe("a silent server over a real HTTP connection", () => {
  let server: Server;
  let handler: (request: IncomingMessage, response: ServerResponse) => void;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((incoming, outgoing) => handler(incoming, outgoing));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("streams a generation that the stored capabilities do not mark as streaming, so a stall is cut", async () => {
    let calls = 0;
    handler = (_incoming, outgoing) => {
      calls++;
      outgoing.writeHead(200, streamHeaders);
      outgoing.write(events({ choices: [{ delta: { content: "par" } }] }));
    };
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl,
      apiKey: "secret",
      modelId: "model",
      capabilities: ["text-generation"],
      runtime: { retry: { maxAttempts: 1 }, deadlines: { stallMs: 120 } }
    });
    expect(runsStreaming(adapter, "summarization")).toBe(true);
    await expect(adapter.runStreaming(request(), undefined, () => undefined)).rejects.toMatchObject(
      {
        kind: "stalled"
      }
    );
    expect(calls).toBe(1);
  });
});
