import { z } from "zod";

import type { ObjectKind } from "./object-address.js";

/**
 * Reciprocal rank fusion for `search.omni` (F5 D12, spec 3.4): every arm returns its best
 * `omniArmLimit` hits in rank order, and a hit scores `sum(1 / (rrfK + rank))` over the arms that
 * found it. Equal scores fall back to a deterministic order: the best arm rank, then the kind order
 * (topic, source, note, entity, question), then the title and the address, compared by code point
 * so that PostgreSQL's `collate "C"` and this module agree.
 *
 * The SQL statement of `omniSearchRepository.ts` fuses with the same constants and the same order;
 * the repository then scores and orders its rows with this module, so the score a caller sees is
 * always `rrfScore` of the arms it lists.
 */
export const rrfK = 60;

/** The hits each arm hands to the fusion. */
export const omniArmLimit = 20;

/** The arms of `search.omni`: trigram on titles and entity aliases, full text, passages, vectors. */
export const omniArmNames = ["title_trgm", "alias_trgm", "fts", "chunk_fts", "ann"] as const;
export const OmniArmNameSchema = z.enum(omniArmNames);
export type OmniArmName = z.infer<typeof OmniArmNameSchema>;

/** The kind order of the tiebreak (D12). */
export const omniKindOrder: readonly ObjectKind[] = [
  "topic",
  "source",
  "note",
  "entity",
  "question"
];

export interface OmniArmRank {
  arm: OmniArmName;
  /** 1-based rank within the arm. */
  rank: number;
}

/**
 * The fused score of the ranks a hit holds. The terms are added from the best rank down, so the
 * same ranks always give the same floating-point sum whatever order they arrive in.
 */
export function rrfScore(ranks: readonly number[]): number {
  for (const rank of ranks)
    if (!Number.isInteger(rank) || rank < 1) throw new RangeError("A rank is a positive integer.");
  return [...ranks].sort((a, b) => a - b).reduce((sum, rank) => sum + 1 / (rrfK + rank), 0);
}

/** What the tiebreak reads of a fused hit. */
export interface OmniRankedHit {
  address: string;
  kind: ObjectKind;
  title: string;
  arms: readonly OmniArmRank[];
  score: number;
}

/** Compares two strings by Unicode code point (PostgreSQL `collate "C"` on UTF-8). */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}

const bestRank = (hit: OmniRankedHit) => Math.min(...hit.arms.map((arm) => arm.rank));

/**
 * The order of fused hits: score (higher first), best arm rank, kind order, title, address. Two
 * different addresses never compare equal, so the order is total.
 */
export function compareOmniHits(a: OmniRankedHit, b: OmniRankedHit): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  const rank = bestRank(a) - bestRank(b);
  if (rank !== 0) return rank;
  const kind = omniKindOrder.indexOf(a.kind) - omniKindOrder.indexOf(b.kind);
  if (kind !== 0) return kind;
  return compareCodePoints(a.title, b.title) || compareCodePoints(a.address, b.address);
}
