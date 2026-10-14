// Experiment helpers for Spike B on real embeddings: labelled datasets, explicit
// insertion orders, language mixing, narrow-pocket checks and the calibration of
// a_min, the ambiguity margin, z and the split/merge thresholds.
import { buildTree } from "./builders.js";
import type { BuilderName, LouvainDiagnostics } from "./builders.js";
import type { TreeConfig } from "./config.js";
import { countOperations } from "./evaluate.js";
import { IncrementalTopicEngine } from "./incremental.js";
import { churn, distribution, nmi, primaryPaths, shapeReport } from "./metrics.js";
import type { Distribution, ShapeReport } from "./metrics.js";
import type { RepairKind } from "./repair.js";
import { createRng, deriveSeed } from "./rng.js";
import { admissionMean, coherenceOf, spreadOf } from "./tree.js";
import type { TopicTree } from "./tree.js";
import { dot, dotRowVec } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

export interface LabelledDataset {
  name: string;
  matrix: EmbeddingMatrix;
  /** Row index per item (items are row indices of `matrix`). */
  items: number[];
  lang: string[];
  domain: string[];
  group: string[];
  /**
   * Article-level holdout unit: the article together with its pt/en twin (Wikipedia
   * mirrors); equal to `group` where no twin exists.
   */
  twin: string[];
  title: string[];
  text: string[];
  dataset: string[];
  /** Chronological rank per row. */
  order: number[];
}

/** Interns string labels as integers. */
export function labelIds(values: readonly string[]): Int32Array {
  const ids = new Map<string, number>();
  return Int32Array.from(values, (value) => {
    const existing = ids.get(value);
    if (existing !== undefined) return existing;
    ids.set(value, ids.size);
    return ids.size - 1;
  });
}

export const round = (value: number, digits = 3): number =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : value;

/** Ancestor of each item's node at `depth` (the node itself when shallower). */
export function depthLabels(tree: TopicTree, items: readonly number[], depth: number): Int32Array {
  return Int32Array.from(items, (item) => {
    const node = tree.itemNode.get(item);
    if (node === undefined) return -1;
    const path = tree.pathOf(node);
    return path[Math.min(depth, path.length - 1)] as number;
  });
}

function majority(values: readonly string[]): { value: string; share: number } {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return { value: best, share: values.length > 0 ? bestCount / values.length : 0 };
}

export interface LanguageReport {
  /** Share of leaves whose minority language holds at least 20% of the members. */
  bilingualLeafShare: number;
  /** Item-weighted dominant-language share of the depth-1 topics. */
  topLevelLanguagePurity: number;
  /** NMI of the depth-1 partition with language and with domain. */
  topLevelNmiLanguage: number;
  topLevelNmiDomain: number;
}

export function languageReport(tree: TopicTree, data: LabelledDataset): LanguageReport {
  let bilingual = 0;
  const leaves = tree.leaves();
  for (const leaf of leaves) {
    if (leaf.items.length === 0) continue;
    const share = majority(leaf.items.map((item) => data.lang[item] as string)).share;
    if (1 - share >= 0.2) bilingual += 1;
  }
  const top = depthLabels(tree, data.items, 1);
  const groups = new Map<number, string[]>();
  data.items.forEach((item, index) => {
    const label = top[index] as number;
    const members = groups.get(label) ?? [];
    members.push(data.lang[item] as string);
    groups.set(label, members);
  });
  let weighted = 0;
  for (const members of groups.values()) weighted += majority(members).share * members.length;
  return {
    bilingualLeafShare: leaves.length > 0 ? bilingual / leaves.length : 0,
    topLevelLanguagePurity: data.items.length > 0 ? weighted / data.items.length : 1,
    topLevelNmiLanguage: nmi(top, labelIds(data.items.map((item) => data.lang[item] as string))),
    topLevelNmiDomain: nmi(top, labelIds(data.items.map((item) => data.domain[item] as string)))
  };
}

