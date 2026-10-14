import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiService } from "./ai-service.js";

const repository = vi.hoisted(() => ({
  getDefaultTask: vi.fn(),
  recordTaskRun: vi.fn(),
  listProfiles: vi.fn(),
  listProviders: vi.fn(),
  listProfileTasks: vi.fn(),
  listTaskRoutes: vi.fn(),
  setTaskRoute: vi.fn(),
  setProfileTask: vi.fn(),
  seedTaskRoute: vi.fn(),
  updateProfile: vi.fn(),
  upsertProvider: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => repository,
  createLocalModelRepository: () => ({ findById: async () => null })
}));

const profileId = "00000000-0000-4000-8000-000000000001";
const otherProfileId = "00000000-0000-4000-8000-000000000002";

function newService() {
  return new AiService({
    userDataPath: "/tmp/ai-routing-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false
  });
}

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: profileId,
  name: "Profile",
  description: null,
  isDefault: false,
  privacyMode: "allow_remote",
  outputLanguage: "ui",
  providerConfigId: "provider-1",
  localModelId: null,
  modelId: "model",
  runtime: "remote",
  capabilities: ["text-generation", "structured-output", "summarization"],
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides
});

const selection = (capabilities: string[]) => ({
  profileId,
  providerConfigId: "provider-1",
  localModelId: null,
  provider: "openai-compatible",
  modelId: "model",
  runtime: "remote",
  revision: null,
  repository: null,
  quantization: null,
  baseUrl: "https://example.test",
  parameters: {},
  modelDefaultParameters: {},
  providerMetadata: {},
  requiredCapabilities: capabilities
});

