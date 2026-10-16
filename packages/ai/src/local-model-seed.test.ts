import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertLocalModelSeeded,
  downloadLocalModel,
  localModelSeedDirectories,
  LocalModelSeedError,
  resolveLocalModelSeedRoot
} from "./local-model-downloader.js";
import {
  localModelCatalog,
  localModelCatalogEntrySchema,
  type LocalModelCatalogEntry
} from "./local-model-catalog.js";

const digest = (content: string) => createHash("sha256").update(content).digest("hex");

describe("the DEV model seed folder", () => {
  it("is off unless MEMORA_LOCAL_MODEL_SEED_DIR names a folder", () => {
    const options = { isPackaged: false, baseDirectory: "/work" };
    expect(resolveLocalModelSeedRoot({}, options)).toBeNull();
    expect(resolveLocalModelSeedRoot({ MEMORA_LOCAL_MODEL_SEED_DIR: "  " }, options)).toBeNull();
  });

  it("resolves a relative folder against the workspace and keeps an absolute one", () => {
    const options = { isPackaged: false, baseDirectory: "/work/memora" };
    expect(
      resolveLocalModelSeedRoot({ MEMORA_LOCAL_MODEL_SEED_DIR: ".cache/models" }, options)
    ).toBe(resolve("/work/memora", ".cache/models"));
    expect(
      resolveLocalModelSeedRoot({ MEMORA_LOCAL_MODEL_SEED_DIR: "/data/models" }, options)
    ).toBe("/data/models");
  });

  it("is refused in a packaged build", () => {
    expect(() =>
      resolveLocalModelSeedRoot(
        { MEMORA_LOCAL_MODEL_SEED_DIR: "/data/models" },
        { isPackaged: true, baseDirectory: "/work" }
      )
    ).toThrow(LocalModelSeedError);
    // No variable, nothing to refuse.
    expect(resolveLocalModelSeedRoot({}, { isPackaged: true, baseDirectory: "/work" })).toBeNull();
  });

  it("maps only catalog entries to seed folders", () => {
    const ids = new Set(localModelCatalog.map((entry) => entry.id));
    for (const id of Object.keys(localModelSeedDirectories)) expect(ids.has(id)).toBe(true);
  });
});