export interface TruthReport {
  /** Leaf partition vs fine groups (article / root source). */
  leafNmiGroup: number;
  /** Item-weighted share of leaf members in the leaf's majority domain. */
  leafDomainPurity: number;
  /** Depth-1 and depth-2 partitions vs domain. */
  depth1NmiDomain: number;
  depth2NmiDomain: number;
}

export function truthReport(
  tree: TopicTree,
  data: LabelledDataset,
  items: readonly number[] = data.items
): TruthReport {
  const domainIds = labelIds(items.map((item) => data.domain[item] as string));
  const groupIds = labelIds(items.map((item) => data.group[item] as string));
  const leaves = Int32Array.from(items, (item) => tree.itemNode.get(item) ?? -1);
  let pure = 0;
  for (const leaf of tree.leaves()) {
    pure +=
      majority(leaf.items.map((item) => data.domain[item] as string)).share * leaf.items.length;
  }
  return {
    leafNmiGroup: nmi(leaves, groupIds),
    leafDomainPurity: items.length > 0 ? pure / items.length : 1,
    depth1NmiDomain: nmi(depthLabels(tree, items, 1), domainIds),
    depth2NmiDomain: nmi(depthLabels(tree, items, 2), domainIds)
  };
}

export interface TreeObservation {
  items: number;
  /** Children of the root (the Areas). */
  rootChildren: number;
  depthMean: number;
  fanOutInTarget: number;
  leafInRange: number;
  leafDomainPurity: number;
  depth1NmiDomain: number;
  depth2NmiDomain: number;
}

/** The shape and top-level quality numbers that growth runs report before and after inserts. */
export function observeTree(
  tree: TopicTree,
  data: LabelledDataset,
  items: readonly number[],
  config: TreeConfig
): TreeObservation {
  const shape = shapeReport(tree, config, items);
  const truth = truthReport(tree, data, items);
  return {
    items: items.length,
    rootChildren: tree.node(tree.rootId).children.length,
    depthMean: round(shape.itemDepth.mean, 2),
    fanOutInTarget: round(shape.fanOut.inTarget, 3),
    leafInRange: round(shape.leafSize.inRange, 3),
    leafDomainPurity: round(truth.leafDomainPurity, 4),
    depth1NmiDomain: round(truth.depth1NmiDomain, 4),
    depth2NmiDomain: round(truth.depth2NmiDomain, 4)
  };
}

export interface PocketReport {
  dataset: string;
  items: number;
  /** Distinct leaves holding the pocket's items, and their member share there. */
  leaves: number;
  leafPocketShare: number;
  /** Distinct depth-1 topics holding the pocket's items. */
  topTopics: number;
  /** Share of the pocket in its largest depth-1 topic. */
  largestTopTopicShare: number;
}

/** How a small dataset embedded in a larger one is kept together (mixed runs). */
export function pocketReport(
  tree: TopicTree,
  data: LabelledDataset,
  dataset: string
): PocketReport {
  const members = data.items.filter((item) => data.dataset[item] === dataset);
  const leafIds = new Set(members.map((item) => tree.itemNode.get(item) ?? -1));
  let pocketInLeaves = 0;
  let leafTotal = 0;
  for (const id of leafIds) {
    const node = tree.node(id);
    leafTotal += node.items.length;
    pocketInLeaves += node.items.filter((item) => data.dataset[item] === dataset).length;
  }
  const top = depthLabels(tree, members, 1);
  const counts = new Map<number, number>();
  for (const label of top) counts.set(label, (counts.get(label) ?? 0) + 1);
  return {
    dataset,
    items: members.length,
    leaves: leafIds.size,
    leafPocketShare: leafTotal > 0 ? pocketInLeaves / leafTotal : 0,
    topTopics: counts.size,
    largestTopTopicShare: members.length > 0 ? Math.max(...counts.values()) / members.length : 0
  };
}

