import { describe, expect, it } from "vitest";
import {
  AiProviderError,
  ProviderUnavailableError,
  isTransientAiError,
  toProviderNetworkError
} from "@app/ai";
import {
  workerErrorMessage,
  workerFailure,
  workerMessageSchema
} from "../workers/worker-contracts.js";
import { isProviderOutage, isTransientJobFailure, providerOutageBlocker } from "./job-failure.js";

describe("job failure classification", () => {
  it("retries provider timeouts, rate limits, server errors, network failures and stalls", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504])
      expect(
        isTransientJobFailure(
          new AiProviderError("busy", { kind: "http", transient: true, status })
        )
      ).toBe(true);
    expect(
      isTransientJobFailure(new AiProviderError("stalled", { kind: "stalled", transient: true }))
    ).toBe(true);
    expect(
      isTransientJobFailure(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
        })
      )
    ).toBe(true);
    expect(isTransientJobFailure(new DOMException("timed out", "TimeoutError"))).toBe(true);
  });

  it("retries a call a remote lane's open circuit breaker failed fast", () => {
    const unavailable = new ProviderUnavailableError("remote:codex", 30_000);
    expect(unavailable.message).toBe("errors.ai.providerUnavailable");
    expect(isTransientJobFailure(unavailable)).toBe(true);
    expect(isTransientJobFailure(new Error("job failed", { cause: unavailable }))).toBe(true);
  });

  it("retries a crashed worker and database connection or contention errors", () => {
    expect(isTransientJobFailure(new Error("Worker exited with code 1."))).toBe(true);
    for (const message of [
      "errors.localModels.runtimeFailed",
      "errors.localModels.modelBusy",
      "organization.errors.modelChanged"
    ])
      expect(isTransientJobFailure(new Error(message))).toBe(true);
    expect(isTransientJobFailure(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransientJobFailure(Object.assign(new Error("deadlock"), { code: "40P01" }))).toBe(
      true
    );
    expect(isTransientJobFailure(Object.assign(new Error("shutdown"), { code: "57P01" }))).toBe(
      true
    );
  });

  it("retries busy files, exhausted descriptors and dropped connections", () => {
    for (const code of ["EBUSY", "EAGAIN", "EMFILE", "ENFILE", "ETIMEDOUT", "ECONNRESET"])
      expect(
        isTransientJobFailure(Object.assign(new Error(`${code}: operation failed`), { code }))
      ).toBe(true);
    for (const code of ["ENOENT", "EACCES", "ENOSPC", "EEXIST", "EPERM"])
      expect(isTransientJobFailure(Object.assign(new Error(`${code}: failed`), { code }))).toBe(
        false
      );
  });

  it("keeps the error code of a filesystem failure that crossed the worker boundary", () => {
    const busy = Object.assign(new Error("EBUSY: resource busy or locked, rename 'a' -> 'b'"), {
      code: "EBUSY"
    });
    const posted = workerMessageSchema.parse(workerErrorMessage(busy));
    expect(posted).toEqual({ kind: "error", error: busy.message, code: "EBUSY" });
    // The supervisor rejects with an Error that carries the code, as the job supervisor classifies it.
    expect(isTransientJobFailure(workerFailure(posted as { error: string; code: string }))).toBe(
      true
    );
    const missing = workerMessageSchema.parse(
      workerErrorMessage(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }))
    );
    expect(isTransientJobFailure(workerFailure(missing as { error: string; code: string }))).toBe(
      false
    );
    // Without a code, a worker failure is as deterministic as it was before.
    expect(isTransientJobFailure(workerFailure({ error: "obsidian_sync_failed" }))).toBe(false);
  });

  it("fails deterministic errors once, with their real error", () => {
    for (const status of [400, 401, 403, 404, 413])
      expect(
        isTransientJobFailure(
          new AiProviderError("rejected", { kind: "http", transient: false, status })
        )
      ).toBe(false);
    for (const message of [
      "knowledge_graph_output_invalid:schema_validation",
      "atomic_note_output_invalid",
      "errors.ai.contextWindowLimit",
      "errors.ai.noCompatibleModel",
      "errors.conversion.emptyResult",
      "errors.matching.rerankingFailed",
      "unsupported_job_type"
    ])
      expect(isTransientJobFailure(new Error(message))).toBe(false);
    expect(isTransientJobFailure(Object.assign(new Error("unique"), { code: "23505" }))).toBe(
      false
    );
    expect(isTransientJobFailure("worker_failed")).toBe(false);
    expect(isTransientJobFailure(undefined)).toBe(false);
  });

  it("retries a bare AbortError, wrapped or not (F4 D8): the caller decides cancellation first", () => {
    // A local runtime aborts a batch or a load of its own; nobody canceled the job.
    expect(isTransientJobFailure(new DOMException("Local inference canceled.", "AbortError"))).toBe(
      true
    );
    expect(isTransientJobFailure(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(
      true
    );
    expect(
      isTransientJobFailure(
        new Error("stage failed", { cause: new DOMException("canceled", "AbortError") })
      )
    ).toBe(true);
    // The adapters' own retries use `isTransientAiError`, which must keep refusing a cancelled call.
    expect(isTransientAiError(new DOMException("Local inference canceled.", "AbortError"))).toBe(
      false
    );
  });

  it("looks through a wrapping error to the failure that caused it", () => {
    const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
    const invalid = new AiProviderError("bad", { kind: "http", transient: false, status: 400 });
    expect(isTransientJobFailure(new Error("stage failed", { cause: busy }))).toBe(true);
    expect(isTransientJobFailure(new Error("stage failed", { cause: invalid }))).toBe(false);
  });
});

