# Spike B: deterministic topic tree on real embeddings (go/no-go)

2026-10-14, branch `refactoring`, phase F0. Can deterministic code over note embeddings build and maintain
a navigable topic tree that reaches every note, has a sane shape, and that the owner finds coherent?

Revised the same day after an adversarial review. What changed, in short:

- The Louvain root grouping had a defect that left 2 Areas for some seeds and samples. It is fixed, and every
  tree number below is now a range over seeds and samples, not one seed.
- "Depth drifts to 4.4-4.6 after growth" came from that defect and is withdrawn.
- Calibration used to hold out random notes, and every pseudo-note embedded its article title, so held-out
  notes matched their ~20 siblings by title. Calibration now also holds out whole articles together with their
  pt/en twins, and the whole study is repeated on title-stripped embeddings. The old calibration numbers are
  the optimistic known-topic case only.
- Growth now has four arrival orders. The old "chronological (new articles)" run was Portuguese twins of
  English articles already in the tree.
- The in-sample ambiguity figure is no longer evidence; the ambiguity verdict is out of sample only.

## Decision

**Conditional GO** for Louvain over a cosine kNN graph, built in batches, with incremental placement between
rebuilds and a decision gate (reranker) for ambiguous notes. The builder choice and the architecture hold.
Two F0 numbers are weaker than first reported: the ambiguity criterion fails for new topics, and the deep-level
coherence evidence is thin.

| F0 exit criterion (`docs/plan.md`) | Measured | Verdict |
| --- | --- | --- |
| Reachability 100% | 100% in 79 of 79 runs: builds, 80/20 growth (up to four arrival orders) and incremental-from-empty, on corpus, title-stripped corpus, benchmark, owner and mixed. 0 hard violations; each build repeats identically for a fixed seed | pass |
| At least 70% of 30 sampled topics coherent (owner) | 25/30 (83%); well named 23/30. One tree (seed 20261014), title-prefixed embeddings, Wikipedia sections. Level 1: 1/4, level 2: 4/6, levels 3-4: 17/17 but 8 of those 17 are one article (or its pt/en twin) and the 3 owner topics are sections of one document each | pass; deep-level evidence is thin |
| Ambiguity at most 30% *(cal.)* at margin 0.03, out of sample | Known topics (random notes held out or inserted): 19-20% titled, 27-29% title-stripped. New articles inserted one by one: 28-32% / 37-40%. New articles against a frozen tree: 47% / 48% | pass for known topics only; fail for new topics |
| (same) Incremental-only growth from empty | Insert ambiguity 22-28% titled, 32-38% stripped; leaf purity 81-83% against 92% for Louvain (stripped) | not recommended |

Conditions for F2:

1. **Upper levels need help.** The 11 Areas mix 3-4 Wikipedia domains (mean depth-1 domain purity 57%) and
   some level-2 topics sit under the wrong Area. Add LLM-assisted grouping and naming of the top two levels plus
   a deterministic mis-parent audit (see Owner evaluation). The top level is also seed dependent: 7-12 Areas
   and depth-1 NMI 0.56-0.73 over 48 builds (see Stability); the rated tree is one of the better ones.
2. **Names in the content language** (decision 17). The TF-IDF fallback has a content-language mode; LLM naming
   is still needed for good names (see Naming).
3. **Batch builds, incremental in between.** Bootstrap and shadow rebuilds use the Louvain builder; incremental
   placement with local repair runs between rebuilds. Incremental-only trees are clearly worse (below).
4. **A decision gate is load-bearing.** At margin 0.03 a third to a half of the notes of a new topic are
   ambiguous, and top-1 leaf precision for new topics is only about 70% by domain (65-76% over splits and margins
   up to 0.05). The gate (a reranker over at most 5 topic descriptors, or "none of these") must handle new
   topics, not only ties.
5. **The ambiguity target needs re-basing** by the owner/orchestrator: 30% is met for known topics and missed
   for new ones (see Calibration). It is a gate-capacity requirement, not a quality bar.
6. **Shape targets** hold: 75-90% of internal nodes at fan-out 4-9 (target 80%), mean depth 3.6-3.9 (target at
   most 4.5), no depth drift under 20% growth.
7. **Recalibrate on real notes** in F2 shadow mode (golden libraries). Everything here is Wikipedia sections.

## Data

