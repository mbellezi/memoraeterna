# A1 implementation report: application prompt catalog

Status: independently verified and accepted on 2026-09-12. A2–A8
remain planned. This report distinguishes deterministic implementation evidence
from native inspection and selected-model semantic evaluation.

## Delivered behavior

`PromptService` is the PostgreSQL-backed authority for immutable revisions,
activations, validation receipts, reset and restoration. The registry includes all
existing summary, note, graph, identity, relation-label, source-matching,
organization, consultation and maintenance families; repairs and state fragments;
shared output/relation language; app-owned Codex adapter instructions; local
model diagnostics; embedding query prefixes and chunk/note/entity/relation/catalog
serializers. Existing execution callers render registered fields. Required output
contracts remain visible and enforced; source values render once and cannot
become template instructions.

Settings > Prompts provides a searchable tree, catalog-wide state filters,
function/domain inheritance, safe variable examples and documentation beneath each
field, insertion at the caret, token highlighting, errors, actual synthetic
composition previews, provider-specific instruction disclosure, history,
comparison, draft saving, validation, bounded samples, activation and reset.
Metadata and labels use all five existing locales. Organization retains domain
management and schedules; organization/maintenance links select their relevant
prompt and domain. The old instruction mutation IPC no longer supplies an
independent editor authority.

Source-free prompt pins are stored at job/run admission and inherited by pipeline
children. Repairs, queued execution and restarted runs retain those templates and
revision references. Canonical inference records contain composition metadata on
success and started failures/cancellation. Canceling before FIFO execution does
not create a model call or inference audit. Request-scoped provenance prevents
same-text revisions or a long queue from borrowing another call's metadata.

Global/shared validation covers distinct effective function/domain compositions,
including a shadowed revision before a future reset could reveal it. Activation
rechecks its expected scope pointer and composition validation under the same SQL
lock. Samples use existing routes and validators. Each explicit batch permits 12
calls and five minutes; cumulative limits are 256 calls, 2,000,000 input characters
and 1,048,576 reserved output tokens, with at most 4,096 output tokens per call.
Persisted reservations, audit IDs, successful cases and organization checkpoints
allow an explicit next batch to resume. Missing models preserve drafts and cannot
authorize required samples.

## Persistence and compatibility

Generated Drizzle migration `0030_damp_phil_sheldon` adds prompt revisions,
activations and validations, the canonical `ai_task_runs.prompt_compositions`
column, and the job-admission pin trigger. The journal and baseline seed are
synchronized at 31 migrations. The verifier checks the three catalog tables,
seven indexes, two foreign keys, JSON audit column and trigger.

Legacy migration preserves all revision/activation history and the explicit active
pointer, including rollback to an older revision. Full configuration replacement
emits resets for omitted overrides and removed domains. Unknown legacy braces
remain literal under a versioned compatibility mapping; only known title/language
placeholders are translated. Previously active ambiguous prose retains equivalent
behavior, while never-activated ambiguous text remains a recoverable draft. Old
queued payloads and run snapshots are not rewritten.

Embedding compatibility uses frozen legacy-equivalent input fingerprints. Actual
instruction/serialization changes alter compatible spaces; unrelated generation
or language edits do not. Vector consumers check provider, runtime, model,
dimensions and effective strategy/space. Existing legacy `native` rows without
provable space identity remain stored but are excluded from semantic comparisons.
Lexical retrieval remains available. Library exposes its existing
`embeddingNeedsRefresh` indicator in `LibraryView`; this is not a promise that all
old vectors remain semantically eligible. There is no vector migration/backfill,
reindex, deletion or automatic processing triggered by prompt activation.

Artifact reuse reads current artifact owners. Summary generation failures cannot
certify an older summary; incomplete note replacement cannot borrow an older
complete generation; no-write attempts preserve untouched old notes. Graph
replacement and its generation receipt share one transaction, including empty
output. Completed zero-output stages are ordered by their own completion time,
not unrelated later updates to the ingestion run. Provider-specific artifact
fingerprints include Codex wording only when applicable to the selected provider.

## Verification evidence

- `npm run typecheck`: passed.
- Complete Vitest suite: 113 files / 711 tests passed (including the independent-gate envelope regression).
- The three A0 rendered-output golden tests passed unchanged. The obsolete A0
  source-expression inventory was retired after migration; registry coverage and
  actual caller/repair spies replace it as runtime evidence.
- `prompt-catalog-renderer`, `prompt-catalog-ai`, `prompt-catalog-callers`,
  `prompt-samples`, editor tests and existing owner suites cover typed examples,
  five-locale metadata, contract removal, one-pass rendering, active edits,
  identical-byte/different-revision audits, FIFO delay/activation, exact note/chunk
  serialization, restarted organization state/repair, consultation repair, all three
  maintenance routines, graph/identity/label/source repairs and bounded sample
  resume/ceiling behavior. Model outputs are deterministic doubles.
