import { describe, expect, it } from "vitest";

import {
  directedNoteRelationTypes,
  noteRelationWriteTypes,
  symmetricNoteRelationTypes
} from "./knowledge.js";
import {
  parseRelationTypingItem,
  RelationTypingLimitsSchema,
  relationTypingAliases,
  relationTypingAnswerItems,
  relationTypingCallSchema,
  relationTypingLimits,
  relationTypingOutputSchema,
  typingDirectionCodes,
  validateRelationTypingAnswer
} from "./relation-typing.js";
import {
  toGrammarJsonSchema,
  toStrictJsonSchema,
  type AiOutputSchema
} from "./structured-output.js";

type JsonSchema = Record<string, unknown>;

/** Every node of a JSON Schema, with the path that reaches it. */
function* nodes(schema: JsonSchema, path = "#"): Generator<[string, JsonSchema]> {
  yield [path, schema];
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  for (const [key, child] of Object.entries(properties ?? {}))
    yield* nodes(child, `${path}/${key}`);
  if (schema.items) yield* nodes(schema.items as JsonSchema, `${path}/[]`);
}

describe("the typing limits (D20, D46)", () => {
  it("types at most 24 pairs per call, with one item-level re-ask", () => {
    expect(relationTypingLimits).toMatchObject({ pairsPerCall: 24, attemptsPerBatch: 2 });
    expect(
      RelationTypingLimitsSchema.safeParse({ ...relationTypingLimits, pairsPerCall: 0 }).success
    ).toBe(false);
    expect(
      RelationTypingLimitsSchema.safeParse({ ...relationTypingLimits, extra: 1 }).success
    ).toBe(false);
  });
});

describe("the direction codes of a type", () => {
  it("admits ab or ba for directed types, both for symmetric ones and none for the veto", () => {
    for (const type of directedNoteRelationTypes)
      expect(typingDirectionCodes(type)).toEqual(["ab", "ba"]);
    for (const type of symmetricNoteRelationTypes)
      expect(typingDirectionCodes(type)).toEqual(["both"]);
    expect(typingDirectionCodes("none")).toEqual(["none"]);
  });
});

/** What the AI service sends a remote runtime for the contract a typing call states (F4 D23). */
const wireSchemaOf = (maxPairs?: number): AiOutputSchema =>
  toStrictJsonSchema(relationTypingOutputSchema(maxPairs), "relation_typing")!;

describe("the wire schema", () => {
  const { name, schema, strict } = wireSchemaOf();
  const allowed = new Set([
    "type",
    "enum",
    "properties",
    "required",
    "items",
    "additionalProperties"
  ]);

  it("is strict-compatible: closed objects, every property required, no other keyword", () => {
    expect(name).toBe("relation_typing");
    expect(strict).toBe(true);
    expect(schema).not.toHaveProperty("$schema");
    for (const [path, node] of nodes(schema)) {
      expect(
        Object.keys(node).filter((key) => !allowed.has(key)),
        path
      ).toEqual([]);
      if (node.type === "object") {
        expect(node.additionalProperties, path).toBe(false);
        expect(node.required, path).toEqual(Object.keys(node.properties as object));
      }
    }
  });

  it("holds no free-text field: every string is an enum (X4)", () => {
    const strings = [...nodes(schema)].filter(([, node]) => node.type === "string");
    expect(strings.map(([path]) => path)).toEqual(["#/pairs/[]/p", "#/pairs/[]/t", "#/pairs/[]/d"]);
    for (const [path, node] of strings) expect(node.enum, path).toBeInstanceOf(Array);
  });

  it("asks for the write vocabulary plus none, the four direction codes and the call's pair ids", () => {
    const item = (schema.properties as Record<string, JsonSchema>).pairs!.items as JsonSchema;
    const props = item.properties as Record<string, JsonSchema>;
    expect(props.t!.enum).toEqual([...noteRelationWriteTypes, "none"]);
    expect(props.d!.enum).toEqual(["ab", "ba", "both", "none"]);
    expect(props.p!.enum).toEqual(relationTypingAliases(24));
    const small = wireSchemaOf(3).schema as {
      properties: { pairs: { items: JsonSchema } };
    };
    expect((small.properties.pairs.items.properties as Record<string, JsonSchema>).p!.enum).toEqual(
      ["p1", "p2", "p3"]
    );
  });

  it("agrees with the Zod contract", () => {
    const contract = relationTypingOutputSchema();
    expect(contract.safeParse({ pairs: [{ p: "p1", t: "extends", d: "ab" }] }).success).toBe(true);
    expect(contract.safeParse({ pairs: [{ p: "p25", t: "extends", d: "ab" }] }).success).toBe(
      false
    );
    expect(
      contract.safeParse({ pairs: [{ p: "p1", t: "extends", d: "ab", why: "x" }] }).success
    ).toBe(false);
  });
});

