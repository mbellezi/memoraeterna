import {
  createDecideValidation,
  findLocalModelCatalogEntry,
  localModelCatalog,
  LocalModelSeedError,
  qwen3RerankerPrompt,
  rankerCatalogArtifactSha256,
  runRankerSmoke,
  type LocalModelCatalogEntry,
  type RankRequest,
  type RankResult
} from "@app/ai";
import type { LocalModelRecord } from "@app/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LocalModelService } from "./local-model-service.js";

/** An in-memory `local_models` table with the semantics of the repository's upsert and update. */
const store = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  downloads: new Map<string, Record<string, unknown>>(),
  jobs: new Map<string, Record<string, unknown>>()
}));
const installer = vi.hoisted(() => ({
  assertLocalModelSeeded: vi.fn(),
  downloadLocalModel: vi.fn(),
  verifyLocalModelFiles: vi.fn(),
  validateCatalogRankerArtifact: vi.fn()
}));
vi.mock("@app/ai", async () => ({
  ...(await vi.importActual<typeof import("@app/ai")>("@app/ai")),
  assertLocalModelSeeded: installer.assertLocalModelSeeded,
  downloadLocalModel: installer.downloadLocalModel,
  verifyLocalModelFiles: installer.verifyLocalModelFiles,
  validateCatalogRankerArtifact: installer.validateCatalogRankerArtifact
}));
vi.mock("@app/db", async () => {
  const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
  const repository = {
    async upsertModel(input: Record<string, unknown>) {
      const existing = store.models.get(String(input.catalogId));
      const record = {
        id:
          existing?.id ??
          `00000000-0000-4000-8000-${String(store.models.size + 1).padStart(12, "0")}`,
        status: "not_downloaded",
        managedPath: null,
        installedSizeBytes: 0,
        licenseAcceptedAt: null,
        lastError: null,
        defaultParameters: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...existing,
        ...input,
        capabilities: input.capabilities,
        metadata: input.metadata
      };
      store.models.set(String(input.catalogId), record);
      return structuredClone(record);
    },
    async listModels() {
      return [...store.models.values()].map((record) => structuredClone(record));
    },
    async findByCatalogId(catalogId: string) {
      const record = store.models.get(catalogId);
      return record ? structuredClone(record) : null;
    },
    async findById(id: string) {
      const record = [...store.models.values()].find((candidate) => candidate.id === id);
      return record ? structuredClone(record) : null;
    },
    async updateModel(id: string, input: Record<string, unknown>) {
      const record = [...store.models.values()].find((candidate) => candidate.id === id)!;
      Object.assign(record, input);
      return structuredClone(record);
    },
    async listFiles() {
      return [];
    },
    async replaceFiles() {},
    async createDownload(input: { localModelId: string; jobId: string; totalBytes: number }) {
      const download = { id: input.jobId, ...input, currentFile: null };
      store.downloads.set(input.localModelId, download);
      return structuredClone(download);
    },
    async latestDownload(localModelId: string) {
      const download = store.downloads.get(localModelId);
      return download ? structuredClone(download) : null;
    },
    async updateDownload() {
      return {};
    },
    async updateFileProgress() {},
    async profilesUsing() {
      return [];
    }
  };
  const jobs = {
    async create(input: Record<string, unknown>) {
      const job = {
        id: `job-${store.jobs.size + 1}`,
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
        ...input
      };
      store.jobs.set(job.id, job);
      return structuredClone(job);
    },
    async findById(id: string) {
      const job = store.jobs.get(id);
      return job ? structuredClone(job) : null;
    },
    async update(id: string, input: Record<string, unknown>) {
      const job = store.jobs.get(id)!;
      Object.assign(job, input);
      return structuredClone(job);
    },
    async reportProgress() {
      return null;
    },
    async requestCancel() {
      return null;
    }
  };
  return {
    ...actual,
    createLocalModelRepository: () => repository,
    createJobRepository: () => jobs,
    createSettingsRepository: () => ({ get: async () => undefined })
  };
});
vi.mock("./credential-service.js", () => ({ CredentialService: class {} }));