export interface InsertionRun {
  engine: IncrementalTopicEngine;
  items: number;
  insertMs: number;
  insertMsPerItem: number;
  insertAmbiguityRate: number;
  insertCrossParentAmbiguityRate: number;
  insertUnadmittedRate: number;
  operations: Record<RepairKind, number>;
  shapeBeforeSettle: ShapeReport;
  settleOperations: number;
  settleMs: number;
  shape: ShapeReport;
}

/** Inserts `order` one by one into an empty tree, then settles. */
export function insertFromEmpty(
  matrix: EmbeddingMatrix,
  order: readonly number[],
  config: TreeConfig,
  seed: number
): InsertionRun {
  const engine = IncrementalTopicEngine.empty(matrix, config, seed);
  let ambiguous = 0;
  let crossParent = 0;
  let unadmitted = 0;
  const started = performance.now();
  for (const item of order) {
    const placement = engine.insert(item);
    if (placement.ambiguous) ambiguous += 1;
    if (placement.crossParentAmbiguous) crossParent += 1;
    if (!placement.admittedLeaf) unadmitted += 1;
  }
  const insertMs = performance.now() - started;
  const operations = countOperations(engine.operations);
  const shapeBeforeSettle = shapeReport(engine.tree, config, order);
  const settleStarted = performance.now();
  const settled = engine.settle();
  const settleMs = performance.now() - settleStarted;
  const n = Math.max(1, order.length);
  return {
    engine,
    items: order.length,
    insertMs,
    insertMsPerItem: insertMs / n,
    insertAmbiguityRate: ambiguous / n,
    insertCrossParentAmbiguityRate: crossParent / n,
    insertUnadmittedRate: unadmitted / n,
    operations,
    shapeBeforeSettle,
    settleOperations: settled.length,
    settleMs,
    shape: shapeReport(engine.tree, config, order)
  };
}

export interface ChurnRun {
  base: number;
  inserted: number;
  buildMs: number;
  insertMsPerItem: number;
  /** Share of base items whose primary path changed while the rest was inserted. */
  churn: number;
  insertAmbiguityRate: number;
  insertCrossParentAmbiguityRate: number;
  insertUnadmittedRate: number;
  /** Share of inserts whose margin to the runner-up leaf was below each margin (out of sample). */
  insertGatedAtMargin: Record<string, number>;
  operations: Record<RepairKind, number>;
  shape: ShapeReport;
  /** The base tree right after the build and the grown tree (needs `data`). */
  before?: TreeObservation;
  after?: TreeObservation;
  /** Louvain root grouping diagnostics of the base build. */
  rootDiagnostics?: LouvainDiagnostics;
}

export const insertMargins = [0.01, 0.02, 0.03, 0.05] as const;

export interface BuildThenInsertOptions {
  /** Ground truth; adds the before/after observations. */
  data?: LabelledDataset;
  rootGrouping?: "fixed" | "legacy";
}

