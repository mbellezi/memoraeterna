// The Atlas spike's go criterion (F5 D21), frozen before the first run.
//
// Registered: 2026-11-11, in the commit that adds this file, before any run of `atlas:spike` on the
// golden-small or the ENV-C data. A change after the first run is a re-registration and the report
// says so; it is never presented as the same test.
//
// Go for F6 (Map > Atlas as a product lens) when, on BOTH datasets:
//   - level-1 contiguity >= 0.70, and
//   - Procrustes disparity between UMAP seeds <= 0.20.
// The golden-small result is weak (8 level-1 topics, 160 notes): the report marks it, the rule does not
// change. Anything that is not a go on both datasets is reported as "no go".
//
// Definitions (the statistic is part of the registration, not only the threshold):
//   - Level-1 branch of a note: the child of the root that holds the note's primary placement
//     (rank 0) in the tree. A note placed on the root itself has no branch; it stays a point of the
//     map (a neighbour that never matches) but is not a measured member.
//   - Contiguity of a member: the share of its 10 nearest 2-D neighbours (Euclidean, among all points of
//     the map) that carry its branch. Level-1 contiguity of a run is the mean over the measured
//     members (note-weighted). The dataset's value is the mean over the three UMAP seeds.
//   - Procrustes disparity of two maps: both centred and scaled to unit Frobenius norm, the best
//     orthogonal fit (rotation or reflection) of one onto the other, the residual sum of squares
//     (scipy.spatial.procrustes). The dataset's value is the maximum over the three seed pairs.
//   - UMAP: umap-js, n_neighbors 15 (self included), min_dist 0.1, 2 components, Euclidean distance on
//     unit vectors, exact neighbour lists, seeds 1, 2 and 3 (random start; umap-js has no spectral one).
export const atlasCriterion = Object.freeze({
  decision: "D21",
  registeredOn: "2026-11-11",
  /** Neighbours in the 1024-d purity and in the 2-D contiguity. */
  neighbours: 10,
  umap: Object.freeze({
    nNeighbors: 15,
    minDist: 0.1,
    nComponents: 2,
    seeds: Object.freeze([1, 2, 3] as const)
  }),
  minLevelOneContiguity: 0.7,
  maxProcrustesDisparity: 0.2,
  /** Branches with fewer members are listed but left out of the macro mean. */
  macroMinMembers: 5
});

export interface DatasetOutcome {
  name: string;
  /** The golden-small data is too small to carry the decision on its own. */
  weak: boolean;
  /** Mean over the seeds of the note-weighted level-1 contiguity. */
  contiguity: number;
  /** Maximum Procrustes disparity over the seed pairs. */
  disparity: number;
}

export interface DatasetJudgement extends DatasetOutcome {
  contiguityMet: boolean;
  disparityMet: boolean;
  met: boolean;
}

export function judgeDataset(outcome: DatasetOutcome): DatasetJudgement {
  const contiguityMet = outcome.contiguity >= atlasCriterion.minLevelOneContiguity;
  const disparityMet = outcome.disparity <= atlasCriterion.maxProcrustesDisparity;
  return { ...outcome, contiguityMet, disparityMet, met: contiguityMet && disparityMet };
}

export interface AtlasVerdict {
  verdict: "go" | "no-go";
  datasets: DatasetJudgement[];
}

/** Go only when every dataset meets both bars; a missing dataset is never a go. */
export function judgeAtlas(outcomes: readonly DatasetOutcome[], expected = 2): AtlasVerdict {
  const datasets = outcomes.map(judgeDataset);
  const go = datasets.length >= expected && datasets.every((dataset) => dataset.met);
  return { verdict: go ? "go" : "no-go", datasets };
}
