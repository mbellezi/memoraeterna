// Spike B embeddings (MLX-first): embeds the public corpus pseudo-notes, the
// benchmark notes and the owner's pseudo-notes with Qwen3-Embedding-0.6B on the
// MLX helper (`embed`, document mode, the app's note input), caches the vectors
// under .cache/spikes/topic-tree/vectors/ and compares MLX with the GGUF vectors
// the app stored (benchmark notes, owner chunks).
//
//   npm run mlx:build                                   (once)
//   npx tsx scripts/spikes/topic-tree/embed-real.ts [--only corpus,corpus-notitle,benchmark,owner] [--no-compare]
//
// "corpus-notitle" re-embeds the public corpus without the article-title prefix of the
// note title (Spike B review: title leakage between held-out and base notes).
//
// Re-runs reuse cached vectors whose input hash is unchanged. Writes
// .cache/spikes/topic-tree/embeddings-report.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { modelDirectory, readModelManifest } from "../download-models.js";
import { MlxHelperClient } from "../lib/mlx-helper-client.js";
import { waitForLocalModelSlot } from "./local-model-slot.js";
import {
  loadBenchmark,
  loadCorpus,
  loadOwner,
  loadOwnerChunks,
  loadStoredVectors,
  readStore,
  sha256,
  spikeDir,
  storeNames,
  writeStore
} from "./real-data.js";
import type { EmbeddableItem, StoreMeta, StoreName, StoredRow } from "./real-data.js";

const args = process.argv.slice(2);
const onlyArg = args.indexOf("--only");
const only = new Set(
  onlyArg >= 0
    ? (args[onlyArg + 1] ?? "").split(",")
    : storeNames.filter((name) => name !== "corpus-notitle")
) as Set<string>;
const compare = !args.includes("--no-compare");

/** Token budget per forward batch (keeps MLX memory bounded; decision 15). */
const batchTokenBudget = 4096;
const maxBatchSize = 16;
const textsPerRequest = 64;

const manifest = await readModelManifest();
const model = manifest.find((candidate) => candidate.name === "qwen3-embedding-0.6b-mlx");
if (!model) throw new Error("models.json has no qwen3-embedding-0.6b-mlx");
const modelPath = modelDirectory(model);
const weights = model.files.find((file) => file.path === "model.safetensors");
const modelInfo = {
  name: model.name,
  repository: model.repository,
  revision: model.revision,
  sha256: weights?.sha256 ?? "unknown"
};

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));
/** Conservative token estimate (pt/en prose is ~3.5-4.5 characters per token). */
const estimateTokens = (text: string): number => Math.ceil(text.length / 2.5) + 16;

interface EmbedOutcome {
  vector: Float32Array;
  tokens: number;
  truncated: boolean;
}

interface Throughput {
  texts: number;
  tokens: number;
  requests: number;
  wallMs: number;
  inferenceMs: number;
  textsPerSecond: number;
  tokensPerSecond: number;
  meanTokens: number;
  maxTokens: number;
  truncated: number;
  loadMs: number;
}

async function embedAll(
  client: MlxHelperClient,
  inputs: readonly string[],
  label: string
): Promise<{ outcomes: EmbedOutcome[]; throughput: Throughput }> {
  const order = inputs
    .map((input, index) => ({ input, index }))
    .sort((a, b) => b.input.length - a.input.length || a.index - b.index);
  const outcomes = new Array<EmbedOutcome>(inputs.length);
  const throughput: Throughput = {
    texts: 0,
    tokens: 0,
    requests: 0,
    wallMs: 0,
    inferenceMs: 0,
    textsPerSecond: 0,
    tokensPerSecond: 0,
    meanTokens: 0,
    maxTokens: 0,
    truncated: 0,
    loadMs: 0
  };
  let nextLog = 1000;
  for (let start = 0; start < order.length; start += textsPerRequest) {
    const group = order.slice(start, start + textsPerRequest);
    const longest = Math.max(...group.map((entry) => estimateTokens(entry.input)));
    const batchSize = Math.max(1, Math.min(maxBatchSize, Math.floor(batchTokenBudget / longest)));
    const started = performance.now();
    const result = await client.embed(
      { modelPath, texts: group.map((entry) => entry.input), normalize: true, batchSize },
      10 * 60_000
    );
    throughput.wallMs += performance.now() - started;
    throughput.inferenceMs += result.timing.inferenceMs;
    throughput.loadMs += result.timing.loadMs;
    throughput.requests += 1;
    if (result.embeddings.length !== group.length) {
      throw new Error(`${label}: ${result.embeddings.length} vectors for ${group.length} texts`);
    }
    group.forEach((entry, position) => {
      const tokens = result.tokenCounts[position] ?? 0;
      const truncated = result.truncated[position] ?? false;
      outcomes[entry.index] = {
        vector: Float32Array.from(result.embeddings[position] ?? []),
        tokens,
        truncated
      };
      throughput.texts += 1;
      throughput.tokens += tokens;
      throughput.maxTokens = Math.max(throughput.maxTokens, tokens);
      if (truncated) throughput.truncated += 1;
    });
    if (throughput.texts >= nextLog || start + textsPerRequest >= order.length) {
      console.log(
        `  ${label}: ${throughput.texts}/${order.length} texts, ` +
          `${round(throughput.texts / (throughput.wallMs / 1000), 1)} texts/s`
      );
      nextLog += 1000;
    }
  }
  const seconds = throughput.wallMs / 1000;
  throughput.textsPerSecond = seconds > 0 ? round(throughput.texts / seconds, 1) : 0;
  throughput.tokensPerSecond = seconds > 0 ? round(throughput.tokens / seconds, 0) : 0;
  throughput.meanTokens = throughput.texts > 0 ? round(throughput.tokens / throughput.texts, 1) : 0;
  throughput.wallMs = Math.round(throughput.wallMs);
  throughput.inferenceMs = Math.round(throughput.inferenceMs);
  throughput.loadMs = Math.round(throughput.loadMs);
  return { outcomes, throughput };
}

