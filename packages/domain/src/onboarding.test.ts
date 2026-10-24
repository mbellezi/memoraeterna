import { describe, expect, it } from "vitest";

import {
  OnboardingFinishInputSchema,
  OnboardingStateSchema,
  isOnboardingDue,
  onboardingSettingKey,
  onboardingStateOf,
  readOnboardingRecord
} from "./onboarding.js";

const at = "2026-10-24T10:00:00.000Z";

describe("the onboarding record", () => {
  it("keeps its row name and reads only a complete record", () => {
    expect(onboardingSettingKey).toBe("onboarding.v1");
    expect(readOnboardingRecord({ version: 1, outcome: "completed", at })).toEqual({
      version: 1,
      outcome: "completed",
      at
    });
    expect(readOnboardingRecord({ version: 1, outcome: "skipped", at })?.outcome).toBe("skipped");
  });

  it("treats a missing or unreadable row as unset, so the first run is due again", () => {
    for (const stored of [
      null,
      undefined,
      "completed",
      {},
      { version: 2, outcome: "completed", at },
      { version: 1, outcome: "later", at },
      { version: 1, outcome: "completed", at: "yesterday" },
      { version: 1, outcome: "completed", at, extra: true }
    ])
      expect(readOnboardingRecord(stored), JSON.stringify(stored)).toBeNull();
  });
});

describe("when the first run is due", () => {
  it("is due only for an empty library with no record", () => {
    const record = readOnboardingRecord({ version: 1, outcome: "skipped", at });
    expect(isOnboardingDue(null, true)).toBe(true);
    expect(isOnboardingDue(null, false)).toBe(false);
    expect(isOnboardingDue(record, true)).toBe(false);
    expect(isOnboardingDue(record, false)).toBe(false);
  });

  it("builds the state the renderer reads and keeps it consistent", () => {
    const record = readOnboardingRecord({ version: 1, outcome: "completed", at });
    expect(onboardingStateOf(null, true)).toEqual({
      outcome: null,
      at: null,
      libraryEmpty: true,
      show: true
    });
    expect(onboardingStateOf(record, true)).toEqual({
      outcome: "completed",
      at,
      libraryEmpty: true,
      show: false
    });
    for (const state of [onboardingStateOf(null, false), onboardingStateOf(record, false)])
      expect(OnboardingStateSchema.parse(state).show).toBe(false);
    expect(() =>
      OnboardingStateSchema.parse({ outcome: null, at: null, libraryEmpty: false, show: true })
    ).toThrow();
  });

  it("accepts a finish request of either outcome and nothing else", () => {
    expect(OnboardingFinishInputSchema.parse({ outcome: "skipped" })).toEqual({
      outcome: "skipped"
    });
    expect(() => OnboardingFinishInputSchema.parse({ outcome: "pending" })).toThrow();
    expect(() => OnboardingFinishInputSchema.parse({ outcome: "completed", at })).toThrow();
  });
});
