import { sha256 } from "@app/conversion";
import {
  AiModelRegistry,
  GoogleGeminiAdapter,
  MlxAdapter,
  NodeLlamaCppAdapter,
  OpenAiCompatibleAdapter,
  redactSensitiveText,
  type AiModelAdapter,
  type AiTaskRequest,
  type AiTaskResult
} from "@app/ai";
import {
  createAiConfigRepository,
  createLocalModelRepository,
  type AiProfileRecord,
  type AiProviderConfigRecord,
  type PgPool
} from "@app/db";
import { AiCapabilitySchema, type AiCapability } from "@app/domain";
import type {
  AiProfile,
  AiProfileCreate,
  AiProfileTaskInput,
  AiProviderConfig,
  AiProviderConfigInput
} from "../../shared/ipc.js";

import { CredentialService } from "./credential-service.js";
import { join } from "node:path";

export interface AiServiceOptions {
  userDataPath: string;
  getPool: () => PgPool | null;
  workspaceRoot: string;
  resourcesPath: string;
  isPackaged: boolean;
}

export class AiService {
  private readonly credentials: CredentialService;
  private readonly activeLocalModels = new Set<string>();
  private readonly registry = new AiModelRegistry();

  public constructor(private readonly options: AiServiceOptions) {
    this.credentials = new CredentialService(options.userDataPath);
  }

  public async listProviders(): Promise<AiProviderConfig[]> {
    return (await createAiConfigRepository(this.requirePool()).listProviders()).map(mapProvider);
  }

  public async saveProvider(input: AiProviderConfigInput): Promise<AiProviderConfig> {
    const repository = createAiConfigRepository(this.requirePool());
    const existing = input.id ? (await repository.listProviders()).find((provider) => provider.id === input.id) : undefined;
    const credentialRef = input.apiKey
      ? await this.credentials.save(input.apiKey, existing?.credentialRef)
      : existing?.credentialRef ?? null;
    const record = await repository.upsertProvider({
      ...(input.id ? { id: input.id } : {}), provider: input.provider, displayName: input.displayName,
      credentialRef, baseUrl: input.baseUrl ?? defaultBaseUrl(input.provider),
      metadata: { modelId: input.modelId, capabilities: input.capabilities }
    });
    return mapProvider(record);
  }

  public async testProvider(providerId: string): Promise<boolean> {
    const adapter = await this.createAdapter(providerId);
    await adapter.testConnection?.();
    return true;
  }

  public async listModels(providerId: string): Promise<string[]> {
    const adapter = await this.createAdapter(providerId);
    return (await adapter.listModels?.() ?? []).map((model) => model.modelId);
  }

  public async listProfiles(): Promise<AiProfile[]> {
    return (await createAiConfigRepository(this.requirePool()).listProfiles()).map(mapProfile);
  }

  public async createProfile(input: AiProfileCreate): Promise<AiProfile> {
    return mapProfile(await createAiConfigRepository(this.requirePool()).createProfile({
      name: input.name,
      isDefault: input.isDefault,
      privacyMode: input.privacyMode,
      ...(input.description !== undefined ? { description: input.description } : {})
    }));
  }

  public async cloneProfile(profileId: string, name: string): Promise<AiProfile> {
    return mapProfile(await createAiConfigRepository(this.requirePool()).cloneProfile(profileId, name));
  }

  public async setProfileTask(input: AiProfileTaskInput): Promise<void> {
    const repository = createAiConfigRepository(this.requirePool());
    const profile = (await repository.listProfiles()).find((candidate) => candidate.id === input.profileId);
    if (!profile) throw new Error("errors.common.notFound");
    if (input.localModelId) {
      const localModel = await createLocalModelRepository(this.requirePool()).findById(input.localModelId);
      if (!localModel || localModel.status !== "ready") throw new Error("errors.localModels.notReady");
      if (localModel.runtime !== input.runtime || localModel.modelId !== input.modelId
          || !input.requiredCapabilities.every((capability) => localModel.capabilities.includes(capability))) {
        throw new Error("errors.ai.noCompatibleModel");
      }
    } else {
      if (profile.privacyMode === "offline_only") throw new Error("errors.ai.noCompatibleModel");
      const provider = (await repository.listProviders()).find((candidate) => candidate.id === input.providerConfigId);
      const capabilities = parseCapabilities(provider?.metadata.capabilities);
      if (!provider || provider.metadata.modelId !== input.modelId
          || !input.requiredCapabilities.every((capability) => capabilities.includes(capability))) {
        throw new Error("errors.ai.noCompatibleModel");
      }
    }
    await repository.setProfileTask({
      profileId: input.profileId,
      task: input.task,
      modelId: input.modelId,
      requiredCapabilities: input.requiredCapabilities,
      ...(input.providerConfigId !== undefined ? { providerConfigId: input.providerConfigId } : {}),
      ...(input.localModelId !== undefined ? { localModelId: input.localModelId } : {}),
      runtime: input.runtime,
      fallbackPolicy: "block",
      parameters: input.task === "embedding" ? { dimensions: 768 } : {}
    });
  }

