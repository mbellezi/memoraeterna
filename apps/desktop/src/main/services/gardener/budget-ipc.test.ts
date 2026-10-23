import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { registerBudgetIpc } from "./budget-ipc.js";

describe("budget.estimateImport over IPC (F4 D14)", () => {
  function register(answer: unknown) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const budget = { estimateImport: vi.fn(async () => answer) };
    const routeModel = vi.fn(async () => null);
    registerBudgetIpc(ipc as unknown as IpcMain, budget as never, routeModel);
    const call = async (...args: unknown[]) =>
      handlers.get(ipcChannels.budgetEstimateImport)!({}, ...args);
    return { call, budget, routeModel, channels: [...handlers.keys()] };
  }

  it("registers one channel, validates the chunk count and the answer", async () => {
    const { call, budget, routeModel, channels } = register({ billing: "subscription" });
    expect(channels).toEqual([ipcChannels.budgetEstimateImport]);
    await expect(call({ chunkCount: 12 })).resolves.toEqual({ billing: "subscription" });
    expect(budget.estimateImport).toHaveBeenCalledWith({ chunkCount: 12 }, { routeModel });
    await expect(call({ chunkCount: -1 })).rejects.toThrow();
    await expect(call({ chunkCount: 1.5 })).rejects.toThrow();
    await expect(call({ chunkCount: 1, extra: true })).rejects.toThrow();
    expect(budget.estimateImport).toHaveBeenCalledOnce();
  });

  it("never hands the renderer an answer outside the estimate's shape", async () => {
    const { call } = register({
      billing: "per_token",
      usd: -1,
      known: true,
      priceTableVersion: "v"
    });
    await expect(call({ chunkCount: 1 })).rejects.toThrow();
  });
});
