import type {
  AiCapability,
  AiModelParameterCapabilities,
  AiOutputSchema,
  AiSchemaMode
} from "@app/domain";

import {
  aiTaskRequestSchema,
  type AiProgressListener,
  type AiModelAdapter,
  type AiModelDescriptor,
  type AiTaskRequest,
  type AiTaskResult
} from "./contracts.js";
import { localRuntimeWedgedError, runWithLocalDeadline } from "./local-deadline.js";
import type { MlxGenerationParameters } from "./local-runtime-protocol.js";
import { MlxHelperHost } from "./mlx-helper-host.js";
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
  /** How the runtime constrained the answer (`grammar` for a GGUF schema grammar); `none` when it did not. */
  schemaMode?: AiSchemaMode;
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
    }) => Promise<LocalExecutionResult>
  ) {
    this.runtime = execute || executeEmbedding ? null : new NodeLlamaRuntime(options.modelPath);
    this.execute = execute ?? ((input) => this.runtime!.generate(input));
    this.executeEmbedding = executeEmbedding ?? ((input) => this.runtime!.embed(input));
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

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    if (!this.canHandle(input)) throw new Error("errors.ai.unsupportedTask");
    const result = await this.execute({
      helperPath: this.options.helperPath,
      modelPath: this.options.modelPath,
      prompt: promptFromInput(input.input),
      parameters: input.parameters,
      // The class deadline from execution start (F3 D31); until the helper can cancel (T61), the
      // host kills it at the deadline.
      timeoutMs:
        this.options.timeoutMs ?? localRequestDeadlineMs(input, this.options.localDeadlines),
      ...(signal ? { signal } : {})
    });
    return taskResult(input, "local-mlx", this.options.modelId, {
      ...result,
      output: typeof result.output === "string" ? stripThinkingOutput(result.output) : result.output
    });
  }

  public async dispose(): Promise<void> {
    if (this.ownsHost) await this.host?.dispose();
  }

  private async generate(input: MlxExecutionInput): Promise<LocalExecutionResult> {
    const result = await this.host!.generate(
      {
        modelPath: input.modelPath,
        prompt: input.prompt,
        parameters: mlxGenerationParameters(input.parameters)
      },
      { timeoutMs: input.timeoutMs, ...(input.signal ? { signal: input.signal } : {}) }
    );
    return {
      output: result.output,
      durationMs: result.durationMs,
      ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {})
    };
  }
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

interface MlxExecutionInput {
  helperPath: string;
  modelPath: string;
  prompt: string;
  parameters: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
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

class NodeLlamaRuntime {
  private module: typeof import("node-llama-cpp") | null = null;
  private llama: Awaited<ReturnType<(typeof import("node-llama-cpp"))["getLlama"]>> | null = null;
  private model: Awaited<
    ReturnType<Awaited<ReturnType<(typeof import("node-llama-cpp"))["getLlama"]>>["loadModel"]>
  > | null = null;
  private loading: Promise<void> | null = null;

  public constructor(private readonly modelPath: string) {}

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
                input.onProgress?.({
                  progress: Math.min(0.95, Math.max(0.02, outputCharacters / (maxTokens * 4)))
                });
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
      const requestedDimensions = numberParameter(
        input.parameters.dimensions,
        embedding.vector.length
      );
      if (
        (requestedDimensions !== 256 &&
          requestedDimensions !== 768 &&
          requestedDimensions !== 1_024) ||
        requestedDimensions > embedding.vector.length
      ) {
        throw new Error(`Unsupported embedding dimension: ${requestedDimensions}`);
      }
      return {
        output: normalizeVector(embedding.vector.slice(0, requestedDimensions)),
        inputTokens: model.tokenize(input.text).length,
        durationMs: Date.now() - startedAt
      };
    } finally {
      await context.dispose();
    }
  }

  public async dispose(): Promise<void> {
    const loading = this.loading;
    if (loading) await loading.catch(() => undefined);
    const model = this.model;
    const llama = this.llama;
    this.model = null;
    this.llama = null;
    this.module = null;
    await model?.dispose();
    await llama?.dispose();
  }

  private async load(signal?: AbortSignal): Promise<void> {
    if (this.model) return;
    if (!this.loading) {
      this.loading = (async () => {
        const module = await import("node-llama-cpp");
        const llama = await module.getLlama();
        let model;
        try {
          model = await llama.loadModel({
            modelPath: this.modelPath,
            ...(signal ? { loadSignal: signal } : {})
          });
        } catch (error) {
          await llama.dispose();
          throw error;
        }
        if (signal?.aborted) {
          await model.dispose();
          await llama.dispose();
          throw new DOMException("Local inference canceled.", "AbortError");
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

function normalizeVector(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return magnitude === 0 ? [...vector] : vector.map((value) => value / magnitude);
}
