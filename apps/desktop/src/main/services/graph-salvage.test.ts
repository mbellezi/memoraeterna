import { describe, expect, it } from "vitest";

import { normalizePredicate, salvageKnowledgeGraph } from "./graph-salvage.js";

const aliases = new Map([
  ["c1", "chunk-1"],
  ["c2", "chunk-2"]
]);

const entity = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  type: "Concept",
  identityDescription: "A concept stated in the evidence.",
  canonicalName: `Name ${key}`,
  aliases: [],
  confidence: 0.9,
  evidenceChunkIds: ["c1"],
  ...extra
});
const relation = (subject: string, object: string, extra: Record<string, unknown> = {}) => ({
  subjectEntityKey: subject,
  predicate: "relates_to",
  displayLabel: "Relates to",
  definition: "The subject relates to the object.",
  objectEntityKey: object,
  confidence: 0.8,
  evidenceChunkIds: ["c2"],
  ...extra
});

describe("normalizePredicate", () => {
  it.each([
    ["relates_to", "relates_to"],
    ["Relates To", "relates_to"],
    ["is-part-of", "is_part_of"],
    ["isPartOf", "is_part_of"],
    ["  located.in ", "located_in"],
    ["works  for", "works_for"]
  ])("reads %s as %s", (input, expected) => {
    expect(normalizePredicate(input)).toBe(expected);
  });

  it.each(["", "causes2", "relação", "a;b", "___"])("does not guess at %j", (input) => {
    expect(normalizePredicate(input)).toBeNull();
  });
});

describe("salvageKnowledgeGraph", () => {
  it("keeps a clean answer as it is, resolving evidence aliases", () => {
    const result = salvageKnowledgeGraph(
      { entities: [entity("e1"), entity("e2")], relations: [relation("e1", "e2")] },
      aliases
    );
    expect(result.nothingValid).toBe(false);
    expect(result.salvagedItems).toBe(0);
    expect(result.output.entities.map((item) => item.evidenceChunkIds)).toEqual([
      ["chunk-1"],
      ["chunk-1"]
    ]);
    expect(result.output.relations[0]?.evidenceChunkIds).toEqual(["chunk-2"]);
  });

  it("drops relations to an unknown entity key and to themselves, keeping the rest", () => {
    const result = salvageKnowledgeGraph(
      {
        entities: [entity("e1"), entity("e2")],
        relations: [
          relation("e1", "e2"),
          relation("e1", "co-presença"),
          relation("e2", "e2"),
          relation("e2", "e1", { predicate: "supports" })
        ]
      },
      aliases
    );
    expect(result.output.relations.map((item) => item.predicate)).toEqual([
      "relates_to",
      "supports"
    ]);
    expect(result.dropped).toEqual({ unknown_entity_key: 1, self_relation: 1 });
    expect(result.salvagedItems).toBe(2);
    expect(result.nothingValid).toBe(false);
    expect(result.problems).toContain("relations.1: references an unknown entity key");
  });

  it("normalizes a predicate to snake_case when that is unambiguous, and drops it otherwise", () => {
    const result = salvageKnowledgeGraph(
      {
        entities: [entity("e1"), entity("e2")],
        relations: [
          relation("e1", "e2", { predicate: "Is Part Of" }),
          relation("e2", "e1", { predicate: "causes 2 things" })
        ]
      },
      aliases
    );
    expect(result.output.relations.map((item) => item.predicate)).toEqual(["is_part_of"]);
    expect(result.normalized).toBe(1);
    expect(result.dropped).toEqual({ invalid_predicate: 1 });
  });

  it("drops an item that cites an alias the batch does not have", () => {
    const result = salvageKnowledgeGraph(
      {
        entities: [entity("e1"), entity("e2", { evidenceChunkIds: ["c9"] })],
        relations: [relation("e1", "e2")]
      },
      aliases
    );
    expect(result.output.entities.map((item) => item.key)).toEqual(["e1"]);
    // The relation lost its object with the entity.
    expect(result.output.relations).toEqual([]);
    expect(result.dropped).toEqual({ unknown_evidence_alias: 1, unknown_entity_key: 1 });
  });

  it("treats a blank optional description as no description instead of dropping the entity", () => {
    const result = salvageKnowledgeGraph(
      {
        entities: [entity("e1", { description: "  " }), entity("e2", { description: "Kept." })],
        relations: []
      },
      aliases
    );
    expect(result.output.entities.map((item) => item.description)).toEqual([undefined, "Kept."]);
    expect(result.normalized).toBe(1);
    expect(result.dropped).toEqual({});
  });

  it("ignores a canonical identity the model supplied and keeps the item", () => {
    const result = salvageKnowledgeGraph(
      {
        entities: [entity("e1", { canonicalEntityId: "ent-1" }), entity("e2")],
        relations: [relation("e1", "e2", { relationTypeId: "rel-1", originalPredicate: "x" })]
      },
      aliases
    );
    expect(result.output.entities[0]).not.toHaveProperty("canonicalEntityId");
    expect(result.output.relations[0]).not.toHaveProperty("relationTypeId");
    expect(result.output.relations[0]).not.toHaveProperty("originalPredicate");
    expect(result.normalized).toBe(2);
  });

  it("keeps the first of two entities with one key and ignores claims", () => {
    const result = salvageKnowledgeGraph(
      {
        entities: [entity("e1"), entity("e1", { canonicalName: "Other" })],
        claims: [{ anything: true }],
        relations: []
      },
      aliases
    );
    expect(result.output.entities.map((item) => item.canonicalName)).toEqual(["Name e1"]);
    expect(result.dropped).toEqual({ duplicate_entity_key: 1 });
  });

  it("keeps the entities when the relations list is missing", () => {
    const result = salvageKnowledgeGraph({ entities: [entity("e1")] }, aliases);
    expect(result.nothingValid).toBe(false);
    expect(result.output.entities).toHaveLength(1);
    expect(result.problems).toContain("relations: must be a list");
  });

  it("accepts an answer with nothing in it: there is nothing to ask again for", () => {
    const result = salvageKnowledgeGraph({ entities: [], relations: [] }, aliases);
    expect(result.nothingValid).toBe(false);
    expect(result.output).toEqual({ entities: [], relations: [] });
  });

  it("asks again only when nothing valid is left", () => {
    const noEntity = salvageKnowledgeGraph(
      { entities: [entity("e1", { type: "Spaceship" })], relations: [relation("e1", "e2")] },
      aliases
    );
    expect(noEntity.nothingValid).toBe(true);
    expect(noEntity.problems[0]).toContain("entities.0");

    const onlyRelations = salvageKnowledgeGraph(
      { entities: [], relations: [relation("e1", "e2")] },
      aliases
    );
    expect(onlyRelations.nothingValid).toBe(true);

    for (const shapeless of [null, "text", [], { other: 1 }])
      expect(salvageKnowledgeGraph(shapeless, aliases).nothingValid).toBe(true);
  });

  it("caps the lists at the contract's limits", () => {
    const result = salvageKnowledgeGraph(
      {
        entities: Array.from({ length: 105 }, (_unused, index) => entity(`e${index}`)),
        relations: []
      },
      aliases
    );
    expect(result.output.entities).toHaveLength(100);
    expect(result.dropped).toEqual({ over_limit: 5 });
  });
});
