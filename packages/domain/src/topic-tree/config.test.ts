import { describe, expect, it } from "vitest";

import {
  TopicTreeConfigSchema,
  canonicalTopicTreeConfig,
  defaultTopicTreeConfig,
  topicTreeConfigForPreset,
  topicTreeConfigWith,
  topicTreePresets
} from "./config.js";
import type { TopicTreeConfig } from "./config.js";

/** Leaf values of a configuration, keyed `group.field`. */
function flatten(config: TopicTreeConfig): Map<string, unknown> {
  const output = new Map<string, unknown>();
  for (const [group, values] of Object.entries(config)) {
    for (const [field, value] of Object.entries(values as Record<string, unknown>)) {
      output.set(`${group}.${field}`, value);
    }
  }
  return output;
}

describe("topic tree configuration", () => {
  it("starts from the Spike B and F2 decision values", () => {
    const config = defaultTopicTreeConfig;
    expect(config.fanOut).toEqual({
      min: 2,
      max: 12,
      targetMin: 4,
      targetMax: 9,
      hardMax: 16,
      rootTarget: 9
    });
    expect(config.leaf).toEqual({
      min: 3,
      max: 30,
      target: 15,
      hardMax: 45,
      minForTargetFanOut: 8
    });
    expect(config.depth).toEqual({ target: 5, cap: 7 });
    expect(config.placement).toMatchObject({
      beam: 3,
      admissionFloor: 0.15,
      leafFloor: 0,
      spreadFactor: 2.5,
      spreadFloor: 0.03,
      ambiguityMargin: 0.01,
      labelWeight: 0
    });
    expect(config.gate).toMatchObject({
      maxCandidates: 5,
      temperature: 1,
      tau: 0,
      theta: 0.5,
      queryTextMaxChars: 400
    });
    expect(config.secondary.max).toBe(2);
    expect(config.items.sourceReplaceCosine).toBe(0.98);
    expect(config.repair).toEqual({
      directItemsSplitAt: 8,
      mergeMaxSize: 22,
      siblingMergeCosine: 0.85,
      cooldownInserts: 10,
      cooldownShare: 0.083,
      pushDownGroupSize: 6,
      sidewaysSplitLimit: "targetMax",
      softMoveShare: 0.05
    });
    expect(config.splitSignal).toEqual({ signal: "off", threshold: null });
    expect(config.louvain).toMatchObject({ knn: 10, resolutionTries: 8, resolutionStep: 1.6 });
    expect(config.knn).toEqual({ exactLimit: 3000, nprobe: 8 });
    expect(config.bootstrap).toMatchObject({ minItems: 12, singleTopicMaxItems: 30 });
    expect(config.rebuild).toMatchObject({ hungarianExactMaxTopics: 300 });
    expect(config.naming).toMatchObject({ maxTopicsPerCall: 24, centralMembers: 5 });
    expect(config.areas).toMatchObject({ min: 7, max: 16 });
    expect(config.ai.areasRepairMaxMissingShare).toBe(0.1);
    expect(config.audit.misParentMargin).toBe(0.1);
    expect(config.space.reembedCoverage).toBe(0.95);
    expect(config.unsorted).toEqual({ shareTarget: 0.02, minItems: 50 });
    expect(config.ai.maxBackgroundCallsPerDay).toBe(270);
    expect(config.jobs).toEqual({ debounceMs: 10_000, debounceCapMs: 60_000 });
    expect(config.build.workerThreshold).toBe(45);
  });

  it("holds the stability values the E3 calibration chose (calibration seeds 7-12)", () => {
    const config = defaultTopicTreeConfig;
    // Gate A (dailyMovedShare, dailyMovedMin, misParentMargin) and T29b grid S (lambda, fresh
    // items, the cooldown scaled with the library: max(10, 0.083 x items)).
    expect(config.stability).toEqual({
      churnWeight: 4,
      recentChurnWeight: 3,
      freezeHours: 24,
      freshHours: 24,
      dailyOperations: 60,
      dailyMovedShare: 0.002,
      dailyMovedMin: 30
    });
    expect(config.repair).toMatchObject({ cooldownInserts: 10, cooldownShare: 0.083 });
    expect(config.audit.misParentMargin).toBe(0.1);
  });

  it("holds the structure values T29b calibrated (calibration seeds 7-12)", () => {
    const config = defaultTopicTreeConfig;
    // Rule F: leaves split sideways only while their parent stays in I3's target band.
    expect(config.repair.sidewaysSplitLimit).toBe("targetMax");
    // Rules DB and Q: the rebuild triggers; review only for an established share past 0.25.
    expect(config.rebuild).toMatchObject({
      doublingMaxItems: 1000,
      qualityDrop: 0.03,
      unadmittedBurstShare: 0.1,
      unadmittedBurstMinItems: 20,
      reviewChurnShare: 0.25
    });
    // Rule B: the cold start of a small library.
    expect(config.bootstrap).toMatchObject({
      minItems: 12,
      singleTopicMaxItems: 30,
      maxInitialSplit: 4,
      modularityMin: 0.2
    });
    // Rule R: renameDrift (the registered fallback; the 2% weekly bar is not met by any value).
    expect(config.naming.renameDrift).toBe(0.5);
    // Rule A: the Areas band, target and the level-2 topics a grouping needs.
    expect(config.areas).toMatchObject({ min: 7, max: 16, target: 10, minLevel2Topics: 20 });
    // D34: three times the busiest day of background topic AI calls (89), rounded up to tens.
    expect(config.ai.maxBackgroundCallsPerDay).toBe(270);
  });

  it("holds the placement and gate values T29a calibrated (calibration seeds 7-12)", () => {
    const config = defaultTopicTreeConfig;
    // T29a's adopted configOverrides: only the ambiguity margin moved from its start value
    // (0.015); T29b's rule FC confirmed it with the stability defaults above.
    const adopted: Record<string, unknown> = {
      "placement.spreadFactor": 2.5,
      "placement.admissionFloor": 0.15,
      "placement.spreadFloor": 0.03,
      "placement.leafFloor": 0,
      "placement.ambiguityMargin": 0.01,
      "placement.labelWeight": 0,
      "gate.temperature": 1,
      "gate.tau": 0,
      "gate.theta": 0.5,
      "splitSignal.signal": "off",
      "splitSignal.threshold": null,
      "repair.siblingMergeCosine": 0.85,
      "audit.misParentMargin": 0.1
    };
    const values = flatten(config);
    const actual = Object.fromEntries(Object.keys(adopted).map((path) => [path, values.get(path)]));
    expect(actual).toEqual(adopted);
  });

  it("is frozen so no consumer can change a default", () => {
    expect(Object.isFrozen(defaultTopicTreeConfig)).toBe(true);
    expect(Object.isFrozen(defaultTopicTreeConfig.fanOut)).toBe(true);
    expect(() => {
      (defaultTopicTreeConfig.fanOut as { max: number }).max = 99;
    }).toThrow();
  });

  it("rejects unknown fields and inconsistent ranges", () => {
    for (const input of [
      { unknown: true },
      { fanOut: { extra: 1 } },
      { fanOut: { min: 5, targetMin: 4 } },
      { fanOut: { max: 20 } },
      { fanOut: { rootTarget: 14 } },
      { leaf: { max: 50 } },
      { leaf: { target: 40 } },
      { depth: { target: 8, cap: 7 } },
      { areas: { max: 17 } },
      { ai: { areasRepairMaxMissingShare: 1.5 } },
      { areas: { min: 11, target: 10 } },
      { placement: { ambiguityMargin: -0.1 } },
      { gate: { theta: 1.5 } },
      { secondary: { max: 3 } },
      { splitSignal: { signal: "coherence" } },
      { jobs: { debounceMs: 70_000 } },
      { repair: { mergeMaxSize: 50 } }
    ]) {
      expect(TopicTreeConfigSchema.safeParse(input).success).toBe(false);
    }
    expect(
      TopicTreeConfigSchema.safeParse({ splitSignal: { signal: "coherence", threshold: 0.6 } })
        .success
    ).toBe(true);
  });

  it("overrides groups and validates the result", () => {
    const config = topicTreeConfigWith({
      placement: { ambiguityMargin: 0.02 },
      gate: { theta: 0.6 }
    });
    expect(config.placement.ambiguityMargin).toBe(0.02);
    expect(config.placement.spreadFactor).toBe(2.5);
    expect(config.gate.theta).toBe(0.6);
    expect(() => topicTreeConfigWith({ leaf: { max: 60 } })).toThrow();
  });

  it("presets shift only the soft I3 and I4 ranges and targets", () => {
    const allowed = new Set([
      "fanOut.min",
      "fanOut.max",
      "fanOut.targetMin",
      "fanOut.targetMax",
      "leaf.min",
      "leaf.max",
      "leaf.target"
    ]);
    const base = flatten(defaultTopicTreeConfig);
    for (const preset of topicTreePresets) {
      const shifted = flatten(topicTreeConfigForPreset(preset));
      for (const [key, value] of shifted) {
        if (!allowed.has(key)) expect([preset, key, value]).toEqual([preset, key, base.get(key)]);
      }
    }
    expect(topicTreeConfigForPreset("balanced")).toEqual(defaultTopicTreeConfig);
    const broad = topicTreeConfigForPreset("broad");
    const deep = topicTreeConfigForPreset("deep");
    expect(broad.leaf.target).toBeGreaterThan(defaultTopicTreeConfig.leaf.target);
    expect(broad.fanOut.targetMax).toBeGreaterThan(defaultTopicTreeConfig.fanOut.targetMax);
    expect(deep.leaf.target).toBeLessThan(defaultTopicTreeConfig.leaf.target);
    expect(deep.fanOut.targetMax).toBeLessThan(defaultTopicTreeConfig.fanOut.targetMax);
    for (const config of [broad, deep]) {
      expect(config.fanOut.hardMax).toBe(defaultTopicTreeConfig.fanOut.hardMax);
      expect(config.leaf.hardMax).toBe(defaultTopicTreeConfig.leaf.hardMax);
    }
  });

  it("serializes canonically for the config hash", () => {
    const json = canonicalTopicTreeConfig(defaultTopicTreeConfig);
    const reordered = TopicTreeConfigSchema.parse(
      Object.fromEntries(Object.entries(defaultTopicTreeConfig).reverse())
    );
    expect(canonicalTopicTreeConfig(reordered)).toBe(json);
    expect(
      json.startsWith('{"ai":{"areasRepairMaxMissingShare":0.1,"maxBackgroundCallsPerDay":270}')
    ).toBe(true);
    expect(canonicalTopicTreeConfig(topicTreeConfigWith({ gate: { theta: 0.6 } }))).not.toBe(json);
  });
});
