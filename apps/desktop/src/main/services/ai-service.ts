export {withOutputLanguageInstruction} from './prompt-runtime.js';
import {withOutputLanguageInstruction} from './prompt-runtime.js';
import { renderPrompt, joinPrompts, capturePromptPin, withPromptPin, promptAudit, embeddingPromptIdentity } from "./prompt-runtime.js";
import { sha256 } from "@app/conversion";
import { createTranslator } from "@app/i18n";
import {
  AiModelRegistry,
  findLocalModelCatalogEntry,
  GoogleGeminiAdapter,
  localParameterCapabilities,
  MlxAdapter,
  NodeLlamaCppAdapter,
  OpenAiCompatibleAdapter,
  OpenAiCodexAdapter,
  providerParameterCapabilities,
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
  type PgPool,
  type JsonObject
} from "@app/db";
import {
  type PromptPin, type PromptCompositionSnapshot,
  AiCapabilitySchema,
  OrganizationProfileSchema,
  type OrganizationProfile,
  normalizeAiModelParameters,
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
import { aiModelParametersSchema } from "../../shared/ipc.js";

import { CredentialService } from "./credential-service.js";
import { AiExecutionQueue } from "./ai-execution-queue.js";
import { withAiTaskParameterDefaults, discoveredContextWindow, discoveredModelLimits, estimateAiPlanningTokens } from "./ai-task-parameters.js";
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
}

export interface AiTaskLogContext {
  maintenanceRunId?: string;
  maintenanceStep?: number;
  organizationRunId?: string;
  organizationStep?: number;
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
  embeddingInputType?: "query" | "document";
  onProgress?: (event: AiProgressEvent) => void;
  onProviderStart?:()=>Promise<void>;
}

type RoutedTask = "text-generation" | "embedding" | "summarization" | "knowledge-graph-generation" | "atomic-note-generation" | "reranking" | "structured-output";
type TaskSelection = NonNullable<Awaited<ReturnType<ReturnType<typeof createAiConfigRepository>["getDefaultTask"]>>>;
interface PromptAdmission { selection:TaskSelection; input:string; instruction:string; compositions:PromptCompositionSnapshot[]; pin:PromptPin; language:string }
const selectionIdentity=(s:TaskSelection)=>JSON.stringify([s.profileId,s.providerConfigId,s.localModelId,s.provider,s.modelId,s.runtime,s.revision,s.baseUrl,s.repository,s.quantization]);
export class AiService {
  public isBusy(): boolean { return aiExecutionQueue.busy; }
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
    const providers=await repository.listProviders();
    for(const provider of providers){const limits=provider.metadata.modelLimits;if(limits&&typeof limits==="object"&&!Array.isArray(limits)){const validated=discoveredModelLimits(limits as Record<string,unknown>);if(discoveredContextWindow({modelLimits:validated}))this.discoveredContexts.set(this.contextKey(provider.provider,provider.baseUrl,String(provider.metadata.modelId)),validated);}}
    return providers.map(mapProvider);
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

  private readonly discoveredContexts = new Map<string, JsonObject>();
  private contextKey(provider:string,baseUrl:string|null,modelId:string){return JSON.stringify([provider,baseUrl??defaultBaseUrl(provider as AiProviderConfig["provider"]),modelId]);}

  public async saveProvider(input: AiProviderConfigInput): Promise<AiProviderConfig> {
    const repository = createAiConfigRepository(this.requirePool());
    const existing = input.id ? (await repository.listProviders()).find((provider) => provider.id === input.id) : undefined;
    const sameModel=existing?.provider===input.provider&&existing.baseUrl===(input.baseUrl??defaultBaseUrl(input.provider))&&existing.metadata.modelId===input.modelId;
    const modelLimits=this.discoveredContexts.get(this.contextKey(input.provider,input.baseUrl??null,input.modelId))??(sameModel?existing?.metadata.modelLimits:undefined);
    const known=discoveredContextWindow({modelLimits});
    const capabilities = withRemoteRerankingCapability(input.provider, input.capabilities);
    const parameterCapabilities = providerParameterCapabilities({
      provider: input.provider,
      modelId: input.modelId,
      baseUrl: input.baseUrl ?? defaultBaseUrl(input.provider),
      capabilities
    });
    if(known&&parameterCapabilities.contextWindow)parameterCapabilities.contextWindow.max=known;
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
      defaultParameters: normalizeAiModelParameters(input.defaultParameters, parameterCapabilities),
      metadata: { modelId: input.modelId, capabilities, ...(known?{modelLimits:modelLimits as JsonObject}:{}) }
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
    const models=await adapter.listModels?.()??[],repository=createAiConfigRepository(this.requirePool()),config=(await repository.listProviders()).find(p=>p.id===providerId);
    if(config){for(const model of models){const limits=discoveredModelLimits(model.limits);if(discoveredContextWindow({modelLimits:limits}))this.discoveredContexts.set(this.contextKey(config.provider,config.baseUrl,model.modelId),limits);}const known=this.discoveredContexts.get(this.contextKey(config.provider,config.baseUrl,String(config.metadata.modelId)));if(known)await repository.cacheProviderModelContext(config.id,config.provider,String(config.metadata.modelId),config.baseUrl,known);}
    return models.map(model=>model.modelId);
  }

