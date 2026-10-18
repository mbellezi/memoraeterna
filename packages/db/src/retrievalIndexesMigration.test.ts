import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "./client.js";
import { runMigrations } from "./migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "./sidecar/index.js";

// Migration 0058 (relation_retrieval_indexes, F3 T49) on a database that already holds a library:
// the notes survive the rewrite their new generated column needs, `search_tsv` equals what its
// expression computes, the five indexes are valid and say what the retrieval queries need, only
// note vectors are in the partial HNSW indexes, the history records the migration, and a database
// built from the baseline seed ends with the same definitions.
const workspace = resolve(import.meta.dirname, "../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const seedFolder = join(workspace, "packages/db/seed");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const lastTag = "0058_relation_retrieval_indexes";

const indexNames = [
  "atomic_notes_search_tsv_idx",
  "atomic_notes_title_trgm_idx",
  "embeddings_256_note_hnsw_idx",
  "embeddings_768_note_hnsw_idx",
  "embeddings_1024_note_hnsw_idx"
];

describe.skipIf(!sidecarInstalled)("migration 0058 on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let baselinePool: PgPool;
  let connectionString = "";
  const noteCount = 120;

  const vector = (dimensions: number, seed: number): string =>
    `[${Array.from({ length: dimensions }, (_, axis) => Math.sin(seed * 7 + axis)).join(",")}]`;
  const fingerprint = async (): Promise<Record<string, string>> => {
    const rows = await pool.query<Record<string, string>>(
      `select (select md5(string_agg(concat_ws('|', id, title, body_markdown, idea_statement, status,
                  supersession_status, language, metadata::text), ',' order by id)) from atomic_notes) as notes,
              (select count(*) from atomic_notes)::text as "noteCount",
              (select count(*) from embeddings_256)::text as e256,
              (select count(*) from embeddings_768)::text as e768,
              (select count(*) from embeddings_1024)::text as e1024,
              (select md5(string_agg(concat_ws('|', id, target_id, model, embedding::text), ',' order by id))
                 from embeddings_256) as vectors`
    );
    return rows.rows[0]!;
  };
  const indexDefinitions = async (db: PgPool): Promise<Record<string, string>> =>
    Object.fromEntries(
      (
        await db.query<{ indexname: string; indexdef: string }>(
          "select indexname, indexdef from pg_indexes where indexname = any($1::text[]) order by indexname",
          [indexNames]
        )
      ).rows.map((row) => [row.indexname, row.indexdef])
    );

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-retrieval-indexes-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_retrieval_indexes_test",
        user: "memora_retrieval_indexes_test",
        password: `retrieval-indexes-${randomUUID()}`,
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

    // The migrations without 0058: the state of a library before it.
    const before = join(workDir, "before");
    await cp(migrationsFolder, before, {
      recursive: true,
      filter: (path) => !path.includes("0058_") && !path.includes("/meta/0058")
    });
    const journal = JSON.parse(await readFile(join(before, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    // The history ends right before 0058: a later migration applied first would put its time past
    // 0058's, and drizzle applies only what is newer than the last one applied.
    journal.entries = journal.entries.slice(
      0,
      journal.entries.findIndex((entry) => entry.tag === lastTag)
    );
    await writeFile(join(before, "meta/_journal.json"), JSON.stringify(journal));
    await runMigrations(pool, before);

    // A library: a source with a chunk, notes with accents, empty ideas and a very long body,
    // and vectors of notes and of chunks in all three dimensions.
    const source = randomUUID();
    const document = randomUUID();
    const chunk = randomUUID();
    await pool.query("insert into source_items (id, type, title) values ($1, 'Book', 'Book')", [
      source
    ]);
    await pool.query(
      "insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, 'D', 't', 'h')",
      [document, source]
    );
    await pool.query(
      "insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash) values ($1, $2, $3, 0, 't', 'c')",
      [chunk, document, source]
    );
    for (let index = 1; index <= noteCount; index += 1) {
      const id = randomUUID();
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
          id,
          index % 11 === 0 ? "" : `Título ${index} — ÁÉÍ`,
          body,
          index % 13 === 0 ? "" : `Ideia ${index}: a memória consolida o sono`,
          source,
          chunk,
          index % 17 === 0 ? "archived" : "active",
          index % 17 === 0 ? "superseded" : "current"
        ]
      );
      for (const dimensions of [256, 768, 1024])
        if (index % 3 === 0 || dimensions === 256)
          await pool.query(
            `insert into embeddings_${dimensions} (target_type, target_id, provider, model, runtime, strategy, content_hash, embedding)
             values ('atomic_note', $1, 'p', $2, 'r', 'native-v2:s', 'h', $3::vector)`,
            [id, `m${dimensions}`, vector(dimensions, index)]
          );
    }
    await pool.query(
      `insert into embeddings_256 (target_type, target_id, chunk_id, provider, model, runtime, strategy, content_hash, embedding)
       values ('chunk', $1, $1, 'p', 'm256', 'r', 'native-v2:s', 'h', $2::vector)`,
      [chunk, vector(256, 999)]
    );
    await pool.query(
      `insert into embeddings_256 (target_type, target_id, provider, model, runtime, strategy, content_hash, embedding)
       values ('source_item', $1, 'p', 'm256', 'r', 'native-v2:s', 'h', $2::vector)`,
      [source, vector(256, 998)]
    );
  }, 180_000);

  afterAll(async () => {
    if (baselinePool) await closePgPool(baselinePool).catch(() => undefined);
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("applies as a pending migration and keeps every note and vector", async () => {
    const column = await pool.query(
      "select 1 from information_schema.columns where table_name = 'atomic_notes' and column_name = 'search_tsv'"
    );
    expect(column.rowCount).toBe(0);
    const beforeState = await fingerprint();
    expect(Number(beforeState.noteCount)).toBe(noteCount);

    await runMigrations(pool, migrationsFolder);
    const afterState = await fingerprint();
    expect(afterState).toEqual(beforeState);
  });

  it("adds search_tsv as a stored generated tsvector equal to its expression", async () => {
    const column = await pool.query<{ type: string; generated: string }>(
      `select format_type(a.atttypid, a.atttypmod) as type, a.attgenerated as generated
         from pg_attribute a where a.attrelid = 'atomic_notes'::regclass and a.attname = 'search_tsv'`
    );
    expect(column.rows[0]).toEqual({ type: "tsvector", generated: "s" });
    const mismatches = await pool.query<{ count: string }>(
      `select count(*)::text as count from atomic_notes
        where search_tsv is distinct from (
          setweight(to_tsvector('simple', f_unaccent(coalesce(title, ''))), 'A') ||
          setweight(to_tsvector('simple', f_unaccent(coalesce(idea_statement, ''))), 'A') ||
          setweight(to_tsvector('simple', f_unaccent(left(coalesce(body_markdown, ''), 4000))), 'B'))`
    );
    expect(mismatches.rows[0]!.count).toBe("0");
    const nulls = await pool.query<{ count: string }>(
      "select count(*)::text as count from atomic_notes where search_tsv is null"
    );
    expect(nulls.rows[0]!.count).toBe("0");
    // Accents are folded and a long body stops at 4,000 characters (a word 8 characters wide, 500 times).
    const folded = await pool.query<{ ok: boolean }>(
      "select search_tsv @@ to_tsquery('simple', 'memoria & coracao') as ok from atomic_notes where title like 'Título 1 %' and body_markdown <> '' limit 1"
    );
    expect(folded.rows[0]?.ok).toBe(true);
    const long = await pool.query<{ ok: boolean }>(
      "select not (search_tsv @@ to_tsquery('simple', 'fim')) as ok from atomic_notes where body_markdown like 'palavra%' limit 1"
    );
    expect(long.rows[0]?.ok).toBe(true);
  });

  it("creates five valid indexes that say what the retrieval queries need", async () => {
    const valid = await pool.query<{ name: string; valid: boolean }>(
      `select c.relname as name, i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relname = any($1::text[])`,
      [indexNames]
    );
    expect(valid.rowCount).toBe(5);
    expect(valid.rows.every((row) => row.valid)).toBe(true);
    const definitions = await indexDefinitions(pool);
    expect(definitions.atomic_notes_search_tsv_idx).toContain("USING gin (search_tsv)");
    expect(definitions.atomic_notes_title_trgm_idx).toContain(
      "USING gin (f_unaccent(title) gin_trgm_ops)"
    );
    for (const dimensions of [256, 768, 1024])
      expect(definitions[`embeddings_${dimensions}_note_hnsw_idx`]).toMatch(
        /USING hnsw \(embedding vector_cosine_ops\) WHERE \(target_type = 'atomic_note'/
      );
  });

  it("keeps vectors of other targets out of the partial HNSW indexes", async () => {
    await pool.query("analyze embeddings_256");
    const sizes = await pool.query<{ indexed: string; notes: string; all: string }>(
      `select (select reltuples::bigint from pg_class where relname = 'embeddings_256_note_hnsw_idx')::text as indexed,
              (select count(*) from embeddings_256 where target_type = 'atomic_note')::text as notes,
              (select count(*) from embeddings_256)::text as all`
    );
    const { indexed, notes, all } = sizes.rows[0]!;
    expect(indexed).toBe(notes);
    expect(Number(all)).toBeGreaterThan(Number(notes));
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
  });

  it("gives a database built from the baseline seed the same definitions", async () => {
    await pool.query("create database baseline_built");
    baselinePool = createPgPool({
      connectionString: connectionString.replace(/\/[^/?]+(\?|$)/, "/baseline_built$1"),
      max: 2
    });
    const result = await runMigrations(baselinePool, migrationsFolder, { seedFolder });
    expect(result.seed.applied).toBe(true);
    expect(result.seed.seededMigrations).toContain(lastTag);
    expect(await indexDefinitions(baselinePool)).toEqual(await indexDefinitions(pool));
    const generated = (db: PgPool) =>
      db.query<{ expression: string }>(
        `select pg_get_expr(d.adbin, d.adrelid) as expression
           from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
          where d.adrelid = 'atomic_notes'::regclass and a.attname = 'search_tsv'`
      );
    expect((await generated(baselinePool)).rows).toEqual((await generated(pool)).rows);
  });
});
