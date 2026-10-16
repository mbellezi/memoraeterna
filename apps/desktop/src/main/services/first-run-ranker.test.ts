import { describe, expect, it, vi } from "vitest";

import type { AiProfile, AiTaskRoute, LocalModelView } from "../../shared/ipc.js";
import {
  FirstRunRanker,
  firstRunRankerCatalogIds,
  firstRunRankerSettingKey
} from "./first-run-ranker.js";
import type {
  FirstRunRankerAi,
  FirstRunRankerModels,
  FirstRunRankerOptions,
  FirstRunRankerState
} from "./first-run-ranker.js";

const { mlx, gguf } = firstRunRankerCatalogIds;
const embeddingId = "gguf-qwen3-embedding-0.6b-q8-0";
const appleSilicon = { platform: "darwin", arch: "arm64" };

/** A model row as `LocalModelService.list` returns it (only the fields the ranker reads). */
function view(catalogId: string, fields: Partial<LocalModelView> = {}): LocalModelView {
  return {
    id: `model-${catalogId}`,
    catalogId,
    modelId: catalogId,
    displayName: catalogId === mlx ? "Qwen3-Reranker-0.6B" : "Qwen3-Reranker-0.6B Q8_0",
    runtime: catalogId.startsWith("mlx") ? "mlx" : "gguf",
    status: "not_downloaded",
    compatible: true,
    capabilities: ["offline", "local-files"],
    lastError: null,
    ...fields
  } as LocalModelView;
}

