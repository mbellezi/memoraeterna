import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiCassette,
  AiModelRegistry,
  GoogleGeminiAdapter,
  NodeLlamaCppAdapter,
  OpenAiCompatibleAdapter,
  aiCassetteReplayedUsageKey,
  aiCassetteRequestKey,
  embedManyLimits,
  embedManyTaskResult,
  type AiEmbedManyOptions,
  type AiEmbedManyResult,
  type AiModelAdapter,
  type AiModelDescriptor,
  type AiTaskRequest,
  type AiTaskResult,
  type LocalEmbeddingBatch
} from "./index.js";

/** A vector that depends on the text only, so a single call and a batch must agree. */
function vectorOf(text: string, dimensions = 4): number[] {
  const seed = [...text].reduce((total, character) => total + character.charCodeAt(0), 0);
  return Array.from({ length: dimensions }, (_, index) => ((seed + index) % 17) / 17);
}

const embeddingRequest = (
  text: string,
  parameters: Record<string, unknown> = {}
): AiTaskRequest => ({
  taskType: "embedding",
  input: text,
  modelId: "embed-model",
  requiredCapabilities: [],
  parameters: { dimensions: 4, ...parameters },
  metadata: { applicationInstruction: "" }
});
const batchOptions = (extra: Partial<AiEmbedManyOptions> = {}): AiEmbedManyOptions => ({
  modelId: "embed-model",
  dimensions: 4,
  parameters: { dimensions: 4 },
  ...extra
});

describe("OpenAI-compatible embedMany", () => {
  function adapter(fetch: typeof globalThis.fetch) {
    return new OpenAiCompatibleAdapter({
      baseUrl: "https://example.test/v1",
      apiKey: "secret-key",
      modelId: "embed-model",
      capabilities: ["embedding"],
      fetch,
      runtime: { retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } },
      random: () => 0.5
    });
  }
  const bodyOf = (init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input: string | string[];
      dimensions: number;
    };
    // A single request sends its text alone; the fake answers it as a batch of one.
    return { ...body, input: Array.isArray(body.input) ? body.input : [body.input] };
  };
  const embeddingsFor = (input: string[], order: number[] = input.map((_, index) => index)) =>
    order.map((index) => ({ index, embedding: vectorOf(input[index]!) }));

  it("sends the texts as one array and returns the vectors in the order of the texts", async () => {
    const bodies: Array<ReturnType<typeof bodyOf>> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = bodyOf(init);
      bodies.push(body);
      // The server may list the rows in any order; each carries its index.
      return Response.json({
        data: embeddingsFor(body.input, [2, 0, 1]),
        usage: { prompt_tokens: 9, total_tokens: 9 }
      });
    });
    const result = await adapter(fetch).embedMany(["alpha", "beta", "gamma"], batchOptions());
    expect(bodies).toEqual([
      { model: "embed-model", input: ["alpha", "beta", "gamma"], dimensions: 4 }
    ]);
    expect(result.embeddings).toEqual([vectorOf("alpha"), vectorOf("beta"), vectorOf("gamma")]);
    expect(result).toMatchObject({
      providerId: "openai-compatible",
      modelId: "embed-model",
      runtime: "remote",
      inputTokens: 9,
      attempts: 1
    });
  });

  it("gives the vector a request with that text alone gives", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = bodyOf(init);
      return Response.json({ data: embeddingsFor(body.input), usage: { prompt_tokens: 1 } });
    });
    const embedding = adapter(fetch);
    const many = await embedding.embedMany(["one", "two"], batchOptions());
    const single = [
      (await embedding.run(embeddingRequest("one"))).output,
      (await embedding.run(embeddingRequest("two"))).output
    ];
    expect(many.embeddings).toEqual(single);
  });

  it("splits a longer list into requests of at most 64 texts and adds up their usage", async () => {
    const sizes: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = bodyOf(init);
      sizes.push(body.input.length);
      return Response.json({
        data: embeddingsFor(body.input),
        usage: { prompt_tokens: body.input.length, total_tokens: body.input.length }
      });
    });
    const texts = Array.from({ length: 130 }, (_, index) => `text ${index}`);
    const result = await adapter(fetch).embedMany(texts, batchOptions());
    expect(embedManyLimits.perRequest).toBe(64);
    expect(sizes).toEqual([64, 64, 2]);
    expect(result.embeddings).toHaveLength(130);
    expect(result.embeddings[129]).toEqual(vectorOf("text 129"));
    expect(result.inputTokens).toBe(130);
    expect(result.tokenUsage).toMatchObject({ inputTokens: 130, totalTokens: 130 });
    expect(result.attempts).toBe(3);
  });

  it("refuses a response that lacks a vector for a text", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const body = bodyOf(init);
      return Response.json({ data: embeddingsFor(body.input).slice(1) });
    });
    await expect(adapter(fetch).embedMany(["a", "b"], batchOptions())).rejects.toThrow(
      "did not contain a vector for every text"
    );
  });

  it("asks for nothing when there is nothing to embed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await adapter(fetch).embedMany([], batchOptions());
    expect(result.embeddings).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Gemini embedMany", () => {
  function gemini(fetch: typeof globalThis.fetch) {
    return new GoogleGeminiAdapter({
      apiKey: "key",
      modelId: "gemini-embedding",
      capabilities: ["embedding"],
      baseUrl: "https://gemini.test/v1beta",
      fetch,
      runtime: { retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } },
      random: () => 0.5
    });
  }

  it("embeds the texts with batchEmbedContents, one vector per text in order", async () => {
    const seen: Array<{ url: string; body: { requests: Array<Record<string, unknown>> } }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const body = JSON.parse(String(init?.body)) as { requests: Array<Record<string, unknown>> };
      seen.push({ url: String(input), body });
      return Response.json({
        embeddings: body.requests.map((item) => ({
          values: vectorOf((item.content as { parts: Array<{ text: string }> }).parts[0]!.text)
        }))
      });
    });
    const result = await gemini(fetch).embedMany(["alpha", "beta"], {
      dimensions: 4,
      modelId: "gemini-embedding"
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("/models/gemini-embedding:batchEmbedContents");
    expect(seen[0]!.body.requests).toEqual([
      {
        model: "models/gemini-embedding",
        content: { parts: [{ text: "alpha" }] },
        outputDimensionality: 4
      },
      {
        model: "models/gemini-embedding",
        content: { parts: [{ text: "beta" }] },
        outputDimensionality: 4
      }
    ]);
    expect(result.embeddings).toEqual([vectorOf("alpha"), vectorOf("beta")]);
    expect(result).toMatchObject({ providerId: "google", modelId: "gemini-embedding" });
  });

  it("refuses a response with fewer vectors than texts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ embeddings: [{ values: [1] }] })
    );
    await expect(gemini(fetch).embedMany(["a", "b"], { dimensions: 4 })).rejects.toThrow(
      "did not contain a vector for every text"
    );
  });
});

