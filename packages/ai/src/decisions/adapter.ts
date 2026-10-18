import type {
  AiModelAdapter,
  AiModelDescriptor,
  AiTaskRequest,
  AiTaskResult
} from "../contracts.js";
import { AiProviderError, isTransientAiError, providerHttpError } from "../provider-error.js";
import {
  remoteCallTask,
  runRemoteCall,
  withCallReport,
  type AiRuntimeConfig,
  type RemoteAttempt,
  type RemoteCallReport
} from "../remote-execution.js";
import { ProviderUnavailableError } from "../scheduler/breaker.js";
import { normalizeTokenUsage } from "../token-usage.js";
import {
  buildDecisionsWireRequest,
  decisionsResponseSchema,
  readDecisionsAnswers,
  readDecisionsTaskInput
} from "./design.js";
import {
  decisionsCostUsd,
  decisionsRuntimeConfig,
  defaultDecisionsLimits,
  type DecisionsLimits
} from "./limits.js";
import type { DecisionsFallbackReason } from "@app/domain";

export interface OpenAiDecisionsAdapterOptions {
  /** The OpenAI Platform key, read for each request; it never leaves this module. */
  apiKey: () => string | Promise<string>;
  limits?: DecisionsLimits;
  /** Replaces `fetch` (tests). */
  fetch?: typeof fetch;
  /** Source of the backoff jitter; tests inject a fixed one. */
  random?: () => number;
  /**
   * Awaited before every attempt of a request after the first (the first runs under the caller's
   * own check): a retry is a new send, so the caller can refuse it, for instance because the person
   * turned the decider off while the request waited out a backoff. Throwing ends the request with
   * that error and sends nothing more; it is never retried.
   */
  beforeRetry?: (attempt: number) => void | Promise<void>;
}

/**
 * The OpenAI Decisions API as an `AiModelAdapter` (F3 plan decision 30): one `reranking` task is one
 * `POST /v1/decisions` request carrying one query note and its candidates (see `design.ts`), and its
 * output is the predicate probability of every candidate, in the order they were sent. It runs under
 * the shared remote-call machinery: its own deadline, bounded jittered retries of 408, 425, 429, 5xx
 * and network failures honoring `Retry-After`, the lane's permit (a backoff gives the lane up), no
 * redirects, a bounded response, and the key redacted from every error. Cost is computed from the
 * reported input tokens at the typed price; output tokens are free.
 */
export class OpenAiDecisionsAdapter implements AiModelAdapter {
  private readonly limits: DecisionsLimits;
  private readonly runtime: AiRuntimeConfig;
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly options: OpenAiDecisionsAdapterOptions) {
    this.limits = options.limits ?? defaultDecisionsLimits;
    this.runtime = decisionsRuntimeConfig(this.limits);
    this.fetchImplementation = options.fetch ?? fetch;
  }

  public describe(): AiModelDescriptor {
    return {
      providerId: this.limits.providerId,
      modelId: this.limits.model,
      runtime: "remote",
      capabilities: ["reranking", "requires-api-key", "requires-network"],
      parameterCapabilities: {},
      displayName: "OpenAI Decisions",
      limits: { maxCandidatesPerRequest: this.limits.maxCandidatesPerRequest },
      requirements: { adapter: "openai-decisions" }
    };
  }

  public canHandle(request: AiTaskRequest): boolean {
    return request.taskType === "reranking" && readDecisionsTaskInput(request.input) !== null;
  }

  public async run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult> {
    const input = readDecisionsTaskInput(request.input);
    if (!input || input.candidates.length > this.limits.maxCandidatesPerRequest)
      throw new Error("errors.ai.unsupportedTask");
    const body = JSON.stringify(buildDecisionsWireRequest(input, this.limits.model));
    const startedAt = performance.now();
    let report: RemoteCallReport | undefined;
    let key = "";
    try {
      key = await this.options.apiKey();
      let attempts = 0;
      const payload = await runRemoteCall(
        { config: this.runtime, random: this.options.random, local: false },
        {
          ...remoteCallTask(request),
          signal,
          streaming: false,
          report: (received) => {
            report = received;
          }
        },
        async (call) => {
          attempts += 1;
          if (attempts > 1) await this.options.beforeRetry?.(attempts);
          return this.attempt(call, body, key);
        }
      );
      const inputTokens = Math.round(payload.usage.input_tokens);
      return withCallReport(
        {
          taskType: "reranking",
          output: { probabilities: readDecisionsAnswers(payload.answers, input.candidates.length) },
          providerId: this.limits.providerId,
          modelId: this.limits.model,
          runtime: "remote",
          durationMs: Math.round(performance.now() - startedAt),
          inputTokens,
          ...(payload.usage.output_tokens !== undefined
            ? { outputTokens: Math.round(payload.usage.output_tokens) }
            : {}),
          tokenUsage: normalizeTokenUsage(payload.usage),
          costEstimate: decisionsCostUsd(inputTokens, this.limits)
        },
        report
      );
    } catch (error) {
      throw cleanDecisionsError(error, key);
    }
  }

  /** The adapter's one-request attempt; the shared machinery retries it. */
  private async attempt(call: RemoteAttempt, body: string, key: string) {
    const response = await call.fetch(this.fetchImplementation, this.limits.url, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
      redirect: "error"
    });
    if (!response.ok)
      throw await call.guard(providerHttpError(response, "Decisions request failed"));
    const text = await call.guard(readBoundedText(response, this.limits.maxResponseBytes));
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiProviderError("The Decisions response is not JSON.", {
        kind: "http",
        transient: false,
        status: response.status
      });
    }
    const parsed = decisionsResponseSchema.safeParse(json);
    if (!parsed.success)
      throw new AiProviderError("The Decisions response does not match its schema.", {
        kind: "http",
        transient: false,
        status: response.status
      });
    return parsed.data;
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Replaces a known key and anything key-shaped in a text. */
export function redactDecisionsSecrets(text: string, key = ""): string {
  let result = text;
  if (key.length >= 8) result = result.split(key).join("[redacted]");
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]");
}

/** The error with its message cleaned; one that held no secret is returned as it is. */
export function cleanDecisionsError(error: unknown, key = ""): unknown {
  if (!(error instanceof Error)) return error;
  const message = redactDecisionsSecrets(error.message, key);
  if (message === error.message) return error;
  if (error instanceof AiProviderError)
    return new AiProviderError(message, {
      kind: error.kind,
      transient: error.transient,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error.code !== undefined ? { code: error.code } : {})
    });
  return new Error(message);
}

/**
 * Why the Decisions decider failed, for the fallback to the local ranker: its lane's breaker is
 * open, the provider refused the key (401, 403), its billing quota is exhausted (a 429 that does not
 * clear), a transient failure outlasted the retries (network), or another failure. A missing
 * credential is `no_key`.
 */
export function classifyDecisionsFailure(error: unknown): DecisionsFallbackReason {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof ProviderUnavailableError) return "breaker_open";
    if (current instanceof AiProviderError) {
      if (current.status === 401 || current.status === 403) return "invalid_key";
      if (current.status === 429 && !current.transient) return "quota";
      return current.transient ? "network" : "error";
    }
    if (current instanceof Error && current.message === "errors.ai.missingCredential")
      return "no_key";
    current = (current as { cause?: unknown }).cause;
  }
  return isTransientAiError(error) ? "network" : "error";
}
