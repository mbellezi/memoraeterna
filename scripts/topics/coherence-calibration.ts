// Topic coherence after the first E4 panel (F2, gate C): the readings and the registered rules of
// `calibrate-coherence.ts` (registered in `.cache/topics/reports/coherence/evidence.md` before any
// calibration-seed run). Pure functions over trees and labels; the CLI loads the data.
//
// - Areas against labels: depth-1 NMI, Spike B's depth-1 purity (mean top-label share of the
//   Areas), the mixed-Area share (top label under 60%) and e8, the expected number of distinct labels
//   among 8 members drawn at random (what one page of the blind panel shows).
// - Source separation in a small library: a source is absorbed when its majority leaf's majority
//   family is another family.
// - The mapping of a recorded `topic.areas` prompt's aliases onto a tree rebuilt from an export
//   (the product's content anchors include root sources, which the replay stores do not hold).
// - Rules A1 (model grouping against Louvain), A3 (`fanOut.rootTarget`), K1 and K2 (the small-library
//   kNN and its threshold).
import {
  getTopic,
  leafTopics,
  nmi,
  primaryPlacement,
  rowItemKey,
  rowOfItemKey,
  subtreeItems
} from "@app/domain/topic-tree";
import type { TopicTreeState } from "@app/domain/topic-tree";

import { depthLabels } from "./replay-metrics.js";

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

/** The mean of the two middle values (the T29a/T29b median). */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

// ---------------------------------------------------------------------------
// Label compositions

export interface Composition {
  total: number;
  /** The most frequent label and its share. */
  topLabel: string | null;
  top: number;
  /** Expected distinct labels among `draws` members drawn at random with replacement. */
  expectedDistinct: number;
}

/** A topic is mixed when its top label holds less than this share of its items (registered). */
export const mixedTopShare = 0.6;
/** Members one panel page shows (E4). */
export const panelMembers = 8;

export function composition(
  counts: ReadonlyMap<string, number>,
  draws = panelMembers
): Composition {
  let total = 0;
  for (const count of counts.values()) total += count;
  let topLabel: string | null = null;
  let topCount = 0;
  for (const [label, count] of [...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (count > topCount) {
      topLabel = label;
      topCount = count;
    }
  }
  let expectedDistinct = 0;
  if (total > 0)
    for (const count of counts.values()) expectedDistinct += 1 - (1 - count / total) ** draws;
  return { total, topLabel, top: total > 0 ? topCount / total : 0, expectedDistinct };
}

/** The label counts of a topic's subtree items (rows without a label are skipped). */
export function subtreeCounts(
  state: TopicTreeState,
  topicId: string,
  labelOf: (row: number) => string | undefined
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of subtreeItems(state, topicId)) {
    const row = rowOfItemKey(item);
    const label = row === undefined ? undefined : labelOf(row);
    if (label !== undefined) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return counts;
}

/** Live topics at `depth` (root = 0) with at least one item in their subtree. */
export function topicsAtDepth(state: TopicTreeState, depth: number): string[] {
  let level = [state.rootId];
  for (let at = 0; at < depth; at += 1) level = level.flatMap((id) => getTopic(state, id).children);
  return level.filter((id) => subtreeItems(state, id).length > 0);
}

export interface LevelReading {
  depth: number;
  topics: number;
  /** Item-weighted NMI of the depth's topics against the labels. */
  nmi: number;
  /** Spike B's purity: the mean over topics of their top label's share. */
  meanTop: number;
  mixedShare: number;
  /** Share of topics whose top label holds at least 80%. */
  pureShare: number;
  e8: number;
  /** e8 by a second label (the article unit), when given. */
  e8Unit: number | null;
  medianSize: number;
}

/** Readings of the topics at one depth against row labels. */
export function levelReading(
  state: TopicTreeState,
  depth: number,
  rows: readonly number[],
  labelOf: (row: number) => string | undefined,
  unitOf?: (row: number) => string | undefined
): LevelReading {
  const ids = topicsAtDepth(state, depth);
  const parts = ids.map((id) => composition(subtreeCounts(state, id, labelOf)));
  const units = unitOf ? ids.map((id) => composition(subtreeCounts(state, id, unitOf))) : null;
  const interned = new Map<string, number>();
  const truth = Int32Array.from(rows, (row) => {
    const label = labelOf(row) ?? "";
    if (!interned.has(label)) interned.set(label, interned.size);
    return interned.get(label) as number;
  });
  const mean = (values: readonly number[]): number =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    depth,
    topics: ids.length,
    nmi: round(nmi(depthLabels(state, rows.map(rowItemKey), depth), truth)),
    meanTop: round(mean(parts.map((part) => part.top))),
    mixedShare: round(mean(parts.map((part) => (part.top < mixedTopShare ? 1 : 0)))),
    pureShare: round(mean(parts.map((part) => (part.top >= 0.8 ? 1 : 0)))),
    e8: round(mean(parts.map((part) => part.expectedDistinct))),
    e8Unit: units ? round(mean(units.map((part) => part.expectedDistinct))) : null,
    medianSize: median(parts.map((part) => part.total))
  };
}

