import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiService, reportedRetryIndex } from "./ai-service.js";

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

function service(run: () => Promise<unknown>) {
  const ai = new AiService({
    userDataPath: "/tmp/ai-wall-clock-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    // One call at a time on the remote lane, so the second call waits behind the first.
    lanes: { mode: "serial" }
  });
  const adapter = {
    describe: () => ({
      providerId: "openai-codex",
      modelId: "fixture",
      capabilities: ["summarization", "reranking", "text-generation"],
      parameterCapabilities: { maxTokens: { min: 1, max: 16384 }, temperature: { min: 0, max: 2 } }
    }),
    canHandle: () => true,
    run: vi.fn(async (request: { taskType: string }) => ({
      taskType: request.taskType,
      output: await run(),
      providerId: "openai-codex",
      modelId: "fixture",
      runtime: "fixture",
      durationMs: 1,
      inputTokens: 2,
      outputTokens: 1
    }))
  };
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(adapter)
  );
  return ai;
}

let clock = 0;

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  state.record.mockReset().mockResolvedValue("run-id");
  state.selection = {
    profileId: uuid,
    providerConfigId: uuid,
    localModelId: null,
    provider: "openai-codex",
    modelId: "fixture",
    runtime: "fixture",
    revision: "1",
    repository: null,
    quantization: null,
    baseUrl: "https://fixture.invalid",
    parameters: { temperature: 0.2 },
    modelDefaultParameters: {},
    requiredCapabilities: ["summarization", "reranking", "text-generation"]
  };
});

afterEach(() => vi.restoreAllMocks());

describe("AI task audit wall-clock fields", () => {
  it("records the queue wait of a call that waited behind another one", async () => {
    const gate = Promise.withResolvers<void>(),
      started = Promise.withResolvers<void>();
    let calls = 0;
    const ai = service(async () => {
      if (++calls === 1) {
        started.resolve();
        await gate.promise;
      }
      return "ok";
    });

    clock = 0;
    const first = ai.runDefaultTask("summarization", "first input");
    await started.promise;
    clock = 100;
    const second = ai.runDefaultTask("reranking", "second input", { attempt: 1, origin: "job" });
    clock = 1_500;
    gate.resolve();
    await Promise.all([first, second]);

    expect(state.record).toHaveBeenCalledTimes(2);
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({
      taskType: "summarization",
      queueMs: 0
    });
    expect(state.record.mock.calls[0]?.[0]).not.toHaveProperty("attempt");
    expect(state.record.mock.calls[1]?.[0]).toMatchObject({
      taskType: "reranking",
      queueMs: 1_400,
      attempt: 1
    });
  });

  it("records the queue wait of a failed call as well", async () => {
    const ai = service(async () => {
      throw new Error("provider failed");
    });

    await expect(ai.runDefaultTask("summarization", "input", { attempt: 0 })).rejects.toThrow();

    expect(state.record).toHaveBeenCalledTimes(1);
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({
      status: "failed",
      queueMs: 0,
      attempt: 0
    });
  });
});

describe("reportedRetryIndex", () => {
  it("keeps the zero-based retry index that pipeline callers report", () => {
    expect(reportedRetryIndex({ attempt: 0 })).toBe(0);
    expect(reportedRetryIndex({ attempt: 1, origin: "ingestion" })).toBe(1);
  });

  it("reports nothing when the caller gave no usable index", () => {
    expect(reportedRetryIndex({})).toBeUndefined();
    expect(reportedRetryIndex({ attempt: -1 })).toBeUndefined();
    expect(reportedRetryIndex({ attempt: 1.5 })).toBeUndefined();
  });

  it("ignores the call counter of Ask calls", () => {
    expect(reportedRetryIndex({ attempt: 1, origin: "consultation" })).toBeUndefined();
  });
});
