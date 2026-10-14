# A6 — Obsidian mirror implementation report

This report records implementation and independent coordinator acceptance of A6.
The coordinator completed the isolated, actual-vault and regular DEV migration gates
before the milestone commit.
No real user source, user vault, regular DEV database or model call was used by
the implementation agent.

## Delivered behavior

- Explicit format/layout version 2 and pinned projection language, independent
  of interface language. Existing registered files keep version-1 behavior until
  an explicit migration; an empty configured mirror adopts content language.
- Canonical source-type folders, Unicode filenames, source parent/child order,
  catalog-only references, separate source originals/current summaries/personal
  interpretation, source-note indexes, shallow shared notes, topic/map and
  investigation navigation. Original assets are registered once and linked
  relatively; copying is an explicit bounded local-storage choice.
- Section-local citation maps and exact evidence anchors, independently visible
  provenance/protection/support, portable typed links with an exact inverse map,
  and supported original/note/wiki edits through existing editorial owners.
  Generated wrappers, summaries, navigation and relations cannot become original
  source text or approve knowledge relationships.
- Additional `obsidian-layout-v2` pairing capability; old readers/replay remain
  available. Plugin 0.2.0 reports all open Markdown leaves and pending targets,
  acknowledges migration capture quiescence, and retains offline operations.
  A connected incompatible plugin blocks migration rather than accumulating
  physical-move echoes that it could misinterpret as user deletion.
- Connections preview/apply/resume/rollback UI with exact IDs, old/new paths,
  base/local/proposed versions, preserved-link inventory, exclusions and explicit
  closed-editor acknowledgment. Action failures keep their message and refresh
  durable state. Initial configuration works without remounting the settings page.
- Durable SQL journals and independent backups precede writes. Existing advisory
  target locks and the managed CAS writer coordinate migration with projection and
  editorial work. Resume reconciles an exact already-written file; retirement
  preserves captured inodes and rejects reuse of a capture destination. Rollback
  checks later bytes and retains independent successful target receipts.

## Persistence

Generated migration `0039_sturdy_lila_cheney.sql` adds only
`obsidian_layout_migrations`; migrations 0037 and 0038 remain unchanged. The seed
contains 40 ordered migrations. The new verifier exercises a populated schema-39
upgrade and a separate empty-database baseline, checks the journal's eight
columns/history and verifies that prior canonical page/revision identities survive.

Existing source, wiki, note, evidence, editorial operation and projection outbox
owners remain canonical. Layout configuration and per-client editor presence use
the existing settings owner. Binary projection ownership uses the existing sync
registry. Reset recognizes registered binary hashes and journal recovery snapshots.

## Verification evidence

The following commands passed during implementation:

- `npm run typecheck`
- `npm test` — 124 test files and 797 tests at the final full-suite checkpoint.
- `npm run build` — desktop, plugin and workspace artifacts; the built sandbox
  preload initializes with only Electron available.
- `npm run db:seed:verify` — baseline includes all 40 migrations.
- `npm run format:check`
- `node --import tsx scripts/verify-obsidian-layout.ts`
- `node --import tsx scripts/verify-obsidian-wiki.ts`
- `node --import tsx scripts/verify-obsidian-editing.ts`
- `node --import tsx scripts/verify-automatic-wiki-a5.ts`
- `node --import tsx scripts/verify-maintenance.ts`

The A6 verifier uses 13 synthetic source instances covering the complete taxonomy,
canonical materialized structure, one shared note, canonical reading memberships,
an original asset and a current generated summary distinct from a legacy catalog
summary. It checks dirty bytes, a failure after disk promotion, journal resume,
binary rollback, later human-edit preservation, old manifest isolation, source-body
writeback, typed-link round-trip, paused sync and empty/populated PostgreSQL paths.
These are isolated service/SQL/filesystem checks, not claims of native editor QA.

The focused capture test recreates an old path after a human save to its captured
inode and confirms a retry preserves both copies. Existing plugin operation-queue
and delivery tests continue to cover exact offline snapshots and newer local text.
After the final build, another workspace type check passed and the plugin CommonJS
artifact loaded in an isolated JavaScript context with only the Obsidian host
module supplied. The sandbox preload check was also run separately and passed.

## Coordinator native evidence

The coordinator owns the actual temporary Obsidian 1.13.7 sessions, frozen plugin
bundles, isolated DEV profiles and screenshots. The first native old-plugin trial
exposed rejected but permanently pending migration echoes. Its queue and vault were
preserved, and this finding produced the incompatible-connected-plugin block.
The coordinator also identified source-summary authority, section evidence/parity,
new-binary rollback and capture-retry gaps; focused fixes and regressions were added.