// ---------------------------------------------------------------------------
// Small libraries: source separation

/** ENV-G families (registered): the forgetting-curve sources are one subject; the rest their own. */
export const envGFamilyByTitle: Readonly<Record<string, string>> = {
  "Forgetting curve": "forgetting-curve",
  "Curva do esquecimento": "forgetting-curve",
  "Replication and Analysis of Ebbinghaus' Forgetting Curve": "forgetting-curve"
};

export function envGFamily(rootTitle: string): string {
  return envGFamilyByTitle[rootTitle] ?? rootTitle;
}

export interface LabelledSource {
  id: string;
  family: string;
  rows: readonly number[];
}

export interface SourceSeparation {
  /** Sources of at least `minNotes` notes whose majority leaf's majority family is another. */
  absorbed: string[];
  /** Item-weighted majority-family share of the leaves. */
  familyPurity: number;
  leaves: number;
}

export function sourceSeparation(
  state: TopicTreeState,
  sources: readonly LabelledSource[],
  minNotes: number
): SourceSeparation {
  const familyOfRow = new Map<number, string>();
  for (const source of sources) for (const row of source.rows) familyOfRow.set(row, source.family);
  const leafFamily = new Map<string, string | null>();
  let weighted = 0;
  let items = 0;
  let leaves = 0;
  for (const leaf of leafTopics(state)) {
    if (leaf.id === state.rootId && leaf.items.length === 0) continue;
    const part = composition(subtreeCounts(state, leaf.id, (row) => familyOfRow.get(row)));
    if (part.total === 0) continue;
    leaves += 1;
    leafFamily.set(leaf.id, part.topLabel);
    weighted += part.top * part.total;
    items += part.total;
  }
  const absorbed: string[] = [];
  for (const source of sources) {
    if (source.rows.length < minNotes) continue;
    const counts = new Map<string, number>();
    for (const row of source.rows) {
      const topicId = primaryPlacement(state, rowItemKey(row))?.topicId;
      if (topicId !== undefined) counts.set(topicId, (counts.get(topicId) ?? 0) + 1);
    }
    const majority = composition(counts).topLabel;
    if (majority !== null && leafFamily.get(majority) !== source.family) absorbed.push(source.id);
  }
  return {
    absorbed: absorbed.sort(),
    familyPurity: items > 0 ? round(weighted / items) : 0,
    leaves
  };
}

/** Item-weighted majority-label share of the leaves (rows without a label are skipped). */
export function leafLabelPurity(
  state: TopicTreeState,
  labelOf: (row: number) => string | undefined
): number {
  let weighted = 0;
  let items = 0;
  for (const leaf of leafTopics(state)) {
    const part = composition(subtreeCounts(state, leaf.id, labelOf));
    weighted += part.top * part.total;
    items += part.total;
  }
  return items > 0 ? round(weighted / items) : 0;
}

// ---------------------------------------------------------------------------
// Recorded `topic.areas` prompts onto exported trees

export interface PromptUnit {
  alias: string;
  titles: readonly string[];
}

export interface TreeUnit extends PromptUnit {
  /** Titles of every item in the unit's subtree, with counts. */
  subtreeTitles: ReadonlyMap<string, number>;
}

export interface AliasMapping {
  /** Prompt alias -> tree alias. */
  map: Map<string, string>;
  exact: number;
  matched: number;
  unmapped: string[];
}

const multiset = (titles: readonly string[]): string => JSON.stringify([...titles].sort());
const aliasNumber = (alias: string): number => Number(alias.slice(1));

/**
 * Maps the aliases of a recorded prompt onto the units of a tree rebuilt from an export: first a
 * unique unit with the same central titles (as a multiset, at least one non-empty), then the unit
 * whose subtree holds every non-empty title of the prompt unit, nearest in alias order, then the
 * nearest unit left by alias order with the most of those titles.
 */
