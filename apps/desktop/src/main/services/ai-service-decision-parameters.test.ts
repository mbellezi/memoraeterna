import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerParameterCapabilities } from "@app/ai";
import { AiService } from "./ai-service.js";
import { noteMatchDecisionOperations } from "./ai-task-parameters.js";

const repository = vi.hoisted(() => ({
  getDefaultTask: vi.fn(),
  recordTaskRun: vi.fn(),
  listProfiles: vi.fn(),
  listProviders: vi.fn(),
  listProfileTasks: vi.fn(),
  listTaskRoutes: vi.fn(),
  seedTaskRoute: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => repository,
  createLocalModelRepository: () => ({ findById: async () => null })
}));

const capabilities = ["text-generation", "structured-output"] as const;
const modelId = "gpt-5.5";
const baseUrl = "https://example.test";
const selection = (parameters: Record<string, unknown> = {}) => ({
  profileId: "00000000-0000-4000-8000-000000000001",
  providerConfigId: "provider-1",
  localModelId: null,
  provider: "openai-compatible",
  modelId,
  runtime: "remote",
  revision: null,
  repository: null,
  quantization: null,
  baseUrl,
  parameters,
  modelDefaultParameters: {},
  providerMetadata: {},
  requiredCapabilities: [...capabilities]
});

/** A service whose routed remote reasoning model answers every call; `run` sees its parameters. */
function routedService() {
  const ai = new AiService({
    userDataPath: "/tmp/ai-decision-parameters-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false
  });
  const run = vi.fn(
    async (request: { taskType: string; parameters?: { reasoningLevel?: string } }) => ({
      taskType: request.taskType,
      output: "{}",
      providerId: "openai-compatible",
      modelId,
      runtime: "remote",
      durationMs: 1
    })
  );
  const adapter = {
    describe: () => ({
      providerId: "openai-compatible",
      modelId,
      capabilities: [...capabilities],
      parameterCapabilities: providerParameterCapabilities({
        provider: "openai-compatible",
        modelId,
        baseUrl,
        capabilities: [...capabilities]
      })
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

describe("reasoning of the reranking route", () => {
  const reasoningOf = async (operation: string | undefined, parameters = {}) => {
    const { ai, run } = routedService();
    repository.getDefaultTask.mockResolvedValue(selection(parameters));
    await ai.runDefaultTask("reranking", "decide", operation ? { operation } : {});
    return run.mock.calls[0]?.[0].parameters?.reasoningLevel;
  };

  it("is off for the note-match decision call and its repair, and audited as such", async () => {
    for (const operation of Object.values(noteMatchDecisionOperations))
      expect(await reasoningOf(operation)).toBe("off");
    expect(repository.recordTaskRun.mock.calls[0]?.[0].parameters).toMatchObject({
      reasoningLevel: "off"
    });
  });

  it("is not changed for source matching or other uses of the route", async () => {
    expect(await reasoningOf("source_relation_matching")).toBeUndefined();
    expect(await reasoningOf(undefined)).toBeUndefined();
  });

  it("records the wire options the adapter chose with the effective parameters", async () => {
    const { ai, run } = routedService();
    const requestOptions = { reasoningEffort: "low", reasoningSummary: null, include: [] };
    run.mockImplementationOnce(async (request) => ({
      taskType: request.taskType,
      output: "{}",
      providerId: "openai-compatible",
      modelId,
      runtime: "remote",
      durationMs: 1,
      requestOptions
    }));
    repository.getDefaultTask.mockResolvedValue(selection());
    await ai.runDefaultTask("reranking", "decide", {
      operation: noteMatchDecisionOperations.decide
    });
    expect(repository.recordTaskRun.mock.calls[0]?.[0].parameters).toEqual(
      expect.objectContaining({ reasoningLevel: "off", requestOptions })
    );
    // Without reported wire options the audit keeps the canonical parameters alone.
    await ai.runDefaultTask("reranking", "decide", {
      operation: noteMatchDecisionOperations.decide
    });
    expect(repository.recordTaskRun.mock.calls[1]?.[0].parameters).not.toHaveProperty(
      "requestOptions"
    );
  });

  it("keeps what the profile asks for on the decision call", async () => {
    expect(await reasoningOf(noteMatchDecisionOperations.decide, { reasoningLevel: "high" })).toBe(
      "high"
    );
  });
});
