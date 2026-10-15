import { describe, expect, it } from "vitest";

import { recommendedMatchingConfiguration } from "./matching-presets.js";
import {
  SourceDecisionItemSchema,
  SourceRelationViewSchema,
  sourceDecisionLimits,
  sourceDecisionPassesFloors
} from "./source-relations.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("source decisions without prose", () => {
  it("answers at most two items per pair with integer scores from 0 to 100", () => {
    expect(sourceDecisionLimits).toEqual({
      maxItemsPerPair: 2,
      maxChunksPerSide: 3,
      maxScore: 100
    });
    const item = {
      from: id(1),
      to: id(2),
      type: "supports",
      importance: 85,
      confidence: 80,
      fromChunks: [id(3)],
      toChunks: [id(4)],
      attempt: 0
    };
    expect(SourceDecisionItemSchema.parse(item)).toEqual(item);
    for (const invalid of [
      { importance: 0.85 },
      { confidence: 101 },
      { fromChunks: [] },
      { toChunks: [id(4), id(5), id(6), id(7)] },
      { attempt: 2 },
      { explanation: "Prose is no part of a verdict." }
    ])
      expect(SourceDecisionItemSchema.safeParse({ ...item, ...invalid }).success).toBe(false);
  });

  it("applies the preset floors to the raw scores divided by 100, weak types excluded", () => {
    const floors = recommendedMatchingConfiguration.sourceRelationSettings;
    expect([floors.minImportance, floors.minConfidence]).toEqual([0.85, 0.8]);
    const passes = (type: string, importance: number, confidence: number) =>
      sourceDecisionPassesFloors({ type: type as "supports", importance, confidence }, floors);
    expect(passes("supports", 85, 80)).toBe(true);
    expect(passes("supports", 84, 100)).toBe(false);
    expect(passes("supports", 100, 79)).toBe(false);
    expect(passes("related", 100, 100)).toBe(false);
    expect(passes("mentions", 100, 100)).toBe(false);
    expect(
      sourceDecisionPassesFloors(
        { type: "related", importance: 90, confidence: 90 },
        { ...floors, includeWeakTypes: true }
      )
    ).toBe(true);
  });

  it("lists relations without stored prose and with an explanation written on open", () => {
    const view = {
      id: id(10),
      sourceItemId: id(1),
      targetSourceItemId: id(2),
      sourceTitle: "Retrieval",
      targetTitle: "Feedback",
      relationType: "supports",
      sourceIdea: null,
      targetIdea: null,
      explanation: null,
      writtenExplanation: { text: `<source-ref id="${id(1)}" /> supports it.`, writtenBy: "m" },
      importance: 0.9,
      confidence: 0.85,
      status: "pending_review",
      current: true,
      evidence: [],
      updatedAt: "2026-10-15T10:00:00.000Z"
    };
    expect(SourceRelationViewSchema.parse(view)).toEqual(view);
    // Older relations keep the prose they stored.
    expect(
      SourceRelationViewSchema.parse({
        ...view,
        sourceIdea: "Idea",
        targetIdea: "Target",
        explanation: "Stored prose.",
        writtenExplanation: null
      }).explanation
    ).toBe("Stored prose.");
  });
});
