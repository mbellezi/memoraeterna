import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { omniArmParameters, omniArms } from "../objectSearchArms.js";
import { contentTsvectorCalls, type PlanNode } from "../repositories/consultationPlan.js";
import { consultationCandidatesSql } from "../repositories/consultationRepository.js";
import { splitSqlStatements } from "../seed.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";

/**
 * Real-database check of migration `0067_object_search_indexes` (F5 T117, D12, D27): on a database
 * with history and a small library only the new migration runs (step by step, timed apart); the
 * immutable `f_jsonb_text_array` is accepted in a generated column and in index expressions; the
 * topic `search_tsv` equals what an independent computation of its expression gives; each new
 * index exists, is valid and says what its arm needs; the two unused indexes of `chunks` are gone
 * and `chunks` keeps its rows and definitions; EXPLAIN (sequential scans off, small tables) uses
 * each index for the exact arm expression of spec 3.4, including the entity alias index; Ask's
 * candidates statement still parses no passage or note text; and a database built from the
 * baseline seed ends with the same shape. It starts its own temporary PostgreSQL sidecar and never
 * touches an existing database.
 */
const migrationName = "0067_object_search_indexes";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const breakpointStep = /^\s*(?:--[^\n]*\n\s*)*/u;

interface Journal {
  entries: Array<{ tag: string; when: number }>;
}

const readJournal = async (folder: string): Promise<Journal> =>
  JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8")) as Journal;

/** Applies every migration before 0067 from a copy of the folder, as a profile from before it. */
async function migrateBefore(db: PgPool, workDir: string): Promise<void> {
  const folder = join(workDir, "migrations-before");
  await cp(migrationsFolder, folder, { recursive: true });
  const journal = await readJournal(folder);
  const position = journal.entries.findIndex((entry) => entry.tag === migrationName);
  assert.ok(position > 0, "the migration is in the journal");
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }, null, 2)
  );
  await runMigrations(db, folder);
}

/** A small library: accented names, aliases (one that is not an array), topics and passages. */
async function seedLibrary(db: PgPool): Promise<void> {
  const tree = randomUUID();
  const root = randomUUID();
  await db.query(
    `insert into topic_trees (id, status, space_key, embedding_provider, embedding_model,
        embedding_runtime, dimensions, config, config_hash, seed, activated_at)
     values ($1, 'active', 'k', 'p', 'm', 'r', 256, '{}', 'h', 1, now())`,
    [tree]
  );
  await db.query(
    `insert into topics (id, tree_id, role, name_state, management) values ($1, $2, 'root', 'unnamed', 'human')`,
    [root, tree]
  );
  const titles = ["Memória e sono", "Fotossíntese", "Redes neurais", "Árvore de decisão"];
  for (const [index, title] of titles.entries())
    await db.query(
      `insert into topics (tree_id, parent_id, role, title, name_state, name_source, description, aliases, position, management)
       values ($1, $2, 'topic', $3, 'named', 'human', $4, $5::jsonb, $6, 'human')`,
      [
        tree,
        root,
        title,
        `Descrição de ${title} com ação`,
        JSON.stringify([`alias ${index} água`, "Coração"]),
        index
      ]
    );
  await db.query(
    `insert into topics (tree_id, parent_id, role, name_state, position, management)
     values ($1, $2, 'topic', 'unnamed', 9, 'human')`,
    [tree, root]
  );
  const entities: [string, unknown][] = [
    ["Ação Humana", ["Ludwig von Mises", "Praxeologia"]],
    ["Café", []],
    ["Entity with object aliases", { not: "an array" }],
    ["Entity with scalar aliases", "scalar"]
  ];
  for (const [name, aliases] of entities)
    await db.query(
      `insert into entities (type, canonical_name, normalized_name, aliases, confidence)
       values ('concept', $1, lower($1), $2::jsonb, 0.9)`,
      [name, JSON.stringify(aliases)]
    );
  for (let s = 0; s < 6; s += 1) {
    const source = randomUUID();
    const document = randomUUID();
    await db.query("insert into source_items (id, type, title) values ($1, 'Book', $2)", [
      source,
      `Fonte ${s} — memória ${s}`
    ]);
    await db.query(
      "insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, 'D', 't', $3)",
      [document, source, `d-${s}`]
    );
    for (let c = 0; c < 10; c += 1)
      await db.query(
        `insert into chunks (document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, $4, $5)`,
        [document, source, c, `Passagem ${s}.${c} sobre memória, ação e água.`, `c-${s}-${c}`]
      );
  }
  await db.query(
    `insert into questions (text, privacy, mode, status)
     values ('Como a memória consolida o sono?', 'offline_only', 'text', 'complete')`
  );
}

