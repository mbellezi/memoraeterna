import { describe, expect, it } from "vitest";

import {
  RecordedRouteSchema,
  RouteSpecSchema,
  UsageError,
  defaultEmbeddingCatalogId,
  parseE2eArgs,
  recordedRoute,
  routeFromFile
} from "./config.js";
import type { E2eConfig } from "./config.js";

const root = "/repo";
const parse = (...args: string[]): E2eConfig => {
  const config = parseE2eArgs(args, { repositoryRoot: root });
  if (config === "help") throw new Error("unexpected help");
  return config;
};

describe("the options of the zero-config end-to-end test", () => {
  it("replays by default, against the cassette in .cache, with the E6 time budget", () => {
    const config = parse();
    expect(config).toMatchObject({
      mode: "replay",
      synthetic: false,
      sourceKey: "plos-one-murre-dros-2015",
      route: null,
      locale: "pt-BR",
      laneTimeoutMs: 15 * 60_000,
      cassetteDir: null,
      keep: false
    });
    expect(config.manifestPath).toBe("/repo/scripts/golden/manifest.json");
  });

  it("answers --help and rejects unknown options", () => {
    expect(parseE2eArgs(["--help"], { repositoryRoot: root })).toBe("help");
    expect(() => parse("--nope")).toThrow(UsageError);
    expect(() => parse("--mode", "sideways")).toThrow(/record, replay or both/);
  });

  it("makes the synthetic self-test record and replay in one go, and refuses a route for it", () => {
    expect(parse("--synthetic").mode).toBe("both");
    expect(parse("--synthetic", "--mode", "replay").mode).toBe("replay");
    expect(() => parse("--mode", "both")).toThrow(/needs --synthetic/);
    expect(() => parse("--synthetic", "--writer-model", "x")).toThrow(/own route/);
  });

  it("lets a replay take no route and no token cap", () => {
    expect(() => parse("--profile", "scratch")).toThrow(/Replay configures its own route/);
    expect(() => parse("--max-tokens", "1000")).toThrow(/only applies to a recording/);
  });

  it("keeps cassettes inside .cache, except the throwaway synthetic one", () => {
    expect(() => parse("--cassette-dir", "/elsewhere/e2e")).toThrow(/inside \/repo\/\.cache/);
    expect(() => parse("--cassette-dir", "/repo/.cache")).toThrow(/inside/);
    expect(() => parse("--cassette-dir", "/repo/.cache/../escape")).toThrow(/inside/);
    expect(parse("--cassette-dir", "/repo/.cache/topics/cassettes/x").cassetteDir).toBe(
      "/repo/.cache/topics/cassettes/x"
    );
    expect(parse("--synthetic", "--cassette-dir", "/tmp/c").cassetteDir).toBe("/tmp/c");
  });

  it("needs a route, the embedding model and a token cap to record a remote writer", () => {
    expect(() => parse("--mode", "record")).toThrow(/needs a route/);
    const remote = [
      "--mode",
      "record",
      "--writer-provider",
      "openai-compatible",
      "--writer-model",
      "m1"
    ];
    expect(() => parse(...remote, "--embedding-gguf", "/m/e.gguf")).toThrow(/--max-tokens/);
    expect(() => parse(...remote, "--max-tokens", "1000")).toThrow(/--embedding-gguf/);
    const config = parse(...remote, "--max-tokens", "1000", "--embedding-gguf", "/m/e.gguf");
    expect(config.maxTokens).toBe(1000);
    expect(config.route?.spec).toMatchObject({
      writer: { kind: "remote", provider: "openai-compatible", modelId: "m1" },
      embedding: { catalogId: defaultEmbeddingCatalogId, path: "/m/e.gguf" }
    });
    // The key comes from an environment variable (or a file), never from a flag.
    expect(config.route?.spec?.writer).toMatchObject({ apiKeyEnv: "MEMORA_E2E_API_KEY" });
    expect(() => parse(...remote, "--api-key", "secret")).toThrow(UsageError);
  });

  it("records with a local writer without a token cap", () => {
    const config = parse(
      "--mode",
      "record",
      "--writer-local",
      "mlx-qwen3-4b-instruct-2507-4bit",
      "--writer-path",
      "/m/qwen",
      "--embedding-gguf",
      "/m/e.gguf"
    );
    expect(config.route?.spec?.writer).toEqual({
      kind: "local",
      catalogId: "mlx-qwen3-4b-instruct-2507-4bit",
      path: "/m/qwen"
    });
    expect(() =>
      parse("--mode", "record", "--writer-local", "x", "--embedding-gguf", "/m/e.gguf")
    ).toThrow(/--writer-path/);
  });

  it("reads a scratch profile's route file from .cache/profiles and nowhere else", () => {
    const config = parse(
      "--mode",
      "record",
      "--profile",
      "e2e-scratch",
      "--max-tokens",
      "5",
      "--embedding-gguf",
      "/m/e.gguf"
    );
    expect(config.route).toEqual({
      spec: null,
      file: "/repo/.cache/profiles/e2e-scratch/e2e-route.json",
      embeddingGguf: "/m/e.gguf"
    });
    expect(() =>
      parse("--mode", "record", "--profile", "../../etc", "--embedding-gguf", "/m/e.gguf")
    ).toThrow(/folder name/);
    expect(() =>
      parse(
        "--mode",
        "record",
        "--profile",
        "a",
        "--route-file",
        "/b.json",
        "--embedding-gguf",
        "/m/e.gguf"
      )
    ).toThrow(/Give one route/);
  });
});

