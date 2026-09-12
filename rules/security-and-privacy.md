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
- Renderer blob workers are allowed only for bundled, local computation such
  as graph layout; the renderer CSP does not allow remote worker sources.
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

- The task router or explicit model override authorizes the selected provider.
  Execution location follows that model, without a separate privacy selector or
  legacy local-only gate. Preserve model identity checks and execution audits.
- Remote calls record provider/model, effective parameters, tokens, duration,
  and estimated cost. Batch operations respect configured cost confirmation.
- Monitoring retains usage and provenance independently of debug. Operation
  diagnostics and full-content capture have separate switches, off by default.
  Full prompts and outputs from both local and remote models may be stored in
  the local monitoring database only when both switches are enabled, after a
  confirmation popup explaining content retention and disk usage. Disabling
  debug disables full capture; in-flight outputs respect the current switches.
  Content remains available until explicitly cleaned. Never capture transport
  credentials, authentication headers or secrets; ordinary console logs remain
  sanitized. See `rules/monitoring.md` for retention and presentation.

## Deletion, reset, and backup

- Destructive UI actions disclose scope and require confirmation. Source-root
  deletion is transactional across descendants and derived artifacts and cleans
  only files managed/registered by the application.
- Synchronization does not infer deletion merely from absence during a scan.
  Prefer tombstones and preserve audit history when loss is possible.
- Reset everything clears all application tables except model/provider profiles,
  capabilities, parameters, task routes and installed local model records/files
  (including embedding models). It also resets other preferences, matching
  presets, storage bindings, integrations, wiki, harness configuration/schedules,
  all histories and every vector family. Migration history and extensions remain;
  recreate only the empty projection clock needed for future synchronization.
- Reset table coverage follows the application schema with an explicit model
  preservation allowlist. Relational cleanup and AGE projection removal share a
  transaction, without cascading into preserved model configuration.
- Stop gateway, jobs and downloads before reset. Remove registered managed files,
  recovery snapshots, internal assets, conversion/cache files and partial model
  downloads, preserving installed models, backups and unrelated personal files.
  Validate containment and reject symlink traversal before deletion. Registered
  recovery content may establish ownership when its frontmatter is invalid.
  Legacy recovery files with independent delivery IDs are removable only inside
  the managed recovery directory, with a recognized recovery filename and valid
  managed frontmatter referencing a registered synchronization identity.
  File failures retain the database ownership registry for retry and report failure;
  a retry tolerates already removed files. Reload the renderer after success so
  stale preferences and wiki state cannot be written back.
- Backups use `pg_dump` plus configured managed folders. They must not include
  plaintext secrets and must report partial-copy failures.
