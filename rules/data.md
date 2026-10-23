# Data and persistence

Load for Drizzle schema, migrations, repositories, SQL, the PostgreSQL sidecar,
pgvector, AGE, projection views, provenance storage or data wipes.

## Canonical storage

- PostgreSQL is the canonical store for sources, documents, chunks, notes,
  relations, topics, processing history and synchronization state. pgvector
  indexes, AGE graphs, search indexes and read-only projection views are derived
  query layers.
- Read-only projection views (for example `knowledge_objects`,
  `knowledge_links`) may unify objects for reading; canonical tables stay
  authoritative and the views never become a write path.
- All SQL lives in `@app/db` repositories. Renderer components and services do
  not issue ad hoc SQL.
- Use transactions for multi-row invariants (hierarchy changes, deletions,
  artifact replacement, sync state). Never wait for model inference inside a
  database transaction.
- Optimistic revisions (expected `updatedAt` or revision IDs) guard concurrent
  edits; stale editors cannot overwrite newer content.

## Identity and provenance

- Every object has a stable UUID that survives reprocessing, renaming, moving
  and projection. Titles, URIs, paths and filenames are never identity.
- Retired IDs are never reused. A merged or retired topic becomes a redirect to
  its successor.
- Chunks link to their source item, document revision and SourceSpan.
  SourceSpans keep Markdown offsets and, when available, page, block ID,
  bounding box and selector.
- Derived artifacts (summaries, notes, relations, topic prose, entities) record
  the exact source revisions, chunks and evidence they came from, plus the
  model, prompt and input hashes that produced them.
- Editing a source creates a new document revision; earlier documents, chunks,
  spans and the notes attached to them stay addressable. Current-content queries
  exclude superseded documents.
- Deleting a source is an explicit, transactional action. Historical evidence
  snapshots of surviving derived knowledge stay readable and are marked
  unavailable; they never become current evidence again.
- Human edits are stored as revisions with before/after snapshots and mark the
  object protected.

## Migrations

- Every schema change gets a new generated migration (`npm run db:generate`).
  Never edit an applied migration.
- In the same change, append the migration SQL to `packages/db/seed/baseline.sql`
  in journal order and add its name to `packages/db/seed/manifest.json`;
  `npm run db:seed:verify` must pass.
- An empty database receives the baseline, records its migrations, then runs
  pending ones. A database with history or data only runs pending migrations.
- Apply and verify every migration on a real PostgreSQL instance: history,
  columns, types, indexes, constraints and migrated data. Report what was
  verified; command success alone is not verification.
- Take a verified backup (restored into a scratch database with matching key-table counts) before any
  destructive migration or data wipe.
- A migration that drops tables or columns is verified on rows in them: no kept table references a
  dropped one (`CASCADE` would drop the reference silently), and the row counts and definitions of
  every kept table are equal before and after.

## PostgreSQL sidecar

- The main process exclusively owns initdb, start, migration, crash recovery and
  shutdown. Data lives under Electron `userData`, never in the app bundle.
- Connect on loopback only. Credentials are generated per installation, stored
  with `safeStorage`, use SCRAM, and TCP `trust` is never configured.
- Detect stale `postmaster.pid`, orphaned processes and competing instances.
  Bound every connection pool, including worker-owned pools.
- A PostgreSQL major upgrade requires an explicit dump/restore or `pg_upgrade`
  plan.

## Vectors, text search and graph

- Embeddings of different dimensions live in separate tables and indexes. Each
  vector records provider, model, runtime, revision, dimensions and embedding
  strategy. Vectors from different spaces are never compared; rows without a
  provable identity are not guessed compatible.
- Text search normalizes accents and case and records the content language;
  indexes must be usable by the queries that rely on them (verify with EXPLAIN).
- AGE is a projection. Commit canonical SQL first; a projection or graph-query
  failure returns no graph signal and never rolls back canonical data. There is
  no hidden relational fallback for AGE traversal.
