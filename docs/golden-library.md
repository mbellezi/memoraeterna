# Golden library: record, replay and compare

The golden library is a small public corpus (`scripts/golden/manifest.json`: 10 roots, 12 files,
pt-BR and English, PDF, HTML, Markdown and plain text, one multi-chapter book) processed by the real
pipeline. An AI cassette records every AI call once and replays it at zero cost, so pipeline changes
are compared on identical inputs. DEV-only: packaged builds refuse cassettes and the golden runner.
The repository keeps only the manifest; files, cassettes, backups and runs live in `.cache/`
(git-ignored). A cassette holds full prompts and outputs, so `MEMORA_AI_CASSETTE_DIR` must be a folder
inside `.cache/`; anything else is refused.

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
cap, and the pause of the legacy wiki automation (policies and maintenance schedules). A refusal logs
`GOLDEN_RUN refused` and quits before any job runs.

It then imports the sources in manifest order (import only; detected structures confirmed as detected;
a source that is already in the library fails the import, so a run always processes new sources),
queues one batch with the full knowledge plan minus `organizeKnowledge` and polls until no job of the
batch is queued or running. `.cache/golden/runs/<ts>/` gets `progress.json` and `summary.json` (backup,
sources, stage outcomes and wall times, AI calls, tokens, durations and `queue_ms` per task from
`ai_task_runs`, routes, settings, cassette counters, ID-free content digests). Without
`MEMORA_GOLDEN_EXIT=1` the app stays open.

The token cap counts input plus output tokens of live calls to remote models. The cassette checks it
before every live call and makes none once it is reached (calls already running finish, so the total can
pass the cap by what they use); the runner cancels the batch at its next poll (every 5 s) with status
`token_limit`. Recording again into the same directory serves recorded calls and calls the provider only
for new ones (new directory = fresh take), so after a `token_limit` stop: reset the library from
Settings, raise the cap and start the same command; the calls already recorded cost nothing.

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
apps/desktop && npx tsx src/main/services/verify-golden-runner.ts`). It does not cover a PDF through
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
  aggregated to root pairs. A root pair counts as linked when at least one relation of the layer joins it;
  statuses `accepted` and `pending_review` count (`--statuses` changes that), `rejected` does not. Rejected,
  archived and superseded notes are not part of the library; relations inside one root are ignored.
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

## After a run

The runner leaves the legacy wiki automation paused on purpose (that code is frozen until it is
replaced) and never resumes it. `summary.json` lists what it paused (`automation.pausedPolicies`,
`automation.pausedSchedules`). To restore it, use Resume on those policies in the Automation screen and
re-enable those schedules in Maintenance. The pre-run backup is in `summary.json` (`backup.path`).

## Cassette key and offline guarantee

Key = SHA-256 of a canonical JSON (sorted keys) of: task type, model identity (provider, model, runtime,
adapter, repository, revision, quantization; never the local path), effective parameters, the composed
input, the adapter instruction and the request schema when present. UUIDs become positional placeholders,
so a fresh library with new chunk IDs yields the same keys and recorded outputs map to the new IDs. The
cassette wraps `AiModelAdapter.run`/`runStreaming` via the registry: remote and local generation, local
embeddings and reranking alike (local calls are recorded: GPU embeddings are not bit-stable and replay
must not load models). Replay never delegates a task call.

## What is and is not deterministic

Deterministic in replay: AI outputs and token counts, import order, serial job order, chunking and
conversion of the pinned bytes with the same converter versions. Not deterministic: wall times, AI
durations, UUIDs, timestamps, and anything that changes a prompt (prompt, route, parameter or converter
changes, approximate vector-search ties), which surfaces as a loud cassette miss, never a silent live
call. A recording samples the model once; a new recording is a new baseline.
