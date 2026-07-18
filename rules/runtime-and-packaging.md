# Native runtime and packaging rules

Load this rule for PostgreSQL, Docling, or MLX artifacts; local model downloads;
desktop packaging; signing; notarization; or distribution.

## Reproducible native artifacts

- Every packaged runtime is platform-specific, version-pinned, and built from a
  recorded origin with checksums, licenses, and SBOM data.
- Runtime code never downloads dependencies or installs packages. Optional model
  downloads are an explicit user workflow with immutable revisions and hash
  verification.
- Missing required target artifacts fail staging; do not publish a partially
  functional package.
- Native binaries and extensions stay outside ASAR where loading requires it
  and enter the platform signing/notarization flow.

## PostgreSQL and AGE

- Package PostgreSQL `18.4`, pgvector `0.8.4`, and the validated AGE target for
  each supported platform under `resources/sidecars/postgres/<platform>/`.
- Package Drizzle migrations and the seed/baseline under application resources.
- Validate initdb, extensions, a vector query, an AGE query, stop/restart, and
  cleanup for every platform artifact. AGE failure degrades graph features but
  does not change relational canonical storage.

## Docling

- Package CPython `3.13.13`, Docling `2.111.0`, locked wheels, fixed model
  revisions, and the JSONL bridge under the Docling resource layout.
- `npm run docling:verify` validates the artifact manifest; the offline smoke
  must convert a PDF and observe real page progress without system Python or
  network access.
- New platform artifacts require an equivalent lock, source/checksum record,
  offline smoke, and packaging validation. There is no system-Python fallback.

## MLX and GGUF

- The Swift MLX helper is macOS arm64 only and ships with `mlx.metallib`. Its
  JSONL protocol, lifecycle, timeout, progress, cancellation, and errors are
  supervised by the desktop.
- Platforms without MLX hide or mark MLX catalog entries as incompatible and
  continue with supported GGUF or remote adapters.
- GGUF native bindings and model files remain outside ASAR as required. Smoke
  tests use the same adapters and resource resolution as the desktop.

## Desktop staging and release

- `scripts/prepare-desktop-resources.mjs` stages migrations, baseline,
  PostgreSQL, Docling, MLX helper/resources, runtime manifest, and SPDX SBOM.
- `npm run package:desktop:dir` creates an unpacked package;
  `npm run package:desktop:smoke` validates repeated startup/shutdown against a
  temporary persistent userData directory.
- Distribution artifacts require clean-install validation plus signature and
  notarization verification where the platform requires them. Credentials stay
  outside the repository.
- Current materialized distribution target is macOS arm64. Adding another
  target requires all native artifacts and equivalent smoke coverage first.
