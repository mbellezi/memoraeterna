# Golden library: record, replay and compare

The golden library is a small public corpus (`scripts/golden/manifest.json`: 10 roots, 12 files,
pt-BR and English, PDF, HTML, Markdown and plain text, one multi-chapter book) processed by the real
pipeline. An AI cassette records every AI call once and replays it at zero cost, so pipeline changes
are compared on identical inputs. DEV-only: packaged builds refuse cassettes and the golden runner.
The repository keeps only the manifest; files, cassettes, backups and runs live in `.cache/`
(git-ignored). A cassette holds full prompts and outputs, so `MEMORA_AI_CASSETTE_DIR` must be a folder
inside `.cache/`; anything else is refused.

**Run only on a clone or scratch profile** (`MEMORA_USER_DATA_DIR`, section 2's note; plan decision 34,
2026-11-11). The commands below default to the owner's DEV profile, and `MEMORA_GOLDEN_RESET` empties the
library of whichever profile runs; no agent starts the owner's DEV profile on refactoring code. Record,
replay and reset stay frozen on the default profile; add `MEMORA_USER_DATA_DIR=<absolute path of the clone>`
to every command.

## 1. Fetch and pin the sources

```sh
export MEMORA_GOLDEN_CONTACT=<contact URL or email>   # goes into the User-Agent; Wikimedia asks for one
npx tsx scripts/golden/fetch.ts --pin      # first time: download unpinned entries, write size + SHA-256
npx tsx scripts/golden/fetch.ts            # later: download missing files, verify every pin
npx tsx scripts/golden/fetch.ts --verify   # offline check of .cache/golden/sources/ (no contact needed)
```

A download that differs from its pin is discarded and reported (upstream changed). Downloads stop
reading at 20 MB. Keep the local files: the runner verifies them before importing; re-pinning a source
invalidates its recorded calls. The Project Gutenberg entry has a `trim` (keep the text between the
`*** START OF` and `*** END OF` lines); a missing marker fails the download instead of keeping the license
text, and the pin covers the trimmed file.

Review the pins before the first recording, then commit the manifest:

- `git diff scripts/golden/manifest.json` shows every size and SHA-256 that was written.
- Open the Transinformação PDF and confirm the manifest's title, authors and DOI against its first page
  (they could not be checked offline).
- Check that the Gutenberg file starts at the story and holds no license text, and that each HTML file
  holds the article and not site chrome.

## 2. Record (live AI, spends the configured route once)

Preconditions: routes configured in the DEV profile (embedding, summarization, atomic-note-generation,
knowledge-graph-generation, reranking); an empty library with no queued or running jobs; no other
local-model job (the local embedding model runs while recording); no edits under `apps/` or `packages/`
during the run (DEV restarts). Recording needs `MEMORA_GOLDEN_MAX_TOKENS`, a cap on live remote tokens
(input plus output); run a dry run first (below) to size it.

```sh
MEMORA_AI_CASSETTE=record MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/golden-small \
MEMORA_GOLDEN_RUN=scripts/golden/manifest.json MEMORA_GOLDEN_MAX_TOKENS=<n> \
MEMORA_GOLDEN_EXIT=1 MEMORA_DEV_BACKGROUND=1 \
npm run dev -w @app/desktop
```

Before the job supervisor starts, the runner checks the cassette, the DEV database, the files and the
routes, and refuses a library that is not empty or has queued or running jobs (override for a library
that holds earlier golden work: `MEMORA_GOLDEN_ALLOW_NONEMPTY=1`; the pending jobs are then only
reported; `MEMORA_GOLDEN_RESET=1` in section 3 empties a library of golden sources first). Only then does
it change anything, in this order: a `pg_dump` backup of the live database in
`.cache/f0/backups/memora-backup-<timestamp>/` (the run stops if it holds no dump; prove it restores
with `npm run db:restore -- --from <backup> --name <slug>` before the first recording), the live token
cap. A refusal logs `GOLDEN_RUN refused` and quits before any job runs.

It then imports the sources in manifest order (import only; detected structures confirmed as detected;
a source that is already in the library fails the import, so a run always processes new sources),
queues one batch with the full knowledge plan minus `organizeKnowledge` and polls until no job of the
batch is queued or running. `.cache/golden/runs/<ts>/` gets `progress.json` and `summary.json` (backup,
sources, stage outcomes and wall times, AI calls, tokens, durations and `queue_ms` per task from
`ai_task_runs`, routes, settings, cassette counters, ID-free content digests). Without
`MEMORA_GOLDEN_EXIT=1` the app stays open.

The token cap counts input plus output tokens of live calls to remote models, except the OpenAI Decisions
API's: those are counted apart (`cassette.liveDecisionsTokens`) and bounded by the decider's own daily dollar
cap (section 9). The cassette checks the cap before every live call and makes none once it is reached (calls
already running finish, so the total can pass the cap by what they use); the runner cancels the batch at its
next poll (every 5 s) with status `token_limit`. Recording again into the same directory serves recorded calls
and calls the provider only for new ones (new directory = fresh take), so after a `token_limit` stop: reset
the library from Settings, raise the cap and start the same command; the calls already recorded cost nothing.

### Dry run

Before the real recording, record two sources with a small cap into a separate cassette, then replay
and compare them (section 3 and 4) to prove: no cassette miss, no network for AI calls and identical
digests.

```sh
MEMORA_AI_CASSETTE=record MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/dry-run \
MEMORA_GOLDEN_RUN=scripts/golden/manifest.json MEMORA_GOLDEN_MAX_TOKENS=<small cap> \
MEMORA_GOLDEN_ONLY=wikipedia-en-forgetting-curve,plos-one-murre-dros-2015 \
MEMORA_GOLDEN_EXIT=1 MEMORA_DEV_BACKGROUND=1 npm run dev -w @app/desktop
```

`MEMORA_GOLDEN_ONLY` takes top-level manifest keys (a container key runs the whole book). A scratch
profile (`MEMORA_USER_DATA_DIR=<folder>`, with its own routes, for example a local OpenAI-compatible
model) keeps the owner's profile out of it. `apps/desktop/src/main/services/verify-golden-runner.ts`
checks the runner against the real ingestion, hierarchy and job services, a real `pg_dump`, the real
library reset behind `MEMORA_GOLDEN_RESET` and a throwaway PostgreSQL, without AI or network (`cd
apps/desktop && npx tsx src/main/services/verify-golden-runner.ts`). It also runs the verdict-only source
pair mode (section 6) with a fake decider and proves it persists nothing. It does not cover a PDF through
Docling or any real AI call.

## 3. Replay (no provider call, no local model)

Start the same command with `MEMORA_AI_CASSETTE=replay` (no token cap is needed) and
`MEMORA_GOLDEN_RESET=1`, which empties the library of the record run in the same DEV profile, with no
Settings click:

```sh
MEMORA_AI_CASSETTE=replay MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/golden-small \
MEMORA_GOLDEN_RUN=scripts/golden/manifest.json MEMORA_GOLDEN_RESET=1 \
MEMORA_GOLDEN_EXIT=1 MEMORA_DEV_BACKGROUND=1 \
npm run dev -w @app/desktop
```

`MEMORA_GOLDEN_RESET=1` is DEV only (packaged builds refuse it, like the runner), must be exactly `1`, and
excludes `MEMORA_GOLDEN_ALLOW_NONEMPTY`. Without it nothing changes: a library that is not empty is
refused. With it, after the same checks as any run (cassette, DEV database, files, routes) and before the
empty-library check, the runner:

1. lists every root source of the library and proves that each one belongs to the manifest (all of it,
   not only the `MEMORA_GOLDEN_ONLY` subset). A file import is proven by the SHA-256 of the original
   bytes it stored, which must equal a pin of the manifest; the detected divisions under it come with it.
   A web capture, which stores no original bytes, is proven by the capture ID derived from its manifest key.
   A book is proven by its type and title and by each of its chapters being a pinned file of that book.
   A root with no document, no asset and no content under it whose type and title equal a manifest entry
   is also accepted: it is the bare leftover of a golden import that failed before the import persisted
   atomically, and nothing in it can be lost.
   If any source is not proven, nothing is changed and the app quits with
   `GOLDEN_RUN refused: library holds non-golden sources (<count>)`, followed by the first sources and why;
2. takes the run's `pg_dump` backup (the one section 2 describes, taken once and recorded as `backup` in
   `summary.json`), before the reset;
