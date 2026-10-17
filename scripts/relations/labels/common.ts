/**
 * Shared shapes of the F3 panel label set (T45, decisions D4 and 21, spec 5.2). The panel labels note
 * pairs and source pairs of public and synthetic libraries with three blind judges:
 *
 *   context.ts   reads a scratch clone of a measurement library (languages, roots, overviews, root
 *                neighbours, topic leaves; after sampling, the evidence excerpts of source pairs)
 *   sample.ts    draws the label set: pools A-C stratified by the MLX score, the source pairs, R_v6,
 *                the R_v9 sample of 50, and the fit/eval splits by root-pair group
 *   render.ts    writes the blind judge pages, the judge prompt and the sealed key
 *   tally.ts     reads the judges' answers: majority per question, unanimity, Fleiss kappa
 *
 * Everything lives under `.cache/f3/labels/` (never versioned); only the tally's ids, content hashes
 * and majority labels go to `scripts/fixtures/f3-relation-labels.json` (spec 4.5).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { directedNoteRelationTypes, noteRelationWriteTypes } from "@app/domain";

import { seededRandom } from "../../spikes/reranker/metrics.ts";

/** Seed of label sampling, page order and splits (spec 5.3). */
export const labelSeed = 20261018;

export const labelsDirectory = ".cache/f3/labels";

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * An independent random stream per purpose, derived from the seed: changing how one pool is drawn
 * never shifts another pool's draw.
 */
export function streamRandom(seed: number, purpose: string): () => number {
  const digest = createHash("sha256").update(`${seed}:${purpose}`).digest();
  return seededRandom(digest.readUInt32BE(0));
}

/** Fisher-Yates on a copy. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

/** Order-independent identity of a pair of ids (the smaller id first). */
export function sortedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// --- Strata ---------------------------------------------------------------------------------------

/** MLX s (max of both directions' log-odds): <0, [0, 1.5), [1.5, 3.3), [3.3, 5), >=5 (spec 5.2). */
export const stratumEdges = [0, 1.5, 3.3, 5] as const;
export const stratumShares = [0.15, 0.2, 0.3, 0.2, 0.15] as const;
export const stratumNames = ["<0", "[0,1.5)", "[1.5,3.3)", "[3.3,5)", ">=5"] as const;
export type Stratum = 0 | 1 | 2 | 3 | 4;

export function stratumOf(score: number): Stratum {
  let stratum = 0;
  while (stratum < stratumEdges.length && score >= stratumEdges[stratum]!) stratum += 1;
  return stratum as Stratum;
}

/** Splits `total` by `shares` with the largest remainder; ties go to the earlier share. */
export function quotas(total: number, shares: readonly number[]): number[] {
  const exact = shares.map((share) => share * total);
  const result = exact.map((value) => Math.floor(value + 1e-9));
  let left = total - result.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value + 1e-9) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    result[index]! += 1;
    left -= 1;
  }
  return result;
}

// --- Vocabulary -----------------------------------------------------------------------------------

/** The write vocabulary of decision D10: what a judge may answer as the type. */
export const writeTypes = noteRelationWriteTypes;
export type WriteType = (typeof noteRelationWriteTypes)[number];
export const directedTypes: readonly string[] = directedNoteRelationTypes;
export const isDirectedType = (type: string): boolean => directedTypes.includes(type);

// --- Library context (context.ts) -----------------------------------------------------------------

export const contextFormat = "memora-label-context";

const id = z.string().min(1);

export const contextSchema = z
  .object({
    format: z.literal(contextFormat),
    version: z.literal(1),
    /** The measurement profile the clone was taken from (`env-f`, `env-g`, `env-c`). */
    profile: z.string().min(1),
    libraryDigest: z.string(),
    /** How a root's vector was built (the topic tree's note-weighted root vector). */
    rootVectorBasis: z.string(),
    sources: z.array(
      z
        .object({
          id,
          parentId: z.string().nullable(),
          rootId: id,
          title: z.string(),
          language: z.string()
        })
        .strict()
    ),
    notes: z.array(
      z
        .object({
          id,
          sourceItemId: id,
          rootId: id,
          language: z.string(),
          /** The note's primary topic when it is a leaf of the active tree. */
          leafTopicId: z.string().nullable()
        })
        .strict()
    ),
    roots: z.array(
      z
        .object({
          id,
          title: z.string(),
          language: z.string(),
          /** Current notes with a vector. */
          notes: z.number().int().nonnegative(),
          overview: z.string(),
          /** `summary`: the current source summary; `opening`: the opening of its first chunk. */
          overviewBasis: z.enum(["summary", "opening", "none"]),
          /** The nearest other roots by the cosine of the root vectors (most similar first). */
          neighbours: z.array(z.object({ id, cosine: z.number() }).strict())
        })
        .strict()
    )
  })
  .strict();
export type LibraryContext = z.infer<typeof contextSchema>;

export const evidenceFormat = "memora-label-evidence";

const excerptSchema = z
  .object({
    chunkId: id,
    /** The chunk's text, whitespace collapsed. */
    text: z.string(),
    /** Where the closest note's span starts inside `text`; null when unknown. */
    focus: z.number().int().nonnegative().nullable(),
    noteId: id,
    cosine: z.number()
  })
  .strict();

export const evidenceSchema = z
  .object({
    format: z.literal(evidenceFormat),
    version: z.literal(1),
    profile: z.string().min(1),
    libraryDigest: z.string(),
    pairs: z.array(
      z
        .object({
          lo: id,
          hi: id,
          /** Up to two excerpts per side, closest cross-root note pairs first. */
          loExcerpts: z.array(excerptSchema),
          hiExcerpts: z.array(excerptSchema)
        })
        .strict()
    )
  })
  .strict();
