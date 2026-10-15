import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { objectKinds, parseObjectAddress } from "@app/domain";
import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import { resetClearedTables } from "./libraryResetRepository.js";
import {
  createViewHistoryRepository,
  normalizeViewHistoryTitle,
  viewHistoryAddress,
  viewHistoryKinds,
  viewHistoryLimits,
  viewHistoryPinLimitMessage
} from "./viewHistoryRepository.js";
import type { Queryable } from "./types.js";

// The real SQL runs in `npm run db:view-history:verify`; this pins the parameters, the bounds and
// that the schema, the migration and the repository agree on the object kinds.
const sourceId = "00000000-0000-4000-8000-000000000001";
const noteId = "00000000-0000-4000-8000-000000000002";

const storedRow = (overrides: Record<string, unknown> = {}) => ({
  address: viewHistoryAddress("source", sourceId),
  kind: "source",
  objectId: sourceId,
  title: "A source",
  parentAddress: null,
  openedAt: "2026-10-15T10:00:00.000Z",
  openCount: 1,
  pinned: false,
  ...overrides
});

function setup(rows: QueryResultRow[] = [], rowCount = rows.length) {
  const query = vi.fn(
    async <T extends QueryResultRow>() => ({ rows, rowCount }) as unknown as QueryResult<T>
  );
  const db: Queryable = { query };
  return { repository: createViewHistoryRepository(db), query };
}

