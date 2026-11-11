import { describe, expect, it, vi } from "vitest";

import type { AppEvent } from "../../shared/app-events";
import type { ObsidianSyncStatus } from "../../shared/ipc";
import { createFakeAppEvents } from "./fake-app-events";
import {
  obsidianSyncEnded,
  readOnEvents,
  settingsTouch,
  watchMonitoringChanged,
  watchObsidianSync,
  type VisibilityHost
} from "./status-followers";

const projection = (kind: "editorial" | "layout" | "wiki", state = "completed"): AppEvent =>
  ({ type: "obsidian.projection", kind, state }) as AppEvent;
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("readOnEvents: one initial read, then a read per event", () => {
  const sources = [
    { type: "obsidian.projection", when: (event) => event.kind === "wiki" }
  ] as const satisfies Parameters<typeof readOnEvents>[0]["sources"];

  it("reads once at the start and delivers the value", async () => {
    const bus = createFakeAppEvents();
    const read = vi.fn(async () => "first");
    const onValue = vi.fn();
    readOnEvents({ api: () => bus.api, sources, read, onValue });
    await settled();
    expect(read).toHaveBeenCalledTimes(1);
    expect(onValue).toHaveBeenCalledExactlyOnceWith("first");
  });

  it("reads again for an event of its own and not for another kind", async () => {
    const bus = createFakeAppEvents();
    const read = vi.fn(async () => "value");
    readOnEvents({ api: () => bus.api, sources, read, onValue: vi.fn() });
    await settled();
    bus.emit(projection("layout"));
    await settled();
    expect(read).toHaveBeenCalledTimes(1);
    bus.emit(projection("wiki"));
    await settled();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("folds the events that arrive during a read into one more read, in order", async () => {
    const bus = createFakeAppEvents();
    const first = deferred<string>();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue("latest");
    const onValue = vi.fn();
    readOnEvents({ api: () => bus.api, sources, read, onValue });
    bus.emit(projection("wiki"));
    bus.emit(projection("wiki"));
    bus.emit(projection("wiki"));
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve("stale");
    await settled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(onValue.mock.calls.map(([value]) => value)).toEqual(["stale", "latest"]);
  });

  it("reports a failed read and goes on reading at the next event", async () => {
    const bus = createFakeAppEvents();
    const read = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue("back");
    const onValue = vi.fn();
    const onError = vi.fn();
    readOnEvents({ api: () => bus.api, sources, read, onValue, onError });
    await settled();
    expect(onError).toHaveBeenCalledTimes(1);
    bus.emit(projection("wiki"));
    await settled();
    expect(onValue).toHaveBeenCalledExactlyOnceWith("back");
  });

  it("delivers nothing after stop and releases the subscription", async () => {
    const bus = createFakeAppEvents();
    const pending = deferred<string>();
    const onValue = vi.fn();
    const follower = readOnEvents({
      api: () => bus.api,
      sources,
      read: () => pending.promise,
      onValue
    });
    expect(bus.listening("obsidian.projection")).toBe(1);
    follower.stop();
    expect(bus.listening("obsidian.projection")).toBe(0);
    pending.resolve("late");
    await settled();
    expect(onValue).not.toHaveBeenCalled();
  });

  it("does nothing while inactive: it does not even read", async () => {
    const bus = createFakeAppEvents();
    const read = vi.fn(async () => "value");
    readOnEvents({ api: () => bus.api, active: false, sources, read, onValue: vi.fn() });
    await settled();
    expect(read).not.toHaveBeenCalled();
    expect(bus.listening("obsidian.projection")).toBe(0);
  });

  it("uses no timer: a quiet minute asks nothing", async () => {
    vi.useFakeTimers();
    try {
      const bus = createFakeAppEvents();
      const read = vi.fn(async () => "value");
      readOnEvents({ api: () => bus.api, sources, read, onValue: vi.fn() });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the filters", () => {
  it("settingsTouch matches an event that names one of the stores", () => {
    const touches = settingsTouch("obsidian", "storage");
    expect(touches({ type: "settings.changed", stores: ["app", "storage"] })).toBe(true);
    expect(touches({ type: "settings.changed", stores: ["ai"] })).toBe(false);
  });

  it("obsidianSyncEnded ignores the ticks of a running sync", () => {
    const status = (state: ObsidianSyncStatus["state"]) =>
      ({ type: "obsidian.sync", ...syncStatus({ state }) }) as Parameters<
        typeof obsidianSyncEnded
      >[0];
    expect(obsidianSyncEnded(status("running"))).toBe(false);
    expect(obsidianSyncEnded(status("completed"))).toBe(true);
    expect(obsidianSyncEnded(status("failed"))).toBe(true);
  });
});

function syncStatus(overrides: Partial<ObsidianSyncStatus> = {}): ObsidianSyncStatus {
  return {
    state: "running",
    stage: "reconciling",
    progress: 0.25,
    processed: 1,
    total: 4,
    synced: 1,
    conflicts: 0,
    projected: 0,
    startedAt: "2026-11-11T10:00:00.000Z",
    finishedAt: null,
    error: null,
    ...overrides
  };
}

describe("the sync card takes obsidian.sync as the status itself", () => {
  const apiOf = (
    bus: ReturnType<typeof createFakeAppEvents>,
    read: () => Promise<ObsidianSyncStatus>
  ) => ({
    ...bus.api,
    obsidian: { getSyncStatus: vi.fn(read) }
  });

  it("shows the one read, then each event, without the event's type", async () => {
    const bus = createFakeAppEvents();
    const api = apiOf(bus, async () => syncStatus({ state: "idle", stage: "idle" }));
    const onStatus = vi.fn();
    watchObsidianSync(() => api, onStatus);
    await settled();
    expect(onStatus).toHaveBeenCalledTimes(1);
    bus.emit({ type: "obsidian.sync", ...syncStatus({ progress: 0.5 }) });
    const shown = onStatus.mock.calls[1]![0] as Record<string, unknown>;
    expect(shown).toEqual(syncStatus({ progress: 0.5 }));
    expect("type" in shown).toBe(false);
    expect(api.obsidian.getSyncStatus).toHaveBeenCalledTimes(1);
  });

  it("drops a read that comes back after an event, which is newer", async () => {
    const bus = createFakeAppEvents();
    const pending = deferred<ObsidianSyncStatus>();
    const api = apiOf(bus, () => pending.promise);
    const onStatus = vi.fn();
    watchObsidianSync(() => api, onStatus);
    bus.emit({ type: "obsidian.sync", ...syncStatus({ state: "completed", progress: 1 }) });
    pending.resolve(syncStatus({ state: "running", progress: 0.1 }));
    await settled();
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls[0]![0]).toMatchObject({ state: "completed" });
  });

  it("stops listening when the card goes", () => {
    const bus = createFakeAppEvents();
    const stop = watchObsidianSync(() => apiOf(bus, async () => syncStatus()), vi.fn());
    expect(bus.listening("obsidian.sync")).toBe(1);
    stop();
    expect(bus.listening("obsidian.sync")).toBe(0);
  });
});

describe("the monitoring view follows monitoring.changed", () => {
  const changed = (): AppEvent =>
    ({ type: "monitoring.changed", since: "2026-11-11T10:00:00.000Z" }) as AppEvent;
  const visibility = (hidden = false) => {
    const listeners = new Set<() => void>();
    const host: VisibilityHost & { hidden: boolean; show(): void } = {
      hidden,
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
      show() {
        host.hidden = false;
        for (const listener of [...listeners]) listener();
      }
    };
    return { host, listeners };
  };

  it("moves on each change while shown and live", () => {
    const bus = createFakeAppEvents();
    const { host } = visibility();
    const onChanged = vi.fn();
    watchMonitoringChanged(() => bus.api, true, host, onChanged);
    bus.emit(changed());
    bus.emit(changed());
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("reads a change that arrived while hidden once, when the window is shown", () => {
    const bus = createFakeAppEvents();
    const { host } = visibility(true);
    const onChanged = vi.fn();
    watchMonitoringChanged(() => bus.api, true, host, onChanged);
    bus.emit(changed());
    bus.emit(changed());
    expect(onChanged).not.toHaveBeenCalled();
    host.show();
    expect(onChanged).toHaveBeenCalledTimes(1);
    host.show();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("subscribes to nothing when not live", () => {
    const bus = createFakeAppEvents();
    const { host, listeners } = visibility();
    const stop = watchMonitoringChanged(() => bus.api, false, host, vi.fn());
    expect(bus.listening("monitoring.changed")).toBe(0);
    expect(listeners.size).toBe(0);
    stop();
  });

  it("releases the subscription and the visibility listener when stopped", () => {
    const bus = createFakeAppEvents();
    const { host, listeners } = visibility();
    const onChanged = vi.fn();
    const stop = watchMonitoringChanged(() => bus.api, true, host, onChanged);
    stop();
    expect(bus.listening("monitoring.changed")).toBe(0);
    expect(listeners.size).toBe(0);
    bus.emit(changed());
    expect(onChanged).not.toHaveBeenCalled();
  });
});
