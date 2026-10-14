# M4 outward Obsidian wiki projection

Implementation date: 2026-09-09. Branch: `codex/second-brain-m4`.
Coordinator acceptance is complete; the authorized local commit records this phase. No M5 wiki writeback,
new inference path, model execution or worktree was introduced.

## Implemented behavior

The existing Obsidian service owns a scoped wiki projector. Canonical mutations
advance a transactional invalidation clock; the existing job supervisor schedules
and resumes bounded `obsidian-wiki` jobs. The selected vault/root/scope is checked
again before writes. Disabled, unconfigured and paused sync produce no wiki files.
Settings exposes source and page selection, descendant inclusion, queued results
and per-target local-edit recovery with base/local/application versions.

A wiki page has one registered projection. Initial parents use an index; leaves
use Markdown files, and secondary collections link to them. Existing paths survive
renaming, editorial moves, archive and restore. The wiki catalog reuses source and
note paths. A catalog-only source has one reference file containing known metadata,
bibliography and child links, with no document ID. When substantive content arrives,
that record safely becomes a source projection at the same path. Its normal source
edit import continues working; a later reference transition remains recoverable.

Conceptual connections use their canonical relation IDs, actual directed owners,
both ideas, independently localized relation/review/freshness labels, and both
original evidence excerpts. Source-reference tags become links by validated
endpoint identity. Wiki citations retain exact saved excerpts, document identity,
locator, freshness and stable evidence/section anchors. Old citations do not silently
redirect to changed current text. Full canonical history stays in PostgreSQL.

The desktop and plugin share format version 1, strict reserved-frontmatter parsing,
line-ending normalization and fenced-code handling. The plugin negotiates
`obsidian-wiki-projection-v1`, skips outward wiki targets, and blocks unsupported
managed manual imports. The gateway independently blocks the actual old-plugin
fallback shape (raw reserved frontmatter with no typed frontmatter object) and
registered paths whose identity was stripped. The source/note import, move and deletion routes reject wiki identities; they
cannot mutate or approve wiki evidence.

Each new wiki delivery records full content, canonical revision, editable/generated/
rendered hashes, acknowledged base and before-content in an outbox before writing.
Per-target locks, expected actual-file hashes, exclusive temporary files and guarded
promotion protect divergence without a plugin. Before/proposed recovery files are
independent copies; a captured original inode also retains late writes from an editor
holding its old handle. File disappearance never deletes wiki pages or their sources.
Source/note writes persist their own in-flight guard, preventing transient delete
notifications and projection echoes from invoking canonical deletion/ingestion.
A lost receipt is reconciled before assigning another source sync version.

Read-only deep links use validated source/wiki IDs. Source relationship routes use
the existing relationship inspector; wiki revision/evidence links pin historical
reading and wait while an unsaved desktop wiki draft is active. Packaged protocol
configuration and single-instance forwarding are present. DEV does not register or
replace an OS protocol association.

## Persistence and specification

Generated migration `0028_elite_preak` adds `obsidian_projection_clock` and
`obsidian_projection_revisions`. Its SQL, now applied to synthetic DEV, includes the trigger
supplement for 15 canonical mutation tables. The 29-migration baseline, manifest,
journal, generated snapshot and seed expectations are synchronized. The verifier
checks retained populated data, migration history, projection indexes, triggers,
transaction rollback and the empty-baseline path.

Durable contracts are documented in `rules/integrations.md` and
`rules/second-brain.md`. Domain projection entity vocabulary includes the four new
outward target types. Library reset clears projection history and removes only
registered, identity-validated recovery files; it does not purge arbitrary vault data.

## Deterministic verification

Commands are run from the repository root. PostgreSQL and gateway/OAuth fixtures
need permission to create local sockets/shared memory in this execution environment.
They use synthetic temporary data and no model inference.

- `npm run typecheck`
- `npm run build`
- `npm test` — coordinator final broad pass: 95 suites / 574 tests.
- `npm run db:seed:verify`
- `npm run format:check` and `git diff --check`
- `node --import tsx scripts/verify-obsidian-wiki.ts`
- `node --import tsx packages/db/src/scripts/verify-source-relations.ts`

