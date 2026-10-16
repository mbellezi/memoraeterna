import {
  createDecideValidation,
  findLocalModelCatalogEntry,
  rankerCatalogArtifactSha256,
  type LocalModelCatalogEntry
} from "@app/ai";
import { aiRouteKeys } from "@app/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiService, decideRouteKey, writeFastRouteKey } from "./ai-service.js";
import { runLocalModelInstallStartup } from "./local-model-install-startup.js";

/**
 * Routing of F2 T14 (D17, D18): the operation override, the stated class route and the task route,
 * the rank path on a validated dedicated ranker, and the seeding of the class routes. The fake
 * repository resolves routes the way `getDefaultTask` does in SQL (the real query is proved on a
 * scratch database by `verify-ai-ranker.ts`).
 */

interface FakeSelection {
  profileId: string;
  providerConfigId: string | null;
  localModelId: string | null;
  provider: string;
  modelId: string;
  runtime: string;
  revision: string | null;
  repository: string | null;
  quantization: string | null;
  baseUrl: string | null;
  modelDefaultParameters: Record<string, unknown>;
  providerMetadata: Record<string, unknown>;
  requiredCapabilities: string[];
}

const db = vi.hoisted(() => ({
  routes: new Map<string, string>(),
  profileTasks: new Map<string, Record<string, unknown>>(),
  profiles: [] as Array<Record<string, unknown>>,
  selections: new Map<string, FakeSelection>(),
  models: new Map<string, Record<string, unknown>>(),
  recordTaskRun: vi.fn(),
  setAiExecution: vi.fn()
}));

