import { describe, expect, it } from "vitest";

import { nonGoldenTopicsConfig, readGoldenTopicsConfig } from "./golden-topics.js";

const dev = { isPackaged: false };

describe("G1: MEMORA_GOLDEN_TOPICS (D23)", () => {
  it("is deterministic with a per-source arrival by default in a golden run", () => {
    expect(readGoldenTopicsConfig({ MEMORA_GOLDEN_RUN: "m.json" }, dev)).toEqual({
      golden: true,
      mode: "deterministic",
      arrival: "per-source"
    });
    expect(
      readGoldenTopicsConfig({ MEMORA_GOLDEN_RUN: "m.json", MEMORA_GOLDEN_TOPICS: "  " }, dev)
    ).toMatchObject({ mode: "deterministic" });
  });

  it("is ignored without MEMORA_GOLDEN_RUN: every other run behaves as full", () => {
    for (const env of [
      {},
      { MEMORA_GOLDEN_TOPICS: "deterministic" },
      { MEMORA_GOLDEN_TOPICS: "deterministic", MEMORA_GOLDEN_TOPICS_ARRIVAL: "batch" },
      { MEMORA_GOLDEN_RUN: "  ", MEMORA_GOLDEN_TOPICS: "deterministic" },
      // Not even a malformed value is an error where the knob is not read.
      { MEMORA_GOLDEN_TOPICS: "nonsense", MEMORA_GOLDEN_TOPICS_ARRIVAL: "nonsense" }
    ])
      expect(readGoldenTopicsConfig(env, dev)).toEqual(nonGoldenTopicsConfig);
    expect(nonGoldenTopicsConfig).toEqual({ golden: false, mode: "full", arrival: "per-source" });
  });

  it("is ignored in a packaged build, which refuses golden runs anyway", () => {
    expect(
      readGoldenTopicsConfig(
        { MEMORA_GOLDEN_RUN: "m.json", MEMORA_GOLDEN_TOPICS: "deterministic" },
        { isPackaged: true }
      )
    ).toEqual(nonGoldenTopicsConfig);
  });

  it("reads full and the arrival of a full run", () => {
    const env = { MEMORA_GOLDEN_RUN: "m.json", MEMORA_GOLDEN_TOPICS: "full" };
    expect(readGoldenTopicsConfig(env, dev)).toEqual({
      golden: true,
      mode: "full",
      arrival: "per-source"
    });
    expect(
      readGoldenTopicsConfig({ ...env, MEMORA_GOLDEN_TOPICS_ARRIVAL: "batch" }, dev)
    ).toMatchObject({ mode: "full", arrival: "batch" });
    expect(
      readGoldenTopicsConfig({ ...env, MEMORA_GOLDEN_TOPICS_ARRIVAL: "per-source" }, dev)
    ).toMatchObject({ arrival: "per-source" });
  });

  it("rejects unknown values inside a golden run, and an arrival without full", () => {
    const run = { MEMORA_GOLDEN_RUN: "m.json" };
    expect(() => readGoldenTopicsConfig({ ...run, MEMORA_GOLDEN_TOPICS: "partial" }, dev)).toThrow(
      "MEMORA_GOLDEN_TOPICS must be deterministic or full"
    );
    expect(() =>
      readGoldenTopicsConfig(
        { ...run, MEMORA_GOLDEN_TOPICS: "full", MEMORA_GOLDEN_TOPICS_ARRIVAL: "daily" },
        dev
      )
    ).toThrow("MEMORA_GOLDEN_TOPICS_ARRIVAL must be per-source or batch");
    expect(() =>
      readGoldenTopicsConfig({ ...run, MEMORA_GOLDEN_TOPICS_ARRIVAL: "batch" }, dev)
    ).toThrow("only applies with MEMORA_GOLDEN_TOPICS=full");
    expect(() =>
      readGoldenTopicsConfig(
        { ...run, MEMORA_GOLDEN_TOPICS: "deterministic", MEMORA_GOLDEN_TOPICS_ARRIVAL: "batch" },
        dev
      )
    ).toThrow("only applies with MEMORA_GOLDEN_TOPICS=full");
  });
});
