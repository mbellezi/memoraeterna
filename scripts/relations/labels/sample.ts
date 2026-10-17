/**
 * Draws the F3 panel label set (T45, spec 5.2, decision D4). Seed 20261018 for every draw and split.
 *
 *   npx tsx scripts/relations/labels/sample.ts panel [--out .cache/f3/labels/label-set.json]
 *   npx tsx scripts/relations/labels/sample.ts pass --name <pass> --lost <pairs.json> \
 *     [--base .cache/f3/labels/label-set.json] [--consistency 20]
 *
 * `panel` reads T44's candidate pairs (the population: pairs that reach the decider at k = 20), T46a's
 * MLX scores (strata by s = max of both directions' log-odds), T46a's note texts, the library contexts
 * of `context.ts`, the fixture mapping and Spike A's dataset, and draws:
 *   - pool A 120 note pairs among fixture tuning roots only, pool B 90 golden, pool C 90 corpus (30
 *     same-leaf, different-article hard negatives), each stratified 15/20/30/20/15% over the strata
 *     <0, [0, 1.5), [1.5, 3.3), [3.3, 5), >=5 (a short stratum hands its deficit to the nearest ones);
 *   - 40 source pairs (15 fixture tuning, 10 golden, 15 corpus; half nearest neighbours, half random
 *     cross-root) plus the nearest and second-nearest root of every golden root and of 20 corpus
 *     roots, deduplicated (R13);
 *   - R_v6 (Spike A's 37 reverse-only acceptances) and a seeded sample of 50 of R_v9's 137 pairs;
 *   - the fit 60% / eval 40% split of pools A-C by unordered root-pair group, stratified by pool and
 *     stratum. No fixture held-out root enters the fit labels (checked).
 *
 * `pass` builds a later blind pass (T58, T63): the R_v9 pairs a configuration loses that the panel
 * has not labelled yet, mixed with already-labelled pairs as a consistency check.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { readMapping } from "../../golden/matching-evaluation-db.ts";
import { matchingFixtureMappingPath, type MatchingMapping } from "../../golden/matching-fixture.ts";
import {
  aggregatePairScores,
  readPairScores,
  readRelationsExport
} from "../../golden/relations-export.ts";
import {
  readSpikeDataset,
  spikeReverseOnly,
  type SpikeDataset
} from "../../golden/reverse-only.ts";
import { readNoteTexts } from "../note-texts.ts";
import { readPairsFile } from "../pair-scoring.ts";
import {
  contextSchema,
  labelSeed,
  labelSetFormat,
  labelSetSchema,
  labelsDirectory,
  quotas,
  readJson,
  sha256Hex,
  shuffled,
  sortedPair,
  streamRandom,
  stratumOf,
  stratumShares,
  type LabelItem,
  type LabelSet,
  type LibraryContext,
  type LibraryName,
  type Membership,
  type PopulationRow,
  type Stratum
} from "./common.ts";

export interface PanelSizes {
  poolA: number;
  poolB: number;
  poolC: number;
  /** Pool C's same-leaf, different-article pairs (part of `poolC`). */
  hardNegatives: number;
  rv9Sample: number;
  sourceBase: Record<"fixture" | "golden" | "corpus", number>;
  /** Roots whose nearest and second-nearest roots are labelled (R13); Infinity takes every root. */
  neighbourRoots: Record<"golden" | "corpus", number>;
  /** Already-labelled pairs mixed into a later pass. */
  consistency: number;
}

export const panelSizes: PanelSizes = {
  poolA: 120,
  poolB: 90,
  poolC: 90,
  hardNegatives: 30,
  rv9Sample: 50,
  sourceBase: { fixture: 15, golden: 10, corpus: 15 },
  neighbourRoots: { golden: Number.POSITIVE_INFINITY, corpus: 20 },
  consistency: 20
};

export const provisionalRule =
  "max of both directions' MLX log-odds (instruction mechanism, spike-a-note-text-v1)";

export const fitShare = 0.6;

type Pool = "A" | "B" | "C";
type Subpool = "general" | "hard-negative";
type NoteLibrary = Exclude<LibraryName, "spike-a">;

