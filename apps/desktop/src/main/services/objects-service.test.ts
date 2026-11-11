import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { PgPool } from "@app/db";
import { ObjectLocateResultSchema } from "@app/domain";

import { ipcChannels } from "../../shared/ipc.js";
import { objectsIpcChannels } from "../../shared/ipc-objects.js";
import { registerObjectsIpc } from "./objects-ipc.js";
import { ObjectsService } from "./objects-service.js";

// The SQL runs against a real database in `npm run db:object-locate:verify`; these tests pin the
// boundary: what is validated, what is refused and what reaches the repository.
const ids = {
  book: "00000000-0000-4000-8000-000000000001",
  chapter: "00000000-0000-4000-8000-000000000002",
  note: "00000000-0000-4000-8000-000000000003",
  page: "00000000-0000-4000-8000-000000000004",
  chunk: "00000000-0000-4000-8000-000000000005",
  root: "00000000-0000-4000-8000-000000000006",
  topic: "00000000-0000-4000-8000-000000000007"
};

const row = (overrides: Record<string, unknown> = {}) => ({
  title: "Chapter",
  path: [
    { id: ids.book, title: "Book" },
    { id: ids.chapter, title: "Chapter" }
  ],
  topicPath: [
    { id: ids.root, title: "" },
    { id: ids.topic, title: "Memory" }
  ],
  alsoIn: [{ kind: "topic", id: ids.page, title: "Learning" }],
  citedBy: [{ kind: "note", id: ids.note, title: "A note" }],
  alsoInCount: "1",
  citedByCount: 1,
  notes: 4,
  passages: 12,
  children: 0,
  ...overrides
});

function setup(rows: unknown[] | null = [row()]) {
  const query = vi.fn(async () => ({ rows: rows ?? [] }));
  const service = new ObjectsService(() =>
    rows === null ? null : ({ query } as unknown as PgPool)
  );
  return { service, query };
}

