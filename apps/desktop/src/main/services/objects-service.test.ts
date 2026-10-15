import { describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { PgPool } from "@app/db";
import { ObjectLocateResultSchema } from "@app/domain";

import { ipcChannels } from "../../shared/ipc.js";
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
