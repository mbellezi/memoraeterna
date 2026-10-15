// The placement gate (D10, spec 3.6 "Gate texts"): what the decider reads, in which order, and the
// keys of its decision cache. Pure TypeScript: the service reads the texts, supplies a hash
// function, calls the validated dedicated ranker outside the engine lock and applies the D10 rule
// (`resolveGate`) with `applyGateResolution` (place.ts).
//
// Texts. A note's query is `Title`, `Idea` and `Text`: the first `gate.queryTextMaxChars`
// characters of its body with whitespace collapsed (Spike A's note text). A root source's query is
// `Title`, `About` (an excerpt of its catalog header of the same size) and `Notes`: up to
// `gate.sourceQueryNoteTitles` distinct titles of its notes nearest the source's vector. A
// candidate topic's document is `Topic`, `About`, `Also called` and `Examples`: up to
// `gate.descriptorExamples` distinct titles of the members nearest its centroid. Empty fields are
// left out. The labels and excerpt bounds are fixed parts of the gate's text contract (versioned
// by `gateTextVersion`), like the Qwen3 template in the ranker runtimes; the instruction is the
// catalog prompt `topic.gate.instruction`.
//
// Order (D22). Candidates follow their content key: the descriptor hash, then the topic ID, so the
// call is a function of content and a replay with fresh UUIDs makes the same call.
//
// Cache keys. `itemHash` hashes the query, `descriptorHash` each descriptor and `descriptorSetHash`
// the ordered descriptor hashes, each prefixed with `gateTextVersion`. With the decider key they
// key `topic_gate_decisions`: the same content against the same descriptors and decider is ranked
// once, and its raw log-odds stay available to recalibrate T, tau and theta.
import { clipCharacters } from "../note-page.js";
import type { TopicTreeConfig } from "./config.js";
import { compareContentKeys, compareStrings, normalizeTopicTitle } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { decidePlacement } from "./place.js";
import type { GateResolution, GateScore, PlacementDecision } from "./place.js";
import { getItem, pathOf, primaryPlacement } from "./state.js";
import type { TopicTreeState } from "./state.js";
import { addItemToPath, recomputePaths, statsRow, subtractItemFromPath } from "./stats.js";
import { dotRowVec, rowView } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

/** The version of the gate's text contract; a change of labels or excerpts changes every key. */
export const gateTextVersion = "topic-gate-text-v1";

/** Field labels of the gate texts (protocol constants of the gate contract). */
export const gateTextLabels = {
  title: "Title",
  idea: "Idea",
  text: "Text",
  about: "About",
  notes: "Notes",
  topic: "Topic",
  alsoCalled: "Also called",
  examples: "Examples"
} as const;

export type GateConfig = TopicTreeConfig["gate"];

