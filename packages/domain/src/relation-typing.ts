import { z } from "zod";

import {
  directedNoteRelationTypes,
  NoteRelationTypingSchema,
  symmetricNoteRelationTypes,
  type NoteRelationTyping
} from "./knowledge.js";

/**
 * The typing contract of relations v2 (F3 D20): after a source's notes are decided, the pairs the
 * decider accepted are typed by one writer call per few pairs. The answer holds only codes (a pair
 * id, a type from the write vocabulary or `none`, a direction), never prose, so no rejected
 * candidate and no accepted pair ever costs a sentence (X4).
 *
 * Positions: the two notes of a pair are shown as `a` and `b` in content order. For a directed type
 * `ab` says `a` is the subject (a supports b) and `ba` that `b` is; a symmetric type is `both`;
 * `none` is a veto with `none`. The backend maps `ab` and `ba` to the stored `lo_to_hi` and
 * `hi_to_lo` by the notes' UUIDs; the model never sees an ID.
 */

/** Part of the typer key and of the audit: bump it when the contract or its validation changes. */
export const relationTypingContractVersion = "relation-typing-v1";

/** Typed configuration of the typing step. The start values are calibrated at M1 (*(cal.)*). */
export const RelationTypingLimitsSchema = z
  .object({
    /** Pairs in one call (D20). */
    pairsPerCall: z.number().int().min(1).max(64),
    /** Model calls for one batch of pairs: the first and one item-level re-ask (D20). */
    attemptsPerBatch: z.number().int().min(1).max(3),
    /** The answer is codes only: a fixed part plus a part per pair. */
    outputTokensBase: z.number().int().min(1),
    outputTokensPerPair: z.number().int().min(1)
  })
  .strict();
export type RelationTypingLimits = z.infer<typeof RelationTypingLimitsSchema>;
export const relationTypingLimits: RelationTypingLimits = RelationTypingLimitsSchema.parse({
  pairsPerCall: 24,
  attemptsPerBatch: 2,
  outputTokensBase: 512,
  outputTokensPerPair: 48
});

/** What the typer says about the direction of one pair. */
export const RelationTypingDirectionCodeSchema = z.enum(["ab", "ba", "both", "none"]);
export type RelationTypingDirectionCode = z.infer<typeof RelationTypingDirectionCodeSchema>;

const directedTypes: readonly string[] = directedNoteRelationTypes;
const symmetricTypes: readonly string[] = symmetricNoteRelationTypes;

/** The direction codes a type admits: directed types `ab` or `ba`, symmetric `both`, `none` `none`. */
export function typingDirectionCodes(
  type: NoteRelationTyping
): readonly RelationTypingDirectionCode[] {
  if (directedTypes.includes(type)) return ["ab", "ba"];
  if (symmetricTypes.includes(type)) return ["both"];
  return ["none"];
}

/** The ids a call can carry: `p1` to `p<n>`, in content order. */
export function relationTypingAliases(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `p${index + 1}`);
}

/**
 * The Zod contract of one answer. Every property is required, objects are closed and every string
 * is an enum, so it converts to a strict JSON Schema (T55, derived per runtime from the contract the
 * caller states, F4 D23) and holds no free-text field (X4).
 */
export function relationTypingOutputSchema(maxPairs = relationTypingLimits.pairsPerCall) {
  const aliases = relationTypingAliases(maxPairs) as [string, ...string[]];
  return z.strictObject({
    pairs: z.array(
      z.strictObject({
        p: z.enum(aliases),
        t: NoteRelationTypingSchema,
        d: RelationTypingDirectionCodeSchema
      })
    )
  });
}

/** One answer item that passed validation: the type and direction are consistent. */
export interface RelationTypingItem {
  alias: string;
  type: NoteRelationTyping;
  direction: RelationTypingDirectionCode;
}

/** Why an item of an answer was not kept; the codes name the problem, never the model's text. */
export type RelationTypingProblem =
  | "missing"
  | "invalid_item"
  | "invalid_type"
  | "invalid_direction"
  | "direction_mismatch"
  | "conflicting";

/** Lower case, trimmed, spaces and hyphens as underscores: `Depends-on` is `depends_on`. */
function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
  return code || null;
}

/** One raw item of the answer, checked on its own so the others survive its defects. */
export function parseRelationTypingItem(
  raw: unknown
):
  | { ok: true; item: RelationTypingItem }
  | { ok: false; alias: string | null; problem: RelationTypingProblem } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, alias: null, problem: "invalid_item" };
  const record = raw as Record<string, unknown>;
  const alias = normalizeCode(record.p);
  if (alias === null) return { ok: false, alias: null, problem: "invalid_item" };
  const type = NoteRelationTypingSchema.safeParse(normalizeCode(record.t));
  if (!type.success) return { ok: false, alias, problem: "invalid_type" };
  const direction = RelationTypingDirectionCodeSchema.safeParse(normalizeCode(record.d));
  if (!direction.success) return { ok: false, alias, problem: "invalid_direction" };
  if (!typingDirectionCodes(type.data).includes(direction.data))
    return { ok: false, alias, problem: "direction_mismatch" };
  return { ok: true, item: { alias, type: type.data, direction: direction.data } };
}

/**
 * The items of a model's answer: the `pairs` array of the object (or of the JSON text, with or
 * without a code fence or surrounding words), or a bare array. Null when there is no such array.
 */
export function relationTypingAnswerItems(output: unknown): unknown[] | null {
  const parsed = typeof output === "string" ? parseJsonText(output) : output;
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const pairs = (parsed as Record<string, unknown>).pairs;
    if (Array.isArray(pairs)) return pairs;
  }
  return null;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const body = fenced ? (fenced[1] ?? "") : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Validates an answer against the aliases the call asked about. Valid items are kept whatever the
 * others are; an alias nobody asked about is ignored; an alias answered twice with the same verdict
 * counts once and with two verdicts is `conflicting` (neither is trusted); an asked alias with no
 * valid item is `missing` (or names its item's own problem), so one re-ask can cover exactly those.
 */
export function validateRelationTypingAnswer(
  output: unknown,
  asked: readonly string[]
): { accepted: Map<string, RelationTypingItem>; problems: Map<string, RelationTypingProblem> } {
  const accepted = new Map<string, RelationTypingItem>();
  const problems = new Map<string, RelationTypingProblem>();
  const wanted = new Set(asked);
  const items = relationTypingAnswerItems(output) ?? [];
  const seen = new Map<string, RelationTypingItem>();
  for (const raw of items) {
    const parsed = parseRelationTypingItem(raw);
    if (!parsed.ok) {
      if (parsed.alias !== null && wanted.has(parsed.alias) && !problems.has(parsed.alias))
        problems.set(parsed.alias, parsed.problem);
      continue;
    }
    const { item } = parsed;
    if (!wanted.has(item.alias)) continue;
    const earlier = seen.get(item.alias);
    if (earlier && (earlier.type !== item.type || earlier.direction !== item.direction)) {
      problems.set(item.alias, "conflicting");
      seen.delete(item.alias);
      accepted.delete(item.alias);
      continue;
    }
    if (problems.get(item.alias) === "conflicting") continue;
    seen.set(item.alias, item);
    accepted.set(item.alias, item);
    problems.delete(item.alias);
  }
  for (const alias of asked)
    if (!accepted.has(alias) && !problems.has(alias)) problems.set(alias, "missing");
  return { accepted, problems };
}
