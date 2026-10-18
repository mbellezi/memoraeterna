/**
 * Real-model smoke of the supervised MLX helper, through the same host and adapter the desktop uses.
 *
 *   npm run mlx:smoke                                       generation on the first installed MLX text model
 *   npm run mlx:smoke -- --score-model-path <dir>           Qwen3-Reranker: model-card pair, en and pt-BR
 *                                                           relevance, helper peak RSS during `score`
 *   npm run mlx:smoke -- --embed-model-path <dir>           Qwen3-Embedding: model-card similarities
 *
 * Options: `--model-path <dir>` (generation, or MEMORA_MLX_MODEL_PATH), `--helper-path <file>`
 * (or MEMORA_MLX_HELPER_PATH), `--report <file>` (writes the measurements as JSON).
 * Naming only `--score-model-path` or `--embed-model-path` skips the generation smoke. Every section
 * that runs shares one helper process, which the smoke asserts: a cancelled request keeps it.
 *
 * The bars of F3 3.5 (T61) run on a helper that announces `cancel`, `stream` and `unload`: with a
 * generation model, the streamed text equals the non-streamed one for a fixed seed and a cancel
 * during the generation stops it within 200 ms at p95 (`--cancel-repeats`, default 20); with a
 * ranker, a cancel during a scoring batch stops it before the next batch; with both, a rank call
 * after the generative model's unload is within 10% of its warm latency. Helper RSS is sampled.
 *
 * Score parity of a helper build (F3 D13, R1), with `--score-model-path`:
 *   --parity-baseline <baseline.json>    the 64 reference pairs, scored in their fixed plan, against
 *                                        a `memora-ranker-parity-baseline` file
 *   --parity-cassette <cassette dir>     recorded `pairs` rank calls (M1's), replayed whole at the
 *                                        batch size they were recorded with, against their scores
 *   --parity-pairs <n>                   at least this many recorded pairs (default 500)
 *   --parity-seed <n>                    which calls are drawn (default 20261018)
 *   --parity-out <parity.json>           the freeze's parity file (with `--parity-template`, whose
 *                                        other runtimes are kept)
 * Naming a parity option skips every other section.
 */
import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { MlxAdapter } from "../packages/ai/src/local-adapters.js";
import {
  MlxRerankerAdapter,
  rankPairsWithAdapter
} from "../packages/ai/src/local-ranker-adapters.js";
import { MlxHelperHost } from "../packages/ai/src/mlx-helper-host.js";
import { readRankResult } from "../packages/ai/src/ranker-input.js";
import {
  compareRankerParity,
  rankerParityPlan,
  rankerParityReferenceHash,
  scoreRankerParityReference
} from "../packages/ai/src/ranker-parity.js";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The MLX helper smoke currently targets darwin-arm64.");
}

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const helperPath = resolve(
  optionValue("--helper-path") ??
    process.env.MEMORA_MLX_HELPER_PATH?.trim() ??
    join(root, "native", "mlx-helper", ".build", "release", "memora-mlx-helper")
);
await Promise.all([access(helperPath), access(join(dirname(helperPath), "mlx.metallib"))]);

const scoreModelPath = optionValue("--score-model-path") ?? process.env.MEMORA_MLX_SCORE_MODEL_PATH;
const embedModelPath = optionValue("--embed-model-path") ?? process.env.MEMORA_MLX_EMBED_MODEL_PATH;
const generationModelPath = optionValue("--model-path") ?? process.env.MEMORA_MLX_MODEL_PATH;
const parity = {
  baseline: optionValue("--parity-baseline"),
  cassette: optionValue("--parity-cassette"),
  pairs: Number(optionValue("--parity-pairs") ?? 500),
  seed: Number(optionValue("--parity-seed") ?? 20261018),
  out: optionValue("--parity-out"),
  template: optionValue("--parity-template")
};
const parityOnly = Boolean(parity.baseline || parity.cassette);
if (parityOnly && !scoreModelPath) throw new Error("The parity check needs --score-model-path.");
const sections = {
  generate:
    !parityOnly && (Boolean(generationModelPath?.trim()) || (!scoreModelPath && !embedModelPath)),
  score: !parityOnly && Boolean(scoreModelPath),
  embed: !parityOnly && Boolean(embedModelPath),
  parity: parityOnly
};
const cancelRepeats = Number(optionValue("--cancel-repeats") ?? 20);

