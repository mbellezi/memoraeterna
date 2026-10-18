import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, resolveAiRuntimeConfig, runRemoteCall } from "@app/ai";
import { AiService } from "./ai-service.js";

const state = vi.hoisted(() => ({
  selection: {} as Record<string, unknown>,
  record: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async () => state.selection,
    recordTaskRun: state.record
  }),
  createLocalModelRepository: () => ({ findById: async () => null })
}));

const uuid = "00000000-0000-4000-8000-000000000001";
const result = (request: { taskType: string }, extra: Record<string, unknown> = {}) => ({
  taskType: request.taskType,
  output: "ok",
  providerId: "openai-compatible",
  modelId: "fixture",
  runtime: "remote",
  durationMs: 1,
  ...extra
});

function service(
  adapter: {
    run?: (request: { taskType: string; input: string }, signal?: AbortSignal) => Promise<unknown>;
    runStreaming?: (
      request: { taskType: string },
      signal: AbortSignal | undefined,
      onProgress: (event: unknown) => void
    ) => Promise<unknown>;
  },
  monitoring?: unknown
) {
  const ai = new AiService({
    userDataPath: "/tmp/ai-calls-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    // One call at a time on the remote lane, so the order behind the call in flight shows.
    lanes: { mode: "serial" },
    ...(monitoring ? { monitoring: monitoring as never } : {})
  });
  const registered = {
    describe: () => ({
      providerId: "openai-compatible",
      modelId: "fixture",
      runtime: "remote",
      // The stored capabilities do not declare streaming.
      capabilities: ["summarization", "embedding", "text-generation"],
      parameterCapabilities: { maxTokens: { min: 1, max: 16384 } }
    }),
    canHandle: () => true,
    run: adapter.run ?? vi.fn(async (request: { taskType: string }) => result(request)),
    ...(adapter.runStreaming ? { runStreaming: adapter.runStreaming } : {})
  };
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(registered)
  );
  return ai;
}