describe("ObjectsService.locate", () => {
  it("locates a source with the stable contract: topics and sources from the root, placements, citations and counts", async () => {
    const { service, query } = setup();
    const result = await service.locate({ address: `memora://source/${ids.chapter}` });
    expect(result).toEqual({
      object: { kind: "source", id: ids.chapter, title: "Chapter" },
      primaryPath: [
        { kind: "topic", id: ids.root, title: "" },
        { kind: "topic", id: ids.topic, title: "Memory" },
        { kind: "source", id: ids.book, title: "Book" },
        { kind: "source", id: ids.chapter, title: "Chapter" }
      ],
      alsoIn: [{ kind: "topic", id: ids.page, title: "Learning" }],
      citedBy: [{ kind: "note", id: ids.note, title: "A note" }],
      counts: { alsoIn: 1, citedBy: 1, notes: 4, passages: 12, children: 0 }
    });
    expect(ObjectLocateResultSchema.parse(result)).toEqual(result);
    // One statement, keyed by the object, bounded lists and a bounded path.
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("with recursive"),
      [ids.chapter, 25, 31]
    ]);
  });

  it("ends the path of a note with the note itself, after its topics and its sources", async () => {
    const { service } = setup([row({ title: "A note" })]);
    const result = await service.locate({ address: `memora://note/${ids.note}` });
    expect(result?.primaryPath.map((item) => [item.kind, item.title])).toEqual([
      ["topic", ""],
      ["topic", "Memory"],
      ["source", "Book"],
      ["source", "Chapter"],
      ["note", "A note"]
    ]);
    expect(result?.object).toEqual({ kind: "note", id: ids.note, title: "A note" });
  });

  it("ignores anchors: they point inside the object and do not change where it is", async () => {
    const { service, query } = setup();
    const anchored = await service.locate({
      address: `memora://source/${ids.chapter}#passage=${ids.chunk}`
    });
    expect(anchored?.object.id).toBe(ids.chapter);
    expect((query.mock.calls[0] as unknown[] | undefined)?.[1]).toEqual([ids.chapter, 25, 31]);
  });

  it("returns null for an object that does not exist", async () => {
    expect(
      await setup([row({ title: null })]).service.locate({ address: `memora://source/${ids.book}` })
    ).toBeNull();
    expect(await setup([]).service.locate({ address: `memora://note/${ids.note}` })).toBeNull();
  });

  it("fails clearly for kinds that have no page yet, without querying", async () => {
    for (const kind of ["topic", "question", "entity"]) {
      const { service, query } = setup();
      await expect(service.locate({ address: `memora://${kind}/${ids.page}` })).rejects.toThrow(
        "objects.errors.unsupportedKind"
      );
      expect(query).not.toHaveBeenCalled();
    }
  });

  it("refuses malformed requests and an unavailable database", async () => {
    const { service, query } = setup();
    for (const input of [
      undefined,
      {},
      { address: "" },
      { address: ids.book },
      { address: `memora://wiki/${ids.page}` },
      { address: `memora://source/${ids.book}`, extra: true }
    ])
      await expect(service.locate(input)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    await expect(
      setup(null).service.locate({ address: `memora://source/${ids.book}` })
    ).rejects.toThrow("objects.errors.unavailable");
  });

  it("never passes an answer that breaks the contract to the renderer", async () => {
    const { service } = setup([row({ alsoIn: [{ kind: "wiki_page", id: ids.page, title: "x" }] })]);
    await expect(service.locate({ address: `memora://source/${ids.chapter}` })).rejects.toThrow();
  });

  it("refuses a secondary placement that is not a topic, and sends no legacy flag", async () => {
    const { service: wrongKind } = setup([
      row({ alsoIn: [{ kind: "note", id: ids.page, title: "x" }] })
    ]);
    await expect(wrongKind.locate({ address: `memora://source/${ids.chapter}` })).rejects.toThrow();
    // A stale row that still carries the removed flag loses it on the way to the renderer.
    const { service: flagged } = setup([
      row({ alsoIn: [{ kind: "topic", id: ids.page, title: "x", legacy: true }] })
    ]);
    const result = await flagged.locate({ address: `memora://source/${ids.chapter}` });
    expect(result?.alsoIn).toEqual([{ kind: "topic", id: ids.page, title: "x" }]);
  });
});

describe("objects IPC registration", () => {
  it("handles objects.locate and validates the payload before the service", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const locate = vi.fn(async () => null);
    registerObjectsIpc(ipc as unknown as IpcMain, { locate } as unknown as ObjectsService);
    const handler = handlers.get(ipcChannels.objectsLocate);
    expect(ipcChannels.objectsLocate).toBe("app:objects:locate");
    expect(handler).toBeDefined();
    expect(() => handler!({}, { address: "nope" })).toThrow();
    expect(locate).not.toHaveBeenCalled();
    const input = { address: `memora://note/${ids.note}` };
    await handler!({}, input);
    expect(locate).toHaveBeenCalledWith(input);
  });
});

