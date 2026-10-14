# M3b recurring maintenance implementation

Historical validation report: privacy-selector and explicit-profile behavior
below describes the milestone at execution time. The current application uses
`structured-output` routing by default, with an optional model override and no
independent local/remote permission. Hybrid embeddings use their own route.
See [current routing rules](../rules/ai-and-knowledge.md). Historical trial inputs
and results are retained unchanged.

Status: accepted after coordinator review, deterministic/PostgreSQL checks and
sequential real local/Luna desktop trials. This report does not
claim M4–M6, real-model quality, background execution while the app is closed,
or operating-system scheduling.

## Delivered behavior

The Organization settings now include persisted disabled-by-default weekly,
monthly and custom routines, diagnostic-only mode without a model, explicit
page/tree/source scope and exclusions, profile/privacy/domain, selected cleanup
categories, budgets, review policy, idle preference, Run now, pause, last/next
execution and five localized timezone occurrence previews. Run now bypasses the
idle preference, while imports, foreground AI and pending/conflicting sync defer
execution. No new dependency, scheduler daemon or Codex automation was introduced.

The existing supervisor claims maintenance jobs after foreground jobs. A single
application executor owns diagnostic cursors and bounded review states. Due
occurrences carry durable identity/windows; missed occurrences become one
catch-up. Compatible simultaneous weekly/monthly work shares one inspection and
pins both effective instruction texts, with the monthly routine displayed as the
broader effective routine. Incompatible policies remain deferred. Policies and
instructions are pinned when admitted, and schedule edits revoke pending work.

Calendar rules: last valid day for missing monthly days; first valid local minute
for a DST gap; earlier instant for a repeated local time. Timezone/cadence edits
start from a future occurrence and cancel previous pending authority. Budget
periods are UTC calendar months. Admissions reserve aggregate capacity under a
transaction lock, and execution/approval crossing a month boundary must reserve
that month too. Known unspent model capacity is released, while unknown or
interrupted calls remain conservative. A strict monetary cap currently defers
model analysis because no reliable provider execution-cost bound is available;
call/token/inspection/change caps provide the usable default. Unknown cost is
shown as unavailable, including OAuth usage.

Inspection is deterministic and paged in batches of at most 50 objects, with a
resumable cursor and explicit coverage/deferred counts. Signals include broken
original references, exact stale dependencies, generated sections without
citations, empty/unplaced pages, duplicate titles/aliases, catalog sources and
notes without wiki connections, long pages and deep/wide branches. These are
review candidates, not demonstrated semantic defects or a mathematical balance
target. Citation review alone does not mean text changed; isolation or age alone
never makes material disposable. Sources and notes remain diagnostic-only input
in M3b. Structural model input contains only a ranked, byte-bounded subset of
wiki candidates and rechecks their revisions at FIFO admission.

Model proposals permit only reparenting, collection navigation and archival of
eligible empty generated drafts. All require human review. They preserve page
and section IDs, original citations, independent citation-review/currentness,
aliases, immutable revisions and canonical source hierarchy. Apply rechecks
revisions, child/navigation eligibility for archival, cancellation and cycles
under the existing wiki placement transaction lock, then writes canonical
receipts. Archive review includes a manual Restore action using the existing wiki
save service; restoration creates another revision and protects that deliberate
placement from further archival. No content, asset, history or vault file is
physically deleted.

All model work uses `AiService.runOrganizationTask`, the existing FIFO/adapters
and canonical `ai_task_runs`. Maintenance-step links commit with the audit row.
There is no second inference queue or telemetry system. Stable decision
fingerprints, minimum benefit, cooldown and recent proposed/applied/rejected
history prevent repeated proposals and oscillation. Uncertain interrupted calls
are not automatically replayed. The resource constraint is universal: exactly
one local inference execution at a time, including embeddings, helpers and tests;
resident models do not authorize concurrent inference.

## Persistence and ownership

- Domain: `packages/domain/src/maintenance.ts`; version-3 function compatibility
  and weekly/monthly/cleanup slots extend the existing organization configuration.
