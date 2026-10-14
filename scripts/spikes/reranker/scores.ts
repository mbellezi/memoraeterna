/** Score files written by `score.ts` and read by `select-instruction.ts` and `evaluate.ts`. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { outputDirectory, runtimeNames, type RuntimeName } from "./dataset.js";

export const scoresDirectory = join(outputDirectory, "scores");

export const scoreFileSchema = z
  .object({
    runtime: z.enum(runtimeNames),
    artifact: z
      .object({
        name: z.string(),
        repository: z.string(),
        revision: z.string(),
        license: z.string(),
        mainFile: z.string(),
        sha256: z.string(),
        bytes: z.number().int()
      })
      .strict(),
    /** Instruction id; `none` for runtimes without an instruction (bge). */
    instructionId: z.string(),
    instruction: z.string().nullable(),
    set: z.enum(["tuning", "holdout", "all"]),
    batchSize: z.number().int().positive(),
    startedAt: z.string(),
    wallMs: z.number(),
    pairCount: z.number().int(),
    /** Log-odds aligned with `dataset.sets[set]`. */
    logOdds: z.array(z.number()),
    meanTokensPerPair: z.number().nullable(),
    hostLoadAverage: z.array(z.number())
  })
  .strict();

export type ScoreFile = z.infer<typeof scoreFileSchema>;

export function scoreFileName(
  runtime: RuntimeName,
  instructionId: string,
  set: string,
  batchSize: number
): string {
  return `${runtime}__${instructionId}__${set}__b${batchSize}.json`;
}

export async function loadScoreFile(
  runtime: RuntimeName,
  instructionId: string,
  set: string,
  batchSize: number
): Promise<ScoreFile> {
  const path = join(scoresDirectory, scoreFileName(runtime, instructionId, set, batchSize));
  return scoreFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