const host = new MlxHelperHost({ helperPath });
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  helperPath,
  config: host.config
};
const pids = new Set<number>();
const failures: string[] = [];

// --- generate ---------------------------------------------------------------------------------

async function generateSection(): Promise<string> {
  console.info("\n== generate");
  const modelPath = await resolveGenerationModelPath();
  const adapter = new MlxAdapter({
    modelId: basename(modelPath),
    modelPath,
    helperPath,
    host,
    capabilities: ["text-generation", "offline"],
    timeoutMs: 10 * 60_000
  });
  const results = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await adapter.run({
      taskType: "text-generation",
      input: "Reply with exactly: OK",
      requiredCapabilities: ["text-generation"],
      parameters: { maxTokens: 4, temperature: 0, topP: 0.95, topK: 20, presencePenalty: 1.5 },
      metadata: { purpose: "mlx-real-model-smoke", attempt }
    });
    expect(
      typeof result.output === "string" && result.output.trim() === "OK",
      `unexpected generation result ${JSON.stringify(result.output)}`
    );
    results.push(result.durationMs);
  }
  recordPid();
  console.info(`generation passed twice for ${basename(modelPath)} in ${results.join("/")} ms`);
  report.generate = { model: basename(modelPath), durationsMs: results };
  return modelPath;
}

// --- score ------------------------------------------------------------------------------------

/** Qwen3-Reranker model card: raw logit differences (bf16 GPU values; the pair differs by up to ~1). */
const rerankerCard = {
  query: "What is the capital of China?",
  documents: [
    "The capital of China is Beijing.",
    "Gravity is a force that attracts two bodies towards each other. It gives weight to physical objects and is responsible for the movement of planets around the sun."
  ],
  expectedLogOdds: [7.625, -11.375],
  tolerance: 1
};

