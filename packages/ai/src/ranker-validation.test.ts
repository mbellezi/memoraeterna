import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { qwen3RerankerPrompt, type RankRequest, type RankResult } from "./ranker-input.js";
import {
  assertRankerSmokePassed,
  checkGgufRankerFacts,
  createDecideValidation,
  decideValidationSchema,
  ggufRankerFacts,
  isDecideValidationCurrent,
  rankerSmokeCases,
  readGgufRankerFacts,
  runRankerSmoke,
  validateGgufRankerArtifact,
  validateMlxRankerArtifact,
  type RankerArtifactFile
} from "./ranker-validation.js";

const fixtures = join(import.meta.dirname, "test-fixtures", "rankers");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memora-ranker-validation-"));
  roots.push(root);
  return root;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function headerFixture(name: string) {
  return JSON.parse(await readFile(join(fixtures, name), "utf8")) as Parameters<
    typeof ggufRankerFacts
  >[0];
}

/** An MLX ranker directory: the real Qwen3-Reranker `config.json` and stand-in weights. */
async function mlxDirectory(config?: string): Promise<{
  directory: string;
  files: RankerArtifactFile[];
}> {
  const directory = await temporaryDirectory();
  const configText = config ?? (await readFile(join(fixtures, "qwen3-reranker-0.6b.config.json")));
  const weights = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  await writeFile(join(directory, "config.json"), configText);
  await writeFile(join(directory, "model.safetensors"), weights);
  const configBytes = await readFile(join(directory, "config.json"));
  return {
    directory,
    files: [
      { path: "config.json", sizeBytes: configBytes.length, sha256: sha256(configBytes) },
      { path: "model.safetensors", sizeBytes: weights.length, sha256: sha256(weights) }
    ]
  };
}

/** A minimal GGUF v3 file: a header with metadata and tensor infos, no tensor data. */
function ggufFile(options: {
  architecture: string;
  poolingType?: number;
  labels?: string[];
  tensors?: string[];
}): Buffer {
  const u32 = (value: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    return buffer;
  };
  const u64 = (value: number) => {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(BigInt(value));
    return buffer;
  };
  const text = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([u64(bytes.length), bytes]);
  };
  const entries = [
    Buffer.concat([text("general.architecture"), u32(8), text(options.architecture)]),
    Buffer.concat([text("general.alignment"), u32(4), u32(32)]),
    Buffer.concat([text("tokenizer.ggml.model"), u32(8), text("gpt2")]),
    Buffer.concat([text("tokenizer.ggml.eos_token_id"), u32(4), u32(151_645)])
  ];
  if (options.poolingType !== undefined) {
    entries.push(
      Buffer.concat([
        text(`${options.architecture}.pooling_type`),
        u32(4),
        u32(options.poolingType)
      ])
    );
  }
  if (options.labels) {
    entries.push(
      Buffer.concat([
        text(`${options.architecture}.classifier.output_labels`),
        u32(9),
        u32(8),
        u64(options.labels.length),
        ...options.labels.map(text)
      ])
    );
  }
  const tensors = (options.tensors ?? ["output_norm.weight", "cls.output.weight"]).map((name) =>
    Buffer.concat([text(name), u32(1), u64(4), u32(0), u64(0)])
  );
  return Buffer.concat([
    Buffer.from("GGUF"),
    u32(3),
    u64(tensors.length),
    u64(entries.length),
    ...entries,
    ...tensors,
    Buffer.alloc(64)
  ]);
}

