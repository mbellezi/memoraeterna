import { describe, expect, it } from "vitest";

import { bandScore } from "./relation-calibration.js";
import { renderRelationPairText } from "./relation-pair-text.js";
import {
  decisionsDailyCapMaxUsd,
  findRelationCalibration,
  frozenRelationCalibrations,
  provisionalRelationCalibrations,
  relationsConfig,
  RelationsConfigSchema
} from "./relations-config.js";

describe("relations config", () => {
  it("holds the values of gate 0, the spec and the F3 bake-off", () => {
    expect(relationsConfig.retrieval).toEqual({
      vectorK: 24,
      textK: 16,
      graphK: 8,
      graphPoolK: 40,
      fusedK: 10,
      rrfK: 60,
      minimumGraphOnly: 3,
      guardFactor: 2,
      cosineFloor: null
    });
    expect(relationsConfig.decide).toEqual({
      rankPairsPerCall: { mlx: 32, gguf: 16 },
      helperBatchSize: 16,
      template: "relation-pair-text-v1",
      bodyCharacters: 600,
      rule: "mean",
      uncalibratedPass: { logOdds: { mlx: 3.3125, gguf: 3.16 }, probability: 0.65 }
    });
    expect(relationsConfig.maxShownPerNote).toBe(10);
    expect(relationsConfig.hysteresisLogOdds).toBe(0.5);
    expect(relationsConfig.typing).toEqual({ pairsPerCall: 24, maxAttempts: 2, coalesceBelow: 6 });
    expect(relationsConfig.link).toEqual({ poolSize: 2, drainPoolSize: 1 });
    expect(relationsConfig.ai).toEqual({ maxBackgroundCallsPerDay: 500 });
    expect(relationsConfig.match).toEqual({
      debounceMs: 60_000,
      maxDebounceMs: 300_000,
      backlogPageSize: 500
    });
    // The longest wait cannot be shorter than the wait itself.
    expect(RelationsConfigSchema.safeParse({ match: { debounceMs: 400_000 } }).success).toBe(false);
    expect(relationsConfig.escalation).toEqual({ enabled: false });
    expect(relationsConfig.discovery).toEqual({ neighbours: 1 });
    expect(relationsConfig.sourceJudge).toEqual({
      // One call per root (F4 D21); `perPair` restores F3's judge by this value alone.
      mode: "perRoot",
      maxPairsPerCall: 12,
      noteRelationsPerPair: 4,
      keepSimilarTo: false,
      exactEvidencePairs: 10_000,
      boundedEvidenceChunks: 16
    });
    expect(RelationsConfigSchema.safeParse({ discovery: { neighbours: 3 } }).success).toBe(false);
    expect(RelationsConfigSchema.parse({ sourceJudge: { mode: "perPair" } }).sourceJudge.mode).toBe(
      "perPair"
    );
    for (const sourceJudge of [{ mode: "perCall" }, { maxPairsPerCall: 0 }])
      expect(RelationsConfigSchema.safeParse({ sourceJudge }).success).toBe(false);
    // Parsing nothing gives the same defaults, with no calibration (every decider uncalibrated).
    expect(RelationsConfigSchema.parse({})).toEqual({ ...relationsConfig, calibrations: [] });
  });

  it("refuses a lossy cosine floor, a guard window or a graph list too short, and twin identities", () => {
    expect(() => RelationsConfigSchema.parse({ retrieval: { cosineFloor: 0.6 } })).toThrow();
    expect(() => RelationsConfigSchema.parse({ retrieval: { vectorK: 19 } })).toThrow();
    expect(() => RelationsConfigSchema.parse({ retrieval: { graphPoolK: 7 } })).toThrow();
    expect(() =>
      RelationsConfigSchema.parse({
        calibrations: [provisionalRelationCalibrations[0], provisionalRelationCalibrations[0]]
      })
    ).toThrow();
  });

  it("holds T58's frozen calibrations: no apply band, suggest from the tuning partition's edge", () => {
    const [mlx, gguf] = frozenRelationCalibrations;
    expect(relationsConfig.calibrations).toEqual(frozenRelationCalibrations);
    expect(findRelationCalibration(relationsConfig, mlx!.identity)).toEqual(mlx);
    expect(findRelationCalibration(relationsConfig, gguf!.identity)).toEqual(gguf);
    for (const entry of [mlx!, gguf!])
      expect(entry).toMatchObject({
        kind: "isotonic",
        applyFrom: null,
        identity: {
          // The F3 bake-off's `relation` instruction, 600 body characters, the mean of both directions.
          instructionSha256: "991ad3a617c4ca6cabab1cb8d45a5806b1e258ef0e5e80a7380d750a09b89c5b",
          bodyCharacters: 600,
          rule: "mean",
          template: "relation-pair-text-v1"
        },
        freezeHash: "745469e5a7acce86ece3f6d271a9646fd2f06116926080a34d9a9b371760b371"
      });
    expect([mlx!.identity.runtimeKind, gguf!.identity.runtimeKind]).toEqual(["mlx", "gguf"]);
    expect(bandScore(0.125, mlx!, 3.3125)).toMatchObject({
      band: "suggest",
      calibration: "frozen"
    });
    expect(bandScore(0.0625, mlx!, 3.3125).band).toBeNull();
    expect(bandScore(9, mlx!, 3.3125).band).toBe("suggest");
    expect(bandScore(0.62, gguf!, 3.16).band).toBe("suggest");
    expect(bandScore(0.6, gguf!, 3.16).band).toBeNull();
    // Plan decision 30: the Decisions API decider has its own identity (the product's online request
    // design) and D18's apply band on those requests.
    const decisions = frozenRelationCalibrations[2]!;
    expect(decisions).toMatchObject({
      kind: "isotonic",
      identity: {
        runtimeKind: "remote",
        provider: "openai",
        model: "gpt-6-luna",
        rule: "mean",
        requestDesignSha256: "dd6549321cda380a356b437d5958d9f11d59213823d978c6de231a8afc3bda66"
      },
      freezeHash: "ae14630a9389761b79b6dfb528d951ac7f5390fd2730549c1b6f74ceba23835a"
    });
    expect(findRelationCalibration(relationsConfig, decisions.identity)).toEqual(decisions);
    expect(bandScore(2.23, decisions, 3.3125).band).toBe("apply");
    expect(bandScore(2.2, decisions, 3.3125).band).toBe("suggest");
    expect(bandScore(1.6, decisions, 3.3125).band).toBe("suggest");
    expect(bandScore(1.59, decisions, 3.3125).band).toBeNull();
    // Spike A's provisional identity (mechanism, 400, max) is another identity: no calibration.
    for (const provisional of provisionalRelationCalibrations)
      expect(findRelationCalibration(relationsConfig, provisional.identity)).toBeNull();
    expect(findRelationCalibration(relationsConfig, { ...mlx!.identity, rule: "max" })).toBeNull();
    expect(
      findRelationCalibration(relationsConfig, { ...mlx!.identity, bodyCharacters: 400 })
    ).toBeNull();
  });
});