The M4 PostgreSQL fixture exercises populated M3b upgrade and empty baseline,
catalog-only hierarchy, Unicode and duplicate titles, one primary projection and
secondary links, exact old excerpts, canonical two-sided connection links, fenced
Markdown, no-op refresh, local prose/frontmatter/generated divergence, explicit
recovery and preserved custom fields, archive/restore, lost receipts, monotonic
source versions after an additional edit, source/reference transitions, preserved
source import, queued pause/scope changes, scope exclusion, transactional invalidation,
symlink containment and no wiki writeback. Injected plugin changed/deleted events
execute during source writes before their receipts and cannot delete/import the
projection's own content. A worker test holds an old file handle open and verifies
that its late bytes remain in the captured inode without changing the independent
before/proposed copies. These are deterministic fixtures, not real editor acceptance.

## Coordinator real Obsidian smoke recipe

Use only a disposable vault and preserve existing application storage settings.
The coordinator prepared `/tmp/memora-second-brain-obsidian-qa`, an isolated Obsidian
profile, and a copy of the pre-M4 plugin. The implementation agent did not open or
modify the actual DEV database, configured vault, user settings or running Obsidian.

1. Build with `npm run build`. The plugin artifacts are
   `apps/obsidian-plugin/dist/main.js` and `apps/obsidian-plugin/dist/manifest.json`.
   Copy them only into the QA vault's `.obsidian/plugins/memora-eterna/` directory;
   enable the plugin in the isolated profile and pair it with DEV through Settings.
2. Launch DEV through `MEMORA_DEV_BACKGROUND=1 npm run dev -w @app/desktop` at its
   normal 1600 × 1200 size. Confirm the 29-migration startup and unchanged canonical
   corpus. Configure the QA vault and a bounded source/page scope, then enable sync.
   Source/note synchronization may finish before its queued wiki job; inspect the
   separate wiki projection state and existing Jobs view.
3. Inspect native Obsidian reading without the plugin, including metadata-only
   parents, a page with children, a duplicate title, Unicode, a secondary collection,
   note/source links, pending/rejected/stale connection states and exact two-sided
   evidence. Check that no fake source documents or independent copied relations
   appeared in PostgreSQL.
4. Pair the preserved old plugin and try its manual Import current note command on
   a wiki file. Expect rejection and no source/note/job creation. Repeat with the
   updated plugin; it should explain that this projection is outward-only. Try a
   malformed/future schema and a registered wiki path with removed identity.
5. Keep a wiki page open in the editor. Save local prose, custom frontmatter and a
   generated-region edit separately, then change its canonical page and synchronize.
   The local file must remain intact, another independent page must update, and the
   Settings diff must preserve both sides. Modify the file again after opening the
   diff: stale recovery must fail visibly inside the dialog. Fresh recovery must
   retain the exact local copy before writing the application version.
6. Exercise rename/move, missing target, reconnect, pause/revoke before a queued
   write, restart after projection, archive/restore and catalog-reference promotion.
   Keep a source/note editor open while a projection is written; no temporary delete
   event may cascade into canonical deletion, and no own-write echo may start ingestion.
7. Check source relationship inspector navigation and pinned historical wiki
   revision/evidence reading. The DEV event route can be exercised directly;
   clicking an OS `memora:` URL requires an appropriately registered packaged app,
   and is not claimed as verified by a DEV-only run. Never open another app/runtime
   to simulate this while DEV is active.
8. Restore saved storage/scope settings and leave all accepted maintenance schedules
   paused. Preserve the QA artifacts and record actual plugin/editor results in this
   report before accepting M4 or creating the phase commit.

## Coordinator acceptance evidence

The coordinator used the existing synthetic DEV corpus and a disposable vault at
`/tmp/memora-second-brain-obsidian-qa`, with the actual Obsidian 1.8.10 application
and a separate profile at `/tmp/memora-obsidian-qa-profile`. DEV opened in the
background at its normal 1600 × 1200 size; Obsidian also kept its default window
size. The personal Obsidian configuration was not changed. The user explicitly
authorized the temporary pairing **QA M4/M5 · Obsidian sintético**. Its access and
temporary storage binding are retained for the immediately following M5 acceptance;
the original DEV storage backup must be restored and the QA pairing revoked when
that integration acceptance finishes.

