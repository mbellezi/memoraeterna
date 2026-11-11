import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";

import { ipcChannels } from "../shared/ipc.js";
import { objectsIpcChannels } from "../shared/ipc-objects.js";
import { questionsChannels } from "../shared/ipc-questions.js";
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

describe("the entry files", () => {
  const main = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
  const handlers = readFileSync(join(import.meta.dirname, "ipc.ts"), "utf8");

  it("register both areas and attach the event port to the bus", () => {
    expect(main).toMatch(/registerObjectsIpc\(\s*ipcMain,/u);
    expect(main).toMatch(/registerQuestionsIpc\(\s*ipcMain,/u);
    expect(main).toMatch(/appEventPort\.attach\(events\)/u);
    expect(main).toMatch(/appEventPort\.detach\(\)/u);
  });

  it("replay the sticky states to a window that has loaded", () => {
    expect(main).toMatch(
      /webContents\.on\("did-finish-load",\s*\(\) =>\s*appEvents\?\.replaySticky\(mainWindow\.webContents\)\s*\)/u
    );
  });

  it("publish model.loading, view.changed and import.progress beside their old channels", () => {
    expect(main).toMatch(/type: "model\.loading", modelId: payload\.modelId/u);
    expect(main).toMatch(/events\.publish\(\{ type: "view\.changed" \}\)/u);
    expect(handlers).toMatch(/appEventPort\.publish\(\{\s*type: "import\.progress"/u);
    // The old channels keep sending until the consumers move (T125).
    expect(main).toContain("ipcChannels.aiLocalEmbeddingLoadStatus");
    expect(main).toContain("ipcChannels.viewHistoryChanged");
    expect(handlers).toContain("ipcChannels.ingestionFileProgress");
  });
});
