import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { OnboardingRecord } from "@app/domain";

import { ipcChannels } from "../../../shared/ipc.js";
import { registerOnboardingIpc } from "./onboarding-ipc.js";
import {
  OnboardingService,
  pgOnboardingStore,
  type OnboardingStore
} from "./onboarding-service.js";

const at = "2026-10-24T09:30:00.000Z";

function memoryStore(initial: unknown, libraryEmpty: boolean) {
  const state = { stored: initial, libraryEmpty, writes: [] as OnboardingRecord[] };
  const store: OnboardingStore = {
    read: async () => state.stored,
    write: async (record) => {
      state.writes.push(record);
      state.stored = record;
    },
    libraryEmpty: async () => state.libraryEmpty
  };
  return { store, state };
}

const service = (store: OnboardingStore) =>
  new OnboardingService({ store, now: () => new Date(at) });

describe("the first run's stored state (F4 D31)", () => {
  it("is due for an empty library with no record", async () => {
    const { store } = memoryStore(null, true);
    await expect(service(store).state()).resolves.toEqual({
      outcome: null,
      at: null,
      libraryEmpty: true,
      show: true
    });
  });

  it("is never due once the library has a source, or a record exists", async () => {
    await expect(service(memoryStore(null, false).store).state()).resolves.toMatchObject({
      show: false
    });
    await expect(
      service(memoryStore({ version: 1, outcome: "skipped", at }, true).store).state()
    ).resolves.toMatchObject({ show: false, outcome: "skipped" });
  });

  it("treats an unreadable row as unset", async () => {
    await expect(
      service(memoryStore({ outcome: "completed" }, true).store).state()
    ).resolves.toMatchObject({ show: true, outcome: null });
  });

  it("records how the first run ended once, and keeps the first record", async () => {
    const { store, state } = memoryStore(null, true);
    const first = await service(store).finish("completed");
    expect(first).toEqual({ outcome: "completed", at, libraryEmpty: true, show: false });
    expect(state.writes).toEqual([{ version: 1, outcome: "completed", at }]);
    const again = await service(store).finish("skipped");
    expect(again.outcome).toBe("completed");
    expect(state.writes).toHaveLength(1);
  });

  it("reads the library and the row from the database, and refuses before it is ready", async () => {
    const query = vi.fn(async () => ({ rows: [{ present: false }] }));
    const empty = pgOnboardingStore(() => ({ query }) as never);
    await expect(empty.libraryEmpty()).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith("select exists (select 1 from source_items) as present");
    query.mockResolvedValueOnce({ rows: [{ present: true }] });
    await expect(empty.libraryEmpty()).resolves.toBe(false);
    const notReady = pgOnboardingStore(() => null);
    await expect(notReady.read()).rejects.toThrow("errors.database.notReady");
    await expect(notReady.libraryEmpty()).rejects.toThrow("errors.database.notReady");
  });
});

describe("the first run over IPC", () => {
  function register(initial: unknown = null) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const { store, state } = memoryStore(initial, true);
    registerOnboardingIpc(ipc as unknown as IpcMain, service(store));
    const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
    return { call, state, channels: [...handlers.keys()].sort() };
  }

  it("registers the read and the write, and nothing else", () => {
    expect(register().channels).toEqual(
      [ipcChannels.onboardingFinish, ipcChannels.onboardingState].sort()
    );
  });

  it("answers the state, which takes no argument", async () => {
    const { call } = register();
    await expect(call(ipcChannels.onboardingState)).resolves.toMatchObject({ show: true });
    // A harness that plays the renderer passes its payload slot, empty.
    await expect(call(ipcChannels.onboardingState, undefined)).resolves.toMatchObject({
      show: true
    });
    await expect(call(ipcChannels.onboardingState, { force: true })).rejects.toThrow();
  });

  it("finishes with a valid outcome only", async () => {
    const { call, state } = register();
    await expect(call(ipcChannels.onboardingFinish, { outcome: "later" })).rejects.toThrow();
    await expect(
      call(ipcChannels.onboardingFinish, { outcome: "skipped", extra: 1 })
    ).rejects.toThrow();
    expect(state.writes).toHaveLength(0);
    await expect(call(ipcChannels.onboardingFinish, { outcome: "skipped" })).resolves.toMatchObject(
      { outcome: "skipped", show: false }
    );
    expect(state.writes).toHaveLength(1);
  });
});
