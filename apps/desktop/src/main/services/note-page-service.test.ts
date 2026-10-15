import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { PgPool } from "@app/db";
import type { NotePage, NotePageRelations } from "@app/domain";

import { ipcChannels } from "../../shared/ipc.js";

const repository = vi.hoisted(() => ({
  readPage: vi.fn(),
  listRelations: vi.fn()
}));
vi.mock("@app/db", () => ({ createNotePageRepository: () => repository }));

const { NotePageService } = await import("./note-page-service.js");
const { registerNotePageIpc } = await import("./note-page-ipc.js");

// The SQL runs against a real database in `npm run db:note-page:verify`; these tests pin the
// boundary: what is validated, what is refused and what reaches the renderer.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-15T10:00:00.000Z";
const relations: NotePageRelations = { items: [], total: 0 };
const page: NotePage = {
  note: {
    id: id(1),
    title: "Retrieval",
    ideaStatement: "Retrieval strengthens memory.",
    bodyMarkdown: "Retrieval strengthens memory.",
    language: null,
    status: "active",
    superseded: false,
    ownership: "source",
    humanProtected: false,
    authorship: "ai",
    generationModel: "writer",
    homeSourceId: id(3),
    createdAt: at,
    updatedAt: at,
    reviewedAt: null,
    lastEditedAt: null
  },
  successors: [],
  evidence: { items: [], total: 0 },
  placement: {
    object: { kind: "note", id: id(1), title: "Retrieval" },
    primaryPath: [{ kind: "note", id: id(1), title: "Retrieval" }],
    alsoIn: [],
    citedBy: [],
    counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
  },
  relations
};
const pool = {} as PgPool;

beforeEach(() => {
  repository.readPage.mockReset();
  repository.listRelations.mockReset();
});

describe("NotePageService", () => {
  it("reads a page with the default relation page size", async () => {
    repository.readPage.mockResolvedValue(page);
    const service = new NotePageService(() => pool);
    expect(await service.page({ noteId: id(1) })).toEqual(page);
    expect(repository.readPage).toHaveBeenCalledWith(id(1), { relationLimit: 20 });
  });

  it("passes a missing note through as null", async () => {
    repository.readPage.mockResolvedValue(null);
    expect(await new NotePageService(() => pool).page({ noteId: id(1) })).toBeNull();
  });

  it("refuses malformed requests and an unavailable database without reading", async () => {
    const service = new NotePageService(() => pool);
    for (const input of [
      undefined,
      {},
      { noteId: "nope" },
      { noteId: id(1), relationLimit: 0 },
      { noteId: id(1), relationLimit: 51 },
      { noteId: id(1), extra: true }
    ])
      await expect(service.page(input)).rejects.toThrow();
    await expect(service.relations({ noteId: id(1), offset: -1 })).rejects.toThrow();
    expect(repository.readPage).not.toHaveBeenCalled();
    expect(repository.listRelations).not.toHaveBeenCalled();
    await expect(new NotePageService(() => null).page({ noteId: id(1) })).rejects.toThrow(
      "objects.errors.unavailable"
    );
  });

  it("never passes an answer that breaks the contract to the renderer", async () => {
    repository.readPage.mockResolvedValue({ ...page, note: { ...page.note, metadata: {} } });
    await expect(new NotePageService(() => pool).page({ noteId: id(1) })).rejects.toThrow();
    repository.listRelations.mockResolvedValue({ items: [], total: -1 });
    await expect(
      new NotePageService(() => pool).relations({ noteId: id(1), offset: 0 })
    ).rejects.toThrow();
  });

  it("pages relations with the default size", async () => {
    repository.listRelations.mockResolvedValue({ items: [], total: 7 });
    expect(await new NotePageService(() => pool).relations({ noteId: id(1), offset: 20 })).toEqual({
      items: [],
      total: 7
    });
    expect(repository.listRelations).toHaveBeenCalledWith(id(1), { offset: 20, limit: 20 });
  });
});

describe("note page IPC registration", () => {
  it("handles both channels and validates the payload before the service", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const service = { page: vi.fn(async () => null), relations: vi.fn(async () => relations) };
    registerNotePageIpc(ipc as unknown as IpcMain, service as never);
    const pageHandler = handlers.get(ipcChannels.notesPage)!;
    const relationsHandler = handlers.get(ipcChannels.notesRelations)!;
    expect(() => pageHandler({}, { noteId: "nope" })).toThrow();
    expect(() => relationsHandler({}, { noteId: id(1) })).toThrow();
    expect(service.page).not.toHaveBeenCalled();
    expect(service.relations).not.toHaveBeenCalled();
    await pageHandler({}, { noteId: id(1) });
    expect(service.page).toHaveBeenCalledWith({ noteId: id(1), relationLimit: 20 });
    await relationsHandler({}, { noteId: id(1), offset: 20, limit: 10 });
    expect(service.relations).toHaveBeenCalledWith({ noteId: id(1), offset: 20, limit: 10 });
  });
});
