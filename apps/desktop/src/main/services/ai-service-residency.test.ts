import {
  findLocalModelCatalogEntry,
  MlxAdapter,
  MlxRerankerAdapter,
  NodeLlamaCppAdapter,
  OpenAiCompatibleAdapter,
  type LocalAdapterOptions
} from "@app/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiService, embeddingSpaceKey } from "./ai-service.js";

/**
 * Minimal residency (D18, Q11) and the embedding space key (D26) of F2 T14: one generative, one
 * embedding and one ranker model stay loaded, never two generative ones; the ranker is exempt
 * from idle release; every MLX adapter shares one helper; the space key is known without a call.
 */

const state = vi.hoisted(() => ({
  selections: new Map<string, Record<string, unknown>>(),
  models: new Map<string, Record<string, unknown>>(),
  newest: null as null | { spaceKey: string },
  recordTaskRun: vi.fn()
}));

vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async (task: string, explicit?: string, keys: readonly string[] = [task]) => {
      const selection =
        (explicit ? state.selections.get(`${explicit}|${task}`) : undefined) ??
        keys.map((key) => state.selections.get(key)).find(Boolean) ??
        null;
      return selection ? { routeKey: task, ...selection } : null;
    },
    recordTaskRun: state.recordTaskRun,
    listTaskRoutes: async () => [],
    listProfiles: async () => [],
    seedTaskRoute: async () => false
  }),
  createLocalModelRepository: () => ({
    findById: async (id: string) => state.models.get(id) ?? null
  }),
  createEmbeddingRepository: () => ({ newestNoteVectorSpace: async () => state.newest })
}));

const generativeEntry = findLocalModelCatalogEntry("mlx-qwen3-4b-instruct-2507-4bit")!;
const embeddingEntry = findLocalModelCatalogEntry("gguf-qwen3-embedding-0.6b-q8-0")!;
const rankerEntry = findLocalModelCatalogEntry("mlx-qwen3-reranker-0.6b")!;

const ids = {
  profile: "00000000-0000-4000-8000-000000000001",
  generativeA: "00000000-0000-4000-8000-0000000000a1",
  generativeB: "00000000-0000-4000-8000-0000000000a2",
  embedding: "00000000-0000-4000-8000-0000000000e1",
  ranker: "00000000-0000-4000-8000-0000000000c1"
};

function localModel(
  id: string,
  entry: NonNullable<ReturnType<typeof findLocalModelCatalogEntry>>,
  overrides: Record<string, unknown> = {}
) {
  return {
    id,
    catalogId: entry.id,
    modelId: entry.repository,
    runtime: entry.runtime,
    repository: entry.repository,
    revision: entry.revision,
    quantization: entry.quantization,
    status: "ready",
    managedPath: `/nonexistent/local-models/${id}`,
    capabilities: [...entry.capabilities],
    defaultParameters: { ...entry.defaultParameters },
    metadata: {},
    ...overrides
  };
}

function localSelection(model: ReturnType<typeof localModel>, parameters = {}) {
  return {
    profileId: ids.profile,
    providerConfigId: null,
    localModelId: model.id,
    provider: `local-${model.runtime}`,
    modelId: model.modelId,
    runtime: model.runtime,
    revision: model.revision,
    repository: model.repository,
    quantization: model.quantization,
    baseUrl: null,
    parameters,
    modelDefaultParameters: model.defaultParameters,
    providerMetadata: {},
    requiredCapabilities: model.capabilities
  };
}

/** A fake local adapter that answers every task; `dispose` tells when it left its slot. */
function fakeLocal(model: { modelId: string; runtime: string }, capabilities: string[]) {
  const providerId = `local-${model.runtime}`;
  return {
    describe: () => ({
      providerId,
      modelId: model.modelId,
      runtime: "local",
      capabilities,
      parameterCapabilities: {},
      limits: {},
      requirements: {}
    }),
    canHandle: () => true,
    run: vi.fn(async (request: { taskType: string }) => ({
      taskType: request.taskType,
      output: request.taskType === "embedding" ? [0.6, 0.8] : "ok",
      providerId,
      modelId: model.modelId,
      runtime: "local",
      durationMs: 1
    })),
    runtimeBuild: async () => "build",
    dispose: vi.fn(async () => undefined)
  };
}

