# A4 automatic content maintenance

Status: independently verified and accepted on 2026-09-12. The final coordinator
acceptance below closes the historical handoff gates and retains failed trials
as diagnostic evidence. A5–A8 remain separate subsequent milestones.

## Implemented behavior

One reviewed policy activation installs incremental, daily, weekly and monthly
bindings. Repeated activation is idempotent; a new preview preserves customized
cadence, limits and catalog instructions, and same-policy resume does not replay
an old setup. Existing policies gain no schedules on migration or app upgrade.
Legacy weekly/monthly/cleanup readers and receipts keep their original contract.

The versioned automatic branch uses MaintenanceService, the existing supervisor,
collection cursors, exact impact deliveries and the curator's guarded patch/support
flow. Explicit selected integration and collection bootstrap obtain backend-owned
occurrence authority immediately. Run-now bypasses idle on the same occurrence,
while retaining conflicts, policy checks, pinned context and spent allowance.
A multi-group bootstrap stays linked to its parent until its cursor settles.

Separate routine occurrences preserve their own due times, eligible start windows
and caps: two-minute incremental debounce / 15 minutes / 10 minutes; daily 02:00 /
6 hours / 20 minutes; Sunday 03:00 / 24 hours / 45 minutes; month day one 04:00 /
72 hours / 90 minutes. Calendar helpers preserve DST gap/fold and month-day clamping.
Different routine kinds serialize under one policy rather than borrowing a monthly
window for daily work. Missed dates coalesce within each distinct routine. Existing
input fingerprints and coverage prevent repeated unchanged synthesis in later sweeps.

Five-second execution heartbeats continue while the supervisor awaits the shared
AI FIFO or provider. Long asynchronous calls consume occurrence time; suspended,
closed or unobserved timer gaps remain separately identified. Restart does not turn
closed time into eligible time. Checkpoint writes cannot reduce heartbeat consumption.
A queued automatic child does not enter its group clock until supervisor execution/FIFO admission. Its original admission snapshot remains unchanged across a closed week. A first FIFO wait can recover only with proof that no provider started; consumed reservations and open FIFO time remain counted. Started/uncertain calls and semantic decisions do not receive this exception. Groups keep their execution deadline, including FIFO wait, and cancellation reaches
provider admission and guarded apply. Exhaustion leaves explicit incomplete coverage
and resumable between-group cursors; unknown calls and review decisions retain their
existing guarded recovery semantics.

A replaced document's new originals can repair the exact stale generated section,
using its stable section identity, while an adjacent protected human section remains
unchanged. Historical excerpts remain in earlier revisions. Relevant TOCs use the
same coherent patch/support gate. Existing notes may participate in weekly/monthly
navigation; no notes, summaries, vectors, matching or graphs are generated implicitly.

The native dialog shows setup/reconciliation, next due, occurrence history, eligible
window, active/deferred/closed time, lateness, coverage, limits, pause and run-now.
Reserved tokens and actual reported usage are distinct. The exact source-free
admitted catalog fragments/revisions are inspectable, with access to the existing
prompt editor. Controls cover all five locales and both theme tokens. Existing shell,
resizable wiki navigation and compact reading links remain intact. Native visual
acceptance is still the coordinator's gate.

## Versioned calibration and authority

Preset: `luna-a2-a3-conservative-v1`.

| Routine | Calls per occurrence | Reserved tokens per occurrence |
| --- | ---: | ---: |
| Incremental | 8 | 128,000 |
| Daily | 16 | 256,000 |
| Weekly | 32 | 512,000 |
| Monthly | 48 | 768,000 |

One parent policy shares 128 calls and 2,000,000 reserved tokens per UTC calendar
month across every installed routine and explicit curator group. Reservations are
atomic and idempotent by organization run/step. Retrying cannot reset the occurrence
or transfer a spent step to another occurrence; crossing a month retains prior debits.
A group needs repair headroom before admission, and lower configured caps win.

