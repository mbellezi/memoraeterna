// Provisional topic names without an LLM: "Parent › TF-IDF terms", with pt/en
// stopwords. A term scores high when many of the node's items contain it, it is
// rare overall, and it is rare among the parent's other items.
import type { TopicTree } from "./tree.js";

export interface NamingInput {
  text: string;
  lang: "pt" | "en";
}

export interface TopicName {
  terms: string[];
  /** Terms joined, e.g. "fotossíntese, clorofila". */
  label: string;
  /** Provisional display name "Parent label › label" (the root's children have no prefix). */
  path: string;
  /** Dominant language of the node's items. */
  lang: "pt" | "en";
}

export interface NamingOptions {
  maxTerms?: number;
  minTermLength?: number;
  /**
   * Owner decision 17: names are always in the content language. When set, only
   * items in this language (and its stopwords) produce terms; a topic with fewer
   * than `minContentItems` of them gets a localized "unnamed" placeholder.
   */
  contentLanguage?: "pt" | "en";
  minContentItems?: number;
}

const unnamedLabel = { pt: "Tópico sem nome", en: "Unnamed topic" } as const;

const englishStopwords =
  "a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how however i if in into is it its itself just like many may me might more most much must my myself no nor not now of off often on once one only or other our ours ourselves out over own same she should since so some such than that the their theirs them themselves then there these they this those through thus to too two under until up upon us used using very was we were what when where which while who whom why will with within without would yet you your yours yourself yourselves first second new known called often several including include includes included became become becomes later early made make makes per well even still another among around based each either however although whether three four five six many most much often also".split(
    " "
  );

const portugueseStopwords =
  "a à ao aos aquela aquelas aquele aqueles aquilo as às até com como contra da das de dela delas dele deles depois do dos e é ela elas ele eles em entre era eram essa essas esse esses esta estas este estes eu foi foram há isso isto já lhe lhes mais mas me mesmo meu minha muito muitos na não nas nem no nos nós num numa o os ou para pela pelas pelo pelos por qual quando que quem se sem ser seu seus sua suas são só também te tem têm ter teu tua um uma umas uns você vocês sobre após cada onde outro outra outros outras pode podem sendo sido seja sejam assim então ainda bem apenas desde durante embora enquanto porque pois todo toda todos todas tanto tão vez vezes forma partir através sob dois duas três primeiro primeira segundo segunda grande grandes maior maiores parte geral exemplo chamado chamada conhecido conhecida usado usada".split(
    " "
  );

const stopwords = new Set(
  [...englishStopwords, ...portugueseStopwords].map((word) => foldTerm(word))
);
const stopwordsByLanguage = {
  pt: new Set(portugueseStopwords.map((word) => foldTerm(word))),
  en: new Set(englishStopwords.map((word) => foldTerm(word)))
};

