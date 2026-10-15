import { createHash } from "node:crypto";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localModelCatalog, localModelManifestHash } from "./local-model-catalog.js";
import { isDedicatedRanker } from "./parameter-capabilities.js";
import { qwen3RerankerPrompt, type RankRequest, type RankResult } from "./ranker-input.js";
import {
  createDecideValidation,
  decideValidationForCatalogEntry,
  isRankerCatalogEntry,
  rankerCatalogArtifactSha256,
  runRankerSmoke,
  validateCatalogRankerArtifact
} from "./ranker-validation.js";

const mlxReranker = localModelCatalog.find((entry) => entry.id === "mlx-qwen3-reranker-0.6b")!;
const ggufReranker = localModelCatalog.find(
  (entry) => entry.id === "gguf-qwen3-reranker-0.6b-q8-0"
)!;
const mib = 1024 ** 2;

describe("Qwen3-Reranker catalog entries", () => {
  it("pin the official MLX weights and the ggml-org GGUF by revision, size and SHA-256", () => {
    expect(mlxReranker).toMatchObject({
      repository: "Qwen/Qwen3-Reranker-0.6B",
      revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
      runtime: "mlx",
      format: "safetensors",
      quantization: "bf16",
      license: "Apache-2.0",
      requiresLicenseAcceptance: false
    });
    expect(
      mlxReranker.files.map((file) => [file.path, file.sizeBytes, file.sha256.slice(0, 8)])
    ).toEqual([
      ["config.json", 727, "d479c427"],
      ["model.safetensors", 1_191_588_280, "27cd75a4"],
      ["tokenizer.json", 11_422_654, "aeb13307"],
      ["tokenizer_config.json", 9_706, "253153d0"]
    ]);
    expect(ggufReranker).toMatchObject({
      repository: "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF",
      revision: "a02f48bb4f057028298c21fa033da2b30d7742d5",
      runtime: "gguf",
      format: "gguf",
      quantization: "Q8_0",
      license: "Apache-2.0",
      files: [
        {
          path: "qwen3-reranker-0.6b-q8_0.gguf",
          sizeBytes: 639_153_184,
          sha256: "22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48"
        }
      ]
    });
  });

  it("are dedicated rankers without generation, embedding or parameters", () => {
    for (const entry of [mlxReranker, ggufReranker]) {
      expect(entry.capabilities).toEqual(["reranking", "offline", "local-files"]);
      expect(isDedicatedRanker(entry.capabilities)).toBe(true);
      expect(isRankerCatalogEntry(entry)).toBe(true);
      expect(entry.parameterCapabilities).toEqual({});
      expect(entry.defaultParameters).toEqual({});
    }
    expect(localModelCatalog.filter(isRankerCatalogEntry).map((entry) => entry.id)).toEqual([
      "mlx-qwen3-reranker-0.6b",
      "gguf-qwen3-reranker-0.6b-q8-0"
    ]);
  });

  it("require at least 1.5 times the peak resident memory measured during scoring", () => {
    // Measured on an M4 Max with the real artifacts (T11): the MLX helper peaked at 1,294 MB during
    // `score`; the in-process GGUF ranker peaked at 1,562 MB during the smoke test.
    expect(mlxReranker.minimumMemoryBytes).toBeGreaterThanOrEqual(1.5 * 1_294 * mib);
    expect(ggufReranker.minimumMemoryBytes).toBeGreaterThanOrEqual(1.5 * 1_562 * mib);
    for (const entry of [mlxReranker, ggufReranker]) {
      expect(entry.recommendedMemoryBytes).toBeGreaterThan(entry.minimumMemoryBytes);
    }
  });

  it("pins only the MLX files the helper loads", () => {
    expect(mlxReranker.files.map((file) => file.path)).toEqual([
      "config.json",
      "model.safetensors",
      "tokenizer.json",
      "tokenizer_config.json"
    ]);
  });
});

