/**
 * Scores a pair set with one local reranker runtime and writes the log-odds under
 * `.cache/spikes/reranker/scores/`.
 *
 *   npx tsx scripts/spikes/reranker/score.ts --runtime mlx --instruction relation --set tuning
 *   npx tsx scripts/spikes/reranker/score.ts --runtime gguf-qwen3 --set all      (frozen instruction)
 *   npx tsx scripts/spikes/reranker/score.ts --runtime gguf-bge --set all
 *
 * Options: --runtime mlx|gguf-qwen3|gguf-bge, --instruction <id> (default: the frozen one;
 * ignored by gguf-bge), --set tuning|holdout|all, --batch <n> (MLX only, default 16).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";

import {
  loadDataset,
  loadFrozen,
  runtimeNames,
  type PairSetName,
  type RuntimeName
} from "./dataset.js";
import { instructionCandidates } from "./instructions.js";
import { mean } from "./metrics.js";
import { openRuntime } from "./runtimes.js";
import { scoreFileName, scoresDirectory, type ScoreFile } from "./scores.js";

function option(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const runtimeName = option("--runtime") as RuntimeName | undefined;
if (!runtimeName || !runtimeNames.includes(runtimeName)) {
  throw new Error(`--runtime must be one of ${runtimeNames.join(", ")}`);
}
const setName = (option("--set") ?? "all") as PairSetName;
const batchSize = Number(option("--batch") ?? 16);
const usesInstruction = runtimeName !== "gguf-bge";
const instructionId = usesInstruction
  ? (option("--instruction") ?? (await loadFrozen()).instructionId)
  : "none";
const instruction = usesInstruction ? instructionCandidates[instructionId] : undefined;
if (usesInstruction && !instruction) throw new Error(`Unknown instruction ${instructionId}`);

const dataset = await loadDataset();
const textById = new Map(dataset.notes.map((note) => [note.id, note.text]));
const pairIds = dataset.sets[setName];
if (!pairIds) throw new Error(`Unknown set ${setName}`);
const pairs = pairIds.map(([query, document]) => ({
  query: textById.get(query)!,
  document: textById.get(document)!
}));

console.info(
  `${runtimeName} / ${instructionId} / ${setName}: ${pairs.length} pairs (batch ${batchSize}, ` +
    `load average ${loadavg()
      .map((v) => v.toFixed(1))
      .join(" ")})`
);
const startedAt = new Date().toISOString();
const runtime = await openRuntime(runtimeName, instruction);
try {
  // Warm up on a few pairs so the model load and kernel compilation stay out of the wall time.
  await runtime.scorePairs(pairs.slice(0, 4), batchSize);
  const started = performance.now();
  const result = await runtime.scorePairs(pairs, batchSize, (done) =>
    console.info(`  ${done}/${pairs.length}`)
  );
  const wallMs = performance.now() - started;
  if (result.logOdds.length !== pairs.length || !result.logOdds.every(Number.isFinite)) {
    throw new Error("Runtime returned missing or non-finite scores");
  }
  const file: ScoreFile = {
    runtime: runtimeName,
    artifact: runtime.artifact,
    instructionId,
    instruction: instruction ?? null,
    set: setName,
    batchSize,
    startedAt,
    wallMs,
    pairCount: pairs.length,
    logOdds: result.logOdds,
    meanTokensPerPair: result.tokenCounts ? mean(result.tokenCounts) : null,
    hostLoadAverage: loadavg()
  };
  await mkdir(scoresDirectory, { recursive: true });
  const path = join(scoresDirectory, scoreFileName(runtimeName, instructionId, setName, batchSize));
  await writeFile(path, `${JSON.stringify(file)}\n`);
  console.info(
    `done in ${(wallMs / 1000).toFixed(1)} s (${(wallMs / pairs.length).toFixed(1)} ms/pair wall` +
      `${file.meanTokensPerPair ? `, ${file.meanTokensPerPair.toFixed(0)} tokens/pair` : ""}) -> ${path}`
  );
} finally {
  await runtime.dispose();
}
