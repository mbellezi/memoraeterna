// Topic naming (plan 4.1 Naming, D11): which topics need a name, the batches an LLM names, and
// the validation of what it answers. Pure TypeScript; the service in the main process makes the
// call, applies the result as one change-set and falls back to the TF-IDF name (naming-fallback.ts)
// for the topics that stay without one.
//
// Names are always in the content language. The model states the language of what it wrote, which
// must equal the content language, and a stopword heuristic checks the description and the title
// as well, because a model that writes "Spaced practice" for a Portuguese library would mix
// languages (owner feedback on Spike B). Prompts are a function of content (D22): groups, topics
// and members follow content-hash order, never IDs.
//
// A name covers the whole topic (gate C, E4: names that described only the central members were
// the dominant failure). A leaf shows a covering sample, its most central members plus the members
// that best cover the rest of it (greedy facility location over the member vectors); an internal
// topic shows its subtopics with their titles and sizes and a few members of each, larger ones
// first. A name never repeats its parent's title or a subtopic's.
import { z } from "zod";

import { clipCharacters, withinCharacters } from "../note-page.js";
import { topicLimits } from "../topics.js";
import type { TopicTreeConfig } from "./config.js";
import { compareContentKeys, compareStrings, normalizeTopicTitle, sameTopicTitle } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { topicOrderKey } from "./naming-fallback.js";
import { depthOf, getTopic, isLive, subtreeItems } from "./state.js";
import type { TopicNode, TopicTreeState } from "./state.js";
import {
  foldTerm,
  guessLanguage,
  sameContentLanguage,
  tokenize,
  topicNamingLanguageOf
} from "./stopwords/index.js";
import { dotRows, dotRowVec } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

export type TopicNamingConfig = TopicTreeConfig["naming"];

// ---------------------------------------------------------------------------
// Which topics need a name

/**
 * Why a topic is named: it has no name, a provisional one, its members drifted, or its LLM name
 * was written under another revision of the naming prompt (only when a rename pass asks for it).
 */
export const namingReasons = ["unnamed", "provisional", "drift", "revision"] as const;
export type NamingReason = (typeof namingReasons)[number];

export interface NamingCandidate {
  topicId: string;
  parentId: string;
  depth: number;
  reason: NamingReason;
  /** Content-key order among all topics (D22). */
  orderKey: string;
}

export interface NamingCandidateOptions {
  /** Topics not to name now (already tried lately). */
  skip?: ReadonlySet<string>;
  /**
   * The share of an LLM-named topic's members that changed since it was named, or null when that
   * is not known; only a share at or above `naming.renameDrift` names the topic again.
   */
  drift?: (topicId: string) => number | null;
  /**
   * Whether an LLM-named topic was named under another revision of the naming prompt; such a
   * topic is named again from scratch (a rename pass, never by default).
   */
  staleRevision?: (topicId: string) => boolean;
}

/** Whether automation may change the topic's name at all (human and protected topics never). */
export function mayAutoName(node: TopicNode): boolean {
  return (
    isLive(node) && node.role === "topic" && node.management === "ai" && node.nameSource !== "human"
  );
}

/**
 * The topics to name, shallow first. A topic with no name or a provisional one is always a
 * candidate; a topic the LLM named is one again only when its members drifted by `renameDrift` or
 * more, or when a rename pass finds it named under another prompt revision. Human-named,
 * human-created, pinned and retired topics never are.
 */
export function namingCandidates(
  state: TopicTreeState,
  config: Pick<TopicTreeConfig, "naming">,
  options: NamingCandidateOptions = {}
): NamingCandidate[] {
  const found: NamingCandidate[] = [];
  for (const node of state.topics.values()) {
    if (!mayAutoName(node) || node.parentId === null) continue;
    if (options.skip?.has(node.id)) continue;
    let reason: NamingReason | null = null;
    if (node.nameState === "unnamed") reason = "unnamed";
    else if (node.nameState === "provisional") reason = "provisional";
    else if (node.nameSource === "llm") {
      const drift = options.drift?.(node.id) ?? null;
      if (options.staleRevision?.(node.id)) reason = "revision";
      else if (drift !== null && drift >= config.naming.renameDrift) reason = "drift";
    }
    if (reason === null) continue;
    found.push({
      topicId: node.id,
      parentId: node.parentId,
      depth: depthOf(state, node.id),
      reason,
      orderKey: topicOrderKey(state, node.id)
    });
  }
  return found.sort(
    (a, b) =>
      a.depth - b.depth ||
      compareStrings(a.orderKey, b.orderKey) ||
      compareStrings(a.topicId, b.topicId)
  );
}

// ---------------------------------------------------------------------------
// Membership drift

