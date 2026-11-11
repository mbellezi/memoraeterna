import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../shared/ipc.js";
import { objectsIpcChannels } from "../shared/ipc-objects.js";
import { questionsChannels } from "../shared/ipc-questions.js";
import { entitiesChannels } from "../shared/ipc-entities.js";
import { homeChannels } from "../shared/ipc-home.js";
import { libraryChannels } from "../shared/ipc-library.js";
import { relationsBranchChannels } from "../shared/ipc-relations-branch.js";
import { searchIpcChannels } from "../shared/ipc-search.js";
import { topicsHistoryChannels } from "../shared/ipc-topics-history.js";
import { registerEntitiesIpc } from "./services/entities-ipc.js";
import { registerHomeIpc } from "./services/home-ipc.js";
import type { HomeService } from "./services/home-service.js";
import { registerLibraryIpc, type LibraryService } from "./services/library-ipc.js";
import { registerRelationsBranchIpc } from "./services/relations-branch-ipc.js";
import { registerSearchOmniIpc } from "./services/search-omni-ipc.js";
import type { SearchOmniService } from "./services/search-omni-service.js";
import { registerTopicsHistoryIpc } from "./services/topics-history-ipc.js";
import { registerObjectsIpc } from "./services/objects-ipc.js";
import type { ObjectsService } from "./services/objects-service.js";
import { registerQuestionsIpc } from "./services/questions-ipc.js";
import type { QuestionsService } from "./services/questions-service.js";

// F5 T170: the wiring card puts the objects and questions areas, the event port and the new
// publishers into the shared entry files. This pins that the channels each area registers are the
// channels its list names (and `ipcChannels` holds), and that the entry files still carry the
// wiring: the main process cannot start in a unit test.
function registered(register: (ipc: IpcMain) => void): string[] {
  const channels: string[] = [];
  register({ handle: (channel: string) => channels.push(channel) } as unknown as IpcMain);
  return channels.sort();
}

describe("the objects area wiring", () => {
  it("registers the area's three channels beside locate and neighborhood, all in ipcChannels", () => {
    const channels = registered((ipc) =>
      registerObjectsIpc(ipc, { get: vi.fn() } as unknown as ObjectsService)
    );
    expect(channels).toEqual(
      [
        ipcChannels.objectsLocate,
        ipcChannels.objectsNeighborhood,
        ...Object.values(objectsIpcChannels)
      ].sort()
    );
    for (const channel of channels) expect(Object.values(ipcChannels)).toContain(channel);
  });
});

describe("the questions area wiring", () => {
  it("registers exactly the area's channels, all in ipcChannels", () => {
    const channels = registered((ipc) =>
      registerQuestionsIpc(ipc, {
        ask: vi.fn(),
        cancel: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        delete: vi.fn(),
        askAgain: vi.fn(),
        clear: vi.fn()
      } as unknown as QuestionsService)
    );
    expect(channels).toEqual(Object.values(questionsChannels).sort());
    expect(ipcChannels.questionsAsk).toBe(questionsChannels.ask);
    expect(ipcChannels.questionsCancel).toBe(questionsChannels.cancel);
    expect(ipcChannels.questionsGet).toBe(questionsChannels.get);
    expect(ipcChannels.questionsList).toBe(questionsChannels.list);
    expect(ipcChannels.questionsDelete).toBe(questionsChannels.delete);
    expect(ipcChannels.questionsAskAgain).toBe(questionsChannels.askAgain);
    expect(ipcChannels.questionsClear).toBe(questionsChannels.clear);
  });
});

describe("the W2 read areas wiring (F5 T171)", () => {
  const cases: [string, string[], string[]][] = [
    [
      "search",
      registered((ipc) =>
        registerSearchOmniIpc(ipc, { omni: vi.fn() } as unknown as SearchOmniService)
      ),
      Object.values(searchIpcChannels)
    ],
    [
      "home",
      registered((ipc) => registerHomeIpc(ipc, { digest: vi.fn() } as unknown as HomeService)),
      Object.values(homeChannels)
    ],
    [
      "library",
      registered((ipc) =>
        registerLibraryIpc(ipc, {
          rows: vi.fn(),
          sourceProgress: vi.fn()
        } as unknown as LibraryService)
      ),
      Object.values(libraryChannels)
    ],
    [
      "entities",
      registered((ipc) => registerEntitiesIpc(ipc, () => null)),
      Object.values(entitiesChannels)
    ],
    [
      "relations.branch",
      registered((ipc) => registerRelationsBranchIpc(ipc, vi.fn())),
      Object.values(relationsBranchChannels)
    ],
    [
      "topics.history",
      registered((ipc) => registerTopicsHistoryIpc(ipc, { history: vi.fn() })),
      Object.values(topicsHistoryChannels)
    ]
  ];

  it.each(cases)("%s registers exactly its channels, all in ipcChannels", (_area, got, wanted) => {
    expect(got).toEqual([...wanted].sort());
    for (const channel of got) expect(Object.values(ipcChannels)).toContain(channel);
  });

  it("registers no channel twice across every area of the window", () => {
    const all = cases.flatMap(([, got]) => got);
    expect(new Set(all).size).toBe(all.length);
    const taken = new Set(Object.values(ipcChannels));
    expect(taken.size).toBe(Object.values(ipcChannels).length);
  });
});

