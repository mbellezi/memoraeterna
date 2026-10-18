import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RouteSpecSchema, parseE2eArgs, recordedRoute } from "./config.js";
import type { E2eConfig } from "./config.js";
import { sharedElectronStub } from "./electron-stub.js";
import { runTopicsE2e } from "./run.js";

// The services import Electron for its secure storage and dialogs; the harness runs without it.
vi.mock("electron", async () => {
  const { sharedElectronStub: stub } = await import("./electron-stub.js");
  return { ...stub().module, default: stub().module };
});

/**
 * The replay of gate R (F3 D41): a copy of `e2e-plos` without its matching entries, run with
 * `MEMORA_AI_CASSETTE_LOCAL_MISSES=live`. A miss on the local writer then runs on the real model, so the
 * replay must be told where the models are, and says so before it creates a workspace or a database.
 */
describe("the E6 replay with live local misses", () => {
  let root = "";
  let config: E2eConfig;

  const parse = (...extra: string[]): E2eConfig => {
    const parsed = parseE2eArgs(
      [
        "--workspace-root",
        root,
        "--cassette-dir",
        join(root, ".cache", "cassette"),
        "--work-dir",
        join(root, "scratch"),
        ...extra
      ],
      { repositoryRoot: root }
    );
    if (parsed === "help") throw new Error("help");
    return parsed;
  };
  const run = (env: Record<string, string>) =>
    runTopicsE2e(config, { electron: sharedElectronStub(), env });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memora-e2e-paths-"));
    const cassette = join(root, ".cache", "cassette");
    await mkdir(join(cassette, "entries"), { recursive: true });
    await writeFile(
      join(cassette, "cassette.json"),
      JSON.stringify({
        format: "memora-ai-cassette",
        version: 1,
        createdAt: "2026-10-17T00:00:00.000Z"
      })
    );
    const recorded = recordedRoute(
      RouteSpecSchema.parse({
        writer: { kind: "local", catalogId: "mlx-qwen3.5-9b-4bit", path: "/models/writer" },
        embedding: { path: "/models/embedding.gguf" }
      }),
      {
        contentLanguage: "pt-BR",
        source: "plos-one-murre-dros-2015",
        notes: 76,
        topics: 14,
        recordedAt: new Date("2026-10-17T02:22:35.068Z")
      }
    );
    await writeFile(join(cassette, "e2e-route.json"), JSON.stringify(recorded));
    config = parse();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("asks for the real models before it creates anything", async () => {
    await expect(run({ MEMORA_AI_CASSETTE_LOCAL_MISSES: "live" })).rejects.toThrow(
      /pass --embedding-gguf <installed embedding model>/
    );
    expect(existsSync(join(root, "scratch"))).toBe(false);
  });

  it("refuses model paths when the replay fails on a miss", async () => {
    const withPaths = parse("--writer-path", root, "--embedding-gguf", join(root, "e.gguf"));
    await expect(
      runTopicsE2e(withPaths, { electron: sharedElectronStub(), env: {} })
    ).rejects.toThrow(/set MEMORA_AI_CASSETTE_LOCAL_MISSES=live/);
    expect(existsSync(join(root, "scratch"))).toBe(false);
  });

  it("refuses a model path that does not exist instead of making an empty file there", async () => {
    const missing = join(root, "models", "writer");
    config = parse("--writer-path", missing, "--embedding-gguf", join(root, "e.gguf"));
    await expect(run({ MEMORA_AI_CASSETTE_LOCAL_MISSES: "live" })).rejects.toThrow(
      /--embedding-gguf .* does not exist/
    );
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(root, "models"))).toBe(false);
  });

  describe("the extraction pin of the recording (T55k)", () => {
    const record = async (pin?: "extraction" | "off") =>
      writeFile(
        join(root, ".cache", "cassette", "e2e-route.json"),
        JSON.stringify(
          recordedRoute(
            RouteSpecSchema.parse({
              writer: { kind: "local", catalogId: "mlx-qwen3.5-9b-4bit", path: "/models/writer" },
              embedding: { path: "/models/embedding.gguf" }
            }),
            {
              contentLanguage: "pt-BR",
              source: "plos-one-murre-dros-2015",
              notes: 76,
              topics: 14,
              recordedAt: new Date("2026-10-18T12:00:00.000Z"),
              ...(pin ? { pin } : {})
            }
          )
        )
      );

    it("refuses a pin that is not the recording's before it creates anything", async () => {
      // A cassette from F2 (no pin kept) is pinned; one recorded under F3 is not.
      await expect(run({ MEMORA_GOLDEN_PIN: "off" })).rejects.toThrow(
        /recorded with MEMORA_GOLDEN_PIN=extraction/
      );
      await record("off");
      await expect(run({ MEMORA_GOLDEN_PIN: "extraction" })).rejects.toThrow(
        /recorded with MEMORA_GOLDEN_PIN=off: replay it with MEMORA_GOLDEN_PIN=off or leave it unset/
      );
      expect(existsSync(join(root, "scratch"))).toBe(false);
    });

    it("replays with the recording's pin whether the variable is unset or says the same", async () => {
      await record("off");
      for (const env of [{}, { MEMORA_GOLDEN_PIN: "off" }])
        // The checkout of this test holds no golden manifest: the run stops at the paper, after the pin.
        await expect(run(env)).rejects.toThrow(/manifest\.json/);
      expect(existsSync(join(root, "scratch"))).toBe(false);
    });
  });

  it("goes on to the next check once both models are there", async () => {
    await writeFile(join(root, "e.gguf"), "");
    config = parse("--writer-path", root, "--embedding-gguf", join(root, "e.gguf"));
    // The checkout of this test holds no golden manifest: the run stops at the paper, after the models.
    await expect(run({ MEMORA_AI_CASSETTE_LOCAL_MISSES: "live" })).rejects.toThrow(
      /manifest\.json/
    );
    expect(existsSync(join(root, "scratch"))).toBe(false);
  });
});
