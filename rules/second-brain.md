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
  domain/function replacement. Only page synthesis is active in this release.
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
