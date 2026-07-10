import { describe, expect, it } from "vitest";

import {
  atomicNoteGenerationMaxTokens,
  withAiTaskParameterDefaults
} from "./ai-task-parameters.js";

describe("AI task parameter defaults", () => {
  it("uses 16K deterministic output for local atomic note generation", () => {
    expect(withAiTaskParameterDefaults("atomic-note-generation", {}, true)).toEqual({
      maxTokens: atomicNoteGenerationMaxTokens,
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

  it("does not send local parameter names to remote generation adapters", () => {
    expect(withAiTaskParameterDefaults("atomic-note-generation", {}, false)).toEqual({});
  });
});
