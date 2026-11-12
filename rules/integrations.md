# Integrations

Load for the Integration Gateway, Chrome extension, YouTube capture, the
Obsidian plugin and vault projection, pairing, synchronization or `memora://`
deep links.

## Integration Gateway

- The gateway runs in the Electron main process on loopback only (HTTP for
  requests, WebSocket for events). If the configured port is taken it may use a
  free port, and Settings shows the actual endpoint.
- Commands and events use versioned Zod contracts from
  `@app/integration-contracts` and call the same application services as
  desktop IPC.
- Pairing issues a one-time token stored only as a hash, creates ephemeral
  sessions, authorizes each operation by granted capability and supports
  revocation. New capabilities are granted explicitly; existing pairings are
  never silently upgraded.
- The gateway exposes application commands only, never repositories, database
  access, arbitrary filesystem paths or provider credentials.

## Chrome extension and YouTube

- The Manifest V3 extension is an isolated client. It reconnects after waking
  and tells the user clearly when the desktop is unavailable.
- It captures pages, selections, metadata and YouTube URLs through contracts;
  the desktop owns deduplication, persistence, conversion and processing.
- Non-interactive captures never trigger generative AI the user has not seen;
  they use searchable processing at most.
- YouTube capture records video ID, platform, channel, language, transcript
  origin and capture time. Missing transcripts degrade explicitly.

## Obsidian projection

- PostgreSQL stays canonical; the vault is a synchronized Markdown projection.
  The plugin monitors only managed files and never accesses PostgreSQL.
- Every managed file carries identity frontmatter (`memora_id`, `memora_type`,
  `memora_managed`, sync version, content hash, plus source/document/revision IDs
  when applicable). Identity never depends on path or filename; collisions get
  deterministic suffixes. Non-reserved user frontmatter is preserved.
- Registered paths are stable: renaming, re-parenting or archiving a topic does
  not silently move files. Physical layout changes are explicit, recoverable
  migrations that check local edits before moving anything.
- The projection follows the topic tree: topics project as folder-note maps of
  content, redirects become aliases, sources and notes keep their registered
  paths. Delivery is paged with a persisted checkpoint; an oversized file fails
  visibly by name, nothing is silently truncated, and topic maps are outward-only.
- Scope and canonical revisions are revalidated immediately before every write.
  Writes are serialized per target, compare actual file bytes before promotion,
  reject symlinks inside the vault, use exclusive temporary files, and keep
  recovery copies under `.memora-recovery`.
- Retired projection files are archived or tombstoned through the recovery flow,
  never deleted when they may hold user edits.

## Synchronization and editing

- The database records relative path, mtime, content and frontmatter hashes,
  version, status and tombstone state per managed file.
- Create, update, rename and delete events validate identity, version and
  expected path. A rename changes the recorded path, not identity. Absence during
  a scan is never evidence of deletion.
- Conflicts are explicit and never resolved by silent overwrite; base, local and
  application versions stay available for an explicit choice.
- Editorial writeback is a separately granted capability bound to one vault.
  Accepted edits become human revisions through the same services as desktop
  edits, mark content protected, invalidate dependents and never start
  generative AI work.
  Generated regions and reserved metadata are not a mutation language.
- The plugin persists pending operations durably before delivery and never
  discards local text on failure.
- Projection writes suppress their own echo events, so a projection never
  triggers ingestion or canonical deletion.

## Deep links and bundles

- `memora://` links are parsed only by `normalizeMemoraLink` (canonical and
  legacy forms), open only an object, respect the single-instance lock and wait
  while the user is editing. Packaged builds register the scheme; DEV never
  changes OS protocol associations.
- The Obsidian plugin ships as a bundled CommonJS artifact built after its
  contracts and translations; type checking must not replace that bundle.
