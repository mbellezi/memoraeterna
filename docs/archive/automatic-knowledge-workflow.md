# Automatic knowledge workflow

Implementation acceptance checklist for the agreed successor experience.

- [x] 1. Automatic-only ingestion, without a page title or manual mode.
- [x] 2. Idempotent initial Wiki areas and preservation-aware existing-library placement.
- [x] 3. Full processing includes Wiki integration.
- [x] 4. Dedicated knowledge automation navigation entry.
- [x] 5. Unified tasks, schedules, harness and operational configuration.
- [x] 6. Visible queued, scheduled, deferred, budget-blocked and failed work.
- [x] 7. Obsidian mirrors changes whenever enabled and configured.
- [x] 8. Installed enabled default routines await model configuration.
- [x] 9. Full language names in model-facing prompt instructions.
- [x] 10. Central readiness with actionable configuration links.
- [x] 11. Whole-unit budget planning before inference.
- [x] 12. Automatic recovery of temporary blockers without replaying uncertain calls.
- [x] 13. Source-to-Wiki-to-Obsidian journey visibility.
- [x] 14. Incremental integration and shared generation deduplication.
- [x] 15. Unified human decisions with preserved proposals and conflicts.
- [x] 16. Remove the legacy title-driven generation entry points.
- [x] 17. One maintenance operations surface; historical records remain readable.
- [x] 18. Direct operational configuration replaces the activation ritual.
- [x] 19. Initial coverage is ordinary scheduled work.
- [x] 20. Consistent names and truthful completion indicators.

Validation records are added after checks run. This document does not authorize
commits or replace the domain specifications.

## Verification

- npm run typecheck: passed.
- npm test: 130 files, 825 tests passed.
- npm run build: passed, including sandbox-preload verification and the Obsidian bundle.
- npm run format:check and git diff --check: passed.
- scripts/verify-knowledge-automation.ts: passed against an isolated PostgreSQL
  instance. Covers idempotent startup, preservation of existing human sections and
  revision history, enabled schedules without a model, automatic admission after
  model configuration, budget preflight, serialized/idempotent curator admission,
  paginated grouped delivery inspection and portable mirror paths/prose.
- Native DEV observations: automatic-only full-processing form, initial areas,
  preserved existing topic under Themes, schedule controls/readiness, grouped
  pending work and the embedded operational prompt catalog.
- The current local library was adapted through the startup path. The existing
  topic and reading-index IDs survived; the topic's prior/current sections and
  automatic navigation content compared equal. No schema migration was required.
- A cold database copy was made before adaptation at
  /private/tmp/memora-before-automation-7Y8U0v/database. This is a local temporary
  recovery copy, not a verified portable backup restoration.
- Verification uses synthetic model execution where needed; it does not claim a
  new quality certification for every configured model or a native Obsidian editor
  conflict test. Existing registered vault paths remain governed by reviewed
  migration and conflict handling.
- Historical failed, uncertain, rejected and budget-limited runs remain recorded.
  Routine defaults do not replay their provider calls or reset spent allowances.

No commit was created.

## Budget controls follow-up

Knowledge automation now has a Budget subpage shared with the schedule policy
selector. It exposes the monthly calls/token ceiling, reserved and remaining
capacity, all seven curator-group limits, numeric ranges, and a shortcut back to
per-routine limits. Changes are saved explicitly; native review retained the
current library's configured values.

Monthly edits compare every active routine revision and update the shared ceiling
under the same policy lock as call reservations. Capacity checks and future call
reservations use that live ceiling. Admitted occurrence snapshots, per-occurrence
limits, calendar dates, pause state, recorded usage and uncertain-call history stay
intact. A reduced ceiling cannot refund prior usage. New scope bindings inherit the
current ceiling, and a stale configuration preview cannot restore an older budget.
Curator limits use normal preview/activation and retain a paused policy.

Validation for this follow-up:

- `npm test`: 131 files, 833 tests passed, including loopback gateway/OAuth tests.
- `npm run typecheck`, workspace build, final desktop build with sandbox preload
  verification, `npm run format:check`, and `git diff --check` passed.
