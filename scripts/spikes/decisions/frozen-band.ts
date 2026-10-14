/**
 * The freeze for the band-only cascade measurement of Spike A2.
 *
 * The band edges and the Decisions threshold come from tuning data only. Once the tuning band-only
 * requests (both candidate orders, every band edge) are scored, `band.ts --freeze` records the
 * thresholds here; `band.ts` refuses to send held-out band requests without this file, and the
 * freeze refuses to be written once any held-out band request exists.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { evaluateSplit } from "../reranker/core.js";
import type { RowScore } from "../reranker/core.js";
import { chooseThreshold, logit } from "../reranker/metrics.js";

import { bandLows, bandRunId, planBand, type BandContext } from "./band-plan.js";
import { outputDirectory, rawDirectory, readRaw } from "./budget.js";
import { currentFingerprint } from "./frozen.js";
import { loadScores, pairId } from "./scores.js";

export const frozenBandPath = join(outputDirectory, "frozen-band.json");
export const bandOrders = ["", "B"] as const;

const frozenBandSchema = z
  .object({
    designFingerprint: z.string(),
    mlxThreshold: z.number(),
    decisionsLogOdds: z.number(),
    decisionsProbability: z.number(),
    lows: z.array(z.number()),
    tuningRequests: z.record(z.string(), z.number()),
    frozenAt: z.string(),
    basis: z.string()
  })
  .strict();

/** The Decisions threshold of the report (max of both directions, full-shortlist requests, tuning only). */
export async function decisionsMaxBothThreshold(ctx: BandContext): Promise<number> {
  const scores = await loadScores(ctx.dataset);
  const lg = (p: number): number => logit(p, 0.005);
  const prob = (query: string, doc: string): number => {
    const entry = scores.predicate.get(pairId(query, doc));
    if (!entry) throw new Error(`No score for ${query} -> ${doc}`);
    return entry.probability ?? 0;
  };
  const dMax: RowScore = (row) =>
    Math.max(lg(prob(row.query, row.doc)), lg(prob(row.doc, row.query)));
  const choice = chooseThreshold(evaluateSplit(ctx.context, "tuning", dMax).labelled);
  if (!choice) throw new Error("no Decisions tuning threshold");
  return choice.threshold;
}

async function heldOutBandRunsExist(): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(rawDirectory);
  } catch {
    return false;
  }
  return names.some((name) => name.startsWith("band-holdout-"));
}

export async function writeFrozenBand(ctx: BandContext): Promise<void> {
  if (await heldOutBandRunsExist())
    throw new Error(
      "Held-out band requests already exist; the band design can no longer be frozen"
    );
  const tuningRequests: Record<string, number> = {};
  for (const lo of bandLows) {
    for (const order of bandOrders) {
      const runId = bandRunId("tuning", lo, order);
      const done = new Set((await readRaw(runId)).filter((r) => r.ok).map((r) => r.key));
      const planned = planBand(ctx, "tuning", lo);
      if (!planned.every((job) => done.has(job.key)))
        throw new Error(`${runId} is incomplete; score all tuning band runs before freezing`);
      tuningRequests[runId] = planned.length;
    }
  }
  const decisions = await decisionsMaxBothThreshold(ctx);
  const current = await currentFingerprint();
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    frozenBandPath,
    `${JSON.stringify(
      {
        designFingerprint: current.fingerprint,
        mlxThreshold: ctx.mlxThreshold,
        decisionsLogOdds: decisions,
        decisionsProbability: 1 / (1 + Math.exp(-decisions)),
        lows: [...bandLows],
        tuningRequests,
        frozenAt: new Date().toISOString(),
        basis:
          "MLX threshold and Decisions threshold are the tuning-only values of the report; band edges are descriptive"
      },
      null,
      2
    )}\n`
  );
}

/** Throws unless the band design was frozen on tuning and still matches the code and data. */
export async function assertBandFrozen(ctx: BandContext): Promise<void> {
  let stored: z.infer<typeof frozenBandSchema>;
  try {
    stored = frozenBandSchema.parse(JSON.parse(await readFile(frozenBandPath, "utf8")));
  } catch {
    throw new Error("Band design not frozen: run `band.ts --freeze` after the tuning band runs");
  }
  const current = await currentFingerprint();
  if (stored.designFingerprint !== current.fingerprint)
    throw new Error("The design changed after the band freeze; held-out band runs must not run");
  if (Math.abs(stored.mlxThreshold - ctx.mlxThreshold) > 1e-9)
    throw new Error("The MLX threshold changed after the band freeze");
  if (Math.abs(stored.decisionsLogOdds - (await decisionsMaxBothThreshold(ctx))) > 1e-9)
    throw new Error("The Decisions threshold changed after the band freeze");
}
