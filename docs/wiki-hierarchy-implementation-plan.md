# Wiki hierarchy: topics, reading TOCs and entity pages

Date: 2026-09-14.

Status: proposed implementation plan; no implementation or acceptance gates have
been completed by writing this document. The agreed scope is deeper editorial
hierarchies for topics, atomic-note tables of contents (TOCs) and entity pages,
with selective upkeep and controlled additional AI usage. The user additionally
requires a configurable target count per group and creation of every missing
ancestor needed to reach the intended leaf, independently of that group size.
Required path ancestors do not consume the target allowance. Proposed field
names, version boundaries and calibration targets below are implementation decisions to
validate before shipping.

This extends the [automatic wiki plan](automatic-wiki-implementation-plan.md).
It does not reopen its completed milestones or assert that arbitrary hierarchy
creation is already available. Follow [RULES](../RULES.md), [STACK](../STACK.md)
and the [rule router](../rules/index.md). Normative contracts remain in
[second-brain](../rules/second-brain.md),
[automatic workflow](../rules/automatic-knowledge-workflow.md),
[AI and knowledge](../rules/ai-and-knowledge.md) and
[knowledge graph](../rules/knowledge-graph.md). Update the owning rules alongside
each implemented durable contract; this plan does not expand legacy authority.

## 1. Intended result

The harness should create and maintain useful paths such as
`Science → Biology → Genetics`, reuse those topics to organize reading TOCs, and
place canonical entity pages under useful collections. It should do this during
ordinary curation wherever possible, using the current model route, inference
FIFO, jobs, checkpoints, support assessment and budgets.

The same content may be reached from several indexes while retaining one
identity and one principal editorial parent. Navigation must work in the native
Wiki before Obsidian is configured. No additional graph extraction, embeddings,
atomic-note generation or external agent framework is a prerequisite.

Success means that users can browse a meaningful deeper tree, follow nested
reading indexes, find the same entity in different contexts, inspect proposed
reorganizations and preserve their own placements. It also means demonstrating
that unchanged maintenance performs no hierarchy-related inference and that
ordinary placement does not add a separate model request.

### Included

- New topics under existing or same-group proposed topics/collections.
- Nested collections and reading TOCs containing notes, sources, pages, entities
  and other TOCs through existing typed memberships.
- Creation/update of Wiki pages bound to existing canonical entities, and their
  placement under meaningful category collections.
- Explicit reviewed proposals to move existing pages and reorganize branches.
- Gradual organization of existing flat content under enabled scoped routines.
- A configurable maximum number of work targets per group, excluding required
  path ancestors, and creation of the complete path with no fixed product depth cap.
- Bounded discovery, protection, history, native navigation, portable links and
  measured AI overhead across the complete workflow.

### Outside this update

- New semantic entity extraction, canonical entity merging or automatic creation
  of graph relations from tree edges.
- A universal taxonomy, fixed mandatory depth, duplicate note trees or new
  identities for each appearance of an object.
- Automatic hard deletion, broad note rewriting, a new scheduler or a new
  inference queue. Existing note-evolution workflows retain their own authority.
- Automatic physical vault reorganization. Existing path migration and conflict
  workflows remain responsible for any requested filesystem movement.

## 2. Current foundations and actual gaps

The following observations refer to the local implementation inspected on the
date above. Recheck them before editing because other work may change these files.

