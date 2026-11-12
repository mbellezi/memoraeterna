// The Settings search (F5 T159, spec 3.8; made tolerant by T161 for the held-out queries of X9): a
// pure function over the registry v2 and the message catalog. It matches what a person types
// against the entry's label in their language, its keywords (the registry's English synonyms and
// task words, matched whatever the language, and the same words in the person's language, kept in
// `settingsShell.words`) and its help text, folding case and accents. It ranks, in this order: the
// label starts with the query; the label has a word that starts with each word of the query; a
// keyword does; the help text does. Small words of the person's language ("how", "onde", "para")
// are not asked for. An entry that has every word, by the start of a word, comes first. After those
// come the entries that have half of the words, a word one slip away from a real one (a swapped or
// missing letter) counting too, ranked by how rare the words they have are; they fill a list up to
// eight. The hit carries the label's matched ranges so the list can underline and embolden them.
import { messages as catalog, type LanguageCode } from "@app/i18n";

import {
  settingSlug,
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

/**
 * Small words that carry no setting ("how", "onde", "para") and the generic verbs of a request
 * ("change", "quero"): they are not asked for while the query has other words. Folded, per language;
 * English counts in every language because the keywords are English.
 */
const smallWords: Readonly<Record<LanguageCode, string>> = {
  en: "a an the of to in on at for by with and or is are was be it its this that these those my me i am you your we our do does did how what which when where why who can could will would should not no any all as from into about so if then than too very more most also only just one some there their them up out off over own let make set turn get want need see show change use choose pick",
  "pt-BR":
    "o a os as um uma uns umas de do da dos das em no na nos nas por pelo pela para pra com sem e ou que qual quais quando onde como quem meu minha meus minhas seu sua seus suas eu me se ao aos sao ser esta este esse essa isso isto mais muito tambem so apenas ja nao sim ver quero mudar trocar alterar fazer deixar usar escolher colocar ativar desativar",
  es: "el la los las un una unos unas de del al en con sin por para y o que cual cuales cuando donde como quien mi mis tu tus su sus yo me se es son ser esta este eso esto mas muy tambien solo ya no si ver quiero cambiar hacer dejar usar elegir poner activar desactivar",
  fr: "le la les un une des du de d l au aux en dans sur avec sans pour par et ou que qui quel quelle quels quelles quand comment mon ma mes ton ta tes son sa ses je me se est sont etre ce cet cette ces plus tres aussi seulement deja ne pas non oui voir veux changer faire laisser utiliser choisir mettre activer desactiver",
  it: "il lo la i gli le un uno una di del dello della dei degli delle in con su per tra fra a da e o che chi quale quali quando dove come mio mia miei mie tuo suo io mi si sono essere questo questa piu molto anche solo gia non vedere voglio cambiare fare lasciare usare scegliere mettere attivare disattivare"
};
const smallWordSets = new Map<LanguageCode, ReadonlySet<string>>();
function smallWordsOf(locale: LanguageCode): ReadonlySet<string> {
  let set = smallWordSets.get(locale);
  if (!set) {
    set = new Set([...smallWords.en.split(" "), ...(smallWords[locale] ?? "").split(" ")]);
    smallWordSets.set(locale, set);
  }
  return set;
}

/** One slip apart: a letter swapped, missing, added or changed (optimal string alignment <= 1). */
function oneSlipApart(a: string, b: string): boolean {
  if (a === b) return true;
  const gap = a.length - b.length;
  if (gap > 1 || gap < -1) return false;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  if (start === a.length || start === b.length) return true;
  if (gap === 0) {
    if (a.slice(start + 1) === b.slice(start + 1)) return true;
    return (
      a[start] === b[start + 1] &&
      a[start + 1] === b[start] &&
      a.slice(start + 2) === b.slice(start + 2)
    );
  }
  return gap === 1 ? a.slice(start + 1) === b.slice(start) : a.slice(start) === b.slice(start + 1);
}

/** A word a query word is one slip from: the whole word, or its start as long as the query word. */
const fuzzyMatches = (token: string, word: string): boolean =>
  token.length >= 4 &&
  word.length >= token.length - 1 &&
  (oneSlipApart(token, word) || oneSlipApart(token, word.slice(0, token.length)));

interface TokenMatch {
  tier: 1 | 2 | 3;
  fuzzy: boolean;
  /** Where in the label (as written) it matched, for a label word typed correctly. */
  label?: [number, number];
}

/**
 * The start of a word, or the word with an ending on it: "troubleshooting" has the keyword
 * "troubleshoot" (a word of five letters or more, and an ending of up to four).
 */
const hasWord = (word: Word, token: string): boolean =>
  word.text.startsWith(token) ||
  (word.text.length >= 5 &&
    token.length > word.text.length &&
    token.length - word.text.length <= 4 &&
    token.startsWith(word.text));

function matchToken(
  token: string,
  labelWords: Word[],
  keywordWords: Word[],
  helpWords: Word[]
): TokenMatch | null {
  const inLabel = labelWords.find((word) => hasWord(word, token));
  if (inLabel)
    return {
      tier: 1,
      fuzzy: false,
      label: [inLabel.start, inLabel.start + Math.min(token.length, inLabel.text.length)]
    };
  if (keywordWords.some((word) => hasWord(word, token))) return { tier: 2, fuzzy: false };
  if (helpWords.some((word) => hasWord(word, token))) return { tier: 3, fuzzy: false };
  if (labelWords.some((word) => fuzzyMatches(token, word.text))) return { tier: 1, fuzzy: true };
  if (keywordWords.some((word) => fuzzyMatches(token, word.text))) return { tier: 2, fuzzy: true };
  if (helpWords.some((word) => fuzzyMatches(token, word.text))) return { tier: 3, fuzzy: true };
  return null;
}

const tierWeight = { 1: 3, 2: 2, 3: 1 } as const;

/** How many words of a query an entry needs to be listed after the entries that have them all. */
const wordsNeeded = (count: number): number => (count > 0 ? 1 : 0);

/** The list never grows past this many with approximate entries; exact ones are all kept. */
const listedWithApproximate = 8;

export function searchSettings(
  query: string,
  locale: LanguageCode,
  registry: readonly SettingEntryV2[] = settingsRegistryV2,
  messages: SettingsMessages = catalog
): SettingHit[] {
  const foldedQuery = foldText(query).trim().replace(/\s+/gu, " ");
  const allTokens = wordsOf(foldedQuery).map((word) => word.text);
  if (allTokens.length === 0) return [];
  const small = smallWordsOf(locale);
  const asked = allTokens.filter((token) => token.length > 1 && !small.has(token));
  const tokens = asked.length > 0 ? asked : allTokens;

  const candidates = registry.map((entry, order) => {
    const foldedLabel = foldText(textOf(messages, locale, entry.labelKey));
    const labelWords = wordsOf(foldedLabel);
    // The English keywords of the registry, and the person's own language's (`settingsShell.words`).
    const keywordWords = [
      ...entry.keywords,
      textOf(messages, locale, `settingsShell.words.${settingSlug(entry.id)}`)
    ].flatMap((keyword) => wordsOf(foldText(keyword)));
    const helpWords = wordsOf(foldText(textOf(messages, locale, entry.helpKey)));
    return {
      entry,
      order,
      foldedLabel,
      matches: tokens.map((token) => matchToken(token, labelWords, keywordWords, helpWords))
    };
  });

  // How rare each word is among the entries: a word that every entry has says little.
  const rarity = tokens.map((_, index) => {
    const have = candidates.filter((candidate) => candidate.matches[index] !== null).length;
    return Math.log(1 + candidates.length / Math.max(1, have));
  });

  const strict: Array<SettingHit & { order: number; first: number }> = [];
  const loose: Array<SettingHit & { score: number; order: number }> = [];
  for (const { entry, order, matches, foldedLabel } of candidates) {
    const found = matches.filter((match): match is TokenMatch => match !== null);
    if (found.length < wordsNeeded(tokens.length)) continue;
    const worst = Math.max(...found.map((match) => match.tier)) as 1 | 2 | 3;
    const hit = {
      id: entry.id,
      section: entry.section,
      group: entry.group,
      tier: worst as SettingHitTier,
      matchedIn: (worst === 1
        ? "label"
        : worst === 2
          ? "keyword"
          : "help") as SettingHit["matchedIn"],
      labelRanges: mergeRanges(found.flatMap((match) => (match.label ? [match.label] : []))),
      order
    };
    if (found.length === tokens.length && found.every((match) => !match.fuzzy)) {
      strict.push({
        ...hit,
        tier: worst === 1 && foldedLabel.startsWith(foldedQuery) ? 0 : hit.tier,
        first: Math.min(...found.map((match) => match.label?.[0] ?? Number.POSITIVE_INFINITY))
      });
    } else {
      const score = matches.reduce(
        (sum, match, index) =>
          match
            ? sum + (rarity[index] ?? 1) * tierWeight[match.tier] * (match.fuzzy ? 0.8 : 1)
            : sum,
        0
      );
      loose.push({ ...hit, score });
    }
  }

  const exact = strict.sort((a, b) => a.tier - b.tier || a.first - b.first || a.order - b.order);
  const approximate = loose
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, Math.max(0, listedWithApproximate - exact.length));
  return [...exact, ...approximate].map(({ id, section, group, tier, matchedIn, labelRanges }) => ({
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
