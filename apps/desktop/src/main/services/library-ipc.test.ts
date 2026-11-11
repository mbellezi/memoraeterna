import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";

import {
  libraryRowSorts,
  libraryRowStatuses,
  libraryRowsCursorMax,
  libraryRowsLimit as dbRowsLimit,
  type LibraryRowsRepository,
  type PgPool
} from "@app/db";

import {
  libraryChannels,
  libraryRowsLimit,
  libraryRowStatuses as sharedStatuses,
  librarySorts,
  librarySourceTypes,
  LibraryRowsInputSchema,
  LibraryRowsResultSchema,
  LibrarySourceProgressSchema
} from "../../shared/ipc-library.js";
import { LibraryService, registerLibraryIpc } from "./library-ipc.js";

const rowId = randomUUID();
const row = {
  id: rowId,
  title: "A source",
  type: "Book",
  authors: ["Ana"],
  addedAt: "2026-01-01T10:00:00.000000Z",
  updatedAt: "2026-01-01T10:00:00.000000Z",
  status: "ready",
  reason: null,
  noteCount: 3,
  place: { path: [{ id: randomUUID(), title: "Nutrição" }], tentative: false },
  hasCover: false
};

function register() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
  const service = {
    rows: vi.fn(async () => ({ rows: [row], total: 1 })),
    sourceProgress: vi.fn(async () => null)
  };
  registerLibraryIpc(ipc as unknown as IpcMain, service as never);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { call, service, channels: [...handlers.keys()] };
}

describe("the library area over IPC", () => {
  it("registers exactly the area's channels, all under app:library", () => {
    const { channels } = register();
    expect(channels.sort()).toEqual(Object.values(libraryChannels).sort());
    for (const channel of channels) expect(channel).toMatch(/^app:library:[a-z-]+$/);
  });

  it("validates a rows request before reading and passes the parsed input on", async () => {
    const { call, service } = register();
    await expect(call(libraryChannels.rows, { sort: "colour" })).rejects.toThrow();
    await expect(call(libraryChannels.rows, { limit: 101 })).rejects.toThrow();
    await expect(call(libraryChannels.rows, { filter: { topicId: "nope" } })).rejects.toThrow();
    await expect(call(libraryChannels.rows, { filter: { kinds: ["Podcast"] } })).rejects.toThrow();
    await expect(call(libraryChannels.rows, { extra: true })).rejects.toThrow();
    expect(service.rows).not.toHaveBeenCalled();
    await call(libraryChannels.rows, { sort: "notes", filter: { query: "  nutri " }, limit: 20 });
    expect(service.rows).toHaveBeenCalledWith({
      sort: "notes",
      filter: { query: "nutri" },
      limit: 20
    });
  });

  it("asks for a source's progress by id only", async () => {
    const { call, service } = register();
    await expect(call(libraryChannels.sourceProgress, { sourceId: "nope" })).rejects.toThrow();
    await expect(call(libraryChannels.sourceProgress, rowId)).rejects.toThrow();
    expect(service.sourceProgress).not.toHaveBeenCalled();
    await expect(call(libraryChannels.sourceProgress, { sourceId: rowId })).resolves.toBeNull();
    expect(service.sourceProgress).toHaveBeenCalledWith({ sourceId: rowId });
  });
});

describe("the library service", () => {
  const repository = (rows: unknown, sourceProgress: unknown = null) =>
    ({
      rows: vi.fn(async () => rows),
      sourceProgress: vi.fn(async () => sourceProgress)
    }) as unknown as LibraryRowsRepository;
  const pool = {} as PgPool;

  it("reads through the repository and checks what it answers", async () => {
    const repo = repository({ rows: [row], total: 1 });
    const service = new LibraryService(
      () => pool,
      () => repo
    );
    await expect(service.rows({ filter: { status: "ready" } })).resolves.toEqual({
      rows: [row],
      total: 1
    });
    expect(repo.rows).toHaveBeenCalledWith({ filter: { status: "ready" } });
    const broken = new LibraryService(
      () => pool,
      () => repository({ rows: [{ id: "x" }], total: 1 })
    );
    await expect(broken.rows({})).rejects.toThrow();
  });

  it("answers null for a source that does not exist and fails when there is no database", async () => {
    const service = new LibraryService(
      () => pool,
      () => repository({ rows: [], total: 0 })
    );
    await expect(service.sourceProgress({ sourceId: rowId })).resolves.toBeNull();
    const offline = new LibraryService(() => null);
    await expect(offline.rows({})).rejects.toThrow("errors.database.notReady");
    await expect(offline.sourceProgress({ sourceId: rowId })).rejects.toThrow(
      "errors.database.notReady"
    );
  });

  it("checks a strip's values", () => {
    const strip = {
      run: {
        status: "running",
        stage: "atomicNotes",
        startedAt: "2026-01-01T10:00:00.000000Z",
        completedAt: null,
        failedStage: null
      },
      needsYou: null,
      paused: false,
      steps: {
        read: { state: "done", pages: 24 },
        chunks: { state: "done", indexed: 142 },
        notes: { state: "running", soFar: 7, estimate: 18 },
        placed: { state: "running", count: 6 },
        summary: { state: "pending" },
        relations: { state: "pending", count: 0 }
      },
      sections: [{ title: "Intro", share: 1, notes: 7, state: "reading" }]
    };
    expect(LibrarySourceProgressSchema.parse(strip)).toEqual(strip);
    expect(LibrarySourceProgressSchema.parse({ ...strip, paused: true })).toMatchObject({
      paused: true
    });
    // The strip reads its paused state from here, so a reply without it is not a strip.
    expect(() => LibrarySourceProgressSchema.parse({ ...strip, paused: undefined })).toThrow();
    expect(LibrarySourceProgressSchema.parse(null)).toBeNull();
    expect(() =>
      LibrarySourceProgressSchema.parse({
        ...strip,
        steps: { ...strip.steps, read: { state: "x" } }
      })
    ).toThrow();
  });
});

describe("the vocabularies stay equal to the database's", () => {
  it("shares the sorts, statuses and limits with the repository", () => {
    expect([...librarySorts]).toEqual([...libraryRowSorts]);
    expect([...sharedStatuses]).toEqual([...libraryRowStatuses]);
    expect(libraryRowsLimit).toEqual(dbRowsLimit);
  });

  it("names the source types the database holds", () => {
    expect(
      LibraryRowsInputSchema.safeParse({ filter: { kinds: [...librarySourceTypes] } }).success
    ).toBe(true);
  });

  it("accepts the longest cursor the repository hands out", () => {
    const next = "a".repeat(libraryRowsCursorMax);
    expect(LibraryRowsResultSchema.parse({ rows: [], total: 0, next }).next).toBe(next);
    expect(LibraryRowsInputSchema.parse({ cursor: next }).cursor).toBe(next);
  });

  it("parses a result with facets", () => {
    const parsed = LibraryRowsResultSchema.parse({
      rows: [row],
      total: 1,
      facets: {
        territories: [
          { topic: { id: randomUUID(), title: "Nutrição" }, count: 1 },
          { topic: null, count: 2 }
        ],
        statuses: { processing: 0, ready: 1, failed: 0, needsYou: 0, storedOnly: 0 }
      }
    });
    expect(parsed.facets?.territories).toHaveLength(2);
  });
});
