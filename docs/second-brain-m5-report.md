# M5 editorial Obsidian synchronization

Implementation branch: `codex/second-brain-m5`. Coordinator acceptance passed on 2026-09-10; the phase is
recorded in its authorized local commit. M6 is outside this phase; the user requested stopping
after accepted M5 is committed.

## Delivered areas

The plugin has a durable versioned operation queue, persistent vault identity,
bounded registered-file manifest, replay with original operation IDs, exact
observed bytes distinct from rebased wire content, per-target partial failures,
request timeouts, validated responses/events, explicit offline moves/deletions,
and native synchronization review. Interrupted or rejected requests preserve the
local payload. Acknowledged payloads leave the plugin queue after its durable
transition; retained bases and receipts remain in PostgreSQL.

A separately granted `obsidian-editorial-v1` capability is required. Existing
pairings are not silently upgraded. New Obsidian pairing UI explains editable
source/note/wiki scope and that saving does not process AI. The binding uses a
persistent vault UUID and the configured vault/root. Scope, identity, capability,
revision and registry validation stay in the application. The service shares the
M4 per-target writer lock and commits editorial changes, invalidation, sync base
and operation receipt transactionally. Grant revocation is checked against the
persisted client while committing.

`SourceEditorialService` now serves Library editing and Obsidian. It preserves
line-normalized Markdown, old documents/chunks/spans, descriptor/bibliographic
values, root introductions and independent child boundaries. Catalog-reference
introductions can become substantive source documents at the same identity/path.
The old plugin/import path also uses editorial replacement, rejects superseded
incoming documents and returns the replacement document ID. It no longer updates
a document in place or creates an ingestion job. Legacy normalized input hashes
remain compatible without normalizing away the stored user text.

Wiki H1 titles and anchored sections create human-origin revisions. Title aliases,
review state, historical citations and evidence associations survive. Changed or
new human sections are protected and need evidence review; new sections receive
no invented citations. Atomic-note edits preserve independent review state,
original evidence links and full before/after snapshots. Human protection applies
to generated upserts, their evidence-link fallback, and pending-note archival
under explicit reingestion. Note projections retain their original evidence
document identity after a source is revised. Note edits invalidate derived
embeddings; existing dependency/fingerprint mechanisms expose stale knowledge.

Comparison uses exact base, local and current application versions. Only proven
independent anchored section/title changes merge automatically. Parser offsets
protect identical/sub-string section bodies and fenced examples. Reserved fields,
generated navigation, source relationships and evidence blocks cannot be edited
as a mutation language. Both Obsidian and Connections expose keep-local, keep-app
and manual merge; a fresh comparison is available after a concurrent change.
Explicit new-section scaffolding and duplicate-copy detachment provide a recovery
route without interpreting arbitrary headings or duplicated IDs as new knowledge.

Managed deletion is a recoverable projection tombstone. It never cascades to
sources, notes or cited objects. Connections can restore a deleted projection.
An offline edit followed by deletion preserves the latest text without requiring
an impossible intermediate file write. The plugin retains inspectable pending
text even if its canonical object was separately deleted.

## Persistence and specification

The coordinator's follow-up review exposed and corrected stale desktop keep-local
content, covered-snapshot replay after desktop resolution, missing intermediate
rename paths, and plugin confirmation after a file deletion. Resolution requests
now retain the exact confirmed local bytes; replay preserves later edits and
separate move/delete events. Old offline queues with a dirty move receive a
durable editorial precursor without changing the move ID. Byte-identical duplicate
paths are captured, and valid receipts clear superseded transport errors. Focused
regressions exercise actual queue/CAS adapters, dirty multi-move/deletion replay,
generated-byte rebasing and resolution boundaries. Real PostgreSQL coverage adds
desktop keep-local after a refreshed comparison, wiki edit/edit/move and note
edit/dirty-move/move with absent intermediate paths and final acknowledgment.

Final native QA exposed failed resolution attempts remaining after their original
conflict was resolved. The review query and manifest now share the same earlier
attempt/client/target/binding predicate. Retries retain the original family, and
the plugin retires exact server-confirmed attempt IDs while preserving later
drafts and independent conflicts. Resolution history is paged with files and
filtered by the plugin's bounded pending-ID snapshot sent in the POST body.
Focused unit tests and the isolated PostgreSQL verifier cover failed manual
attempts, desktop completion, plugin retry, immutable history, independent/later
conflicts, later-edit replay and recovery across multiple manifest pages.

Generated additive migration `0029_slow_valeria_richards` creates
`obsidian_editorial_operations` and `atomic_note_revisions`. The pre-application
supplement backfills human protection from existing edit audit events, without
inventing missing historical text. The implementation agent applied it to isolated PostgreSQL fixtures; the
coordinator subsequently applied and audited it in the synthetic DEV database. Migration 0028 remains immutable.
The generated snapshot, journal, 30-migration baseline, manifest and seed tests
are synchronized. The source-ingestion verifier now derives its expected history
count from the journal rather than its obsolete eighteen-migration constant.

