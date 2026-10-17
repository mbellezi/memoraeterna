// Topic coherence after the first E4 panel (F2, gate C): offline readings and the registered rules
// of `.cache/topics/reports/coherence/evidence.md` (rules in coherence-calibration.ts). Calibration
// seeds 7-12 only; the product trees (exports) are read as an analysis, never rebuilt.
//
//   npx tsx scripts/topics/calibrate-coherence.ts answers                 # A1, D-L2 on the product trees
//   npx tsx scripts/topics/calibrate-coherence.ts root-target --dataset env-c-cal --seeds 7,8,9
//   npx tsx scripts/topics/calibrate-coherence.ts choose-root             # A3 over the root-target rows
//   npx tsx scripts/topics/calibrate-coherence.ts small-knn               # K1 rows and choice
//   npx tsx scripts/topics/calibrate-coherence.ts threshold --k 5         # K2 rows and choice
//   npx tsx scripts/topics/calibrate-coherence.ts doubling --k 5 --max 1000 # K2's guard
//   npx tsx scripts/topics/calibrate-coherence.ts homonyms                # D-H
//
// Inputs come from `MEMORA_TOPICS_CACHE` (a worktree points it at the main checkout's `.cache`);
// output goes to `--out` (default: this checkout's `.cache/topics/reports/coherence`). No model,
// database or network is used.
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  areaGroupingInput,
  areaRepairVectors,
  areaShape,
  buildLouvain,
  centralItems,
  centroidSilhouette,
  checkAreaAnswer,
  cloneTopicTreeState,
  createTopicTreeState,
  defaultTopicTreeConfig,
  dot,
  getTopic,
  insertPlacement,
  insertTopic,
  leafLabels,
  levelOneTopic,
  placementRecord,
  purity,
  recomputeSubtree,
  regroupAreas,
  registerItem,
  rowItemKey,
  rowOfItemKey,
  rowVectors,
  silhouettePoints,
  subtreeItems,
  topicRecord,
  topicTreeConfigWith,
  validateAreaProposal
} from "@app/domain/topic-tree";
import type { TopicRecord, TopicTreeConfig, TopicTreeState } from "@app/domain/topic-tree";

import { loadCorpus } from "../../apps/desktop/src/main/services/topic-tree/corpus-library.js";
import { parseTopicAreasOutput } from "../../apps/desktop/src/main/services/topic-tree/topic-prompts.js";
import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { joinCorpusNotes } from "./calibrate-placement-core.js";
import { articleGrowthDataset, fixturePairs } from "./calibrate-stability.js";
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
  sourceSeparation,
  subtreeCounts
} from "./coherence-calibration.js";
import type {
  GroupingReading,
  LabelledSource,
  LevelReading,
  RootTargetRow,
  SmallKnnRow,
  ThresholdRow,
  TreeUnit
} from "./coherence-calibration.js";
import {
  assertSeedAllowed,
  cacheRoot,
  calibrationSeeds,
  createReplayDataset,
  loadReplayDataset,
  repoRoot,
  twinPairs
} from "./datasets.js";
import type { ReplayDataset } from "./datasets.js";
import { tryReadReplayStore } from "./export-vectors.js";
import { sourceGrowthRun, sourcesInOrder } from "./growth-quality.js";
import type { FixtureReading } from "./growth-quality.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dataset: { type: "string" },
    seeds: { type: "string" },
    values: { type: "string" },
    k: { type: "string" },
    max: { type: "string" },
    out: { type: "string" }
  }
});

const out = values.out ?? join(repoRoot, ".cache", "topics", "reports", "coherence");
const log = (message: string): void => console.info(`[coherence] ${message}`);
const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const seedsOf = (fallback: readonly number[]): number[] => {
  const seeds = values.seeds ? values.seeds.split(",").map(Number) : [...fallback];
  for (const seed of seeds) assertSeedAllowed(seed, "calibration");
  return seeds;
};
const listOf = (text: string | undefined, fallback: string): number[] =>
  (text ?? fallback).split(",").map(Number);

async function writeJson(name: string, data: unknown): Promise<void> {
  await mkdir(out, { recursive: true });
  await writeFile(join(out, name), `${JSON.stringify(data, null, 1)}\n`);
}

