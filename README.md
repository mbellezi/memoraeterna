# Memora Eterna

Memora Eterna is a local-first desktop application for organizing sources,
documents, notes, evidence, and long-term knowledge. The Electron desktop owns
the embedded PostgreSQL database, ingestion/indexing pipeline, AI runtimes, and
the local integrations used by Chrome and Obsidian.

## Current capabilities

- **Source intake and editing:** import files, paste or compose Markdown, and
  preview supported web and YouTube URLs before import. Typed descriptors,
  duplicate review, provenance-aware metadata, and document revision history
  preserve the identity and evidence of every source.
- **Catalogs and hierarchy:** enrich books through Open Library or Google Books
  and academic papers through Crossref. Books, periodical issues, and papers can
  be organized into processable chapters, articles, or sections with canonical
  breadcrumbs and independently editable children.
- **Auditable AI processing:** choose only the stages needed for a source or
  batch—chunking, embeddings, summaries, atomic notes, matching, and knowledge
  graph extraction. Runs are checkpointed, resumable, and trace their model,
  profile, parameters, evidence, token usage, and estimated cost when available.
- **Local and remote models:** configure task-specific profiles for Gemini,
  OpenAI-compatible APIs, ChatGPT/Codex OAuth, GGUF models, and MLX models on
  Apple Silicon. Local embedding models can remain loaded between jobs to make
  repeated semantic searches faster.
- **Search and discovery:** Library search fuses catalog text matches with
  source-level semantic similarity and identifies whether text, vectors, or both
  produced a result. Search also surfaces matching knowledge-graph entities and
  relations with links back to source evidence.
- **Interactive knowledge graph:** explore global source or atomic-note views
  with community-aware ForceAtlas2 layout, zoom-dependent detail, node and edge
  previews, and connection panels that group shared entities and relations.
  Opening a source or atomic note and returning restores the graph view when its
  data has not changed.
- **Review and integrations:** generated atomic notes enter a review queue.
  Chrome capture, YouTube metadata and transcripts, and bidirectional Obsidian
  synchronization connect through the local integration gateway.
- **Operational safety:** credentials use the desktop encrypted store, remote
  processing follows the selected privacy policy, and user-canceled incomplete
  runs can be removed from the processing dashboard without deleting imported
  sources or durable Library artifacts.

## Repository

```txt
apps/
  desktop/             Electron app, React renderer, preload, and local backend
  chrome-extension/    Isolated Chrome Manifest V3 capture client
  obsidian-plugin/     Isolated Obsidian desktop plugin
packages/
  ai/                  AI contracts, adapters, registry, and local models
  conversion/          Conversion, structure detection, and normalization
  db/                  Drizzle schema, migrations, repositories, and sidecar
  domain/              Canonical types and Zod schemas
  i18n/                Product messages and translation helpers
  integration-contracts/  Versioned external-client protocol
native/
  mlx-helper/          Swift MLX helper for macOS arm64
rules/                 Hierarchical engineering specifications
docs/                  Operational developer runbooks
```

## Prerequisites

- Node.js `24.18.0`.
- npm `11.16.0`.
- macOS and Xcode Command Line Tools for the currently materialized native
  development artifacts.

```bash
xcode-select --install
```

Approved technologies and exact versions are in `STACK.md`.

## Initial development setup

Install workspace dependencies:

```bash
npm install
```

Create development environment files and install the PostgreSQL sidecar:

```bash
npm run setup:dev
```

This runs `scripts/setup-dev-env.mjs` and
`scripts/install-postgres-sidecar.mjs`. Local credentials are generated only
when missing. To intentionally regenerate development credentials:

```bash
npm run setup:env -- --force
```

To install only PostgreSQL while preserving existing environment files:

```bash
npm run sidecar:install:postgres
```

Build and validate the isolated Docling runtime:

```bash
npm run docling:build
npm run docling:verify
npm run docling:smoke
```

See `docs/postgres-sidecar.md` and `docs/docling-sidecar.md` for native runtime
details.

## Development commands

```bash
npm run typecheck
npm test
npm run build
npm run format:check
```

Run the desktop in development:

```bash
npm run dev -w @app/desktop
```

Validate the installed PostgreSQL sidecar and its extensions:

```bash
npm run sidecar:spike
```

## PostgreSQL and migrations

