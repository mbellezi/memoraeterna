import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMatrix, normalizeRows } from "@app/domain/topic-tree";

import {
  DatasetNotFoundError,
  arrivalOrder,
  arrivalOrders,
  assertSeedAllowed,
  calibrationSeeds,
  createReplayDataset,
  domainOrder,
  evaluationSeeds,
  growthKinds,
  growthSplit,
  internLabels,
  listReplayDatasets,
  loadReplayDataset,
  seedRole,
  sourceDaySchedule,
  subsetDataset,
  twinPairs,
  unitCount,
  weeklySchedule
} from "./datasets.js";
import { writeReplayStore } from "./export-vectors.js";
import { sha256Hex } from "./export-vectors.js";
import { smallSyntheticOptions, syntheticDataset } from "./synthetic-dataset.js";

const dataset = syntheticDataset();
const everyRow = Array.from({ length: dataset.rows.length }, (_, row) => row);

describe("seeds", () => {
  it("keeps the evaluation and calibration seeds disjoint (spec section 4)", () => {
    expect(evaluationSeeds).toEqual([20261014, 1, 2, 3, 4, 5]);
    expect(calibrationSeeds).toEqual([7, 8, 9, 10, 11, 12]);
    expect(evaluationSeeds.filter((seed) => calibrationSeeds.includes(seed))).toEqual([]);
    expect(seedRole(20261014)).toBe("evaluation");
    expect(seedRole(9)).toBe("calibration");
    expect(seedRole(99)).toBe("other");
  });

  it("refuses the other role's seed and allows free ones", () => {
    expect(() => assertSeedAllowed(7, "calibration")).not.toThrow();
    expect(() => assertSeedAllowed(99, "calibration")).not.toThrow();
    expect(() => assertSeedAllowed(20261014, "calibration")).toThrow(/reserved for evaluation/u);
    expect(() => assertSeedAllowed(8, "evaluation")).toThrow(/reserved for calibration/u);
  });
});

describe("labels and subsets", () => {
  it("interns labels in order of first appearance", () => {
    expect(Array.from(internLabels(["b", "a", "b", "c", "a"]))).toEqual([0, 1, 0, 2, 1]);
  });

  it("labels the synthetic dataset and takes subsets", () => {
    expect(dataset.hasDomains).toBe(true);
    expect(new Set(dataset.labels.domain).size).toBe(6);
    expect(new Set(dataset.labels.group).size).toBe(24);
    const subset = subsetDataset(dataset, [5, 100, 7]);
    expect(subset.rows.map((row) => row.id)).toEqual(["row-5", "row-100", "row-7"]);
    expect(subset.matrix.count).toBe(3);
    expect(Array.from(subset.matrix.data.subarray(32, 64))).toEqual(
      Array.from(dataset.matrix.data.subarray(100 * 32, 101 * 32))
    );
    expect(subset.labels.domain[1]).toBe(dataset.labels.domain[100]);
  });
});

describe("arrival orders", () => {
  it("are permutations, deterministic per seed, and differ", () => {
    const orders = arrivalOrders.map((kind) => arrivalOrder(dataset, kind, 20261014));
    for (const order of orders) {
      expect([...order].sort((a, b) => a - b)).toEqual(everyRow);
    }
    expect(orders[0]).toEqual(everyRow); // chronological = import order here
    expect(orders[1]).not.toEqual(everyRow);
    expect(arrivalOrder(dataset, "shuffled", 20261014)).toEqual(orders[1]);
    expect(arrivalOrder(dataset, "shuffled", 1)).not.toEqual(orders[1]);
  });

  it("orders by the import rank, then the row", () => {
    const shuffledOrderRanks = createReversedRanks();
    expect(arrivalOrder(shuffledOrderRanks, "chronological", 1)).toEqual([2, 1, 0]);
  });

  it("brings whole domains one after another", () => {
    const order = domainOrder(dataset, 20261014);
    const domains = order.map((row) => dataset.labels.domain[row]);
    const changes = domains.filter((value, index) => index > 0 && value !== domains[index - 1]);
    expect(changes.length).toBe(5); // 6 domains, each contiguous
    // Within a domain the import order holds.
    for (let domain = 0; domain < 6; domain += 1) {
      const rows = order.filter((row) => dataset.labels.domain[row] === domain);
      expect(rows).toEqual([...rows].sort((a, b) => a - b));
    }
  });
});

function createReversedRanks() {
  const base = syntheticDataset({
    ...smallSyntheticOptions,
    groups: 1,
    clustersPerGroup: 1,
    pointsPerCluster: 3
  });
  return { ...base, rows: base.rows.map((row, index) => ({ ...row, order: 10 - index })) };
}