| Area | Available foundation | Gap to address |
| --- | --- | --- |
| Domain | `automatic-wiki.ts` represents topic, entity, synthesis and collection targets, initial parents, proposed references and cycle checks. | Existing targets cannot use `initialParent` to move. New move semantics require a versioned contract. |
| Model transport | `CuratorDraftSchema` in `automatic-wiki-runtime.ts` exposes topics and indexes. | No general parent field and no entity-page draft variant. Topics require authored sections. |
| Target allowance | `CuratorLimitsSchema.targets` and `KnowledgeBudgetSettings` already expose a value restricted to 1–3. | Expand the range and distinguish counted work targets from required path ancestors throughout successor drafts, support, discovery and application. |
| Draft expansion | `expandCuratorDraft` in `wiki-curator.ts` creates topic targets and index targets. | Topic parents are null; a new topic index receives its owner as parent. Source/map indexes have no explicit parent. |
| Discovery | `wikiCuratorRepository.ts` ranks scoped candidates and loads selected pages and owner TOCs. | It does not supply a dedicated ancestry/placement inventory. Discovery currently excludes candidates without source dependencies, which matters for navigation-only containers. |
| Persistence | `wikiRepository.ts` stores page parents/revisions and checks cycles under the placement lock; collection memberships are canonical. | Audit whether every hierarchy-only operation preserves section revisions and whether existing entity-page bindings need stronger uniqueness. |
| Native tree | `tree()` and `WikiThemeTree` support parent/child navigation, paginated children and paths to selected pages. | Exercise deeper mixed page kinds, nested TOCs and efficient ancestor loading rather than assuming unlimited depth is already usable. |
| Upkeep | `automatic-maintenance.ts` and `wiki-collection.ts` resume coverage and process exact impacts before broad coverage. | Coverage of originals/notes is not proof of useful hierarchy. Settled flat pages need separately tracked, bounded structural inspection. |
| AI validation | Normal curator execution uses synthesis plus support review; repair can bring the sequence to four calls. | New placement/category assertions must be included in that support view without adding another classifier or reviewer. |

Important starting points:

- [Draft and runtime contracts](../packages/domain/src/automatic-wiki-runtime.ts)
- [Canonical change-set and policy contracts](../packages/domain/src/automatic-wiki.ts)
- [Curator expansion, prompting and validation](../apps/desktop/src/main/services/wiki-curator.ts)
- [Discovery and curator application](../packages/db/src/repositories/wikiCuratorRepository.ts)
- [Wiki persistence and tree reads](../packages/db/src/repositories/wikiRepository.ts)
- [Collection coordinator](../apps/desktop/src/main/services/wiki-collection.ts)
- [Automatic maintenance](../apps/desktop/src/main/services/automatic-maintenance.ts)

## 3. Information architecture

### Principal parent and additional navigation

Use `wiki_pages.parent_id` for the principal editorial parent of every Wiki page,
including topics, collections and entity pages. Keep source hierarchy separate.
Use typed memberships and links for additional reading paths. A note belongs to
indexes by reference; it does not become a Wiki page or acquire a new identity.

Distinguish a TOC's owner from its parent. Ownership identifies the canonical
reading index for a topic/source; parenting controls placement. Repositioning a
TOC must not create a second owner binding. Preserve the existing uniqueness of
source/topic TOCs.

Illustrative thematic navigation, created only when the material warrants it:

```text
Wiki
└── Science
    └── Biology
        ├── Genetics
        │   ├── Genetics reading index
        │   ├── Heredity
        │   │   └── Heredity reading index
        │   └── Gene expression
        │       └── Gene expression reading index
        └── Evolution
            └── Evolution reading index
```

The Genetics reading index can link to notes directly and to the Heredity and
Gene expression indexes. These are reading edges; they do not change those
indexes' principal parents. A note can also appear in the Evolution index with
the same canonical ID. The Atomic notes area can expose these reading paths
without persisting a separate taxonomy or duplicate TOCs.

Support explicit collection-under-collection parents when useful. Do not infer
parentage from every membership. Prevent cycles in designated hierarchical TOC
descent; ordinary related links may be cyclic and all readers must be cycle-safe.

### Content-driven depth

Create an ancestor when it provides a useful destination or grouping for actual
content. Do not pre-create an encyclopedia of empty categories. Reuse existing
parents where appropriate, and allow shallow trees when deeper nesting adds no
value. Do not force every branch to follow the same levels.

Once a useful destination path is chosen, create every missing ancestor needed
to reach its leaf, even if none of that hierarchy exists yet. For example,
`Science → Biology → Genetics → Molecular genetics → Gene regulation` must be
representable from an empty branch. Do not flatten the path, drop ancestors or
stop at three levels because a group has a limited number of targets.

