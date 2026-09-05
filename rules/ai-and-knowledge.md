# AI, search, and knowledge rules

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
- Model adapters and agent harnesses are separate boundaries. Future wiki
  harnesses must invoke application services through bounded tools and retain
  existing privacy, evidence, review and job-audit rules. A provider SDK may be
  implemented behind `AiModelAdapter`; it must not own canonical storage or
  bypass task routing. No external harness runtime is selected by this decision.

## Models, profiles, and parameters

- Each profile references exactly one remote or local model and defines privacy
  mode, response language, and task-specific overrides.
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
- Profile response language defaults to `ui`, otherwise one of `en`, `pt-BR`,
  `it`, `fr`, or `es`. Apply language instructions only to generative tasks and
  preserve structured-output keys/schemas. Embeddings receive no language
  instruction.

Every task run records effective parameters, profile, model, provider, runtime,
prompt version where applicable, input/output tokens, duration, estimated cost,
status, and all participating source IDs.

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

## Derived knowledge

- Summaries are versioned and traceable to source revision, model/profile,
  prompt, and input hashes. Long sources use map-reduce over source chunks.
- Automatically generated atomic notes start as `pending_review`, use validated
  structured output, and link to source, chunks, and SourceSpans.
- Knowledge-graph generation consumes non-rejected atomic notes and their
  evidence, not the full source document. It uses short evidence aliases that
  the backend resolves to real IDs after validation.
- Entities, mentions, claims, relationships, and accepted atomic-note relations
  are canonical in SQL and retain evidence. AGE receives an idempotent
  projection and may contribute an optional ranking signal.
- Atomic-note matching retrieves independent text, vector, metadata, and
  optional graph candidates, combines them with the implemented RRF policy,
  optionally reranks one batch per note, applies the configured threshold, and
  persists only qualified canonical relationships with their signals.
- Generated content never silently overwrites human-reviewed artifacts.

## Search

- Text and vector rankings remain independently inspectable before fusion.
- Search results include source item, document/revision, chunk, SourceSpan,
  scores, and evidence. Hierarchical child results include breadcrumbs to the
  root; a root filter may include descendants.
- Graph failure omits graph rank/score and does not block search or matching.
- Debug capture is opt-in and off by default. Remote provider responses are not
  captured as full debug payloads. Local model payload capture follows
  `rules/security-and-privacy.md`.
