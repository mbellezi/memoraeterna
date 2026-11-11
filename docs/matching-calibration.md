# Matching calibration in DEV

The advanced controls are in Settings → Matching → Advanced matching. Since F3
(T53b) they hold only the note decider's output budget, the canonical matching
limits and the source judge's evidence and output limits. Relations v2 takes its
note thresholds and candidate limits from typed configuration
(`packages/domain/src/relations-config.ts`), so the note threshold, candidate
limits and scoring weights are no longer settings. The controls persist in
application preferences, require no schema migration, and apply to subsequent
processing. Existing note pairs are excluded from generation; changing a setting
does not delete or rewrite previous relationships.

The synthetic pilot contains 12 roots, including four books with two chapters
apiece: 20 source records and 16 content documents. Its fixture is
`scripts/fixtures/matching-pilot.json`. Expected propositions and pair labels are
kept out of source descriptors and model prompts. They are assessment data,
not generation instructions. Negative examples cover same-topic distractors,
homonyms, conditions/negation, and an index with no substantive ideas.

## Run

The runner works only on a scratch profile (F5 D26): an absolute `MEMORA_USER_DATA_DIR` that is a folder
inside `.cache/profiles/` (an APFS clone of a stopped profile, `cp -cR`) or inside `.cache/f<N>/scratch/`
(for example `.cache/f5/scratch/pilot`), with symbolic links resolved. It refuses the owner's DEV profile, a
relative path and any other folder before it reads or writes anything, so no agent ever runs it on the owner's
DEV profile. Its artifacts live in the profile, in `<profile>/matching-pilot/`, not in the repository's
`.cache/`.

Start from an empty scratch library with configured embedding, summary, atomic-note,
graph and reranking routes. The runner never resets the library. Quit any
existing DEV instance before starting another one against its database.

```sh
export PROFILE="$PWD/.cache/f5/scratch/pilot"   # absolute; inside .cache/profiles/ or .cache/f<N>/scratch/
mkdir -p "$PROFILE"
MEMORA_USER_DATA_DIR="$PROFILE" MEMORA_MATCHING_PILOT=inspect npm run dev -w @app/desktop
MEMORA_USER_DATA_DIR="$PROFILE" MEMORA_MATCHING_PILOT=prepare npm run dev -w @app/desktop
MEMORA_USER_DATA_DIR="$PROFILE" MEMORA_MATCHING_PILOT=run npm run dev -w @app/desktop
```

`inspect` checks counts only and writes them to `<profile>/matching-pilot/preflight.json`, then prints the
`MATCHING_PILOT preflight` log line. `prepare` imports without AI
processing. `run` prepares missing fixture items and queues one full-knowledge batch, or follows the batch from
its existing manifest and requeues canceled ingestion jobs in that batch through the normal retry service. It
uses the unpackaged desktop's normal services, queue, model routes and database. The runner refuses a packaged
app and any user-data directory that is not a scratch profile.

The runner enables candidate diagnostics without full prompt/output capture,
then restores the prior diagnostic settings after reporting. Keep model routes
and matching settings stable during a comparison. A stopped or failed run does
not mean calibration is complete; inspect its stage checkpoints and retry through
normal task recovery. Saved artifacts and completed stages remain reusable.

## Inspect and assess

```sh
node --import tsx scripts/matching-pilot-report.ts --profile "$PROFILE"
node --import tsx scripts/matching-pilot-report.ts --profile "$PROFILE" --snapshot
node scripts/analyze-matching-pilot.ts --profile "$PROFILE"
```

Every script requires an absolute `--profile` that passes the runner's scratch check, refuses the default
userData path, and never prints the connection descriptor. The report command only reads the scratch profile's
database. Local artifacts under `<profile>/matching-pilot/` include the source-ID manifest, settings before/run,
model routes and parameters, progress and exported results. These files must
not contain credentials. Exported results include canonical notes, relations,
entity identities and participating sources, candidate diagnostics and usage by
stage. The user can inspect all pilot sources and tasks in the normal app UI.

Completion requires both ingestion and deferred note/source matching to finish.
The run reads its reported input-plus-output token stop from
`<profile>/matching-pilot/limits.json` on every progress poll. The default is
600,000; this pilot was raised to 1,800,000 at the user’s request. There is no
time-based stop. Exhausting the token allowance requests cancellation of the
selected sources. This is an
experiment guard, not a guaranteed provider spending cap: in-flight calls can
overshoot and unknown usage remains unknown. Application matching budgets are
separate, and source input budgets do not include summaries, graph extraction,
embeddings, notes, or output tokens. Provider cost estimates may be unavailable.

Review source evidence, atomicity, duplication, relationship meaning/direction,
expected root-pair coverage, explicitly forbidden pairs, and identity reuse.
Pair labels are screening checks, not a complete semantic gold standard. Do not
report unreviewed extra pairs as false positives or claim calibrated confidence
from model scores. The pilot establishes operational correctness and an initial
cost/quality baseline; it cannot establish a universal sweet spot or validate
40-source candidate truncation with only 12 roots.

For subsequent parameter comparisons, save a consistent database snapshot
before relationship creation and evaluate each configuration from that same
state. Reuse compatible summaries, notes and embeddings; regenerate only the
stages affected by a changed extraction/model configuration. Post-processing
threshold/weight sweeps can reuse candidate diagnostics, but retrieval changes
need new candidates and AI decisions. Keep unseen evaluation sources separate
from tuning, and retain negative cases when expanding the corpus.

## Compare a corrected matching pass

After every baseline ingestion and deferred stage has completed successfully:

```sh
MEMORA_USER_DATA_DIR="$PROFILE" MEMORA_MATCHING_PILOT=rematch npm run dev -w @app/desktop
node scripts/analyze-matching-pilot.ts --profile "$PROFILE" --baseline
node scripts/analyze-matching-pilot.ts --profile "$PROFILE"
```

This explicit DEV-only, scratch-profile-only mode first saves a full database backup through the
normal backup service and copies the baseline artifacts. A guarded transaction
refuses any library other than the manifest's exact 20 sources, active ingestion,
or reviewed relationships. It clears only their unreviewed note/source matching
relationships and pair caches, rebuilds the AGE projection from canonical data,
and queues a custom matching plan with valid prerequisites reused. Source text,
notes, summaries, entities, profiles and settings are preserved. The new manifest
retains the baseline batch and original start time, so the global token allowance
continues counting both rounds. Repeating the command resumes its saved round.

The second pass has warmed embeddings and revised prompts; its quality/cost
comparison is operational, not an experiment isolating a single causal variable.
Do not silently interpret unlabelled cross-domain connections as either correct
or incorrect. Preserve the original labels and record adjudication separately.

The first pilot also exposed replacement of identical catalog chunks during
matching-only reprocessing, cascading to graph evidence. Catalog chunking now
preserves existing IDs when the content, hash, source and chunking version match.
The four affected synthetic catalogs were recovered from the baseline backup,
with evidence remapped only after exact content/hash checks, then verified through
normal embedding reprocessing. The second matching pass had temporarily missing
catalog evidence, another reason not to interpret its count changes as a pure
prompt effect. See `docs/archive/matching-pilot-report.md` for measured outcomes and the
provisional DEV settings.