There is no fixed product depth cap. Bound each query, model context and mutation
group, and use continuation for deeper paths. An ancestor that connects the
intended leaf is useful navigation even before other sibling branches exist; it
does not require independent source prose or a minimum number of children.

Navigation-only ancestors must be possible without fabricated synthesis. Start
with existing collection/map roles where they fit; explicitly decide in H0 how
to represent a topic that has navigation but no authored sections. Do not add
filler prose to satisfy the current draft's nonempty-section requirement.

Category headings and placement still imply meaning. A technical category must
fit the content assigned to it. Neutral containers do not bypass scope or support
checks, and age, isolation or branch size alone never justify removal.

### Entity pages

Example editorial navigation:

```text
Wiki
└── Entities
    └── Organizations
        └── Universities
            └── University of Coimbra
```

Here, Entities/Organizations/Universities can be collections; only the final
page must be bound to an existing canonical entity. This is an illustrative
branch under the current Wiki area, not a requirement for a new global area ID.
Collections may be created as needed, and entity pages can have further useful
children without imposing a fixed depth.

- Resolve entity-page references by admitted canonical entity IDs and current
  scoped mentions. A name alone must never identify an entity.
- Prefer one canonical Wiki representation of an entity, subject to existing
  scope/protection rules. Audit historical duplicates before adding constraints;
  conflicts require reconciliation, never automatic identity merging.
- A page may also participate in thematic TOCs, such as History of Portugal.
- Entity-related notes and subtopics can be linked through existing collections.
  Do not add an `entity_toc` role unless H0 demonstrates that existing page-owner
  and map roles cannot represent the requirement cleanly.
- No graph entity is created for a folder/category. An editorial parent does not
  create `part_of`, `works_at` or `is_a` relations in SQL or AGE.
- If entity extraction was not selected or no eligible entity exists, ordinary
  topic/TOC organization still works. Do not silently invoke extraction.

## 4. Execution with bounded AI overhead

### Reuse the existing curator sequence

Extend the compact draft with explicit initial placement and entity-page outputs.
The ordinary synthesis call proposes content, reading groups and placement
together. The existing support call checks authored content, category meaning and
membership/parent associations against the admitted originals. Keep the shared
repair allowance. Do not add one call per page, note, TOC, entity or ancestor.

Placement metadata cannot replace original evidence. Structural validation checks
IDs and cycles deterministically; semantic validation checks whether the proposed
organization faithfully describes its members. Human approval cannot override an
unsupported assertion. Deterministic repairs of already established navigation
need no inference, but a new semantic choice must not masquerade as such a repair.

### Select the relevant branch in the database

Build a dedicated compact placement inventory alongside current content inputs:

1. Retrieve scoped candidates by canonical bindings, title/alias, purpose and
   existing source/TOC connections; use current lexical facilities first.
2. Add relevant ancestors and a bounded set of nearby children/collections.
3. Send short handles, titles, kinds, parents, owner relationships and explicit
   destination/mutation capabilities. Keep revision IDs and hashes in snapshots.
4. Include full prose and originals only for the content actually being assessed.
5. Disclose candidate omissions and preserve unresolved placement rather than
   inventing a parent or creating a duplicate when discovery is ambiguous.

Existing ancestors may be considered without consuming the configured mutation
target allowance. Loading a parent as a destination must not grant permission to edit or
move it. A protected parent can receive an authorized child only under an explicit
destination capability; its prose and protected sibling order remain protected.

Do not expose out-of-scope ancestors through titles, descriptions or descendants
merely because a child is in scope. Reuse existing bounded conflict previews and
define any metadata-only destination capability explicitly in the owning rules.
Navigation-only containers need a scoped membership/owner lineage, not fabricated
source evidence or unrestricted discovery when their source-dependency set is empty.