const mlxId = "mlx-qwen3-reranker-0.6b";
const ggufId = "gguf-qwen3-reranker-0.6b-q8-0";

function entryOf(catalogId: string): LocalModelCatalogEntry {
  return findLocalModelCatalogEntry(catalogId)!;
}

/** A decide validation as the model test records it for the install of this catalog entry. */
async function validationFor(
  entry: LocalModelCatalogEntry,
  overrides: Record<string, unknown> = {}
) {
  const rank = async (request: RankRequest): Promise<RankResult> => {
    const card =
      request.instruction === qwen3RerankerPrompt.defaultInstruction &&
      request.query.startsWith("What is the capital");
    const logOdds = request.documents.map((_, index) =>
      card ? [7.625, -11.375][index]! : index === 0 ? 8 : -8
    );
    return {
      logOdds,
      scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
      tokenCounts: logOdds.map(() => 100),
      truncated: logOdds.map(() => false)
    };
  };
  return {
    ...createDecideValidation(
      {
        runtime: entry.runtime,
        revision: entry.revision,
        artifactSha256: rankerCatalogArtifactSha256(entry),
        runtimeBuild: "memora-mlx-helper@sha256:test"
      },
      await runRankerSmoke(rank)
    ),
    ...overrides
  };
}

function newService(overrides: Partial<ConstructorParameters<typeof LocalModelService>[0]> = {}) {
  return new LocalModelService({
    getPool: () => ({}) as never,
    userDataPath: "/nonexistent/memora-test",
    ...overrides
  });
}

const storedRanker = (catalogId: string) =>
  store.models.get(catalogId)! as unknown as LocalModelRecord;

/** Pretends the ranker is installed, as the download leaves it. */
function install(catalogId: string, metadata: Record<string, unknown> = {}) {
  const record = storedRanker(catalogId);
  Object.assign(record, {
    status: "ready",
    managedPath: `/nonexistent/memora-test/local-models/${catalogId}`,
    metadata: { ...record.metadata, ...metadata }
  });
}

beforeEach(() => {
  store.models.clear();
  store.downloads.clear();
  store.jobs.clear();
  for (const mock of Object.values(installer)) mock.mockReset();
});

