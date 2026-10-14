# Security, privacy and licensing

Load for secrets, credentials, external input, filesystem or network access,
remote AI routing, spending, deletion, reset, backups, logs, monitoring
retention, licensing, or adding dependencies and model artifacts.

## Secrets and credentials

- API keys, OAuth tokens, database passwords, pairing tokens and repository
  tokens never appear in plaintext database fields, logs, prompts or exports.
- Desktop secrets live in Electron `safeStorage`; persist only references,
  hashes, status and non-sensitive metadata. Pairing tokens are shown once and
  stored as hashes.
- Sanitize provider errors, URLs, headers and structured logs before they reach
  the renderer or files.

## External input and filesystem

- Validate all external, IPC, worker, sidecar and integration payloads with Zod;
  reject unknown or invalid protocol versions.
- The renderer and external clients never receive privileged paths, secrets,
  repository handles or unrestricted native capabilities. File selection returns
  an expiring opaque token, not a path.
- Resolve and validate paths in the main process. Reject traversal, unsafe
  symlinks, paths outside managed roots, oversized archives and dangerous
  container expansion.
- The renderer CSP allows no remote scripts, workers, fonts, stylesheets or
  images; remote covers are copied into managed storage.

## Network

- Network adapters use HTTPS allowlists, explicit timeouts, bounded retries,
  response-size limits and non-sensitive logs.
- Metadata enrichment sends only the documented query fields and honors the
  global opt-out. Credentialed requests go only to their own service and do not
  follow redirects.
- Web page previews validate public DNS before every request and redirect, send
  no cookies or local credentials, and are bounded in size and time.

## Remote AI and spending

- The routed or explicitly selected model authorizes its provider; execution
  location follows that model. Scope and exclusion filters apply before any
  provider call.
- Choosing a remote provider for a route (for example a remote decider)
  discloses in the UI, at the moment of choice, what is sent and the provider's
  data retention (for instance OpenAI Decisions' abuse-monitoring retention).
- Automatic background spending obeys the user's monthly remote cap. Spend is
  computed from recorded usage and a versioned price table; an unknown price is
  estimated conservatively, never counted as zero. Routes without per-token
  pricing (subscriptions) are bounded by concurrency and call caps instead. At
  the cap, background work continues local-only or waits, and the UI says why.
  Work the user starts shows its estimate before it runs (target F4).

## Logs, monitoring and telemetry

- Usage and provenance monitoring is always on and separate from debug.
  Operation diagnostics and full prompt/output capture are separate switches,
  off by default; full capture needs both switches plus a confirmation that
  explains content retention and disk use. Never capture credentials or auth
  headers.
- Monitoring cleanup previews and confirms its scope; it never removes active
  operations or the canonical AI audit.
- Optional usage telemetry is local, opt-in, time-limited and never leaves the
  device. View history needed for product features is a separate local store.

## Deletion, reset and backups

- Destructive actions disclose scope and require confirmation. Source deletion
  is transactional across descendants and derived artifacts and removes only
  files the app manages.
- Synchronization never infers deletion from absence during a scan; prefer
  tombstones and recoverable deletion when data loss is possible.
- Reset stops the gateway, jobs and downloads first; clears application data
  while preserving model/provider configuration and installed models; checks
  containment and rejects symlink traversal before deleting files; keeps backups
  and unrelated personal files; and reloads the renderer afterwards. Relational
  cleanup and graph projection removal share one transaction. An absent optional
  AGE catalog skips only graph removal (an error with AGE present rolls the whole
  reset back). File-deletion failures keep the ownership registry for retry and
  are reported; a retry tolerates files already removed.
- Backups use `pg_dump` plus managed folders, contain no plaintext secrets and
  report partial failures. Take a verified backup before destructive migrations
  or data wipes.

## Licensing

- The repository default is `GPL-3.0-or-later`. `apps/obsidian-plugin` is
  `MIT OR Apache-2.0`; `packages/i18n` and `packages/integration-contracts` are
  `GPL-3.0-or-later OR MIT OR Apache-2.0`. No other code inherits them.
- Package manifests carry their SPDX expression. The root `LICENSE` holds the
  full GPLv3 text and `apps/obsidian-plugin` holds both the MIT and Apache-2.0
  texts. Release staging includes all notices, license texts, source offers and
  installation information that the distributed components require.
- Before adding a dependency, model artifact, font or dataset, check that its
  license allows distribution under the project license (reject non-commercial
  licenses such as CC-BY-NC). Dependencies, models, native runtimes and SBOM
  entries keep their own licenses; the project license never weakens them.
