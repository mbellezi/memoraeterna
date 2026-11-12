import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../shared/ipc.js";
import { settingsDescribeChannels } from "../shared/ipc-settings-describe.js";
import { createSettingsDescribeApi } from "./settings-describe-api.js";

const description = { id: "themeMode", value: "dark", default: "system", changed: true };

describe("settings describe area channels", () => {
  it("are named by the area and held once by ipcChannels", () => {
    expect(settingsDescribeChannels).toEqual({
      describe: "app:settings-describe:describe",
      reset: "app:settings-describe:reset"
    });
    for (const channel of Object.values(settingsDescribeChannels))
      expect(Object.values(ipcChannels).filter((value) => value === channel)).toHaveLength(1);
  });
});

describe("createSettingsDescribeApi", () => {
  it("validates the answer of describe before the page sees it", async () => {
    const invoke = vi.fn(async () => ({ entries: [description] }));
    expect(await createSettingsDescribeApi(invoke).describe()).toEqual({ entries: [description] });
    expect(invoke).toHaveBeenCalledWith(settingsDescribeChannels.describe);
    await expect(
      createSettingsDescribeApi(async () => ({
        entries: [{ ...description, changed: "yes" }]
      })).describe()
    ).rejects.toThrow();
    await expect(
      createSettingsDescribeApi(async () => ({
        entries: [{ ...description, path: "/Users/x" }]
      })).describe()
    ).rejects.toThrow();
  });

  it("validates the request of reset before it leaves and its answer before the page sees it", async () => {
    const invoke = vi.fn(async () => ({ id: "themeMode", value: "system" }));
    const api = createSettingsDescribeApi(invoke);
    expect(await api.reset({ id: "themeMode" })).toEqual({ id: "themeMode", value: "system" });
    expect(invoke).toHaveBeenLastCalledWith(settingsDescribeChannels.reset, { id: "themeMode" });
    const calls = invoke.mock.calls.length;
    await expect(api.reset({ id: "" })).rejects.toThrow();
    await expect(api.reset({ id: "themeMode", extra: 1 } as never)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(calls);
    expect(
      await createSettingsDescribeApi(async () => ({ id: "x", value: "a", pending: true })).reset({
        id: "x"
      })
    ).toEqual({ id: "x", value: "a", pending: true });
    await expect(
      createSettingsDescribeApi(async () => ({ id: "x", value: "a", pending: false })).reset({
        id: "x"
      })
    ).rejects.toThrow();
  });
});