  public async discoverModels(input: AiModelDiscoveryInput): Promise<string[]> {
    const baseUrl = input.baseUrl ?? defaultBaseUrl(input.provider);
    const adapter = input.provider === "openai-codex"
      ? this.createPendingOpenAiCodexAdapter()
      : input.provider === "google"
        ? new GoogleGeminiAdapter({ apiKey: input.apiKey!, modelId: "", capabilities: [], baseUrl })
        : new OpenAiCompatibleAdapter({ apiKey: input.apiKey!, modelId: "", capabilities: [], baseUrl });
    const models=await adapter.listModels?.()??[];for(const model of models){const limits=discoveredModelLimits(model.limits);if(discoveredContextWindow({modelLimits:limits}))this.discoveredContexts.set(this.contextKey(input.provider,baseUrl,model.modelId),limits);}
    const modelIds = models.map(model=>model.modelId);
    return [...new Set(modelIds)].sort((left, right) => left.localeCompare(right));
  }

  public getParameterCapabilities(input: AiParameterCapabilitiesInput): AiModelParameterCapabilities {
    const result=providerParameterCapabilities({
      provider: input.provider,
      modelId: input.modelId,
      baseUrl: input.baseUrl ?? defaultBaseUrl(input.provider),
      capabilities: withRemoteRerankingCapability(input.provider, input.capabilities)
    });const known=discoveredContextWindow({modelLimits:this.discoveredContexts.get(this.contextKey(input.provider,input.baseUrl??null,input.modelId))});if(known&&result.contextWindow)result.contextWindow.max=known;return result;
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
      ...(input.modelId !== undefined ? { privacyMode: input.localModelId ? "offline_only" : "allow_remote" } : {}),
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
    const parameterCapabilities = await this.parameterCapabilitiesForProfile(profile);
    await repository.setProfileTask({
      profileId: input.profileId,
      task: input.task,
      fallbackPolicy: "block",
      parameters: normalizeAiModelParameters(input.parameters, parameterCapabilities)
    });
  }

  public async describePromptRoute(task:string){const selection=await createAiConfigRepository(this.requirePool()).getDefaultTask(task);return selection?{provider:selection.provider,modelId:selection.modelId,repository:selection.repository}:null;}

  public async pinOrganizationProfile(profileId: string | undefined, _legacyPrivacy: "offline_only" | "allow_remote"): Promise<OrganizationProfile> {
    const repository=createAiConfigRepository(this.requirePool());
    const selection=await repository.getDefaultTask("structured-output",profileId);
    if(!selection || !selection.requiredCapabilities.includes("structured-output"))throw new Error("organization.errors.model");
    const effectivePrivacy=selection.localModelId?"offline_only":"allow_remote";
    const parameters=aiModelParametersSchema.parse(withAiTaskParameterDefaults("structured-output",{...selection.modelDefaultParameters,...selection.parameters},Boolean(selection.localModelId),{contextWindowLimit:discoveredContextWindow(selection.providerMetadata)}));
    const identityHash=sha256(JSON.stringify({profileId:selection.profileId,providerConfigId:selection.providerConfigId,localModelId:selection.localModelId,modelId:selection.modelId,runtime:selection.runtime,revision:selection.revision,baseUrl:selection.baseUrl,privacy:effectivePrivacy}));
    return OrganizationProfileSchema.parse({profileId:selection.profileId,providerConfigId:selection.providerConfigId,localModelId:selection.localModelId,provider:selection.provider,modelId:selection.modelId,runtime:selection.runtime,revision:selection.revision,privacy:effectivePrivacy,parameters,identityHash,contextWindow:parameters.contextWindow??null});
  }

