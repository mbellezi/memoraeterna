# Jobs, workers, and processing rules

Load this rule for persistent jobs, processing batches, ingestion runs/stages,
worker supervision, progress, cancellation, retry, or restart recovery.

## Persistence and execution

- Heavy or long-running work executes outside the renderer through supervised
  `worker_threads` or the domain's controlled sidecar/helper.
- Jobs, ingestion runs, per-stage state, and user-triggered processing batches
  are persisted in PostgreSQL. UI progress is a view of persisted work, not the
  owner of execution state.
- Workers claim jobs atomically with `FOR UPDATE SKIP LOCKED`, respect bounded
  database pools/concurrency, and validate boundary payloads with Zod.
- Job state includes status, progress, recoverable error details, retry data,
  cancellation state where supported, and timestamps. User-facing state and
  errors are localized.
- Worker code never imports or mutates renderer state.

## Plans, checkpoints, and recovery

- Each ingestion run persists its requested and effective stages plus an
  immutable plan version. Only effective stages execute.
- Per-stage checkpoints make work resumable after application restart, worker
  crash, timeout, error, or cancellation. Recovery reclaims interrupted work
  without repeating already validated stages.
- A stage records `completed`, `skipped`, `failed`, or `canceled`. Unrequested
  stages are `skipped` with `not_requested` rather than appearing pending.
- Retry/resume, execution of missing stages, and reingestion retain the distinct
  semantics defined in `rules/source-ingestion.md`.
- Reuse an artifact only when its source revision, input hashes, generation,
  parameters, and required dependencies still match. Invalidation is explicit
  and limited to affected downstream artifacts.

## Batches and coordination

- One user action over multiple sources creates one processing batch and
  associated runs, not an unrelated IPC command per selected row.
- Aggregate progress never hides a failed child. Canceling a batch requests
  cancellation for active/pending runs while preserving completed results.
- Collective stages honor their barriers: note matching waits for selected note
  generation, and root aggregation waits for the required child summaries.
- Failure in one independent child does not invalidate completed siblings.

## Verification

Relevant changes cover atomic claiming, progress, cancellation, retry limits,
checkpoint recovery, application restart, stage state, and batch aggregation.
