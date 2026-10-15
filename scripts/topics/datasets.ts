// Datasets of the offline replay: where the replay stores live, labelled item sets, arrival
// orders and the simulated calendar of the E3 weekly replay (spec sections 4 and 8).
//
// Named datasets (spec section 4): `corpus-notitle` and `corpus` are DS-C (the 18,632 Wikipedia
// pseudo-notes, MLX vectors, Spike B stores); `benchmark` and `owner` are the small Spike B sets;
// `env-g`, `env-f` and `env-c` are the app exports of T22a/T22b in the app's own space. Any
// directory with `<name>.meta.json` works through `--vectors-dir`.
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createRng, deriveSeed, rowItemKey } from "@app/domain/topic-tree";
import type { EmbeddingMatrix } from "@app/domain/topic-tree";

import { tryReadReplayStore } from "./export-vectors.js";
import type { ReplayMeta, ReplayRow, ReplayStore } from "./export-vectors.js";

export const repoRoot = resolve(import.meta.dirname, "../..");

/** `.cache` of the checkout, or `MEMORA_TOPICS_CACHE` (a worktree can point at the main cache). */
export function cacheRoot(): string {
  return process.env.MEMORA_TOPICS_CACHE ?? join(repoRoot, ".cache");
}

/** Where replay stores are looked up: app exports first, then the Spike B vector stores. */
export function defaultVectorDirs(): string[] {
  return [
    join(cacheRoot(), "topics", "vectors"),
    join(cacheRoot(), "spikes", "topic-tree", "vectors")
  ];
}

export const reportsDir = (): string => join(cacheRoot(), "topics", "reports");
export const gateScoresDir = (): string => join(cacheRoot(), "topics", "gate-scores");

// ---------------------------------------------------------------------------
// Seeds (spec section 4: pre-registered and disjoint)

/** E1-E3 and gates A and C. */
export const evaluationSeeds: readonly number[] = [20261014, 1, 2, 3, 4, 5];
/** T29a and T29b calibration. A calibration run never uses an evaluation seed or split. */
export const calibrationSeeds: readonly number[] = [7, 8, 9, 10, 11, 12];

export type SeedRole = "evaluation" | "calibration" | "other";

export function seedRole(seed: number): SeedRole {
  if (evaluationSeeds.includes(seed)) return "evaluation";
  if (calibrationSeeds.includes(seed)) return "calibration";
  return "other";
}

/** Throws when a run of `role` would use a seed reserved for the other role. */
export function assertSeedAllowed(seed: number, role: "evaluation" | "calibration"): void {
  const actual = seedRole(seed);
  if (actual !== "other" && actual !== role) {
    throw new Error(`Seed ${seed} is reserved for ${actual} runs; this is a ${role} run`);
  }
}

// ---------------------------------------------------------------------------
// Labelled datasets

/** Interns string labels as dense integers (first appearance order). */
export function internLabels(values: readonly string[]): Int32Array {
  const ids = new Map<string, number>();
  return Int32Array.from(values, (value) => {
    const existing = ids.get(value);
    if (existing !== undefined) return existing;
    ids.set(value, ids.size);
    return ids.size - 1;
  });
}

export interface ReplayDataset {
  name: string;
  meta: ReplayMeta;
  matrix: EmbeddingMatrix;
  rows: ReplayRow[];
  /** Ground-truth label ids per row. */
  labels: {
    domain: Int32Array;
    group: Int32Array;
    language: Int32Array;
    /**
     * Holdout unit: an article with its pt/en twin (Wikipedia mirrors); the group where no twin
     * exists.
     */
    twin: Int32Array;
  };
  /** Where the dataset has real ground truth for `domain` (more than one distinct value). */
  hasDomains: boolean;
}

export interface TwinPair {
  domain: string;
  /** Article titles, and the row groups they come from. */
  en: string;
  pt: string;
  enGroup: string;
  ptGroup: string;
  cosine: number;
}

/** Minimum cosine between article centroids to call a cross-language pair twins (Spike B). */
export const twinThreshold = 0.6;

/**
 * Twin articles by embedding: within each domain, pt and en article centroids are paired one to
 * one by decreasing cosine and kept at or above `twinThreshold` (Spike B: 333 pairs on the
 * corpus). A holdout that left one language of a mirror in the tree would still leak, so twins
 * are held out together.
 */
