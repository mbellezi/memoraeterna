// The placement gate's offline proof (T23, D19): new articles held out of DS-C (whole articles
// with their pt/en twins, `growthSplit` "articles"), each held-out note decided against a frozen
// tree built on the rest, and every gated note put to the dedicated ranker with the gate's own
// texts (gate.ts: queries, descriptors, content-key order) and the D10 rule.
//
//   MEMORA_TOPICS_CACHE=<checkout>/.cache npx tsx scripts/topics/gate-proof.ts \
//     --runtime gguf --dataset corpus-notitle --share 0.1 --seeds 20261014,1,2 --names none,tfidf
//
// Reported per split: the gated and unadmitted shares of held-out notes, auto precision, and for
// gated notes the accepted and "none" shares, precision against the leaf's majority domain versus
// the margin-only baseline (the best admitted leaf), the ranker's own top-1 precision (its best
// candidate, whatever the D10 rule says), and the wall time of each fresh rank call
// (p50, p95). Scores are cached in `.cache/topics/gate-scores/<decider>.jsonl` of this checkout
// (or `--scores-dir`; gate-cache.ts), so a rerun ranks nothing it ranked before; the latency is
// measured on fresh calls only. The dataset is read from `MEMORA_TOPICS_CACHE` (datasets.ts).
//
// Texts follow ENV-C's notes (corpus-library.ts): the note title is the section name (empty for
// an introduction, so the article title never leaks), the idea the first sentence, the body the
// rest. Topics of an offline build have no LLM names: descriptors carry examples (central section
// titles) only (`none`), or the TF-IDF provisional name of the topic's majority language too
// (`tfidf`); each variant reuses the split's build. The product's topics carry LLM names.
//
// Runs one local model (the local-model slot, D35): it waits while another local-model job runs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
  decidePlacement,
  defaultTopicTreeConfig,
  gateCacheKeys,
  gateDeciderKey,
  gateDescriptor,
  gateNoteQuery,
  gateScores,
  leafTopics,
  provisionalNames,
  resolveGate,
  rowOfItemKey,
  rowView,
  subtreeItems
} from "@app/domain/topic-tree";
import type { FallbackText, ItemKey, TopicTreeState } from "@app/domain/topic-tree";

import { splitIdea } from "../../apps/desktop/src/main/services/topic-tree/corpus-library.js";
import { topicGateInstruction } from "../../apps/desktop/src/main/services/topic-tree/topic-prompts.js";
import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { GateScoreCache } from "./gate-cache.js";
import {
  assertSeedAllowed,
  cacheRoot,
  growthSplit,
  loadReplayDataset,
  repoRoot
} from "./datasets.js";
import type { ReplayDataset } from "./datasets.js";
import { majority, summarizeSplit } from "./gate-proof-core.js";
import type { GatedNote, SplitSummary } from "./gate-proof-core.js";

const { values } = parseArgs({
  options: {
    runtime: { type: "string", default: "gguf" },
    dataset: { type: "string", default: "corpus-notitle" },
    share: { type: "string", default: "0.1" },
    seeds: { type: "string", default: "20261014,1,2" },
    names: { type: "string", default: "none" },
    limit: { type: "string" },
    models: { type: "string" },
    report: { type: "string" },
    "scores-dir": { type: "string" }
  }
});
const runtime = values.runtime;
if (runtime !== "gguf" && runtime !== "mlx") throw new Error("--runtime is gguf or mlx");
const nameVariants = values.names.split(",");
for (const variant of nameVariants) {
  if (variant !== "none" && variant !== "tfidf") throw new Error("--names lists none or tfidf");
}
const share = Number(values.share);
const seeds = values.seeds.split(",").map(Number);
for (const seed of seeds) assertSeedAllowed(seed, "evaluation");
const limit = values.limit === undefined ? Number.POSITIVE_INFINITY : Number(values.limit);
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const config = defaultTopicTreeConfig;

// The checkout holding the models and the MLX helper (a worktree points at the main checkout).
const modelsRoot = resolve(values.models ?? join(cacheRoot(), ".."));
const catalogId = runtime === "mlx" ? "mlx-qwen3-reranker-0.6b" : "gguf-qwen3-reranker-0.6b-q8-0";
const entry = findLocalModelCatalogEntry(catalogId);
if (!entry) throw new Error(`No catalog entry ${catalogId}`);
const modelPath =
  runtime === "mlx"
    ? join(modelsRoot, ".cache/models/qwen3-reranker-0.6b-mlx")
    : join(modelsRoot, ".cache/models/qwen3-reranker-0.6b-q8_0-gguf/qwen3-reranker-0.6b-q8_0.gguf");
