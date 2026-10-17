import { describe, expect, it } from "vitest";

import {
  createTopicTreeState,
  insertPlacement,
  insertTopic,
  placementRecord,
  registerItem,
  rowContentHash,
  rowItemKey,
  topicRecord
} from "@app/domain/topic-tree";
import type { TopicTreeState } from "@app/domain/topic-tree";

import {
  chooseRootTarget,
  chooseSmallKnn,
  chooseThreshold,
  composition,
  envGFamily,
  leafLabelPurity,
  levelReading,
  mapPromptAliases,
  median,
  modelMoreCoherent,
  sourceSeparation
} from "./coherence-calibration.js";
import type { RootTargetRow, SmallKnnRow, ThresholdRow } from "./coherence-calibration.js";

/** Root with Areas a (leaves a1, a2) and b (leaf b1); rows placed as given. */
function tree(placements: Record<string, number[]>): TopicTreeState {
  const state = createTopicTreeState({ dim: 2, rootId: "root" });
  insertTopic(state, topicRecord("a", "root"));
  insertTopic(state, topicRecord("b", "root"));
  insertTopic(state, topicRecord("a1", "a"));
  insertTopic(state, topicRecord("a2", "a"));
  insertTopic(state, topicRecord("b1", "b"));
  for (const [topicId, rows] of Object.entries(placements)) {
    for (const row of rows) {
      const key = rowItemKey(row);
      registerItem(state, {
        key,
        kind: "note",
        contentHash: rowContentHash(row),
        rootSource: null
      });
      insertPlacement(state, key, placementRecord(topicId));
    }
  }
  return state;
}

describe("label compositions", () => {
  it("reads the top label and the expected distinct labels of a panel page", () => {
    const part = composition(
      new Map([
        ["x", 6],
        ["y", 2]
      ])
    );
    expect(part.total).toBe(8);
    expect(part.topLabel).toBe("x");
    expect(part.top).toBe(0.75);
    // 1 - 0.25^8 + 1 - 0.75^8
    expect(part.expectedDistinct).toBeCloseTo(2 - 0.25 ** 8 - 0.75 ** 8, 10);
    expect(composition(new Map([["x", 5]])).expectedDistinct).toBe(1);
    expect(median([3, 1, 2, 4])).toBe(2.5);
  });

  it("reads one depth of a tree against row labels", () => {
    const state = tree({ a1: [0, 1, 2], a2: [3, 4], b1: [5, 6, 7, 8] });
    const labels = ["x", "x", "x", "y", "y", "z", "z", "z", "x"];
    const rows = labels.map((_, row) => row);
    const areas = levelReading(state, 1, rows, (row) => labels[row]);
    expect(areas.topics).toBe(2);
    // a: x 3 of 5 (0.6, not mixed); b: z 3 of 4 (0.75).
    expect(areas.meanTop).toBeCloseTo((0.6 + 0.75) / 2, 4);
    expect(areas.mixedShare).toBe(0);
    expect(areas.pureShare).toBe(0);
    const leaves = levelReading(state, 2, rows, (row) => labels[row]);
    expect(leaves.topics).toBe(3);
    expect(leaves.pureShare).toBeCloseTo(2 / 3, 4);
    expect(leafLabelPurity(state, (row) => labels[row])).toBeCloseTo(8 / 9, 4);
  });
});

describe("source separation", () => {
  it("counts a source absorbed when its majority leaf belongs to another family", () => {
    const state = tree({ a1: [0, 1, 2, 3, 4, 5], a2: [6, 7, 8], b1: [9, 10] });
    const sources = [
      { id: "alienista", family: "alienista", rows: [0, 1, 2, 3] },
      { id: "magi", family: "magi", rows: [4, 5, 9] },
      { id: "fair", family: "fair", rows: [6, 7, 8] },
      { id: "tiny", family: "tiny", rows: [10] }
    ];
    const reading = sourceSeparation(state, sources, 3);
    // Magi's majority leaf a1 is Alienista's; the tiny source is below leaf.min.
    expect(reading.absorbed).toEqual(["magi"]);
    expect(reading.leaves).toBe(3);
    expect(reading.familyPurity).toBeCloseTo((4 + 3 + 1) / 11, 4);
    expect(envGFamily("Curva do esquecimento")).toBe(envGFamily("Forgetting curve"));
    expect(envGFamily("O Alienista")).toBe("O Alienista");
  });
});

