import type { AiCapability, AiTaskType } from "@app/domain";

import type { AiModelAdapter, AiModelDescriptor, AiTaskRequest, AiTaskResult } from "./contracts.js";
import { parseResponse, readText } from "./openai-compatible.js";

export interface GoogleGeminiAdapterOptions {
  apiKey: string;
  modelId: string;
  capabilities: AiCapability[];
  baseUrl?: string;
  fetch?: typeof fetch;
}

const generationTasks = new Set<AiTaskType>([
  "text-generation", "structured-output", "summarization", "atomic-note-generation",
  "entity-extraction", "claim-extraction", "reranking", "writing-assistance"
]);

export class GoogleGeminiAdapter implements AiModelAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly baseUrl: string;

  public constructor(private readonly options: GoogleGeminiAdapterOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  public describe(): AiModelDescriptor {
    return {
      providerId: "google",
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
    const response = await this.fetchImplementation(`${this.baseUrl}/models?key=${encodeURIComponent(this.options.apiKey)}`, signal ? { signal } : {});
    if (!response.ok) throw new Error(`AI provider connection failed (${response.status}).`);
  }

  public async listModels(signal?: AbortSignal): Promise<AiModelDescriptor[]> {
    const response = await this.fetchImplementation(`${this.baseUrl}/models?key=${encodeURIComponent(this.options.apiKey)}`, signal ? { signal } : {});
    const payload = await parseResponse<{ models?: Array<{ name?: string; displayName?: string }> }>(response);
    return (payload.models ?? []).flatMap((model) => model.name ? [{
      ...this.describe(), modelId: model.name.replace(/^models\//, ""), ...(model.displayName ? { displayName: model.displayName } : {})
    }] : []);
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const startedAt = performance.now();
    const modelId = request.modelId ?? this.options.modelId;
    if (request.taskType === "embedding") {
      const response = await this.fetchImplementation(
        `${this.baseUrl}/models/${encodeURIComponent(modelId)}:embedContent?key=${encodeURIComponent(this.options.apiKey)}`,
        {
          method: "POST", ...(signal ? { signal } : {}), headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: `models/${modelId}`,
            content: { parts: [{ text: readText(request.input) }] },
            outputDimensionality: typeof request.parameters.dimensions === "number"
              ? request.parameters.dimensions
              : 768
          })
        }
      );
      const payload = await parseResponse<{ embedding?: { values?: number[] } }>(response);
      if (!payload.embedding?.values) throw new Error("AI embedding response did not contain a vector.");
      return { taskType: request.taskType, output: payload.embedding.values, providerId: "google", modelId,
        runtime: "remote", durationMs: Math.round(performance.now() - startedAt) };
    }
    const response = await this.fetchImplementation(
      `${this.baseUrl}/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`,
      {
        method: "POST", ...(signal ? { signal } : {}), headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: readText(request.input) }] }],
          generationConfig: {
            ...(["structured-output", "atomic-note-generation", "reranking"].includes(request.taskType)
              ? { responseMimeType: "application/json" }
              : {}),
            ...googleGenerationParameters(request.parameters, modelId)
          }
        })
      }
    );
    const payload = await parseResponse<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>(response);
    const output = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
    if (output === undefined) throw new Error("AI generation response did not contain content.");
    return {
      taskType: request.taskType, output, providerId: "google", modelId, runtime: "remote",
      durationMs: Math.round(performance.now() - startedAt),
      ...(payload.usageMetadata?.promptTokenCount !== undefined ? { inputTokens: payload.usageMetadata.promptTokenCount } : {}),
      ...(payload.usageMetadata?.candidatesTokenCount !== undefined ? { outputTokens: payload.usageMetadata.candidatesTokenCount } : {})
    };
  }
}

function googleGenerationParameters(parameters: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const reasoningLevel = parameters.reasoningLevel;
  const thinkingConfig = reasoningLevel === "off"
    ? modelId.includes("2.5") ? { thinkingBudget: 0 } : { thinkingLevel: "minimal" }
    : typeof reasoningLevel === "string" ? { thinkingLevel: reasoningLevel } : undefined;
  return {
    ...(typeof parameters.maxTokens === "number" ? { maxOutputTokens: parameters.maxTokens } : {}),
    ...(typeof parameters.temperature === "number" ? { temperature: parameters.temperature } : {}),
    ...(typeof parameters.topP === "number" ? { topP: parameters.topP } : {}),
    ...(typeof parameters.seed === "number" ? { seed: parameters.seed } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {})
  };
}
