import { sha256 } from "@app/conversion";
import { createTranslator } from "@app/i18n";
import {
  AiModelRegistry,
  effectiveReasoningParameters,
  findLocalModelCatalogEntry,
  GoogleGeminiAdapter,
  MlxAdapter,
  NodeLlamaCppAdapter,
  OpenAiCompatibleAdapter,
  OpenAiCodexAdapter,
  redactSensitiveText,
  type AiModelAdapter,
  type AiProgressEvent,
  type AiTaskRequest,
  type AiTaskResult
} from "@app/ai";
import {
  createAiConfigRepository,
  createJobRepository,
  createLocalModelRepository,
  type AiProfileRecord,
  type AiProviderConfigRecord,
  type LocalModelRecord,
  type PgPool
} from "@app/db";
import { AiCapabilitySchema, type AiCapability } from "@app/domain";
import type {
  AiProfile,
  AiProfileCreate,
  AiProfileUpdate,
  AiProfileTask,
  AiProfileTaskInput,
  AiTaskRoute,
  AiProviderConfig,
  AiProviderConfigInput,
  AiModelDiscoveryInput
} from "../../shared/ipc.js";
import { aiModelParametersSchema } from "../../shared/ipc.js";

import { CredentialService } from "./credential-service.js";
import { withAiTaskParameterDefaults } from "./ai-task-parameters.js";
import { isLocalModelOutputDebugEnabled, logLocalModelOutput } from "./local-model-output-debug.js";
import { logStructuredError } from "./structured-logging.js";
import {
  loginOpenAiCodex,
  parseOpenAiCodexCredential,
  refreshOpenAiCodexCredential,
  type OpenAiCodexCredential
} from "./openai-codex-oauth.js";
import { extname, join } from "node:path";

export interface AiServiceOptions {
  userDataPath: string;
  getPool: () => PgPool | null;
  workspaceRoot: string;
  resourcesPath: string;
  isPackaged: boolean;
  logger?: Pick<Console, "error" | "info">;
  getDashboardDebugMode?: () => Promise<boolean>;
  getUiLanguage?: () => Promise<string>;
  openExternal?: (url: string) => Promise<void>;
}

export interface AiTaskLogContext {
  jobId?: string;
  ingestionRunId?: string;
  sourceItemId?: string;
  documentId?: string;
  stage?: string;
  onProgress?: (event: AiProgressEvent) => void;
}

export class AiService {
  private readonly credentials: CredentialService;
  private readonly activeLocalModels = new Set<string>();
  private readonly registry = new AiModelRegistry();
  private readonly oauthRefreshes = new Map<string, Promise<OpenAiCodexCredential>>();
  private pendingOpenAiCodexCredential: OpenAiCodexCredential | null = null;
  private residentLocalAdapter: { localModelId: string; adapter: AiModelAdapter } | null = null;

  public constructor(private readonly options: AiServiceOptions) {
    this.credentials = new CredentialService(options.userDataPath);
  }

  public async listProviders(): Promise<AiProviderConfig[]> {
    const repository = createAiConfigRepository(this.requirePool());
    await repository.ensureRemoteRerankingCapabilities();
    return (await repository.listProviders()).map(mapProvider);
  }

  public async deleteProvider(providerId: string): Promise<boolean> {
    const repository = createAiConfigRepository(this.requirePool());
    const deleted = await repository.deleteProvider(providerId);
    if (!deleted) return false;
    if (deleted.credentialRef
        && !(await repository.listProviders()).some((provider) => provider.credentialRef === deleted.credentialRef)) {
      try {
        await this.credentials.remove(deleted.credentialRef);
      } catch (error) {
        this.options.logger?.error("Failed to remove unused AI provider credential", error);
      }
    }
    return true;
  }