describe("validation of an installed catalog ranker", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-ranker-catalog-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const digest = (content: string) => createHash("sha256").update(content).digest("hex");

  async function installFakeMlxRanker(options: { architecture?: string } = {}) {
    const files = {
      "config.json": JSON.stringify({
        architectures: [options.architecture ?? "Qwen3ForCausalLM"]
      }),
      "model.safetensors": "weights-weights-weights",
      "tokenizer.json": "{}"
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(directory, name), content);
    }
    return {
      runtime: "mlx" as const,
      files: Object.entries(files).map(([path, content]) => ({
        path,
        sizeBytes: Buffer.byteLength(content),
        sha256: digest(content)
      }))
    };
  }

  it("reports the manifest hash an MLX install is pinned by", async () => {
    const entry = await installFakeMlxRanker();

    const report = await validateCatalogRankerArtifact(entry, directory);

    expect(report).toMatchObject({ runtime: "mlx", architecture: "Qwen3ForCausalLM" });
    expect(report.artifactSha256).toBe(localModelManifestHash(entry));
    expect(report.artifactSha256).toBe(rankerCatalogArtifactSha256(entry));
  });

  it("fails visibly, with a localization key, when one byte of the weights changed", async () => {
    const entry = await installFakeMlxRanker();
    await writeFile(join(directory, "model.safetensors"), "weights-weights-weightz");

    await expect(validateCatalogRankerArtifact(entry, directory)).rejects.toMatchObject({
      message: "errors.localModels.checksumMismatch"
    });
  });

  it("rejects a truncated file, a missing file and another architecture", async () => {
    const entry = await installFakeMlxRanker();
    await truncate(join(directory, "model.safetensors"), 4);
    await expect(validateCatalogRankerArtifact(entry, directory)).rejects.toMatchObject({
      message: "errors.localModels.sizeMismatch"
    });
    await rm(join(directory, "tokenizer.json"));
    await writeFile(join(directory, "model.safetensors"), "weights-weights-weights");
    await expect(validateCatalogRankerArtifact(entry, directory)).rejects.toMatchObject({
      message: "errors.localModels.notFound"
    });

    const other = await installFakeMlxRanker({ architecture: "Qwen3ForSequenceClassification" });
    await expect(validateCatalogRankerArtifact(other, directory)).rejects.toMatchObject({
      message: "errors.localModels.rankerInvalid"
    });
  });

  it("reports the file hash a GGUF install is pinned by, and a missing GGUF as not found", async () => {
    expect(rankerCatalogArtifactSha256(ggufReranker)).toBe(ggufReranker.files[0]!.sha256);
    await expect(validateCatalogRankerArtifact(ggufReranker, directory)).rejects.toMatchObject({
      message: "errors.localModels.notFound"
    });
  });
});

describe("a stored decide validation", () => {
  async function passingValidation(entry: typeof mlxReranker) {
    const rank = async (request: RankRequest): Promise<RankResult> => {
      const logOdds = request.documents.map((_, index) =>
        request.instruction === qwen3RerankerPrompt.defaultInstruction &&
        request.query.startsWith("What is the capital")
          ? [7.625, -11.375][index]!
          : index === 0
            ? 8
            : -8
      );
      return {
        logOdds,
        scores: logOdds.map((value) => 1 / (1 + Math.exp(-value))),
        tokenCounts: logOdds.map(() => 100),
        truncated: logOdds.map(() => false)
      };
    };
    const smoke = await runRankerSmoke(rank);
    return createDecideValidation(
      {
        runtime: entry.runtime,
        revision: entry.revision,
        artifactSha256: rankerCatalogArtifactSha256(entry),
        runtimeBuild: "memora-mlx-helper@sha256:test"
      },
      smoke
    );
  }

  it("names the catalog entry's runtime, revision and artifact", async () => {
    const validation = await passingValidation(mlxReranker);

    expect(decideValidationForCatalogEntry(validation, mlxReranker)).toEqual(validation);
  });

  it("does not hold for another revision, artifact, runtime or a malformed record", async () => {
    const validation = await passingValidation(mlxReranker);

    expect(
      decideValidationForCatalogEntry(validation, { ...mlxReranker, revision: "f".repeat(40) })
    ).toBeNull();
    expect(
      decideValidationForCatalogEntry(validation, {
        ...mlxReranker,
        files: mlxReranker.files.map((file, index) =>
          index === 1 ? { ...file, sha256: "e".repeat(64) } : file
        )
      })
    ).toBeNull();
    expect(decideValidationForCatalogEntry(validation, ggufReranker)).toBeNull();
    expect(decideValidationForCatalogEntry({ ...validation, version: 2 }, mlxReranker)).toBeNull();
    expect(decideValidationForCatalogEntry(undefined, mlxReranker)).toBeNull();
    expect(decideValidationForCatalogEntry("validated", mlxReranker)).toBeNull();
  });
});
