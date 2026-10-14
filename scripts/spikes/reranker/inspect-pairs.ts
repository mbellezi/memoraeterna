/**
 * Prints the labelled root pairs of one decider sorted by score, with the best-scoring note pair
 * for each, so misses and near-misses can be read next to the old judge and the cosine.
 *
 *   npx tsx scripts/spikes/reranker/inspect-pairs.ts [--decider mlx|gguf-qwen3|gguf-bge]
 *     [--split tuning|holdout] [--threshold 3.31]
 */
import { buildContext, logOddsLookup, primaryPhase } from "./core.js";
import { loadDataset, loadFrozen, type Partition } from "./dataset.js";
import { loadScoreFile } from "./scores.js";

function option(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const decider = (option("--decider") ?? "mlx") as "mlx" | "gguf-qwen3" | "gguf-bge";
const split = (option("--split") ?? "holdout") as Partition;
const threshold = Number(option("--threshold") ?? Number.NaN);
const dataset = await loadDataset();
const context = buildContext(dataset);
const frozen = await loadFrozen();
const file = await loadScoreFile(
  decider,
  decider === "gguf-bge" ? "none" : frozen.instructionId,
  "all",
  16
);
const lookup = logOddsLookup(dataset.sets.all, file.logOdds);
const rows = context.rowsByPhase.get(primaryPhase[split]) ?? [];

interface Best {
  key: string;
  kind: string;
  score: number;
  query: string;
  doc: string;
  oldLlm: number;
  cosine: number;
}
const best = new Map<string, Best>();
const kinds = new Map<string, string>([
  ...context.labelKeys[split].expected.map((key) => [key, "expected"] as const),
  ...context.labelKeys[split].forbidden.map((key) => [key, "forbidden"] as const)
]);
for (const row of rows) {
  const a = context.noteById.get(row.query)!;
  const b = context.noteById.get(row.doc)!;
  if (a.root === b.root) continue;
  const key = [a.root, b.root].sort().join("/");
  const kind = kinds.get(key);
  if (!kind) continue;
  const score = lookup(row.query, row.doc);
  const current = best.get(key);
  if (!current || score > current.score) {
    best.set(key, {
      key,
      kind,
      score,
      query: a.title,
      doc: b.title,
      oldLlm: row.oldLlm,
      cosine: row.cosine
    });
  }
}
const missing = [...kinds.keys()].filter((key) => !best.has(key));
console.info(`${decider} / ${split} / threshold ${Number.isNaN(threshold) ? "-" : threshold}`);
for (const entry of [...best.values()].sort((a, b) => b.score - a.score)) {
  const mark = Number.isNaN(threshold) ? " " : entry.score >= threshold ? "+" : "-";
  console.info(
    `${mark} ${entry.kind.padEnd(9)} ${entry.key.padEnd(8)} ${entry.score.toFixed(2).padStart(7)}  ` +
      `llm ${entry.oldLlm.toFixed(2)}  cos ${entry.cosine.toFixed(3)}  ` +
      `"${entry.query.slice(0, 40)}" -> "${entry.doc.slice(0, 40)}"`
  );
}
if (missing.length) console.info(`not retrieved: ${missing.join(", ")}`);