/** Builds on `base` with `builder`, then inserts `inserted` one by one (with local repair). */
export function buildThenInsert(
  builder: BuilderName,
  matrix: EmbeddingMatrix,
  base: readonly number[],
  inserted: readonly number[],
  config: TreeConfig,
  seed: number,
  options: BuildThenInsertOptions = {}
): ChurnRun {
  const buildStarted = performance.now();
  const { tree, diagnostics } = buildTree(builder, matrix, base, {
    seed,
    config,
    ...(options.rootGrouping === undefined ? {} : { rootGrouping: options.rootGrouping })
  });
  const buildMs = performance.now() - buildStarted;
  const engine = new IncrementalTopicEngine(tree, matrix, config, seed);
  const before = primaryPaths(tree, base);
  const observedBefore = options.data ? observeTree(tree, options.data, base, config) : undefined;
  let ambiguous = 0;
  let crossParent = 0;
  let unadmitted = 0;
  const gated = Object.fromEntries(insertMargins.map((margin) => [String(margin), 0]));
  const started = performance.now();
  for (const item of inserted) {
    const placement = engine.insert(item);
    if (placement.ambiguous) ambiguous += 1;
    if (placement.crossParentAmbiguous) crossParent += 1;
    if (!placement.admittedLeaf) unadmitted += 1;
    if (placement.admittedLeaf) {
      const margin = placement.margin ?? 1;
      for (const threshold of insertMargins) {
        if (margin < threshold) gated[String(threshold)] = (gated[String(threshold)] ?? 0) + 1;
      }
    }
  }
  const insertMs = performance.now() - started;
  const n = Math.max(1, inserted.length);
  const all = [...base, ...inserted];
  return {
    base: base.length,
    inserted: inserted.length,
    buildMs,
    insertMsPerItem: insertMs / n,
    churn: churn(before, primaryPaths(engine.tree, base)),
    insertAmbiguityRate: ambiguous / n,
    insertCrossParentAmbiguityRate: crossParent / n,
    insertUnadmittedRate: unadmitted / n,
    insertGatedAtMargin: Object.fromEntries(
      Object.entries(gated).map(([margin, count]) => [margin, round(count / n, 4)])
    ),
    operations: countOperations(engine.operations),
    shape: shapeReport(engine.tree, config, all),
    ...(options.data
      ? {
          before: observedBefore as TreeObservation,
          after: observeTree(engine.tree, options.data, all, config)
        }
      : {}),
    ...(diagnostics ? { rootDiagnostics: diagnostics } : {})
  };
}

export function chronological(data: LabelledDataset): number[] {
  return [...data.items].sort(
    (a, b) => (data.order[a] as number) - (data.order[b] as number) || a - b
  );
}

export function shuffled(data: LabelledDataset, seed: number, label = "shuffle"): number[] {
  return createRng(deriveSeed(seed, label)).shuffle([...data.items]);
}

// ---------------------------------------------------------------------------
// Growth and holdout splits

export interface GrowthSplit {
  /** Items the tree is built on. */
  base: number[];
  /** Items inserted one by one (or held out for placement). */
  tail: number[];
}

/**
 * Seeded split that holds out WHOLE units (all items sharing `unitOf`) until about
 * `share` of the items: an article with its pt/en twin, or an entire domain. Splitting
 * random items instead leaves the held-out notes ~20 siblings of the same article in
 * the base tree (Spike B review).
 */
export function splitByUnit(
  data: LabelledDataset,
  unitOf: (item: number) => string,
  share: number,
  seed: number,
  label: string
): GrowthSplit {
  const rng = createRng(deriveSeed(seed, label));
  const units = new Map<string, number[]>();
  for (const item of data.items) {
    const key = unitOf(item);
    const members = units.get(key) ?? [];
    members.push(item);
    units.set(key, members);
  }
  const target = Math.round(share * data.items.length);
  const held = new Set<number>();
  for (const key of rng.shuffle([...units.keys()])) {
    if (held.size >= target) break;
    for (const item of units.get(key) ?? []) held.add(item);
  }
  return {
    base: rng.shuffle(data.items.filter((item) => !held.has(item))),
    tail: rng.shuffle(data.items.filter((item) => held.has(item)))
  };
}

/**
 * How the last `share` of the library arrives:
 * - items: random notes (more notes on topics the tree already has);
 * - chronological: the import order (for the public corpus the tail is the Portuguese
 *   half, which mostly mirrors English articles already in the base);
 * - articles: whole new articles, their pt/en twins held out with them;
 * - domains: whole new domains the base has never seen.
 */
export type GrowthKind = "items" | "chronological" | "articles" | "domains";

