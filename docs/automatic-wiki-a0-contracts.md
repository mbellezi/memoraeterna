# A0: automatic wiki contracts and executable acceptance design

Date: 2026-09-12. Status: A0 contract/fixture gate independently verified and accepted.
A1–A8 runtime and product acceptance remain pending. This report
neither activates policies nor claims that the current application implements the
new executor, prompt catalog, scheduling, browsing or migration behavior.

The local DEV checkout is the execution environment. Fixtures contain invented
material only; no fixture importer or model runner is introduced. No Drizzle
schema or migration changes are included in A0.

## Contract ownership and version dispatch

[automatic-wiki.ts](../packages/domain/src/automatic-wiki.ts) freezes the new
`automatic-wiki-v1` payloads. [prompt-catalog.ts](../packages/domain/src/prompt-catalog.ts)
freezes `prompt-catalog-v1`. Existing `WikiPageContentSchema`,
`wiki-three-tools-v1`, `wiki-maintenance-v1`, instruction `functionsVersion` and
Obsidian format/capability v1 remain unchanged. A new schema does not expand an
old executor's tools or its permission to apply changes.

A2 admission dispatches explicitly by snapshot version inside OrganizationService.
Keep the existing `organization_runs.checkpoint` as the sole run checkpoint,
`organization_steps` as references to canonical AI audits and the existing FIFO.
A v1 legacy checkpoint always uses its legacy parser, tool set and pinned settings;
unknown versions fail before inference. New processing-plan admission uses a new
versioned `integrateWiki` choice carrying a policy revision and no title; old
presets and saved plans retain their original meaning. Import-only never enrolls
an AI operation. A4 adds a distinct automatic-maintenance snapshot version; the
existing weekly/monthly/cleanup snapshot cannot acquire daily/event semantics.

### Canonical roles and navigation

- Keep existing page kinds. `topic` and `entity` retain their meanings;
  `synthesis` gains an explicit investigation role; `collection` gains source TOC,
  topic TOC and map roles. A source TOC belongs to one source; a topic TOC belongs
  to one topic; a cross-topic map has no exclusive owner. The home and global
  indexes are deterministic views, not model-authored sources.
- Use one collection/group/membership implementation for all TOCs. A page may
  contain prose and link to its unique topic index. A group has a stable UUID;
  a membership has its own UUID and typed page/source/note/entity target, purpose,
  order, origin and placement protection. Secondary membership neither duplicates
  an object nor creates a semantic source/note relationship.
- Source parentage remains on `SourceItem`; primary editorial parentage remains
  on `wiki_pages`. An entity explanation links to an existing entity ID. Sources,
  bibliography and attachment assets retain their present ownership.
- `CuratorChangeSetSchema` represents a maximum of three page/TOC targets, titles,
  purposes, exact revisions, initial placement, cited section patches, groups and
  ordered memberships. Proposed handles refer only to objects in that group.
  The backend allocates UUIDs. Model references never authorize access to arbitrary
  UUIDs. Schema checks reject duplicate targets/patches/groups/memberships,
  unresolved handles, non-page parents and cycles among proposed parents.
- Apply-time repository checks additionally resolve every existing reference
  against admitted scope, ownership, current revision and read evidence; validate
  canonical ancestry, source-TOC uniqueness and protected membership/order. These
  are explicit A2 gates, not capabilities supplied by the schema validator.
- A substantive TOC explanation needs original evidence. A simple navigation
  label needs a resolvable target only. Generated indexes never enter ingestion,
  source evidence or semantic matching. Rejected/archived notes leave active maps
  while old revisions remain available.

### Protection and evidence assessment

Keep management (`ai_managed` / `human_managed`), prose protection, placement/order
protection, human verification, machine support, evidence freshness and sync state
independent. Exact section revision is an identity distinct from page revision;
unchanged sections retain their section revision even when the page is renamed,
pinned, moved or another section changes.

A fresh generated section with machine-validated original references and pending
human verification is eligible for labeled exploration. Reviewed-only still
requires human verification. An edited assertion, missing original, failed support
check, stale input or assessment of another section revision is ineligible.
`revalidated` records successful support revalidation; relabeling an
`input_changed` or `prose_changed` assessment as a draft cannot admit it.
Machine checks never set human verification.

