/**
 * Real-model proof of the dedicated ranker adapters (F2 T06), through the same validators,
 * adapters and smoke test the app uses. Local inference runs one model at a time: MLX first, then
 * GGUF, each disposed before the next, and only once no other local-model job is running.
 *
 *   npx tsx scripts/smoke-local-rankers.ts [--models-dir <dir>] [--helper-path <file>]
 *     [--embedding-gguf <file>] [--runtime mlx|gguf|both] [--report <file>]
 *
 * `--models-dir` holds the F0 spike artifacts (`scripts/spikes/models.json` pins), default
 * `.cache/models`. `--embedding-gguf` names a Qwen3-Embedding GGUF the GGUF validator must refuse.
 * For each runtime the proof validates the artifact against its pins, runs the model card smoke
 * and the en/pt-BR relevance pairs, times single-pair and 20-document calls, and checks that an
 * over-long document is truncated and reported instead of failing.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { AiCapability } from "@app/domain";

import {
  MlxRerankerAdapter,
  NodeLlamaRankerAdapter,
  rankWithAdapter
} from "../packages/ai/src/local-ranker-adapters.js";
import { qwen3RerankerPrompt, type RankRequest } from "../packages/ai/src/ranker-input.js";
import {
  rankerSmokeCases,
  runRankerSmoke,
  validateGgufRankerArtifact,
  validateMlxRankerArtifact,
  type RankerSmokeReport
} from "../packages/ai/src/ranker-validation.js";
import type { AiModelAdapter } from "../packages/ai/src/contracts.js";
import { MlxHelperHost } from "../packages/ai/src/mlx-helper-host.js";
import { waitForLocalModelSlot } from "./spikes/topic-tree/local-model-slot.js";

const root = resolve(import.meta.dirname, "..");
const modelsDir = resolve(optionValue("--models-dir") ?? join(root, ".cache", "models"));
const helperPath = resolve(
  optionValue("--helper-path") ??
    join(root, "native", "mlx-helper", ".build", "release", "memora-mlx-helper")
);
const embeddingGguf = optionValue("--embedding-gguf");
const runtimeOption = optionValue("--runtime") ?? "both";
const reportPath = optionValue("--report");
const capabilities: AiCapability[] = ["reranking", "offline", "local-files"];
/** Spike A's per-pair p50 bounds (`docs/spikes/spike-a-reranker.md`, GO rule). */
const p50BoundMs = { mlx: 75, gguf: 150 } as const;

interface PinnedModel {
  name: string;
  repository: string;
  revision: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

const failures: string[] = [];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), modelsDir };

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