const relevanceCases = [
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

/** Margin in log-odds by which a relevant passage must beat an irrelevant one. */
const minimumRelevanceMargin = 0.5;
/** A rank request carries at most 32 documents; each is about 300 tokens in the matching use. */
const workloadDocuments = 32;

async function scoreSection(modelPath: string): Promise<void> {
  console.info("\n== score");
  const pid = requirePid();

  const card = await measureRss(pid, () =>
    host.score({
      modelPath,
      query: rerankerCard.query,
      documents: rerankerCard.documents,
      batchSize: 1
    })
  );
  const cardDelta = Math.max(
    ...card.result.logOdds.map((value, index) =>
      Math.abs(value - rerankerCard.expectedLogOdds[index]!)
    )
  );
  console.info(
    `model-card pair: logOdds ${card.result.logOdds.map((v) => v.toFixed(3)).join(", ")} ` +
      `(card ${rerankerCard.expectedLogOdds.join(", ")}), max |delta| ${cardDelta.toFixed(3)}; ` +
      `model load ${card.result.timing.loadMs.toFixed(0)} ms, peak RSS ${card.rss.peakMb} MB`
  );
  expect(
    cardDelta <= rerankerCard.tolerance,
    `reranker deviates from the model card by ${cardDelta}`
  );

  const relevance = [];
  for (const testCase of relevanceCases) {
    const measured = await measureRss(pid, () =>
      host.score({
        modelPath,
        query: testCase.query,
        documents: [testCase.relevant, testCase.irrelevant]
      })
    );
    const [relevant, irrelevant] = measured.result.logOdds as [number, number];
    const margin = relevant - irrelevant;
    console.info(
      `${testCase.language.padEnd(6)} relevant ${relevant.toFixed(3)}  irrelevant ${irrelevant.toFixed(3)}  ` +
        `margin ${margin.toFixed(3)}  peak RSS ${measured.rss.peakMb} MB`
    );
    expect(
      margin >= minimumRelevanceMargin,
      `${testCase.language}: relevant ${relevant} vs irrelevant ${irrelevant}`
    );
    relevance.push({
      language: testCase.language,
      relevant,
      irrelevant,
      margin,
      rss: measured.rss
    });
  }

  const documents = buildWorkloadDocuments(workloadDocuments);
  const workload = await measureRss(pid, () =>
    host.score({ modelPath, query: relevanceCases[0]!.query, documents, batchSize: 16 })
  );
  const tokens = workload.result.tokenCounts;
  console.info(
    `${documents.length}-document workload: ${mean(tokens).toFixed(0)} tokens per pair on average, ` +
      `${workload.result.timing.perItemMs.toFixed(1)} ms per pair, peak RSS ${workload.rss.peakMb} MB ` +
      `(${workload.rss.samples} samples)`
  );
  expect(
    workload.result.logOdds.length === documents.length &&
      workload.result.logOdds.every(Number.isFinite),
    "the workload returned an invalid result"
  );
  recordPid();

  const peakDuringScoreMb = Math.max(
    card.rss.peakMb,
    workload.rss.peakMb,
    ...relevance.map((entry) => entry.rss.peakMb)
  );
  console.info(`helper peak RSS during score: ${peakDuringScoreMb} MB`);
  report.score = {
    model: basename(modelPath),
    modelCard: {
      logOdds: card.result.logOdds,
      expected: rerankerCard.expectedLogOdds,
      maxAbsDelta: cardDelta,
      yesTokenId: card.result.yesTokenId,
      noTokenId: card.result.noTokenId,
      loadMs: card.result.timing.loadMs,
      rss: card.rss
    },
    relevance,
    workload: {
      documents: documents.length,
      batchSize: 16,
      meanTokensPerPair: mean(tokens),
      maxTokensPerPair: Math.max(...tokens),
      perItemMs: workload.result.timing.perItemMs,
      rss: workload.rss
    },
    peakRssDuringScoreMb: peakDuringScoreMb
  };
}

function buildWorkloadDocuments(count: number): string[] {
  const paragraphs = relevanceCases.flatMap((entry) => [entry.relevant, entry.irrelevant]);
  return Array.from({ length: count }, (_, index) =>
    Array.from({ length: 5 }, (_, offset) => paragraphs[(index + offset) % paragraphs.length]).join(
      " "
    )
  );
}

// --- embed ------------------------------------------------------------------------------------

/** Qwen3-Embedding model card (Transformers example): query by document cosine similarity. */
const embeddingCard = {
  instruction: "Given a web search query, retrieve relevant passages that answer the query",
  queries: ["What is the capital of China?", "Explain gravity"],
  documents: rerankerCard.documents,
  expected: [
    [0.7645568251609802, 0.14142508804798126],
    [0.13549736142158508, 0.5999549627304077]
  ],
  tolerance: 0.01
};

async function embedSection(modelPath: string): Promise<void> {
  console.info("\n== embed");
  const texts = [
    ...embeddingCard.queries.map(
      (query) => `Instruct: ${embeddingCard.instruction}\nQuery:${query}`
    ),
    ...embeddingCard.documents
  ];
  const embedded = await measureRss(requirePid(), () => host.embed({ modelPath, texts }));
  const [q1, q2, d1, d2] = embedded.result.embeddings as [number[], number[], number[], number[]];
  const similarity = [
    [dot(q1, d1), dot(q1, d2)],
    [dot(q2, d1), dot(q2, d2)]
  ];
  const delta = Math.max(
    ...similarity.flatMap((row, i) =>
      row.map((value, j) => Math.abs(value - embeddingCard.expected[i]![j]!))
    )
  );
  const norms = embedded.result.embeddings.map((vector) => Math.sqrt(dot(vector, vector)));
  console.info(
    `model-card similarities ${JSON.stringify(similarity.map((row) => row.map((v) => round(v, 4))))}, ` +
      `max |delta| ${delta.toFixed(4)}, ${embedded.result.dimensions} dimensions, ` +
      `pooling ${embedded.result.pooling}, peak RSS ${embedded.rss.peakMb} MB`
  );
  expect(delta <= embeddingCard.tolerance, `embeddings deviate from the model card by ${delta}`);
  expect(
    norms.every((norm) => Math.abs(norm - 1) < 1e-3),
    `embeddings are not unit length: ${norms}`
  );
  recordPid();
  report.embed = {
    model: basename(modelPath),
    similarity,
    expected: embeddingCard.expected,
    maxAbsDelta: delta,
    dimensions: embedded.result.dimensions,
    pooling: embedded.result.pooling,
    tokenCounts: embedded.result.tokenCounts,
    rss: embedded.rss
  };
}

// --- T61: stream, cancel, unload (F3 3.5) -------------------------------------------------------

const streamedPrompt =
  "Write four sentences about how rivers shape valleys over thousands of years. Use plain words.";
const longPrompt =
  "Write a long, detailed essay of at least 1,500 words about the history of bookbinding, with " +
  "sections on materials, tools, techniques and famous workshops.";
/** Cancel latency at p95 during a generation (F3 3.5). */
const cancelBarMs = 200;
/** A rank call after a generative unload, against its warm latency (F3 3.5). */
const unloadLatencyFactor = 1.1;

function requireCapabilities(): void {
  for (const capability of ["cancel", "stream", "unload"] as const)
    expect(host.supports(capability), `the helper does not announce ${capability}`);
}

/** Streamed text equals the non-streamed text for a fixed seed; the pieces add up to it. */
async function streamSection(modelPath: string): Promise<void> {
  console.info("\n== stream");
  const input = {
    modelPath,
    prompt: streamedPrompt,
    parameters: { maxTokens: 160, temperature: 0.7, topP: 0.9, seed: 61, enableThinking: false }
  };
  const whole = await host.generate(input);
  const pieces: string[] = [];
  let firstPieceMs: number | undefined;
  const started = performance.now();
  const streamed = await host.generate(
    { ...input, stream: true },
    {
      onDelta: (piece) => {
        firstPieceMs ??= performance.now() - started;
        pieces.push(piece);
      }
    }
  );
  const equal = streamed.output === whole.output;
  expect(equal, "the streamed text differs from the non-streamed text for the same seed");
  expect(pieces.join("") === streamed.output, "the streamed pieces do not add up to the text");
  expect(pieces.length > 1, "the helper sent the text in one piece");
  console.info(
    `streamed ${pieces.length} pieces (${streamed.output.length} characters), first after ` +
      `${round(firstPieceMs ?? 0, 0)} ms; equal to the non-streamed text: ${equal}`
  );
  recordPid();
  report.stream = {
    equal,
    pieces: pieces.length,
    characters: streamed.output.length,
    outputTokens: streamed.outputTokens,
    firstPieceMs: round(firstPieceMs ?? 0, 1),
    durationMs: streamed.durationMs
  };
}

/** Cancels generations mid-stream: the helper stops within the bar and keeps its PID. */
async function cancelSection(modelPath: string): Promise<void> {
  console.info("\n== cancel (generation)");
  const pid = requirePid();
  const latencies: number[] = [];
  const pieces: number[] = [];
  const measured = await measureRss(pid, async () => {
    for (let attempt = 0; attempt < cancelRepeats; attempt += 1) {
      const controller = new AbortController();
      const cancelAfter = 8 + (attempt % 8);
      let seen = 0;
      let cancelledAt = 0;
      const outcome = await host
        .generate(
          {
            modelPath,
            prompt: longPrompt,
            parameters: {
              maxTokens: 2_000,
              temperature: 0.7,
              seed: attempt,
              enableThinking: false
            },
            stream: true
          },
          {
            signal: controller.signal,
            onDelta: () => {
              seen += 1;
              if (seen === cancelAfter) {
                cancelledAt = performance.now();
                controller.abort();
              }
            }
          }
        )
        .then(
          () => "finished",
          (error: unknown) => (error as Error).name
        );
      // An aborted caller is released at once; the helper is free again once the cancelled request
      // answered, which is when a request queued behind it is answered.
      await host.health();
      const latency = performance.now() - cancelledAt;
      expect(outcome === "AbortError", `cancel ${attempt}: the generation ended with ${outcome}`);
      expect(host.pid === pid, `cancel ${attempt}: the helper changed PID`);
      latencies.push(latency);
      pieces.push(seen);
    }
  });
  const p95 = percentile(latencies, 0.95);
  console.info(
    `${latencies.length} cancels: p50 ${round(percentile(latencies, 0.5), 1)} ms, p95 ` +
      `${round(p95, 1)} ms, max ${round(Math.max(...latencies), 1)} ms (bar ${cancelBarMs} ms), ` +
      `same PID ${host.pid === pid}, peak RSS ${measured.rss.peakMb} MB`
  );
  expect(p95 <= cancelBarMs, `cancel latency p95 ${p95} ms is above ${cancelBarMs} ms`);
  // A class deadline cancels the same way; the call itself settles once the helper stopped.
  const deadlineMs = 1_500;
  const pastDeadline: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    const outcome = await host
      .generate(
        {
          modelPath,
          prompt: longPrompt,
          parameters: { maxTokens: 2_000, temperature: 0.7, seed: 100 + attempt },
          stream: true
        },
        { timeoutMs: deadlineMs }
      )
      .then(
        () => "finished",
        (error: unknown) => String((error as { code?: string }).code)
      );
    pastDeadline.push(performance.now() - started - deadlineMs);
    expect(outcome === "timeout", `deadline ${attempt}: the generation ended with ${outcome}`);
    expect(host.pid === pid, `deadline ${attempt}: the helper changed PID`);
  }
  console.info(
    `5 deadline cancels settled ${pastDeadline.map((value) => round(value, 1)).join(", ")} ms ` +
      `after the ${deadlineMs} ms deadline`
  );
  expect(
    percentile(pastDeadline, 0.95) <= cancelBarMs,
    `a deadline cancel settled ${Math.max(...pastDeadline)} ms after its deadline`
  );
  // The model stays loaded: the next generation does not load it again.
  const after = await host.generate({
    modelPath,
    prompt: "Reply with exactly: OK",
    parameters: { maxTokens: 4, temperature: 0, enableThinking: false }
  });
  expect(after.output.trim() === "OK", `after the cancels: ${JSON.stringify(after.output)}`);
  recordPid();
  report.cancel = {
    repeats: latencies.length,
    latenciesMs: latencies.map((value) => round(value, 1)),
    p50Ms: round(percentile(latencies, 0.5), 1),
    p95Ms: round(p95, 1),
    maxMs: round(Math.max(...latencies), 1),
    barMs: cancelBarMs,
    piecesBeforeCancel: pieces,
    deadline: { deadlineMs, settledAfterMs: pastDeadline.map((value) => round(value, 1)) },
    samePid: host.pid === pid,
    rss: measured.rss
  };
}