describe("MLX ranker artifact validation", () => {
  it("accepts the real Qwen3-Reranker config with matching checksums", async () => {
    const { directory, files } = await mlxDirectory();

    const report = await validateMlxRankerArtifact({ directory, files });

    expect(report).toMatchObject({
      runtime: "mlx",
      architecture: "Qwen3ForCausalLM",
      sizeBytes: files[0]!.sizeBytes + 8
    });
    expect(report.artifactSha256).toBe(
      sha256(files.map((file) => `${file.path}:${file.sizeBytes}:${file.sha256}`).join("\n"))
    );
  });

  it("refuses another architecture, missing declarations and missing config", async () => {
    const gemma = await mlxDirectory(JSON.stringify({ architectures: ["Gemma3ForCausalLM"] }));
    await expect(validateMlxRankerArtifact(gemma)).rejects.toThrow(
      "errors.localModels.rankerInvalid"
    );
    const two = await mlxDirectory(
      JSON.stringify({ architectures: ["Qwen3ForCausalLM", "Qwen3ForSequenceClassification"] })
    );
    await expect(validateMlxRankerArtifact(two)).rejects.toThrow(
      "errors.localModels.rankerInvalid"
    );
    const { directory, files } = await mlxDirectory();
    await expect(
      validateMlxRankerArtifact({ directory, files: files.filter((f) => f.path !== "config.json") })
    ).rejects.toThrow("errors.localModels.rankerInvalid");
    await expect(
      validateMlxRankerArtifact({
        directory,
        files: files.filter((file) => file.path === "config.json")
      })
    ).rejects.toThrow("errors.localModels.rankerInvalid");
    await rm(join(directory, "config.json"));
    await expect(validateMlxRankerArtifact({ directory, files })).rejects.toThrow(
      "errors.localModels.rankerInvalid"
    );
  });

  it("refuses changed, resized, missing and unsafe files", async () => {
    const { directory, files } = await mlxDirectory();
    await writeFile(join(directory, "model.safetensors"), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9]));
    await expect(validateMlxRankerArtifact({ directory, files })).rejects.toThrow(
      "errors.localModels.checksumMismatch"
    );
    await writeFile(join(directory, "model.safetensors"), new Uint8Array([1, 2, 3]));
    await expect(validateMlxRankerArtifact({ directory, files })).rejects.toThrow(
      "errors.localModels.sizeMismatch"
    );
    await rm(join(directory, "model.safetensors"));
    await expect(validateMlxRankerArtifact({ directory, files })).rejects.toThrow(
      "errors.localModels.notFound"
    );
    const intact = await mlxDirectory();
    await expect(
      validateMlxRankerArtifact({
        directory: intact.directory,
        files: [
          { path: "../escape.safetensors", sizeBytes: 1, sha256: "a".repeat(64) },
          ...intact.files
        ]
      })
    ).rejects.toThrow("errors.localModels.unsafePath");
  });
});

describe("GGUF ranker header validation", () => {
  it("accepts the real Qwen3-Reranker header and rejects the embedding and bge headers", async () => {
    const reranker = ggufRankerFacts(
      await headerFixture("qwen3-reranker-0.6b-q8_0.gguf-header.json")
    );
    expect(reranker).toEqual({
      architecture: "qwen3",
      poolingType: 4,
      outputLabels: ["yes", "no"],
      supportsRanking: true
    });
    expect(() => checkGgufRankerFacts(reranker)).not.toThrow();

    const embedding = ggufRankerFacts(
      await headerFixture("qwen3-embedding-0.6b-q8_0.gguf-header.json")
    );
    expect(embedding.supportsRanking).toBe(false);
    expect(() => checkGgufRankerFacts(embedding)).toThrow("errors.localModels.rankerInvalid");
    try {
      checkGgufRankerFacts(embedding);
    } catch (error) {
      expect((error as { detail: string }).detail).toMatch(/pooling type 3.*no ranking head/u);
    }

    const bge = ggufRankerFacts(await headerFixture("bge-reranker-v2-m3-q8_0.gguf-header.json"));
    expect(bge.supportsRanking).toBe(true);
    expect(() => checkGgufRankerFacts(bge)).toThrow("errors.localModels.rankerInvalid");
  });

  it("trusts the loaded runtime's ranking answer over the header heuristic", async () => {
    const header = await headerFixture("qwen3-reranker-0.6b-q8_0.gguf-header.json");
    expect(() => checkGgufRankerFacts(ggufRankerFacts(header, false))).toThrow(
      "errors.localModels.rankerInvalid"
    );
  });

  it("reads a GGUF header from disk and checks size and checksum", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "ranker.gguf");
    const bytes = ggufFile({ architecture: "qwen3", poolingType: 4, labels: ["yes", "no"] });
    await writeFile(path, bytes);

    await expect(readGgufRankerFacts(path)).resolves.toEqual({
      architecture: "qwen3",
      poolingType: 4,
      outputLabels: ["yes", "no"],
      supportsRanking: true
    });
    await expect(
      validateGgufRankerArtifact({ path, sizeBytes: bytes.length, sha256: sha256(bytes) })
    ).resolves.toEqual({
      runtime: "gguf",
      artifactSha256: sha256(bytes),
      sizeBytes: bytes.length,
      architecture: "qwen3"
    });

    const changed = Buffer.from(bytes);
    changed[changed.length - 1] = 1;
    await writeFile(path, changed);
    await expect(
      validateGgufRankerArtifact({ path, sizeBytes: bytes.length, sha256: sha256(bytes) })
    ).rejects.toThrow("errors.localModels.checksumMismatch");
    await expect(validateGgufRankerArtifact({ path, sizeBytes: bytes.length + 1 })).rejects.toThrow(
      "errors.localModels.sizeMismatch"
    );
  });

  it("refuses swapped labels, other pooling, a missing head, a non-GGUF file and a missing file", async () => {
    const directory = await temporaryDirectory();
    const cases = [
      ggufFile({ architecture: "qwen3", poolingType: 4, labels: ["no", "yes"] }),
      ggufFile({ architecture: "qwen3", poolingType: 3, labels: ["yes", "no"] }),
      ggufFile({
        architecture: "qwen3",
        poolingType: 4,
        labels: ["yes", "no"],
        tensors: ["output_norm.weight"]
      }),
      ggufFile({ architecture: "llama", poolingType: 4, labels: ["yes", "no"] }),
      Buffer.from("not a gguf file at all, just text")
    ];
    for (const [index, bytes] of cases.entries()) {
      const path = join(directory, `case-${index}.gguf`);
      await writeFile(path, bytes);
      await expect(validateGgufRankerArtifact({ path })).rejects.toThrow(
        "errors.localModels.rankerInvalid"
      );
    }
    await expect(
      validateGgufRankerArtifact({ path: join(directory, "none.gguf") })
    ).rejects.toThrow("errors.localModels.notFound");
    await mkdir(join(directory, "folder.gguf"));
    await expect(
      validateGgufRankerArtifact({ path: join(directory, "folder.gguf") })
    ).rejects.toThrow("errors.localModels.notFound");
  });
});

