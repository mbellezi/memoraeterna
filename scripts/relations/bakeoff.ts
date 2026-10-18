/**
 * The F3 decider bake-off analysis and its frozen calibration (T58; spec 3.9, 3.18, 5.5; decisions D3,
 * D4, D13, D18; review resolutions R1, R10, R18). It applies the pre-registered selection rule of
 * `docs/f3-decisions.md` (Pre-registered selection rule) to the panel's fit labels and the fixture
 * tuning partition with T57's population weights, writes the freeze record, and only then reads the
 * sets the freeze seals.
 *
 *   npx tsx scripts/relations/bakeoff.ts tuning-pairs   the pairs file of M1's tuning candidates, so a
 *                                                       configuration M1 did not run is scored on them
 *   npx tsx scripts/relations/bakeoff.ts select         the selection rule: instruction, template,
 *                                                       aggregation, isotonic maps, bands, escalation
 *   npx tsx scripts/relations/bakeoff.ts typer-pairs    the typer's position check pairs (G25)
 *   npx tsx scripts/relations/bakeoff.ts freeze --parity <parity.json> [--refreeze]
 *   npx tsx scripts/relations/bakeoff.ts gate-f [--x1-export <e> --x1-scores <s>] [--rv9-pass <tally>]
 *       [--typer-report <typer-check.json>]             the gate F reads, after the freeze only
 *
 * Sealed until `.cache/f3/freeze/frozen.json` exists (D3, C5): the fixture held-out partition, the
 * panel's eval split, R_v6 and R_v9. `select` reads the fit split of pools A-C and the tuning
 * partition only (the mapping's held-out lists are never loaded before the freeze); `gate-f` refuses
 * to run without a valid freeze record (`freeze-guard.ts`); `freeze` refuses to overwrite a freeze,
 * to freeze on a failed score-parity check (R1) and to freeze a proposal whose inputs changed.
 * Reading choices the pre-registered text leaves open are recorded in the proposal (`readings`).
 */
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  aggregateDirections,
  calibrate,
  fitIsotonic,
  relationCalibrationIdentityKey,
  RelationCalibrationEntrySchema,
  relationsConfig,
  selectBands,
  weightedPrecision,
  wilsonLowerBound,
  provisionalRelationCalibrations,
  type RelationAggregationRule,
  type RelationCalibrationBlock,
  type RelationCalibrationEntry,
  type RelationCalibrationIdentity
} from "@app/domain";
import { z } from "zod";

import {
  frozenFileLocation,
  readHeldOutAccess,
  requireHeldOut,
  type HeldOutAccess
} from "../golden/freeze-guard.ts";
import { matchingMappingSchema, type MatchingMapping } from "../golden/matching-fixture.ts";
import { notePairKey, readPairScores } from "../golden/relations-export.ts";
import { repositoryRoot } from "../spikes/reranker/dataset.ts";
import { labelSeed, shuffled, streamRandom } from "./labels/common.ts";
import { readNoteTexts } from "./note-texts.ts";
import { pairsFileFormat } from "./pair-scoring.ts";

// --- Constants -----------------------------------------------------------------------------------

export const bakeoffTask = "T58";
/** Seed of the cross-validation folds (spec 5.3). */
export const foldSeed = 20261022;
export const foldCount = 5;
export const pools = ["A", "B", "C"] as const;
export type Pool = (typeof pools)[number];
export const runtimes = ["mlx", "gguf"] as const;
export type Runtime = (typeof runtimes)[number];
/** The instructions T46b scored: Spike A's three relation texts and the model card's relation-agnostic default. */
export const instructionIds = ["mechanism", "relation", "study", "default"] as const;
export const templateBodies = [400, 600] as const;
export const aggregationRules = ["max", "mean"] as const;
/** The provisional settings (spec 3.8 step 6): the step-wise rule reads each choice at the others' values. */
export const provisionalChoice = {
  instructionId: "mechanism",
  bodyCharacters: 400,
  rule: "max"
} as const;
/** The decider the rule selects on (decisions 3 and 12): the others take its instruction, template and rule. */
export const defaultRuntime: Runtime = "mlx";
/** The pre-registered bars of D18. */
export const bandBars = {
  applyPrecision: 0.95,
  applyWilsonLower: 0.85,
  suggestPrecision: 0.8
} as const;
/** The score parity of D13 (log-odds) and the stored M1 pairs T61 compares (R1). */
export const parityBar = { maxAbsDelta: 0.125, m1Pairs: 500 } as const;
/** Gate F bars (docs/f3-decisions.md, Gates). */
export const gateFBars = {
  heldOutExpected: 27,
  heldOutForbidden: 0,
  reverseOnlyLoss: 0.05,
  typerDirectionAccuracy: 0.85,
  typerSwapConsistency: 0.9
} as const;
export const typerCheckPairCount = 60;

const cacheDirectory = join(repositoryRoot, ".cache");
export const freezeDirectory = join(cacheDirectory, "f3", "freeze");

export const defaultPaths = {
  labels: join(repositoryRoot, "scripts", "fixtures", "f3-relation-labels.json"),
  weights: join(cacheDirectory, "f3", "m1", "out", "population-weights.json"),
  labelScores: join(cacheDirectory, "f3", "scores", "bakeoff"),
  tuningExport: join(cacheDirectory, "f3", "m1", "out", "m1-run-export.json"),
  tuningScores: join(freezeDirectory, "tuning-scores"),
  mapping: join(cacheDirectory, "golden", "matching-fixture", "mapping.json"),
  v9: join(cacheDirectory, "f3", "scores", "bakeoff", "v9-verdicts.json"),
  labelTexts: join(cacheDirectory, "f3", "scores", "bakeoff", "inputs", "label-note-texts.json"),
  rv9Relations: join(cacheDirectory, "f3", "labels", "r-v9", "relations.json"),
  /** Pools B and C's populations (T57's F3-retrieval exports) and their frame scores at mechanism/600. */
  populationB: join(cacheDirectory, "f3", "m1", "export", "envg-pool-export.json"),
  populationC: join(cacheDirectory, "f3", "m1", "export", "envc-sample-pool-export.json"),
  frameB: join(
    cacheDirectory,
    "f3",
    "labels",
    "topup-2026-10-18",
    "frame",
    "pool-b",
    "labels-mlx-mechanism-t600.json"
  ),
  frameC: join(
    cacheDirectory,
    "f3",
    "labels",
    "topup-2026-10-18",
    "frame",
    "pool-c",
    "labels-mlx-mechanism-t600.json"
  ),
  parityBaselines: join(cacheDirectory, "f3", "ranker-parity"),
  proposal: join(freezeDirectory, "proposal.json"),
  gateF: join(freezeDirectory, "gate-f")
} as const;

export const scoreFileName = (runtime: Runtime, instructionId: string, body: number): string =>
  `labels-${runtime}-${instructionId}-t${body}.json`;

// --- Inputs --------------------------------------------------------------------------------------

export const sha256Hex = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export interface Hashed<T> {
  path: string;
  sha256: string;
  value: T;
}

async function readHashed<T>(path: string, parse: (value: unknown) => T): Promise<Hashed<T>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`Cannot read "${path}".`);
  }
  return { path, sha256: sha256Hex(bytes), value: parse(JSON.parse(bytes.toString("utf8"))) };
}

const labelItemSchema = z
  .object({
    pairId: z.string().min(1),
    kind: z.enum(["note", "source"]),
    library: z.string().min(1),
    lo: z.string().min(1),
    hi: z.string().min(1),
    group: z.string().min(1),
    sets: z.array(z.string().min(1)),
    pool: z.string().nullable(),
    stratum: z.number().int().min(0).max(4).nullable(),
    split: z.enum(["fit", "eval"]).nullable(),
    related: z.boolean().nullable(),
    type: z.string().nullable().optional(),
    direction: z.string().nullable().optional()
  })
  .passthrough();
export type LabelItem = z.infer<typeof labelItemSchema>;

export const labelFixtureSchema = z
  .object({
    format: z.literal("memora-f3-relation-labels"),
    version: z.literal(1),
    labelSetSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    items: z.array(labelItemSchema)
  })
  .passthrough();
export type LabelFixture = z.infer<typeof labelFixtureSchema>;

const weightRow = z.array(z.number().positive()).length(5);
export const populationWeightsSchema = z
  .object({
    strata: z.array(z.string()).length(5),
    pools: z.object({
      A: z.object({ weight: weightRow }).passthrough(),
      B: z.object({ weight: weightRow }).passthrough(),
      C: z.object({ weight: weightRow }).passthrough()
    })
  })
  .passthrough();
export type PopulationWeights = z.infer<typeof populationWeightsSchema>;

/** An F3-retrieval export (T57's `f3-retrieval.ts` and M1's `export-run.py`): ids, lists, scores. */
export const retrievalExportSchema = z
  .object({
    format: z.literal("memora-f3-retrieval-export"),
    label: z.string(),
    notes: z.array(z.object({ id: z.string().min(1), root: z.string().min(1) }).passthrough()),
    candidates: z.array(
      z
        .object({
          noteId: z.string().min(1),
          candidateId: z.string().min(1),
          contentOrder: z.number().nullable().optional()
        })
        .passthrough()
    ),
    decisions: z.array(
      z
        .object({
          lo: z.string().min(1),
          hi: z.string().min(1),
          loToHi: z.number().nullable(),
          hiToLo: z.number().nullable()
        })
        .passthrough()
    ),
    typings: z
      .array(
        z.object({ pairKey: z.string().min(1), relationType: z.string().min(1) }).passthrough()
      )
      .optional()
  })
  .passthrough();
export type RetrievalExport = z.infer<typeof retrievalExportSchema>;

export const v9VerdictsSchema = z
  .object({
    format: z.literal("memora-relations-v9-verdicts"),
    verdicts: z.array(
      z.object({ lo: z.string().min(1), hi: z.string().min(1), score: z.number() }).passthrough()
    )
  })
  .passthrough();

/** Directed log-odds by `query>doc` (`query` opens the prompt), as a score file holds them. */
export type DirectedScores = Map<string, number>;
const directedKey = (query: string, doc: string) => `${query}>${doc}`;

export interface ScoreFileFacts {
  path: string;
  sha256: string;
  decider: string;
  runtimeBuild: string | null;
  instructionSha256: string | null;
  instruction: string | null;
}

async function readScores(
  path: string
): Promise<{ scores: DirectedScores; facts: ScoreFileFacts }> {
  const bytes = await readFile(path).catch(() => {
    throw new Error(`Cannot read the pair scores "${path}".`);
  });
  const parsed = await readPairScores(path);
  const run = z
    .object({
      run: z
        .object({
          runtimeBuild: z.string().nullable().optional(),
          instructionSha256: z.string().nullable().optional(),
          instruction: z.string().nullable().optional()
        })
        .passthrough()
        .optional()
    })
    .passthrough()
    .parse(JSON.parse(bytes.toString("utf8")));
  return {
    scores: new Map(parsed.scores.map((row) => [directedKey(row.query, row.doc), row.logOdds])),
    facts: {
      path,
      sha256: sha256Hex(bytes),
      decider: parsed.decider,
      runtimeBuild: run.run?.runtimeBuild ?? null,
      instructionSha256: run.run?.instructionSha256 ?? null,
      instruction: run.run?.instruction ?? null
    }
  };
}

/** The score of an unordered pair under a rule; null when a direction is missing. */
export function pairScore(
  scores: DirectedScores,
  lo: string,
  hi: string,
  rule: RelationAggregationRule
): number | null {
  const forward = scores.get(directedKey(lo, hi));
  const backward = scores.get(directedKey(hi, lo));
  if (forward === undefined || backward === undefined) return null;
  return aggregateDirections(forward, backward, rule);
}

/** M1's in-run decisions as directed scores (the provisional configuration only). */
export function exportScores(data: Pick<RetrievalExport, "decisions">): DirectedScores {
  const scores: DirectedScores = new Map();
  for (const row of data.decisions) {
    if (row.loToHi !== null) scores.set(directedKey(row.lo, row.hi), row.loToHi);
    if (row.hiToLo !== null) scores.set(directedKey(row.hi, row.lo), row.hiToLo);
  }
  return scores;
}

// --- Labels and weights --------------------------------------------------------------------------

export interface Label {
  pairId: string;
  lo: string;
  hi: string;
  pool: Pool;
  stratum: number;
  group: string;
  positive: boolean;
  weight: number;
}

/**
 * The labelled note pairs of pools A-C in one split, each with its population weight (D4, R18): the
 * candidates of its pool and stratum in F3's retrieval over the labels of that pool and stratum.
 */
export function poolLabels(
  fixture: Pick<LabelFixture, "items">,
  weights: Pick<PopulationWeights, "pools">,
  split: "fit" | "eval"
): Label[] {
  const labels: Label[] = [];
  for (const item of fixture.items) {
    if (item.kind !== "note" || item.split !== split) continue;
    if (!(pools as readonly string[]).includes(item.pool ?? "")) continue;
    if (item.related === null || item.stratum === null) continue;
    const pool = item.pool as Pool;
    labels.push({
      pairId: item.pairId,
      lo: item.lo,
      hi: item.hi,
      pool,
      stratum: item.stratum,
      group: item.group,
      positive: item.related,
      weight: weights.pools[pool].weight[item.stratum]!
    });
  }
  return labels;
}

// --- Population weights by cell (3.9, R18; the top-up of 2026-10-18) -----------------------------

/**
 * The draw strata of the label top-up of 2026-10-18 (`.cache/f3/labels/topup-2026-10-18.md`): the proposed MLX mean of
 * both directions at 600 characters, below 0, [0, 2.15625), [2.15625, 4.375), >= 4.375. Fixed by its pre-registration,
 * whatever the selection picks.
 */
export const topupBandEdges = [0, 2.15625, 4.375] as const;
export const topupBandNames = ["<0", "[0,2.15625)", "[2.15625,4.375)", ">=4.375"] as const;

export function topupBandOf(score: number): number {
  let band = 0;
  while (band < topupBandEdges.length && score >= topupBandEdges[band]!) band++;
  return band;
}

/** `stratum`: T57's (pool, T45 stratum) cells; `stratum-and-band`: each stratum split by top-up band. */
export type CellScheme = "stratum" | "stratum-and-band";
export const cellSchemes = ["stratum", "stratum-and-band"] as const;

export interface WeightCell {
  pool: Pool;
  stratum: number;
  /** The top-up bands the cell holds after merging (one band, or [0] for the `stratum` scheme). */
  bands: number[];
  population: number;
  labels: number;
  weight: number;
}

/**
 * 3.9's weight of a label: the candidates of its cell in the population over the labels of that cell (fit and
 * eval). Under `stratum-and-band` a (pool, stratum) splits by band; a cell with candidates and no label, or labels
 * and no candidate, merges with its nearest lower band cell in the same stratum (the upper one when it is the
 * lowest), until every cell has both (the top-up's pre-registration, section 9). A stratum with candidates and no
 * label at all is reported as unrepresented; labels with no candidate in their stratum are an error.
 */
export function cellWeights(input: {
  pool: Pool;
  population: ReadonlyArray<{ stratum: number; band: number }>;
  labels: ReadonlyArray<{ key: string; stratum: number; band: number }>;
  scheme: CellScheme;
}): {
  weights: Map<string, number>;
  cells: WeightCell[];
  unrepresented: Array<{ pool: Pool; stratum: number; population: number }>;
} {
  const bandCount = input.scheme === "stratum" ? 1 : topupBandEdges.length + 1;
  const bandOf = (band: number) => (input.scheme === "stratum" ? 0 : band);
  const weights = new Map<string, number>();
  const cells: WeightCell[] = [];
  const unrepresented: Array<{ pool: Pool; stratum: number; population: number }> = [];
  for (let stratum = 0; stratum < 5; stratum++) {
    let groups = Array.from({ length: bandCount }, (_, band) => ({
      bands: [band],
      population: input.population.filter(
        (row) => row.stratum === stratum && bandOf(row.band) === band
      ).length,
      labels: input.labels
        .filter((row) => row.stratum === stratum && bandOf(row.band) === band)
        .map((row) => row.key)
    })).filter((group) => group.population > 0 || group.labels.length > 0);
    for (;;) {
      const index = groups.findIndex((group) => group.population > 0 !== group.labels.length > 0);
      if (index < 0) break;
      if (groups.length === 1) {
        const [only] = groups;
        if (only!.labels.length > 0)
          throw new Error(
            `Pool ${input.pool} stratum ${stratum} has labels and no candidate in the population.`
          );
        unrepresented.push({ pool: input.pool, stratum, population: only!.population });
        groups = [];
        break;
      }
      const low = index > 0 ? index - 1 : index;
      const left = groups[low]!,
        right = groups[low + 1]!;
      groups.splice(low, 2, {
        bands: [...left.bands, ...right.bands],
        population: left.population + right.population,
        labels: [...left.labels, ...right.labels]
      });
    }
    for (const group of groups) {
      const weight = group.population / group.labels.length;
      cells.push({
        pool: input.pool,
        stratum,
        bands: group.bands,
        population: group.population,
        labels: group.labels.length,
        weight
      });
      for (const key of group.labels) weights.set(key, weight);
    }
  }
  return { weights, cells, unrepresented };
}