/** Hashes kept per topic when it is named; the estimate's error is about 1/sqrt(size). */
export const membershipSketchSize = 64;

/** A bottom-k sketch of a topic's members: its items' 32-bit content hashes, smallest first. */
export interface MembershipSketch {
  /** Items in the subtree when the sketch was taken. */
  n: number;
  hashes: number[];
}

export const MembershipSketchSchema = z
  .object({
    n: z.number().int().min(0),
    hashes: z.array(z.number().int().min(0).max(0xffffffff)).max(1024)
  })
  .strict();

/** 32-bit FNV-1a, for the rare item whose content hash is not hexadecimal. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** An item's 32-bit membership hash: the start of its content hash (a SHA-256), else a hash of its key. */
export function itemMembershipHash(contentHash: string, key: ItemKey): number {
  return /^[0-9a-f]{8}/u.test(contentHash)
    ? Number.parseInt(contentHash.slice(0, 8), 16)
    : fnv1a32(contentHash || key);
}

/** The sketch of a topic's subtree: its `size` smallest distinct member hashes. */
export function membershipSketch(
  state: TopicTreeState,
  topicId: string,
  size = membershipSketchSize
): MembershipSketch {
  const items = subtreeItems(state, topicId);
  const hashes = new Set<number>();
  for (const key of items) {
    hashes.add(itemMembershipHash(state.items.get(key)?.contentHash ?? "", key));
  }
  return { n: items.length, hashes: [...hashes].sort((a, b) => a - b).slice(0, size) };
}

/**
 * The share of members that changed between two sketches: 1 minus the estimated Jaccard
 * similarity (exact while both topics are smaller than the sketch). Two empty topics did not drift.
 */
export function membershipDrift(then: MembershipSketch, now: MembershipSketch): number {
  if (then.hashes.length === 0 && now.hashes.length === 0) return 0;
  if (then.hashes.length === 0 || now.hashes.length === 0) return 1;
  const left = new Set(then.hashes);
  const right = new Set(now.hashes);
  const union = [...new Set([...then.hashes, ...now.hashes])].sort((a, b) => a - b);
  // A sketch that holds every member is exact. Otherwise the smallest k hashes of the union, with
  // k the shorter sketch, are the smallest of both sets, and the share of them in both estimates
  // the Jaccard similarity (a bottom-k sketch).
  const truncated = then.n > then.hashes.length || now.n > now.hashes.length;
  const k = truncated
    ? Math.min(then.hashes.length, now.hashes.length, union.length)
    : union.length;
  let shared = 0;
  for (const hash of union.slice(0, k)) if (left.has(hash) && right.has(hash)) shared += 1;
  return 1 - shared / k;
}

/**
 * The share of the members a topic had at `then` that changed by `now`: members added plus
 * members removed over the members it had, at most 1 (from the sketches' Jaccard estimate; exact
 * while both are smaller than the sketch). Unlike membershipDrift it does not shrink as a topic
 * grows: a 21-member topic that gains 7 changed by 1/3 (drift 1/4), one of 11 that gains 9 by 9/11.
 */
export function membershipChange(then: MembershipSketch, now: MembershipSketch): number {
  if (then.n === 0) return now.n === 0 ? 0 : 1;
  const jaccard = 1 - membershipDrift(then, now);
  const shared = (jaccard * (then.n + now.n)) / (1 + jaccard);
  return Math.min(1, Math.max(0, (then.n + now.n - 2 * shared) / then.n));
}

// ---------------------------------------------------------------------------
// Central members and the batches of a call

/** One of a topic's most central notes (or sources) as the prompt shows it. */
export interface NamingMember {
  key: ItemKey;
  kind: "note" | "source";
  title: string;
  /** The idea statement cut at `naming.ideaMaxChars`; null for a source. */
  idea: string | null;
  /** The root source the member belongs to (the audit's participating source). */
  rootSource: ItemKey | null;
}

export interface CentralItem {
  key: ItemKey;
  kind: "note" | "source";
  contentHash: string;
  cosine: number;
}

/**
 * The `count` items nearest the topic's centroid: notes first, then root sources only to fill the
 * rest, ties in content-key order (D22). Items without a current vector are left out.
 */
export function centralItems(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  topicId: string,
  count: number
): CentralItem[] {
  const node = getTopic(state, topicId);
  const centroid = node.stats.centroid;
  const ranked: CentralItem[] = [];
  for (const key of subtreeItems(state, topicId)) {
    const entry = state.items.get(key);
    const row = vectors.rowOf(key);
    if (!entry || row === undefined) continue;
    ranked.push({
      key,
      kind: entry.kind,
      contentHash: entry.contentHash,
      cosine: dotRowVec(vectors.matrix, row, centroid)
    });
  }
  ranked.sort(
    (a, b) =>
      Number(a.kind === "source") - Number(b.kind === "source") ||
      b.cosine - a.cosine ||
      compareContentKeys(a, b)
  );
  return ranked.slice(0, count);
}

