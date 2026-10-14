# Spike A: local relation decider (go/no-go)

2026-10-14, branch `refactoring`, phase F0. Can a small local reranker replace the remote LLM that
decides which candidate notes are related, at acceptable quality and speed?

## Decision

**GO (conditional) for a local reranker, MLX first.** The case is speed and cost. On quality the
reranker is equivalent to the old pipeline and to the GGUF fallback on this benchmark, not better,
and the quality evidence is thinner than the headline numbers suggest (see Evidence limits).

| Role | Runtime | Verdict |
| --- | --- | --- |
| Default | MLX `Qwen3-Reranker-0.6B` (bf16) on the Swift helper, both directions scored, max | GO |
| Fallback | GGUF `Qwen3-Reranker-0.6B` Q8_0 via `createRankingContext` (no MLX build, non-Apple-Silicon) | GO, same quality, 1.3x to 1.8x slower |
| Rejected | GGUF `bge-reranker-v2-m3` Q8_0 | NO-GO: 18/28 expected and 3 forbidden pairs on held-out |
| Not needed for speed | Decision-only generative route (the plan's fallback) | At most an optional gray-zone escalation, informed by Spike A2 |

Conditions:

1. Score both directions of every pair and take the max. One direction misses the plan's quality
   bar (MLX 25/28, GGUF 26/28 held-out). This condition was written with the held-out result in
   view, so the held-out numbers confirm it and are not a clean estimate (see Directions).
2. The threshold is provisional. MLX log-odds are coarse (steps of 0.06 to 0.125) and the lowest
   held-out expected pair sits exactly on the chosen threshold. Recalibrate on owner-labelled pairs
   in F3 and use a hysteresis band.
3. The plan's F3 target of at most 5% loss of today's reverse-only acceptances is not met: the
   recommended default loses 12 of 37 (32%), and lowering the threshold does not fix it
   (Direction stability). F3 has to solve this, for example with the gray-zone escalation.
4. This synthetic benchmark cannot separate the reranker from embedding cosine, and the frozen
   instruction is fitted to its decoy design.

GO rule (`docs/plan.md`, F0 exit): p50 at most 75 ms/pair (4-minute goal for 200 notes) or 150
ms/pair (8-minute goal). The plan also sets the quality bar for matching (KPIs in section 8, F1a
and F3 exits): fixture at least 27/28 expected pairs and 0/35 forbidden, and for F3 at most 5%
loss of today's reverse-only acceptances. The report applies that bar to the held-out split with
every choice frozen on tuning:

| Rule | Held-out expected / forbidden | Fixture bar (at least 27/28, 0/35) | Loss of the 37 reverse-only acceptances (target at most 5%) |
| --- | --- | --- | --- |
| MLX Qwen3, both directions | 27 to 28 / 28, 0/35 (28 on a tie, 27 one step higher) | pass | 32% (12) |
| GGUF Qwen3, both directions | 27/28, 0/35 (28 at a threshold 0.02 lower) | pass | 38% (14) |
| MLX Qwen3, one direction | 25/28, 0/35 | fail | 51% (19) |
| GGUF Qwen3, one direction | 26/28, 0/35 | fail | 49% (18) |
| GGUF bge, either rule | 17 to 18/28, 3/35 | fail | 54% to 59% |
| Old pipeline (reference) | 27/28, 0/35 | pass | n/a |

The old LLM verdict alone (`rerank_score >= 0.65`) finds 28/28 held-out and 26/26 tuning. The
pipeline's 27/28 and 23/26 come from its extra blended-score gate: old LLM at least 0.65 and final score at least 0.6
reproduces both numbers at root level, although 7 tuning rows pass both gates and were not
accepted (5 same-root pairs, P01/P02 and R3/R1), so the production rule is not exactly that gate.

Latency passes the per-pair rule for every runtime (single-pair p50 36 ms MLX, 45 ms GGUF Qwen3,
18 ms bge). The 4-minute goal for 200 notes is tighter than that rule suggests at the recommended
shortlist of about 20 candidates scored both ways: 3.6 minutes on MLX at the mean, 4.3 minutes if
every note took its own p95. GGUF Qwen3 needs 6.6 to 7.7 minutes and meets only the 8-minute goal
(Latency).

## Setup

- Apple M4 Max, 64 GB, macOS 26.7.1, Node 24.18.0, node-llama-cpp 3.19.0, MLX Swift 0.31.6 and
  MLX Swift LM 3.31.4 in `native/mlx-helper` (`score`, protocol 1). The machine was not idle
  (load average about 1.5 to 3.9), so timings are upper bounds.
- Artifacts are in `.cache/models/` (pins in `scripts/spikes/models.json`, all Apache-2.0). The
  SHA-256 of the main files was recomputed for this report and matches the pins:

| Name | Source @ revision | File, bytes | SHA-256 |
| --- | --- | --- | --- |
| qwen3-reranker-0.6b-mlx | Qwen/Qwen3-Reranker-0.6B @ e61197ed4502 | model.safetensors, 1,191,588,280 | 27cd75a405b9c1b46b59abfd88aaa209e6fed2a1972cde9b70e7659537c5e65b |
| qwen3-reranker-0.6b-q8_0-gguf | ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF @ a02f48bb4f05 | 639,153,184 | 22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48 |
| bge-reranker-v2-m3-q8_0-gguf | gpustack/bge-reranker-v2-m3-GGUF @ 3093af03b1a6 | 635,676,416 | a43c7c9b11a4c1517e5bf95151960e1621d1b72f7a493364b01e386cf1aaa1d3 |

Qwen3 scores `softmax(logit_no, logit_yes)[yes]` after the model-card prompt (GGUF: context 2048,
model-card template; bge: default path). The helper was rebuilt (memory caps) mid-run; rescoring
gave bit-identical scores.

## Method

- **Data.** The synthetic matching benchmark: 60 roots, 150 notes, 40 tuning and 20 held-out
  roots. Candidates are the old pipeline's own shortlists: tuning = `economy` phase (the frozen
  configuration; 2,298 rows, 19.1 candidates per note), held-out = `validate` phase (598 rows,
  30 new notes against the whole library). The 7,240 directed pairs scored per runtime are all
  judged rows of the four phases plus their reverses.
