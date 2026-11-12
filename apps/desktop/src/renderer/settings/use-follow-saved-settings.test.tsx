// The DOM globals must exist before anything else loads: this import stays first.
import { createTestDom, type TestDom } from "../workspace/test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppSettings, StorageSettings } from "../../shared/ipc";
import {
  storesToRead,
  useFollowSavedSettings,
  type SavedSettingsFollowing
} from "./use-follow-saved-settings";

let dom: TestDom;
let handler: (event: unknown) => void = () => undefined;
let subscribed = 0;
const app = (updatedAt: string) => ({ updatedAt }) as AppSettings;
const storage = (updatedAt: string) => ({ updatedAt }) as StorageSettings;

function Probe(options: SavedSettingsFollowing) {
  useFollowSavedSettings(options);
  return null;
}

const options = (over: Partial<SavedSettingsFollowing> = {}): SavedSettingsFollowing => ({
  enabled: true,
  appBusy: () => false,
  storageBusy: () => false,
  currentApp: () => app("t1"),
  currentStorage: () => storage("t1"),
  onApp: vi.fn(),
  onStorage: vi.fn(),
  ...over
});

beforeEach(() => {
  dom = createTestDom();
  subscribed = 0;
  (dom.window as unknown as { app: unknown }).app = {
    onAppEvent: (_type: string, next: (event: unknown) => void) => {
      subscribed += 1;
      handler = next;
      return () => undefined;
    },
    settings: {
      getApp: () => Promise.resolve(app("t2")),
      get: () => Promise.resolve(storage("t2"))
    }
  };
});
afterEach(async () => {
  await dom.dispose();
});

const emit = async (stores: string[]) => {
  await dom.act(() => void handler({ type: "settings.changed", stores }));
  await dom.act(() => Promise.resolve());
};

describe("which stores a settings.changed asks the app to read", () => {
  it("reads the app store and the storage store, and nothing else", () => {
    expect(storesToRead({ type: "settings.changed", stores: ["app"] })).toEqual({
      app: true,
      storage: false
    });
    expect(storesToRead({ type: "settings.changed", stores: ["ai", "storage"] })).toEqual({
      app: false,
      storage: true
    });
    expect(storesToRead({ type: "settings.changed", stores: ["knowledge.controls"] })).toEqual({
      app: false,
      storage: false
    });
  });
});

describe("the app following what main saved", () => {
  it("hands the app the settings main saved, one read per store the event names", async () => {
    const given = options();
    await dom.render(<Probe {...given} />);
    await emit(["app"]);
    expect(given.onApp).toHaveBeenCalledWith(app("t2"));
    expect(given.onStorage).not.toHaveBeenCalled();
    await emit(["storage"]);
    expect(given.onStorage).toHaveBeenCalledWith(storage("t2"));
  });

  it("does not apply the echo of its own save, nor read over a change it has not saved yet", async () => {
    const echo = options({ currentApp: () => app("t2") });
    await dom.render(<Probe {...echo} />);
    await emit(["app"]);
    expect(echo.onApp).not.toHaveBeenCalled();

    const busy = options({ appBusy: () => true, storageBusy: () => true });
    await dom.render(<Probe {...busy} />);
    await emit(["app", "storage"]);
    expect(busy.onApp).not.toHaveBeenCalled();
    expect(busy.onStorage).not.toHaveBeenCalled();
  });

  it("listens to nothing before the settings are loaded", async () => {
    await dom.render(<Probe {...options({ enabled: false })} />);
    expect(subscribed).toBe(0);
  });
});
