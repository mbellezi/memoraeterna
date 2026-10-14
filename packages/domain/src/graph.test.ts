import { describe, expect, it } from "vitest";

import { KnowledgeGraphGenerationOutputSchema } from "./graph.js";

const id = "11111111-1111-4111-8111-111111111111";
const entity = (key: string) => ({
  key,
  type: "Concept",
  canonicalName: key,
  identityDescription: "A concept defined in the supplied evidence.",
  confidence: 0.9,
  evidenceChunkIds: [id]
});
const relation = {
  subjectEntityKey: "a",
  predicate: "supports",
  displayLabel: "supports",
  definition: "The subject supports the object.",
  objectEntityKey: "b",
  confidence: 0.8,
  evidenceChunkIds: [id]
};

describe("knowledge graph output without claims", () => {
  const output = { entities: [entity("a"), entity("b")], relations: [relation] };

  it("is entities and relations only", () => {
    const parsed = KnowledgeGraphGenerationOutputSchema.parse(output);
    expect(Object.keys(parsed).sort()).toEqual(["entities", "relations"]);
    expect(parsed.entities.map((item) => item.key)).toEqual(["a", "b"]);
  });

  it("drops claims a model still returns, whatever they look like", () => {
    for (const claims of [[], [{ text: "A claim.", confidence: 1 }], "nonsense", null, 7]) {
      const parsed = KnowledgeGraphGenerationOutputSchema.parse({ ...output, claims });
      expect(parsed).not.toHaveProperty("claims");
      expect(parsed.relations).toHaveLength(1);
    }
  });

  it("still refuses any other unknown property and keeps its consistency rules", () => {
    expect(() => KnowledgeGraphGenerationOutputSchema.parse({ ...output, summary: "x" })).toThrow();
    expect(() =>
      KnowledgeGraphGenerationOutputSchema.parse({ entities: [entity("a")], relations: [relation] })
    ).toThrow(/unknown entity key/);
    expect(() =>
      KnowledgeGraphGenerationOutputSchema.parse({ entities: [], claims: [], relations: [] })
    ).not.toThrow();
  });
});