vi.mock("@app/db", async () => {
  const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
  const getDefaultTask = vi.fn(
    async (task: string, explicit?: string, keys: readonly string[] = [task]) => {
      let profileId: string | undefined;
      let routeKey = task;
      if (explicit) profileId = explicit;
      else {
        const key = keys.find((candidate) => db.routes.has(candidate));
        if (key) {
          profileId = db.routes.get(key);
          routeKey = key;
        } else profileId = db.profiles.find((profile) => profile.isDefault)?.id as string;
      }
      if (!profileId) return null;
      const parameters = db.profileTasks.get(`${profileId}|${routeKey}`);
      if (!explicit && !parameters) return null;
      const base = db.selections.get(profileId);
      return base ? { ...base, routeKey, parameters: parameters ?? {} } : null;
    }
  );
  return {
    ...actual,
    createAiConfigRepository: () => ({
      getDefaultTask,
      recordTaskRun: db.recordTaskRun,
      listProfiles: async () => db.profiles,
      listTaskRoutes: async () => [...db.routes].map(([task, profileId]) => ({ task, profileId })),
      listProfileTasks: async () =>
        [...db.profileTasks.keys()].map((key) => {
          const [profileId, task] = key.split("|") as [string, string];
          return { profileId, task, parameters: {} };
        }),
      // The profile writes of the Settings flow: create, then attach the model (the join of
      // `getDefaultTask` is the selection, which follows the model the profile holds).
      createProfile: vi.fn(async (input: Record<string, unknown>) => {
        const record = profile(`00000000-0000-4000-8000-0000000001${db.profiles.length}0`, {
          providerConfigId: null,
          modelId: null,
          runtime: null,
          capabilities: [],
          createdAt: new Date("2026-03-01T00:00:00Z"),
          ...input
        });
        db.profiles.push(record);
        return record;
      }),
      updateProfile: vi.fn(async (input: Record<string, unknown>) => {
        const { id, ...changes } = input;
        const record = db.profiles.find((candidate) => candidate.id === id)!;
        Object.assign(record, changes);
        const model = db.models.get(String(record.localModelId));
        if (model) db.selections.set(String(id), rankerSelection(String(id), model as never));
        return record;
      }),
      seedTaskRoute: vi.fn(async (task: string, profileId: string) => {
        if (db.routes.has(task)) return false;
        db.routes.set(task, profileId);
        if (!db.profileTasks.has(`${profileId}|${task}`))
          db.profileTasks.set(`${profileId}|${task}`, {});
        return true;
      })
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

const ids = {
  writer: "00000000-0000-4000-8000-000000000001",
  mlxRankerProfile: "00000000-0000-4000-8000-000000000002",
  ggufRankerProfile: "00000000-0000-4000-8000-000000000003",
  topicProfile: "00000000-0000-4000-8000-000000000004",
  mlxRanker: "00000000-0000-4000-8000-0000000000a1",
  ggufRanker: "00000000-0000-4000-8000-0000000000a2"
};

const smoke = {
  passed: true,
  modelCard: { logOdds: [7.6, -11.4], expected: [7.625, -11.375], maxDelta: 0.03 },
  relevance: [{ language: "en", relevant: 8, irrelevant: -8, margin: 16 }],
  failures: []
};

function rankerModel(
  id: string,
  entry: LocalModelCatalogEntry,
  runtimeBuild: string,
  overrides: Record<string, unknown> = {}
) {
  return {
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
      decideValidation: createDecideValidation(
        {
          runtime: entry.runtime,
          revision: entry.revision,
          artifactSha256: rankerCatalogArtifactSha256(entry),
          runtimeBuild
        },
        smoke
      )
    },
    ...overrides
  };
}

function profile(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    description: null,
    isDefault: false,
    privacyMode: "allow_remote",
    outputLanguage: "ui",
    providerConfigId: "provider-1",
    localModelId: null,
    modelId: "writer-model",
    runtime: "remote",
    capabilities: ["text-generation", "structured-output", "summarization"],
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  };
}

function remoteSelection(profileId: string, modelId = "writer-model"): FakeSelection {
  return {
    profileId,
    providerConfigId: "provider-1",
    localModelId: null,
    provider: "openai-compatible",
    modelId,
    runtime: "remote",
    revision: null,
    repository: null,
    quantization: null,
    baseUrl: "https://example.test",
    modelDefaultParameters: {},
    providerMetadata: {},
    requiredCapabilities: ["text-generation", "structured-output", "summarization"]
  };
}

function rankerSelection(profileId: string, model: ReturnType<typeof rankerModel>): FakeSelection {
  return {
    profileId,
    providerConfigId: null,
    localModelId: model.id,
    provider: `local-${model.runtime}`,
    modelId: model.modelId,
    runtime: model.runtime,
    revision: model.revision,
    repository: model.repository,
    quantization: model.quantization,
    baseUrl: null,
    modelDefaultParameters: {},
    providerMetadata: {},
    requiredCapabilities: ["reranking", "offline", "local-files"]
  };
}

/** Puts a validated ranker in the library with a profile that holds it. */
function addRanker(kind: "mlx" | "gguf", options: { route?: boolean } = {}) {
  const entry = kind === "mlx" ? mlxEntry : ggufEntry;
  const model = rankerModel(
    kind === "mlx" ? ids.mlxRanker : ids.ggufRanker,
    entry,
    kind === "mlx" ? mlxBuild : ggufBuild
  );
  const profileId = kind === "mlx" ? ids.mlxRankerProfile : ids.ggufRankerProfile;
  db.models.set(model.id, model);
  db.profiles.push(
    profile(profileId, {
      providerConfigId: null,
      localModelId: model.id,
      modelId: model.modelId,
      runtime: model.runtime,
      privacyMode: "offline_only",
      capabilities: ["reranking", "offline", "local-files"],
      createdAt: new Date(kind === "mlx" ? "2026-02-01T00:00:00Z" : "2026-01-15T00:00:00Z")
    })
  );
  db.selections.set(profileId, rankerSelection(profileId, model));
  if (options.route) {
    db.routes.set(decideRouteKey, profileId);
    db.profileTasks.set(`${profileId}|${decideRouteKey}`, {});
  }
  return { model, profileId };
}

/** A ranker that scores documents by position: the first highest. */
function fakeRanker(runtimeBuild: string, providerId = "local-mlx") {
  const run = vi.fn(async (request: { input: string; taskType: string }) => {
    const rank = JSON.parse(request.input) as { documents: string[] };
    const logOdds = rank.documents.map((_, index) => 4 - index * 2);
    return {
      taskType: request.taskType,
      output: {
        logOdds,
        scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
        tokenCounts: logOdds.map((_, index) => 90 + index),
        truncated: logOdds.map((_, index) => index === 1)
      },
      providerId,
      modelId: "ranker",
      runtime: "local",
      durationMs: 7,
      inputTokens: 1,
      outputTokens: 0,
      costEstimate: 0
    };
  });
  const dispose = vi.fn(async () => undefined);
  return {
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

function service(
  options: {
    machine?: { platform: string; arch: string };
    onRoutesSeeded?: (tasks: readonly string[]) => void;
  } = {}
) {
  const getContentLanguage = vi.fn(async () => "pt-BR");
  const ai = new AiService({
    userDataPath: "/tmp/ai-ranker-routing-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    getContentLanguage,
    machine: options.machine ?? { platform: "darwin", arch: "arm64" },
    ...(options.onRoutesSeeded ? { onRoutesSeeded: options.onRoutesSeeded } : {})
  });
  const remote = vi.fn(
    async (request: { taskType: string; input: unknown; workloadClass?: string }) => ({
      taskType: request.taskType,
      output: "{}",
      providerId: "openai-compatible",
      modelId: "writer-model",
      runtime: "remote",
      durationMs: 1
    })
  );
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
    buildRankerAdapter: (model: { modelId: string; runtime: string }) => unknown;
  };
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter({
      describe: () => ({
        providerId: "openai-compatible",
        modelId: "writer-model",
        runtime: "remote",
        capabilities: ["text-generation", "structured-output", "summarization"],
        parameterCapabilities: {}
      }),
      canHandle: () => true,
      run: remote
    })
  );
  const mlxRanker = fakeRanker(mlxBuild, "local-mlx");
  const ggufRanker = fakeRanker(ggufBuild, "local-gguf");
  const build = vi
    .spyOn(internals, "buildRankerAdapter")
    .mockImplementation((model) =>
      model.runtime === "mlx" ? mlxRanker.adapter(model.modelId) : ggufRanker.adapter(model.modelId)
    );
  return { ai, remote, mlxRanker, ggufRanker, build, getContentLanguage };
}

const gateInput = {
  operation: "topic_gate",
  instruction: "Judge whether the note belongs under the topic",
  query: "Title: Photosynthesis\nIdea: Plants turn light into sugar.",
  documents: ["Topic: Plant biology", "Topic: Football", "Topic: Cell energy"],
  sourceIds: ["00000000-0000-4000-8000-0000000000f1"]
};

beforeEach(() => {
  db.routes.clear();
  db.profileTasks.clear();
  db.profiles.length = 0;
  db.selections.clear();
  db.models.clear();
  db.recordTaskRun.mockReset().mockImplementation(async () => crypto.randomUUID());
  db.setAiExecution.mockReset().mockResolvedValue(undefined);
  // The writer: the default profile, routed for the prompt tasks note matching uses.
  db.profiles.push(profile(ids.writer, { isDefault: true }));
  db.selections.set(ids.writer, remoteSelection(ids.writer));
  for (const task of ["reranking", "structured-output", "summarization", "text-generation"]) {
    db.routes.set(task, ids.writer);
    db.profileTasks.set(`${ids.writer}|${task}`, {});
  }
});

describe("route keys", () => {
  it("resolve the operation override, then a stated class, then the task", () => {
    expect(
      aiRouteKeys("structured-output", { operation: "topic_name", workloadClass: "write-fast" })
    ).toEqual(["op:topic_name", "class:write-fast", "structured-output"]);
    // Note matching states no class: its task's derived class (decide) is never a route key.
    expect(aiRouteKeys("reranking", { operation: "note_matching_reranking" })).toEqual([
      "op:note_matching_reranking",
      "reranking"
    ]);
  });
});

describe("rank on a validated dedicated ranker", () => {
  it("sends the rank request with no language prefix, generation defaults or context check", async () => {
    addRanker("mlx", { route: true });
    const { ai, mlxRanker, remote, getContentLanguage } = service();

    const result = await ai.rank(gateInput);

    expect(mlxRanker.run).toHaveBeenCalledOnce();
    const request = mlxRanker.run.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(request.input).toBe(
      JSON.stringify({
        instruction: gateInput.instruction,
        query: gateInput.query,
        documents: gateInput.documents
      })
    );
    expect(request).toMatchObject({
      taskType: "reranking",
      requiredCapabilities: ["reranking"],
      parameters: {},
      workloadClass: "decide",
      operation: "topic_gate",
      profileId: ids.mlxRankerProfile
    });
    expect(getContentLanguage).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      logOdds: [4, 2, 0],
      tokenCounts: [90, 91, 92],
      truncated: [false, true, false],
      profileId: ids.mlxRankerProfile,
      localModelId: ids.mlxRanker,
      runtime: "mlx"
    });
  });

  it("audits the evaluated tokens, no output tokens and cost 0", async () => {
    addRanker("mlx", { route: true });
    const { ai } = service();

    const result = await ai.rank(gateInput);

    expect(db.recordTaskRun).toHaveBeenCalledOnce();
    const run = db.recordTaskRun.mock.calls[0]![0];
    expect(run).toMatchObject({
      profileId: ids.mlxRankerProfile,
      taskType: "reranking",
      provider: "local-mlx",
      modelId: mlxEntry.repository,
      runtime: "mlx",
      adapter: "mlx-swift-lm",
      revision: mlxEntry.revision,
      capabilitiesUsed: ["reranking", "offline"],
      parameters: {},
      inputTokens: 273,
      outputTokens: 0,
      costEstimate: 0,
      durationMs: 7,
      status: "succeeded",
      sourceItemIds: gateInput.sourceIds
    });
    expect(run.queueMs).toBeGreaterThanOrEqual(0);
    expect(run.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.aiTaskRunId).toBe(await db.recordTaskRun.mock.results[0]!.value);
  });

  it("is never run by the reranking route of note matching, and matching never reaches the ranker", async () => {
    addRanker("mlx", { route: true });
    const { ai, mlxRanker, remote } = service();

    await ai.runDefaultTask("reranking", "Decide the relation of these notes.", {
      operation: "note_matching_reranking"
    });

    expect(remote).toHaveBeenCalledOnce();
    expect(remote.mock.calls[0]![0]).toMatchObject({ taskType: "reranking" });
    expect(remote.mock.calls[0]![0].workloadClass).toBeUndefined();
    expect(mlxRanker.run).not.toHaveBeenCalled();
    expect(db.recordTaskRun.mock.calls[0]![0]).toMatchObject({ profileId: ids.writer });
  });

  it("fails visibly without a decide route and never falls back to the generative decider", async () => {
    const { ai, remote, build } = service();

    await expect(ai.rank(gateInput)).rejects.toThrow("errors.ai.noCompatibleModel");
    await expect(ai.decideRouteStatus("topic_gate")).resolves.toBe("missing");

    expect(remote).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(db.recordTaskRun).not.toHaveBeenCalled();
  });

  it("fails visibly when the decide route holds a generative model", async () => {
    db.routes.set(decideRouteKey, ids.writer);
    db.profileTasks.set(`${ids.writer}|${decideRouteKey}`, {});
    const { ai, remote } = service();

    await expect(ai.rank(gateInput)).rejects.toThrow("errors.ai.unsupportedTask");
    await expect(ai.decideRouteStatus()).resolves.toBe("incompatible");
    expect(remote).not.toHaveBeenCalled();
  });

  it("fails visibly on a ranker whose decide validation is missing or names another artifact", async () => {
    const { model } = addRanker("mlx", { route: true });
    const { ai, mlxRanker } = service();

    db.models.set(model.id, { ...model, metadata: {} });
    await expect(ai.rank(gateInput)).rejects.toThrow("errors.localModels.rankerNotValidated");
    await expect(ai.decideRouteStatus()).resolves.toBe("not_validated");

    db.models.set(model.id, {
      ...model,
      metadata: {
        decideValidation: {
          ...(model.metadata.decideValidation as Record<string, unknown>),
          artifactSha256: "b".repeat(64)
        }
      }
    });
    await expect(ai.rank(gateInput)).rejects.toThrow("errors.localModels.rankerNotValidated");

    db.models.set(model.id, { ...model, status: "not_downloaded", managedPath: null });
    await expect(ai.decideRouteStatus()).resolves.toBe("not_ready");
    expect(mlxRanker.run).not.toHaveBeenCalled();
  });

  it("refuses a ranker whose runtime build changed since its validation, before any call", async () => {
    addRanker("mlx", { route: true });
    const { ai, build } = service();
    const stale = fakeRanker("memora-mlx-helper@sha256:" + "c".repeat(64));
    build.mockImplementation((model) => stale.adapter(model.modelId));

    // The cheap status reads only the stored record; the build is checked once the ranker loads.
    await expect(ai.decideRouteStatus()).resolves.toBe("ready");
    await expect(ai.rank(gateInput)).rejects.toThrow("errors.localModels.rankerNotValidated");

    expect(stale.run).not.toHaveBeenCalled();
    expect(db.recordTaskRun.mock.calls[0]![0]).toMatchObject({
      taskType: "reranking",
      status: "failed",
      error: "errors.localModels.rankerNotValidated"
    });
  });

  it("takes an operation override before the decide class route", async () => {
    addRanker("mlx", { route: true });
    const { profileId } = addRanker("gguf");
    db.routes.set("op:topic_gate", profileId);
    db.profileTasks.set(`${profileId}|op:topic_gate`, {});
    const { ai, mlxRanker, ggufRanker } = service();

    await expect(ai.rank(gateInput)).resolves.toMatchObject({ runtime: "gguf" });
    await expect(
      ai.rank({ ...gateInput, operation: "topic_overview_support" })
    ).resolves.toMatchObject({ runtime: "mlx" });

    expect(ggufRanker.run).toHaveBeenCalledOnce();
    expect(mlxRanker.run).toHaveBeenCalledOnce();
  });

  it("keeps the ranker resident between calls", async () => {
    addRanker("mlx", { route: true });
    const { ai, build, mlxRanker } = service();

    await ai.rank(gateInput);
    await ai.rank(gateInput);
    await ai.releaseLocalRuntime(false, false);
    await ai.rank(gateInput);

    expect(build).toHaveBeenCalledOnce();
    expect(mlxRanker.run).toHaveBeenCalledTimes(3);
    expect(mlxRanker.dispose).not.toHaveBeenCalled();
  });

  it("reads the runtime build once per resident ranker and again after a failed read", async () => {
    addRanker("mlx", { route: true });
    const { ai, build } = service();
    const ranker = fakeRanker(mlxBuild);
    const runtimeBuild = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("errors.localModels.runtimeUnavailable"))
      .mockResolvedValue(mlxBuild);
    build.mockImplementation((model) => ({ ...ranker.adapter(model.modelId), runtimeBuild }));

    await expect(ai.rank(gateInput)).rejects.toThrow("errors.localModels.runtimeUnavailable");
    await ai.rank(gateInput);
    await ai.rank(gateInput);

    expect(runtimeBuild).toHaveBeenCalledTimes(2);
    expect(ranker.run).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid rank request before it waits for the AI queue", async () => {
    addRanker("mlx", { route: true });
    const { ai, mlxRanker } = service();

    await expect(ai.rank({ ...gateInput, documents: [] })).rejects.toThrow(
      "errors.ai.unsupportedTask"
    );
    expect(mlxRanker.run).not.toHaveBeenCalled();
  });
});

