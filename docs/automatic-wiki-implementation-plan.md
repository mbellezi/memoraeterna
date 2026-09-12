# Automatic knowledge wiki: implementation plan

Date: 2026-09-12.

Status: A0 contract/fixture work and A1 runtime catalog/editor are independently
verified and accepted (see [A1 report](automatic-wiki-a1-report.md)). A2 is independently
verified and accepted through its database, selected-model and native window gates,
including the collapsible menu and resizable tree (see [A2 report](automatic-wiki-a2-report.md)). A3 is independently verified and accepted through PostgreSQL,
selected-Luna, native and DEV preservation gates (see [A3 report](automatic-wiki-a3-report.md));
A4 is independently accepted through real PostgreSQL, selected-Luna upkeep, native context/settings and DEV preservation gates (see [A4 report](automatic-wiki-a4-report.md)); A5–A8 remain planned. See the
[A0 contract report](automatic-wiki-a0-contracts.md) and
[acceptance ownership matrix](automatic-wiki-a0-acceptance.md).
The product direction and initial information architecture were agreed in the
design discussion. New schema names, tools and numerical limits below are
implementation proposals to validate at their stated gates, not shipped APIs.
This document does not authorize processing the user's library, moving vault
files, activating policies, starting paid trials, or implementing the milestones.

This is the forward plan for second-brain development. The
[previous plan](second-brain-implementation-plan.md) and M2–M5 reports remain
historical implementation and acceptance evidence. Their completion does not
establish completion of this automatic knowledge workflow; the old M6 remains
deferred. Use A0–A8 below for the new work.

Normative constraints live in [second-brain rules](../rules/second-brain.md),
[source ingestion](../rules/source-ingestion.md),
[AI and knowledge](../rules/ai-and-knowledge.md),
[integrations](../rules/integrations.md), [database](../rules/database.md),
[jobs](../rules/jobs-and-processing.md),
[frontend](../rules/frontend-and-i18n.md), and [STACK](../STACK.md).
Update the owning rules with each implemented contract; do not silently expand
legacy executor or plugin capabilities through a prompt change.

## Contents