export interface LibraryInput {
  library: NoteLibrary;
  context: LibraryContext;
  /** The population: unordered note pairs T44 exported and T46a scored. */
  pairs: ReadonlyArray<readonly [string, string]>;
  /** MLX s per sorted pair key `lo:hi`. */
  scores: ReadonlyMap<string, number>;
  /** Notes with text. */
  texts: ReadonlySet<string>;
  /** Fixture partition of a root (`tuning`, `holdout`); null outside the fixture. */
  partitionOfRoot: (rootId: string) => string | null;
}

export interface SampleInput {
  seed: number;
  fixture: LibraryInput;
  golden: LibraryInput;
  corpus: LibraryInput;
  /** R_v6: Spike A's pairs with each note's root and partition. */
  rv6: ReadonlyArray<{
    a: string;
    b: string;
    aRoot: string;
    bRoot: string;
    partitions: [string, string];
  }>;
  /** R_v9: the fixture note pairs v9 accepted. */
  rv9: ReadonlyArray<readonly [string, string]>;
  inputs: Record<string, string>;
  sizes?: PanelSizes;
}

export interface Candidate {
  key: string;
  lo: string;
  hi: string;
  loRoot: string;
  hiRoot: string;
  score: number;
  stratum: Stratum;
}

const keyOf = (lo: string, hi: string) => `${lo}:${hi}`;

export const groupOf = (library: string, a: string, b: string): string =>
  `${library}:${sortedPair(a, b).join("|")}`;

export const pairIdOf = (
  kind: "note" | "source",
  library: string,
  lo: string,
  hi: string
): string => `${kind}:${library}:${sha256Hex(`${lo}|${hi}`).slice(0, 16)}`;

function candidatesOf(input: LibraryInput, keep: (lo: string, hi: string) => boolean): Candidate[] {
  const rootOf = new Map(input.context.notes.map((note) => [note.id, note.rootId]));
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const [a, b] of input.pairs) {
    const [lo, hi] = sortedPair(a, b);
    const key = keyOf(lo, hi);
    if (lo === hi || seen.has(key)) continue;
    seen.add(key);
    const score = input.scores.get(key);
    const loRoot = rootOf.get(lo);
    const hiRoot = rootOf.get(hi);
    if (score === undefined) throw new Error(`${input.library}: pair ${key} has no score.`);
    if (!loRoot || !hiRoot)
      throw new Error(`${input.library}: pair ${key} has a note outside the library.`);
    if (!input.texts.has(lo) || !input.texts.has(hi))
      throw new Error(`${input.library}: pair ${key} has a note without text.`);
    if (!keep(lo, hi)) continue;
    result.push({ key, lo, hi, loRoot, hiRoot, score, stratum: stratumOf(score) });
  }
  return result.sort((x, y) => (x.key < y.key ? -1 : 1));
}

/**
 * Draws `total` candidates stratified by `stratumShares`. A stratum with too few candidates gives all
 * it has and hands its deficit, one at a time, to the nearest strata with candidates left.
 */
export function drawStratified(
  population: readonly Candidate[],
  total: number,
  seed: number,
  purpose: string
): { drawn: Candidate[]; requested: number[]; available: number[] } {
  const byStratum: Candidate[][] = [[], [], [], [], []];
  for (const candidate of population) byStratum[candidate.stratum]!.push(candidate);
  const ordered = byStratum.map((list, stratum) =>
    shuffled(list, streamRandom(seed, `${purpose}:stratum:${stratum}`))
  );
  const requested = quotas(total, stratumShares);
  const taken = requested.map((want, stratum) => Math.min(want, ordered[stratum]!.length));
  for (let stratum = 0; stratum < 5; stratum += 1) {
    let deficit = requested[stratum]! - taken[stratum]!;
    // One at a time to the nearest strata with candidates left (the lower one first at a tie).
    while (deficit > 0) {
      let moved = false;
      for (let distance = 1; distance < 5 && !moved; distance += 1)
        for (const other of [stratum - distance, stratum + distance]) {
          if (deficit <= 0 || other < 0 || other > 4) continue;
          if (ordered[other]!.length - taken[other]! <= 0) continue;
          taken[other]! += 1;
          deficit -= 1;
          moved = true;
        }
      if (!moved) break;
    }
  }
  return {
    drawn: ordered.flatMap((list, stratum) => list.slice(0, taken[stratum])),
    requested,
    available: ordered.map((list) => list.length)
  };
}

