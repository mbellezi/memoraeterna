# Second-brain and wiki rules

Load this rule for wiki pages, second-brain organization/consultation, editorial
knowledge hierarchies, or wiki projection and editing through Obsidian. These
are product constraints for implementation; they do not assert that the wiki
or its reverse synchronization has already shipped.

Also load `rules/ai-and-knowledge.md` and `rules/security-and-privacy.md` for AI
organization/query work; `rules/integrations.md` for Obsidian work; and the
database, jobs or frontend rules when those boundaries are affected.

## Automatic wiki product direction

The following are acceptance constraints for the next automatic-wiki version.
The restricted single-page executor, M3b maintenance and existing sync sections
below continue to define their versioned compatibility contracts until explicit
successors are implemented. This direction does not grant new runtime authority.
Implementation sequencing lives in
[the automatic wiki plan](../docs/automatic-wiki-implementation-plan.md).

- Make AI-managed knowledge and native browsing the primary journey: discover
  relevant topics, create/update coherent page and TOC groups, retain original
  evidence, and integrate later inputs under an enabled scoped policy.
- Maintain source-note TOCs, local topic TOCs, global indexes and cross-topic
  maps. Typed links may reference existing notes, sources, pages and entities
  without copying them or manufacturing semantic evidence. Preserve protected
  prose, placements and ordering independently.
- Keep stable Wiki, Atomic notes, Sources and Attachments areas. The Portuguese
  projection uses `Wiki`, `Notas atômicas`, `Fontes` and `Anexos`; Sources is
  classified by canonical source type and preserves parent/child hierarchy.
  Theme structure emerges from useful content. Note identities and registered
  paths do not depend on their participation in multiple TOCs.
- Provide expandable native navigation, typed internal links/backlinks and exact
  evidence inspection as part of the first automatic flow, before export is
  considered sufficient evidence of a usable wiki.
- Activating automatic organization includes setup of the disclosed maintenance
  routines, rather than requiring manual creation of each schedule. Persist
  idempotent setup, cadence/timezone, due/start deadlines, execution limits,
  budgets and catch-up state. Preserve customized schedules; no application
  update silently activates automation or promises closed-desktop execution.
- Content maintenance must update affected unprotected knowledge and TOCs under
  policy, preserve conflicting interpretations/history and present protected or
  significant structural changes for review. An invalidation flag alone is not
  completion of the editorial update.
- Physical Obsidian layout changes require an explicit recoverable migration of
  registered identities, links and exact local/base versions. Do not replace
  existing paths or overwrite local edits merely by changing a layout formatter.
- All curation and maintenance prompts participate in the application-wide prompt
  catalog specified in `rules/ai-and-knowledge.md`; settings do not create a second
  instruction authority or a separate inference queue.

## Versioned automatic-wiki contracts

- `automatic-wiki-v1` is the successor domain contract. Its schemas do not
  activate automation or expand `wiki-three-tools-v1`, legacy maintenance or
  Obsidian v1 authority. Dispatch by admitted version; retain old-run readers,
  exact snapshots and receipts. Unknown versions fail before inference.
- Keep existing page kinds; source/topic TOCs and maps are collection roles,
  investigations are synthesis roles. One source/topic has one canonical TOC
  owner binding. Typed page/source/atomic-note/entity memberships have stable
  IDs, order and independent placement protection. No universal node store or
  duplicate source-relation authority is introduced.
- New curator proposals carry at most three page/TOC targets, six section
  patches per page, twelve complete original passages per synthesis, twenty
  tools, twenty-one admitted model calls including one repair, and a ten-minute
  group deadline including FIFO wait. Lower effective model/policy limits win.
  These development ceilings do not imply measured token/cost guarantees.
- Proposed handles resolve only inside the coherent group; the backend owns
  canonical IDs, authorization and apply. Validate existing references, scope,
  expected revisions, canonical ancestry and protected text/order at apply.
  Commit identities, sections, TOCs, links, dependencies and group receipts in
  one transaction; conflicts never silently apply an invalid subset.
- Preserve section revision identity and provenance on placement/pin-only
  changes. A successor human save protects only changed prose/citations;
  whole-page protection is explicit. Legacy full-save protection remains
  compatible until its versioned successor is implemented.
- Machine support assessment is tied to exact section revision and consumed
  inputs, independently of human verification, management, freshness and sync.
  Exploration may use current machine-validated unreviewed generated sections;
  reviewed-only still requires human verification. Edited, stale, unsupported,
  missing or ambiguously assessed content requires explicit revalidation or
  replacement; relabeling it as a draft cannot make it eligible.
- Conservatively backfill unknown/human/reviewed/protected origin as
  human-managed. Only positively identified unprotected organization drafts
  may be AI-managed, still requiring enabled policy authority. Legacy ambiguous
  `needs_review` remains unassessed; preserve all existing protections/history.
