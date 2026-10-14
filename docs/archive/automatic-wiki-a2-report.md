# A2 implementation report: automatic curation and native reading

Status: independently verified and accepted, including the selected-model and native
window gates and the requested collapsible menu/resizable tree. This report makes
no A3–A8 completion claim. Delivery uses the dedicated local DEV milestone branch.
The coordinator applied migration 0031 to regular DEV after backup/hash verification.

## Implemented slice

`OrganizationService` dispatches `wiki-curator-v2` to a bounded successor while
preserving legacy single-page organization and maintenance readers/executors.
It reuses organization jobs, the existing supervisor, one inference FIFO,
`AiService` adapters, organization checkpoints/proposals/steps and canonical AI
audits. There is no new inference queue, model framework or source store.

A deliberate source-policy preview shows effective scope, model and permissions.
Activation is explicit and starts no inference. Native "Integrate selected material"
discovers a useful topic without a user-entered title. Optional selected existing
notes remain distinct identities; originals-only runs read the same complete source
passages without enabling another processing stage. The `integrateWiki` version-2
processing choice uses the existing `organizeKnowledge` stage and its selected-stage
barriers. It carries an enabled policy revision and source-free admitted prompt pin.

The model-only transport separates topics and indexes. The backend resolves short
navigation handles and original citation handles independently, fills the exact
A0 `CuratorChangeSetSchema` envelope and validates original lineage, scope, revisions,
roles and protections. Curation has three deterministic bounded reads followed by
synthesis and a separate complete semantic-support check. One repair is shared by
draft structure, semantic rejection and invalid support verdicts. All prompt text, contracts, repair feedback
and reference-guide variables are registered in the A1 catalog and all five locales.
Catalog sample activation invokes the actual successor parser/validator.

A coherent group commits identities, revisions, sections, assessments, TOC groups,
ordered typed memberships, dependencies and its receipt transactionally. Apply
rechecks source hierarchy, current policy/model grant, cancellation, exact original
hashes and every admitted reference under locks. Conflicts never apply a valid
subset. Receipt replay and unchanged input produce no duplicate topic/index/note.
Failed/unfinished identical admissions reuse their existing run and allowance.

Structurally valid candidates persist before semantic review. Apply requires a
positive check covering every target, including prose, metadata, TOC labels and
membership attribution, tied to the exact proposal hash and canonical AI audit.
Unsupported candidates remain inspectable; human group approval cannot bypass the
support gate. The support prompt accepts faithful editorial grouping and rejects
concrete unsupported claims, rather than style or hypothetical reader confusion.

New sections are visibly generated and unreviewed. Their assessment records exact
original-reference checks and support assessed by the selected model, with its
audit identity; it does not claim human review or guaranteed entailment. Structural-
only drafts do not qualify as current unreviewed consultation evidence. Native version-2
section edits protect the changed section; pin/placement-only saves preserve exact
section revision, provenance, assessment and dependencies. Old full-save and
Obsidian v1 contracts remain supported.

The native workspace has expandable keyboard theme navigation, page/index reading,
typed existing note/source/entity/page links, note original-excerpt inspection and
Back through the existing mounted source-detail journey. Proposal review displays
actual ordered memberships, source excerpts and before/after section text. Setup
and activity retain loading, no-model, error, partial and review states.

## Bounds and persistence

A0 ceilings remain three targets, six section patches per target, twelve complete
original passages, twenty tool actions, twenty-one model admissions including one
repair, and ten minutes from admission including FIFO waiting. This slice normally
uses five tool actions and two model calls. A repaired unsupported draft uses seven
tool actions and four calls; a repaired schema/verdict uses six actions and three
calls. Output reservation is at most 2,048 tokens for synthesis/repair and 1,024 for
support checking; lower model limits apply. Calls and reported usage
remain cumulative across recovery. Missing tokens/cost stay unavailable. Repairs
preserve the full invalid output in the checkpoint but may omit that entire draft
from model context to keep complete originals within the selected context limit.

Generated migration `0031_luxuriant_nova` adds six tables for policy revisions and
activations, TOC groups/memberships, exact section assessments and group receipts;
it adds query columns and a unique TOC owner index to existing wiki pages. The
baseline/manifest/journal cover 32 migrations. Migration 0030 is unchanged.
Conservative management backfill preserves immutable old revisions and protections;
it activates no policy. Its existing statement-level projection trigger advances
the empty baseline projection clock once, from two to three. There is no vector
backfill, reindex, source deletion, evidence deletion or vault-layout migration.

`@app/db` now references the existing `@app/domain` workspace package for shared
canonical validation. No external dependency was added.

## Executed checks

