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
- Both file import entry points reopen the directory of the last selected file,
  persisted as a main-only preference across restarts. Canceling does not change
  it; missing/inaccessible directories fall back to the native dialog default.
  Preference persistence failures must not interrupt file selection or import.
- File preparation also returns an optional Zod-validated preview of the first
  20,000 characters of canonical converted Markdown with an explicit truncation
  flag. This is presentation evidence for metadata review; it does not replace
  the complete prepared conversion or create a document revision.
  Identifier extraction preserves detected DOIs before the user chooses a
  source type; choosing the type later must not require another conversion.
- Prepared files expose a read-only structure preview for books, academic papers
  and periodical issues before final import confirmation. Detection uses the
  complete prepared conversion and native file structure, cached per token/type;
  import reuses that detection and its stable division IDs. Preview requests
  neither create source records nor queue processing, and honor token expiry.
  The final import applies the reviewed divisions through the existing structure
  confirmation/materialization flow. Keeping a duplicate reviews its existing
  structure instead of replacing it with a new preview.
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

- Reprocessing unchanged catalog metadata must preserve its chunk and span IDs.
  Replacing identical chunks cascades to entity mentions, claims and graph
  evidence, even when the selected plan only requests embeddings or matching.

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
- Manual intake for hierarchical roots supports composing ordered chapters,
  articles, or sections as separate drafts. The drafts are serialized into
  canonical Markdown and pass through the same structure review and
  transactional materialization flow as detected file structure; they do not
  create a parallel persistence model.

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

- Import and edit wizard step headers are keyboard-accessible navigation. A
  later step is enabled only while all of its input and validation prerequisites
  are satisfied; fixed-context steps remain unavailable. File structure previews
  become available after conversion, before source creation or materialization.

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
- Knowledge-graph generation depends on chunking, not atomic-note generation.
  Selecting both stages generates and combines the source-chunk graph and the
  atomic-note graph.
- The embedding stage persists both chunk embeddings and one normalized
  `source_item` embedding. The source vector combines title, safe descriptor
  metadata, current summary, and segmented content; hierarchical roots combine
  their own catalog representation with the source embeddings of their
  processable descendants after those descendants run in the same batch.
- Editing source metadata or content, changing a summary, or making an ancestor
  summary stale invalidates the affected `source_item` embeddings so stale
  semantic results are never served as current.

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
- A successful atomic-note generation that returns zero notes is an artifact,
  not missing work. Reuse requires a recorded generation on the current document
  revision with matching content hashes and a completed, configured stage whose
  generated count is zero. Failed/unconfigured attempts and changed documents
  do not qualify. Explicit regeneration still reruns the selected stage.
- A completed, configured summary stage classified as `non_content` is likewise
  reusable for the same current revision and content hash. A `too_short` outcome
  remains subject to the current word-count policy rather than becoming a
  permanent content classification. Unconfigured attempts never qualify.
- Reingestion is a new intentional run with new input hashes and a link to the
  superseded run.
- Reviewed or edited summaries, notes, relationships, and evidence are never
  silently overwritten or cascade-deleted. New content or structural boundaries
  create a document revision and new derived generations.
- Approved/rejected/user-edited notes remain attached to their original
  revision. Superseding pending notes requires an explicit policy and remains
  auditable.

## Processing contract reference

`resolveProcessingPlan` owns dependency expansion and canonical stage ordering;
UI code and integrations must not maintain a separate DAG. Plan version is `1`.
For named presets the preset determines requested stages; only `custom` uses the
caller's `requestedStages` directly.

| Stage | Direct prerequisite |
| --- | --- |
| `conversion` | None |
| `structureDetection` | `conversion` |
| `structureReview` | `structureDetection` |
| `materialization` | `structureReview` |
| `chunking` | `materialization` |
| `embedding`, `summarization`, `atomicNotes`, `knowledgeGraph` | `chunking` |
| `organizeKnowledge` | `chunking` |
| `atomicNoteMatching` | `atomicNotes` |
| `sourceMatching` | `summarization`, `embedding` |
| `obsidianProjection` | `materialization` |
| `aggregateSummarization` | `summarization` |

