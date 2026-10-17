import type { Llama, LlamaModel, LlamaRankingContext, Token } from "node-llama-cpp";
import { z } from "zod";

import {
  aiTaskRequestSchema,
  type AiModelAdapter,
  type AiModelDescriptor,
  type AiTaskRequest,
  type AiTaskResult
} from "./contracts.js";
import {
  LocalRuntimeGuard,
  localRequestDeadlineMs,
  type LocalAdapterOptions
} from "./local-adapters.js";
import { sha256File } from "./local-model-downloader.js";
import type { MlxHelperScoreResult, MlxScoreInput } from "./local-runtime-protocol.js";
import { MlxHelperError, MlxHelperHost, type MlxHelperCallOptions } from "./mlx-helper-host.js";
import { isDedicatedRanker } from "./parameter-capabilities.js";
import {
  LocalRankerError,
  parseRankRequest,
  probabilityLogOdds,
  qwen3RerankerPrompt,
  rankRequestLimits,
  rankTaskRequest,
  readRankResult,
  type RankRequest,
  type RankResult
} from "./ranker-input.js";
import { checkGgufRankerFacts, ggufRankerFacts } from "./ranker-validation.js";
import { defaultAiLaneRuntimeConfig, type MlxRuntimeConfigInput } from "./runtime-config.js";

/**
 * Dedicated local rankers (D17): Qwen3-Reranker on the MLX helper's `score` command, or as a GGUF
 * through node-llama-cpp's ranking context. They run only the `reranking` task with a structured
 * `RankRequest`, never a prompt, and only for a model that declares `reranking` without generation
 * or embedding; the generative adapters refuse such a model. Neither is a fallback of the other:
 * routing picks the runtime (`rules/ai.md`).
 */

export const rankerRuntimeConfigSchema = z
  .object({
    /**
     * Tokens of one evaluated sequence (template, instruction, query and document), and the GGUF
     * ranking context size. A longer sequence is truncated from the document's end and reported in
     * `truncated`.
     */
    maxSequenceTokens: z.number().int().min(1_024).max(32_768),
    /** Sequences per MLX forward pass (Spike A: 16 is fastest; 32 is no faster). */
    mlxBatchSize: z.number().int().min(1).max(64),
    /** GGUF ranking contexts kept, one per instruction; each holds its own KV cache. */
    ggufCachedContexts: z.number().int().min(1).max(4)
  })
  .strict();
export type RankerRuntimeConfig = z.infer<typeof rankerRuntimeConfigSchema>;

export const defaultRankerRuntimeConfig: RankerRuntimeConfig = {
  maxSequenceTokens: 2_048,
  mlxBatchSize: 16,
  ggufCachedContexts: 2
};

export function resolveRankerRuntimeConfig(
  input: Partial<RankerRuntimeConfig> = {}
): RankerRuntimeConfig {
  const explicit = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
  return rankerRuntimeConfigSchema.parse({ ...defaultRankerRuntimeConfig, ...explicit });
}

interface RankerAdapterOptions extends LocalAdapterOptions {
  rankerConfig?: Partial<RankerRuntimeConfig>;
}

// --- MLX ----------------------------------------------------------------------------------------

export interface MlxRankerAdapterOptions extends RankerAdapterOptions {
  helperPath: string;
  /**
   * Deadline of one rank call from the start of its execution; defaults to the `decide` class's
   * local deadline (F3 D31).
   */
  timeoutMs?: number;
  runtimeConfig?: MlxRuntimeConfigInput;
  /** The helper shared with the generative and embedding adapters (one helper process, D18). */
  host?: MlxHelperHost;
}

type MlxScore = (
  input: MlxScoreInput,
  options: MlxHelperCallOptions
) => Promise<MlxHelperScoreResult>;

export class MlxRerankerAdapter implements AiModelAdapter {
  private readonly config: RankerRuntimeConfig;
  private readonly host: MlxHelperHost | null;
  private readonly ownsHost: boolean;
  private readonly score: MlxScore;

