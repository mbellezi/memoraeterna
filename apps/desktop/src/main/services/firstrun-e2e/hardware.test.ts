import { HardwareProfileResultSchema } from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  OnboardingHardwareSchema,
  localSetupAvailable,
  onboardingHardwareOf
} from "../../../shared/onboarding.js";
import { recordedHardwareProfile } from "./hardware.js";

describe("the profile the first-run harness plays", () => {
  it("is T97's answer for a recorded Apple silicon Mac, with Hybrid recommended and Local offered", () => {
    expect(HardwareProfileResultSchema.parse(recordedHardwareProfile)).toEqual(
      recordedHardwareProfile
    );
    expect(recordedHardwareProfile.recommendation.recommended).toBe("hybrid");
    expect(recordedHardwareProfile.recommendation.local.offer).toBe("available");
    expect(recordedHardwareProfile.localWriterBytes).toBeGreaterThan(0);
  });

  it("reads as the tier card's facts the way the renderer reads it", () => {
    const card = onboardingHardwareOf(recordedHardwareProfile);
    expect(OnboardingHardwareSchema.parse(card)).toEqual(card);
    expect(card).toMatchObject({
      platform: "darwin",
      nativeArch: "arm64",
      translated: false,
      chip: "Apple M4 Max",
      memoryBytes: 48 * 1024 ** 3,
      recommended: "hybrid"
    });
    expect(localSetupAvailable(card)).toBe(true);
    expect(card.local.writerCatalogId).toBe(
      recordedHardwareProfile.recommendation.local.writerCatalogId
    );
  });

  it("holds the allowlisted facts and no identifier of the machine or the person", () => {
    expect(Object.keys(recordedHardwareProfile.profile).sort()).toEqual(
      [
        "complete",
        "cpu",
        "gpu",
        "memoryBytes",
        "nativeArch",
        "npu",
        "osRelease",
        "platform",
        "probedAt",
        "processArch",
        "translated",
        "version",
        "workingSet"
      ].sort()
    );
  });
});
