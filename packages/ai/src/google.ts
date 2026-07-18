import type { AiCapability, AiReasoningLevel, AiTaskType } from "@app/domain";

import type { AiModelAdapter, AiModelDescriptor, AiProgressListener, AiTaskRequest, AiTaskResult } from "./contracts.js";
import { googleParameterCapabilities } from "./parameter-capabilities.js";
import { parseResponse, readServerSentEvents, readText, streamedProgress } from "./openai-compatible.js";
import { googleThinkingConfig } from "./reasoning.js";

export interface GoogleGeminiAdapterOptions {
  apiKey: string;
  modelId: string;
  capabilities: AiCapability[];
  baseUrl?: string;
  fetch?: typeof fetch;
}

const generationTasks = new Set<AiTaskType>([
  "text-generation", "structured-output", "summarization", "atomic-note-generation",
  "entity-extraction", "claim-extraction", "knowledge-graph-generation", "reranking", "writing-assistance"
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
      parameterCapabilities: googleParameterCapabilities(this.options),
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
    return (payload.models ?? []).flatMap((model) => {
      if (!model.name) return [];
      const modelId = model.name.replace(/^models\//, "");
      return [{
        ...this.describe(),
        modelId,
        parameterCapabilities: googleParameterCapabilities({ modelId, capabilities: this.options.capabilities }),
        ...(model.displayName ? { displayName: model.displayName } : {})
      }];
    });
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
            ...(["structured-output", "knowledge-graph-generation", "atomic-note-generation", "reranking"].includes(request.taskType)
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

  public async runStreaming(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    onProgress: AiProgressListener
  ): Promise<AiTaskResult> {
    if (request.taskType === "embedding") return this.run(request, signal);
    const startedAt = performance.now();
    const modelId = request.modelId ?? this.options.modelId;
    const response = await this.fetchImplementation(
      `${this.baseUrl}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.options.apiKey)}`,
      {
        method: "POST", ...(signal ? { signal } : {}), headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: readText(request.input) }] }],
          generationConfig: {
            ...(["structured-output", "knowledge-graph-generation", "atomic-note-generation", "reranking"].includes(request.taskType)
              ? { responseMimeType: "application/json" }
              : {}),
            ...googleGenerationParameters(request.parameters, modelId)
          }
        })
      }
    );
    let output = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    await readServerSentEvents(response, (data) => {
      const event = JSON.parse(data) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      output += event.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
      inputTokens = event.usageMetadata?.promptTokenCount ?? inputTokens;
      outputTokens = event.usageMetadata?.candidatesTokenCount ?? outputTokens;
      onProgress({ progress: streamedProgress(output.length, request.parameters.maxTokens) });
    });
    if (output.length === 0) throw new Error("AI generation response did not contain content.");
    onProgress({ progress: 1 });
    return {
      taskType: request.taskType, output, providerId: "google", modelId, runtime: "remote",
      durationMs: Math.round(performance.now() - startedAt),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {})
    };
  }
}

function googleGenerationParameters(parameters: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const thinkingConfig = googleThinkingConfig(
    modelId,
    typeof parameters.reasoningLevel === "string" ? parameters.reasoningLevel as AiReasoningLevel : undefined,
    typeof parameters.reasoningMaxTokens === "number" ? parameters.reasoningMaxTokens : undefined
  );
  return {
    ...(typeof parameters.maxTokens === "number" ? { maxOutputTokens: parameters.maxTokens } : {}),
    ...(typeof parameters.temperature === "number" ? { temperature: parameters.temperature } : {}),
    ...(typeof parameters.topP === "number" ? { topP: parameters.topP } : {}),
    ...(typeof parameters.topK === "number" ? { topK: parameters.topK } : {}),
    ...(typeof parameters.presencePenalty === "number" ? { presencePenalty: parameters.presencePenalty } : {}),
    ...(typeof parameters.seed === "number" ? { seed: parameters.seed } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {})
  };
}
