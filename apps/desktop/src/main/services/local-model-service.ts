import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { totalmem } from "node:os";
import { basename, extname, join, relative } from "node:path";

import {
  detectLocalRuntimeCompatibility,
  downloadLocalModel,
  findLocalModelCatalogEntry,
  localModelCatalog,
  localModelCatalogVersion,
  localModelExpectedSize,
  localModelManifestHash,
  redactSensitiveText,
  resolveManagedModelPath,
  sha256File,
  verifyLocalModelFiles,
  type LocalModelCatalogEntry
} from "@app/ai";
import {
  createJobRepository,
  createLocalModelRepository,
  createSettingsRepository,
  type LocalModelRecord,
  type PgPool
} from "@app/db";
import { aiModelParametersSchema } from "../../shared/ipc.js";
import type { AiModelParameters, LocalModelDownloadInput, LocalModelView } from "../../shared/ipc.js";

import { CredentialService } from "./credential-service.js";

export interface LocalModelServiceOptions {
  getPool: () => PgPool | null;
  userDataPath: string;
  fetch?: typeof fetch;
  logger?: Pick<Console, "warn" | "error">;
  isModelInUse?: (localModelId: string) => boolean;
  testModel?: (localModelId: string) => Promise<string>;
}

const repositoryTokenSettingKey = "local-models.repository-token-ref";

export class LocalModelService {
  private readonly credentials: CredentialService;
  private readonly modelsRoot: string;
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private activeCatalogId: string | null = null;
  private pumpPromise: Promise<void> | null = null;
  private stopped = false;

  public constructor(private readonly options: LocalModelServiceOptions) {
    this.credentials = new CredentialService(options.userDataPath);
    this.modelsRoot = join(options.userDataPath, "local-models");
  }

  public async start(): Promise<void> {
    this.stopped = false;
    await this.syncCatalog();
    const repository = createLocalModelRepository(this.requirePool());
    for (const model of await repository.listModels()) {
      if (model.status !== "downloading" && model.status !== "verifying") continue;
      const download = await repository.latestDownload(model.id);
      if (!download) continue;
      await createJobRepository(this.requirePool()).update(download.jobId, {
        status: "queued", lockedAt: null, lockedBy: null, finishedAt: null, cancelRequestedAt: null
      });
      this.schedule(model.catalogId);
    }
  }

  public async shutdown(): Promise<void> {
    this.stopped = true;
    this.queue.length = 0;
    for (const controller of this.controllers.values()) controller.abort();
    await this.pumpPromise;
    this.controllers.clear();
  }

  public async list(): Promise<LocalModelView[]> {
    await this.syncCatalog();
    const repository = createLocalModelRepository(this.requirePool());
    return await Promise.all((await repository.listModels()).map((model) => this.toView(model)));
  }

  public async requestDownload(input: LocalModelDownloadInput): Promise<LocalModelView> {
    const entry = requiredCatalogEntry(input.catalogId);
    const compatibility = compatibilityFor(entry);
    if (!compatibility.compatible) throw new Error(`errors.localModels.${compatibility.reason}`);
    const repository = createLocalModelRepository(this.requirePool());
    const model = await this.requireCatalogModel(entry.id);
    if (entry.requiresLicenseAcceptance && !model.licenseAcceptedAt && !input.acceptLicense) {
      throw new Error("errors.localModels.licenseRequired");
    }
    if (model.status === "ready") return this.toView(model);
    if (input.acceptLicense && !model.licenseAcceptedAt) {
      await repository.updateModel(model.id, { licenseAcceptedAt: new Date() });
    }
    const latest = await repository.latestDownload(model.id);
    if (!latest || !["queued", "running"].includes((await createJobRepository(this.requirePool()).findById(latest.jobId))?.status ?? "")) {
      await this.createDownload(model);
    }
    await repository.updateModel(model.id, { status: "downloading", lastError: null });
    this.schedule(model.catalogId);
    return this.toView((await repository.findById(model.id))!);
  }

