import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createJobRepository,
  createLibraryResetRepository,
  createPgPool,
  createRelationDecisionRepository,
  PostgresSidecarManager,
  type PgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

/**
 * Real-database check of migration `0063_legacy_drop` (F4 D35, T78). On a database with history (every
 * earlier migration applied, a row in each of the 30 legacy tables and in the kept tables around
 * them) only the new migration runs: the 30 tables, their indexes, the fence function and its seven
 * triggers are gone, no relation of a legacy name is left, and nothing else changed (the row counts
 * of every kept table, their constraints, indexes, triggers, functions and views are equal, apart
 * from `relation_decisions_types` and the index of `atomic_note_evolution.run_id`). The pair-level
 * `relation_decisions.accepted` and `.relation_type` and the orphan `atomic_note_evolution.run_id`
 * are gone with their rows kept. An empty database seeded from the baseline ends with the same
 * shape. The statements the guards used to carry (job pruning, dismissing finished jobs), the
 * decision writer and the library reset run against the migrated schema. It starts its own temporary
 * PostgreSQL sidecar and never connects to an existing database.
 */
const migrationName = "0063_legacy_drop";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-legacy-drop-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_legacy_drop",
  user: "memora_legacy_drop",
  password: `legacy-drop-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

/** The 30 tables of D35 (`legacyWipeTables` of F2/F3). */
const legacyTables = [
  "automatic_routine_bindings",
  "automatic_routine_calls",
  "knowledge_impact_deliveries",
  "knowledge_impact_events",
  "maintenance_budget_reservations",
  "maintenance_decisions",
  "maintenance_occurrences",
  "maintenance_receipts",
  "maintenance_runs",
  "maintenance_schedules",
  "maintenance_steps",
  "organization_proposals",
  "organization_receipts",
  "organization_runs",
  "organization_settings_activations",
  "organization_settings_revisions",
  "organization_steps",
  "wiki_dependencies",
  "wiki_evidence",
  "wiki_group_receipts",
  "wiki_investigation_evaluations",
  "wiki_investigations",
  "wiki_memberships",
  "wiki_page_revisions",
  "wiki_pages",
  "wiki_policy_activations",
  "wiki_policy_revisions",
  "wiki_section_assessments",
  "wiki_source_coverage",
  "wiki_toc_groups"
] as const;
const legacyPrefix = "^(wiki_|organization_|maintenance_|automatic_routine_|knowledge_impact_)";
/** The seven tables the fence trigger guarded (0052). */
const fencedTables = [
  "maintenance_runs",
  "maintenance_schedules",
  "organization_runs",
  "organization_settings_revisions",
  "wiki_investigations",
  "wiki_pages",
  "wiki_policy_revisions"
];
/** The only definitions of kept tables that change. */
const changedConstraint = "relation_decisions_types";
const changedIndex = "atomic_note_evolution_run_idx";
const legacySettings = [
  "knowledge.automation.policy.v1",
  "knowledge.wiki-areas.v1",
  "organization.active",
  "legacy.wipe.v1"
];

interface Journal {
  entries: Array<{ tag: string }>;
}

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Applies the migrations before 0063 (`through: false`), or through it (`through: true`), from a
 * copy of the folder. A later migration (0064 and on) is applied by the plain folder afterwards.
 */
async function migrateTo(db: PgPool, journal: Journal, through: boolean): Promise<number> {
  const folder = join(workDir, through ? "migrations-through" : "migrations-before");
  await cp(migrationsFolder, folder, { recursive: true });
  const position = journal.entries.findIndex((entry) => entry.tag === migrationName);
  assert.ok(position > 0, "the migration is in the journal");
  const count = position + (through ? 1 : 0);
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }, null, 2)
  );
  await runMigrations(db, folder);
  return count;
}

/** A row in each of the kept tables a legacy table pointed at, and in each of the 30 legacy tables. */
async function seedHistory(db: PgPool): Promise<{ keptTablesWithRows: number }> {
  const q = (text: string, values: unknown[] = []) => db.query(text, values);
  await q(`insert into source_items (id, type, title) values ($1, 'Book', 'Legacy drop source')`, [
    uid(1)
  ]);
  await q(
    `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
     values ($1, $2, 'Document', 'text', 'doc-hash')`,
    [uid(2), uid(1)]
  );
  await q(
    `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
     values ($1, $2, $3, 0, 'text', 'chunk-hash')`,
    [uid(3), uid(2), uid(1)]
  );
  for (const n of [11, 12])
    await q(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, 'Note', 'Body', 'Idea', $2, $3, 'p', 'm', 'local', 'v', $4)`,
      [uid(n), uid(1), uid(3), `key-${n}`]
    );
  // Jobs of the legacy kinds stay: the migration drops tables, not rows of the shared job queue.
  const organizationJob = (
    await q(
      `insert into jobs (type, status, payload) values ('organization', 'succeeded', '{}') returning id`
    )
  ).rows[0]!.id as string;
  const maintenanceJob = (
    await q(
      `insert into jobs (type, status, payload) values ('maintenance', 'queued', '{}') returning id`
    )
  ).rows[0]!.id as string;
  await q(`insert into jobs (type, status, payload) values ('ingestion', 'succeeded', '{}')`);
  const taskRun = (
    await q(
      `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, finished_at)
       values ('summarization', 'p', 'm', 'remote', 1000, 'succeeded', now()) returning id`
    )
  ).rows[0]!.id as string;

  // Kept tables that held the removed columns: the pair-level outcome of the pre-F3 matcher and
  // the evolution row tied to a legacy run.
  await q(
    `insert into relation_decisions (pair_key, lo_atomic_note_id, hi_atomic_note_id, lo_content_hash,
       hi_content_hash, decider_key, lo_to_hi_score, lo_to_hi_relation_type, lo_to_hi_decided_at,
       relation_type, accepted, score_scale)
     values ($1, $2, $3, 'h1', 'h2', 'decider', 0.9, 'supports', now(), 'supports', true, 'probability'),
            ($1, $2, $3, 'h1', 'h2', 'ranker', 4.5, null, now(), null, false, 'log_odds')`,
    [`${uid(11)}:${uid(12)}`, uid(11), uid(12)]
  );

  // The legacy tables, one row each; the fence admits them only to a session that says so.
  const client = await db.connect();
  try {
    await client.query("set memora.legacy_fixture = 'on'");
    const c = (text: string, values: unknown[] = []) => client.query(text, values);
    await c(`insert into wiki_pages (id, title, kind) values ($1, 'Page', 'topic')`, [uid(21)]);
    await c(
      `insert into wiki_page_revisions (id, page_id, number, origin, content, content_hash)
       values ($1, $2, 1, 'test', '{}'::jsonb, 'hash')`,
      [uid(22), uid(21)]
    );
    await c(
      `insert into wiki_evidence (page_id, source_item_id, document_id, chunk_id, snapshot)
       values ($1, $2, $3, $4, '{}'::jsonb)`,
      [uid(21), uid(1), uid(2), uid(3)]
    );
    await c(
      `insert into organization_settings_revisions (id, configuration, hash) values ($1, '{}'::jsonb, 'h')`,
      [uid(23)]
    );
    await c(`insert into organization_settings_activations (revision_id) values ($1)`, [uid(23)]);
    await c(
      `insert into organization_runs (id, job_id, status, snapshot, checkpoint)
       values ($1, $2, 'applied', '{}'::jsonb, '{}'::jsonb)`,
      [uid(24), organizationJob]
    );
    await c(
      `insert into organization_steps (run_id, sequence, ai_task_run_id, artifact)
       values ($1, 1, $2, '{}'::jsonb)`,
      [uid(24), taskRun]
    );
    await c(`insert into organization_proposals (run_id, proposal) values ($1, '{}'::jsonb)`, [
      uid(24)
    ]);
    await c(`insert into organization_receipts (run_id, revision_id) values ($1, $2)`, [
      uid(24),
      uid(22)
    ]);
    await c(
      `insert into wiki_dependencies (revision_id, section_id, kind, input_id, fingerprint, snapshot)
       values ($1, $2, 'atomic_note', $3, 'f', '{}'::jsonb)`,
      [uid(22), uid(25), uid(11)]
    );
    await c(
      `insert into knowledge_impact_events (id, kind, input_id, operation, fingerprint)
       values ($1, 'atomic_note', $2, 'update', 'f')`,
      [uid(26), uid(11)]
    );
    await c(
      `insert into maintenance_schedules (id, policy, next_at) values ($1, '{}'::jsonb, now())`,
      [uid(27)]
    );
    await c(
      `insert into maintenance_runs (id, job_id, scope_key, period, schedule_ids, status, snapshot,
         checkpoint, reservation)
       values ($1, $2, 'scope', 'p1', '[]'::jsonb, 'queued', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
      [uid(28), maintenanceJob]
    );
    await c(
      `insert into maintenance_occurrences (schedule_id, occurrence_key, due_from, due_until, run_id)
       values ($1, 'k', now(), now(), $2)`,
      [uid(27), uid(28)]
    );
    await c(
      `insert into maintenance_steps (run_id, sequence, ai_task_run_id, artifact)
       values ($1, 1, $2, '{}'::jsonb)`,
      [uid(28), taskRun]
    );
    await c(`insert into maintenance_receipts (run_id, page_id, revision_id) values ($1, $2, $3)`, [
      uid(28),
      uid(21),
      uid(22)
    ]);
    await c(
      `insert into maintenance_decisions (key, page_id, run_id, outcome) values ('k', $1, $2, 'kept')`,
      [uid(21), uid(28)]
    );
    await c(
      `insert into maintenance_budget_reservations (run_id, scope_key, period, reservation)
       values ($1, 'scope', 'p1', '{}'::jsonb)`,
      [uid(28)]
    );
    await c(
      `insert into wiki_policy_revisions (id, policy_id, policy, preview, preview_hash)
       values ($1, $2, '{}'::jsonb, '{}'::jsonb, 'h')`,
      [uid(29), uid(30)]
    );
    await c(
      `insert into wiki_policy_activations (policy_id, revision_id, state) values ($1, $2, 'active')`,
      [uid(30), uid(29)]
    );
    await c(
      `insert into wiki_toc_groups (id, page_id, revision_id, snapshot) values ($1, $2, $3, '{}'::jsonb)`,
      [uid(31), uid(21), uid(22)]
    );
    await c(
      `insert into wiki_memberships (id, page_id, group_id, target_kind, target_id, position, snapshot)
       values ($1, $2, $3, 'atomic_note', $4, 0, '{}'::jsonb)`,
      [uid(32), uid(21), uid(31), uid(11)]
    );
    await c(
      `insert into wiki_section_assessments (section_revision_id, section_id, page_id, assessment)
       values ($1, $2, $3, '{}'::jsonb)`,
      [uid(33), uid(25), uid(21)]
    );
    await c(
      `insert into wiki_group_receipts (run_id, group_id, input_fingerprint, targets)
       values ($1, $2, 'f', '[]'::jsonb)`,
      [uid(24), uid(31)]
    );
    await c(
      `insert into knowledge_impact_deliveries (event_id, consumer, consumer_key, input_generation)
       values ($1, 'consumer', 'key', 'generation')`,
      [uid(26)]
    );
    await c(
      `insert into wiki_source_coverage (policy_id, source_id, input_fingerprint, status, checkpoint, run_id)
       values ($1, $2, 'f', 'covered', '{}'::jsonb, $3)`,
      [uid(30), uid(1), uid(24)]
    );
    await c(
      `insert into automatic_routine_bindings (policy_id, kind, scope_key, preset_version, schedule_id)
       values ($1, 'kind', 'scope', 'v1', $2)`,
      [uid(30), uid(27)]
    );
    await c(
      `insert into automatic_routine_calls (organization_run_id, sequence, run_id, policy_id, period, tokens)
       values ($1, 1, $2, $3, 'p1', 10)`,
      [uid(24), uid(28), uid(30)]
    );
    await c(
      `insert into wiki_investigations (id, request_id, identity, question, answer_page_id, policy_id,
         policy_revision_id, state, input, "current", gaps)
       values ($1, $2, 'identity', 'question', $3, $4, $5, 'followed', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
      [uid(34), uid(35), uid(21), uid(30), uid(29)]
    );
    await c(
      `insert into wiki_investigation_evaluations (id, investigation_id, input_fingerprint,
         composition_hash, status, snapshot)
       values ($1, $2, 'f', 'c', 'done', '{}'::jsonb)`,
      [uid(36), uid(34)]
    );
    await c(
      `insert into atomic_note_evolution (previous_id, next_id, run_id, kind, reason)
       values ($1, $2, $3, 'merge', 'kept history')`,
      [uid(11), uid(12), uid(24)]
    );
  } finally {
    await client.query("reset memora.legacy_fixture").catch(() => undefined);
    client.release();
  }
  // Settings only the removed wipe read, and the vault rows of a legacy wiki page: both stay.
  for (const key of [...legacySettings, "app.keep"])
    await q(`insert into settings (key, value) values ($1, '{"v":1}'::jsonb)`, [key]);
  await q(
    `insert into obsidian_sync_files (memora_id, entity_type, entity_id, memora_type, relative_path,
       frontmatter_hash, content_hash, mtime_ms, status)
     values ($1, 'wiki_page', $1, 'wiki_page', 'Memora/Wiki/page.md', 'f', 'c', 0, 'synced')`,
    [uid(21)]
  );
  const counts = await tableCounts(db);
  for (const table of legacyTables) assert.equal(counts[table], 1, `${table} holds its row`);
  return {
    keptTablesWithRows: Object.entries(counts).filter(
      ([table, n]) => n > 0 && !(legacyTables as readonly string[]).includes(table)
    ).length
  };
}