- Automatic routine bindings are unique by policy, routine kind and canonical
  scope fingerprint; preset version is separate data so upgrades cannot create
  duplicates. One reviewed activation binds defaults, preserving custom cadence,
  prompts and limits; reuse existing schedules only after explicit compatible
  reconciliation. Updates never activate policies.
- Initial routine defaults are incremental two-minute debounce / fifteen-minute
  eligible start window / ten-minute execution, daily 02:00 / six hours / twenty
  minutes, Sunday 03:00 / twenty-four hours / forty-five minutes, and month day
  one 04:00 / seventy-two hours / ninety minutes. Slice groups to ten minutes;
  persist eligible-open time, actual overdue time and cumulative allowances.
  A4 calibrates default call/token presets before release. All routines share
  one parent policy allowance; unknown cost never means zero.
- Resume unfinished occurrences before identical sweeps, coalesce closed-app
  misses into one catch-up per compatible scope, preserve each routine's due
  receipt and avoid duplicate investigation calls. Run-now bypasses idle
  preference only. No-input inspection is quiet and invokes no model.

## Participation and identity

- Every imported source remains discoverable in the wiki catalog, including
  metadata-only containers and sources without atomic notes or graph output.
  Catalog participation does not require an AI-authored page or a fake document.
- Atomic-note generation is optional. Wiki organization can use source evidence
  directly and must not enable note, summary, embedding or graph generation
  merely to satisfy an undocumented prerequisite.
- Import-only remains free of AI execution. AI organization requires explicit
  processing selection or an enabled policy with a defined scope. Resolve its
  profile through the task router unless an explicit override is supplied.
- Sources, notes, entities and wiki pages retain distinct stable identities.
  PostgreSQL is canonical; Markdown files and AGE/search projections are not.
- Editorial wiki hierarchy is distinct from source/document hierarchy. Links
  and collection membership allow one object to appear in multiple contexts
  without duplicating it. Presentation paths and graph communities do not
  determine canonical identity.

## Evidence, editing and consultation

- Derived assertions retain references to exact source revisions and evidence.
  Optional notes and graph elements cannot hide or replace their provenance.
  Repeated derivatives are not independent corroboration.
- Keep source attribution, human interpretation and generated synthesis
  distinguishable. Record review/protection and evidence freshness separately.
- Preserve human-edited and reviewed content through explicit revisions and
  proposals; a pending review status does not waive human-edit protection.
- Changed inputs invalidate affected dependents explicitly without silently
  overwriting curated content or redirecting historical citations to new text.
- Catalog/text consultation works without AI. Optional retrieval signals degrade
  explicitly when unavailable. Enforce scope and privacy before retrieval and
  before provider calls, including restrictions inherited by derived content.
- Questions and browsing are read-only. Saving an answer or reorganizing content
  requires the corresponding explicit action or previously enabled policy.

## Organization authority

- Implement the initial harness as an application-specific TypeScript executor
  with explicit states, Zod-validated tools and PostgreSQL-backed progress,
  reusing existing jobs and supervised workers. Keep its scope limited to the
  product workflows; do not build a general agent platform.
- A harness invokes bounded application tools and the existing model adapter
  boundary. The backend owns permissions, privacy, budgets and apply decisions.
- The model may choose permitted read/proposal tools within a bounded analysis
  state. Application code owns authorization, review/apply transitions and
  recovery. Support native tool calls only where validated; otherwise use the
  same domain action contracts through structured output.
- If an external executor is later adopted under `STACK.md`, retain these
  service/tool contracts and define one checkpoint authority per run. Framework
  checkpoints must not become a competing authority for canonical knowledge,
  review decisions or applied mutations.
- Sources, wiki text, notes, frontmatter and model/tool outputs remain untrusted
  data. None can grant capabilities, change policy or approve its own mutation.
- Model proposals use typed operations, scoped targets, expected revisions and
  validated evidence. The organizer receives no arbitrary code, SQL/Cypher,
  filesystem, network, secret, configuration or deletion capability.
- Persist organization progress and audit; apply coherent changes transactionally
  with idempotent mutation semantics and explicit projection recovery. Prevent
  recursive regeneration from the organizer's own output.

## Harness model routing

- All implemented generative harness functions and their instruction samples use
  `structured-output`, as specified in `rules/ai-and-knowledge.md`. There is no
  separate model route for each instruction function or knowledge domain.
- Operation dialogs, processing-batch organization and model-enabled maintenance
  default to the router. An omitted profile override is valid. The optional
  “Force another model” switch follows `rules/frontend-and-i18n.md`; the selected
  override must support structured output. Diagnostic-only maintenance invokes
  no model. Enabling model analysis remains independent of choosing a model.
