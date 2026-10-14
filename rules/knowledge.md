# Knowledge pipeline

Load for sources and ingestion, conversion, Docling, chunks and SourceSpans,
summaries, atomic notes, relations, the knowledge graph, the topic tree, search,
Ask, or background maintenance (Gardener).

## Sources and ingestion

- `SourceItem` types are canonical; every ingestion uses a complete typed
  descriptor validated with Zod at preload and main-process boundaries.
- Metadata values record `manual`, `extracted` or `enriched` provenance.
  Automation never overwrites a manual value; enrichment results are suggestions
  applied explicitly.
- Duplicates are detected (URI/hash, then type-specific identifiers) and the
  user chooses keep, update or new version; imports never silently discard or
  overwrite.
- Catalog containers (book, periodical issue, paper) may exist without a
  document. Parent/child links use IDs, never titles.
- Native structure (EPUB nav/NCX, PDF outline and page labels) is authoritative
  when present. Detected structure is a draft reviewed before materialization,
  which is transactional and idempotent by division ID. A document division is a
  navigation unit; a chunk is a search/AI unit; never substitute one for the other.
- Importing stays useful without AI. The processing plan DAG has one owner in
  `@app/domain`; UI and integrations never keep a second copy.
- Interactive imports default to full knowledge processing when a writer route is
  ready, otherwise to searchable processing (chunks and embeddings, no generative
  AI). Non-interactive integrations use searchable processing. Import-only stays
  an explicit choice. Interactive imports then open the source (target F1a).
- Saving source content or metadata creates revisions and never starts
  generative AI work. Reviewed or human-edited artifacts are never silently
  overwritten or deleted by reprocessing.

## Conversion

- Web pages use Defuddle; PDF, Office, EPUB, OpenDocument and OCR images use the
  packaged Docling sidecar; textual formats use native converters; YouTube uses
  `youtubei.js`. Archives are extracted with byte, entry, depth, compression and
  path-traversal limits.
- Converters and structure detection never fetch remote resources a document
  references; EPUB/HTML hrefs and fragments resolve safely inside the archive.
- Every textual source becomes normalized Markdown with engine, version, options,
  hashes and warnings recorded. Never report success for empty, corrupt or
  low-coverage output, and never circumvent passwords or DRM.
- Docling runs offline over Zod-validated JSONL on stdin/stdout, exposes no
  port, never uses system Python, and cleans its temporary files.
- Chunks are always produced from the current normalized document, never from a
  summary; reprocessing is idempotent.

## Derived knowledge

- Summaries are versioned and traceable to source revision, model, prompt and
  input hashes; long sources use map-reduce over chunks.
- Atomic notes use validated structured output and link to their source, chunks
  and SourceSpans. Review status never gates automatic processing. Human edits
  mark a note protected and invalidate its embedding and dependents; they never
  start generative AI. Re-embedding is ordinary background work (target F1a).
- Repeated derivations of the same passage are not independent corroboration.
- Entities and semantic relations are canonical in SQL with evidence. Names are
  retrieval signals, never identity; identity reuse needs conservative
  confirmation and ambiguity creates a new entity. Graph extraction runs once per
  source (target F3).
- Human accept or reject decisions on relations are preserved across reruns and
  respected in both directions.

## Relations (target F1a-F3)

- Pipeline: retrieve candidates (vector, full-text, shared entities, fused),
  filter deterministically, decide P(related), assign type and direction only for
  accepted pairs, and write explanations later and only for persisted relations.
  No prose is generated for rejected candidates.
- Decisions store raw scores per direction separately from calibration, keyed by
  the input hashes and decider, so recalibration never re-decides.
- Relation types use one fixed vocabulary shared by notes and sources. Shared
  topics, names, dates or homonyms alone never create a relation; the relation
  must be supported by evidence from both endpoints.
- Source relations are derived from accepted note relations plus decider-confirmed
  discovery pairs, never from same-root pairs.
- Matching runs per source as soon as its notes exist; there is no batch barrier.

## Topic tree (target F2)

- The Topic Tree Engine owns AI-managed structure and is the single writer of AI
  topic parents. Placement is deterministic on embeddings; a decider is consulted
  only for ambiguous cases; LLMs only name topics and write prose.
- Every current note and root source is reachable from the root, each with one
  primary parent and a few secondary placements, with no cycles. Shape targets
  (fan-out, leaf size, depth) live in typed config and are enforced by
  rebalancing operations.
- Every structural operation is recorded in a reversible change-set. Stability
  controls (hysteresis, cooldown, churn budget) prevent thrashing. Human-created,
  pinned and protected nodes never move automatically.
- A topic and its index are one node. Its page is a deterministic map of content;
  prose overviews are written on demand with citations and a support check.

## Search and Ask

- One retriever (full-text, trigram, vector, fused by RRF) serves every search
  surface (target F5). Text retrieval works without AI; missing embeddings
  degrade explicitly.
- Results carry their evidence (chunk ID, SourceSpan, breadcrumbs); IDs are never
  fabricated. Scope and privacy filters apply before retrieval and before any
  provider call. Browsing and asking are read-only; saving is explicit.

## Background maintenance (Gardener, target F4)

- Maintenance runs as event- and threshold-driven tasks on the jobs table, never
  as calendar routines. One failed, rejected or waiting item never blocks others.
- Freshness depends only on content hashes. Saving settings or changing a model
  never invalidates coverage.
- Every applied change is a change-set with undo. Changes that touch human,
  pinned or protected content go to the Inbox for approval.

## Legacy wiki

- Legacy wiki, curator and maintenance code is frozen (minimal fixes only); its
  data handling follows `rules/data.md` (Legacy data).
