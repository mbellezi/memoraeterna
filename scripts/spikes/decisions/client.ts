/**
 * Small fetch client for `POST https://api.openai.com/v1/decisions` (public beta, model
 * `gpt-6-luna`), written for Spike A2 (no SDK dependency).
 *
 * - HTTPS to one fixed URL, no redirects, bounded response size.
 * - Deadlines counted per attempt: headers (connect + first byte) and total (body included).
 * - Retries only transient failures (network, timeout, 408, 425, 429, 5xx), honoring
 *   `Retry-After`, with exponential backoff and jitter. Auth errors, invalid requests, quota
 *   exhaustion and schema failures are never retried.
 * - The key never leaves this module: every error message and debug record passes through
 *   `redactSecrets`, and `describeRequest` replaces the Authorization header.
 */
import { z } from "zod";

import { redactSecrets } from "./env.js";

export const decisionsUrl = "https://api.openai.com/v1/decisions";
export const decisionsModel = "gpt-6-luna";

// --- Wire schemas (from the Decisions API reference) ----------------------------------------

export interface ChoiceOption {
  value: string;
  description?: string;
}

export type DecisionQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: ChoiceOption[] };

export interface DecisionRequest {
  model: string;
  input: string;
  questions: DecisionQuestion[];
}

const choiceValue = z.union([z.string(), z.boolean()]);

const predicateAnswerSchema = z.object({
  type: z.literal("predicate"),
  name: z.string().nullable(),
  probability: z.number()
});
const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  name: z.string().nullable(),
  choice: choiceValue,
  confidence: z.number(),
  probabilities: z.array(z.object({ value: choiceValue, probability: z.number() }))
});
const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  name: z.string().nullable(),
  score: z.number(),
  confidence: z.number(),
  probabilities: z.array(
    z.object({ value: z.number(), label: z.string(), probability: z.number() })
  )
});
const refusalAnswerSchema = z.object({ type: z.literal("refusal"), name: z.string().nullable() });

export const answerSchema = z.discriminatedUnion("type", [
  predicateAnswerSchema,
  choiceAnswerSchema,
  scoreAnswerSchema,
  refusalAnswerSchema
]);
export type DecisionAnswer = z.infer<typeof answerSchema>;

export const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
  input_tokens_details: z
    .object({ cached_tokens: z.number().optional(), cache_write_tokens: z.number().optional() })
    .optional(),
  output_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).optional()
});
export type DecisionUsage = z.infer<typeof usageSchema>;

const responseSchema = z.object({
  model: z.string(),
  answers: z.array(answerSchema),
  usage: usageSchema
});

// --- Results and errors ----------------------------------------------------------------------

export interface AttemptRecord {
  /** HTTP status, or null when no response arrived (network error, timeout). */
  status: number | null;
  ms: number;
  /** Backoff waited before this attempt. */
  waitedMs: number;
  kind?: ErrorKind;
}

export interface DecisionResult {
  model: string;
  answers: DecisionAnswer[];
  usage: DecisionUsage;
  requestId: string | null;
  /** Wall time of the successful attempt (request start to body read), ms. */
  attemptMs: number;
  /** `openai-processing-ms` when the server reports it. */
  serverMs: number | null;
  /** Wall time including retries and backoff, ms. */
  totalMs: number;
  attempts: AttemptRecord[];
  /** Rate-limit headers only (never credentials). */
  rateLimit: Record<string, string>;
}

export type ErrorKind =
  | "auth"
  | "invalid_request"
  | "quota"
  | "rate_limit"
  | "server"
  | "timeout"
  | "network"
  | "schema"
  | "aborted";

export class DecisionsError extends Error {
  readonly kind: ErrorKind;
  readonly status: number | null;
  readonly attempts: AttemptRecord[];
  constructor(kind: ErrorKind, message: string, status: number | null, attempts: AttemptRecord[]) {
    super(message);
    this.name = "DecisionsError";
    this.kind = kind;
    this.status = status;
    this.attempts = attempts;
  }
}

