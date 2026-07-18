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