/** The pairs of a pool's population: an F3-retrieval export's decided pairs with T57's stratum. */
export const populationExportSchema = z
  .object({
    decisions: z.array(
      z
        .object({
          lo: z.string().min(1),
          hi: z.string().min(1),
          stratum: z.number().int().min(0).max(4)
        })
        .passthrough()
    )
  })
  .passthrough();

export interface Weighting {
  scheme: Record<Pool, CellScheme>;
  /** The weight of every pool label (fit and eval) by pair id; R_v9 pairs have none. */
  weightOf: Map<string, number>;
  /** Note pair keys kept out of every pool statistic: R_v9 (spec 5.2, D4: evaluation-only). */
  excluded: ReadonlySet<string>;
  excludedLabels: number;
  excludedPopulation: number;
  cells: WeightCell[];
  unrepresented: Array<{ pool: Pool; stratum: number; population: number }>;
  /** SHA-256 of every input the weights come from, by role. */
  hashes: Record<string, string>;
}

/**
 * The population weights of every pool label (3.9, R18): R_v9 pairs out of the labels and the population of every
 * pool (the calibration never reads them), cells by `scheme` per pool. A label's band is its population pair's
 * frame score when it is a population pair, else its bake-off label score at mechanism/600/mean.
 */
export function buildWeighting(input: {
  items: readonly LabelItem[];
  excluded: ReadonlySet<string>;
  populations: Record<
    Pool,
    {
      pairs: ReadonlyArray<{ lo: string; hi: string; stratum: number }>;
      frame: DirectedScores | null;
      scheme: CellScheme;
    }
  >;
  labelBand: DirectedScores | null;
  hashes: Record<string, string>;
}): Weighting {
  const weightOf = new Map<string, number>();
  const cells: WeightCell[] = [];
  const unrepresented: Weighting["unrepresented"] = [];
  let excludedLabels = 0,
    excludedPopulation = 0;
  for (const pool of pools) {
    const { pairs, frame, scheme } = input.populations[pool];
    const banded = scheme === "stratum-and-band";
    if (banded && !frame) throw new Error(`Pool ${pool}: the band cells need its frame scores.`);
    const frameBand = new Map<string, number>();
    const population: Array<{ stratum: number; band: number }> = [];
    for (const pair of pairs) {
      const key = notePairKey(pair.lo, pair.hi);
      if (input.excluded.has(key)) {
        excludedPopulation++;
        continue;
      }
      let band = 0;
      if (banded) {
        const score = pairScore(frame!, pair.lo, pair.hi, "mean");
        if (score === null) throw new Error(`Pool ${pool}: no frame score for ${key}.`);
        band = topupBandOf(score);
        frameBand.set(key, band);
      }
      population.push({ stratum: pair.stratum, band });
    }
    const labels: Array<{ key: string; stratum: number; band: number }> = [];
    for (const item of input.items) {
      if (item.kind !== "note" || item.pool !== pool || item.split === null) continue;
      if (item.related === null || item.stratum === null) continue;
      const key = notePairKey(item.lo, item.hi);
      if (input.excluded.has(key)) {
        excludedLabels++;
        continue;
      }
      let band = 0;
      if (banded) {
        const fromFrame = frameBand.get(key);
        const fromLabel = input.labelBand
          ? pairScore(input.labelBand, item.lo, item.hi, "mean")
          : null;
        if (fromFrame === undefined && fromLabel === null)
          throw new Error(`Pool ${pool}: no band score for label ${item.pairId}.`);
        band = fromFrame ?? topupBandOf(fromLabel!);
      }
      labels.push({ key: item.pairId, stratum: item.stratum, band });
    }
    const result = cellWeights({ pool, population, labels, scheme });
    for (const [key, weight] of result.weights) weightOf.set(key, weight);
    cells.push(...result.cells);
    unrepresented.push(...result.unrepresented);
  }
  return {
    scheme: Object.fromEntries(
      pools.map((pool) => [pool, input.populations[pool].scheme])
    ) as Record<Pool, CellScheme>,
    weightOf,
    excluded: input.excluded,
    excludedLabels,
    excludedPopulation,
    cells,
    unrepresented,
    hashes: input.hashes
  };
}

/** `poolLabels` with the cell weights: R_v9 pairs never enter a pool statistic. */
export function weightedPoolLabels(
  fixture: Pick<LabelFixture, "items">,
  weighting: Pick<Weighting, "weightOf" | "excluded">,
  split: "fit" | "eval"
): Label[] {
  const labels: Label[] = [];
  for (const item of fixture.items) {
    if (item.kind !== "note" || item.split !== split) continue;
    if (!(pools as readonly string[]).includes(item.pool ?? "")) continue;
    if (item.related === null || item.stratum === null) continue;
    if (weighting.excluded.has(notePairKey(item.lo, item.hi))) continue;
    const weight = weighting.weightOf.get(item.pairId);
    if (weight === undefined) throw new Error(`No population weight for ${item.pairId}.`);
    labels.push({
      pairId: item.pairId,
      lo: item.lo,
      hi: item.hi,
      pool: item.pool as Pool,
      stratum: item.stratum,
      group: item.group,
      positive: item.related,
      weight
    });
  }
  return labels;
}

// --- Statistics ----------------------------------------------------------------------------------

export interface ScoredLabel {
  score: number;
  positive: boolean;
  weight?: number;
}

export interface ProbabilityLabel {
  probability: number;
  positive: boolean;
  weight?: number;
}

/**
 * The area under the ROC curve (Mann-Whitney, ties count half). Weighted, every positive-negative
 * pair counts the product of their weights. Null without both classes.
 */
export function areaUnderCurve(points: readonly ScoredLabel[], weighted = false): number | null {
  const sorted = [...points].sort((left, right) => left.score - right.score);
  let negativesBelow = 0,
    numerator = 0,
    positives = 0,
    negatives = 0;
  for (let start = 0; start < sorted.length;) {
    let end = start;
    while (end < sorted.length && sorted[end]!.score === sorted[start]!.score) end++;
    let groupPositive = 0,
      groupNegative = 0;
    for (let index = start; index < end; index++) {
      const point = sorted[index]!;
      const weight = weighted ? (point.weight ?? 1) : 1;
      if (point.positive) groupPositive += weight;
      else groupNegative += weight;
    }
    numerator += groupPositive * (negativesBelow + groupNegative / 2);
    negativesBelow += groupNegative;
    positives += groupPositive;
    negatives += groupNegative;
    start = end;
  }
  return positives > 0 && negatives > 0 ? numerator / (positives * negatives) : null;
}

const clampProbability = (value: number) => Math.min(Math.max(value, 1e-12), 1 - 1e-12);

/** The mean log-loss of probabilities, weighted by population weight or not. */
export function logLoss(points: readonly ProbabilityLabel[], weighted: boolean): number {
  let total = 0,
    weightSum = 0;
  for (const point of points) {
    const weight = weighted ? (point.weight ?? 1) : 1;
    const p = clampProbability(point.probability);
    total -= weight * (point.positive ? Math.log(p) : Math.log(1 - p));
    weightSum += weight;
  }
  if (weightSum === 0) throw new Error("A log-loss needs points.");
  return total / weightSum;
}

/** The population-weighted Brier score. */
export function brierScore(points: readonly ProbabilityLabel[]): number {
  let total = 0,
    weightSum = 0;
  for (const point of points) {
    const weight = point.weight ?? 1;
    total += weight * (point.probability - (point.positive ? 1 : 0)) ** 2;
    weightSum += weight;
  }
  if (weightSum === 0) throw new Error("A Brier score needs points.");
  return total / weightSum;
}

export interface ReliabilityBin {
  from: number;
  to: number;
  labels: number;
  weight: number;
  meanProbability: number | null;
  positiveShare: number | null;
}

/**
 * The population-weighted expected calibration error over equal-width bins of the predicted
 * probability (R18): the weight-share of each bin times the gap between its weighted positive share
 * and its weighted mean probability. The bins are the reliability table.
 */
export function expectedCalibrationError(
  points: readonly ProbabilityLabel[],
  bins = 10
): { ece: number; bins: ReliabilityBin[] } {
  const rows = Array.from({ length: bins }, (_, index) => ({
    from: index / bins,
    to: (index + 1) / bins,
    labels: 0,
    weight: 0,
    probability: 0,
    positive: 0
  }));
  let weightSum = 0;
  for (const point of points) {
    const weight = point.weight ?? 1;
    const row = rows[Math.min(bins - 1, Math.max(0, Math.floor(point.probability * bins)))]!;
    row.labels++;
    row.weight += weight;
    row.probability += weight * point.probability;
    if (point.positive) row.positive += weight;
    weightSum += weight;
  }
  if (weightSum === 0) throw new Error("An ECE needs points.");
  let ece = 0;
  for (const row of rows)
    if (row.weight > 0)
      ece +=
        (row.weight / weightSum) *
        Math.abs(row.positive / row.weight - row.probability / row.weight);
  return {
    ece,
    bins: rows.map((row) => ({
      from: row.from,
      to: row.to,
      labels: row.labels,
      weight: row.weight,
      meanProbability: row.weight > 0 ? row.probability / row.weight : null,
      positiveShare: row.weight > 0 ? row.positive / row.weight : null
    }))
  };
}

/** The population-weighted share of positives at or above a probability level. */
export function weightedRecall(points: readonly ProbabilityLabel[], level: number): number | null {
  let positives = 0,
    found = 0;
  for (const point of points) {
    if (!point.positive) continue;
    const weight = point.weight ?? 1;
    positives += weight;
    if (point.probability >= level) found += weight;
  }
  return positives > 0 ? found / positives : null;
}

// --- Cross-validation ----------------------------------------------------------------------------

/**
 * Folds by unordered root-pair group (no group crosses folds), stratified by pool and stratum: groups
 * go, largest first (seeded order among equals), to the fold whose cells are furthest below their
 * share, then to the smaller fold, then to the lower index. The split of T45 is drawn the same way.
 */
export function assignFolds(
  items: ReadonlyArray<{ group: string; cell: string }>,
  options: { folds?: number; seed?: number } = {}
): Map<string, number> {
  const folds = options.folds ?? foldCount;
  const seed = options.seed ?? foldSeed;
  const cellSize = new Map<string, number>();
  const groups = new Map<string, string[]>();
  for (const item of items) {
    cellSize.set(item.cell, (cellSize.get(item.cell) ?? 0) + 1);
    groups.set(item.group, [...(groups.get(item.group) ?? []), item.cell]);
  }
  const order = shuffled([...groups.keys()].sort(), streamRandom(seed, "folds")).sort(
    (left, right) => groups.get(right)!.length - groups.get(left)!.length
  );
  const counts = Array.from({ length: folds }, () => new Map<string, number>());
  const sizes = new Array<number>(folds).fill(0);
  const assigned = new Map<string, number>();
  for (const group of order) {
    const cells = groups.get(group)!;
    let best = 0,
      bestNeed = Number.NEGATIVE_INFINITY;
    for (let fold = 0; fold < folds; fold++) {
      let need = 0;
      for (const cell of cells)
        need += cellSize.get(cell)! / folds - (counts[fold]!.get(cell) ?? 0);
      if (
        need > bestNeed + 1e-9 ||
        (Math.abs(need - bestNeed) <= 1e-9 && sizes[fold]! < sizes[best]!)
      ) {
        best = fold;
        bestNeed = need;
      }
    }
    assigned.set(group, best);
    sizes[best]! += cells.length;
    for (const cell of cells) counts[best]!.set(cell, (counts[best]!.get(cell) ?? 0) + 1);
  }
  return assigned;
}

/** Out-of-fold probabilities: each point calibrated by the weighted fit of the other folds. */
export function crossValidatedProbabilities(
  points: ReadonlyArray<ScoredLabel & { fold: number }>,
  folds = foldCount
): number[] {
  const probabilities = new Array<number>(points.length);
  for (let fold = 0; fold < folds; fold++) {
    const train = points.filter((point) => point.fold !== fold);
    if (train.length === 0) throw new Error(`Fold ${fold} leaves nothing to fit.`);
    const blocks = fitIsotonic(train);
    points.forEach((point, index) => {
      if (point.fold === fold) probabilities[index] = calibrate(point.score, blocks);
    });
  }
  return probabilities;
}

// --- The selection rule --------------------------------------------------------------------------

export interface Configuration {
  runtime: Runtime;
  instructionId: string;
  bodyCharacters: number;
  rule: RelationAggregationRule;
}

export const configurationName = (config: Omit<Configuration, "rule"> & { rule?: string }) =>
  `${config.runtime}-${config.instructionId}-t${config.bodyCharacters}${config.rule ? `-${config.rule}` : ""}`;

/** Fit labels scored under a configuration; a label without both directions is an input error. */
export function scoredLabels(
  labels: readonly Label[],
  scores: DirectedScores,
  rule: RelationAggregationRule,
  what: string
): Array<Label & { score: number }> {
  return labels.map((label) => {
    const score = pairScore(scores, label.lo, label.hi, rule);
    if (score === null)
      throw new Error(`${what} has no score for both directions of ${label.pairId}.`);
    return { ...label, score };
  });
}

export interface RuleMeasure {
  rule: RelationAggregationRule;
  auc: number | null;
  weightedAuc: number | null;
  cvLogLoss: number;
  cvLogLossWeighted: number;
}

/** AUC and 5-fold cross-validated log-loss of one configuration's fit labels. */
export function measureRule(
  labels: readonly Label[],
  scores: DirectedScores,
  rule: RelationAggregationRule,
  folds: Map<string, number>,
  what: string
): RuleMeasure {
  const scored = scoredLabels(labels, scores, rule, what);
  const oof = crossValidatedProbabilities(
    scored.map((label) => ({ ...label, fold: folds.get(label.group)! }))
  );
  const probabilities = scored.map((label, index) => ({ ...label, probability: oof[index]! }));
  return {
    rule,
    auc: areaUnderCurve(scored),
    weightedAuc: areaUnderCurve(scored, true),
    cvLogLoss: logLoss(probabilities, false),
    cvLogLossWeighted: logLoss(probabilities, true)
  };
}

export interface ChoiceRow {
  value: string;
  auc: number | null;
  weightedAuc: number | null;
}

/** The highest value of a statistic; null when two values tie at the top (the rule's tie-break then applies). */
export function uniqueBest<T>(rows: readonly T[], statistic: (row: T) => number | null): T | null {
  let best: T | null = null,
    bestValue = Number.NEGATIVE_INFINITY,
    tied = false;
  for (const row of rows) {
    const value = statistic(row);
    if (value === null) continue;
    if (value > bestValue) {
      best = row;
      bestValue = value;
      tied = false;
    } else if (value === bestValue) tied = true;
  }
  return tied ? null : best;
}

export interface SelectionInput {
  labels: readonly Label[];
  /** Score files of the default runtime by `instruction-tbody`. */
  scores: (instructionId: string, bodyCharacters: number) => DirectedScores;
  instructionIds: readonly string[];
  bodies: readonly number[];
  folds: Map<string, number>;
}

export interface Selection {
  instruction: { rows: ChoiceRow[]; chosen: string; at: { bodyCharacters: number; rule: string } };
  template: { rows: ChoiceRow[]; chosen: number; at: { instructionId: string; rule: string } };
  rule: {
    rows: RuleMeasure[];
    chosen: RelationAggregationRule;
    at: { instructionId: string; bodyCharacters: number };
  };
  /** The same choices under the other readings of the text (weighted AUC, weighted log-loss, best over the rest). */
  readings: Record<string, { instructionId: string; bodyCharacters: number; rule: string }>;
}

/**
 * The pre-registered rule, step by step (each choice read at the provisional values of the choices
 * after it): the instruction with the highest fit-label AUC (template 400, max), the template with
 * the highest AUC at that instruction (max), the aggregation with the lower 5-fold cross-validated
 * log-loss (max on a tie). A tie on AUC is broken by the fixture-tuning count (`tieBreak`), which the
 * caller supplies; without one the rule refuses to guess.
 */
