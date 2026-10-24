import { describe, expect, it } from "vitest";

import { fixture, macFixtures, windowsFixtures } from "./__fixtures__/load.js";
import { parseMacDisplays, parseSysctl, parseWindowsProbe, publicLabel } from "./parsers.js";

const gib = 1024 ** 3;

describe("the macOS parsers (recorded on an M4 Max, derived for the other machines)", () => {
  it("reads the kernel facts of the recorded M4 Max", () => {
    expect(parseSysctl(fixture(macFixtures.m4Max64.sysctl))).toEqual({
      cpuBrand: "Apple M4 Max",
      memoryBytes: 68_719_476_736,
      arm64Hardware: true,
      translated: false,
      wiredLimitMb: 0,
      logicalCores: 16,
      physicalCores: 16
    });
  });

  it("reads a translated process, an explicit wired limit and the missing keys of an Intel Mac", () => {
    expect(parseSysctl(fixture(macFixtures.rosettaM1.sysctl))).toMatchObject({
      arm64Hardware: true,
      translated: true,
      memoryBytes: 8 * gib
    });
    expect(parseSysctl(fixture(macFixtures.wiredLimit24.sysctl))).toMatchObject({
      wiredLimitMb: 20_480
    });
    // sysctl lists what it knows and fails on the rest: the answer is partial, never an error.
    expect(parseSysctl(fixture(macFixtures.intel32.sysctl))).toEqual({
      cpuBrand: "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz",
      memoryBytes: 32 * gib,
      arm64Hardware: null,
      translated: null,
      wiredLimitMb: null,
      logicalCores: 16,
      physicalCores: 8
    });
  });

  it("reads nothing from text that is not sysctl output", () => {
    for (const text of ["", "sysctl: unknown oid 'x'", "hw.memsize: lots", "<html></html>"])
      expect(parseSysctl(text)).toEqual({
        cpuBrand: null,
        memoryBytes: null,
        arm64Hardware: null,
        translated: null,
        wiredLimitMb: null,
        logicalCores: null,
        physicalCores: null
      });
    expect(parseSysctl("hw.memsize: 0\nhw.logicalcpu: -4\n").memoryBytes).toBeNull();
    expect(parseSysctl("machdep.cpu.brand_string: serial C02XYZ\n").cpuBrand).toBeNull();
  });

  it("reads the Apple GPU and its cores, and never the displays", () => {
    const text = fixture(macFixtures.m4Max64.displays);
    expect(text).toContain("SYNTHETIC-SERIAL-0001");
    const gpu = parseMacDisplays(text);
    expect(gpu).toEqual({ kind: "apple", name: "Apple M4 Max", cores: 40, vramBytes: null });
    expect(JSON.stringify(gpu)).not.toMatch(/SYNTHETIC|serial/iu);
    expect(parseMacDisplays(fixture(macFixtures.m3Mac16.displays))).toMatchObject({
      kind: "apple",
      cores: 10
    });
  });

  it("prefers the discrete GPU of an Intel Mac and reads its dedicated memory", () => {
    expect(parseMacDisplays(fixture(macFixtures.intel32.displays))).toEqual({
      kind: "discrete",
      name: "AMD Radeon Pro 5500M",
      cores: null,
      vramBytes: 8 * gib
    });
  });

  it("answers no GPU for an empty list and null for text that is not the JSON", () => {
    expect(parseMacDisplays('{"SPDisplaysDataType":[]}')).toEqual({
      kind: "none",
      name: null,
      cores: null,
      vramBytes: null
    });
    for (const text of ["", "not json", "{}", '{"SPDisplaysDataType":"x"}', "[1,2]"])
      expect(parseMacDisplays(text)).toBeNull();
  });
});