- **Note text.** `Title`, `Idea` and the first 400 body characters, one labelled line each (about
  300 tokens per pair). Query = source note, document = candidate note.
- **Labels.** Human expected and forbidden root pairs (tuning 26/25, held-out 28/35), with the
  benchmark's partition rule. A root pair scores the max over its note pairs, either direction,
  same-root pairs ignored; a pair never in a shortlist scores minus infinity ("not retrieved").
- **Freezing.** The instruction is picked on tuning. Each decider's threshold is the midpoint of
  the optimal plateau on tuning: no forbidden root pair, then the most expected pairs (log-odds
  for rerankers). Held-out data only measures, with one exception: the direction condition was
  written with the held-out result in view (see Directions).
- **Directions.** Compared on tuning: as retrieved (one direction), max of both, mean of both.
  One direction found 24/26 and max and mean both found 25/26: a one-pair difference, which is
  weak evidence either way. Max was kept for its wider tuning plateau (0.88 against 0.63
  log-odds). The condition that both directions are required rests mainly on held-out (MLX one
  direction 25/28, below the plan's bar) and on tuning-only direction asymmetry (Direction
  stability). Present the held-out 28/28 as confirmation, not as a clean estimate of a rule
  chosen blind. Validate it again on the F3 owner-labelled pairs.
- **Old judge.** "Yes" = `rerank_score >= 0.65`; "accepted" = the stored relation: agreement, not
  truth. Root-level numbers are the quality evidence; with 26 to 28 pairs per split, one or two
  pairs is not significant, and no confidence interval is reported because the intervals are
  degenerate when the classes separate perfectly.

## Instruction (tuning split only)

| Instruction | Found (of 26) | Root AUC | AUC vs old verdict |
| --- | --- | --- | --- |
| `mechanism` (frozen) | 24 | 0.997 | 0.910 |
| `relation` | 23 | 0.995 | 0.904 |
| `study` | 22 | 0.992 | 0.919 |
| `default` (model-card retrieval text, control) | 20 | 0.989 | 0.913 |