async function appendRow(name: string, row: unknown): Promise<void> {
  await mkdir(out, { recursive: true });
  await appendFile(join(out, name), `${JSON.stringify(row)}\n`);
}

async function readRows<T>(prefix: string): Promise<T[]> {
  const files = (await readdir(out)).filter(
    (file) => file.startsWith(prefix) && file.endsWith(".jsonl")
  );
  const rows: T[] = [];
  for (const file of files.sort()) {
    for (const line of (await readFile(join(out, file), "utf8")).split("\n")) {
      if (line.trim() !== "") rows.push(JSON.parse(line) as T);
    }
  }
  return rows;
}

async function readIndex(name: string): Promise<{ rootTitle?: string; rootSourceId: string }[]> {
  const text = await readFile(
    join(cacheRoot(), "topics", "vectors", `${name}.index.jsonl`),
    "utf8"
  );
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { rootTitle?: string; rootSourceId: string });
}

// ---------------------------------------------------------------------------
// Datasets

/** An ENV-C store labelled from the corpus it was seeded from (T29a's join), with DS-C twins. */
async function labelledEnvC(name: string): Promise<ReplayDataset> {
  const base = await loadReplayDataset(name, { twins: false });
  const index = await readIndex(name);
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
    base.rows.map((row, index_) => ({
      index: index_,
      lang: row.lang,
      rootSourceId: row.rootSourceId,
      rootTitle: index[index_]?.rootTitle ?? "",
      title: row.title,
      order: row.order
    })),
    articles
  );
  const rows = base.rows.map((row, index_) => ({
    ...row,
    domain: joined[index_]!.domain,
    group: joined[index_]!.group
  }));
  const reference = await tryReadReplayStore(join(cacheRoot(), "topics", "vectors"), "corpus", {
    normalize: false
  });
  const twinKeys = new Map<string, string>();
  if (reference) {
    for (const pair of twinPairs(reference)) {
      const key = `twin:${pair.domain}:${pair.en}`;
      twinKeys.set(pair.enGroup, key);
      twinKeys.set(pair.ptGroup, key);
    }
  }
  return createReplayDataset(name, { meta: base.meta, matrix: base.matrix, rows }, { twinKeys });
}

async function dataset(name: string): Promise<ReplayDataset> {
  return name.startsWith("env-c") ? labelledEnvC(name) : loadReplayDataset(name);
}

const domainOf = (data: ReplayDataset) => (row: number) => data.rows[row]?.domain;
const unitOf = (data: ReplayDataset) => (row: number) => String(data.labels.twin[row]);

// ---------------------------------------------------------------------------
// The product trees (exports) and the recorded Areas answers (A1, D-L2)

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

/** The exported tree over the store's note rows (root sources are not in the store). */
async function exportedState(data: ReplayDataset): Promise<TopicTreeState> {
  const exported = JSON.parse(
    await readFile(join(cacheRoot(), "topics", "exports", data.name, "export.json"), "utf8")
  ) as {
    topics: ExportedTopic[];
    placements: { item: string; kind: string; topicId: string; rank: number }[];
  };
  const live = exported.topics.filter((topic) => topic.retiredAt === null);
  const root = live.find((topic) => topic.role === "root");
  if (!root) throw new Error(`${data.name}: the export has no root`);
  const state = createTopicTreeState({ dim: data.matrix.dim, rootId: root.id });
  const children = new Map<string, ExportedTopic[]>();
  for (const topic of live) {
    if (topic.parentId !== null)
      children.set(topic.parentId, [...(children.get(topic.parentId) ?? []), topic]);
  }
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
      queue.push(topic.id);
    }
  }
  const rowOfId = new Map(data.rows.map((row, index) => [row.id, index]));
  for (const placement of exported.placements) {
    if (placement.kind !== "note" || placement.rank !== 0) continue;
    const row = rowOfId.get(placement.item.replace(/^note:/u, ""));
    if (row === undefined) continue;
    const key = rowItemKey(row);
    registerItem(state, {
      key,
      kind: "note",
      contentHash: data.rows[row]!.contentHash,
      rootSource: null
    });
    insertPlacement(state, key, placementRecord(placement.topicId));
  }
  recomputeSubtree(state, rowVectors(data.matrix));
  return state;
}

