/**
 * F0 Spike A smoke: local reranking and embeddings, MLX-first with GGUF fallbacks.
 *
 *   npx tsx scripts/spikes/download-models.ts      (once)
 *   npm run mlx:build                              (once)
 *   npx tsx scripts/spikes/smoke-local-models.ts [--only score,throughput,embeddings]
 *
 * Sections run one runtime at a time (local inference is serialized) and write
 * `.cache/spikes/smoke-local-models.json`.
 *
 *   score       model-card reference checks, then a relevant vs irrelevant pair in pt-BR and in
 *               English on MLX Qwen3-Reranker, GGUF Qwen3-Reranker and GGUF bge-reranker-v2-m3
 *   throughput  MLX `score` on ~250-token pairs at batch sizes 1, 8, 16, 32 (plus GGUF per pair)
 *   embeddings  the first 100 notes of the matching benchmark, formatted like the app's note
 *               embedding input, on MLX Qwen3-Embedding vs the installed GGUF Qwen3-Embedding
 */
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { z } from "zod";

import { renderPrompt } from "../../apps/desktop/src/main/services/prompt-runtime.js";
import {
  modelDirectory,
  readModelManifest,
  sha256File,
  type PinnedModel
} from "./download-models.js";
import {
  createDefaultRankingContext,
  createGgufEmbeddingContext,
  createQwen3RankingContext,
  embedNormalized,
  inspectGguf,
  loadGgufModel
} from "./lib/gguf.js";
import { MlxHelperClient } from "./lib/mlx-helper-client.js";
import { qwen3RerankerDefaultInstruction } from "./lib/qwen3-reranker.js";

const root = resolve(import.meta.dirname, "..", "..");
const outputPath = join(root, ".cache", "spikes", "smoke-local-models.json");
const benchmarkPath = join(root, ".cache", "matching-benchmark", "validate", "results.json");
const installedGgufEmbedding = join(
  homedir(),
  "Library",
  "Application Support",
  "@app",
  "desktop",
  "local-models",
  "gguf-qwen3-embedding-0.6b-q8-0",
  "Qwen3-Embedding-0.6B-Q8_0.gguf"
);

const sections = new Set(
  optionValue("--only")?.split(",") ?? ["score", "throughput", "embeddings"]
);
const report: Record<string, unknown> = { startedAt: new Date().toISOString() };
const failures: string[] = [];

// --- Inputs -------------------------------------------------------------------------------------

/** Qwen3-Reranker model card (sentence-transformers example): raw logit differences. */
const rerankerCard = {
  query: "What is the capital of China?",
  documents: [
    "The capital of China is Beijing.",
    "Gravity is a force that attracts two bodies towards each other. It gives weight to physical objects and is responsible for the movement of planets around the sun."
  ],
  expectedLogOdds: [7.625, -11.375]
};

/** Qwen3-Embedding model card (Transformers example): query x document cosine similarity. */
const embeddingCard = {
  queries: ["What is the capital of China?", "Explain gravity"].map(
    (query) => `Instruct: ${qwen3RerankerDefaultInstruction}\nQuery:${query}`
  ),
  documents: rerankerCard.documents,
  expected: [
    [0.7645568251609802, 0.14142508804798126],
    [0.13549736142158508, 0.5999549627304077]
  ]
};

const sanityCases = [
  {
    language: "en",
    query: "How do vaccines train the immune system?",
    relevant:
      "Vaccines expose the immune system to a harmless antigen, such as an inactivated virus or a piece of its protein. B cells respond by producing antibodies and memory cells, so a later infection by the real pathogen is recognized and neutralized quickly.",
    irrelevant:
      "The Eiffel Tower was built for the 1889 World's Fair in Paris. Its wrought-iron lattice was assembled from about 18,000 parts, and it remained the tallest man-made structure in the world until 1930."
  },
  {
    language: "pt-BR",
    query: "Como a fotossíntese transforma luz em energia para as plantas?",
    relevant:
      "Na fotossíntese, os cloroplastos captam a luz solar com a clorofila e usam essa energia para converter água e dióxido de carbono em glicose e oxigênio. A glicose produzida abastece o crescimento e a respiração da planta.",
    irrelevant:
      "O Campeonato Brasileiro de futebol é disputado por vinte clubes em turno e returno. O time com mais pontos ao fim das 38 rodadas é declarado campeão, e os quatro últimos são rebaixados para a Série B."
  }
];

