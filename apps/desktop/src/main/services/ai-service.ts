export { withOutputLanguageInstruction } from "./prompt-runtime.js";
import { withOutputLanguageInstruction } from "./prompt-runtime.js";
import {
  renderPrompt,
  joinPrompts,
  capturePromptPin,
  withPromptPin,
  promptAudit,
  embeddingPromptIdentity
} from "./prompt-runtime.js";
import { sha256 } from "@app/conversion";
import { createTranslator } from "@app/i18n";
import {
  AiModelRegistry,
  createDecideValidation,
  decideValidationForCatalogEntry,
  findLocalModelCatalogEntry,
  GoogleGeminiAdapter,
  hasGeneration,
  isDecideValidationCurrent,
  isDedicatedRanker,
  isRankerCatalogEntry,
  localParameterCapabilities,
  MlxAdapter,
  MlxHelperHost,
  MlxRerankerAdapter,
  NodeLlamaCppAdapter,
  NodeLlamaRankerAdapter,
  OpenAiCompatibleAdapter,
  OpenAiCodexAdapter,
  parseRankRequest,
  providerParameterCapabilities,
  rankerCatalogArtifactSha256,
  rankTaskRequest,
  readRankResult,
  redactSensitiveText,
  remoteCallReport,
  runRankerSmoke,
  runsStreaming,
  validateCatalogRankerArtifact,
  type AiModelAdapter,
  type AiProgressEvent,
  type AiRuntimeConfigInput,
  type AiTaskRequest,
  type AiTaskResult,
  type AiWorkloadClass,
  type LocalModelCatalogEntry,
  type RankerSmokeReport,
  type RankRequest,
  type RankResult,
  aiCassetteReplayedUsageKey
} from "@app/ai";
import {
  aiRouteKeys,
  createAiConfigRepository,
  createEmbeddingRepository,
  createJobRepository,
  createLocalModelRepository,
  operationRouteKey,
  workloadClassRouteKey,
  type AiProfileRecord,
  type AiProviderConfigRecord,
  type LocalModelRecord,
  type PgPool,
  type JsonObject
} from "@app/db";
import {
  type PromptPin,
  type PromptCompositionSnapshot,
  AiCapabilitySchema,
  OrganizationProfileSchema,
  type OrganizationProfile,
  normalizeAiModelParameters,
  capabilitiesForTask,
  generativeDeciderCapabilities,
  supportsTask,
  type AiCapability,
  type AiModelParameterCapabilities
} from "@app/domain";
import type {
  AiProfile,
  AiProfileCreate,
  AiProfileUpdate,
  AiProfileTask,
  AiProfileTaskInput,
  AiTaskRoute,
  AiProviderConfig,
  AiProviderConfigInput,
  AiModelDiscoveryInput,
  AiParameterCapabilitiesInput,
  LocalEmbeddingLoadStatus
} from "../../shared/ipc.js";
import { aiConfigurableTaskSchema, aiModelParametersSchema } from "../../shared/ipc.js";

import { CredentialService } from "./credential-service.js";
import { ActiveDeadline, AiExecutionQueue, type AiQueuePriority } from "./ai-execution-queue.js";
import {
  withAiTaskParameterDefaults,
  discoveredContextWindow,
  discoveredModelLimits,
  estimateAiPlanningTokens
} from "./ai-task-parameters.js";
import type { MonitoringService } from "./monitoring-service.js";
import { logStructuredError } from "./structured-logging.js";
import {
  loginOpenAiCodex,
  parseOpenAiCodexCredential,
  refreshOpenAiCodexCredential,
  type OpenAiCodexCredential
} from "./openai-codex-oauth.js";
import { extname, join } from "node:path";

const aiExecutionQueue = new AiExecutionQueue();

export interface AiServiceOptions {
  userDataPath: string;
  getPool: () => PgPool | null;
  workspaceRoot: string;
  resourcesPath: string;
  isPackaged: boolean;
  logger?: Pick<Console, "error" | "info">;
  monitoring?: MonitoringService;
  getContentLanguage?: () => Promise<string>;
  getUiLanguage?: () => Promise<string>;
  getKeepLocalEmbeddingModelsLoaded?: () => Promise<boolean>;
  onLocalEmbeddingLoadStatus?: (status: LocalEmbeddingLoadStatus) => void;
  openExternal?: (url: string) => Promise<void>;
  /** Deadline and retry overrides of the remote adapters; the defaults apply to what is left out. */
  runtime?: AiRuntimeConfigInput;
  /**
   * The MLX helper every MLX adapter shares: one helper process holds at most one generative, one
   * embedding and one ranker model (D18). Created on first use when left out; proofs inject one.
   */
  mlxHost?: MlxHelperHost;
  /** The machine; it decides whether an MLX ranker can be seeded (D18). Defaults to this one. */
  machine?: { platform: string; arch: string };
}

/** The `class:decide` route: a validated dedicated ranker (D17, D18). */
export const decideRouteKey = workloadClassRouteKey("decide");
/** The `class:write-fast` route: short structured writing such as topic names (D11, D18). */
export const writeFastRouteKey = workloadClassRouteKey("write-fast");

/** One rank call: a query against at most 32 documents under an instruction (D10). */
export interface AiRankInput {
  /** The calling operation, which may have its own route (`op:<operation>`) before `class:decide`. */
  operation: string;
  /** The ranker instruction, rendered from the prompt catalog by the caller. */
  instruction: string;
  query: string;
  documents: string[];
  /** Queue class; background unless the user waits for the answer (D18). */
  priority?: AiQueuePriority;
  /** Sources whose content takes part in the call, for the audit. */
  sourceIds?: string[];
  jobId?: string;
  stage?: string;
  /** The audit of the instruction; read from the prompt runtime when left out. */
  promptCompositions?: PromptCompositionSnapshot[];
}

export interface AiRankResult extends RankResult {
  aiTaskRunId: string;
  profileId: string;
  localModelId: string;
  provider: string;
  modelId: string;
  runtime: string;
  durationMs: number;
  queueMs: number;
}

/**
 * Whether rank calls of an operation have a ranker to run on, without loading it: `missing` (no
 * usable `op:` or `class:decide` route: none, an inactive one, or one whose model is not
 * installed), `incompatible` (the route's model is not a dedicated ranker), `not_ready` (its files
 * are gone) or `not_validated` (no current decide validation). The runtime build is checked when
 * the ranker is loaded, by `rank` itself.
 */
export type DecideRouteStatus =
  "ready" | "missing" | "incompatible" | "not_ready" | "not_validated";

/** What an embedding call's space key is computed from, besides the adapter (D26). */
export interface EmbeddingSpaceSelection {
  providerConfigId: string | null;
  baseUrl: string | null;
  localModelId: string | null;
  repository: string | null;
  quantization: string | null;
  revision: string | null;
  /** The effective parameters of the call, after defaults and normalization. */
  parameters: JsonObject;
  /** The embedding prompt identity, set only when the wording differs from the shipped one. */
  promptStrategy: string | null;
}

/** The adapter identity an embedding result reports. */
export interface EmbeddingAdapterIdentity {
  providerId: string;
  modelId: string;
  runtime: string;
}

/**
 * The embedding space of a route (D26): the identity a vector's `native-v2:` strategy carries.
 * Pure, so the space can be known without an AI call; any change of model, endpoint, revision,
 * effective parameters or embedding wording is a new space.
 */
export function embeddingSpaceKey(
  selection: EmbeddingSpaceSelection,
  adapter: EmbeddingAdapterIdentity
): string {
  return sha256(
    JSON.stringify({
      providerConfigId: selection.providerConfigId,
      baseUrl: selection.baseUrl,
      localModelId: selection.localModelId,
      repository: selection.repository,
      quantization: selection.quantization,
      model: adapter.modelId,
      provider: adapter.providerId,
      runtime: adapter.runtime,
      revision: selection.revision,
      parameters: selection.parameters,
      ...(selection.promptStrategy ? { promptStrategy: selection.promptStrategy } : {})
    })
  );
}

/** The embedding space of the routed embedding model, computed without a call (D26). */
export interface ActiveEmbeddingSpace {
  spaceKey: string;
  profileId: string;
  provider: string;
  modelId: string;
  /** The model runs on this machine, so a re-embed costs nothing (Q8). */
  local: boolean;
  dimensions: number | null;
  /** The space of the newest stored note vector; null when no note has a vector yet. */
  newestNoteSpaceKey: string | null;
  /** The newest stored note vector lives in this space. */
  confirmed: boolean;
}

/** Residency slots (D18): one generative, one embedding and one ranker model stay loaded. */
type ResidencySlot = "generate" | "embed" | "rank";
const residencySlots: readonly ResidencySlot[] = ["generate", "embed", "rank"];

interface ResidentLocalAdapter {
  localModelId: string;
  runtime: string;
  adapter: AiModelAdapter;
  /** A ranker's runtime build, read once while it stays resident. */
  runtimeBuild?: Promise<string> | undefined;
}

export interface AiTaskLogContext {
  jobId?: string;
  ingestionRunId?: string;
  sourceItemId?: string;
  sourceItemIds?: string[];
  documentId?: string;
  stage?: string;
  operation?: string;
  origin?: string;
  promptVersion?: string;
  promptCompositions?: PromptCompositionSnapshot[];
  chunkId?: string;
  chunkIds?: string[];
  atomicNoteId?: string;
  batchIndex?: number;
  attempt?: number;
  contentLanguage?: string;
  /**
   * The workload class the caller states. It selects the class route (`class:<class>`) before the
   * task route and sets the deadlines; a class derived from the task type never selects a route.
   */
  workloadClass?: AiWorkloadClass;
  embeddingInputType?: "query" | "document";
  /** Overrides the priority derived from the context; see {@link aiTaskPriority}. */
  priority?: AiQueuePriority;
  onProgress?: (event: AiProgressEvent) => void;
  onProviderStart?: () => Promise<void>;
}

type RoutedTask =
  | "text-generation"
  | "embedding"
  | "summarization"
  | "knowledge-graph-generation"
  | "atomic-note-generation"
  | "reranking"
  | "structured-output";
type TaskSelection = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createAiConfigRepository>["getDefaultTask"]>>
>;
interface PromptAdmission {
  selection: TaskSelection;
  input: string;
  instruction: string;
  compositions: PromptCompositionSnapshot[];
  pin: PromptPin;
  language: string;
  /** Wait in the AI execution queue, set when execution starts. */
  queueMs?: number;
}

/**
 * Zero-based retry index (0 = first try) that pipeline callers report in `AiTaskLogContext.attempt`.
 * Ask calls reuse that field as a 1-based call counter, so they report no retry index; unknown
 * stays unknown.
 */
