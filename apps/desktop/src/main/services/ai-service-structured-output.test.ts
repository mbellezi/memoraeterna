import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toStrictJsonSchema } from "@app/domain";
import { z } from "zod";

import { AiService } from "./ai-service.js";

/**
 * Structured output through the AI service (F3 D35): the schema a caller states reaches the
 * adapter's request and stays out of the monitoring context, the mode the adapter used is audited
 * (`schema_mode`), and work sized by the writer asks where its route runs.
 */

const state = vi.hoisted(() => ({
  selections: new Map<string, Record<string, unknown>>(),
  getDefaultTask: vi.fn(),
  record: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async (task: string, profile?: string, keys?: string[]) => {
      state.getDefaultTask(task, profile, keys);
      return state.selections.get(task) ?? null;
    },
    recordTaskRun: state.record
  })
}));

const codexSelection = {
  profileId: "00000000-0000-4000-8000-000000000001",
  providerConfigId: "00000000-0000-4000-8000-0000000000c1",
  localModelId: null,
  provider: "openai-codex",
  modelId: "writer",
  runtime: "remote",
  revision: null,
  repository: null,
  quantization: null,
  baseUrl: "https://chatgpt.com/backend-api/codex",
  parameters: {},
  modelDefaultParameters: {},
  providerMetadata: {},
  requiredCapabilities: ["structured-output"]
};
const localSelection = {
  ...codexSelection,
  providerConfigId: null,
  localModelId: "00000000-0000-4000-8000-0000000000a1",
  provider: "local-mlx",
  runtime: "mlx",
  baseUrl: null
};

const outputSchema = toStrictJsonSchema(
  z.object({ verdict: z.enum(["same", "different"]) }).strict(),
  "pair_verdict"
)!;

function service(result: Record<string, unknown> = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const monitoring = {
    start: vi.fn<(input: Record<string, unknown>) => Promise<{ id: string; full: boolean }>>(
      async () => ({ id: "capture", full: false })
    ),
    finish: vi.fn(async () => undefined)
  };
  const ai = new AiService({
    userDataPath: "/tmp/ai-structured-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    monitoring: monitoring as never
  });
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  const adapter = {
    describe: () => ({
      providerId: "openai-codex",
      modelId: "writer",
      runtime: "remote",
      capabilities: ["structured-output"],
      parameterCapabilities: { maxTokens: { min: 1, max: 16384 } }
    }),
    canHandle: () => true,
    run: vi.fn(async (request: Record<string, unknown>) => {
      requests.push(request);
      return {
        taskType: request.taskType,
        output: '{"verdict":"same"}',
        providerId: "openai-codex",
        modelId: "writer",
        runtime: "remote",
        durationMs: 1,
        ...result
      };
    })
  };
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(adapter)
  );
  return { ai, requests, monitoring };
}

beforeEach(() => {
  state.record.mockReset().mockResolvedValue("run-id");
  state.getDefaultTask.mockReset();
  state.selections.clear();
  state.selections.set("structured-output", codexSelection);
});
afterEach(() => vi.restoreAllMocks());

describe("the output schema of a call", () => {
  it("reaches the adapter's request and is audited with the mode the adapter used", async () => {
    const { ai, requests } = service({ schemaMode: "strict" });
    await ai.runDefaultTask("structured-output", "decide", { outputSchema });
    expect(requests[0]?.outputSchema).toEqual(outputSchema);
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({
      status: "succeeded",
      schemaMode: "strict"
    });
  });

  it("keeps the schema out of the monitoring context", async () => {
    const { ai, monitoring } = service({ schemaMode: "strict" });
    await ai.runDefaultTask("structured-output", "decide", { outputSchema });
    const started = monitoring.start.mock.calls[0]?.[0] as { context: Record<string, unknown> };
    expect(started.context).not.toHaveProperty("outputSchema");
  });

  it("sends no schema when the caller states none, and records an unknown mode as unknown", async () => {
    // A cassette replay and an adapter that does not say leave the mode unknown.
    const { ai, requests } = service();
    await ai.runDefaultTask("structured-output", "decide");
    expect(requests[0]).not.toHaveProperty("outputSchema");
    expect(state.record.mock.calls[0]?.[0]).not.toHaveProperty("schemaMode");
  });

  it.each(["json", "grammar", "none"] as const)("audits the %s mode too", async (schemaMode) => {
    const { ai } = service({ schemaMode });
    await ai.runDefaultTask("structured-output", "decide");
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({ schemaMode });
  });
});

