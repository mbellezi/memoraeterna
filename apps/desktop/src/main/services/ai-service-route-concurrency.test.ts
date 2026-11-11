import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAiScheduler, resolveAiLaneRuntimeConfig, type AiScheduler } from "@app/ai";

import { AiService } from "./ai-service.js";

/**
 * `taskRouteConcurrency` (F5 D22): how many calls of one source's stage may reach the lane its route
 * takes, read without a call. The lane's current limit: 4 for an API key, 2 for Codex, 1 for the
 * local lane and in serial mode, lower after a rate limit, and 1 when no route serves the task.
 */

const state = vi.hoisted(() => ({ selections: new Map<string, Record<string, unknown>>() }));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async (task: string) => state.selections.get(task) ?? null
  })
}));

const ids = {
  codexConfig: "00000000-0000-4000-8000-0000000000c1",
  apiKeyConfig: "00000000-0000-4000-8000-0000000000c2",
  localModel: "00000000-0000-4000-8000-0000000000a1"
};

const route = {
  profileId: "00000000-0000-4000-8000-000000000001",
  revision: null,
  repository: null,
  quantization: null,
  parameters: {},
  modelDefaultParameters: {},
  providerMetadata: {},
  requiredCapabilities: ["summarization", "knowledge-graph-generation", "structured-output"]
};
const codex = {
  ...route,
  providerConfigId: ids.codexConfig,
  localModelId: null,
  provider: "openai-codex",
  modelId: "writer",
  runtime: "remote",
  baseUrl: "https://chatgpt.com/backend-api/codex"
};
const apiKey = {
  ...route,
  providerConfigId: ids.apiKeyConfig,
  localModelId: null,
  provider: "openai-compatible",
  modelId: "writer",
  runtime: "remote",
  baseUrl: "https://api.example.com/v1"
};
const local = {
  ...route,
  providerConfigId: null,
  localModelId: ids.localModel,
  provider: "local-mlx",
  modelId: "local-writer",
  runtime: "mlx",
  baseUrl: null
};

function service(options: { mode?: "product" | "serial"; scheduler?: AiScheduler } = {}) {
  return new AiService({
    userDataPath: "/tmp/ai-route-concurrency-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    lanes: { mode: options.mode ?? "product" },
    isPackaged: false,
    ...(options.scheduler ? { scheduler: options.scheduler } : {})
  });
}

const graph = { operation: "graph_source_chunks", workloadClass: "write-quality" } as const;

beforeEach(() => state.selections.clear());

describe("the concurrency of a task's route", () => {
  it("gives a local route one call at a time", async () => {
    state.selections.set("knowledge-graph-generation", local);
    state.selections.set("summarization", local);
    const ai = service();
    expect(await ai.taskRouteConcurrency("knowledge-graph-generation", graph)).toBe(1);
    expect(
      await ai.taskRouteConcurrency("summarization", {
        operation: "summary_map",
        workloadClass: "write-fast"
      })
    ).toBe(1);
  });

  it("gives Codex its lane's 2 and an API key its 4", async () => {
    state.selections.set("knowledge-graph-generation", codex);
    state.selections.set("summarization", apiKey);
    const ai = service();
    expect(await ai.taskRouteConcurrency("knowledge-graph-generation", graph)).toBe(2);
    expect(await ai.taskRouteConcurrency("summarization")).toBe(4);
  });

  it("gives every route one call at a time in serial mode", async () => {
    state.selections.set("knowledge-graph-generation", codex);
    state.selections.set("summarization", apiKey);
    const ai = service({ mode: "serial" });
    expect(await ai.taskRouteConcurrency("knowledge-graph-generation", graph)).toBe(1);
    expect(await ai.taskRouteConcurrency("summarization")).toBe(1);
  });

  it("follows the lane's current limit after a rate limit lowered it", async () => {
    state.selections.set("knowledge-graph-generation", codex);
    const scheduler = createAiScheduler(
      resolveAiLaneRuntimeConfig({ mode: "product" }, { environment: {}, packaged: false })
    );
    const lane = `remote:${ids.codexConfig}` as const;
    await scheduler.run(
      { lane, remoteKind: "codex", priority: "P2", workloadClass: "write-quality", label: "probe" },
      async () => undefined
    );
    const ai = service({ scheduler });
    expect(await ai.taskRouteConcurrency("knowledge-graph-generation", graph)).toBe(2);
    scheduler.observeRateLimit(lane, null);
    expect(await ai.taskRouteConcurrency("knowledge-graph-generation", graph)).toBe(1);
  });

  it("answers 1 when no route serves the task", async () => {
    expect(await service().taskRouteConcurrency("knowledge-graph-generation", graph)).toBe(1);
  });
});
