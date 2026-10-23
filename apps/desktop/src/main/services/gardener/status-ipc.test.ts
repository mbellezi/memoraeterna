import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { registerGardenerStatusIpc } from "./status-ipc.js";

const status = {
  state: "blocked",
  class: "waiting",
  reason: "provider_rate_limit",
  params: {},
  coverage: { placed: 0.9, matched: 1, overviewsFresh: 0.5 },
  eta: { kind: "at", at: "2026-10-24T15:40:00.000Z" }
};

describe("the Gardener status over IPC (F4 D27)", () => {
  function register(answer: unknown) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const service = { snapshot: vi.fn(async () => answer as never) };
    registerGardenerStatusIpc(ipc as unknown as IpcMain, service);
    const call = async (...args: unknown[]) =>
      handlers.get(ipcChannels.gardenerStatus)!({}, ...args);
    return { call, service, channels: [...handlers.keys()] };
  }

  it("registers one channel and answers with the service's snapshot", async () => {
    const { call, service, channels } = register(status);
    expect(channels).toEqual([ipcChannels.gardenerStatus]);
    await expect(call()).resolves.toEqual(status);
    expect(service.snapshot).toHaveBeenCalledOnce();
  });

  it("takes no argument", async () => {
    const { call, service } = register(status);
    await expect(call({ force: true })).rejects.toThrow();
    expect(service.snapshot).not.toHaveBeenCalled();
  });

  it("never hands the renderer a snapshot outside its contract", async () => {
    await expect(register({ ...status, class: "cap" }).call()).rejects.toThrow();
    await expect(register({ ...status, state: "sleeping" }).call()).rejects.toThrow();
    await expect(register({ ...status, action: "launch_missiles" }).call()).rejects.toThrow();
    await expect(
      register({ ...status, coverage: { ...status.coverage, placed: 2 } }).call()
    ).rejects.toThrow();
    await expect(register({ ...status, taskCount: 4 }).call()).rejects.toThrow();
  });
});
