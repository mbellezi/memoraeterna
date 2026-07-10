import type { AiCapability, AiTaskType } from "@app/domain";

import type { AiModelAdapter, AiModelDescriptor, AiTaskRequest, AiTaskResult } from "./contracts.js";

export interface OpenAiCompatibleAdapterOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  capabilities: AiCapability[];
  fetch?: typeof fetch;
}

const generationTasks = new Set<AiTaskType>([
  "text-generation", "structured-output", "summarization", "atomic-note-generation",
  "entity-extraction", "claim-extraction", "reranking", "writing-assistance"
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
        ...(["structured-output", "atomic-note-generation", "reranking"].includes(request.taskType)
          ? { response_format: { type: "json_object" } }
          : {}),
        ...openAiGenerationParameters(request.parameters)
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

  private request(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImplementation(`${this.options.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` }
    });
  }
}

function openAiGenerationParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof parameters.maxTokens === "number" ? { max_tokens: parameters.maxTokens } : {}),
    ...(typeof parameters.temperature === "number" ? { temperature: parameters.temperature } : {}),
    ...(typeof parameters.topP === "number" ? { top_p: parameters.topP } : {}),
    ...(typeof parameters.seed === "number" ? { seed: parameters.seed } : {}),
    ...(typeof parameters.reasoningLevel === "string"
      ? { reasoning_effort: parameters.reasoningLevel === "off" ? "none" : parameters.reasoningLevel }
      : {})
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
