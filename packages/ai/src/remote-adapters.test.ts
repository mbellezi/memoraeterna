import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiTaskRequest } from "./contracts.js";
import { GoogleGeminiAdapter } from "./google.js";
import { OpenAiCodexAdapter } from "./openai-codex.js";
import { OpenAiCompatibleAdapter } from "./openai-compatible.js";
import type { AiRuntimeConfigInput } from "./remote-execution.js";

const encoder = new TextEncoder();
const request = (
  taskType: AiTaskRequest["taskType"] = "text-generation",
  parameters: Record<string, unknown> = {}
): AiTaskRequest => ({
  taskType,
  input: "hello",
  requiredCapabilities: [],
  parameters,
  metadata: {}
});

function events(...payloads: unknown[]): string {
  return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
}
function sse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init
  });
}
/** A stream that delivers `first`, then neither ends nor fails (a provider that went silent). */
function silentAfter(first: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (first) controller.enqueue(encoder.encode(first));
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}
const completion = (content: string) =>
  Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 1 } });
const deltas = (...parts: string[]) =>
  sse(
    events(...parts.map((content) => ({ choices: [{ delta: { content } }] }))) + "data: [DONE]\n\n"
  );
const runtime = (input: AiRuntimeConfigInput = {}): AiRuntimeConfigInput => ({
  ...input,
  retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 400, ...input.retry }
});

function openAi(fetch: typeof globalThis.fetch, config?: AiRuntimeConfigInput) {
  return new OpenAiCompatibleAdapter({
    baseUrl: "https://example.test/v1",
    apiKey: "secret-key",
    modelId: "model",
    capabilities: ["text-generation", "streaming"],
    fetch,
    runtime: runtime(config),
    random: () => 0.5
  });
}

describe("remote adapter deadlines and retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a 503 after the delay Retry-After asks for and returns the later answer", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("overloaded", { status: 503, headers: { "retry-after": "2" } })
      )
      .mockResolvedValue(completion("answer"));
    const result = openAi(fetch).run(request());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ output: "answer", inputTokens: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 413])("does not retry a %i", async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("rejected", { status }));
    const error = await openAi(fetch)
      .run(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status, transient: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up on a provider that keeps failing and reports the transient error", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("down", { status: 502 }));
    const result = openAi(fetch).run(request());
    const settled = expect(result).rejects.toMatchObject({ status: 502, transient: true });
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("aborts a stalled stream cleanly and reports a transient error", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(silentAfter(events({ choices: [{ delta: { content: "par" } }] })));
    const progress: number[] = [];
    const result = openAi(fetch, { retry: { maxAttempts: 1 } }).runStreaming(
      request(),
      undefined,
      (event) => event.kind !== "text" && progress.push(event.progress)
    );
    const settled = expect(result).rejects.toMatchObject({ kind: "stalled", transient: true });
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
    expect(progress.at(-1)).toBeLessThan(1);
  });

  it("restarts a stalled stream without repeating its partial output", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(silentAfter(events({ choices: [{ delta: { content: "par" } }] })))
      .mockResolvedValue(deltas("complete ", "answer"));
    const progress: number[] = [];
    const result = openAi(fetch).runStreaming(
      request(),
      undefined,
      (event) => event.kind !== "text" && progress.push(event.progress)
    );
    await vi.advanceTimersByTimeAsync(20_050);
    await expect(result).resolves.toMatchObject({ output: "complete answer" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
  });

  it("fails a provider that sends nothing at all within the first-byte deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(silentAfter(""));
    const result = openAi(fetch, { retry: { maxAttempts: 1 } }).runStreaming(
      request(),
      undefined,
      () => undefined
    );
    const settled = expect(result).rejects.toMatchObject({
      kind: "timeout",
      message: "AI provider sent no data within 30000 ms."
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
  });

  it("retries an error the provider reports inside the stream, unless it is deterministic", async () => {
    const transientFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(sse(events({ error: { code: "server_error", message: "oops" } })))
      .mockResolvedValue(deltas("ok"));
    const retried = openAi(transientFetch).runStreaming(request(), undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(retried).resolves.toMatchObject({ output: "ok" });
    const overflowFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        sse(events({ error: { code: "context_length_exceeded", message: "too long" } }))
      );
    await expect(
      openAi(overflowFetch).runStreaming(request(), undefined, () => undefined)
    ).rejects.toMatchObject({ kind: "context_overflow", transient: false });
    expect(overflowFetch).toHaveBeenCalledTimes(1);
  });

  it("stops retrying when the caller cancels", async () => {
    const controller = new AbortController();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("down", { status: 503 }));
    const result = openAi(fetch).run(request(), controller.signal);
    const settled = expect(result).rejects.toThrow("user canceled");
    await vi.advanceTimersByTimeAsync(5);
    controller.abort(new Error("user canceled"));
    await settled;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds an embedding that never answers by its total deadline", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const result = openAi(fetch, {
      retry: { maxAttempts: 1 },
      deadlines: { totalMs: { embed: 1_000 } }
    }).run(request("embedding"));
    const settled = expect(result).rejects.toMatchObject({ kind: "timeout", transient: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;
  });

  it("does not retry a connection test or a model listing", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("down", { status: 503 }));
    await expect(openAi(fetch).testConnection()).rejects.toMatchObject({ status: 503 });
    await expect(openAi(fetch).listModels()).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries ChatGPT/Codex stream failures by their code and keeps credentials out of errors", async () => {
    const codex = (fetch: typeof globalThis.fetch) =>
      new OpenAiCodexAdapter({
        accessToken: "oauth-access-token",
        accountId: "account-1",
        modelId: "gpt-test",
        capabilities: ["text-generation"],
        fetch,
        runtime: runtime(),
        random: () => 0.5
      });
    const failure = (code: string) =>
      sse(
        events({
          type: "response.failed",
          response: { error: { code, message: `failed with ${code}` } }
        })
      );
    const success = sse(
      events(
        { type: "response.output_text.delta", delta: "done" },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }
      )
    );
    const flaky = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(failure("server_error"))
      .mockResolvedValue(success);
    const retried = codex(flaky).run(request());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(retried).resolves.toMatchObject({ output: "done" });
    expect(flaky).toHaveBeenCalledTimes(2);

    const invalid = vi.fn<typeof globalThis.fetch>().mockResolvedValue(failure("invalid_prompt"));
    const error = await codex(invalid)
      .run(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ transient: false, code: "invalid_prompt" });
    expect(invalid).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error)).not.toContain("oauth-access-token");
  });

  it("aborts a stalled ChatGPT/Codex stream", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(silentAfter(events({ type: "response.created" })));
    const result = new OpenAiCodexAdapter({
      accessToken: "token",
      accountId: "account-1",
      modelId: "gpt-test",
      capabilities: ["text-generation"],
      fetch,
      runtime: runtime({ retry: { maxAttempts: 1 } })
    }).run(request());
    const settled = expect(result).rejects.toMatchObject({ kind: "stalled", transient: true });
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
  });

  it("retries Gemini rate limits and reports other 4xx errors once, without the key", async () => {
    const google = (fetch: typeof globalThis.fetch) =>
      new GoogleGeminiAdapter({
        apiKey: "google-secret-key",
        modelId: "gemini-test",
        capabilities: ["text-generation"],
        fetch,
        runtime: runtime(),
        random: () => 0.5
      });
    const answer = Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    const limited = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("RESOURCE_EXHAUSTED", { status: 429 }))
      .mockResolvedValue(answer);
    const retried = google(limited).run(request());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(retried).resolves.toMatchObject({ output: "ok" });
    expect(limited).toHaveBeenCalledTimes(2);

    const rejected = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("API key not valid", { status: 400 }));
    const error = await google(rejected)
      .run(request())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 400, transient: false });
    expect(String((error as Error).message)).not.toContain("google-secret-key");
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("retries a Gemini stream error event by its status", async () => {
    const stream = sse(
      events({ error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } })
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stream)
      .mockResolvedValue(
        sse(events({ candidates: [{ content: { parts: [{ text: "streamed" }] } }] }))
      );
    const result = new GoogleGeminiAdapter({
      apiKey: "key",
      modelId: "gemini-test",
      capabilities: ["text-generation"],
      fetch,
      runtime: runtime(),
      random: () => 0.5
    }).runStreaming(request(), undefined, () => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ output: "streamed" });
  });
});

