/**
 * Spike A latency: single-pair, 8-candidate and 20-candidate per-note timings for each runtime on
 * realistic note pairs, written to `.cache/spikes/reranker/latency.json`.
 *
 *   npx tsx scripts/spikes/reranker/latency.ts [--notes 30] [--repeats 3] [--only mlx,gguf-bge]
 *
 * Sections run one runtime at a time (local inference is serialized). Calls are timed from the
 * caller's side, so MLX numbers include the JSONL round trip to the helper. The host load average
 * is recorded because other processes on the machine inflate the numbers.
 */
import { writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { loadDataset, loadFrozen, outputDirectory, type RuntimeName } from "./dataset.js";
import { instructionCandidates } from "./instructions.js";
import { mean, percentile, seededRandom } from "./metrics.js";
import { openRuntime, type RerankRuntime } from "./runtimes.js";

function option(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const noteCount = Number(option("--notes") ?? 30);
const repeats = Number(option("--repeats") ?? 3);
const only = option("--only")?.split(",") as RuntimeName[] | undefined;
const runtimes: RuntimeName[] = (["mlx", "gguf-qwen3", "gguf-bge"] as const).filter(
  (name) => !only || only.includes(name)
);
const dataset = await loadDataset();
const frozen = await loadFrozen();
const instruction = instructionCandidates[frozen.instructionId]!;
const textById = new Map(dataset.notes.map((note) => [note.id, note.text]));

// A seeded sample of source notes with their 20 judged candidates (the pipeline's own shortlists).
const shortlists = new Map<string, string[]>();
for (const row of dataset.rows) {
  if (row.phase !== "economy" && row.phase !== "validate") continue;
  const list = shortlists.get(row.query) ?? [];
  if (!list.includes(row.doc)) list.push(row.doc);
  shortlists.set(row.query, list);
}
const random = seededRandom(20_261_014);
const eligible = [...shortlists.entries()].filter(([, docs]) => docs.length >= 20);
for (let index = eligible.length - 1; index > 0; index -= 1) {
  const swap = Math.floor(random() * (index + 1));
  [eligible[index], eligible[swap]] = [eligible[swap]!, eligible[index]!];
}
const sample = eligible.slice(0, noteCount).map(([query, docs]) => ({
  query: textById.get(query)!,
  documents: docs.slice(0, 20).map((id) => textById.get(id)!)
}));
const singles = sample.flatMap((note) =>
  note.documents.slice(0, 7).map((document) => ({ query: note.query, document }))
);

interface Timing {
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function summarize(values: number[]): Timing {
  return {
    samples: values.length,
    meanMs: mean(values),
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values)
  };
}

async function measure(name: RuntimeName) {
  const loadStarted = performance.now();
  const runtime: RerankRuntime = await openRuntime(
    name,
    name === "gguf-bge" ? undefined : instruction
  );
  const openMs = performance.now() - loadStarted;
  const loadBefore = loadavg();
  try {
    // The first call loads the MLX model and compiles kernels; time it, then warm up.
    const coldStarted = performance.now();
    await runtime.scoreDocuments(sample[0]!.query, sample[0]!.documents.slice(0, 8), 16);
    const firstCallMs = performance.now() - coldStarted;
    for (const note of sample.slice(0, 3)) {
      await runtime.scoreDocuments(note.query, note.documents.slice(0, 8), 16);
      await runtime.scoreDocuments(note.query, note.documents.slice(0, 1), 1);
    }

    const single: number[] = [];
    const singleDevice: number[] = [];
    const tokens: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const pair of singles) {
        const call = await runtime.scoreDocuments(pair.query, [pair.document], 1);
        single.push(call.wallMs);
        if (call.inferenceMs !== undefined) singleDevice.push(call.inferenceMs);
        if (call.tokenCounts && repeat === 0) tokens.push(...call.tokenCounts);
      }
    }

    const perNote = async (candidates: number, batchSize: number) => {
      const wall: number[] = [];
      const device: number[] = [];
      const amortized: number[] = [];
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        for (const note of sample) {
          const call = await runtime.scoreDocuments(
            note.query,
            note.documents.slice(0, candidates),
            batchSize
          );
          wall.push(call.wallMs);
          if (call.inferenceMs !== undefined) device.push(call.inferenceMs);
          for (const batch of call.batches ?? []) amortized.push(batch.ms / batch.size);
        }
      }
      return {
        candidates,
        batchSize,
        wall: summarize(wall),
        wallPerPairMeanMs: mean(wall) / candidates,
        ...(device.length ? { device: summarize(device) } : {}),
        ...(amortized.length ? { batchAmortizedPerPair: summarize(amortized) } : {})
      };
    };

    const note8 = await perNote(8, 16);
    const note20 = await perNote(20, 16);
    const note20OneBatch = name === "mlx" ? await perNote(20, 32) : null;
    const notesEstimated = 200;
    const estimateMinutes = (perNoteMs: number): number => (notesEstimated * perNoteMs) / 60_000;
    return {
      runtime: name,
      artifact: runtime.artifact,
      openMs,
      firstCallMs,
      hostLoadAverageBefore: loadBefore,
      hostLoadAverageAfter: loadavg(),
      meanTokensPerPair: tokens.length ? mean(tokens) : null,
      singlePairCall: {
        pairs: singles.length,
        repeats,
        wall: summarize(single),
        ...(singleDevice.length ? { device: summarize(singleDevice) } : {})
      },
      perNote8: note8,
      perNote20: note20,
      ...(note20OneBatch ? { perNote20Batch32: note20OneBatch } : {}),
      estimate200Notes8Candidates: {
        minutesAtMeanPerNote: estimateMinutes(note8.wall.meanMs),
        minutesAtP95PerNote: estimateMinutes(note8.wall.p95Ms)
      },
      estimate200Notes20Candidates: {
        minutesAtMeanPerNote: estimateMinutes(note20.wall.meanMs),
        minutesAtP95PerNote: estimateMinutes(note20.wall.p95Ms)
      }
    };
  } finally {
    await runtime.dispose();
  }
}

const results = [];
for (const name of runtimes) {
  console.info(
    `== ${name} (load average ${loadavg()
      .map((v) => v.toFixed(1))
      .join(" ")})`
  );
  const result = await measure(name);
  results.push(result);
  console.info(
    `  single pair p50 ${result.singlePairCall.wall.p50Ms.toFixed(1)} ms, p95 ${result.singlePairCall.wall.p95Ms.toFixed(1)} ms; ` +
      `note x8 mean ${result.perNote8.wall.meanMs.toFixed(0)} ms, note x20 mean ${result.perNote20.wall.meanMs.toFixed(0)} ms; ` +
      `200 notes x 8: ${result.estimate200Notes8Candidates.minutesAtMeanPerNote.toFixed(1)} min`
  );
}
await writeFile(
  join(outputDirectory, "latency.json"),
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      instructionId: frozen.instructionId,
      sampleNotes: sample.length,
      singlePairSample: singles.length,
      repeats,
      baselineToday: { secondsPerNote: 11.9, minutesFor200Notes: (200 * 11.9) / 60 },
      results
    },
    null,
    2
  )}\n`
);
console.info(`Wrote ${join(outputDirectory, "latency.json")}`);