/** Members a covering sample weighs at most (content-key order); a leaf has far fewer. */
export const coveringPoolMax = 256;

/**
 * The covering sample of a topic: its `central` most central notes plus the members that best
 * cover the rest, `total` in all, in content-key order (D22) so the prompt does not single out the
 * centre. The rest are chosen by greedy facility location over the member vectors: each pick is the
 * member that raises the sum, over all members, of the cosine to the nearest picked member the
 * most (ties in content-key order), so a group of members away from the centre gets a
 * representative before a stray one does. Notes come first, as in centralItems: sources fill a
 * topic with too few notes. Items without a current vector are left out.
 */
export function coveringItems(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  topicId: string,
  options: { central: number; total: number }
): CentralItem[] {
  const total = Math.max(0, Math.floor(options.total));
  const ranked = centralItems(state, vectors, topicId, Number.POSITIVE_INFINITY);
  const notes = ranked.filter((item) => item.kind === "note");
  if (notes.length <= total) return ranked.slice(0, total).sort(compareContentKeys);
  const central = notes.slice(0, Math.min(Math.max(0, Math.floor(options.central)), total));
  const chosen = new Set(central.map((item) => item.key));
  // The members weighed: every note of a leaf (at most coveringPoolMax, in content-key order).
  const weighed = [
    ...central,
    ...[...notes]
      .sort(compareContentKeys)
      .filter((item) => !chosen.has(item.key))
      .slice(0, Math.max(0, coveringPoolMax - central.length))
  ].sort(compareContentKeys);
  const rows = weighed.map((item) => vectors.rowOf(item.key) as number);
  const size = weighed.length;
  const similarity = new Float64Array(size * size);
  for (let a = 0; a < size; a += 1) {
    similarity[a * size + a] = 1;
    for (let b = a + 1; b < size; b += 1) {
      const value = dotRows(vectors.matrix, rows[a] as number, rows[b] as number);
      similarity[a * size + b] = value;
      similarity[b * size + a] = value;
    }
  }
  // cover[i]: the cosine of member i to its nearest chosen member (-1 while none is chosen).
  const cover = new Float64Array(size).fill(-1);
  const take = (index: number) => {
    chosen.add((weighed[index] as CentralItem).key);
    for (let i = 0; i < size; i += 1) {
      cover[i] = Math.max(cover[i] as number, similarity[i * size + index] as number);
    }
  };
  weighed.forEach((item, index) => {
    if (chosen.has(item.key)) take(index);
  });
  const picked: CentralItem[] = [...central];
  while (picked.length < total) {
    let best = -1;
    let bestGain = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < size; j += 1) {
      if (chosen.has((weighed[j] as CentralItem).key)) continue;
      let gain = 0;
      for (let i = 0; i < size; i += 1) {
        const lift = (similarity[i * size + j] as number) - (cover[i] as number);
        if (lift > 0) gain += lift;
      }
      // `weighed` is in content-key order: the first of equal gains wins.
      if (gain > bestGain) {
        best = j;
        bestGain = gain;
      }
    }
    if (best < 0) break;
    picked.push(weighed[best] as CentralItem);
    take(best);
  }
  return picked.sort(compareContentKeys);
}

/** A subtopic of an internal topic in its naming sample: its name, its size, a few members. */
export interface SubtopicSample {
  topicId: string;
  /** Its title when it is named (by the model or a person); null when unnamed or provisional. */
  title: string | null;
  /** Items in its subtree. */
  size: number;
  /** Its most central members, as many as the sample gives it. */
  items: CentralItem[];
}

/** What an internal topic shows: its subtopics (larger first) and a few of its own items. */
export interface InternalNamingSample {
  subtopics: SubtopicSample[];
  /** Items placed on the topic itself rather than in a subtopic. */
  direct: CentralItem[];
}

/**
 * The naming sample of an internal topic: every live subtopic with its title and size, larger
 * first (ties in content-key order), and up to `total` members spread over them and over the
 * items placed on the topic itself. A subtopic without a name gets one member first; then each
 * next member goes to the part with the most items per member it already shows (the D'Hondt
 * rule), at most `perChild` per part, so large subtopics show more and none speaks for the whole.
 */
