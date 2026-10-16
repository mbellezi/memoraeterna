# Topic placement and gate calibration (F2 T29a)

Calibration of the Topic Tree Engine's placement and gate parameters (spec section 9, rows z
through mis-parent margin, except bootstrap, rebuild and Areas, which T29b owns). The script is
`scripts/topics/calibrate-placement.ts`, its rules and arithmetic are in
`scripts/topics/calibrate-placement-core.ts` (tested). T29b applies the adopted values to
`packages/domain/src/topic-tree/config.ts`; the per-decider gate values are also stored as
`topic_calibrations` rows by `scripts/topics/save-calibration.ts`.

## Data and seeds

- **ENV-C** (primary): the GGUF app-space export of the 17,735-note corpus library
  (`.cache/topics/vectors/env-c.*`, built with the start config). Its rows are labelled by joining
  `.cache/corpus` (article key `lang:title` → Wikipedia domain; the note text by position within the
  article, checked against the exported section titles). Twins (pt/en mirrors, held out together)
  are the 333 Spike B pairs found on the titled MLX store `corpus`, as for DS-C.
- **DS-C** (cross-check): `corpus-notitle`, the 18,632-note MLX store of Spike B.
- **DS-G / DS-F**: the ENV-G (160 notes, 10 roots) and ENV-F (138 notes, 60 roots) exports in the
  app space, leave-one-source-out (LOSO). A note's label is the leaf a fresh Louvain build of the
  whole set (same seed) gives it.
- **Seeds:** calibration seeds 7-12 only (`calibrationSeeds`, `assertSeedAllowed`); no evaluation
  seed (20261014, 1-5) or evaluation split is used. Medians over seeds are the mean of the two
  middle values.
- Frozen trees are Louvain builds with the start configuration (`buildLouvain`, the product
  builder); placement parameters do not change a build.
- Labels: "right" means the leaf's majority Wikipedia domain is the note's (Spike B's coarse proxy:
  a same-domain leaf counts as right even when the topic is new).

## Registered rules (2026-10-16, before any calibration run)

**R1. Admission: z (`placement.spreadFactor`), a_min (`placement.admissionFloor`),
`placement.spreadFloor`, `placement.leafFloor`.**
- Holdouts per seed on ENV-C and DS-C: known topics (`items`, 20% random notes) and new topics
  (`articles`, 20% whole articles with their twins), each against a frozen tree of the rest; DS-G/F
  LOSO.
- Grid, one at a time around the start (2.5, 0.15, 0.03, 0): z {1.5, 2, 2.5, 3, 3.5}; a_min
  {0.10, 0.15, 0.25, 0.35}; spreadFloor {0, 0.01, 0.03, 0.05, 0.08}; leafFloor {0, 0.3, 0.4, 0.5}.
- Metrics: top-1 domain, admitted to a leaf, gated and auto precision per margin, and separation
  (best right-domain leaf admitted against best wrong-domain leaf admitted).
- (a) Parity: at the start values, the DS-C medians of top-1, admitted, gated at 0.03 and auto
  precision at 0.03 for both holdouts are compared with Spike B's (known 88.9 / 98.0 / 27.8 /
  92.3%, new 69.9 / 87.3 / 48.4 / 71.9%); a gap above 1 point is reported as a finding and changes
  nothing by itself.
- (b) A parameter keeps its start value unless a grid value is better on DS-G/F: the LOSO score
  (share of held-out notes whose PLACE outcome at margin 0.015 is right: a known-topic note
  auto-placed in a leaf of its label, or a new-topic note, whose label no base leaf carries, not
  auto-placed in a leaf), median over seeds and averaged over ENV-G and ENV-F, at least 1 point above
  the start's, while the corpus known-topic medians (ENV-C and DS-C) lose at most 1 point of auto
  precision at 0.015 and at most 2 points of admission. Among qualifying values the highest score
  wins (ties: nearest the start). If several parameters change, the combination is measured and
  must qualify too; otherwise only the parameter with the largest gain changes.

