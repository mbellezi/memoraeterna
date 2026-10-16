import { beforeEach, describe, expect, it, vi } from "vitest";

import { findLocalModelCatalogEntry } from "@app/ai";

import type {
  AiProfile,
  AiProfileCreate,
  AiProfileUpdate,
  LocalModelView
} from "../../shared/ipc.js";
import {
  readLocalModelInstallKnob,
  runLocalModelInstallStartup,
  type LocalModelInstallAi,
  type LocalModelInstallModels
} from "./local-model-install-startup.js";

const mlxId = "mlx-qwen3-reranker-0.6b";
const ggufId = "gguf-qwen3-reranker-0.6b-q8-0";
const dev = { isPackaged: false, baseDirectory: "/work/memora" };
const seeded = { MEMORA_LOCAL_MODEL_SEED_DIR: ".cache/models" };

describe("MEMORA_LOCAL_MODEL_INSTALL knob", () => {
  it("is off when unset or blank, packaged or not", () => {
    expect(readLocalModelInstallKnob({}, dev)).toEqual([]);
    expect(readLocalModelInstallKnob({ MEMORA_LOCAL_MODEL_INSTALL: "  " }, dev)).toEqual([]);
    expect(readLocalModelInstallKnob({}, { ...dev, isPackaged: true })).toEqual([]);
  });

  it("reads comma separated catalog ids, trimmed, once each and in order", () => {
    const env = { ...seeded, MEMORA_LOCAL_MODEL_INSTALL: ` ${mlxId} , ${ggufId},,${mlxId}` };
    expect(readLocalModelInstallKnob(env, dev)).toEqual([mlxId, ggufId]);
  });

  it("is refused in a packaged build, even with a seed folder", () => {
    expect(() =>
      readLocalModelInstallKnob(
        { ...seeded, MEMORA_LOCAL_MODEL_INSTALL: mlxId },
        { ...dev, isPackaged: true }
      )
    ).toThrow("refused in packaged builds");
  });

  it("is refused without the seed folder, which supplies the files", () => {
    for (const env of [
      { MEMORA_LOCAL_MODEL_INSTALL: mlxId },
      { MEMORA_LOCAL_MODEL_INSTALL: mlxId, MEMORA_LOCAL_MODEL_SEED_DIR: "  " }
    ])
      expect(() => readLocalModelInstallKnob(env, dev)).toThrow(
        "needs MEMORA_LOCAL_MODEL_SEED_DIR"
      );
  });

  it("is refused for a value that names no id or an id of the wrong shape", () => {
    for (const value of [",", " , ", "../models", "a b", `${mlxId};rm`, "-x"])
      expect(() =>
        readLocalModelInstallKnob({ ...seeded, MEMORA_LOCAL_MODEL_INSTALL: value }, dev)
      ).toThrow("comma separated list of catalog ids");
  });
});

/** The model service the knob drives: an in-memory store with the install semantics. */
function fakeModels(initial: Record<string, Partial<LocalModelView>> = {}) {
  const views = new Map<string, LocalModelView>();
  for (const id of [mlxId, ggufId, "mlx-gemma-4-e4b-it-4bit"]) {
    const entry = findLocalModelCatalogEntry(id)!;
    views.set(id, {
      id: `00000000-0000-4000-8000-${String(views.size + 1).padStart(12, "0")}`,
      catalogId: id,
      modelId: entry.repository,
      displayName: entry.displayName,
      runtime: entry.runtime,
      capabilities: ["offline", "local-files"],
      status: "not_downloaded",
      lastError: null,
      ...initial[id]
    } as unknown as LocalModelView);
  }
  const models = {
    views,
    /** What the install leaves: ready, and the decide validation when `validates`. */
    validates: true,
    installError: null as Error | null,
    list: vi.fn(async () => [...views.values()].map((view) => structuredClone(view))),
    installFromSeed: vi.fn(async (catalogId: string) => {
      if (models.installError) throw models.installError;
      const view = views.get(catalogId)!;
      view.status = "ready";
      if (models.validates) view.capabilities = ["reranking", "offline", "local-files"];
      else view.lastError = "errors.localModels.rankerSmokeFailed";
      return structuredClone(view);
    }),
    test: vi.fn(async (catalogId: string) => {
      if (!models.validates) throw new Error("errors.localModels.rankerSmokeFailed");
      views.get(catalogId)!.capabilities = ["reranking", "offline", "local-files"];
      return "validated";
    })
  } satisfies LocalModelInstallModels & Record<string, unknown>;
  return models;
}