describe("the Decisions decider's config (plan decision 30)", () => {
  it("caps a day's spend at US$ 0.50 and suggests at Spike A2's pass while uncalibrated", () => {
    expect(relationsConfig.decisions).toEqual({
      dailyCapUsd: 0.5,
      uncalibratedPassLogOdds: 1.3249,
      // Plan decision 31b: a direction needs the two directional scores to differ by 1 log-odds.
      directionMarginLogOdds: 1
    });
    expect(
      RelationsConfigSchema.safeParse({ decisions: { directionMarginLogOdds: -1 } }).success
    ).toBe(false);
    // Spike A2's p >= 0.79, as log-odds.
    expect(relationsConfig.decisions.uncalibratedPassLogOdds).toBeCloseTo(Math.log(0.79 / 0.21), 3);
    expect(RelationsConfigSchema.safeParse({ decisions: { dailyCapUsd: -1 } }).success).toBe(false);
    // The cap has one ceiling, which a DEV proof run's override is held to as well.
    expect(
      RelationsConfigSchema.safeParse({ decisions: { dailyCapUsd: decisionsDailyCapMaxUsd } })
        .success
    ).toBe(true);
    expect(
      RelationsConfigSchema.safeParse({ decisions: { dailyCapUsd: decisionsDailyCapMaxUsd + 1 } })
        .success
    ).toBe(false);
    expect(RelationsConfigSchema.safeParse({ decisions: { dailyCapUsd: Infinity } }).success).toBe(
      false
    );
    expect(RelationsConfigSchema.safeParse({ decisions: { unknown: 1 } }).success).toBe(false);
  });
});

describe("relation pair text", () => {
  it("renders title, idea and the first body characters, Spike A's way", () => {
    expect(
      renderRelationPairText(
        { title: "T", ideaStatement: "I", bodyMarkdown: "  one\n\n two\tthree  " },
        400
      )
    ).toBe("Title: T\nIdea: I\nText: one two three");
    expect(
      renderRelationPairText({ title: "T", ideaStatement: "I", bodyMarkdown: "abcdef" }, 4)
    ).toBe("Title: T\nIdea: I\nText: abcd");
    // Code points, never half a surrogate pair.
    expect(
      renderRelationPairText({ title: "T", ideaStatement: "I", bodyMarkdown: "a😀b" }, 2)
    ).toBe("Title: T\nIdea: I\nText: a😀");
    expect(() =>
      renderRelationPairText({ title: "T", ideaStatement: "I", bodyMarkdown: "" }, 0)
    ).toThrow();
  });
});
