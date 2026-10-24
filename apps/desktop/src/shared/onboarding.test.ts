import { describe, expect, it } from "vitest";

import { OnboardingHardwareSchema, localSetupAvailable } from "./onboarding";

const base = {
  platform: "darwin",
  nativeArch: "arm64",
  translated: false,
  chip: "Apple M4 Pro",
  memoryBytes: 24 * 1024 ** 3,
  workingSetBytes: null,
  recommended: "hybrid",
  estimates: []
} as const;

describe("what the first run reads of this computer", () => {
  it("accepts the allowlisted facts and nothing else", () => {
    expect(OnboardingHardwareSchema.parse(base)).toEqual(base);
    expect(() => OnboardingHardwareSchema.parse({ ...base, serialNumber: "C02XYZ" })).toThrow();
    expect(() => OnboardingHardwareSchema.parse({ ...base, hostname: "my-mac" })).toThrow();
    expect(() => OnboardingHardwareSchema.parse({ ...base, recommended: "custom" })).toThrow();
    expect(() => OnboardingHardwareSchema.parse({ ...base, memoryBytes: -1 })).toThrow();
  });

  it("runs Local on macOS with an Apple silicon processor, translated or not, and nowhere else", () => {
    expect(localSetupAvailable(base)).toBe(true);
    const throughRosetta = { ...base, translated: true };
    expect(localSetupAvailable(throughRosetta)).toBe(true);
    expect(localSetupAvailable({ ...base, nativeArch: "x64" })).toBe(false);
    expect(localSetupAvailable({ ...base, platform: "win32" })).toBe(false);
    expect(localSetupAvailable({ ...base, platform: "linux" })).toBe(false);
  });
});
