import { remoteGenerationContextWindow } from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  aiTaskBehaviorDefaults,
  noteMatchDecisionOperations,
  profileGenerationMaxTokens,
  relationExplanationOperation,
  relationTypingOperation,
  relationTypingRepairOperation,
  routeCapacity,
  sourceRelationExplanationOperation,
  topicNameOperation,
  topicOverviewOperation,
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

  it("turns reasoning off for the note-match decision calls unless the profile asks for it", () => {
    for (const operation of Object.values(noteMatchDecisionOperations)) {
      for (const local of [false, true])
        expect(withAiTaskParameterDefaults("reranking", {}, local, { operation })).toMatchObject({
          reasoningLevel: "off"
        });
      expect(
        withAiTaskParameterDefaults("reranking", { reasoningLevel: "medium" }, false, { operation })
      ).toMatchObject({ reasoningLevel: "medium" });
    }
    for (const task of ["summarization", "knowledge-graph-generation", "structured-output"])
      expect(
        withAiTaskParameterDefaults(task, {}, false, {
          operation: noteMatchDecisionOperations.decide
        })
      ).not.toHaveProperty("reasoningLevel");
  });

  it("turns reasoning off for topic naming unless the profile asks for it, and for no other call", () => {
    const options = { operation: topicNameOperation };
    expect(withAiTaskParameterDefaults("structured-output", {}, false, options)).toMatchObject({
      reasoningLevel: "off"
    });
    expect(
      withAiTaskParameterDefaults("structured-output", { reasoningLevel: "high" }, false, options)
    ).toMatchObject({ reasoningLevel: "high" });
    expect(withAiTaskParameterDefaults("structured-output", {}, false)).not.toHaveProperty(
      "reasoningLevel"
    );
    expect(withAiTaskParameterDefaults("text-generation", {}, false, options)).not.toHaveProperty(
      "reasoningLevel"
    );
    expect(aiTaskBehaviorDefaults("structured-output", true, topicNameOperation)).toEqual({
      reasoningLevel: "off"
    });
  });

  it("turns reasoning off for the topic overview the owner waits for, unless the profile asks for it", () => {
    const options = { operation: topicOverviewOperation };
    expect(withAiTaskParameterDefaults("structured-output", {}, true, options)).toMatchObject({
      reasoningLevel: "off"
    });
    expect(
      withAiTaskParameterDefaults("structured-output", { reasoningLevel: "low" }, false, options)
    ).toMatchObject({ reasoningLevel: "low" });
    expect(withAiTaskParameterDefaults("text-generation", {}, false, options)).not.toHaveProperty(
      "reasoningLevel"
    );
  });

  it("turns reasoning off for the relation typing calls (codes only) unless the profile asks for it", () => {
    for (const operation of [relationTypingOperation, relationTypingRepairOperation]) {
      const options = { operation };
      for (const local of [false, true])
        expect(withAiTaskParameterDefaults("structured-output", {}, local, options)).toMatchObject({
          reasoningLevel: "off"
        });
      expect(
        withAiTaskParameterDefaults("structured-output", { reasoningLevel: "low" }, false, options)
      ).toMatchObject({ reasoningLevel: "low" });
      expect(aiTaskBehaviorDefaults("structured-output", false, operation)).toEqual({
        reasoningLevel: "off"
      });
      // Only that operation of the structured-output task: other tasks keep the profile's.
      for (const task of ["text-generation", "reranking"])
        expect(withAiTaskParameterDefaults(task, {}, false, options)).not.toHaveProperty(
          "reasoningLevel"
        );
    }
  });

  it("turns reasoning off for the relation explanation unless the profile asks for it", () => {
    const options = { operation: relationExplanationOperation };
    for (const local of [false, true])
      expect(withAiTaskParameterDefaults("text-generation", {}, local, options)).toMatchObject({
        reasoningLevel: "off"
      });
    expect(
      withAiTaskParameterDefaults("text-generation", { reasoningLevel: "medium" }, false, options)
    ).toMatchObject({ reasoningLevel: "medium" });
    // Only that operation of that route: other writer calls and other routes keep the profile's.
    expect(withAiTaskParameterDefaults("text-generation", {}, false)).not.toHaveProperty(
      "reasoningLevel"
    );
    expect(
      withAiTaskParameterDefaults("text-generation", {}, false, { operation: "ask" })
    ).not.toHaveProperty("reasoningLevel");
    for (const task of ["summarization", "reranking", "structured-output"])
      expect(withAiTaskParameterDefaults(task, {}, false, options)).not.toHaveProperty(
        "reasoningLevel"
      );
    // A run fingerprint covers whatever a task adds beyond sizing.
    expect(aiTaskBehaviorDefaults("text-generation", false, relationExplanationOperation)).toEqual({
      reasoningLevel: "off"
    });
    // A source relation's explanation is written the same way.
    expect(
      aiTaskBehaviorDefaults("text-generation", false, sourceRelationExplanationOperation)
    ).toEqual({ reasoningLevel: "off" });
    expect(
      withAiTaskParameterDefaults("reranking", {}, false, {
        operation: sourceRelationExplanationOperation
      })
    ).not.toHaveProperty("reasoningLevel");
  });

  it("leaves other uses of the reranking route, such as source matching, on the profile's parameters", () => {
    for (const operation of [undefined, null, "source_relation_matching"]) {
      expect(withAiTaskParameterDefaults("reranking", {}, false, { operation })).not.toHaveProperty(
        "reasoningLevel"
      );
      expect(
        withAiTaskParameterDefaults("reranking", { reasoningLevel: "high" }, true, { operation })
      ).toMatchObject({ reasoningLevel: "high" });
    }
    expect(withAiTaskParameterDefaults("reranking", {}, false)).not.toHaveProperty(
      "reasoningLevel"
    );
    // Whatever a task adds beyond sizing is what a run fingerprint has to cover.
    expect(aiTaskBehaviorDefaults("reranking", false, "source_relation_matching")).toEqual({});
    expect(aiTaskBehaviorDefaults("reranking", false, noteMatchDecisionOperations.repair)).toEqual({
      reasoningLevel: "off"
    });
    expect(aiTaskBehaviorDefaults("atomic-note-generation", true)).toEqual({ temperature: 0 });
  });

  it("preserves explicit profile overrides", () => {
    expect(
      withAiTaskParameterDefaults(
        "atomic-note-generation",
        { maxTokens: 8_192, temperature: 0.1 },
        true
      )
    ).toEqual({ maxTokens: 8_192, temperature: 0.1 });
  });

  it("applies the generation default to remote profiles too", () => {
    expect(withAiTaskParameterDefaults("atomic-note-generation", {}, false)).toEqual({
      maxTokens: profileGenerationMaxTokens,
      contextWindow: 128000
    });
  });
  it("bounds new remote defaults and overrides by discovered capacity while preserving old admissions", () => {
    expect(
      withAiTaskParameterDefaults("structured-output", {}, false, { contextWindowLimit: 64000 })
    ).toMatchObject({ contextWindow: 64000 });
    expect(
      withAiTaskParameterDefaults("structured-output", { contextWindow: 32000 }, false, {
        contextWindowLimit: 64000
      })
    ).toMatchObject({ contextWindow: 32000 });
    expect(
      withAiTaskParameterDefaults("structured-output", {}, false, { admitted: true })
    ).not.toHaveProperty("contextWindow");
    expect(() =>
      withAiTaskParameterDefaults("structured-output", { contextWindow: 128000 }, false, {
        admitted: true,
        contextWindowLimit: 64000
      })
    ).toThrow("errors.ai.contextWindowLimit");
    expect(withAiTaskParameterDefaults("structured-output", {}, true)).not.toHaveProperty(
      "contextWindow"
    );
  });
});