Bound candidates, ancestor traversal, serialized bytes and output within the
effective model context. Prune optional destinations before complete originals;
never truncate an original passage. Select exact limits using the H6 fixtures.
Traversal limits must return continuation/omission state, never silently become
a maximum tree depth. Do not require new embedding inference for parent selection.

### Configure group size independently of path depth

Reuse the existing `limits.targets` policy setting and its Budget control. Expand
its supported range above three in the successor contracts; do not add a competing
setting. Keep three as a conservative initial default unless H6 supports a better
default, not as a hard ceiling. Show it as the maximum work targets per group,
with an explanation that required path ancestors and note references do not count
and that the setting does not limit hierarchy depth.

Define one backend-owned supported range and use it consistently in the UI,
draft transport, change-set validation, required-page snapshots, support verdicts,
discovery expansion, sample builders and apply guards. Count work targets
separately from structural ancestor creation. Enforce the effective policy value
as well as structural envelope bounds. A maximum of six targets
must actually admit six eligible targets, not encounter a leftover `.max(3)`.
Pin the configured limit at admission; use the existing policy revision workflow
for settings edits, preserving admitted-run compatibility and paused state.

The setting limits work targets, not all physical writes or provider capacity. Existing model context,
complete-original, time, call and token limits still apply and can require smaller
groups. Validate supported values before saving; disclose partial work rather
than silently increasing budgets or truncating a proposal. Calibrate the supported
range in H0/H6 while keeping total hierarchy depth independent of that range.

Use the following counting semantics:

- A leaf/topic/entity page being authored, a reading TOC being populated, an
  existing page being moved, or an existing parent index being patched is a work
  target and counts once, even if several operations affect it.
- A new ancestor created only to connect those targets to their required path
  does not count. This can be a navigation-only topic or collection with its
  necessary child links. The exemption applies equally to thematic, TOC and
  entity-category paths. Existing read-only destinations also do not count.
- Backend validation, not a model-supplied flag, classifies an ancestor from its
  minimal structural fields and its reachability to an admitted work target.
  Unrelated pages, substantive ancestor synthesis, populated independent reading
  groups and existing-page rewrites cannot be hidden inside path creation; they
  remain work targets. Shared ancestors are resolved and created once.

Represent the compact path separately from content targets in the successor
proposal. Structural ancestors still have canonical IDs, revisions, support
coverage and receipt entries. Do not funnel them through the old target-array
length check or skip their validation to exempt them from counting.

When the work targets fit the configured limit and the full path fits model and
execution capacity, create targets and missing ancestors in one coherent group,
even when the number of new pages exceeds `limits.targets`. A long path alone
must not split a group because of the target-count setting.

If context, output, execution time or other actual resource bounds require
continuation, persist the intended destination, missing path segments and progress
in the existing coordinator checkpoint. This is bounded, versioned planning data,
not live page references or a new workflow authority. Any per-step structural
envelope bound must be explicit and resumable, never a disguised target/depth cap.

Create ancestors before dependent children in coherent groups, persisting resolved
canonical IDs between groups, until the leaf and its required TOCs are reached.
Proposed handles remain local to one group; never commit dangling parent or
membership references. Resume the recorded route instead of rediscovering it on
every step. Re-read revisions and scope before continuing, reuse supported saved
proposals/receipts when still valid, and reassess only changed or newly authored
content. Include all authored path labels/associations in the support gate; saved
planning data alone does not certify semantics. A path larger than one context
needs explicit continuation rather than unbounded output or a depth cutoff.

Example: create `Science → Biology → Genetics → Molecular genetics → Gene
regulation` plus a reading TOC under Gene regulation. If the first four pages
exist only to establish the path, this is **two work targets** (Gene regulation
and its TOC) plus **four uncounted structural ancestors**, although six pages are
created. With a target limit of three, the entire operation can use one normal
synthesis/support pair when context and execution capacity allow. A third
independent work target still fits; a fourth requires another group. Report any
resource-driven continuation cost honestly, without requiring a call per ancestor.