export function mapPromptAliases(
  prompt: readonly PromptUnit[],
  tree: readonly TreeUnit[]
): AliasMapping {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const unit of prompt) {
    if (!unit.titles.some((title) => title.trim() !== "")) continue;
    const key = multiset(unit.titles);
    const candidates = tree.filter(
      (other) => !used.has(other.alias) && multiset(other.titles) === key
    );
    if (candidates.length === 1) {
      map.set(unit.alias, candidates[0]!.alias);
      used.add(candidates[0]!.alias);
    }
  }
  const exact = map.size;
  for (const pass of ["contained", "nearest"] as const) {
    for (const unit of prompt) {
      if (map.has(unit.alias)) continue;
      const titles = unit.titles.filter((title) => title.trim() !== "");
      let best: string | null = null;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const other of tree) {
        if (used.has(other.alias)) continue;
        let hits = 0;
        for (const title of titles) if ((other.subtreeTitles.get(title) ?? 0) > 0) hits += 1;
        if (pass === "contained" && (titles.length === 0 || hits < titles.length)) continue;
        const score =
          hits * 10 - Math.abs(aliasNumber(other.alias) - aliasNumber(unit.alias)) * 0.5;
        if (score > bestScore) {
          bestScore = score;
          best = other.alias;
        }
      }
      if (best !== null) {
        map.set(unit.alias, best);
        used.add(best);
      }
    }
  }
  return {
    map,
    exact,
    matched: map.size - exact,
    unmapped: prompt.filter((unit) => !map.has(unit.alias)).map((unit) => unit.alias)
  };
}

// ---------------------------------------------------------------------------
// Rule A1: the model's grouping against Louvain's

export interface GroupingReading {
  depth1Nmi: number;
  depth1Purity: number;
  mixedShare: number;
}

export function modelMoreCoherent(
  pairs: readonly { louvain: GroupingReading; model: GroupingReading }[]
): boolean {
  return (
    pairs.length > 0 &&
    pairs.every(
      ({ louvain, model }) =>
        model.depth1Nmi > louvain.depth1Nmi &&
        model.depth1Purity > louvain.depth1Purity &&
        model.mixedShare <= louvain.mixedShare
    )
  );
}

// ---------------------------------------------------------------------------
// Rule A3: fanOut.rootTarget

export interface RootTargetRow {
  dataset: string;
  seed: number;
  rootTarget: number;
  areas: number;
  depth1Nmi: number;
  depth1Purity: number;
  mixedShare: number;
  fanOutInTarget: number;
  meanDepth: number;
  singleChild: number;
}

export interface RootTargetChoice {
  start: number;
  chosen: number;
  table: {
    rootTarget: number;
    builds: number;
    eligible: boolean;
    reasons: string[];
    medianNmi: number;
    medianPurity: number;
    medianMixed: number;
  }[];
}

export const shapeBars = { fanOutInTargetMin: 0.8, meanDepthMax: 4.5 } as const;

export function chooseRootTarget(rows: readonly RootTargetRow[], start = 9): RootTargetChoice {
  const values = [...new Set(rows.map((row) => row.rootTarget))].sort((a, b) => a - b);
  const byValue = (value: number) => rows.filter((row) => row.rootTarget === value);
  const startRows = byValue(start);
  const startNmi = median(startRows.map((row) => row.depth1Nmi));
  const startPurity = median(startRows.map((row) => row.depth1Purity));
  const startMixed = median(startRows.map((row) => row.mixedShare));
  const table = values.map((value) => {
    const list = byValue(value);
    const reasons: string[] = [];
    if (list.some((row) => row.fanOutInTarget < shapeBars.fanOutInTargetMin))
      reasons.push("fan-out");
    if (list.some((row) => row.meanDepth > shapeBars.meanDepthMax)) reasons.push("depth");
    if (list.some((row) => row.areas < 7 || row.areas > 12)) reasons.push("area-count");
    if (list.some((row) => row.singleChild > 0)) reasons.push("single-child");
    const medianNmi = median(list.map((row) => row.depth1Nmi));
    if (medianNmi < startNmi) reasons.push("nmi");
    return {
      rootTarget: value,
      builds: list.length,
      eligible: reasons.length === 0,
      reasons,
      medianNmi: round(medianNmi),
      medianPurity: round(median(list.map((row) => row.depth1Purity))),
      medianMixed: round(median(list.map((row) => row.mixedShare)))
    };
  });
  let best: (typeof table)[number] | null = null;
  for (const entry of table) {
    if (!entry.eligible) continue;
    if (best === null || entry.medianPurity > best.medianPurity + 0.01) best = entry;
  }
  const adopt =
    best !== null &&
    best.rootTarget !== start &&
    best.medianPurity >= round(startPurity) + 0.02 &&
    best.medianMixed <= round(startMixed);
  return { start, chosen: adopt && best ? best.rootTarget : start, table };
}