describe("provider outage (F4 D7): a wait, not a failure", () => {
  const now = 1_000_000;
  const transport = (code: string) =>
    toProviderNetworkError(Object.assign(new Error(`connect ${code}`), { code }));

  it("sets aside a call the breaker refused until the probe answers or the recheck", () => {
    // Nothing was sent: it waits for `network_back`, open period running or probe out alike, so a
    // long outage costs one look per probe, not one per waiting task.
    for (const breaker of ["open", "half_open"] as const)
      expect(
        providerOutageBlocker(
          new ProviderUnavailableError("remote:codex", 12_000, { breaker, failure: "unreachable" }),
          now
        )
      ).toEqual({ class: "offline", reason: "network_unreachable", clearsAt: null });
    // A provider that does not answer (refused, 5xx before the breaker opened): waiting for it.
    expect(
      providerOutageBlocker(
        new Error("stage failed", {
          cause: new ProviderUnavailableError("remote:codex", 0, { failure: "unavailable" })
        }),
        now
      )
    ).toEqual({ class: "waiting", reason: "provider_unavailable", clearsAt: null });
  });

  it("sets aside a call whose connection failed, as the next probe", () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH"])
      expect(providerOutageBlocker(transport(code), now)).toEqual({
        class: "offline",
        reason: "network_unreachable",
        clearsAt: now + 30_000
      });
    for (const code of ["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"])
      expect(providerOutageBlocker(transport(code), now, { providerProbeMs: 5_000 })).toEqual({
        class: "waiting",
        reason: "provider_unavailable",
        clearsAt: now + 5_000
      });
    expect(isProviderOutage(new Error("job failed", { cause: transport("ENOTFOUND") }))).toBe(true);
  });

  it("backs off a reset or a cut stream: the request may have been sent, again and again", () => {
    // A request that always breaks its connection must run out of attempts, not wait for good.
    for (const code of ["ECONNRESET", "EPIPE", "ECONNABORTED", "ETIMEDOUT", "UND_ERR_SOCKET"]) {
      expect(isProviderOutage(transport(code))).toBe(false);
      expect(isTransientJobFailure(transport(code))).toBe(true);
    }
    const cut = toProviderNetworkError(new TypeError("terminated"));
    expect(isProviderOutage(cut)).toBe(false);
    expect(isTransientJobFailure(cut)).toBe(true);
  });

  it("keeps answers on their paths: backoff for 5xx, 429 and deadlines, failure for 4xx", () => {
    for (const status of [429, 500, 503])
      expect(
        isProviderOutage(new AiProviderError("busy", { kind: "http", transient: true, status }))
      ).toBe(false);
    for (const status of [400, 401, 403, 404, 413])
      expect(
        isProviderOutage(
          new AiProviderError("rejected", { kind: "http", transient: false, status })
        )
      ).toBe(false);
    for (const kind of ["timeout", "stalled", "stream", "context_overflow"] as const)
      expect(isProviderOutage(new AiProviderError(kind, { kind, transient: true }))).toBe(false);
    expect(isProviderOutage(new Error("knowledge_graph_output_invalid:schema_validation"))).toBe(
      false
    );
    // A database that refused its connection is no provider outage: it backs off as before.
    expect(
      isProviderOutage(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
    ).toBe(false);
    expect(isProviderOutage(undefined)).toBe(false);
  });
});
