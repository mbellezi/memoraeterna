# Expanded DEV matching benchmark

The expanded fixture contains 60 roots and 82 records including chapters. It
retains the pilot's 12 roots within the 40-root tuning partition, adds 28 tuning
roots, and reserves 20 unseen roots for validation. The preserved pilot parameters
are in `docs/matching-pilot-settings.json`. All examples are synthetic. The
assessment labels, family names, expected ideas and partition flags are excluded
from ingestion/model inputs.

## Execution

Use the unpackaged DEV app and its generated DEV database descriptor. The
benchmark refuses another profile, changed fixtures, unrelated library IDs,
reviewed relationships, and active ingestion during a reset. It saves a full
backup before extending the pilot and before each tuning reset.

```sh
MEMORA_MATCHING_BENCHMARK=1 npm run dev -w @app/desktop
node scripts/matching-benchmark-status.ts
node --import tsx scripts/matching-benchmark-report.ts baseline
node scripts/analyze-matching-benchmark.ts baseline
```

The DEV-only controller reads `.cache/matching-benchmark/control.json`. Each
command has a `phase` and an increasing `revision`. Phases are `prepare`,
`baseline`, `economy`, `coverage`, `validate`, and `stop`. The app remains available
while it waits for the next phase. Phases advance only after result export and
postcondition verification, recorded as `verifiedAt`; job completion alone is
insufficient. Completed, verified phases are not run again. Failed
jobs retain their ordinary checkpoints; recover through the normal retry service
before incrementing the command revision. A stop requests cancellation and
preserves completed work.

Preparation ingests only tuning sources, creates missing summaries/notes/graphs,
stabilizes catalog documents and warms all selected atomic-note embeddings. A
validated zero-note generation is reused instead of repeatedly invoking AI for
the same unchanged document. Failed/unconfigured attempts do not qualify. A
canonical fingerprint covers source/document content, notes, chunks, spans,
summaries and extracted graph evidence. Each tuning pass starts without previous
unreviewed matching relationships or pair decisions, rebuilds AGE from canonical
data, and verifies the extraction fingerprint afterward.

The baseline uses the saved pilot settings. The economical variant lowers note
shortlists to 20 and source-pair allowance to six, with shorter evidence context.
The coverage variant uses 40 note candidates and 12 source pairs, with more
retrieved candidates and evidence passages. All variants keep the same acceptance
thresholds, AI validation requirement, identity safeguards and model routes.
These are comparisons of complete configurations; they do not isolate the effect
of each individual parameter. Offline threshold sweeps reuse recorded decisions
and do not imply new retrieval or generation.

The experiment limit is 5,000,000 reported input-plus-output tokens across all
new preparation, comparison and validation work. It is checked between calls and
during batch polling. In-flight calls may overshoot; missing usage is not invented.
It is separate from per-root source-matching limits. Full-content capture stays
disabled; diagnostic mode is restored after each phase.

## Selection and validation

Export results before resetting the next graph. Local phase directories retain
settings, routes, candidate diagnostics, pair decisions, evidence, usage and
analysis. Inspect expected-pair coverage, forbidden-pair violations, unassessed
pairs, same-root violations, zero-note documents, identity separation and
proposition-level usefulness. Unlabelled bridges are not automatically errors.
The original ambiguous botany/astronomy pair is separately documented.

Freeze the selected settings, timestamp, configuration name and SHA-256 hash of
its training results in `selection.json`. Restore that configuration's unreviewed
graph with `node --import tsx scripts/select-matching-benchmark.ts <configuration>`.
An optional final numeric argument raises the source importance floor using the
observed training scores. Lowering it is refused because rejected source proposals
were not exported. The command filters source relations and their evidence before
restoration, records that post-processing separately and freezes the new floor for
actual holdout execution. It does not claim to simulate new discovery or ordering.
This command verifies the extraction fingerprint, backs up the current state,
and restores the chosen
matching graph transactionally from its saved snapshot if another variant is
currently persisted, then verify the IDs and canonical fingerprint and record
the result in `validation-ready.json`. The repository restore is covered by
`packages/db/src/scripts/verify-matching-benchmark.ts`, including rollback and
review preservation. The validation phase requires both freeze and readiness
records before importing any held-out source. It prepares those sources, warms
their note embeddings and matches only those new roots against the full library.
Do not tune against the held-out outcome; report failures and limitations.

No model is fine-tuned here: this workflow calibrates application matching
parameters. Entity/type extraction is held fixed across the three matching
configurations, so the comparison cannot measure a changed identity threshold.
