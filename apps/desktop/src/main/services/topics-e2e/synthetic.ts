// The synthetic library and the synthetic model of the zero-config end-to-end test (F2 T32), for the
// harness's own proof (`--synthetic`, and its sidecar test): the real services and the real cassette
// run on a small library whose notes carry their theme in their words, with a stand-in for the model
// that answers embeddings and topic names. It proves the harness (fresh database, first-run
// seeding, cassette record and replay, the topic barrier, the assertions), not the product's quality.
import { createHash } from "node:crypto";

import type { AiModelAdapter, AiTaskRequest, AiTaskResult } from "@app/ai";
import { z } from "zod";

import type { Corpus, CorpusArticle, CorpusNote } from "../topic-tree/corpus-library.js";

/** The dimension of the stand-in embedding model (the real one is 1024). */
export const syntheticDimensions = 1024;

export const syntheticCorpus: Pick<Corpus, "name" | "license" | "licenseUrl" | "attribution"> = {
  name: "Synthetic topics e2e library",
  license: "CC0-1.0",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  attribution: "Generated for the zero-config end-to-end test."
};

type Language = "pt" | "en";

interface Theme {
  /** Words that carry the theme; each note uses a rotating pair plus a few more. */
  words: Record<Language, string[]>;
}

const themes: Theme[] = [
  {
    words: {
      pt: [
        "esquecimento",
        "retenção",
        "intervalo",
        "evocação",
        "memória",
        "economia",
        "repetição",
        "aprendizado",
        "curva",
        "decaimento",
        "lembrança",
        "tempo"
      ],
      en: [
        "forgetting",
        "retention",
        "interval",
        "recall",
        "memory",
        "savings",
        "repetition",
        "learning",
        "curve",
        "decay",
        "remembering",
        "time"
      ]
    }
  },
  {
    words: {
      pt: [
        "sono",
        "consolidação",
        "hipocampo",
        "noite",
        "sonho",
        "descanso",
        "neurônios",
        "ondas",
        "ritmo",
        "cortical",
        "repouso",
        "circadiano"
      ],
      en: [
        "sleep",
        "consolidation",
        "hippocampus",
        "night",
        "dreaming",
        "rest",
        "neurons",
        "waves",
        "rhythm",
        "cortical",
        "resting",
        "circadian"
      ]
    }
  },
  {
    words: {
      pt: [
        "estatística",
        "amostra",
        "variância",
        "regressão",
        "potência",
        "hipótese",
        "correlação",
        "erro",
        "ajuste",
        "modelo",
        "teste",
        "distribuição"
      ],
      en: [
        "statistics",
        "sample",
        "variance",
        "regression",
        "power",
        "hypothesis",
        "correlation",
        "error",
        "fitting",
        "model",
        "testing",
        "distribution"
      ]
    }
  }
];

const sentences: Record<Language, (a: string, b: string, c: string) => string> = {
  pt: (a, b, c) =>
    `O estudo mostra que ${a} depende de ${b} e do ${c} observado em cada participante.`,
  en: (a, b, c) =>
    `The study shows that ${a} depends on ${b} and on the ${c} observed in each participant.`
};

const followUps: Record<Language, (word: string, theme: number, index: number) => string> = {
  pt: (word, theme, index) =>
    `${capitalize(word)} reaparece no caso ${theme}.${index}, com novos dados.`,
  en: (word, theme, index) =>
    `${capitalize(word)} appears again in case ${theme}.${index}, with new data.`
};

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const joiners: Record<Language, string> = { pt: " e ", en: " and " };

/** The base language of a locale when the synthetic library can be written in it. */
export function syntheticLanguage(locale: string): Language {
  const base = locale.toLowerCase().split("-")[0];
  if (base === "pt" || base === "en") return base;
  throw new Error(`The synthetic library is written in Portuguese or English, not ${locale}`);
}

/** One root source with `perTheme` notes in each of three themes, in the content language. */
export function syntheticArticle(language: Language, perTheme = 12): CorpusArticle {
  const notes: CorpusNote[] = [];
  themes.forEach((theme, themeIndex) => {
    const words = theme.words[language];
    for (let index = 0; index < perTheme; index += 1) {
      const a = words[index % words.length]!;
      const b = words[(index + 3) % words.length]!;
      const c = words[(index + 7) % words.length]!;
      const title = `${capitalize(a)}${joiners[language]}${b}`;
      const idea = sentences[language](a, b, c);
      const body = followUps[language](
        words[(index + 5) % words.length]!,
        themeIndex + 1,
        index + 1
      );
      notes.push({
        id: `synthetic-${language}-t${themeIndex + 1}-n${String(index + 1).padStart(2, "0")}`,
        title,
        idea,
        body,
        text: `${title}. ${idea} ${body}`
      });
    }
  });
  return {
    key: `${language}:Synthetic memory paper`,
    lang: language,
    title: language === "pt" ? "Um artigo sintético sobre memória" : "A synthetic paper on memory",
    domain: "synthetic",
    pageId: 1,
    revisionId: 1,
    notes
  };
}

// ---------------------------------------------------------------------------
// The stand-in embedding model

const wordPattern = /[\p{L}\p{N}]{3,}/gu;

