# Source ingestion and hierarchy rules

Load this rule for source taxonomy, descriptors, metadata, import workflows,
bibliography, document hierarchy, processing plans, or reingestion. This rule
absorbs the durable decision formerly recorded as ADR 0001.

## Canonical source model

The canonical `SourceItem` taxonomy is:

```txt
PersonalNote, DailyNote, WebArticle, Book, BookChapter,
PeriodicalIssue, AcademicPaper, DocumentSection, StandaloneArticle,
Video, GenericDocument
```

- `SourceDescriptorSchema` is a discriminated Zod union across all source
  types. Every new desktop ingestion uses a complete typed descriptor validated
  at preload and main-process boundaries.
- Creators are structured JSON arrays with explicit roles. Do not introduce a
  normalized people-identity model without a separate durable decision.
- The input descriptor is preserved in `source_items.metadata.descriptor`.
  Bibliographic fields are also projected into normalized work/instance tables
  for lookup and relationships; this duplication is deliberate.
- Each value records `manual`, `extracted`, or `enriched` provenance. Automated
  operations never overwrite a manual value. Applying enriched data over an
  extracted value requires explicit user action.
- Stable IDs, not titles, URIs, paths, or filenames, define identity.

## Safe file and network intake

- File selection and path access stay in the main process. The renderer receives
  an expiring opaque UUID token plus safe metadata, never a local path.
- Metadata enrichment runs only in the main process through the Open Library,
  Google Books, and Crossref adapters. It supports global opt-out, timeout,
  cache, non-blocking failure, and a separate HTTPS allowlist for cover assets.
- Book metadata provider selection is persisted: automatic (Open Library then
  Google Books on empty results or failure), Open Library only, or Google Books
  only. Explicit selection never falls back to another catalog. Cache entries
  are isolated by provider selection; academic metadata continues using Crossref.
- An optional Google Books API key uses the desktop encrypted credential store.
  Settings expose only configured status and explicit save/remove actions. The
  key is sent only to the Google Books API, never to covers or other catalogs,
  and is excluded from logs and error messages. Credentialed requests must not
  follow redirects.
- Open Library catalog requests start at most once per second; concurrent
  identical JSON requests share one fetch. Open Library has a bounded 15-second
  request timeout, with sanitized timeout/DNS/connection diagnostics.
- Enrichment results are suggestions. Applying them is an explicit merge and
  cover files are copied into managed storage rather than hotlinked.
- Duplicate detection proceeds from URI/hash to type-specific title or
  identifiers. The user explicitly chooses to keep, update, or create a new
  version; imports do not silently discard or overwrite a possible duplicate.

## Containers and bibliography

- `Book`, `PeriodicalIssue`, and `AcademicPaper` may exist as catalog containers
  without a `documents` or `ingestion_runs` row.
- Container-aware Library, deletion, processing, search navigation, and
  Obsidian behavior must tolerate the absence of a document.
- Parent-child source relationships use `parentSourceItemId` and bibliographic
  links, never a title string alone.
- Supported processable hierarchies are `Book -> BookChapter`,
  `PeriodicalIssue -> StandaloneArticle`, and
  `AcademicPaper -> DocumentSection`. Lower levels may remain navigational
  `document_divisions` without becoming source items.
- Children inherit appropriate language and bibliographic context while
  retaining their own title, creators, pages, selectors, and identifiers.

## Structure authority and review

- Native source structure is authoritative when present: EPUB nav/NCX for EPUB
  and outline/page labels for PDF. Boundaries align to canonical converted
  Markdown. For PDFs without an outline, segmentation is derived from canonical
  Markdown; Docling blocks provide page/layout evidence but do not define
  offsets by themselves.
- Detected structure is a draft. The user reviews the content, boundaries,
  hierarchy, type, order, and processability before materialization.
- The UI exposes one concept—whether a division becomes a sub-item—even if
  internal persistence retains separate review/processability fields.
- Structure materialization is transactional and idempotent by division ID.
  Sibling order follows `document_divisions.position`.
- An original file belongs to the root and is stored once. Children store typed
  selectors and versioned Markdown derivations that trace back to the original.
- A document division is an editorial/navigation unit; a chunk is a technical
  search/AI unit. Never substitute one for the other.

## Import and processing semantics

Importing, structuring, and processing are distinct operations. An import must
remain useful without AI.

- Mandatory import work preserves the original, identifies metadata, converts
  and normalizes content, reviews structure where applicable, and materializes
  sources/documents.
- Optional processing is selected through the domain DAG in
  `packages/domain/src/hierarchical-ingestion.ts`. The effective plan includes
  prerequisites automatically and is persisted as an immutable snapshot.
- `import_only` creates no AI jobs. Interactive imports always show the plan
  before starting optional work. Non-interactive integrations default to import
  only and leave the source available for later processing.
- Unrequested stages are recorded as `skipped/not_requested`, not pending or
  failed.
- Matching for a batch waits until all selected atomic-note generation has
  completed so execution order does not bias discovery.

When descendants are selected, summarization, atomic-note generation, and note
matching run on processable children, not on the root's full content. A root may
have a small catalog document containing title, creators, metadata, and its
current aggregate summary for requested catalog embedding/graph work.

Root summaries are bottom-up aggregations of current, non-empty child summaries
in canonical order. Non-summarizable children do not block aggregation. Changes
to child summaries make the aggregate stale; history and input IDs/hashes remain
auditable. Aggregate summaries do not create duplicate root-level atomic notes.

## Retry, reingestion, and reviewed artifacts

- Library editing is addressed by source ID and an expected `updatedAt` value;
  stale editors and active processing prevent the save. Metadata edits do not
  queue AI work. Type and parent changes are outside the editorial update.
- Editorial content changes create a new document and its initial revision,
  with explicit `supersedesDocumentId` / `supersededByDocumentId` metadata links.
  Earlier documents, chunks, notes, assets and SourceSpans remain addressable.
  Current-document queries and evidence search exclude superseded documents.
  Source identity and the original file stay stable. Root-content edits do not
  silently rewrite materialized child boundaries; children are edited separately.
- A changed child marks ancestor summaries stale. Results from a superseded
  document cannot satisfy missing stages for its replacement. Successful summary
  generation clears the stale marker. Regenerating unrelated stages must not
  archive pending atomic notes.
- Saved processing presets contain names and requested stages only. Applying a
  preset preserves the current source selection, scope and regeneration policy.
  Presets are stored in application preferences and never execute work on save.

- Retry/resume continues the same run from checkpoints.
- Missing-stage execution reuses valid artifacts and runs only absent work.
- Reingestion is a new intentional run with new input hashes and a link to the
  superseded run.
- Reviewed or edited summaries, notes, relationships, and evidence are never
  silently overwritten or cascade-deleted. New content or structural boundaries
  create a document revision and new derived generations.
- Approved/rejected/user-edited notes remain attached to their original
  revision. Superseding pending notes requires an explicit policy and remains
  auditable.

## Required coverage

Changes in this domain cover descriptor parsing, provenance merge, duplicate
policy, container behavior, hierarchy validation/materialization, processing
plan dependencies, and preservation of reviewed artifacts as applicable.
