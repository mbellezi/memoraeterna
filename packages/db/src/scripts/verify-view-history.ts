import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createChunkRepository,
  createDocumentRepository,
  createLibraryResetRepository,
  createPgPool,
  createSourceItemRepository,
  createViewHistoryRepository,
  PostgresSidecarManager,
  type PgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  viewHistoryAddress,
  viewHistoryLimits
} from "../index.js";

/**
 * Real-database check of `view_history` (migration 0047): applied as a pending migration on a
 * database with history and data, and through the baseline seed on an empty one; columns,
 * indexes and constraints; recorded opens with a count, a title snapshot and a host; pins that
 * survive the retention bound; reads that leave out objects that no longer exist; and the library
 * reset. It starts its own temporary PostgreSQL sidecar and never touches an existing database.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-view-history-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_view_history",
  user: "memora_view_history",
  password: `view-history-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");

const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  const tags: string[] = journal.entries.map((entry: { tag: string }) => entry.tag);
  const tag = tags.find((name) => name.endsWith("_view_history"));
  assert.ok(tag, "the view history migration is in the journal");
  const index = tags.indexOf(tag);
  const historyCount = async (db: PgPool) =>
    Number(
      (
        await db.query<{ count: string }>(
          "select count(*)::text as count from drizzle.__drizzle_migrations"
        )
      ).rows[0]?.count
    );
  /** A copy of the migrations whose journal stops before `before`, to apply a database in steps. */
  const migrationsBefore = async (before: number, name: string) => {
    const folder = join(workDir, name);
    await cp(migrationsFolder, folder, { recursive: true });
    await writeFile(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, before) })
    );
    return folder;
  };

  // 1. Pending path: a database migrated up to the migration before it, with a source, gets it.
  const db = createPgPool({ connectionString: connection.connectionString, max: 3 });
  pools.push(db);
  await runMigrations(db, await migrationsBefore(index, "drizzle-before-view-history"));
  assert.equal(await historyCount(db), index, "history before the view history migration");
  const sources = createSourceItemRepository(db);
  const source = await sources.create({ type: "StandaloneArticle", title: "Kept source" });
  await runMigrations(db, migrationsFolder);
  assert.equal(await historyCount(db), tags.length, "applied as a pending migration");
  assert.equal(
    (await db.query("select 1 from source_items where id = $1", [source.id])).rowCount,
    1,
    "existing data survives"
  );

  // 2. Baseline path: an empty database is seeded with every migration, this one included.
  const seededName = "memora_view_history_seed";
  await db.query(`create database ${seededName}`);
  const seededUrl = new URL(connection.connectionString);
  seededUrl.pathname = `/${seededName}`;
  const seeded = createPgPool({ connectionString: seededUrl.toString(), max: 2 });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(seed.seed.applied && seed.seed.seededMigrations.includes(tag), "baseline holds it");
  assert.equal(await historyCount(seeded), tags.length, "seeded history");

  // 3. Shape: columns, types, indexes and constraints are identical on both paths.
  const shape = async (pool: PgPool) => ({
    columns: (
      await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `select column_name, data_type, is_nullable from information_schema.columns
         where table_name = 'view_history'`
      )
    ).rows
      .map((row) => `${row.column_name}:${row.data_type}:${row.is_nullable}`)
      .sort(),
    indexes: (
      await pool.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where tablename = 'view_history'"
      )
    ).rows
      .map((row) => row.indexdef)
      .sort(),
    constraints: (
      await pool.query<{ conname: string; contype: string }>(
        `select conname, contype from pg_constraint
         where conrelid = 'view_history'::regclass and contype in ('c', 'f', 'p', 'u')`
      )
    ).rows
      .map((row) => `${row.conname}:${row.contype}`)
      .sort()
  });
  const migrated = await shape(db);
  assert.deepEqual(await shape(seeded), migrated, "baseline and pending paths agree");
  assert.deepEqual(
    migrated.columns,
    [
      "address:text:NO",
      "id:uuid:NO",
      "kind:text:NO",
      "object_id:uuid:NO",
      "open_count:integer:NO",
      "opened_at:timestamp with time zone:NO",
      "parent_address:text:YES",
      "pinned:boolean:NO",
      "pinned_at:timestamp with time zone:YES",
      "title:text:NO"
    ],
    "columns"
  );
  assert.deepEqual(
    migrated.constraints,
    [
      "view_history_address:c",
      "view_history_kind:c",
      "view_history_open_count:c",
      "view_history_parent:c",
      "view_history_pin:c",
      "view_history_pkey:p",
      "view_history_title:c"
    ],
    "constraints; no foreign keys: a vanished object never blocks a delete"
  );
  assert.equal(migrated.indexes.length, 3, "primary key, unique address and the read order");
  assert.ok(
    migrated.indexes.some((def) => def.includes("UNIQUE INDEX view_history_address_uidx")),
    "unique address"
  );
  assert.ok(
    migrated.indexes.some((def) => def.includes("(pinned, opened_at)")),
    "read order index"
  );

  // 4. Behavior.
  const history = createViewHistoryRepository(db);
  const second = await sources.create({ type: "StandaloneArticle", title: "Second source" });
  const entities = (id: string, name: string) =>
    db.query(
      `insert into entities (id, type, canonical_name, normalized_name, confidence)
       values ($1, 'concept', $2, $2, 1)`,
      [id, name]
    );
  const entityId = randomUUID();
  await entities(entityId, "An entity");

  const first = await history.record({
    kind: "source",
    objectId: source.id,
    title: "  Kept\nsource "
  });
  assert.deepEqual(
    [first.address, first.title, first.openCount, first.pinned],
    [viewHistoryAddress("source", source.id), "Kept source", 1, false],
    "first open"
  );
  const again = await history.record({
    kind: "source",
    objectId: source.id,
    title: "Renamed source"
  });
  assert.deepEqual([again.title, again.openCount], ["Renamed source", 2], "reopen");
  assert.ok(again.openedAt >= first.openedAt, "reopen is the latest");
  assert.equal(
    (await db.query("select count(*)::int as count from view_history")).rows[0]?.count,
    1,
    "one row per address"
  );

  await history.record({ kind: "source", objectId: second.id, title: "Second source" });
  await history.record({ kind: "entity", objectId: entityId, title: "An entity" });
  const listed = await history.list();
  assert.deepEqual(
    listed.map((entry) => entry.kind),
    ["entity", "source", "source"],
    "most recent first"
  );
  assert.deepEqual(
    (await history.list({ kinds: ["source"] })).map((entry) => entry.objectId),
    [second.id, source.id],
    "kind filter"
  );
  assert.equal((await history.list({ limit: 1 })).length, 1, "page bound");

  // A note records the source that hosted it and is left out once it no longer exists.
  const content = "Retrieval practice improves long-term retention.";
  const document = await createDocumentRepository(db).create({
    sourceItemId: source.id,
    title: source.title,
    canonicalMarkdown: content,
    contentHash: content
  });
  const chunkId = randomUUID();
  const spanId = randomUUID();
  await createChunkRepository(db).replaceDocumentChunks(document.id, source.id, [
    {
      id: chunkId,
      sourceSpanId: spanId,
      chunkIndex: 0,
      content,
      contentHash: content,
      span: { id: spanId, startOffset: 0, endOffset: content.length }
    }
  ]);
  const noteId = randomUUID();
  await db.query(
    `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
       evidence_chunk_id, generation_provider, generation_model, generation_runtime,
       generation_prompt_version, generation_key)
     values ($1::uuid, 'A note', 'A note', 'A note', $2, $3, 'verify', 'verify', 'local', 'verify',
       $1::uuid::text)`,
    [noteId, source.id, chunkId]
  );
  const hostAddress = viewHistoryAddress("source", source.id);
  const note = await history.record({
    kind: "note",
    objectId: noteId,
    title: "A note",
    parentAddress: hostAddress
  });
  assert.equal(note.parentAddress, hostAddress, "a note records its host");
  const reopened = await history.record({ kind: "note", objectId: noteId, title: "A note" });
  assert.equal(reopened.parentAddress, hostAddress, "a reopen without a host keeps the known one");
  assert.ok(
    (await history.list()).some((entry) => entry.kind === "note"),
    "an existing note is listed"
  );
  await db.query("delete from atomic_notes where id = $1", [noteId]);
  assert.ok(
    !(await history.list()).some((entry) => entry.kind === "note"),
    "a deleted note is left out"
  );

  // Pins come first, survive the retention bound and can be removed again.
  const pinned = await history.setPinned(viewHistoryAddress("source", source.id), true);
  assert.equal(pinned?.pinned, true, "pinned");
  assert.equal(
    (await history.list())[0]?.address,
    viewHistoryAddress("source", source.id),
    "pinned entries first"
  );
  assert.equal(await history.setPinned(viewHistoryAddress("source", randomUUID()), true), null);
  await assert.rejects(
    db.query("update view_history set pinned = true, pinned_at = null where kind = 'entity'"),
    /view_history_pin/,
    "a pin has a time"
  );

  // Retention: unpinned entries are bounded, pins are not counted.
  await db.query("delete from view_history where pinned = false");
  const topics = Array.from({ length: viewHistoryLimits.unpinnedEntries + 25 }, () => randomUUID());
  await db.query(
    `insert into view_history (kind, object_id, address, title, opened_at)
     select 'topic', t, 'memora://topic/' || t, 'Topic ' || n, now() - make_interval(secs => n)
     from unnest($1::uuid[]) with ordinality as x(t, n)`,
    [topics]
  );
  await history.record({ kind: "topic", objectId: randomUUID(), title: "Newest topic" });
  const counts = (
    await db.query<{ pinned: boolean; count: number }>(
      "select pinned, count(*)::int as count from view_history group by pinned order by pinned"
    )
  ).rows;
  assert.deepEqual(
    counts.map((row) => [row.pinned, row.count]),
    [
      [false, viewHistoryLimits.unpinnedEntries],
      [true, 1]
    ],
    "unpinned entries are bounded and the pin is kept"
  );
  const kept = await db.query<{ title: string }>(
    "select title from view_history where kind = 'topic' order by opened_at desc limit 1"
  );
  assert.equal(kept.rows[0]?.title, "Newest topic", "the newest entry is kept");
  assert.equal(
    (await db.query("select 1 from view_history where title = $1", [`Topic ${topics.length}`]))
      .rowCount,
    0,
    "the oldest entries are dropped"
  );

  // The objects that no longer exist are left out of a read.
  await db.query("delete from entities where id = $1", [entityId]);
  assert.ok(!(await history.list({ kinds: ["entity"] })).length, "a deleted entity is left out");
  await db.query("delete from source_items where id = $1", [second.id]);
  assert.ok(
    !(await history.list({ limit: 50 })).some((entry) => entry.objectId === second.id),
    "a deleted source is left out"
  );

  // Constraints refuse a row whose address does not match its kind and ID.
  const invalid = async (label: string, sql: string, values: unknown[]) =>
    assert.rejects(db.query(sql, values), /check constraint/, label);
  const insert = `insert into view_history (kind, object_id, address, title, open_count, parent_address)
    values ($1, $2, $3, $4, $5, $6)`;
  const id = randomUUID();
  await invalid("kind list", insert, ["page", id, `memora://page/${id}`, "t", 1, null]);
  await invalid("address matches kind and id", insert, [
    "topic",
    id,
    `memora://topic/${randomUUID()}`,
    "t",
    1,
    null
  ]);
  await invalid("empty title", insert, ["topic", id, `memora://topic/${id}`, "", 1, null]);
  await invalid("long title", insert, [
    "topic",
    id,
    `memora://topic/${id}`,
    "x".repeat(301),
    1,
    null
  ]);
  await invalid("open count", insert, ["topic", id, `memora://topic/${id}`, "t", 0, null]);
  await invalid("parent address", insert, [
    "topic",
    id,
    `memora://topic/${id}`,
    "t",
    1,
    "https://x"
  ]);

  // Clear keeps the pins.
  assert.ok((await history.clear()) > 0, "cleared unpinned entries");
  assert.deepEqual(
    (await history.list()).map((entry) => entry.pinned),
    [true],
    "pins stay"
  );
  await db.query("delete from view_history");
  assert.equal((await history.list()).length, 0);

  // 5. The library reset clears the view history with every other cleared table.
  await history.record({ kind: "source", objectId: source.id, title: "Kept source" });
  await history.setPinned(viewHistoryAddress("source", source.id), true);
  await createLibraryResetRepository(db).reset();
  assert.equal(
    (await db.query("select count(*)::int as count from view_history")).rows[0]?.count,
    0,
    "the library reset clears the view history"
  );

  console.info(
    JSON.stringify({
      verified: [
        "applied as a pending migration on a database with history and data",
        "applied through the baseline seed on an empty database",
        "identical columns, types, nullability, indexes and constraints on both paths",
        "one row per address; reopening refreshes the title snapshot and grows the count",
        "recents list newest first with pins on top; kind filter and page bound",
        "objects that no longer exist (source, entity, note) are left out of a read",
        "unpinned entries are bounded to the retention limit and pins are kept",
        "constraints refuse a wrong kind, address, title, count, pin or parent",
        "clear keeps the pins; the library reset clears the table"
      ],
      migrations: tags.length
    })
  );
} finally {
  for (const pool of pools.reverse()) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
