import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AiCassette,
  createDecideValidation,
  createRankerParityRecord,
  findLocalModelCatalogEntry,
  rankerCatalogArtifactSha256,
  setAiAdapterDecorator,
  type LocalModelCatalogEntry
} from "@app/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiService, decideRouteKey } from "./ai-service.js";

/**
 * `AiService.rankPairs` (F3 T50, D16): the relation decider's both-direction scoring on the
 * validated ranker of the `class:decide` route. The repository is faked the way the ranker routing
 * tests do; the real route query is proved on a scratch database by `verify-ai-ranker.ts`.
 */

const db = vi.hoisted(() => ({
  routes: new Map<string, string>(),
  selections: new Map<string, Record<string, unknown>>(),
  models: new Map<string, Record<string, unknown>>(),
  recordTaskRun: vi.fn(),
  setAiExecution: vi.fn()
}));

vi.mock("@app/db", async () => {
  const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
  return {
    ...actual,
    createAiConfigRepository: () => ({
      getDefaultTask: async (_task: string, _explicit: unknown, keys: readonly string[]) => {
        const key = keys.find((candidate) => db.routes.has(candidate));
        if (!key) return null;
        const profileId = db.routes.get(key)!;
        return { ...db.selections.get(profileId), routeKey: key, parameters: {} };
      },
      recordTaskRun: db.recordTaskRun,
      listProfiles: async () => [],
      listTaskRoutes: async () => [],
      seedTaskRoute: async () => false
    }),
    createLocalModelRepository: () => ({
      findById: async (id: string) => db.models.get(id) ?? null
    }),
    createJobRepository: () => ({ setAiExecution: db.setAiExecution }),
    createEmbeddingRepository: () => ({ newestNoteVectorSpace: async () => null })
  };
});

const mlxEntry = findLocalModelCatalogEntry("mlx-qwen3-reranker-0.6b")!;
const ggufEntry = findLocalModelCatalogEntry("gguf-qwen3-reranker-0.6b-q8-0")!;
const mlxBuild = "memora-mlx-helper@sha256:" + "a".repeat(64);
const ggufBuild = "node-llama-cpp@3.19.0+llama.cpp@b1/metal/prebuilt";
const mlxId = "00000000-0000-4000-8000-0000000000a1";
const ggufId = "00000000-0000-4000-8000-0000000000a2";

const smoke = {
  passed: true,
  modelCard: { logOdds: [7.6, -11.4], expected: [7.625, -11.375], maxDelta: 0.03 },
  relevance: [{ language: "en", relevant: 8, irrelevant: -8, margin: 16 }],
  failures: []
};

function validation(entry: LocalModelCatalogEntry, runtimeBuild: string, parityShift?: number) {
  const scores = Array.from({ length: 64 }, (_, index) => index * 0.3 - 9);
  const parity =
    parityShift === undefined
      ? undefined
      : createRankerParityRecord({
          runtime: entry.runtime,
          scores,
          runtimeBuild,
          baseline: createRankerParityRecord({
            runtime: entry.runtime,
            scores: scores.map((score) => score - parityShift),
            runtimeBuild: "calibration"
          }).baseline
        });
  return createDecideValidation(
    {
      runtime: entry.runtime,
      revision: entry.revision,
      artifactSha256: rankerCatalogArtifactSha256(entry),
      runtimeBuild
    },
    smoke,
    new Date(),
    parity
  );
}