  public constructor(
    private readonly options: MlxRankerAdapterOptions,
    score?: MlxScore
  ) {
    this.config = resolveRankerRuntimeConfig(options.rankerConfig);
    this.ownsHost = !score && !options.host;
    this.host = score
      ? null
      : (options.host ??
        new MlxHelperHost({
          helperPath: options.helperPath,
          ...(options.runtimeConfig ? { config: options.runtimeConfig } : {})
        }));
    this.score = score ?? ((input, callOptions) => this.host!.score(input, callOptions));
  }

  public describe(): AiModelDescriptor {
    return rankerDescriptor("local-mlx", this.options, "mlx-swift-lm", this.config);
  }

  public canHandle(request: AiTaskRequest): boolean {
    return rankerCanHandle(request, this.options.capabilities);
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    if (!this.canHandle(input)) throw unsupported();
    const rank = parseRankRequest(input.input);
    const timeoutMs =
      this.options.timeoutMs ?? localRequestDeadlineMs(input, this.options.localDeadlines);
    let result: MlxHelperScoreResult;
    try {
      result = await this.score(
        {
          modelPath: this.options.modelPath,
          instruction: rank.instruction,
          query: rank.query,
          documents: rank.documents,
          maxTokens: this.config.maxSequenceTokens,
          batchSize: this.config.mlxBatchSize
        },
        { timeoutMs, ...(signal ? { signal } : {}) }
      );
    } catch (error) {
      throw mlxRankerFailure(error);
    }
    const output = readRankResult(
      {
        output: {
          logOdds: result.logOdds,
          scores: result.scores,
          tokenCounts: result.tokenCounts,
          truncated: result.truncated
        }
      },
      rank.documents.length
    );
    return rankTaskResult(input, "local-mlx", this.options.modelId, output, result.durationMs);
  }

  /** The runtime build a validation is bound to: the helper executable's SHA-256. */
  public async runtimeBuild(): Promise<string> {
    return `memora-mlx-helper@sha256:${await sha256File(this.options.helperPath)}`;
  }

  public async dispose(): Promise<void> {
    if (this.ownsHost) await this.host?.dispose();
  }
}

/** Failures the host itself observes: the helper did not answer the request. */
const hostErrorCodes = new Set(["timeout", "helper_exited", "spawn_failed", "disposed"]);

/**
 * Maps helper failures that retrying cannot fix to non-transient keys. The helper answers every
 * failed request with the generic runtime key, which job classification treats as transient, and
 * names the Swift error type as the code: `HelperError` (an unsupported architecture, a tokenizer
 * that is not Qwen3-Reranker's, an invalid request, a non-finite score) or a loader error such as
 * `UpdateError` (weights that do not fit the architecture). For a ranker each depends only on the
 * model and the request, so it would retry forever. The replacement error has no cause, so it does
 * not inherit the transient key. Timeouts, crashes and spawn failures, where the helper never
 * answered, keep their own (transient) classification.
 */
function mlxRankerFailure(error: unknown): unknown {
  if (!(error instanceof MlxHelperError)) return error;
  if (error.code === "protocol") {
    return new LocalRankerError(
      "errors.localModels.invalidRuntimeResponse",
      "The helper answered outside protocol 1."
    );
  }
  if (hostErrorCodes.has(error.code)) return error;
  const reason = helperDiagnostic(error.stderr);
  const diagnostic = `${error.code}: ${reason}`;
  return /^invalid request\b/u.test(reason)
    ? new LocalRankerError("errors.ai.unsupportedTask", diagnostic)
    : new LocalRankerError("errors.localModels.rankerInvalid", diagnostic);
}

/** The helper's last "request … failed: <reason>" diagnostic line, for logs. */
function helperDiagnostic(stderr: string): string {
  const reasons = [...stderr.matchAll(/request [0-9a-f-]+ failed: ([^\n]+)/giu)];
  return (reasons.at(-1)?.[1] ?? "The helper refused the request.").slice(0, 500);
}

// --- GGUF ---------------------------------------------------------------------------------------

