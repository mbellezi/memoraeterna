// Can the leaf coherence (mean cosine of members to the centroid) flag mixed leaves?
// Spike B review: the split-candidate floor of 0.65 was argued from other builders' leaves.
//
//   npx tsx scripts/spikes/topic-tree/coherence-check.ts
//
// For Louvain trees built on 80% of the articles (the calibration base, main seed), counts how
// many domain-pure (majority share at least 0.9), middle and impure (below 0.6) leaves fall
// below a coherence floor and reports the AUC of "low coherence" for impure against pure
// leaves (0.5 = no signal). Writes .cache/spikes/topic-tree/coherence-check.json.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildLouvain } from "./builders.js";
import { defaultTreeConfig } from "./config.js";
import { spikeDir } from "./real-data.js";
import { loadDatasets, seed } from "./real-datasets.js";
import { round, splitByUnit } from "./real-eval.js";
import { coherenceOf } from "./tree.js";

const floors = [0.6, 0.65, 0.7];
const report: Record<string, unknown> = { seed, builder: "louvain", floors };

for (const name of ["corpus", "corpus-notitle"]) {
  const data = (await loadDatasets(new Set([name]))).get(name);
  if (!data) throw new Error(`No vectors for ${name}`);
  const split = splitByUnit(
    data,
    (item) => data.twin[item] as string,
    0.2,
    seed,
    "calibration-articles"
  );
  const { tree } = buildLouvain(data.matrix, split.base, { seed, config: defaultTreeConfig });
  const rows: { coherence: number; share: number; size: number }[] = [];
  for (const leaf of tree.leaves()) {
    if (leaf.items.length === 0) continue;
    const counts = new Map<string, number>();
    for (const item of leaf.items) {
      const domain = data.domain[item] as string;
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    rows.push({
      coherence: coherenceOf(leaf),
      share: Math.max(...counts.values()) / leaf.items.length,
      size: leaf.items.length
    });
  }
  const pure = rows.filter((row) => row.share >= 0.9);
  const middle = rows.filter((row) => row.share >= 0.6 && row.share < 0.9);
  const impure = rows.filter((row) => row.share < 0.6);
  const below = (set: typeof rows, floor: number): number =>
    set.filter((row) => row.coherence < floor).length;
  let wins = 0;
  let ties = 0;
  for (const bad of impure) {
    for (const good of pure) {
      if (bad.coherence < good.coherence) wins += 1;
      else if (bad.coherence === good.coherence) ties += 1;
    }
  }
  const auc = (wins + 0.5 * ties) / Math.max(1, impure.length * pure.length);
  const mean = (set: typeof rows, pick: (row: (typeof rows)[number]) => number): number =>
    set.reduce((total, row) => total + pick(row), 0) / Math.max(1, set.length);
  const entry = {
    leaves: rows.length,
    pure: pure.length,
    middle: middle.length,
    impure: impure.length,
    meanCoherence: {
      pure: round(mean(pure, (row) => row.coherence)),
      middle: round(mean(middle, (row) => row.coherence)),
      impure: round(mean(impure, (row) => row.coherence))
    },
    flagged: floors.map((floor) => ({
      floor,
      pure: below(pure, floor),
      middle: below(middle, floor),
      impure: below(impure, floor)
    })),
    aucLowCoherenceFlagsImpure: round(auc)
  };
  report[name] = entry;
  console.log(name, JSON.stringify(entry));
}
await writeFile(
  join(spikeDir, "coherence-check.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8"
);
