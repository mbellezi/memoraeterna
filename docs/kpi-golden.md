# Golden library baseline (F0, 2026-10-14)

Measured with the golden runner (`docs/golden-library.md`) in the owner's DEV profile, recording
every AI call into a cassette. These are dated measurements of the pre-refactoring pipeline, not
rules. Raw data: `.cache/golden/runs/2026-10-14T18-18-12-216Z/summary.json` and
`.cache/golden/kpi-record.md` (`npm run kpi`, taken before any reset).

## Dataset

`scripts/golden/manifest.json`: 10 public roots (12 files, pt-BR and English): two Wikipedia
articles (web capture), a PLOS ONE paper (PDF, 17 sections), a Transinformação article (PDF), a
Wikibooks chapter, Machado de Assis' *O Alienista* (book, 3 chapters) and *A Cartomante*, Poe's
*The Tell-Tale Heart*, O. Henry's *The Gift of the Magi* and a Turing Way page. Plan: full knowledge
minus `organizeKnowledge` (legacy wiki paused).

| Output | Count |
| --- | --- |
| Sources (roots) | 30 (10) |
| Chunks | 197 |
| Atomic notes | 160 |
| Note relations | 91 |
| Source relations | 2 |
| Summaries | 26 |
| Entities | 610 |

## Record run

- Wall time **79.8 min**; 30 of 30 ingestion runs succeeded; 0 stalled stages.
- **2,477 AI calls**: 1,877 embeddings (local GGUF Qwen3-Embedding-0.6B), 312 knowledge-graph,
  220 reranking (note + source matching), 41 summarization, 29 atomic-note generation (all
  generative calls: `openai-codex` / `gpt-5.6-luna`, reasoning low).
- Tokens: 968,676 input; 547,595 output and 77,497 reasoning (output reported by 600 calls).
  Cost is unknown: the Codex route is a subscription and reports no price.
- **602 generative calls for 197 chunks** (3.1 per chunk, about 92 per 30-chunk chapter), in line
  with the F0 estimate of 90-130.

Where the time goes (AI time is serial, so it is nearly the whole run):

| Task | Calls | Total | Call p50 / p95 |
| --- | --- | --- | --- |
| knowledge-graph-generation | 312 | 37.0 min | 7.1 / 11.5 s |
| reranking (matching) | 220 | 30.2 min | 8.1 / 11.0 s |
| atomic-note-generation | 29 | 3.5 min | 7.6 / 10.3 s |
| summarization | 41 | 3.3 min | 4.5 / 7.9 s |
| embedding | 1,877 | 2.8 min | 0.08 / 0.13 s |

- AI queue time is 0: the supervisor runs one job at a time, so jobs wait in the **job queue**
  instead: ingestion run queue wait p50 27 min, p95 53 min.
- Knowledge graph stage: attempt p95 156 s; 5 runs retried after invalid model output
  (`knowledge_graph_output_invalid:schema_validation`), 54 retries reported in total.

## First measurement of matching v6

v6 asks for an explanation for every reranked candidate (`atomic-note-matching-v6`).

| Measure | v5 (benchmark, 2026-09) | v6 (golden, full) |
| --- | --- | --- |
| Seconds per note | 11.9 | **10.4** (176 calls, 160 notes) |
| Call p50 / p95 | 11.9 s avg | 8.5 / 11.7 s |
| Output tokens per call | 593 | **~1,044** |
| Reasoning tokens per call | 256 | ~153 |
| Source matching | 5.4 s per pair | 15.4 s per root (44 calls, 10 roots) |

The extra output (explanations, mostly for rejected candidates) did not raise per-note time on
this small library, but it is the work F1a removes (decision-only contract).

## Replay determinism

- **Dry run (2 sources, 19 runs):** replay from the cassette finished with 0 misses, 0 provider
  calls, 86 s instead of 1,175 s, and identical digests for chunks, notes, note relations
  (digested as unordered pairs), source relations, summaries, entities, stage outcomes and tokens.
- **Full library:** the replay diverged after 606 of 2,477 calls, at an entity-identity
  confirmation prompt whose candidate list differed. Cause: knowledge-graph failures were retried
  with wall-clock backoff; in replay every call is instant, so other jobs ran before the retry,
  the canonical entity state differed and the prompt changed. Fixes are scheduled: classified
  retries and deterministic requeue order (F1a), schema-constrained output (F3), exact candidate
  search with stable ties (F3). Re-record after F1a. The cassette was then re-recorded in place:
  2,311 calls served (93%), 166 new live calls, 23.8 min, same outputs (160 notes, 91 note
  relations, 2 source relations); the live DEV library holds this full golden state.

## Defects the golden runs exposed (all fixed)

| Defect | Commit |
| --- | --- |
| Import-only capture plans resolved twice (captures and Obsidian imports failed) | `a5a30c8` |
| Docling emits NUL for math minus signs; PDF imports failed in PostgreSQL | `c8a6fb1` |
| Import persistence not atomic; a failure left orphan sources | `ef5db73` |
| Fragment web captures stored empty documents; matching blocked by failed siblings | `8bbf734`, `63e54ef` |
| Prompt aliases and candidate order followed UUIDs, so prompts were not reproducible | `ac51c62` |
| HTML file fragments converted to empty Markdown and empty content deduplicated | `166115b` |

Open (scheduled): note relations store endpoints sorted by UUID, so directed relation types lose
their direction (F3).