Accepted A2 Luna complete runs used two calls each: 3,212 input / 671 output tokens
for selected notes, and 3,110 / 647 for originals. The accepted A3 trial used four
calls, 8,380 input / 1,465 output tokens, including a two-call incremental group of
4,916 / 916. Retained A2 repair trials reached four calls and 7,037 / 2,030 tokens,
including a failed quality gate. These small synthetic measurements motivate bounded
call headroom, not a statistical guarantee. Reservations use conservative UTF-8 bytes
for the admitted prompt, including language and applicable adapter wording, plus
bounded output and protocol margin. This exceeds ordinary measured tokenizer totals
and can stop a large group before its call.

Every cited Luna monetary cost is unavailable, not zero. No new paid call, model
trial, profile edit or user-corpus run was performed by this implementation agent.
A requested hard spend cap prevents inference when no reliable pre-execution bound
exists. Reported canonical usage remains separate from conservative reservations.

## Persistence and legacy reconciliation

Generated migrations are `0035_acoustic_nemesis` (stable binding and call reservation
tables/indexes/FKs) and `0036_hot_scarlet_witch` (nullable schedule `retired_at`).
The baseline, manifest and journal contain 37 migrations. Applied migrations
0030–0034 were not rewritten. Both populated schema35→37 and empty baseline paths
were applied and verified in disposable PostgreSQL, including history count,
retirement column and retained legacy schedule/run/job/occurrence data. No automatic
activation occurs during either migration path.

The coordinator owns the backed-up regular DEV migration and cleanup. Exact obsolete
schedule identities from the supplied inventory are:

- Cleanup: `9e81fda5-84a3-432b-aa89-f35003c7dece`.
- Monthly: `d231e534-0781-4b5a-aaa1-85573383c088`.
- Weekly: `f0998142-1ea8-400f-a299-c895c1b05bc0`.

The weekly row must retain occurrence/run `0a797912-c13b-4fa4-b5a4-58a869e0de7e`
and succeeded job `63702982-3392-488b-a8ed-bbd49b12a37f`. Explicit retirement hides
and disables schedules while preserving these identities; it never deletes an
occurrence to work around the restrictive foreign key. No regular DEV rows were
changed by this agent.

## Executed verification

- Typecheck passed after the implementation and UI changes.
- The final complete suite passed 122 files / 770 tests after the trial02 corrections.
- Focused calendar/clock/UI tests passed: eight clock/calendar cases and five locale
  preview/loading cases. They include a 40-second asynchronous execution, seven-day
  suspended timer, cumulative timeout, DST gap/fold, month day31 and clock rollback.
- `scripts/verify-automatic-wiki-a4.ts` passed populated and empty paths with explicit
  first integration, idle/debounce and run-now reuse, exact stale-section replacement,
  human preservation, customized setup/resume, shared concurrent limits, month
  rollover, monotonic heartbeat/checkpoint writes, retained legacy history, bounded
  catch-up, 14-original/three-group public bootstrap through the real supervisor,
  selected processing completion, missing-model recovery and a child queued across seven closed days with unchanged admission snapshot. All models are fixtures.
- A2/A3 PostgreSQL verifiers passed with their historical activation snapshots,
  preserving every existing assertion. Their old snapshots deliberately omit A4
  setup; the new verifier exercises the complete public A4 activation path.
- PostgreSQL verifiers passed for legacy maintenance, wiki, organization, second-brain
  M3, prompt catalog, Obsidian wiki projection and Obsidian editing. Disposable
  databases and temporary vaults only; no real provider execution.
- Full workspace build passed, including Chrome, desktop, Obsidian and all packages.
  The desktop sandbox preload executed successfully with only Electron resolvable.
  A final desktop rebuild includes the explicit custom weekday/month-day disclosure.
- Format and whitespace checks passed. `npm run db:seed:verify` passed for 37
  migrations with normal local IPC access. The initial sandboxed tsx invocation
  returned EPERM; that environment failure was resolved by the permitted rerun.

