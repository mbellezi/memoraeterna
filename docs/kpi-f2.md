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
reference engine, which has none of T08's stability controls; the gate's "measured path through stability
settings" is being produced by replaying the real engine (T07 PLACE + T08 REBALANCE with hysteresis, cooldown,
freeze and budgets) with the settings calibrated on the calibration seeds only.