| Dataset | Items | Source |
| --- | --- | --- |
| corpus | 18,632 pseudo-notes (8,706 pt, 9,926 en), 25 domains, 800 articles | Wikipedia (CC BY-SA 4.0), `.cache/corpus/notes.jsonl` |
| corpus-notitle | the same 18,632 notes embedded without the article-title prefix | same text, new embeddings |
| benchmark | 150 notes (pt), 9 fixture families, 53 root sources | `benchmark` scratch cluster (synthetic library) |
| owner | 45 pseudo-notes from 2 root documents (pt) | `owner` scratch cluster, read-only |
| mixed | benchmark + owner + seeded 3,000-note sample of corpus-notitle = 3,195 | interleaved at random as "chronology" |

Pseudo-notes are titled "Article" or "Article - Section". **Title leak.** Every titled embedding input starts
with the article title, so the ~23 notes of one article share a prefix. Removing it (section name only; empty
for introductions) moves a note's vector little (mean cosine 0.970 to the titled vector) but lowers the mean
cosine between notes of the same article from 0.510 to 0.439, while notes of other articles in the same domain
stay at 0.26. Prose still names the subject (the article title appears in 18% of stripped inputs), as real
notes do. The titled store is what the owner rated; the stripped store is the realistic one.

**Twins.** About half of the Portuguese articles mirror an English article. 333 mirror pairs are found by
embedding: inside each domain, pt and en article centroids are paired one by one by decreasing cosine and kept
at 0.60 or more (`twins.json`). Checked by title: pairs at 0.65 or more are mirrors or the same subject seen
from a Brazilian angle (Baroque - Barroco no Brasil), and unrelated pairs start near 0.5. Two true mirrors fall
under the threshold (Screenplay - Roteiro 0.58, Short story - Conto 0.57), a small residual leak. That gives 467
holdout groups. Over-grouping only makes a holdout harsher.

The owner's library has **0 atomic notes** in every backup (13 sources, 10 chunks). Its two root documents
(24k characters; child sections repeat them) were split into pseudo-notes with the corpus splitter. That is
enough for a sanity tree and for the 3 owner topics on the evaluation page, not for calibration.

## Embeddings (MLX first)

- Model: `Qwen/Qwen3-Embedding-0.6B` @ `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3` (`model.safetensors`
  SHA-256 `0437e45c…48e23fd`, Apache-2.0) on the MLX helper `embed` command, last-token pooling, L2
  normalized, 1,024 dimensions, document mode (no instruction).
- Input: the app's note input, `renderPrompt("embedding.content.note")` (title, idea, body). Pseudo-notes
  use the article/section title, the first sentence as idea and the rest as body.
- Corpus throughput: titled 18,632 texts in 195 s (95.5 texts/s), stripped in 190 s (98.0 texts/s, 11.4k
  tokens/s, mean 116 tokens, max 256, none truncated), longest-first, batches of at most 16 under a 4,096-token
  budget. An independent re-time on 256 other texts gave 88-90 texts/s, so quote about 88-98 texts/s.
- Batch sweep (512 random texts, 3 repetitions per size in a rotating order, texts/s, mean with min-max):
  batch 1: 56 (55-56), 4: 83 (80-85), 8: 92 (90-94), 16: 91 (87-96), 32: 84 (82-88). Batches 8 and 16 cannot be
  told apart; use 8-16. The single-pass sweep reported earlier is kept in `embed-throughput.single-pass.json`.
- MLX vs the GGUF vectors the app stored: 150 benchmark notes, mean cosine 0.99957 (min 0.99942), top-5
  neighbour overlap 0.987; 10 owner chunks, mean 0.99943 (min 0.99922) with byte-identical input (content
  hash 10/10). Benchmark hashes did not match (0/150); the database is at migration 23 and probably
  hashed differently (inference), while the cosines show the same input.

## Method

Code: `scripts/spikes/topic-tree/`, seeded. The main seed is `20261014`; robustness runs use that and seeds 1-5.
Each build repeated with the same seed gives identical leaves. Builders: top-down balanced spherical k-means,
bottom-up (Clio-like leaf clusters then centroids), Louvain over a cosine 10-NN graph (exact up to 3k items,
IVF above). All finish with the same forced repair pass. The incremental engine places by beam descent (beam
3) with node-relative admission `max(a_min, m_c - z·s_c)` and repairs locally with cooldowns and a 5% churn
budget. `selfcheck.ts` runs 47 checks on synthetic clusters, all passing.

Changes made during the spike, each re-verified by `selfcheck.ts`:

