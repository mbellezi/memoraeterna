import { describe, expect, it } from "vitest";
import {
  relationTypingCallSchema,
  relationTypingOutputSchema,
  toGrammarJsonSchema
} from "@app/domain";

import { relationMatchCallSchema } from "../../apps/desktop/src/main/services/relation-type-resolution.js";
import { confirmationAnswerContract } from "./contracts/confirmation.ts";
import { graphAnswerContract } from "./contracts/graph.ts";
import { notesAnswerContract } from "./contracts/notes.ts";
import { overviewAnswerContract } from "./contracts/overview.ts";
import { topicNamesAnswerContract } from "./contracts/topic-names.ts";
import { schemaForContract as perCallSchema } from "./grammar-schema-per-call.ts";
import { schemaForContract } from "./grammar-schema.ts";

describe("the replay's grammar schema source (F4 D24)", () => {
  it.each([
    ["notes", notesAnswerContract],
    ["graph", graphAnswerContract],
    ["confirmation", confirmationAnswerContract],
    ["topic-names", topicNamesAnswerContract],
    ["overview", overviewAnswerContract],
    ["typing", { name: "relation_typing", contract: relationTypingOutputSchema() }]
  ] as const)("sends %s its grammar schema, never a strict one", (contract, answer) => {
    const schema = schemaForContract(contract, answer);
    expect(schema).toMatchObject({ name: answer.name, strict: false });
    expect(schema!.schema).toMatchObject({ type: "object", additionalProperties: false });
  });
});

describe("the per-call grammar schema source (F4 D24)", () => {
  const rows = [
    {
      key: "r1",
      predicate: "a",
      definition: "a",
      candidates: [{ key: "c1", predicate: "b", definition: "b" }]
    },
    { key: "r2", predicate: "c", definition: "c", candidates: [] }
  ];
  const confirmation = {
    ...confirmationAnswerContract,
    callContract: relationMatchCallSchema(rows)
  };
  const typing = {
    name: "relation_typing",
    contract: relationTypingOutputSchema(),
    callContract: relationTypingCallSchema(["p2", "p5"])
  };

  it("sends a call's own schema when its flow states one, as the product's MLX adapter does", () => {
    expect(perCallSchema("confirmation", confirmation)).toEqual(
      toGrammarJsonSchema(confirmation.callContract, "confirmation")
    );
    expect(perCallSchema("typing", typing)).toEqual(
      toGrammarJsonSchema(typing.callContract, "relation_typing")
    );
    // Without one, the static grammar, as T99's source.
    expect(perCallSchema("graph", graphAnswerContract)).toEqual(
      schemaForContract("graph", graphAnswerContract)
    );
  });

  it("leaves T99's source as it was: the static grammar whatever call contract is stated", () => {
    expect(schemaForContract("confirmation", confirmation)).toEqual(
      toGrammarJsonSchema(confirmationAnswerContract.contract, "confirmation")
    );
    expect(schemaForContract("typing", typing)).toEqual(
      toGrammarJsonSchema(relationTypingOutputSchema(), "relation_typing")
    );
  });
});