Audited baseline: `wikiRepository.save` protects every section on a human save;
`WikiService`/the renderer also submit full page content. This legacy behavior is
preserved by A0. The A2 successor compares section ID, title, kind, Markdown and
citation handles with the exact base. A title/prose/citation change creates a new
section revision, marks support unassessed/invalidated as appropriate and protects
that section. A placement/pin-only save copies all section provenance, protection,
assessment and dependency records unchanged. Whole-page protection is a separate
explicit action. Omitted sections are preserved, never interpreted as deletion.

Conservative migration uses `legacyWikiManagement`: only positively known
organization-origin, unreviewed, unprotected content is potentially AI-managed.
Unknown/human/Obsidian/reviewed/protected content remains human-managed. Existing
protection is never cleared. Legacy `needs_review` with ambiguous cause becomes
`unassessed` / `legacy_ambiguous`, not fresh machine-validated evidence. Exact
historic excerpts survive source removal and are not silently redirected. Eligibility
still requires an enabled policy; classification alone starts no work.

## Minimal persistence extensions and migration sequence

These are selected persistence responsibilities, to be implemented by the owning
milestone. A0 adds no tables and applies no migration. Use generated append-only
Drizzle migrations, synchronize the empty baseline and verify both populated
upgrade and empty paths using real temporary PostgreSQL.

| Milestone / existing owner | Selected extension and constraints |
| --- | --- |
| A1 / organization settings history, canonical AI audit | Add prompt revision, activation and legacy-migration mapping tables. Drafts remain recoverable; activations reference immutable effective compositions. Unique mapping from legacy configuration revision/function/domain/slot prevents duplicate imports. Add prompt IDs/revisions/hash to canonical AI metadata and fingerprints; retain old audits as explicitly legacy. |
| A2 / `wiki_pages`, `wiki_page_revisions` | Add versioned management/role/purpose/current brief/coverage to revision content; project only query-critical management/role into page columns. Retain existing UUID and immutable history. Add stable section-revision identity and assessment records keyed by section revision; content remains in page snapshots rather than a second universal node store. |
| A2 / wiki navigation | Add `wiki_toc_groups` and `wiki_memberships` current query records plus immutable snapshots in page revisions. Unique source/topic TOC owner binding; indexes by page/group/order/ID and typed target for backlinks. Target kind and target UUID remain distinct, with repository-enforced referential validation for polymorphic targets. Group/membership writes, revision snapshots and dependencies share one transaction. |
| A2 / organization | Reuse organization runs, proposals, steps and checkpoint. Add group-level multi-target receipts and per-target revision mappings; unique `(run_id, group_id)` receipt. Keep legacy single-page receipts readable; never overwrite their revision ID with one arbitrary result of a multi-page group. |
| A2 / policy | Add automatic policy immutable revisions and activation history with scope, triggers, operations, limits, model override and instruction composition bindings. Apply rechecks the active revision and enabled state under locks. Saving a draft is not activation. |
| A3 / `wiki_dependencies`, `knowledge_impact_events` | Extend dependencies with consumer kind (section or TOC explanation/navigation) and exact consumed revision/fingerprint snapshots. Extend impact events with input generation and causal run/group. Add one consumer-delivery table with unique `(event_id, consumer, input_generation)` and durable run/receipt binding; use pending/leased/deferred/acknowledged states. |
| A4 / maintenance schedules/runs/occurrences | Reuse tables with version-dispatched payloads. Add routine setup bindings unique on policy/kind/canonical scope, preset version as separate data, and occurrence eligible-time/cursor/allowance state. A parent policy monthly ledger and atomic reservations cover all installed routines; preserve existing custom schedules and legacy runs. |
| A5 / investigations | Add followed-question records bound to a synthesis page, policy/scope/state/gaps and last input fingerprint. Append immutable evaluation/answer history and unique `(investigation_id, input_generation, composition_hash)` receipts. Ask-only remains transient. |
| A6 / Obsidian registry/outbox | Extend projection configuration with layout version/language and category bindings. Add migration plan/target journal with exact base/local/proposed bytes, hashes, ownership, backup and receipts; reuse the target write coordinator and registered paths. |
| A7 / temporal interpretation | Deferred until A7's ownership gate. Do not reuse replaceable graph relation/claim rows as immutable temporal assertions or enable cross-source note consolidation before safe deletion ownership exists. |