export function selectConfiguration(
  input: SelectionInput,
  tieBreak?: (
    candidates: readonly string[],
    step: "instruction" | "template",
    instructionId: string | null
  ) => string
): Selection {
  const what = (instructionId: string, body: number) => `the ${instructionId} t${body} scores`;
  const aucOf = (
    instructionId: string,
    body: number,
    rule: RelationAggregationRule,
    weighted: boolean
  ) =>
    areaUnderCurve(
      scoredLabels(
        input.labels,
        input.scores(instructionId, body),
        rule,
        what(instructionId, body)
      ),
      weighted
    );
  const pick = (
    rows: ChoiceRow[],
    step: "instruction" | "template",
    weighted = false,
    instructionId: string | null = null
  ): string => {
    const best = uniqueBest(rows, (row) => (weighted ? row.weightedAuc : row.auc));
    if (best) return best.value;
    const top = Math.max(...rows.map((row) => (weighted ? row.weightedAuc : row.auc) ?? -1));
    const tied = rows.filter((row) => ((weighted ? row.weightedAuc : row.auc) ?? -1) === top);
    if (!tieBreak)
      throw new Error(`The ${step} AUC ties (${tied.map((row) => row.value).join(", ")}).`);
    return tieBreak(
      tied.map((row) => row.value),
      step,
      instructionId
    );
  };
  const atBody = provisionalChoice.bodyCharacters;
  const atRule = provisionalChoice.rule;
  const instructionRows = input.instructionIds.map((instructionId) => ({
    value: instructionId,
    auc: aucOf(instructionId, atBody, atRule, false),
    weightedAuc: aucOf(instructionId, atBody, atRule, true)
  }));
  const instructionId = pick(instructionRows, "instruction");
  const templateRows = input.bodies.map((body) => ({
    value: String(body),
    auc: aucOf(instructionId, body, atRule, false),
    weightedAuc: aucOf(instructionId, body, atRule, true)
  }));
  const bodyCharacters = Number(pick(templateRows, "template", false, instructionId));
  const ruleRows = aggregationRules.map((rule) =>
    measureRule(
      input.labels,
      input.scores(instructionId, bodyCharacters),
      rule,
      input.folds,
      what(instructionId, bodyCharacters)
    )
  );
  const lowerLoss = (weighted: boolean): RelationAggregationRule => {
    const [max, mean] = ruleRows;
    const of = (row: RuleMeasure) => (weighted ? row.cvLogLossWeighted : row.cvLogLoss);
    return of(mean!) < of(max!) ? "mean" : "max";
  };
  const rule = lowerLoss(false);
  // The readings the text leaves open, reported beside the rule's own.
  const weightedInstruction = pick(instructionRows, "instruction", true);
  const weightedTemplate = Number(
    pick(
      input.bodies.map((body) => ({
        value: String(body),
        auc: aucOf(weightedInstruction, body, atRule, false),
        weightedAuc: aucOf(weightedInstruction, body, atRule, true)
      })),
      "template",
      true,
      weightedInstruction
    )
  );
  const weightedRule = (() => {
    const rows = aggregationRules.map((candidate) =>
      measureRule(
        input.labels,
        input.scores(weightedInstruction, weightedTemplate),
        candidate,
        input.folds,
        what(weightedInstruction, weightedTemplate)
      )
    );
    return rows[1]!.cvLogLossWeighted < rows[0]!.cvLogLossWeighted ? "mean" : "max";
  })();
  // Joint reading: the instruction and template with the highest AUC under either rule, then the rule.
  const joint = input.instructionIds
    .flatMap((candidate) =>
      input.bodies.flatMap((body) =>
        aggregationRules.map((candidateRule) => ({
          instructionId: candidate,
          bodyCharacters: body,
          auc: aucOf(candidate, body, candidateRule, false) ?? -1
        }))
      )
    )
    .sort((left, right) => right.auc - left.auc)[0]!;
  const jointRows = aggregationRules.map((candidate) =>
    measureRule(
      input.labels,
      input.scores(joint.instructionId, joint.bodyCharacters),
      candidate,
      input.folds,
      what(joint.instructionId, joint.bodyCharacters)
    )
  );
  const jointRule = jointRows[1]!.cvLogLoss < jointRows[0]!.cvLogLoss ? "mean" : "max";
  return {
    instruction: {
      rows: instructionRows,
      chosen: instructionId,
      at: { bodyCharacters: atBody, rule: atRule }
    },
    template: { rows: templateRows, chosen: bodyCharacters, at: { instructionId, rule: atRule } },
    rule: { rows: ruleRows, chosen: rule, at: { instructionId, bodyCharacters } },
    readings: {
      stepwiseUnweighted: { instructionId, bodyCharacters, rule },
      stepwiseWeighted: {
        instructionId: weightedInstruction,
        bodyCharacters: weightedTemplate,
        rule: weightedRule
      },
      jointBestAuc: {
        instructionId: joint.instructionId,
        bodyCharacters: joint.bodyCharacters,
        rule: jointRule
      }
    }
  };
}

// --- Bands ---------------------------------------------------------------------------------------

/** The lowest score whose block reaches a probability level, as `bandThresholds` reads a map. */
export function scoreAtLevel(
  blocks: readonly RelationCalibrationBlock[],
  level: number | null
): number | null {
  if (level === null) return null;
  const index = blocks.findIndex((block) => block.probability >= level);
  if (index < 0) return null;
  return index === 0 ? Number.NEGATIVE_INFINITY : blocks[index]!.fromScore;
}

export interface BandMeasure {
  level: number;
  /** Lowest score in the band under the full map. */
  fromScore: number | null;
  precision: number;
  wilsonLower: number;
  effectiveCount: number;
  recall: number | null;
  labels: number;
}

const measureAt = (
  points: readonly (ProbabilityLabel & { weight: number })[],
  level: number,
  blocks: readonly RelationCalibrationBlock[]
): BandMeasure | null => {
  const inBand = points.filter((point) => point.probability >= level);
  const precision = weightedPrecision(inBand);
  if (!precision) return null;
  return {
    level,
    fromScore: scoreAtLevel(blocks, level),
    precision: precision.precision,
    wilsonLower: precision.wilsonLower,
    effectiveCount: precision.effectiveCount,
    recall: weightedRecall(points, level),
    labels: inBand.length
  };
};

export interface BandChoice {
  pApply: number | null;
  pSuggest: number | null;
  /** Where the accept band starts in probability (p_suggest, else p_apply). */
  acceptLevel: number | null;
  apply: BandMeasure | null;
  suggest: BandMeasure | null;
  /** The cross-validated scan the rule read: every out-of-fold level with its weighted precision. */
  scan: Array<{
    level: number;
    labels: number;
    precision: number;
    wilsonLower: number;
    effectiveCount: number;
    forbiddenAtOrAbove: number;
  }>;
  forbiddenProbabilities: number[];
}

/**
 * D18's bands on the out-of-fold probabilities of the fit labels, with the forbidden fixture-tuning
 * root pairs at their best probability under the full map (`selectBands`).
 */
export function chooseBands(input: {
  oof: ReadonlyArray<ProbabilityLabel & { weight: number }>;
  blocks: readonly RelationCalibrationBlock[];
  forbiddenBestScores: readonly number[];
}): BandChoice {
  const forbiddenProbabilities = input.forbiddenBestScores.map((score) =>
    calibrate(score, input.blocks)
  );
  const { pApply, pSuggest } = selectBands({
    points: input.oof,
    forbidden: forbiddenProbabilities,
    applyPrecision: bandBars.applyPrecision,
    applyWilsonLower: bandBars.applyWilsonLower,
    suggestPrecision: bandBars.suggestPrecision
  });
  const levels = [...new Set(input.oof.map((point) => point.probability))].sort((a, b) => a - b);
  const scan = levels.map((level) => {
    const measure = weightedPrecision(input.oof.filter((point) => point.probability >= level))!;
    return {
      level,
      labels: input.oof.filter((point) => point.probability >= level).length,
      precision: measure.precision,
      wilsonLower: measure.wilsonLower,
      effectiveCount: measure.effectiveCount,
      forbiddenAtOrAbove: forbiddenProbabilities.filter((value) => value >= level).length
    };
  });
  const acceptLevel = pSuggest ?? pApply;
  return {
    pApply,
    pSuggest,
    acceptLevel,
    apply: pApply === null ? null : measureAt(input.oof, pApply, input.blocks),
    suggest: pSuggest === null ? null : measureAt(input.oof, pSuggest, input.blocks),
    scan,
    forbiddenProbabilities
  };
}

// --- The fixture tuning partition at a calibration -----------------------------------------------

export interface FixtureLists {
  expected: Array<[string, string]>;
  forbidden: Array<[string, string]>;
}

/** The tuning lists only: held-out stays sealed before the freeze (D3). */
export function tuningLists(
  mapping: Pick<MatchingMapping, "expectedRootPairs" | "forbiddenRootPairs">
): FixtureLists {
  return listsOf(mapping, "tuning");
}

export function listsOf(
  mapping: Pick<MatchingMapping, "expectedRootPairs" | "forbiddenRootPairs">,
  partition: "tuning" | "holdout"
): FixtureLists {
  const sorted = (pair: readonly [string, string]): [string, string] =>
    pair[0] < pair[1] ? [pair[0], pair[1]] : [pair[1], pair[0]];
  return {
    expected: mapping.expectedRootPairs
      .filter((row) => row.partition === partition)
      .map((row) => sorted(row.pair)),
    forbidden: mapping.forbiddenRootPairs
      .filter((row) => row.partition === partition)
      .map((row) => sorted(row.pair))
  };
}

const rootPairKey = (a: string, b: string) => (a < b ? `${a}/${b}` : `${b}/${a}`);

/**
 * A calibration as the offline reads apply it: the map gives the probability, the bands start at score
 * edges (an isotonic entry's `applyFrom` / `suggestFrom`; a probability level of D18 maps to the score
 * where its block starts, `scoreAtLevel`).
 */
export interface Calibration {
  blocks: readonly RelationCalibrationBlock[];
  applyFrom: number | null;
  suggestFrom: number | null;
  rule: RelationAggregationRule;
}

export const bandOf = (
  score: number,
  calibration: Pick<Calibration, "applyFrom" | "suggestFrom">
): "apply" | "suggest" | null =>
  calibration.applyFrom !== null && score >= calibration.applyFrom
    ? "apply"
    : calibration.suggestFrom !== null && score >= calibration.suggestFrom
      ? "suggest"
      : null;

export interface AcceptedPair {
  lo: string;
  hi: string;
  score: number;
  probability: number;
  band: "apply" | "suggest";
  typing: "typed" | "none" | "untyped";
}

/**
 * The note pairs a calibration accepts over an export's candidate lists, offline: each decided note's
 * candidates in the accept band, ranked as the matcher ranks them (band, probability, score, content
 * order) and cut to `maxShownPerNote`; the typings the export holds mark the typer's vetoes.
 */