3. runs the same reset as Settings (it keeps AI routes, credentials and installed models; it deletes the
   imported original files and restores the knowledge defaults), before the job supervisor and the
   local-model service start;
4. checks that no source and no note is left, logs `GOLDEN_RUN {"event":"reset",...}` and writes
   `reset: {performed, removedSources, backupPath}` to `summary.json`; then the run continues on the empty
   library. An empty library needs no reset (`performed: false`, no backup path).

The guard proves the sources, not the rest: the reset clears what Settings clears (wiki pages, jobs, AI audit
and monitoring history; prompts return to their defaults), so use the flag in a profile you use for golden
runs. The alternative is the UI: back up, reset the library from Settings, then start the same command
without the flag.

Every AI call is answered from the cassette with the recorded output and token counts; the audit row keeps
the real (near zero) duration and no cost (nothing is spent, so the recorded cost is not replayed; it stays
in the cassette), and its monitoring entry carries `cassette.replayed = 1`. A call the cassette does not
hold fails loudly: the error names the key, the request is saved to `<cassette>/misses/<key>.json` (diff it
against `<cassette>/entries/<k[0..2]>/<key>.json`), and the runner cancels the batch with status
`diverged`.

With `MEMORA_AI_CASSETTE_TIMING=recorded` (record or replay; refused without a cassette) a served entry
first waits its recorded duration inside the lane slot the call holds, and an `embedMany` batch served
whole waits the sum of its entries' durations. A throughput rerun of remote work therefore costs nothing
and still queues and overlaps like the recording. The audit's duration then includes the wait, and the
cassette counters add `timing` and `waitedMs`. In record mode a miss goes live as usual.

Replay is offline for AI task calls only. Route resolution still runs, so an expired Codex OAuth token
is refreshed once (an authentication request, not an AI call), and the Settings actions that test a
provider or list its models do not go through the cassette: do not use them during a run.

## 4. Compare

```sh
npx tsx scripts/golden/compare.ts .cache/golden/runs/<record> .cache/golden/runs/<replay>
```

Exit 0: both runs completed with identical content digests (chunks, notes, note and source relations,
current summaries, entities), stage outcomes and AI calls and tokens per task.

## 5. Matching-quality fixture (the F1a exit criterion)

The ten public roots above show that the pipeline runs; they carry no human labels, so they cannot say
whether matching links the right notes. The matching fixture is the expanded DEV matching benchmark
(`docs/matching-benchmark.md`) as a second golden manifest: 60 synthetic pt-BR roots (11 books with 22
chapters, 49 single articles; 82 records), 40 tuning and 20 held-out roots, with the human labels per root
pair. Held-out: 28 expected and 35 forbidden pairs; tuning: 26 expected and 25 forbidden. The F1a exit
asks for at least 27 of the 28 expected held-out pairs, 0 of the 35 forbidden ones, and matching time per
note at most a third of the v6 baseline (10.4 s, `docs/kpi-golden.md`).

The texts and labels are versioned in `scripts/fixtures/matching-benchmark.json` (synthetic, no third-party
content). Everything derived from it is generated and git-ignored: the build is offline and deterministic,
its pins would only drift if committed, and the generated manifest repeats the fixture's titles. Labels,
partitions and expected ideas never enter a source file.

### Build

```sh
npx tsx scripts/golden/build-matching-fixture.ts           # write the files, the manifest and the mapping
npx tsx scripts/golden/build-matching-fixture.ts --verify  # offline: do the files on disk match the fixture?
```

- `.cache/golden/sources/mf-<id>.md`: 71 Markdown files, one per document or chapter, with the fixture
  text as is. The runner reads sources only from `.cache/golden/sources/<key>.<ext>`, hence the `mf-`
  prefix instead of a folder of their own.
- `.cache/golden/matching-fixture/manifest.json`: manifest `golden-matching-fixture` (books are `Book`
  containers of `BookChapter` files, singles are `StandaloneArticle`), SHA-256 and size computed from the
  bytes just written. The runner's schema requires an HTTPS URL; the placeholder (`*.invalid`) is never
  fetched.
- `.cache/golden/matching-fixture/mapping.json`: benchmark ids, manifest keys, titles, partitions, the
  expected, forbidden and ambiguous root pairs, the nonconceptual sources and `subsets` (manifest keys for
  `MEMORA_GOLDEN_ONLY`: the 40 tuning roots, and the 48 roots a held-out score needs, which are the 20
  held-out roots plus the tuning roots they are paired with).

Changing the fixture file changes the pins, which invalidates recorded cassettes; rebuild only on purpose.

### Record and replay

Same flow as sections 2 and 3, with the fixture manifest and its own cassette folder:

```sh
MEMORA_AI_CASSETTE=record MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/matching-fixture \
MEMORA_GOLDEN_RUN=.cache/golden/matching-fixture/manifest.json MEMORA_GOLDEN_MAX_TOKENS=<n> \
MEMORA_DEV_BACKGROUND=1 npm run dev -w @app/desktop
```

- The run processes the full plan like the small library (summaries, notes, knowledge graph, matching), so
  size the token cap with a dry run on a few roots: `MEMORA_GOLDEN_ONLY=mf-p01,mf-p02,mf-p03`.
- The reset guard (`MEMORA_GOLDEN_RESET=1`) proves a library against the run's manifest. To switch a
  profile between golden libraries, name the other manifests in `MEMORA_GOLDEN_RESET_ALSO` (comma-separated
  paths, only with `MEMORA_GOLDEN_RESET=1`); a source golden in any of them may be removed, anything else
  still stops the run. Example: `MEMORA_GOLDEN_RESET_ALSO=scripts/golden/manifest.json`.
- Leave `MEMORA_GOLDEN_EXIT=1` out and evaluate while the app is still open (the evaluator needs the DEV
  PostgreSQL running), or evaluate the pre-run backup of the next run, which holds this run's library
  (`npm run db:restore -- --from <backup> --name <slug> --keep-running`).

### Evaluate

```sh
npx tsx scripts/golden/evaluate-matching.ts --db <dev-connection.json | scratch-<slug>.json> \
  --label "v7 record" --out .cache/golden/matching-v7.md --json .cache/golden/matching-v7.json [--check]
```

Read-only: the session is `default_transaction_read_only` and the reads run in one read-only, repeatable
read transaction; only a loopback PostgreSQL is accepted. The report holds counts and root ids, never note
text or a password.

- Roots are found by title (the runner imports them with the fixture titles; two roots with one title are
  reported and not scored). A library built by the benchmark controller is found by id instead:
  `--ids .cache/matching-benchmark/manifest.json`.
- A note belongs to its source and a chapter to its book, so note relations and source relations are both
  aggregated to root pairs. A root pair counts as linked when at least one relation of the layer joins it. On a
  library with the relations v2 columns a note relation counts when it is shown (applied or suggested, not
  withdrawn; `scripts/golden/relation-visibility.ts`). Source relations, and the note relations of a library
  restored from a backup taken before relations v2, count by status: `accepted` and `pending_review` count
  (`--statuses` changes that), `rejected` does not. Rejected, archived and superseded notes are not part of the
  library; relations inside one root are ignored.
- Per partition and layer (note relations, source relations, either): relations, linked root pairs,
  expected pairs linked and the ones missing, forbidden pairs linked, unlabelled pairs (bridges, not errors
  by themselves), pairs involving a designated nonconceptual source.
- Cost of the `reranking` task (`--task` for another one), from `ai_task_runs` and, to tell note from source
  matching and to attribute a call to its note, the monitoring record of each call: calls per note, seconds
  per note, input, output and reasoning tokens per call, per library and per partition, source matching per
  matched root, the prompt contract of the calls, failed and replayed calls. Seconds per note divide the
  seconds of all note-matching calls by the notes of the library, the way the v6 baseline does (10.4 s = 176
  calls over 160 notes). `--since` and `--until` window the calls (a library matched in several passes adds
  the passes); then read the partition rows, because the library row still divides by every note.
- Exit criterion: held-out expected and forbidden pairs on the note-relation layer, and seconds per note
  against `--baseline-seconds-per-note` (default 10.4) divided by three. A measure that cannot be decided is
  reported as such: missing roots, or note-matching calls answered from a cassette, whose durations are
  near zero. Time is therefore only judged on a record run; quality is the same in a replay. `--check`
  exits 0 when everything passes, 1 when a measure fails, 2 when none failed but one is undecided.
