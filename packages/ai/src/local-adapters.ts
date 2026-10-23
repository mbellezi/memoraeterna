import {
  grammarSchemaForContract,
  type AiCapability,
  type AiModelParameterCapabilities,
  type AiOutputContract,
  type AiOutputSchema,
  type AiSchemaMode
} from "@app/domain";

import {
  aiTaskRequestSchema,
  type AiEmbedManyOptions,
  type AiEmbedManyResult,
  type AiProgressListener,
  type AiProgressStep,
  type AiModelAdapter,
  type AiModelDescriptor,
  type AiTaskRequest,
  type AiTaskResult
} from "./contracts.js";
import { runDisposeStep, type LocalDisposeListener } from "./dispose-step.js";
import { embedManyDimensions, embedManyRequest } from "./embed-many.js";
import {
  LocalDeadlineError,
  localRuntimeWedgedError,
  runWithLocalDeadline
} from "./local-deadline.js";
import type { MlxGenerationParameters, MlxGrammarReport } from "./local-runtime-protocol.js";
import { MlxHelperError, MlxHelperHost } from "./mlx-helper-host.js";
import { hasGeneration, localParameterCapabilities } from "./parameter-capabilities.js";
import { requestWorkloadClass } from "./remote-execution.js";
import {
  defaultAiLaneRuntimeConfig,
  localDeadlineMs,
  type AiLocalDeadlines,
  type MlxRuntimeConfigInput
} from "./runtime-config.js";

/**
 * Tasks a generative local model runs by prompting. `reranking` is here as the decision route: a
 * generative model decides by prompt. A dedicated ranker is never prompted; it runs on the ranker
 * adapters (`local-ranker-adapters.ts`), and the generative adapters refuse it.
 */
const generativeLocalTasks = new Set([
  "text-generation",
  "structured-output",
  "summarization",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "reranking"
]);

/** Whether a generative adapter for a model with these capabilities can run the request. */
function generativeAdapterCanHandle(
  request: AiTaskRequest,
  capabilities: readonly AiCapability[]
): boolean {
  if (!request.requiredCapabilities.every((item) => capabilities.includes(item))) return false;
  if (request.taskType === "embedding") return capabilities.includes("embedding");
  return generativeLocalTasks.has(request.taskType) && hasGeneration(capabilities);
}

export interface LocalAdapterOptions {
  modelId: string;
  modelPath: string;
  capabilities: AiCapability[];
  repository?: string;
  revision?: string;
  quantization?: string;
  catalogId?: string;
  parameterCapabilities?: AiModelParameterCapabilities;
  /** Local deadlines per workload class (F3 D31); the typed defaults when left out. */
  localDeadlines?: AiLocalDeadlines;
  /** Receives each bounded step of disposing a GGUF runtime (F4 D23), so the quit can log it. */
  onDisposeStep?: LocalDisposeListener;
}

/** The deadline of a local request: its stated class's, else its task type's class's. */
export function localRequestDeadlineMs(
  request: Pick<AiTaskRequest, "taskType" | "workloadClass">,
  deadlines: AiLocalDeadlines = defaultAiLaneRuntimeConfig.localDeadlines
): number {
  return localDeadlineMs(deadlines, requestWorkloadClass(request));
}

/**
 * A GGUF runtime's deadline guard. A call runs under its class deadline and cancels cooperatively;
 * one that ignores the cancellation is abandoned after the grace period and wedges the runtime, which
 * refuses calls until the abandoned one ended and the runtime was disposed (the next call reloads).
 */
export class LocalRuntimeGuard {
  private wedged: Promise<void> | null = null;

  public constructor(
    private readonly deadlines: AiLocalDeadlines,
    private readonly dispose: () => Promise<void>
  ) {}

  public get isWedged(): boolean {
    return this.wedged !== null;
  }

