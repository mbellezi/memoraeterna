// A small labelled replay dataset from the engine's seeded Gaussian clusters, for the harness
// tests and for smoke runs without any vector store: groups play the domains, clusters the
// articles, and rows arrive in cluster order (a real import brings one document at a time).
import { defaultSyntheticOptions, gaussianClusters } from "@app/domain/topic-tree";
import type { SyntheticOptions } from "@app/domain/topic-tree";

import { createReplayDataset } from "./datasets.js";
import type { ReplayDataset } from "./datasets.js";
import { sha256Hex } from "./export-vectors.js";

export const smallSyntheticOptions: SyntheticOptions = {
  ...defaultSyntheticOptions,
  groups: 6,
  clustersPerGroup: 4,
  pointsPerCluster: 30,
  dim: 32
};

export function syntheticDataset(
  options: SyntheticOptions = smallSyntheticOptions,
  name = "synthetic"
): ReplayDataset {
  const data = gaussianClusters(options);
  const rows = Array.from({ length: data.matrix.count }, (_, row) => ({
    id: `row-${row}`,
    contentHash: sha256Hex(`row-${row}`),
    lang: "en",
    domain: `domain-${data.groups[row]}`,
    group: `article-${data.clusters[row]}`,
    title: `Row ${row}`,
    text: "",
    order: row,
    kind: "note" as const,
    rootSourceId: `article-${data.clusters[row]}`
  }));
  return createReplayDataset(
    name,
    {
      meta: {
        dataset: name,
        count: rows.length,
        dim: options.dim,
        model: { name: "synthetic" },
        runtime: "none",
        input: "seeded Gaussian clusters",
        createdAt: "2026-01-01T00:00:00.000Z"
      },
      rows,
      matrix: data.matrix
    },
    { twins: false }
  );
}
