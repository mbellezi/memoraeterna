# AI and derived knowledge rules

Load this rule for model providers, profiles, parameters, local models,
embeddings, summaries, atomic notes, knowledge graph, matching, or search.

## Adapter and capability model

- Application code invokes AI through `AiModelAdapter`; provider SDK behavior
  stays inside adapters.
- Current remote paths are Google Gemini, generic OpenAI-compatible endpoints,
  and ChatGPT/Codex Responses through desktop OAuth. ChatGPT/Codex OAuth is
  generative only; embeddings use a compatible API-key provider or a local
  embedding model.
- GGUF uses `node-llama-cpp`; MLX uses the supervised Swift helper on macOS
  arm64. Native runtimes never enter the renderer or external clients.
- Each model declares only capabilities the actual adapter/runtime has
  validated. Generative, embedding, and reranking models are registered and
  displayed according to real capabilities, not provider-wide assumptions.
- Adapters normalize loading, execution, streaming, cancellation, progress,
  timeouts, and errors.
- All inference passes through one FIFO execution queue in the main AI service,
  allowing exactly one active request across sources, batches, tasks, profiles,
  providers and local/remote models. This includes embeddings, generation,
  reranking, repairs and local-model tests. Waiting requests do not begin model
  loading or AI execution telemetry. Cancel queued work without invoking the
  model; release an active slot only when execution settles, including failure
  or cancellation. Network discovery and non-inference processing remain separate.
- Model adapters and agent harnesses are separate boundaries. Future wiki
  harnesses must invoke application services through bounded tools and retain
  existing privacy, evidence, review and job-audit rules. A provider SDK may be
  implemented behind `AiModelAdapter`; it must not own canonical storage or
  bypass task routing. No external harness runtime is selected by this decision.

## Models, profiles, and parameters

- Each profile references exactly one remote or local model and defines privacy
  mode and task-specific overrides.
- Each AI task has a persisted profile route. The single default profile is a
  fallback only when no explicit route exists. Validate required capabilities
  before execution.
- Model configurations own defaults. `ai_profile_tasks.parameters` owns only
  profile/task overrides.
- Effective precedence is safe internal defaults, then model defaults, then
  profile/task overrides. The safe internal `maxTokens` for profile-driven
  generative tasks is `16384`.
- Canonical parameter names are `contextWindow`, `temperature`, `maxTokens`,
  `reasoningLevel`, `reasoningMaxTokens`, `topP`, `topK`, `presencePenalty`,
  `dimensions`, and `seed`. Adapters translate them and never forward unknown
  internal keys by object spread.
- The adapter/model parameter descriptor controls both UI fields and runtime
  normalization. Expose only supported reasoning levels and expose
  `reasoningMaxTokens` only when the engine implements a separate budget.
- Global `app.preferences.contentLanguage` controls generated user-visible content,
  independently of the interface and AI profile. On first launch, both languages
  initialize from the supported OS locale, with English fallback; existing
  preferences without contentLanguage inherit their saved interface language.
  Persist the initial selection; subsequent changes are independent. Supported
  values are `en`, `pt-BR`, `it`, `fr`, and `es`. Legacy profile outputLanguage fields
  remain readable but no longer override generation. Apply language instructions
  only to generative tasks. Internal identifiers, relation predicates, keys and
  enums remain English; embeddings receive no language instruction. Existing
  content changes only through regeneration.

Every task run records effective parameters, profile, model, provider, runtime,
prompt version where applicable, input/output tokens, duration, estimated cost,
status, and all participating source IDs.

AI execution also publishes independently prunable monitoring telemetry with
provider token breakdowns and precise call context, as specified in
`rules/monitoring.md`. Local-model output is no longer dumped to the console.

## Local models

- Catalog entries use immutable repository revisions, explicit files, sizes,
  SHA-256 checksums, licenses, capabilities, and memory/platform requirements.
- Downloads use the managed model directory, resumable `.partial` files,
  preflight checks, progress, cancellation, retry, checksum verification, and
  atomic promotion. Optional repository tokens live in `safeStorage`.
- Models cannot be removed while loaded, running, or required by an active
  profile without an explicit replacement flow. Imported GGUF files use their
  SHA-256 as an immutable local revision.
