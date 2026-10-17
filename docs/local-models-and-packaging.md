# Local models and desktop packaging

## Local runtimes

The desktop supports two local AI runtimes, both restricted to the main process
or processes it controls:

- GGUF through `node-llama-cpp` `3.19.0`;
- MLX through the Swift helper in `native/mlx-helper`, available on macOS arm64
  with MLX Swift `0.31.6`, MLX Swift LM `3.31.4`, and Swift Transformers
  `1.3.3`.

The MLX helper accepts versioned JSONL, loads only an already verified local
model directory, and emits progress/results as JSONL. It does not use Python,
install packages, or download weights. Cancellation and timeout terminate the
desktop-controlled helper.

Build and smoke the helper with:

```bash
xcodebuild -downloadComponent MetalToolchain # once for the Xcode installation
npm run mlx:build
npm run mlx:smoke
```

The project build compiles the Swift executable and generates the required
`mlx.metallib` from the official MLX Swift Xcode project. The smoke uses the same
adapter as the desktop. Set `MEMORA_MLX_MODEL_PATH` or pass
`--model-path <path>` when the model is not under the default development
userData directory.

## Audited catalog

`packages/ai/src/local-model-catalog.ts` fixes every repository revision, file,
size, SHA-256, license, capability, and platform/memory requirement. The current
catalog contains:

| ID | Runtime | Purpose |
| --- | --- | --- |
| `mlx-gemma-4-e4b-it-4bit` | MLX | Text generation |
| `mlx-gemma-4-12b-it-4bit` | MLX | Text generation |
| `mlx-qwen3-4b-instruct-2507-4bit` | MLX | Text generation |
| `mlx-qwen3.5-9b-4bit` | MLX | Text generation with validated on/off reasoning |
| `gguf-qwen3-embedding-0.6b-q8-0` | GGUF | Embeddings |
| `gguf-bge-m3-q8-0` | GGUF | Embeddings |
| `mlx-qwen3-reranker-0.6b` | MLX | Dedicated ranker (decide) |
| `gguf-qwen3-reranker-0.6b-q8-0` | GGUF | Dedicated ranker (decide), fallback |

The source file is authoritative for exact revisions, sizes, and checksums.
Capabilities not validated by the actual helper/adapter, including multimodal
capabilities, are not exposed.

## Dedicated rankers

Qwen3-Reranker-0.6B ships as two catalog entries, MLX bf16 safetensors (the official
`Qwen/Qwen3-Reranker-0.6B`, only the four files the helper loads) and the ggml-org Q8_0 GGUF.
Both declare `reranking` and nothing generative or embedding, take no generation parameters,
and need at least 1.5 times the peak resident memory measured while scoring (MLX helper 1,294 MB,
GGUF in process 1,562 MB; minimums 2 GiB and 2.5 GiB).

A ranker is *validated for decide* on install, and only then does it expose `reranking`:

1. The download (or the DEV seed) checks every file's size and SHA-256, and the artifact check
   follows: an MLX `config.json` must name `Qwen3ForCausalLM`, a GGUF header must be `qwen3`
   with rank pooling, a ranking head and the labels `yes`/`no`. A file that fails leaves the
   install `failed` with a localized error.
2. The model test (run automatically after the install, and by **Test inference**) scores the
   Qwen3-Reranker model card pair within one log-odd and requires a relevant passage to beat an
   irrelevant one by at least 0.5 log-odds in English and in Brazilian Portuguese. The language
   pairs use the `diagnostics.local_ranking` instruction from the prompt catalog.
3. A pass is stored in `local_models.metadata.decideValidation`: runtime, revision, artifact
   SHA-256, runtime build (the helper executable's SHA-256, or the node-llama-cpp and llama.cpp
   build) and the smoke report. The catalog sync turns it into the `reranking` capability;
   without it a ranker exposes no task, cannot be assigned to a profile and shows a hint on its
   card.
4. A failed test, a changed revision or artifact, and a removal void the validation and close the
   capability. The validation also carries the runtime build; the routed path that loads the ranker
   compares it (`isDecideValidationCurrent`) and asks for a new test when the build changed. A test
   that cannot run (another ranker in the ranker slot is running a call) reaches no verdict and
   changes nothing.