const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  idea_statement: z.string(),
  body_markdown: z.string()
});
type BenchmarkNote = z.infer<typeof noteSchema>;

/**
 * Mirrors `withEmbeddingInputInstruction` in apps/desktop/src/main/services/ai-service.ts: only
 * Qwen3-Embedding *queries* get `embedding.query_instruction`; note embeddings are documents.
 */
function appEmbeddingInput(note: BenchmarkNote): string {
  return renderPrompt("embedding.content.note", {
    note_title: note.title,
    note_idea: note.idea_statement,
    note_body: note.body_markdown
  });
}

// --- Main ---------------------------------------------------------------------------------------

const manifest = await readModelManifest();
const mlxReranker = artifact(manifest, "qwen3-reranker-0.6b-mlx");
const mlxEmbedder = artifact(manifest, "qwen3-embedding-0.6b-mlx");
const ggufReranker = artifact(manifest, "qwen3-reranker-0.6b-q8_0-gguf");
const ggufBge = artifact(manifest, "bge-reranker-v2-m3-q8_0-gguf");
const notes = z
  .object({ notes: z.array(noteSchema) })
  .parse(JSON.parse(await readFile(benchmarkPath, "utf8"))).notes;

if (sections.has("score")) await scoreSection();
if (sections.has("throughput")) await throughputSection();
if (sections.has("embeddings")) await embeddingSection();