- `scripts/verify-knowledge-automation.ts`: isolated PostgreSQL checks cover shared
  edits through the service command, concurrent/stale saves, live reservation and
  preflight enforcement, idempotent reservations, immutable admitted snapshots,
  retained ledger, inherited budgets, paused curator configuration and rejection
  of stale previews. No actual model was called by this verifier.
- Native DEV review confirmed the Budget subpage, schedule shortcut, preserved
  values, loading/successful reads, numeric validation, disabled invalid saves,
  theme-aligned usage indicators and responsive form layout at normal window size.
- No schema migration or commit was created. Durable rules are recorded in
  `rules/automatic-knowledge-workflow.md` and `rules/second-brain.md`.

## Task history and blocked-analysis follow-up

The automatic-maintenance reader now distinguishes actual human review from a
blocked child analysis while preserving the historical execution state and
inference guards. Occurrence, bootstrap and impact-delivery links resolve the
exact child. Its validation diagnostics appear in the run details, alongside an
Open blocking analysis or Review proposal action. Source-faithfulness rejection
has separate product copy from structural evidence-validation failures. Analysis
details remain read-only when the proposal failed its support check.

A shared Clear task history button is available at the top of Tasks and Knowledge
automation. It dismisses completed, failed and canceled execution histories using
an atomic display cutoff and the existing job dismissal marker. Active canonical
work remains visible even when its dispatcher job already succeeded. Pending
reviews, blocked work, current impact deliveries and schedules are preserved.
History cleanup does not delete canonical audits, proposals, evidence, uncertain
calls or budget reservations, and later state changes remain visible. Exact
result lookup and last-result inspection remain available.

Validation:

- `npm test`: 132 files and 839 tests passed; the final analysis-title adjustment
  also passed its 13 focused UI tests.
- Typecheck, workspace build, desktop sandbox-preload verification, formatting and
  diff checks passed.
- The isolated PostgreSQL verifier passed blocked/review classification, linked
  diagnostics, completed/canceled cleanup, pending-review preservation, unchanged
  record/reservation counts and visibility of later completions. It invokes no
  actual model and does not touch the user's library or history.
- Native DEV review confirmed Blocked labels, the concrete failed-check diagnostic,
  navigation to the associated analysis with before/after text, and the shared
  cleanup button. The actual history was not cleared during native review.
- Rules updated: `rules/automatic-knowledge-workflow.md` and
  `rules/jobs-and-processing.md`. No schema migration or commit was created.

## Terminal rejection and contextual feedback — 2026-09-14

The recurring cards reported at 00:07 were new maintenance occurrences pointing
to the retained 23:21 curator failure, with zero model calls of their own. The
curator run and impact delivery survived cancellation and display cleanup, but
new occurrence admission did not check that retained decision first.

Automatic and manual admissions now check the retained outcome under the policy
lock. Exhausted validation failures receive a terminal `rejected` status and
explicit `automatic_validation` provenance. Existing non-actionable waiting
occurrences and bootstraps are reconciled; canceled history remains canceled.
Impact deliveries acknowledge a negative outcome linked to the original run and
input fingerprint. This never claims that the source was integrated. Navigation
impacts are reconciled and dismissed before this admission check so administrative
backfill cannot appear to be new semantic work.

The schedules page explains the retained outcome, exposes the original analysis
and disables another attempt for those same inputs. Genuine proposals retain
review actions. Rejected outcomes leave the Decisions queue and remain available
in task history and exact result lookup. Clearing history cannot reset rejection,
source provenance or consumed reservations.

Future eligible curator admissions can include bounded, source-scoped validation
feedback: at most four earlier automatic rejections, two diagnostics each,
800-character affected draft excerpts and a 6,000-character total serialization
budget. Exact source/document/chunk identities and original hashes remain bound
to the earlier analysis. The whole historical source scope must fit the new
admitted scope. Feedback is pinned in the new snapshot, included in normal context
planning, marked as historical non-evidence and shown in analysis details.
Technical/uncertain failures do not become content lessons. Registering feedback
creates no impact and is excluded from input identity, preventing self-triggered
retries. Current originals and the complete support gate still control apply.