### Consumer ownership decision

Choose **per-consumer deliveries**, not a second dispatcher queue. Inspection of
`schema.ts` and migration triggers finds `knowledge_impact_events.consumed_at` and
transactional invalidation; there is no implemented durable fan-out worker in the
current service/repository code. `consumed_at` stays legacy/audit data and is never
proof that the curator or investigation consumer finished.

A3 migration takes a transactionally bounded event high-water mark, creates
consumer rows for retained relevant events, and reconciles current dependency
state so pre-migration gaps cannot be missed. Do not treat previously non-null
`consumed_at` as acknowledgment for new consumers. New event writes and delivery
rows commit with canonical mutation. Leases recover on crash; acknowledge only
with a canonical receipt, explicit unchanged-input inspection receipt, or an
explicit scoped exclusion receipt. Paused work is deferred, not acknowledged.
Consumers may share an admitted inspection/run when policy and composition match,
but each retains its own receipt. Causal run/group plus visited revision fingerprints
prevent self-echo loops while allowing real cross-page invalidation.

## Prompt caller inventory and golden evidence

The executable source scan in
[automatic-wiki-prompts.test.ts](../apps/desktop/src/main/services/automatic-wiki-prompts.test.ts)
inventories all direct AI callsites in desktop main code, including routing
forwarders, search, benchmark and supervisor. The committed snapshot is a frozen
baseline: **rendered output** snapshots invoke actual current builders; **source
fragment** snapshots preserve exact inline repairs, typed serializers, state text,
adapter instructions and call expressions. Source fragments are inventory evidence,
not proof those callers executed or that A1 migration is complete. A1 must replace
this temporary inventory gate with registry caller-spy coverage as each family moves.
Do not approve changes to a golden merely to make a migration test pass.

| Catalog family / stable leaf proposal | Current owning file and function | Frozen material / A1 requirement |
| --- | --- | --- |
| `summary.short`, `.partial`, `.reduce` | `knowledge-processing.ts`: `summaryPrompt`, `summaryReductionPrompt`, `generateSummaryFromChunks` | Actual short/map/reduce outputs and real map/reduce caller spy; non-content sentinel/schema and grounded concepts included. |
| `summary.aggregate` | Same: `buildAggregateSummaryPrompt`; KnowledgeService hierarchy caller | Actual parent-kind/title and ordered child-summary composition. |
| `notes.extract`, `.repair` | Same: `buildAtomicNoteGenerationPrompt`, `buildAtomicNoteRepairPrompt` | Actual schema/IDs/feedback/previous-output output. |
| `notes.match` | Same: `buildBatchRerankPrompt`; KnowledgeService matching caller | Actual direction/aliases/relation/explanation contract. No repair path is invented where the current caller has none. |
| `graph.atomic_notes`, `.source_chunks`, `.catalog_metadata`, each `.repair` | Same: graph builders and batch execution | Actual outputs for all three variants and repairs, alias/schema/language fragments and remaining limits. |
| `graph.relation_identity`, `.repair` | `relation-type-resolution.ts`: `buildRelationMatchPrompt`, `confirm` | Actual normal builder output plus inline repair source fragment; A1 spy must execute both attempts. |
| `graph.entity_identity`, `.repair` | `entity-identity-resolution.ts`: shared identity variant, `confirm` | Actual identity builder output plus different inline repair suffix; source evidence and English identifying facts stay distinct from display language. |
| `graph.relation_labels`, `.repair` | `relation-label-processing.ts`: `buildRelationLabelPrompt`, `processRelationLabels` | Actual label builder output; inline invalid-output suffix inventory; A1 caller spy required. |
| `sources.match`, `.repair` | `source-relation-processing.ts`: `sourceRelationPrompt`, `matchSources` | Actual base output and inline dynamic validation-feedback suffix; A1 caller spy covers source aliases, context budgets and two attempts with populated input. |
| `organization.legacy_synthesis` | `organization-service.ts`: `prompt` and `execute`; domain instruction slots | Actual discover/read/propose compositions. Repair is a transcript result, not a separate model tool; its complete literal and transcript serializer are frozen. Legacy samples call the same executor. |
| `consultation.answer`, `.repair` | `consultation-service.ts`: `consultationPrompt`, `ask` | Actual grounded-answer base composition plus inline strict JSON/citation repair suffix. Synthetic sample uses the same caller. |
| `maintenance.weekly`, `.monthly`, `.cleanup` | `maintenance-service.ts`: `maintenancePrompt`; domain built-in slots | Actual routine compositions and full structural contract. No repair exists in the current maintenance executor; invalid/uncertain calls retain spent allowance. |
| `embedding.query_instruction` | `ai-service.ts`: `withEmbeddingInputInstruction` | Actual Qwen query prefix, document passthrough and other-model passthrough. Shared generation language is never applied to embeddings. |
| `embedding.content` | `job-supervisor.ts`, `hierarchical-ingestion-service.ts`, KnowledgeService, `canonical-embedding.ts`, identity/type resolvers | Actual catalog/entity/type serializers; source chunks passthrough and note `title + idea + body` source expressions captured. Source vectors combine header and content vectors; no fictional summarization prompt. |
| `embedding.query` | `search-service.ts`, KnowledgeService, `runConsultationEmbedding` | Caller inventory records raw query forwarding, independent embedding route and scope. |
| `diagnostics.embedding_warmup` | `matching-benchmark.ts` | DEV-only note warmup duplicates note serialization today; include it in A1 strategy identity/caller migration. |
| `shared.output_language` | `ai-service.ts`: `withOutputLanguageInstruction` | Actual output for all five locales. |
| `diagnostics.local_generation`, `.local_embedding` | `ai-service.ts`: `testLocalModel` | Exact `Reply with exactly: OK` and `query: local embedding smoke test` source literals; adapter smoke route/audit remains discoverable. |
| `shared.codex_adapter_instruction` | `packages/ai/src/openai-codex.ts`: `execute` | Exact app-owned `You are a helpful assistant.` instruction. It is app wording and must migrate; provider-owned/model-native chat formatting remains external provenance. |

