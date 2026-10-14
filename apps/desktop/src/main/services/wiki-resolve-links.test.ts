import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { ipcChannels } from "../../shared/ipc.js";
import { registerWikiIpc } from "./wiki-ipc.js";
import { WikiService } from "./wiki-service.js";

const repository = vi.hoisted(() => ({ resolveLinks: vi.fn() }));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createWikiRepository: () => repository
}));

const pageId = "00000000-0000-4000-8000-000000000001";
const revisionId = "00000000-0000-4000-8000-0000000000a1";
const noteId = "00000000-0000-4000-8000-000000000020";
const failedId = "00000000-0000-4000-8000-000000000021";

const resolved = {
  pageId,
  revisionId,
  targets: [
    {
      kind: "atomic_note",
      id: noteId,
      title: "Note",
      markdown: "Body",
      sourceItemId: null,
      evidence: []
    }
  ],
  unresolved: [],
  failed: [{ kind: "atomic_note", id: failedId }]
};

function register(service: Pick<WikiService, "resolveLinks">) {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  registerWikiIpc(
    {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
        handlers.set(channel, handler)
    } as unknown as IpcMain,
    service as WikiService
  );
  return handlers.get(ipcChannels.wikiResolveLinks)!;
}

beforeEach(() => repository.resolveLinks.mockReset());

describe("wiki.resolveLinks over IPC", () => {
  it("passes a validated input to the service and returns its result", async () => {
    const service = { resolveLinks: vi.fn(async () => resolved) };
    const handler = register(service as never);

    await expect(handler({}, { pageId, revisionId })).resolves.toBe(resolved);
    expect(service.resolveLinks).toHaveBeenCalledWith({ pageId, revisionId });
    await handler({}, { pageId });
    expect(service.resolveLinks).toHaveBeenLastCalledWith({ pageId });
  });

  it("refuses a malformed request before it reaches the service", async () => {
    const service = { resolveLinks: vi.fn() };
    const handler = register(service as never);

    for (const payload of [
      undefined,
      null,
      {},
      { pageId: "not-a-uuid" },
      { pageId, revisionId: "x" },
      { pageId, extra: true }
    ])
      expect(() => handler({}, payload)).toThrow();
    expect(service.resolveLinks).not.toHaveBeenCalled();
  });
});

describe("wiki service link resolution", () => {
  const service = new WikiService(() => ({}) as never);

  it("returns targets, missing links and links that failed to read", async () => {
    repository.resolveLinks.mockResolvedValue(resolved);
    const result = await service.resolveLinks({ pageId, revisionId });
    expect(result?.targets).toHaveLength(1);
    expect(result?.failed).toEqual([{ kind: "atomic_note", id: failedId }]);
  });

  it("returns null for a revision that does not exist", async () => {
    repository.resolveLinks.mockResolvedValue(null);
    await expect(service.resolveLinks({ pageId })).resolves.toBeNull();
  });

  it("rejects a repository result that does not say which links failed", async () => {
    repository.resolveLinks.mockResolvedValue({ ...resolved, failed: undefined });
    await expect(service.resolveLinks({ pageId })).rejects.toThrow();
  });
});
