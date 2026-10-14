/**
 * Picks the Qwen3-Reranker instruction using the TUNING split only and freezes it.
 *
 *   for i in default relation mechanism study; do
 *     npx tsx scripts/spikes/reranker/score.ts --runtime mlx --instruction $i --set tuning
 *   done
 *   npx tsx scripts/spikes/reranker/select-instruction.ts
 *
 * Ranking: (1) expected root pairs found on tuning at the zero-forbidden threshold, (2) root AUC
 * expected vs forbidden, (3) AUC against the old judge's verdict. Writes `frozen.json` and
 * `instruction-selection.json`. No held-out data is read.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { aucVersusOldJudge, buildContext, evaluateSplit, logOddsLookup } from "./core.js";
import { frozenPath, loadDataset, outputDirectory } from "./dataset.js";
import { instructionCandidates } from "./instructions.js";
import { chooseThreshold, rootOutcome } from "./metrics.js";
import { loadScoreFile } from "./scores.js";

const batchFlag = process.argv.indexOf("--batch");
const batchSize = batchFlag >= 0 ? Number(process.argv[batchFlag + 1]) : 16;
const dataset = await loadDataset();
const context = buildContext(dataset);

interface Candidate {
  instructionId: string;
  threshold: number | null;
  expectedFound: number;
  forbiddenFound: number;
  rootAuc: number | null;
  aucVersusLlmYes: number | null;
  aucVersusAccepted: number | null;
  meanTokensPerPair: number | null;
}

const candidates: Candidate[] = [];
for (const instructionId of Object.keys(instructionCandidates)) {
  const file = await loadScoreFile("mlx", instructionId, "tuning", batchSize);
  const lookup = logOddsLookup(dataset.sets.tuning, file.logOdds);
  const score = (row: { query: string; doc: string }): number => lookup(row.query, row.doc);
  const split = evaluateSplit(context, "tuning", score);
  const choice = chooseThreshold(split.labelled);
  const outcome = choice ? rootOutcome(split.labelled, choice.threshold) : null;
  candidates.push({
    instructionId,
    threshold: choice?.threshold ?? null,
    expectedFound: outcome?.expectedFound ?? 0,
    forbiddenFound: outcome?.forbiddenFound ?? 0,
    rootAuc: split.rootAuc,
    aucVersusLlmYes: aucVersusOldJudge(split.rows, score, "llm-yes"),
    aucVersusAccepted: aucVersusOldJudge(split.rows, score, "accepted"),
    meanTokensPerPair: file.meanTokensPerPair
  });
}

const key = (c: Candidate): number[] => [c.expectedFound, c.rootAuc ?? 0, c.aucVersusLlmYes ?? 0];
const ranked = [...candidates].sort((a, b) => {
  const [ka, kb] = [key(a), key(b)];
  for (let index = 0; index < ka.length; index += 1) {
    if (ka[index] !== kb[index]) return kb[index]! - ka[index]!;
  }
  return 0;
});
const best = ranked[0]!;
const fixed = (value: number | null, digits = 4): string =>
  value === null ? "n/a" : value.toFixed(digits);
const expectedTotal = context.labelKeys.tuning.expected.length;
console.info("instruction   found    rootAUC  AUC~llmYes  AUC~accepted  threshold(logodds)");
for (const c of ranked) {
  console.info(
    `${c.instructionId.padEnd(12)}  ${c.expectedFound}/${expectedTotal}  ${fixed(c.rootAuc)}  ` +
      `${fixed(c.aucVersusLlmYes)}      ${fixed(c.aucVersusAccepted)}        ${fixed(c.threshold, 2)}`
  );
}
await writeFile(
  join(outputDirectory, "instruction-selection.json"),
  `${JSON.stringify({ batchSize, split: "tuning", ranked }, null, 2)}\n`
);
await writeFile(
  frozenPath,
  `${JSON.stringify(
    {
      instructionId: best.instructionId,
      instruction: instructionCandidates[best.instructionId],
      chosenAt: new Date().toISOString(),
      basis:
        "tuning split only: expected root pairs found at the zero-forbidden threshold, then " +
        "root AUC expected vs forbidden, then AUC against the old judge verdict"
    },
    null,
    2
  )}\n`
);
console.info(`Frozen instruction: ${best.instructionId}`);
