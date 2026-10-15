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
 * that runs shares one helper process, which the smoke asserts.
 */
import { execFile } from "node:child_process";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { MlxAdapter } from "../packages/ai/src/local-adapters.js";
import { MlxHelperHost } from "../packages/ai/src/mlx-helper-host.js";

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
const sections = {
  generate: Boolean(generationModelPath?.trim()) || (!scoreModelPath && !embedModelPath),
  score: Boolean(scoreModelPath),
  embed: Boolean(embedModelPath)
};

const host = new MlxHelperHost({ helperPath });
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  helperPath,
  config: host.config
};
const pids = new Set<number>();
const failures: string[] = [];

// --- generate ---------------------------------------------------------------------------------

async function generateSection(): Promise<void> {
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

  if (sections.generate) await generateSection();
  if (sections.score) await scoreSection(await resolveModelDirectory(scoreModelPath!));
  if (sections.embed) await embedSection(await resolveModelDirectory(embedModelPath!));

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
