import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RecordedFirstRunSchema,
  UsageError,
  codexCapabilities,
  defaultCodexModel,
  defaultFirstSourceKey,
  defaultSecondSourceKey,
  e6BudgetMinutes,
  firstRunCassetteName,
  firstRunModels,
  parseFirstRunArgs,
  recordedWriter,
  replayWriter,
  usage
} from "./config.js";
import type { FirstRunConfig, RecordedFirstRun } from "./config.js";

const root = resolve("/work/memora");
const parse = (argv: string[], env: Record<string, string | undefined> = {}) =>
  parseFirstRunArgs(argv, { repositoryRoot: root, env }) as FirstRunConfig;
const refused = (argv: string[], env: Record<string, string | undefined> = {}) => {
  try {
    parseFirstRunArgs(argv, { repositoryRoot: root, env });
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error("expected a usage error");
};

describe("the first-run end-to-end options", () => {
  it("replays by default, with recorded timing, the E6 sources and bar and the seed folder of the cache", () => {
    const config = parse([]);
    expect(config).toMatchObject({
      mode: "replay",
      synthetic: false,
      replays: 1,
      timing: "recorded",
      sources: { first: defaultFirstSourceKey, second: defaultSecondSourceKey },
      writer: null,
      maxTokens: null,
      cassetteDir: null,
      budgetMs: e6BudgetMinutes * 60_000,
      seedDir: join(root, ".cache", "models"),
      locale: "pt-BR"
    });
    expect(config.manifestPath).toBe(join(root, "scripts", "golden", "manifest.json"));
    expect(firstRunCassetteName).toBe("firstrun-hybrid-f4");
  });

  it("takes the seed folder from the flag, else from MEMORA_LOCAL_MODEL_SEED_DIR, else the cache", () => {
    expect(parse([], { MEMORA_LOCAL_MODEL_SEED_DIR: "/models" }).seedDir).toBe("/models");
    expect(parse([], { MEMORA_LOCAL_MODEL_SEED_DIR: "rel/models" }).seedDir).toBe(
      join(root, "rel", "models")
    );
    expect(parse(["--seed-dir", "/flag"], { MEMORA_LOCAL_MODEL_SEED_DIR: "/models" }).seedDir).toBe(
      "/flag"
    );
    expect(parse([], { MEMORA_LOCAL_MODEL_SEED_DIR: "  " }).seedDir).toBe(
      join(root, ".cache", "models")
    );
  });

  it("asks for two replays, and refuses the replay flags on a recording", () => {
    expect(parse(["--replays", "2"]).replays).toBe(2);
    expect(refused(["--replays", "0"])).toMatch(/positive whole number/u);
    expect(refused(["--mode", "record", "--replays", "2"], {})).toMatch(
      /replays only applies|needs/u
    );
    expect(
      refused([
        "--mode",
        "record",
        "--max-tokens",
        "1000",
        "--codex-credential-file",
        "/c.json",
        "--timing",
        "off"
      ])
    ).toMatch(/--timing only applies to a replay/u);
    expect(
      refused([
        "--mode",
        "record",
        "--max-tokens",
        "1000",
        "--codex-credential-file",
        "/c.json",
        "--seed-dir",
        "/models"
      ])
    ).toMatch(/downloads for real/u);
  });

  it("records with a Codex credential file, the default model and a token cap", () => {
    const config = parse([
      "--mode",
      "record",
      "--max-tokens",
      "150000",
      "--codex-credential-file",
      "/secrets/codex.json"
    ]);
    expect(config.writer).toEqual({
      kind: "codex",
      modelId: defaultCodexModel,
      credentialFile: "/secrets/codex.json"
    });
    expect(config.maxTokens).toBe(150_000);
    expect(config.seedDir).toBeNull();
  });

  it("records with an API key route read from the environment or a file, never from a flag", () => {
    const config = parse([
      "--mode",
      "record",
      "--max-tokens",
      "9",
      "--writer-provider",
      "openai-compatible",
      "--writer-model",
      "m",
      "--writer-base-url",
      "http://127.0.0.1:1234/v1"
    ]);
    expect(config.writer).toEqual({
      kind: "remote",
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "m",
      apiKeyEnv: "MEMORA_E2E_API_KEY"
    });
    expect(
      refused(["--mode", "record", "--writer-provider", "google", "--writer-model", "m"])
    ).toMatch(/--max-tokens/u);
    expect(
      refused([
        "--mode",
        "record",
        "--max-tokens",
        "9",
        "--writer-provider",
        "google",
        "--writer-model",
        "m",
        "--codex-credential-file",
        "/c.json"
      ])
    ).toMatch(/for --writer-provider openai-codex/u);
    expect(
      refused(["--mode", "record", "--max-tokens", "9", "--writer-provider", "google"])
    ).toMatch(/needs --writer-model/u);
  });

  it("refuses a recording with no cap, no credential file, or a credential inside the repository", () => {
    expect(refused(["--mode", "record", "--codex-credential-file", "/c.json"])).toMatch(
      /--max-tokens/u
    );
    expect(refused(["--mode", "record", "--max-tokens", "9"])).toMatch(/--codex-credential-file/u);
    expect(
      refused([
        "--mode",
        "record",
        "--max-tokens",
        "9",
        "--codex-credential-file",
        join(root, "codex.json")
      ])
    ).toMatch(/outside the repository/u);
    // The ignored cache is a place a credential may sit.
    expect(
      parse([
        "--mode",
        "record",
        "--max-tokens",
        "9",
        "--codex-credential-file",
        join(root, ".cache", "private", "codex.json")
      ]).writer
    ).toMatchObject({ kind: "codex" });
  });

  it("refuses a route on a replay, the self-test's own route, and a cassette outside the cache", () => {
    expect(refused(["--writer-model", "x"])).toMatch(/rebuilds the recorded route/u);
    expect(refused(["--max-tokens", "5"])).toMatch(/only applies to a recording/u);
    expect(refused(["--synthetic", "--writer-model", "x"])).toMatch(/its own writer/u);
    expect(refused(["--cassette-dir", "/elsewhere/cassette"])).toMatch(/inside .*\.cache/u);
    expect(parse(["--synthetic", "--cassette-dir", "/anywhere/cassette"]).cassetteDir).toBe(
      "/anywhere/cassette"
    );
    expect(refused(["--mode", "both"])).toMatch(/needs --synthetic/u);
    expect(refused(["--mode", "sideways"])).toMatch(/record, replay or both/u);
    expect(refused(["--nonsense"])).toMatch(/Unknown option/iu);
  });

  it("resumes a take only on a recording, and copies the downloaded models only from a live one into the cache", () => {
    const record = ["--mode", "record", "--max-tokens", "9", "--codex-credential-file", "/c.json"];
    expect(parse(record).resume).toBe(false);
    expect(parse([...record, "--resume"]).resume).toBe(true);
    expect(refused(["--resume"])).toMatch(/--resume only applies to a recording/u);
    expect(parse(record).copyModelsTo).toBeNull();
    expect(
      parse([...record, "--copy-models-to", join(root, ".cache", "models")]).copyModelsTo
    ).toBe(join(root, ".cache", "models"));
    expect(refused([...record, "--copy-models-to", "/elsewhere/models"])).toMatch(
      /inside .*\.cache/u
    );
    expect(refused(["--copy-models-to", join(root, ".cache", "models")])).toMatch(
      /live recording/u
    );
    expect(refused(["--synthetic", "--copy-models-to", join(root, ".cache", "m")])).toMatch(
      /live recording/u
    );
  });

  it("makes the self-test a recording and its replay, with no seed folder and no writer", () => {
    const config = parse(["--synthetic", "--replays", "2"]);
    expect(config).toMatchObject({
      mode: "both",
      synthetic: true,
      replays: 2,
      writer: null,
      seedDir: null
    });
  });

  it("releases the topic work by a2 at 12 first-source notes by default, the threshold and the repeat by flag", () => {
    expect(parse([]).topicRelease).toEqual({
      policy: "a2",
      firstSourceNotes: 12,
      repeatUntilT1: false
    });
    expect(parse(["--synthetic"]).topicRelease.firstSourceNotes).toBe(12);
    expect(parse(["--topic-release-notes", "8", "--topic-release-repeat"]).topicRelease).toEqual({
      policy: "a2",
      firstSourceNotes: 8,
      repeatUntilT1: true
    });
    expect(refused(["--topic-release-notes", "0"])).toMatch(/--topic-release-notes/u);
    expect(refused(["--topic-release-notes", "2.5"])).toMatch(/whole number/u);
  });

  it("keeps the model catalog ids the preset and the first-run ranker name", () => {
    expect(firstRunModels).toEqual({
      embedding: "gguf-qwen3-embedding-0.6b-q8-0",
      rankerMlx: "mlx-qwen3-reranker-0.6b",
      rankerGguf: "gguf-qwen3-reranker-0.6b-q8-0"
    });
  });

  it("gives Codex the generation capabilities of Settings without an API key", () => {
    expect(codexCapabilities).toContain("structured-output");
    expect(codexCapabilities).not.toContain("requires-api-key");
  });

  it("documents the record, the replay, the self-test and the clock in its usage text", () => {
    expect(usage).toContain("npm run firstrun:e2e");
    expect(usage).toContain("--mode record");
    expect(usage).toContain("--synthetic");
    expect(usage).toContain("T0");
    expect(usage).toContain("T1");
    expect(usage).toContain("D");
    expect(usage).toContain("--topic-release-notes");
    expect(usage).toContain("--topic-release-repeat");
    expect(parseFirstRunArgs(["--help"], { repositoryRoot: root })).toBe("help");
  });
});

describe("what a recording keeps of its writer", () => {
  it("drops the credential file, the key variable and the key file", () => {
    expect(
      recordedWriter({
        kind: "codex",
        modelId: "gpt-5.6-luna",
        credentialFile: "/secret/codex.json"
      })
    ).toEqual({ kind: "codex", modelId: "gpt-5.6-luna" });
    expect(
      recordedWriter({
        kind: "remote",
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:1/v1",
        modelId: "m",
        apiKeyEnv: "KEY",
        apiKeyFile: "/secret/key"
      })
    ).toEqual({
      kind: "remote",
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      modelId: "m"
    });
  });

  it("rebuilds a writer with placeholders where a secret was", () => {
    expect(replayWriter({ kind: "codex", modelId: "m" })).toMatchObject({
      kind: "codex",
      modelId: "m",
      credentialFile: "replay-placeholder"
    });
    expect(replayWriter({ kind: "remote", provider: "google", modelId: "m" })).toMatchObject({
      kind: "remote",
      apiKeyEnv: "MEMORA_E2E_API_KEY"
    });
  });
});

const record: RecordedFirstRun = {
  format: "memora-firstrun-e2e-record",
  version: 1,
  recordedAt: "2026-10-24T12:00:00.000Z",
  synthetic: false,
  contentLanguage: "pt-BR",
  sources: { first: defaultFirstSourceKey, second: defaultSecondSourceKey },
  writer: { kind: "codex", modelId: defaultCodexModel },
  topicRelease: { policy: "a2", firstSourceNotes: 12, repeatUntilT1: false },
  linkRuntime: "drain",
  models: {
    embedding: {
      catalogId: firstRunModels.embedding,
      runtime: "gguf",
      bytes: 639_150_592,
      installMs: 90_000
    },
    ranker: {
      catalogId: firstRunModels.rankerMlx,
      runtime: "mlx",
      bytes: 1_203_021_367,
      installMs: 150_000
    }
  },
  result: { notes: 70, topics: 5, noteRelations: 9, digest: "a".repeat(64) },
  timing: {
    t1MinusT0Ms: 400_000,
    appLaunchMs: 9_000,
    downloadCriticalPathMs: 120_000,
    downloadWindowMs: 240_000,
    live: true
  }
};

describe("the record kept next to the cassette", () => {
  it("accepts a complete record and refuses extra members, so a secret cannot ride along", () => {
    expect(RecordedFirstRunSchema.parse(record)).toEqual(record);
    expect(
      RecordedFirstRunSchema.safeParse({
        ...record,
        writer: { kind: "codex", modelId: "m", credentialFile: "/secret" }
      }).success
    ).toBe(false);
    expect(RecordedFirstRunSchema.safeParse({ ...record, apiKey: "k" }).success).toBe(false);
  });

  it("names its topic release and link runtime, and still reads a record from before a2 (a replay refuses it)", () => {
    expect(
      RecordedFirstRunSchema.safeParse({
        ...record,
        topicRelease: { policy: "both-imports", firstSourceNotes: 12, repeatUntilT1: false }
      }).success
    ).toBe(false);
    expect(RecordedFirstRunSchema.safeParse({ ...record, linkRuntime: "product" }).success).toBe(
      false
    );
    const barrier: Partial<RecordedFirstRun> = { ...record };
    delete barrier.topicRelease;
    delete barrier.linkRuntime;
    expect(RecordedFirstRunSchema.safeParse(barrier).success).toBe(true);
  });

  it("needs a SHA-256 digest and whole-millisecond clocks", () => {
    expect(
      RecordedFirstRunSchema.safeParse({ ...record, result: { ...record.result, digest: "x" } })
        .success
    ).toBe(false);
    expect(
      RecordedFirstRunSchema.safeParse({
        ...record,
        timing: { ...record.timing, downloadCriticalPathMs: 1.5 }
      }).success
    ).toBe(false);
  });
});