  public run<T>(
    request: Pick<AiTaskRequest, "taskType" | "workloadClass">,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal, touch: () => void) => Promise<T>,
    options: { streamed?: boolean } = {}
  ): Promise<T> {
    const deadlineMs = localRequestDeadlineMs(request, this.deadlines);
    if (this.wedged) return Promise.reject(localRuntimeWedgedError(deadlineMs));
    return runWithLocalDeadline({
      deadlineMs,
      graceMs: this.deadlines.graceMs,
      signal,
      ...(options.streamed ? { stallMs: this.deadlines.tokenStallMs } : {}),
      run,
      wedged: (settled) => {
        const recovery = settled
          .then(
            () => undefined,
            () => undefined
          )
          .then(() => this.dispose())
          .catch(() => undefined)
          .finally(() => {
            if (this.wedged === recovery) this.wedged = null;
          });
        this.wedged = recovery;
        return recovery;
      }
    });
  }
}

export interface LocalExecutionResult {
  output: string | number[];
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  /**
   * How the runtime constrained the answer (`grammar` for a GGUF schema grammar or the MLX helper's
   * mask); `none` when it did not.
   */
  schemaMode?: AiSchemaMode;
  /** What the runtime chose for the request itself (the MLX grammar's report), for the audit. */
  requestOptions?: AiTaskResult["requestOptions"];
}

/** The vectors of a local batch, in order, with the tokens of each text when the runtime counts them. */
export interface LocalEmbeddingBatch {
  embeddings: number[][];
  itemInputTokens?: number[];
  durationMs: number;
}

/** A batch as the single executor's calls one after another (an executor without a runtime of its own). */
async function embedSequentially(
  executeEmbedding: (input: {
    modelPath: string;
    text: string;
    parameters: Record<string, unknown>;
    signal?: AbortSignal;
  }) => Promise<LocalExecutionResult>,
  input: {
    modelPath: string;
    texts: readonly string[];
    parameters: Record<string, unknown>;
    signal?: AbortSignal;
  }
): Promise<LocalEmbeddingBatch> {
  const embeddings: number[][] = [];
  const itemInputTokens: number[] = [];
  let durationMs = 0;
  for (const text of input.texts) {
    input.signal?.throwIfAborted();
    const result = await executeEmbedding({
      modelPath: input.modelPath,
      text,
      parameters: input.parameters,
      ...(input.signal ? { signal: input.signal } : {})
    });
    embeddings.push(result.output as number[]);
    itemInputTokens.push(result.inputTokens ?? 0);
    durationMs += result.durationMs;
  }
  return { embeddings, itemInputTokens, durationMs };
}

export class NodeLlamaCppAdapter implements AiModelAdapter {
  private readonly runtime: NodeLlamaRuntime | null;
  private readonly guard: LocalRuntimeGuard;
  private readonly execute: (input: {
    modelPath: string;
    prompt: string;
    parameters: Record<string, unknown>;
    outputSchema?: AiOutputSchema;
    signal?: AbortSignal;
    onProgress?: AiProgressListener;
  }) => Promise<LocalExecutionResult>;
  private readonly executeEmbedding: (input: {
    modelPath: string;
    text: string;
    parameters: Record<string, unknown>;
    signal?: AbortSignal;
  }) => Promise<LocalExecutionResult>;
  private readonly executeEmbeddingMany: (input: {
    modelPath: string;
    texts: readonly string[];
    parameters: Record<string, unknown>;
    signal?: AbortSignal;
  }) => Promise<LocalEmbeddingBatch>;

  public constructor(
    private readonly options: LocalAdapterOptions,
    execute?: (input: {
      modelPath: string;
      prompt: string;
      parameters: Record<string, unknown>;
      outputSchema?: AiOutputSchema;
      signal?: AbortSignal;
      onProgress?: AiProgressListener;
    }) => Promise<LocalExecutionResult>,
    executeEmbedding?: (input: {
      modelPath: string;
      text: string;
      parameters: Record<string, unknown>;
      signal?: AbortSignal;
    }) => Promise<LocalExecutionResult>,
    executeEmbeddingMany?: (input: {
      modelPath: string;
      texts: readonly string[];
      parameters: Record<string, unknown>;
      signal?: AbortSignal;
    }) => Promise<LocalEmbeddingBatch>
  ) {
    this.runtime =
      execute || executeEmbedding
        ? null
        : new NodeLlamaRuntime(options.modelPath, {
            disposeMs: (options.localDeadlines ?? defaultAiLaneRuntimeConfig.localDeadlines)
              .disposeMs,
            ...(options.onDisposeStep ? { onDisposeStep: options.onDisposeStep } : {})
          });
    this.execute = execute ?? ((input) => this.runtime!.generate(input));
    this.executeEmbedding = executeEmbedding ?? ((input) => this.runtime!.embed(input));
    // Without a runtime of its own (an injected executor) the batch is the single calls in order.
    this.executeEmbeddingMany =
      executeEmbeddingMany ??
      (this.runtime
        ? (input) => this.runtime!.embedMany(input)
        : (input) => embedSequentially(this.executeEmbedding, input));
    this.guard = new LocalRuntimeGuard(
      options.localDeadlines ?? defaultAiLaneRuntimeConfig.localDeadlines,
      () => this.dispose()
    );
  }

