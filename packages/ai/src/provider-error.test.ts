import { describe, expect, it } from "vitest";

import {
  AiProviderError,
  aiErrorRetryAfterMs,
  classifyHttpFailure,
  isTransientAiError,
  providerHttpError,
  providerStreamError,
  retryAfterMilliseconds,
  retryDelayFromText,
  toProviderNetworkError
} from "./provider-error.js";

describe("HTTP failure classification", () => {
  it.each([408, 425, 429, 500, 502, 503, 504, 529])("treats %i as transient", (status) => {
    expect(classifyHttpFailure(status).transient).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422])("treats %i as permanent", (status) => {
    expect(classifyHttpFailure(status).transient).toBe(false);
  });

  it("recognizes a context overflow, which no retry can fix", () => {
    expect(
      classifyHttpFailure(400, "This model's maximum context length is 128000 tokens.")
    ).toEqual({ kind: "context_overflow", transient: false });
    expect(classifyHttpFailure(400, '{"error":{"code":"context_length_exceeded"}}').kind).toBe(
      "context_overflow"
    );
  });

  it("separates an exhausted quota from a rate limit", () => {
    expect(classifyHttpFailure(429, '{"error":{"code":"insufficient_quota"}}').transient).toBe(
      false
    );
    expect(classifyHttpFailure(429, "Rate limit reached for requests").transient).toBe(true);
  });

  it("treats a per-minute Gemini quota as a rate limit and takes its retry delay from the body", async () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message:
          "You exceeded your current quota, please check your plan and billing details. Please retry in 32.4s.",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "32s" }]
      }
    });
    expect(classifyHttpFailure(429, body)).toEqual({
      kind: "http",
      transient: true,
      retryAfterMs: 32_000
    });
    const error = await providerHttpError(new Response(body, { status: 429 }));
    expect(error).toMatchObject({ transient: true, status: 429, retryAfterMs: 32_000 });
    // The header, when the provider sends one, wins over the body.
    const withHeader = await providerHttpError(
      new Response(body, { status: 429, headers: { "retry-after": "4" } })
    );
    expect(withHeader.retryAfterMs).toBe(4_000);
    expect(
      classifyHttpFailure(429, "You exceeded your current quota. Please retry in 1.5s.")
    ).toMatchObject({ transient: true, retryAfterMs: 1_500 });
  });

  it("keeps an exhausted billing quota permanent, with or without the quota wording", () => {
    for (const body of [
      '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      '{"error":{"code":"billing_hard_limit_reached"}}',
      "Your credit balance is too low to access the API"
    ])
      expect(classifyHttpFailure(429, body)).toEqual({ kind: "http", transient: false });
  });

  it("waits for the reset a ChatGPT plan limit announces instead of retrying at once", async () => {
    for (const type of ["usage_limit_reached", "usage_not_included"]) {
      const body = JSON.stringify({
        error: { type, message: "The usage limit has been reached", resets_in_seconds: 1_800 }
      });
      const error = await providerHttpError(new Response(body, { status: 429 }));
      expect(error).toMatchObject({ transient: true, status: 429, retryAfterMs: 1_800_000 });
    }
    // A reset far in the future is bounded like any other provider delay.
    expect(
      classifyHttpFailure(
        429,
        '{"error":{"type":"usage_limit_reached","resets_in_seconds":900000}}'
      ).retryAfterMs
    ).toBe(3_600_000);
    expect(
      classifyHttpFailure(429, '{"error":{"type":"usage_limit_reached"}}').retryAfterMs
    ).toBeUndefined();
  });

  it("reads the delay a rate-limit message states and nothing else", () => {
    expect(retryDelayFromText('"retryDelay": "0.5s"')).toBe(500);
    expect(retryDelayFromText("Please retry in 12s")).toBe(12_000);
    expect(retryDelayFromText("retry in soon")).toBeUndefined();
    expect(retryDelayFromText("")).toBeUndefined();
  });

  it("keeps the status and the redacted body in the error and reads Retry-After", async () => {
    const error = await providerHttpError(
      new Response("slow down, authorization: Bearer sk-secret-token", {
        status: 429,
        headers: { "retry-after": "7" }
      })
    );
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ status: 429, transient: true, retryAfterMs: 7_000 });
    expect(error.message).toContain("AI provider request failed (429).");
    expect(error.message).not.toContain("sk-secret-token");
  });
});

