import { normalizeTokenUsage } from "./token-usage.js";
import type { AiCapability, AiReasoningLevel, AiSchemaMode, AiTaskType } from "@app/domain";

import type {
  AiModelAdapter,
  AiModelDescriptor,
  AiProgressListener,
  AiTaskRequest,
  AiTaskResult
} from "./contracts.js";
import {
  isDashScopeBaseUrl,
  isQwen35Model,
  openAiCompatibleParameterCapabilities
} from "./parameter-capabilities.js";
import { providerHttpError, providerStreamError } from "./provider-error.js";
import {
  isLocalEndpoint,
  monotonicProgress,
  resolveAiRuntimeConfig,
  remoteCallTask,
  runRemoteCall,
  withCallReport,
  type AiRuntimeConfig,
  type AiRuntimeConfigInput,
  type RemoteAttempt,
  type RemoteCallOptions,
  type RemoteCallReport,
  type RemoteRequestOptions
} from "./remote-execution.js";
import {
  effectiveReasoningLevel,
  isOpenAiReasoningModel,
  openAiReasoningEffort
} from "./reasoning.js";

/** Whether one request sends its strict schema, and why not when it does not. */
interface ResponseFormatState {
  schema: boolean;
  fallback?: "refused" | "refused_earlier";
}

export interface OpenAiCompatibleAdapterOptions {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  capabilities: AiCapability[];
  fetch?: typeof fetch;
  /** Deadline and retry overrides; the defaults apply to everything left out. */
  runtime?: AiRuntimeConfigInput;
  /** Source of the retry jitter. */
  random?: () => number;
}

/** Endpoints whose server refused `stream_options`: they stream without usage from then on. */
const streamUsageRejected = new Set<string>();

/**
 * Configurations (endpoint and model) whose server refused a `json_schema` response format and then
 * accepted `json_object` (F3 D35). Their later requests of this process send `json_object` at once.
 */
const jsonSchemaRejected = new Set<string>();

/** A 400 or 422 that names the structured response format as the parameter at fault. */
const responseFormatParameter = /\bresponse_format\b|\bjson_schema\b/i;

/** Tasks whose answer is JSON: they ask for at least `json_object`. */
const jsonObjectTasks: ReadonlySet<AiTaskType> = new Set([
  "structured-output",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "reranking"
]);

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

export class OpenAiCompatibleAdapter implements AiModelAdapter {
  private readonly fetchImplementation: typeof fetch;
  private readonly runtime: AiRuntimeConfig;
  private readonly local: boolean;

  public constructor(private readonly options: OpenAiCompatibleAdapterOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.runtime = resolveAiRuntimeConfig(options.runtime);
    this.local = isLocalEndpoint(options.baseUrl);
  }

  public describe(): AiModelDescriptor {
    return {
      providerId: "openai-compatible",
      modelId: this.options.modelId,
      runtime: "remote",
      capabilities: this.options.capabilities,
      parameterCapabilities: openAiCompatibleParameterCapabilities(this.options),
      requirements: { network: true, apiKey: true },
      limits: {}
    };
  }

  public canHandle(request: AiTaskRequest): boolean {
    return request.taskType === "embedding" || generationTasks.has(request.taskType);
  }

  public async testConnection(signal?: AbortSignal): Promise<void> {
    await this.remoteCall({ streaming: false, retry: false, signal }, async (call) => {
      const response = await this.request(call, "/models", { method: "GET" });
      if (!response.ok)
        throw await call.guard(providerHttpError(response, "AI provider connection failed"));
    });
  }