- `npm run typecheck` passed.
- The final full suite passed with 115 files / 739 tests, including semantic-check
  recovery, concrete negative assertion/classification verdicts and scoped complete
  original lineage in the review view.
- Successor/caller tests cover exact A0 fixture proposals, unknown scope/reference/
  evidence/revision rejection, independent processing stages, pinned repair,
  cumulative deadline/repair/call ceilings, pre-provider failure versus uncertain
  inference, completed-result recovery after cancellation, real catalog sample
  dispatch and complete repair-context evidence. Semantic cases cover complete
  verdict coverage, shared repair, persistent rejection, no approval bypass, exact
  proposal/audit binding and positive sample capability.
- Native component/forest tests cover loading and all five locales, a single roving
  tree tab stop, collapsed branches, and missing/archived/cyclic parent visibility.
- `scripts/verify-automatic-wiki.ts` passed on disposable real PostgreSQL: populated
  31→32 upgrade retaining old human/generated/protected history, and an empty baseline.
  Both independent fixtures consume A0 mixed-library/first-change-set data. They
  exercise useful topic/source/topic TOCs, shared note identity, exact original
  inspection, unchanged rerun/receipt replay, pin/edit assessment preservation,
  protected group review, transaction rollback, concurrent locked original changes,
  changed note-link scope, reparented scope, exact revision conflict with a valid
  support audit, same-title distinct-purpose pages, selected-processing unchanged
  receipt completion, parameter-sensitive admission, late job cancellation,
  native index pin/current TOC query consistency, policy pause, text-only retrieval,
  unknown cost and zero unrelated optional artifacts/jobs.
- Real PostgreSQL verifiers passed for wiki, organization, second-brain M3,
  maintenance, prompts, Obsidian wiki projection and Obsidian editing. These use
  disposable databases and temporary vaults, with deterministic model doubles.
  Existing behavior checks were retained. Mechanical updates account for the new
  TOC index/projection-clock migration and use journal migration totals.
- `npm run db:seed:verify` passed with 32 migrations. Format check passed after
  adding final newlines to generated metadata.
- Complete workspace builds passed, including desktop, extension, plugin and the
  sandbox preload execution check with only Electron available.

All database verifiers require normal local loopback/IPC permissions. Sandbox EPERM
failures were rerun with the project’s normal approved local access. No verifier
used the regular DEV data/vault, downloaded a model or invoked a paid provider.

## Selected-model and native acceptance

Coordinator trials use synthetic A0 materials only, the actual supervisor,
OrganizationService, AiService/FIFO and installed MLX adapters, with isolated
DatabaseService profiles. Canonical results/audits remain under the ignored local
`.cache/automatic-wiki-20260912/a2-trial-*` directories. Real selected-model results
are not replaced by deterministic fixtures.

Early Qwen3-4B trials exposed JSON envelope/role/reference confusion, a repair-context
limit, copied example prose and unsupported metadata. These failures drove removal
of content-bearing examples, the simpler disjoint topic/index transport, bounded
actionable repair feedback and explicit reference/metadata fidelity guidance.
The four 4B prototype trials are retained as failures or unusable outputs; they do
not certify that model as suitable for this workflow.

Initial Qwen3.5-9B trials with inherited generation parameters also failed some
reference/role shapes. The coordinator explicitly selected isolated structured-
output parameters (temperature 0, presence penalty 0, reasoning disabled), without
changing any regular DEV profile or routing. A later selected-note trial applied in
one actual call, preserved optional artifacts and deduplicated rerun, but its
metadata overstated an interaction; that prototype is not treated as final semantic
acceptance. Further prototype metadata errors prompted the separate semantic check,
instead of relying on structural validation or repeated synthesis wording changes.

The first actual semantic-review trial (`originals-9b-04`) used four calls totaling
8,270 input and 2,483 output tokens and 40,657 ms reported inference time. It prevented
apply, but its final check overrejected a faithful repaired neutral topic and included
positive observations as issues. That is a failed quality gate, retained alongside
all prototype failures. The catalog reviewer was calibrated to permit ordinary
editorial grouping and report only concrete unsupported assertions. Actual controls
and complete trials are recorded below. The native inspection passed after the
user unlocked the Mac; all checks remained within the standard opening size.