Actual editor and gateway results:

- Plain Obsidian reading without the plugin resolved source links and section
  evidence anchors. Metadata-only catalog roots had child links and no fabricated
  document. The canonical `94a83230-da0b-4725-8299-e4ad4723446b` connection retained
  its Limites → Recordar direction, independent pending review, and both original
  stored evidence excerpts.
- A loadable CommonJS build of the pre-M4 plugin from `c14ac1b` attempted its
  manual send command on a wiki page. The gateway rejected `/v1/obsidian/import`
  with `forbidden`, without creating sources, notes, jobs or inference. The current
  plugin displayed the outward-only explanation before sending anything. Its
  settings confirmed a connected DEV gateway.
- Real plugin loading exposed a build-order defect: TypeScript could replace the
  Vite CommonJS bundle with unbundled ES modules. Plugin type checking now emits
  declarations only; the bundle's exact hash remained unchanged after typecheck,
  and the plugin loaded in the actual host.
- Four synthetic human wiki pages exercised Unicode, duplicate titles, stable
  primary paths and secondary collection links. Native Obsidian prose edits stayed
  byte-for-byte intact while an independent page updated. Editing again after
  opening the comparison caused recovery to fail visibly inside the dialog. A
  fresh comparison retained the exact latest local bytes under `.memora-recovery`
  before applying the application revision; the open editor then displayed it.
- Native custom-frontmatter and generated-region edits independently caused
  divergence. Recovery retained the personal `qa_local` property and the exact
  previous file copies. A fenced example containing a control marker remained
  ordinary Markdown content.
- A single additional synthetic source was revised through the existing editorial
  repository while its source file stayed open in Live Preview. The editor received
  document version two at sync version two. Its wiki citation still contained the
  exact version-one excerpt, original document ID and an explicit historical label.
  No own-write echo imported a document or deleted canonical content.
- Native local rename made the registered path an explicit conflict. Restoring
  the name and reviewing the projection resumed delivery without changing identity.
  Archive and restore preserved the file/path and all revisions; active navigation
  excluded the archived page and restored it afterward.
- Read-only links forwarded through the real Electron single-instance path to
  the existing DEV window. Historical page and evidence links opened the pinned
  revision, the source-relation link opened the existing canonical inspector, and
  an unsaved wiki draft remained intact until canceled. Subsequent current-page
  updates did not replace historical reading. No OS protocol association changed.
- The final vault audit found 38 managed files: 21 wiki pages, 3 wiki indexes,
  1 source relationship, 1 catalog reference, 4 source files and 8 atomic notes.
  It found no duplicate managed identities or broken vault-relative links.
  Original row hashes remained unchanged for all 82 sources/documents/chunks,
  150 notes/source links, 97 source relations, 150 relation evidence rows and the
  pre-M4 wiki pages/revisions. Additional QA rows and immutable revisions remain
  identifiable. AI audit count stayed at 4,896 throughout: M4 made no model calls.
- Restarting the final DEV build preserved the original hashes, all 38 managed
  identities and working links. The wiki job completed without conflicts. QA sync
  was then paused and DEV stopped before beginning M5 implementation.

Final review also corrected three asynchronous cases and expanded regression
coverage: lost wiki receipts cannot regress/reuse sync versions; every source/note
write retains the original admitted scope and rechecks current evidence ownership;
late current-page reads cannot replace historical navigation. Legacy pre-write
reads now apply the same size and symlink checks as the managed writer. Starting
a new page from historical reading clears the historical display state.

## Limits

The filesystem and PostgreSQL cannot form a cross-process transaction. An editor
may retain an old inode or save again after the final comparison. Recovery copies
and subsequent comparison preserve/reveal these cases; real Obsidian file-event
ordering and buffer behavior were exercised in the actual QA host. No automatic
three-way merge, offline edit queue, wiki writeback, semantic folder reparenting,
Canvas parity or M6 work is claimed. Large scopes fail visibly at the documented
bounds and need a smaller configured selection. OS protocol registration/launch
behavior requires packaged-app acceptance when that validation is authorized.

**Status: M4 accepted after actual DEV/Obsidian smoke, final broad checks and
expanded isolated PostgreSQL verification. M5 reverse editing remains separate.**
