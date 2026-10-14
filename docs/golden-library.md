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
