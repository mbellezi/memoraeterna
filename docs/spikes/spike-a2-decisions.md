# Spike A2: OpenAI Decisions API as a remote relation decider

2026-10-14, branch `refactoring`, phase F0. Same data, split and metrics as Spike A (`spike-a-reranker.md`), so
Decisions sits in the same table as the local rerankers. Rows marked "from Spike A" were read from its files
(last modified 03:32 UTC; Spike A may still be revised).

## Decision

**Optional, opt-in remote decider; local MLX stays the default.** If it ships first, ship it as a tiebreaker for
MLX's uncertain band (measured below in the band-only request shape); offer "full decider" later for machines
without MLX.

- Quality: on this saturated benchmark Decisions ties the old LLM judge and the best MLX variants at root level.
  Held-out is 28/28 expected and 0/35 forbidden from one direction; the old LLM score alone and MLX
  mean-of-both-directions also reach 28/28 and 0/35, so root level cannot rank them. What separates Decisions: the
  highest agreement with the old `gpt-5.6-luna` judge among the new deciders (note-level AUC 0.97, MLX 0.91 to
  0.94; a judge of the same model family, so this is agreement, not truth), one direction is enough where MLX
  needs both, and the smallest reverse-only loss (8% against MLX 32%, measured on tuning rows only).
- Cost and speed: p50 about 0.2 s per request, US$ 0.03 per 1k pairs, US$ 0.09 for 200 notes x 8 candidates both
  ways.
- Order and makeup dependence: the score changes with candidate order and with what else is in the request. One
  extra shuffle flips 2.9% of decisions and turned held-out 0/35 forbidden into 1/35 (a decoy went 0.03 to
  0.93); changing the request makeup flips 7-9%. The remedies tried (lower or mean of two orders, MLX
  as a floor) are observations from one extra order and one decoy pair, not tested prescriptions.
- Tiebreaker, measured with band-only requests (tuning in two orders, then held-out once in two orders): same
  root results as the full-shortlist figures (tuning 26/26 with 0 forbidden, held-out 28/28 with 0/35) at 5% of
  the directed pairs and 6.5% of the input tokens (band edge 1.5). Its root-level contribution is thin: it rescues
  1 of 26 expected tuning pairs and none on held-out, where MLX max-of-both already finds 28/28. The other
  survivors it adds are agreement with the old judge. Treat it as low-risk and cheap, not as a demonstrated gain.
- Privacy: note text leaves the device (retention below); disclose it and keep it opt-in.

## Setup and method

- `POST https://api.openai.com/v1/decisions`, model `gpt-6-luna` (the only one), public beta (reported open
  since 2026-10-06). Plain `fetch` client with deadlines, `Retry-After` backoff and redaction
  (`scripts/spikes/decisions/client.ts`): 2,702 requests (2,030 main protocol, 672 band-only), 0 errors, 0
  refusals, 0 retries. The key was read from `.env` at runtime and never printed or stored; only synthetic
  fixture text was sent, with aliases c1..cN instead of note IDs.
- Wire facts: answers come in question order and echo `name`; probabilities have two decimals (99 distinct
  values, 69% are 0.00); `usage` has input tokens only; 200 questions in one request worked; this key allows
  5,000 requests and 2M tokens per minute. Spend US$ 0.69 of the US$ 2 limit (6.90M input tokens at US$ 0.10
  per 1M, confirmed on the pricing page); the largest run cost US$ 0.12, the band-only requests US$ 0.05.
- One request per source note (at most 20 candidates): input = frozen Spike A instruction (`mechanism`) + query
  note + candidates c1..cN in a seeded random order (the old ranking cannot leak through position); one
  `predicate` per candidate with the specified wording; score = log-odds of the probability, clipped to
  [0.005, 0.995]. Note text, partition, labels, thresholds (zero forbidden on tuning, plateau midpoint) and
  metric code are Spike A's, imported read-only. All 7,240 directed pairs of Spike A were scored. Typed
  configuration (tuning only): plus one `choice` per candidate (7 options shuffled per question).
- Design frozen on tuning at 04:09 UTC (`frozen-design.json`, enforced by `run.ts`) before any held-out
  request; robustness runs came after.