- **The held-out partition is sealed** (F3 decision D3) until `.cache/f3/freeze/frozen.json` exists (`--frozen`
  names another file): the report and the JSON hold tuning results only, the held-out exit measures read "not
  decided", and `--check` exits 2. The figures quoted below were taken before the seal.

### F3 measurement

The F3 harness (decisions D2 and D3) adds an evaluator gate and four offline scripts; none calls a model.

```sh
# X1 and S1 over the samples (shown relations, applied-only beside; mean and minimum; source report)
npm run golden:evaluate -- --gate f3 --sample S0=<db or stored json> --sample S1=... --live-judge S0,S1 --check
# the offline export the scripts below read: candidate lists, decisions and relations (ids and scores only)
npm run golden:evaluate -- --db <connection.json> --export-relations .cache/f3/m0/<name>-export.json
# the two held-out aggregates gate 0 may read before the freeze, and nothing else
npm run golden:evaluate -- --pre-freeze-feasibility --relations <export.json> --scores <pair-scores.json>
npm run golden:rescore -- --export <export.json> --rule legacy-blend|decider-only:0.65|ranker:max:3.3125 [--parity <stored report>]
npm run golden:recall -- --export <export.json> [--k 20]
npm run golden:reverse-only -- --spike-dataset <dataset.json> --spike-scores <scores.json> --rule max:3.3125
npm run golden:calls -- --summary .cache/golden/runs/<run>/summary.json
npm run golden:calls -- --operations <ops.json> --chunks <n>   # by operation; a row may carry "ranker": true
```

- An export holds the held-out candidate lists too: only the scripts here read it, and they apply the freeze
  guard. Run them from the repository root, where the default paths resolve.
- A relation counts as **shown** (applied, suggested or kept) or **applied** through
  `scripts/golden/relation-visibility.ts`, which reads the relations v2 predicates of
  `packages/db/src/repositories/note-relation-sql.ts` (D9). On a library restored from a backup taken before
  relations v2 (no `band` or `vetoed_at` column) both follow the counted statuses.
- Before the freeze, pair-level output (`rescore`, `candidate-recall`) covers tuning pairs only. `rescore --parity`
  prints whether the rescored root pairs equal a stored report's, and that report's own counts when they do.
- `reverse-only` gives the literal loss of a set of old acceptances (R_v6 from Spike A's files, R_v9 from an
  export), split by same-root pairs, and the adjudicated loss when `--labels` names the panel's verdicts.
- `calls-per-chapter` counts generative calls per chunk and per 30-chunk reference chapter by AI task (a golden
  run summary) or by operation (an export of `ai_task_runs`). Embeddings, the rank and gate operations, the
  interactive and diagnostic operations and rows marked as a ranker's do not count; topic calls are reported
  apart. The F3 note decide on a dedicated ranker is a `reranking` task, like the generative decider's calls,
  and keeps its `relation_decide` operation, which the script does not read as a rank operation. An operation
  row therefore carries `"ranker": true` when a ranker (a local model that writes no text) served it, and a
  row without the flag counts as generative: unmarked, the 58 ranker calls of M2's first X7-REF run (D36's
  7,000-character batches, later set aside by Q8) read 56.8 calls per chapter instead of 30.5 (M2 marked the rows of the profile's local model, which has no `text-generation`). A run
  summary by task has no such flag, so all its `reranking` calls count as generative.
- Parity with published numbers: `rescore --rule legacy-blend` on the end state of v9 sample A or B (an export
  of its backup) reproduces the stored `matching-v9a.json` (24/28) and `matching-v9b.json` (23/28) note
  layers; `reverse-only` on Spike A's stored MLX scores at `max:3.3125` loses 12 of 37; `calls-per-chapter` on
  the golden F1a summary gives 2.51 generative calls per chunk. The unit tests rebuild the first on the real
  fixture mapping and read the stored files for the other two (they skip without them;
  `MEMORA_CACHE_ROOT=<main checkout>/.cache` runs them from a worktree).

### Checked against the old pipeline

The evaluator reproduces the archived result (`docs/archive/matching-benchmark-report.md`) on the newest
benchmark backup, restored into a scratch cluster:

```sh
npm run db:restore -- --from .cache/matching-benchmark/memora-backup-2026-09-09T01-46-23-785Z --name bench-eval --keep-running
npx tsx scripts/golden/evaluate-matching.ts --db .cache/f0/scratch-bench-eval.json \
  --ids .cache/matching-benchmark/manifest.json
npm run db:restore -- --remove --name bench-eval
```

| Measure | Archived report | Evaluator |
| --- | --- | --- |
| Held-out expected pairs, note relations | 27/28 (P03/V01 missing) | 27/28 (P03/V01 missing) |
| Held-out expected pairs, source relations | 27/28 (P09/V03 missing) | 27/28 (P09/V03 missing) |
| Held-out expected pairs, either layer | all 28 | 28/28 |
| Held-out forbidden pairs, both layers | 0/35 | 0/35 |
| Held-out note relations | 57, of which 3 inside one source | 54 between roots |
| Held-out source relations | 35, of which 4 unlabelled bridges | 35, of which 4 pairs unlabelled |
| Tuning expected pairs, notes / sources (economy, floor 0.85) | 23/26, 26/26 | 23/26, 26/26 |
| Source relations in the restored library | 97 (62 tuning, 35 held-out) | 62 tuning, 35 held-out |

The same figures come out by title and by `--ids`. Windowed to the benchmark's validation phase
(`--since 2026-09-09T01:02:08Z --until 2026-09-09T01:18:16Z`, from its manifest) the evaluator finds 30
note-matching calls, one per held-out note, at 11.9 s per note (the 11.9 s of `docs/plan.md`; contract
`atomic-note-matching-v5`), and 121 source-matching calls, as the report says. Without a window the
library reads 46.8 s per note, because the benchmark matched it in four passes.

## 6. Source pair verdicts (the F3 discovery spike)

`MEMORA_GOLDEN_SOURCE_PAIRS=<file>` asks the live source decider of the run's judge mode (shipped: F3's
`sources.decide.pair`, contract `source-relations-v5`; `perRoot`: `sources.decide`, `source-relations-v6`)
about a list of pairs of works and writes every raw verdict. It is DEV only (a
packaged build refuses it) and needs `MEMORA_GOLDEN_RUN`; alone it stops the app with `GOLDEN_RUN refused`.
It persists nothing: no source relation, decision row, run state or explanation, and no library data
changes. The only rows written are the AI audit of the calls themselves, by the AI service; the run
still takes the `pg_dump` backup like any run (section 2).

