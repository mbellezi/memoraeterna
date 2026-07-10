import { describe, expect, it, vi } from "vitest";

import { logLocalModelOutput } from "./local-model-output-debug.js";

describe("local model output debug logging", () => {
  it("prints the complete textual output when explicitly enabled", () => {
    const info = vi.fn();
    const output = "```json\n{\"notes\":[]}\n```\nmodel suffix";

    logLocalModelOutput(
      { info },
      true,
      { jobId: "job-1", taskType: "atomic-note-generation", modelId: "local-model" },
      output
    );

    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      event: "local_model_output_debug",
      privacyWarning: "contains_full_local_model_output",
      jobId: "job-1",
      output
    });
  });

  it("does not log when disabled or when the output is not textual", () => {
    const info = vi.fn();
    logLocalModelOutput({ info }, false, { taskType: "summarization" }, "private output");
    logLocalModelOutput({ info }, true, { taskType: "embedding" }, [0.1, 0.2]);
    expect(info).not.toHaveBeenCalled();
  });
});