/** The AI service the knob drives: profiles in memory, `class:decide` seeded by the update. */
function fakeAi(initial: AiProfile[] = []) {
  const profiles = [...initial];
  const ai = {
    profiles,
    decide: "missing" as string,
    listProfiles: vi.fn(async () => structuredClone(profiles)),
    createProfile: vi.fn(async (input: AiProfileCreate) => {
      const profile = {
        id: `00000000-0000-4000-8000-0000000000${String(profiles.length + 10)}`,
        description: null,
        providerConfigId: null,
        localModelId: null,
        modelId: null,
        runtime: null,
        capabilities: [],
        status: "active",
        ...input
      } as unknown as AiProfile;
      profiles.push(profile);
      return structuredClone(profile);
    }),
    updateProfile: vi.fn(async (input: AiProfileUpdate) => {
      const profile = profiles.find((candidate) => candidate.id === input.id)!;
      Object.assign(profile, input);
      // The seeding that runs after a profile update takes the ranker for `class:decide`.
      ai.decide = "ready";
      return structuredClone(profile);
    }),
    decideRouteStatus: vi.fn(async () => ai.decide)
  } as unknown as LocalModelInstallAi & {
    profiles: AiProfile[];
    decide: string;
    createProfile: ReturnType<typeof vi.fn>;
    updateProfile: ReturnType<typeof vi.fn>;
  };
  return ai;
}

const existingProfile = (overrides: Partial<AiProfile> = {}): AiProfile =>
  ({
    id: "00000000-0000-4000-8000-000000000a01",
    name: "Writer",
    description: null,
    isDefault: true,
    privacyMode: "allow_remote",
    outputLanguage: "ui",
    providerConfigId: "00000000-0000-4000-8000-000000000b01",
    localModelId: null,
    modelId: "writer",
    runtime: "remote",
    capabilities: ["text-generation"],
    status: "active",
    ...overrides
  }) as AiProfile;

function run(
  env: Record<string, string | undefined>,
  deps: {
    models: LocalModelInstallModels;
    ai: LocalModelInstallAi;
  },
  options: { isPackaged?: boolean } = {}
) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const outcomes = runLocalModelInstallStartup({
    env,
    isPackaged: options.isPackaged ?? false,
    workspaceRoot: "/work/memora",
    ...deps,
    logger
  });
  return { logger, outcomes };
}

const knob = (...ids: string[]) => ({ ...seeded, MEMORA_LOCAL_MODEL_INSTALL: ids.join(",") });

let models: ReturnType<typeof fakeModels>;
let ai: ReturnType<typeof fakeAi>;
beforeEach(() => {
  models = fakeModels();
  ai = fakeAi([existingProfile()]);
});

describe("a refused knob", () => {
  it("is logged and ignored when packaged, touching no model and no profile", async () => {
    const { logger, outcomes } = run(knob(mlxId), { models, ai }, { isPackaged: true });

    await expect(outcomes).resolves.toEqual([]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/^MODEL_INSTALL refused: .*packaged builds/u);
    expect(models.list).not.toHaveBeenCalled();
    expect(models.installFromSeed).not.toHaveBeenCalled();
    expect(ai.listProfiles).not.toHaveBeenCalled();
  });

  it("is logged and ignored without the seed folder", async () => {
    const { logger, outcomes } = run({ MEMORA_LOCAL_MODEL_INSTALL: mlxId }, { models, ai });

    await expect(outcomes).resolves.toEqual([]);

    expect(logger.warn.mock.calls[0]![0]).toMatch(/needs MEMORA_LOCAL_MODEL_SEED_DIR/u);
    expect(models.installFromSeed).not.toHaveBeenCalled();
    expect(ai.createProfile).not.toHaveBeenCalled();
  });

  it("does nothing, and logs nothing, when the knob is not set", async () => {
    const { logger, outcomes } = run(seeded, { models, ai });

    await expect(outcomes).resolves.toEqual([]);

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(models.list).not.toHaveBeenCalled();
  });
});

describe("models the knob cannot install", () => {
  it("refuses an unknown id and a catalog entry without a seed folder, and goes on with the rest", async () => {
    const { logger, outcomes } = run(knob("mlx-nothing", "mlx-gemma-4-e4b-it-4bit", mlxId), {
      models,
      ai
    });

    await expect(outcomes).resolves.toMatchObject([
      { catalogId: "mlx-nothing", state: "refused", message: "unknown catalog id" },
      { catalogId: "mlx-gemma-4-e4b-it-4bit", state: "refused" },
      { catalogId: mlxId, state: "ready" }
    ]);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0]![0]).toBe(
      "MODEL_INSTALL mlx-nothing: refused: unknown catalog id"
    );
    expect(logger.warn.mock.calls[1]![0]).toContain("has no seed folder");
    // Only the ranker was installed: the other two never reached the install path.
    expect(models.installFromSeed).toHaveBeenCalledTimes(1);
    expect(models.installFromSeed).toHaveBeenCalledWith(mlxId);
  });
});

