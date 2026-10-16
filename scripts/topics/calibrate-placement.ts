// T29a: calibration of the placement and gate parameters (spec section 9; rules registered in
// calibrate-placement-core.ts and docs/topic-placement-calibration.md before any run). Every stage
// uses the calibration seeds 7-12 only and writes its rows to `<cache>/topics/calibration/runs`;
// `adopt` applies the rules to whatever rows exist and writes `placement-adopted.json` and
// `placement-evidence.md` beside them.
//
//   MEMORA_TOPICS_CACHE=<checkout>/.cache npx tsx scripts/topics/calibrate-placement.ts <stage> ...
//
// Stages:
//   admission --dataset env-c|corpus-notitle --holdout known|new [--seeds 7,...] [--point k=v,...]
//   loso      --dataset env-g|env-f [--seeds]          leave-one-source-out (R1 b, R8)
//   structure --dataset env-c|corpus-notitle [--seeds] sibling pairs, planted mis-parents, leaf signals
//   gate-collect --dataset env-c|corpus-notitle [--seeds] [--share 0.1]
//                                                       gated notes at the adopted R1/R2 values
//   gate-score --runtime mlx|gguf --dataset ...         ranks the collected notes (local-model lock)
//   adopt                                               the rules over every row; JSON and evidence
//
// The ranker runs only in gate-score, one local model at a time: it waits until the
// machine-wide lock file (`--lock`, default `<cache>/f2/LOCAL_MODEL_BUSY`) is absent, creates it,
// waits for any other local-model process, scores the cache misses and removes the lock (also on
// failure). Scores are cached by note, descriptor and decider (gate-cache.ts), so a rerun scores
// nothing it scored before. No embedding or generative model is loaded; nothing is remote.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  MlxRerankerAdapter,
  NodeLlamaRankerAdapter,
  findLocalModelCatalogEntry,
  rankTaskRequest,
  readRankResult
} from "@app/ai";
import type { AiModelAdapter } from "@app/ai";
import {
  buildLouvain,
  centralItems,
  cloneTopicTreeState,
  coherenceOf,
  communityGraphOf,
  createRng,
  createTopicTreeEditor,
  createTopicTreeState,
  decidePlacement,
  defaultTopicTreeConfig,
  deriveSeed,
  dot,
  exactKnnGraph,
  gateCacheKeys,
  gateDeciderKey,
  gateDescriptor,
  gateNoteQuery,
  getTopic,
  insertPlacement,
  insertTopic,
  isLive,
  leafTopics,
  modularity,
  parentFit,
  placementRecord,
  primaryPlacement,
  provisionalNames,
  recomputeSubtree,
  refreshTopics,
  registerItem,
  rowItemKey,
  rowOfItemKey,
  rowVectors,
  rowView,
  sphericalKMeans,
  subtreeItems,
  topicRecord,
  topicTreeConfigWith,
  walkTopics
} from "@app/domain/topic-tree";
import type {
  BuildResult,
  FallbackText,
  ItemKey,
  ItemVectorSource,
  PlacementDecision,
  TopicRecord,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

import {
  loadCorpus,
  splitIdea
} from "../../apps/desktop/src/main/services/topic-tree/corpus-library.js";
import { topicGateInstruction } from "../../apps/desktop/src/main/services/topic-tree/topic-prompts.js";
import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import {
  admissionPointId,
  admissionPoints,
  admissionStart,
  atMargin,
  bimodalityCoefficient,
  chooseAdmission,
  chooseGate,
  chooseMargin,
  chooseMergeCosine,
  chooseMisParentMargin,
  configOverrides,
  existingOrNewTable,
  gateAccepts,
  gatePointId,
  gatePoints,
  gateStart,
  joinCorpusNotes,
  labelWeightGrid,
  marginGrid,
  median,
  percentile,
  ruleBars,
  share,
  spikeBParity,
  splitSignalVerdict,
  startMargin,
  startMergeCosine,
  summarizeLoso,
  summarizeOutcomes
} from "./calibrate-placement-core.js";
import type {
  AdmissionPoint,
  AdmissionRow,
  AdoptedGate,
  GateChoice,
  GateNote,
  GatePoint,
  LeafSignals,
  LosoOutcome,
  MisParentProposal,
  MisParentRun,
  NoteOutcome,
  SiblingPair
} from "./calibrate-placement-core.js";
import {
  assertSeedAllowed,
  cacheRoot,
  calibrationSeeds,
  createReplayDataset,
  defaultVectorDirs,
  growthSplit,
  loadReplayDataset,
  twinPairs
} from "./datasets.js";
import type { ReplayDataset } from "./datasets.js";
import { tryReadReplayStore } from "./export-vectors.js";
import { GateScoreCache } from "./gate-cache.js";
import { majority } from "./gate-proof-core.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dataset: { type: "string" },
    holdout: { type: "string" },
    seeds: { type: "string" },
    point: { type: "string" },
    share: { type: "string" },
    runtime: { type: "string" },
    models: { type: "string" },
    lock: { type: "string" },
    "out-dir": { type: "string" },
    "scores-dir": { type: "string" }
  }
});

