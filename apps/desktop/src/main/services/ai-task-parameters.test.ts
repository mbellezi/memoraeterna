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
      maxTokens: profileGenerationMaxTokens, contextWindow:128000
    });
  });
  it('bounds new remote defaults and overrides by discovered capacity while preserving old admissions',()=>{
    expect(withAiTaskParameterDefaults('structured-output',{},false,{contextWindowLimit:64000})).toMatchObject({contextWindow:64000});
    expect(withAiTaskParameterDefaults('structured-output',{contextWindow:32000},false,{contextWindowLimit:64000})).toMatchObject({contextWindow:32000});
    expect(withAiTaskParameterDefaults('structured-output',{},false,{admitted:true})).not.toHaveProperty('contextWindow');
    expect(()=>withAiTaskParameterDefaults('structured-output',{contextWindow:128000},false,{admitted:true,contextWindowLimit:64000})).toThrow('errors.ai.contextWindowLimit');
    expect(withAiTaskParameterDefaults('structured-output',{},true)).not.toHaveProperty('contextWindow');
  });

});
