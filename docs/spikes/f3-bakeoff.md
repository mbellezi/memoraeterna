# F3 bake-off: the deciders' selection, the freezes and gate F (2026-10-18)

Task T58 of F3 (`docs/f3-decisions.md` D3, D13, D18; plan decisions 29 and 30). Each selection reads only the panel's
fit labels and the fixture tuning partition, and each decider was frozen before its first held-out read. Gate F then
read the fixture held-out lists, R_v6, R_v9 and the panel's eval split, and nothing was re-tuned after it. The working
files are under `.cache/f3/freeze/`: `RUN.md`, `proposal.{json,md}`, `proposal-decisions.{json,md}`, `frozen.json`
(the first freeze is kept beside it), `gate-f/`, `direction-analysis.md` and `x2-analysis.md`.

## Bottom line

The Decisions column is the shipped entry: the product's own online requests (the dense design it replaced is in
brackets; see "The Decisions decider").

| Gate F row | MLX (local, default) | Decisions API (remote, opt-in) | Bar |
| --- | --- | --- | --- |
| Parity (R1) | build sha256:44d081e0...: 64 reference pairs and 522 M1 pairs, max abs delta 0 | request design fingerprint dd654932... (no runtime build) | pass |
| Frozen before its first held-out read | 2026-10-18T07:10:50Z, read 07:14:43Z | 10:00:36Z, read 10:00:46Z (dense: 07:53:06Z, read 07:56:29Z) | yes |
| X1, fixture held-out expected (optimistic typing) | 27/28 (F3/F5 missed): **met** | 28/28, all 28 in the apply band: **met** (dense 28/28) | >= 27/28 |
| X1, fixture held-out forbidden | 0/35: **met** | 0/35: **met** | 0/35 |
| X2, R_v6 loss over the panel-related pairs | 7/35 = 0.200: **not met** | 4/35 = 0.114: **not met** (dense 0.343) | <= 0.05 |
| X2, R_v9 loss | 13/137 = 0.095 [0.095, 0.101]: **not met** | 4/137 lost (3 related, 1 unlabelled): 0.022-0.029, **met either way**; formally pending the one label (dense the same) | <= 0.05 |
| Typer direction accuracy / swap consistency (G25) | 0.567 / 0.417 with revision 2 (0.550 / 0.433 with revision 1): **not met** | same typer | >= 0.85 / >= 0.90 *(cal.)* |
| Clean check, eval split: precision at the edge(s) | 0.673 at suggest (106 labels) | 1.000 at apply and at suggest (28 pool A labels; pools B and C not replayed) (dense: 1.000 / 0.927, 34 labels) | reported |

Also reported for X1, MLX:
- Pessimistic bound 0/28 and applied-only 0/28: the offline export has no typing, and decision 29 sets no apply band.
- Held-out candidate recall 28/28; tuning in the same export 25/26 at 0/25.

Also reported for X1, Decisions: tuning 25/26 at 0/25, all 25 in the apply band (P02/P03 missed, best mean 1.366, under
the 1.593 suggest edge); the dense design read 26/26.

GGUF is frozen beside MLX and read only on the eval split (0.705 at its suggest edge).

## The local selection (pre-registered rule)

The fit labels are 241 note pairs of pools A-C: T45's labels plus the 2026-10-18 top-up, with population weights by
cell (3.9) and all 137 R_v9 pairs left out.

| Step | Read | Choice |
| --- | --- | --- |
| Instruction | fit-label AUC at 400 characters, max: relation 0.7343, mechanism 0.7325, study 0.7184, default 0.6632 | `relation` (sha256 991ad3a6...) |
| Template | relation, max: 400 0.7343, 600 0.7366 | 600 body characters |
| Aggregation | 5-fold CV log-loss: mean 0.5755, max 0.6133 | mean of both directions |

Relation and mechanism are not an exact tie. No tolerance was pre-registered, so `relation` wins as the rule is
written.

Plan decision 29 sets no apply band. The suggest band starts at the score whose band alone (before typing, capped per
note) finds the most expected fixture-tuning root pairs with 0 forbidden; ties go to the higher edge.