export function reportedRetryIndex(
  context: Pick<AiTaskLogContext, "attempt" | "origin">
): number | undefined {
  const { attempt, origin } = context;
  if (origin === "consultation") return undefined;
  return typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 0
    ? attempt
    : undefined;
}
/**
 * Queue class of a call. The user is waiting for query embeddings, Ask answers (origin `consultation`)
 * and actions started from the settings; everything else is background work. Callers may state it.
 */
export function aiTaskPriority(
  context: Pick<AiTaskLogContext, "priority" | "origin" | "embeddingInputType">
): AiQueuePriority {
  if (context.priority) return context.priority;
  return context.embeddingInputType === "query" ||
    context.origin === "consultation" ||
    context.origin === "settings"
    ? "interactive"
    : "background";
}
/** Wall-clock fields for the AI task audit; each is omitted when it was not measured or reported. */
function queueAndAttempt(
  admission: Pick<PromptAdmission, "queueMs"> | null | undefined,
  context: Parameters<typeof reportedRetryIndex>[0]
): { queueMs?: number; attempt?: number } {
  const attempt = reportedRetryIndex(context);
  return {
    ...(admission?.queueMs === undefined ? {} : { queueMs: admission.queueMs }),
    ...(attempt === undefined ? {} : { attempt })
  };
}
const selectionIdentity = (s: TaskSelection) =>
  JSON.stringify([
    s.profileId,
    s.providerConfigId,
    s.localModelId,
    s.provider,
    s.modelId,
    s.runtime,
    s.revision,
    s.baseUrl,
    s.repository,
    s.quantization
  ]);
export class AiService {
  public isBusy(): boolean {
    return aiExecutionQueue.busy;
  }
  private readonly credentials: CredentialService;
  private readonly activeLocalModels = new Set<string>();
  private readonly registry = new AiModelRegistry();
  private readonly oauthRefreshes = new Map<string, Promise<OpenAiCodexCredential>>();
  private pendingOpenAiCodexCredential: OpenAiCodexCredential | null = null;
  /** Local models kept loaded, one per slot, so no two generative models are ever resident (D18). */
  private readonly resident: Partial<Record<ResidencySlot, ResidentLocalAdapter>> = {};
  private mlxHost: MlxHelperHost | null;
  /**
   * An MLX adapter was released while the shared helper still holds its weights: the helper has
   * no unload command, so the next idle release stops it (the next MLX call starts a fresh one).
   */
  private mlxHoldsReleasedModel = false;

  public constructor(private readonly options: AiServiceOptions) {
    this.credentials = new CredentialService(options.userDataPath);
    this.mlxHost = options.mlxHost ?? null;
  }

  public async listProviders(): Promise<AiProviderConfig[]> {
    const repository = createAiConfigRepository(this.requirePool());
    const providers = await repository.listProviders();
    for (const provider of providers) {
      const limits = provider.metadata.modelLimits;
      if (limits && typeof limits === "object" && !Array.isArray(limits)) {
        const validated = discoveredModelLimits(limits as Record<string, unknown>);
        if (discoveredContextWindow({ modelLimits: validated }))
          this.discoveredContexts.set(
            this.contextKey(provider.provider, provider.baseUrl, String(provider.metadata.modelId)),
            validated
          );
      }
    }
    return providers.map(mapProvider);
  }

  public async deleteProvider(providerId: string): Promise<boolean> {
    const repository = createAiConfigRepository(this.requirePool());
    const deleted = await repository.deleteProvider(providerId);
    if (!deleted) return false;
    if (
      deleted.credentialRef &&
      !(await repository.listProviders()).some(
        (provider) => provider.credentialRef === deleted.credentialRef
      )
    ) {
      try {
        await this.credentials.remove(deleted.credentialRef);
      } catch (error) {
        this.options.logger?.error("Failed to remove unused AI provider credential", error);
      }
    }
    return true;
  }

  private readonly discoveredContexts = new Map<string, JsonObject>();
  private contextKey(provider: string, baseUrl: string | null, modelId: string) {
    return JSON.stringify([
      provider,
      baseUrl ?? defaultBaseUrl(provider as AiProviderConfig["provider"]),
      modelId
    ]);
  }