report.finishedAt = new Date().toISOString();
report.failures = failures;
await mkdir(join(root, ".cache", "spikes"), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.info(`\nReport: ${outputPath}`);
if (failures.length) {
  console.error(`FAILED:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.info("All smoke checks passed.");
}

// --- (a) score sanity ---------------------------------------------------------------------------

async function scoreSection(): Promise<void> {
  console.info("\n== (a) relevance smoke");
  const results: Array<Record<string, unknown>> = [];

  const mlx = await MlxHelperClient.start();
  try {
    const card = await mlx.score({
      modelPath: mlxReranker.path,
      query: rerankerCard.query,
      documents: rerankerCard.documents,
      batchSize: 1
    });
    const cardDelta = Math.max(
      ...card.logOdds.map((value, index) => Math.abs(value - rerankerCard.expectedLogOdds[index]!))
    );
    console.info(
      `MLX reranker model-card check: logOdds ${card.logOdds.map(fixed(3)).join(", ")} ` +
        `(card ${rerankerCard.expectedLogOdds.join(", ")}), max |delta| ${fixed(3)(cardDelta)}`
    );
    // The card prints bf16 GPU values. A float32 MLX probe gives 7.597 / -12.192 and llama.cpp
    // Q8_0 gives 7.27 / -12.0, so the strongly negative logit legitimately differs by ~0.9.
    expect(cardDelta <= 1, `MLX reranker deviates from the model card by ${cardDelta}`);
    report.rerankerCardCheck = {
      logOdds: card.logOdds,
      expected: rerankerCard.expectedLogOdds,
      maxAbsDelta: cardDelta,
      yesTokenId: card.yesTokenId,
      noTokenId: card.noTokenId,
      timing: card.timing
    };

    const embedCard = await mlx.embed({
      modelPath: mlxEmbedder.path,
      texts: [...embeddingCard.queries, ...embeddingCard.documents]
    });
    const [q1, q2, d1, d2] = embedCard.embeddings as [number[], number[], number[], number[]];
    const similarity = [
      [dot(q1, d1), dot(q1, d2)],
      [dot(q2, d1), dot(q2, d2)]
    ];
    const embedDelta = Math.max(
      ...similarity.flatMap((row, i) =>
        row.map((value, j) => Math.abs(value - embeddingCard.expected[i]![j]!))
      )
    );
    console.info(
      `MLX embedding model-card check: ${JSON.stringify(similarity.map((row) => row.map(fixed(4))))} ` +
        `max |delta| ${fixed(4)(embedDelta)} (tokens ${embedCard.tokenCounts.join(",")})`
    );
    expect(embedDelta <= 0.01, `MLX embeddings deviate from the model card by ${embedDelta}`);
    report.embeddingCardCheck = {
      similarity,
      expected: embeddingCard.expected,
      maxAbsDelta: embedDelta,
      tokenCounts: embedCard.tokenCounts
    };

    for (const testCase of sanityCases) {
      const result = await mlx.score({
        modelPath: mlxReranker.path,
        query: testCase.query,
        documents: [testCase.relevant, testCase.irrelevant]
      });
      results.push(sanityRow("mlx-qwen3-reranker-0.6b", testCase.language, result.scores));
    }
  } finally {
    await mlx.shutdown();
  }

  for (const [runtime, model, make] of [
    ["gguf-qwen3-reranker-0.6b-q8_0", ggufReranker, "qwen3"],
    ["gguf-bge-reranker-v2-m3-q8_0", ggufBge, "default"]
  ] as const) {
    const gguf = await loadGgufModel(model.path);
    try {
      const header = inspectGguf(gguf.model);
      console.info(`${runtime} header: ${JSON.stringify(header)}`);
      expect(header.supportsRanking, `${runtime} has no classification head`);
      const headers = (report.ggufHeaders ??= {}) as Record<string, unknown>;
      headers[runtime] = header;
      const context =
        make === "qwen3"
          ? await createQwen3RankingContext(gguf.model)
          : await createDefaultRankingContext(gguf.model);
      try {
        for (const testCase of sanityCases) {
          const scores = await context.rankAll(testCase.query, [
            testCase.relevant,
            testCase.irrelevant
          ]);
          results.push(sanityRow(runtime, testCase.language, scores));
        }
        if (make === "qwen3") {
          const card = await context.rankAll(rerankerCard.query, rerankerCard.documents);
          const logOdds = card.map((p) => Math.log(p / (1 - p)));
          console.info(
            `${runtime} model-card check: logOdds ${logOdds.map(fixed(3)).join(", ")} ` +
              `(card ${rerankerCard.expectedLogOdds.join(", ")})`
          );
          report.ggufRerankerCardCheck = { scores: card, logOdds };
        }
      } finally {
        await context.dispose();
      }
    } finally {
      await gguf.dispose();
    }
  }
  report.relevanceSmoke = results;
}

function sanityRow(runtime: string, language: string, scores: readonly number[]) {
  const [relevant, irrelevant] = scores as [number, number];
  const margin = relevant - irrelevant;
  const passed = relevant > irrelevant && margin >= 0.5;
  console.info(
    `${runtime.padEnd(32)} ${language.padEnd(6)} relevant ${fixed(4)(relevant)}  ` +
      `irrelevant ${fixed(4)(irrelevant)}  ${passed ? "ok" : "FAIL"}`
  );
  expect(passed, `${runtime} ${language}: relevant ${relevant} vs irrelevant ${irrelevant}`);
  return { runtime, language, relevant, irrelevant, margin, passed };
}

// --- (b) MLX score throughput -------------------------------------------------------------------

async function throughputSection(): Promise<void> {
  console.info("\n== (b) MLX score throughput (~250-token pairs)");
  const pairCount = 96;
  const mlx = await MlxHelperClient.start();
  let pairs: Array<{ query: string; document: string }>;
  const runs: Array<Record<string, unknown>> = [];
  let reference: { logOdds: number[]; scores: number[] } | undefined;
  try {
    // Calibrate the document length to ~250 tokens per full pair; this also warms up the kernels.
    let targetChars = 640;
    pairs = buildPairs(pairCount, targetChars);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const probe = await mlx.score({ modelPath: mlxReranker.path, pairs, batchSize: 16 });
      const meanTokens = mean(probe.tokenCounts);
      if (Math.abs(meanTokens - 250) <= 10) break;
      targetChars = Math.round(targetChars * (1 + (250 - meanTokens) / (meanTokens - 60)));
      pairs = buildPairs(pairCount, targetChars);
    }
    for (const batchSize of [1, 8, 16, 32]) {
      const started = performance.now();
      const result = await mlx.score({ modelPath: mlxReranker.path, pairs, batchSize });
      const wallMs = performance.now() - started;
      const inferenceMs = result.timing.inferenceMs;
      const batchMs = result.timing.batches.map((batch) => batch.ms);
      reference ??= { logOdds: result.logOdds, scores: result.scores };
      const baseline = reference;
      const maxLogOddsDelta = Math.max(
        ...result.logOdds.map((value, index) => Math.abs(value - baseline.logOdds[index]!))
      );
      const maxScoreDelta = Math.max(
        ...result.scores.map((value, index) => Math.abs(value - baseline.scores[index]!))
      );
      const row = {
        batchSize,
        pairs: pairCount,
        meanTokensPerPair: mean(result.tokenCounts),
        minTokens: Math.min(...result.tokenCounts),
        maxTokens: Math.max(...result.tokenCounts),
        pairsPerSecond: (pairCount * 1000) / inferenceMs,
        msPerPair: inferenceMs / pairCount,
        wallMsPerPair: wallMs / pairCount,
        batchMsP50: percentile(batchMs, 0.5),
        batchMsMax: Math.max(...batchMs),
        maxLogOddsDeltaVsBatch1: maxLogOddsDelta,
        maxScoreDeltaVsBatch1: maxScoreDelta
      };
      runs.push(row);
      console.info(
        `batch ${String(batchSize).padStart(2)}: ${fixed(1)(row.pairsPerSecond)} pairs/s, ` +
          `${fixed(2)(row.msPerPair)} ms/pair (wall ${fixed(2)(row.wallMsPerPair)}), ` +
          `tokens/pair ${fixed(1)(row.meanTokensPerPair)}, vs bs1 max |dLogOdds| ` +
          `${fixed(3)(maxLogOddsDelta)} max |dScore| ${fixed(4)(maxScoreDelta)}`
      );
    }
    report.mlxScoreThroughput = runs;
  } finally {
    await mlx.shutdown();
  }

  // GGUF per-pair latency on the same pairs (node-llama-cpp ranks one pair at a time).
  const ggufRuns: Array<Record<string, unknown>> = [];
  for (const [runtime, model, make] of [
    ["gguf-qwen3-reranker-0.6b-q8_0", ggufReranker, "qwen3"],
    ["gguf-bge-reranker-v2-m3-q8_0", ggufBge, "default"]
  ] as const) {
    const gguf = await loadGgufModel(model.path);
    try {
      const context =
        make === "qwen3"
          ? await createQwen3RankingContext(gguf.model)
          : await createDefaultRankingContext(gguf.model);
      try {
        await context.rank(pairs[0]!.query, pairs[0]!.document);
        const latencies: number[] = [];
        const scores: number[] = [];
        for (const pair of pairs) {
          const started = performance.now();
          scores.push(await context.rank(pair.query, pair.document));
          latencies.push(performance.now() - started);
        }
        const mlxScores = reference?.scores ?? [];
        const row = {
          runtime,
          pairs: pairs.length,
          msPerPairMean: mean(latencies),
          msPerPairP50: percentile(latencies, 0.5),
          msPerPairP95: percentile(latencies, 0.95),
          pairsPerSecond: (pairs.length * 1000) / latencies.reduce((a, b) => a + b, 0),
          meanAbsScoreDeltaVsMlx: mean(
            scores.map((value, index) => Math.abs(value - mlxScores[index]!))
          ),
          pearsonVsMlx: pearson(scores, mlxScores)
        };
        ggufRuns.push(row);
        console.info(
          `${runtime}: ${fixed(1)(row.pairsPerSecond)} pairs/s, p50 ${fixed(2)(row.msPerPairP50)} ` +
            `ms/pair; scores vs MLX: mean |d| ${fixed(4)(row.meanAbsScoreDeltaVsMlx)}, ` +
            `pearson ${fixed(3)(row.pearsonVsMlx)}`
        );
      } finally {
        await context.dispose();
      }
    } finally {
      await gguf.dispose();
    }
  }
  report.ggufRankThroughput = ggufRuns;
}

function buildPairs(
  count: number,
  targetChars: number
): Array<{ query: string; document: string }> {
  const pairs: Array<{ query: string; document: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const query = notes[index % notes.length]!.title;
    const parts: string[] = [];
    let cursor = index + 1;
    while (parts.join("\n\n").length < targetChars) {
      const note = notes[cursor % notes.length]!;
      parts.push(`${note.idea_statement} ${note.body_markdown}`);
      cursor += 1;
    }
    pairs.push({ query, document: parts.join("\n\n").slice(0, targetChars) });
  }
  return pairs;
}

// --- (c) embedding agreement --------------------------------------------------------------------

async function embeddingSection(): Promise<void> {
  console.info("\n== (c) embedding agreement (first 100 benchmark notes)");
  await access(installedGgufEmbedding);
  const texts = notes.slice(0, 100).map(appEmbeddingInput);

  const mlx = await MlxHelperClient.start();
  let mlxVectors: number[][];
  let mlxTokenCounts: number[];
  const mlxRuns: Array<Record<string, unknown>> = [];
  try {
    await mlx.embed({ modelPath: mlxEmbedder.path, texts: texts.slice(0, 8) });
    let result = await mlx.embed({ modelPath: mlxEmbedder.path, texts, batchSize: 16 });
    mlxVectors = result.embeddings;
    mlxTokenCounts = result.tokenCounts;
    for (const batchSize of [1, 16]) {
      const started = performance.now();
      result = await mlx.embed({ modelPath: mlxEmbedder.path, texts, batchSize });
      const wallMs = performance.now() - started;
      const row = {
        batchSize,
        texts: texts.length,
        textsPerSecond: (texts.length * 1000) / result.timing.inferenceMs,
        wallTextsPerSecond: (texts.length * 1000) / wallMs,
        meanTokens: mean(result.tokenCounts)
      };
      mlxRuns.push(row);
      console.info(
        `MLX batch ${String(batchSize).padStart(2)}: ${fixed(1)(row.textsPerSecond)} texts/s ` +
          `(wall ${fixed(1)(row.wallTextsPerSecond)}), mean ${fixed(1)(row.meanTokens)} tokens`
      );
    }
  } finally {
    await mlx.shutdown();
  }

  const gguf = await loadGgufModel(installedGgufEmbedding);
  let ggufVectors: number[][] = [];
  let ggufTokenCounts: number[] = [];
  const ggufRow: Record<string, number> = {};
  const header = inspectGguf(gguf.model);
  try {
    const context = await createGgufEmbeddingContext(gguf.model);
    try {
      await embedNormalized(context, texts[0]!);
      const started = performance.now();
      ggufVectors = [];
      for (const text of texts) ggufVectors.push(await embedNormalized(context, text));
      const elapsed = performance.now() - started;
      ggufTokenCounts = texts.map(
        (text) => gguf.model.tokenize(text).length + (header.appendsEos ? 1 : 0)
      );
      ggufRow.reusedContextTextsPerSecond = (texts.length * 1000) / elapsed;
    } finally {
      await context.dispose();
    }
    // The desktop adapter creates and disposes an embedding context for every call.
    const perCallSample = texts.slice(0, 20);
    const started = performance.now();
    for (const text of perCallSample) {
      const context = await createGgufEmbeddingContext(gguf.model);
      try {
        await embedNormalized(context, text);
      } finally {
        await context.dispose();
      }
    }
    ggufRow.perCallContextTextsPerSecond =
      (perCallSample.length * 1000) / (performance.now() - started);
  } finally {
    await gguf.dispose();
  }
  console.info(
    `GGUF: ${fixed(1)(ggufRow.reusedContextTextsPerSecond ?? NaN)} texts/s (reused context), ` +
      `${fixed(1)(ggufRow.perCallContextTextsPerSecond ?? NaN)} texts/s (context per call, as the app)`
  );

  const cosines = texts.map((_, index) => dot(mlxVectors[index]!, ggufVectors[index]!));
  const tokenMismatches = mlxTokenCounts.filter(
    (count, index) => count !== ggufTokenCounts[index]
  ).length;
  const neighborOverlap = knnOverlap(mlxVectors, ggufVectors, 5);
  const agreement = {
    texts: texts.length,
    meanCosine: mean(cosines),
    minCosine: Math.min(...cosines),
    p05Cosine: percentile(cosines, 0.05),
    maxCosine: Math.max(...cosines),
    knn5Overlap: neighborOverlap,
    tokenCountMismatches: tokenMismatches,
    ggufAppendsEos: header.appendsEos
  };
  console.info(
    `cosine MLX vs GGUF: mean ${fixed(4)(agreement.meanCosine)}, min ${fixed(4)(agreement.minCosine)}, ` +
      `p05 ${fixed(4)(agreement.p05Cosine)}; kNN@5 overlap ${fixed(3)(neighborOverlap)}; ` +
      `token count mismatches ${tokenMismatches}; GGUF appends EOS ${header.appendsEos}`
  );
  expect(agreement.minCosine >= 0.9, `MLX/GGUF embedding cosine too low: ${agreement.minCosine}`);
  report.embeddingAgreement = {
    ...agreement,
    mlx: mlxRuns,
    gguf: ggufRow,
    ggufHeader: header,
    ggufPath: installedGgufEmbedding,
    ggufSha256: await sha256File(installedGgufEmbedding),
    input: "renderPrompt('embedding.content.note') of title/idea/body; documents get no instruction"
  };
}

function knnOverlap(a: number[][], b: number[][], k: number): number {
  const neighbors = (vectors: number[][], index: number) =>
    vectors
      .map((vector, other) => ({ other, similarity: dot(vectors[index]!, vector) }))
      .filter((entry) => entry.other !== index)
      .sort((x, y) => y.similarity - x.similarity)
      .slice(0, k)
      .map((entry) => entry.other);
  let shared = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = new Set(neighbors(a, index));
    shared += neighbors(b, index).filter((other) => left.has(other)).length;
  }
  return shared / (a.length * k);
}

// --- Utilities ----------------------------------------------------------------------------------

function artifact(models: PinnedModel[], name: string): PinnedModel & { path: string } {
  const model = models.find((candidate) => candidate.name === name);
  if (!model) throw new Error(`models.json has no ${name}`);
  const directory = modelDirectory(model);
  const path =
    model.runtime === "gguf"
      ? join(directory, model.files.find((file) => file.path.endsWith(".gguf"))!.path)
      : directory;
  return { ...model, path };
}

function expect(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function dot(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += a[index]! * b[index]!;
  return total;
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const meanA = mean(a);
  const meanB = mean(b);
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index]! - meanA;
    const db = b[index]! - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / Math.max(values.length, 1);
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))] ?? NaN;
}

function fixed(digits: number): (value: number) => string {
  return (value) => value.toFixed(digits);
}

function optionValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