describe("Retry-After", () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it("accepts seconds, milliseconds and HTTP dates and ignores anything else", () => {
    expect(retryAfterMilliseconds(headers({ "retry-after": "2.5" }))).toBe(2_500);
    expect(retryAfterMilliseconds(headers({ "retry-after-ms": "1200" }))).toBe(1_200);
    expect(
      retryAfterMilliseconds(
        headers({ "retry-after": "Wed, 21 Oct 2026 07:28:10 GMT" }),
        Date.parse("Wed, 21 Oct 2026 07:28:00 GMT")
      )
    ).toBe(10_000);
    expect(retryAfterMilliseconds(headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterMilliseconds(headers({ "retry-after": "-3" }))).toBeUndefined();
    expect(retryAfterMilliseconds(headers({}))).toBeUndefined();
  });

  it("prefers the millisecond header and bounds an absurd delay", () => {
    expect(retryAfterMilliseconds(headers({ "retry-after-ms": "250", "retry-after": "30" }))).toBe(
      250
    );
    expect(retryAfterMilliseconds(headers({ "retry-after": "999999999" }))).toBe(3_600_000);
  });
});

describe("errors reported inside a stream", () => {
  it("treats server-side failures and unlabeled failures as transient", () => {
    expect(providerStreamError({ code: "server_error", message: "boom" }).transient).toBe(true);
    expect(providerStreamError({ code: "rate_limit_exceeded" }).transient).toBe(true);
    expect(providerStreamError({ message: "AI provider request failed." }).transient).toBe(true);
    expect(providerStreamError({ code: 503, type: "UNAVAILABLE" }).transient).toBe(true);
  });

  it("retries a Gemini quota error reported in a stream after the delay it states", () => {
    const error = providerStreamError({
      code: 429,
      type: "RESOURCE_EXHAUSTED",
      message: "You exceeded your current quota, please check your plan. Please retry in 32s."
    });
    expect(error).toMatchObject({ transient: true, status: 429, retryAfterMs: 32_000 });
    const exhausted = providerStreamError({ code: "insufficient_quota", message: "Retry in 5s" });
    expect(exhausted.transient).toBe(false);
    expect(exhausted.retryAfterMs).toBeUndefined();
  });

  it("treats invalid requests, context overflow and exhausted quota as permanent", () => {
    expect(providerStreamError({ code: "invalid_prompt" }).transient).toBe(false);
    expect(providerStreamError({ code: 400, type: "INVALID_ARGUMENT" }).transient).toBe(false);
    expect(providerStreamError({ code: "insufficient_quota" }).transient).toBe(false);
    const overflow = providerStreamError({
      code: "context_length_exceeded",
      message: "Your input exceeds the context window of this model."
    });
    expect(overflow).toMatchObject({ kind: "context_overflow", transient: false });
  });
});

describe("transient error detection", () => {
  it("follows the cause chain of transport failures", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isTransientAiError(new TypeError("fetch failed", { cause: reset }))).toBe(true);
    expect(isTransientAiError(new TypeError("terminated"))).toBe(true);
    expect(isTransientAiError(new DOMException("timed out", "TimeoutError"))).toBe(true);
  });

  it("does not retry cancellations, validation failures or unknown errors", () => {
    expect(isTransientAiError(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(isTransientAiError(new Error("knowledge_graph_output_invalid:schema_validation"))).toBe(
      false
    );
    expect(isTransientAiError(new TypeError("Invalid URL"))).toBe(false);
    expect(isTransientAiError("text")).toBe(false);
    expect(isTransientAiError(undefined)).toBe(false);
  });

  it("respects the classification of a typed error even when it is wrapped", () => {
    const permanent = new AiProviderError("bad request", { kind: "http", transient: false });
    const transient = new AiProviderError("busy", {
      kind: "http",
      transient: true,
      retryAfterMs: 4_000
    });
    expect(isTransientAiError(new Error("wrapped", { cause: permanent }))).toBe(false);
    expect(isTransientAiError(new Error("wrapped", { cause: transient }))).toBe(true);
    expect(aiErrorRetryAfterMs(new Error("wrapped", { cause: transient }))).toBe(4_000);
  });

  it("wraps only transport failures as network errors", () => {
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const wrapped = toProviderNetworkError(new TypeError("fetch failed", { cause: reset }));
    expect(wrapped).toBeInstanceOf(AiProviderError);
    expect(wrapped).toMatchObject({ kind: "network", transient: true, code: "ECONNRESET" });
    const invalid = new TypeError("Invalid URL");
    expect(toProviderNetworkError(invalid)).toBe(invalid);
  });
});