Keep the overall hierarchy task incomplete until the intended leaf and required
navigation exist. Occurrence budgets may defer later groups but must not discard
the remaining path. Expose temporary ancestor-only progress as partial and resume
under the next valid authority. Cancellation preserves applied history and does
not automatically restart or delete created ancestors.

No partially valid subset of a group may apply. If a structural reorganization
cannot be decomposed without violating protections or leaving inconsistent
navigation, retain it as an explicit bounded limitation rather than silently
increasing the user's configured group size. A new unprotected path must support
ancestor-first decomposition and cannot be rejected merely for being deeper than
one group. Protected existing-branch rewrites retain their separate review rules.

### Maintain structure selectively

- Incremental: place new pages/notes during their existing curation; inspect only
  affected structural destinations and memberships.
- Daily: resume pending hierarchy work, repair deterministic navigation and
  inspect new/unplaced or changed branches alongside existing coverage.
- Weekly/monthly: inspect wider branch metadata in bounded pages and propose
  useful consolidations of navigation where warranted; no mandatory full-tree
  model pass or mandatory hierarchy call on each occurrence.

Extend the current checkpoint/receipt owners with structural progress when needed.
Do not mark source content stale just to force hierarchy work: currently integrated
content may need placement inspection without prose regeneration. Record structural
inspection/completion separately from original coverage and note placement.

Fingerprint the relevant branch state, policy, effective prompt and model. A
change in an unrelated branch must not invalidate every decision. Retain no-change,
rejected and reviewed outcomes and existing cooldown behavior. Do not generate
self-triggered reorganization loops or repeat canceled/uncertain provider calls.

Use the existing occurrence and shared UTC-month consumption gates. Pausing,
deadline exhaustion and restart preserve cursors, reservations, recorded usage and
decisions. Later authorized work may continue unfinished groups without refunding
earlier consumption. Estimates remain context-planning inputs, not actual tokens.

## 5. Authority, application and compatibility

- New initial placements can apply under the enabled scoped policy after the
  ordinary support and protection checks.
- Moves of existing pages are explicit reviewed proposals by default, including
  the complete before/after paths and affected reading memberships. Large branch
  moves must disclose their descendant impact even when only one parent edge changes.
- Never repurpose `initialParent` on an existing v1 target. Introduce versioned
  structural operations and an explicitly disclosed policy capability, preserving
  legacy readers, admitted snapshots and historical reviews. A prompt edit cannot
  grant move authority. An upgrade cannot activate a paused policy.
- Apply under the existing placement lock and canonical transaction. Recheck page
  and destination revisions, current ancestry, scope, owner uniqueness, canonical
  entity bindings and protections across the complete composed result.
- Prevent cycles involving existing and same-group pages, self-parenting, missing
  or archived destinations, incompatible ownership and duplicate canonical bindings.
  Serialize competing creations or moves; stale proposals fail without partial apply.
- Parenting alone must preserve section revision IDs, provenance, support
  assessments and original dependencies. It must not simulate a human prose edit.
- Preserve typed membership IDs, protected placements, reading order and omitted
  memberships. A model omission cannot silently remove an existing link.
- Persist before/after placement and one idempotent group receipt. Restore an
  earlier organization through a new guarded revision, never by erasing history.
- Migrate only what is necessary. Preserve existing paths, IDs, TOC owners and
  human edits; detect legacy corrupt ancestry/duplicate bindings before adding
  constraints. No automatic semantic merge or wholesale reclassification on upgrade.

## 6. Implementation milestones

Execute milestones in order. Each is unfinished until its exit checks pass. Read
the routed rules for the boundaries being changed; in particular database, jobs,
frontend, integrations and runtime rules before implementing their portions.

### H0 — Freeze contracts and comparison fixtures

- [ ] Capture the current two-call successful curator path and its repair path
  using deterministic fixtures and canonical usage links.
- [ ] Specify the successor draft/run/change-set versions, initial-parent fields,
  reviewed move operation and explicit authority/destination capabilities.