export function internalNamingSample(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  topicId: string,
  options: { total: number; perChild: number }
): InternalNamingSample {
  const node = getTopic(state, topicId);
  const perChild = Math.max(0, Math.floor(options.perChild));
  interface Part {
    topicId: string | null;
    title: string | null;
    size: number;
    key: string;
    ranked: CentralItem[];
    given: number;
  }
  const parts: Part[] = [];
  for (const childId of node.children) {
    const child = getTopic(state, childId);
    if (!isLive(child)) continue;
    parts.push({
      topicId: childId,
      title: child.nameState === "named" ? child.title : null,
      size: subtreeItems(state, childId).length,
      key: topicOrderKey(state, childId),
      ranked: perChild > 0 ? centralItems(state, vectors, childId, perChild) : [],
      given: 0
    });
  }
  const own: Part | null =
    node.items.length === 0
      ? null
      : {
          topicId: null,
          title: null,
          size: node.items.length,
          key: [...new Set(node.items.map((key) => state.items.get(key)?.contentHash ?? ""))]
            .sort(compareStrings)
            .slice(0, 3)
            .join(":"),
          ranked:
            perChild > 0 ? rankByCentroid(state, vectors, node.items, node.stats.centroid) : [],
          given: 0
        };
  if (own) parts.push(own);
  parts.sort((a, b) => b.size - a.size || compareStrings(a.key, b.key));
  const cap = (part: Part) => Math.min(perChild, part.ranked.length);
  let slots = Math.max(0, Math.floor(options.total));
  for (const part of parts) {
    if (slots === 0) break;
    if (part.topicId !== null && part.title === null && cap(part) > 0) {
      part.given = 1;
      slots -= 1;
    }
  }
  while (slots > 0) {
    let best: Part | null = null;
    for (const part of parts) {
      if (part.given >= cap(part)) continue;
      // Parts are larger first: the first of equal quotients wins.
      if (!best || part.size / (part.given + 1) > best.size / (best.given + 1)) best = part;
    }
    if (!best) break;
    best.given += 1;
    slots -= 1;
  }
  return {
    subtopics: parts.flatMap((part) =>
      part.topicId === null
        ? []
        : [
            {
              topicId: part.topicId,
              title: part.title,
              size: part.size,
              items: part.ranked.slice(0, part.given)
            }
          ]
    ),
    direct: own ? own.ranked.slice(0, own.given) : []
  };
}

/** Items ranked by cosine to a centroid, notes first, ties in content-key order. */
function rankByCentroid(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  keys: readonly ItemKey[],
  centroid: Float32Array
): CentralItem[] {
  const ranked: CentralItem[] = [];
  for (const key of keys) {
    const entry = state.items.get(key);
    const row = vectors.rowOf(key);
    if (!entry || row === undefined) continue;
    ranked.push({
      key,
      kind: entry.kind,
      contentHash: entry.contentHash,
      cosine: dotRowVec(vectors.matrix, row, centroid)
    });
  }
  return ranked.sort(
    (a, b) =>
      Number(a.kind === "source") - Number(b.kind === "source") ||
      b.cosine - a.cosine ||
      compareContentKeys(a, b)
  );
}

/** A subtopic as a naming call shows it. */
export interface NamingSubtopic {
  /** Its title, null when it has no name yet. */
  title: string | null;
  size: number;
  members: NamingMember[];
}

/** A topic of a call: its alias (`T1`..), what it holds and the title it has now. */
export interface NamingTopic {
  topicId: string;
  alias: string;
  /** Items in the topic's subtree. */
  size: number;
  /** A leaf's covering sample; an internal topic's own items, if it has any. */
  members: NamingMember[];
  /** An internal topic's subtopics, larger first; empty for a leaf. */
  subtopics: NamingSubtopic[];
  /** The titles its subtopics hold now: the name must repeat none of them (D11). */
  childTitles: string[];
  /** The title a drift rename starts from; the model keeps it while it still fits. */
  currentTitle: string | null;
}

/** Sibling topics under one parent, with the titles their siblings already have. */
export interface NamingGroup {
  parentId: string;
  /** The parent's title, null under the root or under an unnamed parent. */
  parentTitle: string | null;
  /**
   * The title the parent holds now when the prompt does not show it (the parent is named again
   * after its children in this job): a name never repeats it either.
   */
  parentHeldTitle?: string | null;
  /** Titles of siblings not named in this call. */
  namedSiblings: string[];
  topics: NamingTopic[];
}

/** One model call: groups of one level, within `naming.maxTopicsPerCall` and the member budget. */
export interface NamingCall {
  groups: NamingGroup[];
}

export function namingCallTopics(call: NamingCall): NamingTopic[] {
  return call.groups.flatMap((group) => group.topics);
}

