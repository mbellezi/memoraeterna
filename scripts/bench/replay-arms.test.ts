import { findLocalModelCatalogEntry } from "@app/ai";
import { describe, expect, it } from "vitest";

import { arms, customArm, effectiveParameters, workloadClassOf } from "./replay-arms.ts";

describe("the arms", () => {
  it("name the two installed writers by their catalog entries and the two downloads by folder", () => {
    expect(Object.keys(arms)).toEqual(["m4b", "m9b4", "q36-35b-a3b", "gemma4-26b-a4b"]);
    for (const arm of Object.values(arms)) {
      if (arm.catalogId) expect(findLocalModelCatalogEntry(arm.catalogId)).toBeDefined();
      expect(arm.runtime).toBe("mlx");
      expect(arm.parameterSource.length).toBeGreaterThan(0);
    }
    expect(arms.m9b4!.catalogId).toBe("mlx-qwen3.5-9b-4bit");
    expect(arms.m4b!.catalogId).toBe("mlx-qwen3-4b-instruct-2507-4bit");
    expect(arms["q36-35b-a3b"]!.directory).toBe("models/qwen3.6-35b-a3b-4bit-mlx");
    expect(arms["gemma4-26b-a4b"]!.directory).toBe("models/gemma-4-26b-a4b-it-4bit-mlx");
  });

  it("carry the product's own generation parameters of the model family", () => {
    expect(arms.m9b4!.parameters).toMatchObject({
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      presencePenalty: 1.5
    });
    expect(arms["gemma4-26b-a4b"]!.parameters).toEqual({ temperature: 1, topP: 0.95, topK: 64 });
  });

  it("make a custom arm of any folder", () => {
    const arm = customArm({
      label: "x",
      runtime: "gguf",
      modelDir: "/models/x.gguf",
      parameters: { temperature: 0.1 }
    });
    expect(arm).toMatchObject({
      id: "custom",
      runtime: "gguf",
      parameters: { temperature: 0.1 },
      catalogId: null
    });
  });
});

describe("the parameters of a call", () => {
  const call = { taskType: "knowledge-graph-generation", operation: "graph_atomic_notes" } as const;

  it("start from the model's own and add the product's task defaults", () => {
    const parameters = effectiveParameters(arms.m9b4!, call);
    expect(parameters).toMatchObject({ temperature: 0.7, topK: 20, reasoningLevel: "off" });
    expect(parameters.maxTokens).toBe(32_768);
  });

  it("default local atomic notes to temperature zero only where the model states none, as the service does", () => {
    const notes = {
      taskType: "atomic-note-generation",
      operation: "atomic_note_generation"
    } as const;
    expect(effectiveParameters(arms.m9b4!, notes).temperature).toBe(0.7);
    const bare = customArm({
      label: "x",
      runtime: "mlx",
      modelDir: "/m",
      parameters: { topK: 20 }
    });
    expect(effectiveParameters(bare, notes).temperature).toBe(0);
  });

  it("turn reasoning off for the short structured operations", () => {
    const parameters = effectiveParameters(arms["gemma4-26b-a4b"]!, {
      taskType: "structured-output",
      operation: "topic_name",
      maxOutputTokens: 740
    });
    expect(parameters).toMatchObject({ reasoningLevel: "off", maxTokens: 740 });
  });

  it("cap the output at the caller's allowance, never raise it, and take the seed", () => {
    const capped = effectiveParameters(arms.m9b4!, { ...call, maxOutputTokens: 500 }, { seed: 7 });
    expect(capped).toMatchObject({ maxTokens: 500, seed: 7 });
    const roomy = effectiveParameters(
      arms.m9b4!,
      { ...call, maxOutputTokens: 99_999 },
      { overrides: { maxTokens: 1_000 } }
    );
    expect(roomy.maxTokens).toBe(1_000);
  });

  it("let an override replace a model parameter", () => {
    expect(
      effectiveParameters(arms.m9b4!, call, { overrides: { temperature: 0.2 } }).temperature
    ).toBe(0.2);
  });

  it("refuse a parameter the product does not know", () => {
    expect(() => effectiveParameters(arms.m9b4!, call, { overrides: { nonsense: 1 } })).toThrow();
  });
});

describe("the workload class a caller states", () => {
  it("is write-fast for names, overviews and typing and write-quality for confirmation", () => {
    expect(workloadClassOf({ contract: "topic-names" })).toBe("write-fast");
    expect(workloadClassOf({ contract: "overview" })).toBe("write-fast");
    expect(workloadClassOf({ contract: "typing" })).toBe("write-fast");
    expect(workloadClassOf({ contract: "confirmation" })).toBe("write-quality");
    expect(workloadClassOf({ contract: "graph" })).toBeUndefined();
    expect(workloadClassOf({ contract: "notes" })).toBeUndefined();
    expect(workloadClassOf({ contract: "summary" })).toBeUndefined();
  });
});
