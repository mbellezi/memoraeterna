import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AiOutputSchemaSchema,
  analyzeStrictJsonSchema,
  grammarSchemaForContract,
  outputSchemaForContract,
  parseSingleJsonObject,
  toGrammarJsonSchema,
  toStrictJsonSchema,
  validateItems
} from "./structured-output.js";

const typing = z
  .object({
    type: z.enum(["supports", "contradicts", "extends"]),
    direction: z.enum(["n1_to_n2", "n2_to_n1"]),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(300).regex(/^\S/u),
    evidence: z.array(z.string().min(1)).min(1).max(4),
    note: z.string().nullable()
  })
  .strict();

describe("toStrictJsonSchema", () => {
  it("sends a closed object with every member required and only the structural keywords", () => {
    const output = toStrictJsonSchema(typing, "note_relation_typing");
    expect(output).not.toBeNull();
    expect(AiOutputSchemaSchema.parse(output)).toEqual(output);
    expect(output).toEqual({
      name: "note_relation_typing",
      strict: true,
      schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["supports", "contradicts", "extends"] },
          direction: { type: "string", enum: ["n1_to_n2", "n2_to_n1"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          // String lengths and patterns are Zod's to enforce on the answer.
          reason: { type: "string" },
          evidence: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
          note: { anyOf: [{ type: "string" }, { type: "null" }] }
        },
        required: ["type", "direction", "confidence", "reason", "evidence", "note"],
        additionalProperties: false
      }
    });
  });

  it("nests closed objects inside arrays", () => {
    const contract = z
      .object({
        items: z.array(z.object({ key: z.string(), score: z.number().int() }).strict())
      })
      .strict();
    const output = toStrictJsonSchema(contract, "items");
    const items = (output?.schema.properties as Record<string, { items: unknown }>).items.items;
    expect(items).toEqual({
      type: "object",
      properties: { key: { type: "string" }, score: { type: "integer" } },
      required: ["key", "score"],
      additionalProperties: false
    });
  });

  it.each([
    [
      "an optional member",
      z.object({ a: z.string(), b: z.string().optional() }),
      "optional member"
    ],
    ["an open record", z.object({ a: z.record(z.string(), z.string()) }), "open record"],
    ["a tuple", z.object({ a: z.tuple([z.string(), z.string().nullable()]) }), "tuple"],
    ["a refinement", z.object({ a: z.string() }).superRefine(() => undefined), "refinement"],
    [
      "a field refinement",
      z.object({ a: z.string().refine((value) => value.length > 0) }),
      "refinement"
    ],
    [
      "a preprocessing step",
      z.preprocess((value) => value, z.object({ a: z.string() })),
      "transform"
    ],
    ["a transform", z.object({ a: z.string().transform((value) => value) }), "not representable"]
  ])("returns null for %s", (_label, contract, reason) => {
    const analysis = analyzeStrictJsonSchema(contract);
    expect(analysis.schema).toBeNull();
    expect(analysis.issues).toContain(reason);
    expect(toStrictJsonSchema(contract, "contract")).toBeNull();
  });

  it("treats a member with a default as optional input but required output", () => {
    // The output side is what the model must produce: the default is always present there.
    const output = toStrictJsonSchema(
      z.object({ a: z.string().default("x") }).strict(),
      "with_fallback"
    );
    expect(output?.schema.required).toEqual(["a"]);
    expect(JSON.stringify(output)).not.toContain("default");
  });

  it("rejects a provider-facing name that could carry content", () => {
    expect(() => toStrictJsonSchema(typing, "has space")).toThrow();
  });
});