const adapterOptions = {
  modelId: entry.id,
  modelPath,
  capabilities: [...entry.capabilities],
  repository: entry.repository,
  revision: entry.revision,
  quantization: entry.quantization,
  catalogId: entry.id
};

/** Local inference runs one model at a time: wait until no other local-model job runs. */
async function waitForLocalModelSlot(): Promise<void> {
  const job = /memora-mlx-helper|node-llama-cpp|scripts\/spikes\/.*(score|embed)/u;
  for (;;) {
    const others = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((line) => job.test(line) && !line.includes("grep"))
      .filter((line) => !line.trim().startsWith(`${process.pid} `));
    if (others.length === 0) return;
    console.info(`Waiting for other local-model jobs:\n  ${others.join("\n  ")}`);
    await new Promise((done) => setTimeout(done, 30_000));
  }
}

/**
 * ENV-C's note text for a row: the section title (none for an introduction, whose DS-C title is
 * the article's), the first sentence, the rest. An app export's titles are kept as they are.
 */
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

/** TF-IDF provisional names of the leaves, each in its members' majority language. */
function tfidfNames(dataset: ReplayDataset, state: TopicTreeState): Map<string, string> {
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

interface SplitReport extends SplitSummary {
  seed: number;
  names: string;
  base: number;
  buildMs: number;
  /** Gated notes whose scores all came from the gate-score cache. */
  cachedNotes: number;
  inputTokens: number;
  /** Examples of gated notes (query, documents, log-odds, outcome), for reading. */
  samples: unknown[];
}

async function main(): Promise<void> {
  const dataset = await loadReplayDataset(values.dataset);
  console.info(
    `${dataset.name}: ${dataset.rows.length} rows, dim ${dataset.matrix.dim}; ` +
      `ranker ${runtime}; held-out share ${share}; seeds ${seeds.join(", ")}; ` +
      `names ${nameVariants.join(", ")}`
  );
  const instruction = topicGateInstruction();
  const deciderKey = gateDeciderKey(
    {
      runtime,
      repository: entry!.repository,
      revision: entry!.revision,
      quantization: entry!.quantization,
      instruction
    },
    sha
  );
  const cache = await GateScoreCache.open(
    resolve(values["scores-dir"] ?? join(repoRoot, ".cache", "topics", "gate-scores")),
    deciderKey
  );
  const loaded: { adapter: (AiModelAdapter & { dispose?: () => Promise<void> }) | null } = {
    adapter: null
  };
  const ranker = async () => {
    if (loaded.adapter) return loaded.adapter;
    await waitForLocalModelSlot();
    loaded.adapter =
      runtime === "mlx"
        ? new MlxRerankerAdapter({
            ...adapterOptions,
            helperPath: join(modelsRoot, "native/mlx-helper/.build/release/memora-mlx-helper")
          })
        : new NodeLlamaRankerAdapter(adapterOptions);
    return loaded.adapter;
  };

  const splits: SplitReport[] = [];
  try {
    for (const seed of seeds) {
      const split = growthSplit(dataset, "articles", share, seed);
      const built = performance.now();
      const build = buildLouvain(dataset.matrix, split.base, {
        seed,
        config,
        detectCommunities: detectCommunitiesLouvain
      });
      const buildMs = Math.round(performance.now() - built);
      const { state, vectors } = build;
      const domainOf = (row: number) => dataset.rows[row]!.domain;
      const leafDomain = new Map<string, string | null>();
      const majorityDomain = (topicId: string): string | null => {
        if (!leafDomain.has(topicId)) {
          leafDomain.set(
            topicId,
            majority(
              subtreeItems(state, topicId).flatMap((key) => {
                const row = rowOfItemKey(key);
                return row === undefined ? [] : [domainOf(row)];
              })
            )
          );
        }
        return leafDomain.get(topicId) ?? null;
      };
      const titleOf = (key: ItemKey) => {
        const row = rowOfItemKey(key);
        return row === undefined ? "" : noteText(dataset, row).title;
      };
      for (const names of nameVariants) {
        const leafNames =
          names === "tfidf" ? tfidfNames(dataset, state) : new Map<string, string>();
        let auto = 0;
        let autoCorrect = 0;
        let unadmitted = 0;
        let inputTokens = 0;
        let gatedTotal = 0;
        let cachedNotes = 0;
        const gated: GatedNote[] = [];
        const samples: unknown[] = [];
        const tail = [...split.tail].sort((a, b) => a - b);
        for (const row of tail) {
          const decision = decidePlacement(state, config, rowView(dataset.matrix, row));
          if (decision.kind === "unadmitted") {
            unadmitted += 1;
            continue;
          }
          if (decision.kind === "auto") {
            auto += 1;
            if (majorityDomain(decision.topicId) === domainOf(row)) autoCorrect += 1;
            continue;
          }
          gatedTotal += 1;
          if (gated.length >= limit) continue;
          const query = gateNoteQuery(noteText(dataset, row), config.gate);
          const keys = gateCacheKeys(
            query,
            decision.candidates.map((candidate) => ({
              topicId: candidate.topicId,
              descriptor: gateDescriptor(
                {
                  title: leafNames.get(candidate.topicId) ?? null,
                  description: null,
                  aliases: [],
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
          const scoring = keys.candidates.filter((candidate) => candidate.descriptor !== null);
          let rankMs: number | null = null;
          let truncated = 0;
          const cached = scoring.map((candidate) =>
            cache.has(keys.itemHash, candidate.descriptorHash)
              ? cache.get(keys.itemHash, candidate.descriptorHash)!
              : null
          );
          let logOdds: (number | null)[];
          if (scoring.length > 0 && cached.some((score) => score === null)) {
            const request = {
              instruction,
              query,
              documents: scoring.map((candidate) => candidate.descriptor as string)
            };
            const started = performance.now();
            const result = readRankResult(
              await (await ranker()).run(rankTaskRequest(request)),
              request.documents.length
            );
            rankMs = performance.now() - started;
            inputTokens += result.tokenCounts.reduce((sum, count) => sum + count, 0);
            scoring.forEach((candidate, index) => {
              cache.set({
                noteHash: keys.itemHash,
                descriptorHash: candidate.descriptorHash,
                logOdds: result.logOdds[index]!,
                truncated: result.truncated[index] === true
              });
              if (result.truncated[index]) truncated += 1;
            });
            logOdds = [...result.logOdds];
            if (gated.length % 50 === 0) await cache.flush();
          } else {
            cachedNotes += 1;
            logOdds = cached.map((score) => score?.logOdds ?? null);
            truncated = cached.filter((score) => score?.truncated === true).length;
          }
          const scoreOf = new Map(
            scoring.map((candidate, index) => [candidate.topicId, logOdds[index]])
          );
          const resolution = resolveGate(
            gateScores(
              keys.candidates.map((candidate) => ({
                topicId: candidate.topicId,
                logOdds: scoreOf.get(candidate.topicId) ?? null
              }))
            ),
            config.gate
          );
          const chosen = resolution.kind === "accept" ? resolution.topicId : null;
          let top: string | null = null;
          for (const candidate of scoring) {
            const value = scoreOf.get(candidate.topicId);
            if (value === null || value === undefined) continue;
            if (top === null || value > (scoreOf.get(top) as number)) top = candidate.topicId;
          }
          gated.push({
            domain: domainOf(row),
            bestDomain: majorityDomain(decision.best.topicId),
            chosenDomain: chosen === null ? null : majorityDomain(chosen),
            topDomain: top === null ? null : majorityDomain(top),
            rankMs,
            truncated
          });
          if (samples.length < 8 && gated.length % 25 === 1) {
            samples.push({
              domain: domainOf(row),
              query,
              documents: keys.candidates.map((candidate) => ({
                descriptor: candidate.descriptor,
                majorityDomain: majorityDomain(candidate.topicId),
                logOdds: scoreOf.get(candidate.topicId) ?? null,
                best: candidate.topicId === decision.best.topicId
              })),
              outcome: resolution.kind,
              probability: Math.round(resolution.probability * 1000) / 1000,
              noneProbability: Math.round(resolution.noneProbability * 1000) / 1000
            });
          }
          if (gated.length % 100 === 0) {
            console.info(`  seed ${seed} (${names}): ${gated.length} gated notes decided`);
          }
        }
        await cache.flush();
        const summary = summarizeSplit({
          holdout: tail.length,
          auto,
          autoCorrect,
          unadmitted,
          gatedTotal,
          gated
        });
        const report: SplitReport = {
          seed,
          names,
          base: split.base.length,
          buildMs,
          ...summary,
          cachedNotes,
          inputTokens,
          samples
        };
        splits.push(report);
        console.info(JSON.stringify({ ...report, samples: undefined }, null, 2));
      }
    }
  } finally {
    await cache.flush();
    await loaded.adapter?.dispose?.();
  }

  const output = {
    createdAt: new Date().toISOString(),
    dataset: dataset.name,
    runtime,
    catalogId,
    deciderKey,
    names: nameVariants,
    share,
    config: { placement: config.placement, gate: config.gate },
    splits
  };
  const path = resolve(
    values.report ??
      join(repoRoot, ".cache", "topics", "reports", `gate-proof-${dataset.name}-${runtime}.json`)
  );
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`);
  console.info(`Report: ${path}`);
}

await main();
