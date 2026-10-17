/**
 * Proof of the ranker pairs input and the parity reference (F3 T50, D13/D16, R1/R23), through the
 * product adapters that `AiService.rankPairs` calls. Two parts:
 *
 * - `--cassette-keys <cassette dir>` reads recorded topic-gate entries (a `{query, documents}`
 *   rank request) and shows that the product serialization still produces their exact input and
 *   cassette key. It runs no model.
 * - `--runtime mlx|gguf|both` runs the real rankers, one at a time, and only while the caller holds
 *   `.cache/f2/LOCAL_MODEL_BUSY`: parity of the product adapter with the Spike A scorer on a
 *   seeded sample of directed pairs of the Spike A fixture notes, scored in the same calls at the
 *   same helper batch; the p50 of a bounded call (32 pairs on MLX, 16 on GGUF); and the 64-pair
 *   parity reference scored in its fixed plan, repeated to show a build is deterministic, with the
 *   MLX helper batch-1 distance as the scale of bf16 batch noise. `--baseline-dir` writes the
 *   reference scores of each runtime, the baselines a calibration entry stores (D13).
 *
 *   npx tsx scripts/relations/ranker-pairs-proof.ts [--runtime mlx|gguf|both]
 *     [--models-dir <dir>] [--helper-path <file>] [--dataset <Spike A dataset.json>]
 *     [--pairs 500] [--seed 20261018] [--report <file>] [--baseline-dir <dir>]
 *     [--cassette-keys <dir>]
 *
 * Local inference runs one model at a time: MLX first, then GGUF, each disposed before the next, and
 * the spike scorer only after the product adapter was disposed.
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { AiCapability } from "@app/domain";

import type { AiModelAdapter, AiModelDescriptor } from "../../packages/ai/src/contracts.js";
import { aiCassetteRequestKey } from "../../packages/ai/src/cassette.js";
import {
  MlxRerankerAdapter,
  NodeLlamaRankerAdapter,
  rankPairsWithAdapter
} from "../../packages/ai/src/local-ranker-adapters.js";
import { MlxHelperHost } from "../../packages/ai/src/mlx-helper-host.js";
import {
  parseRankRequest,
  probabilityLogOdds,
  rankPairsLimits,
  rankTaskRequest
} from "../../packages/ai/src/ranker-input.js";
import {
  compareRankerParity,
  rankerParityPlan,
  rankerParityReference,
  rankerParityReferenceHash,
  scoreRankerParityReference
} from "../../packages/ai/src/ranker-parity.js";
import {
  validateGgufRankerArtifact,
  validateMlxRankerArtifact
} from "../../packages/ai/src/ranker-validation.js";
import { createQwen3RankingContext, loadGgufModel } from "../spikes/lib/gguf.js";
import { MlxHelperClient } from "../spikes/lib/mlx-helper-client.js";

const root = resolve(import.meta.dirname, "..", "..");
const modelsDir = resolve(optionValue("--models-dir") ?? join(root, ".cache", "models"));
const helperPath = resolve(
  optionValue("--helper-path") ??
    join(root, "native", "mlx-helper", ".build", "release", "memora-mlx-helper")
);
const datasetPath = resolve(
  optionValue("--dataset") ?? join(root, ".cache", "spikes", "reranker", "dataset.json")
);
const sampleSize = Number(optionValue("--pairs") ?? 500);
const seed = Number(optionValue("--seed") ?? 20261018);
const runtimeOption = optionValue("--runtime");
const reportPath = optionValue("--report");
const baselineDir = optionValue("--baseline-dir");
const cassetteDir = optionValue("--cassette-keys");
const capabilities: AiCapability[] = ["reranking", "offline", "local-files"];
/** The bar of the card: product versus spike scorer at equal batches, in log-odds. */
const parityBar = 1e-3;

const failures: string[] = [];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), seed, sampleSize };