/** Cancels a long scoring request: it stops before its next batch and keeps the PID. */
async function scoreCancelSection(modelPath: string): Promise<void> {
  console.info("\n== cancel (scoring)");
  const pid = requirePid();
  const documents = buildWorkloadDocuments(512);
  const latencies: number[] = [];
  let batchMs = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    let cancelledAt = 0;
    const timer = setTimeout(
      () => {
        cancelledAt = performance.now();
        controller.abort();
      },
      400 + attempt * 150
    );
    const outcome = await host
      .score(
        { modelPath, query: relevanceCases[0]!.query, documents, batchSize: 16 },
        { signal: controller.signal }
      )
      .then(
        (result) => {
          batchMs = Math.max(batchMs, ...result.timing.batches.map((batch) => batch.ms));
          return "finished";
        },
        (error: unknown) => (error as Error).name
      );
    clearTimeout(timer);
    await host.health();
    expect(
      outcome === "AbortError",
      `scoring cancel ${attempt}: the request ended with ${outcome}`
    );
    expect(host.pid === pid, `scoring cancel ${attempt}: the helper changed PID`);
    latencies.push(performance.now() - cancelledAt);
  }
  const warm = await host.score({
    modelPath,
    query: relevanceCases[0]!.query,
    documents: documents.slice(0, 16),
    batchSize: 16
  });
  batchMs = Math.max(batchMs, ...warm.timing.batches.map((batch) => batch.ms));
  const max = Math.max(...latencies);
  console.info(
    `${latencies.length} scoring cancels: max ${round(max, 1)} ms; one 16-pair batch ` +
      `${round(batchMs, 1)} ms; same PID ${host.pid === pid}`
  );
  // A cancel waits for the batch in flight at most, plus the answer.
  expect(max <= batchMs + cancelBarMs, `a scoring cancel took ${max} ms`);
  recordPid();
  report.scoreCancel = {
    latenciesMs: latencies.map((value) => round(value, 1)),
    maxMs: round(max, 1),
    batchMs: round(batchMs, 1),
    samePid: host.pid === pid
  };
}