- [ ] Define the expanded `limits.targets` range, compatibility/default behavior
  and route-continuation contract. Separate counted work targets, exempt required
  ancestors, physical mutation count and per-step context bounds. No fixed product
  depth cap is permitted, and ancestor creation must not consume target slots.
- [ ] Resolve navigation-only topics, collection ownership versus parentage,
  entity-page binding uniqueness and hierarchical TOC edges without inventing a
  second node store. Record minimal schema/index needs.
- [ ] Define fixtures for deep topics, nested note TOCs, entity categories,
  homonyms, scope exclusions, protected placements and an already settled tree.
  Include fully missing paths deeper than the configured group size, shared path
  ancestors and runs with target allowances both below and above three.
- [ ] Update the owning normative rules for the successor contracts while
  retaining legacy semantics. List every new numerical limit as a calibrated
  implementation limit, not a model capability or cost guarantee.

Exit: explicit contracts, migration decisions and executable acceptance fixtures;
no schema or prompt change can silently expand old authority.

### H1 — Canonical structure and guarded persistence

- [ ] Implement successor schemas, parent/membership checks, optional required
  indexes and compatible readers in domain and database owners.
- [ ] Replace successor three-target ceilings with the shared supported range
  and enforce each admitted policy's effective target count at validation/apply.
- [ ] Persist exempt structural ancestors in the same coherent transaction and
  receipt as their targets. Validate their canonical identity, required-path role,
  scope and cycles without counting them as content targets or permitting hidden
  existing-page/content edits through the structural shape.
- [ ] Add transactional initial placement and reviewed reparenting, receipt
  replay, expected destination revisions and protection checks.
- [ ] Enforce safe entity-page reuse and TOC ownership under concurrent creation.
- [ ] Prove placement-only revisions preserve prose identity/support and that
  interrupted acknowledgments reuse the committed receipt.
- [ ] If migrations are needed, generate them with the repository mechanism,
  synchronize the baseline and verify both populated upgrades and empty databases.

Exit: deterministic database acceptance for valid trees, concurrency, cycles,
review and preservation; no model execution is needed to verify these invariants.

### H2 — Bounded discovery and compact model transport

- [ ] Add the scoped placement inventory to `wikiCuratorRepository.ts` and the
  immutable curator snapshot; include bounded ancestry and navigation containers.
- [ ] Extend draft expansion for topic/collection parents and canonical entity
  pages, including same-group parents and destination-only existing references.
- [ ] Make the entire supported target range work through synthesis, support,
  repair and context planning. Include every structural ancestor in support
  coverage without counting it as a work target. Continue paths only when actual
  resource bounds require it, not when ancestor count exceeds target allowance.
- [ ] Extend synthesis, support, repair and sample serializers in the existing
  prompt catalog. Preserve custom prompt revisions and validate changed contracts.
- [ ] Include placement/category meaning in complete support coverage, with clear
  separation of authored assertions and read-only reference metadata.
- [ ] Test temporal/procedure/consolidation callers of shared draft contracts so
  the hierarchy update does not break existing intent-specific workflows.

Exit: one normal synthesis/support pair can create a useful multi-level group,
link existing notes and position an existing canonical entity page; invalid
structure fails deterministically and unsupported categorization cannot apply.

### H3 — Existing collection and maintenance orchestration

- [ ] Extend `wiki-collection.ts`, `automatic-maintenance.ts` and their current
  repositories with resumable structural inspection and remaining-work receipts.
- [ ] Preserve full original/eligible-note coverage while splitting hierarchy
  work into coherent groups under the same occurrence and monthly budgets.
- [ ] Persist and resume missing ancestors through to the intended leaf and TOCs;
  do not flatten a chosen path, stop at the first group, or repeatedly plan it.
  Verify a restart and an occurrence-budget interruption between ancestor groups.
- [ ] Add deterministic branch diagnostics and bounded candidates for existing
  flat libraries, without forcing regeneration of integrated sources.
- [ ] Route existing-page moves to the current review surface through the new
  versioned operation; do not revive legacy routine creation.
