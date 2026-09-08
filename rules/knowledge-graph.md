# Knowledge graph rules

Load this rule for graph extraction, entities, claims, semantic relations,
source connections, AGE projection, or the graph dashboard. For model execution
also load `rules/ai-and-knowledge.md`; for SQL/AGE changes load
`rules/database.md`; for ranking changes load `rules/source-search.md`.

## Extraction and evidence

- Knowledge-graph generation always extracts entities, claims, and relations
  from the source chunks and their evidence. When atomic-note generation is
  also selected, a second extraction consumes the non-rejected atomic notes;
  both extractions are combined without requiring atomic notes for the source
  graph. Both paths use short evidence aliases that the backend resolves to
  real IDs after validation.
- Source-chunk graph extraction is capped per standalone document or processable
  subitem by user-configurable entity and relation limits (defaults: 250 and
  500). Every generation prompt receives the remaining allowance, and backend
  validation enforces the same caps before persistence.
- Entities, mentions, claims, relationships, and accepted atomic-note relations
  are canonical in SQL and retain evidence. AGE receives an idempotent
  projection and may contribute an optional ranking signal. Independently
  processed sources connect through reused canonical entities and the relations
  between those entities; each mention and relation retains its source evidence.
- The shared extractor accepts source chunks, atomic notes, or catalog metadata.
  Its current prompt version is `knowledge-graph-v7`. Its historical function
  name, `generateKnowledgeGraphFromAtomicNotes`, does not restrict it to notes.
- New semantic relations require a concise English snake_case `predicate`,
  preserving direction, negation, tense and modality, and a nonempty natural-language
  `displayLabel` in the global content language. Store the phrase and its
  `displayLanguage` in relation metadata; identity and control fields remain English.
  Graph batch keys include the prompt version and snapshotted content language.
- Data and Security offers missing-description generation and regeneration of all
  descriptions using the knowledge-graph model route. These operations preserve
  existing predicates (including legacy ones), relation IDs, endpoints, confidence,
  evidence and unrelated metadata; they do not regenerate source knowledge.
  Persist a job with its target language and creation cutoff. Process bounded batches,
  atomically saving labels with a job marker and model/prompt audit metadata so
  retry or restart skips saved batches. Support cancellation, progress and failures.
- Validate structured output: unique batch entity keys, known claim/relation
  endpoints, different relation endpoints, and evidence from the supplied input.
  Evidence aliases must resolve before persistence; model-produced identifiers
  are never canonical IDs.
- Batch prompts request at most 12 entities and 12 relations. The Zod response
  envelope separately allows 100 entities, 100 claims and 200 relations. These
  are different limits; the configurable source extraction cap is enforced
  across source batches, not independently for every prompt.
- The optional atomic-note pass currently has no source extraction cap. Do not
  describe the 250/500 defaults as a cap on the combined graph.
- Invalid structured output gets one repair attempt with validation feedback.
  Two invalid responses fail with `knowledge_graph_output_invalid:<code>`.
- Resume validated batches using content-derived batch keys and separate
  `source` / `atomic_notes` checkpoint namespaces. Persist batch progress in the
  ingestion stage so completed batches are not generated again on retry.

## Canonical persistence and projection

- Entity names are candidate-retrieval signals, never canonical identity. Homonyms
  of the same type may have distinct IDs. Extraction supplies a grounded English
  `identityDescription`; absent identifying facts must be stated as insufficient.
  Resolve candidates of the same type using names/aliases and model-specific vectors,
  followed by conservative LLM identity confirmation. Names or similarity alone never
  authorize reuse: people, organizations and places require shared distinguishing facts
  without conflicts; concepts require equivalent definitions. Ambiguity creates a new
  entity. Preserve canonical names, merge observed aliases, and retain strongest confidence.
  Exact source/evidence/identity fingerprints reuse previously validated decisions on retry.
  Source persistence upserts by the resolved entity ID; model output cannot provide that ID.
  Renderer grouping and relation-to-entity association use canonical IDs, so homonyms
  remain distinct in source details as well as graph previews.
- Relation types have stable IDs, concise English predicates, English definitions and
  confirmed aliases in SQL. Exact known predicates/aliases bypass AI. Unknown types
  retrieve a configurable number of candidates (default three) through exact cosine search over name plus definition;
  only explicit LLM equivalence authorizes an alias. Preserve direction, tense, negation,
  modality and specificity. Newly extracted types in the same batch are also compared.
  Occurrences retain evidence, display phrases and original predicates; existing historical
  relations are not rewritten by migration. Legacy entities participate in candidate lookup;
  this is prospective identity reuse, not a bulk merge of historical duplicates.
- Both confirmation stages reuse the knowledge-graph AI route and send bounded batches
  with configurable batch size (at most 12 inputs) and a prompt character target
  (default approximately 12,000). Candidate descriptions
  are included once per request. Output is only `{"matches":[["r1","c1"],["r2",null]]}`,
  with exactly one decision per input and only its supplied candidates. No prose or
  LLM-generated scores. Invalid output gets one repair; two failures stop persistence.
  Within-batch references point only backward, preventing identity cycles.
- Configurable relation-type and entity-identity similarity thresholds default to 0.92,
  a provisional retrieval threshold rather than a probability of correctness. Exact entity
  names/aliases are also candidates regardless of score, but still require confirmation.
  Unknown identities require the configured embedding route. Embeddings use separate
  256/768/1024 stores with provider/model/runtime/revision/parameter/strategy identity;
  missing vectors are rebuilt in bounded batches and never compared across model spaces.