/** One line of text: whitespace collapsed, trimmed. */
function line(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function field(label: string, value: string): string | null {
  return value === "" ? null : `${label}: ${value}`;
}

function joinFields(fields: readonly (string | null)[]): string {
  return fields.filter((value): value is string => value !== null).join("\n");
}

/**
 * Up to `max` titles in the given order, collapsed to one line, the first of each set of titles
 * that differ only in case, accents or spacing (I7 normalization).
 */
export function distinctTitles(titles: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const title of titles) {
    if (output.length >= max) break;
    const clean = line(title);
    const key = normalizeTopicTitle(clean);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Queries

export interface GateNoteText {
  title: string;
  idea: string | null;
  /** The note body (Markdown); its excerpt is the `Text` line. */
  body: string | null;
}

/** A note's query: `Title`, `Idea`, then the first `queryTextMaxChars` body characters. */
export function gateNoteQuery(note: GateNoteText, gate: GateConfig): string {
  return joinFields([
    field(gateTextLabels.title, line(note.title)),
    field(gateTextLabels.idea, line(note.idea)),
    field(gateTextLabels.text, clipCharacters(line(note.body), gate.queryTextMaxChars).trimEnd())
  ]);
}

export interface GateSourceText {
  title: string;
  /** The source's catalog header (what its composite vector embeds), or null. */
  header: string | null;
  /** Titles of the source's notes, nearest its vector first. */
  noteTitles: readonly string[];
}

/** A root source's query: `Title`, an `About` excerpt of its catalog header and `Notes`. */
export function gateSourceQuery(source: GateSourceText, gate: GateConfig): string {
  return joinFields([
    field(gateTextLabels.title, line(source.title)),
    field(
      gateTextLabels.about,
      clipCharacters(line(source.header), gate.queryTextMaxChars).trimEnd()
    ),
    field(
      gateTextLabels.notes,
      distinctTitles(source.noteTitles, gate.sourceQueryNoteTitles).join("; ")
    )
  ]);
}

// ---------------------------------------------------------------------------
// Descriptors

export interface GateDescriptorInput {
  title: string | null;
  description: string | null;
  aliases: readonly string[];
  /** Member titles, nearest the centroid first; the first distinct ones become `Examples`. */
  examples: readonly string[];
}

/** A candidate topic's document, or null when it would say nothing (no ranker text is blank). */
export function gateDescriptor(input: GateDescriptorInput, gate: GateConfig): string | null {
  const text = joinFields([
    field(gateTextLabels.topic, line(input.title)),
    field(gateTextLabels.about, line(input.description)),
    field(
      gateTextLabels.alsoCalled,
      distinctTitles(input.aliases, input.aliases.length).join("; ")
    ),
    field(
      gateTextLabels.examples,
      distinctTitles(input.examples, gate.descriptorExamples).join("; ")
    )
  ]);
  return text === "" ? null : text;
}

// ---------------------------------------------------------------------------
// Members that describe a topic or a source

/**
 * Up to `count` notes of a root source, nearest the source's vector first (ties in content-key
 * order, D22): the titles a source query lists. Notes without a current vector are left out.
 */
export function sourceCentralNotes(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  source: ItemKey,
  count: number
): ItemKey[] {
  const sourceRow = vectors.rowOf(source);
  const sourceVector = sourceRow === undefined ? null : rowView(vectors.matrix, sourceRow);
  const ranked: { key: ItemKey; contentHash: string; cosine: number }[] = [];
  for (const entry of state.items.values()) {
    if (entry.kind !== "note" || entry.rootSource !== source) continue;
    const row = vectors.rowOf(entry.key);
    if (row === undefined) continue;
    ranked.push({
      key: entry.key,
      contentHash: entry.contentHash,
      cosine: sourceVector === null ? 0 : dotRowVec(vectors.matrix, row, sourceVector)
    });
  }
  ranked.sort((a, b) => b.cosine - a.cosine || compareContentKeys(a, b));
  return ranked.slice(0, Math.max(0, count)).map((entry) => entry.key);
}

// ---------------------------------------------------------------------------
// Decisions of waiting items

/**
 * Decides again the items that wait for the gate, each as PLACE would decide it: without its own
 * vector in the statistics of the topics above it (an item never sees itself, place.ts). The
 * statistics of the paths it touched are recomputed exactly afterwards (D7), so the state is
 * bit-equal to what it was. Items without a primary placement or a current vector are left out.
 */
export function decideWaitingItems(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  config: TopicTreeConfig,
  items: readonly ItemKey[]
): Map<ItemKey, PlacementDecision> {
  const decisions = new Map<ItemKey, PlacementDecision>();
  const touched = new Set<string>();
  try {
    for (const key of items) {
      getItem(state, key);
      const primary = primaryPlacement(state, key);
      const row = vectors.rowOf(key);
      if (!primary || row === undefined) continue;
      const counted = statsRow(state, vectors, key) !== undefined;
      if (counted) {
        subtractItemFromPath(state, vectors, key, primary.topicId);
        for (const id of pathOf(state, primary.topicId)) touched.add(id);
      }
      try {
        decisions.set(key, decidePlacement(state, config, rowView(vectors.matrix, row)));
      } finally {
        if (counted) addItemToPath(state, vectors, key, primary.topicId);
      }
    }
  } finally {
    if (touched.size > 0) recomputePaths(state, vectors, touched);
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Candidates, keys and scores

export interface GateCandidateText {
  topicId: string;
  /** The candidate's document; null when it has nothing to say (it is not ranked). */
  descriptor: string | null;
}

export interface KeyedGateCandidate extends GateCandidateText {
  /** Hash of the versioned descriptor; the hash of an empty one for a blank descriptor. */
  descriptorHash: string;
}

export interface GateCacheKeys {
  itemHash: string;
  descriptorSetHash: string;
  /** The candidates in content-key order (descriptor hash, then topic ID). */
  candidates: KeyedGateCandidate[];
}

const versioned = (text: string): string => `${gateTextVersion}\n${text}`;

/**
 * The decision-cache keys of one gate call and its candidates in content-key order (D22). `hash`
 * is the service's hash function (SHA-256 hex in the product).
 */
export function gateCacheKeys(
  query: string,
  candidates: readonly GateCandidateText[],
  hash: (text: string) => string
): GateCacheKeys {
  const keyed = candidates
    .map((candidate) => ({
      ...candidate,
      descriptorHash: hash(versioned(candidate.descriptor ?? ""))
    }))
    .sort(
      (a, b) =>
        compareStrings(a.descriptorHash, b.descriptorHash) || compareStrings(a.topicId, b.topicId)
    );
  return {
    itemHash: hash(versioned(query)),
    descriptorSetHash: hash(
      versioned(keyed.map((candidate) => candidate.descriptorHash).join("\n"))
    ),
    candidates: keyed
  };
}

export interface GateDeciderIdentity {
  runtime: string;
  repository: string | null;
  revision: string | null;
  quantization: string | null;
  /** The rendered ranker instruction. */
  instruction: string;
}

/**
 * The decider part of a cache key: the ranker artifact (runtime, repository, revision,
 * quantization) and the instruction it ranked under. Bounded to 300 characters.
 */
export function gateDeciderKey(
  identity: GateDeciderIdentity,
  hash: (text: string) => string
): string {
  const artifact = [
    identity.runtime,
    `${identity.repository ?? "unknown"}@${identity.revision ?? "unknown"}`,
    identity.quantization ?? "none"
  ].join(":");
  return `ranker:${artifact.slice(0, 220)}|instruction:${hash(identity.instruction).slice(0, 16)}|${gateTextVersion}`;
}

/** The candidates the ranker scored (descriptor present), with their log-odds, for `resolveGate`. */
export function gateScores(
  candidates: readonly { topicId: string; logOdds: number | null }[]
): GateScore[] {
  return candidates.flatMap((candidate) =>
    candidate.logOdds === null ? [] : [{ topicId: candidate.topicId, logOdds: candidate.logOdds }]
  );
}

/** "None of these" without a score: no candidate had a descriptor the ranker could read. */
export function unrankedGateResolution(): GateResolution {
  return { kind: "none", topicId: null, probability: 0, noneProbability: 1, probabilities: [] };
}