## Gate requirements recorded at the initial handoff

The initial handoff required the coordinator to freeze the final build, run selected-route content checks on
synthetic material, inspect normal 1600×1200 and minimum 960×640 native windows in
all five locales and both themes, apply/verify the backed-up regular DEV migrations,
and retire only the three authorized obsolete schedules. Never fullscreen. Actual
model semantic accuracy is not established by deterministic fixtures. No A5–A8 work,
Obsidian physical migration or optional artifact generation is claimed here.

Durable rule updates: second-brain, jobs/processing, database and frontend/i18n.
No technology or dependency version changed.

## Coordinator trial02 correction (acceptance still pending)

The independent Luna `a4-trial-content-upkeep-luna-02` is retained as a failed gate.
Its initial two calls applied a topic/index. After replacing original A, discovery
admitted the existing page with `requiredPageIds=[]`, but the synthesis prompt hid
its stale section because the old chunk was no longer among current originals.
The model consequently proposed a new replacement section and re-emitted protected
human prose with empty original handles. Synthesis and the single repair failed
validation; protection/evidence gates were not weakened. The failed upkeep used
2,615 + 2,841 input tokens, 702 + 904 output tokens and 33,790 ms of inference.
All four trial audit costs are unavailable. Neither the failed trial nor its pinned
`shipped-1` snapshots were modified.

The default `organization.curator` is now `shipped-2`. Every discovery/upkeep path
uses the same section patch inventory. It exposes a stale section's exact identity
and previous prose only when its complete source lineage is authorized and the
replacement originals are admitted. Previous prose is explicitly not current support.
Protected or insufficiently grounded sections expose preservation metadata without
prose or patch authority. The registered template and output-contract guidance say
that section arrays contain changes only, omissions preserve existing content, and
corrections reuse the stale section ID rather than appending a duplicate. No output
remapping or relaxation of original/protection validation was introduced. Existing
admissions retain their original catalog pin; the next selected-model test must use
a fresh policy/admission.

New tests invoke the actual curator executor, inspect the prompt passed to its model
boundary, and construct the response from that received patch inventory. Both
unconstrained discovery and exact-target work retain the stale ID and omit protected
prose. Unauthorized or absent replacement originals receive no patchable prose.
The real PostgreSQL A4 verifier also inspects actual model inputs rather than relying
only on snapshots available to a fixture.

The same trial showed 49 seconds awaiting review being accrued as execution. The
scheduler now resolves linked bootstrap/child attention and retained review decisions
before clock accrual or inference authority. The PostgreSQL regression keeps 34,000 ms
of execution unchanged across 49 one-second ticks, records 49,000 ms deferred, and
preserves the attention state without model calls. New manual runs also record the
actual request time in both `snapshot.dueAt` and the occurrence receipt; joining an
existing occurrence preserves its original due time.

Native feedback corrected the obsolete separate-setup wording in all five locales,
removed empty calendar separators, and added Back from the prompt catalog to the
mounted Wiki through the existing shared native/mouse router. Wiki page/tree context
survives that return; the setup dialog can be reopened independently.

After these changes, typecheck and the complete 122-file / 770-test suite passed.
The expanded A4 populated/empty PostgreSQL gate passed. A2/A3 and prompt-catalog
PostgreSQL regressions also passed. The corrected full workspace build passed,
including sandbox preload execution; final format and whitespace checks passed.
No additional migration was generated by this correction. A fresh Luna trial and
updated native checks remain coordinator gates, not implied successes.


## Reopened TOC coverage gate after Luna trial 03

The coordinator's fresh `a4-trial-content-upkeep-luna-03` used four Luna calls.
The synthesis passed its semantic check: it corrected the same generated section
and retained the adjacent human section. Coverage failed: the existing reading
index remained at revision 1 with old, non-current explanation evidence. A narrow
helper reported success because it checked the synthesis but not every dependent.
The delivery recorded a failed index outcome while its discovery bootstrap's
completion masked that outcome as `complete`; maintenance incorrectly reported
`applied` with complete coverage. This trial is not A4 acceptance.