describe("GGUF embedMany", () => {
  const single = vi.fn(
    async (input: { text: string; parameters: Record<string, unknown>; signal?: AbortSignal }) => ({
      output: vectorOf(input.text),
      inputTokens: input.text.length,
      durationMs: 3
    })
  );
  function gguf(
    batch?: (input: {
      modelPath: string;
      texts: readonly string[];
      parameters: Record<string, unknown>;
      signal?: AbortSignal;
    }) => Promise<LocalEmbeddingBatch>
  ) {
    return new NodeLlamaCppAdapter(
      {
        modelId: "embed-model",
        modelPath: "/models/embed.gguf",
        capabilities: ["embedding", "offline"]
      },
      undefined,
      single,
      batch
    );
  }
  beforeEach(() => {
    single.mockClear();
  });

  it("is the single calls one after another when the executor has no batch of its own", async () => {
    const result = await gguf().embedMany(["a", "bb", "ccc"], batchOptions());
    expect(single.mock.calls.map(([input]) => input.text)).toEqual(["a", "bb", "ccc"]);
    expect(result.embeddings).toEqual([vectorOf("a"), vectorOf("bb"), vectorOf("ccc")]);
    expect(result).toMatchObject({
      providerId: "local-gguf",
      modelId: "embed-model",
      runtime: "local",
      inputTokens: 6,
      itemInputTokens: [1, 2, 3],
      costEstimate: 0
    });
  });

  it("runs a batch executor once, under one deadline, with the effective parameters", async () => {
    const executeMany = vi.fn(
      async (input: { texts: readonly string[]; parameters: Record<string, unknown> }) => ({
        embeddings: input.texts.map((text) => vectorOf(text)),
        itemInputTokens: input.texts.map(() => 2),
        durationMs: 5
      })
    );
    const result = await gguf(executeMany).embedMany(
      ["x", "y"],
      batchOptions({ parameters: { dimensions: 4, contextWindow: 2048 } })
    );
    expect(executeMany).toHaveBeenCalledOnce();
    expect(executeMany.mock.calls[0]![0]).toMatchObject({
      texts: ["x", "y"],
      parameters: { dimensions: 4, contextWindow: 2048 }
    });
    expect(single).not.toHaveBeenCalled();
    expect(result.inputTokens).toBe(4);
  });

  it("stops at an aborted signal without embedding", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      gguf().embedMany(["a"], batchOptions({ signal: controller.signal }))
    ).rejects.toBeDefined();
    expect(single).not.toHaveBeenCalled();
  });
});

