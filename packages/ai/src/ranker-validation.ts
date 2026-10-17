import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type { GgufFileInfo } from "node-llama-cpp";
import { z } from "zod";

import { localModelManifestHash, type LocalModelCatalogEntry } from "./local-model-catalog.js";
import { resolveManagedModelPath, sha256File } from "./local-model-downloader.js";
import { isDedicatedRanker } from "./parameter-capabilities.js";
import { rankerParityRecordSchema, type RankerParityRecord } from "./ranker-parity.js";
import {
  LocalRankerError,
  qwen3RerankerPrompt,
  type RankRequest,
  type RankResult
} from "./ranker-input.js";

/**
 * Validation of a dedicated ranker before it may decide (`rules/ai.md`, D17): the artifact (MLX
 * `config.json` architecture plus checksums, or the GGUF header), then a smoke test on the model
 * card pair and a relevant/irrelevant pair in English and Brazilian Portuguese. A passing run is
 * recorded per install as a `DecideValidation`, which a revision, artifact or runtime change voids.
 */

export type RankerRuntime = "mlx" | "gguf";

export interface RankerArtifactFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface RankerArtifactReport {
  runtime: RankerRuntime;
  /** GGUF: the file's SHA-256. MLX: SHA-256 of the `path:size:sha256` lines of the checked files,
   * the same manifest hash a catalog entry gets. */
  artifactSha256: string;
  sizeBytes: number;
  architecture: string;
}

/** `config.json` architectures of an MLX ranker the helper can score (`Scoring.swift`). */
export const mlxRankerArchitectures = ["Qwen3ForCausalLM"] as const;
/** GGUF header of a ranker: architecture, rank pooling (`LLAMA_POOLING_TYPE_RANK`) and labels. */
export const ggufRankerHeader = {
  architecture: "qwen3",
  poolingType: 4,
  /** Label 0 is the score node-llama-cpp returns, so the order fixes the polarity. */
  outputLabels: ["yes", "no"]
} as const;

const sha256Pattern = /^[a-f0-9]{64}$/u;

/**
 * Validates an MLX ranker directory: its `config.json` names the Qwen3 causal LM architecture,
 * then every declared file exists with its size and SHA-256. The architecture alone cannot tell a
 * reranker from another Qwen3 checkpoint; the pinned checksums and the smoke test do.
 */
export async function validateMlxRankerArtifact(input: {
  directory: string;
  files: readonly RankerArtifactFile[];
}): Promise<RankerArtifactReport> {
  if (!input.files.some((file) => file.path === "config.json")) {
    throw new LocalRankerError("errors.localModels.rankerInvalid", "config.json is not declared.");
  }
  if (!input.files.some((file) => file.path.endsWith(".safetensors"))) {
    throw new LocalRankerError("errors.localModels.rankerInvalid", "No weights are declared.");
  }
  const config = await readJson(resolveManagedModelPath(input.directory, "config.json"));
  const architectures = (config as { architectures?: unknown } | null)?.architectures;
  if (!sameStrings(architectures, mlxRankerArchitectures)) {
    throw new LocalRankerError(
      "errors.localModels.rankerInvalid",
      `config.json architectures ${JSON.stringify(architectures)}, expected ${JSON.stringify(mlxRankerArchitectures)}.`
    );
  }
  let sizeBytes = 0;
  for (const file of input.files) {
    await verifyFile(resolveManagedModelPath(input.directory, file.path), file);
    sizeBytes += file.sizeBytes;
  }
  const manifest = input.files
    .map((file) => `${file.path}:${file.sizeBytes}:${file.sha256}`)
    .join("\n");
  return {
    runtime: "mlx",
    artifactSha256: createHash("sha256").update(manifest).digest("hex"),
    sizeBytes,
    architecture: mlxRankerArchitectures[0]
  };
}

/** What the GGUF validator reads from a header. */
export interface GgufRankerFacts {
  architecture: string | undefined;
  poolingType: unknown;
  outputLabels: unknown;
  /** A classification head the ranking runtime can read (node-llama-cpp `supportsRanking`). */
  supportsRanking: boolean;
}