/** Every member a topic shows: its own and its subtopics'. */
export function namingTopicMembers(
  topic: Pick<NamingTopic, "members" | "subtopics">
): NamingMember[] {
  return [...topic.members, ...topic.subtopics.flatMap((subtopic) => subtopic.members)];
}

/** Cuts an idea to `max` characters with an ellipsis; a short text stays as it is. */
export function clipIdea(text: string, max: number): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (withinCharacters(clean, max)) return clean;
  return `${clipCharacters(clean, Math.max(1, max - 1)).trimEnd()}…`;
}

export interface UnaliasedTopic {
  topicId: string;
  size: number;
  members: NamingMember[];
  subtopics?: NamingSubtopic[];
  childTitles?: string[];
  currentTitle: string | null;
}

/** What one call may hold: topics, and members shown (`naming.maxMembersPerCall`). */
export interface NamingCallLimit {
  maxTopics: number;
  maxMembers?: number;
}

/**
 * The members a topic spends of a call's budget: every member it shows, and a quarter of a member
 * per subtopic heading (a title and a size are about a quarter of a member's title and idea).
 */
export function namingTopicWeight(topic: Pick<UnaliasedTopic, "members" | "subtopics">): number {
  const subtopics = topic.subtopics ?? [];
  return (
    topic.members.length +
    subtopics.reduce((sum, subtopic) => sum + subtopic.members.length, 0) +
    Math.ceil(subtopics.length / 4)
  );
}

/**
 * Packs unaliased groups into calls of at most `maxTopics` topics and `maxMembers` members shown
 * (a bare number limits topics only). Groups keep their order and stay whole unless one alone is
 * larger than a call; a topic larger than the member budget gets a call of its own. Aliases run
 * T1.. across the call.
 */
export function packNamingCalls(
  groups: ReadonlyArray<Omit<NamingGroup, "topics"> & { topics: UnaliasedTopic[] }>,
  limit: number | NamingCallLimit
): NamingCall[] {
  const maxTopics = typeof limit === "number" ? limit : limit.maxTopics;
  const maxMembers =
    typeof limit === "number"
      ? Number.POSITIVE_INFINITY
      : (limit.maxMembers ?? Number.POSITIVE_INFINITY);
  const fits = (topics: number, members: number) => topics <= maxTopics && members <= maxMembers;
  interface Piece {
    group: Omit<NamingGroup, "topics">;
    topics: UnaliasedTopic[];
    weight: number;
  }
  const pieces: Piece[] = [];
  for (const { topics, ...group } of groups) {
    let piece: Piece | null = null;
    for (const topic of topics) {
      const weight = namingTopicWeight(topic);
      if (piece && !fits(piece.topics.length + 1, piece.weight + weight)) {
        pieces.push(piece);
        piece = null;
      }
      piece ??= { group, topics: [], weight: 0 };
      piece.topics.push(topic);
      piece.weight += weight;
    }
    if (piece) pieces.push(piece);
  }
  const calls: Piece[][] = [];
  let current: Piece[] = [];
  let size = 0;
  let weight = 0;
  for (const piece of pieces) {
    if (current.length > 0 && !fits(size + piece.topics.length, weight + piece.weight)) {
      calls.push(current);
      current = [];
      size = 0;
      weight = 0;
    }
    current.push(piece);
    size += piece.topics.length;
    weight += piece.weight;
  }
  if (current.length > 0) calls.push(current);
  return calls.map((call) => {
    let next = 0;
    return {
      groups: call.map(({ group, topics }) => ({
        ...group,
        namedSiblings: [...group.namedSiblings],
        topics: topics.map((topic) => ({
          topicId: topic.topicId,
          alias: `T${(next += 1)}`,
          size: topic.size,
          members: topic.members,
          subtopics: topic.subtopics ?? [],
          childTitles: topic.childTitles ?? [],
          currentTitle: topic.currentTitle
        }))
      }))
    };
  });
}

function promptNotes(members: readonly NamingMember[]) {
  return members.map((member) =>
    member.idea === null ? { title: member.title } : { title: member.title, idea: member.idea }
  );
}

/**
 * What the prompt's `%topics%` shows: groups with their parent, named siblings and topics. A topic
 * shows its size and its notes; an internal topic its subtopics (title, size and a few notes) and
 * the notes placed on it, if any.
 */
export function namingPromptGroups(call: NamingCall) {
  return call.groups.map((group) => ({
    parent: group.parentTitle,
    named_siblings: group.namedSiblings,
    topics: group.topics.map((topic) => ({
      alias: topic.alias,
      ...(topic.currentTitle === null ? {} : { current_title: topic.currentTitle }),
      size: topic.size,
      ...(topic.subtopics.length === 0
        ? {}
        : {
            subtopics: topic.subtopics.map((subtopic) => ({
              title: subtopic.title,
              size: subtopic.size,
              ...(subtopic.members.length === 0 ? {} : { notes: promptNotes(subtopic.members) })
            }))
          }),
      ...(topic.subtopics.length > 0 && topic.members.length === 0
        ? {}
        : { notes: promptNotes(topic.members) })
    }))
  }));
}

