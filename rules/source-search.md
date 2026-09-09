# Source and evidence search rules

Load this rule for Library queries, searching source content, evidence results,
semantic retrieval, or ranking. Load `rules/ai-and-knowledge.md` when changing
embedding execution, `rules/database.md` for SQL/vector storage, and
`rules/knowledge-graph.md` for graph extraction or traversal.

## Two retrieval contracts

| Surface | Entry point | Ranking and result unit |
| --- | --- | --- |
| Library browsing/search | `KnowledgeService.browseLibrary` → `libraryRepository.listSources` | Catalog sources, strongest signal plus agreement bonus |
| Evidence search | `SearchService.search` → `searchRepository` and `knowledgeGraphRepository` | Typed chunks, atomic notes, entities and relations; RRF for chunk/note candidates |

Keep these contracts distinct. Library search returns source cards; the
`entity` and `relation` discriminants belong to evidence search, not to the
Library repository result. Neither search path invokes generative reranking;
atomic-note matching has its own candidate fusion and optional reranker.

## Shared retrieval guarantees

- Text and vector rankings remain independently inspectable before fusion.
- Query embeddings use the routed embedding task with `embeddingInputType:
  "query"`; stored content uses document inputs. Accept only finite vectors of
  256, 768, or 1024 dimensions and query embeddings of the same model identity.
- Missing, invalid, or failed query embedding generation leaves textual
  retrieval available. Do not interpret this as a blanket SQL failure fallback.
- Return evidence and breadcrumbs appropriate to the result kind. Chunk results
  carry document ID, chunk ID, optional SourceSpan, page/block/bounding box and
  selector. Do not fabricate chunk IDs for notes or graph-element results.
- Chunk text/vector queries exclude documents marked `supersededByDocumentId`.
  Graph queries and note queries have their own eligibility predicates; do not
  infer uniform revision filtering across all result kinds.

## Library ranking

- The Library search combines its existing catalog match with a query embedding
  against current-model chunk and `source_item` embeddings. Source vector rank
  aggregates the best three current-document chunks, favoring the best chunk,
  and uses the composite source vector as a smaller supporting signal. A
  vector-only result must meet the calibrated standalone floor; a weaker vector
  may contribute only when text or an exact graph entity corroborates it.
  Ranking retains text, vector, and graph scores independently, favors the
  strongest signal with a smaller agreement bonus, and identifies which signals
  produced the match.
- Exact canonical graph entities and aliases promote their evidenced source in
  Library results. Cards show the best evidence excerpt when the match came from
  a chunk or graph element, call raw cosine output vector similarity rather than
  confidence, and flag sources that lack embeddings for the active model.
- Instruction-aware embedding models receive retrieval instructions on query
  inputs only; stored document, chunk, and source inputs remain document text.
  Calibrated Library floors are covered by a synthetic, versioned evaluation set;
  private real-library calibration corpora remain local.
- Catalog text matching checks accent/case-normalized title, subtitle, URI and
  descriptor text, with a minimum text score of 0.75 for a catalog match.
- The source embedding score uses `0.7 * bestChunk + 0.2 * meanTopThreeChunks
  + 0.1 * sourceVector`; divide by 0.9 when no source vector exists. If there
  are no chunk vectors, use the source vector alone.
- Current semantic floors are 0.48 for a standalone vector match and 0.40 for
  a vector match corroborated by catalog text or graph evidence.
- Ranking uses the greatest signal plus 0.15 times the remaining qualifying
  signals. This score is not a calibrated probability and may exceed 1.
- `matchKind` is `traditional`, `embedding`, `graph`, or `combined`.
  Evidence excerpts prefer graph evidence, then the best matching chunk.
  `embeddingNeedsRefresh` means neither a source vector nor a current chunk
  vector was found for the query model; it is not a guarantee of complete
  embedding coverage.
- An empty query browses without generating an embedding. `traditional` mode
  skips query embedding generation; relational graph matching remains part of
  the Library query.

## Evidence search ranking and scope

- The desktop IPC accepts `text` and `hybrid` modes. The broader domain
  `SearchQuerySchema` also declares `vector`; that does not expose a desktop
  vector-only search mode.
- Fetch text candidates in both modes and vector candidates only in hybrid
  mode when embedding generation succeeds. Candidate capacity per retrieval
  list is `min(300, max(50, limit * 3))`.
- Retrieve graph chunk candidates and directly matched entities/relations in
  both modes. Isolate the two graph calls so one failure does not suppress the
  other or block textual results.
- Fuse chunk lists by chunk ID, and note lists by note ID. RRF uses `k = 60`:
  sum `1 / (60 + rank)` over present signals and normalize by
  `activeNonemptyLists / 61`. Preserve the individual scores/ranks. Text-only
  lists without fusion retain their text score.
- Merge the resulting chunks, notes and direct graph elements by final score,
  then stable typed ID, and apply the requested limit. Direct graph elements
  retain their own score; do not describe them as RRF candidates.
- `rootSourceItemId` scopes every candidate query to the root and descendants.
  Apply source-type filters to all result kinds and attach breadcrumbs after
  selecting the final results.
- Current note text/vector queries exclude only `rejected` notes. Archived and
  superseded notes can therefore remain searchable, unlike the graph dashboard.
  A change to current-only note search must explicitly change these queries and
  regression coverage; do not assume dashboard filtering already applies here.

## Diagnostics and verification

- AGE retrieval failure contributes no graph rank and does not block evidence
  search or matching. Evidence result schemas serialize an absent graph signal
  as score zero; diagnostic ranks may be null. Library relational graph lookup
  is part of its SQL query and has no separate graph-error fallback.
- Debug capture is opt-in and off by default. Remote provider responses are not
  captured as full debug payloads. Local model payload capture follows
  `rules/security-and-privacy.md`.

Ownership: `apps/desktop/src/shared/ipc.ts` defines desktop inputs;
`packages/domain/src/search.ts` defines typed results; the services and
repositories in the table own execution. Library calibration constants live in
`packages/db/src/repositories/libraryRepository.ts` and synthetic cases in
`packages/db/src/repositories/__fixtures__/library-search-evaluation.ts`.

Run `search-service.test.ts`, relevant `knowledge-service.test.ts` cases, graph
repository tests, and `packages/db/src/repositories/repositories.test.ts` for
ranking changes. Extend coverage for changed mode/filter/failure semantics;
existing fusion and mocked SQL tests alone do not prove end-to-end retrieval
quality. Calibrate floor changes against the versioned synthetic cases.

## Wiki text consultation

The manual wiki uses the separate `WikiService.search` / `wikiRepository.search`
contract specified in `rules/second-brain.md`. Its stricter current/review filters
are enforced in SQL for every result kind and do not silently change the older
Library/evidence-search contracts above. Conceptual `source_relation` and
extracted `entity_relation` results have distinct identities and review semantics.

The optional cited-answer path uses `ConsultationService` and
`consultationRepository`, retaining the wiki scope/review/provenance boundary.
Its bounded independent signals, original-chunk fusion, full embedding identity
checks, context packing and no-matching contract are specified in
`rules/second-brain.md`; this does not change Library or legacy evidence-search
ranking.