  public async saveProvider(input: AiProviderConfigInput): Promise<AiProviderConfig> {
    const repository = createAiConfigRepository(this.requirePool());
    const existing = input.id
      ? (await repository.listProviders()).find((provider) => provider.id === input.id)
      : undefined;
    const sameModel =
      existing?.provider === input.provider &&
      existing.baseUrl === (input.baseUrl ?? defaultBaseUrl(input.provider)) &&
      existing.metadata.modelId === input.modelId;
    const modelLimits =
      this.discoveredContexts.get(
        this.contextKey(input.provider, input.baseUrl ?? null, input.modelId)
      ) ?? (sameModel ? existing?.metadata.modelLimits : undefined);
    const known = discoveredContextWindow({ modelLimits });
    const capabilities = input.capabilities;
    const parameterCapabilities = providerParameterCapabilities({
      provider: input.provider,
      modelId: input.modelId,
      baseUrl: input.baseUrl ?? defaultBaseUrl(input.provider),
      capabilities
    });
    if (known && parameterCapabilities.contextWindow)
      parameterCapabilities.contextWindow.max = known;
    let credentialRef: string | null;
    if (input.provider === "openai-codex") {
      const existingRef = existing?.provider === "openai-codex" ? existing.credentialRef : null;
      credentialRef = this.pendingOpenAiCodexCredential
        ? await this.credentials.save(
            JSON.stringify(this.pendingOpenAiCodexCredential),
            existingRef
          )
        : existingRef;
      if (!credentialRef) throw new Error("errors.ai.oauthNotConnected");
    } else {
      credentialRef = input.apiKey
        ? await this.credentials.save(input.apiKey, existing?.credentialRef)
        : (existing?.credentialRef ?? null);
    }
    const record = await repository.upsertProvider({
      ...(input.id ? { id: input.id } : {}),
      provider: input.provider,
      displayName: input.displayName,
      credentialRef,
      baseUrl: input.baseUrl ?? defaultBaseUrl(input.provider),
      defaultParameters: normalizeAiModelParameters(input.defaultParameters, parameterCapabilities),
      metadata: {
        modelId: input.modelId,
        capabilities,
        ...(known ? { modelLimits: modelLimits as JsonObject } : {})
      }
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
    const models = (await adapter.listModels?.()) ?? [],
      repository = createAiConfigRepository(this.requirePool()),
      config = (await repository.listProviders()).find((p) => p.id === providerId);
    if (config) {
      for (const model of models) {
        const limits = discoveredModelLimits(model.limits);
        if (discoveredContextWindow({ modelLimits: limits }))
          this.discoveredContexts.set(
            this.contextKey(config.provider, config.baseUrl, model.modelId),
            limits
          );
      }
      const known = this.discoveredContexts.get(
        this.contextKey(config.provider, config.baseUrl, String(config.metadata.modelId))
      );
      if (known)
        await repository.cacheProviderModelContext(
          config.id,
          config.provider,
          String(config.metadata.modelId),
          config.baseUrl,
          known
        );
    }
    return models.map((model) => model.modelId);
  }

  public async discoverModels(input: AiModelDiscoveryInput): Promise<string[]> {
    const baseUrl = input.baseUrl ?? defaultBaseUrl(input.provider);
    const adapter =
      input.provider === "openai-codex"
        ? this.createPendingOpenAiCodexAdapter()
        : input.provider === "google"
          ? new GoogleGeminiAdapter({
              apiKey: input.apiKey!,
              modelId: "",
              capabilities: [],
              baseUrl,
              ...this.runtimeOption()
            })
          : new OpenAiCompatibleAdapter({
              apiKey: input.apiKey!,
              modelId: "",
              capabilities: [],
              baseUrl,
              ...this.runtimeOption()
            });
    const models = (await adapter.listModels?.()) ?? [];
    for (const model of models) {
      const limits = discoveredModelLimits(model.limits);
      if (discoveredContextWindow({ modelLimits: limits }))
        this.discoveredContexts.set(
          this.contextKey(input.provider, baseUrl, model.modelId),
          limits
        );
    }
    const modelIds = models.map((model) => model.modelId);
    return [...new Set(modelIds)].sort((left, right) => left.localeCompare(right));
  }

  public getParameterCapabilities(
    input: AiParameterCapabilitiesInput
  ): AiModelParameterCapabilities {
    const result = providerParameterCapabilities({
      provider: input.provider,
      modelId: input.modelId,
      baseUrl: input.baseUrl ?? defaultBaseUrl(input.provider),
      capabilities: input.capabilities
    });
    const known = discoveredContextWindow({
      modelLimits: this.discoveredContexts.get(
        this.contextKey(input.provider, input.baseUrl ?? null, input.modelId)
      )
    });
    if (known && result.contextWindow) result.contextWindow.max = known;
    return result;
  }

  public async connectOpenAiCodex(): Promise<string[]> {
    if (!this.options.openExternal) throw new Error("errors.ai.oauthLoginFailed");
    const t = createTranslator((await this.options.getUiLanguage?.()) ?? "en");
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
    return (await repository.listProfiles()).map(mapProfile);
  }

  public async createProfile(input: AiProfileCreate): Promise<AiProfile> {
    return mapProfile(
      await createAiConfigRepository(this.requirePool()).createProfile({
        name: input.name,
        isDefault: input.isDefault,
        privacyMode: input.privacyMode,
        outputLanguage: input.outputLanguage,
        ...(input.description !== undefined ? { description: input.description } : {})
      })
    );
  }

  public async updateProfile(input: AiProfileUpdate): Promise<AiProfile> {
    const repository = createAiConfigRepository(this.requirePool());
    let modelCapabilities: AiCapability[] | undefined;
    if (input.modelId !== undefined) {
      if (input.localModelId) {
        const localModel = await createLocalModelRepository(this.requirePool()).findById(
          input.localModelId
        );
        if (!localModel || localModel.status !== "ready")
          throw new Error("errors.localModels.notReady");
        // A ranker exposes `reranking` only once it is validated for decide (rules/ai.md); until
        // then it serves no task, and a profile cannot take it.
        if (
          !aiConfigurableTaskSchema.options.some((task) =>
            supportsTask(task, localModel.capabilities)
          )
        )
          throw new Error("errors.localModels.rankerNotValidated");
        if (
          localModel.runtime !== input.runtime ||
          localModel.modelId !== input.modelId ||
          !input.capabilities?.every((capability) => localModel.capabilities.includes(capability))
        ) {
          throw new Error("errors.ai.noCompatibleModel");
        }
        modelCapabilities = parseCapabilities(localModel.capabilities);
      } else {
        const provider = (await repository.listProviders()).find(
          (candidate) => candidate.id === input.providerConfigId
        );
        const capabilities = parseCapabilities(provider?.metadata.capabilities);
        if (
          !provider ||
          provider.metadata.modelId !== input.modelId ||
          !input.capabilities?.every((capability) => capabilities.includes(capability))
        ) {
          throw new Error("errors.ai.noCompatibleModel");
        }
        modelCapabilities = capabilities;
      }
    }
    const updated = mapProfile(
      await repository.updateProfile({
        id: input.id,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.modelId !== undefined
          ? { privacyMode: input.localModelId ? "offline_only" : "allow_remote" }
          : {}),
        ...(input.outputLanguage !== undefined ? { outputLanguage: input.outputLanguage } : {}),
        ...(input.providerConfigId !== undefined
          ? { providerConfigId: input.providerConfigId }
          : {}),
        ...(input.localModelId !== undefined ? { localModelId: input.localModelId } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
        ...(modelCapabilities !== undefined ? { capabilities: modelCapabilities } : {})
      })
    );
    if (input.modelId) await this.seedTaskRoutes(repository);
    return updated;
  }

  /**
   * Routes every task that has no route to the first configured profile that can serve it: the default
   * profile first, then the oldest. Existing routes and task parameters are never changed. When the
   * default profile runs on this machine, only profiles that run on this machine are candidates: a
   * remote model never inherits a task the user kept local by choosing a local default.
   *
   * The class routes follow (D18): `class:write-fast` takes the writer route's profile (the one that
   * summarizes) when it can write structured output, and `class:decide` takes a profile whose model
   * is a validated dedicated ranker, the MLX one first when this machine runs MLX, else the GGUF
   * one. A dedicated ranker serves only `class:decide`: the task routes carry prompts.
   */
  private async seedTaskRoutes(
    repository: ReturnType<typeof createAiConfigRepository>
  ): Promise<string[]> {
    const routes = new Map(
      (await repository.listTaskRoutes()).map((route) => [route.task, route.profileId])
    );
    const missing = aiConfigurableTaskSchema.options.filter((task) => !routes.has(task));
    if (missing.length === 0 && routes.has(writeFastRouteKey) && routes.has(decideRouteKey))
      return [];
    const configured = (await repository.listProfiles())
      .filter(
        (profile) =>
          profile.status === "active" &&
          profile.modelId &&
          (profile.providerConfigId || profile.localModelId)
      )
      .toSorted(
        (left, right) =>
          Number(right.isDefault) - Number(left.isDefault) ||
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id)
      );
    // The first profile is the default one, or the oldest when the default is not configured.
    const profiles = configured[0]?.localModelId
      ? configured.filter((profile) => profile.localModelId)
      : configured;
    const promptProfiles = profiles.filter(
      (profile) => !isDedicatedRanker(parseCapabilities(profile.capabilities))
    );
    const seeded: string[] = [];
    for (const task of missing) {
      const profile = promptProfiles.find((candidate) =>
        supportsTask(task, candidate.capabilities)
      );
      if (profile && (await repository.seedTaskRoute(task, profile.id))) {
        seeded.push(task);
        routes.set(task, profile.id);
      }
    }
    if (!routes.has(writeFastRouteKey)) {
      const writerId = routes.get("summarization");
      const writer = promptProfiles.find(
        (profile) =>
          profile.id === writerId && supportsTask("structured-output", profile.capabilities)
      );
      if (writer && (await repository.seedTaskRoute(writeFastRouteKey, writer.id)))
        seeded.push(writeFastRouteKey);
    }
    if (!routes.has(decideRouteKey)) {
      const ranker = await this.preferredValidatedRanker(profiles);
      if (ranker && (await repository.seedTaskRoute(decideRouteKey, ranker.id)))
        seeded.push(decideRouteKey);
    }
    return seeded;
  }

  /** The profile whose model is a validated ranker this machine can run: MLX first, else GGUF. */
  private async preferredValidatedRanker(
    profiles: readonly AiProfileRecord[]
  ): Promise<AiProfileRecord | null> {
    const machine = this.options.machine ?? { platform: process.platform, arch: process.arch };
    const runsMlx = machine.platform === "darwin" && machine.arch === "arm64";
    const models = createLocalModelRepository(this.requirePool());
    const validated: Array<{ profile: AiProfileRecord; runtime: string }> = [];
    for (const profile of profiles) {
      if (!profile.localModelId || !isDedicatedRanker(parseCapabilities(profile.capabilities)))
        continue;
      const model = await models.findById(profile.localModelId);
      const entry = model ? findLocalModelCatalogEntry(model.catalogId) : undefined;
      if (!model || !entry || !rankerReadyForDecide(model, entry)) continue;
      if (model.runtime === "mlx" && !runsMlx) continue;
      validated.push({ profile, runtime: model.runtime });
    }
    return (
      validated.find((candidate) => candidate.runtime === "mlx")?.profile ??
      validated.find((candidate) => candidate.runtime === "gguf")?.profile ??
      null
    );
  }

  public async cloneProfile(profileId: string, name: string): Promise<AiProfile> {
    return mapProfile(
      await createAiConfigRepository(this.requirePool()).cloneProfile(profileId, name)
    );
  }

  public async deleteProfile(profileId: string): Promise<boolean> {
    return createAiConfigRepository(this.requirePool()).deleteProfile(profileId);
  }

  /** Profile tasks of the configurable tasks; class and operation routes are not settings yet. */
  public async listProfileTasks(profileId?: string): Promise<AiProfileTask[]> {
    return (await createAiConfigRepository(this.requirePool()).listProfileTasks(profileId))
      .filter((task) => isConfigurableTask(task.task))
      .map((task) => ({
        ...task,
        task: task.task as AiProfileTask["task"],
        parameters: aiModelParametersSchema.parse(task.parameters)
      }));
  }

  /** Routes of the configurable tasks; class and operation routes are not settings yet. */
  public async listTaskRoutes(): Promise<AiTaskRoute[]> {
    return (await createAiConfigRepository(this.requirePool()).listTaskRoutes())
      .filter((route) => isConfigurableTask(route.task))
      .map((route) => ({
        task: route.task as AiTaskRoute["task"],
        profileId: route.profileId
      }));
  }

  public async setTaskRoute(input: AiTaskRoute): Promise<void> {
    const repository = createAiConfigRepository(this.requirePool());
    const profile = (await repository.listProfiles()).find(
      (candidate) => candidate.id === input.profileId
    );
    if (
      !profile ||
      profile.status !== "active" ||
      !profile.modelId ||
      !supportsTask(input.task, profile.capabilities)
    ) {
      throw new Error("errors.ai.noCompatibleModel");
    }
    const configuredTask = (await repository.listProfileTasks(input.profileId)).some(
      (task) => task.task === input.task
    );
    if (!configuredTask) {
      await repository.setProfileTask({
        profileId: input.profileId,
        task: input.task,
        parameters: {}
      });
    }
    await repository.setTaskRoute(input.task, input.profileId);
  }

  public async setProfileTask(input: AiProfileTaskInput): Promise<void> {
    const repository = createAiConfigRepository(this.requirePool());
    const profile = (await repository.listProfiles()).find(
      (candidate) => candidate.id === input.profileId
    );
    if (!profile) throw new Error("errors.common.notFound");
    if (!profile.modelId || !supportsTask(input.task, profile.capabilities)) {
      throw new Error("errors.ai.noCompatibleModel");
    }
    const parameterCapabilities = await this.parameterCapabilitiesForProfile(profile);
    await repository.setProfileTask({
      profileId: input.profileId,
      task: input.task,
      fallbackPolicy: "block",
      parameters: normalizeAiModelParameters(input.parameters, parameterCapabilities)
    });
  }

  public async describePromptRoute(task: string) {
    const selection = await createAiConfigRepository(this.requirePool()).getDefaultTask(task);
    return selection
      ? {
          provider: selection.provider,
          modelId: selection.modelId,
          repository: selection.repository
        }
      : null;
  }

  public async pinOrganizationProfile(
    profileId: string | undefined,
    _legacyPrivacy: "offline_only" | "allow_remote"
  ): Promise<OrganizationProfile> {
    const repository = createAiConfigRepository(this.requirePool());
    const selection = await repository.getDefaultTask("structured-output", profileId);
    if (!selection || !selection.requiredCapabilities.includes("structured-output"))
      throw new Error("organization.errors.model");
    const effectivePrivacy = selection.localModelId ? "offline_only" : "allow_remote";
    const parameters = aiModelParametersSchema.parse(
      withAiTaskParameterDefaults(
        "structured-output",
        { ...selection.modelDefaultParameters, ...selection.parameters },
        Boolean(selection.localModelId),
        { contextWindowLimit: discoveredContextWindow(selection.providerMetadata) }
      )
    );
    const identityHash = sha256(
      JSON.stringify({
        profileId: selection.profileId,
        providerConfigId: selection.providerConfigId,
        localModelId: selection.localModelId,
        modelId: selection.modelId,
        runtime: selection.runtime,
        revision: selection.revision,
        baseUrl: selection.baseUrl,
        privacy: effectivePrivacy
      })
    );
    return OrganizationProfileSchema.parse({
      profileId: selection.profileId,
      providerConfigId: selection.providerConfigId,
      localModelId: selection.localModelId,
      provider: selection.provider,
      modelId: selection.modelId,
      runtime: selection.runtime,
      revision: selection.revision,
      privacy: effectivePrivacy,
      parameters,
      identityHash,
      contextWindow: parameters.contextWindow ?? null
    });
  }

  public async runConsultationEmbedding(
    text: string,
    _legacyPrivacy: "offline_only" | "allow_remote",
    sourceItemIds: string[],
    signal: AbortSignal,
    priority?: AiQueuePriority
  ) {
    return this.admitTask(
      "embedding",
      text,
      {
        stage: "wiki_consultation",
        embeddingInputType: "query",
        sourceItemIds,
        ...(priority ? { priority } : {})
      },
      signal
    );
  }

  public async runOrganizationTask(
    profile: OrganizationProfile,
    input: string,
    context: AiTaskLogContext,
    signal: AbortSignal,
    maxOutputTokens: number,
    beforeExecute?: () => Promise<void>
  ): Promise<DefaultAiTaskResult> {
    const pinned = OrganizationProfileSchema.parse(profile);
    const result = await this.admitTask(
      "structured-output",
      input,
      context,
      signal,
      { maxOutputTokens },
      pinned,
      beforeExecute
    );
    if (!result) throw new Error("organization.errors.model");
    return result;
  }

  public async runDefaultTask(
    taskType:
      | "text-generation"
      | "embedding"
      | "summarization"
      | "knowledge-graph-generation"
      | "atomic-note-generation"
      | "reranking"
      | "structured-output",
    input: string,
    logContext: AiTaskLogContext = {},
    signal?: AbortSignal,
    limits?: { maxOutputTokens: number }
  ): Promise<DefaultAiTaskResult | null> {
    return this.admitTask(taskType, input, logContext, signal, limits);
  }

  private async preparePromptAdmission(
    task: RoutedTask,
    input: string,
    context: AiTaskLogContext,
    pin: PromptPin,
    baseAudit: PromptCompositionSnapshot[],
    pinned?: OrganizationProfile
  ): Promise<PromptAdmission | null> {
    const repository = createAiConfigRepository(this.requirePool());
    const routeKeys = taskRouteKeys(task, context);
    let found = await repository.getDefaultTask(task, pinned?.profileId, routeKeys);
    // A task without a route is routed to the first configured profile that can serve it. A concurrent
    // call may have created the route first, so the task is looked up again whatever this call seeded.
    if (!found && !pinned) {
      await this.seedTaskRoutes(repository);
      found = await repository.getDefaultTask(task, undefined, routeKeys);
    }
    const selection = found ? structuredClone(found) : null;
    if (!selection) {
      if (pinned) throw new Error("organization.errors.model");
      return null;
    }
    const language = context.contentLanguage ?? (await this.options.getContentLanguage?.()) ?? "en";
    return withPromptPin(pin, () => {
      const prepared =
        task === "embedding"
          ? withEmbeddingInputInstruction(
              baseAudit.length
                ? input
                : renderPrompt(
                    context.embeddingInputType === "query"
                      ? "embedding.query"
                      : "embedding.content.chunk",
                    context.embeddingInputType === "query"
                      ? { query: input }
                      : { source_text: input }
                  ),
              selection.modelId,
              selection.repository,
              context.embeddingInputType
            )
          : baseAudit.some((s) => s.promptId.startsWith("diagnostics."))
            ? input
            : withOutputLanguageInstruction(input, language);
      const instruction =
        selection.provider === "openai-codex"
          ? renderPrompt("shared.codex_adapter_instruction")
          : "";
      return {
        selection,
        input: prepared,
        instruction,
        compositions: [...baseAudit, ...promptAudit(prepared), ...promptAudit(instruction)],
        pin,
        language
      };
    });
  }

  private async admitTask(
    task: RoutedTask,
    input: string,
    context: AiTaskLogContext,
    signal?: AbortSignal,
    limits?: { maxOutputTokens: number },
    pinned?: OrganizationProfile,
    beforeProvider?: () => Promise<void>
  ): Promise<DefaultAiTaskResult | null> {
    const pin = capturePromptPin(),
      baseAudit = context.promptCompositions ?? promptAudit(input);
    // Reserve FIFO order synchronously, while source-free routing preparation runs without model loading or telemetry.
    const prepared = this.preparePromptAdmission(task, input, context, pin, baseAudit, pinned).then(
      (value) => ({ value }),
      (error) => ({ error })
    );
    let entered = false,
      admission: PromptAdmission | null = null;
    // Time spent waiting for the execution slot does not count against the caller's own timeout.
    const deadline = ActiveDeadline.of(signal);
    deadline?.pause();
    let waiting = true;
    const stopWaiting = () => {
      if (!waiting) return;
      waiting = false;
      deadline?.resume();
    };
    try {
      return await aiExecutionQueue.run(
        (timing) =>
          withPromptPin(pin, async () => {
            stopWaiting();
            const result = await prepared;
            if ("error" in result) throw result.error;
            admission = result.value ? { ...result.value, queueMs: timing.queueMs } : null;
            if (!admission) return null;
            await beforeProvider?.();
            signal?.throwIfAborted();
            entered = true;
            return this.executeDefaultTask(
              task,
              input,
              context,
              signal,
              limits,
              pinned,
              beforeProvider,
              admission
            );
          }),
        signal,
        { priority: aiTaskPriority(context) }
      );
    } catch (error) {
      if (!entered || !admission || (error && typeof error === "object" && "aiTaskRunId" in error))
        throw error;
      const completed = admission as PromptAdmission,
        selection = completed.selection;
      const aiTaskRunId = await createAiConfigRepository(this.requirePool()).recordTaskRun({
        profileId: selection.profileId,
        taskType: task,
        provider: selection.provider,
        modelId: selection.modelId,
        runtime: selection.runtime,
        parameters: pinned?.parameters ?? {
          ...selection.modelDefaultParameters,
          ...selection.parameters
        },
        promptCompositions: completed.compositions,
        inputHash: sha256(completed.input),
        durationMs: 0,
        ...queueAndAttempt(completed, context),
        status: signal?.aborted ? "canceled" : "failed",
        error: redactSensitiveText(error),
        sourceItemIds: taskSourceItemIds(context)
      });
      if (error instanceof Error) Object.assign(error, { aiTaskRunId });
      throw error;
    } finally {
      stopWaiting();
    }
  }

  private async executeDefaultTask(
    taskType:
      | "text-generation"
      | "embedding"
      | "summarization"
      | "knowledge-graph-generation"
      | "atomic-note-generation"
      | "reranking"
      | "structured-output",
    input: string,
    logContext: AiTaskLogContext,
    signal?: AbortSignal,
    limits?: { maxOutputTokens: number },
    pinned?: OrganizationProfile,
    beforeProvider?: () => Promise<void>,
    admission?: PromptAdmission
  ): Promise<DefaultAiTaskResult | null> {
    const { onProgress, onProviderStart, ...structuredLogContext } = logContext;
    const sourceItemIds = taskSourceItemIds(structuredLogContext);
    const repository = createAiConfigRepository(this.requirePool());
    const selection =
      admission?.selection ??
      (await repository.getDefaultTask(
        taskType,
        pinned?.profileId,
        taskRouteKeys(taskType, logContext)
      ));
    if (!selection) {
      if (pinned) throw new Error("organization.errors.model");
      return null;
    }
    if (pinned) {
      const current = await this.pinOrganizationProfile(pinned.profileId, pinned.privacy);
      if (current.identityHash !== pinned.identityHash)
        throw new Error("organization.errors.modelChanged");
    }
    let parameters = aiModelParametersSchema.parse(
      withAiTaskParameterDefaults(
        taskType,
        pinned?.parameters ?? { ...selection.modelDefaultParameters, ...selection.parameters },
        Boolean(selection.localModelId),
        {
          admitted: !!pinned,
          contextWindowLimit: discoveredContextWindow(selection.providerMetadata),
          operation: logContext.operation
        }
      )
    );
    if (limits)
      parameters.maxTokens = Math.min(
        parameters.maxTokens ?? 16384,
        Math.max(1, Math.floor(limits.maxOutputTokens))
      );
    const plannedOutputTokens = parameters.maxTokens ?? 16384;
    if (!selection.localModelId) {
      const caps = providerParameterCapabilities({
        provider: selection.provider as AiProviderConfig["provider"],
        modelId: selection.modelId,
        baseUrl: selection.baseUrl,
        capabilities: parseCapabilities(
          selection.providerMetadata?.capabilities ?? selection.requiredCapabilities
        )
      });
      parameters = normalizeAiModelParameters(parameters, caps);
    }
    const outputLanguage =
      admission?.language ??
      logContext.contentLanguage ??
      (await this.options.getContentLanguage?.()) ??
      "en";
    const taskInput =
      admission?.input ??
      (taskType === "embedding"
        ? withEmbeddingInputInstruction(
            input,
            selection.modelId,
            selection.repository,
            structuredLogContext.embeddingInputType
          )
        : withOutputLanguageInstruction(input, outputLanguage));
    const keepLocalEmbeddingModelLoaded =
      taskType === "embedding" && selection.localModelId
        ? ((await this.options.getKeepLocalEmbeddingModelsLoaded?.()) ?? true)
        : true;
    const started = Date.now();
    const capture = await this.options.monitoring?.start({
      kind: "ai",
      operation: logContext.operation ?? logContext.stage ?? taskType,
      taskType,
      stage: logContext.stage ?? taskType,
      context: {
        ...structuredLogContext,
        origin:
          logContext.origin ??
          (logContext.ingestionRunId ? "ingestion" : logContext.jobId ? "job" : "interactive"),
        sourceItemIds,
        providerConfigId: selection.providerConfigId,
        localModelId: selection.localModelId,
        repository: selection.repository,
        revision: selection.revision,
        quantization: selection.quantization
      },
      sourceItemIds,
      provider: selection.provider,
      modelId: selection.modelId,
      runtime: selection.runtime,
      profileId: selection.profileId,
      parameters,
      input: taskInput
    });
    try {
      if (
        taskType !== "embedding" &&
        parameters.contextWindow &&
        (!selection.localModelId || selection.runtime === "mlx")
      ) {
        const plannedTokens = estimateAiPlanningTokens(
          taskInput,
          selection.provider === "openai-codex"
            ? (admission?.instruction ?? renderPrompt("shared.codex_adapter_instruction"))
            : "",
          plannedOutputTokens
        );
        if (plannedTokens > parameters.contextWindow)
          throw new Error("errors.ai.contextWindowLimit");
      }
      // The route key that chose the profile names the profile task to compare with.
      const currentSelection = await repository.getDefaultTask(
        selection.routeKey ?? taskType,
        selection.profileId
      );
      if (!currentSelection || selectionIdentity(currentSelection) !== selectionIdentity(selection))
        throw new Error("organization.errors.modelChanged");
      const configuredAdapter = selection.localModelId
        ? await this.createLocalAdapter(selection.localModelId)
        : await this.createAdapter(selection.providerConfigId ?? "");
      const descriptor = configuredAdapter.describe();
      const requiredCapabilities = requiredCapabilitiesForRun(taskType, descriptor.capabilities);
      parameters = normalizeAiModelParameters(parameters, descriptor.parameterCapabilities);
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
      const adapter = this.registry.resolve({
        providerId: descriptor.providerId,
        modelId: descriptor.modelId,
        requiredCapabilities,
        offlineOnly: Boolean(selection.localModelId)
      });
      const request: AiTaskRequest = {
        taskType,
        input: taskInput,
        profileId: selection.profileId,
        modelId: selection.modelId,
        requiredCapabilities,
        parameters,
        metadata: {
          applicationInstruction:
            admission?.instruction ?? renderPrompt("shared.codex_adapter_instruction")
        },
        // A stated class sets the remote deadlines; the operation names the caller.
        ...(logContext.workloadClass ? { workloadClass: logContext.workloadClass } : {}),
        ...requestOperation(logContext.operation)
      };
      const progress = createProgressReporter(onProgress);
      const run = async () => {
        await beforeProvider?.();
        signal?.throwIfAborted();
        if (
          pinned &&
          (await this.pinOrganizationProfile(pinned.profileId, pinned.privacy)).identityHash !==
            pinned.identityHash
        )
          throw new Error("organization.errors.modelChanged");
        await onProviderStart?.();
        // Remote generation always streams, so its connect, first-byte and stall deadlines apply.
        return adapter.runStreaming && runsStreaming(adapter, taskType)
          ? adapter.runStreaming(request, signal, progress)
          : adapter.run(request, signal);
      };
      const runLocal = async () => {
        const needsLoad =
          taskType === "embedding" && adapter.isLoaded?.() === false && adapter.ensureLoaded;
        if (needsLoad) {
          this.options.onLocalEmbeddingLoadStatus?.({
            state: "loading",
            modelId: selection.modelId
          });
          try {
            await adapter.ensureLoaded?.(signal);
            this.options.onLocalEmbeddingLoadStatus?.({
              state: "ready",
              modelId: selection.modelId
            });
          } catch (error) {
            this.options.onLocalEmbeddingLoadStatus?.({
              state: "failed",
              modelId: selection.modelId
            });
            throw error;
          }
        }
        return run();
      };
      progress({ progress: 0.02 });
      const result = selection.localModelId
        ? await this.withLocalModelUsage(selection.localModelId, runLocal)
        : await run();
      progress({ progress: 1 });
      const aiTaskRunId = await repository.recordTaskRun({
        profileId: selection.profileId,
        taskType,
        provider: result.providerId,
        modelId: result.modelId,
        runtime: selection.localModelId ? selection.runtime : result.runtime,
        capabilitiesUsed: requiredCapabilities,
        adapter: result.tokenUsage?.[aiCassetteReplayedUsageKey]
          ? "cassette-replay"
          : selection.localModelId
            ? localAdapterName(selection.runtime)
            : result.providerId,
        repository: selection.repository,
        revision: selection.revision,
        quantization: selection.quantization,
        parameters: auditedParameters(parameters, result.requestOptions),
        promptCompositions: admission?.compositions ?? promptAudit(taskInput),
        inputHash: sha256(taskInput),
        outputHash: sha256(JSON.stringify(result.output)),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {}),
        durationMs: result.durationMs,
        ...queueAndAttempt(admission, logContext),
        status: "succeeded",
        sourceItemIds
      });
      await this.options.monitoring?.finish(capture, {
        status: "succeeded",
        aiTaskRunId,
        durationMs: Date.now() - started,
        tokenUsage: monitoringUsage(result),
        parameters: auditedParameters(parameters, result.requestOptions),
        output: result.output,
        ...(result.attempts !== undefined
          ? { details: callDetails(result.attempts, result.retriedUsage) }
          : {}),
        ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {})
      });
      if (selection.localModelId && taskType === "embedding" && !keepLocalEmbeddingModelLoaded) {
        await this.releaseLocalModel(selection.localModelId).catch((error) => {
          this.options.logger?.error("Failed to release local embedding runtime", error);
        });
      }
      return {
        ...result,
        profileId: selection.profileId,
        aiTaskRunId,
        outputLanguage,
        embeddingSpaceKey: embeddingSpaceKey(
          { ...selection, parameters, promptStrategy: embeddingPromptIdentity() },
          result
        )
      };
    } catch (error) {
      // What the failed call cost and the wire options of its last request, which may be a fallback.
      const failedReport = remoteCallReport(error);
      const aiTaskRunId = await repository.recordTaskRun({
        profileId: selection.profileId,
        taskType,
        provider: selection.provider,
        modelId: selection.modelId,
        runtime: selection.runtime,
        adapter: selection.localModelId ? localAdapterName(selection.runtime) : selection.provider,
        repository: selection.repository,
        revision: selection.revision,
        quantization: selection.quantization,
        parameters: auditedParameters(parameters, failedReport?.requestOptions),
        promptCompositions: admission?.compositions ?? promptAudit(taskInput),
        inputHash: sha256(taskInput),
        durationMs: Date.now() - started,
        ...queueAndAttempt(admission, logContext),
        ...failedCallUsage(error),
        status: signal?.aborted ? "canceled" : "failed",
        error: redactSensitiveText(error),
        sourceItemIds
      });
      await this.options.monitoring?.finish(capture, {
        status: signal?.aborted ? "canceled" : "failed",
        aiTaskRunId,
        durationMs: Date.now() - started,
        error: redactSensitiveText(error),
        parameters: auditedParameters(parameters, failedReport?.requestOptions),
        ...(failedReport
          ? {
              tokenUsage: failedMonitoringUsage(failedReport.failedUsage),
              details: callDetails(failedReport.attempts, failedReport.failedUsage)
            }
          : {})
      });
      if (taskType === "atomic-note-generation") {
        logStructuredError(
          this.options.logger,
          "atomic_note_ai_task_failed",
          {
            ...structuredLogContext,
            stage: structuredLogContext.stage ?? "ai_execution",
            taskType,
            profileId: selection.profileId,
            providerId: selection.provider,
            modelId: selection.modelId,
            runtime: selection.runtime,
            aiTaskRunId
          },
          error,
          "atomic_note_ai_task_failed"
        );
      }
      if (selection.localModelId && taskType === "embedding" && !keepLocalEmbeddingModelLoaded) {
        await this.releaseLocalModel(selection.localModelId).catch((releaseError) => {
          this.options.logger?.error("Failed to release local embedding runtime", releaseError);
        });
      }
      if (error instanceof Error) Object.assign(error, { aiTaskRunId });
      throw error;
    }
  }

  public async traceOperation<T>(
    operation: string,
    context: AiTaskLogContext,
    run: () => Promise<T>,
    details: Record<string, unknown> = {}
  ): Promise<T> {
    const { onProgress: _progress, onProviderStart: _providerStart, ...metadata } = context;
    return this.options.monitoring
      ? this.options.monitoring.operation(operation, metadata, run, details)
      : run();
  }

  public isLocalModelInUse(localModelId: string): boolean {
    return this.activeLocalModels.has(localModelId);
  }

  /**
   * Releases the resident local models that are not running a call (all of them with `force`).
   * The ranker stays loaded (D18), and so does an embedding model when `keepEmbedding` is set, so a
   * gate call between two embedding calls reloads neither. A released MLX model leaves the shared
   * helper, which is stopped once no MLX call runs.
   */
  public async releaseLocalRuntime(force = false, keepEmbedding = false): Promise<void> {
    for (const slot of residencySlots) {
      const occupant = this.resident[slot];
      if (!occupant) continue;
      if (!force) {
        if (this.activeLocalModels.has(occupant.localModelId)) continue;
        if (slot === "rank") continue;
        if (keepEmbedding && occupant.adapter.describe().capabilities.includes("embedding"))
          continue;
      }
      await this.releaseSlot(slot);
    }
    await this.stopIdleMlxHelper(force);
  }

  public async dispose(): Promise<void> {
    await this.releaseLocalRuntime(true);
  }

  /**
   * Ranks documents against a query on the validated dedicated ranker of the operation's route:
   * its operation override, else `class:decide`, never the prompt route of the `reranking` task
   * and never a generative model (D17, D18). It fails visibly when no such ranker is routed, when
   * the route's model is not one, or when its decide validation does not hold for the installed
   * artifact and the runtime build it is about to run on. The call runs in the AI queue like any
   * other (background unless stated) with no language instruction, generation defaults or context
   * check, and is audited with the evaluated tokens and cost 0.
   */
  public async rank(input: AiRankInput, signal?: AbortSignal): Promise<AiRankResult> {
    const request = parseRankRequest({
      instruction: input.instruction,
      query: input.query,
      documents: input.documents
    });
    const pin = capturePromptPin();
    const compositions = input.promptCompositions ?? promptAudit(input.instruction);
    const deadline = ActiveDeadline.of(signal);
    deadline?.pause();
    let waiting = true;
    const stopWaiting = () => {
      if (!waiting) return;
      waiting = false;
      deadline?.resume();
    };
    try {
      return await aiExecutionQueue.run(
        (timing) =>
          withPromptPin(pin, () => {
            stopWaiting();
            return this.executeRank(input, request, compositions, timing.queueMs, signal);
          }),
        signal,
        { priority: input.priority ?? "background" }
      );
    } finally {
      stopWaiting();
    }
  }

  /** Whether rank calls of an operation have a ranker to run on (see {@link DecideRouteStatus}). */
  public async decideRouteStatus(operation?: string): Promise<DecideRouteStatus> {
    try {
      await this.resolveDecideRoute(createAiConfigRepository(this.requirePool()), operation);
      return "ready";
    } catch (error) {
      const key = error instanceof Error ? error.message : "";
      if (key === "errors.ai.noCompatibleModel") return "missing";
      if (key === "errors.ai.unsupportedTask") return "incompatible";
      if (key === "errors.localModels.notReady") return "not_ready";
      if (key === "errors.localModels.rankerNotValidated") return "not_validated";
      throw error;
    }
  }

  /**
   * The embedding space the routed embedding model writes to, computed without an AI call (D26)
   * the way an embedding call computes it, and compared with the newest stored note vector. Null
   * when no embedding model is routed.
   */
  public async activeEmbeddingSpace(): Promise<ActiveEmbeddingSpace | null> {
    const pool = this.requirePool();
    const repository = createAiConfigRepository(pool);
    let selection = await repository.getDefaultTask("embedding");
    if (!selection) {
      await this.seedTaskRoutes(repository);
      selection = await repository.getDefaultTask("embedding");
    }
    if (!selection) return null;
    const parameters = await this.embeddingCallParameters(selection);
    const spaceKey = embeddingSpaceKey(
      { ...selection, parameters, promptStrategy: embeddingPromptIdentity() },
      {
        // What the embedding adapters report: the routed model, `local-<runtime>` or the provider.
        providerId: selection.provider,
        modelId: selection.modelId,
        runtime: selection.localModelId ? "local" : "remote"
      }
    );
    const newest = await createEmbeddingRepository(pool).newestNoteVectorSpace();
    return {
      spaceKey,
      profileId: selection.profileId,
      provider: selection.provider,
      modelId: selection.modelId,
      local: Boolean(selection.localModelId),
      dimensions: typeof parameters.dimensions === "number" ? parameters.dimensions : null,
      newestNoteSpaceKey: newest?.spaceKey ?? null,
      confirmed: newest?.spaceKey === spaceKey
    };
  }

  /** The effective parameters of an embedding call on this route, as `executeDefaultTask` sets them. */
  private async embeddingCallParameters(selection: TaskSelection): Promise<JsonObject> {
    let parameters = aiModelParametersSchema.parse(
      withAiTaskParameterDefaults(
        "embedding",
        { ...selection.modelDefaultParameters, ...selection.parameters },
        Boolean(selection.localModelId),
        { contextWindowLimit: discoveredContextWindow(selection.providerMetadata) }
      )
    );
    if (selection.localModelId) {
      const model = await createLocalModelRepository(this.requirePool()).findById(
        selection.localModelId
      );
      if (!model) throw new Error("errors.localModels.notReady");
      return normalizeAiModelParameters(
        parameters,
        localModelParameterCapabilities(model, parseCapabilities(model.capabilities))
      );
    }
    const provider = selection.provider as AiProviderConfig["provider"];
    parameters = normalizeAiModelParameters(
      parameters,
      providerParameterCapabilities({
        provider,
        modelId: selection.modelId,
        baseUrl: selection.baseUrl,
        capabilities: parseCapabilities(
          selection.providerMetadata?.capabilities ?? selection.requiredCapabilities
        )
      })
    );
    // The adapter's own descriptor, built from the provider configuration (`createAdapter`).
    return normalizeAiModelParameters(
      parameters,
      providerParameterCapabilities({
        provider,
        modelId:
          typeof selection.providerMetadata.modelId === "string"
            ? selection.providerMetadata.modelId
            : "",
        baseUrl: selection.baseUrl,
        capabilities: parseCapabilities(selection.providerMetadata.capabilities)
      })
    );
  }

  /**
   * The validated ranker that serves rank calls of an operation: the `op:<operation>` route, else
   * `class:decide`, seeded on first use like any route. Throws the localized reason otherwise.
   */
  private async resolveDecideRoute(
    repository: ReturnType<typeof createAiConfigRepository>,
    operation: string | undefined
  ): Promise<{ selection: TaskSelection; model: LocalModelRecord; entry: LocalModelCatalogEntry }> {
    const keys = [...(operation ? [operationRouteKey(operation)] : []), decideRouteKey];
    let found = await repository.getDefaultTask(decideRouteKey, undefined, keys);
    if (!found) {
      await this.seedTaskRoutes(repository);
      found = await repository.getDefaultTask(decideRouteKey, undefined, keys);
    }
    if (!found) throw new Error("errors.ai.noCompatibleModel");
    // A remote or generative model never ranks: there is no generative fallback (D10, D17).
    if (!found.localModelId) throw new Error("errors.ai.unsupportedTask");
    const model = await createLocalModelRepository(this.requirePool()).findById(found.localModelId);
    if (!model || model.status !== "ready" || !model.managedPath)
      throw new Error("errors.localModels.notReady");
    const entry = findLocalModelCatalogEntry(model.catalogId);
    if (!entry || !isRankerCatalogEntry(entry)) throw new Error("errors.ai.unsupportedTask");
    if (!rankerReadyForDecide(model, entry))
      throw new Error("errors.localModels.rankerNotValidated");
    return { selection: structuredClone(found), model, entry };
  }

  private async executeRank(
    input: AiRankInput,
    request: RankRequest,
    compositions: PromptCompositionSnapshot[],
    queueMs: number,
    signal: AbortSignal | undefined
  ): Promise<AiRankResult> {
    signal?.throwIfAborted();
    const repository = createAiConfigRepository(this.requirePool());
    const { selection, model, entry } = await this.resolveDecideRoute(repository, input.operation);
    const sourceItemIds = [...new Set(input.sourceIds ?? [])];
    const taskRequest: AiTaskRequest = {
      ...rankTaskRequest(request),
      profileId: selection.profileId,
      modelId: selection.modelId,
      workloadClass: "decide",
      ...requestOperation(input.operation)
    };
    const taskInput = String(taskRequest.input);
    const adapterName = localAdapterName(model.runtime);
    const audit = {
      profileId: selection.profileId,
      taskType: "reranking",
      provider: selection.provider,
      modelId: selection.modelId,
      runtime: model.runtime,
      adapter: adapterName,
      repository: model.repository,
      revision: model.revision,
      quantization: model.quantization,
      capabilitiesUsed: ["reranking", "offline"],
      parameters: {},
      promptCompositions: compositions,
      inputHash: sha256(taskInput),
      queueMs,
      sourceItemIds
    };
    if (input.jobId) {
      try {
        await createJobRepository(this.requirePool()).setAiExecution(input.jobId, {
          provider: selection.provider,
          modelId: selection.modelId,
          reasoningLevel: null
        });
      } catch (error) {
        this.options.logger?.error("Failed to attach AI execution metadata to job", error);
      }
    }
    const started = Date.now();
    const capture = await this.options.monitoring?.start({
      kind: "ai",
      operation: input.operation,
      taskType: "reranking",
      stage: input.stage ?? input.operation,
      context: {
        origin:
          input.priority === "interactive" ? "interactive" : input.jobId ? "job" : "background",
        ...(input.jobId ? { jobId: input.jobId } : {}),
        workloadClass: "decide",
        routeKey: selection.routeKey,
        sourceItemIds,
        localModelId: model.id,
        repository: model.repository,
        revision: model.revision,
        quantization: model.quantization
      },
      sourceItemIds,
      provider: selection.provider,
      modelId: selection.modelId,
      runtime: model.runtime,
      profileId: selection.profileId,
      parameters: {},
      input: taskInput
    });
    try {
      const { result, output } = await this.withLocalModelUsage(model.id, async () => {
        const ranker = await this.residentRanker(model);
        // The validation holds only for the runtime build it ran on (T11): checked before any call.
        // The build is read once per resident ranker; a failed read is retried by the next call.
        ranker.runtimeBuild ??= (ranker.adapter as RankerAdapter).runtimeBuild().catch((error) => {
          ranker.runtimeBuild = undefined;
          throw error;
        });
        const runtimeBuild = await ranker.runtimeBuild;
        if (
          !isDecideValidationCurrent(model.metadata.decideValidation, {
            runtime: entry.runtime,
            revision: entry.revision,
            artifactSha256: rankerCatalogArtifactSha256(entry),
            runtimeBuild
          })
        )
          throw new Error("errors.localModels.rankerNotValidated");
        const descriptor = ranker.adapter.describe();
        const adapter = this.registry.resolve({
          providerId: descriptor.providerId,
          modelId: descriptor.modelId,
          requiredCapabilities: ["reranking"],
          offlineOnly: true
        });
        signal?.throwIfAborted();
        const ran = await adapter.run(taskRequest, signal);
        return { result: ran, output: readRankResult(ran, request.documents.length) };
      });
      const inputTokens = output.tokenCounts.reduce((total, count) => total + count, 0);
      const aiTaskRunId = await repository.recordTaskRun({
        ...audit,
        outputHash: sha256(JSON.stringify(result.output)),
        inputTokens,
        outputTokens: 0,
        costEstimate: 0,
        durationMs: result.durationMs,
        status: "succeeded"
      });
      await this.options.monitoring?.finish(capture, {
        status: "succeeded",
        aiTaskRunId,
        durationMs: Date.now() - started,
        tokenUsage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
        costEstimate: 0,
        parameters: {},
        output
      });
      return {
        ...output,
        aiTaskRunId,
        profileId: selection.profileId,
        localModelId: model.id,
        provider: selection.provider,
        modelId: selection.modelId,
        runtime: model.runtime,
        durationMs: result.durationMs,
        queueMs
      };
    } catch (error) {
      const aiTaskRunId = await repository.recordTaskRun({
        ...audit,
        durationMs: Date.now() - started,
        status: signal?.aborted ? "canceled" : "failed",
        error: redactSensitiveText(error)
      });
      await this.options.monitoring?.finish(capture, {
        status: signal?.aborted ? "canceled" : "failed",
        aiTaskRunId,
        durationMs: Date.now() - started,
        error: redactSensitiveText(error),
        parameters: {}
      });
      if (error instanceof Error) Object.assign(error, { aiTaskRunId });
      throw error;
    }
  }

  public async testLocalModel(localModelId: string): Promise<string> {
    const pin = capturePromptPin();
    return aiExecutionQueue.run(
      () => withPromptPin(pin, () => this.executeLocalModelTest(localModelId)),
      undefined,
      { priority: "interactive" }
    );
  }

  private async executeLocalModelTest(localModelId: string): Promise<string> {
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model) throw new Error("errors.common.notFound");
    const catalogEntry = findLocalModelCatalogEntry(model.catalogId);
    // A dedicated ranker is validated, not prompted: artifact checks, then the ranking smoke test.
    if (catalogEntry && isRankerCatalogEntry(catalogEntry))
      return this.executeRankerValidation(model, catalogEntry);
    const configuredAdapter = await this.createLocalAdapter(localModelId);
    const descriptor = configuredAdapter.describe();
    const embeddingOnly =
      model.capabilities.includes("embedding") && !model.capabilities.includes("text-generation");
    const taskType = embeddingOnly ? ("embedding" as const) : ("text-generation" as const);
    const requiredCapabilities = embeddingOnly
      ? ["embedding" as const]
      : ["text-generation" as const];
    const adapter = this.registry.resolve({
      providerId: descriptor.providerId,
      modelId: descriptor.modelId,
      requiredCapabilities,
      offlineOnly: true
    });
    const repository = createAiConfigRepository(this.requirePool());
    const input = renderPrompt(
      embeddingOnly ? "diagnostics.local_embedding" : "diagnostics.local_generation"
    );
    const parameters = normalizeAiModelParameters(
      aiModelParametersSchema.parse(
        withAiTaskParameterDefaults(taskType, model.defaultParameters, true)
      ),
      descriptor.parameterCapabilities
    );
    const started = Date.now();
    const capture = await this.options.monitoring?.start({
      kind: "ai",
      operation: "local_model_test",
      taskType,
      stage: "local_model_test",
      context: { origin: "settings", localModelId },
      sourceItemIds: [],
      provider: descriptor.providerId,
      modelId: model.modelId,
      runtime: model.runtime,
      parameters,
      input
    });
    try {
      const result = await this.withLocalModelUsage(localModelId, () =>
        adapter.run({
          taskType,
          input,
          modelId: adapter.describe().modelId,
          requiredCapabilities,
          parameters,
          metadata: { purpose: "local-model-test" }
        })
      );
      const aiTaskRunId = await repository.recordTaskRun({
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
        promptCompositions: promptAudit(input),
        outputHash: sha256(JSON.stringify(result.output)),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        costEstimate: 0,
        durationMs: result.durationMs,
        status: "succeeded"
      });
      await this.options.monitoring?.finish(capture, {
        status: "succeeded",
        aiTaskRunId,
        durationMs: Date.now() - started,
        tokenUsage: monitoringUsage(result),
        costEstimate: 0,
        output: result.output
      });
      return Array.isArray(result.output)
        ? `Embedding generated (${result.output.length} dimensions)`
        : typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output);
    } catch (error) {
      const aiTaskRunId = await repository.recordTaskRun({
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
        promptCompositions: promptAudit(input),
        durationMs: Date.now() - started,
        status: "failed",
        error: redactSensitiveText(error)
      });
      await this.options.monitoring?.finish(capture, {
        status: "failed",
        aiTaskRunId,
        durationMs: Date.now() - started,
        error: redactSensitiveText(error)
      });
      throw error;
    }
  }

  /**
   * The decide validation of a dedicated ranker (D17): its artifact against the catalog pins, then
   * the smoke test through the ranker adapter on the model card pair and an English and a Brazilian
   * Portuguese relevance pair. A pass is stored per install in `metadata.decideValidation`, which
   * a revision or artifact change voids; a failure voids any earlier validation and shows on the
   * model. The catalog sync turns a stored validation into the `reranking` capability.
   */
  private async executeRankerValidation(
    model: LocalModelRecord,
    entry: LocalModelCatalogEntry
  ): Promise<string> {
    const models = createLocalModelRepository(this.requirePool());
    const repository = createAiConfigRepository(this.requirePool());
    const instruction = renderPrompt("diagnostics.local_ranking");
    const provider = `local-${model.runtime}`;
    const started = Date.now();
    const capture = await this.options.monitoring?.start({
      kind: "ai",
      operation: "local_model_test",
      taskType: "reranking",
      stage: "local_model_test",
      context: { origin: "settings", localModelId: model.id },
      sourceItemIds: [],
      provider,
      modelId: model.modelId,
      runtime: model.runtime,
      parameters: {},
      input: instruction
    });
    let lastAiTaskRunId: string | undefined;
    let inputTokens = 0;
    const audit = (request: RankRequest, taskRequest: AiTaskRequest) => ({
      taskType: "reranking",
      provider,
      modelId: model.modelId,
      runtime: model.runtime,
      adapter: localAdapterName(model.runtime),
      repository: model.repository,
      revision: model.revision,
      quantization: model.quantization,
      capabilitiesUsed: ["reranking", "offline"],
      parameters: {},
      inputHash: sha256(String(taskRequest.input)),
      promptCompositions: request.instruction === instruction ? promptAudit(instruction) : []
    });
    try {
      if (model.status !== "ready" || !model.managedPath)
        throw new Error("errors.localModels.notReady");
      const artifact = await validateCatalogRankerArtifact(entry, model.managedPath);
      const adapter = await this.createRankerAdapter(model, entry);
      const runtimeBuild = await adapter.runtimeBuild();
      const descriptor = adapter.describe();
      const registered = this.registry.resolve({
        providerId: descriptor.providerId,
        modelId: descriptor.modelId,
        requiredCapabilities: ["reranking"],
        offlineOnly: true
      });
      const rank = async (request: RankRequest): Promise<RankResult> => {
        const taskRequest = rankTaskRequest(request);
        const callStarted = Date.now();
        try {
          const result = await registered.run(taskRequest);
          const output = readRankResult(result, request.documents.length);
          lastAiTaskRunId = await repository.recordTaskRun({
            ...audit(request, taskRequest),
            outputHash: sha256(JSON.stringify(result.output)),
            ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
            ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
            costEstimate: 0,
            durationMs: result.durationMs,
            status: "succeeded"
          });
          inputTokens += result.inputTokens ?? 0;
          return output;
        } catch (error) {
          lastAiTaskRunId = await repository.recordTaskRun({
            ...audit(request, taskRequest),
            durationMs: Date.now() - callStarted,
            status: "failed",
            error: redactSensitiveText(error)
          });
          throw error;
        }
      };
      const smoke = await this.withLocalModelUsage(model.id, () =>
        runRankerSmoke(rank, { instruction })
      );
      const validation = createDecideValidation(
        {
          runtime: entry.runtime,
          revision: entry.revision,
          artifactSha256: artifact.artifactSha256,
          runtimeBuild
        },
        smoke
      );
      await models.updateModel(model.id, {
        lastError: null,
        metadata: { ...model.metadata, decideValidation: validation }
      });
      await this.options.monitoring?.finish(capture, {
        status: "succeeded",
        ...(lastAiTaskRunId ? { aiTaskRunId: lastAiTaskRunId } : {}),
        durationMs: Date.now() - started,
        tokenUsage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
        costEstimate: 0,
        output: smoke
      });
      return rankerValidationSummary(smoke);
    } catch (error) {
      // No verdict is reached while the model is busy or not ready; anything else closes the gate.
      if (!rankerValidationInconclusive.has(redactSensitiveText(error))) {
        const metadata = { ...model.metadata };
        delete metadata.decideValidation;
        await models
          .updateModel(model.id, { lastError: errorKeyOf(error), metadata })
          .catch((cause: unknown) => this.options.logger?.error("Ranker validation record", cause));
      }
      await this.options.monitoring?.finish(capture, {
        status: "failed",
        ...(lastAiTaskRunId ? { aiTaskRunId: lastAiTaskRunId } : {}),
        durationMs: Date.now() - started,
        error: redactSensitiveText(error)
      });
      throw error;
    } finally {
      // The ranker is not kept resident by the test; routed use manages its own residency.
      if (this.resident.rank?.localModelId === model.id && !this.activeLocalModels.has(model.id))
        await this.releaseSlot("rank").catch(() => undefined);
      await this.stopIdleMlxHelper(false).catch(() => undefined);
    }
  }

  /**
   * A dedicated ranker adapter for the model in the ranker slot. It is built with the catalog's
   * declared capabilities, because the stored ones lack `reranking` until the ranker is
   * validated, which is what this adapter is for.
   */
  private async createRankerAdapter(
    model: LocalModelRecord,
    entry: LocalModelCatalogEntry
  ): Promise<RankerAdapter> {
    return (await this.makeResident("rank", model, [...entry.capabilities]))
      .adapter as RankerAdapter;
  }

  /** The routed ranker, resident in the ranker slot with its stored (validated) capabilities. */
  private async residentRanker(model: LocalModelRecord): Promise<ResidentLocalAdapter> {
    const resident = this.resident.rank;
    if (resident?.localModelId === model.id) return resident;
    return this.makeResident("rank", model, parseCapabilities(model.capabilities));
  }

  /** The slot a local model is kept in: rankers, embedding-only models, everything else. */
  private residencySlot(model: LocalModelRecord, capabilities: AiCapability[]): ResidencySlot {
    const entry = findLocalModelCatalogEntry(model.catalogId);
    if (entry ? isRankerCatalogEntry(entry) : isDedicatedRanker(capabilities)) return "rank";
    return !hasGeneration(capabilities) && capabilities.includes("embedding")
      ? "embed"
      : "generate";
  }

  /**
   * Loads a model into its slot, releasing the slot's current model first: a second generative
   * model therefore never joins the first one (`rules/ai.md`). A model running a call is never
   * released; the new one is refused instead.
   */
  private async makeResident(
    slot: ResidencySlot,
    model: LocalModelRecord,
    capabilities: AiCapability[]
  ): Promise<ResidentLocalAdapter> {
    const occupant = this.resident[slot];
    if (occupant) {
      if (this.activeLocalModels.has(occupant.localModelId))
        throw new Error("errors.localModels.modelBusy");
      await this.releaseSlot(slot);
    }
    const adapter =
      slot === "rank"
        ? this.buildRankerAdapter(model, capabilities)
        : this.buildLocalAdapter(model, capabilities);
    const resident: ResidentLocalAdapter = {
      localModelId: model.id,
      runtime: model.runtime,
      adapter
    };
    this.resident[slot] = resident;
    this.registerAdapter(adapter);
    return resident;
  }

  private async releaseSlot(slot: ResidencySlot): Promise<void> {
    const occupant = this.resident[slot];
    if (!occupant) return;
    delete this.resident[slot];
    const descriptor = occupant.adapter.describe();
    this.registry.unregister(descriptor.providerId, descriptor.modelId);
    await occupant.adapter.dispose?.();
    // The shared helper keeps the weights of a released MLX adapter until it stops.
    if (occupant.runtime === "mlx") this.mlxHoldsReleasedModel = true;
  }

  /** Releases one local model unless it is running a call. */
  private async releaseLocalModel(localModelId: string): Promise<void> {
    if (this.activeLocalModels.has(localModelId)) return;
    const slot = residencySlots.find((candidate) => {
      return this.resident[candidate]?.localModelId === localModelId;
    });
    if (slot) await this.releaseSlot(slot);
    await this.stopIdleMlxHelper(false);
  }

  /**
   * Stops the shared MLX helper once it holds a released model and no MLX call runs, or always
   * with `force`. A resident MLX ranker then loads again on its next call.
   */
  private async stopIdleMlxHelper(force: boolean): Promise<void> {
    const host = this.mlxHost;
    if (!host) return;
    if (!force) {
      if (!this.mlxHoldsReleasedModel) return;
      const mlxRunning = residencySlots.some((slot) => {
        const occupant = this.resident[slot];
        return occupant?.runtime === "mlx" && this.activeLocalModels.has(occupant.localModelId);
      });
      if (mlxRunning) return;
    }
    this.mlxHoldsReleasedModel = false;
    await host.dispose();
  }

  /** The one MLX helper of this service (D18). */
  private mlxHelper(): MlxHelperHost {
    this.mlxHost ??= new MlxHelperHost({ helperPath: this.resolveMlxHelperPath() });
    return this.mlxHost;
  }

  private buildRankerAdapter(model: LocalModelRecord, capabilities: AiCapability[]): RankerAdapter {
    const options = {
      ...localAdapterOptions(model, capabilities),
      parameterCapabilities: {}
    };
    return model.runtime === "mlx"
      ? new MlxRerankerAdapter({
          ...options,
          helperPath: this.resolveMlxHelperPath(),
          host: this.mlxHelper()
        })
      : new NodeLlamaRankerAdapter(options);
  }

  private buildLocalAdapter(model: LocalModelRecord, capabilities: AiCapability[]): AiModelAdapter {
    const options = {
      ...localAdapterOptions(model, capabilities),
      parameterCapabilities: localModelParameterCapabilities(model, capabilities)
    };
    return model.runtime === "mlx"
      ? new MlxAdapter({
          ...options,
          helperPath: this.resolveMlxHelperPath(),
          host: this.mlxHelper()
        })
      : new NodeLlamaCppAdapter(options);
  }

  private async parameterCapabilitiesForProfile(
    profile: AiProfileRecord
  ): Promise<AiModelParameterCapabilities> {
    if (profile.localModelId) {
      const model = await createLocalModelRepository(this.requirePool()).findById(
        profile.localModelId
      );
      if (!model) throw new Error("errors.common.notFound");
      return localModelParameterCapabilities(model, parseCapabilities(model.capabilities));
    }
    const provider = (await createAiConfigRepository(this.requirePool()).listProviders()).find(
      (candidate) => candidate.id === profile.providerConfigId
    );
    if (!provider) throw new Error("errors.common.notFound");
    const capabilities = providerParameterCapabilities({
      provider: provider.provider as AiProviderConfig["provider"],
      modelId:
        typeof provider.metadata.modelId === "string"
          ? provider.metadata.modelId
          : (profile.modelId ?? ""),
      baseUrl: provider.baseUrl,
      capabilities: parseCapabilities(provider.metadata.capabilities)
    });
    const known = discoveredContextWindow(provider.metadata);
    if (known && capabilities.contextWindow) capabilities.contextWindow.max = known;
    return capabilities;
  }

  private async createAdapter(providerId: string): Promise<AiModelAdapter> {
    const config = (await createAiConfigRepository(this.requirePool()).listProviders()).find(
      (provider) => provider.id === providerId
    );
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
      return this.registerAdapter(
        new OpenAiCodexAdapter({
          accessToken: credential.access,
          accountId: credential.accountId,
          modelId,
          capabilities,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          ...this.runtimeOption()
        })
      );
    }
    const apiKey = await this.credentials.get(config.credentialRef);
    if (config.provider === "google") {
      return this.registerAdapter(
        new GoogleGeminiAdapter({
          apiKey,
          modelId,
          capabilities,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          ...this.runtimeOption()
        })
      );
    }
    return this.registerAdapter(
      new OpenAiCompatibleAdapter({
        apiKey,
        modelId,
        capabilities,
        baseUrl: config.baseUrl ?? "http://127.0.0.1:11434/v1",
        ...this.runtimeOption()
      })
    );
  }

  private createPendingOpenAiCodexAdapter(): OpenAiCodexAdapter {
    const credential = this.pendingOpenAiCodexCredential;
    if (!credential) throw new Error("errors.ai.oauthNotConnected");
    return new OpenAiCodexAdapter({
      accessToken: credential.access,
      accountId: credential.accountId,
      modelId: "",
      capabilities: [],
      baseUrl: defaultBaseUrl("openai-codex"),
      ...this.runtimeOption()
    });
  }

  private runtimeOption(): { runtime?: AiRuntimeConfigInput } {
    return this.options.runtime ? { runtime: this.options.runtime } : {};
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
      if (this.oauthRefreshes.get(credentialRef) === refresh)
        this.oauthRefreshes.delete(credentialRef);
    }
  }

  /** The resident adapter of a local model, loading it into its slot when it is not resident. */
  private async createLocalAdapter(localModelId: string): Promise<AiModelAdapter> {
    const resident = residencySlots
      .map((slot) => this.resident[slot])
      .find((occupant) => occupant?.localModelId === localModelId);
    if (resident) return resident.adapter;
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model || model.status !== "ready" || !model.managedPath)
      throw new Error("errors.localModels.notReady");
    const capabilities = parseCapabilities(model.capabilities);
    return (await this.makeResident(this.residencySlot(model, capabilities), model, capabilities))
      .adapter;
  }

  private registerAdapter<T extends AiModelAdapter>(adapter: T): T {
    this.registry.register(adapter);
    return adapter;
  }

  private resolveMlxHelperPath(): string {
    return this.options.isPackaged
      ? join(this.options.resourcesPath, "sidecars", "mlx", "darwin-arm64", "memora-mlx-helper")
      : join(
          this.options.workspaceRoot,
          "native",
          "mlx-helper",
          ".build",
          "release",
          "memora-mlx-helper"
        );
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
  embeddingSpaceKey?: string;
}

