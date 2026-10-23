// AUDIT's lints over the engine's state (F4 D19, spec 3.7): the theme drift of a topic's name, the
// rolling re-placement of a sample of the placed notes and the redirect chains of retired topics.
// They are pure functions of the cached tree, run by the audit inside the engine's turn
// (`TopicTreeService.runOnTree`): centroids live only there, no column holds them. Every tree
// write they lead to goes through the engine (single writer): a naming request, REBALANCE's
// acceptance of the re-placement candidates and the redirect change-set.
import type { AuditLintConfig } from "../gardener/lints/config.js";
import { redirectReport } from "../gardener/lints/links.js";
import type { RedirectChain, RedirectNode, RedirectReport } from "../gardener/lints/links.js";
import type { TopicTreeConfig } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import type { StructureEvent } from "./events.js";
import { compareContentKeys, compareStrings, parseItemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { mayAutoName } from "./naming.js";
import { topicOrderKey } from "./naming-fallback.js";
import { decidePlacement, scoreTopic } from "./place.js";
import { getTopic, isLive, primaryPlacement } from "./state.js";
import type { TopicTreeState } from "./state.js";
import { dot, rowView } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

// ---------------------------------------------------------------------------
// Theme drift (decision 20)

export interface ThemeDriftTopic {
  topicId: string;
  /** Cosine of the name's label vector to the topic's centroid. */
  cosine: number;
}

export interface ThemeDriftReport {
  /** Topics whose name could be measured: LLM-named, labelled and big enough. */
  measured: number;
  /** The topics below the threshold, worst first, at most `themeDrift.perRun`. */
  drifted: ThemeDriftTopic[];
  /** Topics below the threshold beyond the cap: the next audit takes them. */
  deferred: number;
  /** 5th, 50th and 95th percentile of the measured cosines (null without any). */
  percentiles: { p05: number; p50: number; p95: number } | null;
}

function percentile(sorted: readonly number[], share: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))));
  return sorted[index] as number;
}

/**
 * The topics whose name no longer matches the theme of their members: the label vector of an
 * LLM-given name against the centroid below `themeDrift.cosine`. Human, pinned and provisional
 * names are never measured (automation never changes them), and a topic without a current label
 * waits for its label vector. The caller asks the naming job to look at the drifted topics.
 */
export function themeDrift(
  state: TopicTreeState,
  config: Pick<AuditLintConfig, "themeDrift">
): ThemeDriftReport {
  const { cosine: threshold, minItems, perRun } = config.themeDrift;
  const measured: ThemeDriftTopic[] = [];
  for (const node of state.topics.values()) {
    if (node.parentId === null || !mayAutoName(node)) continue;
    if (node.nameSource !== "llm" || node.nameState !== "named") continue;
    if (node.label === null || node.stats.n < minItems) continue;
    measured.push({ topicId: node.id, cosine: dot(node.label.vector, node.stats.centroid) });
  }
  const values = measured.map((entry) => entry.cosine).sort((a, b) => a - b);
  const below = measured
    .filter((entry) => entry.cosine < threshold)
    .map((entry) => ({ ...entry, order: topicOrderKey(state, entry.topicId) }))
    .sort(
      (a, b) =>
        a.cosine - b.cosine ||
        compareStrings(a.order, b.order) ||
        compareStrings(a.topicId, b.topicId)
    )
    .map(({ topicId, cosine }) => ({ topicId, cosine }));
  return {
    measured: measured.length,
    drifted: below.slice(0, perRun),
    deferred: Math.max(0, below.length - perRun),
    percentiles:
      values.length === 0
        ? null
        : {
            p05: percentile(values, 0.05),
            p50: percentile(values, 0.5),
            p95: percentile(values, 0.95)
          }
  };
}

// ---------------------------------------------------------------------------
// Rolling re-placement

/**
 * The window of a rolling sample: `count` items of `total` starting where the previous days'
 * windows ended, so every item is decided again in `total / count` days. Deterministic in the
 * day index.
 */
export function rollingWindow(
  total: number,
  dayIndex: number,
  share: number,
  perRun: number
): { start: number; count: number } {
  if (total <= 0 || perRun <= 0 || share <= 0) return { start: 0, count: 0 };
  const count = Math.min(total, perRun, Math.max(1, Math.ceil(total * share)));
  return { start: (Math.max(0, dayIndex) * count) % total, count };
}

