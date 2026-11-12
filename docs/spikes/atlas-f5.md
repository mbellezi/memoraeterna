# Atlas spike: is a 2-D map of the topic tree worth building in F6? (F5 T153, 2026-11-11)

Record only (D21): no model, no Electron, no remote call, no code in the app. The question is whether the stored note
vectors, drawn in 2-D with UMAP, keep each level-1 branch together (contiguity) and give the same map on every run
(Procrustes disparity), well enough to build Map > Atlas as a product lens in F6.

**Verdict on the frozen criterion: no-go.** Contiguity passes on both datasets; seed-to-seed disparity fails on both.

| Dataset | Points | Level-1 branches | Contiguity (mean of 3 UMAP seeds) | Bar | Disparity (max of 3 pairs) | Bar | Met |
| --- | --- | --- | --- | --- | --- | --- | --- |
| golden-small (weak) | 160 | 7 | 0.761 | >= 0.70, met | 0.476 | <= 0.20, not met | no |
| ENV-C | 18,632 | 11 | 0.958 | >= 0.70, met | 0.910 | <= 0.20, not met | no |

The two numbers say different things. The local picture is good: on ENV-C the 10 nearest 2-D neighbours of a note share
its branch 96% of the time, more than its 10 nearest neighbours in the 1024-d space do (92.5%), and far more than PCA
(18%). The global picture is not stable: the three seeds place the branches in unrelated arrangements (disparity 0.73,
0.73 and 0.91 on ENV-C). A map whose layout changes at every redraw cannot be a place the person learns. The criterion
was frozen before the first run and is applied as written; "Reading" below says what the failure does and does not mean.

## Frozen criterion (registered 2026-11-11, commit d6058f49, before any run)

`scripts/spikes/atlas/criterion.ts` holds the thresholds and the statistic of each; the test `metrics.test.ts` pins them.

- **Go for F6** only when, on both datasets, level-1 contiguity >= 0.70 and Procrustes disparity <= 0.20.
- **Contiguity** of a note: the share of its 10 nearest 2-D neighbours (Euclidean, among all points) that carry its
  level-1 branch. A run's value is the mean over the measured notes (note-weighted); a dataset's value is the mean over
  UMAP seeds 1, 2 and 3. The level-1 branch is the child of the root that holds the note's primary placement (rank 0);
  a note on the root itself is a point that never matches and is not a measured member (6 of the 160 on golden-small, none on ENV-C).
- **Disparity** of two maps: both centred and scaled to unit norm, the best rotation or reflection fitted, the residual
  sum of squares (the value `scipy.spatial.procrustes` returns). A dataset's value is the maximum over the three seed
  pairs.
- **UMAP:** umap-js 1.4.0, n_neighbors 15 (self included), min_dist 0.1, 2 components, Euclidean distance on unit
  vectors, exact neighbour lists, random start (umap-js has no spectral start).
- The golden-small result is marked weak (7 level-1 topics, 160 notes; the spec said 8 topics) and still has to meet the bars.
- No re-registration was made. Any later change of a threshold, statistic or method is a re-registration and must be
  reported as one.

## Data

| | golden-small | ENV-C |
| --- | --- | --- |
| Vectors | replay store `.cache/topics/vectors/env-g.*` (160 notes, 1024-d, Qwen3-Embedding-0.6B GGUF, space `42808f3f...`) | the clone's stored note vectors in the active tree's space, through the topic load repository |
| Placements | an `env-g` clone: its active tree `ad4365de...` (19 topics, 7 at level 1, 170 placements) | an ENV-C clone: active tree `4aa3915b...` (1,975 topics, 11 at level 1, 19,633 placements) |
| Tree generation | clone 25; the store was exported at 15: **differs** | clone 327 |
| Notes on the map | 160 of 160 (154 measured: 6 sit on the root) | 18,632 of 18,632 placed notes (the older replay store holds 17,735) |

Three facts about golden-small differ from what the card assumed (the D21 text and CT19 expected the store's own tree):

1. **The store's tree is not in the clone.** The store was exported from tree `81961e5a...` (generation 15); the
   `env-g` profile has since activated tree `ad4365de...` (generation 25, activated 2026-10-17). Same embedding space
   (`spaceKey` equal), so the spike takes the clone's active tree and reports the difference.
2. **The note ids differ.** The clone holds the same 160 notes under new ids: 0 of 160 store ids exist in the clone.
   The spike pairs the store's notes with the clone's by the content hash of the embedding text: 160 of 160 paired, none
   ambiguous. As a check, the cosine between each store vector and the clone's own stored vector is 1.0000 (minimum
   0.99999999), so the store vectors are the clone's vectors and the pairing is right.
3. **The clone is at migration 0055**; the spike reads only tables of that schema, so no migration was needed.

## Results

### 1024-d kNN purity (k = 10, exact), the ceiling of what a map can keep

| Dataset | Purity | Chance (sum of squared branch shares) | Macro mean (branches >= 5 notes) | Lowest branch |
| --- | --- | --- | --- | --- |
| golden-small | 0.721 | 0.191 | 0.617 | 0.350 (Medida de economia na memória, 6 notes) |
| ENV-C | 0.925 | 0.113 | 0.923 | 0.873 (Cultura, religião e artes) |

### 2-D maps