async function tableNames(db: PgPool): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    `select relname as name from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`
  );
  return result.rows.map((row) => row.name);
}

async function tableCounts(db: PgPool): Promise<Record<string, number>> {
  const names = await tableNames(db);
  const result = await db.query<Record<string, number>>(
    `select ${names.map((name) => `(select count(*) from "${name}")::int as "${name}"`).join(", ")}`
  );
  return result.rows[0]!;
}

interface Shape {
  tables: string[];
  columns: string[];
  constraints: string[];
  indexes: string[];
  triggers: string[];
  functions: string[];
  views: string[];
  enums: string[];
}

/** Everything the migration could touch, as sorted strings; column order is not part of the shape. */
async function shape(db: PgPool): Promise<Shape> {
  const lines = async (text: string) =>
    (await db.query<{ line: string }>(text)).rows.map((row) => row.line);
  return {
    tables: await tableNames(db),
    columns: await lines(
      `select table_name || '.' || column_name || ' ' || udt_name || ' ' || is_nullable || ' '
              || coalesce(column_default, '') as line
         from information_schema.columns where table_schema = 'public' order by 1`
    ),
    constraints: await lines(
      `select conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) as line
         from pg_constraint where connamespace = 'public'::regnamespace order by 1`
    ),
    indexes: await lines(
      `select indexname || ' ' || indexdef as line from pg_indexes where schemaname = 'public' order by 1`
    ),
    triggers: await lines(
      `select tgrelid::regclass::text || ' ' || tgname || ' ' || pg_get_triggerdef(oid) as line
         from pg_trigger where not tgisinternal order by 1`
    ),
    functions: await lines(
      `select proname as line from pg_proc where pronamespace = 'public'::regnamespace order by 1`
    ),
    views: await lines(
      `select viewname || ' ' || definition as line from pg_views where schemaname = 'public' order by 1`
    ),
    enums: await lines(
      `select t.typname || ' ' || string_agg(e.enumlabel, ',' order by e.enumsortorder) as line
         from pg_type t join pg_enum e on e.enumtypid = t.oid group by t.typname order by 1`
    )
  };
}

