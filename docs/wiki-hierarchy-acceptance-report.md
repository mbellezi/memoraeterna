# Wiki hierarchy acceptance report

Status: automated acceptance, native hierarchy/review, open-editor Obsidian
preservation, native reset and an ordinary actual-model group passed. H6 execution
is recorded, with two quality/calibration gates still unaccepted: actual deep
entity generation on the selected low-reasoning model, and the proposed 20%
comparable-work token threshold. This report does not declare full acceptance.

## Automated evidence — 15 September 2026

H6 fixes the two seed-test expected migration lists to include the already
existing `0042_wiki_editorial_review_impacts`. The baseline and migration journal
already contain all 43 migrations. No migration, schema change, dependency or
format version was added.

| Check | Observed result |
| --- | --- |
| `npm test` with local loopback available | 138 files, 932 tests passed after the reset follow-up |
| `npm run typecheck` | Passed |
| `npm run format:check` | Passed |
| `npm run build` from the normal workspace | Passed; no native launch or packaging |
| `npm run db:seed:verify` | Passed, 43 migrations |
| `node --import tsx scripts/verify-knowledge-automation.ts` | Passed on isolated PostgreSQL, including reset with a real AGE graph and without the AGE extension |
| `npm run db:prompts:verify` | Passed on isolated PostgreSQL, populated-upgrade and empty-baseline paths |

The first sandbox-only Vitest invocation passed 919 tests and failed five HTTP
fixture cases because local sockets were denied. The same suite passed all 924
with loopback permission. The first PostgreSQL automation attempt could not
create a shared-memory segment under the sandbox; the isolated rerun passed.
These failed attempts remain in the ignored H6 log directory.

The automation verifier observed idempotent startup, preserved existing content,
missing-model readiness, automatic admission after configuration, separate
blocked/review status, strict measured-budget checks, retained histories, and
reset restoration of Wiki areas and four enabled routines without inference.
Its synthetic audit records are not actual provider usage. A fresh normal build
contains the scoped `curatorReferences` helper and both repository callers;
this is static evidence for the previous undefined-reference failure, not a
substitute for native reset.

Earlier recorded H5 checks remain applicable: A5 consultation and scope on both
schema paths, the complete hierarchy transaction/service matrix, and both
Obsidian verifiers. The extended layout verifier includes depth 40 current
layout, depth 20 legacy layout, canonical entity homonyms, a shared note,
rename/reparent, divergent local text and disabled sync. H6 did not rerun these
unchanged boundaries. See the implementation plan for exact prior evidence.

## Navigation measurement boundary

The existing same-machine comparison used 1,201 metadata nodes, width 1,000,
depth 200 and six warm samples per view on Apple M4 Max arm64. Repository p95
latency changed from 40.65 to 0.64 ms for roots, 44.85 to 0.58 ms for broad
children, 41.77 to 0.21 ms for deep children, and 89.05 to 14.94 ms for the
selected depth-200 path. These are database/API timings, not native UI latency.

## Acceptance gates and limitations

- [x] Normal DEV native walkthrough at 1600 × 1200: deep paths, nested TOCs,
  one shared note ID, entity homonyms, protected movement review, partial branch
  progress, and validated target-count control (1–12, default 3).
- [x] Native Reset everything on the isolated fixture only, followed by fresh
  dashboard/default-routine inspection and no unexpected inference.
- [x] Open-editor Obsidian preservation using the same canonical fixture IDs.
- [x] One bounded actual-model curator trial on complete synthetic originals,
  with effective route/parameters, canonical audits, retained failures, support
  outcome, useful-category review, repairs and unchanged-rerun audit count.
- [x] Actual paired prompt-usage measurement on the current selected route.
  Keep ordinary comparable work separate from initial hierarchy/entity work.
  Report tokens, known/null cost, durations, valid output counts and repairs.
  The proposed median overhead limit of 20% remains unaccepted: synthesis work
  differed across variants, and neither support series passed every sample.

The frozen historical serialization fixture contains an unsupported statement
about spacing benefits that contradicts its second original. Preserve that
artifact unchanged. A separately named matched calibration copy must correct the
same candidate purpose/prose in both old and current support payloads before any
provider call, retain exact adjustment metadata, and leave synthesis originals
unchanged. Such prompt-usage trials do not execute or certify the old complete
implementation. Valid outputs with equal work units are required before ordinary
usage is called comparable. Byte ratios alone cannot satisfy the token gate.

Temporary DEV tooling lives in ignored `.cache/wiki-hierarchy-h6`; its only
allowed operational files and isolated database are under
`/private/tmp/memora-wiki-hierarchy-h6`. The temporary main-process hook was removed
and the normal build checked before the final commit. The entity-repair follow-up updates `rules/ai-and-knowledge.md` with the
new/existing entity distinction and actionable repair feedback; no stack changed.