  public async runConsultationEmbedding(text:string,_legacyPrivacy:'offline_only'|'allow_remote',sourceItemIds:string[],signal:AbortSignal){
    return this.admitTask('embedding',text,{stage:'wiki_consultation',embeddingInputType:'query',sourceItemIds},signal);
  }

  public async runOrganizationTask(profile: OrganizationProfile, input: string, context: AiTaskLogContext, signal: AbortSignal, maxOutputTokens: number, beforeExecute?:()=>Promise<void>): Promise<DefaultAiTaskResult> {
    const pinned=OrganizationProfileSchema.parse(profile);
    const result=await this.admitTask("structured-output",input,context,signal,{maxOutputTokens},pinned,beforeExecute);
    if(!result)throw new Error("organization.errors.model");return result;
  }

  public async runDefaultTask(
    taskType: "text-generation" | "embedding" | "summarization" | "knowledge-graph-generation" | "atomic-note-generation" | "reranking" | "structured-output",
    input: string,
    logContext: AiTaskLogContext = {},
    signal?: AbortSignal,
    limits?: { maxOutputTokens: number }
  ): Promise<DefaultAiTaskResult | null> {
    return this.admitTask(taskType,input,logContext,signal,limits);
  }

  private async preparePromptAdmission(task:RoutedTask,input:string,context:AiTaskLogContext,pin:PromptPin,baseAudit:PromptCompositionSnapshot[],pinned?:OrganizationProfile):Promise<PromptAdmission|null>{
    const repository=createAiConfigRepository(this.requirePool());
    await repository.ensureRemoteRerankingCapabilities();
    const found=await repository.getDefaultTask(task,pinned?.profileId);
    const selection=found?structuredClone(found):null;
    if(!selection){if(pinned)throw new Error('organization.errors.model');return null;}
    const language=context.contentLanguage??await this.options.getContentLanguage?.()??'en';
    return withPromptPin(pin,()=>{
      const prepared=task==='embedding'?withEmbeddingInputInstruction(baseAudit.length?input:renderPrompt(context.embeddingInputType==='query'?'embedding.query':'embedding.content.chunk',context.embeddingInputType==='query'?{query:input}:{source_text:input}),selection.modelId,selection.repository,context.embeddingInputType):baseAudit.some(s=>s.promptId.startsWith("diagnostics."))?input:withOutputLanguageInstruction(input,language);
      const instruction=selection.provider==='openai-codex'?renderPrompt('shared.codex_adapter_instruction'):'';
      return {selection,input:prepared,instruction,compositions:[...baseAudit,...promptAudit(prepared),...promptAudit(instruction)],pin,language};
    });
  }

  private async admitTask(task:RoutedTask,input:string,context:AiTaskLogContext,signal?:AbortSignal,limits?:{maxOutputTokens:number},pinned?:OrganizationProfile,beforeProvider?:()=>Promise<void>):Promise<DefaultAiTaskResult|null> {
    const pin=capturePromptPin(),baseAudit=context.promptCompositions??promptAudit(input);
    // Reserve FIFO order synchronously, while source-free routing preparation runs without model loading or telemetry.
    const prepared=this.preparePromptAdmission(task,input,context,pin,baseAudit,pinned).then(value=>({value}),error=>({error}));
    let entered=false,admission:PromptAdmission|null=null;
    try{return await aiExecutionQueue.run(()=>withPromptPin(pin,async()=>{const result=await prepared;if('error' in result)throw result.error;admission=result.value;if(!admission)return null;await beforeProvider?.();signal?.throwIfAborted();entered=true;return this.executeDefaultTask(task,input,context,signal,limits,pinned,beforeProvider,admission);}),signal);}
    catch(error){
      if(!entered||!admission||error&&typeof error==='object'&&'aiTaskRunId' in error)throw error;
      const completed=admission as PromptAdmission,selection=completed.selection;
      const aiTaskRunId=await createAiConfigRepository(this.requirePool()).recordTaskRun({profileId:selection.profileId,taskType:task,provider:selection.provider,modelId:selection.modelId,runtime:selection.runtime,parameters:pinned?.parameters??{...selection.modelDefaultParameters,...selection.parameters},promptCompositions:completed.compositions,inputHash:sha256(completed.input),durationMs:0,status:signal?.aborted?'canceled':'failed',error:redactSensitiveText(error),sourceItemIds:taskSourceItemIds(context),...(context.organizationRunId?{organizationRunId:context.organizationRunId,organizationStep:context.organizationStep}:{}),...(context.maintenanceRunId?{maintenanceRunId:context.maintenanceRunId,maintenanceStep:context.maintenanceStep}:{})});
      if(error instanceof Error)Object.assign(error,{aiTaskRunId});throw error;
    }
  }