  /** The runtime ignored a deadline and is wedged until the abandoned call ended (F3 D31). */
  public get wedged(): boolean {
    return this.guard.isWedged;
  }

  public describe(): AiModelDescriptor {
    return localDescriptor("local-gguf", this.options, "node-llama-cpp");
  }

  public canHandle(request: AiTaskRequest): boolean {
    return generativeAdapterCanHandle(request, this.options.capabilities);
  }

  public isLoaded(): boolean {
    return this.runtime?.isLoaded() ?? true;
  }

  public async ensureLoaded(signal?: AbortSignal): Promise<void> {
    await this.runtime?.ensureLoaded(signal);
  }

  /**
   * Runs under the class deadline. Cancellation stops the sequence (its context is disposed) and
   * keeps the model loaded; only an abandoned call disposes the runtime.
   */
  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    if (!this.canHandle(input)) throw new Error("errors.ai.unsupportedTask");
    const result = await this.guard.run(input, signal, (bounded) =>
      input.taskType === "embedding"
        ? this.executeEmbedding({
            modelPath: this.options.modelPath,
            text: promptFromInput(input.input),
            parameters: input.parameters,
            signal: bounded
          })
        : this.execute({
            modelPath: this.options.modelPath,
            prompt: promptFromInput(input.input),
            parameters: input.parameters,
            ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
            signal: bounded
          })
    );
    return taskResult(input, "local-gguf", this.options.modelId, result);
  }

  /**
   * Embeds the texts one after another on one embedding context (F3 D37). Every vector is the one a
   * single call of that text gives, bit for bit, so the embedding space key is the one of the single
   * path; the whole batch runs under one embed-class deadline.
   */
  public async embedMany(
    texts: readonly string[],
    options: AiEmbedManyOptions = {}
  ): Promise<AiEmbedManyResult> {
    const request = aiTaskRequestSchema.parse(embedManyRequest("", options));
    if (!this.canHandle(request)) throw new Error("errors.ai.unsupportedTask");
    const parameters = { ...request.parameters, dimensions: embedManyDimensions(options) };
    const batch = await this.guard.run(request, options.signal, (bounded) =>
      this.executeEmbeddingMany({
        modelPath: this.options.modelPath,
        texts,
        parameters,
        signal: bounded
      })
    );
    const inputTokens = batch.itemInputTokens?.reduce((total, count) => total + count, 0);
    return {
      embeddings: batch.embeddings,
      ...(batch.itemInputTokens ? { itemInputTokens: batch.itemInputTokens } : {}),
      providerId: "local-gguf",
      modelId: this.options.modelId,
      runtime: "local",
      durationMs: batch.durationMs,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      costEstimate: 0
    };
  }

  public async runStreaming(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    onProgress: AiProgressListener
  ): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    if (input.taskType === "embedding") return this.run(input, signal);
    if (!this.canHandle(input)) throw new Error("errors.ai.unsupportedTask");
    // Each streamed chunk restarts the token stall bound once the first one arrived.
    const result = await this.guard.run(
      input,
      signal,
      (bounded, touch) =>
        this.execute({
          modelPath: this.options.modelPath,
          prompt: promptFromInput(input.input),
          parameters: input.parameters,
          ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          signal: bounded,
          onProgress: (event) => {
            touch();
            onProgress(event);
          }
        }),
      { streamed: true }
    );
    onProgress({ progress: 1 });
    return taskResult(input, "local-gguf", this.options.modelId, result);
  }

  public async dispose(): Promise<void> {
    await this.runtime?.dispose();
  }
}

