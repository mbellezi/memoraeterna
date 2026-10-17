// Discovery pairs of design E (F3 D27): a root that has just matched is judged against its nearest
// earlier root and against every earlier root it is now nearest to (its reverse neighbours), on the
// stored composite vectors of one embedding space. Pure: the source matcher and the order replay
// (`scripts/golden/source-order-replay.ts`) share it.

/** An earlier root, already matched in the same space, with current notes. */
export interface DiscoveryCandidate {
  rootId: string;
  /** Content tie-break (the root's title): roots get new IDs on every import. */
  title: string;
  /** Cosine of the candidate's composite vector and the new root's. */
  cosine: number;
  /** A source relation already links the two roots: never selected, its state is kept. */
  linked: boolean;
  /** The candidate's nearest root, as discovery last stored it. */
  nearestRootId: string | null;
  /**
   * The bar a later root must beat to be among the candidate's nearest: the cosine of its k-th
   * nearest root; null while it has fewer than k, when any root beats it.
   */
  nearestCosine: number | null;
  /** Cosine of the candidate and its nearest root; null without one. */
  nearestRootCosine: number | null;
}

export interface DiscoveryPair {
  rootId: string;
  /** `nearest`: one of the new root's nearest; `reverse`: the new root beat the candidate's bar. */
  reason: "nearest" | "reverse";
  cosine: number;
}

export interface DiscoverySelection {
  /** The pairs to judge, each candidate once, nearest first then by cosine. */
  pairs: DiscoveryPair[];
  /** The new root's own state: its nearest root and its bar. */
  state: { nearestRootId: string | null; nearestCosine: number | null };
  /** Earlier roots whose nearest set the new root joined: their new state. */
  reverse: Array<{ rootId: string; nearestRootId: string; nearestCosine: number | null }>;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Highest cosine first; ties by title, then by ID (only between identical content). */
export function compareDiscoveryCandidates(a: DiscoveryCandidate, b: DiscoveryCandidate): number {
  return b.cosine - a.cosine || compareText(a.title, b.title) || compareText(a.rootId, b.rootId);
}

/**
 * Selects the pairs a new root is judged on (D27): its `neighbours` nearest unlinked earlier roots,
 * plus every unlinked earlier root whose bar it beats (strictly), which then counts the new root
 * among its nearest. With one neighbour the bar is the nearest root's cosine; with two it is the
 * second nearest's. Same-root candidates cannot occur (candidates are other roots).
 */
export function selectDiscoveryPairs(input: {
  rootId: string;
  candidates: readonly DiscoveryCandidate[];
  neighbours: number;
}): DiscoverySelection {
  const neighbours = Math.max(1, Math.min(2, Math.trunc(input.neighbours)));
  const unlinked = input.candidates
    .filter((candidate) => !candidate.linked && candidate.rootId !== input.rootId)
    .toSorted(compareDiscoveryCandidates);
  const nearest = unlinked.slice(0, neighbours);
  const pairs: DiscoveryPair[] = nearest.map((candidate) => ({
    rootId: candidate.rootId,
    reason: "nearest",
    cosine: candidate.cosine
  }));
  const reverse: DiscoverySelection["reverse"] = [];
  for (const candidate of unlinked) {
    if (candidate.nearestCosine !== null && !(candidate.cosine > candidate.nearestCosine)) continue;
    reverse.push({ rootId: candidate.rootId, ...joinNearest(candidate, input.rootId, neighbours) });
    if (!pairs.some((pair) => pair.rootId === candidate.rootId))
      pairs.push({ rootId: candidate.rootId, reason: "reverse", cosine: candidate.cosine });
  }
  return {
    pairs,
    state: {
      nearestRootId: nearest[0]?.rootId ?? null,
      nearestCosine: nearest.length >= neighbours ? nearest[neighbours - 1]!.cosine : null
    },
    reverse
  };
}

/** A candidate's state once the new root joins its nearest set. */
function joinNearest(
  candidate: DiscoveryCandidate,
  rootId: string,
  neighbours: number
): { nearestRootId: string; nearestCosine: number | null } {
  if (neighbours === 1) return { nearestRootId: rootId, nearestCosine: candidate.cosine };
  if (candidate.nearestRootId === null) return { nearestRootId: rootId, nearestCosine: null };
  const current = candidate.nearestRootCosine ?? -1;
  return {
    nearestRootId: candidate.cosine > current ? rootId : candidate.nearestRootId,
    // The two nearest are now the old nearest and the new root: the bar is the lower of the two.
    nearestCosine: Math.min(candidate.cosine, current)
  };
}