/** What the adapter has to declare to run the task: a generative decider needs generation only. */
function requiredCapabilitiesForRun(
  taskType: AiTaskRequest["taskType"],
  available: readonly string[]
): AiCapability[] {
  const required = capabilitiesForTask(taskType);
  if (required.every((capability) => available.includes(capability))) return required;
  const decider =
    taskType === "reranking"
      ? generativeDeciderCapabilities.find((capability) => available.includes(capability))
      : undefined;
  return decider ? [decider] : required;
}

function defaultBaseUrl(provider: AiProviderConfigInput["provider"]): string {
  if (provider === "google") return "https://generativelanguage.googleapis.com/v1beta";
  if (provider === "openai-codex") return "https://chatgpt.com/backend-api/codex";
  return "http://127.0.0.1:11434/v1";
}

type RankerAdapter = AiModelAdapter & { runtimeBuild(): Promise<string> };

/**
 * The route keys of a call (D18): its operation override, the class route of a class it states,
 * then its task route. A class is never derived here: note matching runs the `reranking` task
 * without a stated class, so it never reaches `class:decide`.
 */
function taskRouteKeys(
  task: string,
  context: Pick<AiTaskLogContext, "operation" | "workloadClass">
): string[] {
  return aiRouteKeys(task, {
    operation: requestOperation(context.operation).operation,
    workloadClass: context.workloadClass
  });
}