**R2. Ambiguity margin (`placement.ambiguityMargin`).** Known-topic holdouts of ENV-C and DS-C at
the R1 values. Grid {0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05}. Adopt the smallest
margin whose auto precision is at least 90% on every seed of both datasets (D19 a). The gated share
of new-topic notes at that margin is reported against D19 (b), at most 50%.

**R3. Gate T, τ, θ (`gate.temperature`, `gate.tau`, `gate.theta`), per decider.**
- Data: ENV-C new-article holdouts (`articles`, 10% with twins) against a frozen tree, seeds 7-12, at
  the R1 and R2 values. Every gated note is ranked by both deciders, MLX `mlx-qwen3-reranker-0.6b`
  and GGUF `gguf-qwen3-reranker-0.6b-q8-0`, with the gate's own texts (`gate.ts`): the note query
  (Title, Idea, Text) and one descriptor per candidate leaf. Offline leaves have no LLM names, so a
  descriptor is the leaf's TF-IDF provisional name in its majority language plus 3 central titles
  (the E3 proxy, spec R12). Scores are cached by note, descriptor and decider.
- Cross-check: DS-C, the same protocol, seeds 7-9, MLX decider (reported, not adopted).
- Grid: T {0.5, 1, 2} × τ {−2, −1, 0, 1, 2, 3, 4} × θ {0.3, 0.4, 0.5, 0.6, 0.7, 0.8} (126 points),
  on each decider's own log-odds.
- Rule. The spec's "maximize accepted-gate precision subject to D19 (b, c)" is degenerate as
  written (accepting almost nothing maximizes precision; D19 b and c do not depend on T, τ, θ), so
  it is refined: (1) eligible points have a median accepted precision of at least 90% (D19 a's bar
  applied to gate acceptances), every seed at least 85%, and a median accepted share of gated notes
  of at least 10%; (2) among them the highest median correct share (accepted and right, over all
  gated notes) wins; ties within 0.2 points go to the higher median precision, then to the point
  nearest the start (|τ|, then |T − 1|, then |θ − 0.5|); (3) with no eligible point, the highest
  median precision among points with a median accepted share of at least 10% (the literal rule
  with a floor).
- Reported per decider: the "none" share, the margin-only baseline (best admitted leaf) and the
  ranker's own top-1 on the same notes; D19 (c), the p95 wall time of fresh rank calls per gated
  note, at most 0.3 s.
- Config default (used when no calibration row applies): the MLX decider's values (D18, MLX first).

**R3b. Gate: existing topic or new topic (registered 2026-10-16 after R3's MLX results, before
it ran; reported only, it changes no adopted value).** R3's domain proxy rewards accepting a
new-article note into any same-domain leaf, which is the absorption seen on ENV-G. R3b asks whether
the ranker separates notes that belong to an existing topic from notes of a new topic, at the
article level. Known-topic gated notes come from ENV-C `items` holdouts (10%, seeds 7-12, the R1/R2
values, the R3 texts); a candidate is right when its leaf's majority article-with-twin unit is the
note's. New-topic gated notes are R3's (no base leaf holds their article). Per decider and grid
point: known accepted-right and accepted-wrong shares, the new-topic absorbed (accepted) share, and
the balanced accuracy ((known accepted-right + new not absorbed) / 2), against the margin-only
baseline (every gated note placed at its best admitted leaf) and the start values.

**R3c. Gate with the product's descriptors (registered 2026-10-16 after R3's MLX results, before
it ran; reported only).** Offline leaves carry TF-IDF names, the product's carry LLM names,
descriptions and aliases. The exported ENV-C tree has those (1,508 LLM-named topics), so R3b's
known-topic protocol is repeated against it: per seed 7-12, 10% random notes (`items`) are removed
from the exported tree (statistics recomputed without them), placed at the R1/R2 values, and every
gated note is ranked against descriptors with the leaf's LLM title, description, aliases and 3
central titles of the remaining members. A candidate is right when its leaf's majority
article-with-twin unit is the note's. Caveat: the held-out notes were members when the leaves were
named. Reported per decider: the ranker's top-1 against the margin-only choice on the gated notes,
and accepted precision and share at the start values, the R3 point and the best R3b point.