export interface MlxAdapterOptions extends LocalAdapterOptions {
  helperPath: string;
  /** Replaces the class deadline of every request (tests). */
  timeoutMs?: number;
  /** Memory bounds and deadlines of the helper process this adapter owns. */
  runtimeConfig?: MlxRuntimeConfigInput;
  /**
   * A helper host shared with other adapters, so generation, embeddings and ranking use one
   * helper process. The adapter never disposes a host it did not create.
   */
  host?: MlxHelperHost;
}

export class MlxAdapter implements AiModelAdapter {
  private readonly host: MlxHelperHost | null;
  private readonly ownsHost: boolean;
  private readonly execute: (input: MlxExecutionInput) => Promise<LocalExecutionResult>;

  public constructor(
    private readonly options: MlxAdapterOptions,
    execute?: (input: MlxExecutionInput) => Promise<LocalExecutionResult>
  ) {
    this.ownsHost = !execute && !options.host;
    this.host = execute
      ? null
      : (options.host ??
        new MlxHelperHost({
          helperPath: options.helperPath,
          ...(options.runtimeConfig ? { config: options.runtimeConfig } : {})
        }));
    this.execute = execute ?? ((input) => this.generate(input));
  }

  public describe(): AiModelDescriptor {
    return localDescriptor("local-mlx", this.options, "mlx-swift-lm");
  }

  public canHandle(request: AiTaskRequest): boolean {
    return (
      request.taskType !== "embedding" &&
      generativeAdapterCanHandle(request, this.options.capabilities)
    );
  }

  /**
   * Whether the shared helper holds this model now. After an unload, a stopped helper or a failed
   * generation it does not, and the next call loads it (the memory guard runs first, F3 D39).
   */
  public isLoaded(): boolean {
    return this.host ? this.host.loadedModel("generate") === this.options.modelPath : true;
  }

  /**
   * The grammar schema of a stated contract (F4 D24): the helper decodes the answer under it. None
   * when the running helper announced no `schema` (an older build); before the helper started, the
   * schema is derived and the host leaves it out if the helper turns out not to take it. Whether the
   * model's tokenizer can be masked is the helper's to say (`schemaMode` of the result).
   */
  public outputSchemaFor(contract: AiOutputContract): AiOutputSchema | null {
    if (this.host?.capabilities && !this.host.supports("schema")) return null;
    return grammarSchemaForContract(contract);
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    if (!this.canHandle(input)) throw new Error("errors.ai.unsupportedTask");
    const execution = this.executionInput(input, signal);
    return this.taskResult(input, execution, await this.execute(execution));
  }

