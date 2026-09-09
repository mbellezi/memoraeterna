# Conceptual relationships between sources

Load for source matching, note-to-source relationship reuse, source relationship
review, or the conceptual source graph. Also load `ai-and-knowledge.md`,
`knowledge-graph.md`, `source-search.md`, and `database.md` for their boundaries.

## Meaning and evidence

- Resolve model source aliases in relation propositions/explanations before
  persistence to `<source-ref id="CANONICAL_SOURCE_ID" />` tags. Resolve only
  the validated semantic endpoints; never infer identity from alias numbers.
  Render source and target with numbered circular markers 1 and 2 and replace
  their tags with the same markers in displayed prose. Render as safe React
  nodes with consistent endpoint colors: cyan for marker 1 and violet for
  marker 2 in both headings and prose, retaining the numbers in all themes. Use
  no raw model HTML. Historical alias repair requires the original
  captured prompt and an unambiguous endpoint mapping; never guess from display
  order or sorted IDs.

- `source_relations` is canonical SQL. A relationship connects specific ideas in
  two different source roots, retaining its actual chapter/section endpoints and
  semantic direction. Multiple relationships, including the same type on distinct
  ideas, may connect the same sources. Structural hierarchy links are not semantic.
- Reuse exactly the atomic-note relation vocabulary. `mentions` and `related`
  are disabled for automatic generation by default. Relation types are not the
  open-ended predicates of the entity graph.
- Require important, durable conceptual content, original evidence from both
  owners, and explicit model validation. Shared topics/entities, events, names,
  dates, bibliographies and scores alone never create a relationship. Preserve
  attribution, conditions, negation and uncertainty. Zero output is valid.
- Note relationships are hypotheses until they pass the source criteria.
  Resolve their semantic endpoints from matching metadata, never sorted UUIDs.
  Exclude rejected relationships and rejected, archived or superseded notes.
  The current primary note evidence must belong to its source; never form a
  Cartesian product of sources cited by a synthetic note.
- Consolidate equivalent connections across note reuse and source analysis.
  Evidence occurrences retain their origin and snapshots; repeated passages and
  derivations from the same passage do not increase conceptual prevalence or
  automatically increase confidence. Similarity retrieves possible duplicates;
  existing source relationships are exclusion references during matching, never
  reranking or enrichment candidates. Omit equivalent results, including rejected
  ones, and do not charge identified existing results to the proposal allowance.
  Exclude note links already present in source-relation evidence before the
  reranking call. Distinct new ideas between the same sources remain eligible.
- Human review is independent of note review and uses optimistic timestamps.
  Preserve accepted/rejected relationships and reviewed propositions on reruns.
  Invalidated evidence remains inspectable; a relation loses its live edge when
  no current contribution remains. Currentness checks original content hashes,
  document supersession, and note/relation fingerprints at query time.

## Retrieval, generation and cost

- The `sourceMatching` processing stage prepares summaries and embeddings without
  requiring new atomic notes or entity-graph extraction. It is included in new
  `full_knowledge` plans. Existing immutable plans are not expanded retroactively.
- When the batch also requests atomic-note matching, wait for it as well as all
  selected summary, embedding and note stages. The last batch participant may be
  a catalog job. Deduplicate source roots before assigning analysis budgets.
- Summaries use `summary-v3`: request a readable summary and up to six conceptual
  propositions with original-chunk aliases per map batch in the same call.
  Resolve valid references into `source_summaries.metadata.concepts`; keep map
  concepts alongside the reduced summary. Legacy prose summaries remain usable;
  malformed conceptual references never become evidence. Summary preparation is
  separately audited from the bounded matching stage.
- Retrieve independent text, vector, canonical-concept and note-link rankings,
  fuse with RRF (configurable k, default 60), and interleave note-linked and other sources so every
  shortlist prefix reserves discovery capacity. Search summaries/concepts and
  chunks; composite source vectors are not the only semantic representation.
  Resolve selected subitems to their source roots and exclude that entire root
  from every candidate query before ranking or reranking, including sibling and
  nested subitems. Evidence from an external root may include multiple chapters,
  but those chapters must never be related to each other in the pair evaluation.
- Source/chunk vector comparisons require matching model, provider, runtime,
  dimensions and the full-space strategy identity. New ingestion vectors store
  `native-v2:<spaceKey>` and `source-composite-centroid-v2:<spaceKey>`; older vectors
  without that identity do not contribute to this matcher's vector signal.
  Selecting source matching refreshes incompatible embedding artifacts on the
  selected source. Embedding-space changes also invalidate pair-decision reuse.
- Select bounded original passages through lexical/concept and vector matches,
  together with note evidence. Avoid duplicating a parent's full document when
  processable child content exists. Summaries guide retrieval, never substitute
  for original evidence in a persisted relationship.