describe("the route of a recording", () => {
  const remote = {
    writer: { kind: "remote", provider: "google", modelId: "gemini-x" },
    embedding: { path: "/m/e.gguf" }
  };

  it("fills in the Settings defaults for a generative model and the default embedding model", () => {
    const spec = RouteSpecSchema.parse(remote);
    expect(spec.writer).toMatchObject({
      kind: "remote",
      apiKeyEnv: "MEMORA_E2E_API_KEY",
      capabilities: expect.arrayContaining(["structured-output", "atomic-note-generation"])
    });
    expect(spec.embedding.catalogId).toBe(defaultEmbeddingCatalogId);
  });

  it("rejects an inline secret in a route file", () => {
    for (const secret of ["apiKey", "token", "password"]) {
      const parsed = RouteSpecSchema.safeParse({
        ...remote,
        writer: { ...remote.writer, [secret]: "sk-live" }
      });
      expect(parsed.success).toBe(false);
    }
    expect(() =>
      routeFromFile(JSON.stringify({ writer: { kind: "remote" } }), "r.json", null)
    ).toThrow(/never the key/);
    expect(() => routeFromFile("{", "r.json", null)).toThrow(/not JSON/);
  });

  it("takes the embedding model from the flag over the file, and needs one of them", () => {
    const content = JSON.stringify({ ...remote, embedding: {} });
    expect(() => routeFromFile(content, "r.json", null)).toThrow(/--embedding-gguf/);
    expect(routeFromFile(content, "r.json", "/x/e.gguf").embedding.path).toBe("/x/e.gguf");
    expect(routeFromFile(JSON.stringify(remote), "r.json", null).embedding.path).toBe("/m/e.gguf");
  });

  it("keeps next to the cassette the route without credentials or paths", () => {
    const spec = RouteSpecSchema.parse({
      ...remote,
      writer: {
        ...remote.writer,
        apiKeyFile: "/secrets/key.txt",
        baseUrl: "https://api.example/v1"
      }
    });
    const kept = recordedRoute(spec, {
      contentLanguage: "pt-BR",
      source: "plos-one-murre-dros-2015",
      notes: 63,
      topics: 7,
      recordedAt: new Date("2026-10-16T12:00:00Z")
    });
    expect(RecordedRouteSchema.parse(kept)).toEqual(kept);
    const text = JSON.stringify(kept);
    expect(text).not.toContain("secrets");
    expect(text).not.toContain("/m/e.gguf");
    expect(text).not.toContain("MEMORA_E2E_API_KEY");
    expect(kept).toMatchObject({
      writer: { kind: "remote", provider: "google", modelId: "gemini-x" },
      embedding: { catalogId: defaultEmbeddingCatalogId },
      result: { notes: 63, topics: 7 }
    });
  });
});
