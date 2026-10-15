// Measures the no-LLM naming of the Topic Tree Engine on a labelled replay dataset (F2 T18):
//
//   npx tsx scripts/topics/naming-proof.ts --dataset corpus-notitle --language pt-BR [--seed 20261014]
//     [--out <file.json>]
//
// 1. The stopword language guess against the dataset's own language labels.
// 2. The Louvain tree of the dataset (T09, the build that Spike B measured), and the TF-IDF
//    provisional name of every topic in the content language: how many topics are named, how many
//    stay unnamed and why, sibling duplicates (0 expected), and how many names use a word that
//    belongs to the other language (0 expected: only content-language notes name a topic).
//
// The dataset is a replay store (`.cache/spikes/topic-tree/vectors` or `.cache/topics/vectors`,
// `MEMORA_TOPICS_CACHE` points a worktree at the main checkout's cache). Nothing is written but
// `--out`; no model, database or network is used.
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  buildLouvain,
  defaultTopicTreeConfig,
  foldTerm,
  guessLanguage,
  isLive,
  liveTopicIds,
  normalizeTopicTitle,
  provisionalNames,
  rowItemKey,
  topicNamingLanguageOf,
  walkTopics
} from "@app/domain/topic-tree";
import type { FallbackText, ItemKey, TopicNamingLanguage } from "@app/domain/topic-tree";

import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { loadReplayDataset } from "./datasets.js";

const termSplit = /[^\p{L}\p{N}-]+/u;
const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

export interface LanguageGuessReport {
  notes: number;
  /** Per dataset label: how many notes, and what the guess made of them. */
  byLabel: Record<
    string,
    { notes: number; agree: number; noGuess: number; other: Record<string, number> }
  >;
  agreement: number;
}

/** The stopword guess against the language labels of a dataset's rows. */
export function languageGuessReport(
  rows: ReadonlyArray<{ lang: string; text: string; title: string }>,
  labelToLanguage: (label: string) => TopicNamingLanguage | null
): LanguageGuessReport {
  const byLabel: LanguageGuessReport["byLabel"] = {};
  let agree = 0;
  let judged = 0;
  for (const row of rows) {
    const entry = (byLabel[row.lang] ??= { notes: 0, agree: 0, noGuess: 0, other: {} });
    entry.notes += 1;
    const expected = labelToLanguage(row.lang);
    const guess = guessLanguage(`${row.title}. ${row.text}`).language;
    if (guess === null) entry.noGuess += 1;
    else if (guess === expected) entry.agree += 1;
    else entry.other[guess] = (entry.other[guess] ?? 0) + 1;
    if (expected !== null) {
      judged += 1;
      if (guess === expected) agree += 1;
    }
  }
  return { notes: rows.length, byLabel, agreement: judged === 0 ? 0 : round(agree / judged) };
}

export interface NamingProofReport {
  dataset: string;
  contentLanguage: string;
  seed: number;
  language: LanguageGuessReport;
  tree: { topics: number; leaves: number; maxDepth: number };
  naming: {
    named: number;
    unnamed: number;
    namedShare: number;
    unnamedReasons: Record<string, number>;
    /** Sibling topics whose provisional titles collide, accent- and case-insensitively. */
    siblingDuplicates: number;
    /** Topics with at least one note outside the content language. */
    mixedTopics: number;
    /** Named topics with a word that belongs to the other language. */
    namesWithForeignWord: number;
    meanTerms: number;
  };
  /**
   * The same names with every note treated as written in the content language, which is what
   * naming without the content-language rule does (owner feedback on Spike B: mixed names).
   */
  withoutTheRule: { named: number; namesWithForeignWord: number; foreignShare: number };
  examples: Array<{ title: string; items: number }>;
}