describe("operation and class routes of prompt tasks", () => {
  it("lets an operation override win over the class and task routes", async () => {
    db.profiles.push(profile(ids.topicProfile));
    db.selections.set(ids.topicProfile, remoteSelection(ids.topicProfile, "namer"));
    db.routes.set("op:topic_name", ids.topicProfile);
    db.profileTasks.set(`${ids.topicProfile}|op:topic_name`, { temperature: 0.1 });
    db.routes.set(writeFastRouteKey, ids.writer);
    db.profileTasks.set(`${ids.writer}|${writeFastRouteKey}`, {});
    const { ai, remote } = service();

    await ai.runDefaultTask("structured-output", "Name these topics.", {
      operation: "topic_name",
      workloadClass: "write-fast"
    });

    expect(db.recordTaskRun.mock.calls[0]![0]).toMatchObject({ profileId: ids.topicProfile });
    expect(remote.mock.calls[0]![0]).toMatchObject({
      profileId: ids.topicProfile,
      modelId: "namer",
      operation: "topic_name",
      workloadClass: "write-fast"
    });
  });

  it("uses the stated class route before the task route, and the task route without one", async () => {
    db.profiles.push(profile(ids.topicProfile));
    db.selections.set(ids.topicProfile, remoteSelection(ids.topicProfile, "fast-writer"));
    db.routes.set(writeFastRouteKey, ids.topicProfile);
    db.profileTasks.set(`${ids.topicProfile}|${writeFastRouteKey}`, {});
    const { ai, remote } = service();

    await ai.runDefaultTask("structured-output", "Name these topics.", {
      operation: "topic_name",
      workloadClass: "write-fast"
    });
    await ai.runDefaultTask("structured-output", "Answer.", { operation: "ask" });

    expect(remote.mock.calls.map(([request]) => request.workloadClass)).toEqual([
      "write-fast",
      undefined
    ]);
    expect(db.recordTaskRun.mock.calls.map(([run]) => run.profileId)).toEqual([
      ids.topicProfile,
      ids.writer
    ]);
  });

  it("falls back to the task route when the stated class has no route", async () => {
    const { ai, remote } = service();

    await ai.runDefaultTask("structured-output", "Name these topics.", {
      workloadClass: "write-fast"
    });

    expect(remote.mock.calls[0]![0]).toMatchObject({ workloadClass: "write-fast" });
    expect(db.recordTaskRun.mock.calls[0]![0]).toMatchObject({ profileId: ids.writer });
  });

  it("hides class and operation routes from the settings lists", async () => {
    addRanker("mlx", { route: true });
    db.routes.set("op:topic_name", ids.writer);
    db.profileTasks.set(`${ids.writer}|op:topic_name`, {});
    const { ai } = service();

    const routes = await ai.listTaskRoutes();
    const tasks = await ai.listProfileTasks();

    expect(routes.map((route) => route.task).sort()).toEqual([
      "reranking",
      "structured-output",
      "summarization",
      "text-generation"
    ]);
    expect(tasks.every((task) => !task.task.includes(":"))).toBe(true);
  });
});

