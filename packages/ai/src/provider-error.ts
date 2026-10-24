import { redactSensitiveText } from "./local-model-downloader.js";
import type { LaneFailureKind } from "./scheduler/types.js";

/**
 * Why a remote AI call failed. Only `transient` failures are retried (by the adapter, then by the job
 * supervisor); everything else is deterministic and surfaces with its real error.
 */
export type AiProviderErrorKind =
  "timeout" | "stalled" | "network" | "http" | "stream" | "context_overflow";

export interface AiProviderErrorDetails {
  kind: AiProviderErrorKind;
  /** Retrying the same request can succeed: timeouts, 408, 425, 429, 5xx, transport failures, stalls. */
  transient: boolean;
  status?: number;
  /** Delay requested by the provider (`Retry-After`, a retry delay or reset time in the body), in milliseconds. */
  retryAfterMs?: number;
  /** Provider error code reported inside a stream or response body. */
  code?: string;
}

/** A classified failure of a remote AI provider. Its message never contains credentials or URLs. */
export class AiProviderError extends Error {
  public readonly kind: AiProviderErrorKind;
  public readonly transient: boolean;
  public readonly status: number | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly code: string | undefined;

  public constructor(message: string, details: AiProviderErrorDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = "AiProviderError";
    this.kind = details.kind;
    this.transient = details.transient;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.code = details.code;
  }
}

const maximumRetryAfterMs = 60 * 60_000;
const contextOverflowPattern =
  /context[_ ](?:length|window)|maximum context|too many tokens|token limit|prompt is too long|input token count|exceeds the (?:maximum|model)/i;
/**
 * Exhausted billing quota never recovers by waiting. "Exceeded your current quota" is not listed: Gemini
 * says it for per-minute limits that clear within seconds.
 */
const exhaustedQuotaPattern = /insufficient_quota|billing[_ ]hard[_ ]limit|credit balance/i;
/** Where a rate-limited provider states how long to wait when it sends no `Retry-After` header. */
const bodyRetryDelayPatterns = [
  // Google RetryInfo: "retryDelay": "32s".
  /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i,
  // Google messages: "Please retry in 32.4s."
  /\bretry in (\d+(?:\.\d+)?)\s*s\b/i,
  // ChatGPT plan limits (usage_limit_reached): "resets_in_seconds": 3600.
  /"resets_in_seconds"\s*:\s*(\d+(?:\.\d+)?)/i
];

const transientSystemCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED"
]);
const permanentStreamCodes = new Set([
  "context_length_exceeded",
  "invalid_prompt",
  "invalid_request_error",
  "invalid_argument",
  "insufficient_quota",
  "content_filter",
  "permission_denied",
  "unauthenticated",
  "not_found"
]);

export async function providerHttpError(
  response: Response,
  message = "AI provider request failed"
): Promise<AiProviderError> {
  let rawText = "";
  try {
    rawText = (await response.text()).trim();
  } catch {
    // The HTTP status remains useful when the response body cannot be read.
  }
  const responseText = redactSensitiveText(rawText);
  const summary = `${message} (${response.status}).`;
  const classification = classifyHttpFailure(response.status, rawText);
  // The header wins over a delay stated in the body.
  const retryAfterMs = retryAfterMilliseconds(response.headers) ?? classification.retryAfterMs;
  return new AiProviderError(responseText.length > 0 ? `${summary}\n${responseText}` : summary, {
    kind: classification.kind,
    transient: classification.transient,
    status: response.status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  });
}

/**
 * 408, 425, 429 and 5xx are transient; 400, 401, 403, 404, 413, context overflow and an exhausted
 * billing quota are not. A rate limit that states its reset in the body carries it as `retryAfterMs`.
 */
export function classifyHttpFailure(
  status: number,
  body = ""
): Pick<AiProviderErrorDetails, "kind" | "transient" | "retryAfterMs"> {
  if ((status === 400 || status === 413 || status === 422) && contextOverflowPattern.test(body))
    return { kind: "context_overflow", transient: false };
  if (status === 429) {
    if (exhaustedQuotaPattern.test(body)) return { kind: "http", transient: false };
    const retryAfterMs = retryDelayFromText(body);
    return {
      kind: "http",
      transient: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
    };
  }
  return { kind: "http", transient: status === 408 || status === 425 || status >= 500 };
}

/** The wait a rate-limit message or body states, in milliseconds; undefined when it names none. */
export function retryDelayFromText(text: string): number | undefined {
  for (const pattern of bodyRetryDelayPatterns) {
    const seconds = Number(pattern.exec(text)?.[1]);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(Math.round(seconds * 1_000), maximumRetryAfterMs);
  }
  return undefined;
}