5. **Score parity (F3 D13).** A passing smoke test is followed by a score-parity run: the 64
   directed pairs of `packages/ai/src/ranker-parity-reference.json` (synthetic note text) are scored
   in a fixed plan (MLX 2 calls of 32 pairs at helper batch 16, GGUF 4 calls of 16) and stored in
   `decideValidation.parity`. The scores are compared with a baseline: the ones a calibration stored
   when it was fitted (`AiServiceOptions.rankerParityBaseline`, by model identity), else the first
   run of this install, which is kept as the baseline so a series of small drifts cannot each pass
   against the one before. The largest difference over the 64 pairs must stay within 0.125
   log-odds. Beyond it the ranker keeps its validation but is **uncalibrated**: its row shows
   `errors.localModels.rankerUncalibrated`, `AiService.rank` (the topic gate's calibrated scores)
   refuses it so the gate takes its no-decider path, and `AiService.rankPairs` still scores with
   `uncalibrated: true`, which the relation decider reads as suggest-only.
6. **Re-validation after a runtime-build change.** `LocalModelService.start` compares the runtime
   build every validated ranker would run on with the build its validation names and, for each one
   that changed (a rebuilt or packaged helper, a node-llama-cpp upgrade), runs the model test in
   the background: the smoke test and the parity run. The ranker is unavailable to decide callers
   from the moment a validation is requested until it ends; they take their no-decider path instead
   of waiting for the local lane. Golden runs and AI cassettes never re-validate (no live model).
   A ranker validated before the parity check existed has no baseline until a calibration supplies
   one or its next validation records one.

Every rank call of the test is audited as a `reranking` task run with the evaluated tokens and no
cost. The models screen filters by purpose (text generation, embedding, reranking).

### Routing and residency (F2 D18)

Rank calls (`AiService.rank`) resolve the operation's `op:<operation>` route, else the
`class:decide` route; they never use the `reranking` task route, which carries the prompts of note
and source matching, and note matching never resolves `class:decide`. A profile that holds a
validated ranker seeds `class:decide` (the MLX ranker first on macOS arm64, else the GGUF one);
`class:write-fast` is seeded from the writer (summarization) route when it writes structured
output. No route, a model that is not a dedicated ranker, or a validation that does not hold for the
artifact and runtime build fails visibly, never with a generative fallback. `decideRouteStatus`
answers the same question without loading the ranker.

`AiService.rankPairs` (F3 D16) scores independent directed pairs under one instruction for the
relation decider. It splits a list at the routed runtime's `rankPairsLimits.perCall` (MLX 32, GGUF
16), each call taking the local lane on its own so an interactive call waits for at most one, audits
every call on its own row, and carries the MLX helper batch size (default 16) in the request's
`parameters`, which the cassette key and the decider cache key include. The `{query, documents}`
request of the topic gate is unchanged byte for byte, so recorded gate entries keep their keys.

`AiService` keeps one generative, one embedding and one ranker model resident, so a gate call
between two embedding calls reloads neither; loading another generative model releases the first.
The job supervisor's idle release never releases the ranker. Every MLX adapter shares one helper
process; the helper has no unload command, so releasing an idle MLX model stops it once no MLX call
runs, and a resident MLX ranker loads again on its next call.

### DEV seed

`MEMORA_LOCAL_MODEL_SEED_DIR` (absolute, or relative to the workspace root) names a folder of
artifacts already fetched into `.cache/models` (`scripts/spikes/models.json`). For a catalog entry
with a seed folder (`qwen3-reranker-0.6b-mlx`, `qwen3-reranker-0.6b-q8_0-gguf`), a pinned file
found there with the declared size is cloned into the managed directory instead of downloaded and
verified against its SHA-256 like any download. A seeded file whose bytes differ from the pin fails
the install; it never falls back to the network. Packaged builds refuse the variable.

### DEV install at startup (F2 T22c)

A measurement profile cloned from the owner's DEV profile has no ranker, so the topic placement gate
(`class:decide`) never decides and notes wait at the root. Installing one normally needs the Settings
screen; `MEMORA_LOCAL_MODEL_INSTALL=<catalogId>[,<catalogId>...]` does it at startup from the seed
folder. It needs `MEMORA_LOCAL_MODEL_SEED_DIR` and is refused (one `MODEL_INSTALL refused` log line,
then ignored) in a packaged build, without the seed folder, or with a malformed value. Only the catalog
entries with a seed folder can be named (`mlx-qwen3-reranker-0.6b`, `gguf-qwen3-reranker-0.6b-q8-0`);
an unknown id, or one without a seed folder, is refused on its own line and the rest go on. The folder
layout is `<seed dir>/<seed folder>/<pinned files>`, the one `.cache/models` already has.

