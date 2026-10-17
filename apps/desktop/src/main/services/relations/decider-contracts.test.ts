import { describe, expect, it } from "vitest";
import { z } from "zod";
import { rankResultSchema } from "@app/ai";

import { batchRerankItemSchema } from "../knowledge-processing.js";

/**
 * Exit criterion X4 (spec 5.5): no prose is written for a rejected candidate, because no decider
 * output can hold any. Every contract a decider answers in is listed here; the typing contract
 * (`relations.type`, T51t) joins the list when it lands.
 */
const deciderContracts: Record<string, z.ZodType> = {
  "ranker result (both directions, log-odds)": rankResultSchema,
  "v9 decide-only item": batchRerankItemSchema
};

/** Paths of every free-text field: a string that is neither an enum nor a constant. */
function freeTextFields(schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const node = schema as Record<string, unknown>;
  const own =
    (node.type === "string" || (Array.isArray(node.type) && node.type.includes("string"))) &&
    node.enum === undefined &&
    node.const === undefined
      ? [path]
      : [];
  return [
    ...own,
    ...Object.entries(node).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.flatMap((item, index) => freeTextFields(item, `${path}.${key}[${index}]`))
        : typeof value === "object"
          ? freeTextFields(value, `${path}.${key}`)
          : []
    )
  ];
}

describe("decider contracts (X4)", () => {
  for (const [name, schema] of Object.entries(deciderContracts))
    it(`${name} holds no free-text field`, () => {
      expect(freeTextFields(z.toJSONSchema(schema, { io: "input" }))).toEqual([]);
    });

  it("would find a free-text field", () => {
    expect(freeTextFields(z.toJSONSchema(z.object({ why: z.string() })))).toEqual([
      "$.properties.why"
    ]);
    expect(
      freeTextFields(z.toJSONSchema(z.tuple([z.number(), z.enum(["supports"]), z.string()])))
    ).toEqual(["$.prefixItems[2]"]);
  });

  it("refuses a decide-only item that carries an explanation", () => {
    expect(batchRerankItemSchema.safeParse([1, 90, "supports"]).success).toBe(true);
    expect(batchRerankItemSchema.safeParse([1, 90, "supports", "because"]).success).toBe(false);
  });
});
