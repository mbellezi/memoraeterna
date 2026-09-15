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

## Catalog and artifact provenance

- PostgreSQL owns prompt revisions, activation history and composition validation
  receipts. Preserve every legacy full configuration and activation; omitted slots
  and removed domains must reset older overrides, and the old explicit active
  pointer wins over historical timestamp ordering during migration.
- Artifact compatibility belongs to the generation owning current artifacts, not
  the latest attempted generation. A current summary uses its generation ID.
  Current notes must agree on compatible owning generations and must not come from
  an incomplete replacement; no-write failed attempts leave old ownership intact.
- Canonical graph replacement and its knowledge-generation receipt commit in the
  same transaction, including zero-output replacements. A failure in either rolls
  back both. Completed zero-output stages use their own completion timestamp and
  configured outcome; unrelated later run updates cannot reorder ownership.

- Automatic curation extends the existing owners with `wiki_policy_revisions`,
  `wiki_policy_activations`, `wiki_toc_groups`, `wiki_memberships`,
  `wiki_section_assessments` and `wiki_group_receipts`. Page columns project only
  management/role/TOC owner; immutable revision content retains complete navigation
  and assessment snapshots. Unique TOC owner and run/group receipt indexes prevent
  duplicate owners and canonical group replay.
- A title or alias alone is not page identity. Duplicate curation checks combine
  explicit purpose, page kind and positively overlapping source scope. Unbound
  human prose is never loaded merely because a proposed page shares its title.
- Group apply takes the existing placement lock, policy/run locks, sorted page and
  canonical input locks, then validates current scope, cancellation, model grant,
  every original and typed reference. No inference occurs inside the transaction.
  One invalid target rolls back the whole group. Current TOC query records may be
  replaced, but earlier revision snapshots and receipts remain immutable.
- Group explanations and typed navigation retain exact dependencies in the existing
  dependency table using their stable group identity. Current source/section/note
  impacts remain separate from support and human review; a navigation edit cannot
  turn a stale assessment into fresh evidence. Conservative legacy management
  classification preserves old revision bytes and existing human protections.
- Applying curator content requires the complete supported verdict for the exact
  proposal hash, linked through the existing organization step to a succeeded
  canonical AI audit with the admitted semantic-support prompt composition. Group
  approval cannot bypass this gate. Store candidate and check progress in existing
  proposals/checkpoints; do not create another audit or proposal store.
- The canonical wiki save owns current TOC group/member query rows for every new
  revision, including native pinning and human section edits. Preserve group/member
  identities, order and authorship; refresh only their current revision base.
  Historical revision snapshots remain unchanged.
  Delete current group/member rows for removed groups in that same save. Removal
  repairs retain dependencies of protected prose and surviving targets, including
  unavailable attribution of retained knowledge-owned notes; removed members do
  not leave orphan navigation rows or grant current support. Preserve unchanged
  previously verified sections after evidence loss without allowing new verification
  of missing evidence.

- Per-consumer impact delivery identity includes a concrete consumer key (policy
  or investigation identity), in addition to event, consumer kind and generation.
  One policy's receipt or the legacy `consumed_at` cannot acknowledge another.
  Enrollment shares the canonical event transaction; retained-event reconciliation
  admits at most 100 missing deliveries per pass. Events contain IDs, operation,
  fingerprints and causal metadata, never copied source prose.
- Bootstrap cursors remain in `organization_runs`; `wiki_source_coverage` is the
  persistent per-policy source projection. Coverage fingerprints bind meaningful
  canonical inputs, policy revision, content language, effective model parameters
  and prompt composition. Canonicalize dictionary ordering for this new identity;
  do not change existing proposal/audit hash semantics.
- Parent bootstrap checkpoint updates compare the exact persisted timestamp.
  A stale advance cannot overwrite a pause/cancel. Transactional apply locks and
  rechecks the parent state; pause acknowledgment is serialized with a group
  already committing. No database transaction waits for model inference.
- Navigation uses localized keyset child metadata queries, with independent
  recent/pinned overview reads. Normalize missing/archived/noncurrent parents as
  roots; selected paths remain loadable beyond any sibling page. Canonical saves
  reject cycles, so ordinary reads must not reconstruct the complete forest or
  walk every page's ancestry for historical cycle repair. Selected-path traversal
  terminates defensively on repeated IDs without imposing a hierarchy depth cap.