interface Step {
  step: string;
  ms: number;
}

/** Applies the migration statement by statement in one transaction, as the migrator does. */
async function applySteps(db: PgPool): Promise<{ steps: Step[]; ms: number }> {
  const sql = await readFile(join(migrationsFolder, `${migrationName}.sql`), "utf8");
  const when = (await readJournal(migrationsFolder)).entries.find(
    (entry) => entry.tag === migrationName
  )!.when;
  const client = await db.connect();
  const steps: Step[] = [];
  const started = performance.now();
  try {
    await client.query("begin");
    for (const statement of splitSqlStatements(sql)) {
      const from = performance.now();
      await client.query(statement);
      const label = statement.replace(breakpointStep, "").slice(0, 80).replace(/\s+/gu, " ");
      steps.push({ step: label, ms: Math.round(performance.now() - from) });
    }
    await client.query(
      'insert into drizzle.__drizzle_migrations ("hash", "created_at") values ($1, $2)',
      [createHash("sha256").update(sql).digest("hex"), when]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { steps, ms: Math.round(performance.now() - started) };
}

/** A table's rows and definitions: what the drops must leave alone. */
async function chunksFingerprint(db: PgPool) {
  const rows = await db.query<{ count: string; digest: string }>(
    `select count(*)::text as count,
            coalesce(md5(string_agg(concat_ws('|', id, document_id, chunk_index, content, content_hash,
                language, metadata::text, search_tsv::text), ',' order by id)), '') as digest
       from chunks`
  );
  const definitions = await db.query<{ line: string }>(
    `select a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' ||
            a.attgenerated::text as line
       from pg_attribute a where a.attrelid = 'chunks'::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`
  );
  const constraints = await db.query<{ line: string }>(
    `select conname || ':' || pg_get_constraintdef(oid) as line from pg_constraint
      where conrelid = 'chunks'::regclass order by conname`
  );
  return {
    count: Number(rows.rows[0]!.count),
    digest: rows.rows[0]!.digest,
    columns: definitions.rows.map((row) => row.line),
    constraints: constraints.rows.map((row) => row.line)
  };
}

const newIndexes: Record<string, { table: string; definition: RegExp }> = {
  topics_search_tsv_idx: { table: "topics", definition: /USING gin \(search_tsv\)$/u },
  topics_title_trgm_idx: {
    table: "topics",
    definition: /USING gin \(f_unaccent\(title\) gin_trgm_ops\)$/u
  },
  source_items_title_trgm_idx: {
    table: "source_items",
    definition: /USING gin \(f_unaccent\(title\) gin_trgm_ops\)$/u
  },
  entities_canonical_name_trgm_idx: {
    table: "entities",
    definition: /USING gin \(f_unaccent\(canonical_name\) gin_trgm_ops\)$/u
  },
  entities_aliases_trgm_idx: {
    table: "entities",
    definition: /USING gin \(f_unaccent\(f_jsonb_text_array\(aliases\)\) gin_trgm_ops\)$/u
  },
  chunks_search_tsv_idx: { table: "chunks", definition: /USING gin \(search_tsv\)$/u }
};

/** The shape a database ends with: the function, the column, and every index of the five tables. */
async function shape(db: PgPool) {
  const lines = async (sql: string) =>
    (await db.query<{ line: string }>(sql)).rows.map((row) => row.line);
  return {
    function: await lines(
      `select p.proname || ':' || p.provolatile::text || ':' || p.proparallel::text || ':' || p.proisstrict::text || ':' ||
              pg_get_function_result(p.oid) || ':' || pg_get_function_arguments(p.oid) as line
         from pg_proc p where p.proname = 'f_jsonb_text_array'`
    ),
    column: await lines(
      `select a.attname || ':' || a.attgenerated::text || ':' || pg_get_expr(d.adbin, d.adrelid) as line
         from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = 'topics'::regclass and a.attname = 'search_tsv'`
    ),
    indexes: await lines(
      `select indexdef as line from pg_indexes
        where tablename in ('topics', 'source_items', 'entities', 'chunks') order by indexname`
    )
  };
}

/** The plan of a statement with sequential scans off, so a usable index is the cheapest path. */
async function plan(db: PgPool, sql: string, values: unknown[]): Promise<string> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local enable_seqscan = off");
    const rows = await client.query<{ "QUERY PLAN": string }>(`explain ${sql}`, values);
    await client.query("rollback");
    return rows.rows.map((row) => row["QUERY PLAN"]).join("\n");
  } finally {
    client.release();
  }
}