/**
 * After the generative model's unload the ranker answers at its warm latency: the helper keeps
 * the ranker's weights, its PID and its other slots; RSS falls by about the writer's weights.
 */
async function unloadSection(generateModelPath: string, scoreModelPath: string): Promise<void> {
  console.info("\n== unload");
  const pid = requirePid();
  const small = { modelPath: scoreModelPath, ...relevanceCaseRequest() };
  const full = {
    modelPath: scoreModelPath,
    query: relevanceCases[0]!.query,
    documents: buildWorkloadDocuments(workloadDocuments),
    batchSize: 16
  };
  const timeRank = async (input: Parameters<typeof host.score>[0]) => {
    const started = performance.now();
    const result = await host.score(input);
    return { wallMs: performance.now() - started, cached: result.timing.modelCached };
  };
  const warmSmall: number[] = [];
  const warmFull: number[] = [];
  for (let repeat = 0; repeat < 5; repeat += 1) {
    warmSmall.push((await timeRank(small)).wallMs);
    warmFull.push((await timeRank(full)).wallMs);
  }
  await host.generate({
    modelPath: generateModelPath,
    prompt: "Reply with exactly: OK",
    parameters: { maxTokens: 4, temperature: 0, enableThinking: false }
  });
  const withWriterKb = (await residentSetKb(pid)) ?? 0;
  const outcome = await host.unload("generate");
  const afterUnloadKb = (await residentSetKb(pid)) ?? 0;
  expect(outcome === "unloaded", `unload answered ${outcome}`);
  expect(host.pid === pid, "the unload changed the helper's PID");
  expect(host.loadedModel("score") === scoreModelPath, "the unload dropped the ranker");
  const nextSmall = await timeRank(small);
  const nextFull = await timeRank(full);
  const warmSmallMs = percentile(warmSmall, 0.5);
  const warmFullMs = percentile(warmFull, 0.5);
  expect(nextSmall.cached && nextFull.cached, "the ranker loaded again after the unload");
  expect(
    nextFull.wallMs <= warmFullMs * unloadLatencyFactor,
    `the ${workloadDocuments}-pair rank call after the unload took ${nextFull.wallMs} ms (warm ${warmFullMs})`
  );
  console.info(
    `rank call after the unload: ${round(nextSmall.wallMs, 1)} ms for 2 pairs (warm p50 ` +
      `${round(warmSmallMs, 1)}), ${round(nextFull.wallMs, 1)} ms for ${workloadDocuments} (warm ` +
      `${round(warmFullMs, 1)}); helper RSS ${round(mb(withWriterKb), 0)} -> ` +
      `${round(mb(afterUnloadKb), 0)} MB`
  );
  recordPid();
  report.unload = {
    warmSmallMs: warmSmall.map((value) => round(value, 1)),
    warmFullMs: warmFull.map((value) => round(value, 1)),
    afterUnloadSmallMs: round(nextSmall.wallMs, 1),
    afterUnloadFullMs: round(nextFull.wallMs, 1),
    factor: round(nextFull.wallMs / warmFullMs, 3),
    bar: unloadLatencyFactor,
    rssWithWriterMb: round(mb(withWriterKb), 1),
    rssAfterUnloadMb: round(mb(afterUnloadKb), 1),
    samePid: host.pid === pid
  };
}