- Hybrid consultation uses the independent `embedding` route for query vectors.
  The selected model determines local/remote execution; legacy privacy fields
  are compatibility/audit data, not a second permission or selection gate.

## User-configurable organization instructions

- Organization settings retain domain management and schedules. Instruction
  editing lives exclusively in Settings > Prompts; organization and maintenance
  actions deep-link the relevant implemented function and selected domain. Expose
  global defaults, inherited values and effective overrides in that catalog.
- Allow freely editable organizational guidance and a separately disclosed,
  guarded advanced prompt editor. Advanced changes require validation and a
  bounded proposal-only sample before activation; preserve drafts when testing
  is unavailable. Explain risks to output validity and organization quality.
- Required output/tool contracts, authorization, privacy, evidence identity
  and human-edit protection remain enforced by application code. No prompt
  text, including advanced user guidance, bypasses these boundaries.
- Version and audit configuration changes; provide effective previews, reset
  and restoration. Resolve function/domain inheritance deterministically and
  pin the effective configuration for every organization/maintenance run.
- Saving or activating instructions never implicitly reorganizes existing
  content. Reorganization is a separate scoped action or enabled policy.
- Only deliberate settings operations change harness instructions. Models,
  sources, Obsidian prose and frontmatter cannot activate configuration.

## Periodic maintenance and cleanup

- Support configurable weekly/monthly maintenance and on-demand execution in
  Organization and harnesses settings, with function/domain instructions,
  explicit scope, enabled/paused state, budgets and visible results.
- Schedules are opt-in and persisted. Prevent duplicate dispatch and coalesce
  missed/overlapping occurrences; do not promise execution while the desktop
  is closed unless a separately specified background runtime exists.
- Separate broad inspection from bounded mutations. Rebalancing improves
  navigation and conceptual coherence while respecting protected placements,
  stable identities, source hierarchy and human-reviewed content.
- Structural moves, merges, splits and archival are reviewable proposals,
  requiring human review by default. Preserve previous revisions and prevent
  repeated reorganization of unchanged material.
- Cleanup must not grant an organizer hard-deletion capability. Repair derived
  navigation/indexes or propose recoverable consolidation/archival; never erase
  canonical sources, evidence history or pending Obsidian edits automatically.
- Record no-change runs without intrusive notifications. Surface actionable
  changes, required review, budget limitations and failures accurately.

## Obsidian wiki projection and reverse editing

- Project the supported wiki structure, prose and links within the configured
  managed root only while Obsidian sync is configured, enabled and not paused.
  Reuse source/note projections instead of creating independent content copies.
- A first wiki release may offer outward projection before reverse sync, but it
  must preserve divergent local edits and report them instead of overwriting.
  Unsupported plugin/protocol versions must not reinterpret wiki files as
  source documents or atomic notes.
- Establish stable page/section identities, projection/base revisions and an
  explicit editable/generated content mapping before enabling writeback.
- Plugin-originated edits to supported wiki/index prose and existing hierarchy
  text use application editorial services and preserve old revisions/evidence.
  Saving does not implicitly approve content or schedule AI processing.
- File moves do not infer semantic reparenting or source structure changes.
  Generated navigation/evidence text is not an executable mutation language.
- Reverse sync validates capability, registered identity, path, base revision and
  content. Retries are idempotent; offline edits and conflicting versions remain
  recoverable. Absence during reconciliation is never proof of deletion.
- Never cascade a wiki file deletion into deletion of its cited sources or notes.

## Manual workspace persistence and retrieval

- `WikiService` and `createWikiRepository` own the non-AI workspace. Manual
  operations have no AI, matching, ingestion or graph dependency. `wiki_pages`
  stores independent placement/identity, `wiki_page_revisions` stores immutable
  content snapshots, and `wiki_evidence` stores original passage snapshots.
- A save requires the expected current revision. It creates a human-origin
  revision, protects each section independently of page review, and serializes
  placement changes with a transaction-scoped advisory lock. Primary parent
  cycles, missing parents, self-membership and invalid collection/entity targets
  are rejected atomically. Renaming retains the old title as a lookup alias.
- Sections keep UUIDs across edits and reordering. Their citation IDs resolve
  only to evidence owned by that page. New citation handles resolve validated
  original chunk IDs to page-owned evidence IDs inside the save transaction.
  Persist source ID, document ID, chunk/SourceSpan, content hash, original title,
  locator and exact excerpt. Source deletion or supersession cannot redirect or
  erase saved excerpts. Historical content remains available after restoration;
  restoration itself creates another revision.
- Catalog-only/generated metadata chunks (`processingMode: catalog_metadata`
  or `catalog-metadata-v1`) are not original substantive evidence. Exclude them
  from the passage picker and reject them during citation persistence while
  keeping their canonical source discoverable with a catalog-only disclosure.
