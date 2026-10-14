# A5 implementation and verification report

Date: 2026-09-12. Status: independently verified and accepted on
`codex/automatic-wiki-a5`. The coordinator completed selected-model semantic
review, native verification and actual DEV migration/data-preservation gates after
the implementing agent released ownership. A6–A8 remain separate milestones.

## Delivered behavior

Native Ask explicitly admits `knowledge-consultation-v2` and offers Answer or
Compare. Omitted versions retain the legacy answer contract. Authorized source
scope is resolved before retrieval, including selected sources, explicit descendant
inclusion, current TOC owners and typed memberships. The new path selects eligible
compiled sections and supported TOC context before raw ranking, then packs each
unit with its complete original lineage. It retains six compiled-unit and twelve
original-passage bounds without the legacy 500-source universe cutoff. Source
counts describe the authorized scope; inference audit IDs identify actual admitted
originals. Library and legacy evidence ranking were not changed.

Current section assessments, exact originals and transitive dependencies are
validated before inference and again before save/apply. Mixed-source assertions,
unsupported or human-edited nested prose, rejected/archived notes, incompatible
primary/link ownership and superseded originals are excluded. Missing vectors
retain text retrieval. Generated prose and TOCs are never counted as independent
corroboration. Explicit reviewed-only mode remains distinct from exploration.

Ask retains its twenty-answer, thirty-minute transient cache, cancellation and
120-second FIFO-inclusive deadline. Reusing a live request ID cannot replace a
different question. Save reuses its existing idempotent proposal and canonical
inference audits. Follow is a separate explicit action: it creates a synthesis
page with investigation role plus persistent question/scope/history, without
another inference or creating source material. Page gaps use the same localized
save builder as one-off answers. Newly written answer sections remain unreviewed
and unassessed; valid citation handles do not qualify them as machine checked.

Follow requires an enabled policy that explicitly grants `refresh_investigation`.
New setup previews disclose this grant; old policy revisions retain their original
operations. The current question, answer, prior answers, changed understanding,
evidence, gaps and paused/resolved/awaiting-evidence state are available natively.
Answer selection has a bounded Back stack with scroll restoration; evidence closes
before answer history, and hidden workspaces retain the shared Back-router behavior.
Followed-page retention is distinct from one-off proposal state: reading a current
or prior followed answer does not show the generic proposal review list.
A successor no-match message describes the absence of selected relevant originals
without asserting that the library has no original material; legacy copy is retained.
Controls and new prompt metadata cover all five locales. Stored content keeps its
own language and gap headings use the admitted generation language.

Investigations run inside the existing automatic maintenance pass after its curator
deliveries settle. Their calls are organization run/step identities using the same
AI service FIFO, occurrence allowance, policy monthly ledger, effective profile,
prompt pin and monotonic clock. They do not add a scheduler or inference queue.
Generic topic/index curation excludes investigation pages. Changes can still
invalidate other legitimate consumers.

Input fingerprints cover consumed originals and compiled content, applicable
prompt composition/provider fragments, effective model parameters and language.
Unchanged/irrelevant inspections make no model call. A meaningful change preserves
its explanation and previous answer, and emits a notification only after successful
canonical completion. A no-change evaluation still refreshes current original
citations and the answer-page revision. Evidence removal retains the historical
answer with a stale disclosure and a persistent no-model awaiting-evidence receipt.

Follow/apply share placement → policy → investigation/identity lock ordering.
Expected answer revisions, policy/scope, originals and protection are checked inside
the final transaction; no transaction waits for inference. Pause/resolve revoke
active apply. Delivery acknowledgment uses the IDs captured before inspection,
protecting later arrivals. A never-started budget deferral can resume the same
canonical run and admitted pin in a later eligible occurrence only when no previous
reservation or audit exists for it. Prior deferrals remain in the checkpoint, and
no charged step is transferred or refunded. Startup settles orphaned evaluation
and organization-run states together; a started uncertain call is not replayed.

## Persistence and migration