describe("where a task's route runs", () => {
  it("answers local, remote, or null when no route serves the task", async () => {
    const { ai } = service();
    state.selections.set("knowledge-graph-generation", codexSelection);
    await expect(ai.taskRouteLocality("knowledge-graph-generation")).resolves.toBe("remote");
    state.selections.set("knowledge-graph-generation", localSelection);
    await expect(ai.taskRouteLocality("knowledge-graph-generation")).resolves.toBe("local");
    // An endpoint on this machine (Ollama, LM Studio) shares it with the local models.
    state.selections.set("knowledge-graph-generation", {
      ...codexSelection,
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1"
    });
    await expect(ai.taskRouteLocality("knowledge-graph-generation")).resolves.toBe("local");
    state.selections.delete("knowledge-graph-generation");
    await expect(ai.taskRouteLocality("knowledge-graph-generation")).resolves.toBeNull();
  });

  it("looks the route up by the keys a real call of that operation resolves", async () => {
    const { ai } = service();
    state.selections.set("knowledge-graph-generation", codexSelection);
    await ai.taskRouteLocality("knowledge-graph-generation", { operation: "graph_source_chunks" });
    expect(state.getDefaultTask).toHaveBeenCalledWith("knowledge-graph-generation", undefined, [
      "op:graph_source_chunks",
      "knowledge-graph-generation"
    ]);
    await ai.taskRouteLocality("knowledge-graph-generation", {
      operation: "graph_source_chunks",
      workloadClass: "write-quality"
    });
    expect(state.getDefaultTask).toHaveBeenLastCalledWith("knowledge-graph-generation", undefined, [
      "op:graph_source_chunks",
      "class:write-quality",
      "knowledge-graph-generation"
    ]);
  });
});

describe("what a task's route can take in one call (plan decision 28)", () => {
  it("reads the Codex route's window from the provider's metadata, as an admitted call plans it", async () => {
    const { ai } = service();
    state.selections.set("summarization", {
      ...codexSelection,
      providerMetadata: { modelLimits: { contextWindow: 272_000 } }
    });
    await expect(
      ai.taskRouteCapacity("summarization", {
        operation: "hierarchy_summary",
        workloadClass: "write-fast"
      })
    ).resolves.toEqual({
      contextWindow: 128_000,
      source: "planning",
      maxOutputTokens: 16_384,
      local: false
    });
    // The keys of the call the capacity is for: its operation, its class, then the task route.
    expect(state.getDefaultTask).toHaveBeenLastCalledWith("summarization", undefined, [
      "op:hierarchy_summary",
      "class:write-fast",
      "summarization"
    ]);
  });

  it("reads a smaller provider limit, a local model's catalog window, and none for a model that states none", async () => {
    const { ai } = service();
    state.selections.set("summarization", {
      ...codexSelection,
      provider: "openai-compatible",
      providerMetadata: { modelLimits: { contextWindow: 32_000 } }
    });
    await expect(ai.taskRouteCapacity("summarization")).resolves.toMatchObject({
      contextWindow: 32_000,
      source: "provider"
    });
    state.selections.set("summarization", {
      ...localSelection,
      modelDefaultParameters: { contextWindow: 4_096, maxTokens: 1_024 }
    });
    await expect(ai.taskRouteCapacity("summarization")).resolves.toEqual({
      contextWindow: 4_096,
      source: "profile",
      maxOutputTokens: 1_024,
      local: true
    });
    state.selections.set("summarization", localSelection);
    await expect(ai.taskRouteCapacity("summarization")).resolves.toMatchObject({
      contextWindow: null,
      source: "unknown",
      local: true
    });
    state.selections.delete("summarization");
    await expect(ai.taskRouteCapacity("summarization")).resolves.toBeNull();
  });
});