/** Puts a validated ranker in the library and routes `class:decide` to it. */
function addRanker(kind: "mlx" | "gguf", options: { parityShift?: number } = {}) {
  const entry = kind === "mlx" ? mlxEntry : ggufEntry;
  const id = kind === "mlx" ? mlxId : ggufId;
  const profileId = `00000000-0000-4000-8000-00000000000${kind === "mlx" ? 2 : 3}`;
  db.models.set(id, {
    id,
    catalogId: entry.id,
    modelId: entry.repository,
    runtime: entry.runtime,
    repository: entry.repository,
    revision: entry.revision,
    quantization: entry.quantization,
    status: "ready",
    managedPath: `/nonexistent/local-models/${entry.id}`,
    capabilities: ["reranking", "offline", "local-files"],
    defaultParameters: {},
    metadata: {
      decideValidation: validation(
        entry,
        kind === "mlx" ? mlxBuild : ggufBuild,
        options.parityShift
      )
    }
  });
  db.selections.set(profileId, {
    profileId,
    providerConfigId: null,
    localModelId: id,
    provider: `local-${entry.runtime}`,
    modelId: entry.repository,
    runtime: entry.runtime,
    revision: entry.revision,
    repository: entry.repository,
    quantization: entry.quantization,
    baseUrl: null,
    modelDefaultParameters: {},
    providerMetadata: {},
    requiredCapabilities: ["reranking", "offline", "local-files"]
  });
  db.routes.set(decideRouteKey, profileId);
  return { id, profileId, entry };
}

/** A ranker whose pair k of a call scores 4 − 2k, so a result shows how calls were cut. */
function fakeRanker(runtimeBuild: string, providerId: string) {
  const calls: Array<{
    instruction: string;
    pairs: Array<{ query: string; document: string }>;
    parameters: Record<string, unknown>;
  }> = [];
  const run = vi.fn(
    async (request: { input: string; taskType: string; parameters: Record<string, unknown> }) => {
      const input = JSON.parse(request.input) as {
        instruction: string;
        pairs?: Array<{ query: string; document: string }>;
        documents?: string[];
      };
      if (input.pairs) calls.push({ ...input, pairs: input.pairs, parameters: request.parameters });
      const count = input.pairs?.length ?? input.documents?.length ?? 0;
      const logOdds = Array.from({ length: count }, (_, index) => 4 - index * 2);
      return {
        taskType: request.taskType,
        output: {
          logOdds,
          scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
          tokenCounts: logOdds.map((_, index) => 300 + index),
          truncated: logOdds.map((_, index) => index === 1)
        },
        providerId,
        modelId: "ranker",
        runtime: "local",
        durationMs: 11,
        inputTokens: 1,
        outputTokens: 0,
        costEstimate: 0
      };
    }
  );
  const dispose = vi.fn(async () => undefined);
  return {
    calls,
    run,
    dispose,
    adapter: (modelId: string) => ({
      describe: () => ({
        providerId,
        modelId,
        runtime: "local",
        capabilities: ["reranking", "offline", "local-files"],
        parameterCapabilities: {},
        limits: {},
        requirements: {}
      }),
      canHandle: () => true,
      run,
      runtimeBuild: async () => runtimeBuild,
      dispose
    })
  };
}

function service(options: { machine?: { platform: string; arch: string } } = {}) {
  const ai = new AiService({
    userDataPath: "/tmp/ai-rank-pairs-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    machine: options.machine ?? { platform: "darwin", arch: "arm64" }
  });
  const internals = ai as unknown as {
    buildRankerAdapter: (model: { modelId: string; runtime: string }) => unknown;
    validatingRankers: Map<string, number>;
  };
  const mlx = fakeRanker(mlxBuild, "local-mlx");
  const gguf = fakeRanker(ggufBuild, "local-gguf");
  vi.spyOn(internals, "buildRankerAdapter").mockImplementation((model) =>
    model.runtime === "mlx" ? mlx.adapter(model.modelId) : gguf.adapter(model.modelId)
  );
  return { ai, mlx, gguf, internals };
}

const instruction = "Decide whether the two notes make a claim about the same mechanism.";

/** Directed pairs `p0 → q0`, `q0 → p0`, … as the matcher sends both directions of a candidate. */
function pairs(count: number): Array<{ query: string; document: string }> {
  return Array.from({ length: count }, (_, index) => {
    const note = Math.floor(index / 2);
    const [from, to] = index % 2 === 0 ? ["p", "q"] : ["q", "p"];
    return {
      query: `Title: ${from}${note}\nIdea: First note ${note}.`,
      document: `Title: ${to}${note}\nIdea: Second note ${note}.`
    };
  });
}

const input = { operation: "relations_decide", instruction, sourceIds: [] as string[] };