interface RecordedAnswer {
  file: string;
  recordedAt: string;
  units: { alias: string; titles: string[] }[];
  output: unknown;
}

const areasPromptStart = "Group the numbered topics of a personal knowledge library into Areas";

async function recordedAreasAnswers(): Promise<RecordedAnswer[]> {
  const root = join(cacheRoot(), "golden", "cassettes", "corpus-f2", "entries");
  const answers: RecordedAnswer[] = [];
  for (const dir of (await readdir(root)).sort()) {
    for (const file of (await readdir(join(root, dir))).sort()) {
      const entry = JSON.parse(await readFile(join(root, dir, file), "utf8")) as {
        taskType: string;
        request: { input: unknown };
        responses: { output: unknown; recordedAt: string }[];
      };
      const input = entry.request.input;
      if (entry.taskType !== "structured-output" || typeof input !== "string") continue;
      if (!input.includes(areasPromptStart) || input.includes("was rejected")) continue;
      const units = JSON.parse(
        input.slice(input.indexOf("Topics:\n") + "Topics:\n".length).trim()
      ) as {
        alias: string;
        titles: string[];
      }[];
      for (const response of entry.responses) {
        answers.push({
          file: `${dir}/${file}`,
          recordedAt: response.recordedAt,
          units,
          output: response.output
        });
      }
    }
  }
  return answers.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
}

function treeUnits(
  state: TopicTreeState,
  data: ReplayDataset,
  config: TopicTreeConfig
): TreeUnit[] {
  const vectors = rowVectors(data.matrix);
  const titleOf = (row: number | undefined): string =>
    row === undefined ? "" : (data.rows[row]?.title ?? "");
  return areaGroupingInput(state).units.map((unit) => {
    const subtreeTitles = new Map<string, number>();
    for (const item of subtreeItems(state, unit.topicId)) {
      const title = titleOf(rowOfItemKey(item));
      subtreeTitles.set(title, (subtreeTitles.get(title) ?? 0) + 1);
    }
    return {
      alias: unit.alias,
      titles: centralItems(state, vectors, unit.topicId, config.areas.centralTitles).map((item) =>
        titleOf(rowOfItemKey(item.key))
      ),
      subtreeTitles
    };
  });
}

function areasLabels(state: TopicTreeState, data: ReplayDataset, config: TopicTreeConfig) {
  const rows = data.rows.map((_, row) => row);
  const reading = levelReading(state, 1, rows, domainOf(data), unitOf(data));
  const shape = areaShape(state, config);
  const points = silhouettePoints(state);
  return {
    areas: reading.topics,
    depth1Nmi: reading.nmi,
    depth1Purity: reading.meanTop,
    mixedShare: reading.mixedShare,
    e8: reading.e8,
    silhouette: round(centroidSilhouette(state, points, (id) => levelOneTopic(state, id))),
    meanDepth: round(shape.meanDepth),
    fanOutInTarget: round(shape.fanOutInTarget),
    singleChild: shape.singleChildTopics,
    compositions: getTopic(state, state.rootId).children.map((id) => {
      const part = composition(subtreeCounts(state, id, domainOf(data)));
      const counts = [...subtreeCounts(state, id, domainOf(data))].sort((a, b) => b[1] - a[1]);
      return {
        title: getTopic(state, id).title,
        notes: part.total,
        top: round(part.top),
        e8: round(part.expectedDistinct),
        domains: counts
          .slice(0, 5)
          .map(([domain, count]) => `${domain} ${round(count / part.total, 2)}`)
      };
    })
  };
}

let idCounter = 0;
const newId = (): string =>
  `00000000-0000-4000-9000-${(idCounter += 1).toString(16).padStart(12, "0")}`;

