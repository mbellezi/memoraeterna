import { sha256 } from "@app/conversion";
import {
  GoogleGeminiAdapter,
  OpenAiCompatibleAdapter,
  type AiModelAdapter,
  type AiTaskRequest,
  type AiTaskResult
} from "@app/ai";
import {
  createAiConfigRepository,
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

export class AiService {
  private readonly credentials: CredentialService;

  public constructor(
    userDataPath: string,
    private readonly getPool: () => PgPool | null
  ) {
    this.credentials = new CredentialService(userDataPath);
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
    await createAiConfigRepository(this.requirePool()).setProfileTask({
      ...input,
      runtime: "remote",
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
    const adapter = await this.createAdapter(selection.providerConfigId);
    const started = Date.now();
    try {
      const requiredCapabilities = capabilitiesForTask(taskType);
      const result = await adapter.run({
        taskType, input, profileId: selection.profileId, modelId: selection.modelId,
        requiredCapabilities,
        parameters: selection.parameters, metadata: {}
      });
      const aiTaskRunId = await repository.recordTaskRun({
        profileId: selection.profileId, taskType, provider: result.providerId, modelId: result.modelId,
        runtime: result.runtime, capabilitiesUsed: requiredCapabilities,
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
        durationMs: Date.now() - started, status: "failed",
        error: error instanceof Error ? error.message.slice(0, 500) : "ai_task_failed"
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
      return new GoogleGeminiAdapter({ apiKey, modelId, capabilities, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) });
    }
    return new OpenAiCompatibleAdapter({
      apiKey, modelId, capabilities,
      baseUrl: config.baseUrl ?? "http://127.0.0.1:11434/v1"
    });
  }

  private requirePool(): PgPool {
    const pool = this.getPool();
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
