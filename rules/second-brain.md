# Second-brain and wiki rules

Load this rule for wiki pages, second-brain organization/consultation, editorial
knowledge hierarchies, or wiki projection and editing through Obsidian. These
are product constraints for implementation; they do not assert that the wiki
or its reverse synchronization has already shipped.

Also load `rules/ai-and-knowledge.md` and `rules/security-and-privacy.md` for AI
organization/query work; `rules/integrations.md` for Obsidian work; and the
database, jobs or frontend rules when those boundaries are affected.

## Participation and identity

- Every imported source remains discoverable in the wiki catalog, including
  metadata-only containers and sources without atomic notes or graph output.
  Catalog participation does not require an AI-authored page or a fake document.
- Atomic-note generation is optional. Wiki organization can use source evidence
  directly and must not enable note, summary, embedding or graph generation
  merely to satisfy an undocumented prerequisite.
- Import-only remains free of AI execution. AI organization requires explicit
  processing selection or an enabled policy with a defined scope and profile.
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

## User-configurable organization instructions

- Provide a dedicated Organization and harnesses settings section. Expose
  instructions by implemented function and user-defined knowledge domain,
  including global defaults, inherited values and effective overrides.
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
  explicit source IDs (descendants only on request), content language, privacy,
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
  not acquire it retroactively. Its saved plan options require a topic title,
  profile, privacy and optional domain; one batch produces one cross-source
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
  through the same FIFO with privacy checked before input is exposed. Match the
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
- The run snapshot pins configuration, profile/privacy, language, categories,
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
- Obsidian-originated wiki prose remains local in this release. Protect and
  surface all divergence, including generated-region and frontmatter changes,
  even when no plugin is installed. Recovery is a deliberate outward replacement
  with preserved local/base copies; reverse editing remains a separate release.