  public async cancel(catalogId: string): Promise<LocalModelView> {
    const repository = createLocalModelRepository(this.requirePool());
    const model = await this.requireCatalogModel(catalogId);
    const download = await repository.latestDownload(model.id);
    if (download) await createJobRepository(this.requirePool()).requestCancel(download.jobId);
    this.controllers.get(catalogId)?.abort();
    const queuedIndex = this.queue.indexOf(catalogId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    const next = await repository.updateModel(model.id, { status: "failed", lastError: "errors.localModels.canceled" });
    return this.toView(next);
  }

  public async resume(catalogId: string): Promise<LocalModelView> {
    const model = await this.requireCatalogModel(catalogId);
    const repository = createLocalModelRepository(this.requirePool());
    const latest = await repository.latestDownload(model.id);
    const jobs = createJobRepository(this.requirePool());
    const previousJob = latest ? await jobs.findById(latest.jobId) : null;
    if (!latest || !previousJob || previousJob.attempts >= previousJob.maxAttempts) {
      await this.createDownload(model);
    } else {
      await jobs.update(previousJob.id, {
        status: "queued", error: null, progress: 0, runAfter: new Date(),
        lockedAt: null, lockedBy: null, finishedAt: null, cancelRequestedAt: null
      });
    }
    const next = await repository.updateModel(model.id, { status: "downloading", lastError: null });
    this.schedule(catalogId);
    return this.toView(next);
  }

  public async remove(catalogId: string): Promise<LocalModelView> {
    const repository = createLocalModelRepository(this.requirePool());
    const model = await this.requireCatalogModel(catalogId);
    if (this.controllers.has(catalogId) || this.queue.includes(catalogId)) throw new Error("errors.localModels.modelBusy");
    if (this.options.isModelInUse?.(model.id)) throw new Error("errors.localModels.modelBusy");
    const profiles = await repository.profilesUsing(model.id);
    if (profiles.length > 0) throw new Error("errors.localModels.profileInUse");
    await repository.updateModel(model.id, { status: "removing", lastError: null });
    if (model.managedPath) {
      const relativePath = relative(this.modelsRoot, model.managedPath);
      const safePath = resolveManagedModelPath(this.modelsRoot, relativePath);
      await rm(safePath, { recursive: true, force: true });
    }
    if (!findLocalModelCatalogEntry(catalogId)) {
      const removed = await this.toView({
        ...model,
        status: "not_downloaded",
        managedPath: null,
        installedSizeBytes: 0,
        lastError: null
      });
      await repository.deleteModel(model.id);
      return { ...removed, download: null };
    }
    const next = await repository.updateModel(model.id, {
      status: "not_downloaded", managedPath: null, installedSizeBytes: 0, lastError: null
    });
    return this.toView(next);
  }

  public async test(catalogId: string): Promise<string> {
    const model = await this.requireCatalogModel(catalogId);
    if (model.status !== "ready" || !model.managedPath) throw new Error("errors.localModels.notReady");
    if (!this.options.testModel) throw new Error("errors.localModels.runtimeUnavailable");
    return this.options.testModel(model.id);
  }

  public async setDefaults(localModelId: string, defaultParameters: AiModelParameters): Promise<LocalModelView> {
    const repository = createLocalModelRepository(this.requirePool());
    const model = await repository.findById(localModelId);
    if (!model) throw new Error("errors.localModels.notFound");
    return this.toView(await repository.updateModel(model.id, { defaultParameters }));
  }

  public async setRepositoryToken(token: string): Promise<boolean> {
    const settings = createSettingsRepository(this.requirePool());
    const current = await settings.get<string>(repositoryTokenSettingKey);
    const reference = await this.credentials.save(token, current);
    await settings.set(repositoryTokenSettingKey, reference);
    return true;
  }

  public async hasRepositoryToken(): Promise<boolean> {
    return Boolean(await createSettingsRepository(this.requirePool()).get<string>(repositoryTokenSettingKey));
  }

  public async importGguf(sourcePath: string): Promise<LocalModelView> {
    if (extname(sourcePath).toLowerCase() !== ".gguf") throw new Error("errors.localModels.invalidGguf");
    const source = await stat(sourcePath);
    if (!source.isFile() || source.size <= 0) throw new Error("errors.localModels.invalidGguf");
    const checksum = await sha256File(sourcePath);
    const catalogId = `gguf-${checksum.slice(0, 24)}`;
    const modelPath = resolveManagedModelPath(this.modelsRoot, catalogId);
    const temporaryPath = join(modelPath, "model.gguf.partial");
    const finalPath = join(modelPath, "model.gguf");
    await mkdir(modelPath, { recursive: true });
    await copyFile(sourcePath, temporaryPath);
    if (await sha256File(temporaryPath) !== checksum) {
      await rm(temporaryPath, { force: true });
      throw new Error("errors.localModels.checksumMismatch");
    }
    await rename(temporaryPath, finalPath);
    const repository = createLocalModelRepository(this.requirePool());
    const record = await repository.upsertModel({
      catalogId,
      modelId: basename(sourcePath),
      displayName: basename(sourcePath, extname(sourcePath)),
      family: "GGUF",
      variant: "Imported",
      repository: "local-import",
      revision: checksum,
      runtime: "gguf",
      format: "gguf",
      quantization: "unknown",
      expectedSizeBytes: source.size,
      manifestHash: checksum,
      capabilities: ["text-generation", "structured-output", "summarization", "knowledge-graph-generation", "atomic-note-generation", "cancellation", "offline", "local-files"],
      defaultParameters: { contextWindow: 4_096, temperature: 0.2, maxTokens: 1_024 },
      licenseName: "User supplied",
      licenseUrl: "https://github.com/ggml-org/ggml/blob/master/docs/gguf.md",
      metadata: { minimumMemoryBytes: source.size, recommendedMemoryBytes: Math.ceil(source.size * 1.5) }
    });
    await repository.replaceFiles(record.id, [{ path: "model.gguf", sizeBytes: source.size, sha256: checksum }]);
    return this.toView(await repository.updateModel(record.id, {
      status: "ready", managedPath: finalPath, installedSizeBytes: source.size, lastError: null
    }));
  }

  private async syncCatalog(): Promise<void> {
    const repository = createLocalModelRepository(this.requirePool());
    for (const entry of localModelCatalog) {
      const record = await repository.upsertModel({
        catalogId: entry.id,
        modelId: entry.repository,
        displayName: entry.displayName,
        family: entry.family,
        variant: entry.variant,
        repository: entry.repository,
        revision: entry.revision,
        runtime: entry.runtime,
        format: entry.format,
        quantization: entry.quantization,
        expectedSizeBytes: localModelExpectedSize(entry),
        manifestHash: localModelManifestHash(entry),
        capabilities: entry.capabilities,
        defaultParameters: entry.defaultParameters,
        licenseName: entry.license,
        licenseUrl: entry.licenseUrl,
        metadata: {
          catalogVersion: localModelCatalogVersion,
          defaultParametersInitialized: true,
          minimumMemoryBytes: entry.minimumMemoryBytes,
          recommendedMemoryBytes: entry.recommendedMemoryBytes,
          requiresLicenseAcceptance: entry.requiresLicenseAcceptance
        }
      });
      const files = await repository.listFiles(record.id);
      if (files.length !== entry.files.length || entry.files.some((file) => {
        const existing = files.find((candidate) => candidate.relativePath === file.path);
        return !existing || existing.expectedSizeBytes !== file.sizeBytes || existing.sha256 !== file.sha256;
      })) {
        await repository.replaceFiles(record.id, entry.files.map((file) => ({ path: file.path, sizeBytes: file.sizeBytes, sha256: file.sha256 })));
      }
    }
  }

  private async createDownload(model: LocalModelRecord): Promise<void> {
    const jobs = createJobRepository(this.requirePool());
    const job = await jobs.create({
      type: "local-model-download",
      payload: { localModelId: model.id, catalogId: model.catalogId },
      maxAttempts: 3
    });
    await createLocalModelRepository(this.requirePool()).createDownload({
      localModelId: model.id,
      jobId: job.id,
      totalBytes: model.expectedSizeBytes
    });
  }

  private schedule(catalogId: string): void {
    if (this.stopped || this.activeCatalogId === catalogId || this.queue.includes(catalogId)) return;
    this.queue.push(catalogId);
    this.startPump();
  }

  private startPump(): void {
    if (this.stopped || this.pumpPromise) return;
    this.pumpPromise = this.pump()
      .catch((error: unknown) => this.options.logger?.error(redactSensitiveText(error)))
      .finally(() => {
        this.pumpPromise = null;
        if (!this.stopped && this.queue.length > 0) this.startPump();
      });
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.activeCatalogId !== null) return;
    const catalogId = this.queue.shift();
    if (!catalogId) return;
    this.activeCatalogId = catalogId;
    try {
      await this.executeDownload(catalogId);
    } finally {
      this.activeCatalogId = null;
    }
  }