describe("seeding the class routes", () => {
  it("seeds class:decide with the MLX ranker when both are validated on macOS arm64", async () => {
    addRanker("gguf");
    addRanker("mlx");
    const { ai } = service({ machine: { platform: "darwin", arch: "arm64" } });

    await expect(ai.decideRouteStatus()).resolves.toBe("ready");

    expect(db.routes.get(decideRouteKey)).toBe(ids.mlxRankerProfile);
  });

  it("tells its listener which routes a seeding created (the first-run ranker follows)", async () => {
    addRanker("mlx");
    const seeded: string[][] = [];
    const { ai } = service({ onRoutesSeeded: (tasks) => seeded.push([...tasks]) });

    await ai.decideRouteStatus();
    await ai.decideRouteStatus();

    expect(seeded).toEqual([expect.arrayContaining([decideRouteKey])]);
  });

  it("seeds class:decide with the GGUF ranker on a machine without MLX", async () => {
    addRanker("gguf");
    addRanker("mlx");
    const { ai } = service({ machine: { platform: "linux", arch: "x64" } });

    await ai.decideRouteStatus();

    expect(db.routes.get(decideRouteKey)).toBe(ids.ggufRankerProfile);
  });

  it("never seeds a ranker whose validation does not hold, nor a task route with a ranker", async () => {
    const { model } = addRanker("mlx");
    db.models.set(model.id, { ...model, metadata: {} });
    db.routes.delete("reranking");
    db.profiles.splice(0, 1);
    const { ai } = service();

    await ai.decideRouteStatus();

    expect(db.routes.has(decideRouteKey)).toBe(false);
    // The ranker profile is the only one, yet the prompt route of `reranking` stays unrouted.
    expect(db.routes.has("reranking")).toBe(false);
  });

  it("seeds class:write-fast from the writer route when it writes structured output", async () => {
    const { ai } = service();

    await ai.runDefaultTask("embedding", "text");

    expect(db.routes.get(writeFastRouteKey)).toBe(ids.writer);
  });

  it("does not seed class:write-fast with a remote writer when the default profile is local", async () => {
    db.profiles.length = 0;
    db.profiles.push(
      profile("00000000-0000-4000-8000-0000000000b1", {
        isDefault: true,
        providerConfigId: null,
        localModelId: "00000000-0000-4000-8000-0000000000b2",
        runtime: "mlx",
        capabilities: ["embedding"]
      }),
      profile(ids.writer)
    );
    const { ai } = service();

    await ai.runDefaultTask("embedding", "text");

    expect(db.routes.has(writeFastRouteKey)).toBe(false);
  });
});

