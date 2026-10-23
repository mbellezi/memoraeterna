# PostgreSQL sidecar runbook

The desktop embeds PostgreSQL `18.4` with pgvector `0.8.4` and Apache AGE
`PG18/v1.7.0-rc0`. The Electron main process owns its complete lifecycle.

## Development installation

```bash
npm run sidecar:install:postgres
```

The installer creates local development credentials when needed, downloads the
PostgreSQL binary distribution, builds and installs pgvector and AGE, and writes
a local sidecar manifest. Development files live at:

```txt
vendor/sidecars/postgres/darwin-{arch}/postgresql-18.4/
```

The runtime resolver checks, in order:

1. `MEMORA_POSTGRES_SIDECAR_ROOT`;
2. `MEMORA_POSTGRES_BIN_DIR`;
3. packaged `resources/sidecars/postgres/<platform>/...`;
4. the development `vendor/sidecars/...` path.

## Runtime lifecycle

- Credentials are generated per installation and stored with Electron
  `safeStorage`.
- Data lives under `app.getPath("userData")/database/postgres-data`.
- PostgreSQL binds to loopback. The application tries
  `MEMORA_DATABASE_PORT`, then falls back with a warning to a free dynamic port.
- The renderer receives only validated lifecycle state through preload IPC.
- The shell remains blocked until baseline/migrations finish and status is
  `ready`.
- Shutdown waits for settings repositories, the PostgreSQL pool, and the
  sidecar process.

Development `.env` files support CLI workflows. Packaged runtime credentials do
not depend on those files. In development only, the desktop writes a mode-0600
connection descriptor under userData for local diagnostics.

## Empty-database bootstrap

For a completely empty database, the application applies
`packages/db/seed/baseline.sql`, records the covered migrations listed in
`packages/db/seed/manifest.json`, and then runs pending migrations. Existing
databases skip the baseline and run pending migrations only.

Packaged resources include both the Drizzle migrations and the baseline.

## Verified backups

The Settings backup button (`BackupService.create`) writes a dated folder with
`database.dump`, the managed Obsidian and upload folders when configured, and a
`manifest.json`. A backup is reported as done only after the dump has been
restored once.

1. The service opens a `REPEATABLE READ` transaction, exports its snapshot
   (`pg_export_snapshot()`) and counts the key tables in it: `source_items`,
   `documents`, `chunks`, `atomic_notes`, `embeddings_256/768/1024`,
   `settings` and `ai_profile_sets`.
2. `pg_dump --snapshot` dumps that same snapshot, so the counts and the dump
   agree even while ingestion keeps writing. The snapshot is released as soon as
   the dump is written.
3. `BackupVerifier.verify(dump, expectedCounts)` then checks, in order:
   - `pg_restore --list` (the shipped sidecar binary) reads the archive and
     lists TABLE DATA for every key table;
   - the volume that holds the data directory has at least twice the live
     database size free;
   - the archive restores completely (`--single-transaction --exit-on-error`)
     into `memora_verify_<UTC timestamp>` on the running sidecar;
   - the key-table counts in that scratch database equal the snapshot counts;
   - the scratch database is dropped on every path. A verification that was
     killed mid-way leaves one behind; the next verification drops any
     `memora_verify_*` database first.
4. `manifest.json` (version 2) records `verifiedAt` and the snapshot `counts`.

A failed check throws a localized error (`errors.backup.verificationFailed`, or
`errors.backup.insufficientDisk` for the disk check) and the Settings view shows
it. The folder is kept so nothing is deleted behind the user's back, but its
manifest says `"verifiedAt": null` and names the failure in
`verificationFailure`; do not restore from it. Retrying creates a new folder.

Cost to plan for: one extra restore of the library into the sidecar. A
synthetic library of 609 MB (3,000 sources, 30,000 notes with 1024-d vectors,
2,000 legacy pages) took 67 s end to end (43 s of it the restore); the disk
check required twice its size (about 1.3 GB) to be free.

Callers that need the counts before the dump (the topic switch) call
`openSnapshot()`, pass the result to `create(destination, { snapshot })`, and
release it afterwards. `create(destination, { verify: false })` skips the
verification for a caller that runs `BackupVerifier.verify` itself.

To read an old backup, restore it into a scratch cluster:

```bash
npm run db:restore -- --from <backup folder> --name <slug> --keep-running
```

## Validation

```bash
npm run sidecar:spike
```

The spike uses a temporary data directory, initializes PostgreSQL with SCRAM,
starts on a dynamic loopback port, enables `vector` and `age`, executes vector
and Cypher queries, stops and restarts the server, and cleans up the temporary
directory.

Validate migration/baseline behavior separately with:

```bash
npm run db:seed:verify
npm run db:verify
```

Current packaged artifact support is macOS arm64. Other platforms require their
own PostgreSQL/pgvector/AGE build, manifest, signing path, and equivalent smoke
validation. PostgreSQL major upgrades require an explicit data migration plan.
