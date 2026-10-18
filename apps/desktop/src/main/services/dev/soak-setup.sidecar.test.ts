import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createLocalModelRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { presetCatalogIds } from "@app/domain";

import { AiClassRouteService, type ClassRoutesAi } from "../ai-class-routes.js";
import { createRouteMappingStore, mapLegacyRoutesV1 } from "../ai-route-mapping.js";
import { runSoakSetup, soakSetupSchema, type SoakSetupAi } from "./soak-setup.js";

// The scripted setup of a soak profile on a real PostgreSQL database with the product's schema and
// the real class-route service: the Local preset on a split library cloned from an owner's profile
// (remote task routes, a remote default profile), then the checks and the file.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const gib = 1024 ** 3;
const mac = { platform: "darwin", arch: "arm64", totalMemoryBytes: 32 * gib };
const generative = [
  "text-generation",
  "structured-output",
  "summarization",
  "atomic-note-generation"
];

describe.skipIf(!sidecarInstalled)("the soak profile setup on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool;
  let config: ReturnType<typeof createAiConfigRepository>;
  let models: ReturnType<typeof createLocalModelRepository>;
  let root = "";
  let userDataPath = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-soak-setup-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_soak_setup_test",
        user: "memora_soak_setup_test",
        password: `soak-setup-${randomUUID()}`,
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
    // A repository with a measurement profile inside .cache/profiles/.
    root = join(workDir, "repository");
    userDataPath = join(root, ".cache", "profiles", "env-soak");
    await mkdir(userDataPath, { recursive: true });
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
    await pool.query("delete from atomic_notes");
    await pool.query("delete from source_items");
    await pool.query("delete from settings where key like 'ai.%'");
    await rm(join(root, ".cache", "f3"), { recursive: true, force: true });
  });

  async function remote(name: string, capabilities: string[], isDefault = false) {
    const provider = await config.upsertProvider({
      provider: "openai-codex",
      displayName: `${name} provider`,
      baseUrl: "https://chatgpt.com/backend-api/codex",
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
  }

  async function route(key: string, profileId: string) {
    await config.setProfileTask({ profileId, task: key, parameters: {} });
    await config.setTaskRoute(key, profileId);
  }

  /** The library as cloned from an owner's profile: a remote writer on every legacy task, a remote default. */
  async function ownersLibrary() {
    const writer = await remote("Codex writer", generative, true);
    const embedder = await remote("Codex embedder", ["embedding"]);
    for (const task of [
      "summarization",
      "text-generation",
      "structured-output",
      "atomic-note-generation",
      "knowledge-graph-generation",
      "reranking"
    ])
      await route(task, writer);
    await route("embedding", embedder);
    return { writer, embedder };
  }

  async function installLocalModels() {
    await installed(presetCatalogIds.embedding, "gguf", ["embedding", "offline"]);
    await installed(presetCatalogIds.rankerMlx, "mlx", ["reranking", "offline"]);
    await installed(presetCatalogIds.writerLarge, "mlx", [...generative, "offline"]);
  }

  /** The class-route service on a fake model service: profiles through the repository, calls answered. */
  function aiService(overrides: Record<string, Error> = {}): SoakSetupAi {
    const runDefaultTask = vi.fn(async (task: string) => {
      if (overrides[task]) throw overrides[task];
      if (task === "embedding") return { output: Array.from({ length: 256 }, () => 0.1) };
      if (task === "reranking")
        return { output: JSON.stringify({ results: [[1, 90, "supports"]] }) };
      return { output: "OK" };
    });
    const strip = (profile: object) => ({ ...profile, createdAt: undefined, updatedAt: undefined });
    const fake = {
      runDefaultTask,
      rank: vi.fn(async () => ({ scores: [0.9, 0.1] })),
      listProfiles: async () => (await config.listProfiles()).map(strip),
      createProfile: async (input: Parameters<typeof config.createProfile>[0]) =>
        strip(await config.createProfile(input)),
      updateProfile: async (input: Parameters<typeof config.updateProfile>[0]) =>
        strip(await config.updateProfile(input))
    };
    const service = new AiClassRouteService({
      getPool: () => pool,
      ai: fake as unknown as ClassRoutesAi,
      machine: mac,
      ensureLegacyMapping: async () => {
        await mapLegacyRoutesV1(createRouteMappingStore(pool));
      }
    });
    return {
      applyPreset: (input) => service.applyPreset(input),
      testClassRoute: (target) => service.testClassRoute(target),
      classRoutes: () => service.view()
    };
  }

  const options = (ai: SoakSetupAi, env: Record<string, string> = { MEMORA_SOAK_SETUP: "1" }) => ({
    env,
    isPackaged: false,
    workspaceRoot: root,
    userDataPath,
    pool,
    ai,
    logger: { info: vi.fn(), error: vi.fn() },
    now: () => new Date("2026-10-18T20:00:00Z")
  });
  const setupFile = async () =>
    soakSetupSchema.parse(
      JSON.parse(await readFile(join(root, ".cache", "f3", "soak", "setup.json"), "utf8"))
    );

  async function seedLibrary() {
    await pool.query(`insert into source_items (id, type, title) values
      ('00000000-0000-4000-8000-000000000001', 'Book', 'Book'),
      ('00000000-0000-4000-8000-000000000002', 'StandaloneArticle', 'Paper')`);
    await pool.query(
      `insert into source_items (id, type, title, parent_source_item_id)
       values ('00000000-0000-4000-8000-000000000003', 'BookChapter', 'Chapter', '00000000-0000-4000-8000-000000000001')`
    );
  }

  it("applies the Local preset on a cloned owner's library, reaches no real provider, and writes what it found", async () => {
    const { writer } = await ownersLibrary();
    await installLocalModels();
    await seedLibrary();
    const opts = options(aiService());

    expect(await runSoakSetup(opts)).toBe("ok");
    const file = await setupFile();
    expect(file).toMatchObject({
      status: "ok",
      problems: [],
      userDataPath,
      preset: { requested: "local", applied: true, mode: "local", blocked: [] },
      library: { roots: 2, sources: 3, notes: 0 },
      remote: { reachable: [] }
    });
    // Every class on a local model, tested and passed; the judge routed.
    expect(file.classes.map((entry) => [entry.id, entry.remote, entry.test.state])).toEqual([
      ["embed", false, "passed"],
      ["decide", false, "passed"],
      ["write-fast", false, "passed"],
      ["write-quality", false, "passed"],
      ["answer", false, "passed"]
    ]);
    expect(file.classes.find((entry) => entry.id === "write-fast")?.model).toBe(
      presetCatalogIds.writerLarge
    );
    expect(file.judge).toMatchObject({ remote: false, routed: true, deciderMode: "ranker" });
    // The owner's remote default profile would have served a task no route names: now a local one does.
    expect(file.remote.defaultProfileChanged).toEqual({
      from: "Codex writer",
      to: expect.stringContaining(presetCatalogIds.writerLarge)
    });
    const profiles = await config.listProfiles();
    const defaults = profiles.filter((profile) => profile.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.localModelId).not.toBeNull();
    expect(defaults[0]!.id).not.toBe(writer);
    // The legacy task routes the preset leaves behind are listed, not reached.
    expect(file.remote.residual).toEqual(
      expect.arrayContaining([
        "summarization -> Codex writer (openai-codex)",
        "embedding -> Codex embedder (openai-codex)"
      ])
    );
    expect(opts.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("SOAK_SETUP library: 2 roots (3 sources), 0 notes")
    );
    expect(opts.logger.error).not.toHaveBeenCalled();
  }, 60_000);

  it("is repeatable: a second run changes nothing and says ok again", async () => {
    await ownersLibrary();
    await installLocalModels();
    const ai = aiService();
    expect(await runSoakSetup(options(ai))).toBe("ok");
    const first = await setupFile();
    expect(await runSoakSetup(options(ai))).toBe("ok");
    const second = await setupFile();
    expect(second.remote.defaultProfileChanged).toBeNull();
    const stable = (file: typeof first) =>
      file.classes.map(({ test, ...entry }) => ({ ...entry, state: test.state }));
    expect(stable(second)).toEqual(stable(first));
  }, 60_000);

  it("writes nothing and says which model is missing when the preset cannot be applied", async () => {
    await ownersLibrary();
    const ai = aiService();
    // The legacy route mapping the service runs on first use is not the preset's doing.
    await ai.classRoutes();
    const before = (await config.listTaskRoutes()).length;
    expect(await runSoakSetup(options(ai))).toBe("blocked");
    const file = await setupFile();
    expect(file.status).toBe("blocked");
    expect(file.preset.applied).toBe(false);
    expect(file.preset.blocked.map((entry) => entry.reason)).toContain("model_missing");
    expect(file.problems.join(" ")).toContain("model_missing");
    expect((await config.listTaskRoutes()).length).toBe(before);
    expect((await config.listProfiles()).filter((profile) => profile.isDefault)[0]?.name).toBe(
      "Codex writer"
    );
  }, 60_000);

  it("fails and names the call when a route the owner set by hand still reaches a real provider", async () => {
    const { writer } = await ownersLibrary();
    await installLocalModels();
    // A person's own override of one operation: the preset does not release routes it did not write.
    await route("op:topic_name", writer);
    expect(await runSoakSetup(options(aiService()))).toBe("failed");
    const file = await setupFile();
    expect(file.status).toBe("failed");
    expect(file.remote.reachable).toEqual([
      expect.stringContaining("Codex writer (openai-codex): topic_name")
    ]);
    expect(file.problems.join(" ")).toMatch(/still reaches a real remote provider.*topic_name/su);
  }, 60_000);

  it("fails when a class test fails, with its reason, and still writes the file", async () => {
    await ownersLibrary();
    await installLocalModels();
    expect(
      await runSoakSetup(
        options(aiService({ "structured-output": new Error("errors.localModels.runtimeFailed") }))
      )
    ).toBe("failed");
    const file = await setupFile();
    expect(file.classes.find((entry) => entry.id === "write-fast")?.test).toMatchObject({
      state: "failed",
      error: "errors.localModels.runtimeFailed"
    });
    expect(file.problems.join(" ")).toContain(
      "write-fast: test failed (errors.localModels.runtimeFailed)"
    );
  }, 60_000);

  it("does not count the soak's own fake providers as real ones", async () => {
    const { writer } = await ownersLibrary();
    await installLocalModels();
    const fake = await config.upsertProvider({
      provider: "openai-codex",
      displayName: "DEV fake Codex wire (soak)",
      baseUrl: "http://127.0.0.1:41001/backend-api/codex",
      metadata: {
        modelId: "dev-fake-explain-1",
        capabilities: ["text-generation"],
        treatAsRemote: true
      }
    });
    const fakeProfile = await config.createProfile({ name: "DEV fake Codex wire (soak)" });
    await config.updateProfile({
      id: fakeProfile.id,
      providerConfigId: fake.id,
      modelId: "dev-fake-explain-1",
      runtime: "remote",
      capabilities: ["text-generation"]
    });
    await route("op:relation_explanation", fakeProfile.id);
    void writer;
    expect(await runSoakSetup(options(aiService()))).toBe("ok");
    expect((await setupFile()).remote.reachable).toEqual([]);
  }, 60_000);

  it("is refused beside another DEV knob and leaves the profile alone", async () => {
    await ownersLibrary();
    const before = (await config.listTaskRoutes()).length;
    const opts = options(aiService(), {
      MEMORA_SOAK_SETUP: "1",
      MEMORA_GOLDEN_RUN: "scripts/golden/manifest.json"
    });
    expect(await runSoakSetup(opts)).toBe("refused");
    expect(opts.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("refused with MEMORA_GOLDEN_RUN")
    );
    expect((await config.listTaskRoutes()).length).toBe(before);
    expect(existsSync(join(root, ".cache", "f3", "soak", "setup.json"))).toBe(false);
  }, 60_000);
});
