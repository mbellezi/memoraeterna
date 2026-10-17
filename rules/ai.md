# AI runtime, models and prompts

Load for providers, routing, parameters, local models, prompts or AI audit.

## Adapters and capabilities

- Application code calls AI only through `AiModelAdapter`. Provider SDK behavior,
  wire formats, streaming, cancellation, timeouts and error mapping stay inside
  adapters. Agent harnesses or SDKs never own canonical storage or bypass routing.
- Remote paths: Google Gemini, OpenAI-compatible endpoints and ChatGPT/Codex
  Responses through desktop OAuth (generative only). Local models are MLX-first:
  the MLX implementation in the supervised Swift helper when one exists and the
  host is macOS arm64, else GGUF through `node-llama-cpp`.
- A model declares only capabilities its adapter and runtime validated. Never
  infer a capability from the provider: a generative model is not a reranker,
  though the decision route (`reranking`) may take it as an explicit decider.
- A dedicated reranker serves the `decide` class only after this install validated its artifact (GGUF
  header, or MLX config and architecture) and a smoke test scored a relevant pair clearly above an
  irrelevant one; the result is stored with the model and re-checked when the artifact or runtime changes.
  A runtime-build change re-validates it and checks score parity; drifted scores leave it uncalibrated.
- Canonical parameter names are owned by the domain; adapters translate them and
  never forward unknown keys. The model's parameter descriptor drives both the
  settings UI and runtime normalization.

## Routing

- Every AI task resolves its model through its route: an operation override first, then the
  workload-class route the caller states, then the task route; that model decides where execution
  happens. An unavailable or incompatible model fails visibly; never fall back silently to another model.
- Missing routes are seeded only from profiles no less private than the default.
- Profile, model identity and parameters are pinned at admission; later edits affect new work only.
- Generated user-visible content uses the global content language, separate from
  the interface language. Internal identifiers, predicates, keys and enums stay
  English. Model-facing language names are full English names. Embeddings
  receive no language instruction.

## Scheduling and execution

- Local inference runs one call at a time per machine (app, scripts, helpers,
  tests), bounds its memory (e.g. the MLX buffer cache) so the host never swaps,
  and never loads two local generative models at once or starts a duplicate helper.
- Calls run in lanes: one local lane for every local runtime and one per remote provider
  configuration, with bounded concurrency that adapts to rate-limit signals. Interactive work is
  admitted first, background classes age so none starves, no call preempts a running one, a retry
  backoff never holds a lane, and a caller's timeout excludes its wait for a lane.
- Remote generation streams, so remote calls have deadlines from execution start (connect, first
  byte, stalled stream, total). Only progress (answer text, or reasoning text before it) keeps a
  stream alive, not bytes or lifecycle events, and unless high-reasoning or local a request must
  start answering within a bound of the first byte. Decide calls ask for no reasoning summary, so
  only that bound limits their thinking (a refusing backend gets the previous shape). Adapters
  retry only transient failures (timeouts, stalls, 408, 425, 429, 5xx, network) with bounded,
  jittered exponential backoff, honoring `Retry-After` or a stated reset (a long wait goes to the
  job); never invalid requests, auth failures, exhausted billing quota, context overflow or schema
  failures after the allowed repair. Job retries classify alike. Every runtime, local included,
  enforces a per-class deadline from execution start; a local call that ignores cancellation
  keeps its lane until the runtime is reloaded, and calls needing that lane fail meanwhile.
- Structured output is requested with a schema where the runtime supports it and
  is always validated with Zod. Invalid output gets a bounded repair; valid items
  are kept and only missing ones are requested again (target F3).
- Model output never supplies canonical IDs. Short aliases in prompts are
  resolved by the backend to real IDs and validated before persistence.
- Prompts are a function of content, not of IDs: aliases and the order of
  evidence, candidates and batches follow document position or a content key
  (title, text); an ID only breaks a tie between indistinguishable items.
- Oversized requests are rejected before the provider call with a localized
  error; evidence is never silently truncated.

## Local models

- Catalog entries pin an immutable repository revision, explicit files, sizes,
  SHA-256 checksums, license, capabilities and memory/platform requirements.
  Imported GGUF files use their SHA-256 as the revision.
- Downloads use the managed model directory, resumable `.partial` files,
  preflight, progress, cancellation, checksum verification and atomic promotion;
  repository tokens live in `safeStorage`.
- A model cannot be removed while loaded, running or required by an active
  route without an explicit replacement flow.
- Embedding models expose only embedding capabilities, validate dimensions and
  normalize vectors; instructions apply to queries only. Changing embedding
  wording or serialization creates a new embedding space.

## Prompt catalog

- Every application-owned prompt (including fragments, repairs and adapter
  wording) lives in one catalog owned by `PromptService`, with immutable
  revisions, recoverable drafts and activation history.
- Templates use registered, typed `%variable_name%` placeholders rendered once.
  Variable-like text inside source material stays literal, untrusted data.
  Credentials are never variables. Unknown or missing variables block execution.
- Required output contracts are enforced by code: editing prompt prose can never
  change permissions, source scope, identity or budgets. Saving or activating a
  prompt never reprocesses the library; it affects future admissions only.

## Audit and monitoring

- Every actual AI execution (generation, embedding, reranking, repair, test)
  records a canonical audit with provider, model, runtime, effective parameters
  and wire options, prompt revision and composition hash, token usage, duration,
  cost when known, status and the participating source IDs.
- Provider usage, billed failed attempts included, is normalized without double
  counting. Unknown tokens or cost stay absent and disclosed, never fabricated;
  no extra paid calls are made for telemetry. Budget gates: `security-privacy.md`.
- Monitoring entries are written independently of debug settings and never fail
  the underlying operation. Full capture follows `security-privacy.md`.
