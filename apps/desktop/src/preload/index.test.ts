import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ipcChannels, type DesktopApi } from "../shared/ipc.js";
import { objectsIpcChannels } from "../shared/ipc-objects.js";
import { questionsChannels } from "../shared/ipc-questions.js";

const electron = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => null)
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      electron.exposed[name] = api;
    }
  },
  ipcRenderer: { invoke: electron.invoke, on: vi.fn(), removeListener: vi.fn() }
}));

const note = "memora://note/00000000-0000-4000-8000-000000000001";

describe("the preload's window.app (F5 T170)", () => {
  let app: DesktopApi;
  beforeAll(async () => {
    await import("./index.js");
    app = electron.exposed.app as DesktopApi;
  });

  it("exposes the objects area beside locate and neighborhood", () => {
    expect(Object.keys(app.objects).sort()).toEqual([
      "backlinks",
      "get",
      "locate",
      "neighborhood",
      "resolveMany"
    ]);
  });

  it("sends objects.get, resolveMany and backlinks on the area's channels", async () => {
    electron.invoke.mockClear();
    electron.invoke.mockResolvedValueOnce({ status: "missing" });
    await app.objects.get({ address: note });
    electron.invoke.mockResolvedValueOnce({ items: {}, missing: [note] });
    await app.objects.resolveMany({ addresses: [note] });
    electron.invoke.mockResolvedValueOnce({ items: [] });
    await app.objects.backlinks({ address: note });
    expect(electron.invoke.mock.calls.map((call) => call[0])).toEqual([
      ipcChannels.objectsGet,
      ipcChannels.objectsResolveMany,
      ipcChannels.objectsBacklinks
    ]);
  });

  it("exposes the questions area on its channels", async () => {
    expect(Object.keys(app.questions).sort()).toEqual([
      "ask",
      "askAgain",
      "cancel",
      "clear",
      "delete",
      "get",
      "list"
    ]);
    electron.invoke.mockClear();
    const answer = { questionId: randomUUID(), requestId: randomUUID() };
    electron.invoke.mockResolvedValueOnce(answer);
    await expect(app.questions.ask({ text: "What is memory?" })).resolves.toEqual(answer);
    electron.invoke.mockResolvedValueOnce(null);
    await app.questions.cancel({ requestId: answer.requestId });
    expect(electron.invoke.mock.calls.map((call) => call[0])).toEqual([
      questionsChannels.ask,
      questionsChannels.cancel
    ]);
  });

  it("refuses a malformed request before anything is sent", async () => {
    electron.invoke.mockClear();
    await expect(app.objects.get({ address: "not an address" })).rejects.toThrow();
    await expect(app.questions.ask({ text: "" })).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
});

describe("the area channels in ipcChannels", () => {
  it("hold every channel of the objects and questions areas, once", () => {
    const values = Object.values(ipcChannels);
    for (const channel of [
      ...Object.values(objectsIpcChannels),
      ...Object.values(questionsChannels)
    ])
      expect(values.filter((value) => value === channel)).toHaveLength(1);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("the push channels the preload listens on (F5 D16, T125)", () => {
  it("are the bus, the menu, the window navigation and the deep link, and no other", () => {
    const listened = new Set<string>();
    for (const file of readdirSync(import.meta.dirname).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    ))
      for (const match of readFileSync(join(import.meta.dirname, file), "utf8").matchAll(
        /ipcRenderer\s*\.\s*(?:on|once|addListener)\(\s*(?:ipcChannels|\w+Channels)\.(\w+)/gu
      ))
        listened.add(match[1]!);
    expect([...listened].sort()).toEqual(
      ["appEvents", "menuCommand", "obsidianDeepLink", "windowNavigation"].sort()
    );
  });

  it("listens on the bus from the start, so the replay of the sticky states is kept for the first view", () => {
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).toMatch(/\{ eager: true \}/u);
  });
});
