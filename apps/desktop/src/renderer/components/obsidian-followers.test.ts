import { describe, expect, it, vi } from "vitest";

import type { AppEvent } from "../../shared/app-events";
import type { StorageSettings } from "../../shared/ipc";
import { createFakeAppEvents, type FakeAppEvents } from "../lib/fake-app-events";
import {
  followEditorialConflicts,
  followLayout,
  followWikiStatus,
  type EditorialApi,
  type LayoutApi,
  type WikiApi
} from "./obsidian-followers";

const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const projection = (kind: "editorial" | "layout" | "wiki", state = "completed"): AppEvent =>
  ({ type: "obsidian.projection", kind, state }) as AppEvent;
const settingsChanged = (...stores: string[]): AppEvent =>
  ({ type: "settings.changed", stores }) as AppEvent;
const syncEvent = (state: "running" | "completed"): AppEvent =>
  ({
    type: "obsidian.sync",
    state,
    stage: state === "running" ? "reconciling" : "completed",
    progress: state === "running" ? 0.5 : 1,
    processed: 1,
    total: 2,
    synced: 1,
    conflicts: 0,
    projected: 0,
    startedAt: "2026-11-11T10:00:00.000Z",
    finishedAt: null,
    error: null
  }) as AppEvent;

describe("the editorial card reads when an editorial projection or a sync ends", () => {
  function setup() {
    const bus = createFakeAppEvents();
    const editorialConflicts = vi.fn(async () => [] as never[]);
    const api: EditorialApi = { ...bus.api, obsidian: { editorialConflicts } };
    const onRows = vi.fn();
    const onError = vi.fn();
    const stop = followEditorialConflicts(() => api, onRows, onError);
    return { bus, editorialConflicts, onRows, onError, stop };
  }

  it("reads once at the start", async () => {
    const { editorialConflicts, onRows } = setup();
    await settled();
    expect(editorialConflicts).toHaveBeenCalledTimes(1);
    expect(onRows).toHaveBeenCalledWith([]);
  });

  it("reads again after an editorial projection, not after the other kinds", async () => {
    const { bus, editorialConflicts } = setup();
    await settled();
    bus.emit(projection("wiki"));
    bus.emit(projection("layout"));
    await settled();
    expect(editorialConflicts).toHaveBeenCalledTimes(1);
    bus.emit(projection("editorial"));
    await settled();
    expect(editorialConflicts).toHaveBeenCalledTimes(2);
  });

  it("reads after a sync that ended and not on its ticks", async () => {
    const { bus, editorialConflicts } = setup();
    await settled();
    bus.emit(syncEvent("running"));
    await settled();
    expect(editorialConflicts).toHaveBeenCalledTimes(1);
    bus.emit(syncEvent("completed"));
    await settled();
    expect(editorialConflicts).toHaveBeenCalledTimes(2);
  });

  it("shows the error when the read fails, and releases the bus when the card goes", async () => {
    const bus = createFakeAppEvents();
    const api: EditorialApi = {
      ...bus.api,
      obsidian: {
        editorialConflicts: vi.fn(async () => {
          throw new Error("down");
        })
      }
    };
    const onError = vi.fn();
    const stop = followEditorialConflicts(() => api, vi.fn(), onError);
    await settled();
    expect(onError).toHaveBeenCalledTimes(1);
    stop();
    expect(bus.listening("obsidian.projection")).toBe(0);
    expect(bus.listening("obsidian.sync")).toBe(0);
  });
});

describe("the wiki card reads when a wiki page, a sync or the vault settings change", () => {
  function setup() {
    const bus = createFakeAppEvents();
    const wikiStatus = vi.fn(async () => ({ conflicts: [] }) as never);
    const api: WikiApi = { ...bus.api, obsidian: { wikiStatus } };
    const onStatus = vi.fn();
    const stop = followWikiStatus(() => api, onStatus, vi.fn());
    return { bus, wikiStatus, onStatus, stop };
  }

  it("reads once at the start and then once per event of its own", async () => {
    const { bus, wikiStatus } = setup();
    await settled();
    expect(wikiStatus).toHaveBeenCalledTimes(1);
    bus.emit(projection("wiki", "running"));
    await settled();
    bus.emit(settingsChanged("obsidian"));
    await settled();
    bus.emit(settingsChanged("storage", "app"));
    await settled();
    expect(wikiStatus).toHaveBeenCalledTimes(4);
  });

  it("ignores the layout and editorial projections and unrelated settings", async () => {
    const { bus, wikiStatus } = setup();
    await settled();
    bus.emit(projection("layout"));
    bus.emit(projection("editorial"));
    bus.emit(settingsChanged("ai", "knowledge.controls"));
    await settled();
    expect(wikiStatus).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the card goes", async () => {
    const { bus, wikiStatus, stop } = setup();
    await settled();
    stop();
    bus.emit(projection("wiki"));
    await settled();
    expect(wikiStatus).toHaveBeenCalledTimes(1);
    expect(bus.listening("settings.changed")).toBe(0);
  });
});