- Changing cited section prose marks its evidence association `needs_review`;
  retain historical associations and show the warning. Human verification of
  unchanged revised prose is a separate deliberate editorial action. Page
  review, section protection, citation validation and source freshness remain
  independent fields.
- Wiki consultation has a separate bounded text-only contract with distinct
  `page`, `source`, `chunk`, `atomic_note`, `entity`, `entity_relation` and
  `source_relation` result kinds. Exact normalized title/alias matches precede
  other matches. Original source metadata participates without a document.
- Explicit source scopes expand descendants only when requested. A page scope
  intersects the allowed source scope and uses only citations in its current
  revision. Never expose a mixed-scope page's prose, a note with excluded source
  links, or a conceptual relationship unless both endpoints are in scope.
  Scoped entity results omit global descriptions whose provenance is not scoped.
- Current-only retrieval checks exact consumed wiki evidence, citation review,
  source document supersession, note supersession plus primary/linked evidence
  documents, and canonical conceptual relationship currentness. Rejected and
  archived notes remain excluded. Reviewed-only retrieval uses page review,
  approved notes and accepted conceptual relationships; extracted entities and
  entity relations have no equivalent human review state and are excluded.
  Direct catalog facts and source passages do not acquire a synthetic review state.
- Manual wiki navigation preserves the workspace when opening existing source
  details, including native Back to the wiki. Relationship review continues to
  target its canonical source-relation ID, independently of page/note review.
  Restricted source inspectors must not open an unrestricted relationship list.
- `node --import tsx scripts/verify-wiki.ts` exercises isolated real PostgreSQL
  upgrade/baseline paths and these invariants. UI verification uses the normal
  application opening size, never a maximized/fullscreen 4K window.

## Restricted page synthesis executor

- `OrganizationService` owns the initial page-synthesis workflow. The existing
  `JobSupervisor` claims `organization` jobs and supplies cancellation; every
  inference and repair uses `AiService.runOrganizationTask` and the shared FIFO.
  The model-facing structured JSON envelope exposes exactly `searchEvidence`,
  `readRevision` and `proposePageChange`. No native tool transport is claimed
  until a concrete adapter validates it against the same action contract.
- Admission pins one existing target revision or one preallocated new page ID,
  explicit source IDs (descendants only on request), content language, model execution location,
  model identity and effective parameters, instruction revision/hash and policy.
  Target prose cannot be exposed if its cited sources escape the selected scope.
  A domain is an explicit policy context bound to selected sources or wiki pages;
  cross-domain evidence never blends instructions or expands authorization.
- The initial spike accepts at most 200 substantive original chunks, each no
  larger than 12,000 characters. Reject an oversized or empty evidence scope
  visibly; do not silently truncate source passages. Search returns at most 20
  snippets. Only `readRevision` with the complete bounded passage adds its handle
  to the actual read set. Search results and relationship interpretations are
  not citation support. Revalidate ownership, exact revision/hash and freshness
  before proposal and transactionally before apply.
- Optional service-preloaded conceptual relationships retain their canonical
  relation ID, exact evidence-occurrence ID/fingerprint, independent review and
  update snapshot, directed owners and both original passage handles. Require
  both originals in the actual read set. Bound preload by the tool budget and
  recheck the consumed occurrence, not merely whether another occurrence keeps
  the overall relationship current. Accepting a page never reviews a relation.
- Upper bounds are 12 tools, 13 admitted model calls, six section operations,
  one repair and a five-minute execution deadline including inference queue
  waits. Persist reported input/output and known costs; stop new model calls
  after reported input exceeds the configured allowance. Calls can overshoot
  that allowance. Unknown usage/cost remains explicitly incomplete. Retries
  retain cumulative limits and the original execution deadline.
- `organization_runs.checkpoint` is the only workflow checkpoint authority.
  `organization_steps` references existing canonical `ai_task_runs`; the AI
  audit insert atomically records that reference before returning a model
  result. Do not create a parallel telemetry or inference queue. Monitoring
  cleanup cannot remove configuration, proposals, checkpoints or receipts.
- Proposal steps are durable before entering review. Resume a validated saved
  proposal without calling the model again. A canonical apply transaction
  locks cancellation, expected revision and supporting dependencies, preserves
  unrelated sections, appends an immutable organization-origin wiki revision
  and records one `organization_receipts` row per run. Receipt reconciliation
  displays committed edits accurately even when the completion checkpoint or
  acknowledgment was lost. Provider calls after an uncertain interruption can
  repeat; canonical mutations cannot. Never promise exactly-once billing.
- Human review may approve changes to explicitly selected protected sections;
  keep their protection and previous revisions. Automatic application is
  limited to unprotected AI drafts. Human-created pages (including empty ones),
  reviewed pages and protected changes always pause for deliberate review.
  Generated citation associations remain `needs_review` until a separate
  evidence verification action. Omitted sections are preserved, never deleted.
