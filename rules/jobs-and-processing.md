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
- Atomic-note generation alone does not enroll a run in deferred note matching.
  The batch participant filter requires `atomicNoteMatching` in that run's
  effective stages, just as source matching requires its own explicit stage.
- Retry/resume, execution of missing stages, and reingestion retain the distinct
  semantics defined in `rules/source-ingestion.md`.
- Reuse an artifact only when its source revision, input hashes, generation,
  parameters, and required dependencies still match. Invalidation is explicit
  and limited to affected downstream artifacts.
- Graph batch checkpoints contain validated canonical entity/type IDs. Resolve identities
  before saving the checkpoint, preserve completed batches on retry, and use source-evidence
  identity fingerprints to recover decisions committed before a checkpoint write failed.

## Batches and coordination

- One user action over multiple sources creates one processing batch and
  associated runs, not an unrelated IPC command per selected row.
- Every stage and all its activity, counters, model-call context and outcomes
  belong to an individual source run. Batch barriers coordinate prerequisites
  only. Deferred atomic-note matching and source matching execute separate stage
  jobs per source in sequence; never combine their inputs or broadcast a shared
  completion/result to the batch. Cards display the owning checkpoint's waiting,
  running, failed/canceled or completed state even after the ingestion job ends.
- Aggregate progress never hides a failed child. Canceling a batch requests
  cancellation for active/pending runs while preserving completed results.
- Collective stages honor their barriers: note matching waits for selected note
  generation, and root aggregation waits for the required child summaries.
- Failure in one independent child does not invalidate completed siblings.
- A user-canceled, incomplete ingestion run may be deleted from the processing
  dashboard only after explicit confirmation. Deletion is transactional across
  the root job, its stage jobs, run checkpoints, and an orphaned batch; the
  imported source and durable library artifacts are preserved.

## Verification

Relevant changes cover atomic claiming, progress, cancellation, retry limits,
checkpoint recovery, application restart, stage state, and batch aggregation.

## Implementation navigation

- Relation-description maintenance uses a persisted `relation-labels` job. Main-process
  orchestration invokes the existing controlled AI adapter path in batches of at most
  20 relations. A target-language snapshot and creation cutoff bound the operation;
  metadata markers checkpoint committed batches. Admission deduplicates active jobs.
- `apps/desktop/src/main/services/job-supervisor.ts` owns ingestion execution,
  inline stage jobs, cancellation signals, and batch barriers. It coordinates
  the controlled workers and `KnowledgeService`; the ingestion worker alone
  does not implement the pipeline.
- `packages/db/src/repositories/jobRepository.ts` owns persisted claiming and
  retry state; `ingestionRunRepository.ts` owns stage checkpoints;
  `hierarchicalIngestionRepository.ts` owns batches and artifact-state lookup.
- Graph extraction records validated batches inside the `knowledgeGraph`
  checkpoint metadata through `updateStageProgress`. Progress updates must
  merge metadata without discarding completed batches. See
  `rules/knowledge-graph.md` for batch identity and repair semantics.
- Repository recovery/retry cases are in `repositories.test.ts`; retry policy
  is also covered by `apps/desktop/src/main/services/job-retry.test.ts`.

- The supervisor owns one queue drain at a time. Retry/enqueue wakeups while a
  drain is active are coalesced and scheduled after it settles; they must never
  start concurrent ingestion orchestrators or duplicate collective matching.
  Shutdown clears deferred wakeups and waits for the active drain.

- Organization jobs are claimed by the existing supervisor alongside ingestion
  and relation maintenance. Their run checkpoint owns analysis/review state;
  dispatch jobs may succeed while a proposal awaits review. Canonical mutation
  receipts are reconciled independently of job restart recovery. Completed-job
  cleanup preserves organization jobs, and generic ingestion retry must not
  reset organization attempts or cumulative model/tool budgets.
