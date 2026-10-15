import {
  areaGroupingInput,
  createTopicTreeEditor,
  createTopicTreeState,
  defaultTopicTreeConfig,
  gaussianClusters,
  getTopic,
  placementRecord,
  recomputeSubtree,
  registerItem,
  rowContentHash,
  rowItemKey,
  rowVectors,
  topicTreeConfigWith,
  validateAreaProposal
} from "@app/domain/topic-tree";
import type { TopicTreeState } from "@app/domain/topic-tree";
import { describe, expect, it } from "vitest";

import {
  areasPrompt,
  areasReading,
  measureProposal,
  reparentAreasLevel,
  standInProposal
} from "./areas-proof.js";
import type { ReplayDataset } from "./datasets.js";
import type { ReplayMeta } from "./export-vectors.js";

// 8 domains x 4 topics x 10 notes; the Areas either follow the domains or mix them.
const data = gaussianClusters({
  groups: 8,
  clustersPerGroup: 4,
  pointsPerCluster: 10,
  dim: 24,
  groupSpread: 0.5,
  pointNoise: 0.25,
  seed: 5
});
const config = topicTreeConfigWith(
  { areas: { target: 8, minLevel2Topics: 8 } },
  defaultTopicTreeConfig
);
const rows = Array.from({ length: data.matrix.count }, (_, row) => row);
const dataset: ReplayDataset = {
  name: "synthetic",
  meta: {} as ReplayMeta,
  matrix: data.matrix,
  rows: rows.map((row) => ({
    id: `note-${row}`,
    kind: "note",
    contentHash: rowContentHash(row),
    lang: "pt",
    domain: `d${data.groups[row]}`,
    group: `c${data.clusters[row]}`,
    title: `Domínio ${data.groups[row]} assunto ${data.clusters[row]} nota ${row}`,
    text: "",
    order: row,
    rootSourceId: `root-${data.clusters[row]}`
  })),
  labels: {
    domain: Int32Array.from(data.groups),
    group: Int32Array.from(data.clusters),
    language: new Int32Array(rows.length),
    twin: Int32Array.from(data.clusters)
  },
  hasDomains: true
};
const vectors = rowVectors(data.matrix);
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function tree(areaOf: (cluster: number, group: number) => number): {
  state: TopicTreeState;
  leaves: string[];
  areas: string[];
} {
  const state = createTopicTreeState({ dim: data.matrix.dim, rootId: uuid(0) });
  const editor = createTopicTreeEditor(state, { record: false });
  const areas = Array.from({ length: 8 }, (_, index) => {
    editor.createTopic(uuid(1 + index), state.rootId);
    return uuid(1 + index);
  });
  const leaves = Array.from({ length: 32 }, (_, cluster) => {
    const group = data.groups[data.clusters.indexOf(cluster)] as number;
    editor.createTopic(uuid(100 + cluster), areas[areaOf(cluster, group)] as string);
    return uuid(100 + cluster);
  });
  for (const row of rows) {
    registerItem(state, {
      key: rowItemKey(row),
      kind: "note",
      contentHash: rowContentHash(row),
      rootSource: null
    });
    editor.placeItem(
      rowItemKey(row),
      placementRecord(leaves[data.clusters[row] as number] as string, { decidedBy: "build" })
    );
  }
  recomputeSubtree(state, vectors);
  return { state, leaves, areas };
}

describe("the Areas proof readings", () => {
  it("reads purity, NMI, silhouette and the mis-parent share against the domains", () => {
    const grouped = areasReading(tree((_, group) => group).state, dataset, config);
    const mixed = areasReading(tree((cluster) => cluster % 8).state, dataset, config);
    expect(grouped).toMatchObject({
      areas: 8,
      level2Topics: 32,
      depth1MeanPurity: 1,
      depth1Purity: 1,
      depth1Nmi: 1
    });
    expect(mixed.depth1Purity).toBeLessThan(0.5);
    expect(mixed.depth1MeanPurity).toBeLessThan(0.5);
    expect(grouped.silhouette).toBeGreaterThan(mixed.silhouette);
    expect(grouped.misParented.depth2).toBe(0);
  });

  it("re-parents a planted mis-parent at the Areas level", () => {
    const { state, leaves, areas } = tree((_, group) => group);
    const planted = leaves[0] as string;
    const home = getTopic(state, planted).parentId as string;
    const away = areas.find((area) => area !== home) as string;
    createTopicTreeEditor(state, { record: false }).moveTopic(planted, away);
    recomputeSubtree(state, vectors);
    expect(areasReading(state, dataset, config).misParented.depth2).toBeGreaterThan(0);
    expect(reparentAreasLevel(state, vectors, config, 1).reparented).toBe(1);
    expect(getTopic(state, planted).parentId).toBe(home);
    expect(areasReading(state, dataset, config).misParented.depth2).toBe(0);
  });

  it("puts a geometric stand-in through validation, the regroup and the acceptance", () => {
    const { state } = tree((cluster) => cluster % 8);
    const input = areaGroupingInput(state);
    const proposal = standInProposal(state, input, config, 3);
    expect(validateAreaProposal(input, proposal, config).ok).toBe(true);
    const measured = measureProposal(state, vectors, dataset, config, 3, proposal);
    expect(measured).toMatchObject({ valid: true, accepted: true });
    expect(measured.reading?.depth1Purity).toBeGreaterThan(0.9);
    // The tree it was given is unchanged.
    expect(areasReading(state, dataset, config).depth1Purity).toBeLessThan(0.5);
  });

  it("writes the grouping prompt with aliases and note titles, never item keys", () => {
    const { state } = tree((_, group) => group);
    const prompt = areasPrompt(state, vectors, dataset, config);
    expect(prompt).toContain('"alias":"T1"');
    expect(prompt).toContain("Domínio");
    expect(prompt).not.toContain("row:");
    expect(prompt).not.toContain(uuid(100));
  });
});
