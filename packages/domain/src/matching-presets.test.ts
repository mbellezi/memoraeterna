import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MatchingConfigurationSchema, MatchingPresetsSchema, recommendedMatchingConfiguration, recommendedMatchingPresetId } from "./matching-presets.js";

describe("matching presets", () => {
  it("uses exactly the frozen, validated benchmark values", () => {
    const benchmark = JSON.parse(readFileSync(new URL("../../../docs/matching-benchmark-settings.json", import.meta.url), "utf8"));
    expect(recommendedMatchingConfiguration).toEqual(MatchingConfigurationSchema.parse(benchmark.settings));
  });
  it("rejects duplicate identities, invalid snapshots and attempts to replace the built-in preset", () => {
    const preset = { id: "afbec711-07cd-43b1-8088-153df3dc5f73", name: "Custom", settings: recommendedMatchingConfiguration };
    expect(MatchingPresetsSchema.safeParse([preset, preset]).success).toBe(false);
    expect(MatchingPresetsSchema.safeParse([{ ...preset, id: recommendedMatchingPresetId }]).success).toBe(false);
    expect(MatchingPresetsSchema.safeParse([{ ...preset, settings: { ...preset.settings, sourceRelationSettings: { ...preset.settings.sourceRelationSettings, maxPairs: 0 } } }]).success).toBe(false);
    expect(MatchingPresetsSchema.safeParse([{ ...preset, name: " " }]).success).toBe(false);
  });
});
