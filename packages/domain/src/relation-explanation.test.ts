import { describe, expect, it } from "vitest";

import {
  RelationExplainInputSchema,
  RelationExplainOutcomeSchema,
  RelationExplanationResultSchema,
  RelationVetoResultSchema,
  isDirectedRelationType,
  isRelationVeto,
  relationExplanationLimits,
  relationExplanationOrder,
  relationExplanationSentinel
} from "./relation-explanation.js";

const note = (id: string, ideaStatement: string, title = "Title") => ({ id, title, ideaStatement });
const low = "00000000-0000-4000-8000-000000000001";
const high = "00000000-0000-4000-8000-000000000002";

describe("relation explanation order", () => {
  it("knows which stored and future types read in one direction", () => {
    for (const type of ["supports", "extends", "depends_on", "example_of", "clarifies"])
      expect(isDirectedRelationType(type)).toBe(true);
    for (const type of [
      "contrasts",
      "contradicts",
      "similar_to",
      "same_as",
      "related",
      "mentions",
      "unknown"
    ])
      expect(isDirectedRelationType(type)).toBe(false);
  });

  it("puts the decided subject first for a directed type", () => {
    const a = note(low, "Zeta idea"),
      b = note(high, "Alpha idea");
    const forward = relationExplanationOrder({ type: "supports", semanticSourceId: low, a, b });
    expect(forward).toEqual({ direction: "n1_to_n2", first: a, second: b });
    const reverse = relationExplanationOrder({ type: "supports", semanticSourceId: high, a, b });
    expect(reverse).toEqual({ direction: "n1_to_n2", first: b, second: a });
  });

  it("orders by content, never by ID, when the direction is unknown or the type is symmetric", () => {
    const a = note(low, "Zeta idea"),
      b = note(high, "Alpha idea");
    for (const [type, direction] of [
      ["supports", "unknown"],
      ["contrasts", "symmetric"]
    ] as const) {
      const order = relationExplanationOrder({ type, semanticSourceId: null, a, b });
      expect(order).toEqual({ direction, first: b, second: a });
      // Swapping the stored endpoints (or the IDs) gives the same prompt order.
      expect(relationExplanationOrder({ type, semanticSourceId: null, a: b, b: a })).toEqual(order);
    }
    // A symmetric type ignores a stored semantic source.
    expect(
      relationExplanationOrder({ type: "similar_to", semanticSourceId: low, a, b }).first
    ).toBe(b);
  });

  it("breaks ties on the title, and on the ID only between identical notes", () => {
    const a = note(high, "Same idea", "B title"),
      b = note(low, "Same idea", "A title");
    expect(relationExplanationOrder({ type: "related", semanticSourceId: null, a, b }).first).toBe(
      b
    );
    const c = note(high, "Same idea", "Same"),
      d = note(low, "Same idea", "Same");
    expect(
      relationExplanationOrder({ type: "related", semanticSourceId: null, a: c, b: d }).first
    ).toBe(d);
  });
});

describe("relation explanation contract", () => {
  it("validates the request and the answer strictly", () => {
    expect(RelationExplainInputSchema.parse({ relationId: low })).toEqual({ relationId: low });
    expect(() => RelationExplainInputSchema.parse({ relationId: "x" })).toThrow();
    expect(() => RelationExplainInputSchema.parse({ relationId: low, force: true })).toThrow();
    const result = {
      relationId: low,
      text: `Both describe recall in <note-ref id="${high}" />.`,
      writtenBy: "writer",
      writtenAt: "2026-10-15T10:00:00.000Z"
    };
    expect(RelationExplanationResultSchema.parse(result)).toEqual(result);
    expect(() => RelationExplanationResultSchema.parse({ ...result, writtenBy: "" })).toThrow();
  });

  it("bounds the stored text in characters, like the database check, not in UTF-16 units", () => {
    const base = {
      relationId: low,
      writtenBy: "writer",
      writtenAt: "2026-10-15T10:00:00.000Z"
    };
    const bound = relationExplanationLimits.storedCharacters;
    expect(bound).toBe(4_000);
    const at = (text: string) => RelationExplanationResultSchema.safeParse({ ...base, text });
    expect(at("a".repeat(bound)).success).toBe(true);
    expect(at("a".repeat(bound + 1)).success).toBe(false);
    expect(at("\u{1F600}".repeat(bound)).success).toBe(true);
    expect(at("\u{1F600}".repeat(bound + 1)).success).toBe(false);
    expect(at("").success).toBe(false);
  });

  it("names the request on the delta channel with an optional request ID", () => {
    const requestId = "00000000-0000-4000-8000-0000000000c1";
    expect(RelationExplainInputSchema.parse({ relationId: low, requestId })).toEqual({
      relationId: low,
      requestId
    });
    expect(() => RelationExplainInputSchema.parse({ relationId: low, requestId: "x" })).toThrow();
  });

  it("answers an explanation or the veto, nothing in between", () => {
    const explained = {
      relationId: low,
      text: "Both describe recall.",
      writtenBy: "writer",
      writtenAt: "2026-10-15T10:00:00.000Z"
    };
    const vetoed = { relationId: low, vetoed: true as const };
    expect(RelationExplainOutcomeSchema.parse(explained)).toEqual(explained);
    expect(RelationExplainOutcomeSchema.parse(vetoed)).toEqual(vetoed);
    expect(isRelationVeto(RelationExplainOutcomeSchema.parse(vetoed))).toBe(true);
    expect(isRelationVeto(RelationExplainOutcomeSchema.parse(explained))).toBe(false);
    expect(() => RelationVetoResultSchema.parse({ relationId: low, vetoed: false })).toThrow();
    expect(() => RelationExplainOutcomeSchema.parse({ ...explained, vetoed: true })).toThrow();
    expect(() => RelationExplainOutcomeSchema.parse({ relationId: low })).toThrow();
  });

  it("fixes the sentinel and the stream bounds of D22", () => {
    expect(relationExplanationSentinel).toBe("NOT_RELATED");
    expect(relationExplanationLimits.sentinelHoldCharacters).toBe(16);
    expect(relationExplanationLimits.streamCoalesceMs).toBe(50);
  });

  it("leaves room to think: the output cap is far above the answer it asks for", () => {
    // About 100 tokens of answer; a route that counts reasoning inside the cap needs the rest.
    expect(relationExplanationLimits.maxOutputTokens).toBeGreaterThanOrEqual(2_048);
  });
});