export function twinPairs(store: Pick<ReplayStore, "rows" | "matrix">): TwinPair[] {
  const { dim } = store.matrix;
  const articles = new Map<
    string,
    { lang: string; domain: string; group: string; title: string; sum: Float64Array }
  >();
  store.rows.forEach((row, index) => {
    let article = articles.get(row.group);
    if (!article) {
      article = {
        lang: row.lang,
        domain: row.domain,
        group: row.group,
        title: row.group.split(":").slice(1).join(":") || row.group,
        sum: new Float64Array(dim)
      };
      articles.set(row.group, article);
    }
    for (let d = 0; d < dim; d += 1) {
      article.sum[d] = (article.sum[d] as number) + (store.matrix.data[index * dim + d] as number);
    }
  });
  for (const article of articles.values()) {
    let norm = 0;
    for (let d = 0; d < dim; d += 1) norm += (article.sum[d] as number) ** 2;
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d += 1) article.sum[d] = (article.sum[d] as number) / norm;
  }
  const pairs: TwinPair[] = [];
  const domains = [...new Set([...articles.values()].map((article) => article.domain))];
  for (const domain of domains) {
    const inDomain = [...articles.values()].filter((article) => article.domain === domain);
    const candidates: TwinPair[] = [];
    for (const en of inDomain.filter((article) => article.lang === "en")) {
      for (const pt of inDomain.filter((article) => article.lang === "pt")) {
        let cosine = 0;
        for (let d = 0; d < dim; d += 1) cosine += (en.sum[d] as number) * (pt.sum[d] as number);
        candidates.push({
          domain,
          en: en.title,
          pt: pt.title,
          enGroup: en.group,
          ptGroup: pt.group,
          cosine
        });
      }
    }
    candidates.sort((a, b) => b.cosine - a.cosine || (a.en < b.en ? -1 : a.en > b.en ? 1 : 0));
    const usedEn = new Set<string>();
    const usedPt = new Set<string>();
    for (const pair of candidates) {
      if (pair.cosine < twinThreshold) break;
      if (usedEn.has(pair.en) || usedPt.has(pair.pt)) continue;
      usedEn.add(pair.en);
      usedPt.add(pair.pt);
      pairs.push(pair);
    }
  }
  return pairs.sort((a, b) => b.cosine - a.cosine);
}

/** Row group -> twin key, from the pairs of `twinPairs`. */
function twinKeys(pairs: readonly TwinPair[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const pair of pairs) {
    const key = `twin:${pair.domain}:${pair.en}`;
    keys.set(pair.enGroup, key);
    keys.set(pair.ptGroup, key);
  }
  return keys;
}

/** Whether twin detection applies: bilingual (en and pt) sets with more than one domain. */
function canHaveTwins(rows: readonly ReplayRow[]): boolean {
  const languages = new Set(rows.map((row) => row.lang));
  return (
    new Set(rows.map((row) => row.domain)).size > 1 && languages.has("en") && languages.has("pt")
  );
}

/**
 * Labels a store for the harness. Twins come from `options.twinKeys` (detected on another store
 * of the same rows), else from the store itself on bilingual, multi-domain sets.
 */
export function createReplayDataset(
  name: string,
  store: ReplayStore,
  options: { twins?: boolean; twinKeys?: ReadonlyMap<string, string> } = {}
): ReplayDataset {
  const { rows } = store;
  const domains = new Set(rows.map((row) => row.domain));
  let twins: ReadonlyMap<string, string> = new Map();
  if (options.twins ?? true) {
    if (options.twinKeys) twins = options.twinKeys;
    else if (canHaveTwins(rows)) twins = twinKeys(twinPairs(store));
  }
  return {
    name,
    meta: store.meta,
    matrix: store.matrix,
    rows,
    labels: {
      domain: internLabels(rows.map((row) => row.domain)),
      group: internLabels(rows.map((row) => row.group)),
      language: internLabels(rows.map((row) => row.lang)),
      twin: internLabels(rows.map((row) => twins.get(row.group) ?? row.group))
    },
    hasDomains: domains.size > 1
  };
}

export class DatasetNotFoundError extends Error {
  override readonly name = "DatasetNotFoundError";
}