function relevanceCaseRequest(): { query: string; documents: string[] } {
  const testCase = relevanceCases[0]!;
  return { query: testCase.query, documents: [testCase.relevant, testCase.irrelevant] };
}

// --- parity (F3 D13, R1) ------------------------------------------------------------------------

/** One recorded `pairs` rank call of a cassette and the log-odds it was answered with. */
interface RecordedRankCall {
  key: string;
  input: string;
  parameters: Record<string, unknown>;
  logOdds: number[];
}

async function recordedRankCalls(directory: string): Promise<RecordedRankCall[]> {
  const calls: RecordedRankCall[] = [];
  const root = join(directory, "entries");
  for (const shard of (await readdir(root)).sort()) {
    for (const file of (await readdir(join(root, shard))).sort()) {
      const entry = JSON.parse(await readFile(join(root, shard, file), "utf8")) as {
        key: string;
        taskType: string;
        request: {
          input: string;
          parameters: Record<string, unknown>;
          model: { providerId: string };
        };
        responses: Array<{ output: { logOdds: number[] } }>;
      };
      if (entry.taskType !== "reranking" || entry.request.model.providerId !== "local-mlx")
        continue;
      if (!entry.request.input.includes('"pairs"')) continue;
      // Every occurrence of a key was answered by the same build at the same batch; the first counts.
      calls.push({
        key: entry.key,
        input: entry.request.input,
        parameters: entry.request.parameters,
        logOdds: entry.responses[0]!.output.logOdds
      });
    }
  }
  return calls;
}