beforeEach(() => {
  state.record.mockReset().mockResolvedValue("run-id");
  state.selection = {
    profileId: uuid,
    providerConfigId: uuid,
    localModelId: null,
    provider: "openai-compatible",
    modelId: "fixture",
    runtime: "remote",
    revision: null,
    repository: null,
    quantization: null,
    baseUrl: "https://fixture.invalid",
    parameters: {},
    modelDefaultParameters: {},
    providerMetadata: {},
    requiredCapabilities: ["summarization", "embedding", "text-generation"]
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("how a routed call reaches its adapter", () => {
  it("streams a remote generation although the model does not declare streaming", async () => {
    const run = vi.fn(async (request: { taskType: string }) => result(request));
    const runStreaming = vi.fn(async (request: { taskType: string }) => result(request));
    await service({ run, runStreaming }).runDefaultTask("summarization", "text");
    expect(runStreaming).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not stream an embedding, and uses run when the adapter cannot stream", async () => {
    const run = vi.fn(async (request: { taskType: string }) => result(request));
    const runStreaming = vi.fn(async (request: { taskType: string }) => result(request));
    await service({ run, runStreaming }).runDefaultTask("embedding", "text");
    expect(run).toHaveBeenCalledOnce();
    expect(runStreaming).not.toHaveBeenCalled();
    await service({ run }).runDefaultTask("summarization", "text");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("the answer text of a streamed call (F3 D22)", () => {
  it("hands every piece to onTextDelta at once, and keeps text out of the progress listener", async () => {
    const pieces = Array.from({ length: 120 }, (_, index) => `piece ${index} `);
    const runStreaming = vi.fn(
      async (
        request: { taskType: string },
        _signal: AbortSignal | undefined,
        onProgress: (event: unknown) => void
      ) => {
        onProgress({ progress: 0.4 });
        for (const delta of pieces) onProgress({ kind: "text", delta });
        onProgress({ kind: "text", delta: "again ", restart: true });
        return result(request);
      }
    );
    const progress: unknown[] = [];
    const text: Array<{ delta: string; restart?: boolean }> = [];
    const watch = {
      start: vi.fn<(input: { context: object }) => Promise<{ id: string; full: boolean }>>(
        async () => ({ id: "capture", full: false })
      ),
      finish: vi.fn(async () => undefined)
    };
    await service({ runStreaming }, watch).runDefaultTask("text-generation", "write", {
      onProgress: (event) => progress.push(event),
      onTextDelta: (event) => text.push(event)
    });
    // Not throttled like progress: all 121 pieces arrive, in order, with the restart flag.
    expect(text.map((event) => event.delta)).toEqual([...pieces, "again "]);
    expect(text.at(-1)).toMatchObject({ restart: true });
    // The progress listener of an ingestion job reads `progress` of every event: text never reaches it.
    expect(progress.length).toBeGreaterThan(0);
    expect(
      progress.every((event) => typeof (event as { progress?: number }).progress === "number")
    ).toBe(true);
    // The listeners are the caller's: the monitoring context is data and holds none of them.
    const context = watch.start.mock.calls[0]![0].context;
    expect(context).not.toHaveProperty("onTextDelta");
    expect(context).not.toHaveProperty("onProgress");
  });

  it("never calls it for a runtime that does not stream: the final text arrives at once", async () => {
    const run = vi.fn(async (request: { taskType: string }) => result(request, { output: "all" }));
    const text: string[] = [];
    const execution = await service({ run }).runDefaultTask("text-generation", "write", {
      onTextDelta: (event) => text.push(event.delta)
    });
    expect(text).toEqual([]);
    expect(execution?.output).toBe("all");
  });

  it("serves a call without a text listener from a streaming runtime", async () => {
    const runStreaming = vi.fn(
      async (
        request: { taskType: string },
        _signal: AbortSignal | undefined,
        onProgress: (event: unknown) => void
      ) => {
        onProgress({ kind: "text", delta: "ignored" });
        return result(request);
      }
    );
    await expect(
      service({ runStreaming }).runDefaultTask("text-generation", "write")
    ).resolves.toMatchObject({ output: "ok" });
  });
});

describe("the priority of a consultation query embedding", () => {
  async function order(priority?: "background") {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const seen: string[] = [];
    const ai = service({
      run: async (request) => {
        const name = ["import 1", "import 2", "question"].find((candidate) =>
          request.input.includes(candidate)
        )!;
        seen.push(name);
        if (name === "import 1") {
          started.resolve();
          await gate.promise;
        }
        return result(request);
      }
    });
    const background = { origin: "ingestion", ingestionRunId: "run" };
    const calls: Array<Promise<unknown>> = [
      ai.runDefaultTask("summarization", "import 1", background)
    ];
    await started.promise;
    calls.push(
      ai.runDefaultTask("summarization", "import 2", background),
      ai.runConsultationEmbedding(
        "question",
        "allow_remote",
        [],
        new AbortController().signal,
        priority
      )
    );
    gate.resolve();
    await Promise.all(calls);
    return seen;
  }

  it("is interactive for Ask: it runs right after the call in flight", async () => {
    expect(await order()).toEqual(["import 1", "question", "import 2"]);
  });

  it("is background work for an automatic investigation refresh: it waits behind queued imports", async () => {
    expect(await order("background")).toEqual(["import 1", "import 2", "question"]);
  });
});

describe("the requests a call needed", () => {
  const monitoring = () => ({
    start: vi.fn(async () => ({ id: "capture", full: false })),
    finish: vi.fn<(capture: unknown, result: Record<string, unknown>) => Promise<void>>(
      async () => undefined
    )
  });

  it("keeps the attempts and the tokens of failed attempts in the audit of a successful call", async () => {
    const watch = monitoring();
    const ai = service(
      {
        run: async (request) =>
          result(request, {
            // The adapter already added the 200 + 20 tokens of its failed attempts to the totals.
            inputTokens: 300,
            outputTokens: 50,
            tokenUsage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
            attempts: 3,
            retriedUsage: { inputTokens: 200, outputTokens: 20 }
          })
      },
      watch
    );
    await expect(ai.runDefaultTask("summarization", "text")).resolves.toMatchObject({
      attempts: 3
    });
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({
      status: "succeeded",
      inputTokens: 300,
      outputTokens: 50
    });
    expect(watch.finish.mock.calls[0]?.[1]).toMatchObject({
      status: "succeeded",
      tokenUsage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
      details: { attempts: 3, retriedUsage: { inputTokens: 200, outputTokens: 20 } }
    });
  });

  it("records only what is known when the call needed one request", async () => {
    const watch = monitoring();
    const ai = service({ run: async (request) => result(request, { attempts: 1 }) }, watch);
    await ai.runDefaultTask("summarization", "text");
    expect(watch.finish.mock.calls[0]?.[1]).toMatchObject({ details: { attempts: 1 } });
    expect(watch.finish.mock.calls[0]?.[1].details).not.toHaveProperty("retriedUsage");
    // A result without a report (a local model, a cassette replay) adds no details.
    const plain = monitoring();
    await service({}, plain).runDefaultTask("summarization", "text");
    expect(plain.finish.mock.calls[0]?.[1]).not.toHaveProperty("details");
  });

  it("records the tokens billed for a call that failed after retries", async () => {
    const watch = monitoring();
    const ai = service(
      {
        run: () =>
          runRemoteCall(
            { config: resolveAiRuntimeConfig({ retry: { maxAttempts: 1 } }) },
            { streaming: true },
            async (call) => {
              call.reportUsage({ inputTokens: 50, outputTokens: 7 });
              throw new AiProviderError("stalled", { kind: "stalled", transient: true });
            }
          )
      },
      watch
    );
    await expect(ai.runDefaultTask("summarization", "text")).rejects.toThrow("stalled");
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      inputTokens: 50,
      outputTokens: 7
    });
    expect(watch.finish.mock.calls[0]?.[1]).toMatchObject({
      status: "failed",
      tokenUsage: { inputTokens: 50, outputTokens: 7, totalTokens: 57 },
      details: { attempts: 1, retriedUsage: { inputTokens: 50, outputTokens: 7 } }
    });
  });

  it("records the wire options and every request of a decide call that failed after a fallback", async () => {
    const watch = monitoring();
    const lean = { reasoningEffort: "low", reasoningSummary: null, include: [] };
    const full = {
      reasoningEffort: "low",
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
      leanDecideShape: "refused"
    };
    const ai = service(
      {
        run: () =>
          runRemoteCall(
            { config: resolveAiRuntimeConfig({ retry: { maxAttempts: 1 } }) },
            { streaming: true, taskType: "reranking" },
            async (call) => {
              // One attempt that sent the lean request, was refused and sent the previous shape.
              await call.fetch(async () => new Response("{}"), "https://fixture.invalid", {}, lean);
              await call.fetch(async () => new Response("{}"), "https://fixture.invalid", {}, full);
              throw new AiProviderError("refused", { kind: "http", transient: false, status: 400 });
            }
          )
      },
      watch
    );
    await expect(ai.runDefaultTask("reranking", "text")).rejects.toThrow("refused");
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      parameters: { requestOptions: full }
    });
    expect(watch.finish.mock.calls[0]?.[1]).toMatchObject({
      status: "failed",
      parameters: { requestOptions: full },
      // Both requests reached the provider, so both count.
      details: { attempts: 2 }
    });
  });

  it("records the wire options of a decide call that was canceled", async () => {
    const watch = monitoring();
    const lean = { reasoningEffort: "low", reasoningSummary: null, include: [] };
    const controller = new AbortController();
    const ai = service(
      {
        run: (_request, signal) =>
          runRemoteCall(
            { config: resolveAiRuntimeConfig({ retry: { maxAttempts: 1 } }) },
            { streaming: true, taskType: "reranking", signal },
            async (call) => {
              await call.fetch(async () => new Response("{}"), "https://fixture.invalid", {}, lean);
              controller.abort(new Error("canceled by the caller"));
              return call.guard(new Promise<string>(() => undefined));
            }
          )
      },
      watch
    );
    await expect(ai.runDefaultTask("reranking", "text", {}, controller.signal)).rejects.toThrow(
      "canceled by the caller"
    );
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({
      status: "canceled",
      parameters: { requestOptions: lean }
    });
    expect(watch.finish.mock.calls[0]?.[1]).toMatchObject({
      status: "canceled",
      parameters: { requestOptions: lean },
      details: { attempts: 1 }
    });
  });

  it("records no tokens for a failed call whose provider reported none", async () => {
    const ai = service({
      run: () =>
        runRemoteCall(
          { config: resolveAiRuntimeConfig({ retry: { maxAttempts: 1 } }) },
          { streaming: false },
          async () => {
            throw new AiProviderError("rejected", { kind: "http", transient: false, status: 400 });
          }
        )
    });
    await expect(ai.runDefaultTask("summarization", "text")).rejects.toThrow("rejected");
    const recorded = state.record.mock.calls[0]?.[0];
    expect(recorded).toMatchObject({ status: "failed" });
    expect(recorded).not.toHaveProperty("inputTokens");
    expect(recorded).not.toHaveProperty("outputTokens");
  });
});
