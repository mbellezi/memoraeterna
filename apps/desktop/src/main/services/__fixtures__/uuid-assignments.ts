import { randomUUID } from "node:crypto";

/**
 * Every import mints new UUIDs, so a prompt that depends on them (an alias assigned in UUID order, a
 * tie broken by ID) differs between two imports of identical content, and the AI cassette misses.
 * Determinism tests build the same prompt under several UUID assignments and require byte-identical
 * results. The assignments include the ascending and the descending order, which no content order
 * can match by accident, plus two random ones.
 */
export function uuidAssignments(count: number): string[][] {
  const fresh = () => Array.from({ length: count }, () => randomUUID());
  const ascending = fresh().sort();
  return [ascending, [...ascending].reverse(), fresh(), fresh()];
}

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The AI cassette key's normalization: each distinct UUID becomes a positional placeholder. */
export function withoutUuids(text: string): string {
  const seen: string[] = [];
  return text.replace(uuidPattern, (id) => {
    if (!seen.includes(id)) seen.push(id);
    return `<id${seen.indexOf(id) + 1}>`;
  });
}