function service(options: { mlxHost?: unknown } = {}) {
  const ai = new AiService({
    userDataPath: "/tmp/ai-residency-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    getKeepLocalEmbeddingModelsLoaded: async () => true,
    ...(options.mlxHost ? { mlxHost: options.mlxHost as never } : {})
  });
  const internals = ai as unknown as {
    resident: Record<string, { localModelId: string; adapter: unknown } | undefined>;
    activeLocalModels: Set<string>;
    createLocalAdapter: (id: string) => Promise<unknown>;
    buildLocalAdapter: (model: Record<string, unknown>, capabilities: string[]) => unknown;
    buildRankerAdapter: (model: Record<string, unknown>, capabilities: string[]) => unknown;
    residentRanker: (model: Record<string, unknown>) => Promise<unknown>;
  };
  return { ai, internals };
}

/** A service whose local adapters are fakes; `built` lists them in creation order. */
function fakeService() {
  const { ai, internals } = service();
  const built: Array<ReturnType<typeof fakeLocal> & { localModelId: string }> = [];
  const create = (model: Record<string, unknown>, capabilities: string[]) => {
    const adapter = Object.assign(fakeLocal(model as never, capabilities), {
      localModelId: String(model.id)
    });
    built.push(adapter);
    return adapter;
  };
  vi.spyOn(internals, "buildLocalAdapter").mockImplementation(create);
  vi.spyOn(internals, "buildRankerAdapter").mockImplementation(create);
  return { ai, internals, built };
}

const generativeA = localModel(ids.generativeA, generativeEntry);
const generativeB = localModel(ids.generativeB, generativeEntry, {
  modelId: "mlx-community/another-generative-4bit"
});
const embedding = localModel(ids.embedding, embeddingEntry);
const ranker = localModel(ids.ranker, rankerEntry);

beforeEach(() => {
  state.selections.clear();
  state.models.clear();
  state.newest = null;
  state.recordTaskRun.mockReset().mockResolvedValue("run-id");
  for (const model of [generativeA, generativeB, embedding, ranker])
    state.models.set(model.id, model);
});

