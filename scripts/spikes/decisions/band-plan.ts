/**
 * Band-only requests for the Spike A2 cascade.
 *
 * The cascade accepts a pair on MLX's own score (max of both directions) at or above MLX's tuning
 * threshold (`hi`), rejects it below `lo`, and sends only the pairs in [lo, hi) to Decisions. The
 * first cascade numbers reused probabilities from full-shortlist requests (about 19 candidates per
 * request), which is not what a tiebreaker would send. Here each source note's request carries
 * only its band partners, in both directions (a directed pair needs its own request because the
 * query note differs), grouped by query note and chunked like the other stages.
 */
import { evaluateSplit, logOddsLookup, primaryPhase, buildContext } from "../reranker/core.js";
import type { Context, RowScore } from "../reranker/core.js";
import { loadDataset, loadFrozen } from "../reranker/dataset.js";
import type { Dataset, DatasetRow, Partition } from "../reranker/dataset.js";
import { chooseThreshold } from "../reranker/metrics.js";
import { loadScoreFile } from "../reranker/scores.js";

import { maxCandidatesPerRequest } from "./design.js";
import { chunk } from "./plan.js";

/** Lower edges of MLX's uncertain band: descriptive values, not chosen on held-out. */
export const bandLows = [0, 1.5, 2.5] as const;
export type BandLow = (typeof bandLows)[number];

export interface BandContext {
  dataset: Dataset;
  context: Context;
  instruction: string;
  /** MLX Qwen3, max of both directions (log-odds), Spike A's scores read-only. */
  mlxMax: RowScore;
  /** Upper edge of the band: MLX's tuning-only threshold for the max-of-both score. */
  mlxThreshold: number;
}

export async function loadBandContext(): Promise<BandContext> {
  const dataset = await loadDataset();
  const context = buildContext(dataset);
  const frozen = await loadFrozen();
  const mlxFile = await loadScoreFile("mlx", frozen.instructionId, "all", 16);
  const lookup = logOddsLookup(dataset.sets.all, mlxFile.logOdds);
  const mlxMax: RowScore = (row) =>
    Math.max(lookup(row.query, row.doc), lookup(row.doc, row.query));
  const choice = chooseThreshold(evaluateSplit(context, "tuning", mlxMax).labelled);
  if (!choice) throw new Error("no MLX tuning threshold");
  return {
    dataset,
    context,
    instruction: frozen.instruction,
    mlxMax,
    mlxThreshold: choice.threshold
  };
}

export function partitionRows(ctx: BandContext, partition: Partition): DatasetRow[] {
  return ctx.context.rowsByPhase.get(primaryPhase[partition]) ?? [];
}

export function inBand(ctx: BandContext, row: DatasetRow, lo: number): boolean {
  const m = ctx.mlxMax(row);
  return m >= lo && m < ctx.mlxThreshold;
}

export function bandRows(ctx: BandContext, partition: Partition, lo: number): DatasetRow[] {
  return partitionRows(ctx, partition).filter((row) => inBand(ctx, row, lo));
}

const pairId = (query: string, doc: string): string => `${query}|${doc}`;

/** Every directed pair the tiebreaker has to score for the band rows, deduplicated. */
export function bandDirectedPairs(
  ctx: BandContext,
  partition: Partition,
  lo: number
): Array<[string, string]> {
  const seen = new Map<string, [string, string]>();
  for (const row of bandRows(ctx, partition, lo)) {
    seen.set(pairId(row.query, row.doc), [row.query, row.doc]);
    seen.set(pairId(row.doc, row.query), [row.doc, row.query]);
  }
  return [...seen.values()];
}

export interface BandJob {
  key: string;
  partition: Partition;
  lo: number;
  queryId: string;
  candidateIds: string[];
}

export function planBand(ctx: BandContext, partition: Partition, lo: number): BandJob[] {
  const byQuery = new Map<string, string[]>();
  for (const [query, doc] of bandDirectedPairs(ctx, partition, lo)) {
    const list = byQuery.get(query) ?? [];
    list.push(doc);
    byQuery.set(query, list);
  }
  const jobs: BandJob[] = [];
  for (const [queryId, docs] of [...byQuery.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    docs.sort();
    chunk(docs, maxCandidatesPerRequest).forEach((candidateIds, index) => {
      jobs.push({
        key: `band:${partition}:lo${lo}:${queryId}:${index}`,
        partition,
        lo,
        queryId,
        candidateIds
      });
    });
  }
  return jobs;
}

export const bandRunId = (partition: Partition, lo: number, orderSalt = ""): string =>
  `band-${partition}-lo${lo}__predicate${orderSalt ? `__order${orderSalt}` : ""}`;