  private async executeDefaultTask(
    taskType: "text-generation" | "embedding" | "summarization" | "knowledge-graph-generation" | "atomic-note-generation" | "reranking" | "structured-output",
    input: string,
    logContext: AiTaskLogContext,
    signal?: AbortSignal,
    limits?: { maxOutputTokens: number },
    pinned?: OrganizationProfile,
    beforeProvider?:()=>Promise<void>,
    admission?:PromptAdmission
  ): Promise<DefaultAiTaskResult | null> {
    const { onProgress,onProviderStart, ...structuredLogContext } = logContext;
    const sourceItemIds = taskSourceItemIds(structuredLogContext);
    const repository = createAiConfigRepository(this.requirePool());
    await repository.ensureRemoteRerankingCapabilities();
    const selection = admission?.selection ?? await repository.getDefaultTask(taskType, pinned?.profileId);
    if (!selection) { if(pinned) throw new Error("organization.errors.model"); return null; }
    if(pinned){
      const current=await this.pinOrganizationProfile(pinned.profileId,pinned.privacy);
      if(current.identityHash!==pinned.identityHash)throw new Error("organization.errors.modelChanged");
    }
    let parameters = aiModelParametersSchema.parse(withAiTaskParameterDefaults(
      taskType,
      pinned?.parameters ?? { ...selection.modelDefaultParameters, ...selection.parameters },
      Boolean(selection.localModelId),
      {admitted:!!pinned,contextWindowLimit:discoveredContextWindow(selection.providerMetadata)}
    ));
    if (limits) parameters.maxTokens = Math.min(parameters.maxTokens ?? 16384, Math.max(1,Math.floor(limits.maxOutputTokens)));
    const plannedOutputTokens=parameters.maxTokens??16384;
    if(!selection.localModelId){const caps=providerParameterCapabilities({provider:selection.provider as AiProviderConfig["provider"],modelId:selection.modelId,baseUrl:selection.baseUrl,capabilities:parseCapabilities(selection.providerMetadata?.capabilities??selection.requiredCapabilities)});parameters=normalizeAiModelParameters(parameters,caps);}
    const outputLanguage = admission?.language ?? logContext.contentLanguage ?? await this.options.getContentLanguage?.() ?? "en";
    const taskInput = admission?.input ?? (taskType === "embedding"
      ? withEmbeddingInputInstruction(input, selection.modelId, selection.repository, structuredLogContext.embeddingInputType)
      : withOutputLanguageInstruction(input, outputLanguage));
    const keepLocalEmbeddingModelLoaded = taskType === "embedding" && selection.localModelId
      ? await this.options.getKeepLocalEmbeddingModelsLoaded?.() ?? true
      : true;
    const started = Date.now();
    const capture = await this.options.monitoring?.start({
      kind: "ai", operation: logContext.operation ?? logContext.stage ?? taskType, taskType,
      stage: logContext.stage ?? taskType,
      context: { ...structuredLogContext, origin: logContext.origin ?? (logContext.ingestionRunId ? "ingestion" : logContext.jobId ? "job" : "interactive"), sourceItemIds,
        providerConfigId: selection.providerConfigId, localModelId: selection.localModelId,
        repository: selection.repository, revision: selection.revision, quantization: selection.quantization },
      sourceItemIds, provider: selection.provider, modelId: selection.modelId, runtime: selection.runtime,
      profileId: selection.profileId, parameters, input: taskInput
    });
    try {
      if(taskType!=='embedding'&&parameters.contextWindow&&(!selection.localModelId||selection.runtime==='mlx')){
        const plannedTokens=estimateAiPlanningTokens(taskInput,selection.provider==='openai-codex'?admission?.instruction??renderPrompt('shared.codex_adapter_instruction'):'',plannedOutputTokens);
        if(plannedTokens>parameters.contextWindow)throw new Error('errors.ai.contextWindowLimit');
      }
      const currentSelection=await repository.getDefaultTask(taskType,selection.profileId);
      if(!currentSelection||selectionIdentity(currentSelection)!==selectionIdentity(selection))throw new Error("organization.errors.modelChanged");
      const configuredAdapter = selection.localModelId
        ? await this.createLocalAdapter(selection.localModelId)
        : await this.createAdapter(selection.providerConfigId ?? "");
      const requiredCapabilities = capabilitiesForTask(taskType);
      const descriptor = configuredAdapter.describe();
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
        taskType, input: taskInput, profileId: selection.profileId, modelId: selection.modelId,
        requiredCapabilities, parameters, metadata: {applicationInstruction:admission?.instruction??renderPrompt("shared.codex_adapter_instruction")}
      };
      const progress = createProgressReporter(onProgress);
      const run = async () => {
        await beforeProvider?.();signal?.throwIfAborted();
        if(pinned&&(await this.pinOrganizationProfile(pinned.profileId,pinned.privacy)).identityHash!==pinned.identityHash)throw new Error("organization.errors.modelChanged");
        await onProviderStart?.();
        return adapter.runStreaming
        && (descriptor.capabilities.includes("streaming") || descriptor.capabilities.includes("supports-progress-events"))
        ? adapter.runStreaming(request, signal, progress)
        : adapter.run(request, signal);
      };
      const runLocal = async () => {
        const needsLoad = taskType === "embedding" && adapter.isLoaded?.() === false && adapter.ensureLoaded;
        if (needsLoad) {
          this.options.onLocalEmbeddingLoadStatus?.({ state: "loading", modelId: selection.modelId });
          try {
            await adapter.ensureLoaded?.(signal);
            this.options.onLocalEmbeddingLoadStatus?.({ state: "ready", modelId: selection.modelId });
          } catch (error) {
            this.options.onLocalEmbeddingLoadStatus?.({ state: "failed", modelId: selection.modelId });
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
        ...(logContext.maintenanceRunId?{maintenanceRunId:logContext.maintenanceRunId,maintenanceStep:logContext.maintenanceStep}:{}),
        ...(logContext.organizationRunId?{organizationRunId:logContext.organizationRunId,organizationStep:logContext.organizationStep}:{}),
        profileId: selection.profileId, taskType, provider: result.providerId, modelId: result.modelId,
        runtime: selection.localModelId ? selection.runtime : result.runtime,
        capabilitiesUsed: requiredCapabilities,
        adapter: selection.localModelId ? localAdapterName(selection.runtime) : result.providerId,
        repository: selection.repository,
        revision: selection.revision,
        quantization: selection.quantization,
        parameters, promptCompositions:admission?.compositions??promptAudit(taskInput),
        inputHash: sha256(taskInput), outputHash: sha256(JSON.stringify(result.output)),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {}),
        durationMs: result.durationMs, status: "succeeded", sourceItemIds
      });
      await this.options.monitoring?.finish(capture, {
        status: "succeeded", aiTaskRunId, durationMs: Date.now() - started,
        tokenUsage: monitoringUsage(result), parameters, output: result.output,
        ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {})
      });
      if (selection.localModelId && taskType === "embedding" && !keepLocalEmbeddingModelLoaded) {
        await this.releaseLocalRuntime().catch((error) => {
          this.options.logger?.error("Failed to release local embedding runtime", error);
        });
      }
      return { ...result, profileId: selection.profileId, aiTaskRunId, outputLanguage,
        embeddingSpaceKey: sha256(JSON.stringify({ providerConfigId: selection.providerConfigId, baseUrl: selection.baseUrl, localModelId: selection.localModelId, repository: selection.repository, quantization: selection.quantization, model: result.modelId, provider: result.providerId, runtime: result.runtime, revision: selection.revision, parameters, ...(embeddingPromptIdentity()?{promptStrategy:embeddingPromptIdentity()}: {}) })) };
    } catch (error) {
      const aiTaskRunId = await repository.recordTaskRun({
        ...(logContext.maintenanceRunId?{maintenanceRunId:logContext.maintenanceRunId,maintenanceStep:logContext.maintenanceStep}:{}),
        ...(logContext.organizationRunId?{organizationRunId:logContext.organizationRunId,organizationStep:logContext.organizationStep}:{}),
        profileId: selection.profileId, taskType, provider: selection.provider,
        modelId: selection.modelId, runtime: selection.runtime,
        adapter: selection.localModelId ? localAdapterName(selection.runtime) : selection.provider,
        repository: selection.repository,
        revision: selection.revision,
        quantization: selection.quantization,
        parameters,
        promptCompositions:admission?.compositions??promptAudit(taskInput), inputHash:sha256(taskInput),
        durationMs: Date.now() - started, status: signal?.aborted?"canceled":"failed",
        error: redactSensitiveText(error), sourceItemIds
      });
      await this.options.monitoring?.finish(capture, {
        status: signal?.aborted ? "canceled" : "failed", aiTaskRunId, durationMs: Date.now() - started,
        error: redactSensitiveText(error), parameters
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
      if (selection.localModelId && taskType === "embedding" && !keepLocalEmbeddingModelLoaded) {
        await this.releaseLocalRuntime().catch((releaseError) => {
          this.options.logger?.error("Failed to release local embedding runtime", releaseError);
        });
      }
      if (error instanceof Error) Object.assign(error, { aiTaskRunId });
      throw error;
    }
  }

  public async traceOperation<T>(operation: string, context: AiTaskLogContext, run: () => Promise<T>, details: Record<string, unknown> = {}): Promise<T> {
    const { onProgress: _progress,onProviderStart:_providerStart, ...metadata } = context;
    return this.options.monitoring ? this.options.monitoring.operation(operation, metadata, run, details) : run();
  }

  public isLocalModelInUse(localModelId: string): boolean {
    return this.activeLocalModels.has(localModelId);
  }

  public async releaseLocalRuntime(force = false, keepEmbedding = false): Promise<void> {
    const resident = this.residentLocalAdapter;
    if (!resident) return;
    if (!force && this.activeLocalModels.has(resident.localModelId)) return;
    if (!force && keepEmbedding && resident.adapter.describe().capabilities.includes("embedding")) return;
    this.residentLocalAdapter = null;
    const descriptor = resident.adapter.describe();
    this.registry.unregister(descriptor.providerId, descriptor.modelId);
    await resident.adapter.dispose?.();
  }

  public async dispose(): Promise<void> {
    await this.releaseLocalRuntime(true);
  }

  public async testLocalModel(localModelId: string): Promise<string> {
    const pin=capturePromptPin();return aiExecutionQueue.run(() => withPromptPin(pin,()=>this.executeLocalModelTest(localModelId)));
  }

  private async executeLocalModelTest(localModelId: string): Promise<string> {
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
    const input = renderPrompt(embeddingOnly ? "diagnostics.local_embedding" : "diagnostics.local_generation");
    const parameters = normalizeAiModelParameters(aiModelParametersSchema.parse(withAiTaskParameterDefaults(
      taskType,
      model.defaultParameters,
      true
    )), descriptor.parameterCapabilities);
    const started = Date.now();
    const capture = await this.options.monitoring?.start({ kind: "ai", operation: "local_model_test", taskType,
      stage: "local_model_test", context: { origin: "settings", localModelId }, sourceItemIds: [],
      provider: descriptor.providerId, modelId: model.modelId, runtime: model.runtime, parameters, input });
    try {
      const result = await this.withLocalModelUsage(localModelId, () => adapter.run({
        taskType,
        input,
        modelId: adapter.describe().modelId,
        requiredCapabilities,
        parameters,
        metadata: { purpose: "local-model-test" }
      }));
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
        inputHash: sha256(input), promptCompositions:promptAudit(input),
        outputHash: sha256(JSON.stringify(result.output)),
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        costEstimate: 0,
        durationMs: result.durationMs,
        status: "succeeded"
      });
      await this.options.monitoring?.finish(capture, { status: "succeeded", aiTaskRunId,
        durationMs: Date.now() - started, tokenUsage: monitoringUsage(result), costEstimate: 0, output: result.output });
      return Array.isArray(result.output)
        ? `Embedding generated (${result.output.length} dimensions)`
        : typeof result.output === "string" ? result.output : JSON.stringify(result.output);
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
        inputHash: sha256(input), promptCompositions:promptAudit(input),
        durationMs: Date.now() - started,
        status: "failed",
        error: redactSensitiveText(error)
      });
      await this.options.monitoring?.finish(capture, { status: "failed", aiTaskRunId,
        durationMs: Date.now() - started, error: redactSensitiveText(error) });
      throw error;
    }
  }

  private async parameterCapabilitiesForProfile(profile: AiProfileRecord): Promise<AiModelParameterCapabilities> {
    if (profile.localModelId) {
      const model = await createLocalModelRepository(this.requirePool()).findById(profile.localModelId);
      if (!model) throw new Error("errors.common.notFound");
      return findLocalModelCatalogEntry(model.catalogId)?.parameterCapabilities ?? localParameterCapabilities({
        runtime: model.runtime,
        modelId: model.modelId,
        catalogId: model.catalogId,
        capabilities: parseCapabilities(model.capabilities)
      });
    }
    const provider = (await createAiConfigRepository(this.requirePool()).listProviders())
      .find((candidate) => candidate.id === profile.providerConfigId);
    if (!provider) throw new Error("errors.common.notFound");
    const capabilities=providerParameterCapabilities({
      provider: provider.provider as AiProviderConfig["provider"],
      modelId: typeof provider.metadata.modelId === "string" ? provider.metadata.modelId : profile.modelId ?? "",
      baseUrl: provider.baseUrl,
      capabilities: parseCapabilities(provider.metadata.capabilities)
    });const known=discoveredContextWindow(provider.metadata);if(known&&capabilities.contextWindow)capabilities.contextWindow.max=known;return capabilities;
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
    const capabilities = parseCapabilities(model.capabilities);
    const parameterCapabilities = findLocalModelCatalogEntry(model.catalogId)?.parameterCapabilities
      ?? localParameterCapabilities({
        runtime: model.runtime,
        modelId: model.modelId,
        catalogId: model.catalogId,
        capabilities
      });
    const options = {
      modelId: model.modelId,
      modelPath: resolveLocalModelPath(model),
      capabilities,
      catalogId: model.catalogId,
      parameterCapabilities,
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
  embeddingSpaceKey?: string;
}

function capabilitiesForTask(taskType: AiTaskRequest["taskType"]): AiCapability[] {
  return ({
    "text-generation": ["text-generation"],
    embedding: ["embedding"],
    summarization: ["summarization"],
    "knowledge-graph-generation": ["structured-output"],
    "atomic-note-generation": ["atomic-note-generation", "structured-output"],
    "structured-output": ["structured-output"],
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
  const provider = record.provider as AiProviderConfig["provider"];
  const modelId = typeof record.metadata.modelId === "string" ? record.metadata.modelId : "";
  const capabilities = parseCapabilities(record.metadata.capabilities);
  const parameterCapabilities = providerParameterCapabilities({
    provider,
    modelId,
    baseUrl: record.baseUrl,
    capabilities
  });
  const known=discoveredContextWindow(record.metadata);if(known&&parameterCapabilities.contextWindow)parameterCapabilities.contextWindow.max=known;
  return {
    id: record.id,
    provider,
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    modelId,
    capabilities,
    parameterCapabilities,
    defaultParameters: normalizeAiModelParameters(aiModelParametersSchema.parse(record.defaultParameters), parameterCapabilities),
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



export function withEmbeddingInputInstruction(
  input: string,
  modelId: string,
  repository: string | null,
  inputType: AiTaskLogContext["embeddingInputType"]
): string {
  if (inputType !== "query") return input;
  const identity = `${modelId} ${repository ?? ""}`.toLowerCase();
  if (!identity.includes("qwen3-embedding")) return input;
  return renderPrompt("embedding.query_instruction",{query:input});
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

function taskSourceItemIds(context: Omit<AiTaskLogContext, "onProgress">): string[] {
  return [...new Set([
    ...(context.sourceItemId ? [context.sourceItemId] : []),
    ...(context.sourceItemIds ?? [])
  ])];
}

function monitoringUsage(result: AiTaskResult): Record<string, number> {
  const usage = {
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...result.tokenUsage
  } as Record<string, number>;
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && (usage.outputTokens !== undefined || result.taskType === "embedding")) {
    usage.totalTokens = usage.inputTokens + (usage.outputTokens ?? 0);
  }
  return usage;
}