export async function namingProof(options: {
  dataset: string;
  contentLanguage: string;
  seed: number;
}): Promise<NamingProofReport> {
  const dataset = await loadReplayDataset(options.dataset, { twins: false });
  const config = defaultTopicTreeConfig;
  const content = topicNamingLanguageOf(options.contentLanguage);
  const labelLanguage = (label: string): TopicNamingLanguage | null => topicNamingLanguageOf(label);
  const language = languageGuessReport(dataset.rows, labelLanguage);

  const rows = Array.from({ length: dataset.rows.length }, (_, row) => row);
  const built = buildLouvain(dataset.matrix, rows, {
    seed: options.seed,
    config,
    detectCommunities: detectCommunitiesLouvain
  });
  const { state } = built;
  const texts = new Map<ItemKey, FallbackText>();
  const documentFrequency = new Map<string, Map<string, number>>();
  for (const [index, row] of dataset.rows.entries()) {
    texts.set(rowItemKey(index), { text: `${row.title}. ${row.text}`, language: row.lang });
    const seen = new Set<string>();
    for (const token of `${row.title} ${row.text}`.split(termSplit)) {
      const term = foldTerm(token.replace(/^-+|-+$/gu, ""));
      if (term.length >= 3 && !seen.has(term)) seen.add(term);
    }
    for (const term of seen) {
      const counts = documentFrequency.get(term) ?? new Map<string, number>();
      counts.set(row.lang, (counts.get(row.lang) ?? 0) + 1);
      documentFrequency.set(term, counts);
    }
  }

  const targets = liveTopicIds(state).filter((id) => id !== state.rootId);
  const { names, skipped } = provisionalNames(state, targets, texts, {
    contentLanguage: options.contentLanguage,
    minItems: config.naming.fallbackMinItems,
    maxTerms: config.naming.fallbackMaxTerms
  });

  let leaves = 0;
  let maxDepth = 0;
  walkTopics(state, (node, depth) => {
    if (node.children.length === 0 && node.id !== state.rootId) leaves += 1;
    maxDepth = Math.max(maxDepth, depth);
  });

  // A word is foreign when most notes that use it carry another language label.
  const isForeign = (term: string): boolean => {
    const counts = documentFrequency.get(foldTerm(term));
    if (!counts || content === null) return false;
    let own = 0;
    let total = 0;
    for (const [label, count] of counts) {
      total += count;
      if (topicNamingLanguageOf(label) === content) own += count;
    }
    return total > 0 && own / total < 0.2;
  };
  let withForeign = 0;
  let termCount = 0;
  for (const name of names.values()) {
    termCount += name.terms.length;
    if (name.terms.some(isForeign)) withForeign += 1;
  }
  const reasons: Record<string, number> = {};
  for (const reason of skipped.values()) reasons[reason] = (reasons[reason] ?? 0) + 1;
  let mixedTopics = 0;
  for (const id of targets) {
    const node = state.topics.get(id);
    if (!node || !isLive(node)) continue;
    const items: ItemKey[] = [];
    const collect = (topicId: string): void => {
      const child = state.topics.get(topicId);
      if (!child) return;
      items.push(...child.items);
      for (const next of child.children) collect(next);
    };
    collect(id);
    if (items.some((key) => topicNamingLanguageOf(texts.get(key)?.language) !== content)) {
      mixedTopics += 1;
    }
  }
  // Titles of siblings under one parent, compared the way I7 compares them.
  let duplicates = 0;
  for (const id of liveTopicIds(state)) {
    const seen = new Set<string>();
    for (const childId of state.topics.get(id)?.children ?? []) {
      const title = names.get(childId)?.title;
      if (title === undefined) continue;
      const key = normalizeTopicTitle(title);
      if (seen.has(key)) duplicates += 1;
      seen.add(key);
    }
  }
  const unfilteredTexts = new Map<ItemKey, FallbackText>();
  for (const [key, text] of texts) {
    unfilteredTexts.set(key, { text: text.text, language: options.contentLanguage });
  }
  const unfiltered = provisionalNames(state, targets, unfilteredTexts, {
    contentLanguage: options.contentLanguage,
    minItems: config.naming.fallbackMinItems,
    maxTerms: config.naming.fallbackMaxTerms
  });
  const unfilteredForeign = [...unfiltered.names.values()].filter((name) =>
    name.terms.some(isForeign)
  ).length;
  const examples = [...names.values()].slice(0, 12).map((name) => ({
    title: name.title,
    items: state.topics.get(name.topicId)?.stats.n ?? 0
  }));
  return {
    dataset: options.dataset,
    contentLanguage: options.contentLanguage,
    seed: options.seed,
    language,
    tree: { topics: targets.length, leaves, maxDepth },
    naming: {
      named: names.size,
      unnamed: skipped.size,
      namedShare: round(names.size / Math.max(1, targets.length)),
      unnamedReasons: reasons,
      siblingDuplicates: duplicates,
      mixedTopics,
      namesWithForeignWord: withForeign,
      meanTerms: round(termCount / Math.max(1, names.size), 2)
    },
    withoutTheRule: {
      named: unfiltered.names.size,
      namesWithForeignWord: unfilteredForeign,
      foreignShare: round(unfilteredForeign / Math.max(1, unfiltered.names.size))
    },
    examples
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string", default: "corpus-notitle" },
      language: { type: "string", default: "pt-BR" },
      seed: { type: "string", default: "20261014" },
      out: { type: "string" }
    }
  });
  const report = await namingProof({
    dataset: values.dataset as string,
    contentLanguage: values.language as string,
    seed: Number(values.seed)
  });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) await writeFile(values.out, text);
  process.stdout.write(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
