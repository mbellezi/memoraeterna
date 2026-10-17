import { describe, expect, it } from "vitest";

import { quotas, stratumOf, stratumShares, type LabelSet } from "./common.ts";
import {
  assignSplits,
  checkLabelSet,
  drawStratified,
  pairIdOf,
  sampleLabelSet,
  samplePass,
  type Candidate
} from "./sample.ts";
import { testSizes, testWorld } from "./test-world.ts";

const inSet = (set: LabelSet, name: string) =>
  set.items.filter((item) => item.sets.some((membership) => membership.set === name));

describe("the panel label set", () => {
  it("is the same for the same seed and inputs, and another seed draws another set", () => {
    const first = sampleLabelSet(testWorld().input);
    const second = sampleLabelSet(testWorld().input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const other = sampleLabelSet(testWorld(7).input);
    expect(other.items.map((item) => item.pairId)).not.toEqual(
      first.items.map((item) => item.pairId)
    );
  });

  it("does not depend on the order of the population", () => {
    const world = testWorld();
    const reversed = testWorld();
    reversed.input.fixture.pairs = [...reversed.input.fixture.pairs]
      .reverse()
      .map(([a, b]) => [b, a] as const);
    expect(JSON.stringify(sampleLabelSet(reversed.input).items)).toBe(
      JSON.stringify(sampleLabelSet(world.input).items)
    );
  });

  it("draws every pool to size, stratified 15/20/30/20/15%, and pool C's hard negatives share a leaf across articles", () => {
    const world = testWorld();
    const set = sampleLabelSet(world.input);
    expect(inSet(set, "pool-A")).toHaveLength(testSizes.poolA);
    expect(inSet(set, "pool-B")).toHaveLength(testSizes.poolB);
    expect(inSet(set, "pool-C")).toHaveLength(testSizes.poolC);
    const perStratum = [0, 1, 2, 3, 4].map(
      (stratum) => inSet(set, "pool-A").filter((item) => item.stratum === stratum).length
    );
    expect(perStratum).toEqual(quotas(testSizes.poolA, stratumShares));
    for (const item of set.items.filter((item) => item.pool !== null))
      expect(item.stratum).toBe(stratumOf(item.score!));
    const leaf = new Map(
      world.input.corpus.context.notes.map((note) => [note.id, note.leafTopicId])
    );
    const hard = set.items.filter((item) =>
      item.sets.some((membership) => membership.subpool === "hard-negative")
    );
    expect(hard).toHaveLength(testSizes.hardNegatives);
    for (const item of hard) {
      expect(item.loRoot).not.toBe(item.hiRoot);
      expect(leaf.get(item.lo)).toBe(leaf.get(item.hi));
    }
  });

  it("keeps every fixture held-out root out of the fit labels and out of pool A", () => {
    const world = testWorld();
    const set = sampleLabelSet(world.input);
    const holdout = (root: string) => world.input.fixture.partitionOfRoot(root) === "holdout";
    for (const item of inSet(set, "pool-A")) {
      expect(holdout(item.loRoot) || holdout(item.hiRoot)).toBe(false);
      expect(item.partitions).toEqual(["tuning", "tuning"]);
    }
    for (const item of set.items.filter(
      (item) => item.split === "fit" && item.library === "fixture"
    ))
      expect(item.partitions).toEqual(["tuning", "tuning"]);
    for (const item of inSet(set, "source-base").filter((item) => item.library === "fixture"))
      expect(item.partitions).toEqual(["tuning", "tuning"]);
    // R_v9 does hold held-out pairs: they stay evaluation-only, never split.
    const rv9 = inSet(set, "rv9-sample");
    expect(rv9.some((item) => item.partitions?.includes("holdout"))).toBe(true);
    for (const item of rv9.filter((item) => item.pool === null)) expect(item.split).toBeNull();

    const leaked = structuredClone(set);
    const tuningItem = leaked.items.find(
      (item) => item.split === "fit" && item.library === "fixture"
    )!;
    tuningItem.partitions = ["tuning", "holdout"];
    expect(() => checkLabelSet(leaked)).toThrow(/outside the tuning partition/u);
  });

  it("splits pools 60/40 by root-pair group: no group crosses the splits", () => {
    const set = sampleLabelSet(testWorld().input);
    const splitOf = new Map<string, Set<string>>();
    for (const item of set.items.filter((item) => item.split !== null))
      splitOf.set(item.group, (splitOf.get(item.group) ?? new Set()).add(item.split!));
    for (const splits of splitOf.values()) expect(splits.size).toBe(1);
    const pooled = set.items.filter((item) => item.pool !== null);
    expect(pooled.every((item) => item.split !== null)).toBe(true);
    const fit = pooled.filter((item) => item.split === "fit").length / pooled.length;
    expect(fit).toBeGreaterThan(0.5);
    expect(fit).toBeLessThan(0.7);
    expect(
      set.items.filter((item) => item.pool === null).every((item) => item.split === null)
    ).toBe(true);

    const crossed = structuredClone(set);
    const [a, b] = crossed.items.filter((item) => item.pool !== null);
    b!.group = a!.group;
    b!.split = a!.split === "fit" ? "eval" : "fit";
    expect(() => checkLabelSet(crossed)).toThrow(/crosses the splits/u);
  });

  it("assigns a whole group to one split even when the group spans strata", () => {
    const items = sampleLabelSet(testWorld().input).items.map((item) => ({ ...item, split: null }));
    for (const item of items) if (item.pool === "B") item.group = "golden:one-group";
    assignSplits(items, 1);
    expect(new Set(items.filter((item) => item.pool === "B").map((item) => item.split)).size).toBe(
      1
    );
  });

  it("labels each pair once: an R_v9 pair that pool A drew keeps both memberships", () => {
    const world = testWorld();
    const first = sampleLabelSet(world.input);
    const poolAPair = inSet(first, "pool-A")[0]!;
    world.input.rv9 = [[poolAPair.lo, poolAPair.hi]];
    const set = sampleLabelSet(world.input);
    const item = set.items.find((candidate) => candidate.pairId === poolAPair.pairId)!;
    expect(item.sets.map((membership) => membership.set).sort()).toEqual(["pool-A", "rv9-sample"]);
    expect(new Set(set.items.map((candidate) => candidate.pairId)).size).toBe(set.items.length);
  });

  it("draws the source pairs: half nearest, half random, plus every neighbour pair of the anchor roots", () => {
    const world = testWorld();
    const set = sampleLabelSet(world.input);
    const base = inSet(set, "source-base");
    expect(base).toHaveLength(
      testSizes.sourceBase.fixture + testSizes.sourceBase.golden + testSizes.sourceBase.corpus
    );
    const fixtureBase = base.filter((item) => item.library === "fixture");
    const nearest = fixtureBase.filter((item) =>
      item.sets.some(
        (membership) => membership.set === "source-base" && membership.basis === "nearest"
      )
    );
    expect(nearest).toHaveLength(Math.ceil(testSizes.sourceBase.fixture / 2));
    const memberships = set.items.flatMap((item) =>
      item.sets
        .filter((membership) => membership.set === "source-neighbours")
        .map((membership) => ({ item, membership }))
    );
    const goldenAnchors = new Set(
      memberships
        .filter(({ item }) => item.library === "golden")
        .map(({ membership }) => membership.anchor)
    );
    expect(goldenAnchors.size).toBe(world.input.golden.context.roots.length);
    expect(memberships.filter(({ item }) => item.library === "corpus")).toHaveLength(
      2 * testSizes.neighbourRoots.corpus
    );
    for (const { item, membership } of memberships) {
      const anchor = world.input[item.library as "golden" | "corpus"].context.roots.find(
        (root) => root.id === membership.anchor
      )!;
      const other = item.lo === anchor.id ? item.hi : item.lo;
      expect(anchor.neighbours[membership.basis === "nearest" ? 0 : 1]!.id).toBe(other);
    }
    expect(
      set.items.filter((item) => item.kind === "source").every((item) => item.split === null)
    ).toBe(true);
  });

  it("carries R_v6 and the R_v9 sample as evaluation-only sets", () => {
    const world = testWorld();
    const set = sampleLabelSet(world.input);
    expect(inSet(set, "rv6")).toHaveLength(world.input.rv6.length);
    expect(inSet(set, "rv9-sample")).toHaveLength(testSizes.rv9Sample);
    for (const item of inSet(set, "rv6"))
      expect([item.pool, item.split, item.stratum]).toEqual([null, null, null]);
  });
});

describe("stratified drawing", () => {
  const candidate = (index: number, score: number): Candidate => ({
    key: `n${String(index).padStart(3, "0")}:z`,
    lo: `n${index}`,
    hi: "z",
    loRoot: "r",
    hiRoot: "s",
    score,
    stratum: stratumOf(score)
  });

  it("hands a short stratum's deficit to the nearest strata", () => {
    const population = [
      ...Array.from({ length: 40 }, (_, index) => candidate(index, -1)),
      ...Array.from({ length: 40 }, (_, index) => candidate(100 + index, 1)),
      ...Array.from({ length: 2 }, (_, index) => candidate(200 + index, 2)),
      ...Array.from({ length: 40 }, (_, index) => candidate(300 + index, 4)),
      ...Array.from({ length: 40 }, (_, index) => candidate(400 + index, 6))
    ];
    const draw = drawStratified(population, 20, 20261018, "test");
    const counts = [0, 1, 2, 3, 4].map(
      (stratum) => draw.drawn.filter((item) => item.stratum === stratum).length
    );
    expect(draw.requested).toEqual([3, 4, 6, 4, 3]);
    expect(counts).toEqual([3, 6, 2, 6, 3]);
    expect(draw.drawn).toHaveLength(20);
  });

  it("splits a total by the shares with the largest remainder", () => {
    expect(quotas(120, stratumShares)).toEqual([18, 24, 36, 24, 18]);
    expect(quotas(90, stratumShares)).toEqual([14, 18, 27, 18, 13]);
    expect(quotas(30, stratumShares).reduce((sum, value) => sum + value, 0)).toBe(30);
  });

  it("puts scores on the strata edges into the upper stratum", () => {
    expect([-0.01, 0, 1.49, 1.5, 3.29, 3.3, 4.99, 5].map(stratumOf)).toEqual([
      0, 1, 1, 2, 2, 3, 3, 4
    ]);
  });
});

describe("a later pass", () => {
  it("labels only the lost pairs the panel has not, plus seeded consistency items", () => {
    const world = testWorld();
    const base = sampleLabelSet(world.input);
    const labelled = inSet(base, "rv9-sample")[0]!;
    const notes = world.input.fixture.context.notes;
    const fresh: [string, string] = [notes[40]!.id, notes[47]!.id];
    const pass = samplePass({
      name: "freeze",
      seed: base.seed,
      base,
      fixture: world.input.fixture,
      lost: [[labelled.lo, labelled.hi], fresh, fresh],
      consistency: 3
    });
    expect(inSet(pass, "lost").map((item) => item.pairId)).toEqual([
      pairIdOf(
        "note",
        "fixture",
        ...(fresh[0] < fresh[1] ? fresh : ([fresh[1], fresh[0]] as const))
      )
    ]);
    const consistency = inSet(pass, "consistency");
    expect(consistency).toHaveLength(3);
    const baseIds = new Set(base.items.map((item) => item.pairId));
    expect(consistency.every((item) => baseIds.has(item.pairId))).toBe(true);
    expect(
      JSON.stringify(
        samplePass({
          name: "freeze",
          seed: base.seed,
          base,
          fixture: world.input.fixture,
          lost: [fresh],
          consistency: 3
        }).items.slice(-3)
      )
    ).toBe(JSON.stringify(consistency));
  });
});
