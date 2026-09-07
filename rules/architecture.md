# Architecture rules

Load this rule for changes to application boundaries, package ownership, IPC,
services, workers, or dependency direction.

## Runtime topology

The Electron desktop is the system core and the only application allowed to
own PostgreSQL, privileged filesystem access, secrets, native runtimes,
sidecars, workers, and the Integration Gateway.

```txt
Renderer
  -> typed preload API (`window.app`)
  -> Zod-validated IPC
  -> main-process application service
  -> repository / worker / managed filesystem
  -> PostgreSQL sidecar
```

- The renderer owns presentation and interaction only. It must not import
  Electron main code, `@app/db`, `node:fs`, secrets, or native AI runtimes.
- The preload surface is small, explicit, typed, and treated as an internal
  public API.
- Main-process handlers validate requests before invoking application services.
- Heavy processing runs in `worker_threads` or a supervised sidecar/helper.
  Workers never access UI state.
- Presentation-only graph layout and community detection run in a renderer
  Web Worker over validated graph snapshots. This worker has no privileged
  application, storage, or domain-processing responsibilities.
- Payloads crossing IPC, worker, sidecar, or integration boundaries are
  versioned where compatibility matters and validated with Zod.

## External clients

The Chrome extension and Obsidian plugin are isolated applications. They use
versioned contracts from `@app/integration-contracts` and communicate with the
desktop through the loopback Integration Gateway. They never access the local
database or import desktop main-process code.

## Package ownership

- `@app/domain`: canonical vocabulary and lightweight Zod schemas; no heavy or
  privileged dependencies.
- `@app/integration-contracts`: safe external commands, events, errors,
  capabilities, and protocol versions; no Electron, database, filesystem, or
  service implementation.
- `@app/db`: Drizzle schema, migrations, seed/baseline, repositories, and
  specialized queries.
- `@app/ai`: model contracts, adapters, registry, capability negotiation,
  parameter support, and local model catalog/downloader logic.
- `@app/conversion`: format routing, conversion adapters, structure detection,
  Markdown normalization, and chunking; it does not persist data.
- `@app/i18n`: shared locales, translation helpers, and message-key types.

Application orchestration belongs in desktop main-process services. Do not move
business behavior into the renderer, preload, external clients, repositories,
or Python sidecar merely for convenience.

## Dependency direction

- Desktop may depend on all internal packages.
- Chrome and Obsidian may depend only on browser/host-safe packages, currently
  `@app/integration-contracts` and `@app/i18n` where needed.
- `@app/db`, `@app/ai`, Node-dependent conversion code, and Electron main code
  must not enter external-client or renderer bundles.
- Transport details stay in per-app adapters; domain semantics stay in domain
  contracts and application services.
