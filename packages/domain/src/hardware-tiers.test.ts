import { describe, expect, it } from "vitest";

import { presetCatalogIds } from "./ai-presets.js";
import {
  HardwareProfileResultSchema,
  HardwareProfileSchema,
  HardwareTierConfigSchema,
  classifyHardware,
  defaultHardwareTierConfig,
  estimateAppleWorkingSetBytes,
  hardwareTierIds,
  hardwareTierRows,
  isPublicDeviceLabel,
  localWriterBudgetBytes,
  presetCosts,
  presetMachineFromProfile,
  recommendSetup,
  type HardwareProfile,
  type HardwareTierConfig,
  type HardwareTierId
} from "./hardware-tiers.js";
import { defaultPriceTable, PriceTableSchema } from "./price-table.js";

const gib = 1024 ** 3;

function profile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
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

const mac = (memoryGiB: number, overrides: Partial<HardwareProfile> = {}) =>
  profile({ memoryBytes: memoryGiB * gib, ...overrides });

const windows = (
  memoryGiB: number,
  gpu: HardwareProfile["gpu"],
  overrides: Partial<HardwareProfile> = {}
) =>
  profile({
    platform: "win32",
    processArch: "x64",
    nativeArch: "x64",
    memoryBytes: memoryGiB * gib,
    gpu,
    workingSet: null,
    npu: { present: false, name: null },
    ...overrides
  });

const noGpu = { kind: "none", name: null, cores: null, vramBytes: null } as const;
const igpu = {
  kind: "integrated",
  name: "Intel(R) Arc(TM) Graphics",
  cores: null,
  vramBytes: null
};
const rtx = (vramGiB: number) => ({
  kind: "discrete" as const,
  name: "NVIDIA GeForce RTX 4090",
  cores: null,
  vramBytes: vramGiB * gib
});

/** One machine per row of the table. */
const representatives: Record<HardwareTierId, HardwareProfile> = {
  "apple-8": mac(8),
  "apple-16": mac(16),
  "apple-24": mac(24),
  "apple-32": mac(32),
  "apple-48": mac(48),
  "apple-64": mac(64),
  "apple-96": mac(96),
  "apple-128": mac(128),
  "mac-intel": mac(32, { nativeArch: "x64", processArch: "x64" }),
  "windows-basic": windows(8, igpu),
  "windows-standard": windows(16, igpu),
  "windows-large": windows(64, rtx(24)),
  other: profile({ platform: "linux", nativeArch: "x64", processArch: "x64" })
};