- The existing `reranking` profile route validates, classifies and orders source
  relationships in one bounded request per pair, with at most one repair.
  Use source/chunk/note/existing-relation aliases and validate ownership, type,
  direction, distinct roots, merge targets and output allowance in the backend.
  A failed model never falls back to a generic relationship.
- Source matching uses `source-relations-v4`. Prompts expose shared root aliases
  for chapters/sections and explicitly forbid same-root connections. A same-root
  rejection gives specific repair feedback. Upgrading a v1/v2/v3 checkpoint with
  otherwise unchanged configuration preserves spent budgets and completed work;
  the new prompt fingerprint invalidates old pair-decision reuse.
- Settings defaults per root and execution: 40 retrieved candidates, 8 evaluated
  pairs, 10 proposed relationships, 4 proposals per pair, 20,000 reported input
  tokens, importance 0.75 and evidence confidence 0.8. These are provisional
  cutoffs, not calibrated probabilities. Output generation has a bounded token
  override that cannot raise the configured maximum.
- Input budgets count only valid reported input tokens, including repair calls.
  Never estimate or reserve usage or shorten evidence to fit an estimated budget.
  Allow a call to exceed the limit; block the next call, including a repair, only
  when accumulated reported input tokens are strictly above the limit. Persist
  actual usage before validation or cancellation checks. Missing/invalid usage
  and interrupted calls without usage do not receive invented token charges.
  Record model runs and provenance through the AI service.
- Persist pair decisions, including negative results, keyed by current source,
  summary, note, model/configuration, language and prompt fingerprints. Changed
  inputs invalidate reuse. New executions reuse unchanged decisions; only the
  explicit force-regeneration or `regenerate_selected` artifact policy bypasses
  the decision cache.
- Persist per-root run budgets and recover the transaction/checkpoint gap without
  reissuing saved pairs or resetting proposal allowances. Cancellation preserves
  completed work. Exhaustion returns partial coverage and permits another
  processing execution to continue. Existing qualified relationships are not
  deleted to meet generation limits.

## Presentation and verification

- Processing progress reports completed and planned source-pair analyses in
  the progress bar/card and stage timeline, using persisted checkpoint counts.
  Plan bounded uncached pairs across selected roots before model execution and
  deduplicate reciprocal pairs. A repair is part of one analysis; a negative
  decision completes an analysis. Budget exhaustion, failure and cancellation
  never invent completed work. Retain partial totals across resume and publish
  individual counts only to the owning source-matching checkpoint. The batch
  barrier waits for prerequisites, then executes each source run sequentially
  with its own stage job, log context, counters, completion and failure. Never
  broadcast running/completed state or totals to sibling runs. Cards derive
  deferred source-matching status from that source's checkpoint, even if its
  ingestion job already finished earlier stages. Completed siblings remain
  completed while other sources run or fail. Collective summaries belong only
  to the batch header.

- Sources defaults to the conceptual projection; entity connections remain an
  explicit alternative. Both projections query canonical SQL independently of AGE.
- One visual edge groups a pair. Show up to three prevalent canonical relation
  icons using the atomic-note geometry/colors, with a unique leader 20% larger.
  Conceptual relation icons use the atomic-note progressive zoom reveal and
  density sampling in collapsed and expanded source hierarchies. Zooming out
  fades them to hidden and reduces marker size and spacing; zooming in restores
  them. Hover reveals incident markers and retains emphasis.
  Count distinct connections, not evidence occurrences. Keep ties stable and
  type counts intact when chapters collapse into their ancestors.
- Connection previews support compact cards or a stacked, scrollable relation
  panel with one connection per card, directed titles, origin, review state,
  original evidence and bounded pagination. Preserve the underlying graph and
  existing Back/Escape/focus behavior. Source details expose the same review list.
- Validate with source relation processing tests, graph projection tests, plan
  dependency tests and the isolated PostgreSQL verification script
  `packages/db/src/scripts/verify-source-relations.ts`. Verify populated upgrade
  and empty baseline, both origins, direction, stale evidence, review preservation,
  deduplication, vector-space isolation, pagination, rollback and checkpoints.

- Advanced source matching exposes the RRF constant (default 60), evidence
  passages per source in each pair (3), passage character limit (1000), summary
  character limit (1200), reused note relations per pair (6), and output token
  ceiling (4096, also bounded by the profile). These settings participate in
  configuration fingerprints and cache invalidation. Zero reused note relations
  leaves direct source discovery available. Input token budgets remain separate
  from output and all preparation/other-stage usage; UI copy must describe the
  reported-usage stop, including the possibility of one-call overshoot.

- Clarification requires explaining a substantive claim. Disambiguating unrelated
  homonyms or senses alone never creates a relation, and proper names must not
  be rewritten as abstract definitions. The note reranker follows the same rule.
