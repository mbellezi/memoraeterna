# F2 measurements

Dated measurements of F2 (Topic Tree Engine). Decisions: `docs/f2-decisions.md`.

## Gate W: the legacy wiki wipe (2026-10-15)

The owner authorized the complete deletion of the legacy wiki in chat on 2026-10-15 ("Autorizo apagar
totalmente a wiki antiga"). Only the DEV profile (`~/Library/Application Support/@app/desktop`) holds data.

| Step | Result |
| --- | --- |
| A1 preview on DEV | 5,867 legacy rows: 9 pages + 9 revisions, 1 policy revision + 2 activations, 4 maintenance schedules, 4 routine bindings, 2,919 impact events + 2,919 deliveries; 2 legacy settings keys; 0 legacy jobs; 0 wiki vault files. Library: 30 sources, 197 chunks, 160 notes, 387 vectors. Backup taken and verified by restore in 3.1 s (token `df0c300bbaf6`). |
| A2 dress rehearsal on an APFS clone of the profile | wiped through the app path in 37 ms after a verified backup; a preview of the clone then showed 0 legacy rows, 0 legacy keys and an unchanged library (settings 5 → 4: two keys removed, the wipe record added). |
| A3 fault injection on a restored scratch cluster | killed after `counted`, `backed_up` and `verified`: every time the 5,867 rows were intact; the resumed run wiped them (72 other tables unchanged) and a second run did nothing. |
| A4 recoverability | the rehearsal's verified backup restores with the 5,867 legacy rows and the 160 notes. |
| B0 cold copy | `.cache/f2/legacy-wipe/dev-database-pre-wipe-2026-10-15T16-12-26Z` (290 MB, DEV stopped). |
| B1 DEV wipe | `wiped`: 5,867 → 0 legacy rows in 37 ms; total 3.0 s including the verified backup `.cache/f2/legacy-wipe/backups/memora-backup-2026-10-15T16-12-31-413Z`. |
| B2 normal start | 90 s of normal running with the job supervisor: 0 `LEGACY_RECREATED`, 0 errors, legacy tables at 0, library unchanged (30 / 197 / 160). |

Not checked at B2: the Wiki screen's empty state and one Ask question in the running window (covered by
`verify-consultation.ts` on a scratch database and the renderer tests). The verified dump and the cold copy are
kept until the owner asks to remove them; the old wiki can be read by restoring the dump into a scratch cluster.

## Wave 2: rankers and the pure engine (2026-10-15)

| Measure | Result | Reference |
| --- | --- | --- |
| Ranker, MLX Qwen3-Reranker-0.6B: single pair p50 / p95 | 46.8 / 48.8 ms; 33.3 ms per pair in a 20-document call | bound 75 ms |
| Ranker, GGUF Q8_0 fallback: single pair p50 / p95 | 52.8 / 67.8 ms; 56.0 ms per pair in a 20-document call | bound 150 ms |
| Ranker model-card pair (log-odds) | MLX 7.625 / −12.277; GGUF 7.271 / −12.000 | 7.625 / −11.375 ±1 |
| Ranker margin relevant vs irrelevant | en 19.5 / 19.9, pt-BR 19.3 / 19.2 | ≥0.5 |
| Replay parity on corpus-notitle (18,632 notes, seed 20261014) | depth 3.689, fan-out 4-9 84.8%, leaf purity 91.6%, reachability 100%, 0 hard violations, 11 Areas, 34 s build | Spike B 3.69, 85%, 92% |
| PLACE per note (decide + apply), mean / p95 | 0.17 / 0.21 ms; 15.5% gated, 98.1% admitted to a leaf | Spike B 13.8-16.4% gated |
| Mis-parent audit at depths 2 / 3 / 4 | 3.13 / 1.26 / 0.71% (17 ms) | Spike B 3.1 / 1.3 / 0.7% |
| REBALANCE settle on that build | 0.2 s, 20 operations, 1.31% of items moved, 0 hard violations | — |
| Undo | exact (byte-equal dump, bit-equal stats) over 1,000 random sequences and a 1,500-seed stress run | — |

