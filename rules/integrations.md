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
- Editing synchronized source Markdown uses the shared editorial revision flow.
  Preserve reviewed artifacts and provenance; saving never implies AI processing.

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
  their registered delivery and managed identity validate ownership. Legacy
  recovery filenames with independent delivery IDs use the registered target
  identity and strict recovery-directory validation specified in
  `rules/security-and-privacy.md`.
- The release-1 protocol negotiates `obsidian-wiki-projection-v1`. Clients without
  separately granted editorial capability skip outward files and
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
  Its build first compiles integration contracts and translations so workspace
  build ordering cannot embed stale protocol schemas or product copy.
  Type checking emits declarations only and must never replace that bundle
  with unbundled ES modules. Verify the built artifact remains loadable after
  a subsequent workspace type check.

## Editorial synchronization

- `obsidian-editorial-v1` is a separately granted pairing capability. Existing
  pairings are not silently upgraded. A compatible plugin requires an explicit
  Obsidian pairing with editorial scope, a persistent vault UUID and the current
  vault/root binding. Binding is first-write-wins; a different vault or root
  needs a new pairing. Recheck the grant, target registry, original admitted
  source/page scope and binding before commit. Scope never comes from Markdown.
- The plugin persists versioned operations before delivery, retaining original
  operation IDs, exact observed file bytes and their acknowledged bases across
  restarts. Serialize durable transitions, restore them on persistence failure,
  deduplicate identical captures inside that transition, and serialize target
  replay. Bound the queue to 1,000 operations and 20 million content characters;
  failures remain visible and never silently discard local text. HTTP requests
  have a ten-second timeout and only use the loopback gateway.
- The manifest is cursor-paged over registered files, 25 per page. Missing files
  during scans never imply deletion. Explicit file/folder moves and deletions
  produce separate durable operations; folder operations retain per-file results.
  A move changes registered placement only, not a source parent or wiki parent.
  Copying an existing identity to another path produces a conflict.
- The editorial service uses the M4 per-target write coordinator and a receipt
  transaction, with current canonical locks and expected revisions. That same
  transaction saves human revisions, invalidates dependents, updates the sync
  base and records an immutable operation/receipt. Replaying an applied ID with
  the same request returns its receipt; reusing an ID with different data fails.
  Serialize editorial admission to avoid exhausting the shared PostgreSQL pool.
- Sources use `SourceEditorialService`, also used by the Library. Saving replaces
  a current document through an editorial revision, preserves previous documents,
  chunks and spans, and never creates ingestion/AI jobs. Body-only projection
  edits preserve catalog metadata, bibliography and child boundaries. Legacy
  source edits reject superseded documents and keep the new document identity;
  the legacy input hash may normalize whitespace, but stored text never does.
- Page H1 titles and UUID-anchored sections are editable. The plugin's explicit
  Add human section command can wrap an empty page/index introduction or append a
  new section. Added sections are human/protected and have no invented evidence.
  Reordered, missing or ambiguous anchors require manual reconciliation with the
  exact retained base. Reserved metadata, generated evidence, relation blocks,
  source relationships and navigation are not a mutation language. User YAML is
  retained as local metadata; it cannot change permissions or canonical review.
- Merge only independent anchored section/title changes with intact structure
  and unchanged generated regions. Use parser offsets, never equal body strings,
  to identify a section. Overlap, unsupported structure and changed generated
  bytes retain base/local/app text for explicit keep-local, keep-app or manual
  merge in Obsidian or Connections. Confirmation rechecks canonical revisions
  and current local bytes. Review failures remain visible in the dialog.
- A receipt does not grant permission to overwrite a newer local file/editor.
  The plugin uses the supported host `Vault.process` API and compares the active
  Markdown editor; desktop resolutions use the managed CAS/recovery writer.
  Rebased queued wire content retains its separate original observed bytes.
  A later queued deletion can eliminate the need to reproject an earlier save;
  the final tombstone retains the latest local content. Delivery acknowledgments
  verify the actual file hash and never clear a newer pending operation.
- Explicit deletion creates a recoverable projection tombstone, never a source,
  note or cited-object cascade. Connections can restore it through the same
  reviewed receipt flow. Pending payloads remain inspectable in the plugin even
  if canonical data is removed separately. Acknowledged plugin payloads are
  removed after durable receipt processing; PostgreSQL receipts/bases and note
  revisions remain audit history until explicit library reset.
- New editorial targets are excluded from legacy automatic import/move/delete
  mutation paths. Projection echoes are recognized through exact acknowledged
  content and registered versions; a newer outward version is reconciled before
  being treated as a local edit. No-plugin and incompatible-plugin divergence
  retains the M4 recovery behavior.
- A duplicate-copy conflict can be explicitly detached in the plugin: retain its
  prose/user YAML as an unmanaged local copy, remove its reserved identity fields
  with a local CAS, and dismiss the conflict only after the backend verifies that
  the copied path is no longer managed. The original registry identity is kept.
- Fresh comparisons are read-only; applied receipts remain immutable. Explicit
  resolution supersedes earlier queued snapshots of that file only after checking
  its current observed bytes. Plugin unloading stops late queue transitions and
  file writes; pending operations remain replayable on the next load.
- Move, deletion and restoration receipts invalidate generated navigation in the
  same transaction. Tombstoned targets retain their paths for restoration but
  generated links fall back to validated application navigation. Every rendered
  wiki change advances its sync version, including generated-only link changes
  whose canonical page revision is unchanged.
- Replay follows contiguous explicit move events to the final observed path;
  intermediate paths need not exist. A legacy dirty move first persists a
  separate editorial save while retaining the original move operation ID.
  Generated regions rebase only when their bytes equal the accepted prior input;
  divergent generated text remains available for conflict review.
- Resolution receipts retain the exact locally confirmed bytes. Desktop
  keep-local applies those bytes; plugin replay supersedes only edit snapshots
  through that observed boundary, preserving subsequent edits and every separate
  move/delete event. A missing local file invalidates plugin confirmation rather
  than implicitly restoring it. Byte-identical files at different paths still
  require duplicate-identity reconciliation.
- Failed resolution retries reference the original conflict family. A successful
  resolution hides only earlier attempts with the same client, target and vault
  binding; immutable receipts remain history. The manifest identifies the exact
  retired attempt IDs so the plugin can reconcile a replaced original without
  dropping later drafts or independent conflicts.
- Files and successful resolutions are separately paged, 25 each, through the
  manifest cursor until both are exhausted. The plugin sends its stable snapshot
  of at most 1,000 pending operation IDs in the POST body for all pages. Filter
  resolution history and retired attempt IDs by that snapshot, so long history
  cannot crowd out an older operation still pending on an offline client.