describe("the hardware profile contract (F4 D32)", () => {
  it("holds an allowlist of fields and nothing else", () => {
    expect(Object.keys(HardwareProfileSchema.shape).sort()).toEqual(
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
    expect(Object.keys(HardwareProfileSchema.shape.cpu.shape).sort()).toEqual([
      "brand",
      "logicalCores",
      "physicalCores"
    ]);
    expect(Object.keys(HardwareProfileSchema.shape.gpu.shape).sort()).toEqual([
      "cores",
      "kind",
      "name",
      "vramBytes"
    ]);
    const base = profile();
    for (const extra of ["serialNumber", "hostName", "platformUuid", "userName"])
      expect(HardwareProfileSchema.safeParse({ ...base, [extra]: "x" }).success).toBe(false);
    expect(
      HardwareProfileSchema.safeParse({ ...base, cpu: { ...base.cpu, id: "x" } }).success
    ).toBe(false);
  });

  it("refuses a device label that identifies the machine, its owner or its network", () => {
    for (const label of [
      "Apple M4 Max",
      "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz",
      "NVIDIA GeForce RTX 4090",
      "Snapdragon(R) X Elite - X1E78100 - Qualcomm(R) Hexagon(TM) NPU"
    ])
      expect(isPublicDeviceLabel(label)).toBe(true);
    for (const label of [
      "C02XYZ serial number",
      "4C4C4544-0042-3510-8051-B5C04F4E4B32",
      "a4:83:e7:12:34:56",
      "/Users/someone/Library",
      "C:\\Users\\João",
      "DESKTOP hostname",
      "provisioning UDID",
      "line\nbreak"
    ])
      expect(isPublicDeviceLabel(label)).toBe(false);
    expect(
      HardwareProfileSchema.safeParse({
        ...profile(),
        cpu: { brand: "4C4C4544-0042-3510-8051-B5C04F4E4B32", physicalCores: 1, logicalCores: 1 }
      }).success
    ).toBe(false);
  });

  it("is what the IPC answer carries, validated whole", () => {
    const result = {
      profile: profile(),
      freeDiskBytes: 100 * gib,
      localWriterBytes: 5_950_000_000,
      recommendation: recommendSetup(profile())
    };
    expect(HardwareProfileResultSchema.parse(result)).toEqual(result);
    expect(HardwareProfileResultSchema.safeParse({ ...result, serial: "x" }).success).toBe(false);
    expect(
      HardwareProfileResultSchema.safeParse({
        ...result,
        recommendation: { ...result.recommendation, recommended: "everything" }
      }).success
    ).toBe(false);
  });
});

describe("the Apple working set and the local writer budget", () => {
  it("estimates the default working set by memory from the measured shares", () => {
    expect(estimateAppleWorkingSetBytes(16 * gib) / gib).toBeCloseTo(10.667, 3);
    expect(estimateAppleWorkingSetBytes(24 * gib) / gib).toBeCloseTo(17.76, 2);
    expect(estimateAppleWorkingSetBytes(8 * gib) / gib).toBeCloseTo(5.333, 3);
    // Inferred and kept at the lowest value reported (75%), under the 81% measured at 64 GB.
    expect(estimateAppleWorkingSetBytes(32 * gib) / gib).toBe(24);
    expect(estimateAppleWorkingSetBytes(64 * gib) / gib).toBe(48);
    expect(estimateAppleWorkingSetBytes(512 * gib) / gib).toBe(384);
  });

  it("budgets what a local writer may use as the spike's formula does", () => {
    expect(localWriterBudgetBytes(mac(8))! / gib).toBeLessThan(0);
    expect(localWriterBudgetBytes(mac(16))! / gib).toBeCloseTo(5.0, 2);
    expect(localWriterBudgetBytes(mac(24))! / gib).toBeCloseTo(13.0, 2);
    // The owner's Mac: the measured working set (51.84 GiB) gives the spike's 48.2 GiB.
    const measured = mac(64, { workingSet: { bytes: 55_662_788_608, source: "wired_limit" } });
    expect(localWriterBudgetBytes(measured)! / gib).toBeCloseTo(48.24, 2);
  });

  it("has no local budget off Apple silicon", () => {
    expect(localWriterBudgetBytes(mac(32, { nativeArch: "x64", processArch: "x64" }))).toBeNull();
    expect(localWriterBudgetBytes(windows(64, rtx(24)))).toBeNull();
  });
});

describe("the tier table", () => {
  it("classifies every machine into one of the rows, and every row is reachable", () => {
    for (const id of hardwareTierIds) expect(classifyHardware(representatives[id])).toBe(id);
    expect(hardwareTierRows.map((row) => row.id).sort()).toEqual([...hardwareTierIds].sort());
    // Any memory size lands in a row, the last one (other) included.
    for (const memory of [1, 8, 36, 192, 512, 4096])
      expect(hardwareTierIds).toContain(classifyHardware(mac(memory)));
  });

  it("places the Apple silicon memory classes at the marketing sizes", () => {
    expect(
      [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192].map((memory) => classifyHardware(mac(memory)))
    ).toEqual([
      "apple-8",
      "apple-16",
      "apple-16",
      "apple-24",
      "apple-32",
      "apple-32",
      "apple-48",
      "apple-64",
      "apple-96",
      "apple-128",
      "apple-128"
    ]);
  });

  it("recommends Hybrid on every Mac today and offers Local where a catalog writer fits", () => {
    const rows = [8, 16, 24, 32, 48, 64, 96, 128].map((memory) => recommendSetup(mac(memory)));
    expect(rows.map((row) => row.recommended)).toEqual(Array(8).fill("hybrid"));
    expect(rows.map((row) => row.local.offer)).toEqual([
      "unavailable",
      "available",
      "available",
      "available",
      "available",
      "available",
      "available",
      "available"
    ]);
    // 8 GB: too little memory for any local writer beside the host and the resident pair.
    expect(rows[0]).toMatchObject({
      alternatives: ["cloud"],
      local: { unavailableReason: "memory", writerCatalogId: presetCatalogIds.writerSmall },
      reasons: ["local_memory_too_small"]
    });
    // 16 GB: the 4B (class S), a private mode of lower quality, never the default.
    expect(rows[1]).toMatchObject({
      alternatives: ["local", "cloud"],
      local: { writerCatalogId: presetCatalogIds.writerSmall, qualityClass: "S" },
      reasons: ["local_quality_unverified"]
    });
    // 24 GB and up: the 9B (class M), which the owner has not accepted as a default.
    for (const row of rows.slice(2))
      expect(row).toMatchObject({
        alternatives: ["local", "cloud"],
        local: {
          writerCatalogId: presetCatalogIds.writerLarge,
          qualityClass: "M",
          qualityVerified: false
        },
        reasons: ["local_quality_unverified"]
      });
  });

  it("follows the planner for the writer: the 9B from 24 GiB of memory, else the 4B", () => {
    expect(recommendSetup(mac(24)).local.writerCatalogId).toBe(presetCatalogIds.writerLarge);
    expect(recommendSetup(mac(20)).local.writerCatalogId).toBe(presetCatalogIds.writerSmall);
  });

  it("reads the working set the probe found, not only the memory", () => {
    // A 24 GB Mac whose GPU may wire 6 GiB cannot hold the 9B beside the host and the pair.
    const tight = mac(24, { workingSet: { bytes: 6 * gib, source: "wired_limit" } });
    expect(recommendSetup(tight).local).toMatchObject({
      offer: "unavailable",
      unavailableReason: "memory"
    });
  });

  it("gives an Intel Mac Hybrid and no Local", () => {
    const intel = mac(32, {
      nativeArch: "x64",
      processArch: "x64",
      workingSet: null,
      gpu: { kind: "discrete", name: "AMD Radeon Pro 5500M", cores: null, vramBytes: 8 * gib }
    });
    expect(recommendSetup(intel)).toMatchObject({
      tier: "mac-intel",
      recommended: "hybrid",
      alternatives: ["cloud"],
      reasons: ["local_requires_apple_silicon"],
      local: { offer: "unavailable", unavailableReason: "requires_apple_silicon" }
    });
  });

  it("keeps MLX for an app translated by Rosetta on Apple silicon", () => {
    const translated = mac(16, { processArch: "x64", translated: true });
    expect(presetMachineFromProfile(translated)).toMatchObject({
      arch: "x64",
      nativeArch: "arm64",
      translated: true
    });
    expect(recommendSetup(translated)).toMatchObject({
      alternatives: ["local", "cloud"],
      reasons: ["local_quality_unverified", "running_under_rosetta"]
    });
  });

  it("has Windows rows with no Local preset, because the catalog holds no GGUF writer", () => {
    expect(recommendSetup(windows(8, igpu))).toMatchObject({
      tier: "windows-basic",
      recommended: "cloud",
      alternatives: ["hybrid"],
      reasons: ["local_writer_unavailable", "ranker_slow_on_cpu"],
      local: { offer: "unavailable", unavailableReason: "no_local_writer_for_platform" }
    });
    expect(recommendSetup(windows(16, igpu))).toMatchObject({
      tier: "windows-standard",
      recommended: "hybrid",
      alternatives: ["cloud"]
    });
    // A discrete GPU keeps an 8 GB machine out of the basic row.
    expect(classifyHardware(windows(8, rtx(8)))).toBe("windows-standard");
    expect(classifyHardware(windows(12, noGpu))).toBe("windows-standard");
    expect(recommendSetup(windows(64, rtx(24)))).toMatchObject({
      tier: "windows-large",
      recommended: "hybrid",
      alternatives: ["cloud"]
    });
    expect(classifyHardware(windows(32, rtx(20)))).toBe("windows-large");
    expect(classifyHardware(windows(32, rtx(16)))).toBe("windows-standard");
    expect(classifyHardware(windows(48, igpu))).toBe("windows-large");
  });

  it("gives any other platform Hybrid and no Local", () => {
    expect(
      recommendSetup(profile({ platform: "linux", nativeArch: "x64", processArch: "x64" }))
    ).toMatchObject({
      tier: "other",
      recommended: "hybrid",
      alternatives: ["cloud"],
      local: { offer: "unavailable", unavailableReason: "no_local_writer_for_platform" }
    });
  });

  it("flags a profile whose commands did not all answer", () => {
    expect(recommendSetup(mac(16, { complete: false })).reasons).toContain("probe_incomplete");
  });
});

describe("the verified quality classes (decision 26)", () => {
  const verifying = (classes: HardwareTierConfig["verifiedQualityClasses"]) =>
    HardwareTierConfigSchema.parse({
      ...defaultHardwareTierConfig,
      verifiedQualityClasses: classes
    });

  it("ships none: Local is offered, never recommended", () => {
    expect(defaultHardwareTierConfig.verifiedQualityClasses).toEqual([]);
  });

  it("recommends Local only where a verified class fits", () => {
    const config = verifying(["M"]);
    expect(recommendSetup(mac(64), { config })).toMatchObject({
      recommended: "local",
      alternatives: ["hybrid", "cloud"],
      reasons: []
    });
    // Class S never qualifies, and a Mac too small for the 9B keeps the 4B.
    expect(recommendSetup(mac(16), { config }).recommended).toBe("hybrid");
    // A class is not enough without the memory for it.
    expect(
      recommendSetup(mac(24, { workingSet: { bytes: 6 * gib, source: "wired_limit" } }), { config })
        .recommended
    ).toBe("hybrid");
    // No catalog writer exists off Apple silicon, whatever is verified.
    expect(
      recommendSetup(windows(64, rtx(24)), { config: verifying(["M", "L"]) }).recommended
    ).toBe("hybrid");
  });

  it("refuses to verify class S", () => {
    expect(
      HardwareTierConfigSchema.safeParse({
        ...defaultHardwareTierConfig,
        verifiedQualityClasses: ["S"]
      }).success
    ).toBe(false);
  });
});

describe("price and estimated monthly cost per preset (decision 25)", () => {
  it("gives every row of the table a price and an estimated month for each preset, the same on every machine", () => {
    const costs = hardwareTierIds.map((id) => recommendSetup(representatives[id]).costs);
    for (const cost of costs) {
      expect(cost).toEqual(costs[0]);
      expect(Object.keys(cost).sort()).toEqual(["cloud", "hybrid", "local"]);
      for (const preset of Object.values(cost))
        for (const route of preset.routes) {
          expect(route.monthlyUsd).toBeGreaterThanOrEqual(0);
          expect(route.inputUsdPerM).toBeGreaterThanOrEqual(0);
          expect(route.outputUsdPerM).toBeGreaterThanOrEqual(0);
        }
    }
  });

  it("costs nothing for Local", () => {
    expect(presetCosts().local.routes).toEqual([
      expect.objectContaining({ kind: "local", monthlyUsd: 0, inputUsdPerM: 0, outputUsdPerM: 0 })
    ]);
  });

  it("meters nothing for a ChatGPT plan through Codex and prices an API key per token", () => {
    const { hybrid, cloud } = presetCosts();
    expect(hybrid.routes[0]).toMatchObject({
      kind: "subscription",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      billing: "subscription",
      monthlyUsd: 0,
      verified: true,
      priceTableVersion: defaultPriceTable.version
    });
    // The spike's typical month on gpt-6-luna: $0.39 for the writing, $0.06 more to decide in the cloud.
    expect(hybrid.routes[1]).toMatchObject({
      kind: "api",
      provider: "openai-compatible",
      model: "gpt-6-luna",
      billing: "per_token",
      inputUsdPerM: 0.1,
      outputUsdPerM: 0.5,
      monthlyUsd: 0.39,
      verified: false
    });
    expect(cloud.routes[1]!.monthlyUsd).toBeGreaterThan(hybrid.routes[1]!.monthlyUsd);
    expect(cloud.routes[1]!.monthlyUsd).toBeCloseTo(0.44, 2);
    expect(cloud.routes[0]!.monthlyUsd).toBe(0);
  });

  it("reads the price table, so a new price moves the estimate", () => {
    const doubled = PriceTableSchema.parse({
      ...defaultPriceTable,
      version: "test",
      entries: defaultPriceTable.entries.map((entry) =>
        entry.model === "gpt-6-luna" && entry.provider === "openai-compatible"
          ? {
              ...entry,
              inputUsdPerM: entry.inputUsdPerM * 2,
              outputUsdPerM: entry.outputUsdPerM * 2
            }
          : entry
      )
    });
    expect(presetCosts(doubled).hybrid.routes[1]).toMatchObject({
      monthlyUsd: 0.77,
      priceTableVersion: "test"
    });
  });

  it("never prices a reference at zero when the table lacks it", () => {
    const withoutLuna = PriceTableSchema.parse({
      ...defaultPriceTable,
      entries: defaultPriceTable.entries.filter(
        (entry) => !(entry.provider === "openai-compatible" && entry.model === "gpt-6-luna")
      )
    });
    const route = presetCosts(withoutLuna).hybrid.routes[1]!;
    expect(route.monthlyUsd).toBeGreaterThan(0.39);
    expect(route.verified).toBe(false);
  });

  it("references entries the shipped price table lists", () => {
    for (const reference of Object.values(defaultHardwareTierConfig.costReferences)) {
      const listed = defaultPriceTable.entries.some(
        (entry) =>
          entry.provider === reference.provider &&
          (entry.model === reference.model || entry.model === "*")
      );
      expect(listed).toBe(true);
    }
  });
});