const workDir = await mkdtemp(join(tmpdir(), "memora-search-indexes-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_search_indexes",
  user: "memora_search_indexes",
  password: `search-indexes-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
const report: Record<string, unknown> = {};
const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const admin = createPgPool({ connectionString: connection.connectionString, max: 2 });
  pools.push(admin);
  const journal = await readJournal(migrationsFolder);
  const databaseUrl = (name: string) => {
    const url = new URL(connection.connectionString);
    url.pathname = `/${name}`;
    return url.toString();
  };

  // 1. A database with history and a library: the new objects are absent, the old indexes present.
  await admin.query("create database memora_search_indexes_history");
  const db = createPgPool({
    connectionString: databaseUrl("memora_search_indexes_history"),
    max: 4
  });
  pools.push(db);
  await migrateBefore(db, workDir);
  await seedLibrary(db);
  const absent = await db.query(
    `select (select count(*) from pg_proc where proname = 'f_jsonb_text_array')::int as functions,
            (select count(*) from pg_indexes where indexname = any($1::text[]))::int as indexes,
            (select count(*) from pg_attribute where attrelid = 'topics'::regclass and attname = 'search_tsv')::int as columns,
            (select count(*) from pg_indexes where indexname in ('chunks_content_trgm_idx', 'chunks_content_fts_idx'))::int as old`,
    [Object.keys(newIndexes)]
  );
  assert.deepEqual(absent.rows[0], { functions: 0, indexes: 0, columns: 0, old: 2 }, "before 0067");
  const chunksBefore = await chunksFingerprint(db);
  assert.ok(chunksBefore.count > 0, "the fixture holds passages");

  // 2. Only 0067 runs, step by step; the history records it.
  const applied = await applySteps(db);
  const history = await db.query("select count(*)::int as count from drizzle.__drizzle_migrations");
  assert.equal(Number(history.rows[0]?.count), journal.entries.length, "history records 0067");
  await runMigrations(db, migrationsFolder);
  const again = await db.query("select count(*)::int as count from drizzle.__drizzle_migrations");
  assert.equal(Number(again.rows[0]?.count), journal.entries.length, "nothing left to apply");

  // 3. The function, and the generated column and indexes that use it.
  const after = await shape(db);
  assert.deepEqual(
    after.function,
    ["f_jsonb_text_array:i:s:true:text:value jsonb"],
    "immutable, parallel safe, strict, text from jsonb"
  );
  assert.equal(after.column.length, 1, "topics.search_tsv exists");
  assert.match(after.column[0]!, /^search_tsv:s:/u, "stored generated");
  for (const piece of [
    "setweight(to_tsvector('simple'::regconfig, f_unaccent(COALESCE(title, ''::text))), 'A'::\"char\")",
    "f_unaccent(COALESCE(f_jsonb_text_array(aliases), ''::text))), 'B'::\"char\")",
    "f_unaccent(COALESCE(description, ''::text))), 'C'::\"char\")"
  ])
    assert.ok(after.column[0]!.includes(piece), `the column has ${piece}`);
  const f = async (value: string) =>
    (await db.query<{ text: string }>(`select f_jsonb_text_array($1::jsonb) as text`, [value]))
      .rows[0]!.text;
  assert.equal(await f('["a", "b c", "ç"]'), "a b c ç");
  assert.equal(await f("[]"), "");
  assert.equal(await f('{"x": 1}'), "", "an object reads as empty, never raises");
  assert.equal(await f('"scalar"'), "", "a scalar reads as empty, never raises");
  assert.equal(
    (await db.query("select f_jsonb_text_array(null) is null as isnull")).rows[0]?.isnull,
    true,
    "STRICT: null in, null out"
  );

  // 4. Every topic's stored document equals an independent computation of the expression.
  const topics = await db.query<{ total: number; mismatches: number; named: number }>(
    `select count(*)::int as total,
            count(*) filter (where search_tsv is distinct from
              (setweight(to_tsvector('simple', unaccent(coalesce(title, ''))), 'A') ||
               setweight(to_tsvector('simple', unaccent(coalesce((select string_agg(e, ' ') from jsonb_array_elements_text(aliases) e), ''))), 'B') ||
               setweight(to_tsvector('simple', unaccent(coalesce(description, ''))), 'C')))::int as mismatches,
            count(*) filter (where search_tsv @@ to_tsquery('simple', 'memoria & sono'))::int as named
       from topics`
  );
  assert.equal(topics.rows[0]?.mismatches, 0, "topics.search_tsv equals its per-row document");
  assert.equal(topics.rows[0]?.named, 1, "an accented title is found unaccented");
  const aliasHit = await db.query<{ count: number }>(
    "select count(*)::int as count from topics where search_tsv @@ to_tsquery('simple', 'agua:*')"
  );
  assert.ok(aliasHit.rows[0]!.count >= 4, "aliases (weight B) and descriptions are searchable");
  const unnamed = await db.query<{ tsv: string }>(
    "select search_tsv::text as tsv from topics where title is null and role = 'topic'"
  );
  assert.equal(unnamed.rows[0]?.tsv, "", "an unnamed topic has an empty document");
  report.topics = topics.rows[0]!.total;

  // 5. Each new index exists, is valid and says what its arm needs; the two old ones are gone.
  const indexes = await db.query<{ name: string; table: string; valid: boolean; def: string }>(
    `select c.relname as name, t.relname as "table", i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as def
       from pg_index i join pg_class c on c.oid = i.indexrelid join pg_class t on t.oid = i.indrelid
      where c.relname = any($1::text[])`,
    [Object.keys(newIndexes)]
  );
  assert.deepEqual(
    indexes.rows.map((row) => row.name).sort(),
    Object.keys(newIndexes).sort(),
    "every new index exists"
  );
  for (const row of indexes.rows) {
    const expected = newIndexes[row.name]!;
    assert.equal(row.table, expected.table, `${row.name} is on ${expected.table}`);
    assert.equal(row.valid, true, `${row.name} is valid`);
    assert.match(row.def, expected.definition, `${row.name}: ${row.def}`);
  }
  const old = await db.query(
    "select 1 from pg_indexes where indexname in ('chunks_content_trgm_idx', 'chunks_content_fts_idx')"
  );
  assert.equal(old.rowCount, 0, "the two unused chunk indexes are dropped");
  const invalid = await db.query(
    `select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid where not i.indisvalid`
  );
  assert.equal(invalid.rowCount, 0, "no index of the database is invalid");

  // 6. chunks keeps its rows and definitions: only its two indexes changed.
  assert.deepEqual(await chunksFingerprint(db), chunksBefore, "chunks rows and definitions");
  report.chunks = { rows: chunksBefore.count, indexesDropped: 2, indexAdded: 1 };

  // 7. EXPLAIN uses each index for the exact arm expression of omni's statements.
  const plans: Record<string, string> = {};
  for (const arm of omniArms) {
    const text = await plan(db, arm.sql, [...omniArmParameters]);
    assert.ok(
      text.includes(`Bitmap Index Scan on ${arm.index}`),
      `${arm.arm} on ${arm.table} uses ${arm.index}:\n${text}`
    );
    assert.ok(
      !new RegExp(`Seq Scan on ${arm.table}\\b`, "u").test(text),
      `${arm.arm} on ${arm.table} has no Seq Scan:\n${text}`
    );
    plans[`${arm.arm}:${arm.table}`] = arm.index;
  }
  report.arms = plans;
  const aliasRows = await db.query<{ id: string }>(
    omniArms.find((a) => a.arm === "alias_trgm")!.sql,
    ["praxeologia", "praxeologia:*"]
  );
  assert.equal(aliasRows.rowCount, 1, "the alias arm finds an entity by an alias, unaccented");
  const quickOnly = omniArms.filter((arm) => arm.quick).map((arm) => arm.table);
  assert.ok(!quickOnly.includes("chunks"), "the chunk arm is full mode only");

  // 8. Ask's candidates statement still reads the stored vectors and parses no passage text.
  const sources = (
    await db.query<{ id: string }>("select id from source_items order by id limit 50")
  ).rows.map((row) => row.id);
  const askPlan = (
    await db.query(`explain (verbose, format json) ${consultationCandidatesSql}`, [
      sources,
      "memória e sono",
      false,
      [],
      null
    ])
  ).rows[0]!["QUERY PLAN"] as { Plan: PlanNode }[];
  assert.deepEqual(
    contentTsvectorCalls(askPlan[0]!.Plan),
    [],
    "Ask's candidates statement has no content to_tsvector( in its plan"
  );
  report.askCandidates = "no content to_tsvector( in the plan";

  // 9. An empty database: the baseline seed carries 0067 with the same shape.
  await admin.query("create database memora_search_indexes_empty");
  const seeded = createPgPool({
    connectionString: databaseUrl("memora_search_indexes_empty"),
    max: 2
  });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(seed.seed.applied && seed.seed.seededMigrations.includes(migrationName), "baseline");
  assert.deepEqual(await shape(seeded), after, "baseline and pending shapes are identical");
  const oldOnSeeded = await seeded.query(
    "select 1 from pg_indexes where indexname in ('chunks_content_trgm_idx', 'chunks_content_fts_idx')"
  );
  assert.equal(oldOnSeeded.rowCount, 0, "the baseline leaves no unused chunk index");

  console.log(
    JSON.stringify(
      {
        ok: true,
        migration: migrationName,
        migrationMs: applied.ms,
        steps: applied.steps,
        ...report
      },
      null,
      2
    )
  );
} finally {
  for (const pool of pools) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