/** Throws `rankerInvalid` unless the header is a Qwen3 ranker with rank pooling and yes/no labels. */
export function checkGgufRankerFacts(facts: GgufRankerFacts): void {
  const problems: string[] = [];
  if (facts.architecture !== ggufRankerHeader.architecture) {
    problems.push(`architecture ${facts.architecture ?? "missing"}, expected qwen3`);
  }
  if (facts.poolingType !== ggufRankerHeader.poolingType) {
    problems.push(`pooling type ${JSON.stringify(facts.poolingType ?? null)}, expected rank (4)`);
  }
  if (!facts.supportsRanking) problems.push("no ranking head");
  if (!sameStrings(facts.outputLabels, ggufRankerHeader.outputLabels)) {
    problems.push(
      `classifier labels ${JSON.stringify(facts.outputLabels ?? null)}, expected ["yes","no"]`
    );
  }
  if (problems.length > 0) {
    throw new LocalRankerError("errors.localModels.rankerInvalid", problems.join("; "));
  }
}

/**
 * The ranker facts of a parsed GGUF header. `supportsRanking` is the runtime's own answer once the
 * model is loaded; from a header alone it follows node-llama-cpp's rule: a classification tensor
 * plus an end or separator token, or a ranking template with both placeholders.
 */
export function ggufRankerFacts(
  fileInfo: Pick<GgufFileInfo, "metadata" | "fullTensorInfo">,
  supportsRanking?: boolean
): GgufRankerFacts {
  const metadata = fileInfo.metadata as unknown as Record<string, unknown>;
  const general = record(metadata.general);
  const architecture = typeof general?.architecture === "string" ? general.architecture : undefined;
  const architectureMetadata = architecture ? record(metadata[architecture]) : undefined;
  return {
    architecture,
    poolingType: architectureMetadata?.pooling_type,
    outputLabels: record(architectureMetadata?.classifier)?.output_labels,
    supportsRanking: supportsRanking ?? headerSupportsRanking(fileInfo, metadata)
  };
}

