# A3 — Collection bootstrap and incremental integration

Date: 2026-09-12.

Status: independently verified and accepted. The coordinator completed selected-Luna,
native normal/minimum-window and actual DEV preservation gates. Delivery uses the
dedicated local A3 branch; A4–A8 remain separate work.

## Implemented behavior

`OrganizationService` now owns collection assessment and bootstrap alongside the
existing curator. Read-only assessment pages report originals, current source
summaries, reusable notes, vector/relation availability, existing/protected pages,
coverage and bounded metadata for excluded related knowledge. Policies support
explicit whole-library grants, descendant exclusions, same-identity revision
previews, pause and resume. Previous grants remain effective while a draft is
being edited; new work is disabled in that draft until activation. Active work selection has its
own fair, bounded cursor and is independent of the paginated result history.

`wiki-bootstrap-v1` persists its source/original cursor, selected-note phase and
child receipts in `organization_runs`. Original groups start at six complete
passages and shrink as whole units when the selected context requires it. Each
curator group retains the A2 twelve-original, three-target, six-patch, shared
repair and ten-minute limits. Larger explicitly selected ingestion operations
enter this parent through the existing participation/barrier path. Selected notes
are reused through their complete original lineage; no summaries, notes, vectors,
matching or graph artifacts are regenerated. Source coverage remains partial
until selected note organization settles.

Per-consumer deliveries distinguish concrete policies, independently of the old
`consumed_at`. Canonical input/event enrollment is transactional and source-free.
Retained events are reconciled in bounded pages; initial old-library discovery is
still a separate explicit bootstrap action. A delivery advances through exact
required page targets and separately considers new-topic discovery. C can find
and update existing A/B knowledge by purpose, aliases and scoped lexical content.
Excluded originals yield metadata-only scope attention instead of a duplicate.

Causal run/group IDs stay backend-owned. Superseded revisions and already-applied
outputs stop causal loops while real downstream targets still run. Child results,
review deferrals, exclusions and propagation attention remain durable. Parent
checkpoint updates use timestamp compare-and-swap; transactional apply locks the
parent state, so a later pause cannot be overwritten or acknowledged ahead of a
subsequent child commit. Coverage uses a separately canonicalized configuration
hash without altering A2 proposal/audit hashes. Meaningful edits permit a new
input generation; identical rejections and administrative pin/order changes do
not acquire fresh inference allowances.

Native navigation now uses keyset/lazy metadata reads, deterministic legacy-cycle
roots and selected-path loading. Recent/pinned overview reads and child links are
independent of tree expansion. Contextual Notes, Sources and Connections use actual
memberships/evidence and backlinks; connections have a bounded map and paginated
list. Reading links are compact text links, including child TOCs. Safe inline
references resolve exact section/group citations or admitted canonical IDs; note
and entity inspectors stay outside paragraph HTML. Mouse extra buttons and native
navigation share one active router, including top-layer priority and driver-event
coalescing. Reading/tree/evidence state survives source navigation and Back.
Accessible contextual creation and before/after/into moves preserve source trees
and reject cyclic destinations.

The registered curator template now distinguishes first organization from required
existing-target updates and describes attributed qualification/contradiction.
Admitted historical pins and all legacy executors remain intact.

## Persistence and migration

Generated forward migrations:

- `0032_faulty_leech`: per-consumer delivery and source-coverage tables, causal/source
  metadata on existing impact events.
- `0033_wakeful_kulan_gath`: concrete consumer keys, transactional enrollment and
  missing canonical INSERT/section impact coverage.
- `0034_wiki_impact_expression_fix`: forward correction of the section-trigger JSON
  expression and source-coverage invalidation.

The baseline/manifest/journal cover 35 migrations. Applied 0030/0031 were not
rewritten. The implementation agent applied and inspected these changes in disposable
PostgreSQL instances, including a populated schema-32 upgrade retaining human revision
bytes and the empty baseline. That agent did not open or migrate actual
DEV, change real sources/vectors/profiles/routes, or touch the user's vault.

## Verification evidence

The dedicated `scripts/verify-automatic-wiki-a3.ts` uses deterministic model doubles
through the actual curator/audit persistence path. Both upgrade and empty-baseline
paths cover:

- read-only inventory and catalog-only participation;
- C created after the first A/B group, automatic delivery applying C before any
  manual repeat, unchanged receipt reuse, and consumer quiescence;
- metadata-only excluded-source decisions and independent enabled/paused policy
  deliveries despite legacy acknowledgment;
- selected ingestion with fourteen complete originals, persisted groups, two
  reused notes, pause/restart, truthful stage completion and no hidden derivatives;
- twenty-two exact dependent targets, cursor continuation, and an untouched sibling;
- a two-page causal cycle, real downstream updates and durable no-repeat receipts;
- parent guard/pause serialization, stale-checkpoint rejection, stable rejection
  and meaningful-input reconsideration;
- no-event/no-call pinning, bounded optional entity references, more than 1,100
  navigable pages, selected cyclic paths and atomic cyclic-move rejection;
- actual Sources/Notes/Connections query and keyset behavior, including canonical
  identity grouping across link/membership/evidence associations before pagination
  and distinct explained connection edges.

Unit regressions cover safe reference binding, native/raw-mouse routing, overlay
unmount coalescing and nested configuration-key order. Final executed checks:

