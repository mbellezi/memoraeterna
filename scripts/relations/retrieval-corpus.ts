import { createRng, deriveSeed } from "@app/domain/topic-tree";
import type { Rng } from "@app/domain/topic-tree";

/**
 * A reproducible corpus of atomic notes for the retrieval benchmarks (`explain-retrieval.ts`).
 * The library seed of `scripts/objects/synthetic-library.ts` gives SEED30K its sources, chunks and
 * 30,000 notes, but every note reads "Note 17 / Idea 17", which no full-text or trigram index can
 * be judged on. This module rewrites those notes with text and vectors that have the statistics
 * retrieval depends on: a Zipf-distributed vocabulary in two languages (one of them accented), a
 * third of the tokens function words, topics whose words and embeddings correlate, and short
 * titles, one-sentence ideas and a paragraph or two of body. The document-frequency profile
 * (a long tail of rare words, a few thousand words in 1% to 10% of the notes) is tuned to the
 * ENV-C library, 18,632 real notes in English and Portuguese: 90 thousand lexemes, half of them
 * in a single note.
 *
 * Every note is a pure function of (seed, index): the text and the vector come from the same
 * derived seed, so batches, reruns and random access agree.
 */

export type CorpusLanguage = "en" | "pt";

export interface CorpusNote {
  index: number;
  language: CorpusLanguage;
  topic: number;
  title: string;
  idea: string;
  body: string;
}

export interface CorpusOptions {
  seed: number;
  /** Topics shared by the text and the vectors (default 500). */
  topics?: number;
}

const stopwords: Record<CorpusLanguage, readonly string[]> = {
  en: [
    "the",
    "of",
    "and",
    "to",
    "in",
    "is",
    "that",
    "it",
    "for",
    "with",
    "as",
    "on",
    "are",
    "by",
    "this",
    "from",
    "an",
    "be",
    "or",
    "at",
    "which",
    "can",
    "not",
    "more",
    "than"
  ],
  pt: [
    "de",
    "a",
    "o",
    "que",
    "e",
    "do",
    "da",
    "em",
    "um",
    "para",
    "com",
    "não",
    "uma",
    "os",
    "no",
    "se",
    "na",
    "por",
    "mais",
    "as",
    "dos",
    "como",
    "mas",
    "ao",
    "é"
  ]
};

const consonants = [
  "b",
  "c",
  "d",
  "f",
  "g",
  "l",
  "m",
  "n",
  "p",
  "r",
  "s",
  "t",
  "v",
  "z",
  "br",
  "tr"
];
const vowels = ["a", "e", "i", "o", "u", "ia", "eo"];
const suffixes: Record<CorpusLanguage, readonly string[]> = {
  en: ["ing", "tion", "ness", "ment", "ity", "al", "ous", "ive", "er", "ize", "ence", "ism"],
  pt: ["ção", "mente", "ário", "ência", "idade", "ismo", "ável", "ões", "ico", "ura", "ão", "ê"]
};

/** Dimensions of the latent space the vectors are lifted from. */
const latentDimensions = 24;

const vocabularySize: Record<CorpusLanguage, number> = { en: 60_000, pt: 45_000 };

function buildVocabulary(language: CorpusLanguage, seed: number): string[] {
  const rng = createRng(deriveSeed(seed, `vocabulary:${language}`));
  const words = new Set<string>();
  while (words.size < vocabularySize[language]) {
    let word = "";
    for (let syllables = 2 + rng.int(3); syllables > 0; syllables -= 1)
      word += consonants[rng.int(consonants.length)]! + vowels[rng.int(vowels.length)]!;
    if (rng.next() < 0.55) word += suffixes[language][rng.int(suffixes[language].length)]!;
    // Portuguese words carry accents often enough to exercise the unaccenting of the index.
    if (language === "pt" && rng.next() < 0.3) word = word.replace(/a(?=[^a]*$)/u, "á");
    if (word.length >= 4) words.add(word);
  }
  return [...words];
}

/** Samples a rank with probability proportional to 1 / (rank + offset)^exponent. */
class ZipfSampler {
  private readonly cumulative: Float64Array;
  constructor(size: number, exponent: number, offset: number) {
    this.cumulative = new Float64Array(size);
    let total = 0;
    for (let rank = 0; rank < size; rank += 1) {
      total += 1 / Math.pow(rank + offset, exponent);
      this.cumulative[rank] = total;
    }
  }