- Persistence: `maintenanceRepository`, seven maintenance tables, canonical
  audit links, occurrence/period indexes and restrictive history references.
- Desktop: `MaintenanceService`, existing main/preload/IPC boundary, supervisor
  and FIFO integration, Organization settings, native dialogs and five locales.
- Review UX: composed before/after paths, target/destination revisions, stable
  identities, alias/link preservation, restored archive state, honest usage and
  visible actionable results. Unchanged completed inspections remain quiet.

During implementation, an externally created intermediate commit `a1988db`
captured and published an early incomplete M3b state. Neither implementation
agent nor coordinator created that commit. Its history is preserved. Its
`0026_broad_celestials` migration and snapshot remain unchanged. The only later
schema addition, persisted schedule deferral errors, is the additive generated
`0027_curvy_doomsday`. Baseline and manifest now cover 28 migrations. A discarded,
unapplied draft migration was replaced without rewriting the committed migration.
The coordinator will make only the authorized local completion commit after
acceptance; this phase performs no additional push.

## Verification performed

- Full deterministic workspace suite: **92 suites / 566 tests passed**.
- Whole-workspace typecheck and build passed.
- The baseline seed verifier passed with **28 migrations**.
- `node --import tsx scripts/verify-maintenance.ts` passed against isolated real
  PostgreSQL. It covers populated M3 data, committed 0026 already applied with a
  saved schedule before 0027, empty baseline, table/index/history verification,
  page/source scope isolation, tree exclusions, mixed-source exclusion, no-model
  catalog inspection, idempotent/compatible admission, incompatible profiles,
  shared audit links, unchanged analysis, unspent reservation release,
  pause/cancel, reviewed exact-content preservation and idempotent receipts,
  archival child races and restoration, page revision checks before FIFO,
  missed weekly/monthly catch-up, idle deferral, UTC month rollover/reservation
  saturation, strict monetary-cap deferral, cursor continuation, rejected-decision
  cooldown, uncertain-call containment and per-function advanced sample guards.
- Existing real PostgreSQL wiki (M1), organization (M2) and M3 verifiers also passed.
- Calendar tests cover month end/leap year, DST gap/fold, no second fold
  dispatch, long custom cadence, invalid dates/timezones and future rebasing.
- Renderer tests cover all five locales, loading/disclosure, partial timezone
  input and composed multi-operation tree paths. These do not replace real
  Electron keyboard, sizing, focus, theme or visual acceptance.

Deterministic model outputs test executor contracts, not model quality. The agent
never started DEV, loaded a real model or modified the benchmark corpus. The
coordinator owns sequential local/Luna trials and normal 1600 × 1200 desktop
acceptance. Any local failure must be reported separately; Luna remains the
semantic reference.

## Coordinator acceptance and safe fixture recipe

Preserve the existing five DEV wiki pages and all original sources, notes,
relationships and history. Use only explicitly labeled synthetic maintenance
fixtures. The `draft()` helper in `scripts/verify-maintenance.ts` is the tested
recipe: insert a page plus one immutable `organization`-origin revision; bind a
current original chunk through page-owned `wiki_evidence` containing its exact
source/document/chunk/span identity, hash, title, excerpt and locator. Generated
sections are unprotected drafts with `evidenceReview: needs_review`. Do not
change protection or provenance on any pre-existing page.

For the structural trial create a dedicated empty **human-created collection**
with a learning/memory title and a separate generated topic about retrieval and
feedback, initially unplaced and citing an existing current synthetic passage.
Restrict the routine to those two page IDs, descendants off, navigation selected,
review required, one model call and a small change allowance. The useful result
is a reviewed move of the topic into the collection; source hierarchy and exact
citations must remain unchanged. A separate generated empty leaf can test
recoverable archival. Use diagnostic-only Run now over a curated/empty scope to
verify an honest no-model/no-change result.