- Band-only requests (`band.ts`, added after review): only the pairs in MLX's uncertain band, in both
  directions, one request per query note (the candidates are that note's band partners). Scored on tuning first,
  in two candidate orders and for three band edges; the thresholds (the tuning-only values of this report) were
  frozen at 04:44:47 UTC in `frozen-band.json`, and the held-out requests followed once, in both orders (first
  request 04:44:52, enforced by the script).

## Root-level quality (threshold chosen on tuning)

| Decider | Threshold | Tuning found / forbidden | Held-out found / forbidden | Lowest held-out expected pair (margin above threshold) |
| --- | --- | --- | --- | --- |
| **Decisions, one direction** | p 0.79 | 26/26, 0/25 | **28/28, 0/35** | R3/R5 p 0.96 (1.84) |
| Decisions, max of both / mean of both | p 0.79 / 0.42 | 26/26, 0/25 | 28/28, 0/35 | R3/R5 p 0.98 / 0.97 (2.56 / 3.85) |
| MLX Qwen3 one direction (from Spike A) | 3.31 | 24/26, 0/25 | 25/28, 0/35 | A3/A5 (-2.81) |
| MLX Qwen3 max of both (from Spike A) | 3.31 | 25/26, 0/25 | 28/28 (tie), 0/35 | A2/A5 (0) |
| MLX Qwen3 mean of both (from Spike A) | 1.31 (p 0.79) | 25/26, 0/25 | 28/28, 0/35 | P01/V01 (0.75) |
| GGUF Qwen3 max of both (from Spike A) | 3.16 | 25/26, 0/25 | 27/28, 0/35 | A2/A5 (-0.02) |
| Old LLM score alone (from Spike A) | 0.50 | 26/26, 0/25 | 28/28, 0/35 | P03/V01 (0.35) |
| Cosine (from Spike A) | 0.62 | 25/26, 0/25 | 26/28, 0/35 | P03/V01 (-0.04) |

Margins are in each decider's own units (log-odds for Decisions and the rerankers, score for the old LLM, cosine
for cosine), so they do not compare across rows; Decisions' probabilities are clipped at 0.005 and 0.995.

- Root level is saturated. Decisions has root AUC 1.0 on both splits; so do the old LLM score and MLX on
  held-out (MLX tuning 0.998). The differences in the table are 1 to 3 labelled pairs out of 26 to 28.
- The tuning plateau is (0.48, 0.94] (W1/W4 forbidden to P01/P03 expected), 2.8 log-odds wide against 0.88 for
  MLX max of both. Held-out forbidden pairs that reach the decider top out at 0.11 (R1/R6); 18/25 tuning and 8/35
  held-out forbidden pairs reach any decider, as in Spike A.
- With another candidate order (order B, same thresholds) held-out is 28/28 with 1/35 forbidden (see
  Robustness). The 0/35 is one draw.

## Note level and calibration

| Decider | AUC vs old verdict (tuning / held-out) | Survivors share | Per note | Notes with none |
| --- | --- | --- | --- | --- |
| Decisions, one direction | 0.970 / 0.978 | 13.2% / 18.7% | 2.53 / 3.73 | 27/120, 12/30 |
| Decisions, max of both | 0.966 / 0.973 | 17.4% / 23.9% | 3.33 / 4.77 | 23/120, 11/30 |
| MLX one direction, both (from Spike A) | 0.910 / 0.927, 0.919 / 0.927 | 6.6 / 9.5%, 9.2 / 12.4% | 1.27 / 1.90, 1.77 / 2.47 | 49, 36 of 120 |
| Old pipeline accepted (from Spike A) | n/a | 6.0% / 9.5% | 1.16 / 1.90 | 45/120, 12/30 |

No forbidden root pair survives (tuning, one direction: 179 expected, 22 unlabelled, 103 same-root, 0
forbidden). The AUC is agreement with the old verdict, not truth. Calibration over the primary rows (tuning /
held-out); the probability rises with the old verdict but is not calibrated to it, and against root truth every
labelled row at p 0.5 or more is expected:

| Probability | Rows | Old LLM yes | Expected share of labelled root rows |
| --- | --- | --- | --- |
| 0.00 | 1360 / 365 | 0.3% / 0.5% | 3% / 0% |
| 0.01-0.29 | 437 / 79 | 5.5% / 6.3% | 75% / 80% |
| 0.30-0.69 | 144 / 32 | 36% / 34% | 98% / 100% |
| 0.70-0.99 | 296 / 92 | 77% / 85% | 100% / 100% |
| 1.00 | 61 / 30 | 98% / 100% | 100% / 100% |

Direction stability:

- Primary pairs (2,071 undirected, Decisions only): Pearson 0.91, Spearman 0.82, 36% of accepted pairs pass one
  direction only. Like for like with MLX, on all 3,620 Spike A pairs: Decisions 0.90, 0.74, 37% one direction
  only; MLX 0.82, 0.70, 50%. On the 3,067 tuning-note pairs: 42% against 51%. The scales and the number of
  accepted pairs differ (404 accepted in either direction for Decisions, 218 for MLX), so the shares are not a
  clean ranking. On the 780 pairs the old pipeline judged both ways: old LLM 0.81 / 0.82, Decisions 0.88 / 0.86.
- Old reverse-only acceptances (37 of 139, tuning rows): one direction keeps 29; max of both loses 3 (8.1%, all
  same-root pairs); MLX loses 12 (32%). Lower thresholds that still give 0 forbidden on tuning: p 0.70 loses 2
  (5.4%), p 0.58 loses 1 (2.7%), against the plan target of at most 5%. Both are tuning-only results with no
  held-out counterpart, and the margin is thin: p 0.58 sits 0.10 above the highest tuning forbidden pair (0.48),
  with two-decimal outputs and an order and makeup noise of 0.03 to 0.07 on average (p95 0.16 to 0.32). They do
  not support adopting a lower threshold without validation (for example on the F3 owner-labelled pairs).

## Cost and latency (warm connection)

| Request shape | Tokens per request / pair | US$ per 1k pairs | c1 p50 / p95 ms | c4 p50 / p95 ms | c4 requests/s |
| --- | --- | --- | --- | --- | --- |
| 1 candidate | 437 / 437 | 0.044 | 182 / 271 | 175 / 321 | 20.1 |
| 8 candidates | 2,251 / 281 | 0.028 | 187 / 317 | 186 / 263 | 19.1 |
| 20 candidates | 5,406 / 270 | 0.027 | 217 / 424 | 207 / 293 | 17.3 |

- Each question costs about 150 hidden input tokens beyond its text (157 per question in the 40/100/200 probe),
  most of the bill. Server time is 50-110 ms; the rest is network. Cold first request 453 ms (1.4 s for the
  very first). Identical requests give identical answers (1,680 of 1,680).
- 200 notes x 8 candidates: 0.71 min one direction at concurrency 1 (1.42 both ways), 0.17 min at 4 (0.35).
  200 x 20: 0.85 min one direction (1.70 both ways), 0.19 at 4. The old route took 11.9 s and 1,100 input plus
  590 output tokens per note (about US$ 0.0009 at `gpt-5.6-luna` list price, though not billed per token);
  Decisions takes 0.2 s and US$ 0.0005.
- Band-only requests (the tiebreaker shape) are small, so the per-question overhead dominates: 1.3 to 3.0
  candidates per request, 325 to 426 tokens and US$ 0.033 to 0.043 per 1k pairs, p50 164 to 185 ms.
- Typed configuration (tuning): predicate answers inside a typed request equal the predicate-only ones
  (Spearman 1.000, 0 flips); typing doubles tokens (10,132 per 19-candidate request, US$ 0.053 vs 0.027 per 1k
  pairs) and adds 11% to p50 (244 vs 220 ms). Agreement with the old `relationType` over the 139 stored
  relations is low: 45 of 110 (41%) for old types with a counterpart (29 `similar_to` have none); old
  `supports` (87) maps to supports 31, extends 30, example_of 17, none 9 (agreement, not truth). Predicate and
  type disagree on 143 of 2,298 rows, so keep type as a separate step for accepted pairs.

## Comparison with Spike A runtimes (local ones cost nothing per call; Decisions needs a Platform key)

| Runtime | Single pair p50 / p95 ms | Note x8 mean / p95 ms | Note x20 mean / p95 ms | 200 x 8 both ways (min) | 200 x 20 both ways (min) | Held-out found / forbidden |
| --- | --- | --- | --- | --- | --- | --- |
| MLX Qwen3 (from Spike A) | 36 / 43 | 210 / 250 | 535 / 645 | 1.40 | 3.56 | 28/28 (tie), 0/35 both ways |
| GGUF Qwen3 Q8_0 (from Spike A) | 45 / 54 | 379 / 446 | 992 / 1,156 | 2.53 | 6.62 | 27/28, 0/35 both ways |
| GGUF bge (from Spike A) | 18 / 23 | 141 / 172 | 355 / 430 | 0.94 | 2.36 | 17/28, 3/35 |
| Decisions, concurrency 1 | 182 / 271 | 212 / 317 | 255 / 424 | 1.42 | 1.70 | 28/28, 0/35 one direction |
| Decisions, concurrency 4 | 175 / 321 | 204 / 263 | 226 / 293 | 0.35 | 0.39 | same |