function poolItem(
  library: NoteLibrary,
  candidate: Candidate,
  pool: Pool,
  subpool: Subpool | null,
  partitionOfRoot: (rootId: string) => string | null
): LabelItem {
  const partitions =
    library === "fixture"
      ? ([
          partitionOfRoot(candidate.loRoot) ?? "unknown",
          partitionOfRoot(candidate.hiRoot) ?? "unknown"
        ] as [string, string])
      : null;
  return {
    pairId: pairIdOf("note", library, candidate.lo, candidate.hi),
    kind: "note",
    library,
    lo: candidate.lo,
    hi: candidate.hi,
    loRoot: candidate.loRoot,
    hiRoot: candidate.hiRoot,
    group: groupOf(library, candidate.loRoot, candidate.hiRoot),
    sets: [{ set: `pool-${pool}`, subpool, basis: null, anchor: null }],
    pool,
    stratum: candidate.stratum,
    score: candidate.score,
    split: null,
    partitions
  };
}

function populationRows(
  pool: Pool,
  subpool: Subpool | null,
  population: readonly Candidate[],
  draw: { drawn: Candidate[]; requested: number[] }
): PopulationRow[] {
  return [0, 1, 2, 3, 4].map((stratum) => ({
    pool,
    subpool,
    stratum,
    population: population.filter((candidate) => candidate.stratum === stratum).length,
    requested: draw.requested[stratum]!,
    drawn: draw.drawn.filter((candidate) => candidate.stratum === stratum).length
  }));
}

// --- Source pairs ---------------------------------------------------------------------------------

interface RootChoice {
  lo: string;
  hi: string;
  membership: Membership;
}