Generated migration `0037_flawless_norrin_radd` adds `wiki_investigations` and
`wiki_investigation_evaluations`, their restrictive ownership FKs, identity/history
indexes, state check and canonical event enrollment trigger. The generated custom
forward migration `0038_investigation_descendant_impacts` extends that trigger to
new descendants of an explicitly followed source. Migration 0037 was preserved
once the coordinator froze its first selected-model trial.

The journal and empty baseline are synchronized at **39 migrations**. The A5
PostgreSQL verifier exercises both a populated schema-37 upgrade retaining a human
page/history and an empty baseline, then runs the behavioral gates on each. No
regular DEV database, real library, model configuration or vault was changed by
the implementing agent. The coordinator's separate DEV backup/migration receipts
remain authoritative for actual user-data preservation.

## Checks actually run

- `npm run typecheck` — passed.
- `npm test` — 123 files and 791 tests passed, including all existing 783 tests
  plus eight successor consultation/caller/fingerprint tests.
- `npm run build` — full workspace build passed; the desktop build executed the
  sandbox preload verifier with only Electron available. The coordinator froze
  the schema-39/shipped-2 native output independently.
- `npm run db:seed:verify` — 39-migration baseline passed.
- `npm run format:check` and `git diff --check` — passed.
- `node --import tsx scripts/verify-automatic-wiki-a5.ts` — populated and empty
  PostgreSQL passed. It covers compiled-first packing despite unrelated ranked
  originals; 65 excluded matching pages; more than 500 canonical sources and a
  distant selected TOC owner; reviewed/exploratory and mixed/transitive-scope
  eligibility; exact original expansion; transient Ask; concurrent Save/Follow;
  source-C refresh once; irrelevant/unchanged zero calls; evidence-only current
  revisions; missing-evidence receipts; pause/restart; captured delivery high-water;
  next-occurrence budget resume; new-descendant enrollment; uncertain-run recovery;
  and pause after inference preventing canonical apply.
- `node --import tsx scripts/verify-automatic-wiki.ts`,
  `scripts/verify-automatic-wiki-a3.ts` and `scripts/verify-automatic-wiki-a4.ts` —
  all populated/empty milestone regressions passed.
- The same Node/tsx invocation passed `scripts/verify-second-brain-m3.ts`,
  `scripts/verify-maintenance.ts`, `scripts/verify-wiki.ts`,
  `scripts/verify-organization.ts`, `scripts/verify-prompts.ts`,
  `scripts/verify-obsidian-wiki.ts` and `scripts/verify-obsidian-editing.ts`.
  These checks used disposable PostgreSQL and deterministic model doubles.

Every verifier-owned PostgreSQL process was stopped and its temporary database
removed by the verifier's cleanup. No real model/runtime was started by the agent.

## Selected-model validation history

The coordinator's preserved `a5-trial-investigations-luna-01` used schema 38 and
seven actual admissions. Its read-only/compiled/text-fallback Ask, explicit Follow,
source-C refresh, history, reservations and unchanged no-call behavior passed the
functional checks. Semantic acceptance failed because one generated paragraph
incorrectly called its own synthesis a human interpretation. This is a retained
failure, not accepted A5 evidence.

`consultation.knowledge`, `consultation.investigation` and `consultation.gaps` now
publish `shipped-2`. They explicitly distinguish original findings, supplied
personal-authorship context and newly generated AI inference. Human verification
alone is not human authorship. Admitted shipped-1 pins remain unchanged. Registered
comparison and repair leaves remain part of the actual composition and samples.

The coordinator accepted the schema-39/shipped-2 continuation functionally and
semantically: one actual Luna call reported 2,515 input tokens, 402 output tokens
and 8,825 ms, with context 128,000 and unavailable monetary cost. It corrected the
attribution while preserving the A/C disagreement and the separate B finding.
Upkeep took 120,243 ms including delivery drain/debounce; the unchanged repeat
took 339 ms and made zero calls. Three history entries, old pins, human prose
and optional-artifact counts were preserved. Trials 01 and 03 used eight total
actual calls; trial 02 used zero. Native and actual DEV acceptance followed the
agent handoff and are recorded below. A helper-only directory race in attempt 02 occurred
before any database/model call and is preserved separately; it was not an app
failure. This report does not claim that the user reviewed new model output.

