import { defaultTopicTreeConfig, topicTreeConfigWith } from "@app/domain/topic-tree";
import type { TopicTreeConfig } from "@app/domain/topic-tree";
import { describe, expect, it } from "vitest";

import { structuralConfigGroups, structuralConfigHash } from "./topic-tree-service.js";

describe("the structural configuration hash (D39)", () => {
  const base = structuralConfigHash(defaultTopicTreeConfig);

  it("ignores operational settings: the daily cap, the debounce, audits, naming, overviews", () => {
    for (const overrides of [
      { ai: { maxBackgroundCallsPerDay: 5 } },
      { ai: { areasRepairMaxMissingShare: 0.3 } },
      { jobs: { debounceMs: 1_000, debounceCapMs: 2_000 } },
      { audit: { everyChangeSets: 7 } },
      { naming: { renameDrift: 0.5 } },
      { overview: { maxEvidenceItems: 3 } },
      { build: { workerThreshold: 100 } },
      { stability: { dailyOperations: 3 } }
    ]) {
      expect(structuralConfigHash(topicTreeConfigWith(overrides)), JSON.stringify(overrides)).toBe(
        base
      );
    }
  });

  it("changes with build, placement, shape and Areas parameters", () => {
    for (const overrides of [
      { leaf: { target: 14 } },
      { fanOut: { targetMax: 8 } },
      { placement: { ambiguityMargin: 0.02 } },
      { gate: { theta: 0.6 } },
      { louvain: { resolution: 1.2 } },
      { bootstrap: { minItems: 20 } },
      { areas: { target: 9 } }
    ]) {
      expect(
        structuralConfigHash(topicTreeConfigWith(overrides)),
        JSON.stringify(overrides)
      ).not.toBe(base);
    }
  });

  it("does not depend on key order and names only real configuration groups", () => {
    const reordered = Object.fromEntries(
      Object.entries(defaultTopicTreeConfig).reverse()
    ) as unknown as TopicTreeConfig;
    expect(structuralConfigHash(reordered)).toBe(base);
    for (const group of structuralConfigGroups)
      expect(defaultTopicTreeConfig).toHaveProperty(group);
  });
});