async function pinnedModel(name: string): Promise<PinnedModel> {
  const manifest = JSON.parse(
    await readFile(join(root, "scripts", "spikes", "models.json"), "utf8")
  ) as { models: PinnedModel[] };
  const model = manifest.models.find((candidate) => candidate.name === name);
  if (!model) throw new Error(`models.json has no ${name}`);
  return model;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Note-like texts of about the gate's size: a title, an idea and a 400-character excerpt. */
function noteText(index: number): string {
  const paragraphs = rankerSmokeCases.relevance.flatMap((entry) => [
    entry.relevant,
    entry.irrelevant
  ]);
  const body = paragraphs
    .map((_, offset) => paragraphs[(index + offset) % paragraphs.length])
    .join(" ")
    .slice(0, 400);
  return `Title: Note ${index + 1}\nIdea: ${paragraphs[index % paragraphs.length]!.slice(0, 160)}\nText: ${body}`;
}

async function timedRank(adapter: AiModelAdapter, request: RankRequest) {
  const started = performance.now();
  const result = await rankWithAdapter(adapter, request);
  return { result, ms: performance.now() - started };
}

async function prove(
  runtime: "mlx" | "gguf",
  adapter: AiModelAdapter & { runtimeBuild(): Promise<string> }
) {
  const instruction = qwen3RerankerPrompt.defaultInstruction;
  const load = await timedRank(adapter, {
    instruction,
    query: noteText(0),
    documents: [noteText(1)]
  });

  const smokeStarted = performance.now();
  const smoke: RankerSmokeReport = await runRankerSmoke((request) =>
    rankWithAdapter(adapter, request)
  );
  const smokeMs = performance.now() - smokeStarted;
  console.info(
    `${runtime}: model card ${smoke.modelCard.logOdds.map((value) => value.toFixed(3)).join(", ")} ` +
      `(card ${smoke.modelCard.expected.join(", ")}, max |delta| ${smoke.modelCard.maxDelta.toFixed(3)}); ` +
      smoke.relevance
        .map((entry) => `${entry.language} margin ${entry.margin.toFixed(3)}`)
        .join(", ")
  );
  expect(smoke.passed, `${runtime}: smoke failed: ${smoke.failures.join("; ")}`);

  for (let warm = 0; warm < 3; warm++) {
    await timedRank(adapter, {
      instruction,
      query: noteText(warm),
      documents: [noteText(warm + 1)]
    });
  }
  const single: number[] = [];
  for (let index = 0; index < 30; index++) {
    single.push(
      (
        await timedRank(adapter, {
          instruction,
          query: noteText(index),
          documents: [noteText(index + 7)]
        })
      ).ms
    );
  }
  const batched: number[] = [];
  let tokensPerPair = 0;
  for (let index = 0; index < 5; index++) {
    const documents = Array.from({ length: 20 }, (_, offset) => noteText(index + offset + 1));
    const call = await timedRank(adapter, { instruction, query: noteText(index), documents });
    batched.push(call.ms / documents.length);
    tokensPerPair =
      call.result.tokenCounts.reduce((total, count) => total + count, 0) / documents.length;
  }
  const singleP50 = percentile(single, 0.5);
  console.info(
    `${runtime}: single pair p50 ${singleP50.toFixed(1)} ms, p95 ${percentile(single, 0.95).toFixed(1)} ms; ` +
      `20-document call ${percentile(batched, 0.5).toFixed(1)} ms per pair (p50); ` +
      `${tokensPerPair.toFixed(0)} tokens per pair`
  );
  expect(
    singleP50 <= p50BoundMs[runtime],
    `${runtime}: p50 ${singleP50} ms > ${p50BoundMs[runtime]} ms`
  );

  const long = await timedRank(adapter, {
    instruction,
    query: noteText(0),
    documents: [
      noteText(1),
      Array.from({ length: 40 }, (_, index) => noteText(index))
        .join("\n")
        .slice(0, 15_000)
    ]
  });
  console.info(
    `${runtime}: long document ${long.result.tokenCounts[1]} tokens, truncated ${String(long.result.truncated[1])}`
  );
  expect(
    long.result.truncated[1] === true && long.result.truncated[0] === false,
    `${runtime}: truncation not reported`
  );
  expect(
    long.result.tokenCounts[1]! <= 2_048,
    `${runtime}: truncated sequence exceeds 2048 tokens`
  );

  return {
    runtimeBuild: await adapter.runtimeBuild(),
    firstCallMs: round(load.ms),
    smoke,
    smokeMs: round(smokeMs),
    singlePairMs: {
      p50: round(singleP50),
      p95: round(percentile(single, 0.95)),
      samples: single.length
    },
    batchedPerPairMs: {
      p50: round(percentile(batched, 0.5)),
      documents: 20,
      calls: batched.length
    },
    tokensPerPair: round(tokensPerPair, 0),
    truncation: { tokenCounts: long.result.tokenCounts, truncated: long.result.truncated }
  };
}

async function mlxSection(): Promise<void> {
  console.info("\n== MLX Qwen3-Reranker");
  const pins = await pinnedModel("qwen3-reranker-0.6b-mlx");
  const directory = join(modelsDir, pins.name);
  const validationStarted = performance.now();
  const artifact = await validateMlxRankerArtifact({
    directory,
    files: pins.files.map((file) => ({
      path: file.path,
      sizeBytes: file.size,
      sha256: file.sha256
    }))
  });
  const validationMs = performance.now() - validationStarted;
  console.info(
    `mlx: artifact ${artifact.artifactSha256} validated in ${validationMs.toFixed(0)} ms`
  );
  // One helper process serves both adapters (D18), and the smoke checks it stays one.
  const host = new MlxHelperHost({ helperPath });
  const adapter = new MlxRerankerAdapter({
    modelId: pins.repository,
    modelPath: directory,
    helperPath,
    host,
    capabilities,
    revision: pins.revision
  });
  try {
    report.mlx = { artifact, validationMs: round(validationMs), ...(await prove("mlx", adapter)) };
    // A Qwen3 checkpoint that is not a reranker passes the architecture check; the smoke refuses it.
    const embedding = new MlxRerankerAdapter({
      modelId: "Qwen/Qwen3-Embedding-0.6B",
      modelPath: join(modelsDir, "qwen3-embedding-0.6b-mlx"),
      helperPath,
      host,
      capabilities
    });
    const negative = await runRankerSmoke((request) => rankWithAdapter(embedding, request)).then(
      (smoke) => ({ passed: smoke.passed, modelCard: smoke.modelCard, failures: smoke.failures }),
      (error: unknown) => ({
        error: (error as Error).message,
        detail: (error as { detail?: string }).detail
      })
    );
    console.info(`mlx: Qwen3-Embedding as a ranker -> ${JSON.stringify(negative)}`);
    expect("error" in negative || !negative.passed, "mlx: the embedding model passed the smoke");
    expect(host.spawnCount === 1, `mlx: ${host.spawnCount} helper processes were started`);
    Object.assign(report.mlx as object, {
      embeddingAsRanker: negative,
      helperSpawns: host.spawnCount
    });
  } finally {
    await host.dispose();
  }
}

async function ggufSection(): Promise<void> {
  console.info("\n== GGUF Qwen3-Reranker Q8_0");
  const pins = await pinnedModel("qwen3-reranker-0.6b-q8_0-gguf");
  const file = pins.files.find((candidate) => candidate.path.endsWith(".gguf"))!;
  const path = join(modelsDir, pins.name, file.path);
  const validationStarted = performance.now();
  const artifact = await validateGgufRankerArtifact({
    path,
    sizeBytes: file.size,
    sha256: file.sha256
  });
  const validationMs = performance.now() - validationStarted;
  console.info(
    `gguf: artifact ${artifact.artifactSha256} validated in ${validationMs.toFixed(0)} ms`
  );

  const refusals: Record<string, string> = {};
  for (const [name, candidate] of [
    ["qwen3-embedding", embeddingGguf],
    [
      "bge-reranker-v2-m3",
      join(modelsDir, "bge-reranker-v2-m3-q8_0-gguf", "bge-reranker-v2-m3-Q8_0.gguf")
    ]
  ] as const) {
    if (!candidate) continue;
    const outcome = await validateGgufRankerArtifact({ path: candidate }).then(
      () => "accepted",
      (error: unknown) =>
        `${(error as Error).message} (${String((error as { detail?: string }).detail ?? "")})`
    );
    refusals[name] = outcome;
    console.info(`gguf: ${name} -> ${outcome}`);
    expect(outcome.startsWith("errors.localModels.rankerInvalid"), `gguf: ${name} was not refused`);
  }

  const adapter = new NodeLlamaRankerAdapter({
    modelId: file.path,
    modelPath: path,
    capabilities,
    revision: pins.revision
  });
  try {
    report.gguf = {
      artifact,
      validationMs: round(validationMs),
      refusals,
      ...(await prove("gguf", adapter))
    };
  } finally {
    await adapter.dispose();
  }
}

await waitForLocalModelSlot(10_000);
try {
  if (runtimeOption === "mlx" || runtimeOption === "both") await mlxSection();
  if (runtimeOption === "gguf" || runtimeOption === "both") await ggufSection();
} catch (error) {
  failures.push(
    error instanceof Error
      ? `${error.message} ${String((error as { detail?: string }).detail ?? "")}`
      : String(error)
  );
  console.error(error);
}
report.failures = failures;
report.finishedAt = new Date().toISOString();
if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.info(
  failures.length === 0 ? "\nranker proof passed" : `\nranker proof FAILED: ${failures.length}`
);
process.exitCode = failures.length === 0 ? 0 : 1;