A cold disposable copy of trial 03 reproduced the exact failure before any child
or provider call: `maintenance.errors.budget`. The incremental occurrence had
reserved 25,441 tokens; another group required 128,000 tokens of conservative
admission headroom within its 128,000-token allowance. A fresh daily occurrence
admitted the exact index with current originals. Diagnostic output is retained in
`.cache/automatic-wiki-20260912/a4-index-admission-repro.json`; the original result
hash was unchanged and no model ran in this diagnosis. Limits were not increased.

Admission failures now retain the dependent cursor, exact error namespace and
owning occurrence without creating a successful outcome or acknowledging the
delivery. Between-group budget/deadline exhaustion marks that occurrence failed
and explicitly incomplete. A subsequent authorized occurrence can admit the still
unstarted dependent under the shared monthly ledger; it never refunds the old
occurrence or replays uncertain/semantic child decisions. Failed, rejected,
canceled or review-waiting children remain visible attention. A discovery bootstrap
cannot acknowledge a delivery containing an unresolved dependent outcome. Explicit
outside-scope exclusions and already-applied causal outputs remain distinct skips.
Maintenance resolves delivery attention before its clock or completion decision.

The shipped-2 curator input now exposes TOC explanation freshness, scoped original
lineage and permitted membership handles as well as section patch metadata. It
explains that stale evidence needs a same-group-ID patch even when the neutral
wording remains accurate. Historical prose is not current support; protected or
unadmitted group prose receives no patch authority. Existing admitted pins and
protection/evidence validators remain intact.

The strengthened populated/empty PostgreSQL gate first updates only the topic,
asserts that the index is still stale, observes a retained delivery and exhausted
incomplete occurrence, then repairs the exact index in a subsequent occurrence.
It verifies the same group identity, new current evidence, historical revisions,
unchanged consumed allowance and human prose. It inspects the actual model prompt
for TOC freshness/lineage. A separate case combines an already-complete discovery
bootstrap with an unresolved failed dependent and asserts pending delivery plus
maintenance attention, never success. The 14-original supervisor and selected
processing regressions remain included. Final verification results follow below;
a new complete selected-model trial and coordinator acceptance remain pending.

The retired legacy schedule rows are now excluded from setup reconciliation while
all historical run/occurrence queries stay intact. The migration gate asserts this
with its retained historical schedule. Blocked deliveries are ordered after other
eligible deliveries. Historical policies without automatic routines may continue
inspecting other targets after an unadmittable scope decision, retaining that
unresolved outcome and withholding complete acknowledgment; this preserves the A3
cross-page cycle without silently discarding scope failures. Exact input passage
counts use distinct chunk identities rather than repeated historical evidence IDs.

Final source checks passed: typecheck; the complete 122-file / 770-test unit suite;
A4 populated upgrade and empty baseline; A3 populated/empty including all existing
22-target/cycle assertions; A2 populated/empty; and prompt-catalog PostgreSQL gates.
All test models were deterministic. The updated full workspace build passed, including sandbox preload execution.
Final format and whitespace checks passed.
No further schema migration was required; the existing A4 migration/seed total
remains 37. Trial 03 is preserved, and trial 04 plus independent native verification
remain coordinator-owned acceptance work.

## Trial 04 context diagnosis and configurable context

Fresh Luna trial 04 completed initial A/B organization in two calls (3,769 input,
507 output tokens, 15,251 ms; monetary cost unavailable). Its two-group reading
index and corrected single source then failed admission before any upkeep call:
`organization.errors.context`. It is preserved as a failed acceptance attempt.

