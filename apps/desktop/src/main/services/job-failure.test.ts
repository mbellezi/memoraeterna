import { describe, expect, it } from "vitest";
import { AiProviderError, ProviderUnavailableError } from "@app/ai";
import {
  workerErrorMessage,
  workerFailure,
  workerMessageSchema
} from "../workers/worker-contracts.js";
import { isTransientJobFailure } from "./job-failure.js";

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

  it("looks through a wrapping error to the failure that caused it", () => {
    const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
    const invalid = new AiProviderError("bad", { kind: "http", transient: false, status: 400 });
    expect(isTransientJobFailure(new Error("stage failed", { cause: busy }))).toBe(true);
    expect(isTransientJobFailure(new Error("stage failed", { cause: invalid }))).toBe(false);
  });
});