const stage = positionals[0];
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const outDir = resolve(values["out-dir"] ?? join(cacheRoot(), "topics", "calibration"));
const runsDir = join(outDir, "runs");
const scoresDir = resolve(values["scores-dir"] ?? join(outDir, "gate-scores"));
const seeds = (values.seeds ?? calibrationSeeds.join(",")).split(",").map(Number);
for (const seed of seeds) assertSeedAllowed(seed, "calibration");
const round = (value: number, digits = 4): number =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : value;

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 1)}\n`);
}

const build = (dataset: ReplayDataset, rows: readonly number[], seed: number): BuildResult =>
  buildLouvain(dataset.matrix, rows, {
    seed,
    config: defaultTopicTreeConfig,
    detectCommunities: detectCommunitiesLouvain
  });

// ---------------------------------------------------------------------------
// Datasets

/** ENV-C labelled from the corpus it was seeded from (domains, article groups, note texts). */
async function loadEnvC(): Promise<ReplayDataset> {
  const base = await loadReplayDataset("env-c", { twins: false });
  let indexText: string | null = null;
  for (const dir of defaultVectorDirs()) {
    try {
      indexText = await readFile(join(dir, "env-c.index.jsonl"), "utf8");
      break;
    } catch {
      // next directory
    }
  }
  if (indexText === null) throw new Error("env-c.index.jsonl not found");
  const rootTitles = indexText
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => (JSON.parse(line) as { rootTitle?: string }).rootTitle ?? "");
  const corpus = await loadCorpus(join(cacheRoot(), "corpus"));
  const articles = new Map(
    corpus.articles.map((article) => [
      article.key,
      {
        key: article.key,
        domain: article.domain,
        notes: article.notes.map((note) => ({ id: note.id, title: note.title, text: note.text }))
      }
    ])
  );
  const joined = joinCorpusNotes(
    base.rows.map((row, index) => ({
      index,
      lang: row.lang,
      rootSourceId: row.rootSourceId,
      rootTitle: rootTitles[index] ?? "",
      title: row.title,
      order: row.order
    })),
    articles
  );
  const rows = base.rows.map((row, index) => {
    const note = joined[index]!;
    if (note.index !== index) throw new Error("Corpus join lost a row");
    return { ...row, domain: note.domain, group: note.group, text: note.text };
  });
  // Twins as for DS-C: the Spike B pairs found on the titled MLX store.
  let reference = null;
  for (const dir of defaultVectorDirs()) {
    reference = await tryReadReplayStore(dir, "corpus", { normalize: false });
    if (reference) break;
  }
  if (!reference) throw new Error("The titled corpus store (twins) was not found");
  const twinKeys = new Map<string, string>();
  for (const pair of twinPairs(reference)) {
    const key = `twin:${pair.domain}:${pair.en}`;
    twinKeys.set(pair.enGroup, key);
    twinKeys.set(pair.ptGroup, key);
  }
  return createReplayDataset("env-c", { meta: base.meta, matrix: base.matrix, rows }, { twinKeys });
}

async function loadData(name: string): Promise<ReplayDataset> {
  if (name === "env-c") return loadEnvC();
  if (name === "corpus-notitle") return loadReplayDataset(name);
  if (name === "env-g" || name === "env-f") return loadReplayDataset(name, { twins: false });
  throw new Error(`Unknown dataset ${name}`);
}

/** The gate texts of a row (gate-proof.ts): section title, first sentence, the rest. */
function noteText(dataset: ReplayDataset, row: number) {
  const entry = dataset.rows[row]!;
  const articleTitle = entry.group.split(":").slice(1).join(":") || entry.group;
  const prefix = `${articleTitle} — `;
  const title = entry.title.startsWith(prefix)
    ? entry.title.slice(prefix.length)
    : entry.title === articleTitle
      ? ""
      : entry.title;
  const { idea, body } = splitIdea(entry.text);
  return { title, idea, body };
}

/** Majority label of a topic's subtree (cached). */
function majorityLabeler(
  state: TopicTreeState,
  labelOf: (row: number) => string
): (topicId: string) => string | null {
  const cache = new Map<string, string | null>();
  return (topicId) => {
    if (!cache.has(topicId)) {
      cache.set(
        topicId,
        majority(
          subtreeItems(state, topicId).flatMap((key) => {
            const row = rowOfItemKey(key);
            return row === undefined ? [] : [labelOf(row)];
          })
        )
      );
    }
    return cache.get(topicId) ?? null;
  };
}

function outcomeOf(
  decision: PlacementDecision,
  label: string,
  majorityOf: (topicId: string) => string | null
): NoteOutcome {
  const best =
    decision.kind === "auto" ? decision.leaf : decision.kind === "gate" ? decision.best : null;
  const rightLeaf = decision.leaves.find((leaf) => majorityOf(leaf.topicId) === label);
  const wrongLeaf = decision.leaves.find((leaf) => majorityOf(leaf.topicId) !== label);
  const top = decision.leaves[0];
  return {
    admitted: best !== null,
    margin: best ? decision.margin : null,
    bestRight: best ? majorityOf(best.topicId) === label : false,
    top1Right: top ? majorityOf(top.topicId) === label : false,
    rightAdmitted: rightLeaf ? rightLeaf.admitted : null,
    wrongAdmitted: wrongLeaf ? wrongLeaf.admitted : null
  };
}

const configOf = (point: AdmissionPoint, margin = startMargin): TopicTreeConfig =>
  topicTreeConfigWith({ placement: { ...point, ambiguityMargin: margin } });

/** `--point spreadFactor=2,leafFloor=0.4`: one extra admission point (R1's combination). */
function extraPoint(): AdmissionPoint | null {
  if (!values.point) return null;
  const point: AdmissionPoint = { ...admissionStart };
  for (const part of values.point.split(",")) {
    const [key, value] = part.split("=");
    if (!key || !(key in point) || value === undefined) throw new Error(`Bad --point ${part}`);
    point[key as keyof AdmissionPoint] = Number(value);
  }
  return point;
}

// ---------------------------------------------------------------------------
// R1 and R2: admission and margin

async function stageAdmission(): Promise<void> {
  const name = values.dataset ?? "env-c";
  const holdout = values.holdout === "new" ? "new" : "known";
  const dataset = await loadData(name);
  const extra = extraPoint();
  const points = extra ? [extra] : admissionPoints();
  for (const seed of seeds) {
    const started = performance.now();
    const split = growthSplit(dataset, holdout === "known" ? "items" : "articles", 0.2, seed);
    const built = build(dataset, split.base, seed);
    const domainOf = (row: number) => dataset.rows[row]!.domain;
    const majorityOf = majorityLabeler(built.state, domainOf);
    const tail = [...split.tail].sort((a, b) => a - b);
    const rows: AdmissionRow[] = points.map((point) => {
      const config = configOf(point);
      const outcomes = tail.map((row) =>
        outcomeOf(
          decidePlacement(built.state, config, rowView(dataset.matrix, row)),
          domainOf(row),
          majorityOf
        )
      );
      return {
        dataset: name,
        holdout,
        seed,
        point: admissionPointId(point),
        values: point,
        summary: summarizeOutcomes(outcomes),
        loso: null
      };
    });
    const suffix = extra ? `-${admissionPointId(extra)}` : "";
    await writeJson(join(runsDir, `admission-${name}-${holdout}-${seed}${suffix}.json`), {
      dataset: name,
      holdout,
      seed,
      base: split.base.length,
      tail: tail.length,
      ms: Math.round(performance.now() - started),
      rows
    });
    const start = rows[0]!.summary!;
    console.info(
      `${name} ${holdout} seed ${seed}: ${tail.length} notes, top-1 ${round(start.top1, 3)}, ` +
        `admitted ${round(start.admitted, 3)}, gated@0.015 ${round(atMargin(start, 0.015).gated, 3)}, ` +
        `auto precision@0.015 ${round(atMargin(start, 0.015).autoPrecision, 3)} ` +
        `(${Math.round((performance.now() - started) / 1000)} s)`
    );
  }
}

async function stageLoso(): Promise<void> {
  const name = values.dataset ?? "env-g";
  const dataset = await loadData(name);
  const extra = extraPoint();
  const points = extra ? [extra] : admissionPoints();
  const all = dataset.rows.map((_, row) => row);
  const sources = new Map<string, number[]>();
  for (const row of all) {
    const id = dataset.rows[row]!.rootSourceId;
    sources.set(id, [...(sources.get(id) ?? []), row]);
  }
  for (const seed of seeds) {
    const full = build(dataset, all, seed);
    const label = all.map((row) => primaryPlacement(full.state, rowItemKey(row))?.topicId ?? "");
    const outcomes = new Map<string, LosoOutcome[]>(
      points.map((point) => [admissionPointId(point), []])
    );
    let skipped = 0;
    for (const [, held] of [...sources].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const heldSet = new Set(held);
      const base = all.filter((row) => !heldSet.has(row));
      if (base.length < defaultTopicTreeConfig.bootstrap.minItems) {
        skipped += held.length;
        continue;
      }
      const built = build(dataset, base, seed);
      const majorityOf = majorityLabeler(built.state, (row) => label[row]!);
      const known = new Set(
        leafTopics(built.state)
          .filter((leaf) => leaf.id !== built.state.rootId)
          .map((leaf) => majorityOf(leaf.id))
      );
      for (const point of points) {
        const config = configOf(point);
        for (const row of held) {
          const outcome = outcomeOf(
            decidePlacement(built.state, config, rowView(dataset.matrix, row)),
            label[row]!,
            majorityOf
          );
          outcomes
            .get(admissionPointId(point))!
            .push({ ...outcome, known: known.has(label[row]!) });
        }
      }
    }
    const rows: AdmissionRow[] = points.map((point) => {
      const mine = outcomes.get(admissionPointId(point))!;
      return {
        dataset: name,
        holdout: "loso",
        seed,
        point: admissionPointId(point),
        values: point,
        summary: null,
        loso: summarizeLoso(mine, startMargin),
        losoByMargin: marginGrid.map((margin) => ({ margin, summary: summarizeLoso(mine, margin) }))
      };
    });
    const suffix = extra ? `-${admissionPointId(extra)}` : "";
    await writeJson(join(runsDir, `loso-${name}-${seed}${suffix}.json`), {
      dataset: name,
      seed,
      sources: sources.size,
      skipped,
      fullLeaves: leafTopics(full.state).length,
      rows
    });
    const start = rows[0]!.loso!;
    console.info(
      `${name} loso seed ${seed}: ${start.notes} notes (${start.known} known), score ` +
        `${round(start.score, 3)}, waiting ${round(start.waiting, 3)}`
    );
  }
}

// ---------------------------------------------------------------------------
// R5, R6, R7: structure on full builds

function twoMeansSignals(
  dataset: ReplayDataset,
  members: readonly number[],
  seed: number
): { silhouette: number; modularity: number } {
  const result = sphericalKMeans(dataset.matrix, members, {
    k: 2,
    seed: deriveSeed(seed, "split-signal")
  });
  const labels = result.assignments;
  const n = members.length;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const sums = [0, 0];
    const counts = [0, 0];
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const cluster = labels[j] as number;
      sums[cluster] =
        (sums[cluster] as number) +
        (1 - dot(rowView(dataset.matrix, members[i]!), rowView(dataset.matrix, members[j]!)));
      counts[cluster] = (counts[cluster] as number) + 1;
    }
    const own = labels[i] as number;
    const other = 1 - own;
    if ((counts[own] as number) === 0 || (counts[other] as number) === 0) continue;
    const a = (sums[own] as number) / (counts[own] as number);
    const b = (sums[other] as number) / (counts[other] as number);
    total += (b - a) / Math.max(a, b, 1e-12);
  }
  const graph = exactKnnGraph(dataset.matrix, members, Math.min(5, n - 1));
  const position = new Map(members.map((row, index) => [row, index]));
  return {
    silhouette: total / n,
    modularity: modularity(communityGraphOf(graph, position, members), labels)
  };
}

function plantMisParents(
  state: TopicTreeState,
  built: BuildResult,
  seed: number
): { state: TopicTreeState; planted: Map<string, string> } {
  const clone = cloneTopicTreeState(state);
  const rng = createRng(deriveSeed(seed, "misparent-plant"));
  const byGrandparent = new Map<string, string[]>();
  walkTopics(clone, (node, depth) => {
    if (depth < 2 || node.parentId === null) return;
    const parent = getTopic(clone, node.parentId);
    if (parent.parentId === null || parent.children.length < 3) return;
    const grandparent = getTopic(clone, parent.parentId);
    const uncles = grandparent.children.filter(
      (id) => id !== parent.id && getTopic(clone, id).children.length > 0
    );
    if (uncles.length === 0) return;
    byGrandparent.set(grandparent.id, [...(byGrandparent.get(grandparent.id) ?? []), node.id]);
  });
  const eligible = [...byGrandparent.values()].reduce((sum, list) => sum + list.length, 0);
  const target = Math.max(ruleBars.plantedMin, Math.round(ruleBars.plantedShare * eligible));
  const editor = createTopicTreeEditor(clone, { record: false });
  const planted = new Map<string, string>();
  for (const grandparentId of rng.shuffle([...byGrandparent.keys()].sort())) {
    if (planted.size >= target) break;
    const candidates = (byGrandparent.get(grandparentId) ?? []).sort();
    const topicId = candidates[rng.int(candidates.length)]!;
    const node = getTopic(clone, topicId);
    const parentId = node.parentId!;
    const uncles = getTopic(clone, grandparentId)
      .children.filter((id) => id !== parentId && getTopic(clone, id).children.length > 0)
      .sort();
    const uncle = uncles[rng.int(uncles.length)]!;
    editor.moveTopic(topicId, uncle);
    refreshTopics(clone, built.vectors, [parentId, uncle, topicId]);
    planted.set(topicId, parentId);
  }
  return { state: clone, planted };
}

async function stageStructure(): Promise<void> {
  const name = values.dataset ?? "env-c";
  const dataset = await loadData(name);
  const all = dataset.rows.map((_, row) => row);
  for (const seed of seeds) {
    const started = performance.now();
    const built = build(dataset, all, seed);
    const { state } = built;
    const domainOf = (row: number) => dataset.rows[row]!.domain;
    const unitOf = (row: number) => String(dataset.labels.twin[row]);
    const unitMajority = majorityLabeler(state, unitOf);
    const membersOf = (topicId: string) =>
      subtreeItems(state, topicId).flatMap((key) => {
        const row = rowOfItemKey(key);
        return row === undefined ? [] : [row];
      });

    // R5: leaf signals.
    const leaves: LeafSignals[] = [];
    for (const leaf of leafTopics(state)) {
      if (leaf.id === state.rootId) continue;
      const members = membersOf(leaf.id);
      if (members.length < 4) continue;
      const domains = members.map(domainOf);
      const top = majority(domains);
      const purity = domains.filter((domain) => domain === top).length / domains.length;
      const cosines = members.map((row) => dot(rowView(dataset.matrix, row), leaf.stats.centroid));
      const two = twoMeansSignals(dataset, members, seed);
      leaves.push({
        seed,
        dataset: name,
        size: members.length,
        purity,
        signals: {
          coherence: -coherenceOf(leaf.stats),
          bimodality: bimodalityCoefficient(cosines),
          "two-means-silhouette": two.silhouette,
          "knn-modularity": two.modularity
        }
      });
    }

    // R6: sibling leaf pairs.
    const pairs: SiblingPair[] = [];
    walkTopics(state, (node) => {
      const children = node.children
        .map((id) => getTopic(state, id))
        .filter((child) => child.children.length === 0 && child.stats.n > 0);
      for (let i = 0; i < children.length; i += 1) {
        for (let j = i + 1; j < children.length; j += 1) {
          const a = children[i]!;
          const b = children[j]!;
          pairs.push({
            dataset: name,
            seed,
            cosine: dot(a.stats.centroid, b.stats.centroid),
            size: a.items.length + b.items.length,
            sameUnit: unitMajority(a.id) === unitMajority(b.id)
          });
        }
      }
    });

    // R7: planted mis-parents.
    const { state: planted, planted: plantedMap } = plantMisParents(state, built, seed);
    const proposals: MisParentProposal[] = [];
    walkTopics(planted, (node, depth) => {
      if (depth < 2 || !isLive(node) || node.stats.n === 0) return;
      const fit = parentFit(planted, node.id, depth);
      if (!fit || fit.internalUncleId === null) return;
      const gain = fit.internalUncleCosine - fit.parentCosine;
      if (!(gain >= 0)) return;
      proposals.push({
        dataset: name,
        seed,
        gain,
        restoresPlanted: plantedMap.get(node.id) === fit.internalUncleId
      });
    });
    const misParent: MisParentRun = { dataset: name, seed, planted: plantedMap.size, proposals };

    await writeJson(join(runsDir, `structure-${name}-${seed}.json`), {
      dataset: name,
      seed,
      topics: state.topics.size,
      leaves,
      pairs,
      misParent
    });
    console.info(
      `${name} structure seed ${seed}: ${leaves.length} leaves, ${pairs.length} sibling pairs, ` +
        `${plantedMap.size} planted, ${proposals.length} proposals at gain >= 0 ` +
        `(${Math.round((performance.now() - started) / 1000)} s)`
    );
  }
}

// ---------------------------------------------------------------------------
// R3: the gate

/** TF-IDF provisional names of the leaves, each in its members' majority language (gate-proof). */
function tfidfNames(dataset: ReplayDataset, state: TopicTreeState): Map<string, string> {
  const config = defaultTopicTreeConfig;
  const texts = new Map<ItemKey, FallbackText>();
  for (const key of state.items.keys()) {
    const row = rowOfItemKey(key);
    if (row === undefined) continue;
    const text = noteText(dataset, row);
    texts.set(key, {
      text: text.title ? `${text.title}. ${text.idea}` : text.idea,
      language: dataset.rows[row]!.lang
    });
  }
  const leaves = leafTopics(state)
    .map((node) => node.id)
    .filter((id) => id !== state.rootId);
  const options = {
    minItems: config.naming.fallbackMinItems,
    maxTerms: config.naming.fallbackMaxTerms
  };
  const byLanguage = {
    en: provisionalNames(state, leaves, texts, { ...options, contentLanguage: "en" }).names,
    pt: provisionalNames(state, leaves, texts, { ...options, contentLanguage: "pt-BR" }).names
  };
  const output = new Map<string, string>();
  for (const id of leaves) {
    const languages = subtreeItems(state, id).flatMap((key) => {
      const row = rowOfItemKey(key);
      return row === undefined ? [] : [dataset.rows[row]!.lang];
    });
    const language = majority(languages) === "pt" ? "pt" : "en";
    const name =
      byLanguage[language].get(id) ?? byLanguage[language === "pt" ? "en" : "pt"].get(id);
    if (name) output.set(id, name.title);
  }
  return output;
}

interface GateRequestNote {
  seed: number;
  row: number;
  domain: string;
  itemHash: string;
  query: string;
  /** Scored candidates in content-key order (descriptor present). */
  candidates: {
    topicId: string;
    descriptorHash: string;
    descriptor: string;
    right: boolean;
    /** R3b: the leaf's majority article-with-twin unit is the note's. */
    rightUnit?: boolean;
  }[];
  bestTopicId: string;
  bestRight: boolean;
  bestRightUnit?: boolean;
}

interface GateRequests {
  dataset: string;
  seed: number;
  share: number;
  admission: AdmissionPoint;
  margin: number;
  holdout: number;
  auto: number;
  autoRight: number;
  unadmitted: number;
  gated: number;
  /** Purity and size of every base leaf (R5 none share). */
  leaves: Record<string, { purity: number; size: number }>;
  notes: GateRequestNote[];
}

async function readAdopted(): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(outDir, "placement-adopted.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/** R3 gates new-article holdouts; R3b also known-topic (`items`) holdouts. */
const gateHoldout = (): "new" | "known" => (values.holdout === "known" ? "known" : "new");
const requestPrefix = (name: string, kind: "new" | "known"): string =>
  kind === "known" ? `gate-known-requests-${name}-` : `gate-requests-${name}-`;

/** One topic's descriptor fields (the product's: LLM name, description, aliases). */
interface TopicWords {
  title: string | null;
  description: string | null;
  aliases: string[];
}

interface ExportedTopic {
  id: string;
  parentId: string | null;
  role: string;
  title: string | null;
  nameState: string;
  nameSource: string | null;
  nameLanguage: string | null;
  description: string | null;
  aliases: string[];
  position: number;
  retiredAt: string | null;
}

/**
 * R3c: the exported ENV-C tree (LLM-named topics) without the `held` rows, its statistics
 * recomputed from the vectors. Notes are keyed by row; root sources are left out.
 */
async function namedEnvCState(
  dataset: ReplayDataset,
  held: ReadonlySet<number>
): Promise<{ state: TopicTreeState; vectors: ItemVectorSource; words: Map<string, TopicWords> }> {
  const data = JSON.parse(
    await readFile(join(cacheRoot(), "topics", "exports", "env-c", "export.json"), "utf8")
  ) as {
    topics: ExportedTopic[];
    placements: { item: string; kind: string; topicId: string; rank: number }[];
  };
  const live = data.topics.filter((topic) => topic.retiredAt === null);
  const root = live.find((topic) => topic.role === "root");
  if (!root) throw new Error("The ENV-C export has no root");
  const state = createTopicTreeState({ dim: dataset.matrix.dim, rootId: root.id });
  const children = new Map<string, ExportedTopic[]>();
  for (const topic of live) {
    if (topic.parentId === null) continue;
    children.set(topic.parentId, [...(children.get(topic.parentId) ?? []), topic]);
  }
  const words = new Map<string, TopicWords>();
  const queue = [root.id];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const topic of (children.get(parentId) ?? []).sort((a, b) => a.position - b.position)) {
      insertTopic(
        state,
        topicRecord(topic.id, parentId, {
          title: topic.title,
          nameState: topic.nameState as TopicRecord["nameState"],
          nameSource: topic.nameSource as TopicRecord["nameSource"],
          nameLanguage: topic.nameLanguage,
          description: topic.description,
          aliases: [...topic.aliases],
          position: topic.position
        })
      );
      words.set(topic.id, {
        title: topic.title,
        description: topic.description,
        aliases: [...topic.aliases]
      });
      queue.push(topic.id);
    }
  }
  const rowOfId = new Map(dataset.rows.map((row, index) => [row.id, index]));
  for (const placement of data.placements) {
    if (placement.kind !== "note" || placement.rank !== 0) continue;
    const row = rowOfId.get(placement.item.replace(/^note:/u, ""));
    if (row === undefined || held.has(row)) continue;
    const key = rowItemKey(row);
    registerItem(state, {
      key,
      kind: "note",
      contentHash: dataset.rows[row]!.contentHash,
      rootSource: null
    });
    insertPlacement(state, key, placementRecord(placement.topicId));
  }
  const vectors = rowVectors(dataset.matrix);
  recomputeSubtree(state, vectors);
  return { state, vectors, words };
}

async function stageGateCollect(): Promise<void> {
  const name = values.dataset ?? "env-c";
  const named = name === "env-c-named";
  const kind = named ? "known" : gateHoldout();
  const share_ = Number(values.share ?? "0.1");
  const adopted = await readAdopted();
  const placement = (adopted?.placement ?? null) as {
    admission: AdmissionPoint;
    margin: number;
  } | null;
  if (!placement)
    throw new Error("Run `adopt` after the admission stages first (R1 and R2 values)");
  const config = configOf(placement.admission, placement.margin);
  const dataset = await loadData(named ? "env-c" : name);
  for (const seed of seeds) {
    const split = growthSplit(dataset, kind === "known" ? "items" : "articles", share_, seed);
    const { state, vectors, words } = named
      ? await namedEnvCState(dataset, new Set(split.tail))
      : { ...build(dataset, split.base, seed), words: null };
    const domainOf = (row: number) => dataset.rows[row]!.domain;
    const unitOf = (row: number) => String(dataset.labels.twin[row]);
    const majorityOf = majorityLabeler(state, domainOf);
    const unitMajorityOf = majorityLabeler(state, unitOf);
    const names = words ? null : tfidfNames(dataset, state);
    const describe = (topicId: string): TopicWords =>
      words?.get(topicId) ?? { title: names?.get(topicId) ?? null, description: null, aliases: [] };
    const titleOf = (key: ItemKey) => {
      const row = rowOfItemKey(key);
      return row === undefined ? "" : noteText(dataset, row).title;
    };
    const leaves: GateRequests["leaves"] = {};
    for (const leaf of leafTopics(state)) {
      if (leaf.id === state.rootId) continue;
      const members = subtreeItems(state, leaf.id).flatMap((key) => {
        const row = rowOfItemKey(key);
        return row === undefined ? [] : [domainOf(row)];
      });
      const top = majority(members);
      leaves[leaf.id] = {
        purity: members.length
          ? members.filter((domain) => domain === top).length / members.length
          : 0,
        size: members.length
      };
    }
    const notes: GateRequestNote[] = [];
    let auto = 0;
    let autoRight = 0;
    let unadmitted = 0;
    const tail = [...split.tail].sort((a, b) => a - b);
    for (const row of tail) {
      const decision = decidePlacement(state, config, rowView(dataset.matrix, row));
      if (decision.kind === "unadmitted") {
        unadmitted += 1;
        continue;
      }
      if (decision.kind === "auto") {
        auto += 1;
        if (majorityOf(decision.topicId) === domainOf(row)) autoRight += 1;
        continue;
      }
      const query = gateNoteQuery(noteText(dataset, row), config.gate);
      const keys = gateCacheKeys(
        query,
        decision.candidates.map((candidate) => ({
          topicId: candidate.topicId,
          descriptor: gateDescriptor(
            {
              ...describe(candidate.topicId),
              examples: centralItems(
                state,
                vectors,
                candidate.topicId,
                config.gate.descriptorExamples * 3
              ).map((item) => titleOf(item.key))
            },
            config.gate
          )
        })),
        sha
      );
      notes.push({
        seed,
        row,
        domain: domainOf(row),
        itemHash: keys.itemHash,
        query,
        candidates: keys.candidates
          .filter((candidate) => candidate.descriptor !== null)
          .map((candidate) => ({
            topicId: candidate.topicId,
            descriptorHash: candidate.descriptorHash,
            descriptor: candidate.descriptor as string,
            right: majorityOf(candidate.topicId) === domainOf(row),
            rightUnit: unitMajorityOf(candidate.topicId) === unitOf(row)
          })),
        bestTopicId: decision.best.topicId,
        bestRight: majorityOf(decision.best.topicId) === domainOf(row),
        bestRightUnit: unitMajorityOf(decision.best.topicId) === unitOf(row)
      });
    }
    const requests: GateRequests = {
      dataset: name,
      seed,
      share: share_,
      admission: placement.admission,
      margin: placement.margin,
      holdout: tail.length,
      auto,
      autoRight,
      unadmitted,
      gated: notes.length,
      leaves,
      notes
    };
    await writeJson(join(runsDir, `${requestPrefix(name, kind)}${seed}.json`), requests);
    console.info(
      `${name} gate (${kind}) seed ${seed}: ${tail.length} held-out notes, ${notes.length} gated ` +
        `(${round(share(notes.length, tail.length), 3)}), ${unadmitted} unadmitted`
    );
  }
}

async function readGateRequests(
  name: string,
  kind: "new" | "known" = "new"
): Promise<GateRequests[]> {
  const files = (await readdir(runsDir).catch(() => [] as string[]))
    // Exactly `<prefix><seed>.json`: `env-c` must not pick up `env-c-named`.
    .filter((file) => /^\d+\.json$/u.test(file.slice(requestPrefix(name, kind).length)))
    .filter((file) => file.startsWith(requestPrefix(name, kind)))
    .sort();
  const requests: GateRequests[] = [];
  for (const file of files) {
    const data = JSON.parse(await readFile(join(runsDir, file), "utf8")) as GateRequests;
    if (seeds.includes(data.seed)) requests.push(data);
  }
  return requests;
}

const rankerCatalog = {
  mlx: "mlx-qwen3-reranker-0.6b",
  gguf: "gguf-qwen3-reranker-0.6b-q8-0"
} as const;

function deciderOf(runtime: "mlx" | "gguf") {
  const entry = findLocalModelCatalogEntry(rankerCatalog[runtime]);
  if (!entry) throw new Error(`No catalog entry ${rankerCatalog[runtime]}`);
  const key = gateDeciderKey(
    {
      runtime,
      repository: entry.repository,
      revision: entry.revision,
      quantization: entry.quantization,
      instruction: topicGateInstruction()
    },
    sha
  );
  return { entry, key, catalogId: rankerCatalog[runtime] };
}

/** Waits for the machine-wide lock file, then creates it; returns its remover. */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (;;) {
    try {
      await writeFile(path, `T29a calibrate-placement pid ${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      console.info(`Waiting for ${path} to disappear`);
      await new Promise((done) => setTimeout(done, 30_000));
    }
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await rm(path, { force: true });
  };
  const onSignal = () => {
    void release().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return release;
}

