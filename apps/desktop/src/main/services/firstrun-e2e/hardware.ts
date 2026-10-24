// What `hardware.profile` answers in the first-run harness (F4 T96, T97): a recorded profile, so the
// run does not depend on the machine it happens to run on and the tier card has the same input in
// every pass. The answer is T97's own shape, with the recommendation of the real tier table; the
// probe has its own tests on recorded macOS and Windows output. The harness plays the renderer,
// which reads the answer through the tier card's mapper (`onboardingHardwareOf`).
import { findLocalModelCatalogEntry, localModelExpectedSize } from "@app/ai";
import {
  HardwareProfileResultSchema,
  HardwareProfileSchema,
  recommendSetup,
  type HardwareProfileResult
} from "@app/domain";

/** An Apple silicon Mac with 48 GB, the machine of the owner's DEV profile, as a profile file holds it. */
const recordedProfile = HardwareProfileSchema.parse({
  version: 1,
  platform: "darwin",
  processArch: "arm64",
  nativeArch: "arm64",
  translated: false,
  osRelease: "25.0.0",
  cpu: { brand: "Apple M4 Max", physicalCores: 14, logicalCores: 14 },
  memoryBytes: 48 * 1024 ** 3,
  gpu: { kind: "apple", name: "Apple M4 Max", cores: 40, vramBytes: null },
  workingSet: { bytes: 36 * 1024 ** 3, source: "estimated" },
  npu: { present: true, name: "Apple Neural Engine" },
  complete: true,
  probedAt: "2026-10-24T00:00:00.000Z"
});

const recommendation = recommendSetup(recordedProfile);
const writer = recommendation.local.writerCatalogId
  ? findLocalModelCatalogEntry(recommendation.local.writerCatalogId)
  : undefined;

export const recordedHardwareProfile: HardwareProfileResult = HardwareProfileResultSchema.parse({
  profile: recordedProfile,
  freeDiskBytes: 512 * 1024 ** 3,
  localWriterBytes: writer ? localModelExpectedSize(writer) : null,
  recommendation
});
