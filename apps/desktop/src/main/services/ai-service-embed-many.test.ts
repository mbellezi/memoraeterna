import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedManyLimits, type AiEmbedManyResult, type AiTaskRequest } from "@app/ai";
import { bumpAiConfigGeneration } from "@app/db";
import { AiService, embeddingSpaceKey } from "./ai-service.js";

const state = vi.hoisted(() => ({
  selection: {} as Record<string, unknown>,
  providers: [] as Array<Record<string, unknown>>,
  getDefaultTask: vi.fn(),
  listProviders: vi.fn(),
  record: vi.fn(),
  secret: vi.fn(),
  setAiExecution: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: state.getDefaultTask,
    listProviders: state.listProviders,
    recordTaskRun: state.record,
    // A task without a route looks for a profile to route it to: there is none.
    listTaskRoutes: async () => [],
    listProfiles: async () => [],
    seedTaskRoute: async () => false
  }),
  createLocalModelRepository: () => ({ findById: async () => null }),
  createJobRepository: () => ({ setAiExecution: state.setAiExecution })
}));
vi.mock("./credential-service.js", () => ({
  CredentialService: class {
    public get = state.secret;
    public save = vi.fn();
    public remove = vi.fn();
  }
}));

const profileId = "00000000-0000-4000-8000-000000000001";
const configId = "00000000-0000-4000-8000-0000000000c1";
const otherConfigId = "00000000-0000-4000-8000-0000000000c2";
const pool = {} as never;

/** A vector that depends on the text only, so batches and single calls agree. */
const vectorOf = (text: string) => [text.length, text.charCodeAt(0) % 7, 1, 0];

const providerRow = (id: string, credentialRef: string) => ({
  id,
  provider: "openai-compatible",
  displayName: id,
  credentialRef,
  baseUrl: `https://${id}.test/v1`,
  defaultParameters: {},
  status: "configured",
  metadata: { modelId: "embed-model", capabilities: ["embedding"] },
  createdAt: new Date(),
  updatedAt: new Date()
});

function routeOf(id: string) {
  return {
    routeKey: "embedding",
    profileId,
    privacyMode: "allow_remote",
    providerConfigId: id,
    localModelId: null,
    provider: "openai-compatible",
    credentialRef: "ref",
    baseUrl: `https://${id}.test/v1`,
    modelId: "embed-model",
    runtime: "remote",
    managedPath: null,
    repository: null,
    revision: null,
    quantization: null,
    requiredCapabilities: ["embedding"],
    parameters: {},
    modelDefaultParameters: {},
    providerMetadata: { modelId: "embed-model", capabilities: ["embedding"] },
    outputLanguage: "en"
  };
}

function service() {
  return new AiService({
    userDataPath: "/tmp/embed-many-tests",
    getPool: () => pool,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    lanes: { mode: "serial" }
  });
}

/** What the audit rows of the calls say, in order. */
const rows = () => state.record.mock.calls.map(([row]) => row as Record<string, unknown>);

