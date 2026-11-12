// The Settings search (F5 T159, spec 3.8): a pure function over the registry v2 and the message
// catalog. It matches what a person types against the entry's label in their language, the
// English keywords the copy card writes (synonyms and task words, matched whatever the language),
// and the help text, folding case and accents. It ranks, in this order: the label starts with the
// query; the label has a word that starts with each word of the query; a keyword does; the help
// text does. Every word of the query must match somewhere; the best tier of an entry is its worst
// word's. The hit carries the label's matched ranges so the list can underline and embolden them.
import { messages as catalog, type LanguageCode } from "@app/i18n";

import {
  settingsRegistryV2,
  type SettingEntryV2,
  type SettingsSectionId
} from "./settings-registry";

/** 0: the label starts with the query; 1: a label word; 2: a keyword; 3: the help text. */
export type SettingHitTier = 0 | 1 | 2 | 3;

export interface SettingHit {
  id: string;
  section: SettingsSectionId;
  group: string;
  tier: SettingHitTier;
  /** Where the best-ranked word matched. */
  matchedIn: "label" | "keyword" | "help";
  /** Half-open `[start, end)` ranges of the label (as written) the query matched, to underline; may be empty. */
  labelRanges: Array<[number, number]>;
}

type MessageTree = { readonly [key: string]: string | MessageTree };
export type SettingsMessages = Readonly<Record<LanguageCode, MessageTree>>;

/**
 * Lower-cases and removes accents one character at a time, so that an index of the folded text is
 * an index of the original (a character that would fold to more or fewer units stays as it is).
 */
export function foldText(text: string): string {
  let folded = "";
  for (const char of text) {
    const simple = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    folded +=
      simple.length === char.length
        ? simple
        : char.toLowerCase().length === char.length
          ? char.toLowerCase()
          : char;
  }
  return folded;
}

interface Word {
  text: string;
  start: number;
}

const wordsOf = (folded: string): Word[] =>
  [...folded.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    text: match[0],
    start: match.index
  }));

function lookup(tree: MessageTree | undefined, key: string): string | undefined {
  let node: string | MessageTree | undefined = tree;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** The copy in the person's language, else in English (the fallback of every key). */
function textOf(messages: SettingsMessages, locale: LanguageCode, key: string): string {
  return lookup(messages[locale], key) ?? lookup(messages.en, key) ?? "";
}

export function searchSettings(
  query: string,
  locale: LanguageCode,
  registry: readonly SettingEntryV2[] = settingsRegistryV2,
  messages: SettingsMessages = catalog
): SettingHit[] {
  const foldedQuery = foldText(query).trim().replace(/\s+/gu, " ");
  const tokens = wordsOf(foldedQuery).map((word) => word.text);
  if (tokens.length === 0) return [];

  const hits: Array<SettingHit & { order: number; first: number }> = [];
  registry.forEach((entry, order) => {
    const label = textOf(messages, locale, entry.labelKey);
    const foldedLabel = foldText(label);
    const labelWords = wordsOf(foldedLabel);
    const keywordWords = entry.keywords.flatMap((keyword) => wordsOf(foldText(keyword)));
    const helpWords = wordsOf(foldText(textOf(messages, locale, entry.helpKey)));

    let tier: SettingHitTier = foldedLabel.startsWith(foldedQuery) ? 0 : 1;
    let matchedIn: SettingHit["matchedIn"] = "label";
    const labelRanges: Array<[number, number]> = [];
    let first = Number.POSITIVE_INFINITY;
    let everyTokenMatches = true;
    for (const token of tokens) {
      const inLabel = labelWords.find((word) => word.text.startsWith(token));
      if (inLabel) {
        labelRanges.push([inLabel.start, inLabel.start + token.length]);
        first = Math.min(first, inLabel.start);
        continue;
      }
      const wordTier: SettingHitTier | null = keywordWords.some((word) =>
        word.text.startsWith(token)
      )
        ? 2
        : helpWords.some((word) => word.text.startsWith(token))
          ? 3
          : null;
      if (wordTier === null) {
        everyTokenMatches = false;
        break;
      }
      if (wordTier > tier) {
        tier = wordTier;
        matchedIn = wordTier === 2 ? "keyword" : "help";
      }
    }
    if (!everyTokenMatches) return;
    hits.push({
      id: entry.id,
      section: entry.section,
      group: entry.group,
      tier,
      matchedIn,
      labelRanges: mergeRanges(labelRanges),
      order,
      first
    });
  });

  return hits
    .sort((a, b) => a.tier - b.tier || a.first - b.first || a.order - b.order)
    .map(({ id, section, group, tier, matchedIn, labelRanges }) => ({
      id,
      section,
      group,
      tier,
      matchedIn,
      labelRanges
    }));
}

/** Overlapping or touching ranges become one. */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}
