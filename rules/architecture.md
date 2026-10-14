# Architecture, runtime and packaging

Load for new apps or packages, dependency direction, IPC/preload/main/worker
boundaries, background jobs, repository structure, sidecars, native runtimes,
packaging, signing or development application testing.

## Runtime topology

```txt
Renderer -> typed preload API (window.app) -> Zod-validated IPC
  -> main-process application service -> repository / worker / sidecar
  -> PostgreSQL sidecar
```

- The Electron desktop main process is the only owner of PostgreSQL, privileged
  filesystem access, secrets, native runtimes, sidecars, workers and the
  Integration Gateway.
- The renderer owns presentation and interaction only. It never imports
  Electron main code, `@app/db`, `node:fs`, secrets or native AI runtimes.
- The preload surface is small, explicit and typed. Browser-safe schemas it
  uses are bundled into its CommonJS artifact; the built preload must load with
  only Electron resolvable.
- Main-process handlers validate every request before calling a service.
  Application orchestration lives in main-process services, not in the
  renderer, preload, repositories, external clients or the Python sidecar.
- Heavy work runs in `worker_threads` or a supervised sidecar/helper. Workers
  never touch UI state. Presentation-only computation (graph layout, community
  detection) may run in a renderer Web Worker over validated snapshots.
- New code pushes state changes to the renderer through typed events emitted
  after commit; it does not add polling loops.

## Packages and dependency direction

| Package | Owns |
| --- | --- |
| `apps/desktop` | Electron app, main-process services, preload, renderer |
| `apps/chrome-extension`, `apps/obsidian-plugin` | Isolated external clients |
| `@app/domain` | Canonical vocabulary and lightweight Zod schemas; no privileged deps |
| `@app/integration-contracts` | External commands, events, errors and capabilities |
| `@app/db` | Drizzle schema, migrations, baseline, repositories, SQL |
| `@app/ai` | Model contracts, adapters, registry, local model catalog/downloader |
| `@app/conversion` | Conversion, structure detection, normalization, chunking; no persistence |
| `@app/i18n` | Locales, translation helpers, message-key types |

- Desktop may depend on every internal package. External clients depend only
  on browser/host-safe packages (`@app/integration-contracts`, `@app/i18n`).
- `@app/db`, `@app/ai`, Node-dependent conversion code and Electron main code
  never enter renderer or external-client bundles.
- `@app/db` may import browser-safe `@app/domain` schemas; repositories still
  hold no application orchestration.
- `native/mlx-helper` is the Swift MLX helper; `scripts/` holds setup,
  verification and packaging tools; `docs/` holds the plan and runbooks.
- `.env`, `node_modules/`, build outputs, `.cache/`, `vendor/sidecars/` and real
  calibration corpora are local, never source. Generalizable cases become small
  synthetic fixtures.

## Background jobs

- Jobs, ingestion runs, stage checkpoints and processing batches persist in
  PostgreSQL. UI progress is a view of persisted work, never its owner.
- Workers claim jobs atomically (`FOR UPDATE SKIP LOCKED`) with bounded pools
  and concurrency.
- Stages are resumable from checkpoints after restart, crash, timeout or
  cancellation, without repeating validated work or replaying an uncertain
  provider call. Unrequested stages are recorded as skipped, not pending.
- One failed or canceled item never blocks or invalidates its siblings or
  unrelated tasks. Aggregate progress never hides a failed child. Cancellation
  preserves completed results.
- Only transient errors are retried, with bounded attempts and backoff.
- Reuse an artifact only when its source revision, input hashes and required
  dependencies still match; invalidation is explicit and limited to affected
  dependents.
- Job state, statuses and errors shown to users are localized.

## Sidecars and native runtimes

- PostgreSQL, Docling (CPython) and the MLX helper are platform-specific,
  version-pinned, built from a recorded origin with checksums, licenses and SBOM
  data, and supervised by the desktop (start, timeout, cancellation, crash
  recovery, shutdown).
- Runtime code never downloads dependencies or installs packages. Optional model
  downloads are an explicit user workflow with immutable revisions and hash
  verification. There is no system-Python fallback.
- MLX is macOS arm64 only. Other platforms hide or mark MLX entries
  incompatible and use GGUF or remote adapters.
- AGE failure degrades graph features only; relational storage is unaffected.

## Packaging and release

- Staging packages migrations, the baseline, sidecars, helper resources, a
  runtime manifest and an SPDX SBOM that describe exactly the bytes shipped.
  Missing required artifacts fail staging; never publish a partial package.
- Native binaries stay outside ASAR where loading requires it and enter the
  platform signing and notarization flow. Credentials stay outside the repo.
- Distribution requires clean-install validation plus signature and
  notarization checks. The current target is macOS arm64; a new target needs
  all native artifacts and equivalent smoke coverage first.
- Static archive checks never replace executable startup/shutdown smoke tests.
- Closing the main window quits the app on every platform through graceful
  shutdown of services, local runtimes and PostgreSQL. It never hides the app in
  the tray, and activation never reopens a window while shutdown is in progress.

## Development application testing

- Start DEV only with `npm run dev -w @app/desktop` from the repository root.
- Manual and automated UI validation uses only that DEV app. Never open an
  installed or packaged copy unless the owner asks for release validation, and
  never run it alongside DEV. Run one Memora Eterna instance at a time and
  target it by repository path or `localhost` content.
- Background relaunches use `MEMORA_DEV_BACKGROUND=1` so the DEV window does
  not steal focus.
