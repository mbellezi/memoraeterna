/** Small text helpers the contracts of the prompt-replay harness share. */
import { parseJsonOutput } from "../../../apps/desktop/src/main/services/knowledge-processing.js";

/** A name as the yield compares it: no case, no accents, letters and digits separated by one space. */
export function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Words of a name, for the overlap of two titles. */
function words(text: string): Set<string> {
  return new Set(normalizeName(text).split(" ").filter(Boolean));
}

/** The share of words two texts have in common, 1 for two empty texts. */
export function wordOverlap(left: string, right: string): number {
  const a = words(left);
  const b = words(right);
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** `part / whole`, or 1 when there is nothing to find (an empty recorded set is matched by anything). */
export function share(part: number, whole: number): number {
  return whole === 0 ? 1 : part / whole;
}

/** The size of the intersection of two lists, counted once per distinct member. */
export function intersectionSize(left: Iterable<string>, right: Iterable<string>): number {
  const b = new Set(right);
  let count = 0;
  for (const item of new Set(left)) if (b.has(item)) count += 1;
  return count;
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The JSON object of an answer as the product reads it (fence, stray text), or null. */
export function readObject(output: string): JsonRecord | null {
  try {
    const value = parseJsonOutput(output);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function stringField(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/**
 * The error code a flow reports: the product's own code when the message is one (`knowledge_graph_*`),
 * else the error's name with its `code` when it has one (`LocalDeadlineError:deadline`).
 */
export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  if (/^[a-zA-Z0-9_.:-]{1,120}$/u.test(error.message)) return error.message;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[a-zA-Z0-9_.:-]{1,60}$/u.test(code)
    ? `${error.name}:${code}`
    : error.name;
}