// ---------------------------------------------------------------------------
// Rule K1: the small-library neighbour count

export interface SmallKnnRow {
  dataset: "env-g" | "env-f";
  run: "fresh" | "session" | "daily";
  seed: number;
  k: number;
  reachability: number;
  hardViolations: number;
  /** ENV-G. */
  absorbed: number | null;
  familyPurity: number | null;
  /** ENV-F. */
  fixturePasses: boolean | null;
  forbidden: number | null;
  expected: number | null;
}

export interface SmallKnnChoice {
  chosen: number;
  table: {
    k: number;
    eligible: boolean;
    reasons: string[];
    absorbed: number;
    medianFamilyPurity: number;
    forbiddenMedian: Record<string, number>;
  }[];
}

export function chooseSmallKnn(rows: readonly SmallKnnRow[], off = 10): SmallKnnChoice {
  const values = [...new Set(rows.map((row) => row.k))].sort((a, b) => a - b);
  const runs = ["fresh", "session", "daily"] as const;
  const forbiddenMedian = (k: number, run: string): number =>
    median(
      rows
        .filter((row) => row.k === k && row.dataset === "env-f" && row.run === run)
        .map((row) => row.forbidden ?? 0)
    );
  const table = values.map((k) => {
    const list = rows.filter((row) => row.k === k);
    const reasons: string[] = [];
    if (list.some((row) => row.dataset === "env-f" && row.fixturePasses !== true))
      reasons.push("fixture");
    if (list.some((row) => row.reachability < 1 || row.hardViolations > 0)) reasons.push("e1");
    const medians: Record<string, number> = {};
    for (const run of runs) {
      medians[run] = round(forbiddenMedian(k, run));
      if (forbiddenMedian(k, run) > forbiddenMedian(off, run) + 0.05 + 1e-9) {
        if (!reasons.includes("forbidden")) reasons.push("forbidden");
      }
    }
    const g = list.filter((row) => row.dataset === "env-g");
    return {
      k,
      eligible: reasons.length === 0,
      reasons,
      absorbed: g.reduce((sum, row) => sum + (row.absorbed ?? 0), 0),
      medianFamilyPurity: round(median(g.map((row) => row.familyPurity ?? 0))),
      forbiddenMedian: medians
    };
  });
  const offEntry = table.find((entry) => entry.k === off);
  let best: (typeof table)[number] | null = null;
  for (const entry of table) {
    if (!entry.eligible) continue;
    if (
      best === null ||
      entry.absorbed < best.absorbed ||
      (entry.absorbed === best.absorbed &&
        (entry.medianFamilyPurity > best.medianFamilyPurity ||
          (entry.medianFamilyPurity === best.medianFamilyPurity && entry.k > best.k)))
    ) {
      best = entry;
    }
  }
  const adopt = best !== null && offEntry !== undefined && best.absorbed < offEntry.absorbed;
  return { chosen: adopt && best ? best.k : off, table };
}

// ---------------------------------------------------------------------------
// Rule K2: the threshold

export interface ThresholdRow {
  seed: number;
  size: number;
  k: number;
  articlePurity: number;
  domainPurity: number;
}

export interface ThresholdChoice {
  chosen: number;
  table: { size: number; articleGap: number; domainGap: number; ok: boolean }[];
}

/** The largest grid value whose subset sizes up to it lose at most 0.01 of median purity. */
export function chooseThreshold(
  rows: readonly ThresholdRow[],
  k: number,
  grid: readonly number[] = [200, 500, 1000],
  off = 10
): ThresholdChoice {
  const sizes = [...new Set(rows.map((row) => row.size))].sort((a, b) => a - b);
  const gap = (size: number, field: "articlePurity" | "domainPurity"): number =>
    median(rows.filter((row) => row.size === size && row.k === k).map((row) => row[field])) -
    median(rows.filter((row) => row.size === size && row.k === off).map((row) => row[field]));
  const table = sizes.map((size) => {
    const articleGap = round(gap(size, "articlePurity"));
    const domainGap = round(gap(size, "domainPurity"));
    return { size, articleGap, domainGap, ok: articleGap >= -0.01 && domainGap >= -0.01 };
  });
  let chosen = Math.min(...grid);
  for (const value of [...grid].sort((a, b) => a - b)) {
    const within = table.filter((entry) => entry.size <= value);
    if (within.length > 0 && within.every((entry) => entry.ok)) chosen = value;
    else break;
  }
  return { chosen, table };
}
