// The provisional TF-IDF name of a topic ("Parent › terms"), used when no LLM name exists (plan 4.1
// Naming, D11). It is built only from items written in the content language and with that
// language's stopwords, so a name never mixes languages whatever language the cluster's other
// notes are in (owner feedback on Spike B). A topic with too few content-language items stays
// unnamed: no title is stored and the interface renders "Unnamed topic".
//
// A term scores high when many of the topic's items contain it, it is rare among the items in
// scope, and it is rare among the parent's other items. Terms the ancestors' titles already use
// are skipped. The result is a pure function of the tree structure, the item texts and the options.
import { topicLimits } from "../topics.js";
import { compareStrings, normalizeTopicTitle } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { depthOf, getTopic, isLive, subtreeItems } from "./state.js";
import type { TopicNode, TopicTreeState } from "./state.js";
import { foldTerm, guessLanguage, stopwordSet, topicNamingLanguageOf } from "./stopwords/index.js";
import type { TopicNamingLanguage } from "./stopwords/index.js";

/** What the fallback reads of an item: its text and the language its row declares. */
export interface FallbackText {
  /** Title, idea and the start of the body: whatever names the item's subject. */
  text: string;
  /** A BCP 47 code, or `und` when unknown. */
  language: string;
}

export interface FallbackNameOptions {
  /** The library's content language (`pt-BR`). */
  contentLanguage: string;
  /** Content-language items a topic needs (`naming.fallbackMinItems`). */
  minItems: number;
  /** Terms in a name (`naming.fallbackMaxTerms`). */
  maxTerms: number;
  minTermLength?: number;
  titleMaxLength?: number;
}

export type FallbackSkipReason =
  "language_unsupported" | "too_few_items" | "no_terms" | "duplicate_title";

export interface FallbackName {
  topicId: string;
  /** Surface forms of the chosen terms, best first. */
  terms: string[];
  /** The terms joined with commas. */
  label: string;
  /** `Parent label › label`, or the label alone under the root or an unnamed parent. */
  title: string;
}

export interface FallbackResult {
  names: Map<string, FallbackName>;
  skipped: Map<string, FallbackSkipReason>;
}

/** The separator between a parent's label and a provisional label. */
export const provisionalTitleSeparator = " › ";

const defaultMinTermLength = 3;
/** Terms tried for a title that collides with a sibling's. */
const widenedTermsMax = 6;

/** A topic's own label: a provisional title keeps only its last segment. */
export function topicLabelOf(node: Pick<TopicNode, "title" | "nameSource">): string | null {
  if (node.title === null) return null;
  if (node.nameSource !== "tfidf") return node.title;
  const at = node.title.lastIndexOf(provisionalTitleSeparator);
  return at < 0 ? node.title : node.title.slice(at + provisionalTitleSeparator.length);
}

/**
 * A content-key order of topics that does not depend on IDs (D22): the smallest content hashes of
 * the topic's items, then the ID. A replay with fresh UUIDs and the same content orders alike.
 */
export function topicOrderKey(state: TopicTreeState, topicId: string): string {
  const hashes = new Set<string>();
  for (const item of subtreeItems(state, topicId)) {
    const hash = state.items.get(item)?.contentHash;
    if (hash) hashes.add(hash);
  }
  return [...hashes].sort(compareStrings).slice(0, 3).join(":");
}

/** Keys of the items whose text the fallback needs for `targets`: their parents' subtrees. */
export function fallbackScope(state: TopicTreeState, targets: readonly string[]): ItemKey[] {
  const scope = new Set<ItemKey>();
  for (const id of targets) {
    const node = state.topics.get(id);
    if (!node) continue;
    const root = node.parentId ?? id;
    for (const item of subtreeItems(state, root)) scope.add(item);
  }
  return [...scope].sort(compareStrings);
}

const termSplit = /[^\p{L}\p{N}-]+/u;

/** Distinct terms of a text: folded form to first surface form. */
function termsOf(
  text: string,
  stopwords: ReadonlySet<string>,
  minLength: number
): Map<string, string> {
  const output = new Map<string, string>();
  for (const token of text.split(termSplit)) {
    const surface = token.replace(/^-+|-+$/gu, "").toLowerCase();
    if (surface.length < minLength || /^\p{N}+$/u.test(surface)) continue;
    const key = foldTerm(surface);
    if (stopwords.has(key) || output.has(key)) continue;
    output.set(key, surface);
  }
  return output;
}

interface ItemTerms {
  terms: Map<string, string>;
}

interface GroupStats {
  /** Content-language items in the subtree. */
  n: number;
  df: Map<string, number>;
}

/**
 * Provisional names for `targets` (live topic IDs). Targets are named top-down, so a title can
 * avoid the terms its ancestors use, and a sibling title already taken (accent- and
 * case-insensitive, I7) is never repeated.
 */
