import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";

import {
  closePgPool,
  createChangeSetRepository,
  createPgPool,
  createRelationEventRepository,
  createRelationMatchRunRepository,
  createSourceItemRepository,
  createTopicOverviewRepository,
  createTopicTreeRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool,
  type Queryable,
  type SaveTopicOverviewInput
} from "../index.js";

/**
 * Real-database check of migration `0062_change_set_envelope` (F4 T77, D10): on a database with
 * history (a topic tree, an overview and relation passes written before it) only the new migration
 * runs, every existing row keeps its values and reads the new fields as their defaults or unknown,
 * and the `change_sets` view lists exactly the change-sets (human, open and empty passes left out);
 * on an empty database the baseline brings the same shape. It then drives each store's change-set
 * through its own writer (titles, risk, review, revert, overview versions and their undo), probes
 * the checks, and EXPLAINs the view's page and the retention reads against their indexes. It
 * starts its own temporary PostgreSQL sidecar and never touches an existing database.
 */
const migrationName = "0062_change_set_envelope";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-change-sets-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_change_sets",
  user: "memora_change_sets",
  password: `change-sets-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

interface Journal {
  entries: Array<{ tag: string }>;
}

const tables = [
  "relation_match_runs",
  "topic_overviews",
  "topic_overview_versions",
  "gardener_findings",
  "topic_change_sets"
];

/** Columns, indexes, constraints and the view of everything 0062 touches. */
async function shape(db: PgPool) {
  return {
    columns: (
      await db.query<{ row: string }>(
        `select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable ||
                coalesce(':' || column_default, '') as row
           from information_schema.columns
          where table_name = any($1::text[]) or table_name = 'change_sets'`,
        [tables]
      )
    ).rows
      .map((row) => row.row)
      .sort(),
    indexes: (
      await db.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where tablename = any($1::text[])",
        [tables]
      )
    ).rows
      .map((row) => row.indexdef)
      .sort(),
    constraints: (
      await db.query<{ row: string }>(
        `select conname || ':' || contype::text || ':' || pg_get_constraintdef(oid) as row
           from pg_constraint
          where conrelid = any(select oid from pg_class where relname = any($1::text[]))
            and contype <> 'n'`,
        [tables]
      )
    ).rows
      .map((row) => row.row)
      .sort(),
    view: (
      await db.query<{ def: string | null }>(
        "select pg_get_viewdef(to_regclass('change_sets')) as def"
      )
    ).rows[0]?.def
  };
}

const expectedNewColumns = [
  "change_sets.at:timestamp with time zone:YES",
  "change_sets.id:uuid:YES",
  "change_sets.job_id:uuid:YES",
  "change_sets.kind:text:YES",
  "change_sets.origin:text:YES",
  "change_sets.risk:text:YES",
  "change_sets.status:text:YES",
  "change_sets.subject_id:uuid:YES",
  "change_sets.title_key:text:YES",
  "change_sets.title_params:jsonb:YES",
  "change_sets.undo:text:YES",
  "change_sets.undone_at:timestamp with time zone:YES",
  "gardener_findings.closed_at:timestamp with time zone:YES",
  "gardener_findings.created_at:timestamp with time zone:NO:now()",
  "gardener_findings.fingerprint:text:NO",
  "gardener_findings.id:uuid:NO:gen_random_uuid()",
  "gardener_findings.kind:text:NO",
  "gardener_findings.object_refs:jsonb:NO:'[]'::jsonb",
  "gardener_findings.params:jsonb:NO:'{}'::jsonb",
  "gardener_findings.risk:text:NO:'low'::text",
  "gardener_findings.status:text:NO:'open'::text",
  "gardener_findings.updated_at:timestamp with time zone:NO:now()",
  "relation_match_runs.job_id:uuid:YES",
  "relation_match_runs.review_status:text:YES",
  "relation_match_runs.risk:text:NO:'low'::text",
  "relation_match_runs.title_key:text:YES",
  "relation_match_runs.title_params:jsonb:NO:'{}'::jsonb",
  "relation_match_runs.undone_at:timestamp with time zone:YES",
  "topic_overview_versions.applied_at:timestamp with time zone:YES",
  "topic_overview_versions.base_version:integer:NO",
  "topic_overview_versions.created_at:timestamp with time zone:NO:now()",
  "topic_overview_versions.id:uuid:NO:gen_random_uuid()",
  "topic_overview_versions.job_id:uuid:YES",
  "topic_overview_versions.origin:text:NO",
  "topic_overview_versions.previous:jsonb:YES",
  "topic_overview_versions.proposed:jsonb:YES",
  "topic_overview_versions.risk:text:NO:'low'::text",
  "topic_overview_versions.status:text:NO",
  "topic_overview_versions.title_key:text:NO",
  "topic_overview_versions.title_params:jsonb:NO:'{}'::jsonb",
  "topic_overview_versions.topic_id:uuid:NO",
  "topic_overview_versions.undo_of:uuid:YES",
  "topic_overview_versions.undone_at:timestamp with time zone:YES",
  "topic_overview_versions.version:integer:YES",
  "topic_overviews.divergences:jsonb:NO:'[]'::jsonb",
  "topic_overviews.version:integer:NO:1"
];

const expectedNewIndexes = [
  "CREATE INDEX gardener_findings_open_idx ON public.gardener_findings USING btree (created_at) WHERE (status = 'open'::text)",
  "CREATE INDEX relation_match_runs_started_idx ON public.relation_match_runs USING btree (started_at)",
  "CREATE INDEX topic_change_sets_created_idx ON public.topic_change_sets USING btree (created_at)",
  "CREATE INDEX topic_overview_versions_created_idx ON public.topic_overview_versions USING btree (created_at)",
  "CREATE INDEX topic_overview_versions_topic_created_idx ON public.topic_overview_versions USING btree (topic_id, created_at DESC NULLS LAST)",
  "CREATE INDEX topic_overview_versions_undo_idx ON public.topic_overview_versions USING btree (undo_of) WHERE (undo_of IS NOT NULL)",
  "CREATE UNIQUE INDEX gardener_findings_kind_fingerprint_uidx ON public.gardener_findings USING btree (kind, fingerprint)",
  "CREATE UNIQUE INDEX gardener_findings_pkey ON public.gardener_findings USING btree (id)",
  "CREATE UNIQUE INDEX topic_overview_versions_pkey ON public.topic_overview_versions USING btree (id)",
  "CREATE UNIQUE INDEX topic_overview_versions_version_uidx ON public.topic_overview_versions USING btree (topic_id, version) WHERE (version IS NOT NULL)"
];

/** Applies every migration before 0062 from a copy of the folder, as a profile from before F4. */
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

/** A rejected statement, by SQLSTATE class 23 (integrity): what the checks must refuse. */
async function refused(db: Queryable, label: string, sql: string, values: unknown[] = []) {
  await db.query("savepoint probe");
  try {
    await db.query(sql, values);
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    await db.query("rollback to savepoint probe");
    assert.ok(code.startsWith("23"), `${label}: refused with ${code}`);
    return;
  }
  await db.query("rollback to savepoint probe");
  assert.fail(`${label}: the check accepted it`);
}

const overviewInput = (topicId: string, text: string): SaveTopicOverviewInput => ({
  topicId,
  paragraphs: [{ text, citations: [] }],
  evidence: [],
  memberFingerprint: "members",
  memberCount: 3,
  inputHash: `input-${text}`,
  promptRevisionId: "topic.overview@verify",
  provider: "verify",
  model: "verify",
  runtime: "none",
  aiTaskRunId: null,
  language: "en",
  support: { status: "unchecked", unsupported: [] },
  citations: []
});

const report: Record<string, unknown> = {};
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

  // 1. A database with history: a topic tree, an overview and relation passes from before F4.
  await admin.query("create database memora_change_sets_history");
  const db = createPgPool({ connectionString: databaseUrl("memora_change_sets_history"), max: 4 });
  pools.push(db);
  await migrateBefore(db, journal);
  const before = await shape(db);
  assert.equal(before.view, null, "no change_sets view before 0062");

  const source = await createSourceItemRepository(db).create({
    type: "Book",
    title: "The Book of Sleep"
  });
  const trees = createTopicTreeRepository(db);
  const rootId = randomUUID();
  const sleep = randomUUID();
  const tree = await trees.createTree({
    id: randomUUID(),
    rootId,
    spaceKey: "verify:change-sets:256",
    embeddingProvider: "verify",
    embeddingModel: "verify",
    embeddingRuntime: "none",
    dimensions: 256,
    config: {},
    configHash: "verify",
    seed: 1
  });
  const built = await trees.bootstrapSnapshot({
    treeId: tree.id,
    expectedGeneration: tree.generation,
    titleKey: "topics.changeSets.build",
    topics: [
      topicRecord(sleep, rootId, {
        role: "topic",
        title: "Sleep",
        nameState: "named",
        nameSource: "llm",
        nameLanguage: "en",
        position: 0
      })
    ],
    placements: [
      {
        item: itemKey("source", source.id),
        placement: placementRecord(sleep, { itemFingerprint: "v1" })
      }
    ]
  });
  assert.equal(built.kind, "applied", "the tree is written through the engine");
  const buildId = (built as { changeSetId: string }).changeSetId;

  // An overview written before 0062 (the writer of that time had no version column).
  await db.query(
    /* overview constraint probe: a row as the pre-F4 writer stored it */ `insert into topic_overviews
       (topic_id, paragraphs, evidence, member_fingerprint, member_count, input_hash, prompt_revision_id,
        provider, model, runtime, language)
     values ($1, '[{"text":"Sleep consolidates memory.","citations":[]}]'::jsonb, '[]'::jsonb,
             'members', 3, 'input-0', 'topic.overview@verify', 'verify', 'verify', 'none', 'en')`,
    [sleep]
  );

  // Relation passes as the pre-F4 writer left them: applied, reverted, human, open and empty.
  const run = async (kind: string, finished: boolean, outcome: string | null, events: number) => {
    const id = (
      await db.query<{ id: string }>(
        `insert into relation_match_runs (kind, root_id, finished_at, outcome)
         values ($1, $2, case when $3 then now() end, $4) returning id`,
        [kind, source.id, finished, outcome]
      )
    ).rows[0]!.id;
    for (let index = 0; index < events; index += 1)
      await db.query(
        `insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind)
         values ($1, 'note', null, $2, 'suggested')`,
        [id, `pair-${id}-${index}`]
      );
    return id;
  };
  const applied = await run("link", true, "completed", 2);
  const reverted = await run("link", true, "reverted", 1);
  const human = await run("review", true, "succeeded", 1);
  const open = await run("link", false, null, 1);
  const empty = await run("discover", true, "completed", 0);
  const counts = async () =>
    (
      await db.query<{ runs: number; events: number; overviews: number; changeSets: number }>(
        `select (select count(*)::int from relation_match_runs) as runs,
                (select count(*)::int from relation_events) as events,
                (select count(*)::int from topic_overviews) as overviews,
                (select count(*)::int from topic_change_sets) as "changeSets"`
      )
    ).rows[0];
  const countsBefore = await counts();

  const started = performance.now();
  await runMigrations(db, migrationsFolder, { seedFolder });
  report.migrationMs = Math.round(performance.now() - started);
  assert.deepEqual(await counts(), countsBefore, "no row added or lost");
  const history = await db.query<{ count: string }>(
    "select count(*)::text as count from drizzle.__drizzle_migrations"
  );
  assert.equal(Number(history.rows[0]?.count), journal.entries.length, "history");

  const pendingShape = await shape(db);
  const added = (list: string[], earlier: string[]) =>
    list.filter((entry) => !earlier.includes(entry));
  assert.deepEqual(added(pendingShape.columns, before.columns), expectedNewColumns, "new columns");
  assert.deepEqual(added(pendingShape.indexes, before.indexes), expectedNewIndexes, "new indexes");
  const newConstraints = added(pendingShape.constraints, before.constraints).map((row) =>
    row.split(":").slice(0, 2).join(":")
  );
  assert.deepEqual(
    newConstraints,
    [
      "gardener_findings_pkey:p",
      "gardener_findings_values:c",
      "relation_match_runs_change_set:c",
      "topic_overview_versions_origin:c",
      "topic_overview_versions_pkey:p",
      "topic_overview_versions_status:c",
      "topic_overview_versions_topic_id_topics_id_fk:f",
      "topic_overview_versions_undo_of_topic_overview_versions_id_fk:f",
      "topic_overview_versions_values:c",
      "topic_overviews_version:c"
    ],
    "new constraints"
  );
  const fks = pendingShape.constraints.filter((row) => row.includes(":f:"));
  assert.ok(
    fks.some((row) => row.includes("topic_id_topics_id_fk") && row.includes("ON DELETE CASCADE")),
    "versions leave with their topic"
  );
  assert.ok(
    fks.some((row) => row.includes("undo_of_") && row.includes("ON DELETE RESTRICT")),
    "an undo pins the write it undid"
  );

  // Existing rows keep their values and read the new fields as defaults or unknown.
  const runs = await db.query<Record<string, unknown>>(
    `select id, title_key, title_params, risk, review_status, undone_at, job_id
       from relation_match_runs order by id`
  );
  for (const row of runs.rows)
    assert.deepEqual(
      { ...row, id: undefined },
      {
        id: undefined,
        title_key: null,
        title_params: {},
        risk: "low",
        review_status: null,
        undone_at: null,
        job_id: null
      },
      "a pass from before 0062 (a revert time stays unknown)"
    );
  assert.deepEqual(
    (await db.query("select version, divergences from topic_overviews")).rows,
    [{ version: 1, divergences: [] }],
    "an overview from before 0062 is version 1 with no Divergence"
  );
  const view = await db.query<{
    kind: string;
    id: string;
    status: string;
    undo: string;
    title_key: string;
  }>("select kind, id, status, undo, title_key from change_sets order by kind, id");
  assert.deepEqual(
    view.rows,
    [
      {
        kind: "relation",
        id: applied < reverted ? applied : reverted,
        status: applied < reverted ? "applied" : "undone",
        undo: applied < reverted ? "available" : "unavailable",
        title_key: "changes.titles.relation.link"
      },
      {
        kind: "relation",
        id: applied < reverted ? reverted : applied,
        status: applied < reverted ? "undone" : "applied",
        undo: applied < reverted ? "unavailable" : "available",
        title_key: "changes.titles.relation.link"
      },
      {
        kind: "topic",
        id: buildId,
        status: "applied",
        undo: "unavailable",
        title_key: "topics.changeSets.build"
      }
    ],
    "the view lists the change-sets only: the human, open and empty passes are left out"
  );
  report.excluded = { human, open, empty };

  // 2. An empty database: the baseline seed carries 0062 with the same shape.
  await admin.query("create database memora_change_sets_empty");
  const seeded = createPgPool({
    connectionString: databaseUrl("memora_change_sets_empty"),
    max: 2
  });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(seed.seed.applied && seed.seed.seededMigrations.includes(migrationName), "baseline");
  assert.deepEqual(await shape(seeded), pendingShape, "baseline and pending shapes are identical");

  // 3. Each store through its own writer, read through the view.
  const changeSets = createChangeSetRepository(db);
  const relationRuns = createRelationMatchRunRepository(db);
  const relationEvents = createRelationEventRepository(db);
  const job = randomUUID();
  const titled = await relationRuns.start({
    kind: "match",
    rootId: source.id,
    titleKey: "changes.titles.relationMatched",
    titleParams: { note: "Sleep and memory" },
    risk: "medium",
    jobId: job
  });
  await relationEvents.append({
    runId: titled.id,
    relationKind: "note",
    relationId: null,
    pairKey: "pair-titled",
    kind: "suggested",
    before: null,
    after: null
  });
  await relationRuns.finish(titled.id, { outcome: "completed" });
  const listed = await changeSets.get("relation", titled.id);
  assert.deepEqual(
    listed && {
      titleKey: listed.titleKey,
      titleParams: listed.titleParams,
      risk: listed.risk,
      status: listed.status,
      jobId: listed.jobId,
      undo: listed.undo
    },
    {
      titleKey: "changes.titles.relationMatched",
      titleParams: { note: "Sleep and memory" },
      risk: "medium",
      status: "applied",
      jobId: job,
      undo: "available"
    },
    "a titled pass"
  );
  assert.equal((await relationEvents.revertRun(titled.id)).kind, "reverted");
  const undone = await changeSets.get("relation", titled.id);
  assert.equal(undone?.status, "undone", "a revert reads undone");
  assert.ok(undone?.undoneAt, "with its time");
  assert.equal(undone?.undo, "unavailable");

  const pending = await relationRuns.start({ kind: "match", pendingReview: true });
  await relationRuns.finish(pending.id, { outcome: "completed" });
  await relationEvents.append({
    runId: pending.id,
    relationKind: "note",
    relationId: null,
    pairKey: "pair-pending",
    kind: "suggested",
    before: null,
    after: null
  });
  assert.equal((await changeSets.get("relation", pending.id))?.status, "pending_review");
  assert.deepEqual((await changeSets.pendingCounts()).byKind.relation, 1, "the badge counts it");
  assert.equal((await relationEvents.reviewRun(pending.id, "dismiss")).kind, "dismissed");
  const dismissed = await relationRuns.get(pending.id);
  assert.equal(dismissed?.reviewStatus, "dismissed");
  assert.equal(dismissed?.outcome, "reverted", "a dismissed pass is reverted");
  assert.equal((await changeSets.get("relation", pending.id))?.status, "dismissed");

  const overviews = createTopicOverviewRepository(db);
  const second = await overviews.write(overviewInput(sleep, "Second text."));
  assert.ok(second.kind === "written" && second.version === 2 && second.changeSetId, "v2");
  const third = await overviews.write({
    ...overviewInput(sleep, "Third text."),
    expectedVersion: 2,
    divergences: [{ existing: "E1", new: "E2", summary: "Naps differ." }],
    change: { origin: "patch", risk: "medium" }
  });
  assert.ok(third.kind === "written" && third.version === 3 && third.changeSetId, "v3");
  assert.deepEqual(
    await overviews.write({ ...overviewInput(sleep, "Late."), expectedVersion: 2 }),
    { kind: "moved", version: 3 },
    "a text computed on an older version is refused"
  );
  assert.equal((await changeSets.get("overview", second.changeSetId))?.undo, "blocked");
  assert.equal((await changeSets.get("overview", third.changeSetId))?.undo, "available");
  assert.deepEqual(await overviews.undoVersion(second.changeSetId), {
    kind: "blocked",
    code: "newer_version"
  });
  const restored = await overviews.undoVersion(third.changeSetId);
  assert.equal(restored.kind, "undone", "the patch is undone");
  const now = await overviews.readContext(sleep);
  assert.deepEqual(
    now?.stored && {
      text: now.stored.paragraphs[0]?.text,
      version: now.stored.version,
      divergences: now.stored.divergences
    },
    { text: "Second text.", version: 4, divergences: [] },
    "the replaced text is back, a version up"
  );
  assert.equal((await changeSets.get("overview", third.changeSetId))?.status, "undone");
  const diff = await changeSets.diff("overview", third.changeSetId);
  assert.ok(diff?.kind === "overview", "an overview diff");
  assert.deepEqual(
    [diff.before?.paragraphs[0]?.text, diff.after?.paragraphs[0]?.text, diff.after?.divergences],
    ["Second text.", "Third text.", [{ existing: "E1", new: "E2", summary: "Naps differ." }]],
    "the diff shows the write's two sides"
  );
  const proposal = await overviews.propose({
    ...overviewInput(sleep, "Proposed text."),
    change: { origin: "rewrite", risk: "high" }
  });
  assert.ok(proposal.kind === "proposed" && proposal.baseVersion === 4, "a proposal on v4");
  assert.equal((await changeSets.get("overview", proposal.id))?.status, "pending_review");
  assert.deepEqual(await overviews.resolveProposal(proposal.id, "apply"), {
    kind: "applied",
    version: 5,
    writtenAtExact: (await overviews.readContext(sleep))!.stored!.writtenAtExact
  });

  // 4. The checks refuse what the stores never write (in one transaction, rolled back).
  const probe = await db.connect();
  await probe.query("begin");
  await refused(
    probe,
    "an unknown finding kind",
    "insert into gardener_findings (kind, fingerprint) values ('guess', 'f')"
  );
  await refused(
    probe,
    "a closed open finding",
    "insert into gardener_findings (kind, fingerprint, closed_at) values ('duplicate', 'f', now())"
  );
  await probe.query("insert into gardener_findings (kind, fingerprint) values ('budget', 'month')");
  await refused(
    probe,
    "a second finding with the same fingerprint",
    "insert into gardener_findings (kind, fingerprint) values ('budget', 'month')"
  );
  await refused(
    probe,
    "a pass with an unknown risk",
    "update relation_match_runs set risk = 'extreme' where id = $1",
    [applied]
  );
  await refused(
    probe,
    "a revert time on a pass that was not reverted",
    "update relation_match_runs set undone_at = now() where id = $1",
    [applied]
  );
  await refused(
    probe,
    "an unknown verdict",
    "update relation_match_runs set review_status = 'maybe' where id = $1",
    [applied]
  );
  await refused(
    probe,
    "a pending overview proposal without its text",
    /* overview constraint probe */ `insert into topic_overview_versions
       (topic_id, origin, status, title_key, base_version) values ($1, 'patch', 'pending_review', 'k', 0)`,
    [sleep]
  );
  await refused(
    probe,
    "an applied write without its version",
    /* overview constraint probe */ `insert into topic_overview_versions
       (topic_id, origin, status, title_key, base_version) values ($1, 'write', 'applied', 'k', 1)`,
    [sleep]
  );
  await refused(
    probe,
    "an undo that names no write",
    /* overview constraint probe */ `insert into topic_overview_versions
       (topic_id, origin, status, title_key, base_version, version, applied_at)
     values ($1, 'undo', 'applied', 'k', 1, 2, now())`,
    [sleep]
  );
  await refused(
    probe,
    "an overview without a version",
    /* overview constraint probe */ "update topic_overviews set version = 0 where topic_id = $1",
    [sleep]
  );
  await probe.query("rollback");
  probe.release();

  // 5. The view's page and the retention reads use their indexes (sequential scans off: the
  // tables are tiny here).
  const plan = async (sql: string, values: unknown[]) => {
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
  };
  const page = await plan(changeSets.statements.list, [
    null,
    null,
    null,
    new Date().toISOString(),
    "topic",
    randomUUID(),
    51
  ]);
  for (const index of [
    "topic_change_sets_created_idx",
    "relation_match_runs_started_idx",
    "topic_overview_versions_created_idx"
  ])
    assert.ok(page.includes(index), `the page reads ${index}:\n${page}`);
  const runPrune = await plan(
    `select r.id from relation_match_runs r
      where r.finished_at is not null and r.started_at < $1::timestamptz
        and r.review_status is null order by r.started_at limit 500`,
    [new Date().toISOString()]
  );
  assert.ok(runPrune.includes("relation_match_runs_started_idx"), `run retention:\n${runPrune}`);
  report.plans = { page: page.split("\n").length, runPrune: runPrune.split("\n")[0] };

  console.log(JSON.stringify({ ok: true, migration: migrationName, ...report }, null, 2));
} finally {
  for (const pool of pools) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
