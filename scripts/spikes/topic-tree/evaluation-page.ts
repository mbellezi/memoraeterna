// Owner evaluation page for Spike B: a collapsible browser of the chosen build of
// the public corpus (and of the owner's pseudo-notes), with provisional TF-IDF
// names, counts and 5 central member titles per topic, plus 30 topics sampled
// with a fixed seed across levels to rate as "coerente" / "bem nomeado".
//
//   npx tsx scripts/spikes/topic-tree/evaluation-page.ts [--builder louvain]
//
// Writes .cache/spikes/topic-tree/avaliacao.html (self-contained, Portuguese UI)
// and avaliacao-key.json (truth composition of the sampled topics, not shown on
// the page).
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildTree } from "./builders.js";
import type { BuilderName } from "./builders.js";
import { defaultTreeConfig } from "./config.js";
import { nameTopics } from "./naming.js";
import type { TopicName } from "./naming.js";
import { spikeDir } from "./real-data.js";
import { loadDatasets, seed } from "./real-datasets.js";
import type { LabelledDataset } from "./real-eval.js";
import { createRng, deriveSeed } from "./rng.js";
import { coherenceOf } from "./tree.js";
import type { TopicTree } from "./tree.js";
import { dotRowVec } from "./vectors.js";

const args = process.argv.slice(2);
const builderArg = args[args.indexOf("--builder") + 1];
const builder = (args.includes("--builder") ? builderArg : "louvain") as BuilderName;
if (!["top-down", "bottom-up", "louvain"].includes(builder)) {
  throw new Error(`Unknown builder ${String(builderArg)}`);
}
const config = defaultTreeConfig;
const sampleSize = 30;
const ownerSlots = 3;
/** Public topics per depth (deeper levels fill any shortfall). */
const depthQuota = [0, 4, 6, 8, 9];

interface PageMember {
  t: string;
  s: string;
}

interface PageNode {
  id: number;
  p: number | null;
  d: number;
  n: number;
  name: string;
  path: string;
  coh: number;
  c: number[];
  leaf: boolean;
  central: PageMember[];
}

interface PageSample {
  key: string;
  source: "corpus" | "owner";
  topicId: number;
  depth: number;
  kind: "folha" | "interno";
  n: number;
  name: string;
  path: string;
  members: PageMember[];
}