export function growthSplit(
  data: LabelledDataset,
  kind: GrowthKind,
  share: number,
  seed: number
): GrowthSplit {
  const cut = Math.round(data.items.length * (1 - share));
  switch (kind) {
    case "items": {
      const order = shuffled(data, seed, "churn");
      return { base: order.slice(0, cut), tail: order.slice(cut) };
    }
    case "chronological": {
      const order = chronological(data);
      return { base: order.slice(0, cut), tail: order.slice(cut) };
    }
    case "articles":
      return splitByUnit(data, (item) => data.twin[item] as string, share, seed, "growth-articles");
    case "domains":
      return splitByUnit(
        data,
        (item) => data.domain[item] as string,
        share,
        seed,
        "growth-domains"
      );
  }
}

/** Distinct holdout units of a growth kind (a split needs at least 5 to mean anything). */
export function unitCount(data: LabelledDataset, kind: GrowthKind): number {
  if (kind === "articles") return new Set(data.twin).size;
  if (kind === "domains") return new Set(data.domain).size;
  return data.items.length;
}

// ---------------------------------------------------------------------------
// Calibration on a held-out 20%

export interface MarginPoint {
  margin: number;
  /** Share of held-out placements below the margin (would go to the decision gate). */
  gated: number;
  /** Among automatic placements: chosen leaf's majority domain / group equals the item's. */
  autoDomainPrecision: number;
  /** Null when the group (article) is held out, so no leaf can hold it. */
  autoGroupPrecision: number | null;
  /** Among gated placements, the same (what the gate has to fix). */
  gatedDomainPrecision: number;
}

export interface FloorPoint {
  floor: number;
  /** Share of reference-leaf cosines at or above the floor (recall of the right leaf). */
  referenceKept: number;
  /** Share of best-other-domain-leaf cosines at or above the floor (wrong-domain admission). */
  otherDomainKept: number;
}

/** Out-of-sample placement under one admission setting (same tree, other thresholds). */
export interface PlacementGridPoint {
  /** z: spread factor of the node-relative admission rule. */
  spreadFactor: number;
  /** a_min. */
  admissionFloor: number;
  /** Leaf-only cosine floor (0 = off). */
  leafFloor: number;
  /** Share of held-out notes admitted to a leaf. */
  admittedLeaf: number;
  /** Among admitted notes, the leaf's majority domain is the note's domain. */
  admittedDomainPrecision: number;
  /** Among admitted notes: share whose margin to the runner-up leaf is below 0.03. */
  gatedAt003: number;
  /** Among admitted notes with margin at or above 0.03: domain precision. */
  autoPrecisionAt003: number;
}

export interface CalibrationReport {
  builder: BuilderName;
  /**
   * items: random notes held out (siblings of the same article stay in the base: optimistic);
   * articles-twin-in-base: whole articles held out one by one, but the pt/en twin of a held-out
   * article stays in the base (the Spike B review's holdout: still leaks across languages);
   * articles: whole articles together with their pt/en twins (new topics: the realistic case).
   */
  holdout: HoldoutKind;
  /** items: the base leaf holding most of the item's own article; articles: best same-domain leaf. */
  referenceLeaf: "own-article-leaf" | "best-same-domain-leaf";
  base: number;
  heldOut: number;
  /** Held-out items whose best leaf (top-1 by centroid cosine among the beam's leaves) is right. */
  top1DomainAccuracy: number;
  /** Null when the article is held out. */
  top1GroupAccuracy: number | null;
  admittedLeafRate: number;
  marginCurve: MarginPoint[];
  /** Cosine of held-out items to the reference leaf vs to the best other-domain leaf. */
  cosineOwnLeaf: Distribution;
  cosineOtherDomainLeaf: Distribution;
  cosineOwnLeafLow: { p01: number; p05: number };
  /** (cos - m_c) / max(s_c, floor) to the reference leaf and to the best other-domain leaf. */
  zOwnLeaf: Distribution;
  zOtherDomainLeaf: Distribution;
  /** For each z: share of reference-leaf admissions (recall) and of other-domain admissions (false). */
  zCurve: { z: number; ownAdmitted: number; otherAdmitted: number }[];
  /** A leaf-only cosine floor, alone: recall of the reference leaf vs wrong-domain admission. */
  floorCurve: FloorPoint[];
  /** z, a_min and the leaf floor tried on the same tree and held-out notes. */
  placementGrid: PlacementGridPoint[];
  /** Leaf coherence for domain-pure (>= 0.9) and impure (< 0.6) leaves of the base tree. */
  coherencePureLeaves: Distribution;
  coherenceImpureLeaves: Distribution;
  /** Centroid cosine of sibling leaves sharing / not sharing their majority group. */
  siblingCosineSameGroup: Distribution;
  siblingCosineOtherGroup: Distribution;
}