/** The local models, the AI service and the setting, in memory. */
function world(
  options: {
    views?: LocalModelView[];
    routes?: string[];
    profiles?: Array<Partial<AiProfile>>;
    extra?: Partial<FirstRunRankerOptions>;
  } = {}
) {
  const views = new Map(
    (options.views ?? [view(mlx), view(gguf), view(embeddingId)]).map((entry) => [
      entry.catalogId,
      entry
    ])
  );
  const models = {
    list: vi.fn(async () => [...views.values()].map((entry) => ({ ...entry }))),
    requestDownload: vi.fn(async ({ catalogId }: { catalogId: string }) => {
      const next = { ...views.get(catalogId)!, status: "downloading" as const };
      views.set(catalogId, next);
      return next;
    })
  } satisfies FirstRunRankerModels;
  const profiles: Array<Partial<AiProfile>> = [...(options.profiles ?? [])];
  const ai = {
    listTaskRoutes: vi.fn(async () =>
      (options.routes ?? ["embedding"]).map((task): AiTaskRoute => ({
        task: task as AiTaskRoute["task"],
        profileId: "p-1"
      }))
    ),
    listProfiles: vi.fn(async () => profiles.map((profile) => ({ ...profile })) as AiProfile[]),
    createProfile: vi.fn(async (input) => {
      const profile = { id: `p-${profiles.length + 10}`, status: "active", ...input };
      profiles.push(profile as Partial<AiProfile>);
      return profile as unknown as AiProfile;
    }),
    updateProfile: vi.fn(async (input) => {
      const profile = profiles.find((candidate) => candidate.id === input.id)!;
      Object.assign(profile, input);
      return profile as AiProfile;
    })
  } satisfies FirstRunRankerAi;
  let state: FirstRunRankerState | null = null;
  const store = {
    get: vi.fn(async () => state),
    set: vi.fn(async (next: FirstRunRankerState) => {
      state = next;
    })
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const ranker = new FirstRunRanker({
    models,
    ai,
    store,
    machine: appleSilicon,
    logger,
    now: () => new Date("2026-10-16T12:00:00.000Z"),
    ...options.extra
  });
  return {
    ranker,
    models,
    ai,
    store,
    logger,
    profiles,
    state: () => state,
    /** What the install leaves on the row: installed, and validated unless told otherwise. */
    install(catalogId: string, validated = true) {
      views.set(catalogId, {
        ...views.get(catalogId)!,
        status: "ready",
        capabilities: validated
          ? ["reranking", "offline", "local-files"]
          : ["offline", "local-files"]
      });
    },
    fail(catalogId: string, lastError: string) {
      views.set(catalogId, { ...views.get(catalogId)!, status: "failed", lastError });
    }
  };
}

describe("the first-run ranker (owner decision 19)", () => {
  it("waits for the library's first embedding route, then requests the MLX ranker once", async () => {
    const w = world({ routes: ["summarization"] });
    await expect(w.ranker.ensure()).resolves.toBe("waiting_for_embedding");
    expect(w.models.requestDownload).not.toHaveBeenCalled();
    expect(w.store.set).not.toHaveBeenCalled();

    // A seeding that routed no embedding starts nothing.
    w.ranker.onRoutesSeeded(["class:decide", "summarization"]);
    await w.ranker.ensure();
    expect(w.models.requestDownload).not.toHaveBeenCalled();

    w.ai.listTaskRoutes.mockResolvedValue([{ task: "embedding", profileId: "p-1" }]);
    await expect(w.ranker.ensure()).resolves.toBe("requested");
    expect(w.models.requestDownload).toHaveBeenCalledWith({ catalogId: mlx, acceptLicense: false });
    expect(w.state()).toEqual({
      catalogId: mlx,
      state: "requested",
      reason: null,
      at: "2026-10-16T12:00:00.000Z"
    });
    // While it downloads, later starts and seedings request nothing more.
    await expect(w.ranker.ensure()).resolves.toBe("requested");
    w.ranker.onRoutesSeeded(["embedding"]);
    await w.ranker.ensure();
    expect(w.models.requestDownload).toHaveBeenCalledTimes(1);
    expect(firstRunRankerSettingKey).toBe("local-models.first-run-ranker");
  });

  it("takes the GGUF ranker where MLX does not run, or where its MLX entry cannot run", async () => {
    const linux = world({ extra: { machine: { platform: "linux", arch: "x64" } } });
    await linux.ranker.ensure();
    expect(linux.models.requestDownload).toHaveBeenCalledWith({
      catalogId: gguf,
      acceptLicense: false
    });
    const small = world({ views: [view(mlx, { compatible: false }), view(gguf)] });
    await small.ranker.ensure();
    expect(small.models.requestDownload).toHaveBeenCalledWith({
      catalogId: gguf,
      acceptLicense: false
    });
    const none = world({
      views: [view(mlx, { compatible: false }), view(gguf, { compatible: false })]
    });
    await expect(none.ranker.ensure()).resolves.toBe("skipped");
    expect(none.models.requestDownload).not.toHaveBeenCalled();
    expect(none.state()).toMatchObject({ catalogId: null, state: "skipped" });
    await expect(none.ranker.ensure()).resolves.toBe("skipped");
  });

  it("gives a validated ranker the Settings profile once, so class:decide seeds itself", async () => {
    const w = world({ profiles: [{ id: "p-1", name: "Embedding", status: "active" }] });
    await w.ranker.ensure();
    w.install(mlx);
    await expect(w.ranker.onModelSettled(mlx)).resolves.toBe("ready");
    expect(w.ai.createProfile).toHaveBeenCalledWith({
      name: "Qwen3-Reranker-0.6B (MLX)",
      isDefault: false,
      privacyMode: "offline_only",
      outputLanguage: "ui"
    });
    expect(w.ai.updateProfile).toHaveBeenCalledWith({
      id: "p-11",
      modelId: mlx,
      capabilities: ["reranking", "offline", "local-files"],
      localModelId: `model-${mlx}`,
      runtime: "mlx"
    });
    expect(w.state()).toMatchObject({ catalogId: mlx, state: "ready", reason: null });
    // Settled: nothing more, whatever happens to the model afterwards (a removal is respected).
    await expect(w.ranker.onModelSettled(mlx)).resolves.toBeNull();
    await expect(w.ranker.ensure()).resolves.toBe("settled_earlier");
    expect(w.ai.createProfile).toHaveBeenCalledTimes(1);
    expect(w.models.requestDownload).toHaveBeenCalledTimes(1);
    // Other models' downloads are not its business.
    await expect(w.ranker.onModelSettled(embeddingId)).resolves.toBeNull();
  });

  it("records a failed download or validation without throwing, and completes on a later success", async () => {
    const w = world();
    await w.ranker.ensure();
    w.fail(mlx, "errors.localModels.checksumMismatch");
    await expect(w.ranker.onModelSettled(mlx)).resolves.toBe("failed");
    expect(w.state()).toMatchObject({
      catalogId: mlx,
      state: "failed",
      reason: "errors.localModels.checksumMismatch"
    });
    expect(w.logger.warn).toHaveBeenCalledTimes(1);
    // Installed, but the smoke test could not run (another local model held the slot).
    w.install(mlx, false);
    await expect(w.ranker.onModelSettled(mlx)).resolves.toBe("failed");
    expect(w.state()).toMatchObject({ reason: "errors.localModels.rankerNotValidated" });
    expect(w.ai.createProfile).not.toHaveBeenCalled();
    // The owner runs the test in Settings: validated, so the profile follows.
    w.install(mlx);
    await expect(w.ranker.onModelSettled(mlx)).resolves.toBe("ready");
    expect(w.ai.createProfile).toHaveBeenCalledTimes(1);
  });

  it("never throws when the download is refused or the store fails", async () => {
    const refused = world();
    refused.models.requestDownload.mockRejectedValue(
      new Error("errors.localModels.mlxUnavailable")
    );
    await expect(refused.ranker.ensure()).resolves.toBe("failed");
    expect(refused.state()).toMatchObject({
      catalogId: mlx,
      state: "failed",
      reason: "errors.localModels.mlxUnavailable"
    });
    const broken = world();
    broken.store.get.mockRejectedValue(new Error("errors.database.notReady"));
    await expect(broken.ranker.ensure()).resolves.toBe("failed");
    expect(broken.models.requestDownload).not.toHaveBeenCalled();
  });

  it("adopts a ranker the owner already installed, and reuses its profile", async () => {
    const w = world({
      views: [view(mlx), view(gguf, { status: "ready", capabilities: ["reranking"] })],
      profiles: [{ id: "p-7", status: "active", localModelId: `model-${gguf}` }]
    });
    await expect(w.ranker.ensure()).resolves.toBe("ready");
    expect(w.models.requestDownload).not.toHaveBeenCalled();
    expect(w.ai.createProfile).not.toHaveBeenCalled();
    expect(w.ai.updateProfile).not.toHaveBeenCalled();
    expect(w.state()).toMatchObject({ catalogId: gguf, state: "ready" });
  });

  it("does nothing when turned off (golden runs, the E6 harness)", async () => {
    const w = world({ extra: { enabled: false } });
    await expect(w.ranker.ensure()).resolves.toBe("disabled");
    w.ranker.onRoutesSeeded(["embedding"]);
    await w.ranker.ensure();
    expect(w.store.get).not.toHaveBeenCalled();
    expect(w.models.requestDownload).not.toHaveBeenCalled();
  });
});
