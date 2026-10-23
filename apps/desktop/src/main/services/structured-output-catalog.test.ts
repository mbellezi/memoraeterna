import { describe, expect, it } from "vitest";
import {
  AtomicNoteGenerationOutputSchema,
  KnowledgeGraphGenerationOutputSchema,
  TopicOverviewOutputSchema,
  TopicOverviewPatchOutputSchema,
  analyzeStrictJsonSchema,
  outputSchemaForContract,
  relationTypingOutputSchema
} from "@app/domain";
import type { z } from "zod";

import { relationMatchOutputSchema } from "./relation-type-resolution.js";
import {
  topicAreasOutputContract,
  topicNamingOutputContract,
  topicOverviewOutputContract,
  topicOverviewPatchOutputContract
} from "./topic-tree/topic-prompts.js";

/**
 * The structured-output catalog (F3 D35): every contract a model answers, with whether it can be sent
 * as a strict output schema and, if not, why. A contract that is not strict-compatible keeps its
 * prompt-level JSON and is validated by Zod all the same; a contract is added here when a caller
 * starts to state an `outputContract`, and a change to a contract that flips its outcome shows up
 * in this table. The AI service sends a remote adapter the strict schema of a contract that has one
 * (F4 D23); the others stay prompt-level there and reach a local runtime as a grammar (T99).
 *
 * Why most of today's contracts are not strict: they were written for validation, not for a wire
 * format. Their optional members (`language`, `description`, canonical IDs) are the common cause;
 * the knowledge-graph contract also drops `claims` in a preprocessing step and checks its references
 * with a refinement; the confirmation answer is a tuple list; the naming answer has an optional
 * `aliases` member. The typing contract of T51t is designed strict from the start (keyed objects,
 * enums, every member required), and the overview and the Areas grouping happen to qualify.
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
  },
  {
    id: "topic overview patch (REFRESH, F4 D17)",
    prompts: "topic.overview.patch (repaired by topic.overview.repair)",
    contract: TopicOverviewPatchOutputSchema,
    outcome: "strict"
  },
  {
    id: "relation typing",
    prompts: "relations.type (and its re-ask)",
    contract: relationTypingOutputSchema(),
    outcome: "strict"
  },
  {
    id: "topic naming",
    prompts: "topic.name, topic.name.repair",
    contract: topicNamingOutputContract.contract,
    outcome: ["optional member"]
  },
  {
    id: "topic areas",
    prompts: "topic.areas, topic.areas.repair",
    contract: topicAreasOutputContract.contract,
    outcome: "strict"
  }
];

describe("the contracts the topic tree states", () => {
  it("names the overview's contract from the schema the catalog checks", () => {
    expect(topicOverviewOutputContract.contract).toBe(TopicOverviewOutputSchema);
  });

  it("derives a strict schema under its name for a strict contract and none for the others", () => {
    expect(outputSchemaForContract(topicOverviewOutputContract)).toMatchObject({
      name: "topic_overview",
      strict: true
    });
    expect(outputSchemaForContract(topicAreasOutputContract)).toMatchObject({
      name: "topic_areas",
      strict: true
    });
    expect(outputSchemaForContract(topicOverviewPatchOutputContract)).toMatchObject({
      name: "topic_overview_patch",
      strict: true
    });
    expect(outputSchemaForContract(topicNamingOutputContract)).toBeNull();
  });
});

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
