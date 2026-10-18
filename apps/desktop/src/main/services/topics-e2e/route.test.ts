import { describe, expect, it } from "vitest";

import { RouteSpecSchema, UsageError, parseE2eArgs, recordedRoute } from "./config.js";
import type { E2eConfig, RecordedRoute, RouteSpec } from "./config.js";
import {
  checkReplayModelPaths,
  expectRoutes,
  readApiKey,
  readRecordedRoute,
  replayRoute,
  resolveRoute
} from "./route.js";

const root = "/repo";
const config = (...args: string[]): E2eConfig => {
  const parsed = parseE2eArgs(args, { repositoryRoot: root });
  if (parsed === "help") throw new Error("help");
  return parsed;
};
const never = async (): Promise<string> => {
  throw new Error("must not read");
};

describe("the route of a recording", () => {
  it("takes the flags as they are, without reading a file", async () => {
    const spec = await resolveRoute(
      config(
        "--mode",
        "record",
        "--writer-provider",
        "google",
        "--writer-model",
        "gemini-x",
        "--max-tokens",
        "9",
        "--embedding-gguf",
        "/m/e.gguf"
      ),
      never
    );
    expect(spec.writer).toMatchObject({ kind: "remote", provider: "google", modelId: "gemini-x" });
    expect(spec.embedding.path).toBe("/m/e.gguf");
  });

  it("reads the route file of a scratch profile and rejects a file that holds a key", async () => {
    const recording = config(
      "--mode",
      "record",
      "--profile",
      "e2e-scratch",
      "--max-tokens",
      "9",
      "--embedding-gguf",
      "/m/e.gguf"
    );
    const reads: string[] = [];
    const spec = await resolveRoute(recording, async (path) => {
      reads.push(path);
      return JSON.stringify({
        writer: { kind: "remote", provider: "openai-compatible", modelId: "m", apiKeyEnv: "MY_KEY" }
      });
    });
    expect(reads).toEqual(["/repo/.cache/profiles/e2e-scratch/e2e-route.json"]);
    expect(spec.writer).toMatchObject({ apiKeyEnv: "MY_KEY" });
    await expect(
      resolveRoute(recording, async () =>
        JSON.stringify({
          writer: { kind: "remote", provider: "google", modelId: "m", apiKey: "sk" }
        })
      )
    ).rejects.toThrow(/never the key/);
    await expect(
      resolveRoute(recording, async () => {
        throw new Error("ENOENT");
      })
    ).rejects.toThrow(UsageError);
  });

  it("asks for a token cap whenever the route file turns out to be remote", async () => {
    const withoutCap = config(
      "--mode",
      "record",
      "--route-file",
      "/r.json",
      "--embedding-gguf",
      "/m/e.gguf"
    );
    await expect(
      resolveRoute(withoutCap, async () =>
        JSON.stringify({ writer: { kind: "remote", provider: "google", modelId: "m" } })
      )
    ).rejects.toThrow(/--max-tokens/);
    // A local writer spends nothing remote.
    await expect(
      resolveRoute(withoutCap, async () =>
        JSON.stringify({ writer: { kind: "local", catalogId: "mlx-x", path: "/m/x" } })
      )
    ).resolves.toMatchObject({ writer: { kind: "local" } });
  });

  it("reads the key from a file or from the named variable, and says where it looked", async () => {
    const writer = RouteSpecSchema.parse({
      writer: { kind: "remote", provider: "google", modelId: "m", apiKeyEnv: "WRITER_KEY" }
    }).writer;
    expect(await readApiKey(writer, { WRITER_KEY: "  abc \n" }, never)).toBe("abc");
    await expect(readApiKey(writer, {}, never)).rejects.toThrow(/\$WRITER_KEY/);
    const withFile = RouteSpecSchema.parse({
      writer: { kind: "remote", provider: "google", modelId: "m", apiKeyFile: "/k.txt" }
    }).writer;
    expect(
      await readApiKey(withFile, { MEMORA_E2E_API_KEY: "ignored" }, async () => "from-file\n")
    ).toBe("from-file");
    const local = RouteSpecSchema.parse({
      writer: { kind: "local", catalogId: "mlx-x", path: "/m/x" }
    }).writer;
    expect(await readApiKey(local, {}, never)).toBeNull();
  });
});