export type LibraryEvidence = z.infer<typeof evidenceSchema>;
export type Excerpt = z.infer<typeof excerptSchema>;

// --- Label set (sample.ts) ------------------------------------------------------------------------

export const labelSetFormat = "memora-label-set";

/** The sets an item belongs to. Pools fit and evaluate; the rest are evaluation-only or reported. */
export const labelSetNames = [
  "pool-A",
  "pool-B",
  "pool-C",
  "source-base",
  "source-neighbours",
  "rv6",
  "rv9-sample",
  "lost",
  "consistency"
] as const;
export type LabelSetName = (typeof labelSetNames)[number];

export const libraryNames = ["fixture", "golden", "corpus", "spike-a"] as const;
export type LibraryName = (typeof libraryNames)[number];

const membershipSchema = z
  .object({
    set: z.enum(labelSetNames),
    /** Pool C: `hard-negative` (same leaf, different article) or `general`. */
    subpool: z.enum(["general", "hard-negative"]).nullable().default(null),
    /** Source pairs: how the pair was chosen. */
    basis: z.enum(["nearest", "second-nearest", "random"]).nullable().default(null),
    /** Source neighbour pairs: the root whose nearest or second-nearest root this is. */
    anchor: z.string().nullable().default(null)
  })
  .strict();
export type Membership = z.infer<typeof membershipSchema>;

export const labelItemSchema = z
  .object({
    /** Stable pair id: kind, library and the sorted pair. */
    pairId: id,
    kind: z.enum(["note", "source"]),
    library: z.enum(libraryNames),
    /** Sorted endpoints: note ids for note pairs, root source ids for source pairs. */
    lo: id,
    hi: id,
    loRoot: id,
    hiRoot: id,
    /** Unordered root pair of the library: no group crosses splits. */
    group: id,
    sets: z.array(membershipSchema).min(1),
    pool: z.enum(["A", "B", "C"]).nullable(),
    stratum: z.number().int().min(0).max(4).nullable(),
    /** MLX s at the provisional instruction, template and rule (max of both directions). */
    score: z.number().nullable(),
    split: z.enum(["fit", "eval"]).nullable(),
    /** Fixture partition of both roots (`tuning`, `holdout`); null outside the fixture. */
    partitions: z.tuple([z.string(), z.string()]).nullable()
  })
  .strict();
export type LabelItem = z.infer<typeof labelItemSchema>;

export const populationRowSchema = z
  .object({
    pool: z.enum(["A", "B", "C"]),
    subpool: z.enum(["general", "hard-negative"]).nullable(),
    stratum: z.number().int().min(0).max(4),
    population: z.number().int().nonnegative(),
    requested: z.number().int().nonnegative(),
    drawn: z.number().int().nonnegative()
  })
  .strict();
export type PopulationRow = z.infer<typeof populationRowSchema>;

export const labelSetSchema = z
  .object({
    format: z.literal(labelSetFormat),
    version: z.literal(1),
    seed: z.number().int(),
    /** Name of the labelling pass (`panel` for the T45 set; R_v9 lost-pair passes are named apart). */
    pass: z.string().min(1),
    rule: z.string(),
    /** SHA-256 of every input file, by role. */
    inputs: z.record(z.string(), z.string()),
    populations: z.array(populationRowSchema),
    items: z.array(labelItemSchema)
  })
  .strict();
export type LabelSet = z.infer<typeof labelSetSchema>;

// --- Sealed key (render.ts) -----------------------------------------------------------------------

export const sealedFormat = "memora-label-sealed";

export const sealedItemSchema = labelItemSchema
  .extend({
    /** Position on the pages: `<page>-<slot>`, the only id a judge sees. */
    itemId: z.string().regex(/^\d{3}-\d{2}$/u),
    page: z.number().int().positive(),
    /** Which endpoint the page shows as A. */
    shownA: z.enum(["lo", "hi"]),
    /** SHA-256 of the displayed content of both sides in lo, hi order (page position excluded). */
    contentSha256: z.string()
  })
  .strict();
export type SealedItem = z.infer<typeof sealedItemSchema>;

export const sealedSchema = z
  .object({
    format: z.literal(sealedFormat),
    version: z.literal(1),
    pass: z.string().min(1),
    seed: z.number().int(),
    labelSetSha256: z.string(),
    promptSha256: z.string(),
    pages: z.array(
      z.object({ file: z.string(), items: z.number().int(), sha256: z.string() }).strict()
    ),
    items: z.array(sealedItemSchema)
  })
  .strict();
export type Sealed = z.infer<typeof sealedSchema>;

// --- Answers (judges) -----------------------------------------------------------------------------

export const directionAnswers = ["A->B", "B->A"] as const;

/** One judge answer as written; tally validates the combination (yes needs a type, and so on). */
export const answerSchema = z
  .object({
    id: z.string(),
    related: z.enum(["yes", "no"]),
    type: z.string().nullable().optional(),
    direction: z.string().nullable().optional()
  })
  .passthrough();
export type Answer = z.infer<typeof answerSchema>;

export async function readJson<T>(path: string, schema: z.ZodType<T>, what: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(`Cannot read the ${what} "${path}".`);
  }
  return schema.parse(JSON.parse(text));
}

/** Whitespace collapsed and cut to `limit` code points; an ellipsis marks a cut. */
export function clip(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  const points = [...collapsed];
  if (points.length <= limit) return collapsed;
  return `${points.slice(0, limit).join("").trimEnd()}…`;
}
