import { describe, expect, it } from "vitest";

import { recommendedMatchingConfiguration } from "./matching-presets.js";
import {
  SourceDecisionItemSchema,
  SourceRelationCoverageSchema,
  SourceRelationSettingsSchema,
  SourceRelationViewSchema,
  defaultSourceRelationSettings,
  equivalentSourceRelationTypes,
  promotableNoteRelationType,
  retiredSourceRelationSettingKeys,
  sourceDecisionLimits,
  sourceDecisionPassesFloors,
  sourceVerdictWriteType
} from "./source-relations.js";

describe("source relation settings of design E", () => {
  it("drops the deleted shortlist settings on read and refuses any other unknown field", () => {
    const stored = Object.fromEntries(retiredSourceRelationSettingKeys.map((key) => [key, 6]));
    expect(
      SourceRelationSettingsSchema.parse({ ...defaultSourceRelationSettings, ...stored })
    ).toEqual(defaultSourceRelationSettings);
    expect(Object.keys(defaultSourceRelationSettings)).not.toContain("maxPairs");
    expect(SourceRelationSettingsSchema.safeParse({ unknownLimit: 1 }).success).toBe(false);
  });

  it("reads coverage written before design E without its shortlist flags", () => {
    expect(
      SourceRelationCoverageSchema.parse({
        judgedPairs: 6,
        candidatePairs: 30,
        capReached: true,
        relationLimitReached: false,
        budgetExhausted: false
      })
    ).toEqual({ judgedPairs: 6, candidatePairs: 30, budgetExhausted: false });
  });
});

describe("the write vocabulary of source relations", () => {
  it("writes the judge's contrasts as contradicts and drops similar_to unless kept", () => {
    expect(sourceVerdictWriteType("contrasts", { keepSimilarTo: false })).toBe("contradicts");
    expect(sourceVerdictWriteType("similar_to", { keepSimilarTo: false })).toBeNull();
    expect(sourceVerdictWriteType("similar_to", { keepSimilarTo: true })).toBe("similar_to");
    expect(sourceVerdictWriteType("supports", { keepSimilarTo: false })).toBe("supports");
    expect(sourceVerdictWriteType("mentions", { keepSimilarTo: false })).toBe("mentions");
    expect(equivalentSourceRelationTypes("contradicts")).toEqual(["contradicts", "contrasts"]);
    expect(equivalentSourceRelationTypes("supports")).toEqual(["supports"]);
  });

  it("promotes write types and legacy contrasts, never similar_to or the weak types", () => {
    expect(promotableNoteRelationType("same_as")).toBe("same_as");
    expect(promotableNoteRelationType("contrasts")).toBe("contradicts");
    for (const type of ["similar_to", "mentions", "related", null])
      expect(promotableNoteRelationType(type)).toBeNull();
  });
});

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
    expect([floors.minImportance, floors.minConfidence]).toEqual([0.75, 0.85]);
    const passes = (type: string, importance: number, confidence: number) =>
      sourceDecisionPassesFloors({ type: type as "supports", importance, confidence }, floors);
    expect(passes("supports", 75, 85)).toBe(true);
    expect(passes("supports", 74, 100)).toBe(false);
    expect(passes("supports", 100, 84)).toBe(false);
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
      origin: "judged",
      supportCount: null,
      status: "pending_review",
      current: true,
      evidence: [],
      updatedAt: "2026-10-15T10:00:00.000Z"
    };
    expect(SourceRelationViewSchema.parse(view)).toEqual(view);
    // A promoted relation has no scores (unknown stays unknown) and may use the write vocabulary.
    const promoted = {
      ...view,
      relationType: "same_as",
      importance: null,
      confidence: null,
      origin: "promoted",
      supportCount: 3,
      writtenExplanation: null
    };
    expect(SourceRelationViewSchema.parse(promoted)).toEqual(promoted);
    expect(SourceRelationViewSchema.safeParse({ ...promoted, supportCount: 0 }).success).toBe(
      false
    );
    expect(SourceRelationViewSchema.safeParse({ ...promoted, relationType: "none" }).success).toBe(
      false
    );
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