The desktop embeds PostgreSQL `18.4`, pgvector `0.8.4`, and Apache AGE
`PG18/v1.7.0-rc0`. Development binaries live under
`vendor/sidecars/postgres/darwin-{arch}/postgresql-18.4/` and are ignored by
Git.

At runtime, the main process creates per-installation credentials in Electron
`safeStorage`, stores data under Electron `userData`, starts PostgreSQL on
loopback, runs the empty-database baseline or pending migrations as appropriate,
and releases the UI only after the database is ready. Development CLI `.env`
credentials are separate from packaged runtime credentials.

After a Drizzle schema change:

```bash
npm run db:generate
```

Update `packages/db/seed/baseline.sql` and
`packages/db/seed/manifest.json` in the same change, then run:

```bash
npm run db:seed:verify
npm run db:migrate
npm run db:verify
```

Additional real-database verification commands are available for existing
feature groups:

```bash
npm run db:phase2:verify
npm run db:phase3:verify
npm run db:phase4:verify
npm run db:phase5:verify
npm run db:source-ingestion:verify
npm run phase4:e2e
```

The baseline applies only to a completely empty database. Existing databases
run pending migrations only.

## Local models

On Apple Silicon, build the native MLX helper:

```bash
npm run mlx:build
```

Use **Settings > Local models** to filter the audited catalog, accept required
licenses, configure an optional Hugging Face token, download/resume/verify
models, import GGUF files, test installations, and remove unused models.
Platforms without MLX explicitly mark MLX models as incompatible; supported
GGUF and remote adapters remain available.

In **Settings > AI**, each remote or local model defines defaults. Profiles bind
one model, privacy policy, response language, and task-specific overrides. Task
routes select which profile executes embeddings, summarization, note generation,
graph generation, reranking, and other AI work.

See `docs/local-models-and-packaging.md` for catalog, storage, and helper details.

## Chrome and Obsidian integrations

The desktop exposes an HTTP/WebSocket gateway on `127.0.0.1`. The default port
is `47831`; `MEMORA_INTEGRATION_GATEWAY_PORT` requests another port, and the app
falls back to a free port when needed.

Build both clients:

```bash
npm run build -w @app/chrome-extension
npm run build -w @app/obsidian-plugin
```

For Chrome, open `chrome://extensions`, enable developer mode, and load
`apps/chrome-extension/dist` as an unpacked extension.

For Obsidian, copy `apps/obsidian-plugin/dist` into:

```txt
<vault>/.obsidian/plugins/memora-eterna/
```

Enable the plugin under Community plugins.

Pair either client from **Settings > Local integration gateway**:

1. choose the client type and create a pairing;
2. copy the client ID and one-time token;
3. enter the endpoint, client ID, and token in the extension or plugin.

The database stores only the token hash. Revocation blocks future handshakes.
Obsidian reconciliation reports version/hash conflicts instead of silently
overwriting either side.

## License

Memora Eterna is licensed under the GNU General Public License version 3 or
later. See [`LICENSE`](LICENSE).

The Obsidian plugin is separately dual-licensed under your choice of the MIT
License or Apache License 2.0. Its license texts are in
[`apps/obsidian-plugin`](apps/obsidian-plugin/). The shared i18n and integration
contract packages are offered under the same permissive alternatives so the
plugin and its distributed bundle can use them under compatible terms.

## Backup and desktop package

Settings can create a dated backup containing a custom-format `pg_dump` and the
configured managed folders.

Create and smoke-test an unpacked desktop package:

```bash
npm run package:desktop:dir
npm run package:desktop:smoke
```

Create macOS DMG/ZIP artifacts:

```bash
npm run package:desktop:mac
```

Staging writes a runtime manifest and SPDX SBOM and fails when a required target
artifact is absent. The current materialized distribution target is macOS
arm64. Signing, notarization, and clean-install validation are required before
publication; credentials are external to the repository.

## Engineering specifications

AI coding agents read only:

1. `RULES.md`;
2. `STACK.md`;
3. `rules/index.md`;
4. the domain rules selected by that index for the task.

Completed implementation plans are intentionally not retained. Durable behavior
is specified in the routed rule hierarchy, while operational procedures remain
in `docs/`.

Do not commit `.env`, `apps/*/.env`, `.cache/`, generated build directories, or
`vendor/sidecars/`.