**R4. Label weight (`placement.labelWeight`).** Grid {0, 0.1, 0.2, 0.3, 0.4, 0.5} on the R3
holdouts with the leaves' embedded labels; adopt a value above 0 only if top-1 domain improves by at
least 2 points. Label vectors exist only after naming and label embedding in a profile; when none
are available offline, the value stays 0 and the row says so.

**R5. Split signal (I8, `splitSignal`).** Leaves of at least 6 members of full Louvain builds of
ENV-C and DS-C, seeds 7-12; pure = majority-domain share at least 0.9, impure below 0.6 (Spike B).
Signals (higher = more likely impure): low coherence, the bimodality coefficient of member cosines
to the centroid, the 2-means silhouette, the 5-NN modularity of the 2-means split, and the gate
"none" share (R3 leaves that were the best candidate of at least 3 gated notes, ENV-C only). AUC of
impure against pure per dataset, pooled over seeds. Activate the best signal only if its AUC is at
least 0.75 on every dataset where it is measured; otherwise `off`.

**R6. Sibling merge (`repair.siblingMergeCosine`; `repair.mergeMaxSize` 22 not varied).** Pairs of
sibling leaves in the full builds (R5) whose combined size is at most 22; a pair is right when both
leaves have the same majority article-with-twin unit. Grid {0.75, 0.78, 0.80, 0.82, 0.85, 0.88,
0.90}. Adopt the smallest cosine whose precision is at least 90% on every seed with pairs, with at
least 20 pairs per dataset; otherwise keep 0.85 and report.

**R7. Mis-parent margin (`audit.misParentMargin`).** In each full build (R5), 5% (at least 5) of the
eligible topics (depth ≥ 2, a parent with at least 3 children, an internal uncle; one per
grandparent) are moved under a seeded random internal uncle and the statistics refreshed. Every
re-parent proposal (`reparentTarget`) with gain ≥ the margin is counted; a proposal that moves a
planted topic back to its original parent is right, every other proposal is wrong. Grid {0, 0.025,
0.05, 0.075, 0.1, 0.125, 0.15, 0.2}. Adopt the smallest margin at or above 0.1 (the gate-A
stability calibration) whose precision is at least 90% in every run; recall and the smallest margin
meeting the bar without the floor are reported.

**R8. No-decider fallback (report, D10 and D19).** From the R2/R3 holdouts and the LOSO runs: the
share of notes left waiting without a decider, the precision a margin-only fallback (best admitted
leaf) would give them, and the calibrated gate's outcome on the same notes.

## Evidence (2026-10-16)