/**
 * Datasets whose twins are detected on another store of the same rows. Spike B found the twins
 * of the title-stripped corpus on the titled embeddings (333 pairs, 467 holdout units), and every
 * number measured against that split keeps doing so.
 */
export const defaultTwinSources: Readonly<Record<string, string>> = {
  "corpus-notitle": "corpus"
};

export interface LoadDatasetOptions {
  dirs?: readonly string[];
  /** Detect twins (default true). */
  twins?: boolean;
  /** Store whose embeddings define the twins (default: `defaultTwinSources`, else the store). */
  twinsFrom?: string;
  normalize?: boolean;
}

/** Loads dataset `name` from the first directory that holds it. */
export async function loadReplayDataset(
  name: string,
  options: LoadDatasetOptions = {}
): Promise<ReplayDataset> {
  const dirs = options.dirs ?? defaultVectorDirs();
  const read = async (storeName: string): Promise<ReplayStore | null> => {
    for (const dir of dirs) {
      const store = await tryReadReplayStore(dir, storeName, {
        normalize: options.normalize ?? false
      });
      if (store) return store;
    }
    return null;
  };
  const store = await read(name);
  if (!store) throw new DatasetNotFoundError(`Dataset ${name} not found in ${dirs.join(", ")}`);
  const wantTwins = options.twins ?? true;
  const source = options.twinsFrom ?? defaultTwinSources[name];
  let keys: ReadonlyMap<string, string> | undefined;
  if (wantTwins && source !== undefined && source !== name && canHaveTwins(store.rows)) {
    const reference = await read(source);
    const aligned =
      reference !== null &&
      reference.rows.length === store.rows.length &&
      reference.rows.every((row, index) => row.group === store.rows[index]?.group);
    if (aligned) keys = twinKeys(twinPairs(reference));
  }
  return createReplayDataset(name, store, {
    twins: wantTwins,
    ...(keys === undefined ? {} : { twinKeys: keys })
  });
}

/** Names of the replay stores in `dirs` (a store is a `<name>.meta.json`). */
export async function listReplayDatasets(
  dirs: readonly string[] = defaultVectorDirs()
): Promise<{ name: string; dir: string }[]> {
  const found: { name: string; dir: string }[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".meta.json")) continue;
      const name = entry.slice(0, -".meta.json".length);
      if (seen.has(name)) continue;
      seen.add(name);
      found.push({ name, dir });
    }
  }
  return found;
}

/** `row:<n>` item keys of a dataset, in row order. */
export function datasetKeys(dataset: Pick<ReplayDataset, "rows">): string[] {
  return dataset.rows.map((_, row) => rowItemKey(row));
}

/** A subset of a dataset as a new dataset (row i of the result = rows[i] of the source). */
export function subsetDataset(dataset: ReplayDataset, rows: readonly number[]): ReplayDataset {
  const { dim } = dataset.matrix;
  const data = new Float32Array(rows.length * dim);
  rows.forEach((row, index) => {
    data.set(dataset.matrix.data.subarray(row * dim, (row + 1) * dim), index * dim);
  });
  const pick = (labels: Int32Array): Int32Array =>
    Int32Array.from(rows, (row) => labels[row] as number);
  return {
    name: dataset.name,
    meta: { ...dataset.meta, count: rows.length },
    matrix: { dim, count: rows.length, data },
    rows: rows.map((row) => dataset.rows[row] as ReplayRow),
    labels: {
      domain: pick(dataset.labels.domain),
      group: pick(dataset.labels.group),
      language: pick(dataset.labels.language),
      twin: pick(dataset.labels.twin)
    },
    hasDomains: dataset.hasDomains
  };
}

// ---------------------------------------------------------------------------
// Arrival orders

export const arrivalOrders = ["chronological", "shuffled", "domain"] as const;
export type ArrivalOrder = (typeof arrivalOrders)[number];

function allRows(dataset: Pick<ReplayDataset, "rows">): number[] {
  return Array.from({ length: dataset.rows.length }, (_, row) => row);
}

/** Import order: the dataset's chronological rank, then the row. */
export function chronologicalOrder(dataset: Pick<ReplayDataset, "rows">): number[] {
  return allRows(dataset).sort(
    (a, b) => (dataset.rows[a] as ReplayRow).order - (dataset.rows[b] as ReplayRow).order || a - b
  );
}

