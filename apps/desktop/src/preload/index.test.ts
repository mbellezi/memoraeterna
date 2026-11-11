import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ipcChannels, type DesktopApi } from "../shared/ipc.js";
import { objectsIpcChannels } from "../shared/ipc-objects.js";
import { questionsChannels } from "../shared/ipc-questions.js";

const electron = vi.hoisted(() => {
  /** The channel of every listener the preload registered, in order, whatever the registering call. */
  const listened: unknown[] = [];
  const record = (channel: unknown) => {
    listened.push(channel);
  };
  return {
    exposed: {} as Record<string, unknown>,
    listened,
    /** What was listened to once the module had loaded, before any view subscribed. */
    atLoad: [] as unknown[],
    record,
    invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => null)
  };
});

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown) => {
      electron.exposed[name] = api;
    }
  },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.record,
    once: electron.record,
    addListener: electron.record,
    prependListener: electron.record,
    prependOnceListener: electron.record,
    removeListener: vi.fn()
  }
}));

const note = "memora://note/00000000-0000-4000-8000-000000000001";

describe("the preload's window.app (F5 T170)", () => {
  let app: DesktopApi;
  beforeAll(async () => {
    await import("./index.js");
    electron.atLoad = [...electron.listened];
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

const pushChannels = [
  ipcChannels.appEvents,
  ipcChannels.menuCommand,
  ipcChannels.obsidianDeepLink,
  ipcChannels.windowNavigation
].sort();

describe("the push channels the preload listens on (F5 D16, T125)", () => {
  it("are, in the source, the bus, the menu, the window navigation and the deep link, and no other", () => {
    const allowed = new Set(
      ["appEvents", "menuCommand", "obsidianDeepLink", "windowNavigation"].map(
        (name) => `ipcChannels.${name}`
      )
    );
    let registrations = 0;
    for (const file of readdirSync(import.meta.dirname).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
    ))
      for (const match of readFileSync(join(import.meta.dirname, file), "utf8").matchAll(
        /\bipcRenderer\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\(\s*([^,)]*)/gu
      )) {
        registrations += 1;
        // A string literal or a variable is no channel of the contract: it must be a named one.
        expect(allowed, `${file}: ${match[0]}`).toContain(match[1]!.trim());
      }
    expect(registrations).toBeGreaterThanOrEqual(pushChannels.length);
  });

  it("listens on the bus from the start, before any view subscribes", () => {
    // The main process replays the sticky states once the page has loaded: a dispatcher created
    // lazily would miss them (a comment saying `eager` would not change this).
    expect(electron.atLoad).toEqual([ipcChannels.appEvents]);
  });

  it("registers no listener on any other channel, whichever subscription is made", () => {
    const noop = () => undefined;
    const visit = (node: unknown, depth: number) => {
      if (depth > 3 || node === null || typeof node !== "object") return;
      for (const [name, member] of Object.entries(node)) {
        if (typeof member === "function" && /^(?:on|subscribe)/u.test(name)) {
          try {
            (member as (...args: unknown[]) => unknown)("view.changed", noop);
          } catch {
            /* A subscription that needs other arguments is reached below by its own test. */
          }
        } else visit(member, depth + 1);
      }
    };
    const exposed = electron.exposed.app as DesktopApi;
    visit(exposed, 0);
    exposed.system.subscribeNavigation(noop);
    exposed.menu.subscribeCommand(noop);
    exposed.obsidian.onOpen(noop);
    expect([...new Set(electron.listened)].sort()).toEqual(pushChannels);
  });
});