  /**
   * Generates with the text streamed (F3 D22): the helper's `delta` lines become `{kind: "text"}`
   * events carrying the answer only (never the reasoning before a `</think>`), and its progress
   * lines progress events. Once the first piece came, a silence longer than the token stall bound
   * stops the call like its deadline does. An older helper that does not stream answers at the end.
   */
  public async runStreaming(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    onProgress: AiProgressListener
  ): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    if (!this.canHandle(input)) throw new Error("errors.ai.unsupportedTask");
    const answer = mlxAnswerStream(
      mlxGenerationParameters(input.parameters).enableThinking === true
    );
    const emit = (text: string) => {
      if (text.length > 0) onProgress({ kind: "text", delta: text });
    };
    const execution = this.executionInput(input, signal);
    const stallMs = (this.options.localDeadlines ?? defaultAiLaneRuntimeConfig.localDeadlines)
      .tokenStallMs;
    const result = await this.execute({
      ...execution,
      stallMs,
      onDelta: (chunk) => emit(answer.push(chunk)),
      onProgress
    }).catch((error: unknown) => {
      throw mlxGenerationFailure(error, execution.timeoutMs, stallMs);
    });
    emit(answer.end());
    onProgress({ progress: 1 });
    return this.taskResult(input, execution, result);
  }

  public async dispose(): Promise<void> {
    if (this.ownsHost) await this.host?.dispose();
  }

  private executionInput(input: AiTaskRequest, signal: AbortSignal | undefined): MlxExecutionInput {
    // With thinking on the answer follows free reasoning, so no schema is sent (F4 D24).
    const thinking = mlxGenerationParameters(input.parameters).enableThinking === true;
    return {
      helperPath: this.options.helperPath,
      modelPath: this.options.modelPath,
      prompt: promptFromInput(input.input),
      parameters: input.parameters,
      ...(input.outputSchema && !thinking ? { outputSchema: input.outputSchema } : {}),
      ...(input.outputSchema && thinking ? { schemaRefusal: "thinking" as const } : {}),
      // The class deadline from execution start (F3 D31): the host cancels the request then, and
      // kills the helper only if it has not stopped within the grace period.
      timeoutMs:
        this.options.timeoutMs ?? localRequestDeadlineMs(input, this.options.localDeadlines),
      ...(signal ? { signal } : {})
    };
  }

  /** The task result; a schema left out for thinking is recorded as refused, the answer as `none`. */
  private taskResult(
    input: AiTaskRequest,
    execution: MlxExecutionInput,
    result: LocalExecutionResult
  ): AiTaskResult {
    const refused = execution.schemaRefusal
      ? {
          schemaMode: "none" as const,
          requestOptions: { grammar: { refusal: execution.schemaRefusal } }
        }
      : {};
    return taskResult(input, "local-mlx", this.options.modelId, {
      ...result,
      ...refused,
      output: typeof result.output === "string" ? stripThinkingOutput(result.output) : result.output
    });
  }

  private async generate(input: MlxExecutionInput): Promise<LocalExecutionResult> {
    const result = await this.host!.generate(
      {
        modelPath: input.modelPath,
        prompt: input.prompt,
        parameters: mlxGenerationParameters(input.parameters),
        ...(input.onDelta ? { stream: true } : {}),
        ...(input.outputSchema ? { schema: input.outputSchema.schema } : {})
      },
      {
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onDelta ? { onDelta: input.onDelta } : {}),
        ...(input.stallMs !== undefined ? { stallMs: input.stallMs } : {}),
        ...(input.onProgress
          ? {
              onProgress: ({ progress, messageKey }) => input.onProgress!({ progress, messageKey })
            }
          : {})
      }
    );
    return {
      output: result.output,
      durationMs: result.durationMs,
      ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
      // A helper that took no schema (or none was sent) wrote the answer unconstrained.
      schemaMode: result.schemaMode === "grammar" ? "grammar" : "none",
      ...(result.grammar ? { requestOptions: { grammar: grammarAudit(result.grammar) } } : {})
    };
  }
}

/** The grammar report as the audit stores it (`requestOptions.grammar`): its known fields only. */
function grammarAudit(report: MlxGrammarReport): Record<string, string | number> {
  const audit: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(report)) if (value !== undefined) audit[key] = value;
  return audit;
}

/** A streamed generation that went silent is a local deadline outcome (`stalled`, transient). */
function mlxGenerationFailure(error: unknown, deadlineMs: number, stallMs: number): unknown {
  if (!(error instanceof MlxHelperError) || error.code !== "stalled") return error;
  return new LocalDeadlineError(`Local model generation stalled for ${stallMs} ms.`, {
    code: "stalled",
    deadlineMs
  });
}

/**
 * The answer part of a streamed MLX generation, read the way {@link stripThinkingOutput} reads the
 * whole output: text up to a closing `</think>` is reasoning and is never streamed (F3 D22). With
 * thinking on, everything waits for the closing tag (the chat template may open the block in the
 * prompt); with thinking off, only text that starts with `<think>` waits for it. The answer's
 * leading whitespace is dropped. Without a closing tag the whole output is the answer, sent at the end.
 */
export function mlxAnswerStream(thinking: boolean): {
  push: (chunk: string) => string;
  end: () => string;
} {
  const open = "<think>";
  const close = "</think>";
  let held = "";
  let answering = false;
  let started = false;
  const answer = (text: string) => {
    if (started) return text;
    const trimmed = text.replace(/^\s+/u, "");
    if (trimmed.length > 0) started = true;
    return trimmed;
  };
  return {
    push(chunk) {
      if (answering) return answer(chunk);
      held += chunk;
      const closing = held.indexOf(close);
      if (closing >= 0) {
        answering = true;
        const rest = held.slice(closing + close.length);
        held = "";
        return answer(rest);
      }
      if (thinking) return "";
      const head = held.trimStart();
      const mayBeReasoning =
        head.length < open.length ? open.startsWith(head) : head.startsWith(open);
      if (mayBeReasoning) return "";
      answering = true;
      const text = held;
      held = "";
      return answer(text);
    },
    end() {
      if (answering || held.length === 0) return "";
      const text = held.trim();
      held = "";
      return answer(text);
    }
  };
}

