import { describe, expect, it, vi } from "vitest";

import { logStructuredError } from "./structured-logging.js";

describe("structured error logging", () => {
  it("logs correlation fields without leaking error payloads or secrets", () => {
    const error = vi.fn();
    logStructuredError(
      { error },
      "atomic_note_generation_failed",
      {
        jobId: "job-1",
        ingestionRunId: "run-1",
        sourceItemId: "source-1",
        documentId: "document-1",
        stage: "output_validation",
        profileId: "profile-1",
        providerId: "provider-1",
        modelId: "model-1",
        runtime: "mlx",
        aiTaskRunId: "ai-run-1"
      },
      new Error("Authorization: Bearer hf_super_secret private source content"),
      "atomic_note_output_invalid"
    );

    const serialized = String(error.mock.calls[0]?.[0]);
    const record = JSON.parse(serialized) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: "error",
      event: "atomic_note_generation_failed",
      jobId: "job-1",
      ingestionRunId: "run-1",
      profileId: "profile-1",
      modelId: "model-1",
      errorType: "Error",
      errorCode: "atomic_note_output_invalid"
    });
    expect(serialized).not.toContain("hf_super_secret");
    expect(serialized).not.toContain("private source content");
  });

  it("preserves short technical error codes", () => {
    const error = vi.fn();
    logStructuredError(
      { error },
      "atomic_note_generation_failed",
      { stage: "output_validation" },
      new Error("atomic_note_unknown_evidence_chunk"),
      "atomic_note_output_invalid"
    );

    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      errorCode: "atomic_note_unknown_evidence_chunk"
    });
  });
});
