// Follow-up to the owner's Spike B rating (decision 17: levels 3-4 were 17/17
// coherent, levels 1-2 only 5/10): audits the upper levels of the evaluated build
// (Louvain over the public corpus, same seed and config as avaliacao.html).
//
//   npx tsx scripts/spikes/topic-tree/audit-top-levels.ts
//
// Reports per depth: mis-parented topics (an uncle centroid is closer than the
// parent's), domain purity, and how often content-language-only TF-IDF naming
// (pt) falls back to the "unnamed" placeholder. Writes
// .cache/spikes/topic-tree/top-levels-audit.json.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildTree } from "./builders.js";
import { defaultTreeConfig } from "./config.js";
import { nameTopics } from "./naming.js";
import { spikeDir } from "./real-data.js";
import { loadDatasets, seed } from "./real-datasets.js";
import { dot } from "./vectors.js";

const data = (await loadDatasets(new Set(["corpus"]))).get("corpus");
if (!data) throw new Error("No corpus vectors; run embed-real.ts first");
const { tree } = buildTree("louvain", data.matrix, data.items, { seed, config: defaultTreeConfig });
const inputOf = (item: number) => ({
  text: `${data.title[item] ?? ""}\n${data.text[item] ?? ""}`,
  lang: (data.lang[item] === "en" ? "en" : "pt") as "pt" | "en"
});
const mixedNames = nameTopics(tree, inputOf);
const ptNames = nameTopics(tree, inputOf, { contentLanguage: "pt" });

interface DepthStats {
  topics: number;
  misParented: number;
  meanParentMargin: number;
  domainPurityMean: number;
  unnamedPt: number;
}
const byDepth = new Map<number, DepthStats & { marginSum: number; puritySum: number }>();
const topLevel: Record<string, unknown>[] = [];
const misParentExamples: string[] = [];

tree.walk((node, depth) => {
  if (node.parent === null) return;
  const parent = tree.node(node.parent);
  const items = tree.subtreeItems(node.id);
  const counts = new Map<string, number>();
  for (const item of items)
    counts.set(data.domain[item] ?? "", (counts.get(data.domain[item] ?? "") ?? 0) + 1);
  const domains = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const purity = items.length > 0 ? (domains[0]?.[1] ?? 0) / items.length : 0;
  let parentMargin = Number.NaN;
  let misParented = false;
  if (parent.parent !== null) {
    const grandparent = tree.node(parent.parent);
    const ownCos = dot(node.centroid, parent.centroid);
    let bestUncle = Number.NEGATIVE_INFINITY;
    let bestUncleId = -1;
    for (const uncle of grandparent.children) {
      if (uncle === parent.id) continue;
      const cos = dot(node.centroid, tree.node(uncle).centroid);
      if (cos > bestUncle) {
        bestUncle = cos;
        bestUncleId = uncle;
      }
    }
    parentMargin = ownCos - bestUncle;
    misParented = parentMargin < 0;
    if (misParented && misParentExamples.length < 12) {
      misParentExamples.push(
        `${mixedNames.get(node.id)?.label ?? node.id} (n ${node.n}) under "${mixedNames.get(parent.id)?.label}" ` +
          `but closer to "${mixedNames.get(bestUncleId)?.label}" (margin ${parentMargin.toFixed(3)})`
      );
    }
  }
  const stats = byDepth.get(depth) ?? {
    topics: 0,
    misParented: 0,
    meanParentMargin: 0,
    domainPurityMean: 0,
    unnamedPt: 0,
    marginSum: 0,
    puritySum: 0
  };
  stats.topics += 1;
  if (misParented) stats.misParented += 1;
  if (Number.isFinite(parentMargin)) stats.marginSum += parentMargin;
  stats.puritySum += purity;
  if ((ptNames.get(node.id)?.terms.length ?? 0) === 0) stats.unnamedPt += 1;
  byDepth.set(depth, stats);
  if (depth === 1) {
    topLevel.push({
      n: node.n,
      children: node.children.length,
      name: mixedNames.get(node.id)?.label,
      namePt: ptNames.get(node.id)?.label,
      domains: domains
        .slice(0, 4)
        .map(([domain, count]) => `${domain} ${Math.round((100 * count) / items.length)}%`)
    });
  }
});

const depths = [...byDepth.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([depth, stats]) => ({
    depth,
    topics: stats.topics,
    misParented: stats.misParented,
    misParentedShare: Number((stats.misParented / stats.topics).toFixed(3)),
    meanParentMargin: depth >= 2 ? Number((stats.marginSum / stats.topics).toFixed(3)) : null,
    domainPurityMean: Number((stats.puritySum / stats.topics).toFixed(3)),
    unnamedPtShare: Number((stats.unnamedPt / stats.topics).toFixed(3))
  }));
const report = { builder: "louvain", seed, depths, topLevel, misParentExamples };
await writeFile(
  join(spikeDir, "top-levels-audit.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8"
);
console.table(depths);
console.table(topLevel);
console.log(misParentExamples.join("\n"));
