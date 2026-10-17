/**
 * The offline data the F3 measurement scripts read instead of a database: an export of a library's
 * sources, notes, matching candidate lists (`similarity_debug_*`), recorded decisions
 * (`relation_decisions`) and note relations, and the pair scores of a ranker. Both are plain JSON,
 * validated here; `evaluate-matching.ts --export-relations` writes the first from a database.
 *
 * Exports hold ids, scores and ranks only: no note text and no explanations.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

const id = z.string().min(1);
const rank = z.number().int().positive().nullable();
const score = z.number().nullable();

const candidateSchema = z.object({
  /** The note being matched. */
  sourceNoteId: id,
  /** The candidate the retrieval put in its list. */
  targetNoteId: id,
  /** Rank in the fused candidate list (1 is best). */
  finalRank: z.number().int().positive(),
  textRank: rank.default(null),
  vectorRank: rank.default(null),
  graphRank: rank.default(null),
  textScore: score.default(null),
  vectorScore: score.default(null),
  metadataScore: score.default(null),
  graphScore: score.default(null),
  fusionScore: score.default(null),
  /** The decider's score (0-1) for source to target when the candidate was judged. */
  rerankScore: score.default(null),
  finalScore: score.default(null),
  passedThreshold: z.boolean().nullable().default(null)
});

const decisionSchema = z.object({
  loNoteId: id,
  hiNoteId: id,
  deciderKey: z.string().default(""),
  loToHiScore: score.default(null),
  hiToLoScore: score.default(null),
  loToHiType: z.string().nullable().default(null),
  hiToLoType: z.string().nullable().default(null),
  accepted: z.boolean().default(false)
});

const relationSchema = z.object({
  sourceNoteId: id,
  targetNoteId: id,
  status: z.string(),
  relationType: z.string().nullable().default(null),
  vectorScore: score.default(null),
  textScore: score.default(null),
  metadataScore: score.default(null),
  graphScore: score.default(null),
  rerankScore: score.default(null),
  finalScore: score.default(null),
  fusionScore: score.default(null),
  textRank: rank.default(null),
  vectorRank: rank.default(null),
  graphRank: rank.default(null),
  /** The visibility clause's verdicts when the library had them; absent on older exports. */
  shown: z.boolean().optional(),
  applied: z.boolean().optional()
});

export const relationsExportSchema = z.object({
  format: z.literal("memora-relations-export"),
  version: z.literal(1),
  sources: z.array(
    z.object({ id, parentId: z.string().nullable().default(null), title: z.string() })
  ),
  notes: z.array(z.object({ id, sourceItemId: id })),
  candidates: z.array(candidateSchema).default([]),
  decisions: z.array(decisionSchema).default([]),
  relations: z.array(relationSchema).default([]),
  context: z
    .object({
      label: z.string().nullable().default(null),
      database: z.string().nullable().default(null),
      generatedAt: z.string().nullable().default(null)
    })
    .default({ label: null, database: null, generatedAt: null })
});
export type RelationsExport = z.infer<typeof relationsExportSchema>;
export type ExportCandidate = z.infer<typeof candidateSchema>;
export type ExportDecision = z.infer<typeof decisionSchema>;
export type ExportRelation = z.infer<typeof relationSchema>;

export async function readRelationsExport(path: string): Promise<RelationsExport> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Cannot read the relations export "${path}".`);
  }
  return relationsExportSchema.parse(JSON.parse(text));
}

/** Order-independent identity of a note pair. */
export const notePairKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

// --- Pair scores ---------------------------------------------------------------------------------

/**
 * Directed scores of a ranker over note pairs: `query` is the note whose text opens the prompt, `doc`
 * the candidate. Log-odds, as Spike A's scorer writes them.
 */
export const pairScoresSchema = z.object({
  format: z.literal("memora-relations-pair-scores"),
  version: z.literal(1),
  /** Free text naming the decider and its configuration (reported, never parsed). */
  decider: z.string().default(""),
  scale: z.literal("log-odds"),
  scores: z.array(z.object({ query: id, doc: id, logOdds: z.number() }))
});
export type PairScores = z.infer<typeof pairScoresSchema>;

export async function readPairScores(path: string): Promise<PairScores> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Cannot read the pair scores "${path}".`);
  }
  return pairScoresSchema.parse(JSON.parse(text));
}

export type Aggregation = "max" | "mean";

/**
 * One score per unordered pair from its two directions: the max or the mean. A pair with one scored
 * direction only gets that score under `max` and is left out under `mean` (it was not scored both ways).
 */
export function aggregatePairScores(
  scores: PairScores,
  aggregation: Aggregation
): Map<string, number> {
  const directions = new Map<string, { forward?: number; backward?: number }>();
  for (const { query, doc, logOdds } of scores.scores) {
    const key = notePairKey(query, doc);
    const entry = directions.get(key) ?? {};
    if (query < doc) entry.forward = logOdds;
    else entry.backward = logOdds;
    directions.set(key, entry);
  }
  const result = new Map<string, number>();
  for (const [key, { forward, backward }] of directions) {
    if (forward !== undefined && backward !== undefined)
      result.set(
        key,
        aggregation === "max" ? Math.max(forward, backward) : (forward + backward) / 2
      );
    else if (aggregation === "max") result.set(key, (forward ?? backward)!);
  }
  return result;
}

/** Parses `max:3.3125` or `mean:3.16`: the aggregation of the two directions and the threshold. */
export function parseRankerRule(text: string): { aggregation: Aggregation; threshold: number } {
  const match = /^(max|mean):(-?\d+(?:\.\d+)?)$/u.exec(text);
  if (!match) throw new Error(`The ranker rule "${text}" must look like max:3.3125 or mean:3.16.`);
  return { aggregation: match[1] as Aggregation, threshold: Number(match[2]) };
}

/** Spike A's frozen MLX rule: the max of both directions at 3.3125 log-odds. */
export const spikeAFrozenRule = { aggregation: "max", threshold: 3.3125 } as const;
/** Spike A's frozen GGUF Qwen3 rule: the same aggregation at 3.1626... log-odds (about 3.16). */
export const spikeAFrozenRuleGguf = { aggregation: "max", threshold: 3.1626532246778707 } as const;

/** The retrieval depth of decision D17: 20 fused candidates per note. */
export const defaultCandidateDepth = 20;