describe("the simulated calendar", () => {
  it("covers the E3 shape: a 60% base then 8 weeks of 5%, every row once", () => {
    const order = arrivalOrder(dataset, "chronological", 1);
    const schedule = weeklySchedule(order);
    expect(schedule.weeks).toBe(8);
    expect(schedule.base).toEqual(order.slice(0, Math.round(order.length * 0.6)));
    expect(schedule.days).toHaveLength(56);
    expect(schedule.days[0]).toMatchObject({ day: 1, week: 1 });
    expect(schedule.days[55]).toMatchObject({ day: 56, week: 8 });
    const arrived = schedule.days.flatMap((day) => day.rows);
    expect([...schedule.base, ...arrived]).toEqual(order);
    const perWeek = Array.from({ length: 8 }, (_, index) =>
      schedule.days
        .filter((day) => day.week === index + 1)
        .reduce((n, day) => n + day.rows.length, 0)
    );
    for (const count of perWeek) {
      expect(Math.abs(count - order.length * 0.05)).toBeLessThanOrEqual(2);
    }
  });

  it("spreads a week's arrivals evenly over its days and honors other options", () => {
    const order = Array.from({ length: 100 }, (_, row) => row);
    const schedule = weeklySchedule(order, {
      baseShare: 0.5,
      weeks: 2,
      weeklyShare: 0.1,
      daysPerWeek: 5
    });
    expect(schedule.base).toHaveLength(50);
    expect(schedule.days.map((day) => day.rows.length)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(schedule.days.at(-1)?.rows.at(-1)).toBe(69);
    expect(() => weeklySchedule(order, { baseShare: 1 })).toThrow(RangeError);
  });

  it("makes one source a day after a base of the first sources (ENV-G and ENV-F)", () => {
    const schedule = sourceDaySchedule(dataset, { baseShare: 0.5 });
    const sources = new Set(dataset.rows.map((row) => row.rootSourceId));
    expect(sources.size).toBe(24);
    expect(schedule.days).toHaveLength(12);
    for (const day of schedule.days) {
      expect(new Set(day.rows.map((row) => dataset.rows[row]?.rootSourceId)).size).toBe(1);
    }
    expect(schedule.base).toHaveLength(12 * 30);
    expect(schedule.days[0]?.week).toBe(1);
    expect(schedule.days[11]?.week).toBe(2);
  });
});

describe("growth splits", () => {
  it.each(growthKinds)("%s splits the rows into disjoint base and tail", (kind) => {
    const split = growthSplit(dataset, kind, 0.2, 20261014);
    expect([...split.base, ...split.tail].sort((a, b) => a - b)).toEqual(everyRow);
    expect(new Set([...split.base, ...split.tail]).size).toBe(everyRow.length);
    if (kind === "items" || kind === "chronological") {
      expect(split.tail.length).toBe(Math.round(everyRow.length * 0.2));
    } else {
      expect(split.tail.length).toBeGreaterThanOrEqual(Math.round(everyRow.length * 0.2));
    }
  });

  it("holds whole units out", () => {
    for (const kind of ["articles", "domains"] as const) {
      const split = growthSplit(dataset, kind, 0.2, 7);
      const labels = kind === "articles" ? dataset.labels.twin : dataset.labels.domain;
      const tailUnits = new Set(split.tail.map((row) => labels[row]));
      expect(split.base.some((row) => tailUnits.has(labels[row] as number))).toBe(false);
    }
    expect(unitCount(dataset, "domains")).toBe(6);
    expect(unitCount(dataset, "articles")).toBe(24);
    expect(unitCount(dataset, "items")).toBe(everyRow.length);
  });

  it("is deterministic per seed and differs between seeds", () => {
    expect(growthSplit(dataset, "items", 0.2, 3)).toEqual(growthSplit(dataset, "items", 0.2, 3));
    expect(growthSplit(dataset, "items", 0.2, 3).tail).not.toEqual(
      growthSplit(dataset, "items", 0.2, 4).tail
    );
  });
});

const twinEntries: [string, string, string][] = [
  ["en", "astronomy", "en:Sun"],
  ["pt", "astronomy", "pt:Sol"],
  ["en", "astronomy", "en:Moon"],
  ["pt", "geography", "pt:Rio"],
  ["pt", "geography", "pt:Lago"],
  ["en", "law", "en:Law"]
];

/** Six articles in three domains; `mirror` makes Sol a near-copy of Sun, else all are unrelated. */
function twinStore(name: string, mirror: boolean) {
  const dim = 6;
  const matrix = createMatrix(6, dim);
  const vectors = mirror
    ? [
        [1, 0, 0, 0, 0, 0], // en:Sun
        [0.98, 0.2, 0, 0, 0, 0], // pt:Sol (mirror of Sun)
        [0, 1, 0, 0, 0, 0], // en:Moon
        [0, 0, 1, 0, 0, 0], // pt:Rio (unrelated)
        [0, 0, 0.9, 0.3, 0, 0], // pt:Lago
        [0, 0, 0, 0, 1, 0] // en:Law (other domain)
      ]
    : [
        [1, 0, 0, 0, 0, 0],
        [0, 1, 0, 0, 0, 0],
        [0, 0, 1, 0, 0, 0],
        [0, 0, 0, 1, 0, 0],
        [0, 0, 0, 0, 1, 0],
        [0, 0, 0, 0, 0, 1]
      ];
  vectors.forEach((vector, row) => matrix.data.set(vector, row * dim));
  normalizeRows(matrix);
  return {
    meta: {
      dataset: name,
      count: 6,
      dim,
      model: { name: "m" },
      runtime: "r",
      input: "i",
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    rows: twinEntries.map(([lang, domain, group], order) => ({
      id: `n${order}`,
      contentHash: sha256Hex(`n${order}`),
      lang,
      domain,
      group,
      title: group,
      order
    })),
    matrix
  };
}

describe("twins", () => {
  it("pairs a Portuguese article with its English mirror within a domain", () => {
    const store = createReplayDataset("twins", {
      ...twinStore("twins", true),
      rows: twinStore("twins", true).rows.map((row) => ({
        ...row,
        kind: "note" as const,
        text: "",
        rootSourceId: row.group
      }))
    });
    const pairs = twinPairs({ rows: store.rows, matrix: store.matrix });
    expect(pairs.map((pair) => [pair.en, pair.pt])).toEqual([["Sun", "Sol"]]);
    expect(store.labels.twin[0]).toBe(store.labels.twin[1]);
    expect(store.labels.twin[2]).not.toBe(store.labels.twin[0]);
    expect(new Set(store.labels.twin).size).toBe(5);
  });

  it("takes the twins of a stripped store from the titled one (Spike B's split)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "replay-twins-"));
    try {
      await writeReplayStore(dir, "wiki", twinStore("wiki", true));
      await writeReplayStore(dir, "wiki-notitle", twinStore("wiki-notitle", false));
      const alone = await loadReplayDataset("wiki-notitle", { dirs: [dir] });
      expect(new Set(alone.labels.twin).size).toBe(6); // its own vectors show no mirror
      const borrowed = await loadReplayDataset("wiki-notitle", { dirs: [dir], twinsFrom: "wiki" });
      expect(borrowed.labels.twin[0]).toBe(borrowed.labels.twin[1]);
      expect(new Set(borrowed.labels.twin).size).toBe(5);
      const off = await loadReplayDataset("wiki-notitle", {
        dirs: [dir],
        twinsFrom: "wiki",
        twins: false
      });
      expect(new Set(off.labels.twin).size).toBe(6);
      // A reference store whose rows differ is ignored.
      await writeReplayStore(dir, "other", {
        ...twinStore("other", true),
        rows: twinStore("other", true).rows.map((row) => ({ ...row, group: `${row.group}!` }))
      });
      const misaligned = await loadReplayDataset("wiki-notitle", {
        dirs: [dir],
        twinsFrom: "other"
      });
      expect(new Set(misaligned.labels.twin).size).toBe(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("loading", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "replay-datasets-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads from the first directory that has the store and lists stores once", async () => {
    const other = await mkdtemp(join(tmpdir(), "replay-datasets-"));
    try {
      await writeReplayStore(dir, "alpha", storeOf("alpha"));
      await writeReplayStore(other, "alpha", storeOf("alpha"));
      await writeReplayStore(other, "beta", storeOf("beta"));
      const loaded = await loadReplayDataset("alpha", { dirs: [dir, other] });
      expect(loaded.name).toBe("alpha");
      expect(loaded.rows).toHaveLength(4);
      expect(await listReplayDatasets([dir, other])).toEqual([
        { name: "alpha", dir },
        { name: "beta", dir: other }
      ]);
      await expect(loadReplayDataset("gamma", { dirs: [dir, other] })).rejects.toBeInstanceOf(
        DatasetNotFoundError
      );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

function storeOf(name: string) {
  const matrix = createMatrix(4, 4);
  for (let row = 0; row < 4; row += 1) matrix.data[row * 4 + row] = 1;
  return {
    meta: {
      dataset: name,
      count: 4,
      dim: 4,
      model: { name: "m" },
      runtime: "r",
      input: "i",
      createdAt: "2026-01-01T00:00:00.000Z"
    },
    rows: Array.from({ length: 4 }, (_, row) => ({
      id: `${name}-${row}`,
      lang: "en",
      group: `g${row}`,
      title: `t${row}`,
      order: row
    })),
    matrix
  };
}