## Wave 3 and gate A (2026-10-15)

| Measure | Result | Bar |
| --- | --- | --- |
| Topic tables (0053): bootstrap of a 2,000-item tree | 0.31-0.34 s, stored tree equal to the engine dump, statistics bit-equal | — |
| PLACE change-set through the repository, p50 / max | 5.5-6.2 / 8.5 ms | — |
| Undo of the last 5 change-sets | 7.5-14.6 ms each; snapshot hash equal to before | exact |
| Skeleton load (18,632 notes, 1,500 topics) p50 / p95 | 57 / 70 ms | ≤300 ms |
| Vector load (18,611 × 1024, binary) p50 / max | 224 / 251 ms (text form 866 ms) | ≤5,000 ms |
| Ranker install from the local seed + automatic decide validation | MLX 4.5 s, GGUF 3.5 s; a one-byte change voids it | — |
| IVF recall@10 at nprobe 8 (3,000 / 6,000 samples / production queries) | 0.931 / 0.942 / 0.963 | ≥0.9 |
| Worker partition | equals the in-process build; partition hash equals Spike B's | equal |
| E3 weekly churn, Spike B reference engine (chronological / shuffled) | max 4.56% / 3.38%, median 3.36% / 3.01%; 0 hard violations | ≤3% |

Gate A: parity, property tests, worker parity and IVF recall pass. The E3 churn above was measured with the
reference engine, which has none of T08's stability controls.

### Gate A churn with the real engine (passed)

The replay now runs the real engine (T07 PLACE with secondaries, T08 REBALANCE with its stability controls,
audit before every REBALANCE, exact undo checked on a copy). Neutral settings reproduce the reference within
the Spike B tolerances. Stability settings were calibrated on the calibration seeds (7-12, both orders, 60-point
grid) with a rule fixed before any evaluation seed ran; frozen defaults: churn weight λ 6 (was 1), daily moved
share 0.002 (was 0.02), cooldown 931 inserts (one simulated week; was 25), re-parent margin 0.1 (was 0.05).

| Evaluation seeds (20261014, 1-5), both orders | Result | Bar |
| --- | --- | --- |
| Worst weekly churn | 2.59% | ≤3% |
| Reachability / hard violations | 100% / 0 in every run | 100% / 0 |
| REBALANCE change-sets undone exactly | all | all |
| Final fan-out 4-9 share | 66-78% | 80% (E2, gate C; calibrated in T29) |

## Wave 4 (2026-10-15)

| Measure | Result | Bar |
| --- | --- | --- |
| Ranker through `AiService.rank`, 1 query × 5 documents, MLX, interleaved with embeddings | p50 81 ms, p95 82 ms; 0 reloads, 1 helper process | p95 ≤300 ms (target 200) |
| Same, GGUF ranker | p50 153 ms, p95 159 ms | — |
| PLACE job after a fresh build (3,000 notes) | 13 ms per job, 49 ms before the planner statistics settle (ANALYZE after builds lands with T19) | — |


## Wave 5 and gate B (2026-10-15)

