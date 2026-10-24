import { mkdir, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findLocalModelCatalogEntry, localModelSeedDirectories } from "@app/ai";
import { describe, expect, it } from "vitest";

import { UsageError, firstRunModels } from "./config.js";
import {
  SyntheticLocalModelService,
  assertModelsSeeded,
  copyModelsToSeed,
  createFirstRunModels,
  firstRunModelPlan,
  offlineFetch,
  pinnedBytes
} from "./models.js";

describe("the models of a clean install", () => {
  it("installs the MLX ranker where MLX runs and the GGUF one elsewhere, with the GGUF embedder always", () => {
    expect(firstRunModelPlan({ platform: "darwin", arch: "arm64" })).toEqual({
      embedding: firstRunModels.embedding,
      ranker: firstRunModels.rankerMlx,
      rankerRuntime: "mlx"
    });
    for (const machine of [
      { platform: "darwin", arch: "x64" },
      { platform: "win32", arch: "x64" },
      { platform: "linux", arch: "arm64" }
    ])
      expect(firstRunModelPlan(machine)).toMatchObject({
        embedding: firstRunModels.embedding,
        ranker: firstRunModels.rankerGguf,
        rankerRuntime: "gguf"
      });
  });

  it("knows the pinned sizes Q5 names (1,842,171,959 bytes for the two downloads)", () => {
    expect(pinnedBytes(firstRunModels.embedding)).toBe(639_150_592);
    expect(pinnedBytes(firstRunModels.rankerMlx)).toBe(1_203_021_367);
    expect(pinnedBytes(firstRunModels.embedding) + pinnedBytes(firstRunModels.rankerMlx)).toBe(
      1_842_171_959
    );
    expect(() => pinnedBytes("mlx-nothing")).toThrow("no entry");
  });

  it("seeds both models from folders the seed map names", () => {
    expect(localModelSeedDirectories[firstRunModels.embedding]).toBe(
      "qwen3-embedding-0.6b-q8_0-gguf"
    );
    expect(localModelSeedDirectories[firstRunModels.rankerMlx]).toBe("qwen3-reranker-0.6b-mlx");
    expect(localModelSeedDirectories[firstRunModels.rankerGguf]).toBe(
      "qwen3-reranker-0.6b-q8_0-gguf"
    );
  });
});