/** A service whose routed remote model declares `capabilities` and answers every call with "{}". */
function routedService(capabilities: string[]) {
  const ai = newService();
  const run = vi.fn(async (request: { taskType: string }) => ({
    taskType: request.taskType,
    output: "{}",
    providerId: "openai-compatible",
    modelId: "model",
    runtime: "remote",
    durationMs: 1
  }));
  const adapter = {
    describe: () => ({
      providerId: "openai-compatible",
      modelId: "model",
      capabilities,
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
  return { ai, run };
}

beforeEach(() => {
  for (const mock of Object.values(repository)) mock.mockReset();
  repository.listProfileTasks.mockResolvedValue([]);
  repository.listTaskRoutes.mockResolvedValue([]);
  repository.seedTaskRoute.mockResolvedValue(true);
  repository.recordTaskRun.mockResolvedValue("run-id");
});

describe("the decision route", () => {
  it("accepts a generative profile and writes no capability for it", async () => {
    repository.listProfiles.mockResolvedValue([profile()]);
    await newService().setTaskRoute({ task: "reranking", profileId });
    expect(repository.setProfileTask).toHaveBeenCalledWith({
      profileId,
      task: "reranking",
      parameters: {}
    });
    expect(repository.setTaskRoute).toHaveBeenCalledWith("reranking", profileId);
    expect(repository.upsertProvider).not.toHaveBeenCalled();
    expect(repository.updateProfile).not.toHaveBeenCalled();
  });

  it("refuses a profile that cannot decide and a task the profile cannot serve", async () => {
    repository.listProfiles.mockResolvedValue([profile({ capabilities: ["embedding"] })]);
    await expect(newService().setTaskRoute({ task: "reranking", profileId })).rejects.toThrow(
      "errors.ai.noCompatibleModel"
    );
    repository.listProfiles.mockResolvedValue([profile({ capabilities: ["text-generation"] })]);
    await expect(newService().setTaskRoute({ task: "summarization", profileId })).rejects.toThrow(
      "errors.ai.noCompatibleModel"
    );
    expect(repository.setTaskRoute).not.toHaveBeenCalled();
  });

  it("does not tag a saved generative model as a reranker", async () => {
    repository.upsertProvider.mockImplementation(async (input) => ({
      id: "provider-1",
      credentialRef: null,
      baseUrl: null,
      defaultParameters: {},
      status: "configured",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...input
    }));
    const saved = await newService().saveProvider({
      provider: "openai-compatible",
      displayName: "Local",
      modelId: "qwen",
      capabilities: ["text-generation", "structured-output"],
      defaultParameters: {}
    } as never);
    expect(repository.upsertProvider.mock.calls[0]?.[0].metadata.capabilities).toEqual([
      "text-generation",
      "structured-output"
    ]);
    expect(saved.capabilities).toEqual(["text-generation", "structured-output"]);
  });

  it("lists providers and profiles without rewriting their capabilities", async () => {
    repository.listProviders.mockResolvedValue([]);
    repository.listProfiles.mockResolvedValue([profile()]);
    const ai = newService();
    await expect(ai.listProviders()).resolves.toEqual([]);
    await expect(ai.listProfiles()).resolves.toHaveLength(1);
  });

  it("runs a generative model as a decision-only decider and audits what it really used", async () => {
    const { ai, run } = routedService(["text-generation", "structured-output"]);
    repository.getDefaultTask.mockResolvedValue(
      selection(["text-generation", "structured-output"])
    );
    await expect(ai.runDefaultTask("reranking", "decide")).resolves.toMatchObject({ output: "{}" });
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      taskType: "reranking",
      requiredCapabilities: ["structured-output"]
    });
    expect(repository.recordTaskRun.mock.calls[0]?.[0]).toMatchObject({
      taskType: "reranking",
      status: "succeeded",
      capabilitiesUsed: ["structured-output"]
    });
  });

  it("keeps requiring the reranking capability of a model that declares it", async () => {
    const { ai, run } = routedService(["reranking", "text-generation"]);
    repository.getDefaultTask.mockResolvedValue(selection(["reranking", "text-generation"]));
    await ai.runDefaultTask("reranking", "decide");
    expect(run.mock.calls[0]?.[0]).toMatchObject({ requiredCapabilities: ["reranking"] });
  });

  it("fails visibly when the routed model cannot decide", async () => {
    const { ai, run } = routedService(["embedding"]);
    repository.getDefaultTask.mockResolvedValue(selection(["embedding"]));
    await expect(ai.runDefaultTask("reranking", "decide")).rejects.toThrow(
      "errors.ai.noCompatibleModel"
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe("seeding task routes from the first configured profile", () => {
  const generative = {
    id: profileId,
    isDefault: true,
    createdAt: new Date("2026-03-01T00:00:00Z"),
    capabilities: ["text-generation", "structured-output", "summarization"]
  };
  const embedding = {
    id: otherProfileId,
    name: "Embedding",
    providerConfigId: null,
    localModelId: "local-1",
    runtime: "gguf",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    capabilities: ["embedding"]
  };

  it("routes each missing task to the first configured profile that can serve it", async () => {
    repository.listTaskRoutes.mockResolvedValue([
      { task: "summarization", profileId: otherProfileId }
    ]);
    repository.listProfiles.mockResolvedValue([
      profile(embedding),
      profile(generative),
      profile({ id: "unconfigured", modelId: null, capabilities: ["embedding", "text-generation"] })
    ]);
    repository.getDefaultTask.mockResolvedValue(null);
    await expect(newService().runDefaultTask("text-generation", "hello")).resolves.toBeNull();
    const seeded = Object.fromEntries(repository.seedTaskRoute.mock.calls);
    expect(seeded).toEqual({
      embedding: otherProfileId,
      "text-generation": profileId,
      "structured-output": profileId,
      "knowledge-graph-generation": profileId,
      // No profile offers atomic-note generation; a generative model decides explicitly.
      reranking: profileId
    });
    // The default profile goes first, and an existing route is never replaced.
    expect(repository.seedTaskRoute).not.toHaveBeenCalledWith("summarization", expect.anything());
  });

  it("looks the task up again once routes were seeded and runs it", async () => {
    repository.listProfiles.mockResolvedValue([profile(generative)]);
    repository.getDefaultTask
      .mockResolvedValueOnce(null)
      .mockResolvedValue(selection(generative.capabilities));
    const { ai, run } = routedService(generative.capabilities);
    await expect(ai.runDefaultTask("summarization", "text")).resolves.toMatchObject({
      output: "{}"
    });
    expect(repository.seedTaskRoute).toHaveBeenCalledWith("summarization", profileId);
    expect(run).toHaveBeenCalledOnce();
  });

  it("leaves a task unrouted when no profile can serve it", async () => {
    repository.listProfiles.mockResolvedValue([profile(generative)]);
    repository.getDefaultTask.mockResolvedValue(null);
    await expect(newService().runDefaultTask("embedding", "text")).resolves.toBeNull();
    expect(repository.seedTaskRoute).not.toHaveBeenCalledWith("embedding", expect.anything());
    // The task is looked up again after seeding even when nothing was seeded for it.
    expect(repository.getDefaultTask).toHaveBeenCalledTimes(2);
  });

  it("does not touch routes while the task resolves", async () => {
    repository.getDefaultTask.mockResolvedValue(selection(generative.capabilities));
    const { ai } = routedService(generative.capabilities);
    await ai.runDefaultTask("summarization", "text");
    expect(repository.listTaskRoutes).not.toHaveBeenCalled();
    expect(repository.seedTaskRoute).not.toHaveBeenCalled();
  });

  it("seeds when a profile gets its model, without changing routes that exist", async () => {
    repository.listProviders.mockResolvedValue([
      {
        id: "provider-1",
        metadata: { modelId: "model", capabilities: ["text-generation", "structured-output"] }
      }
    ]);
    repository.updateProfile.mockResolvedValue(profile(generative));
    repository.listProfiles.mockResolvedValue([profile(generative)]);
    repository.listTaskRoutes.mockResolvedValue([{ task: "text-generation", profileId: "other" }]);
    await newService().updateProfile({
      id: profileId,
      providerConfigId: "provider-1",
      modelId: "model",
      runtime: "remote",
      capabilities: ["text-generation", "structured-output"]
    });
    const tasks = repository.seedTaskRoute.mock.calls.map(([task]) => task);
    expect(tasks).toContain("structured-output");
    expect(tasks).toContain("reranking");
    expect(tasks).not.toContain("text-generation");
  });
});