// ---------------------------------------------------------------------------
// The model's answer

/** The contract the model answers: one item per alias. */
export const NamingItemSchema = z.object({
  alias: z.string(),
  title: z.string(),
  description: z.string(),
  aliases: z.array(z.string()).optional(),
  language: z.string()
});

const NamingEnvelopeSchema = z.object({ topics: z.array(z.unknown()) });

export const namingRejections = [
  "missing",
  "malformed",
  "duplicate_answer",
  "title_empty",
  "title_length",
  "title_format",
  "title_generic",
  "title_identifier",
  "same_as_parent",
  "same_as_child",
  "duplicate_sibling",
  "language_mismatch",
  "language_heuristic",
  "description_missing",
  "description_length"
] as const;
export type NamingRejection = (typeof namingRejections)[number];

export interface AcceptedName {
  topicId: string;
  alias: string;
  title: string;
  description: string;
  aliases: string[];
  language: string;
}

export interface RejectedName {
  topicId: string;
  alias: string;
  reason: NamingRejection;
  /** The title the model proposed, when there was one. */
  title?: string;
}

export interface NamingValidation {
  accepted: AcceptedName[];
  rejected: RejectedName[];
}

export interface NamingValidationContext {
  /** The library's content language (`pt-BR`). */
  contentLanguage: string;
  config: TopicNamingConfig;
}

/** Words that name nothing, in the five content languages (compared folded, whole title only). */
const genericTitles = new Set(
  [
    "miscellaneous",
    "misc",
    "other",
    "others",
    "general",
    "generic",
    "notes",
    "note",
    "topics",
    "topic",
    "various",
    "unsorted",
    "untitled",
    "unnamed",
    "uncategorized",
    "unnamed topic",
    "diversos",
    "diverso",
    "outros",
    "outro",
    "geral",
    "notas",
    "nota",
    "topicos",
    "topico",
    "sem titulo",
    "sem nome",
    "sem categoria",
    "topico sem nome",
    "varios",
    "otros",
    "temas",
    "tema",
    "sin titulo",
    "sin nombre",
    "tema sin nombre",
    "divers",
    "autres",
    "general",
    "sujets",
    "sujet",
    "sans titre",
    "sans nom",
    "sujet sans nom",
    "varie",
    "altri",
    "generale",
    "argomenti",
    "argomento",
    "senza titolo",
    "senza nome",
    "argomento senza nome"
  ].map(foldTerm)
);

