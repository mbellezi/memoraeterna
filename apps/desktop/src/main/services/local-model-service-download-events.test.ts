import type { LocalModelDownloadProgress } from "@app/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppEventSchema, type ModelDownloadEvent } from "../../shared/app-events.js";
import { LocalModelService } from "./local-model-service.js";

/** An in-memory `local_models` table, as in the ranker tests, reduced to what a download touches. */
const store = vi.hoisted(() => ({
  models: new Map<string, Record<string, unknown>>(),
  downloads: new Map<string, Record<string, unknown>>(),
  jobs: new Map<string, Record<string, unknown>>()
}));
const installer = vi.hoisted(() => ({
  downloadLocalModel: vi.fn(),
  verifyLocalModelFiles: vi.fn()
}));
vi.mock("@app/ai", async () => ({
  ...(await vi.importActual<typeof import("@app/ai")>("@app/ai")),
  downloadLocalModel: installer.downloadLocalModel,
  verifyLocalModelFiles: installer.verifyLocalModelFiles
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
      const download = {
        id: input.jobId,
        ...input,
        currentFile: null,
        downloadedBytes: 0,
        bytesPerSecond: 0,
        etaSeconds: null
      };
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
    },
    async deleteModel() {}
  };
  const jobs = {
    async create(input: Record<string, unknown>) {
      const job = {
        id: `00000000-0000-4000-8000-${String(store.jobs.size + 101).padStart(12, "0")}`,
        status: "queued",
        attempts: 0,
        maxAttempts: 3,
        ...input
      };
      store.jobs.set(String(job.id), job);
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

const catalogId = "gguf-bge-m3-q8-0";

function newService(onDownload: (event: ModelDownloadEvent) => void) {
  return new LocalModelService({
    getPool: () => ({}) as never,
    userDataPath: "/nonexistent/memora-test",
    onDownload
  });
}

const step = (downloadedBytes: number): LocalModelDownloadProgress => ({
  currentFile: "model.gguf",
  currentFileBytes: downloadedBytes,
  currentFileSizeBytes: 100,
  downloadedBytes,
  totalBytes: 100,
  bytesPerSecond: 7.4,
  etaSeconds: 3
});

beforeEach(() => {
  store.models.clear();
  store.downloads.clear();
  store.jobs.clear();
  for (const mock of Object.values(installer)) mock.mockReset();
});

describe("model.download events from the local model service", () => {
  it("announces the request, each progress step, verifying and ready, all valid", async () => {
    installer.downloadLocalModel.mockImplementation(
      async ({
        entry,
        onProgress
      }: {
        entry: { id: string };
        onProgress: (p: LocalModelDownloadProgress) => Promise<void>;
      }) => {
        await onProgress(step(30));
        await onProgress(step(100));
        return { modelPath: `/nonexistent/memora-test/local-models/${entry.id}`, sizeBytes: 100 };
      }
    );
    installer.verifyLocalModelFiles.mockResolvedValue(true);
    const events: ModelDownloadEvent[] = [];
    const service = newService((event) => events.push(event));

    await service.requestDownload({ catalogId, acceptLicense: true });
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe("ready"));

    expect(events.map((event) => event.status)).toEqual([
      "downloading",
      "downloading",
      "downloading",
      "verifying",
      "ready"
    ]);
    for (const event of events) {
      expect(AppEventSchema.safeParse(event).success).toBe(true);
      expect(event.catalogId).toBe(catalogId);
    }
    expect(events[1]).toMatchObject({
      currentFile: "model.gguf",
      downloadedBytes: 30,
      totalBytes: 100,
      bytesPerSecond: 7,
      etaSeconds: 3,
      error: null
    });
    expect(events.at(-1)).toMatchObject({ downloadedBytes: 100, totalBytes: 100, etaSeconds: 0 });
  });

  it("announces a failed install with the reason, and keeps the install if a listener throws", async () => {
    installer.downloadLocalModel.mockRejectedValue(new Error("network down"));
    const events: ModelDownloadEvent[] = [];
    const warn = vi.fn();
    const service = new LocalModelService({
      getPool: () => ({}) as never,
      userDataPath: "/nonexistent/memora-test",
      logger: { warn, error: vi.fn() },
      onDownload: (event) => {
        events.push(event);
        if (events.length === 1) throw new Error("listener failed");
      }
    });

    await service.requestDownload({ catalogId, acceptLicense: true });
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe("failed"));

    expect(events.at(-1)).toMatchObject({ status: "failed", error: "network down" });
    expect(AppEventSchema.safeParse(events.at(-1)).success).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(store.models.get(catalogId)).toMatchObject({
      status: "failed",
      lastError: "network down"
    });
  });

  it("cuts a very long error so the event stays valid", async () => {
    installer.downloadLocalModel.mockRejectedValue(new Error("x".repeat(5_000)));
    const events: ModelDownloadEvent[] = [];
    const service = newService((event) => events.push(event));

    await service.requestDownload({ catalogId, acceptLicense: true });
    await vi.waitFor(() => expect(events.at(-1)?.status).toBe("failed"));

    expect(events.at(-1)?.error?.length).toBeLessThanOrEqual(1_000);
    expect(AppEventSchema.safeParse(events.at(-1)).success).toBe(true);
  });

  it("announces a cancel as a failed install with the canceled key", async () => {
    installer.downloadLocalModel.mockImplementation(() => new Promise(() => undefined));
    const events: ModelDownloadEvent[] = [];
    const service = newService((event) => events.push(event));
    await service.requestDownload({ catalogId, acceptLicense: true });
    await vi.waitFor(() => expect(installer.downloadLocalModel).toHaveBeenCalledTimes(1));

    await service.cancel(catalogId);

    expect(events.at(-1)).toMatchObject({
      status: "failed",
      error: "errors.localModels.canceled"
    });
  });

  it("works without a listener", async () => {
    installer.downloadLocalModel.mockResolvedValue({
      modelPath: "/nonexistent/memora-test/local-models/x",
      sizeBytes: 100
    });
    installer.verifyLocalModelFiles.mockResolvedValue(true);
    const service = new LocalModelService({
      getPool: () => ({}) as never,
      userDataPath: "/nonexistent/memora-test"
    });

    await service.requestDownload({ catalogId, acceptLicense: true });
    await vi.waitFor(() => expect(store.models.get(catalogId)?.status).toBe("ready"));
  });
});
