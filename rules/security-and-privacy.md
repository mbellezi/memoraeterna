# Security and privacy rules

Load this rule for secrets, external inputs, filesystem/network access, remote
processing, destructive operations, backups, or sensitive logging.

## Secrets and credentials

- API keys, OAuth refresh/access tokens, database passwords, pairing tokens, and
  repository tokens never appear in plaintext database fields or logs.
- Store desktop secrets with Electron `safeStorage`; persist only references,
  hashes, non-sensitive metadata, and status.
- Pairing tokens are shown once and stored only as hashes. Database credentials
  use per-installation generation and SCRAM.
- Sanitize provider errors, URLs, headers, and structured logs before exposing
  them to renderer or files.

## Trust boundaries

- Validate all external, IPC, worker, sidecar, and integration payloads with
  Zod. Reject unknown or invalid protocol versions where compatibility requires
  it.
- Renderer and external clients never receive privileged filesystem paths,
  secrets, repository handles, or unrestricted native capabilities.
- Validate and resolve paths in the main process. Reject traversal, unsafe
  symlinks where relevant, paths outside managed roots, oversized archives, and
  dangerous container expansion.
- Network adapters use HTTPS allowlists, short timeouts, bounded retries, and
  non-sensitive logs. Metadata enrichment sends only the documented catalog
  query fields and respects global opt-out.
- User-triggered manual URL previews respect the enrichment opt-out. Web pages
  use HTTPS and the Electron Chromium network stack. Public DNS resolution is
  validated immediately before every request and bounded redirect; requests use
  explicit timeouts and a response-size limit and send no browser cookies or local
  credentials. Page requests use a Chrome user agent matching the current desktop
  platform and packaged Chromium version. Video previews accept validated YouTube
  video identifiers.

## AI privacy and cost

- Never send content to a remote provider when the selected profile requires
  offline/local processing.
- Remote calls record provider/model, effective parameters, tokens, duration,
  and estimated cost. Batch operations respect configured cost confirmation.
- Full remote-provider responses are never written to debug logs. Full local
  model output may be captured only through the explicit dashboard debug switch,
  off by default, with a privacy warning; treat resulting events as sensitive
  and disable capture after diagnosis.

## Deletion, reset, and backup

- Destructive UI actions disclose scope and require confirmation. Source-root
  deletion is transactional across descendants and derived artifacts and cleans
  only files managed/registered by the application.
- Synchronization does not infer deletion merely from absence during a scan.
  Prefer tombstones and preserve audit history when loss is possible.
- Library reset removes library data and registered managed projections/assets
  but preserves installed local model files and records.
- Backups use `pg_dump` plus configured managed folders. They must not include
  plaintext secrets and must report partial-copy failures.