The file is a JSON list of `{"left": ..., "right": ..., "label": ...}`; `label` is optional. A side is a
top-level manifest key (`mf-f1`, `machado-a-cartomante`; a book is its container key) or the exact title of
a root source. A pair that cannot be resolved (no such root, two roots with one title, a chapter key) is
reported, not fatal; a pair of one root with itself is refused (`same_root`). The file may also be
`{"grouping": "root", "pairs": [...]}` (F4 D21's microbenchmark): under the judge mode `perRoot` the pairs
are covered greedily by the root in most of them (ties: the root the file names first) and each root's pairs
are asked about in one call, as the matcher judges a root; each pair is still reported apart, and only the
group's first pair (`batch.lead`) carries the calls and their usage. The shipped `perPair` asks one pair a call.

Two ways to run it, chosen by the library:

- **Verdict-only** (`MEMORA_GOLDEN_ALLOW_NONEMPTY=1`, a library that already holds every root of the manifest,
  `MEMORA_GOLDEN_ONLY` empty): nothing is imported or processed; the pairs are judged at once. The runner
  refuses it when a manifest root is missing from the library (found by title) or when `MEMORA_GOLDEN_ONLY` is
  set. The app starts only the local-model service in this mode: no job supervisor (jobs left in the library
  stay untouched), integration gateway or vault sync, so nothing else can change the library.
- **After the batch** (an empty library, or `MEMORA_GOLDEN_RESET=1`): the normal run imports and processes the
  manifest; once the batch has settled, the pairs are judged. A batch that ends `diverged` or `token_limit`
  skips them, a failure in this step never discards the batch's summary, and one token cap covers both.

For each pair the request is the one the matcher builds: its uncited note relations, the evidence passages,
`sourceDecisionPrompt`, the same call context (operation `source_relation_matching`, stage `sourceMatching`)
and output budget, and the same single repair when an answer holds malformed items. The answer is read by the
production v5 parser. Calls go through the normal AI service one at a time, so the cassette records them. Use a
fresh cassette directory so the calls are live: a request identical to a recorded one is served from the
cassette (`replayed: true`, its timing is no measurement). Recording needs `MEMORA_GOLDEN_MAX_TOKENS`.
Replaying the same directory against the same library and prompts regenerates the file at no cost. The run
stops calling at a replay miss, at the live token cap, or after three failed calls in a row; the pairs left
are `skipped`.

`.cache/golden/runs/<ts>/source-pair-verdicts.json` (rewritten after every pair, `state: running` then
`finished`) holds `status`, the settings and floors used, the cassette counters, `totals` and one entry per
pair: `status` (`judged`, `invalid_output`, `unresolved`, `same_root`, `no_evidence`, `error`, `skipped`),
the two roots, the request (allowance, output budget, the prompt's source and chunk aliases with their IDs, no
text), each attempt (wall and provider time, input, output and reasoning tokens, run ID, the raw output),
every raw item (type, importance and confidence 0 to 100, evidence aliases, `passesFloors`, `outcome`: `kept`,
`below_floors` or `over_allowance`), the relations the matcher would keep, `verdict` (`related` or
`not_related`) and the relations the library already holds (never shown to the decider). `summary.json` gets
`sourcePairs` with the totals and the path. `outcome` ignores saved relations, so it shows what the decider
said, not what the library holds.

The spike's 79 must-run pairs are in `scripts/golden/source-pairs/` (manifest keys and a join label only, no
fixture text, no expected or forbidden labels). Each file is for the library state it was made from, loaded in
the DEV profile that runs the command (loading a backup into a profile is not part of this mode; `npm run
db:restore` makes a scratch cluster):

| File | Pairs | Library state | `MEMORA_GOLDEN_RUN` | Backup it comes from | Cap (estimate) |
| --- | ---: | --- | --- | --- | ---: |
| `spike-f3-fix3.json` | 30 | FIX3, fixture after the v8 final run | `.cache/golden/matching-fixture/manifest.json` | `.cache/f0/backups/memora-backup-2026-10-15T00-47-37-770Z` | 120000 |
| `spike-f3-fix1.json` | 18 | FIX1, fixture after the v8 first run | the same | `.cache/f1a/backups/memora-backup-2026-10-14T23-17-41-000Z` | 70000 |
| `spike-f3-old.json` | 17 | OLD, the September benchmark library | the same | `.cache/matching-benchmark/memora-backup-2026-09-09T01-46-23-785Z` | 70000 |
| `spike-f3-gold.json` | 14 | GOLD, golden library after `golden-small-v9-a` | `scripts/golden/manifest.json` | `.cache/f0/backups/memora-backup-2026-10-15T14-20-20-933Z` | 80000 |

A pair's request depends on the library's notes and chunks, so a file run against another state of the library
judges a different request. The GOLD backup is the spike run's own pre-run backup: the `04-15-46` backup named
here before reproduces only 11 of the 14 GOLD requests (the library had changed by the time of the spike),
while `14-20-20` reproduces all 14 and FIX3's backup all 30 (T53's proof). The label (`fix3:F1/Q1`) is the
pair ID of the spike analysis. The caps are twice the plan's per-call figures (about 1.5k input tokens on the
fixture, 2.1k on golden, about 0.4k output with reasoning). One run, for example the golden library (repeat
per file with its manifest and cassette folder):

```sh
MEMORA_AI_CASSETTE=record MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/source-spike-gold \
MEMORA_GOLDEN_RUN=scripts/golden/manifest.json MEMORA_GOLDEN_ALLOW_NONEMPTY=1 \
MEMORA_GOLDEN_SOURCE_PAIRS=scripts/golden/source-pairs/spike-f3-gold.json \
MEMORA_GOLDEN_MAX_TOKENS=80000 MEMORA_GOLDEN_EXIT=1 MEMORA_DEV_BACKGROUND=1 \
npm run dev -w @app/desktop
```

## 6b. Note pair verdicts (the F3 decider bake-off)

`MEMORA_GOLDEN_NOTE_PAIRS=<file>` asks the live generative decider (v9, `atomic-note-matching-v9`, the
decide-only contract) about a list of pairs of notes and writes every raw verdict. It is DEV only (a packaged
build ignores it, and the module refuses it) and exclusive: it is refused together with `MEMORA_GOLDEN_RUN`,
`MEMORA_GOLDEN_SOURCE_PAIRS`, the reset, only, allow-nonempty and topics knobs, `MEMORA_PROFILE_RESET`,
`MEMORA_LEGACY_WIPE`, the pilots, the corpus runner and `MEMORA_LOCAL_MODEL_INSTALL`, and the app quits
(`GOLDEN_NOTE_PAIRS refused`). Like the verdict-only source mode the app starts only the local-model service,
and the run takes no backup: the module has no database handle, reads no library and persists nothing. The
only rows written are the AI audit of the calls, by the AI service; the only file is the report.

The file is `{"format": "memora-golden-note-pairs", "version": 1, "notes": {key: {title, idea}}, "pairs":
[{source, candidate, label?}]}`. The notes travel in the file (title and idea statement, which is all the v9
prompt shows), so one run can judge notes of several libraries. Pairs are grouped by `source`: one call per
source note with at most 20 candidates, numbered from 1 in content order (title, then idea; never keys), as the
matcher numbers them. The request is the matcher's: `buildBatchRerankPrompt`, operation
`note_matching_reranking` (and `_repair` for the one repair of the numbers left out or malformed), the matching
settings' `maxRerankOutputTokens`, read by the production parser; a test runs the matcher and compares the two.
The profile's `reranking` route answers (Codex). Use a fresh cassette directory so the calls are live: a
request identical to a recorded one is served from the cassette (`replayed: true`). Recording needs
`MEMORA_GOLDEN_MAX_TOKENS`. The run stops calling at a replay miss, at the live token cap, or after three
failed calls in a row; the pairs left are `skipped`.