describe("installing a ranker", () => {
  it("installs it from the seed, creates the profile the Settings flow creates and routes class:decide", async () => {
    const { logger, outcomes } = run(knob(mlxId), { models, ai });

    await expect(outcomes).resolves.toEqual([
      {
        catalogId: mlxId,
        state: "ready",
        message:
          'installed from the seed folder, validated for decide, profile "Qwen3-Reranker-0.6B (MLX)" created, class:decide ready'
      }
    ]);

    expect(models.installFromSeed).toHaveBeenCalledWith(mlxId);
    const view = models.views.get(mlxId)!;
    // The same two calls as the Settings screen: create (local model, offline) and attach the model
    // with the capabilities it exposes after its validation.
    expect(ai.createProfile).toHaveBeenCalledWith({
      name: "Qwen3-Reranker-0.6B (MLX)",
      isDefault: false,
      privacyMode: "offline_only",
      outputLanguage: "ui"
    });
    expect(ai.updateProfile).toHaveBeenCalledWith({
      id: ai.profiles[1]!.id,
      modelId: view.modelId,
      capabilities: ["reranking", "offline", "local-files"],
      localModelId: view.id,
      runtime: "mlx"
    });
    expect(ai.profiles[0]).toMatchObject({ name: "Writer", isDefault: true });
    expect(logger.info).toHaveBeenCalledWith(
      `MODEL_INSTALL ${mlxId}: ${(await outcomes)[0]!.message}`
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("makes the first profile the default one, as the Settings screen does", async () => {
    const empty = fakeAi();

    await run(knob(ggufId), { models, ai: empty }).outcomes;

    expect(empty.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Qwen3-Reranker-0.6B Q8_0 (GGUF)", isDefault: true })
    );
  });

  it("installs the models in the order given, one at a time", async () => {
    const order: string[] = [];
    models.installFromSeed.mockImplementation(async (catalogId: string) => {
      order.push(`start ${catalogId}`);
      await Promise.resolve();
      const view = models.views.get(catalogId)!;
      view.status = "ready";
      view.capabilities = ["reranking", "offline", "local-files"];
      order.push(`end ${catalogId}`);
      return structuredClone(view);
    });

    await run(knob(ggufId, mlxId), { models, ai }).outcomes;

    expect(order).toEqual([`start ${ggufId}`, `end ${ggufId}`, `start ${mlxId}`, `end ${mlxId}`]);
    expect(ai.profiles.map((profile) => profile.name)).toEqual([
      "Writer",
      "Qwen3-Reranker-0.6B Q8_0 (GGUF)",
      "Qwen3-Reranker-0.6B (MLX)"
    ]);
  });
});

describe("idempotency", () => {
  it("leaves an installed, validated model with a profile alone", async () => {
    await run(knob(mlxId), { models, ai }).outcomes;
    models.installFromSeed.mockClear();
    models.test.mockClear();
    ai.createProfile.mockClear();
    ai.updateProfile.mockClear();

    const second = run(knob(mlxId), { models, ai });
    const [outcome] = await second.outcomes;

    expect(models.installFromSeed).not.toHaveBeenCalled();
    expect(models.test).not.toHaveBeenCalled();
    expect(ai.createProfile).not.toHaveBeenCalled();
    expect(ai.updateProfile).not.toHaveBeenCalled();
    expect(ai.profiles).toHaveLength(2);
    expect(outcome).toEqual({
      catalogId: mlxId,
      state: "ready",
      message:
        'left alone: already installed, validated for decide, profile "Qwen3-Reranker-0.6B (MLX)" exists, class:decide ready'
    });
    expect(second.logger.info).toHaveBeenCalledOnce();
  });

  it("creates only the missing profile for a model that is installed and validated", async () => {
    models = fakeModels({
      [mlxId]: { status: "ready", capabilities: ["reranking", "offline", "local-files"] }
    });

    const [outcome] = await run(knob(mlxId), { models, ai }).outcomes;

    expect(models.installFromSeed).not.toHaveBeenCalled();
    expect(models.test).not.toHaveBeenCalled();
    expect(ai.createProfile).toHaveBeenCalledOnce();
    expect(outcome!.message).toMatch(
      /^already installed, validated for decide, profile .* created/u
    );
  });

  it("finishes a profile an earlier start created but never attached a model to", async () => {
    models = fakeModels({
      [mlxId]: { status: "ready", capabilities: ["reranking", "offline", "local-files"] }
    });
    ai = fakeAi([
      existingProfile(),
      existingProfile({
        id: "00000000-0000-4000-8000-000000000a02",
        name: "Qwen3-Reranker-0.6B (MLX)",
        isDefault: false,
        providerConfigId: null,
        modelId: null,
        runtime: null,
        capabilities: []
      })
    ]);

    await run(knob(mlxId), { models, ai }).outcomes;

    expect(ai.createProfile).not.toHaveBeenCalled();
    expect(ai.updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "00000000-0000-4000-8000-000000000a02" })
    );
    expect(ai.profiles).toHaveLength(2);
  });

  it("runs the decide validation of a model that is installed but not validated", async () => {
    models = fakeModels({ [mlxId]: { status: "ready" } });

    const [outcome] = await run(knob(mlxId), { models, ai }).outcomes;

    expect(models.installFromSeed).not.toHaveBeenCalled();
    expect(models.test).toHaveBeenCalledWith(mlxId);
    expect(ai.createProfile).toHaveBeenCalledOnce();
    expect(outcome!.state).toBe("ready");
  });
});

describe("failures", () => {
  it("logs a refused or failed install and creates no profile", async () => {
    models.installError = new Error("seed_incomplete: model.safetensors is missing");

    const { logger, outcomes } = run(knob(mlxId), { models, ai });

    await expect(outcomes).resolves.toEqual([
      {
        catalogId: mlxId,
        state: "failed",
        message: "install refused: seed_incomplete: model.safetensors is missing"
      }
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      `MODEL_INSTALL ${mlxId}: failed: install refused: seed_incomplete: model.safetensors is missing`
    );
    expect(ai.createProfile).not.toHaveBeenCalled();
  });

  it("reports an install that ended failed with the model's error", async () => {
    models.installFromSeed.mockImplementation(async (catalogId: string) => {
      const view = models.views.get(catalogId)!;
      view.status = "failed";
      view.lastError = "errors.localModels.checksumMismatch";
      return structuredClone(view);
    });

    const [outcome] = await run(knob(mlxId), { models, ai }).outcomes;

    expect(outcome).toMatchObject({
      state: "failed",
      message: "install failed: errors.localModels.checksumMismatch"
    });
    expect(ai.createProfile).not.toHaveBeenCalled();
  });

  it("creates no profile for a ranker that stays unvalidated, and says why", async () => {
    models.validates = false;

    const [outcome] = await run(knob(mlxId), { models, ai }).outcomes;

    expect(outcome).toEqual({
      catalogId: mlxId,
      state: "failed",
      message:
        "installed from the seed folder, not validated for decide: errors.localModels.rankerSmokeFailed"
    });
    expect(ai.createProfile).not.toHaveBeenCalled();
    expect(ai.updateProfile).not.toHaveBeenCalled();
  });

  it("reports a validation that throws for a model installed earlier", async () => {
    models = fakeModels({ [mlxId]: { status: "ready" } });
    models.validates = false;

    const [outcome] = await run(knob(mlxId), { models, ai }).outcomes;

    expect(outcome).toMatchObject({ state: "failed" });
    expect(outcome!.message).toContain("validation failed: errors.localModels.rankerSmokeFailed");
    expect(ai.createProfile).not.toHaveBeenCalled();
  });

  it("never throws, and a model that fails does not stop the next one", async () => {
    ai.createProfile.mockRejectedValueOnce(
      new Error("postgres://user:secret@localhost/db is down")
    );

    const { logger, outcomes } = run(knob(mlxId, ggufId), { models, ai });
    const results = await outcomes;

    expect(results.map((result) => result.state)).toEqual(["failed", "ready"]);
    expect(String(logger.warn.mock.calls[0]![0])).not.toContain("secret");
    expect(ai.profiles.map((profile) => profile.name)).toContain("Qwen3-Reranker-0.6B Q8_0 (GGUF)");
  });

  it("states the class:decide status the AI service answers, whatever it is", async () => {
    ai.updateProfile.mockImplementation(async () => {
      ai.decide = "not_validated";
      return ai.profiles[1]!;
    });

    const [outcome] = await run(knob(mlxId), { models, ai }).outcomes;

    expect(outcome!.message).toMatch(/class:decide not_validated$/u);
  });
});
