import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { settingsDescribeChannels } from "../../shared/ipc-settings-describe.js";
import { registerSettingsDescribeIpc } from "./settings-describe-ipc.js";

function register() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  const settings = {
    describe: vi.fn(async () => ({ entries: [] })),
    reset: vi.fn(async (input: { id: string }) => ({ id: input.id, value: null }))
  };
  registerSettingsDescribeIpc(ipc as unknown as Pick<IpcMain, "handle">, settings);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, settings, channels: [...handlers.keys()] };
}

describe("registerSettingsDescribeIpc", () => {
  it("registers exactly the two channels of the area", () => {
    expect(register().channels.sort()).toEqual(Object.values(settingsDescribeChannels).sort());
  });

  it("describes without a payload and resets by id", async () => {
    const { call, settings } = register();
    expect(await call(settingsDescribeChannels.describe)).toEqual({ entries: [] });
    expect(await call(settingsDescribeChannels.reset, { id: "themeMode" })).toEqual({
      id: "themeMode",
      value: null
    });
    expect(settings.reset).toHaveBeenCalledWith({ id: "themeMode" });
  });

  it("refuses a request the schema does not accept before the service sees it", async () => {
    const { call, settings } = register();
    await expect(call(settingsDescribeChannels.reset, { id: "" })).rejects.toThrow();
    await expect(call(settingsDescribeChannels.reset, { id: "a", extra: true })).rejects.toThrow();
    await expect(call(settingsDescribeChannels.reset)).rejects.toThrow();
    expect(settings.reset).not.toHaveBeenCalled();
  });
});
