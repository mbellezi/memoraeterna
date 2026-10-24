import { presetCatalogIds } from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  OnboardingHardwareSchema,
  localRefusal,
  localSetupAvailable,
  onboardingHardwareOf,
  runsMlx,
  type HardwareProfileReading
} from "./onboarding";

const gib = 1024 ** 3;

const base = {
  platform: "darwin",
  nativeArch: "arm64",
  translated: false,
  chip: "Apple M4 Pro",
  memoryBytes: 24 * gib,
  workingSetBytes: null,
  recommended: "hybrid",
  local: {
    available: true,
    unavailableReason: null,
    writerCatalogId: presetCatalogIds.writerLarge
  },
  estimates: []
} as const;

/** What T97's `hardware.profile` answers on an Apple silicon Mac, with its fields as the tier table names them. */
function t97Answer(overrides: {
  memoryBytes?: number;
  local?: HardwareProfileReading["recommendation"]["local"];
  platform?: HardwareProfileReading["profile"]["platform"];
  nativeArch?: HardwareProfileReading["profile"]["nativeArch"];
}) {
  const route = (kind: "subscription" | "api", monthlyUsd: number) => ({
    kind,
    provider: kind === "api" ? "openai-compatible" : "openai-codex",
    model: "gpt-6-luna",
    billing: kind === "api" ? "per_token" : "subscription",
    inputUsdPerM: kind === "api" ? 0.1 : 0,
    outputUsdPerM: kind === "api" ? 0.5 : 0,
    monthlyUsd,
    verified: false,
    priceTableVersion: "2026-10-24"
  });
  return {
    profile: {
      version: 1,
      platform: overrides.platform ?? "darwin",
      processArch: "arm64",
      nativeArch: overrides.nativeArch ?? "arm64",
      translated: false,
      osRelease: "25.0.0",
      cpu: { brand: "Apple M4 Max", physicalCores: 16, logicalCores: 16 },
      memoryBytes: overrides.memoryBytes ?? 64 * gib,
      gpu: { kind: "apple", name: "Apple M4 Max", cores: 40, vramBytes: null },
      workingSet: { bytes: 48 * gib, source: "estimated" },
      npu: { present: true, name: null },
      complete: true,
      probedAt: "2026-10-24T05:00:00.000Z"
    },
    freeDiskBytes: 500 * gib,
    localWriterBytes: 5 * gib,
    recommendation: {
      tier: "apple-64",
      recommended: "hybrid",
      alternatives: ["local", "cloud"],
      reasons: ["local_quality_unverified"],
      local: overrides.local ?? {
        offer: "available",
        unavailableReason: null,
        writerCatalogId: presetCatalogIds.writerLarge,
        qualityClass: "M",
        qualityVerified: false,
        budgetBytes: 30 * gib
      },
      costs: {
        local: {
          routes: [
            {
              kind: "local",
              provider: null,
              model: null,
              billing: null,
              inputUsdPerM: 0,
              outputUsdPerM: 0,
              monthlyUsd: 0,
              verified: true,
              priceTableVersion: null
            }
          ]
        },
        hybrid: { routes: [route("subscription", 0), route("api", 0.39)] },
        cloud: { routes: [route("subscription", 0), route("api", 0.44)] }
      }
    }
  } as const;
}

describe("what the first run reads of this computer", () => {
  it("accepts the allowlisted facts and nothing else", () => {
    expect(OnboardingHardwareSchema.parse(base)).toEqual(base);
    expect(() => OnboardingHardwareSchema.parse({ ...base, serialNumber: "C02XYZ" })).toThrow();
    expect(() => OnboardingHardwareSchema.parse({ ...base, hostname: "my-mac" })).toThrow();
    expect(() => OnboardingHardwareSchema.parse({ ...base, recommended: "custom" })).toThrow();
    expect(() => OnboardingHardwareSchema.parse({ ...base, memoryBytes: -1 })).toThrow();
  });

  it("takes a Local offer only with its reason when refused, and with its writer when offered", () => {
    expect(() =>
      OnboardingHardwareSchema.parse({
        ...base,
        local: { available: false, unavailableReason: null, writerCatalogId: null }
      })
    ).toThrow();
    expect(() =>
      OnboardingHardwareSchema.parse({
        ...base,
        local: { available: true, unavailableReason: null, writerCatalogId: null }
      })
    ).toThrow();
  });

  it("runs Local on macOS with Apple silicon, translated or not, where its writer fits, and nowhere else", () => {
    expect(localSetupAvailable(base)).toBe(true);
    const throughRosetta = { ...base, translated: true };
    expect(localSetupAvailable(throughRosetta)).toBe(true);
    expect(localSetupAvailable({ ...base, nativeArch: "x64" })).toBe(false);
    expect(localSetupAvailable({ ...base, platform: "win32" })).toBe(false);
    expect(localSetupAvailable({ ...base, platform: "linux" })).toBe(false);
    const tooSmall = {
      ...base,
      local: { available: false, unavailableReason: "memory", writerCatalogId: null }
    } as const;
    expect(localRefusal(tooSmall)).toBe("memory");
    expect(runsMlx(tooSmall)).toBe(true);
    expect(localRefusal({ ...base, nativeArch: "x64" })).toBe("requires_apple_silicon");
  });
});

describe("the tier card's reading of T97's answer", () => {
  it("keeps the facts the card shows, the table's pick, its Local offer and the API key month", () => {
    expect(onboardingHardwareOf(t97Answer({}))).toEqual({
      platform: "darwin",
      nativeArch: "arm64",
      translated: false,
      chip: "Apple M4 Max",
      memoryBytes: 64 * gib,
      workingSetBytes: 48 * gib,
      recommended: "hybrid",
      local: {
        available: true,
        unavailableReason: null,
        writerCatalogId: presetCatalogIds.writerLarge
      },
      estimates: [
        { preset: "local", monthlyUsd: null },
        { preset: "hybrid", monthlyUsd: 0.39 },
        { preset: "cloud", monthlyUsd: 0.44 }
      ]
    });
  });

  it("refuses Local where the table does, with its reason: the memory, or the platform", () => {
    const small = onboardingHardwareOf(
      t97Answer({
        memoryBytes: 8 * gib,
        local: { offer: "unavailable", unavailableReason: "memory", writerCatalogId: null }
      })
    );
    expect(localRefusal(small)).toBe("memory");
    const windows = onboardingHardwareOf(
      t97Answer({
        platform: "win32",
        nativeArch: "x64",
        local: {
          offer: "unavailable",
          unavailableReason: "no_local_writer_for_platform",
          writerCatalogId: null
        }
      })
    );
    expect(localRefusal(windows)).toBe("no_local_writer_for_platform");
  });
});