async function stageAnswers(): Promise<void> {
  const config = defaultTopicTreeConfig;
  const trees: { data: ReplayDataset; state: TopicTreeState; units: TreeUnit[] }[] = [];
  for (const name of ["env-c", "env-c-cal"]) {
    const data = await dataset(name);
    const state = await exportedState(data);
    trees.push({ data, state, units: treeUnits(state, data, config) });
  }
  const answers = await recordedAreasAnswers();
  const results: Record<string, unknown>[] = [];
  const pairs: { louvain: GroupingReading; model: GroupingReading }[] = [];
  for (const answer of answers) {
    const fits = trees.map((tree) => ({
      tree,
      mapping: mapPromptAliases(answer.units, tree.units)
    }));
    fits.sort((a, b) => b.mapping.exact - a.mapping.exact);
    const { tree, mapping } = fits[0]!;
    const parsed = parseTopicAreasOutput(answer.output);
    const mapped = {
      areas: parsed.areas.map((area) => ({
        ...area,
        members: area.members.map((member) => mapping.map.get(member) ?? member)
      }))
    };
    const input = areaGroupingInput(tree.state);
    const check = checkAreaAnswer(input, mapped, config, areaRepairVectors(tree.state, input));
    const louvain = areasLabels(tree.state, tree.data, config);
    const checked = validateAreaProposal(input, check.proposal, config);
    if (!checked.ok) {
      results.push({
        file: answer.file,
        tree: tree.data.name,
        valid: false,
        issues: checked.issues
      });
      continue;
    }
    const copy = cloneTopicTreeState(tree.state);
    const regroup = regroupAreas({
      state: copy,
      vectors: rowVectors(tree.data.matrix),
      config,
      input,
      proposal: checked.proposal,
      seed: 20261014,
      now: "2026-10-17T12:00:00.000Z",
      day: "2026-10-17",
      newTopicId: newId,
      changeSetId: newId(),
      contentLanguage: "pt-BR"
    });
    const model = areasLabels(copy, tree.data, config);
    pairs.push({ louvain, model });
    const emptyTitles = answer.units
      .flatMap((unit) => unit.titles)
      .filter((title) => title.trim() === "").length;
    results.push({
      file: answer.file,
      recordedAt: answer.recordedAt,
      tree: tree.data.name,
      units: answer.units.length,
      emptyTitleShare: round(emptyTitles / (3 * answer.units.length)),
      mapping: { exact: mapping.exact, matched: mapping.matched, unmapped: mapping.unmapped },
      repair: check.report,
      acceptance: {
        accepted: regroup.acceptance.accepted,
        reasons: regroup.acceptance.reasons,
        silhouette: regroup.acceptance.silhouette
      },
      louvain,
      model
    });
    log(
      `${answer.file.slice(0, 10)} on ${tree.data.name}: mapped ${mapping.exact}+${mapping.matched}; ` +
        `${regroup.acceptance.accepted ? "accepted" : `rejected (${regroup.acceptance.reasons.join(",")})`}; ` +
        `NMI ${louvain.depth1Nmi} -> ${model.depth1Nmi}, purity ${louvain.depth1Purity} -> ` +
        `${model.depth1Purity}, mixed ${louvain.mixedShare} -> ${model.mixedShare}, e8 ${louvain.e8} -> ${model.e8}`
    );
  }
  const verdict = modelMoreCoherent(pairs);
  log(`rule A1: the model's grouping is ${verdict ? "" : "not "}more coherent than Louvain's`);

  // D-L2 on the product tree the panel rated, and the panel's ENV-C topics beside their labels.
  const rated = trees.find((tree) => tree.data.name === "env-c-cal")!;
  const rows = rated.data.rows.map((_, row) => row);
  const levels = [1, 2, 3].map((depth) =>
    levelReading(rated.state, depth, rows, domainOf(rated.data), unitOf(rated.data))
  );
  const panel: Record<string, unknown>[] = [];
  try {
    const folder = join(cacheRoot(), "topics", "rating", "seed-20261016-ai");
    const sealed = JSON.parse(await readFile(join(folder, "sealed.json"), "utf8")) as {
      entries: { key: string; profile: string; stratum: string; topicId: string; name: string }[];
    };
    const verdicts = (
      JSON.parse(await readFile(join(folder, "answers.json"), "utf8")) as {
        answers: Record<string, { coerente: boolean; bemNomeado: boolean }>;
      }
    ).answers;
    for (const entry of sealed.entries) {
      if (entry.profile !== "env-c" || !rated.state.topics.has(entry.topicId)) continue;
      const byDomain = composition(subtreeCounts(rated.state, entry.topicId, domainOf(rated.data)));
      const byUnit = composition(subtreeCounts(rated.state, entry.topicId, unitOf(rated.data)));
      panel.push({
        key: entry.key,
        stratum: entry.stratum,
        name: entry.name,
        coherent: verdicts[entry.key]?.coerente ?? null,
        notes: byDomain.total,
        topDomain: byDomain.topLabel,
        topShare: round(byDomain.top),
        e8Domain: round(byDomain.expectedDistinct),
        e8Article: round(byUnit.expectedDistinct)
      });
    }
  } catch (error) {
    log(`no panel: ${(error as Error).message}`);
  }
  await writeJson("answers.json", {
    ruleA1: { modelMoreCoherent: verdict },
    answers: results,
    levels,
    panel
  });
}