  public async saveProvider(input: AiProviderConfigInput): Promise<AiProviderConfig> {
    const repository = createAiConfigRepository(this.requirePool());
    const existing = input.id ? (await repository.listProviders()).find((provider) => provider.id === input.id) : undefined;
    const capabilities = withRemoteRerankingCapability(input.provider, input.capabilities);
    let credentialRef: string | null;
    if (input.provider === "openai-codex") {
      const existingRef = existing?.provider === "openai-codex" ? existing.credentialRef : null;
      credentialRef = this.pendingOpenAiCodexCredential
        ? await this.credentials.save(JSON.stringify(this.pendingOpenAiCodexCredential), existingRef)
        : existingRef;
      if (!credentialRef) throw new Error("errors.ai.oauthNotConnected");
    } else {
      credentialRef = input.apiKey
        ? await this.credentials.save(input.apiKey, existing?.credentialRef)
        : existing?.credentialRef ?? null;
    }
    const record = await repository.upsertProvider({
      ...(input.id ? { id: input.id } : {}), provider: input.provider, displayName: input.displayName,
      credentialRef, baseUrl: input.baseUrl ?? defaultBaseUrl(input.provider),
      defaultParameters: input.defaultParameters,
      metadata: { modelId: input.modelId, capabilities }
    });
    if (input.provider === "openai-codex") this.pendingOpenAiCodexCredential = null;
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

  public async discoverModels(input: AiModelDiscoveryInput): Promise<string[]> {
    const baseUrl = input.baseUrl ?? defaultBaseUrl(input.provider);
    const adapter = input.provider === "openai-codex"
      ? this.createPendingOpenAiCodexAdapter()
      : input.provider === "google"
        ? new GoogleGeminiAdapter({ apiKey: input.apiKey!, modelId: "", capabilities: [], baseUrl })
        : new OpenAiCompatibleAdapter({ apiKey: input.apiKey!, modelId: "", capabilities: [], baseUrl });
    const modelIds = (await adapter.listModels?.() ?? []).map((model) => model.modelId);
    return [...new Set(modelIds)].sort((left, right) => left.localeCompare(right));
  }

  public async connectOpenAiCodex(): Promise<string[]> {
    if (!this.options.openExternal) throw new Error("errors.ai.oauthLoginFailed");
    const t = createTranslator(await this.options.getUiLanguage?.() ?? "en");
    const credential = await loginOpenAiCodex({
      openExternal: this.options.openExternal,
      pageText: {
        successTitle: t("settings.ai.oauth.callbackSuccessTitle"),
        successDescription: t("settings.ai.oauth.callbackSuccessDescription"),
        errorTitle: t("settings.ai.oauth.callbackErrorTitle"),
        closeWindow: t("settings.ai.oauth.callbackCloseWindow")
      }
    });
    this.pendingOpenAiCodexCredential = credential;
    try {
      return await this.discoverModels({ provider: "openai-codex" });
    } catch (error) {
      this.pendingOpenAiCodexCredential = null;
      throw error;
    }
  }

  public disconnectOpenAiCodex(): void {
    this.pendingOpenAiCodexCredential = null;
  }

  public async listProfiles(): Promise<AiProfile[]> {
    const repository = createAiConfigRepository(this.requirePool());
    await repository.ensureRemoteRerankingCapabilities();
    return (await repository.listProfiles()).map(mapProfile);
  }

  public async createProfile(input: AiProfileCreate): Promise<AiProfile> {
    return mapProfile(await createAiConfigRepository(this.requirePool()).createProfile({
      name: input.name,
      isDefault: input.isDefault,
      privacyMode: input.privacyMode,
      outputLanguage: input.outputLanguage,
      ...(input.description !== undefined ? { description: input.description } : {})
    }));
  }

  public async updateProfile(input: AiProfileUpdate): Promise<AiProfile> {
    const repository = createAiConfigRepository(this.requirePool());
    let modelCapabilities: AiCapability[] | undefined;
    if (input.modelId !== undefined) {
      if (input.localModelId) {
        const localModel = await createLocalModelRepository(this.requirePool()).findById(input.localModelId);
        if (!localModel || localModel.status !== "ready") throw new Error("errors.localModels.notReady");
        if (localModel.runtime !== input.runtime || localModel.modelId !== input.modelId
            || !input.capabilities?.every((capability) => localModel.capabilities.includes(capability))) {
          throw new Error("errors.ai.noCompatibleModel");
        }
        modelCapabilities = parseCapabilities(localModel.capabilities);
      } else {
        if (input.privacyMode === "offline_only") throw new Error("errors.ai.noCompatibleModel");
        const provider = (await repository.listProviders()).find((candidate) => candidate.id === input.providerConfigId);
        const capabilities = parseCapabilities(provider?.metadata.capabilities);
        if (!provider || provider.metadata.modelId !== input.modelId
            || !input.capabilities?.every((capability) => capabilities.includes(capability))) {
          throw new Error("errors.ai.noCompatibleModel");
        }
        modelCapabilities = capabilities;
      }
    }
    return mapProfile(await repository.updateProfile({
      id: input.id,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.privacyMode !== undefined ? { privacyMode: input.privacyMode } : {}),
      ...(input.outputLanguage !== undefined ? { outputLanguage: input.outputLanguage } : {}),
      ...(input.providerConfigId !== undefined ? { providerConfigId: input.providerConfigId } : {}),
      ...(input.localModelId !== undefined ? { localModelId: input.localModelId } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
      ...(modelCapabilities !== undefined ? { capabilities: modelCapabilities } : {})
    }));
  }

  public async cloneProfile(profileId: string, name: string): Promise<AiProfile> {
    return mapProfile(await createAiConfigRepository(this.requirePool()).cloneProfile(profileId, name));
  }

  public async deleteProfile(profileId: string): Promise<boolean> {
    return createAiConfigRepository(this.requirePool()).deleteProfile(profileId);
  }

  public async listProfileTasks(profileId?: string): Promise<AiProfileTask[]> {
    return (await createAiConfigRepository(this.requirePool()).listProfileTasks(profileId)).map((task) => ({
      ...task,
      task: task.task as AiProfileTask["task"],
      parameters: aiModelParametersSchema.parse(task.parameters)
    }));
  }

  public async listTaskRoutes(): Promise<AiTaskRoute[]> {
    return (await createAiConfigRepository(this.requirePool()).listTaskRoutes()).map((route) => ({
      task: route.task as AiTaskRoute["task"],
      profileId: route.profileId
    }));
  }

  public async setTaskRoute(input: AiTaskRoute): Promise<void> {
    const repository = createAiConfigRepository(this.requirePool());
    await repository.ensureRemoteRerankingCapabilities();
    const profile = (await repository.listProfiles()).find((candidate) => candidate.id === input.profileId);
    if (!profile || profile.status !== "active" || !profile.modelId
        || !capabilitiesForTask(input.task).every((capability) => profile.capabilities.includes(capability))) {
      throw new Error("errors.ai.noCompatibleModel");
    }
    const configuredTask = (await repository.listProfileTasks(input.profileId))
      .some((task) => task.task === input.task);
    if (!configuredTask) {
      await repository.setProfileTask({ profileId: input.profileId, task: input.task, parameters: {} });
    }
    await repository.setTaskRoute(input.task, input.profileId);
  }

  public async setProfileTask(input: AiProfileTaskInput): Promise<void> {
    const repository = createAiConfigRepository(this.requirePool());
    await repository.ensureRemoteRerankingCapabilities();
    const profile = (await repository.listProfiles()).find((candidate) => candidate.id === input.profileId);
    if (!profile) throw new Error("errors.common.notFound");
    if (!profile.modelId || !capabilitiesForTask(input.task).every((capability) => profile.capabilities.includes(capability))) {
      throw new Error("errors.ai.noCompatibleModel");
    }
    await repository.setProfileTask({
      profileId: input.profileId,
      task: input.task,
      fallbackPolicy: "block",
      parameters: input.parameters
    });
  }

  public async runDefaultTask(
    taskType: "embedding" | "summarization" | "knowledge-graph-generation" | "atomic-note-generation" | "reranking",
    input: string,
    logContext: AiTaskLogContext = {},
    signal?: AbortSignal
  ): Promise<DefaultAiTaskResult | null> {
    const { onProgress, ...structuredLogContext } = logContext;
    const repository = createAiConfigRepository(this.requirePool());
    await repository.ensureRemoteRerankingCapabilities();
    const selection = await repository.getDefaultTask(taskType);
    if (!selection) return null;
    const parameters = effectiveReasoningParameters(
      selection.provider,
      selection.modelId,
      withAiTaskParameterDefaults(
        taskType,
        { ...selection.modelDefaultParameters, ...selection.parameters },
        Boolean(selection.localModelId)
      )
    );
    if (structuredLogContext.jobId) {
      try {
        await createJobRepository(this.requirePool()).setAiExecution(structuredLogContext.jobId, {
          provider: selection.provider,
          modelId: selection.modelId,
          reasoningLevel: parameters.reasoningLevel ?? null
        });
      } catch (error) {
        this.options.logger?.error("Failed to attach AI execution metadata to job", error);
      }
    }
    const outputLanguage = selection.outputLanguage === "ui"
      ? await this.options.getUiLanguage?.() ?? "en"
      : selection.outputLanguage;
    const taskInput = taskType === "embedding"
      ? input
      : withOutputLanguageInstruction(input, outputLanguage);
    const started = Date.now();
    try {
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
      const request: AiTaskRequest = {
        taskType, input: taskInput, profileId: selection.profileId, modelId: selection.modelId,
        requiredCapabilities, parameters, metadata: {}
      };
      const progress = createProgressReporter(onProgress);
      const run = () => adapter.runStreaming
        && (descriptor.capabilities.includes("streaming") || descriptor.capabilities.includes("supports-progress-events"))
        ? adapter.runStreaming(request, signal, progress)
        : adapter.run(request, signal);
      progress({ progress: 0.02 });
      const result = selection.localModelId
        ? await this.withLocalModelUsage(selection.localModelId, run)
        : await run();
      progress({ progress: 1 });
      const aiTaskRunId = await repository.recordTaskRun({
        profileId: selection.profileId, taskType, provider: result.providerId, modelId: result.modelId,
        runtime: selection.localModelId ? selection.runtime : result.runtime,
        capabilitiesUsed: requiredCapabilities,
        adapter: selection.localModelId ? localAdapterName(selection.runtime) : result.providerId,
        repository: selection.repository,
        revision: selection.revision,
        quantization: selection.quantization,
        parameters,
        inputHash: sha256(taskInput), outputHash: sha256(JSON.stringify(result.output)),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {}),
        durationMs: result.durationMs, status: "succeeded"
      });
      if (selection.localModelId) {
        const debugOutputEnabled = await isLocalModelOutputDebugEnabled(this.options.getDashboardDebugMode);
        logLocalModelOutput(this.options.logger, debugOutputEnabled, {
          ...structuredLogContext,
          stage: structuredLogContext.stage ?? "ai_execution",
          taskType,
          profileId: selection.profileId,
          providerId: result.providerId,
          modelId: result.modelId,
          runtime: result.runtime,
          aiTaskRunId
        }, result.output);
      }
      return { ...result, profileId: selection.profileId, aiTaskRunId, outputLanguage };
    } catch (error) {
      const aiTaskRunId = await repository.recordTaskRun({
        profileId: selection.profileId, taskType, provider: selection.provider,
        modelId: selection.modelId, runtime: selection.runtime,
        adapter: selection.localModelId ? localAdapterName(selection.runtime) : selection.provider,
        repository: selection.repository,
        revision: selection.revision,
        quantization: selection.quantization,
        parameters,
        durationMs: Date.now() - started, status: "failed",
        error: redactSensitiveText(error).slice(0, 500)
      });
      if (taskType === "atomic-note-generation") {
        logStructuredError(this.options.logger, "atomic_note_ai_task_failed", {
          ...structuredLogContext,
          stage: structuredLogContext.stage ?? "ai_execution",
          taskType,
          profileId: selection.profileId,
          providerId: selection.provider,
          modelId: selection.modelId,
          runtime: selection.runtime,
          aiTaskRunId
        }, error, "atomic_note_ai_task_failed");
      }
      throw error;
    }
  }

