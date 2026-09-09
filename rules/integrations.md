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

## Wiki projection release 1

- `ObsidianSyncService.wiki` owns outward wiki projection, using the existing
  `JobSupervisor` (`obsidian-wiki` jobs), managed writer and sync registry. The
  saved `obsidian.wiki.scope` setting selects sources, optional descendants and
  wiki pages; empty selections mean all eligible objects. A page with excluded
  evidence or a note with an excluded source link is not exported. Conceptual
  relationships require both directed endpoints in scope. Scope applies to
  manual, queued and ingestion-triggered source/note projection as well.
- Canonical wiki, dependency, source/document/evidence, note/relation and
  bibliography mutations transactionally advance `obsidian_projection_clock`.
  It coalesces invalidation, never stores canonical knowledge. The supervisor
  queues a bounded refresh for a changed generation/configuration, only with
  configured, enabled, unpaused sync. Every target write rechecks the admitted
  vault/root/scope. A disabled desktop does not promise background execution.
- Bound a refresh to 1,000 sources, 1,000 pages, 2,000 notes, 1,000 conceptual
  relations and 100 evidence occurrences per relation. Limit each managed file
  to 2,000,000 characters/bytes on the relevant serialization/read boundary,
  and the wiki plan to 20,000,000 characters. Oversized scopes fail visibly;
  they never silently export a truncated bibliography, page or evidence body.
- Wiki identities project once at their primary placement: leaves are files,
  initial parents have an index file, secondary memberships are wikilinks.
  Registered paths survive renaming, reparenting, archive and restoration.
  Archived existing projections show recoverable archive state and leave active
  navigation; files are not deleted. Source and note paths are reused. The wiki
  source catalog links them; metadata-only sources have one `source_reference`
  record with bibliography and child links, without a document identity.
  Later substantive ingestion safely promotes that same record/path to a
  source file; transitions in either direction preserve divergent local edits.
- Source relationships are read-only generated files keyed by the existing
  relation ID. Render the actual directed owners, both attributed ideas,
  explanation, independently translated review/freshness and both original
  evidence snapshots. Resolve source-reference tags from endpoint IDs and
  registered paths. Historical excerpts remain explicit and never silently
  redirect to changed current source prose. Page citations retain source,
  document, locator, exact excerpt and stable evidence/section anchors.
- Shared `@app/integration-contracts` Markdown format version 1 owns parsing,
  serialization and normalization on desktop/plugin. Keep legacy fields plus
  `memora_wiki_schema` and `memora_revision_id` for outward types. Reject unknown
  or duplicate reserved fields. Preserve non-reserved user frontmatter. Only
  line endings normalize; hard breaks, fences, Unicode and whitespace remain
  meaningful. Reserved control markers inside fenced examples remain data.
  Title/section Markdown is separated from the generated region; section UUIDs
  and block anchors are stable. Generated regions are not a mutation language.
- `obsidian_projection_revisions` is the per-target delivery outbox and retained
  merge base. Before filesystem work it records serialized content, canonical
  revision, editable/generated/rendered hashes and the exact acknowledged base.
  The generated hash covers generated region content without delimiter markers;
  the rendered hash includes all frontmatter, markers and prose. Recovery keeps
  historical bases and local copies. A matching observed intended file can
  finish a lost receipt without another write. A missing or changed target
  becomes an explicit conflict; independent targets continue.
- Serialize target writes with a PostgreSQL advisory lock. Recheck actual file
  content before promotion, reject symlink descendants of the real vault root,
  and use exclusive temporary files. Preserve independent before/proposed copies
  and the captured original inode under `.memora-recovery`; exclusive promotion
  preserves files recreated during its brief gap. Cross-process editor saves
  are not a filesystem/database transaction. Late saves to the old inode remain
  recoverable in the captured copy; real open-editor smoke is a release gate.
- Persist an in-flight `projectionWrite` guard before source/note writes and
  suppress their own changed/moved/deleted plugin events until the receipt.
  This prevents a transient absent path from invoking canonical deletion and
  prevents projection echoes from triggering ingestion. Restart reconciles the
  observed intended hash before clearing a guard. Recovery files are excluded
  from reconciliation and are removed only by explicit library reset when
  their registered delivery and managed identity validate ownership.
- Negotiate `obsidian-wiki-projection-v1`. New plugins skip outward files and
  refuse unsupported managed manual imports. The gateway also rejects reserved
  raw Markdown when an older plugin omits its unrecognized frontmatter object.
  Source/note import, move and delete routes cannot reinterpret registered wiki,
  reference or conceptual-relationship identities. Stage 1 performs no wiki
  writeback, review approval or AI execution.
- Read-only `memora://open/wiki/<id>` and `memora://open/source/<id>` links validate
  IDs and supported query fields. Wiki revision/evidence routes stay pinned to
  the exact historical revision; source relation links use its existing inspector.
  An incoming wiki link waits while a desktop draft is being edited. Protocol
  launch forwarding respects the application single-instance lock. Packaged
  builds register the scheme; DEV does not change OS protocol associations.
- Desktop recovery shows base, local and proposed versions. It checks the latest
  delivery and local file hash, preserves the local copy and explicitly applies
  the application version; it does not import wiki prose. Keep action failures
  visible inside the review dialog. Real plugin/vault acceptance is required in
  addition to the isolated `scripts/verify-obsidian-wiki.ts` verifier.

- Source/note writes retain the original admitted scope binding through all
  asynchronous reads and reference-to-document promotion. Immediately before
  a write, revalidate that binding and current source/note evidence ownership,
  including notes named in generated relation links. A stale preloaded note set
  is not authorization after scope or linked evidence changes.
- Receipt reconciliation reloads the synchronized registry version before
  rendering another wiki/source revision. Recovering an already-written file
  cannot decrease its sync version or reuse that version for newer content.
- Wiki links wait while editing, organization, consultation or history review
  is active. All current-page background and dialog-close reads share the
  navigation request epoch; a delayed response cannot replace a linked
  historical revision, even when both responses have the same page ID.
- The Obsidian plugin's loadable JavaScript is the Vite CommonJS bundle.
  Type checking emits declarations only and must never replace that bundle
  with unbundled ES modules. Verify the built artifact remains loadable after
  a subsequent workspace type check.