- Embedding models expose only `embedding` plus applicable local/offline
  capabilities. Use the runtime's embedding API, validate requested dimensions,
  and normalize vectors.
- Local embedding models remain resident after first use until application
  shutdown by default. An AI setting may opt out, in which case the idle runtime
  is released after embedding work completes.

## Derived knowledge

- Summaries are versioned and traceable to source revision, model/profile,
  prompt, and input hashes. Long sources use map-reduce over source chunks.
- Summary map calls also produce grounded conceptual facets for source matching,
  as specified in `rules/source-relations.md`. Source matching reuses the
  reranking route, with separate per-root budgets and no unvalidated fallback.
- Automatically generated atomic notes start as `pending_review`, use validated
  structured output, and link to source, chunks, and SourceSpans.
- Graph extraction, canonical persistence, projections, and dashboard contracts
  are defined in `rules/knowledge-graph.md`; load it when changing those areas.
- Graph canonicalization uses the embedding route for retrieval and the graph-generation
  route for compact batch confirmation. Internal relation definitions and entity identity
  facts are always English. User-visible descriptions keep the global content language.
  Record embedding and confirmation runs with source IDs and effective model parameters;
  persist the threshold, model-space identity and accepted decision with the catalog.
- Atomic-note matching retrieves independent text, vector, metadata, and
  optional graph candidates, combines them with the implemented RRF policy,
  optionally reranks one batch per note, applies the configured threshold, and
  persists only qualified canonical relationships with their signals.
- Generated content never silently overwrites human-reviewed artifacts.
- Atomic-note matching v6 requires a concise, nonempty explanation (at most 700
  characters) for every reranked candidate in the content language. Persist the
  model explanation with qualified relations. Resolve source alias s1 and the
  evaluated candidate alias to canonical `<note-ref id="UUID" />` tags before
  persistence; reject other aliases and model-supplied reference tags. Preserve
  semantic identity independently of sorted storage endpoints. Existing relations
  are not automatically regenerated by this prompt upgrade.

## Search and related rules

- Load `rules/source-search.md` for Library search, evidence search, ranking,
  result contracts, and retrieval degradation.
- Load `rules/source-ingestion.md` for source/chunk embedding construction and
  invalidation, and `rules/jobs-and-processing.md` for generation checkpoints.

## Matching calibration controls

- Matching presets snapshot all three thresholds plus atomic-note, canonical
  identity/type and source matching settings. They do not change AI profiles,
  routes, languages or extraction settings. Store custom presets and their active
  identity together with effective settings in `app.preferences`; validate unique
  UUIDs, names, complete snapshots and the selected preset before a single write.
- The built-in `recommended-v1` preset is immutable and uses the frozen benchmark
  values in `packages/domain/src/matching-presets.ts`: note threshold 0.60,
  retrieval 20/20/10, shortlist 20, graph reserve 3; source candidates 30, pairs 6,
  importance 0.85, confidence 0.80, input ceiling 60,000 and economy evidence
  limits. New installations select it. Existing different effective settings are
  preserved as a custom preset; matching values already equal to the recommendation
  select the built-in. Persist this compatibility initialization on the next write.
- Duplicates have independent identities and snapshots. Editing or renaming a
  custom preset retains its identity; switching applies its complete snapshot.
  New custom presets start from the built-in recommendation. Custom presets may
  be deleted, while the built-in preset remains immutable and undeletable.
  Direct legacy settings updates synchronize the active custom snapshot or create
  a custom copy, never modifying the built-in. Serialize preference writes.
  All matching resets use the recommended snapshot, including individual weights,
  booleans and numeric limits. Low-level schema defaults remain compatibility
  fallbacks, distinct from the versioned UI recommendation.

- Advanced matching settings are validated in `packages/domain/src/matching-settings.ts`
  and persisted in application preferences. Missing fields load canonical defaults.
  Snapshot effective settings in note-relation metadata and similarity diagnostics.