describe("residency", () => {
  it("never keeps two generative models resident, while the embedding model stays", async () => {
    const { ai, internals, built } = fakeService();
    state.selections.set("embedding", localSelection(embedding));
    state.selections.set("text-generation", localSelection(generativeA));
    await ai.runDefaultTask("embedding", "text");
    await ai.runDefaultTask("text-generation", "first");
    state.selections.set("text-generation", localSelection(generativeB));
    await ai.runDefaultTask("text-generation", "second");

    const [embeddingAdapter, first, second] = built;
    expect(built.map((adapter) => adapter.localModelId)).toEqual([
      ids.embedding,
      ids.generativeA,
      ids.generativeB
    ]);
    // The first generative model left before the second one was loaded.
    expect(first!.dispose).toHaveBeenCalledOnce();
    expect(first!.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      second!.run.mock.invocationCallOrder[0]!
    );
    expect(embeddingAdapter!.dispose).not.toHaveBeenCalled();
    expect(internals.resident.generate?.localModelId).toBe(ids.generativeB);
    expect(internals.resident.embed?.localModelId).toBe(ids.embedding);
  });

  it("refuses a second generative model while the first one runs a call", async () => {
    const { internals, built } = fakeService();
    await internals.createLocalAdapter(ids.generativeA);
    internals.activeLocalModels.add(ids.generativeA);

    await expect(internals.createLocalAdapter(ids.generativeB)).rejects.toThrow(
      "errors.localModels.modelBusy"
    );
    expect(built[0]!.dispose).not.toHaveBeenCalled();
    expect(internals.resident.generate?.localModelId).toBe(ids.generativeA);
  });

  it("keeps the ranker through idle releases, the embedding model when asked, and drops all on dispose", async () => {
    const { ai, internals, built } = fakeService();
    await internals.createLocalAdapter(ids.generativeA);
    await internals.createLocalAdapter(ids.embedding);
    await internals.residentRanker(ranker);
    const [generative, embeddingAdapter, rankerAdapter] = built;

    await ai.releaseLocalRuntime(false, true);
    expect(generative!.dispose).toHaveBeenCalledOnce();
    expect(embeddingAdapter!.dispose).not.toHaveBeenCalled();
    expect(rankerAdapter!.dispose).not.toHaveBeenCalled();

    await ai.releaseLocalRuntime(false, false);
    expect(embeddingAdapter!.dispose).toHaveBeenCalledOnce();
    expect(rankerAdapter!.dispose).not.toHaveBeenCalled();
    expect(internals.resident.rank?.localModelId).toBe(ids.ranker);

    await ai.dispose();
    expect(rankerAdapter!.dispose).toHaveBeenCalledOnce();
    expect(Object.values(internals.resident).filter(Boolean)).toEqual([]);
  });

  it("does not release a model that is running a call", async () => {
    const { ai, internals, built } = fakeService();
    await internals.createLocalAdapter(ids.generativeA);
    internals.activeLocalModels.add(ids.generativeA);

    await ai.releaseLocalRuntime(false, false);

    expect(built[0]!.dispose).not.toHaveBeenCalled();
  });

  it("runs every MLX adapter on one shared helper, which stops only when no MLX call runs", async () => {
    const host = { dispose: vi.fn(async () => undefined) };
    const { ai, internals } = service({ mlxHost: host });
    const generative = (await internals.createLocalAdapter(ids.generativeA)) as MlxAdapter;
    const rankerAdapter = internals.buildRankerAdapter(ranker, [
      "reranking",
      "offline",
      "local-files"
    ]) as MlxRerankerAdapter;
    expect(generative).toBeInstanceOf(MlxAdapter);
    expect((generative as unknown as { host: unknown }).host).toBe(host);
    expect((rankerAdapter as unknown as { host: unknown }).host).toBe(host);

    // A resident ranker running a call keeps the helper alive after the generative model left it.
    Object.assign(internals.resident, {
      rank: { localModelId: ids.ranker, adapter: rankerAdapter, runtime: "mlx" }
    });
    internals.activeLocalModels.add(ids.ranker);
    await ai.releaseLocalRuntime(false, true);
    expect(internals.resident.generate).toBeUndefined();
    expect(host.dispose).not.toHaveBeenCalled();

    internals.activeLocalModels.delete(ids.ranker);
    await ai.releaseLocalRuntime(false, true);
    expect(host.dispose).toHaveBeenCalledOnce();
    // Nothing left to unload: further idle releases keep the helper and its ranker.
    await ai.releaseLocalRuntime(false, true);
    expect(host.dispose).toHaveBeenCalledOnce();
    expect(internals.resident.rank?.localModelId).toBe(ids.ranker);
  });
});

