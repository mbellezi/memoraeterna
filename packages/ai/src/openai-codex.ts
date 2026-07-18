import type { AiCapability, AiReasoningLevel, AiTaskType } from "@app/domain";

import type { AiModelAdapter, AiModelDescriptor, AiProgressListener, AiTaskRequest, AiTaskResult } from "./contracts.js";
import { readServerSentEvents, readText, streamedProgress } from "./openai-compatible.js";
import { openAiCodexParameterCapabilities } from "./parameter-capabilities.js";
import { effectiveReasoningLevel, openAiReasoningEffort } from "./reasoning.js";

export interface OpenAiCodexAdapterOptions {
  accessToken: string;
  accountId: string;
  modelId: string;
  capabilities: AiCapability[];
  baseUrl?: string;
  fetch?: typeof fetch;
}

const defaultBaseUrl = "https://chatgpt.com/backend-api/codex";
const generationTasks = new Set<AiTaskType>([
  "text-generation", "structured-output", "summarization", "atomic-note-generation",
  "entity-extraction", "claim-extraction", "knowledge-graph-generation", "reranking", "writing-assistance"
]);

export class OpenAiCodexAdapter implements AiModelAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly baseUrl: string;

  public constructor(private readonly options: OpenAiCodexAdapterOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, "");
  }

  public describe(): AiModelDescriptor {
    return {
      providerId: "openai-codex",
      modelId: this.options.modelId,
      runtime: "remote",
      capabilities: this.options.capabilities,
      parameterCapabilities: openAiCodexParameterCapabilities(this.options),
      requirements: { network: true, oauth: true },
      limits: {}
    };
  }

  public canHandle(request: AiTaskRequest): boolean {
    return generationTasks.has(request.taskType);
  }

  public async testConnection(signal?: AbortSignal): Promise<void> {
    await this.listModels(signal);
  }

  public async listModels(signal?: AbortSignal): Promise<AiModelDescriptor[]> {
    const response = await this.request(`${this.baseUrl}/models?client_version=1.0.0`, {
      method: "GET",
      ...(signal ? { signal } : {})
    });
    if (!response.ok) throw new Error(`AI model discovery failed (${response.status}).`);
    const payload = await response.json() as {
      models?: Array<{ slug?: string; display_name?: string; visibility?: string; context_window?: number; max_output_tokens?: number }>;
    };
    return (payload.models ?? []).flatMap((model) => {
      if (!model.slug || model.visibility === "hide" || model.visibility === "none") return [];
      const limits = {
        ...(model.context_window !== undefined ? { contextWindow: model.context_window } : {}),
        ...(model.max_output_tokens !== undefined ? { maxTokens: model.max_output_tokens } : {})
      };
      return [{
        ...this.describe(),
        modelId: model.slug,
        parameterCapabilities: openAiCodexParameterCapabilities({
          modelId: model.slug,
          capabilities: this.options.capabilities,
          ...(model.max_output_tokens !== undefined ? { maxOutputTokens: model.max_output_tokens } : {})
        }),
        ...(model.display_name ? { displayName: model.display_name } : {}),
        limits
      }];
    });
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    return this.execute(request, signal);
  }

  public async runStreaming(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    onProgress: AiProgressListener
  ): Promise<AiTaskResult> {
    return this.execute(request, signal, onProgress);
  }

  private async execute(
    request: AiTaskRequest,
    signal?: AbortSignal,
    onProgress?: AiProgressListener
  ): Promise<AiTaskResult> {
    if (!this.canHandle(request)) throw new Error("errors.ai.unsupportedTask");
    const startedAt = performance.now();
    const response = await this.request(`${this.baseUrl}/responses`, {
      method: "POST",
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        model: request.modelId ?? this.options.modelId,
        store: false,
        stream: true,
        instructions: "You are a helpful assistant.",
        input: [{ role: "user", content: [{ type: "input_text", text: readText(request.input) }] }],
        text: { verbosity: "low" },
        include: ["reasoning.encrypted_content"],
        ...codexGenerationParameters(request.parameters, request.modelId ?? this.options.modelId)
      })
    });
    if (!response.ok) throw new Error(`AI provider request failed (${response.status}).`);

    let output = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let streamError: string | undefined;
    await readServerSentEvents(response, (data) => {
      if (data === "[DONE]") return;
      const event = JSON.parse(data) as {
        type?: string;
        delta?: string;
        message?: string;
        error?: { message?: string };
        response?: { error?: { message?: string }; usage?: { input_tokens?: number; output_tokens?: number } };
      };
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        output += event.delta;
        onProgress?.({ progress: streamedProgress(output.length, request.parameters.maxTokens) });
      }
      if (event.type === "error" || event.type === "response.failed") {
        streamError = event.message ?? event.error?.message ?? event.response?.error?.message ?? "AI provider request failed.";
      }
      inputTokens = event.response?.usage?.input_tokens ?? inputTokens;
      outputTokens = event.response?.usage?.output_tokens ?? outputTokens;
    }, 16 * 1024 * 1024);
    if (streamError) throw new Error(streamError);
    if (output.length === 0) throw new Error("AI generation response did not contain content.");
    onProgress?.({ progress: 1 });
    return {
      taskType: request.taskType,
      output,
      providerId: "openai-codex",
      modelId: request.modelId ?? this.options.modelId,
      runtime: "remote",
      durationMs: Math.round(performance.now() - startedAt),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {})
    };
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    return this.fetchImplementation(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        accept: init.method === "POST" ? "text/event-stream" : "application/json",
        authorization: `Bearer ${this.options.accessToken}`,
        "chatgpt-account-id": this.options.accountId,
        "openai-beta": "responses=experimental",
        originator: "memora-eterna",
        "user-agent": "memora-eterna"
      }
    });
  }
}

function codexGenerationParameters(parameters: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const reasoningLevel = typeof parameters.reasoningLevel === "string"
    ? effectiveReasoningLevel("openai-codex", modelId, parameters.reasoningLevel as AiReasoningLevel)
    : undefined;
  const reasoningEffort = openAiReasoningEffort(reasoningLevel);
  return {
    ...(typeof parameters.maxTokens === "number" ? { max_output_tokens: parameters.maxTokens } : {}),
    ...(reasoningEffort ? {
      reasoning: reasoningEffort === "none"
        ? { effort: reasoningEffort }
        : { effort: reasoningEffort, summary: "auto" }
    } : {})
  };
}