- [ ] Retain exact changed-input, no-change and rejection identities; verify
  idleness, pause/cancel, restart, deadline and budget behavior.

Exit: initial integration, later imports and due maintenance all advance useful
hierarchy work; repeated unchanged occurrences use zero hierarchy model calls.

### H4 — Native browsing and structural review

- [ ] Extend `WikiThemeTree`, `WikiNavigationPane`, `WikiWorkspace` and context
  reads only where necessary; reuse paginated children, path reveal and typed links.
- [ ] Make mixed-depth topics, collections and entity pages navigable with
  breadcrumbs, keyboard controls and stable selection/expansion after updates.
- [ ] Show nested note TOCs as reading paths with shared IDs; distinguish a
  principal child from an additional related/reading link.
- [ ] Add before/after move previews, affected descendant/member counts,
  protection indicators, reason and accept/reject actions to existing decisions.
- [ ] Show structural progress independently from source integration and sync,
  including loading, empty, deferred, partial, error and successful states.
- [ ] Extend the existing Budget target-count control beyond three with validated
  save, effective/default value and localized explanation. Show counted targets
  separately from structural ancestors and total changed pages; distinguish the
  limit from depth, references and remaining ancestor/leaf work.
- [ ] Translate new product messages in every supported locale and keep generated
  content language independent of UI language.

Exit: normal-size native desktop walkthrough covers both examples, a shared note,
an entity homonym, a reviewed move and a pending limited-budget branch.

### H5 — Retrieval and Obsidian preservation

- [ ] Verify `wikiContextRepository.ts` and consultation scope expansion across
  nested TOCs: deduplicate originals, bound traversal and preserve exclusions and
  complete lineage. Do not make tree ancestors synthetic supporting evidence.
- [ ] Verify `obsidianWikiRepository.ts` and existing editorial/layout services
  export deeper parents, nested reading links and entity-page references using
  registered canonical identities.
- [ ] Preserve existing registered physical paths. Reflect deeper hierarchy in
  portable navigation without forcing one directory per ancestor.
- [ ] Exercise divergent local edits, deep paths, page rename/reparent, historical
  links and disabled sync. Any required physical relocation must use the existing
  explicit recoverable layout migration, with its own verification.

Exit: native and portable navigation reach the same objects; retrieval respects
scope and local editor changes remain recoverable.

### H6 — Cost, quality and complete-journey acceptance

- [ ] Run the comparison matrix below on fixed synthetic corpora and the same
  selected model/profile, prompts and budgets. Keep deterministic and real-model
  results separate; never treat mock tokens as measured provider usage.
- [ ] Inspect actual category usefulness, excessive depth, reuse of ancestors,
  note attribution, homonyms and unsupported implied entity relationships.
- [ ] Measure database discovery as well as model calls, input/output tokens,
  latency, repairs and known cost from canonical audit records.
- [ ] Complete relevant automated, real PostgreSQL and normal-size native gates;
  verify Obsidian behavior for the same canonical fixture identities.
- [ ] Record residual limitations and final calibrated context bounds. Do not
  declare the feature complete with a missing required quality or preservation gate.

Exit: an evidence-backed report demonstrates useful hierarchy and bounded overhead
without claiming that all providers or all library sizes have identical cost.

## 7. Acceptance and cost matrix

The numerical token target below is a proposed calibration gate, not a promise.
Freeze the corpus and baseline before tuning and keep failed trials in the report.