// ---------------------------------------------------------------------------
// A3: fanOut.rootTarget on calibration builds (with the D-L2 readings of each build)

async function stageRootTarget(): Promise<void> {
  const name = values.dataset ?? "env-c-cal";
  const data = await dataset(name);
  const rows = data.rows.map((_, row) => row);
  for (const seed of seedsOf(calibrationSeeds)) {
    for (const rootTarget of listOf(values.values, "9,10,11,12")) {
      const config = topicTreeConfigWith({ fanOut: { rootTarget } });
      const started = performance.now();
      const { state } = buildLouvain(data.matrix, rows, {
        seed,
        config,
        detectCommunities: detectCommunitiesLouvain
      });
      const areas = areasLabels(state, data, config);
      const levels: LevelReading[] = [2, 3].map((depth) =>
        levelReading(state, depth, rows, domainOf(data), unitOf(data))
      );
      const row: RootTargetRow & { levels: LevelReading[]; e8: number; seconds: number } = {
        dataset: name,
        seed,
        rootTarget,
        areas: areas.areas,
        depth1Nmi: areas.depth1Nmi,
        depth1Purity: areas.depth1Purity,
        mixedShare: areas.mixedShare,
        e8: areas.e8,
        fanOutInTarget: areas.fanOutInTarget,
        meanDepth: areas.meanDepth,
        singleChild: areas.singleChild,
        levels,
        seconds: round((performance.now() - started) / 1000, 1)
      };
      await appendRow(`rows-root-${name}-${seed}.jsonl`, row);
      log(
        `${name} seed ${seed} rootTarget ${rootTarget}: Areas ${row.areas}, NMI ${row.depth1Nmi}, purity ` +
          `${row.depth1Purity}, mixed ${row.mixedShare}, e8 ${row.e8}, fan-out ${row.fanOutInTarget}, ` +
          `depth ${row.meanDepth}; level 2 pure ${levels[0]?.pureShare}; ${row.seconds} s`
      );
    }
  }
}

async function stageChooseRoot(): Promise<void> {
  const rows = await readRows<RootTargetRow>("rows-root-");
  const choice = chooseRootTarget(rows);
  await writeJson("root-target.json", choice);
  for (const entry of choice.table) {
    log(
      `rootTarget ${entry.rootTarget}: ${entry.builds} builds, ${entry.eligible ? "eligible" : `not eligible (${entry.reasons.join(",")})`}, ` +
        `NMI ${entry.medianNmi}, purity ${entry.medianPurity}, mixed ${entry.medianMixed}`
    );
  }
  log(`rule A3: rootTarget ${choice.chosen}`);
}

// ---------------------------------------------------------------------------
// K1: the small-library neighbour count on ENV-G and ENV-F

interface FixtureMapping {
  roots: { id: string; title: string; family: string; nonconceptual: boolean }[];
}