Local and Luna trials must execute sequentially with the same semantic evidence,
instructions and bounds. Use independent copies of the two fixture pages for
proposal trials when a successful first proposal would intentionally trigger
scope admission/cooldown protection; preserve identical evidence/content while
keeping independent IDs and review histories. The existing bounded Sample
workflow also provides identical synthetic semantic inputs across profiles.
Never relax cooldown/protection or clear canonical decisions merely to run a
comparison. Pause all acceptance schedules afterward; no recurring paid work
should remain enabled.

Verify normal startup migrations without resetting DEV, next/last and paused
states, Run now while actively reviewing the app, cancelled/revoked apply,
review/restore, composed tree readability, Escape/Back/focus restoration and
settings/domain sample activation. Reopen with
`MEMORA_DEV_BACKGROUND=1 npm run dev -w @app/desktop`; keep the normal
1600 × 1200 opening size and never maximize/fullscreen for acceptance.

## Remaining acceptance limits

Real desktop and paired real-model acceptance are recorded below.
Strict monetary caps remain conservative deferral when price bounds are
unavailable. Duplicate diagnostics currently use exact normalized title/alias
matches; semantic consolidation, advanced note merge/split and physical storage
purge are not implemented by this phase. Derived wiki navigation is computed
from canonical revisions, so there is no independent stale navigation index to
repair. M4 owns wiki projection; M3b never touches vault files.

## Bounded coordinator acceptance corrections

The coordinator's first sequential actual pair returned valid no-change results:
local run `308bedbe…` used one call with 1,023 input / 212 output tokens; Luna run
`93b7b4a6…` used one call with 932 input / 93 output tokens. Luna described the
human collection as an unavailable destination. The backend already permitted
that unchanged destination, but the prompt did not distinguish its permissions
from those of the page being moved. No proposal was forced or protection relaxed.

The corrected compact `wiki-maintenance-destinations-v2` prompt explicitly exposes
`canReceiveChildren` and `canReceiveCollectionLink`. Human/protected/pinned/reviewed
pages remain protected from mutation while valid unchanged destinations remain
usable. A regression using the coordinator's exact Portuguese topic prose/title
pattern passes the default 8,192 context envelope with 2,048 output tokens and
1,024 reserved overhead; no context enlargement is required.

Decision persistence now records only byte-packed mutation candidates actually
supplied for analysis. Decision identities include the stable bounded selection
context; unchanged no-change results remain quiet, while a changed destination
can make reconsideration useful. Proposed/applied/rejected targets keep their
page-level cooldown. Existing decisions and applied migrations are preserved.
The real PostgreSQL regression verifies that pruned candidates acquire no
negative decision, a later pass analyzes different deferred IDs, an unchanged
no-change scope makes no call, a changed destination is reconsidered, and a
rejected move remains suppressed across further destination changes.

No-change model explanations are displayed as escaped text; no-model internal
English messages remain hidden. Review/restore errors survive successful
background refresh. Maintenance's optional source selector is collapsed and
uses a localized source-selection hint rather than the M2 chunk-pilot limit.
These fixes do not expand backend scope or add a migration. The coordinator owns
fresh C/D real-model and desktop acceptance; the agent did not start DEV or run
real inference during this correction.

Correction verification: 20 focused tests and the complete 92-suite / 566-test workspace suite passed, as did typecheck, build, format/diff checks and the expanded isolated PostgreSQL maintenance verifier. Migrations 0026 and 0027 were not changed.

## Coordinator desktop and real-model acceptance (2026-09-09)

The coordinator ran the real Electron application at its standard 1600 × 1200
opening size with background launch, migrated the existing synthetic DEV to 28
migrations, and preserved the original 82 sources, 82 documents, 82 chunks,
150 notes, 97 conceptual source relations and five pre-maintenance wiki pages.
Twelve explicitly labeled QA wiki fixtures were added (four equivalent triples),
leaving 17 wiki pages. No original evidence, matching cache or AI history was
cleared. Seven acceptance routines were left disabled; the final application
process was stopped after all calls settled.