/** The operation a request carries, when it has one the request contract accepts. */
function requestOperation(operation: string | undefined): { operation?: string } {
  return operation && operation.length <= 200 ? { operation } : {};
}

/** Tasks the settings show; class and operation routes are internal until F3. */
function isConfigurableTask(task: string): boolean {
  return aiConfigurableTaskSchema.safeParse(task).success;
}

/** An installed catalog ranker whose decide validation names this revision and artifact. */
function rankerReadyForDecide(model: LocalModelRecord, entry: LocalModelCatalogEntry): boolean {
  return (
    model.status === "ready" &&
    Boolean(model.managedPath) &&
    isRankerCatalogEntry(entry) &&
    isDedicatedRanker(parseCapabilities(model.capabilities)) &&
    decideValidationForCatalogEntry(model.metadata.decideValidation, entry) !== null
  );
}

function localAdapterOptions(model: LocalModelRecord, capabilities: AiCapability[]) {
  return {
    modelId: model.modelId,
    modelPath: resolveLocalModelPath(model),
    capabilities,
    catalogId: model.catalogId,
    repository: model.repository,
    revision: model.revision,
    quantization: model.quantization
  };
}

/** The parameter descriptor a local adapter carries: the catalog's, else the runtime's. */
function localModelParameterCapabilities(
  model: LocalModelRecord,
  capabilities: AiCapability[]
): AiModelParameterCapabilities {
  return (
    findLocalModelCatalogEntry(model.catalogId)?.parameterCapabilities ??
    localParameterCapabilities({
      runtime: model.runtime,
      modelId: model.modelId,
      catalogId: model.catalogId,
      capabilities
    })
  );
}

