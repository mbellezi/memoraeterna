import { z } from "zod";

import { NoteRelationBandSchema, NoteRelationDirectionSchema } from "./knowledge.js";

/**
 * `objects.neighborhood` (docs/plan.md 4.5, F3 D43 and R30): the bounded local graph around one
 * object, in one read-only response without AI. F3 restricts it to notes (`objectTypes: ["note"]`);
 * F5 widens `objectTypes` to the other object kinds instead of replacing the read.
 *
 * Nodes are the focus, its strongest neighbours (depth 1) and, at depth 2, the neighbours of the
 * strongest depth-1 nodes. Edges are every shown relation among the chosen nodes. A relation is
 * shown through the predicates of `note-relation-sql.ts` alone (D9): applied, kept or suggested,
 * between current notes. A suggestion is an edge with `state: "suggested"`; a renderer draws it
 * apart from the relations the owner kept (decision 29). The legacy fused score is never part of
 * the answer, and the probability only ranks.
 */
export const objectNeighborhoodLimits = {
  /** Nodes in an answer, the focus included. */
  nodes: 40,
  /** Depth 2 expands the neighbours of this many strongest depth-1 nodes. */
  seeds: 12,
  /** Neighbours read for each seed before the strongest are chosen. */
  perSeed: 10,
  /** Relations of a seed read by their stored rank before the endpoints' currency is checked. */
  seedPool: 30
} as const;

/** The object kinds a neighbourhood holds. F3: notes only (R30). */
export const objectNeighborhoodTypes = ["note"] as const;
export const ObjectNeighborhoodTypeSchema = z.enum(objectNeighborhoodTypes);
export type ObjectNeighborhoodType = z.infer<typeof ObjectNeighborhoodTypeSchema>;

export const ObjectNeighborhoodInputSchema = z
  .object({
    objectId: z.string().uuid(),
    /** Restricted to `["note"]` in F3; the field exists so F5 widens the read without a new name. */
    objectTypes: z.array(ObjectNeighborhoodTypeSchema).min(1).max(1).default(["note"]),
    depth: z.union([z.literal(1), z.literal(2)]).default(1),
    limit: z
      .number()
      .int()
      .min(1)
      .max(objectNeighborhoodLimits.nodes)
      .default(objectNeighborhoodLimits.nodes)
  })
  .strict();
export type ObjectNeighborhoodInput = z.input<typeof ObjectNeighborhoodInputSchema>;
export type ObjectNeighborhoodRequest = z.infer<typeof ObjectNeighborhoodInputSchema>;

export const ObjectNeighborhoodNodeSchema = z
  .object({
    id: z.string().uuid(),
    kind: ObjectNeighborhoodTypeSchema,
    title: z.string().min(1),
    ideaStatement: z.string().min(1),
    /** Content language; null when it was stored as unknown. */
    language: z.string().min(1).nullable(),
    /** 0 is the focus, 1 a note related to it, 2 a note related to one of those. */
    depth: z.union([z.literal(0), z.literal(1), z.literal(2)])
  })
  .strict();
export type ObjectNeighborhoodNode = z.infer<typeof ObjectNeighborhoodNodeSchema>;

/**
 * What a drawn relation is: `kept` (the owner kept it), `applied` (a legacy row or one an apply
 * band wrote) or `suggested` (nobody kept it yet). Withdrawn and removed relations are never drawn.
 */
export const ObjectNeighborhoodEdgeStateSchema = z.enum(["applied", "kept", "suggested"]);
export type ObjectNeighborhoodEdgeState = z.infer<typeof ObjectNeighborhoodEdgeStateSchema>;

export const ObjectNeighborhoodEdgeSchema = z
  .object({
    id: z.string().uuid(),
    /**
     * The canonical pair, sorted by ID (`lo < hi`): the direction says how it reads. It is the
     * direction the relation may be shown in (decision 31b): an arrow only when the owner or the
     * decider gave one; `unknown` draws a line.
     */
    lo: z.string().uuid(),
    hi: z.string().uuid(),
    direction: NoteRelationDirectionSchema,
    /** The stored type; later phases add values, so renderers map unknown ones safely. */
    type: z.string().min(1).max(40),
    state: ObjectNeighborhoodEdgeStateSchema,
    /** Automation's band; null on a legacy row. */
    band: NoteRelationBandSchema.nullable()
  })
  .strict();
export type ObjectNeighborhoodEdge = z.infer<typeof ObjectNeighborhoodEdgeSchema>;

const maxEdges = (objectNeighborhoodLimits.nodes * (objectNeighborhoodLimits.nodes - 1)) / 2;

export const ObjectNeighborhoodSchema = z
  .object({
    focus: z.string().uuid(),
    depth: z.union([z.literal(1), z.literal(2)]),
    /** The focus first, then depth 1 and depth 2 in rank order. */
    nodes: z.array(ObjectNeighborhoodNodeSchema).min(1).max(objectNeighborhoodLimits.nodes),
    edges: z.array(ObjectNeighborhoodEdgeSchema).max(maxEdges),
    /** Notes related to the focus, drawn or not: the exact count of its shown relations. */
    neighbourTotal: z.number().int().nonnegative(),
    /** True when the focus has more related notes than the answer holds. */
    truncated: z.boolean()
  })
  .strict();
export type ObjectNeighborhood = z.infer<typeof ObjectNeighborhoodSchema>;

/** A note that a depth-1 note is related to, with the rank of that relation. */
export interface NeighbourCandidate {
  /** The candidate note. */
  id: string;
  /** Rank of the depth-1 note it hangs from (1 is the strongest). */
  seedRank: number;
  probability: number | null;
  finalScore: number;
}

/**
 * The second ring of a depth-2 neighbourhood: candidates rank by probability (unknown last), then
 * the stored score, then the strength of the seed they hang from, then ID. A note reachable from
 * several seeds counts once, with its best relation; the focus and the notes already chosen never
 * come back. At most `slots` are chosen.
 */
export function chooseSecondRing(
  candidates: readonly NeighbourCandidate[],
  taken: ReadonlySet<string>,
  slots: number
): string[] {
  const byProbability = (left: number | null, right: number | null) =>
    left === right ? 0 : left === null ? 1 : right === null ? -1 : right - left;
  const order = (left: NeighbourCandidate, right: NeighbourCandidate) =>
    byProbability(left.probability, right.probability) ||
    right.finalScore - left.finalScore ||
    left.seedRank - right.seedRank ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const chosen: string[] = [];
  const seen = new Set(taken);
  for (const candidate of [...candidates].sort(order)) {
    if (chosen.length >= slots) break;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    chosen.push(candidate.id);
  }
  return chosen;
}