describe("view history repository", () => {
  it("addresses an object by kind and ID, never by title", () => {
    expect(viewHistoryAddress("note", noteId)).toBe(`memora://note/${noteId}`);
    // The one parser and kind list are the domain's, so the table check and the address grammar
    // cannot drift from the router, links and Cmd-K.
    expect(viewHistoryKinds).toBe(objectKinds);
    expect(viewHistoryKinds).toEqual(["source", "note", "topic", "question", "entity"]);
    for (const kind of objectKinds)
      expect(parseObjectAddress(viewHistoryAddress(kind, noteId))).toEqual({ kind, id: noteId });
    expect(viewHistoryAddress("source", sourceId.toUpperCase())).toBe(
      `memora://source/${sourceId}`
    );
    expect(() => viewHistoryAddress("source", "My Source")).toThrow();
  });

  it("keeps the kinds and the address shape in the migration that creates the table", () => {
    const folder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
    const file = readdirSync(folder).find((name) => name.endsWith("_view_history.sql"));
    const sql = readFileSync(resolve(folder, file!), "utf8");
    const kinds = /"kind" in \(([^)]*)\)/u.exec(sql)?.[1];
    expect(kinds?.split(",").map((kind) => kind.trim().replaceAll("'", ""))).toEqual([
      ...viewHistoryKinds
    ]);
    expect(sql).toContain("'memora://' || ");
    expect(sql).toContain(`char_length("view_history"."title") between 1 and 300`);
    expect(viewHistoryLimits.titleCharacters).toBe(300);
  });

  it("is a table of the library reset, which clears everything it does not preserve", () => {
    expect(resetClearedTables).toContain("view_history");
  });

  it("normalizes a title to one trimmed line within the stored bound", () => {
    expect(normalizeViewHistoryTitle("  A\n title \t here ")).toBe("A title here");
    const long = "ab".repeat(400);
    expect(Array.from(normalizeViewHistoryTitle(long))).toHaveLength(300);
    // Cut by characters: a surrogate pair is never split.
    expect(Array.from(normalizeViewHistoryTitle("😀".repeat(400)))).toHaveLength(300);
    expect(() => normalizeViewHistoryTitle(" \n ")).toThrow("title");
  });

  it("records an open as an upsert on the address, then trims to the retention bound", async () => {
    const { repository, query } = setup([storedRow({ openCount: 3 })]);
    const entry = await repository.record({
      kind: "source",
      objectId: sourceId,
      title: " A\nsource "
    });
    const [insert, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(insert).toContain("on conflict (address) do update");
    expect(insert).toContain("open_count = h.open_count + 1");
    expect(insert).toContain("coalesce(excluded.parent_address, h.parent_address)");
    expect(values).toEqual(["source", sourceId, `memora://source/${sourceId}`, "A source", null]);
    const [trim, trimValues] = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(trim).toContain("pinned = false");
    expect(trimValues).toEqual([viewHistoryLimits.unpinnedEntries]);
    expect(entry).toMatchObject({ openCount: 3, pinned: false, parentAddress: null });
    expect(entry.openedAt).toEqual(new Date("2026-10-15T10:00:00.000Z"));
  });

  it("keeps the host of a note open", async () => {
    const { repository, query } = setup([
      storedRow({ kind: "note", objectId: noteId, parentAddress: `memora://source/${sourceId}` })
    ]);
    await repository.record({
      kind: "note",
      objectId: noteId,
      title: "A note",
      parentAddress: `memora://source/${sourceId}`
    });
    const [, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(values[4]).toBe(`memora://source/${sourceId}`);
  });

  it("gives pins and recents slots of their own, and bounds both", async () => {
    const { repository, query } = setup([storedRow({ pinned: true })]);
    expect(await repository.list()).toHaveLength(1);
    await repository.list({ limit: 1000, kinds: ["source", "note"] });
    await repository.list({ limit: 0 });
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls[0]![0]).toContain("order by h.pinned desc, h.opened_at desc");
    expect(calls[0]![0]).toContain("from source_items s where s.id = h.object_id");
    // Pins are numbered apart from recents, so many pins never push the recents off the page.
    expect(calls[0]![0]).toContain("partition by h.pinned order by h.opened_at desc");
    expect(calls[0]![0]).toContain(
      "(h.pinned and h.slot <= $3) or (not h.pinned and h.slot <= $2)"
    );
    const pins = viewHistoryLimits.pinnedEntries;
    expect(calls[0]![1]).toEqual([null, viewHistoryLimits.listDefault, pins]);
    expect(calls[1]![1]).toEqual([["source", "note"], viewHistoryLimits.listMax, pins]);
    expect(calls[2]![1]).toEqual([null, 1, pins]);
  });

  it("pins and unpins by address, and reports an address that was never opened", async () => {
    const found = setup([storedRow({ pinned: true })]);
    expect((await found.repository.setPinned(`memora://source/${sourceId}`, true))?.pinned).toBe(
      true
    );
    expect(found.query.mock.calls[0]![1]).toEqual([
      `memora://source/${sourceId}`,
      true,
      viewHistoryLimits.pinnedEntries
    ]);
    const missing = setup([]);
    expect(await missing.repository.setPinned(`memora://source/${sourceId}`, false)).toBeNull();
    expect(missing.query).toHaveBeenCalledTimes(1);
    expect(await missing.repository.setPinned(`memora://source/${sourceId}`, true)).toBeNull();
  });

  it("refuses a new pin past the cap, but still unpins and re-pins a pinned entry", async () => {
    expect(viewHistoryLimits.pinnedEntries).toBe(10);
    const address = `memora://source/${sourceId}`;
    // The update touches nothing at the cap; the entry exists, so the pin is refused.
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });
    const repository = createViewHistoryRepository({ query } as unknown as Queryable);
    await expect(repository.setPinned(address, true)).rejects.toThrow(viewHistoryPinLimitMessage);
    const [update] = query.mock.calls[0] as unknown as [string];
    // Only a new pin counts: unpinning, and pinning what is already pinned, always pass.
    expect(update).toContain("not $2::boolean or h.pinned");
    // A pin of an object that is gone is not listed, so it does not use up a slot either.
    expect(update).toContain("from view_history p");
    expect(update).toContain("p.pinned and");
    expect(update).toContain("from source_items s where s.id = p.object_id");
    expect(update).toContain(") < $3");
    expect(query.mock.calls[1]![1]).toEqual([address]);
  });

  it("forgets the entries of deleted objects, pinned or not, and what only their host can open", async () => {
    const { repository, query } = setup([], 3);
    expect(
      await repository.forgetObjects({
        sourceIds: [sourceId],
        noteIds: [noteId],
        entityIds: []
      })
    ).toBe(3);
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("delete from view_history");
    expect(sql).not.toContain("pinned");
    expect(values).toEqual([[sourceId], [noteId], [], [`memora://source/${sourceId}`]]);
    // A note, entity or source that survives its host keeps its entry: the host clause leaves the
    // kinds that have a table to the explicit IDs above.
    expect(sql).toContain(
      "or (parent_address = any($4::text[]) and kind not in ('source', 'note', 'entity'))"
    );
    expect(sql).not.toMatch(/\n\s*or parent_address/);
    // Nothing deleted, nothing asked.
    expect(await repository.forgetObjects({})).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("clears the unpinned entries and the pins of objects that no longer exist", async () => {
    const { repository, query } = setup([], 4);
    expect(await repository.clear()).toBe(4);
    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toContain("delete from view_history h where h.pinned = false or not (");
    // Pins of existing objects are not matched; a pin of a vanished object is.
    expect(sql).toContain("from source_items s where s.id = h.object_id");
    expect(sql).toContain("from atomic_notes n where n.id = h.object_id");
    expect(sql).toContain("from entities e where e.id = h.object_id");
  });
});
