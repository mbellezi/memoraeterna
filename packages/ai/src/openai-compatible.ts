import type { AiCapability, AiReasoningLevel, AiTaskType } from "@app/domain";

import type { AiModelAdapter, AiModelDescriptor, AiProgressListener, AiTaskRequest, AiTaskResult } from "./contracts.js";
import { effectiveReasoningLevel, openAiReasoningEffort } from "./reasoning.js";

export interface OpenAiCompatibleAdapterOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  capabilities: AiCapability[];
  fetch?: typeof fetch;
}

const generationTasks = new Set<AiTaskType>([
  "text-generation", "structured-output", "summarization", "atomic-note-generation",
  "entity-extraction", "claim-extraction", "knowledge-graph-generation", "reranking", "writing-assistance"
]);

export class OpenAiCompatibleAdapter implements AiModelAdapter {
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: OpenAiCompatibleAdapterOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
  }

  public describe(): AiModelDescriptor {
    return {
      providerId: "openai-compatible",
      modelId: this.options.modelId,
      runtime: "remote",
      capabilities: this.options.capabilities,
      requirements: { network: true, apiKey: true },
      limits: {}
    };
  }

  public canHandle(request: AiTaskRequest): boolean {
    return request.taskType === "embedding" || generationTasks.has(request.taskType);
  }

  public async testConnection(signal?: AbortSignal): Promise<void> {
    const response = await this.request("/models", { method: "GET", ...(signal ? { signal } : {}) });
    if (!response.ok) throw new Error(`AI provider connection failed (${response.status}).`);
  }

  public async listModels(signal?: AbortSignal): Promise<AiModelDescriptor[]> {
    const response = await this.request("/models", { method: "GET", ...(signal ? { signal } : {}) });
    if (!response.ok) throw new Error(`AI model discovery failed (${response.status}).`);
    const payload = await response.json() as { data?: Array<{ id?: string }> };
    return (payload.data ?? []).flatMap((model) => model.id ? [{ ...this.describe(), modelId: model.id }] : []);
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const startedAt = performance.now();
    if (request.taskType === "embedding") {
      const response = await this.request("/embeddings", {
        method: "POST",
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
          model: request.modelId ?? this.options.modelId,
          input: readText(request.input),
          dimensions: typeof request.parameters.dimensions === "number" ? request.parameters.dimensions : 768
        })
      });
      const payload = await parseResponse<{ data?: Array<{ embedding?: number[] }>; usage?: { prompt_tokens?: number; total_tokens?: number } }>(response);
      const embedding = payload.data?.[0]?.embedding;
      if (!embedding) throw new Error("AI embedding response did not contain a vector.");
      return {
        taskType: request.taskType,
        output: embedding,
        providerId: "openai-compatible",
        modelId: request.modelId ?? this.options.modelId,
        runtime: "remote",
        durationMs: Math.round(performance.now() - startedAt),
        ...(payload.usage?.prompt_tokens !== undefined ? { inputTokens: payload.usage.prompt_tokens } : {})
      };
    }
    const response = await this.request("/chat/completions", {
      method: "POST",
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        model: request.modelId ?? this.options.modelId,
        messages: [{ role: "user", content: readText(request.input) }],
        ...(["structured-output", "knowledge-graph-generation", "atomic-note-generation", "reranking"].includes(request.taskType)
          ? { response_format: { type: "json_object" } }
          : {}),
        ...openAiGenerationParameters(request.parameters, request.modelId ?? this.options.modelId)
      })
    });
    const payload = await parseResponse<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>(response);
    const output = payload.choices?.[0]?.message?.content;
    if (output === undefined) throw new Error("AI generation response did not contain content.");
    return {
      taskType: request.taskType,
      output,
      providerId: "openai-compatible",
      modelId: request.modelId ?? this.options.modelId,
      runtime: "remote",
      durationMs: Math.round(performance.now() - startedAt),
      ...(payload.usage?.prompt_tokens !== undefined ? { inputTokens: payload.usage.prompt_tokens } : {}),
      ...(payload.usage?.completion_tokens !== undefined ? { outputTokens: payload.usage.completion_tokens } : {})
    };
  }

  public async runStreaming(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    onProgress: AiProgressListener
  ): Promise<AiTaskResult> {
    if (request.taskType === "embedding") return this.run(request, signal);
    const startedAt = performance.now();
    const response = await this.request("/chat/completions", {
      method: "POST",
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        model: request.modelId ?? this.options.modelId,
        messages: [{ role: "user", content: readText(request.input) }],
        stream: true,
        stream_options: { include_usage: true },
        ...(["structured-output", "knowledge-graph-generation", "atomic-note-generation", "reranking"].includes(request.taskType)
          ? { response_format: { type: "json_object" } }
          : {}),
        ...openAiGenerationParameters(request.parameters, request.modelId ?? this.options.modelId)
      })
    });
    let output = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    await readServerSentEvents(response, (data) => {
      if (data === "[DONE]") return;
      const event = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      output += event.choices?.[0]?.delta?.content ?? "";
      inputTokens = event.usage?.prompt_tokens ?? inputTokens;
      outputTokens = event.usage?.completion_tokens ?? outputTokens;
      onProgress({ progress: streamedProgress(output.length, request.parameters.maxTokens) });
    });
    if (output.length === 0) throw new Error("AI generation response did not contain content.");
    onProgress({ progress: 1 });
    return {
      taskType: request.taskType,
      output,
      providerId: "openai-compatible",
      modelId: request.modelId ?? this.options.modelId,
      runtime: "remote",
      durationMs: Math.round(performance.now() - startedAt),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {})
    };
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImplementation(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` }
    });
  }
}

function openAiGenerationParameters(parameters: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const reasoningLevel = typeof parameters.reasoningLevel === "string"
    ? effectiveReasoningLevel("openai-compatible", modelId, parameters.reasoningLevel as AiReasoningLevel)
    : undefined;
  const reasoningEffort = openAiReasoningEffort(reasoningLevel);
  return {
    ...(typeof parameters.maxTokens === "number" ? { max_tokens: parameters.maxTokens } : {}),
    ...(typeof parameters.temperature === "number" ? { temperature: parameters.temperature } : {}),
    ...(typeof parameters.topP === "number" ? { top_p: parameters.topP } : {}),
    ...(typeof parameters.seed === "number" ? { seed: parameters.seed } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
  };
}

export function readText(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null && "text" in input && typeof input.text === "string") return input.text;
  return JSON.stringify(input);
}

export async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`AI provider request failed (${response.status}).`);
  return await response.json() as T;
}

export async function readServerSentEvents(
  response: Response,
  onData: (data: string) => void,
  maximumBytes?: number
): Promise<void> {
  if (!response.ok) throw new Error(`AI provider request failed (${response.status}).`);
  if (!response.body) throw new Error("AI provider streaming response did not contain a body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    receivedBytes += value?.byteLength ?? 0;
    if (maximumBytes !== undefined && receivedBytes > maximumBytes) {
      await reader.cancel();
      throw new Error("AI provider streaming response exceeded the configured size limit.");
    }
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) onData(data);
    }
    if (done) break;
  }
  const trailing = buffer.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (trailing.length > 0) onData(trailing);
}

export function streamedProgress(outputCharacters: number, configuredMaxTokens: unknown): number {
  const maxTokens = typeof configuredMaxTokens === "number" && configuredMaxTokens > 0 ? configuredMaxTokens : 1_024;
  return Math.min(0.95, Math.max(0.02, outputCharacters / (maxTokens * 4)));
}