The cold disposable clone reproduced the exact pinned prompt at 12,689 characters,
above the unchanged 12,288-character ceiling derived from the old unknown-context
fallback (8,192 total minus 2,048 output, times two). Existing-knowledge metadata
occupied 3,247 characters. Removing redundant collection/evidence/membership UUID
lists and section revision metadata from model serialization retained patch IDs,
originals, freshness, member handles, titles, protection and full historical prose.
The same admission now succeeds at 12,069 characters. A realistic correction with
both TOC groups produces a 10,847-character support prompt within its 14,336
ceiling. Both stages execute through the deterministic curator boundary regression.
No context/output cap or evidence validator was raised for this correction. The
trial's source/profile/prompt snapshots and result hash were unchanged; no model
ran in the clone. The registered curator body remains `shipped-2`, and support
remains `shipped-1`; their fields equal the trial's pins. Rendered-input hashes
naturally reflect the smaller serialization.

The user's subsequent context-configuration request revealed that the canonical
field already existed but remote descriptors removed it during normalization.
New remote generation now resolves an absent context to an explicit application
planning budget of 128,000 tokens, with model defaults and task overrides taking
precedence. The field is exposed for Google, OpenAI-compatible and Codex, and for
MLX generation as an app-side explicit control. GGUF keeps its existing runtime
control; implicit local and embedding behavior receives no remote default. The
MLX UI names an unspecified value as the workflow default, not an invented total
runtime capacity. Total-context and output-token controls remain distinct.