export function acceptedPairs(input: {
  data: Pick<RetrievalExport, "candidates" | "typings">;
  scores: DirectedScores;
  calibration: Calibration;
  maxShownPerNote?: number;
}): AcceptedPair[] {
  const cap = input.maxShownPerNote ?? relationsConfig.maxShownPerNote;
  const typings = new Map<string, string>();
  for (const row of input.data.typings ?? []) {
    const [a, b] = row.pairKey.split(":");
    if (a && b) typings.set(notePairKey(a, b), row.relationType);
  }
  const byNote = new Map<string, Array<{ candidateId: string; contentOrder: number }>>();
  for (const row of input.data.candidates) {
    const list = byNote.get(row.noteId) ?? [];
    list.push({
      candidateId: row.candidateId,
      contentOrder: row.contentOrder ?? Number.MAX_SAFE_INTEGER
    });
    byNote.set(row.noteId, list);
  }
  const accepted = new Map<string, AcceptedPair>();
  for (const [noteId, list] of byNote) {
    const ranked = list
      .map((row) => {
        const lo = noteId < row.candidateId ? noteId : row.candidateId;
        const hi = noteId < row.candidateId ? row.candidateId : noteId;
        const score = pairScore(input.scores, lo, hi, input.calibration.rule);
        if (score === null) return null;
        const probability = calibrate(score, input.calibration.blocks);
        const band = bandOf(score, input.calibration);
        return band ? { lo, hi, score, probability, band, contentOrder: row.contentOrder } : null;
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort(
        (left, right) =>
          (left.band === "apply" ? 0 : 1) - (right.band === "apply" ? 0 : 1) ||
          right.probability - left.probability ||
          right.score - left.score ||
          left.contentOrder - right.contentOrder
      )
      .slice(0, cap);
    for (const row of ranked) {
      const key = notePairKey(row.lo, row.hi);
      if (accepted.has(key)) continue;
      const typed = typings.get(key);
      accepted.set(key, {
        lo: row.lo,
        hi: row.hi,
        score: row.score,
        probability: row.probability,
        band: row.band,
        typing: typed === undefined ? "untyped" : typed === "none" ? "none" : "typed"
      });
    }
  }
  return [...accepted.values()];
}

export interface RootLevel {
  expected: number;
  /** Found by the decider's band alone, before the typer's vetoes (decision 29's edge reads this). */
  expectedBeforeTyping: number;
  expectedOf: number;
  expectedPessimistic: number;
  expectedApplied: number;
  forbidden: number;
  forbiddenOf: number;
  forbiddenBeforeTyping: number;
  missed: Array<{
    pair: string;
    bestScore: number | null;
    bestProbability: number | null;
    reached: boolean;
  }>;
  forbiddenLinked: string[];
  forbiddenLinkedBeforeTyping: string[];
  /** Every forbidden root pair's best decided score (for the band rule's forbidden check). */
  forbiddenBest: Array<{ pair: string; bestScore: number | null }>;
}

/**
 * Root-pair counts of a calibration on a fixture partition: an expected root pair is found when an
 * accepted note pair joins the two roots (optimistic typing: an untyped pair counts; pessimistic: only
 * a typed pair counts; a `none` veto never counts), a forbidden one is linked likewise; same-root pairs
 * are ignored. Best scores are over every decided note pair of the root pair.
 */
export function rootLevel(input: {
  data: Pick<RetrievalExport, "notes" | "candidates" | "typings" | "decisions">;
  scores: DirectedScores;
  calibration: Calibration;
  lists: FixtureLists;
  maxShownPerNote?: number;
}): RootLevel {
  const rootOf = new Map(input.data.notes.map((note) => [note.id, note.root]));
  const accepted = acceptedPairs(input);
  const linked = {
    optimistic: new Set<string>(),
    pessimistic: new Set<string>(),
    applied: new Set<string>(),
    any: new Set<string>()
  };
  for (const pair of accepted) {
    const a = rootOf.get(pair.lo),
      b = rootOf.get(pair.hi);
    if (!a || !b || a === b) continue;
    const key = rootPairKey(a, b);
    linked.any.add(key);
    if (pair.typing === "none") continue;
    linked.optimistic.add(key);
    if (pair.typing === "typed") linked.pessimistic.add(key);
    if (pair.band === "apply") linked.applied.add(key);
  }
  const best = new Map<string, number>();
  for (const row of input.data.decisions) {
    const a = rootOf.get(row.lo),
      b = rootOf.get(row.hi);
    if (!a || !b || a === b) continue;
    const score = pairScore(input.scores, row.lo, row.hi, input.calibration.rule);
    if (score === null) continue;
    const key = rootPairKey(a, b);
    best.set(key, Math.max(best.get(key) ?? Number.NEGATIVE_INFINITY, score));
  }
  const keyOf = ([a, b]: [string, string]) => rootPairKey(a, b);
  const expectedKeys = input.lists.expected.map(keyOf);
  const forbiddenKeys = input.lists.forbidden.map(keyOf);
  const count = (keys: string[], set: Set<string>) => keys.filter((key) => set.has(key)).length;
  return {
    expected: count(expectedKeys, linked.optimistic),
    expectedBeforeTyping: count(expectedKeys, linked.any),
    expectedOf: expectedKeys.length,
    expectedPessimistic: count(expectedKeys, linked.pessimistic),
    expectedApplied: count(expectedKeys, linked.applied),
    forbidden: count(forbiddenKeys, linked.optimistic),
    forbiddenOf: forbiddenKeys.length,
    forbiddenBeforeTyping: count(forbiddenKeys, linked.any),
    missed: expectedKeys
      .filter((key) => !linked.optimistic.has(key))
      .map((key) => {
        const score = best.get(key) ?? null;
        return {
          pair: key,
          bestScore: score,
          bestProbability: score === null ? null : calibrate(score, input.calibration.blocks),
          reached: score !== null
        };
      }),
    forbiddenLinked: forbiddenKeys.filter((key) => linked.optimistic.has(key)),
    forbiddenLinkedBeforeTyping: forbiddenKeys.filter((key) => linked.any.has(key)),
    forbiddenBest: forbiddenKeys.map((key) => ({ pair: key, bestScore: best.get(key) ?? null }))
  };
}

/**
 * The rule's tie-break: expected tuning root pairs found at zero forbidden, i.e. whose best decided
 * score lies above every forbidden tuning root pair's best score (the strictest threshold that links
 * no forbidden pair).
 */
export function expectedAtZeroForbidden(input: {
  data: Pick<RetrievalExport, "notes" | "decisions">;
  scores: DirectedScores;
  lists: FixtureLists;
  rule: RelationAggregationRule;
}): number {
  const rootOf = new Map(input.data.notes.map((note) => [note.id, note.root]));
  const best = new Map<string, number>();
  for (const row of input.data.decisions) {
    const a = rootOf.get(row.lo),
      b = rootOf.get(row.hi);
    if (!a || !b || a === b) continue;
    const score = pairScore(input.scores, row.lo, row.hi, input.rule);
    if (score === null) continue;
    const key = rootPairKey(a, b);
    best.set(key, Math.max(best.get(key) ?? Number.NEGATIVE_INFINITY, score));
  }
  const ceiling = Math.max(
    Number.NEGATIVE_INFINITY,
    ...input.lists.forbidden.map(
      ([a, b]) => best.get(rootPairKey(a, b)) ?? Number.NEGATIVE_INFINITY
    )
  );
  return input.lists.expected.filter(
    ([a, b]) => (best.get(rootPairKey(a, b)) ?? Number.NEGATIVE_INFINITY) > ceiling
  ).length;
}

// --- Plan decision 29: the decide threshold from the fixture tuning partition ---------------------

export interface PanelAtEdge {
  labels: number;
  precision: number | null;
  wilson: number | null;
  neff: number | null;
  recall: number | null;
}

export interface DecideThreshold {
  basis: string;
  /** The suggest band starts at this score; null when no edge finds an expected pair at 0 forbidden. */
  edge: number | null;
  /** The map's probability at the edge (reported). */
  probability: number | null;
  expectedBeforeTyping: number;
  forbiddenBeforeTyping: number;
  expectedOf: number;
  forbiddenOf: number;
  /** Candidate edges looked at (every distinct decided tuning score). */
  candidates: number;
  /** Reported, not gating (decision 29): the panel's fit labels at or above the edge, in sample. */
  panel: Record<string, PanelAtEdge>;
  panelCrossRoot: PanelAtEdge;
}

export const decisionTwentyNineBasis =
  "plan decision 29: suggest from the fixture tuning partition's edge that finds the most expected root pairs at 0 forbidden (ties: the higher edge); no apply band";

/**
 * Plan decision 29's threshold: over every distinct aggregated score of the decided tuning pairs, the edge
 * whose suggest band (alone, before the typer, capped per note as the matcher caps it) finds the most
 * expected fixture-tuning root pairs while linking no forbidden one; on a tie the higher edge. The panel's
 * weighted precision at the edge is reported beside it.
 */
export function decideThreshold(input: {
  data: Pick<RetrievalExport, "notes" | "candidates" | "typings" | "decisions">;
  scores: DirectedScores;
  rule: RelationAggregationRule;
  blocks: readonly RelationCalibrationBlock[];
  lists: FixtureLists;
  labels: ReadonlyArray<Label & { score: number }>;
  sameRoot?: (label: Label) => boolean;
}): DecideThreshold {
  const edges = [
    ...new Set(
      input.data.decisions.flatMap((row) => {
        const score = pairScore(input.scores, row.lo, row.hi, input.rule);
        return score === null ? [] : [score];
      })
    )
  ].sort((a, b) => b - a);
  let best: { edge: number; level: RootLevel } | null = null;
  for (const edge of edges) {
    const level = rootLevel({
      data: input.data,
      scores: input.scores,
      calibration: { blocks: input.blocks, applyFrom: null, suggestFrom: edge, rule: input.rule },
      lists: input.lists
    });
    if (level.forbiddenBeforeTyping > 0) continue;
    if (!best || level.expectedBeforeTyping > best.level.expectedBeforeTyping)
      best = { edge, level };
  }
  const chosen = best && best.level.expectedBeforeTyping > 0 ? best : null;
  const at = (rows: ReadonlyArray<Label & { score: number }>): PanelAtEdge => {
    if (!chosen) return { labels: 0, precision: null, wilson: null, neff: null, recall: null };
    const band = rows.filter((row) => row.score >= chosen.edge);
    const measure = weightedPrecision(band);
    const positives = rows.filter((row) => row.positive).reduce((t, row) => t + row.weight, 0);
    const found = band.filter((row) => row.positive).reduce((t, row) => t + row.weight, 0);
    return {
      labels: band.length,
      precision: measure?.precision ?? null,
      wilson: measure?.wilsonLower ?? null,
      neff: measure?.effectiveCount ?? null,
      recall: positives > 0 ? found / positives : null
    };
  };
  const sameRoot =
    input.sameRoot ??
    ((label: Label) => {
      const [a, b] = (label.group.split(":")[1] ?? "").split("|");
      return a !== undefined && a === b;
    });
  return {
    basis: decisionTwentyNineBasis,
    edge: chosen?.edge ?? null,
    probability: chosen ? calibrate(chosen.edge, input.blocks) : null,
    expectedBeforeTyping: chosen?.level.expectedBeforeTyping ?? 0,
    forbiddenBeforeTyping: chosen?.level.forbiddenBeforeTyping ?? 0,
    expectedOf: input.lists.expected.length,
    forbiddenOf: input.lists.forbidden.length,
    candidates: edges.length,
    panel: Object.fromEntries(
      (["pooled", ...pools] as const).map((pool) => [
        pool,
        at(pool === "pooled" ? input.labels : input.labels.filter((label) => label.pool === pool))
      ])
    ),
    panelCrossRoot: at(input.labels.filter((label) => !sameRoot(label)))
  };
}

// --- Escalation ----------------------------------------------------------------------------------

export interface EscalationPoint extends ProbabilityLabel {
  weight: number;
  /** The label's score; the uncertain band's lower edge is a score of the full map. */
  score: number;
  /** The generative decide-only verdict (0-1), null when none is stored. */
  verdict: number | null;
}

export interface EscalationCandidate {
  lowerScore: number;
  lowerLevel: number;
  precision: number | null;
  recall: number | null;
  escalatedLabels: number;
  withoutVerdict: number;
  forbiddenAdded: string[];
  forbiddenWithoutVerdict: string[];
  expectedAdded: string[];
}

export interface EscalationResult {
  adopted: boolean;
  reason: string;
  /** The uncertain band: scores from `lowerScore` (its full-map probability `lowerLevel`) up to the accept band. */
  lowerLevel: number | null;
  lowerScore: number | null;
  baseline: { precision: number | null; recall: number | null };
  cascade: EscalationCandidate | null;
  /** Every lower edge the rule looked at, the narrowest band first. */
  candidates: EscalationCandidate[];
  forbiddenAdded: string[];
  forbiddenWithoutVerdict: string[];
  /** Expected tuning root pairs the cascade would add, where a verdict is stored. */
  expectedAdded: string[];
}

/**
 * The escalation clause of the rule (D18): an uncertain band right below the accept band whose pairs a
 * generative decide-only call accepts at `pass`. The band's lower edge is a block start of the full
 * map below the accept band (so the deployed band is never empty); a label is escalated when its
 * out-of-fold probability is under the accept level and its score at or above the edge. The rule takes
 * the lowest edge at which the cascade keeps the accept band's precision bar and adds no forbidden
 * tuning root pair (a pair of the band with no stored verdict counts as added: it is not known to stay
 * out), and adopts it only when its cross-validated weighted recall is above the ranker's alone.
 */
export function evaluateEscalation(input: {
  points: readonly EscalationPoint[];
  acceptLevel: number | null;
  precisionBar: number;
  blocks: readonly RelationCalibrationBlock[];
  pass: number;
  /** Tuning root pairs' decided note pairs: score, full-map probability and verdict. */
  tuning: ReadonlyArray<{
    rootPair: string;
    kind: "expected" | "forbidden" | "other";
    score: number;
    probability: number;
    verdict: number | null;
    found: boolean;
  }>;
}): EscalationResult {
  const empty = (reason: string): EscalationResult => ({
    adopted: false,
    reason,
    lowerLevel: null,
    lowerScore: null,
    baseline: { precision: null, recall: null },
    cascade: null,
    candidates: [],
    forbiddenAdded: [],
    forbiddenWithoutVerdict: [],
    expectedAdded: []
  });
  if (input.acceptLevel === null) return empty("no accept band to escalate below");
  const acceptLevel = input.acceptLevel;
  const evaluate = (lowerScore: number): EscalationCandidate => {
    let escalated = 0,
      withoutVerdict = 0;
    const accepted = input.points.map((point) => {
      if (point.probability >= acceptLevel) return true;
      if (point.score < lowerScore) return false;
      escalated++;
      if (point.verdict === null) {
        withoutVerdict++;
        return false;
      }
      return point.verdict >= input.pass;
    });
    const precision = weightedPrecision(input.points.filter((_, index) => accepted[index]));
    let positives = 0,
      found = 0;
    input.points.forEach((point, index) => {
      if (!point.positive) return;
      positives += point.weight;
      if (accepted[index]) found += point.weight;
    });
    const band = input.tuning.filter(
      (row) => row.score >= lowerScore && row.probability < acceptLevel
    );
    const roots = (rows: typeof band) => [...new Set(rows.map((row) => row.rootPair))].sort();
    return {
      lowerScore,
      lowerLevel: calibrate(lowerScore, input.blocks),
      precision: precision?.precision ?? null,
      recall: positives > 0 ? found / positives : null,
      escalatedLabels: escalated,
      withoutVerdict,
      forbiddenAdded: roots(
        band.filter(
          (row) => row.kind === "forbidden" && (row.verdict === null || row.verdict >= input.pass)
        )
      ),
      forbiddenWithoutVerdict: roots(
        band.filter((row) => row.kind === "forbidden" && row.verdict === null)
      ),
      expectedAdded: roots(
        band.filter(
          (row) =>
            row.kind === "expected" &&
            !row.found &&
            row.verdict !== null &&
            row.verdict >= input.pass
        )
      )
    };
  };
  const base = {
    precision:
      weightedPrecision(input.points.filter((point) => point.probability >= acceptLevel))
        ?.precision ?? null,
    recall: weightedRecall(input.points, acceptLevel)
  };
  // Block starts of the full map below the accept band, the narrowest band (highest edge) first.
  const edges = input.blocks
    .map((block, index) => (index === 0 ? Number.NEGATIVE_INFINITY : block.fromScore))
    .filter((_, index) => input.blocks[index]!.probability < acceptLevel)
    .sort((a, b) => b - a);
  const candidates = edges.map(evaluate);
  const passing = candidates.filter(
    (candidate) =>
      candidate.precision !== null &&
      candidate.precision >= input.precisionBar &&
      candidate.forbiddenAdded.length === 0
  );
  const chosen = passing.at(-1) ?? null;
  if (!chosen)
    return {
      ...empty("no uncertain band keeps the precision bar without a forbidden tuning root pair"),
      baseline: base,
      candidates
    };
  const adopted = (chosen.recall ?? 0) - (base.recall ?? 0) > 1e-12;
  return {
    adopted,
    reason: adopted
      ? `cross-validated weighted recall ${fmt(base.recall)} -> ${fmt(chosen.recall)} at precision >= ${input.precisionBar}, no forbidden tuning root pair added`
      : "the cascade does not raise cross-validated recall at the precision bar",
    lowerLevel: chosen.lowerLevel,
    lowerScore: chosen.lowerScore,
    baseline: base,
    cascade: chosen,
    candidates,
    forbiddenAdded: chosen.forbiddenAdded,
    forbiddenWithoutVerdict: chosen.forbiddenWithoutVerdict,
    expectedAdded: chosen.expectedAdded
  };
}

/** The generative verdicts by unordered pair: the higher of the judged directions (decide-only, D16). */
export function verdictsByPair(
  rows: ReadonlyArray<{ lo: string; hi: string; score: number }>
): Map<string, number> {
  const verdicts = new Map<string, number>();
  for (const row of rows) {
    const key = notePairKey(row.lo, row.hi);
    verdicts.set(key, Math.max(verdicts.get(key) ?? Number.NEGATIVE_INFINITY, row.score));
  }
  return verdicts;
}

const fmt = (value: number | null | undefined, digits = 3) =>
  value === null || value === undefined
    ? "-"
    : Number.isFinite(value)
      ? value.toFixed(digits)
      : String(value);

// --- Identities ----------------------------------------------------------------------------------

/** The calibration identity of a catalog ranker under a selection (D13), from the provisional entry. */
export function selectedIdentity(
  runtime: Runtime,
  choice: { instructionSha256: string; bodyCharacters: number; rule: RelationAggregationRule }
): RelationCalibrationIdentity {
  const provisional = provisionalRelationCalibrations.find(
    (entry) => entry.identity.runtimeKind === runtime
  );
  if (!provisional) throw new Error(`No provisional calibration for ${runtime}.`);
  return {
    ...provisional.identity,
    instructionSha256: choice.instructionSha256,
    bodyCharacters: choice.bodyCharacters,
    rule: choice.rule
  };
}

// --- select --------------------------------------------------------------------------------------

export interface DeciderProposal {
  runtime: Runtime;
  configuration: Configuration;
  identity: RelationCalibrationIdentity;
  scoreFile: ScoreFileFacts;
  tuningScoreFile: ScoreFileFacts | null;
  fitLabels: { labels: number; positives: number; weightedPositiveShare: number };
  blocks: RelationCalibrationBlock[];
  bands: BandChoice & { applyFromScore: number | null; suggestFromScore: number | null };
  /** The fixture tuning partition at the frozen band (decision 29: the suggest edge, no apply band). */
  tuning: RootLevel | null;
  /** Plan decision 29's threshold, with the panel's precision at it (reported, not gating). */
  threshold: DecideThreshold | null;
  tuningNote: string | null;
  escalation: EscalationResult | null;
  /** The accept band's cross-validated weighted precision and recall in each pool (reported only). */
  acceptByPool: Record<string, { labels: number; precision: number | null; recall: number | null }>;
  /** The fit labels' cross-validated calibration quality (reported; the eval split is read after the freeze). */
  cvQuality: {
    ece: number;
    brier: number;
    auc: number | null;
    weightedAuc: number | null;
    aucByPool: Record<string, number | null>;
  };
}

export interface Proposal {
  format: "memora-f3-bakeoff-proposal";
  version: 1;
  task: typeof bakeoffTask;
  computedAt: string;
  sealed: string[];
  readings: string[];
  inputs: Record<string, string>;
  selection: Selection;
  choice: {
    instructionId: string;
    instructionSha256: string;
    instruction: string;
    bodyCharacters: number;
    rule: RelationAggregationRule;
  };
  folds: { seed: number; count: number; sizes: number[] };
  deciders: DeciderProposal[];
  verdictPass: number;
  /** The population weights the rule used (3.9): cells, R_v9 kept out, every pool label's weight. */
  weighting: {
    scheme: Record<Pool, CellScheme>;
    cells: WeightCell[];
    unrepresented: Weighting["unrepresented"];
    excludedLabels: number;
    excludedPopulation: number;
    excludedPairs: string[];
    weights: Record<string, number>;
  };
}

export const sealedSets = [
  "the fixture held-out partition (expected and forbidden lists, candidate lists)",
  "the panel's eval split of pools A-C",
  "R_v6 (spike-a, 37 pairs)",
  "R_v9 (the v9 acceptances on the pinned fixture, the 50-pair sample and every lost-pair pass)"
] as const;

export const selectionReadings = [
  "R_v9 pairs (all 137, not only the 50-pair sample) leave pools A-C in both splits and every pool's population (spec 5.2, D4: evaluation-only); the R_v9 sample keeps its 50 pairs.",
  "Population weights by cell (3.9): pools B and C by (T45 stratum, top-up band of the mechanism/600/mean score) with the empty-cell merge rule of the 2026-10-18 top-up's pre-registration; pool A by T45 stratum.",
  "AUC is the plain Mann-Whitney AUC of the fit labels (the text names no weight); the weighted AUC is reported beside it and the proposal records whether it picks the same.",
  "The rule is read step by step at the provisional values of the later choices (instruction at 400 characters and max, template at max); the joint best AUC is reported beside it.",
  "Log-loss is the plain mean over the fit labels' out-of-fold probabilities (weighted PAV fits); the population-weighted log-loss is reported beside it.",
  "The instruction, template and rule are chosen on the default decider (MLX, decisions 3 and 12) and shared by every decider, as relations-config.ts holds one instruction, template and rule; each decider gets its own isotonic map and bands.",
  "A forbidden fixture-tuning root pair is 'at or above' a level when any of its decided note pairs reaches it before typing (the typer's veto is not part of the calibration).",
  "Plan decision 29 (owner, 2026-10-18) amends D18: no apply band; the suggest edge is the score whose band alone (before typing, capped per note) finds the most expected fixture-tuning root pairs with 0 forbidden, ties to the higher edge, on the instruction, template and rule the panel selection picked; the panel's precision, ECE and Brier are reported, not gating. D18's own reading is reported beside it.",
  "The uncertain-band escalation is not evaluated: its clause needs the precision bar decision 29 removed (adopting it is an owner decision)."
] as const;

export interface SelectInputs {
  labels: Hashed<LabelFixture>;
  /** The population weights of the pool labels, R_v9 kept out (`buildWeighting`). */
  weighting: Weighting;
  tuningExport: Hashed<RetrievalExport>;
  mapping: Hashed<MatchingMapping>;
  v9: Hashed<z.infer<typeof v9VerdictsSchema>>;
  labelScore: (
    runtime: Runtime,
    instructionId: string,
    body: number
  ) => Promise<{ scores: DirectedScores; facts: ScoreFileFacts }>;
  tuningScore: (
    runtime: Runtime,
    instructionId: string,
    body: number
  ) => Promise<{ scores: DirectedScores; facts: ScoreFileFacts } | null>;
  now: () => Date;
}

/** The whole pre-freeze analysis. Reads the fit split and the tuning partition only. */
export async function runSelect(inputs: SelectInputs): Promise<Proposal> {
  const labels = weightedPoolLabels(inputs.labels.value, inputs.weighting, "fit");
  if (labels.length === 0) throw new Error("No fit labels.");
  const folds = assignFolds(
    labels.map((label) => ({ group: label.group, cell: `${label.pool}:${label.stratum}` }))
  );
  const sizes = new Array<number>(foldCount).fill(0);
  for (const label of labels) sizes[folds.get(label.group)!]!++;
  const cache = new Map<string, Awaited<ReturnType<SelectInputs["labelScore"]>>>();
  const labelScore = async (runtime: Runtime, instructionId: string, body: number) => {
    const key = `${runtime}:${instructionId}:${body}`;
    if (!cache.has(key)) cache.set(key, await inputs.labelScore(runtime, instructionId, body));
    return cache.get(key)!;
  };
  for (const instructionId of instructionIds)
    for (const body of templateBodies) await labelScore(defaultRuntime, instructionId, body);
  // The tie-break of the rule: fixture-tuning expected root pairs found at zero forbidden, on the
  // tuning scores of each tied configuration (re-scored M1 candidates; M1's own run for the provisional one).
  const lists = tuningLists(inputs.mapping.value);
  const tuningOf = new Map<string, DirectedScores>();
  for (const instructionId of instructionIds)
    for (const body of templateBodies) {
      const file = await inputs.tuningScore(defaultRuntime, instructionId, body);
      if (file) tuningOf.set(`${instructionId}:${body}`, file.scores);
      else if (
        instructionId === provisionalChoice.instructionId &&
        body === provisionalChoice.bodyCharacters
      )
        tuningOf.set(`${instructionId}:${body}`, exportScores(inputs.tuningExport.value));
    }
  const selection = selectConfiguration(
    {
      labels,
      scores: (instructionId, body) =>
        cache.get(`${defaultRuntime}:${instructionId}:${body}`)!.scores,
      instructionIds,
      bodies: templateBodies,
      folds
    },
    (candidates, step, atInstruction) => {
      const counts = candidates.map((candidate) => {
        const key =
          step === "instruction"
            ? `${candidate}:${provisionalChoice.bodyCharacters}`
            : `${atInstruction}:${candidate}`;
        const scores = tuningOf.get(key);
        if (!scores)
          throw new Error(`The ${step} AUC ties; the tie-break needs the tuning scores of ${key}.`);
        return {
          candidate,
          count: expectedAtZeroForbidden({
            data: inputs.tuningExport.value,
            scores,
            lists,
            rule: provisionalChoice.rule
          })
        };
      });
      const top = Math.max(...counts.map((row) => row.count));
      return counts.find((row) => row.count === top)!.candidate;
    }
  );
  const chosenFile = cache.get(
    `${defaultRuntime}:${selection.instruction.chosen}:${selection.template.chosen}`
  )!;
  if (!chosenFile.facts.instructionSha256 || !chosenFile.facts.instruction)
    throw new Error(`${chosenFile.facts.path} does not record its instruction.`);
  const choice = {
    instructionId: selection.instruction.chosen,
    instructionSha256: chosenFile.facts.instructionSha256,
    instruction: chosenFile.facts.instruction,
    bodyCharacters: selection.template.chosen,
    rule: selection.rule.chosen
  };
  // The v9 verdicts stay an input (hashed) for the escalation clause, which decision 29 does not evaluate.
  const pass = relationsConfig.decide.uncalibratedPass.probability;
  const deciders: DeciderProposal[] = [];
  for (const runtime of runtimes) {
    const file = await labelScore(runtime, choice.instructionId, choice.bodyCharacters);
    const scored = scoredLabels(labels, file.scores, choice.rule, file.facts.path);
    const blocks = fitIsotonic(scored);
    const oofValues = crossValidatedProbabilities(
      scored.map((label) => ({ ...label, fold: folds.get(label.group)! }))
    );
    const oof = scored.map((label, index) => ({ ...label, probability: oofValues[index]! }));
    // The tuning scores of this configuration: re-scored M1 candidates, or M1's own run when it is the provisional one.
    const tuningFile = await inputs.tuningScore(
      runtime,
      choice.instructionId,
      choice.bodyCharacters
    );
    const provisionalRun =
      runtime === "mlx" &&
      choice.instructionId === provisionalChoice.instructionId &&
      choice.bodyCharacters === provisionalChoice.bodyCharacters;
    const tuningScores =
      tuningFile?.scores ?? (provisionalRun ? exportScores(inputs.tuningExport.value) : null);
    let tuning: RootLevel | null = null;
    let forbiddenBestScores: number[] = [];
    const edgesOf = (bands: { pApply: number | null; pSuggest: number | null }): Calibration => ({
      blocks,
      applyFrom: scoreAtLevel(blocks, bands.pApply),
      suggestFrom: scoreAtLevel(blocks, bands.pSuggest),
      rule: choice.rule
    });
    if (tuningScores) {
      const before = rootLevel({
        data: inputs.tuningExport.value,
        scores: tuningScores,
        calibration: edgesOf({ pApply: null, pSuggest: null }),
        lists
      });
      forbiddenBestScores = before.forbiddenBest.flatMap((row) =>
        row.bestScore === null ? [] : [row.bestScore]
      );
    }
    // D18's reading (reported, not frozen since plan decision 29).
    const bands = chooseBands({ oof, blocks, forbiddenBestScores });
    // Reported only: where the accept band's cross-validated precision comes from, pool by pool.
    const acceptByPool: DeciderProposal["acceptByPool"] = {};
    for (const pool of pools) {
      const own = oof.filter((label) => label.pool === pool);
      const level = bands.acceptLevel;
      const inBand = level === null ? [] : own.filter((label) => label.probability >= level);
      acceptByPool[pool] = {
        labels: inBand.length,
        precision: weightedPrecision(inBand)?.precision ?? null,
        recall: level === null ? null : weightedRecall(own, level)
      };
    }
    // Plan decision 29: the suggest edge from the fixture tuning partition, no apply band.
    const threshold = tuningScores
      ? decideThreshold({
          data: inputs.tuningExport.value,
          scores: tuningScores,
          rule: choice.rule,
          blocks,
          lists,
          labels: scored
        })
      : null;
    if (tuningScores && threshold)
      tuning = rootLevel({
        data: inputs.tuningExport.value,
        scores: tuningScores,
        calibration: { blocks, applyFrom: null, suggestFrom: threshold.edge, rule: choice.rule },
        lists
      });
    // The uncertain-band escalation's clause needs a precision bar, which decision 29 removed.
    const escalation: EscalationResult | null = null;
    const ece = expectedCalibrationError(oof);
    const aucByPool: Record<string, number | null> = {};
    for (const pool of pools)
      aucByPool[pool] = areaUnderCurve(scored.filter((label) => label.pool === pool));
    const weightSum = scored.reduce((total, label) => total + label.weight, 0);
    deciders.push({
      runtime,
      configuration: {
        runtime,
        instructionId: choice.instructionId,
        bodyCharacters: choice.bodyCharacters,
        rule: choice.rule
      },
      identity: selectedIdentity(runtime, choice),
      scoreFile: file.facts,
      tuningScoreFile: tuningFile?.facts ?? null,
      fitLabels: {
        labels: scored.length,
        positives: scored.filter((label) => label.positive).length,
        weightedPositiveShare:
          scored.reduce((total, label) => total + (label.positive ? label.weight : 0), 0) /
          weightSum
      },
      blocks,
      bands: {
        ...bands,
        applyFromScore: scoreAtLevel(blocks, bands.pApply),
        suggestFromScore: scoreAtLevel(blocks, bands.pSuggest)
      },
      tuning,
      threshold,
      tuningNote: tuningScores
        ? tuningFile
          ? `M1's ${inputs.tuningExport.value.decisions.length} tuning candidate pairs re-scored at ${configurationName({ runtime, instructionId: choice.instructionId, bodyCharacters: choice.bodyCharacters })} (${tuningFile.facts.path})`
          : "M1's own in-run scores (the provisional configuration)"
        : `no tuning scores at ${configurationName({ runtime, instructionId: choice.instructionId, bodyCharacters: choice.bodyCharacters })}: the forbidden check of the bands and the tuning counts are pending (score M1's candidates with tuning-pairs and bakeoff-score-pairs.ts)`,
      escalation,
      acceptByPool,
      cvQuality: {
        ece: ece.ece,
        brier: brierScore(oof),
        auc: areaUnderCurve(scored),
        weightedAuc: areaUnderCurve(scored, true),
        aucByPool
      }
    });
  }
  const inputHashes: Record<string, string> = {
    labels: inputs.labels.sha256,
    labelSetSha256: inputs.labels.value.labelSetSha256,
    ...inputs.weighting.hashes,
    tuningExport: inputs.tuningExport.sha256,
    mapping: inputs.mapping.sha256,
    v9: inputs.v9.sha256
  };
  for (const [key, entry] of cache) inputHashes[`labelScores:${key}`] = entry.facts.sha256;
  for (const decider of deciders)
    if (decider.tuningScoreFile)
      inputHashes[`tuningScores:${decider.runtime}`] = decider.tuningScoreFile.sha256;
  return {
    format: "memora-f3-bakeoff-proposal",
    version: 1,
    task: bakeoffTask,
    computedAt: inputs.now().toISOString(),
    sealed: [...sealedSets],
    readings: [...selectionReadings],
    inputs: inputHashes,
    selection,
    choice,
    folds: { seed: foldSeed, count: foldCount, sizes },
    deciders,
    verdictPass: pass,
    weighting: {
      scheme: inputs.weighting.scheme,
      cells: inputs.weighting.cells,
      unrepresented: inputs.weighting.unrepresented,
      excludedLabels: inputs.weighting.excludedLabels,
      excludedPopulation: inputs.weighting.excludedPopulation,
      excludedPairs: [...inputs.weighting.excluded].sort(),
      weights: Object.fromEntries(
        [...inputs.weighting.weightOf].sort(([a], [b]) => (a < b ? -1 : 1))
      )
    }
  };
}

// --- Proposal report -----------------------------------------------------------------------------

const scoreText = (value: number | null) =>
  value === null
    ? "none"
    : value === Number.NEGATIVE_INFINITY
      ? "every score"
      : `s >= ${fmt(value, 4)}`;

export function renderProposal(proposal: Proposal): string {
  const { selection } = proposal;
  const lines = [
    `# F3 bake-off: the pre-registered rule on the fit labels and the tuning partition (${proposal.task})`,
    "",
    `Computed ${proposal.computedAt}. Sealed until the freeze: ${proposal.sealed.join("; ")}.`,
    "",
    "## Choice",
    "",
    `- Instruction: **${proposal.choice.instructionId}** (sha256 ${proposal.choice.instructionSha256.slice(0, 12)}...), template **${proposal.choice.bodyCharacters}** body characters, aggregation **${proposal.choice.rule}**.`,
    `- Readings of the text that agree: ${Object.entries(selection.readings)
      .map(
        ([name, value]) => `${name} = ${value.instructionId}/${value.bodyCharacters}/${value.rule}`
      )
      .join("; ")}.`,
    "",
    `### Instruction (fit-label AUC at ${selection.instruction.at.bodyCharacters} characters, ${selection.instruction.at.rule})`,
    "",
    "| Instruction | AUC | weighted AUC |",
    "| --- | ---: | ---: |",
    ...selection.instruction.rows.map(
      (row) => `| ${row.value} | ${fmt(row.auc, 4)} | ${fmt(row.weightedAuc, 4)} |`
    ),
    "",
    `### Template (fit-label AUC, ${selection.template.at.instructionId}, ${selection.template.at.rule})`,
    "",
    "| Body characters | AUC | weighted AUC |",
    "| --- | ---: | ---: |",
    ...selection.template.rows.map(
      (row) => `| ${row.value} | ${fmt(row.auc, 4)} | ${fmt(row.weightedAuc, 4)} |`
    ),
    "",
    `### Aggregation (5-fold cross-validated log-loss, folds seed ${proposal.folds.seed}, fold sizes ${proposal.folds.sizes.join("/")})`,
    "",
    "| Rule | AUC | weighted AUC | CV log-loss | CV log-loss (weighted) |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...selection.rule.rows.map(
      (row) =>
        `| ${row.rule} | ${fmt(row.auc, 4)} | ${fmt(row.weightedAuc, 4)} | ${fmt(row.cvLogLoss, 4)} | ${fmt(row.cvLogLossWeighted, 4)} |`
    ),
    ""
  ];
  for (const decider of proposal.deciders) {
    const { bands } = decider;
    lines.push(
      `## ${decider.runtime.toUpperCase()} at ${configurationName(decider.configuration)}`,
      "",
      `Fit labels ${decider.fitLabels.labels} (${decider.fitLabels.positives} related; population-weighted related share ${fmt(decider.fitLabels.weightedPositiveShare)}). Scores: ${decider.scoreFile.path} (build ${decider.scoreFile.runtimeBuild ?? "unknown"}).`,
      "",
      "Isotonic map (weighted PAV, blocks of at least 15 labels, (k+1)/(n+2) on weighted counts):",
      "",
      "| From score | P |",
      "| ---: | ---: |",
      ...decider.blocks.map(
        (block) => `| ${fmt(block.fromScore, 4)} | ${fmt(block.probability, 4)} |`
      ),
      "",
      `- D18's reading (reported, not frozen since decision 29): p_apply ${bands.pApply === null ? "none (no level reaches weighted precision >= 0.95 with Wilson >= 0.85)" : fmt(bands.pApply, 4)}; apply band ${scoreText(bands.applyFromScore)}.`,
      `- D18's p_suggest ${bands.pSuggest === null ? "none" : fmt(bands.pSuggest, 4)}; suggest band ${scoreText(bands.suggestFromScore)}.`,
      ...(bands.apply
        ? [
            `- At p_apply (cross-validated): weighted precision ${fmt(bands.apply.precision)}, Wilson ${fmt(bands.apply.wilsonLower)}, n_eff ${fmt(bands.apply.effectiveCount, 1)}, weighted recall ${fmt(bands.apply.recall)}.`
          ]
        : []),
      ...(bands.suggest
        ? [
            `- At p_suggest (cross-validated): weighted precision ${fmt(bands.suggest.precision)}, Wilson ${fmt(bands.suggest.wilsonLower)}, n_eff ${fmt(bands.suggest.effectiveCount, 1)}, weighted recall ${fmt(bands.suggest.recall)}.`
          ]
        : []),
      `- Highest cross-validated weighted precision at any level: ${fmt(Math.max(...bands.scan.map((row) => row.precision)))}; highest Wilson lower bound: ${fmt(Math.max(...bands.scan.map((row) => row.wilsonLower)))}.`,
      `- The accept band by pool (cross-validated, reported only): ${Object.entries(
        decider.acceptByPool
      )
        .map(
          ([pool, row]) =>
            `${pool} precision ${fmt(row.precision)}, recall ${fmt(row.recall)} (${row.labels} labels)`
        )
        .join("; ")}.`,
      `- Forbidden tuning root pairs' best probability: ${bands.forbiddenProbabilities.length ? fmt(Math.max(...bands.forbiddenProbabilities), 4) : "none decided"} (max).`,
      `- Cross-validated quality on the fit labels: ECE ${fmt(decider.cvQuality.ece)}, Brier ${fmt(decider.cvQuality.brier)}, AUC ${fmt(decider.cvQuality.auc)} (weighted ${fmt(decider.cvQuality.weightedAuc)}), AUC per pool ${Object.entries(
        decider.cvQuality.aucByPool
      )
        .map(([pool, value]) => `${pool} ${fmt(value)}`)
        .join(", ")}.`,
      "",
      `Tuning: ${decider.tuningNote ?? ""}`,
      ""
    );
    if (decider.threshold) {
      const threshold = decider.threshold;
      const panel = (row: PanelAtEdge) =>
        `${fmt(row.precision)} (Wilson ${fmt(row.wilson)}, n_eff ${fmt(row.neff, 1)}, recall ${fmt(row.recall)}, ${row.labels} labels)`;
      lines.push(
        `**Plan decision 29: suggest from mean ${threshold.edge === null ? "none" : `>= ${fmt(threshold.edge, 4)}`} (map P ${fmt(threshold.probability)}), no apply band.** On the fixture tuning partition (before typing): ${threshold.expectedBeforeTyping}/${threshold.expectedOf} expected root pairs, ${threshold.forbiddenBeforeTyping}/${threshold.forbiddenOf} forbidden (${threshold.candidates} candidate edges).`,
        "",
        `Reported, not gating: the panel's fit labels at the edge (in sample, cell weights): pooled ${panel(threshold.panel.pooled!)}; ${pools.map((pool) => `${pool} ${panel(threshold.panel[pool]!)}`).join("; ")}; cross-root ${panel(threshold.panelCrossRoot)}.`,
        ""
      );
    }
    if (decider.tuning) {
      const tuning = decider.tuning;
      lines.push(
        "| Tuning note layer (accept band) | Value |",
        "| --- | --- |",
        `| Expected found (optimistic typing: untyped pairs count) | ${tuning.expected}/${tuning.expectedOf} |`,
        `| Expected found (pessimistic: only pairs M1 typed count) | ${tuning.expectedPessimistic}/${tuning.expectedOf} |`,
        `| Expected found, applied band only | ${tuning.expectedApplied}/${tuning.expectedOf} |`,
        `| Forbidden linked (after M1's typer vetoes) | ${tuning.forbidden}/${tuning.forbiddenOf} ${tuning.forbiddenLinked.join(" ")} |`,
        `| Forbidden linked before typing | ${tuning.forbiddenBeforeTyping}/${tuning.forbiddenOf} ${tuning.forbiddenLinkedBeforeTyping.join(" ")} |`,
        `| Expected missed | ${tuning.missed.map((row) => `${row.pair} (best ${fmt(row.bestScore)}, P ${fmt(row.bestProbability)})`).join("; ") || "none"} |`,
        ""
      );
    }
    if (decider.escalation) {
      const escalation = decider.escalation;
      lines.push(
        `Escalation: **${escalation.adopted ? "adopted" : "not adopted"}** (${escalation.reason}). The ranker alone at the accept band: cross-validated weighted precision ${fmt(escalation.baseline.precision)}, recall ${fmt(escalation.baseline.recall)}.` +
          (escalation.lowerScore !== null
            ? ` Uncertain band ${scoreText(escalation.lowerScore)} up to the accept band (full-map P ${fmt(escalation.lowerLevel, 4)}).`
            : ""),
        "",
        "| Lower edge | P at the edge | CV precision | CV recall | Fit labels escalated (no verdict) | Forbidden tuning root pairs added (no verdict) | Expected tuning root pairs added |",
        "| ---: | ---: | ---: | ---: | ---: | --- | --- |",
        ...escalation.candidates.map(
          (candidate) =>
            `| ${fmt(candidate.lowerScore, 4)} | ${fmt(candidate.lowerLevel, 4)} | ${fmt(candidate.precision)} | ${fmt(candidate.recall)} | ${candidate.escalatedLabels} (${candidate.withoutVerdict}) | ${candidate.forbiddenAdded.join(" ") || "none"} (${candidate.forbiddenWithoutVerdict.join(" ") || "none"}) | ${candidate.expectedAdded.join(" ") || "none"} |`
        ),
        ""
      );
    }
  }
  lines.push("## Readings", "", ...proposal.readings.map((reading) => `- ${reading}`), "");
  return `${lines.join("\n")}\n`;
}

// --- Freeze --------------------------------------------------------------------------------------

/** T61's score-parity outcome per runtime (R1), assembled from its proof. */
export const parityFileSchema = z
  .object({
    format: z.literal("memora-f3-freeze-parity"),
    version: z.literal(1),
    runtimes: z.partialRecord(
      z.enum(runtimes),
      z
        .object({
          /** The runtime build T61's proof ran (the new helper build for MLX). */
          runtimeBuild: z.string().min(1),
          /** The 64 synthetic reference pairs against the stored baseline (D13). */
          reference: z
            .object({
              referenceHash: z.string().regex(/^[0-9a-f]{64}$/u),
              maxAbsDelta: z.number().min(0)
            })
            .strict(),
          /** The stored M1 pairs at equal batches (R1). */
          m1Pairs: z
            .object({ pairs: z.number().int().min(0), maxAbsDelta: z.number().min(0) })
            .strict()
            .nullable(),
          source: z.string().min(1)
        })
        .strict()
    )
  })
  .strict();
export type ParityFile = z.infer<typeof parityFileSchema>;

export const parityBaselineSchema = z
  .object({
    format: z.literal("memora-ranker-parity-baseline"),
    referenceHash: z.string().regex(/^[0-9a-f]{64}$/u),
    runtime: z.enum(runtimes),
    runtimeBuild: z.string().min(1),
    scores: z.array(z.number().finite()).length(64)
  })
  .passthrough();

/**
 * Whether a runtime may freeze (R1): T61's parity passed on the reference set and on at least 500
 * stored M1 pairs, or the scores the proposal was fitted on come from T61's build itself.
 */
export function parityVerdict(
  entry: ParityFile["runtimes"][Runtime] | undefined,
  scoresBuild: string | null
): { ok: boolean; reason: string } {
  if (!entry) return { ok: false, reason: "no parity outcome for this runtime" };
  if (scoresBuild !== null && scoresBuild === entry.runtimeBuild)
    return { ok: true, reason: `the scores come from the checked build ${entry.runtimeBuild}` };
  if (entry.reference.maxAbsDelta > parityBar.maxAbsDelta)
    return {
      ok: false,
      reason: `reference parity ${entry.reference.maxAbsDelta} > ${parityBar.maxAbsDelta}`
    };
  if (!entry.m1Pairs) return { ok: false, reason: "no stored M1 pair parity" };
  if (entry.m1Pairs.pairs < parityBar.m1Pairs)
    return { ok: false, reason: `${entry.m1Pairs.pairs} stored M1 pairs < ${parityBar.m1Pairs}` };
  if (entry.m1Pairs.maxAbsDelta > parityBar.maxAbsDelta)
    return {
      ok: false,
      reason: `M1 pair parity ${entry.m1Pairs.maxAbsDelta} > ${parityBar.maxAbsDelta}`
    };
  return {
    ok: true,
    reason: `parity ${entry.reference.maxAbsDelta} (reference) and ${entry.m1Pairs.maxAbsDelta} (${entry.m1Pairs.pairs} M1 pairs) <= ${parityBar.maxAbsDelta}`
  };
}

/** JSON with sorted keys: the hashed form of a configuration. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`;
  return JSON.stringify(value);
}

export interface FreezeRecord {
  format: "memora-f3-freeze";
  version: 1;
  task: typeof bakeoffTask;
  configHash: string;
  calibrationIdentity: string;
  frozenAt: string;
  parity: Record<string, unknown>;
  inputHashes: Record<string, string>;
  config: {
    instruction: { id: string; sha256: string };
    template: string;
    bodyCharacters: number;
    rule: RelationAggregationRule;
    retrieval: typeof relationsConfig.retrieval;
    maxShownPerNote: number;
    escalation: {
      adopted: boolean;
      lowerScore: number | null;
      lowerLevel: number | null;
      pass: number;
    };
    discoveryNeighbours: number;
  };
  calibrations: RelationCalibrationEntry[];
  proposal: { sha256: string; computedAt: string };
  previous: Array<{ configHash: string; frozenAt: string; file: string }>;
}

/** The freeze record of a proposal (pure). */
export function buildFreezeRecord(input: {
  proposal: Proposal;
  proposalSha256: string;
  parity: ParityFile;
  baselines: Partial<Record<Runtime, z.infer<typeof parityBaselineSchema>>>;
  frozenAt: Date;
  previous?: FreezeRecord["previous"];
  /** The runtimes to freeze (default all the proposal holds; the default decider always). */
  runtimes?: readonly Runtime[];
}): FreezeRecord {
  const { proposal } = input;
  const primary = proposal.deciders.find((decider) => decider.runtime === defaultRuntime);
  if (!primary) throw new Error("The proposal has no default decider.");
  if (input.runtimes && !input.runtimes.includes(defaultRuntime))
    throw new Error(`The freeze always holds the default decider (${defaultRuntime}).`);
  const parity: Record<string, unknown> = {};
  const calibrations: Array<
    Omit<Extract<RelationCalibrationEntry, { kind: "isotonic" }>, "freezeHash">
  > = [];
  for (const decider of proposal.deciders) {
    if (input.runtimes && !input.runtimes.includes(decider.runtime)) continue;
    if (!decider.tuning)
      throw new Error(
        `${decider.runtime}: the tuning scores are missing, so the bands' forbidden check did not run.`
      );
    const verdict = parityVerdict(
      input.parity.runtimes[decider.runtime],
      decider.scoreFile.runtimeBuild
    );
    if (!verdict.ok)
      throw new Error(
        `${decider.runtime}: the score-parity check did not pass (${verdict.reason}). Re-score M1's candidates and the label pairs on the new build, run select again, and freeze that proposal (R1).`
      );
    const baseline = input.baselines[decider.runtime];
    if (!baseline) throw new Error(`${decider.runtime}: no parity baseline.`);
    // The calibration keeps the reference scores of the build its fit scores came from (D13).
    if (baseline.runtimeBuild !== decider.scoreFile.runtimeBuild)
      throw new Error(
        `${decider.runtime}: the parity baseline is of ${baseline.runtimeBuild}, the fit scores of ${decider.scoreFile.runtimeBuild ?? "an unknown build"}.`
      );
    // Plan decision 29: the suggest edge from the fixture tuning partition, no apply band.
    if (!decider.threshold || decider.threshold.edge === null)
      throw new Error(
        `${decider.runtime}: no decide threshold (decision 29: no edge finds an expected tuning root pair at 0 forbidden); nothing to freeze.`
      );
    parity[decider.runtime] = {
      ...input.parity.runtimes[decider.runtime],
      verdict: verdict.reason,
      baselineBuild: baseline.runtimeBuild
    };
    calibrations.push({
      kind: "isotonic",
      identity: decider.identity,
      blocks: decider.blocks,
      applyFrom: null,
      suggestFrom: decider.threshold.edge,
      basis: decider.threshold.basis,
      labelSetHash: proposal.inputs.labelSetSha256!,
      fittedAt: proposal.computedAt,
      parity: { referenceHash: baseline.referenceHash, scores: baseline.scores }
    });
  }
  const escalation = primary.escalation;
  const config: FreezeRecord["config"] = {
    instruction: { id: proposal.choice.instructionId, sha256: proposal.choice.instructionSha256 },
    template: primary.identity.template,
    bodyCharacters: proposal.choice.bodyCharacters,
    rule: proposal.choice.rule,
    retrieval: relationsConfig.retrieval,
    maxShownPerNote: relationsConfig.maxShownPerNote,
    escalation: {
      adopted: escalation?.adopted ?? false,
      lowerScore: escalation?.adopted ? escalation.lowerScore : null,
      lowerLevel: escalation?.adopted ? escalation.lowerLevel : null,
      pass: proposal.verdictPass
    },
    discoveryNeighbours: relationsConfig.discovery.neighbours
  };
  const configHash = sha256Hex(
    canonicalJson({
      config,
      calibrations: calibrations.map((entry) => ({ ...entry, fittedAt: undefined }))
    })
  );
  const entries = calibrations.map((entry) =>
    RelationCalibrationEntrySchema.parse({ ...entry, freezeHash: configHash })
  );
  return {
    format: "memora-f3-freeze",
    version: 1,
    task: bakeoffTask,
    configHash,
    calibrationIdentity: relationCalibrationIdentityKey(primary.identity),
    frozenAt: input.frozenAt.toISOString(),
    parity,
    inputHashes: { ...proposal.inputs, proposal: input.proposalSha256 },
    config,
    calibrations: entries,
    proposal: { sha256: input.proposalSha256, computedAt: proposal.computedAt },
    previous: input.previous ?? []
  };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

/**
 * Writes `frozen.json` once (D3). Refuses an existing freeze unless `refreeze` (the first is kept
 * beside it and named in `previous`), a gate F output written before the freeze, a proposal whose
 * inputs changed since it was computed, and a failed parity check (R1).
 */
export async function writeFreeze(input: {
  proposalPath: string;
  parityPath: string;
  baselinePaths: Partial<Record<Runtime, string>>;
  frozenPath: string;
  gateFDirectory: string;
  refreeze: boolean;
  runtimes?: readonly Runtime[];
  currentHashes: (proposal: Proposal) => Promise<Record<string, string>>;
  now: () => Date;
}): Promise<FreezeRecord> {
  const previous: FreezeRecord["previous"] = [];
  if (await exists(input.frozenPath)) {
    if (!input.refreeze)
      throw new Error(
        `${input.frozenPath} exists: the configuration is frozen. A re-freeze needs --refreeze and is reported beside the first.`
      );
    const prior = JSON.parse(await readFile(input.frozenPath, "utf8")) as FreezeRecord;
    const kept = input.frozenPath.replace(
      /\.json$/u,
      `-${prior.frozenAt.replace(/[:.]/gu, "-")}.json`
    );
    await rename(input.frozenPath, kept);
    previous.push(...(prior.previous ?? []), {
      configHash: prior.configHash,
      frozenAt: prior.frozenAt,
      file: kept
    });
  } else if (await exists(input.gateFDirectory))
    throw new Error(
      `${input.gateFDirectory} exists without a freeze: a held-out read happened before the freeze (D3).`
    );
  const proposalBytes = await readFile(input.proposalPath);
  const proposal = JSON.parse(proposalBytes.toString("utf8")) as Proposal;
  if (proposal.format !== "memora-f3-bakeoff-proposal")
    throw new Error(`${input.proposalPath} is not a bake-off proposal.`);
  const current = await input.currentHashes(proposal);
  for (const [key, hash] of Object.entries(proposal.inputs))
    if (current[key] !== hash)
      throw new Error(
        `The proposal's input ${key} changed since it was computed: run select again.`
      );
  const parity = parityFileSchema.parse(JSON.parse(await readFile(input.parityPath, "utf8")));
  const baselines: Partial<Record<Runtime, z.infer<typeof parityBaselineSchema>>> = {};
  // Only the baselines of the runtimes this freeze holds.
  const frozenRuntimes = input.runtimes ?? proposal.deciders.map((decider) => decider.runtime);
  for (const [runtime, path] of Object.entries(input.baselinePaths) as Array<[Runtime, string]>)
    if (frozenRuntimes.includes(runtime))
      baselines[runtime] = parityBaselineSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const record = buildFreezeRecord({
    proposal,
    proposalSha256: sha256Hex(proposalBytes),
    parity,
    baselines,
    frozenAt: input.now(),
    previous,
    ...(input.runtimes ? { runtimes: input.runtimes } : {})
  });
  await mkdir(dirname(input.frozenPath), { recursive: true });
  await writeFile(`${input.frozenPath}.tmp`, `${JSON.stringify(record, null, 1)}\n`);
  await rename(`${input.frozenPath}.tmp`, input.frozenPath);
  return record;
}

// --- Gate F (after the freeze) -------------------------------------------------------------------

/** The frozen calibration of a runtime as the offline reads use it. */
export function frozenCalibration(record: FreezeRecord, runtime: Runtime): Calibration {
  const entry = record.calibrations.find((candidate) => candidate.identity.runtimeKind === runtime);
  if (!entry || entry.kind !== "isotonic")
    throw new Error(`The freeze has no isotonic calibration for ${runtime}.`);
  return {
    blocks: entry.blocks,
    applyFrom: entry.applyFrom,
    suggestFrom: entry.suggestFrom,
    rule: entry.identity.rule
  };
}

export interface ReverseOnlyLoss {
  set: "R_v6" | "R_v9";
  pairs: number;
  lost: number;
  related: number | null;
  lostRelated: number | null;
  loss: number | null;
  /** 95% interval of the loss when the kept pairs' related share is estimated from a sample (R10). */
  interval: [number, number] | null;
  literalLoss: number;
  sameRoot: { pairs: number; lost: number };
  unlabelledLost: number;
  lostPairs: Array<[string, string]>;
  /** Kept pairs with no panel label: a later pass labels them when 5% lies inside the interval (R10). */
  keptUnlabelledPairs: Array<[string, string]>;
}

/** R_v6: the 37 pairs in product shape at the frozen bands; loss over the panel-related ones (Q1). */
export function reverseOnlyLossR6(input: {
  items: readonly LabelItem[];
  scores: DirectedScores;
  calibration: Calibration;
}): ReverseOnlyLoss {
  const set = input.items.filter((item) => item.sets.includes("rv6"));
  const lost: LabelItem[] = [];
  let sameRootPairs = 0,
    sameRootLost = 0;
  for (const item of set) {
    const score = pairScore(input.scores, item.lo, item.hi, input.calibration.rule);
    const kept = score !== null && bandOf(score, input.calibration) !== null;
    const [, roots = ""] = item.group.split(":");
    const [a, b] = roots.split("|");
    const sameRoot = a !== undefined && a === b;
    if (sameRoot) sameRootPairs++;
    if (!kept) {
      lost.push(item);
      if (sameRoot) sameRootLost++;
    }
  }
  const related = set.filter((item) => item.related === true).length;
  const lostRelated = lost.filter((item) => item.related === true).length;
  return {
    set: "R_v6",
    pairs: set.length,
    lost: lost.length,
    related,
    lostRelated,
    loss: related > 0 ? lostRelated / related : null,
    interval: null,
    literalLoss: set.length ? lost.length / set.length : 0,
    sameRoot: { pairs: sameRootPairs, lost: sameRootLost },
    unlabelledLost: lost.filter((item) => item.related === null).length,
    lostPairs: lost.map((item) => [item.lo, item.hi]),
    keptUnlabelledPairs: []
  };
}

/**
 * R_v9 (R10): a v9-accepted pair is kept when the frozen pipeline's accept band holds it in the given
 * export (a pair that never reached the decider is lost). The numerator is exact (every lost pair is
 * labelled by the freeze pass); the kept pairs' related share comes from the seeded 50-pair sample, so
 * the denominator is lost-related + kept x share, with the share's Wilson interval carried to the loss.
 */
export function reverseOnlyLossR9(input: {
  pairs: ReadonlyArray<{ lo: string; hi: string; sameRoot: boolean }>;
  accepted: ReadonlySet<string>;
  sample: ReadonlyArray<{ lo: string; hi: string; related: boolean }>;
  /** Every panel label known for a pair (the base set, the freeze pass, any later pass). */
  labels: ReadonlyMap<string, boolean>;
}): ReverseOnlyLoss {
  const keyOf = (pair: { lo: string; hi: string }) => notePairKey(pair.lo, pair.hi);
  const lost = input.pairs.filter((pair) => !input.accepted.has(keyOf(pair)));
  const keptPairs = input.pairs.filter((pair) => input.accepted.has(keyOf(pair)));
  const kept = keptPairs.length;
  const share = input.sample.length
    ? input.sample.filter((row) => row.related).length / input.sample.length
    : null;
  const labelled = lost.filter((pair) => input.labels.has(keyOf(pair)));
  const lostRelated = labelled.filter((pair) => input.labels.get(keyOf(pair))).length;
  const unlabelled = lost.length - labelled.length;
  const keptUnlabelled = keptPairs.filter((pair) => !input.labels.has(keyOf(pair)));
  const lossAt = (value: number) =>
    lostRelated + kept * value > 0 ? lostRelated / (lostRelated + kept * value) : 0;
  let loss: number | null = null,
    related: number | null = null,
    interval: [number, number] | null = null;
  if (unlabelled === 0 && keptUnlabelled.length === 0) {
    // Every pair labelled: the exact figure gates (R10).
    related = lostRelated + keptPairs.filter((pair) => input.labels.get(keyOf(pair))).length;
    loss = related > 0 ? lostRelated / related : null;
  } else if (unlabelled === 0 && share !== null) {
    related = lostRelated + kept * share;
    loss = lossAt(share);
    const n = input.sample.length;
    interval = [lossAt(1 - wilsonLowerBound(1 - share, n)), lossAt(wilsonLowerBound(share, n))];
  }
  return {
    set: "R_v9",
    pairs: input.pairs.length,
    lost: lost.length,
    related,
    lostRelated: unlabelled > 0 ? null : lostRelated,
    loss,
    interval,
    literalLoss: input.pairs.length ? lost.length / input.pairs.length : 0,
    sameRoot: {
      pairs: input.pairs.filter((pair) => pair.sameRoot).length,
      lost: lost.filter((pair) => pair.sameRoot).length
    },
    unlabelledLost: unlabelled,
    lostPairs: lost.map((pair) => [pair.lo, pair.hi]),
    keptUnlabelledPairs: keptUnlabelled.map((pair) => [pair.lo, pair.hi])
  };
}

export const typerReportSchema = z
  .object({
    format: z.literal("memora-typer-position-check"),
    summary: z
      .object({
        pairs: z.number(),
        directionAccuracy: z.number().nullable(),
        swapConsistency: z.number().nullable()
      })
      .passthrough(),
    // Absent in reports written before the typer experiment's options (plan decision 29).
    orders: z.enum(["both", "content"]).optional(),
    prompt: z.object({ candidate: z.string().nullable() }).passthrough().optional()
  })
  .passthrough()
  .refine((report) => report.orders !== "content" && !report.prompt?.candidate, {
    message:
      "Gate F reads the two-order check of the product's typing prompt, not a typer experiment report."
  });

// --- Typer check pairs ---------------------------------------------------------------------------

export const directedWriteTypes = [
  "supports",
  "extends",
  "depends_on",
  "example_of",
  "clarifies"
] as const;

/**
 * The position-bias check of G25: panel-positive fit-split pairs of pools A-C with a directed majority
 * type and direction (the eval split stays untouched for the clean check), seeded, rendered as the
 * decider reads them (`a` the lower id).
 */
export function typerCheckPairs(input: {
  items: readonly LabelItem[];
  text: (id: string) => string | undefined;
  count?: number;
  seed?: number;
}): Array<{ id: string; a: string; b: string; type: string; subject: "a" | "b" }> {
  const eligible = input.items
    .filter(
      (item) =>
        item.kind === "note" &&
        (pools as readonly string[]).includes(item.pool ?? "") &&
        item.split === "fit" &&
        item.related === true &&
        (directedWriteTypes as readonly string[]).includes(item.type ?? "") &&
        (item.direction === "lo_to_hi" || item.direction === "hi_to_lo")
    )
    .sort((left, right) => (left.pairId < right.pairId ? -1 : 1));
  const chosen = shuffled(eligible, streamRandom(input.seed ?? labelSeed, "typer-check")).slice(
    0,
    input.count ?? typerCheckPairCount
  );
  return chosen.map((item, index) => {
    const a = input.text(item.lo),
      b = input.text(item.hi);
    if (!a || !b) throw new Error(`No note text for ${item.pairId}.`);
    return {
      id: `t${String(index + 1).padStart(2, "0")}`,
      a,
      b,
      type: item.type!,
      subject: item.direction === "lo_to_hi" ? "a" : "b"
    };
  });
}

// --- CLI -----------------------------------------------------------------------------------------

/** The R_v9 pairs (spec 5.2: evaluation-only), as note pair keys. */
export async function readRv9Pairs(path: string): Promise<{ pairs: Set<string>; sha256: string }> {
  const read = await readHashed(path, (value) =>
    z
      .array(
        z.object({ source_note: z.string().min(1), target_note: z.string().min(1) }).passthrough()
      )
      .parse(value)
  );
  return {
    pairs: new Set(read.value.map((row) => notePairKey(row.source_note, row.target_note))),
    sha256: read.sha256
  };
}

/** The cell weights from the files: R_v9 out, pools B and C by (stratum, band), pool A by stratum. */
export async function readWeighting(input: {
  items: readonly LabelItem[];
  poolA: { pairs: ReadonlyArray<{ lo: string; hi: string; stratum: number }>; sha256: string };
  rv9Path: string;
  populationB: string;
  populationC: string;
  frameB: string;
  frameC: string;
  labelBand: string;
  /** T57's coarse (pool, stratum) cells everywhere: the reported sensitivity. */
  coarse?: boolean;
}): Promise<Weighting> {
  const rv9 = await readRv9Pairs(input.rv9Path);
  const population = (path: string) =>
    readHashed(path, (value) => populationExportSchema.parse(value));
  const [b, c] = [await population(input.populationB), await population(input.populationC)];
  const scheme: CellScheme = input.coarse ? "stratum" : "stratum-and-band";
  const frameB = scheme === "stratum" ? null : await readScores(input.frameB);
  const frameC = scheme === "stratum" ? null : await readScores(input.frameC);
  const labelBand = scheme === "stratum" ? null : await readScores(input.labelBand);
  return buildWeighting({
    items: input.items,
    excluded: rv9.pairs,
    populations: {
      A: { pairs: input.poolA.pairs, frame: null, scheme: "stratum" },
      B: { pairs: b.value.decisions, frame: frameB?.scores ?? null, scheme },
      C: { pairs: c.value.decisions, frame: frameC?.scores ?? null, scheme }
    },
    labelBand: labelBand?.scores ?? null,
    hashes: {
      weighting: `${scheme}:R_v9-out`,
      rv9: rv9.sha256,
      populationB: b.sha256,
      populationC: c.sha256,
      ...(frameB ? { frameB: frameB.facts.sha256 } : {}),
      ...(frameC ? { frameC: frameC.facts.sha256 } : {}),
      ...(labelBand ? { labelBand: labelBand.facts.sha256 } : {})
    }
  });
}

async function readInputs(values: Record<string, string | boolean | undefined>) {
  const path = (key: string, fallback: string) =>
    resolve(typeof values[key] === "string" ? (values[key] as string) : fallback);
  const labels = await readHashed(path("labels", defaultPaths.labels), (value) =>
    labelFixtureSchema.parse(value)
  );
  const tuningExport = await readHashed(path("tuning-export", defaultPaths.tuningExport), (value) =>
    retrievalExportSchema.parse(value)
  );
  const labelScoresDir = path("label-scores", defaultPaths.labelScores);
  const weighting = await readWeighting({
    items: labels.value.items,
    poolA: {
      pairs: populationExportSchema.parse(tuningExport.value).decisions,
      sha256: tuningExport.sha256
    },
    rv9Path: path("rv9-relations", defaultPaths.rv9Relations),
    populationB: path("population-b", defaultPaths.populationB),
    populationC: path("population-c", defaultPaths.populationC),
    frameB: path("frame-b", defaultPaths.frameB),
    frameC: path("frame-c", defaultPaths.frameC),
    labelBand: join(labelScoresDir, scoreFileName("mlx", "mechanism", 600)),
    coarse: values.coarse === true
  });
  return {
    labels,
    weighting,
    tuningExport,
    mapping: await readHashed(path("mapping", defaultPaths.mapping), (value) =>
      matchingMappingSchema.parse(value)
    ),
    v9: await readHashed(path("v9", defaultPaths.v9), (value) => v9VerdictsSchema.parse(value)),
    labelScoresDir,
    tuningScoresDir: path("tuning-scores", defaultPaths.tuningScores)
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 1)}\n`);
}

export const usage = `Usage: npx tsx scripts/relations/bakeoff.ts <tuning-pairs|select|typer-pairs|freeze|gate-f> [options]
  tuning-pairs [--tuning-export <retrieval export.json>] [--out <pairs.json>]
      the pairs file of an export's decided pairs (M1's tuning candidates by default; X1's S0 export after the freeze)
  select [--out-dir .cache/f3/freeze] [--labels ...] [--tuning-export ...] [--tuning-scores <dir>]
         [--label-scores <dir>] [--mapping ...] [--v9 ...] [--rv9-relations ...] [--population-b ...]
         [--population-c ...] [--frame-b ...] [--frame-c ...] [--coarse]
      population weights by cell (3.9): R_v9 pairs out of every pool, pools B and C by (T45 stratum, top-up band),
      pool A by stratum; --coarse: T57's (pool, stratum) cells everywhere (a sensitivity)
  typer-pairs [--body <chars>] [--texts <note-texts.json>] [--labels ...] [--proposal ...] [--out <pairs.json>]
  freeze --parity <parity.json> [--proposal <proposal.json>] [--runtimes mlx,gguf] [--baselines mlx=<file>] [--refreeze]
  gate-f [--x1-export <export.json> --x1-scores <scores.json>] [--rv9-pass <tally.json>[,<tally.json>]]
         [--typer-report <typer-check.json>] [--labels ...] [--proposal ...] [--mapping ...] [--label-scores <dir>]
         [--rv9-relations <relations.json>] [--out-dir .cache/f3/freeze/gate-f]
Paths default to the repository's .cache; run from the repository root.`;

export async function runBakeoffCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      out: { type: "string" },
      "out-dir": { type: "string" },
      labels: { type: "string" },
      "tuning-export": { type: "string" },
      "tuning-scores": { type: "string" },
      "label-scores": { type: "string" },
      mapping: { type: "string" },
      v9: { type: "string" },
      body: { type: "string" },
      texts: { type: "string" },
      proposal: { type: "string" },
      parity: { type: "string" },
      refreeze: { type: "boolean" },
      runtimes: { type: "string" },
      baselines: { type: "string" },
      "x1-export": { type: "string" },
      "x1-scores": { type: "string" },
      "rv9-pass": { type: "string" },
      "typer-report": { type: "string" },
      "rv9-relations": { type: "string" },
      "population-b": { type: "string" },
      "population-c": { type: "string" },
      "frame-b": { type: "string" },
      "frame-c": { type: "string" },
      coarse: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: true,
    strict: true
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.info(usage);
    return;
  }
  if (command === "tuning-pairs") {
    const data = (
      await readHashed(resolve(values["tuning-export"] ?? defaultPaths.tuningExport), (value) =>
        retrievalExportSchema.parse(value)
      )
    ).value;
    const pairs = data.decisions.map((row) =>
      row.lo < row.hi ? [row.lo, row.hi] : [row.hi, row.lo]
    );
    const out = resolve(values.out ?? join(freezeDirectory, "inputs", "m1-tuning-pairs.json"));
    await writeJsonFile(out, {
      format: pairsFileFormat,
      version: 1,
      profile: `m1-tuning:${data.label}`,
      unorderedPairs: pairs.length,
      directedPairs: 2 * pairs.length,
      pairs
    });
    console.info(`${pairs.length} tuning candidate pairs -> ${out}`);
    return;
  }
  if (command === "select") {
    const inputs = await readInputs(values);
    const proposal = await runSelect({
      ...inputs,
      labelScore: (runtime, instructionId, body) =>
        readScores(join(inputs.labelScoresDir, scoreFileName(runtime, instructionId, body))),
      tuningScore: async (runtime, instructionId, body) => {
        const file = join(inputs.tuningScoresDir, scoreFileName(runtime, instructionId, body));
        return (await exists(file)) ? readScores(file) : null;
      },
      now: () => new Date()
    });
    const outDir = resolve(values["out-dir"] ?? freezeDirectory);
    await writeJsonFile(join(outDir, "proposal.json"), proposal);
    await writeFile(join(outDir, "proposal.md"), renderProposal(proposal));
    console.info(renderProposal(proposal).split("\n").slice(0, 12).join("\n"));
    console.info(`-> ${join(outDir, "proposal.json")}, ${join(outDir, "proposal.md")}`);
    return;
  }
  if (command === "typer-pairs") {
    const proposalPath = resolve(values.proposal ?? defaultPaths.proposal);
    const proposal = (await exists(proposalPath))
      ? (JSON.parse(await readFile(proposalPath, "utf8")) as Proposal)
      : null;
    const body = Number(
      values.body ?? proposal?.choice.bodyCharacters ?? relationsConfig.decide.bodyCharacters
    );
    const texts = await readNoteTexts(resolve(values.texts ?? defaultPaths.labelTexts), body);
    const fixture = labelFixtureSchema.parse(
      JSON.parse(await readFile(resolve(values.labels ?? defaultPaths.labels), "utf8"))
    );
    const pairs = typerCheckPairs({
      items: fixture.items,
      text: (id) => texts.rendered.get(id)?.text
    });
    const out = resolve(values.out ?? join(freezeDirectory, "typer-check-pairs.json"));
    await writeJsonFile(out, { pairs });
    console.info(
      `${pairs.length} directed panel-positive pairs at ${body} body characters -> ${out}`
    );
    return;
  }
  if (command === "freeze") {
    if (!values.parity) throw new Error("freeze needs --parity <parity.json> (T61's outcome, R1).");
    const proposalPath = resolve(values.proposal ?? defaultPaths.proposal);
    const record = await writeFreeze({
      proposalPath,
      parityPath: resolve(values.parity),
      baselinePaths: {
        ...Object.fromEntries(
          runtimes.map((runtime) => [
            runtime,
            join(defaultPaths.parityBaselines, `ranker-parity-baseline-${runtime}.json`)
          ])
        ),
        // --baselines mlx=<file>[,gguf=<file>]: the baseline of another build (scores re-done on T61's).
        ...Object.fromEntries(
          (typeof values.baselines === "string" ? values.baselines.split(",") : []).map((item) => {
            const [runtime, path] = item.split("=");
            return [z.enum(runtimes).parse(runtime), resolve(path ?? "")];
          })
        )
      },
      frozenPath: resolve(frozenFileLocation()),
      gateFDirectory: defaultPaths.gateF,
      refreeze: values.refreeze === true,
      ...(typeof values.runtimes === "string"
        ? { runtimes: z.array(z.enum(runtimes)).parse(values.runtimes.split(",")) }
        : {}),
      currentHashes: async (proposal) => {
        const inputs = await readInputs(values);
        const hashes: Record<string, string> = {
          labels: inputs.labels.sha256,
          labelSetSha256: inputs.labels.value.labelSetSha256,
          ...inputs.weighting.hashes,
          tuningExport: inputs.tuningExport.sha256,
          mapping: inputs.mapping.sha256,
          v9: inputs.v9.sha256
        };
        for (const key of Object.keys(proposal.inputs)) {
          const [kind, runtime, instructionId, body] = key.split(":");
          if (kind === "labelScores")
            hashes[key] = sha256Hex(
              await readFile(
                join(
                  inputs.labelScoresDir,
                  scoreFileName(runtime as Runtime, instructionId!, Number(body))
                )
              )
            );
          if (kind === "tuningScores") {
            const decider = proposal.deciders.find((candidate) => candidate.runtime === runtime);
            if (decider?.tuningScoreFile)
              hashes[key] = sha256Hex(await readFile(decider.tuningScoreFile.path));
          }
        }
        return hashes;
      },
      now: () => new Date()
    });
    console.info(`frozen ${record.configHash} at ${record.frozenAt} -> ${frozenFileLocation()}`);
    return;
  }
  if (command === "gate-f") {
    const access: HeldOutAccess = await readHeldOutAccess();
    requireHeldOut(access);
    const record = JSON.parse(
      await readFile(resolve(frozenFileLocation()), "utf8")
    ) as FreezeRecord;
    const options: Record<string, string | boolean | undefined> = values;
    const flag = (key: string) =>
      typeof options[key] === "string" ? resolve(options[key] as string) : undefined;
    const paths: Partial<GateFPaths> = Object.fromEntries(
      Object.entries({
        labels: flag("labels"),
        proposal: flag("proposal"),
        mapping: flag("mapping"),
        labelScores: flag("label-scores"),
        rv9Relations: flag("rv9-relations"),
        outDir: flag("out-dir")
      }).filter(([, value]) => value !== undefined)
    );
    const result = await runGateF({ record, values, paths });
    const outDir = paths.outDir ?? defaultPaths.gateF;
    await writeJsonFile(join(outDir, "gate-f.json"), result);
    await writeFile(join(outDir, "gate-f.md"), renderGateF(result));
    console.info(renderGateF(result));
    return;
  }
  throw new Error(`Unknown command "${command}".\n${usage}`);
}

