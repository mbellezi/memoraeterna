# F3 bake-off: the decider's selection, the freeze and gate F (2026-10-18)

Task T58 of F3 (`docs/f3-decisions.md` D3, D13, D18; plan decisions 29 and 30). The selection reads only the
panel's fit labels and the fixture tuning partition. The configuration was frozen before any held-out read. Gate
F then read the fixture held-out lists, R_v6, R_v9 and the panel's eval split, and nothing was re-tuned after it.
The working files are under `.cache/f3/freeze/` (`RUN.md`, `proposal.{json,md}`, `frozen.json`, `gate-f/`).

## Bottom line

| Gate F row | Value | Bar | Status |
| --- | --- | --- | --- |
| T61's parity (R1) | MLX build sha256:44d081e0...: 64 reference pairs and 522 M1 pairs, max abs delta 0; GGUF scores come from the checked build | pass | met |
| `frozen.json` before any held-out read | frozen 2026-10-18T07:10:50.254Z; first held-out read 07:14:43.686Z | yes | met |
| X1, fixture held-out expected (optimistic typing) | 27/28 (missed F3/F5, best mean -0.906) | >= 27/28 | met |
| X1, fixture held-out forbidden | 0/35 | 0/35 | met |
| X2, R_v6 loss over the panel-related pairs | 7/35 = 0.200 (literal 9/37 = 0.243; same-root 6/17) | <= 0.05 | **not met** |
| X2, R_v9 loss | pending: 13/137 lost (literal 0.095; same-root 4/34), 5 of them unlabelled | <= 0.05 | pending (panel pass) |
| Typer direction accuracy / swap consistency (G25) | pending (the orchestrator's DEV run) | >= 0.85 / >= 0.90 *(cal.)* | pending |

X1 also reports the following. The pessimistic bound is 0/28 and applied-only is 0/28: the offline export has no
typing, and decision 29 sets no apply band. Held-out candidate recall is 28/28. The tuning counts in the same export
are 25/26 expected and 0/25 forbidden.

## The selection (pre-registered rule, fit labels and tuning only)

The fit labels: 241 note pairs of pools A-C. That is T45's labels plus the 2026-10-18 top-up, with population weights
by cell (3.9) and all 137 R_v9 pairs left out.

| Step | Read | Choice |
| --- | --- | --- |
| Instruction | fit-label AUC at 400 characters, max: relation 0.7343, mechanism 0.7325, study 0.7184, default 0.6632 | `relation` (sha256 991ad3a6...) |
| Template | relation, max: 400 0.7343, 600 0.7366 | 600 body characters |
| Aggregation | 5-fold CV log-loss: mean 0.5755, max 0.6133 | mean of both directions |

The relation and mechanism AUCs are not an exact tie, and no tolerance was pre-registered, so `relation` wins as the
rule is written.

Plan decision 29 replaced D18's bands. There is no apply band. The suggest band starts at the score whose band alone
finds the most expected fixture-tuning root pairs with 0 forbidden. Here "alone" means before typing, capped per note
as the matcher caps it. Ties go to the higher edge.

| Decider | Isotonic map | Suggest from (mean log-odds) | Map P there | Tuning expected / forbidden | Panel fit labels at the edge, pooled (Wilson, n_eff, recall) | A / B / C | CV ECE / Brier |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| MLX Qwen3-Reranker-0.6B bf16 | 6 blocks | 0.125 | 0.386 | 25/26 / 0/25 (P02/P03 missed) | 0.497 (0.400, 97.0, 0.728) | 0.911 / 0.708 / 0.400 | 0.041 / 0.090 |
| GGUF Qwen3-Reranker-0.6B Q8_0 | 7 blocks | 0.6186 | 0.411 | 25/26 / 0/25 | 0.563 (0.461, 92.9, 0.710) | 0.959 / 0.725 / 0.473 | 0.031 / 0.096 |

D18's own reading is reported, not frozen. No level reaches cross-validated weighted precision 0.95 with Wilson >= 0.85
(the best is 0.739 for MLX and 0.627 for GGUF), and no level reaches 0.80. The uncertain-band escalation is not
evaluated, because its clause reads the precision bar that decision 29 removed.

## The freeze

Config hash `745469e5a7acce86ece3f6d271a9646fd2f06116926080a34d9a9b371760b371`, frozen at 2026-10-18T07:10:50.254Z, for
the MLX and GGUF deciders. MLX passed parity on T61's numbers. GGUF passed because the proposal's GGUF scores come from
the very build parity names. The calibration entries are `kind: isotonic` with the map's blocks, `applyFrom: null`
and `suggestFrom` at the edge. They also carry the label-set and freeze hashes and each build's 64 parity scores.
`relations-config.ts` ships them as the defaults, with `decide.bodyCharacters` 600 and `decide.rule` mean; the
catalog's `relations.decide.instruction` is revision 2, the `relation` instruction. The Decisions API decider of plan
decision 30 gets a calibration entry of its own identity later; it is not part of this freeze.

## Gate F reads

- **X1.** F3's retrieval runs in S0 order on a fresh ENV-F clone. That is 52 roots released: 39 tuning in manifest
  order, then 13 held-out; 8 roots with no notes are not released. It covers 138 notes, 2,154 candidate rows and
  1,977 decided pairs. Each decided pair is scored by MLX at relation/600 on T61's build (27.2 ms per directed pair).
  The one held-out expected root pair missed is F3/F5 (best mean -0.906, below 0.125).
- **X2 R_v6.** The 37 Spike A reverse-only pairs are banded at the frozen edge. The panel calls 35 of them related, and
  7 of those fall below 0.125. All 7 are `extends` pairs, at mean scores from -3.25 to -1.06. The bar fails. By the
  rule, the measured value goes to the owner and nothing is re-tuned on it.
- **X2 R_v9.** 13 of the 137 v9 acceptances are not in S0's suggest band. 5 of the lost pairs have no panel label, so
  the loss waits for the lost-pair pass (`.cache/f3/labels/passes/freeze/`: 25 items, the 5 lost pairs and 20
  consistency pairs, 2 pages, about 9.6k input tokens per judge, three blind Opus judges).
- **The clean check (the panel's eval split, nothing chosen on it).** The precision at the suggest edge is
  population-weighted, with the frozen proposal's cell weights.

| Decider | Labels | Precision at the suggest edge | Recall at the edge | ECE | Brier | AUC A / B / C |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| MLX | 106 | 0.673 | 0.565 | 0.030 | 0.104 | 0.989 / 0.758 / 0.825 |
| GGUF | 106 | 0.705 | 0.457 | 0.088 | 0.098 | 0.985 / 0.807 / 0.831 |

- **Reconcile dry run on the stored M1 run (0 calls).** It considered 109 relations. 92 move from apply to suggest. 17
  are left to the next match, because their rendered text differs at 600 characters. None drops out. 74 stored scores
  that have no relation would now be suggested (the next match types them).

## The typer (plan decision 29's experiment)

At the MLX edge, all 147 fit labels were typed in content order on live Codex (14 calls, about 85k tokens).
- **Typer prompt revision 1:** band + typed precision 0.677 pooled, recall kept 0.946, the panel's type on 39/85
  typed positives.
- **The panel's strict relatedness question (now revision 2):** precision 0.746, recall kept 0.906, the panel's type
  on 46/82.

Neither reaches 0.80, so there is no "confirmed" tier. The strict wording ships as `relations.type` revision 2 (the
orchestrator's adoption; content only, no model change). Revision 1 stays selectable as the candidate
`candidate-shipped-1`. G25's position check runs on revision 2, with 60 fit-split directed pairs and no R_v9 pair.

## Owner-relevant

1. **X2 fails on R_v6** (0.200 against <= 0.05). Spike A's reverse-only `extends` pairs score far below the frozen
   edge. X1 passes (27/28 at 0/35), and R_v9 waits for its pass.
2. Every automatic note relation is a suggestion (decision 29). The panel calls about half of the band's weighted
   pairs unrelated on the fit labels (MLX 0.497); the eval split reads 0.673 for MLX and 0.705 for GGUF.
3. The typer's veto lifts the band to 0.746 with the strict prompt, short of a "confirmed" tier.
