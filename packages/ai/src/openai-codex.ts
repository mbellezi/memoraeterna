import { normalizeTokenUsage } from "./token-usage.js";
import type { AiCapability, AiReasoningLevel, AiSchemaMode, AiTaskType } from "@app/domain";

import type {
  AiModelAdapter,
  AiModelDescriptor,
  AiProgressListener,
  AiProgressStep,
  AiTaskRequest,
  AiTaskResult
} from "./contracts.js";
import { createTextDeltaStream } from "./contracts.js";
import { readServerSentEvents, readText, streamedProgress } from "./openai-compatible.js";
import { outputSchemaIdentity } from "./output-schema-identity.js";
import { openAiCodexParameterCapabilities } from "./parameter-capabilities.js";
import { providerHttpError, providerStreamError, type AiProviderError } from "./provider-error.js";
import {
  monotonicProgress,
  resolveAiRuntimeConfig,
  remoteCallTask,
  requestWorkloadClass,
  runRemoteCall,
  withCallReport,
  type AiRuntimeConfig,
  type AiRuntimeConfigInput,
  type RemoteAttempt,
  type RemoteCallOptions,
  type RemoteCallReport,
  type RemoteRequestOptions
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

/** The parameter a provider names when it refuses the structured-output format. */
const schemaFormatParameter =
  /\btext\.format\b|\bjson_schema\b|\bresponse_format\b|\binvalid schema\b|(["'`])(?:format|schema)\1/i;

/**
 * Whether a refused request is an invalid-request answer (400 or 422) that names the strict
 * schema format as the parameter at fault. Auth, WAF, transient failures and prompt problems never
 * qualify.
 */
function refusesSchemaFormat(error: AiProviderError): boolean {
  return (
    !error.transient &&
    error.kind === "http" &&
    (error.status === 400 || error.status === 422) &&
    schemaFormatParameter.test(error.message)
  );
}

/**
 * A parameter name of the lean shape as a provider states it, not a word of prose: a path
 * (`reasoning.summary`, `include[0]`, `encrypted_content`), a quoted name (`'include'`) or the name
 * after "parameter".
 */
const leanShapeParameter =
  /\bencrypted_content\b|\breasoning\.summary\b|\binclude\[\d+\]|(["'`])(?:summary|include)\1|\bparam(?:eter)?s?\b\W{1,3}(?:summary|include)\b/i;

/**
 * Whether a refused request is an invalid-request answer (400 or 422) that names the reasoning
 * summary, the `include` list or the encrypted reasoning as the parameter at fault. Auth, WAF and
 * not-found pages, transient failures and a prompt problem never qualify, however their text reads.
 */
function refusesLeanDecideShape(error: AiProviderError): boolean {
  return (
    !error.transient &&
    error.kind === "http" &&
    (error.status === 400 || error.status === 422) &&
    leanShapeParameter.test(error.message)
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
  /**
   * Models this backend refused a decide call for without the reasoning summary and the encrypted
   * reasoning, and then accepted the previous shape. This adapter's later decide calls send them that
   * shape; the memory lives as long as the service keeps the instance (F3 D38), and a changed
   * configuration asks again. A refusal is remembered only once the fallback request is accepted, so a
   * failure that has nothing to do with the shape never costs the lean shape.
   */
  private readonly refusedLeanDecideShapes = new Set<string>();
  /**
   * Strict `text.format` schemas this backend refused for a model and then accepted the same request
   * without (F3 D35), keyed by endpoint, model and schema identity. Later requests with that schema
   * go without it at once; another schema on the same model is still sent (10-25). As with the lean
   * shape, a refusal is remembered only once the request without the schema is accepted.
   */
  private readonly refusedSchemaShapes = new Set<string>();

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
    const progress = onProgress ? monotonicProgress<AiProgressStep>(onProgress) : undefined;
    const textStream = createTextDeltaStream(onProgress);
    const modelId = request.modelId ?? this.options.modelId;
    const decide = requestWorkloadClass(request) === "decide";
    const shapeKey = `${this.baseUrl}\u0000${modelId}`;
    // A refused schema is that schema's own: the model's other contracts keep theirs.
    const schemaKey = request.outputSchema
      ? `${shapeKey}\u0000${outputSchemaIdentity(request.outputSchema)}`
      : shapeKey;
    let report: RemoteCallReport | undefined;
    // This call met a refusal of the lean shape; its later attempts go straight to the full shape.
    let refusedInCall = false;
    // The same for the strict schema format (F3 D35): a refusal is a schema fallback, not a repair.
    let schemaRefusedInCall = false;
    // How the request the backend accepted asked for structured output.
    let schemaMode: AiSchemaMode = "none";
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
        textStream.attempt();
        // A decide call needs no reasoning prose: it is sent without the reasoning summary and,
        // being a single stateless turn (store false), without the encrypted reasoning, unless this
        // backend refused that shape before.
        const refusedBefore = decide && this.refusedLeanDecideShapes.has(shapeKey);
        const known = refusedInCall ? "refused" : refusedBefore ? "refused_earlier" : undefined;
        const schemaKnown = !request.outputSchema
          ? undefined
          : schemaRefusedInCall
            ? "refused"
            : this.refusedSchemaShapes.has(schemaKey)
              ? "refused_earlier"
              : undefined;
        let lean = decide && known === undefined;
        let leanDecideShape = known;
        let withSchema = request.outputSchema !== undefined && schemaKnown === undefined;
        let schemaFallback: "refused" | "refused_earlier" | undefined = schemaKnown;
        // The wire options go with each request, so the audit has them even when the call fails.
        const send = () => {
          const body = codexRequestBody(request, modelId, lean, withSchema);
          schemaMode = withSchema ? "strict" : "none";
          return this.request(
            call,
            `${this.baseUrl}/responses`,
            { method: "POST", body: JSON.stringify(body.payload) },
            {
              ...body.options,
              ...(leanDecideShape ? { leanDecideShape } : {}),
              ...(schemaFallback ? { schemaFallback } : {})
            }
          );
        };
        let response = await send();
        // A refusal names the parameter at fault, so each fallback drops only that one; the next
        // attempt of this call keeps it dropped.
        for (let fallbacks = 0; !response.ok && fallbacks < 2; fallbacks += 1) {
          const failure = await call.guard(providerHttpError(response));
          if (withSchema && refusesSchemaFormat(failure)) {
            withSchema = false;
            schemaRefusedInCall = true;
            schemaFallback = "refused";
          } else if (lean && refusesLeanDecideShape(failure)) {
            // Fall back once to the previous shape.
            lean = false;
            refusedInCall = true;
            leanDecideShape = "refused";
          } else throw failure;
          response = await send();
        }
        if (!response.ok) throw await call.guard(providerHttpError(response));
        // The backend accepted the full shape after it refused the lean one: keep that from now on.
        if (refusedInCall) this.refusedLeanDecideShapes.add(shapeKey);
        if (schemaRefusedInCall) this.refusedSchemaShapes.add(schemaKey);

        let output = "";
        let tokenUsage: Record<string, number> = {};
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        let streamError: AiProviderError | undefined;
        // The reasoning steps this request reported, so a repeated report is not counted again.
        const reasoningSteps = new Set<string>();
        await readServerSentEvents(
          response,
          (data) => {
            if (data === "[DONE]") return;
            const event = JSON.parse(data) as {
              type?: string;
              delta?: string;
              message?: string;
              code?: string;
              output_index?: number;
              item?: { id?: string; type?: string };
              error?: { message?: string; code?: string; type?: string };
              response?: {
                error?: { message?: string; code?: string; type?: string };
                usage?: Record<string, unknown> & { input_tokens?: number; output_tokens?: number };
              };
            };
            if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
              if (event.delta.length > 0) call.progressed("answer");
              output += event.delta;
              textStream.delta(event.delta);
              progress?.({
                progress: streamedProgress(output.length, request.parameters.maxTokens)
              });
            } else if (
              (event.type === "response.reasoning_summary_text.delta" ||
                event.type === "response.reasoning_text.delta") &&
              typeof event.delta === "string" &&
              event.delta.length > 0
            ) {
              call.progressed("reasoning");
            } else if (
              (event.type === "response.output_item.added" ||
                event.type === "response.output_item.done") &&
              event.item?.type === "reasoning"
            ) {
              // A request that asks for no reasoning summary streams no reasoning text: a reasoning
              // item starting or ending is the only sign that the model is still thinking (a step of
              // about 500 tokens each, F4 CODEXSTALLFIX). Each start and each end counts once. Other
              // lifecycle events (created, in_progress, a message item, content and summary parts)
              // and keep-alive comments are not progress.
              const step = `${event.type}\u0000${event.item.id ?? event.output_index ?? ""}`;
              if (!reasoningSteps.has(step)) {
                reasoningSteps.add(step);
                call.progressed("reasoning");
              }
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
        requestOptions: report?.requestOptions ?? {},
        schemaMode,
        tokenUsage: streamed.tokenUsage,
        ...(streamed.inputTokens !== undefined ? { inputTokens: streamed.inputTokens } : {}),
        ...(streamed.outputTokens !== undefined ? { outputTokens: streamed.outputTokens } : {})
      },
      report
    );
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

  private request(
    call: RemoteAttempt,
    url: string,
    init: RequestInit,
    wireOptions?: RemoteRequestOptions
  ): Promise<Response> {
    return call.fetch(
      this.fetchImplementation,
      url,
      {
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
      },
      wireOptions
    );
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
  lean: boolean,
  withSchema = false
): { payload: Record<string, unknown>; options: RemoteRequestOptions } {
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
      text: {
        // A strict schema the backend accepts; the answer is validated by its consumer all the same.
        ...(withSchema && request.outputSchema
          ? {
              format: {
                type: "json_schema",
                name: request.outputSchema.name,
                schema: request.outputSchema.schema,
                strict: request.outputSchema.strict
              }
            }
          : {}),
        verbosity: "low"
      },
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
      include,
      ...(request.outputSchema ? { schemaMode: withSchema ? "strict" : "none" } : {})
    }
  };
}