const snippet = (text: string, limit = 180): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, flat.lastIndexOf(" ", limit - 1))}…`;
};

function member(data: LabelledDataset, item: number): PageMember {
  let title = data.title[item] ?? "";
  // Owner pseudo-notes repeat their (long) document title; show the section only.
  const documentTitle = (data.group[item] ?? "").replace(/^owner:/, "");
  if (data.dataset[item] === "owner" && title.startsWith(`${documentTitle} — `)) {
    title = title.slice(documentTitle.length + 3);
  }
  return { t: title, s: snippet(data.text[item] ?? "") };
}

function centralMembers(
  tree: TopicTree,
  data: LabelledDataset,
  nodeId: number,
  count: number
): number[] {
  const node = tree.node(nodeId);
  return tree
    .subtreeItems(nodeId)
    .map((item) => ({ item, cos: dotRowVec(data.matrix, item, node.centroid) }))
    .sort((a, b) => b.cos - a.cos || a.item - b.item)
    .slice(0, count)
    .map((entry) => entry.item);
}

function pageTree(
  tree: TopicTree,
  data: LabelledDataset,
  names: Map<number, TopicName>
): PageNode[] {
  const nodes: PageNode[] = [];
  tree.walk((node, depth) => {
    const name = names.get(node.id);
    nodes.push({
      id: node.id,
      p: node.parent,
      d: depth,
      n: node.n,
      name: node.id === tree.rootId ? "Tópicos" : (name?.label ?? "(sem nome)"),
      path: name?.path ?? "",
      coh: Number(coherenceOf(node).toFixed(3)),
      c: [...node.children],
      leaf: node.children.length === 0,
      central: centralMembers(tree, data, node.id, 5).map((item) => member(data, item))
    });
  });
  return nodes;
}

function sampleTopics(
  tree: TopicTree,
  data: LabelledDataset,
  names: Map<number, TopicName>,
  source: "corpus" | "owner",
  quota: number[],
  total: number,
  label: string
): PageSample[] {
  const rng = createRng(deriveSeed(seed, `sample:${label}`));
  const byDepth = new Map<number, number[]>();
  tree.walk((node, depth) => {
    if (node.id === tree.rootId || node.n < config.leaf.min) return;
    const bucket = Math.min(depth, quota.length - 1);
    const ids = byDepth.get(bucket) ?? [];
    ids.push(node.id);
    byDepth.set(bucket, ids);
  });
  const chosen: { id: number; depth: number }[] = [];
  let carry = 0;
  for (let depth = 1; depth < quota.length; depth += 1) {
    const wanted = (quota[depth] ?? 0) + carry;
    const pool = rng.shuffle([...(byDepth.get(depth) ?? [])]);
    const taken = pool.slice(0, wanted);
    for (const id of taken) chosen.push({ id, depth: tree.depthOf(id) });
    carry = wanted - taken.length;
  }
  return chosen.slice(0, total).map(({ id, depth }) => {
    const node = tree.node(id);
    const members = rng.shuffle(tree.subtreeItems(id)).slice(0, 8);
    const name = names.get(id);
    return {
      key: `${source}:${id}`,
      source,
      topicId: id,
      depth,
      kind: node.children.length === 0 ? "folha" : "interno",
      n: node.n,
      name: name?.label ?? "(sem nome)",
      path: name?.path ?? "",
      members: members.map((item) => member(data, item))
    };
  });
}

function composition(tree: TopicTree, data: LabelledDataset, nodeId: number) {
  const items = tree.subtreeItems(nodeId);
  const count = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  };
  const domains = count(items.map((item) => data.domain[item] ?? ""));
  return {
    n: items.length,
    domainPurity: items.length > 0 ? (domains[0]?.[1] ?? 0) / items.length : 0,
    domains,
    groups: count(items.map((item) => data.group[item] ?? "")),
    languages: count(items.map((item) => data.lang[item] ?? ""))
  };
}

const datasets = await loadDatasets(new Set(["corpus", "owner"]));
const corpus = datasets.get("corpus");
if (!corpus) throw new Error("No corpus vectors; run embed-real.ts first");
const owner = datasets.get("owner");
const inputOf = (data: LabelledDataset) => (item: number) => ({
  text: `${data.title[item] ?? ""}\n${data.text[item] ?? ""}`,
  lang: (data.lang[item] === "en" ? "en" : "pt") as "pt" | "en"
});

console.log(`Building ${builder} over ${corpus.items.length} corpus items…`);
const corpusTree = buildTree(builder, corpus.matrix, corpus.items, { seed, config }).tree;
const corpusNames = nameTopics(corpusTree, inputOf(corpus));
const ownerTree =
  owner && owner.items.length >= 12
    ? buildTree(builder, owner.matrix, owner.items, { seed, config }).tree
    : null;
const ownerNames = ownerTree && owner ? nameTopics(ownerTree, inputOf(owner)) : null;

const ownerSamples =
  ownerTree && owner && ownerNames
    ? sampleTopics(ownerTree, owner, ownerNames, "owner", [0, ownerSlots], ownerSlots, "owner")
    : [];
const publicSamples = sampleTopics(
  corpusTree,
  corpus,
  corpusNames,
  "corpus",
  depthQuota,
  sampleSize - ownerSamples.length,
  "corpus"
);
// Interleave owner topics at fixed positions so they are not all at the end.
const samples: PageSample[] = [...publicSamples];
ownerSamples.forEach((sample, index) => {
  samples.splice(Math.min(samples.length, 7 + index * 9), 0, sample);
});

const generatedAt = new Date().toISOString();
const pageId = createHash("sha256")
  .update(JSON.stringify({ builder, seed, keys: samples.map((sample) => sample.key) }))
  .digest("hex")
  .slice(0, 12);
const pageData = {
  pageId,
  builder,
  seed,
  generatedAt,
  model: "Qwen3-Embedding-0.6B (MLX, native/mlx-helper)",
  corpus: {
    items: corpus.items.length,
    pt: corpus.lang.filter((lang) => lang === "pt").length,
    en: corpus.lang.filter((lang) => lang === "en").length,
    domains: new Set(corpus.domain).size,
    nodes: pageTree(corpusTree, corpus, corpusNames)
  },
  owner:
    ownerTree && owner && ownerNames
      ? { items: owner.items.length, nodes: pageTree(ownerTree, owner, ownerNames) }
      : null,
  samples
};

const key = samples.map((sample, index) => ({
  position: index + 1,
  key: sample.key,
  depth: sample.depth,
  kind: sample.kind,
  name: sample.name,
  ...composition(
    sample.source === "owner" && ownerTree ? ownerTree : corpusTree,
    sample.source === "owner" && owner ? owner : corpus,
    sample.topicId
  )
}));
await writeFile(
  join(spikeDir, "avaliacao-key.json"),
  `${JSON.stringify({ pageId, builder, seed, generatedAt, samples: key }, null, 2)}\n`,
  "utf8"
);

const template = await readFile(join(import.meta.dirname, "evaluation-page.html"), "utf8");
const json = JSON.stringify(pageData).replace(/</g, "\\u003c");
const html = template.replace("__PAGE_DATA__", () => json);
const outputPath = join(spikeDir, "avaliacao.html");
await writeFile(outputPath, html, "utf8");
const purity = key.filter((entry) => entry.key.startsWith("corpus:"));
console.log(
  `Wrote ${outputPath} (${Math.round(html.length / 1024)} KiB, ${samples.length} sampled topics, ` +
    `page ${pageId}); sampled corpus topics with domain purity >= 0.7: ` +
    `${purity.filter((entry) => entry.domainPurity >= 0.7).length}/${purity.length}`
);