describe("the DEV install knob (MEMORA_LOCAL_MODEL_INSTALL)", () => {
  const knobEnv = {
    MEMORA_LOCAL_MODEL_INSTALL: "mlx-qwen3-reranker-0.6b",
    MEMORA_LOCAL_MODEL_SEED_DIR: "/work/.cache/models"
  };

  /** The model service as the knob sees it: the install adds the validated model row. */
  function modelService() {
    const model = rankerModel(ids.mlxRanker, mlxEntry, mlxBuild);
    const view = {
      id: model.id,
      catalogId: mlxEntry.id,
      modelId: model.modelId,
      displayName: mlxEntry.displayName,
      runtime: "mlx",
      status: "not_downloaded",
      capabilities: ["offline", "local-files"],
      lastError: null
    };
    return {
      model,
      list: vi.fn(async () => [{ ...view }] as never),
      installFromSeed: vi.fn(async () => {
        db.models.set(model.id, model);
        Object.assign(view, { status: "ready", capabilities: model.capabilities });
        return { ...view } as never;
      }),
      test: vi.fn(async () => "validated")
    };
  }

  const startKnob = (ai: AiService, models: ReturnType<typeof modelService>) =>
    runLocalModelInstallStartup({
      env: knobEnv,
      isPackaged: false,
      workspaceRoot: "/work",
      models,
      ai,
      logger: { info: vi.fn(), warn: vi.fn() }
    });

  it("gives the installed ranker a profile, and class:decide then resolves to it", async () => {
    const models = modelService();
    const { ai, mlxRanker, remote } = service();
    await expect(ai.decideRouteStatus("topic_gate")).resolves.toBe("missing");

    const [outcome] = await startKnob(ai, models);

    expect(outcome).toMatchObject({ state: "ready" });
    expect(outcome!.message).toContain("class:decide ready");
    const created = db.profiles.find((candidate) => candidate.localModelId === ids.mlxRanker)!;
    expect(created).toMatchObject({
      name: "Qwen3-Reranker-0.6B (MLX)",
      privacyMode: "offline_only",
      runtime: "mlx",
      capabilities: ["reranking", "offline", "local-files"],
      isDefault: false
    });
    expect(db.routes.get(decideRouteKey)).toBe(created.id);
    await expect(ai.decideRouteStatus("topic_gate")).resolves.toBe("ready");
    // The gate's rank call now runs on the new ranker, never on the writer.
    const result = await ai.rank(gateInput);
    expect(result).toMatchObject({ profileId: created.id, localModelId: ids.mlxRanker });
    expect(mlxRanker.run).toHaveBeenCalledOnce();
    expect(remote).not.toHaveBeenCalled();
    // The prompt routes and the default profile are untouched.
    expect(db.profiles.find((candidate) => candidate.isDefault)!.id).toBe(ids.writer);
    expect(db.routes.get("reranking")).toBe(ids.writer);
  });

  it("is idempotent: a second start changes no profile and no route", async () => {
    const models = modelService();
    const { ai } = service();
    await startKnob(ai, models);
    const profiles = structuredClone(db.profiles);
    const routes = new Map(db.routes);
    models.installFromSeed.mockClear();

    const [outcome] = await startKnob(ai, models);

    expect(outcome!.message).toMatch(/^left alone: /u);
    expect(models.installFromSeed).not.toHaveBeenCalled();
    expect(db.profiles).toEqual(profiles);
    expect(db.routes).toEqual(routes);
  });

  it("leaves a class:decide route that is set already where it is", async () => {
    addRanker("gguf", { route: true });
    const { ai } = service();

    await startKnob(ai, modelService());

    expect(db.routes.get(decideRouteKey)).toBe(ids.ggufRankerProfile);
    expect(db.profiles.some((candidate) => candidate.localModelId === ids.mlxRanker)).toBe(true);
  });
});