## Durable specification

Updated `rules/second-brain.md`, `rules/database.md`,
`rules/jobs-and-processing.md` and `rules/frontend-and-i18n.md` describe successor
scope/provenance, explicit retention, refresh ownership, shared reservations,
recovery, notifications and native Back behavior. No technology, dependency or
runtime version changed. Actual DEV migration, native acceptance and coordinator
commit/integration remain outside the implementing agent's authority.

## Independent coordinator acceptance

After the agent released ownership, the coordinator independently passed the
791-test/123-file suite, typecheck, A5 populated/empty PostgreSQL, A4/A3/A2,
legacy M3/wiki/organization/maintenance, prompt catalog, AI-context and both
Obsidian projection/editorial PostgreSQL verifiers. The 39-migration baseline,
format check and diff whitespace check passed. These disposable databases were
closed and cleaned up. No verifier invoked a real model. A final Italian copy
clarification distinguishes automatic matching from the new source-comparison
function; the i18n and desktop builds plus sandbox preload passed afterward.

Native checks used frozen local DEV builds and an isolated copy of the synthetic
trial database. They covered English, Portuguese, Italian, French and Spanish,
light/dark themes, the normal 1600 × 1200 window and 960 × 640 minimum. No window
was maximized or fullscreen. The collapsed icon menu and 400-pixel adjustable
tree remained usable; keyboard resizing and persistence were verified. Current
and previous answers, exact evidence, source return, close-layer order and retained
answer state worked with native Alt-Left. Physical mouse side-button clicks were
not directly available in CUA; the shared router's tests cover that input path.

One native Source comparison invoked the configured Luna route and its actual
comparison prompt, with the single permitted repair: 4,079 input tokens, 780
output tokens and 23,533 ms summed provider duration across two calls. The final
answer preserved A/C disagreement, the separate supplied B comparison, missing
details and AI authorship. Save created an awaiting-review proposal; Follow
created a separate answer page. Save, Follow, Pause, Resolve, Resume and the final
Pause added no calls. A no-match query also added no audit or page. The policy
was resumed through the canonical repository solely as synthetic fixture setup;
native policy activation is not claimed by this test. Both investigations and
the parent policy were paused afterward, and their answers survived restart.

All A5 actual trials and native validation together used **10 calls**, with
context **128,000** in every audit, 21,488 reported input tokens and 4,021 output
tokens. Monetary cost remained unavailable. The failed attribution from trial 01
and the zero-call helper failure from trial 02 remain preserved; neither is
misrepresented as a successful semantic result. No new local model runtime or
real user material was used for these trials.

The regular DEV cluster was upgraded **37 → 39** with only the two forward A5
migrations. The coordinator freshly restored the verified pre-A5 dump and
compared every pre-existing column and row across **95 tables** before and after
migration. All canonical digests matched. Catalog checks verified the 28 new
columns, seven indexes, four restrictive foreign keys, enrollment trigger and
AGE/pgvector extensions. The new investigation tables remained empty.
The preserved regular DEV inventory is 13 sources, 13 documents, 10 chunks,
335 AI audits, 42 vectors and **zero wiki pages**. Migration made zero model
calls, executed zero jobs and activated zero policies; the cluster stopped cleanly.

Local coordinator receipts are `a5-trial01-coordinator-review.json`,
`a5-trial03-coordinator-review.json`, `a5-native-retention-receipt.json`,
`a5-native-coordinator-review.json`, `a5-dev-catalog-verification.json` and
`a5-dev-migration-result.json` under the ignored acceptance directory. The native
release snapshot includes the final Italian clarification. Real temporary-vault
layout/editor testing remains an A6 gate, rather than an A5 completion claim.