Validated discovery limits are cached in existing provider JSONB metadata and
bound to provider/model/endpoint identity. Same-model saves retain them; a changed
model does not inherit them. Google inputTokenLimit is a conservative bound on the
app budget, stored separately from outputTokenLimit; those limits are never added.
Google documents these as [separate input and output limits](https://ai.google.dev/api/models#Model).
Generic model IDs imply no capacity. Discovery is never fetched during inference.
The common AI service checks prepared input, applicable adapter instructions,
output reservation and protocol allowance before provider start, using the same
conservative UTF-8 planning function as automatic reservation. Effective context
survives normalization into monitoring and canonical task audits. Adapters omit
this app-only control from remote wire requests and the MLX native protocol.
Oversized requests fail visibly; no originals are truncated. Organization and
maintenance surface that common context error as actionable context attention.

Old pinned profiles with null/absent context remain unchanged, retaining historical
builder behavior. Bootstrap children inherit their original profile parameters,
language and prompt catalog after settings edits. Immutable model identity and
current policy/revocation checks remain. A newly discovered smaller limit rejects
an incompatible old pin explicitly rather than rewriting it. Default resolution
requires no persistent update or migration, and settings saves create no inference,
processing jobs or vector work.

The new `scripts/verify-ai-context.ts` PostgreSQL gate covers all three remote
providers, 128,000 empty defaults, 64,000 model defaults, 32,000 task overrides,
save/reload, immutable old pins, effective audit parameters, smaller discovered
limits, identity-bound cache preservation/removal and a legacy null-context
bootstrap child retaining its admitted language/parameters. Its six adapter calls
are deterministic fixtures, with no network or model runtime. The existing A4 and
A3 populated/empty PostgreSQL gates also pass. The final full unit suite passes 783 tests across 122 files. Typecheck, the
complete workspace build (including sandbox preload execution), format and
whitespace checks pass. A2 and prompt-catalog PostgreSQL regressions also pass.
The coordinator independently verified the intermediate remote UI in five locales,
model/profile save and restart, and read-only effective pins 32,000 → 64,000 →
128,000. The OS-dependent number separator was corrected to ungrouped digits.
Final native refresh and the next fresh selected-model acceptance trial remain
coordinator-owned gates. No regular DEV database or real profile was changed here.

The final editor correction hydrates the discovery cache from validated persisted
provider metadata after restart, so opening an existing model keeps its known
smaller maximum. Successful model discovery refreshes the editor descriptor. The
PostgreSQL gate verifies restarted listProviders → getParameterCapabilities at
16,000, with no transfer to another model or endpoint; all 783 unit tests pass.


## Final independent coordinator acceptance

The final checkout passed the complete 122-file / 783-test suite, typecheck, format
and whitespace checks. Independent PostgreSQL reruns passed AI context settings,
A4 populated 35→37 and empty baseline, A3 populated/empty, A2 populated/empty and
the prompt catalog. Earlier independent A4 checks also passed legacy maintenance,
wiki, organization, M3 and Obsidian projection/editing regressions. The agent's
final complete workspace build and sandbox preload gate passed; the coordinator
froze and opened that output natively. The 37-migration seed verification remains
valid; no schema changed during the context follow-up.

Fresh selected-Luna trial 05 passed with six actual calls: 12,906 input tokens,
2,125 output tokens and 49,537 ms of reported inference. All six audits record
the new 128,000-token context. Monetary cost remains unavailable. Shared monthly
reservations total 81,516 tokens across all six calls. The corrected A report
replaces the same generated section and attributes the scoring correction, while
B remains a distinct reported finding. Both TOC groups retain their identities
and cite current complete originals. The protected neighboring interpretation
and separate human page remain exact; notes, summaries, vectors and entities
remain zero. Four topic revisions retain the earlier state. This semantic review
was performed by the AI coordinator against the user-confirmed base criteria;
it is not a claim that the user reviewed this new output.

The first upkeep occurrence retains its budget-exhausted, incomplete receipt.
The next scheduled incremental occurrence completes the exact index, with no
hidden failed dependent or repeated topic synthesis. End-to-end upkeep took
158,937 ms, including the real two-minute debounce. An unchanged explicit repeat
completed in 348 ms and made zero calls. The earlier trials 02/03/04 failures remain
recorded; none is relabeled as successful or removed.

Native QA covered all five locales, both themes, normal 1600×1200 and minimum 960×640
windows, without fullscreen. Routine customization/pause, Tuesday persistence,
exact prompt/history inspection and top-layer Back passed. Catalog Back returns
to the same Wiki page/tree context. Compact links and the resizable tree remain
usable. Native Alt-Left exercised the shared Back route; physical extra mouse
buttons were covered by the shared-router tests, not a claimed physical click.
The new context field saved 64,000 at model level and 32,000 at task level, retained
both after restart, and resolved actual read-only pins 32,000→64,000→128,000 on
restoring inheritance/defaults. These settings checks made zero model calls or
processing jobs. The final English UI shows the unambiguous 128000 default.

Regular local DEV was migrated from 35 to 37 through the normal migration flow.
A fresh restore of the verified pre-A4 backup was compared against all 93 legacy
tables and their original columns. Every row/column is preserved except the
expected active-prompt publication and the three explicitly authorized schedule
retirements. The first verification helper counted PostgreSQL 18 NOT NULL catalog
entries as foreign keys; the recovery verifier distinguished all 15 constraints
from the 3 foreign keys and verified the already-applied schema without rerunning
migrations. All 13 added columns, 4 indexes, 3 restrictive FKs and vector/AGE
extensions were checked.

The three obsolete schedules are retired and absent from active setup/listing,
with their rows, historical occurrence, maintenance run and succeeded job intact.
The DEV Wiki remains empty. Its 13 sources, 13 documents, 10 chunks, 7 summaries,
3 profiles, 335 AI audits and 42 vectors remain unchanged; no job or model ran.
The actual DEV server was stopped cleanly after verification. No library policy
was activated, no vault was migrated and no model-specific capacity was inferred
from a model name. Default 128,000 is application planning, with reliable smaller
provider bounds respected; it is not uniform model-compatibility certification.

Detailed local receipts are kept under ignored .cache/automatic-wiki-20260912:
a4-trial05-coordinator-review.json, a4-native-coordinator-review.json,
a4-context-native-review.json and a4-dev-migration-result.json. Durable rules
changed in AI/knowledge, second-brain, jobs/processing, database and frontend/i18n.