The public pure-builder exports and extraction of `buildRelationLabelPrompt` are
mechanical test seams; call text/order and permissions are unchanged. No runtime
caller resolves the new catalog yet. No provider/model test is executed by A0.

### Prompt migration and variable rules

A1 uses immutable shipped definitions, drafts and activation history in one
registry. Precedence is default → global → function → domain → domain/function;
full-template replacement is distinct from guidance inheritance. Each field lists
its exact used tokens with five-locale description, value type, backend origin,
required status, synthetic example, sensitivity and serialization. Credentials
are never registered variables. Domains are explicit, never inferred from text.

Use `%snake_case%`, `%%` for literal percent and ordinary `50%` as literal text.
Malformed/unknown tokens, unresolved required data, types, missing enforced
contract dependencies and fragment cycles fail before queue admission. Interpolate
once; source-contained `%token%`, shell-like text and legacy braces stay literal.
[prompt-variables.json](../scripts/fixtures/automatic-wiki/prompt-variables.json)
is the executable input/expected-result oracle that A1's renderer tests must consume.
A0 validates its structure and coverage; it does not pretend a renderer exists.

Mechanically migrate only known builder inputs and supported legacy
`{{title}}`/`{{language}}` slots. Preserve ambiguous drafts unchanged for correction.
Record legacy source revision/function/domain/slot mapping and verify effective
text against goldens before activating migrated settings. Keep original active
configuration until validation succeeds; retain legacy snapshots for admitted jobs.
Shared edits list impacted compositions and need appropriate bounded sample coverage.
A missing model leaves a saved draft, never a silent advanced activation.

Every future admission pins prompt IDs, revisions, composition hash, output
contract and effective model/parameters; retries keep them. Ordinary audit stores
IDs/hashes, not source bodies. Full prompt/output capture retains existing Monitoring
opt-in. Embedding instruction or serializer changes alter strategy/space identity
and require explicit re-embedding; no incompatible vector comparison or automatic
library regeneration follows a save.

## Routine setup and calendar contract

The four defaults are executable data in `automaticRoutineDefaults`: incremental
2-minute debounce, 15-minute eligible start window, 10-minute execution; daily 02:00,
6-hour window, 20-minute execution; Sunday 03:00, 24-hour window, 45-minute execution;
month day 1 at 04:00, 72-hour window, 90-minute execution. All semantic groups cap at
10 minutes including FIFO wait. Followed investigations share changed-input work
in incremental/daily occurrences, not a fifth duplicate schedule.

