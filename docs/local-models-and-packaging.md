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

The source file is authoritative for exact revisions, sizes, and checksums.
Capabilities not validated by the actual helper/adapter, including multimodal
capabilities, are not exposed.

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