  public async listModels(signal?: AbortSignal): Promise<AiModelDescriptor[]> {
    const payload = await this.remoteCall(
      { streaming: false, retry: false, signal },
      async (call) => {
        const response = await this.request(call, "/models", { method: "GET" });
        if (!response.ok)
          throw await call.guard(providerHttpError(response, "AI model discovery failed"));
        return (await call.guard(response.json())) as {
          data?: Array<{ id?: string; context_window?: number }>;
        };
      }
    );
    return (payload.data ?? []).flatMap((model) =>
      model.id
        ? [
            {
              ...this.describe(),
              modelId: model.id,
              limits:
                Number.isInteger(model.context_window) && model.context_window! > 0
                  ? { contextWindow: model.context_window }
                  : {},
              parameterCapabilities: openAiCompatibleParameterCapabilities({
                ...this.options,
                modelId: model.id
              })
            }
          ]
        : []
    );
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const startedAt = performance.now();
    let report: RemoteCallReport | undefined;
    const reportTo = (received: RemoteCallReport) => {
      report = received;
    };
    if (request.taskType === "embedding") {
      const payload = await this.remoteCall(
        { request, streaming: false, signal, report: reportTo },
        async (call) =>
          parseResponse<{
            data?: Array<{ embedding?: number[] }>;
            usage?: Record<string, unknown> & { prompt_tokens?: number; total_tokens?: number };
          }>(
            await this.request(call, "/embeddings", {
              method: "POST",
              body: JSON.stringify({
                model: request.modelId ?? this.options.modelId,
                input: readText(request.input),
                dimensions:
                  typeof request.parameters.dimensions === "number"
                    ? request.parameters.dimensions
                    : 768
              })
            }),
            call
          )
      );
      const embedding = payload.data?.[0]?.embedding;
      if (!embedding) throw new Error("AI embedding response did not contain a vector.");
      return withCallReport(
        {
          taskType: request.taskType,
          output: embedding,
          providerId: "openai-compatible",
          modelId: request.modelId ?? this.options.modelId,
          runtime: "remote",
          durationMs: Math.round(performance.now() - startedAt),
          tokenUsage: normalizeTokenUsage(payload.usage),
          ...(payload.usage?.prompt_tokens !== undefined
            ? { inputTokens: payload.usage.prompt_tokens }
            : {})
        },
        report
      );
    }
    let schemaMode = this.requestedSchemaMode(request);
    const payload = await this.remoteCall(
      { request, streaming: false, signal, report: reportTo },
      async (call) => {
        const format = this.responseFormat(request);
        const open = () =>
          this.request(
            call,
            "/chat/completions",
            {
              method: "POST",
              body: JSON.stringify(this.generationBody(request, false, true, format))
            },
            this.schemaWireOptions(request, format)
          );
        let response = await open();
        if (format.schema && (response.status === 400 || response.status === 422)) {
          const rejection = await call.guard(providerHttpError(response));
          if (!responseFormatParameter.test(rejection.message)) throw rejection;
          // Fall back once to `json_object`; the next attempts of this call keep it.
          jsonSchemaRejected.add(this.schemaKey(request));
          format.schema = false;
          format.fallback = "refused";
          response = await open();
        }
        schemaMode = format.schema ? "strict" : this.requestedSchemaMode(request);
        return parseResponse<{
          choices?: Array<{ message?: { content?: string } }>;
          usage?: Record<string, unknown> & { prompt_tokens?: number; completion_tokens?: number };
        }>(response, call);
      }
    );
    const output = payload.choices?.[0]?.message?.content;
    if (output === undefined) throw new Error("AI generation response did not contain content.");
    return withCallReport(
      {
        taskType: request.taskType,
        output,
        providerId: "openai-compatible",
        modelId: request.modelId ?? this.options.modelId,
        runtime: "remote",
        durationMs: Math.round(performance.now() - startedAt),
        schemaMode,
        ...(report?.requestOptions ? { requestOptions: report.requestOptions } : {}),
        tokenUsage: normalizeTokenUsage(payload.usage),
        ...(payload.usage?.prompt_tokens !== undefined
          ? { inputTokens: payload.usage.prompt_tokens }
          : {}),
        ...(payload.usage?.completion_tokens !== undefined
          ? { outputTokens: payload.usage.completion_tokens }
          : {})
      },
      report
    );
  }