Ranked by pairs found at zero forbidden, then root AUC, then AUC against the old verdict. Frozen
text: "Given a note (Query), decide whether the Document note makes a claim about the same
underlying mechanism, rule or phenomenon, so that a careful reader would link the two notes.
Shared names, titles, vocabulary, catalogs or credits do not count." The gap to `relation` is one
pair, so the pick is weakly supported.

The frozen text is fitted to the synthetic benchmark's design. It copies the benchmark's decoy
archetype (names, titles, catalogs, credits) into the prompt, and 56 of the 60 forbidden-pair
rationales are phrased around a missing "mechanism". The tuning forbidden pairs are mostly "names
and titles in a program or catalog" (21 of 25); the held-out decoys are the same archetype
(reference-only content 28, index or catalog-only text 7), and 21 of the 28 held-out expected
pairs share their rationale with one of seven tuning mechanism families (the other 7 are labelled
unseen paraphrases). Held-out therefore cannot show whether the instruction generalises, and "any
relation-specific text beats the default" holds for this benchmark only. Re-select the
instruction on the F3 owner-labelled pairs, including same-topic, different-claim negatives,
before treating it as the product default.

## Root-level quality

Threshold fixed on tuning; "both" = max of the two directions. Margin = score of the lowest
held-out expected pair minus the threshold; a pair passes at `>=`, so margin 0 passes on a tie.
AUC is over the labelled root pairs that reached the decider.

| Decider | Threshold | Tuning found / forbidden | Held-out found / forbidden | Lowest held-out expected pair (margin) | AUC tuning / held-out |
| --- | --- | --- | --- | --- | --- |
| MLX Qwen3, one direction | 3.3125 (p 0.965) | 24/26, 0/25 | 25/28, 0/35 | A3/A5 0.50 (-2.81) | 0.996 / 1.000 |
| **MLX Qwen3, both** | 3.3125 | 25/26, 0/25 | **28/28, 0/35, on a tie** | A2/A5 3.3125 (0.00) | 0.998 / 1.000 |
| MLX Qwen3, mean of both | 1.3125 | 25/26, 0/25 | 28/28, 0/35 | P01/V01 2.06 (+0.75) | 0.997 / 1.000 |
| GGUF Qwen3, one direction | 3.05 | 24/26, 0/25 | 26/28, 0/35 | A3/A5 -0.12 (-3.17) | 0.996 / 1.000 |
| GGUF Qwen3, both | 3.16 | 25/26, 0/25 | 27/28, 0/35 | A2/A5 3.143 (-0.019) | 0.998 / 1.000 |
| GGUF bge, one direction | -1.36 | 21/26, 0/25 | 18/28, 3/35 | A2/A5 -6.23 (-4.87) | 0.951 / 0.696 |
| GGUF bge, both | -1.32 | 22/26, 0/25 | 17/28, 3/35 | F3/F5 -5.11 (-3.79) | 0.938 / 0.714 |
| Cosine (`vector_score`) | 0.62 | 25/26, 0/25 | 26/28, 0/35 | P03/V01 0.574 (-0.044) | 0.998 / 1.000 |
| Old LLM `rerank_score` alone (0.65 gives the same) | 0.50 | 26/26, 0/25 | 28/28, 0/35 | P03/V01 0.85 (+0.35) | 1.000 / 1.000 |
| Old pipeline, note level (production rule) | n/a | 23/26, 0/25 | 27/28, 0/35 | n/a | n/a |
| Old pipeline, source level | n/a | 26/26, 0/25 | 27/28, 0/35 | n/a | n/a |