describe("remote adapters over a real HTTP connection", () => {
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

  const adapter = (config: AiRuntimeConfigInput) =>
    new OpenAiCompatibleAdapter({
      baseUrl,
      apiKey: "secret",
      modelId: "model",
      capabilities: ["text-generation", "streaming"],
      runtime: {
        ...config,
        retry: { baseDelayMs: 10, maxDelayMs: 20, ...config.retry },
        deadlines: { stallMs: 150, ...config.deadlines }
      }
    });

  it("cuts a stream that goes silent and succeeds on the retry", async () => {
    let calls = 0;
    handler = (_incoming, outgoing) => {
      calls++;
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      if (calls === 1) {
        outgoing.write(events({ choices: [{ delta: { content: "par" } }] }));
        return; // never ends
      }
      outgoing.end(events({ choices: [{ delta: { content: "whole" } }] }) + "data: [DONE]\n\n");
    };
    const result = await adapter({}).runStreaming(request(), undefined, () => undefined);
    expect(result.output).toBe("whole");
    expect(calls).toBe(2);
  });

  it("reports a stall once the attempts are used up", async () => {
    let calls = 0;
    handler = (_incoming, outgoing) => {
      calls++;
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.write(events({ choices: [{ delta: { content: "x" } }] }));
    };
    await expect(
      adapter({ retry: { maxAttempts: 2 } }).runStreaming(request(), undefined, () => undefined)
    ).rejects.toMatchObject({ kind: "stalled", transient: true });
    expect(calls).toBe(2);
  });

  it("enforces the total deadline on a non-streamed request the server never answers", async () => {
    handler = () => undefined;
    // Servers on this machine get three times the configured total deadline.
    await expect(
      adapter({
        retry: { maxAttempts: 1 },
        deadlines: { totalMs: { embed: 50 } }
      }).run(request("embedding"))
    ).rejects.toMatchObject({ kind: "timeout", transient: true });
  });

  it("honors a cancellation while the server is silent", async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const result = adapter({}).run(request(), controller.signal);
    setTimeout(() => controller.abort(new Error("user canceled")), 30);
    await expect(result).rejects.toThrow("user canceled");
  });
});
