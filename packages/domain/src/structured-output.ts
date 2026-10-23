import { z } from "zod";

/**
 * Structured model output (F3 D35). A contract that is strict-compatible carries its JSON Schema on
 * the request; each adapter maps it to its provider's wire format. A contract that is not (open
 * records, tuples, refinements, optional members) keeps its prompt-level JSON and is validated by
 * Zod after the call, as every structured output always is.
 */

const jsonObjectSchema = z.record(z.string(), z.json());

/** The schema a request carries: a name for the provider, the JSON Schema, and whether it is strict. */
export const AiOutputSchemaSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    schema: jsonObjectSchema,
    strict: z.boolean()
  })
  .strict();
export type AiOutputSchema = z.infer<typeof AiOutputSchemaSchema>;

/** How structured output was requested from the runtime that answered (`ai_task_runs.schema_mode`). */
export const AiSchemaModeSchema = z.enum(["strict", "json", "grammar", "none"]);
export type AiSchemaMode = z.infer<typeof AiSchemaModeSchema>;

type JsonObject = Record<string, unknown>;

/** Keywords of a JSON Schema this module leaves in the schema it sends; the rest is validated by Zod. */
const portableKeywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "description"
]);

/** Keywords that make a schema unfit for strict output, with the reason a table test shows. */
const unsupportedKeywords: Readonly<Record<string, string>> = {
  prefixItems: "tuple",
  propertyNames: "open record",
  patternProperties: "open record",
  oneOf: "oneOf",
  allOf: "allOf",
  not: "not",
  if: "conditional",
  $ref: "reference",
  $defs: "reference"
};

export interface StrictJsonSchemaAnalysis {
  /** Why the contract cannot be sent strictly; empty when it can. */
  issues: string[];
  /** The portable JSON Schema; null when `issues` is not empty. */
  schema: JsonObject | null;
}

/**
 * Converts a Zod contract (its output side) to the JSON Schema a strict request sends, or explains
 * why it cannot be. Strict means every property of every object is required, objects are closed, and
 * the contract holds nothing JSON Schema cannot say: no refinement, transform, tuple or open record.
 * Validation-only keywords (string patterns and lengths, formats, defaults) are left out of the
 * schema: Zod enforces them on the answer.
 */
export function analyzeStrictJsonSchema(contract: z.ZodType): StrictJsonSchemaAnalysis {
  const issues = new Set<string>();
  let converted: JsonObject;
  try {
    converted = z.toJSONSchema(contract, {
      io: "output",
      unrepresentable: "throw",
      cycles: "throw",
      reused: "inline",
      override: (context) => {
        const definition = context.zodSchema._zod.def as {
          type: string;
          checks?: Array<{ _zod: { def: { check: string } } }>;
        };
        if (definition.checks?.some((check) => check._zod.def.check === "custom"))
          issues.add("refinement");
        if (definition.type === "pipe" || definition.type === "transform") issues.add("transform");
        if (definition.type === "lazy") issues.add("reference");
      }
    }) as JsonObject;
  } catch {
    issues.add("not representable");
    return { issues: [...issues].sort(), schema: null };
  }
  const portable = portableSchema(converted, issues) as JsonObject;
  return issues.size === 0
    ? { issues: [], schema: portable }
    : { issues: [...issues].sort(), schema: null };
}

function portableSchema(node: unknown, issues: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((item) => portableSchema(item, issues));
  if (typeof node !== "object" || node === null) return node;
  const schema = node as JsonObject;
  for (const [keyword, reason] of Object.entries(unsupportedKeywords))
    if (keyword in schema) issues.add(reason);
  const isObject =
    schema.type === "object" || "properties" in schema || "additionalProperties" in schema;
  if (isObject) {
    const properties = (schema.properties ?? {}) as JsonObject;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    if (schema.additionalProperties !== false) issues.add("open record");
    if (Object.keys(properties).some((key) => !required.includes(key)))
      issues.add("optional member");
  }
  const result: JsonObject = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (!portableKeywords.has(keyword)) continue;
    if (keyword === "properties" && typeof value === "object" && value !== null) {
      result.properties = Object.fromEntries(
        Object.entries(value as JsonObject).map(([key, member]) => [
          key,
          portableSchema(member, issues)
        ])
      );
    } else if (keyword === "items" || keyword === "anyOf") {
      result[keyword] = portableSchema(value, issues);
    } else if (
      (keyword === "minimum" || keyword === "maximum") &&
      Math.abs(value as number) === Number.MAX_SAFE_INTEGER
    ) {
      // The bounds Zod adds to every integer say nothing a provider needs.
      continue;
    } else {
      result[keyword] = value;
    }
  }
  return result;
}

