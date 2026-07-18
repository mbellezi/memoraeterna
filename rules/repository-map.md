# Repository map

Load this rule only for codebase navigation, ownership decisions, structural
changes, or script discovery. Keep it structural; do not add implementation
history or completed plans.

## Root layout

```txt
apps/
  desktop/             Electron application and local backend
  chrome-extension/    Manifest V3 capture client
  obsidian-plugin/     Obsidian desktop integration
packages/
  ai/                  AI contracts, adapters, registry, local models
  conversion/          Conversion, structure detection, normalization, chunks
  db/                  PostgreSQL schema, migrations, seed, repositories
  domain/              Canonical types and Zod schemas
  i18n/                Shared product messages and translation helpers
  integration-contracts/  Versioned external-client protocol
native/
  mlx-helper/          Swift MLX runtime helper
scripts/               Setup, native runtime, verification, and packaging tools
docs/                  Operational runbooks for developers
rules/                 Normative domain specifications and routing index
```

## Desktop entry points

- `apps/desktop/src/main/index.ts`: Electron lifecycle and service startup.
- `apps/desktop/src/main/ipc.ts`: main-process IPC handlers.
- `apps/desktop/src/shared/ipc.ts`: shared IPC channels and Zod contracts.
- `apps/desktop/src/preload/index.ts`: safe `window.app` bridge.
- `apps/desktop/src/renderer/App.tsx`: application shell and navigation.
- `apps/desktop/src/main/services/`: application services for database, jobs,
  ingestion, AI, search, knowledge, integrations, storage, backup, and sync.
- `apps/desktop/src/main/workers/`: worker entry points and worker contracts.
- `apps/desktop/src/renderer/components/`: product screens and vendored UI
  components.

## Package entry points

- `packages/domain/src/source-item.ts` and `source-descriptor.ts`: source
  taxonomy and typed ingestion descriptors.
- `packages/domain/src/hierarchical-ingestion.ts`: document divisions,
  processing stages, presets, scopes, and plan resolution.
- `packages/integration-contracts/src/index.ts`: gateway protocol.
- `packages/db/src/schema.ts`: Drizzle schema.
- `packages/db/drizzle/`: append-only generated migrations.
- `packages/db/seed/baseline.sql` and `seed/manifest.json`: empty-database
  baseline and covered migration list.
- `packages/db/src/repositories/`: persistence and query boundaries.
- `packages/ai/src/`: remote/local adapters, parameters, registry, catalog, and
  downloader.
- `packages/conversion/src/`: router, native converters, Docling client,
  metadata extraction, structure detection, normalization, and chunking.
- `packages/i18n/src/locales/`: all product copy for supported locales.

## Primary commands

```bash
npm run typecheck
npm test
npm run build
npm run format:check

npm run db:generate
npm run db:seed:verify
npm run db:migrate
npm run db:verify

npm run sidecar:spike
npm run docling:verify
npm run docling:smoke
npm run mlx:smoke
npm run package:desktop:dir
npm run package:desktop:smoke
```

Use `README.md` and `docs/` for setup and command prerequisites.

## Generated and local-only content

Do not treat `.env`, `node_modules/`, `dist/`, `out/`, `release/`, `coverage/`,
`.cache/`, `vendor/sidecars/`, `apps/desktop/build-resources/`, Swift `.build/`,
or `*.tsbuildinfo` as source. Real calibration corpora and caches under
`samples/` are local and ignored; generalizable cases belong in synthetic,
versioned fixtures.