describe("the capacity of a task route", () => {
  const remote = (providerMetadata: Record<string, unknown>, parameters = {}) => ({
    localModelId: null,
    parameters,
    modelDefaultParameters: {},
    providerMetadata
  });

  it("is the planning window of a remote call when the provider's limit is larger", () => {
    // The Codex route discovers a 272K window; a call is planned against the application's 128K.
    expect(
      routeCapacity("summarization", remote({ modelLimits: { contextWindow: 272_000 } }))
    ).toEqual({
      contextWindow: remoteGenerationContextWindow,
      source: "planning",
      maxOutputTokens: profileGenerationMaxTokens,
      local: false
    });
  });

  it("follows the provider's discovered limit when it is the smaller one (OpenAI-compatible)", () => {
    expect(
      routeCapacity("summarization", remote({ modelLimits: { contextWindow: 32_000 } }))
    ).toMatchObject({ contextWindow: 32_000, source: "provider" });
    // `inputTokens` is a limit too, and the smaller of the two bounds the window.
    expect(
      routeCapacity(
        "summarization",
        remote({ modelLimits: { contextWindow: 200_000, inputTokens: 64_000 } })
      )
    ).toMatchObject({ contextWindow: 64_000, source: "provider" });
  });

  it("follows the profile's own window, bounded by the provider's", () => {
    expect(
      routeCapacity(
        "summarization",
        remote({ modelLimits: { contextWindow: 272_000 } }, { contextWindow: 64_000 })
      )
    ).toMatchObject({ contextWindow: 64_000, source: "profile" });
    expect(
      routeCapacity(
        "summarization",
        remote({ modelLimits: { contextWindow: 32_000 } }, { contextWindow: 64_000 })
      )
    ).toMatchObject({ contextWindow: 32_000, source: "provider" });
  });

  it("reads a local model's window and output from its catalog defaults, else reports none", () => {
    expect(
      routeCapacity("summarization", {
        localModelId: "imported",
        parameters: {},
        modelDefaultParameters: { contextWindow: 4_096, maxTokens: 1_024 },
        providerMetadata: {}
      })
    ).toEqual({ contextWindow: 4_096, source: "profile", maxOutputTokens: 1_024, local: true });
    // The profile's own parameters win over the model's defaults.
    expect(
      routeCapacity("summarization", {
        localModelId: "imported",
        parameters: { contextWindow: 16_384 },
        modelDefaultParameters: { contextWindow: 4_096 },
        providerMetadata: null
      })
    ).toMatchObject({ contextWindow: 16_384, source: "profile" });
    // A catalog MLX model states no window: its native limit is not metadata the app holds.
    expect(
      routeCapacity("summarization", {
        localModelId: "mlx",
        parameters: {},
        modelDefaultParameters: { temperature: 1 },
        providerMetadata: {}
      })
    ).toEqual({
      contextWindow: null,
      source: "unknown",
      maxOutputTokens: profileGenerationMaxTokens,
      local: true
    });
  });
});