| Dataset | Map | Contiguity | Macro | Lowest branch | Branches in one component | Mean share in the largest component |
| --- | --- | --- | --- | --- | --- | --- |
| golden-small | UMAP seed 1 | 0.745 | 0.657 | 0.233 | 4 of 7 | 0.878 |
| | UMAP seed 2 | 0.782 | 0.691 | 0.300 | 5 of 7 | 0.906 |
| | UMAP seed 3 | 0.757 | 0.669 | 0.233 | 4 of 7 | 0.878 |
| | PCA | 0.606 | 0.452 | | 2 of 7 | 0.832 |
| ENV-C | UMAP seed 1 | 0.958 | 0.957 | 0.923 | 0 of 11 | 0.806 |
| | UMAP seed 2 | 0.958 | 0.958 | 0.931 | 0 of 11 | 0.879 |
| | UMAP seed 3 | 0.957 | 0.956 | 0.927 | 0 of 11 | 0.815 |
| | PCA | 0.184 | 0.146 | | 0 of 11 | 0.103 |

"Components" are the connected components of a branch's notes in the 2-D 10-NN graph. On ENV-C every branch is drawn as
many islands (seed 1: 9 to 59 each; 54 to 98% of its notes in the biggest), as the pictures show.

Procrustes disparity between seeds (pairs 1-2, 1-3, 2-3): golden-small 0.095, 0.422, 0.476; ENV-C 0.732, 0.733, 0.910.
PCA keeps 11.8% and 5.7% of the variance on golden-small and 3.1% and 2.6% on ENV-C: a linear 2-D view is not a
candidate for either.

Per-branch tables, the epochs and run times are in `.cache/f5/atlas/metrics.json` and
`.cache/f5/atlas/<dataset>/metrics.json`. The pictures are `.cache/f5/atlas/<dataset>/umap-seed{1,2,3}.png` and
`pca.png` (one colour per level-1 branch, grey for none; gitignored). Cost on a loaded Mac (load 45): exact 1024-d kNN on
ENV-C 105 s; UMAP 7 s per seed on ENV-C and 0.1 s on golden-small.

## Reading

- **What passes.** The embedding space already carries the branches (purity 0.925 against 0.113 by chance on ENV-C) and
  UMAP keeps that locally (0.958). A reader looking at one region of an UMAP map would see notes of one branch together.
  PCA does not do this.
- **What fails, and why it is probably the method rather than the data.** The two datasets fail by different margins
  (0.48 and 0.91), and the golden-small pair 1-2 alone is 0.095, so the disparity is driven by how the islands are
  arranged, not by what is inside each. umap-js starts from uniform random positions and has no spectral initialisation,
  so each seed lays the islands out anew. This is a hypothesis from the implementation, not measured here: nothing in the
  spike runs a different initialisation.
- **Other limits.** Every branch splits into islands on ENV-C (which the person would see as one branch in several
  places). The `Artes e cultura` and `Cultura, religião e artes` branches of the ENV-C tree overlap in meaning, so some of
  the 4% non-contiguity is the tree's, not the map's. golden-small has 160 notes, 7 branches and one branch of 6 notes;
  its numbers move with a few notes. The disparity statistic compares random-start runs, the hardest case; a product
  map would fix its layout once and keep it.
- **What this does not show.** Whether a fixed layout (a spectral or PCA start, then a stored layout updated
  incrementally) would pass. That is a different test than the registered one.

## Decision input for F6

On the frozen rule the Atlas does not go. Two ways forward, for the owner or orchestrator to choose; neither has been
run and neither changes this verdict:

1. **Do not build the Atlas lens in F6** (the default of the plan: it builds only on a go).
2. **Re-register and re-run once:** an initialisation that does not depend on a seed (spectral or PCA start, from an
   implementation that offers it), the same contiguity bar, and a stability test that compares a stored layout with
   the layout after adding 5% new notes instead of seed against seed. It would be reported as a new registration, with the
   result above kept as the first.

## Reproduce

Only the `database/` folder of a profile is cloned (APFS clone, as gate M did); nothing in `.cache/profiles/*` is
started or written, and the scripts start a throwaway PostgreSQL through `scripts/lib/profile-server.ts` on the clone,
read-only.

```sh
mkdir -p .cache/f5/scratch/atlas/env-g .cache/f5/scratch/atlas/env-c
cp -cR .cache/profiles/env-g/database .cache/f5/scratch/atlas/env-g/database
cp -cR .cache/profiles/env-c/database .cache/f5/scratch/atlas/env-c/database
npm run atlas:spike -- --gs-profile "$PWD/.cache/f5/scratch/atlas/env-g" \
  --gs-vectors .cache/topics/vectors/env-g --profile "$PWD/.cache/f5/scratch/atlas/env-c"
```

`--only golden-small` or `--only env-c` runs one dataset (no verdict is given). The run is deterministic: the seeds
are fixed and the neighbour search is exact, so a second run gives the same numbers. Files: `scripts/spikes/atlas/`
(`criterion.ts` the frozen rule, `sources.ts` the two readers, `dataset.ts` and `branches.ts` the pairing and labels,
`metrics.ts`, `procrustes.ts`, `pca.ts`, `umap.ts`, `png.ts` and `analyse.ts` the analysis, `run.ts` the command) with
their tests; `npm run typecheck:scripts` covers them.