- `npm run typecheck`: passed.
- `npm test`: 119 files and 754 tests passed.
- `npm run build`: passed for all workspaces, including the sandbox preload
  initialization check with only Electron resolvable.
- `npm run db:seed:verify`: all 35 migration entries verified.
- `npm run format:check` and `git diff --check`: passed.
- `node --import tsx scripts/verify-automatic-wiki-a3.ts`: both real PostgreSQL
  paths passed with deterministic model doubles and no user-library access.

The verifier also proves an old active coordinator remains executable/visible
after sixty newer terminal records, and scopes 121 optional entities to bounded
references without reading non-admitted mentions. The coordinator independently
reran automatic wiki A2, wiki, organization, M3, maintenance, prompts and both
Obsidian verifiers; M3 now checks the exact 21 trigger names rather than an obsolete
count of twelve.

## Independent coordinator acceptance

The final root suite passed **119 files / 755 tests**, typecheck, format/diff and
seed35. The complete workspace build passed with the sandbox preload check;
the last renderer-only path-preservation adjustment then passed typecheck and a
fresh desktop/preload build. The dedicated A3 PostgreSQL verifier passed both
populated32→35 and empty paths independently. All eight predecessor verifiers
also passed; the prompt verifier was repeated after the language correction.

Actual selected-model trial `a3-trial-incremental-luna-02` used the existing
configured Luna route (`gpt-5.6-luna`, `openai-codex`) through the real supervisor,
OrganizationService, AiService, FIFO and adapters, on an isolated synthetic corpus.
A/B was applied first; C was created afterward and event delivery updated the
same topic and reading index before any manual repeat. The final text retains
the positive classroom finding, the failed replication under the same conditions,
and the independent distributed-practice finding. It does not infer universal
disproof or a combined-treatment benefit. Exact original citations and TOC groups
were inspected, not merely counted.

The trial used four calls: two initial and two incremental, totaling **8,380 input
and 1,465 output tokens**, with **32,246 ms** reported inference time. C integration
settled in 21,940 ms including its coordinator steps; unchanged delivery settled
without a call. All costs were unavailable, not zero. The protected human page and
zero-note/summary/vector/entity optional state remained unchanged. A C-only policy
was blocked from reading excluded A/B before inference. The prior trial also
passed semantic integration, but initially mixed Portuguese authored headings
with English prose. Its evidence is retained; the curator now supplies the pinned
content language explicitly and distinguishes new headings from original source
labels. Trial02 confirmed English authored titles, purposes and prose while
canonical Portuguese reference names remained unchanged.

Native DEV verification used only a synthetic copy, all policies paused, at
1600×1200 and 960×640, never full screen. Compact TOC/child links, an actual inline
paragraph, note details outside the paragraph, exact citation inspection, source
navigation and sequential Alt+Left return were exercised. Raw mouse extra-button
routing and duplicate driver events were covered by unit tests; CUA did not emit
a physical extra mouse-button click. Notes/Sources showed one item per identity;
Connections retained distinct explained associations and a bounded map/list.
Policy selection, paused/disabled actions, read-only assessment and new context
labels were checked in all five locales, with both themes inspected.

The native scale copy added 1,105 metadata pages plus an inline-reference fixture.
The tree was paged through and page 1,105 opened successfully. A final correction
preserves loaded sibling pages and continuation when hydrating a distant selected
path; opening page 97 and continuing to 147 was rechecked natively. Warm bounded
PostgreSQL tree reads had p95 **3.51 ms** over 24 samples on the recorded Apple M4 Max
reference machine. This measures the database query, not end-to-end UI latency.

The verified pre-A3 schema32 dump was restored and compared before migration.
The coordinator then applied 0032–0034 to actual DEV, verified 35 migration receipts,
new columns/indexes, 21 impact triggers and retained AGE/pgvector extensions.
All existing rows/columns across 91 pre-existing public tables were compared;
only the expected `prompts.active` runtime publication was exempted. DEV retains
13 sources, 13 documents, 10 chunks, 7 summaries, 3 profiles, 335 AI audits and
42 vectors, with zero wiki pages. Migration executed zero jobs/model calls and
activated zero policies; new delivery/coverage tables remain empty. The actual
server was cleanly stopped afterward. Detailed receipts and test profiles stay
in the ignored local `.cache/automatic-wiki-20260912` directory.

## Gate boundaries

The deterministic tests establish persistence and orchestration. The coordinator
separately inspected actual Luna output and the native desktop. This is AI review
of synthetic material, not the human-reviewed corpus acceptance required at A8,
or evidence of uniform quality across models. Earlier native/context findings
were corrected and rechecked before acceptance.

A group still cannot fit an original larger than its canonical passage/context
ceiling or a selected note requiring more than twelve complete originals. These
cases retain explicit attention; originals are never clipped. Broad propagation
is bounded at one hundred visited page revisions per delivery and records the
remaining cursor as attention rather than reporting full integration. Optional
entity references are bounded and omitted counts are disclosed. Maintenance
schedule setup, recurring allowances, investigations and Obsidian layout migration
remain A4–A8 work.

Durable specifications changed in `rules/second-brain.md`, `rules/database.md`,
`rules/jobs-and-processing.md` and `rules/frontend-and-i18n.md`. No stack or dependency
change was needed.