/** Reads the ranker facts from a GGUF file's header without loading the weights. */
export async function readGgufRankerFacts(path: string): Promise<GgufRankerFacts> {
  const { readGgufFileInfo } = await import("node-llama-cpp");
  let fileInfo: GgufFileInfo;
  try {
    fileInfo = await readGgufFileInfo(path, { readTensorInfo: true });
  } catch (error) {
    throw new LocalRankerError(
      "errors.localModels.rankerInvalid",
      `The GGUF header could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return ggufRankerFacts(fileInfo);
}

/** Validates a GGUF ranker file: its header, then its size and SHA-256 when they are pinned. */
export async function validateGgufRankerArtifact(input: {
  path: string;
  sizeBytes?: number;
  sha256?: string;
}): Promise<RankerArtifactReport> {
  const size = await fileSize(input.path);
  checkGgufRankerFacts(await readGgufRankerFacts(input.path));
  if (input.sizeBytes !== undefined && size !== input.sizeBytes) {
    throw new LocalRankerError(
      "errors.localModels.sizeMismatch",
      `${size} bytes, expected ${input.sizeBytes}.`
    );
  }
  const sha256 = await sha256File(input.path);
  if (input.sha256 !== undefined && sha256 !== input.sha256) {
    throw new LocalRankerError("errors.localModels.checksumMismatch", "The GGUF file changed.");
  }
  return {
    runtime: "gguf",
    artifactSha256: sha256,
    sizeBytes: size,
    architecture: ggufRankerHeader.architecture
  };
}

// --- catalog installs ---------------------------------------------------------------------------------

/** Whether a catalog entry is a dedicated ranker, which exposes `reranking` only once validated. */
export function isRankerCatalogEntry(entry: Pick<LocalModelCatalogEntry, "capabilities">): boolean {
  return isDedicatedRanker(entry.capabilities);
}

/**
 * The artifact digest a validation of this catalog entry carries when the install matches its pins:
 * the manifest hash for an MLX directory, the file's SHA-256 for a GGUF.
 */
export function rankerCatalogArtifactSha256(
  entry: Pick<LocalModelCatalogEntry, "runtime" | "files">
): string {
  if (entry.runtime === "mlx") return localModelManifestHash(entry);
  return ggufFile(entry).sha256;
}

/**
 * Validates an installed catalog ranker against its pins. `modelPath` is the managed folder of the
 * entry (or, for a GGUF, the file itself). Throws the localized `LocalRankerError` of the first
 * problem: a missing file, a size or checksum mismatch, or an artifact that is not a supported
 * Qwen3 ranker.
 */
export async function validateCatalogRankerArtifact(
  entry: Pick<LocalModelCatalogEntry, "runtime" | "files">,
  modelPath: string
): Promise<RankerArtifactReport> {
  if (entry.runtime === "mlx") {
    return validateMlxRankerArtifact({ directory: modelPath, files: entry.files });
  }
  const file = ggufFile(entry);
  return validateGgufRankerArtifact({
    path: modelPath.toLowerCase().endsWith(".gguf")
      ? modelPath
      : resolveManagedModelPath(modelPath, file.path),
    sizeBytes: file.sizeBytes,
    sha256: file.sha256
  });
}

/**
 * The stored validation when it names this catalog entry's runtime, revision and artifact, else
 * null. The runtime build is not known here: the adapter about to run the ranker compares it with
 * `isDecideValidationCurrent`, which is the full check.
 */
export function decideValidationForCatalogEntry(
  value: unknown,
  entry: Pick<LocalModelCatalogEntry, "runtime" | "revision" | "files">
): DecideValidation | null {
  const parsed = decideValidationSchema.safeParse(value);
  return parsed.success &&
    parsed.data.runtime === entry.runtime &&
    parsed.data.revision === entry.revision &&
    parsed.data.artifactSha256 === rankerCatalogArtifactSha256(entry)
    ? parsed.data
    : null;
}

function ggufFile(entry: Pick<LocalModelCatalogEntry, "files">): RankerArtifactFile {
  const file = entry.files.find((candidate) => candidate.path.toLowerCase().endsWith(".gguf"));
  if (!file) {
    throw new LocalRankerError("errors.localModels.rankerInvalid", "The entry has no GGUF file.");
  }
  return file;
}

// --- smoke ----------------------------------------------------------------------------------------

/** Pass bars of the smoke test (typed configuration). */
export const rankerSmokeConfig = {
  /** Largest distance from the model card's log-odds (bf16 values differ by up to about 1). */
  modelCardTolerance: 1,
  /** Log-odds by which a relevant passage must beat an irrelevant one in each language. */
  minimumRelevanceMargin: 0.5
} as const;

/**
 * Smoke inputs. The model card pair and its log-odds come from the Qwen3-Reranker model card
 * (measured on the MLX bf16 weights by T01). The language pairs are fixed test data.
 */
export const rankerSmokeCases = {
  modelCard: {
    query: "What is the capital of China?",
    documents: [
      "The capital of China is Beijing.",
      "Gravity is a force that attracts two bodies towards each other. It gives weight to physical " +
        "objects and is responsible for the movement of planets around the sun."
    ],
    expectedLogOdds: [7.625, -11.375]
  },
  relevance: [
    {
      language: "en",
      query: "How do vaccines train the immune system?",
      relevant:
        "Vaccines expose the immune system to a harmless antigen, such as an inactivated virus or a " +
        "piece of its protein. B cells respond by producing antibodies and memory cells, so a later " +
        "infection by the real pathogen is recognized and neutralized quickly.",
      irrelevant:
        "The Eiffel Tower was built for the 1889 World's Fair in Paris. Its wrought-iron lattice was " +
        "assembled from about 18,000 parts, and it remained the tallest man-made structure in the " +
        "world until 1930."
    },
    {
      language: "pt-BR",
      query: "Como a fotossíntese transforma luz em energia para as plantas?",
      relevant:
        "Na fotossíntese, os cloroplastos captam a luz solar com a clorofila e usam essa energia para " +
        "converter água e dióxido de carbono em glicose e oxigênio. A glicose produzida abastece o " +
        "crescimento e a respiração da planta.",
      irrelevant:
        "O Campeonato Brasileiro de futebol é disputado por vinte clubes em turno e returno. O time " +
        "com mais pontos ao fim das 38 rodadas é declarado campeão, e os quatro últimos são " +
        "rebaixados para a Série B."
    }
  ]
} as const;

const finite = z.number().finite();

export const rankerSmokeReportSchema = z
  .object({
    passed: z.boolean(),
    modelCard: z
      .object({
        logOdds: z.array(finite).length(2),
        expected: z.array(finite).length(2),
        maxDelta: finite
      })
      .strict(),
    relevance: z
      .array(
        z
          .object({
            language: z.string().min(1).max(16),
            relevant: finite,
            irrelevant: finite,
            margin: finite
          })
          .strict()
      )
      .min(1),
    failures: z.array(z.string().min(1).max(500))
  })
  .strict();
export type RankerSmokeReport = z.infer<typeof rankerSmokeReportSchema>;

/**
 * Runs the smoke test through a ranker. The model card pair always uses the model card's
 * instruction, because its reference values were measured with it; `instruction` replaces it for
 * the language pairs only.
 */
export async function runRankerSmoke(
  rank: (request: RankRequest) => Promise<RankResult>,
  options: { instruction?: string } = {}
): Promise<RankerSmokeReport> {
  const failures: string[] = [];
  const card = rankerSmokeCases.modelCard;
  const cardResult = await rank({
    instruction: qwen3RerankerPrompt.defaultInstruction,
    query: card.query,
    documents: [...card.documents]
  });
  const cardLogOdds = cardResult.logOdds.slice(0, 2);
  const maxDelta = Math.max(
    ...card.expectedLogOdds.map((expected, index) =>
      Math.abs((cardLogOdds[index] ?? Number.NaN) - expected)
    )
  );
  if (!(maxDelta <= rankerSmokeConfig.modelCardTolerance)) {
    failures.push(
      `model card log-odds ${cardLogOdds.map((value) => value.toFixed(3)).join(", ")} deviate by ` +
        `${maxDelta.toFixed(3)} from ${card.expectedLogOdds.join(", ")}`
    );
  }
  const relevance = [];
  for (const testCase of rankerSmokeCases.relevance) {
    const result = await rank({
      instruction: options.instruction ?? qwen3RerankerPrompt.defaultInstruction,
      query: testCase.query,
      documents: [testCase.relevant, testCase.irrelevant]
    });
    const [relevant, irrelevant] = result.logOdds as [number, number];
    const margin = relevant - irrelevant;
    if (!(margin >= rankerSmokeConfig.minimumRelevanceMargin)) {
      failures.push(`${testCase.language}: relevant beats irrelevant by ${margin.toFixed(3)}`);
    }
    relevance.push({ language: testCase.language, relevant, irrelevant, margin });
  }
  return rankerSmokeReportSchema.parse({
    passed: failures.length === 0,
    modelCard: { logOdds: cardLogOdds, expected: [...card.expectedLogOdds], maxDelta },
    relevance,
    failures
  });
}

/** Throws the localized smoke failure unless the report passed. */
export function assertRankerSmokePassed(report: RankerSmokeReport): void {
  if (!report.passed) {
    throw new LocalRankerError(
      "errors.localModels.rankerSmokeFailed",
      report.failures.join("; ") || "The smoke test failed."
    );
  }
}

// --- decide validation record -----------------------------------------------------------------------

/** What a validation is valid for: the install's runtime, revision, artifact and runtime build. */
export interface DecideValidationSubject {
  runtime: RankerRuntime;
  revision: string;
  artifactSha256: string;
  runtimeBuild: string;
}

/** `local_models.metadata.decideValidation`: a ranker passed validation on this exact install. */
export const decideValidationSchema = z
  .object({
    version: z.literal(1),
    runtime: z.enum(["mlx", "gguf"]),
    revision: z.string().min(1).max(200),
    artifactSha256: z.string().regex(sha256Pattern),
    runtimeBuild: z.string().min(1).max(500),
    smoke: rankerSmokeReportSchema.refine((report) => report.passed, {
      message: "A decide validation needs a passing smoke test."
    }),
    /**
     * The score-parity check of the build this validation ran on (D13, R1). Absent on a validation
     * made before the check existed, which counts as `unchecked`.
     */
    parity: rankerParityRecordSchema.optional(),
    validatedAt: z.iso.datetime()
  })
  .strict();
export type DecideValidation = z.infer<typeof decideValidationSchema>;

/**
 * The record of a passed validation; a failed smoke test throws `rankerSmokeFailed` instead. A
 * parity check that did not pass is still recorded: the ranker works on this build but its
 * scores no longer match what a calibration was fitted on.
 */
export function createDecideValidation(
  subject: DecideValidationSubject,
  smoke: RankerSmokeReport,
  validatedAt: Date = new Date(),
  parity?: RankerParityRecord
): DecideValidation {
  assertRankerSmokePassed(smoke);
  return decideValidationSchema.parse({
    version: 1,
    ...subject,
    smoke,
    ...(parity ? { parity } : {}),
    validatedAt: validatedAt.toISOString()
  });
}

/**
 * Whether a stored validation's last parity check failed, so the decider is uncalibrated (D13). A
 * missing or malformed record, or a validation with no parity check, is not a failure.
 */
export function decideValidationParityFailed(value: unknown): boolean {
  const parsed = decideValidationSchema.safeParse(value);
  return parsed.success && parsed.data.parity !== undefined && !parsed.data.parity.passed;
}

/**
 * Whether a stored validation still holds for the install as it is now. A missing or malformed
 * record, another revision, another artifact or another runtime build voids it.
 */
export function isDecideValidationCurrent(
  value: unknown,
  subject: DecideValidationSubject
): boolean {
  const parsed = decideValidationSchema.safeParse(value);
  return (
    parsed.success &&
    parsed.data.runtime === subject.runtime &&
    parsed.data.revision === subject.revision &&
    parsed.data.artifactSha256 === subject.artifactSha256 &&
    parsed.data.runtimeBuild === subject.runtimeBuild
  );
}

// --- helpers ------------------------------------------------------------------------------------------

function headerSupportsRanking(
  fileInfo: Pick<GgufFileInfo, "fullTensorInfo">,
  metadata: Record<string, unknown>
): boolean {
  const tensors = fileInfo.fullTensorInfo ?? [];
  if (
    !tensors.some((tensor) => tensor.name === "cls.weight" || tensor.name === "cls.output.weight")
  )
    return false;
  const tokenizer = record(metadata.tokenizer);
  const ggml = record(tokenizer?.ggml);
  const template = tokenizer?.["chat_template.rerank"];
  return (
    typeof ggml?.eos_token_id === "number" ||
    typeof ggml?.sep_token_id === "number" ||
    (typeof template === "string" &&
      template.includes("{query}") &&
      template.includes("{document}"))
  );
}

async function verifyFile(path: string, file: RankerArtifactFile): Promise<void> {
  const size = await fileSize(path);
  if (size !== file.sizeBytes) {
    throw new LocalRankerError(
      "errors.localModels.sizeMismatch",
      `${file.path}: ${size} bytes, expected ${file.sizeBytes}.`
    );
  }
  if ((await sha256File(path)) !== file.sha256) {
    throw new LocalRankerError("errors.localModels.checksumMismatch", `${file.path} changed.`);
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    return info.size;
  } catch {
    throw new LocalRankerError("errors.localModels.notFound", "A model file is missing.");
  }
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new LocalRankerError("errors.localModels.rankerInvalid", "config.json is missing.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LocalRankerError("errors.localModels.rankerInvalid", "config.json is not JSON.");
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}
