import { describe, expect, it } from "vitest";

import { OnboardingHardwareSchema, localSetupAvailable } from "../../../shared/onboarding.js";
import { recordedHardwareProfile } from "./hardware.js";

describe("the profile the first-run harness plays", () => {
  it("is a recorded Apple silicon profile that the tier card reads, with Hybrid recommended", () => {
    expect(OnboardingHardwareSchema.parse(recordedHardwareProfile)).toEqual(
      recordedHardwareProfile
    );
    expect(localSetupAvailable(recordedHardwareProfile)).toBe(true);
    expect(recordedHardwareProfile.recommended).toBe("hybrid");
  });

  it("holds the allowlisted facts and no identifier of the machine or the person", () => {
    expect(Object.keys(recordedHardwareProfile).sort()).toEqual(
      [
        "chip",
        "estimates",
        "local",
        "memoryBytes",
        "nativeArch",
        "platform",
        "recommended",
        "translated",
        "workingSetBytes"
      ].sort()
    );
  });
});
