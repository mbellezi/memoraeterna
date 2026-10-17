import { describe, expect, it } from "vitest";

import { bandScore } from "./relation-calibration.js";
import { renderRelationPairText } from "./relation-pair-text.js";
import {
  findRelationCalibration,
  provisionalRelationCalibrations,
  relationsConfig,
  RelationsConfigSchema
} from "./relations-config.js";

describe("relations config", () => {
  it("holds the provisional values of gate 0 and the spec", () => {
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
      bodyCharacters: 400,
      rule: "max",
      uncalibratedPass: { logOdds: { mlx: 3.3125, gguf: 3.16 }, probability: 0.65 }
    });
    expect(relationsConfig.maxShownPerNote).toBe(10);
    expect(relationsConfig.hysteresisLogOdds).toBe(0.5);
    expect(relationsConfig.typing).toEqual({ pairsPerCall: 24, maxAttempts: 2, coalesceBelow: 6 });
    expect(relationsConfig.link).toEqual({ poolSize: 2, drainPoolSize: 1 });
    expect(relationsConfig.ai).toEqual({ maxBackgroundCallsPerDay: 500 });
    expect(relationsConfig.escalation).toEqual({ enabled: false });
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

  it("applies the provisional rule of each catalog ranker at Spike A's threshold, with no suggest band", () => {
    const [mlx, gguf] = provisionalRelationCalibrations;
    expect(findRelationCalibration(relationsConfig, mlx!.identity)).toEqual(mlx);
    expect(findRelationCalibration(relationsConfig, gguf!.identity)).toEqual(gguf);
    expect(bandScore(3.3125, mlx!, 3.3125).band).toBe("apply");
    expect(bandScore(3.3, mlx!, 3.3125).band).toBeNull();
    expect(bandScore(3.16, gguf!, 3.16).band).toBe("apply");
    expect(bandScore(3.15, gguf!, 3.16).band).toBeNull();
    // Another instruction or rule is another identity: no calibration.
    expect(findRelationCalibration(relationsConfig, { ...mlx!.identity, rule: "mean" })).toBeNull();
    expect(
      findRelationCalibration(relationsConfig, { ...mlx!.identity, bodyCharacters: 600 })
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