function eligibleRoots(input: LibraryInput): LibraryContext["roots"] {
  return input.context.roots
    .filter((root) => root.notes > 0 && root.neighbours.length > 0)
    .filter((root) => input.library !== "fixture" || input.partitionOfRoot(root.id) === "tuning")
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Half nearest-neighbour pairs (rounded up), half random cross-root pairs, all among `eligible`. */
export function drawSourceBase(input: LibraryInput, total: number, seed: number): RootChoice[] {
  const eligible = eligibleRoots(input);
  const allowed = new Set(eligible.map((root) => root.id));
  const chosen = new Map<string, RootChoice>();
  const add = (a: string, b: string, membership: Membership): boolean => {
    const [lo, hi] = sortedPair(a, b);
    if (lo === hi || chosen.has(keyOf(lo, hi))) return false;
    chosen.set(keyOf(lo, hi), { lo, hi, membership });
    return true;
  };
  const nearestWanted = Math.ceil(total / 2);
  let nearest = 0;
  for (const root of shuffled(eligible, streamRandom(seed, `source:${input.library}:nearest`))) {
    if (nearest >= nearestWanted) break;
    const neighbour = root.neighbours.find((item) => allowed.has(item.id));
    if (
      neighbour &&
      add(root.id, neighbour.id, {
        set: "source-base",
        subpool: null,
        basis: "nearest",
        anchor: root.id
      })
    )
      nearest += 1;
  }
  const random = streamRandom(seed, `source:${input.library}:random`);
  let attempts = 0;
  while (chosen.size < total && attempts < 10_000) {
    attempts += 1;
    const a = eligible[Math.floor(random() * eligible.length)]!;
    const b = eligible[Math.floor(random() * eligible.length)]!;
    add(a.id, b.id, { set: "source-base", subpool: null, basis: "random", anchor: null });
  }
  if (chosen.size < total)
    throw new Error(`${input.library}: only ${chosen.size} source pairs could be drawn.`);
  return [...chosen.values()];
}

/** The nearest and second-nearest root of each anchor root (R13), over the whole library. */
export function drawSourceNeighbours(
  input: LibraryInput,
  anchors: number,
  seed: number
): RootChoice[] {
  const eligible = input.context.roots
    .filter((root) => root.notes > 0 && root.neighbours.length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const picked = Number.isFinite(anchors)
    ? shuffled(eligible, streamRandom(seed, `source:${input.library}:neighbour-roots`)).slice(
        0,
        anchors
      )
    : eligible;
  return picked.flatMap((root) =>
    root.neighbours.slice(0, 2).map((neighbour, index) => {
      const [lo, hi] = sortedPair(root.id, neighbour.id);
      return {
        lo,
        hi,
        membership: {
          set: "source-neighbours" as const,
          subpool: null,
          basis: index === 0 ? ("nearest" as const) : ("second-nearest" as const),
          anchor: root.id
        }
      };
    })
  );
}

function sourceItem(library: NoteLibrary, choice: RootChoice, input: LibraryInput): LabelItem {
  return {
    pairId: pairIdOf("source", library, choice.lo, choice.hi),
    kind: "source",
    library,
    lo: choice.lo,
    hi: choice.hi,
    loRoot: choice.lo,
    hiRoot: choice.hi,
    group: groupOf(library, choice.lo, choice.hi),
    sets: [choice.membership],
    pool: null,
    stratum: null,
    score: null,
    split: null,
    partitions:
      library === "fixture"
        ? [
            input.partitionOfRoot(choice.lo) ?? "unknown",
            input.partitionOfRoot(choice.hi) ?? "unknown"
          ]
        : null
  };
}

// --- Splits ---------------------------------------------------------------------------------------

/**
 * Fit/eval by unordered root-pair group (no group crosses splits), stratified by pool and stratum:
 * groups go, largest first (seeded order among equals), to the split whose pool-and-stratum cells
 * are furthest below their target.
 */
export function assignSplits(items: LabelItem[], seed: number, share = fitShare): void {
  const pooled = items.filter((item) => item.pool !== null);
  const cell = (item: LabelItem) => `${item.pool}:${item.stratum}`;
  const cellSize = new Map<string, number>();
  for (const item of pooled) cellSize.set(cell(item), (cellSize.get(cell(item)) ?? 0) + 1);
  const groups = new Map<string, LabelItem[]>();
  for (const item of pooled) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  const order = shuffled([...groups.keys()].sort(), streamRandom(seed, "splits")).sort(
    (a, b) => groups.get(b)!.length - groups.get(a)!.length
  );
  const fitCount = new Map<string, number>();
  const evalCount = new Map<string, number>();
  let fitTotal = 0;
  let evalTotal = 0;
  for (const group of order) {
    const members = groups.get(group)!;
    let fitNeed = 0;
    let evalNeed = 0;
    for (const item of members) {
      const size = cellSize.get(cell(item))!;
      fitNeed += share * size - (fitCount.get(cell(item)) ?? 0);
      evalNeed += (1 - share) * size - (evalCount.get(cell(item)) ?? 0);
    }
    const globalFitNeed = share * pooled.length - fitTotal;
    const globalEvalNeed = (1 - share) * pooled.length - evalTotal;
    const toFit =
      fitNeed > evalNeed + 1e-9 ||
      (Math.abs(fitNeed - evalNeed) <= 1e-9 && globalFitNeed >= globalEvalNeed);
    for (const item of members) {
      item.split = toFit ? "fit" : "eval";
      const counts = toFit ? fitCount : evalCount;
      counts.set(cell(item), (counts.get(cell(item)) ?? 0) + 1);
    }
    if (toFit) fitTotal += members.length;
    else evalTotal += members.length;
  }
}

/** Refuses a label set whose fit labels hold a fixture held-out root, or a group in both splits. */
export function checkLabelSet(set: LabelSet): void {
  for (const item of set.items) {
    if (item.split === "fit" && item.library === "fixture") {
      if (!item.partitions || item.partitions.some((partition) => partition !== "tuning"))
        throw new Error(
          `Fit item ${item.pairId} holds a fixture root outside the tuning partition.`
        );
    }
    if (item.split !== null && item.pool === null)
      throw new Error(`Item ${item.pairId} is split but belongs to no pool.`);
  }
  const splitOfGroup = new Map<string, string>();
  for (const item of set.items) {
    if (item.split === null) continue;
    const seen = splitOfGroup.get(item.group);
    if (seen && seen !== item.split) throw new Error(`Group ${item.group} crosses the splits.`);
    splitOfGroup.set(item.group, item.split);
  }
  const ids = new Set<string>();
  for (const item of set.items) {
    if (ids.has(item.pairId)) throw new Error(`Pair ${item.pairId} appears twice.`);
    ids.add(item.pairId);
  }
}

// --- The panel ------------------------------------------------------------------------------------

export function sampleLabelSet(input: SampleInput): LabelSet {
  const sizes = input.sizes ?? panelSizes;
  const { seed } = input;
  const items: LabelItem[] = [];
  const populations: PopulationRow[] = [];
  const byKey = new Map<string, LabelItem>();
  const push = (item: LabelItem) => {
    const existing = byKey.get(item.pairId);
    if (existing) {
      for (const membership of item.sets)
        if (!existing.sets.some((own) => JSON.stringify(own) === JSON.stringify(membership)))
          existing.sets.push(membership);
      return;
    }
    byKey.set(item.pairId, item);
    items.push(item);
  };

  // Pool A: fixture tuning roots only (no held-out root anywhere in the pool).
  const tuning = (rootId: string) => input.fixture.partitionOfRoot(rootId) === "tuning";
  const rootOfFixtureNote = new Map(
    input.fixture.context.notes.map((note) => [note.id, note.rootId])
  );
  const poolAPopulation = candidatesOf(
    input.fixture,
    (lo, hi) => tuning(rootOfFixtureNote.get(lo)!) && tuning(rootOfFixtureNote.get(hi)!)
  );
  const poolA = drawStratified(poolAPopulation, sizes.poolA, seed, "pool-A");
  populations.push(...populationRows("A", null, poolAPopulation, poolA));
  for (const candidate of poolA.drawn)
    push(poolItem("fixture", candidate, "A", null, input.fixture.partitionOfRoot));

  const poolBPopulation = candidatesOf(input.golden, () => true);
  const poolB = drawStratified(poolBPopulation, sizes.poolB, seed, "pool-B");
  populations.push(...populationRows("B", null, poolBPopulation, poolB));
  for (const candidate of poolB.drawn) push(poolItem("golden", candidate, "B", null, () => null));

  // Pool C: the same-leaf, different-article hard negatives first, then the rest of the pool.
  const leafOf = new Map(input.corpus.context.notes.map((note) => [note.id, note.leafTopicId]));
  const corpusPopulation = candidatesOf(input.corpus, () => true);
  const hardPopulation = corpusPopulation.filter(
    (candidate) =>
      candidate.loRoot !== candidate.hiRoot &&
      (leafOf.get(candidate.lo) ?? null) !== null &&
      leafOf.get(candidate.lo) === leafOf.get(candidate.hi)
  );
  const hard = drawStratified(hardPopulation, sizes.hardNegatives, seed, "pool-C:hard-negative");
  const hardKeys = new Set(hard.drawn.map((candidate) => candidate.key));
  const generalPopulation = corpusPopulation.filter((candidate) => !hardKeys.has(candidate.key));
  const general = drawStratified(
    generalPopulation,
    sizes.poolC - sizes.hardNegatives,
    seed,
    "pool-C:general"
  );
  populations.push(...populationRows("C", "hard-negative", hardPopulation, hard));
  populations.push(...populationRows("C", "general", generalPopulation, general));
  for (const candidate of hard.drawn)
    push(poolItem("corpus", candidate, "C", "hard-negative", () => null));
  for (const candidate of general.drawn)
    push(poolItem("corpus", candidate, "C", "general", () => null));

  // Source pairs: the base 40, then the R13 neighbour pairs (deduplicated: one item, more sets).
  for (const library of ["fixture", "golden", "corpus"] as const)
    for (const choice of drawSourceBase(input[library], sizes.sourceBase[library], seed))
      push(sourceItem(library, choice, input[library]));
  for (const library of ["golden", "corpus"] as const)
    for (const choice of drawSourceNeighbours(input[library], sizes.neighbourRoots[library], seed))
      push(sourceItem(library, choice, input[library]));

  // R_v6: evaluation only (Spike A's own notes).
  for (const pair of input.rv6) {
    const [lo, hi] = sortedPair(pair.a, pair.b);
    const loRoot = lo === pair.a ? pair.aRoot : pair.bRoot;
    const hiRoot = lo === pair.a ? pair.bRoot : pair.aRoot;
    push({
      pairId: pairIdOf("note", "spike-a", lo, hi),
      kind: "note",
      library: "spike-a",
      lo,
      hi,
      loRoot,
      hiRoot,
      group: groupOf("spike-a", loRoot, hiRoot),
      sets: [{ set: "rv6", subpool: null, basis: null, anchor: null }],
      pool: null,
      stratum: null,
      score: null,
      split: null,
      partitions: lo === pair.a ? pair.partitions : [pair.partitions[1], pair.partitions[0]]
    });
  }

  // R_v9: a seeded sample of 50 of its pairs, evaluation only.
  const rv9Keys = [...new Set(input.rv9.map(([a, b]) => keyOf(...sortedPair(a, b))))].sort();
  for (const key of shuffled(rv9Keys, streamRandom(seed, "rv9-sample")).slice(0, sizes.rv9Sample)) {
    const [lo, hi] = key.split(":") as [string, string];
    const loRoot = rootOfFixtureNote.get(lo);
    const hiRoot = rootOfFixtureNote.get(hi);
    if (!loRoot || !hiRoot)
      throw new Error(`R_v9 pair ${key} has a note outside the fixture library.`);
    if (!input.fixture.texts.has(lo) || !input.fixture.texts.has(hi))
      throw new Error(`R_v9 pair ${key} has a note without text.`);
    push({
      pairId: pairIdOf("note", "fixture", lo, hi),
      kind: "note",
      library: "fixture",
      lo,
      hi,
      loRoot,
      hiRoot,
      group: groupOf("fixture", loRoot, hiRoot),
      sets: [{ set: "rv9-sample", subpool: null, basis: null, anchor: null }],
      pool: null,
      stratum: null,
      score: input.fixture.scores.get(key) ?? null,
      split: null,
      partitions: [
        input.fixture.partitionOfRoot(loRoot) ?? "unknown",
        input.fixture.partitionOfRoot(hiRoot) ?? "unknown"
      ]
    });
  }

  assignSplits(items, seed);
  const set: LabelSet = {
    format: labelSetFormat,
    version: 1,
    seed,
    pass: "panel",
    rule: provisionalRule,
    inputs: input.inputs,
    populations,
    items
  };
  checkLabelSet(set);
  return set;
}

/**
 * A later blind pass: every lost pair the base set has not labelled, plus `consistency` base note
 * items (seeded) whose labels the pass must reproduce.
 */
export function samplePass(input: {
  name: string;
  seed: number;
  base: LabelSet;
  fixture: LibraryInput;
  lost: ReadonlyArray<readonly [string, string]>;
  consistency: number;
}): LabelSet {
  const labelled = new Set(input.base.items.map((item) => item.pairId));
  const rootOf = new Map(input.fixture.context.notes.map((note) => [note.id, note.rootId]));
  const items: LabelItem[] = [];
  const seen = new Set<string>();
  for (const [a, b] of input.lost) {
    const [lo, hi] = sortedPair(a, b);
    const pairId = pairIdOf("note", "fixture", lo, hi);
    if (labelled.has(pairId) || seen.has(pairId)) continue;
    seen.add(pairId);
    const loRoot = rootOf.get(lo);
    const hiRoot = rootOf.get(hi);
    if (!loRoot || !hiRoot)
      throw new Error(`Lost pair ${lo}:${hi} has a note outside the fixture library.`);
    items.push({
      pairId,
      kind: "note",
      library: "fixture",
      lo,
      hi,
      loRoot,
      hiRoot,
      group: groupOf("fixture", loRoot, hiRoot),
      sets: [{ set: "lost", subpool: null, basis: null, anchor: null }],
      pool: null,
      stratum: null,
      score: input.fixture.scores.get(keyOf(lo, hi)) ?? null,
      split: null,
      partitions: [
        input.fixture.partitionOfRoot(loRoot) ?? "unknown",
        input.fixture.partitionOfRoot(hiRoot) ?? "unknown"
      ]
    });
  }
  const candidates = input.base.items
    .filter((item) => item.kind === "note")
    .sort((x, y) => (x.pairId < y.pairId ? -1 : 1));
  for (const item of shuffled(
    candidates,
    streamRandom(input.seed, `pass:${input.name}:consistency`)
  ).slice(0, input.consistency))
    items.push({
      ...item,
      sets: [{ set: "consistency", subpool: null, basis: null, anchor: null }],
      pool: null,
      stratum: null,
      split: null
    });
  return {
    format: labelSetFormat,
    version: 1,
    seed: input.seed,
    pass: input.name,
    rule: input.base.rule,
    inputs: input.base.inputs,
    populations: [],
    items
  };
}

// --- Inputs ---------------------------------------------------------------------------------------

export const defaultInputs = {
  mapping: matchingFixtureMappingPath,
  spikeDataset: ".cache/spikes/reranker/dataset.json",
  spikeBenchmark: "scripts/fixtures/matching-benchmark.json",
  rv9Export: ".cache/f3/m0/exports/envf-retrieval-export.json",
  fixture: {
    pairs: ".cache/f3/m0/pairs/env-f-pairs.json",
    scores: ".cache/f3/scores/env-f-mlx-mechanism.json",
    texts: ".cache/f3/scratch/t46a/env-f-note-texts.json",
    context: `${labelsDirectory}/inputs/env-f-context.json`
  },
  golden: {
    pairs: ".cache/f3/m0/pairs/env-g-pairs.json",
    scores: ".cache/f3/scores/env-g-mlx-mechanism.json",
    texts: ".cache/f3/scratch/t46a/env-g-note-texts.json",
    context: `${labelsDirectory}/inputs/env-g-context.json`
  },
  corpus: {
    pairs: ".cache/f3/m0/pairs/env-c-20261018-pairs.json",
    scores: ".cache/f3/scores/env-c-20261018-mlx-mechanism.json",
    texts: ".cache/f3/scratch/t46a/env-c-20261018-note-texts.json",
    context: `${labelsDirectory}/inputs/env-c-context.json`
  }
} as const;

const fileSha = async (path: string): Promise<string> => sha256Hex(await readFile(path));

/** Fixture root partitions by the mapping: a library root resolves by its title, as the evaluator does. */
export function fixturePartitions(
  mapping: MatchingMapping,
  context: LibraryContext
): (rootId: string) => string | null {
  const byTitle = new Map<string, string[]>();
  for (const root of context.roots)
    byTitle.set(root.title, [...(byTitle.get(root.title) ?? []), root.id]);
  const partition = new Map<string, string>();
  for (const root of mapping.roots) {
    const ids = byTitle.get(root.title) ?? [];
    if (ids.length !== 1)
      throw new Error(`Fixture root ${root.id} resolves to ${ids.length} library roots.`);
    partition.set(ids[0]!, root.partition);
  }
  return (rootId) => partition.get(rootId) ?? null;
}

async function libraryInput(
  library: NoteLibrary,
  paths: { pairs: string; scores: string; texts: string; context: string },
  partitionOf: ((context: LibraryContext) => (rootId: string) => string | null) | null,
  inputs: Record<string, string>
): Promise<LibraryInput> {
  const context = await readJson(paths.context, contextSchema, "library context");
  const pairs = await readPairsFile(paths.pairs);
  const scores = await readPairScores(paths.scores);
  const texts = await readNoteTexts(paths.texts);
  if (texts.file.libraryDigest !== context.libraryDigest)
    throw new Error(`${library}: the note texts and the context come from different libraries.`);
  inputs[`${library}.pairs`] = pairs.sha256;
  inputs[`${library}.scores`] = await fileSha(paths.scores);
  inputs[`${library}.texts`] = texts.sha256;
  inputs[`${library}.context`] = await fileSha(paths.context);
  return {
    library,
    context,
    pairs: pairs.file.pairs,
    scores: aggregatePairScores(scores, "max"),
    texts: new Set(texts.file.notes.map((note) => note.id)),
    partitionOfRoot: partitionOf ? partitionOf(context) : () => null
  };
}

/** Spike A's R_v6 pairs with the roots and partitions of its notes. */
export function rv6Pairs(dataset: SpikeDataset): SampleInput["rv6"] {
  const notes = new Map(
    dataset.notes.map((note) => [
      note.id,
      note as { id: string; root: string; partition?: unknown }
    ])
  );
  return spikeReverseOnly(dataset).map((pair) => {
    const a = notes.get(pair.a)!;
    const b = notes.get(pair.b)!;
    return {
      a: pair.a,
      b: pair.b,
      aRoot: a.root,
      bRoot: b.root,
      partitions: [String(a.partition ?? "unknown"), String(b.partition ?? "unknown")]
    };
  });
}

export async function readPanelInput(paths = defaultInputs): Promise<SampleInput> {
  const inputs: Record<string, string> = {};
  const mapping = await readMapping(paths.mapping);
  inputs.mapping = await fileSha(paths.mapping);
  const fixture = await libraryInput(
    "fixture",
    paths.fixture,
    (context) => fixturePartitions(mapping, context),
    inputs
  );
  const golden = await libraryInput("golden", paths.golden, null, inputs);
  const corpus = await libraryInput("corpus", paths.corpus, null, inputs);
  const dataset = await readSpikeDataset(paths.spikeDataset);
  inputs.spikeDataset = await fileSha(paths.spikeDataset);
  const rv9 = await readRelationsExport(paths.rv9Export);
  inputs.rv9Export = await fileSha(paths.rv9Export);
  return {
    seed: labelSeed,
    fixture,
    golden,
    corpus,
    rv6: rv6Pairs(dataset),
    rv9: rv9.relations.map((relation) => [relation.sourceNoteId, relation.targetNoteId] as const),
    inputs
  };
}

export function summarize(set: LabelSet): string {
  const lines = [`label set "${set.pass}": ${set.items.length} items`];
  const count = (filter: (item: LabelItem) => boolean) => set.items.filter(filter).length;
  for (const name of [
    "pool-A",
    "pool-B",
    "pool-C",
    "source-base",
    "source-neighbours",
    "rv6",
    "rv9-sample",
    "lost",
    "consistency"
  ])
    lines.push(
      `  ${name}: ${count((item) => item.sets.some((membership) => membership.set === name))}`
    );
  lines.push(
    `  note items ${count((item) => item.kind === "note")}, source items ${count((item) => item.kind === "source")}`
  );
  lines.push(
    `  fit ${count((item) => item.split === "fit")}, eval ${count((item) => item.split === "eval")}`
  );
  for (const row of set.populations)
    if (row.drawn !== row.requested || row.population < row.requested)
      lines.push(
        `  pool ${row.pool}${row.subpool ? `/${row.subpool}` : ""} stratum ${row.stratum}: requested ${row.requested}, drawn ${row.drawn}, population ${row.population}`
      );
  return lines.join("\n");
}

async function writeLabelSet(path: string, set: LabelSet): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(labelSetSchema.parse(set), null, 1)}\n`);
  console.info(`wrote ${target}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: "string" },
      name: { type: "string" },
      base: { type: "string" },
      lost: { type: "string" },
      consistency: { type: "string" }
    },
    strict: true,
    allowPositionals: true
  });
  const command = positionals[0] ?? "panel";
  if (command === "panel") {
    const set = sampleLabelSet(await readPanelInput());
    console.info(summarize(set));
    await writeLabelSet(values.out ?? `${labelsDirectory}/label-set.json`, set);
  } else if (command === "pass") {
    if (!values.name || !values.lost) throw new Error("pass needs --name and --lost.");
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(values.name) || values.name === "panel")
      throw new Error("--name must be a lowercase slug other than `panel`.");
    const base = await readJson(
      values.base ?? `${labelsDirectory}/label-set.json`,
      labelSetSchema,
      "label set"
    );
    const lostFile = z
      .union([
        z.array(z.tuple([z.string(), z.string()])),
        z.object({ pairs: z.array(z.tuple([z.string(), z.string()])) })
      ])
      .parse(JSON.parse(await readFile(values.lost, "utf8")));
    const inputs: Record<string, string> = {};
    const mapping = await readMapping(defaultInputs.mapping);
    const fixture = await libraryInput(
      "fixture",
      defaultInputs.fixture,
      (context) => fixturePartitions(mapping, context),
      inputs
    );
    const set = samplePass({
      name: values.name,
      seed: labelSeed,
      base,
      fixture,
      lost: Array.isArray(lostFile) ? lostFile : lostFile.pairs,
      consistency: values.consistency ? Number(values.consistency) : panelSizes.consistency
    });
    console.info(summarize(set));
    await writeLabelSet(
      values.out ?? `${labelsDirectory}/passes/${values.name}/label-set.json`,
      set
    );
  } else {
    throw new Error("The command must be `panel` or `pass`.");
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[labels/sample] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
