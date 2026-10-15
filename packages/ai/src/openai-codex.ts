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
  aiWorkloadClass,
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
const encryptedReasoning = "reasoning.encrypted_content";

/**
 * Backends (base URL and model) that refused a decide call without the reasoning summary and the
 * encrypted reasoning. Decide calls of this process send them the previous request shape.
 */
const refusedLeanDecideShapes = new Set<string>();

/**
 * Whether a refused request names the reasoning summary or the `include` list: a deterministic 4xx
 * about the lean decide shape, not a transient failure or a problem with the prompt.
 */
function refusesLeanDecideShape(error: AiProviderError): boolean {
  return (
    !error.transient &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    /summary|include|encrypted_content/i.test(error.message)
  );
}

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
    const modelId = request.modelId ?? this.options.modelId;
    const decide = aiWorkloadClass(request.taskType) === "decide";
    const shapeKey = `${this.baseUrl}\u0000${modelId}`;
    let requestOptions: Record<string, string | string[] | null> = {};
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
        // A decide call needs no reasoning prose: it is sent without the reasoning summary and,
        // being a single stateless turn (store false), without the encrypted reasoning, unless this
        // backend refused that shape before.
        const refusedBefore = decide && refusedLeanDecideShapes.has(shapeKey);
        const send = (lean: boolean) => {
          const body = codexRequestBody(request, modelId, lean);
          requestOptions = body.options;
          return this.request(call, `${this.baseUrl}/responses`, {
            method: "POST",
            body: JSON.stringify(body.payload)
          });
        };
        let response = await send(decide && !refusedBefore);
        if (!response.ok) {
          const failure = await call.guard(providerHttpError(response));
          if (!decide || refusedBefore || !refusesLeanDecideShape(failure)) throw failure;
          // Fall back once to the previous shape and keep it for this backend from now on.
          refusedLeanDecideShapes.add(shapeKey);
          response = await send(false);
          requestOptions = { ...requestOptions, leanDecideShape: "refused" };
          if (!response.ok) throw await call.guard(providerHttpError(response));
        } else if (refusedBefore) {
          requestOptions = { ...requestOptions, leanDecideShape: "refused_earlier" };
        }

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
              if (event.delta.length > 0) call.progressed("answer");
              output += event.delta;
              progress?.({
                progress: streamedProgress(output.length, request.parameters.maxTokens)
              });
            } else if (
              (event.type === "response.reasoning_summary_text.delta" ||
                event.type === "response.reasoning_text.delta") &&
              typeof event.delta === "string" &&
              event.delta.length > 0
            ) {
              // Lifecycle events (created, in_progress, output_item.added, ...) are not progress.
              call.progressed("reasoning");
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
        modelId,
        runtime: "remote",
        durationMs: Math.round(performance.now() - startedAt),
        requestOptions,
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

/**
 * The Responses request and the wire options the audit records for it. The lean shape (decide calls)
 * asks for neither the reasoning summary nor the encrypted reasoning; the full shape is the previous
 * request: the encrypted reasoning always, and the summary whenever the request reasons.
 */
function codexRequestBody(
  request: AiTaskRequest,
  modelId: string,
  lean: boolean
): { payload: Record<string, unknown>; options: Record<string, string | string[] | null> } {
  const reasoningLevel =
    typeof request.parameters.reasoningLevel === "string"
      ? effectiveReasoningLevel(
          "openai-codex",
          modelId,
          request.parameters.reasoningLevel as AiReasoningLevel
        )
      : undefined;
  const reasoningEffort = openAiReasoningEffort(reasoningLevel);
  const summary = !lean && reasoningEffort && reasoningEffort !== "none" ? "auto" : undefined;
  const include = lean ? [] : [encryptedReasoning];
  return {
    payload: {
      model: modelId,
      store: false,
      stream: true,
      instructions:
        typeof request.metadata.applicationInstruction === "string"
          ? request.metadata.applicationInstruction
          : "",
      input: [{ role: "user", content: [{ type: "input_text", text: readText(request.input) }] }],
      text: { verbosity: "low" },
      ...(include.length > 0 ? { include } : {}),
      ...(reasoningEffort
        ? {
            reasoning: summary ? { effort: reasoningEffort, summary } : { effort: reasoningEffort }
          }
        : {})
    },
    options: {
      reasoningEffort: reasoningEffort ?? null,
      reasoningSummary: summary ?? null,
      include
    }
  };
}