On the reviewed native candidate, the coordinator reported successful first-vault
configuration without remounting, disabled Apply while sync was disabled, explicit
blocking of the connected old plugin, preservation of plugin `data.json` during
upgrade, rejection of migration with an actually open source editor, and successful
migration after closing that editor. That run completed 34/34 targets including
one attachment, with no AI calls or editorial mutations and unchanged canonical
counts. These observations belong to the coordinator's preserved native receipts;
they are not inferred from the isolated verifier.

The final coordinator gates are recorded below. The implementation agent's checks
and the coordinator's actual native observations remain distinct evidence.

## Independent coordinator acceptance

The final root verification passed 797 tests in 124 files, type checking, formatting,
the 40-migration baseline, the full workspace build and sandbox preload. Independent
A6, M4 projection, M5 editing, A5 consultation/investigation and maintenance verifiers
passed against temporary PostgreSQL instances. Initial loopback/tsx IPC restrictions
were resolved by rerunning those checks with approved local access; they were not
application failures. M4/M5 and the full suite passed again after the final note fix.

Actual Obsidian 1.13.7 (installer 1.8.10), plugin 0.2.0 and an isolated DEV profile
were exercised with 17 synthetic sources, nine wiki pages and one shared note:

- Initial unconfigured state, configuring a path without remounting, disabled sync,
  the incompatible connected plugin block, actual open-editor blocking, current
  plugin quiescence and the 34-target migration including one original attachment
  passed. The current plugin remained synchronized without false move/delete echoes.
- A source correction was saved offline, retained through an Obsidian restart and
  delivered using the native reconnect command after restarting DEV. PostgreSQL
  retained both documents, exact Unicode and the original Markdown hard break.
  No AI or ingestion job was started; deterministic projection refreshes used the
  existing job queue. An accidental test title prefix was undone and reconciled
  through the native keep-application review, preserving its conflict receipt.
- The plugin's explicit human-section command added a protected personal section.
  Subsequent prose editing preserved the prior generated section byte-for-byte,
  including its exact evidence, model-support assessment and unreviewed human state.
- A Portuguese-to-English layout migration and its complete rollback passed.
  A subsequent migration followed by another human source revision produced the
  expected guarded rollback: 33 targets restored and one changed source retained
  for review. Its current and historical documents remained intact. Root corrected
  the UI counter and five-locale guidance so this state is never presented as a
  fully restored vault. The isolated fixture intentionally retains that pending
  review; a later edit is not overwritten merely to finish rollback.
- English, Portuguese, Italian, French and Spanish controls were inspected at the
  minimum 960×640 window; both themes and the standard 1600×1200 opening window were
  checked. No fullscreen or maximized test was used. Original titles, content language
  and projection language remained independent of the interface locale.
- A standalone vault without the plugin was reconstructed from the exact retained
  output of a completed migration. Real reading followed map → shared note → original
  source, and native Back returned through the same path. Its relative attachment
  link opened the correct synthetic file in TextEdit. That native tool call incurred
  an external automation delay; the file itself opened successfully.
- Final note rendering now includes primary and linked originals, independent note
  review/protection and current/historical evidence labels. An isolated source-edit
  regression verifies that only generated metadata/sync version changes while note
  identity, path, prose, prior document and excerpts remain. The final renderer was
  also used to refresh the standalone note and its historical/pending-review labels
  were inspected in Obsidian without a plugin.

Regular DEV migrated from schema 39 to 40 through the normal migration runner after
restoring and comparing the verified pre-A6 dump again. Exact row counts and digests
of all 97 pre-existing public tables were unchanged. The new table's eight columns,
two indexes, primary key, migration history, retained investigation trigger and
AGE/pgvector extensions were checked. The wiki remains empty; the migration created
no policy activation, model call or job. No real user vault was modified.

Detailed coordinator receipts, retained failed trials and synthetic profiles are
under ignored `.cache/automatic-wiki-20260912/`; they are development evidence, not
shipping source or a replacement for the canonical data and migration history.

## Durable specifications and bounds

Updated `rules/integrations.md`, `rules/database.md` and
`rules/frontend-and-i18n.md`. No stack dependency changed. A migration processes
at most 100 targets per action; independent remaining targets need resume. An asset
is bounded to 16 MB, with a 100 MB/1,000-asset inventory ceiling. Unavailable or
omitted assets remain visible. Journal status exposes full snapshots only for the
newest migration. Filesystem and SQL do not form a whole-vault atomic transaction;
the persisted journal, exact comparisons and recovery copies make partial work
reviewable and resumable.
