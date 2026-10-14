import { describe, expect, it } from "vitest";

import {
  defaultInteractivePreset,
  resolveProcessingPlan,
  validateDivisionTree,
  type DocumentDivisionCandidate
} from "./hierarchical-ingestion.js";

describe("hierarchical ingestion", () => {
  it("includes source matching in full knowledge and resolves it without generating notes", () => {
    const input = {
      preset: "custom" as const,
      requestedStages: ["sourceMatching" as const],
      scope: "source_only" as const,
      targetSourceItemIds: [],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid" as const
    };
    const plan = resolveProcessingPlan(input);
    expect(plan.effectiveStages).toContain("summarization");
    expect(plan.effectiveStages).toContain("embedding");
    expect(plan.effectiveStages).not.toContain("atomicNotes");
    expect(plan.effectiveStages).not.toContain("knowledgeGraph");
    expect(
      resolveProcessingPlan({ ...input, preset: "full_knowledge", requestedStages: [] })
        .effectiveStages
    ).toContain("sourceMatching");
  });
  it("resolves presets and automatically includes dependencies", () => {
    const plan = resolveProcessingPlan({
      preset: "custom",
      requestedStages: ["knowledgeGraph"],
      scope: "selected_items",
      targetSourceItemIds: ["11111111-1111-4111-8111-111111111111"],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid"
    });
    expect(plan.effectiveStages).toEqual([
      "conversion",
      "structureDetection",
      "structureReview",
      "materialization",
      "chunking",
      "knowledgeGraph"
    ]);
    expect(plan.automaticallyIncludedStages).toContain("chunking");
    expect(plan.automaticallyIncludedStages).not.toContain("atomicNotes");
  });

  it("defaults interactive processing to full knowledge only when a writer route is ready", () => {
    const request = (preset: ReturnType<typeof defaultInteractivePreset>) =>
      resolveProcessingPlan({
        preset,
        requestedStages: [],
        scope: "source_only",
        targetSourceItemIds: [],
        forceRegeneration: false,
        previousArtifactPolicy: "reuse_valid"
      }).effectiveStages;
    expect(defaultInteractivePreset(true)).toBe("full_knowledge");
    expect(request(defaultInteractivePreset(true))).toEqual(
      expect.arrayContaining(["atomicNotes", "knowledgeGraph", "sourceMatching"])
    );
    expect(defaultInteractivePreset(false)).toBe("search_ready");
    const searchable = request(defaultInteractivePreset(false));
    expect(searchable).toEqual(expect.arrayContaining(["chunking", "embedding"]));
    for (const generative of [
      "summarization",
      "atomicNotes",
      "knowledgeGraph",
      "atomicNoteMatching",
      "sourceMatching",
      "organizeKnowledge"
    ] as const)
      expect(searchable).not.toContain(generative);
  });
  it("keeps import-only free from AI stages", () => {
    const plan = resolveProcessingPlan({
      preset: "import_only",
      requestedStages: [],
      scope: "source_only",
      targetSourceItemIds: [],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid"
    });
    expect(plan.effectiveStages).not.toContain("embedding");
    expect(plan.effectiveStages).not.toContain("summarization");
    expect(plan.effectiveStages).not.toContain("atomicNotes");
  });

  it("reports overlaps without rejecting adjacent divisions", () => {
    const base = {
      parentId: null,
      kind: "chapter",
      level: 0,
      startSelector: {},
      endSelector: {},
      confidence: 0.9,
      evidence: [],
      reviewStatus: "accepted",
      isProcessable: true,
      metadata: {}
    } as const;
    const divisions: DocumentDivisionCandidate[] = [
      {
        ...base,
        id: "11111111-1111-4111-8111-111111111111",
        title: "One",
        position: 0,
        markdownStart: 0,
        markdownEnd: 10
      },
      {
        ...base,
        id: "22222222-2222-4222-8222-222222222222",
        title: "Two",
        position: 1,
        markdownStart: 9,
        markdownEnd: 20
      },
      {
        ...base,
        id: "33333333-3333-4333-8333-333333333333",
        title: "Three",
        position: 2,
        markdownStart: 20,
        markdownEnd: 30
      }
    ];
    expect(validateDivisionTree(divisions)).toEqual([
      { code: "overlap", divisionIds: [divisions[0]!.id, divisions[1]!.id] }
    ]);
  });
});