describe("the route of a replay", () => {
  const spec: RouteSpec = RouteSpecSchema.parse({
    writer: {
      kind: "remote",
      provider: "openai-compatible",
      modelId: "m1",
      baseUrl: "http://h/v1"
    },
    embedding: { path: "/m/e.gguf" }
  });
  const recorded = recordedRoute(spec, {
    contentLanguage: "pt-BR",
    source: "plos-one-murre-dros-2015",
    notes: 63,
    topics: 5,
    recordedAt: new Date("2026-10-16T12:00:00Z")
  });

  it("rebuilds the recorded profile with placeholder paths in the scratch workspace", () => {
    const replay = replayRoute(recorded, "/scratch/models");
    expect(replay.writer).toMatchObject({
      kind: "remote",
      provider: "openai-compatible",
      modelId: "m1",
      baseUrl: "http://h/v1"
    });
    expect(replay.embedding.path).toBe("/scratch/models/gguf-qwen3-embedding-0.6b-q8-0.gguf");
    const local = replayRoute(
      { ...recorded, writer: { kind: "local", catalogId: "mlx-x" } },
      "/scratch/models"
    );
    expect(local.writer).toEqual({
      kind: "local",
      catalogId: "mlx-x",
      path: "/scratch/models/mlx-x"
    });
  });

  it("puts the installed models in place of the placeholders when the replay's local misses run live", () => {
    const local: RecordedRoute = { ...recorded, writer: { kind: "local", catalogId: "mlx-x" } };
    expect(
      replayRoute(local, "/scratch/models", { writer: "/m/mlx-x", embedding: "/m/e.gguf" })
    ).toMatchObject({
      writer: { kind: "local", catalogId: "mlx-x", path: "/m/mlx-x" },
      embedding: { path: "/m/e.gguf" }
    });
    // A path left out keeps its placeholder; a remote writer has no path to take.
    expect(replayRoute(local, "/scratch/models", { embedding: "/m/e.gguf" })).toMatchObject({
      writer: { path: "/scratch/models/mlx-x" },
      embedding: { path: "/m/e.gguf" }
    });
    expect(
      replayRoute(recorded, "/scratch/models", { writer: "/m/ignored" }).writer
    ).not.toHaveProperty("path");
  });

  describe("the models a live local miss runs on (MEMORA_AI_CASSETTE_LOCAL_MISSES=live)", () => {
    const local: RecordedRoute = { ...recorded, writer: { kind: "local", catalogId: "mlx-x" } };
    const present = new Set(["/m/mlx-x", "/m/e.gguf"]);
    const exists = (path: string) => present.has(path);
    const none = { writer: null, embedding: null };

    it("needs the embedding model and a local writer's directory, and both must exist", () => {
      expect(() =>
        checkReplayModelPaths(local, { writer: "/m/mlx-x", embedding: "/m/e.gguf" }, "live", exists)
      ).not.toThrow();
      expect(() => checkReplayModelPaths(local, none, "live", exists)).toThrow(
        /pass --embedding-gguf/
      );
      expect(() =>
        checkReplayModelPaths(local, { writer: null, embedding: "/m/e.gguf" }, "live", exists)
      ).toThrow(/pass --writer-path <installed local writer>/);
      expect(() =>
        checkReplayModelPaths(local, { writer: "/m/typo", embedding: "/m/e.gguf" }, "live", exists)
      ).toThrow(/--writer-path \/m\/typo does not exist/);
      expect(() =>
        checkReplayModelPaths(local, { writer: "/m/mlx-x", embedding: "/m/typo" }, "live", exists)
      ).toThrow(/--embedding-gguf \/m\/typo does not exist/);
    });

    it("needs no writer path for a remote writer, and refuses one", () => {
      expect(() =>
        checkReplayModelPaths(recorded, { writer: null, embedding: "/m/e.gguf" }, "live", exists)
      ).not.toThrow();
      expect(() =>
        checkReplayModelPaths(
          recorded,
          { writer: "/m/mlx-x", embedding: "/m/e.gguf" },
          "live",
          exists
        )
      ).toThrow(/recorded with a remote one/);
    });

    it("refuses paths for a replay that fails on a miss, where nothing would load them, and asks for none", () => {
      expect(() => checkReplayModelPaths(local, none, "fail", exists)).not.toThrow();
      expect(() =>
        checkReplayModelPaths(local, { writer: "/m/mlx-x", embedding: null }, "fail", exists)
      ).toThrow(/set MEMORA_AI_CASSETTE_LOCAL_MISSES=live/);
    });
  });

  it("reads the route next to the cassette, and asks to record first when it is missing", async () => {
    expect(
      await readRecordedRoute("/cassettes/e2e-plos", async (path) => {
        expect(path).toBe("/cassettes/e2e-plos/e2e-route.json");
        return JSON.stringify(recorded);
      })
    ).toEqual(recorded);
    await expect(
      readRecordedRoute("/cassettes/e2e-plos", async () => {
        throw new Error("ENOENT");
      })
    ).rejects.toThrow(/record it first/);
    await expect(
      readRecordedRoute("/cassettes/e2e-plos", async () => JSON.stringify({ format: "other" }))
    ).rejects.toThrow(/not a recorded route/);
  });
});

describe("the routes the first-run seeding must make", () => {
  const good = {
    embedding: "Embedding",
    summarization: "Writer",
    "atomic-note-generation": "Writer",
    "knowledge-graph-generation": "Writer",
    "structured-output": "Writer",
    "class:write-fast": "Writer"
  };

  it("accepts the writer for generation, the embedding profile for vectors and no decider", () => {
    expect(() => expectRoutes(good)).not.toThrow();
  });

  it("names every task that went to the wrong profile or nowhere", () => {
    expect(() => expectRoutes({ ...good, embedding: "Writer" })).toThrow(
      /embedding routes to Writer, not to Embedding/
    );
    expect(() =>
      expectRoutes({ ...good, "class:write-fast": undefined as unknown as string })
    ).toThrow(/class:write-fast routes to nothing/);
    expect(() => expectRoutes({ ...good, "class:decide": "Writer" })).toThrow(
      /class:decide is routed/
    );
  });
});
