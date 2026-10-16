import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { ipcChannels } from "../../shared/ipc.js";
import { registerWikiIpc } from "./wiki-ipc.js";
import type { WikiService } from "./wiki-service.js";

function register() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  const service = { search: vi.fn(async () => ({ items: [] })) };
  registerWikiIpc(ipc as unknown as IpcMain, service as unknown as WikiService);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, service, channels: [...handlers.keys()] };
}

describe("wiki over IPC", () => {
  it("registers only the source search of the scope pickers", () => {
    const { channels } = register();
    expect(channels).toEqual([ipcChannels.wikiSearch]);
  });
  it("validates a search before it reaches the service", async () => {
    const { call, service } = register();
    await expect(call(ipcChannels.wikiSearch, { kind: "not-a-kind" })).rejects.toThrow();
    await expect(call(ipcChannels.wikiSearch, { kind: "page" })).rejects.toThrow();
    expect(service.search).not.toHaveBeenCalled();
    await call(ipcChannels.wikiSearch, { kind: "source", text: "recall", offset: 0, limit: 30 });
    expect(service.search).toHaveBeenCalledOnce();
  });
});