Setup identity is `(policy_id, routine_kind, canonical_scope_fingerprint)`. The
preset version is recorded separately: including it in the uniqueness key would
multiply schedules on upgrade. Canonical scope fingerprints sort/deduplicate IDs
and include exclusions/descendant/domain semantics. `automaticRoutineSetupKey`
accepts this already canonical fingerprint; it never hashes arbitrary user prose.

One explicit policy activation transaction creates/binds the four routines and
records the reviewed preview. Reopening/restarting is idempotent. A compatible
custom schedule may be bound only after the preview identifies it; compatibility
requires the same scope, supported operation contract, effective prompts and
allowance authority. Similar names/times alone do not permit adoption. Preserve
custom cadence/prompts/budgets; incompatible overlaps remain separate or explicitly
paused by the user's selected reconciliation. Upgrade/reset never erases history.
Missing model routing gives needs-configuration while deterministic inspection
continues. Installing an update creates no activation.

Selected IANA timezone controls due instants. DST gaps advance to first valid
minute, folds run once, nonexistent month days clamp. Existing calendar helpers
are regression-tested with London gap/fold and February 31. Daily/event scheduling
needs the new version rather than reinterpreting legacy custom cadence.

Persist due UTC instant, timezone/cadence revision, occurrence ID, eligible open
elapsed time, active group elapsed time, paused/deferred time, cutoff/input generation,
cursor, actual overdue interval, snapshots and cumulative usage/reservations.
Start windows accrue only while the desktop is open and eligible; deferred reasons
(model configuration, foreground imports/AI, sync conflict, inactivity) remain
visible. Resume the same unfinished cursor first; coalesce closed-week misses into
one catch-up per compatible scope. Each overlapped routine keeps its due receipt.
Run-now bypasses the one-minute idle preference only. Pause/cadence edits revoke
future admission and guarded apply; retry cannot reset occurrence/month allowances.

A4 calibrates versioned default call/token allowances from explicitly authorized
A2 real-model measurements. Null cost is unknown, not zero or unlimited. This is
an unresolved A4 release measurement, not an omitted A0 contract or invented cost
promise. Shared parent policy reservations prevent four routines multiplying one
allowance. Exhausted time/budget checkpoints incomplete coverage. Unchanged input
records inspection without inference or notification.

## Synthetic journey and native walkthrough

[mixed-library.json](../scripts/fixtures/automatic-wiki/mixed-library.json) contains
12 sources covering every canonical type, actual book/chapter and paper/section
parentage, periodical children, catalog-only objects, optional notes/summaries,
personal/daily material, an existing protected human page and A/C contradiction.
All claims are explicitly fictional. Expected assertions are separate from source
text and must never enter model context. [first-change-set.json](../scripts/fixtures/automatic-wiki/first-change-set.json)
is a schema-validated three-target proposal with one shared note identity.

A2/A3 native DEV walkthrough uses a disposable database fixture, 1600×1200 normal
opening size and 960×640 minimum (`main/index.ts`), `MEMORA_DEV_BACKGROUND=1`,
all five locales and light/dark themes. It must be performed against the actual
new UI, not replaced by this document or a rendered mockup:

1. Start empty/no-model: stable areas and catalog/intake remain useful, automatic
   work disabled and no AI admissions. Show loading/retryable error states.
2. Admit A/B under a scoped enabled policy without a page title. First use selected
   atomic notes, then repeat on an independent originals-only fixture; assert no
   optional stage is silently enabled. Show partial work if a selected derivative fails.
3. Read the first useful topic and source/topic TOCs; disclose unreviewed generated
   state. Arrow/Home/End navigation expands/collapses themes with focus retained.
4. Follow the same note from both indexes, open its exact original passage and Back.
   Restore page, evidence, scroll, question and filters. Catalog-only references
   have no invented text; protected human page retains exact bytes/provenance.
5. Retry unchanged A/B: compare canonical page/note/group IDs and receipt counts;
   no duplicates or unnecessary inference. Interrupt before/after proposal/apply
   to verify resume using the same snapshot and receipt.
