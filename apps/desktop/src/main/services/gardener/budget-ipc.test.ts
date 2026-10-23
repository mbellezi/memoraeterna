import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { registerBudgetIpc } from "./budget-ipc.js";

const snapshot = {
  month: "2026-10",
  day: "2026-10-23",
  money: {
    spentUsd: 4.1,
    reservedUsd: 0,
    capUsd: 5,
    pauseShare: 0.8,
    continued: false,
    state: "paused",
    priceTableVersion: "2026-10-23.2"
  },
  calls: { usedCalls: 3, reservedCalls: 0, capCalls: 800, state: "open" }
};

describe("the budget over IPC (F4 D14)", () => {
  function register(answer: unknown, meters: unknown = snapshot) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const budget = {
      estimateImport: vi.fn(async () => answer),
      snapshot: vi.fn(async () => meters)
    };
    const actions = {
      continuePastPause: vi.fn(async () => ({
        ...snapshot,
        money: { ...snapshot.money, continued: true, state: "open" }
      }))
    };
    const routeModel = vi.fn(async () => null);
    registerBudgetIpc(ipc as unknown as IpcMain, budget as never, routeModel, actions as never);
    const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
    return { call, budget, actions, routeModel, channels: [...handlers.keys()] };
  }

  it("registers the estimate, the meters and the continue action, and validates the estimate", async () => {
    const { call, budget, routeModel, channels } = register({ billing: "subscription" });
    expect(channels).toEqual([
      ipcChannels.budgetEstimateImport,
      ipcChannels.budgetSnapshot,
      ipcChannels.budgetContinue
    ]);
    const estimate = (input: unknown) => call(ipcChannels.budgetEstimateImport, input);
    await expect(estimate({ chunkCount: 12 })).resolves.toEqual({ billing: "subscription" });
    expect(budget.estimateImport).toHaveBeenCalledWith({ chunkCount: 12 }, { routeModel });
    await expect(estimate({ chunkCount: -1 })).rejects.toThrow();
    await expect(estimate({ chunkCount: 1.5 })).rejects.toThrow();
    await expect(estimate({ chunkCount: 1, extra: true })).rejects.toThrow();
    expect(budget.estimateImport).toHaveBeenCalledOnce();
  });

  it("never hands the renderer an answer outside the estimate's shape", async () => {
    const { call } = register({
      billing: "per_token",
      usd: -1,
      known: true,
      priceTableVersion: "v"
    });
    await expect(call(ipcChannels.budgetEstimateImport, { chunkCount: 1 })).rejects.toThrow();
  });

  it("reads the meters and continues past the pause share, refusing arguments and bad answers", async () => {
    const { call, actions } = register(null);
    await expect(call(ipcChannels.budgetSnapshot)).resolves.toEqual(snapshot);
    await expect(call(ipcChannels.budgetContinue)).resolves.toMatchObject({
      money: { continued: true, state: "open" }
    });
    expect(actions.continuePastPause).toHaveBeenCalledOnce();
    await expect(call(ipcChannels.budgetContinue, { force: true })).rejects.toThrow();
    expect(actions.continuePastPause).toHaveBeenCalledOnce();
    const bad = register(null, { ...snapshot, money: { ...snapshot.money, spentUsd: -1 } });
    await expect(bad.call(ipcChannels.budgetSnapshot)).rejects.toThrow();
  });
});