async function loadDataset(name: StoreName): Promise<EmbeddableItem[]> {
  switch (name) {
    case "corpus":
      return loadCorpus();
    case "corpus-notitle":
      return loadCorpus({ stripArticleTitle: true });
    case "benchmark":
      return loadBenchmark();
    case "owner":
      return loadOwner();
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < a.length; k += 1) {
    dot += (a[k] as number) * (b[k] as number);
    na += (a[k] as number) ** 2;
    nb += (b[k] as number) ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    mean: round(sorted.reduce((total, value) => total + value, 0) / Math.max(1, sorted.length), 5),
    min: round(sorted[0] ?? 0, 5),
    p05: round(at(0.05), 5),
    p50: round(at(0.5), 5)
  };
}

/** Top-k nearest-neighbour overlap between two embeddings of the same items. */
function neighbourOverlap(a: Float32Array[], b: Float32Array[], k: number): number {
  const top = (vectors: Float32Array[], i: number): Set<number> =>
    new Set(
      vectors
        .map((vector, j) => ({
          j,
          sim: j === i ? -Infinity : cosine(vectors[i] as Float32Array, vector)
        }))
        .sort((x, y) => y.sim - x.sim)
        .slice(0, k)
        .map((entry) => entry.j)
    );
  let shared = 0;
  for (let i = 0; i < a.length; i += 1) {
    const left = top(a, i);
    for (const j of top(b, i)) if (left.has(j)) shared += 1;
  }
  return a.length > 0 ? round(shared / (a.length * k), 4) : 0;
}

const reportPath = join(spikeDir, "embeddings-report.json");
/** Datasets and comparisons from earlier runs are kept unless re-run. */
const previous = await readFile(reportPath, "utf8")
  .then((text) => JSON.parse(text) as Record<string, unknown>)
  .catch(() => ({}) as Record<string, unknown>);
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  model: { ...modelInfo, runtime: "mlx (native/mlx-helper embed)" },
  input:
    "renderPrompt('embedding.content.note', {note_title, note_idea, note_body}); documents get no instruction",
  batching: { batchTokenBudget, maxBatchSize, textsPerRequest, order: "longest first" },
  datasets: { ...(previous.datasets as Record<string, unknown> | undefined) },
  comparisons: { ...(previous.comparisons as Record<string, unknown> | undefined) }
};
const datasetReports = report.datasets as Record<string, unknown>;

