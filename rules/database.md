# Database and persistence rules

Load this rule for Drizzle schema, migrations, repositories, SQL, PostgreSQL,
pgvector, or AGE persistence.

## Canonical storage

PostgreSQL is the canonical local store. Use stable IDs and repositories from
`@app/db`; do not spread ad hoc SQL through renderer components or application
services. Relational tables remain canonical for entities, relationships,
notes, processing history, and synchronization state. AGE and search indexes are
derived query layers.

Use transactions for multi-row invariants such as hierarchy materialization,
source-tree deletion, artifact versioning, and sync-state changes. Preserve
provenance and audit history across retries and reprocessing.

## Migration contract

Every Drizzle schema change requires a new generated migration:

```bash
npm run db:generate
```

- Never edit an already-applied migration to represent new behavior.
- In the same change, append the migration SQL to
  `packages/db/seed/baseline.sql` in journal order and add its name to
  `packages/db/seed/manifest.json` in the order from
  `packages/db/drizzle/meta/_journal.json`.
- `npm run db:seed:verify` must pass before the migration is considered ready.
- Apply the migration through the normal project flow and verify it in a real
  PostgreSQL instance. Command success alone is insufficient.
- Verify the Drizzle history plus affected columns, types, indexes, constraints,
  extensions, and migrated data through `information_schema`, catalogs, or a
  direct query. Report the verification performed.

## Empty and existing databases

- A completely empty database receives the versioned baseline, records all
  included migrations in `drizzle.__drizzle_migrations`, then runs pending
  migrations.
- A database with Drizzle history or application data never receives the
  baseline; it runs only pending migrations.
- Validate both paths when bootstrap or baseline behavior changes. The baseline
  may contain structure only; it does not replace migrations for existing data.

## PostgreSQL sidecar

- The Electron main process exclusively owns initdb, start, migration, crash
  recovery, and clean shutdown.
- Data lives under Electron `userData`, never inside the application bundle.
- Connect on loopback. Try `MEMORA_DATABASE_PORT` when valid and available,
  otherwise log a warning and select a free dynamic port.
- Generate credentials per installation, store them with Electron
  `safeStorage`, use SCRAM, and never configure TCP `trust`.
- Detect stale `postmaster.pid`, orphaned processes, and competing application
  instances. Limit connection pools, including worker-owned pools.
- A PostgreSQL major change requires an explicit dump/restore or `pg_upgrade`
  migration plan.

## Automatic-wiki persistence evolution

- Reuse wiki page/revision, organization run/checkpoint/step, canonical AI audit,
  maintenance and Obsidian registry/outbox ownership. New TOC group/membership,
  section assessment, policy, prompt, investigation and migration-journal records
  extend those boundaries; do not introduce a universal node store.
- Multi-target organization uses group receipts unique by run/group plus exact
  per-target revisions. Retain the old single-page receipt contract and readers;
  never represent a multi-page group by overwriting one legacy receipt revision.
- Knowledge impacts use one per-consumer delivery table, unique by event,
  consumer and input generation, with lease/defer state and durable receipt.
  `knowledge_impact_events.consumed_at` remains legacy data, never global proof
  that new curator/investigation consumers completed. No competing event queue
  or dispatcher checkpoint authority is introduced.
- Event creation and delivery enrollment commit with canonical input mutation.
  Upgrade reconciles retained events and current dependency state at a bounded
  high-water mark; old consumption timestamps cannot acknowledge new consumers.
  Causal run/group and visited revision fingerprints bound propagation while
  preserving real cross-page invalidation. A paused consumer defers work.
- Apply corresponding generated migrations only in the milestone implementing
  persistence; contract-only schemas and synthetic fixtures do not justify
  mutating a user's database. Upgrade tests retain historical revisions and
  conservative human protections as well as checking schema/baseline parity.

## Search and graph storage

- Vector columns and indexes have fixed dimensions. Keep 256, 768, and 1024
  dimensional embeddings in separate tables/indexes and record model, runtime,
  dimension, strategy, source, and generation.
- Text search uses the `simple` configuration with `unaccent` and `pg_trgm`;
  preserve document language for future language-specific evolution.
- AGE is a projection/query mechanism, not the source of truth. If projection or
  a graph query fails, continue without graph score. Do not implement a hidden
  relational CTE traversal fallback.