Temporary driver preparation was also exercised against a separate disposable
PostgreSQL database with synthetic model stubs. Both fixtures were created,
the move-only proposal and partial bootstrap parsed, and the protected move was
accepted while preserving exact section content. Matched benchmark inputs were
serialized before an intentional no-provider stub failure, and that failed output
was retained. This verifies fixture preparation only; it does not complete native,
credential-import, provider, pairing, projection-worker or editor acceptance.


## First actual-model trial and repair follow-up

The first bounded actual trial used the configured OpenAI Codex route with
`gpt-5.6-luna`, low reasoning, a 128,000-token planning context and profile maximum
output of 16,384. Its custom six-target policy and complete two-source synthetic
genetics corpus remained fixed. Synthesis and one repair produced two canonical
AI audits: 6,672 input tokens, 1,886 output tokens, 36,536 ms summed model duration,
and unknown cost. No support call or canonical group apply occurred.

The first response used page titles as handles and emitted two new entity pages
without sections. The repair corrected the handles but retained empty entity
sections; the old final diagnostic was generic `organization.errors.evidence`.
Root's manual review found the topic prose faithfully attributed and qualified,
with distinct canonical entity references, but no useful broader ancestor path.
These observations do not certify semantic support or a successful hierarchy.
The original trial marker, outputs, rejection and audits remain intact.

The follow-up clarifies the existing prompt contract: machine handles have an
explicit format, new entity pages require grounded sections, existing entity
patches may omit unchanged sections, and an ordinary topic TOC preferably uses
its owner as principal parent. Broader-to-narrower navigation is encouraged only
when supported and useful. Draft and canonical validation now report exact
entity-section paths; they do not fabricate prose, handles or ancestry or weaken
the original-evidence gate. The four affected existing catalog defaults use
shipped prompt revision 6; public transport markers and database schema do not
change, and earlier admitted prompt snapshots remain immutable.

All 927 tests in 138 files, TypeScript and the isolated PostgreSQL prompt verifier
passed after this change. Deterministic revalidation of both retained real outputs
now reports both invalid handles and empty entity sections for the first output,
and the two exact entity-section paths for its repair. This is not new inference.
A new explicit trial is permitted once for a changed exact prompt fingerprint;
repeating the same fingerprint is refused without resetting prior allowances or
replaying the old run. Later ordinary and guided trial observations are recorded below.

Root's initial normal-size native observations also confirmed configured-model
readiness and all four routines. The primary paused policy's Budget UI rejected
13 targets and saved 6, showing effective 6 and default 3. These observations do
not complete native hierarchy, reset or Obsidian editor acceptance.


## Normal-main execution and guided placement follow-up

A second actual trial through the first temporary bundled driver produced a
supported candidate in two calls but lacked organization prompt compositions in
its canonical audits. Canonical apply correctly refused it. The driver and normal
main process had separate prompt-runtime context/provenance maps; this was a test
instrumentation failure, not a production apply failure. It remains recorded with
6,105 input tokens, 897 output tokens, 19,101 ms and unknown cost. No audit was
rewritten and no evidence guard was relaxed.

The corrected temporary controller invokes the normal main OrganizationService
and its prompt context, wrapping the same AiService only to retain synthetic trial
inputs/outputs. On a fresh scoped copy of the two originals, the ordinary normal-main
trial applied after synthesis and support: 5,800 input tokens, 815 output tokens,
18,445 ms and unknown cost. Both audits retain the required organization prompt
composition. An unchanged start/execute returned the same run with zero new audits.
This ordinary success does not establish deep placement or the 20% token gate.

The following explicit guided case requested a five-ancestor reading path and
canonical entity pages. The model proposed six total minimal ancestors plus a
reviewed move, but the two-call attempt rejected before support: 8,896 input
tokens, 2,399 output tokens, 45,717 ms and unknown cost. The first response used
canonical entity references as page handles and object-valued entity bindings.
Its repair converted the bindings to strings but retained those wrong page handles
and repeated a current parent on an existing TOC. All outputs and audits remain.

The revision-7 prompt follow-up distinguishes PAGE handles from canonical ENTITY
reference strings and limits owner-preferred initial placement to NEW TOCs.
Existing topic/index/entity patches require initialParent:null even for unchanged
parents. Draft errors now identify wrong entity page handles and exact initialParent
fields; expansion rejects non-page, wrong-kind or unavailable page references with
field-specific feedback. It never converts entity IDs into pages, guesses a new
handle, or changes the guarded placement/evidence contract. Existing entity edits
using distinct valid page/entity references retain links-only patch behavior.