export function provisionalNames(
  state: TopicTreeState,
  targets: readonly string[],
  texts: ReadonlyMap<ItemKey, FallbackText>,
  options: FallbackNameOptions
): FallbackResult {
  const names = new Map<string, FallbackName>();
  const skipped = new Map<string, FallbackSkipReason>();
  const language: TopicNamingLanguage | null = topicNamingLanguageOf(options.contentLanguage);
  if (language === null) {
    for (const id of targets) skipped.set(id, "language_unsupported");
    return { names, skipped };
  }
  const minLength = options.minTermLength ?? defaultMinTermLength;
  const titleMax = options.titleMaxLength ?? topicLimits.titleMaxLength;
  const stopwords = stopwordSet(language);

  // Terms of every content-language note in scope; a note whose row says `und` is read by its text.
  const items = new Map<ItemKey, ItemTerms>();
  const globalDf = new Map<string, number>();
  const surfaces = new Map<string, Map<string, number>>();
  const addItem = (key: ItemKey): void => {
    if (items.has(key) || state.items.get(key)?.kind !== "note") return;
    const entry = texts.get(key);
    if (!entry) return;
    const declared = topicNamingLanguageOf(entry.language);
    const itemLanguage = declared ?? guessLanguage(entry.text).language;
    if (itemLanguage !== language) return;
    const terms = termsOf(entry.text, stopwords, minLength);
    items.set(key, { terms });
    for (const [folded, surface] of terms) {
      globalDf.set(folded, (globalDf.get(folded) ?? 0) + 1);
      const forms = surfaces.get(folded) ?? new Map<string, number>();
      forms.set(surface, (forms.get(surface) ?? 0) + 1);
      surfaces.set(folded, forms);
    }
  };
  for (const key of fallbackScope(state, targets)) addItem(key);
  const contentTotal = items.size;
  const display = (folded: string): string => {
    const forms = surfaces.get(folded);
    if (!forms) return folded;
    return [...forms].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))[0]?.[0] ?? folded;
  };

  const groups = new Map<string, GroupStats>();
  const groupOf = (topicId: string): GroupStats => {
    let group = groups.get(topicId);
    if (group) return group;
    const df = new Map<string, number>();
    let n = 0;
    for (const key of subtreeItems(state, topicId)) {
      const item = items.get(key);
      if (!item) continue;
      n += 1;
      for (const folded of item.terms.keys()) df.set(folded, (df.get(folded) ?? 0) + 1);
    }
    group = { n, df };
    groups.set(topicId, group);
    return group;
  };

  const targetSet = new Set(targets);
  const taken = new Map<string, Set<string>>();
  const takenTitles = (parentId: string): Set<string> => {
    let set = taken.get(parentId);
    if (!set) {
      set = new Set();
      for (const childId of getTopic(state, parentId).children) {
        const child = getTopic(state, childId);
        // A sibling that is itself renamed in this run gives up its title.
        if (child.title !== null && !targetSet.has(childId)) {
          set.add(normalizeTopicTitle(child.title));
        }
      }
      taken.set(parentId, set);
    }
    return set;
  };
  const ancestorTerms = (topicId: string): Set<string> => {
    const used = new Set<string>();
    let parent = getTopic(state, topicId).parentId;
    while (parent !== null) {
      const node = getTopic(state, parent);
      if (node.title !== null) {
        for (const token of node.title.split(termSplit)) {
          const folded = foldTerm(token.replace(/^-+|-+$/gu, ""));
          if (folded) used.add(folded);
        }
      }
      parent = node.parentId;
    }
    return used;
  };

  const ordered = [...new Set(targets)]
    .filter((id) => state.topics.has(id) && isLive(getTopic(state, id)))
    .map((id) => ({ id, depth: depthOf(state, id), key: topicOrderKey(state, id) }))
    .sort(
      (a, b) => a.depth - b.depth || compareStrings(a.key, b.key) || compareStrings(a.id, b.id)
    );

  for (const { id } of ordered) {
    const node = getTopic(state, id);
    const parentId = node.parentId;
    if (parentId === null) continue;
    const own = groupOf(id);
    if (own.n < options.minItems) {
      skipped.set(id, "too_few_items");
      continue;
    }
    const parent = groupOf(parentId);
    const scoreTerms = (avoid: ReadonlySet<string>) => {
      const found: Array<{ term: string; score: number }> = [];
      for (const [term, count] of own.df) {
        if ((count < 2 && own.n > 2) || avoid.has(term)) continue;
        const share = count / own.n;
        const idf = Math.log(contentTotal / (globalDf.get(term) ?? 1));
        const outside = (parent.df.get(term) ?? count) - count;
        const siblingIdf = Math.log((parent.n - own.n + 1) / (outside + 1));
        found.push({ term, score: share * (idf + Math.max(0, siblingIdf)) });
      }
      return found.sort((a, b) => b.score - a.score || compareStrings(a.term, b.term));
    };
    // A child avoids the words its ancestors' titles use; when that leaves it nothing (a small
    // topic whose few frequent words its parent took), it may repeat them rather than stay unnamed.
    let scored = scoreTerms(ancestorTerms(id));
    if (scored.length === 0) scored = scoreTerms(new Set());
    if (scored.length === 0) {
      skipped.set(id, "no_terms");
      continue;
    }
    const parentLabel = parentId === state.rootId ? null : topicLabelOf(getTopic(state, parentId));
    const used = takenTitles(parentId);
    let chosen: FallbackName | null = null;
    for (
      let count = Math.min(options.maxTerms, scored.length);
      count <= widenedTermsMax;
      count += 1
    ) {
      if (count > scored.length) break;
      const terms = scored.slice(0, count).map((entry) => display(entry.term));
      const label = terms.join(", ");
      const title = parentLabel ? `${parentLabel}${provisionalTitleSeparator}${label}` : label;
      if (title.length > titleMax) break;
      if (used.has(normalizeTopicTitle(title))) continue;
      chosen = { topicId: id, terms, label, title };
      break;
    }
    if (!chosen) {
      skipped.set(id, "duplicate_title");
      continue;
    }
    used.add(normalizeTopicTitle(chosen.title));
    names.set(id, chosen);
  }
  return { names, skipped };
}