- **MLX both is 27 to 28 of 28, decided by one tie.** The lowest held-out expected pair, A2/A5,
  scores exactly the threshold (3.3125). MLX log-odds come from bf16 logits: 405 distinct values
  over 7,240 pairs, adjacent steps 0.0625 to 0.125 near the threshold. The next expected pair
  (P01/V01) sits one step higher at 3.375, so a threshold one step up gives 27/28. Across the
  whole tuning plateau (2.875, 3.75] the held-out result is 28/28 up to 3.3125, 27/28 up to
  3.375 and 26/28 above (a diagnostic, not a way to pick the threshold). Re-picking the threshold
  from the batch-1 scores gives 3.375 and 27/28 (Latency, batch note). GGUF both scores the same
  pair at 3.143 against its threshold 3.163, a miss by 0.02, and is 28/28 for any threshold up to
  3.143. The one-pair gap between MLX both and GGUF both is therefore one borderline pair, a tie
  against a near miss. MLX both, GGUF both and the old pipeline (27/28) are equivalent in quality.
- **Mean of both is the less fragile both-direction rule on held-out.** It has the same tuning
  result (25/26) and 28/28 held-out with a 0.75 margin, also 28/28 with batch-1 scores. It was not
  chosen because its tuning plateau is narrower; compare max and mean on the F3 pairs.
- **One forbidden pair sets the tuning threshold.** F1/F4 scores 2.875 (old LLM score 0.0); the
  next-highest tuning forbidden pair scores 1.0. Held-out, the highest forbidden pair that reaches
  the decider scores 1.875 (P07/V05) with max of both, so the held-out plateau is (1.875,
  3.3125] and the two plateaus overlap only in (2.875, 3.3125].
- The MLX one-direction misses (W3/W5 3.00, A1/A5 2.13, A3/A5 0.50) come from threshold
  strictness, not ranking: every held-out expected pair ranks above the worst held-out forbidden
  pair (-1.13). Tuning misses: P02/P03 and L2/L3 (1.5 and 1.6).
- Only 18 of 25 tuning and 8 of 35 held-out forbidden pairs ever reach a decider; the rest are
  never in a shortlist, so "0 forbidden" is weak evidence, and a root AUC that counts the
  unretrieved pairs as the lowest scores is inflated. The AUC column therefore uses only pairs
  that reached the decider (held-out: 8 forbidden pairs). It is 1.000 for the Qwen3 rows and
  cosine only because those classes separate; it carries no interval.
- Cosine is a strong baseline here. The old LLM verdict alone beats the old production rule (28/28
  against 27/28; 26/26 against 23/26), because the rule also requires the blended final score
  (0.6 retrieval, 0.4 LLM) to reach 0.6.
- Inside the stratum cosine already passes (cosine at least 0.62: 274 tuning, 94 held-out rows)
  the AUC against the old verdict is 0.72 for MLX against 0.70 for cosine on tuning, and 0.83
  against 0.66 on held-out. Some information beyond cosine, but only 17 "no" rows held-out.

## Note level

| Decider | AUC vs old verdict (tuning / held-out) | Candidates surviving | Survivors per note (mean) | Notes with none | Tuning survivors by root-pair label: expected / unlabelled / same-root / forbidden |
| --- | --- | --- | --- | --- | --- |
| MLX, one direction | 0.910 / 0.927 | 6.6% / 9.5% | 1.27 / 1.90 | 49/120, 12/30 | 92 / 6 / 54 / 0 |
| MLX, both | 0.919 / 0.927 | 9.2% / 12.4% | 1.77 / 2.47 | 36/120, 11/30 | 125 / 12 / 75 / 0 |
| GGUF Qwen3, one direction | 0.912 / 0.933 | 6.6% / 9.2% | 1.27 / 1.83 | 49/120, 12/30 | 96 / 4 / 52 / 0 |
| GGUF bge, one direction | 0.844 / 0.787 | 6.4% / 8.9% | 1.23 / 1.77 | 49/120, 9/30 | 62 / 27 / 58 / 0 |
| Cosine | 0.916 / 0.949 | 11.9% / 15.7% | 2.28 / 3.13 | 28/120, 9/30 | 139 / 19 / 116 / 0 |
| Old pipeline (accepted) | n/a | 6.0% / 9.5% | 1.16 / 1.90 | 45/120, 12/30 | 80 / 1 / 58 / 0 |