The full suite passed 930 tests in 138 files; the focused domain/curator suite
passed 59 tests. TypeScript and the isolated PostgreSQL prompt verifier passed.
Retained guided output revalidation reports two specific string-binding errors
for the first response and five exact page-handle/initialParent errors for its
repair. Synthetic execution reaches complete support after a valid repair. These
checks do not assert a subsequent actual-model success.

The temporary guided trial guard allows one explicit attempt per actual guided
prompt fingerprint and source-ID set, retains earlier markers and refuses the same
inputs again. Normal-main's one-attempt guard is unchanged. A local test of that
actual guard covered repeat refusal, changed-prompt admission, legacy-marker
preservation and the unchanged normal-main rule without DB, provider or UI calls.
The explicit test preference now places the first Ciência ancestor beneath the
supplied Temas area; this is test guidance, not backend insertion of a desired path.

## Second guided rejection and diagnostic precedence

The revision-7 guided attempt remained rejected after synthesis and one repair,
without support or apply: 10,216 input tokens, 2,946 output tokens, 55,546 ms and
unknown cost. Its repair received both complete originals, all four current
issues, the explicit entity/page example, canonicalPage:null for both entities,
and the complete previous output. No decisive context was truncated or omitted.

The current diagnostics nevertheless gave conflicting guidance on the same rows:
entity handles were correctly rejected as non-page references, but a dependent
message described those rows as existing pages and requested null parents/moves.
The model followed the latter advice, adding moves for the entity references while
retaining invalid page handles. The narrow correction suppresses that dependent
placement instruction only when entity.handle equals entity.entity. Identity
rejection and every valid existing-page placement guard remain unchanged. There
is no handle coercion, evidence relaxation, prompt wording/revision change or
replay of the rejected trial. This diagnostic correction does not establish that
a future model attempt would succeed; all prior failures remain retained.

The focused domain/curator suite passed 59 tests, and TypeScript passed after
this precedence correction. Regression coverage retains exact handle errors,
withholds contradictory placement advice for those invalid rows, and verifies
that distinct existing entity page handles still reject non-null initialParent.
No new provider call or native restart was performed for this correction.

## Native hierarchy and open-editor preservation

The predetermined display fixture is separate from actual model acceptance. Native
DEV showed the full Temas / Ciência / Biologia / Genética / Expressão gênica /
Índice de expressão gênica path. Inner and outer TOCs linked the same canonical
note; the outer Notes context returned one row after traversing its subordinate
reading index. Both source links and current evidence were visible. The two
Aurora pages appeared under Entidades / Organizações / Institutos de pesquisa,
with distinct canonical entity IDs confirmed in the repository.

Native protected-move review showed exact before/after paths, one descendant and
two protected memberships, and applied only after its explicit review action.
The text and child TOC remained. The partial-budget fixture showed completed
original coverage and notes separately from deferred structural work, including
two work targets, two ancestors, four page changes and one pending decision.

Obsidian 1.13.7 loaded the workspace plugin in the temporary vault after explicit
user confirmation. The normal gateway connected; initial projection wrote 34
registered files without conflict. One editor remained open throughout an edit,
canonical rename and reparent. The added test paragraph arrived in native Wiki
revision 3; native rename/reparent produced revision 4. Projection updated the
open buffer's title and deep breadcrumbs while retaining the exact page ID,
section ID, edited prose, shared-note file and all 34 registered paths. The final
projection changed five files and reported zero conflicts.

The first automation insertion used an inaccurate live-preview accessibility
selection offset and damaged an end marker. The plugin retained it as a conflict;
canonical content remained unchanged. Undo and a source-mode Find operation
prepared the corrected current edit. A stale manual comparison was refused;
reconciliation refreshed it, and explicit manual merge then synchronized with no
pending edits. This records a test interaction failure and successful preservation,
not a spontaneous product corruption or a change to synchronization guards.

## Actual paired prompt-usage experiment

Three alternating pairs used the same configured gpt-5.6-luna/low route and
complete frozen originals. Each pair contains one synthesis call and one support
call; support judges the same separately calibrated fixed candidate, not the
preceding synthesized output. All 12 calls have canonical usage audits. There was
no repair or application in this serialization experiment, and cost was unavailable
for every call.

| Pair | Historical tokens | Current tokens | Historical / current model duration | Synthesis targets | Fixed-candidate support |
| --- | ---: | ---: | --- | --- | --- |
| 1 | 4,283 | 4,239 | 16,173 / 14,175 ms | 2 / 1 | accepted / rejected |
| 2 | 4,331 | 3,994 | 16,344 / 11,067 ms | 2 / 1 | accepted / accepted |
| 3 | 4,207 | 4,012 | 14,486 / 9,784 ms | 2 / 1 | rejected / accepted |

