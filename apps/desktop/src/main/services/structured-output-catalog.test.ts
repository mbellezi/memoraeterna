import { describe, expect, it } from "vitest";
import {
  AtomicNoteGenerationOutputSchema,
  KnowledgeGraphGenerationOutputSchema,
  TopicOverviewOutputSchema,
  analyzeStrictJsonSchema
} from "@app/domain";
import type { z } from "zod";

import { relationMatchOutputSchema } from "./relation-type-resolution.js";

/**
 * The structured-output catalog (F3 D35): every contract a model answers, with whether it can be sent
 * as a strict output schema and, if not, why. A contract that is not strict-compatible keeps its
 * prompt-level JSON and is validated by Zod all the same; a contract is added here when a caller
 * starts to state `outputSchema` for it, and a change to a contract that flips its outcome shows up
 * in this table.
 *
 * Why most of today's contracts are not strict: they were written for validation, not for a wire
 * format. Their optional members (`language`, `description`, canonical IDs) are the common cause;
 * the knowledge-graph contract also drops `claims` in a preprocessing step and checks its references
 * with a refinement; the confirmation answer is a tuple list. The typing contract of T51t is designed
 * strict from the start (keyed objects, enums, every member required).
 */
const catalog: Array<{
  id: string;
  prompts: string;
  contract: z.ZodType;
  /** `strict`, or the reasons the contract cannot be sent strictly. */
  outcome: "strict" | string[];
}> = [
  {
    id: "atomic notes",
    prompts: "notes.extract, notes.repair",
    contract: AtomicNoteGenerationOutputSchema,
    outcome: ["optional member"]
  },
  {
    id: "knowledge graph",
    prompts: "graph.source_chunks, graph.atomic_notes, graph.catalog_metadata (and repairs)",
    contract: KnowledgeGraphGenerationOutputSchema,
    outcome: ["optional member", "refinement", "transform"]
  },
  {
    id: "confirmation (entity identity, relation type)",
    prompts: "graph.entity_identity, graph.relation_identity (and repairs)",
    contract: relationMatchOutputSchema,
    outcome: ["tuple"]
  },
  {
    id: "topic overview",
    prompts: "topic.overview",
    contract: TopicOverviewOutputSchema,
    outcome: "strict"
  }
];

describe("the structured-output catalog", () => {
  it.each(catalog)("$id ($prompts)", ({ contract, outcome }) => {
    const analysis = analyzeStrictJsonSchema(contract);
    if (outcome === "strict") {
      expect(analysis.issues).toEqual([]);
      expect(analysis.schema).not.toBeNull();
    } else {
      expect(analysis.schema).toBeNull();
      expect(analysis.issues).toEqual(outcome);
    }
  });

  it("sends an object schema with closed objects for every strict contract", () => {
    for (const { contract, outcome } of catalog) {
      if (outcome !== "strict") continue;
      const schema = analyzeStrictJsonSchema(contract).schema!;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
    }
  });
});
