# F1b measurements (2026-10-15)

Dated measurements of F1b. Method as in `docs/kpi-f1a.md`: extraction (summaries, notes, graph, embeddings)
is served from a copy of the previous cassette, so every run holds the same notes and only matching calls the
provider. Route: `openai-codex` / `gpt-5.6-luna`, reasoning low.

## Note matching: decide-only compact contract v9 (decision 16)

`atomic-note-matching-v9` returns `[n, score 0-100, type]` per candidate and no prose; decide calls are sent
without the reasoning summary (the backend accepted the lean request on all 170 live calls of the first
sample; no fallback was needed).

### Golden library (160 notes, the v6 baseline notes)

| Measure | v6 (F0) | v8 (F1a) | v9 (F1b) |
| --- | --- | --- | --- |
| Seconds per note | 10.4 | 4.29 | **2.75** |
| Call p50 / p95 | 8.5 / 11.7 s | 4.14 / 7.97 s | **2.82 / 4.67 s** |
| Output tokens per call (incl. reasoning) | ~1,044 | 429 | **239** |
| Note matching calls | 176 | 151 | 151 |
| Persisted note relations | 91 | 105 | 108 |

v9 is 26% of the v6 time per note (target ≤1/3). Run: `.cache/golden/runs/2026-10-15T04-26-47-527Z`.

### Matching fixture (138 notes, pinned)

| Run | Held-out, note layer | Held-out, notes or sources | Tuning, note layer | Forbidden | Seconds per note |
| --- | --- | --- | --- | --- | --- |
| v8 final (F1a) | 22/28 | 27/28 | 21/26 | 0/35, 0/25 | 2.96 |
| v9 sample A | 24/28 | 27/28 | 21/26 | 0/35, 0/25 | **2.08** |
| v9 sample B | 23/28 | 27/28 | 21/26 | 0/35, 0/25 | **2.34** |

Both v9 samples sit in the v8 range on the note layer (22-24/28, decider noise) and keep 27/28 on notes or
sources and 0 forbidden. Reports: `.cache/golden/matching-v9a.md`, `.cache/golden/matching-v9b.md`.

## Reading and placement

| Measure | Result | Target |
| --- | --- | --- |
| `objects.locate` p95 | 0.75 ms (fixture library), 0.90 ms (seeded 30,000 notes) | ≤50 ms |
| `notes.page` p95 | 2.28 ms (fixture library), 3.15 ms (seeded, 187,274 relations, hubs of 400) | — |
| Location of a source or note | 0 clicks on its page, 1 from a card, search, graph, recents or wiki | 0-1 click |
| Token contrast | 326 pairs pass AA in light and dark | AA |

## Source matching (not yet changed)

Source matching still makes about 6 calls per root (1,516 input and ~230 output tokens per call) and holds the
fixture's 27/28 on notes or sources; its plan is being measured separately.