- `organization_settings_revisions` stores immutable full configurations;
  `organization_settings_activations` records deliberate activation history.
  Resolve each editable slot by built-in, global, function, domain and
  domain/function replacement. Page synthesis and read-only consultation have separate implemented slots.
  Advanced templates support only `{{title}}` and `{{language}}`, with no
  executable template language or includes. Advanced activation requires a
  successful proposal-only synthetic run for each changed effective advanced
  prompt; identical inherited prompts may share coverage. A global sample
  cannot authorize distinct, untested domain instructions. Saving, resetting,
  restoring or activating never starts organization. Restoration creates a new
  draft/activation rather than rewriting history. Retain the active revision
  even when it falls outside the bounded recent-history page.
- `scripts/verify-organization.ts` uses isolated populated-upgrade and empty
  PostgreSQL databases to exercise containment, review, cancellation, exact
  evidence and recovery. Its deterministic model fixtures are explicitly
  separate from real local/remote trial evidence in the implementation plan.

- The existing `settings` table key `organization.active` is the serialized
  active-configuration pointer; activation timestamps alone do not decide which
  concurrent settings operation is current. Activity lists return bounded
  summaries without evidence bodies. Load full run snapshots on deliberate
  expansion. Derive per-field usage availability from canonical AI task links,
  and never display an absent cost estimate as zero. Schema repair diagnostics
  retain bounded issue codes/paths, not unvalidated full provider output.
- Retry admission requires a terminal dispatch job as well as a retryable run.
  A cancellation request does not mean the active model has settled; reject
  immediate retry while the original job still owns execution. Validation,
  scope, stale-evidence and budget failures require a fresh run rather than
  bypassing the single repair through supervisor retries.

- Structured-output transport may normalize one complete outer JSON or
  unlabeled code fence, then applies the same strict action schema. Reject
  arbitrary prose prefixes/suffixes, multiple blocks and unknown keys; never
  extract a convenient JSON substring from mixed output. Citation handle lists
  are unique. Validate inline run handles against that section's citation list
  and convert them to the same displayed citation order before canonical save.
  Render new-section proposals at full reading width; show before/after columns
  only when an existing section is being replaced.

## Mixed-source organization, consultation and impacts

- `organizeKnowledge` is an explicit processing stage with only `chunking` as
  its direct prerequisite. Existing named presets and saved effective plans do
  not acquire it retroactively. Its saved plan options require a topic title and
  accept an optional profile override and domain; one batch produces one cross-source
  organization run. Reuse an exact normalized existing title/alias only when
  all current cited sources fit the authorized scope. Ambiguous matches or an
  existing topic outside scope require a visible scope conflict, never a duplicate
  topic or an implicit scope expansion. Placement and protected sections stay
  under the existing wiki revision/review rules.
- Admission inspects every selected derivation checkpoint and active parent and
  per-stage jobs. Idle or succeeded parent jobs do not release pending matching.
  After a terminal upstream failure/cancellation, unreachable selected work is
  explicitly skipped on its own checkpoint with `upstream_failed_or_canceled`;
  organization snapshots preserve those omissions. Do not rerun matching to
  satisfy organization. Keep the original batch failure and successful siblings.
- Summary-v3 concepts, current non-rejected/non-archived notes and scoped entity
  mentions are optional context. Admit complete original provenance in scope;
  summaries with ungrounded/legacy concept strings are not synthesis support.
  Notes also pin a digest of their complete source-link manifest. Entity context
  exposes scoped names/mentions, not unrestricted global descriptions. A proposed
  section's `contextIds` binds consumed interpretations to that section and
  requires every supporting original handle in its citations/read set.
- `ConsultationService` owns transient, read-only cited answers and has no matching,
  relation-write or page-apply method. Text/title, grounded concepts, eligible
  notes, canonical relationships, scoped wiki sections with verified citation associations and entity names provide
  independent lexical signals. Optional vectors use the existing embedding route
  through the same FIFO using the configured embedding route. Match the
  entire provider/model/runtime/dimension/space identity and original content hash.
  No compatible vectors means explicit textual degradation, not document generation.
- Query fusion uses RRF with `k=60`, one contribution per original chunk per
  signal, and reserves other source roots before filling with additional chapters.
  Chapters remain eligible. Reuse the existing 0.48 standalone / 0.40 corroborated
  vector floors; these remain provisional retrieval thresholds, not probabilities.
  Zero-relevance candidates cannot supply an answer. Fetch up to 200 lexical and
  100 independently hydrated vector candidates in at most 500 scoped sources.
  Pack at most 12 complete original passages and eligible optional contexts into
  the selected profile budget before inference; disclose omitted coverage.
