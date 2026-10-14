// Splits a plain-text Wikipedia extract (exsectionformat=wiki) into paragraph-based
// pseudo-notes: prose only, 200-700 characters, at most 25 per article, without
// lists, tables, reference sections or other boilerplate.
import type { CorpusItem } from "./items.js";

export interface RawArticle {
  lang: "pt" | "en";
  domain: string;
  title: string;
  pageId: number;
  revisionId: number;
  extract: string;
}

export interface SplitOptions {
  minChars: number;
  maxChars: number;
  maxPerArticle: number;
}

export const defaultSplitOptions: SplitOptions = {
  minChars: 200,
  maxChars: 700,
  maxPerArticle: 25
};

const skippedSections = new Set(
  [
    // English
    "see also",
    "references",
    "external links",
    "further reading",
    "notes",
    "bibliography",
    "sources",
    "citations",
    "works cited",
    "footnotes",
    "gallery",
    "explanatory notes",
    "notes and references",
    "references and notes",
    "discography",
    "filmography",
    "selected works",
    "works",
    "publications",
    "selected publications",
    "awards",
    "awards and honors",
    "awards and nominations",
    "general and cited references",
    "general references",
    "cited sources",
    "primary sources",
    "secondary sources",
    // Portuguese
    "ver tambem",
    "referencias",
    "ligacoes externas",
    "links externos",
    "bibliografia",
    "notas",
    "leitura adicional",
    "leituras adicionais",
    "leitura recomendada",
    "fontes",
    "galeria",
    "discografia",
    "filmografia",
    "obras",
    "principais obras",
    "notas e referencias",
    "referencias bibliograficas",
    "premios",
    "premios e indicacoes",
    "bibliografia recomendada"
  ].map(foldKey)
);

const boilerplatePattern =
  /\b(ISBN|ISSN|doi:|Retrieved \d|Consultado em|Arquivado do original|Archived from|Wikimedia Commons|Wikcionário|Wiktionary)\b|^[\^↑]/u;

function foldKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Removes `{\displaystyle ...}` blocks (balanced braces) left by math markup. */
function stripMath(text: string): string {
  const marker = "{\\displaystyle";
  let output = "";
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(marker, cursor);
    if (start < 0) break;
    output += text.slice(cursor, start);
    let depth = 0;
    let index = start;
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    cursor = index + 1;
  }
  return output + text.slice(cursor);
}

function cleanParagraph(text: string): string {
  return stripMath(text)
    .replace(/\s+/g, " ")
    .replace(/\(\s*[;,]?\s*\)/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function isProse(text: string): boolean {
  if (text.includes("\t")) return false;
  if (boilerplatePattern.test(text)) return false;
  if (!/[.!?…"”»)]$/u.test(text)) return false;
  const words = text.split(" ").filter((word) => word.length > 0);
  if (words.length < 8) return false;
  let letters = 0;
  let digits = 0;
  for (const char of text) {
    if (/\p{L}/u.test(char)) letters += 1;
    else if (/\p{N}/u.test(char)) digits += 1;
  }
  return letters / text.length >= 0.6 && digits / text.length <= 0.15;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+(?=[\p{Lu}"“«(\d])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** Packs sentences of an over-long paragraph into chunks within the bounds. */
function packLongParagraph(text: string, options: SplitOptions): string[] {
  const chunks: string[] = [];
  let current = "";
  for (let sentence of splitSentences(text)) {
    while (sentence.length > options.maxChars) {
      const cut = sentence.lastIndexOf(" ", options.maxChars - 1);
      const head = sentence.slice(0, cut > options.minChars ? cut : options.maxChars).trim();
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      chunks.push(head);
      sentence = sentence.slice(head.length).trim();
    }
    if (current.length === 0) current = sentence;
    else if (current.length + 1 + sentence.length <= options.maxChars) {
      current = `${current} ${sentence}`;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current.length > 0) {
    const last = chunks.at(-1);
    if (
      current.length < options.minChars &&
      last !== undefined &&
      last.length + 1 + current.length <= options.maxChars
    ) {
      chunks[chunks.length - 1] = `${last} ${current}`;
    } else {
      chunks.push(current);
    }
  }
  return chunks.filter(
    (chunk) => chunk.length >= options.minChars && chunk.length <= options.maxChars
  );
}

interface Section {
  heading: string | null;
  skipped: boolean;
  paragraphs: string[];
}

function parseSections(extract: string): Section[] {
  const sections: Section[] = [{ heading: null, skipped: false, paragraphs: [] }];
  let skippedTopLevel = false;
  for (const rawLine of extract.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const heading = /^(={2,6})\s*(.+?)\s*\1$/u.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 2;
      const name = heading[2] ?? "";
      const skipped = skippedSections.has(foldKey(name));
      if (level === 2) skippedTopLevel = skipped;
      sections.push({ heading: name, skipped: skipped || skippedTopLevel, paragraphs: [] });
      continue;
    }
    sections.at(-1)?.paragraphs.push(line);
  }
  return sections;
}

export function splitArticle(
  article: RawArticle,
  options: SplitOptions = defaultSplitOptions
): CorpusItem[] {
  const candidates: { text: string; heading: string | null }[] = [];
  const seen = new Set<string>();
  const push = (text: string, heading: string | null): void => {
    if (text.length < options.minChars || text.length > options.maxChars) return;
    if (seen.has(text)) return;
    seen.add(text);
    candidates.push({ text, heading });
  };

  for (const section of parseSections(article.extract)) {
    if (section.skipped) continue;
    let buffer = "";
    for (const raw of section.paragraphs) {
      const paragraph = cleanParagraph(raw);
      if (!isProse(paragraph)) {
        // A list, table row or caption breaks the run of prose.
        if (buffer.length >= options.minChars) push(buffer, section.heading);
        buffer = "";
        continue;
      }
      if (paragraph.length > options.maxChars) {
        if (buffer.length >= options.minChars) push(buffer, section.heading);
        buffer = "";
        for (const chunk of packLongParagraph(paragraph, options)) push(chunk, section.heading);
        continue;
      }
      if (buffer.length === 0) {
        buffer = paragraph;
      } else if (buffer.length + 1 + paragraph.length <= options.maxChars) {
        buffer = `${buffer} ${paragraph}`;
      } else {
        push(buffer, section.heading);
        buffer = paragraph;
      }
      if (buffer.length >= options.minChars) {
        push(buffer, section.heading);
        buffer = "";
      }
    }
    if (buffer.length >= options.minChars) push(buffer, section.heading);
  }

  // Keep at most maxPerArticle candidates, evenly spread so every part of the
  // article is represented (the lead is always kept).
  const selected: number[] = [];
  if (candidates.length <= options.maxPerArticle) {
    for (let index = 0; index < candidates.length; index += 1) selected.push(index);
  } else {
    for (let slot = 0; slot < options.maxPerArticle; slot += 1) {
      selected.push(Math.floor((slot * candidates.length) / options.maxPerArticle));
    }
  }

  return selected.map((index) => {
    const candidate = candidates[index];
    if (!candidate) throw new Error("unreachable: candidate index out of range");
    return {
      id: `wp-${article.lang}-${article.pageId}-c${String(index).padStart(3, "0")}`,
      lang: article.lang,
      domain: article.domain,
      articleTitle: article.title,
      title: candidate.heading ? `${article.title} — ${candidate.heading}` : article.title,
      text: candidate.text
    };
  });
}