/**
 * The strict output schema of a contract, or null when the contract cannot be sent strictly. The name
 * is the provider-facing label (letters, digits, `_`, `-`; `structured_output` when a caller names
 * none); it never carries content.
 */
export function toStrictJsonSchema(
  contract: z.ZodType,
  name = "structured_output"
): AiOutputSchema | null {
  const analysis = analyzeStrictJsonSchema(contract);
  if (!analysis.schema) return null;
  return AiOutputSchemaSchema.parse({ name, schema: analysis.schema, strict: true });
}

/**
 * The output contract a structured caller states in its log context (F4 D23): the Zod contract of
 * the answer and the provider-facing name of its schema. The caller never states a wire schema; the
 * AI service derives one per runtime from the contract (`outputSchemaForContract`).
 */
export interface AiOutputContract {
  name: string;
  contract: z.ZodType;
}

const strictContractSchemas = new WeakMap<z.ZodType, Map<string, AiOutputSchema | null>>();

/**
 * The strict schema a remote runtime is sent for a stated contract (F4 D23), or null when the
 * contract cannot be sent strictly (an optional member, a tuple, a refinement) and the call keeps
 * its prompt-level JSON. Cached per contract object and name: callers keep one contract per shape.
 */
export function outputSchemaForContract(output: AiOutputContract): AiOutputSchema | null {
  let byName = strictContractSchemas.get(output.contract);
  if (!byName) {
    byName = new Map();
    strictContractSchemas.set(output.contract, byName);
  }
  if (!byName.has(output.name))
    byName.set(output.name, toStrictJsonSchema(output.contract, output.name));
  return byName.get(output.name) ?? null;
}

/** The problems of a Zod failure as short lines (`path: message`), at most `limit` of them. */
export function validationProblems(error: z.ZodError, limit = 8): string[] {
  return error.issues
    .slice(0, limit)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`);
}

export interface ItemValidation<T> {
  /** The items that passed, in their original order, with the position each had in the answer. */
  valid: Array<{ index: number; value: T }>;
  /** The items that failed, with what was wrong; the answer's own position is kept. */
  invalid: Array<{ index: number; raw: unknown; problems: string[] }>;
}

/**
 * Item-level validation (D35): each member of a list is checked on its own, so valid items are kept
 * and only the invalid ones need another request. A value that is not a list has no items.
 */
export function validateItems<T>(items: unknown, schema: z.ZodType<T>): ItemValidation<T> {
  const result: ItemValidation<T> = { valid: [], invalid: [] };
  if (!Array.isArray(items)) return result;
  items.forEach((raw: unknown, index) => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) result.valid.push({ index, value: parsed.data });
    else result.invalid.push({ index, raw, problems: validationProblems(parsed.error) });
  });
  return result;
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue((value as JsonObject)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The balanced `{...}` spans of a text, outside strings, in order; an unbalanced tail is ignored. */
function topLevelObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) inString = true;
    else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) spans.push(text.slice(start, index + 1));
    }
  }
  return spans;
}

/**
 * Parses a model answer that must hold exactly one JSON object. The answer may be a code fence, carry
 * stray characters around the object (a trailing parenthesis) or repeat the same object twice;
 * anything else is an error: no object, or two different objects, is never guessed at. A value that
 * is not a string is returned unchanged.
 */
export function parseSingleJsonObject(output: unknown): unknown {
  if (typeof output !== "string") return output;
  const trimmed = output.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "")
    : trimmed;
  try {
    return JSON.parse(unfenced) as unknown;
  } catch (error) {
    const parsed: unknown[] = [];
    for (const span of topLevelObjects(unfenced)) {
      try {
        parsed.push(JSON.parse(span) as unknown);
      } catch {
        // A span that is not JSON is not an object of the answer.
      }
    }
    if (parsed.length === 0) throw error;
    const distinct = new Set(parsed.map(canonicalValue));
    if (distinct.size !== 1)
      throw new SyntaxError("The answer holds more than one different JSON object", {
        cause: error
      });
    return parsed[0];
  }
}
