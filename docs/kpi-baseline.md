# KPI baseline (F0)

Measured on 2026-10-14 with `npm run kpi` on restored backups in scratch PostgreSQL clusters
(`.cache/f0/scratch-*`). The live DEV database is empty (decision 13) and was never read. These are the
numbers the refactoring must beat; they are not targets. Full per-dataset reports (aggregates only, no note
text) are in `.cache/f0/kpi-<name>.md` and `.json`; regenerate them with:

```sh
npx tsx scripts/db/restore-backup.ts --from <backup dir | .dump> --name <slug> --keep-running
npm run kpi -- --db .cache/f0/scratch-<slug>.json --out .cache/f0/kpi-<slug>.md --json .cache/f0/kpi-<slug>.json
```

## Datasets

| Name | Source dump | Dump date | Schema | Content |
| --- | --- | --- | --- | --- |
| owner | `automatic-wiki-20260912/dev-clean-wiki-before-a8.dump` (sha256 `027186b2f002`) | 2026-09-12 | 42 of 44 | The owner's real library after the 2026-09-09 reset: 13 Portuguese uploads, 0 notes, no wiki |
| benchmark | `matching-benchmark/memora-backup-2026-09-09T01-46-23-785Z` (sha256 `66268a1fc450`) | 2026-09-09 | 23 of 44 | Synthetic pt-BR matching fixture, four matching passes, no wiki tables yet |
| wiki-teste | `wiki-teste/database.dump` (sha256 `9333dfcf3b05`) | 2026-09-10 | 30, migrated to 44 | The benchmark library plus QA artifacts and 22 legacy wiki pages; used only for wiki structure |

`wiki-teste` is not the owner's library (see `.cache/f0/datasets.md`). Its scratch copy was migrated to the
current schema only so that the wiki queries could read the current columns. Every figure is for a small
library: there is no real library of useful size, so nothing here calibrates the Topic Tree Engine.

## Library

| Measure | owner | benchmark | wiki-teste |
| --- | --- | --- | --- |
| Sources (roots) | 13 (2) | 82 (60) | 86 (62) |
| Types | 11 DocumentSection, 2 AcademicPaper | 49 StandaloneArticle, 22 BookChapter, 11 Book | 49 StandaloneArticle, 24 BookChapter, 12 Book, 1 AcademicPaper |
| Chunks | 10 | 82 | 86 |
| Notes (all `pending_review`) | 0 | 150 | 151 |
| Note relations / source relations | 0 / 0 | 196 / 97 | 196 / 97 |
| Entities / embeddings (1024) | 82 / 42 | 769 / 305 | 769 / 305 |

## Processing: wall time per stage

Seconds, p50 / p95, executed stages only (artifacts reused from an earlier run are not counted). Wall time
runs from the first start to completion, so it includes retries and the waits between them.

| Stage | owner (n) | benchmark (n) |
| --- | --- | --- |
| chunking | 0.12 / 0.14 (7) | 0.11 / 0.12 (134) |
| summarization | 7.4 / 9.0 (6) | 5.4 / 7.7 (83) |
| embedding | 0.70 / 1.4 (7) | 0.46 / 0.52 (136) |
| atomicNotes | 12.2 / 15.2 (6) | 6.95 / 10.4 (72) |
| knowledgeGraph | 74 / 110 (7) | 60 / 112 (81) |
| atomicNoteMatching, sourceMatching | unknown (6 each) | unknown (205 each) |

Ingestion runs: owner 12 succeeded and 6 failed, benchmark 453 succeeded. Queue wait (created to started)
p50 / p95: owner 734 / 1541 s, benchmark 1457 / 2110 s. Succeeded run wall time p50 / p95: owner 91 / 592 s,
benchmark 0.01 / 563 s (most benchmark runs only reused artifacts). Job latency from creation to finish is
dominated by that queue wait, for example 1458 s p50 for benchmark `ingestion` jobs.

## AI usage

Succeeded-call duration p50 / p95 in seconds; tokens are the sums the providers reported. Route:
`openai-codex / gpt-5.6-luna / remote` for everything except embeddings (`local-gguf`
Qwen3-Embedding-0.6B). Cost is unknown for every remote call (`cost_estimate` is null) and 0 for local
embeddings. Reasoning tokens are part of the output tokens.

| Task | Dataset | Calls | Duration | Input tokens | Output tokens | Reasoning tokens |
| --- | --- | --- | --- | --- | --- | --- |
| reranking | benchmark | 1,835 | 6.9 / 16.4 | 2,838,016 | 653,036 | 289,345 |
| reranking | owner | 26 | 24.3 / 27.8 | 32,483 | 33,359 | 3,712 |
| knowledge-graph-generation | benchmark | 316 | 20.1 / 28.7 | 240,630 | 243,012 | 37,034 |
| knowledge-graph-generation | owner | 31 | 19.5 / 33.1 | 27,308 | 24,924 | 3,696 |
| atomic-note-generation | benchmark | 72 | 6.9 / 10.4 | 50,140 | 21,143 | 3,065 |
| summarization | benchmark | 73 | 5.7 / 7.8 | 25,877 | 17,603 | 1,035 |
| embedding (local) | benchmark | 2,550 | 0.09 / 0.12 | 146,665 | none | none |