describe("AiService.embedMany", () => {
  beforeEach(() => {
    state.selection = routeOf(configId);
    state.getDefaultTask.mockReset().mockImplementation(async () => state.selection);
    state.listProviders.mockReset().mockResolvedValue([providerRow(configId, "ref-1")]);
    state.record.mockReset().mockResolvedValue("00000000-0000-4000-8000-0000000000aa");
    state.secret.mockReset().mockResolvedValue("secret-key");
    state.setAiExecution.mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** A server that answers every embedding request, single or batched, and remembers them. */
  function server() {
    const requests: Array<{ url: string; auth: string; input: string | string[] }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string | string[] };
      const texts = Array.isArray(body.input) ? body.input : [body.input];
      requests.push({
        url: String(url),
        auth: String((init?.headers as Record<string, string>).authorization),
        input: body.input
      });
      return Response.json({
        data: texts.map((text, index) => ({ index, embedding: vectorOf(text) })),
        usage: { prompt_tokens: texts.length * 3, total_tokens: texts.length * 3 }
      });
    });
    vi.stubGlobal("fetch", fetch);
    return { fetch, requests };
  }

  const context = { stage: "embedding", priority: "P2" as const };

  it("embeds the texts in batches of at most 32, one lane request and one audit row each", async () => {
    const { requests } = server();
    const texts = Array.from({ length: 70 }, (_, index) => `chunk number ${index}`);
    const result = await service().embedMany(texts, context);
    expect(embedManyLimits.perExecution).toBe(32);
    expect(requests.map((request) => (request.input as string[]).length)).toEqual([32, 32, 6]);
    expect(result!.embeddings).toHaveLength(70);
    expect(result!.embeddings[69]).toEqual(vectorOf("chunk number 69"));
    expect(result).toMatchObject({ calls: 3, providerId: "openai-compatible" });
    expect(result!.aiTaskRunIds).toHaveLength(3);
    // One audit row per execution, saying how many texts it embedded.
    expect(rows().map((row) => (row.parameters as Record<string, unknown>).items)).toEqual([
      32, 32, 6
    ]);
    expect(rows()).toSatisfy((all: Array<Record<string, unknown>>) =>
      all.every(
        (row) =>
          row.taskType === "embedding" &&
          row.status === "succeeded" &&
          row.workloadClass === "embed" &&
          typeof row.inputHash === "string" &&
          typeof row.outputHash === "string"
      )
    );
    expect(rows()[2]).toMatchObject({ inputTokens: 18 });
  });

  it("writes the space key a single call writes, so the F2 tree never sees a space change", async () => {
    server();
    const ai = service();
    const batch = await ai.embedMany(["alpha", "beta"], context);
    const single = await ai.runDefaultTask("embedding", "alpha", {
      ...context,
      workloadClass: "embed"
    });
    expect(batch!.embeddingSpaceKey).toBe(single!.embeddingSpaceKey);
    expect(batch!.embeddingSpaceKey).toBe(await ai.embeddingRouteSpaceKey());
    expect(batch!.embeddings[0]).toEqual(single!.output);
  });

  it("returns null when no embedding model is routed, and for nothing to embed", async () => {
    server();
    state.getDefaultTask.mockResolvedValue(null);
    await expect(service().embedMany(["a"], context)).resolves.toBeNull();
    await expect(service().embedMany([], context)).resolves.toBeNull();
  });

  it("runs the texts one by one inside one lane request when the adapter has no embedMany", async () => {
    const ai = service();
    const run = vi.fn(async (request: AiTaskRequest) => ({
      taskType: request.taskType,
      output: vectorOf(String(request.input)),
      providerId: "openai-compatible",
      modelId: "embed-model",
      runtime: "remote" as const,
      durationMs: 2,
      inputTokens: 3
    }));
    const adapter = {
      describe: () => ({
        providerId: "openai-compatible",
        modelId: "embed-model",
        runtime: "remote" as const,
        capabilities: ["embedding" as const],
        parameterCapabilities: {}
      }),
      canHandle: () => true,
      run
    };
    const internals = ai as unknown as {
      createAdapter: () => Promise<unknown>;
      registerAdapter: (adapter: unknown) => unknown;
    };
    vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
      internals.registerAdapter(adapter)
    );
    const result = await ai.embedMany(["one", "three"], context);
    expect(run.mock.calls.map(([request]) => request.input)).toEqual(["one", "three"]);
    expect(result!.embeddings).toEqual([vectorOf("one"), vectorOf("three")]);
    // The two single calls were one execution with one audit row.
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      inputTokens: 6,
      parameters: expect.objectContaining({ items: 2 })
    });
  });

  it("records a failed batch with its item count and rethrows", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("no", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(service().embedMany(["a", "b", "c"], context)).rejects.toThrow();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      status: "failed",
      parameters: expect.objectContaining({ items: 3 })
    });
  });

  it("refuses a result that holds fewer vectors than texts", async () => {
    const ai = service();
    const adapter = {
      describe: () => ({
        providerId: "openai-compatible",
        modelId: "embed-model",
        runtime: "remote" as const,
        capabilities: ["embedding" as const],
        parameterCapabilities: {}
      }),
      canHandle: () => true,
      run: vi.fn(),
      embedMany: async (texts: readonly string[]): Promise<AiEmbedManyResult> => ({
        embeddings: texts.slice(1).map(vectorOf),
        providerId: "openai-compatible",
        modelId: "embed-model",
        runtime: "remote",
        durationMs: 1
      })
    };
    const internals = ai as unknown as {
      createAdapter: () => Promise<unknown>;
      registerAdapter: (adapter: unknown) => unknown;
    };
    vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
      internals.registerAdapter(adapter)
    );
    await expect(ai.embedMany(["a", "b"], context)).rejects.toThrow(
      "did not contain a vector for every text"
    );
  });

  it("keeps the embedding space key of every kind of route byte for byte (D26, D37)", () => {
    // Pinned from the code before batching: a stored vector's strategy carries this key, so a
    // different key would make the F2 tree see a space change and re-embed the library.
    const none = { quantization: null, revision: null, localModelId: null, promptStrategy: null };
    const routes = [
      {
        selection: {
          ...none,
          providerConfigId: null,
          baseUrl: null,
          localModelId: "00000000-0000-4000-8000-0000000000d1",
          repository: "Qwen/Qwen3-Embedding-0.6B-GGUF",
          quantization: "Q8_0",
          revision: "rev-1",
          parameters: { dimensions: 768 }
        },
        adapter: { providerId: "local-gguf", modelId: "qwen3-embedding-0.6b", runtime: "local" },
        key: "8275fc67808ee3f5f7dba5f1a3db6e22623bdb4f87ada14391ab9d9245ab1eaa"
      },
      {
        selection: {
          ...none,
          providerConfigId: "00000000-0000-4000-8000-0000000000c1",
          baseUrl: "https://api.example.test/v1",
          repository: null,
          parameters: { dimensions: 768 }
        },
        adapter: {
          providerId: "openai-compatible",
          modelId: "text-embedding-3-small",
          runtime: "remote"
        },
        key: "e7a6e4b89032db2f2e32408ec6a8820eaea5af458717da100cf9321354ea9c28"
      },
      {
        selection: {
          ...none,
          providerConfigId: "00000000-0000-4000-8000-0000000000c2",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          repository: null,
          parameters: { dimensions: 256 }
        },
        adapter: { providerId: "google", modelId: "gemini-embedding-001", runtime: "remote" },
        key: "33a22dcc4b4b65148d9df2b2547826a1d73f3ac7a6b4607013829be7575fe62c"
      }
    ];
    for (const route of routes)
      expect(embeddingSpaceKey(route.selection, route.adapter)).toBe(route.key);
    // Any change of the identity is another space.
    expect(
      embeddingSpaceKey(
        { ...routes[0]!.selection, parameters: { dimensions: 256 } },
        routes[0]!.adapter
      )
    ).not.toBe(routes[0]!.key);
  });
});