/** What the GGUF ranker adapter needs from its runtime; tests inject a fake. */
export interface GgufRankingRuntime {
  isLoaded(): boolean;
  /** Loads the model and refuses it unless its header is a Qwen3 ranker. */
  load(signal?: AbortSignal): Promise<void>;
  /** Relevance probabilities of each document for the query, under the instruction's template. */
  rank(input: {
    instruction: string;
    query: string;
    documents: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ probabilities: number[]; tokenCounts: number[]; truncated: boolean[] }>;
  runtimeBuild(): Promise<string>;
  dispose(): Promise<void>;
}

export type NodeLlamaRankerAdapterOptions = RankerAdapterOptions;

export class NodeLlamaRankerAdapter implements AiModelAdapter {
  private readonly config: RankerRuntimeConfig;
  private readonly runtime: GgufRankingRuntime;
  private readonly guard: LocalRuntimeGuard;
  private tail: Promise<unknown> = Promise.resolve();

  public constructor(
    private readonly options: NodeLlamaRankerAdapterOptions,
    runtime?: GgufRankingRuntime
  ) {
    this.config = resolveRankerRuntimeConfig(options.rankerConfig);
    this.runtime = runtime ?? new NodeLlamaRankingRuntime(options.modelPath, this.config);
    // An abandoned rank call disposes the runtime once it ended; the next call loads it again.
    this.guard = new LocalRuntimeGuard(
      options.localDeadlines ?? defaultAiLaneRuntimeConfig.localDeadlines,
      () => this.runtime.dispose()
    );
  }

  /** The runtime ignored a deadline and is wedged until the abandoned call ended (F3 D31). */
  public get wedged(): boolean {
    return this.guard.isWedged;
  }

  public describe(): AiModelDescriptor {
    return rankerDescriptor("local-gguf", this.options, "node-llama-cpp", this.config);
  }

  public canHandle(request: AiTaskRequest): boolean {
    return rankerCanHandle(request, this.options.capabilities);
  }

  public isLoaded(): boolean {
    return this.runtime.isLoaded();
  }

  public async ensureLoaded(signal?: AbortSignal): Promise<void> {
    await this.runtime.load(signal);
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    if (!this.canHandle(input)) throw unsupported();
    const rank = parseRankRequest(input.input);
    // One rank call at a time: the ranking contexts are shared and evicted between instructions.
    // The deadline counts from the call's own start, not from its turn behind an earlier one.
    const bounded = () =>
      this.guard.run(input, signal, (deadlineSignal) => this.rankOnce(input, rank, deadlineSignal));
    const run = this.tail.then(bounded, bounded);
    this.tail = run.catch(() => undefined);
    return run;
  }

  public runtimeBuild(): Promise<string> {
    return this.runtime.runtimeBuild();
  }

  public async dispose(): Promise<void> {
    await this.tail;
    await this.runtime.dispose();
  }

  private async rankOnce(
    input: AiTaskRequest,
    rank: RankRequest,
    signal: AbortSignal | undefined
  ): Promise<AiTaskResult> {
    const started = Date.now();
    const ranked = await this.runtime.rank({
      instruction: rank.instruction,
      query: rank.query,
      documents: rank.documents,
      ...(signal ? { signal } : {})
    });
    if (!ranked.probabilities.every((probability) => Number.isFinite(probability))) {
      throw new LocalRankerError(
        "errors.localModels.rankerInvalid",
        "The model produced a non-finite score."
      );
    }
    const output = readRankResult(
      {
        output: {
          logOdds: ranked.probabilities.map(probabilityLogOdds),
          scores: ranked.probabilities,
          tokenCounts: ranked.tokenCounts,
          truncated: ranked.truncated
        }
      },
      rank.documents.length
    );
    return rankTaskResult(input, "local-gguf", this.options.modelId, output, Date.now() - started);
  }
}

/**
 * Fits a query and a document into a sequence bound after the template's own tokens, cutting the
 * document's end first and the query's only when it alone overflows (the MLX helper keeps the
 * same prefix of its content).
 */
export function fitRankingSequence<T>(input: {
  templateTokens: number;
  query: readonly T[];
  document: readonly T[];
  maxSequenceTokens: number;
}): { query: T[]; document: T[]; tokenCount: number; truncated: boolean } {
  const budget = input.maxSequenceTokens - input.templateTokens;
  if (budget < 1) {
    throw new LocalRankerError(
      "errors.ai.unsupportedTask",
      "The instruction leaves no room for the query and the document."
    );
  }
  const truncated = input.query.length + input.document.length > budget;
  const query = input.query.slice(0, budget);
  const document = input.document.slice(0, budget - query.length);
  return {
    query,
    document,
    tokenCount: input.templateTokens + query.length + document.length,
    truncated
  };
}

/** The Qwen3-Reranker model card prompt as a node-llama-cpp ranking template. */
export function qwen3RankingTemplate(
  instruction: string
): `${string}{{query}}${string}{{document}}${string}` {
  const template =
    qwen3RerankerPrompt.prefix +
    qwen3RerankerPrompt.content(instruction, "{{query}}", "{{document}}") +
    qwen3RerankerPrompt.suffix;
  if (!isQueryFirstTemplate(template)) throw unsupported();
  return template;
}

function isQueryFirstTemplate(
  template: string
): template is `${string}{{query}}${string}{{document}}${string}` {
  const query = template.indexOf("{{query}}");
  return (
    query >= 0 &&
    template.indexOf("{{query}}", query + 1) < 0 &&
    template.indexOf("{{document}}") > query &&
    template.indexOf("{{document}}", template.indexOf("{{document}}") + 1) < 0
  );
}

class NodeLlamaRankingRuntime implements GgufRankingRuntime {
  private module: typeof import("node-llama-cpp") | null = null;
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private loading: Promise<void> | null = null;
  /** Ranking contexts by instruction, least recently used first. */
  private readonly contexts = new Map<string, LlamaRankingContext>();