export function detectLocalRuntimeCompatibility(input: {
  runtime: "gguf" | "mlx";
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  totalMemoryBytes: number;
  minimumMemoryBytes: number;
}): { compatible: boolean; reason: "compatible" | "unsupported_platform" | "insufficient_memory" } {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  if (input.runtime === "mlx" && (platform !== "darwin" || arch !== "arm64")) {
    return { compatible: false, reason: "unsupported_platform" };
  }
  if (input.totalMemoryBytes < input.minimumMemoryBytes) {
    return { compatible: false, reason: "insufficient_memory" };
  }
  return { compatible: true, reason: "compatible" };
}

export interface MlxExecutionInput {
  helperPath: string;
  modelPath: string;
  prompt: string;
  parameters: Record<string, unknown>;
  /** The grammar schema the answer is decoded under (F4 D24); absent with thinking on. */
  outputSchema?: AiOutputSchema;
  /** Why a schema the request carried was not sent. */
  schemaRefusal?: "thinking";
  timeoutMs: number;
  signal?: AbortSignal;
  /** Streams the generation: each piece of text as the helper writes it. */
  onDelta?: (text: string) => void;
  /** Longest silence between two streamed pieces once the first one came. */
  stallMs?: number;
  onProgress?: (event: AiProgressStep) => void;
}

/** Maps the canonical task parameters to the helper's generation parameters. */
function mlxGenerationParameters(parameters: Record<string, unknown>): MlxGenerationParameters {
  return {
    maxTokens: numberParameter(parameters.maxTokens, 1_024),
    temperature: numberParameter(parameters.temperature, 0.2),
    ...(typeof parameters.topP === "number" ? { topP: parameters.topP } : {}),
    ...(typeof parameters.topK === "number" ? { topK: parameters.topK } : {}),
    ...(typeof parameters.presencePenalty === "number"
      ? { presencePenalty: parameters.presencePenalty }
      : {}),
    enableThinking:
      typeof parameters.reasoningLevel === "string" ? parameters.reasoningLevel !== "off" : false,
    ...(typeof parameters.seed === "number" ? { seed: parameters.seed } : {})
  };
}

export function stripThinkingOutput(output: string): string {
  const closingTag = "</think>";
  const closingIndex = output.indexOf(closingTag);
  return (closingIndex >= 0 ? output.slice(closingIndex + closingTag.length) : output).trim();
}

/**
 * What a streamed chunk of generated text reports: the text itself (F3 D22) and the estimated
 * progress. node-llama-cpp keeps thought segments out of the text chunks, so a chunk is answer text.
 */
export function reportGeneratedChunk(
  listener: AiProgressListener | undefined,
  chunk: string,
  outputCharacters: number,
  maxTokens: number
): void {
  if (!listener) return;
  if (chunk.length > 0) listener({ kind: "text", delta: chunk });
  listener({ progress: Math.min(0.95, Math.max(0.02, outputCharacters / (maxTokens * 4))) });
}

type NodeLlamaModule = typeof import("node-llama-cpp");

export interface NodeLlamaRuntimeOptions {
  /** The longest one step of `dispose` waits (F4 D23); the typed default when left out. */
  disposeMs?: number;
  onDisposeStep?: LocalDisposeListener;
  /** Loads the engine module (tests); `node-llama-cpp` when left out. */
  importModule?: () => Promise<NodeLlamaModule>;
}

/** The in-process GGUF engine: one model, loaded on first use, with a bounded disposal. */
export class NodeLlamaRuntime {
  private module: typeof import("node-llama-cpp") | null = null;
  private llama: Awaited<ReturnType<(typeof import("node-llama-cpp"))["getLlama"]>> | null = null;
  private model: Awaited<
    ReturnType<Awaited<ReturnType<(typeof import("node-llama-cpp"))["getLlama"]>>["loadModel"]>
  > | null = null;
  private loading: Promise<void> | null = null;
  /** Aborts the load in progress when the runtime is disposed. */
  private loadAbort: AbortController | null = null;

