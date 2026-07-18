# Docling sidecar runbook

The Docling integration lives in `packages/conversion`. Python is limited to
`packages/conversion/sidecar/docling_sidecar.py`; application and domain logic
remain TypeScript.

## Runtime layout

Development:

```txt
vendor/sidecars/docling/<platform>/
  bin/python3.13          # python.exe on Windows
  ... pinned CPython, wheels, and local models
```

Packaged application:

```txt
resources/
  sidecars/docling/<platform>/
  docling/docling_sidecar.py
```

The current artifact contains CPython `3.13.13`, Docling `2.111.0`, locked
wheels, and fixed model revisions. The application never uses system Python and
never runs `pip install` at runtime.

## Protocol

- Versioned JSONL over stdin/stdout; no network port.
- Current `protocolVersion`: `3`.
- Requests, progress events, and responses are validated by Zod in
  `packages/conversion/src/docling-contracts.ts`.
- Every event is correlated by `requestId`.
- PDF progress reports completed and total pages from the actual Docling output
  pipeline.
- Results include Markdown, structured blocks, pages, bounding boxes, offsets,
  warnings, quality data, and raw `DoclingDocument` data when available.

The desktop creates temporary files under `userData/tmp/conversion` and removes
them after success, error, or cancellation. Useful structured results are
persisted by the ingestion service as derived assets.

## Build and verification

```bash
npm run docling:build
npm run docling:verify
npm run docling:smoke
```

`docling:build` currently materializes `darwin-arm64`. It downloads an immutable
CPython distribution, verifies its SHA-256, installs only packages from
`requirements-darwin-arm64.lock`, and pre-downloads fixed model revisions.

`docling:verify` checks the generated runtime manifest, package lock, model
revisions, and required files.

`docling:smoke` converts a generated PDF with invalid loopback proxies and
Hugging Face/Transformers offline modes enabled. The smoke requires a real page
progress event before the final response, proving that the packaged Python,
wheels, and models operate without network or system Python.

To rebuild after intentionally changing the runtime definition or lock:

```bash
npm run docling:build -- --force
```

To remove the generated development artifact:

```bash
npm run docling:remove
```

The builder records CPython origin, lock hash, packages, model revisions, sizes,
and aggregate hashes. Desktop staging validates the files again and includes
them in the SPDX SBOM. Any new platform must provide an equivalent lock,
manifest, offline smoke, and packaging validation; there is no system-Python
fallback.