async function paritySection(modelPath: string): Promise<void> {
  console.info("\n== parity");
  const adapter = new MlxRerankerAdapter({
    modelId: "parity",
    modelPath,
    helperPath,
    host,
    capabilities: ["reranking", "offline", "local-files"]
  });
  const runtimeBuild = await adapter.runtimeBuild();
  const result: Record<string, unknown> = { runtimeBuild, model: basename(modelPath) };
  let reference: { referenceHash: string; maxAbsDelta: number } | null = null;
  if (parity.baseline) {
    const baseline = JSON.parse(await readFile(resolve(parity.baseline), "utf8")) as {
      referenceHash: string;
      plan: unknown;
      runtimeBuild: string;
      scores: number[];
    };
    const referenceHash = rankerParityReferenceHash();
    expect(baseline.referenceHash === referenceHash, "the baseline is of another reference set");
    expect(
      JSON.stringify(baseline.plan) === JSON.stringify(rankerParityPlan("mlx")),
      "the baseline was scored under another plan"
    );
    const scores = await scoreRankerParityReference("mlx", (request, plan) =>
      rankPairsWithAdapter(
        adapter,
        request,
        plan.helperBatchSize === undefined ? {} : { batchSize: plan.helperBatchSize }
      )
    );
    const delta = compareRankerParity(baseline.scores, scores);
    reference = { referenceHash, maxAbsDelta: delta.maxDelta };
    console.info(
      `64 reference pairs against ${baseline.runtimeBuild}: max |delta| ${delta.maxDelta}, mean ` +
        `${round(delta.meanDelta, 4)}`
    );
    result.reference = { ...delta, baselineBuild: baseline.runtimeBuild, scores };
  }
  let m1Pairs: { pairs: number; maxAbsDelta: number } | null = null;
  if (parity.cassette) {
    const calls = await recordedRankCalls(resolve(parity.cassette));
    const order = seededShuffle(calls, parity.seed);
    const chosen: RecordedRankCall[] = [];
    let pairs = 0;
    for (const call of order) {
      if (pairs >= parity.pairs) break;
      chosen.push(call);
      pairs += call.logOdds.length;
    }
    expect(
      pairs >= parity.pairs,
      `the cassette holds ${pairs} recorded pairs, fewer than ${parity.pairs}`
    );
    let maxAbsDelta = 0;
    let total = 0;
    let identical = 0;
    for (const call of chosen) {
      const ran = await adapter.run({
        taskType: "reranking",
        input: call.input,
        requiredCapabilities: ["reranking"],
        parameters: call.parameters,
        metadata: {}
      });
      const scored = readRankResult(ran, call.logOdds.length).logOdds;
      scored.forEach((value, index) => {
        const delta = Math.abs(value - call.logOdds[index]!);
        maxAbsDelta = Math.max(maxAbsDelta, delta);
        total += delta;
        if (delta === 0) identical += 1;
      });
    }
    m1Pairs = { pairs, maxAbsDelta };
    console.info(
      `${chosen.length} recorded calls, ${pairs} pairs at their recorded batch: max |delta| ` +
        `${maxAbsDelta}, mean ${round(total / pairs, 4)}, identical ${identical}`
    );
    result.m1Pairs = {
      calls: chosen.length,
      callsInCassette: calls.length,
      pairs,
      maxAbsDelta,
      meanAbsDelta: total / pairs,
      identical,
      keys: chosen.map((call) => call.key),
      seed: parity.seed
    };
  }
  recordPid();
  report.parity = result;
  if (parity.out) {
    if (!reference) throw new Error("--parity-out needs --parity-baseline.");
    const template = parity.template
      ? (JSON.parse(await readFile(resolve(parity.template), "utf8")) as {
          runtimes: Record<string, unknown>;
        })
      : { runtimes: {} };
    const file = {
      format: "memora-f3-freeze-parity",
      version: 1,
      runtimes: {
        ...template.runtimes,
        mlx: {
          runtimeBuild,
          reference,
          m1Pairs,
          source: resolve(optionValue("--report") ?? parity.out)
        }
      }
    };
    await mkdir(dirname(resolve(parity.out)), { recursive: true });
    await writeFile(resolve(parity.out), `${JSON.stringify(file, null, 1)}\n`);
    console.info(`Parity file: ${resolve(parity.out)}`);
  }
}

/** A deterministic shuffle (mulberry32), so the same seed draws the same calls. */
function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

// --- support ----------------------------------------------------------------------------------

interface RssMeasurement {
  peakMb: number;
  startMb: number;
  endMb: number;
  samples: number;
}

