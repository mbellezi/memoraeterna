import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "./client.js";
import { runMigrations } from "./migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "./sidecar/index.js";

// Migration 0064 (ask_text_vectors, F4 T79) on a database that already holds a library: the
// passages and notes survive the rewrite their new generated columns need, `search_tsv` and
// `ask_tsv` equal what their expressions compute, the evidence index is valid, nothing indexes the
// vectors (the statement has no `@@` for an index to serve), the history records the migration, and
// a database built from the baseline seed ends with the same definitions.
const workspace = resolve(import.meta.dirname, "../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const seedFolder = join(workspace, "packages/db/seed");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const lastTag = "0064_ask_text_vectors";

const searchExpression = "to_tsvector('simple', f_unaccent(content))";
const askExpression = "to_tsvector('simple', f_unaccent(idea_statement || ' ' || body_markdown))";

describe.skipIf(!sidecarInstalled)("migration 0064 on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let baselinePool: PgPool;
  let connectionString = "";
  const chunkCount = 90;
  const noteCount = 60;

  const fingerprint = async (): Promise<Record<string, string>> => {
    const rows = await pool.query<Record<string, string>>(
      `select (select md5(string_agg(concat_ws('|', id, document_id, chunk_index, content, content_hash,
                  language, metadata::text), ',' order by id)) from chunks) as chunks,
              (select count(*) from chunks)::text as "chunkCount",
              (select md5(string_agg(concat_ws('|', id, title, body_markdown, idea_statement, status,
                  supersession_status, language, metadata::text, search_tsv::text), ',' order by id)) from atomic_notes) as notes,
              (select count(*) from atomic_notes)::text as "noteCount"`
    );
    return rows.rows[0]!;
  };
  const definitions = async (db: PgPool): Promise<Record<string, string>> =>
    Object.fromEntries(
      (
        await db.query<{ indexname: string; indexdef: string }>(
          `select indexname, indexdef from pg_indexes
            where indexname = 'atomic_notes_evidence_chunk_id_idx' order by indexname`
        )
      ).rows.map((row) => [row.indexname, row.indexdef])
    );
  const generated = (db: PgPool, table: string, column: string) =>
    db.query<{ expression: string; kind: string }>(
      `select pg_get_expr(d.adbin, d.adrelid) as expression, a.attgenerated as kind
         from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
        where d.adrelid = $1::regclass and a.attname = $2`,
      [table, column]
    );

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-ask-text-vectors-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_ask_text_vectors_test",
        user: "memora_ask_text_vectors_test",
        password: `ask-text-vectors-${randomUUID()}`,
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

    // The migrations without 0064: the state of a library before it.
    const before = join(workDir, "before");
    await cp(migrationsFolder, before, {
      recursive: true,
      filter: (path) => !path.includes("0064_") && !path.includes("/meta/0064")
    });
    const journal = JSON.parse(await readFile(join(before, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    // The history ends right before 0064: a later migration applied first would put its time past
    // 0064's, and drizzle applies only what is newer than the last one applied.
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry) => entry.tag === lastTag)
    );
    await writeFile(join(before, "meta/_journal.json"), JSON.stringify(journal));
    await runMigrations(pool, before);

    // A library: passages with accents, capitals, an empty-looking one and a very long one, and
    // notes with accents, an empty body and a body past the 4,000 characters `search_tsv` keeps.
    const source = randomUUID();
    const document = randomUUID();
    await pool.query("insert into source_items (id, type, title) values ($1, 'Book', 'Book')", [
      source
    ]);
    await pool.query(
      "insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, 'D', 't', 'h')",
      [document, source]
    );
    const chunks: string[] = [];
    for (let index = 0; index < chunkCount; index += 1) {
      const id = randomUUID();
      chunks.push(id);
      const content =
        index % 30 === 29
          ? `${"palavra ".repeat(900)}fim`
          : index % 11 === 10
            ? "."
            : `Memória e coração número ${index}, O'Brien & "quotes" — AÇÃO e Ação, ação`;
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash, language)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, document, source, index, content, `c-${index}`, index % 2 ? "pt" : "und"]
      );
    }
    for (let index = 1; index <= noteCount; index += 1) {
      const body =
        index % 20 === 0
          ? `${"palavra ".repeat(700)}fim`
          : index % 7 === 0
            ? ""
            : `Memória e coração número ${index}, O'Brien & "quotes" — ação`;
      await pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
            evidence_chunk_id, generation_provider, generation_model, generation_runtime,
            generation_prompt_version, generation_key, status, supersession_status)
         values ($1::uuid, $2, $3, $4, $5, $6, 't', 't', 'local', 't', $1::text, $7, $8)`,
        [
          randomUUID(),
          `Título ${index} — ÁÉÍ`,
          body,
          index % 13 === 0 ? "" : `Ideia ${index}: a memória consolida o sono`,
          source,
          chunks[index % chunks.length],
          index % 17 === 0 ? "archived" : "active",
          index % 17 === 0 ? "superseded" : "current"
        ]
      );
    }
  }, 180_000);

  afterAll(async () => {
    if (baselinePool) await closePgPool(baselinePool).catch(() => undefined);
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("applies as a pending migration and keeps every passage and note", async () => {
    const columns = await pool.query(
      `select 1 from information_schema.columns
        where (table_name = 'chunks' and column_name = 'search_tsv')
           or (table_name = 'atomic_notes' and column_name = 'ask_tsv')`
    );
    expect(columns.rowCount).toBe(0);
    const beforeState = await fingerprint();
    expect(Number(beforeState.chunkCount)).toBe(chunkCount);
    expect(Number(beforeState.noteCount)).toBe(noteCount);

    await runMigrations(pool, migrationsFolder);
    expect(await fingerprint()).toEqual(beforeState);
  }, 120_000);

  it("adds both vectors as stored generated tsvectors equal to their expressions", async () => {
    for (const [table, column, expression] of [
      ["chunks", "search_tsv", searchExpression],
      ["atomic_notes", "ask_tsv", askExpression]
    ] as const) {
      const type = await pool.query<{ type: string; generated: string }>(
        `select format_type(a.atttypid, a.atttypmod) as type, a.attgenerated as generated
           from pg_attribute a where a.attrelid = $1::regclass and a.attname = $2`,
        [table, column]
      );
      expect(type.rows[0], `${table}.${column}`).toEqual({ type: "tsvector", generated: "s" });
      const mismatches = await pool.query<{ count: string }>(
        `select count(*)::text as count from ${table} where ${column} is distinct from (${expression})`
      );
      expect(mismatches.rows[0]!.count, `${table}.${column} against its expression`).toBe("0");
      const nulls = await pool.query<{ count: string }>(
        `select count(*)::text as count from ${table} where ${column} is null`
      );
      expect(nulls.rows[0]!.count, `${table}.${column} nulls`).toBe("0");
    }
  });

  it("folds accents and keeps the whole text, unweighted", async () => {
    const folded = await pool.query<{ ok: boolean }>(
      `select search_tsv @@ to_tsquery('simple', 'memoria & coracao & acao') as ok
         from chunks where content like 'Memória e coração número 1,%'`
    );
    expect(folded.rows[0]?.ok).toBe(true);
    // A passage longer than the 4,000 characters of the notes' search_tsv is kept whole here.
    const long = await pool.query<{ ok: boolean }>(
      "select search_tsv @@ to_tsquery('simple', 'fim') as ok from chunks where content like 'palavra%' limit 1"
    );
    expect(long.rows[0]?.ok).toBe(true);
    const wholeNote = await pool.query<{ ok: boolean }>(
      "select ask_tsv @@ to_tsquery('simple', 'fim') as ok from atomic_notes where body_markdown like 'palavra%' limit 1"
    );
    expect(wholeNote.rows[0]?.ok).toBe(true);
    // The weighted vector of 0058 still cuts the body: ask_tsv is another column, not a rename.
    const cut = await pool.query<{ ok: boolean }>(
      "select not (search_tsv @@ to_tsquery('simple', 'fim')) as ok from atomic_notes where body_markdown like 'palavra%' limit 1"
    );
    expect(cut.rows[0]?.ok).toBe(true);
    const weights = await pool.query<{ ask: boolean; search: boolean }>(
      `select bool_or(ask_tsv::text ~ '[0-9][A-D]') as ask, bool_or(search_tsv::text ~ '[0-9][A-D]') as search
         from atomic_notes`
    );
    expect(weights.rows[0]).toEqual({ ask: false, search: true });
  });

  it("creates a valid evidence index and no index on the vectors", async () => {
    const valid = await pool.query<{ valid: boolean }>(
      `select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = 'atomic_notes_evidence_chunk_id_idx'`
    );
    expect(valid.rows).toEqual([{ valid: true }]);
    expect((await definitions(pool)).atomic_notes_evidence_chunk_id_idx).toContain(
      "USING btree (evidence_chunk_id)"
    );
    // No query of the statement uses `@@`, so a GIN on the vectors would serve none.
    const onVectors = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes
        where (tablename = 'chunks' and indexdef like '%search_tsv%')
           or (tablename = 'atomic_notes' and indexdef like '%ask_tsv%')`
    );
    expect(onVectors.rows).toEqual([]);
  });

  it("records the migration in the history and has nothing left to apply", async () => {
    const sql = await readFile(join(migrationsFolder, `${lastTag}.sql`), "utf8");
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")
    ) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const when = journal.entries.find((entry) => entry.tag === lastTag)!.when;
    const history = await pool.query<{ hash: string; createdAt: string }>(
      'select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations where created_at = $1',
      [when]
    );
    expect(history.rows).toEqual([
      { hash: createHash("sha256").update(sql).digest("hex"), createdAt: String(when) }
    ]);
    const count = (
      await pool.query<{ count: string }>(
        "select count(*)::text as count from drizzle.__drizzle_migrations"
      )
    ).rows[0]!.count;
    await runMigrations(pool, migrationsFolder);
    expect(
      (
        await pool.query<{ count: string }>(
          "select count(*)::text as count from drizzle.__drizzle_migrations"
        )
      ).rows[0]!.count
    ).toBe(count);
  }, 120_000);

  it("gives a database built from the baseline seed the same definitions", async () => {
    await pool.query("create database baseline_built");
    baselinePool = createPgPool({
      connectionString: connectionString.replace(/\/[^/?]+(\?|$)/, "/baseline_built$1"),
      max: 2
    });
    const result = await runMigrations(baselinePool, migrationsFolder, { seedFolder });
    expect(result.seed.applied).toBe(true);
    expect(result.seed.seededMigrations).toContain(lastTag);
    expect(await definitions(baselinePool)).toEqual(await definitions(pool));
    for (const [table, column] of [
      ["chunks", "search_tsv"],
      ["atomic_notes", "ask_tsv"]
    ] as const)
      expect((await generated(baselinePool, table, column)).rows).toEqual(
        (await generated(pool, table, column)).rows
      );
  }, 120_000);
});