/** Compares two sorted lists and, when they differ, says which lines only one of them holds. */
function assertSameLines(actual: string[], expected: string[], message: string): void {
  const extra = actual.filter((line) => !expected.includes(line));
  const missing = expected.filter((line) => !actual.includes(line));
  assert.ok(
    extra.length === 0 && missing.length === 0,
    `${message}\n  only after: ${JSON.stringify(extra)}\n  only before: ${JSON.stringify(missing)}`
  );
}

const ofLegacyTable = (line: string) =>
  legacyTables.some((table) => line.startsWith(`${table}.`) || line.startsWith(`${table} `));

/** What the migration removes from a shape, so the rest can be compared with what is left. */
function withoutLegacy(before: Shape): Shape {
  const kept = (line: string) => !ofLegacyTable(line);
  return {
    tables: before.tables.filter((name) => !(legacyTables as readonly string[]).includes(name)),
    columns: before.columns.filter(
      (line) =>
        kept(line) &&
        !line.startsWith("relation_decisions.accepted ") &&
        !line.startsWith("relation_decisions.relation_type ") &&
        !line.startsWith("atomic_note_evolution.run_id ")
    ),
    // PostgreSQL 18 lists NOT NULL as a constraint: the dropped columns take theirs along.
    constraints: before.constraints.filter(
      (line) =>
        kept(line) &&
        !line.includes(` ${changedConstraint} `) &&
        !/^(relation_decisions \S+ NOT NULL (accepted|relation_type)|atomic_note_evolution \S+ NOT NULL run_id)$/u.test(
          line
        )
    ),
    indexes: before.indexes.filter(
      (line) =>
        !legacyTables.some((table) => line.includes(` ON public.${table} `)) &&
        !line.startsWith(`${changedIndex} `)
    ),
    triggers: before.triggers.filter((line) => kept(line)),
    functions: before.functions.filter((name) => name !== "legacy_insert_fence"),
    views: before.views,
    enums: before.enums
  };
}