  public constructor(
    private readonly modelPath: string,
    private readonly options: NodeLlamaRuntimeOptions = {}
  ) {}

  public isLoaded(): boolean {
    return this.model !== null;
  }

  public async ensureLoaded(signal?: AbortSignal): Promise<void> {
    await this.load(signal);
  }

  public async generate(input: {
    prompt: string;
    parameters: Record<string, unknown>;
    outputSchema?: AiOutputSchema;
    signal?: AbortSignal;
    onProgress?: AiProgressListener;
  }): Promise<LocalExecutionResult> {
    const startedAt = Date.now();
    await this.load(input.signal);
    const model = this.model!;
    // A schema becomes a grammar that only lets the model write answers of that shape (F3 D35). A
    // schema the grammar compiler refuses leaves the call unconstrained, and the result says so.
    const grammar = input.outputSchema
      ? await this.llama!.createGrammarForJsonSchema(input.outputSchema.schema as never).catch(
          () => null
        )
      : null;
    const context = await model.createContext({
      contextSize: contextSizeParameter(input.parameters.contextWindow),
      ...(input.signal ? { createSignal: input.signal } : {})
    });
    const session = new this.module!.LlamaChatSession({ contextSequence: context.getSequence() });
    try {
      const inputTokens = model.tokenize(input.prompt).length;
      let outputCharacters = 0;
      const maxTokens = numberParameter(input.parameters.maxTokens, 1_024);
      const output = await session.prompt(input.prompt, {
        ...(grammar ? { grammar } : {}),
        maxTokens: numberParameter(input.parameters.maxTokens, 1_024),
        temperature: numberParameter(input.parameters.temperature, 0.2),
        ...(typeof input.parameters.topP === "number" ? { topP: input.parameters.topP } : {}),
        ...(typeof input.parameters.topK === "number" ? { topK: input.parameters.topK } : {}),
        ...(typeof input.parameters.seed === "number" ? { seed: input.parameters.seed } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onProgress
          ? {
              onTextChunk: (chunk: string) => {
                outputCharacters += chunk.length;
                reportGeneratedChunk(input.onProgress, chunk, outputCharacters, maxTokens);
              }
            }
          : {})
      });
      return {
        output,
        inputTokens,
        outputTokens: model.tokenize(output).length,
        durationMs: Date.now() - startedAt,
        schemaMode: grammar ? "grammar" : "none"
      };
    } finally {
      await context.dispose();
    }
  }