async function stageSmallKnn(): Promise<void> {
  const pairs = await fixturePairs();
  if (!pairs) throw new Error("The ENV-F fixture pairs are required");
  const mapping = JSON.parse(
    await readFile(join(cacheRoot(), "golden", "matching-fixture", "mapping.json"), "utf8")
  ) as FixtureMapping;
  const fixtureLabel = new Map(
    mapping.roots.map((root) => [root.title, root.nonconceptual ? "work" : root.family])
  );
  for (const name of ["env-g", "env-f"] as const) {
    const data = await loadReplayDataset(name, { twins: false });
    const index = await readIndex(name);
    const titleOfSource = new Map(index.map((row) => [row.rootSourceId, row.rootTitle ?? ""]));
    const sources: LabelledSource[] = sourcesInOrder(data).map((source) => {
      const title = titleOfSource.get(source.id) ?? source.id;
      return {
        id: source.id,
        family: name === "env-g" ? envGFamily(title) : (fixtureLabel.get(title) ?? title),
        rows: source.rows
      };
    });
    const familyOfRow = new Map<number, string>();
    for (const source of sources)
      for (const row of source.rows) familyOfRow.set(row, source.family);
    for (const seed of seedsOf(calibrationSeeds)) {
      for (const k of listOf(values.values, "4,5,6,7,8,10")) {
        const config = topicTreeConfigWith({
          louvain: { smallLibraryKnn: k, smallLibraryMaxItems: 1000 }
        });
        const readings: {
          run: SmallKnnRow["run"];
          state: TopicTreeState;
          reachability: number;
          hard: number;
          fixture: FixtureReading | null;
        }[] = [];
        for (const calendar of ["session", "daily"] as const) {
          let grown: TopicTreeState | null = null;
          let fresh: TopicTreeState | null = null;
          const reading = sourceGrowthRun(data, {
            calendar,
            seed,
            config,
            detect: detectCommunitiesLouvain,
            ...(name === "env-f" ? { pairs } : {}),
            inspect: (g, f) => {
              grown = g;
              fresh = f;
            }
          });
          readings.push({
            run: calendar,
            state: grown!,
            reachability: reading.grown.reachability,
            hard: reading.grown.hardViolations,
            fixture: reading.fixture?.grown ?? null
          });
          if (calendar === "session") {
            readings.push({
              run: "fresh",
              state: fresh!,
              reachability: reading.fresh.reachability,
              hard: reading.fresh.hardViolations,
              fixture: reading.fixture?.fresh ?? null
            });
          }
        }
        for (const entry of readings) {
          const separation = sourceSeparation(
            entry.state,
            sources,
            defaultTopicTreeConfig.leaf.min
          );
          const row: SmallKnnRow & {
            leaves: number;
            absorbedSources: string[];
            labelPurity: number;
            forbiddenNotes: number | null;
          } = {
            dataset: name,
            run: entry.run,
            seed,
            k,
            reachability: entry.reachability,
            hardViolations: entry.hard,
            absorbed: name === "env-g" ? separation.absorbed.length : null,
            familyPurity: name === "env-g" ? separation.familyPurity : null,
            fixturePasses: entry.fixture ? entry.fixture.passes : null,
            forbidden: entry.fixture ? entry.fixture.forbidden.sameLeafOrSibling : null,
            expected: entry.fixture ? entry.fixture.expected.sameLeafOrSibling : null,
            forbiddenNotes: entry.fixture ? entry.fixture.forbidden.notePairsSameLeaf : null,
            leaves: separation.leaves,
            absorbedSources: separation.absorbed.map((id) => titleOfSource.get(id) ?? id),
            labelPurity: leafLabelPurity(entry.state, (row) => familyOfRow.get(row))
          };
          await appendRow(`rows-knn-${name}-${seed}.jsonl`, row);
          log(
            `${name} ${entry.run} seed ${seed} k ${k}: leaves ${row.leaves}, purity ${row.labelPurity}` +
              (name === "env-g"
                ? `, absorbed ${row.absorbed} (${row.absorbedSources.join("; ")})`
                : `, fixture ${row.fixturePasses} expected ${row.expected} forbidden ${row.forbidden}`)
          );
        }
      }
    }
  }
}