- Answers use strict paragraph/citation/context manifests, at most two model calls
  (one repair), 2,048 output tokens per call and a two-minute deadline including
  FIFO waits. Reported input over 30,000 stops a repair; actual usage can overshoot.
  Recheck originals and context at FIFO admission and immediately before the
  provider call, then report changes detected while answering as stale. Do not
  hold a database transaction across inference. Canonical AI audits retain every
  call, including failed/canceled work and unknown usage/cost.
- Unsaved answers are session state, bounded to 20 entries and 30 minutes. Explicit
  save creates an awaiting-review proposal and a settled dispatch job atomically;
  it cannot enqueue another model call. A transaction-scoped request identity
  deduplicates concurrent saves/lost acknowledgments. Link existing query audit IDs,
  preserve the original manifest/profile/instructions and store the validated
  proposal checkpoint so cancel/retry returns to review without inference. Apply
  uses the existing guarded wiki transaction and receipt; a question never applies.
- Consultation has its own global/function/domain/domain-function instruction
  resolution and advanced sample coverage. Legacy configurations without
  `functionsVersion: 2` retain built-in consultation advanced instructions while
  inheriting eligible free guidance; their old synthesis samples cannot authorize
  the new function. A deliberate draft save upgrades the configuration, and every
  changed consultation advanced prompt requires a consultation sample before
  activation. Saving/activation still never launches organization.
- `wiki_dependencies` records exact revision/section consumers, typed original
  inputs, consumed fingerprints/snapshots and independent stale reasons.
  `knowledge_impact_events` records committed input changes in the same transaction
  through database triggers, covering every canonical writer and source deletion
  cascades. Do not reinterpret these events as permission to run AI. Source
  processing progress/status and administrative timestamps alone do not stale
  evidence. Note source-link changes invalidate their consumers, and relationship
  dependencies include the exact occurrence and any originating note relationship.
- Wiki sections depend on exact consumed section content, not unrelated sibling
  edits. Source relation currentness alone cannot refresh a stale consumed
  occurrence. Never invalidate unrelated sections merely because a page was
  touched. Unchanged sections carry their previous dependency snapshots and stale
  reasons into new manual revisions; deleted/superseded originals stay readable
  in historical citations. M3 does not add note generation/editing, note merge/split,
  relationship editing, automatic reorganization or a hard-deletion capability.
- `scripts/verify-second-brain-m3.ts` verifies real PostgreSQL populated M2-history
  upgrades, empty baselines, scopes, exact impacts, read-only/save concurrency,
  optional provenance and processing barriers with deterministic model fixtures.
  Real local/Luna quality and normal-size desktop smoke are separate coordinator
  acceptance evidence.

- Saving a cited answer retains every explicit evidence gap/limitation in its
  generated Markdown, with a content-language heading and the originating
  citation/context provenance. Distribute bounded limitations across existing
  sections (or one additional eligible section) without exceeding six operations
  or 12,000 characters per operation. Never silently discard uncertainty on save.
- Saved/sample query checkpoints retain known per-call token/cost totals and
  per-field availability counts. Unknown remote pricing is not zero. The read
  service reconciles totals and incompleteness against linked canonical AI audits,
  including older saved proposals whose initial checkpoint omitted those values.
- Transactional note-context validation locks the note parent `FOR UPDATE` and
  existing source-link rows `FOR SHARE` before recomputing the complete manifest.
  This serializes new FK links and link updates/deletions with dependency writes;
  later committed changes invalidate the newly committed consumer. Use stable
  dependency lock order and never hold these locks across inference.
- Organizer prompts omit dependency fingerprints and other internal bookkeeping
  while immutable snapshots retain them for validation. Before admission, pack
  optional relations/concepts/notes/entities into the profile budget while
  reserving room for search and two complete original reads. Record and display
  available/included context counts; original passages are never truncated to fit.
  Deferred organization failures show the owning stage and localized checkpoint
  cause even when the original ingestion job already succeeded.

## Persisted recurring maintenance

- `MaintenanceService` owns weekly, monthly and custom-cadence inspection through
  the existing `maintenance` supervisor job. Routines are disabled by default;
  diagnostic-only routines need no model profile. Run now is an explicit bounded
  admission and bypasses only the optional idle preference. Scheduled work runs
  only in the open desktop, normally after one minute of inactivity. Imports,
  foreground AI and pending/conflicting synchronization defer work visibly.
- `maintenance_schedules`, occurrence identities and due windows prevent duplicate
  dispatch. Missed occurrences coalesce into one catch-up. Compatible simultaneous
  weekly/monthly routines share one inspection and pin both effective instruction
  texts, with monthly shown as the broader effective routine. Different profiles,
  privacy, domains, categories, budgets or effective instruction contexts cannot
  silently inherit another active run. Scope normalization is independent of JSON
  property order and ignores irrelevant whole-library selections.