All runs on calibration seeds 7-12 (R3's DS-C cross-check: 7-9). Values in
`<cache>/topics/calibration/placement-adopted.json`, rows in `runs/`, ranker scores in
`gate-scores/` (one file per decider key).

| Parameter | Config path | Start → value | Dataset | Method | Rule | Result |
| --- | --- | --- | --- | --- | --- | --- |
| z | `placement.spreadFactor` | 2.5 → **2.5** | ENV-C, DS-C (known, new), DS-G/F LOSO | R1 sweep | R1 (b) | z 2 / 1.5 gain 2.8 / 4.3 LOSO points but cost 3.2 / 8.9 points of corpus known-topic admission (bar 2): not adopted |
| a_min | `placement.admissionFloor` | 0.15 → **0.15** | same | R1 sweep | R1 (b) | 0.10-0.25 identical; 0.35 costs 4.4 points of admission |
| spreadFloor | `placement.spreadFloor` | 0.03 → **0.03** | same | R1 sweep | R1 (b) | best gain 0.7 point (0.05), under the 1-point bar |
| leafFloor | `placement.leafFloor` | 0 → **0** | same | R1 sweep | R1 (b) | 0.3-0.4 change nothing; 0.5 lowers LOSO by 0.5 and corpus admission by 3.5 points |
| Ambiguity margin | `placement.ambiguityMargin` | 0.015 → **0.01** | ENV-C, DS-C known | R2 grid | smallest with auto precision ≥ 90% on every split | 0.01: min 90.1%, median 91.2% (0.005: min 89.7%); gated 11.2% of known-topic notes, 24.0% (ENV-C) / 24.4% (DS-C) of new-topic notes (D19 b ≤ 50%: pass) |
| Gate T, τ, θ (MLX) | `gate.temperature`, `gate.tau`, `gate.theta`; `topic_calibrations` | 1, 0, 0.5 → **1, 0, 0.5** | ENV-C new articles, 2,601 gated notes | R3 grid | R3 | no eligible point (no point reaches 90% precision); the fallback step returns T 2, τ −2, θ 0.3 (70.0%, 60% accepted) and is **not applied** (deviation D-1); start: 67.1% precision, 34.7% accepted, none 65.3%; margin-only 67.3%; p95 192 ms (D19 c: pass) |
| Gate T, τ, θ (GGUF) | `topic_calibrations` row | 1, 0, 0.5 → **1, 0, 0.5** | same | R3 grid | R3 | no eligible point; fallback T 1, τ −2, θ 0.4 (69.0%, 54% accepted) not applied (D-1); start 68.0%, 32.2% accepted; p95 327 ms under a loaded machine (D19 c: fail; wave 4 measured 159 ms) |
| Label weight | `placement.labelWeight` | 0 → **0** | none | R4 | R4 | not measured: no label vectors offline (they need an embedding model, which this task may not load) |
| Split signal (I8) | `splitSignal.signal`, `.threshold` | off → **off** | ENV-C, DS-C full builds; ENV-C gate | R5 AUC | AUC ≥ 0.75 everywhere | best: low coherence 0.669 (ENV-C) / 0.637 (DS-C); bimodality 0.46 / 0.44; 2-means silhouette 0.50 / 0.51; kNN modularity 0.49 / 0.48; gate none share 0.54 (10 impure leaves) |
| Sibling merge | `repair.siblingMergeCosine` | 0.85 → **0.85** | ENV-C, DS-C full builds | R6 | precision ≥ 90% every seed, ≥ 20 pairs per dataset | no cosine qualifies per seed; pooled precision 91.3% at 0.80 (381 pairs), 96.1% at 0.82 (155), 96.6% at 0.85 (29 pairs in 12 builds: merges rarely apply) |
| Mis-parent margin | `audit.misParentMargin` | 0.1 → **0.1** | ENV-C, DS-C full builds, 497 planted errors | R7 | smallest ≥ 0.1 with precision ≥ 90% in every run | no margin meets it per run (worst run 77-82% at 0.1-0.2); pooled precision 91.8% at 0.075, **95.4% at 0.1** (recall 41.4%), 98.4% at 0.2 (recall 12.5%); the gate-A value stays |

### R1 details

Medians over seeds 7-12 at the start values (gated and auto precision at margin 0.01):

| Set | Holdout | Top-1 domain | Admitted | Gated | Auto precision | Right leaf admitted | Wrong leaf admitted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ENV-C | known | 88.5% | 97.2% | 10.5% | 91.3% | 93.7% | 29.8% |
| ENV-C | new | 67.6% | 85.7% | 24.0% | 71.5% | 66.9% | 36.6% |
| DS-C | known | 87.5% | 97.0% | 11.6% | 91.1% | 92.9% | 29.9% |
| DS-C | new | 69.4% | 85.6% | 24.4% | 72.9% | 66.8% | 33.5% |

- Parity with Spike B (DS-C, start values, margin 0.03): known top-1 87.5% (Spike B 88.9%),
  admitted 97.0% (98.0%), gated 26.3% (27.8%), auto precision 92.5% (92.3%); new top-1 69.4%
  (69.9%), admitted 85.6% (87.3%), gated 43.3% (48.4%), auto precision 74.2% (71.9%). Five of eight
  are within 1 point or better; known top-1 (−1.4) and new admitted (−1.7) are close, and new-topic
  gated is 5.1 points lower. The splits differ (calibration seeds 7-12 against Spike B's 20261014
  and 1-5) and the F2 engine adds the leave-one-out mean and the internal percentile to admission,
  so this is reported, not acted on.
- LOSO medians (start values, margin 0.015): ENV-G 44.1% (23% of its held-out notes have a known
  topic), ENV-F 75.4% (90% known). z pulls the two sets apart: z 1.5 raises ENV-G to 58.8% and
  lowers ENV-F to 69.2%; z 3.5 lowers ENV-G to 32.2% and raises ENV-F to 77.5%. A tighter z keeps
  new-topic notes out of existing leaves (the absorption seen in the ENV-G record run) at the cost
  of known-topic admission; the registered guard keeps 2.5.

### R3, R3b and R3c details

- The ranker's confidence carries no precision signal on R3's labels: on ENV-C new-article gated
  notes, accepted precision per seed is 58-76% when 13% of the notes are accepted, 64-79% at 35%
  and 66-72% at 60% (MLX), and the ranker's top-1 equals the margin-only choice (MLX 67.8%, GGUF 67.3% against
  67.3%; on the 1,282 notes whose candidates mix right and wrong domains, 749 / 747 against 748).
  DS-C cross-check at the start values (MLX, 1,309 notes): 74.7% precision, 34.9% accepted,
  margin-only 69.4%.