class AttemptFailure extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null
  ) {
    super(message);
  }
}

// --- Client ----------------------------------------------------------------------------------

export interface DecisionsClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Deadline to receive the response headers (connect + first byte), per attempt. */
  headersTimeoutMs?: number;
  /** Deadline for the whole attempt, body included. */
  totalTimeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Retry-After values above this are not honored; the request fails instead. */
  maxRetryAfterMs?: number;
  maxResponseBytes?: number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Receives redacted events only (never headers or the key). */
  onEvent?:
    | ((event: { kind: "retry"; status: number | null; waitMs: number; attempt: number }) => void)
    | undefined;
}

const retryableStatuses = new Set([408, 425, 429]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

/** `Retry-After` as milliseconds (delta-seconds or HTTP date); null when absent or invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export class DecisionsClient {
  readonly #apiKey: string;
  readonly #options: Required<Omit<DecisionsClientOptions, "apiKey" | "onEvent">> &
    Pick<DecisionsClientOptions, "onEvent">;

  constructor(options: DecisionsClientOptions) {
    this.#apiKey = options.apiKey;
    this.#options = {
      fetchImpl: options.fetchImpl ?? fetch,
      headersTimeoutMs: options.headersTimeoutMs ?? 45_000,
      totalTimeoutMs: options.totalTimeoutMs ?? 90_000,
      maxAttempts: options.maxAttempts ?? 5,
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 20_000,
      maxRetryAfterMs: options.maxRetryAfterMs ?? 60_000,
      maxResponseBytes: options.maxResponseBytes ?? 4_000_000,
      random: options.random ?? Math.random,
      sleep: options.sleep ?? defaultSleep,
      onEvent: options.onEvent
    };
  }

  /** Request description for debugging with the credential replaced. */
  describeRequest(request: DecisionRequest): {
    url: string;
    headers: Record<string, string>;
    questions: number;
    inputChars: number;
  } {
    return {
      url: decisionsUrl,
      headers: { Authorization: "Bearer [REDACTED]", "Content-Type": "application/json" },
      questions: request.questions.length,
      inputChars: request.input.length
    };
  }

  #clean(text: string): string {
    return redactSecrets(text, [this.#apiKey]).slice(0, 400);
  }

  async decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
    const body = JSON.stringify(request);
    const attempts: AttemptRecord[] = [];
    const started = performance.now();
    let waitedMs = 0;
    for (let attempt = 1; ; attempt += 1) {
      const attemptStarted = performance.now();
      try {
        const parsed = await this.#once(body, signal);
        attempts.push({ status: 200, ms: performance.now() - attemptStarted, waitedMs });
        return {
          model: parsed.value.model,
          answers: parsed.value.answers,
          usage: parsed.value.usage,
          requestId: parsed.requestId,
          attemptMs: performance.now() - attemptStarted,
          serverMs: parsed.serverMs,
          totalMs: performance.now() - started,
          attempts,
          rateLimit: parsed.rateLimit
        };
      } catch (error) {
        const failure =
          error instanceof AttemptFailure
            ? error
            : new AttemptFailure(
                signal?.aborted ? "aborted" : "network",
                this.#clean(error instanceof Error ? error.message : "request failed"),
                null,
                !signal?.aborted,
                null
              );
        attempts.push({
          status: failure.status,
          ms: performance.now() - attemptStarted,
          waitedMs,
          kind: failure.kind
        });
        const retryAfter = failure.retryAfterMs;
        const giveUp =
          !failure.retryable ||
          attempt >= this.#options.maxAttempts ||
          (retryAfter !== null && retryAfter > this.#options.maxRetryAfterMs);
        if (giveUp) {
          throw new DecisionsError(failure.kind, failure.message, failure.status, attempts);
        }
        const backoff = Math.min(
          this.#options.maxDelayMs,
          this.#options.baseDelayMs * 2 ** (attempt - 1)
        );
        const jittered = backoff * (0.5 + this.#options.random() * 0.5);
        const wait = retryAfter !== null ? retryAfter + this.#options.random() * 250 : jittered;
        this.#options.onEvent?.({ kind: "retry", status: failure.status, waitMs: wait, attempt });
        try {
          await this.#options.sleep(wait, signal);
        } catch {
          throw new DecisionsError("aborted", "aborted while waiting to retry", null, attempts);
        }
        waitedMs = wait;
      }
    }
  }

  async #once(body: string, outer?: AbortSignal) {
    const { fetchImpl, headersTimeoutMs, totalTimeoutMs, maxResponseBytes } = this.#options;
    const controller = new AbortController();
    const state: { timedOut: "headers" | "total" | null } = { timedOut: null };
    const headersTimer = setTimeout(() => {
      state.timedOut = "headers";
      controller.abort();
    }, headersTimeoutMs);
    const totalTimer = setTimeout(() => {
      state.timedOut = "total";
      controller.abort();
    }, totalTimeoutMs);
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      if (outer?.aborted) throw new AttemptFailure("aborted", "aborted", null, false, null);
      let response: Response;
      try {
        response = await fetchImpl(decisionsUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#apiKey}`,
            "Content-Type": "application/json"
          },
          body,
          redirect: "error",
          signal: controller.signal
        });
      } catch (error) {
        if (outer?.aborted) throw new AttemptFailure("aborted", "aborted", null, false, null);
        if (state.timedOut) {
          throw new AttemptFailure(
            "timeout",
            `${state.timedOut} deadline exceeded`,
            null,
            true,
            null
          );
        }
        throw new AttemptFailure(
          "network",
          this.#clean(error instanceof Error ? error.message : "network error"),
          null,
          true,
          null
        );
      }
      clearTimeout(headersTimer);
      let text: string;
      try {
        text = await readBoundedText(response, maxResponseBytes);
      } catch (error) {
        if (outer?.aborted) throw new AttemptFailure("aborted", "aborted", null, false, null);
        if (state.timedOut) {
          throw new AttemptFailure(
            "timeout",
            `${state.timedOut} deadline exceeded`,
            null,
            true,
            null
          );
        }
        throw new AttemptFailure(
          "network",
          this.#clean(error instanceof Error ? error.message : "body read failed"),
          response.status,
          true,
          null
        );
      }
      if (!response.ok) throw this.#httpFailure(response, text);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AttemptFailure("schema", "response is not JSON", response.status, false, null);
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) {
        throw new AttemptFailure(
          "schema",
          this.#clean(
            `response does not match the schema: ${parsed.error.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join(".")} ${issue.message}`)
              .join("; ")}`
          ),
          response.status,
          false,
          null
        );
      }
      const processing = Number(response.headers.get("openai-processing-ms"));
      const rateLimit: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (name.toLowerCase().startsWith("x-ratelimit-")) rateLimit[name.toLowerCase()] = value;
      });
      return {
        value: parsed.data,
        requestId: response.headers.get("x-request-id"),
        serverMs: Number.isFinite(processing) && processing > 0 ? processing : null,
        rateLimit
      };
    } finally {
      clearTimeout(headersTimer);
      clearTimeout(totalTimer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }

  #httpFailure(response: Response, text: string): AttemptFailure {
    let code = "";
    let message: string;
    try {
      const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error;
      code = typeof error?.code === "string" ? error.code : "";
      message = typeof error?.message === "string" ? error.message : "";
    } catch {
      message = text;
    }
    const status = response.status;
    const detail = this.#clean(`HTTP ${status}${code ? ` ${code}` : ""}: ${message}`);
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    if (status === 401 || status === 403) {
      return new AttemptFailure("auth", detail, status, false, null);
    }
    if (status === 429 && /quota|billing/i.test(code)) {
      return new AttemptFailure("quota", detail, status, false, null);
    }
    if (retryableStatuses.has(status)) {
      return new AttemptFailure("rate_limit", detail, status, true, retryAfter);
    }
    if (status >= 500) return new AttemptFailure("server", detail, status, true, retryAfter);
    return new AttemptFailure("invalid_request", detail, status, false, null);
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
