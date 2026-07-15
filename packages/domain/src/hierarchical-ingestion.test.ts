import { describe, expect, it } from "vitest";

import {
  resolveProcessingPlan,
  validateDivisionTree,
  type DocumentDivisionCandidate
} from "./hierarchical-ingestion.js";

describe("hierarchical ingestion", () => {
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
      "conversion", "structureDetection", "structureReview", "materialization", "chunking", "atomicNotes", "knowledgeGraph"
    ]);
    expect(plan.automaticallyIncludedStages).toContain("atomicNotes");
  });

  it("keeps import-only free from AI stages", () => {
    const plan = resolveProcessingPlan({
      preset: "import_only", requestedStages: [], scope: "source_only",
      targetSourceItemIds: [], forceRegeneration: false, previousArtifactPolicy: "reuse_valid"
    });
    expect(plan.effectiveStages).not.toContain("embedding");
    expect(plan.effectiveStages).not.toContain("summarization");
    expect(plan.effectiveStages).not.toContain("atomicNotes");
  });

  it("reports overlaps without rejecting adjacent divisions", () => {
    const base = {
      parentId: null, kind: "chapter", level: 0, startSelector: {}, endSelector: {},
      confidence: 0.9, evidence: [], reviewStatus: "accepted", isProcessable: true, metadata: {}
    } as const;
    const divisions: DocumentDivisionCandidate[] = [
      { ...base, id: "11111111-1111-4111-8111-111111111111", title: "One", position: 0, markdownStart: 0, markdownEnd: 10 },
      { ...base, id: "22222222-2222-4222-8222-222222222222", title: "Two", position: 1, markdownStart: 9, markdownEnd: 20 },
      { ...base, id: "33333333-3333-4333-8333-333333333333", title: "Three", position: 2, markdownStart: 20, markdownEnd: 30 }
    ];
    expect(validateDivisionTree(divisions)).toEqual([
      { code: "overlap", divisionIds: [divisions[0]!.id, divisions[1]!.id] }
    ]);
  });
});
