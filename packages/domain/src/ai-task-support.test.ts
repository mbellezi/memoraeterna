import { describe, expect, it } from "vitest";

import { AiCapabilities, AiTaskTypes } from "./ai.js";
import {
  capabilitiesForTask,
  generativeDeciderCapabilities,
  supportsTask
} from "./ai-task-support.js";

describe("which models can serve a task", () => {
  it("accepts a generative model on the decision route without a reranking capability", () => {
    expect(supportsTask("reranking", ["text-generation"])).toBe(true);
    expect(supportsTask("reranking", ["structured-output"])).toBe(true);
    expect(supportsTask("reranking", ["reranking"])).toBe(true);
  });

  it("accepts nothing else as a decider and keeps every other task strict", () => {
    expect(supportsTask("reranking", ["embedding"])).toBe(false);
    expect(supportsTask("reranking", [])).toBe(false);
    expect(supportsTask("embedding", ["text-generation"])).toBe(false);
    expect(supportsTask("summarization", ["text-generation"])).toBe(false);
    expect(supportsTask("atomic-note-generation", ["structured-output"])).toBe(false);
    expect(
      supportsTask("atomic-note-generation", ["atomic-note-generation", "structured-output"])
    ).toBe(true);
  });

  it("requires the declared capabilities for each generative writer task", () => {
    expect(capabilitiesForTask("summarization")).toEqual(["summarization"]);
    expect(capabilitiesForTask("knowledge-graph-generation")).toEqual(["structured-output"]);
    expect(capabilitiesForTask("atomic-note-generation")).toEqual([
      "atomic-note-generation",
      "structured-output"
    ]);
    // A profile whose capabilities were emptied serves none of the tasks that declare a need.
    for (const task of AiTaskTypes) {
      if (capabilitiesForTask(task).length === 0) continue;
      expect(supportsTask(task, [])).toBe(false);
    }
  });

  it("lets a task without a requirement through, as routing always has", () => {
    expect(capabilitiesForTask("claim-extraction")).toEqual([]);
    expect(supportsTask("claim-extraction", [])).toBe(true);
  });

  it("only ever treats generation capabilities as decider capabilities", () => {
    for (const capability of generativeDeciderCapabilities)
      expect(AiCapabilities).toContain(capability);
    for (const capability of AiCapabilities) {
      if (generativeDeciderCapabilities.includes(capability) || capability === "reranking")
        continue;
      expect(supportsTask("reranking", [capability])).toBe(false);
    }
  });
});
