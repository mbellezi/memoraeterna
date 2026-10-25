import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  grammarSchemaForContract,
  toStrictJsonSchema,
  type AiOutputContract,
  type AiOutputSchema
} from "@app/domain";
import { z } from "zod";

import { AiService, routedOutputSchema } from "./ai-service.js";

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

describe("the output contract of a call (F4 D23)", () => {
  const strictContract: AiOutputContract = {
    name: "pair_verdict",
    contract: z.object({ verdict: z.enum(["same", "different"]) }).strict()
  };
  // A confirmation answer is a tuple list: it never reaches a remote provider as a schema.
  const tupleContract: AiOutputContract = {
    name: "pair_matches",
    contract: z.object({ matches: z.array(z.tuple([z.string(), z.string().nullable()])) }).strict()
  };

  it("sends a remote adapter the strict schema of a contract that has one", async () => {
    const { ai, requests } = service({ schemaMode: "strict" });
    await ai.runDefaultTask("structured-output", "decide", { outputContract: strictContract });
    expect(requests[0]?.outputSchema).toEqual(outputSchema);
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({ schemaMode: "strict" });
  });

  it("sends a remote adapter nothing for a contract that cannot be strict", async () => {
    const { ai, requests } = service({ schemaMode: "none" });
    await ai.runDefaultTask("structured-output", "decide", { outputContract: tupleContract });
    expect(requests[0]).not.toHaveProperty("outputSchema");
    expect(state.record.mock.calls[0]?.[0]).toMatchObject({ schemaMode: "none" });
  });

  it("keeps the contract out of the monitoring context, as the schema is", async () => {
    const { ai, monitoring } = service();
    await ai.runDefaultTask("structured-output", "decide", {
      outputContract: strictContract,
      operation: "pair_verdict"
    });
    const started = monitoring.start.mock.calls[0]?.[0] as { context: Record<string, unknown> };
    expect(started.context).not.toHaveProperty("outputContract");
    expect(started.context).toMatchObject({ operation: "pair_verdict" });
  });

  it("sends a remote adapter the strict schema of the answer's strict terms and nothing else new (owner, 10-25)", async () => {
    const terms: AiOutputContract = {
      name: "pair_note",
      contract: z.object({ note: z.string().optional() }).strict(),
      strictContract: z.object({ note: z.string().nullable() }).strict(),
      grammar: false
    };
    const { ai, requests } = service({ schemaMode: "strict" });
    await ai.runDefaultTask("structured-output", "decide", {
      operation: "pair_note",
      outputContract: terms
    });
    await ai.runDefaultTask("structured-output", "decide", { operation: "pair_note" });
    const [stated, plain] = requests;
    expect(stated?.outputSchema).toEqual(toStrictJsonSchema(terms.strictContract!, "pair_note"));
    // Byte for byte the same request but for the schema: prompt, parameters, metadata, operation.
    expect(JSON.stringify({ ...stated, outputSchema: undefined })).toBe(JSON.stringify(plain));
  });

  it("sends a schema the caller states itself as it is, whatever contract it also states", async () => {
    const { ai, requests } = service();
    const probe = toStrictJsonSchema(z.object({ ok: z.boolean() }).strict(), "probe")!;
    await ai.runDefaultTask("structured-output", "decide", {
      outputSchema: probe,
      outputContract: strictContract
    });
    expect(requests[0]?.outputSchema).toEqual(probe);
  });
});

describe("routedOutputSchema", () => {
  const contract: AiOutputContract = {
    name: "verdict",
    contract: z.object({ verdict: z.enum(["same", "different"]) }).strict()
  };
  const grammar: AiOutputSchema = {
    name: "verdict",
    schema: { type: "object", properties: { verdict: { type: "string" } } },
    strict: false
  };
  const plain = {};

  it("derives the strict schema for a remote adapter and ignores the adapter's own hook", () => {
    const hooked = { outputSchemaFor: vi.fn(() => grammar) };
    const routed = routedOutputSchema({
      contract,
      taskType: "structured-output",
      local: false,
      adapter: hooked
    });
    expect(routed).toEqual(toStrictJsonSchema(contract.contract, "verdict"));
    expect(hooked.outputSchemaFor).not.toHaveBeenCalled();
  });

  it("hands the contract to a local runtime that takes a schema, and to no other", () => {
    const hooked = { outputSchemaFor: vi.fn(() => grammar) };
    expect(
      routedOutputSchema({ contract, taskType: "structured-output", local: true, adapter: hooked })
    ).toEqual(grammar);
    expect(hooked.outputSchemaFor).toHaveBeenCalledWith(contract);
    expect(
      routedOutputSchema({ contract, taskType: "structured-output", local: true, adapter: plain })
    ).toBeUndefined();
    // A runtime that declines the contract (thinking on, a tokenizer it cannot mask) runs without.
    expect(
      routedOutputSchema({
        contract,
        taskType: "structured-output",
        local: true,
        adapter: { outputSchemaFor: () => null }
      })
    ).toBeUndefined();
  });

  it("hands a local runtime nothing for a contract stated for remote runtimes only", () => {
    const remoteOnly: AiOutputContract = { ...contract, grammar: false };
    const mlx = { outputSchemaFor: (stated: AiOutputContract) => grammarSchemaForContract(stated) };
    expect(
      routedOutputSchema({ contract, taskType: "structured-output", local: true, adapter: mlx })
    ).toEqual(grammarSchemaForContract(contract));
    expect(
      routedOutputSchema({
        contract: remoteOnly,
        taskType: "structured-output",
        local: true,
        adapter: mlx
      })
    ).toBeUndefined();
    expect(
      routedOutputSchema({
        contract: remoteOnly,
        taskType: "structured-output",
        local: false,
        adapter: mlx
      })
    ).toEqual(toStrictJsonSchema(contract.contract, "verdict"));
  });

  it("states nothing for a call that states no contract, and a stated schema wins", () => {
    expect(
      routedOutputSchema({ taskType: "structured-output", local: false, adapter: plain })
    ).toBeUndefined();
    const stated: AiOutputSchema = { name: "stated", schema: { type: "object" }, strict: true };
    expect(
      routedOutputSchema({
        stated,
        contract,
        taskType: "structured-output",
        local: true,
        adapter: plain
      })
    ).toBe(stated);
  });

  it("never states a schema for an embedding", () => {
    expect(
      routedOutputSchema({ contract, taskType: "embedding", local: false, adapter: plain })
    ).toBeUndefined();
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
