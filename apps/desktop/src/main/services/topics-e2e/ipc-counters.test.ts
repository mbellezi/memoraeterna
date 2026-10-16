import { describe, expect, it } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { RecordingIpc, allChannels, channelClass } from "./ipc-counters.js";

describe("which channels belong to Settings", () => {
  it("classes the Settings screens' channels as settings", () => {
    for (const channel of [
      ipcChannels.settingsGet,
      ipcChannels.settingsUpdate,
      ipcChannels.appSettingsGet,
      ipcChannels.appSettingsUpdate,
      ipcChannels.googleBooksKeyUpdate,
      ipcChannels.aiProvidersSave,
      ipcChannels.aiProfilesCreate,
      ipcChannels.aiProfilesUpdate,
      ipcChannels.aiTaskRouteSet,
      ipcChannels.localModelsList,
      ipcChannels.localModelsDownload,
      ipcChannels.promptCommand,
      ipcChannels.libraryReset,
      ipcChannels.backupCreate,
      ipcChannels.integrationPairingCreate,
      ipcChannels.obsidianLayoutApply,
      ipcChannels.obsidianSyncStart
    ])
      expect(channelClass(channel), channel).toBe("settings");
  });

  it("classes what a user reaches while working as product", () => {
    for (const channel of [
      ipcChannels.ingestionImportFile,
      ipcChannels.ingestionStructureConfirm,
      ipcChannels.ingestionProcess,
      ipcChannels.jobsList,
      ipcChannels.topicsTree,
      ipcChannels.topicsStatus,
      ipcChannels.topicsMutate,
      ipcChannels.objectsLocate,
      ipcChannels.libraryList,
      ipcChannels.searchQuery,
      ipcChannels.consultationAsk,
      ipcChannels.monitoringList
    ])
      expect(channelClass(channel), channel).toBe("product");
  });

  it("covers every channel with one of the two classes", () => {
    const channels = allChannels();
    expect(channels.length).toBeGreaterThan(100);
    expect(
      channels.filter((channel) => channelClass(channel) === "settings").length
    ).toBeGreaterThan(40);
    expect(new Set(channels).size).toBe(channels.length);
  });
});

describe("the recording ipcMain", () => {
  function ipcWith(...channels: string[]) {
    const ipc = new RecordingIpc();
    const seen: unknown[] = [];
    for (const channel of channels)
      ipc.main.handle(channel, (_event, payload) => {
        seen.push(payload);
        return `answer:${channel}`;
      });
    return { ipc, seen };
  }

  it("runs the registered handler and counts the call in the current phase", async () => {
    const { ipc, seen } = ipcWith(ipcChannels.aiProfilesCreate, ipcChannels.topicsStatus);
    expect(await ipc.invoke(ipcChannels.aiProfilesCreate, { name: "Writer" })).toBe(
      `answer:${ipcChannels.aiProfilesCreate}`
    );
    ipc.phase("user");
    await ipc.invoke(ipcChannels.topicsStatus);
    await ipc.invoke(ipcChannels.topicsStatus);
    expect(seen).toEqual([{ name: "Writer" }, undefined, undefined]);
    expect(ipc.calls("setup", "settings")).toBe(1);
    expect(ipc.calls("setup", "product")).toBe(0);
    expect(ipc.calls("user", "settings")).toBe(0);
    expect(ipc.calls("user", "product")).toBe(2);
    expect(ipc.calls("user")).toBe(2);
  });

  it("counts a Settings call made in the user phase, even when its handler fails", async () => {
    const ipc = new RecordingIpc();
    ipc.main.handle(ipcChannels.appSettingsGet, () => {
      throw new Error("boom");
    });
    ipc.phase("user");
    await expect(ipc.invoke(ipcChannels.appSettingsGet)).rejects.toThrow("boom");
    expect(ipc.calls("user", "settings")).toBe(1);
    expect(ipc.summary().phases.user).toEqual([
      { channel: ipcChannels.appSettingsGet, class: "settings", calls: 1 }
    ]);
  });

  it("refuses a channel nobody registered and a second handler on one channel", async () => {
    const { ipc } = ipcWith(ipcChannels.topicsTree);
    await expect(ipc.invoke(ipcChannels.topicsStatus)).rejects.toThrow(/No handler registered/);
    expect(() => ipc.main.handle(ipcChannels.topicsTree, () => undefined)).toThrow(
      /Second handler/
    );
  });

  it("summarizes the wrapped handlers by class and lists Settings calls first", async () => {
    const { ipc } = ipcWith(
      ipcChannels.aiProvidersSave,
      ipcChannels.settingsGet,
      ipcChannels.jobsList,
      ipcChannels.topicsTree
    );
    ipc.phase("user");
    await ipc.invoke(ipcChannels.topicsTree);
    await ipc.invoke(ipcChannels.settingsGet);
    const summary = ipc.summary();
    expect(summary.registered).toEqual({ settings: 2, product: 2 });
    expect(summary.phases.user!.map((entry) => entry.class)).toEqual(["settings", "product"]);
  });
});