6. Import C later. Discover the existing A/B topic by purpose/aliases, read authorized
   originals, qualify only relevant sections, retain the contradiction and unchanged
   section revisions. Repeat with A excluded: no A prose exposure or bypass duplicate.
7. Pin a page, then edit one section and one order: protection changes only the
   selected dimension. Concurrent human/plugin edits or policy pause block late apply.
8. In A3, use at least 1,201 pages: navigate/paginate to the last page, breadcrumbs,
   backlinks and contextual Notes/Sources. Empty/loading/error/partial/stale states
   remain readable at minimum width; native screenshots are required evidence.
9. In A4, verify settings preview/routines, overdue reasons, pause/run-now and quiet
   unchanged inspection across restart. In A5, consult compiled pages first, inspect
   originals, ask without persistence, explicitly follow and refresh once per generation.

A0 tests exercise schema/fixture integrity and legacy prompt outputs only. They do
not establish semantic model quality, the native journey, scheduler execution,
concurrency transactions, database upgrades or complete prompt caller migration.

## Obsidian migration design

[path-map.json](../scripts/fixtures/automatic-wiki/path-map.json) specifies the
synthetic old-to-new map, source taxonomy, original hierarchy, stable note path,
Unicode titles, repeated title and explicit dirty/missing/collision exclusions.
Paths are relative to `Memora Eterna`; changing interface locale moves nothing.
A6 implements layout capability `automatic-wiki-layout-v1` and negotiates supported
editable/generated regions separately from existing editorial/projection v1.
Old/no-plugin clients cannot reinterpret TOCs/wrappers as source or note mutations.

Assessment inventories registered IDs/paths, ownership, acknowledged base,
canonical revision, current file bytes/hash, pending operations, tombstones,
capabilities and unmanaged collisions. Present exact old→new paths and generated
links; dirty/open targets require conflict resolution or explicit exclusion.
Persist the plan and backups before mutation; acquire the existing per-target
coordinator and recheck scope, sync enablement, actual bytes and open-editor state.
Journal states are in the fixture. Exclusive/CAS writes plus SQL receipts reconcile
filesystem-before-registry and registry-before-link crashes; never claim whole-vault
atomicity. Reconcile intended bytes to recover lost acknowledgments without rewriting.

Keep source/page/note IDs, historical revisions and unmanaged frontmatter/prose.
Rewrite only registered generated links, with path-qualified aliases and NFC/case,
reserved-name/path-length collision checks. Assets project once per managed asset
identity; omitted binaries remain explicit. Promoting catalog-only sources reuses
their path. Moving a physical folder never reparents canonical source/editorial trees.
Rollback checks for edits after migration and retains base/local/proposed backups;
it cannot blindly restore old bytes. Paused/unconfigured sync writes nothing.
Actual temporary-vault/open-editor/offline/old-plugin recovery belongs to A6/A8.

## Verification and handoff

A0's executable checks are domain contract negatives, synthetic fixture integrity,
existing calendar boundaries, actual rendered prompt goldens and exhaustive direct
AI caller/source-fragment snapshots. Run:

```sh
npx vitest run packages/domain/src/automatic-wiki.test.ts packages/domain/src/prompt-catalog.test.ts apps/desktop/src/main/services/automatic-wiki-prompts.test.ts
npm run typecheck
npm run format:check
```

No migration generated/applied; no real AI, packaged app or user vault was used.
The coordinator independently verified the complete diff, all 107 test files / 667
tests, `npm run typecheck`, `npm run format:check`, `git diff --check` and
`npm run build`. The build covered desktop, preload, extension, plugin and packages.
The complete test suite requires local loopback access for its gateway/OAuth tests;
the restricted sandbox alone reports EPERM for those five tests.

Baseline real-PostgreSQL verifiers for wiki, organization and second-brain M3
passed populated-upgrade and empty-baseline checks in temporary DEV databases.
The existing maintenance verifier has a pre-existing hardcoded migration count
of 28 versus the current journal's 30; repair that assertion with A4's verifier
changes without dropping its behavior checks. No new A0 migration was needed.

See [the acceptance matrix](automatic-wiki-a0-acceptance.md) for every product target's
owner, reusable input and required later test. Baseline verifiers/tests do not
substitute for those downstream gates.
