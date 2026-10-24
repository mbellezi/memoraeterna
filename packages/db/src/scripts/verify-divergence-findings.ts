import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";

import {
  closePgPool,
  createPgPool,
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
 * Real-database check of migration `0065_divergence_findings` (F4 D17, D29): on a database with
 * findings of every earlier kind only the new migration runs, every row keeps its values and the
 * table keeps its columns and indexes, while the check now takes `divergence` and still refuses an
 * unknown kind; on an empty database the baseline brings the same check. It then drives the overview
 * writer: an automatic patch that adds Divergences records one high-risk finding in its
 * transaction, the owner's apply of a proposal records none, and the undo of the patch resolves it.
 * It starts its own temporary PostgreSQL sidecar and never touches an existing database.
 */
const migrationName = "0065_divergence_findings";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const workDir = await mkdtemp(join(tmpdir(), "memora-divergence-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_divergence",
  user: "memora_divergence",
  password: `divergence-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

interface Journal {
  entries: Array<{ tag: string }>;
}

/** Applies every migration before 0065 from a copy of the folder, as a profile from before it. */
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

/** The table's columns, indexes and check, as the catalog states them. */
async function shape(db: Queryable) {
  const columns = await db.query<{ line: string }>(
    `select column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as line
       from information_schema.columns where table_name = 'gardener_findings' order by column_name`
  );
  const indexes = await db.query<{ line: string }>(
    `select indexdef as line from pg_indexes where tablename = 'gardener_findings' order by indexname`
  );
  const check = await db.query<{ line: string }>(
    `select pg_get_constraintdef(c.oid) as line from pg_constraint c
      where c.conname = 'gardener_findings_values'`
  );
  return {
    columns: columns.rows.map((row) => row.line),
    indexes: indexes.rows.map((row) => row.line),
    check: check.rows[0]?.line ?? null
  };
}

/** A statement the check must refuse (SQLSTATE class 23). */
async function refused(db: PgPool, label: string, sql: string): Promise<void> {
  try {
    await db.query(sql);
  } catch (error) {
    const code = String((error as { code?: unknown }).code ?? "");
    assert.ok(code.startsWith("23"), `${label}: refused with ${code}`);
    return;
  }
  assert.fail(`${label}: the check accepted it`);
}

const overview = (
  topicId: string,
  paragraphs: string[],
  divergences: SaveTopicOverviewInput["divergences"] = []
): SaveTopicOverviewInput => ({
  topicId,
  paragraphs: paragraphs.map((text) => ({ text, citations: [] })),
  evidence: [],
  memberFingerprint: `members-${paragraphs.length}`,
  memberCount: 3,
  inputHash: `input-${paragraphs.join("|")}`,
  promptRevisionId: "topic.overview@verify",
  provider: "verify",
  model: "verify",
  runtime: "none",
  aiTaskRunId: null,
  language: "en",
  support: { status: "unchecked", unsupported: [] },
  divergences,
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

  // 1. A database with history: one finding of each earlier kind, open and closed.
  await admin.query("create database memora_divergence_history");
  const db = createPgPool({ connectionString: databaseUrl("memora_divergence_history"), max: 4 });
  pools.push(db);
  await migrateBefore(db, journal);
  await db.query(
    `insert into gardener_findings (kind, fingerprint, object_refs, params, risk, status, closed_at)
     values ('duplicate', 'dup:1', '["memora://note/00000000-0000-4000-8000-000000000001"]', '{"reason":"title"}', 'low', 'open', null),
            ('broken_link', 'link:1', '[]', '{}', 'medium', 'dismissed', now()),
            ('redirect_chain', 'chain:1', '[]', '{"hops":3}', 'low', 'resolved', now()),
            ('backlog', 'match:1', '[]', '{"task":"match","notes":4}', 'low', 'open', null),
            ('budget', 'money_80:2026-10', '[]', '{"month":"2026-10"}', 'medium', 'open', null)`
  );
  await refused(
    db,
    "divergence before 0065",
    "insert into gardener_findings (kind, fingerprint) values ('divergence', 'd:0')"
  );
  const before = await shape(db);
  const rowsBefore = await db.query("select * from gardener_findings order by kind");

  await runMigrations(db, migrationsFolder);
  const history = await db.query("select count(*)::int as count from drizzle.__drizzle_migrations");
  assert.equal(Number(history.rows[0]?.count), journal.entries.length, "history");
  const after = await shape(db);
  assert.deepEqual(after.columns, before.columns, "columns unchanged");
  assert.deepEqual(after.indexes, before.indexes, "indexes unchanged");
  assert.ok(
    after.check?.includes("'divergence'::text"),
    `the check takes divergence: ${after.check}`
  );
  assert.equal(
    after.check?.replace(", 'divergence'::text", ""),
    before.check,
    "only the kind list of the check changed"
  );
  const rowsAfter = await db.query("select * from gardener_findings order by kind");
  assert.deepEqual(rowsAfter.rows, rowsBefore.rows, "every existing row keeps its values");
  await db.query(
    "insert into gardener_findings (kind, fingerprint, risk) values ('divergence', 'divergence:probe', 'high')"
  );
  await refused(
    db,
    "an unknown kind",
    "insert into gardener_findings (kind, fingerprint) values ('guess', 'g:1')"
  );
  await db.query("delete from gardener_findings where fingerprint = 'divergence:probe'");
  report.history = { rows: rowsAfter.rowCount, migrations: Number(history.rows[0]?.count) };

  // 2. An empty database: the baseline seed carries 0065 with the same check.
  await admin.query("create database memora_divergence_empty");
  const seeded = createPgPool({ connectionString: databaseUrl("memora_divergence_empty"), max: 2 });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(seed.seed.applied && seed.seed.seededMigrations.includes(migrationName), "baseline");
  assert.deepEqual(await shape(seeded), after, "baseline and pending shapes are identical");

  // 3. The overview writer: an automatic patch records its Divergences, its undo resolves them.
  const source = await createSourceItemRepository(db).create({ type: "Book", title: "Sleep" });
  const trees = createTopicTreeRepository(db);
  const rootId = randomUUID();
  const topicId = randomUUID();
  const tree = await trees.createTree({
    id: randomUUID(),
    rootId,
    spaceKey: "verify:divergence:256",
    embeddingProvider: "verify",
    embeddingModel: "verify",
    embeddingRuntime: "none",
    dimensions: 256,
    config: {},
    configHash: "verify",
    seed: 1
  });
  await trees.bootstrapSnapshot({
    treeId: tree.id,
    expectedGeneration: tree.generation,
    titleKey: "topics.changeSets.build",
    topics: [
      topicRecord(topicId, rootId, {
        role: "topic",
        title: "Sleep",
        nameState: "named",
        nameSource: "llm",
        nameLanguage: "en"
      })
    ],
    placements: [{ item: itemKey("source", source.id), placement: placementRecord(topicId) }]
  });
  const overviews = createTopicOverviewRepository(db);
  const divergences = () =>
    db.query<{
      fingerprint: string;
      status: string;
      risk: string;
      objectRefs: string[];
      params: Record<string, unknown>;
    }>(
      `select fingerprint, status, risk, object_refs as "objectRefs", params
         from gardener_findings where kind = 'divergence' order by created_at`
    );
  await overviews.write(overview(topicId, ["Naps help."]));
  assert.equal((await divergences()).rowCount, 0, "a first write disagrees with nothing");
  // The owner applies a proposal they read, Divergence and all: nothing is sent to the Inbox.
  const proposal = await overviews.propose(
    overview(
      topicId,
      ["Naps help.", "Long naps can hurt."],
      [{ existing: "1", new: "2", summary: "Long naps leave a person groggy." }]
    )
  );
  if (proposal.kind !== "proposed") throw new Error("not proposed");
  assert.equal((await overviews.resolveProposal(proposal.id, "apply")).kind, "applied", "applied");
  assert.equal((await divergences()).rowCount, 0, "the owner's apply sends nothing to the Inbox");
  // An automatic patch keeps the stored Divergence and adds one: one finding, for the new one.
  const patched = await overviews.write(
    overview(
      topicId,
      ["Naps help.", "Long naps can hurt.", "Short ones do not."],
      [
        { existing: "1", new: "2", summary: "Long naps leave a person groggy." },
        { existing: "2", new: "3", summary: "Twenty minutes is enough." }
      ]
    )
  );
  if (patched.kind !== "written" || !patched.changeSetId) throw new Error("not written");
  const recorded = (await divergences()).rows;
  assert.deepEqual(
    recorded.map((row) => [
      row.fingerprint,
      row.status,
      row.risk,
      row.objectRefs,
      row.params.divergences,
      row.params.changeSetId
    ]),
    [
      [
        `divergence:${patched.changeSetId}`,
        "open",
        "high",
        [`memora://topic/${topicId}`],
        1,
        patched.changeSetId
      ]
    ],
    "the patch's new Divergence is one open, high-risk finding naming the topic and the patch"
  );
  // Its undo takes the text, and the Divergence with it, back: the item closes.
  assert.equal((await overviews.undoVersion(patched.changeSetId)).kind, "undone", "undone");
  assert.deepEqual(
    (await divergences()).rows.map((row) => row.status),
    ["resolved"],
    "the undo of the patch resolves its item"
  );
  // A second patch adds one again; a later write that adds none sends nothing, and blocks the
  // patch's undo, which leaves the item open.
  const again = await overviews.write(
    overview(
      topicId,
      ["Naps help.", "Long naps can hurt.", "Short ones do not."],
      [
        { existing: "1", new: "2", summary: "Long naps leave a person groggy." },
        { existing: "2", new: "3", summary: "Twenty minutes is enough." }
      ]
    )
  );
  if (again.kind !== "written" || !again.changeSetId) throw new Error("not written");
  const plain = await overviews.write(
    overview(
      topicId,
      ["Naps help.", "Long naps can hurt.", "Short ones do not.", "Light helps waking."],
      [
        { existing: "1", new: "2", summary: "Long naps leave a person groggy." },
        { existing: "2", new: "3", summary: "Twenty minutes is enough." }
      ]
    )
  );
  assert.equal(plain.kind, "written", "the plain patch is written");
  assert.deepEqual(
    (await divergences()).rows.map((row) => [row.fingerprint, row.status]),
    [
      [`divergence:${patched.changeSetId}`, "resolved"],
      [`divergence:${again.changeSetId}`, "open"]
    ],
    "one item per patch that added Divergences"
  );
  assert.equal((await overviews.undoVersion(again.changeSetId)).kind, "blocked", "blocked");
  assert.equal((await divergences()).rows[1]?.status, "open", "a blocked undo leaves the item");
  report.writer = { recorded: recorded.length };

  console.log(JSON.stringify({ ok: true, migration: migrationName, ...report }, null, 2));
} finally {
  for (const pool of pools) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
