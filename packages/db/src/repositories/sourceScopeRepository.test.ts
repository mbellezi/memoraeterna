import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createSourceScopeRepository, sourceScopeSql } from "./sourceScopeRepository.js";
import type { Queryable } from "./types.js";

// The scope pickers' source search against a real PostgreSQL database: text and accent matching,
// the descendants of a scope, breadcrumbs, catalog-only sources and the paging bound.
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const u = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = { book: u(1), chapter: u(2), paper: u(3), note: u(4), catalog: u(5) };
const defaults = { text: "", sourceIds: [], includeDescendants: true, limit: 30, offset: 0 };

describe("source scope search", () => {
  it("asks for one row more than the page to know whether more follow", async () => {
    const rows = [1, 2, 3].map((n) => ({ id: u(n), kind: "source" }));
    const query = vi.fn(async () => ({ rows }) as never);
    const db: Queryable = { query };
    const page = await createSourceScopeRepository(db).search({
      ...defaults,
      text: "memory",
      sourceIds: [ids.book],
      includeDescendants: false,
      limit: 2,
      offset: 4
    });
    expect(query).toHaveBeenCalledWith(sourceScopeSql, ["memory", [ids.book], false, 3, 4]);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });
});

describe.skipIf(!sidecarInstalled)("source scope search on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  const search = (
    input: Partial<Parameters<ReturnType<typeof createSourceScopeRepository>["search"]>[0]>
  ) => createSourceScopeRepository(pool).search({ ...defaults, ...input });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-source-scope-"));
    // Parallel test files pick free ports the same way; a lost race needs only a fresh attempt.
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_source_scope_test",
        user: "memora_source_scope_test",
        password: `source-scope-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    const insert = (id: string, type: string, title: string, parent: string | null, sub?: string) =>
      pool.query(
        "insert into source_items (id, type, title, parent_source_item_id, subtitle) values ($1, $2, $3, $4, $5)",
        [id, type, title, parent, sub ?? null]
      );
    await insert(ids.book, "Book", "Memória e esquecimento", null, "A study");
    await insert(ids.chapter, "BookChapter", "Active recall", ids.book);
    await insert(ids.paper, "AcademicPaper", "Memory consolidation", null);
    await insert(ids.note, "PersonalNote", "My notes", null);
    await insert(ids.catalog, "Book", "Not acquired yet", null);
    // Only the chapter, the paper and the note hold readable content.
    for (const id of [ids.chapter, ids.paper, ids.note]) {
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'text', $3)`,
        [randomUUID(), id, `hash-${id}`]
      );
    }
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash, metadata)
       values ($1, $2, 'Document', 'text', 'hash-catalog', '{"processingMode":"catalog_metadata"}')`,
      [randomUUID(), ids.catalog]
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("lists the whole library with the path of each source", async () => {
    const { items, hasMore } = await search({});
    expect(hasMore).toBe(false);
    expect(items.map((item) => item.title).toSorted()).toEqual(
      [
        "Active recall",
        "Memory consolidation",
        "Memória e esquecimento",
        "My notes",
        "Not acquired yet"
      ].toSorted()
    );
    expect(items.find((item) => item.id === ids.chapter)).toMatchObject({
      kind: "source",
      sourceItemId: ids.chapter,
      sourceType: "BookChapter",
      breadcrumb: "Memória e esquecimento / Active recall",
      catalogOnly: false,
      exact: false
    });
  });

  it("matches title, subtitle and metadata without regard to accents or case", async () => {
    expect((await search({ text: "MEMORIA" })).items.map((i) => i.id)).toEqual([ids.book]);
    expect((await search({ text: "a study" })).items.map((i) => i.id)).toEqual([ids.book]);
    expect((await search({ text: "nothing like this" })).items).toEqual([]);
  });

  it("puts an exact title first and flags catalog-only sources", async () => {
    const { items } = await search({ text: "memory consolidation" });
    expect(items[0]).toMatchObject({ id: ids.paper, exact: true, catalogOnly: false });
    const all = (await search({})).items;
    expect(all.find((item) => item.id === ids.catalog)?.catalogOnly).toBe(true);
    // The book holds no document of its own; only its chapter does.
    expect(
      all
        .filter((item) => item.catalogOnly)
        .map((item) => item.id)
        .toSorted()
    ).toEqual([ids.book, ids.catalog].toSorted());
  });

  it("limits the search to the chosen sources and, on request, their descendants", async () => {
    expect((await search({ sourceIds: [ids.book] })).items.map((i) => i.id).toSorted()).toEqual(
      [ids.chapter, ids.book].toSorted()
    );
    expect(
      (await search({ sourceIds: [ids.book], includeDescendants: false })).items.map((i) => i.id)
    ).toEqual([ids.book]);
  });

  it("pages with a bounded window", async () => {
    const first = await search({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const last = await search({ limit: 2, offset: 4 });
    expect(last.items).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });
});