async function stageChooseKnn(): Promise<void> {
  const rows = await readRows<SmallKnnRow>("rows-knn-");
  const choice = chooseSmallKnn(rows);
  await writeJson("small-knn.json", choice);
  for (const entry of choice.table) {
    log(
      `k ${entry.k}: ${entry.eligible ? "eligible" : `not eligible (${entry.reasons.join(",")})`}, ENV-G absorbed ` +
        `${entry.absorbed}, family purity ${entry.medianFamilyPurity}, ENV-F forbidden ${JSON.stringify(entry.forbiddenMedian)}`
    );
  }
  log(`rule K1: smallLibraryKnn ${choice.chosen}`);
}

// ---------------------------------------------------------------------------
// K2: the threshold on DS-C article subsets, and its doubling guard

async function stageThreshold(): Promise<void> {
  const k = Number(values.k ?? "5");
  const corpus = await loadReplayDataset("corpus-notitle");
  for (const seed of seedsOf(calibrationSeeds)) {
    for (const size of listOf(values.values, "200,500,1000,2000")) {
      const subset = articleGrowthDataset(corpus, seed, size);
      const rows = subset.rows.map((_, row) => row);
      const keys = rows.map(rowItemKey);
      for (const neighbours of [k, 10]) {
        const config = topicTreeConfigWith({ louvain: { knn: neighbours } });
        const { state } = buildLouvain(subset.matrix, rows, {
          seed,
          config,
          detectCommunities: detectCommunitiesLouvain
        });
        const leaves = leafLabels(state, keys);
        const row: ThresholdRow & { rows: number } = {
          seed,
          size,
          rows: rows.length,
          k: neighbours,
          articlePurity: round(
            purity(
              leaves,
              Int32Array.from(rows, (r) => subset.labels.twin[r] as number)
            )
          ),
          domainPurity: round(
            purity(
              leaves,
              Int32Array.from(rows, (r) => subset.labels.domain[r] as number)
            )
          )
        };
        await appendRow(`rows-threshold-k${k}-${seed}.jsonl`, row);
        log(
          `threshold seed ${seed} size ${size} (${rows.length}) k ${neighbours}: article ${row.articlePurity}, domain ${row.domainPurity}`
        );
      }
    }
  }
  const all = await readRows<ThresholdRow>(`rows-threshold-k${k}-`);
  const choice = chooseThreshold(all, k);
  await writeJson(`threshold-k${k}.json`, choice);
  log(`rule K2: smallLibraryMaxItems ${choice.chosen} (${JSON.stringify(choice.table)})`);
}

async function stageDoubling(): Promise<void> {
  const k = Number(values.k ?? "5");
  const max = Number(values.max ?? "1000");
  const corpus = await loadReplayDataset("corpus-notitle", { twins: false });
  const results: Record<string, unknown>[] = [];
  for (const seed of seedsOf([7, 8, 9])) {
    const subset = articleGrowthDataset(corpus, seed, 1000);
    for (const variant of [
      { label: "off", config: defaultTopicTreeConfig },
      {
        label: `k${k}<=${max}`,
        config: topicTreeConfigWith({ louvain: { smallLibraryKnn: k, smallLibraryMaxItems: max } })
      }
    ]) {
      const reading = sourceGrowthRun(subset, {
        calendar: "daily",
        seed,
        config: variant.config,
        detect: detectCommunitiesLouvain
      });
      const row = {
        seed,
        variant: variant.label,
        rebuilds: reading.rebuilds.map((rebuild) => `${rebuild.trigger}@${rebuild.atRows}`),
        grown: reading.truth.grown?.leafDomainPurity ?? null,
        fresh: reading.truth.fresh?.leafDomainPurity ?? null,
        reachability: reading.grown.reachability,
        hardViolations: reading.grown.hardViolations
      };
      results.push(row);
      log(
        `doubling seed ${seed} ${variant.label}: grown ${row.grown} fresh ${row.fresh}, rebuilds ${row.rebuilds.join(" ")}`
      );
    }
  }
  const summary: Record<string, unknown> = {};
  for (const label of [...new Set(results.map((row) => row.variant as string))]) {
    const list = results.filter((row) => row.variant === label);
    const grown = median(list.map((row) => row.grown as number));
    const fresh = median(list.map((row) => row.fresh as number));
    summary[label] = {
      grown: round(grown),
      fresh: round(fresh),
      withinTwoPoints: fresh - grown <= 0.02
    };
  }
  await writeJson(`doubling-k${k}-${max}.json`, { results, summary });
  log(`doubling guard: ${JSON.stringify(summary)}`);
}