describe("the entry files", () => {
  const main = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  const handlers = readFileSync(join(import.meta.dirname, "ipc.ts"), "utf8");

  it("register both areas and attach the event port to the bus", () => {
    expect(main).toMatch(/registerObjectsIpc\(\s*ipcMain,/u);
    expect(main).toMatch(/registerQuestionsIpc\(\s*ipcMain,/u);
    expect(main).toMatch(/appEventPort\.attach\(events\)/u);
    expect(main).toMatch(/appEventPort\.detach\(\)/u);
  });

  it("install the IPC trace before the first handler registers, and register every W2 area", () => {
    const trace = main.search(/installIpcTrace\(\s*ipcMain,/u);
    expect(trace).toBeGreaterThan(0);
    // Nothing may register a handler before the trace wraps `handle`: it is the first call on ipcMain.
    expect(main.search(/ipcMain\.handle\(/u)).toBeGreaterThan(trace);
    expect(main.search(/register\w+Ipc\(/u)).toBeGreaterThan(trace);
    for (const register of [
      /registerSearchOmniIpc\(\s*ipcMain,/u,
      /registerHomeIpc\(\s*ipcMain,/u,
      /registerLibraryIpc\(\s*ipcMain,/u,
      /registerEntitiesIpc\(\s*ipcMain,/u,
      /registerRelationsBranchIpc\(\s*ipcMain,/u,
      /registerTopicsHistoryIpc\(\s*ipcMain,/u
    ])
      expect(main).toMatch(register);
  });

  it("let a quit wait for the Asks that are writing their end", () => {
    expect(main).toMatch(/registerQuestionsIpc\(ipcMain, questionsService\)/u);
    expect(main).toMatch(/name: "questions"[\s\S]*?questionsService\?\.idle\(\)/u);
    expect(main.indexOf('name: "questions"')).toBeLessThan(main.indexOf('name: "AI runtime"'));
  });

  it("replay the sticky states to a window that has loaded", () => {
    expect(main).toMatch(
      /webContents\.on\("did-finish-load",\s*\(\) =>\s*appEvents\?\.replaySticky\(mainWindow\.webContents\)\s*\)/u
    );
  });

  it("publish model.loading, view.changed and import.progress on the bus and on no other channel", () => {
    expect(main).toMatch(/type: "model\.loading", modelId: payload\.modelId/u);
    expect(main).toMatch(/events\.publish\(\{ type: "view\.changed" \}\)/u);
    expect(handlers).toMatch(/appEventPort\.publish\(\{\s*type: "import\.progress"/u);
    // The six channels the bus replaced (T125) are gone from the senders.
    for (const retired of [
      "aiLocalEmbeddingLoadStatus",
      "viewHistoryChanged",
      "ingestionFileProgress",
      "relationsChanged",
      "topicsChanged",
      "relationExplanationDelta"
    ]) {
      expect(main).not.toContain(`ipcChannels.${retired}`);
      expect(handlers).not.toContain(`ipcChannels.${retired}`);
    }
  });

  it("send to a window only on the bus, the menu, the window navigation and the deep link", () => {
    const sent = new Set<string>();
    for (const source of [main, handlers])
      // The first argument of any send, a literal or a variable included: only a named channel is
      // one. `channel` is the parameter of the helper `sendToMainWindow(channel: string, ...)`
      // that forwards what its callers name, and those callers are scanned here too.
      for (const match of source.matchAll(/(?:\.send|sendToMainWindow)\(\s*([^,)\s]+)/gu))
        if (!/^channel:?$/u.test(match[1]!)) sent.add(match[1]!);
    expect([...sent].sort()).toEqual(
      [
        "ipcChannels.appEvents",
        "ipcChannels.menuCommand",
        "ipcChannels.obsidianDeepLink",
        "ipcChannels.windowNavigation"
      ].sort()
    );
  });
});
