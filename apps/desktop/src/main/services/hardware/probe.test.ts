import { HardwareProfileSchema } from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  fakeRunner,
  fixture,
  macFixtures,
  macRunner,
  windowsFixtures
} from "./__fixtures__/load.js";
import { probeHardware, type ProbeInput } from "./probe.js";

const gib = 1024 ** 3;
const now = new Date("2026-10-24T10:00:00.000Z");

function input(overrides: Partial<ProbeInput> = {}): ProbeInput {
  return {
    platform: "darwin",
    processArch: "arm64",
    osRelease: "25.0.0",
    totalMemoryBytes: 64 * gib,
    cpuModel: "Apple M4 Max",
    logicalCores: 16,
    env: {},
    run: macRunner(macFixtures.m4Max64),
    now,
    ...overrides
  };
}

describe("the macOS probe", () => {
  it("probes the recorded M4 Max: Apple GPU cores, Rosetta, memory and the working set", async () => {
    const profile = await probeHardware(input());
    expect(profile).toEqual({
      version: 1,
      platform: "darwin",
      processArch: "arm64",
      nativeArch: "arm64",
      translated: false,
      osRelease: "25.0.0",
      cpu: { brand: "Apple M4 Max", physicalCores: 16, logicalCores: 16 },
      memoryBytes: 68_719_476_736,
      gpu: { kind: "apple", name: "Apple M4 Max", cores: 40, vramBytes: null },
      // iogpu.wired_limit_mb is 0: the default share of memory (estimated, 75% at 64 GB).
      workingSet: { bytes: 48 * gib, source: "estimated" },
      npu: { present: true, name: "Apple Neural Engine" },
      complete: true,
      probedAt: "2026-10-24T10:00:00.000Z"
    });
    expect(HardwareProfileSchema.safeParse(profile).success).toBe(true);
  });

  it("asks the two commands of the allowlist, once each", async () => {
    const run = macRunner(macFixtures.m4Max64);
    await probeHardware(input({ run }));
    expect(run.calls.map((call) => call.file).sort()).toEqual([
      "/usr/sbin/sysctl",
      "/usr/sbin/system_profiler"
    ]);
  });

  it("probes a 16 GB base Mac", async () => {
    const profile = await probeHardware(
      input({ run: macRunner(macFixtures.m3Mac16), totalMemoryBytes: 16 * gib })
    );
    expect(profile).toMatchObject({
      cpu: { brand: "Apple M3" },
      memoryBytes: 16 * gib,
      gpu: { kind: "apple", cores: 10 }
    });
    expect(profile.workingSet!.bytes / gib).toBeCloseTo(10.667, 3);
  });

  it("finds Apple silicon under Rosetta: an x64 app on arm64 hardware", async () => {
    const profile = await probeHardware(
      input({
        processArch: "x64",
        run: macRunner(macFixtures.rosettaM1),
        totalMemoryBytes: 8 * gib
      })
    );
    expect(profile).toMatchObject({
      processArch: "x64",
      nativeArch: "arm64",
      translated: true,
      gpu: { kind: "apple", cores: 8 }
    });
    expect(profile.workingSet).not.toBeNull();
  });

  it("takes the wired limit as the working set when one is set, and never above the memory", async () => {
    const wired = await probeHardware(
      input({ run: macRunner(macFixtures.wiredLimit24), totalMemoryBytes: 24 * gib })
    );
    expect(wired.workingSet).toEqual({ bytes: 20 * gib, source: "wired_limit" });
    const sysctl = "hw.memsize: 8589934592\nhw.optional.arm64: 1\niogpu.wired_limit_mb: 65536\n";
    const clipped = await probeHardware(
      input({
        run: fakeRunner({ sysctl, displays: fixture(macFixtures.rosettaM1.displays) }),
        totalMemoryBytes: 8 * gib
      })
    );
    expect(clipped.workingSet).toEqual({ bytes: 8 * gib, source: "wired_limit" });
  });

  it("probes an Intel Mac: x64 hardware, a discrete GPU, no working set, no NPU", async () => {
    const profile = await probeHardware(
      input({
        processArch: "x64",
        run: macRunner(macFixtures.intel32),
        totalMemoryBytes: 32 * gib,
        cpuModel: "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz"
      })
    );
    expect(profile).toMatchObject({
      nativeArch: "x64",
      translated: false,
      cpu: { physicalCores: 8, logicalCores: 16 },
      gpu: { kind: "discrete", name: "AMD Radeon Pro 5500M", vramBytes: 8 * gib },
      workingSet: null,
      npu: { present: false, name: null },
      complete: true
    });
  });

  it("keeps the Node figures and says so when a command does not answer", async () => {
    const noSysctl = await probeHardware(
      input({ run: fakeRunner({ sysctl: null, displays: fixture(macFixtures.m4Max64.displays) }) })
    );
    expect(noSysctl).toMatchObject({
      complete: false,
      memoryBytes: 64 * gib,
      translated: false,
      nativeArch: "arm64",
      cpu: { brand: "Apple M4 Max", physicalCores: null, logicalCores: 16 },
      gpu: { kind: "apple", cores: 40 }
    });
    const noDisplays = await probeHardware(
      input({ run: fakeRunner({ sysctl: fixture(macFixtures.m4Max64.sysctl), displays: null }) })
    );
    expect(noDisplays).toMatchObject({
      complete: false,
      memoryBytes: 68_719_476_736,
      gpu: { kind: "apple", name: null, cores: null }
    });
    const none = await probeHardware(input({ run: fakeRunner({}) }));
    expect(none).toMatchObject({ complete: false, memoryBytes: 64 * gib });
  });

  it("falls back to the Node figures when the probe itself fails", async () => {
    const profile = await probeHardware(
      input({
        run: async () => {
          throw new Error("boom");
        }
      })
    );
    expect(profile).toMatchObject({
      platform: "darwin",
      nativeArch: "arm64",
      complete: false,
      workingSet: null,
      gpu: { kind: "unknown" }
    });
  });
});

