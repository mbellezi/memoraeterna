import { normalizeTokenUsage } from "./token-usage.js";
import type { AiCapability, AiReasoningLevel, AiSchemaMode, AiTaskType } from "@app/domain";

import type {
  AiEmbedManyOptions,
  AiEmbedManyResult,
  AiModelAdapter,
  AiModelDescriptor,
  AiProgressListener,
  AiTaskRequest,
  AiTaskResult
} from "./contracts.js";
import { embedManyLimits } from "./contracts.js";
import {
  chunkTexts,
  embedManyDimensions,
  embedManyRequest,
  remoteEmbedManyResult,
  type RemoteEmbedPart
} from "./embed-many.js";
import { googleParameterCapabilities } from "./parameter-capabilities.js";
import {
  parseResponse,
  readServerSentEvents,
  readText,
  streamedProgress
} from "./openai-compatible.js";
import { providerHttpError, providerStreamError } from "./provider-error.js";
import { googleThinkingConfig } from "./reasoning.js";
import {
  monotonicProgress,
  resolveAiRuntimeConfig,
  remoteCallTask,
  runRemoteCall,
  withCallReport,
  type AiRuntimeConfig,
  type AiRuntimeConfigInput,
  type RemoteAttempt,
  type RemoteCallOptions,
  type RemoteCallReport
} from "./remote-execution.js";

export interface GoogleGeminiAdapterOptions {
  apiKey: string;
  modelId: string;
  capabilities: AiCapability[];
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Deadline and retry overrides; the defaults apply to everything left out. */
  runtime?: AiRuntimeConfigInput;
  /** Source of the retry jitter. */
  random?: () => number;
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

/** Tasks whose answer is JSON: they ask for the JSON mime type at least. */
const jsonTasks: ReadonlySet<AiTaskType> = new Set([
  "structured-output",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "reranking"
]);

/** How a request asks for structured output: a strict schema, the JSON mime type, or nothing. */
function googleSchemaMode(request: AiTaskRequest): AiSchemaMode {
  return request.outputSchema ? "strict" : jsonTasks.has(request.taskType) ? "json" : "none";
}

export class GoogleGeminiAdapter implements AiModelAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly baseUrl: string;
  private readonly runtime: AiRuntimeConfig;

  public constructor(private readonly options: GoogleGeminiAdapterOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.runtime = resolveAiRuntimeConfig(options.runtime);
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
    await this.remoteCall({ streaming: false, retry: false, signal }, async (call) => {
      const response = await this.get(call, "/models");
      if (!response.ok)
        throw await call.guard(providerHttpError(response, "AI provider connection failed"));
    });
  }