describe("exposure of a ranker's reranking capability", () => {
  it("is withheld until the ranker is installed and validated for decide", async () => {
    const views = await newService().list();

    for (const id of [mlxId, ggufId]) {
      const view = views.find((candidate) => candidate.catalogId === id)!;
      expect(view.capabilities).toEqual(["offline", "local-files"]);
      expect(view.parameterCapabilities).toEqual({});
      expect(view.status).toBe("not_downloaded");
    }
    // Generative and embedding models are untouched.
    const gemma = views.find((candidate) => candidate.catalogId === "mlx-gemma-4-e4b-it-4bit")!;
    expect(gemma.capabilities).toContain("text-generation");
    expect(gemma.capabilities).not.toContain("reranking");
    expect(
      views.find((candidate) => candidate.catalogId === "gguf-bge-m3-q8-0")!.capabilities
    ).toEqual(["embedding", "offline", "local-files"]);
  });

  it("is exposed once an installed ranker holds a validation of its revision and artifact", async () => {
    const service = newService();
    await service.list();
    install(mlxId, { decideValidation: await validationFor(entryOf(mlxId)) });

    const views = await service.list();

    expect(views.find((view) => view.catalogId === mlxId)!.capabilities).toEqual([
      "reranking",
      "offline",
      "local-files"
    ]);
    // The validation survives every later sync, which rewrites the catalog metadata.
    await service.list();
    expect(storedRanker(mlxId).metadata.decideValidation).toMatchObject({ version: 1 });
    // The other runtime is a separate install with its own validation.
    expect(views.find((view) => view.catalogId === ggufId)!.capabilities).not.toContain(
      "reranking"
    );
  });

  it("is withdrawn when the catalog revision or the artifact no longer matches the validation", async () => {
    const service = newService();
    await service.list();
    const entry = entryOf(mlxId);
    const stale = await validationFor(entry, { revision: "0".repeat(40) });
    install(mlxId, { decideValidation: stale });

    let view = (await service.list()).find((candidate) => candidate.catalogId === mlxId)!;
    expect(view.capabilities).not.toContain("reranking");
    expect(storedRanker(mlxId).metadata.decideValidation).toBeUndefined();

    install(mlxId, {
      decideValidation: await validationFor(entry, { artifactSha256: "1".repeat(64) })
    });
    view = (await service.list()).find((candidate) => candidate.catalogId === mlxId)!;
    expect(view.capabilities).not.toContain("reranking");
    expect(storedRanker(mlxId).metadata.decideValidation).toBeUndefined();
  });

  it("is withdrawn when the ranker is not installed any more", async () => {
    const service = newService();
    await service.list();
    install(mlxId, { decideValidation: await validationFor(entryOf(mlxId)) });
    expect((await service.list()).find((view) => view.catalogId === mlxId)!.capabilities).toContain(
      "reranking"
    );

    Object.assign(storedRanker(mlxId), { status: "not_downloaded", managedPath: null });

    const view = (await service.list()).find((candidate) => candidate.catalogId === mlxId)!;
    expect(view.capabilities).not.toContain("reranking");
    expect(storedRanker(mlxId).metadata.decideValidation).toBeUndefined();
  });

  it("ignores a validation stored on a model that is not a dedicated ranker", async () => {
    const service = newService();
    await service.list();
    const gemma = storedRanker("mlx-gemma-4-e4b-it-4bit");
    gemma.metadata = { decideValidation: await validationFor(entryOf(mlxId)) };

    await service.list();

    expect(storedRanker("mlx-gemma-4-e4b-it-4bit").metadata.decideValidation).toBeUndefined();
  });
});

describe("testing an installed ranker", () => {
  it("exposes reranking right after a passing test, and closes it when a later test fails", async () => {
    const service = newService({
      testModel: async (localModelId) => {
        const record = [...store.models.values()].find(
          (candidate) => candidate.id === localModelId
        )!;
        record.metadata = {
          ...(record.metadata as object),
          decideValidation: await validationFor(entryOf(String(record.catalogId)))
        };
        return "validated";
      }
    });
    await service.list();
    install(mlxId);
    expect(
      (await service.list()).find((view) => view.catalogId === mlxId)!.capabilities
    ).not.toContain("reranking");

    await expect(service.test(mlxId)).resolves.toBe("validated");
    expect((await service.list()).find((view) => view.catalogId === mlxId)!.capabilities).toContain(
      "reranking"
    );

    const failing = newService({
      testModel: async (localModelId) => {
        const record = [...store.models.values()].find(
          (candidate) => candidate.id === localModelId
        )!;
        const metadata = { ...(record.metadata as Record<string, unknown>) };
        delete metadata.decideValidation;
        record.metadata = metadata;
        record.lastError = "errors.localModels.checksumMismatch";
        throw new Error("errors.localModels.checksumMismatch");
      }
    });
    await expect(failing.test(mlxId)).rejects.toThrow("errors.localModels.checksumMismatch");
    const view = (await failing.list()).find((candidate) => candidate.catalogId === mlxId)!;
    expect(view.capabilities).not.toContain("reranking");
    expect(view.lastError).toBe("errors.localModels.checksumMismatch");
  });

  it("does not test a ranker that is not installed", async () => {
    const testModel = vi.fn();
    const service = newService({ testModel });

    await expect(service.test(ggufId)).rejects.toThrow("errors.localModels.notReady");
    expect(testModel).not.toHaveBeenCalled();
  });
});