describe("ObjectsService.neighborhood and its IPC registration (R30)", () => {
  const note = (n: number, depth: 0 | 1) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind: "note" as const,
    title: `Note ${n}`,
    ideaStatement: `Idea ${n}.`,
    language: null,
    depth
  });

  /** A pool whose connection answers the three statements of the repository. */
  function pooled(focusFound: boolean) {
    const focus = note(1, 0);
    const query = vi.fn(async (config: string | { name?: string }) => {
      const name = typeof config === "string" ? "" : (config.name ?? "");
      if (name === "object-neighborhood-neighbours")
        return {
          rows: [
            focusFound
              ? { focus, total: 1, neighbours: [{ ...note(2, 1), depth: undefined }] }
              : { focus: null, total: 0, neighbours: [] }
          ]
        };
      return { rows: [] };
    });
    const pool = {
      connect: async () => ({ query, release: () => undefined })
    } as unknown as PgPool;
    return { service: new ObjectsService(() => pool), query };
  }

  it("validates the request: notes only, depth 1 or 2, at most 40 nodes", async () => {
    const { service, query } = pooled(true);
    const objectId = note(1, 0).id;
    await expect(service.neighborhood({ objectId, objectTypes: ["source"] })).rejects.toThrow();
    await expect(service.neighborhood({ objectId, depth: 3 })).rejects.toThrow();
    await expect(service.neighborhood({ objectId, limit: 41 })).rejects.toThrow();
    await expect(service.neighborhood({ objectId: "nope" })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("answers the contract for a note, null for a missing one, and fails without a database", async () => {
    const objectId = note(1, 0).id;
    const found = await pooled(true).service.neighborhood({ objectId });
    expect(found).toMatchObject({
      focus: objectId,
      depth: 1,
      nodes: [
        { id: objectId, depth: 0 },
        { id: note(2, 1).id, depth: 1 }
      ],
      edges: [],
      neighbourTotal: 1,
      truncated: false
    });
    expect(await pooled(false).service.neighborhood({ objectId })).toBeNull();
    await expect(new ObjectsService(() => null).neighborhood({ objectId })).rejects.toThrow(
      "objects.errors.unavailable"
    );
  });

  it("handles objects.neighborhood and validates the payload before the service", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const neighborhood = vi.fn(async () => null);
    registerObjectsIpc(
      ipc as unknown as IpcMain,
      { locate: vi.fn(), neighborhood } as unknown as ObjectsService
    );
    const handler = handlers.get(ipcChannels.objectsNeighborhood);
    expect(ipcChannels.objectsNeighborhood).toBe("app:objects:neighborhood");
    expect(handler).toBeDefined();
    expect(() => handler!({}, { objectId: "nope" })).toThrow();
    expect(() => handler!({}, { objectId: ids.note, objectTypes: ["topic"] })).toThrow();
    expect(neighborhood).not.toHaveBeenCalled();
    await handler!({}, { objectId: ids.note });
    expect(neighborhood).toHaveBeenCalledWith({
      objectId: ids.note,
      objectTypes: ["note"],
      depth: 1,
      limit: 40
    });
  });
});

