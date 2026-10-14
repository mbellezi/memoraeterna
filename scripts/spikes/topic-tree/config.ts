// Typed defaults for the Spike B topic-tree experiments. These are starting points
// to calibrate, not product rules.

export interface TreeConfig {
  fanOut: {
    /** Soft range for internal nodes. */
    min: number;
    max: number;
    targetMin: number;
    targetMax: number;
    /** Hard violation above this. */
    hardMax: number;
    /**
     * Top-level topics (Areas) the builders aim for when the root splits above the
     * leaf level; 0 uses the same balanced rule as the other levels.
     */
    rootTarget: number;
  };
  leaf: {
    min: number;
    max: number;
    target: number;
    /** Hard violation above this. */
    hardMax: number;
    /**
     * Builders split a last-level node into fanOut.targetMin leaves (instead of fewer,
     * larger ones) when its leaves would still average at least this many items.
     */
    minForTargetFanOut: number;
  };
  depth: {
    /** Target depth of leaves (root = 0). */
    target: number;
    /** Hard cap on leaf depth. */
    cap: number;
  };
  placement: {
    beam: number;
    /** a_min: absolute admission floor. */
    admissionFloor: number;
    /**
     * Extra absolute floor for leaves only (0 disables). Measured as a calibration option
     * (Spike B review); the default stays off because on article-held-out notes it barely
     * separates the right leaf from the best wrong-domain leaf.
     */
    leafFloor: number;
    /** Admission is cos >= max(a_min, m_c - spreadFactor * s_c). */
    spreadFactor: number;
    /** Lower bound on s_c for nodes too small to estimate it. */
    spreadFloor: number;
    /** top1 - top2 below this marks the placement ambiguous. */
    ambiguityMargin: number;
    /**
     * Use the leave-one-out mean member cosine for m_c (members are biased toward
     * a centroid they contributed to; a new item is out of sample).
     */
    leaveOneOutMean: boolean;
    /**
     * Internal nodes also admit items at or above this lower percentile (0-0.1) of
     * their member cosines (0 disables; leaves always use the m_c - k * s_c rule).
     */
    internalPercentile: number;
  };
  repair: {
    /** Direct items on an internal node that trigger forming a new leaf from them. */
    directItemsSplitAt: number;
    /** A tiny leaf merges into a sibling only if the result stays at or below this (hysteresis). */
    mergeMaxSize: number;
    /** Soft repairs on a node wait this many inserts after its previous repair. */
    cooldownInserts: number;
    /** Push-down groups children into groups of about this size. */
    pushDownGroupSize: number;
    /**
     * Churn budget: a soft repair (not forced, below the hard limits) is skipped when
     * it would change the path of more than this share of all items.
     */
    softMoveShare: number;
  };
  bottomUp: {
    childrenTarget: number;
    topTopicsMax: number;
  };
  louvain: {
    knn: number;
    resolution: number;
    resolutionTries: number;
  };
  kmeans: {
    maxIterations: number;
    /** Stop when fewer than this share of points change cluster. */
    tolerance: number;
  };
}

export const defaultTreeConfig: TreeConfig = {
  fanOut: { min: 2, max: 12, targetMin: 4, targetMax: 9, hardMax: 16, rootTarget: 9 },
  leaf: { min: 3, max: 30, target: 15, hardMax: 45, minForTargetFanOut: 8 },
  depth: { target: 5, cap: 7 },
  placement: {
    beam: 3,
    admissionFloor: 0.15,
    leafFloor: 0,
    spreadFactor: 2.5,
    spreadFloor: 0.03,
    ambiguityMargin: 0.03,
    leaveOneOutMean: true,
    internalPercentile: 0.01
  },
  repair: {
    directItemsSplitAt: 8,
    mergeMaxSize: 22,
    cooldownInserts: 25,
    pushDownGroupSize: 6,
    softMoveShare: 0.05
  },
  bottomUp: { childrenTarget: 8, topTopicsMax: 10 },
  louvain: { knn: 10, resolution: 1, resolutionTries: 8 },
  kmeans: { maxIterations: 25, tolerance: 0.002 }
};

export function withConfig(overrides: {
  [K in keyof TreeConfig]?: Partial<TreeConfig[K]>;
}): TreeConfig {
  return {
    fanOut: { ...defaultTreeConfig.fanOut, ...overrides.fanOut },
    leaf: { ...defaultTreeConfig.leaf, ...overrides.leaf },
    depth: { ...defaultTreeConfig.depth, ...overrides.depth },
    placement: { ...defaultTreeConfig.placement, ...overrides.placement },
    repair: { ...defaultTreeConfig.repair, ...overrides.repair },
    bottomUp: { ...defaultTreeConfig.bottomUp, ...overrides.bottomUp },
    louvain: { ...defaultTreeConfig.louvain, ...overrides.louvain },
    kmeans: { ...defaultTreeConfig.kmeans, ...overrides.kmeans }
  };
}