/** Every word that carries a theme, in both languages. */
const themeVocabulary = new Set(
  themes
    .flatMap((theme) => [...theme.words.pt, ...theme.words.en])
    .map((word) => word.toLowerCase())
);

/**
 * A unit vector that is a function of the words: every word adds a signed amount to a hashed
 * coordinate, a theme word one and any other word little, so notes that share their theme are close
 * and notes of other themes are not, whatever sentence frame they share.
 */
export function syntheticEmbedding(text: string, dimensions = syntheticDimensions): number[] {
  const vector = new Float64Array(dimensions);
  for (const word of text.toLowerCase().normalize("NFC").match(wordPattern) ?? []) {
    const digest = createHash("sha256").update(word).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const weight = themeVocabulary.has(word) ? 1 : 0.15;
    vector[index] = (vector[index] ?? 0) + (digest[4]! % 2 === 0 ? weight : -weight);
  }
  const noise = createHash("sha256").update(text).digest();
  for (let index = 0; index < 8; index += 1)
    vector[noise.readUInt16BE(index * 2) % dimensions]! += 0.05;
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Array.from(vector, (value) => value / norm);
}

// ---------------------------------------------------------------------------
// The stand-in naming model

const GroupSchema = z.object({
  parent: z.string().nullable(),
  topics: z.array(
    z.object({
      alias: z.string(),
      notes: z.array(z.object({ title: z.string(), idea: z.string().optional() }))
    })
  )
});

/** The groups a topic naming prompt carries: the JSON after "Topics:" up to the repair block. */
export function namingGroups(input: string): z.infer<typeof GroupSchema>[] | null {
  const marker = "\nTopics:\n";
  const at = input.lastIndexOf(marker);
  if (at < 0) return null;
  const body = input.slice(at + marker.length);
  const end = body.indexOf("\n\n");
  try {
    return z.array(GroupSchema).parse(JSON.parse(end < 0 ? body : body.slice(0, end)));
  } catch {
    return null;
  }
}

const description: Record<Language, (title: string) => string> = {
  pt: (title) => `Reúne as notas sobre ${title.toLowerCase()} e o que elas dizem a respeito.`,
  en: (title) => `Brings together the notes about ${title.toLowerCase()} and what they say.`
};

/** The answer of the stand-in to a naming prompt: a title from the topic's most frequent words. */
export function syntheticNaming(input: string, language: Language, contentLanguage: string) {
  const groups = namingGroups(input);
  if (!groups) return null;
  const joiner = joiners[language];
  const themeWords = new Set(themes.flatMap((theme) => theme.words[language]));
  const topics = groups.flatMap((group) => {
    const taken = new Set<string>();
    return group.topics.map((topic) => {
      const counts = new Map<string, number>();
      for (const note of topic.notes) {
        for (const word of `${note.title} ${note.idea ?? ""}`.toLowerCase().match(wordPattern) ??
          [])
          counts.set(word, (counts.get(word) ?? 0) + 1);
      }
      const ranked = [...counts]
        .filter(([word]) => themeWords.has(word))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([word]) => word);
      let title = capitalize(`${ranked[0] ?? "assunto"}${joiner}${ranked[1] ?? "contexto"}`);
      for (let attempt = 2; taken.has(title.toLowerCase()); attempt += 1)
        title = capitalize(
          `${ranked[0] ?? "assunto"}${joiner}${ranked[attempt] ?? `tema ${attempt}`}`
        );
      taken.add(title.toLowerCase());
      return {
        alias: topic.alias,
        title,
        description: description[language](title),
        aliases: [] as string[],
        language: contentLanguage
      };
    });
  });
  return JSON.stringify({ topics });
}

// ---------------------------------------------------------------------------
// The stand-in provider

/**
 * Wraps a real adapter so that it answers like a model without calling it: embeddings from the
 * words, topic names from the notes, everything else an empty JSON object. The cassette wraps this
 * (record mode stores the answers), so a replay reads them back from the cassette alone.
 */
export function syntheticProvider(
  adapter: AiModelAdapter,
  options: { language: Language; contentLanguage: string }
): AiModelAdapter {
  const answer = async (request: AiTaskRequest): Promise<AiTaskResult> => {
    const descriptor = adapter.describe();
    const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
    const output: unknown =
      request.taskType === "embedding"
        ? syntheticEmbedding(input)
        : (syntheticNaming(input, options.language, options.contentLanguage) ?? "{}");
    return {
      taskType: request.taskType,
      output,
      providerId: descriptor.providerId,
      modelId: request.modelId ?? descriptor.modelId,
      runtime: descriptor.runtime,
      durationMs: 1,
      inputTokens: Math.ceil(input.length / 4),
      outputTokens: request.taskType === "embedding" ? 0 : 40
    };
  };
  return {
    describe: () => adapter.describe(),
    canHandle: (request) => adapter.canHandle(request),
    isLoaded: () => true,
    ensureLoaded: async () => undefined,
    run: (request) => answer(request),
    runStreaming: (request, _signal, onProgress) => {
      onProgress({ progress: 1 });
      return answer(request);
    },
    dispose: async () => undefined
  };
}
