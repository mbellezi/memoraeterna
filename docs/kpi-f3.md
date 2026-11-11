# F3 measurements

Dated measurements of F3 (Relations v2 and AI runtime lanes). Decisions and the full readings:
`docs/f3-decisions.md` (sections "Calibration outcome", "Gate outcomes decided by the owner", "Gate P passed",
"M2 outcome", "X7 at M2", "S1 second library at M2", "Ask retrieval after the soak"). Runbooks and raw outputs:
`.cache/f3/` (M2: `.cache/f3/m2/RUN.md`; soak: `.cache/f3/soak/RUN.md` and the run's `T64r.md`).

## Frozen configuration

| Item | Value |
| --- | --- |
| Local deciders (decision 29) | MLX Qwen3-Reranker-0.6B, `relation` instruction, 600-character pair text, mean of both directions; suggest only, MLX from 0.125, GGUF from 0.6186; freeze `745469e5` |
| Opt-in remote decider (decisions 30, 31c) | OpenAI Decisions API `gpt-6-luna`, request design `dd654932`; apply from 2.228, suggest from 1.593; freeze `ae14630a` |
| MLX helper | `memora-mlx-helper@sha256:44d081e0`, parity max delta 0 on the reference and 522 M1 pairs |
| Direction (decision 31b) | none on automatic note relations; the owner on Keep or a clear decider (Decisions for notes, the source judge for sources) |
| Graph batches | 3,500 characters with 12/12 caps on every writer (D36's 7,000/24 failed X7's yield) |
| Source discovery | one neighbour (two neighbours moved to F4) |

## Gate X (M2, T63, 2026-10-18/19)

| Item | Result | Verdict |
| --- | --- | --- |
| X1 | S0, S1, S2, B1 held-out 27/28 each (mean 27.00, min 27), 0/35 forbidden in each | met |
| X1 reported | GGUF 26/28 at 0/35; the Decisions samples not measured (the account had no credit; dropped by the owner) | reported |
| X2 | R_v9 loss 10.3 % (10.3-11.0 %) over 137 pairs, panel kappa 0.897 | not met (decision 31d, revisited in F6; carried to F7 on 2026-11-11, plan decision 34) |
| X3 | W for 200 notes: TP-G 2.72 min, TP-F 4.00 (239.9 s), TP-C200 2.86 and 2.87 (P0 queue p95 675 and 757 ms); TP-Local 7.68 (reported, bar 8.0) | met |
| X4 | decider contract 4/4; 0 explanation calls, no remote call outside typing and judging, 0 ranker output tokens, every typing in the band | met |
| X5 | sibling delays -4 to 280 ms (`phase4:e2e`); links commit while later roots decide | met |
| X6 | the 24 h soak below | met |
| X7 | 45.0 generative calls per chapter at 3,500-character batches, entity yield 105 % of F1a | met on the owner's re-based bar (≤45; F4 returns it to ≤40) |
| S1 time | 2.89 / 2.66 AI-call s and 1.60 / 1.44 judge calls per source (S0 / S1), 0 replayed; book pair SQL p95 47.2 ms | met |
| S1 quality | source layer 27/28 and 28/28 held-out at 0/35; tuning 26/26 at 0/25 | met |
| S1 pairs | golden pairs 3/3; order replay over 2,000 orders: 0 forbidden, 54/54 expected, with the 122-pair closure judged | met |
| S1 second library | one neighbour accepts 6, two neighbours 13 of 27 panel-positive pairs | not met; F4 |
| Non-regression (5.6) | E6 replay 0 misses; `topics:e2e --synthetic`; `db:topics:verify`; golden-small-f2 G1 digests unchanged (197 chunks, 160 notes, 26 summaries, 484 entities); topic tree untouched and 0 roots moved in every run | met |

## X6: the 24 h soak (T64, 2026-10-19/20)

Local preset (MLX Qwen3.5-9B writer, MLX ranker, GGUF embedder), loopback fakes for Ask and explanations with seeded
faults, a Codex-wire outage, MLX helper kills and GGUF batch aborts. Run `soak24-20261019T0036`.

| Line | Result | Bar |
| --- | --- | --- |
| Calls past deadline | 0 of 8,493 | 0 |
| Repairs (D35) | 0 of 107 counted; the local writer's 151 of 1,174 (12.9 %) set aside by decision 31(a) | ≤2 % |
| Jobs stuck, blocked, past twice their deadline | 0, 0, 0 | 0 |
| Swap after warm-up | 9.2 MB | ≤50 MB |
| P0 wait over the bound | 0 | 0 |
| Breaker | opened in the outage, closed 38 s after it | ≤60 s |
| Helper restarts | 7 for 7 kills | equal |
| Remote deadlines | first byte 6/6 at 30 s, stall 5/5 at 20 s, 652/652 remote totals | all |
| Driver actions | 72 articles, 288 explanations + 24 bursts, 12 edits, 4 re-imports, 6 typing faults: all ok; Ask 114 of 144 | — |

The failure audit (T64r) found one product defect: 27 asks failed their 120 s budget in local retrieval (a plan flip in
the Ask candidates query, 1 s to over 120 s). Fixed before the close (no migration): candidates p95 1,219 → 176 ms on the
soak's database with identical results, every Ask statement bounded by the remaining budget, a plan-shape test as guard.
The 46 failed jobs were the local writer's invalid structured output after its repair (decision 31a): 39 of about 82
imported sources ended with an incomplete graph, which F4's JSON-constrained decoding addresses.

## Close (T66, 2026-10-20)

| Check | Result |
| --- | --- |
| `npm run check` (format, lint, types, tests, ratchet, contrast) | passed: 6,163 tests before the Ask fix, 6,186 after it (sidecar tests on the vendored PostgreSQL 18.4) |
| `phase4:e2e`, `topics:e2e`, `topics:e2e --synthetic` | passed (stage F, 2026-10-19) |
| Rules line budget | 800 of 800 |

Spend in F3: about 2.49M Codex tokens (cap 2.9M, raised from 1.7M by the owner for M2); the Decisions API about
US$ 1.5-1.7, all before M2 (US$ 0 in M2).