## Robustness and cascade

Candidate order (one extra shuffle, "order B", 4,142 pairs):

- 61% identical, mean |diff| 0.031, p95 0.16, max 0.90, Spearman 0.90; 119 pairs (2.9%) cross the threshold.
- Held-out at the order-A threshold is 28/28 with 1/35 forbidden: P06/V05, a decoy sharing module names (0.03 in
  order A, 0.93 in order B). Re-choosing the threshold on order B's own tuning data (p 0.77) does not help (still
  1/35). The lower or the mean of A and B gives 0/35 again, and MLX scores that decoy at -1.3, below every band
  edge below, so the cascade rejects it in both orders.
- This is n=1: one extra order and one decoy pair. Whether min-of-orders, several shuffles per accept or a local
  floor are reliable remedies is untested; it needs 3 to 5 orders on tuning.

Request makeup (the same directed pair in a request with other candidates; the latency requests use their own
shuffle keys, so order and makeup are separated only where stated). Mean |diff| is in probability:

| Comparison | What differs | Pairs | Mean / p95 diff | Decisions flipped at p 0.79 | Identical |
| --- | --- | --- | --- | --- | --- |
| 20-candidate vs primary | order only (same candidate set for all 600 pairs) | 600 | 0.031 / 0.16 | 18 (3.0%) | 62% |
| Single-candidate vs primary | makeup only (one candidate has no order) | 210 | 0.069 / 0.30 | 16 (7.6%) | 18% |
| 8-candidate vs primary | makeup and order | 240 | 0.070 / 0.32 | 22 (9.2%) | 26% |
| 8-candidate vs 20-candidate | makeup and order | 240 | 0.069 / 0.28 | 20 (8.3%) | 26% |
| Single-candidate vs 20-candidate | makeup (one candidate has no order) | 210 | 0.072 / 0.26 | 15 (7.1%) | 20% |

Removing other candidates moves a probability about twice as much as reshuffling them (0.07 against 0.03), and
changes 7 to 9% of decisions. A control with the same relative order and a different makeup was not run.

Cascade: MLX max of both directions accepts at 3.31 or more (its tuning threshold); pairs with MLX in
[lo, 3.31) go to Decisions, both directions, accepted at p 0.79 on the max of both. Band edges are
descriptive, not chosen on held-out.

**Band-only requests (the tiebreaker shape, measured).** Each query note sends only its band partners:

| lo | Tuning: directed pairs / requests / input tokens vs all primary | Held-out: pairs / requests / tokens | Tuning found / forb., orders A and B | Held-out found / forb., orders A and B | Reverse-only kept, A and B (MLX alone: 25 of 37) | Held-out survivors added (old judge also yes), A and B |
| --- | --- | --- | --- | --- | --- | --- |
| 1.5 | 152 (5.0%) / 80 / 6.5% | 52 (4.7%) / 35 / 6.5% | 26/26, 0 and 26/26, 0 | 28/28, 0 and 28/28, 0 | 29 and 29 | 17 (11) and 18 (11) |
| 0 | 304 (10.0%) / 103 / 11.8% | 108 (9.8%) / 65 / 13.0% | 26/26, 0 and 26/26, 0 | 28/28, 0 and 28/28, 0 | 33 and 32 | 30 (21) and 29 (21) |
| 2.5 | 52 (1.7%) / 39 / 2.4% | 18 (1.6%) / 14 / 2.4% | 25/26, 0 and 25/26, 0 | 28/28, 0 and 28/28, 0 | 27 and 26 | 7 (5) and 7 (5) |

**The earlier figures (full-shortlist probabilities).** They reuse the probabilities of the primary requests,
which carry about 19 candidates. Keeping that makeup would mean sending every primary request (forward and reverse)
that holds a band pair, so the real cost of that deployment is the last two columns, not the share of rows:

| lo | Rows in band (tuning / held-out) | Notes touched (tuning / held-out) | Tuning found / forb. | Held-out found / forb., orders A and B | Reverse-only kept | Primary requests to send (tuning / held-out) | Input tokens (tuning / held-out) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1.5 | 6.0% / 4.7% | 73/120, 14/30 | 26/26, 0 | 28/28, 0 and 0 | 30 of 37 | 37% / 22% | 50% / 35% |
| 0 | 12.0% / 9.5% | 100/120, 22/30 | 26/26, 0 | 28/28, 0 and 0 | 34 of 37 | 54% / 40% | 70% / 58% |
| 2.5 | 2.0% / 1.5% | 35/120, 6/30 | 25/26, 0 | 28/28, 0 and 0 | 27 of 37 | 18% / 9% | 24% / 14% |