/** Errors that say the test could not run, not that the ranker failed it. */
const rankerValidationInconclusive = new Set([
  "errors.localModels.modelBusy",
  "errors.localModels.notReady",
  "errors.database.notReady"
]);

/** The localization key of an error, for the message a model card shows. */
function errorKeyOf(error: unknown): string {
  const message = redactSensitiveText(error);
  return message.startsWith("errors.")
    ? message.split(":")[0]!
    : "errors.localModels.runtimeFailed";
}

/** What the model test shows after a passing validation. */
function rankerValidationSummary(smoke: RankerSmokeReport): string {
  const log = (value: number) => value.toFixed(3);
  return [
    "Reranker validated for decide",
    `Model card pair: ${smoke.modelCard.logOdds.map(log).join(", ")} (card ${smoke.modelCard.expected.join(", ")}, largest difference ${log(smoke.modelCard.maxDelta)})`,
    ...smoke.relevance.map(
      (entry) =>
        `${entry.language}: relevant ${log(entry.relevant)}, irrelevant ${log(entry.irrelevant)} (margin ${log(entry.margin)})`
    )
  ].join("\n");
}

function localAdapterName(runtime: string): string {
  return runtime === "mlx" ? "mlx-swift-lm" : "node-llama-cpp";
}

function mapProvider(record: AiProviderConfigRecord): AiProviderConfig {
  const provider = record.provider as AiProviderConfig["provider"];
  const modelId = typeof record.metadata.modelId === "string" ? record.metadata.modelId : "";
  const capabilities = parseCapabilities(record.metadata.capabilities);
  const parameterCapabilities = providerParameterCapabilities({
    provider,
    modelId,
    baseUrl: record.baseUrl,
    capabilities
  });
  const known = discoveredContextWindow(record.metadata);
  if (known && parameterCapabilities.contextWindow) parameterCapabilities.contextWindow.max = known;
  return {
    id: record.id,
    provider,
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    modelId,
    capabilities,
    parameterCapabilities,
    defaultParameters: normalizeAiModelParameters(
      aiModelParametersSchema.parse(record.defaultParameters),
      parameterCapabilities
    ),
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
    id: record.id,
    name: record.name,
    description: record.description,
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

export function withEmbeddingInputInstruction(
  input: string,
  modelId: string,
  repository: string | null,
  inputType: AiTaskLogContext["embeddingInputType"]
): string {
  if (inputType !== "query") return input;
  const identity = `${modelId} ${repository ?? ""}`.toLowerCase();
  if (!identity.includes("qwen3-embedding")) return input;
  return renderPrompt("embedding.query_instruction", { query: input });
}

function createProgressReporter(
  listener?: (event: AiProgressEvent) => void
): (event: AiProgressEvent) => void {
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

function taskSourceItemIds(context: Omit<AiTaskLogContext, "onProgress">): string[] {
  return [
    ...new Set([
      ...(context.sourceItemId ? [context.sourceItemId] : []),
      ...(context.sourceItemIds ?? [])
    ])
  ];
}

type CallTokens = { inputTokens?: number | undefined; outputTokens?: number | undefined };

/** Tokens the provider billed for the attempts of a call that failed, for the audit of the failed run. */
function failedCallUsage(error: unknown): { inputTokens?: number; outputTokens?: number } {
  const usage = remoteCallReport(error)?.failedUsage;
  return {
    ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {})
  };
}

function failedMonitoringUsage(usage: CallTokens): Record<string, number> {
  return {
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? { totalTokens: usage.inputTokens + usage.outputTokens }
      : {})
  };
}

/**
 * The effective parameters plus the wire options the adapter chose itself, as the provider received
 * them: of the successful request, or of the last one a failed or canceled call started.
 */
function auditedParameters(
  parameters: JsonObject,
  requestOptions: AiTaskResult["requestOptions"] | undefined
): JsonObject {
  return requestOptions
    ? { ...parameters, requestOptions: requestOptions as JsonObject }
    : parameters;
}

/** What the monitoring entry keeps about the requests of a call: their number and what the failed ones used. */
function callDetails(attempts: number, retried: CallTokens | undefined): JsonObject {
  return {
    attempts,
    ...(retried && Object.keys(retried).length > 0 ? { retriedUsage: { ...retried } } : {})
  };
}

function monitoringUsage(result: AiTaskResult): Record<string, number> {
  const usage = {
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...result.tokenUsage
  } as Record<string, number>;
  if (
    usage.totalTokens === undefined &&
    usage.inputTokens !== undefined &&
    (usage.outputTokens !== undefined || result.taskType === "embedding")
  ) {
    usage.totalTokens = usage.inputTokens + (usage.outputTokens ?? 0);
  }
  return usage;
}