describe("ObjectsService.get, resolveMany and backlinks (F5 D11)", () => {
  // The SQL runs against a real database in `objectReadRepository.sidecar.test.ts`; these pin the
  // boundary: what is validated, what is refused, how a missing object and a cursor travel.
  const sourceRow = {
    id: ids.book,
    title: "Book",
    raw: "A **bold** summary.",
    language: "en",
    updatedAt: new Date("2026-11-11T10:00:00.000Z"),
    notes: "3",
    passages: 12
  };
  const pooled = (rows: unknown[]) => {
    const query = vi.fn(async () => ({ rows }));
    return { service: new ObjectsService(() => ({ query }) as unknown as PgPool), query };
  };

  it("gets one object with the stable contract, and answers missing for no row", async () => {
    const { service, query } = pooled([sourceRow]);
    expect(await service.get({ address: `memora://source/${ids.book}` })).toEqual({
      address: `memora://source/${ids.book}`,
      kind: "source",
      title: "Book",
      status: "current",
      preview: "A bold summary.",
      language: "en",
      updatedAt: "2026-11-11T10:00:00.000Z",
      counts: { notes: 3, passages: 12 }
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(await pooled([]).service.get({ address: `memora://note/${ids.note}` })).toEqual({
      status: "missing"
    });
  });

  it("refuses an address that is not an object address, and fails without a database", async () => {
    const { service, query } = pooled([]);
    await expect(service.get({ address: "memora://open/source/x" })).rejects.toThrow();
    await expect(
      service.get({ address: `memora://source/${ids.book}`, extra: 1 })
    ).rejects.toThrow();
    await expect(service.resolveMany({ addresses: ["nope"] })).rejects.toThrow();
    await expect(service.backlinks({ address: "nope" })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    await expect(
      new ObjectsService(() => null).get({ address: `memora://source/${ids.book}` })
    ).rejects.toThrow("objects.errors.unavailable");
  });

  it("resolves many keyed by the address as requested, with the missing ones listed", async () => {
    const { service } = pooled([sourceRow]);
    const upper = `memora://source/${ids.book.toUpperCase()}`;
    const absent = `memora://note/${ids.note}`;
    const result = await service.resolveMany({ addresses: [upper, absent] });
    expect(Object.keys(result.items)).toEqual([upper]);
    expect(result.items[upper]?.address).toBe(`memora://source/${ids.book}`);
    expect(result.missing).toEqual([absent]);
    expect(await service.resolveMany({ addresses: [] })).toEqual({ items: {}, missing: [] });
  });

  it("asks for paths only when the request does", async () => {
    const { service, query } = pooled([sourceRow]);
    await service.resolveMany({ addresses: [`memora://source/${ids.book}`] });
    expect(query).toHaveBeenCalledTimes(1);
    await service.resolveMany({
      addresses: [`memora://source/${ids.book}`],
      include: { path: true }
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("pages backlinks: items validated, a cursor handed out and taken back, a bad one refused", async () => {
    const row = (n: number) => ({
      arm: 0,
      from: `memora://note/${ids.note}`,
      anchor: `passage=${ids.chunk}`,
      snippet: "A **passage** of the source.",
      id: `00000000-0000-4000-8000-0000000001${n}0`,
      createdAt: `2026-11-11T10:00:0${n}.123456Z`
    });
    const { service, query } = pooled([row(3), row(2), row(1)]);
    const first = await service.backlinks({ address: `memora://source/${ids.book}`, limit: 2 });
    const item = {
      from: `memora://note/${ids.note}`,
      via: "evidence",
      anchor: `passage=${ids.chunk}`,
      snippet: "A passage of the source."
    };
    expect(first.items).toEqual([item, item]);
    expect(first.next).toBeDefined();
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [
      ids.book,
      -1,
      expect.any(String),
      expect.any(String),
      3
    ]);
    await service.backlinks({
      address: `memora://source/${ids.book}`,
      limit: 2,
      cursor: first.next
    });
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [
      ids.book,
      0,
      "2026-11-11T10:00:02.123456Z",
      "00000000-0000-4000-8000-000000000120",
      3
    ]);
    await expect(
      service.backlinks({ address: `memora://source/${ids.book}`, cursor: "garbage" })
    ).rejects.toThrow("errors.common.validationFailed");
    await expect(
      service.backlinks({ address: `memora://source/${ids.book}`, limit: 51 })
    ).rejects.toThrow();
  });

  it("answers no backlinks for a question without reading", async () => {
    const { service, query } = pooled([]);
    expect(await service.backlinks({ address: `memora://question/${ids.page}` })).toEqual({
      items: []
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("registers the three channels and validates each payload before the service", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const service = {
      locate: vi.fn(),
      neighborhood: vi.fn(),
      get: vi.fn(),
      resolveMany: vi.fn(),
      backlinks: vi.fn()
    };
    registerObjectsIpc(ipc as unknown as IpcMain, service as unknown as ObjectsService);
    const call = (channel: string, payload: unknown) => handlers.get(channel)!({}, payload);
    const note = `memora://note/${ids.note}`;
    expect(() => call(objectsIpcChannels.objectsGet, { address: "nope" })).toThrow();
    expect(() => call(objectsIpcChannels.objectsResolveMany, { addresses: ["nope"] })).toThrow();
    expect(() => call(objectsIpcChannels.objectsBacklinks, { address: "nope" })).toThrow();
    expect(service.get).not.toHaveBeenCalled();
    await call(objectsIpcChannels.objectsGet, { address: note });
    await call(objectsIpcChannels.objectsResolveMany, { addresses: [note] });
    await call(objectsIpcChannels.objectsBacklinks, { address: note });
    expect(service.get).toHaveBeenCalledWith({ address: note });
    expect(service.resolveMany).toHaveBeenCalledWith({ addresses: [note] });
    expect(service.backlinks).toHaveBeenCalledWith({ address: note, limit: 50 });
  });
});