describe("recorded Areas prompts onto exported trees", () => {
  it("maps by central titles first, then by subtree titles and alias order", () => {
    const subtree = (titles: string[]) => new Map(titles.map((title) => [title, 1]));
    const tree = [
      {
        alias: "T1",
        titles: ["Jazz", "Blues", ""],
        subtreeTitles: subtree(["Jazz", "Blues", "Swing"])
      },
      {
        alias: "T2",
        titles: ["Vacinas", "", ""],
        subtreeTitles: subtree(["Vacinas", "Imunidade"])
      },
      { alias: "T3", titles: ["", "", ""], subtreeTitles: subtree(["", "Origem"]) },
      { alias: "T4", titles: ["Queijo", "Leite", ""], subtreeTitles: subtree(["Queijo", "Leite"]) }
    ];
    const prompt = [
      { alias: "T1", titles: ["Vacinas", "", ""] },
      { alias: "T2", titles: ["Blues", "", "Jazz"] },
      { alias: "T3", titles: ["Leite", "Queijo-2", ""] },
      { alias: "T4", titles: ["", "", ""] }
    ];
    const mapping = mapPromptAliases(prompt, tree);
    expect(mapping.exact).toBe(2);
    expect(mapping.map.get("T1")).toBe("T2");
    expect(mapping.map.get("T2")).toBe("T1");
    // "Queijo-2" is in no subtree: the nearest unit with the most titles.
    expect(mapping.map.get("T3")).toBe("T4");
    expect(mapping.map.get("T4")).toBe("T3");
    expect(mapping.unmapped).toEqual([]);
  });
});

describe("the registered rules", () => {
  it("A1: the model's grouping must beat Louvain on NMI and purity without more mixing", () => {
    const louvain = { depth1Nmi: 0.66, depth1Purity: 0.54, mixedShare: 0.7 };
    expect(
      modelMoreCoherent([
        { louvain, model: { depth1Nmi: 0.7, depth1Purity: 0.6, mixedShare: 0.6 } }
      ])
    ).toBe(true);
    expect(
      modelMoreCoherent([
        { louvain, model: { depth1Nmi: 0.58, depth1Purity: 0.6, mixedShare: 0.6 } }
      ])
    ).toBe(false);
    expect(modelMoreCoherent([])).toBe(false);
  });

  it("A3: adopts a root target only when eligible and 0.02 purer at the median", () => {
    const row = (
      rootTarget: number,
      seed: number,
      purity: number,
      extra: Partial<RootTargetRow> = {}
    ) => ({
      dataset: "d",
      seed,
      rootTarget,
      areas: 10,
      depth1Nmi: 0.65,
      depth1Purity: purity,
      mixedShare: 0.6,
      fanOutInTarget: 0.85,
      meanDepth: 3.7,
      singleChild: 0,
      ...extra
    });
    const rows = [
      row(9, 7, 0.5),
      row(9, 8, 0.52),
      row(12, 7, 0.55),
      row(12, 8, 0.56),
      row(11, 7, 0.6),
      row(11, 8, 0.6, { fanOutInTarget: 0.7 })
    ];
    const choice = chooseRootTarget(rows);
    expect(choice.table.find((entry) => entry.rootTarget === 11)?.eligible).toBe(false);
    expect(choice.chosen).toBe(12);
    expect(chooseRootTarget([row(9, 7, 0.5), row(12, 7, 0.51)]).chosen).toBe(9);
  });

  it("K1: the fewest absorbed sources among values that keep the ENV-F fixture", () => {
    const g = (k: number, absorbed: number): SmallKnnRow => ({
      dataset: "env-g",
      run: "fresh",
      seed: 7,
      k,
      reachability: 1,
      hardViolations: 0,
      absorbed,
      familyPurity: 0.9,
      fixturePasses: null,
      forbidden: null,
      expected: null
    });
    const f = (k: number, forbidden: number, passes = true): SmallKnnRow => ({
      ...g(k, 0),
      dataset: "env-f",
      absorbed: null,
      familyPurity: null,
      fixturePasses: passes,
      forbidden,
      expected: 1
    });
    const rows = [
      g(10, 3),
      f(10, 0.1),
      g(5, 0),
      f(5, 0.12),
      g(4, 0),
      f(4, 0.3),
      g(6, 1),
      f(6, 0.1, false)
    ];
    const choice = chooseSmallKnn(rows);
    expect(choice.table.find((entry) => entry.k === 4)?.reasons).toEqual(["forbidden"]);
    expect(choice.table.find((entry) => entry.k === 6)?.reasons).toEqual(["fixture"]);
    expect(choice.chosen).toBe(5);
    expect(chooseSmallKnn([g(10, 0), f(10, 0.1), g(5, 0), f(5, 0.1)]).chosen).toBe(10);
  });

  it("K2: the largest threshold whose subset sizes lose at most 0.01 of purity", () => {
    const row = (size: number, k: number, articlePurity: number): ThresholdRow => ({
      seed: 7,
      size,
      k,
      articlePurity,
      domainPurity: 0.95
    });
    const rows = [
      row(200, 5, 0.9),
      row(200, 10, 0.9),
      row(500, 5, 0.895),
      row(500, 10, 0.9),
      row(1000, 5, 0.85),
      row(1000, 10, 0.9)
    ];
    expect(chooseThreshold(rows, 5).chosen).toBe(500);
    expect(
      chooseThreshold(
        rows.filter((entry) => entry.size !== 1000),
        5
      ).chosen
    ).toBe(1000);
  });
});