  private async executeDownload(catalogId: string): Promise<void> {
    const entry = requiredCatalogEntry(catalogId);
    const repository = createLocalModelRepository(this.requirePool());
    const model = await this.requireCatalogModel(catalogId);
    const download = await repository.latestDownload(model.id);
    if (!download) return;
    const jobs = createJobRepository(this.requirePool());
    const job = await jobs.findById(download.jobId);
    if (!job || job.status === "canceled") return;
    const controller = new AbortController();
    this.controllers.set(catalogId, controller);
    await jobs.update(job.id, {
      status: "running", attempts: job.attempts + 1, lockedAt: new Date(),
      lockedBy: `local-model-service:${process.pid}`, finishedAt: null
    });
    await repository.updateDownload(job.id, { startedAt: new Date(), error: null });
    try {
      const token = await this.getRepositoryToken();
      const result = await downloadLocalModel({
        entry,
        destinationRoot: this.modelsRoot,
        ...(token ? { token } : {}),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        signal: controller.signal,
        onProgress: async (progress) => {
          await Promise.all([
            repository.updateDownload(job.id, {
              currentFile: progress.currentFile,
              downloadedBytes: progress.downloadedBytes,
              bytesPerSecond: Math.round(progress.bytesPerSecond),
              etaSeconds: progress.etaSeconds,
              checkpoint: { currentFile: progress.currentFile, fileBytes: progress.currentFileBytes }
            }),
            repository.updateFileProgress(
              model.id,
              progress.currentFile,
              progress.currentFileBytes,
              progress.currentFileBytes === progress.currentFileSizeBytes ? "ready" : "downloading"
            ),
            jobs.reportProgress(job.id, progress.totalBytes === 0 ? 0 : progress.downloadedBytes / progress.totalBytes)
          ]);
        }
      });
      await repository.updateModel(model.id, { status: "verifying" });
      if (!await verifyLocalModelFiles(entry, result.modelPath)) throw new Error("errors.localModels.checksumMismatch");
      await repository.updateModel(model.id, {
        status: "ready", managedPath: result.modelPath, installedSizeBytes: result.sizeBytes, lastError: null
      });
      await repository.updateDownload(job.id, {
        currentFile: null, downloadedBytes: result.sizeBytes, bytesPerSecond: 0,
        etaSeconds: 0, completedAt: new Date(), error: null
      });
      await jobs.update(job.id, {
        status: "succeeded", progress: 1, result: { localModelId: model.id }, error: null,
        lockedAt: null, lockedBy: null, finishedAt: new Date()
      });
    } catch (error) {
      const canceled = controller.signal.aborted;
      const message = canceled ? "errors.localModels.canceled" : redactSensitiveText(error);
      await repository.updateModel(model.id, { status: "failed", lastError: message });
      await repository.updateDownload(job.id, { error: message, bytesPerSecond: 0, etaSeconds: null });
      await jobs.update(job.id, {
        status: canceled ? "canceled" : "failed", error: canceled ? null : message,
        lockedAt: null, lockedBy: null, finishedAt: new Date()
      });
      if (!canceled) this.options.logger?.warn(message);
    } finally {
      this.controllers.delete(catalogId);
    }
  }

