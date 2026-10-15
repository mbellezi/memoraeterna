import { findLocalModelCatalogEntry, rankerCatalogArtifactSha256 } from "@app/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiService } from "./ai-service.js";
import { defaultPromptPin, installPromptPin, withPromptPin } from "./prompt-runtime.js";

const state = vi.hoisted(() => ({
  model: {} as Record<string, unknown>,
  recordTaskRun: vi.fn(),
  updateModel: vi.fn(),
  validateArtifact: vi.fn(),
  updateProfile: vi.fn()
}));
vi.mock("@app/ai", async () => ({
  ...(await vi.importActual<typeof import("@app/ai")>("@app/ai")),
  validateCatalogRankerArtifact: state.validateArtifact
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createLocalModelRepository: () => ({
    findById: async () => state.model,
    updateModel: state.updateModel
  }),
  createAiConfigRepository: () => ({
    recordTaskRun: state.recordTaskRun,
    updateProfile: state.updateProfile,
    listTaskRoutes: async () => [],
    listProfiles: async () => [],
    seedTaskRoute: async () => false
  })
}));

const modelId = "00000000-0000-4000-8000-000000000001";
const entry = findLocalModelCatalogEntry("mlx-qwen3-reranker-0.6b")!;
const runtimeBuild = "memora-mlx-helper@sha256:" + "a".repeat(64);
const shippedInstruction =
  "Given a web search query, retrieve relevant passages that answer the query";

function rankerModel(overrides: Record<string, unknown> = {}) {
  return {
    id: modelId,
    catalogId: entry.id,
    modelId: entry.repository,
    runtime: "mlx",
    repository: entry.repository,
    revision: entry.revision,
    quantization: entry.quantization,
    status: "ready",
    managedPath: "/nonexistent/memora/local-models/mlx-qwen3-reranker-0.6b",
    capabilities: ["offline", "local-files"],
    defaultParameters: {},
    metadata: { catalogVersion: "test" },
    lastError: null,
    ...overrides
  };
}

type RankInput = { instruction: string; query: string; documents: string[] };

/** A ranker that scores the first document of every request above the others. */
function fakeRanker(options: { sameScore?: boolean; failOnCall?: number } = {}) {
  const requests: RankInput[] = [];
  const dispose = vi.fn(async () => undefined);
  const run = vi.fn(async (request: { input: string; taskType: string }) => {
    const rank = JSON.parse(request.input) as RankInput;
    requests.push(rank);
    if (options.failOnCall === requests.length) throw new Error("errors.localModels.runtimeFailed");
    const card = rank.query.startsWith("What is the capital of China");
    const logOdds = rank.documents.map((_, index) =>
      card ? [7.625, -11.375][index]! : options.sameScore ? 1 : index === 0 ? 8 : -8
    );
    return {
      taskType: request.taskType,
      output: {
        logOdds,
        scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
        tokenCounts: logOdds.map(() => 120),
        truncated: logOdds.map(() => false)
      },
      providerId: "local-mlx",
      modelId: entry.repository,
      runtime: "local",
      durationMs: 4,
      inputTokens: 120 * logOdds.length,
      outputTokens: 0,
      costEstimate: 0
    };
  });
  const adapter = {
    describe: () => ({
      providerId: "local-mlx",
      modelId: entry.repository,
      runtime: "local",
      capabilities: [...entry.capabilities],
      parameterCapabilities: {},
      limits: {},
      requirements: {}
    }),
    canHandle: () => true,
    run,
    runtimeBuild: async () => runtimeBuild,
    dispose
  };
  return { adapter, requests, run, dispose };
}

function service(adapter: ReturnType<typeof fakeRanker>["adapter"] | Error) {
  const monitoring = {
    start: vi.fn(async () => ({ id: "capture", full: false })),
    finish: vi.fn(async () => undefined)
  };
  const ai = new AiService({
    userDataPath: "/tmp/ai-ranker-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    monitoring: monitoring as never
  });
  const internals = ai as unknown as {
    buildRankerAdapter: () => unknown;
    resident: Record<string, unknown>;
    activeLocalModels: Set<string>;
  };
  const create = vi.spyOn(internals, "buildRankerAdapter").mockImplementation(() => {
    if (adapter instanceof Error) throw adapter;
    return adapter;
  });
  return { ai, monitoring, create, internals };
}

beforeEach(() => {
  state.model = rankerModel();
  state.recordTaskRun.mockReset().mockImplementation(async () => crypto.randomUUID());
  state.updateModel.mockReset().mockImplementation(async () => state.model);
  state.updateProfile.mockReset().mockResolvedValue({
    id: modelId,
    name: "Profile",
    description: null,
    isDefault: false,
    privacyMode: "offline_only",
    outputLanguage: "ui",
    providerConfigId: null,
    localModelId: modelId,
    modelId: entry.repository,
    runtime: "mlx",
    capabilities: [],
    status: "active",
    createdAt: new Date(0),
    updatedAt: new Date(0)
  });
  state.validateArtifact.mockReset().mockResolvedValue({
    runtime: "mlx",
    artifactSha256: rankerCatalogArtifactSha256(entry),
    sizeBytes: 1,
    architecture: "Qwen3ForCausalLM"
  });
});
afterEach(() => installPromptPin(defaultPromptPin()));