describe("the hot path of an AI call reads the configuration once (F3 D38)", () => {
  beforeEach(() => {
    state.selection = routeOf(configId);
    state.getDefaultTask.mockReset().mockImplementation(async () => state.selection);
    state.listProviders.mockReset().mockResolvedValue([providerRow(configId, "ref-1")]);
    state.record.mockReset().mockResolvedValue("00000000-0000-4000-8000-0000000000aa");
    state.secret.mockReset().mockResolvedValue("secret-key");
    state.setAiExecution.mockReset().mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { input: string | string[] };
        const texts = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({
          data: texts.map((text, index) => ({ index, embedding: vectorOf(text) }))
        });
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const embed = (ai: AiService, text: string, extra: Record<string, unknown> = {}) =>
    ai.runDefaultTask("embedding", text, {
      workloadClass: "embed",
      priority: "P2",
      embeddingInputType: "document",
      ...extra
    });

  it("reads the route, the provider rows and the credential once for many calls", async () => {
    const ai = service();
    for (let call = 0; call < 6; call += 1) await embed(ai, `text ${call}`);
    // Admission resolves the route with its keys, the recheck inside the lane with the profile.
    expect(state.getDefaultTask).toHaveBeenCalledTimes(2);
    expect(state.listProviders).toHaveBeenCalledTimes(1);
    expect(state.secret).toHaveBeenCalledTimes(1);
    expect(state.record).toHaveBeenCalledTimes(6);
  });

  it("reads the execution metadata of a job once, not for every call", async () => {
    const ai = service();
    for (let call = 0; call < 4; call += 1) await embed(ai, `text ${call}`, { jobId: "job-1" });
    await embed(ai, "other job", { jobId: "job-2" });
    expect(state.setAiExecution).toHaveBeenCalledTimes(2);
    expect(state.setAiExecution.mock.calls.map(([id]) => id)).toEqual(["job-1", "job-2"]);
  });

  it("keeps one adapter until the configuration changes, then builds it again", async () => {
    const ai = service();
    await embed(ai, "one");
    await embed(ai, "two");
    expect(state.secret).toHaveBeenCalledTimes(1);
    // Any writer of the configuration (the repositories and the credential service report it).
    bumpAiConfigGeneration();
    await embed(ai, "three");
    expect(state.secret).toHaveBeenCalledTimes(2);
    expect(state.listProviders).toHaveBeenCalledTimes(2);
    await embed(ai, "four");
    expect(state.secret).toHaveBeenCalledTimes(2);
  });

  it("sees a route that was changed after the cache filled once a writer reports it", async () => {
    const ai = service();
    await embed(ai, "one");
    state.selection = { ...routeOf(configId), modelId: "other-model" };
    // The change is not visible to a cache nobody told, which is why every writer reports itself.
    await embed(ai, "two");
    expect(rows().at(-1)).toMatchObject({ modelId: "embed-model" });
    bumpAiConfigGeneration();
    state.listProviders.mockResolvedValue([
      {
        ...providerRow(configId, "ref-1"),
        metadata: { modelId: "other-model", capabilities: ["embedding"] }
      }
    ]);
    await embed(ai, "three");
    expect(rows().at(-1)).toMatchObject({ modelId: "other-model" });
  });

  it("fails a call whose route changed while it waited for its lane, once a writer reports the change", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const answer = (init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body)) as { input: string | string[] };
      const texts = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({
        data: texts.map((text, index) => ({ index, embedding: vectorOf(text) }))
      });
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        started.resolve();
        await gate.promise;
        return answer(init);
      })
    );
    const ai = service();
    const first = embed(ai, "holds the lane");
    await started.promise;
    // Admitted with the route it has now, then waits behind the first call.
    const second = embed(ai, "waits");
    await vi.waitFor(() => expect(state.getDefaultTask).toHaveBeenCalledTimes(2));
    state.selection = { ...routeOf(configId), modelId: "another-model" };
    bumpAiConfigGeneration();
    gate.resolve();
    await first;
    await expect(second).rejects.toThrow("organization.errors.modelChanged");
    expect(rows().at(-1)).toMatchObject({ status: "failed" });
  });

  it("never lets two configurations of one provider and model resolve each other's adapter", async () => {
    state.listProviders.mockResolvedValue([
      providerRow(configId, "ref-1"),
      providerRow(otherConfigId, "ref-2")
    ]);
    state.secret.mockImplementation(async (ref: string) => `key-of-${ref}`);
    const fetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const ai = service();
    state.selection = routeOf(configId);
    await embed(ai, "first");
    state.selection = routeOf(otherConfigId);
    bumpAiConfigGeneration();
    await embed(ai, "second");
    // Interleaved: the first configuration again, with the other still registered.
    state.selection = routeOf(configId);
    bumpAiConfigGeneration();
    await embed(ai, "third");
    const seen = fetch.mock.calls.map(([url, init]) => [
      String(url),
      (init as RequestInit).headers as Record<string, string>
    ]);
    expect(seen.map(([url]) => String(url).split("/")[2])).toEqual([
      `${configId}.test`,
      `${otherConfigId}.test`,
      `${configId}.test`
    ]);
    expect(seen.map(([, headers]) => (headers as Record<string, string>).authorization)).toEqual([
      "Bearer key-of-ref-1",
      "Bearer key-of-ref-2",
      "Bearer key-of-ref-1"
    ]);
  });

  it("builds an adapter once for calls that run at the same time", async () => {
    const ai = service();
    await Promise.all(Array.from({ length: 5 }, (_, index) => embed(ai, `text ${index}`)));
    expect(state.secret).toHaveBeenCalledTimes(1);
    expect(state.listProviders).toHaveBeenCalledTimes(1);
  });
});
