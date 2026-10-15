import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import { resetClearedTables } from "./libraryResetRepository.js";
import {
  createViewHistoryRepository,
  normalizeViewHistoryTitle,
  viewHistoryAddress,
  viewHistoryKinds,
  viewHistoryLimits
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
    expect(viewHistoryKinds).toEqual(["source", "note", "topic", "question", "entity"]);
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

  it("lists pinned entries first and bounds the page", async () => {
    const { repository, query } = setup([storedRow({ pinned: true })]);
    expect(await repository.list()).toHaveLength(1);
    await repository.list({ limit: 1000, kinds: ["source", "note"] });
    await repository.list({ limit: 0 });
    const calls = query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls[0]![0]).toContain("order by h.pinned desc, h.opened_at desc");
    expect(calls[0]![0]).toContain("from source_items s where s.id = h.object_id");
    expect(calls[0]![1]).toEqual([null, viewHistoryLimits.listDefault]);
    expect(calls[1]![1]).toEqual([["source", "note"], viewHistoryLimits.listMax]);
    expect(calls[2]![1]).toEqual([null, 1]);
  });

  it("pins and unpins by address, and reports an address that was never opened", async () => {
    const found = setup([storedRow({ pinned: true })]);
    expect((await found.repository.setPinned(`memora://source/${sourceId}`, true))?.pinned).toBe(
      true
    );
    expect(found.query.mock.calls[0]![1]).toEqual([`memora://source/${sourceId}`, true]);
    const missing = setup([]);
    expect(await missing.repository.setPinned(`memora://source/${sourceId}`, false)).toBeNull();
  });

  it("clears the unpinned entries and keeps the pins", async () => {
    const { repository, query } = setup([], 4);
    expect(await repository.clear()).toBe(4);
    expect(query.mock.calls[0]![0]).toBe("delete from view_history where pinned = false");
  });
});
