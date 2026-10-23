import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createGardenerOutcomeRepository,
  createJobRepository,
  createPgPool,
  PostgresSidecarManager,
  type PgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

/**
 * Real-database check of migration `0060_gardener_tasks` (F4 T74): on a database with history
 * (every earlier migration applied, jobs queued, running and finished as the pre-F4 code left
 * them) only the new migration runs, backfills the scope and subject of queued and running jobs by
 * the kind table (never an inline stage row), names the root of queued link and promote jobs as
 * their source, keeps one running job per scope, leaves finished jobs without an outcome (legacy)
 * and adds or loses no row; on an empty database the baseline brings the same schema. It checks the
 * columns, the constraints, the indexes and that the claim and latestByType reads can use them,
 * and the repository's claim exclusion and quarantine. It starts its own temporary PostgreSQL
 * sidecar and never connects to an existing database.
 */
const migrationName = "0060_gardener_tasks";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-gardener-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_gardener",
  user: "memora_gardener",
  password: `gardener-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

interface Journal {
  entries: Array<{ tag: string }>;
}

const expectedColumns = [
  "gardener_outcomes.consecutive_failures:integer:NO:0",
  "gardener_outcomes.created_at:timestamp with time zone:NO:now()",
  "gardener_outcomes.failed_fingerprint:text:YES:",
  "gardener_outcomes.kind:text:NO:",
  "gardener_outcomes.last_error_class:text:YES:",
  "gardener_outcomes.last_fingerprint:text:YES:",
  "gardener_outcomes.last_job_id:uuid:YES:",
  "gardener_outcomes.last_outcome:text:NO:",
  "gardener_outcomes.quarantined_at:timestamp with time zone:YES:",
  "gardener_outcomes.subject_key:text:NO:",
  "gardener_outcomes.updated_at:timestamp with time zone:NO:now()",
  "jobs.blocked_at:timestamp with time zone:YES:",
  "jobs.blocked_class:text:YES:",
  "jobs.blocked_reason:text:YES:",
  "jobs.input_fingerprint:text:YES:",
  "jobs.outcome:text:YES:",
  "jobs.quarantined_at:timestamp with time zone:YES:",
  "jobs.scope_key:text:YES:",
  "jobs.subject_key:text:YES:",
  "note_match_state.input_hash:text:YES:"
];
const newJobColumns = [
  "scope_key",
  "subject_key",
  "outcome",
  "blocked_class",
  "blocked_reason",
  "blocked_at",
  "quarantined_at",
  "input_fingerprint"
];

async function gardenerColumns(db: PgPool): Promise<string[]> {
  const columns = await db.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and (table_name = 'gardener_outcomes'
         or (table_name = 'jobs' and column_name = any($1::text[]))
         or (table_name = 'note_match_state' and column_name = 'input_hash'))
      order by table_name, column_name`,
    [newJobColumns]
  );
  return columns.rows.map(
    (row) =>
      `${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}:${row.column_default ?? ""}`
  );
}

