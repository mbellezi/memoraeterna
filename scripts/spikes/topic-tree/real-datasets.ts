// Labelled real datasets for Spike B: the vector stores of embed-real.ts as
// LabelledDataset values, plus the mixed library (benchmark + owner + a seeded
// 3k sample of the public corpus).
//
// Datasets: corpus (pseudo-notes embedded with "Article - Section" titles), corpus-notitle
// (the same notes embedded without the article-title prefix), benchmark, owner, mixed.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readStore, spikeDir } from "./real-data.js";
import type { VectorStore } from "./real-data.js";
import type { LabelledDataset } from "./real-eval.js";
import { createRng, deriveSeed } from "./rng.js";
import { createMatrix } from "./vectors.js";

/** Seed of every Spike B real-data experiment. */
export const seed = 20261014;

// ---------------------------------------------------------------------------
// pt/en twins: the public corpus holds Portuguese and English articles on the same topic
// (about half of the Portuguese titles mirror English ones). A holdout that leaves one
// language in the base tree and the other out would still leak, so twins are held out
// together.

/** Minimum cosine between article centroids to call a cross-language pair twins. */
export const twinThreshold = 0.6;

export interface TwinPair {
  domain: string;
  en: string;
  pt: string;
  cosine: number;
}

/**
 * Twin articles by embedding: within each domain, pt and en article centroids are paired
 * one-to-one by decreasing cosine and kept at or above `twinThreshold`. Checked by title on
 * the corpus: pairs at 0.65 and above are mirrors or the same subject seen from a Brazilian
 * angle (Baroque - Barroco no Brasil); unrelated pairs start near 0.5; two true mirrors fall
 * under the threshold (Screenplay - Roteiro 0.58, Short story - Conto 0.57), a small residual
 * leak. Over-grouping (related topics) only makes the holdout harsher.
 */
export function twinPairs(store: VectorStore): TwinPair[] {
  const dim = store.meta.dim;
  const articles = new Map<
    string,
    { lang: string; domain: string; title: string; sum: Float64Array }
  >();
  store.rows.forEach((row, index) => {
    let article = articles.get(row.group);
    if (!article) {
      article = {
        lang: row.lang,
        domain: row.domain,
        title: row.group.split(":").slice(1).join(":"),
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
  for (const domain of [...new Set([...articles.values()].map((article) => article.domain))]) {
    const inDomain = [...articles.values()].filter((article) => article.domain === domain);
    const candidates: TwinPair[] = [];
    for (const en of inDomain.filter((article) => article.lang === "en")) {
      for (const pt of inDomain.filter((article) => article.lang === "pt")) {
        let cosine = 0;
        for (let d = 0; d < dim; d += 1) cosine += (en.sum[d] as number) * (pt.sum[d] as number);
        candidates.push({ domain, en: en.title, pt: pt.title, cosine });
      }
    }
    candidates.sort((a, b) => b.cosine - a.cosine || a.en.localeCompare(b.en));
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

/** Row group ("lang:article") -> twin key; cached under .cache/spikes/topic-tree/twins.json. */
export async function loadTwinMap(): Promise<Map<string, string>> {
  const path = join(spikeDir, "twins.json");
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as {
      threshold: number;
      keys: Record<string, string>;
    };
    if (cached.threshold === twinThreshold) return new Map(Object.entries(cached.keys));
  } catch {
    // Computed below.
  }
  const store = await readStore("corpus");
  if (!store) return new Map();
  const pairs = twinPairs(store);
  const keys: Record<string, string> = {};
  for (const pair of pairs) {
    keys[`en:${pair.en}`] = `twin:${pair.domain}:${pair.en}`;
    keys[`pt:${pair.pt}`] = `twin:${pair.domain}:${pair.en}`;
  }
  await mkdir(spikeDir, { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ threshold: twinThreshold, pairs, keys }, null, 2)}\n`,
    "utf8"
  );
  return new Map(Object.entries(keys));
}

/** Concatenates stores into one labelled dataset (row order = store order). */
export function labelled(
  name: string,
  parts: { store: VectorStore; rows?: number[] }[],
  twins: ReadonlyMap<string, string> = new Map()
): LabelledDataset {
  const selected = parts.map(({ store, rows }) => ({
    store,
    rows: rows ?? store.rows.map((_, index) => index)
  }));
  const count = selected.reduce((total, part) => total + part.rows.length, 0);
  const dim = selected[0]?.store.meta.dim ?? 1024;
  const matrix = createMatrix(count, dim);
  const data: LabelledDataset = {
    name,
    matrix,
    items: [],
    lang: [],
    domain: [],
    group: [],
    twin: [],
    title: [],
    text: [],
    dataset: [],
    order: []
  };
  let orderOffset = 0;
  for (const { store, rows } of selected) {
    for (const row of rows) {
      const meta = store.rows[row];
      if (!meta) throw new Error(`Missing row ${row} in ${store.meta.dataset}`);
      const index = data.items.length;
      matrix.data.set(store.matrix.data.subarray(row * dim, (row + 1) * dim), index * dim);
      data.items.push(index);
      data.lang.push(meta.lang);
      data.domain.push(parts.length > 1 ? `${meta.dataset}:${meta.domain}` : meta.domain);
      data.group.push(`${meta.dataset}:${meta.group}`);
      data.twin.push(
        meta.dataset === "corpus"
          ? (twins.get(meta.group) ?? `${meta.dataset}:${meta.group}`)
          : `${meta.dataset}:${meta.group}`
      );
      data.title.push(meta.title);
      data.text.push(meta.text);
      data.dataset.push(meta.dataset);
      data.order.push(orderOffset + meta.order);
    }
    orderOffset += store.rows.length;
  }
  return data;
}

/**
 * Mixed: benchmark + owner + a seeded 3k sample of the corpus, interleaved by a fixed order.
 * The corpus part comes from the title-stripped store when it exists, so the sample does
 * not share article-title prefixes.
 */
export async function loadDatasets(names: Set<string>): Promise<Map<string, LabelledDataset>> {
  const stores = new Map<string, VectorStore>();
  for (const name of ["corpus", "corpus-notitle", "benchmark", "owner"]) {
    const store = await readStore(name);
    if (store) stores.set(name, store);
  }
  const twins = await loadTwinMap();
  const output = new Map<string, LabelledDataset>();
  for (const name of ["corpus", "corpus-notitle", "benchmark", "owner"]) {
    const store = stores.get(name);
    if (names.has(name) && store) output.set(name, labelled(name, [{ store }], twins));
  }
  const corpus = stores.get("corpus-notitle") ?? stores.get("corpus");
  if (names.has("mixed") && corpus) {
    const sample = createRng(deriveSeed(seed, "mixed-sample"))
      .shuffle(corpus.rows.map((_, index) => index))
      .slice(0, 3000)
      .sort((a, b) => a - b);
    const parts: { store: VectorStore; rows?: number[] }[] = [{ store: corpus, rows: sample }];
    for (const name of ["benchmark", "owner"]) {
      const store = stores.get(name);
      if (store) parts.push({ store });
    }
    const mixed = labelled("mixed", parts, twins);
    // Chronology for the mixed library: the three sources interleaved at random.
    const order = createRng(deriveSeed(seed, "mixed-order")).shuffle([...mixed.items]);
    order.forEach((item, rank) => {
      mixed.order[item] = rank;
    });
    output.set("mixed", mixed);
  }
  return output;
}