/** No other local-model process may run (gate-proof.ts). */
async function waitForLocalModelSlot(): Promise<void> {
  const job = /memora-mlx-helper|node-llama-cpp|scripts\/spikes\/.*(score|embed)/u;
  for (;;) {
    const others = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => job.test(line) && !line.includes("grep"))
      .filter((line) => !line.trim().startsWith(`${process.pid} `));
    if (others.length === 0) return;
    console.info(`Waiting for other local-model processes (${others.length})`);
    await new Promise((done) => setTimeout(done, 30_000));
  }
}

async function stageGateScore(): Promise<void> {
  const runtime = values.runtime;
  if (runtime !== "mlx" && runtime !== "gguf") throw new Error("--runtime is mlx or gguf");
  const name = values.dataset ?? "env-c";
  const decider = deciderOf(runtime);
  const cache = await GateScoreCache.open(scoresDir, decider.key);
  const kind = gateHoldout();
  const requests = await readGateRequests(name, kind);
  const misses = requests.flatMap((request) =>
    request.notes.filter(
      (note) =>
        note.candidates.length > 0 &&
        note.candidates.some((candidate) => !cache.has(note.itemHash, candidate.descriptorHash))
    )
  );
  console.info(
    `${name} ${runtime}: ${requests.reduce((sum, request) => sum + request.notes.length, 0)} gated ` +
      `notes, ${misses.length} to rank`
  );
  const latencyPath = join(
    runsDir,
    `gate-latency-${name}-${runtime}${kind === "known" ? "-known" : ""}.json`
  );
  const previous = JSON.parse(await readFile(latencyPath, "utf8").catch(() => '{"rankMs":[]}')) as {
    rankMs: number[];
    truncated?: number;
    inputTokens?: number;
  };
  const rankMs = [...previous.rankMs];
  let truncated = previous.truncated ?? 0;
  let inputTokens = previous.inputTokens ?? 0;
  if (misses.length > 0) {
    const modelsRoot = resolve(values.models ?? join(cacheRoot(), ".."));
    const release = await acquireLock(
      resolve(values.lock ?? join(cacheRoot(), "f2", "LOCAL_MODEL_BUSY"))
    );
    let adapter: (AiModelAdapter & { dispose?: () => Promise<void> }) | null = null;
    try {
      await waitForLocalModelSlot();
      const { entry } = decider;
      const options = {
        modelId: entry.id,
        capabilities: [...entry.capabilities],
        repository: entry.repository,
        revision: entry.revision,
        quantization: entry.quantization,
        catalogId: entry.id
      };
      adapter =
        runtime === "mlx"
          ? new MlxRerankerAdapter({
              ...options,
              modelPath: join(modelsRoot, ".cache/models/qwen3-reranker-0.6b-mlx"),
              helperPath: join(modelsRoot, "native/mlx-helper/.build/release/memora-mlx-helper")
            })
          : new NodeLlamaRankerAdapter({
              ...options,
              modelPath: join(
                modelsRoot,
                ".cache/models/qwen3-reranker-0.6b-q8_0-gguf/qwen3-reranker-0.6b-q8_0.gguf"
              )
            });
      const instruction = topicGateInstruction();
      let done = 0;
      for (const note of misses) {
        const request = {
          instruction,
          query: note.query,
          documents: note.candidates.map((candidate) => candidate.descriptor)
        };
        const started = performance.now();
        const result = readRankResult(
          await adapter.run(rankTaskRequest(request)),
          request.documents.length
        );
        rankMs.push(performance.now() - started);
        inputTokens += result.tokenCounts.reduce((sum, count) => sum + count, 0);
        note.candidates.forEach((candidate, index) => {
          if (result.truncated[index]) truncated += 1;
          cache.set({
            noteHash: note.itemHash,
            descriptorHash: candidate.descriptorHash,
            logOdds: result.logOdds[index]!,
            truncated: result.truncated[index] === true
          });
        });
        done += 1;
        if (done % 200 === 0) {
          await cache.flush();
          console.info(`  ${runtime}: ${done}/${misses.length} ranked`);
        }
      }
    } finally {
      await cache.flush();
      await adapter?.dispose?.();
      await release();
    }
  }
  await writeJson(latencyPath, {
    dataset: name,
    runtime,
    deciderKey: decider.key,
    calls: rankMs.length,
    p50Ms: round(percentile(rankMs, 50), 1),
    p95Ms: round(percentile(rankMs, 95), 1),
    maxMs: round(percentile(rankMs, 100), 1),
    truncated,
    inputTokens,
    rankMs: rankMs.map((value) => round(value, 1))
  });
  console.info(
    `${name} ${runtime}: p95 ${round(percentile(rankMs, 95), 1)} ms over ${rankMs.length} calls`
  );
}