  public async embed(input: {
    text: string;
    parameters: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<LocalExecutionResult> {
    const startedAt = Date.now();
    await this.load(input.signal);
    const model = this.model!;
    const context = await model.createEmbeddingContext({
      contextSize: contextSizeParameter(input.parameters.contextWindow),
      ...(input.signal ? { createSignal: input.signal } : {})
    });
    try {
      if (input.signal?.aborted) throw new DOMException("Local inference canceled.", "AbortError");
      const embedding = await context.getEmbeddingFor(input.text);
      return {
        output: embeddingVector(embedding.vector, input.parameters),
        inputTokens: model.tokenize(input.text).length,
        durationMs: Date.now() - startedAt
      };
    } finally {
      await context.dispose();
    }
  }

  /** The texts on one embedding context, one after another (the vectors `embed` gives, bit for bit). */
  public async embedMany(input: {
    texts: readonly string[];
    parameters: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<LocalEmbeddingBatch> {
    const startedAt = Date.now();
    await this.load(input.signal);
    const model = this.model!;
    const context = await model.createEmbeddingContext({
      contextSize: contextSizeParameter(input.parameters.contextWindow),
      ...(input.signal ? { createSignal: input.signal } : {})
    });
    try {
      const embeddings: number[][] = [];
      const itemInputTokens: number[] = [];
      for (const text of input.texts) {
        if (input.signal?.aborted)
          throw new DOMException("Local inference canceled.", "AbortError");
        const embedding = await context.getEmbeddingFor(text);
        embeddings.push(embeddingVector(embedding.vector, input.parameters));
        itemInputTokens.push(model.tokenize(text).length);
      }
      return { embeddings, itemInputTokens, durationMs: Date.now() - startedAt };
    } finally {
      await context.dispose();
    }
  }

  /**
   * Releases the model and the engine. A load in progress is aborted first; each step (the load, the
   * model, the engine) waits at most `disposeMs` and is reported, so a native `dispose` that does not
   * return cannot hold the quit (F4 D23). An abandoned step is left running.
   */
  public async dispose(): Promise<void> {
    const disposeMs = this.options.disposeMs ?? defaultAiLaneRuntimeConfig.localDeadlines.disposeMs;
    const listener = this.options.onDisposeStep;
    const loading = this.loading;
    if (loading) {
      this.loadAbort?.abort();
      await runDisposeStep("gguf load", disposeMs, () => loading.catch(() => undefined), listener);
    }
    const model = this.model;
    const llama = this.llama;
    this.model = null;
    this.llama = null;
    this.module = null;
    if (model) await runDisposeStep("gguf model", disposeMs, () => model.dispose(), listener);
    if (llama) await runDisposeStep("gguf engine", disposeMs, () => llama.dispose(), listener);
  }

  private async load(signal?: AbortSignal): Promise<void> {
    if (this.model) return;
    if (!this.loading) {
      const abort = new AbortController();
      this.loadAbort = abort;
      const loadSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      this.loading = (async () => {
        const module = await (this.options.importModule?.() ?? import("node-llama-cpp"));
        const llama = await module.getLlama();
        let model;
        try {
          model = await llama.loadModel({ modelPath: this.modelPath, loadSignal });
        } catch (error) {
          await llama.dispose();
          throw error;
        }
        if (loadSignal.aborted) {
          await model.dispose();
          await llama.dispose();
          throw new DOMException("Local inference canceled.", "AbortError");
        }
        this.module = module;
        this.llama = llama;
        this.model = model;
      })().finally(() => {
        this.loading = null;
        if (this.loadAbort === abort) this.loadAbort = null;
      });
    }
    await this.loading;
  }
}

function localDescriptor(
  providerId: string,
  options: LocalAdapterOptions,
  adapter: string
): AiModelDescriptor {
  const runtime = providerId === "local-mlx" ? "mlx" : "gguf";
  return {
    providerId,
    modelId: options.modelId,
    runtime: "local",
    capabilities: options.capabilities,
    parameterCapabilities:
      options.parameterCapabilities ??
      localParameterCapabilities({
        runtime,
        modelId: options.modelId,
        capabilities: options.capabilities,
        ...(options.catalogId ? { catalogId: options.catalogId } : {})
      }),
    limits: {},
    requirements: {
      adapter,
      modelPath: options.modelPath,
      ...(options.repository ? { repository: options.repository } : {}),
      ...(options.revision ? { revision: options.revision } : {}),
      ...(options.quantization ? { quantization: options.quantization } : {})
    }
  };
}

function taskResult(
  request: AiTaskRequest,
  providerId: string,
  modelId: string,
  result: LocalExecutionResult
): AiTaskResult {
  return {
    taskType: request.taskType,
    output: result.output,
    providerId,
    modelId,
    runtime: "local",
    durationMs: result.durationMs,
    ...(request.taskType !== "embedding" ? { schemaMode: result.schemaMode ?? "none" } : {}),
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.requestOptions ? { requestOptions: result.requestOptions } : {}),
    costEstimate: 0
  };
}

function promptFromInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

function numberParameter(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function contextSizeParameter(value: unknown): "auto" | number {
  return typeof value === "number" && Number.isInteger(value) && value >= 128 ? value : "auto";
}

/** The stored form of a model's vector: cut to the requested dimension and normalized (rules/ai.md). */
function embeddingVector(vector: readonly number[], parameters: Record<string, unknown>): number[] {
  const requestedDimensions = numberParameter(parameters.dimensions, vector.length);
  if (
    (requestedDimensions !== 256 && requestedDimensions !== 768 && requestedDimensions !== 1_024) ||
    requestedDimensions > vector.length
  ) {
    throw new Error(`Unsupported embedding dimension: ${requestedDimensions}`);
  }
  return normalizeVector(vector.slice(0, requestedDimensions));
}

function normalizeVector(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return magnitude === 0 ? [...vector] : vector.map((value) => value / magnitude);
}