- R3b (article level; 1,203 known-topic and 2,601 new-topic gated notes):

  | Decider | Point | Known accepted right | Known accepted wrong | New absorbed | Balanced |
  | --- | --- | --- | --- | --- | --- |
  | both | margin-only | 48.0% | 52.0% | 100% | 24.0% |
  | MLX | start T 1, τ 0, θ 0.5 | 33.9% | 26.6% | 34.7% | 49.6% |
  | MLX | R3 fallback T 2, τ −2, θ 0.3 | 42.7% | 37.7% | 60.5% | 41.1% |
  | MLX | best balanced T 0.5, τ 3, θ 0.5 | 23.8% | 13.7% | 13.4% | 55.2% |
  | GGUF | start | 31.6% | 24.5% | 32.2% | 49.7% |
  | GGUF | R3 fallback T 1, τ −2, θ 0.4 | 40.6% | 35.8% | 54.2% | 43.2% |
  | GGUF | best balanced T 0.5, τ 3, θ 0.5 | 23.0% | 13.6% | 12.3% | 55.4% |

- R3c (LLM descriptors of the exported ENV-C tree, 1,018 known-topic gated notes; 73% have a right
  candidate): ranker top-1 48.8% (MLX) / 48.5% (GGUF) against margin-only 46.0%; on the 739 mixed
  notes 66.3% / 65.9% against 62.4%. Accepted precision: start 58.4% (54% accepted) / 61.1% (50%);
  R3 fallback 57.0% (78%) / 57.3% (70%); T 0.5, τ 3, θ 0.5 65.0% (36%) / 65.3% (31%). With the
  product's descriptors the ranker adds about 3-4 points over the centroid order, far from the 90%
  bar.
