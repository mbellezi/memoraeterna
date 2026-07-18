# External integration and synchronization rules

Load this rule for the Integration Gateway, Chrome extension, YouTube capture,
Obsidian plugin, vault projection, pairing, or synchronization.

## Integration Gateway

- The gateway runs in the Electron main process on loopback only. It uses HTTP
  for requests and WebSocket for events; Native Messaging is not used.
- The configured port may fall back to a free port on conflict, and Settings
  displays the actual endpoint.
- All commands/events use versioned Zod contracts in
  `@app/integration-contracts` and are routed to the same application services
  used by desktop IPC.
- Pairing produces a one-time token. Store only its hash, create ephemeral
  sessions, authorize every operation by declared capability, and support
  revocation.
- The gateway exposes application commands, never repositories, database
  access, arbitrary filesystem paths, or provider credentials.

## Chrome extension and YouTube

- The Manifest V3 extension is an isolated client. Its service worker reconnects
  after waking and gives clear feedback when the desktop is unavailable.
- It captures pages, selections, metadata, and YouTube URLs through integration
  contracts. Defuddle may run in the rendered page context.
- The desktop owns deduplication, persistence, conversion, and processing.
- YouTube metadata/transcripts use `youtubei.js` when available. Record video
  ID, platform, channel, language, transcript origin/type, and capture time.
  Missing transcripts degrade explicitly; robust transcription is not implied.
- Non-interactive captures default to import-only processing so clients never
  trigger an unexpected AI workflow requiring an unseen dialog.

## Obsidian projection

- PostgreSQL remains canonical. The vault is a synchronized, editable Markdown
  projection.
- Every managed file has stable identity frontmatter including `memora_id`,
  `memora_type`, `memora_managed`, `memora_sync_version`, and
  `memora_content_hash`, plus source/document/root/division/revision IDs when
  applicable.
- Human-readable paths are default. Identity never depends on a path or
  filename. Resolve collisions with short date, then counter, then short-ID
  suffixes.
- Hierarchies project as root index plus child folders while preserving root,
  child, division, and revision IDs.

## Bidirectional sync

- The plugin monitors only managed Markdown and communicates changes by
  contract. It never accesses PostgreSQL.
- The database stores relative path, mtime, content/frontmatter hashes, version,
  status, and tombstone state.
- Create/update/rename/delete events validate identity, version, and expected
  path. Rename/move changes the recorded path without changing identity.
- Reconciliation scans compare files that are actually present. Absence during
  a scan is not sufficient evidence of deletion; explicit deletion events use
  validated identity/version/path.
- Conflicts are explicit and never resolved by silent overwrite. Prefer
  tombstones or recoverable deletion when data loss is possible.
- Editing synchronized source Markdown triggers the defined document revision
  and reprocessing behavior; preserve reviewed artifacts and provenance.