  public isLocalModelInUse(localModelId: string): boolean {
    return this.activeLocalModels.has(localModelId);
  }

  public async releaseLocalRuntime(force = false): Promise<void> {
    const resident = this.residentLocalAdapter;
    if (!resident) return;
    if (!force && this.activeLocalModels.has(resident.localModelId)) return;
    this.residentLocalAdapter = null;
    const descriptor = resident.adapter.describe();
    this.registry.unregister(descriptor.providerId, descriptor.modelId);
    await resident.adapter.dispose?.();
  }

  public async dispose(): Promise<void> {
    await this.releaseLocalRuntime(true);
  }

  public async testLocalModel(localModelId: string): Promise<string> {
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model) throw new Error("errors.common.notFound");
    const configuredAdapter = await this.createLocalAdapter(localModelId);
    const descriptor = configuredAdapter.describe();
    const embeddingOnly = model.capabilities.includes("embedding")
      && !model.capabilities.includes("text-generation");
    const taskType = embeddingOnly ? "embedding" as const : "text-generation" as const;
    const requiredCapabilities = embeddingOnly ? ["embedding" as const] : ["text-generation" as const];
    const adapter = this.registry.resolve({
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      requiredCapabilities,
      offlineOnly: true
    });
    const repository = createAiConfigRepository(this.requirePool());
    const input = embeddingOnly ? "query: local embedding smoke test" : "Reply with exactly: OK";
    const parameters = withAiTaskParameterDefaults(
      taskType,
      model.defaultParameters,
      true
    );
    const started = Date.now();
    try {
      const result = await this.withLocalModelUsage(localModelId, () => adapter.run({
        taskType,
        input,
        modelId: adapter.describe().modelId,
        requiredCapabilities,
        parameters,
        metadata: { purpose: "local-model-test" }
      }));
      await repository.recordTaskRun({
        taskType,
        provider: result.providerId,
        modelId: result.modelId,
        runtime: model.runtime,
        adapter: localAdapterName(model.runtime),
        repository: model.repository,
        revision: model.revision,
        quantization: model.quantization,
        capabilitiesUsed: [...requiredCapabilities, "offline"],
        parameters,
        inputHash: sha256(input),
        outputHash: sha256(JSON.stringify(result.output)),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        costEstimate: 0,
        durationMs: result.durationMs,
        status: "succeeded"
      });
      return Array.isArray(result.output)
        ? `Embedding generated (${result.output.length} dimensions)`
        : typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    } catch (error) {
      await repository.recordTaskRun({
        taskType,
        provider: `local-${model.runtime}`,
        modelId: model.modelId,
        runtime: model.runtime,
        adapter: localAdapterName(model.runtime),
        repository: model.repository,
        revision: model.revision,
        quantization: model.quantization,
        capabilitiesUsed: [...requiredCapabilities, "offline"],
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
    const modelId = typeof config.metadata.modelId === "string" ? config.metadata.modelId : "";
    const capabilities: AiCapability[] = Array.isArray(config.metadata.capabilities)
      ? config.metadata.capabilities.flatMap((value) => {
          const parsed = AiCapabilitySchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    if (config.provider === "openai-codex") {
      const credential = await this.getOpenAiCodexCredential(config.credentialRef);
      return this.registerAdapter(new OpenAiCodexAdapter({
        accessToken: credential.access,
        accountId: credential.accountId,
        modelId,
        capabilities,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {})
      }));
    }
    const apiKey = await this.credentials.get(config.credentialRef);
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

  private createPendingOpenAiCodexAdapter(): OpenAiCodexAdapter {
    const credential = this.pendingOpenAiCodexCredential;
    if (!credential) throw new Error("errors.ai.oauthNotConnected");
    return new OpenAiCodexAdapter({
      accessToken: credential.access,
      accountId: credential.accountId,
      modelId: "",
      capabilities: [],
      baseUrl: defaultBaseUrl("openai-codex")
    });
  }

  private async getOpenAiCodexCredential(credentialRef: string): Promise<OpenAiCodexCredential> {
    const credential = parseOpenAiCodexCredential(await this.credentials.get(credentialRef));
    if (credential.expires > Date.now() + 60_000) return credential;
    const activeRefresh = this.oauthRefreshes.get(credentialRef);
    if (activeRefresh) return activeRefresh;
    const refresh = (async () => {
      try {
        const next = await refreshOpenAiCodexCredential(credential.refresh);
        await this.credentials.save(JSON.stringify(next), credentialRef);
        return next;
      } catch (error) {
        this.options.logger?.error("OpenAI Codex OAuth refresh failed", error);
        throw new Error("errors.ai.oauthRefreshFailed");
      }
    })();
    this.oauthRefreshes.set(credentialRef, refresh);
    try {
      return await refresh;
    } finally {
      if (this.oauthRefreshes.get(credentialRef) === refresh) this.oauthRefreshes.delete(credentialRef);
    }
  }

  private async createLocalAdapter(localModelId: string): Promise<AiModelAdapter> {
    if (this.residentLocalAdapter?.localModelId === localModelId) return this.residentLocalAdapter.adapter;
    await this.releaseLocalRuntime();
    if (this.residentLocalAdapter) throw new Error("errors.localModels.modelBusy");
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model || model.status !== "ready" || !model.managedPath) throw new Error("errors.localModels.notReady");
    const options = {
      modelId: model.modelId,
      modelPath: resolveLocalModelPath(model),
      capabilities: parseCapabilities(model.capabilities),
      repository: model.repository,
      revision: model.revision,
      quantization: model.quantization
    };
    const adapter = model.runtime === "mlx"
      ? new MlxAdapter({ ...options, helperPath: this.resolveMlxHelperPath() })
      : new NodeLlamaCppAdapter(options);
    this.residentLocalAdapter = { localModelId, adapter };
    return this.registerAdapter(adapter);
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
  outputLanguage: string;
}

function capabilitiesForTask(taskType: AiTaskRequest["taskType"]): AiCapability[] {
  return ({
    embedding: ["embedding"],
    summarization: ["summarization"],
    "knowledge-graph-generation": ["structured-output"],
    "atomic-note-generation": ["atomic-note-generation", "structured-output"],
    reranking: ["reranking"]
  } as Partial<Record<AiTaskRequest["taskType"], AiCapability[]>>)[taskType] ?? [];
}

const remoteGenerativeCapabilities = new Set<AiCapability>([
  "text-generation",
  "structured-output",
  "summarization",
  "knowledge-graph-generation",
  "atomic-note-generation"
]);

function withRemoteRerankingCapability(
  provider: AiProviderConfigInput["provider"],
  capabilities: AiCapability[]
): AiCapability[] {
  const supportsReranking = provider === "openai-codex"
    || capabilities.some((capability) => remoteGenerativeCapabilities.has(capability));
  return supportsReranking && !capabilities.includes("reranking")
    ? [...capabilities, "reranking"]
    : capabilities;
}

function defaultBaseUrl(provider: AiProviderConfigInput["provider"]): string {
  if (provider === "google") return "https://generativelanguage.googleapis.com/v1beta";
  if (provider === "openai-codex") return "https://chatgpt.com/backend-api/codex";
  return "http://127.0.0.1:11434/v1";
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
    defaultParameters: aiModelParametersSchema.parse(record.defaultParameters),
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
    isDefault: record.isDefault,
    privacyMode: record.privacyMode,
    outputLanguage: record.outputLanguage as AiProfile["outputLanguage"],
    providerConfigId: record.providerConfigId,
    localModelId: record.localModelId,
    modelId: record.modelId,
    runtime: record.runtime as AiProfile["runtime"],
    capabilities: parseCapabilities(record.capabilities),
    status: record.status
  };
}

function resolveLocalModelPath(model: LocalModelRecord): string {
  if (!model.managedPath) throw new Error("errors.localModels.notReady");
  if (model.runtime !== "gguf" || extname(model.managedPath).toLowerCase() === ".gguf") {
    return model.managedPath;
  }
  const entry = findLocalModelCatalogEntry(model.catalogId);
  const file = entry?.files.find((candidate) => candidate.path.toLowerCase().endsWith(".gguf"));
  if (!file) throw new Error("errors.localModels.invalidGguf");
  return join(model.managedPath, file.path);
}

function withOutputLanguageInstruction(input: string, language: string): string {
  const languageName = ({
    en: "English",
    "pt-BR": "Brazilian Portuguese",
    it: "Italian",
    fr: "French",
    es: "Spanish"
  } as Record<string, string>)[language] ?? language;
  return `Produce all natural-language response text in ${languageName}. Preserve required JSON keys and schemas exactly.\n\n${input}`;
}

function createProgressReporter(listener?: (event: AiProgressEvent) => void): (event: AiProgressEvent) => void {
  let lastProgress = -1;
  let lastReportedAt = 0;
  return (event) => {
    if (!listener) return;
    const now = Date.now();
    const progress = Math.max(0, Math.min(1, event.progress));
    if (progress < 1 && progress - lastProgress < 0.01 && now - lastReportedAt < 250) return;
    lastProgress = progress;
    lastReportedAt = now;
    listener({ ...event, progress });
  };
}
