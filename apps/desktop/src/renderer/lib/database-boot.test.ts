import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseStatus } from "../../shared/ipc";
import { waitForDatabaseReady, type DatabaseBootApi } from "./database-boot";
import { createFakeAppEvents } from "./fake-app-events";

const clock = new Date("2026-11-11T10:00:00.000Z");
const at = (offsetMs: number) => new Date(clock.getTime() + offsetMs).toISOString();
const status = (
  state: DatabaseStatus["state"],
  offsetMs: number,
  extra: Partial<DatabaseStatus> = {}
): DatabaseStatus => ({
  state,
  messageKey: `database.status.${state}` as DatabaseStatus["messageKey"],
  updatedAt: at(offsetMs),
  ...extra
});
const publish = (bus: ReturnType<typeof createFakeAppEvents>, value: DatabaseStatus) =>
  bus.emit({ type: "database.status", ...value });

function boot(getStatus: () => Promise<DatabaseStatus>) {
  const bus = createFakeAppEvents();
  const api: DatabaseBootApi = { ...bus.api, database: { getStatus: vi.fn(getStatus) } };
  const seen: DatabaseStatus[] = [];
  const wait = () =>
    waitForDatabaseReady(api, { onStatus: (value) => seen.push(value), timeoutMs: 60_000 });
  return { bus, api, seen, wait };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clock);
});
afterEach(() => vi.useRealTimers());

describe("the boot waits for database.status, not for a loop", () => {
  it("resolves with the ready status that arrives on the bus and stops listening", async () => {
    const { bus, seen, wait } = boot(() => new Promise(() => undefined));
    const done = wait();
    expect(bus.listening("database.status")).toBe(1);
    publish(bus, status("starting", 10));
    publish(bus, status("migrating", 20));
    publish(bus, status("ready", 30));
    await expect(done).resolves.toMatchObject({ state: "ready" });
    expect(seen.map((value) => value.state)).toEqual(["starting", "migrating", "ready"]);
    expect(bus.listening("database.status")).toBe(0);
  });

  it("reads the status once, and takes it when it is ready already", async () => {
    const { api, wait } = boot(async () => status("ready", -5_000));
    await expect(wait()).resolves.toMatchObject({ state: "ready" });
    expect(api.database.getStatus).toHaveBeenCalledTimes(1);
  });

  it("learns a ready state that was sticky before the window subscribed", async () => {
    const { bus, api, wait } = boot(() => new Promise(() => undefined));
    const earlier = bus.api.onAppEvent("database.status", () => undefined);
    publish(bus, status("ready", -60_000));
    const done = wait();
    await expect(done).resolves.toMatchObject({ state: "ready" });
    expect(api.database.getStatus).not.toHaveBeenCalled();
    earlier();
  });

  it("asks nothing again while it waits: a long wait costs one read", async () => {
    const { api, wait } = boot(() => new Promise(() => undefined));
    void wait();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.database.getStatus).toHaveBeenCalledTimes(1);
  });

  it("does not take the replay of an earlier failure for the result of a retry", async () => {
    const { bus, seen, wait } = boot(async () => status("failed", -30_000));
    const earlier = bus.api.onAppEvent("database.status", () => undefined);
    publish(bus, status("failed", -30_000));
    const done = wait();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    publish(bus, status("starting", 5));
    publish(bus, status("ready", 50));
    await expect(done).resolves.toMatchObject({ state: "ready" });
    earlier();
  });

  it("ends with the failure the attempt itself produced", async () => {
    const { bus, wait } = boot(() => new Promise(() => undefined));
    const done = wait();
    publish(bus, status("failed", 15, { error: "no sidecar" }));
    await expect(done).resolves.toMatchObject({ state: "failed", error: "no sidecar" });
  });

  it("drops a status older than one it has already seen", async () => {
    const { bus, seen, wait } = boot(async () => status("starting", 5));
    const done = wait();
    publish(bus, status("migrating", 40));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.map((value) => value.state)).toEqual(["migrating"]);
    publish(bus, status("ready", 60));
    await done;
  });

  it("fails when the status cannot be read", async () => {
    const { bus, wait } = boot(async () => {
      throw new Error("ipc down");
    });
    await expect(wait()).resolves.toMatchObject({
      state: "failed",
      messageKey: "database.status.failed"
    });
    expect(bus.listening("database.status")).toBe(0);
  });

  it("fails after the timeout with one timer and no loop", async () => {
    const { bus, api, wait } = boot(() => new Promise(() => undefined));
    const done = wait();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(done).resolves.toMatchObject({
      state: "failed",
      error: "Database startup timed out."
    });
    expect(api.database.getStatus).toHaveBeenCalledTimes(1);
    expect(bus.listening("database.status")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