describe("the Windows probe (fixtures; untested on Windows hardware)", () => {
  const windows = (name: string, overrides: Partial<ProbeInput> = {}) =>
    input({
      platform: "win32",
      processArch: "x64",
      osRelease: "10.0.26100",
      totalMemoryBytes: 64 * gib,
      cpuModel: "Intel(R) Core(TM) i9-13900K",
      run: fakeRunner({ windows: fixture(name) }),
      ...overrides
    });

  it("probes a desktop with a discrete GPU", async () => {
    const run = fakeRunner({ windows: fixture(windowsFixtures.rtx4090) });
    const profile = await probeHardware(windows(windowsFixtures.rtx4090, { run }));
    expect(profile).toMatchObject({
      platform: "win32",
      nativeArch: "x64",
      translated: false,
      cpu: { brand: "13th Gen Intel(R) Core(TM) i9-13900K", physicalCores: 24, logicalCores: 32 },
      memoryBytes: 64 * gib,
      gpu: { kind: "discrete", name: "NVIDIA GeForce RTX 4090", vramBytes: 24 * gib },
      workingSet: null,
      complete: true
    });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.file).toMatch(/powershell\.exe$/u);
  });

  it("probes a laptop with an integrated GPU and an NPU", async () => {
    expect(
      await probeHardware(windows(windowsFixtures.coreUltra, { totalMemoryBytes: 16 * gib }))
    ).toMatchObject({
      gpu: { kind: "integrated", name: "Intel(R) Arc(TM) Graphics" },
      npu: { present: true, name: "Intel(R) AI Boost" },
      memoryBytes: 16 * gib
    });
  });

  it("finds an emulated x64 app on Windows on Arm through PROCESSOR_ARCHITEW6432", async () => {
    const profile = await probeHardware(
      windows(windowsFixtures.snapdragon, { env: { PROCESSOR_ARCHITEW6432: "ARM64" } })
    );
    expect(profile).toMatchObject({ processArch: "x64", nativeArch: "arm64", translated: true });
    expect(
      await probeHardware(
        windows(windowsFixtures.snapdragon, {
          processArch: "arm64",
          env: { PROCESSOR_ARCHITEW6432: "ARM64" }
        })
      )
    ).toMatchObject({ nativeArch: "arm64", translated: false });
  });

  it("keeps the Node figures and says so when PowerShell prints an error", async () => {
    for (const run of [
      fakeRunner({ windows: fixture(windowsFixtures.error) }),
      fakeRunner({ windows: null })
    ])
      expect(await probeHardware(windows(windowsFixtures.rtx4090, { run }))).toMatchObject({
        complete: false,
        cpu: { brand: "Intel(R) Core(TM) i9-13900K", physicalCores: null },
        memoryBytes: 64 * gib,
        gpu: { kind: "unknown" }
      });
  });
});

describe("other platforms", () => {
  it("runs no command on Linux and reads the Node figures", async () => {
    const run = fakeRunner({});
    const profile = await probeHardware(
      input({ platform: "linux", processArch: "x64", run, cpuModel: "AMD Ryzen 9 7950X" })
    );
    expect(run.calls).toHaveLength(0);
    expect(profile).toMatchObject({
      platform: "linux",
      nativeArch: "x64",
      cpu: { brand: "AMD Ryzen 9 7950X" },
      gpu: { kind: "unknown" },
      workingSet: null,
      complete: true
    });
    expect(
      (await probeHardware(input({ platform: "freebsd", processArch: "riscv64" }))).platform
    ).toBe("other");
  });
});

describe("what a profile never holds (privacy contract, spike 6.4)", () => {
  const identifiers = [
    /SYNTHETIC/iu,
    /DESKTOP-/u,
    /serial/iu,
    /udid/iu,
    /hostname/iu,
    /VEN_[0-9A-F]{4}/u,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
    /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/iu,
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/u,
    /\/Users\//u,
    /[A-Z]:\\/u
  ];

  it("keeps no serial number, UUID, hostname, address, device path or user path from any fixture", async () => {
    const probes = [
      ...Object.values(macFixtures).map((files) => input({ run: macRunner(files) })),
      ...Object.values(windowsFixtures).map((name) =>
        input({
          platform: "win32",
          processArch: "x64",
          run: fakeRunner({ windows: fixture(name) })
        })
      )
    ];
    for (const probe of probes) {
      const text = JSON.stringify(await probeHardware(probe));
      for (const pattern of identifiers) expect(text).not.toMatch(pattern);
    }
  });
});