`.cache/golden/runs/<ts>/note-pair-verdicts.json` (rewritten after every call, `state: running` then
`finished`) holds `status`, the settings, the cassette counters, `totals`, one entry per call (attempts with
wall and provider time, tokens, run ID and the raw output) and one per pair: `status` (`decided`, `undecided`,
`skipped`, `error`), `score` (the contract's integer 0 to 100), `relationType`, the call and the candidate
number. `scripts/relations/bakeoff-v9.ts` builds the pair list of the bake-off (`inputs`: the label pairs no
recorded v9 decision covers) and merges the report with the recorded verdicts (`merge --report <file>`).

## 7. The Topic Tree Engine under a golden run (F2: G1, the barrier, the profiles)

`MEMORA_GOLDEN_TOPICS` is read only when `MEMORA_GOLDEN_RUN` is set (and never in a packaged build); every
other run behaves as `full` and ignores it, whatever its value.

- `deterministic` (the default in a golden run): the engine places and rebalances but makes no topic AI call
  (no gate, naming, Areas, labels or overview). The run is exactly what it was before F2: one batch, existing
  cassettes replay at 0 misses and keep their timing. `summary.json` records `topics: {mode, arrival: null}`.
- `full`: every topic call runs. F2 measurements use it in `record` mode on a cassette copy, so the extraction
  stays pinned and only the new `topic.*` calls are recorded; later replays must show 0 misses. It needs the
  topic service's job barrier and is refused without it, before anything changes.
- `MEMORA_GOLDEN_TOPICS_ARRIVAL` (only with `full`) decides when topic jobs run. **The topic barrier:** topic
  jobs are held while a source ingests, so the items present at every build and naming call are a function of
  the manifest order and not of lane timing. The import stays one batch: a book's aggregate summary is written
  once every summarization stage of the batch has completed, and each source matches its own notes as soon as
  they exist (F3 D24). `per-source` (the default) paces the batch's jobs: the supervisor is stopped while the
  batch is queued, the jobs of every source after the first are pushed far into the future (`run_after`), and
  each source's jobs are released only after the previous source's jobs have finished and the light lane was
  drained. The heavy lane is idle at every drain, so nothing else can enqueue topic work, and the hold is
  re-armed before the next source runs. The last source's drain follows the whole batch. `batch` keeps the
  single batch unpaced and drains the light lane once after it. Pacing is not neutral for books. Under
  `per-source` a book's catalog run comes right after its own chapters, before its aggregate summary exists, so
  its catalog header (chunk 0) carries no summary and the header's graph output differs from a one-batch run's
  (gate R: 488 entities against 484). A golden run does not queue the catalog-header refresh that would rebuild
  it (After a run), so compare a run only with a reference of the same topics mode and arrival. A drain ends
  after two polls without a queued or running `topic-*` job; a replay miss or the live token cap stops the run
  (`diverged`, `token_limit`) and leaves the topic jobs held. A run needs an idle job queue to start in `full`
  mode. `summary.json` then has
  `topics: {mode, arrival, held, boundaries: [{source, batchId, drainMs, polls}], drainMs, jobs}`.

Measurement profiles ENV-G (golden-small), ENV-F (matching fixture) and ENV-C (the corpus) live under
`.cache/profiles/<name>`:

```sh
npx tsx scripts/topics/env-profiles.ts create env-f --from <stopped DEV userData> [--dry-run]
npx tsx scripts/topics/env-profiles.ts recipe env-f --max-tokens <cap>     # the record and replay commands
npx tsx scripts/topics/env-profiles.ts check env-f
```

`create` clones the stopped DEV profile with `cp -cR` (APFS, so the model weights are not duplicated; the
source is only read and a running one is refused), starts the app once with the DEV-only
`MEMORA_PROFILE_RESET=1` and then copies the cassette (`golden-small-v9-a` to `golden-small-f2`,
`matching-fixture-v9-a` to `matching-fixture-f2`; an existing copy is never overwritten). The reset is the
Settings reset: AI routes, credentials and installed models stay, the library and the settings go, and the app
writes `profile-reset.json` and quits. The knob is refused when packaged, with any other DEV knob that changes
the library, with a value other than `1`, and unless the profile folder is inside `<repository>/.cache/profiles/`
(symbolic links resolved), so the owner's profile can never be reset by it. The script refuses a profile whose
content language is not the one its cassette was recorded with (pt-BR): a replay would miss every prompt.

A profile cloned from the owner's DEV profile has no ranker, so the topic placement gate (`class:decide`)
never decides. `recipe` therefore prints an optional first start with the DEV-only
`MEMORA_LOCAL_MODEL_INSTALL=mlx-qwen3-reranker-0.6b` (and `MEMORA_LOCAL_MODEL_SEED_DIR=<repository>/.cache/models`),
which installs the ranker from the seed folder, creates its AI profile, validates it and routes
`class:decide` to it, then quits after `MEMORA_SMOKE_AUTO_QUIT_MS`. It is idempotent, refused when
packaged or without the seed folder, and must run without `MEMORA_AI_CASSETTE` (the validation scores
real pairs on the local ranker). See "DEV install at startup" in `local-models-and-packaging.md`.

The install changes no existing route: on a profile that already has a ranker, `class:decide` stays on the
first one, and the new ranker gets only its profile. A route pointed at it by hand also needs an active
`class:decide` row in `ai_profile_tasks` on that profile, or it resolves to nothing (M2's GGUF bases).

A ranker's validation holds only for the runtime build it ran on (`memora-mlx-helper@sha256:<hash>` for MLX;
F3 froze the ranker on build `44d081e0…`, the SHA-256 of `native/mlx-helper/.build/release/memora-mlx-helper`).
A start with no `MEMORA_AI_CASSETTE` and no `MEMORA_GOLDEN_RUN` re-validates, in the background, every ranker
whose validation names another build: the smoke test and the 64-pair parity check. Golden, re-match and other
cassette runs never re-validate. On a profile validated on an older build their rank calls fail
`errors.localModels.rankerNotValidated` and matching finds nothing (M2's first golden non-regression replay on
ENV-G). After `npm run mlx:build` changes the helper, start a clone of each base profile once with neither, as
M2 refreshed ENV-F, ENV-G and ENV-C, then clone that clone for the runs:

```sh
MEMORA_USER_DATA_DIR="$PWD/.cache/profiles/<clone of env-g>" MEMORA_SMOKE_AUTO_QUIT_MS=150000 \
MEMORA_CATALOG_HEADERS=off MEMORA_DEV_BACKGROUND=1 npm run dev -w @app/desktop
```

`MEMORA_CATALOG_HEADERS=off` keeps that start from queuing the catalog-header refresh (with no cassette and no
measurement knob it would be on, and it would rebuild headers that lack their summary and extract their graph
again). Give the quit time for the parity check (M2: 150 s on ENV-F and ENV-G, 300 s on ENV-C).

`npm run topics:export -- --db <dev-connection.json | scratch-<slug>.json | postgres url> --name env-f` exports
the tree of a running profile through a read-only session: `.cache/topics/exports/<name>/export.json` (tree,
names, placements, gate log, change-sets, daily metrics, shape audit) and the replay store
`.cache/topics/vectors/<name>.{f32,index.jsonl,meta.json}` (the unit vectors of the current notes in the tree's
embedding space, in import order), which `npm run topics:replay` loads by name.

### The extraction pin and the local-miss policy (F3: D5, D41)

`MEMORA_GOLDEN_PIN` is read only when `MEMORA_GOLDEN_RUN` is set (and never in a packaged build); the E6 runner
(`npm run topics:e2e`) reads it too. `extraction` (the default in both) keeps the recording-era path for
extraction, entity identity and relation-type resolution: strict parse, whole-output repair, no salvage, no
item-level repair, no output schema, the 3,500-character graph batch with 12/12 caps, and the error codes the
answers were recorded under. Every recorded repair of the F2-era cassettes then replays. `off` runs the
product path (schema output, item-level repair, graph salvage, batches by writer locality, which since X7 at
M2 give remote writers the same 3,500 characters and 12/12 caps as local ones, the pin's batch), for a
re-record under F3. `summary.json` records `pin`.

`MEMORA_AI_CASSETTE_LOCAL_MISSES=live` (DEV, golden and E6 runners, with `MEMORA_AI_CASSETTE=replay`) lets a
replay miss on a local runtime (ranker, local writer, local embedder) run live; the answer is recorded into
the cassette copy and counted in `cassette.liveLocalMisses` by task. A miss on a remote runtime still fails.
Non-regression replays after F3 matching merges use it on a copy with the matching entries stripped:

```sh
npm run golden:cassette-nonreg -- --base .cache/golden/cassettes/golden-small-f2 \
  --out .cache/golden/cassettes/golden-small-f2-nonreg-R --strict
```

The copy never overwrites an existing folder (a replay with live local misses records into it, so each sample
needs a fresh copy), leaves the base untouched and writes `nonreg.json` (base, rule version, counts per kind).
The rule (`scripts/golden/cassette-nonreg.ts`, version `matching-strip-v2`, tested against the prompt catalog)
strips the generative note decide, the ranker's note decide, the source judge and the relation typer by their
prompts, whatever the runtime that recorded them. A ranker request is recognised by the `instruction` of its
`{instruction, query, documents}` JSON or of the `{instruction, pairs}` JSON that F3's note decide sends, so the
rank entries of an F3-recorded cassette are stripped too. Extraction, embeddings, the topic calls and the topic
gate's rank calls stay. An entry no rule recognises is kept and reported, and `--strict` refuses to write a
copy that holds one.

The golden-small replay that uses such a copy (gate R's G1; the full script is `.cache/f3/gate-r/run-golden.sh`)
starts on a fresh APFS clone of ENV-G whose ranker validation names the current helper build (above):

```sh
MEMORA_USER_DATA_DIR=<absolute path of the clone> \
MEMORA_AI_CASSETTE=replay MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/golden-small-f2-nonreg-<tag> \
MEMORA_AI_CASSETTE_LOCAL_MISSES=live MEMORA_GOLDEN_RUN=scripts/golden/manifest.json MEMORA_GOLDEN_RESET=1 \
MEMORA_GOLDEN_TOPICS=deterministic MEMORA_GOLDEN_PIN=extraction MEMORA_GOLDEN_RELATIONS=local \
MEMORA_AI_LANES=serial MEMORA_GOLDEN_EXIT=1 MEMORA_DEV_BACKGROUND=1 npm run dev -w @app/desktop
```

`MEMORA_GOLDEN_RELATIONS` is read only in a golden run: `live` (the default) or `local`, which switches relation
remote calls off (a pair with no cached typing is persisted untyped and discovery is deferred). Link jobs drain
one at a time either way. `MEMORA_USER_DATA_DIR` must be absolute, because npm runs the app from `apps/desktop`.
The bar is 0 extraction misses and 0 remote misses (D41), and gate R also required the chunk, note, summary and
entity digests of the G1 deterministic reference; the ranker's note decide runs live and is counted.

An E6 replay with `MEMORA_AI_CASSETTE_LOCAL_MISSES=live` runs its misses on the real models, so it also takes
`--writer-path <installed writer dir>` and `--embedding-gguf <installed .gguf>` (a plain replay installs
placeholder files and refuses both); the run stops before it creates anything when one is missing.

`MEMORA_GOLDEN_SCHEMA_PROBE=<calls>` (1 to 20, with `MEMORA_GOLDEN_RUN`) runs that many structured calls with a
strict `outputSchema` through the normal AI service and the cassette, instead of the manifest: nothing is
imported, no job or topic work starts, the library is not read and no backup is taken (only AI audit rows are
written). `summary.json` gets `probe`: calls, answered, valid and invalid answers, `schema_mode` counts, schema
fallbacks (a backend that refused the strict format) and tokens, with no prompt or answer text. Recording needs
`MEMORA_GOLDEN_MAX_TOKENS`; use a fresh cassette folder so every call is live:

```sh
MEMORA_AI_CASSETTE=record MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/schema-probe-f3 \
MEMORA_GOLDEN_RUN=scripts/golden/manifest.json MEMORA_GOLDEN_SCHEMA_PROBE=12 \
MEMORA_GOLDEN_MAX_TOKENS=30000 MEMORA_GOLDEN_EXIT=1 MEMORA_DEV_BACKGROUND=1 \
npm run dev -w @app/desktop
```

`npx tsx scripts/golden/graph-salvage-share.ts --cassette <folder>...` measures, offline and at no cost, how
many recorded extraction answers the recording-era parse rejects and how many of those the graph salvage keeps
with no further call (counts only, no text).

## 8. The soak and the pre-soak (F3 T62: X6, gate P)

A soak runs a day of an owner's use on a clone of ENV-G (`env-soak`, the Local preset) and checks that no AI
call outlives its deadline, that repairs stay rare, and that nothing wedges. It spends nothing: the remote side
is two fake providers on loopback, so no real provider is called and no cassette is used. It is DEV-only
(refused when packaged, with another DEV measurement knob, or on a profile outside `.cache/profiles/`: it
writes fake provider routes into the AI configuration and the driver imports, edits and deletes library
content).

| Knob | Meaning |
| --- | --- |
| `MEMORA_SOAK_SETUP=1` | Prepares the clone, then quits (below); refused beside any other DEV knob. |
| `MEMORA_FAKE_REMOTE=scripts/soak/plan.json` | Starts the fake providers and routes `class:answer` and `op:relation_explanation` to them. |
| `MEMORA_SOAK=scripts/soak/plan.json` | Starts the driver (needs `MEMORA_FAKE_REMOTE` and the same plan). |
| `MEMORA_SOAK_PROFILE=soak24\|presoak4\|soak7\|soak7-gate` | The plan profile (default `soak24`); `presoak4` is gate P's 4 h run; F4's two below. |
| `MEMORA_SOAK_RUN=<name>` | The run folder `.cache/f3/soak/<name>/` (default `<profile>-<timestamp>`). |

**Profile setup** (`MEMORA_SOAK_SETUP=1`, `dev/soak-setup.ts`). On the clone, with no job, gateway or vault sync started,
it applies the Local preset through the AI service, as the Settings > AI preset button does, then runs the class
tests one by one. It then checks that no call of the product resolves to a real remote provider (every operation,
class and decide route, resolved through the product's own route chain; the soak's fake providers do not count) and
that the default profile is not a real remote one. A remote default profile is the one thing it changes besides the
preset: a task that no route names would use it, so the `write-fast` class's local writer becomes the default, and
the file says so. Remote routes that no call resolves to (the legacy task routes a preset leaves behind) are listed,
not changed. It prints the library (roots, sources, notes) and the model, runtime and test result of each class and
of the judge, writes them to `.cache/f3/soak/setup.json` (`status` `ok`, `blocked` when a model the preset needs is
not installed, `failed` with `problems`) and quits. It can be run again. The soak knobs run the same reach check
when they start, and refuse a profile that still reaches a real provider.

**Fake providers** (`apps/desktop/src/main/services/dev/fake-*.ts`). An OpenAI-compatible fake serves Ask
(`class:answer`: a valid answer that cites the first passage it is given) and a Codex-wire fake serves
relation explanations (`op:relation_explanation`: the Responses protocol as server-sent events behind a DEV
OAuth stub, a fixed dummy credential in a DEV-only credential entry, `NOT_RELATED` at a seeded 2 %). Their
provider configurations carry `treatAsRemote: true`, which one predicate (`isRemoteExecution`) reads for the
lane and for the adapter's deadline mode, so the fakes run under the remote connect, first-byte, stall and
answer-start bounds and the remote totals; without the knob, or packaged, the flag is ignored. Latencies are
drawn from the recorded Codex durations: `npm run soak:latency-fit` writes `.cache/f3/soak/latency-fit.json`
from the golden and fixture cassettes once. Each fake wraps its protocol in the fault decorator
(`fault-decorator.ts`): a third remote kind, such as the Decisions API (plan decision 30), is covered by
wrapping it the same way.

**Driver** (seed 20261021). Every 20 min a public corpus article (`.cache/corpus/wikipedia`) goes through the
real ingestion path; every 10 min an Ask question (P0); every 5 min an explanation is opened through the
service (P0) and every hour a burst of 10; every 2 h a human note edit (re-embed); every 6 h a source is
versioned (an article imported again as a new version) and another is deleted; every 4 h a source whose typing
fails deterministically; 35 s after each outage of the Codex-wire fake an explanation opens, which is the probe
that closes the breaker. Faults (seeded, deterministic per seed and request number): 429 with `Retry-After` 1-10
s (5 %), 503 (2 %), a 25 s stall after the first text (1 %), a first byte at 35 s (1 %), a malformed answer
(0.5 %); a 15 min outage of the Codex-wire fake at hour 6; answers 10x slower on the OpenAI-compatible fake for
5 min at hour 12; the MLX helper is SIGKILLed every 3 h +/- 30 min; a GGUF embedding batch is aborted every 6 h.
The `presoak4` profile adds forced bursts of three consecutive faults of each kind (the retry budget), so every
kind ends a whole call.

**The catalog-header catch-up stays on.** A soak is product behaviour: `MEMORA_SOAK` and `MEMORA_FAKE_REMOTE` are
not measurement knobs for `catalogHeaderPolicy`, the run's `meta.json` records the policy, and the knobs refuse
`MEMORA_CATALOG_HEADERS=off`. The first minutes of an ENV-G clone therefore include the catch-up jobs of its roots.

**Files** in `.cache/f3/soak/<run>/`: `meta.json`, `events.ndjson` (every fake exchange, window, local fault,
driver action and breaker move), `samples.ndjson` (every minute: lanes, jobs, helper RSS, pageouts, event-loop
lag, pool), `task-runs.ndjson` (the `ai_task_runs` rows with the 0057 columns), `articles.ndjson`. Creating a
`STOP` file in the folder ends the run in an orderly way; the app then quits.

**Report.** `npm run soak:report -- .cache/f3/soak/<run> --status` is the health check of a run in progress
(nothing is written). `npm run soak:report -- .cache/f3/soak/<run> [--presoak]` writes `report.md` and
`report.json`: the X6 table (calls past deadline by audit row and by the lane watchdog, repairs per D35 over
the structured calls that count (no injected call, and by plan decision 31(a) none of the local MLX writer's:
lane local, runtime mlx, no enforced schema mode; those are reported apart as information until F4's
constrained decoding), stuck and blocked jobs, pageouts after warm-up, P0 wait, breaker, helper restarts,
remote deadlines), the audited sample of 50 non-injected failures and every wedged slot. With `--presoak` it
asserts, for each injected fault kind on each fake, the attempt (the fake's record: a 429 with `Retry-After`,
a stall that the client left at the stall bound, a first byte that the client left at the first-byte bound)
and the call (its audit row's `deadline_outcome` and error class). Exit code 0 passes, 2 needs a person (the
report says which line), 1 fails.

### The 7-day Hybrid soak and gate S (F4 T89)

F4's soak (`docs/f4-decisions.md`, section "The 7-day soak") runs the Hybrid preset with the real Codex writer
for every writer class and the judge, under a token cap; the rest of this section still holds. The plan profiles
`soak7` (168 h) and `soak7-gate` (gate S, about 5.4 h) carry an `f4` section: `codex.expected` and `codex.cap`
(the driver refuses to run without them; gate S re-freezes them), the zero-token faults in front of the Codex
adapter, the windows of known ground truth, the money window and the Decisions admission (`off`). Their runs
write to `f4/soak/<run>/` under the data root.

| Knob | Meaning |
| --- | --- |
| `MEMORA_SOAK_REAL_WRITER=<codex providerConfigId>` | Admits exactly that Codex OAuth configuration as a real provider (the knobs' need for the fakes, the setup's reach check, the fakes' installation); every other real provider is still refused. With `MEMORA_SOAK_SETUP=1` the setup applies `hybrid` instead of `local` and tests each class with one real call (the token check). Honoured only unpackaged, on a profile under the data root's `profiles/`. |
| `MEMORA_SOAK_DATA_ROOT=<absolute folder>` | The `.cache` that holds the profiles, the corpus, the run folders and the local-model lock (the main checkout's), so the soak runs from a worktree outside the checkout on a frozen branch (D1). Without it everything is `<workspace>/.cache`. |
| `MEMORA_SOAK_ADMIT_DECISIONS=1` | Admits the opt-in Decisions decider for one run (decision 32's remote check): it needs the real writer, a plan profile that allows Decisions, `MEMORA_RELATIONS_DECISIONS=on`, a key file only its owner can read and a stated cap of at most the product's US$0.50 a day. Off by default; `soak7` says `off`. |

A soak refuses `MEMORA_DEV_POWER_BLOCKS` and `MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS` (its windows drive the
power override, and it keeps the shipped relations values). Outside a soak, `MEMORA_DEV_POWER_BLOCKS=<word>,...`
(F4 T75, ignored when packaged) replaces the machine's activity and power readings for the Gardener's duty cycle,
"only idle" and "only on AC" with 10-minute blocks from the start, repeated (`idle`, `active`, `battery`,
`battery-active` or `real`); an unknown word stops the start. On a run whose meta has an `f4` section,
`npm run soak:report` adds E1-E5 with their exposure, the injection ledger with its 0-bytes check, the token
budget and the load ledger; `--count-local-writer` counts every structured call of the local writer in the repair
rate (C4's re-run). `zsh scripts/soak/watch-soak.sh <plan profile> <run directory> <app pid>` is the hourly
watchdog: it creates `STOP` on a stop check's FAIL line and ends the run at the profile's duration plus one hour.

## 9. Relation re-match runs and the F3 DEV probes (T52b, T63)

`MEMORA_RELATIONS_REMATCH` (`apps/desktop/src/main/services/dev/relations-rematch.ts`) matches again the notes a
measurement profile already holds, with no extraction, so a quality sample spends no extraction quota (D5). It
first waits for the composite vectors of the hierarchy roots that have none (T53f). It then clears the relation
state, checks that the library holds the pinned notes and releases the roots one at a time behind a visibility
fence, through the DEV heavy job `relation-rematch`. Each root's notes are decided with the call ingestion makes,
and its link job (typing, persistence, promotion, discovery) is queued. The next root is released as soon as the
root's decide step has committed. When the link jobs have drained, the run writes `summary.json` and the app
quits. Lanes are serial unless `MEMORA_AI_LANES=product`, and the catalog-header refresh is off (the summary's
`catalogHeaders.jobs` must be 0).

The run is refused:

- when packaged;
- beside another DEV knob that imports, wipes, resets or probes a library (the golden runner and its pair
  modes, the resets, the legacy wipe, the matching pilot and benchmark, the lane and explanation probes, the
  typer check);
- outside `.cache/profiles/`, or without the DEV PostgreSQL sidecar;
- without `MEMORA_AI_CASSETTE` (recording also needs `MEMORA_GOLDEN_MAX_TOKENS`);
- when the library's notes are not the pinned ones (the digest of the profile's kind in
  `.cache/f3/m0/digests.json`, or `MEMORA_RELATIONS_REMATCH_DIGEST`).

Start every sample from a fresh clone of a base whose ranker validation names the current helper build
(section 7), with its own cassette copy.

| Knob | Meaning |
| --- | --- |
| `MEMORA_RELATIONS_REMATCH=arrival:<seed>\|burst` | `arrival:manifest` (or `arrival:S0`): tuning roots, then held-out roots, each in manifest order. `arrival:<seed>` shuffles each partition with that seed (S1 20261031, S2 20261032). `burst`: every root is visible from the start (the batch reference). |
| `MEMORA_RELATIONS_REMATCH_MAPPING=<file>` | The fixture mapping that gives the partitions; an ENV-F profile defaults to `.cache/golden/matching-fixture/mapping.json`. |
| `MEMORA_RELATIONS_REMATCH_ROOTS=<file>` | The roots to release, titles or IDs in manifest order (a JSON list or `{"roots": [...]}`); default: every root with notes. |
| `MEMORA_RELATIONS_REMATCH_BACKGROUND=matched` | The roots left out count as already matched (TP-C200): their source state and each note's k-th vector cosine (D19) are seeded. |
| `MEMORA_RELATIONS_REMATCH_DISCOVERY=off` | No nearest-source discovery and no judge call; typing and promotion stay on (M1). |
| `MEMORA_RELATIONS_REMATCH_CANDIDATES=record` | Turns the clone's debug mode on, so every note's candidate list is kept for the evaluator's export. |
| `MEMORA_RELATIONS_REMATCH_LINK=drain\|product` | `drain` (the default, quality samples): one link job at a time, first in first out, no coalescing and no daily counting. `product` (X3's timing runs, with `MEMORA_AI_LANES=product`): the app's own link pool, small-source coalescing and daily call counter. |
| `MEMORA_RELATIONS_REMATCH_P0_PROBE_MS=<n>` | X3's P0 probe: one query embedding at P0 every `n` ms (at least 1,000) while the run works. |
| `MEMORA_RELATIONS_HELPER_BATCH=<1-64>` | The MLX ranker's helper batch for this DEV start (B1 runs batch 1 against the product's 16), recorded in the summary. The rank request carries it in its parameters, so it changes the cassette key. |
| `MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS=1\|2` | Source discovery's neighbours for this DEV start (F4 C2 runs two before D21's rule may change the shipped value), recorded in the summary; any other value stops the start. |
| `MEMORA_RELATIONS_REMATCH_DIGEST=<sha256>:<notes>` | The pinned notes digest, for a profile whose kind has none recorded. |
| `MEMORA_RELATIONS_REMATCH_OUT=<folder in .cache>` | Where `summary.json` goes (default `.cache/f3/rematch/<run>/`). |
| `MEMORA_RELATIONS_REMATCH_DRAIN_MS=<n>` | How long the link jobs may take to drain (default 2 h). |
| `MEMORA_AI_CASSETTE_TIMING=recorded` | Recorded timing (section 3), for X3's throughput reruns. |

The X1 quality sample S0 runs on a fresh copy of `matching-fixture-f2` with its matching entries stripped
(section 7), so ranking, typing and judging run live:

```sh
MEMORA_USER_DATA_DIR=<repository>/.cache/profiles/<fresh clone of env-f> MEMORA_WORKSPACE_ROOT=<repository> \
MEMORA_RELATIONS_REMATCH=arrival:manifest MEMORA_RELATIONS_REMATCH_ROOTS=.cache/f3/freeze/x1/roots-s0.json \
MEMORA_RELATIONS_REMATCH_CANDIDATES=record MEMORA_RELATIONS_REMATCH_OUT=.cache/f3/rematch/<run> \
MEMORA_AI_CASSETTE=record MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/<run> \
MEMORA_GOLDEN_MAX_TOKENS=<cap> MEMORA_DEV_BACKGROUND=1 npm run dev -w @app/desktop
```

A timing run adds `MEMORA_AI_LANES=product` and `MEMORA_RELATIONS_REMATCH_LINK=product`, plus
`MEMORA_AI_CASSETTE_TIMING=recorded` wherever it serves recorded entries. TP-C200 also sets
`..._BACKGROUND=matched` and `..._P0_PROBE_MS=10000`. The summary's `p0Probe` holds the caller's wall time per
probe; the queue wait X3 reads is `ai_task_runs.queue_ms` of the rows whose stage is `rematch_p0_probe`. Each
probe embeds a text that names the run, so a cassette never serves it: a replay that probes needs
`MEMORA_AI_CASSETTE_LOCAL_MISSES=live`.

`npm run relations:rematch-report -- .cache/f3/rematch/<run>/summary.json [--out report.md]` reads only the
summary. It shows:

- the run's identity;
- X3's clock: T0 is the first decide admission, T1 the last relation, typing, veto or source-relation commit,
  and W the span normalized to 200 notes;
- the timeline of releases, decides and links;
- the AI calls by task, lane and class, and the cassette counters;
- the relations and typings;
- the flags that make a run unusable, among them: an outcome other than completed, a cassette miss, the live-token cap
  reached, failed AI calls or link jobs, a root not released or not committed, link jobs that did not drain, a
  notes digest that differs, a catalog-header refresh that was on or queued jobs, a root with no composite
  vector.

M2 used a run only when it completed with 0 cassette misses and 0 failed link jobs, and its calibration identity
check (R1) passed. A run that reaches its cap is void (its pairs persist untyped): raise the cap and run again
on the same cassette copy, whose recorded calls are served at no cost.

### The Decisions decider in a run (plan decision 30)

`MEMORA_RELATIONS_DECISIONS=on` (`dev/decisions-dev-options.ts`; ignored when packaged) turns the Decisions
decider on without the Settings opt-in. It still needs the Hybrid or Cloud preset: a DEV run with the knob and no
preset chosen counts as Hybrid, and the Local preset still refuses it. `MEMORA_RELATIONS_DECISIONS_KEY_FILE=<file>`
reads the OpenAI Platform key from a file instead of the secure store. `MEMORA_RELATIONS_DECISIONS_CAP_USD=<n>`
replaces the day's US$ cap, up to the schema's maximum. A Decisions quality sample is the S0 command above plus
`MEMORA_RELATIONS_DECISIONS=on`, `MEMORA_RELATIONS_DECISIONS_KEY_FILE=<key file>` and
`MEMORA_RELATIONS_DECISIONS_CAP_USD=1.00` (M2's DS0).

The cassette records and replays Decisions requests like any adapter's, and a replay needs no key. Their live
tokens are counted in `cassette.liveDecisionsTokens`, apart from `liveTokens`: a Decisions request carries about
3,000 input tokens, so counted against `MEMORA_GOLDEN_MAX_TOKENS`, the cap meant for the writer, they would stop
a sample after about a hundred requests. Decisions tokens do not count toward `MEMORA_GOLDEN_MAX_TOKENS`, but
once that cap is reached the cassette refuses every live call, Decisions requests included; the dollar cap bounds
what the Decisions API spends.

In F3 the key came from `.env`'s `OPENAPI_KEY` (the owner's test key, D6). For each run M2 wrote it into a
mode-600 file under `.cache/f3/m2/secrets/`, deleted the file afterwards and scanned the run folder and the
cassette for the key. Never print or log the key. The test key is used only on measurement profiles whose
text is synthetic or public (the fixture, the golden and the corpus libraries: D6 and plan decision 30), never on
the owner's DEV library.

When the decider may not decide or fails (no key, the day's cap, an open breaker, a provider error such as 429
`insufficient_quota`), the matcher falls back to the local ranker. M2's DS0 measured the MLX ranker that way, so
check that the run's Decisions requests succeeded (its AI calls and `cassette.liveDecisionsTokens`) before you
read it as a Decisions sample.

### Other F3 DEV probes

| Knob | What it does |
| --- | --- |
| `MEMORA_DEV_LANE_PROBE=<report path in .cache>` | B5: decide-sized calls on synthetic text at concurrency 1, 2 and 3 (about 40 calls, 60k tokens), stopping at the first level that sees a 429 or a failed call. The job supervisor stays stopped, and the app quits at the end. |
| `MEMORA_DEV_EXPLAIN_PROBE=<report path in .cache>` | T59: on a clone inside `.cache/profiles/`, opens relations as the Note page does, one after the other and again, and measures the time to the first text and to the validated explanation, and whether the second open makes no call. `MEMORA_DEV_EXPLAIN_PROBE_OPENS` sets the number of opens (10 by default, at most 50; about 10k tokens on a remote writer). It writes the explanations and withdraws the relations the writer finds unrelated. |
| `MEMORA_TYPER_CHECK=<pairs file>` | The typer's position-bias check (gate F): panel pairs typed in both orders by the product's typing step. It persists nothing, writes `.cache/f3/typer-check/<time>/typer-check.json` and quits. `MEMORA_TYPER_CHECK_PROMPT=<candidate revision>` and `MEMORA_TYPER_CHECK_ORDERS=content` serve decision 29's typer experiment. |

All three are refused when packaged. The lane and explanation probes are also refused with a cassette or with
another measurement run.

## 10. The local-writer benchmark (F4 T69, record only)

`npm run bench:writer -- plan|run` replays the generative calls of a golden cassette (default `golden-small-f2`)
on a local writer through the product's adapter, validation, salvage and repair, and records per item the first
answer's validity, repairs, salvage, tok/s, time to first text, memory, swap and the yield against the recorded
answer (decisions 25 and 26: nothing is adopted). `plan` runs no inference; `run --arm <arm>` replays one arm,
holds the data root's `LOCAL_MODEL_BUSY` for the whole run and can resume. `--data-root` (or
`MEMORA_BENCH_DATA_ROOT`) names the `.cache` it reads and writes (default `<cwd>/.cache`).
`npm run bench:writer-report -- <run dir>...` writes the tables per arm and contract; with `--out` on a file that
holds its marker comments (`docs/spikes/local-writer-benchmark.md`) only the block between them is rewritten.

## After a run

The runner pauses nothing and `summary.json` has no `automation` entry: the legacy wiki automation is
unwired and nothing creates its policies or schedules (F2 D3), so a run leaves no legacy state behind.
The pre-run backup is in `summary.json` (`backup.path`).

`summary.json` also records `catalogHeaders: {refresh, reason, jobs}`. Unless `MEMORA_CATALOG_HEADERS=on`
forces it (below), a golden run does not queue the catalog-header refresh of plan decision 27, whose calls a
recording does not hold: `refresh` is `off` with reason `golden_run` (or `switch`), and `jobs`, the
`catalog-header` jobs created since the app started, must be 0. Re-match runs and the E6 runner record
`catalogHeaders` too, with reason `relations_rematch` and `topics_e2e`. `MEMORA_CATALOG_HEADERS=off` turns the refresh off on any start, and `on` forces it on even in a
measurement run (a live proof on a recorded profile). The soak refuses `off` (section 8).

## Cassette key and offline guarantee

Key = SHA-256 of a canonical JSON (sorted keys) of: task type, model identity (provider, model, runtime,
adapter, repository, revision, quantization; never the local path), effective parameters, the composed
input, the adapter instruction and the legacy `metadata.outputSchema` when present (the `outputSchema` of
F3's schema output is never part of the key: the entry body stores it for audit, so recorded entries keep
serving). UUIDs become positional placeholders,
so a fresh library with new chunk IDs yields the same keys and recorded outputs map to the new IDs. The
cassette wraps `AiModelAdapter.run`/`runStreaming` via the registry: remote and local generation, local
embeddings and reranking alike (local calls are recorded: GPU embeddings are not bit-stable and replay
must not load models). Replay never delegates a task call. Since F3 an `embedMany` batch is served and
recorded per text under the single-call key (D37). An MLX ranker's `pairs` request carries the helper batch
in its parameters, so the batch is part of the key. The OpenAI Decisions adapter is registered like any other
adapter, so its requests are recorded and replayed too (a replay needs no Decisions key).

## What is and is not deterministic

Deterministic in replay: AI outputs and token counts, import order, serial job order, chunking and
conversion of the pinned bytes with the same converter versions. Not deterministic: wall times, AI
durations, UUIDs, timestamps, and anything that changes a prompt (prompt, route, parameter or converter
changes, approximate vector-search ties), which surfaces as a loud cassette miss, never a silent live
call. A recording samples the model once; a new recording is a new baseline.
