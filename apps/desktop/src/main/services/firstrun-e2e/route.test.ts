import { describe, expect, it } from "vitest";

import { UsageError, firstRunModels } from "./config.js";
import type { RecordedFirstRun } from "./config.js";
import {
  checkRecordMatches,
  harnessRefreshToken,
  parseCodexCredentialFile,
  placeholderCodexCredential,
  readApiKey,
  readCodexCredential,
  readRecordedFirstRun,
  writeRecordedFirstRun
} from "./route.js";
import { topicReleaseSettings } from "./topic-release.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = Date.parse("2026-10-24T12:00:00Z");
const minutes = (n: number) => n * 60_000;
const credential = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    access: "SECRET-ACCESS-TOKEN",
    refresh: "SECRET-REFRESH-TOKEN",
    expires: now + minutes(120),
    accountId: "acct-1",
    planType: "plus",
    ...overrides
  });

describe("the Codex credential of a recording", () => {
  it("keeps the access token and drops the refresh token, so the harness cannot rotate the real one", () => {
    const parsed = parseCodexCredentialFile(credential(), "/c.json", now);
    expect(parsed).toEqual({
      access: "SECRET-ACCESS-TOKEN",
      refresh: harnessRefreshToken,
      expires: now + minutes(120),
      accountId: "acct-1",
      planType: "plus"
    });
    expect(JSON.stringify(parsed)).not.toContain("SECRET-REFRESH-TOKEN");
  });

  it("works without a refresh token in the file", () => {
    const withoutRefresh = JSON.parse(credential()) as Record<string, unknown>;
    delete withoutRefresh.refresh;
    delete withoutRefresh.planType;
    expect(parseCodexCredentialFile(JSON.stringify(withoutRefresh), "/c.json", now).refresh).toBe(
      harnessRefreshToken
    );
  });

  it("refuses an access token that expires before the run could end, without a refresh", () => {
    expect(() =>
      parseCodexCredentialFile(credential({ expires: now + minutes(10) }), "/c.json", now)
    ).toThrow(/expires in 10 minutes.*never refreshes/su);
    expect(() =>
      parseCodexCredentialFile(credential({ expires: now - 1 }), "/c.json", now)
    ).toThrow(/has expired/u);
    expect(
      parseCodexCredentialFile(credential({ expires: now + minutes(46) }), "/c.json", now).expires
    ).toBe(now + minutes(46));
  });

  it("refuses a file that is not a credential and never prints a token", () => {
    for (const content of [
      "not json",
      "{}",
      credential({ access: 5 }),
      credential({ accountId: "" })
    ]) {
      let message = "";
      try {
        parseCodexCredentialFile(content, "/c.json", now);
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("SECRET");
    }
  });

  it("reads the file through the reader it is given, and says when it cannot", async () => {
    const writer = { kind: "codex", modelId: "m", credentialFile: "/c.json" } as const;
    await expect(readCodexCredential(writer, now, async () => credential())).resolves.toMatchObject(
      {
        accountId: "acct-1"
      }
    );
    await expect(
      readCodexCredential(writer, now, async () => {
        throw new Error("ENOENT");
      })
    ).rejects.toThrow("could not be read");
  });

  it("gives a replay a placeholder that lasts and refreshes nothing", () => {
    const placeholder = placeholderCodexCredential(now);
    expect(placeholder.expires).toBeGreaterThan(now + 24 * 3_600_000);
    expect(placeholder.refresh).toBe(harnessRefreshToken);
  });
});

describe("the API key of a remote writer", () => {
  const writer = {
    kind: "remote",
    provider: "openai-compatible",
    modelId: "m",
    apiKeyEnv: "THE_KEY"
  } as const;

  it("comes from the file, else from the named variable", async () => {
    await expect(readApiKey(writer, { THE_KEY: " k1 " })).resolves.toBe("k1");
    await expect(
      readApiKey({ ...writer, apiKeyFile: "/k" }, { THE_KEY: "k1" }, async () => "k2\n")
    ).resolves.toBe("k2");
  });

  it("says where to put the key when it is missing", async () => {
    await expect(readApiKey(writer, {})).rejects.toThrow("$THE_KEY");
  });
});

const record: RecordedFirstRun = {
  format: "memora-firstrun-e2e-record",
  version: 1,
  recordedAt: "2026-10-24T12:00:00.000Z",
  synthetic: false,
  contentLanguage: "pt-BR",
  sources: { first: "plos", second: "wikibooks" },
  writer: { kind: "codex", modelId: "m" },
  topicRelease: topicReleaseSettings(),
  linkRuntime: "drain",
  models: {
    embedding: { catalogId: firstRunModels.embedding, runtime: "gguf", bytes: 1, installMs: 1 },
    ranker: { catalogId: firstRunModels.rankerMlx, runtime: "mlx", bytes: 1, installMs: 1 }
  },
  result: { notes: 1, topics: 1, noteRelations: 1, digest: "b".repeat(64) },
  timing: {
    t1MinusT0Ms: 1,
    appLaunchMs: 1,
    downloadCriticalPathMs: 1,
    downloadWindowMs: 1,
    live: true
  }
};
const plan = {
  embedding: firstRunModels.embedding,
  ranker: firstRunModels.rankerMlx,
  rankerRuntime: "mlx"
} as const;

describe("the record kept with the cassette", () => {
  it("is written and read back, and a missing or invalid one says how to make it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memora-firstrun-record-"));
    try {
      const file = await writeRecordedFirstRun(directory, record);
      expect(JSON.parse(await readFile(file, "utf8"))).toEqual(record);
      await expect(readRecordedFirstRun(directory)).resolves.toEqual(record);
      await expect(readRecordedFirstRun(join(directory, "nowhere"))).rejects.toThrow(
        /--mode record first/u
      );
      await expect(readRecordedFirstRun(directory, async () => "{}")).rejects.toThrow(
        /not a first-run record/u
      );
      await expect(readRecordedFirstRun(directory, async () => "nope")).rejects.toThrow(
        /not JSON/u
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("must match the replay: the sources, the ranker this machine installs, the live or synthetic kind", () => {
    const config = {
      sources: { first: "plos", second: "wikibooks" },
      synthetic: false,
      topicRelease: topicReleaseSettings()
    };
    expect(() => checkRecordMatches(record, config, plan)).not.toThrow();
    expect(() =>
      checkRecordMatches(record, { ...config, sources: { first: "plos", second: "other" } }, plan)
    ).toThrow(/second source wikibooks.*--second-source wikibooks/su);
    expect(() =>
      checkRecordMatches(record, config, {
        ...plan,
        ranker: firstRunModels.rankerGguf,
        rankerRuntime: "gguf"
      })
    ).toThrow(/recorded with the ranker.*record again on this machine/su);
    expect(() => checkRecordMatches(record, { ...config, synthetic: true }, plan)).toThrow(
      /live record: replay it without --synthetic|self-test/u
    );
    expect(() => checkRecordMatches({ ...record, synthetic: true }, config, plan)).toThrow(
      /self-test's.*--synthetic/su
    );
  });

  it("must match the replay's topic release and link runtime, and refuses a record from before a2", () => {
    const config = {
      sources: { first: "plos", second: "wikibooks" },
      synthetic: false,
      topicRelease: topicReleaseSettings()
    };
    const barrier: RecordedFirstRun = { ...record };
    delete barrier.topicRelease;
    delete barrier.linkRuntime;
    expect(() => checkRecordMatches(barrier, config, plan)).toThrow(
      /before the a2 topic release.*record again/su
    );
    expect(() =>
      checkRecordMatches(
        record,
        { ...config, topicRelease: topicReleaseSettings({ firstSourceNotes: 8 }) },
        plan
      )
    ).toThrow(/at 12 first-source notes, not 8: replay it with --topic-release-notes 12/u);
    expect(() =>
      checkRecordMatches(
        record,
        { ...config, topicRelease: topicReleaseSettings({ repeatUntilT1: true }) },
        plan
      )
    ).toThrow(/without --topic-release-repeat/u);
    expect(() =>
      checkRecordMatches(
        { ...record, topicRelease: topicReleaseSettings({ repeatUntilT1: true }) },
        config,
        plan
      )
    ).toThrow(/replay it with --topic-release-repeat/u);
  });
});
