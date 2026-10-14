import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAtomicNoteRepository,
  createChunkRepository,
  createDocumentRepository,
  createKnowledgeGraphRepository,
  createPgPool,
  createSourceItemRepository,
  PostgresSidecarManager,
  type PgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "../index.js";

/**
 * Real-database check of decision 13 (migration 0045): generated notes are active at birth. The
 * migration is applied as a pending migration on a database with history and notes in every state,
 * and through the baseline seed on an empty one; the rebuilt enum, default, index and triggers; the
 * conversion of unreviewed generated notes only; and the repository behavior built on it (active
 * at birth, review queue, regeneration guard, one queued re-embedding job per edited note). It
 * starts its own temporary PostgreSQL sidecar and never touches an existing database.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-notes-active-db-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_notes_active",
  user: "memora_notes_active",
  password: `notes-active-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");
const tag = "0045_notes_active_at_birth";

const pools: PgPool[] = [];
try {
  const connection = await manager.start();
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8"));
  assert.equal(journal.entries.at(-1)?.tag, tag, "0045 is the newest migration");
  const historyCount = async (db: PgPool) =>
    Number(
      (
        await db.query<{ count: string }>(
          "select count(*)::text as count from drizzle.__drizzle_migrations"
        )
      ).rows[0]?.count
    );

  // 1. Pending path: a database migrated to 0044, with notes in every state, gets only 0045.
  const db = createPgPool({ connectionString: connection.connectionString, max: 3 });
  pools.push(db);
  const previousFolder = join(workDir, "drizzle-0044");
  await cp(migrationsFolder, previousFolder, { recursive: true });
  await writeFile(
    join(previousFolder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, -1) })
  );
  await runMigrations(db, previousFolder);
  assert.equal(await historyCount(db), journal.entries.length - 1, "history before 0045");

  const source = await createSourceItemRepository(db).create({
    type: "StandaloneArticle",
    title: "Notes active at birth"
  });
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
  const states = {
    generated: { status: "pending_review", metadata: {} },
    protectedEdit: { status: "pending_review", metadata: { humanProtected: true } },
    auditedEdit: { status: "pending_review", metadata: {} },
    approved: { status: "approved", metadata: {} },
    rejected: { status: "rejected", metadata: {} },
    archived: { status: "archived", metadata: {} }
  } as const;
  const noteIds: Record<keyof typeof states, string> = {} as never;
  for (const [name, state] of Object.entries(states)) {
    const id = randomUUID();
    noteIds[name as keyof typeof states] = id;
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, metadata,
         created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
         generation_runtime, generation_prompt_version, generation_key, updated_at)
       values ($1::uuid, $2, $2, $2, $3::atomic_note_status, $4, $5, $6, 'verify', 'verify',
         'local', 'verify', $1::uuid::text, '2026-01-02T03:04:05.678Z')`,
      [id, name, state.status, state.metadata, source.id, chunkId]
    );
  }
  await db.query(
    `insert into atomic_note_review_events (atomic_note_id, action, previous_status, next_status)
     values ($1, 'edit', 'pending_review', 'pending_review'),
            ($2, 'approve', 'pending_review', 'approved')`,
    [noteIds.auditedEdit, noteIds.approved]
  );
  const impactsBefore = Number(
    (await db.query("select count(*)::int as count from knowledge_impact_events")).rows[0]?.count
  );

  await runMigrations(db, migrationsFolder);
  assert.equal(await historyCount(db), journal.entries.length, "0045 applied as pending");
  const statuses = async (pool: PgPool) =>
    Object.fromEntries(
      (
        await pool.query<{ id: string; status: string; updated: string }>(
          "select id, status::text, updated_at::text as updated from atomic_notes"
        )
      ).rows.map((row) => [row.id, row.status])
    );
  const after = await statuses(db);
  assert.deepEqual(
    Object.fromEntries(Object.entries(noteIds).map(([name, id]) => [name, after[id]])),
    {
      generated: "active",
      protectedEdit: "pending_review",
      auditedEdit: "pending_review",
      approved: "approved",
      rejected: "rejected",
      archived: "archived"
    },
    "only unreviewed generated notes become active"
  );
  assert.equal(
    (
      await db.query<{ same: boolean }>(
        "select updated_at = '2026-01-02T03:04:05.678Z' as same from atomic_notes where id = $1",
        [noteIds.generated]
      )
    ).rows[0]?.same,
    true,
    "the relabeling does not move updated_at"
  );
  assert.equal(
    Number(
      (await db.query("select count(*)::int as count from knowledge_impact_events")).rows[0]?.count
    ),
    impactsBefore,
    "the relabeling records no wiki impact"
  );

  // 2. Baseline path: an empty database is seeded with every migration, 0045 included.
  const seededName = "memora_notes_active_seed";
  await db.query(`create database ${seededName}`);
  const seededUrl = new URL(connection.connectionString);
  seededUrl.pathname = `/${seededName}`;
  const seeded = createPgPool({ connectionString: seededUrl.toString(), max: 2 });
  pools.push(seeded);
  const seed = await runMigrations(seeded, migrationsFolder, { seedFolder });
  assert.ok(seed.seed.applied && seed.seed.seededMigrations.includes(tag), "baseline holds 0045");
  assert.equal(await historyCount(seeded), journal.entries.length, "seeded history");

  // 3. Shape: the enum, the default, the index, the triggers and the review-event columns are
  // identical on both paths.
  const shape = async (pool: PgPool) => ({
    enumValues: (
      await pool.query<{ value: string }>(
        "select unnest(enum_range(null::atomic_note_status))::text as value"
      )
    ).rows.map((row) => row.value),
    leftoverTypes: Number(
      (
        await pool.query(
          "select count(*)::int as count from pg_type where typname = 'atomic_note_status_old'"
        )
      ).rows[0]?.count
    ),
    columns: (
      await pool.query<{ table_name: string; column_name: string; udt_name: string; d: string }>(
        `select table_name, column_name, udt_name, coalesce(column_default, '') as d
           from information_schema.columns
          where udt_name = 'atomic_note_status' order by table_name, column_name`
      )
    ).rows.map((row) => `${row.table_name}.${row.column_name}:${row.udt_name}:${row.d}`),
    index: (
      await pool.query<{ indexdef: string }>(
        "select indexdef from pg_indexes where indexname = 'atomic_notes_status_idx'"
      )
    ).rows.map((row) => row.indexdef),
    triggers: (
      await pool.query<{ tgname: string; tgenabled: string }>(
        `select tgname, tgenabled from pg_trigger
          where tgrelid = 'atomic_notes'::regclass and not tgisinternal order by tgname`
      )
    ).rows.map((row) => `${row.tgname}:${row.tgenabled}`)
  });
  const migrated = await shape(db);
  assert.deepEqual(await shape(seeded), migrated, "baseline and pending paths agree");
  assert.deepEqual(migrated.enumValues, [
    "active",
    "pending_review",
    "approved",
    "rejected",
    "archived"
  ]);
  assert.equal(migrated.leftoverTypes, 0, "the old type is dropped");
  assert.deepEqual(migrated.columns, [
    "atomic_note_review_events.next_status:atomic_note_status:",
    "atomic_note_review_events.previous_status:atomic_note_status:",
    "atomic_notes.status:atomic_note_status:'active'::atomic_note_status"
  ]);
  assert.equal(migrated.index.length, 1, "the status index is rebuilt");
  assert.ok(
    migrated.triggers.length > 0 && migrated.triggers.every((trigger) => trigger.endsWith(":O")),
    "every note trigger is enabled again"
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from atomic_note_review_events where previous_status = 'pending_review'"
      )
    ).rows[0]?.count,
    2,
    "the audit keeps its statuses"
  );

  // 4. Behavior on the migrated database.
  const notes = createAtomicNoteRepository(db);
  const generated = await notes.upsertGenerated({
    title: "Born active",
    bodyMarkdown: "Retrieval practice improves retention.",
    ideaStatement: "Retrieval practice improves retention.",
    sourceItemId: source.id,
    evidenceChunkId: chunkId,
    evidenceLinks: [{ chunkId }],
    generationProvider: "verify",
    generationModel: "verify",
    generationRuntime: "local",
    generationPromptVersion: "verify",
    generationKey: "born-active"
  });
  assert.equal(generated.status, "active", "a generated note is active at birth");
  const queue = async () =>
    (
      await db.query<{ status: string; payload: Record<string, unknown>; priority: number }>(
        `select status::text, payload, priority from jobs
          where type = 'note-embedding' and payload->>'atomicNoteId' = $1 order by created_at`,
        [generated.id]
      )
    ).rows;
  assert.deepEqual(await queue(), [], "generating a note queues no re-embedding");
  const listed = (await notes.listPending(500)).map((note) => note.id);
  assert.ok(listed.includes(generated.id) && listed.includes(noteIds.generated), "queue: active");
  assert.ok(listed.includes(noteIds.protectedEdit), "queue: legacy pending");
  assert.ok(
    ![noteIds.approved, noteIds.rejected, noteIds.archived].some((id) => listed.includes(id)),
    "queue: reviewed notes are not offered again"
  );

  // Regeneration refreshes an unreviewed note and leaves an edited one alone.
  const regenerated = await notes.upsertGenerated({
    title: "Born active, regenerated",
    bodyMarkdown: "Retrieval practice improves retention, again.",
    ideaStatement: "Retrieval practice improves retention.",
    sourceItemId: source.id,
    evidenceChunkId: chunkId,
    generationId: (
      await db.query<{ generation_id: string }>(
        "select generation_id from atomic_notes where id = $1",
        [generated.id]
      )
    ).rows[0]!.generation_id,
    evidenceLinks: [{ chunkId }],
    generationProvider: "verify",
    generationModel: "verify",
    generationRuntime: "local",
    generationPromptVersion: "verify",
    generationKey: "born-active"
  });
  assert.equal(regenerated.id, generated.id);
  assert.equal(regenerated.title, "Born active, regenerated", "an active note is regenerated");

  // A human edit deletes the stale vector and queues one background job, however many edits.
  await db.query(
    `insert into embeddings_1024 (target_type, target_id, provider, model, runtime, content_hash, embedding)
     values ('atomic_note', $1, 'verify', 'verify', 'local', 'stale', array_fill(0.1::real, array[1024])::vector)`,
    [generated.id]
  );
  const edited = await notes.review({ id: generated.id, action: "edit", title: "Edited by hand" });
  assert.equal(edited?.status, "active", "an edit keeps the status and protects the note");
  assert.equal(
    (
      await db.query("select count(*)::int as count from embeddings_1024 where target_id = $1", [
        generated.id
      ])
    ).rows[0]?.count,
    0,
    "the edit invalidates the embedding"
  );
  assert.deepEqual(
    (await queue()).map((job) => [job.status, job.payload.sourceItemId, job.priority]),
    [["queued", source.id, 10]],
    "one queued job"
  );
  await notes.review({ id: generated.id, action: "edit", bodyMarkdown: "Edited again." });
  assert.equal((await queue()).length, 1, "a second edit before the job runs queues nothing");
  await db.query(
    "update jobs set status = 'running' where type = 'note-embedding' and payload->>'atomicNoteId' = $1",
    [generated.id]
  );
  await notes.review({ id: generated.id, action: "edit", bodyMarkdown: "Edited a third time." });
  assert.deepEqual(
    (await queue()).map((job) => job.status),
    ["running", "queued"],
    "an edit during a running job queues a new one, which re-reads the note"
  );
  await notes.review({ id: generated.id, action: "approve" });
  assert.equal((await queue()).length, 2, "approving queues nothing");
  const discarded = await notes.review({ id: noteIds.generated, action: "discard" });
  assert.equal(discarded?.status, "rejected");
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from jobs where payload->>'atomicNoteId' = $1",
        [noteIds.generated]
      )
    ).rows[0]?.count,
    0,
    "discarding queues nothing"
  );
  const rejectedEdit = await notes.review({
    id: noteIds.rejected,
    action: "edit",
    title: "Edited after rejection"
  });
  assert.equal(rejectedEdit?.status, "rejected");
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from jobs where payload->>'atomicNoteId' = $1",
        [noteIds.rejected]
      )
    ).rows[0]?.count,
    0,
    "a discarded note is not re-embedded"
  );

  // Active notes take part in matching next to the legacy and reviewed ones; discarded ones do not.
  const stillActive = await notes.upsertGenerated({
    title: "Another active note",
    bodyMarkdown: "Retrieval practice improves retention.",
    ideaStatement: "Retrieval practice improves retention.",
    sourceItemId: source.id,
    evidenceChunkId: chunkId,
    evidenceLinks: [{ chunkId }],
    generationProvider: "verify",
    generationModel: "verify",
    generationRuntime: "local",
    generationPromptVersion: "verify",
    generationKey: "another-active"
  });
  assert.equal(stillActive.status, "active");
  const candidateIds = async (noteId: string) =>
    (await notes.findTextMatchingCandidates({ noteId, limit: 50 })).map(
      (candidate) => candidate.note.id
    );
  const fromApproved = await candidateIds(noteIds.approved);
  assert.ok(fromApproved.includes(stillActive.id), "an active note is a matching candidate");
  const fromActive = await candidateIds(stillActive.id);
  assert.ok(
    [noteIds.protectedEdit, noteIds.auditedEdit, noteIds.approved].every((id) =>
      fromActive.includes(id)
    ),
    "an active note is matched against pending and approved notes"
  );
  assert.ok(
    !fromActive.includes(noteIds.rejected) && !fromActive.includes(noteIds.generated),
    "discarded notes are not candidates"
  );

  // 5. Claims are no longer extracted: persisting a graph writes none and leaves stored ones alone.
  await db.query(
    `insert into claims (source_item_id, evidence_chunk_id, text, content_hash, confidence)
     values ($1, $2, 'A claim extracted before they were dropped.', 'legacy-claim', 0.9)`,
    [source.id, chunkId]
  );
  const claimCount = async () =>
    Number(
      (
        await db.query("select count(*)::int as count from claims where source_item_id = $1", [
          source.id
        ])
      ).rows[0]?.count
    );
  const persisted = await createKnowledgeGraphRepository(db).replaceSourceExtraction({
    sourceItemId: source.id,
    language: "en",
    generation: { provider: "verify", promptVersion: "knowledge-graph-v8" },
    batches: [
      {
        entities: ["retrieval", "retention"].map((key) => ({
          key,
          type: "Concept",
          canonicalName: key,
          aliases: [],
          confidence: 0.9,
          evidenceChunkIds: [chunkId]
        })),
        relations: [
          {
            subjectEntityKey: "retrieval",
            predicate: "improves",
            objectEntityKey: "retention",
            confidence: 0.9,
            evidenceChunkIds: [chunkId]
          }
        ]
      }
    ]
  });
  assert.deepEqual(
    [persisted.entityCount, persisted.relationCount, "claimCount" in persisted],
    [2, 1, false],
    "entities and relations are stored, claims are not even counted"
  );
  assert.equal(await claimCount(), 1, "the stored claim is neither replaced nor removed");

  console.info(
    JSON.stringify({
      verified: [
        "0045 applied as a pending migration on a database with history and notes in every state",
        "0045 applied through the baseline seed on an empty database",
        "identical enum, default, status index, triggers and review-event columns on both paths",
        "only unreviewed generated notes became active; protected, audited, approved, rejected and archived notes kept their status and updated_at; no wiki impact recorded",
        "generated notes are active at birth; the review queue offers active and pending notes",
        "an edit invalidates the embedding and queues one deduplicated note-embedding job; approve and discard queue none",
        "active notes are matching candidates next to pending and approved ones; discarded notes are not",
        "graph persistence stores entities and relations, writes no claim and leaves stored claims untouched"
      ],
      migrations: journal.entries.length
    })
  );
} finally {
  for (const pool of pools.reverse()) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}