Benchmark total: 4,846 calls and 20,025 s of call time, of which reranking is 13,997 s (70%). Owner total:
335 calls and 1,344 s; 18 summarization calls failed. Repair or retry share among calls that report a retry
index: knowledge graph 35 of 316 (benchmark), source matching 44 of 1,341, summarization 0 of 62 and
atomic notes 0 of 72.

## Matching (the v6 contract)

One reranking call per note, then one reranking call per source pair attempt. The benchmark library was
matched in four passes with different settings, so per-note totals add the passes; the per-call latency is
the figure comparable with the 11.9 s per note in `docs/plan.md`.

| Measure | benchmark | owner |
| --- | --- | --- |
| Note matching calls / distinct notes | 494 / 150 (3.3 per note) | 26 / 26 |
| Seconds per note call, p50 / p95 | 14.2 / 18.1 | 24.3 / 27.8 |
| Seconds per note, all passes | 46.5 | 24.4 |
| Source pair calls / distinct source roots | 1,341 / 60 (22 per root) | none |
| Seconds per source pair call, p50 / p95 | 3.8 / 12.1 | none |
| Seconds per source root, all pairs | 117 | none |
| `atomic-note-matching` span per source, p50 / p95 | 31.6 / 66.9 (197) | none |
| `source-matching` span per source, p50 / p95 | 36.1 / 78.8 (205) | none |

## Wiki structure (legacy, wiki-teste)

The other two datasets have no wiki pages. The legacy wiki is wiped when the Topic Tree Engine lands
(decision 4); this is the "before" picture only.

| Measure | Value |
| --- | --- |
| Live pages | 22: 7 human collections, 7 human topics, 2 human syntheses, 6 AI topics |
| AI pages without a parent (orphan roots) | 6 of 6 AI pages |
| Depth / fan-out | max depth 1 (17 pages at depth 0, 5 at depth 1); 3 internal pages, 19 leaves, children p50 1, max 3 |
| Current notes in a membership of a live page | 0 of 151 |
| Sources with a source TOC page | 0 of 86 |

Organization runs: wiki-teste 12 (6 failed: 5 `organization.errors.invalid`, 1 `organization.errors.context`;
3 applied, 2 rejected, 1 sample), owner 2 (1 applied, 1 failed `organization.errors.context`). Maintenance
runs: wiki-teste 9 (3 no change, 2 sample, 2 applied, 1 rejected, 1 failed `maintenance.errors.invalid`),
owner 1 (no change). No run was waiting for review. Failed jobs in the benchmark: 3 knowledge graph (2
`knowledge_graph_output_invalid:schema_validation`, 1 `errors.relationTypes.invalidOutput`), 2 source
matching (`errors.sourceRelations.invalidOutput`), 1 note matching (`errors.matching.rerankingFailed`).
No stuck jobs, queued jobs overdue or orphaned running ingestion runs in any snapshot.

## Instrumentation added

Migration `0043_wall_clock_instrumentation` adds `ingestion_run_stages.attempts`, `attempt_started_at` and
`ended_at`, and `ai_task_runs.queue_ms` and `attempt` (null means unknown, `attempts = 0` means not
recorded). New runs record:

- the start of every stage, including the matching stages whose start was never stored before, the end of
  each attempt however it ended (completed, skipped, failed, canceled or interrupted) and the attempt count;
- the AI queue wait from admission to the start of execution, and the zero-based retry index that pipeline
  callers report (0 first try, 1 first repair; Ask, organization and maintenance report none).

Verified by restoring the benchmark backup into a new scratch cluster and applying the pending migrations
(23 to 44 applied; row fingerprints of `ai_task_runs`, `ingestion_run_stages` and `jobs` unchanged, new
columns null or 0), and by `npm run db:wall-clock:verify -w @app/db` on an empty database.

## Not measurable yet

- Queue wait, stage attempt windows and retry counts: every historical row predates migration 0043. Wave 3
  runs through the DEV app produce the first values; the `kpi` report shows them automatically.
- Wall time of the matching stages and of `conversion`, `structureDetection`, `structureReview` and
  `materialization`: the first group had no recorded start, the second is completed as reused at plan time
  while the real conversion runs at import and is not timed by stage rows. Matching spans exist only in
  diagnostic mode.
- Jobs store no start time (`locked_at` is cleared at finish), so only creation-to-finish latency is known.
- v6 matching latency on the current code at scale, local reranker latency per pair, and golden-library
  pipeline timings: wave 3 through the DEV app.
- Cost of remote calls, and any baseline for a Topic Tree (no memberships or source TOCs exist in any
  dataset); a library large enough for tree calibration comes from the public corpus, not these backups.