describe("the embedding space key", () => {
  it("keeps the key every stored vector was written with", () => {
    // Values of the inline formula the key was extracted from (`native-v2:<key>` strategies).
    expect(
      embeddingSpaceKey(
        {
          providerConfigId: "provider-1",
          baseUrl: "https://example.test",
          localModelId: null,
          repository: null,
          quantization: null,
          revision: null,
          parameters: { dimensions: 1024 },
          promptStrategy: null
        },
        { providerId: "openai-compatible", modelId: "text-embedding-3-small", runtime: "remote" }
      )
    ).toBe("ed5c3139f9d6042568cc65965e22c92e25fefe8457325778f3a178bc73265aba");
    expect(
      embeddingSpaceKey(
        {
          providerConfigId: null,
          baseUrl: null,
          localModelId: ids.embedding,
          repository: "Qwen/Qwen3-Embedding-0.6B-GGUF",
          quantization: "Q8_0",
          revision: "r1",
          parameters: { dimensions: 768 },
          promptStrategy: "strategy-1"
        },
        { providerId: "local-gguf", modelId: "Qwen/Qwen3-Embedding-0.6B-GGUF", runtime: "local" }
      )
    ).toBe("b9929742f554dab43135dfee01ae23bd314fcadaf1897aa3557041083e3dc78b");
  });

  it("is the same without a call as after a remote embedding call", async () => {
    const { ai } = service();
    const capabilities = ["embedding"] as const;
    state.selections.set("embedding", {
      profileId: ids.profile,
      providerConfigId: "provider-1",
      localModelId: null,
      provider: "openai-compatible",
      modelId: "text-embedding-3-small",
      runtime: "remote",
      revision: null,
      repository: null,
      quantization: null,
      baseUrl: "https://example.test/v1",
      parameters: { dimensions: 1024, temperature: 0.4 },
      modelDefaultParameters: { dimensions: 768 },
      providerMetadata: { modelId: "text-embedding-3-small", capabilities: [...capabilities] },
      requiredCapabilities: [...capabilities]
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({ data: [{ embedding: [0.6, 0.8] }], usage: { prompt_tokens: 3 } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const internals = ai as unknown as {
      createAdapter: () => Promise<unknown>;
      registerAdapter: (adapter: unknown) => unknown;
    };
    vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
      internals.registerAdapter(
        new OpenAiCompatibleAdapter({
          apiKey: "test-key",
          modelId: "text-embedding-3-small",
          capabilities: [...capabilities],
          baseUrl: "https://example.test/v1",
          fetch
        })
      )
    );

    const called = await ai.runDefaultTask("embedding", "a note");
    const active = await ai.activeEmbeddingSpace();

    expect(fetch).toHaveBeenCalledOnce();
    expect(called?.embeddingSpaceKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(active).toMatchObject({
      spaceKey: called!.embeddingSpaceKey,
      provider: "openai-compatible",
      local: false,
      dimensions: 1024,
      newestNoteSpaceKey: null,
      confirmed: false
    });
  });

  it("is the same without a call as after a local embedding call, and confirms the newest vector", async () => {
    const { ai, internals } = service();
    state.selections.set("embedding", localSelection(embedding, { dimensions: 768 }));
    const original = internals.buildLocalAdapter.bind(ai);
    const embed = vi.fn(async () => ({ output: [0.6, 0.8], durationMs: 1 }));
    vi.spyOn(internals, "buildLocalAdapter").mockImplementation((model, capabilities) => {
      const real = original(model, capabilities) as unknown as { options: LocalAdapterOptions };
      return new NodeLlamaCppAdapter(real.options, vi.fn(), embed);
    });

    const called = await ai.runDefaultTask("embedding", "a note");
    state.newest = { spaceKey: called!.embeddingSpaceKey! };
    const active = await ai.activeEmbeddingSpace();

    expect(embed).toHaveBeenCalledOnce();
    expect(active).toMatchObject({
      spaceKey: called!.embeddingSpaceKey,
      provider: "local-gguf",
      modelId: embeddingEntry.repository,
      local: true,
      dimensions: 768,
      newestNoteSpaceKey: called!.embeddingSpaceKey,
      confirmed: true
    });

    state.newest = { spaceKey: "another-space" };
    await expect(ai.activeEmbeddingSpace()).resolves.toMatchObject({
      newestNoteSpaceKey: "another-space",
      confirmed: false
    });
  });

  it("is null when no embedding model is routed", async () => {
    const { ai } = service();
    await expect(ai.activeEmbeddingSpace()).resolves.toBeNull();
  });
});
