import {
  HardwareProfileSchema,
  defaultHardwareTierConfig,
  hardwareTierIds,
  presetCatalogIds,
  recommendSetup,
  type HardwareProfile
} from "@app/domain";
import { describe, expect, it } from "vitest";

import { findLocalModelCatalogEntry, localModelCatalog } from "./local-model-catalog.js";

const gib = 1024 ** 3;

function machine(overrides: Record<string, unknown>): HardwareProfile {
  return HardwareProfileSchema.parse({
    version: 1,
    platform: "darwin",
    processArch: "arm64",
    nativeArch: "arm64",
    translated: false,
    osRelease: "25.0.0",
    cpu: { brand: "Apple M4 Max", physicalCores: 16, logicalCores: 16 },
    memoryBytes: 64 * gib,
    gpu: { kind: "apple", name: "Apple M4 Max", cores: 40, vramBytes: null },
    workingSet: null,
    npu: { present: true, name: "Apple Neural Engine" },
    complete: true,
    probedAt: "2026-10-24T10:00:00.000Z",
    ...overrides
  });
}

/** A grid of machines over every platform, architecture and memory size the tier table distinguishes. */
function grid(): HardwareProfile[] {
  const memories = [4, 8, 12, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 512];
  const discrete = {
    kind: "discrete",
    name: "NVIDIA GeForce RTX 4090",
    cores: null,
    vramBytes: 24 * gib
  };
  const profiles: HardwareProfile[] = [];
  for (const memory of memories) {
    const memoryBytes = memory * gib;
    profiles.push(
      machine({ memoryBytes }),
      machine({ memoryBytes, processArch: "x64", translated: true }),
      machine({ memoryBytes, processArch: "x64", nativeArch: "x64" }),
      machine({
        memoryBytes,
        platform: "win32",
        processArch: "x64",
        nativeArch: "x64",
        gpu: discrete,
        workingSet: null
      }),
      machine({
        memoryBytes,
        platform: "win32",
        processArch: "arm64",
        nativeArch: "arm64",
        gpu: {
          kind: "integrated",
          name: "Qualcomm(R) Adreno(TM) X1-85 GPU",
          cores: null,
          vramBytes: null
        },
        workingSet: null
      }),
      machine({ memoryBytes, platform: "linux", processArch: "x64", nativeArch: "x64" })
    );
  }
  return profiles;
}

describe("the tier table suggests only today's catalog models (decision 26)", () => {
  const writers = [presetCatalogIds.writerLarge, presetCatalogIds.writerSmall];

  it("names no writer outside the presets' two, and both are in the catalog", () => {
    expect(Object.keys(defaultHardwareTierConfig.localWriters).sort()).toEqual([...writers].sort());
    for (const id of writers)
      expect(findLocalModelCatalogEntry(id)).toMatchObject({
        runtime: "mlx",
        capabilities: expect.arrayContaining(["text-generation", "structured-output"])
      });
  });

  it("suggests, over every platform and memory size, only a catalog writer the presets already use", () => {
    const suggested = new Set<string>();
    const tiers = new Set<string>();
    for (const profile of grid()) {
      const { local, tier } = recommendSetup(profile);
      tiers.add(tier);
      if (local.writerCatalogId) suggested.add(local.writerCatalogId);
      // A writer is only ever named where the presets can run Local: Apple silicon with MLX.
      if (profile.platform !== "darwin" || profile.nativeArch !== "arm64")
        expect(local.writerCatalogId).toBeNull();
    }
    expect([...suggested].sort()).toEqual([...writers].sort());
    for (const id of suggested) expect(findLocalModelCatalogEntry(id)).toBeDefined();
    expect([...tiers].sort()).toEqual([...hardwareTierIds].sort());
  });

  it("recommends no local writer until the owner verifies a quality class", () => {
    expect(defaultHardwareTierConfig.verifiedQualityClasses).toEqual([]);
    for (const profile of grid()) expect(recommendSetup(profile).recommended).not.toBe("local");
  });

  it("prices only models of a price entry, never a catalog model it would download", () => {
    const catalogIds = new Set(localModelCatalog.map((entry) => entry.id));
    for (const reference of Object.values(defaultHardwareTierConfig.costReferences))
      expect(catalogIds.has(reference.model)).toBe(false);
  });
});
