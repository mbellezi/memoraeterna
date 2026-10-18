import { describe, expect, it } from "vitest";

import { findLocalModelCatalogEntry } from "./local-model-catalog.js";
import {
  LocalMemoryBlockedError,
  availableMemoryBytes,
  memoryGuard,
  parseVmStat,
  residencyPlan
} from "./residency-plan.js";
import { defaultAiLaneRuntimeConfig } from "./runtime-config.js";

const gib = 1_024 ** 3;
const minimum = (id: string) => findLocalModelCatalogEntry(id)!.minimumMemoryBytes;
const group = {
  embed: minimum("gguf-qwen3-embedding-0.6b-q8-0"),
  rank: minimum("mlx-qwen3-reranker-0.6b")
};
const writers = {
  "qwen3.5-9b": minimum("mlx-qwen3.5-9b-4bit"),
  "qwen3-4b": minimum("mlx-qwen3-4b-instruct-2507-4bit"),
  "gemma-4-12b": minimum("mlx-gemma-4-12b-it-4bit")
};
const headroomBytes = defaultAiLaneRuntimeConfig.residency.headroomBytes;

describe("residencyPlan (F3 D39)", () => {
  it("uses the catalog minimums and the typed headroom", () => {
    expect(group).toEqual({ embed: 2 * gib, rank: 2 * gib });
    expect(writers).toEqual({
      "qwen3.5-9b": 12 * gib,
      "qwen3-4b": 8 * gib,
      "gemma-4-12b": 16 * gib
    });
    expect(headroomBytes).toBe(4 * gib);
  });

  // [memory GiB, writer, allowed, keep the ranker while the writer is loaded]
  const cases: Array<[number, keyof typeof writers, boolean, boolean]> = [
    [16, "qwen3-4b", true, true],
    [16, "qwen3.5-9b", true, false],
    [16, "gemma-4-12b", false, false],
    [24, "qwen3.5-9b", true, true],
    [24, "gemma-4-12b", true, true],
    [36, "qwen3.5-9b", true, true],
    [36, "gemma-4-12b", true, true],
    [64, "qwen3.5-9b", true, true],
    [64, "gemma-4-12b", true, true]
  ];
  it.each(cases)(
    "at %i GiB with %s: allowed %s, ranker kept %s",
    (memory, writer, allowed, keepRankDuringGeneration) => {
      expect(
        residencyPlan({
          totalMemoryBytes: memory * gib,
          resident: group,
          generative: writers[writer],
          headroomBytes
        })
      ).toEqual({ allowed, keepRankDuringGeneration });
    }
  );

  it("counts only the resident models a slot holds", () => {
    const plan = (resident: { embed?: number; rank?: number }) =>
      residencyPlan({
        totalMemoryBytes: 16 * gib,
        resident,
        generative: writers["qwen3.5-9b"],
        headroomBytes
      });
    expect(plan({})).toEqual({ allowed: true, keepRankDuringGeneration: true });
    expect(plan({ embed: group.embed })).toEqual({
      allowed: true,
      keepRankDuringGeneration: false
    });
  });
});

describe("the load guard", () => {
  it("needs the catalog minimum plus the margin in free and inactive memory", () => {
    const marginBytes = defaultAiLaneRuntimeConfig.residency.loadMarginBytes;
    expect(marginBytes).toBe(gib);
    expect(memoryGuard({ availableBytes: 13 * gib, minimumBytes: 12 * gib, marginBytes })).toEqual({
      allowed: true,
      requiredBytes: 13 * gib
    });
    expect(
      memoryGuard({ availableBytes: 13 * gib - 1, minimumBytes: 12 * gib, marginBytes })
    ).toEqual({ allowed: false, requiredBytes: 13 * gib });
  });

  it("is a visible local-model error that names what was missing", () => {
    const error = new LocalMemoryBlockedError("free", 13 * gib, 9 * gib);
    expect(error).toMatchObject({
      message: "errors.localModels.insufficient_memory",
      code: "blocked_memory",
      reason: "free",
      requiredBytes: 13 * gib,
      availableBytes: 9 * gib
    });
  });

  it("reads free, inactive and speculative pages from vm_stat", () => {
    const output = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                                   405350.",
      "Pages active:                                1513361.",
      "Pages inactive:                              1681924.",
      "Pages speculative:                             25215.",
      "Pages throttled:                                   0.",
      "Pages wired down:                             355995."
    ].join("\n");
    expect(parseVmStat(output)).toBe((405_350 + 1_681_924 + 25_215) * 16_384);
    expect(parseVmStat("Pages free: 10.")).toBeNull();
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)")).toBeNull();
  });

  it("reads this machine's available memory", async () => {
    const available = await availableMemoryBytes();
    expect(available).toBeGreaterThan(0);
  });
});