describe("outputSchemaForContract (F4 D23)", () => {
  it("derives the strict schema of a stated contract under its name", () => {
    expect(outputSchemaForContract({ name: "note_relation_typing", contract: typing })).toEqual(
      toStrictJsonSchema(typing, "note_relation_typing")
    );
  });

  it("derives none for a contract that cannot be sent strictly, and keeps it prompt-level", () => {
    const optional = z.object({ title: z.string(), language: z.string().optional() });
    expect(outputSchemaForContract({ name: "optional", contract: optional })).toBeNull();
    const tuple = z.object({ rows: z.array(z.tuple([z.string(), z.string()])) });
    expect(outputSchemaForContract({ name: "tuple", contract: tuple })).toBeNull();
  });

  it("converts a contract once per name", () => {
    const contract = z.object({ verdict: z.enum(["same", "different"]) }).strict();
    const first = outputSchemaForContract({ name: "verdict", contract });
    expect(outputSchemaForContract({ name: "verdict", contract })).toBe(first);
    expect(outputSchemaForContract({ name: "other_name", contract })?.name).toBe("other_name");
  });
});

describe("toGrammarJsonSchema (F4 D24)", () => {
  it("keeps patterns, lengths and bounds and closes every object", () => {
    expect(toGrammarJsonSchema(typing, "note_relation_typing")).toEqual({
      name: "note_relation_typing",
      strict: false,
      schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["supports", "contradicts", "extends"] },
          direction: { type: "string", enum: ["n1_to_n2", "n2_to_n1"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string", minLength: 1, maxLength: 300, pattern: "^\\S" },
          evidence: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: 4
          },
          note: { anyOf: [{ type: "string" }, { type: "null" }] }
        },
        required: ["type", "direction", "confidence", "reason", "evidence", "note"],
        additionalProperties: false
      }
    });
  });

  it("writes tuples as closed prefixItems with every item but trailing optional ones required", () => {
    const contract = z.object({
      pairs: z.array(z.tuple([z.string(), z.string().nullable()])).max(12),
      span: z.tuple([z.number(), z.number().optional()]),
      tail: z.tuple([z.string()], z.number())
    });
    const properties = toGrammarJsonSchema(contract)!.schema.properties as Record<string, unknown>;
    expect(properties.pairs).toEqual({
      type: "array",
      maxItems: 12,
      items: {
        type: "array",
        prefixItems: [{ type: "string" }, { anyOf: [{ type: "string" }, { type: "null" }] }],
        items: false,
        minItems: 2,
        maxItems: 2
      }
    });
    expect(properties.span).toMatchObject({ minItems: 1, maxItems: 2, items: false });
    expect(properties.tail).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
      minItems: 1
    });
  });

  it("leaves optional and defaulted members out of required and reads a preprocessed contract's input", () => {
    const contract = z.preprocess(
      (value) => value,
      z
        .object({
          title: z.string().min(1),
          language: z.enum(["en", "pt-BR"]).optional(),
          aliases: z.array(z.string()).default([])
        })
        .superRefine(() => undefined)
    );
    expect(toGrammarJsonSchema(contract)!.schema).toEqual({
      type: "object",
      properties: {
        title: { type: "string", minLength: 1 },
        language: { type: "string", enum: ["en", "pt-BR"] },
        aliases: { type: "array", items: { type: "string" } }
      },
      required: ["title"],
      additionalProperties: false
    });
  });

  it("closes a non-strict object, reads oneOf as anyOf and leaves open records and unknowns to Zod", () => {
    const contract = z.object({
      kind: z.discriminatedUnion("k", [
        z.object({ k: z.literal("a"), n: z.number().int().gt(0) }),
        z.object({ k: z.literal("b") })
      ]),
      meta: z.record(z.string(), z.string()),
      when: z.date(),
      empty: z.object({}).strict()
    });
    const properties = toGrammarJsonSchema(contract)!.schema.properties as Record<string, unknown>;
    expect(properties.kind).toEqual({
      anyOf: [
        {
          type: "object",
          properties: {
            k: { type: "string", const: "a" },
            n: { type: "integer", exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER }
          },
          required: ["k", "n"],
          additionalProperties: false
        },
        {
          type: "object",
          properties: { k: { type: "string", const: "b" } },
          required: ["k"],
          additionalProperties: false
        }
      ]
    });
    expect(properties.meta).toEqual({});
    expect(properties.when).toEqual({});
    expect(properties.empty).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false
    });
  });

  it("refuses a recursive contract and caches per contract and name", () => {
    type Tree = { children: Tree[] };
    const tree: z.ZodType<Tree> = z.lazy(() => z.object({ children: z.array(tree) }));
    expect(toGrammarJsonSchema(tree)).toBeNull();
    const contract = z.object({ verdict: z.enum(["same", "different"]) });
    const first = grammarSchemaForContract({ name: "verdict", contract });
    expect(first?.strict).toBe(false);
    expect(grammarSchemaForContract({ name: "verdict", contract })).toBe(first);
    expect(grammarSchemaForContract({ name: "other", contract })?.name).toBe("other");
  });

  it("sends a stated call contract's grammar, under the contract's name, and falls back when it is too large", () => {
    const contract = z.object({ pick: z.string() }).strict();
    const callContract = z.object({ pick: z.enum(["a", "b"]) }).strict();
    expect(grammarSchemaForContract({ name: "pick", contract, callContract })).toEqual(
      toGrammarJsonSchema(callContract, "pick")
    );
    const huge = z
      .object({ pick: z.enum(Array.from({ length: 20_000 }, (_, i) => `alias-${i}`)) })
      .strict();
    expect(grammarSchemaForContract({ name: "pick", contract, callContract: huge })).toBe(
      grammarSchemaForContract({ name: "pick", contract })
    );
  });

  it("never reads a call contract for the strict schema of a remote runtime", () => {
    const contract = z.object({ pick: z.string() }).strict();
    const callContract = z.object({ pick: z.enum(["a"]) }).strict();
    expect(outputSchemaForContract({ name: "pick", contract, callContract })).toBe(
      outputSchemaForContract({ name: "pick", contract })
    );
  });
});

