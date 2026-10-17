import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import type { AiService } from "./ai-service.js";
import { KnowledgeService } from "./knowledge-service.js";
import { relationDailyCapError } from "./relations/relation-call-budget.js";

// The link job's steps that the knowledge service provides (F3 T52): typing on the writer route,
// read after the legacy route mapping, and the interim discovery (the v5 source matcher) at the
// link job's priority, every remote call asked of the daily cap first.
const mocks = vi.hoisted(() => ({
  aiConfig: { getDefaultTask: vi.fn() },
  typings: { find: vi.fn(), record: vi.fn() },
  matchSources: vi.fn()
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createAiConfigRepository: () => mocks.aiConfig,
  createRelationTypingRepository: () => mocks.typings
}));
vi.mock("./source-relation-processing.js", async (original) => ({
  ...(await original<typeof import("./source-relation-processing.js")>()),
  matchSources: mocks.matchSources
}));

const order: string[] = [];
const ai = {
  runDefaultTask: vi.fn(async () => ({ output: {}, aiTaskRunId: "run" })),
  ensureLegacyRouteMapping: vi.fn(async () => void order.push("mapping"))
};
const service = () =>
  new KnowledgeService({
    getPool: () => ({}) as PgPool,
    aiService: ai as unknown as AiService,
    userDataPath: "/tmp/test",
    getStorageSettings: async () => ({}) as never,
    getUploadedFilesBasePath: async () => null,
    getContentLanguage: async () => "pt-BR"
  });
const codexRoute = {
  provider: "openai-codex",
  providerConfigId: "codex-config",
  baseUrl: null,
  localModelId: null,
  modelId: "gpt-test",
  runtime: "remote",
  repository: null,
  revision: null,
  quantization: null,
  profileId: "profile",
  parameters: {},
  modelDefaultParameters: {}
};
const note = (id: string) => ({ id, text: `Title: ${id}`, hash: `hash-${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  mocks.typings.find.mockResolvedValue(new Map());
});

describe("the link job's typing step", () => {
  it("reads the writer route after the legacy route mapping, and types untyped without one", async () => {
    mocks.aiConfig.getDefaultTask.mockImplementation(async () => {
      order.push("route");
      return null;
    });
    const result = await service().typeRelationPairs(
      [{ first: note("a"), second: note("b"), band: "apply" }],
      { priority: "P2" }
    );
    expect(order).toEqual(["mapping", "route"]);
    expect(mocks.aiConfig.getDefaultTask).toHaveBeenCalledWith(
      "structured-output",
      undefined,
      expect.arrayContaining(["op:relation_typing", "class:write-fast"])
    );
    expect([...result.pairs.values()].map((pair) => pair.outcome)).toEqual([
      { kind: "untyped", reason: "no_route" }
    ]);
    expect(ai.runDefaultTask).not.toHaveBeenCalled();
  });
});

describe("the link job's discovery step until design E", () => {
  it("judges at the link job's priority and stops at the daily cap", async () => {
    mocks.aiConfig.getDefaultTask.mockResolvedValue(codexRoute);
    mocks.matchSources.mockImplementation(
      async (input: {
        ai: Pick<AiService, "runDefaultTask">;
        sourceIds: string[];
        runKey: string;
      }) => {
        expect(input).toMatchObject({ sourceIds: ["root"], runKey: "relation-link:job" });
        await input.ai.runDefaultTask("reranking", "first", { priority: "P2" });
        await input.ai.runDefaultTask("reranking", "second", { priority: "P2" });
        return { persistedCount: 1 };
      }
    );
    const reserveCall = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      service().discoverSourceRelations({
        rootId: "root",
        runKey: "relation-link:job",
        regenerate: false,
        priority: "P1",
        reserveCall,
        context: { jobId: "job" }
      })
    ).rejects.toThrow(relationDailyCapError);
    // The judge's route runs remotely: each call asked for a remote call first.
    expect(reserveCall.mock.calls).toEqual([["remote"], ["remote"]]);
    expect(ai.runDefaultTask).toHaveBeenCalledOnce();
    expect(ai.runDefaultTask).toHaveBeenCalledWith(
      "reranking",
      "first",
      { operation: "source_relation_matching", workloadClass: "decide", priority: "P1" },
      undefined,
      undefined
    );
  });
});
