import type { IpcMain } from "electron";
import { HardwareProfileSchema, recommendSetup, type HardwareProfileResult } from "@app/domain";
import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { registerHardwareIpc } from "./ipc.js";

const gib = 1024 ** 3;
const profile = HardwareProfileSchema.parse({
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
const answer: HardwareProfileResult = {
  profile,
  freeDiskBytes: 100 * gib,
  localWriterBytes: 5_950_000_000,
  recommendation: recommendSetup(profile)
};

describe("hardware.profile over IPC (F4 D32)", () => {
  function register(result: unknown = answer) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const service = { profile: vi.fn(async () => result as HardwareProfileResult) };
    registerHardwareIpc(ipc as unknown as IpcMain, service);
    const call = async (...args: unknown[]) =>
      handlers.get(ipcChannels.hardwareProfile)!({}, ...args);
    return { call, service, channels: [...handlers.keys()] };
  }

  it("registers one channel and answers with the service's result", async () => {
    const { call, service, channels } = register();
    expect(ipcChannels.hardwareProfile).toBe("app:hardware:profile");
    expect(channels).toEqual([ipcChannels.hardwareProfile]);
    await expect(call()).resolves.toEqual(answer);
    expect(service.profile).toHaveBeenCalledWith({});
  });

  it("takes nothing, or a request to re-detect", async () => {
    const { call, service } = register();
    await call({ refresh: true });
    expect(service.profile).toHaveBeenLastCalledWith({ refresh: true });
    await call({ refresh: false });
    expect(service.profile).toHaveBeenLastCalledWith({ refresh: false });
  });

  it("refuses any other argument without probing", async () => {
    const { call, service } = register();
    for (const args of [[{ refresh: "yes" }], [{ path: "/etc" }], ["refresh"], [{}, {}], [null]])
      await expect(call(...args)).rejects.toThrow();
    expect(service.profile).not.toHaveBeenCalled();
  });

  it("never lets a field outside the contract leave the main process", async () => {
    await expect(register({ ...answer, serialNumber: "C02XYZ" }).call()).rejects.toThrow();
    await expect(
      register({ ...answer, profile: { ...profile, hostName: "mac.local" } }).call()
    ).rejects.toThrow();
    await expect(
      register({
        ...answer,
        recommendation: { ...answer.recommendation, recommended: "all" }
      }).call()
    ).rejects.toThrow();
    await expect(register({ ...answer, freeDiskBytes: -1 }).call()).rejects.toThrow();
  });
});
