# Monitoring and diagnostic history

- The desktop monitoring dashboard has AI Usage and Debug tabs. Every actual
  AI execution, including embeddings, reranking, canonicalization confirmations,
  repair attempts and local-model tests, records a monitoring entry independently
  of debug. Calls record running and terminal state; interrupted entries are
  reconciled on startup before jobs resume. Monitoring failures never fail the
  underlying operation.
- Preserve precise caller context: operation, stage, source IDs and title
  snapshots, job, ingestion run, document, chunk/note IDs, prompt version, batch
  and attempt where available. Historical backfill exposes unavailable context
  honestly and runs once, never repopulating history after cleanup.
- Adapters retain all available numeric provider usage details. Normalize input,
  output (including reported reasoning), thinking, cached input, cache writes
  and total tokens without double counting. Unknown values remain absent, never
  fabricated as zero. Show known cost estimates and disclose missing costs and
  incomplete token totals. No pricing guesses or extra paid calls for telemetry.
- Debug additionally records processing stage outcomes, canonicalization and
  relation persistence alongside existing similarity diagnostics. Full prompts
  and outputs require the separate full-capture switch and warning described in
  `security-and-privacy.md`. Large contents are loaded only for an expanded
  operation, rendered as escaped text with JSON syntax colors and incremental
  display; copying retains the complete record.
- History uses bounded server-side pages, source/stage/model/ID search, type,
  status and time filters, and aggregates over the entire filtered history.
  Live refresh pauses for older pages and hidden documents. Failed refreshes
  remain visible and retryable. Source details use normal Library navigation.
- Transient monitoring lives in `monitoring_operations`, separately from the
  canonical `ai_task_runs` audit and derivation references. Cleanup previews and
  confirms scope/count/cutoff for entries older than a positive number of days
  or calendar months (clamped at month end). It removes either complete
  monitoring and similarity entries, or only captured inputs/outputs. Active
  operations and canonical artifacts/audit are preserved. Library reset clears
  monitoring too.
- Validate monitoring inputs and outputs across IPC/preload with Zod. Regression
  coverage includes usage normalization, capture gating, errors, date cutoffs,
  pagination/aggregation, retention and preservation of canonical audit.

- Maintenance model calls link canonical AI audits to `maintenance_steps` in the
  audit insert transaction. Inspection-only/no-change runs do not manufacture AI
  activity. Pending/unknown calls keep their reservation and availability state;
  diagnostic history and review receipts are independent of monitoring retention.
