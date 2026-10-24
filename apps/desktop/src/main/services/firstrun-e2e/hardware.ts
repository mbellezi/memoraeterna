// What `hardware.profile` answers in the first-run harness (F4 T96): a recorded profile, so the run
// does not depend on the machine it happens to run on and the tier card has the same input in
// every pass. The probe and the tier table are T97's, with their own tests on recorded macOS and
// Windows output; the harness plays the renderer, which only reads the answer.
import { OnboardingHardwareSchema, type OnboardingHardware } from "../../../shared/onboarding.js";

/** An Apple silicon Mac with 48 GB, the machine of the owner's DEV profile, as a profile file would hold it. */
export const recordedHardwareProfile: OnboardingHardware = OnboardingHardwareSchema.parse({
  platform: "darwin",
  nativeArch: "arm64",
  translated: false,
  chip: "Apple M4 Max",
  memoryBytes: 48 * 1024 ** 3,
  workingSetBytes: 36 * 1024 ** 3,
  recommended: "hybrid",
  estimates: [
    { preset: "local", monthlyUsd: null },
    { preset: "hybrid", monthlyUsd: 0.39 },
    { preset: "cloud", monthlyUsd: 0.45 }
  ]
});