  public async runStreaming(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    onProgress: AiProgressListener
  ): Promise<AiTaskResult> {
    if (request.taskType === "embedding") return this.run(request, signal);
    const startedAt = performance.now();
    const progress = monotonicProgress(onProgress);
    let report: RemoteCallReport | undefined;
    let schemaMode = this.requestedSchemaMode(request);
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
        const format = this.responseFormat(request);
        let includeUsage = !streamUsageRejected.has(this.options.baseUrl);
        const open = () =>
          this.request(
            call,
            "/chat/completions",
            {
              method: "POST",
              body: JSON.stringify(this.generationBody(request, true, includeUsage, format))
            },
            this.schemaWireOptions(request, format)
          );
        let response = await open();
        // Some OpenAI-compatible servers reject `stream_options` or the `json_schema` response format;
        // ask again without the one that was named and remember it.
        for (
          let fallbacks = 0;
          fallbacks < 2 && (response.status === 400 || response.status === 422);
          fallbacks += 1
        ) {
          const rejection = await call.guard(providerHttpError(response));
          if (format.schema && responseFormatParameter.test(rejection.message)) {
            jsonSchemaRejected.add(this.schemaKey(request));
            format.schema = false;
            format.fallback = "refused";
          } else if (includeUsage && /stream_options|include_usage/i.test(rejection.message)) {
            streamUsageRejected.add(this.options.baseUrl);
            includeUsage = false;
          } else throw rejection;
          response = await open();
        }
        schemaMode = format.schema ? "strict" : this.requestedSchemaMode(request);
        let output = "";
        let tokenUsage: Record<string, number> = {};
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        await readServerSentEvents(
          response,
          (data) => {
            if (data === "[DONE]") return;
            const event = JSON.parse(data) as {
              choices?: Array<{
                delta?: { content?: string | null; reasoning_content?: string; reasoning?: string };
              }>;
              usage?: Record<string, unknown> & {
                prompt_tokens?: number;
                completion_tokens?: number;
              };
              error?: { message?: string; code?: string | number; type?: string };
            };
            if (event.error) throw providerStreamError(event.error);
            const choice = event.choices?.[0]?.delta;
            const delta = choice?.content ?? "";
            if (delta.length > 0) call.progressed("answer");
            else if (choice?.reasoning_content || choice?.reasoning) call.progressed("reasoning");
            output += delta;
            tokenUsage = { ...tokenUsage, ...normalizeTokenUsage(event.usage) };
            call.reportUsage(tokenUsage);
            inputTokens = event.usage?.prompt_tokens ?? inputTokens;
            outputTokens = event.usage?.completion_tokens ?? outputTokens;
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
        providerId: "openai-compatible",
        modelId: request.modelId ?? this.options.modelId,
        runtime: "remote",
        durationMs: Math.round(performance.now() - startedAt),
        schemaMode,
        ...(report?.requestOptions ? { requestOptions: report.requestOptions } : {}),
        tokenUsage: streamed.tokenUsage,
        ...(streamed.inputTokens !== undefined ? { inputTokens: streamed.inputTokens } : {}),
        ...(streamed.outputTokens !== undefined ? { outputTokens: streamed.outputTokens } : {})
      },
      report
    );
  }

