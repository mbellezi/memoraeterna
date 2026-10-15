import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { totalmem } from "node:os";
import { basename, extname, join, relative } from "node:path";

import {
  decideValidationForCatalogEntry,
  detectLocalRuntimeCompatibility,
  downloadLocalModel,
  findLocalModelCatalogEntry,
  isRankerCatalogEntry,
  localModelCatalog,
  localModelCatalogVersion,
  localModelExpectedSize,
  localModelManifestHash,
  localParameterCapabilities,
  redactSensitiveText,
  resolveLocalModelSeedRoot,
  resolveManagedModelPath,
  sha256File,
  validateCatalogRankerArtifact,
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
import { normalizeAiModelParameters } from "@app/domain";
import { aiModelParametersSchema } from "../../shared/ipc.js";
import type {
  AiModelParameters,
  LocalModelDownloadInput,
  LocalModelView
} from "../../shared/ipc.js";

import { CredentialService } from "./credential-service.js";

export interface LocalModelServiceOptions {
  getPool: () => PgPool | null;
  userDataPath: string;
  fetch?: typeof fetch;
  logger?: Pick<Console, "warn" | "error">;
  isModelInUse?: (localModelId: string) => boolean;
  testModel?: (localModelId: string) => Promise<string>;
  /**
   * Whether this is a packaged build. A missing value counts as packaged, so a service built
   * without it never reads a DEV seed folder.
   */
  isPackaged?: boolean;
  /** Base of a relative `MEMORA_LOCAL_MODEL_SEED_DIR`; defaults to the working directory. */
  workspaceRoot?: string;
  /** Environment the DEV seed folder is read from; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

const repositoryTokenSettingKey = "local-models.repository-token-ref";

export class LocalModelService {
  private readonly credentials: CredentialService;
  private readonly modelsRoot: string;
  private readonly controllers = new Map<string, AbortController>();
  /** DEV only: a folder of already downloaded artifacts that stands in for the network. */
  private readonly seedRoot: string | null;
  private syncing: Promise<void> = Promise.resolve();
  private readonly queue: string[] = [];
  private activeCatalogId: string | null = null;
  private pumpPromise: Promise<void> | null = null;
  private stopped = false;

  public constructor(private readonly options: LocalModelServiceOptions) {
    this.credentials = new CredentialService(options.userDataPath);
    this.modelsRoot = join(options.userDataPath, "local-models");
    this.seedRoot = resolveSeedRoot(options);
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
        status: "queued",
        lockedAt: null,
        lockedBy: null,
        finishedAt: null,
        cancelRequestedAt: null
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

  /** Readiness only: unlike `list`, this never writes, so a screen can ask on every activation. */
  public async listStatuses(): Promise<Array<Pick<LocalModelView, "id" | "status">>> {
    const models = await createLocalModelRepository(this.requirePool()).listModels();
    return models.map((model) => ({ id: model.id, status: model.status }));
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
    let model = await this.requireCatalogModel(entry.id);
    model = await this.initializeRecommendedDefaults(model, entry);
    if (entry.requiresLicenseAcceptance && !model.licenseAcceptedAt && !input.acceptLicense) {
      throw new Error("errors.localModels.licenseRequired");
    }
    if (model.status === "ready") return this.toView(model);
    if (input.acceptLicense && !model.licenseAcceptedAt) {
      await repository.updateModel(model.id, { licenseAcceptedAt: new Date() });
    }
    const latest = await repository.latestDownload(model.id);
    if (
      !latest ||
      !["queued", "running"].includes(
        (await createJobRepository(this.requirePool()).findById(latest.jobId))?.status ?? ""
      )
    ) {
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
    const next = await repository.updateModel(model.id, {
      status: "failed",
      lastError: "errors.localModels.canceled"
    });
    return this.toView(next);
  }

  public async resume(catalogId: string): Promise<LocalModelView> {
    const entry = requiredCatalogEntry(catalogId);
    const model = await this.initializeRecommendedDefaults(
      await this.requireCatalogModel(catalogId),
      entry
    );
    const repository = createLocalModelRepository(this.requirePool());
    const latest = await repository.latestDownload(model.id);
    const jobs = createJobRepository(this.requirePool());
    const previousJob = latest ? await jobs.findById(latest.jobId) : null;
    if (!latest || !previousJob || previousJob.attempts >= previousJob.maxAttempts) {
      await this.createDownload(model);
    } else {
      await jobs.update(previousJob.id, {
        status: "queued",
        error: null,
        progress: 0,
        runAfter: new Date(),
        lockedAt: null,
        lockedBy: null,
        finishedAt: null,
        cancelRequestedAt: null
      });
    }
    const next = await repository.updateModel(model.id, { status: "downloading", lastError: null });
    this.schedule(catalogId);
    return this.toView(next);
  }

  public async remove(catalogId: string): Promise<LocalModelView> {
    const repository = createLocalModelRepository(this.requirePool());
    const model = await this.requireCatalogModel(catalogId);
    if (this.controllers.has(catalogId) || this.queue.includes(catalogId))
      throw new Error("errors.localModels.modelBusy");
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
    await repository.updateModel(model.id, {
      status: "not_downloaded",
      managedPath: null,
      installedSizeBytes: 0,
      lastError: null
    });
    // A removed ranker is no longer validated: the sync closes its `reranking` capability.
    await this.syncCatalog();
    return this.toView((await repository.findById(model.id))!);
  }

  public async test(catalogId: string): Promise<string> {
    const model = await this.requireCatalogModel(catalogId);
    if (model.status !== "ready" || !model.managedPath)
      throw new Error("errors.localModels.notReady");
    if (!this.options.testModel) throw new Error("errors.localModels.runtimeUnavailable");
    const entry = findLocalModelCatalogEntry(catalogId);
    try {
      return await this.options.testModel(model.id);
    } finally {
      // A ranker's test records or voids its decide validation, which the sync turns into the
      // `reranking` capability (or takes it away).
      if (entry && isRankerCatalogEntry(entry)) await this.syncCatalog();
    }
  }

  public async setDefaults(
    localModelId: string,
    defaultParameters: AiModelParameters
  ): Promise<LocalModelView> {
    const repository = createLocalModelRepository(this.requirePool());
    const model = await repository.findById(localModelId);
    if (!model) throw new Error("errors.localModels.notFound");
    const parameterCapabilities =
      findLocalModelCatalogEntry(model.catalogId)?.parameterCapabilities ??
      localParameterCapabilities({
        runtime: model.runtime,
        modelId: model.modelId,
        catalogId: model.catalogId,
        capabilities: model.capabilities as LocalModelView["capabilities"]
      });
    const normalized = normalizeAiModelParameters(
      aiModelParametersSchema.parse(defaultParameters),
      parameterCapabilities
    );
    return this.toView(await repository.updateModel(model.id, { defaultParameters: normalized }));
  }

  public async setRepositoryToken(token: string): Promise<boolean> {
    const settings = createSettingsRepository(this.requirePool());
    const current = await settings.get<string>(repositoryTokenSettingKey);
    const reference = await this.credentials.save(token, current);
    await settings.set(repositoryTokenSettingKey, reference);
    return true;
  }

  public async hasRepositoryToken(): Promise<boolean> {
    return Boolean(
      await createSettingsRepository(this.requirePool()).get<string>(repositoryTokenSettingKey)
    );
  }

  public async importGguf(sourcePath: string): Promise<LocalModelView> {
    if (extname(sourcePath).toLowerCase() !== ".gguf")
      throw new Error("errors.localModels.invalidGguf");
    const source = await stat(sourcePath);
    if (!source.isFile() || source.size <= 0) throw new Error("errors.localModels.invalidGguf");
    const checksum = await sha256File(sourcePath);
    const catalogId = `gguf-${checksum.slice(0, 24)}`;
    const modelPath = resolveManagedModelPath(this.modelsRoot, catalogId);
    const temporaryPath = join(modelPath, "model.gguf.partial");
    const finalPath = join(modelPath, "model.gguf");
    await mkdir(modelPath, { recursive: true });
    await copyFile(sourcePath, temporaryPath);
    if ((await sha256File(temporaryPath)) !== checksum) {
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
      capabilities: [
        "text-generation",
        "structured-output",
        "summarization",
        "knowledge-graph-generation",
        "atomic-note-generation",
        "cancellation",
        "offline",
        "local-files"
      ],
      defaultParameters: { contextWindow: 4_096, temperature: 0.2, maxTokens: 1_024 },
      licenseName: "User supplied",
      licenseUrl: "https://github.com/ggml-org/ggml/blob/master/docs/gguf.md",
      metadata: {
        minimumMemoryBytes: source.size,
        recommendedMemoryBytes: Math.ceil(source.size * 1.5)
      }
    });
    await repository.replaceFiles(record.id, [
      { path: "model.gguf", sizeBytes: source.size, sha256: checksum }
    ]);
    return this.toView(
      await repository.updateModel(record.id, {
        status: "ready",
        managedPath: finalPath,
        installedSizeBytes: source.size,
        lastError: null
      })
    );
  }

  /** Catalog synchronizations run one after another: each rewrites the rows it reads. */
  private syncCatalog(): Promise<void> {
    const run = this.syncing.then(
      () => this.synchronizeCatalog(),
      () => this.synchronizeCatalog()
    );
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async synchronizeCatalog(): Promise<void> {
    const repository = createLocalModelRepository(this.requirePool());
    for (const entry of localModelCatalog) {
      // A ranker's `reranking` capability is exposed only while its decide validation names this
      // revision and artifact on an installed model (STACK.md, rules/ai.md). A revision or
      // artifact change, or a removal, takes the validation, and the capability, away. The row is
      // read right before its write, because the model test stores a validation in it meanwhile.
      const existing = isRankerCatalogEntry(entry)
        ? await repository.findByCatalogId(entry.id)
        : null;
      const decideValidation =
        existing?.status === "ready"
          ? decideValidationForCatalogEntry(existing.metadata.decideValidation, entry)
          : null;
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
        capabilities: exposedCapabilities(entry, decideValidation !== null),
        defaultParameters: entry.defaultParameters,
        licenseName: entry.license,
        licenseUrl: entry.licenseUrl,
        metadata: {
          catalogVersion: localModelCatalogVersion,
          defaultParametersInitialized: true,
          minimumMemoryBytes: entry.minimumMemoryBytes,
          recommendedMemoryBytes: entry.recommendedMemoryBytes,
          requiresLicenseAcceptance: entry.requiresLicenseAcceptance,
          ...(decideValidation ? { decideValidation } : {})
        }
      });
      const files = await repository.listFiles(record.id);
      if (
        files.length !== entry.files.length ||
        entry.files.some((file) => {
          const existing = files.find((candidate) => candidate.relativePath === file.path);
          return (
            !existing ||
            existing.expectedSizeBytes !== file.sizeBytes ||
            existing.sha256 !== file.sha256
          );
        })
      ) {
        await repository.replaceFiles(
          record.id,
          entry.files.map((file) => ({
            path: file.path,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256
          }))
        );
      }
    }
  }

  private async initializeRecommendedDefaults(
    model: LocalModelRecord,
    entry: LocalModelCatalogEntry
  ): Promise<LocalModelRecord> {
    if (
      Object.keys(model.defaultParameters).length > 0 ||
      Object.keys(entry.defaultParameters).length === 0
    ) {
      return model;
    }
    return createLocalModelRepository(this.requirePool()).updateModel(model.id, {
      defaultParameters: entry.defaultParameters
    });
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
    if (this.stopped || this.activeCatalogId === catalogId || this.queue.includes(catalogId))
      return;
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
    let installed = false;
    await jobs.update(job.id, {
      status: "running",
      attempts: job.attempts + 1,
      lockedAt: new Date(),
      lockedBy: `local-model-service:${process.pid}`,
      finishedAt: null
    });
    await repository.updateDownload(job.id, { startedAt: new Date(), error: null });
    try {
      const token = await this.getRepositoryToken();
      const result = await downloadLocalModel({
        entry,
        destinationRoot: this.modelsRoot,
        ...(this.seedRoot ? { seedRoot: this.seedRoot } : {}),
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
              checkpoint: {
                currentFile: progress.currentFile,
                fileBytes: progress.currentFileBytes
              }
            }),
            repository.updateFileProgress(
              model.id,
              progress.currentFile,
              progress.currentFileBytes,
              progress.currentFileBytes === progress.currentFileSizeBytes ? "ready" : "downloading"
            ),
            jobs.reportProgress(
              job.id,
              progress.totalBytes === 0 ? 0 : progress.downloadedBytes / progress.totalBytes
            )
          ]);
        }
      });
      await repository.updateModel(model.id, { status: "verifying" });
      if (!(await verifyLocalModelFiles(entry, result.modelPath)))
        throw new Error("errors.localModels.checksumMismatch");
      // A dedicated ranker must also be a supported Qwen3 ranker before it counts as installed.
      if (isRankerCatalogEntry(entry)) await validateCatalogRankerArtifact(entry, result.modelPath);
      await repository.updateModel(model.id, {
        status: "ready",
        managedPath: result.modelPath,
        installedSizeBytes: result.sizeBytes,
        lastError: null
      });
      await repository.updateDownload(job.id, {
        currentFile: null,
        downloadedBytes: result.sizeBytes,
        bytesPerSecond: 0,
        etaSeconds: 0,
        completedAt: new Date(),
        error: null
      });
      await jobs.update(job.id, {
        status: "succeeded",
        progress: 1,
        result: { localModelId: model.id },
        error: null,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date()
      });
      installed = true;
    } catch (error) {
      const canceled = controller.signal.aborted;
      const message = canceled ? "errors.localModels.canceled" : redactSensitiveText(error);
      await repository.updateModel(model.id, { status: "failed", lastError: message });
      await repository.updateDownload(job.id, {
        error: message,
        bytesPerSecond: 0,
        etaSeconds: null
      });
      await jobs.update(job.id, {
        status: canceled ? "canceled" : "failed",
        error: canceled ? null : message,
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date()
      });
      if (!canceled) this.options.logger?.warn(message);
    } finally {
      this.controllers.delete(catalogId);
    }
    if (installed && isRankerCatalogEntry(entry)) await this.validateInstalledRanker(model.id);
  }

  /**
   * A freshly installed ranker is validated for `decide` right away: the artifact checks ran with
   * the install, and the smoke test follows through the model test. The install stays; a ranker that
   * fails (or cannot be tested now, for instance while another local model runs) is left without
   * `reranking`, and the failure shows on the model until a later test passes.
   */
  private async validateInstalledRanker(localModelId: string): Promise<void> {
    if (this.stopped || !this.options.testModel) return;
    try {
      await this.options.testModel(localModelId);
    } catch (error) {
      this.options.logger?.warn(redactSensitiveText(error));
    }
    try {
      await this.syncCatalog();
    } catch (error) {
      this.options.logger?.warn(redactSensitiveText(error));
    }
  }

  private async toView(model: LocalModelRecord): Promise<LocalModelView> {
    const entry = findLocalModelCatalogEntry(model.catalogId);
    const parameterCapabilities =
      entry?.parameterCapabilities ??
      localParameterCapabilities({
        runtime: model.runtime,
        modelId: model.modelId,
        catalogId: model.catalogId,
        capabilities: model.capabilities as LocalModelView["capabilities"]
      });
    const minimumMemoryBytes =
      entry?.minimumMemoryBytes ??
      numericMetadata(model, "minimumMemoryBytes", model.expectedSizeBytes);
    const recommendedMemoryBytes =
      entry?.recommendedMemoryBytes ??
      numericMetadata(model, "recommendedMemoryBytes", model.expectedSizeBytes);
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
      parameterCapabilities,
      defaultParameters: normalizeAiModelParameters(
        aiModelParametersSchema.parse(model.defaultParameters),
        parameterCapabilities
      ),
      recommendedParameters: entry?.recommendedParameters
        ? {
            ...(entry.recommendedParameters.reasoning
              ? {
                  reasoning: normalizeAiModelParameters(
                    entry.recommendedParameters.reasoning,
                    parameterCapabilities
                  )
                }
              : {}),
            ...(entry.recommendedParameters.nonReasoning
              ? {
                  nonReasoning: normalizeAiModelParameters(
                    entry.recommendedParameters.nonReasoning,
                    parameterCapabilities
                  )
                }
              : {})
          }
        : null,
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
      download: download
        ? {
            jobId: download.jobId,
            currentFile: download.currentFile,
            downloadedBytes: download.downloadedBytes,
            totalBytes: download.totalBytes,
            bytesPerSecond: download.bytesPerSecond,
            etaSeconds: download.etaSeconds
          }
        : null
    };
  }

  private async requireCatalogModel(catalogId: string): Promise<LocalModelRecord> {
    await this.syncCatalog();
    const model = await createLocalModelRepository(this.requirePool()).findByCatalogId(catalogId);
    if (!model) throw new Error("errors.localModels.notFound");
    return model;
  }

  private async getRepositoryToken(): Promise<string | undefined> {
    const reference = await createSettingsRepository(this.requirePool()).get<string>(
      repositoryTokenSettingKey
    );
    return reference ? this.credentials.get(reference) : undefined;
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

/**
 * The capabilities a catalog install exposes. A dedicated ranker declares `reranking`, and keeps it
 * only while it is validated for `decide`; before that it exposes no task at all.
 */
function exposedCapabilities(entry: LocalModelCatalogEntry, validated: boolean): string[] {
  return isRankerCatalogEntry(entry) && !validated
    ? entry.capabilities.filter((capability) => capability !== "reranking")
    : [...entry.capabilities];
}

/** The DEV seed folder, or null when seeding is off, refused (packaged) or misconfigured. */
function resolveSeedRoot(options: LocalModelServiceOptions): string | null {
  try {
    return resolveLocalModelSeedRoot(options.env ?? process.env, {
      isPackaged: options.isPackaged ?? true,
      baseDirectory: options.workspaceRoot ?? process.cwd()
    });
  } catch (error) {
    options.logger?.warn(redactSensitiveText(error));
    return null;
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
