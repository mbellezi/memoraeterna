import { describe, expect, it } from "vitest";

import { bandScore } from "./relation-calibration.js";
import { renderRelationPairText } from "./relation-pair-text.js";
import {
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
    expect(relationsConfig.escalation).toEqual({ enabled: false });
    expect(relationsConfig.discovery).toEqual({ neighbours: 1 });
    expect(relationsConfig.sourceJudge).toEqual({
      noteRelationsPerPair: 4,
      keepSimilarTo: false,
      exactEvidencePairs: 10_000,
      boundedEvidenceChunks: 16
    });
    expect(RelationsConfigSchema.safeParse({ discovery: { neighbours: 3 } }).success).toBe(false);
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
    // Spike A's provisional identity (mechanism, 400, max) is another identity: no calibration.
    for (const provisional of provisionalRelationCalibrations)
      expect(findRelationCalibration(relationsConfig, provisional.identity)).toBeNull();
    expect(findRelationCalibration(relationsConfig, { ...mlx!.identity, rule: "max" })).toBeNull();
    expect(
      findRelationCalibration(relationsConfig, { ...mlx!.identity, bodyCharacters: 400 })
    ).toBeNull();
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