| Decider | Suggest from (mean log-odds) | Map P there | Tuning expected / forbidden | Panel fit labels at the edge, pooled (Wilson, n_eff, recall) | A / B / C | CV ECE / Brier |
| --- | ---: | ---: | --- | --- | --- | --- |
| MLX Qwen3-Reranker-0.6B bf16 | 0.125 | 0.386 | 25/26 / 0/25 (P02/P03 missed) | 0.497 (0.400, 97.0, 0.728) | 0.911 / 0.708 / 0.400 | 0.041 / 0.090 |
| GGUF Qwen3-Reranker-0.6B Q8_0 | 0.6186 | 0.411 | 25/26 / 0/25 | 0.563 (0.461, 92.9, 0.710) | 0.959 / 0.725 / 0.473 | 0.031 / 0.096 |

D18's own reading is reported, not frozen: no level reaches 0.95 / 0.85 (best 0.739 for MLX and 0.627 for GGUF).

## The Decisions decider (plan decision 30)

The decider is `gpt-6-luna`, with one predicate question per candidate and Spike A's frozen `mechanism` instruction.
Each request is a note against its whole decided neighbourhood, in id order, chunked at 20, at 600 characters. Every
pair is asked in both directions and in the bake-off's two candidate orders. The two orders' probabilities are
averaged, read as log-odds at epsilon 1e-7, and the two directions take the mean.