function percentileAbove(values: readonly number[], threshold: number): number {
  return values.length > 0
    ? values.filter((value) => value >= threshold).length / values.length
    : 0;
}

export type HoldoutKind = "items" | "articles-twin-in-base" | "articles";

export interface CalibrationOptions {
  holdout?: HoldoutKind;
  margins?: readonly number[];
  floors?: readonly number[];
  rootGrouping?: "fixed" | "legacy";
  /** Admission settings for the placement grid (default: see `defaultPlacementGrid`). */
  grid?: readonly { spreadFactor: number; admissionFloor: number; leafFloor: number }[];
}

export const defaultPlacementGrid = [
  ...[1.5, 2, 2.5, 3, 4].flatMap((spreadFactor) =>
    [0.15, 0.25, 0.35].map((admissionFloor) => ({ spreadFactor, admissionFloor, leafFloor: 0 }))
  ),
  ...[0.3, 0.35, 0.4, 0.45, 0.5, 0.55].map((leafFloor) => ({
    spreadFactor: 2.5,
    admissionFloor: 0.15,
    leafFloor
  })),
  ...[2, 3].map((spreadFactor) => ({ spreadFactor, admissionFloor: 0.15, leafFloor: 0.4 }))
];

export function calibrate(
  builder: BuilderName,
  data: LabelledDataset,
  config: TreeConfig,
  seed: number,
  options: CalibrationOptions = {}
): CalibrationReport {
  const holdout = options.holdout ?? "items";
  const margins = options.margins ?? [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.05, 0.08];
  const floors = options.floors ?? [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
  let base: number[];
  let heldOut: number[];
  if (holdout === "items") {
    const order = shuffled(data, seed, "calibration");
    const cut = Math.round(order.length * 0.8);
    base = order.slice(0, cut);
    heldOut = order.slice(cut);
  } else {
    const split = splitByUnit(
      data,
      (item) => (holdout === "articles" ? data.twin[item] : data.group[item]) as string,
      0.2,
      seed,
      holdout === "articles" ? "calibration-articles" : "calibration-articles-twin-in-base"
    );
    base = split.base;
    heldOut = split.tail;
  }
  const { tree } = buildTree(builder, data.matrix, base, {
    seed,
    config,
    ...(options.rootGrouping === undefined ? {} : { rootGrouping: options.rootGrouping })
  });
  const engine = new IncrementalTopicEngine(tree, data.matrix, config, seed);
  const leaves = tree.leaves().filter((leaf) => leaf.items.length > 0);
  const leafDomain = new Map<number, { value: string; share: number }>();
  const leafGroup = new Map<number, { value: string; share: number }>();
  for (const leaf of leaves) {
    leafDomain.set(leaf.id, majority(leaf.items.map((item) => data.domain[item] as string)));
    leafGroup.set(leaf.id, majority(leaf.items.map((item) => data.group[item] as string)));
  }
  // Own-group leaf: the leaf holding most base items of the group (items holdout only).
  const groupLeaf = new Map<string, number>();
  if (holdout === "items") {
    const counts = new Map<string, Map<number, number>>();
    for (const item of base) {
      const group = data.group[item] as string;
      const leaf = tree.itemNode.get(item) as number;
      const perLeaf = counts.get(group) ?? new Map<number, number>();
      perLeaf.set(leaf, (perLeaf.get(leaf) ?? 0) + 1);
      counts.set(group, perLeaf);
    }
    for (const [group, perLeaf] of counts) {
      let best = -1;
      let bestCount = 0;
      for (const [leaf, count] of perLeaf) {
        if (count > bestCount) {
          best = leaf;
          bestCount = count;
        }
      }
      if (bestCount >= config.leaf.min && tree.has(best) && tree.isLeaf(best))
        groupLeaf.set(group, best);
    }
  }

  const records: {
    margin: number;
    domainOk: boolean;
    groupOk: boolean;
    admitted: boolean;
  }[] = [];
  const cosOwn: number[] = [];
  const cosOther: number[] = [];
  const zOwn: number[] = [];
  const zOther: number[] = [];
  const zOf = (item: number, leafId: number): { cos: number; z: number } => {
    const leaf = tree.node(leafId);
    const cos = dotRowVec(data.matrix, item, leaf.centroid);
    const spread = Math.max(config.placement.spreadFloor, spreadOf(leaf));
    return { cos, z: (cos - admissionMean(leaf, config)) / spread };
  };
  for (const item of heldOut) {
    const placement = engine.place(item);
    const leafCandidates = placement.candidates.filter((candidate) => candidate.leaf);
    const best = leafCandidates[0];
    if (!best) continue;
    const second = leafCandidates[1];
    const margin = second ? best.score - second.score : 1;
    records.push({
      margin,
      domainOk: leafDomain.get(best.nodeId)?.value === data.domain[item],
      groupOk: holdout === "items" && leafGroup.get(best.nodeId)?.value === data.group[item],
      admitted: placement.admittedLeaf
    });
    let reference = holdout === "items" ? (groupLeaf.get(data.group[item] as string) ?? -1) : -1;
    let otherLeaf = -1;
    let otherCos = -Infinity;
    let sameDomainLeaf = -1;
    let sameDomainCos = -Infinity;
    for (const leaf of leaves) {
      const cos = dotRowVec(data.matrix, item, leaf.centroid);
      if (leafDomain.get(leaf.id)?.value === data.domain[item]) {
        if (cos > sameDomainCos) {
          sameDomainCos = cos;
          sameDomainLeaf = leaf.id;
        }
        continue;
      }
      if (cos > otherCos) {
        otherCos = cos;
        otherLeaf = leaf.id;
      }
    }
    if (holdout !== "items") reference = sameDomainLeaf;
    if (reference >= 0) {
      const { cos, z } = zOf(item, reference);
      cosOwn.push(cos);
      zOwn.push(z);
    }
    if (otherLeaf >= 0) {
      const { cos, z } = zOf(item, otherLeaf);
      cosOther.push(cos);
      zOther.push(z);
    }
  }

  const marginCurve = margins.map((threshold): MarginPoint => {
    const auto = records.filter((record) => record.margin >= threshold);
    const gated = records.filter((record) => record.margin < threshold);
    const share = (rows: typeof records, key: "domainOk" | "groupOk"): number =>
      rows.length > 0 ? rows.filter((row) => row[key]).length / rows.length : 1;
    return {
      margin: threshold,
      gated: records.length > 0 ? gated.length / records.length : 0,
      autoDomainPrecision: share(auto, "domainOk"),
      autoGroupPrecision: holdout === "items" ? share(auto, "groupOk") : null,
      gatedDomainPrecision: share(gated, "domainOk")
    };
  });

  const placementGrid = (options.grid ?? defaultPlacementGrid).map(
    ({ spreadFactor, admissionFloor, leafFloor }): PlacementGridPoint => {
      const gridEngine = new IncrementalTopicEngine(
        tree,
        data.matrix,
        {
          ...config,
          placement: { ...config.placement, spreadFactor, admissionFloor, leafFloor }
        },
        seed
      );
      let admitted = 0;
      let admittedRight = 0;
      let gated = 0;
      let auto = 0;
      let autoRight = 0;
      for (const item of heldOut) {
        const placement = gridEngine.place(item);
        if (!placement.admittedLeaf) continue;
        admitted += 1;
        const right = leafDomain.get(placement.nodeId)?.value === data.domain[item];
        if (right) admittedRight += 1;
        if ((placement.margin ?? 1) < 0.03) gated += 1;
        else {
          auto += 1;
          if (right) autoRight += 1;
        }
      }
      return {
        spreadFactor,
        admissionFloor,
        leafFloor,
        admittedLeaf: heldOut.length > 0 ? admitted / heldOut.length : 0,
        admittedDomainPrecision: admitted > 0 ? admittedRight / admitted : 0,
        gatedAt003: admitted > 0 ? gated / admitted : 0,
        autoPrecisionAt003: auto > 0 ? autoRight / auto : 0
      };
    }
  );

  const pure: number[] = [];
  const impure: number[] = [];
  for (const leaf of leaves) {
    const share = leafDomain.get(leaf.id)?.share ?? 0;
    if (share >= 0.9) pure.push(coherenceOf(leaf));
    else if (share < 0.6) impure.push(coherenceOf(leaf));
  }
  const sameGroup: number[] = [];
  const otherGroup: number[] = [];
  tree.walk((node) => {
    const children = node.children
      .map((id) => tree.node(id))
      .filter((child) => child.children.length === 0);
    for (let a = 0; a < children.length; a += 1) {
      for (let b = a + 1; b < children.length; b += 1) {
        const left = children[a];
        const right = children[b];
        if (!left || !right || left.items.length === 0 || right.items.length === 0) continue;
        const cos = dot(left.centroid, right.centroid);
        if (leafGroup.get(left.id)?.value === leafGroup.get(right.id)?.value) sameGroup.push(cos);
        else otherGroup.push(cos);
      }
    }
  });

  return {
    builder,
    holdout,
    referenceLeaf: holdout === "items" ? "own-article-leaf" : "best-same-domain-leaf",
    base: base.length,
    heldOut: heldOut.length,
    top1DomainAccuracy:
      records.filter((record) => record.domainOk).length / Math.max(1, records.length),
    top1GroupAccuracy:
      holdout === "items"
        ? records.filter((record) => record.groupOk).length / Math.max(1, records.length)
        : null,
    admittedLeafRate:
      records.filter((record) => record.admitted).length / Math.max(1, records.length),
    marginCurve,
    cosineOwnLeaf: distribution(cosOwn),
    cosineOtherDomainLeaf: distribution(cosOther),
    cosineOwnLeafLow: lowPercentiles(cosOwn),
    zOwnLeaf: distribution(zOwn),
    zOtherDomainLeaf: distribution(zOther),
    zCurve: [0.5, 1, 1.5, 2, 2.5, 3, 4].map((z) => ({
      z,
      ownAdmitted: percentileAbove(zOwn, -z),
      otherAdmitted: percentileAbove(zOther, -z)
    })),
    floorCurve: floors.map((floor) => ({
      floor,
      referenceKept: percentileAbove(cosOwn, floor),
      otherDomainKept: percentileAbove(cosOther, floor)
    })),
    placementGrid,
    coherencePureLeaves: distribution(pure),
    coherenceImpureLeaves: distribution(impure),
    siblingCosineSameGroup: distribution(sameGroup),
    siblingCosineOtherGroup: distribution(otherGroup)
  };
}

/** Low percentiles that `distribution` does not report. */
export function lowPercentiles(values: readonly number[]): { p01: number; p05: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p01: at(0.01), p05: at(0.05) };
}
