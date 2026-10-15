# F1a measurements (2026-10-15)

Dated measurements of the F1a pipeline (decision-only matching `atomic-note-matching-v8`, lossless
feasibility gate, `relation_decisions`, notes embedded at creation, one judgment per pair with a generative
decider, deadlines and classified retries, notes active at birth, no claims, one chunk graph pass). Route:
`openai-codex` / `gpt-5.6-luna`, reasoning low; local GGUF Qwen3-Embedding-0.6B. Baseline:
`docs/kpi-golden.md`. Evaluator and fixture: `docs/golden-library.md` section 5.

## Matching fixture (60 roots, 82 records, 138 notes)

The first run recorded the whole pipeline into `.cache/golden/cassettes/matching-fixture-f1a`. The later
runs served extraction (summaries, notes, graph, embeddings) from that cassette, so all three runs hold the
same 138 notes; only matching differed. Reports: `.cache/golden/matching-f1a*.md`.

| Run | Held-out, note layer | Tuning, note layer | Notes or sources (held-out) | Forbidden | Calls | Seconds per note |
| --- | --- | --- | --- | --- | --- | --- |
| 1. v8 as built (later notes invisible to earlier ones) | 24/28 | 20/26 | 27/28 | 0/35, 0/25 | 120 | 2.94 |
| 2. notes embedded at creation, both directions asked | 24/28 | 22/26 | 27/28 | 0/35, 0/25 | 135 | ~4.3 |
| 3. final: one judgment per pair | 22/28 | 21/26 | 27/28 | 0/35, 0/25 | 116 | **2.96** |

- Final run: 575 pairs judged once each (0 asked in both directions), 0.84 calls per note, call p50/p95
  3.39/5.52 s, 708 input, 330 output and 124 reasoning tokens per call (v6: ~1,044 output tokens per call).
- Source matching: 6.2 calls and 5.6 s per root (v6 golden: 15.4 s per root).
- The old pipeline reached 27/28 held-out on the note layer with a different extraction of the same texts
  (`docs/archive/matching-benchmark-report.md`).

## Golden library (10 roots, 197 chunks, 160 notes)

Re-recorded with the F1a pipeline (`.cache/golden/runs/2026-10-15T00-47-40-446Z`). Summaries and notes were
served from the F0 cassette (same prompts), so the 160 notes are the ones of the v6 baseline; the knowledge
graph and matching ran live.

| Task | F0 (v6) calls / min / output tokens | F1a calls / min / output tokens |
| --- | --- | --- |
| knowledge-graph-generation | 312 / 37.0 / 273,977 | 230 / 24.1 / 177,503 |
| note matching | 176 / 27.7 / ~184,000 | 151 / 11.4 / ~64,800 |
| generative calls per chunk | 3.06 | 2.51 |

- Wall time 79.8 → 40.0 min (summaries and notes replayed here; they took 6.8 min live in F0).
- Note matching: **4.29 s per note** (p50 4.14 s, p95 7.97 s, 429 output tokens per call) against 10.4 s
  in v6: 41% of the baseline, short of the ≤1/3 target that the fixture meets (2.96 s). The golden notes
  are longer and keep more feasible candidates per call. The remaining gap is being analysed.
- 105 note relations (v6: 91), 1 source relation (v6: 2), 484 entities (v6: 565, no claims).

### Where the golden 4.29 s per note goes

From the recorded calls (exact token counts; robust per-call model: 1.20 s + 5.3 ms per visible token +
8.9 ms per reasoning token, R² 0.91; input size has no measurable effect). Full analysis: `docs/spikes/f1a-matching-latency.md`.

| Component | s/note | Share |
| --- | --- | --- |
| Fixed cost per call (151 calls) | 1.14 | 27% |
| Reasoning tokens (164 per call, `low` is the route's floor) | 1.38 | 32% |
| Explanation text and wrapper (562 explanations) | 0.59 | 14% |
| JSON keys, quotes and decimal scores | 0.40 | 9% |
| Decision values | 0.33 | 8% |
| Backend tail (unexplained) | 0.45 | 10% |

- 270 of the 562 explanations sat on verdicts that can never be accepted; at most 105 reached a persisted
  relation.
- Predicted for a decide-only compact contract (`[alias, score 0-100, type]`): 3.29 s/note on the golden
  library (medium confidence) and about 2.25 on the fixture; adopted as decision 16 with explanations
  written on demand.

## Why the note layer reads 22-24 (diagnosis)

- Extraction sampling: the F1a run extracted different notes for the same roots, and the four missing
  pairs lost their bridge notes (for example W5 has 1 note instead of 2, M3 1 instead of 2). Per candidate,
  hybrid components and decider scores match the old pipeline statistically (decider P(score ≥ 0.65) on
  expected held-out pairs 0.73 vs 0.76).
- Decider noise: re-drawing decider scores from the old pipeline's own re-ask statistics, the old pipeline
  reaches ≥27/28 in about 17% of samples (mean 25.4); these notes give a mean of 22.2. Runs 1-3 vary by two
  pairs on identical notes, within that noise.
- One defect found and fixed: a note was embedded only when it was matched, so inside a batch the earlier
  note never saw later ones and every pair was judged from one side (`0fb523c`). Old profiles also carried a
  fake `reranking` tag on generative models, which made the decider ask both directions (`ae32471`).
- Not the cause: the v8 contract, the gate, the decision cache, the per-note limit, retrieval, the graph
  pass on notes being off.

The exit was re-based on these facts (decision 15 in `docs/plan.md`).

## Other F1a exit criteria

| Criterion | Evidence |
| --- | --- |
| Injected sibling failure does not delay others | `phase4:e2e` batch release check; F0 fix `8bbf734`, `63e54ef` |
| 0 new orphan roots | atomic import (`ef5db73`); each reset between runs proved the library held only the 82 fixture records |
| Interactive imports produce chunks and notes | Second-brain default when a writer route is ready (`da9bf8e`, `50960b8`) |
| A 200-link page makes ≤2 IPC calls per cycle | call-counting test: 2 on the first cycle, then 1 |
| Ask during import: 0 timeouts, waits for at most one call | interactive priority and `ActiveDeadline` tests (`dcfc7b5`) |

## Robustness seen in the runs

- One source-matching call ran 90 s on a stream that kept sending non-progress events; the watchdog now
  counts only progress and an answer must start within 30 s (`5d65a4b`); the decide-class total is 45 s.
- One source-matching stage failed on invalid model output; deterministic failures now fail once instead of
  being retried (`dcfc7b5`).