/** Samples the helper's resident set size every 100 ms while `run` executes. */
async function measureRss<T>(
  pid: number,
  run: () => Promise<T>
): Promise<{ result: T; rss: RssMeasurement }> {
  const samples: number[] = [];
  let sampling: Promise<void> = Promise.resolve();
  const sample = () => {
    sampling = sampling.then(async () => {
      const kb = await residentSetKb(pid);
      if (kb !== undefined) samples.push(kb);
    });
  };
  sample();
  const timer = setInterval(sample, 100);
  let result: T;
  try {
    result = await run();
  } finally {
    clearInterval(timer);
  }
  sample();
  await sampling;
  const peakKb = Math.max(...samples);
  return {
    result,
    rss: {
      peakMb: round(mb(peakKb), 1),
      startMb: round(mb(samples[0] ?? 0), 1),
      endMb: round(mb(samples.at(-1) ?? 0), 1),
      samples: samples.length
    }
  };
}

async function residentSetKb(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const value = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function requirePid(): number {
  const pid = host.pid;
  if (pid === undefined) throw new Error("The MLX helper is not running.");
  return pid;
}

function recordPid(): void {
  pids.add(requirePid());
}

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

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((total, value, index) => total + value * b[index]!, 0);
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function mb(kilobytes: number): number {
  return kilobytes / 1_024;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function resolveModelDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  await assertModelDirectory(resolved);
  return resolved;
}

async function resolveGenerationModelPath(): Promise<string> {
  const configured = generationModelPath?.trim();
  if (configured) {
    await assertModelDirectory(configured);
    return resolve(configured);
  }

  const roots = [
    join(homedir(), "Library", "Application Support", "@app", "desktop", "local-models"),
    join(homedir(), "Library", "Application Support", "Memora Eterna", "local-models")
  ];
  for (const modelsRoot of roots) {
    let entries;
    try {
      entries = await readdir(modelsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries
      .filter((candidate) => candidate.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = join(modelsRoot, entry.name);
      try {
        await assertModelDirectory(candidate);
        return candidate;
      } catch {
        // Continue looking for a fully materialized model.
      }
    }
  }

  throw new Error(
    "No installed MLX model was found. Set MEMORA_MLX_MODEL_PATH or pass --model-path <path>."
  );
}

async function assertModelDirectory(path: string): Promise<void> {
  const files = await readdir(path);
  if (
    !files.includes("config.json") ||
    !files.includes("tokenizer.json") ||
    !files.some((file) => file.endsWith(".safetensors"))
  ) {
    throw new Error(`The MLX model directory is incomplete: ${path}`);
  }
}

// --- run --------------------------------------------------------------------------------------

try {
  await host.health();
  recordPid();
  report.idleRssMb = round(mb((await residentSetKb(requirePid())) ?? 0), 1);
  console.info(`helper pid ${requirePid()}, idle RSS ${String(report.idleRssMb)} MB`);

  report.capabilities = [...(host.capabilities ?? [])];
  const scoreModel = sections.score ? await resolveModelDirectory(scoreModelPath!) : undefined;
  let generationModel: string | undefined;
  if (sections.generate) generationModel = await generateSection();
  if (scoreModel) await scoreSection(scoreModel);
  if (sections.embed) await embedSection(await resolveModelDirectory(embedModelPath!));
  if (sections.parity) await paritySection(await resolveModelDirectory(scoreModelPath!));
  if (generationModel || scoreModel) requireCapabilities();
  if (generationModel) {
    await streamSection(generationModel);
    await cancelSection(generationModel);
  }
  if (scoreModel) await scoreCancelSection(scoreModel);
  if (generationModel && scoreModel) await unloadSection(generationModel, scoreModel);

  expect(pids.size === 1 && host.spawnCount === 1, `expected one helper process, saw ${[...pids]}`);
  report.helperProcesses = { pids: [...pids], spawnCount: host.spawnCount };
} finally {
  await host.dispose();
}

report.finishedAt = new Date().toISOString();
report.failures = failures;
const reportPath = optionValue("--report");
if (reportPath) {
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  console.info(`Report: ${resolve(reportPath)}`);
}
if (failures.length > 0) {
  console.error(`FAILED:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.info(
    `MLX helper smoke passed (${Object.entries(sections)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name)
      .join(", ")}) on one helper process.`
  );
}