describe("the Windows parser (documented output; untested on Windows hardware)", () => {
  it("reads a discrete GPU with its 64-bit video memory, not the 4 GB AdapterRAM", () => {
    const facts = parseWindowsProbe(fixture(windowsFixtures.rtx4090));
    expect(facts).toEqual({
      cpu: { brand: "13th Gen Intel(R) Core(TM) i9-13900K", physicalCores: 24, logicalCores: 32 },
      gpu: { kind: "discrete", name: "NVIDIA GeForce RTX 4090", cores: null, vramBytes: 24 * gib },
      npu: { present: false, name: null }
    });
    // The CPU serial number, the computer name and the PnP device path are in the text, not in the facts.
    expect(fixture(windowsFixtures.rtx4090)).toMatch(/SYNTHETIC-CPU-SERIAL.*DESKTOP-SYNTH123/su);
    expect(JSON.stringify(facts)).not.toMatch(/SYNTHETIC|DESKTOP-|PCI|VEN_/u);
  });

  it("reads an integrated GPU and an NPU from the unrolled single objects PowerShell prints", () => {
    expect(parseWindowsProbe(fixture(windowsFixtures.coreUltra))).toEqual({
      cpu: { brand: "Intel(R) Core(TM) Ultra 7 155H", physicalCores: 16, logicalCores: 22 },
      gpu: { kind: "integrated", name: "Intel(R) Arc(TM) Graphics", cores: null, vramBytes: null },
      npu: { present: true, name: "Intel(R) AI Boost" }
    });
  });

  it("reads Windows on Arm", () => {
    expect(parseWindowsProbe(fixture(windowsFixtures.snapdragon))).toMatchObject({
      cpu: { physicalCores: 12, logicalCores: 12 },
      gpu: { kind: "integrated", name: "Qualcomm(R) Adreno(TM) X1-85 GPU" },
      npu: { present: true, name: expect.stringContaining("Hexagon") }
    });
  });

  it("does not count a basic or remote display adapter as a GPU", () => {
    expect(parseWindowsProbe(fixture(windowsFixtures.displayOnly))?.gpu).toEqual({
      kind: "none",
      name: null,
      cores: null,
      vramBytes: null
    });
  });

  it("marks a GPU of an unknown name discrete only by its dedicated memory", () => {
    const probe = (bytes: number) =>
      parseWindowsProbe(
        JSON.stringify({
          cpu: { Name: "X", NumberOfCores: 1, NumberOfLogicalProcessors: 1 },
          gpus: [{ Name: "Acme Graphics Card" }],
          vram: [{ Name: "Acme Graphics Card", Bytes: bytes }]
        })
      )?.gpu;
    expect(probe(8 * gib)).toMatchObject({ kind: "discrete", vramBytes: 8 * gib });
    expect(probe(256 * 1024 ** 2)).toMatchObject({ kind: "unknown", vramBytes: null });
  });

  it("takes the discrete GPU with the most memory", () => {
    const facts = parseWindowsProbe(
      JSON.stringify({
        cpu: { Name: "X" },
        gpus: [{ Name: "NVIDIA GeForce RTX 3060" }, { Name: "NVIDIA GeForce RTX 4090" }],
        vram: [
          { Name: "NVIDIA GeForce RTX 3060", Bytes: 12 * gib },
          { Name: "NVIDIA GeForce RTX 4090", Bytes: 24 * gib }
        ]
      })
    );
    expect(facts?.gpu).toMatchObject({ name: "NVIDIA GeForce RTX 4090", vramBytes: 24 * gib });
  });

  it("tolerates a byte-order mark and text around the JSON", () => {
    const json = fixture(windowsFixtures.coreUltra).trim();
    expect(parseWindowsProbe(`\uFEFF${json}`)?.cpu.brand).toBe("Intel(R) Core(TM) Ultra 7 155H");
    expect(parseWindowsProbe(`warning: slow\n${json}\n`)?.cpu.brand).toBe(
      "Intel(R) Core(TM) Ultra 7 155H"
    );
  });

  it("answers null for a PowerShell error, text that is not JSON and JSON of another shape", () => {
    for (const text of [
      fixture(windowsFixtures.error),
      "",
      "{not json}",
      "{}",
      '{"cpu":"x"}',
      '{"cpu":null,"gpus":[]}'
    ])
      expect(parseWindowsProbe(text)).toBeNull();
  });
});

describe("the device labels the parsers keep", () => {
  it("trims and bounds a name and drops one that identifies the machine", () => {
    expect(publicLabel("  Apple   M4  Max ")).toBe("Apple M4 Max");
    expect(publicLabel("x".repeat(300))).toHaveLength(120);
    for (const value of [
      null,
      undefined,
      4,
      "",
      "   ",
      "4C4C4544-0042-3510-8051-B5C04F4E4B32",
      "C:\\Users\\a"
    ])
      expect(publicLabel(value)).toBeNull();
  });
});