// --- Gate F runner -------------------------------------------------------------------------------

export interface GateFResult {
  configHash: string;
  frozenAt: string;
  readAt: string;
  x1: (RootLevel & { partition: "holdout"; reached: number; tuning: RootLevel }) | null;
  rv6: ReverseOnlyLoss | null;
  rv9: ReverseOnlyLoss | null;
  typer: { directionAccuracy: number | null; swapConsistency: number | null; pairs: number } | null;
  cleanCheck: Array<{
    runtime: Runtime;
    labels: number;
    precisionAtApply: number | null;
    precisionAtSuggest: number | null;
    recallAtAccept: number | null;
    ece: number;
    brier: number;
    reliability: ReliabilityBin[];
    aucByPool: Record<string, number | null>;
  }>;
}

/** Where gate F reads its inputs and writes its outputs (the defaults are the repository's). */
export interface GateFPaths {
  labels: string;
  /** The frozen proposal: the eval split takes its population weights (the freeze record holds its hash). */
  proposal: string;
  mapping: string;
  labelScores: string;
  rv9Relations: string;
  outDir: string;
}

/**
 * The gate F reads (after the freeze only; the caller checks the freeze guard): the panel's eval split
 * as the clean check, R_v6, and with a held-out export and its scores the X1 forecast and R_v9.
 */
