// A tiny corpus in the format of `.cache/corpus` (Spike B) for the corpus runner's tests: four
// articles in two languages, every note with a first sentence (the idea) and a body, and an
// introduction note whose title is the article title (the notitle variant has none).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { corpusManifestFile, corpusNotesFile } from "./corpus-library.js";

interface FixtureArticle {
  lang: "pt" | "en";
  domain: string;
  title: string;
  pageId: number;
  revisionId: number;
  sections: string[];
}

export const fixtureArticles: readonly FixtureArticle[] = [
  {
    lang: "en",
    domain: "biology",
    title: "Photosynthesis",
    pageId: 24544,
    revisionId: 1379238357,
    sections: ["", "Light reactions", "Calvin cycle", "Evolution"]
  },
  {
    lang: "pt",
    domain: "biology",
    title: "Fotossíntese",
    pageId: 4812,
    revisionId: 68123456,
    sections: ["", "Fase clara", "Ciclo de Calvin"]
  },
  {
    lang: "en",
    domain: "music",
    title: "Counterpoint",
    pageId: 7101,
    revisionId: 1377000111,
    sections: ["", "Species", "History"]
  },
  {
    lang: "pt",
    domain: "music",
    title: "Contraponto",
    pageId: 9930,
    revisionId: 68000222,
    sections: ["", "Espécies"]
  }
];

function noteText(article: FixtureArticle, section: string, index: number): string {
  return article.lang === "en"
    ? `${article.title} has a topic called ${section || "overview"} number ${index}. It is described here with enough words to look like a real passage of an encyclopedia article.`
    : `${article.title} tem um tema chamado ${section || "resumo"} número ${index}. Ele é descrito aqui com palavras suficientes para parecer uma passagem de um artigo de enciclopédia.`;
}

export async function writeFixtureCorpus(directory: string): Promise<{
  articles: number;
  notes: number;
}> {
  await mkdir(directory, { recursive: true });
  const rows: unknown[] = [];
  for (const article of fixtureArticles) {
    article.sections.forEach((section, index) => {
      rows.push({
        id: `wp-${article.lang}-${article.pageId}-c${String(index).padStart(3, "0")}`,
        lang: article.lang,
        domain: article.domain,
        articleTitle: article.title,
        title: section === "" ? article.title : `${article.title} — ${section}`,
        text: noteText(article, section, index)
      });
    });
  }
  const manifest = {
    name: "Test corpus",
    source: "Wikipedia (fixture)",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    attribution: "Text from Wikipedia articles by Wikipedia contributors.",
    articles: fixtureArticles.map((article) => ({
      lang: article.lang,
      domain: article.domain,
      title: article.title,
      pageId: article.pageId,
      revisionId: article.revisionId,
      notes: article.sections.length
    }))
  };
  await writeFile(join(directory, corpusManifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    join(directory, corpusNotesFile),
    rows.map((row) => `${JSON.stringify(row)}\n`).join("")
  );
  return {
    articles: fixtureArticles.length,
    notes: fixtureArticles.reduce((total, article) => total + article.sections.length, 0)
  };
}
