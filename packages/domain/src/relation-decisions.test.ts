import { describe, expect, it } from "vitest";

import { aiPresetIds } from "./ai-presets.js";
import {
  DecisionsSettingSchema,
  DecisionsStatusSchema,
  DecisionsStoredStateSchema,
  decisionsAvailableInPreset,
  decisionsDeciderPresets,
  relationsDecisionsCredentialRef
} from "./relation-decisions.js";

describe("the Decisions decider's presets", () => {
  it("is offered in Hybrid and Cloud only: never in Local, a custom setup or an unset one", () => {
    expect(decisionsDeciderPresets).toEqual(["hybrid", "cloud"]);
    expect(
      [...aiPresetIds, "custom" as const, null].map((preset) => [
        preset,
        decisionsAvailableInPreset(preset)
      ])
    ).toEqual([
      ["local", false],
      ["hybrid", true],
      ["cloud", true],
      ["custom", false],
      [null, false]
    ]);
  });
});

describe("the Decisions decider's stored shapes", () => {
  it("keeps its key under a fixed reference of the secure store, never in a setting", () => {
    expect(relationsDecisionsCredentialRef).toBe("ai:decisions-openai-platform");
    expect(DecisionsSettingSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it("starts with no invalid key, no use and no fallback", () => {
    expect(DecisionsStoredStateSchema.parse({})).toEqual({
      keyInvalid: false,
      lastUsedAt: null,
      fallback: null
    });
    expect(DecisionsSettingSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(DecisionsSettingSchema.safeParse({ enabled: true, apiKey: "sk-x" }).success).toBe(false);
  });

  it("has no place for a key in the status Settings reads", () => {
    const status = {
      state: "fallback",
      enabled: true,
      presetAllowed: true,
      keyStored: true,
      keyInvalid: false,
      fallbackReason: "spend_cap",
      model: "gpt-6-luna",
      priceInputPerMillionUsd: 0.1,
      spentTodayUsd: 0.5,
      dailyCapUsd: 0.5,
      requestsToday: 40,
      calibrated: false,
      lastUsedAt: null
    };
    expect(DecisionsStatusSchema.parse(status)).toEqual(status);
    expect(DecisionsStatusSchema.safeParse({ ...status, apiKey: "sk-secret" }).success).toBe(false);
    expect(DecisionsStatusSchema.safeParse({ ...status, fallbackReason: "other" }).success).toBe(
      false
    );
  });
});
