import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundBlockedError, defaultKnowledgeControls } from "@app/domain";

import { AiService } from "./ai-service.js";
import { BackgroundGate } from "./gardener/background-gate.js";

// T75 at the AI service: a call states its budget class beside its priority, the scheduler's
// admission hook refuses the Gardener's background calls a gate holds before anything is sent, and
// user calls are never refused, whatever their priority.

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
const controls = { value: { ...defaultKnowledgeControls } };
const gate = new BackgroundGate({
  controls: () => controls.value,
  power: () => ({ active: false, onBattery: false, idleMs: 3_600_000, overridden: false })
});

function service() {
  const ai = new AiService({
    userDataPath: "/tmp/ai-background-admission-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    backgroundAdmission: { admit: gate.admit, backgroundDutyCycle: gate.dutyCycle }
  });
  const adapter = {
    describe: () => ({
      providerId: "openai-codex",
      modelId: "fixture",
      capabilities: ["summarization", "text-generation"],
      parameterCapabilities: { maxTokens: { min: 1, max: 16384 }, temperature: { min: 0, max: 2 } }
    }),
    canHandle: () => true,
    run: vi.fn(async (request: { taskType: string }) => ({
      taskType: request.taskType,
      output: "ok",
      providerId: "openai-codex",
      modelId: "fixture",
      runtime: "fixture",
      durationMs: 1
    }))
  };
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(adapter)
  );
  return { ai, adapter };
}

beforeEach(() => {
  controls.value = { ...defaultKnowledgeControls };
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
    requiredCapabilities: ["summarization", "text-generation"]
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("background admission at the AI service", () => {
  it("refuses a background call a gate holds before anything is sent, and tells its job", async () => {
    controls.value = { ...controls.value, autonomy: "off" };
    const { ai, adapter } = service();
    const call = ai.runDefaultTask("summarization", "name these topics", {
      jobId: "job-7",
      priority: "P3",
      budgetClass: "background",
      workloadClass: "write-fast"
    });
    await expect(call).rejects.toBeInstanceOf(BackgroundBlockedError);
    expect(adapter.run).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
    expect(gate.takeAdmissionBlock("job-7")).toEqual({ class: "paused", reason: "autonomy_off" });
  });

  it("runs user and unstated calls whatever the controls, a P2 import included", async () => {
    controls.value = { ...controls.value, paused: true, autonomy: "off" };
    const { ai, adapter } = service();
    await expect(
      ai.runDefaultTask("summarization", "an import", {
        origin: "ingestion",
        priority: "P2",
        budgetClass: "user"
      })
    ).resolves.toMatchObject({ output: "ok" });
    await expect(
      ai.runDefaultTask("summarization", "older caller", { priority: "P3" })
    ).resolves.toMatchObject({ output: "ok" });
    expect(adapter.run).toHaveBeenCalledTimes(2);
  });

  it("runs a background call once nothing holds it", async () => {
    const { ai } = service();
    await expect(
      ai.runDefaultTask("summarization", "background", {
        priority: "P3",
        budgetClass: "background"
      })
    ).resolves.toMatchObject({ output: "ok" });
  });
});