  public async runDefaultTask(
    taskType: "embedding" | "summarization" | "atomic-note-generation" | "reranking",
    input: string
  ): Promise<DefaultAiTaskResult | null> {
    const repository = createAiConfigRepository(this.requirePool());
    const selection = await repository.getDefaultTask(taskType);
    if (!selection) return null;
    const configuredAdapter = selection.localModelId
      ? await this.createLocalAdapter(selection.localModelId)
      : await this.createAdapter(selection.providerConfigId ?? "");
    const requiredCapabilities = capabilitiesForTask(taskType);
    const descriptor = configuredAdapter.describe();
    const adapter = this.registry.resolve({
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      requiredCapabilities,
      offlineOnly: Boolean(selection.localModelId)
    });
    const started = Date.now();
    try {
      const run = () => adapter.run({
        taskType, input, profileId: selection.profileId, modelId: selection.modelId,
        requiredCapabilities, parameters: selection.parameters, metadata: {}
      });
      const result = selection.localModelId
        ? await this.withLocalModelUsage(selection.localModelId, run)
        : await run();
      const aiTaskRunId = await repository.recordTaskRun({
        profileId: selection.profileId, taskType, provider: result.providerId, modelId: result.modelId,
        runtime: selection.localModelId ? selection.runtime : result.runtime,
        capabilitiesUsed: requiredCapabilities,
        adapter: selection.localModelId ? localAdapterName(selection.runtime) : result.providerId,
        repository: selection.repository,
        revision: selection.revision,
        quantization: selection.quantization,
        parameters: selection.parameters,
        inputHash: sha256(input), outputHash: sha256(JSON.stringify(result.output)),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {}),
        durationMs: result.durationMs, status: "succeeded"
      });
      return { ...result, profileId: selection.profileId, aiTaskRunId };
    } catch (error) {
      await repository.recordTaskRun({
        profileId: selection.profileId, taskType, provider: selection.provider,
        modelId: selection.modelId, runtime: selection.runtime,
        adapter: selection.localModelId ? localAdapterName(selection.runtime) : selection.provider,
        repository: selection.repository,
        revision: selection.revision,
        quantization: selection.quantization,
        parameters: selection.parameters,
        durationMs: Date.now() - started, status: "failed",
        error: redactSensitiveText(error).slice(0, 500)
      });
      throw error;
    }
  }

  public isLocalModelInUse(localModelId: string): boolean {
    return this.activeLocalModels.has(localModelId);
  }

  public async testLocalModel(localModelId: string): Promise<string> {
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model) throw new Error("errors.common.notFound");
    const configuredAdapter = await this.createLocalAdapter(localModelId);
    const descriptor = configuredAdapter.describe();
    const adapter = this.registry.resolve({
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      requiredCapabilities: ["text-generation"],
      offlineOnly: true
    });
    const repository = createAiConfigRepository(this.requirePool());
    const input = "Reply with exactly: OK";
    const parameters = { maxTokens: 16, temperature: 0 };
    const started = Date.now();
    try {
      const result = await this.withLocalModelUsage(localModelId, () => adapter.run({
        taskType: "text-generation",
        input,
        modelId: adapter.describe().modelId,
        requiredCapabilities: ["text-generation"],
        parameters,
        metadata: { purpose: "local-model-test" }
      }));
      await repository.recordTaskRun({
        taskType: "text-generation",
        provider: result.providerId,
        modelId: result.modelId,
        runtime: model.runtime,
        adapter: localAdapterName(model.runtime),
        repository: model.repository,
        revision: model.revision,
        quantization: model.quantization,
        capabilitiesUsed: ["text-generation", "offline"],
        parameters,
        inputHash: sha256(input),
        outputHash: sha256(JSON.stringify(result.output)),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        costEstimate: 0,
        durationMs: result.durationMs,
        status: "succeeded"
      });
      return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    } catch (error) {
      await repository.recordTaskRun({
        taskType: "text-generation",
        provider: `local-${model.runtime}`,
        modelId: model.modelId,
        runtime: model.runtime,
        adapter: localAdapterName(model.runtime),
        repository: model.repository,
        revision: model.revision,
        quantization: model.quantization,
        capabilitiesUsed: ["text-generation", "offline"],
        parameters,
        inputHash: sha256(input),
        durationMs: Date.now() - started,
        status: "failed",
        error: redactSensitiveText(error).slice(0, 500)
      });
      throw error;
    }
  }

  private async createAdapter(providerId: string): Promise<AiModelAdapter> {
    const config = (await createAiConfigRepository(this.requirePool()).listProviders()).find((provider) => provider.id === providerId);
    if (!config) throw new Error("errors.common.notFound");
    if (!config.credentialRef) throw new Error("errors.ai.missingCredential");
    const apiKey = await this.credentials.get(config.credentialRef);
    const modelId = typeof config.metadata.modelId === "string" ? config.metadata.modelId : "";
    const capabilities: AiCapability[] = Array.isArray(config.metadata.capabilities)
      ? config.metadata.capabilities.flatMap((value) => {
          const parsed = AiCapabilitySchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    if (config.provider === "google") {
      return this.registerAdapter(new GoogleGeminiAdapter({
        apiKey, modelId, capabilities, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {})
      }));
    }
    return this.registerAdapter(new OpenAiCompatibleAdapter({
      apiKey, modelId, capabilities,
      baseUrl: config.baseUrl ?? "http://127.0.0.1:11434/v1"
    }));
  }

  private async createLocalAdapter(localModelId: string): Promise<AiModelAdapter> {
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model || model.status !== "ready" || !model.managedPath) throw new Error("errors.localModels.notReady");
    const options = {
      modelId: model.modelId,
      modelPath: model.managedPath,
      capabilities: parseCapabilities(model.capabilities),
      repository: model.repository,
      revision: model.revision,
      quantization: model.quantization
    };
    if (model.runtime === "mlx") {
      return this.registerAdapter(new MlxAdapter({ ...options, helperPath: this.resolveMlxHelperPath() }));
    }
    return this.registerAdapter(new NodeLlamaCppAdapter(options));
  }

  private registerAdapter<T extends AiModelAdapter>(adapter: T): T {
    this.registry.register(adapter);
    return adapter;
  }

  private resolveMlxHelperPath(): string {
    return this.options.isPackaged
      ? join(this.options.resourcesPath, "sidecars", "mlx", "darwin-arm64", "memora-mlx-helper")
      : join(this.options.workspaceRoot, "native", "mlx-helper", ".build", "release", "memora-mlx-helper");
  }

  private async withLocalModelUsage<T>(localModelId: string, run: () => Promise<T>): Promise<T> {
    if (this.activeLocalModels.has(localModelId)) throw new Error("errors.localModels.modelBusy");
    this.activeLocalModels.add(localModelId);
    try {
      return await run();
    } finally {
      this.activeLocalModels.delete(localModelId);
    }
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

export interface DefaultAiTaskResult extends AiTaskResult {
  profileId: string;
  aiTaskRunId: string;
}

function capabilitiesForTask(taskType: AiTaskRequest["taskType"]): AiCapability[] {
  return ({
    embedding: ["embedding"],
    summarization: ["summarization"],
    "atomic-note-generation": ["atomic-note-generation", "structured-output"],
    reranking: ["reranking"]
  } as Partial<Record<AiTaskRequest["taskType"], AiCapability[]>>)[taskType] ?? [];
}

function defaultBaseUrl(provider: AiProviderConfigInput["provider"]): string {
  return provider === "google" ? "https://generativelanguage.googleapis.com/v1beta" : "http://127.0.0.1:11434/v1";
}

function localAdapterName(runtime: string): string {
  return runtime === "mlx" ? "mlx-swift-lm" : "node-llama-cpp";
}

function mapProvider(record: AiProviderConfigRecord): AiProviderConfig {
  return {
    id: record.id,
    provider: record.provider as AiProviderConfig["provider"],
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    modelId: typeof record.metadata.modelId === "string" ? record.metadata.modelId : "",
    capabilities: parseCapabilities(record.metadata.capabilities),
    secretConfigured: Boolean(record.credentialRef),
    status: record.status
  };
}

function parseCapabilities(value: unknown): AiCapability[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((capability) => {
    const parsed = AiCapabilitySchema.safeParse(capability);
    return parsed.success ? [parsed.data] : [];
  });
}

function mapProfile(record: AiProfileRecord): AiProfile {
  return {
    id: record.id, name: record.name, description: record.description,
    isDefault: record.isDefault, privacyMode: record.privacyMode, status: record.status
  };
}