const identifierPatterns: readonly RegExp[] = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
  /^t\d+$/iu,
  /^(?:topic|topico|tópico|tema|sujet|argomento|cluster|group|grupo|groupe|gruppo|node|nodo|nœud)\s*[-_#:.]?\s*\d+$/iu,
  /\b(?:note|source|topic):[0-9a-f-]{6,}/iu,
  /^[0-9a-f]{10,}$/iu,
  /^[\d\s.,;:\-_/\\#]+$/u
];

/** True when a title is a word that names nothing ("Miscellaneous", "Outros"), as a whole. */
export function isGenericTopicTitle(title: string): boolean {
  return genericTitles.has(foldTerm(title));
}

/** True when a name looks like an identifier, an alias or a placeholder rather than a subject. */
export function isIdentifierShaped(text: string): boolean {
  const trimmed = text.trim();
  return identifierPatterns.some((pattern) => pattern.test(trimmed));
}

/** A title or alias as the model wrote it, cleaned: one line, no wrapping quotes or Markdown. */
export function cleanNameText(text: string): string {
  let clean = text
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  clean = clean.replace(/^(?:title|título|titre|titolo)\s*:\s*/iu, "");
  clean = clean.replace(/^[*_`#>\s"'“”‘’«»]+/u, "");
  for (let previous = ""; previous !== clean;) {
    previous = clean;
    clean = clean.replace(/[*_`\s"'“”‘’«».。]+$/u, "");
  }
  return clean;
}

/** The text of a model answer as JSON: a parsed value, or a string with an optional code fence. */
export function parseModelJson(output: unknown): unknown {
  if (typeof output !== "string") return output;
  const trimmed = output.trim();
  const fenced = /^```[a-z]*\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  const body = fenced ? (fenced[1] ?? "") : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Validates the answer of one call against its topics. Valid items are kept, whatever the others
 * are: a topic answered twice is ambiguous and neither answer is trusted, an alias nobody asked for
 * is ignored, and the first topic (in call order) to claim a title among its siblings keeps it.
 */
export function validateNamingOutput(
  output: unknown,
  call: NamingCall,
  context: NamingValidationContext
): NamingValidation {
  const { config } = context;
  const asked = new Map<string, { topic: NamingTopic; group: NamingGroup }>();
  for (const group of call.groups) {
    for (const topic of group.topics) asked.set(topic.alias, { topic, group });
  }
  const answers = new Map<string, unknown[]>();
  let malformed = false;
  const envelope = NamingEnvelopeSchema.safeParse(parseModelJson(output));
  if (!envelope.success) malformed = true;
  else {
    for (const item of envelope.data.topics) {
      const alias =
        typeof item === "object" && item !== null && "alias" in item
          ? (item as { alias: unknown }).alias
          : undefined;
      if (typeof alias !== "string" || !asked.has(alias)) continue;
      answers.set(alias, [...(answers.get(alias) ?? []), item]);
    }
  }
  const accepted: AcceptedName[] = [];
  const rejected: RejectedName[] = [];
  // Titles claimed under each parent so far: its named siblings, then the accepted ones in order.
  const claimed = new Map<string, string[]>();
  for (const group of call.groups) {
    claimed.set(group.parentId, [...(claimed.get(group.parentId) ?? []), ...group.namedSiblings]);
  }
  for (const group of call.groups) {
    for (const topic of group.topics) {
      const reject = (reason: NamingRejection, title?: string) =>
        rejected.push({
          topicId: topic.topicId,
          alias: topic.alias,
          reason,
          ...(title === undefined ? {} : { title })
        });
      const given = answers.get(topic.alias) ?? [];
      if (malformed) {
        reject("malformed");
        continue;
      }
      if (given.length === 0) {
        reject("missing");
        continue;
      }
      if (given.length > 1) {
        reject("duplicate_answer");
        continue;
      }
      const parsed = NamingItemSchema.safeParse(given[0]);
      if (!parsed.success) {
        reject("malformed");
        continue;
      }
      const item = parsed.data;
      const title = cleanNameText(item.title);
      if (title === "") {
        reject("title_empty");
        continue;
      }
      if (!withinCharacters(title, config.titleMaxChars)) {
        reject("title_length", title);
        continue;
      }
      if (title.includes("›") || /[{}[\]<>]/u.test(title)) {
        reject("title_format", title);
        continue;
      }
      if (isIdentifierShaped(title)) {
        reject("title_identifier", title);
        continue;
      }
      if (genericTitles.has(foldTerm(title))) {
        reject("title_generic", title);
        continue;
      }
      if (
        [group.parentTitle, group.parentHeldTitle ?? null].some(
          (parent) => parent !== null && sameTopicTitle(parent, title)
        )
      ) {
        reject("same_as_parent", title);
        continue;
      }
      if (topic.childTitles.some((child) => sameTopicTitle(child, title))) {
        reject("same_as_child", title);
        continue;
      }
      if (!statesContentLanguage(item.language, context.contentLanguage)) {
        reject("language_mismatch", title);
        continue;
      }
      const description = item.description.replace(/\s+/gu, " ").trim();
      if (description === "") {
        reject("description_missing", title);
        continue;
      }
      if (!withinCharacters(description, config.descriptionMaxChars)) {
        reject("description_length", title);
        continue;
      }
      if (languageDisagrees(title, description, context.contentLanguage)) {
        reject("language_heuristic", title);
        continue;
      }
      const taken = claimed.get(group.parentId) ?? [];
      if (taken.some((other) => sameTopicTitle(other, title))) {
        reject("duplicate_sibling", title);
        continue;
      }
      claimed.set(group.parentId, [...taken, title]);
      const seen = new Set([normalizeTopicTitle(title)]);
      const aliases: string[] = [];
      for (const raw of item.aliases ?? []) {
        const alias = cleanNameText(raw);
        const normal = normalizeTopicTitle(alias);
        if (
          alias === "" ||
          seen.has(normal) ||
          !withinCharacters(alias, topicLimits.aliasMaxLength) ||
          isIdentifierShaped(alias) ||
          genericTitles.has(foldTerm(alias))
        ) {
          continue;
        }
        seen.add(normal);
        aliases.push(alias);
        if (aliases.length >= config.maxAliases) break;
      }
      accepted.push({
        topicId: topic.topicId,
        alias: topic.alias,
        title,
        description,
        aliases,
        language: context.contentLanguage
      });
    }
  }
  return { accepted, rejected };
}

/**
 * The independent language check (the stated `language` is only the model's word): the
 * description reads as another supported language than the content language, or a title of at
 * least two words reads as English in a library that is not English. English is the slip models
 * make; a short title in another language cannot be told from a word the content language shares
 * ("sono" is Portuguese for sleep and an Italian function word).
 */
function languageDisagrees(title: string, description: string, contentLanguage: string): boolean {
  const content = topicNamingLanguageOf(contentLanguage);
  if (content === null) return false;
  const text = guessLanguage(description, 3, 2);
  if (text.language !== null && text.language !== content) return true;
  if (content === "en" || tokenize(title).length < 2) return false;
  const named = guessLanguage(title, 1, 1);
  return named.language === "en" && named.hits[content] < 1;
}

/** Language names a model may write instead of a code (compared folded). */
const languageNames: Record<string, string> = {
  english: "en",
  inglês: "en",
  ingles: "en",
  anglais: "en",
  inglese: "en",
  portuguese: "pt",
  português: "pt",
  portugues: "pt",
  portugais: "pt",
  portoghese: "pt",
  spanish: "es",
  español: "es",
  espanol: "es",
  espagnol: "es",
  spagnolo: "es",
  french: "fr",
  français: "fr",
  francais: "fr",
  francês: "fr",
  frances: "fr",
  francese: "fr",
  italian: "it",
  italiano: "it",
  italien: "it"
};

/** Whether the `language` a model stated is the content language (a code, or a language name). */
export function statesContentLanguage(stated: string, contentLanguage: string): boolean {
  const lowered = stated.trim().toLowerCase();
  const named = languageNames[lowered] ?? languageNames[foldTerm(lowered)];
  return sameContentLanguage(named ?? stated, contentLanguage);
}

const rejectionLines: Record<NamingRejection, (title: string, parent: string | null) => string> = {
  missing: () => "no answer was given",
  malformed: () => "the answer did not follow the JSON contract",
  duplicate_answer: () => "the alias was answered more than once",
  title_empty: () => "the title is empty",
  title_length: (title) => `the title "${title}" is too long`,
  title_format: (title) => `the title "${title}" contains Markdown, brackets or a path separator`,
  title_generic: (title) => `the title "${title}" names no subject`,
  title_identifier: (title) => `the title "${title}" looks like an identifier or a placeholder`,
  same_as_parent: (title, parent) =>
    `the title "${title}" repeats the parent title${parent ? ` "${parent}"` : ""}`,
  same_as_child: (title) =>
    `the title "${title}" repeats the title of one of its subtopics: name the whole topic, broader than each subtopic`,
  duplicate_sibling: (title) => `the title "${title}" is already used by a sibling topic`,
  language_mismatch: () => "the name is not in the content language",
  language_heuristic: (title) => `the name "${title}" or its description mixes languages`,
  description_missing: () => "the description is empty",
  description_length: () => "the description is too long"
};

/** The lines of the repair prompt: one per rejected alias, in call order. */
export function describeRejections(
  rejected: readonly RejectedName[],
  call: NamingCall,
  contentLanguage: string
): string {
  const order = new Map(namingCallTopics(call).map((topic, index) => [topic.alias, index]));
  const parents = new Map<string, string | null>();
  for (const group of call.groups) {
    for (const topic of group.topics) {
      parents.set(topic.alias, group.parentTitle ?? group.parentHeldTitle ?? null);
    }
  }
  return [...rejected]
    .sort((a, b) => (order.get(a.alias) ?? 0) - (order.get(b.alias) ?? 0))
    .map(
      (item) =>
        `${item.alias}: ${rejectionLines[item.reason](item.title ?? "", parents.get(item.alias) ?? null)}` +
        (item.reason === "language_mismatch" || item.reason === "language_heuristic"
          ? ` (write everything in ${contentLanguage})`
          : "")
    )
    .join("\n");
}

/**
 * The call that asks again for the rejected topics only: the same groups reduced to those topics,
 * with the titles accepted for their siblings added to what is taken.
 */
export function retryCall(call: NamingCall, validation: NamingValidation): NamingCall | null {
  const retryAliases = new Set(validation.rejected.map((item) => item.alias));
  const acceptedTitles = new Map<string, string>();
  for (const name of validation.accepted) acceptedTitles.set(name.topicId, name.title);
  const groups: NamingGroup[] = [];
  for (const group of call.groups) {
    const topics = group.topics.filter((topic) => retryAliases.has(topic.alias));
    if (topics.length === 0) continue;
    const accepted = group.topics.flatMap((topic) => {
      const title = acceptedTitles.get(topic.topicId);
      return title === undefined ? [] : [title];
    });
    groups.push({ ...group, namedSiblings: [...group.namedSiblings, ...accepted], topics });
  }
  return groups.length === 0 ? null : { groups };
}
