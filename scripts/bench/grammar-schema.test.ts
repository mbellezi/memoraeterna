import { describe, expect, it } from "vitest";

import { confirmationAnswerContract } from "./contracts/confirmation.ts";
import { graphAnswerContract } from "./contracts/graph.ts";
import { notesAnswerContract } from "./contracts/notes.ts";
import { overviewAnswerContract } from "./contracts/overview.ts";
import { topicNamesAnswerContract } from "./contracts/topic-names.ts";
import { schemaForContract } from "./grammar-schema.ts";

describe("the replay's grammar schema source (F4 D24)", () => {
  it.each([
    ["notes", notesAnswerContract],
    ["graph", graphAnswerContract],
    ["confirmation", confirmationAnswerContract],
    ["topic-names", topicNamesAnswerContract],
    ["overview", overviewAnswerContract]
  ] as const)("sends %s its grammar schema, never a strict one", (contract, answer) => {
    const schema = schemaForContract(contract, answer);
    expect(schema).toMatchObject({ name: answer.name, strict: false });
    expect(schema!.schema).toMatchObject({ type: "object", additionalProperties: false });
  });
});
