// MLX embedding throughput by batch size on a seeded sample of the corpus
// pseudo-notes (same input as embed-real.ts), for the F2/F3 embedMany defaults.
// Every batch size is measured `--reps` times (default 3) in a rotating order, because a
// single pass per size cannot separate the batch-size effect from run-to-run noise
// (Spike B review).
//
//   npx tsx scripts/spikes/topic-tree/embed-throughput.ts [--sample 512] [--reps 3]
//
// Writes .cache/spikes/topic-tree/embed-throughput.json.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { modelDirectory, readModelManifest } from "../download-models.js";
import { MlxHelperClient } from "../lib/mlx-helper-client.js";
import { waitForLocalModelSlot } from "./local-model-slot.js";
import { loadCorpus, spikeDir } from "./real-data.js";
import { createRng } from "./rng.js";

const args = process.argv.slice(2);
const sampleSize = Number(args[args.indexOf("--sample") + 1] ?? 512) || 512;
const repetitions = args.includes("--reps") ? Number(args[args.indexOf("--reps") + 1]) || 3 : 3;
const batchSizes = [1, 4, 8, 16, 32];
const textsPerRequest = 128;

const model = (await readModelManifest()).find(
  (entry) => entry.name === "qwen3-embedding-0.6b-mlx"
);
if (!model) throw new Error("models.json has no qwen3-embedding-0.6b-mlx");
const modelPath = modelDirectory(model);
const corpus = await loadCorpus();
const inputs = createRng(7)
  .shuffle(corpus.map((entry) => entry.input))
  .slice(0, sampleSize);

await waitForLocalModelSlot();
const client = await MlxHelperClient.start();
const rows: Record<string, number>[] = [];
try {
  // Warm-up loads the model once.
  await client.embed({ modelPath, texts: inputs.slice(0, 4), batchSize: 4 });
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    // Rotate the order so no batch size always runs first or last.
    const order = batchSizes.map(
      (_, index) => batchSizes[(index + repetition) % batchSizes.length] as number
    );
    for (const batchSize of order) {
      let tokens = 0;
      let inferenceMs = 0;
      const started = performance.now();
      for (let start = 0; start < inputs.length; start += textsPerRequest) {
        const result = await client.embed({
          modelPath,
          texts: inputs.slice(start, start + textsPerRequest),
          batchSize
        });
        tokens += result.inputTokens;
        inferenceMs += result.timing.inferenceMs;
      }
      const wallMs = performance.now() - started;
      const row = {
        repetition: repetition + 1,
        batchSize,
        texts: inputs.length,
        tokens,
        wallMs: Math.round(wallMs),
        inferenceMs: Math.round(inferenceMs),
        textsPerSecond: Number((inputs.length / (wallMs / 1000)).toFixed(1)),
        msPerText: Number((wallMs / inputs.length).toFixed(2))
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
} finally {
  await client.shutdown();
}
const summary = batchSizes.map((batchSize) => {
  const speeds = rows
    .filter((row) => row.batchSize === batchSize)
    .map((row) => row.textsPerSecond as number);
  const mean = speeds.reduce((total, value) => total + value, 0) / Math.max(1, speeds.length);
  return {
    batchSize,
    runs: speeds.length,
    textsPerSecondMean: Number(mean.toFixed(1)),
    textsPerSecondMin: Math.min(...speeds),
    textsPerSecondMax: Math.max(...speeds)
  };
});
console.table(summary);
await writeFile(
  join(spikeDir, "embed-throughput.json"),
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      model: { name: model.name, revision: model.revision },
      sample: sampleSize,
      order: "random (unsorted lengths)",
      textsPerRequest,
      repetitions,
      summary,
      rows
    },
    null,
    2
  )}\n`,
  "utf8"
);