Durable decisions are recorded in `rules/integrations.md`,
`rules/second-brain.md`, `rules/source-ingestion.md` and
`rules/ai-and-knowledge.md` and `rules/architecture.md`. Library reset includes the new library-owned history.

## Verification commands

Run from the repository root. The PostgreSQL, gateway and OAuth fixtures need
local socket/shared-memory access. They use disposable data, synthetic passages
and mocked transport/model adapters; no real inference runs.

```sh
npm run typecheck
npm run build
npm test
npm run db:seed:verify
npm run format:check
git diff --check
node --import tsx scripts/verify-obsidian-editing.ts
node --import tsx scripts/verify-obsidian-wiki.ts
node --import tsx packages/db/src/scripts/verify-source-ingestion.ts
node --import tsx packages/db/src/scripts/verify-source-relations.ts
```

The dedicated M5 verifier exercises a populated M4 upgrade and empty baseline,
legacy human-note backfill, preserved bibliography without a source descriptor,
parent/child source content, catalog introduction promotion, identical-section
wiki changes, added human sections, note hard breaks/indentation/history,
protected generated upserts and evidence links, stale note saves, explicit
reingestion archival protection, operation replay, concurrent section merges,
conflict resolution, duplicate detachment, path-only moves, offline edit-delete
replay, tombstone restoration, repeat projection, pause and pairing revocation.
The M4 verifier retains its no-plugin, legacy-plugin, scope/CAS, historical
citation, writer-event, lost-receipt and recovery cases. Its source-import
assertion now requires preservation of the old document, as M5 specifies.

Queue/unit fixtures cover persistence-before-send, restart IDs, mismatched
receipts, independent failed targets, identical capture deduplication, disk-full
transitions, stale object references after rollback, rebased observed bytes,
offline edit-delete sequencing, request timeout/loopback validation, strict
format parsing and conservative anchored merges. Gateway tests require an explicit
new grant rather than upgrading existing pairings. Full final counts and commands
are recorded in the implementation handoff; actual editor acceptance is separate.

## Final implementation checks

All own checks passed: full build; typecheck; **98 suites / 595 tests**;
30-migration seed verification; formatting and diff whitespace checks; isolated
M4 projection, M5 editorial, source-ingestion and source-relations verifiers.
The CommonJS bundle parsed as JavaScript, required the native Obsidian module,
and remained byte-identical after a subsequent workspace typecheck. Its SHA-256
was `0e86b6fd7a6344658ec137ea0070cca99f4e07d7259738f5e8c34809dd1f3f27`. This is artifact validation, not actual host acceptance.
No required implementation check remains failing or hung.

## Coordinator actual QA recipe

Only the coordinator may start actual DEV, replace the plugin in the retained QA
vault/profile, update/revoke QA pairings, or restore original storage settings.
The implementation agent did not touch those resources or read plugin secrets.
Use normal application/window sizes and no model calls.

1. Build, then retain the hash of `apps/obsidian-plugin/dist/main.js`. Run
   `npm run typecheck` and confirm the bundle hash is unchanged and the artifact
   remains CommonJS. Install only this build into the authorized QA plugin folder.
2. Start DEV in the background using `MEMORA_DEV_BACKGROUND=1`. Confirm migration
   30 and the original corpus hashes. Create a new explicitly authorized Obsidian
   QA pairing with editorial scope; an old pairing must request re-pairing rather
   than silently acquire write access. Pair the isolated plugin and resume only
   the bounded synthetic QA scope.
3. Edit source-parent introduction, source-child body, atomic-note title/body and
   wiki title/sections in the actual native editor. Confirm updated canonical
   prose, exact old documents/citations, unchanged child boundaries, independent
   review, preserved human notes and zero implicit processing jobs/model calls.
4. For an empty wiki parent/index, run **Add human section** before typing its
   introduction. The command inserts the stable section markers. If prose was
   already typed outside markers, run the command, open Sync review, reconcile
   the comparison and choose the intended local/manual result. Existing anchored
   sections may contain ordinary Markdown headings and fenced marker examples.
5. With DEV unavailable, edit the same file at least twice, rename a file/folder,
   and edit then delete another file before the typing debounce finishes. Restart
   Obsidian and reconnect. Verify original queued operation IDs, per-file results,
   final text, stable identities and recoverable latest deleted content. A scan
   that merely misses a file must not delete anything.
6. Change a source/page/note in the app while its native editor is open. Test
   independent sections versus overlapping prose/title, changed generated text,
   removed/reordered anchors, unknown reserved metadata and a copied managed ID.
   Inspect base/local/app and try keep-local, keep-app and manual merge in both
   UIs. Edit again after opening comparison: stale confirmation must fail visibly;
   obtain a fresh comparison before resolving. Duplicate detachment deliberately
   preserves an unmanaged local copy and keeps the original canonical identity.
