import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closePgPool,
  createPgPool,
  createSourceItemRepository,
  listSourceRelations,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "../index.js";

/**
 * Real-database check of migration 0050 (source relations decided without prose): applied as a
 * pending migration on a populated database whose relations carry prose, and through the baseline
 * seed on an empty one. Verifies history, column nullability, the explanation cache table with its
 * types, defaults, check and foreign keys, the older rows' prose and evidence, and the behavior of
 * the new constraints.
 */
const root = resolve(import.meta.dirname, "../../../..");
const migrations = join(root, "packages/db/drizzle"),
  seedFolder = join(root, "packages/db/seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-source-relation-explanations-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "source_explanations",
  user: "source_explanations",
  password: randomUUID(),
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

const target = "0050_source_relation_explanations";

async function nullable(db: PgPool): Promise<Record<string, string>> {
  const rows = (
    await db.query(
      `select column_name, is_nullable from information_schema.columns
      where table_name = 'source_relations' and column_name in ('source_idea','target_idea','explanation')
      order by column_name`
    )
  ).rows;
  return Object.fromEntries(rows.map((row) => [row.column_name, row.is_nullable]));
}

async function tableExists(db: PgPool): Promise<boolean> {
  return (
    (
      await db.query(
        "select count(*)::int as n from information_schema.tables where table_name = 'source_relation_explanations'"
      )
    ).rows[0].n === 1
  );
}

/** The schema migration 0050 creates, the same whichever path applied it. */
async function verifySchema(db: PgPool, label: string) {
  assert.deepEqual(
    await nullable(db),
    { explanation: "YES", source_idea: "YES", target_idea: "YES" },
    `${label}: the prose columns accept null`
  );
  const columns = (
    await db.query(
      `select column_name, data_type, is_nullable, character_maximum_length, column_default
      from information_schema.columns where table_name = 'source_relation_explanations' order by ordinal_position`
    )
  ).rows.map((row) => [
    row.column_name,
    row.data_type,
    row.is_nullable,
    row.character_maximum_length,
    row.column_default
  ]);
  assert.deepEqual(
    columns,
    [
      ["relation_id", "uuid", "NO", null, null],
      ["text", "text", "NO", null, null],
      ["input_hash", "text", "NO", null, null],
      ["prompt_version", "text", "NO", null, null],
      ["provider", "text", "NO", null, null],
      ["model", "text", "NO", null, null],
      ["runtime", "text", "NO", null, null],
      ["ai_task_run_id", "uuid", "YES", null, null],
      ["language", "character varying", "NO", 16, null],
      ["written_at", "timestamp with time zone", "NO", null, "now()"]
    ],
    `${label}: the explanation cache has the columns of 0049's note explanations`
  );
  const constraints = (
    await db.query(
      `select c.conname, c.contype, c.confdeltype, f.relname as foreign_table, pg_get_constraintdef(c.oid) as definition
      from pg_constraint c join pg_class t on t.oid = c.conrelid left join pg_class f on f.oid = c.confrelid
      where t.relname = 'source_relation_explanations' order by c.conname`
    )
  ).rows;
  const byName = new Map(constraints.map((row) => [row.conname as string, row]));
  assert.equal(
    byName.get("source_relation_explanations_pkey")?.contype,
    "p",
    `${label}: keyed by relation`
  );
  assert.match(
    String(byName.get("source_relation_explanations_text")?.definition),
    /char_length\(text\) >= 1\) AND \(char_length\(text\) <= 4000/,
    `${label}: the text is bounded`
  );
  const relationFk = byName.get("source_relation_explanations_relation_id_source_relations_id_fk");
  assert.deepEqual(
    [relationFk?.foreign_table, relationFk?.confdeltype],
    ["source_relations", "c"],
    `${label}: an explanation is deleted with its relation`
  );
  const runFk = byName.get("source_relation_explanations_ai_task_run_id_ai_task_runs_id_fk");
  assert.deepEqual(
    [runFk?.foreign_table, runFk?.confdeltype],
    ["ai_task_runs", "n"],
    `${label}: the writer's run is forgotten, not the explanation`
  );
}

/** What the new constraints allow and refuse. */
async function verifyBehavior(db: PgPool, label: string) {
  const sources = createSourceItemRepository(db);
  const a = await sources.create({ type: "Book", title: `${label} work A` });
  const b = await sources.create({ type: "Book", title: `${label} work B` });
  const relation = (
    await db.query(
      `insert into source_relations (identity_key, source_item_id, target_source_item_id, relation_type, importance, confidence)
      values ($1, $2, $3, 'supports', 0.9, 0.85) returning id`,
      [randomUUID(), a.id, b.id]
    )
  ).rows[0].id as string;
  const explain = (text: string, relationId = relation) =>
    db.query(
      `insert into source_relation_explanations (relation_id, text, input_hash, prompt_version, provider, model, runtime, language)
      values ($1, $2, 'hash', 'source-relation-explanation-v1', 'test', 'writer', 'local', 'pt-BR')`,
      [relationId, text]
    );
  await assert.rejects(explain(""), `${label}: an empty explanation is refused`);
  await assert.rejects(explain("x".repeat(4001)), `${label}: an oversized explanation is refused`);
  await assert.rejects(
    explain("Orphan.", randomUUID()),
    `${label}: an explanation needs a relation`
  );
  await explain("Written on open.");
  assert.equal(
    (
      await db.query(
        "select written_at is not null as written from source_relation_explanations where relation_id = $1",
        [relation]
      )
    ).rows[0].written,
    true
  );
  const listed = (await listSourceRelations(db, a.id, b.id)).relations[0]!;
  assert.deepEqual(
    [listed.sourceIdea, listed.targetIdea, listed.explanation],
    [null, null, null],
    `${label}: a relation without prose lists with null prose`
  );
  await db.query("delete from source_items where id = $1", [a.id]);
  assert.equal(
    (await db.query("select count(*)::int as n from source_relation_explanations")).rows[0].n,
    0,
    `${label}: the explanation is deleted with its relation`
  );
  await db.query("delete from source_items where id = $1", [b.id]);
}

let pool: PgPool | null = null,
  emptyPool: PgPool | null = null;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 3 });
  const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
  const targetEntry = journal.entries.find((entry: { tag: string }) => entry.tag === target);
  assert.ok(targetEntry, "Migration 0050 is in the journal");
  const prior = journal.entries.filter((entry: { idx: number }) => entry.idx < targetEntry.idx);
  const oldFolder = join(workDir, "before-0050");
  await mkdir(join(oldFolder, "meta"), { recursive: true });
  await writeFile(
    join(oldFolder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: prior })
  );
  for (const entry of prior)
    await copyFile(join(migrations, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
  await runMigrations(pool, oldFolder);
  assert.deepEqual(
    await nullable(pool),
    { explanation: "NO", source_idea: "NO", target_idea: "NO" },
    "Before 0050 the prose columns are required"
  );
  assert.equal(await tableExists(pool), false);

  // A populated library: relations saved with prose and their evidence.
  const sources = createSourceItemRepository(pool);
  const works = await Promise.all(
    ["Older work A", "Older work B", "Older work C"].map((title) =>
      sources.create({ type: "Book", title })
    )
  );
  const prose: Array<{
    id: string;
    source_idea: string;
    target_idea: string;
    explanation: string;
  }> = [];
  const pairs: Array<[(typeof works)[number], (typeof works)[number]]> = [
    [works[0]!, works[1]!],
    [works[1]!, works[2]!]
  ];
  for (const [index, [from, to]] of pairs.entries()) {
    const row = (
      await pool.query(
        `insert into source_relations (identity_key, source_item_id, target_source_item_id, relation_type,
          source_idea, target_idea, explanation, importance, confidence, status)
        values ($1, $2, $3, 'supports', $4, $5, $6, 0.9, 0.85, $7) returning id, source_idea, target_idea, explanation`,
        [
          randomUUID(),
          from.id,
          to.id,
          `Idea ${index} in ${from.title}`,
          `Idea ${index} in ${to.title}`,
          `Older prose ${index}.`,
          index === 0 ? "accepted" : "pending_review"
        ]
      )
    ).rows[0];
    prose.push(row);
    await pool.query(
      `insert into source_relation_evidence (relation_id, evidence_key, origin, snapshot)
      values ($1, $2, 'source_analysis', $3)`,
      [
        row.id,
        randomUUID(),
        { sourceExcerpt: "Older source passage.", targetExcerpt: "Older target passage." }
      ]
    );
  }
  const before = (
    await pool.query(
      "select count(*)::int as relations, (select count(*)::int from source_relation_evidence) as evidence from source_relations"
    )
  ).rows[0];

  // The pending migration runs on the populated database; the baseline is never applied to it.
  const applied = await runMigrations(pool, migrations, { seedFolder });
  assert.equal(applied.seed.applied, false, "A database with history only runs pending migrations");
  const history = (await pool.query("select count(*)::int as n from drizzle.__drizzle_migrations"))
    .rows[0].n;
  assert.equal(history, journal.entries.length, "0050 is recorded in the migration history");
  await verifySchema(pool, "pending migration");
  const after = (
    await pool.query(
      "select count(*)::int as relations, (select count(*)::int from source_relation_evidence) as evidence from source_relations"
    )
  ).rows[0];
  assert.deepEqual(after, before, "No relation or evidence is lost");
  for (const row of prose)
    assert.deepEqual(
      (
        await pool.query(
          "select id, source_idea, target_idea, explanation from source_relations where id = $1",
          [row.id]
        )
      ).rows[0],
      row,
      "Older rows keep their prose"
    );
  assert.equal(
    (await pool.query("select status::text from source_relations where id = $1", [prose[0]!.id]))
      .rows[0].status,
    "accepted",
    "Older rows keep the owner's review"
  );
  await verifyBehavior(pool, "Pending");

  // An empty database receives the baseline, records every migration and has the same schema.
  await pool.query("create database source_explanations_empty");
  const url = new URL(connection.connectionString);
  url.pathname = "/source_explanations_empty";
  emptyPool = createPgPool({ connectionString: url.toString(), max: 2 });
  assert.equal((await runMigrations(emptyPool, migrations, { seedFolder })).seed.applied, true);
  assert.equal(
    (await emptyPool.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0]
      .n,
    journal.entries.length
  );
  await verifySchema(emptyPool, "baseline");
  await verifyBehavior(emptyPool, "Baseline");
  console.log(
    `Verified migration ${target} as a pending migration on a populated database ` +
      `(${before.relations} relations with prose and ${before.evidence} evidence rows kept, ` +
      `review kept, history ${history}) and through the baseline seed on an empty one: ` +
      "nullable prose columns, the explanation cache table with its columns, defaults, " +
      "length check, cascade and set-null foreign keys, and its behavior."
  );
} finally {
  if (emptyPool) await closePgPool(emptyPool);
  if (pool) await closePgPool(pool);
  await manager.stop();
  await rm(workDir, { recursive: true, force: true });
}
