// The OpenAI Decisions API as an opt-in relation decider (F3 plan decision 30), on the AI service's
// scheduler: every request runs on a remote lane of its own with its own circuit breaker, in the
// `decide` class, under its own deadline, and is audited like any other AI execution. This module
// holds what is the decider's alone: whether it may decide now (the Hybrid or Cloud setup, the
// person's opt-in, a stored key the provider has not refused, the day's spend cap, the lane's
// breaker), the OpenAI Platform key in the secure store, and the status Settings shows. When it may
// not decide, or fails, the relation matcher falls back to the local ranker and says why.
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { sha256 } from "@app/conversion";
import {
  ActiveDeadline,
  aiCassetteReplayedUsageKey,
  bindLanePermit,
  classifyDecisionsFailure,
  cleanDecisionsError,
  combineDecisionAnswers,
  decisionsCostUsd,
  decisionsTaskRequest,
  DecisionsUnavailableError,
  estimatePlanInputTokens,
  executionLane,
  isDeadlineFailure,
  OpenAiDecisionsAdapter,
  planDecisionRequests,
  priorityNumber,
  redactDecisionsSecrets,
  redactSensitiveText,
  resolveDecisionsLimits,
  type AiModelAdapter,
  type AiModelRegistry,
  type AiScheduler,
  type DecisionsLimits,
  type DecisionsLimitsInput,
  type DecisionsList,
  type DirectedDecision,
  type LanePermit,
  type PlannedDecisionsRequest
} from "@app/ai";
import { createAiConfigRepository, createSettingsRepository, type PgPool } from "@app/db";
import {
  AiPresetModeSchema,
  DecisionsSettingSchema,
  DecisionsStoredStateSchema,
  decisionsAvailableInPreset,
  relationsConfig as defaultRelationsConfig,
  relationsDecisionsCredentialRef,
  relationsDecisionsSettingKey,
  relationsDecisionsStateSettingKey,
  type AiPresetMode,
  type DecisionsFallbackReason,
  type DecisionsStatus,
  type DecisionsStoredState,
  type PromptCompositionSnapshot,
  type RelationsConfig
} from "@app/domain";

import { aiTaskPriority, type AiPriorityInput } from "./ai-priority.js";
import { presetSettingKey } from "./ai-class-routes.js";
import type { MonitoringService } from "./monitoring-service.js";
import { promptAudit } from "./prompt-runtime.js";
import {
  createDecisionsSpendBudget,
  type DecisionsSpendBudget
} from "./relations/decisions-budget.js";
import { decisionsDesign, relationDecisionsInstruction } from "./relations/decisions-identity.js";

/** Whether the decider decides now; when it does not, why (`off` and `preset` are not fallbacks). */
export type DecisionsResolution =
  { use: "decisions" } | { use: "local"; reason: DecisionsFallbackReason | null };

export interface DecisionsDecideInput {
  /** The calling operation, for the audit. */
  operation: string;
  /** The instruction text from the prompt catalog (`relations.decisions.instruction`). */
  instruction: string;
  /** Directed lists: a query note and its candidates (query to candidate). */
  lists: readonly DecisionsList[];
  priority?: AiPriorityInput | undefined;
  sourceIds?: string[] | undefined;
  jobId?: string | undefined;
  stage?: string | undefined;
  promptCompositions?: PromptCompositionSnapshot[] | undefined;
}

export interface DecisionsDecideResult {
  /** One decision per candidate of every list, in the lists' order. */
  decisions: Array<Array<DirectedDecision & { aiTaskRunId: string | null }>>;
  calls: number;
  inputTokens: number;
  costUsd: number;
  /** Requests a DEV cassette served: they spent nothing. */
  replayed: number;
}