/** Reads `retry-after-ms` or `Retry-After` (seconds or an HTTP date); undefined when absent or invalid. */
export function retryAfterMilliseconds(
  headers: Pick<Headers, "get">,
  now: number = Date.now()
): number | undefined {
  const rawMilliseconds = headers.get("retry-after-ms")?.trim();
  if (rawMilliseconds) {
    const milliseconds = Number(rawMilliseconds);
    if (Number.isFinite(milliseconds) && milliseconds >= 0)
      return Math.min(Math.round(milliseconds), maximumRetryAfterMs);
  }
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value))
    return Math.min(Math.round(Number(value) * 1_000), maximumRetryAfterMs);
  // An HTTP date names a month; Date.parse would otherwise accept numbers such as "-3".
  const date = /[a-z]/i.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - now), maximumRetryAfterMs);
}

/** Maps an error reported inside a response stream to a classified error. */
export function providerStreamError(event: {
  message?: string | undefined;
  code?: string | number | undefined;
  type?: string | undefined;
  status?: number | undefined;
}): AiProviderError {
  const text = event.message?.trim() || "AI provider request failed.";
  const names = [event.code, event.type, event.status]
    .filter((value) => value !== undefined)
    .map((value) => String(value).toLowerCase());
  const status = [event.status, event.code].find((value) => typeof value === "number");
  const code = names.find((value) => !/^\d+$/.test(value));
  const evidence = `${names.join(" ")} ${text}`;
  const overflow = contextOverflowPattern.test(evidence);
  // Without positive evidence of a deterministic failure the provider is assumed to have hiccuped.
  const permanent =
    overflow ||
    exhaustedQuotaPattern.test(evidence) ||
    names.some((value) => permanentStreamCodes.has(value)) ||
    (status !== undefined && !classifyHttpFailure(status, text).transient);
  const retryAfterMs = permanent ? undefined : retryDelayFromText(text);
  return new AiProviderError(redactSensitiveText(text), {
    kind: overflow ? "context_overflow" : "stream",
    transient: !permanent,
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
  });
}

/** Whether retrying the failed operation can succeed: typed provider errors, timeouts and transport failures. */
export function isTransientAiError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (current instanceof AiProviderError) return current.transient;
    if (isTransientSystemError(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Transport failures that say the network, not the provider, did not answer (F4 D27). */
const unreachableSystemCodes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH"
]);

/**
 * How a failed call tells the lane its provider failed (F4 D27, the Activity status): a refused
 * credential (401, 403), an unreachable network (DNS and routing codes), any other transient
 * failure as the provider not answering; undefined for a failure that proves the provider answered
 * (a rejected request, a context overflow).
 */
export function providerFailureKind(error: unknown): LaneFailureKind | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (current instanceof AiProviderError) {
      if (current.status === 401 || current.status === 403) return "unauthorized";
      // A rate limit is an answer: the lane pauses for it, the provider is reachable.
      if (current.status === 429) return undefined;
      if (current.kind === "network" && current.code && unreachableSystemCodes.has(current.code))
        return "unreachable";
      return current.transient ? "unavailable" : undefined;
    }
    if (isTransientSystemError(current)) {
      const code = systemErrorCode(current);
      return code && unreachableSystemCodes.has(code) ? "unreachable" : "unavailable";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Transport failures before a connection existed: DNS and routing, a refused connection, the HTTP
 * client's connect deadline. None of the request reached the provider.
 */
const connectFailureCodes = new Set([
  ...unreachableSystemCodes,
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT"
]);

/**
 * Whether a call failed before it reached its provider (F4 D7, D14): a transport failure while
 * connecting, so nothing was sent and nothing can be billed. A reset, a closed socket or a cut
 * stream may come after the request was sent (and again for the same request), so it is not one.
 */
export function isConnectFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (current instanceof AiProviderError)
      return current.kind === "network" && connectFailureCodes.has(current.code ?? "");
    if (isTransientSystemError(current))
      return connectFailureCodes.has(systemErrorCode(current) ?? "");
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The delay a failed operation asks for before it is tried again, when the provider named one. */
export function aiErrorRetryAfterMs(error: unknown): number | undefined {
  for (let depth = 0; depth < 5 && error !== undefined && error !== null; depth++) {
    if (error instanceof AiProviderError) return error.retryAfterMs;
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Wraps a transport failure (reset, refused, DNS, undici socket errors) as a transient provider error;
 * any other error, including invalid requests, is returned unchanged.
 */
export function toProviderNetworkError(error: unknown): unknown {
  if (error instanceof AiProviderError || !isTransientSystemError(error)) return error;
  const code = systemErrorCode(error);
  return new AiProviderError(
    `AI provider connection failed${code ? ` (${code})` : ""}.`,
    { kind: "network", transient: true, ...(code ? { code } : {}) },
    { cause: error }
  );
}

function systemErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && transientSystemCodes.has(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isTransientSystemError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  if (systemErrorCode(error) !== undefined) return true;
  // undici reports a dropped connection as a bare TypeError whose cause names the reason.
  return error.name === "TypeError" && /^(?:fetch failed|terminated)$/.test(error.message);
}