- **Lift**: a node below fan-out 4 dissolves into its parent (or adopts an internal child's children) when the
  result stays within 4-9.
- Builders split a last-level node into 4 leaves (not 2-3) when leaves still average at least 8 items.
- **Root target 9 Areas** instead of the balanced rule (6): better depth-1 domain NMI with Louvain.
- **Local overflow repair**: split sideways only while the parent has room, otherwise push down locally.
  Leaves under a full parent split downward into 4; the root never grows past 12 from absorbed items.
- z (spread factor) 1.5 to 2.5 from the first calibration (re-checked below: not identified by the data).
- **Root grouping fix (review).** The Louvain builder accepted up to 1.5 x 9 = 13 communities at the root.
  Thirteen is above fan-out.max (12), so they were super-grouped with k = round(13 / 6) = 2 and the root kept 2
  Areas (depth-1 NMI as low as 0.11). Now the root window stops at fan-out.max and, when no resolution fits,
  the super-grouping aims at the 9-Area target. The change touches only the root, so the rated tree
  (seed 20261014, 11 communities, no grouping needed) is bit-identical: same canonical leaf partition before
  and after (SHA-256 `fcc9cca5…da230c0`). Below the root the same window and `round(n / 6)` rule remain
  (7 inner nodes of that tree group 13-19 communities into 2-3 children); changing them would change the rated
  tree and is left open. `selfcheck.ts` has a 13-blob case where the old grouping gives 2 Areas and the new
  one 9. A `rootGrouping: "legacy"` option reproduces the old behaviour for before/after runs.
- **Leaf-only floor**: `placement.leafFloor` (default 0 = off) so the proposed floor can be measured.

Protocol (review):

- **Ambiguity** = share of placements whose best leaf beats the runner-up leaf by less than the margin (0.03
  unless stated). It is reported only out of sample: held-out notes against a frozen tree, or notes inserted
  one by one (each placed before it joins). Re-placing a tree's own items is a self-consistency check
  (`placementInSample`, 4.6% titled and 7.1% stripped for Louvain) and is not evidence.
- **Holdouts** (20%): random notes ("known topics": the siblings of the same article stay in the base);
  whole articles one by one ("twin in base": the review's holdout, the pt/en twin may stay); whole articles
  together with their twins ("new topics"). Calibration repeats on six different splits (seeds).
- **Growth** (build on 80%, insert 20% one by one with local repair), arrival orders: *items* (random notes),
  *chronological* (import order; the tail is the Portuguese half, mostly twins of English articles already in
  the tree), *articles* (new articles with their twins held out), *domains* (about 5 whole domains never seen).
- Other metrics: churn = share of already-placed items whose root-to-node path changed; leaf domain purity =
  item-weighted majority-domain share of leaves; NMI against Wikipedia domains. The domain label is a coarse
  proxy (astronomy vs physics, history vs politics), so errors on new topics are pessimistic.

## Results

Corpus, main seed. Every row: reachability 100%, 0 single-child chains, 0 hard violations, leaf sizes 3-30 for
100% of leaves, Unsorted at most 0.1%.

| Build | Depth mean / p95 | Fan-out 4-9 | Coherence mean / p10 | Silhouette | Leaf purity | Depth-1 / 2 NMI | Language NMI at top | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| top-down, titled | 3.86 / 4 | 92% | 0.713 / 0.652 | 0.021 | 86% | 0.36 / 0.56 | 0.066 | 7 s |
| top-down, stripped | 3.91 / 4 | 95% | 0.686 / 0.635 | 0.008 | 79% | 0.32 / 0.51 | 0.175 | 7 s |
| bottom-up, titled | 3.92 / 4 | 62% | 0.732 / 0.682 | 0.073 | 90% | 0.35 / 0.63 | 0.004 | 29 s |
| bottom-up, stripped | 3.93 / 4 | 51% | 0.701 / 0.657 | 0.051 | 84% | 0.27 / 0.54 | 0.007 | 29 s |
| **louvain, titled** | 3.66 / 4 | 79% | 0.753 / 0.707 | 0.115 | 97% | 0.71 / 0.76 | 0.000 | 48 s |
| **louvain, stripped** | 3.69 / 4 | 85% | 0.722 / 0.680 | 0.089 | 92% | 0.65 / 0.71 | 0.001 | 46 s |
| incremental chronological, titled / stripped | 4.29 / 6, 4.61 / 6 | 80%, 77% | 0.726 / 0.661, 0.693 / 0.641 | 0.037, 0.009 | 90%, 83% | 0.37, 0.13 | - | 0.16-0.19 ms/item |
| incremental shuffled, titled / stripped | 3.23 / 4, 3.20 / 4 | 81%, 75% | 0.719 / 0.661, 0.685 / 0.635 | 0.026, 0.012 | 89%, 81% | 0.46, 0.37 | - | 0.13-0.16 ms/item |

Louvain leads on coherence, silhouette, leaf purity and NMI in both embedding variants (top-down has more
nodes in the 4-9 fan-out band), and the title adds about 5 points of leaf purity and 0.03 of silhouette to it. The stripped Louvain tree is still good (92% purity). At placement,
Louvain is also best on the title-stripped corpus (top-1 domain 88.8% for known topics against 82.3% top-down
and 84.0% bottom-up; 68.8% for new topics against 63.9% and 64.5%), but on the titled corpus it admits far
fewer new-topic notes to a leaf (48% against 91-99%), probably because its leaves are tight (inference).

Louvain's node-relative admission separates the classes best: for known topics (stripped, z=2.5) 82% of the
right-domain best leaf is admitted against 50% of the best wrong-domain leaf; bottom-up gives 84% against 77%
and top-down 85% against 89%, i.e. nothing.

Mixed (3,195, corpus part title-stripped): Louvain again leads (leaf purity 82% against 62-66%, silhouette
0.081 against 0.017-0.030, depth-1 NMI 0.62 against 0.29-0.34). The 45 owner pseudo-notes sit in 2 leaves (88%
owner items) under 2 Areas (51% in the larger); the 150 benchmark notes sit in 14 leaves under 2 Areas (76% in
the larger). Incremental-only trees: purity 61-64%, silhouette -0.006 to 0.004.

Benchmark (150) and owner (45) are one-level trees of 8-10 and 3-4 leaves. **On the only non-Wikipedia labelled
note set, the benchmark, Louvain leaf purity by fixture family is 59%** (top-down 55%, bottom-up 62%; NMI
against root source 0.66), far below the 92-97% on Wikipedia articles. Owner leaf purity is 100% by root
document, which with two documents is a weak test.

**Language.** Top-down splits the top level partly by language (language NMI 0.066 titled, 0.175 stripped).
Louvain and bottom-up are language-neutral at the top (NMI at most 0.007), and 42% (titled) to 52% (stripped)
of Louvain leaves hold both languages, so clustering can stay language-agnostic.

## Stability across seeds and samples

Louvain, 6 seeds x 4 bases (min / median / max). The seed changes the build (kNN lists, Louvain order,
k-means) and, for sampled bases, the sample. Bases: all notes; a random 80%; the first 80% by import order;
80% of the articles with their twins.

| Base | Embeddings | Areas under the root | Depth-1 NMI | Depth mean | Fan-out 4-9 | Leaf purity |
| --- | --- | --- | --- | --- | --- | --- |
| all | titled | 9 / 11 / 11 | 0.66 / 0.69 / 0.71 | 3.66 / 3.74 / 3.82 | 76% / 80% / 85% | 97.1 / 97.2 / 97.3% |
| random 80% | titled | 9 / 9.5 / 12 | 0.63 / 0.68 / 0.71 | 3.59 / 3.71 / 3.86 | 75% / 80% / 84% | 96.8 / 96.9 / 97.0% |
| first 80% | titled | 8 / 10.5 / 11 | 0.56 / 0.66 / 0.69 | 3.61 / 3.67 / 3.80 | 79% / 82% / 85% | 97.0 / 97.1 / 97.1% |
| 80% of articles | titled | 7 / 9.5 / 12 | 0.60 / 0.67 / 0.73 | 3.58 / 3.67 / 3.82 | 79% / 82% / 85% | 97.4 / 97.5 / 97.8% |
| all | stripped | 10 / 10 / 12 | 0.64 / 0.64 / 0.65 | 3.68 / 3.75 / 3.79 | 83% / 85% / 86% | 91.5 / 91.6 / 91.8% |
| random 80% | stripped | 9 / 9.5 / 11 | 0.62 / 0.63 / 0.67 | 3.61 / 3.72 / 3.76 | 83% / 85% / 87% | 90.8 / 91.1 / 91.3% |
| first 80% | stripped | 8 / 10 / 11 | 0.61 / 0.65 / 0.66 | 3.62 / 3.69 / 3.80 | 83% / 86% / 88% | 91.8 / 92.1 / 92.2% |
| 80% of articles | stripped | 10 / 10.5 / 12 | 0.64 / 0.67 / 0.68 | 3.57 / 3.65 / 3.66 | 83% / 87% / 90% | 91.9 / 92.3 / 92.6% |

Over the 48 builds the root has 7-12 Areas and never 3 or fewer. With the old root grouping, 6 of the 24 titled
builds ended with 2 Areas (depth-1 NMI 0.11-0.31, one 0.58; mean depth 3.81-4.57). Headline numbers therefore
read: **7-12 Areas and depth-1 NMI 0.56-0.73 (median about 0.66)**, not "11 Areas and 0.71"; the rated seed is
near the top of the range. Leaf purity, depth and fan-out are stable (spread of about 1 point of purity and 0.3
of mean depth).

## Growth

Louvain, build on 80%, insert 20% one by one (min / median / max over 6 seeds; "x -> y" = right after the build
-> after the inserts). Churn = base items whose path changed. Insert gated = share of inserts whose margin to
the runner-up leaf is below 0.03; unadmitted = not admitted to any leaf.

| Arrival | Embeddings | Areas | Depth mean | Fan-out 4-9 | Depth-1 NMI | Churn | Insert unadmitted | Insert gated at 0.03 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| random notes | titled | 9.5 -> 11 | 3.71 -> 3.71 | 80% -> 79% | 0.68 -> 0.67 | 3.8 / 4.0 / 5.0% | 1.6 / 1.7 / 2.1% | 19.1 / 19.9 / 20.3% |
| import order (pt twins) | titled | 10.5 -> 10.5 | 3.67 -> 3.75 | 82% -> 79% | 0.66 -> 0.63 | 8.1 / 8.6 / 9.1% | 0.8 / 1.1 / 1.7% | 19.2 / 20.4 / 22.6% |
| new articles | titled | 9.5 -> 11 | 3.67 -> 3.72 | 82% -> 78% | 0.67 -> 0.64 | 3.9 / 4.3 / 5.6% | 4.4 / 5.6 / 6.7% | 28.0 / 30.3 / 32.2% |
| new domains | titled | 11 -> 12 | 3.56 -> 3.66 | 80% -> 78% | 0.75 -> 0.67 | 0.6 / 0.9 / 1.4% | 4.5 / 5.4 / 7.1% | 25.6 / 27.7 / 29.0% |
| random notes | stripped | 9.5 -> 10.5 | 3.72 -> 3.71 | 85% -> 81% | 0.63 -> 0.62 | 4.3 / 5.2 / 5.7% | 0.8 / 0.9 / 1.1% | 26.7 / 27.5 / 28.7% |
| import order (pt twins) | stripped | 10 -> 10 | 3.69 -> 3.67 | 86% -> 81% | 0.65 -> 0.63 | 6.9 / 7.7 / 8.4% | 0.3 / 0.5 / 0.5% | 30.3 / 31.0 / 32.0% |
| new articles | stripped | 10.5 -> 12 | 3.65 -> 3.66 | 87% -> 83% | 0.67 -> 0.65 | 4.5 / 5.1 / 5.5% | 1.6 / 1.6 / 2.1% | 36.7 / 37.8 / 39.6% |
| new domains | stripped | 11 -> 12 | 3.55 -> 3.60 | 84% -> 82% | 0.72 -> 0.64 | 1.8 / 2.8 / 3.3% | 1.7 / 2.3 / 4.2% | 35.2 / 37.2 / 39.3% |

- **No depth drift.** Mean depth moves by at most +0.17 (max 3.88 over 48 runs, median change 0.0-0.09).
  The "4.4-4.6 after growth" in the first write-up came from base trees that already had 2 Areas: re-running
  the old grouping on the same split gives depth 4.57 before the inserts and 4.56 after (root 2 -> 7 Areas),
  and 4.34 -> 4.40 for the import-order split (root 2 -> 2). The rebuild-cadence advice built on it ("after about 20% growth") is
  withdrawn; no cadence follows from shape drift.
- **Churn** is 0.6-9% of the base for 25% growth (the weekly 3% target depends on the growth rate and on
  rebuilds with Hungarian ID mapping, untested). It is highest when the arrival is the import order.
- **New domains** are absorbed into the existing Areas because the root is capped at 12: depth-1 NMI falls
  from 0.72 to 0.64 (stripped) and 0.75 to 0.67 (titled). That, not depth, is the signal for a shadow rebuild.
- **Unsorted** (items on internal nodes) after growth is 0.1-0.9% (main seed).
- Louvain inserts cost 0.14-0.19 ms each (placement plus local repair). From an empty tree, two insertion orders
  agree at leaf NMI 0.80 (titled) and 0.75 (stripped).

## Owner evaluation

`.cache/spikes/topic-tree/avaliacao.html` (page `709dd5c05206`, Louvain, seed 20261014, titled embeddings): 27
corpus topics sampled 4/6/8/9 across levels 1/2/3/4+ and 3 owner topics, 8 random members each. Ratings
(decision 17): coherent 25/30, well named 23/30; level 1: 1/4, level 2: 4/6, levels 3-4: 17/17, owner: 3/3.
A domain-purity proxy (at least 70% one domain) ranks the levels the same way: 2/4, 5/6, 16/17 and 3/3, but two
rejected upper topics ("language", "poetry") are over 90% one domain: a few stray subtopics among 8 sampled
members are enough for a reader to reject a broad topic. The owner rejects mixed pt/en names such as
"solar, estrelas, stars".

**What the 17/17 and 3/3 do and do not show.** They hold for Wikipedia article sections. Of the 17 rated deep
topics (levels 3-4), 8 are one article (or its pt/en twin) and 10 hold at most two; the other 7 mix 3 or
more articles. All pseudo-notes carry the article title. Each owner topic is a set of sections of one root
document, so it tests splitting a document, not clustering a library. On the benchmark, the one non-Wikipedia set, leaf
purity by fixture family is 59%. Reliable deep levels are not shown for real notes: rate golden-library notes
in F2 before relying on them. The rated tree was built before the root fix and is unchanged by it.

Upper-level audit (`audit-top-levels.ts`, same build): mean domain purity 0.57 at depth 1, 0.92 at depth
2, 0.97 below. A topic is mis-parented when an uncle centroid is closer than its parent's: 3.1% of depth-2
topics, 1.3% at depth 3, 0.7% at depth 4. Examples: Tropicália under "language" (closer to music, margin
-0.14), Portinari under "law", capoeira under "ecosystems", Fourier analysis under "stars". This check is
deterministic and cheap, so F2 can run it as an AUDIT step and propose re-parent operations.

**Naming.** `naming.ts` takes `contentLanguage`: only content-language items and stopwords produce
terms, and a topic with fewer than 2 of them gets "Tópico sem nome" / "Unnamed topic". With pt on the
corpus, levels 1-2 keep pt names (0% and 5% unnamed); levels 3-4 fall back for 20-29% of topics
(English-only articles). Placeholders are acceptable as a fallback, but LLM naming is still needed.

## Calibration

Louvain, six splits (min / median / max), 20% held out, margin 0.03 unless stated; "auto precision" = among
notes above the margin, the best leaf's majority domain is the note's domain.

| Held out | Embeddings | Top-1 domain | Admitted to a leaf | Gated at 0.02 | Gated at 0.03 | Auto precision at 0.03 |
| --- | --- | --- | --- | --- | --- | --- |
| random notes (known topics) | titled | 94.4 / 94.6 / 94.8% | 95.5 / 95.9 / 96.4% | 13.3 / 13.7 / 14.2% | 19.0 / 19.4 / 20.5% | 96.4 / 96.5 / 96.5% |
| articles, twin in base | titled | 77.5 / 82.4 / 83.6% | 65.7 / 68.1 / 69.2% | 24.2 / 25.2 / 25.9% | 34.2 / 35.0 / 36.2% | 83.2 / 87.0 / 88.6% |
| articles + twins (new topics) | titled | 64.5 / 69.0 / 73.6% | 48.0 / 54.0 / 55.5% | 33.4 / 34.3 / 36.0% | 46.8 / 47.1 / 49.2% | 64.6 / 71.3 / 78.0% |
| random notes (known topics) | stripped | 88.2 / 88.9 / 89.3% | 97.8 / 98.0 / 98.5% | 18.2 / 19.3 / 20.9% | 27.3 / 27.8 / 29.4% | 91.9 / 92.3 / 92.5% |
| articles, twin in base | stripped | 76.4 / 77.7 / 78.8% | 89.3 / 90.8 / 92.5% | 27.6 / 28.3 / 30.2% | 38.1 / 39.1 / 41.7% | 81.2 / 82.2 / 83.7% |
| articles + twins (new topics) | stripped | 68.7 / 69.9 / 72.7% | 86.1 / 87.3 / 88.3% | 34.5 / 35.5 / 36.1% | 46.5 / 48.4 / 49.7% | 69.0 / 71.9 / 74.3% |

The first write-up's numbers (top-1 94.8%, admitted 96.4%, 19.8% gated, auto precision 96.5%) are the first row
(main seed reproduced exactly): the optimistic case. Holding out whole articles with their twins drops top-1
to about 70% and raises the gated share to 47-49%. The review's holdout (twin left in the base) reproduces
its figures closely (top-1 82%, auto precision 87% titled; admitted 68% against its 72%, gated 35% against its
32%, on other splits) and still leaks across languages. Growth (above) is the sequential view: a new article's
first notes create the leaf its later notes find, so the gated share is lower (28-40%) than against a frozen
tree (47-49%).

What the data support for F2 (Louvain, title-stripped unless stated; ranges over the six splits):

- **z.** The admission rule separates the right-domain best leaf from the best wrong-domain leaf for known
  topics (z=2.5: 82-83% against 50-54%; z=2: 75-76% against 36-39%; z=3: 87-88% against 64-68%) but not for new
  topics (65-70% against 44-52%). Moving z by 0.5 shifts admission by 2-18 points and the precision of
  admitted notes by about 1 point. z is not identified within 2-3; keep 2.5.
- **a_min.** 0.15 and 0.25 are identical; 0.35 only lowers admission (97% to 93% known, 87% to 84% new) for no
  precision gain.
- **Leaf-only floor.** Implemented as an option and measured; **not adopted.** At 0.40 admission drops by
  about 1 point or less and precision rises by 0.2. At 0.50 it trades 4 points (known) to 15 points (new) of
  admission for +1.3 points of precision, and the best other-domain leaf has cosine p50 0.49 (p90 0.60)
  against 0.61 for the right one on known topics. The old "0.40" proposal was untested and does not separate.
- **Margin.** Fixed from an external target before reading the curves: the smallest margin keeping auto-placed
  domain precision at or above 90% on known-topic growth. Stripped: 0.01 gives 89.8-90.4% (not in all six
  splits), **0.015 gives 90.5-91.1%** and gates 13.8-16.4% (titled: 94-95% already at margin 0). It gates 26-28%
  of new-topic notes. No margin up to 0.05 reaches 90% on new topics (stripped: 69-74% at 0.03, 69-76% at 0.05;
  74% at 0.08 on the main split), so the margin is the wrong lever there: it moves the gated share a lot and
  precision by 1-4 points.
- **Coherence floor for split candidates: not supported.** `coherence-check.ts`: a floor of 0.65 flags 1 of 32
  impure leaves (stripped; 0 of 6 titled) and 9 of 760 pure ones; the AUC of low coherence for impure against
  pure leaves is 0.60 stripped and 0.50 titled. Louvain's impure leaves are as coherent as its pure ones
  (mean 0.723 against 0.740 stripped; 0.767 against 0.764 titled). The 0.65 came from top-down and bottom-up
  leaves. No replacement signal was tested; calibrate a split trigger on real notes in F2 shadow mode.
- **Merge sibling leaves.** Same-article sibling leaves have centroid cosine p50 0.73, p90 0.81 and other
  siblings p95 0.80 (stripped; titled 0.78, 0.85 and 0.82), so the 0.85 rule merges few leaves. Keep it as
  a conservative start.

On MLX the gate (a reranker over at most 5 topic descriptors) costs an estimated 0.1-0.2 s per gated note at
Spike A latencies (estimate, not measured here); at 30-50% gated that is minutes per thousand notes, so cost
is not the constraint, decision quality is.

## F2 start values *(cal.)*

| Parameter | Start value | Evidence |
| --- | --- | --- |
| Builder | Louvain on cosine 10-NN, up to 8 resolution tries; root window at most fan-out.max, root grouping toward 9 Areas | Best purity, silhouette and NMI in both embedding variants; 48 builds, never fewer than 7 Areas |
| Areas (root) | 9 targeted (7-12 obtained) | Depth-1 NMI 0.56-0.73; expect to need LLM grouping |
| Fan-out / leaf / depth | 2-12 (4-9, hard 16) / 3-30 (15, hard 45) / target 5, cap 7 | 75-90% at fan-out 4-9, 100% of leaves at 3-30, mean depth 3.6-3.9 |
| z (spread factor) | 2.5 | Not identified in 2-3 (see above) |
| a_min (all nodes) | 0.15 | 0.15-0.25 identical; 0.35 only lowers admission |
| Leaf-only floor | none (`leafFloor` = 0) | Does not separate right from wrong leaves |
| Ambiguity margin | 0.015 | Smallest margin with auto precision at least 90% on known topics (external target); gates 14-16% there, 26-28% on new topics |
| Coherence floor (split candidate) | none | Cannot flag mixed Louvain leaves (AUC 0.50-0.60) |
| Merge sibling leaves | centroid cosine at least 0.85, result at most 22 (conservative) | Same-article siblings p90 0.81 |
| Churn budget / cooldown | 5% of items per soft repair / 25 inserts | 80/20 churn 0.6-9.1% |
| Shadow rebuild | on a quality drop or a burst of unadmitted notes (new domains: depth-1 NMI -0.08) | No depth drift; cadence is not a function of growth share |

## Risks and open issues

1. **Representativeness.** Wikipedia pseudo-notes share vocabulary and article structure; the title leak is
   removed in the stripped runs but siblings still share subject words. The owner has no real notes yet.
   Recalibrate in F2 shadow mode on golden libraries.
2. **Upper levels** (condition 1): no LLM grouping was tested; the audit catches only centroid-level
   mis-parenting, not Areas that are coherent by centroid but mixed to a reader. The inner super-grouping rule
   (2-3 children for 13-19 communities) is unchanged.
3. **New topics.** Top-1 domain precision for notes of unseen articles is about 70% and the gated share 47-49%
   against a frozen tree. The domain label is coarse, so true quality is higher, but this is unmeasured. The
   gate's behaviour on new topics is the real F2 test (Spike A reranker).
4. **Growth.** Whole new domains are absorbed under a root capped at 12 Areas (depth-1 NMI -0.08); the weekly
   3% churn target depends on the growth rate and on rebuilds with Hungarian ID mapping (untested).
5. **Cost.** The Louvain build takes 46-48 s for 18.6k items on one thread (needs the clustering worker);
   kNN is approximate (IVF) above 3k items. The reranker gate is untested here.
6. **Coverage.** Removal, edit and N/LS drift were checked only on synthetic data (`selfcheck.ts`). The spike
   scripts have no vitest coverage (the root config does not include `scripts/`). Twin detection is by
   embedding (cosine at least 0.60).

## Reproduce

```bash
npx tsx scripts/spikes/topic-tree/selfcheck.ts                   # synthetic invariants (47 checks)
npx tsx scripts/spikes/topic-tree/embed-real.ts                  # MLX vectors -> .cache/spikes/topic-tree/vectors
npx tsx scripts/spikes/topic-tree/embed-real.ts --only corpus-notitle --no-compare   # title-stripped corpus
npx tsx scripts/spikes/topic-tree/embed-throughput.ts --reps 3   # batch-size sweep, 3 repetitions
npx tsx scripts/spikes/topic-tree/run-real.ts                    # builds, growth, calibration -> real-results.json
npx tsx scripts/spikes/topic-tree/summarize-real.ts              # tables -> real-results.md
npx tsx scripts/spikes/topic-tree/stability.ts --dataset corpus --mode build      # seeds x bases (also corpus-notitle,
npx tsx scripts/spikes/topic-tree/stability.ts --dataset corpus --mode growth     #   --grouping legacy, --mode calibration)
npx tsx scripts/spikes/topic-tree/stability.ts --summary         # ranges -> stability.md
npx tsx scripts/spikes/topic-tree/coherence-check.ts             # coherence as a mixed-leaf signal
npx tsx scripts/spikes/topic-tree/evaluation-page.ts --builder louvain   # avaliacao.html + avaliacao-key.json
npx tsx scripts/spikes/topic-tree/audit-top-levels.ts            # upper-level audit
```

The embedding scripts wait for the local-model mutex (decision 16) and need `npm run mlx:build` and the
pinned weights; `embed-real.ts` and the owner/benchmark loaders need the `owner` and `benchmark` scratch
clusters running (`scripts/db/restore-backup.ts --keep-running`). All outputs live under
`.cache/spikes/topic-tree/` (gitignored): `real-results.json|md`, `stability-*.json`, `stability.md`,
`twins.json`, `coherence-check.json`, `embed-throughput.json`.
