// Stopwords of the five content languages and a stopword-score language guess (plan 4.1 Naming:
// provisional names come only from content-language items, with that language's stopwords).
// The lists are hand-written for this project, so no third-party notice applies.
import { englishStopwords } from "./en.js";
import { spanishStopwords } from "./es.js";
import { frenchStopwords } from "./fr.js";
import { italianStopwords } from "./it.js";
import { portugueseStopwords } from "./pt.js";

/** The languages a topic can be named in without an LLM (the app's five content languages). */
export const topicNamingLanguages = ["en", "pt", "es", "fr", "it"] as const;
export type TopicNamingLanguage = (typeof topicNamingLanguages)[number];

const rawLists: Record<TopicNamingLanguage, readonly string[]> = {
  en: englishStopwords,
  pt: portugueseStopwords,
  es: spanishStopwords,
  fr: frenchStopwords,
  it: italianStopwords
};

/** Lowercase, accents removed: the form in which terms and stopwords are compared. */
export function foldTerm(term: string): string {
  return term
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** The primary language subtag of a BCP 47 code, lowercase (`pt-BR` is `pt`), or "". */
function primarySubtag(code: string | null | undefined): string {
  return code?.trim().toLowerCase().split(/[-_]/u)[0] ?? "";
}

/**
 * The topic-naming language of a BCP 47 code (`pt-BR`, `pt`, `en-US`), or null when the code names
 * no supported language or is unknown (`und`).
 */
export function topicNamingLanguageOf(code: string | null | undefined): TopicNamingLanguage | null {
  const primary = primarySubtag(code);
  return (topicNamingLanguages as readonly string[]).includes(primary)
    ? (primary as TopicNamingLanguage)
    : null;
}

/** True when two language codes name the same language (`pt` and `pt-BR` do). */
export function sameContentLanguage(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = primarySubtag(a);
  return left !== "" && left === primarySubtag(b);
}

const foldedSets = new Map<TopicNamingLanguage, ReadonlySet<string>>();

/** The stopwords of a language, folded (accent- and case-insensitive). */
export function stopwordSet(language: TopicNamingLanguage): ReadonlySet<string> {
  let set = foldedSets.get(language);
  if (!set) {
    set = new Set(rawLists[language].map(foldTerm));
    foldedSets.set(language, set);
  }
  return set;
}

// Detection scores a word for every language whose list holds it, 1 divided by the number of such
// languages (accents kept): a word only Portuguese has counts fully, "mais" (Portuguese and
// French) half for each, "que" a third. The many function words the Romance languages share
// therefore cannot tip a guess, yet short texts still gather evidence.
let owners: Map<string, TopicNamingLanguage[]> | null = null;

function wordOwners(): Map<string, TopicNamingLanguage[]> {
  if (owners) return owners;
  const found = new Map<string, TopicNamingLanguage[]>();
  for (const language of topicNamingLanguages) {
    for (const word of rawLists[language]) {
      const lowered = word.toLowerCase();
      const list = found.get(lowered) ?? [];
      if (!list.includes(language)) list.push(language);
      found.set(lowered, list);
    }
  }
  owners = found;
  return found;
}

export interface LanguageGuess {
  /** The language with clearly the highest score, or null when no language leads. */
  language: TopicNamingLanguage | null;
  /** Stopword score per language. */
  hits: Record<TopicNamingLanguage, number>;
}

/** Tokens of a text: letters and digits (with inner apostrophes and hyphens), lowercase. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’-]+/u)
    .map((token) => token.replace(/^[-'’]+|[-'’]+$/gu, ""))
    .filter((token) => token.length > 0);
}

/**
 * Guesses the language of a text by its stopwords: a score of at least `minScore` and a lead of at
 * least `minLead` over the runner-up. A heuristic for note text and generated names; the `language`
 * fields of notes and names stay the primary evidence.
 */
export function guessLanguage(text: string, minScore = 2, minLead = 1): LanguageGuess {
  const hits = { en: 0, pt: 0, es: 0, fr: 0, it: 0 } as Record<TopicNamingLanguage, number>;
  const words = wordOwners();
  for (const token of tokenize(text)) {
    // "l'homme" and "dell'arte" carry an article before the apostrophe.
    const owning = words.get(token) ?? words.get(token.split(/['’]/u)[0] ?? "");
    if (!owning) continue;
    for (const language of owning) hits[language] += 1 / owning.length;
  }
  const ranked = topicNamingLanguages
    .map((language) => ({ language, score: hits[language] }))
    .sort((a, b) => b.score - a.score);
  const [top, next] = ranked;
  const language =
    top && next && top.score >= minScore && top.score - next.score >= minLead ? top.language : null;
  return { language, hits };
}