function expect(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error(`FAIL: ${message}`);
  }
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  return value ? value : undefined;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Deterministic generator (mulberry32), the spikes' convention. */
function seededRandom(initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PinnedModel {
  name: string;
  repository: string;
  revision: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

async function pinnedModel(name: string): Promise<PinnedModel> {
  const manifest = JSON.parse(
    await readFile(join(root, "scripts", "spikes", "models.json"), "utf8")
  ) as { models: PinnedModel[] };
  const model = manifest.models.find((candidate) => candidate.name === name);
  if (!model) throw new Error(`models.json has no ${name}`);
  return model;
}

type Pair = { query: string; document: string };

/** A seeded sample of the Spike A directed pairs, with the texts of the fixture notes. */
async function samplePairs(): Promise<{ pairs: Pair[]; storedIndex: number[] }> {
  const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as {
    notes: Array<{ id: string; text: string }>;
    sets: { all: Array<[string, string]> };
  };
  const text = new Map(dataset.notes.map((note) => [note.id, note.text]));
  const indices = dataset.sets.all.map((_, index) => index);
  const random = seededRandom(seed);
  for (let index = indices.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [indices[index], indices[swap]] = [indices[swap]!, indices[index]!];
  }
  const storedIndex = indices.slice(0, sampleSize);
  return {
    storedIndex,
    pairs: storedIndex.map((index) => {
      const [query, document] = dataset.sets.all[index]!;
      return { query: text.get(query)!, document: text.get(document)! };
    })
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const slices: T[][] = [];
  for (let start = 0; start < items.length; start += size)
    slices.push(items.slice(start, start + size));
  return slices;
}

// --- recorded gate entries ------------------------------------------------------------------------------

async function cassetteKeys(directory: string): Promise<void> {
  const entries = join(resolve(directory), "entries");
  let seen = 0;
  let identical = 0;
  let hit = 0;
  for (const shard of await readdir(entries)) {
    for (const file of await readdir(join(entries, shard))) {
      const entry = JSON.parse(await readFile(join(entries, shard, file), "utf8")) as {
        key: string;
        taskType: string;
        request: {
          input: string;
          model: Record<string, string | undefined>;
          parameters: Record<string, unknown>;
        };
      };
      if (entry.taskType !== "reranking") continue;
      let rank;
      try {
        rank = parseRankRequest(entry.request.input);
      } catch {
        continue; // a generative decider's prompt, not a ranker call
      }
      seen += 1;
      const task = { ...rankTaskRequest(rank), modelId: entry.request.model.modelId };
      if (task.input === entry.request.input) identical += 1;
      const model = entry.request.model;
      const descriptor: AiModelDescriptor = {
        providerId: model.providerId!,
        modelId: model.modelId!,
        runtime: "local",
        capabilities,
        parameterCapabilities: {},
        limits: {},
        requirements: {
          adapter: model.adapter,
          repository: model.repository,
          revision: model.revision,
          quantization: model.quantization
        }
      };
      if (aiCassetteRequestKey(descriptor, task).key === entry.key) hit += 1;
    }
  }
  console.info(
    `cassette ${directory}: ${seen} recorded rank entries, ${identical} with a byte-identical ` +
      `product input, ${hit} with the same cassette key`
  );
  expect(seen > 0, `${directory} holds no recorded rank entry`);
  expect(identical === seen && hit === seen, `${directory}: ${seen - hit} entries would miss`);
  report.cassetteKeys = {
    directory,
    recordedRankEntries: seen,
    identicalInputs: identical,
    sameKey: hit
  };
}

// --- the runtimes -----------------------------------------------------------------------------------------

interface RuntimeProof {
  runtime: "mlx" | "gguf";
  adapter: AiModelAdapter & { runtimeBuild(): Promise<string> };
  helperBatch: number | undefined;
  /** Scores one chunk the way the spike scorer does, on its own runtime instance. */
  spike(pairs: Pair[][], instruction: string): Promise<number[][]>;
  modelIdentity: Record<string, unknown>;
  dispose(): Promise<void>;
}

async function openMlx(): Promise<RuntimeProof> {
  const pins = await pinnedModel("qwen3-reranker-0.6b-mlx");
  const directory = join(modelsDir, pins.name);
  const artifact = await validateMlxRankerArtifact({
    directory,
    files: pins.files.map((file) => ({
      path: file.path,
      sizeBytes: file.size,
      sha256: file.sha256
    }))
  });
  const host = new MlxHelperHost({ helperPath });
  const adapter = new MlxRerankerAdapter({
    modelId: pins.repository,
    modelPath: directory,
    helperPath,
    host,
    capabilities,
    revision: pins.revision
  });
  return {
    runtime: "mlx",
    adapter,
    helperBatch: rankPairsLimits.helperBatchSize,
    modelIdentity: { repository: pins.repository, revision: pins.revision, ...artifact },
    async spike(groups, instruction) {
      const client = await MlxHelperClient.start({ helperPath, timeoutMs: 30 * 60_000 });
      try {
        const scored: number[][] = [];
        for (const pairs of groups) {
          const result = await client.score({
            modelPath: directory,
            instruction,
            pairs,
            batchSize: rankPairsLimits.helperBatchSize
          });
          scored.push(result.logOdds);
        }
        return scored;
      } finally {
        await client.shutdown();
      }
    },
    dispose: () => host.dispose()
  };
}

async function openGguf(): Promise<RuntimeProof> {
  const pins = await pinnedModel("qwen3-reranker-0.6b-q8_0-gguf");
  const file = pins.files.find((candidate) => candidate.path.endsWith(".gguf"))!;
  const path = join(modelsDir, pins.name, file.path);
  const artifact = await validateGgufRankerArtifact({
    path,
    sizeBytes: file.size,
    sha256: file.sha256
  });
  const adapter = new NodeLlamaRankerAdapter({
    modelId: file.path,
    modelPath: path,
    capabilities,
    revision: pins.revision
  });
  return {
    runtime: "gguf",
    adapter,
    helperBatch: undefined,
    modelIdentity: { repository: pins.repository, revision: pins.revision, ...artifact },
    async spike(groups, instruction) {
      const runtime = await loadGgufModel(path);
      try {
        const context = await createQwen3RankingContext(runtime.model, instruction);
        const scored: number[][] = [];
        for (const pairs of groups) {
          const logOdds: number[] = [];
          for (const pair of pairs) {
            logOdds.push(probabilityLogOdds(await context.rank(pair.query, pair.document)));
          }
          scored.push(logOdds);
        }
        await context.dispose();
        return scored;
      } finally {
        await runtime.dispose();
      }
    },
    dispose: () => adapter.dispose()
  };
}

async function prove(proof: RuntimeProof): Promise<void> {
  const { runtime, adapter } = proof;
  const perCall = rankPairsLimits.perCall[runtime];
  const reference = rankerParityReference();
  const instruction = reference.instruction;
  const { pairs, storedIndex } = await samplePairs();
  const groups = chunks(pairs, perCall);
  const batch = proof.helperBatch === undefined ? {} : { batchSize: proof.helperBatch };

  // The product path: the calls AiService.rankPairs makes, warm-up first.
  const warmup = performance.now();
  await rankPairsWithAdapter(adapter, { instruction, pairs: groups[0]! }, batch);
  const firstCallMs = performance.now() - warmup;
  const product: number[][] = [];
  const callMs: number[] = [];
  for (const group of groups) {
    const started = performance.now();
    const result = await rankPairsWithAdapter(adapter, { instruction, pairs: group }, batch);
    callMs.push(performance.now() - started);
    product.push(result.logOdds);
  }
  const full = groups.filter((group) => group.length === perCall).length;
  const fullMs = callMs.filter((_, index) => groups[index]!.length === perCall);
  console.info(
    `${runtime}: ${pairs.length} pairs in ${groups.length} calls of ${perCall}; first (loading) call ` +
      `${firstCallMs.toFixed(0)} ms; full call p50 ${percentile(fullMs, 0.5).toFixed(1)} ms, p95 ` +
      `${percentile(fullMs, 0.95).toFixed(1)} ms (${(percentile(fullMs, 0.5) / perCall).toFixed(1)} ms per pair)`
  );

  // The parity reference in its fixed plan, three times: a build is deterministic.
  const referenceRuns: number[][] = [];
  for (let run = 0; run < 3; run++) {
    referenceRuns.push(
      await scoreRankerParityReference(runtime, async (request, plan) =>
        rankPairsWithAdapter(adapter, request, {
          ...(plan.helperBatchSize ? { batchSize: plan.helperBatchSize } : {})
        })
      )
    );
  }
  const repeatability = Math.max(
    compareRankerParity(referenceRuns[0]!, referenceRuns[1]!).maxDelta,
    compareRankerParity(referenceRuns[0]!, referenceRuns[2]!).maxDelta
  );
  console.info(`${runtime}: reference scored 3 times, largest repeat difference ${repeatability}`);
  expect(repeatability === 0, `${runtime}: the reference scores differ between identical runs`);

  // The scale of bf16 batch noise: the same reference with a helper batch of 1 (MLX only).
  let batchOneDistance: { maxDelta: number; meanDelta: number } | null = null;
  if (runtime === "mlx") {
    const plan = rankerParityPlan("mlx");
    const batchOne = await scoreRankerParityReference("mlx", (request) =>
      rankPairsWithAdapter(adapter, request, { batchSize: 1 })
    );
    const distance = compareRankerParity(referenceRuns[0]!, batchOne);
    batchOneDistance = { maxDelta: round(distance.maxDelta), meanDelta: round(distance.meanDelta) };
    console.info(
      `mlx: reference at helper batch 1 versus ${plan.helperBatchSize}: max |delta| ` +
        `${distance.maxDelta.toFixed(4)}, mean ${distance.meanDelta.toFixed(4)} (tolerance 0.125)`
    );
  }

  const runtimeBuild = await adapter.runtimeBuild();
  await proof.dispose();

  // The spike scorer on the same calls, on its own instance, after the product runtime is gone.
  const spike = await proof.spike(groups, instruction);
  const deltas = product.flatMap((scores, call) =>
    scores.map((score, index) => Math.abs(score - spike[call]![index]!))
  );
  const maxDelta = Math.max(...deltas);
  const flat = product.flat();
  const stored = await storedSpikeScores(runtime, storedIndex);
  const storedDelta = stored ? compareRankerParity(stored, flat) : null;
  console.info(
    `${runtime}: product versus the spike scorer on ${deltas.length} pairs at equal calls` +
      `${proof.helperBatch ? ` and batch ${proof.helperBatch}` : ""}: max |delta| ${maxDelta}, ` +
      `mean ${(deltas.reduce((total, value) => total + value, 0) / deltas.length).toExponential(2)}, ` +
      `${deltas.filter((value) => value > parityBar).length} above ${parityBar}`
  );
  if (storedDelta) {
    console.info(
      `${runtime}: versus the stored Spike A run (one request of 7,240 pairs, other batch makeup): ` +
        `max |delta| ${storedDelta.maxDelta.toFixed(4)}, mean ${storedDelta.meanDelta.toFixed(4)}`
    );
  }
  expect(
    maxDelta <= parityBar,
    `${runtime}: parity with the spike scorer ${maxDelta} > ${parityBar}`
  );

  if (baselineDir) {
    await mkdir(resolve(baselineDir), { recursive: true });
    const file = join(resolve(baselineDir), `ranker-parity-baseline-${runtime}.json`);
    await writeFile(
      file,
      `${JSON.stringify(
        {
          format: "memora-ranker-parity-baseline",
          version: 1,
          writtenAt: new Date().toISOString(),
          referenceHash: rankerParityReferenceHash(),
          plan: rankerParityPlan(runtime),
          runtime,
          runtimeBuild,
          model: proof.modelIdentity,
          scores: referenceRuns[0]
        },
        null,
        1
      )}\n`
    );
    console.info(`${runtime}: baseline scores written to ${file}`);
  }

  report[runtime] = {
    runtimeBuild,
    model: proof.modelIdentity,
    pairs: pairs.length,
    callsOf: perCall,
    helperBatch: proof.helperBatch ?? null,
    firstCallMs: round(firstCallMs, 0),
    fullCalls: full,
    callMs: {
      p50: round(percentile(fullMs, 0.5), 1),
      p95: round(percentile(fullMs, 0.95), 1),
      perPairP50: round(percentile(fullMs, 0.5) / perCall, 2)
    },
    productVersusSpike: {
      pairs: deltas.length,
      maxAbsDelta: maxDelta,
      pairsAbove1e3: deltas.filter((value) => value > parityBar).length
    },
    versusStoredSpikeRun: storedDelta
      ? {
          maxAbsDelta: round(storedDelta.maxDelta, 4),
          meanAbsDelta: round(storedDelta.meanDelta, 4)
        }
      : null,
    referenceRepeatabilityMaxDelta: repeatability,
    referenceAtHelperBatch1: batchOneDistance,
    referenceHash: rankerParityReferenceHash(),
    referenceScoreRange: [
      round(Math.min(...referenceRuns[0]!)),
      round(Math.max(...referenceRuns[0]!))
    ]
  };
}

/** The stored Spike A scores (one request of all 7,240 pairs) of the sampled pairs, if present. */
async function storedSpikeScores(
  runtime: "mlx" | "gguf",
  storedIndex: readonly number[]
): Promise<number[] | null> {
  const file = join(
    datasetPath,
    "..",
    "scores",
    runtime === "mlx" ? "mlx__mechanism__all__b16.json" : "gguf-qwen3__mechanism__all__b16.json"
  );
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as { logOdds: number[] };
    return storedIndex.map((index) => stored.logOdds[index]!);
  } catch {
    return null;
  }
}

if (cassetteDir) await cassetteKeys(cassetteDir);

if (runtimeOption) {
  const open = { mlx: [openMlx], gguf: [openGguf], both: [openMlx, openGguf] }[runtimeOption];
  if (!open) throw new Error("--runtime must be mlx, gguf or both");
  for (const opener of open) {
    console.info(`\n== ${opener === openMlx ? "MLX" : "GGUF"} Qwen3-Reranker`);
    await prove(await opener());
  }
}

report.failures = failures;
report.finishedAt = new Date().toISOString();
if (reportPath) await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.info("\nproof passed");
