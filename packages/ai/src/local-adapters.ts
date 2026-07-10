import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AiCapability } from "@app/domain";

import {
  aiTaskRequestSchema,
  type AiProgressListener,
  type AiModelAdapter,
  type AiModelDescriptor,
  type AiTaskRequest,
  type AiTaskResult
} from "./contracts.js";
import { mlxHelperRequestSchema, parseMlxHelperOutput, type MlxHelperRequest } from "./local-runtime-protocol.js";

const supportedLocalTasks = new Set([
  "text-generation",
  "structured-output",
  "summarization",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "reranking"
]);

export interface LocalAdapterOptions {
  modelId: string;
  modelPath: string;
  capabilities: AiCapability[];
  repository?: string;
  revision?: string;
  quantization?: string;
}

export interface LocalExecutionResult {
  output: string | number[];
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

export class NodeLlamaCppAdapter implements AiModelAdapter {
  private readonly runtime: NodeLlamaRuntime | null;
  private readonly execute: (input: { modelPath: string; prompt: string; parameters: Record<string, unknown>; signal?: AbortSignal; onProgress?: AiProgressListener }) => Promise<LocalExecutionResult>;
  private readonly executeEmbedding: (input: { modelPath: string; text: string; parameters: Record<string, unknown>; signal?: AbortSignal }) => Promise<LocalExecutionResult>;

  public constructor(
    private readonly options: LocalAdapterOptions,
    execute?: (input: { modelPath: string; prompt: string; parameters: Record<string, unknown>; signal?: AbortSignal; onProgress?: AiProgressListener }) => Promise<LocalExecutionResult>,
    executeEmbedding?: (input: { modelPath: string; text: string; parameters: Record<string, unknown>; signal?: AbortSignal }) => Promise<LocalExecutionResult>
  ) {
    this.runtime = execute || executeEmbedding ? null : new NodeLlamaRuntime(options.modelPath);
    this.execute = execute ?? ((input) => this.runtime!.generate(input));
    this.executeEmbedding = executeEmbedding ?? ((input) => this.runtime!.embed(input));
  }

  public describe(): AiModelDescriptor {
    return localDescriptor("local-gguf", this.options, "node-llama-cpp");
  }

  public canHandle(request: AiTaskRequest): boolean {
    return (request.taskType === "embedding" || supportedLocalTasks.has(request.taskType))
      && request.requiredCapabilities.every((item) => this.options.capabilities.includes(item));
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    const abort = () => { void this.dispose(); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = input.taskType === "embedding"
        ? await this.executeEmbedding({
            modelPath: this.options.modelPath,
            text: promptFromInput(input.input),
            parameters: input.parameters,
            ...(signal ? { signal } : {})
          })
        : await this.execute({
            modelPath: this.options.modelPath,
            prompt: promptFromInput(input.input),
            parameters: input.parameters,
            ...(signal ? { signal } : {})
          });
      return taskResult(input, "local-gguf", this.options.modelId, result);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  public async runStreaming(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    onProgress: AiProgressListener
  ): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    if (input.taskType === "embedding") return this.run(input, signal);
    const result = await this.execute({
      modelPath: this.options.modelPath,
      prompt: promptFromInput(input.input),
      parameters: input.parameters,
      ...(signal ? { signal } : {}),
      onProgress
    });
    onProgress({ progress: 1 });
    return taskResult(input, "local-gguf", this.options.modelId, result);
  }

  public async dispose(): Promise<void> {
    await this.runtime?.dispose();
  }
}

export class MlxAdapter implements AiModelAdapter {
  private readonly runtime: MlxHelperRuntime | null;
  private readonly execute: (input: MlxExecutionInput) => Promise<LocalExecutionResult>;

  public constructor(
    private readonly options: LocalAdapterOptions & { helperPath: string; timeoutMs?: number },
    execute?: (input: MlxExecutionInput) => Promise<LocalExecutionResult>
  ) {
    this.runtime = execute ? null : new MlxHelperRuntime(options.helperPath);
    this.execute = execute ?? ((input) => this.runtime!.execute(input));
  }

  public describe(): AiModelDescriptor {
    return localDescriptor("local-mlx", this.options, "mlx-swift-lm");
  }

  public canHandle(request: AiTaskRequest): boolean {
    return supportedLocalTasks.has(request.taskType) && request.requiredCapabilities.every((item) => this.options.capabilities.includes(item));
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
    const result = await this.execute({
      helperPath: this.options.helperPath,
      modelPath: this.options.modelPath,
      prompt: promptFromInput(input.input),
      parameters: input.parameters,
      timeoutMs: this.options.timeoutMs ?? 10 * 60_000,
      ...(signal ? { signal } : {})
    });
    return taskResult(input, "local-mlx", this.options.modelId, result);
  }