- [1. Outcome and scope](#1-outcome-and-scope)
- [2. Existing foundations and gaps](#2-existing-foundations-and-gaps)
- [3. Information architecture](#3-information-architecture)
- [4. Sources and attachments](#4-sources-and-attachments)
- [5. Automatic TOCs](#5-automatic-tocs)
- [6. Canonical model and evidence](#6-canonical-model-and-evidence)
- [7. Authority and configuration](#7-authority-and-configuration)
- [8. Curator execution](#8-curator-execution)
- [9. Initial organization and incremental updates](#9-initial-organization-and-incremental-updates)
- [10. Desktop experience](#10-desktop-experience)
- [11. Consultation and investigations](#11-consultation-and-investigations)
- [12. Maintenance and long-term memory](#12-maintenance-and-long-term-memory)
- [13. Obsidian projection and migration](#13-obsidian-projection-and-migration)
- [14. Implementation milestones](#14-implementation-milestones)
- [15. Verification and release gates](#15-verification-and-release-gates)
- [16. Risks and bounded decisions](#16-risks-and-bounded-decisions)
- [17. Research references](#17-research-references)

Companion design: [application-wide Prompts settings](ai-prompt-catalog-plan.md)
contains the full prompt hierarchy, current caller inventory, `%variable_name%`
contract, per-field variable documentation and migration/acceptance details.

## 1. Outcome and scope

The user supplies material, chooses interests and corrects interpretations. The
application maintains an inspectable, interconnected body of knowledge: topic
pages, atomic notes, tables/maps of contents, entities, syntheses and ongoing
investigations. Native browsing is useful before Obsidian is configured.

The defining journey is:

1. Enable an automatic organization policy for a clearly described scope.
2. Add material through the existing intake and processing flow.
3. The curator identifies relevant existing knowledge and useful new topics.
4. It creates or updates a coherent group of pages and TOCs with original evidence.
5. The user opens the knowledge tree and reads what changed, follows ideas,
   inspects evidence, asks questions and makes corrections.
6. Later material revises affected understanding; stable content stays stable.
7. The configured Obsidian mirror receives the same knowledge and navigation.

The main success criterion is this complete journey, not the presence of a
page editor, an AI dialog, or a successful export in isolation.

### Included

- Reuse of the existing ingestion, summaries, embeddings, graph, note matching,
  conceptual source relationships, revisions, jobs, AI adapters and sync.
- Automatic topic discovery, multi-page synthesis and initial placement.
- Source TOCs, topic TOCs, global indexes and cross-topic reading maps.
- Initial organization of an existing library, followed by incremental updates.
- Native hierarchical navigation, typed internal links, backlinks and evidence.
- Review by exception, with independent human protection and evidence freshness.
- Knowledge-first consultation and explicitly followed, persistent questions.
- Periodic editorial maintenance, temporal interpretation and reusable lessons.
- Automatic setup of maintenance routines with explicit cadence, due windows,
  execution limits and restart/catch-up behavior.
- One hierarchical settings catalog for all application-owned AI prompts,
  editable templates and documented `%variable_name%` inputs.
- The agreed Portuguese example layout, localized presentation and safe migration
  of registered Obsidian paths.

### Boundaries

- Atomic notes, embeddings, summaries, graph extraction and matching remain
  optional; missing derivatives do not exclude a source from the catalog.
- Import-only performs no AI work. Automatic organization is an explicit enabled
  policy/processing choice, visible in the effective plan.
- PostgreSQL remains canonical. Files, directory paths, search and AGE are
  projections; a note appearing in two TOCs keeps one identity.
- No new agent framework, database, provider SDK, web application or daemon is
  selected. Retain the Electron/TypeScript architecture and shared inference FIFO.
- Existing model routing applies: generative harness functions use
  `structured-output`, query vectors use `embedding`, an explicit override wins,
  and an absent route may use the global default. Pin admitted model identity and
  parameters. Do not restore the removed local/remote permission selector.
- Conversation/email/account capture, autonomous web research and a full personal
  task manager are not implicit extensions of this plan. Personal and daily notes
  already deliberately supplied to the application can participate.

## 2. Existing foundations and gaps

Baseline: the local working tree inspected on 2026-09-12, including ongoing
model-routing and intake/theme changes. Preserve those unrelated edits. Recheck
the owning files at the start of each milestone; this is not a frozen checkout.

| Area | Existing implementation to reuse | Work required |
| --- | --- | --- |
| Ingestion | [IngestionService](../apps/desktop/src/main/services/ingestion-service.ts), [hierarchical processing](../apps/desktop/src/main/services/hierarchical-ingestion-service.ts), [DAG](../packages/domain/src/hierarchical-ingestion.ts) | Enroll authorized changes in an automatic curation workflow without requiring a user-supplied topic title. |
| Derived knowledge | [KnowledgeService](../apps/desktop/src/main/services/knowledge-service.ts), [knowledge processing](../apps/desktop/src/main/services/knowledge-processing.ts) | Reuse valid artifacts as discovery/context; add note TOCs and avoid duplicate generation. |
| Source connections | [Source relation processing](../apps/desktop/src/main/services/source-relation-processing.ts), [repository](../packages/db/src/repositories/sourceRelationRepository.ts) | Consume qualified original evidence and preserve independent relation review; never invoke matching implicitly. |
| Editorial storage | [Wiki domain](../packages/domain/src/wiki.ts), [WikiService](../apps/desktop/src/main/services/wiki-service.ts), [wiki repository](../packages/db/src/repositories/wikiRepository.ts) | Typed navigation to notes/sources, management state, revisioned multi-page changes and scalable navigation reads. |
| Synthesis | [OrganizationService](../apps/desktop/src/main/services/organization-service.ts), [participation](../apps/desktop/src/main/services/organization-participation.ts) | Replace the one-preselected-page product workflow with a versioned curator that discovers and updates several targets. Keep legacy runs resumable. |
| Dependencies | [Wiki context](../packages/db/src/repositories/wikiContextRepository.ts), `wiki_dependencies`, `knowledge_impact_events` | Consume events into bounded editorial work; current invalidation alone does not refresh prose. |
| Maintenance | [MaintenanceService](../apps/desktop/src/main/services/maintenance-service.ts), [repository](../packages/db/src/repositories/maintenanceRepository.ts) | Add resynthesis and TOC upkeep beyond existing reparent/link/empty-draft proposals. |
| Consultation | [ConsultationService](../apps/desktop/src/main/services/consultation-service.ts), [retrieval](../packages/db/src/repositories/consultationRepository.ts) | Start from useful compiled knowledge, verify dependencies and deepen into originals; persist followed questions. |
| Native UX | [WikiWorkspace](../apps/desktop/src/renderer/components/WikiWorkspace.tsx), [navigation](../apps/desktop/src/renderer/components/wiki-navigation.ts), [Markdown](../apps/desktop/src/renderer/components/MarkdownEditor.tsx) | Expandable tree, page links/backlinks, TOCs, contextual views, useful home and explicit automatic-work state. |
| Obsidian | [Wiki projection](../apps/desktop/src/main/services/obsidian-wiki-projection.ts), [editorial service](../apps/desktop/src/main/services/obsidian-editorial-service.ts), [plugin](../apps/obsidian-plugin/src/main.ts) | New layout, typed TOCs/internal links and resumable path migration while preserving M4/M5 delivery guarantees. |

The current `full_knowledge` preset does not include `organizeKnowledge`.
The existing organization stage produces one topic per batch, finds a target by
exact title/alias and rejects an existing page whose sources exceed its selected
scope. New material therefore cannot automatically enrich arbitrary existing
topics. This is an orchestration gap, not evidence that ingestion must be rebuilt.

Current wiki navigation is an indented list with no branch expansion; hierarchy
already exists in SQL. Current consultation ranks original chunks with wiki as an
additional signal. Current maintenance does not rewrite prose. Those are explicit
baseline limitations that the milestones below must resolve.

## 3. Information architecture

### 3.1 Stable areas and emerging topics

Use four stable areas: Wiki, Atomic notes, Sources and Attachments. The root is
the configured managed root inside an existing vault, not the vault itself.
The Portuguese layout below records the agreed initial presentation. Examples
under Themes are illustrative, not a taxonomy to create in every library.

```text
Memora Eterna/
├── Início.md
├── Wiki/
│   ├── Índice.md
│   ├── Temas/
│   │   ├── Aprendizagem/
│   │   │   ├── Índice.md
│   │   │   ├── Memória/
│   │   │   │   ├── Índice.md
│   │   │   │   ├── Recuperação ativa.md
│   │   │   │   └── Espaçamento.md
│   │   │   └── Métodos de estudo.md
│   │   └── Other topics as they emerge
│   ├── Entidades/
│   │   ├── Pessoas/
│   │   ├── Organizações/
│   │   ├── Lugares/
│   │   └── Obras/
│   ├── Sínteses/
│   ├── Investigações/
│   └── Mapas/
├── Notas atômicas/
│   ├── Índice.md
│   └── Recuperar antes de consultar favorece a retenção.md
├── Fontes/
│   ├── Índice.md
│   ├── Livros/
│   ├── Artigos/
│   │   ├── Acadêmicos/
│   │   ├── Web/
│   │   └── Avulsos/
│   ├── Periódicos/
│   ├── Vídeos/
│   ├── Documentos/
│   ├── Notas pessoais/
│   └── Diário/
└── Anexos/
```

Stable internal category keys are language-independent. Resolve display/path
labels from an explicit projection language, initially the content language.
Changing the interface language must not move files. Changing an established
projection language uses the reviewed path migration procedure in section 13.

Do not manufacture empty subject hierarchies. Show stable areas in native
navigation even when empty; materialize their folder/index projections as needed.
Create deeper theme folders only when they improve comprehension. A modest
initial theme depth is a heuristic, not an identity rule or forced balancing target.

### 3.2 Page roles

| Area | Contents | Initial domain mapping |
| --- | --- | --- |
| Home | Theme entry points, continue reading, meaningful changes and concise attention state | Deterministic view with a portable index projection. |
| Themes | Evolving explanations across sources, with local reading/navigation indexes | Existing `topic`; a topic can carry prose plus a TOC. |
| Entities | Useful editorial explanations of people, organizations, places, works and other supported entity kinds | Existing `entity` linked to the canonical entity ID. Create on usefulness, not for every extracted name. |
| Syntheses | Comparisons, arguments and answers spanning themes | Existing `synthesis`. |
| Investigations | A followed question, current answer, competing interpretations, evidence gaps and next review | Extend synthesis with an explicit investigation role and persistent follow-up state. |
| Maps | Cross-topic paths such as “How to learn better” | Existing `collection`, with a map role and typed membership. |
| Atomic notes | One reusable idea per note; links into many topics and maps | Existing note identities and revision history. |
| Sources | Bibliographic references and source content in its original hierarchy | Existing `SourceItem`; a source wrapper is not another knowledge page or source copy. |

A book's bibliographic/source record lives in Sources. An editorial page about
the book's influence may live in Entities/Works and links to that record. They
have different roles and IDs, not duplicated authoritative source text.

### 3.3 Placement and navigation

- One primary editorial parent determines breadcrumbs and initial page placement.
  Secondary memberships and semantic links can cross the entire authorized wiki.
- Source parentage is independent. A chapter stays with its book even when cited
  under several themes. A wiki move cannot rematerialize source divisions.
- Keep atomic-note files shallow and stable initially. Topic organization lives
  in TOCs and typed memberships; do not copy or move a note for every new theme.
- Folder paths are presentation. Generate path-qualified wikilinks with readable
  aliases; ambiguous same-title pages never resolve by title alone.
- Preserve Unicode titles, normalize safely for portable filenames, and handle
  case/normalization collisions, reserved names and path length explicitly.
  Disambiguate with existing bibliography context, then a short ID when needed.
- Keep meaningful physical paths stable after registration. Large directory
  changes are explicit migrations; ordinary TOC updates should not churn paths.

## 4. Sources and attachments

### 4.1 Source taxonomy mapping

Classify by the existing source type, not file extension. A PDF can be a book,
paper or generic document. A URL does not necessarily make a source a web article.

| Canonical source type | Initial Portuguese path | Hierarchy behavior |
| --- | --- | --- |
| `Book` | `Fontes/Livros/<author — title>/` | Source page plus materialized chapters when present. |
| `BookChapter` | Its book's `Capítulos/` | Use canonical sibling order; preserve the parent reference. |
| `AcademicPaper` | `Fontes/Artigos/Acadêmicos/<title>/` | Source page and optional `Seções/`. |
| `DocumentSection` | Its academic paper's `Seções/` | Preserve actual parent and selector; do not place as an unrelated article. |
| `PeriodicalIssue` | `Fontes/Periódicos/<publication — issue>/` | Source page and `Artigos/` for its children. |
| `StandaloneArticle` | `Fontes/Artigos/Avulsos/` when standalone | A child of a periodical remains inside that issue. |
| `WebArticle` | `Fontes/Artigos/Web/` | Keep URL, author and capture/publication metadata when known. |
| `Video` | `Fontes/Vídeos/` | Preserve channel, original URL and transcript locators when available. |
| `GenericDocument` | `Fontes/Documentos/` | Keep supported original metadata and structure. |
| `PersonalNote` | `Fontes/Notas pessoais/` | Human source text, distinct from generated atomic notes. |
| `DailyNote` | `Fontes/Diário/` | Optional year/month subdivision from an actual recorded date; never invent a date. |

Example:

```text
Fontes/Livros/Autor — Título do livro/
├── Título do livro.md
├── Capítulos/
│   ├── 01 — Introdução.md
│   └── 02 — Formação de memórias.md
└── Notas deste livro.md
```

The book page contains bibliography, available overview and links to chapters,
the original asset and derived knowledge. The note TOC points to existing atomic
note files. For materialized hierarchies, avoid projecting an additional complete
copy of child content inside the parent solely for navigation.

### 4.2 Source page and attachment contract

1. Every in-scope source has one registered reference/content identity, including
   catalog-only containers. A missing document never leads to invented excerpts.
2. Separate original/converted text, human interpretation, generated summaries
   and generated navigation in the data and projected format. A generated summary
   must never round-trip as a human edit to the original document body.
3. Source pages expose bibliography, available content, revision-aware references,
   generated summary when available, note TOC and wiki pages using the source.
4. Cite exact source/document/chunk/span and historical excerpt, not just the
   source's current filename. A bibliography-only reference is not substantive
   evidence for a generated claim.
5. Project configured original files and images into managed Attachments storage
   once per asset identity. Reuse valid existing assets; do not redownload or
   duplicate the original for each chapter or citing page. Large binary export
   remains an explicit storage option with visible coverage.
6. Attachment links must work after export within the portable managed tree.
   Preserve registered ownership and handle omitted assets explicitly.

## 5. Automatic TOCs

TOC means a navigable table/map of contents over knowledge objects. An original
document's extracted TOC remains source structure, not evidence for new ideas.

| TOC | Trigger | Contents and placement |
| --- | --- | --- |
| Source note TOC | Successful selected note generation, note revision/review or explicit rebuild | Notes grouped into useful sections; original source order when helpful. A revisioned collection bound to the source, projected beside it. |
| Topic TOC | Topic discovery, changed memberships or meaningful knowledge updates | Subtopics, notes, sources, syntheses and open questions. Lives with the topic's `Índice.md`. |
| Global index | Committed navigation changes | Main theme/area entry points and category indexes; deterministic from canonical placement. |
| Cross-topic map | Useful recurring question or explicitly chosen reading path | Ordered groups spanning themes, under `Wiki/Mapas`. |

Separate deterministic link maintenance from semantic authorship. The backend
resolves IDs, ordering, counts, paths and backlinks. The model proposes useful
groups, labels, descriptions and reading order when analysis is authorized.
Deterministic TOCs remain possible without another model call.

TOC generation must:

- Reuse notes and sources; membership does not duplicate content or create a
  semantic relation such as “supports” without the relation workflow's evidence.
- Give groups stable IDs and preserve human-pinned membership/order independently
  from prose protection. Change only affected groups.
- Explain inclusion/order briefly where useful. A substantive factual description
  needs original evidence; a plain navigation label needs a valid target.
- Include pending generated material in exploratory navigation with its state;
  exclude rejected/archived notes from active maps and preserve historical links.
- Preserve useful outliers. Insufficient material can yield one simple index,
  an explicit unorganized state, or no semantic regrouping.
- Update reverse links and source/notes indexes in the same coherent change.
- Avoid duplicate local/map indexes: an index belongs to one stable topic or
  collection; another context links to it.
- Never feed generated TOCs back into source ingestion or count them as original
  evidence. Projection echoes must not restart generation.

## 6. Canonical model and evidence

### 6.1 Extend existing records

The following are proposed responsibilities, not mandatory final table names.
A0 must decide which additions fit existing records and which require tables.
Do not introduce a universal node store or a second authority for source relations.

| Record/boundary | Proposed extension |
| --- | --- |
| Wiki page/revision | Management mode (`ai_managed` or `human_managed`), page role, editorial purpose, current brief and exact input coverage. Keep current stable IDs and immutable revision history. |
| Section | Independent prose protection and provenance; evidence validation reason/revision; optional typed question/claim blocks. Unchanged sections retain dependencies. |
| Navigation membership/link | Stable ID, source page/section/group, typed target (`page`, `source`, `atomic_note`, `entity`), purpose, order, origin, placement protection and expected revisions. |
| TOC group | Stable group identity within a collection/topic, title, optional explanation, ordered membership references and authorship. Prefer one collection implementation for source/topic/map roles. |
| Curator run/change set | Versioned snapshots over multiple targets, discovery coverage, proposed creates/updates/links, dependencies, checkpoint and canonical receipts. Extend the organization boundary. |
| Automatic policy | Scope, trigger selection, allowed operations, budgets, model override if any, instruction/domain context, enabled/paused state and activation history. |
| Impact delivery | Per-consumer receipt, input generation and causal origin; extend the existing impact event mechanism so crash recovery cannot lose work. |
| Investigation | Question, scope, current answer page, evidence gaps, followed/paused/resolved state, trigger/cadence, last evaluated input fingerprint and evaluation history. |
| Projection layout | Version, language, stable category bindings, registered path assignments and migration journal with exact bases/receipts. |
| Prompt catalog | Stable prompt/fragment IDs, immutable shipped defaults, typed variables, user overrides, activation history and pinned composition hashes. Reuse existing instruction history where applicable. |

A0 must assess the existing `knowledge_impact_events.consumed_at` field: one
consumer must not mark an event globally finished while another still needs it.
Use consumer-specific delivery state or a serialized dispatcher with durable
fan-out receipts. Choose one approach, not two independent queues.

Backfill management/protection conservatively. Human-origin, reviewed or already
protected content stays protected. Legacy unprotected AI drafts may become
eligible only under an enabled policy. An ambiguous origin is not permission.

### 6.2 Knowledge is supported by original evidence

- Keep source attribution, user interpretation and model inference distinct.
- Maintain exact source revision/excerpt references through intermediate notes,
  summaries and wiki sections. The same original appearing in several derivatives
  is one evidence lineage, not independent corroboration.
- Persist exact consumed dependencies per section and TOC explanation. Navigation
  dependencies can update links without making unchanged factual prose stale.
- Support multi-source sections within their authorized scope. A page with a
  different purpose may share sources without being a duplicate topic.
- Existing extracted graph claims/relations can be replaced during regeneration.
  Their current IDs are not an immutable long-term assertion history; retain
  consumed snapshots and original evidence before using them in durable pages.
- Distinguish a statement becoming invalid from the source text being revised,
  a page being reorganized or a projection path moving.

### 6.3 Review must not make automation unusable

Keep four independent dimensions: authorship/management, human review, evidence
freshness and synchronization. A fifth validation result can record structural
support checks without pretending to be human verification or factual certainty.

The existing `needs_review` flag covers cases that the automatic workflow must
distinguish: a newly generated assertion awaiting human verification and an edited
assertion whose old citation may no longer support its wording. Design a versioned
reason/assessment record tied to the exact section revision.

Ordinary exploratory consultation may use fresh AI drafts with validated original
references and an explicit unreviewed label. `reviewedOnly` continues to require
the appropriate human state. Changed/unsupported assertions cannot be admitted
merely by relabeling them as drafts. Revalidation or a reviewed replacement is
required. Machine structural checks never set human review to accepted.

Audit existing save paths: pinning a page or changing placement must not convert
every unchanged generated section into human prose. Editing one section protects
that section; protecting the whole page is a separate user action. Preserve all
old revisions and existing protections during migration.

## 7. Authority and configuration

### 7.1 One deliberate activation, bounded ongoing work

Offer an automatic organization setup with understandable choices: library/domain
scope, future imports, desired detail, interests, note TOCs, update cadence and
resource allowance. Initial library organization is a separate scoped action.
Show an effective preview before activation; do not require prompt editing.

The default generative model comes from the current task router. Keep “Force
another model” as the existing advanced override. Instruction functions/domains
can evolve independently without creating a model route per domain.

Saving instructions does not execute curation. Enabling a policy authorizes its
listed triggers and operations; changing it records a revision. Pausing stops new
admissions and prevents unapplied work from using revoked authority. A model or
document cannot activate or broaden a policy.

| Operation | Initial automatic policy | Human involvement |
| --- | --- | --- |
| Repair deterministic indexes/backlinks | Automatic within scope | Visible history; no repeated approval. |
| Create grounded AI topic sections and TOCs | Automatic after policy activation | Inspectable/reversible; material stays visibly unreviewed. |
| Give new generated pages their initial placement | Automatic within authorized destinations | Preserve a coherent navigation preview and history. |
| Update unprotected AI-managed sections/memberships | Automatic if expected revisions and dependencies validate | Conflicts become one reviewable change set. |
| Edit protected text or fixed membership/order | Proposal only | Explicit targeted approval; preserve original wording/history. |
| Move established branches, merge/split identities or archive substantive knowledge | Reviewable proposal by default | Show affected objects and links; no routine structural churn. |
| Delete canonical sources, evidence or history | No curator capability | Existing separate user-controlled deletion flow only. |
| Save a transient answer | Explicit save | Existing deliberate action; no silent chat capture. |
| Refresh a followed question | Automatic under its enabled policy | Notify for meaningful findings, limitations or required review. |

Small reversible placement automation beyond initial placement can be evaluated
later as an explicit policy capability. Do not silently relax legacy M3b's
mandatory-review schema.

### 7.2 Prompts and policies have different roles

Implement a dedicated application-wide Prompts settings section following the
[companion design](ai-prompt-catalog-plan.md). It includes current source summaries,
atomic notes, matching, graph extraction/canonicalization, relation descriptions,
embeddings, diagnostics and repairs, as well as new wiki functions. Each prompt
field uses `%variable_name%` placeholders and lists its used variables/functions
directly beneath the field. Provide search, breadcrumbs and an expandable hierarchy.

Extend existing organization instructions with slots for discovery, page synthesis,
TOC organization, consultation and maintenance inside that same catalog. Reuse
global/function/domain/domain-function inheritance and revision history; Organization
and Maintenance settings deep-link to it rather than owning duplicate editors.
Old advanced prompts remain bound to the contracts against which they were
validated. Activation of a new advanced contract needs its own bounded sample.

Application code owns schemas, scopes, allowed targets, budgets, review and apply.
Prompts express editorial preferences: vocabulary, preferred depth, emphasis,
reading order and useful connections. Keep ordinary settings free of internal
IDs, JSON manifests and model bookkeeping; offer diagnostics on demand.

## 8. Curator execution

### 8.1 Reuse the application executor

Introduce a versioned multi-target curator under the organization service
boundary. The existing three-tool executor stays available for legacy run replay
and explicit single-page synthesis. A broader application contract is required;
increasing a prompt's ambition cannot create unsupported operations.

Proposed read/proposal operations:

| Operation | Responsibility |
| --- | --- |
| `readKnowledgeIndex` | Read bounded topics, TOCs, page purposes and scoped coverage. |
| `findRelatedKnowledge` | Retrieve eligible page/note/source candidates using existing text, concepts, vectors and relations. |
| `readKnowledgeRevision` | Read exact page/note revisions and original evidence with distinct handles. |
| `readSourceEvidence` | Read complete bounded passages/locators from original sources. |
| `proposeKnowledgeChanges` | Describe a coherent set of creates, section patches, TOC groups, typed links and initial placements. |

Use temporary proposal handles for new objects and allocate canonical IDs in the
backend. Every reference must resolve to a supplied existing target or a valid new
handle within the same change set. The model cannot issue SQL, arbitrary code,
filesystem operations, external fetches, policy changes or apply commands.

Support validated structured output through current adapters. Native tool
transport remains optional and requires equivalent contract tests. The custom
TypeScript executor remains the selected runtime; evaluate LangGraph.js only if
measured recovery/branching complexity warrants the existing STACK decision gate.

### 8.2 Execution lifecycle

```text
authorized trigger
  -> admitted snapshot
  -> discover candidates
  -> read knowledge and originals
  -> build coherent proposal
  -> validate evidence, scope, references and expected revisions
  -> automatic apply OR awaiting review
  -> canonical transaction and receipts
  -> native navigation refresh and projection invalidation
```

Each state is durable, cancellable where applicable and recoverable. Persist
proposal output before review. Canonical apply is idempotent; uncertain provider
billing is not exactly-once execution. Do not hold a database transaction while
waiting for inference.

Apply a coherent bounded change set in one transaction, including new identities,
sections, typed links, TOC membership, dependencies and receipts. Revalidate
cancellation/policy and lock targets in stable order. A conflicting target sends
the coherent group back for review/replanning; never silently apply an invalid
subset. Independent groups can finish separately with visible partial completion.

One versioned organization checkpoint owns the curator state. Reuse canonical AI
audit references and the existing supervisor; do not introduce an independent
inference queue, billing record or competing checkpoint authority.

### 8.3 Discovery and bounded execution

Discovery begins with exact known dependents, then searches for relevant existing
topics and original evidence. Use title/aliases, page purpose and content, grounded
summary concepts, eligible notes and conceptual relations as separate signals.
Text retrieval must work without vectors or AGE. Similarity and graph communities
suggest candidates; they do not establish identity or hierarchy.

For a new source C related to a page supported by A and B:

1. Locate that page within the enabled policy scope.
2. Read its current purpose, sections, dependencies and permitted evidence from
   A/B/C; preserve the actual authorized source set in the run snapshot.
3. Update only relevant sections and TOCs. New evidence may support, qualify or
   contradict old claims.
4. If A or B lies outside the policy, expose only permitted discovery metadata
   and request a scope decision. Do not load excluded prose or create a silent
   duplicate merely to bypass the conflict.

Page creation requires a useful distinct purpose and enough substantive evidence
for its claims. One authoritative source may be enough for an attributed page;
there is no mandatory source count. Reuse topics before creating near-duplicates.
Do not generate one page per entity, note, chunk or relationship.

Start A2 with deliberately small limits: at most three changed pages/TOCs per
coherent group, six section patches per page, twelve complete original passages
per synthesis step, twenty tool actions, twenty-one model admissions including
one repair, and a ten-minute deadline including FIFO waits. These are provisional
development ceilings, not calibrated performance claims. Lower effective limits
must respect the selected model's context and configured policy allowances.

Count all admitted calls, repairs, steps and cumulative reported usage across
retries. Record unknown tokens/cost as unknown. An in-flight request can overshoot
a reported-token allowance; stop subsequent calls. Do not promise a strict money
cap without a reliable execution-cost bound. Paginate broad discovery and split
large work into resumable groups instead of truncating evidence or raising limits
without evaluation.

## 9. Initial organization and incremental updates

### 9.1 Bootstrap an existing library

1. Inventory canonical sources, descendants, available originals, summaries,
   notes, current embeddings, relations, existing pages and protected placements.
2. Create a read-only assessment of coverage and proposed organizing scope.
   Identify existing pages and aliases before generating topic candidates.
3. Show a bounded initial plan: candidate themes, TOCs, reusable artifacts,
   missing optional signals, selected model and expected work limits.
4. On explicit start, process checkpoints in batches through the existing FIFO.
   Do not regenerate valid notes, matching, graphs or embeddings as a prerequisite.
5. Apply permitted groups incrementally; the native wiki becomes usable after
   the first completed group. Preserve progress and errors across restart.
6. Finish with coverage, unresolved material and review items. “Organized” means
   integrated or deliberately catalog-only, not that every source produced prose.

Do not reset the library, replace existing source IDs or assign every source to
one exclusive theme. Existing manual pages remain visible and preserved.

### 9.2 New material and edits

Extend the processing-plan contract with automatic discovery options that do not
require a topic title. Retain legacy plan parsing/replay. Offer a visible effective
“Integrate into wiki” choice backed by an enabled policy; do not silently mutate
old named presets or saved plans.

Selected note generation can produce/update its deterministic source TOC after
completion. Semantic regrouping is an authorized organization operation. A valid
zero-note result does not create artificial notes or a misleading empty analysis.

Wait for selected upstream work using existing per-stage barriers. A completed
parent job does not prove matching settled. Record failed/skipped derivatives and
continue from usable originals only when the admitted policy permits partial work.
Catalog-only sources get reference/navigation participation without AI claims.

Consume changes from source revisions, note edits/review, summaries, source
relation changes and consumed wiki sections. Add missing event coverage for newly
available inputs where required. Commit events with the canonical mutation.

Coalesce by scope and input generation. Track direct dependents and potential
new-topic discovery separately: an unfamiliar source has no dependents yet but
can still contribute knowledge. Preserve rejected decisions until meaningful
input, scope or instruction changes justify reconsideration.

Use causal run/change-set IDs to prevent recursive processing of the curator's
own output. Propagate real cross-page invalidation through a bounded worklist with
visited revision fingerprints; do not suppress legitimate downstream updates
or allow cycles to schedule forever.

### 9.3 Recoverable status

Distinguish cataloged, awaiting organization, analyzing, partially integrated,
integrated, needs attention and stale. Keep ingestion, editorial and sync states
independent. Provide pause, cancel, retry and inspect-result actions without
turning the home screen into a job-monitoring console.

## 10. Desktop experience

### 10.1 Main workspace

```text
Second brain   [Search knowledge or ask...]   Add material   Activity
-----------------------------------------------------------------
Home           | Learning > Memory          | Evidence / related
Themes         | Page title and overview    | Source and locator
Maps           | Read · Notes · Sources     | Exact revision/excerpt
Investigations | · Connections              | Why connected
Atomic notes   | Prose and inline links     | Open original
Sources        | Local TOC and subtopics    |
Attention      | Recent meaningful changes |
```

Use the current shared theme/components. Treat these panels as adaptive: collapse
the tree/inspector before overlap, with independent scroll and preserved history.
Normal app opening size and minimum supported width are the visual gates.

The tree needs expansion/collapse, keyboard arrows/Home/End, focus, selection,
stable keys, breadcrumbs, pagination/lazy children and expansion persistence.
Secondary memberships are visibly links to an existing item. Do not fetch a
flat first-1,000-pages list and call it complete navigation.

Support creating/moving within context, but keep manual page creation secondary
to reading and material intake. Replace numeric position entry as the primary
organizing interaction with accessible move-before/after/into commands. Optional
drag/drop has an equivalent keyboard path and never changes source parentage.

### 10.2 Reading and links

- Render typed links to pages, source references, notes and entities inside prose
  and TOCs; provide backlinks and “why connected” details.
- Use one safe reference resolver across native preview, answers and projection.
  Do not infer identity from titles or render untrusted HTML.
- Inline citation selection focuses the exact evidence inspector. Preserve page,
  selected passage, question, filters and scroll through source navigation/Back.
- Topic notes and sources are current memberships/evidence, not every item from
  any source that happens to be cited somewhere on the page.
- Offer a bounded local map with a list alternative; distinguish structural,
  evidential and semantic edges. Preserve existing global graph behavior.
- Human edits, reviewed state, evidence age, automatic work and sync conflicts
  remain distinguishable without filling every page with technical controls.

### 10.3 Home, attention and settings

Home shows useful thematic entry points, continue reading, followed questions and
meaningful recent changes. No model or an empty library still provides catalog
access and a clear intake path. Partial knowledge displays useful available work.

Attention groups related proposed changes with a reason and before/after reading
view. Accept/reject coherent groups; explain protected targets and stale inputs.
Ordinary successful maintenance is quiet. Restore creates a new revision and
does not erase historical learning or receipts.

Settings has separate, connected sections:

- **Automatic organization:** scope, operation policy, detail and activation.
- **Maintenance:** automatically installed routines, next/last execution,
  deadline/status, budget, pause/run-now and a link to each routine's prompt.
- **Prompts:** complete hierarchical catalog from the companion design, including
  variables below every prompt field and composition/history previews.
- **Connections / Obsidian:** export scope, language/layout and migration review.

All user-visible copy and variable descriptions use the five supported locales.
Template text is content, with its own recorded language; changing UI language
must not rewrite a customized template or relocate a vault.

## 11. Consultation and investigations

### 11.1 Knowledge-first retrieval

1. Resolve authorized scope and find relevant theme indexes, pages and TOCs.
2. Read their current compiled sections and dependency/coverage state.
3. Use adequate, fresh compiled knowledge directly as the working context,
   keeping resolvable original provenance for its assertions.
4. Deepen into original passages when the question needs detail, evidence
   verification, a disagreement, missing coverage or stale-section replacement.
5. Answer with source-backed citations and distinguish user interpretations,
   generated synthesis and unresolved alternatives.

Original access must not depend on repeating the old top-12-chunk selection before
any wiki knowledge can participate. Conversely, compiled prose is not independent
proof or permission to skip source validation. Expand evidence lazily within
budgets, preserve source diversity and disclose coverage limits.

Retain working text retrieval when embeddings/AGE are unavailable. The new
knowledge retrieval contract can reuse existing lexical/vector repositories;
do not silently change Library or legacy evidence-search ranking semantics.
Human-reviewed-only mode remains explicit; ordinary exploration may use eligible
unreviewed generated knowledge under section 6.3's distinct validation states.

### 11.2 Followed questions

“Follow this question” creates a persistent investigation with explicit scope,
an answer page, current evidence, gaps and a refresh policy. Merely asking a
question stays read-only. Saving a one-off answer remains available separately.

Changed relevant inputs trigger a refresh; routine due checks with unchanged
input do not call the model. Record previous answers and what evidence changed.
Distinguish resolved, paused and awaiting-evidence states. Missing evidence can
produce suggested material to obtain, not an automatic external research task.

Notify when an answer changes materially, a contradiction is substantiated or user
input is needed. Keep transient chat, deliberately saved source material and
followed investigations as distinct retention choices.

## 12. Maintenance and long-term memory

### 12.1 Automatic routine setup

Enabling automatic wiki organization includes a single setup preview of the
default routines below. Activation creates/binds those persisted routines
automatically; users do not have to configure each weekly/monthly schedule by hand.
It also selects the relevant registered prompt compositions for each routine.
No routines are activated merely by installing an application update.

Use stable setup keys based on policy ID, routine kind and scope plus a preset
version. Reopening setup or restarting must not duplicate schedules. Reuse
compatible existing schedules; detect overlaps and show the proposed reconciliation.
Preserve customized cadence, prompts and limits on upgrade. A deliberate reset
can restore preset defaults without erasing history.

If the effective generative route is unavailable, keep setup and user edits,
show a needs-configuration state, and permit deterministic inspections. Never
silently switch models. Automatic routine activation remains part of the user's
explicit automation policy, independent of choosing a model.

### 12.2 Initial cadence and execution deadlines

These are proposed initial defaults to expose during setup and calibrate at A4.
Use the selected IANA timezone, initially the system timezone. A due time is not
a promise of execution while the desktop is closed. The start windows below are
measured in eligible open-desktop time, with the actual overdue interval visible.

| Routine | Due trigger | Target start window after eligible | Maximum execution per occurrence | Work |
| --- | --- | --- | --- | --- |
| Incremental integration | Two-minute debounce after relevant selected processing/edits settle | 15 minutes | One 10-minute group, then checkpoint/defer remaining groups | Update affected pages and TOCs; consider new topics. |
| Daily content upkeep | Every day at 02:00 | 6 hours | 20 minutes, sliced into groups of at most 10 minutes | Stale sections, new evidence, citation/link integrity and followed questions with changed inputs. |
| Weekly organization | Sunday at 03:00 | 24 hours | 45 minutes, sliced into bounded groups | Cross-topic TOCs, disconnected useful notes, duplicate candidates and navigation coherence. |
| Monthly consolidation | First day of each month at 04:00 | 72 hours | 90 minutes, sliced into bounded groups | Broader synthesis, temporal review, archived/active relevance and reviewed merge/split proposals once supported. |
| Followed investigation | Relevant input change; otherwise inspected in daily upkeep | Same incremental/daily window | Shared occurrence allowance; no duplicate call | Refresh the persistent answer only when its evidence or explicit instructions require it. |

The per-group deadline includes FIFO waiting after admission. Whole-occurrence
caps bound execution across slices; paused/deferred time is recorded separately.
Deadline exhaustion saves progress and reports incomplete coverage; it never
labels an unfinished library sweep complete. Budgets can stop work earlier.

A4 sets conservative default per-occurrence and calendar-month call/token
allowances from the A2 real-model measurements, exposes the resolved numbers in
setup, and freezes them as a versioned preset before release. Unknown monetary
cost is not zero; a hard monetary cap needs a reliable pre-execution bound.
The schedule defaults above must be usable without requiring users to enter
budgets manually, but no unmeasured token/cost promise is made by this plan.

### 12.3 Scheduling and recovery semantics

- Reuse `MaintenanceService`, persisted schedules/runs and the existing supervisor.
  No OS scheduler or always-running service is introduced.
- Scheduled model work normally waits for at least one minute of inactivity and
  yields between groups to imports, foreground AI and conflicting sync. Run now
  bypasses only the idle preference, not authorization, budgets or conflicts.
- Coalesce missed occurrences to one bounded catch-up per compatible scope.
  Daily/weekly/monthly overlap can share inspection and input coverage without
  losing each routine's due state or silently blending different policies/prompts.
- No replay storm after a week with the application closed. Resume unfinished
  cursors before beginning another identical full sweep.
- Missing month days clamp, DST gaps advance to the next valid local minute and
  repeated local times run once. Timezone/cadence edits recompute future authority.
- Pause/disable revokes new work and guarded apply; restart and retry retain
  cumulative budgets, prompt/model snapshots, occurrence IDs and receipts.
- Retry transient infrastructure failures with bounded backoff inside the same
  allowance. Uncertain model calls and invalid proposals do not obtain a fresh
  budget by retrying; ambiguous calls require the existing recovery policy.
- Display last success, next due time, start deadline, running duration, overdue
  reason, coverage and pending decisions. Quiet no-change runs stay in history.
- Maintenance never raises prompt capture settings, wipes matching caches,
  deletes canonical content or regenerates optional artifacts without selection.

### 12.4 Content operations

Extend maintenance with the curator's scoped patch workflow: refresh outdated
sections, incorporate relevant new evidence, update TOCs and sustain alternative
interpretations. A source correction should repair the exact consumers, not
rewrite every page sharing a broad theme.

Distinguish deterministic problems from semantic findings. A broken reference can
be verified mechanically; “these sources disagree” requires reading the supported
claims and their context. Conflicting accounts are preserved and attributed.
Repeated model summaries do not become new corroboration.

Keep active knowledge, historical context and archived material discoverable.
Reduced relevance changes prominence; age alone never makes a fact false or
justifies deletion. A substantive archive or branch reorganization remains a
reviewable proposal, with cooldown and history to prevent oscillation.

### 12.5 Temporal and procedural memory

A7 adds explicit interpretation of event/validity time versus publication,
recording/import and revision time. Unknown dates stay unknown. A past preference
can be historically accurate without being the user's present preference.

Use versioned assertion/interpretation records attached to knowledge sections,
with original evidence and support/contradiction/supersession links. Resolve the
minimal schema at A7; do not treat replaceable extracted graph rows as durable
temporal assertions or rewrite history when a view changes.

Deliberately supplied personal/daily notes and saved decisions can support pages
about patterns, lessons and reusable procedures. Identify user statements and
AI inferences separately. A proposed procedure records when it worked, limits,
supporting experience and subsequent corrections. Instructions learned from
source text do not activate policies or alter the application's prompt catalog.

Advanced atomic-note consolidation may propose merging duplicates, splitting
multi-idea notes or creating cross-source notes. Before applying these operations,
define ownership independent of one arbitrary source's deletion cascade, retain
old IDs/revisions through supersession links, and update TOCs/dependents. This
workflow requires human review and explicit tests, not a similarity threshold alone.

## 13. Obsidian projection and migration

### 13.1 One canonical organization, two browsing surfaces

Project the information architecture from sections 3–5 using existing sync
ownership, managed-root containment and scoped export. Reuse source/note
identities, registered paths, exact bases and revision/section anchors.
Native and Obsidian views consume the same typed memberships and link targets.

Add a new format/layout capability for TOCs, source wrappers, generated metadata
and new editable sections. Negotiate compatibility before enabling writeback.
An old plugin may retain supported old content and explicit divergence handling;
it must never reinterpret a new TOC as a source or atomic note.

Keep user text/frontmatter outside generated areas. Explicit supported edits
round-trip through editorial services with human protection and optimistic
revisions. Moving a vault folder remains a physical move, not a semantic command
to reparent sources or topics. Generated links cannot approve source relations.

No-plugin output must be useful plain Markdown with working wikilinks. Full
audit/history remains canonical in PostgreSQL, with portable evidence snapshots
and references sufficient to understand the exported current knowledge.

### 13.2 Registered-path migration

The new `Fontes`/`Notas atômicas`/`Wiki` layout does not apply to existing files by
simply changing a path formatter. Existing paths are deliberately stable and may
contain human edits. Migration is an explicit, separately reviewable operation.

1. Inventory current registered paths, schema/capability versions, live files,
   acknowledged bases, pending plugin operations, tombstones and local divergence.
2. Produce a dry-run old-to-new path map with source/page/note/asset IDs, affected
   links, filename collisions, missing files and estimated copy/move work.
3. Persist a migration plan/checkpoint and recoverable backup strategy before
   applying. Require conflict resolution or a clear exclusion for dirty targets;
   do not overwrite an open editor or consume its pending text.
4. Quiesce conflicting writes for affected targets. Use the existing target
   coordinator, compare actual bytes and preserve base/local/proposed snapshots.
5. Migrate bounded groups, updating registry bindings and every generated link
   through durable receipts. Filesystem and SQL cannot be one transaction;
   reconcile crash states rather than claiming atomic whole-vault moves.
6. Verify observed content hashes, preserved canonical IDs/revisions and links.
   Preserve ambiguous unmanaged links for explicit review; do not rewrite unrelated
   user files just because their text resembles an old title.
7. Resume normal projection only after target reconciliation. Failed targets remain
   recoverable; successful independent groups stay recorded.
8. Support rollback from the journal/backups while checking for edits made after
   migration. Rollback must preserve those edits rather than replay old bytes blindly.

Use the same process for later layout-language changes or major physical
reorganizations. Source promotion from catalog-only to substantive content keeps
identity and paths. Archival/tombstones preserve restoration and do not erase
originals. A paused/unconfigured sync performs no migration or projection writes.

## 14. Implementation milestones

A0 contract/fixture work and A1 runtime catalog/editor are independently accepted;
A2 has passed independent backend, selected-model and native walkthrough gates;
A3 has passed independent collection, selected-model, native and DEV migration gates;
A4 has passed independent maintenance, context, selected-model, native and DEV migration gates; A5–A8 remain **planned**. Each implementation task must report its
actual checks, migration state, rule updates and remaining limitations. Do not
mark a milestone accepted because mocks or an export alone succeeded.

| Milestone | Depends on | Main result | Exit gate |
| --- | --- | --- | --- |
| A0 — Contracts and executable acceptance design | Existing M1–M5 baseline | Information model, management policy, prompt inventory, migration design and synthetic journey fixtures | Every target behavior maps to an owner and test; compatibility/protection decisions are explicit. |
| A1 — Application-wide prompt catalog | A0 | Real runtime registry, hierarchical settings editor and documented variables for existing prompt families | Editing an active prompt changes the actual next eligible call; all current families and repairs are covered. |
| A2 — First automatic wiki with native UX | A0, A1 | A bounded source-to-topic/TOC flow visible in the app, including an expandable tree and evidence navigation | New material produces a useful browsable wiki without manual page titles or Obsidian. |
| A3 — Existing-library bootstrap and incremental integration | A2 | Resumable organization of an existing collection, event delivery, multi-page integration and scalable native navigation | A/B knowledge is updated by C; restart, unchanged retries and partial processing preserve correctness. |
| A4 — Automatically configured content maintenance | A3 | Daily/weekly/monthly routines installed by policy activation, with schedules, deadlines and editorial updates | Closed-app catch-up, pause, budgets, stale resynthesis and quiet no-change behavior pass. |
| A5 — Knowledge-first consultation and investigations | A3; A4 for recurrence | Compiled-page retrieval, original drill-down and persistent followed questions | Existing synthesis is reused faithfully; questions stay read-only unless saved/followed. |
| A6 — Obsidian layout and safe migration | A2/A3; A5 for investigation export | Source-type folders, TOCs, portable links, new format capability and registered-path migration | Native/Obsidian knowledge parity and real open-editor/offline recovery pass. |
| A7 — Long-term semantic maintenance | A4, A5, A6 compatibility | Temporal assertions, experience/procedure pages and reviewed note consolidation | Historical truth, human interpretation, note ownership and supersession survive edits/deletion scenarios. |
| A8 — Complete product acceptance and rollout | A1–A7 | End-to-end evaluation, scale checks, packaging and migration/rollback readiness | The full user journey and all preservation gates pass with truthful remaining limits. |

### A0 — Model, scope and fixtures

- Freeze object roles, typed links/TOC groups, management modes and the distinction
  between pending human verification and invalidated evidence.
- Select the minimal persistence extensions from section 6. Specify versioned
  APIs, old-run replay, conservative backfills and consumer event ownership.
- Inventory every prompt caller/repair and define the shared registry/variable
  schema from the companion document. Capture current outputs as golden fixtures.
- Define routine setup identities, activation semantics, calendar windows and
  interaction with existing custom schedules.
- Prepare a synthetic mixed library: books/chapters, paper/sections, web article,
  catalog-only source, personal/daily note, existing human page and overlapping
  ideas with a deliberate contradiction. Do not import it into the user's library.
- Specify a normal-size native walkthrough and old-to-new Obsidian path map.

Owners: `packages/domain`, `packages/db`, current wiki/organization/maintenance
services, integration contracts, docs and owning rules. No real-library mutation
is needed to complete A0.

### A1 — Prompts as an actual application service

- Implement catalog/revision persistence and deterministic template rendering,
  variables, fragments and effective inheritance.
- Build Settings > Prompts with tree/search, field-level variable descriptions,
  insertion, validation, composition preview, activation/reset and history.
- Register all existing prompt families, not just the second-brain functions.
  Migrate callers in small groups with rendered-input equivalence checks.
- Migrate legacy Organization instruction slots into this authority without
  discarding drafts or histories. Keep compatibility readers for old snapshots.
- Include prompt composition IDs/hashes in canonical audits and relevant artifact
  fingerprints; preserve existing full-capture privacy and retention settings.

Owners: domain schemas, proposed prompt service/repository, existing AI/knowledge
callers, settings renderer, preload/IPC, i18n and DB migrations. Gate with actual
caller-spy tests in addition to template unit tests. No inline prompt duplicate
may remain authoritative after its registered entry is declared migrated.

### A2 — First complete automatic slice

- Implement multi-target curation with the small limits in section 8 and the
  existing supervisor/FIFO/adapters; register its prompts immediately.
- Support new AI topic pages, source/topic TOCs, typed note/source links and
  initial placement under an activated scoped policy.
- Deliver the minimum real native reading journey at the same time: expand a
  theme, open a page, follow a note and inspect the original excerpt, then Back.
- Exercise the slice once with selected atomic notes and once with originals
  only. Neither variant may silently activate the other's optional stages.
- Demonstrate a useful topic and TOC from at least two complementary materials;
  a second run over unchanged inputs produces no duplicate page/note/index.

Owners: organization/wiki repositories and services, `WikiWorkspace`, navigation,
safe Markdown/reference rendering, processing-plan UI and i18n. Do not defer all
native UX to the end or judge this gate only in Obsidian.

### A3 — Integrate and scale the collection

Status: **implemented; independent coordinator gate pending**. See the
[A3 implementation report](automatic-wiki-a3-report.md).

- Implement assessment/bootstrap cursors, event consumption and exact dependent
  invalidation with bounded new-topic discovery.
- Resolve existing pages by purpose and evidence as well as title; correctly
  combine A/B/C within policy scope without bypassing excluded sources.
- Reconcile selected processing barriers and partial failures. Preserve valid
  summaries, notes, vectors, matching decisions and graph extraction.
- Complete paginated/lazy tree reads, memberships/backlinks, contextual Notes /
  Sources / Connections views and reviewable grouped changes.
- Add progress/resume/pause and freshness/coverage presentation that survives
  reopening source details or restarting the application.

Owners: ingestion participation, job supervisor, impact/dependency repositories,
curator, navigation/read APIs and renderer. Migration tests need populated old
history and an empty baseline. Scale fixtures must exceed the old 1,000-page list
ceiling and prove that no pages silently disappear.

### A4 — Setup and run automatic maintenance

- Install/bind incremental, daily, weekly and monthly routines in one policy
  activation. Repeated setup is idempotent and respects customized schedules.
- Implement the cadence/deadline table, eligible-time calculation, overdue
  reasons, idle gates, compatible overlaps, catch-up and cancellation.
- Extend deterministic diagnostics with bounded content refresh and TOC upkeep.
  Preserve unreviewed/curated distinctions and alternative interpretations.
- Calibrate and publish versioned default call/token allowances from A2 trials;
  setup works without hand-entered limits. Share a parent policy allowance so
  automatically installed routines cannot multiply the permitted spending.
- Expose next/last run, start deadline, limits, pause/run-now, history and links
  to the exact effective maintenance prompts.

Owners: maintenance domain/repository/service, supervisor, automatic policy
settings and Prompts integration. Test event-driven/daily routines as new versioned
contracts; do not reuse legacy weekly/monthly schemas with invented semantics.

### A5 — Consultation and persistent questions

- Implement the knowledge-first retrieval contract and scope-aware original
  evidence expansion. Retain text fallback and separate legacy search behavior.
- Persist investigations and refresh bindings; keep one-off unsaved answers
  transient. Saving/following remain explicit product actions.
- Show the question, current answer, changed understanding, citations and gaps.
  Use meaningful-change notifications and no-input/no-call optimization.
- Register answer, comparison, investigation, gap and repair prompts in the
  same searchable settings hierarchy.

Owners: consultation domain/service/repository, maintenance bindings,
investigation persistence and native answer/read views. Test that compiled pages
are used before unrelated raw chunks and that stale/unsupported prose is not
laundered into a new answer.

### A6 — New Obsidian mirror

- Implement `Fontes` classification, parent/child source wrappers, source note
  TOCs, shallow atomic-note placement, topic/map indexes and attachment links.
- Upgrade shared parser/serializer/protocol with supported editable/generated
  regions and negotiated plugin capabilities. Preserve old-format handling.
- Build migration assessment, preview, journal, target write coordination,
  conflict recovery, link verification and guarded rollback.
- Exercise no-plugin, old-plugin and current-plugin behavior with an actual
  temporary vault and open editor, including offline edits and restart.
- Keep native and exported navigation driven by the same canonical memberships;
  migration must not invent a second hierarchy or duplicate source files.

Owners: projection/editorial services, Obsidian repositories, worker/client,
plugin, integration contracts and Connections settings. Use existing M4/M5
verifiers as regression foundations; actual vault QA remains required.

### A7 — Long-term interpretation and note evolution

- Add explicit validity/event/recording times and versioned interpretation changes
  with evidence. Display historical knowledge without treating it as current.
- Maintain reusable lessons/procedures from deliberately supplied experience;
  expose assumptions and corrections, not automatic personality profiling.
- Implement reviewed merge/split/cross-source note workflows only after removing
  unsafe single-source ownership assumptions for their new identities.
- Repair affected TOCs, links, dependencies and projections through receipts;
  preserve prior IDs/revisions and rejected decisions.
- Add temporal/procedure/consolidation prompt leaves and appropriate recurring
  maintenance routines under the existing policy, not new hidden background jobs.

Owners: note/wiki domain and repositories, review services, curator/maintenance,
investigation views and projection. Entire canonical-source deletion remains a
separate explicit user operation and must be tested against retained knowledge.

### A8 — Product acceptance and rollout

- Run the complete matrix below with deterministic fixtures, real PostgreSQL,
  native desktop checks and an actual temporary Obsidian vault.
- Evaluate representative real-model outputs against a human-reviewed synthetic
  corpus. Reuse current selected models through one FIFO; do not launch extra
  local runtimes or claim uniform compatibility from a single successful model.
- Preserve the earlier Luna-reference/local-best-effort acceptance history as
  context; select any new paid trials explicitly when implementation reaches them.
- Verify package startup/preload/plugin artifacts, migrations, backup/restore,
  paused-policy behavior and old-run compatibility.
- Roll out with automatic setup offered explicitly and a scoped first run.
  Migration remains a separate concrete preview/action. No library reset.
- Update docs and rules to implemented status only after each gate passes.

## 15. Verification and release gates

### 15.1 Scenario matrix

| Area | Required scenario and expected result |
| --- | --- |
| Complete journey | Import A/B, generate useful topic and TOC, read natively, import C, inspect the resulting targeted update, then browse the same structure in Obsidian. |
| Optional stages | Originals-only, notes-only selected derivation, unavailable vectors/AGE and metadata-only containers all retain truthful useful participation. No hidden generation. |
| TOCs | One note in several topic/source maps keeps one identity. New/rejected/edited notes update only relevant groups; pinned order remains. Generated indexes never become source evidence. |
| Discovery | Equivalent topic aliases reuse existing pages; distinct purposes remain distinct; out-of-scope A/B cannot be exposed by importing C. |
| Protection | Editing one section preserves/protects that section; pinning/placement changes do not rewrite provenance or protect unrelated text accidentally. |
| Evidence | Exact historical excerpts survive changed/deleted originals; derivatives do not multiply evidence; unsupported edited assertions cannot pass as fresh drafts. |
| Transaction/recovery | Crash before proposal, while awaiting review, after canonical commit and before projection receipt; retry produces no duplicate canonical mutation. |
| Concurrency | New source revision, note link, human edit, policy pause or plugin edit during inference causes bounded revalidation/conflict, not lost content. |
| Prompt coverage | Every actual application prompt and repair resolves to the registry; an activated edit affects the next eligible call, with IDs/hashes in its audit. |
| Prompt variables | Every field documents exact tokens/functions; insertion, literal percent, source-contained tokens, missing values, schema fragments and cyclic composition behave correctly. |
| Prompt migration | Current defaults/overrides retain effective behavior; queued runs keep old templates; prompt changes cannot reuse incompatible embeddings. |
| Routine setup | One activation installs the default routines; restart/repeated setup/upgrades create no duplicate schedule and preserve user customizations. |
| Routine calendar | Due times, start windows, maximum duration, daylight-saving transitions, missing month days, timezone changes and overdue reasons are accurate. |
| Routine recovery | App closed for a week, resumed cursor, overlapping monthly/weekly routines, canceled run and exhausted allowance do not cause a catch-up storm or false completion. |
| Routine usefulness | Changed evidence updates relevant prose/TOCs; unchanged inspection makes no unnecessary model call and sends no routine notification. |
| Consultation | Fresh compiled knowledge is used; originals are expanded when needed; exploratory/reviewed-only modes and restrictions remain explicit. |
| Investigations | Ask does not persist/follow automatically; followed question refreshes once for a relevant generation and retains prior answers/gaps. |
| Long-term memory | Changed preference/event interpretation preserves history; old material is not false merely due to age; learned procedures retain qualifying evidence. |
| Note consolidation | Merge/split proposals preserve prior notes, attribution, deletion ownership, redirects, TOCs and all dependent snapshots. |
| Navigation | Expand/collapse, keyboard-only use, breadcrumbs, backlinks, source Back, historical deep links, pagination and a corpus above 1,000 pages work. |
| Native quality | Empty/no-model/loading/error/partial/stale states, all locales, light/dark themes and normal/minimum windows remain usable. |
| Export | Every source type, catalog-only promotion, parent-child order, repeated titles, Unicode, optional assets and multi-context notes project correctly. |
| Vault migration | Dirty/open files, unmanaged collisions, folder moves, duplicate IDs, tombstones, disk/write failure and interrupted migration preserve base/local/app content. |
| Sync compatibility | No plugin, old plugin, new plugin and offline replay cannot reinterpret new TOCs or generated summaries as source edits. |
| Rollback | Restoring app revisions or migration paths preserves edits made after the action being undone. |

### 15.2 Checks by changed boundary

Use existing tests/verifiers as foundations; extend them where behavior changes.

- Domain and service tests: wiki, organization, consultation, maintenance,
  processing plans/barriers, knowledge processing, source matching, identity/type
  resolution, AI FIFO/pinning and new prompt-rendering/caller-coverage suites.
- Renderer tests: wiki navigation/reference rendering, source history, prompt
  catalog/editor/variables, routine setup and calendar/status views.
- Real PostgreSQL: populated upgrade and empty-baseline paths, schema/index/FK
  verification, multi-target transactions, event consumers and migration receipts.
- Existing scripts: [wiki](../scripts/verify-wiki.ts),
  [organization](../scripts/verify-organization.ts),
  [M3](../scripts/verify-second-brain-m3.ts),
  [maintenance](../scripts/verify-maintenance.ts),
  [outward sync](../scripts/verify-obsidian-wiki.ts),
  [editorial sync](../scripts/verify-obsidian-editing.ts).
- Appropriate workspace checks: `npm test`, `npm run typecheck`, `npm run build`,
  `npm run format:check`, `npm run db:seed:verify`; generate/apply/verify migrations
  through the existing database flow. Run actual WebGL checks when graph
  rendering changes, and packaging/plugin checks when those artifacts change.

No application/AI/DB migration test is required merely to write this plan. Its
documentation verification consists of local links/anchors, formatting, scope
review and preservation of pre-existing edits.

### 15.3 Quality and scale evaluation

Use a versioned synthetic corpus with human-reviewed expected ideas, meaningful
connections, unresolved disagreements and counterexamples. Evaluate:

- Citation support, attribution, retained uncertainty and contradictions.
- Useful compression and semantic duplication across pages and atomic notes.
- Whether a user finds a known idea and follows it to its original evidence.
- Integration stability: unchanged material produces no gratuitous changes.
- Genuine improvement after C arrives; honest absence when evidence is missing.
- Prompt customization effects on real outputs, including invalid edits contained
  by unchanged application contracts.
- Actual call/token/cost availability, background-work delay and page/tree latency.

Record a reference machine and corpus sizes. Provisional native targets are
warm bounded navigation/search at p95 within 300 ms and a cached page within
200 ms, subject to measured calibration. Model inference has separate measured
latency; do not promise instant synthesis or universal long-term accuracy.

## 16. Risks and bounded decisions

| Risk | Planned handling |
| --- | --- |
| Repeating the earlier product gap | A2 must deliver automatic knowledge and native reading together; later backend milestones cannot substitute for this gate. |
| Excessive folder/topic proliferation | Useful-purpose creation criteria, TOCs over shared notes, shallow initial placement and review for major reorganizations. |
| Rewriting drift or entrenched false synthesis | Section patches, exact evidence, competing interpretations, immutable history and targeted revalidation. |
| Too many approvals | Enabled policy covers routine AI-managed text/TOCs; protection and significant structural decisions are specific exceptions. |
| Unsafe scope broadening | Discover only within the policy; out-of-scope dependencies require an explicit decision before reading/applying. |
| Background cost/backlog | Default scheduled setup with measured allowances, one FIFO, coalescing, cursors, actual deadlines and honest incomplete coverage. |
| A decorative prompt catalog | Runtime caller migration and coverage tests are required, including repair text and embedding instructions. |
| Incompatible prompt/vector updates | Versioned templates and full composition/strategy fingerprints; explicit re-embedding and legacy snapshot replay. |
| Confusing generated source wrappers with original text | Versioned editable/generated regions and negotiated plugin capabilities with exact bases. |
| Broken external links during migration | Persist path maps and target receipts, resolve generated references, preserve unrelated/unmanaged content for review. |
| Cross-source note deletion loss | Define ownership before merge/split/new cross-source creation; keep old identities and evidence snapshots. |

Defaults for exact candidate thresholds, model allowances and topic depth are
calibrated implementation choices. Table names/tool names are proposals. The
accepted direction is stable IDs, source-type folders, automatic TOCs/content
curation, native hierarchy, scheduled setup and a complete editable prompt catalog.
These choices do not require reopening the entire product discussion to begin A0.

## 17. Research references

References informed the design; their runtimes and assertions of quality are not
adopted as dependencies or proof of this application's behavior.

| Reference | Contribution used |
| --- | --- |
| [Karpathy LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) | Persistent compiled knowledge, source separation, incremental integration and useful answers retained as pages. |
| [Microsoft LLM Wiki architecture](https://github.com/microsoft/llmwiki/blob/main/ARCHITECTURE.md) | Separate raw inputs, concepts/entities, source references, saved queries and maintained indexes. |
| [LLM Wiki Kit schema](https://github.com/MauricioPerera/llm-wiki-kit/blob/main/SCHEMA.md) | Typed pages and explicit category indexes, with atomic assertions distinct from syntheses. |
| [Second Brain Public Blueprint](https://github.com/andrewabrahamian/second-brain-public-blueprint) | Maps as a navigation function distinct from durable topics and project work. |
| [LYT / ACE](https://blog.linkingyourthinking.com/notes/the-ace-folder-framework-flexes-for-you) | Multiple browsing intentions and maps over reusable ideas; no mandatory full PARA/ACE layout. |
| [A-Mem](https://arxiv.org/abs/2502.12110) | Dynamically connected atomic memories and revisiting existing organization after new material. |
| [Graphiti](https://github.com/getzep/graphiti), [Zep provenance](https://blog.getzep.com/how-zep-tracks-provenance-in-agent-memory/) | Temporal validity and traceable dependencies; preserve original support through updates. |
| [Hindsight mental models](https://hindsight.vectorize.io/developer/mental-models) | Persistent answers to chosen questions, scoped refresh and evidence/history. |
| [Letta context repositories](https://www.letta.com/blog/context-repositories/), [sleep-time compute](https://www.letta.com/blog/sleep-time-compute/) | Background consolidation and versioned memory; retain the application's existing executor and canonical database. |
| [memU](https://github.com/NevaMind-AI/memU) | Reusable procedures extracted from deliberately available experience. |
| [Memory as Metabolism](https://arxiv.org/abs/2604.12034) | Design inspiration for relevance, consolidation and preserving alternative interpretations; an unvalidated theoretical proposal, not a reliability guarantee. |
