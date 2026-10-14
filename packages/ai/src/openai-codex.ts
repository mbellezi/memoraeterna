import { normalizeTokenUsage } from "./token-usage.js";
import type { AiCapability, AiReasoningLevel, AiTaskType } from "@app/domain";

import type {
  AiModelAdapter,
  AiModelDescriptor,
  AiProgressListener,
  AiTaskRequest,
  AiTaskResult
} from "./contracts.js";
import { readServerSentEvents, readText, streamedProgress } from "./openai-compatible.js";
import { openAiCodexParameterCapabilities } from "./parameter-capabilities.js";
import { providerHttpError, providerStreamError, type AiProviderError } from "./provider-error.js";
import {
  monotonicProgress,
  resolveAiRuntimeConfig,
  runRemoteCall,
  withCallReport,
  type AiRuntimeConfig,
  type AiRuntimeConfigInput,
  type RemoteAttempt,
  type RemoteCallOptions,
  type RemoteCallReport
} from "./remote-execution.js";
import { effectiveReasoningLevel, openAiReasoningEffort } from "./reasoning.js";

export interface OpenAiCodexAdapterOptions {
  accessToken: string;
  accountId: string;
  modelId: string;
  capabilities: AiCapability[];
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Deadline and retry overrides; the defaults apply to everything left out. */
  runtime?: AiRuntimeConfigInput;
  /** Source of the retry jitter. */
  random?: () => number;
}

const defaultBaseUrl = "https://chatgpt.com/backend-api/codex";
const generationTasks = new Set<AiTaskType>([
  "text-generation",
  "structured-output",
  "summarization",
  "atomic-note-generation",
  "entity-extraction",
  "claim-extraction",
  "knowledge-graph-generation",
  "reranking",
  "writing-assistance"
]);

export class OpenAiCodexAdapter implements AiModelAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly baseUrl: string;
  private readonly runtime: AiRuntimeConfig;

  public constructor(private readonly options: OpenAiCodexAdapterOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl).replace(/\/$/, "");
    this.runtime = resolveAiRuntimeConfig(options.runtime);
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
    const payload = await this.remoteCall(
      { streaming: false, retry: false, signal },
      async (call) => {
        const response = await this.request(call, `${this.baseUrl}/models?client_version=1.0.0`, {
          method: "GET"
        });
        if (!response.ok)
          throw await call.guard(providerHttpError(response, "AI model discovery failed"));
        return (await call.guard(response.json())) as {
          models?: Array<{
            slug?: string;
            display_name?: string;
            visibility?: string;
            context_window?: number;
            max_output_tokens?: number;
          }>;
        };
      }
    );
    return (payload.models ?? []).flatMap((model) => {
      if (!model.slug || model.visibility === "hide" || model.visibility === "none") return [];
      const limits = {
        ...(model.context_window !== undefined ? { contextWindow: model.context_window } : {}),
        ...(model.max_output_tokens !== undefined ? { maxTokens: model.max_output_tokens } : {})
      };
      return [
        {
          ...this.describe(),
          modelId: model.slug,
          parameterCapabilities: openAiCodexParameterCapabilities({
            modelId: model.slug,
            capabilities: this.options.capabilities
          }),
          ...(model.display_name ? { displayName: model.display_name } : {}),
          limits
        }
      ];
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
    const progress = onProgress ? monotonicProgress(onProgress) : undefined;
    let report: RemoteCallReport | undefined;
    const streamed = await this.remoteCall(
      {
        request,
        streaming: true,
        signal,
        report: (received) => {
          report = received;
        }
      },
      async (call) => {
        const response = await this.request(call, `${this.baseUrl}/responses`, {
          method: "POST",
          body: JSON.stringify({
            model: request.modelId ?? this.options.modelId,
            store: false,
            stream: true,
            instructions:
              typeof request.metadata.applicationInstruction === "string"
                ? request.metadata.applicationInstruction
                : "",
            input: [
              { role: "user", content: [{ type: "input_text", text: readText(request.input) }] }
            ],
            text: { verbosity: "low" },
            include: ["reasoning.encrypted_content"],
            ...codexGenerationParameters(
              request.parameters,
              request.modelId ?? this.options.modelId
            )
          })
        });
        if (!response.ok) throw await call.guard(providerHttpError(response));

        let output = "";
        let tokenUsage: Record<string, number> = {};
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        let streamError: AiProviderError | undefined;
        await readServerSentEvents(
          response,
          (data) => {
            if (data === "[DONE]") return;
            const event = JSON.parse(data) as {
              type?: string;
              delta?: string;
              message?: string;
              code?: string;
              error?: { message?: string; code?: string; type?: string };
              response?: {
                error?: { message?: string; code?: string; type?: string };
                usage?: Record<string, unknown> & { input_tokens?: number; output_tokens?: number };
              };
            };
            if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
              if (event.delta.length > 0) call.outputStarted();
              output += event.delta;
              progress?.({
                progress: streamedProgress(output.length, request.parameters.maxTokens)
              });
            }
            if (event.type === "error" || event.type === "response.failed") {
              const failure = event.error ?? event.response?.error;
              streamError = providerStreamError({
                message: event.message ?? failure?.message,
                code: event.code ?? failure?.code,
                type: failure?.type
              });
            }
            tokenUsage = { ...tokenUsage, ...normalizeTokenUsage(event.response?.usage) };
            call.reportUsage(tokenUsage);
            inputTokens = event.response?.usage?.input_tokens ?? inputTokens;
            outputTokens = event.response?.usage?.output_tokens ?? outputTokens;
          },
          16 * 1024 * 1024,
          call
        );
        if (streamError) throw streamError;
        if (output.length === 0) throw new Error("AI generation response did not contain content.");
        return { output, tokenUsage, inputTokens, outputTokens };
      }
    );
    progress?.({ progress: 1 });
    return withCallReport(
      {
        taskType: request.taskType,
        output: streamed.output,
        providerId: "openai-codex",
        modelId: request.modelId ?? this.options.modelId,
        runtime: "remote",
        durationMs: Math.round(performance.now() - startedAt),
        tokenUsage: streamed.tokenUsage,
        ...(streamed.inputTokens !== undefined ? { inputTokens: streamed.inputTokens } : {}),
        ...(streamed.outputTokens !== undefined ? { outputTokens: streamed.outputTokens } : {})
      },
      report
    );
  }

  private remoteCall<T>(
    options: Omit<RemoteCallOptions, "taskType" | "parameters"> & { request?: AiTaskRequest },
    attempt: (call: RemoteAttempt) => Promise<T>
  ): Promise<T> {
    const { request, ...call } = options;
    return runRemoteCall(
      { config: this.runtime, random: this.options.random },
      { ...call, taskType: request?.taskType, parameters: request?.parameters },
      attempt
    );
  }

  private request(call: RemoteAttempt, url: string, init: RequestInit): Promise<Response> {
    return call.fetch(this.fetchImplementation, url, {
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

function codexGenerationParameters(
  parameters: Record<string, unknown>,
  modelId: string
): Record<string, unknown> {
  const reasoningLevel =
    typeof parameters.reasoningLevel === "string"
      ? effectiveReasoningLevel(
          "openai-codex",
          modelId,
          parameters.reasoningLevel as AiReasoningLevel
        )
      : undefined;
  const reasoningEffort = openAiReasoningEffort(reasoningLevel);
  return {
    ...(reasoningEffort
      ? {
          reasoning:
            reasoningEffort === "none"
              ? { effort: reasoningEffort }
              : { effort: reasoningEffort, summary: "auto" }
        }
      : {})
  };
}