- Selected wiki trees expand only their explicit descendants. Citation provenance
  never broadens a page selection into other consumers of the same source. A
  source-only selection excludes mixed-source page prose; excluded page branches
  remain excluded. Domain membership constrains admission and never grants a
  model authority to widen scope.
- Calendar days missing from a month clamp to its last valid day. A daylight-saving
  gap advances to the first valid local minute, and a fold uses its earlier instant
  only. Changing a schedule, including its timezone, cancels pending authority and
  computes the next future occurrence. The preview uses the chosen timezone and
  interface locale. Paused/canceled occurrences are not replayed automatically.
- The run snapshot pins configuration, profile/model identity and execution location, language, categories,
  review policy and bounds. `maintenance_runs.checkpoint` owns the resumable
  inspection cursor, bounded candidates, coverage and cumulative call state.
  Later occurrences continue unfinished inspection before starting a new sweep.
  Canonical mutations and receipts remain transactional with expected revisions;
  late progress must never resurrect a settled run.
- Inspect deterministic page/source/note diagnostics before invoking a model.
  Current citation loss/dependency invalidation, uncited generated sections,
  empty/unplaced pages, duplicate titles/aliases, unused catalog material, notes
  without wiki connections and branch/page size are review signals. Citation
  `needs_review` alone does not prove changed or unsupported prose. Isolation or
  age alone never makes material disposable. Source/note diagnostics are not
  included in the structural model payload; no note provenance shortcut bypasses
  the M3 manifest boundary. A byte-bounded ranked subset of wiki candidates may
  reach the existing FIFO, with current page revisions rechecked there.
- The M3b model proposal schema permits only reparenting, adding collection
  navigation and recoverable archival of eligible empty generated drafts. Every
  operation requires human review, a reason, minimum expected benefit and exact
  page/destination revisions. Human placements, pinned/reviewed pages and protected
  content remain intact. Archival additionally rechecks live children and incoming
  collection navigation while holding the wiki placement lock. It never erases
  canonical content, evidence, history, assets or vault files. Merge/split and new
  cross-source note editing are later workflows.
- Per-run and UTC calendar-month allowances cover calls, total tokens, inspection
  and proposed/applied changes. Persist reservations atomically with occurrence
  admission. Work crossing a month boundary must also reserve capacity in that
  month before execution or approval; reservation release must not erase known
  usage. Known unspent model capacity is released on a no-call completion or
  cancellation. Unknown/interrupted calls retain conservative capacity and do not
  automatically replay. A strict monetary cap defers model analysis when no reliable
  execution-cost bound is available; uncapped cost remains unknown, never zero.
- Maintenance calls use `AiService.runOrganizationTask`, the same FIFO/adapters
  and canonical `ai_task_runs`. Its audit insert and `maintenance_steps` reference
  commit together. Monitoring cleanup cannot remove schedules, proposals,
  occurrence/budget records, decisions or mutation receipts.
- Stable input/configuration/model fingerprints prevent repeated analysis, while
  recent proposed/applied/rejected decisions and configurable cooldown prevent
  oscillation. Settings expose weekly/monthly/cleanup guidance and domain overrides.
  Version 3 explicitly opts new functions into advanced inheritance; each changed
  effective advanced function/domain prompt needs its own successful bounded sample.
  Samples never apply canonical edits or count as real-model quality acceptance.
- Maintenance history distinguishes inspected coverage, findings, omitted/deferred
  work, model usage availability and errors. Review requests, failures and budget
  limitations receive visible in-app attention; unchanged completed inspections
  remain quiet. Tree previews compose all proposed moves and retain IDs, aliases,
  expected revisions and the before/after navigation paths.

- Structural prompt permissions distinguish the changed `pageId` from unchanged
  destinations. `eligibleMove` protects the former; supplied current non-archived
  pages may receive children, and collections may receive navigation links, even
  when human/protected/pinned/reviewed. Explicit destination capabilities never
  authorize moving or editing the destination itself.
- Maintenance decision identities include the bounded inspection/destination
  context before cooldown and byte pruning. Record only mutation candidates
  actually supplied to the model. An exact unchanged no-change result is quiet;
  changed context may reopen it. Recent proposed/applied/rejected operations keep
  their conservative page-level cooldown. Supplied candidates with no proposed
  operation retain a no-change outcome, independently of other proposed targets.

## Outward wiki synchronization

- Wiki release 1 uses the persisted outward format and safe delivery contracts
  in `rules/integrations.md`. Canonical revision, evidence, review, section
  protection, scope and hierarchy remain independent from sync state.
- Source-relationship projections reuse canonical relation identity and both
  historical original evidence sides; generated summaries cannot approve or
  alter relationships. Metadata-only catalog references never require notes,
  graph output, AI execution or fabricated original documents.