export function shuffledOrder(dataset: Pick<ReplayDataset, "rows">, seed: number): number[] {
  return createRng(deriveSeed(seed, "shuffle")).shuffle(allRows(dataset));
}

/**
 * Whole units arrive one after another in a seeded order, each in import order: the stress case
 * (E3 "domain arrival"). The unit is the domain, or the group where the set has one domain only.
 */
export function domainOrder(
  dataset: Pick<ReplayDataset, "rows" | "hasDomains">,
  seed: number
): number[] {
  const unitOf = (row: number): string => {
    const entry = dataset.rows[row] as ReplayRow;
    return dataset.hasDomains ? entry.domain : entry.group;
  };
  const chronological = chronologicalOrder(dataset);
  const units = new Map<string, number[]>();
  for (const row of chronological) {
    const members = units.get(unitOf(row)) ?? [];
    members.push(row);
    units.set(unitOf(row), members);
  }
  const keys = [...units.keys()].sort();
  createRng(deriveSeed(seed, "domain-order")).shuffle(keys);
  return keys.flatMap((key) => units.get(key) ?? []);
}

export function arrivalOrder(
  dataset: Pick<ReplayDataset, "rows" | "hasDomains">,
  kind: ArrivalOrder,
  seed: number
): number[] {
  switch (kind) {
    case "chronological":
      return chronologicalOrder(dataset);
    case "shuffled":
      return shuffledOrder(dataset, seed);
    case "domain":
      return domainOrder(dataset, seed);
  }
}

// ---------------------------------------------------------------------------
// Base/tail splits (Spike B growth runs)

export interface GrowthSplit {
  /** Rows the tree is built on. */
  base: number[];
  /** Rows inserted one by one. */
  tail: number[];
}

/**
 * How the last `share` of the library arrives:
 * - items: random notes (more notes on topics the tree already has);
 * - chronological: the import order;
 * - articles: whole new articles, their pt/en twins held out with them;
 * - domains: whole new domains the base has never seen.
 */
export type GrowthKind = "items" | "chronological" | "articles" | "domains";
export const growthKinds: readonly GrowthKind[] = ["items", "chronological", "articles", "domains"];

/**
 * Seeded split that holds out WHOLE units (all rows sharing `unitOf`) until about `share` of the
 * rows (Spike B review: random notes would leave their ~20 siblings in the base).
 */
export function splitByUnit(
  dataset: Pick<ReplayDataset, "rows">,
  unitOf: (row: number) => number,
  share: number,
  seed: number,
  label: string
): GrowthSplit {
  const rng = createRng(deriveSeed(seed, label));
  const units = new Map<number, number[]>();
  for (const row of allRows(dataset)) {
    const key = unitOf(row);
    const members = units.get(key) ?? [];
    members.push(row);
    units.set(key, members);
  }
  const target = Math.round(share * dataset.rows.length);
  const held = new Set<number>();
  for (const key of rng.shuffle([...units.keys()])) {
    if (held.size >= target) break;
    for (const row of units.get(key) ?? []) held.add(row);
  }
  const rows = allRows(dataset);
  return {
    base: rng.shuffle(rows.filter((row) => !held.has(row))),
    tail: rng.shuffle(rows.filter((row) => held.has(row)))
  };
}

export function growthSplit(
  dataset: ReplayDataset,
  kind: GrowthKind,
  share: number,
  seed: number
): GrowthSplit {
  const cut = Math.round(dataset.rows.length * (1 - share));
  switch (kind) {
    case "items": {
      const order = createRng(deriveSeed(seed, "churn")).shuffle(allRows(dataset));
      return { base: order.slice(0, cut), tail: order.slice(cut) };
    }
    case "chronological": {
      const order = chronologicalOrder(dataset);
      return { base: order.slice(0, cut), tail: order.slice(cut) };
    }
    case "articles":
      return splitByUnit(
        dataset,
        (row) => dataset.labels.twin[row] as number,
        share,
        seed,
        "growth-articles"
      );
    case "domains":
      return splitByUnit(
        dataset,
        (row) => dataset.labels.domain[row] as number,
        share,
        seed,
        "growth-domains"
      );
  }
}

