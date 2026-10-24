import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HardwareProfileResultSchema } from "@app/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeRunner, fixture, macFixtures, macRunner } from "./__fixtures__/load.js";
import type { CommandRunner } from "./commands.js";
import {
  HardwareService,
  incompleteProfileRetryMs,
  type HardwareServiceOptions
} from "./hardware-service.js";
import { hardwareProfileMaxAgeMs, hardwareProfilePath } from "./profile-cache.js";

const gib = 1024 ** 3;
let userData: string;
let clock: number;

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "memora-hardware-"));
  clock = Date.parse("2026-10-24T10:00:00.000Z");
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

function service(overrides: Partial<HardwareServiceOptions> = {}) {
  const run = overrides.run ?? macRunner(macFixtures.m4Max64);
  const warn = vi.fn();
  return {
    run: run as ReturnType<typeof macRunner>,
    warn,
    service: new HardwareService({
      userDataPath: userData,
      run,
      platform: "darwin",
      processArch: "arm64",
      osRelease: () => "25.0.0",
      totalMemoryBytes: () => 64 * gib,
      cpuModel: () => ({ model: "Apple M4 Max", logicalCores: 16 }),
      freeBytes: async () => 120 * gib,
      now: () => new Date(clock),
      logger: { warn },
      ...overrides
    })
  };
}

describe("hardware.profile (F4 D32)", () => {
  it("answers the profile, the free disk now and the recommendation for the owner's Mac", async () => {
    const { service: hardware } = service();
    const result = await hardware.profile();
    expect(HardwareProfileResultSchema.parse(result)).toEqual(result);
    expect(result.freeDiskBytes).toBe(120 * gib);
    expect(result.profile).toMatchObject({
      platform: "darwin",
      gpu: { cores: 40 },
      complete: true
    });
    expect(result.recommendation).toMatchObject({
      tier: "apple-64",
      recommended: "hybrid",
      alternatives: ["local", "cloud"],
      local: { offer: "available", writerCatalogId: "mlx-qwen3.5-9b-4bit", qualityClass: "M" }
    });
    // The download size is the catalog's pinned size of that writer (today's model, decision 26).
    expect(result.localWriterBytes).toBeGreaterThan(5.9e9);
    expect(result.localWriterBytes).toBeLessThan(6.1e9);
  });

  it("answers no download size where no local writer applies", async () => {
    const { service: hardware } = service({
      platform: "win32",
      processArch: "x64",
      run: fakeRunner({ windows: null }),
      env: {}
    });
    const result = await hardware.profile();
    expect(result.localWriterBytes).toBeNull();
    expect(result.recommendation).toMatchObject({ recommended: "hybrid", alternatives: ["cloud"] });
    expect(result.profile.complete).toBe(false);
  });

  it("reads the free disk at every call and answers null when it cannot be read", async () => {
    let free = 10 * gib;
    const { service: hardware } = service({ freeBytes: async () => free });
    expect((await hardware.profile()).freeDiskBytes).toBe(10 * gib);
    free = 3 * gib;
    expect((await hardware.profile()).freeDiskBytes).toBe(3 * gib);
    const { service: unreadable } = service({
      freeBytes: async () => {
        throw new Error("no volume");
      }
    });
    expect((await unreadable.profile()).freeDiskBytes).toBeNull();
  });

  it("reads the free disk of the real volume by default", async () => {
    const hardware = new HardwareService({
      userDataPath: userData,
      run: macRunner(macFixtures.m4Max64),
      platform: "darwin",
      processArch: "arm64",
      osRelease: () => "25.0.0",
      totalMemoryBytes: () => 64 * gib,
      cpuModel: () => ({ model: "Apple M4 Max", logicalCores: 16 })
    });
    expect((await hardware.profile()).freeDiskBytes).toBeGreaterThan(0);
  });
});