- Automatic maintenance reuses version-dispatched `maintenance_schedules`,
  `maintenance_runs`, `maintenance_occurrences` and the existing monthly reservation
  table. `automatic_routine_bindings` has unique policy/kind/scope identity and a
  separately recorded preset version. `automatic_routine_calls` is unique by
  organization run/step and links every reservation to its occurrence and policy.
- Serialize reservations on the parent policy lock. The same step cannot be
  charged twice or transferred between occurrences. Every installed child shares
  the parent monthly ledger; retries preserve consumed or uncertain reservations.
  Historical estimate ledgers retain their original accounting and replay identity.
  They no longer authorize or block generation. Aggregate budget consumption from
  canonical AI audits through the exact organization step and routine-call links,
  with UTC month attribution by audit timestamp. Use strict greater-than comparisons
  before provider execution; do not include planned future calls or tokens. Unknown
  usage remains incomplete, and a completed result is never discarded for crossing
  the configured consumption limit.
- Schedule retirement uses `retired_at`; it never deletes a historical occurrence
  merely to satisfy a foreign key. Automatic readers exclude retired legacy rows,
  while historical run readers remain available. Protected-section equality uses
  structural content equality, not JSON object key order after a JSONB round-trip.

- `wiki_investigations` owns explicit follow identity and current state;
  `wiki_investigation_evaluations` owns unique question/input/composition evaluations.
  Their answer pages, immutable revisions and originals remain in the existing wiki
  tables. Evaluation inference uses existing organization runs/steps and canonical
  AI audits, not an additional scheduler or inference log.
- Follow/apply use the shared placement → policy → investigation/identity lock order.
  Policy/scope, exact originals, transitive dependencies, current answer revision
  and human protection are checked transactionally; no transaction awaits inference.
  Source-impact enrollment includes new descendants in the canonical source-write
  transaction. Delivery acknowledgments reference only IDs captured before inspection,
  so an event arriving during retrieval cannot be swallowed by a no-change receipt.
- A never-started investigation deferral may resume in a later eligible occurrence
  only when no reservation or canonical audit exists for that run. Preserve the
  admitted snapshot and canonical run ID; its existing checkpoint records renewed
  occurrence authority and prior deferrals. Do not transfer an already charged
  step, refund the parent ledger, or erase failed/uncertain provider history.

- `obsidian_layout_migrations` owns explicit physical-layout assessment, immutable
  admitted target snapshots and recoverable per-target progress. It does not
  create source/wiki identity or activate organization policy. Existing sync
  registry, editorial history and projection outbox remain the corresponding
  placement, writeback and delivery authorities. Binary projection ownership
  uses registered document-asset IDs, with journaled migration/rollback receipts.
- Migration status reads return full target snapshots only for the newest
  journal; earlier entries contain metadata. Retain complete snapshots in SQL
  for recovery. Library reset recognizes registered binary hashes and journaled
  recovery paths before clearing ownership, and preserves unrelated files.

- Atomic notes retain non-null historical `created_from_source_item_id` and
  `evidence_chunk_id` identifiers, with separate nullable owning-source/owning-chunk
  foreign keys. A validated ownership trigger supplies those cascade owners for
  legacy/source-owned notes. Only reviewed evolution promotes participants and
  outputs to `knowledge` ownership with no arbitrary source/chunk deletion owner;
  promotion cannot be reversed by an ordinary update.
- `atomic_note_evidence` stores immutable original attribution snapshots without
  source/chunk deletion FKs; `atomic_note_evolution` retains restrictive previous,
  successor and organization-run references. Live source links remain projections
  of available originals. Deleting a source cannot erase retained note identities,
  excerpts, supersession links, note revisions or canonical organization AI audits.
  Whole-source deletion remains the separate explicit SourceDeletionService action.
- Ownership backfill preserves all earlier columns, note fingerprints and legacy
  cascade behavior without generating semantic impact events. Generation upserts
  and pending-note archival exclude knowledge-owned identities. A note's former
  source ID is attribution, never permission to regenerate it or delete its file.
- Currentness and scoped retrieval check retained attribution as well as live links.
  Deleted secondary evidence cannot disappear from scope checks. Whole-library
  historical wiki search includes knowledge-owned notes after primary deletion;
  source-specific searches must still contain the complete retained source set.
- Obsidian scope admission uses a focused dependency/typed-reference source
  closure shared by both outward layouts. It includes retained interpretation
  originals, note evidence and derivative relation endpoints without joining away
  deleted source IDs. Metadata-only path pages inherit descendant attribution;
  related references affect provenance without creating principal tree edges.
  Projection note evidence shares the canonical snapshot reader and retained
  currentness predicate, including exact source ownership checks.