- `node --import tsx scripts/verify-prompts.ts`: passed on disposable real
  PostgreSQL populated upgrade and empty baseline. It includes migration history,
  literal legacy compatibility/active-pointer rollback, parent/child pins,
  all-domain validation and activation conflict, no automatic vector work,
  chunk/note/Library space filtering, artifact ownership, partial note writes,
  graph receipt rollback and stage-completion ordering. Storage sample receipts
  are explicit deterministic fixtures; actual runner behavior is tested separately.
- Existing real PostgreSQL verifiers for wiki, organization, second-brain M3 and
  maintenance passed with their behavior assertions retained. The maintenance
  verifier's obsolete hardcoded migration total now follows the journal.
- Seed verifier passed with 31 migrations. Format check passed.
- Workspace build passed. The desktop build now executes the built sandbox preload
  with only Electron available and asserts that the prompt IPC surface initializes;
  this prevents a transitive workspace dependency from breaking native startup.

The coordinator independently inspected an isolated empty local DEV profile at
1600 × 1200 and 960 × 640, windowed throughout, in five locales and both themes.
Observed cases include per-field documentation, invalid draft persistence and
filtering, missing-model error with zero calls, backend activation rejection,
keyboard tree traversal and sidebar overflow correction. Fresh native rechecks of
updated catalog labels, failed-sample activation state and unique tree identities
passed. A guidance revision was validated, activated and reset through the native
editor without inference; both revisions remained in history. The deterministic
validation notice no longer implies that sample-exempt guidance requires inference.
No real inference or user vault operation was performed for A1 acceptance.

## Specification updates

Updated AI/knowledge, processing jobs, database, monitoring, second-brain,
frontend/i18n, search and architecture rules for the implemented catalog,
admission/audit, compatibility, artifact ownership, editor and preload contracts.
The only added package relationship is the existing browser-safe `@app/i18n`
package supplying localized registry metadata to `@app/domain`. No external
dependency, model framework, hosted service or new processing authority was added.

## Independent-gate correction: non-AI job envelopes

The independent gate found that the catalog admission trigger also attaches a pin
to non-AI jobs. The strict Obsidian wiki payload parser rejected that metadata and,
after a failed attempt, the supervisor's `errorHistory`. A shared task-envelope
extractor now separates only `promptPin`, `errorHistory` and
`dashboardDismissedAt` before strict task validation and worker dispatch. Direct
Obsidian wiki/managed-writer entrypoints follow the same boundary. Other unknown
task fields still fail; persisted admission and error history remain unchanged.

The Obsidian wiki real PostgreSQL/temporary-vault verifier now initializes the
catalog, executes a freshly persisted projection job, executes its persisted retry
with monitoring metadata, exercises a persisted managed-writer job and rejects
unknown task fields. It confirms zero AI audits. The complete existing projection,
conflict, receipt/recovery and containment checks passed. Migration 0030, its SQL
hash, journal and baseline were not changed by this correction; the coordinator
reported that it had already been applied to regular DEV before this correction.
The implementation agent used only disposable databases and the verifier's
explicit temporary vault during this gate fix.

## Final coordinator acceptance

The coordinator independently ran the complete suite (113 files, 711 tests),
typecheck, format, workspace build including sandbox-preload execution, the
31-migration seed check, and the prompt, wiki, organization, M3, maintenance and
Obsidian wiki PostgreSQL verifiers. The envelope correction was rechecked with
the full suite, build and actual persisted-job temporary-vault regression.

Regular DEV already recorded migration 0030 before the controlled gate. Its
idempotent database startup and final catalog initialization passed with 31
migrations. Row digests matched a restored pre-A1 backup for canonical sources,
documents, chunks, summaries, profiles/routes, old AI audits, all vector tables,
wiki records and legacy organization history. The preserved content includes
13 sources, 13 documents, 10 chunks, seven summaries, 42 vectors and 335 AI audits;
the wiki remains empty after the authorized A0 cleanup. The acceptance helper
executed no jobs or model calls and changed none of its before/after data digests.

A local-model metadata refresh and one failed Obsidian wiki job were already
present before this gate; they were preserved rather than rewritten. The failure
was the envelope-validation regression reproduced and corrected above. Its old
failure remains in execution history; acceptance did not retry the user's vault.
Native acceptance used only the isolated empty DEV profile, in windows no larger
than the standard 1600 by 1200 and down to 960 by 640; fullscreen was never used.