The MLX one-direction rule keeps 83 of the old pipeline's 139 tuning relations, adds 69 and drops
56 (held-out: 42 shared, 15 added, 15 dropped); both directions keep 105 and add 107. Edges will
differ from the old pipeline's, but unlabelled survivors stay few and none hits a forbidden pair.

## Direction stability

- MLX a-to-b against b-to-a over 3,620 pairs: Pearson 0.82, Spearman 0.70, mean gap 1.8 log-odds.
  At the threshold 110 pairs pass both ways and 218 in either, so 50% of accepted pairs pass in
  one direction only (GGUF Qwen3 51%, bge 62%). On the 3,067 pairs between tuning notes only
  (no held-out data) the figures are the same: Pearson 0.81, 51% in one direction only (GGUF
  Qwen3 53%, bge 62%). On the 780 pairs the old pipeline judged both ways, the old LLM scores
  correlate 0.81 / 0.82 (Pearson / Spearman) and MLX 0.78 / 0.77: about as direction-sensitive as
  the LLM judge, so scoring both directions is needed.
- The old pipeline accepted 139 relations on tuning; 37 (27%) in one direction while the reverse
  was judged and rejected: 20 on expected cross-root pairs and 17 same-root note pairs (notes of
  one source). MLX one direction keeps 18 of the 37 in the old direction (13 also in the
  reverse), accepts only the reverse for 7 and neither direction for 12. The max of both
  directions keeps 25 and loses 12 (32%): 8 same-root pairs and 4 on expected root pairs. GGUF
  Qwen3 both directions keeps 23 and loses 14 (38%). Of all 139 old acceptances, MLX both loses 34
  (24%).
- The plan's F3 target is at most 5% loss. The metric is not defined there; the reading used here
  is "neither direction reaches the max-both threshold". Lowering the threshold does not reach the
  target: MLX loses 27% at 2.81 (tuning: one forbidden root pair passes) and 11% at 0.31 (two
  forbidden pairs pass). Closing the gap needs something other than a threshold, such as the
  gray-zone escalation, or a decision that those one-direction acceptances should not survive
  (the old verdicts are agreement, not truth). F3 must decide which.

## Latency

30 sampled notes with their 20 shortlisted candidates, 3 repeats, one runtime at a time. MLX
includes the JSONL round trip; GGUF `rankAll` is serial in node-llama-cpp. Today's pipeline is
11.9 s per note, about 40 minutes for 200 notes (not like for like: it also generates text).

| Runtime | Single pair p50 / p95 (ms) | Note x8 mean / p95 (ms) | Note x20 mean / p95 (ms) | ms per pair x8 / x20 | 200 notes x 8, both ways (min, mean / p95) | 200 notes x 20, both ways (min, mean / p95) | Load + first call |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MLX | 36.1 / 43.1 | 210 / 250 | 535 / 645 | 26 / 27 | 1.40 / 1.67 | 3.56 / 4.30 | 22 + 586 ms |
| GGUF Qwen3 Q8_0 | 45.0 / 53.9 | 379 / 446 | 992 / 1,156 | 47 / 50 | 2.53 / 2.97 | 6.62 / 7.71 | 590 + 357 ms |
| GGUF bge Q8_0 | 17.7 / 22.5 | 141 / 172 | 355 / 430 | 18 / 18 | 0.94 / 1.15 | 2.36 / 2.87 | 1,179 + 168 ms |

The "p95" minutes assume every note takes its own per-note p95, so they are an upper bound.
Quality was measured on the old shortlists of about 19 to 20 candidates per note; recall with 8
candidates was not measured, so the 8-candidate column has no quality result behind it. At 20
candidates both ways the 4-minute goal holds on MLX at the mean only (3.6 minutes, 4.3 at p95);
GGUF Qwen3 meets only the 8-minute goal. One direction alone halves each figure (MLX 1.8 minutes
at 20 candidates).

MLX amortized per pair inside a batch: p50 25 ms, p95 30 ms (device time 31.5 ms for a single
pair); batch 32 is no faster than 16. Full passes over the 7,240 pairs took 171 s (MLX batch 16),
273 s (batch 1), 360 s (GGUF Qwen3) and 129 s (bge).