| Scenario | Functional acceptance | AI acceptance |
| --- | --- | --- |
| New topic with an existing parent | Correct parent; old branch/prose unchanged. | No dedicated placement call; normal successful path remains two calls. |
| Fully missing deep path | Every required ancestor and the intended leaf/TOCs are created; ancestors consume no target slots and impose no depth cutoff. | One group when actual resources allow; otherwise count all resumed groups without per-ancestor calls. |
| Configurable target count | Values below and above three reach drafts, support, apply and UI consistently; configured excess fails and old snapshots retain their contracts. | Raising the count adds no mandatory call; context/usage limits remain authoritative. |
| Deep path with a target limit of three | Five topic levels plus a TOC count as two work targets and four structural ancestors; all six pages may commit in one group. | Normal two-call path when context/evidence allow; no split caused by ancestor count. |
| Shared ancestors and counting guards | Several targets reuse one path; independent synthesis or existing-page rewrites cannot be misclassified as exempt ancestors. | Reuse the same compact path context; no repeated ancestor planning or support call per node. |
| Nested atomic-note TOCs | Direct notes and child indexes work; one note appears in multiple contexts with one ID. | No call per note/ancestor; selected notes remain in ordinary group processing. |
| Entity category hierarchy | Existing entity ID reused; categories are collections; homonyms stay distinct. | No hierarchy-triggered graph extraction or identity-confirmation pass. |
| Integrated flat library | Useful structural work progresses without marking prose stale. | Bounded branch work within routine/month limits; separate initial cost report. |
| Existing protected branch move | Exact before/after proposal and human decision; no silent move. | Saved proposal approval/rejection requires no new inference. |
| Unchanged rerun/daily occurrence | No duplicate pages, TOCs, moves or pending wrappers. | Zero hierarchy inference, including for retained unchanged decisions. |
| Change in one branch | Only its relevant hierarchy/dependents are reconsidered. | No full-tree prompt or unrelated-branch reanalysis. |
| Pause/restart/budget exhaustion | Cursor and committed groups survive; incomplete work stays visible. | No replay of completed/uncertain calls; no allowance reset. |
| Narrow scope or missing evidence | No excluded ancestry/prose leakage or fabricated categorization. | No automatic scope expansion or derivative generation to fill the gap. |

For ordinary cases with reusable ancestors, target median total input-plus-output
token overhead of at most 20% against the baseline on the frozen comparable corpus.
Report median and high-percentile overhead, per-case call counts, output size and
repair rate. Extra grouping work and previously unsupported entity-page generation
must be reported separately, not presented as equivalent baseline operations.

If the target fails, first reduce repeated context, candidate breadth and verbose
output; inspect whether repairs indicate a confusing contract. Do not remove the
support gate, truncate originals or quietly increase budgets to meet the target.
Document any revised target before claiming acceptance. Unknown tokens/pricing
remain unknown. Also measure discovery latency with broad and deep synthetic trees
to ensure lower model cost is not purchased with unbounded database work.

## 8. Verification and completion record

Extend existing domain, curator, prompt and navigation tests for the changed
contracts. Add an isolated real-PostgreSQL hierarchy verifier if existing scripts
cannot express the full transaction/restart matrix; avoid duplicating their setup.

Relevant existing verification entry points include:

- `scripts/verify-wiki.ts` and `scripts/verify-automatic-wiki.ts`.
- `scripts/verify-automatic-wiki-a3.ts` and `scripts/verify-automatic-wiki-a4.ts`.
- `scripts/verify-automatic-wiki-a5.ts` for compiled consultation and scope.
- `scripts/verify-knowledge-automation.ts` for the automatic workflow.
- `scripts/verify-prompts.ts`, `scripts/verify-obsidian-wiki.ts`,
  `scripts/verify-obsidian-editing.ts` and `scripts/verify-obsidian-layout.ts`
  for their affected boundaries.

Use `npm run typecheck`, relevant Vitest suites, `npm run format:check` and the
build/runtime checks required by the actual changed areas. For database changes,
run the routed migration/baseline checks on isolated populated and empty databases.
Start native DEV only from the repository root with `npm run dev -w @app/desktop`.
Real-model trials use the configured route and canonical audits with the existing
single-inference resource contract. A test run must never reset the user's library.

The final implementation report must list completed H0–H6 items, changed rules,
schema/migration results, checks actually executed, before/after navigation
examples, measured ordinary versus initial-organization cost, preserved identities
and paths, and any unresolved gate. Writing this plan marks none of those checks
as executed and changes no runtime behavior or normative specification.