  private generationBody(
    request: AiTaskRequest,
    stream: boolean,
    includeUsage = true,
    format: ResponseFormatState = this.responseFormat(request)
  ): Record<string, unknown> {
    const schema = request.outputSchema;
    return {
      model: request.modelId ?? this.options.modelId,
      messages: [{ role: "user", content: readText(request.input) }],
      ...(stream
        ? { stream: true, ...(includeUsage ? { stream_options: { include_usage: true } } : {}) }
        : {}),
      ...(schema && format.schema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: schema.name, schema: schema.schema, strict: schema.strict }
            }
          }
        : schema || jsonObjectTasks.has(request.taskType)
          ? { response_format: { type: "json_object" } }
          : {}),
      ...openAiGenerationParameters(
        request.parameters,
        request.modelId ?? this.options.modelId,
        this.options.baseUrl
      )
    };
  }

  /** The key a refused `json_schema` format is remembered under: the endpoint and the model. */
  private schemaKey(request: AiTaskRequest): string {
    return `${this.options.baseUrl}\u0000${request.modelId ?? this.options.modelId}`;
  }

  /** Whether this request sends its strict schema: not when the configuration refused one before. */
  private responseFormat(request: AiTaskRequest): ResponseFormatState {
    if (!request.outputSchema) return { schema: false };
    return jsonSchemaRejected.has(this.schemaKey(request))
      ? { schema: false, fallback: "refused_earlier" }
      : { schema: true };
  }

  /** The mode of a request that sends no strict schema: JSON tasks ask for `json_object`, others for nothing. */
  private requestedSchemaMode(request: AiTaskRequest): AiSchemaMode {
    return request.outputSchema || jsonObjectTasks.has(request.taskType) ? "json" : "none";
  }

  /** The wire options of a request with a schema, for the audit; none for any other request. */
  private schemaWireOptions(
    request: AiTaskRequest,
    format: ResponseFormatState
  ): RemoteRequestOptions | undefined {
    return request.outputSchema
      ? {
          schemaMode: format.schema ? "strict" : "json",
          ...(format.fallback ? { schemaFallback: format.fallback } : {})
        }
      : undefined;
  }

  private remoteCall<T>(
    options: Omit<RemoteCallOptions, "taskType" | "parameters" | "workloadClass"> & {
      request?: AiTaskRequest;
    },
    attempt: (call: RemoteAttempt) => Promise<T>
  ): Promise<T> {
    const { request, ...call } = options;
    return runRemoteCall(
      { config: this.runtime, random: this.options.random, local: this.local },
      { ...call, ...remoteCallTask(request) },
      attempt
    );
  }

  private request(
    call: RemoteAttempt,
    path: string,
    init: RequestInit,
    wireOptions?: RemoteRequestOptions
  ): Promise<Response> {
    return call.fetch(
      this.fetchImplementation,
      `${this.options.baseUrl.replace(/\/$/, "")}${path}`,
      {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`
        }
      },
      wireOptions
    );
  }
}

function openAiGenerationParameters(
  parameters: Record<string, unknown>,
  modelId: string,
  baseUrl: string
): Record<string, unknown> {
  const reasoningLevel =
    typeof parameters.reasoningLevel === "string"
      ? effectiveReasoningLevel(
          "openai-compatible",
          modelId,
          parameters.reasoningLevel as AiReasoningLevel
        )
      : undefined;
  const reasoningMaxTokens =
    typeof parameters.reasoningMaxTokens === "number" ? parameters.reasoningMaxTokens : undefined;
  const qwenReasoning = qwenGenerationReasoningParameters(
    modelId,
    baseUrl,
    reasoningLevel,
    reasoningMaxTokens
  );
  const reasoningEffort =
    qwenReasoning === undefined && isOpenAiReasoningModel(modelId)
      ? openAiReasoningEffort(reasoningLevel)
      : undefined;
  return {
    ...(typeof parameters.maxTokens === "number" ? { max_tokens: parameters.maxTokens } : {}),
    ...(typeof parameters.temperature === "number" ? { temperature: parameters.temperature } : {}),
    ...(typeof parameters.topP === "number" ? { top_p: parameters.topP } : {}),
    ...(typeof parameters.topK === "number" ? { top_k: parameters.topK } : {}),
    ...(typeof parameters.presencePenalty === "number"
      ? { presence_penalty: parameters.presencePenalty }
      : {}),
    ...(typeof parameters.seed === "number" ? { seed: parameters.seed } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(qwenReasoning ?? {})
  };
}

function qwenGenerationReasoningParameters(
  modelId: string,
  baseUrl: string,
  reasoningLevel: AiReasoningLevel | undefined,
  reasoningMaxTokens: number | undefined
): Record<string, unknown> | undefined {
  if (!isQwen35Model(modelId) || (reasoningLevel === undefined && reasoningMaxTokens === undefined))
    return undefined;
  const enabled = reasoningLevel !== "off";
  if (isDashScopeBaseUrl(baseUrl)) {
    return {
      enable_thinking: enabled,
      ...(enabled && reasoningMaxTokens !== undefined
        ? { thinking_budget: reasoningMaxTokens }
        : {})
    };
  }
  return { chat_template_kwargs: { enable_thinking: enabled } };
}

export function readText(input: unknown): string {
  if (typeof input === "string") return input;
  if (
    typeof input === "object" &&
    input !== null &&
    "text" in input &&
    typeof input.text === "string"
  )
    return input.text;
  return JSON.stringify(input);
}

export async function parseResponse<T>(response: Response, call?: RemoteAttempt): Promise<T> {
  if (!response.ok)
    throw await (call ? call.guard(providerHttpError(response)) : providerHttpError(response));
  return (await (call ? call.guard(response.json()) : response.json())) as T;
}

/**
 * Reads a server-sent-event stream. With `call`, the first chunk ends the first-byte deadline and a
 * pending read ends as soon as the attempt does, so a silent provider cannot hold the execution slot.
 * Bytes, comments and empty data restart nothing: `onData` reports progress through `call.progressed`.
 */
export async function readServerSentEvents(
  response: Response,
  onData: (data: string) => void,
  maximumBytes?: number,
  call?: RemoteAttempt
): Promise<void> {
  if (!response.ok)
    throw await (call ? call.guard(providerHttpError(response)) : providerHttpError(response));
  if (!response.body) throw new Error("AI provider streaming response did not contain a body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await (call ? call.guard(reader.read()) : reader.read());
      if (value?.byteLength) call?.chunkReceived();
      receivedBytes += value?.byteLength ?? 0;
      if (maximumBytes !== undefined && receivedBytes > maximumBytes) {
        throw new Error("AI provider streaming response exceeded the configured size limit.");
      }
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data.length > 0) onData(data);
      }
      if (done) break;
    }
  } catch (error) {
    // Free the connection of an interrupted stream; the original failure is what the caller needs.
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  const trailing = buffer
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (trailing.length > 0) onData(trailing);
}

export function streamedProgress(outputCharacters: number, configuredMaxTokens: unknown): number {
  const maxTokens =
    typeof configuredMaxTokens === "number" && configuredMaxTokens > 0
      ? configuredMaxTokens
      : 1_024;
  return Math.min(0.95, Math.max(0.02, outputCharacters / (maxTokens * 4)));
}