describe("cassette embedMany", () => {
  const descriptor: AiModelDescriptor = {
    providerId: "local-gguf",
    modelId: "embed-model",
    runtime: "local",
    capabilities: ["embedding", "offline"],
    parameterCapabilities: {},
    limits: {},
    requirements: { adapter: "node-llama-cpp", repository: "repo/embed", revision: "rev1" }
  };

  /** An adapter with both entry points; `batches` records what the real `embedMany` was asked. */
  class FakeEmbedder implements AiModelAdapter {
    public singles: string[] = [];
    public batches: string[][] = [];
    public constructor(
      private readonly description: AiModelDescriptor = descriptor,
      private readonly live = true
    ) {}
    public describe() {
      return this.description;
    }
    public canHandle() {
      return true;
    }
    public async run(request: AiTaskRequest): Promise<AiTaskResult> {
      if (!this.live) throw new Error("the runtime must not be called");
      const text = String(request.input);
      this.singles.push(text);
      return {
        taskType: "embedding",
        output: vectorOf(text),
        providerId: this.description.providerId,
        modelId: this.description.modelId,
        runtime: this.description.runtime,
        durationMs: 10,
        inputTokens: text.length,
        costEstimate: 0
      };
    }
    public async embedMany(texts: readonly string[]): Promise<AiEmbedManyResult> {
      if (!this.live) throw new Error("the runtime must not be called");
      this.batches.push([...texts]);
      return {
        embeddings: texts.map((text) => vectorOf(text)),
        itemInputTokens: texts.map((text) => text.length),
        inputTokens: texts.reduce((total, text) => total + text.length, 0),
        providerId: this.description.providerId,
        modelId: this.description.modelId,
        runtime: this.description.runtime,
        durationMs: 30,
        costEstimate: 0
      };
    }
  }

  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-embed-many-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const entryFiles = async () =>
    (await readdir(join(directory, "entries"), { recursive: true })).filter((name) =>
      name.endsWith(".json")
    );

  it("keys each text by the single request of that text", async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    await recorder.wrap(new FakeEmbedder()).embedMany!(["alpha", "beta"], batchOptions());
    const keys = (await entryFiles()).map((name) => name.split("/").at(-1)!.replace(".json", ""));
    const expected = ["alpha", "beta"].map(
      (text) => aiCassetteRequestKey(descriptor, embeddingRequest(text)).key
    );
    expect(keys.toSorted()).toEqual(expected.toSorted());
  });

  it("serves a batch from entries a single call recorded", async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    const single = recorder.wrap(new FakeEmbedder());
    await single.run(embeddingRequest("alpha"));
    await single.run(embeddingRequest("beta"));

    const offline = new FakeEmbedder(descriptor, false);
    const replay = new AiCassette({ mode: "replay", directory });
    const result = await replay.wrap(offline).embedMany!(["beta", "alpha"], batchOptions());
    expect(result.embeddings).toEqual([vectorOf("beta"), vectorOf("alpha")]);
    expect(result.replayedItems).toBe(2);
    expect(result.tokenUsage).toMatchObject({ [aiCassetteReplayedUsageKey]: 1 });
    expect(result.inputTokens).toBe("beta".length + "alpha".length);
    expect(replay.stats()).toMatchObject({ served: 2, misses: 0, recorded: 0 });
    expect(offline.batches).toEqual([]);
  });

  it("records a batch as single entries that a single call finds", async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    const live = new FakeEmbedder();
    await recorder.wrap(live).embedMany!(["alpha", "beta", "gamma"], batchOptions());
    expect(live.batches).toEqual([["alpha", "beta", "gamma"]]);
    expect(recorder.stats()).toMatchObject({ recorded: 3, served: 0 });

    const replay = new AiCassette({ mode: "replay", directory });
    const offline = replay.wrap(new FakeEmbedder(descriptor, false));
    for (const text of ["gamma", "alpha", "beta"]) {
      const served = await offline.run(embeddingRequest(text));
      expect(served.output).toEqual(vectorOf(text));
      expect(served.inputTokens).toBe(text.length);
    }
    expect(replay.stats()).toMatchObject({ served: 3, misses: 0 });
  });

  it("asks the runtime for the texts the cassette lacks and no others", async () => {
    await new AiCassette({ mode: "record", directory })
      .wrap(new FakeEmbedder())
      .run(embeddingRequest("beta"));
    // A later run resumes from the cassette: its occurrence counts start again.
    const recorder = new AiCassette({ mode: "record", directory });
    const live = new FakeEmbedder();
    const result = await recorder.wrap(live).embedMany!(["alpha", "beta", "gamma"], batchOptions());
    expect(live.batches).toEqual([["alpha", "gamma"]]);
    expect(result.embeddings).toEqual([vectorOf("alpha"), vectorOf("beta"), vectorOf("gamma")]);
    // Part of the batch ran live, so it is not reported as a replay.
    expect(result.tokenUsage?.[aiCassetteReplayedUsageKey]).toBeUndefined();
    expect(result.replayedItems).toBe(1);
    expect(recorder.stats()).toMatchObject({ recorded: 2, served: 1 });
  });

  it("makes the same text twice take the next recorded response, as two single calls do", async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    await recorder.wrap(new FakeEmbedder()).embedMany!(["alpha", "alpha"], batchOptions());
    const key = aiCassetteRequestKey(descriptor, embeddingRequest("alpha")).key;
    const entry = (await entryFiles()).find((name) => name.includes(key));
    expect(entry).toBeDefined();

    const replay = new AiCassette({ mode: "replay", directory });
    const wrapped = replay.wrap(new FakeEmbedder(descriptor, false));
    await wrapped.run(embeddingRequest("alpha"));
    await wrapped.run(embeddingRequest("alpha"));
    await expect(wrapped.run(embeddingRequest("alpha"))).rejects.toMatchObject({
      name: "AiCassetteMissError"
    });
  });

  it("fails a replayed batch on a miss and consumes none of its recorded responses", async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    await recorder.wrap(new FakeEmbedder()).run(embeddingRequest("alpha"));

    const replay = new AiCassette({ mode: "replay", directory });
    const wrapped = replay.wrap(new FakeEmbedder(descriptor, false));
    await expect(wrapped.embedMany!(["alpha", "missing"], batchOptions())).rejects.toMatchObject({
      name: "AiCassetteMissError",
      taskType: "embedding"
    });
    expect(replay.stats()).toMatchObject({ served: 0, misses: 1 });
    // The text that was in the cassette is still there for the retry.
    const retried = await wrapped.embedMany!(["alpha"], batchOptions());
    expect(retried.embeddings).toEqual([vectorOf("alpha")]);
  });

  it("lets a local miss run live under the live policy and records it", async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    await recorder.wrap(new FakeEmbedder()).run(embeddingRequest("alpha"));

    const replay = new AiCassette({ mode: "replay", directory, localMisses: "live" });
    const live = new FakeEmbedder();
    const result = await replay.wrap(live).embedMany!(["alpha", "beta"], batchOptions());
    expect(live.batches).toEqual([["beta"]]);
    expect(result.embeddings).toEqual([vectorOf("alpha"), vectorOf("beta")]);
    expect(replay.stats()).toMatchObject({ served: 1, misses: 0, liveLocalMisses: 1 });
  });

  it("waits a batch served whole for its entries' recorded time (T52b), freeing them when canceled", async () => {
    class RecordedSlowly extends FakeEmbedder {
      public override async run(request: AiTaskRequest): Promise<AiTaskResult> {
        return { ...(await super.run(request)), durationMs: 1000 };
      }
    }
    const single = new AiCassette({ mode: "record", directory }).wrap(new RecordedSlowly());
    await single.run(embeddingRequest("alpha"));
    await single.run(embeddingRequest("beta"));
    const waits: Array<{ ms: number; end: () => void; fail: (reason: unknown) => void }> = [];
    const replay = new AiCassette(
      { mode: "replay", directory, timing: "recorded" },
      undefined,
      (ms) => new Promise<void>((end, fail) => void waits.push({ ms, end, fail }))
    );
    const wrapped = replay.wrap(new FakeEmbedder(descriptor, false));
    const canceled = wrapped.embedMany!(["alpha", "beta"], batchOptions());
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    // Two single calls of 1 s each when they were recorded.
    expect(waits[0]!.ms).toBeGreaterThan(1500);
    expect(waits[0]!.ms).toBeLessThanOrEqual(2000);
    waits[0]!.fail(new Error("canceled"));
    await expect(canceled).rejects.toThrow("canceled");
    expect(replay.stats()).toMatchObject({ served: 0, misses: 0 });
    // The retry is served from the same entries.
    const served = wrapped.embedMany!(["alpha", "beta"], batchOptions());
    await vi.waitFor(() => expect(waits).toHaveLength(2));
    waits[1]!.end();
    await expect(served).resolves.toMatchObject({
      embeddings: [vectorOf("alpha"), vectorOf("beta")],
      replayedItems: 2
    });
    expect(replay.stats()).toMatchObject({ served: 2, timing: "recorded" });
  });

  it("counts the tokens of a remote batch against the live cap", async () => {
    const remote: AiModelDescriptor = {
      ...descriptor,
      providerId: "openai-compatible",
      runtime: "remote"
    };
    const recorder = new AiCassette({ mode: "record", directory });
    recorder.limitLiveTokens(10);
    const live = new FakeEmbedder(remote);
    const wrapped = recorder.wrap(live);
    await wrapped.embedMany!(["aaaaaaaaaaaa"], batchOptions());
    expect(recorder.stats().liveTokens).toBe(12);
    await expect(wrapped.embedMany!(["b"], batchOptions())).rejects.toMatchObject({
      code: "token_limit"
    });
    // A remote batch has no per-text count: the entries record none.
    expect(live.batches).toHaveLength(1);
  });

  it("offers no embedMany for an adapter that has none", () => {
    const plain: AiModelAdapter = {
      describe: () => descriptor,
      canHandle: () => true,
      run: async () => {
        throw new Error("unused");
      }
    };
    const wrapped = new AiCassette({ mode: "record", directory }).wrap(plain);
    expect(wrapped.embedMany).toBeUndefined();
  });

  it("builds the task result its single calls add up to", () => {
    expect(
      embedManyTaskResult({
        embeddings: [[1], [2]],
        itemInputTokens: [1, 1],
        replayedItems: 2,
        providerId: "p",
        modelId: "m",
        runtime: "local",
        durationMs: 1,
        inputTokens: 2
      })
    ).toEqual({
      taskType: "embedding",
      output: [[1], [2]],
      providerId: "p",
      modelId: "m",
      runtime: "local",
      durationMs: 1,
      inputTokens: 2
    });
  });
});