- Without an authorized compatible editorial plugin, Obsidian prose remains
  local. Preserve every divergence, including generated regions and frontmatter.
  Authorized reverse editing follows the editorial synchronization contract in
  `rules/integrations.md`: human-origin revisions, protected changed sections,
  independent review, retained historical evidence, exact merge bases and explicit
  conflict resolution. Source relationships cannot be approved through prose.
- A new human section has a stable UUID and no fabricated evidence. Changed
  assertions retain their historical evidence associations but need evidence
  review. An explicit navigation command in the application owns semantic
  reparenting/reordering; moving a vault folder does not grant that authority.

## Automatic curation first slice

- `OrganizationService` dispatches `wiki-curator-v2` separately from legacy
  `wiki-three-tools-v1`. The successor uses the same organization jobs, run
  checkpoint, proposals, step/audit links and supervisor. Its three deterministic
  bounded reads load a scoped knowledge index, typed existing references and
  complete originals. Synthesis proposes the coherent group; a separate bounded
  semantic support check validates its claims and metadata against those originals.
  The tool count includes those reads and each synthesis/check action.
- The model transport separates topics from indexes. Index owners distinguish
  topic, source and map; ordered short reference handles identify members. Backend
  code resolves exact admitted IDs, fingerprints, roles, section/page revisions,
  membership purpose and initial placement into `CuratorChangeSetSchema`. Original
  `eN` citation handles never authorize typed navigation targets. Selected existing
  notes must appear in a reading group without being regenerated or duplicated.
- Scope activation is deliberate and follows an effective preview of source
  titles, routed/overridden model, permissions and ceilings. Draft creation and
  activation do not run curation. Migration never enables a policy. The A2 trigger
  is explicit selected processing; later recurring setup retains its own version.
- Defaults retain the A0 ceilings, with a 2,048-token maximum output reservation
  per model call and lower profile limits winning. The bounded first slice refuses
  scopes exceeding twelve complete originals or one hundred scoped existing pages.
  It never clips an original passage to fit. Deadline starts at run admission and
  includes FIFO waits. Repeated admission of unfinished/failed identical inputs
  returns the same run; unchanged applied targets return the existing receipt.
- Prompts, including repairs and reference guides, are actual catalog entries.
  Repair persists bounded actionable issue paths/messages. If the complete invalid
  prior draft cannot fit, omit that whole draft from repair context while retaining
  it in the checkpoint; never omit part of an original passage. Model ambiguity or
  exhausted repair is a visible failure, not permission to relax the output schema.
- Persist a structurally valid candidate before checking semantic support. The
  support verdict must cover every target, including sections, titles, purposes,
  explanations and TOC attribution. Unsupported candidates remain inspectable but
  cannot apply through automatic or human group approval. One shared repair may
  fix draft structure, semantic issues or an invalid verdict, followed by a fresh
  complete support check where needed. Normal execution uses two model calls;
  repairing an unsupported draft uses at most four, within cumulative ceilings.
- A model-supported section remains visibly unreviewed by a person. Record the
  exact proposal hash, support verdict and canonical audit identity. Structural
  reference checks alone do not qualify unreviewed generated knowledge for current
  consultation. Human evidence verification stays independent. The model check is
  an assessment, not a guarantee of entailment or human approval.
- Neutral editorial grouping of faithfully attributed findings is useful and
  allowed. A semantic rejection identifies a concrete unsupported assertion or
  misattribution; style preferences, hypothetical confusion and positive/no-issue
  observations are not support failures. Real-model acceptance checks positive and
  fabricated-negative cases; valid JSON alone does not certify usefulness.
- Specific technical mechanisms, interventions or experimental-variable labels
  must fit each classified member's own original lineage. A broad editorial
  subject does not authorize assigning one source's specific mechanism to every
  source or note under its topic or group heading.
- The review-only view binds complete originals directly to each section and each
  typed membership. A section is not required to describe other sections' sources;
  a group is assessed against its own members, and the page has an editorial
  umbrella scope. Remove irrelevant canonical identifiers from this model view
  while preserving the exact full-proposal hash and audit binding for apply.
- Existing reference titles/bodies are explicitly read-only context in the review
  view. Linking a pending note does not endorse all its unchanged wording. Review
  authored page/section/group claims and the membership association against original
  lineage; never request edits to supplied source/note metadata. A verdict pointing
  into read-only metadata/original text is an invalid check, using the shared repair
  to recheck the same candidate rather than regenerate content for an impossible edit.
- Native version-2 saves compare individual sections with the exact base, protect
  only changed prose/citations and preserve omitted sections. Pin/placement-only
  changes retain section revisions, provenance, assessments and dependencies.
  Explicit verification of unchanged citations creates a separately assessed,
  protected section revision; it cannot verify unavailable originals.