describe("downloading with a seed folder", () => {
  let work: string;
  let seedRoot: string;
  let destination: string;
  const files = {
    "config.json": '{"architectures":["Qwen3ForCausalLM"]}',
    "model.safetensors": "weights-weights-weights"
  };

  /** A catalog entry that the seed map knows, small enough to build in a test. */
  function entry(): LocalModelCatalogEntry {
    const base = localModelCatalog.find((candidate) => candidate.id === "mlx-qwen3-reranker-0.6b")!;
    return localModelCatalogEntrySchema.parse({
      ...base,
      files: Object.entries(files).map(([path, content]) => ({
        path,
        sizeBytes: Buffer.byteLength(content),
        sha256: digest(content)
      }))
    });
  }

  async function seedFolder(contents: Record<string, string>) {
    const folder = join(seedRoot, localModelSeedDirectories["mlx-qwen3-reranker-0.6b"]!);
    await mkdir(folder, { recursive: true });
    for (const [name, content] of Object.entries(contents)) {
      await writeFile(join(folder, name), content);
    }
  }

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "memora-model-seed-"));
    seedRoot = join(work, "seed");
    destination = join(work, "models");
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("copies the pinned files from the seed without the network and reports progress", async () => {
    await seedFolder(files);
    const fetchSpy = vi.fn(async () => {
      throw new Error("the network must not be used");
    });
    const progress: number[] = [];

    const result = await downloadLocalModel({
      entry: entry(),
      destinationRoot: destination,
      seedRoot,
      fetch: fetchSpy as unknown as typeof fetch,
      minFreeBytes: 0,
      onProgress: (event) => {
        progress.push(event.downloadedBytes);
      }
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    for (const [name, content] of Object.entries(files)) {
      expect(await readFile(join(result.modelPath, name), "utf8")).toBe(content);
    }
    expect(progress.at(-1)).toBe(result.sizeBytes);
    // The seed is copied, never moved, and no partial file is left behind.
    expect(await readFile(join(seedRoot, "qwen3-reranker-0.6b-mlx", "config.json"), "utf8")).toBe(
      files["config.json"]
    );
    await expect(stat(join(result.modelPath, "config.json.partial"))).rejects.toThrow();
  });

  it("refuses a seeded file that differs from its pin by one byte, never falling back to the network", async () => {
    await seedFolder({ ...files, "model.safetensors": "weights-weights-weightz" });
    const fetchSpy = vi.fn();

    await expect(
      downloadLocalModel({
        entry: entry(),
        destinationRoot: destination,
        seedRoot,
        fetch: fetchSpy as unknown as typeof fetch,
        minFreeBytes: 0
      })
    ).rejects.toThrow("errors.localModels.checksumMismatch");

    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(
      stat(join(destination, "mlx-qwen3-reranker-0.6b", "model.safetensors"))
    ).rejects.toThrow();
  });

  it("downloads a file the seed does not have, and everything when no seed is set", async () => {
    await seedFolder({ "config.json": files["config.json"] });
    const requested: string[] = [];
    const fetchStub = async (url: string | URL | Request) => {
      const text = String(url);
      requested.push(text.slice(text.lastIndexOf("/") + 1));
      const content = text.endsWith("model.safetensors")
        ? files["model.safetensors"]
        : files["config.json"];
      return new Response(content, { status: 200 });
    };

    await downloadLocalModel({
      entry: entry(),
      destinationRoot: destination,
      seedRoot,
      fetch: fetchStub as unknown as typeof fetch,
      minFreeBytes: 0
    });
    expect(requested).toEqual(["model.safetensors"]);

    requested.length = 0;
    await rm(destination, { recursive: true, force: true });
    await downloadLocalModel({
      entry: entry(),
      destinationRoot: destination,
      fetch: fetchStub as unknown as typeof fetch,
      minFreeBytes: 0
    });
    expect(requested).toEqual(["config.json", "model.safetensors"]);
  });

  it("ignores the seed for entries without a seed folder", async () => {
    const other = localModelCatalogEntrySchema.parse({
      ...entry(),
      id: "mlx-not-seeded",
      files: [
        {
          path: "config.json",
          sizeBytes: Buffer.byteLength(files["config.json"]),
          sha256: digest(files["config.json"])
        }
      ]
    });
    await seedFolder(files);
    const fetchStub = vi.fn(async () => new Response(files["config.json"], { status: 200 }));

    await downloadLocalModel({
      entry: other,
      destinationRoot: destination,
      seedRoot,
      fetch: fetchStub as unknown as typeof fetch,
      minFreeBytes: 0
    });

    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("checking that the seed folder holds a whole model", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "memora-model-seed-check-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  const small = (id: string, contents: Record<string, string>) => ({
    id,
    files: Object.entries(contents).map(([path, content]) => ({
      path,
      sizeBytes: Buffer.byteLength(content),
      sha256: digest(content)
    }))
  });

  it("passes when every pinned file is there at its declared size", async () => {
    const files = { "config.json": "{}", "model.safetensors": "weights" };
    const folder = join(work, localModelSeedDirectories["mlx-qwen3-reranker-0.6b"]!);
    await mkdir(folder, { recursive: true });
    for (const [name, content] of Object.entries(files))
      await writeFile(join(folder, name), content);

    await expect(
      assertLocalModelSeeded(small("mlx-qwen3-reranker-0.6b", files), work)
    ).resolves.toBeUndefined();
  });

  it("refuses a missing file and a file of another size, so nothing is fetched", async () => {
    const files = { "config.json": "{}", "model.safetensors": "weights" };
    const folder = join(work, localModelSeedDirectories["mlx-qwen3-reranker-0.6b"]!);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "config.json"), "{}");

    const missing = assertLocalModelSeeded(small("mlx-qwen3-reranker-0.6b", files), work);
    await expect(missing).rejects.toMatchObject({ code: "seed_incomplete" });
    await expect(missing).rejects.toThrow("model.safetensors is missing from the seed folder");

    await writeFile(join(folder, "model.safetensors"), "shorter");
    await writeFile(join(folder, "config.json"), "{ }");
    await expect(
      assertLocalModelSeeded(small("mlx-qwen3-reranker-0.6b", files), work)
    ).rejects.toMatchObject({ code: "seed_incomplete" });
  });

  it("refuses an entry that has no seed folder", async () => {
    await expect(
      assertLocalModelSeeded(small("mlx-gemma-4-e4b-it-4bit", { "config.json": "{}" }), work)
    ).rejects.toMatchObject({ code: "not_seedable" });
  });
});