export interface DecisionsRuntimeOptions {
  getPool: () => PgPool | null;
  scheduler: AiScheduler;
  registry: AiModelRegistry;
  credentials: {
    save(secret: string, existingRef?: string | null): Promise<string>;
    remove(reference: string): Promise<boolean>;
  };
  /** The decrypted key of a reference, cached for a generation of the configuration; throws when absent. */
  readSecret: (reference: string) => Promise<string>;
  monitoring?: MonitoringService | undefined;
  logger?: Pick<Console, "error" | "info"> | undefined;
  /** The DEV cassette of the process: a replay needs no key and spends nothing. */
  cassetteMode?: "record" | "replay" | undefined;
  /**
   * DEV only (`MEMORA_RELATIONS_DECISIONS=on`): the decider is on without the person's opt-in, and a
   * profile with no setup chosen counts as Hybrid. Never set in a packaged build.
   */
  devEnabled?: boolean | undefined;
  /** DEV only: a file holding the key, read instead of the secure store (`MEMORA_RELATIONS_DECISIONS_KEY_FILE`). */
  devKeyFile?: string | undefined;
  /** DEV only: the day's spend cap in US$ for a proof run (`MEMORA_RELATIONS_DECISIONS_CAP_USD`). */
  devCapUsd?: number | undefined;
  limits?: DecisionsLimitsInput | undefined;
  config?: RelationsConfig | undefined;
  fetch?: typeof fetch | undefined;
  random?: (() => number) | undefined;
  now?: (() => Date) | undefined;
}

const passwordCharacters = /^[\x21-\x7e]{16,400}$/u;
const outputSchema = z.object({ probabilities: z.array(z.number().nullable()) });

/** A fixed synthetic pair for the key test: two notes of no one's library. */
const testList: DecisionsList = {
  query:
    "Title: Spaced practice\nIdea: Reviewing material at increasing intervals improves long-term recall.\nText: Spaced practice spreads study over time.",
  candidates: [
    "Title: Distributed practice\nIdea: Spreading study sessions over time improves retention compared with cramming.\nText: Distributed practice."
  ]
};

export class DecisionsRuntime {
  private readonly limits: DecisionsLimits;
  private readonly config: RelationsConfig;
  private readonly adapter: AiModelAdapter;
  private readonly lane: ReturnType<typeof executionLane>;
  private readonly spend: DecisionsSpendBudget;
  private readonly now: () => Date;
  private lastFallbackWrite: { reason: string; at: number } | null = null;