export interface ReplacementCandidate {
  item: ItemKey;
  /** The leaf the note sits in. */
  from: string;
  /** The leaf PLACE would choose now. */
  to: string;
  /** PLACE's score of `to` minus its score of `from`. */
  gain: number;
}

export interface ReplacementReport {
  /** Placed notes the sample could draw from (settled, AI-placed, with a vector, in a leaf). */
  eligible: number;
  /** Notes decided again. */
  sampled: number;
  candidates: ReplacementCandidate[];
  /** Candidates beyond the cap: the window moves on and they are not asked for again. */
  deferred: number;
}

/**
 * Decides again a rolling sample of the placed notes against the tree as it is now (a centroid
 * moves as members arrive, so an old placement can stop being the best one). A note whose PLACE
 * decision is a different leaf by at least `replacement.minGain` is a candidate. Nothing moves
 * here: REBALANCE tries each candidate against its acceptance rule (dQ - lambda x churn).
 */
export function replacementCandidates(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  treeConfig: TopicTreeConfig,
  config: Pick<AuditLintConfig, "replacement">,
  dayIndex: number
): ReplacementReport {
  const { share, perRun, minGain, candidates: cap } = config.replacement;
  const settled: { key: ItemKey; contentHash: string }[] = [];
  for (const [key, entry] of state.items) {
    if (parseItemKey(key)?.kind !== "note") continue;
    const placement = primaryPlacement(state, key);
    if (!placement || placement.management !== "ai") continue;
    if (placement.needsGate || placement.needsVector || vectors.rowOf(key) === undefined) continue;
    const topic = getTopic(state, placement.topicId);
    if (!isLive(topic) || topic.children.length > 0 || topic.parentId === null) continue;
    settled.push({ key, contentHash: entry.contentHash });
  }
  settled.sort(compareContentKeys);
  const window = rollingWindow(settled.length, dayIndex, share, perRun);
  const found: ReplacementCandidate[] = [];
  for (let offset = 0; offset < window.count; offset += 1) {
    const { key } = settled[(window.start + offset) % settled.length] as { key: ItemKey };
    const row = vectors.rowOf(key) as number;
    const vector = rowView(vectors.matrix, row);
    const from = (primaryPlacement(state, key) as { topicId: string }).topicId;
    const decision = decidePlacement(state, treeConfig, vector);
    if (decision.kind !== "auto" || decision.leaf.topicId === from) continue;
    const gain = decision.leaf.score - scoreTopic(state, treeConfig, vector, from).score;
    if (gain >= minGain) found.push({ item: key, from, to: decision.leaf.topicId, gain });
  }
  found.sort((a, b) => b.gain - a.gain || compareStrings(a.item, b.item));
  return {
    eligible: settled.length,
    sampled: window.count,
    candidates: found.slice(0, cap),
    deferred: Math.max(0, found.length - cap)
  };
}

// ---------------------------------------------------------------------------
// Redirect chains

/** The redirects of every topic of the state, for the link lints. */
export function redirectNodes(state: TopicTreeState): Map<string, RedirectNode> {
  const nodes = new Map<string, RedirectNode>();
  for (const node of state.topics.values()) {
    nodes.set(node.id, { retired: !isLive(node), redirectTo: node.redirectTo });
  }
  return nodes;
}

export interface RedirectPlan {
  report: RedirectReport;
  /** The chains this audit compresses (at most `links.compressPerRun`). */
  chains: RedirectChain[];
  /** Chains beyond the cap: the next audit takes them. */
  deferred: number;
}

export function planRedirectCompression(
  state: TopicTreeState,
  config: Pick<AuditLintConfig, "links">
): RedirectPlan {
  const report = redirectReport(redirectNodes(state), config.links.maxHops);
  const cap = config.links.compressPerRun;
  return {
    report,
    chains: report.chains.slice(0, cap),
    deferred: Math.max(0, report.chains.length - cap)
  };
}

/**
 * Points each retired topic of `chains` straight at the live topic its chain ends at, through the
 * engine's editor: the state holds the result and the returned events are the change-set.
 */
export function compressRedirects(
  state: TopicTreeState,
  chains: readonly RedirectChain[]
): StructureEvent[] {
  const editor = createTopicTreeEditor(state);
  for (const chain of chains) editor.redirectTopic(chain.topicId, chain.to);
  return [...editor.events];
}