describe("the layout card reads the binding, and the layout when it needs to", () => {
  const storage = (overrides: Partial<StorageSettings> = {}) =>
    ({
      obsidianVaultPath: "/vault",
      managedRoot: "/managed",
      obsidianSyncEnabled: true,
      obsidianSyncPaused: false,
      ...overrides
    }) as StorageSettings;

  function setup(initial: StorageSettings = storage()) {
    const bus: FakeAppEvents = createFakeAppEvents();
    let current = initial;
    const layoutStatus = vi.fn(async () => ({ migrations: [], config: null }) as never);
    const get = vi.fn(async () => current);
    const getApp = vi.fn(async () => ({ contentLanguage: "pt-BR" }) as never);
    const api: LayoutApi = {
      ...bus.api,
      obsidian: { layoutStatus },
      settings: { get, getApp }
    };
    const handlers = {
      onBinding: vi.fn(),
      onStatus: vi.fn(),
      onRebound: vi.fn(),
      onError: vi.fn()
    };
    const stop = followLayout(() => api, handlers);
    return {
      bus,
      layoutStatus,
      get,
      handlers,
      stop,
      setStorage: (next: StorageSettings) => {
        current = next;
      }
    };
  }

  it("reads the binding and the layout once, and starts the form from the content language", async () => {
    const { layoutStatus, handlers } = setup();
    await settled();
    expect(handlers.onBinding).toHaveBeenCalledWith({ configured: true, active: true });
    expect(layoutStatus).toHaveBeenCalledTimes(1);
    expect(handlers.onRebound).toHaveBeenCalledExactlyOnceWith({
      version: 2,
      language: "pt-BR",
      attachments: "omit"
    });
  });

  it("reads the settings again on a vault settings change but the layout only when the binding moved", async () => {
    const { bus, layoutStatus, get, handlers, setStorage } = setup();
    await settled();
    bus.emit(settingsChanged("obsidian"));
    await settled();
    expect(get).toHaveBeenCalledTimes(2);
    expect(layoutStatus).toHaveBeenCalledTimes(1);
    setStorage(storage({ obsidianSyncPaused: true }));
    bus.emit(settingsChanged("storage"));
    await settled();
    expect(handlers.onBinding).toHaveBeenLastCalledWith({ configured: true, active: false });
    expect(layoutStatus).toHaveBeenCalledTimes(1);
    setStorage(storage({ obsidianVaultPath: "/other" }));
    bus.emit(settingsChanged("storage"));
    await settled();
    expect(layoutStatus).toHaveBeenCalledTimes(2);
    expect(handlers.onRebound).toHaveBeenCalledTimes(2);
  });

  it("reads the layout after a layout projection without resetting the form", async () => {
    const { bus, layoutStatus, handlers } = setup();
    await settled();
    bus.emit(projection("layout"));
    await settled();
    expect(layoutStatus).toHaveBeenCalledTimes(2);
    expect(handlers.onStatus).toHaveBeenCalledTimes(2);
    expect(handlers.onRebound).toHaveBeenCalledTimes(1);
  });

  it("ignores the other kinds of projection", async () => {
    const { bus, layoutStatus } = setup();
    await settled();
    bus.emit(projection("wiki"));
    bus.emit(projection("editorial"));
    await settled();
    expect(layoutStatus).toHaveBeenCalledTimes(1);
  });

  it("reports a failed read", async () => {
    const bus = createFakeAppEvents();
    const api: LayoutApi = {
      ...bus.api,
      obsidian: { layoutStatus: vi.fn() },
      settings: {
        get: vi.fn(async () => {
          throw new Error("down");
        }),
        getApp: vi.fn()
      }
    };
    const onError = vi.fn();
    followLayout(() => api, { onBinding: vi.fn(), onStatus: vi.fn(), onRebound: vi.fn(), onError });
    await settled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("delivers nothing after the card goes", async () => {
    const { bus, handlers, stop } = setup();
    await settled();
    stop();
    handlers.onStatus.mockClear();
    bus.emit(projection("layout"));
    await settled();
    expect(handlers.onStatus).not.toHaveBeenCalled();
    expect(bus.listening("obsidian.projection")).toBe(0);
  });
});
