import { describe, expect, it } from "vitest";

import {
  profileGenerationMaxTokens,
  withAiTaskParameterDefaults
} from "./ai-task-parameters.js";

describe("AI task parameter defaults", () => {
  it.each([
    "text-generation",
    "summarization",
    "knowledge-graph-generation",
    "atomic-note-generation",
    "reranking"
  ])("uses 16K output by default for the profiled generation task %s", (taskType) => {
    expect(withAiTaskParameterDefaults(taskType, {}, false)).toMatchObject({
      maxTokens: profileGenerationMaxTokens
    });
  });

  it("keeps local atomic note generation deterministic", () => {
    expect(withAiTaskParameterDefaults("atomic-note-generation", {}, true)).toEqual({
      maxTokens: profileGenerationMaxTokens,
      temperature: 0
    });
  });

  it("preserves explicit profile overrides", () => {
    expect(withAiTaskParameterDefaults(
      "atomic-note-generation",
      { maxTokens: 8_192, temperature: 0.1 },
      true
    )).toEqual({ maxTokens: 8_192, temperature: 0.1 });
  });

  it("applies the generation default to remote profiles too", () => {
    expect(withAiTaskParameterDefaults("atomic-note-generation", {}, false)).toEqual({
      maxTokens: profileGenerationMaxTokens
    });
  });
});