- **Deviation D-1.** R3's registered rule has no eligible point, so it fell back to its step 3.
  That output is within the flat precision curve above, and R3b (registered before it ran) shows it
  raises new-topic absorption from 35% to 60% (MLX) and lowers balanced accuracy. T29a therefore
  keeps the start values for both deciders and reports the fallback output; applying it instead is
  one change to `gate.*` (orchestrator decision). A future gate calibration needs labels that tell a
  known topic from a new one (R3b's protocol) and the product's LLM descriptors (R3c); on those, the
  stricter T 0.5, τ 3, θ 0.5 cuts absorption to 13% while placing 24% of known-topic gated notes in
  their article's leaf.

### R8: the no-decider fallback (D10, D19)

- D19 (a) does not depend on the decider: auto precision on known topics is ≥ 90% from margin 0.01.
  D19 (b) holds: 24% of new-topic notes are gated at 0.01 (ENV-C 24.0%, DS-C 24.4%). D19 (c) is
  met by MLX (p95 192 ms) and not by GGUF under load (327 ms).
- Without a decider every gated note keeps `needs_gate`, and REBALANCE never moves such an item
  (`isMovableDirectItem`), so it waits at its fallback ancestor until a ranker validates: 24% of
  new-article notes and 10.5% of known-topic notes on ENV-C, plus the unadmitted notes (15% of new,
  about 3% of known), which are movable. On the LOSO sets 6.6% (ENV-G) and 7.2% (ENV-F) of held-out
  notes are gated and 40.6% / 4.4% unadmitted; the record runs' 10-17% Unsorted is this.
- Margin-only placement should not take over: the best admitted leaf of a gated note is right for
  67% of new-article notes by domain, 48% of known-topic notes by article (R3b), and 32% (ENV-G) /
  39% (ENV-F) of LOSO notes by fresh-build leaf, far below D19 (a)'s 90%; it would absorb every
  new-topic note.
- Suggested instead (an engine change, not made here): with no validated decide route, treat a
  gated note as the gate's "none" (`needs_split_check`, movable), keeping a marker so `topic-sweep`
  re-gates it once a ranker validates. REBALANCE can then form leaves from waiting notes (the
  right outcome for new topics) instead of holding them at the root.
- Adopted as owner decision 19 (`decided_by = fallback-none`), measured with the replay's
  `--gate fallback` against `--gate off`, calibration seeds 7-9, adopted defaults (medians of 6
  runs; reports in a worktree's `.cache/topics/reports/decision19`):

  | Run | Gate | Unsorted | E3 max churn (median seed, chron / shuffled) | Fan-out 4-9 (min) | Leaf domain purity |
  | --- | --- | --- | --- | --- | --- |
  | Weekly (E3) | off | 4.4% (4.2-4.7%) | 2.1% / 2.4% | 83.9% (80.9%) | 0.885 |
  | Weekly (E3) | fallback | 4.3% (3.9-4.8%) | 2.5% / 2.4% | 83.8% (79.9%) | 0.886 |
  | Growth (E2) | off | 2.5% (2.2-2.7%) | - | 87.4% (85.2%) | 0.902 |
  | Growth (E2) | fallback | 2.0% (1.6-2.3%) | - | 87.2% (84.8%) | 0.905 |

  E1 holds in every run. Source-by-source growth purity (ENV-G, ENV-F) is 0.817 (off) and 0.819
  (fallback) against 0.901 for the margin-only `baseline`; the ENV-F fixture passes 6 of 6 in all
  three. The fallback makes gated notes movable, but REBALANCE groups few of them: in the weekly
  replay (seed 7, chronological) 8 of 899 fallback notes reached a leaf; the rest sit on the root
  (244) and on internal topics (647, 190 of them in piles of 8 or more on Areas, whose operations
  are proposals), so Unsorted barely moves. Grouping them is REBALANCE's calibration, not the gate's.

### Other findings

- The product does not read `topic_calibrations` yet: `topic-gate.ts` resolves with
  `plan.config.gate`. The per-decider rows (`save-calibration.ts`) record the calibration; the gate
  uses them only once it looks up `activeCalibration(spaceKey, deciderKey)`.
- The registered per-run precision rules of R6 and R7 are too strict for their sample sizes (2-45
  proposals or pairs per run); their pooled precision meets 90% from 0.80 and 0.075.

## Reproduce

```sh
export MEMORA_TOPICS_CACHE=<checkout>/.cache
npx tsx scripts/topics/calibrate-placement.ts admission --dataset env-c --holdout known   # and new; corpus-notitle
npx tsx scripts/topics/calibrate-placement.ts loso --dataset env-g                        # and env-f
npx tsx scripts/topics/calibrate-placement.ts structure --dataset env-c                   # and corpus-notitle
npx tsx scripts/topics/calibrate-placement.ts adopt                                       # R1, R2
npx tsx scripts/topics/calibrate-placement.ts gate-collect --dataset env-c                # R3 (and --holdout known: R3b)
npx tsx scripts/topics/calibrate-placement.ts gate-collect --dataset env-c-named          # R3c
npx tsx scripts/topics/calibrate-placement.ts gate-score --runtime mlx --dataset env-c    # local-model lock; gguf too
npx tsx scripts/topics/calibrate-placement.ts adopt
npx tsx scripts/topics/save-calibration.ts --db <profile>/database/dev-connection.json --dry-run
```