Every generative case ran local Qwen3 4B and then Luna, with equivalent semantic
inputs, scope and limits. All calls used the main shared FIFO sequentially;
no other local generative model or parallel embedding execution was started.
Luna was the semantic reference. The bounded maintenance prompt fit the default
8192 context with 2048 output allowance and 1024 reserve; no context increase
was needed. OAuth cost remained unknown rather than displaying zero.

| Case | Local result; input/output tokens; time | Luna result; input/output tokens; time |
| --- | --- | --- |
| Initial navigation A/B | Valid no-change; 1023/212; 2711 ms | Valid no-change; 932/93; 3413 ms |
| Corrected navigation C/D | Valid reparent proposal; 1070/364; 3666 ms | Valid reparent proposal, reviewed/applied; 988/276; 6464 ms |
| Empty generated draft archival C/D | Invalid proposal contained, no mutation; 743/244; 2589 ms | Valid archive proposal, reviewed/applied/restored; 703/244; 6133 ms |
| Monthly synthetic instruction sample | Sample passed; 985/331; 3406 ms | Sample passed; 906/262; 5826 ms |

Each row/profile used one admitted call. The initial no-change comparison exposed
an ambiguous destination capability in the software contract. Clarifying that a
manual collection can receive a child without itself being moved produced a
useful navigation proposal from both profiles on fresh fixtures. The local
explanation overstated isolation as a defect; Luna gave a more precise thematic
navigation rationale. The local archival failure remains a disclosed best-effort
limitation, not a reason to loosen validation or load a larger model.

Navigation runs: local `cfbdea2c-1a78-45ec-bcde-a749d28e0e88` was rejected after
comparison; Luna `dd2c6210-405c-4173-81f3-f90133f474a7` moved fixture topic
`927aa5e8-6090-4e48-9cbf-cc3d7250c83c` under its collection and recorded revision
`9f2cf633-87aa-4989-94d4-a365f73099a3`. Independent database assertions verified
that only the parent changed: sections, citation IDs, aliases and every other
content field were identical, with exactly one maintenance receipt.

Archival runs: local `30933dd6-b925-4939-a728-762b5fc4d059` failed validation;
Luna `902e90ae-51ca-43c3-af3a-1df4e0afc39d` archived the empty generated fixture
`6395daba-fe3b-4d53-850c-e594e7c0e13e`. Review created revision
`a74199a6-5497-4210-9e79-e955aabca584`; the visible Restore action created human
revision `46f6a291-4735-43b7-b4d1-0ff6c115652a`. The original, archived and restored
revisions all remain addressable. A repeated restore check made no extra revision.
The coordinator added explicit localized restoration confirmation after observing
that a disabled button alone did not communicate success clearly.

Instruction samples `e80aa5c6-397c-4d8c-9f25-b1eaa189ae46` (local) and
`dbd0e3b7-6467-443a-b8b8-ea4b54f9b036` (Luna) passed through Settings with the same
saved monthly configuration and synthetic injected-content fixture. Their review
UI offers no canonical apply action. The existing active configuration was not
changed. Per-function/domain activation rejection remains additionally covered
by the real PostgreSQL verifier. The active-instruction comparison now resolves
the selected function consistently with the draft preview.

A diagnostic-only run `e359de66-5ef0-4f66-a026-74c04f7e18b8` inspected one selected
manual collection without any AI task. Saving its paused schedule admitted no
work. The UI showed invalid timezone input without crashing, future month-end
clamping across DST, enabled/paused state and next execution; enabling then
pausing the diagnostic routine left no recurring work. Real keyboard Return /
Escape restored focus to its Edit routine button. The normal-size dark UI passed
before/after movement, archive/restore, explicit no-change explanation, bounded
history/sample details, collapsed optional source scope and honest failure/cost
disclosure checks. No full-screen window was used.

Final coordinator verification after the UX corrections passed **92 suites / 566
tests**, full build/typecheck, format/diff checks, the 28-migration seed verifier
and the expanded isolated PostgreSQL maintenance verifier. M3b is accepted.