What the band-only measurement shows:

- The two shapes are different measurements. For the same directed pair, the band-only probability differs from the
  full-shortlist one by 0.06 to 0.11 on average (11 to 25% identical, p95 0.28 to 0.52). At lo 1.5, 16 to 18% of
  the directed pairs cross p 0.79 on tuning (24 and 27 of 152) and 10 to 13% on held-out (7 and 5 of 52), and the
  decision changes for 19 to 20 of 138 band rows on tuning (12 + 8 and 11 + 8). The root-level quality figures
  survive the change of shape; the cost figures do not: at lo 1.5 band-only sends 5% of the pairs and 6.5% of the
  tokens, while keeping the full-shortlist makeup would send 37% of the requests and 50% of the tokens (about 8
  times the tokens).
- Root-level contribution of the tiebreaker: on tuning at lo 1.5 and 0 it decides 1 expected root pair that MLX
  max of both misses (P02/P03, p 0.94 and 0.95) and turns away the forbidden pairs that reach the band (lo 1.5:
  F1/F4 at 0.11 and 0.02; lo 0: three pairs, highest 0.26). On held-out no expected pair needs it (MLX max of
  both already finds 28/28) and the one forbidden pair in the band (P07/V05) scores 0.005. The case for the
  tiebreaker at root level therefore rests on one tuning pair.
- Threshold in this shape: the tuning plateau at lo 1.5 is (0.11, 0.94] in order A and (0.02, 0.94] in order B, so
  p 0.79 sits inside it, but the single expected pair is 0.15 above the threshold, smaller than the p95 band-only
  vs full-shortlist difference (0.36 to 0.41).
- The extra survivors the tiebreaker adds (lo 1.5, orders A and B: tuning 72 and 73, held-out 17 and 18) agree with
  the old judge in 61 to 77% of cases (tuning 55 of 72 and 56 of 73, held-out 11 of 17 and 11 of 18); that is the
  same-family agreement noted above, not evidence that they are right.
- The decoy P06/V05 never reaches the band (MLX -1.3), so band-only requests do not test the order-B failure.
- A lower edge sends more for little: lo 0 sends twice the pairs of lo 1.5 and keeps 3 to 4 more of the 37
  reverse-only acceptances; lo 2.5 loses the one tuning pair the tiebreaker rescues (25/26).

## Privacy and retention (official data controls, read 2026-10-14)

Sent: instruction, query and candidate texts (title, idea, 400 body characters), question text. Not used for
training by default; abuse-monitoring logs (may hold prompts and responses) are kept up to 30 days, longer if
the law requires; no application state except prompt caching (encrypted tensors on GPU machines, gone after 24
h). Zero Data Retention: eligible with limits, only after OpenAI approval; Private Retention with PSP is
"pending confirmation"; US and EU regional processing exist. `rules/security-privacy.md` requires disclosing
this where the user picks the remote decider.

## Against the earlier research, limits and reproduction

- Cost was estimated at US$ 0.006-0.016 per 1k pairs; measured 0.027-0.044 (hidden per-question tokens), still
  negligible. Third-party medians of 1.5-2.3 s for Luna do not apply: Decisions p50 is 0.18-0.22 s, flat up to
  200 questions ("10x faster than Responses" untested; about 50x faster than the old route). The plan called
  `choice` the order-sensitive question; predicates are too. A lane of 4 is safe (17-20 requests/s, no 429).
- Limits: easy synthetic benchmark (pt-BR only), saturated at root level, 26 to 28 labelled pairs per split, only
  8 of 35 held-out forbidden pairs reach any decider. The order result is n=1 (one extra order, one decoy), the old-judge
  agreement is not truth, and the tiebreaker's root-level gain is one tuning pair. Re-measure on the F3
  owner-labelled pairs, with several orders.
- Reproduce: `npx tsx scripts/spikes/decisions/<script>.ts` with `smoke --probe-limits`, `run --stage <s> --config
  <c> [--order-salt B]`, `freeze`, `latency`, `band --partition tuning [--order-salt B]`, `band --freeze`,
  `band --partition holdout [--order-salt B]`, `evaluate`, `compare`; results in `.cache/spikes/decisions/`.
