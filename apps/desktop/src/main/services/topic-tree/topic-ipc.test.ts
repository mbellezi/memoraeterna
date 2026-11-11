import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import { ipcChannels } from "../../../shared/ipc.js";
import { registerTopicIpc, registerTopicTreeIpc, type TopicReadPort } from "./topic-ipc.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-15T12:00:00.000Z";

type Handler = (event: unknown, payload?: unknown) => unknown;

function fakeIpc() {
  const handlers = new Map<string, Handler>();
  const ipc = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
  const call = async (channel: string, payload?: unknown) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler registered for '${channel}'`);
    return handler({}, payload);
  };
  return { ipc: ipc as unknown as IpcMain, handlers, call };
}

function readPort() {
  return {
    tree: vi.fn<TopicReadPort["tree"]>(async () => null),
    path: vi.fn<TopicReadPort["path"]>(async () => null),
    page: vi.fn<TopicReadPort["page"]>(async () => null),
    notes: vi.fn<TopicReadPort["notes"]>(async () => null),
    shape: vi.fn<TopicReadPort["shape"]>(async () => null),
    changeSet: vi.fn<TopicReadPort["changeSet"]>(async () => null),
    status: vi.fn<TopicReadPort["status"]>(async () => ({
      phase: "active" as const,
      counts: { items: 0, placed: 0, pending: 0, needsGate: 0 }
    }))
  };
}

const readChannels = [
  ipcChannels.topicsTree,
  ipcChannels.topicsPath,
  ipcChannels.topicsPage,
  ipcChannels.topicsNotes,
  ipcChannels.topicsShape,
  ipcChannels.topicsChangeSet,
  ipcChannels.topicsStatus
];
const operationChannels = [
  ipcChannels.topicsMutate,
  ipcChannels.topicsUndo,
  ipcChannels.topicsReview,
  ipcChannels.topicsReembed,
  ipcChannels.topicsOverview,
  ipcChannels.topicsOverviewCancel
];

describe("topic IPC channels", () => {
  it("registers every contract of the spec once, and no channel for the switch", () => {
    // `topicsHistory` is the topics-history area's (F5 T171), registered by its own IPC module.
    const topicChannels = Object.entries(ipcChannels).filter(
      ([name]) => name.startsWith("topics") && name !== "topicsHistory"
    );
    expect(topicChannels.map(([name]) => name).sort()).toEqual(
      [
        "topicsChangeSet",
        "topicsMutate",
        "topicsNotes",
        "topicsOverview",
        "topicsOverviewCancel",
        "topicsPage",
        "topicsPath",
        "topicsReembed",
        "topicsReview",
        "topicsShape",
        "topicsStatus",
        "topicsTree",
        "topicsUndo"
      ].sort()
    );
    expect(topicChannels.every(([, channel]) => /^app:topics:[a-z-]+$/u.test(channel))).toBe(true);
    expect(new Set(Object.values(ipcChannels)).size).toBe(Object.values(ipcChannels).length);
    const { handlers, ipc } = fakeIpc();
    registerTopicIpc(ipc, { read: readPort() });
    expect([...handlers.keys()].sort()).toEqual([...readChannels, ...operationChannels].sort());
  });
});

describe("registerTopicIpc", () => {
  it("validates each request before the service sees it and hands over the parsed defaults", async () => {
    const { ipc, call } = fakeIpc();
    const read = readPort();
    registerTopicIpc(ipc, { read });

    await call(ipcChannels.topicsTree);
    expect(read.tree).toHaveBeenLastCalledWith({
      parentId: null,
      limit: 100,
      includeItems: false,
      itemLimit: 5
    });
    await call(ipcChannels.topicsPage, { id: id(1) });
    expect(read.page).toHaveBeenLastCalledWith({ id: id(1), noteLimit: 6 });
    await call(ipcChannels.topicsShape, undefined);
    expect(read.shape).toHaveBeenLastCalledWith({ rootId: null, depth: 4, nodeLimit: 2000 });
    await call(ipcChannels.topicsNotes, { id: id(1), scope: "subtree" });
    expect(read.notes).toHaveBeenLastCalledWith({
      id: id(1),
      limit: 50,
      scope: "subtree",
      kind: "all"
    });
    await call(ipcChannels.topicsPath, { id: id(2) });
    await call(ipcChannels.topicsChangeSet, { id: id(3) });
    await call(ipcChannels.topicsStatus);
    expect(read.path).toHaveBeenCalledWith({ id: id(2) });
    expect(read.changeSet).toHaveBeenCalledWith({ id: id(3) });
    expect(read.status).toHaveBeenCalledTimes(1);

    for (const [channel, bad] of [
      [ipcChannels.topicsTree, { limit: 500 }],
      [ipcChannels.topicsTree, "root"],
      [ipcChannels.topicsPath, {}],
      [ipcChannels.topicsPage, { id: "x" }],
      [ipcChannels.topicsNotes, { id: id(1), kind: "source" }],
      [ipcChannels.topicsShape, { depth: 9 }],
      [ipcChannels.topicsChangeSet, { id: 5 }]
    ] as const) {
      await expect(call(channel, bad), channel).rejects.toThrow();
    }
    expect(read.tree).toHaveBeenCalledTimes(1);
    expect(read.path).toHaveBeenCalledTimes(1);
  });

  it("answers the unwired operations with topics.errors.unavailable after validating them", async () => {
    const { ipc, call } = fakeIpc();
    registerTopicIpc(ipc, { read: readPort() });
    const requests: Array<[string, unknown]> = [
      [ipcChannels.topicsMutate, { op: "pin", id: id(1) }],
      [ipcChannels.topicsUndo, { changeSetId: id(2) }],
      [ipcChannels.topicsReview, { changeSetId: id(2), decision: "apply" }],
      [ipcChannels.topicsReembed, { confirm: true }],
      [ipcChannels.topicsOverview, { id: id(3) }]
    ];
    for (const [channel, payload] of requests) {
      await expect(call(channel, payload), channel).rejects.toThrow("topics.errors.unavailable");
    }
    // Nothing is being written without the overview service: a cancel stops nothing.
    expect(await call(ipcChannels.topicsOverviewCancel, { id: id(3) })).toBe(false);
    // An invalid request is refused as such, not as unavailable.
    await expect(call(ipcChannels.topicsMutate, { op: "delete" })).rejects.not.toThrow(
      "topics.errors.unavailable"
    );
    await expect(call(ipcChannels.topicsReembed, { confirm: false })).rejects.not.toThrow(
      "topics.errors.unavailable"
    );
  });

  it("runs the handler a task installs on the parsed request and validates its answer", async () => {
    const { ipc, call } = fakeIpc();
    const mutate = vi.fn(async () => ({ changeSetId: id(5), generation: 8 }));
    const undo = vi.fn(async () => ({ status: "blocked" as const, blockers: [] }));
    const review = vi.fn(async () => ({ status: "dismissed" as const }));
    const reembed = vi.fn(async () => ({ queued: 12 }));
    registerTopicIpc(ipc, { read: readPort(), mutate, undo, review, reembed });

    expect(
      await call(ipcChannels.topicsMutate, {
        op: "rename",
        id: id(1),
        title: "  New  ",
        expectedUpdatedAt: at
      })
    ).toEqual({ changeSetId: id(5), generation: 8 });
    expect(mutate).toHaveBeenCalledWith({
      op: "rename",
      id: id(1),
      title: "New",
      expectedUpdatedAt: at
    });
    expect(await call(ipcChannels.topicsUndo, { changeSetId: id(2) })).toEqual({
      status: "blocked",
      blockers: []
    });
    expect(
      await call(ipcChannels.topicsReview, { changeSetId: id(2), decision: "dismiss" })
    ).toEqual({
      status: "dismissed"
    });
    expect(await call(ipcChannels.topicsReembed, { confirm: true })).toEqual({ queued: 12 });

    mutate.mockResolvedValueOnce({ changeSetId: "x", generation: 1 } as never);
    await expect(call(ipcChannels.topicsMutate, { op: "pin", id: id(1) })).rejects.toThrow();
    mutate.mockRejectedValueOnce(new Error("topics.errors.protected"));
    await expect(call(ipcChannels.topicsMutate, { op: "unpin", id: id(1) })).rejects.toThrow(
      "topics.errors.protected"
    );
  });

  it("writes and cancels overviews through the installed service, validating both ways", async () => {
    const { ipc, call } = fakeIpc();
    const ready = {
      status: "ready" as const,
      stale: false,
      paragraphs: [{ text: "Sleep consolidates memory [1].", citations: [1] }],
      citations: [
        { n: 1, chunkId: id(7), sourceTitle: "Book", excerpt: "Passage.", available: true }
      ],
      evidence: { used: 1, total: 4 },
      writtenAt: at,
      model: "writer",
      language: "en",
      support: { status: "unchecked" as const, unsupported: [] }
    };
    const writeOverview = vi.fn(async () => ready);
    const cancelOverview = vi.fn(() => true);
    registerTopicIpc(ipc, { read: readPort(), writeOverview, cancelOverview });
    expect(await call(ipcChannels.topicsOverview, { id: id(3), force: true })).toEqual(ready);
    expect(writeOverview).toHaveBeenCalledWith({ id: id(3), force: true });
    expect(await call(ipcChannels.topicsOverviewCancel, { id: id(3) })).toBe(true);
    expect(cancelOverview).toHaveBeenCalledWith({ id: id(3) });
    await expect(call(ipcChannels.topicsOverview, { id: "x" })).rejects.toThrow();
    await expect(
      call(ipcChannels.topicsOverviewCancel, { id: id(3), force: true })
    ).rejects.toThrow();
    writeOverview.mockResolvedValueOnce({ ...ready, paragraphs: "x" } as never);
    await expect(call(ipcChannels.topicsOverview, { id: id(3) })).rejects.toThrow();
    expect(writeOverview).toHaveBeenCalledTimes(2);
  });

  it("lets a failure of the read service reach the caller untouched", async () => {
    const { ipc, call } = fakeIpc();
    const read = readPort();
    read.tree.mockRejectedValue(new Error("topics.errors.stale"));
    registerTopicIpc(ipc, { read });
    await expect(call(ipcChannels.topicsTree, {})).rejects.toThrow("topics.errors.stale");
  });
});

describe("registerTopicTreeIpc", () => {
  it("wires the read service and every handler with one call, and pushes nothing itself", async () => {
    const { ipc, call, handlers } = fakeIpc();
    const mutate = vi.fn(async () => ({ changeSetId: id(5), generation: 2 }));
    const wired = registerTopicTreeIpc(ipc, {
      getPool: () => null,
      mutate
    });
    expect(handlers.size).toBe(13);
    // The database is not ready, so every read says so; the operation that was installed runs.
    await expect(call(ipcChannels.topicsTree, {})).rejects.toThrow("topics.errors.unavailable");
    await expect(call(ipcChannels.topicsStatus)).rejects.toThrow("topics.errors.unavailable");
    await expect(call(ipcChannels.topicsUndo, { changeSetId: id(2) })).rejects.toThrow(
      "topics.errors.unavailable"
    );
    expect(await call(ipcChannels.topicsMutate, { op: "pin", id: id(1) })).toEqual({
      changeSetId: id(5),
      generation: 2
    });
    expect(Object.keys(wired)).toEqual(["read"]);
    expect(wired.read).toBeDefined();
  });
});