export async function runGateF(input: {
  record: FreezeRecord;
  values: Record<string, string | boolean | undefined>;
  paths?: Partial<GateFPaths>;
  now?: () => Date;
}): Promise<GateFResult> {
  const { record, values } = input;
  const paths: GateFPaths = {
    labels: defaultPaths.labels,
    proposal: defaultPaths.proposal,
    mapping: defaultPaths.mapping,
    labelScores: defaultPaths.labelScores,
    rv9Relations: defaultPaths.rv9Relations,
    outDir: defaultPaths.gateF,
    ...input.paths
  };
  const fixture = labelFixtureSchema.parse(JSON.parse(await readFile(paths.labels, "utf8")));
  const proposalBytes = await readFile(paths.proposal);
  if (sha256Hex(proposalBytes) !== record.proposal.sha256)
    throw new Error(`${paths.proposal} is not the proposal the freeze holds.`);
  const proposal = JSON.parse(proposalBytes.toString("utf8")) as Proposal;
  // The eval split's weights are the frozen proposal's (the same cells, R_v9 out).
  const weighting = {
    weightOf: new Map(Object.entries(proposal.weighting.weights)),
    excluded: new Set(proposal.weighting.excludedPairs)
  };
  const mapping = matchingMappingSchema.parse(JSON.parse(await readFile(paths.mapping, "utf8")));
  const mlx = frozenCalibration(record, "mlx");
  const labelScores = (runtime: Runtime) =>
    readScores(
      join(
        paths.labelScores,
        scoreFileName(runtime, record.config.instruction.id, record.config.bodyCharacters)
      )
    );
  // The panel's eval split: the clean check beside X1 (nothing was chosen on it).
  const evalLabels = weightedPoolLabels(fixture, weighting, "eval");
  const cleanCheck: GateFResult["cleanCheck"] = [];
  for (const entry of record.calibrations) {
    const runtime = entry.identity.runtimeKind;
    const calibration = frozenCalibration(record, runtime);
    const scores = (await labelScores(runtime)).scores;
    const scored = scoredLabels(evalLabels, scores, calibration.rule, `${runtime} eval scores`);
    const points = scored.map((label) => ({
      ...label,
      probability: calibrate(label.score, calibration.blocks)
    }));
    // The reported panel figures at the frozen edges (decision 29: not gating).
    const at = (edge: number | null) =>
      edge === null
        ? null
        : (weightedPrecision(points.filter((point) => point.score >= edge))?.precision ?? null);
    const acceptFrom = calibration.suggestFrom ?? calibration.applyFrom;
    const positives = points
      .filter((point) => point.positive)
      .reduce((t, point) => t + point.weight, 0);
    const quality = expectedCalibrationError(points);
    const aucByPool: Record<string, number | null> = {};
    for (const pool of pools)
      aucByPool[pool] = areaUnderCurve(scored.filter((label) => label.pool === pool));
    cleanCheck.push({
      runtime,
      labels: points.length,
      precisionAtApply: at(calibration.applyFrom),
      precisionAtSuggest: at(calibration.suggestFrom),
      recallAtAccept:
        acceptFrom === null || positives === 0
          ? null
          : points
              .filter((point) => point.positive && point.score >= acceptFrom)
              .reduce((t, point) => t + point.weight, 0) / positives,
      ece: quality.ece,
      brier: brierScore(points),
      reliability: quality.bins,
      aucByPool
    });
  }
  const mlxScores = (await labelScores("mlx")).scores;
  const rv6 = reverseOnlyLossR6({ items: fixture.items, scores: mlxScores, calibration: mlx });
  let x1: GateFResult["x1"] = null;
  let rv9: ReverseOnlyLoss | null = null;
  if (typeof values["x1-export"] === "string" && typeof values["x1-scores"] === "string") {
    const data = retrievalExportSchema.parse(
      JSON.parse(await readFile(resolve(values["x1-export"]), "utf8"))
    );
    const scores = (await readScores(resolve(values["x1-scores"]))).scores;
    const heldOut = rootLevel({
      data,
      scores,
      calibration: mlx,
      lists: listsOf(mapping, "holdout")
    });
    const tuning = rootLevel({ data, scores, calibration: mlx, lists: listsOf(mapping, "tuning") });
    x1 = {
      ...heldOut,
      partition: "holdout",
      reached: heldOut.expectedOf - heldOut.missed.filter((row) => !row.reached).length,
      tuning
    };
    const accepted = new Set(
      acceptedPairs({ data, scores, calibration: mlx }).map((pair) => notePairKey(pair.lo, pair.hi))
    );
    const relations = z
      .array(
        z
          .object({
            source_note: z.string(),
            target_note: z.string(),
            source_root: z.string(),
            target_root: z.string()
          })
          .passthrough()
      )
      .parse(JSON.parse(await readFile(paths.rv9Relations, "utf8")));
    const lostLabels = new Map<string, boolean>();
    for (const item of fixture.items)
      if (item.related !== null) lostLabels.set(notePairKey(item.lo, item.hi), item.related);
    // Each later blind pass (the freeze pass, and a second one for the kept pairs when needed).
    const passes = typeof values["rv9-pass"] === "string" ? values["rv9-pass"].split(",") : [];
    for (const path of passes) {
      const pass = z
        .object({
          items: z.array(
            z
              .object({
                lo: z.string(),
                hi: z.string(),
                related: z.object({ majority: z.boolean().nullable() })
              })
              .passthrough()
          )
        })
        .passthrough()
        .parse(JSON.parse(await readFile(resolve(path), "utf8")));
      for (const item of pass.items)
        if (item.related.majority !== null)
          lostLabels.set(notePairKey(item.lo, item.hi), item.related.majority);
    }
    const sample = fixture.items
      .filter((item) => item.sets.includes("rv9-sample") && item.related !== null)
      .map((item) => ({ lo: item.lo, hi: item.hi, related: item.related! }));
    rv9 = reverseOnlyLossR9({
      pairs: relations.map((row) => ({
        lo: row.source_note,
        hi: row.target_note,
        sameRoot: row.source_root === row.target_root
      })),
      accepted,
      sample,
      labels: lostLabels
    });
    await writeJsonFile(join(paths.outDir, "rv9-lost.json"), { pairs: rv9.lostPairs });
    await writeJsonFile(join(paths.outDir, "rv9-kept-unlabelled.json"), {
      pairs: rv9.keptUnlabelledPairs
    });
  }
  let typer: GateFResult["typer"] = null;
  if (typeof values["typer-report"] === "string") {
    const report = typerReportSchema.parse(
      JSON.parse(await readFile(resolve(values["typer-report"]), "utf8"))
    );
    typer = {
      directionAccuracy: report.summary.directionAccuracy,
      swapConsistency: report.summary.swapConsistency,
      pairs: report.summary.pairs
    };
  }
  return {
    configHash: record.configHash,
    frozenAt: record.frozenAt,
    readAt: (input.now ?? (() => new Date()))().toISOString(),
    x1,
    rv6,
    rv9,
    typer,
    cleanCheck
  };
}