/** The gated notes of `name` with one decider's cached log-odds (notes it has not ranked are left out). */
async function gateNotes(
  name: string,
  runtime: "mlx" | "gguf",
  kind: "new" | "known" = "new"
): Promise<{ notes: GateNote[]; requests: GateRequests[]; missing: number; deciderKey: string }> {
  const decider = deciderOf(runtime);
  const cache = await GateScoreCache.open(scoresDir, decider.key);
  const requests = await readGateRequests(name, kind);
  // R3b judges at the article level: a known-topic note's right leaf holds its article; a
  // new-topic note (articles held out with their twins) has none.
  const unitLevel = kind === "known";
  const notes: GateNote[] = [];
  let missing = 0;
  for (const request of requests) {
    for (const note of request.notes) {
      const scores = note.candidates.map((candidate) =>
        cache.get(note.itemHash, candidate.descriptorHash)
      );
      if (scores.some((score) => score === undefined || score === null)) {
        missing += 1;
        continue;
      }
      notes.push({
        seed: note.seed,
        logOdds: scores.map((score) => score!.logOdds),
        right: note.candidates.map((candidate) =>
          unitLevel ? candidate.rightUnit === true : candidate.right
        ),
        bestRight: unitLevel ? note.bestRightUnit === true : note.bestRight
      });
    }
  }
  return { notes, requests, missing, deciderKey: decider.key };
}