describe("one item of an answer", () => {
  it("accepts a consistent type and direction, tolerating case and separators", () => {
    expect(parseRelationTypingItem({ p: "p1", t: "extends", d: "ab" })).toEqual({
      ok: true,
      item: { alias: "p1", type: "extends", direction: "ab" }
    });
    expect(parseRelationTypingItem({ p: " P2 ", t: "Depends-On", d: "BA" })).toEqual({
      ok: true,
      item: { alias: "p2", type: "depends_on", direction: "ba" }
    });
    expect(parseRelationTypingItem({ p: "p3", t: "same_as", d: "both" }).ok).toBe(true);
    expect(parseRelationTypingItem({ p: "p4", t: "none", d: "none" }).ok).toBe(true);
  });

  it("names the problem: directed types need ab or ba, symmetric ones both, none none", () => {
    const problem = (item: unknown) => {
      const parsed = parseRelationTypingItem(item);
      return parsed.ok ? null : parsed.problem;
    };
    expect(problem({ p: "p1", t: "supports", d: "both" })).toBe("direction_mismatch");
    expect(problem({ p: "p1", t: "supports", d: "none" })).toBe("direction_mismatch");
    expect(problem({ p: "p1", t: "contradicts", d: "ab" })).toBe("direction_mismatch");
    expect(problem({ p: "p1", t: "same_as", d: "ba" })).toBe("direction_mismatch");
    expect(problem({ p: "p1", t: "none", d: "ab" })).toBe("direction_mismatch");
    expect(problem({ p: "p1", t: "similar_to", d: "both" })).toBe("invalid_type");
    expect(problem({ p: "p1", t: "supports", d: "forward" })).toBe("invalid_direction");
    expect(problem({ p: "p1", t: "supports" })).toBe("invalid_direction");
    expect(problem({ t: "supports", d: "ab" })).toBe("invalid_item");
    expect(problem("p1")).toBe("invalid_item");
  });
});

describe("an answer", () => {
  it("reads the pairs array of an object, of JSON text with or without a fence, or a bare array", () => {
    const pairs = [{ p: "p1", t: "none", d: "none" }];
    expect(relationTypingAnswerItems({ pairs })).toEqual(pairs);
    expect(relationTypingAnswerItems(JSON.stringify({ pairs }))).toEqual(pairs);
    expect(relationTypingAnswerItems("```json\n" + JSON.stringify({ pairs }) + "\n```")).toEqual(
      pairs
    );
    expect(
      relationTypingAnswerItems("Here you go: " + JSON.stringify({ pairs }) + " Done.")
    ).toEqual(pairs);
    expect(relationTypingAnswerItems(JSON.stringify(pairs))).toEqual(pairs);
    expect(relationTypingAnswerItems("no json")).toBeNull();
    expect(relationTypingAnswerItems({ result: [] })).toBeNull();
    expect(relationTypingAnswerItems(null)).toBeNull();
  });

  it("keeps the valid items and names the problem of each other asked alias", () => {
    const { accepted, problems } = validateRelationTypingAnswer(
      {
        pairs: [
          { p: "p1", t: "extends", d: "ab" },
          { p: "p2", t: "supports", d: "both" },
          { p: "p3", t: "contradicts", d: "both" },
          { p: "p9", t: "same_as", d: "both" },
          "junk"
        ]
      },
      ["p1", "p2", "p3", "p4"]
    );
    expect([...accepted.keys()]).toEqual(["p1", "p3"]);
    expect(Object.fromEntries(problems)).toEqual({ p2: "direction_mismatch", p4: "missing" });
  });

  it("counts a repeated identical item once and trusts neither of two different verdicts", () => {
    const { accepted, problems } = validateRelationTypingAnswer(
      [
        { p: "p1", t: "extends", d: "ab" },
        { p: "p1", t: "extends", d: "ab" },
        { p: "p2", t: "extends", d: "ab" },
        { p: "p2", t: "extends", d: "ba" },
        { p: "p2", t: "extends", d: "ab" }
      ],
      ["p1", "p2"]
    );
    expect([...accepted.keys()]).toEqual(["p1"]);
    expect(Object.fromEntries(problems)).toEqual({ p2: "conflicting" });
  });

  it("reports every alias as missing when the answer holds no pairs array", () => {
    const { accepted, problems } = validateRelationTypingAnswer("sorry", ["p1", "p2"]);
    expect(accepted.size).toBe(0);
    expect(Object.fromEntries(problems)).toEqual({ p1: "missing", p2: "missing" });
  });
});

describe("the answer of one call (the grammar's call contract, F4 D24)", () => {
  const asked = ["p3", "p7"];
  const contract = relationTypingCallSchema(asked);

  it("takes each asked pair once, in the order asked, under its own id", () => {
    const answer = {
      pairs: [
        { p: "p3", t: "extends", d: "ab" },
        { p: "p7", t: "none", d: "none" }
      ]
    };
    expect(contract.safeParse(answer).success).toBe(true);
    // Whatever the call contract takes, the batch contract and the validator take too.
    expect(relationTypingOutputSchema().safeParse(answer).success).toBe(true);
    const { accepted, problems } = validateRelationTypingAnswer(answer, asked);
    expect([...accepted.keys()]).toEqual(asked);
    expect(problems.size).toBe(0);
    for (const wrong of [
      { pairs: [{ p: "p3", t: "extends", d: "ab" }] },
      { pairs: [...answer.pairs].reverse() },
      { pairs: [answer.pairs[0], { p: "p1", t: "none", d: "none" }] },
      { pairs: [...answer.pairs, answer.pairs[1]] }
    ])
      expect(contract.safeParse(wrong).success).toBe(false);
  });

  it("emits a closed tuple of closed items whose ids are constants", () => {
    const schema = toGrammarJsonSchema(contract, "relation_typing")!.schema as JsonSchema;
    const pairs = (schema.properties as Record<string, JsonSchema>).pairs!;
    expect(pairs).toMatchObject({ items: false, minItems: 2, maxItems: 2 });
    expect(
      (pairs.prefixItems as JsonSchema[]).map(
        (item) => (item.properties as Record<string, JsonSchema>).p
      )
    ).toEqual([
      { type: "string", const: "p3" },
      { type: "string", const: "p7" }
    ]);
  });
});