await waitForLocalModelSlot();
const client = await MlxHelperClient.start();
try {
  for (const name of storeNames) {
    if (!only.has(name)) continue;
    console.log(`\n== ${name}`);
    const items = await loadDataset(name);
    const cached = await readStore(name);
    const cachedBySha = new Map<string, { row: StoredRow; vector: Float32Array }>();
    if (cached && cached.meta.model.sha256 === modelInfo.sha256) {
      cached.rows.forEach((row, index) => {
        cachedBySha.set(row.inputSha256, {
          row,
          vector: cached.matrix.data.slice(index * cached.meta.dim, (index + 1) * cached.meta.dim)
        });
      });
    }
    const hashes = items.map((entry) => sha256(entry.input));
    const missing = items
      .map((entry, index) => ({ entry, index }))
      .filter(({ index }) => !cachedBySha.has(hashes[index] as string));
    console.log(
      `  ${items.length} items, ${items.length - missing.length} cached, ${missing.length} to embed`
    );
    const { outcomes, throughput } = await embedAll(
      client,
      missing.map(({ entry }) => entry.input),
      name
    );
    const fresh = new Map(
      missing.map(({ index }, position) => [index, outcomes[position] as EmbedOutcome])
    );
    const dim = 1024;
    const vectors = new Float32Array(items.length * dim);
    const rows: StoredRow[] = items.map((entry, index) => {
      const hash = hashes[index] as string;
      const outcome = fresh.get(index);
      const hit = cachedBySha.get(hash);
      const vector = outcome?.vector ?? hit?.vector;
      if (!vector || vector.length !== dim)
        throw new Error(`${name}: no ${dim}-d vector for ${entry.item.id}`);
      vectors.set(vector, index * dim);
      return {
        ...entry.item,
        inputSha256: hash,
        tokens: outcome?.tokens ?? hit?.row.tokens ?? 1,
        truncated: outcome?.truncated ?? hit?.row.truncated ?? false
      };
    });
    const meta: StoreMeta = {
      dataset: name,
      count: rows.length,
      dim,
      model: modelInfo,
      runtime: "mlx",
      input:
        name === "corpus-notitle"
          ? "embedding.content.note (section name only as title, idea = first sentence, body = rest)"
          : "embedding.content.note (title, idea = first sentence, body = rest for pseudo-notes)",
      createdAt: new Date().toISOString()
    };
    await writeStore(name, meta, rows, vectors);
    const tokens = rows.map((row) => row.tokens);
    datasetReports[name] = {
      items: rows.length,
      cached: items.length - missing.length,
      embedded: missing.length,
      languages: {
        pt: rows.filter((row) => row.lang === "pt").length,
        en: rows.filter((row) => row.lang === "en").length
      },
      tokens: {
        total: tokens.reduce((total, value) => total + value, 0),
        mean: round(
          tokens.reduce((total, value) => total + value, 0) / Math.max(1, tokens.length),
          1
        ),
        max: Math.max(...tokens)
      },
      truncated: rows.filter((row) => row.truncated).length,
      throughput: missing.length > 0 ? throughput : null
    };
    console.log(`  stored ${rows.length} vectors; throughput ${JSON.stringify(throughput)}`);
  }

  if (compare) {
    console.log("\n== MLX vs stored GGUF vectors");
    const comparisons = report.comparisons as Record<string, unknown>;
    const benchmark = await readStore("benchmark");
    if (benchmark) {
      const stored = await loadStoredVectors("benchmark", "atomic_note");
      const mlx: Float32Array[] = [];
      const gguf: Float32Array[] = [];
      let hashMatches = 0;
      benchmark.rows.forEach((row, index) => {
        const reference = stored.get(row.id);
        if (!reference) return;
        if (reference.contentHash === row.inputSha256) hashMatches += 1;
        mlx.push(benchmark.matrix.data.slice(index * 1024, (index + 1) * 1024));
        gguf.push(reference.vector);
      });
      comparisons.benchmarkNotes = {
        pairs: mlx.length,
        storedModel: [...stored.values()][0]?.model ?? null,
        identicalInputByContentHash: hashMatches,
        cosine: summarize(mlx.map((vector, index) => cosine(vector, gguf[index] as Float32Array))),
        top5NeighbourOverlap: neighbourOverlap(mlx, gguf, 5)
      };
      console.log(`  benchmark notes: ${JSON.stringify(comparisons.benchmarkNotes)}`);
    }
    if (only.has("owner")) {
      const chunks = await loadOwnerChunks();
      const stored = await loadStoredVectors("owner", "chunk");
      const { outcomes, throughput } = await embedAll(
        client,
        chunks.map((chunk) => chunk.input),
        "owner chunks"
      );
      const pairs = chunks
        .map((chunk, index) => ({
          chunk,
          outcome: outcomes[index] as EmbedOutcome,
          reference: stored.get(chunk.id)
        }))
        .filter((pair) => pair.reference !== undefined);
      comparisons.ownerChunks = {
        pairs: pairs.length,
        identicalInputByContentHash: pairs.filter(
          (pair) => pair.reference?.contentHash === sha256(pair.chunk.input)
        ).length,
        tokens: pairs.map((pair) => pair.outcome.tokens),
        cosine: summarize(
          pairs.map((pair) => cosine(pair.outcome.vector, pair.reference?.vector as Float32Array))
        ),
        throughput
      };
      console.log(`  owner chunks: ${JSON.stringify(comparisons.ownerChunks)}`);
    }
  }
} finally {
  await client.shutdown();
}

report.finishedAt = new Date().toISOString();
await mkdir(spikeDir, { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\nReport: ${reportPath}`);