describe("the preflight of a replay", () => {
  const plan = firstRunModelPlan({ platform: "darwin", arch: "arm64" });

  it("asks the seed folder for both models and names the folder that lacks files", async () => {
    const seed = await mkdtemp(join(tmpdir(), "memora-firstrun-seed-"));
    try {
      let error: unknown;
      try {
        await assertModelsSeeded(plan, seed);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(UsageError);
      const message = (error as Error).message;
      expect(message).toContain(firstRunModels.embedding);
      expect(message).toContain(join(seed, "qwen3-embedding-0.6b-q8_0-gguf"));
      expect(message).toContain("MEMORA_LOCAL_MODEL_SEED_DIR");
    } finally {
      await rm(seed, { recursive: true, force: true });
    }
  });

  it("passes once every pinned file is there at its declared size (the bytes are verified by the install)", async () => {
    const seed = await mkdtemp(join(tmpdir(), "memora-firstrun-seed-"));
    try {
      for (const catalogId of [plan.embedding, plan.ranker]) {
        const entry = findLocalModelCatalogEntry(catalogId)!;
        const folder = join(seed, localModelSeedDirectories[catalogId]!);
        await mkdir(folder, { recursive: true });
        for (const file of entry.files) {
          const path = join(folder, file.path);
          await mkdir(join(path, ".."), { recursive: true });
          // A sparse file of the pinned size: nothing is read from it here.
          await writeFile(path, "");
          await truncate(path, file.sizeBytes);
        }
      }
      await expect(assertModelsSeeded(plan, seed)).resolves.toBeUndefined();
    } finally {
      await rm(seed, { recursive: true, force: true });
    }
  });

  it("lets an error that is not a seed problem through", async () => {
    await expect(
      assertModelsSeeded(plan, "/seed", async () => {
        throw new Error("disk on fire");
      })
    ).rejects.toThrow("disk on fire");
  });

  it("closes the network: a model the seed lacks cannot be downloaded", async () => {
    await expect(offlineFetch("https://huggingface.co/x")).rejects.toThrow("network is closed");
  });
});

describe("the local model service of a run", () => {
  const base = {
    repositoryRoot: "/repo",
    getPool: () => null,
    userDataPath: "/tmp/userData"
  };

  it("builds the real service for a download and for a seeded replay, and the stand-in for the self-test", () => {
    expect(createFirstRunModels({ ...base, mode: "download", seedDir: null })).not.toBeInstanceOf(
      SyntheticLocalModelService
    );
    expect(createFirstRunModels({ ...base, mode: "seed", seedDir: "/seed" })).not.toBeInstanceOf(
      SyntheticLocalModelService
    );
    expect(
      createFirstRunModels({
        ...base,
        mode: "synthetic",
        seedDir: null,
        synthetic: { modelsDirectory: "/tmp/m", installDelayMs: 10, helperPath: "/tmp/h" }
      })
    ).toBeInstanceOf(SyntheticLocalModelService);
  });

  it("refuses a replay with no seed folder and a self-test with no directory", () => {
    expect(() => createFirstRunModels({ ...base, mode: "seed", seedDir: null })).toThrow(
      UsageError
    );
    expect(() => createFirstRunModels({ ...base, mode: "synthetic", seedDir: null })).toThrow(
      "directory"
    );
  });
});

describe("the models a live recording leaves for the replays", () => {
  const plan = firstRunModelPlan({ platform: "darwin", arch: "arm64" });
  /** The catalog entries with files of 12 bytes: the copy checks sizes, so a test needs no gigabytes. */
  const tiny: typeof findLocalModelCatalogEntry = (catalogId) => {
    const entry = findLocalModelCatalogEntry(catalogId);
    return entry && { ...entry, files: entry.files.map((file) => ({ ...file, sizeBytes: 12 })) };
  };

  /** A scratch profile that holds the downloaded files at the size the lookup declares. */
  async function downloaded(userData: string, ids: string[]) {
    for (const catalogId of ids) {
      for (const file of tiny(catalogId)!.files) {
        const path = join(userData, "local-models", catalogId, file.path);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "twelve bytes");
      }
    }
  }

  it("copies each downloaded file into the seed folder it belongs to, once", async () => {
    const work = await mkdtemp(join(tmpdir(), "memora-firstrun-copy-"));
    try {
      const userData = join(work, "userData");
      const seed = join(work, "seed");
      await downloaded(userData, [plan.embedding, plan.ranker]);
      const first = await copyModelsToSeed(plan, userData, seed, tiny);
      expect(first.map((outcome) => outcome.catalogId)).toEqual([plan.embedding, plan.ranker]);
      expect(first[0]).toMatchObject({ copied: ["Qwen3-Embedding-0.6B-Q8_0.gguf"], present: [] });
      expect(first[1]!.copied).toEqual(tiny(plan.ranker)!.files.map((file) => file.path));
      const embedder = join(
        seed,
        "qwen3-embedding-0.6b-q8_0-gguf",
        "Qwen3-Embedding-0.6B-Q8_0.gguf"
      );
      expect((await stat(embedder)).size).toBe(12);
      // A second copy changes nothing.
      const second = await copyModelsToSeed(plan, userData, seed, tiny);
      expect(second.every((outcome) => outcome.copied.length === 0)).toBe(true);
      expect(second[0]!.present).toEqual(["Qwen3-Embedding-0.6B-Q8_0.gguf"]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("refuses a model that was not downloaded at its pinned size, after the ones that were", async () => {
    const work = await mkdtemp(join(tmpdir(), "memora-firstrun-copy-"));
    try {
      const userData = join(work, "userData");
      await downloaded(userData, [plan.embedding]);
      await expect(copyModelsToSeed(plan, userData, join(work, "seed"), tiny)).rejects.toThrow(
        /was not downloaded at its pinned size/u
      );
      // The embedder was whole and is in the seed; the ranker was not and is not.
      await expect(
        stat(join(work, "seed", "qwen3-embedding-0.6b-q8_0-gguf"))
      ).resolves.toBeDefined();
      await expect(stat(join(work, "seed", "qwen3-reranker-0.6b-mlx"))).rejects.toThrow();
      // A file of another size is not a download that finished.
      await writeFile(
        join(userData, "local-models", plan.embedding, "Qwen3-Embedding-0.6B-Q8_0.gguf"),
        "short"
      );
      await expect(copyModelsToSeed(plan, userData, join(work, "seed2"), tiny)).rejects.toThrow(
        /Qwen3-Embedding-0.6B-Q8_0.gguf was not downloaded/u
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
