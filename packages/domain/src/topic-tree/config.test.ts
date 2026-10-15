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
      ambiguityMargin: 0.015,
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
      cooldownInserts: 25,
      pushDownGroupSize: 6,
      softMoveShare: 0.05
    });
    expect(config.splitSignal).toEqual({ signal: "off", threshold: null });
    expect(config.louvain).toMatchObject({ knn: 10, resolutionTries: 8, resolutionStep: 1.6 });
    expect(config.knn).toEqual({ exactLimit: 3000, nprobe: 8 });
    expect(config.bootstrap).toMatchObject({ minItems: 12, singleTopicMaxItems: 30 });
    expect(config.rebuild).toMatchObject({ doublingMaxItems: 1000, hungarianExactMaxTopics: 300 });
    expect(config.naming).toMatchObject({
      maxTopicsPerCall: 24,
      centralMembers: 5,
      renameDrift: 0.3
    });
    expect(config.areas).toMatchObject({ min: 7, max: 16, target: 10 });
    expect(config.audit.misParentMargin).toBe(0.05);
    expect(config.space.reembedCoverage).toBe(0.95);
    expect(config.unsorted).toEqual({ shareTarget: 0.02, minItems: 50 });
    expect(config.ai.maxBackgroundCallsPerDay).toBe(300);
    expect(config.jobs).toEqual({ debounceMs: 10_000, debounceCapMs: 60_000 });
    expect(config.build.workerThreshold).toBe(45);
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
    expect(json.startsWith('{"ai":{"maxBackgroundCallsPerDay":300}')).toBe(true);
    expect(canonicalTopicTreeConfig(topicTreeConfigWith({ gate: { theta: 0.6 } }))).not.toBe(json);
  });
});