  public async listModels(signal?: AbortSignal): Promise<AiModelDescriptor[]> {
    const payload = await this.remoteCall(
      { streaming: false, retry: false, signal },
      async (call) =>
        parseResponse<{
          models?: Array<{
            name?: string;
            displayName?: string;
            inputTokenLimit?: number;
            outputTokenLimit?: number;
          }>;
        }>(await this.get(call, "/models"), call)
    );
    return (payload.models ?? []).flatMap((model) => {
      if (!model.name) return [];
      const modelId = model.name.replace(/^models\//, "");
      return [
        {
          ...this.describe(),
          modelId,
          limits: {
            ...(Number.isInteger(model.inputTokenLimit) && model.inputTokenLimit! > 0
              ? { inputTokens: model.inputTokenLimit }
              : {}),
            ...(Number.isInteger(model.outputTokenLimit) && model.outputTokenLimit! > 0
              ? { outputTokens: model.outputTokenLimit }
              : {})
          },
          parameterCapabilities: googleParameterCapabilities({
            modelId,
            capabilities: this.options.capabilities
          }),
          ...(model.displayName ? { displayName: model.displayName } : {})
        }
      ];
    });
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const startedAt = performance.now();
    const modelId = request.modelId ?? this.options.modelId;
    let report: RemoteCallReport | undefined;
    const reportTo = (received: RemoteCallReport) => {
      report = received;
    };
    if (request.taskType === "embedding") {
      const payload = await this.remoteCall(
        { request, streaming: false, signal, report: reportTo },
        async (call) =>
          parseResponse<{
            embedding?: { values?: number[] };
            usageMetadata?: Record<string, unknown>;
          }>(
            await this.post(call, `/models/${encodeURIComponent(modelId)}:embedContent`, {
              model: `models/${modelId}`,
              content: { parts: [{ text: readText(request.input) }] },
              outputDimensionality:
                typeof request.parameters.dimensions === "number"
                  ? request.parameters.dimensions
                  : 768
            }),
            call
          )
      );
      if (!payload.embedding?.values)
        throw new Error("AI embedding response did not contain a vector.");
      return withCallReport(
        {
          taskType: request.taskType,
          output: payload.embedding.values,
          providerId: "google",
          modelId,
          runtime: "remote",
          durationMs: Math.round(performance.now() - startedAt),
          tokenUsage: normalizeTokenUsage(payload.usageMetadata, "google")
        },
        report
      );
    }
    const payload = await this.remoteCall(
      { request, streaming: false, signal, report: reportTo },
      async (call) =>
        parseResponse<{
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          usageMetadata?: Record<string, unknown> & {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
          };
        }>(
          await this.post(
            call,
            `/models/${encodeURIComponent(modelId)}:generateContent`,
            this.generationBody(request, modelId)
          ),
          call
        )
    );
    const output = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
    if (output === undefined) throw new Error("AI generation response did not contain content.");
    return withCallReport(
      {
        taskType: request.taskType,
        output,
        providerId: "google",
        modelId,
        runtime: "remote",
        durationMs: Math.round(performance.now() - startedAt),
        schemaMode: googleSchemaMode(request),
        tokenUsage: normalizeTokenUsage(payload.usageMetadata, "google"),
        ...(payload.usageMetadata?.promptTokenCount !== undefined
          ? { inputTokens: payload.usageMetadata.promptTokenCount }
          : {}),
        ...(payload.usageMetadata?.candidatesTokenCount !== undefined
          ? { outputTokens: payload.usageMetadata.candidatesTokenCount }
          : {})
      },
      report
    );
  }

  /**
   * Embeds the texts with `batchEmbedContents`, at most {@link embedManyLimits.perRequest} per
   * request (D37). The response holds one vector per request, in order.
   */
  public async embedMany(
    texts: readonly string[],
    options: AiEmbedManyOptions = {}
  ): Promise<AiEmbedManyResult> {
    const startedAt = performance.now();
    const modelId = options.modelId ?? this.options.modelId;
    const outputDimensionality = embedManyDimensions(options);
    const parts: RemoteEmbedPart[] = [];
    const reports: RemoteCallReport[] = [];
    for (const group of chunkTexts(texts, embedManyLimits.perRequest)) {
      const payload = await this.remoteCall(
        {
          request: embedManyRequest(group[0] ?? "", options),
          streaming: false,
          signal: options.signal,
          report: (received) => reports.push(received)
        },
        async (call) =>
          parseResponse<{
            embeddings?: Array<{ values?: number[] }>;
            usageMetadata?: Record<string, unknown>;
          }>(
            await this.post(call, `/models/${encodeURIComponent(modelId)}:batchEmbedContents`, {
              requests: group.map((text) => ({
                model: `models/${modelId}`,
                content: { parts: [{ text }] },
                outputDimensionality
              }))
            }),
            call
          )
      );
      const embeddings = (payload.embeddings ?? []).flatMap((item) =>
        item.values ? [item.values] : []
      );
      if ((payload.embeddings ?? []).length !== group.length || embeddings.length !== group.length)
        throw new Error("AI embedding response did not contain a vector for every text.");
      parts.push({ embeddings, tokenUsage: normalizeTokenUsage(payload.usageMetadata, "google") });
    }
    return remoteEmbedManyResult({
      providerId: "google",
      modelId,
      durationMs: Math.round(performance.now() - startedAt),
      parts,
      reports
    });
  }

  public async runStreaming(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    onProgress: AiProgressListener
  ): Promise<AiTaskResult> {
    if (request.taskType === "embedding") return this.run(request, signal);
    const startedAt = performance.now();
    const modelId = request.modelId ?? this.options.modelId;
    const progress = monotonicProgress(onProgress);
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
        const response = await this.post(
          call,
          `/models/${encodeURIComponent(modelId)}:streamGenerateContent`,
          this.generationBody(request, modelId),
          "alt=sse"
        );
        let output = "";
        let tokenUsage: Record<string, number> = {};
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        await readServerSentEvents(
          response,
          (data) => {
            const event = JSON.parse(data) as {
              candidates?: Array<{
                content?: { parts?: Array<{ text?: string; thought?: boolean }> };
              }>;
              usageMetadata?: Record<string, unknown> & {
                promptTokenCount?: number;
                candidatesTokenCount?: number;
              };
              error?: { message?: string; code?: number; status?: string };
            };
            if (event.error)
              throw providerStreamError({
                message: event.error.message,
                code: event.error.code,
                type: event.error.status
              });
            // Thought summaries show the model is working, but they are not the answer.
            const parts = event.candidates?.[0]?.content?.parts ?? [];
            const text = parts.map((part) => (part.thought ? "" : (part.text ?? ""))).join("");
            if (text.length > 0) call.progressed("answer");
            else if (parts.some((part) => part.thought && part.text)) call.progressed("reasoning");
            output += text;
            tokenUsage = { ...tokenUsage, ...normalizeTokenUsage(event.usageMetadata, "google") };
            call.reportUsage(tokenUsage);
            inputTokens = event.usageMetadata?.promptTokenCount ?? inputTokens;
            outputTokens = event.usageMetadata?.candidatesTokenCount ?? outputTokens;
            progress({ progress: streamedProgress(output.length, request.parameters.maxTokens) });
          },
          undefined,
          call
        );
        if (output.length === 0) throw new Error("AI generation response did not contain content.");
        return { output, tokenUsage, inputTokens, outputTokens };
      }
    );
    progress({ progress: 1 });
    return withCallReport(
      {
        taskType: request.taskType,
        output: streamed.output,
        providerId: "google",
        modelId,
        runtime: "remote",
        durationMs: Math.round(performance.now() - startedAt),
        schemaMode: googleSchemaMode(request),
        tokenUsage: streamed.tokenUsage,
        ...(streamed.inputTokens !== undefined ? { inputTokens: streamed.inputTokens } : {}),
        ...(streamed.outputTokens !== undefined ? { outputTokens: streamed.outputTokens } : {})
      },
      report
    );
  }

  private generationBody(request: AiTaskRequest, modelId: string): Record<string, unknown> {
    return {
      contents: [{ role: "user", parts: [{ text: readText(request.input) }] }],
      generationConfig: {
        ...(request.outputSchema
          ? {
              responseMimeType: "application/json",
              responseJsonSchema: request.outputSchema.schema
            }
          : jsonTasks.has(request.taskType)
            ? { responseMimeType: "application/json" }
            : {}),
        ...googleGenerationParameters(request.parameters, modelId)
      }
    };
  }

  private remoteCall<T>(
    options: Omit<RemoteCallOptions, "taskType" | "parameters" | "workloadClass"> & {
      request?: AiTaskRequest;
    },
    attempt: (call: RemoteAttempt) => Promise<T>
  ): Promise<T> {
    const { request, ...call } = options;
    return runRemoteCall(
      { config: this.runtime, random: this.options.random },
      { ...call, ...remoteCallTask(request) },
      attempt
    );
  }

  /** The API key travels in the query string, so URLs never appear in errors or logs. */
  private get(call: RemoteAttempt, path: string): Promise<Response> {
    return call.fetch(this.fetchImplementation, this.url(path), {});
  }

  private post(
    call: RemoteAttempt,
    path: string,
    body: Record<string, unknown>,
    query = ""
  ): Promise<Response> {
    return call.fetch(this.fetchImplementation, this.url(path, query), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  private url(path: string, query = ""): string {
    return `${this.baseUrl}${path}?${query ? `${query}&` : ""}key=${encodeURIComponent(this.options.apiKey)}`;
  }
}

function googleGenerationParameters(
  parameters: Record<string, unknown>,
  modelId: string
): Record<string, unknown> {
  const thinkingConfig = googleThinkingConfig(
    modelId,
    typeof parameters.reasoningLevel === "string"
      ? (parameters.reasoningLevel as AiReasoningLevel)
      : undefined,
    typeof parameters.reasoningMaxTokens === "number" ? parameters.reasoningMaxTokens : undefined
  );
  return {
    ...(typeof parameters.maxTokens === "number" ? { maxOutputTokens: parameters.maxTokens } : {}),
    ...(typeof parameters.temperature === "number" ? { temperature: parameters.temperature } : {}),
    ...(typeof parameters.topP === "number" ? { topP: parameters.topP } : {}),
    ...(typeof parameters.topK === "number" ? { topK: parameters.topK } : {}),
    ...(typeof parameters.presencePenalty === "number"
      ? { presencePenalty: parameters.presencePenalty }
      : {}),
    ...(typeof parameters.seed === "number" ? { seed: parameters.seed } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {})
  };
}