- `search_ready` adds chunking/embedding to import; `summary` adds
  chunking/summarization; `full_knowledge` adds chunking, embedding, summary,
  notes, graph, note matching and source matching. Source matching has a
  collective barrier and root budgets defined in `rules/source-relations.md`.
  Projection and aggregate summarization are not
  explicit stages of `full_knowledge`; root aggregation is coordinated by the
  processing service/supervisor.
- Scopes are `source_only`, `children_only`, `source_and_children`, and
  `selected_items`. Child scopes expand descendants; a selected ancestor with
  a selected descendant is assigned catalog processing instead of duplicating
  descendant content processing.
- Artifact policies are `reuse_valid`, `regenerate_selected`, and
  `preserve_reviewed_archive_pending`. The last policy archives pending notes
  only during reingestion that includes `atomicNotes`. Same-document chunks
  remain reusable even when other stages are regenerated.
- The queue records a batch and runs even when there is no executable optional
  work; a run can complete with `jobId: null`. Container-only creation returns
  null document/run/job identifiers. Consumers must distinguish these cases.
- Structure review returns before queueing optional work. Confirmation saves,
  confirms and materializes the draft before queueing selected child processing
  and applicable root catalog work.

## Implementation boundaries and current limits

| Responsibility | Entry point |
| --- | --- |
| Descriptor and plan contracts | `packages/domain/src/source-descriptor.ts`, `hierarchical-ingestion.ts` |
| Intake, duplicates, original assets and bibliography | `apps/desktop/src/main/services/ingestion-service.ts` |
| Structure review, scope expansion and run creation | `apps/desktop/src/main/services/hierarchical-ingestion-service.ts` |
| Execution order, cancellation and collective barriers | `apps/desktop/src/main/services/job-supervisor.ts` |
| Structure transactions and artifact lookup | `packages/db/src/repositories/hierarchicalIngestionRepository.ts` |
| Run checkpoints | `packages/db/src/repositories/ingestionRunRepository.ts` |
| Conversion and chunk provenance | `packages/conversion/src/` |

For conversion details load `rules/conversion.md`; for execution/recovery load
`rules/jobs-and-processing.md`; for graph stages load `rules/knowledge-graph.md`;
for consumption of embeddings load `rules/source-search.md`.

The following boundaries describe current behavior rather than relaxing the
preservation and validation requirements above:

- Confirmation currently filters out `empty_range` validation issues, and
  materialization skips empty Markdown slices. Empty divisions therefore do not
  currently block confirmation or produce child sources. Changes to structure
  validation must reconcile this with the stricter acceptance rule above and
  cover the service and repository together.
- Artifact reuse currently consults `getArtifactState` for the current document
  and completed checkpoints. Do not assume that the full model/parameter/hash
  compatibility requirement in `jobs-and-processing.md` is automatically
  established by artifact existence.
- The supervisor owns ingestion orchestration. The minimal
  `workers/ingestion.worker.ts` acknowledgment is not the pipeline implementation.

## Required coverage

Changes in this domain cover descriptor parsing, provenance merge, duplicate
policy, container behavior, hierarchy validation/materialization, processing
plan dependencies, and preservation of reviewed artifacts as applicable.

Existing focused suites: `packages/domain/src/hierarchical-ingestion.test.ts`,
`apps/desktop/src/main/services/ingestion-service.test.ts`,
`apps/desktop/src/main/services/hierarchical-ingestion-service.test.ts`,
`packages/db/src/repositories/hierarchicalIngestionRepository.test.ts`, and
`packages/db/src/repositories/repositories.test.ts`. For transaction, hierarchy,
or persistence changes also use `npm run db:source-ingestion:verify` with a
configured test PostgreSQL instance; unit tests are not a substitute for it.

- Explicit `organizeKnowledge` selection stores topic/profile/privacy/domain options
  in the immutable plan and remains independent of all optional derivations. It
  is not added to existing named presets. Its separate cross-source batch run,
  terminal barriers and review contracts are specified in `second-brain.md`.

- Library and Obsidian editorial saves share `SourceEditorialService`. Normalize
  line endings only, preserving hard breaks, indentation, fences and trailing
  content. Projected body edits do not rewrite descriptor or bibliography fields,
  including legacy catalog records without a complete descriptor. Source revision
  timestamps advance by at least one millisecond so IPC timestamps remain valid
  optimistic revisions. Saving content creates no processing jobs.
