# AI runtime, models and prompts

Load for model providers, adapters, routing, parameters, local models, the AI
scheduler, embeddings, rerankers, structured output, prompts, or AI audit and
monitoring.

## Adapters and capabilities

- Application code calls AI only through `AiModelAdapter`. Provider SDK behavior,
  wire formats, streaming, cancellation, timeouts and error mapping stay inside
  adapters. Agent harnesses or SDKs never own canonical storage or bypass routing.
- Remote paths: Google Gemini, OpenAI-compatible endpoints and ChatGPT/Codex
  Responses through desktop OAuth (generative only). Local models are MLX-first:
  use the MLX implementation in the supervised Swift helper (macOS arm64) when
  one exists; GGUF through `node-llama-cpp` is the fallback when there is no MLX
  build or no Apple Silicon. Native runtimes never enter the renderer or
  external clients.
- A model declares only capabilities its actual adapter and runtime validated.
  Never infer a capability from the provider (for example, a generative model is
  not a reranker).
- A reranker or decider gets `decide` only after its artifact is validated (GGUF
  header, or MLX config and architecture) and a smoke test scores a relevant
  pair clearly above an irrelevant one (target F1a-F2).
- Canonical parameter names are owned by the domain; adapters translate them and
  never forward unknown keys. The model's parameter descriptor drives both the
  settings UI and runtime normalization.

## Routing

- Every AI task resolves its model through its route (explicit operation
  override first, then the task or workload-class route). An unavailable or
  incompatible model fails visibly; never fall back silently to another model.
- The routed or explicitly selected model determines where execution happens.
- The effective profile, model identity and parameters are pinned when work is
  admitted. Later settings edits affect new work only.
- Generated user-visible content uses the global content language, separate from
  the interface language. Internal identifiers, predicates, keys and enums stay
  English. Model-facing language names are full English names. Embeddings
  receive no language instruction.

## Scheduling and execution

- Local inference runs one call at a time per machine (app, scripts, helpers,
  tests), bounds its memory (e.g. the MLX buffer cache) so the host never swaps,
  and never loads two local generative models at once or starts a duplicate helper.
- Remote calls run with bounded concurrency per provider configuration and
  respect rate-limit signals. Interactive work is served before background work;
  a running call is never preempted (target F1a-F3).
- Every remote call has deadlines counted from execution start (connect, first
  byte, stalled stream, total). Retry only transient failures (timeouts, 408,
  425, 429, 5xx, network) with backoff and jitter, honoring `Retry-After`; never
  retry invalid requests, auth failures, context overflow or schema failures
  after the allowed repair (target F1a).
- Structured output is requested with a schema where the runtime supports it and
  is always validated with Zod. Invalid output gets a bounded repair; valid items
  are kept and only missing ones are requested again (target F3).
- Model output never supplies canonical IDs. Short aliases in prompts are
  resolved by the backend to real IDs and validated before persistence.
- Oversized requests are rejected before the provider call with a localized
  error; evidence is never silently truncated.

## Local models

- Catalog entries pin an immutable repository revision, explicit files, sizes,
  SHA-256 checksums, license, capabilities and memory/platform requirements.
  Imported GGUF files use their SHA-256 as the revision.
- Downloads use the managed model directory, resumable `.partial` files,
  preflight checks, progress, cancellation, checksum verification and atomic
  promotion. Optional repository tokens live in `safeStorage`.
- A model cannot be removed while loaded, running or required by an active
  route without an explicit replacement flow.
- Embedding models expose only embedding capabilities, validate requested
  dimensions and normalize vectors. Query and document inputs are distinguished;
  instructions apply to queries only. Changing embedding wording or serialization
  creates a new embedding space.

## Prompt catalog

- Every application-owned prompt (including fragments, repairs and adapter
  wording) lives in one catalog owned by `PromptService`, with immutable
  revisions, recoverable drafts and activation history.
- Templates use registered, typed `%variable_name%` placeholders rendered once.
  Variable-like text inside source material stays literal, untrusted data.
  Credentials are never variables. Unknown or missing variables block execution.
- Required output contracts are enforced by code. Editing prompt prose can never
  change permissions, source scope, identity or budgets.
- Saving or activating a prompt never reprocesses the library; it affects future
  admissions only.

## Audit and monitoring

- Every actual AI execution (generation, embedding, reranking, repair, test)
  records a canonical audit with provider, model, runtime, effective parameters,
  prompt revision and composition hash, token usage, duration, cost when known,
  status and the participating source IDs.
- Provider usage is normalized without double counting. Unknown tokens or cost
  stay absent and disclosed, never fabricated; no extra paid calls are made for
  telemetry. Budget gates use the rules in `security-privacy.md`.
- Monitoring entries are written independently of debug settings and never fail
  the underlying operation. Full capture follows `security-privacy.md`.
