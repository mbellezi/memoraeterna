import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAiCodexAdapter } from "./openai-codex.js";
import { remoteCallReport } from "./remote-execution.js";

describe("OpenAI Codex adapter", () => {
  it("lists visible subscription models with OAuth account headers", async () => {
    const adapter = new OpenAiCodexAdapter({
      accessToken: "oauth-access",
      accountId: "account-1",
      modelId: "gpt-test",
      capabilities: ["text-generation"],
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0"
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer oauth-access");
        expect(headers.get("chatgpt-account-id")).toBe("account-1");
        return Response.json({
          models: [
            {
              slug: "gpt-visible",
              display_name: "Visible",
              visibility: "list",
              max_output_tokens: 128_000
            },
            { slug: "gpt-hidden", visibility: "hide" }
          ]
        });
      }
    });

    await expect(adapter.listModels()).resolves.toMatchObject([
      {
        modelId: "gpt-visible",
        displayName: "Visible",
        limits: { maxTokens: 128_000 },
        parameterCapabilities: {}
      }
    ]);
  });

  it.each(["gpt-5.6-terra", "gpt-5.6-luna"])(
    "omits the unsupported max_output_tokens parameter for %s",
    async (modelId) => {
      const body = [
        'data: {"type":"response.output_text.delta","delta":"summary"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n'
      ].join("");
      const adapter = new OpenAiCodexAdapter({
        accessToken: "oauth-access",
        accountId: "account-1",
        modelId,
        capabilities: ["summarization", "streaming"],
        fetch: async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          expect(payload).not.toHaveProperty("max_output_tokens");
          expect(payload).not.toHaveProperty("contextWindow");
          expect(payload).not.toHaveProperty("context_window");
          expect(payload).toMatchObject({
            model: modelId,
            reasoning: { effort: "low", summary: "auto" }
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
      });

      await expect(
        adapter.run({
          taskType: "summarization",
          input: "test",
          requiredCapabilities: ["summarization"],
          parameters: { contextWindow: 128000, maxTokens: 16_384, reasoningLevel: "off" },
          metadata: {}
        })
      ).resolves.toMatchObject({ output: "summary", modelId });
    }
  );

  it("streams a generative response and rejects embeddings", async () => {
    const body = [
      'data: {"type":"response.output_text.delta","delta":"hello "}\n\n',
      'data: {"type":"response.output_text.delta","delta":"world"}\n\n',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":2}}}\n\n'
    ].join("");
    const adapter = new OpenAiCodexAdapter({
      accessToken: "oauth-access",
      accountId: "account-1",
      modelId: "gpt-5.6-sol",
      capabilities: ["text-generation", "streaming"],
      fetch: async (_input, init) => {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(payload).toMatchObject({
          model: "gpt-5.6-sol",
          store: false,
          stream: true,
          reasoning: { effort: "max" }
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
    });

    await expect(
      adapter.run({
        taskType: "text-generation",
        input: "test",
        requiredCapabilities: ["text-generation"],
        parameters: { reasoningLevel: "max" },
        metadata: {}
      })
    ).resolves.toMatchObject({ output: "hello world", inputTokens: 2, outputTokens: 2 });
    await expect(
      adapter.run({
        taskType: "embedding",
        input: "test",
        requiredCapabilities: ["embedding"],
        parameters: {},
        metadata: {}
      })
    ).rejects.toThrow("errors.ai.unsupportedTask");
  });

  it("preserves the detailed provider response when a request fails", async () => {
    const adapter = new OpenAiCodexAdapter({
      accessToken: "oauth-access",
      accountId: "account-1",
      modelId: "gpt-5.6-terra",
      capabilities: ["summarization"],
      fetch: async () =>
        Response.json(
          {
            detail: "Request rejected for account policy"
          },
          { status: 400 }
        )
    });

    const error = await adapter
      .run({
        taskType: "summarization",
        input: "test",
        requiredCapabilities: ["summarization"],
        parameters: {},
        metadata: {}
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("AI provider request failed (400).");
    expect((error as Error).message).toContain("Request rejected for account policy");
  });
});

describe("decide calls without the reasoning summary", () => {
  const events = (...payloads: unknown[]) =>
    payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
  const answer = (text: string) =>
    events(
      { type: "response.output_text.delta", delta: text },
      { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 1 } } }
    );
  const sse = (body: string) =>
    new Response(body, { headers: { "content-type": "text/event-stream" } });
  const payloadOf = (init: RequestInit | undefined) =>
    JSON.parse(String(init?.body)) as Record<string, unknown>;
  // The process remembers a refusal per base URL and model, so every test uses its own backend.
  let backend = 0;
  const adapter = (fetch: typeof globalThis.fetch, maxAttempts = 3) =>
    new OpenAiCodexAdapter({
      accessToken: "oauth-access",
      accountId: "account-1",
      modelId: "gpt-5.6-luna",
      capabilities: ["text-generation", "structured-output", "streaming"],
      baseUrl: `https://decide-${(backend += 1)}.example.test/codex`,
      fetch,
      runtime: { retry: { maxAttempts } },
      random: () => 0.5
    });
  const decide = {
    taskType: "reranking" as const,
    input: "decide",
    requiredCapabilities: [],
    parameters: { reasoningLevel: "low" },
    metadata: {}
  };
  const fullShape = {
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"]
  };
  const leanOptions = { reasoningEffort: "low", reasoningSummary: null, include: [] };
  const fullOptions = {
    reasoningEffort: "low",
    reasoningSummary: "auto",
    include: ["reasoning.encrypted_content"]
  };
  const refusal = (message: string) =>
    Response.json({ error: { message, type: "invalid_request_error" } }, { status: 400 });

  it("sends a decide call without the summary or the encrypted reasoning, and reports it", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const codex = adapter(async (_input, init) => {
      payloads.push(payloadOf(init));
      return sse(answer('{"results":[]}'));
    });
    await expect(codex.run(decide)).resolves.toMatchObject({
      output: '{"results":[]}',
      requestOptions: leanOptions
    });
    expect(payloads[0]).toMatchObject({ store: false, reasoning: { effort: "low" } });
    expect(payloads[0]!.reasoning).not.toHaveProperty("summary");
    expect(payloads[0]).not.toHaveProperty("include");

    // Other workload classes keep the previous request.
    await expect(
      codex.run({ ...decide, taskType: "summarization" as const })
    ).resolves.toMatchObject({ requestOptions: fullOptions });
    expect(payloads[1]).toMatchObject(fullShape);
  });

  it("falls back once to the previous shape when the backend refuses it, and remembers that", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [
      refusal("Unsupported value: 'include' must contain 'reasoning.encrypted_content'."),
      sse(answer("first")),
      sse(answer("second")),
      sse(answer("other model"))
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    const codex = adapter(fetch);
    await expect(codex.run(decide)).resolves.toMatchObject({
      output: "first",
      requestOptions: { ...fullOptions, leanDecideShape: "refused" },
      // The provider received both requests of that one call.
      attempts: 2
    });
    expect(payloads[0]).not.toHaveProperty("include");
    expect(payloads[1]).toMatchObject(fullShape);
    // The next decide call of this process goes straight to the shape the backend accepts.
    await expect(codex.run(decide)).resolves.toMatchObject({
      output: "second",
      requestOptions: { ...fullOptions, leanDecideShape: "refused_earlier" },
      attempts: 1
    });
    expect(payloads[2]).toMatchObject(fullShape);
    expect(fetch).toHaveBeenCalledTimes(3);
    // The memory is per backend and model: another model is still asked without the summary.
    await expect(codex.run({ ...decide, modelId: "gpt-5.6-terra" })).resolves.toMatchObject({
      output: "other model",
      requestOptions: leanOptions
    });
    expect(payloads[3]).not.toHaveProperty("include");
  });

  it("surfaces a refusal of the previous shape too, without a third request or a memory", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [
      refusal("Missing required parameter: 'reasoning.summary'."),
      refusal("Unsupported parameter: 'reasoning.summary' is not available."),
      sse(answer("lean again"))
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    const codex = adapter(fetch);
    const error = await codex.run(decide).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 400, transient: false });
    expect((error as Error).message).toContain("'reasoning.summary' is not available");
    expect(fetch).toHaveBeenCalledTimes(2);
    // The audit of the failed call has both requests and the wire options of the last one.
    expect(remoteCallReport(error)).toMatchObject({
      attempts: 2,
      requestOptions: { ...fullOptions, leanDecideShape: "refused" }
    });
    // Nothing proved the lean shape wrong: the next decide call still sends it.
    await expect(codex.run(decide)).resolves.toMatchObject({
      output: "lean again",
      requestOptions: leanOptions,
      attempts: 1
    });
    expect(payloads[2]).not.toHaveProperty("include");
    expect(payloads[2]!.reasoning).not.toHaveProperty("summary");
  });

  it("falls back for a 422 that names the parameter, in several wordings", async () => {
    const wordings = [
      "Unsupported parameter: 'reasoning.summary' is not supported with this model.",
      'Invalid value: "reasoning.encrypted_content". Supported values are: none.',
      '{"error":{"message":"Unknown parameter.","param":"include[0]"}}',
      "Unknown parameter: include",
      "encrypted_content is not accepted when store is false"
    ];
    for (const message of wordings) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          Response.json({ error: { message, type: "invalid_request_error" } }, { status: 422 })
        )
        .mockResolvedValueOnce(sse(answer("full")));
      await expect(adapter(fetch).run(decide), message).resolves.toMatchObject({
        output: "full",
        attempts: 2
      });
    }
  });

  it("never falls back for a refusal that is not about the request shape", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [refusal("Request rejected for account policy"), sse(answer("lean again"))];
    const codex = adapter(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    await expect(codex.run(decide)).rejects.toThrow("Request rejected for account policy");
    expect(payloads).toHaveLength(1);
    await expect(codex.run(decide)).resolves.toMatchObject({ requestOptions: leanOptions });
    expect(payloads[1]).not.toHaveProperty("include");
  });

  it("does not take a plain word or another status for a refusal of the shape", async () => {
    const cases: Array<[status: number, body: string]> = [
      // A WAF or auth page says "include" in prose; only an invalid request (400, 422) can be one.
      [403, "Please include the Ray ID in your report. Your summary was blocked."],
      [401, '{"error":{"message":"Token expired; include a fresh token.","code":"token_expired"}}'],
      [404, "Not found: 'include' route"],
      // An invalid request that mentions the words without naming a parameter.
      [400, "Please include a valid session. A summary of the rules is on our site."]
    ];
    for (const [status, body] of cases) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(body, { status }))
        .mockResolvedValue(sse(answer("fallback")));
      const codex = adapter(fetch);
      const error = await codex.run(decide).catch((caught: unknown) => caught);
      expect(error, body).toMatchObject({ status });
      expect(fetch, body).toHaveBeenCalledTimes(1);
      // The failure remembered nothing: the next call is still lean.
      await expect(codex.run(decide), body).resolves.toMatchObject({
        requestOptions: leanOptions
      });
    }
  });

  it("keeps the full shape for the next attempt of a call whose fallback failed transiently", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const responses = [
      refusal("Unsupported parameter: 'reasoning.summary'."),
      new Response("busy", { status: 503 }),
      sse(answer("full")),
      sse(answer("again"))
    ];
    const codex = adapter(async (_input, init) => {
      payloads.push(payloadOf(init));
      return responses.shift()!;
    });
    await expect(codex.run(decide)).resolves.toMatchObject({
      output: "full",
      requestOptions: { ...fullOptions, leanDecideShape: "refused" },
      // Lean, the fallback that failed, and the retry: three requests.
      attempts: 3
    });
    expect(payloads[0]).not.toHaveProperty("include");
    expect(payloads[1]).toMatchObject(fullShape);
    expect(payloads[2]).toMatchObject(fullShape);
    // The full shape was accepted in the end, so the next call starts with it.
    await expect(codex.run(decide)).resolves.toMatchObject({
      requestOptions: { ...fullOptions, leanDecideShape: "refused_earlier" }
    });
  });

  it("records the wire options of a lean request that failed before an answer", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("down", { status: 500 }));
    const error = await adapter(fetch, 1)
      .run(decide)
      .catch((caught: unknown) => caught);
    expect(remoteCallReport(error)).toMatchObject({ attempts: 1, requestOptions: leanOptions });
  });

  describe("watchdog", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const encoder = new TextEncoder();
    /** A stream that delivers each chunk at its time and then, unless `endAt` is given, hangs. */
    const scheduled = (chunks: Array<[atMs: number, body: string]>, endAt?: number) => {
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const [at, body] of chunks)
              timers.push(setTimeout(() => controller.enqueue(encoder.encode(body)), at));
            if (endAt !== undefined) timers.push(setTimeout(() => controller.close(), endAt));
          },
          cancel() {
            for (const timer of timers) clearTimeout(timer);
          }
        }),
        { headers: { "content-type": "text/event-stream" } }
      );
    };
    const lifecycle = events(
      { type: "response.created" },
      { type: "response.output_item.added", item: { type: "reasoning" } }
    );

    it("keeps a decide call alive on its answer text after a silent reasoning phase", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        scheduled(
          [
            [0, lifecycle],
            // 25 s of silent reasoning: longer than the 20 s stall window, inside the 30 s bound of
            // a decide call, which sends no reasoning summary to show it is thinking.
            [25_000, events({ type: "response.output_text.delta", delta: '{"results":' })],
            [30_000, answer("[]}")]
          ],
          30_000
        )
      );
      const result = adapter(fetch, 1).run(decide);
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(result).resolves.toMatchObject({ output: '{"results":[]}', attempts: 1 });
    });

    it("keeps a medium-effort decide call alive through the same silent phase", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        scheduled(
          [
            [0, lifecycle],
            [28_000, answer('{"results":[]}')]
          ],
          28_000
        )
      );
      const result = adapter(fetch, 1).run({ ...decide, parameters: { reasoningLevel: "medium" } });
      await vi.advanceTimersByTimeAsync(28_001);
      await expect(result).resolves.toMatchObject({ output: '{"results":[]}', attempts: 1 });
    });

    it("still bounds the silence before the answer of a decide call at 30 s", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => scheduled([[0, lifecycle]]));
      const result = adapter(fetch, 1).run(decide);
      let ended = false;
      const settled = expect(result).rejects.toMatchObject({ kind: "stalled", transient: true });
      void result.catch(() => {
        ended = true;
      });
      // Lifecycle events are not progress: only the answer text ends the silence, and the bound
      // is the answer-start window, not the 20 s stall window.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("keeps the short stall window once the answer text of a decide call started", async () => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        scheduled([
          [0, lifecycle],
          [10_000, events({ type: "response.output_text.delta", delta: '{"results":' })]
        ])
      );
      const result = adapter(fetch, 1).run(decide);
      const settled = expect(result).rejects.toMatchObject({
        kind: "stalled",
        message: "AI provider stream stalled for 20000 ms."
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;
    });
  });
});