Validation:

- The isolated admission verifier passed 13 checks covering rejection reconciliation,
  canceled/history preservation, repeated timer/manual calls, month/routine edits,
  immutable source feedback, context bounds, scope exclusion, negative receipts,
  genuine new inputs, new policy generations and absence of new impact events.
- The existing isolated automation verifier passed all 22 checks for startup,
  budget, mirror, attention and display cleanup behavior. Neither verifier called
  an actual model or modified the user's library.
- Native DEV inspection confirmed zero pending decisions, the retained-result
  schedules notice and the original analysis labeled Rejected by automatic
  validation with its specific diagnosis and original text. The known analysis
  retains four calls; its repeated maintenance occurrence is now rejected, while
  older canceled occurrences remain unchanged. History was not cleared during
  this inspection.
- Rules updated: `rules/automatic-knowledge-workflow.md`,
  `rules/jobs-and-processing.md` and `rules/second-brain.md`.
- No schema migration or commit was created.
- Final verification: 134 test files / 858 tests passed, along with typecheck,
  workspace build, sandbox-preload verification, format and diff checks. Two
  successive native DEV reads retained four curator runs, 163 canonical AI audits,
  seven maintenance occurrences and zero active jobs; reconciliation created no
  additional inference or occurrence.

## Source journey read failure — 2026-09-14

The Sources tab failed because `coalesce(ingestion_runs.status, 'imported')`
forced its display-only fallback into the PostgreSQL ingestion status enum.
The query now casts the persisted status to text before applying that fallback;
canonical ingestion states and stored data are unchanged.

Source journey loading now settles on failure, provides a localized retry action,
preserves the last loaded page during refresh errors and avoids overlapping
polling requests. Regression checks cover loading, failure, retry presentation,
empty and retained-data states in all five locales, plus execution of the real
SQL against empty, imported-only and processed-source PostgreSQL fixtures.
Typecheck, desktop build, sandbox preload, formatting and diff checks passed.
This implements existing database and frontend rules; no durable specification
or schema changed, and no commit was created.

## Prompt variable highlight alignment — 2026-09-14

The textarea's native scrollbar reduced its text viewport by 15 pixels while the
highlight layer used the full container width. Long prompt lines wrapped at
unequal positions, producing highlights on plain words or empty space. The layer
now uses the textarea client width/height and resynchronizes on text changes,
resize and scroll. Prompt templates, saved revisions and inference are unchanged.

Verification: four prompt-editor unit tests, typecheck, desktop build and sandbox
preload passed. The isolated Electron renderer verifier checks exact token ranges
against plain-text geometry at two widths and three scroll positions for a real
catalog prompt and a Unicode/escaped-percent fixture (12 cases). Native DEV
inspection confirmed aligned policy/group/current-page variables in the user's
selected prompt after scrolling. The frontend rule now requires matching client
viewports and renderer geometry checks. No migration or commit was created.

## Reinstall defaults after Reset everything — 2026-09-14

Reset cleared the automatic policy/schedules and reloaded the renderer, but only
application startup invoked their initialization. The reset service now awaits a
required default-restoration callback after cleanup. Startup and reset share the
same initializer for prompt runtime, investigation recovery and automatic Wiki
setup. A reset reports success only after default installation; background services
resume only after successful completion, including restoration. Failed resets keep
those services stopped until a successful retry or application restart.

Verification: reset-service tests check restoration after database commit and file
cleanup, and no restoration when deletion is refused. The PostgreSQL automation
verifier executes a full reset against disposable storage with AGE, then confirms
four enabled routines, Wiki areas, missing-model readiness, no inference, empty
sources and idempotent reinitialization. Typecheck, desktop build, sandbox preload,
format and diff checks passed. Reset behavior was updated in the security/privacy
and automatic-workflow rules. No migration or commit was created. The user's DEV
was reopened to recover missing defaults; no additional user-data reset was run.