describe("installing a ranker", () => {
  const wasInstalled = (catalogId: string) => storedRanker(catalogId).status === "ready";

  beforeEach(() => {
    installer.downloadLocalModel.mockImplementation(async ({ entry }) => ({
      modelPath: `/nonexistent/memora-test/local-models/${entry.id}`,
      sizeBytes: entry.files.reduce(
        (total: number, file: { sizeBytes: number }) => total + file.sizeBytes,
        0
      )
    }));
    installer.verifyLocalModelFiles.mockResolvedValue(true);
    installer.validateCatalogRankerArtifact.mockResolvedValue({ runtime: "gguf" });
  });

  it("checks the artifact, then validates the ranker for decide right away", async () => {
    const testModel = vi.fn(async (localModelId: string) => {
      const record = [...store.models.values()].find((candidate) => candidate.id === localModelId)!;
      record.metadata = {
        ...(record.metadata as object),
        decideValidation: await validationFor(entryOf(ggufId))
      };
      return "validated";
    });
    const service = newService({ testModel });

    await service.requestDownload({ catalogId: ggufId, acceptLicense: false });
    await vi.waitFor(() => expect(testModel).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(storedRanker(ggufId).capabilities).toEqual(["reranking", "offline", "local-files"])
    );

    expect(installer.validateCatalogRankerArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: ggufId }),
      `/nonexistent/memora-test/local-models/${ggufId}`
    );
    expect(testModel).toHaveBeenCalledWith(storedRanker(ggufId).id);
    expect(wasInstalled(ggufId)).toBe(true);
  });

  it("keeps the install but not the capability when the validation test fails", async () => {
    const warn = vi.fn();
    const testModel = vi.fn(async () => {
      throw new Error("errors.localModels.rankerSmokeFailed");
    });
    const service = newService({ testModel, logger: { warn, error: vi.fn() } });

    await service.requestDownload({ catalogId: ggufId, acceptLicense: false });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("errors.localModels.rankerSmokeFailed")
    );

    expect(wasInstalled(ggufId)).toBe(true);
    expect(storedRanker(ggufId).capabilities).toEqual(["offline", "local-files"]);
  });

  it("does not install a ranker whose artifact is not a supported Qwen3 ranker", async () => {
    installer.validateCatalogRankerArtifact.mockRejectedValue(
      new Error("errors.localModels.rankerInvalid")
    );
    const testModel = vi.fn();
    const warn = vi.fn();
    const service = newService({ testModel, logger: { warn, error: vi.fn() } });

    await service.requestDownload({ catalogId: ggufId, acceptLicense: false });
    await vi.waitFor(() => expect(storedRanker(ggufId).status).toBe("failed"));

    expect(storedRanker(ggufId).lastError).toBe("errors.localModels.rankerInvalid");
    expect(testModel).not.toHaveBeenCalled();
  });

  it("does not validate or artifact-check an embedding model", async () => {
    const testModel = vi.fn();
    const service = newService({ testModel });

    await service.requestDownload({ catalogId: "gguf-bge-m3-q8-0", acceptLicense: false });
    await vi.waitFor(() => expect(storedRanker("gguf-bge-m3-q8-0").status).toBe("ready"));
    await service.shutdown();

    expect(installer.validateCatalogRankerArtifact).not.toHaveBeenCalled();
    expect(testModel).not.toHaveBeenCalled();
  });

  it("downloads from the DEV seed folder when one is configured", async () => {
    const service = newService({
      env: { MEMORA_LOCAL_MODEL_SEED_DIR: ".cache/models" },
      isPackaged: false,
      workspaceRoot: "/work/memora",
      testModel: vi.fn(async () => "ok")
    });

    await service.requestDownload({ catalogId: ggufId, acceptLicense: false });
    await vi.waitFor(() => expect(installer.downloadLocalModel).toHaveBeenCalledTimes(1));

    expect(installer.downloadLocalModel.mock.calls[0]![0]).toMatchObject({
      seedRoot: "/work/memora/.cache/models"
    });
  });

  it("never reads a seed folder in a packaged build", async () => {
    const service = newService({
      env: { MEMORA_LOCAL_MODEL_SEED_DIR: ".cache/models" },
      isPackaged: true,
      logger: { warn: vi.fn(), error: vi.fn() },
      testModel: vi.fn(async () => "ok")
    });

    await service.requestDownload({ catalogId: ggufId, acceptLicense: false });
    await vi.waitFor(() => expect(installer.downloadLocalModel).toHaveBeenCalledTimes(1));

    expect(installer.downloadLocalModel.mock.calls[0]![0]).not.toHaveProperty("seedRoot");
  });
});