const pass = (ok: boolean | null) => (ok === null ? "pending" : ok ? "pass" : "FAIL");

export function renderGateF(result: GateFResult): string {
  const lines = [
    `# Gate F reads (frozen ${result.configHash.slice(0, 16)} at ${result.frozenAt}; read ${result.readAt})`,
    "",
    "| Check | Value | Bar | Verdict |",
    "| --- | --- | --- | --- |"
  ];
  if (result.x1) {
    const x1 = result.x1;
    lines.push(
      `| X1 forecast, held-out expected (optimistic typing) | ${x1.expected}/${x1.expectedOf} | >= ${gateFBars.heldOutExpected}/28 | ${pass(x1.expected >= gateFBars.heldOutExpected)} |`,
      `| X1 forecast, held-out forbidden | ${x1.forbidden}/${x1.forbiddenOf} | ${gateFBars.heldOutForbidden}/35 | ${pass(x1.forbidden <= gateFBars.heldOutForbidden)} |`,
      `| X1 pessimistic bound (only typed pairs count) | ${x1.expectedPessimistic}/${x1.expectedOf} | reported | - |`,
      `| X1 applied-only | ${x1.expectedApplied}/${x1.expectedOf} | reported | - |`,
      `| Held-out candidate recall | ${x1.reached}/${x1.expectedOf} | reported | - |`,
      `| Tuning in the same export | ${x1.tuning.expected}/${x1.tuning.expectedOf}, ${x1.tuning.forbidden}/${x1.tuning.forbiddenOf} forbidden | reported | - |`
    );
  } else
    lines.push("| X1 forecast | needs --x1-export and --x1-scores | >= 27/28, 0/35 | pending |");
  for (const loss of [result.rv6, result.rv9])
    if (loss)
      lines.push(
        `| X2 ${loss.set} loss (panel-related) | ${loss.loss === null ? `pending (${loss.unlabelledLost} lost pairs unlabelled)` : fmt(loss.loss)}${loss.interval ? ` [${fmt(loss.interval[0])}, ${fmt(loss.interval[1])}]` : ""} | <= ${gateFBars.reverseOnlyLoss} | ${pass(loss.loss === null ? null : loss.loss <= gateFBars.reverseOnlyLoss)} |`,
        `| X2 ${loss.set} literal loss | ${loss.lost}/${loss.pairs} (${fmt(loss.literalLoss)}); same-root ${loss.sameRoot.lost}/${loss.sameRoot.pairs} | reported | - |`
      );
  if (result.typer)
    lines.push(
      `| Typer direction accuracy | ${fmt(result.typer.directionAccuracy)} (${result.typer.pairs} pairs) | >= ${gateFBars.typerDirectionAccuracy} | ${pass(result.typer.directionAccuracy === null ? null : result.typer.directionAccuracy >= gateFBars.typerDirectionAccuracy)} |`,
      `| Typer swap consistency | ${fmt(result.typer.swapConsistency)} | >= ${gateFBars.typerSwapConsistency} | ${pass(result.typer.swapConsistency === null ? null : result.typer.swapConsistency >= gateFBars.typerSwapConsistency)} |`
    );
  else lines.push("| Typer checks | needs --typer-report | >= 0.85, >= 0.90 | pending |");
  lines.push(
    "",
    "## Clean check: the panel's eval split (nothing was chosen on it)",
    "",
    "| Decider | Labels | Precision at p_apply | Precision at p_suggest | Recall at the accept band | ECE | Brier | AUC A/B/C |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |"
  );
  for (const row of result.cleanCheck)
    lines.push(
      `| ${row.runtime} | ${row.labels} | ${fmt(row.precisionAtApply)} | ${fmt(row.precisionAtSuggest)} | ${fmt(row.recallAtAccept)} | ${fmt(row.ece)} | ${fmt(row.brier)} | ${pools.map((pool) => fmt(row.aucByPool[pool])).join("/")} |`
    );
  if (result.x1)
    lines.push(
      "",
      `Held-out expected missed: ${result.x1.missed.map((row) => `${row.pair} (${row.reached ? `best ${fmt(row.bestScore)}` : "not reached"})`).join("; ") || "none"}; forbidden linked: ${result.x1.forbiddenLinked.join(" ") || "none"}.`
    );
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  try {
    await runBakeoffCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[relations/bakeoff] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
