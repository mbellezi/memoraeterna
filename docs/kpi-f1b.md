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

## Source matching: one judgment per pair and the compact verdict v5 (decision 17)

`source-relations-v5` returns `[from, to, type, importance 0-100, confidence 0-100, chunks, chunks]` items with
no prose; each source pair is judged once; raw scores are stored, so floors are re-tuned without new calls;
explanations are written on open. Extraction and note matching were served from cassettes (pinned notes).

| Measure | v4 (prose) | v5, floors 0.85/0.80 | v5, floors 0.75/0.85 (`recommended-v2`) |
| --- | --- | --- | --- |
| Fixture seconds per source (A / B) | 20.25 (FIX3), 19.7 (FIX1) | 16.21 / 16.51 | same calls |
| Golden seconds per source | 15.3 | — | **10.85** (p50 call 2.04 s) |
| Output tokens per call (incl. reasoning) | ~235 | ~90 | ~98 (golden) |
| Fixture source layer, held-out expected (A / B) | 27 / 27 of 28 | 23 / 23 | **26 / 27** |
| Fixture source layer, tuning expected (A / B) | 26 / 25 of 26 | 23 / 23 | 26 / 26 |
| Forbidden (held-out, tuning) | 0, 0 | 0, 0 | 0, 0 |
| Held-out bridges (A / B) | 6-8 | 0 / 0 | 0 / 2 |

- The new floors were chosen on sample A's tuning partition only (rule fixed before reading held-out:
  maximise tuning expected with 0 forbidden, then fewest bridges, then highest floors), frozen, and then
  applied to held-out and to sample B. v5 ranks pairs as well as v4 (tuning AUC 0.97-0.998) but scores
  them lower. The result has no margin: under ±2-3 points of score noise, held-out reaches 27/28 in 20-60% of
  draws. The owner accepted it (2026-10-15); the F3 discovery design replaces this path.
- Fixture time is −20% (the F1b bar was ≤16.2 s; samples 16.21 and 16.51); golden is −29%.
- The only expected pair missed permanently, Q3/Q5, never enters the 6-pair shortlist (also missed by v4).

## F3 discovery spike (decision 17)

DEV-only verdict mode of the golden runner (`MEMORA_GOLDEN_SOURCE_PAIRS`, nothing persisted), v5 verdicts on
the pairs design E would send to the judge that had no recorded verdict:

- Fixture library (32 pairs, all valid answers, ~2 s per call): Q3/Q5 is judged related (supports 92/94, kept);
  all 13 reachable forbidden pairs never judged before are rejected with no item; 2 unlabelled pairs fall below
  the floors.
- Golden library (14 pairs): the two strongest note-linked pairs are judged related (80/98 and 75/95, kept); the
  third (70/72) falls below the floors but design E promotes all three from their note relations without a
  call; none of the 11 other pairs is accepted.
- Not run: the September benchmark library (OLD), which would need loading into the DEV profile.
