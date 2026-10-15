import { describe, expect, it, vi } from "vitest";
import type { QueryResultRow } from "pg";

import type { PgPool } from "../client.js";
import { createObsidianEditorialRepository } from "./obsidianEditorialRepository.js";
import { createObsidianSyncRepository } from "./obsidianSyncRepository.js";
import { createObsidianWikiRepository } from "./obsidianWikiRepository.js";
import type { Queryable } from "./types.js";

// The statements run against PostgreSQL in the T34a proof (obsidian-wiki-retire.sidecar.test.ts);
// this pins their shape: the retired status is only ever compared as text, so the queries stay valid
// on a database that has not gained the enum value yet.
function fake(rows: QueryResultRow[] = []) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  return { query, db: { query } as unknown as Queryable, pool: { query } as unknown as PgPool };
}
const row = {
  id: "11111111-1111-4111-8111-111111111111",
  memoraId: "22222222-2222-4222-8222-222222222222",
  entityType: "wiki_page",
  entityId: "22222222-2222-4222-8222-222222222222",
  sourceItemId: null,
  documentId: null,
  memoraType: "wiki_page",
  relativePath: "Memora/Wiki/Page.md",
  frontmatterHash: "f",
  contentHash: "c",
  mtimeMs: "12",
  syncVersion: 3,
  status: "retired",
  lastSyncedAt: null,
  deletedAt: null,
  metadata: { retired: { outcome: "kept" } },
  createdAt: new Date("2026-10-15T10:00:00Z"),
  updatedAt: new Date("2026-10-15T11:00:00Z")
};

describe("obsidianSyncRepository.listWikiFiles", () => {
  it("lists wiki page and index files by path and maps the rows", async () => {
    const { db, query } = fake([row]);
    const files = await createObsidianSyncRepository(db).listWikiFiles(true);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      memoraId: row.memoraId,
      relativePath: "Memora/Wiki/Page.md",
      status: "retired",
      mtimeMs: 12,
      metadata: { retired: { outcome: "kept" } }
    });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("memora_type in ('wiki_page', 'wiki_index')");
    expect(sql).toContain("entity_type in ('wiki_page', 'wiki_index')");
    expect(sql).toContain("(status::text = 'retired') = $1");
    expect(sql).toContain("order by relative_path");
    expect(params).toEqual([true]);
  });

  it("asks for the live rows with the opposite flag", async () => {
    const { db, query } = fake();
    expect(await createObsidianSyncRepository(db).listWikiFiles(false)).toEqual([]);
    expect((query.mock.calls[0] as unknown as [string, unknown[]])[1]).toEqual([false]);
  });
});

describe("obsidianWikiRepository", () => {
  it("finds which of the given pages still exist, and asks nothing for an empty list", async () => {
    const { pool, query } = fake([{ id: "a" }, { id: "b" }]);
    const repository = createObsidianWikiRepository(pool);
    expect(await repository.existingPageIds([])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(await repository.existingPageIds(["a", "b", "c"])).toEqual(["a", "b"]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("from wiki_pages where id=any($1::uuid[])");
    expect(params).toEqual([["a", "b", "c"]]);
  });

  it("leaves the projection conflicts of retired files out", async () => {
    const { pool, query } = fake([
      { id: "1", memora_id: "a", relative_path: "p", status: "conflict", error: null },
      { id: "2", memora_id: "b", relative_path: "q", status: "written", error: null }
    ]);
    const conflicts = await createObsidianWikiRepository(pool).conflicts("binding");
    expect(conflicts.map((c) => c.memora_id)).toEqual(["a"]);
    const sql = (query.mock.calls[0] as unknown as [string])[0];
    expect(sql).toContain("f.memora_id=r.memora_id and f.status::text='retired'");
  });
});

describe("obsidianEditorialRepository.conflicts", () => {
  it("does not list the editorial conflicts of a retired file", async () => {
    const { pool, query } = fake();
    await createObsidianEditorialRepository(pool).conflicts("binding");
    const sql = (query.mock.calls[0] as unknown as [string])[0];
    expect(sql).toContain("f.memora_id=o.target_id and f.status::text='retired'");
  });
});
