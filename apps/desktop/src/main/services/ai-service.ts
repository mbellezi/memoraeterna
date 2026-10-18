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
  createRankerParityRecord,
  decideValidationForCatalogEntry,
  decideValidationParityFailed,
  findLocalModelCatalogEntry,
  GoogleGeminiAdapter,
  hasCapabilities,
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
  parseRankPairsRequest,
  parseRankRequest,
  providerParameterCapabilities,
  rankerCatalogArtifactSha256,
  rankerParityBaselineApplies,
  rankerParityReferenceHash,
  rankPairsLimits,
  rankPairsTaskRequest,
  rankTaskRequest,
  readRankResult,
  redactSensitiveText,
  remoteCallReport,
  runRankerSmoke,
  runsStreaming,
  scoreRankerParityReference,
  validateCatalogRankerArtifact,
  type AiModelAdapter,
  type AiProgressEvent,
  type AiProgressStep,
  type AiTextDelta,
  type AiLaneRuntimeConfig,
  type AiLaneRuntimeConfigInput,
  type AiRuntimeConfig,
  type AiRuntimeConfigInput,
  type AiScheduler,
  type AiTaskRequest,
  type AiTaskResult,
  type AiWorkloadClass,
  type LocalModelCatalogEntry,
  type RankerParityBaseline,
  type RankerParityPlan,
  type RankerParityRecord,
  type RankerSmokeReport,
  type RankPairsRequest,
  type RankRequest,
  type RankResult,
  type LanePermit,
  type LaneSnapshot,
  ActiveDeadline,
  aiCassetteReplayedUsageKey,
  bindLanePermit,
  createAiScheduler,
  embedManyLimits,
  embedManyTaskResult,
  executionLane,
  isDeadlineFailure,
  isRemoteExecution,
  providerTreatedAsRemote,
  localDeadlineMs,
  LocalDeadlineError,
  LocalMemoryBlockedError,
  LocalRankerError,
  localRuntimeWedgedError,
  availableMemoryBytes,
  memoryGuard,
  priorityNumber,
  ProviderUnavailableError,
  remoteTotalDeadlineMs,
  requestWorkloadClass,
  residencyPlan,
  resolveAiLaneRuntimeConfig,
  resolveAiRuntimeConfig,
  sumTokenUsage,
  type MlxHelperSlot,
  type ResidencyPlan
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
  AiSchemaModeSchema,
  OrganizationProfileSchema,
  type OrganizationProfile,
  normalizeAiModelParameters,
  capabilitiesForTask,
  generativeDeciderCapabilities,
  supportsTask,
  type AiCapability,
  type AiModelParameterCapabilities,
  type AiOutputSchema,
  type AiSchemaMode,
  type DecisionsStatus,
  type NoteDeciderMode
} from "@app/domain";
import type {
  AiApplyPresetInput,
  AiApplyPresetResult,
  AiClassRouteTarget,
  AiClassRoutes,
  AiSetClassRouteInput,
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

import { AiClassRouteService } from "./ai-class-routes.js";
import {
  DecisionsRuntime,
  type DecisionsDecideInput,
  type DecisionsDecideResult,
  type DecisionsResolution,
  type DecisionsRuntimeOptions
} from "./ai-decisions.js";
import { AiConfigCache } from "./ai-config-cache.js";
import { createRouteMappingStore, mapLegacyRoutesV1 } from "./ai-route-mapping.js";
import { CredentialService } from "./credential-service.js";
import { aiTaskPriority, type AiPriorityInput } from "./ai-priority.js";
import {
  withAiTaskParameterDefaults,
  discoveredContextWindow,
  discoveredModelLimits,
  estimateAiPlanningTokens,
  routeCapacity,
  type TaskRouteCapacity
} from "./ai-task-parameters.js";
import type { MonitoringService } from "./monitoring-service.js";
import { logStructuredError } from "./structured-logging.js";
import {
  loginOpenAiCodex,
  parseOpenAiCodexCredential,
  refreshOpenAiCodexCredential,
  type OpenAiCodexCredential
} from "./openai-codex-oauth.js";
import { totalmem } from "node:os";
import { extname, join } from "node:path";

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
   * Lane limits, aging and local deadlines (F3 D29-D31); the typed defaults, `MEMORA_AI_LANES` in
   * an unpackaged build and the serial lanes of golden runs apply to what is left out.
   */
  lanes?: AiLaneRuntimeConfigInput;
  /**
   * The lane scheduler. Each service owns one by default; services that model one machine (tests)
   * share one explicitly.
   */
  scheduler?: AiScheduler;
  /**
   * The MLX helper every MLX adapter shares: one helper process holds at most one generative, one
   * embedding and one ranker model (D18). Created on first use when left out; proofs inject one.
   */
  mlxHost?: MlxHelperHost;
  /**
   * The machine; it decides whether an MLX ranker can be seeded (D18) and, by its memory, which
   * local models stay loaded together (F3 D39). Defaults to this one.
   */
  machine?: { platform: string; arch: string; totalMemoryBytes?: number };
  /**
   * Free plus inactive memory now, read before a local generative model loads (F3 D39). Defaults to
   * `vm_stat` on macOS and `os.freemem()` elsewhere.
   */
  availableMemoryBytes?: () => Promise<number>;
  /**
   * Called with the task and class routes a seeding just created (never throws into it): the
   * first-run ranker install follows the first embedding route (owner decision 19).
   */
  onRoutesSeeded?: (tasks: readonly string[]) => void;
  /**
   * The parity baseline a calibration stored for a ranker model (D13): the scores of the 64
   * reference pairs when the calibration was fitted. A validation on a rebuilt runtime is compared
   * with it. Left out, or null for a model, the first validation's own scores become the baseline of
   * that install.
   */
  rankerParityBaseline?: (identity: RankerParityModelIdentity) => RankerParityBaseline | null;
  /**
   * Honour the DEV-only `treatAsRemote` flag of provider configurations (F3 R6, T62): a loopback
   * fake provider then runs in a remote lane under the remote deadlines. Refused in a packaged
   * build whatever is passed; the app sets it from `MEMORA_FAKE_REMOTE` (`treatAsRemoteHonoured`).
   */
  honourTreatAsRemote?: boolean;

  /** The DEV cassette installed for this process: a replay needs no Decisions key (plan decision 30). */
  cassetteMode?: "record" | "replay" | undefined;
  /** DEV only (`MEMORA_RELATIONS_DECISIONS=on`): the Decisions decider is on and a profile with no setup counts as Hybrid. */
  devDecisions?: boolean | undefined;
  /** DEV only (`MEMORA_RELATIONS_DECISIONS_KEY_FILE`): a file holding the key, read instead of the secure store. */
  devDecisionsKeyFile?: string | undefined;
  /** DEV only (`MEMORA_RELATIONS_DECISIONS_CAP_USD`): the day's Decisions spend cap for a proof run. */
  devDecisionsCapUsd?: number | undefined;
  /** Limits, config, fetch and clock of the Decisions decider; the typed defaults apply to what is left out. */
  decisions?: Pick<DecisionsRuntimeOptions, "limits" | "config" | "fetch" | "random" | "now">;
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
  /** Lane priority; background (P2) unless the user waits for the answer (D18, F3 D30). */
  priority?: AiPriorityInput;
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
 * Independent directed pairs (query, document) under one instruction, scored in order (F3 D16): the
 * relation decider's two directions of every candidate. The service splits a longer list at the
 * routed runtime's `rankPairsLimits.perCall` (32 MLX, 16 GGUF), so a P0 call waits for at most one
 * bounded call, and each call takes the local lane on its own.
 */
export interface AiRankPairsInput {
  /** The calling operation, which may have its own route (`op:<operation>`) before `class:decide`. */
  operation: string;
  /** The ranker instruction, rendered from the prompt catalog by the caller. */
  instruction: string;
  pairs: Array<{ query: string; document: string }>;
  /**
   * Sequences per MLX forward pass (default `rankPairsLimits.helperBatchSize`). It is an effective
   * parameter of the call, so the cassette and the decider cache key it (D13); a GGUF ranker scores
   * pairs one by one and has none.
   */
  helperBatchSize?: number;
  /** Lane priority; background (P2) unless the user waits for the answer (D30). */
  priority?: AiPriorityInput;
  /** Sources whose content takes part in the call, for the audit. */
  sourceIds?: string[];
  jobId?: string;
  stage?: string;
  /** The audit of the instruction; read from the prompt runtime when left out. */
  promptCompositions?: PromptCompositionSnapshot[];
}

export interface AiRankPairsResult extends RankResult {
  /** One audit row per call, in call order. */
  aiTaskRunIds: string[];
  calls: number;
  profileId: string;
  localModelId: string;
  provider: string;
  modelId: string;
  runtime: string;
  /** The runtime build that scored, part of the decider cache key (D13). */
  runtimeBuild: string;
  /** The effective parameters of every call: the MLX helper batch, none for GGUF. */
  parameters: { batchSize?: number };
  /**
   * The ranker's last parity check failed (D13): its scores no longer match what a calibration was
   * fitted on, so the caller treats the decider as uncalibrated (suggest only).
   */
  uncalibrated: boolean;
  /** Summed over the calls. */
  durationMs: number;
  queueMs: number;
}

/** What a rank caller uses a ranker for: `documents` is the topic gate's, `pairs` the relation decider's. */
type RankPurpose = "documents" | "pairs";

/** The wire request of one rank call, whichever shape it has. */
interface RankWire {
  request: AiTaskRequest;
  /** Scores the call must return. */
  count: number;
}

/** What a rank call returns before `rank` and `rankPairs` shape it. */
type ExecutedRank = RankResult & {
  aiTaskRunId: string;
  profileId: string;
  localModelId: string;
  provider: string;
  modelId: string;
  runtime: string;
  durationMs: number;
  queueMs: number;
  runtimeBuild: string;
  uncalibrated: boolean;
};

/** The model identity a calibration's parity baseline is looked up by (D13). */
export interface RankerParityModelIdentity {
  runtime: "mlx" | "gguf";
  repository: string;
  revision: string;
  quantization: string;
  artifactSha256: string;
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

/**
 * Residency slots (D18): one generative, one embedding and one ranker model stay loaded; the
 * generative one leaves after an idle period, and the ranker leaves while it is loaded when the
 * machine cannot hold both (F3 D39).
 */
type ResidencySlot = "generate" | "embed" | "rank";
const residencySlots: readonly ResidencySlot[] = ["generate", "embed", "rank"];
/** The MLX helper's model slot of each residency slot. */
const mlxHelperSlots: Record<ResidencySlot, MlxHelperSlot> = {
  generate: "generate",
  embed: "embed",
  rank: "score"
};

interface ResidentLocalAdapter {
  localModelId: string;
  runtime: string;
  adapter: AiModelAdapter;
  /** The catalog minimum of the model's memory; unknown for a model outside the catalog. */
  minimumMemoryBytes?: number | undefined;
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
  priority?: AiPriorityInput;
  /** A second call for the same items after a validation failure; operations named `*_repair` are. */
  isRepair?: boolean;
  /**
   * The strict JSON Schema of the answer (F3 D35), only for a contract that passed the strict
   * compatibility check. The request carries it; the monitoring context does not.
   */
  outputSchema?: AiOutputSchema;
  onProgress?: (event: AiProgressStep) => void;
  /**
   * The answer text as the model writes it (F3 D22), for a runtime that streams it; a runtime that
   * does not stream never calls it. It runs unthrottled and must not throw.
   */
  onTextDelta?: (event: AiTextDelta) => void;
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
  /**
   * The composed texts of an `embedMany` batch; `input` is then their JSON, which the audit hashes.
   * The batch is one lane request, so it is admitted, run and audited as one call (F3 D37).
   */
  inputs?: string[];
  /** Whether a local embedding model stays loaded after the call; read at admission, off the lane. */
  keepLocalEmbeddingLoaded?: boolean;
  /** Admission to execution start on the lane, set when execution starts. */
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
/** A job's AI execution metadata is written again after this long even when it did not change. */
const executionAttachmentTtlMs = 10 * 60_000;

/** The access token of an OAuth adapter is replaced this long before it expires. */
const oauthRefreshMarginMs = 60_000;

/** A remote adapter as the cache keeps it: with what decides when it must be built again. */
interface BuiltRemoteAdapter {
  adapter: AiModelAdapter;
  /** When the OAuth access token it carries expires (epoch ms); absent for an API key. */
  expiresAt?: number;
  credentialRef?: string;
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
  private readonly credentials: CredentialService;
  /** Lanes, priorities and local deadlines of every call (F3 D29-D31); no module state. */
  private readonly scheduler: AiScheduler;
  private readonly laneConfig: AiLaneRuntimeConfig;
  private readonly remoteRuntime: AiRuntimeConfig;
  private readonly localDeadlineHistory = new LocalDeadlineHistory();
  private readonly activeLocalModels = new Set<string>();
  /** The legacy route mapping of this process (D34); reset after a seeding so new routes map too. */
  private legacyRouteMapping: Promise<void> | null = null;
  private classRoutesHelper: AiClassRouteService | null = null;
  private decisionsHelper: DecisionsRuntime | null = null;
  /**
   * Rankers whose validation is queued or running. Decide is unavailable on them: callers take the
   * no-decider path instead of waiting for the lane, and a runtime-build change is validated, with
   * its parity check, before the ranker serves again (D13).
   */
  private readonly validatingRankers = new Map<string, number>();
  private readonly registry = new AiModelRegistry();
  /** What the hot path reads of the configuration, valid for one generation of it (F3 D38). */
  private readonly configCache: AiConfigCache;
  private readonly oauthRefreshes = new Map<string, Promise<OpenAiCodexCredential>>();
  /** The execution metadata last attached to each job, so a job's many calls update it once (D38). */
  private readonly attachedExecutions = new Map<string, { key: string; at: number }>();
  /** The registry key of each provider configuration's adapter, to drop it with the configuration. */
  private readonly remoteAdapterKeys = new Map<string, string>();
  private pendingOpenAiCodexCredential: OpenAiCodexCredential | null = null;
  /** Local models kept loaded, one per slot, so no two generative models are ever resident (D18). */
  private readonly resident: Partial<Record<ResidencySlot, ResidentLocalAdapter>> = {};
  private mlxHost: MlxHelperHost | null;
  /**
   * An MLX adapter was released while the shared helper still holds its weights: an older helper
   * has no `unload`, so the next idle release stops it (the next MLX call starts a fresh one).
   */
  private mlxHoldsReleasedModel = false;
  /** Unloads the generative model once it has been idle for its period (F3 D39). */
  private generativeIdleTimer: ReturnType<typeof setTimeout> | null = null;

  /** The DEV flag `treatAsRemote` counts: unpackaged and asked for (F3 R6). */
  private readonly treatAsRemoteHonoured: boolean;

  public constructor(private readonly options: AiServiceOptions) {
    this.treatAsRemoteHonoured = !options.isPackaged && options.honourTreatAsRemote === true;
    this.credentials = new CredentialService(options.userDataPath);
    this.configCache = new AiConfigCache({ pool: () => options.getPool() });
    this.mlxHost = options.mlxHost ?? null;
    this.laneConfig = resolveAiLaneRuntimeConfig(options.lanes, { packaged: options.isPackaged });
    this.remoteRuntime = resolveAiRuntimeConfig(options.runtime);
    this.scheduler =
      options.scheduler ??
      createAiScheduler(this.laneConfig, undefined, {
        // A breaker moving is the one lane event worth a line: it explains the calls that fail fast.
        onBreakerTransition: (lane, { from, to, reason }) =>
          options.logger?.info(`AI lane ${lane}: circuit breaker ${from} -> ${to} (${reason})`)
      });
  }

  /** The state of every lane the scheduler has seen: limits, waits, rate limits and breakers. */
  public laneSnapshots(): LaneSnapshot[] {
    return this.scheduler.snapshot();
  }

  /** The MLX helper's process and how often it was started; null before the first MLX call (soak). */
  public mlxHelperStats(): { pid: number | undefined; spawnCount: number } | null {
    return this.mlxHost ? { pid: this.mlxHost.pid, spawnCount: this.mlxHost.spawnCount } : null;
  }

  /**
   * Where a routed model runs, for the lane and the deadline mode: the selection plus the DEV flag
   * of its provider configuration when this process honours it (F3 R6). One place, so the lane, the
   * route locality and the deadline can never disagree.
   */
  private executionTarget<T extends Pick<TaskSelection, "providerMetadata">>(
    selection: T
  ): T & { treatAsRemote: boolean } {
    return {
      ...selection,
      treatAsRemote: providerTreatedAsRemote(selection.providerMetadata, this.treatAsRemoteHonoured)
    };
  }

  /**
   * The model a task runs on (`getDefaultTask`), cached for the generation of the configuration so a
   * call reads its route from the database once, not at admission and again inside the lane (F3
   * D38). A writer of the configuration drops it; the pinned selection of an admitted call stays
   * the one it was admitted with, and the `modelChanged` recheck compares it with what is cached now.
   */
  private defaultTask(
    ...args: Parameters<ReturnType<typeof createAiConfigRepository>["getDefaultTask"]>
  ): Promise<TaskSelection | null> {
    const [task, explicitProfileId, routeKeys] = args;
    const keys = routeKeys && routeKeys.length > 0 ? [...routeKeys] : [task];
    return this.configCache.route(JSON.stringify([task, explicitProfileId ?? null, keys]), () =>
      createAiConfigRepository(this.requirePool()).getDefaultTask(...args)
    );
  }

  /** The row of a local model, cached for the generation of the configuration. */
  private localModelRow(id: string): Promise<LocalModelRecord | null> {
    return this.configCache.localModel(id, () =>
      createLocalModelRepository(this.requirePool()).findById(id)
    );
  }

  /** The provider rows, cached for the generation of the configuration. */
  private providerRows(): Promise<AiProviderConfigRecord[]> {
    return this.configCache.providers(() =>
      createAiConfigRepository(this.requirePool()).listProviders()
    );
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
    this.configCache.invalidate();
    if (!deleted) return false;
    this.forgetRemoteAdapter(providerId);
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
    this.configCache.invalidate();
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
      if (known) {
        await repository.cacheProviderModelContext(
          config.id,
          config.provider,
          String(config.metadata.modelId),
          config.baseUrl,
          known
        );
        this.configCache.invalidate();
      }
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
    const created = await createAiConfigRepository(this.requirePool()).createProfile({
      name: input.name,
      isDefault: input.isDefault,
      privacyMode: input.privacyMode,
      outputLanguage: input.outputLanguage,
      ...(input.description !== undefined ? { description: input.description } : {})
    });
    this.configCache.invalidate();
    return mapProfile(created);
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
    this.configCache.invalidate();
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
    if (seeded.length > 0) {
      this.configCache.invalidate();
      // A task that was just routed maps to its class route like any other (D34).
      this.legacyRouteMapping = null;
      await this.ensureLegacyRouteMapping();
      try {
        this.options.onRoutesSeeded?.(seeded);
      } catch (error) {
        this.options.logger?.error("A route seeding listener failed", error);
      }
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
    const cloned = await createAiConfigRepository(this.requirePool()).cloneProfile(profileId, name);
    this.configCache.invalidate();
    return mapProfile(cloned);
  }

  public async deleteProfile(profileId: string): Promise<boolean> {
    const deleted = await createAiConfigRepository(this.requirePool()).deleteProfile(profileId);
    this.configCache.invalidate();
    return deleted;
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
    this.configCache.invalidate();
  }

  /** The five workload classes and the generative judge as Settings shows them (D34). */
  public classRoutes(): Promise<AiClassRoutes> {
    return this.classRouteService().view();
  }

  public applyPreset(input: AiApplyPresetInput): Promise<AiApplyPresetResult> {
    return this.classRouteService().applyPreset(input);
  }

  public testClassRoute(route: AiClassRouteTarget): Promise<AiClassRoutes> {
    return this.classRouteService().testClassRoute(route);
  }

  public setClassRoute(input: AiSetClassRouteInput): Promise<AiClassRoutes> {
    return this.classRouteService().setClassRoute(input);
  }

  public setDeciderMode(mode: NoteDeciderMode | null): Promise<AiClassRoutes> {
    return this.classRouteService().setDeciderMode(mode);
  }

  // --- the Decisions API decider (F3 plan decision 30) ------------------------------------------------

  private decisionsRuntime(): DecisionsRuntime {
    this.decisionsHelper ??= new DecisionsRuntime({
      getPool: () => this.options.getPool(),
      scheduler: this.scheduler,
      registry: this.registry,
      credentials: this.credentials,
      readSecret: (reference) => this.credentialSecret(reference),
      cassetteMode: this.options.cassetteMode,
      devEnabled: this.options.devDecisions,
      devKeyFile: this.options.devDecisionsKeyFile,
      devCapUsd: this.options.devDecisionsCapUsd,
      ...(this.options.monitoring ? { monitoring: this.options.monitoring } : {}),
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      ...(this.options.decisions ?? {})
    });
    return this.decisionsHelper;
  }

  /** What Settings shows of the opt-in OpenAI Decisions decider; never its key. */
  public decisionsStatus(): Promise<DecisionsStatus> {
    return this.decisionsRuntime().status();
  }

  public setDecisionsEnabled(enabled: boolean): Promise<DecisionsStatus> {
    return this.decisionsRuntime().setEnabled(enabled);
  }

  public saveDecisionsKey(apiKey: string): Promise<DecisionsStatus> {
    return this.decisionsRuntime().saveKey(apiKey);
  }

  public removeDecisionsKey(): Promise<DecisionsStatus> {
    return this.decisionsRuntime().removeKey();
  }

  public testDecisionsKey(signal?: AbortSignal): Promise<DecisionsStatus> {
    return this.decisionsRuntime().testKey(signal);
  }

  /** Whether the next relation matching decides with the Decisions API, and if not why (the status). */
  public resolveDecisions(): Promise<DecisionsResolution> {
    return this.decisionsRuntime().resolve();
  }

  /**
   * Scores directed lists on the Decisions API (the candidate lists stay the matcher's): the
   * validated request design on the decider's own remote lane. Throws `DecisionsUnavailableError`
   * when it cannot decide, so the matcher falls back to the local ranker.
   */
  public decideWithDecisions(
    input: DecisionsDecideInput,
    signal?: AbortSignal
  ): Promise<DecisionsDecideResult> {
    return this.decisionsRuntime().decide(input, signal);
  }

  private classRouteService(): AiClassRouteService {
    this.classRoutesHelper ??= new AiClassRouteService({
      getPool: () => this.options.getPool(),
      ai: this,
      ...(this.options.machine ? { machine: this.options.machine } : {}),
      ensureLegacyMapping: () => this.ensureLegacyRouteMapping(),
      // Leaving the Hybrid and Cloud setups stops the opt-in Decisions decider (plan decision 30).
      onPresetChanged: (mode) => this.decisionsRuntime().presetChanged(mode),
      ...(this.options.logger ? { logger: this.options.logger } : {})
    });
    return this.classRoutesHelper;
  }

  /**
   * Maps the legacy task routes to the class routes (`mapLegacyRoutesV1`, D34) before the first
   * call that resolves a route, and again after a seeding. It never fails a call: a failure is
   * logged and the task routes keep choosing, as they did before. Code that reads the routes
   * itself before it calls (the relation matcher's decider resolution) awaits it first.
   */
  public ensureLegacyRouteMapping(): Promise<void> {
    if (this.legacyRouteMapping) return this.legacyRouteMapping;
    const pool = this.options.getPool();
    // Without a database there is nothing to map yet; the next call tries again.
    if (!pool) return Promise.resolve();
    this.legacyRouteMapping = mapLegacyRoutesV1(createRouteMappingStore(pool)).then(
      () => undefined,
      (error: unknown) => {
        this.options.logger?.error("Mapping the legacy AI routes failed", error);
      }
    );
    return this.legacyRouteMapping;
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
    this.configCache.invalidate();
  }

  public async describePromptRoute(task: string) {
    const selection = await this.defaultTask(task);
    return selection
      ? {
          provider: selection.provider,
          modelId: selection.modelId,
          repository: selection.repository
        }
      : null;
  }

  /**
   * Where the model a task is routed to runs: `local` for a local runtime or an endpoint on this
   * machine, `remote` for a provider, null when no route serves the task. Work that is sized by the
   * writer (F3 D36) asks before it plans; the answer follows the route keys a real call resolves.
   */
  public async taskRouteLocality(
    task: RoutedTask,
    context: Pick<AiTaskLogContext, "operation" | "workloadClass"> = {}
  ): Promise<"local" | "remote" | null> {
    // The class routes exist before a route is read, as for a real call (D34).
    await this.ensureLegacyRouteMapping();
    const selection = await this.defaultTask(task, undefined, taskRouteKeys(task, context));
    if (!selection) return null;
    return isRemoteExecution(this.executionTarget(selection)) ? "remote" : "local";
  }

  /**
   * What the model a task is routed to can take in one call: the context window its calls are
   * admitted against and the output they reserve, read without a call (plan decision 28). Work whose
   * input grows with its source (a book's summary) sizes its calls by it before it plans. Null when
   * no route serves the task.
   */
  public async taskRouteCapacity(
    task: RoutedTask,
    context: Pick<AiTaskLogContext, "operation" | "workloadClass"> = {}
  ): Promise<TaskRouteCapacity | null> {
    await this.ensureLegacyRouteMapping();
    const selection = await this.defaultTask(task, undefined, taskRouteKeys(task, context));
    return selection ? routeCapacity(task, selection, context.operation) : null;
  }

  public async pinOrganizationProfile(
    profileId: string | undefined,
    _legacyPrivacy: "offline_only" | "allow_remote",
    route?: { workloadClass?: AiWorkloadClass; operation?: string }
  ): Promise<OrganizationProfile> {
    // The route keys of the stated class and operation apply when no profile is chosen (D18).
    const selection = route
      ? await this.defaultTask(
          "structured-output",
          profileId,
          aiRouteKeys("structured-output", route)
        )
      : await this.defaultTask("structured-output", profileId);
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
    priority?: AiPriorityInput
  ) {
    return this.admitTask(
      "embedding",
      text,
      {
        stage: "wiki_consultation",
        embeddingInputType: "query",
        workloadClass: "embed",
        priority: priority ?? "P0",
        sourceItemIds
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

  /**
   * Embeds several texts with the routed embedding model (F3 D37). The texts are split into batches
   * of at most {@link embedManyLimits.perExecution}; each batch is one lane request, so a P0 call
   * waits for at most one bounded batch, and one audit row with the number of texts. A route whose
   * adapter has no `embedMany` runs the texts one by one inside the same lane request. The vectors
   * are those of single `runDefaultTask` calls and live in the same embedding space, so the space key
   * is the route's, whichever way a text was embedded. Returns null when no embedding model is routed
   * (or there is nothing to embed). Callers that store each batch as it arrives pass at most one
   * batch, so a failure keeps what the earlier batches stored.
   */
  public async embedMany(
    texts: readonly string[],
    logContext: AiTaskLogContext = {},
    signal?: AbortSignal
  ): Promise<AiEmbedManyExecution | null> {
    if (texts.length === 0) return null;
    const parts: DefaultAiTaskResult[] = [];
    const embeddings: number[][] = [];
    for (const batch of chunked(texts, embedManyLimits.perExecution)) {
      signal?.throwIfAborted();
      const part = await this.admitTask(
        "embedding",
        batch,
        { embeddingInputType: "document", workloadClass: "embed", ...logContext },
        signal
      );
      if (!part) {
        if (parts.length === 0) return null;
        throw new Error("organization.errors.modelChanged");
      }
      // The configuration changed between two batches: their vectors would mix spaces.
      if (parts[0] && parts[0].embeddingSpaceKey !== part.embeddingSpaceKey)
        throw new Error("organization.errors.modelChanged");
      embeddings.push(...readEmbeddingBatch(part.output, batch.length));
      parts.push(part);
    }
    const first = parts[0]!;
    return {
      embeddings,
      profileId: first.profileId,
      providerId: first.providerId,
      modelId: first.modelId,
      runtime: first.runtime,
      embeddingSpaceKey: first.embeddingSpaceKey ?? "",
      aiTaskRunIds: parts.map((part) => part.aiTaskRunId),
      calls: parts.length,
      durationMs: parts.reduce((total, part) => total + part.durationMs, 0)
    };
  }

  private async preparePromptAdmission(
    task: RoutedTask,
    input: string | readonly string[],
    context: AiTaskLogContext,
    pin: PromptPin,
    baseAudit: PromptCompositionSnapshot[],
    pinned?: OrganizationProfile,
    /** The audit of each text of a batch, read where the caller rendered it (not under the pin). */
    batchAudits: PromptCompositionSnapshot[][] = []
  ): Promise<PromptAdmission | null> {
    const repository = createAiConfigRepository(this.requirePool());
    const routeKeys = taskRouteKeys(task, context);
    // The class routes exist before the first call resolves one (D34).
    await this.ensureLegacyRouteMapping();
    let found = await this.defaultTask(task, pinned?.profileId, routeKeys);
    // A task without a route is routed to the first configured profile that can serve it. A concurrent
    // call may have created the route first, so the task is looked up again whatever this call seeded.
    if (!found && !pinned) {
      await this.seedTaskRoutes(repository);
      found = await this.defaultTask(task, undefined, routeKeys);
    }
    const selection = found ? structuredClone(found) : null;
    if (!selection) {
      if (pinned) throw new Error("organization.errors.model");
      return null;
    }
    const language = context.contentLanguage ?? (await this.options.getContentLanguage?.()) ?? "en";
    // Read here, off the lane: a local embedding call used to read the setting inside its slot.
    const keepLocalEmbeddingLoaded =
      task === "embedding" && selection.localModelId
        ? await (async () => (await this.options.getKeepLocalEmbeddingModelsLoaded?.()) ?? true)()
            // A setting that cannot be read leaves the model loaded, as an unset one does.
            .catch(() => true)
        : undefined;
    return withPromptPin(pin, () => {
      const compose = (text: string, audit: PromptCompositionSnapshot[]) =>
        task === "embedding"
          ? withEmbeddingInputInstruction(
              audit.length
                ? text
                : renderPrompt(
                    context.embeddingInputType === "query"
                      ? "embedding.query"
                      : "embedding.content.chunk",
                    context.embeddingInputType === "query" ? { query: text } : { source_text: text }
                  ),
              selection.modelId,
              selection.repository,
              context.embeddingInputType
            )
          : audit.some((s) => s.promptId.startsWith("diagnostics."))
            ? text
            : withOutputLanguageInstruction(text, language);
      const instruction =
        selection.provider === "openai-codex"
          ? renderPrompt("shared.codex_adapter_instruction")
          : "";
      const keep = keepLocalEmbeddingLoaded === undefined ? {} : { keepLocalEmbeddingLoaded };
      if (typeof input !== "string") {
        // A batch: every text composes on its own, and the audit lists each composition once.
        const inputs = input.map((text, index) => compose(text, batchAudits[index] ?? []));
        return {
          selection,
          input: JSON.stringify(inputs),
          inputs,
          instruction,
          compositions: uniqueCompositions([
            ...batchAudits.flat(),
            ...inputs.flatMap(promptAudit),
            ...promptAudit(instruction)
          ]),
          pin,
          language,
          ...keep
        };
      }
      const prepared = compose(input, baseAudit);
      return {
        selection,
        input: prepared,
        instruction,
        compositions: [...baseAudit, ...promptAudit(prepared), ...promptAudit(instruction)],
        pin,
        language,
        ...keep
      };
    });
  }

  private async admitTask(
    task: RoutedTask,
    input: string | readonly string[],
    context: AiTaskLogContext,
    signal?: AbortSignal,
    limits?: { maxOutputTokens: number },
    pinned?: OrganizationProfile,
    beforeProvider?: () => Promise<void>
  ): Promise<DefaultAiTaskResult | null> {
    const pin = capturePromptPin(),
      baseAudit =
        typeof input === "string" ? (context.promptCompositions ?? promptAudit(input)) : [];
    const batchAudits = typeof input === "string" ? [] : input.map((text) => promptAudit(text));
    // The admission is reserved now, so FIFO order and aging count from here while the source-free
    // routing preparation reads the route that decides the lane, without model loading or telemetry.
    const reservation = this.scheduler.reserve();
    const admittedAt = Date.now();
    // Preparing and waiting for the lane do not count against the caller's own timeout.
    const deadline = ActiveDeadline.of(signal);
    deadline?.pause();
    let preparing = true;
    const prepared = () => {
      if (!preparing) return;
      preparing = false;
      deadline?.resume();
    };
    try {
      const admission = await untilAborted(
        this.preparePromptAdmission(task, input, context, pin, baseAudit, pinned, batchAudits),
        signal
      );
      if (!admission) return null;
      const { lane, remoteKind } = executionLane(this.executionTarget(admission.selection));
      const priority = aiTaskPriority(context);
      const workloadClass = requestWorkloadClass({
        taskType: task,
        workloadClass: context.workloadClass
      });
      const execution = this.scheduler.run(
        {
          lane,
          remoteKind,
          priority,
          workloadClass,
          signal,
          label: context.operation ?? context.stage ?? task,
          reservation,
          pauses: deadline ? [deadline] : []
        },
        (permit) =>
          withPromptPin(pin, async () => {
            await beforeProvider?.();
            signal?.throwIfAborted();
            return this.executeDefaultTask(
              task,
              context,
              signal,
              limits,
              pinned,
              beforeProvider,
              { ...admission, queueMs: permit.queueMs },
              permit
            );
          })
      );
      // The scheduler stops the caller's clock itself while the call waits for its lane.
      prepared();
      const complete = await execution.catch((error: unknown) => {
        if (!(error instanceof ProviderUnavailableError)) throw error;
        // An open circuit breaker failed the call fast (D32): nothing was sent, the audit says so.
        const deadlineMs = this.callDeadlineMs(admission.selection, task, context.workloadClass);
        return () =>
          this.recordUnstartedTask(
            task,
            context,
            signal,
            pinned,
            { ...admission, queueMs: Date.now() - admittedAt },
            error,
            (failure) =>
              laneAudit(
                { lane, workloadClass, priority, releasedMs: 0, requeueMs: 0 },
                deadlineMs,
                context,
                signal,
                failure
              )
          );
      });
      // The lane is free again: the audit and the monitoring entry are written outside it.
      return await complete();
    } finally {
      prepared();
    }
  }

  /**
   * Runs one admitted call on its lane. It returns what completes the call once the lane is
   * released (F3 D38): the audit row and the monitoring entry, then the result or the error.
   */
  private async executeDefaultTask(
    taskType: RoutedTask,
    logContext: AiTaskLogContext,
    signal: AbortSignal | undefined,
    limits: { maxOutputTokens: number } | undefined,
    pinned: OrganizationProfile | undefined,
    beforeProvider: (() => Promise<void>) | undefined,
    admission: PromptAdmission,
    permit: LanePermit
  ): Promise<() => Promise<DefaultAiTaskResult>> {
    const { onProgress, onTextDelta, onProviderStart, outputSchema, ...structuredLogContext } =
      logContext;
    const sourceItemIds = taskSourceItemIds(structuredLogContext);
    const repository = createAiConfigRepository(this.requirePool());
    const selection = admission.selection;
    const deadlineMs = this.callDeadlineMs(selection, taskType, logContext.workloadClass);
    const lane = (failure?: { error: unknown }) =>
      laneAudit(permit, deadlineMs, logContext, signal, failure);
    let parameters: ReturnType<typeof aiModelParametersSchema.parse>;
    const keepLocalEmbeddingModelLoaded = admission.keepLocalEmbeddingLoaded ?? true;
    const batch = admission.inputs;
    try {
      if (pinned) {
        const current = await this.pinOrganizationProfile(pinned.profileId, pinned.privacy);
        if (current.identityHash !== pinned.identityHash)
          throw new Error("organization.errors.modelChanged");
      }
      parameters = aiModelParametersSchema.parse(
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
    } catch (error) {
      // Nothing was sent to a model: the audit row records the failed admission.
      return () =>
        this.recordUnstartedTask(taskType, logContext, signal, pinned, admission, error, lane);
    }
    const plannedOutputTokens = parameters.maxTokens ?? 16384;
    const outputLanguage = admission.language;
    const taskInput = admission.input;
    // One audit row per execution: a batch says how many texts it embedded.
    const audited = (options: AiTaskResult["requestOptions"] | undefined) =>
      auditedParameters(batch ? { ...parameters, items: batch.length } : parameters, options);
    const releaseEmbeddingModel = async () => {
      if (selection.localModelId && taskType === "embedding" && !keepLocalEmbeddingModelLoaded)
        await this.releaseLocalModel(selection.localModelId).catch((error) => {
          this.options.logger?.error("Failed to release local embedding runtime", error);
        });
    };
    const started = Date.now();
    // Not awaited on the lane: the entry is completed after the lane is released.
    const capture = this.startMonitoring({
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
          selection.provider === "openai-codex" ? admission.instruction : "",
          plannedOutputTokens
        );
        if (plannedTokens > parameters.contextWindow)
          throw new Error("errors.ai.contextWindowLimit");
      }
      // The route key that chose the profile names the profile task to compare with.
      const currentSelection = await this.defaultTask(
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
      if (
        structuredLogContext.jobId &&
        this.executionAttachmentDue(structuredLogContext.jobId, {
          provider: selection.provider,
          modelId: selection.modelId,
          reasoningLevel: parameters.reasoningLevel ?? null
        })
      ) {
        try {
          await createJobRepository(this.requirePool()).setAiExecution(structuredLogContext.jobId, {
            provider: selection.provider,
            modelId: selection.modelId,
            reasoningLevel: parameters.reasoningLevel ?? null
          });
        } catch (error) {
          this.attachedExecutions.delete(structuredLogContext.jobId);
          this.options.logger?.error("Failed to attach AI execution metadata to job", error);
        }
      }
      // A remote adapter is used as it was created: on concurrent lanes another call may register
      // one with the same provider and model ids meanwhile. Local adapters are resident.
      const adapter = selection.localModelId
        ? this.registry.resolve({
            providerId: descriptor.providerId,
            modelId: descriptor.modelId,
            requiredCapabilities,
            offlineOnly: true
          })
        : withCapabilities(configuredAdapter, requiredCapabilities);
      const request: AiTaskRequest = {
        taskType,
        // A batch's texts travel as `embedMany`'s own argument; the request is the template of each.
        input: batch ? "" : taskInput,
        profileId: selection.profileId,
        modelId: selection.modelId,
        requiredCapabilities,
        parameters,
        metadata: { applicationInstruction: admission.instruction },
        // A stated class sets the deadlines; the operation names the caller.
        ...(logContext.workloadClass ? { workloadClass: logContext.workloadClass } : {}),
        ...requestOperation(logContext.operation),
        ...(outputSchema ? { outputSchema } : {})
      };
      // The adapter's signal carries the lane permit, so retry backoffs sleep off the lane.
      const execution = laneSignal(signal, permit);
      const progress = createProgressReporter(onProgress, onTextDelta);
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
        // A batch is one execution: the adapter's `embedMany`, else its single calls in order.
        if (batch) return runEmbeddingBatch(adapter, request, batch, logContext, execution);
        // Remote generation always streams, so its connect, first-byte and stall deadlines apply.
        return adapter.runStreaming && runsStreaming(adapter, taskType)
          ? adapter.runStreaming(request, execution, progress)
          : adapter.run(request, execution);
      };
      const runLocal = async () => {
        if (taskType !== "embedding")
          await this.beforeLocalGeneration(selection.localModelId!, adapter);
        const needsLoad =
          taskType === "embedding" && adapter.isLoaded?.() === false && adapter.ensureLoaded;
        if (needsLoad) {
          this.options.onLocalEmbeddingLoadStatus?.({
            state: "loading",
            modelId: selection.modelId
          });
          try {
            await adapter.ensureLoaded?.(execution);
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
      this.localDeadlineHistory.settled(selection.localModelId, taskInput);
      await releaseEmbeddingModel();
      return async () => {
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
          parameters: audited(result.requestOptions),
          promptCompositions: admission.compositions,
          inputHash: sha256(taskInput),
          outputHash: sha256(JSON.stringify(result.output)),
          ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
          ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
          ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {}),
          durationMs: result.durationMs,
          ...queueAndAttempt(admission, logContext),
          ...lane(),
          ...(result.schemaMode ? { schemaMode: result.schemaMode } : {}),
          status: "succeeded",
          sourceItemIds
        });
        await this.options.monitoring?.finish(await capture, {
          status: "succeeded",
          aiTaskRunId,
          durationMs: Date.now() - started,
          tokenUsage: monitoringUsage(result),
          parameters: audited(result.requestOptions),
          output: batch ? embeddingBatchSummary(result.output) : result.output,
          ...(result.attempts !== undefined
            ? { details: callDetails(result.attempts, result.retriedUsage) }
            : {}),
          ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {})
        });
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
      };
    } catch (caught) {
      // An abandoned local call keeps the local lane until its runtime is disposed (F3 D31).
      this.holdWedgedLocalLane(permit, caught);
      const error = this.localDeadlineHistory.verdict(selection.localModelId, taskInput, caught, {
        aborted: Boolean(signal?.aborted),
        deadlineMs
      });
      // What the failed call cost and the wire options of its last request, which may be a fallback.
      const failedReport = remoteCallReport(caught);
      const durationMs = Date.now() - started;
      await releaseEmbeddingModel();
      return async () => {
        const aiTaskRunId = await repository.recordTaskRun({
          profileId: selection.profileId,
          taskType,
          provider: selection.provider,
          modelId: selection.modelId,
          runtime: selection.runtime,
          adapter: selection.localModelId
            ? localAdapterName(selection.runtime)
            : selection.provider,
          repository: selection.repository,
          revision: selection.revision,
          quantization: selection.quantization,
          parameters: audited(failedReport?.requestOptions),
          promptCompositions: admission.compositions,
          inputHash: sha256(taskInput),
          durationMs,
          ...queueAndAttempt(admission, logContext),
          ...failedCallUsage(caught),
          ...lane({ error }),
          ...failedSchemaMode(failedReport?.requestOptions),
          status: signal?.aborted ? "canceled" : "failed",
          error: redactSensitiveText(error),
          sourceItemIds
        });
        await this.options.monitoring?.finish(await capture, {
          status: signal?.aborted ? "canceled" : "failed",
          aiTaskRunId,
          durationMs: Date.now() - started,
          error: redactSensitiveText(error),
          parameters: audited(failedReport?.requestOptions),
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
        if (error instanceof Error) Object.assign(error, { aiTaskRunId });
        throw error;
      };
    }
  }

  /** The audit of an admitted call that failed before anything was sent to a model. */
  private async recordUnstartedTask(
    taskType: RoutedTask,
    context: AiTaskLogContext,
    signal: AbortSignal | undefined,
    pinned: OrganizationProfile | undefined,
    admission: PromptAdmission,
    error: unknown,
    lane: (failure?: { error: unknown }) => LaneAuditFields
  ): Promise<never> {
    const selection = admission.selection;
    const aiTaskRunId = await createAiConfigRepository(this.requirePool()).recordTaskRun({
      profileId: selection.profileId,
      taskType,
      provider: selection.provider,
      modelId: selection.modelId,
      runtime: selection.runtime,
      parameters: {
        ...(pinned?.parameters ?? {
          ...selection.modelDefaultParameters,
          ...selection.parameters
        }),
        ...(admission.inputs ? { items: admission.inputs.length } : {})
      },
      promptCompositions: admission.compositions,
      inputHash: sha256(admission.input),
      durationMs: 0,
      ...queueAndAttempt(admission, context),
      ...lane({ error }),
      status: signal?.aborted ? "canceled" : "failed",
      error: redactSensitiveText(error),
      sourceItemIds: taskSourceItemIds(context)
    });
    if (error instanceof Error) Object.assign(error, { aiTaskRunId });
    throw error;
  }

  /** The total deadline of a call on a route (F3 D31): the local one, else the remote one. */
  private callDeadlineMs(
    selection: Pick<
      TaskSelection,
      "localModelId" | "provider" | "baseUrl" | "providerConfigId" | "providerMetadata"
    >,
    taskType: AiTaskRequest["taskType"],
    statedClass: AiWorkloadClass | undefined
  ): number {
    const workloadClass = requestWorkloadClass({ taskType, workloadClass: statedClass });
    if (selection.localModelId)
      return localDeadlineMs(this.laneConfig.localDeadlines, workloadClass);
    // OpenAI-compatible servers on this machine get the longer local total (remote-execution.ts);
    // a fake the soak marks `treatAsRemote` keeps the remote one (F3 R6).
    const servedLocally =
      selection.provider === "openai-compatible" &&
      !isRemoteExecution(this.executionTarget(selection));
    return remoteTotalDeadlineMs(this.remoteRuntime, workloadClass, servedLocally);
  }

  /**
   * Whether the job's AI execution metadata must be written for this call: not when the same model
   * and reasoning level were attached to the job a moment ago. A job makes many calls with one model;
   * each used to update its row inside the lane.
   */
  private executionAttachmentDue(jobId: string, execution: JsonObject): boolean {
    const key = JSON.stringify(execution);
    const attached = this.attachedExecutions.get(jobId);
    const now = Date.now();
    if (attached?.key === key && now - attached.at < executionAttachmentTtlMs) return false;
    this.attachedExecutions.delete(jobId);
    this.attachedExecutions.set(jobId, { key, at: now });
    // Oldest first out: a long session makes many jobs.
    if (this.attachedExecutions.size > 512)
      this.attachedExecutions.delete(this.attachedExecutions.keys().next().value!);
    return true;
  }

  /** Starts a monitoring entry without waiting for it; a failed start is no entry. */
  private startMonitoring(
    input: Parameters<MonitoringService["start"]>[0]
  ): Promise<Awaited<ReturnType<MonitoringService["start"]>> | undefined> {
    const monitoring = this.options.monitoring;
    if (!monitoring) return Promise.resolve(undefined);
    return Promise.resolve()
      .then(() => monitoring.start(input))
      .catch((error: unknown) => {
        this.options.logger?.error("Failed to start an AI monitoring entry", error);
        return undefined;
      });
  }

  public async traceOperation<T>(
    operation: string,
    context: AiTaskLogContext,
    run: () => Promise<T>,
    details: Record<string, unknown> = {}
  ): Promise<T> {
    // The listeners are the caller's; the monitor records data.
    const metadata: Record<string, unknown> = { ...context };
    for (const listener of ["onProgress", "onTextDelta", "onProviderStart"])
      delete metadata[listener];
    return this.options.monitoring
      ? this.options.monitoring.operation(operation, metadata, run, details)
      : run();
  }

  public isLocalModelInUse(localModelId: string): boolean {
    if (this.activeLocalModels.has(localModelId)) return true;
    return residencySlots.some((slot) => {
      const occupant = this.resident[slot];
      return occupant?.localModelId === localModelId && isWedged(occupant.adapter);
    });
  }

  /**
   * Whether a resident model is in use: running a call, or wedged by a call that ignored its
   * deadline (F3 D31), whose runtime is disposed by its own recovery once that call ended.
   */
  private occupied(occupant: ResidentLocalAdapter): boolean {
    return this.activeLocalModels.has(occupant.localModelId) || isWedged(occupant.adapter);
  }

  /**
   * After a call its runtime abandoned (F3 D31, C11) the local lane stays held until the runtime
   * was disposed; meanwhile every call that needs the lane fails visibly with `wedged` instead of
   * waiting, its deadline paused, behind a native call that may not end for minutes.
   */
  private holdWedgedLocalLane(permit: LanePermit, error: unknown): void {
    if (!(error instanceof LocalDeadlineError) || !error.recovery) return;
    permit.holdUntil(error.recovery, {
      refuse: (entry) =>
        localRuntimeWedgedError(
          localDeadlineMs(this.laneConfig.localDeadlines, entry.workloadClass)
        )
    });
  }

  /**
   * Releases the resident local models that are not running a call (all of them with `force`).
   * The ranker stays loaded (D18), the generative model leaves on its own idle timer (F3 D39), and
   * an embedding model stays when `keepEmbedding` is set, so a gate call between two embedding
   * calls reloads neither. A released MLX model is unloaded from the shared helper, which keeps
   * running; an older helper without `unload` is stopped once no MLX call runs.
   */
  public async releaseLocalRuntime(force = false, keepEmbedding = false): Promise<void> {
    for (const slot of residencySlots) {
      const occupant = this.resident[slot];
      if (!occupant) continue;
      if (!force) {
        if (this.occupied(occupant)) continue;
        if (slot === "rank" || slot === "generate") continue;
        if (keepEmbedding && occupant.adapter.describe().capabilities.includes("embedding"))
          continue;
      }
      // Stopping everything stops the helper too: no unload first.
      await this.releaseSlot(slot, { unload: !force });
    }
    await this.stopIdleMlxHelper(force);
  }

  public async dispose(): Promise<void> {
    this.clearGenerativeIdleTimer();
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
    // Validated before it waits for the lane.
    const request = parseRankRequest({
      instruction: input.instruction,
      query: input.query,
      documents: input.documents
    });
    const pin = capturePromptPin();
    const compositions = input.promptCompositions ?? promptAudit(input.instruction);
    return this.runRankCall(
      input,
      { request: rankTaskRequest(request), count: request.documents.length },
      { pin, compositions, purpose: "documents" },
      signal
    );
  }

  /**
   * Scores independent directed pairs on the validated dedicated ranker of the operation's route,
   * the way {@link rank} scores documents, for the relation decider (F3 D16, T50). A list longer
   * than the routed runtime's `rankPairsLimits.perCall` is split into calls of at most that many
   * pairs (32 on MLX, 16 on GGUF), each taking the local lane on its own, so a P0 call waits for
   * at most one bounded call. Each call is audited on its own row and carries the helper batch size
   * in its parameters. The whole list is validated before any call waits for the lane.
   *
   * Unlike {@link rank}, a ranker whose parity check failed still scores (the relation decider
   * suggests only when `uncalibrated` is set); it is unavailable only while it validates or when
   * it is not validated.
   */
  public async rankPairs(
    input: AiRankPairsInput,
    signal?: AbortSignal
  ): Promise<AiRankPairsResult> {
    const { model } = await this.resolveDecideRoute(
      createAiConfigRepository(this.requirePool()),
      input.operation,
      "pairs"
    );
    const runtime = model.runtime === "mlx" ? "mlx" : "gguf";
    const perCall = rankPairsLimits.perCall[runtime];
    // MLX alone has a helper batch; the effective parameters say so (D13).
    const batchSize =
      runtime === "mlx" ? (input.helperBatchSize ?? rankPairsLimits.helperBatchSize) : undefined;
    // Validated before the first call waits for the lane.
    const wires = chunked(input.pairs, perCall).map((pairs): RankWire => {
      const request = parseRankPairsRequest({ instruction: input.instruction, pairs });
      return {
        request: rankPairsTaskRequest(request, batchSize === undefined ? {} : { batchSize }),
        count: request.pairs.length
      };
    });
    if (wires.length === 0) {
      throw new LocalRankerError("errors.ai.unsupportedTask", "A pairs request needs a pair.");
    }
    const pin = capturePromptPin();
    const compositions = input.promptCompositions ?? promptAudit(input.instruction);
    const parts: ExecutedRank[] = [];
    for (const wire of wires) {
      signal?.throwIfAborted();
      parts.push(
        await this.runRankCall(input, wire, { pin, compositions, purpose: "pairs" }, signal)
      );
    }
    const last = parts.at(-1)!;
    return {
      logOdds: parts.flatMap((part) => part.logOdds),
      scores: parts.flatMap((part) => part.scores),
      tokenCounts: parts.flatMap((part) => part.tokenCounts),
      truncated: parts.flatMap((part) => part.truncated),
      aiTaskRunIds: parts.map((part) => part.aiTaskRunId),
      calls: parts.length,
      profileId: last.profileId,
      localModelId: last.localModelId,
      provider: last.provider,
      modelId: last.modelId,
      runtime: last.runtime,
      runtimeBuild: last.runtimeBuild,
      parameters: batchSize === undefined ? {} : { batchSize },
      uncalibrated: parts.some((part) => part.uncalibrated),
      durationMs: parts.reduce((total, part) => total + part.durationMs, 0),
      queueMs: parts.reduce((total, part) => total + part.queueMs, 0)
    };
  }

  /** One rank call on the local lane; its audit is written once the lane is free. */
  private async runRankCall(
    input: Pick<AiRankInput, "operation" | "priority" | "sourceIds" | "jobId" | "stage">,
    wire: RankWire,
    admission: {
      pin: PromptPin;
      compositions: PromptCompositionSnapshot[];
      purpose: RankPurpose;
    },
    signal: AbortSignal | undefined
  ): Promise<ExecutedRank> {
    const { pin, compositions, purpose } = admission;
    // The wait for the local lane does not count against the caller's own timeout.
    const deadline = ActiveDeadline.of(signal);
    const complete = await this.scheduler.run(
      {
        lane: "local",
        priority: aiTaskPriority({ priority: input.priority }),
        workloadClass: "decide",
        signal,
        label: input.operation,
        pauses: deadline ? [deadline] : []
      },
      (permit) =>
        withPromptPin(pin, () =>
          this.executeRank(input, wire, compositions, purpose, permit, signal)
        )
    );
    // The audit and the monitoring entry are written once the lane is free.
    return complete();
  }

  /**
   * Whether rank calls of an operation have a ranker to run on (see {@link DecideRouteStatus}).
   * `purpose` is `documents` for the topic gate's calibrated scores (a failed parity check closes
   * it, D13) and `pairs` for the relation decider.
   */
  public async decideRouteStatus(
    operation?: string,
    purpose: RankPurpose = "documents"
  ): Promise<DecideRouteStatus> {
    try {
      await this.resolveDecideRoute(
        createAiConfigRepository(this.requirePool()),
        operation,
        purpose
      );
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
    const routed = await this.routedEmbedding();
    if (!routed) return null;
    const { selection, parameters, spaceKey } = routed;
    const newest = await createEmbeddingRepository(this.requirePool()).newestNoteVectorSpace();
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

  /** The space key of the routed embedding model, computed without an AI call (D26); null without one. */
  public async embeddingRouteSpaceKey(): Promise<string | null> {
    return (await this.routedEmbedding())?.spaceKey ?? null;
  }

  /** The routed embedding model, its call parameters and its space key, without an AI call. */
  private async routedEmbedding(): Promise<{
    selection: TaskSelection;
    parameters: JsonObject;
    spaceKey: string;
  } | null> {
    const repository = createAiConfigRepository(this.requirePool());
    // The keys every embedding caller resolves: its class route first, then the task route (D34).
    const keys = aiRouteKeys("embedding", { workloadClass: "embed" });
    let selection = await this.defaultTask("embedding", undefined, keys);
    if (!selection) {
      await this.seedTaskRoutes(repository);
      selection = await this.defaultTask("embedding", undefined, keys);
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
    return { selection, parameters, spaceKey };
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
      const model = await this.localModelRow(selection.localModelId);
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
   * The ranker is unavailable while it validates (the caller takes its no-decider path instead of
   * waiting), and, for the `documents` purpose, when its last parity check failed (D13): the topic
   * gate's calibration was fitted on scores the rebuilt runtime no longer produces.
   */
  private async resolveDecideRoute(
    repository: ReturnType<typeof createAiConfigRepository>,
    operation: string | undefined,
    purpose: RankPurpose
  ): Promise<{ selection: TaskSelection; model: LocalModelRecord; entry: LocalModelCatalogEntry }> {
    const keys = [...(operation ? [operationRouteKey(operation)] : []), decideRouteKey];
    let found = await this.defaultTask(decideRouteKey, undefined, keys);
    if (!found) {
      await this.seedTaskRoutes(repository);
      found = await this.defaultTask(decideRouteKey, undefined, keys);
    }
    if (!found) throw new Error("errors.ai.noCompatibleModel");
    // A remote or generative model never ranks: there is no generative fallback (D10, D17).
    if (!found.localModelId) throw new Error("errors.ai.unsupportedTask");
    const model = await this.localModelRow(found.localModelId);
    if (!model || model.status !== "ready" || !model.managedPath)
      throw new Error("errors.localModels.notReady");
    const entry = findLocalModelCatalogEntry(model.catalogId);
    if (!entry || !isRankerCatalogEntry(entry)) throw new Error("errors.ai.unsupportedTask");
    if (!rankerReadyForDecide(model, entry) || this.validatingRankers.has(model.id))
      throw new Error("errors.localModels.rankerNotValidated");
    if (purpose === "documents" && decideValidationParityFailed(model.metadata.decideValidation))
      throw new Error("errors.localModels.rankerNotValidated");
    return { selection: structuredClone(found), model, entry };
  }

  private async executeRank(
    input: Pick<AiRankInput, "operation" | "priority" | "sourceIds" | "jobId" | "stage">,
    wire: RankWire,
    compositions: PromptCompositionSnapshot[],
    purpose: RankPurpose,
    permit: LanePermit,
    signal: AbortSignal | undefined
  ): Promise<() => Promise<ExecutedRank>> {
    signal?.throwIfAborted();
    const repository = createAiConfigRepository(this.requirePool());
    const { selection, model, entry } = await this.resolveDecideRoute(
      repository,
      input.operation,
      purpose
    );
    const sourceItemIds = [...new Set(input.sourceIds ?? [])];
    const queueMs = permit.queueMs;
    const taskRequest: AiTaskRequest = {
      ...wire.request,
      profileId: selection.profileId,
      modelId: selection.modelId,
      workloadClass: "decide",
      ...requestOperation(input.operation)
    };
    // The effective parameters: none for a documents call, the MLX helper batch for a pairs call.
    const parameters = taskRequest.parameters as JsonObject;
    const taskInput = String(taskRequest.input);
    const adapterName = localAdapterName(model.runtime);
    const deadlineMs = localDeadlineMs(this.laneConfig.localDeadlines, "decide");
    const lane = (failure?: { error: unknown }) =>
      laneAudit(permit, deadlineMs, { operation: input.operation }, signal, failure);
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
      parameters,
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
    // Not awaited on the lane: the entry is completed after the lane is released.
    const capture = this.startMonitoring({
      kind: "ai",
      operation: input.operation,
      taskType: "reranking",
      stage: input.stage ?? input.operation,
      context: {
        origin:
          aiTaskPriority({ priority: input.priority }) === "P0"
            ? "interactive"
            : input.jobId
              ? "job"
              : "background",
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
      parameters,
      input: taskInput
    });
    try {
      const { result, output, runtimeBuild } = await this.withLocalModelUsage(
        model.id,
        async () => {
          const ranker = await this.residentRanker(model);
          // The validation holds only for the runtime build it ran on (T11): checked before any call.
          const runtimeBuild = await this.rankerBuild(ranker);
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
          const ran = await adapter.run(taskRequest, laneSignal(signal, permit));
          return { result: ran, output: readRankResult(ran, wire.count), runtimeBuild };
        }
      );
      this.localDeadlineHistory.settled(model.id, taskInput);
      const inputTokens = output.tokenCounts.reduce((total, count) => total + count, 0);
      return async () => {
        const aiTaskRunId = await repository.recordTaskRun({
          ...audit,
          outputHash: sha256(JSON.stringify(result.output)),
          inputTokens,
          outputTokens: 0,
          costEstimate: 0,
          durationMs: result.durationMs,
          ...lane(),
          status: "succeeded"
        });
        await this.options.monitoring?.finish(await capture, {
          status: "succeeded",
          aiTaskRunId,
          durationMs: Date.now() - started,
          tokenUsage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
          costEstimate: 0,
          parameters,
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
          queueMs,
          runtimeBuild,
          uncalibrated: decideValidationParityFailed(model.metadata.decideValidation)
        };
      };
    } catch (caught) {
      // An abandoned GGUF call keeps the local lane until its runtime is disposed (F3 D31).
      this.holdWedgedLocalLane(permit, caught);
      const error = this.localDeadlineHistory.verdict(model.id, taskInput, caught, {
        aborted: Boolean(signal?.aborted),
        deadlineMs
      });
      const durationMs = Date.now() - started;
      return async () => {
        const aiTaskRunId = await repository.recordTaskRun({
          ...audit,
          durationMs,
          ...lane({ error }),
          status: signal?.aborted ? "canceled" : "failed",
          error: redactSensitiveText(error)
        });
        await this.options.monitoring?.finish(await capture, {
          status: signal?.aborted ? "canceled" : "failed",
          aiTaskRunId,
          durationMs: Date.now() - started,
          error: redactSensitiveText(error),
          parameters
        });
        if (error instanceof Error) Object.assign(error, { aiTaskRunId });
        throw error;
      };
    }
  }

  public async testLocalModel(localModelId: string): Promise<string> {
    const pin = capturePromptPin();
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model) throw new Error("errors.common.notFound");
    // Settings tests are interactive: P0 on the local lane, in the class of what they test.
    const workloadClass = localModelTestClass(model);
    // A ranker is unavailable from the moment its validation is requested until it ends, also while
    // it waits for the lane: callers take the no-decider path instead of queueing behind it (D13).
    const entry = findLocalModelCatalogEntry(model.catalogId);
    const validating = Boolean(entry && isRankerCatalogEntry(entry));
    if (validating)
      this.validatingRankers.set(model.id, (this.validatingRankers.get(model.id) ?? 0) + 1);
    try {
      return await this.scheduler.run(
        { lane: "local", priority: "P0", workloadClass, label: "local_model_test" },
        (permit) =>
          withPromptPin(pin, () => this.executeLocalModelTest(localModelId, permit, workloadClass))
      );
    } finally {
      if (validating) {
        const remaining = (this.validatingRankers.get(model.id) ?? 1) - 1;
        if (remaining > 0) this.validatingRankers.set(model.id, remaining);
        else this.validatingRankers.delete(model.id);
      }
    }
  }

  private async executeLocalModelTest(
    localModelId: string,
    permit: LanePermit,
    workloadClass: AiWorkloadClass
  ): Promise<string> {
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model) throw new Error("errors.common.notFound");
    const catalogEntry = findLocalModelCatalogEntry(model.catalogId);
    // A dedicated ranker is validated, not prompted: artifact checks, then the ranking smoke test.
    if (catalogEntry && isRankerCatalogEntry(catalogEntry))
      return this.executeRankerValidation(model, catalogEntry, permit);
    const deadlineMs = localDeadlineMs(this.laneConfig.localDeadlines, workloadClass);
    const lane = (failure?: { error: unknown }) =>
      laneAudit(permit, deadlineMs, {}, undefined, failure);
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
      const result = await this.withLocalModelUsage(localModelId, async () => {
        if (!embeddingOnly) await this.beforeLocalGeneration(localModelId, adapter);
        return adapter.run({
          taskType,
          input,
          modelId: adapter.describe().modelId,
          requiredCapabilities,
          parameters,
          metadata: { purpose: "local-model-test" }
        });
      });
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
        ...lane(),
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
        ...lane({ error }),
        status: "failed",
        error: redactSensitiveText(error)
      });
      await this.options.monitoring?.finish(capture, {
        status: "failed",
        aiTaskRunId,
        durationMs: Date.now() - started,
        error: redactSensitiveText(error)
      });
      this.holdWedgedLocalLane(permit, error);
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
    entry: LocalModelCatalogEntry,
    permit: LanePermit
  ): Promise<string> {
    const deadlineMs = localDeadlineMs(this.laneConfig.localDeadlines, "decide");
    const lane = (failure?: { error: unknown }) =>
      laneAudit(permit, deadlineMs, {}, undefined, failure);
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
    const audit = (request: { instruction: string }, taskRequest: AiTaskRequest) => ({
      taskType: "reranking",
      provider,
      modelId: model.modelId,
      runtime: model.runtime,
      adapter: localAdapterName(model.runtime),
      repository: model.repository,
      revision: model.revision,
      quantization: model.quantization,
      capabilitiesUsed: ["reranking", "offline"],
      parameters: taskRequest.parameters as JsonObject,
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
      // One audited call of the validation: the smoke test's documents, or a parity pairs call.
      const call = async (
        request: { instruction: string },
        taskRequest: AiTaskRequest,
        count: number
      ): Promise<RankResult> => {
        const callStarted = Date.now();
        try {
          const result = await registered.run(taskRequest);
          const output = readRankResult(result, count);
          lastAiTaskRunId = await repository.recordTaskRun({
            ...audit(request, taskRequest),
            outputHash: sha256(JSON.stringify(result.output)),
            ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
            ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
            costEstimate: 0,
            durationMs: result.durationMs,
            ...lane(),
            status: "succeeded"
          });
          inputTokens += result.inputTokens ?? 0;
          return output;
        } catch (error) {
          lastAiTaskRunId = await repository.recordTaskRun({
            ...audit(request, taskRequest),
            durationMs: Date.now() - callStarted,
            ...lane({ error }),
            status: "failed",
            error: redactSensitiveText(error)
          });
          this.holdWedgedLocalLane(permit, error);
          throw error;
        }
      };
      const rank = (request: RankRequest) =>
        call(request, rankTaskRequest(request), request.documents.length);
      const rankPairs = (request: RankPairsRequest, plan: RankerParityPlan) =>
        call(
          request,
          rankPairsTaskRequest(
            request,
            plan.helperBatchSize === undefined ? {} : { batchSize: plan.helperBatchSize }
          ),
          request.pairs.length
        );
      // The smoke test, then the parity check of a build that passed it (D13): the reference pairs
      // are scored in the fixed calls of the runtime's parity plan.
      const { smoke, parityScores } = await this.withLocalModelUsage(model.id, async () => {
        const report = await runRankerSmoke(rank, { instruction });
        return {
          smoke: report,
          parityScores: report.passed
            ? await scoreRankerParityReference(entry.runtime, rankPairs)
            : null
        };
      });
      const identity: RankerParityModelIdentity = {
        runtime: entry.runtime,
        repository: entry.repository,
        revision: entry.revision,
        quantization: entry.quantization,
        artifactSha256: artifact.artifactSha256
      };
      // The scores stored with a calibration come first; then the baseline this install recorded.
      const parity = parityScores
        ? createRankerParityRecord({
            runtime: entry.runtime,
            scores: parityScores,
            runtimeBuild,
            baseline: this.parityBaseline(model, entry, identity)
          })
        : undefined;
      const validation = createDecideValidation(
        {
          runtime: entry.runtime,
          revision: entry.revision,
          artifactSha256: artifact.artifactSha256,
          runtimeBuild
        },
        smoke,
        new Date(),
        parity
      );
      // A failed parity check leaves the ranker validated but uncalibrated, visibly (D13).
      await models.updateModel(model.id, {
        lastError: parity && !parity.passed ? "errors.localModels.rankerUncalibrated" : null,
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
      return rankerValidationSummary(smoke, parity);
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
      // The validation is stored with the model, which routes resolve (F3 D38).
      this.configCache.invalidate();
      // The ranker is not kept resident by the test; routed use manages its own residency.
      const ranker = this.resident.rank;
      if (ranker?.localModelId === model.id && !this.occupied(ranker))
        await this.releaseSlot("rank").catch(() => undefined);
      await this.stopIdleMlxHelper(false).catch(() => undefined);
    }
  }

  /**
   * The scores a parity check compares with (D13): the ones a calibration stored for this model,
   * else the baseline this install recorded at an earlier validation of the same artifact. Null
   * when neither applies (another reference or batching, or none yet): the run then starts the
   * install's own baseline.
   */
  private parityBaseline(
    model: LocalModelRecord,
    entry: LocalModelCatalogEntry,
    identity: RankerParityModelIdentity
  ): RankerParityBaseline | null {
    let calibrated: RankerParityBaseline | null = null;
    try {
      calibrated = this.options.rankerParityBaseline?.(identity) ?? null;
    } catch (error) {
      this.options.logger?.error("Ranker parity baseline", error);
    }
    const previous =
      decideValidationForCatalogEntry(model.metadata.decideValidation, entry)?.parity?.baseline ??
      null;
    const hash = rankerParityReferenceHash();
    return (
      [calibrated, previous].find((baseline) =>
        rankerParityBaselineApplies(baseline, entry.runtime, hash)
      ) ?? null
    );
  }

  /**
   * The runtime build a ranker would run on now: the MLX helper executable's SHA-256, or the
   * node-llama-cpp and llama.cpp build of a GGUF ranker (which loads the model to read it). The
   * startup re-validation compares it with the build a stored validation names (D13).
   */
  public async rankerRuntimeBuild(localModelId: string): Promise<string> {
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model) throw new Error("errors.common.notFound");
    const ranker = await this.residentRanker(model);
    return this.rankerBuild(ranker);
  }

  /** The resident ranker's build, read once while it stays resident; a failed read is retried. */
  private rankerBuild(ranker: ResidentLocalAdapter): Promise<string> {
    ranker.runtimeBuild ??= (ranker.adapter as RankerAdapter).runtimeBuild().catch((error) => {
      ranker.runtimeBuild = undefined;
      throw error;
    });
    return ranker.runtimeBuild;
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
    await this.makeRoomForRanker(entry.minimumMemoryBytes);
    return (await this.makeResident("rank", model, [...entry.capabilities]))
      .adapter as RankerAdapter;
  }

  /** The routed ranker, resident in the ranker slot with its stored (validated) capabilities. */
  private async residentRanker(model: LocalModelRecord): Promise<ResidentLocalAdapter> {
    await this.makeRoomForRanker(findLocalModelCatalogEntry(model.catalogId)?.minimumMemoryBytes);
    const resident = this.resident.rank;
    if (resident?.localModelId === model.id) return resident;
    return this.makeResident("rank", model, parseCapabilities(model.capabilities));
  }

  /**
   * The residency plan (F3 D39) of the generative model with the resident embedder and a ranker of
   * this minimum; null when the generative model's minimum is unknown (outside the catalog).
   */
  private residencyPlanFor(
    generativeMinimumBytes: number | undefined,
    rankMinimumBytes: number | undefined
  ): ResidencyPlan | null {
    if (generativeMinimumBytes === undefined) return null;
    return residencyPlan({
      totalMemoryBytes: this.options.machine?.totalMemoryBytes ?? totalmem(),
      resident: {
        embed: this.resident.embed?.minimumMemoryBytes ?? 0,
        rank: rankMinimumBytes ?? 0
      },
      generative: generativeMinimumBytes,
      headroomBytes: this.laneConfig.residency.headroomBytes
    });
  }

  /**
   * Before a ranker call: when the machine cannot hold the ranker beside the generative model, the
   * generative one leaves first (it loads again on its next call).
   */
  private async makeRoomForRanker(rankMinimumBytes: number | undefined): Promise<void> {
    const generative = this.resident.generate;
    if (!generative || this.occupied(generative)) return;
    const plan = this.residencyPlanFor(generative.minimumMemoryBytes, rankMinimumBytes);
    if (!plan || plan.keepRankDuringGeneration) return;
    await this.releaseSlot("generate");
    await this.stopIdleMlxHelper(false);
  }

  /**
   * Before a call of the local generative model (F3 D39): the ranker leaves when the machine cannot
   * hold both, and a model that is about to load must fit the residency plan and the memory that is
   * free now (its catalog minimum plus the load margin), else the call is refused visibly
   * (`blocked: memory`) instead of pushing the machine into swap.
   */
  private async beforeLocalGeneration(
    localModelId: string,
    adapter: AiModelAdapter
  ): Promise<void> {
    const generative = this.resident.generate;
    if (generative?.localModelId !== localModelId) return;
    const minimum = generative.minimumMemoryBytes;
    const plan = this.residencyPlanFor(minimum, this.resident.rank?.minimumMemoryBytes);
    const ranker = this.resident.rank;
    if (plan && !plan.keepRankDuringGeneration && ranker && !this.occupied(ranker)) {
      await this.releaseSlot("rank");
      await this.stopIdleMlxHelper(false);
    }
    // Only a load needs room; a replayed call loads nothing.
    if (minimum === undefined || adapter.isLoaded?.() !== false) return;
    const residency = this.laneConfig.residency;
    if (plan && !plan.allowed) {
      throw new LocalMemoryBlockedError(
        "plan",
        minimum + residency.headroomBytes,
        this.options.machine?.totalMemoryBytes ?? totalmem()
      );
    }
    const available = await (this.options.availableMemoryBytes ?? availableMemoryBytes)();
    const guard = memoryGuard({
      availableBytes: available,
      minimumBytes: minimum,
      marginBytes: residency.loadMarginBytes
    });
    if (!guard.allowed) {
      this.options.logger?.info(
        `Local generative model not loaded: ${available} bytes free, ${guard.requiredBytes} needed`
      );
      throw new LocalMemoryBlockedError("free", guard.requiredBytes, available);
    }
  }

  /** (Re)starts the generative model's idle period: it unloads when the period ends unused. */
  private armGenerativeIdleTimer(): void {
    this.clearGenerativeIdleTimer();
    const occupant = this.resident.generate;
    if (!occupant) return;
    const timer = setTimeout(() => {
      if (this.generativeIdleTimer === timer) this.generativeIdleTimer = null;
      void this.unloadIdleGenerative(occupant).catch((error: unknown) =>
        this.options.logger?.error("Idle unload of the local generative model", error)
      );
    }, this.laneConfig.residency.generativeIdleUnloadMs);
    timer.unref?.();
    this.generativeIdleTimer = timer;
  }

  private clearGenerativeIdleTimer(): void {
    if (this.generativeIdleTimer) clearTimeout(this.generativeIdleTimer);
    this.generativeIdleTimer = null;
  }

  /**
   * The idle period ended: the generative model leaves, unless a call or an abandoned (wedged) one
   * still holds it; then another period starts.
   */
  private async unloadIdleGenerative(occupant: ResidentLocalAdapter): Promise<void> {
    if (this.resident.generate !== occupant) return;
    if (this.occupied(occupant)) {
      this.armGenerativeIdleTimer();
      return;
    }
    await this.releaseSlot("generate");
    await this.stopIdleMlxHelper(false);
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
      if (this.occupied(occupant)) throw new Error("errors.localModels.modelBusy");
      await this.releaseSlot(slot);
    }
    const adapter =
      slot === "rank"
        ? this.buildRankerAdapter(model, capabilities)
        : this.buildLocalAdapter(model, capabilities);
    const resident: ResidentLocalAdapter = {
      localModelId: model.id,
      runtime: model.runtime,
      adapter,
      minimumMemoryBytes: findLocalModelCatalogEntry(model.catalogId)?.minimumMemoryBytes
    };
    this.resident[slot] = resident;
    this.registerAdapter(adapter);
    if (slot === "generate") this.armGenerativeIdleTimer();
    return resident;
  }

  private async releaseSlot(
    slot: ResidencySlot,
    options: { unload?: boolean } = {}
  ): Promise<void> {
    const occupant = this.resident[slot];
    if (!occupant) return;
    delete this.resident[slot];
    if (slot === "generate") this.clearGenerativeIdleTimer();
    const descriptor = occupant.adapter.describe();
    this.registry.unregister(descriptor.providerId, descriptor.modelId);
    await occupant.adapter.dispose?.();
    if (occupant.runtime === "mlx") await this.unloadMlxSlot(slot, options.unload ?? true);
  }

  /**
   * Drops a released MLX model from the shared helper, which keeps its PID and its other models
   * (F3 D39). An older helper without `unload` keeps the weights until it stops: the next idle
   * release stops it once no MLX call runs.
   */
  private async unloadMlxSlot(slot: ResidencySlot, unload: boolean): Promise<void> {
    const host = this.mlxHost;
    const outcome =
      host && unload
        ? await host.unload(mlxHelperSlots[slot]).catch((error: unknown) => {
            this.options.logger?.error("MLX helper unload failed", error);
            return "unsupported" as const;
          })
        : "unsupported";
    if (outcome === "unsupported") this.mlxHoldsReleasedModel = true;
  }

  /** Releases one local model unless it is running a call or wedged. */
  private async releaseLocalModel(localModelId: string): Promise<void> {
    if (this.activeLocalModels.has(localModelId)) return;
    const slot = residencySlots.find((candidate) => {
      return this.resident[candidate]?.localModelId === localModelId;
    });
    if (slot && !this.occupied(this.resident[slot]!)) await this.releaseSlot(slot);
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

  /**
   * The one MLX helper of this service (D18). A call it cancels at its deadline may take the local
   * grace period to stop before the helper is killed (F3 D31).
   */
  private mlxHelper(): MlxHelperHost {
    this.mlxHost ??= new MlxHelperHost({
      helperPath: this.resolveMlxHelperPath(),
      config: { cancelGraceMs: this.laneConfig.localDeadlines.graceMs }
    });
    return this.mlxHost;
  }

  private buildRankerAdapter(model: LocalModelRecord, capabilities: AiCapability[]): RankerAdapter {
    const options = {
      ...localAdapterOptions(model, capabilities, this.laneConfig.localDeadlines),
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
      ...localAdapterOptions(model, capabilities, this.laneConfig.localDeadlines),
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

  /**
   * The adapter of a provider configuration. One instance serves every call until the configuration
   * changes (F3 D38), so a call neither reads the provider rows nor decrypts the credential again,
   * and what the server refused stays remembered by the instance. An OAuth adapter is built again
   * once its access token is about to expire.
   */
  private async createAdapter(providerId: string): Promise<AiModelAdapter> {
    const build = () =>
      this.configCache.adapter(providerId, () => this.buildRemoteAdapter(providerId));
    const built = await build();
    if (built.expiresAt === undefined || built.expiresAt > Date.now() + oauthRefreshMarginMs)
      return built.adapter;
    // Refreshing saves the credential, which moves the generation and drops the cached adapter.
    await this.getOpenAiCodexCredential(built.credentialRef!);
    return (await build()).adapter;
  }

  private async buildRemoteAdapter(providerId: string): Promise<BuiltRemoteAdapter> {
    const config = (await this.providerRows()).find((provider) => provider.id === providerId);
    if (!config) throw new Error("errors.common.notFound");
    if (!config.credentialRef) throw new Error("errors.ai.missingCredential");
    const modelId = typeof config.metadata.modelId === "string" ? config.metadata.modelId : "";
    const capabilities: AiCapability[] = Array.isArray(config.metadata.capabilities)
      ? config.metadata.capabilities.flatMap((value) => {
          const parsed = AiCapabilitySchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    const key = `${config.id}:${modelId}`;
    const previous = this.remoteAdapterKeys.get(config.id);
    if (previous && previous !== key) this.registry.unregisterKey(previous);
    this.remoteAdapterKeys.set(config.id, key);
    if (config.provider === "openai-codex") {
      const credential = await this.getOpenAiCodexCredential(config.credentialRef);
      return {
        adapter: this.registerAdapter(
          new OpenAiCodexAdapter({
            accessToken: credential.access,
            accountId: credential.accountId,
            modelId,
            capabilities,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
            ...this.runtimeOption()
          }),
          key
        ),
        expiresAt: credential.expires,
        credentialRef: config.credentialRef
      };
    }
    const apiKey = await this.credentialSecret(config.credentialRef);
    if (config.provider === "google") {
      return {
        adapter: this.registerAdapter(
          new GoogleGeminiAdapter({
            apiKey,
            modelId,
            capabilities,
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
            ...this.runtimeOption()
          }),
          key
        )
      };
    }
    return {
      adapter: this.registerAdapter(
        new OpenAiCompatibleAdapter({
          apiKey,
          modelId,
          capabilities,
          baseUrl: config.baseUrl ?? "http://127.0.0.1:11434/v1",
          // The DEV fakes of the soak answer from loopback but run under the remote deadlines (R6).
          ...(providerTreatedAsRemote(config.metadata, this.treatAsRemoteHonoured)
            ? { treatAsRemote: true }
            : {}),
          ...this.runtimeOption()
        }),
        key
      )
    };
  }

  /** A decrypted credential, kept until the configuration or a credential changes (F3 D38). */
  private credentialSecret(reference: string): Promise<string> {
    return this.configCache.credential(reference, () => this.credentials.get(reference));
  }

  /** Removes the registration of a provider configuration's adapter once it is gone or replaced. */
  private forgetRemoteAdapter(providerConfigId: string): void {
    const key = this.remoteAdapterKeys.get(providerConfigId);
    if (key) this.registry.unregisterKey(key);
    this.remoteAdapterKeys.delete(providerConfigId);
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
    const credential = parseOpenAiCodexCredential(await this.credentialSecret(credentialRef));
    if (credential.expires > Date.now() + oauthRefreshMarginMs) return credential;
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
    if (resident) {
      // A call is on its way: the generative model's idle period starts again.
      if (resident === this.resident.generate) this.armGenerativeIdleTimer();
      return resident.adapter;
    }
    const model = await createLocalModelRepository(this.requirePool()).findById(localModelId);
    if (!model || model.status !== "ready" || !model.managedPath)
      throw new Error("errors.localModels.notReady");
    const capabilities = parseCapabilities(model.capabilities);
    return (await this.makeResident(this.residencySlot(model, capabilities), model, capabilities))
      .adapter;
  }

  /**
   * Registers an adapter and returns the instance the registry holds for it (wrapped by the DEV
   * cassette when one is installed). A remote adapter is keyed by its provider configuration and model
   * (`providerConfigId:modelId`), so two configurations that name one model never resolve each
   * other's adapter (F3 D38); a local model's adapter by its provider and model ids, which its
   * installation makes unique.
   */
  private registerAdapter(adapter: AiModelAdapter, key?: string): AiModelAdapter {
    return this.registry.register(adapter, key);
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
      // The generative model's idle period starts when its last call ends (F3 D39).
      if (this.resident.generate?.localModelId === localModelId) this.armGenerativeIdleTimer();
    }
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

/** What {@link AiService.embedMany} returns: one vector per text, in order, and the audit rows. */
export interface AiEmbedManyExecution {
  embeddings: number[][];
  profileId: string;
  providerId: string;
  modelId: string;
  runtime: AiTaskResult["runtime"];
  embeddingSpaceKey: string;
  /** One audit row per execution (batch of at most {@link embedManyLimits.perExecution} texts). */
  aiTaskRunIds: string[];
  calls: number;
  durationMs: number;
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

/** The vectors of a batch result, checked to be one finite list of numbers per text. */
function readEmbeddingBatch(output: unknown, count: number): number[][] {
  if (
    !Array.isArray(output) ||
    output.length !== count ||
    !output.every(
      (vector) =>
        Array.isArray(vector) &&
        vector.length > 0 &&
        vector.every((value) => typeof value === "number" && Number.isFinite(value))
    )
  )
    throw new Error("AI embedding response did not contain a vector for every text.");
  return output as number[][];
}

/** What the monitoring entry keeps of a batch: its size, not its vectors. */
function embeddingBatchSummary(output: unknown): JsonObject {
  const vectors = Array.isArray(output) ? output : [];
  const first = vectors[0];
  return { items: vectors.length, dimensions: Array.isArray(first) ? first.length : 0 };
}

/** The distinct compositions of a batch, in order of appearance. */
function uniqueCompositions(
  compositions: readonly PromptCompositionSnapshot[]
): PromptCompositionSnapshot[] {
  return [
    ...new Map(
      compositions.map((snapshot) => [`${snapshot.promptId}:${snapshot.compositionHash}`, snapshot])
    ).values()
  ];
}

/**
 * Runs a batch of embeddings as one execution: the adapter's `embedMany` when it has one, else its
 * single calls in order. The result is the task result the single calls would add up to.
 */
async function runEmbeddingBatch(
  adapter: AiModelAdapter,
  request: AiTaskRequest,
  texts: readonly string[],
  context: Pick<AiTaskLogContext, "embeddingInputType" | "operation" | "workloadClass">,
  signal: AbortSignal | undefined
): Promise<AiTaskResult> {
  if (adapter.embedMany)
    return embedManyTaskResult(
      await adapter.embedMany(texts, {
        inputType: context.embeddingInputType ?? "document",
        parameters: request.parameters,
        ...(typeof request.parameters.dimensions === "number"
          ? { dimensions: request.parameters.dimensions }
          : {}),
        ...(request.modelId ? { modelId: request.modelId } : {}),
        ...(context.workloadClass ? { workloadClass: context.workloadClass } : {}),
        ...(context.operation ? { operation: context.operation } : {}),
        ...(signal ? { signal } : {})
      })
    );
  const results: AiTaskResult[] = [];
  for (const text of texts) {
    signal?.throwIfAborted();
    results.push(await adapter.run({ ...request, input: text }, signal));
  }
  const sum = (field: "inputTokens" | "durationMs") =>
    results.every((result) => result[field] !== undefined)
      ? results.reduce((total, result) => total + (result[field] ?? 0), 0)
      : undefined;
  const first = results[0]!;
  const tokens = sum("inputTokens");
  const usage = sumTokenUsage(results.map((result) => result.tokenUsage)) ?? {};
  delete usage[aiCassetteReplayedUsageKey];
  return {
    ...first,
    output: results.map((result) => result.output),
    durationMs: sum("durationMs") ?? 0,
    ...(tokens !== undefined ? { inputTokens: tokens } : {}),
    // A cassette marks a result served without a model; the batch is that only when every text was.
    tokenUsage: {
      ...usage,
      ...(results.every((result) => result.tokenUsage?.[aiCassetteReplayedUsageKey])
        ? { [aiCassetteReplayedUsageKey]: 1 }
        : {})
    }
  };
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

function localAdapterOptions(
  model: LocalModelRecord,
  capabilities: AiCapability[],
  localDeadlines: AiLaneRuntimeConfig["localDeadlines"]
) {
  return {
    modelId: model.modelId,
    modelPath: resolveLocalModelPath(model),
    capabilities,
    catalogId: model.catalogId,
    repository: model.repository,
    revision: model.revision,
    quantization: model.quantization,
    localDeadlines
  };
}

/** A GGUF adapter whose runtime ignored a deadline and still runs the abandoned call (F3 D31). */
function isWedged(adapter: AiModelAdapter): boolean {
  return (adapter as { wedged?: unknown }).wedged === true;
}

/** The adapter, when its model declares what the call needs (as `AiModelRegistry.resolve` checks). */
function withCapabilities(
  adapter: AiModelAdapter,
  required: readonly AiCapability[]
): AiModelAdapter {
  if (!hasCapabilities(adapter.describe(), required))
    throw new Error("errors.ai.noCompatibleModel");
  return adapter;
}

/** The class a settings test of a local model runs in: rankers decide, embedders embed. */
function localModelTestClass(model: LocalModelRecord): AiWorkloadClass {
  const entry = findLocalModelCatalogEntry(model.catalogId);
  if (
    entry ? isRankerCatalogEntry(entry) : isDedicatedRanker(parseCapabilities(model.capabilities))
  )
    return "decide";
  return model.capabilities.includes("embedding") && !model.capabilities.includes("text-generation")
    ? "embed"
    : "answer";
}

/**
 * The adapter's own signal for one execution: it follows the caller's and carries the lane permit,
 * so the remote retry loop sleeps off the lane and reports rate limits to it.
 */
function laneSignal(signal: AbortSignal | undefined, permit: LanePermit): AbortSignal {
  const own = AbortSignal.any(signal ? [signal] : []);
  bindLanePermit(own, permit);
  return own;
}

type LaneAuditFields = {
  lane: string;
  workloadClass: AiWorkloadClass;
  priority: number;
  deadlineMs: number;
  deadlineOutcome: "met" | "aborted";
  isRepair: boolean;
  retryWaitMs: number;
  requeueMs: number;
};

/**
 * The scheduler's audit of one execution (0057): its lane, class, priority and deadline, whether a
 * deadline ended it (a cancelled call met its deadline), the retry sleeps off the lane and the
 * re-waits for it. `failure` is set when the call failed.
 */
function laneAudit(
  permit: Pick<LanePermit, "lane" | "workloadClass" | "priority" | "releasedMs" | "requeueMs">,
  deadlineMs: number,
  context: Pick<AiTaskLogContext, "isRepair" | "operation">,
  signal: AbortSignal | undefined,
  failure?: { error: unknown }
): LaneAuditFields {
  return {
    lane: permit.lane,
    workloadClass: permit.workloadClass,
    priority: priorityNumber(permit.priority),
    deadlineMs,
    deadlineOutcome:
      failure && !signal?.aborted && isDeadlineFailure(failure.error) ? "aborted" : "met",
    isRepair: context.isRepair ?? context.operation?.endsWith("_repair") ?? false,
    retryWaitMs: permit.releasedMs,
    requeueMs: permit.requeueMs
  };
}

/** The schema mode of the last request a failed call started, when its adapter stated one. */
function failedSchemaMode(
  options: Record<string, unknown> | undefined
): { schemaMode: AiSchemaMode } | Record<string, never> {
  const mode = AiSchemaModeSchema.safeParse(options?.schemaMode);
  return mode.success ? { schemaMode: mode.data } : {};
}

/** Rejects as soon as `signal` aborts, so an admission is cancelled promptly while it prepares. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Local inputs whose last call ended on its deadline (F3 D31): a second consecutive deadline on the
 * same model and input is deterministic, so it fails without a job retry. Bounded, oldest first out.
 */
class LocalDeadlineHistory {
  private static readonly capacity = 64;
  private readonly timedOut = new Set<string>();

  /** A call on this model and input settled without a deadline. */
  public settled(localModelId: string | null, input: string): void {
    if (localModelId) this.timedOut.delete(this.key(localModelId, input));
  }

  /** The error a failed local call reports: the repeated-deadline one on its second deadline. */
  public verdict(
    localModelId: string | null,
    input: string,
    error: unknown,
    call: { aborted: boolean; deadlineMs: number }
  ): unknown {
    if (!localModelId) return error;
    const key = this.key(localModelId, input);
    if (call.aborted || !isDeadlineFailure(error)) {
      this.timedOut.delete(key);
      return error;
    }
    if (this.timedOut.delete(key))
      return new LocalDeadlineError(
        `Local model call exceeded its ${call.deadlineMs} ms deadline twice in a row on the same input.`,
        { code: "deadline_repeated", deadlineMs: call.deadlineMs, transient: false }
      );
    this.timedOut.add(key);
    if (this.timedOut.size > LocalDeadlineHistory.capacity)
      this.timedOut.delete(this.timedOut.values().next().value!);
    return error;
  }

  private key(localModelId: string, input: string): string {
    return `${localModelId}\u0000${sha256(input)}`;
  }
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
function rankerValidationSummary(smoke: RankerSmokeReport, parity?: RankerParityRecord): string {
  const log = (value: number) => value.toFixed(3);
  return [
    "Reranker validated for decide",
    `Model card pair: ${smoke.modelCard.logOdds.map(log).join(", ")} (card ${smoke.modelCard.expected.join(", ")}, largest difference ${log(smoke.modelCard.maxDelta)})`,
    ...smoke.relevance.map(
      (entry) =>
        `${entry.language}: relevant ${log(entry.relevant)}, irrelevant ${log(entry.irrelevant)} (margin ${log(entry.margin)})`
    ),
    ...(parity
      ? [
          `Score parity with the ${parity.baseline.source} baseline: largest difference ${log(parity.maxDelta)} log-odds (limit ${log(parity.tolerance)}), ${
            parity.passed ? "within the limit" : "beyond the limit: uncalibrated, it only suggests"
          }`
        ]
      : [])
  ].join("\n");
}

/** Consecutive slices of at most `size` items, in order. */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const slices: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    slices.push(items.slice(start, start + size));
  return slices;
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
  listener?: (event: AiProgressStep) => void,
  onTextDelta?: (event: AiTextDelta) => void
): (event: AiProgressEvent) => void {
  let lastProgress = -1;
  let lastReportedAt = 0;
  return (event) => {
    // Text is not progress: it is never throttled and never reaches a progress listener.
    if (event.kind === "text") {
      onTextDelta?.(event);
      return;
    }
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
