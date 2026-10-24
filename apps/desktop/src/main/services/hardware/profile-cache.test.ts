import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HardwareProfileSchema, type HardwareProfile } from "@app/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cacheIsCurrent,
  hardwareFingerprint,
  hardwareProfileMaxAgeMs,
  hardwareProfilePath,
  readProfileCache,
  writeProfileCache,
  type CheapFacts
} from "./profile-cache.js";

const gib = 1024 ** 3;
const facts: CheapFacts = {
  platform: "darwin",
  osRelease: "25.0.0",
  processArch: "arm64",
  memoryBytes: 64 * gib,
  cpuModel: "Apple M4 Max"
};
const profile: HardwareProfile = HardwareProfileSchema.parse({
  version: 1,
  platform: "darwin",
  processArch: "arm64",
  nativeArch: "arm64",
  translated: false,
  osRelease: "25.0.0",
  cpu: { brand: "Apple M4 Max", physicalCores: 16, logicalCores: 16 },
  memoryBytes: 64 * gib,
  gpu: { kind: "apple", name: "Apple M4 Max", cores: 40, vramBytes: null },
  workingSet: { bytes: 48 * gib, source: "estimated" },
  npu: { present: true, name: "Apple Neural Engine" },
  complete: true,
  probedAt: "2026-10-24T10:00:00.000Z"
});

let userData: string;
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "memora-hardware-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe("the hardware profile fingerprint", () => {
  it("is a sha-256 of the facts Node reads, and moves with each of them", () => {
    const fingerprint = hardwareFingerprint(facts);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(hardwareFingerprint({ ...facts })).toBe(fingerprint);
    for (const changed of [
      { platform: "win32" },
      { osRelease: "25.1.0" },
      { processArch: "x64" },
      { memoryBytes: 32 * gib },
      { cpuModel: "Apple M4 Pro" },
      { cpuModel: null }
    ])
      expect(hardwareFingerprint({ ...facts, ...changed })).not.toBe(fingerprint);
  });
});

describe("the profile file under userData/hardware", () => {
  it("lives at hardware/profile-v1.json and round-trips the profile", async () => {
    const fingerprint = hardwareFingerprint(facts);
    await writeProfileCache(userData, fingerprint, profile);
    expect(hardwareProfilePath(userData)).toBe(join(userData, "hardware", "profile-v1.json"));
    await expect(readProfileCache(userData)).resolves.toEqual({ version: 1, fingerprint, profile });
  });

  it("is written whole: no temporary file stays, a second write replaces the first", async () => {
    const fingerprint = hardwareFingerprint(facts);
    await writeProfileCache(userData, fingerprint, profile);
    await writeProfileCache(userData, fingerprint, { ...profile, osRelease: "25.1.0" });
    expect(await readdir(join(userData, "hardware"))).toEqual(["profile-v1.json"]);
    expect((await readProfileCache(userData))?.profile.osRelease).toBe("25.1.0");
  });

  it("holds only the allowlisted fields, as a JSON document", async () => {
    await writeProfileCache(userData, hardwareFingerprint(facts), profile);
    const document = JSON.parse(await readFile(hardwareProfilePath(userData), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(document).sort()).toEqual(["fingerprint", "profile", "version"]);
    expect(Object.keys(document.profile as object).sort()).toEqual(
      Object.keys(HardwareProfileSchema.shape).sort()
    );
  });

  it("reads nothing from a missing, corrupt or out-of-contract file", async () => {
    await expect(readProfileCache(userData)).resolves.toBeNull();
    await mkdir(join(userData, "hardware"), { recursive: true });
    for (const text of [
      "",
      "not json",
      "{}",
      JSON.stringify({ version: 1, fingerprint: "x", profile }),
      JSON.stringify({ version: 1, fingerprint: hardwareFingerprint(facts), profile, serial: "x" }),
      JSON.stringify({
        version: 1,
        fingerprint: hardwareFingerprint(facts),
        profile: { ...profile, hostName: "x" }
      })
    ]) {
      await writeFile(hardwareProfilePath(userData), text, "utf8");
      await expect(readProfileCache(userData)).resolves.toBeNull();
    }
  });

  it("refuses to write a profile outside the contract", async () => {
    await expect(writeProfileCache(userData, "not a hash", profile)).rejects.toThrow();
    await expect(readdir(userData)).resolves.not.toContain("hardware");
  });
});

describe("when the cached profile still answers", () => {
  const fingerprint = hardwareFingerprint(facts);
  const cached = { version: 1 as const, fingerprint, profile };
  const probedAt = Date.parse(profile.probedAt);

  it("answers for this machine's fingerprint within 30 days", () => {
    expect(hardwareProfileMaxAgeMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(cacheIsCurrent(cached, fingerprint, new Date(probedAt))).toBe(true);
    expect(cacheIsCurrent(cached, fingerprint, new Date(probedAt + hardwareProfileMaxAgeMs))).toBe(
      true
    );
  });

  it("probes again on another fingerprint, after 30 days, for a clock set back or an incomplete profile", () => {
    expect(
      cacheIsCurrent(cached, hardwareFingerprint({ ...facts, memoryBytes: 1 }), new Date(probedAt))
    ).toBe(false);
    expect(
      cacheIsCurrent(cached, fingerprint, new Date(probedAt + hardwareProfileMaxAgeMs + 1))
    ).toBe(false);
    expect(cacheIsCurrent(cached, fingerprint, new Date(probedAt - 1))).toBe(false);
    expect(
      cacheIsCurrent(
        { ...cached, profile: { ...profile, complete: false } },
        fingerprint,
        new Date(probedAt)
      )
    ).toBe(false);
  });
});