It has its own calibration identity: provider and model, instruction hash, template, rule, and
`requestDesignSha256` 0e1ebd94..., the fingerprint of the whole request design. It has no runtime build, so its
parity is that fingerprint's equality. D18 was applied as written, to the dense validation's two-order-mean fit scores
(`scripts/relations/bakeoff-remote.ts select`, the local proposal's cell weights and folds).

| Read | Value |
| --- | --- |
| p_apply | 0.871: apply from mean 2.372 (CV precision 0.989, Wilson 0.863, n_eff 28.3, 49 labels) |
| p_suggest | 0.601: suggest from 1.497 (precision 0.808, 102 labels) |
| Fixture tuning at the bands | 26/26 expected (all 26 applied), 0/25 forbidden |
| Decision 29's tuning edge, reported beside | 2.382, 26/26 at 0 forbidden; panel at it 1.000 (Wilson 0.877, 48 labels) |
| Cross-validated quality | ECE 0.035, Brier 0.050, AUC 0.953 |
| The accept band by pool | A 0.962, B 1.000, C 0.740 |

### On the product's own requests (the shipped entry)

The T58d review found that the product does not send the dense design. It asks online, as a library grows: a note's
turn sends one forward list and then one reverse list per candidate.
- **The forward list** carries the note's retrieval targets and, room allowing, the notes it was decided against
  before, in content order, capped at 12.
- **Each reverse list** has the candidate as the query and the note as its one target, plus up to 11 of the
  candidate's own earlier partners.
- **The lossless filter:** a reverse direction whose forward probability is 0 in both orders is not asked.

`scripts/relations/bakeoff-online.ts` replayed the fit labels' libraries through the product's builder
(`decisionsNeighbourhood`, `planDecisionRequests`, `buildDecisionsWireRequest`) in arrival order, so "partners decided
so far" built up as in a live library:
- **The fixture:** S0's 138 turns. M1's 111 tuning turns are its first part, unchanged; the 27 held-out turns follow.
- **ENV-G's golden library** (pool B), in its export's order.
- **ENV-C's 200-note sample** (pool C). The library around the sample has no turns of its own, so a library note's
  partners are the sample's earlier decisions only.
- **Spike A's library** (R_v6, approximated): each note's 10 nearest earlier notes by Spike A's cosine.

Labelled pairs the retrieval did not produce (fixture 9, golden 20, corpus 21) were added as extra targets to their
later note's forward list. 2,650 requests on live Decisions cost US$ 0.84 (cap US$ 1.00): synthetic fixture and Spike A
text, and the owner-approved public golden and corpus texts.

The new identity is `requestDesignSha256` dd654932..., which is the desktop app's `decisionsDesign` identity. D18 as
written, seed 20261022, same labels and cell weights:

| Read | Product's online requests (shipped) | Dense design (replaced) |
| --- | --- | --- |
| p_apply, apply from | 0.884, mean >= 2.228 (CV precision 1.000, Wilson 0.890, n_eff 31.2, 54 labels) | 0.871, mean >= 2.372 (0.989, 0.863, 28.3, 49 labels) |
| p_suggest, suggest from | 0.616, mean >= 1.593 (precision 0.810, 96 labels) | 0.601, mean >= 1.497 (0.808, 102 labels) |
| An apply band at other fold seeds | 19 of 40 (1000-1039); none at 1000 and 1001, the same at 1002 | 39 of 40 |
| Fixture tuning at the bands | 25/26 expected (all 25 applied; P02/P03 at 1.366 missed), 0/25 forbidden | 26/26, 0/25 |
| Decision 29's tuning edge, reported beside | 1.366: 26/26 at 0 forbidden; panel at it 0.852 (Wilson 0.735, 91 labels) | 2.382: 26/26; panel 1.000 (48 labels) |
| Cross-validated ECE / Brier / AUC | 0.050 / 0.049 / 0.953 | 0.035 / 0.050 / 0.953 |
| The accept band by pool | A 1.000, B 1.000, C 0.730 | A 0.962, B 1.000, C 0.740 |
| X1 held-out | 28/28 at 0/35, all applied | 28/28 at 0/35, all applied |
| X2 R_v6 / R_v9 | 0.114 / 0.022-0.029 | 0.343 / 0.022-0.029 |

The pre-registered rule reads seed 20261022, which gives an apply band, so the entry ships one. The band is fragile:
at about half of the other fold seeds no level reaches 0.95 / 0.85. The owner should know before relying on automatic
apply.

## The freezes

- **First freeze (local):** `745469e5a7acce86ece3f6d271a9646fd2f06116926080a34d9a9b371760b371`, 2026-10-18T07:10:50.254Z,
  MLX and GGUF.
  - MLX passed on T61's parity numbers.
  - GGUF passed because its proposal scores come from the build that parity names.
- **Re-freeze:** `8017633d054529975c25e2bbd2ae50f03d245e93e3c46c872215c9cb4be3e6e3`, 2026-10-18T07:53:06.300Z.
  - It adds the Decisions entry and keeps the local entries exactly as they were (their `freezeHash` names the first
    freeze).
  - The first record is kept beside it as `frozen-2026-10-18T07-10-50-254Z.json` and named in `previous` (D3).
- **Second re-freeze (the product's requests):** `ae14630a9389761b79b6dfb528d951ac7f5390fd2730549c1b6f74ceba23835a`,
  2026-10-18T10:00:36.743Z.
  - It replaces the dense-design Decisions entry with the one frozen on the product's own requests (the replaced entry
    is recorded under `remote.decisions.superseded`) and keeps the local entries as they were.
  - Both earlier records are kept beside it and named in `previous`.
- **What ships:** `relations-config.ts` ships the two local entries and the online Decisions entry, with
  `decide.bodyCharacters` 600 and `decide.rule` mean, and the catalog's `relations.decide.instruction` at revision 2
  (`relation`).

## Gate F reads

- **X1.** F3's retrieval runs in S0 order on a fresh ENV-F clone: 52 roots released, 39 tuning and then 13 held-out,
  with 138 notes and 1,977 decided pairs.
  - MLX scored every decided pair at relation/600 on T61's build.
  - Decisions answered the same notes' dense requests: 532 requests, US$ 0.22 of the card's US$ 0.28, synthetic
    fixture text only.
  - MLX misses one held-out expected root pair, F3/F5 (best mean -0.906); Decisions finds it.
- **X2 R_v6** (Spike A's 37 reverse-only acceptances).
  - MLX loses 7 of the 35 related pairs: all `extends`, 4 same-root, mean scores -3.25 to -1.06. In all but one, both
    directions are below the edge, so the max of the two directions would not keep them at that edge either.
  - Decisions loses 12, all `extends`, 7 same-root. Their means are 0.06 to 1.39, under the 1.497 suggest edge. In 6
    of them one direction is above it, and the mean of the two directions takes the pair under. Decisions keeps 2 of
    MLX's 7 and loses 7 that MLX keeps.
  - Spike A's library has no F3 export, so its dense shape is approximated: each note's 10 nearest judged rows by
    cosine, and the notes whose 10 nearest hold it.
  - R_v6 is the cost of the mean rule and the bands both deciders' fit labels chose. Changing them now would be
    re-tuning on a gate read, so it is the owner's call.
- **X2 R_v9** (the 137 v9 acceptances on the pinned fixture; the lost-pair panel pass, consistency 16/20).
  - MLX loses 13, all below its edge and all panel-related: `extends` 7, `example_of` 3, `same_as` 3; 4 same-root.
  - Decisions keeps all 13. It loses 4 others, each below its suggest edge: 3 related `extends` pairs (same-root) and
    1 pair no pass has labelled.
  - The Decisions loss is 0.022, or 0.029 if that pair is related. The bar is met either way; one label closes it
    formally.
  - Details: `.cache/f3/freeze/x2-analysis.md`.
- **The typer (G25).** The two reports are `2026-10-18T07-31-49-973Z` (revision 2) and `07-32-53-182Z` (revision 1).
  - Revision 2 reads 0.567 / 0.417, revision 1 0.550 / 0.433, so the strict prompt did not cause the failure.
  - Both name the note shown second as the subject far more often than the panel does (first-position share
    0.26 / 0.32 against 0.50).
  - Of the 60 panel directions, 47 are unanimous.
  - Offline readings (`.cache/f3/freeze/direction-analysis.md`):
    - When the typer's two orders agree (25-26 of 60 pairs) it is right 0.73-0.76 of the time.
    - The local rankers' directional asymmetry carries no direction (MLX 0.48, GGUF 0.48: chance).
    - Decisions' asymmetry carries some: 0.70 on all 60, 0.78 on the 37 pairs whose directions differ by at least 1
      log-odds. Those scores are paid already whenever Decisions decides.
    - 78% of the panel's related pairs, and 92% of the strict typer's answers, have a directed type. The product
      already shows an unknown direction as ↔ with "{subject} and {object} are linked: {word}".
- **The clean check** (the panel's eval split, nothing chosen on it; population-weighted).

| Decider | Labels | Precision at apply | Precision at suggest | Recall at the accept band | ECE | Brier | AUC A / B / C |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| MLX | 106 | - | 0.673 | 0.565 | 0.030 | 0.104 | 0.989 / 0.758 / 0.825 |
| GGUF | 106 | - | 0.705 | 0.457 | 0.088 | 0.098 | 0.985 / 0.807 / 0.831 |
| Decisions (covered labels only) | 34 | 1.000 | 0.927 | 0.785 | 0.032 | 0.011 | - |

Two more reads:
- **Decisions' clean check** covers the eval labels its dense requests answered: 33 of pool A's, 1 of pool B's. Pools
  B and C are public texts that this card did not send.
- **Reconcile dry run on the stored M1 run** (MLX, 0 calls): 109 relations considered. 92 move from apply to suggest,
  17 wait for the next match because their rendered text changed, and none drops out.

## The typer prompt (plan decision 29's experiment)

At the MLX edge, all 147 fit labels were typed in content order on live Codex (14 calls, about 85k tokens).
- **Revision 1:** band + typed precision 0.677, recall kept 0.946.
- **Revision 2,** with the panel's strict relatedness question: 0.746, recall kept 0.906.

Neither reaches 0.80, so there is no "confirmed" tier. Revision 2 ships, and revision 1 stays selectable as
`candidate-shipped-1`.

## Owner-relevant

1. **Local (MLX):** X1 passes; X2 fails on both R_v6 (0.200) and R_v9 (0.095), and the typer's direction fails.
   Every automatic relation is a suggestion (decision 29).
2. **Decisions, on the product's own requests:** X1 passes with every held-out expected pair in the apply band, and X2
   R_v9 passes (0.022-0.029, one label pending). X2 R_v6 fails (0.114, against the dense design's 0.343). D18 gives an
   apply band at the rule's seed, but only at 19 of 40 other fold seeds.
3. **Direction:** neither typer prompt reaches the bars. Options with no extra call:
   - Show every automatic relation's direction as unknown (↔, "linked: supports") until the owner keeps it.
   - Show a direction only where Decisions' two directions differ clearly (0.78 at 37/60).
   - Show it only where the typer's two orders agree (0.76 at 25/60), at a second typing call per pair.