| Actual local trial | Reported calls / input / output tokens / inference ms | Result |
| --- | --- | --- |
| Faithful positive control on repaired `originals-9b-04` | 1 / 2,349 / 41 / 4,609 | Supported, both targets covered, zero issues; no canonical writes |
| Fabricated clinical permanence/significance/synergy control | 1 / 2,347 / 513 / 9,055 | Rejected with concrete prose/title/purpose/group issues; no canonical writes |
| Complete `originals-9b-05` | 3 / 5,779 / 1,076 / 20,830 | Applied after one schema repair and support check; faithful separate findings and neutral topic/TOC; unchanged rerun made zero calls |
| Complete `notes-9b-05` | 2 / 4,169 / 599 / 13,223 | Structural/transactional success, but semantic acceptance failed: specific retrieval/distribution labels misclassified one source despite faithful prose |
| Complete `notes-9b-06` with scoped review | 4 / 7,301 / 1,717 / 30,742 | Correctly blocked apply, but final review overrejected faithful repaired text; failed model-quality gate |
| Complete `notes-luna-01` through the configured route | 4 / 7,037 / 2,030 / 43,509 | Faithful topic/index candidate, but invalid review requested renaming an existing read-only note; no apply |

The referenced local 9B trials reported cost zero, preserved protected human and optional
artifacts and retained existing identities. Luna pricing was unavailable and is not zero.
The local notes result is a retained failed
semantic prototype, not an accepted gate. It prompted a generic classification
check: a broad editorial umbrella may group distinct work, but a specific mechanism
or variable heading must fit every linked member's own originals. Additional
classification controls and complete trials are recorded below.
An initial subtle-control attempt returned truncated malformed verdict JSON, so it
does not count as a control pass. The support output contract now asks for at most
four distinct concise issues within its existing 1,024-token reservation; broader
runtime validation bounds remain compatible with already persisted trial verdicts.
The next compact control returned valid JSON but falsely compared a section with
another section's sources. It is also retained as a failed control. Review input
now carries complete originals directly on each section and typed membership,
separates page editorial scope from section/group scope and omits irrelevant
canonical identifiers. The full canonical proposal hash/audit binding is unchanged.

The scoped review controls subsequently passed with compact valid JSON and complete
coverage of both targets. The faithful positive used 1,777 input / 51 output tokens
and 3,827 ms; the fabricated-claim negative used 1,780 / 286 tokens and 5,652 ms; the
subtle classification negative used 1,833 / 285 tokens and 5,739 ms. Each used one
actual call. The third specifically rejected a source under an unsupported variable
heading and an unsupported technical umbrella label. All canonical hashes remained
unchanged and no apply occurred. Evidence is retained in the ignored
`a2-semantic-classification-controls-04.log` and per-stage canonical audit/result
files under `a2-trial-notes-9b-05`. Later selected-route tests below cover the final
immutable-reference correction; the native walkthrough remains a separate gate.

The subsequent complete scoped-review `notes-9b-06` trial exhausted the shared
repair without applying. Canonical human and optional artifacts remained unchanged;
all four audits reported cost zero. Total wall time was 31,861 ms, distinct from
30,742 ms summed inference time. The selected local model still confused editorial
conjunction with a combined intervention and misread an original condition. The
successful controls therefore do not certify reliable complete-run behavior for
that local model. Prompt tuning stopped at the current scoped view; this limitation
is retained rather than weakening the support gate or increasing budgets.

The coordinator subsequently used the existing configured Luna route for a separate
synthetic trial. All four cost audit fields were null; cost remains unknown. The
trial exposed a concrete review-context bug: it requested changing the supplied
existing note title, despite the curator having no note-edit capability. The view
now labels immutable reference titles/text explicitly; the catalog excludes them
from authored claims and assesses only the association against originals. Verdicts
pointing into immutable context are invalid checks, repaired against the same
candidate without regenerating it for an impossible edit. This agent has not
executed a remote model, handled credentials or changed a regular DEV provider/profile.
Final selected-route measurements and completed native acceptance are recorded below.

## Independent coordinator gate

The backend candidate passed 115 test files / 739 tests, typecheck, format and whitespace
checks, the complete workspace build (including sandbox preload execution), and
seed verification for all 32 migrations. Independent disposable PostgreSQL verifiers
passed for automatic wiki, prompts, wiki, organization, second-brain M3, maintenance,
Obsidian wiki and Obsidian editing. No user vault was used.

The configured DEV `gpt-5.6-luna` route was exercised against synthetic A0 material
in isolated databases through the actual supervisor, organization service, FIFO,
adapter and canonical audits. The existing credential service was used without
copying or printing secrets; regular DEV sources, profiles and routes were not changed.
The route's configured reasoning level was `low`.