async function verifySchema(db: PgPool, label: string, journal: Journal): Promise<void> {
  const history = await db.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  assert.equal(Number(history.rows[0]?.count), journal.entries.length, `${label}: history`);
  assert.deepEqual(await gardenerColumns(db), expectedColumns, `${label}: columns`);
  const constraints = await db.query<{ conname: string; contype: string }>(
    `select conname, contype from pg_constraint
      where conrelid in ('jobs'::regclass, 'gardener_outcomes'::regclass, 'note_match_state'::regclass)
        and conname = any($1::text[]) order by conname`,
    [
      [
        "gardener_outcomes_kind_subject_key_pk",
        "gardener_outcomes_values",
        "jobs_gardener",
        "note_match_state_values"
      ]
    ]
  );
  assert.deepEqual(
    constraints.rows.map((row) => `${row.conname}:${row.contype}`),
    [
      "gardener_outcomes_kind_subject_key_pk:p",
      "gardener_outcomes_values:c",
      "jobs_gardener:c",
      "note_match_state_values:c"
    ],
    `${label}: constraints`
  );
  const matchCheck = await db.query<{ def: string }>(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'note_match_state_values'"
  );
  assert.match(matchCheck.rows[0]?.def ?? "", /input_hash/u, `${label}: note_match_state check`);
  const indexes = await db.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes
      where indexname = any($1::text[]) order by indexname`,
    [["gardener_outcomes_quarantined_idx", "jobs_running_scope_uidx", "jobs_type_status_idx"]]
  );
  const byName = new Map(indexes.rows.map((row) => [row.indexname, row.indexdef]));
  assert.match(
    byName.get("jobs_running_scope_uidx") ?? "",
    /CREATE UNIQUE INDEX jobs_running_scope_uidx ON public\.jobs USING btree \(scope_key\) WHERE \(\(scope_key IS NOT NULL\) AND \(status = 'running'::job_status\)\)/u,
    `${label}: running scope index`
  );
  assert.match(
    byName.get("jobs_type_status_idx") ?? "",
    /ON public\.jobs USING btree \(type, status\)/u,
    `${label}: type and status index`
  );
  assert.match(
    byName.get("gardener_outcomes_quarantined_idx") ?? "",
    /WHERE \(quarantined_at IS NOT NULL\)/u,
    `${label}: quarantine index`
  );
}

/** Applies every migration before 0060 from a copy of the folder, as a profile from before F4. */
async function migrateBefore(db: PgPool, journal: Journal): Promise<void> {
  const folder = join(workDir, "migrations-before");
  await cp(migrationsFolder, folder, { recursive: true });
  const position = journal.entries.findIndex((entry) => entry.tag === migrationName);
  assert.ok(position > 0, "the migration is in the journal");
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, position) }, null, 2)
  );
  await runMigrations(db, folder);
}

async function plan(db: PgPool, sql: string, values: unknown[]): Promise<string> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("set local enable_seqscan = off");
    const explained = await client.query<{ "QUERY PLAN": string }>(`explain ${sql}`, values);
    await client.query("rollback");
    return explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
  } finally {
    client.release();
  }
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

  // 1. A database with history: jobs as the pre-F4 code left them.
  await admin.query("create database memora_gardener_history");
  const history = createPgPool({
    connectionString: databaseUrl("memora_gardener_history"),
    max: 3
  });
  pools.push(history);
  await migrateBefore(history, journal);
  assert.deepEqual(
    (await gardenerColumns(history)).filter((column) => column.startsWith("jobs.")),
    [],
    "no Gardener column before 0060"
  );
  const book = (
    await history.query<{ id: string }>(
      "insert into source_items (type, title) values ('Book', 'A book') returning id"
    )
  ).rows[0]!.id;
  const chapter = (
    await history.query<{ id: string }>(
      "insert into source_items (type, title, parent_source_item_id) values ('BookChapter', 'One', $1) returning id",
      [book]
    )
  ).rows[0]!.id;
  const treeId = randomUUID();
  const fixtures: Array<[string, string, string, Record<string, unknown>]> = [
    ["place", "topic-place", "queued", { treeId, rootSourceId: book, sourceItemId: book }],
    ["gate", "topic-gate", "queued", { treeId, noteId: chapter }],
    ["name", "topic-name", "queued", { treeId }],
    ["sweep", "topic-sweep", "queued", { treeId: null, reason: "startup" }],
    ["link", "relation-link", "queued", { rootId: book }],
    ["promote", "relation-promote", "queued", { rootId: chapter }],
    ["linkRunning", "relation-link", "running", { rootId: chapter, n: 1 }],
    ["linkRunningTwin", "relation-link", "running", { rootId: chapter, n: 2 }],
    ["header", "catalog-header", "queued", {}],
    ["retype", "relation-retype", "queued", {}],
    ["ingestion", "ingestion", "queued", { sourceItemId: chapter }],
    ["stage", "summarization", "running", { sourceItemId: chapter }],
    ["done", "topic-place", "succeeded", { treeId, rootSourceId: book }],
    ["embedding", "note-embedding", "queued", { atomicNoteId: randomUUID(), sourceItemId: book }]
  ];
  const ids = new Map<string, string>();
  for (const [name, type, status, payload] of fixtures) {
    const inserted = await history.query<{ id: string }>(
      `insert into jobs (type, status, payload, lane, locked_at)
       values ($1, $2::job_status, $3, $4, case when $2 = 'running' then now() end) returning id`,
      [
        type,
        status,
        payload,
        ["ingestion", "summarization", "note-embedding"].includes(type) ? "heavy" : "light"
      ]
    );
    ids.set(name, inserted.rows[0]!.id);
  }
  const beforeCount = await history.query<{ count: string }>(
    "select count(*)::text as count from jobs"
  );
  const started = performance.now();
  await runMigrations(history, migrationsFolder, { seedFolder });
  const migrationMs = Math.round(performance.now() - started);
  await verifySchema(history, "history", journal);
  const afterCount = await history.query<{ count: string }>(
    "select count(*)::text as count from jobs"
  );
  assert.equal(afterCount.rows[0]?.count, beforeCount.rows[0]?.count, "no job added or lost");
  const rows = await history.query<{
    id: string;
    scope_key: string | null;
    subject_key: string | null;
    outcome: string | null;
    blocked_class: string | null;
    quarantined_at: Date | null;
    payload: Record<string, unknown>;
  }>(
    "select id, scope_key, subject_key, outcome, blocked_class, quarantined_at, payload from jobs"
  );
  const row = (name: string) => rows.rows.find((candidate) => candidate.id === ids.get(name))!;
  const keys = (name: string) => [row(name).scope_key, row(name).subject_key];
  assert.deepEqual(keys("place"), [`tree:${treeId}:structure`, `root:${book}`], "place keys");
  assert.deepEqual(keys("gate"), [`tree:${treeId}:gate`, `note:${chapter}`], "gate keys");
  assert.deepEqual(keys("name"), [`tree:${treeId}:names`, `tree:${treeId}`], "naming keys");
  assert.deepEqual(keys("sweep"), [null, null], "a sweep before any tree has no keys");
  assert.deepEqual(keys("link"), [`root:${book}`, `root:${book}`], "link keys");
  assert.equal(row("link").payload.sourceItemId, book, "a queued link job names its root");
  assert.deepEqual(keys("promote"), [`root:${chapter}`, `root:${chapter}`], "promote keys");
  assert.equal(row("promote").payload.sourceItemId, chapter, "a queued promote job names its root");
  const running = [row("linkRunning").scope_key, row("linkRunningTwin").scope_key];
  assert.deepEqual(
    running.filter((scope) => scope !== null),
    [`root:${chapter}`],
    "one running job per scope keeps it"
  );
  assert.deepEqual(keys("header"), ["catalog-header", "catalog-header"], "singleton keys");
  assert.deepEqual(keys("retype"), [null, "relation-retype"], "the sweep has a subject only");
  assert.deepEqual(keys("ingestion"), [`root:${book}`, `root:${book}`], "ingestion by its root");
  assert.deepEqual(keys("stage"), [null, null], "an inline stage row keeps no scope");
  assert.deepEqual(keys("done"), [null, null], "a finished job is not backfilled");
  assert.equal(row("done").outcome, null, "a finished job reads as legacy");
  assert.deepEqual(keys("embedding"), [null, null], "cache-only work has no keys");
  assert.ok(
    rows.rows.every(
      (candidate) => candidate.blocked_class === null && candidate.quarantined_at === null
    ),
    "nothing is blocked or quarantined by the migration"
  );

  // 2. An empty database: the baseline seed carries 0060.
  await admin.query("create database memora_gardener_empty");
  const empty = createPgPool({ connectionString: databaseUrl("memora_gardener_empty"), max: 4 });
  pools.push(empty);
  const seeded = await runMigrations(empty, migrationsFolder, { seedFolder });
  assert.ok(seeded.seed.applied, "the baseline seed was applied");
  await verifySchema(empty, "empty", journal);

  // 3. The constraints refuse states the model does not have.
  const jobs = createJobRepository(empty);
  const probe = await jobs.create({ type: "topic-place", lane: "light", payload: { treeId } });
  const refused: string[] = [];
  for (const [label, sql] of [
    ["outcome on a queued job", "update jobs set outcome = 'done' where id = $1"],
    ["unknown outcome", "update jobs set status = 'succeeded', outcome = 'finished' where id = $1"],
    ["quarantine on a queued job", "update jobs set quarantined_at = now() where id = $1"],
    [
      "class without reason",
      "update jobs set blocked_class = 'paused', blocked_at = now() where id = $1"
    ],
    [
      "unknown class",
      "update jobs set blocked_class = 'later', blocked_reason = 'x', blocked_at = now() where id = $1"
    ],
    [
      "blocker on a running job",
      "update jobs set status = 'running', blocked_class = 'paused', blocked_reason = 'user_pause', blocked_at = now() where id = $1"
    ]
  ] as const) {
    await empty.query(sql, [probe.id]).then(
      () => assert.fail(`${label} was accepted`),
      (error: { code?: string; constraint?: string }) => {
        assert.equal(error.code, "23514", `${label} violates a check`);
        assert.equal(error.constraint, "jobs_gardener", `${label}: jobs_gardener`);
        refused.push(label);
      }
    );
  }
  await empty
    .query(
      "insert into gardener_outcomes (kind, subject_key, last_outcome, consecutive_failures, quarantined_at) values ('k', 's', 'failed', 0, now())"
    )
    .then(
      () => assert.fail("a quarantine without a failure was accepted"),
      (error: { code?: string }) => assert.equal(error.code, "23514")
    );

  // 4. Claim exclusion: one running job per scope, enforced by the index whatever writes it.
  const sibling = await jobs.create({
    type: "topic-sweep",
    lane: "light",
    payload: { treeId, reason: "requested" }
  });
  assert.equal((await jobs.claimNext("w1", undefined, "light"))?.id, probe.id, "first claim");
  assert.equal(
    await jobs.claimNext("w2", undefined, "light"),
    null,
    "the sibling of a running scope waits"
  );
  await empty.query("update jobs set status = 'running' where id = $1", [sibling.id]).then(
    () => assert.fail("a second running job of one scope was accepted"),
    (error: { code?: string; constraint?: string }) => {
      assert.equal(error.code, "23505");
      assert.equal(error.constraint, "jobs_running_scope_uidx");
    }
  );

  // 5. Quarantine after the second failed job on one (kind, subject, fingerprint).
  const fingerprint = `gf1:${"0".repeat(64)}`;
  let quarantinedAt: Date | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const job = await jobs.create({ type: "topic-name", lane: "light", payload: { treeId } });
    const ended = await jobs.finish(
      job.id,
      { status: "failed", error: "invalid", finishedAt: new Date() },
      {
        kind: "topic-name",
        subjectKey: `tree:${treeId}`,
        result: "failed",
        fingerprint,
        errorClass: "result:invalid",
        quarantineAfter: 2
      }
    );
    quarantinedAt = ended?.quarantinedAt ?? null;
    assert.equal(quarantinedAt === null, attempt === 0, `failed job ${attempt + 1}`);
  }
  assert.equal(
    await createGardenerOutcomeRepository(empty).countQuarantined(),
    1,
    "one quarantine"
  );

  // 6. The reads can use the new indexes.
  const latestPlan = await plan(
    empty,
    "select id from jobs where type = $1 and status in ('queued', 'running')",
    ["topic-build"]
  );
  assert.match(latestPlan, /jobs_type_status_idx/u, "latestByType's filter uses (type, status)");
  const scopePlan = await plan(
    empty,
    "select 1 from jobs r where r.scope_key = $1 and r.status = 'running'",
    [`tree:${treeId}:structure`]
  );
  assert.match(
    scopePlan,
    /jobs_running_scope_uidx/u,
    "the claim's same-scope probe uses the index"
  );

  console.info(
    JSON.stringify({
      verified: [
        "history database: only 0060 ran; no job added or lost",
        "queued and running jobs got scope and subject by the kind table; inline stages and finished jobs none",
        "queued link and promote jobs name their root as sourceItemId",
        "one running job per scope kept its scope",
        "empty database: the baseline seed carries 0060",
        "columns, types, nullability, defaults; four constraints; three indexes",
        "jobs_gardener refuses outcome, blocker and quarantine states outside the model",
        "jobs_running_scope_uidx refuses a second running job of one scope; the claim skips it",
        "the second failed job on one input quarantines it",
        "latestByType and the claim's scope probe use the new indexes"
      ],
      migrations: journal.entries.length,
      migrationMs,
      refused
    })
  );
} finally {
  for (const pool of pools.reverse()) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