function foldTerm(term: string): string {
  return term.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Distinct terms of a text: key = folded form, value = first surface form. */
export function terms(
  text: string,
  minLength = 3,
  stopSet: ReadonlySet<string> = stopwords
): Map<string, string> {
  const output = new Map<string, string>();
  for (const token of text.split(/[^\p{L}\p{N}-]+/u)) {
    const surface = token.replace(/^-+|-+$/g, "").toLowerCase();
    if (surface.length < minLength || /^\p{N}+$/u.test(surface)) continue;
    const key = foldTerm(surface);
    if (stopSet.has(key)) continue;
    if (!output.has(key)) output.set(key, surface);
  }
  return output;
}

export function nameTopics(
  tree: TopicTree,
  inputOf: (item: number) => NamingInput,
  options: NamingOptions = {}
): Map<number, TopicName> {
  const maxTerms = options.maxTerms ?? 3;
  const minLength = options.minTermLength ?? 3;
  const itemTerms = new Map<number, Map<string, string>>();
  const globalDf = new Map<string, number>();
  const surfaceCounts = new Map<string, Map<string, number>>();
  const langOf = new Map<number, "pt" | "en">();
  const contentLanguage = options.contentLanguage;
  const minContentItems = options.minContentItems ?? 2;
  const stopSet = contentLanguage ? stopwordsByLanguage[contentLanguage] : stopwords;
  for (const item of tree.itemNode.keys()) {
    const input = inputOf(item);
    const found =
      contentLanguage && input.lang !== contentLanguage
        ? new Map<string, string>()
        : terms(input.text, minLength, stopSet);
    itemTerms.set(item, found);
    langOf.set(item, input.lang);
    for (const [key, surface] of found) {
      globalDf.set(key, (globalDf.get(key) ?? 0) + 1);
      const surfaces = surfaceCounts.get(key) ?? new Map<string, number>();
      surfaces.set(surface, (surfaces.get(surface) ?? 0) + 1);
      surfaceCounts.set(key, surfaces);
    }
  }
  const contentTotal = contentLanguage
    ? [...langOf.values()].filter((lang) => lang === contentLanguage).length
    : itemTerms.size;
  const displayOf = (key: string): string => {
    const surfaces = surfaceCounts.get(key);
    if (!surfaces) return key;
    return (
      [...surfaces.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? key
    );
  };

  // Document frequency per node over its subtree items (post-order merge).
  const nodeDf = new Map<number, Map<string, number>>();
  /** Items that can name the node (content-language items, or all). */
  const nodeCount = new Map<number, number>();
  const counts = (item: number): boolean =>
    !contentLanguage || langOf.get(item) === contentLanguage;
  const collect = (id: number): Map<string, number> => {
    const node = tree.node(id);
    const df = new Map<string, number>();
    let count = node.items.filter(counts).length;
    for (const item of node.items) {
      for (const key of itemTerms.get(item)?.keys() ?? []) df.set(key, (df.get(key) ?? 0) + 1);
    }
    for (const child of node.children) {
      for (const [key, value] of collect(child)) df.set(key, (df.get(key) ?? 0) + value);
      count += nodeCount.get(child) ?? 0;
    }
    nodeDf.set(id, df);
    nodeCount.set(id, count);
    return df;
  };
  collect(tree.rootId);

  const names = new Map<number, TopicName>();
  const assign = (id: number, parentTerms: Set<string>, parentLabel: string): void => {
    const node = tree.node(id);
    const df = nodeDf.get(id) ?? new Map<string, number>();
    const parentId = node.parent;
    const parentDf = parentId === null ? null : nodeDf.get(parentId);
    const n = nodeCount.get(id) ?? 0;
    const parentN = parentId === null ? contentTotal : (nodeCount.get(parentId) ?? 0);
    const scored: { key: string; score: number }[] = [];
    for (const [key, count] of df) {
      if (count < 2 && n > 2) continue;
      if (parentTerms.has(key)) continue;
      const share = count / Math.max(1, n);
      const idf = Math.log(contentTotal / (globalDf.get(key) ?? 1));
      const outside = (parentDf?.get(key) ?? count) - count;
      const siblingIdf = Math.log((parentN - n + 1) / (outside + 1));
      scored.push({ key, score: share * (idf + Math.max(0, siblingIdf)) });
    }
    scored.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    const chosen =
      contentLanguage && n < minContentItems
        ? []
        : scored.slice(0, maxTerms).map((entry) => entry.key);
    let pt = 0;
    let en = 0;
    for (const item of tree.subtreeItems(id)) {
      if (langOf.get(item) === "en") en += 1;
      else pt += 1;
    }
    const label =
      chosen.map(displayOf).join(", ") ||
      (contentLanguage ? unnamedLabel[contentLanguage] : "(unnamed)");
    const isRoot = id === tree.rootId;
    const path = isRoot ? "" : parentLabel ? `${parentLabel} › ${label}` : label;
    names.set(id, {
      terms: chosen.map(displayOf),
      label,
      path,
      lang: contentLanguage ?? (en > pt ? "en" : "pt")
    });
    const nextTerms = new Set([...parentTerms, ...chosen]);
    for (const child of node.children) assign(child, nextTerms, isRoot ? "" : label);
  };
  assign(tree.rootId, new Set(), "");
  return names;
}