describe("testing a dedicated ranker", () => {
  it("validates the artifact, runs the ranking smoke test and stores the decide validation", async () => {
    const ranker = fakeRanker();
    const { ai, monitoring } = service(ranker.adapter);

    const summary = await ai.testLocalModel(modelId);

    expect(state.validateArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.id }),
      "/nonexistent/memora/local-models/mlx-qwen3-reranker-0.6b"
    );
    // The model card pair uses the card's instruction; the language pairs use the catalog prompt.
    expect(ranker.requests.map((request) => request.instruction)).toEqual([
      "Given a web search query, retrieve relevant passages that answer the query",
      shippedInstruction,
      shippedInstruction
    ]);
    expect(ranker.requests.map((request) => request.documents.length)).toEqual([2, 2, 2]);
    expect(state.updateModel).toHaveBeenCalledTimes(1);
    const [id, update] = state.updateModel.mock.calls[0]!;
    expect(id).toBe(modelId);
    expect(update).toMatchObject({
      lastError: null,
      metadata: {
        catalogVersion: "test",
        decideValidation: {
          version: 1,
          runtime: "mlx",
          revision: entry.revision,
          artifactSha256: rankerCatalogArtifactSha256(entry),
          runtimeBuild,
          smoke: { passed: true, failures: [] }
        }
      }
    });
    expect(update.metadata.decideValidation.validatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(summary).toMatch(/^Reranker validated for decide\nModel card pair: 7\.625, -11\.375/u);
    expect(summary).toContain("en: relevant 8.000, irrelevant -8.000 (margin 16.000)");
    expect(summary).toContain("pt-BR:");
    // The test leaves no ranker resident.
    expect(ranker.dispose).toHaveBeenCalledTimes(1);
    // Monitoring sees one reranking test.
    expect(monitoring.start).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ai",
        operation: "local_model_test",
        taskType: "reranking",
        provider: "local-mlx",
        runtime: "mlx"
      })
    );
    expect(monitoring.finish).toHaveBeenCalledWith(
      { id: "capture", full: false },
      expect.objectContaining({
        status: "succeeded",
        costEstimate: 0,
        tokenUsage: { inputTokens: 720, outputTokens: 0, totalTokens: 720 }
      })
    );
  });

  it("audits every rank call with the evaluated tokens and no cost", async () => {
    const { ai } = service(fakeRanker().adapter);

    await ai.testLocalModel(modelId);

    expect(state.recordTaskRun).toHaveBeenCalledTimes(3);
    for (const [run] of state.recordTaskRun.mock.calls) {
      expect(run).toMatchObject({
        taskType: "reranking",
        provider: "local-mlx",
        modelId: entry.repository,
        runtime: "mlx",
        adapter: "mlx-swift-lm",
        repository: entry.repository,
        revision: entry.revision,
        quantization: "bf16",
        capabilitiesUsed: ["reranking", "offline"],
        parameters: {},
        inputTokens: 240,
        outputTokens: 0,
        costEstimate: 0,
        status: "succeeded"
      });
      expect(run.inputHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(run.outputHash).toMatch(/^[a-f0-9]{64}$/u);
    }
    const compositions = state.recordTaskRun.mock.calls.map(
      ([run]) => run.promptCompositions as Array<{ promptId: string }>
    );
    // The shipped prompt is the model card's own instruction, so every call sent that text.
    for (const composition of compositions) {
      expect(composition.map((entry) => entry.promptId)).toContain("diagnostics.local_ranking");
    }
  });

  it("takes the language-pair instruction from the pinned catalog prompt", async () => {
    const ranker = fakeRanker();
    const { ai } = service(ranker.adapter);
    const pin = defaultPromptPin();
    const prompt = pin.entries.find((candidate) => candidate.id === "diagnostics.local_ranking")!;
    prompt.fields.body = "Judge whether the passage answers the question";
    prompt.revisions.push({ id: prompt.id, revisionId: "edited" });

    await withPromptPin(pin, () => ai.testLocalModel(modelId));

    expect(ranker.requests.map((request) => request.instruction)).toEqual([
      // The model card pair keeps the card's instruction: its reference scores need it.
      "Given a web search query, retrieve relevant passages that answer the query",
      "Judge whether the passage answers the question",
      "Judge whether the passage answers the question"
    ]);
    // Only the calls that carry the catalog prompt are audited against it.
    const compositions = state.recordTaskRun.mock.calls.map(
      ([run]) => run.promptCompositions as Array<{ promptId: string }>
    );
    expect(compositions[0]).toEqual([]);
    expect(compositions[1]!.map((entry) => entry.promptId)).toEqual(["diagnostics.local_ranking"]);
    expect(compositions[2]!.map((entry) => entry.promptId)).toEqual(["diagnostics.local_ranking"]);
  });

  it("fails visibly and voids an earlier validation when a language pair does not separate", async () => {
    state.model = rankerModel({
      metadata: { catalogVersion: "test", decideValidation: { version: 1 } }
    });
    const { ai, monitoring } = service(fakeRanker({ sameScore: true }).adapter);

    await expect(ai.testLocalModel(modelId)).rejects.toThrow(
      "errors.localModels.rankerSmokeFailed"
    );

    expect(state.updateModel).toHaveBeenCalledWith(modelId, {
      lastError: "errors.localModels.rankerSmokeFailed",
      metadata: { catalogVersion: "test" }
    });
    expect(monitoring.finish).toHaveBeenCalledWith(
      { id: "capture", full: false },
      expect.objectContaining({ status: "failed" })
    );
  });

  it("rejects an install whose weights changed, before any model is loaded", async () => {
    state.validateArtifact.mockRejectedValue(new Error("errors.localModels.checksumMismatch"));
    state.model = rankerModel({
      metadata: { catalogVersion: "test", decideValidation: { version: 1 } }
    });
    const { ai, create } = service(fakeRanker().adapter);

    await expect(ai.testLocalModel(modelId)).rejects.toThrow("errors.localModels.checksumMismatch");

    expect(create).not.toHaveBeenCalled();
    expect(state.updateModel).toHaveBeenCalledWith(modelId, {
      lastError: "errors.localModels.checksumMismatch",
      metadata: { catalogVersion: "test" }
    });
    expect(state.recordTaskRun).not.toHaveBeenCalled();
  });

  it("records the failed rank call and closes the gate when the runtime fails", async () => {
    const ranker = fakeRanker({ failOnCall: 2 });
    const { ai } = service(ranker.adapter);

    await expect(ai.testLocalModel(modelId)).rejects.toThrow("errors.localModels.runtimeFailed");

    expect(state.recordTaskRun.mock.calls.map(([run]) => run.status)).toEqual([
      "succeeded",
      "failed"
    ]);
    expect(state.recordTaskRun.mock.calls[1]![0].error).toBe("errors.localModels.runtimeFailed");
    expect(state.updateModel).toHaveBeenCalledWith(modelId, {
      lastError: "errors.localModels.runtimeFailed",
      metadata: { catalogVersion: "test" }
    });
    expect(ranker.dispose).toHaveBeenCalledTimes(1);
  });

  it("reaches no verdict while another ranker in the ranker slot is running a call", async () => {
    state.model = rankerModel({
      metadata: { catalogVersion: "test", decideValidation: { version: 1 } }
    });
    const { ai, create, internals } = service(fakeRanker().adapter);
    const otherId = "00000000-0000-4000-8000-000000000009";
    internals.resident.rank = {
      localModelId: otherId,
      runtime: "gguf",
      adapter: fakeRanker().adapter
    };
    internals.activeLocalModels.add(otherId);

    await expect(ai.testLocalModel(modelId)).rejects.toThrow("errors.localModels.modelBusy");

    expect(create).not.toHaveBeenCalled();
    expect(state.updateModel).not.toHaveBeenCalled();
  });

  it("does not test a ranker that is not installed", async () => {
    state.model = rankerModel({ status: "not_downloaded", managedPath: null });
    const { ai } = service(fakeRanker().adapter);

    await expect(ai.testLocalModel(modelId)).rejects.toThrow("errors.localModels.notReady");

    expect(state.updateModel).not.toHaveBeenCalled();
  });
});

describe("assigning a ranker to a profile", () => {
  const assign = (ai: AiService, capabilities: string[]) =>
    ai.updateProfile({
      id: modelId,
      modelId: entry.repository,
      runtime: "mlx",
      localModelId: modelId,
      capabilities: capabilities as never
    });

  it("is refused until the ranker is validated for decide", async () => {
    const { ai } = service(fakeRanker().adapter);

    await expect(assign(ai, ["offline"])).rejects.toThrow("errors.localModels.rankerNotValidated");
    expect(state.updateProfile).not.toHaveBeenCalled();
  });

  it("is possible once the validation has exposed reranking", async () => {
    state.model = rankerModel({ capabilities: ["reranking", "offline", "local-files"] });
    const { ai } = service(fakeRanker().adapter);

    await expect(assign(ai, ["reranking"])).resolves.toMatchObject({ localModelId: modelId });
    expect(state.updateProfile).toHaveBeenCalledTimes(1);
  });
});