7. Exercise canonical updates with a newer native buffer, receipt interruption,
   reconnect/restart, pause, scope exclusion, revoked pairing, malformed response
   and transport outage. Queue errors remain actionable; generated relations
   cannot become approved through prose. Restore a tombstone through Connections.
   Use the existing application page editor for semantic reparent/reorder and
   verify folder moves do not change that hierarchy.
8. Recheck original hashes, history, evidence, source relationships, job/audit
   counts and built plugin loading after a subsequent typecheck. The coordinator
   must revoke every temporary QA pairing, stop DEV and restore the saved original
   storage/scope safely after acceptance. Commit M5 locally only after real QA and
   final review; then stop without starting M6.

## Release gate and limits

The coordinator completed the actual Obsidian 1.8.10/DEV buffer, file-event,
restart and recovery release gate described above. Filesystem writes and PostgreSQL cannot form one cross-process
transaction; exact compare-and-swap, persistent pending receipts and retained
recovery copies preserve/reveal late saves instead of claiming atomic editor
ownership. Unsupported or ambiguous structures require explicit reconciliation.
A single configured vault is supported. No model benchmark, note merge/split,
advanced graph view or M6 completion is claimed.

**Status: M5 accepted. M6 is deferred; work stops after the M5 local commit.**

## Coordinator acceptance (2026-09-10)

The coordinator exercised the actual Obsidian 1.8.10 editor against the migrated
synthetic DEV database, using only the explicitly authorized temporary QA vault
and pairing. Memora opened behind existing windows at its normal 1600×1200 size;
neither application was maximized. The original pairing was revoked and its
inability to acquire editorial scope implicitly was confirmed before the new
pairing was used.

Native title/prose edits round-tripped for wiki pages, a source chapter and an
atomic note. A metadata-only book gained its own introduction at the same identity
and path, without absorbing its children. Add human section created an anchored
introduction on the empty parent wiki page. Human provenance/protection, distinct
pending review, Markdown hard breaks and indentation were retained. After the
chapter changed, the Memora evidence inspector still displayed the exact old
document and excerpt, explicitly identified as historical.

Editing different sections in the two applications merged automatically. Editing
the same section produced base/local/application comparison; native Keep
application resolved that conflict. An updated local file invalidated an already
open desktop confirmation. A fresh comparison supported manual merging, and
subsequent plugin reconciliation did not overwrite that choice with older queued
snapshots. Invalid manual framing remained an explicit conflict and did not
change the canonical page.

With DEV stopped, the native editor performed repeated note edits, two successive
renames, a page edit followed by recoverable deletion, and a folder rename affecting
two chapters. Actual Obsidian reload preserved the original queued IDs and exact
payloads. All seven original operations replayed successfully, the queue drained,
the latest note text arrived at the final path, and source/wiki parents stayed
unchanged. Connections restored the deleted page with its latest offline text;
no canonical page, note, source or citation was deleted. Byte-identical duplicate
files were detected and explicitly detached as preserved unmanaged copies.

Actual tests also found and corrected sandbox preload bundling, swallowed/stale
transport messages, dependency build ordering, intermediate move replay, dirty
moves, duplicate capture, fresh desktop confirmation and resolution-family
presentation/replay. The plugin build now compiles contracts/translations before
Vite, preventing an old protocol schema from entering an otherwise current
CommonJS bundle. The actual plugin accepted desktop resolution manifests after
this correction.

The original benchmark row hashes remained identical: no original source,
document, chunk, note, note evidence link, source relationship, relationship
evidence, wiki page or wiki revision was lost or unexpectedly changed. At the
acceptance audit, DEV contained 86 sources, 88 documents, 86 chunks, 151 notes,
97 source relationships, 22 wiki pages and 50 wiki revisions, including retained
M4/M5 synthetic QA history. The projection contained 43 managed files and two
unmanaged recovery copies, with no duplicate managed IDs or broken emitted links.
The AI audit count remained 4,896. These deterministic save/sync scenarios run no
LLM or embedding inference, so local/Luna generation comparison is not applicable.

Final coordinator checks: full workspace build/typecheck, **99 suites / 611 tests**,
30-migration seed verification, formatting/diff checks, isolated M4/M5 PostgreSQL
verifiers, source-ingestion/source-relations PostgreSQL verifiers and actual
editor/restart/recovery tests. Migration 0029 was applied and audited in DEV as
well as tested against populated and empty isolated databases. Applied migrations
were not rewritten.

Both temporary QA pairings were revoked and actual reauthentication was refused.
The temporary plugin credentials were cleared after closing the QA instance. DEV
was stopped; the saved original storage preferences were restored without starting
the application, and the QA-only projection scope was removed after retaining its
value in a temporary artifact. Canonical content/history and recovery copies were
kept. The personal Obsidian configuration hash remained unchanged. No push, merge
or M6 work was performed.

Final CommonJS SHA-256: `2a3bac15752c014954e384a0af25a51aa0b21bfcdd5f2ad0ce4adc9eb62c363d`.
The actual host loaded this build and synchronized with no pending edits.
