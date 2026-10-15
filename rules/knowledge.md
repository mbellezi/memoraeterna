# Knowledge pipeline

Load for ingestion, conversion, chunks and SourceSpans, summaries, atomic notes,
relations, the graph, the topic tree, search, Ask or maintenance (Gardener).

## Sources and ingestion

- `SourceItem` types are canonical; every ingestion uses a complete typed
  descriptor validated with Zod at preload and main-process boundaries.
- Metadata values record `manual`, `extracted` or `enriched` provenance.
  Automation never overwrites a manual value; enrichment is applied explicitly.
- Duplicates are detected (URI/hash, then type-specific IDs); the user chooses
  keep, update or new version; imports never silently discard or overwrite.
- Catalog containers (book, periodical issue, paper) may exist without a
  document. Parent/child links use IDs, never titles.
- Native structure (EPUB nav/NCX, PDF outline and page labels) is authoritative
  when present. Detected structure is a draft reviewed before materialization,
  which is transactional and idempotent by division ID. A document division is a
  navigation unit; a chunk is a search/AI unit; never substitute one for the other.
- Importing stays useful without AI. The processing plan DAG has one owner in
  `@app/domain`; UI and integrations never keep a second copy.
- Interactive imports and Library processing default to full knowledge when a
  writer route is ready, otherwise to searchable processing (chunks and
  embeddings, no generative AI); integrations use searchable processing.
  Import-only stays an explicit choice. A finished import opens its source.
- Saving source content or metadata creates revisions and never starts
  generative AI work. Reviewed or human-edited artifacts are never silently
  overwritten or deleted by reprocessing.

## Conversion

- Web pages and HTML files (rendered fragments without `html`/`body` included)
  use Defuddle, with the page text as the fallback; PDF, Office, EPUB,
  OpenDocument and OCR images use the packaged Docling sidecar; other textual
  formats use native converters; YouTube uses `youtubei.js`. Archives are
  extracted with byte, entry, depth, compression and path-traversal limits.
- Converters and structure detection never fetch remote resources a document
  references; EPUB/HTML hrefs and fragments resolve safely inside the archive.
- Every textual source becomes normalized Markdown with engine, version, options,
  hashes and warnings recorded. Never report success for empty, corrupt or
  low-coverage output, and never circumvent passwords or DRM.
- A source without text is never stored: file imports, captures and note imports
  refuse an empty conversion with `errors.conversion.emptyResult`, and the hash
  of empty content never identifies a duplicate.
- Docling runs offline over Zod-validated JSONL on stdin/stdout, exposes no
  port, never uses system Python, and cleans its temporary files.
- Chunks are always produced from the current normalized document, never from a
  summary; reprocessing is idempotent.

## Derived knowledge

- Summaries are versioned and traceable to source revision, model, prompt and
  input hashes; long sources use map-reduce over chunks.
- Atomic notes use validated structured output and link to their source, chunks and SourceSpans.
  They are active at birth with an AI-provenance badge (review is optional) and are embedded when
  created, so matching never meets a note without a vector. Human edits protect a note and
  invalidate its embedding and dependents; one embedding job rebuilds it, never generative AI.
  Approval invalidates no embedding, decision, explanation or evidence; only the frozen legacy wiki reads status.
- Repeated derivations of the same passage are not independent corroboration.
- Entities and semantic relations are canonical in SQL with evidence. Names are
  retrieval signals, never identity; identity reuse needs conservative
  confirmation and ambiguity creates a new entity. Graph extraction runs once per
  source over its chunks, for entities and relations; old claims are read-only.
- Human accept or reject of a relation survives reruns, in both directions.

## Relations

- The decider writes no prose; explanations are written on demand for a relation
  the owner opens, and cached. Filters before it are lossless (they drop only
  candidates no decider score could accept). A required decider that fails or
  decides nothing fails the note visibly, before its checkpoint.
- Decisions keep each direction's raw score, AI run and time apart from
  calibration, keyed by both notes' content hashes and the decider; a decided
  direction is reused with the decider that decided it. A generative decider
  judges each unordered pair once: its verdict answers the reverse direction
  (the type stays with the judged direction) and no row is written for the
  reuse; a reranker scores both directions (target F3).
- Relation types use one fixed vocabulary shared by notes and sources; type,
  direction and explanation are assigned only to accepted pairs. Shared topics,
  names, dates or homonyms alone never create a relation; the relation must be
  supported by evidence from both endpoints (target F3).
- Source relations come from accepted note relations plus decider-confirmed
  discovery pairs, never same-root pairs. Matching runs per source as soon as its
  notes exist, with no batch barrier (target F3).
- A relation's explanation is written only when the owner opens it, never in bulk or in the
  background, and cached for what it was written from (ideas, passages, type, direction, language).

## Topic tree (target F2)

- The Topic Tree Engine owns AI-managed structure and is the single writer of AI
  topic parents. Placement is deterministic on embeddings; a decider is consulted
  only for ambiguous cases; LLMs name topics in the content language and write prose.
- Every current note and root source is reachable from the root with one primary
  parent and a few secondary placements, and no cycles. Shape targets (fan-out,
  leaf size, depth) live in typed config and are enforced by rebalancing.
- Every structural operation is recorded in a reversible change-set. Stability controls (hysteresis,
  cooldown, churn budget) prevent thrashing. Human-created, pinned and protected nodes never move automatically.
- A topic and its index are one node. Its page is a deterministic map of content;
  prose overviews are written on demand with citations and a support check.

## Search and Ask

- One retriever (full-text, trigram, vector; RRF) serves every search surface
  (target F5). Text search needs no AI; missing embeddings degrade explicitly.
- Results carry their evidence (chunk ID, SourceSpan, breadcrumbs); IDs are never
  fabricated. Scope and privacy filters apply before retrieval and before any
  provider call. Browsing and asking are read-only; saving is explicit.

## Background maintenance (Gardener, target F4)

- Maintenance runs as event- and threshold-driven tasks on the jobs table, never
  as calendar routines. One failed, rejected or waiting item never blocks others.
- Freshness depends only on content hashes. Saving settings or changing a model never invalidates coverage.
- Every applied change is a change-set with undo. Changes that touch human,
  pinned or protected content go to the Inbox for approval.

## Legacy wiki

- Legacy wiki, curator and maintenance code is frozen (minimal fixes only); its
  data handling follows `rules/data.md` (Legacy data).