| Final selected-route test | Calls | Input tokens | Output tokens | Summed inference ms | Result |
| --- | --- | --- | --- | --- | --- |
| `notes-luna-02` | 2 | 3,212 | 671 | 16,643 | Useful grounded topic/TOC, existing note and original drill-down references, supported verdict |
| `originals-luna-01` | 2 | 3,110 | 647 | 14,724 | Useful grounded topic/TOC from both originals, supported verdict, no optional derivations |
| Faithful positive control | 1 | 1,849 | 110 | 3,338 | Accepted, all targets covered, no issues |
| Fabricated empirical claims control | 1 | 1,815 | 327 | 7,998 | Rejected: invented clinical proof, significance, synergy, permanence and feedback exclusion |
| Wrong-member classification control | 1 | 1,849 | 232 | 12,305 | Rejected: retrieval-before-rereading note under a distributed-practice heading |

Both complete runs preserved human content and optional-artifact counts. A repeated
start returned the same run with no new model call, page, note or index. The controls
made no canonical changes. Every final Luna cost was unavailable; this is retained
as unknown for subsequent allowance calibration. These fixtures establish the
specified behavior, not universal model accuracy. Earlier local-model failures remain
failures and do not certify 4B/9B suitability for automatic curation.

The restored pre-A2 DEV backup matched the live canonical hashes before migration.
Migration `0031_luxuriant_nova` advanced regular DEV from 31 to 32 applied migrations;
all compared source/document/chunk/note/summary/profile/provider/route/model/job/audit/
vector/wiki/legacy-configuration/maintenance hashes remained unchanged. DEV still has
zero wiki pages and 42 vectors, with zero policy activations. The migration gate ran
no jobs or inference. Receipts and trial evidence are retained under the ignored
`.cache/automatic-wiki-20260912` directory, including `a2-dev-migration-result.json`.

The final isolated Electron DEV snapshot uses the successful `notes-luna-02`
database. After the Mac was unlocked, the coordinator verified theme expansion,
topic/TOC reading, an existing note, its exact original excerpt, source navigation
and Back with the page, note and inspector preserved. Both 1600 × 1200 and 960 × 640
windows passed, with light/dark themes and automatic setup in all five locales.
No fullscreen test was performed. Native review removed a misleading empty-page
message from populated TOCs and corrected the setup scope/close copy.

## Deliberate milestone boundary

A2 delivers the first real bounded curation/native slice. Broad bootstrap/event
consumers, A/B/C integration and paginated/lazy browsing beyond the bounded index
belong to A3; default recurring setup/calibrated shared allowances belong to A4;
knowledge-first consultation and investigations belong to A5. Obsidian physical
layout/protocol migration remains A6. None is silently claimed here.

Updated durable rules: second-brain, database, jobs/processing, AI/knowledge,
frontend/i18n and architecture. The native gate is complete; A3 starts only after
this independently accepted A2 delivery is locally committed.

## A2 navigation layout addition

The application menu now collapses to a 64-pixel icon rail using an accessible
header toggle. Main destinations and settings scopes retain localized names,
tooltips, active states and focus indicators; the theme action remains available
in the rail footer. The existing app settings service persists the collapse
preference and wiki tree width, with backward-compatible defaults and no migration.

Wiki navigation now prefers 320 pixels (previously 176, or 128 at narrow widths).
Its visible divider accepts pointer drag, Left/Right arrows, Shift for larger steps,
Home/End and double-click reset. Completed gestures persist a 240–520-pixel
preference; cancellation does not save. The observed split container excludes the
inline evidence inspector, and temporary viewport bounds preserve 360 pixels for
reading without replacing the saved preference. Tree rows use a fixed chevron
column, distinct page-kind icons, indentation guides, wrapping 14-pixel titles,
40-pixel minimum rows and independent scrolling. Chevron clicks expand branches;
opening their titles preserves expansion. Roving keyboard navigation and defensive
orphan/cyclic-root visibility remain intact.

Automated validation for this addition: 31 renderer/settings/i18n test files,
206 tests passed; full repository typecheck, full workspace build (including
sandbox preload verification), format check and `git diff --check` passed. Final
native acceptance also passed at standard 1600 × 1200 and minimum 960 × 640, both
themes. Pointer resizing reached 470 pixels; keyboard Left/Home/End reached
454/240/520, double-click restored 320, and app restart restored the collapsed
menu and 520-pixel saved preference after temporary minimum-window clamping.
The icon-only settings destinations remained accessible. No fullscreen,
model execution, migration, actual database or vault operation was performed by
this UI addition. The durable contract was added to `rules/frontend-and-i18n.md`.

The coordinator adjusted page cards and title actions to reflow by the actual
reading-panel width, and anchored the narrow-window evidence overlay below the
wrapped toolbar. Native screenshots verified these cases with a wide tree and
open inspector. The final full suite passed 116 files / 748 tests, full typecheck,
final desktop build with preload execution, format and whitespace checks.
The UI-only changes required no further database or model run.
