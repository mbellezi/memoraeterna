import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiService } from "./ai-service.js";

const repository = vi.hoisted(() => ({
  getDefaultTask: vi.fn(),
  recordTaskRun: vi.fn(),
  listProfiles: vi.fn(),
  listTaskRoutes: vi.fn(),
  seedTaskRoute: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => repository,
  createLocalModelRepository: () => ({ findById: async () => null })
}));

const remoteId = "00000000-0000-4000-8000-000000000001";
const localId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const generative = ["text-generation", "structured-output", "summarization", "embedding"];

const profile = (overrides: Record<string, unknown> = {}) => ({
  id: remoteId,
  name: "Profile",
  description: null,
  isDefault: false,
  privacyMode: "allow_remote",
  outputLanguage: "ui",
  providerConfigId: "provider-1",
  localModelId: null,
  modelId: "model",
  runtime: "remote",
  capabilities: generative,
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides
});
const local = (overrides: Record<string, unknown> = {}) =>
  profile({
    id: localId,
    providerConfigId: null,
    localModelId: "local-model",
    runtime: "mlx",
    privacyMode: "offline_only",
    ...overrides
  });

function newService() {
  return new AiService({
    userDataPath: "/tmp/ai-seeding-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false
  });
}

const selection = (capabilities: string[]) => ({
  profileId: remoteId,
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

/** A service whose routed model declares `capabilities` and answers every call with "{}". */
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
  repository.listTaskRoutes.mockResolvedValue([]);
  repository.seedTaskRoute.mockResolvedValue(true);
  repository.recordTaskRun.mockResolvedValue("run-id");
});

describe("two callers that find a task without a route", () => {
  it("both run it once one of them has seeded the route", async () => {
    const routed = new Set<string>();
    repository.listProfiles.mockResolvedValue([profile({ isDefault: true })]);
    repository.listTaskRoutes.mockImplementation(async () =>
      [...routed].map((task) => ({ task, profileId: remoteId }))
    );
    repository.seedTaskRoute.mockImplementation(async (task: string) => {
      if (routed.has(task)) return false;
      routed.add(task);
      return true;
    });
    let reads = 0;
    repository.getDefaultTask.mockImplementation(async (task: string) => {
      if (routed.has(task)) return selection(generative);
      // The second caller read before the first one seeded and is told so late.
      if (++reads === 2) await vi.waitFor(() => expect(routed.has(task)).toBe(true));
      return null;
    });
    const { ai, run } = routedService(generative);
    const results = await Promise.all([
      ai.runDefaultTask("summarization", "first"),
      ai.runDefaultTask("summarization", "second")
    ]);
    // The route exists for both callers, so neither is told that no model is configured.
    expect(results).toEqual([
      expect.objectContaining({ output: "{}" }),
      expect.objectContaining({ output: "{}" })
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("looks the task up again even when this call had nothing left to seed", async () => {
    repository.listProfiles.mockResolvedValue([profile({ isDefault: true })]);
    repository.listTaskRoutes.mockResolvedValue(
      ["summarization", "text-generation", "structured-output", "embedding"].map((task) => ({
        task,
        profileId: remoteId
      }))
    );
    repository.getDefaultTask.mockResolvedValueOnce(null).mockResolvedValue(selection(generative));
    const { ai, run } = routedService(generative);
    await expect(ai.runDefaultTask("summarization", "text")).resolves.toMatchObject({
      output: "{}"
    });
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("seeding stays on this machine when the default profile does", () => {
  const seeded = () => Object.fromEntries(repository.seedTaskRoute.mock.calls);

  it("never routes a task to a remote profile when the default profile is local", async () => {
    repository.listProfiles.mockResolvedValue([
      local({ isDefault: true, capabilities: ["text-generation", "embedding"] }),
      profile({ capabilities: generative })
    ]);
    repository.getDefaultTask.mockResolvedValue(null);
    await expect(newService().runDefaultTask("summarization", "text")).resolves.toBeNull();
    const routes = seeded();
    expect(routes["text-generation"]).toBe(localId);
    expect(routes.embedding).toBe(localId);
    // Only the remote profile could summarize, so the task stays unrouted instead of leaving the machine.
    expect(routes.summarization).toBeUndefined();
    expect(Object.values(routes)).not.toContain(remoteId);
  });

  it("follows the oldest configured profile when the default profile is not configured", async () => {
    repository.listProfiles.mockResolvedValue([
      profile({ id: otherId, isDefault: true, modelId: null, providerConfigId: null }),
      local({ createdAt: new Date("2026-01-01T00:00:00Z") }),
      profile({ createdAt: new Date("2026-02-01T00:00:00Z") })
    ]);
    repository.getDefaultTask.mockResolvedValue(null);
    await newService().runDefaultTask("summarization", "text");
    expect(Object.values(seeded())).not.toContain(remoteId);
    expect(Object.values(seeded())).toContain(localId);
  });

  it("lets a remote default use a local profile for what it cannot do and keeps remote candidates", async () => {
    repository.listProfiles.mockResolvedValue([
      profile({ isDefault: true, capabilities: ["text-generation", "structured-output"] }),
      local({ capabilities: ["embedding"] }),
      profile({
        id: otherId,
        createdAt: new Date("2026-03-01T00:00:00Z"),
        capabilities: generative
      })
    ]);
    repository.getDefaultTask.mockResolvedValue(null);
    await newService().runDefaultTask("summarization", "text");
    const routes = seeded();
    expect(routes["text-generation"]).toBe(remoteId);
    expect(routes.embedding).toBe(localId);
    expect(routes.summarization).toBe(otherId);
  });
});
