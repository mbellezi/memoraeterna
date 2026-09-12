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
- Dashboard cleanup dismisses succeeded and failed jobs of every type using
  `payload.dashboardDismissedAt`, preserving execution records and audit links.
  Queue admission is unaffected; retry removes the dismissal and active jobs
  remain visible. Canceled-run deletion retains its separate confirmed flow.
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
- A failed polling pass or idle-runtime cleanup schedules another bounded poll.
  Optional wiki-sync and maintenance admission failures cannot prevent foreground
  jobs from being claimed; report sanitized diagnostics and retry admission on
  subsequent polls. Shutdown still prevents any deferred restart.

- Organization jobs are claimed by the existing supervisor alongside ingestion
  and relation maintenance. Their run checkpoint owns analysis/review state;
  dispatch jobs may succeed while a proposal awaits review. Canonical mutation
  receipts are reconciled independently of job restart recovery. Completed-job
  cleanup preserves organization jobs, and generic ingestion retry must not
  reset organization attempts or cumulative model/tool budgets.

- Organization participation reconciles selected stage checkpoints and active
  per-stage jobs before admission; succeeded parent jobs are insufficient. Batch
  counters and source cards retain pending/failed organization and any failed
  selected checkpoint. Batch cancellation reaches linked organization jobs and
  review proposals, blocks late apply, and preserves completed derivations. A
  source-card cancellation also cancels its currently linked cross-source run.
  One ineligible organization batch must not starve unrelated queued jobs.
  Generic ingestion retry cannot restart a settled parent while its linked
  organization checkpoint is pending, waiting for the batch or running.

- Maintenance uses the existing supervisor after foreground jobs. Its admission,
  per-period reservations, cursor, model state and review receipt are persisted.
  A paused/changed schedule revokes its pending runs and aborts active execution;
  generic job retry and completed-job cleanup cannot reset maintenance limits or
  remove its audit links. An uncertain interrupted inference is not replayed.
  Run now can queue during user activity but still respects imports/sync conflicts
  and the shared inference FIFO. Due schedules retain a visible deferral reason.

## Automatic-wiki successor work

- Admit new curator work with versioned policy, source scope, model and prompt
  composition snapshots. Legacy single-page organization and maintenance runs
  retain their original dispatch and checkpoint semantics. Source text cannot
  activate policy, select a new model or raise a budget.
- Automatic impact consumers use the per-consumer delivery ownership in
  `rules/database.md`. Persist generation/causal run/group and acknowledge only
  a durable apply, unchanged-inspection or explicit exclusion receipt. A global
  legacy consumption timestamp is not acknowledgment for another consumer.
- Automatic routine occurrences retain cumulative calls, tokens, unknown usage,
  reservations, deadlines, cursor and receipts across deferral/restart/retry.
  Policy pause/revision changes revoke new work and guarded apply. Retry cannot
  acquire a fresh occurrence allowance. No transaction waits for inference.

## Prompt admission snapshots

- Persist source-free catalog templates/revision references at job or run
  admission. Pipeline child jobs inherit the original parent admission; repairs,
  retries, restarts and FIFO waiting do not recapture newly active prompts.
- Preserve older queued payloads and versioned legacy run snapshots. New ordinary
  jobs receive the catalog pin through the SQL admission trigger; explicitly scoped
  batches and harness runs persist the resolved domain composition themselves.
- Prompt preparation may run while a request waits, but reserve FIFO order
  synchronously. Check freshness after acquiring the FIFO and again before the
  provider call. Queued cancellation creates no inference execution or AI audit;
  its admitted job/run snapshot remains the provenance of the canceled work.
- Persisted jobs may carry reserved app-owned envelope fields (`promptPin`,
  `errorHistory`, `dashboardDismissedAt`) beside task arguments. Extract those
  fields before strict task validation and worker dispatch, leaving the stored
  admission/audit payload intact. Direct task entrypoints must follow the same
  rule. Continue rejecting unknown task fields; never make task schemas permissive
  merely to accept admission or retry metadata. Non-AI jobs obey this boundary too.

- `integrateWiki` version 2 is a title-free choice on the existing explicitly
  selected `organizeKnowledge` stage. Legacy plans/presets keep their meaning and
  DAG. It references an enabled policy revision and adds no summary, note, vector,
  matching or graph prerequisite. Selected-stage barriers and omissions remain
  owned by existing ingestion checkpoints. Processing-batch metadata pins the
  source-free catalog at admission, including batches reusing all other artifacts.
- A selected processing stage may link an unchanged curator receipt through its
  existing organization-run metadata. Reconciliation resolves that link even when
  the receipt originated outside this batch, completes the stage and starts no
  duplicate inference. The original run keeps its admission and audit ownership.
- Curator admission deduplicates the same unfinished or failed input generation
  under a transaction lock. Retry preserves calls, repairs, usage availability,
  original admission deadline and exact templates. An uncertain started provider
  call is not automatically repeated. A known pre-provider guard failure is not
  mislabeled as uncertain inference merely because UI progress began.
- Persist completed curator synthesis/check results before a subsequent admission
  guard can cancel or defer execution. Resume the stored semantic-check or repair
  stage without repeating known completed inference. A single repair allowance is
  shared by structural failures, unsupported drafts and invalid check verdicts;
  none resets cumulative calls, usage or the admission deadline.
- Admission deduplication includes effective model parameters and content language.
  Changing parameters may admit a new generation after a failed old generation;
  the old snapshot, budgets and history remain unchanged. Running-model identity
  guards still preserve the parameters frozen at that run's admission.