async function verifyDropped(db: PgPool, label: string, migrations: number): Promise<void> {
  const history = await db.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  assert.equal(Number(history.rows[0]?.count), migrations, `${label}: history`);
  // No relation of a legacy name is left: tables, indexes, sequences, views.
  const relations = await db.query<{ name: string }>(
    `select relname as name from pg_class
      where relnamespace = 'public'::regnamespace and relname ~ $1 order by relname`,
    [legacyPrefix]
  );
  assert.deepEqual(
    relations.rows.map((row) => row.name),
    [],
    `${label}: no relation of a legacy name is left`
  );
  const routines = await db.query<{ name: string }>(
    `select proname as name from pg_proc
      where pronamespace = 'public'::regnamespace and (proname ~ $1 or proname = 'legacy_insert_fence')`,
    [legacyPrefix]
  );
  assert.deepEqual(
    routines.rows.map((row) => row.name),
    [],
    `${label}: no legacy function is left`
  );
  const triggers = await db.query<{ name: string }>(
    "select tgname as name from pg_trigger where not tgisinternal and tgname = 'legacy_insert_fence'"
  );
  assert.equal(triggers.rowCount, 0, `${label}: no fence trigger is left`);
  const removed = await db.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'relation_decisions' and column_name in ('accepted', 'relation_type'))
        or (table_name = 'atomic_note_evolution' and column_name = 'run_id'))`
  );
  assert.deepEqual(removed.rows, [], `${label}: the removed columns are gone`);
  const check = await db.query<{ definition: string }>(
    `select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'relation_decisions'::regclass and conname = $1`,
    [changedConstraint]
  );
  assert.equal(check.rowCount, 1, `${label}: the type check is kept`);
  assert.match(
    check.rows[0]!.definition,
    /lo_to_hi_relation_type/u,
    `${label}: it checks lo -> hi`
  );
  assert.match(
    check.rows[0]!.definition,
    /hi_to_lo_relation_type/u,
    `${label}: it checks hi -> lo`
  );
  assert.doesNotMatch(
    check.rows[0]!.definition,
    /\brelation_type\b/u,
    `${label}: not the old column`
  );
  const pk = await db.query<{ columns: string }>(
    `select string_agg(a.attname, ',' order by a.attnum) as columns from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.conrelid = 'atomic_note_evolution'::regclass and c.contype = 'p'`
  );
  assert.equal(pk.rows[0]?.columns, "previous_id,next_id", `${label}: the evolution key is kept`);
  // The one view still reads.
  await db.query("select count(*) from change_sets");
}

const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const admin = createPgPool({ connectionString: connection.connectionString, max: 2 });
  pools.push(admin);
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")
  ) as Journal;
  const databaseUrl = (name: string) => {
    const url = new URL(connection.connectionString);
    url.pathname = `/${name}`;
    return url.toString();
  };

  // 1. A database with history: every earlier migration applied and rows everywhere.
  await admin.query("create database memora_legacy_drop_history");
  const history = createPgPool({
    connectionString: databaseUrl("memora_legacy_drop_history"),
    max: 4
  });
  pools.push(history);
  const beforeCount = await migrateTo(history, journal, false);
  const before = await shape(history);
  assert.deepEqual(
    legacyTables.filter((table) => !before.tables.includes(table)),
    [],
    "the 30 legacy tables exist before the migration"
  );
  assert.ok(before.functions.includes("legacy_insert_fence"), "the fence function exists before");
  const fenced = before.triggers
    .filter((line) => line.includes(" legacy_insert_fence "))
    .map((line) => line.split(" ")[0]!)
    .sort();
  assert.deepEqual(fenced, fencedTables, "the fence guards its seven tables before");
  const intoLegacy = await history.query<{ line: string }>(
    `select conrelid::regclass::text || '.' || conname as line from pg_constraint
      where contype = 'f' and confrelid::regclass::text = any($1::text[])
        and not (conrelid::regclass::text = any($1::text[]))`,
    [[...legacyTables]]
  );
  assert.deepEqual(
    intoLegacy.rows,
    [],
    "no foreign key from a kept table reaches a legacy table, so CASCADE drops nothing kept"
  );
  const { keptTablesWithRows } = await seedHistory(history);
  const countsBefore = await tableCounts(history);
  const decisionsBefore = (
    await history.query(
      `select pair_key, decider_key, lo_to_hi_score, lo_to_hi_relation_type, hi_to_lo_score,
              hi_to_lo_relation_type, score_scale from relation_decisions order by decider_key`
    )
  ).rows;
  const evolutionBefore = (
    await history.query("select previous_id, next_id, kind, reason from atomic_note_evolution")
  ).rows;
  assert.equal(decisionsBefore.length, 2, "two relation decisions before");
  assert.equal(evolutionBefore.length, 1, "one evolution row before");

  const started = performance.now();
  const throughCount = await migrateTo(history, journal, true);
  const migrationMs = Math.round(performance.now() - started);
  assert.equal(throughCount, beforeCount + 1, "only 0063 was pending");
  assert.ok(migrationMs < 15_000, `the migration took ${migrationMs} ms, over the 15 s gate bar`);
  await verifyDropped(history, "history", throughCount);

  // 2. Nothing else changed: counts of every kept table, then every kept definition.
  const countsAfter = await tableCounts(history);
  const keptCounts = Object.fromEntries(
    Object.entries(countsBefore).filter(
      ([table]) => !(legacyTables as readonly string[]).includes(table)
    )
  );
  assert.deepEqual(countsAfter, keptCounts, "the row counts of every kept table are equal");
  const after = await shape(history);
  const expected = withoutLegacy(before);
  // The type check is redefined, not removed: verifyDropped read its new definition.
  const comparable = {
    ...after,
    constraints: after.constraints.filter((line) => !line.includes(` ${changedConstraint} `))
  };
  for (const key of Object.keys(expected) as Array<keyof Shape>)
    assertSameLines(comparable[key], expected[key], `only the dropped definitions left: ${key}`);
  assert.deepEqual(
    (
      await history.query(
        `select pair_key, decider_key, lo_to_hi_score, lo_to_hi_relation_type, hi_to_lo_score,
                hi_to_lo_relation_type, score_scale from relation_decisions order by decider_key`
      )
    ).rows,
    decisionsBefore,
    "the relation decisions keep every column that stays"
  );
  assert.deepEqual(
    (await history.query("select previous_id, next_id, kind, reason from atomic_note_evolution"))
      .rows,
    evolutionBefore,
    "the evolution row keeps every column that stays"
  );
  const settings = await history.query<{ key: string }>(
    "select key from settings where key = any($1::text[]) order by key",
    [[...legacySettings]]
  );
  assert.deepEqual(
    settings.rows.map((row) => row.key),
    [...legacySettings].sort(),
    "the settings rows are kept (no SQL for them in this migration)"
  );

  // 3. An empty database: the baseline seed ends with the same shape (any later migration applied).
  await runMigrations(history, migrationsFolder, { seedFolder });
  const final = await shape(history);
  await admin.query("create database memora_legacy_drop_empty");
  const empty = createPgPool({
    connectionString: databaseUrl("memora_legacy_drop_empty"),
    max: 4
  });
  pools.push(empty);
  const seeded = await runMigrations(empty, migrationsFolder, { seedFolder });
  assert.ok(seeded.seed.applied, "the baseline seed was applied");
  assert.ok(seeded.seed.seededMigrations.includes(migrationName), "the baseline carries 0063");
  await verifyDropped(empty, "empty", journal.entries.length);
  const baseline = await shape(empty);
  for (const key of Object.keys(final) as Array<keyof Shape>)
    assertSameLines(baseline[key], final[key], `baseline and pending paths agree: ${key}`);

  // 4. The type check still refuses a type outside the vocabulary and accepts a known one.
  const decisions = createRelationDecisionRepository(history);
  await decisions.record({
    sourceAtomicNoteId: uid(12),
    targetAtomicNoteId: uid(11),
    sourceContentHash: "h2",
    targetContentHash: "h1",
    deciderKey: "decider-2",
    score: 0.8,
    relationType: "extends",
    aiTaskRunId: null
  });
  const verdicts = await decisions.findVerdicts({
    sourceAtomicNoteId: uid(12),
    sourceContentHash: "h2",
    deciderKey: "decider-2",
    targets: [{ atomicNoteId: uid(11), contentHash: "h1" }]
  });
  assert.deepEqual(
    verdicts.get(uid(11)),
    { score: 0.8, relationType: "extends" },
    "the writer records and reads a verdict on the migrated schema"
  );
  await history
    .query(
      `update relation_decisions set lo_to_hi_relation_type = 'bogus' where decider_key = 'decider'`
    )
    .then(
      () => assert.fail("a type outside the vocabulary was accepted"),
      (error: { code?: string }) => assert.equal(error.code, "23514", "the type check refuses it")
    );
  await history
    .query(
      `insert into atomic_note_evolution (previous_id, next_id, kind, reason) values ($1, $2, 'merge', 'again')`,
      [uid(11), uid(12)]
    )
    .then(
      () => assert.fail("a second evolution row for the same pair was accepted"),
      (error: { code?: string }) => assert.equal(error.code, "23505", "the key still holds")
    );

  // 5. The statements the guards used to carry, and the reset, run on the migrated schema.
  const jobs = createJobRepository(history);
  const dismissed = await jobs.clearCompletedOrFailed();
  assert.ok(dismissed >= 2, "finished jobs, the legacy-kind job included, are dismissed");
  const pruned = await jobs.pruneFinished({ before: new Date(Date.now() + 60_000), limit: 10 });
  assert.ok(pruned >= 0, "pruning finished jobs runs");
  await createLibraryResetRepository(empty).reset();
  assert.equal(
    (await empty.query("select count(*)::int as n from source_items")).rows[0]?.n,
    0,
    "the library reset runs without the legacy tables"
  );

  console.info(
    JSON.stringify({
      verified: [
        "history database: only 0063 ran, on rows in each of the 30 legacy tables",
        "no relation, function or trigger of a legacy name is left; the fence function and its 7 triggers are gone",
        "no foreign key from a kept table reached a legacy table (CASCADE dropped nothing kept)",
        "row counts of every kept table equal; constraints, indexes, triggers, functions, views and enums equal apart from the removed definitions",
        "relation_decisions.accepted and .relation_type and atomic_note_evolution.run_id gone, their rows kept, the type check kept on both directions",
        "empty database: the baseline seed ends with the same shape",
        "job dismissal and pruning, the decision writer and the library reset run on the migrated schema"
      ],
      migrations: journal.entries.length,
      legacyTables: legacyTables.length,
      keptTablesWithRows,
      keptTables: Object.keys(keptCounts).length,
      migrationMs
    })
  );
} finally {
  for (const pool of pools.reverse()) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