describe("installing from the DEV seed folder at startup", () => {
  const seedDir = "/work/memora/.cache/models";
  const devService = (
    overrides: Partial<ConstructorParameters<typeof LocalModelService>[0]> = {}
  ) =>
    newService({
      env: { MEMORA_LOCAL_MODEL_SEED_DIR: seedDir },
      isPackaged: false,
      workspaceRoot: "/work/memora",
      ...overrides
    });
  /** What a passing model test leaves in the store. */
  const validating = () =>
    vi.fn(async (localModelId: string) => {
      const record = [...store.models.values()].find((candidate) => candidate.id === localModelId)!;
      record.metadata = {
        ...(record.metadata as object),
        decideValidation: await validationFor(entryOf(String(record.catalogId)))
      };
      return "validated";
    });

  beforeEach(() => {
    installer.assertLocalModelSeeded.mockResolvedValue(undefined);
    installer.downloadLocalModel.mockImplementation(async ({ entry }) => ({
      modelPath: `/nonexistent/memora-test/local-models/${entry.id}`,
      sizeBytes: entry.files.reduce(
        (total: number, file: { sizeBytes: number }) => total + file.sizeBytes,
        0
      )
    }));
    installer.verifyLocalModelFiles.mockResolvedValue(true);
    installer.validateCatalogRankerArtifact.mockResolvedValue({ runtime: "mlx" });
  });

  it("installs through the normal install path with the seed root, and returns after the decide validation", async () => {
    const testModel = validating();
    const service = devService({ testModel });

    const view = await service.installFromSeed(mlxId);

    // Nothing is awaited with waitFor: the call itself returns when the ranker is validated.
    expect(installer.assertLocalModelSeeded).toHaveBeenCalledWith(
      expect.objectContaining({ id: mlxId }),
      seedDir
    );
    expect(installer.downloadLocalModel).toHaveBeenCalledTimes(1);
    expect(installer.downloadLocalModel.mock.calls[0]![0]).toMatchObject({
      seedRoot: seedDir,
      entry: expect.objectContaining({ id: mlxId })
    });
    expect(installer.validateCatalogRankerArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: mlxId }),
      `/nonexistent/memora-test/local-models/${mlxId}`
    );
    expect(testModel).toHaveBeenCalledWith(storedRanker(mlxId).id);
    expect(view).toMatchObject({ catalogId: mlxId, status: "ready" });
    expect(view.capabilities).toEqual(["reranking", "offline", "local-files"]);
  });

  it("leaves an unvalidated ranker installed without reranking when the model test fails", async () => {
    const warn = vi.fn();
    const service = devService({
      testModel: vi.fn(async () => {
        throw new Error("errors.localModels.rankerSmokeFailed");
      }),
      logger: { warn, error: vi.fn() }
    });

    const view = await service.installFromSeed(mlxId);

    expect(view.status).toBe("ready");
    expect(view.capabilities).not.toContain("reranking");
  });

  it("reports a failed install instead of throwing", async () => {
    installer.downloadLocalModel.mockRejectedValue(
      new Error("errors.localModels.checksumMismatch")
    );
    const service = devService({
      testModel: validating(),
      logger: { warn: vi.fn(), error: vi.fn() }
    });

    const view = await service.installFromSeed(ggufId);

    expect(view).toMatchObject({
      status: "failed",
      lastError: "errors.localModels.checksumMismatch"
    });
  });

  it("waits for a model queued behind another one", async () => {
    const service = devService({ testModel: validating() });

    const [mlx, gguf] = await Promise.all([
      service.installFromSeed(mlxId),
      service.installFromSeed(ggufId)
    ]);

    expect([mlx.status, gguf.status]).toEqual(["ready", "ready"]);
    expect(mlx.capabilities).toContain("reranking");
    expect(gguf.capabilities).toContain("reranking");
    expect(installer.downloadLocalModel).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a model that is installed already", async () => {
    const service = devService({ testModel: validating() });
    await service.installFromSeed(mlxId);
    installer.downloadLocalModel.mockClear();

    const view = await service.installFromSeed(mlxId);

    expect(view.status).toBe("ready");
    expect(installer.downloadLocalModel).not.toHaveBeenCalled();
  });

  it("downloads nothing when there is no seed folder or the build is packaged", async () => {
    for (const service of [
      newService({ env: {}, isPackaged: false, testModel: validating() }),
      newService({
        env: { MEMORA_LOCAL_MODEL_SEED_DIR: seedDir },
        isPackaged: true,
        logger: { warn: vi.fn(), error: vi.fn() },
        testModel: validating()
      })
    ]) {
      await expect(service.installFromSeed(mlxId)).rejects.toMatchObject({
        code: "seed_not_set"
      });
    }
    expect(installer.downloadLocalModel).not.toHaveBeenCalled();
  });

  it("downloads nothing when the seed folder lacks a pinned file", async () => {
    installer.assertLocalModelSeeded.mockRejectedValue(
      new LocalModelSeedError(
        "seed_incomplete",
        "model.safetensors is missing from the seed folder"
      )
    );
    const service = devService({ testModel: validating() });

    await expect(service.installFromSeed(mlxId)).rejects.toMatchObject({ code: "seed_incomplete" });

    expect(installer.downloadLocalModel).not.toHaveBeenCalled();
    expect((await service.list()).find((view) => view.catalogId === mlxId)!.status).toBe(
      "not_downloaded"
    );
  });

  it("rejects an id that is not in the catalog", async () => {
    await expect(devService().installFromSeed("mlx-nothing")).rejects.toThrow(
      "errors.localModels.notFound"
    );
    expect(installer.downloadLocalModel).not.toHaveBeenCalled();
  });
});

describe("the DEV seed folder", () => {
  it("is refused in a packaged build, and when the build is not declared", () => {
    const warn = vi.fn();
    newService({
      env: { MEMORA_LOCAL_MODEL_SEED_DIR: "/data/models" },
      isPackaged: true,
      logger: { warn, error: vi.fn() }
    });
    newService({
      env: { MEMORA_LOCAL_MODEL_SEED_DIR: "/data/models" },
      logger: { warn, error: vi.fn() }
    });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toMatch(/refused in packaged builds/u);
  });

  it("is accepted in an unpackaged build", () => {
    const warn = vi.fn();
    newService({
      env: { MEMORA_LOCAL_MODEL_SEED_DIR: ".cache/models" },
      isPackaged: false,
      workspaceRoot: "/work",
      logger: { warn, error: vi.fn() }
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the catalog the service synchronizes", () => {
  it("lists both rankers beside the other models", async () => {
    const views = await newService().list();

    expect(views).toHaveLength(localModelCatalog.length);
    expect(views.map((view) => view.catalogId)).toEqual(expect.arrayContaining([mlxId, ggufId]));
  });
});