beforeEach(() => {
  db.routes.clear();
  db.selections.clear();
  db.models.clear();
  db.recordTaskRun.mockReset().mockImplementation(async () => crypto.randomUUID());
  db.setAiExecution.mockReset().mockResolvedValue(undefined);
});

describe("rankPairs on a validated dedicated ranker", () => {
  it("scores both directions in one call and audits it on its own row with the helper batch", async () => {
    addRanker("mlx");
    const { ai, mlx } = service();
    const list = pairs(6);

    const result = await ai.rankPairs({ ...input, pairs: list });

    expect(mlx.run).toHaveBeenCalledOnce();
    const request = mlx.run.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(request).toMatchObject({
      taskType: "reranking",
      requiredCapabilities: ["reranking"],
      parameters: { batchSize: 16 },
      workloadClass: "decide",
      operation: "relations_decide"
    });
    expect(JSON.parse(request.input as string)).toEqual({ instruction, pairs: list });
    expect(result).toMatchObject({
      logOdds: [4, 2, 0, -2, -4, -6],
      tokenCounts: [300, 301, 302, 303, 304, 305],
      calls: 1,
      provider: "local-mlx",
      runtime: "mlx",
      runtimeBuild: mlxBuild,
      parameters: { batchSize: 16 },
      uncalibrated: false,
      durationMs: 11
    });
    expect(result.aiTaskRunIds).toHaveLength(1);
    expect(db.recordTaskRun).toHaveBeenCalledOnce();
    expect(db.recordTaskRun.mock.calls[0]![0]).toMatchObject({
      taskType: "reranking",
      provider: "local-mlx",
      parameters: { batchSize: 16 },
      inputTokens: 1_815,
      outputTokens: 0,
      costEstimate: 0,
      status: "succeeded"
    });
    expect(result.aiTaskRunIds[0]).toBe(await db.recordTaskRun.mock.results[0]!.value);
  });

  it("splits a longer list at 32 pairs per MLX call, in order, one audit row per call", async () => {
    addRanker("mlx");
    const { ai, mlx } = service();
    const list = pairs(70);

    const result = await ai.rankPairs({ ...input, pairs: list });

    expect(mlx.calls.map((call) => call.pairs.length)).toEqual([32, 32, 6]);
    expect(mlx.calls.flatMap((call) => call.pairs)).toEqual(list);
    expect(mlx.calls.map((call) => call.parameters)).toEqual([
      { batchSize: 16 },
      { batchSize: 16 },
      { batchSize: 16 }
    ]);
    expect(result.calls).toBe(3);
    expect(result.logOdds).toHaveLength(70);
    // Each call restarts its own scores (4 − 2k), so the cuts show in the concatenation.
    expect(result.logOdds.slice(30, 34)).toEqual([-56, -58, 4, 2]);
    expect(result.aiTaskRunIds).toHaveLength(3);
    expect(new Set(result.aiTaskRunIds).size).toBe(3);
    expect(db.recordTaskRun).toHaveBeenCalledTimes(3);
    expect(result.durationMs).toBe(33);
  });

  it("splits at 16 pairs per GGUF call and sends no helper batch", async () => {
    addRanker("gguf");
    const { ai, gguf } = service({ machine: { platform: "linux", arch: "x64" } });

    const result = await ai.rankPairs({ ...input, pairs: pairs(40), helperBatchSize: 1 });

    expect(gguf.calls.map((call) => call.pairs.length)).toEqual([16, 16, 8]);
    expect(gguf.calls.map((call) => call.parameters)).toEqual([{}, {}, {}]);
    expect(result).toMatchObject({
      calls: 3,
      provider: "local-gguf",
      runtimeBuild: ggufBuild,
      parameters: {}
    });
    expect(db.recordTaskRun.mock.calls.map(([run]) => run.parameters)).toEqual([{}, {}, {}]);
  });

  it("carries the helper batch size a caller asks for, so batch 1 and batch 16 are distinct requests", async () => {
    addRanker("mlx");
    const { ai, mlx } = service();

    const batch1 = await ai.rankPairs({ ...input, pairs: pairs(4), helperBatchSize: 1 });
    const batch16 = await ai.rankPairs({ ...input, pairs: pairs(4) });

    expect(mlx.calls.map((call) => call.parameters)).toEqual([{ batchSize: 1 }, { batchSize: 16 }]);
    expect(batch1.parameters).toEqual({ batchSize: 1 });
    expect(batch16.parameters).toEqual({ batchSize: 16 });
    expect(mlx.calls[0]!.pairs).toEqual(mlx.calls[1]!.pairs);
  });

  it("validates the whole list before the first call waits for the lane", async () => {
    addRanker("mlx");
    const { ai, mlx } = service();
    const list = pairs(40);

    await expect(
      ai.rankPairs({ ...input, pairs: [...list, { query: " ", document: "x" }] })
    ).rejects.toThrow("errors.ai.unsupportedTask");
    await expect(ai.rankPairs({ ...input, pairs: [] })).rejects.toThrow(
      "errors.ai.unsupportedTask"
    );
    await expect(ai.rankPairs({ ...input, instruction: "  ", pairs: list })).rejects.toThrow(
      "errors.ai.unsupportedTask"
    );
    await expect(ai.rankPairs({ ...input, pairs: list, helperBatchSize: 0 })).rejects.toThrow(
      "errors.ai.unsupportedTask"
    );

    expect(mlx.run).not.toHaveBeenCalled();
    expect(db.recordTaskRun).not.toHaveBeenCalled();
  });

  it("lets a P0 call in between the calls of a long list: it waits for at most one", async () => {
    addRanker("mlx");
    const { ai, mlx } = service();
    const order: string[] = [];
    const firstCall = Promise.withResolvers<void>();
    const base = mlx.run.getMockImplementation()!;
    mlx.run.mockImplementation(async (request) => {
      const kind = "pairs" in JSON.parse(request.input) ? "pairs" : "documents";
      order.push(kind);
      if (order.length === 1) await firstCall.promise;
      return base(request);
    });

    const background = ai.rankPairs({ ...input, pairs: pairs(64), priority: "background" });
    await vi.waitFor(() => expect(order).toEqual(["pairs"]));
    const interactive = ai.rank({
      operation: "topic_overview_support",
      instruction,
      query: "Title: a",
      documents: ["Topic: b"],
      priority: "interactive"
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    firstCall.resolve();
    await Promise.all([background, interactive]);

    // The second pairs call waited for the P0 rank call: one bounded call, not the whole list.
    expect(order).toEqual(["pairs", "documents", "pairs"]);
  });

  it("stops between calls once the signal aborts", async () => {
    addRanker("mlx");
    const { ai, mlx } = service();
    const controller = new AbortController();
    const base = mlx.run.getMockImplementation()!;
    mlx.run.mockImplementation(async (request) => {
      controller.abort();
      return base(request);
    });

    await expect(ai.rankPairs({ ...input, pairs: pairs(64) }, controller.signal)).rejects.toThrow();

    expect(mlx.run).toHaveBeenCalledOnce();
  });
});

describe("availability of the ranker for pairs", () => {
  it("fails visibly without a decide route and on a model that is not a ranker", async () => {
    const { ai, mlx } = service();

    await expect(ai.rankPairs({ ...input, pairs: pairs(2) })).rejects.toThrow(
      "errors.ai.noCompatibleModel"
    );
    expect(mlx.run).not.toHaveBeenCalled();
  });

  it("refuses a ranker whose runtime build changed since its validation, as rank does", async () => {
    addRanker("mlx");
    const { ai } = service();
    const stale = fakeRanker("memora-mlx-helper@sha256:" + "c".repeat(64), "local-mlx");
    vi.spyOn(
      ai as unknown as { buildRankerAdapter: (model: { modelId: string }) => unknown },
      "buildRankerAdapter"
    ).mockImplementation((model) => stale.adapter(model.modelId));

    await expect(ai.rankPairs({ ...input, pairs: pairs(4) })).rejects.toThrow(
      "errors.localModels.rankerNotValidated"
    );

    expect(stale.run).not.toHaveBeenCalled();
    expect(db.recordTaskRun.mock.calls[0]![0]).toMatchObject({
      status: "failed",
      error: "errors.localModels.rankerNotValidated"
    });
  });

  it("is unavailable while its validation runs: callers take the no-decider path, no waiting", async () => {
    const { id } = addRanker("mlx");
    const { ai, mlx, internals } = service();
    internals.validatingRankers.set(id, 1);

    await expect(ai.decideRouteStatus("topic_gate")).resolves.toBe("not_validated");
    await expect(ai.decideRouteStatus("relations_decide", "pairs")).resolves.toBe("not_validated");
    await expect(
      ai.rank({ operation: "topic_gate", instruction, query: "q", documents: ["d"] })
    ).rejects.toThrow("errors.localModels.rankerNotValidated");
    await expect(ai.rankPairs({ ...input, pairs: pairs(2) })).rejects.toThrow(
      "errors.localModels.rankerNotValidated"
    );
    expect(mlx.run).not.toHaveBeenCalled();
    expect(db.recordTaskRun).not.toHaveBeenCalled();

    internals.validatingRankers.delete(id);
    await expect(ai.decideRouteStatus("topic_gate")).resolves.toBe("ready");
    await expect(ai.rankPairs({ ...input, pairs: pairs(2) })).resolves.toMatchObject({ calls: 1 });
  });

  it("keeps scoring pairs for the relation decider after a failed parity check, flagged uncalibrated", async () => {
    addRanker("mlx", { parityShift: 0.5 });
    const { ai, mlx } = service();

    const result = await ai.rankPairs({ ...input, pairs: pairs(4) });

    expect(result.uncalibrated).toBe(true);
    expect(mlx.run).toHaveBeenCalledOnce();
    await expect(ai.decideRouteStatus("relations_decide", "pairs")).resolves.toBe("ready");
  });

  it("takes the topic gate to its no-decider path after a failed parity check", async () => {
    addRanker("mlx", { parityShift: 0.5 });
    const { ai, mlx } = service();

    await expect(ai.decideRouteStatus("topic_gate")).resolves.toBe("not_validated");
    await expect(
      ai.rank({ operation: "topic_gate", instruction, query: "q", documents: ["d"] })
    ).rejects.toThrow("errors.localModels.rankerNotValidated");

    expect(mlx.run).not.toHaveBeenCalled();
  });

  it("serves the topic gate and reports calibrated pairs after a parity check within the limit", async () => {
    addRanker("mlx", { parityShift: 0.125 });
    const { ai } = service();

    await expect(ai.decideRouteStatus("topic_gate")).resolves.toBe("ready");
    await expect(ai.rankPairs({ ...input, pairs: pairs(2) })).resolves.toMatchObject({
      uncalibrated: false
    });
  });
});

describe("the cassette wrap of rankPairs", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-rank-pairs-cassette-"));
  });
  afterEach(async () => {
    setAiAdapterDecorator(null);
    await rm(directory, { recursive: true, force: true });
  });

  it("records a pairs call and replays it without running the ranker; batch 1 is another entry", async () => {
    addRanker("mlx");
    const list = pairs(8);

    setAiAdapterDecorator((adapter) => new AiCassette({ mode: "record", directory }).wrap(adapter));
    const live = service();
    const recorded = await live.ai.rankPairs({ ...input, pairs: list });
    expect(live.mlx.run).toHaveBeenCalledOnce();

    const replayCassette = new AiCassette({ mode: "replay", directory });
    setAiAdapterDecorator((adapter) => replayCassette.wrap(adapter));
    const offline = service();
    const replayed = await offline.ai.rankPairs({ ...input, pairs: list });

    expect(offline.mlx.run).not.toHaveBeenCalled();
    expect(replayed.logOdds).toEqual(recorded.logOdds);
    expect(replayed.tokenCounts).toEqual(recorded.tokenCounts);
    await expect(
      offline.ai.rankPairs({ ...input, pairs: list, helperBatchSize: 1 })
    ).rejects.toThrow(/cassette miss/iu);
    expect(offline.mlx.run).not.toHaveBeenCalled();
  });
});