  sample(rng: Rng): number {
    const target = rng.next() * this.cumulative[this.cumulative.length - 1]!;
    let low = 0;
    let high = this.cumulative.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.cumulative[middle]! < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

export class RetrievalCorpus {
  readonly topics: number;
  private readonly vocabulary: Record<CorpusLanguage, string[]>;
  private readonly background: Record<CorpusLanguage, ZipfSampler>;
  private readonly stopwordSampler: Record<CorpusLanguage, ZipfSampler>;
  private readonly topicPicker: ZipfSampler;
  /** Words of each topic, per language. */
  private readonly topicWords: Record<CorpusLanguage, string[][]>;
  private readonly centers = new Map<string, Float32Array>();
  private readonly projections = new Map<number, Float32Array[]>();

  constructor(private readonly options: CorpusOptions) {
    this.topics = options.topics ?? 500;
    this.vocabulary = {
      en: buildVocabulary("en", options.seed),
      pt: buildVocabulary("pt", options.seed)
    };
    this.background = {
      en: new ZipfSampler(this.vocabulary.en.length, 1.05, 12),
      pt: new ZipfSampler(this.vocabulary.pt.length, 1.05, 12)
    };
    this.stopwordSampler = {
      en: new ZipfSampler(stopwords.en.length, 1, 1),
      pt: new ZipfSampler(stopwords.pt.length, 1, 1)
    };
    this.topicPicker = new ZipfSampler(this.topics, 0.6, 3);
    const perTopic = 60;
    const pick = (language: CorpusLanguage, topic: number): string[] => {
      const rng = createRng(deriveSeed(options.seed, `topic:${language}:${topic}`));
      const words = new Set<string>();
      // The words of a topic are its own: drawn from the vocabulary past its most common words.
      const head = 500;
      while (words.size < perTopic)
        words.add(
          this.vocabulary[language][head + rng.int(this.vocabulary[language].length - head)]!
        );
      return [...words];
    };
    this.topicWords = {
      en: Array.from({ length: this.topics }, (_, topic) => pick("en", topic)),
      pt: Array.from({ length: this.topics }, (_, topic) => pick("pt", topic))
    };
  }

  private rngFor(index: number, label: string): Rng {
    return createRng(deriveSeed(deriveSeed(this.options.seed, index), label));
  }

  /** The topic mix of a note: its main topic and, for most notes, a second one. */
  private topicsOf(index: number): { primary: number; secondary: number } {
    const rng = this.rngFor(index, "topics");
    return { primary: this.topicPicker.sample(rng), secondary: rng.int(this.topics) };
  }

  note(index: number): CorpusNote {
    const rng = this.rngFor(index, "text");
    const language: CorpusLanguage = rng.next() < 0.35 ? "pt" : "en";
    const { primary, secondary } = this.topicsOf(index);
    const words = this.vocabulary[language];
    const contentWord = (): string => {
      const roll = rng.next();
      if (roll < 0.34) return this.topicWords[language][primary]![rng.int(60)]!;
      if (roll < 0.44) return this.topicWords[language][secondary]![rng.int(60)]!;
      return words[this.background[language].sample(rng)]!;
    };
    const phrase = (content: number, functionWordRate: number): string => {
      const tokens: string[] = [];
      for (let produced = 0; produced < content;) {
        if (tokens.length > 0 && rng.next() < functionWordRate)
          tokens.push(stopwords[language][this.stopwordSampler[language].sample(rng)]!);
        else {
          tokens.push(contentWord());
          produced += 1;
        }
      }
      return tokens.join(" ");
    };
    const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
    const title = capitalize(phrase(3 + rng.int(4), 0.15));
    const idea = `${capitalize(phrase(9 + rng.int(8), 0.5))}.`;
    const paragraphs = 1 + rng.int(3);
    const body = Array.from(
      { length: paragraphs },
      () => `${capitalize(phrase(30 + rng.int(40), 0.5))}.`
    ).join("\n\n");
    return { index, language, topic: primary, title, idea, body };
  }

  /** The latent centre of a topic. */
  private center(topic: number): Float32Array {
    let center = this.centers.get(String(topic));
    if (!center) {
      const rng = createRng(deriveSeed(this.options.seed, `center:${topic}`));
      center = Float32Array.from({ length: latentDimensions }, () => rng.gaussian());
      this.centers.set(String(topic), center);
    }
    return center;
  }

  /** The fixed random map from the latent space to `dimensions`: one unit column per latent axis. */
  private projection(dimensions: number): Float32Array[] {
    let columns = this.projections.get(dimensions);
    if (!columns) {
      const rng = createRng(deriveSeed(this.options.seed, `projection:${dimensions}`));
      columns = Array.from({ length: latentDimensions }, () => {
        const column = Float32Array.from({ length: dimensions }, () => rng.gaussian());
        normalize(column);
        return column;
      });
      this.projections.set(dimensions, columns);
    }
    return columns;
  }

  /**
   * The unit embedding of a note. Its topics' centres plus a spread give a point in a
   * `latentDimensions`-dimensional space, which a fixed random map lifts to `dimensions` with a
   * little noise: neighbours have a graded similarity and the data has the low intrinsic
   * dimension real embeddings have, so an ANN index is judged on structure and not on ties.
   */
  vector(index: number, dimensions: number): Float32Array {
    const { primary, secondary } = this.topicsOf(index);
    const rng = this.rngFor(index, `vector:${dimensions}`);
    const first = this.center(primary);
    const second = this.center(secondary);
    const columns = this.projection(dimensions);
    const vector = new Float32Array(dimensions);
    for (let axis = 0; axis < latentDimensions; axis += 1) {
      const weight = first[axis]! + 0.4 * second[axis]! + 0.5 * rng.gaussian();
      const column = columns[axis]!;
      for (let at = 0; at < dimensions; at += 1) vector[at] = vector[at]! + weight * column[at]!;
    }
    const noise = Float32Array.from({ length: dimensions }, () => rng.gaussian());
    normalize(noise);
    normalize(vector);
    for (let at = 0; at < dimensions; at += 1) vector[at] = vector[at]! + 0.15 * noise[at]!;
    normalize(vector);
    return vector;
  }
}

function normalize(vector: Float32Array): void {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  for (let axis = 0; axis < vector.length; axis += 1) vector[axis] = vector[axis]! / norm;
}

/** The text form pgvector reads: `[0.1,0.2,...]`. */
export function vectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector, (value) => value.toFixed(6)).join(",")}]`;
}

/** Cosine similarity of two unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let axis = 0; axis < a.length; axis += 1) sum += a[axis]! * b[axis]!;
  return sum;
}
