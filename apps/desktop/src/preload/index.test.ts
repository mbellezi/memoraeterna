import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ipcChannels, type DesktopApi } from "../shared/ipc.js";
import { dropChannels } from "../shared/ipc-drop.js";
import { entitiesChannels } from "../shared/ipc-entities.js";
import { homeChannels } from "../shared/ipc-home.js";
import { libraryChannels } from "../shared/ipc-library.js";
import { objectsIpcChannels } from "../shared/ipc-objects.js";
import { questionsChannels } from "../shared/ipc-questions.js";
import { relationsBranchChannels } from "../shared/ipc-relations-branch.js";
import { searchIpcChannels } from "../shared/ipc-search.js";
import { topicsHistoryChannels } from "../shared/ipc-topics-history.js";

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
  },
  webUtils: { getPathForFile: () => "" }
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

  it("exposes the drop bridge, which refuses an item with no path before asking main", async () => {
    expect(typeof app.ingestion.prepareDroppedFiles).toBe("function");
    electron.invoke.mockClear();
    const results = await app.ingestion.prepareDroppedFiles([{ name: "colada.png" }]);
    expect(results).toEqual([{ status: "refused", name: "colada.png", reason: "notAFile" }]);
    expect(electron.invoke).not.toHaveBeenCalled();
    expect(Object.values(ipcChannels)).toContain(dropChannels.prepare);
  });

  it("refuses a malformed request before anything is sent", async () => {
    electron.invoke.mockClear();
    await expect(app.objects.get({ address: "not an address" })).rejects.toThrow();
    await expect(app.questions.ask({ text: "" })).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
});

describe("the preload's window.app, W2 areas (F5 T171)", () => {
  let app: DesktopApi;
  beforeAll(async () => {
    await import("./index.js");
    app = electron.exposed.app as DesktopApi;
  });
  const id = "00000000-0000-4000-8000-000000000002";

  it("adds search.omni beside the legacy query, home, library, entities, relations.branch and topics.history", () => {
    expect(Object.keys(app.search).sort()).toEqual(["omni", "query"]);
    expect(Object.keys(app.home)).toEqual(["digest"]);
    expect(Object.keys(app.library).sort()).toEqual(["rows", "sourceProgress"]);
    expect(Object.keys(app.entities)).toEqual(["page"]);
    expect(Object.keys(app.relations)).toContain("branch");
    expect(Object.keys(app.relations)).toContain("explain");
    expect(Object.keys(app.topics)).toContain("history");
    expect(Object.keys(app.topics)).toContain("tree");
  });

  it("sends every new read on its area's channel", async () => {
    electron.invoke.mockClear();
    // The mocked answers are not valid: only where each request went is under test here.
    const asks = [
      () => app.search.omni({ query: "memory", mode: "quick", requestId: "r1" }),
      () => app.home.digest(),
      () => app.library.rows({ sort: "title" }),
      () => app.library.sourceProgress({ sourceId: id }),
      () => app.entities.page({ id }),
      () => app.relations.branch({ scope: { topicId: id } }),
      () => app.topics.history({ topicIds: [id], days: 7 }),
      () => app.questions.get({ id }),
      () => app.questions.list(),
      () => app.questions.delete({ id }),
      () => app.questions.askAgain({ id }),
      () => app.questions.clear()
    ];
    for (const ask of asks) await ask().catch(() => undefined);
    expect(electron.invoke.mock.calls.map((call) => call[0])).toEqual([
      searchIpcChannels.searchOmni,
      homeChannels.digest,
      libraryChannels.rows,
      libraryChannels.sourceProgress,
      entitiesChannels.page,
      relationsBranchChannels.branch,
      topicsHistoryChannels.topicsHistory,
      questionsChannels.get,
      questionsChannels.list,
      questionsChannels.delete,
      questionsChannels.askAgain,
      questionsChannels.clear
    ]);
    expect(electron.invoke.mock.calls.slice(0, 7).map((call) => call[0])).toEqual([
      ipcChannels.searchOmni,
      ipcChannels.homeDigest,
      ipcChannels.libraryRows,
      ipcChannels.librarySourceProgress,
      ipcChannels.entitiesPage,
      ipcChannels.relationsBranch,
      ipcChannels.topicsHistory
    ]);
  });

  it("validates the answer before the page sees it", async () => {
    electron.invoke.mockResolvedValueOnce({ unexpected: true });
    await expect(app.home.digest()).rejects.toThrow();
    electron.invoke.mockResolvedValueOnce({ unexpected: true });
    await expect(app.entities.page({ id })).rejects.toThrow();
  });

  it("refuses a malformed request before anything is sent", async () => {
    electron.invoke.mockClear();
    await expect(app.search.omni({ query: "", mode: "quick", requestId: "r" })).rejects.toThrow();
    await expect(app.library.rows({ limit: 1000 })).rejects.toThrow();
    await expect(app.entities.page({ id: "x" })).rejects.toThrow();
    await expect(app.topics.history({ topicIds: [], days: 0 })).rejects.toThrow();
    expect(electron.invoke).not.toHaveBeenCalled();
  });
});

describe("the area channels in ipcChannels", () => {
  it("hold every channel of the objects, questions and W2 areas, once", () => {
    const values = Object.values(ipcChannels);
    for (const channel of [
      ...Object.values(objectsIpcChannels),
      ...Object.values(questionsChannels),
      ...Object.values(searchIpcChannels),
      ...Object.values(homeChannels),
      ...Object.values(libraryChannels),
      ...Object.values(entitiesChannels),
      ...Object.values(relationsBranchChannels),
      ...Object.values(topicsHistoryChannels)
    ])
      expect(values.filter((value) => value === channel)).toHaveLength(1);
    expect(new Set(values).size).toBe(values.length);
  });
});

const pushChannels = [
  ipcChannels.appEvents,
  ipcChannels.menuCommand,
  ipcChannels.deepLinkOpen,
  ipcChannels.windowNavigation
].sort();

describe("the push channels the preload listens on (F5 D16, T125)", () => {
  it("are, in the source, the bus, the menu, the window navigation and the deep link, and no other", () => {
    const allowed = new Set(
      ["appEvents", "menuCommand", "deepLinkOpen", "windowNavigation"].map(
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
    exposed.deepLink.onOpen(noop);
    expect([...new Set(electron.listened)].sort()).toEqual(pushChannels);
  });
});