describe("the profile's cache", () => {
  it("probes once, then answers from memory", async () => {
    const { service: hardware, run } = service();
    await hardware.profile();
    await hardware.profile();
    await hardware.profile();
    expect(run.calls).toHaveLength(2); // sysctl and system_profiler, once
  });

  it("writes userData/hardware/profile-v1.json and a new start reads it without a command", async () => {
    const first = service();
    const probed = await first.service.profile();
    const document = JSON.parse(await readFile(hardwareProfilePath(userData), "utf8")) as {
      profile: unknown;
    };
    expect(document.profile).toEqual(probed.profile);

    const second = service({ run: fakeRunner({}) });
    const again = await second.service.profile();
    expect(again.profile).toEqual(probed.profile);
    expect(second.run.calls).toHaveLength(0);
  });

  it("probes again when the fingerprint changes: more memory, a new OS release, another CPU", async () => {
    await service().service.profile();
    for (const change of [
      { totalMemoryBytes: () => 128 * gib },
      { osRelease: () => "25.1.0" },
      { cpuModel: () => ({ model: "Apple M5 Max", logicalCores: 18 }) }
    ]) {
      const next = service(change);
      await next.service.profile();
      expect(next.run.calls).toHaveLength(2);
    }
  });

  it("probes again after 30 days", async () => {
    await service().service.profile();
    clock += hardwareProfileMaxAgeMs - 1000;
    const fresh = service();
    await fresh.service.profile();
    expect(fresh.run.calls).toHaveLength(0);

    clock += 2000;
    const stale = service();
    await stale.service.profile();
    expect(stale.run.calls).toHaveLength(2);
  });

  it("probes again on a request to re-detect", async () => {
    const { service: hardware, run } = service();
    await hardware.profile();
    expect(run.calls).toHaveLength(2);
    await hardware.profile({ refresh: true });
    expect(run.calls).toHaveLength(4);
    await hardware.profile({});
    expect(run.calls).toHaveLength(4);
  });

  it("never caches an incomplete profile, tries again after a minute and then caches the answer", async () => {
    const calls: string[] = [];
    let displays: string | null = null;
    const run: CommandRunner = async (command) => {
      calls.push(command.file);
      return command.file.endsWith("sysctl") ? fixture(macFixtures.m4Max64.sysctl) : displays;
    };
    const { service: hardware, warn } = service({ run });
    const first = await hardware.profile();
    expect(first.profile.complete).toBe(false);
    expect(first.recommendation.reasons).toContain("probe_incomplete");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("incomplete"));
    await expect(readFile(hardwareProfilePath(userData), "utf8")).rejects.toThrow();

    await hardware.profile(); // inside the minute: the same answer, no new command
    expect(calls).toHaveLength(2);
    clock += incompleteProfileRetryMs;
    displays = fixture(macFixtures.m4Max64.displays);
    const later = await hardware.profile();
    expect(later.profile.complete).toBe(true);
    expect(calls).toHaveLength(4);
    await expect(readFile(hardwareProfilePath(userData), "utf8")).resolves.toContain(
      "Apple M4 Max"
    );
  });

  it("shares one probe among callers and lets a refresh wait for it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = macRunner(macFixtures.m4Max64);
    const slow = Object.assign(
      async (command: Parameters<typeof base>[0]) => {
        await gate;
        return base(command);
      },
      { calls: base.calls }
    );
    const { service: hardware } = service({ run: slow });
    const first = hardware.profile();
    const second = hardware.profile();
    const refresh = hardware.profile({ refresh: true });
    release();
    const [a, b] = await Promise.all([first, second, refresh]);
    expect(a.profile).toEqual(b.profile);
    // One probe for the first two, one more for the refresh that waited.
    expect(base.calls).toHaveLength(4);
  });

  it("answers and logs when the cache cannot be written", async () => {
    const blocker = join(userData, "hardware");
    await writeFile(blocker, "a file where the folder goes");
    const { service: hardware, warn } = service();
    const result = await hardware.profile();
    expect(result.profile.complete).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not cached"));
  });
});

describe("what the answer never holds", () => {
  it("carries no identifier from the commands' output, in the answer or in the file", async () => {
    const { service: hardware } = service();
    const result = await hardware.profile();
    const file = await readFile(hardwareProfilePath(userData), "utf8");
    for (const text of [JSON.stringify(result), file])
      expect(text).not.toMatch(/SYNTHETIC|serial|udid|uuid|hostname|\/Users\//iu);
  });
});