// ---------------------------------------------------------------------------
// D-H: homonyms in ENV-F

async function stageHomonyms(): Promise<void> {
  const data = await loadReplayDataset("env-f", { twins: false });
  const index = await readIndex("env-f");
  const mapping = JSON.parse(
    await readFile(join(cacheRoot(), "golden", "matching-fixture", "mapping.json"), "utf8")
  ) as FixtureMapping;
  const rootByTitle = new Map(mapping.roots.map((root) => [root.title, root]));
  const { matrix } = data;
  const info = data.rows.map((row, at) => {
    const root = rootByTitle.get(index[at]?.rootTitle ?? "");
    return {
      row: at,
      title: row.title,
      family: root?.family ?? "?",
      work: root?.nonconceptual ?? false,
      rootTitle: index[at]?.rootTitle ?? ""
    };
  });
  const cos = (a: number, b: number): number =>
    dot(
      matrix.data.subarray(a * matrix.dim, (a + 1) * matrix.dim),
      matrix.data.subarray(b * matrix.dim, (b + 1) * matrix.dim)
    );
  const mean = (list: readonly number[]): number =>
    list.length > 0 ? list.reduce((s, v) => s + v, 0) / list.length : 0;
  const works = info.filter((entry) => entry.work);
  const perWork = works.map((entry) => {
    const others = info.filter((other) => other.row !== entry.row);
    const family = others.filter((other) => !other.work && other.family === entry.family);
    const otherWorks = others.filter((other) => other.work && other.rootTitle !== entry.rootTitle);
    const unrelated = others.filter((other) => !other.work && other.family !== entry.family);
    const nearest = [...others]
      .sort((a, b) => cos(entry.row, b.row) - cos(entry.row, a.row))
      .slice(0, 5);
    return {
      root: entry.rootTitle,
      note: entry.title,
      family: entry.family,
      toFamily: round(mean(family.map((other) => cos(entry.row, other.row)))),
      toOtherWorks: round(mean(otherWorks.map((other) => cos(entry.row, other.row)))),
      toUnrelated: round(mean(unrelated.map((other) => cos(entry.row, other.row)))),
      nearestFamilyShare: round(
        nearest.filter((other) => !other.work && other.family === entry.family).length / 5
      ),
      nearestWorkShare: round(nearest.filter((other) => other.work).length / 5)
    };
  });
  const summary = {
    works: perWork.length,
    meanToFamily: round(mean(perWork.map((entry) => entry.toFamily))),
    meanToOtherWorks: round(mean(perWork.map((entry) => entry.toOtherWorks))),
    meanToUnrelated: round(mean(perWork.map((entry) => entry.toUnrelated))),
    closerToFamilyThanWorks: perWork.filter((entry) => entry.toFamily > entry.toOtherWorks).length,
    meanNearestFamilyShare: round(mean(perWork.map((entry) => entry.nearestFamilyShare))),
    meanNearestWorkShare: round(mean(perWork.map((entry) => entry.nearestWorkShare)))
  };
  await writeJson("homonyms.json", { summary, perWork });
  log(`homonyms: ${JSON.stringify(summary)}`);
}

async function main(): Promise<number> {
  switch (positionals[0]) {
    case "answers":
      await stageAnswers();
      return 0;
    case "root-target":
      await stageRootTarget();
      return 0;
    case "choose-root":
      await stageChooseRoot();
      return 0;
    case "small-knn":
      await stageSmallKnn();
      return 0;
    case "choose-knn":
      await stageChooseKnn();
      return 0;
    case "threshold":
      await stageThreshold();
      return 0;
    case "doubling":
      await stageDoubling();
      return 0;
    case "homonyms":
      await stageHomonyms();
      return 0;
    default:
      console.error(
        "Usage: calibrate-coherence.ts <answers|root-target|choose-root|small-knn|choose-knn|threshold|doubling|homonyms>"
      );
      return 2;
  }
}

if (process.argv[1]?.endsWith("calibrate-coherence.ts") ?? false) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    }
  );
}
