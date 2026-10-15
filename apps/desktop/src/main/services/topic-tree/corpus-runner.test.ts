import { describe, expect, it } from "vitest";

import { CorpusRefusal, defaultCorpusSeed, readCorpusConfig } from "./corpus-runner.js";

const workspaceRoot = "/work/memora";
const profile = `${workspaceRoot}/.cache/profiles/env-c`;
const base = { MEMORA_TOPIC_CORPUS: "1", MEMORA_USER_DATA_DIR: profile };
const read = (env: Record<string, string | undefined>, isPackaged = false) =>
  readCorpusConfig(env, { isPackaged, workspaceRoot });
const code = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof CorpusRefusal ? error.code : `other:${String(error)}`;
  }
  return undefined;
};

describe("the corpus runner's knobs", () => {
  it("does nothing without MEMORA_TOPIC_CORPUS", () => {
    expect(read({})).toBeNull();
    expect(read({ MEMORA_TOPIC_CORPUS: "  ", MEMORA_USER_DATA_DIR: profile })).toBeNull();
    // Another knob alone is ignored, not refused.
    expect(read({ MEMORA_TOPIC_CORPUS_STAGE: "nonsense" })).toBeNull();
  });

  it("reads the defaults: the workspace corpus, every stage, the evaluation seed", () => {
    const config = read({
      ...base,
      MEMORA_AI_CASSETTE: "replay",
      MEMORA_AI_CASSETTE_DIR: ".cache/golden/cassettes/corpus-f2"
    })!;
    expect(config).toMatchObject({
      directory: `${workspaceRoot}/.cache/corpus`,
      stages: ["seed", "build", "arrive"],
      holdout: null,
      articleLimit: null,
      seed: defaultCorpusSeed,
      maxTokens: null,
      exit: false,
      cassette: "replay",
      userDataPath: profile
    });
  });

  it("reads a folder, a stage list, the holdout, the subset, the seed, the cap and the exit", () => {
    const config = read({
      ...base,
      MEMORA_TOPIC_CORPUS: "corpora/small",
      MEMORA_TOPIC_CORPUS_STAGE: "arrive, seed",
      MEMORA_TOPIC_CORPUS_HOLDOUT: "articles:40",
      MEMORA_TOPIC_CORPUS_ARTICLES: "60",
      MEMORA_TOPIC_CORPUS_SEED: "9",
      MEMORA_TOPIC_CORPUS_MAX_TOKENS: "120000",
      MEMORA_TOPIC_CORPUS_EXIT: "1",
      MEMORA_AI_CASSETTE: "record"
    })!;
    expect(config).toMatchObject({
      directory: `${workspaceRoot}/corpora/small`,
      // The stages run in their own order whatever the order of the list.
      stages: ["seed", "arrive"],
      holdout: { mode: "articles", count: 40 },
      articleLimit: 60,
      seed: 9,
      maxTokens: 120000,
      exit: true,
      cassette: "record"
    });
  });

  it("is refused when packaged", () => {
    expect(code(() => read(base, true))).toBe("packaged");
  });

  it("is refused beside another knob that changes the library", () => {
    for (const knob of [
      "MEMORA_GOLDEN_RUN",
      "MEMORA_GOLDEN_RESET",
      "MEMORA_PROFILE_RESET",
      "MEMORA_LEGACY_WIPE",
      "MEMORA_MATCHING_PILOT"
    ])
      expect(code(() => read({ ...base, [knob]: "1" }))).toBe("conflictingKnob");
  });

  it("needs a profile folder to be named", () => {
    expect(code(() => read({ MEMORA_TOPIC_CORPUS: "1" }))).toBe("outsideProfiles");
  });

  it("refuses bad values", () => {
    const cassette = { MEMORA_AI_CASSETTE: "replay" };
    for (const bad of [
      { MEMORA_TOPIC_CORPUS_STAGE: "seed,teleport" },
      { MEMORA_TOPIC_CORPUS_HOLDOUT: "articles:zero" },
      { MEMORA_TOPIC_CORPUS_ARTICLES: "0" },
      { MEMORA_TOPIC_CORPUS_SEED: "-1" },
      { MEMORA_TOPIC_CORPUS_MAX_TOKENS: "many" }
    ])
      expect(code(() => read({ ...base, ...cassette, ...bad }))).toBe("invalidValue");
  });

  it("lets the seed stage run with no AI setting, since it makes no model call but embeddings", () => {
    expect(read({ ...base, MEMORA_TOPIC_CORPUS_STAGE: "seed" })).toMatchObject({
      stages: ["seed"],
      cassette: null
    });
  });

  it("never reaches a provider unrecorded: the topic stages need a cassette, and record needs a cap", () => {
    expect(code(() => read(base))).toBe("cassetteRequired");
    expect(code(() => read({ ...base, MEMORA_TOPIC_CORPUS_STAGE: "build" }))).toBe(
      "cassetteRequired"
    );
    // A cassette that is off, or an unknown mode, is no cassette.
    expect(code(() => read({ ...base, MEMORA_AI_CASSETTE: "off" }))).toBe("cassetteRequired");
    expect(code(() => read({ ...base, MEMORA_AI_CASSETTE: "record" }))).toBe("tokenCapRequired");
    expect(
      read({ ...base, MEMORA_AI_CASSETTE: "record", MEMORA_TOPIC_CORPUS_MAX_TOKENS: "50000" })
    ).toMatchObject({ cassette: "record", maxTokens: 50000 });
    expect(read({ ...base, MEMORA_AI_CASSETTE: "replay" })).toMatchObject({ cassette: "replay" });
  });
});