/** A fake ranker that answers the smoke inputs with fixed log-odds. */
function fakeRank(values: { card?: [number, number]; en?: number; pt?: number } = {}) {
  const requests: RankRequest[] = [];
  const rank = async (request: RankRequest): Promise<RankResult> => {
    requests.push(request);
    const pair: [number, number] =
      request.query === rankerSmokeCases.modelCard.query
        ? (values.card ?? [7.5, -11.25])
        : [request.query.startsWith("Como") ? (values.pt ?? 4) : (values.en ?? 5), -6];
    return {
      logOdds: pair,
      scores: pair.map((value) => 1 / (1 + Math.exp(-value))),
      tokenCounts: [80, 90],
      truncated: [false, false]
    };
  };
  return { rank, requests };
}

describe("ranker smoke test", () => {
  it("passes on the model card pair and both language pairs", async () => {
    const { rank, requests } = fakeRank();
    const report = await runRankerSmoke(rank, { instruction: "Is the passage about the query?" });

    expect(report).toMatchObject({
      passed: true,
      modelCard: { logOdds: [7.5, -11.25], expected: [7.625, -11.375], maxDelta: 0.125 },
      failures: []
    });
    expect(report.relevance.map((entry) => [entry.language, entry.margin])).toEqual([
      ["en", 11],
      ["pt-BR", 10]
    ]);
    expect(requests.map((request) => request.instruction)).toEqual([
      qwen3RerankerPrompt.defaultInstruction,
      "Is the passage about the query?",
      "Is the passage about the query?"
    ]);
    expect(() => assertRankerSmokePassed(report)).not.toThrow();
  });

  it("fails visibly when the model card drifts or a language pair does not separate", async () => {
    const drift = await runRankerSmoke(fakeRank({ card: [5, -11.375] }).rank);
    expect(drift.passed).toBe(false);
    expect(drift.failures[0]).toMatch(/model card/u);
    expect(() => assertRankerSmokePassed(drift)).toThrow("errors.localModels.rankerSmokeFailed");

    const portuguese = await runRankerSmoke(fakeRank({ pt: -5.8 }).rank);
    expect(portuguese.passed).toBe(false);
    expect(portuguese.failures).toEqual(["pt-BR: relevant beats irrelevant by 0.200"]);
  });
});

describe("decide validation record", () => {
  const subject = {
    runtime: "mlx" as const,
    revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
    artifactSha256: "a".repeat(64),
    runtimeBuild: `memora-mlx-helper@sha256:${"b".repeat(64)}`
  };

  it("is recorded only for a passed smoke test and voided by any change of the install", async () => {
    const smoke = await runRankerSmoke(fakeRank().rank);
    const validation = createDecideValidation(subject, smoke, new Date("2026-10-15T12:00:00Z"));

    expect(decideValidationSchema.parse(validation)).toEqual(validation);
    expect(validation).toMatchObject({ version: 1, validatedAt: "2026-10-15T12:00:00.000Z" });
    expect(isDecideValidationCurrent(validation, subject)).toBe(true);
    expect(isDecideValidationCurrent(validation, { ...subject, revision: "c".repeat(40) })).toBe(
      false
    );
    expect(
      isDecideValidationCurrent(validation, { ...subject, artifactSha256: "d".repeat(64) })
    ).toBe(false);
    expect(isDecideValidationCurrent(validation, { ...subject, runtimeBuild: "other" })).toBe(
      false
    );
    expect(isDecideValidationCurrent(validation, { ...subject, runtime: "gguf" })).toBe(false);
    expect(isDecideValidationCurrent(undefined, subject)).toBe(false);
    expect(isDecideValidationCurrent({ ...validation, smoke: { passed: true } }, subject)).toBe(
      false
    );

    const failed = await runRankerSmoke(fakeRank({ en: -5.9 }).rank);
    expect(() => createDecideValidation(subject, failed)).toThrow(
      "errors.localModels.rankerSmokeFailed"
    );
    expect(isDecideValidationCurrent({ ...validation, smoke: failed }, subject)).toBe(false);
  });
});
