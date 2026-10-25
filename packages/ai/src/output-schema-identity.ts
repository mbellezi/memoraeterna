import { createHash } from "node:crypto";
import type { AiOutputSchema } from "@app/domain";

/**
 * The identity a remote adapter remembers a refused output schema under, beside the endpoint and
 * the model: the schema's name and a hash of its body (keys sorted, so the same schema always
 * hashes alike). The name alone is not enough: one name can carry different bodies (a typing
 * contract per batch size, the DEV probe's own schemas). So a refusal of one schema never makes
 * another contract on the same model go without its own.
 */
export function outputSchemaIdentity(schema: AiOutputSchema): string {
  const body = stableJson({ schema: schema.schema, strict: schema.strict });
  return `${schema.name}\u0000${createHash("sha256").update(body).digest("hex")}`;
}

/** JSON with object keys sorted and undefined members left out, as `JSON.stringify` leaves them. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