- Note retrieval exposes independent text/vector/graph limits (30/30/20), fused
  candidate limit (30, maximum 100), graph-only reservation (5), and RRF constant
  (60). Zero graph candidates disables that signal. Reservation cannot exceed
  the fused shortlist. The reranking envelope accepts the same maximum of 100.
- Base weights are configurable separately for the four available-signal groups.
  Normalize each group by its positive weight sum; all-zero groups are invalid.
  The AI share defaults to 0.4, with remaining weight assigned to the base score.
- Note persistence requires the final threshold and, when an AI result exists,
  a strictly positive validation score meeting the separate minimum (0.65).
  Other signals cannot override an AI rejection. Successful AI validation is
  required by default; unavailable/invalid reranking fails the stage visibly.
  Generic `mentions`/`related` types are disabled by default, independently from
  source matching. Explicitly disabling required validation only permits fallback
  when its type and score satisfy the other configured gates.
- Exclude already persisted note pairs, including reviewed/rejected ones, before
  reranking and do not consume their generation allowance or overwrite them.
  Persist up to the configured number of new pairs per note and execution (10),
  ordered by final score with stable ID ties. This is not a total graph-degree cap.
  Reranking has a configurable output limit (4096) bounded by the profile maximum.
- The versioned synthetic DEV pilot lives in `scripts/fixtures/matching-pilot.json`.
  Expected ideas and relationship labels never enter AI prompts. The explicit
  unpackaged DEV runner uses normal ingestion services and the existing AI routes,
  requires an empty library on first preparation, resumes its saved manifest,
  and never resets a library automatically. Reports retain settings, models,
  candidates, evidence, token availability and separate stage usage. Its reported
  token stop may overshoot by in-flight work; it is not a guaranteed provider cap.
  Pair-level screening labels never substitute for semantic/evidence review.

- An explicit DEV pilot rematch may replace only the manifest's unreviewed
  synthetic matching relationships and decision caches after successful baseline
  completion and a full backup. Refuse unrelated source IDs, active ingestion or
  reviewed relationships. Preserve canonical source/note/summary/entity data,
  profiles, the original audit, and the accumulated token allowance. Rebuild the
  AGE projection from canonical data before the new matching pass. This is a
  test-only workflow, never an automatic library cleanup.

- The expanded synthetic benchmark keeps 40 tuning roots (including the pilot)
  and 20 held-out roots in `scripts/fixtures/matching-benchmark.json`. Holdout
  content is not imported until the chosen settings and training-result hash
  are frozen. Candidate/context presets share acceptance and identity safeguards.
  Warm all selected note embeddings before comparisons, snapshot canonical
  extraction, and verify its preservation across matching-only passes. Back up
  each reset and require the exact fixture source-ID set; retain the pilot
  configuration separately. Accumulate reported usage across preparation,
  comparisons and validation under the explicitly authorized experiment limit.

- Organization uses an explicit pinned profile through the same `AiService`
  inference queue. It records a canonical AI task and organization-step link
  atomically. A queued run keeps its original effective model parameters and
  content language after settings edits. Recheck immutable provider/model,
  endpoint, runtime/revision and privacy compatibility before adapter creation;
  revoked or incompatible identity fails visibly. A local-only run or profile
  cannot invoke a remote adapter or use a fallback profile.

- Runtime and validation work must never load two local generative models or
  duplicate real helper instances simultaneously. The resource ceiling is one
  local generative model plus one embedding model, including across DEV and
  standalone test processes. Dispose the active generative runtime before
  switching real local models. Deterministic model mocks do not load runtimes.

- Cited consultation and its optional query embedding use the existing FIFO and
  adapters. The explicit query privacy applies to embedding admission as well as
  generation; ineligible embeddings degrade to text. Organization/consultation
  callers can revalidate scoped evidence inside FIFO admission and immediately
  before adapter execution. Explicit answer saves reference existing canonical
  AI audits instead of creating duplicate inference or billing records.

- The local resource ceiling applies universally across the application, standalone
  scripts, helpers and real-model trials: exactly one local inference execution
  at a time, including embeddings. Keeping one generative model and one embedding
  model resident does not authorize concurrent inference. Real model comparisons
  run sequentially through the shared application FIFO; never start a duplicate
  helper/runtime to accelerate a test.
