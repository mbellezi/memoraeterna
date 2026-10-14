import { describe, expect, it } from "vitest";
import { AiProviderError } from "@app/ai";
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