  public constructor(private readonly options: DecisionsRuntimeOptions) {
    this.limits = resolveDecisionsLimits(options.limits);
    this.config = options.config ?? defaultRelationsConfig;
    this.now = options.now ?? (() => new Date());
    this.lane = executionLane({
      localModelId: null,
      providerConfigId: null,
      provider: this.limits.providerId,
      baseUrl: this.limits.url
    });
    this.spend = createDecisionsSpendBudget({
      db: () => this.requirePool(),
      pricePerMillionInputTokensUsd: this.limits.pricePerMillionInputTokensUsd,
      now: this.now
    });
    // Registered like every adapter, so the DEV cassette (a registry decorator) wraps it.
    this.adapter = options.registry.register(
      new OpenAiDecisionsAdapter({
        apiKey: () => this.apiKey(),
        limits: this.limits,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.random ? { random: options.random } : {})
      }),
      `${this.limits.providerId}:${this.limits.model}`
    );
  }

  // --- the key ------------------------------------------------------------------------------------

  /** The key for one request; a replay reads none (the cassette never reaches the provider). */
  private async apiKey(): Promise<string> {
    try {
      return await this.readKey();
    } catch (error) {
      if (this.options.cassetteMode === "replay") return "cassette-replay";
      throw error;
    }
  }

  /** The key: the secure store's, or in a DEV run the file `MEMORA_RELATIONS_DECISIONS_KEY_FILE` names. */
  private async readKey(): Promise<string> {
    const file = this.options.devKeyFile;
    if (!file) return this.options.readSecret(relationsDecisionsCredentialRef);
    const key = (await readFile(file, "utf8")).trim();
    if (!key) throw new Error("errors.ai.missingCredential");
    return key;
  }

  private async keyStored(): Promise<boolean> {
    try {
      await this.readKey();
      return true;
    } catch {
      return false;
    }
  }

  /** Stores the OpenAI Platform key in the secure store. The key is never returned or logged. */
  public async saveKey(apiKey: string): Promise<DecisionsStatus> {
    const key = apiKey.trim();
    if (!passwordCharacters.test(key)) throw new Error("errors.relations.decisions.keyFormat");
    await this.options.credentials.save(key, relationsDecisionsCredentialRef);
    await this.writeState({ keyInvalid: false });
    return this.status();
  }

  public async removeKey(): Promise<DecisionsStatus> {
    await this.options.credentials.remove(relationsDecisionsCredentialRef);
    await this.writeState({ keyInvalid: false, lastUsedAt: null, fallback: null });
    return this.status();
  }

  // --- the setting and the status -------------------------------------------------------------------

  public async setEnabled(enabled: boolean): Promise<DecisionsStatus> {
    if (enabled && !decisionsAvailableInPreset(await this.preset()))
      throw new Error("errors.relations.decisions.presetNotAllowed");
    await createSettingsRepository(this.requirePool()).set(relationsDecisionsSettingKey, {
      enabled
    });
    return this.status();
  }

  private async enabled(): Promise<boolean> {
    if (this.options.devEnabled) return true;
    const stored = DecisionsSettingSchema.safeParse(
      await createSettingsRepository(this.requirePool()).get(relationsDecisionsSettingKey)
    );
    return stored.success && stored.data.enabled;
  }

  /** The setup (`ai.preset.v1`); a DEV run with no setup chosen counts as Hybrid. */
  private async preset(): Promise<AiPresetMode | null> {
    const stored = z
      .object({ mode: AiPresetModeSchema })
      .passthrough()
      .safeParse(await createSettingsRepository(this.requirePool()).get(presetSettingKey));
    const mode = stored.success ? stored.data.mode : null;
    return mode === null && this.options.devEnabled ? "hybrid" : mode;
  }

  private async readState(): Promise<DecisionsStoredState> {
    const parsed = DecisionsStoredStateSchema.safeParse(
      (await createSettingsRepository(this.requirePool()).get(relationsDecisionsStateSettingKey)) ??
        {}
    );
    return parsed.success ? parsed.data : DecisionsStoredStateSchema.parse({});
  }

  private async writeState(patch: Partial<DecisionsStoredState>): Promise<void> {
    const next = { ...(await this.readState()), ...patch };
    await createSettingsRepository(this.requirePool()).set(relationsDecisionsStateSettingKey, next);
  }

  /** The day's spend cap in US$: the typed config's, or in a DEV run the one the run names. */
  private capUsd(): number {
    return this.options.devCapUsd ?? this.config.decisions.dailyCapUsd;
  }

  private breakerOpen(): boolean {
    return (
      this.options.scheduler.snapshot().find((entry) => entry.lane === this.lane.lane)?.breaker
        ?.state === "open"
    );
  }

  private calibrated(): boolean {
    return (
      decisionsDesign({
        instruction: relationDecisionsInstruction(),
        config: this.config,
        limits: this.limits
      }).calibration !== null
    );
  }

  /** Whether the decider may decide now, and if not why. */
  private async availability(): Promise<
    { ok: true } | { ok: false; reason: "off" | "preset" | DecisionsFallbackReason }
  > {
    if (!(await this.enabled())) return { ok: false, reason: "off" };
    if (!decisionsAvailableInPreset(await this.preset())) return { ok: false, reason: "preset" };
    const state = await this.readState();
    if (this.options.cassetteMode !== "replay") {
      if (!(await this.keyStored())) return { ok: false, reason: "no_key" };
      if (state.keyInvalid) return { ok: false, reason: "invalid_key" };
    }
    const spent = await this.spend.status();
    if (spent.usd >= this.capUsd()) return { ok: false, reason: "spend_cap" };
    if (this.breakerOpen()) return { ok: false, reason: "breaker_open" };
    return { ok: true };
  }

  /** What Settings shows. Never the key. */
  public async status(): Promise<DecisionsStatus> {
    const [enabled, preset, state, spent, stored] = await Promise.all([
      this.enabled(),
      this.preset(),
      this.readState(),
      this.spend.status(),
      this.keyStored()
    ]);
    const presetAllowed = decisionsAvailableInPreset(preset);
    const availability = await this.availability();
    const reason =
      !availability.ok && availability.reason !== "off" && availability.reason !== "preset"
        ? availability.reason
        : null;
    return {
      state: !presetAllowed
        ? "unavailable_preset"
        : !enabled
          ? "off"
          : reason
            ? "fallback"
            : "ready",
      enabled,
      presetAllowed,
      keyStored: stored,
      keyInvalid: state.keyInvalid,
      fallbackReason: presetAllowed && enabled ? (reason ?? state.fallback?.reason ?? null) : null,
      model: this.limits.model,
      priceInputPerMillionUsd: this.limits.pricePerMillionInputTokensUsd,
      spentTodayUsd: spent.usd,
      dailyCapUsd: this.capUsd(),
      requestsToday: spent.requests,
      calibrated: this.calibrated(),
      lastUsedAt: state.lastUsedAt
    };
  }

  // --- the matcher's questions --------------------------------------------------------------------

  /**
   * Whether the next admission decides with this decider. A reason is recorded for the status when
   * the person turned the decider on and the local ranker decides anyway.
   */
  public async resolve(): Promise<DecisionsResolution> {
    const availability = await this.availability();
    if (availability.ok) return { use: "decisions" };
    if (availability.reason === "off" || availability.reason === "preset")
      return { use: "local", reason: null };
    await this.noteFallback(availability.reason);
    return { use: "local", reason: availability.reason };
  }

  private async noteFallback(reason: DecisionsFallbackReason): Promise<void> {
    const at = this.now().getTime();
    const previous = this.lastFallbackWrite;
    // The same reason is written at most once every ten seconds: admissions ask often.
    if (previous?.reason === reason && at - previous.at < 10_000) return;
    this.lastFallbackWrite = { reason, at };
    try {
      await this.writeState({ fallback: { reason, at: this.now().toISOString() } });
    } catch (error) {
      this.options.logger?.error("Failed to record the Decisions fallback", error);
    }
  }

  // --- deciding -----------------------------------------------------------------------------------

  /**
   * Scores directed lists: every list is cut into requests of at most 20 candidates, each sent in the
   * two candidate orders of the validated design on the Decisions lane, and a candidate's score is the
   * log-odds of the mean of the two orders' probabilities. Throws {@link DecisionsUnavailableError}
   * when the decider cannot decide (it is off, the key is refused, the day's cap is reached, the
   * lane's breaker is open, the network failed); a cancellation is rethrown as it is.
   */
  public async decide(
    input: DecisionsDecideInput,
    signal?: AbortSignal
  ): Promise<DecisionsDecideResult> {
    const availability = await this.availability();
    if (!availability.ok) {
      if (availability.reason === "off" || availability.reason === "preset")
        throw new Error("errors.relations.decisions.presetNotAllowed");
      throw new DecisionsUnavailableError(availability.reason);
    }
    return this.run(input, signal);
  }

  private async run(
    input: DecisionsDecideInput,
    signal: AbortSignal | undefined
  ): Promise<DecisionsDecideResult> {
    const plan = planDecisionRequests(input.lists, input.instruction, this.limits);
    if (plan.length === 0)
      return {
        decisions: input.lists.map((list) =>
          list.candidates.map(() => ({ probability: null, logOdds: null, aiTaskRunId: null }))
        ),
        calls: 0,
        inputTokens: 0,
        costUsd: 0,
        replayed: 0
      };
    // The plan's expected cost against what is left of the day, before anything is sent.
    const spent = await this.spend.status();
    const estimated = decisionsCostUsd(estimatePlanInputTokens(plan, this.limits), this.limits);
    if (spent.usd + estimated > this.capUsd())
      throw await this.fail(new DecisionsUnavailableError("spend_cap"), signal);
    const deadline = ActiveDeadline.of(signal);
    const controller = new AbortController();
    const stop = deadline
      ? deadline.join(controller.signal)
      : signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal;
    const executed = new Map<number, ExecutedRequest>();
    try {
      await Promise.all(
        plan.map(async (request) => {
          executed.set(request.id, await this.runRequest(request, input, stop));
        })
      );
    } catch (error) {
      controller.abort(error);
      throw await this.fail(error, signal);
    }
    const combined = combineDecisionAnswers(
      input.lists,
      plan,
      new Map([...executed].map(([id, done]) => [id, done.probabilities])),
      this.limits
    );
    const runIds = input.lists.map((list) => list.candidates.map(() => null as string | null));
    for (const request of plan)
      for (const candidateIndex of request.candidateIndices) {
        const slot = runIds[request.listIndex]!;
        slot[candidateIndex] ??= executed.get(request.id)!.aiTaskRunId;
      }
    const totals = [...executed.values()];
    await this.writeState({ lastUsedAt: this.now().toISOString(), fallback: null }).catch(
      () => undefined
    );
    return {
      decisions: combined.map((list, listIndex) =>
        list.map((decision, candidateIndex) => ({
          ...decision,
          aiTaskRunId: runIds[listIndex]![candidateIndex] ?? null
        }))
      ),
      calls: plan.length,
      inputTokens: totals.reduce((sum, done) => sum + done.inputTokens, 0),
      costUsd: totals.reduce((sum, done) => sum + done.costUsd, 0),
      replayed: totals.filter((done) => done.replayed).length
    };
  }

  /** The error to throw for a failure: a cancellation as it is, anything else as a reason. */
  private async fail(error: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    if (signal?.aborted) return error;
    if (error instanceof DecisionsUnavailableError) {
      await this.noteFallback(error.reason);
      return error;
    }
    const reason = classifyDecisionsFailure(error);
    this.options.logger?.info(
      `Decisions decider failed (${reason}): ${redactSensitiveText(redactDecisionsSecrets(String(error instanceof Error ? error.message : error)))}`
    );
    // The provider refused the key: no request is sent until a key is saved or tested again.
    if (reason === "invalid_key")
      await this.writeState({ keyInvalid: true }).catch(() => undefined);
    await this.noteFallback(reason);
    return new DecisionsUnavailableError(reason, { cause: cleanDecisionsError(error) });
  }

  private async runRequest(
    request: PlannedDecisionsRequest,
    input: DecisionsDecideInput,
    signal: AbortSignal
  ): Promise<ExecutedRequest> {
    // The wait for the lane does not count against the caller's own timeout.
    const deadline = ActiveDeadline.of(signal);
    const complete = await this.options.scheduler.run(
      {
        lane: this.lane.lane,
        ...(this.lane.remoteKind ? { remoteKind: this.lane.remoteKind } : {}),
        priority: aiTaskPriority({ priority: input.priority }),
        workloadClass: "decide",
        signal,
        label: input.operation,
        pauses: deadline ? [deadline] : []
      },
      (permit) => this.execute(request, input, permit, signal)
    );
    // The audit and the monitoring entry are written once the lane is free.
    return complete();
  }

  private async execute(
    planned: PlannedDecisionsRequest,
    input: DecisionsDecideInput,
    permit: LanePermit,
    signal: AbortSignal
  ): Promise<() => Promise<ExecutedRequest>> {
    signal.throwIfAborted();
    const repository = createAiConfigRepository(this.requirePool());
    const taskRequest = decisionsTaskRequest(planned.input, this.limits);
    const taskInput = String(taskRequest.input);
    const sourceItemIds = [...new Set(input.sourceIds ?? [])];
    const started = Date.now();
    const audit = {
      taskType: "reranking",
      provider: this.limits.providerId,
      modelId: this.limits.model,
      runtime: "remote",
      adapter: "openai-decisions",
      capabilitiesUsed: ["reranking", "requires-network"],
      parameters: {},
      promptCompositions: input.promptCompositions ?? promptAudit(input.instruction),
      inputHash: sha256(taskInput),
      queueMs: permit.queueMs,
      sourceItemIds
    };
    const lane = (failure?: { error: unknown }) => ({
      lane: permit.lane,
      workloadClass: permit.workloadClass,
      priority: priorityNumber(permit.priority),
      deadlineMs: this.limits.totalDeadlineMs,
      deadlineOutcome:
        failure && !signal.aborted && isDeadlineFailure(failure.error)
          ? ("aborted" as const)
          : ("met" as const),
      isRepair: false,
      retryWaitMs: permit.releasedMs,
      requeueMs: permit.requeueMs
    });
    const capture = this.startMonitoring({
      kind: "ai",
      operation: input.operation,
      taskType: "reranking",
      stage: input.stage ?? input.operation,
      context: {
        origin: input.jobId ? "job" : "background",
        ...(input.jobId ? { jobId: input.jobId } : {}),
        workloadClass: "decide",
        routeKey: "decisions",
        sourceItemIds
      },
      sourceItemIds,
      provider: this.limits.providerId,
      modelId: this.limits.model,
      runtime: "remote",
      parameters: {},
      input: taskInput
    });
    // The adapter's own signal follows the caller's and carries the lane permit, so the retry loop
    // sleeps off the lane and reports rate limits and outcomes to its breaker.
    const own = AbortSignal.any([signal]);
    bindLanePermit(own, permit);
    try {
      const result = await this.adapter.run(taskRequest, own);
      const { probabilities } = outputSchema.parse(result.output);
      const replayed = Boolean(result.tokenUsage?.[aiCassetteReplayedUsageKey]);
      const inputTokens = result.inputTokens ?? 0;
      const costUsd = replayed
        ? 0
        : (result.costEstimate ?? decisionsCostUsd(inputTokens, this.limits));
      return async () => {
        const aiTaskRunId = await repository.recordTaskRun({
          ...audit,
          outputHash: sha256(JSON.stringify(result.output)),
          inputTokens,
          outputTokens: result.outputTokens ?? 0,
          costEstimate: costUsd,
          durationMs: result.durationMs,
          ...lane(),
          status: "succeeded"
        });
        // A request a cassette served spent nothing.
        if (!replayed)
          await this.spend.add(inputTokens).catch((error: unknown) => {
            this.options.logger?.error("Failed to count the Decisions spend", error);
          });
        await this.options.monitoring?.finish(await capture, {
          status: "succeeded",
          aiTaskRunId,
          durationMs: Date.now() - started,
          tokenUsage: {
            inputTokens,
            outputTokens: result.outputTokens ?? 0,
            totalTokens: inputTokens + (result.outputTokens ?? 0)
          },
          costEstimate: costUsd,
          parameters: {}
        });
        return { probabilities, aiTaskRunId, inputTokens, costUsd, replayed };
      };
    } catch (caught) {
      const error = cleanDecisionsError(caught);
      const durationMs = Date.now() - started;
      return async () => {
        const aiTaskRunId = await repository.recordTaskRun({
          ...audit,
          durationMs,
          ...lane({ error }),
          status: signal.aborted ? "canceled" : "failed",
          error: redactSensitiveText(
            redactDecisionsSecrets(String(error instanceof Error ? error.message : error))
          )
        });
        await this.options.monitoring?.finish(await capture, {
          status: signal.aborted ? "canceled" : "failed",
          aiTaskRunId,
          durationMs,
          error: redactSensitiveText(
            redactDecisionsSecrets(String(error instanceof Error ? error.message : error))
          ),
          parameters: {}
        });
        throw error;
      };
    }
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
        this.options.logger?.error("Failed to start a Decisions monitoring entry", error);
        return undefined;
      });
  }

  // --- the key test -------------------------------------------------------------------------------

  /**
   * One tiny request with a fixed synthetic pair (about 600 tokens, a fraction of a cent): the key
   * works, or the provider refuses it. A refusal marks the key invalid until one is saved again.
   */
  public async testKey(signal?: AbortSignal): Promise<DecisionsStatus> {
    if (this.options.cassetteMode !== "replay" && !(await this.keyStored()))
      throw new DecisionsUnavailableError("no_key");
    // A failure is classified and recorded by the run; a refused key marks itself invalid there.
    await this.run(
      {
        operation: "decisions_key_test",
        instruction: relationDecisionsInstruction(),
        lists: [testList],
        priority: "P0",
        stage: "decisions_key_test"
      },
      signal
    );
    await this.writeState({ keyInvalid: false });
    return this.status();
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

interface ExecutedRequest {
  probabilities: Array<number | null>;
  aiTaskRunId: string;
  inputTokens: number;
  costUsd: number;
  replayed: boolean;
}