Once the local models have started (a golden run or pilot waits for it), for each id in order:

1. a model that is not installed is installed through the normal install path
   (`LocalModelService.installFromSeed`): the seed folder must hold every pinned file at its declared
   size, or nothing is installed and nothing is downloaded; sizes and SHA-256 are verified as for any
   download, the ranker's artifact checks and its decide validation (the model test) follow, as after a
   Settings install;
2. an installed ranker that is not validated runs the same model test;
3. a validated model that no active profile holds gets the profile the Settings flow creates: a
   profile named `<display name> (<RUNTIME>)`, offline only, output language `ui`, that is the default
   one only when it is the first profile, with the model and the capabilities the model exposes;
   saving it seeds the missing routes, so `class:decide` takes the validated ranker (the MLX one first);
   an existing route is never changed.

It is idempotent (an installed, validated, held model is "left alone") and never touches a remote
provider. Each model gets one log line: `MODEL_INSTALL <id>: installed from the seed folder, validated
for decide, profile "..." created, class:decide ready`, or `left alone: ...`, or `failed: ...` with the
reason. A failed model never keeps the app from starting. The validation scores real pairs on the local
ranker, so run the start without `MEMORA_AI_CASSETTE`. `npx tsx scripts/topics/env-profiles.ts recipe`
prints the start as the optional first step of each measurement profile.

```sh
MEMORA_USER_DATA_DIR=<repository>/.cache/profiles/env-f \
MEMORA_WORKSPACE_ROOT=<repository> \
MEMORA_LOCAL_MODEL_SEED_DIR=<repository>/.cache/models \
MEMORA_LOCAL_MODEL_INSTALL=mlx-qwen3-reranker-0.6b \
MEMORA_SMOKE_AUTO_QUIT_MS=5000 \
npm run dev -w @app/desktop
```

## Download and storage

Managed models live under `userData/local-models/<catalog-id>`. The downloader:

- checks platform, memory, and free disk space;
- sends an optional Hugging Face token only as an authorization header;
- uses `.partial` files and HTTP Range resume;
- persists jobs, file position, byte progress, speed, ETA, and checkpoints;
- verifies size and SHA-256 before atomic promotion;
- resumes interrupted downloads after restart;
- removes only within the managed directory and blocks removal while a model is
  loaded, running, or required by an active profile.

Repository tokens live in `safeStorage`. Existing GGUF files may be imported
into managed storage; their SHA-256 becomes the immutable local revision.

Library reset preserves installed model files and model records while removing
library data, derived artifacts, registered managed copies, and registered
Obsidian projections.

## Backup and operational limits

Settings can create a backup containing a custom-format `pg_dump` and the
configured managed Obsidian/upload folders.

| Variable | Default |
| --- | ---: |
| `MEMORA_MAX_IMPORT_BYTES` | 512 MiB |
| `MEMORA_DOCLING_TIMEOUT_MS` | 300000 ms |
| `MEMORA_DOCLING_MAX_OUTPUT_BYTES` | 256 MiB |
| `MEMORA_DOCLING_MAX_PAGES` | 500 pages |

## Desktop package

Prepare reproducible resources with:

```bash
node scripts/prepare-desktop-resources.mjs
```

Staging copies migrations, baseline, PostgreSQL, the offline Docling runtime,
the MLX helper and Metal library into `apps/desktop/build-resources`. It writes
`runtime-manifest.json` with file hashes and `sbom.spdx.json` with native/Python
package and model data. Staging fails if a required target artifact is missing.

Build and validate an unpacked application:

```bash
npm run package:desktop:dir
npm run package:desktop:smoke
```

Build macOS distribution artifacts:

```bash
npm run package:desktop:mac
```

The current materialized target is macOS arm64. Distribution requires manifest
validation, signing, notarization, and a clean install on a machine without
system Python. Credentials remain outside the repository. Other platforms need
equivalent PostgreSQL/AGE, Docling, native AI artifacts, and smoke coverage.
