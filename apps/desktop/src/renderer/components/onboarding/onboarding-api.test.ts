import { HardwareProfileSchema, recommendSetup, type HardwareProfileResult } from "@app/domain";
import { describe, expect, it, vi } from "vitest";

import type { DesktopApi } from "../../../shared/ipc";
import { onboardingApiOf } from "./use-first-run";

const gib = 1024 ** 3;

/** T97's `hardware.profile` answer for an Apple silicon Mac, with the real tier table's pick. */
function t97Answer(memoryBytes: number): HardwareProfileResult {
  const profile = HardwareProfileSchema.parse({
    version: 1,
    platform: "darwin",
    processArch: "arm64",
    nativeArch: "arm64",
    translated: false,
    osRelease: "25.0.0",
    cpu: { brand: "Apple M3", physicalCores: 8, logicalCores: 8 },
    memoryBytes,
    gpu: { kind: "apple", name: "Apple M3", cores: 10, vramBytes: null },
    workingSet: { bytes: Math.floor(memoryBytes * 0.66), source: "estimated" },
    npu: { present: true, name: null },
    complete: true,
    probedAt: "2026-10-24T05:00:00.000Z"
  });
  return {
    profile,
    freeDiskBytes: 100 * gib,
    localWriterBytes: null,
    recommendation: recommendSetup(profile)
  };
}

describe("the first run's preload", () => {
  it("reads T97's hardware answer as the tier card's facts, and passes the rest through", async () => {
    const answer = t97Answer(64 * gib);
    const app = {
      onAppEvent: vi.fn(() => () => undefined),
      onboarding: { state: vi.fn(), finish: vi.fn() },
      settings: { updateApp: vi.fn() },
      hardware: { profile: vi.fn(async () => answer) },
      localModels: { list: vi.fn(), download: vi.fn() },
      ai: { applyPreset: vi.fn() }
    } as unknown as DesktopApi;
    const api = onboardingApiOf(app);
    const card = await api.hardware.profile();
    expect(app.hardware.profile).toHaveBeenCalledWith();
    expect(card).toMatchObject({
      platform: "darwin",
      nativeArch: "arm64",
      chip: "Apple M3",
      memoryBytes: 64 * gib,
      recommended: answer.recommendation.recommended,
      local: {
        available: answer.recommendation.local.offer === "available",
        writerCatalogId: answer.recommendation.local.writerCatalogId
      }
    });
    expect(api.onboarding).toBe(app.onboarding);
    expect(api.localModels).toBe(app.localModels);
    expect(api.ai).toBe(app.ai);
  });

  it("refuses Local where T97's tier table says the writer does not fit", async () => {
    const app = {
      hardware: { profile: vi.fn(async () => t97Answer(8 * gib)) }
    } as unknown as DesktopApi;
    const card = await onboardingApiOf(app).hardware.profile();
    expect(card.local).toMatchObject({ available: false, unavailableReason: "memory" });
  });
});
