import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createLocalModelRepository,
  createPgPool,
  createSettingsRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type JsonObject,
  type PgPool
} from "@app/db";
import { generativeDecideOperations, presetCatalogIds } from "@app/domain";

import {
  AiClassRouteService,
  classTestsSettingKey,
  deciderModeSettingKey,
  presetSettingKey,
  type ClassRoutesAi
} from "./ai-class-routes.js";
import {
  classMapSettingKey,
  createRouteMappingStore,
  describeEffectiveRoutes,
  effectiveRouteChanges,
  legacyOperations,
  mapLegacyRoutesV1,
  resolveRoute,
  unroutedGenerativeDecide
} from "./ai-route-mapping.js";
import { AiService } from "./ai-service.js";

// The class routes against the real route SQL: the pure mirror the mapping plans with must resolve
// what `getDefaultTask` resolves, and the presets, the mapping and the choices must leave the
// routes the callers rely on.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const gib = 1024 ** 3;
const mac = { platform: "darwin", arch: "arm64", totalMemoryBytes: 32 * gib };
const intel = { platform: "darwin", arch: "x64", totalMemoryBytes: 32 * gib };
const generative = [
  "text-generation",
  "structured-output",
  "summarization",
  "atomic-note-generation"
];

describe.skipIf(!sidecarInstalled)("workload class routes on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool;
  let config: ReturnType<typeof createAiConfigRepository>;
  let models: ReturnType<typeof createLocalModelRepository>;
  let settings: ReturnType<typeof createSettingsRepository>;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-class-routes-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_class_routes_test",
        user: "memora_class_routes_test",
        password: `class-routes-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    config = createAiConfigRepository(pool);
    models = createLocalModelRepository(pool);
    settings = createSettingsRepository(pool);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool.query("delete from ai_task_profile_routes");
    await pool.query("delete from ai_profile_tasks");
    await pool.query("delete from ai_profile_sets");
    await pool.query("delete from ai_provider_configs");
    await pool.query("delete from local_models");
    await pool.query("delete from settings where key = any($1)", [
      [classMapSettingKey, presetSettingKey, classTestsSettingKey, deciderModeSettingKey]
    ]);
  });

  async function remote(name: string, capabilities: string[], isDefault = false) {
    const provider = await config.upsertProvider({
      provider: "openai-compatible",
      displayName: `${name} provider`,
      baseUrl: "https://example.test/v1",
      metadata: { modelId: name, capabilities }
    });
    const profile = await config.createProfile({ name, isDefault });
    await config.updateProfile({
      id: profile.id,
      providerConfigId: provider.id,
      modelId: name,
      runtime: "remote",
      capabilities,
      privacyMode: "allow_remote"
    });
    return profile.id;
  }

  async function installed(catalogId: string, runtime: "gguf" | "mlx", capabilities: string[]) {
    const model = await models.upsertModel({
      catalogId,
      modelId: catalogId,
      displayName: `${catalogId} model`,
      family: "test",
      variant: "test",
      repository: "test/test",
      revision: "0".repeat(40),
      runtime,
      format: runtime === "mlx" ? "safetensors" : "gguf",
      quantization: "4-bit",
      expectedSizeBytes: 1,
      manifestHash: "hash",
      capabilities,
      licenseName: "MIT",
      licenseUrl: "https://example.test/license"
    });
    await pool.query("update local_models set status = 'ready' where id = $1", [model.id]);
    return model;
  }

  async function localProfile(catalogId: string, runtime: "gguf" | "mlx", capabilities: string[]) {
    const model = await installed(catalogId, runtime, capabilities);
    const profile = await config.createProfile({ name: catalogId, privacyMode: "offline_only" });
    await config.updateProfile({
      id: profile.id,
      localModelId: model.id,
      modelId: model.modelId,
      runtime,
      capabilities,
      privacyMode: "offline_only"
    });
    return profile.id;
  }

  async function route(key: string, profileId: string, parameters: JsonObject = {}) {
    await config.setProfileTask({ profileId, task: key, parameters });
    await config.setTaskRoute(key, profileId);
  }

  async function routes(): Promise<Record<string, string>> {
    return Object.fromEntries((await config.listTaskRoutes()).map((r) => [r.task, r.profileId]));
  }

  /** A fake AI service: profiles through the repository, calls answered per task. */
  function fakeAi(overrides: Partial<Record<string, unknown>> = {}) {
    const runDefaultTask = vi.fn(async (task: string, _input: string, context: unknown) => {
      void context;
      if (overrides[task] instanceof Error) throw overrides[task];
      if (task === "embedding") return { output: Array.from({ length: 256 }, () => 0.1) };
      if (task === "reranking")
        return { output: JSON.stringify({ results: [[1, 90, "supports"]] }) };
      return { output: "OK" };
    });
    const rank = vi.fn(async () => ({ scores: [0.9, 0.1] }));
    const ai = {
      runDefaultTask,
      rank,
      listProfiles: async () =>
        (await config.listProfiles()).map((p) => ({
          ...p,
          createdAt: undefined,
          updatedAt: undefined
        })),
      createProfile: async (input: { name: string; isDefault?: boolean; privacyMode?: string }) => {
        const profile = await config.createProfile(input);
        return { ...profile, createdAt: undefined, updatedAt: undefined };
      },
      updateProfile: async (input: { id: string; [key: string]: unknown }) => {
        const profile = await config.updateProfile(
          input as Parameters<typeof config.updateProfile>[0]
        );
        return { ...profile, createdAt: undefined, updatedAt: undefined };
      }
    };
    return { ai: ai as unknown as ClassRoutesAi, runDefaultTask, rank };
  }

  function service(ai: ClassRoutesAi, machine = mac) {
    return new AiClassRouteService({
      getPool: () => pool,
      ai,
      machine,
      ensureLegacyMapping: async () => {
        await mapLegacyRoutesV1(createRouteMappingStore(pool));
      }
    });
  }

  /** A library as it stood before F3: a different profile for each task. */
  async function splitLibrary() {
    const ids = {
      embed: await remote("embedder", ["embedding"]),
      summary: await remote("summary-writer", generative, true),
      text: await remote("text-writer", generative),
      structured: await remote("structured-writer", generative),
      kg: await remote("kg-writer", generative),
      atomic: await remote("atomic-writer", generative),
      judge: await remote("judge-writer", generative)
    };
    await route("embedding", ids.embed);
    await route("summarization", ids.summary, { temperature: 0.2 });
    await route("text-generation", ids.text, { reasoningLevel: "off" });
    await route("structured-output", ids.structured);
    await route("knowledge-graph-generation", ids.kg, { maxTokens: 4000 });
    await route("atomic-note-generation", ids.atomic);
    await route("reranking", ids.judge);
    return ids;
  }

  it("resolves the routes as the SQL does (the mirror the mapping plans with)", async () => {
    const ids = await splitLibrary();
    const ranker = await localProfile(presetCatalogIds.rankerMlx, "mlx", ["reranking"]);
    await route("class:decide", ranker);
    await route("class:write-fast", ids.summary);
    // A route whose profile task is missing resolves nothing, in the SQL and in the mirror.
    await config.setTaskRoute("op:orphan", ids.kg);
    // A route whose profile cannot serve it never falls through.
    await pool.query("update ai_profile_sets set status = 'inactive' where id = $1", [ids.text]);
    const { facts } = await createRouteMappingStore(pool).read();
    const cases: Array<[string, string[]]> = [
      ["structured-output", ["structured-output"]],
      ["structured-output", ["class:write-fast", "structured-output"]],
      ["structured-output", ["op:orphan", "class:write-fast", "structured-output"]],
      ["text-generation", ["class:answer", "text-generation"]],
      [
        "knowledge-graph-generation",
        ["op:missing", "class:write-quality", "knowledge-graph-generation"]
      ],
      ["reranking", ["op:note_matching_reranking", "class:decide", "reranking"]],
      ["reranking", ["reranking"]],
      ["summarization", ["summarization"]],
      ["atomic-note-generation", ["atomic-note-generation"]],
      ["embedding", ["class:embed", "embedding"]]
    ];
    for (const [task, keys] of cases) {
      const sql = await config.getDefaultTask(task, undefined, keys);
      const mirror = resolveRoute(facts, keys, task);
      expect(mirror?.profileId ?? null, keys.join(" > ")).toBe(sql?.profileId ?? null);
      if (sql && mirror) expect(mirror.parameters).toEqual(sql.parameters);
    }
    // No route at all: the default profile serves the task with its own profile task.
    await config.setProfileTask({
      profileId: ids.summary,
      task: "text-generation",
      parameters: {}
    });
    await pool.query("delete from ai_task_profile_routes where task = 'text-generation'");
    const refreshed = (await createRouteMappingStore(pool).read()).facts;
    const sql = await config.getDefaultTask("text-generation", undefined, ["text-generation"]);
    expect(resolveRoute(refreshed, ["text-generation"], "text-generation")?.profileId).toBe(
      sql?.profileId
    );
    expect(sql?.profileId).toBe(ids.summary);
  }, 60_000);

  it("keeps every effective model and its parameters when the legacy routes are mapped", async () => {
    await splitLibrary();
    const store = createRouteMappingStore(pool);
    const sqlDump = async (mode: "legacy" | "classed") => {
      const out: Array<[string, string | null, JsonObject | null]> = [];
      for (const entry of legacyOperations) {
        const keys = [
          `op:${entry.operation}`,
          ...(mode === "classed" || entry.classedBefore ? [`class:${entry.class}`] : []),
          entry.task
        ];
        const selection = await config.getDefaultTask(entry.task, undefined, keys);
        out.push([entry.operation, selection?.profileId ?? null, selection?.parameters ?? null]);
      }
      return out;
    };
    const before = await sqlDump("legacy");
    const { facts } = await store.read();
    expect(before.every(([, profileId]) => profileId !== null)).toBe(true);
    const written = await mapLegacyRoutesV1(store);
    expect(written.classRoutes.length).toBeGreaterThan(0);
    expect(written.operationRoutes.length).toBeGreaterThan(0);
    const after = await sqlDump("classed");
    expect(after).toEqual(before);
    const mapped = (await store.read()).facts;
    expect(
      effectiveRouteChanges(
        describeEffectiveRoutes(facts, "legacy"),
        describeEffectiveRoutes(mapped, "classed")
      )
    ).toEqual([]);
    // Idempotent: nothing more is written, and the record names what the first run wrote.
    expect(await mapLegacyRoutesV1(store)).toEqual({ classRoutes: [], operationRoutes: [] });
    expect(await settings.get(classMapSettingKey)).toMatchObject({
      version: 1,
      classRoutes: written.classRoutes,
      operationRoutes: written.operationRoutes,
      releasedClasses: []
    });
    expect(unroutedGenerativeDecide(Object.keys(await routes()))).toEqual([]);
  }, 60_000);

  it("maps the legacy routes on the first call of the AI service and leaves a set class route", async () => {
    const ids = await splitLibrary();
    await route("class:write-fast", ids.kg);
    const ai = new AiService({
      userDataPath: workDir,
      getPool: () => pool,
      workspaceRoot: workspace,
      resourcesPath: workspace,
      isPackaged: false,
      machine: mac
    });
    const view = await ai.classRoutes();
    expect(view.classes.find((entry) => entry.id === "embed")?.profileName).toBe("embedder");
    expect(view.classes.find((entry) => entry.id === "write-fast")?.profileName).toBe("kg-writer");
    expect(view.classes.find((entry) => entry.id === "write-quality")?.profileName).toBe(
      "atomic-writer"
    );
    expect(view.classes.find((entry) => entry.id === "decide")?.test.state).toBe("none");
    expect(view.judge).toMatchObject({ profileName: "judge-writer", routed: true, remote: true });
    expect(view.preset).toBeNull();
    expect(Object.keys(await routes())).toEqual(
      expect.arrayContaining(generativeDecideOperations.map((operation) => `op:${operation}`))
    );
  }, 60_000);

  it("maps once the database is there, not before, and only once", async () => {
    await splitLibrary();
    let available = false;
    const ai = new AiService({
      userDataPath: workDir,
      getPool: () => (available ? pool : null),
      workspaceRoot: workspace,
      resourcesPath: workspace,
      isPackaged: false,
      machine: mac
    });
    await expect(ai.classRoutes()).rejects.toThrow("errors.database.notReady");
    expect(await settings.get(classMapSettingKey)).toBeNull();
    available = true;
    await ai.classRoutes();
    const recorded = await settings.get<{ mappedAt: string }>(classMapSettingKey);
    expect(recorded).not.toBeNull();
    // A second call neither maps nor rewrites the record.
    await ai.classRoutes();
    expect(await settings.get(classMapSettingKey)).toEqual(recorded);
  }, 60_000);

  describe("presets", () => {
    it("applies Cloud: the remote writer on every write class, the judge routes and the mode", async () => {
      const ids = await splitLibrary();
      const ranker = await localProfile(presetCatalogIds.rankerMlx, "mlx", ["reranking"]);
      await route("class:decide", ranker);
      const { ai, runDefaultTask, rank } = fakeAi();
      const result = await service(ai).applyPreset({ preset: "cloud" });
      expect(result.applied).toBe(true);
      const after = await routes();
      for (const key of ["write-fast", "write-quality", "answer"])
        expect(after[`class:${key}`]).toBe(ids.summary);
      // The remote embedding model serves embed when the provider has one; the ranker stays.
      expect(after["class:embed"]).toBe(ids.embed);
      expect(after["class:decide"]).toBe(ranker);
      for (const operation of generativeDecideOperations)
        expect(after[`op:${operation}`]).toBe(ids.summary);
      expect(after.reranking).toBe(ids.summary);
      expect(await settings.get(deciderModeSettingKey)).toBe("ranker-else-generative");
      expect(await settings.get(presetSettingKey)).toMatchObject({ mode: "cloud" });
      // The mapping's overrides are gone and it leaves every class alone from now on.
      const state = await settings.get<{ operationRoutes: string[]; releasedClasses: string[] }>(
        classMapSettingKey
      );
      expect(state?.releasedClasses.toSorted()).toEqual(
        ["answer", "decide", "embed", "write-fast", "write-quality"].toSorted()
      );
      expect(Object.keys(after)).not.toContain("op:graph_atomic_notes");
      expect(await mapLegacyRoutesV1(createRouteMappingStore(pool))).toEqual({
        classRoutes: [],
        operationRoutes: []
      });
      // One test per class, each on its own class route, recorded with its model.
      expect(runDefaultTask).toHaveBeenCalledTimes(5);
      expect(rank).toHaveBeenCalledTimes(1);
      expect(result.view.classes.map((entry) => entry.test.state)).toEqual([
        "passed",
        "passed",
        "passed",
        "passed",
        "passed"
      ]);
      expect(result.view.judge.test.state).toBe("passed");
      expect(result.view.preset).toBe("cloud");
      expect(result.view.judge.deciderMode).toBe("ranker-else-generative");
      // The source judge resolves the writer while class:decide holds the ranker.
      const judge = await config.getDefaultTask("reranking", undefined, [
        "op:source_relation_matching",
        "class:decide",
        "reranking"
      ]);
      expect(judge?.profileId).toBe(ids.summary);
      const gate = await config.getDefaultTask("class:decide", undefined, ["class:decide"]);
      expect(gate?.profileId).toBe(ranker);
    }, 60_000);

    it("a failed test leaves the class unverified with its reason and keeps its route", async () => {
      const ids = await splitLibrary();
      const { ai } = fakeAi({ "structured-output": new Error("errors.ai.providerUnavailable") });
      const result = await service(ai).applyPreset({ preset: "cloud" });
      expect(result.applied).toBe(true);
      const fast = result.view.classes.find((entry) => entry.id === "write-fast")!;
      expect(fast.test).toMatchObject({
        state: "failed",
        error: "errors.ai.providerUnavailable"
      });
      expect((await routes())["class:write-fast"]).toBe(ids.summary);
      // Changing the class's model forgets the old result: the new model is untested.
      await service(ai).setClassRoute({ route: "write-fast", profileId: ids.text });
      const view = await service(ai).view();
      expect(view.classes.find((entry) => entry.id === "write-fast")?.test.state).toBe("untested");
    }, 60_000);

    it("applies Local from the installed models and creates the missing profiles", async () => {
      await splitLibrary();
      await installed(presetCatalogIds.embedding, "gguf", ["embedding", "offline"]);
      await installed(presetCatalogIds.rankerMlx, "mlx", ["reranking", "offline"]);
      await installed(presetCatalogIds.writerLarge, "mlx", [...generative, "offline"]);
      const { ai } = fakeAi();
      const result = await service(ai).applyPreset({ preset: "local", test: false });
      expect(result.blocked).toEqual([]);
      expect(result.applied).toBe(true);
      const profiles = await config.listProfiles();
      const byId = new Map(profiles.map((p) => [p.id, p]));
      const after = await routes();
      for (const key of ["write-fast", "write-quality", "answer"])
        expect(byId.get(after[`class:${key}`]!)?.modelId).toBe(presetCatalogIds.writerLarge);
      expect(byId.get(after["class:embed"]!)?.modelId).toBe(presetCatalogIds.embedding);
      expect(byId.get(after["class:decide"]!)?.modelId).toBe(presetCatalogIds.rankerMlx);
      for (const operation of generativeDecideOperations)
        expect(byId.get(after[`op:${operation}`]!)?.modelId).toBe(presetCatalogIds.writerLarge);
      expect(await settings.get(deciderModeSettingKey)).toBe("ranker");
      // One local writer: a single profile serves the three write classes.
      expect(
        new Set(["write-fast", "write-quality", "answer"].map((k) => after[`class:${k}`])).size
      ).toBe(1);
    }, 60_000);

    it("writes nothing when a model the setup needs is missing, and names it", async () => {
      await splitLibrary();
      const { ai } = fakeAi();
      await service(ai).view();
      const before = await routes();
      const local = await service(ai).applyPreset({ preset: "local", test: false });
      expect(local.applied).toBe(false);
      expect(local.blocked.map((entry) => [entry.route, entry.reason])).toEqual(
        expect.arrayContaining([
          ["embed", "model_missing"],
          ["write-fast", "model_missing"],
          ["judge", "model_missing"]
        ])
      );
      expect(local.blocked.find((entry) => entry.route === "write-fast")).toMatchObject({
        catalogId: presetCatalogIds.writerLarge,
        modelName: expect.stringContaining("Qwen")
      });
      expect(await routes()).toEqual(before);
      expect(await settings.get(presetSettingKey)).toBeNull();
    }, 60_000);

    it("refuses Local off Apple silicon and asks for a remote model when there is none", async () => {
      const { ai } = fakeAi();
      const off = await service(ai, intel).applyPreset({ preset: "local", test: false });
      expect(off).toMatchObject({
        applied: false,
        blocked: [{ route: null, reason: "local_requires_apple_silicon" }]
      });
      expect(off.view.presets.find((p) => p.id === "local")).toMatchObject({ available: false });
      await installed(presetCatalogIds.embedding, "gguf", ["embedding"]);
      const noRemote = await service(ai).applyPreset({ preset: "hybrid", test: false });
      expect(noRemote.applied).toBe(false);
      expect(noRemote.blocked.map((entry) => entry.reason)).toContain("no_remote_profile");
    }, 60_000);

    it("records Custom without touching the routes", async () => {
      const ids = await splitLibrary();
      const { ai } = fakeAi();
      const svc = service(ai);
      await svc.view();
      const before = await routes();
      const result = await svc.applyPreset({ preset: "custom" });
      expect(result.view.preset).toBe("custom");
      expect(await routes()).toEqual(before);
      expect(ids.summary).toBeDefined();
    }, 60_000);
  });

  describe("custom choices", () => {
    it("points a class at a profile, releases its mapped overrides and refuses a profile that cannot serve it", async () => {
      const ids = await splitLibrary();
      const ranker = await localProfile(presetCatalogIds.rankerMlx, "mlx", ["reranking"]);
      const { ai } = fakeAi();
      const svc = service(ai);
      await svc.view();
      expect(Object.keys(await routes())).toContain("op:graph_atomic_notes");
      const view = await svc.setClassRoute({ route: "write-quality", profileId: ids.kg });
      expect(view.preset).toBe("custom");
      const after = await routes();
      expect(after["class:write-quality"]).toBe(ids.kg);
      expect(Object.keys(after)).not.toContain("op:graph_atomic_notes");
      expect(Object.keys(after)).toContain("op:relation_explanation");
      // A generative writer is never the ranker; a ranker is never a writer or the judge.
      await expect(svc.setClassRoute({ route: "decide", profileId: ids.judge })).rejects.toThrow(
        "errors.ai.noCompatibleModel"
      );
      await expect(svc.setClassRoute({ route: "write-fast", profileId: ranker })).rejects.toThrow(
        "errors.ai.noCompatibleModel"
      );
      await expect(svc.setClassRoute({ route: "judge", profileId: ranker })).rejects.toThrow(
        "errors.ai.noCompatibleModel"
      );
      await expect(svc.setClassRoute({ route: "embed", profileId: ids.kg })).rejects.toThrow(
        "errors.ai.noCompatibleModel"
      );
      await svc.setClassRoute({ route: "decide", profileId: ranker });
      expect((await routes())["class:decide"]).toBe(ranker);
    }, 60_000);

    it("routes the judge on all four operations and the reranking route together", async () => {
      const ids = await splitLibrary();
      const { ai } = fakeAi();
      const svc = service(ai);
      const view = await svc.setClassRoute({ route: "judge", profileId: ids.text });
      const after = await routes();
      for (const operation of generativeDecideOperations)
        expect(after[`op:${operation}`]).toBe(ids.text);
      expect(after.reranking).toBe(ids.text);
      expect(view.judge).toMatchObject({ profileName: "text-writer", routed: true });
      expect(unroutedGenerativeDecide(Object.keys(after))).toEqual([]);
      // The judge test runs the decide-only contract on the judge route.
      const tested = await svc.testClassRoute("judge");
      expect(tested.judge.test).toMatchObject({ state: "passed", model: "text-writer" });
    }, 60_000);

    it("sets and clears the note decider mode", async () => {
      await splitLibrary();
      const { ai } = fakeAi();
      const svc = service(ai);
      expect((await svc.setDeciderMode("generative")).judge.deciderMode).toBe("generative");
      expect(await settings.get(deciderModeSettingKey)).toBe("generative");
      expect((await svc.setDeciderMode(null)).judge.deciderMode).toBeNull();
      expect(await settings.get(deciderModeSettingKey)).toBeNull();
    }, 60_000);

    it("tests nothing for a class without a route", async () => {
      const { ai, runDefaultTask } = fakeAi();
      const view = await service(ai).testClassRoute("write-fast");
      expect(runDefaultTask).not.toHaveBeenCalled();
      expect(view.classes.find((entry) => entry.id === "write-fast")).toMatchObject({
        profileId: null,
        test: { state: "untested" }
      });
    });
  });
});