/** Distinct holdout units of a growth kind (a split needs at least 5 to mean anything). */
export function unitCount(dataset: ReplayDataset, kind: GrowthKind): number {
  if (kind === "articles") return new Set(dataset.labels.twin).size;
  if (kind === "domains") return new Set(dataset.labels.domain).size;
  return dataset.rows.length;
}

// ---------------------------------------------------------------------------
// The simulated calendar

export interface SimulatedDay {
  /** 1-based simulated day since the base was built. */
  day: number;
  /** 1-based simulated week. */
  week: number;
  rows: number[];
}

export interface SimulatedSchedule {
  /** Rows of the base tree, built and settled before day 1. */
  base: number[];
  days: SimulatedDay[];
  weeks: number;
}

export interface WeeklyScheduleOptions {
  /** Share of the rows in the base build (E3: 0.6). */
  baseShare?: number;
  /** Simulated weeks (E3: 8). */
  weeks?: number;
  /** Share of the rows arriving each week (E3: 0.05). */
  weeklyShare?: number;
  daysPerWeek?: number;
}

/**
 * E3: a `baseShare` base, then `weeks` weeks of `weeklyShare` arrivals in `order`, spread over
 * `daysPerWeek` simulated days (each day is one PLACE and REBALANCE round). Week boundaries are
 * cumulative roundings, so the last week ends at the last row.
 */
export function weeklySchedule(
  order: readonly number[],
  options: WeeklyScheduleOptions = {}
): SimulatedSchedule {
  const baseShare = options.baseShare ?? 0.6;
  const weeks = options.weeks ?? 8;
  const weeklyShare = options.weeklyShare ?? 0.05;
  const daysPerWeek = options.daysPerWeek ?? 7;
  if (!(baseShare > 0 && baseShare < 1) || weeks < 1 || weeklyShare <= 0 || daysPerWeek < 1) {
    throw new RangeError("Invalid weekly schedule options");
  }
  const n = order.length;
  const boundary = (week: number): number =>
    Math.min(n, Math.round(n * (baseShare + week * weeklyShare)));
  const baseEnd = Math.min(n, Math.round(n * baseShare));
  const days: SimulatedDay[] = [];
  for (let week = 1; week <= weeks; week += 1) {
    const start = week === 1 ? baseEnd : boundary(week - 1);
    const end = week === weeks && baseShare + weeks * weeklyShare >= 1 ? n : boundary(week);
    const count = Math.max(0, end - start);
    for (let day = 0; day < daysPerWeek; day += 1) {
      const from = start + Math.floor((count * day) / daysPerWeek);
      const to = start + Math.floor((count * (day + 1)) / daysPerWeek);
      days.push({ day: (week - 1) * daysPerWeek + day + 1, week, rows: order.slice(from, to) });
    }
  }
  return { base: order.slice(0, baseEnd), days, weeks };
}

/**
 * ENV-G and ENV-F (manifest order): the first `baseShare` of the sources bootstrap the tree, then
 * one source per simulated day, each source's notes in import order.
 */
export function sourceDaySchedule(
  dataset: Pick<ReplayDataset, "rows">,
  options: { baseShare?: number; daysPerWeek?: number } = {}
): SimulatedSchedule {
  const baseShare = options.baseShare ?? 0.5;
  const daysPerWeek = options.daysPerWeek ?? 7;
  const sources: { id: string; rows: number[] }[] = [];
  const index = new Map<string, number>();
  for (const row of chronologicalOrder(dataset)) {
    const id = (dataset.rows[row] as ReplayRow).rootSourceId;
    let at = index.get(id);
    if (at === undefined) {
      at = sources.length;
      index.set(id, at);
      sources.push({ id, rows: [] });
    }
    sources[at]?.rows.push(row);
  }
  const baseSources = Math.max(1, Math.min(sources.length, Math.round(sources.length * baseShare)));
  const tail = sources.slice(baseSources);
  return {
    base: sources.slice(0, baseSources).flatMap((source) => source.rows),
    days: tail.map((source, at) => ({
      day: at + 1,
      week: Math.floor(at / daysPerWeek) + 1,
      rows: source.rows
    })),
    weeks: Math.max(1, Math.ceil(tail.length / daysPerWeek))
  };
}
