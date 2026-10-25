import { describe, expect, it } from "vitest";

import {
  isStructuredCall,
  withSoakCallContext,
  currentSoakCallContext
} from "./soak-call-context.js";

describe("the structured callers of a soak", () => {
  it("reads a call whose task type states a contract as structured, a summary or an answer as plain text", () => {
    for (const taskType of [
      "structured-output",
      "knowledge-graph-generation",
      "atomic-note-generation",
      "reranking"
    ] as const)
      expect(isStructuredCall({ taskType })).toBe(true);
    for (const taskType of ["summarization", "text-generation", "embedding"] as const)
      expect(isStructuredCall({ taskType })).toBe(false);
  });

  it("reads a call that sends a wire schema as structured whatever its task type", () => {
    expect(
      isStructuredCall({
        taskType: "text-generation",
        outputSchema: { name: "answer", schema: { type: "object" }, strict: true }
      })
    ).toBe(true);
  });

  it("never reads a repair as the call to injure: it is what a refused answer causes", () => {
    for (const operation of [
      "graph_atomic_notes_repair",
      "atomic_note_repair",
      "relation_typing_repair",
      "note_matching_reranking_repair"
    ])
      expect(isStructuredCall({ taskType: "structured-output", operation })).toBe(false);
    expect(isStructuredCall({ taskType: "structured-output", operation: "topic_name" })).toBe(true);
  });

  it("carries the flag in the call's context for the fetch layer to read", async () => {
    const seen = await withSoakCallContext(async () => currentSoakCallContext()?.structured, {
      structured: true
    });
    expect(seen.outcome).toEqual({ value: true });
    const plain = await withSoakCallContext(async () => currentSoakCallContext()?.structured);
    expect(plain.outcome).toEqual({ value: undefined });
  });
});