  public constructor(
    private readonly modelPath: string,
    private readonly config: RankerRuntimeConfig
  ) {}

  public isLoaded(): boolean {
    return this.model !== null;
  }

  public async load(signal?: AbortSignal): Promise<void> {
    if (this.model) return;
    if (!this.loading) {
      this.loading = (async () => {
        const module = await import("node-llama-cpp");
        const llama = await module.getLlama();
        let model: LlamaModel;
        try {
          model = await llama.loadModel({
            modelPath: this.modelPath,
            ...(signal ? { loadSignal: signal } : {})
          });
        } catch (error) {
          await llama.dispose();
          throw error;
        }
        try {
          checkGgufRankerFacts(ggufRankerFacts(model.fileInfo, model.fileInsights.supportsRanking));
          throwIfAborted(signal);
        } catch (error) {
          await model.dispose();
          await llama.dispose();
          throw error;
        }
        this.module = module;
        this.llama = llama;
        this.model = model;
      })().finally(() => {
        this.loading = null;
      });
    }
    await this.loading;
  }

  public async rank(input: {
    instruction: string;
    query: string;
    documents: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ probabilities: number[]; tokenCounts: number[]; truncated: boolean[] }> {
    await this.load(input.signal);
    const model = this.model!;
    const context = await this.context(input.instruction);
    const templateTokens = this.templateTokens(model, input.instruction);
    const query = model.tokenize(input.query, false, "trimLeadingSpace");
    const probabilities: number[] = [];
    const tokenCounts: number[] = [];
    const truncated: boolean[] = [];
    for (const text of input.documents) {
      throwIfAborted(input.signal);
      const fitted = fitRankingSequence<Token>({
        templateTokens,
        query,
        document: model.tokenize(text, false, "trimLeadingSpace"),
        maxSequenceTokens: this.config.maxSequenceTokens
      });
      probabilities.push(await context.rank(fitted.query, fitted.document));
      tokenCounts.push(fitted.tokenCount);
      truncated.push(fitted.truncated);
    }
    return { probabilities, tokenCounts, truncated };
  }

  public async runtimeBuild(): Promise<string> {
    await this.load();
    const version = await this.module!.getModuleVersion();
    const llama = this.llama!;
    return `node-llama-cpp@${version}+llama.cpp@${llama.llamaCppRelease.release}/${String(llama.gpu)}/${llama.buildType}`;
  }

  public async dispose(): Promise<void> {
    const loading = this.loading;
    if (loading) await loading.catch(() => undefined);
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    for (const context of contexts) await context.dispose();
    const model = this.model;
    const llama = this.llama;
    this.model = null;
    this.llama = null;
    this.module = null;
    await model?.dispose();
    await llama?.dispose();
  }

  private async context(instruction: string): Promise<LlamaRankingContext> {
    const cached = this.contexts.get(instruction);
    if (cached) {
      this.contexts.delete(instruction);
      this.contexts.set(instruction, cached);
      return cached;
    }
    while (this.contexts.size >= this.config.ggufCachedContexts) {
      const [oldest, context] = this.contexts.entries().next().value!;
      this.contexts.delete(oldest);
      await context.dispose();
    }
    const context = await this.model!.createRankingContext({
      contextSize: this.config.maxSequenceTokens,
      template: qwen3RankingTemplate(instruction)
    });
    this.contexts.set(instruction, context);
    return context;
  }

  /**
   * Tokens the ranking context adds around the query and the document, counted the way
   * node-llama-cpp 3.19 builds the input: each template piece with special tokens, plus a
   * beginning or end token when the vocabulary asks for one that the template lacks.
   */
  private templateTokens(model: LlamaModel, instruction: string): number {
    const [before = "", rest = ""] = qwen3RankingTemplate(instruction).split("{{query}}");
    const [between = "", after = ""] = rest.split("{{document}}");
    const pieces = [before, between, after].map((piece) =>
      model.tokenize(piece, true, "trimLeadingSpace")
    );
    const first = pieces.find((piece) => piece.length > 0)?.[0];
    const last = [...pieces]
      .reverse()
      .find((piece) => piece.length > 0)
      ?.at(-1);
    const bos = model.tokens.shouldPrependBosToken ? model.tokens.bos : null;
    const eos = model.tokens.shouldAppendEosToken ? model.tokens.eos : null;
    return (
      pieces.reduce((total, piece) => total + piece.length, 0) +
      (bos !== null && first !== bos ? 1 : 0) +
      (eos !== null && last !== eos ? 1 : 0)
    );
  }
}

// --- shared ---------------------------------------------------------------------------------------

/** Runs a rank request through a ranker adapter and returns its checked result. */
export async function rankWithAdapter(
  adapter: AiModelAdapter,
  request: RankRequest,
  signal?: AbortSignal
): Promise<RankResult> {
  const result = await adapter.run(rankTaskRequest(request), signal);
  return readRankResult(result, request.documents.length);
}

function rankerCanHandle(
  request: AiTaskRequest,
  capabilities: AiTaskRequest["requiredCapabilities"]
): boolean {
  return (
    request.taskType === "reranking" &&
    isDedicatedRanker(capabilities) &&
    request.requiredCapabilities.every((capability) => capabilities.includes(capability))
  );
}

function rankerDescriptor(
  providerId: "local-mlx" | "local-gguf",
  options: LocalAdapterOptions,
  adapter: string,
  config: RankerRuntimeConfig
): AiModelDescriptor {
  return {
    providerId,
    modelId: options.modelId,
    runtime: "local",
    capabilities: options.capabilities,
    // A ranker takes no generation parameters: `localParameterCapabilities` of a ranker is `{}`.
    parameterCapabilities: {},
    limits: {
      maxDocuments: rankRequestLimits.maxDocuments,
      maxSequenceTokens: config.maxSequenceTokens
    },
    requirements: {
      adapter,
      kind: "ranker",
      modelPath: options.modelPath,
      ...(options.repository ? { repository: options.repository } : {}),
      ...(options.revision ? { revision: options.revision } : {}),
      ...(options.quantization ? { quantization: options.quantization } : {})
    }
  };
}

/** A ranker's audit: its input tokens are the evaluated sequences, it generates none, it is free. */
function rankTaskResult(
  request: AiTaskRequest,
  providerId: string,
  modelId: string,
  output: RankResult,
  durationMs: number
): AiTaskResult {
  return {
    taskType: request.taskType,
    output,
    providerId,
    modelId,
    runtime: "local",
    durationMs: Math.max(0, Math.round(durationMs)),
    inputTokens: output.tokenCounts.reduce((total, count) => total + count, 0),
    outputTokens: 0,
    costEstimate: 0
  };
}

function unsupported(): LocalRankerError {
  return new LocalRankerError(
    "errors.ai.unsupportedTask",
    "A dedicated ranker runs only rank requests, and only for a ranker model."
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Local inference canceled.", "AbortError");
}
