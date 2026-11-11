import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "./client.js";
import { runMigrations } from "./migrations.js";
import { omniArmParameters, omniArms } from "./objectSearchArms.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "./sidecar/index.js";

// Migration 0067 (object_search_indexes, F5 T117) on a database that already holds a library: the
// indexes exist and say what omni's arms need, the two unused chunk indexes are gone and the
// passages are untouched, the topic document is generated, and EXPLAIN (sequential scans off, small
// tables) uses each index for the exact arm expression of spec 3.4. The thorough run, with timings
// and the baseline comparison, is `npm run db:search-indexes:verify`.
const workspace = resolve(import.meta.dirname, "../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const seedFolder = join(workspace, "packages/db/seed");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const lastTag = "0067_object_search_indexes";

const newIndexes = [
  "chunks_search_tsv_idx",
  "entities_aliases_trgm_idx",
  "entities_canonical_name_trgm_idx",
  "source_items_title_trgm_idx",
  "topics_search_tsv_idx",
  "topics_title_trgm_idx"
];
const oldIndexes = ["chunks_content_fts_idx", "chunks_content_trgm_idx"];

describe.skipIf(!sidecarInstalled)("migration 0067 on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let baselinePool: PgPool;
  let connectionString = "";
  let chunksBefore: unknown;

  const chunksFingerprint = async (): Promise<unknown> =>
    (
      await pool.query(
        `select count(*)::int as count, md5(string_agg(concat_ws('|', id, content, content_hash,
                search_tsv::text), ',' order by id)) as digest from chunks`
      )
    ).rows[0];
  const definitions = async (db: PgPool): Promise<Record<string, string>> =>
    Object.fromEntries(
      (
        await db.query<{ indexname: string; indexdef: string }>(
          "select indexname, indexdef from pg_indexes where indexname = any($1::text[]) order by indexname",
          [[...newIndexes, ...oldIndexes]]
        )
      ).rows.map((row) => [row.indexname, row.indexdef])
    );
  const plan = async (sql: string): Promise<string> => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local enable_seqscan = off");
      const rows = await client.query<{ "QUERY PLAN": string }>(`explain ${sql}`, [
        ...omniArmParameters
      ]);
      await client.query("rollback");
      return rows.rows.map((row) => row["QUERY PLAN"]).join("\n");
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-search-indexes-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_search_indexes_test",
        user: "memora_search_indexes_test",
        password: `search-indexes-${randomUUID()}`,
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
    connectionString = connection.connectionString;
    pool = createPgPool({ connectionString, max: 2 });

    // The history ends right before 0067: the state of a library before it.
    const before = join(workDir, "before");
    await cp(migrationsFolder, before, { recursive: true });
    const journal = JSON.parse(await readFile(join(before, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry) => entry.tag === lastTag)
    );
    await writeFile(join(before, "meta/_journal.json"), JSON.stringify(journal));
    await runMigrations(pool, before);

    const source = randomUUID();
    const document = randomUUID();
    await pool.query("insert into source_items (id, type, title) values ($1, 'Book', $2)", [
      source,
      "Memória e coração"
    ]);
    await pool.query(
      "insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, 'D', 't', 'h')",
      [document, source]
    );
    for (let index = 0; index < 20; index += 1)
      await pool.query(
        `insert into chunks (document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, $4, $5)`,
        [document, source, index, `Memória e ação número ${index}`, `c-${index}`]
      );
    for (const [name, aliases] of [
      ["Ação Humana", ["Praxeologia"]],
      ["Odd aliases", { not: "an array" }]
    ] as const)
      await pool.query(
        `insert into entities (type, canonical_name, normalized_name, aliases, confidence)
         values ('concept', $1, lower($1), $2::jsonb, 0.9)`,
        [name, JSON.stringify(aliases)]
      );
    const tree = randomUUID();
    const root = randomUUID();
    await pool.query(
      `insert into topic_trees (id, status, space_key, embedding_provider, embedding_model,
          embedding_runtime, dimensions, config, config_hash, seed, activated_at)
       values ($1, 'active', 'k', 'p', 'm', 'r', 256, '{}', 'h', 1, now())`,
      [tree]
    );
    await pool.query(
      "insert into topics (id, tree_id, role, name_state, management) values ($1, $2, 'root', 'unnamed', 'human')",
      [root, tree]
    );
    await pool.query(
      `insert into topics (tree_id, parent_id, role, title, name_state, name_source, description, aliases, management)
       values ($1, $2, 'topic', 'Memória e sono', 'named', 'human', 'Descrição com ação', '["Coração"]', 'human')`,
      [tree, root]
    );
    await pool.query(
      `insert into questions (text, privacy, mode, status)
       values ('Como a memória consolida o sono?', 'offline_only', 'text', 'complete')`
    );
    chunksBefore = await chunksFingerprint();
    expect(Object.keys(await definitions(pool)).sort()).toEqual(oldIndexes);

    await runMigrations(pool, migrationsFolder);

    await pool.query("create database memora_search_indexes_baseline");
    const url = new URL(connectionString);
    url.pathname = "/memora_search_indexes_baseline";
    baselinePool = createPgPool({ connectionString: url.toString(), max: 2 });
    await runMigrations(baselinePool, migrationsFolder, { seedFolder });
  }, 240_000);

  afterAll(async () => {
    await closePgPool(baselinePool).catch(() => undefined);
    await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  });

  it("creates every index valid and drops the two unused chunk indexes", async () => {
    const found = await definitions(pool);
    expect(Object.keys(found).sort()).toEqual(newIndexes);
    expect(found.topics_search_tsv_idx).toContain("USING gin (search_tsv)");
    expect(found.chunks_search_tsv_idx).toContain("USING gin (search_tsv)");
    expect(found.topics_title_trgm_idx).toContain("USING gin (f_unaccent(title) gin_trgm_ops)");
    expect(found.source_items_title_trgm_idx).toContain(
      "USING gin (f_unaccent(title) gin_trgm_ops)"
    );
    expect(found.entities_canonical_name_trgm_idx).toContain(
      "USING gin (f_unaccent(canonical_name) gin_trgm_ops)"
    );
    expect(found.entities_aliases_trgm_idx).toContain(
      "USING gin (f_unaccent(f_jsonb_text_array(aliases)) gin_trgm_ops)"
    );
    const invalid = await pool.query(
      "select 1 from pg_index i join pg_class c on c.oid = i.indexrelid where not i.indisvalid"
    );
    expect(invalid.rowCount).toBe(0);
    expect(await chunksFingerprint()).toEqual(chunksBefore);
  });

  it("is immutable and reads anything that is not an array as empty", async () => {
    const properties = await pool.query(
      `select provolatile::text as volatility, proparallel::text as parallel, proisstrict as strict
         from pg_proc where proname = 'f_jsonb_text_array'`
    );
    expect(properties.rows).toEqual([{ volatility: "i", parallel: "s", strict: true }]);
    const read = async (value: string) =>
      (await pool.query("select f_jsonb_text_array($1::jsonb) as text", [value])).rows[0]?.text;
    expect(await read('["a", "b c"]')).toBe("a b c");
    expect(await read("[]")).toBe("");
    expect(await read('{"x": 1}')).toBe("");
    expect(await read('"scalar"')).toBe("");
  });

  it("stores the topic document: title A, aliases B, description C, unaccented", async () => {
    const stored = await pool.query<{ tsv: string; matches: boolean }>(
      `select search_tsv::text as tsv, search_tsv @@ to_tsquery('simple', 'memoria:* & sono') as matches
         from topics where title is not null`
    );
    expect(stored.rows[0]?.matches).toBe(true);
    expect(stored.rows[0]?.tsv).toContain("'sono':3A");
    expect(stored.rows[0]?.tsv).toContain("'coracao':4B");
    expect(stored.rows[0]?.tsv).toContain("'acao':7C");
    const unnamed = await pool.query<{ tsv: string }>(
      "select search_tsv::text as tsv from topics where title is null"
    );
    expect(unnamed.rows[0]?.tsv).toBe("");
  });

  it.each(omniArms.map((arm) => [`${arm.arm} on ${arm.table}`, arm] as const))(
    "uses its index for the %s arm and scans no table sequentially",
    async (_label, arm) => {
      const text = await plan(arm.sql);
      expect(text).toContain(`Bitmap Index Scan on ${arm.index}`);
      expect(text).not.toMatch(new RegExp(`Seq Scan on ${arm.table}\\b`, "u"));
    }
  );

  it("finds an entity by an alias, unaccented, through the alias arm", async () => {
    const alias = omniArms.find((arm) => arm.arm === "alias_trgm")!;
    const rows = await pool.query(alias.sql, ["praxeologia", "praxeologia:*"]);
    expect(rows.rowCount).toBe(1);
  });

  it("gives a database built from the baseline the same index definitions", async () => {
    expect(await definitions(baselinePool)).toEqual(await definitions(pool));
  });
});