- Catalog commits use transactions, advisory locks and optimistic revisions; concurrent
  changes cause bounded re-resolution. Canonical decisions precede extraction checkpoints,
  so restart reuses completed batches. Entity identity fingerprints handle retries before
  a checkpoint is saved. Model-produced canonical IDs are rejected. Relations whose two
  endpoints resolve to the same entity are omitted. Library reset clears the catalogs.
- `replaceSourceExtraction` transactionally replaces the source's mentions,
  claims, entity relations, and atomic-note entity links, retaining global
  entity identities. Current extraction rows are a replaceable snapshot, not
  immutable graph-generation history. Do not promise stable mention/relation
  IDs across regeneration or treat this as a reviewed graph editing API.
- Mentions and relations are inserted only for chunks owned by the source and
  copy the chunk's SourceSpan. Claims retain all evidence IDs in metadata and
  use the first evidence chunk for their primary link. Note/entity links derive
  from shared chunk evidence through `atomic_note_source_links`.
- Commit SQL before projecting into the AGE graph `memora_knowledge`. Projection
  failure returns `projected: false` and a diagnostic while retaining canonical
  extraction. Do not roll back successful extraction because AGE is unavailable.
- AGE traversal may discover shared/related-entity note candidates; common
  entities are downweighted by inverse entity frequency. There is no hidden SQL
  traversal fallback when AGE fails. Direct relational inspection and dashboard
  aggregation are separate supported queries and do not require AGE.

## Dashboard and interaction

- Every semantic relation display uses its stored natural-language description,
  including source details, search, graph previews and debug elements. When missing,
  show a localized pending-description message instead of the internal predicate.
  Atomic-note relation icons and their existing localized legend remain unchanged.
- The global knowledge-graph dashboard has separate source and atomic-note
  projections. Sources defaults to persisted conceptual source relationships;
  the alternative entity view aggregates shared entities and semantic entity
  relations. Load `rules/source-relations.md` for source matching and its display.
  Atomic-note edges use persisted, non-rejected note relations.
  Rejected, archived, and superseded notes are excluded from the dashboard.
  Lazy source-connection details include canonical entity IDs and semantic relation
  IDs, directed endpoints and predicates alongside grouped display strings; visual
  previews must never reconstruct graph identity by parsing those strings.
- Dashboard responses are bounded to 20,000 nodes and 50,000 edges. Source
  connection details are loaded separately and include descendant evidence;
  do not inflate the initial graph with every connection detail.
- Sigma/Graphology render the graph; d3-force layout runs in a renderer Web
  Worker with Zod-validated commands/events and finite coordinates. Layout and
  community assignments are presentation state, never canonical identity.
- Hover highlighting and information-card intent are independent: highlight
  after 100 ms of dwell and preview after 1 second of pointer inactivity.
  Suspend hover during interactions and dispose timers on teardown.
- Connection previews allocate one label row per relation sharing the same canonical
  source and target IDs in the same direction. Rows have stable ordering and screen-pixel
  spacing across zoom and hover; opposite directions use opposite sides of the edge.
  Labels stay upright along the edge and retain individual highlight/fade colors.
  Label layout never merges edges or changes arrows, picking identities or physics.
- Wheel motion is bounded and normalized across delta units; stop animation
  catch-up after background stalls. Dispose Sigma, workers, and animation work
  when leaving the view. Connection preview WebGL context loss is deferred
  until removed canvases retire, with a timeout fallback for hidden windows.

## Ownership and verification

| Concern | Implementation entry point |
| --- | --- |
| Extraction schemas and entity types | `packages/domain/src/graph.ts` |
| Prompt, validation, repair and batch keys | `apps/desktop/src/main/services/knowledge-processing.ts` |
| Source/note pass orchestration and projection result | `apps/desktop/src/main/services/knowledge-service.ts` |
| Ingestion checkpoint persistence | `apps/desktop/src/main/services/job-supervisor.ts` |
| Canonical extraction and AGE queries | `packages/db/src/repositories/knowledgeGraphRepository.ts` |
| Dashboard projections and lazy details | `packages/db/src/repositories/knowledgeGraphDashboardRepository.ts` |
| IPC response bounds | `apps/desktop/src/shared/ipc.ts` |
| Layout, physics, interaction and teardown | `apps/desktop/src/renderer/components/knowledge-graph-*.ts` |

Relevant changes must preserve the cases in `knowledge-processing.test.ts`,
`knowledge-service.test.ts`, both graph repository test files, and the renderer
`knowledge-graph-*.test.ts` suites. For WebGL/program/lifecycle changes also run
`npm run test:graph-webgl`. Mock repository tests do not verify real AGE behavior;
SQL/projection changes need the database verification required by `database.md`.

- Advanced matching exposes separate candidate limits for entity identities and
  relation types (default 3, maximum 20), confirmation batch size (default and
  maximum 12), and a prompt character target (default 12,000). A single input is
  retained intact even when it exceeds that target. These controls never bypass
  explicit identity/equivalence confirmation. Persist effective settings with
  accepted catalog decisions; configurable candidate limits reach SQL retrieval
  and within-batch candidate selection consistently.
