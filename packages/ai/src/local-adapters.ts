import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AiCapability } from "@app/domain";

import {
  aiTaskRequestSchema,
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
  public constructor(
    private readonly options: LocalAdapterOptions,
    private readonly execute: (input: { modelPath: string; prompt: string; parameters: Record<string, unknown>; signal?: AbortSignal }) => Promise<LocalExecutionResult> = executeNodeLlamaCpp,
    private readonly executeEmbedding: (input: { modelPath: string; text: string; parameters: Record<string, unknown>; signal?: AbortSignal }) => Promise<LocalExecutionResult> = executeNodeLlamaEmbedding
  ) {}

  public describe(): AiModelDescriptor {
    return localDescriptor("local-gguf", this.options, "node-llama-cpp");
  }

  public canHandle(request: AiTaskRequest): boolean {
    return (request.taskType === "embedding" || supportedLocalTasks.has(request.taskType))
      && request.requiredCapabilities.every((item) => this.options.capabilities.includes(item));
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const input = aiTaskRequestSchema.parse(request);
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
  }
}

export class MlxAdapter implements AiModelAdapter {
  public constructor(
    private readonly options: LocalAdapterOptions & { helperPath: string; timeoutMs?: number },
    private readonly execute: (input: MlxExecutionInput) => Promise<LocalExecutionResult> = executeMlxHelper
  ) {}

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

async function executeMlxHelper(input: MlxExecutionInput): Promise<LocalExecutionResult> {
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
  const child = spawn(input.helperPath, [], { stdio: ["pipe", "pipe", "pipe"], env: minimalRuntimeEnvironment() });
  return await runHelperProcess(child, request, input.timeoutMs, input.signal);
}

async function runHelperProcess(
  child: ChildProcessWithoutNullStreams,
  request: MlxHelperRequest,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<LocalExecutionResult> {
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  const abort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  child.stdin.end(`${JSON.stringify(request)}\n`);
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (signal?.aborted) throw new DOMException("Local inference canceled.", "AbortError");
    const messages = parseMlxHelperOutput(stdout);
    const response = messages.findLast((message) => message.kind === "result");
    if (!response || response.requestId !== request.requestId) throw new Error("errors.localModels.invalidRuntimeResponse");
    if (!response.ok) throw new Error(response.error.messageKey);
    if (exitCode !== 0) throw new Error(`errors.localModels.runtimeFailed:${exitCode ?? "signal"}:${stderr.slice(-200)}`);
    return {
      output: response.output,
      durationMs: response.durationMs,
      ...(response.inputTokens !== undefined ? { inputTokens: response.inputTokens } : {}),
      ...(response.outputTokens !== undefined ? { outputTokens: response.outputTokens } : {})
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (!child.killed) child.kill("SIGTERM");
  }
}

async function executeNodeLlamaCpp(input: {
  modelPath: string;
  prompt: string;
  parameters: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<LocalExecutionResult> {
  const startedAt = Date.now();
  const module = await import("node-llama-cpp");
  const llama = await module.getLlama();
  const model = await llama.loadModel({ modelPath: input.modelPath });
  const context = await model.createContext({ contextSize: contextSizeParameter(input.parameters.contextWindow) });
  const session = new module.LlamaChatSession({ contextSequence: context.getSequence() });
  try {
    const inputTokens = model.tokenize(input.prompt).length;
    const output = await session.prompt(input.prompt, {
      maxTokens: numberParameter(input.parameters.maxTokens, 1_024),
      temperature: numberParameter(input.parameters.temperature, 0.2),
      ...(typeof input.parameters.topP === "number" ? { topP: input.parameters.topP } : {}),
      ...(typeof input.parameters.seed === "number" ? { seed: input.parameters.seed } : {}),
      ...(input.signal ? { signal: input.signal } : {})
    });
    return {
      output,
      inputTokens,
      outputTokens: model.tokenize(output).length,
      durationMs: Date.now() - startedAt
    };
  } finally {
    await context.dispose();
    await model.dispose();
    await llama.dispose();
  }
}

async function executeNodeLlamaEmbedding(input: {
  modelPath: string;
  text: string;
  parameters: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<LocalExecutionResult> {
  const startedAt = Date.now();
  const module = await import("node-llama-cpp");
  const llama = await module.getLlama();
  const model = await llama.loadModel({ modelPath: input.modelPath });
  const context = await model.createEmbeddingContext({
    contextSize: contextSizeParameter(input.parameters.contextWindow),
    ...(input.signal ? { createSignal: input.signal } : {})
  });
  try {
    if (input.signal?.aborted) throw new DOMException("Local inference canceled.", "AbortError");
    const embedding = await context.getEmbeddingFor(input.text);
    const requestedDimensions = numberParameter(input.parameters.dimensions, embedding.vector.length);
    if ((requestedDimensions !== 256 && requestedDimensions !== 768)
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
    await model.dispose();
    await llama.dispose();
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