Median raw totals were 4,283 historical and 4,012 current tokens. The median paired
raw difference was -4.64%; the highest observed difference (nearest-rank p95 in
this three-pair sample) was -1.03%. Input alone was 3,515 versus 3,561 tokens per
pair (+1.31%). These are usage observations, **not an equivalent-work savings or
20% acceptance claim**: every current synthesis omitted the TOC generated by its
historical counterpart. A subsequent missing-TOC group would add real work/calls.
The ordinary normal-main trial above did create its topic and TOC in two calls.

All six synthesis outputs passed their respective structural checks. Manual review
found faithful separately attributed core findings, but current samples 1 and 2
introduced an insufficiently supported comparison/inference about learner
experience, and several umbrella labels merit stricter semantic checking on this
very short corpus. The fixed-candidate current rejection identified plural
“studies” on a one-study index; the historical rejection treated “complementary”
as an unsupported relationship. Neither verdict series was uniformly accepted.
The historical full implementation was not executed or certified. Retained raw
failures and unequal output sizes must not be removed or normalized away to make
the calibration pass.

## Final diagnostic retry boundary

After the diagnostic precedence correction, the explicit normal-main request with
unchanged prompts and sources returned the same rejected guided run and created
zero new AI audits. This verifies retained-decision behavior; it is not a fresh
successful model test of the correction. An initial temporary-controller path
lookup failed before admission or inference and was retained separately. No prior
run, audit, allowance, prompt snapshot or rejection was rewritten.

The selected low-reasoning model therefore has no successful actual deep
entity-creation result in this report. Deterministic/service/PostgreSQL and native
preservation checks pass, but reliable model generation of that combined case and
the equivalent-work token threshold remain explicit unaccepted quality/calibration
gates. The bounded experiment stops here; repeated sampling until a favorable
answer would not establish reliability.

## Deferred reset investigation and native result

The supplied log showed PostgreSQL ready, followed by an undefined `references`
helper during knowledge-default initialization. H2 already corrected the helper
binding. Normal DEV startup after removing every temporary main-process hook no
longer reproduced that error or `wiki.errors.unavailable`.

The first explicitly authorized native reset of the temporary fixture exposed a
second defect: unconditional access to `ag_catalog.ag_graph` when AGE had not been
initialized. Its transaction rolled back: five sources, three notes, twenty Wiki
pages, twenty-three audit rows, seven organization runs and four schedules remained.
Managed Markdown had already been removed, while its ownership registry and the
unmanaged test marker remained, making the subsequent retry meaningful.

Reset now checks for the optional AGE catalog before graph work. When present,
graph removal remains in the same transaction as canonical cleanup and real errors
still roll everything back. When absent, only graph cleanup is skipped. The existing
model allowlist, no-CASCADE safeguard, projection clock and default restoration
remain unchanged. The isolated PostgreSQL verifier now exercises an actual graph,
absent extension, repeated reset and preserved provider/profile/task-route records.

After rebuilding normal DEV, the same authorized native reset succeeded. The
renderer reloaded into an empty Library; Knowledge automation showed a configured
model, zero sources and all four enabled routines. Wiki showed its nine initial
areas. Database reads confirmed zero notes, zero organization runs and zero AI
audits. Provider, profile, parameter/task and route table hashes matched their
pre-reset values. Six local-model catalog records remained; their whole-row hash
changed across the intervening DEV restarts, which refresh catalog metadata and
updated timestamps, so this native comparison does not claim byte identity for
that table. The repository reset preserves local-model/file tables explicitly.
No managed Markdown remained; the unrelated temporary-vault marker survived.
The user's normal library and original Obsidian vault were not reset.

Final root verification after this fix passed 932 tests in 138 files, the workspace
build and formatting. TypeScript and the dedicated PostgreSQL reset matrix passed
during the sequential High review. No migration, dependency or public format
version was introduced. All temporary main-process validation hooks were removed.

## Durable specification changes across the implementation

Updated `rules/second-brain.md`, `rules/ai-and-knowledge.md`,
`rules/automatic-knowledge-workflow.md`, `rules/jobs-and-processing.md`,
`rules/database.md`, `rules/source-search.md`, `rules/frontend-and-i18n.md`,
`rules/integrations.md` and `rules/security-and-privacy.md`. The rules cover scoped
hierarchy/counting, bounded continuation and evidence, reading traversal, protected
review, stable projection paths and reset with optional AGE. `STACK.md` is unchanged.