First cold-started tree on the wiped DEV profile (golden library, 160 notes, 10 roots), built by the real
service: 9 leaf topics under the root, named in pt-BR in 1 call with 0 repairs ("Curva do esquecimento",
"Replicação de Ebbinghaus", "Modelos da curva do esquecimento", "Metodologia do experimento de retenção",
"Esquecimento na memória social", "Linguagem e memória", "Princípios FAIR para dados", "Simão Bacamarte e a
Casa Verde", "A cartomante").

| Gate B check | Result |
| --- | --- |
| DEV tree reachable from the root (cold-started after the wipe) | 170 of 170 items (100%), 0 hard violations, 0 orphans |
| Service placements equal the replay of the same rows | equal (160 rows) |
| Leaf size / Unsorted share / undo rate | 11-30 items, 100% in range / 0% / 0% |
| DB undo exact | yes (T12, `db:topics:verify`) |
| Source deletion and re-chunking keep reachability | yes on a scratch PostgreSQL with the real services (T15b) |
| Light lane under a held AI slot | PLACE completes while a model job holds the slot (T02, T19 scratch proofs) |
| `golden-small-v5-a` replay with G1 deterministic | 0 misses twice in a row with identical content, equal to the recording (197 chunks, 160 notes, 111 note relations, 1 source relation, same calls and tokens) |

Found and fixed on the way:
- Naming marked renamed topics and their ancestors dirty, so every cache load ran a needless sweep (`a4408ab`).
- An immediate job request merged into a debounced one stayed deferred (`a174f51`).
- Graph candidates for note matching were cut at 250 paths with ties broken by the physical row order of the
  graph tables, so replays diverged on a few notes; the cut now keeps every tied path (`4493092`, pre-F2 bug).

Owner preview P: the DEV app was left open with the new navigator and topic page; feedback feeds T24/T29.

## Wave 6 (2026-10-16)

No AI calls and no migration in this wave; the numbers are offline or on scratch PostgreSQL. Live proofs on the
measurement profiles (ENV-C, ENV-G) follow in wave 7.

| Task | Measure | Result |
| --- | --- | --- |
| T23 gate | DS-C new-article holdout, 3 splits, gate precision at the start values | about equal to margin-only placement; the threshold is T29a's to calibrate |
| T24 Areas | DS-C seeds 1-5, built tree vs. after the Areas-level re-parent pass | mis-parented depth 2: 7.9% → 6.9% (stripped), 3.9% → 3.5% (titled); level-2 silhouette 0.136 → 0.139; NMI unchanged |
| T24 Areas | E3 churn with the change (evaluation seeds, both orders) | worst week 2.69% (gate A: 2.59%), all runs under 3% |
| T24 Areas | Regroup time at 18,632 notes | 97-354 ms |
| T25 Shape | Icicle layout of 2,000 topics | p50 0.8 ms, p95 1.05 ms (bar 50 ms) |
| T26 human operations | 1,000 replayed inserts after a human move, rename and pin | REBALANCE applied 390 operations; the 3 protected topics did not change |
| T26 human operations | Mutate / undo latency (72-note library) | median 26 ms / 53 ms, max 204 ms / 237 ms (cold cache) |
| T26 human operations | Undo of move, create, pin, unpin and place | restores the stored tree dump exactly |
| T27 locate | `objects.locate` p95 with topic paths, DS-S (30,000 notes, 2,500 topics) | 0.85 ms (bar 50 ms) |
| T27 locate | ENV-C-shaped synthetic library (18,632 notes, 1,500 topics) | 0.84 ms |
| T33 Obsidian | No-op / first projection pass at 18.6k notes | about 39 s / 264 s of compute-worker time, paged on the light lane |

Merged with the wave: the five locale files had two `topics.changeSets` blocks, so the first one (`place`,
`build`, `rebuild`, `rebalance`, `proposal`) never reached the UI; they are one block now. Not delivered: pin and
unpin of notes and sources from the topic screens (they keep their existing view-history pin).

## Wave 7, code (2026-10-16)

Seven tasks merged (T28, T31, T19b, T34b, T40r, T32's harness, and T26f follow-ups); T31, T19b and T40r had an
Opus review, and the medium findings of T31 and T19b were fixed before the merge. Verification followed the new
economical rule: `npm run check:changed` per task, one full `npm run check` (376 test files, 3,855 tests) and the
stage verifiers (`phase4:e2e`, `db:seed:verify` with 55 migrations, `db:topic-overview:verify`,
`db:topics:verify`) at the merge.

| Task | Measure | Result |
| --- | --- | --- |
| T28 Ask about a topic | Retrieval at 20,000 notes, 220 topics | library 277 ms; root 301 ms; Area (1,000 notes) 24 ms; leaf 8 ms |
| T28 | Scoped answer cites only the subtree; no wiki repository call | yes (sidecar test, SQL statement spy) |
| T19b space change | 108 notes, 30 topics, 256-d space moved to 768-d | 30 of 30 topic IDs kept, 0 items moved, 0 hard violations |
| T19b | Remote route / local route | remote waits for `topics.reembed`; local re-embeds on its own |
| T32 E6 harness | `topics:e2e --synthetic` (no models) | record 40 calls, replay 40 served, 0 misses, both passes PASSED |
| T40r removal | Legacy wiki data access removed | rules 800 → 795 lines; long product lines 158 → 157 |

Pending for gate C: the E6 record and replay on the PLOS paper (T32), the live proofs on the measurement
profiles (T31 on ENV-G, T19b on a copy of ENV-G, T23/T24 on ENV-C), calibration (T29a/T29b), the owner's blind
rating (T30) and the gate-C measurement (T29c).

## Measurement profiles and calibration (2026-10-16)

**Profiles.** ENV-G and ENV-F (golden library and matching fixture, grown source by source through the real
app) and ENV-C (the 17,735-note corpus re-embedded through the app's GGUF route at 105 notes/s, built by the
corpus runner) were created from the DEV profile. The MLX Qwen3-Reranker-0.6B was installed into all three with
the new DEV knob (`MEMORA_LOCAL_MODEL_INSTALL`, validated for `decide`). Topic calls are recorded to
`golden-small-f2`, `matching-fixture-f2` and `corpus-f2` (0 misses on every run).

**Defects the profiles exposed, all fixed in this wave:**
- Growth absorbed unrelated sources into existing leaves (ENV-G: short stories inside "Comparação de modelos de
  memória"): the REBALANCE cooldown was a fixed 931 inserts, rebuild triggers ran only in the daily audit and
  names were not refreshed within a session. T29b made the cooldown scale with the library, lets fresh items
  move freely for 24 h, checks the triggers after every PLACE and re-checks name drift a minute after changes.
- A leaf stayed above its hard maximum after the gate moved 21 notes into it (E1 fail on ENV-C): the gate did
  not request REBALANCE; it does now, and REBALANCE scans for hard violations on every run (2 ms at ENV-C size).
- An Areas answer missing one topic was dropped without repair: incomplete answers are now repaired.

**Calibration (seeds 7-12 only; evidence in `docs/topic-placement-calibration.md` and `.cache/topics/reports/t29b`).**
Changed defaults: ambiguity margin 0.015 → 0.01; churn weight 6 → 4; cooldown = max(10, 8.3% of placed items)
(was 931); fresh items 24 h; sideways splits limited to the 4-9 band; rebuild quality drop 0.05 → 0.03; bootstrap
modularity 0.1 → 0.2; rename drift 0.3 → 0.5; background AI calls 300 → 270 per day. Gate T/τ/θ keep 1/0/0.5 for
both rankers: no grid point reached 90% accepted precision and the rule's fallback would absorb more new topics
(the ranker's top choice matches margin-only placement on 67-68% of new-article notes).

**Gate C replays (evaluation seeds 20261014 and 1-5, both orders, replay config `15d990301e09`).**

| Exit | Result | Bar |
| --- | --- | --- |
| E1 | reachability 1, 0 orphans, 0 hard violations in all 24 runs | 100%, 0, 0 |
| E2 depth / fan-out 4-9 | median depth 3.71; median 85.2-86.5%, lowest 83.3% | ≤4.5; ≥80%, none <75% |
| E3 weekly churn at the median seed | 2.55% chronological, 2.38% shuffled | ≤3% |

**Profiles rebuilt with the calibrated `config_hash` 82befc7b (T30).**

| Profile | Topics | Depth | Fan-out 4-9 | Unsorted | E1 |
| --- | --- | --- | --- | --- | --- |
| ENV-C (rebuild, 1,117 of 1,518 topic IDs kept) | 1,570 | 3.70 | 88.2% | 0.1% | pass |
| ENV-G (grown source by source) | 17 (14 leaves) | 1.49 | — | 0% (was 10%) | pass |
| ENV-F (grown source by source) | 16 (13 leaves) | 1.39 | — | 0% (was 16.7%) | pass |

The live gate on ENV-C (40 held-out articles, MLX ranker): 202 decisions, 130 accepted and 72 "none", rank calls
about 130-360 ms. Not met and reported: rename drift 7.4% of topics per week against the 2% target; the LLM Areas
grouping is rejected by its silhouette rule, so the Louvain level-1 topics stay as Areas.