describe("validateItems", () => {
  const item = z.object({ key: z.string().min(1), n: z.number() }).strict();

  it("keeps the valid items with their position and explains the others", () => {
    const result = validateItems(
      [{ key: "a", n: 1 }, { key: "", n: 2 }, "text", { key: "c", n: 3 }, { key: "d" }],
      item
    );
    expect(result.valid.map(({ index, value }) => [index, value.key])).toEqual([
      [0, "a"],
      [3, "c"]
    ]);
    expect(result.invalid.map(({ index }) => index)).toEqual([1, 2, 4]);
    expect(result.invalid[0]?.problems[0]).toContain("key");
  });

  it("finds no item in a value that is not a list", () => {
    expect(validateItems({ key: "a" }, item)).toEqual({ valid: [], invalid: [] });
  });
});

describe("parseSingleJsonObject", () => {
  const object = '{"matches":[["r1","c1"],["r2",null]]}';

  it("reads a plain object, a fenced object and a value that is not text", () => {
    expect(parseSingleJsonObject(object)).toEqual({
      matches: [
        ["r1", "c1"],
        ["r2", null]
      ]
    });
    expect(parseSingleJsonObject(`\`\`\`json\n${object}\n\`\`\``)).toEqual({
      matches: [
        ["r1", "c1"],
        ["r2", null]
      ]
    });
    expect(parseSingleJsonObject({ already: "parsed" })).toEqual({ already: "parsed" });
  });

  it("recovers an object repeated twice (a recorded local-writer defect)", () => {
    expect(parseSingleJsonObject(`${object}\n\n${object}`)).toEqual({
      matches: [
        ["r1", "c1"],
        ["r2", null]
      ]
    });
  });

  it("recovers an object followed by a stray parenthesis (a recorded local-writer defect)", () => {
    expect(parseSingleJsonObject(`${object})`)).toEqual({
      matches: [
        ["r1", "c1"],
        ["r2", null]
      ]
    });
  });

  it("never guesses between two different objects", () => {
    expect(() => parseSingleJsonObject(`${object} {"matches":[]}`)).toThrow(
      /more than one different/
    );
  });

  it("fails on an answer with no object, keeping the parser's own error", () => {
    expect(() => parseSingleJsonObject("no json here")).toThrow(SyntaxError);
    expect(() => parseSingleJsonObject('{"matches":[')).toThrow(SyntaxError);
  });

  it("does not read braces inside strings as objects", () => {
    expect(parseSingleJsonObject('{"a":"}{"} )')).toEqual({ a: "}{" });
  });
});