## Hierarchy persistence

- The hierarchy rollout uses an empty database and one current contract, without
  historical migration/reconciliation gates or new format versions. No database
  reset is implied. Canonical revisions and receipts created by new work remain
  immutable and idempotent.
- The existing curator repository exposes scoped placement metadata separately
  from editable prose. Infer navigation-only lineage from reachable children,
  current dependencies, typed memberships and retained original attribution.
  Empty dependencies never imply permission for ordinary pages. The reserved
  app-owned Wiki area IDs may receive children without source lineage only when
  the initialization marker, exact empty navigation shape and canonical area
  parentage agree. They are destination-only, never editable/movable curator
  targets; excluded content or arbitrary empty human pages receive no exemption.
  Bound response rows and bytes;
  continue complete touched ancestry and subtopic descent without a depth cap.
- Every canonical Wiki save serializes entity-ID and source/topic TOC-owner
  uniqueness, archived-parent rejection and hierarchical TOC-cycle checks under
  the placement lock. Reuse exact canonical entity IDs; do not merge identities
  or create semantic graph relations from editorial edges.
- One guarded group transaction saves all work targets, exempt ancestors and
  explicitly accepted moves. Require exact originals, current scope and enabled
  policy, expected page/destination revisions, complete changed-handle support
  linked to the succeeded canonical AI audit, complete pinned fragment revisions
  and the admitted supportCompositionHash.
  Preserve untouched section revisions, assessments, memberships and protection.
- Ancestor-only chunks require the exact route loaded from its owning backend
  checkpoint and a matching current child run. Atomically save the next admitted
  prefix, canonical IDs/revisions/fingerprints, route progress and group receipt;
  model-provided proof alone never authorizes zero-work mutation.
- Child admission updates the route's current-child binding and the bootstrap
  cursor in the same transaction as the existing organization job/run creation.
  The original resource-deferred planner is linked by `continuedByRouteId` and
  `continuationComplete`; retain its consumed audit even after route completion.
  Maintenance review lookup excludes that superseded planning failure, while
  unresolved route children retain their exact review/uncertain/negative states.
- Route planning stores explicit parent references for every ancestor and final
  target. Validate the exact topological prefix and all frontier endpoints; update
  every resolved branch fingerprint atomically after each chunk. Distinguish
  placement references from ordinary owner/member/link references when rebinding.
- Known-unstarted route retirement serializes against the run's provider-start
  transition and its job. Canonical task recording atomically writes its
  organization step, so any step/audit blocks retirement. Preserve old reservation
  rows; successor admission locks both owner and retired child, verifies the
  current occurrence and exact retained proposal, and writes reciprocal linkage
  together with the new child binding. Historical linked planners/deferrals do
  not become current actionable maintenance failures.

- The current curator repository exposes one canonical apply implementation for
  content and hierarchy. Its ordinary apply entry point delegates to the same
  hierarchy transaction; no older writer can silently drop ancestors or moves.
  Reserved navigation-area inventories skip descendant traversal and disclose
  only their exact immutable destination revision, including in narrow scopes.
- Ordinary editorial generation supplements noncausal impact IDs with scoped
  human revision IDs that change principal parent. Existing impact triggers omit
  placement-only edits; no new queue or trigger is introduced. Organization
  revisions and pin/order-only human changes do not enter this content signature.

- Wiki reading context and compiled consultation share principal-child, owned-TOC
  and typed subtopic descent. An explicitly selected page-owned TOC also opens its
  canonical owner as a seed; descending into another TOC does not independently
  open an outside owner. Related links remain connections, never traversal edges.
  Deduplicate traversal IDs to terminate cycles and preserve the existing bounded
  result/keyset contracts. Source scope includes transitive compiled dependencies
  and every primary, live-linked and retained original of referenced notes and
  note-relation participants before any derived prose is returned.

- Editable hierarchy inventory entries pin a metadata-only review footprint:
  memberships owned by the moved subtree or pointing into it, including page
  revisions, canonical group/member/target IDs, purpose, authorship, member/group
  order and protection; incoming automatic links and explicit collection links
  pin their owning page revisions. Include this footprint in the inventory hash
  and exact transactional equality check. A same-count incoming change still
  invalidates review. These IDs grant no mutation authority and disclose no
  excluded headings or prose. Reserved destination areas expose no footprint.
  Keep manifests within the existing inventory byte bound and out of model prompts.
