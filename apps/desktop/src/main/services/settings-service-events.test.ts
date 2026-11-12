import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AppEventSchema, type AppEvent } from "../../shared/app-events.js";
import { appEventPort } from "./app-events.js";
import { changedSettingPaths, SettingsService } from "./settings-service.js";

const folders: string[] = [];

afterEach(async () => {
  appEventPort.detach();
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createService() {
  vi.stubEnv("MEMORA_DATABASE_URL", "");
  const path = await mkdtemp(join(tmpdir(), "memora-settings-events-"));
  folders.push(path);
  const events: AppEvent[] = [];
  appEventPort.attach({ publish: (event) => events.push(event) });
  return { service: new SettingsService(path, { desktopLocale: "en" }), events };
}

const settingsEvents = (events: AppEvent[]) =>
  events.filter((event) => event.type === "settings.changed");

describe("SettingsService publishes settings.changed after a save", () => {
  it("names the app store and the keys a save moved", async () => {
    const { service, events } = await createService();
    await service.getApp();
    expect(settingsEvents(events)).toEqual([]);

    await service.updateApp({ themeMode: "light", navigationCollapsed: true });

    expect(settingsEvents(events)).toEqual([
      { type: "settings.changed", stores: ["app"], keys: ["navigationCollapsed", "themeMode"] }
    ]);
    expect(AppEventSchema.safeParse(events.at(-1)).success).toBe(true);
  });

  it("sends nothing when a save changes no value", async () => {
    const { service, events } = await createService();
    await service.updateApp({ themeMode: "light" });
    events.length = 0;

    await service.updateApp({ themeMode: "light" });

    expect(settingsEvents(events)).toEqual([]);
  });

  it("names the storage store for a storage save", async () => {
    const { service, events } = await createService();

    await service.update({ managedRoot: "Notes" });

    expect(settingsEvents(events)).toEqual([
      { type: "settings.changed", stores: ["storage"], keys: ["managedRoot"] }
    ]);
  });

  it("sends nothing for a save that fails validation", async () => {
    const { service, events } = await createService();

    await expect(service.update({ obsidianSyncEnabled: true })).rejects.toThrow();

    expect(settingsEvents(events)).toEqual([]);
  });
});

describe("changedSettingPaths", () => {
  it("walks plain objects, counts a list as one value and ignores the save timestamp", () => {
    const before = { a: { b: 1, c: [1, 2] }, d: "x", updatedAt: "1" };
    const after = { a: { b: 2, c: [1, 2, 3] }, d: "x", e: true, updatedAt: "2" };

    expect(changedSettingPaths(before, after).sort()).toEqual(["a.b", "a.c", "e"]);
    expect(changedSettingPaths(before, before)).toEqual([]);
  });
});