  private async toView(model: LocalModelRecord): Promise<LocalModelView> {
    const entry = findLocalModelCatalogEntry(model.catalogId);
    const minimumMemoryBytes = entry?.minimumMemoryBytes ?? numericMetadata(model, "minimumMemoryBytes", model.expectedSizeBytes);
    const recommendedMemoryBytes = entry?.recommendedMemoryBytes ?? numericMetadata(model, "recommendedMemoryBytes", model.expectedSizeBytes);
    const compatibility = detectLocalRuntimeCompatibility({
      runtime: model.runtime,
      totalMemoryBytes: totalmem(),
      minimumMemoryBytes
    });
    const repository = createLocalModelRepository(this.requirePool());
    const [download, profilesUsing] = await Promise.all([
      repository.latestDownload(model.id),
      repository.profilesUsing(model.id)
    ]);
    return {
      id: model.id,
      catalogId: model.catalogId,
      modelId: model.modelId,
      displayName: model.displayName,
      family: model.family,
      variant: model.variant,
      repository: model.repository,
      revision: model.revision,
      runtime: model.runtime,
      format: model.format,
      quantization: model.quantization,
      capabilities: model.capabilities as LocalModelView["capabilities"],
      defaultParameters: aiModelParametersSchema.parse(model.defaultParameters),
      minimumMemoryBytes,
      recommendedMemoryBytes,
      expectedSizeBytes: model.expectedSizeBytes,
      installedSizeBytes: model.installedSizeBytes,
      licenseName: model.licenseName,
      licenseUrl: model.licenseUrl,
      requiresLicenseAcceptance: entry?.requiresLicenseAcceptance ?? false,
      licenseAccepted: Boolean(model.licenseAcceptedAt),
      status: model.status,
      compatible: compatibility.compatible,
      compatibilityReason: compatibility.reason,
      profilesUsing,
      lastError: model.lastError,
      download: download ? {
        jobId: download.jobId,
        currentFile: download.currentFile,
        downloadedBytes: download.downloadedBytes,
        totalBytes: download.totalBytes,
        bytesPerSecond: download.bytesPerSecond,
        etaSeconds: download.etaSeconds
      } : null
    };
  }

  private async requireCatalogModel(catalogId: string): Promise<LocalModelRecord> {
    await this.syncCatalog();
    const model = await createLocalModelRepository(this.requirePool()).findByCatalogId(catalogId);
    if (!model) throw new Error("errors.localModels.notFound");
    return model;
  }

  private async getRepositoryToken(): Promise<string | undefined> {
    const reference = await createSettingsRepository(this.requirePool()).get<string>(repositoryTokenSettingKey);
    return reference ? this.credentials.get(reference) : undefined;
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

function compatibilityFor(entry: LocalModelCatalogEntry) {
  return detectLocalRuntimeCompatibility({
    runtime: entry.runtime,
    totalMemoryBytes: totalmem(),
    minimumMemoryBytes: entry.minimumMemoryBytes
  });
}

function requiredCatalogEntry(catalogId: string): LocalModelCatalogEntry {
  const entry = findLocalModelCatalogEntry(catalogId);
  if (!entry) throw new Error("errors.localModels.notFound");
  return entry;
}

function numericMetadata(model: LocalModelRecord, key: string, fallback: number): number {
  const value = model.metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
