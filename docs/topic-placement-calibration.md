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

## Evidence

Results are filled in after the runs.
