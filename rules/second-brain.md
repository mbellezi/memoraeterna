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