  public async dispose(): Promise<void> {
    await this.runtime?.dispose();
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

class MlxHelperRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdout = "";
  private stderr = "";
  private persistenceConfirmed = false;

  public constructor(private readonly helperPath: string) {}

  public async execute(input: MlxExecutionInput): Promise<LocalExecutionResult> {
    const child = this.ensureChild();
    const request = createMlxGenerateRequest(input);
    const abort = () => { void this.dispose(); };
    input.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, input.timeoutMs);
    child.stdin.write(`${JSON.stringify(request)}\n`);
    try {
      return await this.waitForResult(child, request, input.signal);
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
  }

  public async dispose(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.stdout = "";
    this.stderr = "";
    if (!child || child.killed) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child;
    this.persistenceConfirmed = false;
    const child = spawn(this.helperPath, [], { stdio: ["pipe", "pipe", "pipe"], env: minimalRuntimeEnvironment() });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { this.stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { this.stderr = `${this.stderr}${chunk}`.slice(-2_000); });
    child.once("error", () => { if (this.child === child) this.child = null; });
    child.once("exit", () => { if (this.child === child) this.child = null; });
    this.child = child;
    return child;
  }

  private async waitForResult(
    child: ChildProcessWithoutNullStreams,
    request: MlxHelperRequest,
    signal?: AbortSignal
  ): Promise<LocalExecutionResult> {
    let exitedAt: number | null = null;
    while (exitedAt === null || Date.now() - exitedAt < 50) {
      if (signal?.aborted) throw new DOMException("Local inference canceled.", "AbortError");
      const messages = parseMlxHelperOutput(this.stdout);
      const response = messages
        .filter((message) => message.kind === "result")
        .findLast((message) => message.requestId === request.requestId);
      if (response) {
        this.stdout = "";
        if (!response.ok) throw new Error(response.error.messageKey);
        const result = {
          output: response.output,
          durationMs: response.durationMs,
          ...(response.inputTokens !== undefined ? { inputTokens: response.inputTokens } : {}),
          ...(response.outputTokens !== undefined ? { outputTokens: response.outputTokens } : {})
        };
        await this.detectPersistence(child);
        return result;
      }
      if (this.child !== child || child.exitCode !== null || child.killed) exitedAt ??= Date.now();
      await new Promise((resolve) => setTimeout(resolve, exitedAt === null ? 10 : 5));
    }
    if (signal?.aborted) throw new DOMException("Local inference canceled.", "AbortError");
    throw new Error("errors.localModels.runtimeFailed");
  }

  private async detectPersistence(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.persistenceConfirmed || child.exitCode !== null || child.killed) return;
    const exited = await new Promise<boolean>((resolve) => {
      const onExit = () => { clearTimeout(timeout); resolve(true); };
      const timeout = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve(false);
      }, 50);
      child.once("exit", onExit);
    });
    if (!exited && this.child === child) this.persistenceConfirmed = true;
  }
}

function createMlxGenerateRequest(input: MlxExecutionInput): MlxHelperRequest {
  const request = mlxHelperRequestSchema.parse({
    protocolVersion: 1,
    requestId: randomUUID(),
    command: "generate",
    modelPath: input.modelPath,
    prompt: input.prompt,
    parameters: {
      maxTokens: numberParameter(input.parameters.maxTokens, 1_024),
      temperature: numberParameter(input.parameters.temperature, 0.2),
      ...(typeof input.parameters.seed === "number" ? { seed: input.parameters.seed } : {})
    }
  });
  return request;
}

class NodeLlamaRuntime {
  private module: typeof import("node-llama-cpp") | null = null;
  private llama: Awaited<ReturnType<typeof import("node-llama-cpp")["getLlama"]>> | null = null;
  private model: Awaited<ReturnType<Awaited<ReturnType<typeof import("node-llama-cpp")["getLlama"]>>["loadModel"]>> | null = null;
  private loading: Promise<void> | null = null;

  public constructor(private readonly modelPath: string) {}

  public async generate(input: {
    prompt: string;
    parameters: Record<string, unknown>;
    signal?: AbortSignal;
    onProgress?: AiProgressListener;
  }): Promise<LocalExecutionResult> {
    const startedAt = Date.now();
    await this.load(input.signal);
    const model = this.model!;
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
        maxTokens: numberParameter(input.parameters.maxTokens, 1_024),
        temperature: numberParameter(input.parameters.temperature, 0.2),
        ...(typeof input.parameters.topP === "number" ? { topP: input.parameters.topP } : {}),
        ...(typeof input.parameters.seed === "number" ? { seed: input.parameters.seed } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.onProgress ? {
          onTextChunk: (chunk: string) => {
            outputCharacters += chunk.length;
            input.onProgress?.({ progress: Math.min(0.95, Math.max(0.02, outputCharacters / (maxTokens * 4))) });
          }
        } : {})
      });
      return {
        output,
        inputTokens,
        outputTokens: model.tokenize(output).length,
        durationMs: Date.now() - startedAt
      };
    } finally {
      await context.dispose();
    }
  }

  public async embed(input: { text: string; parameters: Record<string, unknown>; signal?: AbortSignal }): Promise<LocalExecutionResult> {
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
      const requestedDimensions = numberParameter(input.parameters.dimensions, embedding.vector.length);
      if ((requestedDimensions !== 256 && requestedDimensions !== 768 && requestedDimensions !== 1_024)
          || requestedDimensions > embedding.vector.length) {
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
          model = await llama.loadModel({ modelPath: this.modelPath, ...(signal ? { loadSignal: signal } : {}) });
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
      })().finally(() => { this.loading = null; });
    }
    await this.loading;
  }
}

function localDescriptor(providerId: string, options: LocalAdapterOptions, adapter: string): AiModelDescriptor {
  return {
    providerId,
    modelId: options.modelId,
    runtime: "local",
    capabilities: options.capabilities,
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

function taskResult(request: AiTaskRequest, providerId: string, modelId: string, result: LocalExecutionResult): AiTaskResult {
  return {
    taskType: request.taskType,
    output: result.output,
    providerId,
    modelId,
    runtime: "local",
    durationMs: result.durationMs,
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
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + (value * value), 0));
  return magnitude === 0 ? [...vector] : vector.map((value) => value / magnitude);
}

function minimalRuntimeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL
  };
}