describe("the adapter registry keys", () => {
  const adapterOf = (name: string): AiModelAdapter => ({
    describe: () => ({
      providerId: "openai-compatible",
      modelId: "shared-model",
      runtime: "remote",
      capabilities: ["embedding"],
      parameterCapabilities: {},
      limits: {},
      requirements: { name }
    }),
    canHandle: () => true,
    run: async () => {
      throw new Error(name);
    }
  });

  it("keeps two configurations of one provider and model apart", () => {
    const registry = new AiModelRegistry();
    const first = adapterOf("first");
    const second = adapterOf("second");
    expect(registry.register(first, "config-1:shared-model")).toBe(first);
    registry.register(second, "config-2:shared-model");
    expect(registry.get("config-1:shared-model")).toBe(first);
    expect(registry.get("config-2:shared-model")).toBe(second);
    registry.unregisterKey("config-1:shared-model");
    expect(() => registry.get("config-1:shared-model")).toThrow("errors.ai.noCompatibleModel");
    expect(registry.get("config-2:shared-model")).toBe(second);
  });

  it("refuses an adapter that lacks a required capability", () => {
    const registry = new AiModelRegistry();
    registry.register(adapterOf("first"), "config-1:shared-model");
    expect(() => registry.get("config-1:shared-model", ["text-generation"])).toThrow(
      "errors.ai.noCompatibleModel"
    );
  });

  it("registers under providerId:modelId when no key is given", () => {
    const registry = new AiModelRegistry();
    const adapter = adapterOf("only");
    registry.register(adapter);
    expect(registry.get("openai-compatible:shared-model")).toBe(adapter);
    registry.unregister("openai-compatible", "shared-model");
    expect(registry.list()).toEqual([]);
  });
});