Scores depend slightly on batch composition (bf16): batch 1 against 16 differs by 0.09 log-odds
on average, p99 0.31, max 0.50; 8 of 7,240 directed decisions flip (4 undirected max-of-both
decisions). Root level, one direction: unchanged (24/26 and 25/28). Max of both: unchanged at the
batch-16 threshold (25/26 and 28/28), but re-picking the threshold on the batch-1 scores gives
3.375 and falls to 27/28 (A2/A5 3.3125 is below it); mean of both stays 28/28. The threshold
picked on the tuning-only run (3.16) moved to 3.31 on the full run.

## Recommended defaults to calibrate in F2 and F3

1. Decider: MLX `Qwen/Qwen3-Reranker-0.6B` @ `e61197ed4502`, helper `score`. Without the helper or
   Apple Silicon use the GGUF Qwen3 file; never fall back silently, keep a per-runtime threshold
   (the GGUF ones came out 0.15 to 0.25 lower).
2. Input: the three-line note text with 400 body characters, instruction `mechanism` (provisional,
   see Instruction), helper default `maxTokens`, batch size 16, token-bounded batches.
3. Both directions, max. Provisional accept threshold about 3.3 log-odds (p about 0.96), known to
   within roughly 0.1: on tuning the plateau between the worst forbidden pair (2.875) and the next
   expected one (3.75) is 0.88 log-odds wide, and the lowest held-out expected pair sits on 3.3125.
   Store raw log-odds per direction (`relation_decisions`, F1a) so the threshold can change
   without rescoring, and compare max with mean of both on the F3 pairs.
4. Shortlist about 20 candidates per note (every expected tuning pair has a candidate row at 19,
   30 and 39 per note). That costs about 1.1 s per note both ways (3.6 minutes per 200 notes);
   eight candidates would cost 0.4 s both ways, but their recall was not measured.
5. Use a hysteresis band of about 0.5 log-odds around the threshold, or cache decisions, because of
   batch-composition noise. Hypothesis for optional LLM escalation, also a candidate answer to the
   reverse-only loss: a gray zone of roughly 1.5 to 3.3.
6. Hypothesis to test in F2: decide on the reranker score alone, not blended with retrieval, with
   cosine staying the shortlist stage. The evidence is indirect: the old LLM verdict alone beat the
   old blended rule on this fixture, which shows the blend gate hurt, not that the reranker alone
   beats cosine fused with the reranker. That fusion was not measured.

## Evidence limits and open items

- Easy synthetic benchmark: cosine reaches 26/28 with 0 forbidden and few hard negatives reach the
  decider (8 of 35 held-out forbidden pairs). The ~300 owner-labeled pairs planned for F3,
  including same-topic, different-claim negatives, must recalibrate the threshold and gray zone.
- 26 to 28 labelled pairs per split: one pair is not significant, and the MLX both-direction
  result moves between 27 and 28 with one quantisation step.
- Held-out results informed the direction condition, and the instruction is fitted to the
  benchmark's decoy design (see Directions and Instruction). Re-validate both on F3 data.
- The reverse-only loss target of F3 is not met by any runtime (Direction stability).
- The OpenAI Decisions API comparison (Spike A2) is pending and was not run here.
- Not measured: fusing cosine with the reranker, longer notes, languages other than pt-BR,
  recall with fewer than 19 candidates per note, a custom bge template. No owner text was used.

## Reproduce

Run `build-dataset.ts`, `score.ts --runtime mlx --set tuning --instruction <id>` for each
instruction, `select-instruction.ts`, `score.ts --set all` for `mlx` (batch 16 and 1), `gguf-qwen3`
and `gguf-bge`, then `latency.ts` and `evaluate.ts`, all under `scripts/spikes/reranker/` with
`npx tsx`. `evaluate.ts` only reads the stored scores (no model run). Raw results are in
`.cache/spikes/reranker/` (`evaluation.json`, `latency.json`, `tables.md`, `frozen.json`,
`scores/`).