// ---------------------------------------------------------------------------
// adopt

async function readRuns<T>(prefix: string): Promise<T[]> {
  const files = (await readdir(runsDir).catch(() => [] as string[]))
    .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
    .sort();
  const output: T[] = [];
  for (const file of files)
    output.push(JSON.parse(await readFile(join(runsDir, file), "utf8")) as T);
  return output;
}

const pct = (value: number | null | undefined, digits = 1): string =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "-"
    : `${(value * 100).toFixed(digits)}%`;

async function stageAdopt(): Promise<void> {
  const admissionFiles = await readRuns<{ rows: AdmissionRow[] }>("admission-");
  const losoFiles = await readRuns<{ rows: AdmissionRow[] }>("loso-");
  const rows = [...admissionFiles, ...losoFiles]
    .flatMap((file) => file.rows)
    .filter((row) => seeds.includes(row.seed));
  const lines: string[] = [];
  const say = (text = "") => lines.push(text);

  // R1.
  const startId = admissionPointId(admissionStart);
  const admission = chooseAdmission(rows, (point) => {
    const id = admissionPointId(point);
    const found = rows.filter((row) => row.point === id);
    return found.length > 0 ? found : null;
  });
  const parity = (["known", "new"] as const).map((holdout) => {
    const mine = rows.filter(
      (row) => row.dataset === "corpus-notitle" && row.holdout === holdout && row.point === startId
    );
    const m = (pick: (row: AdmissionRow) => number) => median(mine.map(pick));
    const measured = {
      top1: m((row) => row.summary!.top1),
      admitted: m((row) => row.summary!.admitted),
      gated03: m((row) => atMargin(row.summary!, 0.03).gated),
      autoPrecision03: m((row) => atMargin(row.summary!, 0.03).autoPrecision)
    };
    const reference = spikeBParity[holdout];
    const gaps = Object.fromEntries(
      Object.entries(measured).map(([key, value]) => [
        key,
        value - reference[key as keyof typeof reference]
      ])
    );
    return { holdout, seeds: mine.length, measured, reference, gaps };
  });

  // R2.
  const marginChoice = chooseMargin(rows, admission.adopted);
  const margin = marginChoice.margin ?? startMargin;
  const adoptedId = admissionPointId(admission.adopted);
  const newAt = (dataset: string) => {
    const mine = rows.filter(
      (row) => row.dataset === dataset && row.holdout === "new" && row.point === adoptedId
    );
    return {
      gated: median(mine.map((row) => atMargin(row.summary!, margin).gated)),
      autoPrecision: median(mine.map((row) => atMargin(row.summary!, margin).autoPrecision)),
      admitted: median(mine.map((row) => row.summary!.admitted)),
      seeds: mine.length
    };
  };

  // R3 (per decider) and R8.
  const gates: AdoptedGate[] = [];
  const gateChoices: Record<string, GateChoice & { missing: number }> = {};
  for (const runtime of ["mlx", "gguf"] as const) {
    const { notes, missing, deciderKey } = await gateNotes("env-c", runtime);
    if (notes.length === 0) continue;
    const choice = chooseGate(notes);
    gateChoices[runtime] = { ...choice, missing };
    const latency = JSON.parse(
      await readFile(join(runsDir, `gate-latency-env-c-${runtime}.json`), "utf8").catch(() => "{}")
    ) as { p95Ms?: number; p50Ms?: number; calls?: number; truncated?: number };
    // Only an eligible point is a calibration. The fallback step's output is reported, not
    // applied: on these labels precision is flat in T, tau and theta (it only tracks the base
    // rate of same-domain candidates), and R3b shows the fallback raises new-topic absorption
    // (docs/topic-placement-calibration.md, deviation D-1). The start values stay.
    const ruleOutput = choice.chosen?.point ?? gateStart;
    const point = choice.how === "eligible" ? ruleOutput : gateStart;
    const at = choice.summaries.find((summary) => summary.id === gatePointId(point));
    gates.push({
      catalogId: rankerCatalog[runtime],
      runtime,
      deciderKey,
      temperature: point.temperature,
      tau: point.tau,
      theta: point.theta,
      how: choice.how === "eligible" ? "eligible" : "kept-start",
      metrics: {
        ruleStep: choice.how,
        ruleOutput: gatePointId(ruleOutput),
        ruleOutputPrecision: round(choice.chosen?.medianPrecision ?? Number.NaN),
        ruleOutputAcceptedShare: round(choice.chosen?.medianAcceptedShare ?? Number.NaN),
        gatedNotes: notes.length,
        notRanked: missing,
        medianAcceptedPrecision: round(at?.medianPrecision ?? Number.NaN),
        minAcceptedPrecision: round(at?.minPrecision ?? Number.NaN),
        medianAcceptedShare: round(at?.medianAcceptedShare ?? Number.NaN),
        medianCorrectShare: round(at?.medianCorrectShare ?? Number.NaN),
        medianNoneShare: round(at?.medianNoneShare ?? Number.NaN),
        baselinePrecision: round(choice.baseline.precision),
        rankerTop1: round(choice.rankerTop1),
        rankP50Ms: latency.p50Ms ?? null,
        rankP95Ms: latency.p95Ms ?? null,
        rankCalls: latency.calls ?? null,
        truncatedDocuments: latency.truncated ?? null
      }
    });
  }
  /** The point R3's registered rule returned for a decider (adopted or not). */
  const ruleOutputOf = (runtime: "mlx" | "gguf"): GatePoint | null => {
    const id = gates.find((gate) => gate.runtime === runtime)?.metrics.ruleOutput;
    return gatePoints().find((point) => gatePointId(point) === id) ?? null;
  };
  // R3b (reported only): existing topic or new topic, per decider.
  const existingOrNew: Record<string, unknown> = {};
  for (const runtime of ["mlx", "gguf"] as const) {
    const known = await gateNotes("env-c", runtime, "known");
    const fresh = await gateNotes("env-c", runtime, "new");
    if (known.notes.length === 0 || fresh.notes.length === 0) continue;
    const table = existingOrNewTable(
      known.notes,
      fresh.notes.map((note) => ({ ...note, right: note.right.map(() => false), bestRight: false }))
    );
    const best = [...table.rows].sort((a, b) => b.balanced - a.balanced)[0]!;
    const at = (id: string) => table.rows.find((row) => row.id === id) ?? null;
    const ruleOutput = ruleOutputOf(runtime);
    existingOrNew[runtime] = {
      knownNotes: known.notes.length,
      newNotes: fresh.notes.length,
      baseline: table.baseline,
      start: at(gatePointId(gateStart)),
      ruleOutput: ruleOutput ? at(gatePointId(ruleOutput)) : null,
      bestBalanced: best,
      rows: table.rows
    };
  }

  // R3c (reported only): known-topic gated notes against the LLM-named ENV-C tree.
  const productDescriptors: Record<string, unknown> = {};
  for (const runtime of ["mlx", "gguf"] as const) {
    const { notes } = await gateNotes("env-c-named", runtime, "known");
    if (notes.length === 0) continue;
    const top1 = (note: GateNote) =>
      note.right[gateAccepts(note.logOdds, gateStart).index] === true;
    const mixed = notes.filter((note) => note.right.some(Boolean) && !note.right.every(Boolean));
    const acceptance = (point: GatePoint) => {
      const perSeed = [...new Set(notes.map((note) => note.seed))].map((seed) => {
        const mine = notes.filter((note) => note.seed === seed);
        let accepted = 0;
        let right = 0;
        for (const note of mine) {
          const verdict = gateAccepts(note.logOdds, point);
          if (!verdict.accepted) continue;
          accepted += 1;
          if (note.right[verdict.index]) right += 1;
        }
        return { precision: share(right, accepted), accepted: share(accepted, mine.length) };
      });
      return {
        point: gatePointId(point),
        precision: round(median(perSeed.map((entry) => entry.precision))),
        acceptedShare: round(median(perSeed.map((entry) => entry.accepted)))
      };
    };
    const r3Point = ruleOutputOf(runtime);
    const r3bBest = (
      existingOrNew[runtime] as { bestBalanced?: { point: GatePoint | null } } | undefined
    )?.bestBalanced?.point;
    productDescriptors[runtime] = {
      gatedNotes: notes.length,
      anyRight: round(share(notes.filter((note) => note.right.some(Boolean)).length, notes.length)),
      rankerTop1: round(share(notes.filter(top1).length, notes.length)),
      marginOnly: round(share(notes.filter((note) => note.bestRight).length, notes.length)),
      mixedNotes: mixed.length,
      mixedRankerTop1: round(share(mixed.filter(top1).length, mixed.length)),
      mixedMarginOnly: round(share(mixed.filter((note) => note.bestRight).length, mixed.length)),
      start: acceptance(gateStart),
      r3: r3Point ? acceptance(r3Point) : null,
      r3bBest: r3bBest ? acceptance(r3bBest) : null
    };
  }

  const mlxGate = gates.find((gate) => gate.runtime === "mlx") ?? gates[0];
  const gateDefault: GatePoint = mlxGate
    ? { temperature: mlxGate.temperature, tau: mlxGate.tau, theta: mlxGate.theta }
    : gateStart;

  // DS-C cross-check (MLX) at the MLX values.
  let crossCheck: Record<string, number> | null = null;
  {
    const { notes } = await gateNotes("corpus-notitle", "mlx");
    if (notes.length > 0) {
      const perSeed = [...new Set(notes.map((note) => note.seed))].map((seed) => {
        const mine = notes.filter((note) => note.seed === seed);
        let accepted = 0;
        let right = 0;
        for (const note of mine) {
          const verdict = gateAccepts(note.logOdds, gateDefault);
          if (verdict.accepted) {
            accepted += 1;
            if (note.right[verdict.index]) right += 1;
          }
        }
        return {
          precision: share(right, accepted),
          accepted: share(accepted, mine.length),
          correct: share(right, mine.length),
          baseline: share(mine.filter((note) => note.bestRight).length, mine.length)
        };
      });
      crossCheck = {
        notes: notes.length,
        precision: round(median(perSeed.map((entry) => entry.precision))),
        acceptedShare: round(median(perSeed.map((entry) => entry.accepted))),
        correctShare: round(median(perSeed.map((entry) => entry.correct))),
        baselinePrecision: round(median(perSeed.map((entry) => entry.baseline)))
      };
    }
  }

  // D19 (b) from the gate splits, and R8 on ENV-C.
  const envcRequests = await readGateRequests("env-c");
  const d19b = {
    gatedShare: round(median(envcRequests.map((request) => share(request.gated, request.holdout)))),
    unadmittedShare: round(
      median(envcRequests.map((request) => share(request.unadmitted, request.holdout)))
    ),
    autoPrecision: round(
      median(envcRequests.map((request) => share(request.autoRight, request.auto)))
    )
  };

  // R5: leaf signals plus the none share from the ENV-C gate splits at the default gate values.
  const structures = (
    await readRuns<{
      dataset: string;
      seed: number;
      leaves: LeafSignals[];
      pairs: SiblingPair[];
      misParent: MisParentRun;
    }>("structure-")
  ).filter((entry) => seeds.includes(entry.seed));
  const leafSignals: LeafSignals[] = structures.flatMap((entry) => entry.leaves);
  if (envcRequests.length > 0 && mlxGate) {
    const cache = await GateScoreCache.open(scoresDir, mlxGate.deciderKey);
    for (const request of envcRequests) {
      const byLeaf = new Map<string, { none: number; total: number }>();
      for (const note of request.notes) {
        const scores = note.candidates.map((candidate) =>
          cache.get(note.itemHash, candidate.descriptorHash)
        );
        if (scores.some((score) => !score)) continue;
        const verdict = gateAccepts(
          scores.map((score) => score!.logOdds),
          gateDefault
        );
        const entry = byLeaf.get(note.bestTopicId) ?? { none: 0, total: 0 };
        entry.total += 1;
        if (!verdict.accepted) entry.none += 1;
        byLeaf.set(note.bestTopicId, entry);
      }
      for (const [leafId, entry] of byLeaf) {
        const leaf = request.leaves[leafId];
        if (!leaf || entry.total < ruleBars.noneShareMinNotes) continue;
        leafSignals.push({
          seed: request.seed,
          dataset: "env-c-gate",
          size: leaf.size,
          purity: leaf.purity,
          signals: { "none-share": entry.none / entry.total }
        });
      }
    }
  }
  const split = splitSignalVerdict(leafSignals);

  // R6 and R7.
  const pairs = structures.flatMap((entry) => entry.pairs);
  const merge = chooseMergeCosine(pairs, defaultTopicTreeConfig.repair.mergeMaxSize);
  const misParent = chooseMisParentMargin(structures.map((entry) => entry.misParent));

  // R8: LOSO at the adopted margin.
  const losoAt = (dataset: string) => {
    const mine = rows.filter(
      (row) => row.dataset === dataset && row.holdout === "loso" && row.point === adoptedId
    );
    const at = mine.map(
      (row) => row.losoByMargin?.find((entry) => Math.abs(entry.margin - margin) < 1e-12)?.summary
    );
    const valid = at.filter((entry) => entry !== undefined);
    return {
      seeds: valid.length,
      score: round(median(valid.map((entry) => entry!.score))),
      waiting: round(median(valid.map((entry) => entry!.waiting))),
      gated: round(median(valid.map((entry) => entry!.gated))),
      gatedBaselinePrecision: round(median(valid.map((entry) => entry!.gatedBaselinePrecision)))
    };
  };

  const labelWeight = 0;
  // The gate rows belong to the space the gated notes were placed in: ENV-C's (the app's GGUF space).
  let spaceKey: string | null = null;
  for (const dir of defaultVectorDirs()) {
    try {
      const meta = JSON.parse(await readFile(join(dir, "env-c.meta.json"), "utf8")) as {
        spaceKey?: string;
      };
      spaceKey = meta.spaceKey ?? null;
      break;
    } catch {
      // next directory
    }
  }
  if (!spaceKey) throw new Error("env-c.meta.json has no spaceKey");
  const adopted = {
    task: "T29a",
    createdAt: new Date().toISOString(),
    seeds,
    spaceKey,
    dataset: "env-c+corpus-notitle+env-g+env-f:calibration-seeds-7-12",
    placement: { admission: admission.adopted, margin },
    gates,
    gateDefault,
    configOverrides: configOverrides({
      admission: admission.adopted,
      margin,
      gateDefault,
      labelWeight,
      splitSignal: { signal: split.signal, threshold: split.signal === "off" ? null : null },
      siblingMergeCosine: merge.chosen ?? startMergeCosine,
      misParentMargin: misParent.chosen ?? defaultTopicTreeConfig.audit.misParentMargin
    }),
    evidence: {
      r1: { choice: admission, parity },
      r2: { ...marginChoice, newTopics: { envC: newAt("env-c"), dsC: newAt("corpus-notitle") } },
      r3: {
        gates: gates.map((gate) => ({
          runtime: gate.runtime,
          how: gate.how,
          metrics: gate.metrics
        })),
        d19b,
        crossCheck,
        existingOrNew,
        productDescriptors
      },
      r4: { labelWeight, grid: labelWeightGrid, status: "not measured: no label vectors offline" },
      r5: split,
      r6: merge,
      r7: misParent,
      r8: { envG: losoAt("env-g"), envF: losoAt("env-f"), envC: d19b }
    }
  };
  await writeJson(join(outDir, "placement-adopted.json"), adopted);

  // A short evidence summary (the full tables live in the JSON).
  say("# T29a evidence summary (generated)");
  say();
  say(`Seeds ${seeds.join(", ")}; rows ${rows.length}; generated ${adopted.createdAt}.`);
  say();
  say("## R1 admission");
  for (const entry of admission.parameters) {
    say(
      `- ${entry.parameter}: start ${entry.start}, chosen ${entry.chosen}; ` +
        entry.candidates
          .map(
            (candidate) =>
              `${candidate.value}: LOSO ${pct(candidate.losoScore)} (${candidate.losoGain >= 0 ? "+" : ""}${(candidate.losoGain * 100).toFixed(1)}), ` +
              `prec drop ${(candidate.precisionDrop * 100).toFixed(1)}, adm drop ${(candidate.admissionDrop * 100).toFixed(1)}${candidate.qualifies ? " qualifies" : ""}`
          )
          .join("; ")
    );
  }
  say(
    `- start LOSO score ${pct(admission.startLosoScore)}; combination ${JSON.stringify(admission.combination)}`
  );
  for (const entry of parity) {
    say(
      `- parity ${entry.holdout} (DS-C, ${entry.seeds} seeds): ` +
        Object.entries(entry.measured)
          .map(
            ([key, value]) =>
              `${key} ${pct(value)} vs ${pct(entry.reference[key as keyof typeof entry.reference])}`
          )
          .join(", ")
    );
  }
  say();
  say("## R2 margin");
  say(`- chosen ${marginChoice.margin ?? "none (start kept)"}`);
  for (const entry of marginChoice.table) {
    say(
      `- ${entry.margin}: min precision ${pct(entry.minPrecision)}, median ${pct(entry.medianPrecision)}, median gated ${pct(entry.medianGated)}`
    );
  }
  say(
    `- new topics at the margin: ENV-C ${JSON.stringify(newAt("env-c"))}, DS-C ${JSON.stringify(newAt("corpus-notitle"))}`
  );
  say();
  say("## R3 gate");
  for (const gate of gates) {
    say(`- ${gate.runtime}: ${gatePointId(gate)} (${gate.how}) ${JSON.stringify(gate.metrics)}`);
  }
  say(
    `- D19 (b) ENV-C split: ${JSON.stringify(d19b)}; DS-C cross-check ${JSON.stringify(crossCheck)}`
  );
  for (const [runtime, entry] of Object.entries(productDescriptors)) {
    say(`- R3c ${runtime}: ${JSON.stringify(entry)}`);
  }
  for (const [runtime, entry] of Object.entries(existingOrNew)) {
    say(`- R3b ${runtime}: ${JSON.stringify({ ...(entry as object), rows: undefined })}`);
  }
  for (const [runtime, choice] of Object.entries(gateChoices)) {
    const top = [...choice.summaries]
      .filter((summary) => summary.eligible)
      .sort((a, b) => b.medianCorrectShare - a.medianCorrectShare)
      .slice(0, 5);
    say(
      `- ${runtime} top eligible: ` +
        top
          .map(
            (summary) =>
              `${summary.id} prec ${pct(summary.medianPrecision)} acc ${pct(summary.medianAcceptedShare)} corr ${pct(summary.medianCorrectShare)}`
          )
          .join("; ")
    );
    const startSummary = choice.summaries.find((summary) => summary.id === gatePointId(gateStart));
    say(
      `- ${runtime} start: prec ${pct(startSummary?.medianPrecision)} acc ${pct(startSummary?.medianAcceptedShare)} corr ${pct(startSummary?.medianCorrectShare)} none ${pct(startSummary?.medianNoneShare)}`
    );
  }
  say();
  say("## R5 split signal");
  say(`- verdict ${split.signal}`);
  for (const entry of split.auc) {
    say(
      `- ${entry.signal} ${entry.dataset}: AUC ${entry.auc.toFixed(3)} (${entry.impure} impure, ${entry.pure} pure)`
    );
  }
  say();
  say("## R6 sibling merge");
  say(`- chosen ${merge.chosen ?? "none"}`);
  for (const entry of merge.table) {
    say(
      `- ${entry.value}: ${entry.pairs} pairs, precision ${pct(entry.precision)}, min seed ${pct(entry.minSeedPrecision)}${entry.qualifies ? " qualifies" : ""}`
    );
  }
  say();
  say("## R7 mis-parent margin");
  say(
    `- chosen ${misParent.chosen ?? "none"}, without the floor ${misParent.withoutFloor ?? "none"}`
  );
  for (const entry of misParent.table) {
    say(
      `- ${entry.margin}: ${entry.proposals} proposals, precision ${pct(entry.precision)}, min run ${pct(entry.minRunPrecision)}, recall ${pct(entry.recall)}`
    );
  }
  say();
  say("## R8 no decider");
  say(`- ENV-G LOSO ${JSON.stringify(losoAt("env-g"))}`);
  say(`- ENV-F LOSO ${JSON.stringify(losoAt("env-f"))}`);
  await writeFile(join(outDir, "placement-evidence.md"), `${lines.join("\n")}\n`);
  console.info(lines.join("\n"));
}

// ---------------------------------------------------------------------------

switch (stage) {
  case "admission":
    await stageAdmission();
    break;
  case "loso":
    await stageLoso();
    break;
  case "structure":
    await stageStructure();
    break;
  case "gate-collect":
    await stageGateCollect();
    break;
  case "gate-score":
    await stageGateScore();
    break;
  case "adopt":
    await stageAdopt();
    break;
  default:
    throw new Error(
      "Usage: calibrate-placement.ts admission|loso|structure|gate-collect|gate-score|adopt [options]"
    );
}
